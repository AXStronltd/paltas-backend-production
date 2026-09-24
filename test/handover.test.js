/* ====================================================================== *
 * HANDING IT OVER, WHO WAS ON IT, AND WHAT A SALE ACTUALLY DID.
 *
 * The afternoon everything else has been leading to, and the two rules that
 * decide whether any of it meant anything:
 *
 *   A FLAT CANNOT BE HANDED OVER with a critical or major defect open against
 *   it. That check reads the SAME defect register the site uses — actual
 *   rows — because it is the moment the pressure to ignore one is greatest:
 *   the buyer is in the car park and the defect is "being sorted". Minor
 *   defects deliberately do not block; refusing over a scratched worktop
 *   teaches people to record everything as minor.
 *
 *   A SALE IS NOT COMPLETE while money is outstanding, and what has been paid
 *   is read from the payments rather than from the deposit column — a buyer
 *   six instalments in has paid far more than their deposit, and completing on
 *   the strength of a stale column transfers a flat before it is paid for.
 *
 * And a third, quieter one: somebody leaving a project is a DATE, never a
 * deletion, because a team list that forgets them cannot answer who approved
 * something in March.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_handover";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping handover tests";
let dbHelp = null;
let createApp, db, pg;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.js"));
    ({ createApp } = await import("../src/server.js"));
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
    body: { name: name || `Riverside ${++seq}`, city: "Nairobi" } });
  assert.equal(p.status, 201, p.text.slice(0, 200));
  return p.json.project;
}

async function unit(cookie) {
  const s = await call("/sites", { method: "POST", cookie,
    body: { name: `Court ${++seq}`, city: "Nairobi" } });
  assert.equal(s.status, 201, s.text.slice(0, 200));
  const b = await call("/buildings", { method: "POST", cookie,
    body: { siteId: s.json.site.id, name: `Block ${seq}` } });
  const u = await call("/units", { method: "POST", cookie,
    body: { buildingId: b.json.building.id, siteId: s.json.site.id, ref: `A0${seq}` } });
  assert.equal(u.status, 201, u.text.slice(0, 220));
  return u.json.unit;
}

async function defect(cookie, unitId, severity, title) {
  const d = await call("/defects", { method: "POST", cookie,
    body: { unitId, severity, title: title || `${severity} thing ${++seq}` } });
  assert.equal(d.status, 201, d.text.slice(0, 220));
  return d.json.defect;
}

async function handover(cookie, body) {
  const h = await call("/handovers", { method: "POST", cookie,
    body: { toName: "Grace Wanjiru", scheduledOn: "2026-05-01", ...(body || {}) } });
  assert.equal(h.status, 201, h.text.slice(0, 220));
  return h.json.handover;
}

const finish = (cookie, id, body) =>
  call(`/handovers/${id}/complete`, { method: "POST", cookie,
    body: { receivedBy: "Grace Wanjiru", ...(body || {}) } });

/* ====================================================================== *
 * THE HANDOVER
 * ====================================================================== */

