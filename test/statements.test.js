/* ====================================================================== *
 * THE STATEMENTS, AND THE IDENTITIES THEY HAVE TO SATISFY.
 *
 * A balance sheet that does not balance, a cash movement whose opening plus
 * receipts is not its closing, or a tenant statement showing somebody else's
 * rent are all the same class of defect: a figure that looks like a fact.
 * None of them throws, none of them is obvious on screen, and all of them are
 * found by arithmetic rather than by reading.
 *
 * So most of what is below is arithmetic. The statements are built from the
 * journal, the journal is built by the posting bridge, and these check the
 * whole chain from a business event to a reported figure.
 *
 *     npx prisma generate
 *     TEST_DATABASE_URL=postgresql://…  npm test
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_statements";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping statement tests";
let dbHelp = null;
let createApp, db, pg;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
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
  return { cookie, session };
}

async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
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

/* ====================================================================== *
 * THE BALANCE SHEET
 * ====================================================================== */

test("the balance sheet balances, once the profit is counted", { skip }, async () => {
  /*
   * THE IDENTITY. A sheet of asset, liability and equity accounts alone does
   * NOT balance — the gap is the profit not yet moved into equity. Getting
   * this wrong produces a sheet that is out by exactly the period's earnings,
   * which looks like a rounding problem and is not.
   */
  const { cookie } = await company();
  await tenancy(cookie, { rent: 8_500_000 });
  await call("/expenses", { method: "POST", cookie,
    body: { detail: "Cleaning", category: "cleaning", amount: 400_000, currency: "KES" } });

  const { status, json } = await call("/ledger/balance-sheet", { cookie });
  assert.equal(status, 200);

  assert.equal(json.balanced, true,
    `assets ${json.totals.assets} vs funding ${json.funding} — out by ${json.difference}`);
  assert.equal(n(json.totals.assets), n(json.funding));
  assert.equal(
    n(json.totals.assets),
    n(json.totals.liabilities) + n(json.totals.equity) + n(json.totals.retained));

  /* Rent earned less cleaning spent. */
  assert.equal(n(json.totals.retained), 8_500_000 - 400_000);
});

test("a balance sheet carries no income or expense accounts", { skip }, async () => {
  const { cookie } = await company();
  await tenancy(cookie);
  await call("/expenses", { method: "POST", cookie,
    body: { detail: "Security", category: "security", amount: 100_000, currency: "KES" } });

  const { json } = await call("/ledger/balance-sheet", { cookie });
  const types = [...json.assets, ...json.liabilities, ...json.equity].map((r) => r.type);
  assert.deepEqual([...new Set(types)].sort().filter((t) => !["ASSET", "EQUITY", "LIABILITY"].includes(t)), [],
    "a profit-and-loss account reached the balance sheet, so 'what the company owns' now includes what it earned");
});

test("the sheet moves as at a date", { skip }, async () => {
  const { cookie } = await company();
  await tenancy(cookie, { rent: 2_000_000 });

  /* Everything above is dated March 2026. */
  const before = await call("/ledger/balance-sheet?asAt=2026-01-31", { cookie });
  assert.equal(n(before.json.totals.assets), 0, "a sheet dated before the business started showed assets");

  const after = await call("/ledger/balance-sheet?asAt=2026-12-31", { cookie });
  assert.equal(n(after.json.totals.assets), 2_000_000);
  assert.equal(after.json.balanced, true);
});

/* ====================================================================== *
 * THE INCOME STATEMENT
 * ====================================================================== */

test("income less expenses, and only those accounts", { skip }, async () => {
  const { cookie } = await company();
  await tenancy(cookie, { rent: 9_000_000 });
  await call("/expenses", { method: "POST", cookie,
    body: { detail: "Lift service", category: "maintenance", amount: 1_250_000, currency: "KES" } });
  await call("/expenses", { method: "POST", cookie,
    body: { detail: "Power", category: "utility", amount: 350_000, currency: "KES" } });

  const { json } = await call("/ledger/income-statement", { cookie });
  assert.equal(n(json.totals.income), 9_000_000);
  assert.equal(n(json.totals.expenses), 1_600_000);
  assert.equal(n(json.totals.net), 7_400_000);

  const types = [...json.income, ...json.expenses].map((r) => r.type);
  assert.deepEqual([...new Set(types)].sort(), ["EXPENSE", "INCOME"],
    "a balance sheet account reached the P&L, so 'profit' now includes the bank");
});

