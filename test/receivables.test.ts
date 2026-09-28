/* ====================================================================== *
 * WHAT IS OWED — ACCOUNTS RECEIVABLE, END TO END.
 *
 * ── THE DEFECT THESE EXIST BECAUSE OF ──────────────────────────────────
 *
 * The Collections screen was built on "a receivable is a transaction": it read
 * the merged cash list and filtered `flow === "in"`. Every row that survives
 * that filter is a PAYMENT — money that has already arrived — so Outstanding,
 * Overdue, the aging buckets and every tenant balance came out as ZERO for
 * real data. Not slightly wrong. Zero, always, for every company.
 *
 * A receivable is an INVOICE that has not been paid in full. Different table,
 * opposite state.
 *
 * ── THE TWO THINGS THAT ARE EASY TO GET WRONG ──────────────────────────
 *
 * AGING MUST COME FROM `dueOn`, NOT FROM `status`. recomputeInvoice does set
 * OVERDUE — but only when something recomputes the invoice. PALTAS has no
 * scheduler, so an invoice that quietly passes its due date is never touched
 * and still reads SENT. Trusting status under-reports arrears, which is the
 * one number a landlord checks first.
 *
 * CURRENCIES ARE NEVER ADDED. A company can hold property in two countries.
 * There is no exchange-rate source and none is invented here.
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
const SCHEMA = "test_receivables";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping ledger tests";
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
      skip = "RUN `npx prisma generate` FIRST — the ledger tests cannot run without it";
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
      name: `AR Co ${n}`, country,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `ar${n}@example.com`, name: `Person ${n}`, orgId: org.id,
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

/** The chart, seeded, as a code → id map. */
async function chartOf(cookie: string) {
  await call("/ledger/accounts/seed", { method: "POST", cookie });
  const { json } = await call("/ledger/accounts", { cookie });
  return Object.fromEntries(json.accounts.map((a: Wire) => [a.code, a.id]));
}

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (dbHelp) console.log("\n" + "─".repeat(72) + "\n" + dbHelp + "\n" + "─".repeat(72) + "\n");
});


/* ---------------------------------------------------------------- helpers */

/** An invoice with one line, issued, for `amount` minor units. */
async function invoiceFor(
  cookie: string,
  { amount, dueOn, currency, partyId, leaseId }:
  { amount: number; dueOn?: string; currency?: string; partyId?: string; leaseId?: string },
) {
  const made = await call("/invoices", {
    method: "POST", cookie,
    body: { ...(dueOn ? { dueOn } : {}), ...(currency ? { currency } : {}),
            ...(partyId ? { partyId } : {}), ...(leaseId ? { leaseId } : {}) },
  });
  if (made.status !== 201) throw new Error(`invoice: ${made.text.slice(0, 200)}`);
  const id = made.json.invoice.id;
  const line = await call(`/invoices/${id}/lines`, {
    method: "POST", cookie,
    body: { detail: "Rent", quantity: 1, unitPrice: amount },
  });
  if (line.status !== 201) throw new Error(`line: ${line.text.slice(0, 200)}`);
  /* DRAFT becoming SENT is the moment it is owed. */
  const sent = await call(`/invoices/${id}`, { method: "PATCH", cookie, body: { status: "SENT" } });
  if (sent.status !== 200) throw new Error(`issue: ${sent.text.slice(0, 200)}`);
  return id as string;
}

async function pay(cookie: string, invoiceId: string, amount: number, reference: string) {
  const res = await call("/payments", {
    method: "POST", cookie,
    body: { invoiceId, amount, method: "MPESA", reference },
  });
  if (res.status !== 201) throw new Error(`payment: ${res.text.slice(0, 200)}`);
  return res;
}

async function ar(cookie: string, query = "") {
  const res = await call(`/ledger/receivables${query}`, { cookie });
  if (res.status !== 200) throw new Error(`${res.status}: ${res.text.slice(0, 200)}`);
  return res.json;
}

/** Days ago, as a yyyy-mm-dd string. */
function daysAgo(n: number) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const only = (books: any[]) => { assert.equal(books.length, 1, "one currency"); return books[0]; };

/* ====================================================================== *
 * THE THING THAT WAS ZERO
 * ====================================================================== */

