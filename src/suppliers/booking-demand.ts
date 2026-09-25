/* ====================================================================== *
 * BOOKING.COM DEMAND API, v3.
 *
 * The second supplier behind `src/domain/supply.js`, written to the same shape
 * as the Expedia Rapid adapter so the two are comparable line for line.
 *
 * ── WHAT IS VERIFIABLE HERE, AND WHAT IS NOT ────────────────────────────
 *
 * Less than for Rapid, and the difference is the whole reason Rapid went first.
 *
 * Rapid signs each request with SHA-512(key + secret + timestamp) — a pure
 * function, so the part that fails with an unexplained 401 is under test with
 * no account at all. Booking.com authenticates with a BEARER TOKEN issued to an
 * affiliate. A token cannot be derived, so nothing about this adapter's auth
 * can be checked until somebody holds one.
 *
 * What IS tested below: the request bodies, the two-call join, the response
 * mapping against captured shapes, the refusals, and the redaction. What is
 * not, and cannot be: that Booking.com accepts the token, that its live
 * response matches the documented shape, and that any city id is the city
 * claimed.
 *
 * ── THE SHAPE OF A DEMAND SEARCH ────────────────────────────────────────
 *
 * Two POSTs, for the same reason Rapid needs two GETs:
 *
 *   POST /accommodations/search    ids, dates and prices. No names.
 *   POST /accommodations/details   names, cities, photos, review scores.
 *
 * And the same identifier problem. Search takes a numeric Booking city id, a
 * bounding box, or an explicit list of accommodation ids — never a city name.
 * So this adapter takes a city map and, for an unmapped city, returns NO ROOMS
 * WITH A REASON. It does not guess an id: Booking's city ids are opaque
 * integers and a wrong one returns real hotels somewhere else at real prices,
 * which looks entirely correct and is completely wrong.
 *
 * ── CREDENTIALS ─────────────────────────────────────────────────────────
 *
 *     BOOKING_DEMAND_TOKEN       the affiliate bearer token
 *     BOOKING_DEMAND_AFFILIATE   the X-Affiliate-Id value
 *     BOOKING_DEMAND_TEST=1      marks everything SANDBOX on the page
 *     BOOKING_DEMAND_CITIES      {"mombasa,ke": "-1234567"} as JSON
 *
 * From the environment only. Never logged, never returned, and `redact()`
 * scrubs bearer tokens from every error path because an API that echoes your
 * request is how a token reaches a log file.
 * ====================================================================== */

import { SupplyUnavailable, toMinor 
} from "../domain/supply.ts";
import type {
  AccommodationSupplier, FetchLike, FetchReply, RawOffer, SupplierDescription, SupplyQuery, SupplyResult,
} from "../domain/supply.ts";
import { messageOf } from "../http/errors.ts";

/**
 * A JSON body from Booking.com. Everything below narrows it field by field,
 * because nothing arriving over that wire has been checked by anybody here.
 */
type Json = Record<string, unknown>;

/** Read one property off an unknown object without asserting its shape. */
const at = (v: unknown, key: string): unknown =>
  (typeof v === "object" && v !== null) ? (v as Json)[key] : undefined;

const BASE = "https://demandapi.booking.com/3.1";

/** Nights between two ISO dates; null for anything that is not a real stay. */
export function nightsBetween(checkIn: string, checkOut: string): number | null {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round((b - a) / 86_400_000);
}

function cityIndex(map: Readonly<Record<string, unknown>> | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(map || {})) {
    out.set(String(k).toLowerCase().replace(/\s+/g, ""), String(v));
  }
  return out;
}

/**
 * The price of one search result.
 *
 * Booking nests it under `price.total` or `price.gross_amount`, depending on
 * which `extras` were requested. GROSS is taken where both exist: it is the
 * figure including taxes and fees, and the net one is lower and not what a
 * guest pays. Showing net would undercut every PALTAS listing beside it with a
 * number nobody will be charged.
 */
export function priceOf(result: unknown): { price: number; currency: string } | null {
  const p = at(result, "price");
  if (!p) return null;
  const pick = at(p, "gross_amount") || at(p, "total") || at(p, "amount") || null;
  if (!pick) return null;
  const value = at(pick, "value");
  const minor = toMinor((value !== undefined ? value : pick) as number | string);
  if (minor === null) return null;
  const currency = String(at(pick, "currency") || at(p, "currency") || "").toUpperCase();
  if (!currency) return null;
  return { price: minor, currency };
}