test("the P&L's net for all time is the balance sheet's retained", { skip }, async () => {
  /*
   * The cross-check that catches a whole class of mistake. Two statements,
   * two code paths, one number — if they disagree, one of them is wrong and
   * nothing on either screen would say which.
   */
  const { cookie } = await company();
  await tenancy(cookie, { rent: 6_400_000 });
  await call("/expenses", { method: "POST", cookie,
    body: { detail: "Insurance", category: "insurance", amount: 900_000, currency: "KES" } });

  const pl = await call("/ledger/income-statement", { cookie });
  const bs = await call("/ledger/balance-sheet", { cookie });
  assert.equal(n(pl.json.totals.net), n(bs.json.totals.retained));
});

test("a period narrows the P&L to what happened in it", { skip }, async () => {
  const { cookie } = await company();
  await tenancy(cookie, { rent: 5_000_000 });          /* dated March */
  await call("/expenses", { method: "POST", cookie,
    body: { detail: "June repair", category: "repairs", amount: 700_000, currency: "KES", spentOn: "2026-06-10" } });

  const march = await call("/ledger/income-statement?from=2026-03-01&to=2026-03-31", { cookie });
  assert.equal(n(march.json.totals.income), 5_000_000);
  assert.equal(n(march.json.totals.expenses), 0, "June's repair was counted in March");

  const june = await call("/ledger/income-statement?from=2026-06-01&to=2026-06-30", { cookie });
  assert.equal(n(june.json.totals.income), 0);
  assert.equal(n(june.json.totals.expenses), 700_000);
});

/* ====================================================================== *
 * CASH MOVEMENT
 * ====================================================================== */

test("opening plus receipts less payments is the closing balance", { skip }, async () => {
  const { cookie } = await company();
  await tenancy(cookie, { rent: 8_500_000 });

  const { status, json } = await call("/ledger/cash-movement", { cookie });
  assert.equal(status, 200);
  assert.equal(json.reconciles, true, "cash movement does not reconcile to its own closing balance");
  assert.equal(
    n(json.totals.opening) + n(json.totals.received) - n(json.totals.spent),
    n(json.totals.closing));
  assert.equal(n(json.totals.received), 8_500_000, "the rent did not show as received");
});

test("it says plainly that it is not an IAS 7 cash flow", { skip }, async () => {
  /*
   * An expense books to PAYABLE, not to bank, so none of it appears here —
   * correctly, because no cash has moved. A reader who thinks this is a full
   * cash flow statement would conclude the company spent nothing.
   */
  const { cookie } = await company();
  await tenancy(cookie, { rent: 1_000_000 });
  await call("/expenses", { method: "POST", cookie,
    body: { detail: "Cleaning", category: "cleaning", amount: 200_000, currency: "KES" } });

  const { json } = await call("/ledger/cash-movement", { cookie });
  assert.match(json.basis, /not an IAS 7/i,
    "the basis is not stated, so this reads as a filing it is not");
  assert.equal(n(json.totals.spent), 0,
    "an unpaid expense showed as cash going out");
});

test("an opening balance is what was there before the window", { skip }, async () => {
  const { cookie } = await company();
  await tenancy(cookie, { rent: 3_000_000 });   /* paid 5 March */

  const april = await call("/ledger/cash-movement?from=2026-04-01&to=2026-04-30", { cookie });
  assert.equal(n(april.json.totals.opening), 3_000_000, "March's rent was not carried in as opening");
  assert.equal(n(april.json.totals.received), 0, "April received nothing");
  assert.equal(n(april.json.totals.closing), 3_000_000);
  assert.equal(april.json.reconciles, true);
});

/* ====================================================================== *
 * OWNER, TENANT AND PROPERTY STATEMENTS
 * ====================================================================== */

