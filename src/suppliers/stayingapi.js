/**
 * StayingAPI — accommodation DATA, and deliberately not accommodation SUPPLY.
 *
 * ================================================================
 * THE ONE THING TO KNOW BEFORE USING THIS FILE
 * ================================================================
 *
 * StayingAPI CANNOT TAKE A BOOKING. Its whole surface, read from
 * https://api.stayingapi.com/openapi.json, is eight read endpoints:
 *
 *     GET /account                    plan, credits, rate limit
 *     GET /search                     properties across platforms
 *     GET /price                      live price for a listing + dates
 *     GET /availability               nightly availability
 *     GET /listing/{platform}/{id}    one normalised listing
 *     GET /reviews                    a listing's reviews
 *     GET /price-compare              the same stay across OTAs
 *     GET /jobs/{jobId}               poll an async scrape
 *
 * There is no prebook, no book, no cancel, no payment and no offer id — not
 * renamed, not undocumented: absent. The word "book" appears in that spec only
 * as the name of the platform Booking.com, and the single `bookable` field is a
 * flag saying whether a listing can be booked ON ITS OWN SITE.
 *
 * What it does is read Airbnb, Booking.com, Vrbo, Expedia, Hotels.com, Google
 * and TripAdvisor, and tell you what is listed and what it costs.
 *
 * ================================================================
 * WHY THIS IS NOT REGISTERED WITH src/domain/supply.js
 * ================================================================
 *
 * That seam feeds the marketplace, and everything reaching the marketplace is
 * offered to a visitor as a room they can take. Registering a source that
 * cannot complete a booking would put cards on the homepage that lead to a
 * "View rooms" button with nothing behind it — the precise failure PALTAS has
 * refused at every turn, and worse here because the price shown would be
 * somebody else's and could move between the page and the click.
 *
 * So this module stands alone. It is wired by whatever decides to use it, for
 * one of the two things it is honestly good for:
 *
 *   COMPARISON — what a hotel PALTAS already sells costs elsewhere. Adds a fact
 *     to a real bookable room and invents nothing.
 *   METASEARCH — listings that link out to the OTA holding them, each one
 *     labelled as somebody else's and never wearing a PALTAS booking button.
 *
 * Both are legitimate. They are different products, so neither is chosen here.
 *
 * ================================================================
 * CREDITS ARE METERED PER RESULT
 * ================================================================
 *
 * /search bills RATE × results PER PLATFORM (airbnb 2x, booking/vrbo 1x,
 * google 15x, minimum 5); /price-compare is 30 flat via Google. PALTAS's
 * homepage loads inventory on EVERY visit, so calling search from there would
 * spend credits on people who are only scrolling past. Nothing in this file
 * calls anything on its own, and `limit` defaults low on purpose.
 */

import { SupplyUnavailable, toMinor } from "../domain/supply.js";

export const DEFAULT_BASE = "https://api.stayingapi.com/v1";

/** Platforms the API will read. From the spec's enum, not from memory. */
export const PLATFORMS = ["airbnb", "booking", "vrbo", "expedia", "hotels", "google", "tripadvisor"];

/**
 * Sandbox or live, decided BY THE KEY and by nothing else.
 *
 * `stay_test_` is the deterministic sandbox and bills nothing; `stay_live_`
 * spends real credits against a real account. Letting a config flag override
 * that is how a test run bills a live plan, so there is no flag: the key is the
 * answer, the same rule LiteAPI's `sand_` prefix already follows here.
 */
export function environmentOf(apiKey) {
  const k = String(apiKey || "");
  if (k.startsWith("stay_test_")) return { sandbox: true, known: true };
  if (k.startsWith("stay_live_")) return { sandbox: false, known: true };
  return { sandbox: false, known: false };
}