test("a flat with a serious defect is not handed over", { skip }, async () => {
  /*
   * THE RULE. It reads the defect register itself — not a checkbox — because
   * this is the moment the pressure to tick one off is greatest.
   */
  const { cookie } = await company();
  const u = await unit(cookie);
  const h = await handover(cookie, { unitId: u.id });
  assert.match(h.ref, /^HOV-\d{4}$/);

  const major = await defect(cookie, u.id, "MAJOR", "Balcony door does not close");
  const minor = await defect(cookie, u.id, "MINOR", "Scratched worktop");

  const blocked = await finish(cookie, h.id);
  assert.equal(blocked.status, 409, "a flat was handed over with a major defect open");
  assert.match(blocked.json.message, /Balcony door does not close/);
  /* And the minor one is deliberately NOT in the way. */
  assert.ok(!blocked.json.message.includes("Scratched worktop"),
    "a scratched worktop stopped a handover, which teaches people to lie about severity");

  /* Fixed is not enough — one person's word is not two. */
  await call(`/defects/${major.id}/fixed`, { method: "POST", cookie,
    body: { fixedByName: "Peter Mwangi" } });
  const stillBlocked = await finish(cookie, h.id);
  assert.equal(stillBlocked.status, 409,
    "a defect one person said was fixed let the flat be handed over");
  assert.match(stillBlocked.json.message, /verifying by somebody else/i);

  await call(`/defects/${major.id}/verify`, { method: "POST", cookie,
    body: { verifiedByName: "Grace Wanjiru" } });
  const done = await finish(cookie, h.id);
  assert.equal(done.status, 200, done.text.slice(0, 260));
  assert.equal(done.json.handover.status, "COMPLETED");
  assert.equal(done.json.handover.receivedBy, "Grace Wanjiru");
  assert.ok(done.json.handover.completedOn);
  /* The minor one is still open, and that is correct. */
  assert.equal((await call(`/defects/${minor.id}`, { cookie })).json.defect.status, "OPEN");
});

test("what stands in the way can be read before anybody drives over", { skip }, async () => {
  const { cookie } = await company();
  const u = await unit(cookie);
  const h = await handover(cookie, { unitId: u.id });
  await defect(cookie, u.id, "CRITICAL", "No power to the consumer unit");
  await defect(cookie, u.id, "MINOR", "Paint touch-up");
  await call(`/handovers/${h.id}/items`, { method: "POST", cookie,
    body: { title: "Front door keys", kind: "Keys" } });

  const out = await call(`/handovers/${h.id}/readiness`, { cookie });
  assert.equal(out.status, 200);
  assert.equal(out.json.ready, false);
  assert.equal(out.json.counts.blockingDefects, 1, "the minor defect was counted as a blocker");
  assert.equal(out.json.counts.itemsOutstanding, 1);
  assert.match(out.json.means, /Minor ones are not counted/i);
});

test("a handover needs the name of whoever took it", { skip }, async () => {
  const { cookie } = await company();
  const h = await handover(cookie, { unitId: (await unit(cookie)).id });
  const bare = await call(`/handovers/${h.id}/complete`, { method: "POST", cookie, body: {} });
  assert.equal(bare.status, 400, "the keys were handed to nobody");
  assert.match(bare.json.message, /actually received the keys/i);
});

test("keys, meters and manuals are recorded, or deliberately not", { skip }, async () => {
  const { cookie } = await company();
  const u = await unit(cookie);
  const h = await handover(cookie, { unitId: u.id });

  const keys = await call(`/handovers/${h.id}/items`, { method: "POST", cookie,
    body: { title: "Front door keys", kind: "Keys" } });
  const meter = await call(`/handovers/${h.id}/items`, { method: "POST", cookie,
    body: { title: "Electricity meter", kind: "Meter" } });
  const manual = await call(`/handovers/${h.id}/items`, { method: "POST", cookie,
    body: { title: "O&M manuals", kind: "Document" } });
  assert.equal(keys.status, 201);

  await call(`/handovers/${h.id}/items/${keys.json.item.id}`, { method: "POST", cookie,
    body: { status: "DONE", reading: "3 keys, 2 fobs" } });
  await call(`/handovers/${h.id}/items/${meter.json.item.id}`, { method: "POST", cookie,
    body: { status: "DONE", reading: "004182 kWh" } });

  /* A problem has to say what it is. */
  assert.equal((await call(`/handovers/${h.id}/items/${manual.json.item.id}`,
    { method: "POST", cookie, body: { status: "ISSUE" } })).status, 400);
  await call(`/handovers/${h.id}/items/${manual.json.item.id}`, { method: "POST", cookie,
    body: { status: "ISSUE", note: "The M&E section is missing." } });

  /* Everything is either dealt with or a known problem, so it completes —
     and says the problem is still outstanding rather than swallowing it. */
  const done = await finish(cookie, h.id);
  assert.equal(done.status, 200, done.text.slice(0, 240));
  assert.match(done.json.said, /recorded as a problem on the day/i);

  const back = await call(`/handovers/${h.id}`, { cookie });
  const read = back.json.handover.items.find((i) => i.kind === "Meter");
  assert.equal(read.reading, "004182 kWh", "the meter reading was lost");
});

