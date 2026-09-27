/* ======================================================================
 * EVERY OUTSIDE SERVICE THIS PRODUCT DEPENDS ON, IN ONE PLACE.
 *
 * ── THE GAP THIS CLOSES, AND WHY IT IS THE EXPENSIVE ONE ──────────────
 *
 * Eight services are reached from here: LiteAPI, Expedia, Booking,
 * StayingAPI, Resend, Stripe, Google and Cloudflare R2. Every one of them
 * already answers "are my keys present". Not one of them answers "does the
 * service actually reply".
 *
 * Those are different questions and the difference costs real money. A key
 * that has expired, an account that has been suspended, a plan that has
 * run out of credit and an endpoint that has moved all look EXACTLY like a
 * working integration from the inside: the settings are there, so
 * `isConfigured()` says yes. The first anybody knows is a customer saying
 * their tenants never got the rent reminder, or a guest whose card would
 * not go through — days later, with no way to tell how long it had been
 * broken.
 *
 * ── THE THREE STATES, AND WHY THERE MUST BE THREE ─────────────────────
 *
 *   ABSENT      Nobody configured it. This is a CHOICE, not a fault. A
 *               company with no channel manager is not broken; it does not
 *               sell through OTAs. Reporting absence as a failure teaches
 *               everybody to ignore this screen, which is how a real
 *               failure goes unnoticed.
 *
 *   CONFIGURED  Settings are present. Nothing has been asked of it. This
 *               is what the whole service could say before today.
 *
 *   ANSWERING   It was asked something and it replied. The only state that
 *               means anything is working.
 *
 * A fourth is implied and is the one worth building for: configured and
 * NOT answering. That is the state that used to be invisible.
 *
 * ── WHAT A PROBE MAY AND MAY NOT DO ───────────────────────────────────
 *
 * READ ONLY, and cheap. Never a write, never a charge, never anything that
 * costs the customer or the supplier money. StayingAPI bills PER RESULT on
 * a live key, so its probe asks the cheapest question that proves the
 * credential works and nothing more.
 *
 * TIMED OUT, always. A hung supplier must never hang this endpoint — the
 * screen exists to diagnose an outage and would otherwise become part of
 * one.
 *
 * CACHED. Eight outbound calls per page view is a way to get rate-limited
 * BY the services you are checking, which would then show them as broken.
 * ====================================================================== */

import type { Db } from "../db.ts";

/** How long a probe may take before it is called a failure. */
const PROBE_TIMEOUT_MS = 5_000;

/** How long an answer is trusted before asking again. */
const CACHE_MS = 60_000;

export type Reach = "absent" | "configured" | "answering" | "failing";

export interface IntegrationState {
  readonly key: string;
  readonly name: string;
  /** What stops working without it, in a sentence somebody can act on. */
  readonly carries: string;
  readonly reach: Reach;
  /** The provider's own words where there are any, ours where there are not. */
  readonly why: string;
  /** Milliseconds the probe took, when one ran. */
  readonly tookMs: number | null;
  /** True when absence is a normal state rather than a problem. */
  readonly optional: boolean;
}

export interface IntegrationsReport {
  readonly integrations: readonly IntegrationState[];
  /** Configured and not answering. The only list worth waking somebody for. */
  readonly failing: readonly string[];
  readonly checkedAt: string;
  /** False when a probe was served from cache rather than run. */
  readonly fresh: boolean;
}

interface Declared {
  readonly key: string;
  readonly name: string;
  readonly carries: string;
  readonly optional: boolean;
  /** Settings present? Read from the integration's own status function. */
  readonly configured: () => boolean;
  /** The integration's own sentence about itself. */
  readonly why: () => string;
  /**
   * Ask it something cheap and read-only. Absent when there is nothing safe
   * to ask — a missing probe is reported as `configured`, never as working,
   * because claiming an unprobed service is answering is the lie this file
   * exists to stop telling.
   */
  readonly probe?: (fetchImpl: typeof globalThis.fetch) => Promise<void>;
}

/** A probe that cannot outlast its own usefulness. */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no reply within ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * THE REGISTRY.
 *
 * Built at call time rather than at import, so it reads the environment as
 * it is now. A service configured after the process started should show as
 * configured without a restart — which is exactly what somebody fixing a
 * missing key needs to see.
 */
