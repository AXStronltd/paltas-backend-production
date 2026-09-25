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
import { freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";

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
    ({ db } = await import("../src/db.ts"));
    ({ createApp } = await import("../src/server.ts"));
    supply = await import("../src/domain/supply.ts");
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
  const { expediaRapid } = await import("../src/suppliers/expedia-rapid.ts");
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

/* ====================================================================== *
 * WHOSE BOOKING IS IT.
 *
 * These routes can read and cancel a hotel reservation by id. Before
 * SupplierBooking existed they could only ask "are you signed in?", which is not
 * ownership — anybody holding an id could open a stranger's booking or cancel
 * their holiday. That is the hole this table closes, and these are the tests
 * that keep it closed.
 * ====================================================================== */

/** A signed-in person with their own cookie. */
async function person(tag) {
  const { createSession } = await import("../src/auth/sessions.ts");
  const u = await db.user.create({
    data: { email: `${tag}-${Date.now()}-${Math.round(Math.random() * 1e6)}@paltas.io`, name: tag },
  });
  const s = await createSession(u.id);
  return { user: u, cookie: `paltas_session=${s.token}` };
}

async function withCookie(method, path, body, cookie) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

/** A supplier whose bookings are deterministic, so ownership is the only variable. */
function bookingSupplier() {
  const made = new Map();
  /*
   * Unique per instance, because SupplierBooking is @@unique([supplier,
   * bookingId]) and it means it. A fixture that restarted at "BK1" for every
   * test had its second booking correctly refused by the constraint — the
   * database was right and the fixture was wrong.
   */
  const run = Date.now().toString(36) + Math.round(Math.random() * 1e6).toString(36);
  return {
    name: "expedia-rapid", sandbox: true,
    describe() { return { name: "expedia-rapid", label: "Expedia", connected: true, sandbox: true, capabilities: [], why: "" }; },
    async search() { return { offers: [] }; },
    /* Unique per instance: prebookId is @@unique([supplier, prebookId]) now,
       so a fixture that always says "PB" collides across tests — and the second
       test would find the FIRST test's hold, owned by somebody else. */
    async prebook() { return { prebookId: `PB-${run}-${made.size + 1}`, price: 10000, currency: "USD", priceDifferencePercent: 0, sandbox: true }; },
    async book({ holder }) {
      const id = "BK" + run + "-" + (made.size + 1);
      const b = { bookingId: id, status: "CONFIRMED", hotelName: "Test Hotel", hotelId: "h1",
        checkIn: "2027-01-15", checkOut: "2027-01-17", price: 10000, currency: "USD",
        refundable: true, cancellation: [], source: "expedia-rapid", sandbox: true,
        clientReference: "ref-" + id, hotelConfirmationCode: "HC" + id,
        supplierBookingId: "", createdAt: new Date().toISOString(), holder };
      made.set(id, b);
      return b;
    },
    async booking({ bookingId }) {
      const b = made.get(bookingId);
      if (!b) throw new Error("404 not found");
      return b;
    },
    async cancel({ bookingId }) {
      const b = made.get(bookingId);
      if (b) b.status = "CANCELLED";
      return { bookingId, status: "CANCELLED", charged: false, cancellationFee: 0, refund: 10000, currency: "USD", sandbox: true };
    },
  };
}

test("a booking is recorded against the person who made it", { skip }, async () => {
  supply.register(bookingSupplier());
  try {
    const alice = await person("alice");
    const hold = await withCookie("POST", "/marketplace/stays/hold", { offerId: "O", pay: false }, alice.cookie);
    const made = await withCookie("POST", "/marketplace/stays/book", {
      prebookId: hold.json.hold.prebookId,
      holder: { firstName: "Alice", lastName: "Traveller", email: "alice@paltas.io" },
    }, alice.cookie);

    assert.equal(made.status, 201, made.text.slice(0, 200));
    assert.equal(made.json.recorded, true,
      "the booking was not recorded, so PALTAS cannot show it to the guest later");

    const row = await db.supplierBooking.findFirst({
      where: { bookingId: made.json.booking.bookingId },
    });
    assert.ok(row, "no SupplierBooking row was written");
    assert.equal(row.userId, alice.user.id, "the row is not owned by the person who booked");
    /* A sandbox booking is not travel, and the record has to know. */
    assert.equal(row.sandbox, true);
    assert.equal(row.hotelConfirmationCode, "HC" + made.json.booking.bookingId,
      "the code a guest shows at the desk was not stored");
  } finally { supply.clear(); }
});

test("one person cannot read or cancel another's booking", { skip }, async () => {
  /*
   * The reason this table exists. Cancelling a stranger's holiday is the worst
   * thing these routes could permit, so it is checked before anything at all is
   * sent to the supplier.
   */
  supply.register(bookingSupplier());
  try {
    const alice = await person("alice");
    const mallory = await person("mallory");

    const hold = await withCookie("POST", "/marketplace/stays/hold", { offerId: "O", pay: false }, alice.cookie);
    const made = await withCookie("POST", "/marketplace/stays/book", {
      prebookId: hold.json.hold.prebookId,
      holder: { firstName: "Alice", lastName: "T", email: "alice@paltas.io" },
    }, alice.cookie);
    const id = made.json.booking.bookingId;

    const read = await withCookie("GET", `/marketplace/stays/${id}`, null, mallory.cookie);
    assert.equal(read.status, 404, "a signed-in stranger read somebody else's booking");
    /* 404 and not 403: "that exists but is not yours" confirms the id is real,
       which is a small oracle worth not handing out. */
    assert.match(read.text, /not_found/);

    const kill = await withCookie("DELETE", `/marketplace/stays/${id}`, null, mallory.cookie);
    assert.equal(kill.status, 404, "a signed-in stranger cancelled somebody else's holiday");

    /* And it really is untouched — not merely reported as refused. */
    const after = await withCookie("GET", `/marketplace/stays/${id}`, null, alice.cookie);
    assert.equal(after.status, 200);
    assert.equal(after.json.booking.status, "CONFIRMED");

    const list = await withCookie("GET", "/marketplace/stays", null, mallory.cookie);
    assert.equal(list.json.count, 0, "a stranger's booking appeared in Mallory's list");
  } finally { supply.clear(); }
});

test("a cancellation writes back what it actually cost", { skip }, async () => {
  supply.register(bookingSupplier());
  try {
    const alice = await person("alice");
    const hold = await withCookie("POST", "/marketplace/stays/hold", { offerId: "O", pay: false }, alice.cookie);
    const made = await withCookie("POST", "/marketplace/stays/book", {
      prebookId: hold.json.hold.prebookId,
      holder: { firstName: "Alice", lastName: "T", email: "alice@paltas.io" },
    }, alice.cookie);
    const id = made.json.booking.bookingId;

    await withCookie("DELETE", `/marketplace/stays/${id}`, null, alice.cookie);
    const row = await db.supplierBooking.findFirst({ where: { bookingId: id } });
    assert.equal(row.status, "CANCELLED");
    assert.ok(row.cancelledAt, "no cancellation time recorded");
    /*
     * The fee and the refund, not just the status. A non-refundable
     * cancellation charges anyway, and a record saying only "cancelled" would
     * tell somebody they had their money back when they did not.
     */
    assert.equal(row.refund, 10000n);
    assert.equal(row.cancellationFee, 0n);
  } finally { supply.clear(); }
});

test("the bookings list needs no supplier at all", { skip }, async () => {
  /*
   * A guest checking where they are staying tomorrow should not depend on a
   * wholesaler being awake — and the supplier could not answer it anyway: it
   * knows PALTAS's bookings, not this person's.
   */
  supply.register(bookingSupplier());
  const alice = await person("alice");
  const hold = await withCookie("POST", "/marketplace/stays/hold", { offerId: "O", pay: false }, alice.cookie);
  await withCookie("POST", "/marketplace/stays/book", {
    prebookId: hold.json.hold.prebookId,
    holder: { firstName: "Alice", lastName: "T", email: "alice@paltas.io" },
  }, alice.cookie);

  /* Supplier gone entirely. */
  supply.clear();
  const list = await withCookie("GET", "/marketplace/stays", null, alice.cookie);
  assert.equal(list.status, 200, "the list broke when the supplier went away");
  assert.equal(list.json.count, 1);
  assert.equal(list.json.stays[0].hotelName, "Test Hotel");
});

/* ====================================================================== *
 * THE PREBOOK PAIR, AND NOT BOOKING TWICE.
 *
 * LiteAPI: "Save transactionId and prebookId together, immediately. Each
 * prebook call generates a new pair, and they cannot be retrieved later."
 *
 * Everything below is a consequence of that sentence. Lose the pair after a
 * customer has paid and there is a charge with no reservation and no way to
 * find one; reuse it carelessly and there are two reservations for one payment.
 * ====================================================================== */

/** A supplier with the full payment lifecycle, deterministic per instance. */
function payingSupplier() {
  const run = Date.now().toString(36) + Math.round(Math.random() * 1e6).toString(36);
  let n = 0;
  const booked = new Map();
  return {
    name: "liteapi", sandbox: true,
    describe() { return { name: "liteapi", label: "LiteAPI", connected: true, sandbox: true, capabilities: [], why: "" }; },
    async search() { return { offers: [] }; },
    async rooms() { return { hotelId: "h1", nights: 2, offers: [{ offerId: "OFF-1", roomName: "King", price: 25000, currency: "USD", refundable: true, cancellation: [] }] }; },
    async prebook({ offerId, usePaymentSdk }) {
      const id = `PB-${run}-${++n}`;
      return {
        prebookId: id, offerId, hotelId: "h1",
        checkIn: "2027-03-10", checkOut: "2027-03-12",
        price: 25000, currency: "USD", priceDifferencePercent: 0, sandbox: true,
        ...(usePaymentSdk ? { payment: {
          clientSecret: `pi_${run}_secret_${n}`, transactionId: `tr_${run}_${n}`,
          publishableKey: "pk_test_FIXTURE", stripeJsUrl: "https://js.stripe.com/v3/",
          environment: "sandbox" } } : {}),
      };
    },
    async book({ prebookId, holder, transactionId }) {
      const id = `BK-${run}-${prebookId}`;
      const b = { bookingId: id, status: "CONFIRMED", hotelName: "Test Hotel", hotelId: "h1",
        checkIn: "2027-03-10", checkOut: "2027-03-12", price: 25000, currency: "USD",
        refundable: true, cancellation: [], source: "liteapi", sandbox: true,
        clientReference: "ref-" + id, hotelConfirmationCode: "HC-" + id,
        supplierBookingId: "", createdAt: new Date().toISOString(), holder, transactionId };
      booked.set(id, b);
      return b;
    },
    async booking({ bookingId }) { const b = booked.get(bookingId); if (!b) throw new Error("404"); return b; },
    async cancel({ bookingId }) { return { bookingId, status: "CANCELLED", charged: false, cancellationFee: 0, refund: 25000, currency: "USD", sandbox: true }; },
  };
}

test("holding a rate requires an account, and records the pair at once", { skip }, async () => {
  supply.register(payingSupplier());
  try {
    /* Anonymous: there would be nobody to record it against. */
    const anon = await withCookie("POST", "/marketplace/stays/hold", { offerId: "OFF-1", pay: true });
    assert.equal(anon.status, 401, "a rate was held with no account to record it against");

    const alice = await person("alice");
    const held = await withCookie("POST", "/marketplace/stays/hold",
      { offerId: "OFF-1", pay: true }, alice.cookie);
    assert.equal(held.status, 200, held.text.slice(0, 200));

    const pb = held.json.hold.prebookId;
    const tx = held.json.hold.payment.transactionId;
    assert.ok(pb && tx, "the prebook pair did not come back");
    assert.ok(held.json.paltasBookingId, "no PALTAS booking id was returned");

    /* Durable BEFORE the browser is told anything — it may never come back. */
    const row = await db.supplierBooking.findFirst({ where: { prebookId: pb } });
    assert.ok(row, "the prebook was not persisted");
    assert.equal(row.transactionId, tx, "the transactionId was not stored with its prebook");
    assert.equal(row.userId, alice.user.id);
    assert.equal(row.status, "HELD");
    assert.equal(row.paymentStatus, "PENDING");
    assert.equal(row.bookingId, null, "a bookingId exists before anything was booked");

    /*
     * And the Stripe client secret is NOT among it. It settles one payment, it
     * belongs in the payment UI, and a copy at rest is a copy that can leak.
     */
    const stored = JSON.stringify(row, (k, v) => (typeof v === "bigint" ? String(v) : v));
    assert.ok(!stored.includes("_secret_"), "the Stripe client secret was persisted");
  } finally { supply.clear(); }
});

test("booking uses the transactionId from ITS OWN prebook, never the caller's", { skip }, async () => {
  /*
   * A transactionId from a different prebook would settle the wrong payment
   * against this reservation. The client is not trusted with it at all — the
   * value comes from the row PALTAS wrote when the rate was held.
   */
  supply.register(payingSupplier());
  try {
    const alice = await person("alice");
    const a = await withCookie("POST", "/marketplace/stays/hold", { offerId: "OFF-1", pay: true }, alice.cookie);
    const b = await withCookie("POST", "/marketplace/stays/hold", { offerId: "OFF-1", pay: true }, alice.cookie);
    const mine = a.json.hold.prebookId;
    const other = b.json.hold.payment.transactionId;

    const made = await withCookie("POST", "/marketplace/stays/book", {
      prebookId: mine,
      /* Deliberately somebody else's transaction. It must be ignored. */
      transactionId: other,
      holder: { firstName: "Alice", lastName: "T", email: "a@paltas.io" },
    }, alice.cookie);
    assert.equal(made.status, 201, made.text.slice(0, 200));

    const row = await db.supplierBooking.findFirst({ where: { prebookId: mine } });
    assert.equal(row.transactionId, a.json.hold.payment.transactionId,
      "the booking settled against a transactionId the client supplied");
    assert.notEqual(row.transactionId, other);
  } finally { supply.clear(); }
});

test("a retried booking replays the first, it does not reserve a second room", { skip }, async () => {
  supply.register(payingSupplier());
  try {
    const alice = await person("alice");
    const held = await withCookie("POST", "/marketplace/stays/hold", { offerId: "OFF-1", pay: true }, alice.cookie);
    const pb = held.json.hold.prebookId;
    const body = { prebookId: pb, holder: { firstName: "Alice", lastName: "T", email: "a@paltas.io" } };

    const first = await withCookie("POST", "/marketplace/stays/book", body, alice.cookie);
    assert.equal(first.status, 201);

    /* A double-click, a flaky connection, a client that missed the response. */
    const again = await withCookie("POST", "/marketplace/stays/book", body, alice.cookie);
    assert.equal(again.status, 200, "a retry created a new booking instead of replaying");
    assert.equal(again.json.idempotent, true);
    assert.equal(again.json.booking.bookingId, first.json.booking.bookingId,
      "the retry returned a DIFFERENT booking — the guest now holds two rooms");
    assert.match(again.json.notice, /not been charged again/);

    const rows = await db.supplierBooking.count({ where: { prebookId: pb } });
    assert.equal(rows, 1, `${rows} rows for one prebook`);
  } finally { supply.clear(); }
});

test("somebody else's held rate cannot be booked", { skip }, async () => {
  supply.register(payingSupplier());
  try {
    const alice = await person("alice");
    const mallory = await person("mallory");
    const held = await withCookie("POST", "/marketplace/stays/hold", { offerId: "OFF-1", pay: true }, alice.cookie);

    const stolen = await withCookie("POST", "/marketplace/stays/book", {
      prebookId: held.json.hold.prebookId,
      holder: { firstName: "M", lastName: "X", email: "m@paltas.io" },
    }, mallory.cookie);
    assert.equal(stolen.status, 404, "a stranger booked a rate somebody else was holding");

    const row = await db.supplierBooking.findFirst({ where: { prebookId: held.json.hold.prebookId } });
    assert.equal(row.bookingId, null, "the hold was consumed by somebody who did not own it");
  } finally { supply.clear(); }
});

test("an unknown prebook is refused rather than invented", { skip }, async () => {
  supply.register(payingSupplier());
  try {
    const alice = await person("alice");
    const r = await withCookie("POST", "/marketplace/stays/book", {
      prebookId: "PB-does-not-exist",
      holder: { firstName: "A", lastName: "B", email: "a@paltas.io" },
    }, alice.cookie);
    assert.equal(r.status, 404);
    assert.match(r.text, /not one PALTAS is holding/);
  } finally { supply.clear(); }
});

test("a supplier's own refusal reaches the caller, not a generic 500", { skip }, async () => {
  /*
   * Verified against the live sandbox, which answers an unpaid book with
   * `{"code":2014,"description":"payment not completed"}`. Before the error
   * handler learned to honour `expose`, that became "Something went wrong at
   * our end" — telling a guest whose card had not gone through that PALTAS was
   * broken, which is both wrong and unactionable.
   */
  const s = payingSupplier();
  s.book = async () => {
    const { SupplyUnavailable } = await import("../src/domain/supply.ts");
    throw new SupplyUnavailable("LiteAPI returned 400: payment not completed");
  };
  supply.register(s);
  try {
    const alice = await person("alice");
    const held = await withCookie("POST", "/marketplace/stays/hold", { offerId: "OFF-1", pay: true }, alice.cookie);
    const r = await withCookie("POST", "/marketplace/stays/book", {
      prebookId: held.json.hold.prebookId,
      holder: { firstName: "A", lastName: "B", email: "a@paltas.io" },
    }, alice.cookie);

    assert.equal(r.status, 503, "a supplier refusal was reported as a fault in PALTAS");
    assert.match(r.json.message, /payment not completed/);
    assert.ok(!/Something went wrong at our end/.test(r.text));
  } finally { supply.clear(); }
});

test("the supplier envelope says whether a guest could actually pay", { skip }, async () => {
  /*
   * THE QUESTION THIS COULD NOT ANSWER.
   *
   * The LiteAPI adapter has computed `canTakePayment` all along — whether a
   * Stripe publishable key exists for the environment it is running in — and
   * the seam's whitelist dropped it. So the only way to learn that a booking
   * cannot be completed was to sign in, choose a room, hold a rate, and reach
   * a payment step that says "the payment could not be set up".
   *
   * Everything before that point looks like a working marketplace. The
   * difference between BOOKABLE and BROWSABLE is the difference between a
   * checkout and a dead end.
   */
  supply.register({
    name: "liteapi",
    search: async () => ({ offers: [] }),
    /* Faithful to the real adapter: it declares a public identity, which is
       what keeps its own name out of a visitor's response. A stub without one
       leaks, and SHOULD — that is how Booking.com stays named. */
    publicName: "partner",
    publicLabel: "our hotel partners",
    describe: () => ({
      name: "liteapi", connected: true, sandbox: false,
      publicName: "partner", publicLabel: "our hotel partners",
      capabilities: ["search", "book"],
      canTakePayment: false, paymentEnvironment: "live",
    }),
  });

  const r = await fetch(`${base}/marketplace/suppliers`);
  const body = await r.json();
  const s = body.suppliers[0];

  /*
   * THE PUBLIC ROUTE ANSWERS THE GUEST'S QUESTION AND STOPS THERE.
   *
   * "Can this be booked" is the guest's question and it is answered. WHICH
   * environment variable is missing is not: a guest cannot act on the name of
   * one, and printing it tells anybody who asks how the integration is wired
   * and who PALTAS buys through. That detail moved to /platform/suppliers,
   * asserted below, rather than being thrown away.
   */
  assert.equal(s.bookable, false, "the envelope does not report whether a guest can pay");
  assert.equal(s.canTakePayment, false);
  assert.match(s.why, /browsed but not booked/, "a false boolean explains nothing on its own");
  assert.equal(s.paymentWhy, undefined, "an environment variable reached a public response");
  assert.equal(s.paymentEnvironment, undefined, "the deployment environment reached a public response");

  /* And the supplier is not named to a visitor at all. */
  const raw = JSON.stringify(body);
  assert.ok(!/liteapi|LiteAPI|LITEAPI/.test(raw),
    "the wholesaler PALTAS buys through was named in a public response");
  assert.ok(!/pk_(live|test)_[A-Za-z0-9]/.test(raw), "a publishable key reached the envelope");
  assert.ok(!/sk_|sand_|prod_/.test(raw), "a secret-shaped string reached the envelope");

  /* With a key present it simply says so. */
  supply.register({
    name: "liteapi",
    search: async () => ({ offers: [] }),
    describe: () => ({
      name: "liteapi", connected: true, sandbox: false,
      capabilities: ["search", "book"],
      canTakePayment: true, paymentEnvironment: "live",
    }),
  });
  const ok = await (await fetch(`${base}/marketplace/suppliers`)).json();
  assert.equal(ok.suppliers[0].canTakePayment, true);
  assert.equal(ok.suppliers[0].bookable, true);
  assert.equal(ok.suppliers[0].why, "", "a working checkout still carries a complaint");
});

test("the detail a visitor must not see is kept, behind the staff door", { skip }, async () => {
  /*
   * Removing the wholesaler's name from public responses must not cost an
   * operator the ability to find out why a checkout is refusing. The sentence
   * that names LITEAPI_STRIPE_PK_LIVE still exists — it is now somewhere only
   * PALTAS staff can read it.
   */
  supply.register({
    name: "liteapi",
    search: async () => ({ offers: [] }),
    describe: () => ({
      name: "liteapi", label: "LiteAPI", connected: true, sandbox: false,
      capabilities: ["search", "book"],
      canTakePayment: false, paymentEnvironment: "live",
    }),
  });

  /* Shut to the public, which is the point of moving it. */
  const anon = await fetch(`${base}/platform/suppliers`);
  assert.ok(anon.status === 401 || anon.status === 403,
    `the operator supplier detail answered an unauthenticated caller with ${anon.status}`);

  /* And the operator envelope itself still names names. */
  const op = supply.status();
  assert.equal(op.name, "liteapi", "the operator lost which supplier is connected");
  assert.equal(op.label, "LiteAPI");
  assert.match(op.paymentWhy, /LITEAPI_STRIPE_PK_LIVE is not set/,
    "the operator lost the reason a booking cannot be paid for");
});

test("the page a visitor actually loads never names the wholesaler", { skip }, async () => {
  /*
   * THE ROUTE THAT MATTERS, CHECKED WHOLE.
   *
   * The supplier envelope is asserted elsewhere, but a visitor does not load
   * the supplier envelope — they load the listings. Every row on that page
   * carries its own provenance, so the wholesaler's name could come back
   * through any one of `source`, `supplier.name`, `supplier.label`, the
   * namespaced `id`, or the envelope stitched in beside them.
   *
   * So this asserts the property over the ENTIRE response body rather than
   * field by field: a string that names who PALTAS buys through does not
   * appear anywhere in what a browser receives.
   */
  supply.register({
    name: "liteapi",
    label: "LiteAPI",
    publicName: "partner",
    publicLabel: "our hotel partners",
    describe: () => ({
      name: "liteapi", label: "LiteAPI",
      publicName: "partner", publicLabel: "our hotel partners",
      connected: true, sandbox: false, capabilities: ["search", "book"],
      canTakePayment: true, paymentEnvironment: "live",
    }),
    async search() {
      return { offers: [{
        supplierRef: "lp1897", title: "Diani Reef Beach Resort",
        city: "Diani", country: "KE", price: 64000, currency: "KES",
        nights: 7, offerId: "off_1", refundable: true, rating: 8.7, ratingCount: 1204,
      }] };
    },
  });

  const r = await get("/marketplace/listings?stayCity=Diani&stayCountry=KE" +
                      "&checkIn=2026-11-01&checkOut=2026-11-08");
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const raw = r.text;

  assert.ok(!/liteapi/i.test(raw),
    "the wholesaler is named somewhere in the listings a visitor loads");

  /* Non-vacuous: the supplier row really is in the body being searched. */
  const rows = r.json.supply || [];
  assert.equal(rows.length, 1, "no supplier row reached the response, so the check proved nothing");
  assert.equal(rows[0].source, "partner");
  assert.equal(rows[0].supplier.label, "our hotel partners");
  assert.equal(rows[0].id, "partner:lp1897");

  /* And the disclosure that is NOT about the wholesaler survives. */
  assert.equal(rows[0].paltasOwned, false,
    "a supplier room stopped being marked as not a PALTAS listing");
});
