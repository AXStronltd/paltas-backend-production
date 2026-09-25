/*
 * StayingAPI — a DATA source, and the tests that keep it from being mistaken
 * for a supply one.
 *
 * Every fixture here is hand-written. No test in this file calls the real API:
 * /search bills per result against a live account, and a test suite that spends
 * money every time it runs is a test suite people stop running.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { stayingApi, environmentOf, fromEnv, PLATFORMS, DEFAULT_BASE } from "../src/suppliers/stayingapi.ts";
import { SupplyUnavailable } from "../src/domain/supply.ts";

const TEST_KEY = "stay_test_" + "f".repeat(20);
const LIVE_KEY = "stay_live_" + "a".repeat(20);

function fakeFetch(steps: Wire) {
  const seen = [];
  const queue = Array.isArray(steps) ? steps.slice() : [steps];
  const impl = async (url: Wire, opts: Wire) => {
    seen.push({ url: String(url), headers: (opts && opts.headers) || {} });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: (next.status || 200) < 400,
      status: next.status || 200,
      headers: { get: (k: Wire) => (next.headers || {})[String(k).toLowerCase()] ?? null },
      json: async () => next.body,
    };
  };
  impl.seen = seen;
  return impl;
}

test("the key decides the environment, and nothing else can", () => {
  assert.equal(environmentOf(TEST_KEY).sandbox, true);
  assert.equal(environmentOf(LIVE_KEY).sandbox, false);

  /*
   * An unrecognised prefix is REFUSED rather than assumed. Guessing wrong in
   * one direction bills a live account for a test run; in the other it returns
   * deterministic fixtures to production and calls them inventory.
   */
  assert.equal(environmentOf("sk_live_whatever").known, false);
  assert.throws(() => stayingApi({ apiKey: "sk_live_whatever", fetchImpl: fakeFetch({ body: {} }) }),
    (e) => e instanceof SupplyUnavailable && /stay_test_ or stay_live_/.test(e.message));

  /* There is no option to override it — a sandbox key is a sandbox client. */
  const c = stayingApi({ apiKey: TEST_KEY, sandbox: false, fetchImpl: fakeFetch({ body: {} }) });
  assert.equal(c.sandbox, true, "a config flag overrode the key's own environment");
});

test("it says plainly that it cannot take a booking", async () => {
  const c = stayingApi({ apiKey: TEST_KEY, fetchImpl: fakeFetch({ body: {} }) });

  /*
   * The whole reason this file exists separately from liteapi.js. StayingAPI's
   * published surface is eight GETs — search, price, availability, listing,
   * reviews, price-compare, jobs, account — and no prebook, book, cancel or
   * payment anywhere in it.
   */
  assert.ok(!has(c.describe, "describe").call(c).capabilities.includes("book"),
    "StayingAPI advertises a booking capability it does not have");
  assert.ok(!has(c.describe, "describe").call(c).capabilities.includes("prebook"));
  assert.ok(!has(c.describe, "describe").call(c).capabilities.includes("cancel"));

  await assert.rejects(() => c.book(), (e) =>
    e instanceof SupplyUnavailable && /no booking endpoint at all/.test(e.message),
    "book() failed with something other than an explanation");
});

