/* ====================================================================== *
 * THE ACCOMMODATION SUPPLY ADAPTER.
 *
 * No credentials exist for Expedia Rapid or the Booking.com Demand API, and
 * neither can be reached without a signed agreement. So these tests cover the
 * part of an integration that is verifiable WITHOUT an account — which turns
 * out to be most of the part that goes wrong:
 *
 *   the signature, which is a pure function and the usual cause of a 401
 *   the response mapping, against captured response shapes
 *   the refusals, which must refuse rather than invent
 *   the redaction, because a supplier error body can carry the key
 *
 * What is NOT covered, and cannot be until somebody holds credentials: that
 * Rapid accepts this signature, that its live response matches the documented
 * shape, and that the region ids map to the cities claimed.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
/* Source is read through one helper so a rename to .ts cannot make this
   scanner silently find nothing. See test/src-files.js. */
import { sourceText } from "./src-files.js";

/*
 * The precedence test imports src/server.js, which validates its configuration
 * at import time and refuses to load without these. Nothing here talks to a
 * database or binds a port — createApp() is never called — so they only need to
 * be present and well-formed, not real.
 */
process.env.SESSION_SECRET ||= "test-secret-that-is-long-enough-to-pass-validation";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.DATABASE_URL ||= "postgresql://unused@127.0.0.1:1/none";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";

import {
  SupplyUnavailable, notConnected, register, clear, isConnected, status,
  searchSupply, normaliseOffer, toMinor,
} from "../src/domain/supply.ts";
import {
  expediaRapid, signature, authorizationHeader, nightsBetween, lowestTotal,
  redact, fromEnv,
} from "../src/suppliers/expedia-rapid.ts";

test.afterEach(() => clear());

/* ================================================================ 1
 * THE SEAM
 * ================================================================ */

test("with no supplier connected, a search returns nothing and does not throw", async () => {
  /*
   * The distinction this whole file exists for. "What has the wholesaler got?"
   * has a correct answer when there is no wholesaler, and it is "nothing I can
   * see" — not an exception that takes the marketplace down with it.
   */
  assert.equal(isConnected(), false);
  const r = await searchSupply({ city: "Mombasa", country: "KE" });
  assert.deepEqual(r.offers, []);
  assert.equal(r.failed, false);
  assert.equal(r.supplier.connected, false);

  /*
   * The envelope on a search is the VISITOR's one, so the reason is in words a
   * guest can act on. "No accommodation supplier is connected" is true, and
   * useless to somebody looking for a room — it stays on the operator
   * envelope, asserted just below, where it can actually be acted on.
   */
  assert.match(r.supplier.why, /not available right now/);
  assert.match(status().why, /No accommodation supplier is connected/,
    "the operator lost the reason a supplier is missing");
});

test("a supplier must be named, because every offer is attributed to it", () => {
  assert.throws(() => register({ search: async () => ({ offers: [] }) }),
    /must have a name/);
  assert.throws(() => register({ name: "x" }), /must implement search/);
  assert.equal(isConnected(), false, "a rejected supplier must not end up registered");
});

test("a supplier that throws yields no offers and a reason, never an exception", async () => {
  register({
    name: "broken-co",
    async search() { throw new SupplyUnavailable("the wholesaler is asleep"); },
  });
  const r = await searchSupply({});
  assert.deepEqual(r.offers, [], "a failing supplier must not produce offers");
  assert.equal(r.failed, true);
  assert.match(r.why, /asleep/);
});

test("a supplier that hangs cannot hang the marketplace", async () => {
  /* The adapter's own timeout is the first defence; this checks the seam does
     not wait on a promise that never settles in the successful case either. */
  register({
    name: "slow-co",
    async search() {
      await new Promise((r) => setTimeout(r, 5));
      return { offers: [] };
    },
  });
  const r = await searchSupply({});
  assert.equal(r.failed, false);
  assert.deepEqual(r.offers, []);
});

test("an adapter cannot pass supplier inventory off as PALTAS's own", async () => {
  /*
   * `source` and `paltasOwned` are written by the seam from the registered
   * supplier's name, never read from the offer. So an adapter that tries to
   * claim otherwise — by mistake or otherwise — is overruled.
   */
  register({
    name: "expedia-rapid",
    async search() {
      return { offers: [{
        supplierRef: "99", title: "Somebody else's hotel", price: 10000,
        currency: "USD", nights: 1,
        source: "paltas", paltasOwned: true, supplier: { name: "paltas" },
      }] };
    },
  });
  const r = await searchSupply({});
  assert.equal(r.offers.length, 1);
  assert.equal(r.offers[0].source, "expedia-rapid");
  assert.equal(r.offers[0].paltasOwned, false);
  assert.equal(r.offers[0].supplier.name, "expedia-rapid");
});

test("an offer with no price or no currency is dropped, not shown blank", async () => {
  register({
    name: "s",
    async search() {
      return { offers: [
        { supplierRef: "1", title: "priced",   price: 5000, currency: "USD", nights: 1 },
        { supplierRef: "2", title: "no price", currency: "USD", nights: 1 },
        { supplierRef: "3", title: "no ccy",   price: 5000, nights: 1 },
        { title: "no id",  price: 5000, currency: "USD", nights: 1 },
      ] };
    },
  });
  const r = await searchSupply({});
  assert.deepEqual(r.offers.map((o) => o.title), ["priced"]);
  assert.equal(r.dropped, 3, "dropped rows must be counted, not silently lost");
});

test("a sandbox supplier is marked on every single offer", async () => {
  register({
    name: "expedia-rapid", sandbox: true,
    async search() {
      return { offers: [{ supplierRef: "1", title: "T", price: 100, currency: "USD", nights: 1 }] };
    },
  });
  const r = await searchSupply({});
  assert.equal(r.offers[0].supplier.sandbox, true,
    "a test rate shown as a real one is the worst failure this can have");
  assert.equal(status().sandbox, true);
});

test("status never carries a credential", () => {
  register(expediaRapid({ apiKey: "KEY-abc123", sharedSecret: "SECRET-xyz789" }));
  const s = JSON.stringify(status());
  assert.ok(!s.includes("KEY-abc123"), "the API key is in the status payload");
  assert.ok(!s.includes("SECRET-xyz789"), "the shared secret is in the status payload");
  assert.equal(s.includes("expedia-rapid"), true, "the supplier should still be named");
});

/* ================================================================ 2
 * MONEY AND UNITS
 * ================================================================ */

test("a price becomes integer minor units, and an unparseable one becomes null", () => {
  assert.equal(toMinor("149.50"), 14950);
  assert.equal(toMinor(149.5), 14950);
  assert.equal(toMinor("0"), 0);
  /* Null, never 0. A missing price displayed as "0" reads as free, which is
     the worst available way to be wrong about a hotel room. */
  assert.equal(toMinor(undefined), null);
  assert.equal(toMinor("not a number"), null);
  assert.equal(toMinor(-5), null);
  /* Floating point: 0.1 + 0.2 territory must not leave a stray cent. */
  assert.equal(toMinor("8.015"), 802);
});

test("a stay total is never presented as a nightly rate", () => {
  /*
   * The error this prevents is a factor of seven. A wholesaler quotes the whole
   * stay; a PALTAS short-let quotes one night. Printed under the same "per
   * night" label, the supplier's room looks like a spectacular bargain.
   */
  const o = normaliseOffer(
    { supplierRef: "1", title: "T", price: 70000, currency: "USD", nights: 7 },
    { name: "s", sandbox: false });
  assert.equal(o.price, 70000);
  assert.equal(o.nights, 7);
  assert.equal(o.priceBasis, "stay");
  assert.equal(o.perNight, 10000);

  /* Unknown nights must not produce a confident per-night figure. */
  const u = normaliseOffer(
    { supplierRef: "2", title: "T", price: 70000, currency: "USD" },
    { name: "s", sandbox: false });
  assert.equal(u.perNight, null);
  assert.equal(u.priceBasis, "unknown");
});

test("a rating the supplier did not give is null, not zero", () => {
  const o = normaliseOffer(
    { supplierRef: "1", title: "T", price: 100, currency: "USD", nights: 1 },
    { name: "s", sandbox: false });
  assert.equal(o.rating, null, "0 out of 10 is a terrible hotel; null is no data");
  assert.equal(o.ratingCount, null);
  assert.equal(o.image, null);
});

/* ================================================================ 3
 * THE RAPID SIGNATURE — the part a 401 never explains
 * ================================================================ */

