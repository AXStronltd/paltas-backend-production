/* ====================================================================== *
 * THE COMMAND CENTRE SHOWS WHAT A COMPANY ACTUALLY HAS.
 *
 * ── THE DEFECT THESE EXIST BECAUSE OF ──────────────────────────────────
 *
 * The console counted everything THROUGH SITES: units were the sum of each
 * property's unit count, and the whole content area was gated on whether any
 * property existed.
 *
 * `Unit.siteId` is optional and `Lease.unitId` is optional. So a company can
 * hold units and tenancies with no Site row at all — and one did. Everything
 * it owned was invisible, and the screen offered to help it add its first
 * property, which it had been using for weeks.
 *
 * The first test here is that exact company.
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
const SCHEMA = "test_command_centre";

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
      name: `Almas Co ${n}`, country,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `cc${n}@example.com`, name: `Person ${n}`, orgId: org.id,
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


let CC: typeof import("../src/domain/command-centre.ts");
if (!skip) CC = await import("../src/domain/command-centre.ts");

const centre = (orgId: string, money = true) =>
  CC.commandCentre(db, { orgId, money });

/* ====================================================================== *
 * THE COMPANY WHOSE COMMAND CENTRE WAS BLANK
 * ====================================================================== */

test("units and leases count even when the company has no property record", { skip }, async () => {
  const { org } = await company();

  /* Exactly the shape that was invisible: units with no site, leases with no
     unit. Both columns are optional, so this is a state PALTAS allows. */
  await db.unit.create({ data: { orgId: org.id, ref: "A-101", status: "OCCUPIED" } });
  await db.unit.create({ data: { orgId: org.id, ref: "A-102", status: "VACANT" } });
  for (let i = 0; i < 4; i++) {
    await db.lease.create({
      data: { orgId: org.id, ref: `L-000${i}`, rent: 13500000n, status: "ACTIVE" } });
  }

  const cc = await centre(org.id);
  assert.equal(cc.portfolio.sites, 0, "it genuinely has no property record");
  assert.equal(cc.portfolio.units, 2, "and its units are counted anyway");
  assert.equal(cc.leases.live, 4, "and its tenancies");
  assert.equal(cc.portfolio.occupied, 1);
  assert.equal(cc.portfolio.vacant, 1);
  assert.equal(cc.portfolio.occupancyPct, 50);
});

/*
 * "0% occupied" and "no units yet" are different statements and only one of
 * them is a problem. A percentage of nothing is not zero.
 */
test("a company with no units reports no occupancy, not nought per cent", { skip }, async () => {
  const { org } = await company();
  const cc = await centre(org.id);
  assert.equal(cc.portfolio.units, 0);
  assert.equal(cc.portfolio.occupancyPct, null);
});

test("occupancy is read from the unit's own status", { skip }, async () => {
  const { org } = await company();
  const site = await db.site.create({ data: { orgId: org.id, name: "Almas Tower" } });
  for (const [ref, status] of [["A", "OCCUPIED"], ["B", "OCCUPIED"], ["C", "VACANT"],
                               ["D", "RESERVED"], ["E", "OFF_MARKET"]] as const) {
    await db.unit.create({ data: { orgId: org.id, siteId: site.id, ref, status } });
  }
  const cc = await centre(org.id);
  assert.equal(cc.portfolio.units, 5);
  assert.equal(cc.portfolio.occupied, 2);
  assert.equal(cc.portfolio.vacant, 1);
  assert.equal(cc.portfolio.reserved, 1);
  assert.equal(cc.portfolio.offMarket, 1);
  assert.equal(cc.portfolio.occupancyPct, 40);
  assert.equal(cc.portfolio.sites, 1);
});

/* A tenant serving notice still holds the unit and still owes rent. */
test("a lease on notice is still live", { skip }, async () => {
  const { org } = await company();
  await db.lease.create({ data: { orgId: org.id, ref: "L-1", status: "ACTIVE", rent: 1n } });
  await db.lease.create({ data: { orgId: org.id, ref: "L-2", status: "NOTICE", rent: 1n } });
  await db.lease.create({ data: { orgId: org.id, ref: "L-3", status: "ENDED", rent: 1n } });
  const cc = await centre(org.id);
  assert.equal(cc.leases.live, 2);
});

/* ====================================================================== *
 * MONEY IS NOT FOR EVERYBODY
 * ====================================================================== */

/*
 * Omitted, not zeroed. A finance section full of noughts tells somebody they
 * have no money, which is a different statement from "this is not yours to
 * see" — and the wrong one.
 */
test("a role that may not see money gets no finance section at all", { skip }, async () => {
  const { org } = await company();
  const cc = await centre(org.id, false);
  assert.equal(cc.finance, null);
});

test("a role that may see money gets what is owed, from the receivables service", { skip }, async () => {
  const { org, cookie } = await company();
  const inv = await call("/invoices", { method: "POST", cookie, body: { dueOn: "2026-08-01" } });
  const id = inv.json.invoice.id;
  await call(`/invoices/${id}/lines`, { method: "POST", cookie,
    body: { detail: "Rent", quantity: 1, unitPrice: 13500000 } });
  await call(`/invoices/${id}`, { method: "PATCH", cookie, body: { status: "SENT" } });

  const cc = await centre(org.id);
  assert.ok(cc.finance, "the section is there");
  assert.equal(cc.finance!.openInvoices, 1);
  const kes = cc.finance!.books.find((b) => b.currency === "KES");
  assert.ok(kes, "a book in the invoice's own currency");
  assert.equal(kes!.outstanding, "13500000");

  /* And it agrees with Collections, because it IS Collections' service. */
  const ar = await call("/ledger/receivables", { cookie });
  assert.equal(ar.json.books[0].open, kes!.outstanding);
});

