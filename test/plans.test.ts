/* ======================================================================
 * PAYMENT PLANS: THE SCHEDULE MUST ADD UP TO THE PRICE.
 *
 * Ported from paltas-dev-core's plan tests. The arithmetic assertions are
 * the point: a plan that totals one shilling more than the price means a
 * buyer who pays everything still owes money and cannot complete, and one
 * shilling less means a flat handed over with a balance nobody collects.
 * Both surface at handover, in front of the buyer.
 *
 * So several of these use deliberately awkward figures — prices that do
 * not divide, shares that do not — because a plan built from 1,000,000
 * over 4 instalments proves nothing at all.
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
const skip = DB ? false : "no TEST_DATABASE_URL — skipping payment-plan tests";

const SCHEMA = "plans_test";
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
      name: `Plan ${n} Ltd`, country: "ke",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const email = `plan${n}@example.test`;
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

/** A contract at a price, through the sales chain that makes one. */
async function contract(orgId: string, price: bigint, deposit = 0n) {
  const n = ++seq;
  return db.contract.create({
    data: {
      orgId, ref: `CON-${n}`, price, deposit, currency: "KES",
      status: "RESERVED", signedOn: new Date("2026-01-15"),
    },
  });
}

const TIME = {
  kind: "TIME_BASED", depositBp: 2000, count: 6,
  firstDue: "2026-02-01", everyMonths: 1,
};

/* ==================================================================== *
 * THE INVARIANT: IT ADDS UP.
 * ==================================================================== */

test("a plan adds up to the price exactly, even when it does not divide", { skip }, async () => {
  const { cookie, org } = await company();

  /* 1,000,001 over a 20% deposit and 7 instalments. Nothing here divides. */
  for (const price of [1_000_001n, 4_999_999n, 7n, 333_333_333n]) {
    const c = await contract(org.id, price);
    const made = await call(`/contracts/${c.id}/plan`, {
      method: "POST", cookie, body: { ...TIME, count: 7 },
    });
    assert.equal(made.status, 201, made.text.slice(0, 240));

    const total = made.json.plan.instalments
      .reduce((a: bigint, i: Wire) => a + BigInt(i.amount), 0n);
    assert.equal(total, price,
      `*** a plan on ${price} totals ${total}. A buyer who pays every ` +
      `instalment in full would still owe ${price - total}, and would find ` +
      `out at handover. ***`);
  }
});

test("the remainder lands on the last instalment, not spread about", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_001n);
  const made = await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie, body: { ...TIME, depositBp: 0, count: 3 },
  });

  const amounts = made.json.plan.instalments.map((i: Wire) => BigInt(i.amount));
  /* Deposit of zero, then three instalments of 1,000,001 / 3. */
  const body = amounts.slice(1);
  assert.equal(body.length, 3);
  assert.equal(body[0], body[1], "the error was spread across the instalments");
  assert.equal(body[2], body[0] + 2n,
    "the last instalment should carry the whole remainder");
});

test("a reservation fee already paid appears, and comes off the deposit", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n, 50_000n);
  const made = await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie, body: { ...TIME, depositBp: 2000, count: 4 },
  });
  assert.equal(made.status, 201, made.text.slice(0, 240));

  const lines = made.json.plan.instalments;
  assert.match(lines[0].description, /Reservation fee/i,
    "the fee the buyer already handed over is missing from the schedule");
  assert.equal(BigInt(lines[0].amount), 50_000n);
  assert.match(lines[1].description, /less reservation fee/i);
  assert.equal(BigInt(lines[1].amount), 150_000n,
    "a 20% deposit on 1,000,000 is 200,000, less the 50,000 already paid");

  const total = lines.reduce((a: bigint, i: Wire) => a + BigInt(i.amount), 0n);
  assert.equal(total, 1_000_000n, "the whole price should still be accounted for");
});

test("a deposit smaller than the fee already taken is refused", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n, 200_000n);
  const impossible = await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie, body: { ...TIME, depositBp: 500 },
  });
  assert.equal(impossible.status, 400,
    "a 5% deposit of 50,000 was accepted against 200,000 already paid");
  assert.match(String(impossible.json.message), /already handed over/i);
});

/* ==================================================================== *
 * CONSTRUCTION-LINKED: NO DATE UNTIL THE BUILDING GETS THERE.
 * ==================================================================== */

const STAGES = {
  kind: "CONSTRUCTION_LINKED", depositBp: 1000, depositDue: "2026-02-01",
  milestones: [
    { name: "Foundation", shareBp: 3000 },
    { name: "Superstructure", shareBp: 4000 },
    { name: "Finishes", shareBp: 3000 },
  ],
};

test("milestone shares must account for the whole balance", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n);
  const short = await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie,
    body: { ...STAGES, milestones: [{ name: "Foundation", shareBp: 3000 }] },
  });
  assert.equal(short.status, 400,
    "*** 30% of the balance was scheduled and the other 70% left unbilled ***");
  assert.match(String(short.json.message), /nobody will ever invoice/i);
});