/** How this adapter is configured. */
export interface BookingDemandConfig {
  readonly token?: string;
  readonly affiliateId?: string;
  /** Marks every offer SANDBOX. A sandbox token forces it on regardless. */
  readonly test?: boolean;
  /** `{ "city,cc": "booking_city_id" }` — Booking prices by city id, not name. */
  readonly cities?: Readonly<Record<string, unknown>>;
  /** Injected for tests. */
  readonly fetchImpl?: FetchLike;
  /** A supplier that hangs must not hang the homepage. */
  readonly timeoutMs?: number;
  /** Overridable base, for a proxy or a test that must not reach the network. */
  readonly baseUrl?: string;
}

export function bookingDemand({
  token,
  affiliateId,
  test = false,
  cities = {},
  fetchImpl,
  timeoutMs = 6000,
  baseUrl = BASE,
}: BookingDemandConfig = {}): AccommodationSupplier {
  if (!token || !affiliateId) {
    throw new SupplyUnavailable(
      "Booking.com Demand cannot be registered without BOOKING_DEMAND_TOKEN and " +
      "BOOKING_DEMAND_AFFILIATE. Nothing is connected, and PALTAS will show " +
      "only its own listings.");
  }

  /*
   * A SANDBOX TOKEN FORCES SANDBOX MODE, WHATEVER THE FLAG SAYS.
   *
   * Booking.com issues test credentials prefixed `sand_`. If one of those is
   * configured without BOOKING_DEMAND_TEST=1, every rate it returns renders as
   * ordinary bookable inventory — real-looking hotels at real-looking prices
   * that cannot actually be booked by anybody.
   *
   * That is the single worst failure available to this integration, and it
   * happens through an omission rather than a mistake: somebody pastes the
   * token and forgets the flag. So the token itself decides. An operator cannot
   * turn this off, because there is no legitimate reason to present test
   * inventory as live.
   */
  const looksSandbox = /^sand[_-]/i.test(String(token).trim());
  const sandbox = Boolean(test) || looksSandbox;
  const http = fetchImpl || globalThis.fetch;
  if (typeof http !== "function") {
    throw new SupplyUnavailable("No fetch implementation is available for Booking.com Demand.");
  }
  const index = cityIndex(cities);

  async function call(path: string, body: Json, travellerIp?: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: FetchReply;
    try {
      res = await http(baseUrl + path, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Affiliate-Id": String(affiliateId),
          "Content-Type": "application/json",
          Accept: "application/json",
          /* Booking applies the right market from the end traveller's address,
             not the calling server's. Passed through, stored nowhere. */
          ...(travellerIp ? { "X-Forwarded-For": travellerIp } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      clearTimeout(timer);
      throw new SupplyUnavailable(at(e, "name") === "AbortError"
        ? `Booking.com did not answer within ${timeoutMs}ms.`
        : `Booking.com could not be reached: ${redact(messageOf(e))}`);
    }
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      throw new SupplyUnavailable(
        `Booking.com returned ${res.status}: ${redact(text).slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new SupplyUnavailable("Booking.com returned a body that is not JSON.");
    }
  }

  return {
    name: "booking-demand",
    /* The brand a visitor is told, which is what the licence attributes. */
    label: "Booking.com",
    sandbox,

    describe(): SupplierDescription {
      return {
        name: "booking-demand",
        label: "Booking.com",
        connected: true,
        sandbox,
        capabilities: ["search", "details"],
        why: sandbox
          ? "Booking.com Demand is connected in TEST mode" +
            (looksSandbox && !test
              ? " \u2014 forced, because the configured token is a sandbox token " +
                "(it begins \"sand_\"). Set BOOKING_DEMAND_TEST=1 to make this " +
                "explicit, or use a production token."
              : "") +
            ". Every offer it returns is marked as a sandbox rate and must not " +
            "be presented as bookable."
          : "Booking.com Demand is connected.",
        /* Said out loud so an operator can see which rates these are. */
        disclosure: sandbox
          ? "These rates come from Booking.com's TEST environment. They are not " +
            "real availability and cannot be booked."
          : "",
        citiesKnown: index.size,
      };
    },

    async search({
      city = "", country = "", checkIn = "", checkOut = "", guests = 2,
      limit = 12, currency = "USD", travellerIp = "",
    }: SupplyQuery = {}): Promise<SupplyResult> {
      const nights = nightsBetween(checkIn, checkOut);
      if (!nights) {
        return {
          offers: [],
          note: "Booking.com prices a stay, so it needs a check-in and a " +
                "check-out date. No dates were given, so no supplier rates are shown.",
        };
      }

      const key = `${city}`.toLowerCase().replace(/\s+/g, "") + "," +
                  `${country}`.toLowerCase().replace(/\s+/g, "");
      const cityId = index.get(key);
      if (!cityId) {
        return {
          offers: [],
          note: `Booking.com has no city id mapped for "${city}, ${country}", so ` +
                `no supplier rates are shown for it. ${index.size} city/cities ` +
                `are configured.`,
        };
      }

      const adults = Math.min(30, Math.max(1, Number(guests) || 2));
      const found = await call("/accommodations/search", {
        checkin: checkIn,
        checkout: checkOut,
        city: Number(cityId),
        guests: { number_of_adults: adults, number_of_rooms: 1 },
        currency: String(currency || "USD").toUpperCase(),
        booker: {
          /* Booking requires the booker's market; it decides which rates and
             which legal terms apply. */
          country: String(country || "US").toLowerCase(),
          platform: "desktop",
        },
        extras: ["extra_charges", "products"],
        rows: Math.min(100, Math.max(1, limit) * 3),
      }, travellerIp);

      const foundData = at(found, "data");
      const results: unknown[] = Array.isArray(foundData) ? foundData : [];
      const priced: { id: string; price: number; currency: string }[] = [];
      for (const r of results) {
        const id = at(r, "id");
        if (id === undefined || id === null) continue;
        const p = priceOf(r);
        if (!p) continue;
        priced.push({ id: String(id), ...p });
        if (priced.length >= Math.min(100, Math.max(1, limit) * 3)) break;
      }
      if (!priced.length) return { offers: [], note: "Booking.com priced nothing for those dates." };

      /* Names, cities, photos and review scores — the second call. */
      const details = await call("/accommodations/details", {
        accommodations: priced.map((p) => Number(p.id)).filter(Number.isFinite),
        languages: ["en-gb"],
        extras: ["photos", "description"],
      }, travellerIp);

      const detailData = at(details, "data");
      const byId = new Map<string, unknown>();
      for (const d of (Array.isArray(detailData) ? detailData : [])) {
        const id = at(d, "id");
        if (id !== undefined) byId.set(String(id), d);
      }

      const offers: RawOffer[] = [];
      for (const p of priced) {
        const d = byId.get(p.id);
        const name = at(d, "name");
        /* No name means no card. Dropped rather than drawn half-blank. */
        if (!d || !name) continue;

        const review = at(d, "reviews") || at(d, "review_scores") || {};
        const rawScore = at(review, "score");
        const rawCount = at(review, "count");
        const score = rawScore !== undefined ? Number(rawScore) : NaN;
        const count = rawCount !== undefined ? Number(rawCount) : NaN;
        const photos = at(d, "photos");
        const firstPhoto = Array.isArray(photos) && photos.length ? photos[0] : null;
        const photo = firstPhoto
          ? (at(firstPhoto, "url") || at(at(firstPhoto, "urls"), "url") || null)
          : null;
        const location = at(d, "location");
        const address = at(d, "address");
        const url = at(d, "url");

        offers.push({
          supplierRef: p.id,
          title: typeof name === "string" ? name : String(at(name, "en-gb") || ""),
          city: String(at(location, "city") || at(address, "city") || ""),
          country: String(at(location, "country") || at(address, "country") || "").toUpperCase(),
          place: String(at(address, "address") || ""),
          price: p.price,
          currency: p.currency,
          nights,
          /* Booking reports cancellation per product, not per property, and
             this adapter does not request products in enough depth to be sure.
             Null means "the supplier did not say", which is honest; false would
             claim non-refundable on the supplier's behalf. */
          refundable: null,
          /* Booking scores out of 10, like Rapid. Real guest data, attributed. */
          rating: Number.isFinite(score) ? score : null,
          ratingCount: Number.isFinite(count) ? Math.round(count) : null,
          image: photo === null ? null : String(photo),
          deepLink: url ? String(url) : null,
        });
        if (offers.length >= limit) break;
      }

      return { offers };
    },
  };
}

/** Scrub anything credential-shaped before it is thrown or logged. */
export function redact(s: unknown): string {
  return String(s || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/("?(?:token|access_token|affiliate[_-]?id|secret)"?\s*[:=]\s*"?)[^",\s}]+/gi,
             "$1[redacted]")
    .replace(/X-Affiliate-Id:\s*\S+/gi, "X-Affiliate-Id: [redacted]");
}

/** Build from the environment, or null when this installation has no token. */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): AccommodationSupplier | null {
  if (!env.BOOKING_DEMAND_TOKEN || !env.BOOKING_DEMAND_AFFILIATE) return null;

  let cities: Record<string, unknown> = {};
  if (env.BOOKING_DEMAND_CITIES) {
    try { cities = JSON.parse(env.BOOKING_DEMAND_CITIES); } catch { cities = {}; }
  }
  return bookingDemand({
    token: env.BOOKING_DEMAND_TOKEN,
    affiliateId: env.BOOKING_DEMAND_AFFILIATE,
    test: env.BOOKING_DEMAND_TEST === "1",
    cities,
  });
}
