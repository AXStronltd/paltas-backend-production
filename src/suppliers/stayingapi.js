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
  apiKey = String(apiKey || "").trim();
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

  /*
   * THE ASYNC JOB PROTOCOL, WHICH IS WHERE THE PAYLOAD ACTUALLY LIVES.
   *
   * A first version of this read `body.data` for everything and returned
   * nothing on every slow query — silently, with no error, looking exactly like
   * "no other seller published a price". Three things in the spec make that
   * wrong, and all three fail the same quiet way:
   *
   *   A COMPLETED JOB PUTS THE PAYLOAD AT data.result, not at data. Reading
   *   data gives you {jobId, status, result} and no offers at all.
   *
   *   IN PROGRESS IS `pending` OR `running`. Checking only for pending treats a
   *   running job as finished and returns its placeholder.
   *
   *   A FAILED JOB IS HTTP 200. The spec says so in capitals: detect it via
   *   data.status === "failed", NOT via the status code. Treated as success it
   *   is, again, an empty answer.
   *
   * So the unwrapping is done here, once, and every caller below receives the
   * same shape whether the work was synchronous or took four polls.
   */
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function urlFor(path, params = {}) {
    const url = new URL(/^https?:/.test(path) ? path : base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** One request. Returns the parsed body plus what the headers asked for. */
  async function once(url) {
    const stop = new AbortController();
    const t = setTimeout(() => stop.abort(), timeoutMs);
    let res;
    try {
      res = await http(url, {
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
    if (res.status === 429) throw new SupplyUnavailable("StayingAPI is rate limiting this account.");
    if (res.status === 402) throw new SupplyUnavailable("This StayingAPI account is out of credits.");

    if (!res.ok && res.status !== 202) {
      const why = (body && (body.message || body.error)) || `StayingAPI answered ${res.status}.`;
      /* Whatever it said, it is not repeated verbatim: an upstream error can
         carry an echo of the request, key included. */
      throw new SupplyUnavailable(
        typeof why === "string" && !/stay_(test|live)_/.test(why)
          ? why : `StayingAPI answered ${res.status}.`);
    }

    /* The service hints its own back-off. Honouring it beats guessing. */
    let after = 0;
    try {
      const h = res.headers && typeof res.headers.get === "function"
        ? res.headers.get("retry-after") : null;
      const n = Number(h);
      if (Number.isFinite(n) && n > 0) after = Math.min(10_000, n * 1000);
    } catch { /* headers are optional in a fake */ }

    return { status: res.status, body, retryAfter: after };
  }

  async function call(path, params = {}) {
    let { body, retryAfter } = await once(urlFor(path, params));

    for (let i = 0; i < maxPolls; i++) {
      const d = (body && body.data) || {};
      /* A synchronous answer has no jobId and is already the payload. */
      if (!d.jobId) break;

      if (d.status === "completed") break;
      if (d.status === "failed") {
        const why = (d.error && (d.error.message || d.error.code)) || "the platform could not be read";
        throw new SupplyUnavailable("StayingAPI could not complete the request: " + why);
      }
      /* pending or running — both mean keep waiting. */
      await sleep(retryAfter || pollMs);
      const next = await once(urlFor(d.pollUrl || `/jobs/${encodeURIComponent(d.jobId)}`));
      body = next.body;
      retryAfter = next.retryAfter;
    }

    const d = (body && body.data) || {};
    if (d.jobId && d.status === "completed") {
      /* THE PAYLOAD. The same shape a synchronous call returns. */
      return { ...body, data: d.result };
    }
    if (d.jobId && d.status === "failed") {
      const why = (d.error && (d.error.message || d.error.code)) || "the platform could not be read";
      throw new SupplyUnavailable("StayingAPI could not complete the request: " + why);
    }
    if (d.jobId) {
      throw new SupplyUnavailable("StayingAPI is still working; PALTAS stopped waiting.");
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

    /**
     * WHAT THE SAME PROPERTY COSTS ELSEWHERE.
     *
     * Google-aggregator mode: a name and a location, no listing ids needed, 30
     * credits flat. This is the mode that suits PALTAS, because the hotels
     * being compared are ones LiteAPI already sells by name — there are no
     * Airbnb or Vrbo ids to supply for a Hilton.
     *
     * TWO RULES, BOTH FROM THE SPEC AND BOTH ABOUT NOT LYING WITH TRUE NUMBERS.
     *
     * ONE — compare on `totalPrice` and nothing else. The per-fee breakdown is
     * direct-mode only and, in the spec's own words, best-effort: Airbnb reports
     * cleaning, service and taxes, Booking.com reports taxes only, Vrbo and
     * Google report none. A null fee does NOT mean the platform does not charge
     * it, it means nobody could read it — so a breakdown shown beside a total
     * would invite exactly the wrong conclusion. It is not returned here.
     *
     * TWO — an offer quoted in another currency is DROPPED, not converted.
     * PALTAS holds no exchange rate it would be willing to stand behind, and
     * "£310" beside "$380" invites a comparison that is wrong by whatever the
     * rate happens to be. How many were dropped is reported instead, so the
     * page can say the comparison is partial rather than implying it is whole.
     */
    async compare({ name, location, googleHotelId, checkIn, checkOut,
                    adults = 2, children = 0, currency: want = "" } = {}) {
      if (!checkIn || !checkOut) {
        throw new SupplyUnavailable("A price comparison needs a check-in and a check-out date.");
      }
      if (!name && !location && !googleHotelId) {
        throw new SupplyUnavailable(
          "A price comparison needs a property name, a location or a Google hotel id.");
      }
      const cur = String(want || currency).toUpperCase();
      const r = await call("/price-compare", {
        name, location, googleHotelId, checkIn, checkOut, adults, children, currency: cur,
      });
      const d = (r && r.data) || {};
      const raw = Array.isArray(d.offers) ? d.offers : [];

      const offers = raw.map((o) => ({
        /* In Google mode this is the seller's name as Google reported it. It is
           displayed, so it is trimmed and never invented. */
        ota: String(o.ota || "").trim() || null,
        price: moneyFrom(o.totalPrice, o.currency),
        url: o.url || null,
        bookable: false,
      })).filter((o) => o.ota && o.price && o.price.currency === cur);

      /* Cheapest and median come from the API already excluding other
         currencies, so they agree with the list above rather than contradicting
         it. Recomputed from what survived only if it did not send them. */
      const totals = offers.map((o) => o.price.amountMinor).sort((x, y) => x - y);
      const median = totals.length
        ? totals[Math.floor((totals.length - 1) / 2)] : null;

      return {
        property: d.property || name || null,
        checkIn: d.checkIn || checkIn,
        checkOut: d.checkOut || checkOut,
        currency: cur,
        offers,
        min: moneyFrom(d.min, cur) || (totals.length ? { amountMinor: totals[0], currency: cur } : null),
        median: moneyFrom(d.median, cur) || (median !== null ? { amountMinor: median, currency: cur } : null),
        /* Said out loud: a comparison missing three of five sellers is a
           different fact from one that found two. */
        dropped: Math.max(0, raw.length - offers.length),
        via: "google",
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

/*
 * BOTH SPELLINGS, BECAUSE BOTH ARE REASONABLE.
 *
 * The product is "StayingAPI", so STAYINGAPI_KEY reads as its name — and
 * STAYING_API_KEY reads as "the Staying API key", which is how most people
 * type it and what was actually set on production. Neither is wrong, and
 * spending a support round on which one the code happened to pick is a waste
 * of somebody's afternoon. The first is canonical; the second is accepted.
 *
 * BOTH SET AND DIFFERENT IS REFUSED rather than resolved by precedence. That
 * is the state after somebody rotates one and forgets the other, and silently
 * preferring either means the service runs on a key its operator believes they
 * replaced — which is worse than not starting the feature at all.
 */
export const KEY_NAMES = ["STAYINGAPI_KEY", "STAYING_API_KEY"];

/** Built only when a key is present, so a missing one degrades to nothing. */
export function fromEnv(env = process.env) {
  /*
   * TRIMMED, and a blank value counts as ABSENT. Pasting a key into a dashboard
   * field is how one acquires a trailing newline, and an untrimmed key is sent
   * to the API in an Authorization header where it fails as a credential rather
   * than as a configuration mistake — a 401 that looks like a revoked key.
   */
  const found = KEY_NAMES
    .map((n) => [n, String(env[n] || "").trim()])
    .filter(([, v]) => v);

  if (!found.length) return null;

  const values = new Set(found.map(([, v]) => v));
  if (values.size > 1) {
    throw new SupplyUnavailable(
      found.map(([n]) => n).join(" and ") + " are both set and hold DIFFERENT " +
      "keys. PALTAS will not choose between them: that is what a half-finished " +
      "rotation looks like, and picking either one runs this service on a " +
      "credential somebody believes they have replaced. Remove whichever is stale.");
  }

  return stayingApi({
    apiKey: found[0][1],
    baseUrl: env.STAYINGAPI_BASE_URL || env.STAYING_API_BASE_URL || DEFAULT_BASE,
    currency: env.STAYINGAPI_CURRENCY || env.STAYING_API_CURRENCY || "USD",
  });
}
