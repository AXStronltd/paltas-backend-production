/* ====================================================================== *
 * THE PALTAS API.
 *
 * Sessions, organizations and the promotion workflow — the first slice of the
 * contract in the frontend's backend.md, built so the frontend needs no change
 * above `PromoAPI` and `PALTAS.Session`.
 * ====================================================================== */

import express from "express";
import cookieParser from "cookie-parser";

import { config } from "./config.js";
import { db, closeDb } from "./db.js";
import {
  cors, errorHandler, notFound, rateLimit, securityHeaders, withSession,
} from "./http/index.js";
import { pruneExpiredSessions } from "./auth/sessions.js";
import { authRoutes } from "./routes/auth.js";
import { organizationRoutes } from "./routes/organizations.js";
import { invitationRoutes } from "./routes/invitations.js";
import { provisioningRoutes } from "./routes/provisioning.js";
import { promotionRoutes } from "./routes/promotions.js";
import { productRoutes } from "./routes/products.js";
import { marketRoutes } from "./routes/market.js";
import { marketplaceRoutes } from "./routes/marketplace.js";
import { stayRoutes } from "./routes/stays.js";
import { paymentRoutes } from "./routes/payments.js";
import { stripeWebhookRoutes } from "./routes/stripe-webhook.js";
import { register as registerProcessor, fromEnv as stripeFromEnv, status as payStatus } from "./payments/stripe.js";
import { guestRoutes } from "./routes/guest.js";
import { platformRoutes } from "./routes/platform.js";
import { investmentRoutes } from "./routes/investments.js";
import { dnaRoutes } from "./routes/dna.js";
import { authorityRoutes } from "./modules/authority/api/routes.js";
import { register as registerSupplier, status as supplierStatus } from "./domain/supply.js";
import { fromEnv as liteApiFromEnv } from "./suppliers/liteapi.js";
import { fromEnv as stayingApiFromEnv, KEY_NAMES as STAYING_KEYS } from "./suppliers/stayingapi.js";
import { registerCompare, compareStatus, noteCompareUnavailable } from "./domain/compare.js";
import { fromEnv as expediaRapidFromEnv } from "./suppliers/expedia-rapid.js";
import { fromEnv as bookingDemandFromEnv } from "./suppliers/booking-demand.js";
import { fromEnv as sampleCatalogueFromEnv } from "./suppliers/sample-catalogue.js";

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

/* Fixed at import, so it is the process's age and not the request's clock. */
const STARTED_AT = new Date().toISOString();

