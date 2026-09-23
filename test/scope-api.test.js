/* ====================================================================== *
 * SITE SCOPE — "a guard on two gates is not a guard on every gate".
 *
 * The organization filter has always held: nobody reads another company's
 * records. Inside one company there was no wall at all. `Membership.scope`
 * was stored, returned in the session, and read by the frontend — and
 * enforced by nothing, so a guard assigned to one gate could list every
 * visit, pass, vehicle, incident and patrol the company had.
 *
 * These tests are that wall. They are separate from tenancy.test.js because
 * it is a different question: not "whose company is this?" but "what is this
 * person's remit inside it?"
 *
 * The last two tests are the honest ones. They assert what scope does NOT
 * reach, so that if somebody later believes it covers everything, a test
 * tells them otherwise.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

/* This file's own schema — `node --test` runs files in parallel and each one
   rebuilds from nothing. See the long note in db-help.js. */
const SCHEMA = "test_scope";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret-that-is-long-enough-to-pass";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping site scope tests";
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
});
test.after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
});

async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}),
               ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not always JSON */ }
  return { status: res.status, json, text };
}

let seq = 0;

/**
 * One company, two sites, and a record of several kinds at each.
 *
 * Then a person whose membership carries `scope`. Everything below asks the
 * same question of that person: which of the two sites can they see?
 *
 * The role is MANAGER by default, deliberately. A MANAGER has `manage` on
 * every area, so the role wall lets everything through and scope is the only
 * thing narrowing the result — which is what these tests are measuring. Use a
 * GUARD and a 403 from the role check would mask whether scope did anything.
 * The last test uses a GUARD on purpose, to show the two walls compose.
 */
async function company({ scope, role = "MANAGER" }) {
  const n = ++seq;
  const org = await db.organization.create({
    data: { name: `Firm ${n}`, country: "ae",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { status: "ACTIVE" } },
      entitlements: { create: [
        { product: "SECURITY_MANAGEMENT" },
        { product: "PROPERTY_MANAGEMENT" },
      ] } },
  });

  const north = await db.site.create({
    data: { orgId: org.id, name: `North Gate ${n}`, city: "Dubai" } });
  const south = await db.site.create({
    data: { orgId: org.id, name: `South Gate ${n}`, city: "Dubai" } });

  /* One of each at BOTH sites, so every assertion below has something it
     should see and something it should not. */
  for (const [site, tag] of [[north, "north"], [south, "south"]]) {
    await db.incident.create({
      data: { orgId: org.id, siteId: site.id, ref: `INC-${n}-${tag}`,
              title: `Alarm at ${tag}` } });
    await db.visit.create({
      data: { orgId: org.id, siteId: site.id, visitor: `Visitor ${tag}` } });
    await db.building.create({
      data: { orgId: org.id, siteId: site.id, name: `Block ${tag}` } });
  }

  /* And one incident belonging to NO site, which is the interesting case. */
  await db.incident.create({
    data: { orgId: org.id, ref: `INC-${n}-none`, title: "Head office alarm" } });

  const email = `s${n}.${Date.now()}@scope.test`;
  const user = await db.user.create({
    data: { email, name: email, googleSub: "sub_" + email } });
  await db.membership.create({
    data: { orgId: org.id, userId: user.id, role, scope } });

  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: { tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
            userId: user.id, orgId: org.id,
            expiresAt: new Date(Date.now() + 3600_000) },
  });

  return { org, north, south, cookie: `paltas_session=${token}` };
}

/*
 * The list envelope is keyed by the SLUG — `{ sites: [...] }`, not
 * `{ rows: [...] }`. Getting that wrong is how two of these tests first
 * "passed": a missing key read as an empty list, and "saw nothing it should
 * not" is trivially true of nothing. So this throws rather than defaults.
 */
function rowsOf(r, slug) {
  assert.equal(r.status, 200, `GET /${slug} answered ${r.status}: ${r.text.slice(0, 160)}`);
  const rows = r.json && r.json[slug];
  assert.ok(Array.isArray(rows),
    `GET /${slug} did not return a "${slug}" array — got ${Object.keys(r.json || {})}`);
  return rows;
}

/** Whatever each row calls itself, flattened to one string to search. */
const names = (r, slug) =>
  rowsOf(r, slug).map((x) => x.name || x.title || x.visitor || x.ref).join(" ");

/* ================================================================ *
 * WHAT SCOPE DOES
 * ================================================================ */

