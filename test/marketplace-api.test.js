/* ====================================================================== *
 * THE PUBLIC MARKETPLACE, AND THE WALL AROUND IT.
 *
 * This is the only endpoint in the service a stranger may read, so it is the
 * only one where a mistake is immediately public. Every test below is some
 * version of one question: can somebody with no account see something nobody
 * agreed to publish?
 *
 * `status: "LIVE"` is the whole of the consent model. An agent moving a listing
 * out of DRAFT is the single act in this schema that means "show this to the
 * market", so it is the only thing this endpoint honours.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_marketplace";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret-that-is-long-enough-to-pass";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping marketplace tests";
let createApp, db, pg;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.js"));
    ({ createApp } = await import("../src/server.js"));
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = String(e && e.message);
    skip = /did not initialize|locate the Query Engine|generate/.test(m)
      ? "RUN `npx prisma generate` FIRST"
      : "database unreachable: " + m.slice(0, 90);
  }
}

let server, base, pool;
test.before(async () => {
  if (skip) return;
  pool = poolInSchema(pg, DB, SCHEMA);
  await freshSchema(pool, SCHEMA);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  await seed();
});
test.after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
});

/** No cookie, ever — that is the point of these tests. */
async function get(path) {
  const res = await fetch(base + path);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not always JSON */ }
  return { status: res.status, json, text, cache: res.headers.get("cache-control") };
}

let ids = {};

async function seed() {
  const make = async (name, products, transfer) => {
    const o = await db.organization.create({
      data: {
        name, country: "ke",
        subscription: { create: { status: "ACTIVE" } },
        verification: { create: { status: "COMPLETE" } },
        workspace: { create: { status: "ACTIVE" } },
        entitlements: { create: products.map((p) => ({ product: p })) },
      },
    });
    const site = await db.site.create({
      data: { orgId: o.id, name: name + " Court", city: "Nairobi", country: "KE" } });
    if (transfer) {
      await db.hotelService.create({
        data: { orgId: o.id, name: "Airport transfer", kind: "Transfer", active: true,
                /* The hotel charges for it. `chargeable` is the only thing in the
                   schema that can answer free-or-paid, so the test pins it. */
                chargeable: true } });
    }
    return { o, site };
  };

  const agent = await make("Alma Lets", ["AGENT_HOST"], false);
  const hotel = await make("Sunrise Hotel", ["AGENT_HOST", "HOTEL_MANAGEMENT"], true);
  ids.agentOrg = agent.o.id;

  const u1 = await db.unit.create({
    data: { orgId: agent.o.id, siteId: agent.site.id, ref: "12B",
            buildingName: "Riverside Court", kind: "TWO_BED", sqm: 82, floor: 3 } });
  const u2 = await db.unit.create({
    data: { orgId: hotel.o.id, siteId: hotel.site.id, ref: "PH1",
            buildingName: "Sunrise Tower", kind: "THREE_BED", sqm: 140, floor: 12 } });

  /* Two published, two not. The two that are not carry the secrets. */
  await db.listing.create({
    data: { orgId: agent.o.id, unitId: u1.id, title: "Two-bed, Riverside Court",
            kind: "LONG_LET", price: 9_600_000n, currency: "KES", status: "LIVE",
            ownerName: "Jane Mwangi", mandate: "Sole agency, 8%",
            note: "Owner will take 10% less" } });
  await db.listing.create({
    data: { orgId: hotel.o.id, unitId: u2.id, title: "Penthouse suite, Sunrise",
            kind: "SHORT_STAY", price: 1_450_000n, currency: "KES", status: "LIVE" } });
  await db.listing.create({
    data: { orgId: agent.o.id, unitId: u1.id, title: "SECRET DRAFT",
            kind: "FOR_SALE", price: 5_500_000_000n, status: "DRAFT" } });
  await db.listing.create({
    data: { orgId: agent.o.id, unitId: u1.id, title: "Withdrawn one",
            kind: "FOR_SALE", price: 1n, status: "WITHDRAWN" } });

  /* A development nobody published. There is no publish flag on a Project. */
  await db.project.create({
    data: { orgId: agent.o.id, name: "CONFIDENTIAL Karen Ridge",
            budget: 120_000_000_000n } });
}

/* ================================================================ */

test("a stranger with no account can read published listings", { skip }, async () => {
  const r = await get("/marketplace/listings");
  assert.equal(r.status, 200, r.text.slice(0, 160));
  assert.equal(r.json.listings.length, 2,
    "expected the two LIVE listings, got " + r.json.listings.length);
  assert.equal(r.json.source, "live-listings");
  assert.match(r.cache || "", /public/,
    "public inventory should be briefly cacheable");
});

test("only LIVE is public — DRAFT and WITHDRAWN are not", { skip }, async () => {
  /*
   * The consent model in one assertion. A DRAFT is an agent still working; a
   * WITHDRAWN listing is one they took down. Showing either is publishing
   * something nobody agreed to publish.
   */
  const r = await get("/marketplace/listings");
  const body = r.text;
  assert.ok(!body.includes("SECRET DRAFT"), "a DRAFT listing was published");
  assert.ok(!body.includes("Withdrawn one"), "a WITHDRAWN listing was published");

  /* And asking for FOR_SALE — which only the hidden two are — returns none. */
  const forSale = await get("/marketplace/listings?kind=for_sale");
  assert.equal(forSale.json.count, 0,
    "a kind filter reached listings that are not LIVE");
});

