/* ====================================================================== *
 * WHAT A COMPANY CAN ASK ABOUT ITSELF.
 *
 * Five endpoints over data that already existed and had no reader: the audit
 * trail, expiring documents, one customer's payment history, and the company's
 * own settings.
 *
 * The one that needs the most proving is the audit trail. It is filtered by
 * the areas a person may already read, so the thing to establish is that it
 * cannot become a way round the permissions it is built on — a role that
 * cannot open an invoice must not learn from the log that one was written.
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
const SCHEMA = "test_company";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping company tests";
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
    select: { orgId: true },
  });
  return { cookie, session, orgId: me.orgId };
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
 * THE AUDIT TRAIL
 * ====================================================================== */

test("a company can read its own history at last", { skip }, async () => {
  const { cookie } = await company();
  await tenancy(cookie, { rent: 4_000_000 });

  const { status, json } = await call("/audit", { cookie });
  assert.equal(status, 200, "a company still cannot read its own audit trail");
  assert.ok(json.total > 0, "nothing was recorded for a company that just invoiced and was paid");

  const actions = json.events.map((e: Wire) => e.action);
  assert.ok(actions.some((a: Wire) => a === "create"), "creating rows was not recorded");
  assert.ok(json.events.every((e: Wire) => e.who), "an entry with nobody against it");
  /* `detail` is a second copy of the row and is deliberately not sent. */
  assert.ok(json.events.every((e: Wire) => e.detail === undefined), "the log is leaking row contents");
});

test("the log shows only the areas a role may already read", { skip }, async () => {
  /*
   * THE PROPERTY THIS ENDPOINT LIVES OR DIES BY. ENGINEERING has maintenance
   * and property and no finance at all, so the invoices and payments this
   * company raised must not appear in its log — otherwise the trail is a way
   * to learn what somebody cannot open.
   */
  const owner = await company();
  await tenancy(owner.cookie, { rent: 5_000_000 });
  await call("/expenses", { method: "POST", cookie: owner.cookie,
    body: { detail: "Lift service", category: "maintenance", amount: 90_000, currency: "KES" } });

  const eng = await asRole(owner, "ENGINEERING");
  const { status, json } = await call("/audit", { cookie: eng });
  assert.equal(status, 200);

  const entities = new Set(json.events.map((e: Wire) => e.entity));
  assert.ok(!entities.has("invoice"), "an engineer was shown the invoices");
  assert.ok(!entities.has("payment"), "an engineer was shown the payments");
  assert.ok(!json.areas.includes("finance"), "finance was offered to a role with none");

  /* And the owner, who may read everything, does see them. */
  const all = await call("/audit", { cookie: owner.cookie });
  const ownerEntities = new Set(all.json.events.map((e: Wire) => e.entity));
  assert.ok(ownerEntities.has("invoice"), "an owner could not see the invoices");
});

test("asking for an area you cannot read is refused, not quietly empty", { skip }, async () => {
  const owner = await company();
  await tenancy(owner.cookie, { rent: 1_000_000 });
  const eng = await asRole(owner, "ENGINEERING");

  const res = await call("/audit?entity=invoice", { cookie: eng });
  assert.equal(res.status, 404,
    "an empty list would read as 'nothing happened' rather than 'not yours to see'");
});

test("one company's history is invisible to another", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  await tenancy(theirs.cookie, { rent: 7_000_000 });

  const { json } = await call("/audit", { cookie: mine.cookie });
  assert.equal(json.total, 0, "another company's actions reached this log");
});

/* ====================================================================== *
 * EXPIRING DOCUMENTS
 * ====================================================================== */

test("documents about to lapse are found, and the lapsed ones come first", { skip }, async () => {
  const { cookie } = await company();
  const day = 864e5;
  const mk = (name: Wire, days: Wire) => call("/documents", { method: "POST", cookie,
    body: { name, kind: "INSURANCE", expiresAt: new Date(Date.now() + days * day).toISOString() } });

  await mk("Lapsed cover", -30);
  await mk("Due next month", 30);
  await mk("Due next year", 400);
  await call("/documents", { method: "POST", cookie, body: { name: "No expiry", kind: "OTHER" } });

  const { status, json } = await call("/documents/expiring?withinDays=90", { cookie });
  assert.equal(status, 200);

  const names = json.documents.map((d: Wire) => d.name);
  assert.deepEqual(names, ["Lapsed cover", "Due next month"],
    "the window is wrong, or a document with no expiry was counted as expiring");
  assert.equal(json.expired, 1);
  assert.equal(json.documents[0].expired, true, "the lapsed one is not first");
  assert.ok(json.documents[0].daysLeft < 0, "an already-lapsed document read as having time left");
});

