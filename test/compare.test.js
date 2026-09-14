/*
 * Price comparison — the guards, not the happy path.
 *
 * Every call here is a fake. The real endpoint costs 30 credits against a
 * metered account, and a suite that spends money is a suite people stop
 * running.
 */
import test from "node:test";
import assert from "node:assert/strict";

/* connectComparison() lives in server.js, whose config guard refuses to load
   without these. They are stubs — nothing here starts a server or opens a
   socket; only the one function is called, with an env object of its own. */
process.env.SESSION_SECRET ||= "test-secret-that-is-long-enough-to-pass";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.DATABASE_URL ||= "postgresql://unused@127.0.0.1:1/none";
import {
  registerCompare, clearCompare, compareStatus, comparePrices, forgetComparisons,
} from "../src/domain/compare.js";

const HOTEL = { hotelId: "lp1a2b", name: "Al Marwa Rayhaan by Rotana", city: "Makkah", country: "SA", stars: 5 };
const supplierThatSells = { hotel: async () => HOTEL };
const supplierThatDoesNot = { hotel: async () => null };

function fakeProvider(answer, log = []) {
  return {
    name: "stayingapi",
    describe: () => ({ name: "stayingapi", label: "StayingAPI", sandbox: true, why: "connected" }),
    compare: async (args) => { log.push(args); return typeof answer === "function" ? answer(args) : answer; },
  };
}

const STAY = { hotelId: "lp1a2b", country: "SA", currency: "GBP",
               checkIn: "2026-11-02", checkOut: "2026-11-05", guests: 2 };

test.beforeEach(() => { clearCompare(); forgetComparisons(); });
test.after(() => clearCompare());

test("with no provider it says so and takes nothing off the page", async () => {
  const out = await comparePrices({ supplier: supplierThatSells, ...STAY });
  assert.deepEqual(out.offers, []);
  assert.equal(out.provider.connected, false);
  assert.match(out.why, /No price-comparison provider is connected/);
  /* The important half: it RESOLVED rather than threw. A comparison is an
     extra, and a failing extra must not remove a bookable room. */
  assert.ok(out.basis, "the caveat is missing even when there is nothing to caveat");
});

test("a hotel PALTAS does not sell is never priced, and costs nothing", async () => {
  const log = [];
  registerCompare(fakeProvider({ offers: [] }, log));

  const out = await comparePrices({ supplier: supplierThatDoesNot, ...STAY });
  assert.match(out.why, /does not sell this hotel/);
  assert.equal(log.length, 0,
    "a 30-credit comparison was requested for a hotel PALTAS does not sell");
});

test("the property name comes from the supplier, never from the caller", async () => {
  const log = [];
  registerCompare(fakeProvider({ offers: [], currency: "GBP" }, log));

  /* A caller trying to smuggle its own property in. */
  await comparePrices({
    supplier: supplierThatSells, ...STAY,
    name: "Somebody Else's Hotel", location: "Monaco", googleHotelId: "abc",
  });

  assert.equal(log.length, 1);
  assert.equal(log[0].name, HOTEL.name,
    "the caller chose which property was priced at PALTAS's expense");
  assert.equal(log[0].location, "Makkah");
  assert.equal(log[0].adults, 2);
  assert.equal(log[0].currency, "GBP");
});

test("an offer in another currency is dropped and counted, never converted", async () => {
  registerCompare(fakeProvider({
    currency: "GBP",
    offers: [
      { ota: "Booking.com", price: { amountMinor: 41200, currency: "GBP" }, url: "https://x", bookable: false },
      { ota: "Hotels.com", price: { amountMinor: 39900, currency: "GBP" }, url: "https://y", bookable: false },
    ],
    min: { amountMinor: 39900, currency: "GBP" },
    median: { amountMinor: 41200, currency: "GBP" },
    dropped: 2,
  }));

  const out = await comparePrices({ supplier: supplierThatSells, ...STAY });
  assert.equal(out.offers.length, 2);
  assert.equal(out.dropped, 2, "the dropped count was lost, so a partial comparison looks whole");
  assert.deepEqual(out.min, { amountMinor: 39900, currency: "GBP" });
  for (const o of out.offers) {
    assert.equal(o.price.currency, "GBP");
    assert.equal(o.bookable, false, "another seller's offer is marked bookable on PALTAS");
  }
});

