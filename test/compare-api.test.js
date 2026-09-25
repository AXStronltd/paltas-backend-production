/* ======================================================================
 * GET /api/marketplace/hotels/:hotelId/compare
 *
 * The most expensive endpoint PALTAS has: every cache miss is a 30-credit
 * call against a metered account. These tests are about the guards on it —
 * that it is public, that it refuses a hotel PALTAS does not sell, and that a
 * caller cannot choose which property gets priced.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { freshSchema, poolInSchema, urlForSchema } from "./db-help.js";
/* Source is read through one helper so a rename to .ts cannot make this
   scanner silently find nothing. See test/src-files.js. */
import { sourceText } from "./src-files.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_compare";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret-that-is-long-enough-to-pass";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping compare route tests";
let createApp, db, pg, supply, compare;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
    ({ createApp } = await import("../src/server.js"));
    supply = await import("../src/domain/supply.ts");
    compare = await import("../src/domain/compare.ts");
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = String(e && e.message);
    skip = /did not initialize|locate the Query Engine|generate/.test(m)
      ? "RUN `npx prisma generate` FIRST"
      : "database unreachable: " + m.slice(0, 90);
  }
}

let server, base, pool;
const asked = [];

const HOTEL = { hotelId: "lp82798", name: "Conrad Jabal Omar Makkah", city: "Makkah", country: "SA", stars: 5 };

test.before(async () => {
  if (skip) return;
  pool = poolInSchema(pg, DB, SCHEMA);
  await freshSchema(pool, SCHEMA);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  supply.register({
    name: "liteapi",
    search: async () => ({ offers: [] }),
    hotel: async ({ hotelId }) => (hotelId === HOTEL.hotelId ? HOTEL : null),
  });
  compare.registerCompare({
    name: "stayingapi",
    describe: () => ({ name: "stayingapi", label: "StayingAPI", sandbox: true, why: "sandbox" }),
    compare: async (args) => {
      asked.push(args);
      return {
        property: args.name, checkIn: args.checkIn, checkOut: args.checkOut,
        currency: args.currency || "USD",
        offers: [
          { ota: "Booking.com", price: { amountMinor: 84900, currency: args.currency || "USD" },
            url: "https://www.booking.com/x", bookable: false },
        ],
        min: { amountMinor: 84900, currency: args.currency || "USD" },
        median: { amountMinor: 84900, currency: args.currency || "USD" },
        dropped: 1,
      };
    },
  });
});

test.after(async () => {
  if (compare) compare.clearCompare();
  if (supply) supply.clear();
  if (server) server.close();
  if (pool) await pool.end();
});

const url = (q) => `${base}/marketplace/hotels/${HOTEL.hotelId}/compare?${q}`;
const OK = "checkIn=2026-11-02&checkOut=2026-11-05&guests=2&country=SA&currency=USD";

test("it is public — choosing a room is browsing", { skip }, async () => {
  compare.forgetComparisons();
  const r = await fetch(url(OK));
  assert.equal(r.status, 200, "a signed-out visitor cannot see what a hotel costs elsewhere");
  const b = await r.json();
  assert.equal(b.offers.length, 1);
  assert.equal(b.offers[0].ota, "Booking.com");
  assert.equal(b.offers[0].bookable, false, "another seller's offer is marked bookable");
});

test("it refuses without the things that change the answer", { skip }, async () => {
  for (const [why, q] of [
    ["no dates", "country=SA"],
    ["no country", "checkIn=2026-11-02&checkOut=2026-11-05"],
    ["a country that is not a code", "checkIn=2026-11-02&checkOut=2026-11-05&country=Saudi"],
    ["a currency that is not a code", "checkIn=2026-11-02&checkOut=2026-11-05&country=SA&currency=POUNDS"],
    ["checkOut before checkIn", "checkIn=2026-11-05&checkOut=2026-11-02&country=SA"],
  ]) {
    const r = await fetch(url(q));
    assert.equal(r.status, 400, `${why} was accepted`);
  }
});

test("a hotel PALTAS does not sell costs nothing to ask about", { skip }, async () => {
  compare.forgetComparisons();
  const before = asked.length;
  const r = await fetch(`${base}/marketplace/hotels/not-ours/compare?${OK}`);
  assert.equal(r.status, 200, "an unknown hotel should answer, not fail");
  const b = await r.json();
  assert.deepEqual(b.offers, []);
  assert.match(b.why, /does not sell this hotel/);
  assert.equal(asked.length, before, "a 30-credit comparison was bought for a hotel PALTAS does not sell");
});

test("the caller cannot choose which property is priced", { skip }, async () => {
  compare.forgetComparisons();
  const before = asked.length;
  await fetch(url(OK + "&name=Ritz%20Paris&location=Paris&googleHotelId=abc"));
  assert.equal(asked.length, before + 1);
  const last = asked[asked.length - 1];
  assert.equal(last.name, HOTEL.name, "the query string chose the property, at PALTAS's expense");
  assert.equal(last.location, "Makkah");
  assert.equal(last.currency, "USD");
});

test("the answer carries its caveat and its dropped count", { skip }, async () => {
  compare.forgetComparisons();
  const b = await (await fetch(url(OK))).json();
  assert.match(b.basis, /Room type, board basis and cancellation terms may differ/,
    "two totals are shown side by side with nothing saying they are not like-for-like");
  assert.equal(b.dropped, 1, "an offer dropped for being in another currency was not disclosed");
  assert.ok(!/stay_(live|test)_/.test(JSON.stringify(b)), "the response carries a key-shaped string");
});

test("the same question is bought once", { skip }, async () => {
  compare.forgetComparisons();
  const before = asked.length;
  await fetch(url(OK));
  await fetch(url(OK));
  await fetch(url(OK));
  assert.equal(asked.length, before + 1, "a cached comparison was bought again");
});

test("it is rate limited harder than the free endpoints", { skip }, async () => {
  /* The rooms list costs nothing and gets 120/min. This costs money. */
  const src = sourceText("routes", "stays.js");
  const block = src.slice(src.indexOf('/compare"'), src.indexOf('/compare"') + 220);
  assert.ok(/max: 20\b/.test(block),
    "the metered endpoint is not limited more tightly than the free ones");
});