test("an unpaid invoice is owed, with its open balance", { skip }, async () => {
  const { cookie } = await company();
  await invoiceFor(cookie, { amount: 13500000, dueOn: daysAgo(-5) });

  const r = await ar(cookie);
  assert.equal(r.invoiceCount, 1);
  const book = only(r.books);
  assert.equal(book.currency, "KES");
  assert.equal(book.open, "13500000", "the whole invoice is outstanding");
  assert.equal(book.notYetDue, "13500000", "and it is not late yet");
  assert.equal(book.overdue, "0");
});

test("a paid invoice is not owed at all", { skip }, async () => {
  const { cookie } = await company();
  const id = await invoiceFor(cookie, { amount: 100000, dueOn: daysAgo(10) });
  await pay(cookie, id, 100000, "PAID-FULL-1");

  const r = await ar(cookie);
  assert.equal(r.invoiceCount, 0, "nothing is owed");
  assert.deepEqual(r.books, [], "and there is no book to report");
});

test("a part-paid invoice is owed for the remainder only", { skip }, async () => {
  const { cookie } = await company();
  const id = await invoiceFor(cookie, { amount: 100000, dueOn: daysAgo(10) });
  await pay(cookie, id, 40000, "PART-1");

  const r = await ar(cookie);
  assert.equal(r.invoiceCount, 1);
  assert.equal(r.invoices[0].total, "100000");
  assert.equal(r.invoices[0].paid, "40000");
  assert.equal(r.invoices[0].open, "60000", "the remainder, not the whole invoice");
  assert.equal(only(r.books).open, "60000");
});

/* A draft has not been asked for and a void has been withdrawn. Counting
   either would invent a debt. */
for (const state of ["DRAFT", "VOID"] as const) {
  test(`a ${state} invoice is not owed`, { skip }, async () => {
    const { org, cookie } = await company();
    const id = await invoiceFor(cookie, { amount: 500000, dueOn: daysAgo(30) });
    await db.invoice.update({ where: { id }, data: { status: state } });
    void org;
    assert.equal((await ar(cookie)).invoiceCount, 0);
  });
}

/* ====================================================================== *
 * AGING — FROM THE DUE DATE, NOT FROM THE STATUS COLUMN
 * ====================================================================== */

/*
 * The load-bearing test. This invoice's status still says SENT because nothing
 * recomputed it after its due date passed — which is the real state of every
 * overdue invoice in a system with no scheduler. Reading `status` would report
 * it as current and hide the arrears.
 */
test("an invoice whose status is still SENT is aged by its due date", { skip }, async () => {
  const { cookie } = await company();
  const id = await invoiceFor(cookie, { amount: 900000, dueOn: daysAgo(45) });
  /* Exactly what time passing looks like: nothing touched it. */
  await db.invoice.update({ where: { id }, data: { status: "SENT" } });

  const r = await ar(cookie);
  const row = r.invoices[0];
  assert.equal(row.status, "SENT", "the column is stale, as it is in production");
  assert.equal(row.daysLate, 45);
  assert.equal(row.bucket, "D31_60", "and it is aged anyway");

  const book = only(r.books);
  assert.equal(book.overdue, "900000", "counted as arrears");
  assert.equal(book.notYetDue, "0");
  const b = (k: string) => book.aging.find((x: any) => x.bucket === k);
  assert.equal(b("D31_60").amount, "900000");
  assert.equal(b("D31_60").count, 1);
  assert.equal(b("D1_30").amount, "0", "and not in a bucket it does not belong to");
});

/* A whole-day count, not elapsed hours. An invoice due yesterday is one day
   late this morning, not zero for most of the working day. */
test("due yesterday is one day late", { skip }, async () => {
  const { cookie } = await company();
  await invoiceFor(cookie, { amount: 1000, dueOn: daysAgo(1) });
  const r = await ar(cookie);
  assert.equal(r.invoices[0].daysLate, 1);
  assert.equal(r.invoices[0].bucket, "D1_30");
});

/*
 * THE CASE THAT SEPARATES CALENDAR DAYS FROM ELAPSED HOURS.
 *
 * Dates are fixed rather than relative to now, because the whole point is a
 * due date late in one day measured early in the next: one hour of real time,
 * one whole day of lateness. Counting elapsed milliseconds gives 0 and keeps
 * the invoice out of arrears for most of a working day; counting calendar days
 * gives 1, which is what a person means by "yesterday".
 *
 * Without this, daysAgo() writes midnight UTC and both arithmetics agree — so
 * the test above passes either way and proves nothing.
 */
