import { messageOf } from "../http/errors.ts";
/* The supplier's own description of a hotel, from where suppliers are
   defined rather than restated here. */
import type { SupplierHotel } from "./supply.ts";

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
 * It also answers findHomes(), which is a different product on the same
 * provider — whole homes from Airbnb and Vrbo, which LiteAPI does not sell at
 * all. It lives in this file because the PROVIDER is the same one and there
 * must be exactly one registration: two modules each holding their own would
 * be two places to connect, two to clear, and two to get out of step.
 *
 * It will not present the comparison as like-for-like. PALTAS quotes a specific
 * room on a specific board basis; Google reports what sellers advertise for the
 * property. Those are different things, and `basis` says so in words the page
 * is expected to print rather than paraphrase.
 */

/**
 * WHAT A PRICE COMPARISON PROVIDER HAS TO BE.
 *
 * `compare` is the one register insists on. Everything a comparison returns
 * is somebody else's data, so the results are `unknown` and narrowed where
 * they are read rather than trusted where they arrive.
 */
export interface CompareProvider {
  /** What other sellers are asking for one hotel on one set of dates. */
  compare(query: Record<string, unknown>): Promise<CompareAnswer> | CompareAnswer;
  /**
   * Whole-home listings elsewhere. Optional AT THE TYPE LEVEL and checked
   * again at the call site, because a provider that only compares prices is
   * a legitimate one and findHomes() must say so rather than crash.
   */
  search?(query: Record<string, unknown>): Promise<CompareAnswer> | CompareAnswer;
  describe?(): { name?: string; label?: string; [key: string]: unknown };
  readonly name?: string;
  [key: string]: unknown;
}

/** What one comes back with. Every field optional — it is another company's API. */
export interface CompareAnswer {
  readonly offers?: readonly unknown[];
  readonly results?: readonly unknown[];
  readonly [key: string]: unknown;
}

let provider: CompareProvider | null = null;

/*
 * WHY THERE IS NO PROVIDER — which is a different question from whether there
 * is one, and the only question worth answering when one was expected.
 *
 * "Not connected" covers three situations that need three different actions:
 * nobody configured it, somebody configured it wrongly, or it fell over on the
 * way up. Collapsing them into one message means the only way to tell them
 * apart is a boot log nobody can read from outside the machine.
 *
 * Never holds a credential — the callers below pass a sentence, never a value.
 */
let unavailableBecause = "";

export function noteCompareUnavailable(reason: unknown): void {
  unavailableBecause = String(reason || "");
}

/** Wire the comparison provider. Absent is a normal state. */
export function registerCompare(p: CompareProvider | null | undefined): CompareProvider | null {
  if (p && typeof p.compare !== "function") {
    throw new Error("A comparison provider must implement compare().");
  }
  provider = p || null;
  if (provider) unavailableBecause = "";
  return provider;
}

export function clearCompare() {
  provider = null; unavailableBecause = "";
  CACHE.clear();
  /* Both caches, or a cleared provider still serves its old homes. */
  HOMES.clear();
}