test("the Rapid signature is SHA-512 of key + secret + unix seconds", () => {
  const key = "testkey", secret = "testsecret", ts = 1_700_000_000;
  /* Computed independently here rather than pasted from the implementation, so
     this fails if the concatenation order or the digest ever changes. */
  const expected = createHash("sha512").update("testkeytestsecret1700000000", "utf8").digest("hex");
  assert.equal(signature(key, secret, ts), expected);
  assert.equal(signature(key, secret, ts).length, 128, "SHA-512 hex is 128 characters");
  assert.match(signature(key, secret, ts), /^[0-9a-f]{128}$/);
});

test("the signature changes every second, and with every input", () => {
  const a = signature("k", "s", 1_700_000_000);
  assert.notEqual(a, signature("k", "s", 1_700_000_001), "a stale signature is a 401");
  assert.notEqual(a, signature("k2", "s", 1_700_000_000));
  assert.notEqual(a, signature("k", "s2", 1_700_000_000));
});

test("the timestamp must be seconds, because milliseconds is a silent 401", () => {
  /*
   * Passing Date.now() straight in is the classic version of this bug: the
   * request is well-formed, the signature is well-formed, and Rapid rejects it
   * for being roughly fifty thousand years out of date.
   */
  assert.throws(() => signature("k", "s", 1.7e12 + 0.5), /integer Unix timestamp in seconds/);
  assert.throws(() => signature("k", "s", "1700000000"), /integer Unix timestamp in seconds/);
});

test("no key and no secret means refuse, never an unsigned request", () => {
  assert.throws(() => signature("", "s", 1), SupplyUnavailable);
  assert.throws(() => signature("k", "", 1), SupplyUnavailable);
  assert.throws(() => expediaRapid({ apiKey: "k" }), /EXPEDIA_RAPID_SECRET/);
  assert.throws(() => expediaRapid({}), /EXPEDIA_RAPID_API_KEY/);
});

test("the Authorization header is in the form Rapid parses", () => {
  const h = authorizationHeader("abc", "def", 1_700_000_000);
  assert.match(h, /^EAN APIKey=abc,Signature=[0-9a-f]{128},timestamp=1700000000$/,
    "Rapid parses this by position and spelling; a stray space is a 401");
});

/* ================================================================ 4
 * MAPPING A RAPID RESPONSE
 * ================================================================ */

test("the lowest INCLUSIVE total wins, because exclusive is not the price", () => {
  /*
   * Rapid returns both. `exclusive` omits taxes and fees and is always lower,
   * so a page that shows it undercuts every PALTAS listing beside it with a
   * number the guest will not be charged.
   */
  const property = {
    property_id: "123",
    rooms: [{
      rates: [
        { id: "r1", refundable: false, occupancy_pricing: { 2: { totals: {
            inclusive: { billable_currency: { value: "220.00", currency: "usd" } },
            exclusive: { billable_currency: { value: "180.00", currency: "usd" } } } } } },
        { id: "r2", refundable: true, occupancy_pricing: { 2: { totals: {
            inclusive: { billable_currency: { value: "205.50", currency: "usd" } },
            exclusive: { billable_currency: { value: "170.00", currency: "usd" } } } } } },
      ],
    }],
  };
  const best = lowestTotal(property);
  assert.equal(best.price, 20550, "not 17000 — exclusive is not what anybody pays");
  assert.equal(best.currency, "USD");
  assert.equal(best.refundable, true, "the cheapest rate's own terms, not the first rate's");
});

test("a property Rapid did not price yields nothing", () => {
  assert.equal(lowestTotal({ property_id: "1", rooms: [] }), null);
  assert.equal(lowestTotal({ property_id: "1" }), null);
  assert.equal(lowestTotal({ rooms: [{ rates: [{ occupancy_pricing: {} }] }] }), null);
});

test("nights come from the dates, and a nonsense range is null", () => {
  assert.equal(nightsBetween("2026-10-01", "2026-10-08"), 7);
  assert.equal(nightsBetween("2026-10-01", "2026-10-02"), 1);
  assert.equal(nightsBetween("2026-10-08", "2026-10-01"), null, "backwards");
  assert.equal(nightsBetween("2026-10-01", "2026-10-01"), null, "zero nights is not a stay");
  assert.equal(nightsBetween("", ""), null);
  assert.equal(nightsBetween("not-a-date", "2026-10-08"), null);
});

/* ================================================================ 5
 * A WHOLE SEARCH, AGAINST A STUBBED RAPID
 * ================================================================ */

/** Rapid's two calls, answered from captured shapes. */
function stubRapid({ availability, content, fail }) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, opts) => {
      calls.push({ url, headers: opts.headers });
      if (fail) return { ok: false, status: fail, text: async () => JSON.stringify(fail === 401
        ? { type: "unauthorized", message: "invalid signature", request: url }
        : { type: "server_error" }) };
      const body = url.includes("/properties/availability") ? availability : content;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  };
}

const AVAILABILITY = [
  { property_id: "111", status: "available", rooms: [{ rates: [
      { id: "r", refundable: true, occupancy_pricing: { 2: { totals: {
        inclusive: { billable_currency: { value: "700.00", currency: "USD" } } } } } }] }] },
  { property_id: "222", status: "sold_out", rooms: [] },
  { property_id: "333", status: "available", rooms: [{ rates: [
      { id: "r", refundable: false, occupancy_pricing: { 2: { totals: {
        inclusive: { billable_currency: { value: "420.00", currency: "USD" } } } } } }] }] },
];

const CONTENT = {
  111: { name: "Nyali Beach Hotel", address: { line_1: "Mombasa Road", city: "Mombasa", country_code: "KE" },
         ratings: { guest: { overall: "8.6", count: "1423" } },
         images: [{ links: { "350px": { href: "https://images.example/111.jpg" } } }] },
  /* 333 is priced but has no content — so it must not be rendered. */
};

test("a Rapid search joins prices to content and drops what it cannot draw", async () => {
  const stub = stubRapid({ availability: AVAILABILITY, content: CONTENT });
  register(expediaRapid({
    apiKey: "k", sharedSecret: "s", fetchImpl: stub.fetchImpl,
    regions: { "mombasa,ke": "6054439" },
    now: () => 1_700_000_000_000,
  }));

  const r = await searchSupply({
    city: "Mombasa", country: "KE", checkIn: "2026-10-01", checkOut: "2026-10-08",
    guests: 2, limit: 12, travellerIp: "41.90.1.1",
  });

  assert.equal(r.failed, false, r.why);
  assert.equal(r.offers.length, 1,
    "222 is sold out and 333 has no content — only 111 can be drawn");

  const o = r.offers[0];
  assert.equal(o.title, "Nyali Beach Hotel");
  assert.equal(o.city, "Mombasa");
  assert.equal(o.price, 70000, "the stay total, in minor units");
  assert.equal(o.nights, 7);
  assert.equal(o.perNight, 10000, "700 over seven nights");
  assert.equal(o.priceBasis, "stay");
  assert.equal(o.refundable, true);
  assert.equal(o.rating, 8.6, "a real guest rating, carried and attributed");
  assert.equal(o.ratingCount, 1423);
  assert.equal(o.image, "https://images.example/111.jpg");
  assert.equal(o.source, "expedia-rapid");
  assert.equal(o.paltasOwned, false);
  assert.equal(o.id, "expedia-rapid:111", "namespaced so it cannot collide with a listing id");
});

test("Rapid is sent the traveller's IP, signed, and with dates", async () => {
  const stub = stubRapid({ availability: AVAILABILITY, content: CONTENT });
  register(expediaRapid({
    apiKey: "mykey", sharedSecret: "mysecret", fetchImpl: stub.fetchImpl,
    regions: { "mombasa,ke": "6054439" }, now: () => 1_700_000_000_000,
  }));
  await searchSupply({
    city: "Mombasa", country: "KE", checkIn: "2026-10-01", checkOut: "2026-10-08",
    travellerIp: "41.90.1.1",
  });

  const first = stub.calls[0];
  assert.match(first.url, /checkin=2026-10-01/);
  assert.match(first.url, /checkout=2026-10-08/);
  assert.match(first.url, /region_id=6054439/);
  /* Rapid refuses a search without the end traveller's IP, and will not accept
     this server's. */
  assert.equal(first.headers["Customer-Ip"], "41.90.1.1");
  assert.match(first.headers.Authorization, /^EAN APIKey=mykey,Signature=[0-9a-f]{128},timestamp=1700000000$/);
});