test("{all:true} sees every site — the column default changes nothing",
  { skip }, async () => {
  const c = await company({ scope: { all: true } });
  const r = await call("/sites", { cookie: c.cookie });
  assert.equal(rowsOf(r, "sites").length, 2, "an unscoped member should see both sites");
});

test("a member scoped to one site sees only that site", { skip }, async () => {
  const c = await company({ scope: { sites: [] } });
  /* scope written after the sites exist, so it can name one of them */
  await db.membership.updateMany({
    where: { orgId: c.org.id }, data: { scope: { sites: [c.north.id] } } });

  const r = await call("/sites", { cookie: c.cookie });
  const rows = rowsOf(r, "sites");
  assert.equal(rows.length, 1, "a scoped member saw " + rows.length + " sites, not 1");
  assert.ok(/North/.test(rows[0].name), "the wrong site came back: " + rows[0].name);
});

test("and only that site's incidents, visits and buildings", { skip }, async () => {
  const c = await company({ scope: { sites: [] } });
  await db.membership.updateMany({
    where: { orgId: c.org.id }, data: { scope: { sites: [c.north.id] } } });

  for (const slug of ["incidents", "visits", "buildings"]) {
    const r = await call("/" + slug, { cookie: c.cookie });
    const got = names(r, slug);
    assert.ok(/north/i.test(got), slug + " lost the row it should have: " + got);
    assert.ok(!/south/i.test(got), slug + " LEAKED the other site: " + got);
  }
});

test("a row belonging to no site is not in a scoped member's remit",
  { skip }, async () => {
  const c = await company({ scope: { sites: [] } });
  await db.membership.updateMany({
    where: { orgId: c.org.id }, data: { scope: { sites: [c.north.id] } } });

  const r = await call("/incidents", { cookie: c.cookie });
  const got = names(r, "incidents");
  assert.ok(/Alarm at north/.test(got), "the remit's own incident went missing: " + got);
  assert.ok(!/Head office/.test(got),
    "a siteless incident appeared for a site-scoped member: " + got);
});

test("reading one record by id is narrowed too — not just the list",
  { skip }, async () => {
  const c = await company({ scope: { sites: [] } });
  await db.membership.updateMany({
    where: { orgId: c.org.id }, data: { scope: { sites: [c.north.id] } } });

  const south = await db.incident.findFirst({
    where: { orgId: c.org.id, siteId: c.south.id } });

  const r = await call("/incidents/" + south.id, { cookie: c.cookie });
  assert.equal(r.status, 404,
    "a scoped member read another site's incident by guessing its id");
});

test("and writing it, and deleting it", { skip }, async () => {
  const c = await company({ scope: { sites: [] } });
  await db.membership.updateMany({
    where: { orgId: c.org.id }, data: { scope: { sites: [c.north.id] } } });

  const south = await db.incident.findFirst({
    where: { orgId: c.org.id, siteId: c.south.id } });

  const patch = await call("/incidents/" + south.id,
    { method: "PATCH", body: { title: "changed" }, cookie: c.cookie });
  assert.equal(patch.status, 404, "a scoped member edited another site's record");

  const del = await call("/incidents/" + south.id,
    { method: "DELETE", cookie: c.cookie });
  assert.equal(del.status, 404, "a scoped member deleted another site's record");

  const still = await db.incident.findUnique({ where: { id: south.id } });
  assert.ok(still, "the record was actually destroyed");
  assert.equal(still.title, "Alarm at south", "the title was actually changed");
});

test("a record cannot be CREATED outside the remit either", { skip }, async () => {
  const c = await company({ scope: { sites: [] } });
  await db.membership.updateMany({
    where: { orgId: c.org.id }, data: { scope: { sites: [c.north.id] } } });

  const bad = await call("/incidents", { method: "POST", cookie: c.cookie,
    body: { ref: "INC-X", title: "filed at the wrong gate", siteId: c.south.id } });
  assert.equal(bad.status, 403,
    "a scoped member filed a record at a site they cannot see");

  const good = await call("/incidents", { method: "POST", cookie: c.cookie,
    body: { ref: "INC-Y", title: "filed at my own gate", siteId: c.north.id } });
  assert.equal(good.status, 201, "the member could not write at their OWN site");
});

test("an unreadable scope shows nothing rather than everything", { skip }, async () => {
  /* The two ways to read a malformed scope are "show them everything" and
     "show them nothing". The first turns a data bug into a silent breach. */
  for (const scope of [{}, { sites: [] }, { all: false }, { sites: "north" }]) {
    const c = await company({ scope });
    const r = await call("/sites", { cookie: c.cookie });
    assert.equal(rowsOf(r, "sites").length, 0,
      "scope " + JSON.stringify(scope) + " was treated as unrestricted");
  }
});

