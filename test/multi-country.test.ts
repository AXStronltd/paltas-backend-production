/* ====================================================================== *
 * ONE PLATFORM, FOUR COUNTRIES.
 *
 * ── THE DEFECT THESE EXIST BECAUSE OF ──────────────────────────────────
 *
 * Thirty-one models carry `currency String @default("KES")`. A company's BOOKS
 * resolve their currency from the company's country, dynamically and correctly
 * — but nothing else did. So a Swedish company raised invoices in KES against
 * books in SEK, and domain/posting.ts refused to post them, exactly as it is
 * designed to:
 *
 *     "this is in KES and the books are in SEK — post it by hand with the
 *      rate used"
 *
 * The accounting chain stopped for every organization outside Kenya. Nothing
 * failed loudly; the ledger simply stayed empty.
 *
 * No test asserted that a Swedish company gets SEK, which is why it survived
 * a full suite and a production audit. That absence is the real defect, and
 * this file is it being closed.
 *
 * ── WHAT IS PINNED HERE ────────────────────────────────────────────────
 *
 *   · each country resolves its own currency, from the shared catalogue
 *   · a record created WITHOUT a stated currency gets the right one
 *   · a Kenyan property held by a Swedish company still bills in KES
 *   · an invoice in a non-Kenyan company reaches the ledger at all
 *   · history does not move when a company's country changes
 *   · a country the catalogue does not know gets nothing invented for it
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
const SCHEMA = "test_multi_country";

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
      name: `Global Co ${n}`, country,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `global${n}@example.com`, name: `Person ${n}`, orgId: org.id,
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


/* The four the brief names, and what the catalogue says each keeps its books in. */
const COUNTRIES: [string, string, string][] = [
  ["ke", "KES", "Kenya"],
  ["se", "SEK", "Sweden"],
  ["gb", "GBP", "United Kingdom"],
  ["us", "USD", "United States"],
];

/* ====================================================================== *
 * THE CURRENCY A NEW RECORD IS IN
 * ====================================================================== */

for (const [cc, want, name] of COUNTRIES) {
  test(`${name}: an invoice with no stated currency is in ${want}`, { skip }, async () => {
    const { cookie } = await company({ country: cc });
    const made = await call("/invoices", { method: "POST", cookie, body: {} });
    assert.equal(made.status, 201, made.text.slice(0, 200));
    assert.equal(made.json.invoice.currency, want,
      `a company in ${name} raised an invoice in ${made.json.invoice.currency}`);
  });

  test(`${name}: a property, unit and lease are all in ${want}`, { skip }, async () => {
    const { cookie } = await company({ country: cc });
    const site = await call("/sites", { method: "POST", cookie, body: { name: "Almas Tower" } });
    assert.equal(site.status, 201, site.text.slice(0, 200));
    assert.equal(site.json.site.currency, want, "the property");

    const unit = await call("/units", {
      method: "POST", cookie,
      body: { siteId: site.json.site.id, ref: "A-101", rent: 13500000 },
    });
    assert.equal(unit.status, 201, unit.text.slice(0, 200));
    assert.equal(unit.json.unit.currency, want, "the unit");
    assert.equal(String(unit.json.unit.rent), "13500000", "the rent is what was entered");

    const lease = await call("/leases", {
      method: "POST", cookie, body: { unitId: unit.json.unit.id, rent: 13500000 },
    });
    assert.equal(lease.status, 201, lease.text.slice(0, 200));
    assert.equal(lease.json.lease.currency, want, "the lease");
  });
}

/* ====================================================================== *
 * THE MULTINATIONAL CASE — why the chain anchors on the PROPERTY
 * ====================================================================== */

/*
 * A Kenyan tower held by a Swedish company bills in KES. Asking the company
 * gives SEK and would be wrong, which is the whole reason Site carries its own
 * currency and units resolve through it rather than through the organization.
 */