test("every row it returns is marked as somebody else's, and unbookable", { }, async () => {
  /*
   * The fixture is the PUBLISHED `Property` shape, not a guess at it. A first
   * version of normalise() read row.title, row.city and row.rating; every live
   * card came out with no price and no score, which looked like sparse data and
   * was three wrong field names.
   */
  const c = stayingApi({ apiKey: TEST_KEY, fetchImpl: fakeFetch({ body: { data: { results: [
    { platform: "booking", platformListingId: "casa-de-alba", name: "Casa de Alba",
      url: "https://www.booking.com/hotel/es/casa-de-alba.html",
      location: { city: "Madrid", country: "Spain" },
      images: ["https://img/1.jpg"],
      price: { currency: "EUR", totalPrice: 412.5, nightlyPrice: 137.5 },
      guestRating: 8.8, ratingScale: 10, reviewCount: 240, bedrooms: 2, propertyType: "Apartment" },
    { platform: "airbnb", platformListingId: "12345", name: "Loft in Malasaña",
      url: "https://airbnb.com/rooms/12345",
      location: { city: "Madrid", country: "Spain" },
      price: { currency: "EUR", totalPrice: 150 },
      guestRating: 4.9, ratingScale: 5 },
  ] } } }) });

  const { results } = await c.search({ location: "Madrid", checkIn: "2026-11-02", checkOut: "2026-11-05" });
  assert.equal(results.length, 2);

  for (const r of results) {
    assert.equal(r.bookable, false, `${r.id} is not marked unbookable`);
    assert.equal(r.paltasOwned, false);
    assert.equal(r.source, "stayingapi");
    assert.ok(r.via, "a row does not say which platform holds it");
    assert.ok(r.url, "a row has no link to the site that can actually sell it");
    assert.ok(r.title, "a row lost its name");
  }

  /* Money in integer minor units, from price.totalPrice — the whole stay, which
     is what a visitor compares. */
  assert.deepEqual(results[0].price, { amountMinor: 41250, currency: "EUR" });
  assert.deepEqual(results[0].perNight, { amountMinor: 13750, currency: "EUR" });
  assert.equal(results[0].city, "Madrid");
  assert.equal(results[0].image, "https://img/1.jpg");
  assert.equal(results[0].id, "booking:casa-de-alba");

  /*
   * THE SCALE COMES FROM THE SERVICE, NOT FROM THE PLATFORM NAME.
   *
   * 4.8 read as out of 10 is a bad hotel; out of 5 it is an excellent one. The
   * same true number, two opposite meanings.
   */
  assert.deepEqual(results[0].rating, { score: 8.8, outOf: 10 });
  assert.deepEqual(results[1].rating, { score: 4.9, outOf: 5 });
  /* Nothing invented where the platform gave nothing. */
  assert.equal(results[1].perNight, null, "a per-night price was divided out of a total");
});

test("a rating with no scale, or past its scale, is dropped", { }, async () => {
  const c = stayingApi({ apiKey: TEST_KEY, fetchImpl: fakeFetch({ body: { data: { results: [
    { platform: "airbnb", platformListingId: "1", name: "Nine out of five",
      url: "https://a/1", guestRating: 9.1, ratingScale: 5 },
    { platform: "booking", platformListingId: "2", name: "No scale given",
      url: "https://b/2", guestRating: 9.1, ratingScale: null },
    { platform: "booking", platformListingId: "3", name: "No score at all",
      url: "https://b/3", guestRating: 0, ratingScale: 10 },
  ] } } }) });
  const { results } = await c.search({ location: "Lisbon" });
  assert.equal(results[0].rating, null, "a 9.1 on a 5-point scale was kept");
  assert.equal(results[1].rating, null,
    "a score with no scale was given a plausible default instead of being dropped");
  assert.equal(results[2].rating, null, "a zero was rendered as a score");
});

test("a completed job is read at data.result, not data", { }, async () => {
  /*
   * THE BUG THIS EXISTS FOR.
   *
   * A completed job carries {jobId, status, result} and the payload is at
   * `result`. Reading `data` gives the wrapper — no offers, no error, no clue.
   * It looks exactly like "nobody else lists this hotel", which is why it
   * survived two live comparisons before anything noticed.
   */
  const f = fakeFetch([
    { status: 202, body: { data: { jobId: "job_77", status: "pending", pollUrl: "/v1/jobs/job_77" } } },
    { status: 200, body: { data: { jobId: "job_77", status: "running", pollUrl: "/v1/jobs/job_77" } } },
    { status: 200, body: { data: { jobId: "job_77", status: "completed",
        result: { results: [{ platform: "vrbo", platformListingId: "9", name: "Cabin",
                             url: "https://vrbo.com/9" }] } } } },
  ]);
  const c = stayingApi({ apiKey: TEST_KEY, fetchImpl: f, pollMs: 1 });
  const { results } = await c.search({ location: "Aspen" });

  assert.equal(results.length, 1, "the payload under data.result was not unwrapped");
  assert.equal(results[0].title, "Cabin");

  /* `running` is in progress, not finished. Stopping there returns a wrapper. */
  assert.equal(f.seen.length, 3, "a running job was treated as terminal");

  /* Polling is free; re-issuing the search is not. */
  assert.ok(/\/jobs\/job_77/.test(f.seen[1].url) && /\/jobs\/job_77/.test(f.seen[2].url),
    "the billed endpoint was called again instead of the free jobs one");
});

test("a failed job is HTTP 200, and is not mistaken for an empty answer", { }, async () => {
  /*
   * The spec says this in capitals: detect failure via data.status, NOT via the
   * status code. Treated as success it is another silent empty result.
   */
  const f = fakeFetch([
    { status: 202, body: { data: { jobId: "job_x", status: "pending", pollUrl: "/v1/jobs/job_x" } } },
    { status: 200, body: { data: { jobId: "job_x", status: "failed",
        error: { code: "platform_blocked", message: "Google refused the request.", retryable: true } } } },
  ]);
  const c = stayingApi({ apiKey: TEST_KEY, fetchImpl: f, pollMs: 1 });
  await assert.rejects(() => c.search({ location: "Aspen" }),
    (e) => e instanceof SupplyUnavailable && /Google refused the request/.test(e.message),
    "a failed job came back as success with no offers");
});