test("an unmapped city returns nothing and says so, rather than guessing a region", async () => {
  /*
   * The most dangerous available shortcut. Rapid's region ids are opaque
   * integers; a wrong one returns real hotels in the wrong country at real
   * prices, which looks entirely correct and is completely wrong.
   */
  const stub = stubRapid({ availability: AVAILABILITY, content: CONTENT });
  register(expediaRapid({
    apiKey: "k", sharedSecret: "s", fetchImpl: stub.fetchImpl,
    regions: { "mombasa,ke": "6054439" }, now: () => 1_700_000_000_000,
  }));
  const r = await searchSupply({
    city: "Kisumu", country: "KE", checkIn: "2026-10-01", checkOut: "2026-10-08",
  });
  assert.deepEqual(r.offers, []);
  assert.equal(stub.calls.length, 0, "no request should be made at all");
  assert.match(r.why, /no region mapped/i,
    "the caller must be told WHY, not left with an unexplained empty list");
});

test("no dates means no supplier rates, not invented dates", async () => {
  const stub = stubRapid({ availability: AVAILABILITY, content: CONTENT });
  register(expediaRapid({
    apiKey: "k", sharedSecret: "s", fetchImpl: stub.fetchImpl,
    regions: { "mombasa,ke": "6054439" }, now: () => 1_700_000_000_000,
  }));
  const r = await searchSupply({ city: "Mombasa", country: "KE" });
  assert.deepEqual(r.offers, []);
  assert.equal(stub.calls.length, 0);
});

test("a 401 from Rapid never puts the signature in the error", async () => {
  /*
   * Rapid echoes the request in some error bodies, and the request carries the
   * signature. An unredacted body in a log is how a credential leaves a
   * building.
   */
  const stub = stubRapid({ fail: 401 });
  register(expediaRapid({
    apiKey: "SUPERSECRETKEY", sharedSecret: "s", fetchImpl: stub.fetchImpl,
    regions: { "mombasa,ke": "1" }, now: () => 1_700_000_000_000,
  }));
  const r = await searchSupply({
    city: "Mombasa", country: "KE", checkIn: "2026-10-01", checkOut: "2026-10-08",
  });
  assert.equal(r.failed, true);
  assert.deepEqual(r.offers, [], "a 401 must not produce offers");
  assert.ok(!r.why.includes("SUPERSECRETKEY"), "the API key is in the error message: " + r.why);
  assert.ok(!/[0-9a-f]{128}/.test(r.why), "the signature is in the error message");
  assert.match(r.why, /401/);
});

test("redaction covers the shapes a credential actually arrives in", () => {
  assert.equal(redact("EAN APIKey=abc123,Signature=def,timestamp=1"),
    "EAN APIKey=[redacted],Signature=[redacted],timestamp=1");
  assert.match(redact('{"api_key":"abc123"}'), /\[redacted\]/);
  assert.match(redact('{"shared_secret": "xyz"}'), /\[redacted\]/);
  assert.ok(!redact("sig " + "a".repeat(128)).includes("a".repeat(128)));
  /* And it must not mangle an ordinary message. */
  assert.equal(redact("Rapid returned 503"), "Rapid returned 503");
});

/* ================================================================ 6
 * CONFIGURATION
 * ================================================================ */

test("absent credentials are the normal state, not a crash", () => {
  /*
   * This is how every installation starts, including production today. fromEnv
   * must return null so the service boots and the marketplace serves PALTAS's
   * own listings, exactly as it did before a supplier existed.
   */
  assert.equal(fromEnv({}), null);
  assert.equal(fromEnv({ EXPEDIA_RAPID_API_KEY: "k" }), null, "a key with no secret");
  assert.equal(fromEnv({ EXPEDIA_RAPID_SECRET: "s" }), null, "a secret with no key");
});

test("test mode is a sandbox, and says so", () => {
  const s = fromEnv({
    EXPEDIA_RAPID_API_KEY: "k", EXPEDIA_RAPID_SECRET: "s", EXPEDIA_RAPID_TEST: "1",
  });
  assert.equal(s.sandbox, true);
  assert.match(s.describe().why, /TEST mode/);
  assert.match(s.describe().why, /must not be presented as bookable/);
});

test("a malformed region map disables cities, it does not disable the service", () => {
  const s = fromEnv({
    EXPEDIA_RAPID_API_KEY: "k", EXPEDIA_RAPID_SECRET: "s",
    EXPEDIA_RAPID_REGIONS: "{not json",
  });
  assert.ok(s, "a bad region map must not stop the supplier being built");
  assert.equal(s.describe().regionsKnown, 0);
});

test("notConnected is the default and cannot be searched into existence", async () => {
  clear();
  assert.equal(isConnected(), false);
  const r = await notConnected.search();
  assert.deepEqual(r.offers, []);
  assert.equal(notConnected.describe().connected, false);
});

/* ================================================================ 7
 * BOOKING.COM DEMAND
 *
 * Less is verifiable here than for Rapid, and that asymmetry is the reason
 * Rapid went first. Rapid's auth is a pure function and fully tested. Booking
 * uses a bearer token, which cannot be derived — so the request bodies, the
 * two-call join, the mapping and the redaction are covered, and the auth itself
 * cannot be until somebody holds a token.
 * ================================================================ */

const { bookingDemand, priceOf, fromEnv: bookingFromEnv, redact: bookingRedact } =
  await import("../src/suppliers/booking-demand.ts");

const B_SEARCH = { data: [
  { id: 111, price: { gross_amount: { value: "700.00", currency: "USD" },
                      total: { value: "580.00", currency: "USD" } } },
  { id: 222, price: { gross_amount: { value: "420.00", currency: "USD" } } },
  { id: 333 },                                   /* unpriced */
] };
const B_DETAILS = { data: [
  { id: 111, name: "Harbour Lodge", url: "https://www.booking.com/hotel/x.html",
    location: { city: "Mombasa", country: "ke" },
    address: { address: "12 Harbour Road" },
    reviews: { score: "8.4", count: "905" },
    photos: [{ url: "https://cf.bstatic.com/111.jpg" }] },
  /* 222 priced but has no detail record, so it cannot be drawn. */
] };

function stubBooking({ search, details, fail }) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, opts) => {
      calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      if (fail) return { ok: false, status: fail,
        text: async () => JSON.stringify({ message: "bad token", echo: opts.headers }) };
      const body = url.includes("/accommodations/search") ? search : details;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  };
}

test("Booking.com takes the GROSS price, because net is not what anybody pays", () => {
  /* Both are returned. `total` here omits taxes and fees and is lower, so
     showing it would undercut every PALTAS listing with a number the guest will
     not be charged. */
  assert.deepEqual(priceOf(B_SEARCH.data[0]), { price: 70000, currency: "USD" });
  assert.equal(priceOf({ id: 1 }), null);
  assert.equal(priceOf({ id: 1, price: {} }), null);
  /* No currency is not a price. */
  assert.equal(priceOf({ price: { gross_amount: { value: "10.00" } } }), null);
});

test("a Booking search joins two POSTs and drops what it cannot draw", async () => {
  const stub = stubBooking({ search: B_SEARCH, details: B_DETAILS });
  register(bookingDemand({
    token: "tok", affiliateId: "12345", fetchImpl: stub.fetchImpl,
    cities: { "mombasa,ke": "-1234567" },
  }));
  const r = await searchSupply({
    city: "Mombasa", country: "KE", checkIn: "2026-10-01", checkOut: "2026-10-08",
    travellerIp: "41.90.1.1",
  });

  assert.equal(r.failed, false, r.why);
  assert.equal(r.offers.length, 1, "222 has no detail record and 333 no price");
  const o = r.offers[0];
  assert.equal(o.title, "Harbour Lodge");
  assert.equal(o.city, "Mombasa");
  assert.equal(o.price, 70000);
  assert.equal(o.nights, 7);
  assert.equal(o.perNight, 10000);
  assert.equal(o.rating, 8.4);
  assert.equal(o.ratingCount, 905);
  assert.equal(o.source, "booking-demand");
  assert.equal(o.supplier.label, "Booking.com",
    "the attribution must read as the brand, not the internal adapter name");
  assert.equal(o.id, "booking-demand:111");
  /*
   * Booking reports cancellation per product and this adapter does not request
   * products deeply enough to be certain, so it says nothing rather than
   * claiming non-refundable on the supplier's behalf.
   */
  assert.equal(o.refundable, null);
});

