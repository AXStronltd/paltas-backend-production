/* ====================================================================== *
 * LITEAPI (Nuitee Connect), v3.0.
 *
 * The third supplier behind `src/domain/supply.js`, and the first one this
 * installation actually holds a key for.
 *
 * Contract verified against the published reference rather than memory:
 *
 *   base     https://api.liteapi.travel/v3.0
 *   auth     X-API-Key: <key>
 *   sandbox  keys are prefixed `sand_`; production keys are not
 *
 *   POST /hotels/rates    prices for a stay, by cityName + countryCode
 *   GET  /data/hotels     names, addresses, star ratings, photos, in bulk
 *
 * ── WHY THIS ONE IS BETTER TO INTEGRATE THAN THE OTHER TWO ──────────────
 *
 * Expedia Rapid and the Booking.com Demand API both price by an opaque region
 * or city id and offer no search by name, which is why both of those adapters
 * carry a hand-maintained id map and return nothing for an unmapped city. A
 * wrong id there returns real hotels in the wrong country at real prices.
 *
 * LiteAPI takes `cityName` and `countryCode` directly. There is no id map, no
 * unmapped-city dead end, and nothing to get silently wrong — which removes the
 * single largest caveat from the other two adapters.
 *
 * ── STILL TWO CALLS ─────────────────────────────────────────────────────
 *
 * Same as the others, for the same reason. `/hotels/rates` returns `hotelId`
 * and money and no name; `/data/hotels` returns the content. A card needs both,
 * so they are joined on hotel id and anything present in only one is dropped
 * rather than drawn half-blank. `/data/hotels` takes a comma-separated
 * `hotelIds`, so the join costs one request and not one per hotel — the
 * single-hotel `/data/hotel` endpoint would have cost N.
 *
 * ── SANDBOX ─────────────────────────────────────────────────────────────
 *
 * A `sand_` key FORCES sandbox mode and cannot be overridden. LiteAPI's sandbox
 * returns real hotel content with test rates, which is exactly the combination
 * that looks bookable and is not. Every offer is marked, on the card, with a
 * disclosure that travels on the row.
 *
 * ── CREDENTIALS ─────────────────────────────────────────────────────────
 *
 *     LITEAPI_KEY             sand_… or prod_…
 *     LITEAPI_CURRENCY        optional, default USD
 *     LITEAPI_NATIONALITY     optional ISO-2 guest nationality, default US
 *
 * From the environment only. `redact()` scrubs the key from every error path,
 * because an API that echoes your request is how a key reaches a log.
 * ====================================================================== */

import { SupplyUnavailable, toMinor } from "../domain/supply.js";

const BASE = "https://api.liteapi.travel/v3.0";

/**
 * The cheapest retail total across a hotel's room types and rates.
 *
 * LiteAPI nests it at
 *   roomTypes[].rates[].retailRate.total[] -> { amount, currency }
 *
 * `total` is an ARRAY, hence the [0]. RETAIL is taken rather than
 * `suggestedSellingPrice`: retail is what the booking actually costs, and the
 * suggested selling price is a markup recommendation. Showing the latter would
 * inflate every supplier room against the PALTAS listings beside it.
 */
export function cheapestRate(hotel) {
  let best = null;
  for (const rt of hotel.roomTypes || []) {
    for (const rate of rt.rates || []) {
      const total = rate.retailRate && rate.retailRate.total;
      const first = Array.isArray(total) ? total[0] : total;
      if (!first) continue;
      const minor = toMinor(first.amount);
      if (minor === null) continue;
      const currency = String(first.currency || "").toUpperCase();
      if (!currency) continue;
      if (!best || minor < best.price) {
        best = { price: minor, currency, refundable: refundableFrom(rate) };
      }
    }
  }
  return best;
}

/**
 * LiteAPI states refundability as a tag: "RFN" or "NRFN".
 *
 * Anything else — absent, unrecognised, a new value — becomes null, meaning
 * "the supplier did not say". Defaulting to false would print
 * "Non-refundable" on the supplier's behalf about a booking whose terms nobody
 * here actually read.
 */
export function refundableFrom(rate) {
  const tag = rate && rate.cancellationPolicies && rate.cancellationPolicies.refundableTag;
  if (tag === "RFN") return true;
  if (tag === "NRFN") return false;
  return null;
}