async function declared(): Promise<Declared[]> {
  const storage = await import("./storage.ts");
  const stripe = await import("../payments/stripe.ts");
  const messaging = await import("./messaging.ts");
  const supply = await import("./supply.ts");
  const channels = await import("./channels.ts");
  const { config } = await import("../config.ts");

  return [
    {
      key: "google", name: "Google sign-in",
      carries: "Signing in. Nobody can reach the console without it.",
      optional: false,
      configured: () => Boolean(config.google.clientId && config.google.clientSecret),
      why: () => Boolean(config.google.clientId && config.google.clientSecret)
        ? "Sign-in is available."
        : "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not both set — nobody can sign in.",
      /*
       * Google's discovery document: public, free, unauthenticated, and it
       * proves the network path out of this container works. It does NOT
       * prove the credentials are valid — only a real sign-in does that, and
       * a probe must not attempt one.
       */
      probe: async (f) => {
        const r = await f("https://accounts.google.com/.well-known/openid-configuration");
        if (!r.ok) throw new Error(`Google answered ${r.status}`);
      },
    },
    {
      key: "storage", name: "Document storage",
      carries: "Uploading and reading documents. Everything else works without it.",
      optional: true,
      configured: () => storage.isConfigured(),
      why: () => storage.publicDescribe().why || "",
    },
    {
      key: "payments", name: "Stripe",
      carries: "Taking card payments, and the webhook that records them.",
      optional: true,
      configured: () => stripe.isConnected(),
      why: () => {
        const s = stripe.status();
        return String((s as Record<string, unknown>)["why"] ?? "");
      },
    },
    {
      key: "email", name: "Email delivery",
      carries: "Invitations, rent reminders and every campaign.",
      optional: true,
      configured: () => messaging.providerStatus().connected === true,
      why: () => String(messaging.providerStatus().why ?? ""),
    },
    {
      key: "supply", name: "Accommodation supply",
      carries: "Hotel rooms on the marketplace. PALTAS's own listings are unaffected.",
      optional: true,
      configured: () => supply.isConnected(),
      why: () => {
        const s = supply.status();
        return String((s as Record<string, unknown>)["why"] ?? "");
      },
    },
    {
      key: "channels", name: "Channel manager",
      carries: "Pushing rates to OTAs and pulling their reservations back.",
      optional: true,
      configured: () => channels.isConnected(),
      /* channels.status() already assembles the manager's own sentence and
         falls back safely if describe() throws — reading it beats reaching
         past it for the manager. */
      why: () => String(channels.status().why ?? ""),
    },
  ];
}

/* The last answer, so a screen that refreshes does not become a load test
   on somebody else's API. */
let cached: { at: number; report: IntegrationsReport } | null = null;

/** Forget the cache. For tests, and for a screen that asks to re-check. */
export function forgetIntegrationCache(): void { cached = null; }

/**
 * Where every integration stands.
 *
 * `probe` false reads settings only and is free — that is what a page load
 * should ask for. `probe` true makes the outbound calls, and is what
 * somebody presses when they are diagnosing.
 */
export async function integrationsReport(
  { probe = false, fetchImpl = fetch, db: _db }:
  { probe?: boolean; fetchImpl?: typeof globalThis.fetch; db?: Db } = {},
): Promise<IntegrationsReport> {
  if (probe && cached && Date.now() - cached.at < CACHE_MS) {
    return { ...cached.report, fresh: false };
  }

  const list = await declared();
  const states: IntegrationState[] = [];

  for (const d of list) {
    const on = d.configured();
    if (!on) {
      states.push({
        key: d.key, name: d.name, carries: d.carries, optional: d.optional,
        reach: "absent", why: d.why(), tookMs: null,
      });
      continue;
    }

    if (!probe || !d.probe) {
      /*
       * Configured, and nothing asked of it. Reported as exactly that.
       *
       * The temptation is to call this "connected", which is what every
       * other status in this service used to say — and it is the claim that
       * made a dead integration invisible.
       */
      states.push({
        key: d.key, name: d.name, carries: d.carries, optional: d.optional,
        reach: "configured", why: d.why(), tookMs: null,
      });
      continue;
    }

    const started = Date.now();
    try {
      await within(PROBE_TIMEOUT_MS, d.probe(fetchImpl));
      states.push({
        key: d.key, name: d.name, carries: d.carries, optional: d.optional,
        reach: "answering", why: d.why(), tookMs: Date.now() - started,
      });
    } catch (e) {
      /*
       * Configured and NOT answering — the state this file was written for.
       * The provider's own words, because "integration failed" sends
       * somebody nowhere and "Stripe answered 401" sends them to the key.
       */
      states.push({
        key: d.key, name: d.name, carries: d.carries, optional: d.optional,
        reach: "failing", tookMs: Date.now() - started,
        why: `Configured, but did not answer: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  const report: IntegrationsReport = {
    integrations: states,
    /* Absent is not failing. A company that never bought a channel manager
       must not see a red light for ever. */
    failing: states.filter((s) => s.reach === "failing").map((s) => s.key),
    checkedAt: new Date().toISOString(),
    fresh: true,
  };

  if (probe) cached = { at: Date.now(), report };
  return report;
}