test("the Booking request carries the token, affiliate and a real body", async () => {
  const stub = stubBooking({ search: B_SEARCH, details: B_DETAILS });
  register(bookingDemand({
    token: "tok-abc", affiliateId: "98765", fetchImpl: stub.fetchImpl,
    cities: { "mombasa,ke": "-1234567" },
  }));
  await searchSupply({
    city: "Mombasa", country: "KE", checkIn: "2026-10-01", checkOut: "2026-10-08",
    guests: 3, travellerIp: "41.90.1.1",
  });

  const first = stub.calls[0];
  assert.equal(first.headers.Authorization, "Bearer tok-abc");
  assert.equal(first.headers["X-Affiliate-Id"], "98765");
  assert.equal(first.body.checkin, "2026-10-01");
  assert.equal(first.body.checkout, "2026-10-08");
  assert.equal(first.body.city, -1234567, "the city id must be a number, not a string");
  assert.equal(first.body.guests.number_of_adults, 3);
  /* Booking decides which rates and which legal terms apply from the booker's
     market, so it is not optional. */
  assert.equal(first.body.booker.country, "ke");

  const second = stub.calls[1];
  assert.ok(second.url.includes("/accommodations/details"));
  assert.deepEqual(second.body.accommodations, [111, 222]);
});

test("an unmapped city returns nothing and says so, and makes no request", async () => {
  const stub = stubBooking({ search: B_SEARCH, details: B_DETAILS });
  register(bookingDemand({
    token: "t", affiliateId: "1", fetchImpl: stub.fetchImpl,
    cities: { "mombasa,ke": "-1234567" },
  }));
  const r = await searchSupply({
    city: "Kisumu", country: "KE", checkIn: "2026-10-01", checkOut: "2026-10-08",
  });
  assert.deepEqual(r.offers, []);
  assert.equal(stub.calls.length, 0);
  assert.match(r.why, /no city id mapped/i);
});

test("a Booking error never carries the bearer token", async () => {
  const stub = stubBooking({ fail: 401 });
  register(bookingDemand({
    token: "SUPERSECRETTOKEN", affiliateId: "1", fetchImpl: stub.fetchImpl,
    cities: { "mombasa,ke": "-1" },
  }));
  const r = await searchSupply({
    city: "Mombasa", country: "KE", checkIn: "2026-10-01", checkOut: "2026-10-08",
  });
  assert.equal(r.failed, true);
  assert.deepEqual(r.offers, []);
  assert.ok(!r.why.includes("SUPERSECRETTOKEN"),
    "the bearer token is in the error message: " + r.why);
  assert.match(r.why, /401/);
});

test("Booking redaction covers the shapes a token arrives in", () => {
  assert.equal(bookingRedact("Authorization: Bearer abc.def-ghi"),
    "Authorization: Bearer [redacted]");
  assert.match(bookingRedact('{"token":"abc"}'), /\[redacted\]/);
  assert.match(bookingRedact("X-Affiliate-Id: 12345"), /\[redacted\]/);
  assert.equal(bookingRedact("Booking returned 503"), "Booking returned 503");
});

test("Booking needs both a token and an affiliate id, or it refuses", () => {
  assert.equal(bookingFromEnv({}), null);
  assert.equal(bookingFromEnv({ BOOKING_DEMAND_TOKEN: "t" }), null);
  assert.equal(bookingFromEnv({ BOOKING_DEMAND_AFFILIATE: "1" }), null);
  assert.throws(() => bookingDemand({ token: "t" }), /BOOKING_DEMAND_AFFILIATE/);
});

/* ================================================================ 8
 * THE SAMPLE CATALOGUE
 *
 * Demonstration inventory on a public marketplace. Every test here is a version
 * of one question: can a visitor mistake this for something they could book?
 * ================================================================ */

const { sampleCatalogue, fromEnv: sampleFromEnv, DISCLOSURE } =
  await import("../src/suppliers/sample-catalogue.ts");

test("the sample catalogue is off unless somebody switches it on", () => {
  /*
   * The single most important test in this file. Demonstration content that can
   * appear because a variable was left at its default is how fake inventory
   * ends up on a live marketplace with nobody having decided it should.
   */
  assert.equal(sampleFromEnv({}), null);
  assert.equal(sampleFromEnv({ PALTAS_SAMPLE_SUPPLY: "0" }), null);
  assert.equal(sampleFromEnv({ PALTAS_SAMPLE_SUPPLY: "true" }), null,
    "only the exact string \"1\" may enable it");
  assert.ok(sampleFromEnv({ PALTAS_SAMPLE_SUPPLY: "1" }));
});

test("every sample property is marked unbookable three separate ways", async () => {
  register(sampleCatalogue({ count: 4 }));
  const r = await searchSupply({ city: "Mombasa", country: "KE" });
  assert.ok(r.offers.length > 0);

  for (const o of r.offers) {
    /* 1. the sandbox flag the frontend reads to stamp the card */
    assert.equal(o.supplier.sandbox, true, "a sample offer is not flagged sandbox");
    /* 2. in the TITLE, so it survives a screenshot that crops the badge */
    assert.match(o.title, /\(sample\)$/,
      `"${o.title}" does not say it is a sample in its own title`);
    /* 3. a disclosure on the row, because a card may be rendered by a client
          that never read the envelope */
    assert.equal(o.supplier.disclosure, DISCLOSURE);
    assert.match(o.supplier.disclosure, /not a real property|cannot be booked/);
    /* and it is never PALTAS's own */
    assert.equal(o.paltasOwned, false);
    assert.equal(o.source, "paltas-sample");
  }
  assert.match(status().label, /not real inventory/i,
    "the attribution a visitor reads must say what this is");
});

test("the sample names no real business", async () => {
  /*
   * Putting a real hotel's name on invented inventory at an invented price
   * misrepresents that company — which is a worse wrong than the fake listing
   * itself. The titles are generic property descriptions for that reason.
   */
  register(sampleCatalogue({ count: 8 }));
  const r = await searchSupply({ city: "Mombasa", country: "KE" });
  for (const o of r.offers) {
    assert.ok(!/\b(Hilton|Marriott|Serena|Radisson|Sarova|Swahili Beach|Voyager)\b/i.test(o.title),
      `"${o.title}" names what looks like a real business`);
  }
});

test("the sample hotlinks nobody's photograph", async () => {
  register(sampleCatalogue({ count: 8 }));
  const r = await searchSupply({ city: "Mombasa", country: "KE" });
  for (const o of r.offers) {
    assert.equal(o.image, null,
      "a sample is not a licence to serve somebody else's image");
  }
});

test("the sample shows properties on a plain load, and prices a night", async () => {
  /*
   * The one place it diverges from a real wholesaler, on purpose. Expedia and
   * Booking refuse without dates because their price is a live quote. A sample
   * price is not a quote, and the point of the catalogue is a populated page the
   * moment somebody arrives.
   */
  register(sampleCatalogue({ count: 3 }));
  const plain = await searchSupply({ city: "Mombasa", country: "KE" });
  assert.equal(plain.offers.length, 3, "a plain load must still show properties");
  assert.equal(plain.offers[0].nights, 1, "with no dates the figure is one night");

  const dated = await searchSupply({
    city: "Mombasa", country: "KE", checkIn: "2026-10-01", checkOut: "2026-10-08",
  });
  assert.equal(dated.offers[0].nights, 7);
  assert.equal(dated.offers[0].price, plain.offers[0].price * 7,
    "seven nights should cost seven times one night");
});

test("the sample is deterministic, so two screenshots differ only by the page", async () => {
  register(sampleCatalogue({ count: 5 }));
  const a = await searchSupply({ city: "Mombasa", country: "KE" });
  const b = await searchSupply({ city: "Mombasa", country: "KE" });
  assert.deepEqual(a.offers, b.offers);
});

test("a real supplier always outranks the sample catalogue", async () => {
  /*
   * Checked against the actual boot function rather than by reading it, because
   * "the real one wins" is exactly the kind of precedence that looks right in
   * source and is wrong in practice.
   */
  const { connectSuppliers } = await import("../src/server.js");

  clear();
  let s = connectSuppliers({ PALTAS_SAMPLE_SUPPLY: "1" });
  assert.equal(s.name, "paltas-sample", "with no credentials the sample should be used");

  clear();
  s = connectSuppliers({
    PALTAS_SAMPLE_SUPPLY: "1",
    EXPEDIA_RAPID_API_KEY: "k", EXPEDIA_RAPID_SECRET: "s",
  });
  assert.equal(s.name, "expedia-rapid",
    "the sample catalogue outranked a licensed supplier");

  clear();
  s = connectSuppliers({
    PALTAS_SAMPLE_SUPPLY: "1",
    BOOKING_DEMAND_TOKEN: "t", BOOKING_DEMAND_AFFILIATE: "1",
  });
  assert.equal(s.name, "booking-demand",
    "the sample catalogue outranked a licensed supplier");

  clear();
  assert.equal(connectSuppliers({}), null, "nothing configured means nothing connected");
});

