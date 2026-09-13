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
let createApp, db, pg, supply;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.js"));
    ({ createApp } = await import("../src/server.js"));
    supply = await import("../src/domain/supply.js");
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


/* ====================================================================== *
 * A LICENSED SUPPLIER ALONGSIDE PALTAS'S OWN LISTINGS.
 *
 * The marketplace can also show a wholesaler's rooms. The requirement was to
 * add that WITHOUT altering how PALTAS's own listings work, and "without
 * altering" is not a thing to assert by reading the diff — so these tests pin
 * it against a live endpoint and a real database.
 *
 * Nothing here needs credentials. A stub supplier stands in for Expedia Rapid,
 * which is the point: the seam must behave identically whatever is behind it.
 * ====================================================================== */

/** A supplier that answers, so the two-array split can be observed. */
function stubSupplier({ name = "expedia-rapid", sandbox = false, offers = null, throws = null } = {}) {
  return {
    name, sandbox,
    describe() { return { name, connected: true, sandbox, capabilities: ["search"], why: "" }; },
    async search() {
      if (throws) throw new Error(throws);
      return { offers: offers || [{
        supplierRef: "111", title: "Nyali Beach Hotel", city: "Mombasa", country: "KE",
        place: "Mombasa Road", price: 70000, currency: "USD", nights: 7,
        refundable: true, rating: 8.6, ratingCount: 1423,
        image: "https://images.example/111.jpg",
      }] };
    },
  };
}

test("PALTAS's own listings are identical whether or not a supplier is connected",
  { skip }, async () => {
    /*
     * THE REGRESSION TEST FOR THE WHOLE FEATURE.
     *
     * `listings` is what PALTAS itself published. Adding a wholesaler must not
     * change one byte of it — not the rows, not the order, not the count, not a
     * single field on a single row. If a supplier can influence this array then
     * PALTAS's inventory and somebody else's have become entangled, and every
     * assurance the platform gives about who you are dealing with is weaker
     * than it looks.
     */
    supply.clear();
    const before = await get("/marketplace/listings?limit=48");

    supply.register(stubSupplier());
    const after = await get("/marketplace/listings?limit=48");

    try {
      assert.deepEqual(after.json.listings, before.json.listings,
        "connecting a supplier changed PALTAS's own listings");
      assert.equal(after.json.count, before.json.count);
      /* And the supplier's rooms did arrive — otherwise this passes vacuously
         by the supplier simply not working. */
      assert.ok(after.json.supply.length > 0,
        "the supplier returned nothing, so this test proved nothing");
    } finally {
      supply.clear();
    }
  });

test("supplier rooms never enter the listings array", { skip }, async () => {
  supply.register(stubSupplier());
  try {
    const r = await get("/marketplace/listings");
    for (const l of r.json.listings) {
      assert.equal(l.source, "paltas",
        `a row in "listings" is not PALTAS's: ${l.title} (${l.source})`);
      assert.equal(l.paltasOwned, true);
    }
    for (const o of r.json.supply) {
      assert.equal(o.paltasOwned, false);
      assert.equal(o.source, "expedia-rapid");
      assert.ok(o.supplier && o.supplier.name === "expedia-rapid",
        "every supplier row must name its supplier, because both suppliers' " +
        "terms require their content to be attributed");
    }
    /* No id can be ambiguous between the two. */
    const ids = new Set(r.json.listings.map((l) => l.id));
    for (const o of r.json.supply) {
      assert.ok(!ids.has(o.id), "a supplier id collides with a PALTAS listing id");
    }
  } finally { supply.clear(); }
});

