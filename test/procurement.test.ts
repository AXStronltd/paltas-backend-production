/* ====================================================================== *
 * BUYING THINGS, AND CHANGING WHAT WAS AGREED.
 *
 * Two rules run through everything below, and both are about not having two
 * answers to one question:
 *
 *   FINANCE STAYS AUTHORITATIVE. A purchase order is a commitment, not a
 *   payment. Nothing here records money; the moment an invoice arrives it
 *   becomes an Expense, and that is what the ledger and every report read. A
 *   "paid" column on an order would give a company two answers to "what have
 *   we spent" and no way to tell which is right.
 *
 *   THE SIGNED CONTRACT VALUE IS NEVER TOUCHED. A variation is its own
 *   record, and what a contract is worth today is what it was signed at plus
 *   every approved variation — computed, never stored. A contract worth £4.3m
 *   with no trace that it was signed at £3.9m cannot answer the question every
 *   dispute turns on.
 *
 * The smaller rules are of the same kind: an order's total comes from its
 * lines and is never sent, more cannot be received than was ordered, and an
 * award declines the others and says why this one.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
import { portOf } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";
import { present } from "./wire.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_proc";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping procurement tests";
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

async function vendor(cookie: Wire, name?: Wire) {
  const v = await call("/parties", { method: "POST", cookie,
    body: { name: name || `Supplier ${++seq}`, kind: "VENDOR" } });
  assert.equal(v.status, 201, v.text.slice(0, 200));
  return v.json.party;
}

async function rfq(cookie: Wire, body?: Wire) {
  const r = await call("/rfqs", { method: "POST", cookie,
    body: { title: "Reinforcement to levels 3-5", category: "Materials", ...(body || {}) } });
  assert.equal(r.status, 201, r.text.slice(0, 220));
  return r.json.rfq;
}

async function quote(cookie: Wire, rfqId: Wire, amount: Wire, who?: Wire) {
  const q = await call("/quotes", { method: "POST", cookie,
    body: { rfqId, vendorName: who || `Supplier ${++seq}`, amount, currency: "KES",
            leadTimeDays: 14 } });
  assert.equal(q.status, 201, q.text.slice(0, 220));
  return q.json.quote;
}

/* ====================================================================== *
 * ASKING, AND CHOOSING
 * ====================================================================== */

test("awarding a quote does all four things, or none of them", { skip }, async () => {
  const { cookie } = await company();
  const r = await rfq(cookie);
  assert.match(r.ref, /^RFQ-\d{4}$/);

  await call(`/rfqs/${r.id}/issue`, { method: "POST", cookie });
  const cheap = await quote(cookie, r.id, 4_200_000, "Kilimani Steel");
  const dear = await quote(cookie, r.id, 5_100_000, "Westlands Metals");
  const third = await quote(cookie, r.id, 4_800_000, "Athi Supplies");

  /* An award with no reasoning is the one somebody asks about later. */
  const bare = await call(`/rfqs/${r.id}/award`, { method: "POST", cookie,
    body: { quoteId: cheap.id } });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /defensible/i);

  const out = await call(`/rfqs/${r.id}/award`, { method: "POST", cookie,
    body: { quoteId: cheap.id, note: "Cheapest, and the only one that could deliver by week 12." } });
  assert.equal(out.status, 200, out.text.slice(0, 220));

  /* One: the quote wins, with the reasoning kept. */
  assert.equal(out.json.quote.status, "AWARDED");
  /* Two: the others are declined — the record that makes it defensible. */
  assert.equal(out.json.declined, 2);
  for (const q of [dear, third]) {
    const back = await call(`/quotes/${q.id}`, { cookie });
    assert.equal(back.json.quote.status, "DECLINED");
  }
  /* Three: the request is settled. */
  assert.equal((await call(`/rfqs/${r.id}`, { cookie })).json.rfq.status, "AWARDED");
  /* Four: an order exists, AT THE QUOTED FIGURE. */
  const order = out.json.order;
  assert.match(order.ref, /^PO-\d{4}$/);
  assert.equal(order.status, "DRAFT");
  assert.equal(Number(order.total), 4_200_000,
    "the order was opened at a figure nobody quoted");
  assert.equal(order.quoteId, cheap.id);
  assert.equal(order.vendorName, "Kilimani Steel");
});