test("role and scope are two walls, and both stand", { skip }, async () => {
  /* A GUARD cannot reach sites at all — that is the role wall, and it answers
     before scope is ever consulted. Scope then narrows what is left. */
  const c = await company({ scope: { all: true }, role: "GUARD" });
  const blocked = await call("/sites", { cookie: c.cookie });
  assert.equal(blocked.status, 403, "a guard read the company's site list");

  const scoped = await company({ scope: { sites: [] }, role: "GUARD" });
  await db.membership.updateMany({
    where: { orgId: scoped.org.id }, data: { scope: { sites: [scoped.north.id] } } });
  const r = await call("/visits", { cookie: scoped.cookie });
  const got = names(r, "visits");
  assert.ok(/north/i.test(got) && !/south/i.test(got),
    "a guard on one gate saw both gates: " + got);
});

/* ================================================================ *
 * WHAT SCOPE DOES NOT DO — asserted, so nobody assumes otherwise
 * ================================================================ */

/*
 * The resources scope CANNOT narrow, because they carry no site.
 *
 * Written out rather than computed, so adding a resource is a decision: a new
 * name appearing here means somebody looked at it and concluded a site-scoped
 * person should see all of them. The test below fails until they do.
 */
/*
 * `contracts` joined this list when unit sales were modelled, and it is the
 * same shape as `leases` directly below it: both hang off a unit and a party
 * rather than off a site. A contract's site is knowable — project → site —
 * but reaching it means a join the scope filter does not do for any other
 * resource, and giving Contract a siteId of its own would duplicate the
 * project's and be free to drift from it.
 *
 * So a site-scoped member reads the company's whole sales book, exactly as
 * they already read its whole lease book. That is the documented limitation
 * named below, not a new one.
 */
const EXPECTED_UNNARROWABLE = [
  "audit-tasks", "capital-calls", "channels", "contracts", "conversations",
  "deals", "distributions", "documents", "group-bookings", "guest-requests",
  "investment-orders", "investor-profiles", "investors", "invoices", "leads",
  "leases", "listings", "messages", "ops-tasks", "parties", "payments",
  "payouts", "pricing-rules", "rate-rules", "reservations",
  "token-holdings", "viewings",
].sort();

test("the resources with no site are NOT narrowed — by design",
  { skip }, async () => {
  const { RESOURCES } = await import("../src/domain/registry.js");
  const without = Object.entries(RESOURCES)
    .filter(([slug, r]) => slug !== "sites" && !r.fields.siteId)
    .map(([slug]) => slug);

  /* If this number moves, somebody added or removed a resource and should
     decide deliberately whether scope reaches it. */
  assert.deepEqual(without.sort(), EXPECTED_UNNARROWABLE,
    "the set of resources scope cannot narrow has changed — see resource.js");
});

test("so a site-scoped member still reads the company's whole contact list",
  { skip }, async () => {
  /* This is the limit named in resource.js, proven rather than described.
     Fixing it means deciding what a site-scoped person's remit is for a row
     with no site, which is a product decision, not a filter. */
  const c = await company({ scope: { sites: [] } });
  await db.membership.updateMany({
    where: { orgId: c.org.id }, data: { scope: { sites: [c.north.id] } } });
  await db.party.create({
    data: { orgId: c.org.id, name: "Somebody at the other gate", kind: "CONTACT" } });

  const r = await call("/parties", { cookie: c.cookie });
  assert.equal(rowsOf(r, "parties").length, 1,
    "parties are now narrowed — good, but update resource.js and these tests");
});

test("SITE_BEARING matches the schema — it cannot drift", { skip }, async () => {
  /*
   * scopedTo() takes a MODEL name, because a hand-written count has no
   * resource declaration to read a field map from. So the set of site-bearing
   * models is written out by hand, and a hand-written list of what to secure
   * is a list that goes stale. This reads the schema and compares.
   */
  const { SITE_BEARING } = await import("../src/domain/scope.js");
  const { readFileSync } = await import("node:fs");
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  const actual = new Set();
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    if (/^\s*siteId\s+String/m.test(m[2])) {
      actual.add(m[1][0].toLowerCase() + m[1].slice(1));
    }
  }

  /* If the schema parse finds nothing, the two deepEquals below both pass on
     empty sets and this test proves nothing. */
  assert.ok(actual.size >= 15,
    "the schema scan found only " + actual.size + " site-bearing models, so this " +
    "test is not actually comparing anything — the regex has stopped matching");

  const missing = [...actual].filter((m) => !SITE_BEARING.has(m)).sort();
  const extra = [...SITE_BEARING].filter((m) => !actual.has(m)).sort();

  assert.deepEqual(missing, [],
    "these models carry a siteId but scopedTo() does not narrow them, so any " +
    "hand-written query against them ignores a person's remit: " + missing);
  assert.deepEqual(extra, [],
    "SITE_BEARING names models that have no siteId — scopedTo() would build a " +
    "filter on a column that does not exist: " + extra);
});

