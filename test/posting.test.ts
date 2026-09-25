/* ====================================================================== *
 * BUSINESS EVENTS, AND THE ENTRIES THEY POST.
 *
 * domain/posting.js turns an invoice, a payment and an expense into journal
 * entries. Two properties matter more than any of the arithmetic, and they
 * pull in opposite directions:
 *
 *   1. THE BOOKS MUST FOLLOW THE BUSINESS. A rent payment that never reaches
 *      the ledger makes every report built on it wrong.
 *
 *   2. THE BOOKS MUST NEVER BLOCK THE BUSINESS. Not one company in production
 *      has a chart of accounts. If posting were required, every invoice and
 *      every payment would have started failing the moment this shipped.
 *
 * Most of what is below is rule 2. It is the one that costs a customer money
 * when it is wrong, and it is the one that looks like an improvement right up
 * until somebody cannot record a payment.
 *
 *     npx prisma generate
 *     TEST_DATABASE_URL=postgresql://…  npm test
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
import { portOf } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_posting";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping posting tests";
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
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${portOf(server)}`;
}

let seq = 0;
async function company() {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Posting Co ${n}`, country: "ke",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const email = `posting${n}@example.com`;
  const user = await db.user.create({
    data: { email, name: `Person ${n}`, googleSub: "sub_" + email },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: org.id, expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role: "OWNER" } });
  return { org, cookie: `paltas_session=${token}` };
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

const seedChart = (cookie: Wire) => call("/ledger/accounts/seed", { method: "POST", cookie });

/** The trial balance, as a code → row map. */
async function books(cookie: Wire) {
  const { json } = await call("/ledger/trial-balance", { cookie });
  return {
    balanced: json.balanced,
    by: Object.fromEntries(json.rows.map((r: Wire) => [r.code, r])),
  };
}

/** An invoice with one line, issued. */
async function issuedInvoice(cookie: Wire, { amount = 8_500_000, taxBps = 0 } = {}) {
  const made = await call("/invoices", { method: "POST", cookie, body: { currency: "KES" } });
  const id = made.json.invoice.id;
  await call(`/invoices/${id}/lines`, {
    method: "POST", cookie,
    body: { detail: "March rent", quantity: 1, unitPrice: amount, taxBps },
  });
  const sent = await call(`/invoices/${id}`, {
    method: "PATCH", cookie, body: { status: "SENT", issuedOn: "2026-03-01" },
  });
  return { id, res: sent };
}

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (dbHelp) console.log("\n" + "─".repeat(72) + "\n" + dbHelp + "\n" + "─".repeat(72) + "\n");
});

/* ====================================================================== *
 * RULE 2 FIRST — the books never block the business
 * ====================================================================== */

test("with no chart of accounts, a payment is still recorded", { skip }, async () => {
  /*
   * THE TEST THIS FILE EXISTS FOR. Every company in production is in exactly
   * this state. If this ever fails, shipping it stops people banking rent.
   */
  const { cookie } = await company();
  const { id } = await issuedInvoice(cookie);

  const res = await call("/payments", {
    method: "POST", cookie,
    body: { invoiceId: id, amount: 8_500_000, method: "MPESA", reference: "QK7X1" },
  });

  assert.equal(res.status, 201, `a payment was refused: ${res.text.slice(0, 200)}`);
  assert.equal(Number(res.json.payment.amount), 8_500_000);
  assert.equal(res.json.booking.booked, null, "it claimed to book without a chart");
  assert.match(res.json.booking.why, /chart of accounts/i,
    "the reason was not stated, so the gap would be invisible");
});

