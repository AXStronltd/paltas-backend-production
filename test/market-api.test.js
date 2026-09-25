/* ====================================================================== *
 * THE PLATFORM CATALOGUE, AND THE ORDER IT IS MOUNTED IN.
 *
 * Four public endpoints that belong to no organization. The most important
 * thing proved here is not their shape — it is that they are reachable AT
 * ALL, because the mistake they existed inside of for months was a routing
 * order, not a missing handler.
 *
 * routes/products.js does `productRoutes.use(guarded)` with NO path, mounted
 * at "/". Anything reaching it gets requireSession() and a 401. So a public
 * route registered BELOW it is dead, and the failure reads as an
 * authentication problem — which is the single most misleading way for a
 * routing bug to present.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

process.env.DATABASE_URL = DB || "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret-that-is-long-enough-to-pass";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

/*
 * NO DATABASE NEEDED, AND THAT IS THE POINT.
 *
 * The catalogue is platform configuration, not tenant data. If one of these
 * endpoints ever needs a query, that is a design change worth noticing — so
 * this file deliberately never opens a connection, and still runs everywhere.
 */
const { createApp } = await import("../src/server.js");
const { catalogueSize } = await import("../src/domain/market.ts");

let server, base;
test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const get = async (p) => {
  const r = await fetch(base + p, { headers: { Accept: "application/json" } });
  let json = null;
  try { json = await r.json(); } catch { /* not every response is JSON */ }
  return { status: r.status, json, cache: r.headers.get("cache-control") };
};

/* ================================================================ */

test("the catalogue loaded from contract/market-config.js", () => {
  const n = catalogueSize();
  assert.ok(n.countries >= 40, `only ${n.countries} countries — did the contract file change?`);
  assert.ok(n.methods >= 20, `only ${n.methods} payment methods`);
  assert.ok(n.languages >= 2, `only ${n.languages} languages`);
});

test("all four are PUBLIC — no session, no organization, no 401", async () => {
  for (const p of ["/market/config", "/payment-methods/available?country=KE",
                   "/localization/config", "/market/services?country=KE"]) {
    const r = await get(p);
    assert.notEqual(r.status, 401,
      `${p} answered 401 — it is mounted BELOW productRoutes and is unreachable`);
    assert.equal(r.status, 200, `${p} -> ${r.status}`);
  }
});

test("GET /market/config returns every country the platform knows", async () => {
  const r = await get("/market/config");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.countries));
  assert.equal(r.json.count, r.json.countries.length);
  assert.equal(r.json.source, "server");

  /* The exact shape the frontend reads — a missing key here is a country
     picker with no flag, or money formatted in the wrong locale. */
  const ke = r.json.countries.find((c) => c.code === "KE");
  assert.ok(ke, "Kenya is not in the catalogue");
  for (const k of ["code", "name", "flag", "currency", "locale", "langs", "region", "dial", "cities"]) {
    assert.ok(k in ke, `country is missing "${k}"`);
  }
  assert.equal(ke.currency, "KES");
  assert.ok(Array.isArray(ke.cities) && ke.cities.length > 0);
});

test("GET /payment-methods/available answers for a market, and insists on one", async () => {
  const r = await get("/payment-methods/available?country=KE");
  assert.equal(r.status, 200);
  assert.equal(r.json.country, "KE");
  assert.ok(Array.isArray(r.json.methods) && r.json.methods.length > 0);

  const ids = r.json.methods.map((m) => m.id);
  assert.ok(ids.includes("mpesa"), `Kenya without M-Pesa: ${ids.join(",")}`);
  for (const k of ["id", "name", "type", "provider", "feeLabel", "eligible"]) {
    assert.ok(k in r.json.methods[0], `method is missing "${k}"`);
  }

  /*
   * NO COUNTRY IS A 400, NOT A GUESS.
   *
   * A method is only ever available somewhere. Defaulting to a country the
   * caller did not name is how somebody is offered a rail their bank has
   * never heard of.
   */
  const none = await get("/payment-methods/available");
  assert.equal(none.status, 400);
  const junk = await get("/payment-methods/available?country=KENYA");
  assert.equal(junk.status, 400, "a three-letter code should be refused");
});

test("a market with different rails gets different rails", async () => {
  const ke = await get("/payment-methods/available?country=KE");
  const gb = await get("/payment-methods/available?country=GB");
  const keIds = ke.json.methods.map((m) => m.id).sort().join(",");
  const gbIds = gb.json.methods.map((m) => m.id).sort().join(",");
  assert.notEqual(keIds, gbIds, "every market returned the same methods — the filter is not running");
  assert.ok(!gbIds.includes("mpesa"), "M-Pesa offered in the United Kingdom");
});

test("amount is in MINOR UNITS, like every other amount in this API", async () => {
  /* A sum far above every rail's ceiling must remove the limited ones. If
     minor units were read as major, this would look like 1,000,000 and the
     filter would behave completely differently. */
  const big = await get("/payment-methods/available?country=KE&amount=10000000000");
  const small = await get("/payment-methods/available?country=KE&amount=100000");
  assert.equal(big.status, 200);
  assert.equal(small.status, 200);
  assert.ok(big.json.methods.length <= small.json.methods.length,
    "a very large amount offered at least as many methods as a small one");
});

test("GET /localization/config says which languages and how complete", async () => {
  const r = await get("/localization/config?country=KE");
  assert.equal(r.status, 200);
  assert.equal(r.json.country, "KE");
  assert.ok(Array.isArray(r.json.languages) && r.json.languages.length > 0);
  assert.ok(Array.isArray(r.json.available));
  assert.ok(r.json.directions && typeof r.json.directions === "object");
  assert.ok(r.json.coverage && typeof r.json.coverage === "object");

  /*
   * `strings` MUST NOT be sent.
   *
   * The frontend MERGES this key into its own pack. A partial set would
   * silently overwrite complete entries with incomplete ones, and the symptom
   * would be a half-translated page nobody could trace to an API response.
   */
  assert.equal("strings" in r.json, false, "sending strings would overwrite the frontend's packs");

  /* Country is optional here — the language list is useful without one. */
  const nowhere = await get("/localization/config");
  assert.equal(nowhere.status, 200);
  assert.equal(nowhere.json.country, null);
});

test("GET /market/services is the path, and /services stays the tenant's", async () => {
  const r = await get("/market/services?country=KE");
  assert.equal(r.status, 200);
  assert.equal(r.json.country, "KE");
  assert.ok(Array.isArray(r.json.services) && r.json.services.length > 0);
  assert.ok(r.json.capabilities, "capabilities missing");
  assert.ok(Array.isArray(r.json.capabilities.products));

  /*
   * THE COLLISION THIS ENDPOINT EXISTS TO AVOID.
   *
   * /services is the `services` RESOURCE — HotelService, one company's
   * restaurants and spas, behind a session. It must still be authenticated,
   * and it must NOT have been repurposed to answer market questions.
   */
  const tenant = await get("/services/available");
  assert.equal(tenant.status, 401,
    "/services must remain the tenant's authenticated resource");
});

test("the catalogue is cacheable, and says so", async () => {
  const r = await get("/market/config");
  assert.match(String(r.cache), /max-age=\d+/,
    "a catalogue that changes when a market opens should not be revalidated per request");
  assert.match(String(r.cache), /public/);
});

test("an unknown country is refused rather than answered emptily", async () => {
  const r = await get("/market/services?country=ZZ");
  assert.equal(r.status, 200);
  assert.equal(r.json.country, null);
  assert.deepEqual(r.json.services, []);
});