test("a supplier outage leaves the marketplace working", { skip }, async () => {
  /*
   * The failure mode that matters most in production. A wholesaler being down
   * must not take the homepage with it — PALTAS's listings are what the visitor
   * came for, and they do not depend on Expedia being awake.
   */
  supply.clear();
  const healthy = await get("/marketplace/listings");

  supply.register(stubSupplier({ throws: "connect ETIMEDOUT 23.45.67.89:443" }));
  try {
    const r = await get("/marketplace/listings");
    assert.equal(r.status, 200, "a supplier outage must not become an error page");
    assert.deepEqual(r.json.listings, healthy.json.listings,
      "PALTAS's listings changed because a third party was unreachable");
    assert.deepEqual(r.json.supply, [], "a failed supplier must produce no rooms");
    assert.equal(r.json.suppliers.failed, true);
    assert.match(r.json.suppliers.why, /ETIMEDOUT/,
      "an empty shelf with no reason is indistinguishable from a full outage");
  } finally { supply.clear(); }
});

test("an empty supply array always says which of the three reasons it is", { skip }, async () => {
  /* 1. nothing connected */
  supply.clear();
  let r = await get("/marketplace/listings");
  assert.deepEqual(r.json.supply, []);
  assert.equal(r.json.suppliers.connected, false);
  assert.match(r.json.suppliers.why, /No accommodation supplier is connected/);

  /* 2. connected, nothing to offer */
  supply.register(stubSupplier({ offers: [] }));
  r = await get("/marketplace/listings");
  assert.equal(r.json.suppliers.connected, true);
  assert.equal(r.json.suppliers.failed, false);

  /* 3. connected and broken — covered above, checked here for the contrast */
  supply.register(stubSupplier({ throws: "boom" }));
  r = await get("/marketplace/listings");
  assert.equal(r.json.suppliers.connected, true);
  assert.equal(r.json.suppliers.failed, true);
  supply.clear();
});

test("a supplier's stay total is never served as a nightly rate", { skip }, async () => {
  supply.register(stubSupplier());
  try {
    const r = await get("/marketplace/listings");
    const o = r.json.supply[0];
    assert.equal(o.price, 70000);
    assert.equal(o.nights, 7);
    assert.equal(o.priceBasis, "stay",
      "a wholesaler quotes the whole stay and a PALTAS short-let quotes a " +
      "night; printed under one label the supplier looks seven times cheaper");
    assert.equal(o.perNight, 10000);
  } finally { supply.clear(); }
});

test("supplier content is never cached, and PALTAS's own still is", { skip }, async () => {
  /*
   * Both suppliers' terms restrict storing their rates, and a wholesale quote
   * is priced against live allocation anyway. A shared cache cannot hold half a
   * response, so the presence of supplier content makes the whole body
   * uncacheable.
   */
  supply.clear();
  const own = await get("/marketplace/listings");
  assert.match(own.cache, /max-age=60/, "PALTAS's own listings should still cache");

  supply.register(stubSupplier());
  try {
    const mixed = await get("/marketplace/listings");
    assert.ok(mixed.json.supply.length > 0);
    assert.match(mixed.cache, /no-store/,
      "a wholesaler's quote was served with a cache header");
  } finally { supply.clear(); }
});

test("a sandbox supplier is marked on every room it returns", { skip }, async () => {
  supply.register(stubSupplier({ sandbox: true }));
  try {
    const r = await get("/marketplace/listings");
    assert.equal(r.json.suppliers.sandbox, true);
    for (const o of r.json.supply) {
      assert.equal(o.supplier.sandbox, true,
        "a test rate presented as bookable is the worst failure available here");
    }
  } finally { supply.clear(); }
});

test("no supplier credential can reach a browser", { skip }, async () => {
  /* The status route and the marketplace envelope both describe the supplier.
     Neither may carry the key, and there is no field in the shape that could. */
  const { expediaRapid } = await import("../src/suppliers/expedia-rapid.js");
  supply.register(expediaRapid({
    apiKey: "LIVEKEY-should-never-appear", sharedSecret: "LIVESECRET-should-never-appear",
  }));
  try {
    for (const path of ["/marketplace/listings", "/marketplace/suppliers"]) {
      const r = await get(path);
      assert.ok(!r.text.includes("LIVEKEY-should-never-appear"),
        `the API key appears in the response from ${path}`);
      assert.ok(!r.text.includes("LIVESECRET-should-never-appear"),
        `the shared secret appears in the response from ${path}`);
    }
  } finally { supply.clear(); }
});

