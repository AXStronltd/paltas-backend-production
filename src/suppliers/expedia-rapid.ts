/* ====================================================================== *
 * EXPEDIA RAPID (EPS Rapid), v3.
 *
 * The first real accommodation supplier behind `src/domain/supply.js`.
 *
 * ── WHY RAPID FIRST, AND NOT THE BOOKING.COM DEMAND API ─────────────────
 *
 * Both need a signed commercial agreement and neither can be reached without
 * credentials, so the choice came down to how much of the integration can be
 * proven correct BEFORE those credentials exist.
 *
 * Rapid authenticates with a computed signature:
 *
 *     Signature = SHA-512( apiKey + sharedSecret + unixSeconds )
 *
 * That is a pure function. It can be tested exhaustively with no network, no
 * account and no secret worth protecting, which means the part of this file
 * most likely to be silently wrong — and the part that fails with an
 * unhelpful 401 when it is — is the part under test today.
 *
 * Booking.com's Demand API uses a bearer token issued to an affiliate. A
 * bearer token cannot be derived, so nothing about its auth is verifiable
 * until somebody holds one. The adapter seam takes either; this one goes
 * first because it can be checked.
 *
 * ── THE SHAPE OF A RAPID SEARCH, WHICH IS NOT ONE REQUEST ───────────────
 *
 * Rapid does not have a "hotels in Mombasa" endpoint. Two things follow, and
 * both are handled below rather than wished away:
 *
 *   1. AVAILABILITY IS BY ID, NOT BY NAME. `/v3/properties/availability`
 *      takes `region_id` or up to 250 `property_id`s. A city name has to be
 *      resolved to a region first, and Rapid expects partners to hold the
 *      region list themselves. So this adapter takes a region map and, when a
 *      city is not in it, returns NO OFFERS with a reason. It does not guess a
 *      region id, because the wrong region id returns real hotels in the wrong
 *      country at real prices.
 *
 *   2. PRICES AND NAMES COME FROM DIFFERENT ENDPOINTS. Availability returns
 *      property ids, room rates and refundability — no name, no city, no
 *      image, no rating. Those are in `/v3/properties/content`. A card needs
 *      both, so a search is two calls joined on property id, and a property
 *      that appears in one but not the other is dropped rather than rendered
 *      half-blank.
 *
 * ── WHAT IS NEVER DONE HERE ─────────────────────────────────────────────
 *
 * Nothing is stored. No property, no rate, no name, no image is written to the
 * database or held between requests — see the note in `supply.js` for the
 * licensing and the staleness reasons, either of which is sufficient.
 *
 * Nothing is invented. A property Rapid did not price is not in the result. A
 * rating Rapid did not give is null. If the call fails, this throws and the
 * marketplace shows PALTAS's own listings with a note that the supplier is
 * unavailable — it never serves the last thing it saw.
 *
 * ── CREDENTIALS ─────────────────────────────────────────────────────────
 *
 * From the environment, never from a request, never logged, never returned:
 *
 *     EXPEDIA_RAPID_API_KEY
 *     EXPEDIA_RAPID_SECRET
 *     EXPEDIA_RAPID_TEST=1        optional, sends Rapid's test header
 *     EXPEDIA_RAPID_REGIONS       optional, {"mombasa,ke": "6054439"} as JSON
 *
 * `redact()` at the bottom exists because Rapid echoes the request back in
 * some error bodies, and an error body is the classic way a key reaches a log.
 * ====================================================================== */

import { createHash } from "node:crypto";
import { SupplyUnavailable, toMinor } from "../domain/supply.ts";
import type {
  AccommodationSupplier, RawOffer, SupplierDescription, SupplyQuery, SupplyResult,
} from "../domain/supply.ts";
import { messageOf } from "../http/errors.ts";

/** A JSON value from Rapid. Narrowed field by field where it is read. */
type Json = Record<string, unknown>;

/** Read one property off an unknown object without asserting its shape. */
const at = (v: unknown, key: string): unknown =>
  (typeof v === "object" && v !== null) ? (v as Json)[key] : undefined;

/** The same, for a list. Anything that is not an array reads as empty. */
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const BASE = "https://api.ean.com/v3";

/**
 * The Rapid Authorization header.
 *
 * SHA-512 of the three values concatenated with nothing between them, as
 * lowercase hex. The timestamp is Unix SECONDS — milliseconds is the mistake
 * that produces a 401 with no explanation, so it is computed here once and
 * never passed in from elsewhere.
 *
 * Exported so it can be tested without a network, an account or a real secret.
 */