test("the comparison always carries the sentence that keeps it honest", async () => {
  registerCompare(fakeProvider({ currency: "GBP", offers: [
    { ota: "Booking.com", price: { amountMinor: 41200, currency: "GBP" }, url: "https://x" }] }));
  const out = await comparePrices({ supplier: supplierThatSells, ...STAY });

  /*
   * PALTAS quotes one room on one board basis; Google reports what sellers
   * advertise for the property. Printing two totals side by side without
   * saying that is a comparison that reads as like-for-like and is not.
   */
  assert.match(out.basis, /Room type, board basis and cancellation terms may differ/);
});

test("the same question is asked once, however many times it is put", async () => {
  const log = [];
  registerCompare(fakeProvider({ currency: "GBP", offers: [] }, log));

  const a = await comparePrices({ supplier: supplierThatSells, ...STAY });
  const b = await comparePrices({ supplier: supplierThatSells, ...STAY });
  assert.equal(log.length, 1, "a cached comparison was bought twice");
  assert.ok(!a.cached, "the first answer claimed to be cached");
  assert.ok(b.cached, "the second answer was not served from cache");

  /* Anything that changes the answer must miss: different nights are a
     different price, and a different guest count is a different room. */
  await comparePrices({ supplier: supplierThatSells, ...STAY, checkOut: "2026-11-06" });
  assert.equal(log.length, 2, "a different stay was served a stale answer");
  await comparePrices({ supplier: supplierThatSells, ...STAY, guests: 4 });
  assert.equal(log.length, 3, "a different party size was served a stale answer");
});

test("a provider that fails leaves the room alone", async () => {
  registerCompare({
    describe: () => ({ name: "stayingapi", sandbox: false }),
    compare: async () => { throw new Error("StayingAPI is out of credits."); },
  });

  const out = await comparePrices({ supplier: supplierThatSells, ...STAY });
  assert.deepEqual(out.offers, []);
  assert.match(out.why, /out of credits/);
  assert.equal(out.hotel.name, HOTEL.name, "a failed extra lost the hotel it was attached to");
});

test("a supplier that cannot look a hotel up spends nothing", async () => {
  const log = [];
  registerCompare(fakeProvider({ offers: [] }, log));
  const out = await comparePrices({ supplier: {}, ...STAY });
  assert.match(out.why, /does not sell this hotel/);
  assert.equal(log.length, 0);
});

test("status never carries a credential", () => {
  registerCompare(fakeProvider({ offers: [] }));
  const s = JSON.stringify(compareStatus());
  assert.ok(!/stay_(live|test)_/.test(s), "compareStatus() exposes a key-shaped string");
  assert.equal(compareStatus().connected, true);
  clearCompare();
  assert.equal(compareStatus().connected, false);
});

test("'not connected' says WHICH absence it is, and never with a key", async () => {
  const { noteCompareUnavailable } = await import("../src/domain/compare.js");

  /*
   * Three situations wear the same words otherwise: nobody configured it,
   * somebody configured it wrongly, or it fell over on the way up. Each needs a
   * different action, and a boot log is unreadable from outside the machine —
   * which is exactly where somebody asking "why is this off?" is standing.
   */
  clearCompare();
  noteCompareUnavailable("STAYINGAPI_KEY is not set on this service, so no other sellers are shown.");
  assert.match(compareStatus().why, /is not set on this service/);

  noteCompareUnavailable("STAYINGAPI_KEY was set but rejected: A StayingAPI key must begin with stay_test_ or stay_live_.");
  const why = compareStatus().why;
  assert.match(why, /was set but rejected/);
  /* It names the PREFIX it wanted, which is not a credential. Nothing that
     reaches this field may ever be the value itself. */
  assert.ok(!/stay_(live|test)_[A-Za-z0-9_-]{8,}/.test(why),
    "the diagnosis carries something key-shaped");

  /* Connecting clears it, or a working provider carries a stale complaint. */
  registerCompare({ compare: async () => ({ offers: [] }), describe: () => ({ name: "x" }) });
  assert.equal(compareStatus().connected, true);
  assert.ok(!/was set but rejected/.test(compareStatus().why), "a stale failure survived a successful connect");
  clearCompare();
});