test("a tenant's statement shows what they were charged and what they paid", { skip }, async () => {
  const { cookie } = await company();
  const t = await tenancy(cookie, { rent: 8_500_000 });

  const { status, json } = await call(`/ledger/statement?partyId=${t.partyId}`, { cookie });
  assert.equal(status, 200);
  assert.ok(json.rows.length >= 2, `only ${json.rows.length} lines — the dimensions were not stamped`);

  /* Charged the rent, paid the rent, so they are square. */
  assert.equal(n(json.totals.charged), 8_500_000);
  assert.equal(n(json.totals.paid), 8_500_000);
  assert.equal(n(json.totals.balance), 0);

  /* The running balance is the last row's, and it is the tenant's, not the
     account's. */
  assert.equal(n(json.rows[json.rows.length - 1].balance), 0);
});

test("an unpaid tenant owes what they were invoiced", { skip }, async () => {
  const { cookie } = await company();
  const t = await tenancy(cookie, { rent: 4_200_000, pay: false });

  const { json } = await call(`/ledger/statement?partyId=${t.partyId}`, { cookie });
  assert.equal(n(json.totals.balance), 4_200_000, "an unpaid tenant did not show as owing");
});

test("a property's statement is its own lines", { skip }, async () => {
  const { cookie } = await company();
  const a = await tenancy(cookie, { rent: 5_000_000 });
  /* A second property, whose rent must not appear on the first's statement. */
  const site2 = await call("/sites", { method: "POST", cookie, body: { name: "Westgate Plaza", city: "Nairobi" } });
  await call("/expenses", { method: "POST", cookie,
    body: { detail: "Repaint", category: "repairs", amount: 600_000, currency: "KES", siteId: site2.json.site.id } });

  const first = await call(`/ledger/statement?siteId=${a.siteId}`, { cookie });
  assert.ok(first.json.rows.length >= 2);
  const refs = first.json.rows.map((r) => r.memo).join(" ");
  assert.ok(!/Repaint/.test(refs), "another property's cost appeared on this one's statement");

  const second = await call(`/ledger/statement?siteId=${site2.json.site.id}`, { cookie });
  assert.equal(n(second.json.totals.charged), 600_000);
});

test("a statement names what it is for, or is refused", { skip }, async () => {
  const { cookie } = await company();
  const bare = await call("/ledger/statement", { cookie });
  assert.equal(bare.status, 400);
});

test("another company's tenant has no statement here", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const t = await tenancy(theirs.cookie, { rent: 1_000_000 });

  const res = await call(`/ledger/statement?partyId=${t.partyId}`, { cookie: mine.cookie });
  assert.equal(res.status, 404,
    "another company's tenant was answered with an empty statement, which reads as 'owes nothing'");
});

/* ====================================================================== *
 * AND THE WHOLE THING AGREES WITH ITSELF
 * ====================================================================== */

test("every statement agrees with the trial balance", { skip }, async () => {
  const { cookie } = await company();
  await tenancy(cookie, { rent: 8_500_000 });
  await tenancy(cookie, { rent: 3_000_000, pay: false });
  await call("/expenses", { method: "POST", cookie,
    body: { detail: "Grounds", category: "cleaning", amount: 500_000, currency: "KES" } });

  const tb = await call("/ledger/trial-balance", { cookie });
  const bs = await call("/ledger/balance-sheet", { cookie });
  const pl = await call("/ledger/income-statement", { cookie });
  const cash = await call("/ledger/cash-movement", { cookie });

  assert.equal(tb.json.balanced, true, "the books do not balance");
  assert.equal(bs.json.balanced, true, "the balance sheet does not balance");
  assert.equal(cash.json.reconciles, true, "cash does not reconcile");
  assert.equal(n(pl.json.totals.net), n(bs.json.totals.retained), "the P&L and the sheet disagree");

  /* Assets are the bank plus what is still owed; the unpaid rent is the
     receivable. */
  assert.equal(n(cash.json.totals.closing), 8_500_000, "cash");
  assert.equal(n(bs.json.totals.assets), 8_500_000 + 3_000_000, "bank plus the outstanding invoice");
  assert.equal(n(pl.json.totals.net), 11_500_000 - 500_000, "both rents earned, less the grounds");
});