test("a sand_ token forces sandbox mode even when the flag is off", async () => {
  /*
   * Booking issues test credentials prefixed `sand_`. Configured without
   * BOOKING_DEMAND_TEST=1, every rate would render as ordinary bookable
   * inventory — real-looking hotels at real-looking prices that nobody can
   * actually book. It is the worst failure available to this integration and it
   * happens by OMISSION: somebody pastes the token and forgets the flag.
   *
   * So the token decides, and an operator cannot override it. There is no
   * legitimate reason to present test inventory as live.
   */
  const s = bookingDemand({
    token: "sand_00000000-0000-4000-8000-000000000000",   /* fixture, not a real token */
    affiliateId: "1",
    /* explicitly NOT in test mode */
    test: false,
  });
  assert.equal(s.sandbox, true,
    "a sandbox token was accepted as a production credential");
  assert.equal(s.describe().sandbox, true);
  assert.match(s.describe().why, /forced, because the configured token is a sandbox token/);
  assert.match(s.describe().disclosure, /cannot be booked/);

  /* And it reaches every offer, which is what the page actually reads. */
  const stub = stubBooking({ search: B_SEARCH, details: B_DETAILS });
  register(bookingDemand({
    token: "sand_abc", affiliateId: "1", test: false, fetchImpl: stub.fetchImpl,
    cities: { "mombasa,ke": "-1" },
  }));
  const r = await searchSupply({
    city: "Mombasa", country: "KE", checkIn: "2026-10-01", checkOut: "2026-10-08",
  });
  assert.ok(r.offers.length > 0, "the stub returned nothing, so this proves nothing");
  for (const o of r.offers) {
    assert.equal(o.supplier.sandbox, true, "a sandbox offer is not marked");
    assert.match(o.supplier.disclosure, /TEST environment/);
  }
});

test("a production token is left alone", () => {
  /* The detection must not catch a real credential and quietly mark live
     inventory unbookable, which would be the mirror-image failure. */
  const s = bookingDemand({ token: "abc123-not-a-sandbox", affiliateId: "1" });
  assert.equal(s.sandbox, false);
  assert.equal(s.describe().disclosure, "");
  assert.match(s.describe().why, /^Booking\.com Demand is connected\.$/);
});

test("fromEnv carries the forced sandbox through", () => {
  const s = bookingFromEnv({
    BOOKING_DEMAND_TOKEN: "sand_00000000-0000-4000-8000-000000000000",
    BOOKING_DEMAND_AFFILIATE: "12345",
  });
  assert.equal(s.sandbox, true,
    "the sandbox token survived the environment without being marked");
});

/* ================================================================ 9
 * LITEAPI (Nuitee Connect)
 *
 * Contract taken from the published reference, not from memory:
 *   X-API-Key, base https://api.liteapi.travel/v3.0, sandbox keys `sand_`
 *   POST /hotels/rates   by cityName + countryCode
 *   GET  /data/hotels    bulk content by comma-separated hotelIds
 * ================================================================ */

const {
  liteApi, cheapestRate, refundableFrom, ratingOf,
  fromEnv: liteFromEnv, redact: liteRedact,
} = await import("../src/suppliers/liteapi.ts");

const L_RATES = { data: [
  { hotelId: "lp1897", roomTypes: [{ rates: [
      { retailRate: {
          total: [{ amount: 742.5, currency: "USD" }],
          suggestedSellingPrice: [{ amount: 890, currency: "USD" }] },
        cancellationPolicies: { refundableTag: "RFN" } },
      { retailRate: { total: [{ amount: 640, currency: "USD" }] },
        cancellationPolicies: { refundableTag: "NRFN" } },
  ] }] },
  { hotelId: "lp5555", roomTypes: [{ rates: [
      { retailRate: { total: [{ amount: 310, currency: "USD" }] } },
  ] }] },
  { hotelId: "lp9999", roomTypes: [] },                /* unpriced */
] };

const L_CONTENT = { data: [
  { id: "lp1897", name: "Diani Reef Beach Resort", address: "Diani Beach Road",
    city: "Diani", country: "KE", stars: 5, rating: 8.7, reviewCount: 1204,
    main_photo: "https://static.liteapi.travel/lp1897.jpg" },
  /* lp5555 priced but absent from content, so it cannot be drawn. */
], total: 1 };

function stubLite({ rates, content, fail }) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method || "GET", headers: opts.headers,
                   body: opts.body ? JSON.parse(opts.body) : null });
      if (fail) return { ok: false, status: fail,
        text: async () => JSON.stringify({ error: "bad key", sent: opts.headers }) };
      const body = url.includes("/hotels/rates") ? rates : content;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  };
}

test("the cheapest RETAIL total wins, not the suggested selling price", () => {
  /*
   * suggestedSellingPrice is a markup recommendation. Retail is what the booking
   * costs. Showing the suggestion would inflate every supplier room against the
   * PALTAS listings beside it — the mirror of the net/gross trap in the other
   * two adapters.
   */
  const best = cheapestRate(L_RATES.data[0]);
  assert.equal(best.price, 64000, "not 74250, and certainly not 89000");
  assert.equal(best.currency, "USD");
  assert.equal(best.refundable, false, "the cheapest rate's own terms");
  assert.equal(cheapestRate({ roomTypes: [] }), null);
  /* `total` is an array in the contract; a bare object must not crash it. */
  assert.equal(cheapestRate({ roomTypes: [{ rates: [{ retailRate: {} }] }] }), null);
});

test("refundability is RFN or NRFN, and anything else is 'not stated'", () => {
  assert.equal(refundableFrom({ cancellationPolicies: { refundableTag: "RFN" } }), true);
  assert.equal(refundableFrom({ cancellationPolicies: { refundableTag: "NRFN" } }), false);
  /* Not false. Defaulting to non-refundable would state terms nobody read. */
  assert.equal(refundableFrom({}), null);
  assert.equal(refundableFrom({ cancellationPolicies: {} }), null);
  assert.equal(refundableFrom({ cancellationPolicies: { refundableTag: "SOMETHING_NEW" } }), null);
});

test("a review score is taken only on the scale the card renders", () => {
  assert.equal(ratingOf(8.7), 8.7);
  assert.equal(ratingOf("8.65"), 8.7);
  assert.equal(ratingOf(10), 10);
  /*
   * The card prints "x / 10". A 92 shown as "92/10" is nonsense and a 92
   * quietly divided by ten is a fabrication, so anything off-scale is dropped.
   */
  assert.equal(ratingOf(92), null);
  assert.equal(ratingOf(0), null);
  assert.equal(ratingOf(-1), null);
  assert.equal(ratingOf(undefined), null);
});