test("a Kenyan property in a Swedish company bills in KES, not SEK", { skip }, async () => {
  const { cookie } = await company({ country: "se" });

  const swedish = await call("/sites", { method: "POST", cookie, body: { name: "Stockholm Huset" } });
  assert.equal(swedish.json.site.currency, "SEK", "the company's own country applies by default");

  const kenyan = await call("/sites", {
    method: "POST", cookie, body: { name: "Almas Tower", country: "ke" },
  });
  assert.equal(kenyan.json.site.currency, "KES",
    "a property states where it stands, and that decides its money");

  const unit = await call("/units", {
    method: "POST", cookie, body: { siteId: kenyan.json.site.id, ref: "A-101", rent: 13500000 },
  });
  assert.equal(unit.json.unit.currency, "KES", "the unit follows the property, not the company");

  const lease = await call("/leases", {
    method: "POST", cookie, body: { unitId: unit.json.unit.id, rent: 13500000 },
  });
  assert.equal(lease.json.lease.currency, "KES", "and so does the lease");
});

test("a currency the caller states is never overridden", { skip }, async () => {
  const { cookie } = await company({ country: "se" });
  const site = await call("/sites", {
    method: "POST", cookie, body: { name: "Gulf Office", country: "ke", currency: "AED" },
  });
  assert.equal(site.json.site.currency, "AED", "what somebody said wins over what we would infer");
});

/* ====================================================================== *
 * THE PAYOFF — the ledger is reachable outside Kenya
 * ====================================================================== */

/*
 * This is the assertion the P0 was hiding behind. Issuing an invoice books it:
 * Dr receivable, Cr income. While the invoice was KES and the books SEK, the
 * bridge skipped every one of them with a stated reason, so a Swedish
 * company's ledger stayed empty no matter how much it billed.
 */
test("a Swedish company's invoice actually reaches its SEK books", { skip }, async () => {
  const { cookie } = await company({ country: "se" });
  await chartOf(cookie);

  const inv = await call("/invoices", { method: "POST", cookie, body: {} });
  assert.equal(inv.json.invoice.currency, "SEK");
  const id = inv.json.invoice.id;

  const line = await call(`/invoices/${id}/lines`, {
    method: "POST", cookie, body: { detail: "Rent, October", quantity: 1, unitPrice: 13500000 },
  });
  assert.equal(line.status, 201, line.text.slice(0, 200));

  /* DRAFT becoming anything else is the moment it is booked. */
  const issued = await call(`/invoices/${id}`, {
    method: "PATCH", cookie, body: { status: "SENT" },
  });
  assert.equal(issued.status, 200, issued.text.slice(0, 200));

  assert.ok(issued.json.booking, "issuing an invoice reports what it booked");
  assert.equal(issued.json.booking.why, null,
    `the entry was skipped: ${issued.json.booking.why}`);
  assert.ok(issued.json.booking.booked, "a journal reference came back");

  /* And it is really in the ledger, in SEK. */
  const entries = await call("/ledger/entries", { cookie });
  const mine = entries.json.entries.find((e: Wire) => e.ref === issued.json.booking.booked);
  assert.ok(mine, "the entry is listed");
  assert.equal(mine.currency, "SEK");
  assert.equal(mine.baseCurrency, "SEK");
});

/* ====================================================================== *
 * HISTORY, AND ISOLATION
 * ====================================================================== */

test("a company changing country does not rewrite what it already billed", { skip }, async () => {
  const { org, cookie } = await company({ country: "ke" });
  const inv = await call("/invoices", { method: "POST", cookie, body: {} });
  assert.equal(inv.json.invoice.currency, "KES");

  await db.organization.update({ where: { id: org.id }, data: { country: "se" } });

  const again = await call(`/invoices/${inv.json.invoice.id}`, { cookie });
  assert.equal(again.json.invoice.currency, "KES",
    "a historical record states the currency it was raised in, for ever");

  /* New ones follow the new country. Both facts matter. */
  const next = await call("/invoices", { method: "POST", cookie, body: {} });
  assert.equal(next.json.invoice.currency, "SEK", "and what comes next follows the company");
});