test("collected and spent this month are counted, per currency", { skip }, async () => {
  const { org, cookie } = await company();
  const inv = await call("/invoices", { method: "POST", cookie, body: {} });
  const id = inv.json.invoice.id;
  await call(`/invoices/${id}/lines`, { method: "POST", cookie,
    body: { detail: "Rent", quantity: 1, unitPrice: 5000000 } });
  await call(`/invoices/${id}`, { method: "PATCH", cookie, body: { status: "SENT" } });
  await call("/payments", { method: "POST", cookie,
    body: { invoiceId: id, amount: 2000000, method: "MPESA", reference: "CC-1" } });
  await call("/expenses", { method: "POST", cookie,
    body: { detail: "Plumber", amount: 750000, spentOn: new Date().toISOString() } });

  const cc = await centre(org.id);
  assert.equal(cc.finance!.collectedThisMonth[0]!.amount, "2000000");
  assert.equal(cc.finance!.collectedThisMonth[0]!.currency, "KES");
  assert.equal(cc.finance!.expensesThisMonth[0]!.amount, "750000");
});

/* ====================================================================== *
 * WHAT NEEDS ATTENTION
 * ====================================================================== */

test("an overdue invoice becomes something to do, not a number", { skip }, async () => {
  const { org, cookie } = await company();
  const inv = await call("/invoices", { method: "POST", cookie,
    body: { dueOn: new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10) } });
  const id = inv.json.invoice.id;
  await call(`/invoices/${id}/lines`, { method: "POST", cookie,
    body: { detail: "Rent", quantity: 1, unitPrice: 13500000 } });
  await call(`/invoices/${id}`, { method: "PATCH", cookie, body: { status: "SENT" } });

  const cc = await centre(org.id);
  const item = cc.attention.find((a) => a.kind === "rent-overdue");
  assert.ok(item, `nothing was raised: ${JSON.stringify(cc.attention)}`);
  assert.equal(item!.entity, "invoice");
  assert.equal(item!.entityId, id, "and it names the record, so a click can open it");
  assert.equal(item!.priority, "high", "45 days late");
  assert.equal(item!.screen, "fin_collect", "and where to go");
});

test("a lease running out is raised before it does", { skip }, async () => {
  const { org } = await company();
  const soon = new Date(Date.now() + 20 * 86400000);
  await db.lease.create({
    data: { orgId: org.id, ref: "L-9", status: "ACTIVE", rent: 1n,
            tenantName: "Grace Wanjiru", endsOn: soon } });

  const cc = await centre(org.id);
  const item = cc.attention.find((a) => a.kind === "lease-expiring");
  assert.ok(item);
  assert.match(item!.what, /Grace Wanjiru/);
  assert.equal(item!.priority, "high", "inside thirty days");
  assert.equal(cc.leases.expiringSoon.length, 1);
});

test("a lease that ended long ago is not raised", { skip }, async () => {
  const { org } = await company();
  await db.lease.create({
    data: { orgId: org.id, ref: "L-8", status: "ENDED", rent: 1n,
            endsOn: new Date(Date.now() - 400 * 86400000) } });
  const cc = await centre(org.id);
  assert.equal(cc.attention.filter((a) => a.kind === "lease-expiring").length, 0);
});

/* ====================================================================== *
 * ACTIVITY COMES FROM THE AUDIT TRAIL THAT ALREADY EXISTS
 * ====================================================================== */

test("recent activity is the audit trail, not a second log", { skip }, async () => {
  const { org, cookie } = await company();
  await call("/invoices", { method: "POST", cookie, body: {} });

  const cc = await centre(org.id);
  assert.ok(cc.activity.length > 0, "something was recorded");
  const made = cc.activity.find((a) => a.entity === "invoice");
  assert.ok(made, `no invoice activity: ${JSON.stringify(cc.activity.slice(0, 3))}`);
  assert.ok(made!.entityId, "it names the record, so a click can open it");
  assert.ok(made!.at instanceof Date);
  assert.equal(typeof made!.actorName, "string");

  /* The same rows the audit screen reads. */
  const trail = await db.auditEvent.count({ where: { orgId: org.id } });
  assert.ok(trail >= cc.activity.length);
});

/* ====================================================================== *
 * SCOPE
 * ====================================================================== */

test("nothing crosses a company", { skip }, async () => {
  const a = await company();
  const b = await company();
  await db.unit.create({ data: { orgId: a.org.id, ref: "A-1", status: "OCCUPIED" } });
  await db.lease.create({ data: { orgId: a.org.id, ref: "L-1", status: "ACTIVE", rent: 1n } });

  const mine = await centre(b.org.id);
  assert.equal(mine.portfolio.units, 0);
  assert.equal(mine.leases.live, 0);
  assert.equal(mine.activity.filter((x) => x.entity === "unit").length, 0);
});

/* An empty company is a real state, and must read as one rather than a fault. */
test("a brand new company reports honest emptiness", { skip }, async () => {
  const { org } = await company();
  const cc = await centre(org.id);
  assert.equal(cc.portfolio.units, 0);
  assert.equal(cc.portfolio.sites, 0);
  assert.equal(cc.leases.live, 0);
  assert.equal(cc.operations.openCases, 0);
  assert.deepEqual(cc.attention, []);
  assert.equal(cc.finance!.openInvoices, 0);
  assert.deepEqual(cc.finance!.books, [], "no book, rather than a zero in a currency");
});
