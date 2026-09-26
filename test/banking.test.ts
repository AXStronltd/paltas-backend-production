/* ======================================================================
 * RECONCILIATION: THE TWO SIDES THAT MUST BE MADE TO AGREE.
 *
 * Ported from paltas-dev-core's reconciliation test — duplicate statement
 * lines refused, unknown references left in the queue, one line proving
 * one payment — with the things a single-tenant in-memory module had no
 * concept of: an organization, a permission, an audit row, and a database
 * constraint doing the work instead of a check in a function.
 *
 * The assertion that matters most is the ambiguous one. Two payments of
 * the same amount quoting the same reference is where an automatic guess
 * is wrong about half the time, and a WRONG match costs more than no
 * match: the receipt goes to the wrong buyer, whose balance is then wrong,
 * and the buyer who really paid gets chased for money they have sent.
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
const skip = DB ? false : "no TEST_DATABASE_URL — skipping banking tests";

const SCHEMA = "banking_test";
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
      name: `Bank ${n} Ltd`, country: "ke",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const email = `bank${n}@example.test`;
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

/** A bank account through the API a finance screen would use. */
async function account(cookie: string, over: Record<string, unknown> = {}) {
  const made = await call("/banking/accounts", {
    method: "POST", cookie,
    body: { name: `Equity KES ${++seq}`, kind: "BANK", currency: "KES", ...over },
  });
  assert.equal(made.status, 201, made.text.slice(0, 240));
  return made.json.account;
}

/** A payment recorded directly, as a receipt taken at a desk would be. */
async function payment(orgId: string, over: Record<string, unknown> = {}) {
  return db.payment.create({
    data: {
      orgId, amount: 250_000n, currency: "KES", method: "BANK",
      reference: `TRF-${++seq}`, receivedAt: new Date("2026-03-10"), ...over,
    },
  });
}

const LINE = (over: Record<string, unknown> = {}) => ({
  valueOn: "2026-03-10", amount: 250_000, reference: "TRF-X", payerName: "A Buyer", ...over,
});

/* ==================================================================== *
 * A STATEMENT COMES IN.
 * ==================================================================== */

test("a statement is imported, and the same file twice is not", { skip }, async () => {
  const { cookie } = await company();
  const acct = await account(cookie);

  const first = await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie,
    body: { lines: [LINE({ reference: "A1" }), LINE({ reference: "A2", amount: 90_000 })] },
  });
  assert.equal(first.status, 201, first.text.slice(0, 240));
  assert.equal(first.json.imported, 2);
  assert.equal(first.json.duplicates.length, 0);

  /* The bank sends March again, with one new line on the end. */
  const again = await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie,
    body: { lines: [LINE({ reference: "A1" }), LINE({ reference: "A3", amount: 10_000 })] },
  });
  assert.equal(again.status, 201, again.text.slice(0, 240));
  assert.equal(again.json.imported, 1, "the new line should have gone in");
  assert.equal(again.json.duplicates.length, 1,
    "*** re-importing March doubled a receipt ***");

  assert.equal(await db.bankTransaction.count({ where: { bankAccountId: acct.id } }), 3);
});

test("a hyphen or a space does not make a new reference", { skip }, async () => {
  const { cookie } = await company();
  const acct = await account(cookie);

  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ reference: "INV-001" })] },
  });
  const spaced = await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ reference: "inv 001" })] },
  });
  assert.equal(spaced.json.duplicates.length, 1,
    "“INV-001” and “inv 001” are one reference written two ways");
});

test("a line in the wrong currency is refused, and nothing is imported", { skip }, async () => {
  const { cookie } = await company();
  const acct = await account(cookie, { currency: "KES" });

  const wrong = await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie,
    body: { lines: [LINE({ currency: "USD" })] },
  });
  assert.equal(wrong.status, 400);
  assert.match(String(wrong.json.message), /wrong file or the wrong account/i);
  assert.equal(await db.bankTransaction.count({ where: { bankAccountId: acct.id } }), 0);
});

/* ==================================================================== *
 * ONE LINE PROVES ONE PAYMENT.
 * ==================================================================== */