test("a request is awarded once", { skip }, async () => {
  const { cookie } = await company();
  const r = await rfq(cookie);
  const a = await quote(cookie, r.id, 100);
  const b = await quote(cookie, r.id, 200);
  await call(`/rfqs/${r.id}/award`, { method: "POST", cookie,
    body: { quoteId: a.id, note: "Cheaper." } });
  const again = await call(`/rfqs/${r.id}/award`, { method: "POST", cookie,
    body: { quoteId: b.id, note: "Changed my mind." } });
  assert.equal(again.status, 409, "one request bought the same thing twice");
});

test("a quote given against a different request cannot win this one", { skip }, async () => {
  const { cookie } = await company();
  const mine = await rfq(cookie);
  const other = await rfq(cookie, { title: "Something else" });
  const q = await quote(cookie, other.id, 500);
  const res = await call(`/rfqs/${mine.id}/award`, { method: "POST", cookie,
    body: { quoteId: q.id, note: "Looks cheap." } });
  assert.equal(res.status, 400);
});

/* ====================================================================== *
 * ORDERING
 * ====================================================================== */

async function order(cookie: Wire, body?: Wire) {
  const v = await vendor(cookie);
  const o = await call("/purchase-orders", { method: "POST", cookie,
    body: { title: "Reinforcement", vendorId: v.id, vendorName: v.name,
            currency: "KES", ...(body || {}) } });
  assert.equal(o.status, 201, o.text.slice(0, 220));
  return o.json.purchaseOrder;
}

async function line(cookie: Wire, orderId: Wire, body?: Wire) {
  const l = await call(`/purchase-orders/${orderId}/lines`, { method: "POST", cookie,
    body: { description: "Y12 bar", quantity: 3000, unit: "tonne",
            unitPrice: 120_000, ...(body || {}) } });
  assert.equal(l.status, 201, l.text.slice(0, 220));
  return l.json;
}

test("an order's total comes from its lines and cannot be sent", { skip }, async () => {
  const { cookie } = await company();
  const o = await order(cookie);
  assert.equal(Number(o.total), 0);

  /* Sending one is refused outright. */
  const typed = await call(`/purchase-orders/${o.id}`, { method: "PATCH", cookie,
    body: { total: 999_999_999 } });
  assert.equal(typed.status, 400, "a total was typed in and the order became two documents");

  /* 3 tonnes at 1,200.00 each. Quantities are thousandths. */
  const a = await line(cookie, o.id);
  assert.equal(Number(a.line.total), 360_000);
  assert.equal(Number(a.order.subtotal), 360_000);

  const b = await line(cookie, o.id, { description: "Y16 bar", quantity: 1500, unitPrice: 130_000 });
  assert.equal(Number(b.line.total), 195_000, "a half-tonne was not halved");
  assert.equal(Number(b.order.subtotal), 555_000);

  /* And removing one puts it back. */
  const gone = await call(`/purchase-orders/${o.id}/lines/${a.line.id}`,
    { method: "DELETE", cookie });
  assert.equal(Number(gone.json.order.subtotal), 195_000);
});

test("an order with nothing on it is not a commitment", { skip }, async () => {
  const { cookie } = await company();
  const o = await order(cookie);
  const res = await call(`/purchase-orders/${o.id}/issue`, { method: "POST", cookie });
  assert.equal(res.status, 400, "an empty order went to a supplier");
  assert.match(res.json.message, /about to go to a supplier/i);
});

test("issuing an order commits the company and spends nothing", { skip }, async () => {
  /*
   * THE RULE FINANCE RESTS ON. An issued order is a promise. If it were also
   * a cost, every report would count it twice — once as a commitment and
   * again when the invoice arrives.
   */
  const { cookie } = await company();
  const o = await order(cookie);
  await line(cookie, o.id);
  const out = await call(`/purchase-orders/${o.id}/issue`, { method: "POST", cookie,
    body: { tax: 57_600 } });
  assert.equal(out.status, 200, out.text.slice(0, 220));
  assert.equal(out.json.order.status, "ISSUED");
  assert.equal(Number(out.json.order.total), 417_600, "tax was not folded into the total");
  assert.match(out.json.said, /nothing has been spent/i);

  /* Nothing has reached the books. */
  const spent = await call("/expenses", { cookie });
  assert.equal(spent.json.expenses.length, 0,
    "committing to a purchase recorded a cost that had not happened");

  const back = await call(`/purchase-orders/${o.id}`, { cookie });
  assert.match(back.json.purchaseOrder.means, /Committed, not spent/i);
});

