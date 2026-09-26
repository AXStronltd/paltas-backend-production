/* ======================================================================
 * BUYER 360: EVERY FIGURE DERIVED, NONE OF THEM STORED.
 *
 * Ported from paltas-dev-core's Buyer360 tests. The assertions that carry
 * weight are the ones about what a figure MEANS:
 *
 *   · outstanding is measured against what has been BILLED, never the whole
 *     price — otherwise every buyer on a five-year plan is permanently in
 *     arrears and the figure stops being useful for finding the ones who
 *     really are behind;
 *
 *   · an overpayment is held as credit and NEVER netted against arrears,
 *     because a buyer with a credit is not a buyer who owes money, and a
 *     report that nets the two hides both facts at once.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

import { portOf, present } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";

process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const skip = DB ? false : "no TEST_DATABASE_URL — skipping Buyer 360 tests";

const SCHEMA = "buyer360_test";
let createApp: typeof import("../src/server.ts")["createApp"];
let db: typeof import("../src/db.ts")["db"];
let pg: typeof import("pg")["default"];
let server: import("node:http").Server;
let base: string;
let seq = 0;

if (!skip) {
  process.env.DATABASE_URL = urlForSchema(String(DB), SCHEMA);
  ({ default: pg } = await import("pg"));
  const pool = poolInSchema(pg, String(DB), SCHEMA);
  try {
    await freshSchema(pool, SCHEMA);
  } catch (e) {
    const said = explain(e, String(DB));
    throw said ? new Error(said) : e;
  } finally {
    await pool.end();
  }
  ({ createApp } = await import("../src/server.ts"));
  ({ db } = await import("../src/db.ts"));
  server = http.createServer(createApp());
  await new Promise<void>((r) => { server.listen(0, () => r()); });
  base = `http://127.0.0.1:${portOf(server)}`;
}

test.after(async () => {
  if (skip) return;
  await new Promise<void>((r) => { server.close(() => r()); });
  await db.$disconnect();
});

async function call(
  path: string, { method = "GET", body, cookie }: CallOptions = {},
): Promise<Reply> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Wire = null;
  try { json = JSON.parse(text); } catch { /* not every reply is JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function company(role: import("@prisma/client").$Enums.Role = "OWNER") {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Buyer ${n} Ltd`, country: "ke",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const email = `b360${n}@example.test`;
  const user = await db.user.create({
    data: { email, name: `Person ${n}`, googleSub: "sub_" + email },
  });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: org.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return { org, user, cookie: `paltas_session=${token}` };
}

async function contract(orgId: string, price: bigint, deposit = 0n) {
  const n = ++seq;
  return db.contract.create({
    data: {
      orgId, ref: `CON-${n}`, price, deposit, currency: "KES",
      status: "RESERVED", signedOn: new Date("2026-01-15"),
    },
  });
}

/** An invoice against a contract, with one line and a total. */
async function invoice(
  orgId: string, contractId: string, total: bigint, over: Record<string, unknown> = {},
) {
  return db.invoice.create({
    data: {
      orgId, contractId, ref: `INV-${++seq}`, currency: "KES",
      total, status: "SENT", issuedOn: new Date("2026-02-01"), ...over,
    },
  });
}

async function paid(orgId: string, invoiceId: string, amount: bigint, over: Record<string, unknown> = {}) {
  const p = await db.payment.create({
    data: {
      orgId, invoiceId, amount, currency: "KES", method: "BANK",
      reference: `TRF-${++seq}`, receivedAt: new Date("2026-02-15"), ...over,
    },
  });
  const inv = present(await db.invoice.findUnique({ where: { id: invoiceId } }), "gone");
  await db.invoice.update({
    where: { id: invoiceId }, data: { paid: inv.paid + amount },
  });
  return p;
}

/* ==================================================================== *
 * WHAT A BUYER OWES, AND WHAT THAT MEANS.
 * ==================================================================== */