test("a payment is confirmed against the bank", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  const p = await payment(org.id, { reference: "TRF-100" });

  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ reference: "TRF-100" })] },
  });
  const line = present(
    await db.bankTransaction.findFirst({ where: { bankAccountId: acct.id } }), "no line");

  const matched = await call("/banking/match", {
    method: "POST", cookie, body: { paymentId: p.id, transactionId: line.id },
  });
  assert.equal(matched.status, 200, matched.text.slice(0, 240));

  const after = present(await db.payment.findUnique({ where: { id: p.id } }), "gone");
  assert.ok(after.reconciledAt, "the payment is still not confirmed");
  const usedLine = present(await db.bankTransaction.findUnique({ where: { id: line.id } }), "gone");
  assert.equal(usedLine.matchedPaymentId, p.id);
});

test("one statement line cannot prove two payments", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  const a = await payment(org.id, { reference: "TRF-200" });
  const b = await payment(org.id, { reference: "TRF-201" });

  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ reference: "TRF-200" })] },
  });
  const line = present(
    await db.bankTransaction.findFirst({ where: { bankAccountId: acct.id } }), "no line");

  assert.equal((await call("/banking/match", {
    method: "POST", cookie, body: { paymentId: a.id, transactionId: line.id },
  })).status, 200);

  const twice = await call("/banking/match", {
    method: "POST", cookie, body: { paymentId: b.id, transactionId: line.id },
  });
  assert.equal(twice.status, 409,
    "*** one receipt was used to prove two payments, so the money was counted twice ***");
  assert.match(String(twice.json.message), /one line is one receipt/i);
});

test("amounts that differ are not the same event", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  const p = await payment(org.id, { amount: 250_000n });

  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ amount: 249_500 })] },
  });
  const line = present(
    await db.bankTransaction.findFirst({ where: { bankAccountId: acct.id } }), "no line");

  const off = await call("/banking/match", {
    method: "POST", cookie, body: { paymentId: p.id, transactionId: line.id },
  });
  assert.equal(off.status, 400, "a 500-shilling difference was buried by the match");
  assert.match(String(off.json.message), /bank took a charge/i,
    "the refusal should say what to do about a bank charge");
});

test("money going out is not a receipt", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  const p = await payment(org.id, { amount: 250_000n });

  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ amount: -250_000 })] },
  });
  const line = present(
    await db.bankTransaction.findFirst({ where: { bankAccountId: acct.id } }), "no line");

  const out = await call("/banking/match", {
    method: "POST", cookie, body: { paymentId: p.id, transactionId: line.id },
  });
  assert.equal(out.status, 400);
  assert.match(String(out.json.message), /money going out/i);
});

test("a voided payment is not confirmed back into existence", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  const p = await payment(org.id, {
    reference: "TRF-300", voided: true, voidReason: "entered twice", voidedAt: new Date(),
  });

  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ reference: "TRF-300" })] },
  });
  const line = present(
    await db.bankTransaction.findFirst({ where: { bankAccountId: acct.id } }), "no line");

  const revived = await call("/banking/match", {
    method: "POST", cookie, body: { paymentId: p.id, transactionId: line.id },
  });
  assert.equal(revived.status, 409,
    "*** a voided payment was confirmed, putting back a figure somebody removed ***");
  assert.match(String(revived.json.message), /entered twice/,
    "the refusal should quote why it was voided");
});

test("a match can be undone, and the statement line is never edited", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  const p = await payment(org.id, { reference: "TRF-400" });
  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ reference: "TRF-400" })] },
  });
  const line = present(
    await db.bankTransaction.findFirst({ where: { bankAccountId: acct.id } }), "no line");
  await call("/banking/match", {
    method: "POST", cookie, body: { paymentId: p.id, transactionId: line.id },
  });

  const undone = await call(`/banking/transactions/${line.id}/unmatch`, {
    method: "POST", cookie,
  });
  assert.equal(undone.status, 200, undone.text.slice(0, 200));

  const after = present(await db.bankTransaction.findUnique({ where: { id: line.id } }), "gone");
  assert.equal(after.matchedPaymentId, null);
  assert.equal(after.amount, 250_000n, "unmatching altered the bank's own record");
  assert.equal(after.reference, "TRF-400", "unmatching altered the bank's own record");
  assert.equal(
    present(await db.payment.findUnique({ where: { id: p.id } }), "gone").reconciledAt, null);
});

/* ==================================================================== *
 * MATCHING WHAT AGREES, AND REFUSING TO GUESS.
 * ==================================================================== */