test("an issued order's lines are what was ordered", { skip }, async () => {
  const { cookie } = await company();
  const o = await order(cookie);
  const l = await line(cookie, o.id);
  await call(`/purchase-orders/${o.id}/issue`, { method: "POST", cookie });

  assert.equal((await call(`/purchase-orders/${o.id}/lines`, { method: "POST", cookie,
    body: { description: "Extra", unitPrice: 1 } })).status, 409);
  assert.equal((await call(`/purchase-orders/${o.id}/lines/${l.line.id}`,
    { method: "DELETE", cookie })).status, 409);
});

test("more cannot be received than was ordered", { skip }, async () => {
  const { cookie } = await company();
  const o = await order(cookie);
  const l = await line(cookie, o.id, { quantity: 3000 });     /* 3 tonnes */
  await call(`/purchase-orders/${o.id}/issue`, { method: "POST", cookie });

  const over = await call(`/purchase-orders/${o.id}/receive`, { method: "POST", cookie,
    body: { lines: [{ lineId: l.line.id, quantity: 4000 }] } });
  assert.equal(over.status, 409, "four tonnes were received against three ordered");
  assert.match(over.json.message, /Nothing has been recorded/i);

  /* And it really recorded nothing — not a partial receipt of three. */
  const back = await call(`/purchase-orders/${o.id}`, { cookie });
  assert.equal(back.json.purchaseOrder.lines[0].receivedQty, 0);
  assert.equal(back.json.purchaseOrder.receipts.length, 0);
  assert.equal(back.json.purchaseOrder.status, "ISSUED");
});

test("a part delivery is a part delivery, and the second one finishes it", { skip }, async () => {
  const { cookie } = await company();
  const o = await order(cookie);
  const l = await line(cookie, o.id, { quantity: 3000 });
  await call(`/purchase-orders/${o.id}/issue`, { method: "POST", cookie });

  const first = await call(`/purchase-orders/${o.id}/receive`, { method: "POST", cookie,
    body: { deliveryNote: "DN-8841", receivedBy: "Peter Mwangi",
            lines: [{ lineId: l.line.id, quantity: 1000, condition: "Accepted" }] } });
  assert.equal(first.status, 200, first.text.slice(0, 220));
  assert.match(first.json.receipt.ref, /^GRN-\d{4}$/);
  assert.equal(first.json.complete, false);
  assert.equal(first.json.order.status, "PARTIALLY_RECEIVED");
  assert.equal(first.json.outstanding[0].short, 2);

  /* Two more tonnes takes it to three, which is all of it. */
  const second = await call(`/purchase-orders/${o.id}/receive`, { method: "POST", cookie,
    body: { lines: [{ lineId: l.line.id, quantity: 2000 }] } });
  assert.equal(second.json.complete, true);
  assert.equal(second.json.order.status, "RECEIVED");

  /* A third would exceed it, and is refused. */
  assert.equal((await call(`/purchase-orders/${o.id}/receive`, { method: "POST", cookie,
    body: { lines: [{ lineId: l.line.id, quantity: 1 }] } })).status, 409);
});