test("one company's country cannot reach another's records", { skip }, async () => {
  const a = await company({ country: "ke" });
  const b = await company({ country: "gb" });
  const aInv = await call("/invoices", { method: "POST", cookie: a.cookie, body: {} });
  const bInv = await call("/invoices", { method: "POST", cookie: b.cookie, body: {} });
  assert.equal(aInv.json.invoice.currency, "KES");
  assert.equal(bInv.json.invoice.currency, "GBP");

  await db.organization.update({ where: { id: a.org.id }, data: { country: "us" } });

  const bAgain = await call(`/invoices/${bInv.json.invoice.id}`, { cookie: b.cookie });
  assert.equal(bAgain.json.invoice.currency, "GBP", "untouched");
});

/* ====================================================================== *
 * WHAT WE DO NOT KNOW, WE DO NOT INVENT
 * ====================================================================== */

/*
 * The catalogue has fifty countries, not every country. For one it does not
 * know there is no currency to infer, and guessing is the failure this whole
 * change exists to stop. The column default stands and the caller decides.
 */
test("a country the catalogue does not know gets nothing invented", { skip }, async () => {
  const { cookie } = await company({ country: "zz" });
  const inv = await call("/invoices", { method: "POST", cookie, body: {} });
  assert.equal(inv.status, 201);
  assert.equal(inv.json.invoice.currency, "KES",
    "the column default stands — no currency was fabricated for an unknown country");

  /*
   * And the books say so plainly rather than picking one. A BALANCED entry
   * with real lines, so the refusal that comes back is about the currency and
   * not about the shape — "An entry needs its lines" is checked first and
   * would have made this test pass for the wrong reason.
   */
  const chart = await chartOf(cookie);
  const posted = await call("/ledger/entries", {
    method: "POST", cookie,
    body: {
      date: "2026-09-28", memo: "A balanced entry in an unknown currency",
      lines: [
        { accountId: chart["1100"], debit: 1000 },
        { accountId: chart["4000"], credit: 1000 },
      ],
    },
  });
  assert.ok(posted.status >= 400,
    `an unknown reporting currency must be refused, not guessed — got ${posted.status}`);
  assert.match(posted.text, /baseCurrency|market catalogue|country/i,
    "and the refusal says what to do about it");
});

/* ====================================================================== *
 * AN OFFERING'S CURRENCY — the last hard-coded KES
 * ====================================================================== */

/*
 * `routes/investments.ts` held `String(b["currency"] || "KES")`. A literal in a
 * route bypasses both the column default and the resolver, so every offering
 * raised outside Kenya was in shillings — and InvestmentOrder inherits it, so
 * `targetRaise`, `unitPrice`, `minInvestment` and every order amount were
 * mislabelled.
 */
/*
 * An offering may only be raised by an APPROVED ISSUER — a compliance gate, and
 * a correct one. The test records the approval the way PALTAS does rather than
 * routing around the check, so these tests still run through it.
 */
async function approveIssuer(orgId: string) {
  await db.issuerProfile.create({
    data: {
      orgId, status: "APPROVED", legalName: "An Approved Issuer",
      regulator: "Test regulator", licenceRef: "LIC-1",
      approvedAt: new Date(), approvedBy: "audit test",
    },
  });
}

async function offering(cookie: string, body: Record<string, unknown>) {
  const site = await call("/sites", {
    method: "POST", cookie, body: { name: "Held Property", ...(body["siteCountry"] ? { country: body["siteCountry"] } : {}) },
  });
  return call("/investments/offerings", {
    method: "POST", cookie,
    body: {
      siteId: site.json.site.id, title: "A Tower, in units",
      structure: "SPV_EQUITY", eligibility: "RETAIL_PERMITTED",
      targetRaise: 100000000, tokenUnits: 1000, unitPrice: 100000,
      minInvestment: 100000, jurisdictions: "",
      ...body,
    },
  });
}