test("a LiteAPI search prices by city NAME and needs no id map", async () => {
  const stub = stubLite({ rates: L_RATES, content: L_CONTENT });
  register(liteApi({ apiKey: "prod_live", fetchImpl: stub.fetchImpl }));
  const r = await searchSupply({
    city: "Diani", country: "ke", checkIn: "2026-11-01", checkOut: "2026-11-08",
    guests: 2, limit: 12,
  });

  assert.equal(r.failed, false, r.why);
  assert.equal(r.offers.length, 1, "lp5555 has no content and lp9999 no price");

  const o = r.offers[0];
  assert.equal(o.title, "Diani Reef Beach Resort");
  assert.equal(o.city, "Diani");
  assert.equal(o.country, "KE");
  assert.equal(o.price, 64000);
  assert.equal(o.nights, 7);
  assert.equal(o.perNight, 9143, "64000 over seven nights");
  assert.equal(o.rating, 8.7);
  assert.equal(o.ratingCount, 1204);
  assert.equal(o.image, "https://static.liteapi.travel/lp1897.jpg");
  /*
   * A PUBLIC ROW CARRIES THE PUBLIC IDENTITY.
   *
   * These two fields go straight into a response every visitor's browser
   * receives, so they say "partner" rather than naming the wholesaler PALTAS
   * buys through. The adapter's real name is unchanged and still reachable
   * through status() — it is the key bookings are stored under, and renaming
   * it would orphan every booking already taken.
   */
  assert.equal(o.source, "partner");
  assert.equal(o.id, "partner:lp1897", "the id namespace still separates supplier rows from PALTAS ones");
  assert.equal(status().name, "liteapi", "the adapter's own identity must not change");

  /* The request itself: a name, not an opaque id — the whole reason this
     adapter has no id map where the other two need one. */
  const rates = stub.calls[0];
  assert.equal(rates.method, "POST");
  assert.match(rates.url, /\/hotels\/rates$/);
  assert.equal(rates.headers["X-API-Key"], "prod_live");
  assert.equal(rates.body.cityName, "Diani");
  assert.equal(rates.body.countryCode, "KE");
  assert.equal(rates.body.checkin, "2026-11-01");
  assert.deepEqual(rates.body.occupancies, [{ adults: 2, children: [] }]);

  /* And content in ONE call, not one per hotel. */
  const content = stub.calls[1];
  assert.equal(stub.calls.length, 2, "content must be fetched in bulk");
  assert.match(content.url, /\/data\/hotels\?/);
  assert.match(content.url, /hotelIds=lp1897%2Clp5555/);
  assert.match(content.url, /countryCode=KE/);
});

test("a sand_ key forces sandbox mode and cannot be overridden", async () => {
  /*
   * The most convincing fake inventory this platform could display: LiteAPI's
   * sandbox returns REAL hotel names, REAL addresses and REAL photographs with
   * TEST rates. A real hotel at a price nobody can book.
   *
   * So the key decides, not a flag somebody might forget.
   */
  const s = liteApi({ apiKey: "sand_00000000-0000-4000-8000-000000000000" });
  assert.equal(s.sandbox, true);
  assert.match(s.describe().label, /sandbox/i,
    "the attribution a visitor reads must say it is a sandbox");
  assert.match(s.describe().why, /cannot be switched off/);
  assert.match(s.describe().disclosure, /cannot be booked/);

  const stub = stubLite({ rates: L_RATES, content: L_CONTENT });
  register(liteApi({ apiKey: "sand_abc", fetchImpl: stub.fetchImpl }));
  const r = await searchSupply({
    city: "Diani", country: "KE", checkIn: "2026-11-01", checkOut: "2026-11-08",
  });
  assert.ok(r.offers.length > 0);
  for (const o of r.offers) {
    assert.equal(o.supplier.sandbox, true);
    assert.match(o.supplier.disclosure, /sandbox/i);
    assert.match(o.supplier.disclosure, /cannot be booked/);
  }

  /* A production key must NOT be caught — marking live inventory unbookable is
     the mirror-image failure. */
  assert.equal(liteApi({ apiKey: "prod_xyz" }).sandbox, false);
});

test("LiteAPI refuses without dates and without a country", async () => {
  const stub = stubLite({ rates: L_RATES, content: L_CONTENT });
  register(liteApi({ apiKey: "prod_k", fetchImpl: stub.fetchImpl }));

  let r = await searchSupply({ city: "Diani", country: "KE" });
  assert.deepEqual(r.offers, []);
  assert.match(r.why, /check-in and a check-out/);

  r = await searchSupply({ city: "Diani", checkIn: "2026-11-01", checkOut: "2026-11-08" });
  assert.deepEqual(r.offers, []);
  assert.match(r.why, /needs a country/);
  assert.equal(stub.calls.length, 0, "neither refusal should make a request");
});

test("a LiteAPI error never carries the key", async () => {
  const stub = stubLite({ fail: 401 });
  register(liteApi({ apiKey: "sand_SUPERSECRETKEYVALUE", fetchImpl: stub.fetchImpl }));
  const r = await searchSupply({
    city: "Diani", country: "KE", checkIn: "2026-11-01", checkOut: "2026-11-08",
  });
  assert.equal(r.failed, true);
  assert.deepEqual(r.offers, []);
  assert.ok(!r.why.includes("SUPERSECRETKEYVALUE"), "the key is in the error: " + r.why);
  assert.match(r.why, /401/);
});

test("LiteAPI redaction covers both key prefixes and the header", () => {
  assert.match(liteRedact("key sand_00000000-0000-4000"), /\[redacted-key\]/);
  assert.match(liteRedact("key prod_abc123-def"), /\[redacted-key\]/);
  assert.match(liteRedact('{"X-API-Key":"whatever"}'), /\[redacted\]/);
  assert.equal(liteRedact("LiteAPI returned 503"), "LiteAPI returned 503");
});

test("LiteAPI outranks the other suppliers and the sample catalogue", async () => {
  const { connectSuppliers } = await import("../src/server.js");
  clear();
  let s = connectSuppliers({
    LITEAPI_KEY: "sand_x",
    EXPEDIA_RAPID_API_KEY: "k", EXPEDIA_RAPID_SECRET: "s",
    BOOKING_DEMAND_TOKEN: "t", BOOKING_DEMAND_AFFILIATE: "1",
    PALTAS_SAMPLE_SUPPLY: "1",
  });
  assert.equal(s.name, "liteapi");
  assert.equal(s.sandbox, true, "a sandbox key must survive the boot path");

  clear();
  assert.equal(connectSuppliers({ LITEAPI_KEY: "" }), null,
    "an empty key must not count as a configured supplier");
  clear();
});

/* ================================================================ 10
 * THE LITEAPI BOOKING LIFECYCLE, OFFLINE.
 *
 * The live sandbox flow is exercised separately and by hand. These are the
 * deterministic checks that belong in a suite: the request bodies, the
 * identifier that everything hangs on, and the refusals that stop money moving
 * where it should not.
 * ================================================================ */

const { offersFor, cancellationFrom, newClientReference, wireBooking } =
  await import("../src/suppliers/liteapi.ts");

const L_HOTEL = {
  hotelId: "lp1",
  roomTypes: [
    { offerId: "OFFER-A", name: "Standard Twin", rates: [
        { rateId: "r1", boardName: "Breakfast Included", maxOccupancy: 2,
          retailRate: { total: [{ amount: 210, currency: "USD" }] },
          cancellationPolicies: { refundableTag: "RFN", cancelPolicyInfos: [
            { cancelTime: "2026-11-25 12:00:00", amount: 0, currency: "USD", type: "amount", timezone: "GMT" }] } },
        /* identical to the first in every way a guest can see */
        { rateId: "r2", boardName: "Breakfast Included", maxOccupancy: 2,
          retailRate: { total: [{ amount: 210, currency: "USD" }] },
          cancellationPolicies: { refundableTag: "RFN", cancelPolicyInfos: [] } },
    ] },
    { offerId: "OFFER-B", name: "Deluxe King", rates: [
        { rateId: "r3", boardName: "Room Only",
          retailRate: { total: [{ amount: 180, currency: "USD" }] },
          cancellationPolicies: { refundableTag: "NRFN" } },
    ] },
    /* No offerId: cannot be prebooked, so it must not be offered. */
    { name: "Phantom Suite", rates: [
        { rateId: "r4", retailRate: { total: [{ amount: 10, currency: "USD" }] } } ] },
  ],
};

test("offersFor omits anything that cannot actually be booked", () => {
  const offers = offersFor(L_HOTEL);
  assert.ok(offers.every((o) => o.offerId),
    "an offer with no offerId was listed — prebook would fail on it, so showing " +
    "it offers something that cannot be taken");
  assert.ok(!offers.some((o) => o.roomName === "Phantom Suite"));
  /* Cheapest first, because that is the order somebody shops in. */
  assert.deepEqual(offers.map((o) => o.price), [18000, 21000]);
  assert.equal(offers[0].offerId, "OFFER-B");
  assert.equal(offers[0].refundable, false);
  assert.equal(offers[1].refundable, true);
});

test("offers a guest could not tell apart are collapsed", () => {
  /*
   * A live sandbox search for one Nairobi hotel returned 200 offers, most of
   * them the same room, board, price and terms by a different supplier routing.
   * Twelve identical rows is not a choice, it is a wall.
   */
  const offers = offersFor(L_HOTEL);
  assert.equal(offers.length, 2,
    "two rates on OFFER-A are identical in room, board, price and refundability " +
    "and should appear once");
  /* But a real difference must survive. */
  const varied = offersFor({ roomTypes: [{ offerId: "X", name: "Room", rates: [
    { retailRate: { total: [{ amount: 100, currency: "USD" }] }, boardName: "Room Only",
      cancellationPolicies: { refundableTag: "RFN" } },
    { retailRate: { total: [{ amount: 100, currency: "USD" }] }, boardName: "Room Only",
      cancellationPolicies: { refundableTag: "NRFN" } },
  ] }] });
  assert.equal(varied.length, 2, "refundable and non-refundable at the same price are a real choice");
});

