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

import { SupplyUnavailable, toMinor 
} from "../domain/supply.ts";
import type {
  AccommodationSupplier, FetchLike, FetchReply, BookRequest, BookingGuest, BookingQuery, HotelQuery,
  PrebookQuery, RawOffer, RoomsQuery, SupplierDescription, SupplyQuery, SupplyResult,
} from "../domain/supply.ts";
import { messageOf } from "../http/errors.ts";

/** A JSON value from LiteAPI. Narrowed where read, never trusted on arrival. */
type Json = Record<string, unknown>;

/** Read one property off an unknown object without asserting its shape. */
const at = (v: unknown, key: string): unknown =>
  (typeof v === "object" && v !== null) ? (v as Json)[key] : undefined;

/** The same, for a list. Anything that is not an array reads as empty. */
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Where LiteAPI lives. Overridable so a proxy or a future host is config. */
export const DEFAULT_BASE = "https://api.liteapi.travel/v3.0";

/*
 * Stripe.js, loaded by the browser for the Payment Element.
 *
 * DIRECT STRIPE ELEMENTS, not LiteAPI's hosted wrapper. The difference that
 * matters: the PaymentIntent is created on LITEAPI'S Stripe platform when
 * prebook is called, so — in their words — "you never need your own Stripe
 * account or your own server-side Stripe integration". PALTAS mounts an Element
 * against LiteAPI's PaymentIntent using LiteAPI's publishable key, the guest's
 * card goes straight to Stripe, and LiteAPI captures on booking.
 *
 * This is therefore NOT a second payment system. It creates no PaymentIntent, no
 * customer, no charge and no Stripe account of its own, and it is reachable only
 * from a hotel checkout. Anything PALTAS-native stays wherever it already lives.
 */
export const STRIPE_JS_URL = "https://js.stripe.com/v3/";

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
/** The cheapest bookable rate at one hotel, and what it takes to book it. */
export interface CheapestRate {
  readonly price: number;
  readonly currency: string;
  readonly refundable: boolean | null;
  /** The identifier /rates/prebook takes. Lives on the ROOM TYPE, not the rate. */
  readonly offerId: string | null;
  readonly rateId: string | null;
  readonly roomName: string;
  readonly boardName: string;
  readonly maxOccupancy: number | null;
}

export function cheapestRate(hotel: unknown): CheapestRate | null {
  let best: CheapestRate | null = null;
  for (const rt of list(at(hotel, "roomTypes"))) {
    for (const rate of list(at(rt, "rates"))) {
      const total = at(at(rate, "retailRate"), "total");
      const first = Array.isArray(total) ? total[0] : total;
      if (!first) continue;
      const minor = toMinor(at(first, "amount") as number | string);
      if (minor === null) continue;
      const currency = String(at(first, "currency") || "").toUpperCase();
      if (!currency) continue;
      if (!best || minor < best.price) {
        const offerId = at(rt, "offerId");
        const rateId = at(rate, "rateId");
        const maxOccupancy = at(rate, "maxOccupancy");
        best = {
          price: minor,
          currency,
          refundable: refundableFrom(rate),
          /*
           * THE IDENTIFIER THE WHOLE BOOKING FLOW HANGS ON.
           *
           * `offerId` lives on the ROOM TYPE, not on the rate — `rateId` is the
           * rate within it. /rates/prebook takes the offerId, so it has to be
           * carried up from the parent here. Reading it off the rate returns
           * undefined and prebook fails with a validation error that says
           * nothing about where the id was supposed to come from.
           */
          offerId: offerId ? String(offerId) : null,
          rateId: rateId ? String(rateId) : null,
          /* What the room actually is, which a guest choosing between two rates
             at the same hotel needs to see. */
          roomName: String(at(rt, "name") || at(rate, "name") || ""),
          boardName: String(at(rate, "boardName") || at(rate, "boardType") || ""),
          maxOccupancy: Number.isFinite(Number(maxOccupancy))
            ? Number(maxOccupancy) : null,
        };
      }
    }
  }
  return best;
}

/**
 * Every bookable offer at one hotel, cheapest first.
 *
 * `cheapestRate` answers "what does this hotel cost", which is all a marketplace
 * card needs. This answers "what could I actually book", which is what a guest
 * needs once they have chosen the hotel — a room name, a board type, what it
 * costs and whether it can be cancelled, per offer.
 *
 * An offer with no offerId is omitted: it cannot be prebooked, so showing it
 * would be offering something that cannot be taken.
 */
