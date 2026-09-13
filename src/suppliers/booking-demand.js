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

import { SupplyUnavailable, toMinor } from "../domain/supply.js";

const BASE = "https://demandapi.booking.com/3.1";

/** Nights between two ISO dates; null for anything that is not a real stay. */
export function nightsBetween(checkIn, checkOut) {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round((b - a) / 86_400_000);
}

function cityIndex(map) {
  const out = new Map();
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
export function priceOf(result) {
  const p = result && result.price;
  if (!p) return null;
  const pick = p.gross_amount || p.total || p.amount || null;
  if (!pick) return null;
  const minor = toMinor(pick.value !== undefined ? pick.value : pick);
  if (minor === null) return null;
  const currency = String(pick.currency || p.currency || "").toUpperCase();
  if (!currency) return null;
  return { price: minor, currency };
}

/**
 * @param {object} cfg
 *   token, affiliateId   from the environment
 *   test                 marks every offer SANDBOX
 *   cities               { "city,cc": "booking_city_id" }
 *   fetchImpl            injected for tests
 *   timeoutMs            a supplier that hangs must not hang the homepage
 */
export function bookingDemand({
  token,
  affiliateId,
  test = false,
  cities = {},
  fetchImpl,
  timeoutMs = 6000,
} = {}) {
  if (!token || !affiliateId) {
    throw new SupplyUnavailable(
      "Booking.com Demand cannot be registered without BOOKING_DEMAND_TOKEN and " +
      "BOOKING_DEMAND_AFFILIATE. Nothing is connected, and PALTAS will show " +
      "only its own listings.");
  }
  const http = fetchImpl || globalThis.fetch;
  if (typeof http !== "function") {
    throw new SupplyUnavailable("No fetch implementation is available for Booking.com Demand.");
  }
  const index = cityIndex(cities);

  async function call(path, body, travellerIp) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await http(BASE + path, {
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
      throw new SupplyUnavailable(e && e.name === "AbortError"
        ? `Booking.com did not answer within ${timeoutMs}ms.`
        : `Booking.com could not be reached: ${redact(String(e && e.message))}`);
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
    sandbox: Boolean(test),

    describe() {
      return {
        name: "booking-demand",
        label: "Booking.com",
        connected: true,
        sandbox: Boolean(test),
        capabilities: ["search", "details"],
        why: test
          ? "Booking.com Demand is connected in TEST mode. Every offer it returns " +
            "is marked as a sandbox rate and must not be presented as bookable."
          : "Booking.com Demand is connected.",
        citiesKnown: index.size,
      };
    },

    async search({
      city = "", country = "", checkIn = "", checkOut = "", guests = 2,
      limit = 12, currency = "USD", travellerIp = "",
    } = {}) {
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

      const results = (found && Array.isArray(found.data)) ? found.data : [];
      const priced = [];
      for (const r of results) {
        if (!r || r.id === undefined || r.id === null) continue;
        const p = priceOf(r);
        if (!p) continue;
        priced.push({ id: String(r.id), ...p });
        if (priced.length >= Math.min(100, Math.max(1, limit) * 3)) break;
      }
      if (!priced.length) return { offers: [], note: "Booking.com priced nothing for those dates." };

      /* Names, cities, photos and review scores — the second call. */
      const details = await call("/accommodations/details", {
        accommodations: priced.map((p) => Number(p.id)).filter(Number.isFinite),
        languages: ["en-gb"],
        extras: ["photos", "description"],
      }, travellerIp);

      const byId = new Map();
      for (const d of (details && Array.isArray(details.data) ? details.data : [])) {
        if (d && d.id !== undefined) byId.set(String(d.id), d);
      }

      const offers = [];
      for (const p of priced) {
        const d = byId.get(p.id);
        /* No name means no card. Dropped rather than drawn half-blank. */
        if (!d || !d.name) continue;

        const review = d.reviews || d.review_scores || {};
        const score = review.score !== undefined ? Number(review.score) : NaN;
        const count = review.count !== undefined ? Number(review.count) : NaN;
        const photo = Array.isArray(d.photos) && d.photos.length
          ? (d.photos[0].url || (d.photos[0].urls && d.photos[0].urls.url) || null)
          : null;

        offers.push({
          supplierRef: p.id,
          title: typeof d.name === "string" ? d.name : (d.name && d.name["en-gb"]) || "",
          city: (d.location && d.location.city) || (d.address && d.address.city) || "",
          country: ((d.location && d.location.country) ||
                    (d.address && d.address.country) || "").toUpperCase(),
          place: (d.address && d.address.address) || "",
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
          image: photo,
          deepLink: (d.url && String(d.url)) || null,
        });
        if (offers.length >= limit) break;
      }

      return { offers };
    },
  };
}

/** Scrub anything credential-shaped before it is thrown or logged. */
export function redact(s) {
  return String(s || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/("?(?:token|access_token|affiliate[_-]?id|secret)"?\s*[:=]\s*"?)[^",\s}]+/gi,
             "$1[redacted]")
    .replace(/X-Affiliate-Id:\s*\S+/gi, "X-Affiliate-Id: [redacted]");
}

/** Build from the environment, or null when this installation has no token. */
export function fromEnv(env = process.env) {
  if (!env.BOOKING_DEMAND_TOKEN || !env.BOOKING_DEMAND_AFFILIATE) return null;

  let cities = {};
  if (env.BOOKING_DEMAND_CITIES) {
    try { cities = JSON.parse(env.BOOKING_DEMAND_CITIES); } catch (e) { cities = {}; }
  }
  return bookingDemand({
    token: env.BOOKING_DEMAND_TOKEN,
    affiliateId: env.BOOKING_DEMAND_AFFILIATE,
    test: env.BOOKING_DEMAND_TEST === "1",
    cities,
  });
}