test("the invoice is where the money exists, and it exists once", { skip }, async () => {
  /*
   * THE BRIDGE. Everything anybody reports about cost comes from the Expense
   * on the other end of it — never from the order.
   */
  const { cookie } = await company();
  const o = await order(cookie);
  await line(cookie, o.id);                       /* 360,000 */
  await call(`/purchase-orders/${o.id}/issue`, { method: "POST", cookie });

  const out = await call(`/purchase-orders/${o.id}/invoice`, { method: "POST", cookie,
    body: { amount: 372_000, note: "Includes a delivery charge." } });
  assert.equal(out.status, 200, out.text.slice(0, 220));
  assert.equal(out.json.order.status, "CLOSED");
  assert.ok(out.json.order.expenseId, "the order does not point at the cost");
  assert.equal(Number(out.json.expense.amount), 372_000);
  /* The difference between committed and billed, which nobody reads an order
     to find out and everybody wants to know. */
  assert.equal(out.json.variance, "12000");
  assert.match(out.json.said, /above the order/i);

  /* It is in the books, once. */
  const spent = await call("/expenses", { cookie });
  assert.equal(spent.json.expenses.length, 1);
  assert.equal(Number(spent.json.expenses[0].amount), 372_000);

  const again = await call(`/purchase-orders/${o.id}/invoice`, { method: "POST", cookie });
  assert.equal(again.status, 409, "one purchase was recorded as two costs");
  assert.equal((await call("/expenses", { cookie })).json.expenses.length, 1);
});

test("an order that has been invoiced or delivered cannot be cancelled away", { skip }, async () => {
  const { cookie } = await company();

  const delivered = await order(cookie);
  const l = await line(cookie, delivered.id, { quantity: 2000 });
  await call(`/purchase-orders/${delivered.id}/issue`, { method: "POST", cookie });
  await call(`/purchase-orders/${delivered.id}/receive`, { method: "POST", cookie,
    body: { lines: [{ lineId: l.line.id, quantity: 1000 }] } });
  const res = await call(`/purchase-orders/${delivered.id}/cancel`, { method: "POST", cookie,
    body: { reason: "Never mind." } });
  assert.equal(res.status, 409, "goods on site with no record of being ordered");

  const billed = await order(cookie);
  await line(cookie, billed.id);
  await call(`/purchase-orders/${billed.id}/issue`, { method: "POST", cookie });
  await call(`/purchase-orders/${billed.id}/invoice`, { method: "POST", cookie });
  assert.equal((await call(`/purchase-orders/${billed.id}/cancel`, { method: "POST", cookie,
    body: { reason: "Never mind." } })).status, 409);
});

test("what is committed is not what has been spent", { skip }, async () => {
  const { cookie } = await company();
  const live = await order(cookie);
  await line(cookie, live.id);                    /* 360,000 committed */
  await call(`/purchase-orders/${live.id}/issue`, { method: "POST", cookie });

  const billed = await order(cookie);
  await line(cookie, billed.id, { unitPrice: 100_000 });   /* 300,000, then billed */
  await call(`/purchase-orders/${billed.id}/issue`, { method: "POST", cookie });
  await call(`/purchase-orders/${billed.id}/invoice`, { method: "POST", cookie });

  const out = await call("/purchase-orders/committed", { cookie });
  assert.equal(out.json.count, 1, "an order already in the books was still counted as committed");
  assert.equal(out.json.committed.KES, "360000");
  assert.match(out.json.means, /not in the ledger/i);
});

/* ====================================================================== *
 * VARIATIONS
 * ====================================================================== */

async function contract(cookie: Wire, price: Wire) {
  const c = await call("/contracts", { method: "POST", cookie,
    body: { projectId: await project(cookie), price, currency: "KES" } });
  assert.equal(c.status, 201, c.text.slice(0, 220));
  return c.json.contract;
}

async function variation(cookie: Wire, contractId: Wire, body?: Wire) {
  const v = await call("/change-orders", { method: "POST", cookie,
    body: { contractId, title: "Upgrade to stone worktops",
            reason: "Buyer's request", amount: 400_000, currency: "KES",
            days: 10, ...(body || {}) } });
  assert.equal(v.status, 201, v.text.slice(0, 220));
  return v.json.changeOrder;
}