/** One bookable offer, plus the deadlines it can be cancelled against. */
export interface BookableOffer extends Omit<CheapestRate, "offerId"> {
  readonly offerId: string;
  readonly cancellation: readonly CancellationTerm[];
}

export function offersFor(hotel: unknown): BookableOffer[] {
  const out: BookableOffer[] = [];
  for (const rt of list(at(hotel, "roomTypes"))) {
    const offerId = at(rt, "offerId");
    if (!offerId) continue;
    for (const rate of list(at(rt, "rates"))) {
      const total = at(at(rate, "retailRate"), "total");
      const first = Array.isArray(total) ? total[0] : total;
      if (!first) continue;
      const minor = toMinor(at(first, "amount") as number | string);
      if (minor === null) continue;
      const currency = String(at(first, "currency") || "").toUpperCase();
      if (!currency) continue;
      const rateId = at(rate, "rateId");
      const maxOccupancy = at(rate, "maxOccupancy");
      out.push({
        offerId: String(offerId),
        rateId: rateId ? String(rateId) : null,
        roomName: String(at(rt, "name") || at(rate, "name") || ""),
        boardName: String(at(rate, "boardName") || at(rate, "boardType") || ""),
        maxOccupancy: Number.isFinite(Number(maxOccupancy))
          ? Number(maxOccupancy) : null,
        price: minor,
        currency,
        refundable: refundableFrom(rate),
        cancellation: cancellationFrom(rate),
      });
    }
  }
  /*
   * DEDUPLICATED, because LiteAPI returns a great many near-identical offers.
   *
   * A live sandbox search for one Nairobi hotel returned 200 offers, most of
   * them the same room at the same board at the same price with the same
   * cancellation terms — different supplier routings to the same thing. A guest
   * choosing between twelve identical "2 Single Beds, Breakfast Included,
   * USD 125.58" rows is not being given a choice, they are being given a wall.
   *
   * So offers that a guest could not tell apart are collapsed to the first one,
   * which keeps a real offerId to book with. Anything that differs in room,
   * board, price or refundability survives as its own row, because those are
   * the things somebody is actually choosing between.
   */
  const seen = new Set<string>();
  const distinct: BookableOffer[] = [];
  for (const o of out.sort((a, b) => a.price - b.price)) {
    const key = [o.roomName, o.boardName, o.price, o.currency, o.refundable].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(o);
  }
  return distinct;
}

/**
 * The cancellation deadlines and charges, as the supplier states them.
 *
 * Amounts stay in MINOR UNITS like every other figure in this service. A policy
 * the supplier did not send comes back as an empty array rather than as "free
 * cancellation", because the absence of a policy is not a generous one.
 */
/** One cancellation deadline and what it costs after it. */
export interface CancellationTerm {
  readonly until: string | null;
  readonly timezone: string | null;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly type?: string | null;
}

export function cancellationFrom(rate: unknown): CancellationTerm[] {
  const cp = at(rate, "cancellationPolicies");
  const infos = list(at(cp, "cancelPolicyInfos"));
  return infos.map((i: unknown) => ({
    /* Verbatim from the supplier; never reformatted into a local timezone,
       because the timezone is part of the deadline. */
    until: at(i, "cancelTime") ? String(at(i, "cancelTime")) : null,
    timezone: at(i, "timezone") ? String(at(i, "timezone")) : null,
    amount: toMinor(at(i, "amount") as number | string),
    currency: at(i, "currency") ? String(at(i, "currency")).toUpperCase() : null,
    type: at(i, "type") ? String(at(i, "type")) : null,
  })).filter((i) => i.until || i.amount !== null);
}

/**
 * LiteAPI states refundability as a tag: "RFN" or "NRFN".
 *
 * Anything else — absent, unrecognised, a new value — becomes null, meaning
 * "the supplier did not say". Defaulting to false would print
 * "Non-refundable" on the supplier's behalf about a booking whose terms nobody
 * here actually read.
 */