test("auto-match ties up what agrees on amount and reference", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  await payment(org.id, { reference: "TRF-500", amount: 250_000n });
  await payment(org.id, { reference: "TRF-501", amount: 90_000n });

  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie,
    body: { lines: [
      LINE({ reference: "trf 500", amount: 250_000 }),
      LINE({ reference: "TRF-501", amount: 90_000 }),
      LINE({ reference: "UNKNOWN-9", amount: 12_345 }),
    ] },
  });

  const run = await call(`/banking/accounts/${acct.id}/auto-match`, { method: "POST", cookie });
  assert.equal(run.status, 200, run.text.slice(0, 240));
  assert.equal(run.json.matched.length, 2, "the two that agreed were not matched");
  assert.equal(run.json.unmatchedLines, 1, "the unknown reference should stay in the queue");
  assert.equal(run.json.ambiguous.length, 0);
});

test("where two payments fit, nothing is matched", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);

  /*
   * TWO DIFFERENT METHODS, one reference.
   *
   * My first version of this test used two BANK payments and could not run at
   * all: Payment carries @@unique([orgId, method, reference]), so this service
   * already refuses two receipts of the same method quoting the same
   * reference — a stronger guard than the module this was ported from, which
   * allowed the duplicate and disambiguated later.
   *
   * What the unique does NOT cover is two methods sharing a reference, and
   * that is ordinary: a buyer told "quote MARCH" sends part by bank transfer
   * and part by M-PESA, both for the same instalment amount. A statement line
   * quoting MARCH then fits both.
   */
  await payment(org.id, { reference: "MARCH", amount: 250_000n, method: "BANK" });
  await payment(org.id, { reference: "MARCH", amount: 250_000n, method: "MPESA" });

  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ reference: "MARCH" })] },
  });

  const run = await call(`/banking/accounts/${acct.id}/auto-match`, { method: "POST", cookie });
  assert.equal(run.json.matched.length, 0,
    "*** an automatic guess picked one of two receipts. The confirmation goes " +
    "to the wrong one, whose record is then wrong, and the payment that really " +
    "arrived stays listed as missing. ***");
  assert.equal(run.json.ambiguous.length, 1, "it should be listed for a person to settle");
  assert.equal(run.json.ambiguous[0].candidates, 2);
  assert.match(String(run.json.said), /wrong buyer/i);
});

test("auto-match does not touch a line with no reference", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  await payment(org.id, { reference: "", amount: 250_000n });
  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ reference: "" })] },
  });

  const run = await call(`/banking/accounts/${acct.id}/auto-match`, { method: "POST", cookie });
  assert.equal(run.json.matched.length, 0,
    "a blank reference matched a blank reference, which is not agreement — it is " +
    "two absences");
  assert.equal(run.json.unmatchedLines, 1);
});

test("auto-match runs twice without matching anything twice", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  await payment(org.id, { reference: "TRF-600" });
  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ reference: "TRF-600" })] },
  });

  const first = await call(`/banking/accounts/${acct.id}/auto-match`, { method: "POST", cookie });
  const second = await call(`/banking/accounts/${acct.id}/auto-match`, { method: "POST", cookie });
  assert.equal(first.json.matched.length, 1);
  assert.equal(second.json.matched.length, 0, "the second run matched it again");
  assert.equal(second.json.unmatchedLines, 0);
});

/* ==================================================================== *
 * THE REPORT — the two questions that had no answer before.
 * ==================================================================== */

test("the unreconciled report names both sides", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  /* Money in the bank nobody has claimed. */
  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ reference: "WHOSE-IS-THIS" })] },
  });
  /* A receipt on the books that never turned up. */
  await payment(org.id, { reference: "NEVER-ARRIVED", method: "BANK" });
  /* A card payment, which the processor confirmed and no statement will show
     for days — it must NOT be reported as missing. */
  await payment(org.id, { reference: "CARD-1", method: "CARD" });

  const report = await call("/banking/unreconciled", { cookie });
  assert.equal(report.status, 200, report.text.slice(0, 200));
  assert.equal(report.json.lines.length, 1);
  assert.equal(report.json.lines[0].reference, "WHOSE-IS-THIS");
  assert.deepEqual(report.json.payments.map((p: Wire) => p.reference), ["NEVER-ARRIVED"],
    "a card payment was reported as never arriving, which will teach everybody " +
    "to ignore this report");
});

/* ==================================================================== *
 * WHOSE MONEY IT IS.
 * ==================================================================== */