/**
 * A guest review score, only when it is on the scale the page renders.
 *
 * The card prints "x / 10". LiteAPI's `rating` is a 0–10 guest score, but this
 * refuses anything outside that range rather than rescaling a number whose
 * meaning it would be guessing at — a 92 shown as "92/10" is nonsense and a 92
 * quietly divided by ten is a fabrication.
 */
export function ratingOf(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n <= 0 || n > 10) return null;
  return Math.round(n * 10) / 10;
}

/**
 * @param {object} cfg
 *   apiKey        LITEAPI_KEY
 *   currency      what to ask rates in
 *   nationality   ISO-2 guest nationality; LiteAPI prices against it
 *   fetchImpl     injected for tests
 *   timeoutMs     a supplier that hangs must not hang the homepage
 */
export function liteApi({
  apiKey,
  currency = "USD",
  nationality = "US",
  fetchImpl,
  timeoutMs = 7000,
} = {}) {
  if (!apiKey) {
    throw new SupplyUnavailable(
      "LiteAPI cannot be registered without LITEAPI_KEY. Nothing is connected, " +
      "and PALTAS will show only its own listings.");
  }
  const http = fetchImpl || globalThis.fetch;
  if (typeof http !== "function") {
    throw new SupplyUnavailable("No fetch implementation is available for LiteAPI.");
  }

  /*
   * A `sand_` KEY FORCES SANDBOX MODE, AND NOTHING CAN OVERRIDE IT.
   *
   * LiteAPI's sandbox returns REAL hotel names, addresses and photographs with
   * TEST rates. That combination is the most convincing fake inventory this
   * platform could possibly display: a real hotel, a real photograph, a real
   * address, and a price nobody can actually book at.
   *
   * So the key decides, not a flag an operator might forget to set. There is no
   * legitimate reason to present sandbox rates as live.
   */
  const sandbox = /^sand[_-]/i.test(String(apiKey).trim());

  async function call(path, { method = "GET", body = null, params = null } = {}) {
    const url = new URL(BASE + path);
    if (params) for (const [k, v] of params) url.searchParams.append(k, String(v));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await http(url.toString(), {
        method,
        signal: controller.signal,
        headers: {
          "X-API-Key": apiKey,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      clearTimeout(timer);
      throw new SupplyUnavailable(e && e.name === "AbortError"
        ? `LiteAPI did not answer within ${timeoutMs}ms.`
        : `LiteAPI could not be reached: ${redact(String(e && e.message))}`);
    }
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      throw new SupplyUnavailable(
        `LiteAPI returned ${res.status}: ${redact(text).slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new SupplyUnavailable("LiteAPI returned a body that is not JSON.");
    }
  }

  return {
    name: "liteapi",
    label: sandbox ? "LiteAPI (sandbox)" : "LiteAPI",
    sandbox,

    describe() {
      return {
        name: "liteapi",
        label: sandbox ? "LiteAPI (sandbox)" : "LiteAPI",
        connected: true,
        sandbox,
        capabilities: ["search", "rates", "content"],
        why: sandbox
          ? "LiteAPI is connected with a SANDBOX key (it begins \"sand_\"), so " +
            "sandbox mode is forced and cannot be switched off. The hotels are " +
            "real but the rates are test data: every card is marked unbookable."
          : "LiteAPI is connected.",
        disclosure: sandbox
          ? "These rates come from LiteAPI's sandbox environment. The hotel is " +
            "real but the price is test data and the room cannot be booked."
          : "",
      };
    },

    async search({
      city = "", country = "", checkIn = "", checkOut = "", guests = 2,
      limit = 12, currency: want = "",
    } = {}) {
      /*
       * Dates are not optional, and this one genuinely cannot fake it. A rate is
       * priced against live allocation for specific nights; there is no such
       * thing as "the price" without them.
       */
      const a = Date.parse(`${checkIn}T00:00:00Z`);
      const b = Date.parse(`${checkOut}T00:00:00Z`);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
        return {
          offers: [],
          note: "LiteAPI prices a stay, so it needs a check-in and a check-out " +
                "date. No dates were given, so no supplier rates are shown.",
        };
      }
      const nights = Math.round((b - a) / 86_400_000);

      /*
       * A country is required. `/data/hotels` demands countryCode, and a rates
       * search without one would ask LiteAPI to price the planet.
       */
      const cc = String(country || "").trim().toUpperCase();
      if (!cc) {
        return {
          offers: [],
          note: "LiteAPI needs a country before it can price anything, and none " +
                "was given.",
        };
      }

      const ccy = String(want || currency || "USD").toUpperCase();
      const adults = Math.min(10, Math.max(1, Number(guests) || 2));
      const take = Math.min(50, Math.max(1, Number(limit) || 12));

      /* 1. Prices. cityName and countryCode directly — no id map. */
      const rated = await call("/hotels/rates", {
        method: "POST",
        body: {
          ...(city ? { cityName: String(city).trim() } : {}),
          countryCode: cc,
          checkin: checkIn,
          checkout: checkOut,
          occupancies: [{ adults, children: [] }],
          currency: ccy,
          guestNationality: String(nationality || "US").toUpperCase(),
          limit: take * 2,
          /* One rate per hotel is all a card shows, and asking for more makes
             the response several times larger for nothing. */
          maxRatesPerHotel: 1,
        },
      });

      const rows = (rated && Array.isArray(rated.data)) ? rated.data : [];
      const priced = [];
      for (const h of rows) {
        if (!h || !h.hotelId) continue;
        const best = cheapestRate(h);
        if (!best) continue;
        priced.push({ id: String(h.hotelId), ...best });
        if (priced.length >= take * 2) break;
      }
      if (!priced.length) {
        return { offers: [], note: "LiteAPI priced nothing for those dates." };
      }

      /* 2. Content, in ONE request. The single-hotel endpoint would cost N. */
      const content = await call("/data/hotels", {
        params: [
          ["countryCode", cc],
          ["hotelIds", priced.map((p) => p.id).join(",")],
          ["limit", String(Math.min(200, priced.length))],
        ],
      });

      const byId = new Map();
      for (const d of (content && Array.isArray(content.data) ? content.data : [])) {
        if (d && d.id !== undefined) byId.set(String(d.id), d);
      }

      const offers = [];
      for (const p of priced) {
        const d = byId.get(p.id);
        /* No name means no card. */
        if (!d || !d.name) continue;

        offers.push({
          supplierRef: p.id,
          title: String(d.name),
          city: String(d.city || city || ""),
          country: String(d.country || cc).toUpperCase(),
          place: String(d.address || ""),
          price: p.price,
          currency: p.currency,
          nights,
          refundable: p.refundable,
          /* The guest review score, and only if it is on the 0–10 scale the
             card renders. */
          rating: ratingOf(d.rating),
          ratingCount: Number.isFinite(Number(d.reviewCount))
            ? Math.round(Number(d.reviewCount)) : null,
          /* Served from LiteAPI's own host, never re-hosted. */
          image: d.main_photo ? String(d.main_photo)
               : (d.thumbnail ? String(d.thumbnail) : null),
          deepLink: null,
          /* The hotel's own star rating, which is a different thing from a guest
             score. Carried because it is real; the card does not render it yet. */
          stars: Number.isFinite(Number(d.stars)) ? Number(d.stars) : null,
        });
        if (offers.length >= take) break;
      }

      return { offers };
    },
  };
}

/** Scrub the key from anything about to be thrown or logged. */
export function redact(s) {
  return String(s || "")
    .replace(/\b(?:sand|prod)_[A-Za-z0-9-]+/gi, "[redacted-key]")
    .replace(/(X-API-Key"?\s*[:=]\s*"?)[^",\s}]+/gi, "$1[redacted]")
    .replace(/("?(?:api[_-]?key|apiKey)"?\s*[:=]\s*"?)[^",\s}]+/gi, "$1[redacted]");
}

/** Build from the environment, or null when this installation has no key. */
export function fromEnv(env = process.env) {
  if (!env.LITEAPI_KEY) return null;
  return liteApi({
    apiKey: env.LITEAPI_KEY,
    currency: env.LITEAPI_CURRENCY || "USD",
    nationality: env.LITEAPI_NATIONALITY || "US",
  });
}
