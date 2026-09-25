/* ====================================================================== *
 * ONE DEVELOPMENT ON ONE PAGE, AND WHAT IT COULD NOT WORK OUT.
 *
 * A report that shows 0 where it has no data is worse than no report. Zero
 * defects and "nobody has recorded any defects" look identical on a screen
 * and mean opposite things — and it is always the second one, the site that
 * has not started snagging, that a green dashboard is hiding.
 *
 * So every test below is about that distinction. An empty register reports
 * `recorded: false` and is named in `unrecorded`; a register with rows and
 * nothing outstanding reports `recorded: true` and a genuine zero. Nothing is
 * estimated, a figure that cannot be computed is absent rather than plausible,
 * and money is absent entirely for somebody who may not see it.
 *
 * The activity trail is tested for the same thing it has always been tested
 * for: it adds no reach. Somebody sees events about models they may already
 * read, and nothing else.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_reports";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping report tests";
let dbHelp = null;
let createApp, db, pg;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
    ({ createApp } = await import("../src/server.ts"));
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = String(e && e.message);
    if (/did not initialize|locate the Query Engine|generate/.test(m)) {
      skip = "RUN `npx prisma generate` FIRST";
    } else {
      const help = explain(e, DB);
      if (help) { skip = "database configuration — see below"; dbHelp = help; }
      else skip = "database unreachable: " + m.slice(0, 90);
    }
  }
}

let server, base, pool;

async function boot() {
  pool = poolInSchema(pg, DB, SCHEMA);
  await freshSchema(pool, SCHEMA);
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
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
  const me = await db.session.findFirst({
    where: { tokenHash: crypto.createHash("sha256").update(token).digest("hex") },
    select: { orgId: true, userId: true },
  });
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

async function call(path, { method = "GET", body, cookie, headers } = {}) {
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
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const n = (v) => Number(v);

/**
 * A property with a unit, a tenant on a lease, an invoice issued against that
 * lease, and the rent paid. This is the shape every per-entity statement
 * needs, and it is the shape that proves the posting bridge stamps its
 * dimensions.
 */