test("nothing private about the owner or the deal is returned", { skip }, async () => {
  const r = await get("/marketplace/listings");
  const body = r.text;
  /* A named private individual. The COMPANY is returned; the owner is not. */
  assert.ok(!body.includes("Jane Mwangi"), "the owner's name was published");
  /* The commercial terms between agent and owner. */
  assert.ok(!body.includes("Sole agency"), "the mandate was published");
  /* And the agent's own remarks, which is the worst of the three. */
  assert.ok(!body.includes("10% less"), "an internal note was published");
  /* No internal identifier needs to reach a browser. */
  assert.ok(!body.includes(ids.agentOrg), "an orgId was published");
  /* The company offering it IS returned — a marketplace needs that. */
  assert.ok(body.includes("Alma Lets"), "the offering company should be named");
});

test("a development is never published, because nothing marks one as publishable",
  { skip }, async () => {
  /*
   * A Project has a stage and no publish flag, so there is no way to tell one
   * its owner wants advertised from one they are quietly costing. The
   * "New developments" section shows an empty state until somebody decides what
   * publishing a development means.
   */
  const r = await get("/marketplace/listings");
  assert.ok(!r.text.includes("CONFIDENTIAL"), "a development project was published");
});

test("no rating, no image, no review is invented", { skip }, async () => {
  /*
   * None of the three exists on a Listing anywhere in this schema. A star
   * rating invented here would be the most quietly corrosive thing on the
   * page, because every visitor would believe a guest left it.
   */
  const r = await get("/marketplace/listings");
  for (const field of ["rating", "stars", "reviews", "image", "photo"]) {
    assert.ok(!(field in (r.json.listings[0] || {})),
      `the endpoint returns a "${field}" that the database does not have`);
  }
  assert.doesNotMatch(r.text, /"rating"|"stars"|"image"/,
    "an invented field reached the response");
});

test("the filters answer honestly, and a bad one is refused", { skip }, async () => {
  const cases = [
    ["?kind=short_stay", 1], ["?kind=long_let", 1], ["?kind=for_sale", 0],
    ["?transfer=true", 1], ["?hotel=true", 1],
    ["?city=Nairobi", 2], ["?city=Mombasa", 0],
  ];
  for (const [q, expected] of cases) {
    const r = await get("/marketplace/listings" + q);
    assert.equal(r.status, 200, q + " → " + r.status);
    assert.equal(r.json.count, expected, `${q} returned ${r.json.count}, expected ${expected}`);
  }
  /* An unknown kind is a 400 naming the options, not a silent everything. */
  const bad = await get("/marketplace/listings?kind=nonsense");
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /short_stay/);
});

test("airport transfer is a fact about the company, not a claim", { skip }, async () => {
  /*
   * True only when the company offering the listing runs a transfer service
   * that is switched ON. It is computed per request from HotelService, never
   * stored on the listing, so it cannot drift away from the truth.
   */
  const r = await get("/marketplace/listings");
  const hotel = r.json.listings.find((l) => l.offeredBy === "Sunrise Hotel");
  const agent = r.json.listings.find((l) => l.offeredBy === "Alma Lets");
  assert.equal(hotel.transfer, true, "the hotel with an active transfer service says false");
  assert.equal(agent.transfer, false, "a letting agent with no transfer service says true");
  assert.equal(hotel.hotel, true);
  assert.equal(agent.hotel, false);
});

test("the page size is capped however large a limit is asked for", { skip }, async () => {
  const r = await get("/marketplace/listings?limit=100000");
  assert.equal(r.status, 200);
  assert.ok(r.json.listings.length <= 48,
    "the cap can be raised by asking, which is how one request costs a minute");
});

test("free or paid comes from the service's own chargeable flag", { skip }, async () => {
  /*
   * The homepage offers Free transfer and Paid transfer as filters, and the only
   * field in the schema that can answer them is HotelService.chargeable — set by
   * the property inside Hotel Management. This checks the endpoint reports it
   * rather than guessing, and that a listing with NO transfer service says
   * "not applicable" instead of "free".
   */
  const r = await get("/marketplace/listings");
  const hotel = r.json.listings.find((l) => l.offeredBy === "Sunrise Hotel");
  const agent = r.json.listings.find((l) => l.offeredBy === "Alma Lets");

  assert.equal(hotel.transferFree, false,
    "the hotel's transfer is chargeable, so transferFree must be false");
  assert.equal(agent.transferFree, null,
    "a company with no transfer service must say null, not false — 'we do not " +
    "know' and 'it costs money' are different answers");

  /* And the filter narrows on it. */
  const paid = await get("/marketplace/listings?transferFree=false");
  assert.ok(paid.json.listings.every((l) => l.transferFree === false),
    "?transferFree=false returned a listing whose transfer is not chargeable");
  assert.ok(paid.json.listings.some((l) => l.offeredBy === "Sunrise Hotel"),
    "?transferFree=false dropped the one company that charges for a transfer");

  const free = await get("/marketplace/listings?transferFree=true");
  assert.equal(free.json.listings.length, 0,
    "nothing seeded offers a free transfer, so this must be empty rather than " +
    "falling back to every listing");
});

test("direction is not answered, because nothing records it", { skip }, async () => {
  /*
   * A guest wants to know whether they will be collected on arrival or dropped
   * off on departure. HotelService has a name, a kind, an opening time, a
   * capacity and a chargeable flag — and nothing that says which way a car goes.
   *
   * So the endpoint must not grow a field that implies it knows. This is the
   * test that fails if somebody adds `transferWay: "both"` with a default.
   */
  const r = await get("/marketplace/listings");
  for (const l of r.json.listings) {
    const invented = Object.keys(l).filter((k) =>
      /^(way|direction|transferWay|transferDirection|pickup|dropoff|dropOff)$/i.test(k));
    assert.deepEqual(invented, [],
      "the public listing claims to know a transfer's direction: " + invented.join(", ") +
      ". Nothing in the schema records it, so the value can only be a default " +
      "dressed up as a fact.");
  }
});