test("an approved variation changes what a contract is worth, never what it was signed at", { skip }, async () => {
  /*
   * THE RULE. A contract worth 4.3m with no trace that it was signed at 3.9m
   * cannot answer the question every dispute turns on.
   */
  const { cookie } = await company();
  const c = await contract(cookie, 3_900_000);
  const v = await variation(cookie, c.id, { amount: 400_000, days: 10 });

  await call(`/change-orders/${v.id}/submit`, { method: "POST", cookie });
  const out = await call(`/change-orders/${v.id}/decide`, { method: "POST", cookie,
    body: { approve: true, decidedBy: "Grace Wanjiru" } });
  assert.equal(out.status, 200, out.text.slice(0, 220));
  assert.equal(out.json.changeOrder.status, "APPROVED");
  assert.equal(out.json.changeOrder.decidedBy, "Grace Wanjiru");

  /* The contract row itself is untouched. */
  const row = await call(`/contracts/${c.id}`, { cookie });
  assert.equal(Number(row.json.contract.price), 3_900_000,
    "the signed figure was silently rewritten");

  /* And the current value is the sum, computed. */
  const value = await call(`/contracts/${c.id}/value`, { cookie });
  assert.equal(value.json.contract.signedAt, "3900000");
  assert.equal(value.json.contract.approvedVariations, "400000");
  assert.equal(value.json.contract.currentValue, "4300000");
  assert.equal(value.json.contract.daysAdded, 10);
  assert.equal(value.json.contract.variations.length, 1);
  assert.match(out.json.said, /signed figure is unchanged/i);
});

test("a variation that reduces the price is a real thing", { skip }, async () => {
  /* An omission. Forcing it positive would mean recording a credit as a charge. */
  const { cookie } = await company();
  const c = await contract(cookie, 3_900_000);
  const v = await variation(cookie, c.id, { title: "Omit the balcony", amount: -250_000, days: -5 });
  await call(`/change-orders/${v.id}/submit`, { method: "POST", cookie });
  await call(`/change-orders/${v.id}/decide`, { method: "POST", cookie, body: { approve: true } });

  const value = await call(`/contracts/${c.id}/value`, { cookie });
  assert.equal(value.json.contract.currentValue, "3650000");
  assert.equal(value.json.contract.daysAdded, -5);
});

test("only approved variations count", { skip }, async () => {
  const { cookie } = await company();
  const c = await contract(cookie, 1_000_000);

  const yes = await variation(cookie, c.id, { amount: 100_000 });
  const no = await variation(cookie, c.id, { amount: 200_000 });
  const draft = await variation(cookie, c.id, { amount: 400_000 });
  const gone = await variation(cookie, c.id, { amount: 800_000 });

  await call(`/change-orders/${yes.id}/submit`, { method: "POST", cookie });
  await call(`/change-orders/${yes.id}/decide`, { method: "POST", cookie, body: { approve: true } });
  await call(`/change-orders/${no.id}/submit`, { method: "POST", cookie });
  await call(`/change-orders/${no.id}/decide`, { method: "POST", cookie,
    body: { approve: false, note: "Not in the scope." } });
  await call(`/change-orders/${gone.id}/submit`, { method: "POST", cookie });
  await call(`/change-orders/${gone.id}/withdraw`, { method: "POST", cookie,
    body: { reason: "Buyer changed their mind." } });

  const value = await call(`/contracts/${c.id}/value`, { cookie });
  assert.equal(value.json.contract.currentValue, "1100000",
    "a variation nobody approved was counted against the contract");
  assert.equal(value.json.contract.variations.length, 1);
  assert.equal((await call(`/change-orders/${draft.id}`, { cookie })).json.changeOrder.status, "DRAFT");
});

test("a variation is decided once, and a rejection says why", { skip }, async () => {
  const { cookie } = await company();
  const c = await contract(cookie, 1_000_000);
  const v = await variation(cookie, c.id);

  /* Not before it is submitted. */
  assert.equal((await call(`/change-orders/${v.id}/decide`, { method: "POST", cookie,
    body: { approve: true } })).status, 409);

  await call(`/change-orders/${v.id}/submit`, { method: "POST", cookie });
  const bare = await call(`/change-orders/${v.id}/decide`, { method: "POST", cookie,
    body: { approve: false } });
  assert.equal(bare.status, 400, "a variation was turned down with no reason");

  await call(`/change-orders/${v.id}/decide`, { method: "POST", cookie,
    body: { approve: false, note: "Outside the contract scope." } });
  const again = await call(`/change-orders/${v.id}/decide`, { method: "POST", cookie,
    body: { approve: true } });
  assert.equal(again.status, 409, "a decision was reversed with no record of the first");
  /* And it cannot be taken back after the fact either. */
  assert.equal((await call(`/change-orders/${v.id}/withdraw`, { method: "POST", cookie })).status, 409);
});