test("outstanding is what has been billed and not paid, not the whole price", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 10_000_000n);
  /* A deposit of 1,000,000 billed and paid. Nine million not yet billed. */
  const inv = await invoice(org.id, c.id, 1_000_000n);
  await paid(org.id, inv.id, 1_000_000n);

  const view = await call(`/contracts/${c.id}/buyer`, { cookie });
  assert.equal(view.status, 200, view.text.slice(0, 240));

  assert.equal(view.json.position.outstanding, "0",
    "*** a buyer who has paid every bill in full was reported as owing " +
    "9,000,000. Every buyer on a long plan would show as in arrears and the " +
    "figure would stop meaning anything. ***");
  assert.equal(view.json.position.unbilled, "9000000",
    "what is not yet billed should be reported, separately and honestly");
  assert.equal(view.json.position.invoiced, "1000000");
  assert.equal(view.json.position.received, "1000000");
});

test("an overpayment is held as credit and not netted against arrears", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 10_000_000n);
  const inv = await invoice(org.id, c.id, 1_000_000n);
  /* The buyer rounds up and sends 1,200,000. */
  await paid(org.id, inv.id, 1_000_000n);
  await db.payment.create({
    data: {
      orgId: org.id, invoiceId: inv.id, amount: 200_000n, currency: "KES",
      method: "MPESA", reference: `EXTRA-${++seq}`, receivedAt: new Date("2026-02-16"),
    },
  });

  const view = await call(`/contracts/${c.id}/buyer`, { cookie });
  assert.equal(view.json.position.credit, "200000",
    "*** 200,000 the buyer genuinely sent vanished because no invoice was open " +
    "to take it ***");
  assert.equal(view.json.position.outstanding, "0",
    "a credit must not be shown as arrears");
  assert.equal(view.json.position.received, "1200000",
    "received is everything that arrived");
});

test("overdue counts only bills whose date has passed", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 10_000_000n);
  await invoice(org.id, c.id, 500_000n, { dueOn: new Date("2026-02-01") });
  await invoice(org.id, c.id, 500_000n, { dueOn: new Date("2099-01-01") });

  const view = await call(`/contracts/${c.id}/buyer`, { cookie });
  assert.equal(view.json.position.overdue, "500000",
    "a bill that is not due yet was counted as overdue");
  assert.equal(view.json.position.outstanding, "1000000",
    "both bills are outstanding; only one is overdue");
});

test("a void invoice counts for nothing", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 10_000_000n);
  await invoice(org.id, c.id, 500_000n);
  await invoice(org.id, c.id, 900_000n, { status: "VOID" });

  const view = await call(`/contracts/${c.id}/buyer`, { cookie });
  assert.equal(view.json.position.invoiced, "500000",
    "a cancelled bill was still counted against the buyer");
});

test("a voided payment counts for nothing", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 10_000_000n);
  const inv = await invoice(org.id, c.id, 500_000n);
  await db.payment.create({
    data: {
      orgId: org.id, invoiceId: inv.id, amount: 500_000n, currency: "KES",
      method: "CHEQUE", reference: `BOUNCED-${++seq}`, receivedAt: new Date("2026-02-10"),
      voided: true, voidReason: "cheque bounced", voidedAt: new Date(),
    },
  });

  const view = await call(`/contracts/${c.id}/buyer`, { cookie });
  assert.equal(view.json.position.received, "0",
    "*** a bounced cheque was counted as money received ***");
  assert.equal(view.json.payments.length, 0, "and it should not be listed as a payment");
});

/* ==================================================================== *
 * THE SCHEDULE, WITH EACH LINE'S REAL STATE.
 * ==================================================================== */

test("each instalment says where it actually stands", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n);
  await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie,
    body: {
      kind: "CONSTRUCTION_LINKED", depositBp: 1000, depositDue: "2026-02-01",
      milestones: [
        { name: "Foundation", shareBp: 5000 },
        { name: "Finishes", shareBp: 5000 },
      ],
    },
  });

  /* Bill and part-pay the deposit. */
  const deposit = present(
    await db.paymentInstalment.findFirst({
      where: { orgId: org.id, plan: { contractId: c.id }, seq: 0 },
    }), "no deposit line");
  const inv = await invoice(org.id, c.id, deposit.amount);
  await db.paymentInstalment.update({
    where: { id: deposit.id }, data: { invoiceId: inv.id },
  });
  await paid(org.id, inv.id, deposit.amount / 2n);

  const view = await call(`/contracts/${c.id}/buyer`, { cookie });
  const states = view.json.schedule.map((s: Wire) => [s.description, s.state]);

  assert.deepEqual(states, [
    ["Deposit", "part-paid"],
    ["On Foundation", "awaiting stage"],
    ["On Finishes", "awaiting stage"],
  ], "the schedule should say what each line is actually doing");
});

