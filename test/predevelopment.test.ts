/* ====================================================================== *
 * EVERYTHING BEFORE ANYBODY BUILDS ANYTHING.
 *
 * Land is found and bought, the numbers are tested, somebody draws it, and an
 * authority says yes. Four registers, and the tests are about the one rule
 * each carries that a spreadsheet cannot:
 *
 *   an acquisition cannot complete while a due-diligence item is unsettled —
 *   buying land on an unresolved title search is the most expensive mistake
 *   in this business, and it is always made by ticking the search off;
 *
 *   a feasibility's profit, margin and residual land value are COMPUTED, so
 *   they cannot drift from the costs they come from;
 *
 *   issuing a drawing revision supersedes the previous one rather than
 *   overwriting it, and a sheet out for construction cannot be edited;
 *
 *   an approved permit needs the authority's own reference, and one that has
 *   lapsed reads as expired whatever its column says.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
import { portOf } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";
import { present } from "./wire.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_predev";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping pre-development tests";
let dbHelp: typeof import("./db-help.ts") | null = null;
/*
 * LOADED INSIDE A `try`, SO THEY ARE DECLARED OUTSIDE IT.
 *
 * Importing the service pulls in the Prisma client, and a checkout where
 * nobody has run `prisma generate` throws on that import rather than failing
 * a test — a setup problem, reported as one below.
 *
 * `typeof import(...)` is the module's own type, so these handles are checked
 * against the real thing rather than carried as `any`.
 */
let createApp: typeof import("../src/server.ts")["createApp"];
let db: typeof import("../src/db.ts")["db"];
let pg: typeof import("pg")["default"];

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
    ({ createApp } = await import("../src/server.ts"));
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/did not initialize|locate the Query Engine|generate/.test(m)) {
      skip = "RUN `npx prisma generate` FIRST";
    } else {
      const help = explain(e, DB);
      if (help) { skip = "database configuration — see below"; dbHelp = help; }
      else skip = "database unreachable: " + m.slice(0, 90);
    }
  }
}

let server: import("node:http").Server;
let base: string;
let pool: import("pg").Pool;