test("a variation that changes nothing is not a variation", { skip }, async () => {
  const { cookie } = await company();
  const c = await contract(cookie, 1_000_000);
  const v = await variation(cookie, c.id, { amount: 0, days: 0 });
  const res = await call(`/change-orders/${v.id}/submit`, { method: "POST", cookie });
  assert.equal(res.status, 400);
});

/* ====================================================================== *
 * TENANCY, AUTHORISATION AND THE TRAIL
 * ====================================================================== */

test("none of it crosses a company", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const r = await rfq(theirs.cookie);
  const q = await quote(theirs.cookie, r.id, 100);
  const o = await order(theirs.cookie);
  const c = await contract(theirs.cookie, 1_000_000);
  const v = await variation(theirs.cookie, c.id);

  const post = (path: Wire, body: Wire) => call(path, { method: "POST", cookie: mine.cookie, body: body || {} });
  assert.equal((await post(`/rfqs/${r.id}/issue`)).status, 404);
  assert.equal((await post(`/rfqs/${r.id}/award`, { quoteId: q.id, note: "x" })).status, 404);
  assert.equal((await post(`/purchase-orders/${o.id}/issue`)).status, 404);
  assert.equal((await post(`/change-orders/${v.id}/submit`)).status, 404);
  assert.equal((await call(`/contracts/${c.id}/value`, { cookie: mine.cookie })).status, 404);
  assert.equal((await call("/purchase-orders/committed", { cookie: mine.cookie })).json.count, 0);
});

test("somebody who may not touch the money may not commit the company", { skip }, async () => {
  /*
   * An issued purchase order is a liability. A site manager who may record a
   * defect must not be able to order two hundred thousand of steel.
   */
  const owner = await company();
  const ops = await asRole(owner, "OPERATIONS");
  const o = await order(owner.cookie);
  await line(owner.cookie, o.id);

  assert.equal((await call("/purchase-orders", { method: "POST", cookie: ops,
    body: { title: "Steel" } })).status, 403);
  assert.equal((await call(`/purchase-orders/${o.id}/issue`, { method: "POST", cookie: ops })).status, 403);
  assert.equal((await call(`/purchase-orders/${o.id}/invoice`, { method: "POST", cookie: ops })).status, 403);
});

test("every commitment and every variation is recorded", { skip }, async () => {
  const { orgId, cookie } = await company();
  const r = await rfq(cookie);
  const q = await quote(cookie, r.id, 500_000);
  await call(`/rfqs/${r.id}/issue`, { method: "POST", cookie });
  const awarded = await call(`/rfqs/${r.id}/award`, { method: "POST", cookie,
    body: { quoteId: q.id, note: "Only quote." } });
  const oid = awarded.json.order.id;
  await call(`/purchase-orders/${oid}/issue`, { method: "POST", cookie });
  await call(`/purchase-orders/${oid}/invoice`, { method: "POST", cookie });

  const c = await contract(cookie, 1_000_000);
  const v = await variation(cookie, c.id);
  await call(`/change-orders/${v.id}/submit`, { method: "POST", cookie });
  await call(`/change-orders/${v.id}/decide`, { method: "POST", cookie, body: { approve: true } });

  /* Taking a line OFF an order is the half that used to leave nothing behind. */
  const draft = await order(cookie);
  const l = await line(cookie, draft.id);
  await call(`/purchase-orders/${draft.id}/lines/${l.line.id}`, { method: "DELETE", cookie });

  const actions = new Set((await db.auditEvent.findMany({
    where: { orgId }, select: { action: true } })).map((e) => e.action));
  for (const want of ["rfq.issue", "rfq.award", "purchase.issue", "purchase.invoice",
                      "purchase.line.remove", "change.submit", "change.decide"]) {
    assert.ok(actions.has(want), `${want} was not recorded`);
  }
});