export function signature(
  apiKey: string, sharedSecret: string, unixSeconds: number,
): string {
  if (!apiKey || !sharedSecret) {
    throw new SupplyUnavailable("Expedia Rapid is missing its API key or shared secret.");
  }
  if (!Number.isInteger(unixSeconds)) {
    throw new SupplyUnavailable("Expedia Rapid needs an integer Unix timestamp in seconds.");
  }
  return createHash("sha512")
    .update(`${apiKey}${sharedSecret}${unixSeconds}`, "utf8")
    .digest("hex");
}

/** The full header value, in the exact order and spelling Rapid parses. */
export function authorizationHeader(
  apiKey: string, sharedSecret: string, unixSeconds: number,
): string {
  const sig = signature(apiKey, sharedSecret, unixSeconds);
  return `EAN APIKey=${apiKey},Signature=${sig},timestamp=${unixSeconds}`;
}

/**
 * Nights between two ISO dates, which is what a stay total divides by.
 *
 * Returns null for anything that is not two valid dates in the right order.
 * Null propagates into the offer as "this is a stay total and we do not know
 * over how many nights", which is worse to display and better than a wrong
 * per-night figure.
 */
export function nightsBetween(checkIn: string, checkOut: string): number | null {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round((b - a) / 86_400_000);
}

/** `{"mombasa,ke": "6054439"}` -> a lookup that tolerates case and spacing. */
function regionIndex(map: Readonly<Record<string, unknown>> | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(map || {})) {
    out.set(String(k).toLowerCase().replace(/\s+/g, ""), String(v));
  }
  return out;
}

/**
 * The lowest inclusive total across a property's rooms and rates.
 *
 * Rapid nests a stay total under
 *   rooms[].rates[].occupancy_pricing[<occupancy>].totals.inclusive.billable_currency
 *
 * INCLUSIVE, deliberately: it is the figure with taxes and fees in it, and the
 * exclusive one is lower and not what a guest pays. Showing `exclusive` would
 * undercut every PALTAS listing beside it with a number that is not the price.
 */
/** The cheapest inclusive total found on one property, and how it is sold. */
export interface LowestTotal {
  readonly price: number;
  readonly currency: string;
  /** Null means the supplier did not say — not the same as non-refundable. */
  readonly refundable: boolean | null;
  readonly rateId: string | null;
}

export function lowestTotal(property: unknown): LowestTotal | null {
  let best: LowestTotal | null = null;
  for (const room of list(at(property, "rooms"))) {
    for (const rate of list(at(room, "rates"))) {
      const pricing = at(rate, "occupancy_pricing") ?? {};
      for (const occ of Object.keys(pricing as Json)) {
        const billable = at(at(at(pricing, occ), "totals"), "inclusive");
        const money = at(billable, "billable_currency");
        if (!money) continue;
        const minor = toMinor(at(money, "value") as number | string);
        if (minor === null) continue;
        if (!best || minor < best.price) {
          const refundable = at(rate, "refundable");
          const rateId = at(rate, "id");
          best = {
            price: minor,
            currency: String(at(money, "currency") || "").toUpperCase(),
            /* Rapid marks a rate refundable with this flag. Absent means the
               supplier did not say, which is not the same as non-refundable. */
            refundable: typeof refundable === "boolean" ? refundable : null,
            rateId: rateId ? String(rateId) : null,
          };
        }
      }
    }
  }
  return best;
}

/* ---------------------------------------------------------------- *
 * THE ADAPTER.
 * ---------------------------------------------------------------- */

/**
 * @param {object} cfg
 *   apiKey, sharedSecret   from the environment
 *   test                   send Rapid's `Test: standard` header
 *   regions                { "city,cc": "region_id" }
 *   fetchImpl              injected for tests; defaults to global fetch
 *   timeoutMs              a supplier that hangs must not hang the homepage
 *   now                    injected clock, so the signature is testable
 */
/** How this adapter is configured. */
export interface ExpediaRapidConfig {
  readonly apiKey?: string;
  readonly sharedSecret?: string;
  /** Sends Rapid's `Test: standard` header, and marks every offer sandbox. */
  readonly test?: boolean;
  /** `{ "city,cc": "region_id" }` — Rapid prices by opaque region id. */
  readonly regions?: Readonly<Record<string, unknown>>;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** A supplier that hangs must not hang the homepage. */
  readonly timeoutMs?: number;
  /** Injected clock, so the signature is testable. */
  readonly now?: () => number;
}