test("the supplier status route says whether one is connected", { skip }, async () => {
  supply.clear();
  let r = await get("/marketplace/suppliers");
  assert.equal(r.status, 200);
  assert.equal(r.json.suppliers[0].connected, false);

  supply.register(stubSupplier({ name: "expedia-rapid" }));
  r = await get("/marketplace/suppliers");
  assert.equal(r.json.suppliers[0].connected, true);
  assert.equal(r.json.suppliers[0].name, "expedia-rapid");
  supply.clear();
});

test("nothing a supplier returns is written to the database", { skip }, async () => {
  /*
   * There is no model for supplier inventory and there must not be one. Both
   * suppliers restrict storing their content, and a saved wholesale rate is a
   * price a guest cannot book by the time it is shown.
   *
   * Checked by counting listings across a supplier-backed request: if supplier
   * rooms were being persisted as listings, this grows.
   */
  supply.clear();
  const before = await db.listing.count();

  supply.register(stubSupplier());
  try {
    const r = await get("/marketplace/listings");
    assert.ok(r.json.supply.length > 0, "the supplier returned nothing to persist");
    assert.equal(await db.listing.count(), before,
      "a supplier's room was written into the Listing table");
  } finally { supply.clear(); }
});

test("telling the supplier where to look does not hide PALTAS's listings", { skip }, async () => {
  /*
   * A bug this caught rather than a feature it documents.
   *
   * A wholesaler must be told a place before it can quote anything. The obvious
   * way to pass that — reuse `country` — also narrows PALTAS's own listings, so
   * a visitor browsing from Sweden would stop seeing the Kenyan listings they
   * could see a moment earlier. The supplier hint gets its own parameter for
   * exactly this reason.
   */
  supply.clear();
  const all = await get("/marketplace/listings?limit=48");
  assert.ok(all.json.listings.length > 0, "nothing is seeded, so this proves nothing");

  /* A supplier hint for somewhere with no PALTAS inventory at all. */
  const hinted = await get("/marketplace/listings?limit=48&stayCountry=SE&stayCity=Stockholm");
  assert.deepEqual(hinted.json.listings, all.json.listings,
    "a supplier hint narrowed PALTAS's own listings");

  /* Whereas `country` is a real filter on PALTAS listings and must stay one. */
  const filtered = await get("/marketplace/listings?limit=48&country=SE");
  assert.equal(filtered.json.listings.length, 0,
    "`country` must still filter PALTAS listings — nothing is seeded in Sweden");
});

test("an explicit city search narrows both halves of the page", { skip }, async () => {
  /* The fallback: when somebody actually searches for a place, the supplier
     should look there too rather than needing the hint spelled out twice. */
  supply.clear();
  let seen = null;
  supply.register({
    name: "expedia-rapid",
    describe() { return { name: "expedia-rapid", connected: true, sandbox: false, capabilities: [], why: "" }; },
    async search(q) { seen = q; return { offers: [] }; },
  });
  try {
    await get("/marketplace/listings?city=Nairobi&country=KE");
    assert.equal(seen.city, "Nairobi", "the supplier was not told the searched city");
    assert.equal(seen.country, "KE");
  } finally { supply.clear(); }
});

test("the traveller's IP reaches the supplier and is not invented", { skip }, async () => {
  /*
   * Both major suppliers require the END TRAVELLER's IP on a search — it is how
   * they apply the right market and meet their own compliance duties — and
   * neither accepts the calling server's.
   */
  supply.clear();
  let seen = null;
  supply.register({
    name: "expedia-rapid",
    describe() { return { name: "expedia-rapid", connected: true, sandbox: false, capabilities: [], why: "" }; },
    async search(q) { seen = q; return { offers: [] }; },
  });
  try {
    await get("/marketplace/listings");
    assert.ok(seen, "the supplier was never asked");
    assert.equal(typeof seen.travellerIp, "string");
    assert.ok(seen.travellerIp.length > 0,
      "no traveller IP was passed through, and both suppliers refuse a search without one");
  } finally { supply.clear(); }
});