test("the diagnosis tells an empty value and a misspelt name apart", async () => {
  const { connectComparison } = await import("../src/server.js");

  /*
   * Three mistakes present identically as "not set", and only one of them is
   * "you forgot": a value that saved empty, a name one character out, and a
   * genuine absence. From outside the machine they are indistinguishable —
   * which is exactly where somebody debugging a live service is standing.
   */
  clearCompare();
  connectComparison({});
  assert.match(compareStatus().why, /Neither STAYINGAPI_KEY nor STAYING_API_KEY is set/);

  clearCompare();
  connectComparison({ STAYINGAPI_KEY: "   " });
  assert.match(compareStatus().why, /exists on this service but its value is empty/);

  clearCompare();
  connectComparison({ STAYINGAPI_TOKEN: "whatever", STAYING_SECRET: "whatever" });
  const why = compareStatus().why;
  /* Order-independent: the names are sorted, and "A" sorts before "_". */
  for (const name of ["STAYING_SECRET", "STAYINGAPI_TOKEN"]) {
    assert.ok(why.includes(name),
      `${name} was not reported, so a typo in the variable name stays invisible`);
  }

  /*
   * And it reads NAMES only. A value must never reach this field, however the
   * variable is spelt.
   */
  clearCompare();
  connectComparison({ STAYINGAPI_TOKEN: "stay_live_" + "z".repeat(30) });
  assert.ok(!/stay_live_z/.test(compareStatus().why),
    "the diagnosis printed the value of a near-miss variable");

  /* A key with an unrecognised prefix is a different answer again. */
  clearCompare();
  connectComparison({ STAYINGAPI_KEY: "sk_live_not_a_staying_key" });
  assert.match(compareStatus().why, /was set but rejected/);
  assert.ok(!/sk_live_not_a_staying_key/.test(compareStatus().why),
    "the rejected key was quoted back");
  clearCompare();
});

test("health says which build is answering, and since when", async () => {
  /*
   * "Is my change live yet?" was being answered by guessing from behaviour,
   * which fails precisely when it matters: the interesting case is usually one
   * where the old build and the new one say the SAME thing. That cost several
   * rounds over one environment variable.
   *
   * A commit SHA identifies a build. It is not a credential and grants nothing.
   */
  const src = (await import("node:fs")).readFileSync(
    new URL("../src/server.js", import.meta.url), "utf8");
  const h = src.slice(src.indexOf('app.get("/health"'), src.indexOf('app.get("/", (_req'));

  assert.match(h, /RENDER_GIT_COMMIT/, "health does not say which build is answering");
  assert.match(h, /startedAt: STARTED_AT/, "health does not say when the process started");
  assert.match(h, /\.slice\(0, 7\)/, "the full SHA is published where a short one identifies the build");

  /* Fixed at import — the process's age, not the request's clock. */
  assert.match(src, /const STARTED_AT = new Date\(\)\.toISOString\(\);/,
    "startedAt is computed per request, so it can never show a restart");
});