test("cancellation deadlines keep their timezone and their minor units", () => {
  const policies = cancellationFrom(L_HOTEL.roomTypes[0].rates[0]);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].until, "2026-11-25 12:00:00");
  /* The timezone is part of the deadline, so it is never dropped or localised. */
  assert.equal(policies[0].timezone, "GMT");
  assert.equal(policies[0].amount, 0);
  /* No policy is an empty list, never "free cancellation". */
  assert.deepEqual(cancellationFrom({}), []);
  assert.deepEqual(cancellationFrom({ cancellationPolicies: {} }), []);
});

test("a client reference is always unique, because a repeat is refused", () => {
  /*
   * LiteAPI answers a repeated clientReference with 4005 "duplicate booking
   * attempt". That is the behaviour that stops a retry becoming two bookings,
   * and it means a fixed reference turns every second attempt into a failure
   * that reads like a broken integration.
   */
  const a = newClientReference(), b = newClientReference();
  assert.notEqual(a, b);
  assert.match(a, /^PALTAS-/);
});

test("a booking is wired into this service's shape, in minor units", () => {
  const b = wireBooking({
    bookingId: "BK1", clientReference: "PALTAS-x", status: "CONFIRMED",
    hotelConfirmationCode: "HC9", hotel: { hotelId: "lp1", name: "Hotel One" },
    checkin: "2026-12-04", checkout: "2026-12-06", price: 122.86, currency: "usd",
    cancellationPolicies: { refundableTag: "RFN", cancelPolicyInfos: [
      { cancelTime: "2026-12-01 00:00:00", amount: 0, currency: "USD", timezone: "GMT" }] },
    createdAt: "2026-09-13T00:00:00Z",
  }, true);
  assert.equal(b.price, 12286, "money must arrive in minor units like everything else");
  assert.equal(b.currency, "USD");
  assert.equal(b.hotelName, "Hotel One");
  assert.equal(b.refundable, true);
  assert.equal(b.cancellation.length, 1);
  /* The stamp that stops a sandbox booking being shown as travel. */
  assert.equal(b.sandbox, true);
  assert.equal(b.source, "liteapi");
  assert.throws(() => wireBooking({}, true), /returned no booking/);
});

test("prebook sends the offerId and keeps payment secrets to itself", async () => {
  let sent = null;
  const a = liteApi({ apiKey: "sand_x", fetchImpl: async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: {
      prebookId: "PB1", offerId: "OFFER-A", hotelId: "lp1",
      checkin: "2026-12-04", checkout: "2026-12-06", price: 210, currency: "USD",
      priceDifferencePercent: 0,
      /* The supplier sends these. They must not come back out. */
      secretKey: "sk_live_should_never_escape", transactionId: "tx_123",
    } }) };
  } });

  const held = await a.prebook({ offerId: "OFFER-A" });
  assert.match(sent.url, /\/rates\/prebook$/);
  assert.equal(sent.body.offerId, "OFFER-A");
  assert.equal(sent.body.usePaymentSdk, false);
  assert.equal(held.prebookId, "PB1");
  assert.equal(held.price, 21000);
  assert.equal(held.sandbox, true);
  /* A value that never leaves here cannot leak from here. */
  const json = JSON.stringify(held);
  assert.ok(!json.includes("sk_live_should_never_escape"), "a payment secret escaped prebook");
  assert.ok(!json.includes("tx_123"), "a transaction id escaped prebook");
  await assert.rejects(() => a.prebook({}), /offer id is needed/i);
});

test("a price that moved between search and prebook is surfaced, not swallowed", async () => {
  /*
   * The whole reason prebook exists. A guest who saw one number and is charged
   * another has been misled by this service, not by the hotel — so the
   * difference is returned for a caller to stop on.
   */
  const a = liteApi({ apiKey: "sand_x", fetchImpl: async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ data: {
      prebookId: "PB2", price: 260, currency: "USD", priceDifferencePercent: 23.8,
      cancellationChanged: true } }) }) });
  const held = await a.prebook({ offerId: "O" });
  assert.equal(held.priceDifferencePercent, 23.8);
  assert.equal(held.cancellationChanged, true);
});

test("booking sends ACC_CREDIT_CARD and only ever that", async () => {
  let sent = null;
  const a = liteApi({ apiKey: "sand_x", fetchImpl: async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: {
      bookingId: "BK9", status: "CONFIRMED", clientReference: sent.clientReference,
      hotel: { hotelId: "lp1", name: "Hotel One" }, price: 210, currency: "USD" } }) };
  } });

  const b = await a.book({ prebookId: "PB1",
    holder: { firstName: "Test", lastName: "Guest", email: "t@paltas.io" } });
  assert.equal(sent.payment.method, "ACC_CREDIT_CARD",
    "the only payment method this adapter may send is the sandbox simulation");
  assert.equal(sent.prebookId, "PB1");
  /* Generated, because LiteAPI refuses a repeat. */
  assert.match(sent.clientReference, /^PALTAS-/);
  /* A guest list is built from the holder when none is given — the hotel needs a
     name against the room, not an empty array. */
  assert.equal(sent.guests.length, 1);
  assert.equal(sent.guests[0].occupancyNumber, 1);
  assert.equal(b.bookingId, "BK9");
  assert.equal(b.sandbox, true);
});

test("a production key cannot complete a booking at all", async () => {
  /*
   * Two different guards, and this is the adapter's. PALTAS has no payment
   * provider, and the only method it sends is a sandbox simulation — so booking
   * against a live key would be taking a room without paying for it. That is
   * somebody else's money.
   */
  const prod = liteApi({ apiKey: "prod_real", fetchImpl: async () => {
    throw new Error("the network must never be reached on this path");
  } });
  await assert.rejects(
    () => prod.book({ prebookId: "PB", holder: { firstName: "a", lastName: "b", email: "c@d.e" } }),
    /will not complete a live LiteAPI booking/);
});

test("booking refuses without the details a hotel needs to check somebody in", async () => {
  const a = liteApi({ apiKey: "sand_x", fetchImpl: async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ data: { bookingId: "x" } }) }) });
  await assert.rejects(() => a.book({ prebookId: "PB" }), /needs a firstName/);
  await assert.rejects(() => a.book({ prebookId: "PB", holder: { firstName: "A" } }), /needs a lastName/);
  await assert.rejects(() => a.book({ prebookId: "PB", holder: { firstName: "A", lastName: "B" } }), /needs a email/);
  await assert.rejects(() => a.book({}), /prebook id is needed/i);
});

test("a cancellation that still charges says so", async () => {
  /*
   * LiteAPI answers a non-refundable cancellation with CANCELLED_WITH_CHARGES, a
   * fee and a zero refund. Flattening that into "cancelled" would tell somebody
   * they had their money back when they did not — verified against the live
   * sandbox, which charged USD 127.41 and refunded nothing.
   */
  const a = liteApi({ apiKey: "sand_x", fetchImpl: async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ data: {
      bookingId: "BK9", status: "CANCELLED_WITH_CHARGES",
      cancellation_fee: 127.41, refund_amount: 0, currency: "USD" } }) }) });
  const c = await a.cancel({ bookingId: "BK9" });
  assert.equal(c.status, "CANCELLED_WITH_CHARGES");
  assert.equal(c.charged, true);
  assert.equal(c.cancellationFee, 12741);
  assert.equal(c.refund, 0);
  await assert.rejects(() => a.cancel({}), /booking id is needed/i);
});

test("rooms refuses without a hotel and without dates", async () => {
  const a = liteApi({ apiKey: "sand_x", fetchImpl: async () => {
    throw new Error("the network must not be reached");
  } });
  await assert.rejects(() => a.rooms({ checkIn: "2026-12-04", checkOut: "2026-12-06" }), /hotel id is needed/i);
  await assert.rejects(() => a.rooms({ hotelId: "lp1" }), /check-in and a check-out/);
});