test("an item nobody dealt with stops it, unless somebody says otherwise", { skip }, async () => {
  const { cookie } = await company();
  const h = await handover(cookie, { unitId: (await unit(cookie)).id });
  await call(`/handovers/${h.id}/items`, { method: "POST", cookie,
    body: { title: "Warranty pack" } });

  const blocked = await finish(cookie, h.id);
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.message, /Warranty pack/);

  const anyway = await finish(cookie, h.id, { acceptIncomplete: true });
  assert.equal(anyway.status, 200);
  assert.match(anyway.json.said, /never dealt with/i);
});

test("a buyer refusing to take it is a real outcome", { skip }, async () => {
  const { cookie } = await company();
  const h = await handover(cookie, { unitId: (await unit(cookie)).id });
  assert.equal((await call(`/handovers/${h.id}/refuse`, { method: "POST", cookie })).status, 400);

  const out = await call(`/handovers/${h.id}/refuse`, { method: "POST", cookie,
    body: { reason: "The kitchen is the wrong specification." } });
  assert.equal(out.json.handover.status, "REFUSED");
  assert.equal(out.json.handover.refusedReason, "The kitchen is the wrong specification.");
  assert.match(out.json.said, /Schedule another/i);
});

test("what was handed over that day does not change afterwards", { skip }, async () => {
  const { cookie } = await company();
  const h = await handover(cookie, { unitId: (await unit(cookie)).id });
  const item = await call(`/handovers/${h.id}/items`, { method: "POST", cookie,
    body: { title: "Keys" } });
  await call(`/handovers/${h.id}/items/${item.json.item.id}`, { method: "POST", cookie,
    body: { status: "DONE", reading: "2 keys" } });
  await finish(cookie, h.id);

  assert.equal((await call(`/handovers/${h.id}/items/${item.json.item.id}`,
    { method: "POST", cookie, body: { status: "ISSUE", note: "Actually only one." } })).status, 409);
  assert.equal((await call(`/handovers/${h.id}/items`, { method: "POST", cookie,
    body: { title: "Another thing" } })).status, 409);
  assert.equal((await finish(cookie, h.id)).status, 409);
});

/* ====================================================================== *
 * WHAT A SALE ACTUALLY DID
 * ====================================================================== */

async function contract(cookie, price, unitId) {
  const c = await call("/contracts", { method: "POST", cookie,
    body: { projectId: (await project(cookie)).id, unitId, price, currency: "KES",
            deposit: 0 } });
  assert.equal(c.status, 201, c.text.slice(0, 220));
  return c.json.contract;
}

/** Money that actually arrived: an invoice against the sale, and a payment. */
async function pay(cookie, contractId, amount) {
  const inv = await call("/invoices", { method: "POST", cookie,
    body: { contractId, currency: "KES", issuedOn: "2026-01-01" } });
  assert.equal(inv.status, 201, inv.text.slice(0, 220));
  /* Lines hang off the invoice, which is where the total is recomputed. */
  const line = await call(`/invoices/${inv.json.invoice.id}/lines`, { method: "POST", cookie,
    body: { detail: "Instalment", quantity: 1, unitPrice: amount } });
  assert.equal(line.status, 201, line.text.slice(0, 220));
  /* A distinct reference per payment: the service refuses a second bank
     payment carrying the same one, which is a real guard against a transfer
     being recorded twice — and two instalments really do have two references. */
  const p = await call("/payments", { method: "POST", cookie,
    body: { invoiceId: inv.json.invoice.id, amount, currency: "KES", method: "BANK",
            reference: `TRF-${++seq}` } });
  assert.equal(p.status, 201, p.text.slice(0, 220));
  return p.json.payment;
}