test("a construction-linked plan adds up too, on a price that does not divide", { skip }, async () => {
  const { cookie, org } = await company();

  /*
   * A price where the milestone shares do NOT divide evenly.
   *
   * An earlier version of this file only tested 1,000,000 split 30/40/30 —
   * which comes to exactly 900,000 — so removing the rule that gives the LAST
   * milestone the remainder changed nothing and every test still passed. The
   * figures below are chosen so that rule is load-bearing.
   */
  for (const price of [1_000_001n, 4_999_997n, 11n]) {
    const c = await contract(org.id, price);
    const made = await call(`/contracts/${c.id}/plan`, {
      method: "POST", cookie, body: STAGES,
    });
    assert.equal(made.status, 201, made.text.slice(0, 240));

    const total = made.json.plan.instalments
      .reduce((a: bigint, i: Wire) => a + BigInt(i.amount), 0n);
    assert.equal(total, price,
      `*** a stage plan on ${price} totals ${total}. The ${price - total} ` +
      `difference is money that would never be invoiced, found at handover. ***`);
  }
});

test("a construction-linked instalment has no date until its stage is certified", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n);
  const made = await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie, body: STAGES,
  });
  assert.equal(made.status, 201, made.text.slice(0, 240));

  const staged = made.json.plan.instalments.filter((i: Wire) => i.milestone);
  assert.equal(staged.length, 3);
  assert.ok(staged.every((i: Wire) => i.dueOn === null),
    "a buyer was given a date for a stage the building has not reached");

  const read = await call(`/contracts/${c.id}/plan`, { cookie });
  assert.equal(read.json.plan.awaitingMilestone, 3,
    "a plan with no dates on it is normal here, and should be said out loud");

  /* The foundation is certified. */
  const certified = await call("/plans/milestones/Foundation/certify", {
    method: "POST", cookie, body: { dueOn: "2026-05-01" },
  });
  assert.equal(certified.status, 200, certified.text.slice(0, 200));
  assert.equal(certified.json.made, 1);

  const after = await call(`/contracts/${c.id}/plan`, { cookie });
  const foundation = after.json.plan.instalments.find((i: Wire) => i.milestone === "Foundation");
  assert.ok(foundation.dueOn, "certifying the stage did not make its instalment due");
  assert.equal(after.json.plan.awaitingMilestone, 2);
});

test("certifying the same stage twice does not move a date already given", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n);
  await call(`/contracts/${c.id}/plan`, { method: "POST", cookie, body: STAGES });

  await call("/plans/milestones/Foundation/certify", {
    method: "POST", cookie, body: { dueOn: "2026-05-01" },
  });
  const again = await call("/plans/milestones/Foundation/certify", {
    method: "POST", cookie, body: { dueOn: "2026-09-01" },
  });
  assert.equal(again.json.made, 0, "the same stage was certified twice");

  const plan = await call(`/contracts/${c.id}/plan`, { cookie });
  const foundation = plan.json.plan.instalments.find((i: Wire) => i.milestone === "Foundation");
  assert.match(String(foundation.dueOn), /^2026-05-01/,
    "*** a due date the buyer was already given was moved four months later ***");
});

/* ==================================================================== *
 * A PREVIEW WRITES NOTHING.
 * ==================================================================== */

test("a preview shows the schedule and saves none of it", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n);

  const shown = await call(`/contracts/${c.id}/plan/preview`, {
    method: "POST", cookie, body: TIME,
  });
  assert.equal(shown.status, 200, shown.text.slice(0, 240));
  assert.equal(BigInt(shown.json.total), 1_000_000n);
  assert.equal(shown.json.instalments.length, 7, "a deposit and six instalments");

  assert.equal(await db.paymentPlan.count({ where: { contractId: c.id } }), 0,
    "a preview a buyer is still thinking about was saved as agreed");
});

/* ==================================================================== *
 * RE-PLANNING SUPERSEDES, AND STOPS WHEN MONEY HAS BEEN ASKED FOR.
 * ==================================================================== */

test("a new plan supersedes the old one, which is kept", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n);
  await call(`/contracts/${c.id}/plan`, { method: "POST", cookie, body: TIME });
  await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie, body: { ...TIME, count: 12 },
  });

  const all = await db.paymentPlan.findMany({
    where: { contractId: c.id }, orderBy: { createdAt: "asc" },
  });
  assert.equal(all.length, 2, "the old plan was edited rather than superseded");
  assert.ok(all[0]?.supersededAt, "the first plan is still live");
  assert.equal(all[1]?.supersededAt, null);

  const live = await call(`/contracts/${c.id}/plan`, { cookie });
  assert.equal(live.json.plan.instalments.length, 13, "a deposit and twelve");
});