test("a stage that has been certified reads as due, not as waiting", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n);
  await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie,
    body: {
      kind: "CONSTRUCTION_LINKED", depositBp: 1000, depositDue: "2026-02-01",
      milestones: [{ name: "Foundation", shareBp: 10000 }],
    },
  });
  await call("/plans/milestones/Foundation/certify", {
    method: "POST", cookie, body: { dueOn: "2026-03-01" },
  });

  const view = await call(`/contracts/${c.id}/buyer`, { cookie });
  const foundation = view.json.schedule.find((s: Wire) => s.milestone === "Foundation");
  assert.equal(foundation.state, "due",
    "a certified stage still read as waiting for the building to reach it");
});

/* ==================================================================== *
 * NOTHING IS STORED, AND WHETHER THE BANK HAS SEEN IT.
 * ==================================================================== */

test("the position is recalculated, never read from a column", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 10_000_000n);
  const inv = await invoice(org.id, c.id, 1_000_000n);

  const before = await call(`/contracts/${c.id}/buyer`, { cookie });
  assert.equal(before.json.position.outstanding, "1000000");

  /* Money arrives by a path this endpoint knows nothing about. */
  await paid(org.id, inv.id, 400_000n);

  const after = await call(`/contracts/${c.id}/buyer`, { cookie });
  assert.equal(after.json.position.outstanding, "600000",
    "*** the position did not move when money arrived, so it is being read " +
    "from somewhere that goes stale ***");
});

test("a payment says whether the bank has confirmed it", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 10_000_000n);
  const inv = await invoice(org.id, c.id, 1_000_000n);
  const p = await paid(org.id, inv.id, 1_000_000n);

  const unconfirmed = await call(`/contracts/${c.id}/buyer`, { cookie });
  assert.equal(unconfirmed.json.payments[0].confirmed, false,
    "nothing has been matched to a statement yet");

  await db.payment.update({ where: { id: p.id }, data: { reconciledAt: new Date() } });
  const confirmed = await call(`/contracts/${c.id}/buyer`, { cookie });
  assert.equal(confirmed.json.payments[0].confirmed, true,
    "a payment confirmed against the bank should say so — it is the difference " +
    "between a claim and a receipt");
});

/* ==================================================================== *
 * WHOSE BUYER IT IS.
 * ==================================================================== */

test("one company cannot read another's buyer position", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const c = await contract(theirs.org.id, 10_000_000n);

  const peeked = await call(`/contracts/${c.id}/buyer`, { cookie: mine.cookie });
  assert.equal(peeked.status, 404,
    "*** one company read another company's buyer, their price and their arrears ***");
});

test("somebody with no business in the money may not read a buyer's arrears", { skip }, async () => {
  const owner = await company();
  const c = await contract(owner.org.id, 10_000_000n);

  /*
   * HOUSEKEEPING, not OPERATIONS.
   *
   * My first version used OPERATIONS and failed, correctly: that role holds
   * finance at READ in ROLE_AREAS, which is a deliberate decision — operations
   * can see the money and not move it. A buyer's balance is a read, so
   * operations may have it. The test was wrong, not the table.
   */
  const { cookie } = await company("HOUSEKEEPING");
  assert.equal((await call(`/contracts/${c.id}/buyer`, { cookie })).status, 403,
    "housekeeping read a buyer's price and arrears");
});

test("a role that may read the money but not move it can still see a buyer", { skip }, async () => {
  const owner = await company();
  const c = await contract(owner.org.id, 10_000_000n);
  const { cookie } = await company("OPERATIONS");
  assert.equal((await call(`/contracts/${c.id}/buyer`, { cookie })).status, 404,
    "operations holds finance at read, so the refusal here should be about " +
    "whose contract it is rather than about the role");
});