/* ====================================================================== *
 * PAYMENT HISTORY
 * ====================================================================== */

test("one customer's payments, with the voided ones shown but not counted", { skip }, async () => {
  const { cookie } = await company();
  const t = await tenancy(cookie, { rent: 6_000_000 });

  /* A second payment that is then voided — it happened, so it stays in the
     history; it is not money, so it stays out of the total. */
  const extra = await call("/payments", { method: "POST", cookie,
    body: { invoiceId: t.invoiceId, amount: 500_000, method: "CASH", reference: "H-1" } });
  await call(`/payments/${extra.json.payment.id}/void`, { method: "POST", cookie,
    body: { reason: "Counted twice at the desk" } });

  const { status, json } = await call(`/payments/history?partyId=${t.partyId}`, { cookie });
  assert.equal(status, 200);
  assert.equal(json.count, 2, "the voided payment vanished from the history");
  assert.equal(json.voided, 1);
  assert.equal(Number(json.received), 6_000_000, "a voided payment was counted as received");
  assert.ok(json.payments[0].invoice, "the payment does not say which bill it settled");
});

test("a statement is refused for somebody else's customer", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const t = await tenancy(theirs.cookie, { rent: 2_000_000 });

  const res = await call(`/payments/history?partyId=${t.partyId}`, { cookie: mine.cookie });
  assert.equal(res.status, 404);
});

/* ====================================================================== *
 * COMPANY SETTINGS
 * ====================================================================== */

test("a company can see what its country actually decides", { skip }, async () => {
  const { cookie } = await company();
  const { status, json } = await call("/organization/settings", { cookie });
  assert.equal(status, 200);
  assert.equal(json.organization.country, "ke");
  assert.equal(json.reportingCurrency, "KES");
  assert.equal(json.market.currency, "KES");
  assert.ok(json.market.languages.length, "the market says nothing about languages");
});

test("changing the country changes the currency the books are kept in", { skip }, async () => {
  /*
   * THE POINT OF THIS SCREEN. The country was set once at signup and then
   * unreachable, and it is not a label — it decides the reporting currency.
   * A company that registered under the wrong one had no way to say so.
   */
  const { cookie } = await company();
  const moved = await call("/organization/settings", {
    method: "PATCH", cookie, body: { country: "se", city: "Stockholm" },
  });
  assert.equal(moved.status, 200, moved.text.slice(0, 200));
  assert.equal(moved.json.reportingCurrency, "SEK");

  /* And the ledger agrees, because both read the same catalogue. */
  const codes = await chartOf(cookie);
  const posted = await call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["1000"], debit: 1000 }, { accountId: codes["4000"], credit: 1000 }] },
  });
  assert.equal(posted.json.entry.baseCurrency, "SEK",
    "the books did not follow the company to its new country");
});

test("a country the catalogue does not know is refused", { skip }, async () => {
  const { cookie } = await company();
  const res = await call("/organization/settings", {
    method: "PATCH", cookie, body: { country: "zz" },
  });
  assert.equal(res.status, 400,
    "an unknown country would leave every posting skipping for want of a currency");
  assert.match(res.json.message, /market PALTAS knows/i);
});

test("a company cannot mark itself active, or rename its own plan", { skip }, async () => {
  const { cookie } = await company();
  for (const body of [{ status: "ACTIVE" }, { kind: "PLATFORM" }]) {
    const res = await call("/organization/settings", { method: "PATCH", cookie, body });
    assert.equal(res.status, 400, `${Object.keys(body)[0]} was accepted from the customer`);
  }
});

test("changing the settings is itself recorded", { skip }, async () => {
  const { cookie } = await company();
  await call("/organization/settings", { method: "PATCH", cookie, body: { name: "Renamed Ltd" } });
  const { json } = await call("/audit?action=organization", { cookie });
  assert.ok(json.total >= 1, "a company renamed itself and nothing recorded it");
});