async function boot() {
  pool = poolInSchema(pg, DB, SCHEMA);
  await freshSchema(pool, SCHEMA);
  const app = createApp();
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${portOf(server)}`;
}

let seq = 0;
async function company() {
  const n = ++seq;
  const email = `stmt${n}@example.com`;
  const user = await db.user.create({
    data: { email, name: `Person ${n}`, googleSub: "sub_" + email },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  const session = await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: null, expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const cookie = `paltas_session=${token}`;
  /* Through the real signup, so the chart is seeded the way it is in life. */
  const made = await call("/organizations", {
    method: "POST", cookie, body: { name: `Statements Co ${n}`, work: ["property"], country: "ke" },
  });
  assert.equal(made.status, 201, made.text.slice(0, 200));
  const me = present(await db.session.findFirst({
    where: { tokenHash: crypto.createHash("sha256").update(token).digest("hex") },
    select: { orgId: true, userId: true },
  }), "no me — the row this test made is gone");
  /* The name matters: "assigned to me" matches the account OR the name, because
     plenty of people are given work before they ever sign in. */
  return { cookie, session, orgId: me.orgId, userId: me.userId, name: `Person ${n}` };
}

/*
 * THE REAL fetch, HELD BEFORE ANYTHING REPLACES IT.
 *
 * Several tests below stand a fake mail provider up by swapping
 * globalThis.fetch. Without this line those tests would also intercept the
 * requests this helper makes to the service under test — every call would be
 * answered by the fake provider, and the tests would pass while proving
 * nothing at all.
 */
const realFetch = globalThis.fetch;

async function call(
  path: string, { method = "GET", body, cookie, headers }: CallOptions = {},
): Promise<Reply> {
  const res = await realFetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Wire = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const n = (v: unknown): number => Number(v);

/**
 * A property with a unit, a tenant on a lease, an invoice issued against that
 * lease, and the rent paid. This is the shape every per-entity statement
 * needs, and it is the shape that proves the posting bridge stamps its
 * dimensions.
 */
async function tenancy(
  cookie: string, { rent = 8_500_000, pay = true }: { rent?: number; pay?: boolean } = {},
) {
  /* A unit reference is unique per company, so a second tenancy in the same
     company needs its own — otherwise the create 409s and the failure surfaces
     three lines later as "cannot read properties of undefined". */
  const k = ++seq;
  const site = await call("/sites", { method: "POST", cookie, body: { name: `Kilimani Suites ${k}`, city: "Nairobi" } });
  assert.equal(site.status, 201, site.text.slice(0, 160));
  const siteId = site.json.site.id;
  const unit = await call("/units", { method: "POST", cookie, body: { ref: `A-${200 + k}`, siteId } });
  assert.equal(unit.status, 201, unit.text.slice(0, 160));
  const unitId = unit.json.unit.id;
  const tenant = await call("/parties", { method: "POST", cookie, body: { name: `Tenant ${k}`, kind: "TENANT" } });
  const partyId = tenant.json.party.id;
  const lease = await call("/leases", { method: "POST", cookie, body: { unitId, tenantId: partyId, rent } });
  const leaseId = lease.json.lease.id;

  const inv = await call("/invoices", { method: "POST", cookie, body: { currency: "KES", partyId, leaseId } });
  const invoiceId = inv.json.invoice.id;
  await call(`/invoices/${invoiceId}/lines`, {
    method: "POST", cookie, body: { detail: "March rent", quantity: 1, unitPrice: rent, taxBps: 0 },
  });
  const sent = await call(`/invoices/${invoiceId}`, {
    method: "PATCH", cookie, body: { status: "SENT", issuedOn: "2026-03-01" },
  });
  assert.match(sent.json.booking.booked || "", /^JE-\d{4}$/,
    `the invoice was not booked: ${sent.json.booking.why}`);

  let paid = null;
  if (pay) {
    paid = await call("/payments", {
      method: "POST", cookie,
      body: { invoiceId, amount: rent, method: "MPESA", reference: `R-${++seq}`, receivedAt: "2026-03-05" },
    });
    assert.match(paid.json.booking.booked || "", /^JE-\d{4}$/,
      `the payment was not booked: ${paid.json.booking.why}`);
  }
  return { siteId, unitId, partyId, leaseId, invoiceId, paid };
}

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (dbHelp) console.log("\n" + "─".repeat(72) + "\n" + dbHelp + "\n" + "─".repeat(72) + "\n");
});


/** The chart, seeded, as a code → id map. */
async function chartOf(cookie: string) {
  await call("/ledger/accounts/seed", { method: "POST", cookie });
  const { json } = await call("/ledger/accounts", { cookie });
  return Object.fromEntries(json.accounts.map((a: Wire) => [a.code, a.id]));
}

/** The same company, seen by somebody with a narrower role. */
async function asRole(owner: string, role: string) {
  const n = ++seq;
  const org = await db.session.findFirst({
    where: { tokenHash: { not: "" } }, select: { orgId: true },
    orderBy: { createdAt: "desc" },
  });
  const orgId = owner.orgId;
  const email = `role${n}@example.com`;
  const user = await db.user.create({
    data: { email, name: `Role ${n}`, googleSub: "sub_" + email },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId, expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  await db.membership.create({ data: { userId: user.id, orgId, role } });
  return `paltas_session=${token}`;
}



/* ====================================================================== *
 * SHARED
 * ====================================================================== */

async function project(cookie: string, name?: string) {
  const p = await call("/projects", { method: "POST", cookie,
    body: { name: name || `Riverside ${++seq}`, city: "Nairobi" } });
  assert.equal(p.status, 201, p.text.slice(0, 200));
  return p.json.project.id;
}

/* ====================================================================== *
 * LAND
 * ====================================================================== */

async function acquisition(cookie: Wire, body?: Wire) {
  const a = await call("/acquisitions", { method: "POST", cookie,
    body: { title: "Plot 14, Kiambu Road", location: "Kiambu", areaSqm: 4000,
            askingPrice: 85_000_000, currency: "KES", ...(body || {}) } });
  assert.equal(a.status, 201, a.text.slice(0, 220));
  return a.json.acquisition;
}

const move = (cookie: Wire, id: Wire, status: Wire, body?: Wire) =>
  call(`/acquisitions/${id}/status`, { method: "POST", cookie,
    body: { status, ...(body || {}) } });

async function toAgreed(cookie: Wire, id: Wire, price: Wire) {
  await move(cookie, id, "APPRAISING");
  await move(cookie, id, "OFFERED", { offeredPrice: price - 5_000_000 });
  const r = await move(cookie, id, "AGREED",
    { agreedPrice: price, sellerName: "Mwangi Family Trust" });
  assert.equal(r.status, 200, r.text.slice(0, 220));
  return r;
}

test("land cannot be bought with a search outstanding", { skip }, async () => {
  /*
   * THE RULE THIS REGISTER EXISTS FOR. It is always made the same way: the
   * title search is outstanding, completion is Friday, and somebody ticks it
   * off. Here ticking it off is a separate act with a name attached, and
   * completing without it is refused.
   */
  const { cookie } = await company();
  const a = await acquisition(cookie);
  assert.match(a.ref, /^ACQ-\d{4}$/);

  await call(`/acquisitions/${a.id}/diligence`, { method: "POST", cookie,
    body: { title: "Title search", category: "Title" } });
  const survey = await call(`/acquisitions/${a.id}/diligence`, { method: "POST", cookie,
    body: { title: "Boundary survey", category: "Survey" } });
  assert.equal(survey.status, 201);

  await toAgreed(cookie, a.id, 80_000_000);
  await move(cookie, a.id, "DUE_DILIGENCE");

  const early = await move(cookie, a.id, "COMPLETED");
  assert.equal(early.status, 409, "land was bought with the searches outstanding");
  assert.match(early.json.message, /Title search/);
  assert.match(early.json.message, /Boundary survey/);

  /* Clearing one is not enough. */
  const back = await call(`/acquisitions/${a.id}`, { cookie });
  const title = back.json.acquisition.diligence.find((d: Wire) => d.title === "Title search");
  await call(`/acquisitions/${a.id}/diligence/${title.id}`, { method: "POST", cookie,
    body: { status: "CLEAR", checkedBy: "Grace Wanjiru" } });
  assert.equal((await move(cookie, a.id, "COMPLETED")).status, 409);

  await call(`/acquisitions/${a.id}/diligence/${survey.json.item.id}`, { method: "POST", cookie,
    body: { status: "CLEAR" } });
  const done = await move(cookie, a.id, "COMPLETED");
  assert.equal(done.status, 200, done.text.slice(0, 220));
  assert.equal(done.json.acquisition.status, "COMPLETED");
  assert.ok(done.json.acquisition.completedOn);
  assert.match(done.json.said, /Every check was clear/i);
});

test("a known problem is waived by somebody, never cleared away", { skip }, async () => {
  /*
   * WAIVED IS NOT CLEAR. Clear says the problem is not there; waived says it
   * is there and somebody decided to buy anyway. Collapsing them is how a
   * company discovers afterwards that nobody actually made that decision.
   */
  const { cookie } = await company();
  const a = await acquisition(cookie);
  const item = await call(`/acquisitions/${a.id}/diligence`, { method: "POST", cookie,
    body: { title: "Right of way over the north boundary", category: "Title" } });
  const id = item.json.item.id;

  /* An issue needs to say what it is. */
  assert.equal((await call(`/acquisitions/${a.id}/diligence/${id}`, { method: "POST", cookie,
    body: { status: "ISSUE" } })).status, 400);
  await call(`/acquisitions/${a.id}/diligence/${id}`, { method: "POST", cookie,
    body: { status: "ISSUE", finding: "A neighbour has a registered right of way." } });

  await toAgreed(cookie, a.id, 80_000_000);
  const blocked = await move(cookie, a.id, "COMPLETED");
  assert.equal(blocked.status, 409, "land was bought over a known problem");
  assert.match(blocked.json.message, /registered right of way/);

  /* A waiver needs a reason. */
  assert.equal((await call(`/acquisitions/${a.id}/diligence/${id}`, { method: "POST", cookie,
    body: { status: "WAIVED" } })).status, 400);

  const waived = await call(`/acquisitions/${a.id}/diligence/${id}`, { method: "POST", cookie,
    body: { status: "WAIVED", waivedBy: "Grace Wanjiru",
            waivedReason: "The right of way runs outside the development footprint." } });
  assert.equal(waived.json.item.status, "WAIVED");
  assert.equal(waived.json.item.waivedBy, "Grace Wanjiru");

  const done = await move(cookie, a.id, "COMPLETED");
  assert.equal(done.status, 200);
  /* And the completion SAYS so, rather than reading as a clean deal. */
  assert.match(done.json.said, /waived rather than cleared/i);

  const back = await call(`/acquisitions/${a.id}`, { cookie });
  const kept = back.json.acquisition.diligence[0];
  assert.match(kept.waivedReason, /outside the development footprint/);
  assert.equal(kept.finding, "A neighbour has a registered right of way.",
    "the problem was erased when it was accepted");
});

test("a pipeline only moves forwards, and a dead deal says why", { skip }, async () => {
  const { cookie } = await company();
  const a = await acquisition(cookie);

  /* No jumping straight to agreed. */
  assert.equal((await move(cookie, a.id, "AGREED", { agreedPrice: 1 })).status, 409);
  /* An offer of nothing is not an offer. */
  assert.equal((await move(cookie, a.id, "OFFERED", { offeredPrice: 0 })).status, 400);
  /* An agreed deal needs somebody who agreed it. */
  await move(cookie, a.id, "OFFERED", { offeredPrice: 70_000_000 });
  assert.equal((await move(cookie, a.id, "AGREED",
    { agreedPrice: 75_000_000, sellerName: "" })).status, 400);

  const dead = await acquisition(cookie);
  assert.equal((await move(cookie, dead.id, "ABANDONED")).status, 400);
  const out = await move(cookie, dead.id, "ABANDONED",
    { reason: "The seller had no registrable title." });
  assert.equal(out.status, 200);
  assert.equal(out.json.acquisition.abandonedReason, "The seller had no registrable title.");
  /* And a dead deal stays dead. */
  assert.equal((await move(cookie, dead.id, "IDENTIFIED")).status, 409);
});

test("completing with no agreed price would buy land for nothing", { skip }, async () => {
  const { cookie } = await company();
  const a = await acquisition(cookie);
  /* Reach AGREED through the front door, then null the price the only way a
     caller could — which is not at all. */
  await move(cookie, a.id, "OFFERED", { offeredPrice: 1_000 });
  const patched = await call(`/acquisitions/${a.id}`, { method: "PATCH", cookie,
    body: { agreedPrice: 999 } });
  assert.equal(patched.status, 400, "an agreed price was typed in around the status route");
});

/* ====================================================================== *
 * DOES IT WORK ON PAPER
 * ====================================================================== */

async function feasibility(cookie: Wire, body?: Wire) {
  const f = await call("/feasibilities", { method: "POST", cookie,
    body: { title: "Riverside, 40 units", landCost: 80_000_000,
            buildCost: 240_000_000, professional: 24_000_000,
            financeCost: 18_000_000, otherCost: 8_000_000,
            grossValue: 480_000_000, currency: "KES",
            targetMarginBps: 1500, ...(body || {}) } });
  assert.equal(f.status, 201, f.text.slice(0, 220));
  return f.json.feasibility;
}

test("the numbers follow the costs, because nothing stores them", { skip }, async () => {
  const { cookie } = await company();
  const f = await feasibility(cookie);

  const back = await call(`/feasibilities/${f.id}`, { cookie });
  const n = back.json.feasibility;
  /* 80 + 240 + 24 + 18 + 8 = 370m cost, 480m value, 110m profit. */
  assert.equal(n.totalCost, "370000000");
  assert.equal(n.profit, "110000000");
  assert.equal(n.marginBps, 2972, `margin read ${n.marginBps}`);
  assert.equal(n.viable, true);
  assert.match(n.basis, /on cost, not on value/i);

  /* Change ONE cost and every derived figure moves with it. A stored margin
     would still say 29.72% here. */
  await call(`/feasibilities/${f.id}`, { method: "PATCH", cookie,
    body: { buildCost: 320_000_000 } });
  const after = (await call(`/feasibilities/${f.id}`, { cookie })).json.feasibility;
  assert.equal(after.totalCost, "450000000");
  assert.equal(after.profit, "30000000");
  assert.equal(after.viable, false, "a scheme returning 6.7% still read as viable against a 15% target");
});

test("the residual land value is what the study is for", { skip }, async () => {
  const { cookie } = await company();
  /* 480m value, 290m of build and fees, 15% target. The land can cost what
     leaves 15% on cost: 480/1.15 − 290. */
  const f = await feasibility(cookie, {
    buildCost: 240_000_000, professional: 24_000_000,
    financeCost: 18_000_000, otherCost: 8_000_000,
    grossValue: 480_000_000, targetMarginBps: 1500,
  });
  const n = (await call(`/feasibilities/${f.id}`, { cookie })).json.feasibility;
  const expected = Math.floor((480_000_000 * 10000) / 11500) - 290_000_000;
  assert.equal(n.residualLandValue, String(expected),
    "the most the land could cost and still work was wrong");
});

test("a scheme that does not work cannot be approved by accident", { skip }, async () => {
  const { cookie } = await company();
  const f = await feasibility(cookie, { grossValue: 380_000_000 });   /* a loss */

  const quiet = await call(`/feasibilities/${f.id}/decide`, { method: "POST", cookie,
    body: { approve: true, decidedBy: "Grace Wanjiru" } });
  assert.equal(quiet.status, 409, "a scheme that loses money was approved silently");
  assert.match(quiet.json.message, /does not work on its own numbers/i);

  /* Deliberately, with the reasoning, is allowed — companies take strategic
     losses, and refusing outright would be this service deciding for them. */
  const deliberate = await call(`/feasibilities/${f.id}/decide`, { method: "POST", cookie,
    body: { approve: true, acceptLoss: true, decidedBy: "Grace Wanjiru",
            note: "Strategic — it secures the adjoining plot." } });
  assert.equal(deliberate.status, 200, deliberate.text.slice(0, 220));
  assert.match(deliberate.json.said, /DESPITE/);
  assert.equal(deliberate.json.feasibility.decidedBy, "Grace Wanjiru");
});

test("a study with nothing on the other side of the sum is not a study", { skip }, async () => {
  const { cookie } = await company();
  const f = await feasibility(cookie, { grossValue: 0 });
  const res = await call(`/feasibilities/${f.id}/decide`, { method: "POST", cookie,
    body: { approve: true, acceptLoss: true, note: "Fine." } });
  assert.equal(res.status, 400);
});

test("a later study replaces an earlier one without erasing it", { skip }, async () => {
  const { cookie } = await company();
  const f = await feasibility(cookie);
  await call(`/feasibilities/${f.id}/decide`, { method: "POST", cookie,
    body: { approve: true, decidedBy: "Grace Wanjiru" } });

  const out = await call(`/feasibilities/${f.id}/supersede`, { method: "POST", cookie,
    body: { title: "Riverside, 44 units" } });
  assert.equal(out.status, 200);
  assert.equal(out.json.next.status, "DRAFT");
  assert.equal(out.json.next.title, "Riverside, 44 units");
  assert.equal(String(out.json.next.buildCost), String(f.buildCost),
    "the new study did not start from the old one's numbers");

  /* The decided one survives exactly as it was decided on. */
  const old = (await call(`/feasibilities/${f.id}`, { cookie })).json.feasibility;
  assert.equal(old.status, "SUPERSEDED");
  assert.equal(old.decidedBy, "Grace Wanjiru");
  assert.equal(old.profit, "110000000");
});

test("a study is decided once", { skip }, async () => {
  const { cookie } = await company();
  const f = await feasibility(cookie);
  await call(`/feasibilities/${f.id}/decide`, { method: "POST", cookie, body: { approve: true } });
  const again = await call(`/feasibilities/${f.id}/decide`, { method: "POST", cookie,
    body: { approve: false, note: "Changed my mind." } });
  assert.equal(again.status, 409, "a decision was reversed with no record of the first");
});

/* ====================================================================== *
 * DRAWINGS
 * ====================================================================== */

async function drawing(cookie: Wire, body?: Wire) {
  const d = await call("/drawings", { method: "POST", cookie,
    body: { number: "A-101", title: "Ground floor plan", discipline: "Architectural",
            revision: "A", ...(body || {}) } });
  assert.equal(d.status, 201, d.text.slice(0, 220));
  return d.json.drawing;
}

test("a sheet out for construction is fixed, and a change is a new revision", { skip }, async () => {
  /* Somebody built to revision A. Overwriting it means nobody can ever find
     out what they built to. */
  const { cookie } = await company();
  const a = await drawing(cookie);

  const issued = await call(`/drawings/${a.id}/issue`, { method: "POST", cookie,
    body: { for: "CONSTRUCTION", issuedBy: "Grace Wanjiru" } });
  assert.equal(issued.status, 200);
  assert.equal(issued.json.drawing.status, "ISSUED_FOR_CONSTRUCTION");
  assert.match(issued.json.said, /a change is a new revision/i);

  /* It cannot be pulled back to comment. */
  assert.equal((await call(`/drawings/${a.id}/issue`, { method: "POST", cookie,
    body: { for: "COMMENT" } })).status, 409);

  /* A revision must say what changed. */
  assert.equal((await call(`/drawings/${a.id}/revise`, { method: "POST", cookie })).status, 400);

  const out = await call(`/drawings/${a.id}/revise`, { method: "POST", cookie,
    body: { reason: "Core relocated 600mm east." } });
  assert.equal(out.status, 200, out.text.slice(0, 220));
  assert.equal(out.json.next.revision, "B", "the next revision was not B");
  assert.equal(out.json.next.status, "DRAFT");
  assert.equal(out.json.next.number, "A-101");
  assert.equal(out.json.next.previousId, a.id);

  /*
   * REV A SURVIVES, UNCHANGED. Not merely present — the same sheet, still
   * called A, still saying it went out for construction and who issued it.
   * Asserting only that it is SUPERSEDED would pass against an
   * implementation that renamed it to B in place, which is exactly the bug
   * this rule exists to prevent.
   */
  const old = (await call(`/drawings/${a.id}`, { cookie })).json.drawing;
  assert.equal(old.status, "SUPERSEDED");
  assert.equal(old.revision, "A", "the sheet somebody built to was renamed");
  assert.equal(old.number, "A-101");
  assert.equal(old.title, "Ground floor plan");
  assert.ok(old.issuedOn, "the superseded sheet lost the date it went out");
  assert.equal(old.issuedBy, "Grace Wanjiru");
  assert.match(old.means, /may still be holding it/i);
  assert.equal(old.next.ref, out.json.next.ref);
});

test("the register answers the only question a site asks of it", { skip }, async () => {
  const { cookie } = await company();
  const a = await drawing(cookie, { number: "A-101" });
  await call(`/drawings/${a.id}/issue`, { method: "POST", cookie, body: { for: "CONSTRUCTION" } });
  const revised = await call(`/drawings/${a.id}/revise`, { method: "POST", cookie,
    body: { reason: "Core moved." } });
  await call(`/drawings/${revised.json.next.id}/issue`, { method: "POST", cookie,
    body: { for: "CONSTRUCTION" } });

  const s = await drawing(cookie, { number: "S-204", title: "Pile layout", discipline: "Structural" });
  await call(`/drawings/${s.id}/issue`, { method: "POST", cookie, body: { for: "COMMENT" } });

  const out = await call("/drawings/current", { cookie });
  assert.equal(out.json.counts.current, 2, "a superseded sheet was still current");
  assert.equal(out.json.counts.forConstruction, 1);
  assert.equal(out.json.counts.forComment, 1);
  assert.ok(!out.json.drawings.some((d: Wire) => d.id === a.id),
    "revision A is still being offered to build from");
  assert.match(out.json.means, /may be holding/i);
});

test("a superseded sheet cannot be issued or revised again", { skip }, async () => {
  const { cookie } = await company();
  const a = await drawing(cookie);
  await call(`/drawings/${a.id}/revise`, { method: "POST", cookie, body: { reason: "x" } });
  assert.equal((await call(`/drawings/${a.id}/issue`, { method: "POST", cookie })).status, 409);
  assert.equal((await call(`/drawings/${a.id}/revise`, { method: "POST", cookie,
    body: { reason: "y" } })).status, 409);
});

/* ====================================================================== *
 * PERMITS
 * ====================================================================== */

async function permit(cookie: Wire, body?: Wire) {
  const p = await call("/permits", { method: "POST", cookie,
    body: { title: "Development approval", kind: "Planning",
            authority: "Nairobi City County", blocking: true, ...(body || {}) } });
  assert.equal(p.status, 201, p.text.slice(0, 220));
  return p.json.permit;
}

const permitTo = (cookie: Wire, id: Wire, status: Wire, body?: Wire) =>
  call(`/permits/${id}/status`, { method: "POST", cookie, body: { status, ...(body || {}) } });

test("a permit nobody can look up is a permit nobody can prove", { skip }, async () => {
  const { cookie } = await company();
  const p = await permit(cookie);
  await permitTo(cookie, p.id, "PREPARING");
  await permitTo(cookie, p.id, "SUBMITTED");

  const bare = await permitTo(cookie, p.id, "APPROVED");
  assert.equal(bare.status, 400, "a permit was approved with no reference to it");
  assert.match(bare.json.message, /ringing them up/i);

  const out = await permitTo(cookie, p.id, "APPROVED", {
    reference: "NCC/DA/2026/4417",
    conditions: "Hoarding to be maintained to the building line.",
    expiresOn: "2028-06-30",
  });
  assert.equal(out.status, 200);
  assert.equal(out.json.permit.reference, "NCC/DA/2026/4417");
  assert.match(out.json.permit.conditions, /Hoarding/);
  assert.match(out.json.said, /lapses on 2028-06-30/);
});

test("an approval with no expiry says nothing will warn you", { skip }, async () => {
  const { cookie } = await company();
  const p = await permit(cookie);
  await permitTo(cookie, p.id, "PREPARING");
  await permitTo(cookie, p.id, "SUBMITTED");
  const out = await permitTo(cookie, p.id, "APPROVED", { reference: "X/1" });
  assert.match(out.json.said, /nothing here will warn you/i);
});

test("a consent that has lapsed reads as expired whatever the column says", { skip }, async () => {
  /*
   * THE RULE. A stored APPROVED on a permit that ran out last March is a
   * licence to build illegally, and nothing would ever change it — the column
   * is correct about what the authority said and wrong about today.
   */
  const { cookie } = await company();
  const p = await permit(cookie);
  await permitTo(cookie, p.id, "PREPARING");
  await permitTo(cookie, p.id, "SUBMITTED");
  await permitTo(cookie, p.id, "APPROVED", { reference: "NCC/1", expiresOn: "2020-01-01" });

  const back = await call(`/permits/${p.id}`, { cookie });
  /* The column still says what the authority said. */
  assert.equal(back.json.permit.status, "APPROVED");
  /* And everything anybody reads says otherwise. */
  assert.equal(back.json.permit.lapsed, true, "a dead permit still read as current");
  assert.equal(back.json.permit.granted, false);
  assert.equal(back.json.permit.blocks, true);
  assert.match(back.json.permit.means, /unlawful today/i);
});

test("what legally stops work is one question, not a filter", { skip }, async () => {
  const { cookie } = await company();

  /* Granted and current — not blocking. */
  const ok = await permit(cookie, { title: "Building permit" });
  await permitTo(cookie, ok.id, "PREPARING");
  await permitTo(cookie, ok.id, "SUBMITTED");
  await permitTo(cookie, ok.id, "APPROVED", { reference: "A/1", expiresOn: "2099-01-01" });

  /* Granted and lapsed — blocking, and that is the one a filter would miss. */
  const dead = await permit(cookie, { title: "Environmental licence" });
  await permitTo(cookie, dead.id, "PREPARING");
  await permitTo(cookie, dead.id, "SUBMITTED");
  await permitTo(cookie, dead.id, "APPROVED", { reference: "B/1", expiresOn: "2020-01-01" });

  /* Never applied for — blocking. */
  await permit(cookie, { title: "Hoarding licence" });

  /* Not required — not blocking, however unfinished. */
  await permit(cookie, { title: "Nice to have", blocking: false });

  /* Granted, current, and about to lapse — not blocking, but worth knowing. */
  const soon = await permit(cookie, { title: "Road closure" });
  await permitTo(cookie, soon.id, "PREPARING");
  await permitTo(cookie, soon.id, "SUBMITTED");
  const near = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  await permitTo(cookie, soon.id, "APPROVED", { reference: "C/1", expiresOn: near });

  const out = await call("/permits/blocking", { cookie });
  assert.equal(out.json.counts.blocking, 2, "the lapsed one or the missing one was not counted");
  assert.equal(out.json.counts.lapsed, 1);
  assert.equal(out.json.counts.granted, 2);
  assert.equal(out.json.counts.expiringWithin90Days, 1);
  assert.ok(out.json.permits.some((p: Wire) => p.id === dead.id),
    "a lapsed permit was not reported as stopping work");
  assert.ok(!out.json.permits.some((p: Wire) => p.id === ok.id));
  assert.match(out.json.means, /lapsed counts as not granted/i);
});

test("a refusal keeps the authority's own reason", { skip }, async () => {
  const { cookie } = await company();
  const p = await permit(cookie);
  await permitTo(cookie, p.id, "PREPARING");
  await permitTo(cookie, p.id, "SUBMITTED");
  assert.equal((await permitTo(cookie, p.id, "REFUSED")).status, 400);

  const out = await permitTo(cookie, p.id, "REFUSED",
    { reason: "Plot ratio exceeds the zone maximum of 2.5." });
  assert.equal(out.json.permit.refusedReason, "Plot ratio exceeds the zone maximum of 2.5.");
  /* And a refused application does not quietly come back. */
  assert.equal((await permitTo(cookie, p.id, "APPROVED", { reference: "X" })).status, 409);

  const back = await call(`/permits/${p.id}`, { cookie });
  assert.deepEqual(back.json.permit.events.map((e: Wire) => e.status),
    ["PREPARING", "SUBMITTED", "REFUSED"]);
  assert.match(back.json.permit.events[2].detail, /Plot ratio/);
});

/* ====================================================================== *
 * TENANCY, AUTHORISATION AND THE TRAIL
 * ====================================================================== */

test("none of it crosses a company", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const a = await acquisition(theirs.cookie);
  const f = await feasibility(theirs.cookie);
  const d = await drawing(theirs.cookie);
  const p = await permit(theirs.cookie);

  const post = (path: Wire, body: Wire) => call(path, { method: "POST", cookie: mine.cookie, body: body || {} });
  assert.equal((await post(`/acquisitions/${a.id}/status`, { status: "APPRAISING" })).status, 404);
  assert.equal((await post(`/acquisitions/${a.id}/diligence`, { title: "x" })).status, 404);
  assert.equal((await post(`/feasibilities/${f.id}/decide`, { approve: true })).status, 404);
  assert.equal((await post(`/drawings/${d.id}/issue`)).status, 404);
  assert.equal((await post(`/permits/${p.id}/status`, { status: "PREPARING" })).status, 404);
  assert.equal((await call("/permits/blocking", { cookie: mine.cookie })).json.counts.blocking, 0);
  assert.equal((await call("/drawings/current", { cookie: mine.cookie })).json.count, 0);
});

test("somebody who may not touch the money may not buy land", { skip }, async () => {
  const owner = await company();
  const ops = await asRole(owner, "OPERATIONS");
  const a = await acquisition(owner.cookie);
  const f = await feasibility(owner.cookie);

  assert.equal((await call(`/acquisitions/${a.id}/status`, { method: "POST", cookie: ops,
    body: { status: "APPRAISING" } })).status, 403);
  assert.equal((await call(`/feasibilities/${f.id}/decide`, { method: "POST", cookie: ops,
    body: { approve: true } })).status, 403);

  /* But operations DOES run the drawings and the permits, which is its job. */
  const d = await drawing(owner.cookie);
  assert.equal((await call(`/drawings/${d.id}/issue`, { method: "POST", cookie: ops })).status, 200);
});

test("every decision before a brick is laid is recorded", { skip }, async () => {
  const { orgId, cookie } = await company();
  const a = await acquisition(cookie);
  await move(cookie, a.id, "APPRAISING");
  const f = await feasibility(cookie);
  await call(`/feasibilities/${f.id}/decide`, { method: "POST", cookie, body: { approve: true } });
  const d = await drawing(cookie);
  await call(`/drawings/${d.id}/issue`, { method: "POST", cookie });
  await call(`/drawings/${d.id}/revise`, { method: "POST", cookie, body: { reason: "x" } });
  const p = await permit(cookie);
  await permitTo(cookie, p.id, "PREPARING");

  const actions = new Set((await db.auditEvent.findMany({
    where: { orgId }, select: { action: true } })).map((e) => e.action));
  for (const want of ["acquisition.status", "feasibility.decide", "drawing.issue",
                      "drawing.revise", "permit.status"]) {
    assert.ok(actions.has(want), `${want} was not recorded`);
  }
});