/* ================================================================ 11
 * DIRECT STRIPE ELEMENTS, AND THE WALL BETWEEN ENVIRONMENTS.
 *
 * LiteAPI owns the Stripe account: "you never need your own Stripe account or
 * your own server-side Stripe integration — the PaymentIntent is created on
 * LiteAPI's Stripe platform when you call the prebook endpoint." So this is not
 * a payment system of PALTAS's own, and these tests are mostly about it not
 * quietly becoming one.
 * ================================================================ */

const PKS = { stripePkTest: "pk_test_FIXTURE", stripePkLive: "pk_live_FIXTURE" };

function prebookStub(extra) {
  let sent = null;
  const a = liteApi({ apiKey: extra.apiKey, ...PKS, fetchImpl: async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: {
      prebookId: "PB1", transactionId: "tr_ct_FIXTURE",
      secretKey: "pi_3FIXTURE_secret_abc", price: 210, currency: "USD",
      priceDifferencePercent: 0 } }) };
  } });
  return { a, sent: () => sent };
}

test("a sandbox key can never hand out a live publishable key", async () => {
  /*
   * The whole of the environment separation on the payment side, and it is not a
   * flag anybody can set wrongly — it is derived from the API key's own prefix.
   * A pk_live_ mounted against a sandbox PaymentIntent would fail confusingly;
   * the reverse would take a real card into a test account.
   */
  const { a } = prebookStub({ apiKey: "sand_fixture" });
  const held = await a.prebook({ offerId: "O", usePaymentSdk: true });
  assert.equal(held.payment.publishableKey, "pk_test_FIXTURE");
  assert.equal(held.payment.environment, "sandbox");
  assert.equal(held.sandbox, true);
});

test("a production key can never hand out a test publishable key", async () => {
  const { a } = prebookStub({ apiKey: "prod_fixture" });
  const held = await a.prebook({ offerId: "O", usePaymentSdk: true });
  assert.equal(held.payment.publishableKey, "pk_live_FIXTURE");
  assert.equal(held.payment.environment, "live");
  assert.equal(held.sandbox, false);
});

test("prebook hands over a Stripe client secret and Stripe's own script", async () => {
  const { a, sent } = prebookStub({ apiKey: "sand_fixture" });
  const held = await a.prebook({ offerId: "O", usePaymentSdk: true });

  assert.equal(sent().body.usePaymentSdk, true);
  /* A client secret belongs in the browser — that is what it is for — and it is
     scoped to this one payment. */
  assert.equal(held.payment.clientSecret, "pi_3FIXTURE_secret_abc");
  assert.equal(held.payment.transactionId, "tr_ct_FIXTURE");
  /* Stripe directly, not LiteAPI's hosted wrapper. */
  assert.equal(held.payment.stripeJsUrl, "https://js.stripe.com/v3/");

  /*
   * The pair must arrive together. LiteAPI: "Save transactionId and prebookId
   * together, immediately. Each prebook call generates a new pair, and they
   * cannot be retrieved later." Losing one means a guest who paid for a room
   * that was never booked and cannot be found.
   */
  assert.ok(held.prebookId && held.payment.transactionId);
});

test("no payment session is returned when none was asked for", async () => {
  /* A value with no use cannot leak. On the ACC_CREDIT_CARD path nothing in a
     browser has any business holding a payment session. */
  const { a } = prebookStub({ apiKey: "sand_fixture" });
  const held = await a.prebook({ offerId: "O" });
  assert.equal(held.payment, undefined);
});

test("a missing publishable key means browse-only, never a wrong-environment fallback", async () => {
  /*
   * LiteAPI issues these through an account manager rather than their dashboard,
   * so a working API key with no payment key is a legitimate state. It must
   * degrade to "cannot take payment" rather than to the other environment's key.
   */
  let sent = null;
  const a = liteApi({ apiKey: "prod_fixture", stripePkTest: "pk_test_FIXTURE",
    fetchImpl: async (url, opts) => {
      sent = JSON.parse(opts.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: {
        prebookId: "PB", transactionId: "tr_x", secretKey: "pi_x_secret_y",
        price: 1, currency: "USD" } }) };
    } });
  assert.equal(a.describe().canTakePayment, false,
    "a client must be able to tell BEFORE it offers somebody a pay button");
  const held = await a.prebook({ offerId: "O", usePaymentSdk: true });
  assert.equal(held.payment.publishableKey, null,
    "a production prebook fell back to the TEST publishable key");
});

test("a customer booking is never settled with ACC_CREDIT_CARD on a live key", async () => {
  /*
   * ACC_CREDIT_CARD charges the PARTNER's card in production — "the partner bears
   * full financial responsibility for the transaction". Used for customer
   * bookings it would bill PALTAS for every room a visitor took, with nothing
   * collected from the traveller.
   */
  let body = null;
  const a = liteApi({ apiKey: "prod_fixture", ...PKS, fetchImpl: async (url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: {
      bookingId: "B", status: "CONFIRMED", hotel: { hotelId: "h", name: "H" },
      price: 210, currency: "USD" } }) };
  } });

  await a.book({ prebookId: "PB", transactionId: "tr_paid",
    holder: { firstName: "A", lastName: "B", email: "a@b.c" } });
  assert.equal(body.payment.method, "TRANSACTION_ID");
  assert.equal(body.payment.transactionId, "tr_paid");
  assert.ok(!JSON.stringify(body).includes("ACC_CREDIT_CARD"),
    "ACC_CREDIT_CARD appears in a live customer booking");
});

test("PALTAS creates no Stripe object of its own, anywhere", () => {
  /*
   * The instruction was not to build a second payment system. This is the check
   * that it was not built by accident: the backend may name Stripe in prose and
   * hand over a client secret, but it must not depend on the Stripe SDK, create a
   * PaymentIntent, or hold a secret key of its own.
   */
  /*
   * This originally asserted the REPO had no Stripe dependency. That was true
   * when the only payment path was LiteAPI's, and it became wrong the moment
   * PALTAS added Stripe Connect so member companies could collect from their own
   * customers — a different rail into a different account, legitimately needing
   * the SDK.
   *
   * The claim that actually matters was never "PALTAS has no Stripe". It is
   * "the LITEAPI flow creates no Stripe object of its own", because the
   * PaymentIntent for a hotel room is created on LiteAPI's platform and a second
   * one would charge the guest twice. So the assertion is scoped to the file it
   * is about.
   */
  const src = sourceText("suppliers", "liteapi.js");
  assert.ok(!/from ["']stripe["']|require\(["']stripe["']\)/.test(src),
    "the LiteAPI adapter imports the Stripe SDK — it must not: the PaymentIntent " +
    "is created on LiteAPI's platform, and anything created here would be a " +
    "second charge");
  assert.ok(!/new Stripe\(|require\(["']stripe|from ["']stripe/.test(src),
    "the adapter instantiates Stripe server-side");
  /* And it must never hold a Stripe SECRET key — only the client secret, which
     is a different thing and belongs in a browser. */
  assert.ok(!/sk_live_|sk_test_|STRIPE_SECRET/.test(src),
    "a Stripe secret key appears in the adapter");
});

test("the real LiteAPI adapter declares a public identity of its own", () => {
  /*
   * ANCHORED TO THE REAL ADAPTER, NOT A STUB.
   *
   * Everything that keeps the wholesaler's name out of public responses hangs
   * off these two fields. A stub can be written to declare them; what matters
   * is that the adapter actually shipped does, so this asks the real one.
   *
   * The opposite case is asserted alongside: Booking.com and Expedia are
   * consumer brands whose licences require their name on the inventory, and
   * they must NOT declare a public identity — otherwise this change would
   * quietly strip an attribution somebody is contractually owed.
   */
  const a = liteApi({ apiKey: "prod_test_key_not_real", baseUrl: "https://example.invalid" });
  assert.equal(a.publicName, "partner", "the wholesaler would be named on every public row");
  assert.match(a.publicLabel, /hotel partners/, "the attribution line would name the wholesaler");
  assert.equal(a.name, "liteapi", "the adapter's internal identity must not change");
  assert.equal(a.label, "LiteAPI", "an operator must still be told which supplier is connected");

  register(a);
  assert.equal(status().name, "liteapi", "the booking key changed, which orphans stored bookings");
  assert.equal(status().publicName, "partner");

  /* A brand that must stay named declares neither. */
  const b = bookingDemand({ token: "t", affiliateId: "a", baseUrl: "https://example.invalid" });
  assert.ok(!b.publicName, "Booking.com was anonymised, which strips a required attribution");
  assert.ok(!b.publicLabel, "Booking.com's attribution label was replaced");
});
