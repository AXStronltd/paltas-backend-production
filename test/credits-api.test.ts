/* ====================================================================== *
 * THE LEDGER, END TO END.
 *
 * domain/ledger.js enforces four rules — a posted entry balances, a posted
 * entry is immutable, a closed period does not move, and nothing crosses an
 * organization. It has enforced them for some time with no way to reach it.
 * These are the tests that the ROUTES do not quietly weaken any of them.
 *
 * ── WHY THIS NEEDS A REAL DATABASE ─────────────────────────────────────
 *
 * Most end-to-end tests in this suite can run against test/fake-prisma.js.
 * These cannot, and the fake says so itself: accountBalance() filters lines
 * THROUGH their entry — `where: { entry: { status: "POSTED" } }` — and the
 * fake refuses relation filters rather than pretending to support them.
 *
 * That is the right outcome anyway. This is the money. The things worth
 * proving here are a real transaction rolling back, a real unique constraint
 * on the entry reference, and BigInt arriving back as the figure that was
 * sent — none of which an in-memory stand-in can honestly answer.
 *
 *     npx prisma generate
 *     TEST_DATABASE_URL=postgresql://…  npm test
 *
 * Without a database this file skips, like the other end-to-end files.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
import { portOf } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

/* Its own schema, dropped and rebuilt every run — so it must not be one any
   other file reads. NOT "test_ledger": that belongs to ledger.test.js, which
   proves the same rules one layer down, and two files dropping one schema
   concurrently fails with a duplicate-type error that reads like a broken
   migration rather than a name clash. */
const SCHEMA = "test_credits_api";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping credit tests";
/* The sentence explain() produced, held so it prints in full at the end of
   the run rather than truncated into a skip reason. */
let dbHelp: string | null = null;
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
      skip = "RUN `npx prisma generate` FIRST — the credit tests cannot run without it";
    } else {
      const help = explain(e, DB);
      if (help) { skip = "database configuration — see below"; dbHelp = help; }
      else skip = "database unreachable: " + m.slice(0, 90);
    }
  }
}

/* ---------------------------------------------------------------- rig */

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