test("it follows the pollUrl the service gives, and its Retry-After", { }, async () => {
  const f = fakeFetch([
    { status: 202, headers: { "retry-after": "1" },
      body: { data: { jobId: "j2", status: "pending", pollUrl: "/v1/jobs/somewhere-else" } } },
    { status: 200, body: { data: { jobId: "j2", status: "completed", result: { results: [] } } } },
  ]);
  const c = stayingApi({ apiKey: TEST_KEY, fetchImpl: f, pollMs: 1 });
  await c.search({ location: "Oslo" });

  /*
   * THE EXACT URL, not a substring of it.
   *
   * The first version of this asserted that "/jobs/somewhere-else" APPEARED in
   * the polled URL — which is true of the broken "/v1/v1/jobs/somewhere-else"
   * as well. The test passed while the code 404'd against production, and it
   * only ever 404'd on requests slow enough to go asynchronous, so nothing
   * synchronous ever showed it.
   */
  assert.equal(f.seen[1].url, "https://api.stayingapi.com/v1/jobs/somewhere-else",
    "the version segment is doubled, or the service's own pollUrl was ignored");
  assert.ok(!/\/v1\/v1\//.test(f.seen[1].url), "the /v1 prefix is doubled");

  /* And my own relative paths still hang off the versioned base. */
  assert.equal(f.seen[0].url.split("?")[0], "https://api.stayingapi.com/v1/search");
});

test("it stops waiting rather than polling forever", async () => {
  const f = fakeFetch({ status: 202, body: { data: { jobId: "job_stuck", status: "running", pollUrl: "/v1/jobs/job_stuck" } } });
  const c = stayingApi({ apiKey: TEST_KEY, fetchImpl: f, pollMs: 1, maxPolls: 3 });
  await assert.rejects(() => c.search({ location: "Nowhere" }),
    (e) => e instanceof SupplyUnavailable && /stopped waiting/.test(e.message));
  assert.ok(f.seen.length <= 5, `polled ${f.seen.length} times with a cap of 3`);
});

test("the key travels in a header and never in a URL or an error", async () => {
  const f = fakeFetch({ body: { data: { results: [] } } });
  const c = stayingApi({ apiKey: LIVE_KEY, fetchImpl: f });
  await c.search({ location: "Cairo" });

  assert.ok(!f.seen[0].url.includes(LIVE_KEY), "the key was put in the query string");
  assert.equal(f.seen[0].headers.Authorization, "Bearer " + LIVE_KEY);

  /*
   * An upstream error can echo the request back, key included. Whatever the
   * API says, what reaches a caller must not carry the credential.
   */
  const leak = stayingApi({ apiKey: LIVE_KEY, fetchImpl: fakeFetch({
    status: 400, body: { message: `bad request for key ${LIVE_KEY}` } }) });
  await assert.rejects(() => leak.search({ location: "Cairo" }), (e) => {
    assert.ok(!e.message.includes(LIVE_KEY), "the upstream error leaked the API key");
    assert.ok(!/stay_live_/.test(e.message), "the error carried a key-shaped string");
    return true;
  });

  /* And nothing the browser is allowed to see carries one either. */
  const shown = JSON.stringify(has(c.describe, "describe").call(c));
  assert.ok(!shown.includes(LIVE_KEY) && !/stay_(live|test)_/.test(shown),
    "describe() exposes the key");
});

test("money and credits are refused rather than guessed", async () => {
  for (const [status, expected] of [[401, /rotated or revoked/], [402, /out of credits/], [429, /rate limiting/]]) {
    const c = stayingApi({ apiKey: LIVE_KEY, fetchImpl: fakeFetch({ status, body: {} }) });
    await assert.rejects(() => c.search({ location: "Doha" }),
      (e) => e instanceof SupplyUnavailable && expected.test(e.message),
      `${status} did not produce its own explanation`);
  }
});

test("search asks for no more than it needs, and only real platforms", async () => {
  const f = fakeFetch({ body: { data: { results: [] } } });
  const c = stayingApi({ apiKey: TEST_KEY, fetchImpl: f });

  /* limit is PER PLATFORM and billed per result, so the API's own 40 is a
     ceiling and anything above it is clamped rather than sent. */
  await c.search({ location: "Rome", limit: 500, platforms: ["airbnb", "myspace", "booking"] });
  const u = new URL(f.seen[0].url);
  assert.equal(u.searchParams.get("limit"), "40", "an unbounded limit was sent to a metered endpoint");
  assert.equal(u.searchParams.get("platforms"), "airbnb,booking", "a platform that does not exist was requested");

  await assert.rejects(() => c.search({}), (e) => /needs somewhere to search/.test(e.message));
});

test("either spelling of the variable works, and a conflict is refused", () => {
  /*
   * The product is "StayingAPI", so STAYINGAPI_KEY reads as its name;
   * STAYING_API_KEY reads as "the Staying API key", which is how most people
   * type it and what was actually set on production. Neither is wrong, and a
   * support round over which one the code happened to pick is a wasted
   * afternoon.
   */
  assert.equal(fromEnv({ STAYINGAPI_KEY: TEST_KEY }).sandbox, true);
  assert.equal(fromEnv({ STAYING_API_KEY: TEST_KEY }).sandbox, true,
    "the spelling most people type was not accepted");

  /* The same key under both names is one key, not a conflict. */
  assert.ok(fromEnv({ STAYINGAPI_KEY: TEST_KEY, STAYING_API_KEY: TEST_KEY }),
    "the same value under both names was treated as a disagreement");

  /*
   * DIFFERENT values is what a half-finished rotation looks like. Preferring
   * either silently runs the service on a credential its operator believes
   * they replaced, which is worse than the feature not starting.
   */
  assert.throws(() => fromEnv({ STAYINGAPI_KEY: TEST_KEY, STAYING_API_KEY: LIVE_KEY }), (e) => {
    assert.match(e.message, /both set and hold DIFFERENT keys/);
    assert.ok(!e.message.includes(TEST_KEY) && !e.message.includes(LIVE_KEY),
      "the conflict message quoted the keys it was refusing to choose between");
    return true;
  });
});

test("fromEnv builds nothing without a key", () => {
  assert.equal(fromEnv({}), null, "a client was built with no credential");
  const c = fromEnv({ STAYINGAPI_KEY: TEST_KEY });
  assert.equal(c.sandbox, true);
  assert.equal(has(c.describe, "describe").call(c).name, "stayingapi");
  assert.equal(DEFAULT_BASE, "https://api.stayingapi.com/v1");
  assert.deepEqual(PLATFORMS,
    ["airbnb", "booking", "vrbo", "expedia", "hotels", "google", "tripadvisor"]);
});

test("it is not registered as the marketplace's supplier", () => {
  /*
   * The guard that matters most, and the easiest to undo by accident.
   *
   * src/domain/supply.js feeds the marketplace, and everything arriving there
   * is offered to a visitor as a room they can take. Registering a source with
   * no booking endpoint would put cards on the homepage whose "View rooms"
   * button has nothing behind it.
   */
  const server = sourceText("server.js");
  assert.ok(!/register\(\s*stayingApi|stayingApi[\s\S]{0,80}?supply\.register/.test(server),
    "StayingAPI is being registered as the bookable supplier");
});
import { readFileSync } from "node:fs";
/* Source is read through one helper so a rename to .ts cannot make this
   scanner silently find nothing. See test/src-files.js. */
import { sourceText } from "./src-files.ts";
import { has } from "./wire.ts";
import type { Wire } from "./wire.ts";

test("a key pasted with whitespace is trimmed, and a blank one is absent", () => {
  /*
   * Pasting into a dashboard field is how one acquires a trailing newline. An
   * untrimmed key goes into an Authorization header and fails as a CREDENTIAL —
   * a 401 that reads as revoked — rather than as the configuration mistake it
   * is. And a whitespace-only value is somebody who meant to set it and did
   * not, which must look identical to not having set it at all.
   */
  assert.equal(fromEnv({ STAYINGAPI_KEY: "   " }), null, "a blank value built a client");
  assert.equal(fromEnv({ STAYING_API_KEY: "   " }), null, "a blank value under the alias built a client");
  assert.equal(fromEnv({ STAYINGAPI_KEY: "\n\t " }), null, "a whitespace value built a client");
  assert.equal(fromEnv({ STAYINGAPI_KEY: "" }), null);

  const c = fromEnv({ STAYINGAPI_KEY: "  " + TEST_KEY + "\n" });
  assert.ok(c, "a key with surrounding whitespace was refused instead of trimmed");
  assert.equal(c.sandbox, true, "the prefix was not seen through the whitespace");
});