test("lateness is whole calendar days, not elapsed hours", { skip }, async () => {
  const { cookie } = await company();
  const id = await invoiceFor(cookie, { amount: 5000 });
  await db.invoice.update({
    where: { id }, data: { dueOn: new Date("2026-09-20T23:30:00.000Z") },
  });

  const r = await ar(cookie, "?asAt=2026-09-21T00:30:00.000Z");
  assert.equal(r.invoices[0].daysLate, 1,
    "one hour later in real time, but one day late");
  assert.equal(r.invoices[0].bucket, "D1_30");
});

test("due today is due, not late", { skip }, async () => {
  const { cookie } = await company();
  await invoiceFor(cookie, { amount: 1000, dueOn: daysAgo(0) });
  const r = await ar(cookie);
  assert.equal(r.invoices[0].daysLate, 0);
  assert.equal(r.invoices[0].bucket, "DUE");
});

/* An invoice nobody dated cannot be late. It is owed, and it waits in CURRENT
   rather than being called arrears on the strength of a date nobody set. */
test("an invoice with no due date is owed but never overdue", { skip }, async () => {
  const { cookie } = await company();
  await invoiceFor(cookie, { amount: 700000 });
  const r = await ar(cookie);
  assert.equal(r.invoices[0].daysLate, null);
  assert.equal(r.invoices[0].bucket, "CURRENT");
  assert.equal(only(r.books).overdue, "0");
  assert.equal(only(r.books).open, "700000", "still owed");
});

test("every bucket is reported, including the empty ones", { skip }, async () => {
  const { cookie } = await company();
  await invoiceFor(cookie, { amount: 1000, dueOn: daysAgo(200) });
  const book = only((await ar(cookie)).books);
  assert.equal(book.aging.length, 6, "an aging profile must be readable across dates");
  assert.deepEqual(book.aging.map((a: any) => a.bucket),
    ["CURRENT", "DUE", "D1_30", "D31_60", "D61_90", "D90_PLUS"]);
  assert.equal(book.aging.find((a: any) => a.bucket === "D90_PLUS").amount, "1000");
});

/* Month-end is the same question asked of a different day, not a second
   report. Measured at a date before it was due, the same invoice is current. */
test("asAt moves the date arrears are measured against", { skip }, async () => {
  const { cookie } = await company();
  await invoiceFor(cookie, { amount: 250000, dueOn: daysAgo(40) });

  const now = await ar(cookie);
  assert.equal(now.invoices[0].bucket, "D31_60");

  const back = await ar(cookie, `?asAt=${daysAgo(50)}`);
  assert.equal(back.invoices[0].daysLate, -10, "not yet due, ten days out");
  assert.equal(back.invoices[0].bucket, "CURRENT");
  assert.equal(only(back.books).overdue, "0");
});

/* ====================================================================== *
 * CURRENCIES ARE NOT ADDED TOGETHER
 * ====================================================================== */

test("two currencies make two books and nothing is converted", { skip }, async () => {
  const { cookie } = await company({ country: "se" });
  await invoiceFor(cookie, { amount: 100000, dueOn: daysAgo(5) });
  await invoiceFor(cookie, { amount: 200000, dueOn: daysAgo(5), currency: "KES" });

  const r = await ar(cookie);
  assert.equal(r.mixed, true, "and it says so");
  assert.equal(r.books.length, 2);
  const kes = r.books.find((b: any) => b.currency === "KES");
  const sek = r.books.find((b: any) => b.currency === "SEK");
  assert.equal(sek.open, "100000");
  assert.equal(kes.open, "200000");
  assert.ok(!("total" in r), "there is no single total across currencies");
});

/* ====================================================================== *
 * WHO OWES WHAT
 * ====================================================================== */