/** Money, in the integer minor units the rest of PALTAS speaks. */
function moneyFrom(amount, currency) {
  if (amount == null || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return null;
  const cur = String(currency || "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return null;
  /* toMinor() takes the amount alone — it multiplies by 100 and knows nothing
     about the currency. Passing `cur` here would suggest it picks an exponent
     per currency, which it does not, and the next person to read it would
     assume JPY and KWD were handled. They are not, platform-wide. */
  return { amountMinor: toMinor(n), currency: cur };
}

/**
 * A rating, only when it is one.
 *
 * Platforms score on different scales — Airbnb out of 5, Booking.com out of 10
 * — and a 4.8 shown beside a 9.2 as if they were the same number is a lie told
 * with true figures. Both are carried with the scale they came on, and anything
 * outside its own range is dropped rather than clamped into plausibility.
 */
function ratingFrom(raw, platform) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const outOf = platform === "airbnb" || platform === "vrbo" ? 5 : 10;
  if (n > outOf) return null;
  return { score: Math.round(n * 10) / 10, outOf };
}

export function stayingApi({
  apiKey,
  baseUrl = DEFAULT_BASE,
  currency = "USD",
  timeoutMs = 20000,
  /* A live scrape answers 202 and a job id. These bound the wait so a slow
     platform cannot hold a request open indefinitely. */
  pollMs = 900,
  maxPolls = 12,
  fetchImpl,
} = {}) {
  if (!apiKey) throw new SupplyUnavailable("StayingAPI needs an API key.");

  const env = environmentOf(apiKey);
  if (!env.known) {
    throw new SupplyUnavailable(
      "A StayingAPI key must begin with stay_test_ or stay_live_. PALTAS will " +
      "not guess which environment an unrecognised key belongs to, because " +
      "guessing wrong either bills a live account or silently returns fixtures.");
  }
  const sandbox = env.sandbox;
  const base = String(baseUrl).replace(/\/+$/, "");

  const http = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!http) throw new SupplyUnavailable("No fetch implementation is available for StayingAPI.");

  async function call(path, params = {}, depth = 0) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const stop = new AbortController();
    const t = setTimeout(() => stop.abort(), timeoutMs);
    let res;
    try {
      res = await http(url.toString(), {
        method: "GET",
        signal: stop.signal,
        headers: {
          /* The key travels in the header and appears in no URL, so it cannot
             end up in an access log, a referrer or an error message. */
          Authorization: "Bearer " + apiKey,
          Accept: "application/json",
        },
      });
    } catch (e) {
      throw new SupplyUnavailable(e && e.name === "AbortError"
        ? "StayingAPI did not answer in time."
        : "StayingAPI could not be reached.");
    } finally {
      clearTimeout(t);
    }

    let body;
    try { body = await res.json(); }
    catch { throw new SupplyUnavailable("StayingAPI returned a body that is not JSON."); }

    if (res.status === 401 || res.status === 403) {
      throw new SupplyUnavailable("StayingAPI refused the key. It may have been rotated or revoked.");
    }
    if (res.status === 429) {
      throw new SupplyUnavailable("StayingAPI is rate limiting this account.");
    }
    if (res.status === 402) {
      throw new SupplyUnavailable("This StayingAPI account is out of credits.");
    }

    /*
     * 202 means a live scrape is running. Poll the job — which the spec prices
     * at zero credits — rather than re-issuing the search, which would be
     * billed again every time.
     */
    const jobId = body && body.data && body.data.jobId;
    if (res.status === 202 && jobId) {
      if (depth >= maxPolls) {
        throw new SupplyUnavailable("StayingAPI is still working; PALTAS stopped waiting.");
      }
      await new Promise((r) => setTimeout(r, pollMs));
      return call(`/jobs/${encodeURIComponent(jobId)}`, {}, depth + 1);
    }
    /* A poll that is still pending comes back 200 with no result yet. */
    if (body && body.data && body.data.status === "pending") {
      if (depth >= maxPolls) {
        throw new SupplyUnavailable("StayingAPI is still working; PALTAS stopped waiting.");
      }
      await new Promise((r) => setTimeout(r, pollMs));
      return call(path, params, depth + 1);
    }

    if (!res.ok) {
      const why = (body && (body.message || body.error)) || `StayingAPI answered ${res.status}.`;
      /* Whatever it said, it is not repeated verbatim into a browser — an
         upstream error can carry an echo of the request, key included. */
      throw new SupplyUnavailable(
        typeof why === "string" && !/stay_(test|live)_/.test(why)
          ? why : `StayingAPI answered ${res.status}.`);
    }
    return body;
  }

  /** One search result, in PALTAS's shape, flagged for what it is. */
  function normalise(row, platform) {
    if (!row || typeof row !== "object") return null;
    const p = String(row.platform || platform || "").toLowerCase();
    const id = row.id || row.listingId || row.slug;
    if (!id) return null;

    const price = moneyFrom(
      row.totalPrice ?? row.total ?? row.price ?? (row.pricing && row.pricing.total),
      row.currency || (row.pricing && row.pricing.currency) || currency);

    return {
      id: `${p}:${id}`,
      title: String(row.title || row.name || "").trim() || null,
      city: (row.city || (row.address && row.address.city) || "") || null,
      country: (row.country || (row.address && row.address.country) || "") || null,
      image: row.image || (Array.isArray(row.images) ? row.images[0] : "") || null,
      price,
      rating: ratingFrom(row.rating ?? (row.reviews && row.reviews.rating), p),
      reviewCount: Number.isFinite(Number(row.reviewCount)) ? Number(row.reviewCount) : null,
      /*
       * THE THREE FIELDS THAT KEEP THIS HONEST.
       *
       * `bookable:false` is not a placeholder to fill in later — it is the
       * truth about every row this adapter will ever return. `via` names whose
       * listing it is, and `url` is where somebody actually completes it. A
       * renderer that ignores all three and draws a PALTAS booking button is
       * doing so against an explicit statement, not an omission.
       */
      bookable: false,
      via: p || null,
      url: row.url || row.link || null,
      source: "stayingapi",
      paltasOwned: false,
    };
  }

  return {
    name: "stayingapi",
    label: "StayingAPI",
    sandbox,

    /** Safe for a browser: no key, and no way to derive one. */
    describe() {
      return {
        name: "stayingapi",
        label: "StayingAPI",
        connected: true,
        sandbox,
        /*
         * Booking is absent from this list because it is absent from the API.
         * Anything checking capabilities before offering a room will therefore
         * decline on its own, without having to know what StayingAPI is.
         */
        capabilities: ["search", "price", "availability", "content", "reviews", "compare"],
        platforms: PLATFORMS,
        why: sandbox
          ? "StayingAPI is connected in its deterministic sandbox. Results are fixtures and cost no credits."
          : "StayingAPI is connected. It reads listings and prices; it cannot take a booking.",
      };
    },

    async account() {
      const r = await call("/account");
      const d = (r && r.data) || r || {};
      /* Deliberately narrow. A plan object may carry an account identifier and
         there is no reason for one to travel further than this. */
      return {
        plan: d.plan || d.tier || null,
        credits: Number.isFinite(Number(d.credits)) ? Number(d.credits) : null,
        sandbox,
      };
    },

    /**
     * Search. `limit` is per platform, so three platforms at ten is thirty
     * results and thirty results' worth of credits — hence a low default and a
     * hard ceiling of the API's own 40.
     */
    async search({ location, checkIn, checkOut, adults = 2, children = 0, rooms = 1,
                   platforms = [], limit = 10, sort = "recommended", cursor = "" } = {}) {
      if (!location) throw new SupplyUnavailable("StayingAPI needs somewhere to search.");
      const asked = (platforms || []).filter((p) => PLATFORMS.includes(p));
      const r = await call("/search", {
        location, checkIn, checkOut, adults, children, rooms,
        currency,
        platforms: asked.length ? asked.join(",") : undefined,
        limit: Math.max(1, Math.min(40, Number(limit) || 10)),
        sort, cursor,
      });
      const d = (r && r.data) || {};
      const rows = d.results || d.listings || (Array.isArray(d) ? d : []);
      return {
        results: (Array.isArray(rows) ? rows : []).map((x) => normalise(x)).filter(Boolean),
        cursor: d.cursor || d.nextCursor || "",
        creditsUsed: Number.isFinite(Number(r && r.creditsUsed)) ? Number(r.creditsUsed) : null,
      };
    },

    async price({ platform, id, checkIn, checkOut, adults = 2 } = {}) {
      if (!platform || !id) throw new SupplyUnavailable("StayingAPI needs a platform and a listing id.");
      const r = await call("/price", { platform, id, checkIn, checkOut, adults, currency });
      const d = (r && r.data) || {};
      return {
        price: moneyFrom(d.total ?? d.price, d.currency || currency),
        /* What each platform includes differs — Airbnb reports cleaning and
           service, Booking.com reports taxes only — so the breakdown is passed
           through rather than summed into a number that means nothing. */
        breakdown: d.breakdown || null,
        bookable: d.bookable === true,
        via: platform,
      };
    },

    async compare({ location, checkIn, checkOut, listings = [], adults = 2 } = {}) {
      const r = await call("/price-compare", {
        location, checkIn, checkOut, adults, currency,
        listings: listings.length ? listings.join(",") : undefined,
      });
      const d = (r && r.data) || {};
      const offers = Array.isArray(d.offers || d.results) ? (d.offers || d.results) : [];
      return {
        offers: offers.map((o) => ({
          via: String(o.platform || "").toLowerCase() || null,
          price: moneyFrom(o.total ?? o.price, o.currency || currency),
          url: o.url || null,
          bookable: false,
        })).filter((o) => o.price),
      };
    },

    /*
     * The refusal, written down rather than left to be discovered.
     *
     * Anything that walks a supplier's interface and calls book() gets a
     * sentence explaining the situation instead of `undefined is not a
     * function` three frames deep at the moment somebody is paying.
     */
    async book() {
      throw new SupplyUnavailable(
        "StayingAPI cannot take a booking — it has no booking endpoint at all. " +
        "It reads listings and prices from other platforms. A stay found " +
        "through it is completed on the platform that holds it, or through a " +
        "supplier that can actually sell it.");
    },
  };
}

/** Built only when a key is present, so a missing one degrades to nothing. */
export function fromEnv(env = process.env) {
  if (!env.STAYINGAPI_KEY) return null;
  return stayingApi({
    apiKey: env.STAYINGAPI_KEY,
    baseUrl: env.STAYINGAPI_BASE_URL || DEFAULT_BASE,
    currency: env.STAYINGAPI_CURRENCY || "USD",
  });
}