export function createApp() {
  const app = express();

  /* Render terminates TLS at its edge, so the client IP and the protocol
     arrive in headers. Without this, every request looks like it came from
     the proxy — which breaks rate limiting and makes secure cookies look
     insecure. */
  app.set("trust proxy", config.trustProxyHops);
  app.disable("x-powered-by");

  /* ------------------------------------------------------------------ *
   * MONEY ON THE WIRE.
   *
   * Money is stored as BigInt — see prisma/migrations/…_money_bigint. A
   * BigInt cannot be JSON-serialised: `JSON.stringify({a: 1n})` throws
   * "Do not know how to serialize a BigInt", which would be a 500 on every
   * response carrying an amount.
   *
   * So it goes out as a JSON NUMBER, not a string. The frontend reads money
   * as numbers and does arithmetic on it in 135 screens; sending strings
   * would be exact and would break every one of them. A number is exact
   * here too, up to Number.MAX_SAFE_INTEGER — 9,007,199,254,740,991 minor
   * units, or about ninety trillion major. The largest figure this platform
   * actually holds is 5.4e11, so the margin is roughly four orders of
   * magnitude.
   *
   * AND IT REFUSES RATHER THAN ROUNDS. Above MAX_SAFE_INTEGER a JS number
   * silently stops being exact: 9007199254740993 becomes …92. Money that is
   * quietly wrong is worse than a request that failed, so that case throws
   * and the error handler turns it into a 500 naming the field. It should
   * never happen; if it ever does, somebody needs to know rather than to
   * reconcile a ledger that disagrees with itself.
   * ------------------------------------------------------------------ */
  app.set("json replacer", function (key, value) {
    if (typeof value !== "bigint") return value;
    if (value > 9007199254740991n || value < -9007199254740991n) {
      throw new Error(
        `${key} is ${value} minor units, which is past the point a JSON number ` +
        `stays exact. Refusing to send a figure that would be silently wrong.`);
    }
    return Number(value);
  });

  app.use(securityHeaders());
  app.use(cors());
  /*
   * THE STRIPE WEBHOOK GOES FIRST, and the order is not cosmetic.
   *
   * Its signature is computed over the exact bytes Stripe sent. express.json()
   * parses and discards them, and a re-serialised object does not verify — so
   * mounted after this line, every webhook would fail with a signature error
   * that looks exactly like a wrong secret. It carries its own express.raw().
   */
  app.use(stripeWebhookRoutes);

  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());
  app.use(rateLimit({ windowMs: 60_000, max: 600 }));
  app.use(withSession());

  /* Render polls this. It touches the database on purpose: a service that
     answers "healthy" while its database is unreachable has told you nothing
     worth knowing. */
  app.get("/health", async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({
        ok: true, service: "paltas-api", env: config.env,
        /*
         * WHICH BUILD IS ANSWERING, AND SINCE WHEN.
         *
         * Without these, "is my change live yet?" is answered by guessing from
         * behaviour — and that fails exactly when it matters, because the
         * interesting case is usually one where the old build and the new one
         * say the same thing. It cost several rounds of confusion over an
         * environment variable before this existed.
         *
         * `startedAt` also answers "did it restart when I saved that variable",
         * which is the other half of the same question.
         *
         * A commit SHA identifies a build; it is not a credential and grants
         * nothing. Render sets RENDER_GIT_COMMIT on every deploy.
         */
        commit: String(process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || null,
        startedAt: STARTED_AT,
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: "database_unreachable" });
    }
  });

  app.get("/", (_req, res) => {
    res.json({
      service: "paltas-api",
      docs: "See backend.md in the paltas-frontend repository.",
      signIn: config.publicUrl + "/auth/google",
    });
  });

  app.use("/auth", authRoutes);
  app.use("/organizations", organizationRoutes);
  app.use("/invitations", invitationRoutes);
  app.use("/", provisioningRoutes);
  app.use("/promotions", promotionRoutes);

  /* ------------------------------------------------------------------ *
   * THE PLATFORM CATALOGUE — AND IT MUST STAY ABOVE productRoutes.
   *
   * These four are public and belong to no organization. productRoutes
   * below applies requireSession() at "/" with no path, so ANY path that
   * reaches it answers 401 — which is exactly why these four answered 401
   * for months before they existed, rather than 404.
   *
   * Registered after it they would be dead, and the failure would read as
   * an authentication problem rather than a routing one.
   * test/market-api.test.js asserts this order.
   * ------------------------------------------------------------------ */
  /*
   * API RESPONSES ARE NOT CACHEABLE BY DEFAULT.
   *
   * This service is proxied through paltas.io, so its responses travel through
   * a shared CDN. One customer's invoice list sitting in that cache and being
   * served to another is exactly the wall this platform sells — and a missing
   * Cache-Control header leaves the decision to whatever heuristics the cache
   * happens to use.
   *
   * Set BEFORE the routers, so the handful of genuinely public, genuinely
   * static endpoints (market config, payment methods, localization) can and do
   * override it with their own `public, max-age=600`. Everything else — every
   * authenticated read of a customer's own data — stays no-store.
   *
   * Netlify cannot do this: [[headers]] do not apply to proxied responses, so a
   * rule there looked right and did nothing at all.
   */
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.use(marketplaceRoutes);
  app.use(stayRoutes);
  app.use(paymentRoutes);
  app.use(marketRoutes);

  /* ------------------------------------------------------------------ *
   * THE GUEST PORTAL — and it must stay above productRoutes too.
   *
   * A guest holds no membership, so requireOrganization() below would refuse
   * them before they reached a single one of their own endpoints. These are
   * scoped to a PERSON rather than a company — see routes/guest.js.
   * ------------------------------------------------------------------ */
  app.use(guestRoutes);

  /* ------------------------------------------------------------------ *
   * THE PALTAS STAFF CONSOLE — above productRoutes, like the others.
   *
   * It is the ONE place in this service that reads across tenants, and it is
   * a separate file for exactly that reason: the organization filter in
   * http/resource.js stays unconditional, and this narrow door sits beside it
   * rather than inside it. Read-only, and every read is audited naming the
   * member of staff. See the long note in routes/platform.js.
   * ------------------------------------------------------------------ */
  app.use(platformRoutes);

  /*
   * TOKENISED INVESTMENT — before productRoutes, like every other router here.
   *
   * productRoutes mounts at "/" behind requireSession(), so anything registered
   * after it gets a 401 instead of reaching its handler. That is the same
   * ordering the market, guest and platform routers depend on.
   */
  app.use(investmentRoutes);

  /*
   * PROPERTY DNA — before productRoutes, for the same reason investments is.
   *
   * productRoutes mounts at "/" and builds a CRUD router for every declared
   * resource, so anything registered after it competes with those paths.
   * These are /properties/:siteId/... and there is no `properties` resource,
   * but the ordering rule is the one that keeps that true if one is ever
   * added.
   */
  app.use(dnaRoutes);

  /*
   * THE AUTHORITY LAYER, after Property DNA and before productRoutes.
   *
   * It does NOT sit behind requireOpenSubscription: a public authority is not
   * a paying customer and has no subscription to lapse. Putting that guard on
   * it would make a land registry's access depend on somebody's card.
   */
  app.use(authorityRoutes);

  /* The six products. Every path under here is organization-scoped and
     permission-checked by construction — see http/resource.js. */
  app.use("/", productRoutes);

  app.use((req, _res, next) => next(notFound(`No endpoint at ${req.method} ${req.path}.`)));
  app.use(errorHandler(log));

  return app;
}