test("a sale is not complete while money is outstanding", { skip }, async () => {
  const { cookie } = await company();
  const u = await unit(cookie);
  const c = await contract(cookie, 12_000_000, u.id);

  const step = (status, body) => call(`/contracts/${c.id}/status`, { method: "POST", cookie,
    body: { status, ...(body || {}) } });

  await step("SOLD");
  const early = await step("COMPLETED");
  assert.equal(early.status, 409, "a flat was transferred before it was paid for");
  assert.match(early.json.message, /120000\.00 outstanding/);

  await pay(cookie, c.id, 5_000_000);
  const half = await call(`/contracts/${c.id}/balance`, { cookie });
  assert.equal(half.json.received, "5000000");
  assert.equal(half.json.owed, "7000000");
  assert.match(half.json.means, /not from the deposit column/i);
  assert.equal((await step("COMPLETED")).status, 409);

  await pay(cookie, c.id, 7_000_000);
  const done = await step("COMPLETED");
  assert.equal(done.status, 200, done.text.slice(0, 240));
  assert.equal(done.json.balance.owed, "0");
  assert.match(done.json.said, /paid in full/i);
});

test("completing with money outstanding is a decision, on the record", { skip }, async () => {
  const { cookie } = await company();
  const c = await contract(cookie, 12_000_000, (await unit(cookie)).id);
  await call(`/contracts/${c.id}/status`, { method: "POST", cookie, body: { status: "SOLD" } });
  const out = await call(`/contracts/${c.id}/status`, { method: "POST", cookie,
    body: { status: "COMPLETED", acceptOutstanding: true } });
  assert.equal(out.status, 200);
  assert.match(out.json.said, /deliberate decision and it is on the record/i);
  assert.equal(out.json.balance.owed, "12000000");
});

test("an approved variation changes what is owed", { skip }, async () => {
  /* The balance is read against the CURRENT value, not the signed one —
     otherwise a variation is a flat somebody gets for free. */
  const { cookie } = await company();
  const c = await contract(cookie, 10_000_000, (await unit(cookie)).id);
  await pay(cookie, c.id, 10_000_000);
  assert.equal((await call(`/contracts/${c.id}/balance`, { cookie })).json.owed, "0");

  const v = await call("/change-orders", { method: "POST", cookie,
    body: { contractId: c.id, title: "Stone worktops", amount: 400_000, currency: "KES" } });
  await call(`/change-orders/${v.json.changeOrder.id}/submit`, { method: "POST", cookie });
  await call(`/change-orders/${v.json.changeOrder.id}/decide`, { method: "POST", cookie,
    body: { approve: true } });

  const after = await call(`/contracts/${c.id}/balance`, { cookie });
  assert.equal(after.json.value, "10400000");
  assert.equal(after.json.owed, "400000",
    "a variation was added to the contract and asked of nobody");
});

test("cancelling a sale puts the flat back on the market", { skip }, async () => {
  /* Without this, a cancelled sale leaves a unit marked RESERVED that nobody
     can sell and nobody can find. */
  const { cookie } = await company();
  const u = await unit(cookie);
  await call(`/units/${u.id}`, { method: "PATCH", cookie, body: { status: "RESERVED" } });
  const c = await contract(cookie, 8_000_000, u.id);

  assert.equal((await call(`/contracts/${c.id}/status`, { method: "POST", cookie,
    body: { status: "CANCELLED" } })).status, 400);

  const out = await call(`/contracts/${c.id}/status`, { method: "POST", cookie,
    body: { status: "CANCELLED", reason: "The buyer could not raise the finance." } });
  assert.equal(out.status, 200);
  assert.equal(out.json.releasedUnit.status, "VACANT",
    "the flat stayed reserved against a sale that is not happening");
  assert.equal((await call(`/units/${u.id}`, { cookie })).json.unit.status, "VACANT");
  assert.match(out.json.said, /back on the market/i);
});

