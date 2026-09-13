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
} from "../src/domain/supply.js";
import {
  expediaRapid, signature, authorizationHeader, nightsBetween, lowestTotal,
  redact, fromEnv,
} from "../src/suppliers/expedia-rapid.js";

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
  assert.match(r.supplier.why, /No accommodation supplier is connected/);
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
  await import("../src/suppliers/booking-demand.js");

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
  await import("../src/suppliers/sample-catalogue.js");

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
    token: "sand_39ae6723-474f-401c-af75-0c5e0f4bbfdc",
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
    BOOKING_DEMAND_TOKEN: "sand_39ae6723-474f-401c-af75-0c5e0f4bbfdc",
    BOOKING_DEMAND_AFFILIATE: "12345",
  });
  assert.equal(s.sandbox, true,
    "the sandbox token survived the environment without being marked");
});