/* Only start a server when run directly — importing this file in a test must
   not bind a port. */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());

/**
 * Attach an accommodation supplier, if this installation has credentials for one.
 *
 * Called from the boot path below and NOT from createApp(), deliberately. A
 * test builds the app dozens of times and must decide for itself whether a
 * supplier exists — registering inside createApp() would let a real wholesaler
 * be reached from a test run that never asked for one.
 *
 * Absent credentials are the NORMAL state and not an error: nothing is
 * registered, the marketplace serves PALTAS's own listings exactly as before,
 * and the log says which it is so an operator is never left guessing.
 */
/**
 * Attach a payment processor, if this installation has a key.
 *
 * Out of createApp() for the same reason as connectSuppliers: a test builds the
 * app many times and must decide for itself whether Stripe exists. Registering
 * inside createApp() would let a LIVE key be reached from a test run that never
 * asked for one, which on this seam means real money.
 */
export function connectPayments(env = process.env) {
  try {
    const stripe = stripeFromEnv(env);
    if (!stripe) {
      log.info("payment processor: none configured — companies cannot collect card payments");
      return null;
    }
    registerProcessor(stripe);
    const s = payStatus();
    log.info(`payment processor: ${s.name}${s.livemode ? " (LIVE — real cards)" : " (test mode)"}`);
    if (s.livemode && !env.STRIPE_WEBHOOK_SECRET) {
      /* Live, and unable to verify a webhook. Payments would be taken and never
         recorded, because the only place a Payment row is written is the
         verified webhook. */
      log.error(
        "  *** STRIPE IS LIVE BUT STRIPE_WEBHOOK_SECRET IS NOT SET. " +
        "No webhook can be verified, so no payment will be recorded. ***");
    }
    return s;
  } catch (e) {
    log.error("payment processor failed to connect:", e && e.message);
    return null;
  }
}

/**
 * The price-comparison provider — separate from connectSuppliers(), and that
 * separation is the point.
 *
 * StayingAPI has no booking endpoint. Registering it as a SUPPLIER would put
 * rooms on the marketplace that nobody can take; registering it here attaches
 * what other sellers charge to a LiteAPI room that IS bookable. Two different
 * seams, because they are two different promises to a visitor.
 */