async function tenancy(cookie, { rent = 8_500_000, pay = true } = {}) {
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
async function chartOf(cookie) {
  await call("/ledger/accounts/seed", { method: "POST", cookie });
  const { json } = await call("/ledger/accounts", { cookie });
  return Object.fromEntries(json.accounts.map((a) => [a.code, a.id]));
}

/** The same company, seen by somebody with a narrower role. */
async function asRole(owner, role) {
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

async function project(cookie, name) {
  const p = await call("/projects", { method: "POST", cookie,
    body: { name: name || `Riverside ${++seq}`, city: "Nairobi", currency: "KES" } });
  assert.equal(p.status, 201, p.text.slice(0, 200));
  return p.json.project;
}

const report = (cookie, id) => call(`/projects/${id}/report`, { cookie });

/* ====================================================================== *
 * AN EMPTY REGISTER IS NOT A CLEAN ONE
 * ====================================================================== */

test("a development nobody has touched says so, rather than showing zeroes", { skip }, async () => {
  /*
   * THE RULE. Zero defects and "nobody has recorded any defects" look
   * identical as a number, and it is always the second one that matters.
   */
  const { cookie } = await company();
  const p = await project(cookie);
  const out = await report(cookie, p.id);
  assert.equal(out.status, 200, out.text.slice(0, 240));

  assert.equal(out.json.programme.recorded, false);
  assert.equal(out.json.programme.progress, null,
    "a development with no phases reported a weighted progress it could not compute");
  assert.equal(out.json.blockers.defects.recorded, false);
  assert.equal(out.json.blockers.defects.critical, 0);
  assert.equal(out.json.blockers.rfis.recorded, false);
  assert.equal(out.json.blockers.permits.recorded, false);

  /* And they are named out loud, not left as a suspiciously quiet dashboard. */
  const said = out.json.unrecorded.join(" | ");
  assert.match(said, /no programme/i);
  assert.match(said, /no RFIs have ever been raised/i);
  assert.match(said, /no permits recorded/i);
  assert.match(said, /nothing has been inspected/i);
  assert.match(said, /nobody is recorded as being on this job/i);

  assert.deepEqual(out.json.attention, []);
  assert.match(out.json.means, /not the same as clear/i);
});

test("a register with rows and nothing wrong is a genuine zero", { skip }, async () => {
  const { cookie } = await company();
  const p = await project(cookie);

  /* One defect, raised and settled by two people. */
  const d = await call("/defects", { method: "POST", cookie,
    body: { projectId: p.id, title: "Chipped tile", severity: "MAJOR" } });
  await call(`/defects/${d.json.defect.id}/fixed`, { method: "POST", cookie,
    body: { fixedByName: "Peter Mwangi" } });
  await call(`/defects/${d.json.defect.id}/verify`, { method: "POST", cookie,
    body: { verifiedByName: "Grace Wanjiru" } });

  const out = await report(cookie, p.id);
  assert.equal(out.json.blockers.defects.recorded, true,
    "a register with a row in it read as empty");
  assert.equal(out.json.blockers.defects.total, 1);
  assert.equal(out.json.blockers.defects.major, 0, "a verified defect still read as open");
  assert.ok(!out.json.unrecorded.some((u) => /inspected/.test(u)),
    "a project with a settled defect was reported as never having been snagged");
});

/* ====================================================================== *
 * WHAT NEEDS SOMEBODY TODAY
 * ====================================================================== */

test("the report names what is wrong rather than scoring it", { skip }, async () => {
  const { cookie } = await company();
  const p = await project(cookie);

  /* A permit required and never granted. */
  await call("/permits", { method: "POST", cookie,
    body: { projectId: p.id, title: "Building permit", blocking: true } });

  /* A critical defect. */
  await call("/defects", { method: "POST", cookie,
    body: { projectId: p.id, title: "No fire stopping to the riser", severity: "CRITICAL" } });

  /* A question nobody answered in time. */
  await call("/rfis", { method: "POST", cookie,
    body: { projectId: p.id, subject: "Cladding fixing", dueOn: "2020-01-01" } });

  /* A milestone that went past. */
  await call("/milestones", { method: "POST", cookie,
    body: { projectId: p.id, name: "Watertight", dueOn: "2020-01-01" } });

  const out = await report(cookie, p.id);
  const said = out.json.attention.join(" | ");
  assert.match(said, /permit/i);
  assert.match(said, /cannot lawfully proceed/i);
  assert.match(said, /critical defect/i);
  assert.match(said, /unanswered past the date/i);
  assert.match(said, /milestone/i);
  assert.match(out.json.means, /need somebody today/i);

  /* No score. A number out of ten invites somebody to improve the number. */
  assert.equal(out.json.score, undefined);
  assert.equal(out.json.health, undefined);
});

test("a lapsed permit counts against the project, not for it", { skip }, async () => {
  const { cookie } = await company();
  const p = await project(cookie);
  const perm = await call("/permits", { method: "POST", cookie,
    body: { projectId: p.id, title: "Environmental licence", blocking: true } });
  const id = perm.json.permit.id;
  const step = (status, body) => call(`/permits/${id}/status`, { method: "POST", cookie,
    body: { status, ...(body || {}) } });
  await step("PREPARING");
  await step("SUBMITTED");
  await step("APPROVED", { reference: "NEMA/1", expiresOn: "2020-01-01" });

  const out = await report(cookie, p.id);
  assert.equal(out.json.blockers.permits.granted, 0,
    "a consent that lapsed was counted as granted");
  assert.equal(out.json.blockers.permits.lapsed, 1);
  assert.equal(out.json.blockers.permits.blocking, 1);
  assert.match(out.json.attention.join(" "), /cannot lawfully proceed/i);
});

test("progress is the weighted average the development screen uses", { skip }, async () => {
  const { cookie } = await company();
  const p = await project(cookie);
  await call("/project-phases", { method: "POST", cookie,
    body: { projectId: p.id, name: "Substructure", weight: 3, progress: 100 } });
  await call("/project-phases", { method: "POST", cookie,
    body: { projectId: p.id, name: "Superstructure", weight: 1, progress: 20 } });

  const out = await report(cookie, p.id);
  /* (100×3 + 20×1) / 4 = 80. Not the plain average of 60. */
  assert.equal(out.json.programme.progress, 80,
    "the report and the development screen would have told two stories");
  assert.equal(out.json.programme.recorded, true);
  assert.match(out.json.programme.from, /weighted average/i);
});

/* ====================================================================== *
 * MONEY, AND WHO MAY SEE IT
 * ====================================================================== */

test("committed and spent are two numbers, never one", { skip }, async () => {
  const { cookie } = await company();
  const p = await project(cookie);

  const live = await call("/purchase-orders", { method: "POST", cookie,
    body: { projectId: p.id, title: "Steel", vendorName: "Kilimani Steel", currency: "KES" } });
  await call(`/purchase-orders/${live.json.purchaseOrder.id}/lines`, { method: "POST", cookie,
    body: { description: "Y12", quantity: 1000, unitPrice: 300_000 } });
  await call(`/purchase-orders/${live.json.purchaseOrder.id}/issue`, { method: "POST", cookie });

  const billed = await call("/purchase-orders", { method: "POST", cookie,
    body: { projectId: p.id, title: "Blocks", vendorName: "Athi", currency: "KES" } });
  await call(`/purchase-orders/${billed.json.purchaseOrder.id}/lines`, { method: "POST", cookie,
    body: { description: "Blocks", quantity: 1000, unitPrice: 120_000 } });
  await call(`/purchase-orders/${billed.json.purchaseOrder.id}/issue`, { method: "POST", cookie });
  await call(`/purchase-orders/${billed.json.purchaseOrder.id}/invoice`, { method: "POST", cookie });

  const out = await report(cookie, p.id);
  assert.equal(out.json.money.purchasing.committed, "300000",
    "an order already in the books was still counted as committed");
  assert.equal(out.json.money.purchasing.invoiced, "120000");
  assert.match(out.json.money.purchasing.note, /not in the ledger/i);
});

test("an approved variation shows beside the signed figure, not instead of it", { skip }, async () => {
  const { cookie } = await company();
  const p = await project(cookie);
  const c = await call("/contracts", { method: "POST", cookie,
    body: { projectId: p.id, price: 10_000_000, currency: "KES" } });
  const v = await call("/change-orders", { method: "POST", cookie,
    body: { contractId: c.json.contract.id, projectId: p.id, title: "Worktops",
            amount: 500_000, currency: "KES" } });
  await call(`/change-orders/${v.json.changeOrder.id}/submit`, { method: "POST", cookie });
  await call(`/change-orders/${v.json.changeOrder.id}/decide`, { method: "POST", cookie,
    body: { approve: true } });

  const out = await report(cookie, p.id);
  assert.equal(out.json.money.sales.signed, "10000000");
  assert.equal(out.json.money.sales.approvedVariations, "500000");
  assert.equal(out.json.money.sales.currentValue, "10500000");
  assert.match(out.json.money.sales.note, /never changes/i);
});

test("somebody who may not see money gets a report with none in it", { skip }, async () => {
  /* Absent, not zeroed. A zero somebody is not allowed to see is still a
     number about the company. */
  const owner = await company();
  const p = await project(owner.cookie);
  await call("/contracts", { method: "POST", cookie: owner.cookie,
    body: { projectId: p.id, price: 10_000_000, currency: "KES" } });

  /*
   * A security administrator reads the property and NOT the money — which is
   * the case worth testing: the report is served, and the money is ABSENT
   * rather than zeroed. A zero somebody is not allowed to see is still a
   * number about the company, and a section of zeroes reads as a company with
   * no sales rather than as a reader with no permission.
   */
  const guard = await asRole(owner, "SECURITY_MANAGER");
  const blind = await call(`/projects/${p.id}/report`, { cookie: guard });
  assert.equal(blind.status, 200);
  assert.equal(blind.json.moneyVisible, false);
  assert.equal(blind.json.money, null, "money was zeroed rather than withheld");
  /* And the rest of the report is really there. */
  assert.ok(blind.json.programme);
  assert.ok(blind.json.blockers);

  const ops = await asRole(owner, "OPERATIONS");
  const partial = await call(`/projects/${p.id}/report`, { cookie: ops });
  assert.equal(partial.status, 200);
  /* Operations holds finance at READ, so it does see the money. The point is
     that the report asks rather than assuming. */
  assert.equal(partial.json.moneyVisible, true);
  assert.ok(partial.json.money);

  const promo = await asRole(owner, "PROMO_CONTRIBUTOR");
  const none = await call(`/projects/${p.id}/report`, { cookie: promo });
  assert.equal(none.status, 403, "somebody who cannot read the property read its report");
});

/* ====================================================================== *
 * THE TRAIL, NARROWED TO ONE DEVELOPMENT
 * ====================================================================== */

test("the trail shows what happened to this development and nothing else", { skip }, async () => {
  const { cookie } = await company();
  const mine = await project(cookie, "Riverside");
  const other = await project(cookie, "Kilimani");

  const a = await call("/rfis", { method: "POST", cookie,
    body: { projectId: mine.id, subject: "Mine" } });
  await call(`/rfis/${a.json.rfi.id}/answer`, { method: "POST", cookie, body: { answer: "Yes." } });

  const b = await call("/rfis", { method: "POST", cookie,
    body: { projectId: other.id, subject: "Theirs" } });
  await call(`/rfis/${b.json.rfi.id}/answer`, { method: "POST", cookie, body: { answer: "Also yes." } });

  const out = await call(`/projects/${mine.id}/activity`, { cookie });
  assert.equal(out.status, 200);
  assert.ok(out.json.count > 0, "nothing was recorded against the development at all");
  assert.ok(out.json.events.every((e) => e.entityId !== b.json.rfi.id),
    "another development's history leaked into this one");
  assert.ok(out.json.events.some((e) => e.action === "rfi.answer"),
    "an answered question is missing from its own development's trail");
});

test("the trail adds no reach", { skip }, async () => {
  /*
   * The same rule GET /audit is built on. Somebody hears about models in
   * areas they may already read, and nothing else — so a site manager reading
   * a project's history does not learn what the purchase orders said.
   */
  const owner = await company();
  const p = await project(owner.cookie);

  const rfi = await call("/rfis", { method: "POST", cookie: owner.cookie,
    body: { projectId: p.id, subject: "Visible" } });
  await call(`/rfis/${rfi.json.rfi.id}/answer`, { method: "POST", cookie: owner.cookie,
    body: { answer: "Yes." } });

  const po = await call("/purchase-orders", { method: "POST", cookie: owner.cookie,
    body: { projectId: p.id, title: "Secret steel", vendorName: "X", currency: "KES" } });
  await call(`/purchase-orders/${po.json.purchaseOrder.id}/lines`, { method: "POST",
    cookie: owner.cookie, body: { description: "Y12", quantity: 1000, unitPrice: 1_000_000 } });
  await call(`/purchase-orders/${po.json.purchaseOrder.id}/issue`, { method: "POST",
    cookie: owner.cookie });

  const full = await call(`/projects/${p.id}/activity`, { cookie: owner.cookie });
  assert.ok(full.json.events.some((e) => e.entity === "purchaseOrder"),
    "an owner could not see the purchasing history");

  /* ENGINEERING has property but not finance. */
  const eng = await asRole(owner, "ENGINEERING");
  const narrow = await call(`/projects/${p.id}/activity`, { cookie: eng });
  assert.equal(narrow.status, 200);
  assert.ok(!narrow.json.events.some((e) => e.entity === "purchaseOrder"),
    "an engineer learned what the company is committed to spend");
  assert.ok(narrow.json.hidden > 0, "nothing was reported as withheld");
});

test("neither the report nor the trail crosses a company", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const p = await project(theirs.cookie);
  assert.equal((await call(`/projects/${p.id}/report`, { cookie: mine.cookie })).status, 404);
  assert.equal((await call(`/projects/${p.id}/activity`, { cookie: mine.cookie })).status, 404);
});