export function refundableFrom(rate: unknown): boolean | null {
  const tag = at(at(rate, "cancellationPolicies"), "refundableTag");
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
export function ratingOf(value: unknown): number | null {
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
/** How this adapter is configured. */
export interface LiteApiConfig {
  readonly apiKey?: string;
  /** Overridable base, for a proxy or a future host. */
  readonly baseUrl?: string;
  /**
   * An EXPLICIT environment, when one is given. The key's prefix stays
   * authoritative; a declared value that DISAGREES is refused rather than
   * resolved, because the two ways of being wrong are "test rates shown as
   * real" and "real money taken in a test flow".
   */
  readonly environment?: string;
  readonly currency?: string;
  /** ISO-2 guest nationality; LiteAPI prices against it. */
  readonly nationality?: string;
  /** LiteAPI's own Stripe publishable keys — public values, but theirs. */
  readonly stripePkTest?: string;
  readonly stripePkLive?: string;
  /** Injected for tests. */
  readonly fetchImpl?: FetchLike;
  /** A supplier that hangs must not hang the homepage. */
  readonly timeoutMs?: number;
}

/** What one call to LiteAPI is. */
interface CallOptions {
  readonly method?: string;
  readonly body?: Json | null;
  readonly params?: readonly (readonly [string, string])[] | null;
}

export function liteApi({
  apiKey,
  /** Overridable base, for a proxy or a future host. */
  baseUrl = DEFAULT_BASE,
  /**
   * An EXPLICIT environment, when one is given.
   *
   * The key's prefix already decides this and stays authoritative for safety —
   * but a declared LITEAPI_ENV that DISAGREES with the key is a
   * misconfiguration worth refusing rather than silently resolving, because the
   * two ways of being wrong are "test rates shown as real" and "real money
   * taken in a test flow".
   */
  environment = "",
  currency = "USD",
  nationality = "US",
  /*
   * LiteAPI's Stripe publishable keys, one per environment. Both are PUBLIC
   * values — a publishable key is designed to sit in a web page — but they are
   * still configuration rather than constants, because they are LiteAPI's to
   * rotate and they arrive from an account manager rather than a dashboard.
   */
  stripePkTest = "",
  stripePkLive = "",
  fetchImpl,
  timeoutMs = 7000,
}: LiteApiConfig = {}): AccommodationSupplier {
  if (!apiKey) {
    throw new SupplyUnavailable(
      "LiteAPI cannot be registered without LITEAPI_KEY. Nothing is connected, " +
      "and PALTAS will show only its own listings.");
  }
  /* Captured after the guard above: a destructured parameter is a mutable
     binding, so the check does not narrow it inside call(). */
  const key = apiKey;

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
  const keySaysSandbox = /^sand[_-]/i.test(String(apiKey).trim());

  /*
   * THE KEY DECIDES, AND A CONTRADICTING DECLARATION IS AN ERROR.
   *
   * LITEAPI_ENV exists so an operator can state their intent. When it agrees
   * with the key, nothing changes. When it disagrees, that is refused: one of
   * the two is wrong, and guessing which means either showing test rates as
   * real or running live money through a sandbox flow. Neither is a thing to
   * resolve quietly at boot.
   */
  const declared = String(environment || "").trim().toLowerCase();
  if (declared && declared !== "sandbox" && declared !== "production") {
    throw new SupplyUnavailable(
      `LITEAPI_ENV must be "sandbox" or "production", not "${declared}".`);
  }
  if (declared) {
    const declaredSandbox = declared === "sandbox";
    if (declaredSandbox !== keySaysSandbox) {
      throw new SupplyUnavailable(
        `LITEAPI_ENV says "${declared}" but the API key is a ` +
        `${keySaysSandbox ? "sandbox (sand_)" : "production (prod_)"} key. ` +
        `One of the two is wrong, and PALTAS will not guess which: the wrong ` +
        `answer either shows test rates as real or puts live money through a ` +
        `test flow.`);
    }
  }
  const sandbox = keySaysSandbox;

  async function call(
    path: string, { method = "GET", body = null, params = null }: CallOptions = {},
  ): Promise<unknown> {
    const url = new URL(baseUrl + path);
    if (params) for (const [k, v] of params) url.searchParams.append(k, String(v));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: FetchReply;
    try {
      res = await http(url.toString(), {
        method,
        signal: controller.signal,
        headers: {
          "X-API-Key": key,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      clearTimeout(timer);
      throw new SupplyUnavailable(at(e, "name") === "AbortError"
        ? `LiteAPI did not answer within ${timeoutMs}ms.`
        : `LiteAPI could not be reached: ${redact(messageOf(e))}`);
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

    /*
     * WHAT A GUEST READS, WHICH IS NOT WHO PALTAS BUYS FROM.
     *
     * LiteAPI is a wholesaler. It is not a consumer brand, a guest has no
     * relationship with it and no use for its name — what naming it does is
     * hand the guest the company to go and book with instead of PALTAS.
     * Booking.com and Expedia are the opposite case: consumer brands whose
     * licences require the name on the inventory, and those adapters
     * deliberately set no publicLabel so their own brand is what shows.
     *
     * This changes the NAME only. The attribution line still says these are
     * not PALTAS listings, because that is about who the guest's contract is
     * with, and it is true whoever supplies the room.
     */
    publicLabel: sandbox ? "our hotel partners (sandbox)" : "our hotel partners",
    /* The machine token a public row carries, in place of "liteapi". */
    publicName: "partner",
    sandbox,

    describe() {
      return {
        name: "liteapi",
        label: sandbox ? "LiteAPI (sandbox)" : "LiteAPI",
        publicLabel: sandbox ? "our hotel partners (sandbox)" : "our hotel partners",
        publicName: "partner",
        connected: true,
        sandbox,
        capabilities: ["search", "rates", "content", "prebook", "book", "cancel"],
        /* Safe to show: a base URL is not a credential, and an operator
           debugging a proxy needs to see which host is being called. */
        baseUrl,
        why: sandbox
          ? "LiteAPI is connected with a SANDBOX key (it begins \"sand_\"), so " +
            "sandbox mode is forced and cannot be switched off. The hotels are " +
            "real but the rates are test data: every card is marked unbookable."
          : "LiteAPI is connected.",
        disclosure: sandbox
          ? "These rates come from LiteAPI's sandbox environment. The hotel is " +
            "real but the price is test data and the room cannot be booked."
          : "",
        /*
         * Whether a guest could actually pay. Said out loud because the
         * difference between "bookable" and "browsable" is the difference
         * between a checkout and a dead end, and a client needs to know which
         * it is BEFORE it offers somebody a button.
         */
        canTakePayment: Boolean(sandbox ? stripePkTest : stripePkLive),
        paymentEnvironment: sandbox ? "sandbox" : "live",
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

      const rows = list(at(rated, "data"));
      const priced: (CheapestRate & { id: string })[] = [];
      for (const h of rows) {
        const hotelIdOf = at(h, "hotelId");
        if (!hotelIdOf) continue;
        const best = cheapestRate(h);
        if (!best) continue;
        priced.push({ id: String(hotelIdOf), ...best });
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

      const byId = new Map<string, unknown>();
      for (const d of list(at(content, "data"))) {
        const id = at(d, "id");
        if (id !== undefined) byId.set(String(id), d);
      }

      const offers: RawOffer[] = [];
      for (const p of priced) {
        const d = byId.get(p.id);
        const name = at(d, "name");
        /* No name means no card. */
        if (!d || !name) continue;

        offers.push({
          supplierRef: p.id,
          title: String(name),
          city: String(at(d, "city") || city || ""),
          country: String(at(d, "country") || cc).toUpperCase(),
          place: String(at(d, "address") || ""),
          price: p.price,
          currency: p.currency,
          nights,
          refundable: p.refundable,
          /* The guest review score, and only if it is on the 0–10 scale the
             card renders. */
          rating: ratingOf(at(d, "rating")),
          ratingCount: Number.isFinite(Number(at(d, "reviewCount")))
            ? Math.round(Number(at(d, "reviewCount"))) : null,
          /* Served from LiteAPI's own host, never re-hosted. */
          image: at(d, "main_photo") ? String(at(d, "main_photo"))
               : (at(d, "thumbnail") ? String(at(d, "thumbnail")) : null),
          deepLink: null,
          /* The hotel's own star rating, which is a different thing from a guest
             score. Carried because it is real; the card does not render it yet. */
          stars: Number.isFinite(Number(at(d, "stars"))) ? Number(at(d, "stars")) : null,
          /*
           * What a guest would prebook to take this price. Carried on the card's
           * offer so selecting a room does not need the search run again — and
           * so a price shown is provably a price that can be acted on.
           */
          offerId: p.offerId,
          roomName: p.roomName,
          boardName: p.boardName,
        });
        if (offers.length >= take) break;
      }

      return { offers };
    },

    /* ================================================================ *
     * THE BOOKING LIFECYCLE.
     *
     * search -> rooms -> prebook -> book -> retrieve -> cancel
     *
     * Every step returns what the supplier said and nothing else. Where a step
     * can fail in a way that matters commercially — a price that moved between
     * prebook and book, a cancellation that charges anyway — that is surfaced
     * rather than smoothed over, because the guest is the one who pays for it.
     * ================================================================ */

    /**
     * Every bookable room and rate at ONE hotel, for a stay.
     *
     * This is the step between "here is a hotel at a price" and "book it". The
     * card's price is the cheapest offer; a guest choosing a room needs to see
     * the others, what board they include and whether they can be cancelled.
     */
    async rooms({ hotelId = "", checkIn = "", checkOut = "", guests = 2, currency: want = "" } = {}) {
      if (!hotelId) throw new SupplyUnavailable("A hotel id is needed to list its rooms.");
      const a = Date.parse(`${checkIn}T00:00:00Z`);
      const b = Date.parse(`${checkOut}T00:00:00Z`);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
        throw new SupplyUnavailable("Room rates need a check-in and a check-out date.");
      }

      const rated = await call("/hotels/rates", {
        method: "POST",
        body: {
          hotelIds: [String(hotelId)],
          checkin: checkIn,
          checkout: checkOut,
          occupancies: [{ adults: Math.min(10, Math.max(1, Number(guests) || 2)), children: [] }],
          currency: String(want || currency || "USD").toUpperCase(),
          guestNationality: String(nationality || "US").toUpperCase(),
          /* Every rate this time, not one — the whole point is the choice. */
          limit: 1,
        },
      });

      const hotel = list(at(rated, "data"))
        .find((h: unknown) => String(at(h, "hotelId")) === String(hotelId));
      if (!hotel) return { hotelId: String(hotelId), nights: Math.round((b - a) / 86_400_000), offers: [] };

      return {
        hotelId: String(hotelId),
        nights: Math.round((b - a) / 86_400_000),
        offers: offersFor(hotel),
      };
    },

    /**
     * Hold an offer and get the real, final price.
     *
     * The step that exists because a wholesale rate can move between being
     * shown and being taken. LiteAPI reports that as `priceDifferencePercent`,
     * and it is returned rather than ignored: a guest who saw one number and is
     * charged another has been misled by this service, not by the hotel.
     */
    /**
     * ONE HOTEL'S CONTENT — its name, city and classification.
     *
     * Added for the price comparison, and added HERE rather than trusting the
     * browser to say which property it wants priced. A comparison costs 30
     * credits at StayingAPI, so a caller that could name any property in the
     * world would be an open door onto somebody else's bill. The only thing
     * PALTAS accepts is a hotel id it already sells; the name it asks Google
     * about comes from the supplier, not from the request.
     *
     * `countryCode` is not optional — /data/hotels demands it.
     */
    async hotel({ hotelId = "", countryCode = "" }: HotelQuery = {}) {
      if (!hotelId) throw new SupplyUnavailable("A hotel id is needed.");
      const cc = String(countryCode || "").toUpperCase();
      if (!/^[A-Z]{2}$/.test(cc)) {
        throw new SupplyUnavailable("A two-letter country code is needed to look a hotel up.");
      }
      const r = await call("/data/hotels", {
        params: [["countryCode", cc], ["hotelIds", String(hotelId)], ["limit", "1"]],
      });
      const d = list(at(r, "data"))
        .find((x: unknown) => String(at(x, "id")) === String(hotelId));
      if (!d) return null;
      return {
        hotelId: String(at(d, "id")),
        name: at(d, "name") ? String(at(d, "name")) : null,
        city: at(d, "city") ? String(at(d, "city")) : null,
        country: at(d, "country") ? String(at(d, "country")) : cc,
        stars: Number.isFinite(Number(at(d, "stars"))) && Number(at(d, "stars")) > 0
          ? Number(at(d, "stars")) : null,
      };
    },

    async prebook({ offerId = "", usePaymentSdk = false }: PrebookQuery = {}) {
      if (!offerId) throw new SupplyUnavailable("An offer id is needed to hold a rate.");

      /*
       * TWO WAYS TO PAY, AND ONLY ONE OF THEM IS SAFE ON A LIVE KEY.
       *
       *   usePaymentSdk: false -> settled later with ACC_CREDIT_CARD. In
       *     PRODUCTION that charges PALTAS'S OWN CARD, not the guest's —
       *     "the partner bears full financial responsibility for the
       *     transaction". Every booking any visitor made would be billed to
       *     PALTAS with nothing collected from the traveller. `book()` refuses
       *     this combination outright.
       *
       *   usePaymentSdk: true -> LiteAPI returns a payment session and the
       *     GUEST pays with their own card in LiteAPI's hosted form. PALTAS
       *     never sees the card and never fronts the money. This is the only
       *     way a live booking may be completed here.
       */
      const r = await call("/rates/prebook", {
        method: "POST",
        body: { offerId: String(offerId), usePaymentSdk: Boolean(usePaymentSdk) },
      });
      const d = at(r, "data") ?? {};
      const prebookId = at(d, "prebookId");
      if (!prebookId) {
        throw new SupplyUnavailable("LiteAPI held no rate — it returned no prebookId.");
      }

      const total = at(d, "price") !== undefined
        ? toMinor(at(d, "price") as number | string) : null;
      return {
        prebookId: String(prebookId),
        offerId: at(d, "offerId") ? String(at(d, "offerId")) : String(offerId),
        hotelId: at(d, "hotelId") ? String(at(d, "hotelId")) : null,
        /* Dates as the supplier wrote them — never reformatted, because a
           check-in is a local date and a timezone conversion moves it. */
        checkIn: at(d, "checkin") == null ? null : String(at(d, "checkin")),
        checkOut: at(d, "checkout") == null ? null : String(at(d, "checkout")),
        price: total,
        currency: at(d, "currency") ? String(at(d, "currency")).toUpperCase() : null,
        /*
         * Anything other than 0 means the price moved. Surfaced verbatim so a
         * caller can stop and re-confirm rather than book at a number the guest
         * never agreed to.
         */
        priceDifferencePercent: Number.isFinite(Number(at(d, "priceDifferencePercent")))
          ? Number(at(d, "priceDifferencePercent")) : 0,
        cancellationChanged: Boolean(at(d, "cancellationChanged")),
        boardChanged: Boolean(at(d, "boardChanged")),
        sandbox,

        /*
         * THE PAYMENT SESSION, returned ONLY when the SDK path was asked for.
         *
         * `secretKey` is a client-side payment session key in the same sense as
         * a Stripe client secret: LiteAPI's hosted form needs it in the
         * browser, and it is scoped to this one transaction. So it has to be
         * returned — withholding it means the guest cannot pay.
         *
         * It is still not returned on the other path. A value with no use
         * cannot leak, and on the ACC_CREDIT_CARD route nothing in the browser
         * has any business holding a payment session.
         */
        ...(usePaymentSdk ? {
          payment: {
            /*
             * The Stripe PaymentIntent client secret, on LiteAPI's Stripe
             * platform. It belongs in the browser — that is what a client secret
             * is for — and it is scoped to this one payment.
             */
            clientSecret: at(d, "secretKey") ? String(at(d, "secretKey")) : null,
            transactionId: at(d, "transactionId") ? String(at(d, "transactionId")) : null,
            /*
             * LiteAPI's OWN Stripe publishable key, for the environment this key
             * belongs to.
             *
             * Chosen from `sandbox`, which is derived from the API key's prefix,
             * so the two environments cannot cross: a sand_ key can never hand
             * out a pk_live_ and a prod_ key can never hand out a pk_test_. That
             * is the whole of the sandbox/production separation on the payment
             * side, and it is not a flag anybody can set wrongly.
             *
             * Null when this installation has not been given the key. LiteAPI
             * does not publish it in their dashboard — it comes from an account
             * manager — so its absence is normal and has to be survivable.
             */
            publishableKey: sandbox ? (stripePkTest || null) : (stripePkLive || null),
            stripeJsUrl: STRIPE_JS_URL,
            environment: sandbox ? "sandbox" : "live",
          },
        } : {}),
      };
    },

    /**
     * Take the held rate.
     *
     * In sandbox this settles with ACC_CREDIT_CARD, which LiteAPI documents as
     * simulating a booking without a charge. That is the ONLY payment method
     * this adapter will send, and it refuses outright on a production key —
     * because a real booking needs a real payment provider, and PALTAS has none
     * connected. Booking for free against a live key is somebody else's money.
     */
    async book({ prebookId = "", holder = {}, guests = [], clientReference = "",
                 transactionId = "" }: BookRequest = {}) {
      if (!prebookId) throw new SupplyUnavailable("A prebook id is needed to book.");

      /*
       * WHO PAID decides whether this is allowed to proceed.
       *
       * With a transactionId the guest has already paid through LiteAPI's hosted
       * form, so settling with TRANSACTION_ID simply completes what they bought.
       * That is safe on a live key.
       *
       * Without one the only method available is ACC_CREDIT_CARD, which in
       * production charges PALTAS's own card. In sandbox it charges nobody and
       * is the documented way to simulate a booking. So: no transaction and no
       * sandbox means refuse, and the refusal says which of the two is missing.
       */
      const paid = Boolean(transactionId);
      if (!paid && !sandbox) {
        throw new SupplyUnavailable(
          "PALTAS will not complete a live LiteAPI booking that nobody has paid " +
          "for. Without a transactionId the only method available is " +
          "ACC_CREDIT_CARD, which in production charges PALTAS's own card rather " +
          "than the guest's. Hold the rate with usePaymentSdk, let the guest pay, " +
          "and pass the transactionId back.");
      }
      for (const f of ["firstName", "lastName", "email"] as const) {
        if (!holder[f]) throw new SupplyUnavailable(`The booking holder needs a ${f}.`);
      }

      const r = await call("/rates/book", {
        method: "POST",
        body: {
          prebookId: String(prebookId),
          /*
           * ALWAYS a client reference, and always a unique one.
           *
           * LiteAPI enforces uniqueness: a repeat reference is refused with
           * 4005 "duplicate booking attempt with existing client reference".
           * That is good behaviour — it is what stops a retried request
           * becoming two bookings — but it means the reference cannot be a
           * fixed string, and a caller that forgets to vary it gets a failure
           * that reads like a broken integration.
           *
           * So one is generated when none is given. The caller's own reference
           * is preserved when supplied, because it is how PALTAS ties a
           * supplier booking back to its own record.
           */
          clientReference: String(clientReference || newClientReference()),
          holder: {
            firstName: String(holder.firstName),
            lastName: String(holder.lastName),
            email: String(holder.email),
            ...(holder.phone ? { phone: String(holder.phone) } : {}),
          },
          guests: (guests.length ? guests : [{
            occupancyNumber: 1,
            firstName: holder.firstName, lastName: holder.lastName, email: holder.email,
          } satisfies BookingGuest]).map((g: BookingGuest, i: number) => ({
            occupancyNumber: Number(g.occupancyNumber) || i + 1,
            firstName: String(g.firstName || holder.firstName),
            lastName: String(g.lastName || holder.lastName),
            ...(g.email ? { email: String(g.email) } : {}),
            ...(g.phone ? { phone: String(g.phone) } : {}),
            ...(g.remarks ? { remarks: String(g.remarks) } : {}),
          })),
          /*
           * TRANSACTION_ID when the guest paid; ACC_CREDIT_CARD only ever in
           * sandbox, where it charges nobody.
           */
          payment: paid
            ? { method: "TRANSACTION_ID", transactionId: String(transactionId) }
            : { method: "ACC_CREDIT_CARD" },
        },
      });
      return wireBooking(at(r, "data"), sandbox);
    },

    /** What the supplier currently says about a booking. */
    async booking({ bookingId = "" }: BookingQuery = {}) {
      if (!bookingId) throw new SupplyUnavailable("A booking id is needed.");
      const r = await call(`/bookings/${encodeURIComponent(String(bookingId))}`);
      return wireBooking(at(r, "data"), sandbox);
    },

    /**
     * Cancel, and report honestly what it cost.
     *
     * A non-refundable booking still cancels — LiteAPI returns
     * CANCELLED_WITH_CHARGES with a fee and a zero refund. That distinction is
     * the whole value of this call, so it is returned rather than flattened into
     * "cancelled".
     */
    async cancel({ bookingId = "" }: BookingQuery = {}) {
      if (!bookingId) throw new SupplyUnavailable("A booking id is needed to cancel.");
      const r = await call(`/bookings/${encodeURIComponent(String(bookingId))}`, { method: "PUT" });
      const d = at(r, "data") ?? {};
      const fee = at(d, "cancellation_fee");
      const refund = at(d, "refund_amount");
      return {
        bookingId: at(d, "bookingId") ? String(at(d, "bookingId")) : String(bookingId),
        status: at(d, "status") ? String(at(d, "status")) : null,
        /* Charged anyway, and said so. */
        charged: at(d, "status") === "CANCELLED_WITH_CHARGES",
        cancellationFee: fee !== undefined ? toMinor(fee as number | string) : null,
        refund: refund !== undefined ? toMinor(refund as number | string) : null,
        currency: at(d, "currency") ? String(at(d, "currency")).toUpperCase() : null,
        sandbox,
      };
    },
  };
}

/**
 * A reference unique enough that a retry cannot collide with the attempt before
 * it. Time plus randomness, prefixed so it is recognisable in LiteAPI's console.
 */
export function newClientReference() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `PALTAS-${Date.now().toString(36)}-${rand}`;
}

/**
 * One booking, in this service's shape.
 *
 * Money in minor units like everywhere else. `sandbox` is stamped on the record
 * because a sandbox booking is not a booking — nobody is arriving — and anything
 * that stores or displays one has to be able to tell.
 */
export function wireBooking(d: unknown, sandbox: boolean) {
  const bookingId = at(d, "bookingId");
  if (!d || !bookingId) {
    throw new SupplyUnavailable("LiteAPI returned no booking.");
  }
  const hotel = at(d, "hotel");
  const policies = at(d, "cancellationPolicies");
  const tag = at(policies, "refundableTag");
  return {
    bookingId: String(bookingId),
    clientReference: at(d, "clientReference") ? String(at(d, "clientReference")) : null,
    status: at(d, "status") ? String(at(d, "status")) : null,
    /* What the guest shows at the desk. */
    hotelConfirmationCode: at(d, "hotelConfirmationCode")
      ? String(at(d, "hotelConfirmationCode")) : null,
    hotelId: at(hotel, "hotelId") ? String(at(hotel, "hotelId"))
           : (at(d, "hotelId") ? String(at(d, "hotelId")) : null),
    hotelName: at(hotel, "name") ? String(at(hotel, "name")) : null,
    checkIn: at(d, "checkin") == null ? null : String(at(d, "checkin")),
    checkOut: at(d, "checkout") == null ? null : String(at(d, "checkout")),
    price: at(d, "price") !== undefined ? toMinor(at(d, "price") as number | string) : null,
    currency: at(d, "currency") ? String(at(d, "currency")).toUpperCase() : null,
    refundable: policies
      ? (tag === "RFN" ? true : tag === "NRFN" ? false : null)
      : null,
    cancellation: list(at(policies, "cancelPolicyInfos")).map((i: unknown) => ({
      until: at(i, "cancelTime") ? String(at(i, "cancelTime")) : null,
      timezone: at(i, "timezone") ? String(at(i, "timezone")) : null,
      amount: toMinor(at(i, "amount") as number | string),
      currency: at(i, "currency") ? String(at(i, "currency")).toUpperCase() : null,
    })),
    createdAt: at(d, "createdAt") == null ? null : String(at(d, "createdAt")),
    supplierBookingId: at(d, "supplierBookingId")
      ? String(at(d, "supplierBookingId")) : null,
    source: "liteapi",
    sandbox: Boolean(sandbox),
  };
}

/** Scrub the key from anything about to be thrown or logged. */
export function redact(s: unknown): string {
  return String(s || "")
    .replace(/\b(?:sand|prod)_[A-Za-z0-9-]+/gi, "[redacted-key]")
    .replace(/(X-API-Key"?\s*[:=]\s*"?)[^",\s}]+/gi, "$1[redacted]")
    .replace(/("?(?:api[_-]?key|apiKey)"?\s*[:=]\s*"?)[^",\s}]+/gi, "$1[redacted]");
}

/** Build from the environment, or null when this installation has no key. */
export function fromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AccommodationSupplier | null {
  if (!env.LITEAPI_KEY) return null;
  return liteApi({
    apiKey: env.LITEAPI_KEY,
    baseUrl: env.LITEAPI_BASE_URL || DEFAULT_BASE,
    environment: env.LITEAPI_ENV || "",
    currency: env.LITEAPI_CURRENCY || "USD",
    nationality: env.LITEAPI_NATIONALITY || "US",
    /* Both kept apart by name so neither can be used for the wrong
       environment, and both optional so a missing key degrades to
       browse-only rather than breaking the marketplace. */
    stripePkTest: env.LITEAPI_STRIPE_PK_TEST || "",
    stripePkLive: env.LITEAPI_STRIPE_PK_LIVE || "",
  });
}