export function connectComparison(env = process.env) {
  try {
    const p = stayingApiFromEnv(env);
    if (!p) {
      /*
       * WHY fromEnv() returned nothing, in the detail an operator needs.
       *
       * "Not set" is true of three different mistakes and only one of them is
       * "you forgot". A value that saved as empty, and a value that saved under
       * a name one character out, both present as absent — and from outside the
       * machine there is no way to tell them apart, which is exactly where
       * somebody debugging this is standing.
       *
       * NAMES ARE NOT SECRETS. Listing which STAYING-ish variables this process
       * can actually see turns a typo from an afternoon into a sentence. No
       * value is read, and none could be: only Object.keys is consulted.
       */
      const blank = STAYING_KEYS.filter(
        (n) => typeof env[n] === "string" && String(env[n]).trim() === "");
      const nearby = Object.keys(env)
        .filter((k) => /STAYING/i.test(k) && !STAYING_KEYS.includes(k))
        .sort();

      let why;
      if (blank.length) {
        why = blank.join(" and ") + " exists on this service but its value is empty.";
      } else if (nearby.length) {
        why = STAYING_KEYS.join(" / ") + " are not set, but this service can see " +
              nearby.join(" and ") + " — one of those is probably meant to be it.";
      } else {
        why = "Neither " + STAYING_KEYS.join(" nor ") +
              " is set on this service, so no other sellers are shown.";
      }
      noteCompareUnavailable(why);
      log.info("price comparison: " + why);
      return null;
    }
    registerCompare(p);
    const s = compareStatus();
    log.info(`price comparison: ${s.name}${s.sandbox ? " (SANDBOX — fixtures, no credits)" : " (LIVE — 30 credits per comparison)"}`);
    if (!s.sandbox) {
      /*
       * Worth saying on every boot. This is the only endpoint PALTAS has that
       * spends money per request, and the guards on it — a hotel PALTAS
       * already sells, a six-hour cache, twenty a minute — are the difference
       * between a feature and a bill.
       */
      log.info("  comparisons are cached for 6h and rate limited to 20/min, and only for hotels PALTAS sells");
    }
    return s;
  } catch (e) {
    /* A comparison is an extra. Failing to wire one must never stop the API
       from booting or take a bookable room off the marketplace.
       The message is the adapter's own and never contains a credential — it
       refuses an unrecognised key by describing the PREFIX it wanted. */
    const why = (e && e.message) || "the provider could not be built";
    noteCompareUnavailable("STAYINGAPI_KEY was set but rejected: " + why);
    log.error("price comparison failed to connect:", why);
    return null;
  }
}

export function connectSuppliers(env = process.env) {
  try {
    /*
     * PRECEDENCE, and it is deliberate.
     *
     * A licensed supplier always wins. The sample catalogue is reached for only
     * when neither Expedia nor Booking.com has credentials AND somebody has
     * explicitly set PALTAS_SAMPLE_SUPPLY=1 — so demonstration content can
     * never quietly outrank real inventory, and can never appear because a
     * variable was left at its default.
     */
    /*
     * LiteAPI first because it is the supplier this installation holds a key
     * for, and because it is the only one of the three that can price a city by
     * NAME — the other two need a hand-maintained id map and return nothing for
     * any city missing from it.
     */
    const real = liteApiFromEnv(env)
      || expediaRapidFromEnv(env)
      || bookingDemandFromEnv(env);
    const chosen = real || sampleCatalogueFromEnv(env);

    if (!chosen) {
      log.info("accommodation supplier: none configured — PALTAS listings only");
      return null;
    }

    registerSupplier(chosen);
    const s = supplierStatus();
    /* The name and the mode. Never a credential — status() has no field that
       could carry one. */
    log.info(`accommodation supplier: ${s.name}${s.sandbox ? " (SANDBOX/TEST)" : ""}`);

    if (!real) {
      /*
       * Loud, and on every boot. Sample inventory on a public marketplace is
       * the kind of thing that gets switched on for a demo and forgotten, and
       * the log is the only place an operator will ever notice.
       */
      log.error(
        "  *** SAMPLE CATALOGUE IS LIVE. The properties on the marketplace are " +
        "demonstration content: not real, not bookable, marked on every card. " +
        "Unset PALTAS_SAMPLE_SUPPLY to turn it off. ***");
    }
    return s;
  } catch (e) {
    /* A misconfigured supplier must not stop the API from booting. The
       marketplace degrades to PALTAS's own listings, which is the behaviour it
       had before any supplier existed. */
    log.error("accommodation supplier failed to connect:", e && e.message);
    return null;
  }
}

if (isMain) {
  connectSuppliers();
  connectComparison();
  connectPayments();
  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info(`paltas-api listening on :${config.port} (${config.env})`);
    log.info(`  sign in at ${config.publicUrl}/auth/google`);
    log.info(`  app origin ${config.appUrl}`);
  });

  pruneExpiredSessions()
    .then((n) => n && log.info(`pruned ${n} expired session(s)`))
    .catch((e) => log.error("session prune failed", e.message));

  /* Render sends SIGTERM on deploy. Finishing the requests already in flight
     is the difference between a clean deploy and a handful of people seeing a
     failure for no reason. */
  const stop = async (signal) => {
    log.info(`${signal} — shutting down`);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