export function expediaRapid({
  apiKey,
  sharedSecret,
  test = false,
  regions = {},
  fetchImpl,
  timeoutMs = 6000,
  now = () => Date.now(),
}: ExpediaRapidConfig = {}): AccommodationSupplier {
  if (!apiKey || !sharedSecret) {
    throw new SupplyUnavailable(
      "Expedia Rapid cannot be registered without EXPEDIA_RAPID_API_KEY and " +
      "EXPEDIA_RAPID_SECRET. Nothing is connected, and PALTAS will show only " +
      "its own listings.");
  }

  /*
   * The credentials, captured after the guard above.
   *
   * A destructured parameter is a mutable binding, so the check three lines up
   * does not narrow it away from `string | undefined` inside call() below.
   * Copying into a const is what makes the guard visible to the signer.
   */
  const key = apiKey;
  const secret = sharedSecret;

  const http = fetchImpl || globalThis.fetch;
  if (typeof http !== "function") {
    throw new SupplyUnavailable("No fetch implementation is available for Expedia Rapid.");
  }
  const index = regionIndex(regions);

  /** Every Rapid call: signed, timed out, and parsed without trusting it. */
  async function call(
    path: string, params: readonly (readonly [string, string])[], travellerIp?: string,
  ): Promise<unknown> {
    const unix = Math.floor(now() / 1000);
    const url = new URL(BASE + path);
    for (const [k, v] of params) url.searchParams.append(k, String(v));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await http(url.toString(), {
        method: "GET",
        signal: controller.signal,
        headers: {
          Authorization: authorizationHeader(key, secret, unix),
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          /*
           * Rapid requires the END TRAVELLER's IP, not this server's. It is
           * how they apply the right market and meet their own compliance
           * duties, and a missing or wrong one gets the request refused.
           * Passed through for this one call and stored nowhere.
           */
          "Customer-Ip": travellerIp || "127.0.0.1",
          "User-Agent": "PALTAS/1.0 (+https://paltas.io)",
          ...(test ? { Test: "standard" } : {}),
        },
      });
    } catch (e) {
      clearTimeout(timer);
      /* An abort is a timeout, and saying so is more useful than "aborted". */
      const why = at(e, "name") === "AbortError"
        ? `Expedia Rapid did not answer within ${timeoutMs}ms.`
        : `Expedia Rapid could not be reached: ${redact(messageOf(e))}`;
      throw new SupplyUnavailable(why);
    }
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      /*
       * Redacted, always. Rapid echoes the request in some error bodies and
       * the request carries the signature — so the unredacted body is the
       * single most likely way a credential reaches a log file.
       */
      throw new SupplyUnavailable(
        `Expedia Rapid returned ${res.status}: ${redact(text).slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new SupplyUnavailable("Expedia Rapid returned a body that is not JSON.");
    }
  }

  return {
    name: "expedia-rapid",
    /* A test-mode integration is a sandbox, and must be marked as one
       everywhere — a visitor cannot be shown a test rate as a real one. */
    sandbox: Boolean(test),

    describe(): SupplierDescription {
      return {
        name: "expedia-rapid",
        connected: true,
        sandbox: Boolean(test),
        capabilities: ["search", "availability", "content"],
        why: test
          ? "Expedia Rapid is connected in TEST mode. Every offer it returns is " +
            "marked as a sandbox rate and must not be presented as bookable."
          : "Expedia Rapid is connected.",
        /* Named so an operator can see why a city returns nothing. The region
           IDS are not secret; the count is the useful part. */
        regionsKnown: index.size,
      };
    },

    async search({
      city = "", country = "", checkIn = "", checkOut = "", guests = 2,
      limit = 12, currency = "USD", travellerIp = "",
    }: SupplyQuery = {}): Promise<SupplyResult> {
      /*
       * Rapid prices a STAY, so it cannot be asked "what have you got" with no
       * dates. A marketplace browsing with no dates chosen gets nothing from
       * the supplier and its own listings as usual — which is honest, and the
       * alternative is inventing a date range and showing prices for it.
       */
      const nights = nightsBetween(checkIn, checkOut);
      if (!nights) {
        return {
          offers: [],
          note: "Expedia Rapid prices a stay, so it needs a check-in and a " +
                "check-out date. No dates were given, so no supplier rates " +
                "are shown.",
        };
      }

      const key = `${city}`.toLowerCase().replace(/\s+/g, "") + "," +
                  `${country}`.toLowerCase().replace(/\s+/g, "");
      const regionId = index.get(key);
      if (!regionId) {
        /*
         * No guess. Rapid's region ids are opaque integers and a wrong one
         * returns real hotels in the wrong place at real prices — which is
         * far worse than an empty supplier shelf, because it looks right.
         */
        return {
          offers: [],
          note: `Expedia Rapid has no region mapped for "${city}, ${country}", ` +
                `so no supplier rates are shown for it. ${index.size} region(s) ` +
                `are configured.`,
        };
      }

      const occupancy = Math.min(8, Math.max(1, Number(guests) || 2));
      const avail = await call("/properties/availability", [
        ["checkin", checkIn],
        ["checkout", checkOut],
        ["region_id", regionId],
        ["occupancy", String(occupancy)],
        ["currency", String(currency || "USD").toUpperCase()],
        ["country_code", String(country || "US").toUpperCase()],
        ["language", "en-US"],
        ["sales_channel", "website"],
        ["sales_environment", "hotel_only"],
        ["rate_plan_count", "1"],
      ], travellerIp);

      const properties = list(avail);
      const priced: { id: string; total: LowestTotal; links: unknown }[] = [];
      for (const p of properties) {
        const propertyId = at(p, "property_id");
        if (!propertyId) continue;
        /* Rapid marks sold-out properties in the same array. */
        const status = at(p, "status");
        if (status && status !== "available") continue;
        const total = lowestTotal(p);
        if (!total || !total.currency) continue;
        priced.push({ id: String(propertyId), total, links: at(p, "links") ?? null });
        if (priced.length >= Math.min(250, Math.max(1, limit) * 3)) break;
      }
      if (!priced.length) return { offers: [], note: "Expedia Rapid priced nothing for those dates." };

      /*
       * Names, cities, images and guest ratings — a second call, because
       * availability does not carry them. Keyed object, property_id -> content.
       */
      const content = await call("/properties/content", [
        ...priced.map((p) => ["property_id", p.id] as const),
        ["language", "en-US"],
      ], travellerIp);

      const offers: RawOffer[] = [];
      for (const p of priced) {
        const c = at(content, p.id);
        const name = at(c, "name");
        /* No content means no name and no city. A card cannot be drawn from a
           price and an opaque id, so it is dropped rather than half-drawn. */
        if (!c || !name) continue;

        const addr = at(c, "address");
        const guest = at(at(c, "ratings"), "guest");
        const rawOverall = at(guest, "overall");
        const rawCount = at(guest, "count");
        const overall = rawOverall !== undefined ? Number(rawOverall) : NaN;
        const count = rawCount !== undefined ? Number(rawCount) : NaN;
        const images = list(at(c, "images"));
        const firstImage = images.length
          ? (at(at(at(images[0], "links"), "350px"), "href") ?? null)
          : null;

        offers.push({
          supplierRef: p.id,
          title: String(name),
          city: String(at(addr, "city") || ""),
          country: String(at(addr, "country_code") || ""),
          place: [at(addr, "line_1"), at(addr, "city")].filter(Boolean).join(", "),
          price: p.total.price,
          currency: p.total.currency,
          nights,
          refundable: p.total.refundable,
          /* Rapid's guest rating is out of 10 and IS something guests left, so
             it is carried — attributed to Expedia, never shown as a PALTAS
             rating. NaN becomes null rather than 0. */
          rating: Number.isFinite(overall) ? overall : null,
          ratingCount: Number.isFinite(count) ? Math.round(count) : null,
          image: firstImage === null ? null : String(firstImage),
          deepLink: null,
        });
        if (offers.length >= limit) break;
      }

      return { offers };
    },
  };
}

/**
 * Remove anything credential-shaped from a string before it is thrown.
 *
 * Rapid's own error bodies sometimes echo the request, which carries the
 * Authorization header — so this runs on every error path rather than at the
 * one place a key seemed likely to appear.
 */
export function redact(s: unknown): string {
  return String(s || "")
    .replace(/APIKey=[^,\s"]+/gi, "APIKey=[redacted]")
    .replace(/Signature=[^,\s"]+/gi, "Signature=[redacted]")
    .replace(/\b[a-f0-9]{128}\b/gi, "[redacted-signature]")
    .replace(/("?(?:api[_-]?key|shared[_-]?secret|secret)"?\s*[:=]\s*"?)[^",\s}]+/gi,
             "$1[redacted]");
}

/**
 * Build the adapter from the environment, or explain why it cannot be.
 *
 * Returns null rather than throwing when credentials are absent, because "no
 * supplier configured" is the NORMAL state of this installation and must not
 * stop the service from booting.
 */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): AccommodationSupplier | null {
  if (!env.EXPEDIA_RAPID_API_KEY || !env.EXPEDIA_RAPID_SECRET) return null;

  let regions: Record<string, unknown> = {};
  if (env.EXPEDIA_RAPID_REGIONS) {
    try {
      regions = JSON.parse(env.EXPEDIA_RAPID_REGIONS);
    } catch {
      /* A malformed map is a configuration error worth surfacing, but it must
         not take the supplier down: an empty map means every city politely
         returns no supplier offers with a reason. */
      regions = {};
    }
  }

  return expediaRapid({
    apiKey: env.EXPEDIA_RAPID_API_KEY,
    sharedSecret: env.EXPEDIA_RAPID_SECRET,
    test: env.EXPEDIA_RAPID_TEST === "1",
    regions,
  });
}