test("a Swedish company's investment offering is in SEK, not KES", { skip }, async () => {
  const { org, cookie } = await company({ country: "se" });
  await approveIssuer(org.id);
  const made = await offering(cookie, {});
  assert.equal(made.status, 201, made.text.slice(0, 250));
  assert.equal(made.json.offering.currency, "SEK");
});

test("an offering on a Kenyan property is in KES even for a Swedish company", { skip }, async () => {
  const { org, cookie } = await company({ country: "se" });
  await approveIssuer(org.id);
  const made = await offering(cookie, { siteCountry: "ke" });
  assert.equal(made.status, 201, made.text.slice(0, 250));
  assert.equal(made.json.offering.currency, "KES",
    "the property it is raised against decides, not the company");
});

test("a stated offering currency still wins", { skip }, async () => {
  const { org, cookie } = await company({ country: "se" });
  await approveIssuer(org.id);
  const made = await offering(cookie, { currency: "usd" });
  assert.equal(made.json.offering.currency, "USD");
});

/* ====================================================================== *
 * A REPORT DOES NOT ADD TWO CURRENCIES TOGETHER
 * ====================================================================== */

/*
 * The trial balance summed each line as TRANSACTED. For one set of books in one
 * currency those are the same numbers, which is why it read as correct. For a
 * company that posts a cross-currency entry BY HAND — which is precisely what
 * domain/posting.ts instructs when it skips one — it added shillings to kronor
 * and called the result a total. It even stayed `balanced`, because each entry
 * balances in both currencies, so nothing flagged it.
 *
 * The converted amounts were already stored on every line.
 */
test("a cross-currency entry is reported in the books' own currency", { skip }, async () => {
  const { cookie } = await company({ country: "se" });
  const chart = await chartOf(cookie);

  /* Earned 1,000.00 SEK natively. */
  const native = await call("/ledger/entries", {
    method: "POST", cookie,
    body: {
      date: "2026-09-10", memo: "Swedish rent",
      lines: [
        { accountId: chart["1100"], debit: 100000 },
        { accountId: chart["4000"], credit: 100000 },
      ],
    },
  });
  assert.equal(native.status, 201, native.text.slice(0, 200));

  /*
   * And earned 10,000.00 KES, worth 820.00 SEK at the rate actually used. The
   * transaction figures and the converted figures are both stated, which is
   * what the ledger demands rather than inventing a rate.
   */
  const foreign = await call("/ledger/entries", {
    method: "POST", cookie,
    body: {
      date: "2026-09-11", memo: "Kenyan rent, converted",
      currency: "KES", baseCurrency: "SEK", fxRate: "0.082", fxSource: "bank advice",
      lines: [
        { accountId: chart["1100"], debit: 1000000, baseDebit: 82000 },
        { accountId: chart["4000"], credit: 1000000, baseCredit: 82000 },
      ],
    },
  });
  assert.equal(foreign.status, 201, foreign.text.slice(0, 250));

  const pl = await call("/ledger/income-statement?from=2026-09-01&to=2026-09-30", { cookie });
  assert.equal(pl.status, 200, pl.text.slice(0, 200));

  /*
   * 100000 + 82000 = 182000 minor units of SEK.
   * The bug produced 100000 + 1000000 = 1100000 — a number in no currency at
   * all, and six times too large.
   */
  assert.equal(String(pl.json.totals.income), "182000",
    `income was totalled as ${pl.json.totals.income} — the KES figures were added raw`);

  const tb = await call("/ledger/trial-balance", { cookie });
  assert.equal(String(tb.json.debit), "182000", "the trial balance totals in SEK");
  assert.equal(tb.json.balanced, true, "and it still balances");
});