test("a contract only moves forwards", { skip }, async () => {
  const { cookie } = await company();
  const c = await contract(cookie, 1_000_000, (await unit(cookie)).id);
  const step = (status, body) => call(`/contracts/${c.id}/status`, { method: "POST", cookie,
    body: { status, ...(body || {}) } });

  assert.equal((await step("COMPLETED")).status, 409, "a reservation completed without being signed");
  await step("SOLD");
  const signed = await call(`/contracts/${c.id}`, { cookie });
  assert.ok(signed.json.contract.signedOn, "signing did not stamp a date");
  await step("COMPLETED", { acceptOutstanding: true });
  assert.equal((await step("CANCELLED", { reason: "x" })).status, 409);
});

/* ====================================================================== *
 * WHO IS ON THE JOB
 * ====================================================================== */

test("a team list is who to ring, and leaving does not erase anybody", { skip }, async () => {
  const { cookie } = await company();
  const p = await project(cookie);

  const bare = await call(`/projects/${p.id}/team`, { method: "POST", cookie,
    body: { name: "Grace Wanjiru" } });
  assert.equal(bare.status, 400, "somebody joined a team with no role");

  const arch = await call(`/projects/${p.id}/team`, { method: "POST", cookie,
    body: { name: "Grace Wanjiru", role: "Architect", company: "GW Architects",
            email: "grace@example.com", responsible: "The facade and the cladding." } });
  assert.equal(arch.status, 201, arch.text.slice(0, 220));
  await call(`/projects/${p.id}/team`, { method: "POST", cookie,
    body: { name: "Peter Mwangi", role: "Quantity surveyor" } });

  const before = await call(`/projects/${p.id}/team`, { cookie });
  assert.equal(before.json.counts.current, 2);
  assert.equal(before.json.unstated, 1, "a team member with nothing said about what they do");

  /* Somebody with open work leaves, and the work is named rather than
     silently becoming nobody's. */
  const t = await call("/tasks", { method: "POST", cookie,
    body: { projectId: p.id, title: "Issue the cladding tender" } });
  await call(`/tasks/${t.json.task.id}/assign`, { method: "POST", cookie,
    body: { assigneeName: "Grace Wanjiru" } });

  const out = await call(`/projects/${p.id}/team/${arch.json.member.id}/leave`,
    { method: "POST", cookie, body: {} });
  assert.equal(out.status, 200);
  assert.equal(out.json.openTasks.length, 1, "the work they were carrying was not named");
  assert.equal(out.json.openTasks[0].ref, t.json.task.ref);
  assert.match(out.json.said, /somebody has to decide who takes them/i);

  /* And they are still on the record. */
  const after = await call(`/projects/${p.id}/team`, { cookie });
  assert.equal(after.json.counts.current, 1);
  assert.equal(after.json.counts.former, 1);
  assert.equal(after.json.former[0].name, "Grace Wanjiru");
  assert.ok(after.json.former[0].leftOn);
  assert.equal(after.json.former[0].responsible, "The facade and the cladding.",
    "what they answered for was erased when they left");

  assert.equal((await call(`/projects/${p.id}/team/${arch.json.member.id}/leave`,
    { method: "POST", cookie })).status, 409);
});

test("somebody outside the company cannot be put on a job in it", { skip }, async () => {
  const { cookie } = await company();
  const p = await project(cookie);
  const stranger = await db.user.create({
    data: { email: `out${++seq}@example.com`, name: "Outsider", googleSub: `s${seq}` } });
  const res = await call(`/projects/${p.id}/team`, { method: "POST", cookie,
    body: { userId: stranger.id, role: "Project manager" } });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /not a member of this company/i);
});