async function signIn(
  { email, name, orgId }: { email: string; name: string; orgId?: string },
) {
  const user = await db.user.upsert({
    where: { email },
    create: { email, name, googleSub: "sub_" + email },
    update: {},
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: orgId || null,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return { user, cookie: `paltas_session=${token}` };
}

let seq = 0;
async function company(
  { role = "OWNER", country = "ke" }: { role?: import("@prisma/client").$Enums.Role; country?: string } = {},
) {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Credits Co ${n}`, country,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `credits${n}@example.com`, name: `Person ${n}`, orgId: org.id,
  });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
  return { org, user, cookie };
}

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
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (dbHelp) console.log("\n" + "─".repeat(72) + "\n" + dbHelp + "\n" + "─".repeat(72) + "\n");
});

/* ====================================================================== *
 * REACHABILITY — the thing that was actually missing
 * ====================================================================== */

/* ====================================================================== *
 * END TO END, AGAINST A REAL DATABASE.
 * ====================================================================== */

/** An issued invoice for 100,000, optionally part paid. */
async function invoiceOf(cookie: string, { paid = 0 } = {}) {
  const party = (await call("/parties", {
    method: "POST", cookie, body: { name: "A Payer", kind: "TENANT" },
  })).json.party;

  const inv = (await call("/invoices", {
    method: "POST", cookie,
    body: { partyId: party.id, currency: "KES", dueOn: "2026-10-01" },
  })).json.invoice;

  await call(`/invoices/${inv.id}/lines`, {
    method: "POST", cookie, body: { detail: "Rent", quantity: 1, unitPrice: 100_000 },
  });
  /* Issued by moving it off DRAFT — `status` is a writable field on the
     invoices resource, and afterWrite() is what stamps issuedOn. */
  await call(`/invoices/${inv.id}`, { method: "PATCH", cookie, body: { status: "SENT" } });

  let payment = null;
  if (paid) {
    payment = (await call("/payments", {
      method: "POST", cookie,
      body: { invoiceId: inv.id, amount: paid, method: "CASH", receivedBy: "A Person" },
    })).json.payment;
  }
  const after = (await call(`/invoices/${inv.id}`, { cookie })).json.invoice;
  return { party, invoice: after, payment };
}

test("a credit note reduces what is owed without inventing cash", { skip }, async () => {
  const { cookie } = await company();
  const { invoice } = await invoiceOf(cookie);

  const res = await call(`/invoices/${invoice.id}/credit-notes`, {
    method: "POST", cookie, body: { amount: 40_000, reason: "billed for a month they had left" },
  });
  assert.equal(res.status, 201, `${res.status} ${res.text.slice(0, 200)}`);
  assert.match(res.json.creditNote.ref, /^CN-\d{4}$/);

  const after = res.json.invoice;
  /* THE WHOLE POINT. Credited, not paid — a collections screen reads `paid`,
     and cash that never arrived must not appear there. */
  assert.equal(Number(after.credited), 40_000);
  assert.equal(Number(after.paid), 0);
  assert.equal(after.status, "PART_PAID");
});

test("crediting the rest settles the invoice", { skip }, async () => {
  const { cookie } = await company();
  const { invoice } = await invoiceOf(cookie);
  await call(`/invoices/${invoice.id}/credit-notes`, {
    method: "POST", cookie, body: { amount: 100_000, reason: "goodwill, unit was uninhabitable" },
  });
  const after = (await call(`/invoices/${invoice.id}`, { cookie })).json.invoice;
  assert.equal(after.status, "PAID", "an invoice credited in full is not still owed");
  assert.equal(Number(after.paid), 0, "and still no money arrived");
});

test("it cannot credit more than is owed", { skip }, async () => {
  const { cookie } = await company();
  const { invoice } = await invoiceOf(cookie, { paid: 60_000 });

  const res = await call(`/invoices/${invoice.id}/credit-notes`, {
    method: "POST", cookie, body: { amount: 50_000, reason: "trying it on" },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /more than is owed/);
});

test("a credit note needs a reason", { skip }, async () => {
  const { cookie } = await company();
  const { invoice } = await invoiceOf(cookie);
  const res = await call(`/invoices/${invoice.id}/credit-notes`, {
    method: "POST", cookie, body: { amount: 1_000 },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /reason/i);
});

test("credit notes disappear from arrears, so nobody is chased for them", { skip }, async () => {
  const { cookie } = await company();
  const { invoice } = await invoiceOf(cookie);

  const before = await call("/ledger/receivables", { cookie });
  assert.equal(Number(before.json.books[0].open), 100_000);

  await call(`/invoices/${invoice.id}/credit-notes`, {
    method: "POST", cookie, body: { amount: 100_000, reason: "written off, tenant absconded" },
  });

  const after = await call("/ledger/receivables", { cookie });
  const open = after.json.books.length ? Number(after.json.books[0].open) : 0;
  assert.equal(open, 0, "a bill the company withdrew is still being chased");
});

test("voiding a credit note owes the money again", { skip }, async () => {
  const { cookie } = await company();
  const { invoice } = await invoiceOf(cookie);
  const note = (await call(`/invoices/${invoice.id}/credit-notes`, {
    method: "POST", cookie, body: { amount: 100_000, reason: "raised against the wrong invoice" },
  })).json.creditNote;

  const res = await call(`/credit-notes/${note.id}/void`, {
    method: "POST", cookie, body: { reason: "it was the right invoice after all" },
  });
  assert.equal(res.status, 200, `${res.status} ${res.text.slice(0, 160)}`);
  assert.equal(Number(res.json.invoice.credited), 0);
  assert.notEqual(res.json.invoice.status, "PAID");
});

test("a credit note cannot be written directly, edited or deleted", { skip }, async () => {
  const { cookie } = await company();
  const { invoice } = await invoiceOf(cookie);
  const note = (await call(`/invoices/${invoice.id}/credit-notes`, {
    method: "POST", cookie, body: { amount: 10_000, reason: "a small correction" },
  })).json.creditNote;

  const made = await call("/credit-notes", {
    method: "POST", cookie, body: { invoiceId: invoice.id, amount: 999_999, currency: "KES", reason: "forged" },
  });
  assert.notEqual(made.status, 201, "money was written off without an invoice to check it against");

  const patched = await call(`/credit-notes/${note.id}`, {
    method: "PATCH", cookie, body: { amount: 999_999 },
  });
  assert.notEqual(patched.status, 200, "a credit note was edited after the ledger was posted");

  const deleted = await call(`/credit-notes/${note.id}`, { method: "DELETE", cookie });
  assert.notEqual(deleted.status, 200);
});

/* ---------------------------------------------------------------- refunds */

test("a refund sends money back and the invoice is owed again", { skip }, async () => {
  const { cookie } = await company();
  const { invoice, payment } = await invoiceOf(cookie, { paid: 100_000 });
  assert.equal(invoice.status, "PAID");

  const res = await call(`/payments/${payment.id}/refund`, {
    method: "POST", cookie, body: { amount: 100_000, reason: "sale fell through before completion" },
  });
  assert.equal(res.status, 201, `${res.status} ${res.text.slice(0, 200)}`);
  assert.equal(Number(res.json.refund.amount), -100_000, "a refund is a negative payment");

  const after = res.json.invoice;
  assert.equal(Number(after.paid), 0, "the money went back, so it is not collected");
  assert.notEqual(after.status, "PAID", "giving the money back does not cancel the bill");
});

test("it cannot refund more than arrived, or twice", { skip }, async () => {
  const { cookie } = await company();
  const { payment } = await invoiceOf(cookie, { paid: 100_000 });

  const tooMuch = await call(`/payments/${payment.id}/refund`, {
    method: "POST", cookie, body: { amount: 100_001, reason: "sending out more than came in" },
  });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.json.message, /more than was received/);

  await call(`/payments/${payment.id}/refund`, {
    method: "POST", cookie, body: { amount: 60_000, reason: "partial, unit was late" },
  });
  const again = await call(`/payments/${payment.id}/refund`, {
    method: "POST", cookie, body: { amount: 60_000, reason: "the same money twice" },
  });
  assert.equal(again.status, 400, "the company paid out 120,000 against 100,000 received");
  assert.match(again.json.message, /more than was received/);
});

test("a screen can ask what is left to credit or refund", { skip }, async () => {
  const { cookie } = await company();
  const { invoice, payment } = await invoiceOf(cookie, { paid: 40_000 });

  const c = await call(`/invoices/${invoice.id}/credit-notes`, { cookie });
  assert.equal(c.json.creditable, "60000", "the unpaid part is what may be credited");

  const r = await call(`/payments/${payment.id}/refund`, { cookie });
  assert.equal(r.json.refundable, "40000", "the part that arrived is what may be refunded");
});

test("both reach the ledger, and say so when they cannot", { skip }, async () => {
  const { cookie } = await company();
  const { invoice } = await invoiceOf(cookie);
  const res = await call(`/invoices/${invoice.id}/credit-notes`, {
    method: "POST", cookie, body: { amount: 10_000, reason: "a correction worth booking" },
  });
  /* No chart is seeded here, so the honest answer is a stated skip rather
     than silence — the same contract every other posting keeps. */
  /* bookingOf() answers {booked, why}: a journal ref, or the sentence saying
     why there is none. Never both null — silence about whether the books
     moved is the one answer finance cannot use. */
  const b = res.json.booking;
  assert.ok(b, "the response does not say whether it was booked");
  assert.ok(b.booked || b.why, "a booking that neither posted nor explained itself");
  assert.match(String(b.why || ""), /chart of accounts/,
    "no chart is seeded here, so it should say exactly that");
});

test("one company cannot credit or refund another's", { skip }, async () => {
  const a = await company();
  const b = await company();
  const { invoice, payment } = await invoiceOf(a.cookie, { paid: 100_000 });

  const credit = await call(`/invoices/${invoice.id}/credit-notes`, {
    method: "POST", cookie: b.cookie, body: { amount: 1_000, reason: "another company's invoice" },
  });
  assert.equal(credit.status, 404);

  const refund = await call(`/payments/${payment.id}/refund`, {
    method: "POST", cookie: b.cookie, body: { amount: 1_000, reason: "another company's money" },
  });
  assert.equal(refund.status, 404);
});

test("both are written to the audit trail", { skip }, async () => {
  const { cookie, org } = await company();
  const { invoice, payment } = await invoiceOf(cookie, { paid: 100_000 });
  await call(`/payments/${payment.id}/refund`, {
    method: "POST", cookie, body: { amount: 10_000, reason: "part refund for the late handover" },
  });
  await call(`/invoices/${invoice.id}/credit-notes`, {
    method: "POST", cookie, body: { amount: 5_000, reason: "goodwill on the same matter" },
  });

  const actions = (await db.auditEvent.findMany({ where: { orgId: org.id } })).map((e) => e.action);
  assert.ok(actions.includes("payment.refund"), "a refund left no trace");
  assert.ok(actions.includes("credit-note.issue"), "a credit note left no trace");
});