export function compareStatus() {
  if (!provider) {
    return {
      connected: false, name: "", label: "",
      why: unavailableBecause ||
        "No price-comparison provider is connected, so PALTAS shows no other sellers.",
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

/**
 * THE COMPARISON PROVIDER, AS A VISITOR MAY SEE IT.
 *
 * Same reasoning as publicStatus() in supply.js, and the same distinction.
 * A visitor's question is "are other sellers listing this room, and for how
 * much" — the answer is the SELLERS, and those are named in full because
 * naming them is the entire point of a price comparison.
 *
 * Which data provider PALTAS buys that comparison from is not part of the
 * answer. It is a commercial relationship, a guest cannot act on it, and it
 * was appearing in a public response for nobody's benefit.
 *
 * The operator view keeps the name, on /platform/suppliers.
 */
export function publicCompareStatus() {
  const d = compareStatus();
  return {
    connected: d.connected,
    sandbox: Boolean(d.sandbox),
    /* Whether other sellers can be shown, without saying who supplies that. */
    why: d.connected ? "" : "Prices from other sellers are not available right now.",
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

function cacheGet(key: string): ComparisonResult | null {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.until) { CACHE.delete(key); return null; }
  /* Refresh recency so the eviction below drops the genuinely cold ones. */
  CACHE.delete(key); CACHE.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: ComparisonResult): void {
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
/** What a price comparison is asked for. */
export interface CompareQuery {
  /** The accommodation supplier, asked to confirm which hotel this is. */
  readonly supplier?: {
    hotel?(q: Record<string, unknown>): Promise<SupplierHotel | null>;
  } | null;
  readonly hotelId?: unknown;
  readonly country?: unknown;
  readonly currency?: string;
  readonly checkIn?: unknown;
  readonly checkOut?: unknown;
  readonly guests?: number;
}

/**
 * WHAT A PRICE COMPARISON ANSWERS WITH.
 *
 * ONE shape, every time. The function returns from nine places and each
 * spreads `base` and adds what it knows — so without this declared, the
 * return type is a nine-way union and a caller cannot read `offers` at all
 * without narrowing through all nine.
 *
 * The page reads this object directly, so the honest description is: every
 * field is always present, and `why` says why the list is empty when it is.
 * That is what the endpoint has always sent; it was simply never written
 * down.
 */
export interface ComparisonResult {
  readonly hotelId: string;
  readonly checkIn: unknown;
  readonly checkOut: unknown;
  readonly guests: number;
  readonly offers: readonly unknown[];
  readonly min: unknown;
  readonly median: unknown;
  readonly dropped: number;
  readonly provider: ReturnType<typeof publicCompareStatus>;
  /** The caveat the page must print beside two totals from different sellers. */
  readonly basis: string;
  /** Empty when there is a list and nothing to explain. */
  readonly why?: string;
  /** Named when the comparison got far enough to identify the property. */
  readonly hotel?: { name?: string | null; city?: string | null; stars?: unknown };
  readonly currency?: unknown;
  /** True when this answer came from the cache rather than the provider. */
  readonly cached?: boolean;
}

export async function comparePrices({
  supplier, hotelId, country, currency = "", checkIn, checkOut, guests = 2,
}: CompareQuery = {}): Promise<ComparisonResult> {
  const base = {
    hotelId: String(hotelId || ""),
    checkIn, checkOut, guests,
    offers: [], min: null, median: null, dropped: 0,
    /* A public result: the SELLERS are named in full, the provider PALTAS
       buys the comparison from is not. */
    provider: publicCompareStatus(),
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

  if (!provider) return { ...base, why: publicCompareStatus().why };
  if (!hotelId || !checkIn || !checkOut) {
    return { ...base, why: "A comparison needs a hotel and the nights it covers." };
  }

  /*
   * THE NAME COMES FROM THE SUPPLIER, NOT THE REQUEST.
   *
   * This lookup is what makes the endpoint safe to expose. If PALTAS does not
   * sell this hotel, there is no name to ask about and no credit is spent.
   */
  let hotel: SupplierHotel | null = null;
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
             why: messageOf(e) || "The comparison could not be made." };
  }

  const value = {
    ...base,
    hotel: { name: hotel.name, city: hotel.city, stars: hotel.stars },
    currency: out.currency,
    offers: out.offers || [],
    min: out.min || null,
    median: out.median || null,
    dropped: Number(out.dropped) || 0,
    why: (out.offers && out.offers.length)
      ? ""
      : "No other seller published a comparable price for these dates.",
  };
  cacheSet(key, value);
  return value;
}


/*
 * ================================================================
 * WHOLE HOMES FROM OTHER SITES
 * ================================================================
 *
 * PALTAS owns no short-stay homes, and LiteAPI sells hotel rooms — so the
 * "Homes for a few nights" shelf has nothing on it and says so. Airbnb and Vrbo
 * are exactly the gap, and StayingAPI can read them.
 *
 * WHAT THESE ARE NOT: bookable. Every row carries bookable:false and the URL of
 * the site that holds it, for the same reason the comparison does — this
 * provider has no booking endpoint, and a card with a PALTAS button on it would
 * be a promise nobody can keep.
 *
 * WHAT THEY COST: /search bills per result PER PLATFORM — Airbnb 2x, Vrbo 1x,
 * minimum 5. Eight results across both is roughly 24 credits. So this NEVER
 * runs for a visitor who has not named a destination: browsing the homepage
 * must cost nothing, and a homepage that loads inventory on every visit would
 * otherwise bill for bots and bounces alike.
 */
const HOMES = new Map();
const HOMES_TTL_MS = 6 * 60 * 60 * 1000;
const HOMES_MAX = 300;

export function forgetHomes() { HOMES.clear(); }

/** What a homes search is asked for. */
export interface HomesQuery {
  readonly city?: unknown;
  readonly checkIn?: unknown;
  readonly checkOut?: unknown;
  readonly guests?: number;
  readonly currency?: string;
  readonly limit?: number;
}

export async function findHomes(
  { city, checkIn, checkOut, guests = 2, currency = "", limit = 8 }: HomesQuery = {},
) {
  const base = {
    homes: [], city: city || "", checkIn, checkOut,
    /* A public result: the SELLERS are named in full, the provider PALTAS
       buys the comparison from is not. */
    provider: publicCompareStatus(),
    /*
     * The sentence the page prints. These are not PALTAS's, they are not
     * bookable here, and a visitor deserves to know that before they click
     * rather than after.
     */
    basis: "Listed by Airbnb and Vrbo. PALTAS does not sell these \u2014 they are " +
           "booked on the site that lists them.",
  };

  if (!provider || typeof provider.search !== "function") {
    return { ...base, why: publicCompareStatus().why };
  }
  /*
   * NO DESTINATION, NO SEARCH, NO CREDIT. This is the whole cost control, and
   * it is a guard rather than a convention so that a caller cannot forget it.
   */
  if (!city || !String(city).trim()) {
    return { ...base, why: "Choose a destination and these fill in." };
  }
  if (!checkIn || !checkOut) {
    return { ...base, why: "A home is priced for particular nights, so these need dates." };
  }

  const key = [String(city).trim().toLowerCase(), checkIn, checkOut, guests, currency].join("|");
  const hit = HOMES.get(key);
  if (hit && Date.now() <= hit.until) {
    HOMES.delete(key); HOMES.set(key, hit);
    return { ...hit.value, cached: true };
  }

  let out;
  try {
    out = await provider.search({
      location: String(city).trim(),
      checkIn, checkOut, adults: guests,
      /* The two platforms LiteAPI does not cover. Asking for the others would
         return hotels PALTAS already sells, billed a second time. */
      platforms: ["airbnb", "vrbo"],
      limit: Math.max(1, Math.min(20, Number(limit) || 8)),
      sort: "price_asc",
    });
  } catch (e) {
    /* An extra that failed is still an extra: the shelf says what it said
       before, and the bookable inventory around it is untouched. */
    return { ...base, why: messageOf(e) || "Other sites could not be read." };
  }

  const homes = (out.results ?? []).filter(
    (r: unknown): r is Record<string, unknown> =>
      typeof r === "object" && r !== null
      && (r as Record<string, unknown>)["bookable"] === false
      && Boolean((r as Record<string, unknown>)["url"]));
  const value = {
    ...base,
    homes,
    count: homes.length,
    why: homes.length ? "" : "Airbnb and Vrbo list nothing for those dates.",
  };

  if (HOMES.size >= HOMES_MAX) {
    const oldest = HOMES.keys().next().value;
    if (oldest !== undefined) HOMES.delete(oldest);
  }
  HOMES.set(key, { value, until: Date.now() + HOMES_TTL_MS });
  return value;
}