/* ====================================================================== *
 * TENANCY, AUTHORISATION AND THE TRAIL
 * ====================================================================== */

test("none of it crosses a company", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const u = await unit(theirs.cookie);
  const h = await handover(theirs.cookie, { unitId: u.id });
  const c = await contract(theirs.cookie, 1_000_000, u.id);
  const p = await project(theirs.cookie);
  const m = await call(`/projects/${p.id}/team`, { method: "POST", cookie: theirs.cookie,
    body: { name: "Theirs", role: "PM" } });

  const post = (path, body) => call(path, { method: "POST", cookie: mine.cookie, body: body || {} });
  assert.equal((await post(`/handovers/${h.id}/complete`, { receivedBy: "X" })).status, 404);
  assert.equal((await post(`/handovers/${h.id}/items`, { title: "X" })).status, 404);
  assert.equal((await call(`/handovers/${h.id}/readiness`, { cookie: mine.cookie })).status, 404);
  assert.equal((await post(`/contracts/${c.id}/status`, { status: "SOLD" })).status, 404);
  assert.equal((await call(`/contracts/${c.id}/balance`, { cookie: mine.cookie })).status, 404);
  assert.equal((await call(`/projects/${p.id}/team`, { cookie: mine.cookie })).status, 404);
  assert.equal((await post(`/projects/${p.id}/team/${m.json.member.id}/leave`)).status, 404);
});

test("somebody who may not touch the money may not complete a sale", { skip }, async () => {
  const owner = await company();
  const ops = await asRole(owner, "OPERATIONS");
  const u = await unit(owner.cookie);
  const c = await contract(owner.cookie, 1_000_000, u.id);
  const h = await handover(owner.cookie, { unitId: u.id });

  assert.equal((await call(`/contracts/${c.id}/status`, { method: "POST", cookie: ops,
    body: { status: "SOLD" } })).status, 403);
  /* But it may READ the numbers — operations holds finance at read, so that a
     site manager can see what a buyer owes without being able to change it.
     That is a different thing from being able to complete the sale. */
  assert.equal((await call(`/contracts/${c.id}/balance`, { cookie: ops })).status, 200);
  /* And it DOES hand flats over, which is its job. */
  assert.equal((await call(`/handovers/${h.id}/complete`, { method: "POST", cookie: ops,
    body: { receivedBy: "Grace Wanjiru" } })).status, 200);
});

test("every handover and every move on a sale is recorded", { skip }, async () => {
  const { orgId, cookie } = await company();
  const u = await unit(cookie);
  const h = await handover(cookie, { unitId: u.id });
  const c = await contract(cookie, 1_000_000, u.id);
  await call(`/contracts/${c.id}/status`, { method: "POST", cookie, body: { status: "SOLD" } });
  const p = await project(cookie);
  const m = await call(`/projects/${p.id}/team`, { method: "POST", cookie,
    body: { name: "A", role: "PM" } });
  await call(`/projects/${p.id}/team/${m.json.member.id}/leave`, { method: "POST", cookie });
  /* A meter reading quietly changed before the handover finished must leave
     something behind, so the item route is audited too. */
  const item = await call(`/handovers/${h.id}/items`, { method: "POST", cookie,
    body: { title: "Electricity meter", kind: "Meter" } });
  await call(`/handovers/${h.id}/items/${item.json.item.id}`, { method: "POST", cookie,
    body: { status: "DONE", reading: "004182 kWh" } });
  await finish(cookie, h.id);

  const actions = new Set((await db.auditEvent.findMany({
    where: { orgId }, select: { action: true } })).map((e) => e.action));
  for (const want of ["handover.complete", "handover.item", "contract.status",
                      "project.team.join", "project.team.leave"]) {
    assert.ok(actions.has(want), `${want} was not recorded`);
  }
});