test("with no chart, an expense is still recorded", { skip }, async () => {
  const { cookie } = await company();
  const res = await call("/expenses", {
    method: "POST", cookie,
    body: { detail: "Generator service", category: "maintenance", amount: 1_250_000, currency: "KES" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.booking.booked, null);
  assert.match(res.json.booking.why, /chart of accounts/i);
});

test("a payment in a closed period is taken, and says it was not booked", { skip }, async () => {
  /*
   * The period rule protects the BOOKS. It must not reach back and refuse
   * money that has already arrived in the bank.
   */
  const { cookie } = await company();
  await seedChart(cookie);

  const period = await call("/ledger/periods", {
    method: "POST", cookie,
    body: { label: "March 2026", opensAt: "2026-03-01", closesAt: "2026-03-31" },
  });
  await call(`/ledger/periods/${period.json.period.id}/close`, { method: "POST", cookie });

  const { id } = await issuedInvoice(cookie);
  const res = await call("/payments", {
    method: "POST", cookie,
    body: {
      invoiceId: id, amount: 1_000_000, method: "CASH", reference: "C-1",
      receivedAt: "2026-03-15",
    },
  });

  assert.equal(res.status, 201, "a closed period refused a payment");
  assert.equal(res.json.booking.booked, null);
  assert.match(res.json.booking.why, /closed/i);
});

/* ====================================================================== *
 * RULE 1 — with a chart, the books follow the business
 * ====================================================================== */

test("an issued invoice books receivable against income", { skip }, async () => {
  const { cookie } = await company();
  await seedChart(cookie);

  const { res } = await issuedInvoice(cookie, { amount: 8_500_000 });
  assert.equal(res.status, 200);
  assert.match(res.json.booking.booked || "", /^JE-\d{4}$/, `not booked: ${res.json.booking.why}`);

  const { by, balanced } = await books(cookie);
  assert.equal(balanced, true);
  assert.equal(Number(by["1100"].debit), 8_500_000, "receivable was not debited");
  assert.equal(Number(by["4090"].credit), 8_500_000, "income was not credited");
});

test("tax on an invoice is held as a liability, not counted as income", { skip }, async () => {
  const { cookie } = await company();
  await seedChart(cookie);

  /* 10,000.00 net at 16% — the gross is 11,600.00 and 1,600.00 of it is the
     tax authority's, not the company's earnings. */
  await issuedInvoice(cookie, { amount: 1_000_000, taxBps: 1600 });

  const { by, balanced } = await books(cookie);
  assert.equal(balanced, true);
  assert.equal(Number(by["1100"].debit), 1_160_000, "the receivable is the gross");
  assert.equal(Number(by["4090"].credit), 1_000_000, "income is the net");
  assert.equal(Number(by["2300"].credit), 160_000, "the tax was counted as income");
});

test("a payment moves the receivable into the bank", { skip }, async () => {
  const { cookie } = await company();
  await seedChart(cookie);
  const { id } = await issuedInvoice(cookie, { amount: 8_500_000 });

  const res = await call("/payments", {
    method: "POST", cookie,
    body: { invoiceId: id, amount: 8_500_000, method: "MPESA", reference: "QK9Z2" },
  });
  assert.match(res.json.booking.booked || "", /^JE-\d{4}$/, `not booked: ${res.json.booking.why}`);

  const { by, balanced } = await books(cookie);
  assert.equal(balanced, true);
  assert.equal(Number(by["1000"].debit), 8_500_000, "the bank was not debited");
  /* Invoiced then paid: the receivable is raised and cleared, so it nets off. */
  assert.equal(Number(by["1100"].balance), 0, "the receivable was not cleared");
});

test("cash goes to cash and a transfer goes to the bank", { skip }, async () => {
  const { cookie } = await company();
  await seedChart(cookie);
  const a = await issuedInvoice(cookie, { amount: 400_000 });
  const b = await issuedInvoice(cookie, { amount: 600_000 });

  await call("/payments", { method: "POST", cookie,
    body: { invoiceId: a.id, amount: 400_000, method: "CASH", reference: "C-9" } });
  await call("/payments", { method: "POST", cookie,
    body: { invoiceId: b.id, amount: 600_000, method: "BANK", reference: "B-9" } });

  const { by } = await books(cookie);
  assert.equal(Number(by["1010"].debit), 400_000, "cash did not land in cash");
  assert.equal(Number(by["1000"].debit), 600_000, "a transfer did not land in the bank");
});

test("an expense books the cost against what is owed for it", { skip }, async () => {
  const { cookie } = await company();
  await seedChart(cookie);

  const res = await call("/expenses", {
    method: "POST", cookie,
    body: { detail: "Lift service", category: "maintenance", amount: 1_250_000, currency: "KES" },
  });
  assert.equal(res.status, 201);
  assert.match(res.json.booking.booked || "", /^JE-\d{4}$/, `not booked: ${res.json.booking.why}`);

  const { by, balanced } = await books(cookie);
  assert.equal(balanced, true);
  assert.equal(Number(by["5000"].debit), 1_250_000, "maintenance was not charged");
  assert.equal(Number(by["2000"].credit), 1_250_000, "nothing was recorded as owed");
});

test("an unrecognised expense category books to other operating expenses", { skip }, async () => {
  const { cookie } = await company();
  await seedChart(cookie);
  await call("/expenses", {
    method: "POST", cookie,
    body: { detail: "Drone survey", category: "aerial-survey", amount: 90_000, currency: "KES" },
  });
  const { by } = await books(cookie);
  assert.equal(Number(by["5900"].debit), 90_000,
    "a cost with no matching heading was left out of the books entirely");
});

/* ====================================================================== *
 * UNDOING, AND NOT DOING IT TWICE
 * ====================================================================== */

test("voiding a payment posts the mirror and leaves the bank flat", { skip }, async () => {
  const { cookie } = await company();
  await seedChart(cookie);
  const { id } = await issuedInvoice(cookie, { amount: 2_000_000 });

  const paid = await call("/payments", {
    method: "POST", cookie,
    body: { invoiceId: id, amount: 2_000_000, method: "BANK", reference: "V-1" },
  });
  const before = await books(cookie);
  assert.equal(Number(before.by["1000"].balance), 2_000_000);

  const voided = await call(`/payments/${paid.json.payment.id}/void`, {
    method: "POST", cookie, body: { reason: "Bounced at the bank" },
  });
  assert.equal(voided.status, 200);
  assert.match(voided.json.booking.booked || "", /^JE-\d{4}$/, `not reversed: ${voided.json.booking.why}`);

  const after = await books(cookie);
  assert.equal(after.balanced, true);
  assert.equal(Number(after.by["1000"].balance), 0, "the bank kept money that bounced");
  /* Both halves stay in the journal — a void is a correction, not an erasure. */
  const entries = await call("/ledger/entries", { cookie });
  assert.equal(entries.json.entries.filter((e: Wire) => e.sourceType === "payment").length, 2);
});

test("the same business row is never booked twice", { skip }, async () => {
  /*
   * UN-SEND AND RE-SEND, which is the path that actually reaches the guard.
   *
   * A second PATCH straight to SENT proves nothing: the hook only fires when
   * the status LEAVES draft, so a SENT → SENT write returns before the bridge
   * is called at all. I wrote that test first, deleted the idempotency check
   * to see it fail, and it passed — the transition guard was doing the work
   * and `alreadyPosted` was untested.
   *
   * Taking the invoice back to DRAFT and issuing it again makes the hook fire
   * a second time with before.status === "DRAFT", so the only thing standing
   * between this company and a doubled receivable is the sourceId check.
   */
  const { cookie } = await company();
  await seedChart(cookie);
  const { id } = await issuedInvoice(cookie, { amount: 5_000_000 });

  const before = await books(cookie);
  assert.equal(Number(before.by["1100"].debit), 5_000_000);

  await call(`/invoices/${id}`, { method: "PATCH", cookie, body: { status: "DRAFT" } });
  const again = await call(`/invoices/${id}`, { method: "PATCH", cookie, body: { status: "SENT" } });
  assert.equal(again.status, 200);
  assert.match(again.json.booking.why || "", /already booked as JE-\d{4}/,
    "the second issue did not recognise that this invoice was already in the books");

  const after = await books(cookie);
  assert.equal(Number(after.by["1100"].debit), 5_000_000,
    "the same invoice was booked twice — the receivable doubled");

  const { json } = await call("/ledger/entries", { cookie });
  assert.equal(json.entries.filter((e: Wire) => e.sourceType === "invoice").length, 1);
});

test("a payment not against an invoice is left for a person to book", { skip }, async () => {
  /*
   * There is no receivable for it to clear, and crediting income instead
   * would decide on the customer's behalf that money in hand has been
   * earned. That is a revenue-recognition judgement, not a mapping.
   */
  const { cookie } = await company();
  await seedChart(cookie);

  const res = await call("/payments", {
    method: "POST", cookie,
    body: { amount: 300_000, method: "CASH", reference: "LOOSE-1", currency: "KES" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.booking.booked, null);
  assert.match(res.json.booking.why, /invoice/i);
});

/* ====================================================================== *
 * AND THE WHOLE CYCLE
 * ====================================================================== */

test("invoice, pay, spend — and the books still balance", { skip }, async () => {
  const { cookie } = await company();
  await seedChart(cookie);

  const a = await issuedInvoice(cookie, { amount: 8_500_000 });
  const b = await issuedInvoice(cookie, { amount: 1_000_000, taxBps: 1600 });
  await call("/payments", { method: "POST", cookie,
    body: { invoiceId: a.id, amount: 8_500_000, method: "MPESA", reference: "CYC-1" } });
  await call("/expenses", { method: "POST", cookie,
    body: { detail: "Cleaning", category: "cleaning", amount: 400_000, currency: "KES" } });

  const { by, balanced } = await books(cookie);
  assert.equal(balanced, true, "a full cycle left the books out of balance");

  assert.equal(Number(by["1000"].balance), 8_500_000, "bank");
  assert.equal(Number(by["1100"].balance), 1_160_000, "one invoice is still outstanding, gross");
  assert.equal(Number(by["4090"].balance), 9_500_000, "income is both invoices, net of tax");
  assert.equal(Number(by["2300"].balance), 160_000, "tax held");
  assert.equal(Number(by["5030"].balance), 400_000, "cleaning");
  assert.equal(Number(by["2000"].balance), 400_000, "owed for it");

  /* The one identity that has to hold: what the business has, less what it
     owes, equals what it earned less what it spent. */
  const assets = 8_500_000 + 1_160_000;
  const liabilities = 160_000 + 400_000;
  const earned = 9_500_000 - 400_000;
  assert.equal(assets - liabilities, earned);
});

test("every entry the bridge posts says which row it came from", { skip }, async () => {
  const { cookie } = await company();
  await seedChart(cookie);
  const { id } = await issuedInvoice(cookie, { amount: 700_000 });
  await call("/payments", { method: "POST", cookie,
    body: { invoiceId: id, amount: 700_000, method: "CARD", reference: "SRC-1" } });

  const { json } = await call("/ledger/entries", { cookie });
  const sources = json.entries.map((e: Wire) => e.sourceType).sort();
  assert.deepEqual(sources, ["invoice", "payment"],
    "an automatic entry did not record what caused it, so nothing can be traced back");

  /* And the id is the real row's, so report → entry → the invoice works. */
  const inv = json.entries.find((e: Wire) => e.sourceType === "invoice");
  assert.equal(inv.sourceId, id);
});

/* ====================================================================== *
 * THE ADOPTION STEP — a company arrives with books
 * ====================================================================== */

/** Somebody signed in who does not belong to a company yet. */
async function newcomer() {
  const n = ++seq;
  const email = `founder${n}@example.com`;
  const user = await db.user.create({
    data: { email, name: `Founder ${n}`, googleSub: "sub_" + email },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: null, expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return { cookie: `paltas_session=${token}` };
}

test("a company created through signup already has a chart of accounts", { skip }, async () => {
  const { cookie } = await newcomer();
  const res = await call("/organizations", {
    method: "POST", cookie,
    body: { name: "Riverside Holdings", work: ["property"], country: "ke" },
  });
  assert.equal(res.status, 201, res.text.slice(0, 200));
  assert.ok(res.json.chartOfAccounts > 20,
    `only ${res.json.chartOfAccounts} accounts were seeded at signup`);

  const chart = await call("/ledger/accounts", { cookie });
  assert.equal(chart.status, 200);
  const codes = chart.json.accounts.map((a: Wire) => a.code);
  for (const needed of ["1000", "1100", "2000", "2300", "4000", "5000"]) {
    assert.ok(codes.includes(needed), `the starting chart is missing ${needed}`);
  }
});

test("a brand-new company's first invoice and payment book themselves", { skip }, async () => {
  /*
   * THE POINT OF SEEDING AT SIGNUP.
   *
   * No seeding call, no setup, nothing but the company being created: the
   * first invoice it issues and the first payment it takes reach the ledger
   * on their own. Before this, every company in production was in the other
   * state — every posting skipped, with a reason nobody had read.
   */
  const { cookie } = await newcomer();
  const made = await call("/organizations", {
    method: "POST", cookie,
    body: { name: "Kilimani Estates", work: ["property"], country: "ke" },
  });
  assert.equal(made.status, 201);

  const { id, res } = await issuedInvoice(cookie, { amount: 8_500_000 });
  assert.match(res.json.booking.booked || "", /^JE-\d{4}$/,
    `the first invoice was not booked: ${res.json.booking.why}`);

  const paid = await call("/payments", {
    method: "POST", cookie,
    body: { invoiceId: id, amount: 8_500_000, method: "MPESA", reference: "NEW-1" },
  });
  assert.equal(paid.status, 201);
  assert.match(paid.json.booking.booked || "", /^JE-\d{4}$/,
    `the first payment was not booked: ${paid.json.booking.why}`);

  const { by, balanced } = await books(cookie);
  assert.equal(balanced, true);
  assert.equal(Number(by["1000"].debit), 8_500_000, "the money did not reach the bank account");
  assert.equal(Number(by["1100"].balance), 0, "the receivable was raised and never cleared");
});

test("seeding at signup is idempotent — a second company is its own", { skip }, async () => {
  /* Two companies, two charts, and neither one sees the other's accounts. */
  const a = await newcomer();
  const b = await newcomer();
  await call("/organizations", { method: "POST", cookie: a.cookie,
    body: { name: "Alpha Property", work: ["property"] } });
  await call("/organizations", { method: "POST", cookie: b.cookie,
    body: { name: "Beta Property", work: ["property"] } });

  const ca = await call("/ledger/accounts", { cookie: a.cookie });
  const cb = await call("/ledger/accounts", { cookie: b.cookie });
  assert.equal(ca.json.count, cb.json.count);

  const idsA = new Set(ca.json.accounts.map((x: Wire) => x.id));
  const shared = cb.json.accounts.filter((x: Wire) => idsA.has(x.id));
  assert.deepEqual(shared, [], "two companies were handed the same account rows");
});
