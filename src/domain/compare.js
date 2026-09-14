/**
 * PRICE COMPARISON — a fact added to a room PALTAS can actually sell.
 *
 * This is the ONLY thing StayingAPI is used for here, and the reason is in
 * src/suppliers/stayingapi.js: that API has no booking endpoint at all, so
 * anything it surfaces on its own would be a room nobody could take. Attached
 * to a LiteAPI hotel that IS bookable, the same data becomes useful — here is
 * what this stay costs on the sites that also sell it.
 *
 * WHAT THIS REFUSES TO DO
 *
 * It will not compare a hotel PALTAS does not sell. The caller supplies an id
 * and a country; the property NAME asked about is read from the supplier's own
 * content for that id. A comparison costs 30 credits against a metered account,
 * so a route that accepted a name would be an open door onto somebody's bill.
 *
 * It will not convert currencies. PALTAS holds no rate it would stand behind,
 * and a converted figure beside a real one is a comparison wrong by whatever
 * the rate happens to be. Offers in another currency are dropped and counted.
 *
 * It will not present the comparison as like-for-like. PALTAS quotes a specific
 * room on a specific board basis; Google reports what sellers advertise for the
 * property. Those are different things, and `basis` says so in words the page
 * is expected to print rather than paraphrase.
 */

let provider = null;

/** Wire the comparison provider. Absent is a normal state. */
export function registerCompare(p) {
  if (p && typeof p.compare !== "function") {
    throw new Error("A comparison provider must implement compare().");
  }
  provider = p || null;
  return provider;
}

export function clearCompare() { provider = null; CACHE.clear(); }

export function compareStatus() {
  if (!provider) {
    return {
      connected: false, name: "", label: "",
      why: "No price-comparison provider is connected, so PALTAS shows no other sellers.",
    };
  }
  const d = provider.describe ? provider.describe() : {};
  return {
    connected: true,
    name: d.name || provider.name || "",
    label: d.label || "",
    sandbox: Boolean(d.sandbox),
    why: d.why || "",
  };
}

/*
 * A SMALL, BOUNDED, EXPIRING CACHE.
 *
 * Keyed on everything that changes the answer and nothing that does not, so two
 * visitors asking the same question of the same hotel for the same nights are
 * one call. Bounded because an unbounded cache on a public route is a memory
 * leak with a rate limiter in front of it.
 */
const CACHE = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;   /* six hours; OTA prices do not move faster */
const MAX_ENTRIES = 500;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.until) { CACHE.delete(key); return null; }
  /* Refresh recency so the eviction below drops the genuinely cold ones. */
  CACHE.delete(key); CACHE.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (CACHE.size >= MAX_ENTRIES) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(key, { value, until: Date.now() + TTL_MS });
}

/** For tests, and for a deploy that wants to start cold. */
export function forgetComparisons() { CACHE.clear(); }

/**
 * Compare one hotel PALTAS sells.
 *
 * Never throws for an absent provider or an empty answer — a comparison is an
 * extra, and a missing extra must not take a bookable room off the page with
 * it. It returns `offers: []` and says why.
 */
export async function comparePrices({
  supplier, hotelId, country, currency = "", checkIn, checkOut, guests = 2,
} = {}) {
  const base = {
    hotelId: String(hotelId || ""),
    checkIn, checkOut, guests,
    offers: [], min: null, median: null, dropped: 0,
    provider: compareStatus(),
    /*
     * THE SENTENCE THE PAGE MUST PRINT.
     *
     * PALTAS quotes one room on one board basis. Google reports what sellers
     * advertise for the PROPERTY, which may be a different room, a different
     * board basis or a different cancellation policy. Saying so is the
     * difference between a useful comparison and a misleading one, and leaving
     * it to whoever writes the template is how it gets dropped.
     */
    basis: "Other sellers' advertised totals for this property and these dates. " +
           "Room type, board basis and cancellation terms may differ from the room " +
           "priced here.",
  };

  if (!provider) return { ...base, why: compareStatus().why };
  if (!hotelId || !checkIn || !checkOut) {
    return { ...base, why: "A comparison needs a hotel and the nights it covers." };
  }

  /*
   * THE NAME COMES FROM THE SUPPLIER, NOT THE REQUEST.
   *
   * This lookup is what makes the endpoint safe to expose. If PALTAS does not
   * sell this hotel, there is no name to ask about and no credit is spent.
   */
  let hotel = null;
  try {
    if (supplier && typeof supplier.hotel === "function") {
      hotel = await supplier.hotel({ hotelId, countryCode: country });
    }
  } catch {
    return { ...base, why: "PALTAS could not confirm which hotel this is, so it asked nothing." };
  }
  if (!hotel || !hotel.name) {
    return { ...base, why: "PALTAS does not sell this hotel, so there is nothing to compare." };
  }

  const key = [hotelId, country, currency, checkIn, checkOut, guests].join("|");
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  let out;
  try {
    out = await provider.compare({
      name: hotel.name,
      location: hotel.city || hotel.country || country,
      checkIn, checkOut, adults: guests, currency,
    });
  } catch (e) {
    /* A comparison that failed is an extra that failed. The room is unaffected,
       and the reason is passed through rather than swallowed. */
    return { ...base, hotel: { name: hotel.name, city: hotel.city },
             why: (e && e.message) || "The comparison could not be made." };
  }

  const value = {
    ...base,
    hotel: { name: hotel.name, city: hotel.city, stars: hotel.stars },
    currency: out.currency,
    offers: out.offers || [],
    min: out.min || null,
    median: out.median || null,
    dropped: out.dropped || 0,
    why: (out.offers && out.offers.length)
      ? ""
      : "No other seller published a comparable price for these dates.",
  };
  cacheSet(key, value);
  return value;
}