test("party balances add up to the book, worst first", { skip }, async () => {
  const { cookie, org } = await company();
  const a = await db.party.create({ data: { orgId: org.id, name: "Grace Wanjiru", kind: "TENANT" } });
  const b = await db.party.create({ data: { orgId: org.id, name: "Peter Kamau", kind: "TENANT" } });

  await invoiceFor(cookie, { amount: 100000, dueOn: daysAgo(5), partyId: a.id });
  await invoiceFor(cookie, { amount: 300000, dueOn: daysAgo(95), partyId: a.id });
  await invoiceFor(cookie, { amount: 900000, dueOn: daysAgo(2), partyId: b.id });

  const book = only((await ar(cookie)).books);
  assert.equal(book.open, "1300000");
  const sum = book.parties.reduce((t: bigint, p: any) => t + BigInt(p.open), 0n);
  assert.equal(sum.toString(), book.open, "the parties must add up to the book");

  assert.equal(book.parties[0].name, "Grace Wanjiru",
    "95 days late outranks a larger amount that is 2 days late");
  assert.equal(book.parties[0].open, "400000", "both her invoices");
  assert.equal(book.parties[0].invoiceCount, 2);
  assert.equal(book.parties[0].oldestDaysLate, 95);
  assert.equal(book.parties[0].bucket, "D90_PLUS");
  assert.equal(book.parties[1].name, "Peter Kamau");
});

/* ====================================================================== *
 * AN OVERPAYMENT IS A CREDIT, NOT A NEGATIVE DEBT
 * ====================================================================== */

/*
 * The same rule buyer360 keeps. Netting somebody's credit against their own —
 * or worse, against the total — makes a statement that cannot be explained.
 */
test("an overpaid invoice does not reduce what others owe", { skip }, async () => {
  const { cookie } = await company();
  const over = await invoiceFor(cookie, { amount: 100000, dueOn: daysAgo(5) });
  await pay(cookie, over, 150000, "OVER-1");
  await invoiceFor(cookie, { amount: 80000, dueOn: daysAgo(5) });

  const r = await ar(cookie);
  assert.equal(r.invoiceCount, 1, "the overpaid invoice is simply not a receivable");
  assert.equal(only(r.books).open, "80000",
    "the 50,000 credit has not been netted against the other invoice");
});

/* ====================================================================== *
 * SCOPE
 * ====================================================================== */

test("nothing crosses a company", { skip }, async () => {
  const a = await company();
  const b = await company();
  await invoiceFor(a.cookie, { amount: 500000, dueOn: daysAgo(5) });

  assert.equal((await ar(a.cookie)).invoiceCount, 1);
  assert.equal((await ar(b.cookie)).invoiceCount, 0, "and not into the other company");
});

test("a party from another company is not found, rather than answering nothing", { skip }, async () => {
  const a = await company();
  const b = await company();
  const mine = await db.party.create({ data: { orgId: a.org.id, name: "Theirs", kind: "TENANT" } });

  const res = await call(`/ledger/receivables?partyId=${mine.id}`, { cookie: b.cookie });
  assert.equal(res.status, 404,
    "an empty report would read as 'they owe nothing', which is a different claim");
});

/* A property filter reaches an invoice through its lease, because an invoice
   names a lease and only the lease knows the unit. */
test("a property filter finds what is owed there, and only there", { skip }, async () => {
  const { cookie, org } = await company();
  const siteA = await db.site.create({ data: { orgId: org.id, name: "Almas Tower" } });
  const siteB = await db.site.create({ data: { orgId: org.id, name: "Other Court" } });
  const unitA = await db.unit.create({ data: { orgId: org.id, siteId: siteA.id, ref: "A-101" } });
  const leaseA = await db.lease.create({ data: { orgId: org.id, unitId: unitA.id, ref: "L-A-1" } });

  await invoiceFor(cookie, { amount: 400000, dueOn: daysAgo(5), leaseId: leaseA.id });
  /* And one against no lease at all, which must not appear under a property. */
  await invoiceFor(cookie, { amount: 900000, dueOn: daysAgo(5) });

  const atA = await ar(cookie, `?siteId=${siteA.id}`);
  assert.equal(atA.invoiceCount, 1, "only the invoice against that property's lease");
  assert.equal(only(atA.books).open, "400000");

  /* A property with no leases owes nothing — it must not fall back to
     reporting everything, which is how a filter becomes a lie. */
  const atB = await ar(cookie, `?siteId=${siteB.id}`);
  assert.equal(atB.invoiceCount, 0);
  assert.deepEqual(atB.books, []);
});