test("homes are never searched without a destination", async () => {
  const { findHomes, forgetHomes } = await import("../src/domain/compare.js");
  const log = [];
  clearCompare(); forgetHomes();
  registerCompare({
    describe: () => ({ name: "stayingapi", sandbox: true }),
    compare: async () => ({ offers: [] }),
    search: async (a) => { log.push(a); return { results: [] }; },
  });

  /*
   * THE COST CONTROL, AS A GUARD RATHER THAN A CONVENTION.
   *
   * This search bills per result per platform, and the homepage loads inventory
   * on every visit — bots and bounces included. Without a named destination it
   * must never run, and a caller must not be able to forget that.
   */
  const none = await findHomes({ checkIn: "2026-11-02", checkOut: "2026-11-05" });
  assert.deepEqual(none.homes, []);
  assert.match(none.why, /Choose a destination/);
  assert.equal(log.length, 0, "a metered search ran with no destination");

  await findHomes({ city: "   ", checkIn: "2026-11-02", checkOut: "2026-11-05" });
  assert.equal(log.length, 0, "whitespace counted as a destination");

  /* Dates too — a home is priced for particular nights. */
  const undated = await findHomes({ city: "Lisbon" });
  assert.match(undated.why, /need dates/);
  assert.equal(log.length, 0, "a metered search ran with no dates");
  clearCompare();
});

test("homes ask only for the platforms LiteAPI does not cover", async () => {
  const { findHomes, forgetHomes } = await import("../src/domain/compare.js");
  const log = [];
  clearCompare(); forgetHomes();
  registerCompare({
    describe: () => ({ name: "stayingapi", sandbox: true }),
    compare: async () => ({ offers: [] }),
    search: async (a) => {
      log.push(a);
      return { results: [
        { id: "airbnb:1", title: "Loft", via: "airbnb", bookable: false,
          url: "https://airbnb.com/1", price: { amountMinor: 18000, currency: "GBP" } },
        /* Rejected by the filter: no link to open. */
        { id: "vrbo:2", title: "No link", via: "vrbo", bookable: false, url: null },
      ] };
    },
  });

  const out = await findHomes({ city: "London", checkIn: "2026-11-02", checkOut: "2026-11-05", guests: 3 });

  /* Booking.com and Expedia would return hotels PALTAS already sells through
     LiteAPI — billed a second time for inventory it already has. */
  assert.deepEqual(log[0].platforms, ["airbnb", "vrbo"],
    "the search pays for platforms whose inventory PALTAS already carries");
  assert.equal(log[0].adults, 3);
  assert.ok(log[0].limit <= 20, "an unbounded limit was sent to a per-result endpoint");

  assert.equal(out.homes.length, 1, "a home with no link to open was kept");
  assert.equal(out.homes[0].bookable, false);
  assert.match(out.basis, /PALTAS does not sell these/,
    "the shelf carries nothing saying these are not PALTAS's");
  clearCompare();
});

test("the same destination is searched once", async () => {
  const { findHomes, forgetHomes } = await import("../src/domain/compare.js");
  const log = [];
  clearCompare(); forgetHomes();
  registerCompare({
    describe: () => ({ name: "stayingapi", sandbox: true }),
    compare: async () => ({ offers: [] }),
    search: async (a) => { log.push(a); return { results: [] }; },
  });
  const q = { city: "Lisbon", checkIn: "2026-11-02", checkOut: "2026-11-05", guests: 2 };
  await findHomes(q);
  await findHomes(q);
  await findHomes({ ...q, city: "  lisbon  " });   /* same place, typed differently */
  assert.equal(log.length, 1, "a cached destination was bought again");

  await findHomes({ ...q, city: "Porto" });
  assert.equal(log.length, 2, "a different destination was served a stale answer");
  clearCompare();
});

test("a provider that fails leaves the shelf as it was", async () => {
  const { findHomes, forgetHomes } = await import("../src/domain/compare.js");
  clearCompare(); forgetHomes();
  registerCompare({
    describe: () => ({ name: "stayingapi", sandbox: false }),
    compare: async () => ({ offers: [] }),
    search: async () => { throw new Error("StayingAPI is out of credits."); },
  });
  const out = await findHomes({ city: "Oslo", checkIn: "2026-11-02", checkOut: "2026-11-05" });
  assert.deepEqual(out.homes, []);
  assert.match(out.why, /out of credits/);
  clearCompare();
});