test("a plan cannot be redrawn once an instalment has been invoiced", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n);
  await call(`/contracts/${c.id}/plan`, { method: "POST", cookie, body: TIME });

  /* Bill the deposit. */
  const inv = await db.invoice.create({
    data: { orgId: org.id, ref: `INV-${++seq}`, currency: "KES", contractId: c.id },
  });
  const deposit = present(
    await db.paymentInstalment.findFirst({
      where: { orgId: org.id, plan: { contractId: c.id }, seq: 0 },
    }), "no instalment");
  await db.paymentInstalment.update({
    where: { id: deposit.id }, data: { invoiceId: inv.id },
  });

  const redrawn = await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie, body: { ...TIME, count: 12 },
  });
  assert.equal(redrawn.status, 409,
    "*** the plan was redrawn under a buyer who has already been billed ***");
  assert.match(String(redrawn.json.message), /Credit or settle/i);
});

test("one instalment cannot be invoiced twice", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n);
  await call(`/contracts/${c.id}/plan`, { method: "POST", cookie, body: TIME });

  const inv = await db.invoice.create({
    data: { orgId: org.id, ref: `INV-${++seq}`, currency: "KES", contractId: c.id },
  });
  const two = await db.paymentInstalment.findMany({
    where: { orgId: org.id, plan: { contractId: c.id } }, orderBy: { seq: "asc" }, take: 2,
  });
  await db.paymentInstalment.update({
    where: { id: present(two[0], "none").id }, data: { invoiceId: inv.id },
  });

  await assert.rejects(
    () => db.paymentInstalment.update({
      where: { id: present(two[1], "none").id }, data: { invoiceId: inv.id },
    }),
    /Unique constraint/,
    "one invoice was attached to two instalments — the buyer is billed twice " +
    "for the same stage, and the constraint is what should stop it");
});

/* ==================================================================== *
 * WHAT IS DUE — the list a scheduled job will work through.
 * ==================================================================== */

test("only instalments that are due and unbilled are listed", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n);
  await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie,
    body: { ...TIME, depositBp: 1000, count: 3, firstDue: "2026-02-01", everyMonths: 1 },
  });

  const due = await call("/plans/due?asAt=2026-03-15", { cookie });
  assert.equal(due.status, 200, due.text.slice(0, 200));
  /* The deposit (1 Feb) and the first instalment (1 Mar). Not April or May. */
  assert.equal(due.json.due.length, 2,
    `expected the deposit and one instalment, got ${due.json.due.length}`);
  assert.ok(due.json.due.every((d: Wire) => d.contract.ref === c.ref),
    "the list should say which contract each one belongs to");

  /* A construction-linked line with no date must never appear. */
  const c2 = await contract(org.id, 1_000_000n);
  await call(`/contracts/${c2.id}/plan`, { method: "POST", cookie, body: STAGES });
  const after = await call("/plans/due?asAt=2030-01-01", { cookie });
  const staged = after.json.due.filter((d: Wire) => /^On /.test(String(d.description)));
  assert.equal(staged.length, 0,
    "an instalment waiting on a stage the building has not reached was billed");
});

/* ==================================================================== *
 * WHOSE PLAN IT IS, AND WHO MAY SET ONE.
 * ==================================================================== */

test("one company cannot read or set another's payment plan", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const c = await contract(theirs.org.id, 1_000_000n);
  await call(`/contracts/${c.id}/plan`, { method: "POST", cookie: theirs.cookie, body: TIME });

  const peeked = await call(`/contracts/${c.id}/plan`, { cookie: mine.cookie });
  assert.equal(peeked.json.plan, null, "*** one company read another's payment terms ***");

  const meddled = await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie: mine.cookie, body: { ...TIME, count: 99 },
  });
  assert.equal(meddled.status, 404,
    "'exists but is not yours' must be indistinguishable from 'does not exist'");
  assert.equal(await db.paymentPlan.count({ where: { contractId: c.id } }), 1,
    "*** one company rewrote another company's payment plan ***");
});

test("somebody who may not touch the money may not set a plan", { skip }, async () => {
  const owner = await company();
  const c = await contract(owner.org.id, 1_000_000n);
  const { cookie } = await company("OPERATIONS");

  const tried = await call(`/contracts/${c.id}/plan`, {
    method: "POST", cookie, body: TIME,
  });
  assert.equal(tried.status, 403,
    "operations agreed what a buyer pays and when");
});

test("setting a plan and certifying a stage are both on the record", { skip }, async () => {
  const { cookie, org } = await company();
  const c = await contract(org.id, 1_000_000n);
  await call(`/contracts/${c.id}/plan`, { method: "POST", cookie, body: STAGES });
  await call("/plans/milestones/Foundation/certify", {
    method: "POST", cookie, body: { dueOn: "2026-05-01" },
  });

  const trail = await db.auditEvent.findMany({
    where: { orgId: org.id, action: { in: ["contract.plan.set", "plan.milestone.certify"] } },
    orderBy: { at: "asc" },
  });
  assert.deepEqual(trail.map((e) => e.action), ["contract.plan.set", "plan.milestone.certify"]);
  assert.equal((trail[0]?.detail as Wire)?.instalments, 4, "a deposit and three stages");
  assert.ok(trail.every((e) => e.actorName), "a payment plan with nobody attached to it");
});