test("one company cannot see or match another's bank lines", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const theirAcct = await account(theirs.cookie);
  const theirPayment = await payment(theirs.org.id, { reference: "TRF-700" });
  await call(`/banking/accounts/${theirAcct.id}/statement`, {
    method: "POST", cookie: theirs.cookie, body: { lines: [LINE({ reference: "TRF-700" })] },
  });
  const line = present(
    await db.bankTransaction.findFirst({ where: { bankAccountId: theirAcct.id } }), "no line");

  const listed = await call("/banking/accounts", { cookie: mine.cookie });
  assert.equal(listed.json.accounts.length, 0, "*** one company saw another's bank accounts ***");

  const peeked = await call("/banking/unreconciled", { cookie: mine.cookie });
  assert.equal(peeked.json.lines.length, 0, "*** one company saw another's bank statement ***");

  const stolen = await call("/banking/match", {
    method: "POST", cookie: mine.cookie,
    body: { paymentId: theirPayment.id, transactionId: line.id },
  });
  assert.equal(stolen.status, 404,
    "'exists but is not yours' must be indistinguishable from 'does not exist'");
  assert.equal(
    present(await db.payment.findUnique({ where: { id: theirPayment.id } }), "gone").reconciledAt,
    null, "*** one company confirmed another company's payment ***");

  const imported = await call(`/banking/accounts/${theirAcct.id}/statement`, {
    method: "POST", cookie: mine.cookie, body: { lines: [LINE({ reference: "X" })] },
  });
  assert.equal(imported.status, 404, "one company imported a statement into another's account");
});

/* ==================================================================== *
 * PERMISSION AND AUDIT.
 * ==================================================================== */

test("only somebody trusted with the money may reconcile", { skip }, async () => {
  const owner = await company();
  const acct = await account(owner.cookie);
  const { cookie } = await company("HOUSEKEEPING");

  assert.equal((await call("/banking/accounts", { cookie })).status, 403);
  assert.equal((await call(`/banking/accounts/${acct.id}/auto-match`,
    { method: "POST", cookie })).status, 403);
  assert.equal((await call("/banking/unreconciled", { cookie })).status, 403,
    "housekeeping read the company's bank statement");
});

test("every match and unmatch is on the record", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  const p = await payment(org.id, { reference: "TRF-800" });
  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie, body: { lines: [LINE({ reference: "TRF-800" })] },
  });
  const line = present(
    await db.bankTransaction.findFirst({ where: { bankAccountId: acct.id } }), "no line");
  await call("/banking/match", {
    method: "POST", cookie, body: { paymentId: p.id, transactionId: line.id },
  });
  await call(`/banking/transactions/${line.id}/unmatch`, { method: "POST", cookie });

  const trail = await db.auditEvent.findMany({
    where: { orgId: org.id, action: { startsWith: "banking." } },
    orderBy: { at: "asc" },
  });
  assert.deepEqual(trail.map((e) => e.action),
    ["banking.account.add", "banking.statement.import", "banking.match", "banking.unmatch"]);
  assert.ok(trail.every((e) => e.actorName), "a reconciliation with nobody attached to it");
});

test("a hand match records who decided, an auto match records that it was automatic", { skip }, async () => {
  const { cookie, org } = await company();
  const acct = await account(cookie);
  const byHand = await payment(org.id, { reference: "HAND-1" });
  const byRule = await payment(org.id, { reference: "AUTO-1", amount: 77_000n });
  await call(`/banking/accounts/${acct.id}/statement`, {
    method: "POST", cookie,
    body: { lines: [LINE({ reference: "HAND-1" }), LINE({ reference: "AUTO-1", amount: 77_000 })] },
  });

  const handLine = present(
    await db.bankTransaction.findFirst({ where: { bankAccountId: acct.id, refNorm: "HAND1" } }),
    "no line");
  await call("/banking/match", {
    method: "POST", cookie, body: { paymentId: byHand.id, transactionId: handLine.id },
  });
  await call(`/banking/accounts/${acct.id}/auto-match`, { method: "POST", cookie });

  const hand = present(await db.bankTransaction.findUnique({ where: { id: handLine.id } }), "gone");
  const auto = present(
    await db.bankTransaction.findFirst({ where: { bankAccountId: acct.id, refNorm: "AUTO1" } }),
    "no line");
  assert.notEqual(hand.matchedBy, "auto",
    "a person's decision was recorded as automatic — an auto-match that goes " +
    "wrong is a rule to fix, and a hand match that does is a conversation");
  assert.equal(auto.matchedBy, "auto");
  assert.equal(auto.matchedPaymentId, byRule.id);
});