test("a site-scoped member's summary counts match their own lists", { skip }, async () => {
  /*
   * The tile and the list must agree. A manager who reads "2 sites" above a
   * list of one stops trusting both numbers, and a count is information in
   * its own right — "14 open incidents" tells somebody restricted to one gate
   * how busy the other gates are.
   */
  const c = await company({ scope: { sites: [] } });
  await db.membership.updateMany({
    where: { orgId: c.org.id }, data: { scope: { sites: [c.north.id] } } });

  const r = await call("/summary", { cookie: c.cookie });
  assert.equal(r.status, 200, "/summary answered " + r.status + ": " + r.text.slice(0, 140));

  assert.equal(r.json.counts.openIncidents, 1,
    "a site-scoped member's incident count covered the whole company: " +
    JSON.stringify(r.json.counts));

  const list = names(await call("/incidents", { cookie: c.cookie }), "incidents");
  assert.ok(/north/i.test(list) && !/south/i.test(list),
    "the list and the count disagree — list was: " + list);
});

test("a scoped member's request for one site cannot land on a different one", { skip }, async () => {
  /*
   * THE BUG THIS EXISTS TO PREVENT, WHICH SHIPPED.
   *
   * `sites` is the one resource that narrows on its OWN id: scopeWhere()
   * returns { id: { in: allowed } }. The three by-id handlers built their
   * where clause as
   *
   *     { id: req.params.id, orgId, ...scopeWhere(...) }
   *
   * and a spread puts its keys LAST — so the scope's `id` replaced the id
   * being asked for. The request stopped meaning "site B" and started
   * meaning "any site in my remit", which Prisma answered with the first one.
   *
   * Nothing crossed a tenant wall: orgId held, and the row returned was one
   * this person may see. It was worse than a refusal in a quieter way —
   *
   *     GET    /sites/B  returned 200 with A's data
   *     PATCH  /sites/B  renamed A
   *     DELETE /sites/B  deleted A, and its buildings and units with it
   *
   * — and all three looked like they had worked. A manager with two
   * buildings could archive the wrong one and be told it succeeded.
   */
  const c = await company({ scope: { sites: [] } });
  await db.membership.updateMany({
    where: { orgId: c.org.id }, data: { scope: { sites: [c.north.id] } } });

  /* Reading the site they may NOT see must refuse — not quietly hand back
     the one they may. */
  const read = await call(`/sites/${c.south.id}`, { cookie: c.cookie });
  assert.equal(read.status, 404,
    `reading an out-of-scope site answered ${read.status}` +
    (read.json && read.json.site ? ` with "${read.json.site.name}"` : ""));

  /* Writing to it must not land on the one they may. */
  const before = await db.site.findUnique({ where: { id: c.north.id } });
  const edit = await call(`/sites/${c.south.id}`, {
    method: "PATCH", cookie: c.cookie, body: { name: "Renamed by an outsider" } });
  assert.equal(edit.status, 404, "an out-of-scope site was editable");
  assert.equal((await db.site.findUnique({ where: { id: c.north.id } })).name, before.name,
    "*** editing one site renamed a different one ***");
  assert.equal((await db.site.findUnique({ where: { id: c.south.id } })).name, c.south.name,
    "an out-of-scope site was renamed");

  /* And deleting it must not delete the one they may. */
  const gone = await call(`/sites/${c.south.id}`, { method: "DELETE", cookie: c.cookie });
  assert.equal(gone.status, 404, "an out-of-scope site was deletable");
  assert.ok(await db.site.findUnique({ where: { id: c.north.id } }),
    "*** deleting one site deleted a different one ***");
  assert.ok(await db.site.findUnique({ where: { id: c.south.id } }),
    "an out-of-scope site was deleted");

  /* Non-vacuous: the site they MAY reach still answers, by its own id. */
  const mine = await call(`/sites/${c.north.id}`, { cookie: c.cookie });
  assert.equal(mine.status, 200, "the scope now refuses a site the member may see");
  assert.equal(mine.json.site.id, c.north.id,
    "the id asked for is not the id returned, which is the whole bug");
});
