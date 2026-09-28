/* ====================================================================== *
 * RENT THAT RAISES ITSELF — AND NEVER TWICE.
 *
 * Lease has carried a rent figure from the beginning and nothing said WHEN it
 * was owed, so nothing could raise it: every rent invoice was typed by hand,
 * for every unit, every month.
 *
 * This generates money, so the bar is the one that matters: a month charged
 * twice is not a bug somebody shrugs at. The scheduler's claim stops two RUNS;
 * the unique (orgId, leaseId, periodKey) on RentCharge — written in the same
 * transaction as the invoice — stops one interrupted run redoing the leases it
 * already reached. Only the second is about money, and it is what most of
 * these tests are about.
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
const SCHEMA = "test_rent";

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
      name: `Rent Co ${n}`, country,
      /* These tests are about what happens once a company has asked for
         automatic rent. The one test that is about NOT asking turns it off. */
      autoRent: true,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `rent${n}@example.com`, name: `Person ${n}`, orgId: org.id,
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


let R: typeof import("../src/domain/rent.ts");
if (!skip) R = await import("../src/domain/rent.ts");

const OCT = "2026-10";

/** A live lease with a rent, on a unit, for a named tenant. */
async function lease(orgId: string, over: Record<string, unknown> = {}) {
  const site = await db.site.create({ data: { orgId, name: "Almas Tower" } });
  const unit = await db.unit.create({
    data: { orgId, siteId: site.id, ref: String(over["unitRef"] || "A-101") } });
  const tenant = await db.party.create({
    data: { orgId, name: String(over["tenantName"] || "Grace Wanjiru"), kind: "TENANT" } });
  return db.lease.create({
    data: {
      orgId, unitId: unit.id, tenantId: tenant.id,
      ref: "L-" + Math.random().toString(36).slice(2, 8),
      unitRef: String(over["unitRef"] || "A-101"),
      rent: 13500000n, currency: "KES", rentDay: 1,
      startsOn: new Date("2026-01-01T00:00:00Z"),
      status: "ACTIVE",
      ...over,
    },
  });
}

const invoicesOf = (orgId: string) =>
  db.invoice.findMany({ where: { orgId }, include: { lines: true }, orderBy: { ref: "asc" } });

/* ====================================================================== *
 * IT RAISES RENT, ONCE
 * ====================================================================== */

test("a live lease is invoiced for the month", { skip }, async () => {
  const { org } = await company();
  const l = await lease(org.id);

  const out = await R.runRent(db, { periodKey: OCT, orgId: org.id });
  assert.equal(out.raised, 1, JSON.stringify(out));

  const [inv] = await invoicesOf(org.id);
  assert.ok(inv, "an invoice was raised");
  assert.equal(inv.status, "SENT", "raised, not drafted — a draft owes nothing");
  assert.equal(String(inv.total), "13500000", "the lease's rent");
  assert.equal(inv.currency, "KES");
  assert.equal(inv.leaseId, l.id);
  assert.equal(inv.partyId, l.tenantId);
  assert.equal(inv.source, "lease");
  assert.equal(inv.dueOn?.toISOString().slice(0, 10), "2026-10-01", "the lease's rent day");
  assert.equal(inv.lines.length, 1);
  assert.match(inv.lines[0]!.detail, /Rent — October 2026/);
  assert.match(inv.lines[0]!.detail, /A-101/, "which unit it is for");
});

/*
 * THE TEST THIS WHOLE DESIGN EXISTS FOR. A second attempt at a month already
 * charged must produce nothing — not a second invoice, not an error.
 */
test("running the same month twice raises rent once", { skip }, async () => {
  const { org } = await company();
  await lease(org.id);

  const first = await R.runRent(db, { periodKey: OCT, orgId: org.id });
  const second = await R.runRent(db, { periodKey: OCT, orgId: org.id });

  assert.equal(first.raised, 1);
  assert.equal(second.raised, 0, "the month was already charged");
  assert.equal(second.skipped, 1, "and it says so rather than failing");
  assert.equal((await invoicesOf(org.id)).length, 1, "exactly one invoice exists");
});

/* Four at once is what a stale-claim takeover racing the original looks like. */
test("four runs of one month racing still raise rent once", { skip }, async () => {
  const { org } = await company();
  await lease(org.id);

  const outs = await Promise.all([
    R.runRent(db, { periodKey: OCT, orgId: org.id }),
    R.runRent(db, { periodKey: OCT, orgId: org.id }),
    R.runRent(db, { periodKey: OCT, orgId: org.id }),
    R.runRent(db, { periodKey: OCT, orgId: org.id }),
  ]);

  assert.equal(outs.reduce((t, o) => t + o.raised, 0), 1, "one, across all four");
  assert.equal((await invoicesOf(org.id)).length, 1);
  assert.equal((await db.rentCharge.count({ where: { orgId: org.id } })), 1);
});

test("the next month is charged, and separately", { skip }, async () => {
  const { org } = await company();
  await lease(org.id);
  await R.runRent(db, { periodKey: OCT, orgId: org.id });
  const nov = await R.runRent(db, { periodKey: "2026-11", orgId: org.id });

  assert.equal(nov.raised, 1);
  const invs = await invoicesOf(org.id);
  assert.equal(invs.length, 2);
  assert.notEqual(invs[0]!.ref, invs[1]!.ref, "and they are numbered apart");
});

/* It must never bill history because somebody switched it on. */
test("a run raises its own month and no earlier one", { skip }, async () => {
  const { org } = await company();
  await lease(org.id);
  await R.runRent(db, { periodKey: OCT, orgId: org.id });

  const charges = await db.rentCharge.findMany({ where: { orgId: org.id } });
  assert.equal(charges.length, 1);
  assert.equal(charges[0]!.periodKey, OCT,
    "switching this on in October must not bill every month since January");
});

/* ====================================================================== *
 * NOBODY IS BILLED WITHOUT ASKING
 * ====================================================================== */

/*
 * THE SAFETY PROPERTY, and the reason `autoRent` defaults to false.
 *
 * Every company on PALTAS today raises rent by hand. If shipping this charged
 * all of them, the current month would be billed a SECOND time for every
 * tenant whose invoice was already typed — and PALTAS cannot see what was
 * billed outside it, so it must not assume nothing was.
 */
test("a company that has not asked for automatic rent is not charged", { skip }, async () => {
  const { org } = await company();
  await db.organization.update({ where: { id: org.id }, data: { autoRent: false } });
  await lease(org.id);

  const out = await R.runRent(db, { periodKey: OCT, orgId: org.id });
  assert.equal(out.raised, 0, "a live lease with rent was still not invoiced");
  assert.equal(await db.invoice.count({ where: { orgId: org.id } }), 0);
  assert.equal(await db.rentCharge.count({ where: { orgId: org.id } }), 0);
});

test("a run across every company touches only those that opted in", { skip }, async () => {
  const optedIn = await company();
  const notOptedIn = await company();
  await db.organization.update({
    where: { id: notOptedIn.org.id }, data: { autoRent: false } });
  await lease(optedIn.org.id);
  await lease(notOptedIn.org.id);

  /* No orgId: the whole platform, as the scheduler runs it. */
  await R.runRent(db, { periodKey: "2026-12" });

  assert.equal(await db.invoice.count({ where: { orgId: optedIn.org.id } }), 1);
  assert.equal(await db.invoice.count({ where: { orgId: notOptedIn.org.id } }), 0);
});

/* A safety flag nobody can switch on is a feature that can never be used. */
test("an owner can turn automatic rent on, and it takes effect", { skip }, async () => {
  const { org, cookie } = await company();
  await db.organization.update({ where: { id: org.id }, data: { autoRent: false } });
  await lease(org.id);

  assert.equal((await R.runRent(db, { periodKey: OCT, orgId: org.id })).raised, 0);

  const on = await call("/organization/settings", {
    method: "PATCH", cookie, body: { autoRent: true },
  });
  assert.equal(on.status, 200, on.text.slice(0, 200));

  assert.equal((await R.runRent(db, { periodKey: OCT, orgId: org.id })).raised, 1,
    "and the next run raises rent");
});

/* Turning it on must not bill anything by itself — the run does that, for the
   month it is in. */
test("turning it on raises nothing on its own", { skip }, async () => {
  const { org, cookie } = await company();
  await db.organization.update({ where: { id: org.id }, data: { autoRent: false } });
  await lease(org.id);

  await call("/organization/settings", { method: "PATCH", cookie, body: { autoRent: true } });
  assert.equal(await db.invoice.count({ where: { orgId: org.id } }), 0);
});

/* ====================================================================== *
 * WHICH LEASES OWE RENT
 * ====================================================================== */

/* A tenant serving notice still owes rent — which is why LIVE_LEASE_STATES is
   shared with occupancy rather than restated. */
for (const [status, charged] of [
  ["ACTIVE", true], ["NOTICE", true],
  ["DRAFT", false], ["ENDED", false], ["TERMINATED", false],
] as const) {
  test(`a ${status} lease is ${charged ? "charged" : "not charged"}`, { skip }, async () => {
    const { org } = await company();
    await lease(org.id, { status });
    const out = await R.runRent(db, { periodKey: OCT, orgId: org.id });
    assert.equal(out.raised, charged ? 1 : 0);
  });
}

test("a lease that has not started yet owes nothing", { skip }, async () => {
  const { org } = await company();
  await lease(org.id, { startsOn: new Date("2026-11-01T00:00:00Z") });
  assert.equal((await R.runRent(db, { periodKey: OCT, orgId: org.id })).raised, 0);
});

test("a lease that ended before the month owes nothing", { skip }, async () => {
  const { org } = await company();
  await lease(org.id, { endsOn: new Date("2026-09-30T00:00:00Z") });
  assert.equal((await R.runRent(db, { periodKey: OCT, orgId: org.id })).raised, 0);
});

/* Ending mid-month is still a month the tenant lived there. */
test("a lease ending mid-month is still charged for that month", { skip }, async () => {
  const { org } = await company();
  await lease(org.id, { endsOn: new Date("2026-10-20T00:00:00Z") });
  assert.equal((await R.runRent(db, { periodKey: OCT, orgId: org.id })).raised, 1);
});

test("a lease with no rent is not invoiced for nothing", { skip }, async () => {
  const { org } = await company();
  await lease(org.id, { rent: 0n });
  assert.equal((await R.runRent(db, { periodKey: OCT, orgId: org.id })).raised, 0);
  assert.equal((await invoicesOf(org.id)).length, 0);
});

/* ====================================================================== *
 * THE DAY IT FALLS DUE
 * ====================================================================== */

/*
 * A lease due on the 31st is due on the 30th in April and the 28th in
 * February. Skipping the month instead means a tenant is never billed in
 * February, which is the kind of thing nobody notices for a year.
 */
for (const [period, day, expected] of [
  ["2026-10", 31, "2026-10-31"],
  ["2026-04", 31, "2026-04-30"],
  ["2026-02", 31, "2026-02-28"],
  ["2024-02", 31, "2024-02-29"],
  ["2026-10", 15, "2026-10-15"],
] as const) {
  test(`rent day ${day} in ${period} falls due ${expected}`, { skip }, () => {
    assert.equal(R.dueDate(period, day).toISOString().slice(0, 10), expected);
  });
}

test("a short month still raises rent, on its last day", { skip }, async () => {
  const { org } = await company();
  await lease(org.id, { rentDay: 31 });
  await R.runRent(db, { periodKey: "2026-02", orgId: org.id });
  const [inv] = await invoicesOf(org.id);
  assert.equal(inv!.dueOn?.toISOString().slice(0, 10), "2026-02-28");
});

/* ====================================================================== *
 * HOW OFTEN
 * ====================================================================== */

/* Quarterly and yearly count from the month the lease started, not January. */
test("a quarterly lease is charged every third month from its start", { skip }, async () => {
  const { org } = await company();
  await lease(org.id, { billing: "QUARTERLY", startsOn: new Date("2026-02-01T00:00:00Z") });

  const charged: string[] = [];
  for (const p of ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-08"]) {
    if ((await R.runRent(db, { periodKey: p, orgId: org.id })).raised) charged.push(p);
  }
  assert.deepEqual(charged, ["2026-02", "2026-05", "2026-08"]);
});

test("a yearly lease is charged on its anniversary month only", { skip }, async () => {
  const { org } = await company();
  await lease(org.id, { billing: "YEARLY", startsOn: new Date("2026-03-01T00:00:00Z") });

  const charged: string[] = [];
  for (const p of ["2026-03", "2026-04", "2026-09", "2027-03"]) {
    if ((await R.runRent(db, { periodKey: p, orgId: org.id })).raised) charged.push(p);
  }
  assert.deepEqual(charged, ["2026-03", "2027-03"]);
});

/* Without a start date there is nothing to count quarters from, and guessing
   would charge somebody in a month they do not owe. */
test("a quarterly lease with no start date is left for a person", { skip }, async () => {
  const { org } = await company();
  await lease(org.id, { billing: "QUARTERLY", startsOn: null });
  assert.equal((await R.runRent(db, { periodKey: OCT, orgId: org.id })).raised, 0);
});

/* ====================================================================== *
 * MONEY, AND THE BOOKS
 * ====================================================================== */

test("the invoice is in the lease's currency, not the company's", { skip }, async () => {
  const { org } = await company({ country: "se" });
  await lease(org.id, { currency: "KES" });   /* a Kenyan property, Swedish company */
  await R.runRent(db, { periodKey: OCT, orgId: org.id });
  const [inv] = await invoicesOf(org.id);
  assert.equal(inv!.currency, "KES");
});

/* What was charged is written onto the charge as well as the invoice: a rent
   review changes the lease, and must not change what last month says. */
test("a rent review does not rewrite a month already charged", { skip }, async () => {
  const { org } = await company();
  const l = await lease(org.id);
  await R.runRent(db, { periodKey: OCT, orgId: org.id });

  await db.lease.update({ where: { id: l.id }, data: { rent: 20000000n } });
  await R.runRent(db, { periodKey: "2026-11", orgId: org.id });

  const charges = await db.rentCharge.findMany({
    where: { orgId: org.id }, orderBy: { periodKey: "asc" } });
  assert.equal(String(charges[0]!.amount), "13500000", "October keeps the old rent");
  assert.equal(String(charges[1]!.amount), "20000000", "November has the new one");
});

test("rent reaches the ledger when there is a chart to reach", { skip }, async () => {
  const { org, cookie } = await company();
  await chartOf(cookie);
  await lease(org.id);
  await R.runRent(db, { periodKey: OCT, orgId: org.id });

  const [inv] = await invoicesOf(org.id);
  const entry = await db.journalEntry.findFirst({
    /* Lowercase: domain/posting.ts writes "invoice", "payment", "expense". */
    where: { orgId: org.id, sourceType: "invoice", sourceId: inv!.id },
    include: { lines: true },
  });
  assert.ok(entry, "the rent was booked");
  const debits = entry!.lines.reduce((t, l) => t + l.debit, 0n);
  const credits = entry!.lines.reduce((t, l) => t + l.credit, 0n);
  assert.equal(String(debits), "13500000");
  assert.equal(debits, credits, "and it balances");
});

/*
 * A company with no chart of accounts still gets its rent raised. Refusing to
 * bill a tenant because the books are not set up yet would be the wrong way
 * round — and the run says why nothing was booked rather than staying quiet.
 */
test("no chart of accounts stops the booking, not the rent", { skip }, async () => {
  const { org } = await company();
  await lease(org.id);

  const out = await R.runRent(db, { periodKey: OCT, orgId: org.id });
  assert.equal(out.raised, 1, "the rent was still raised");
  assert.ok(out.notes.some((n) => /chart of accounts/i.test(n)),
    `the run does not say why it was not booked: ${JSON.stringify(out.notes)}`);
});

/* ====================================================================== *
 * SCOPE, AND NUMBERING
 * ====================================================================== */

test("a run for one company does not touch another's leases", { skip }, async () => {
  const a = await company();
  const b = await company();
  await lease(a.org.id);
  await lease(b.org.id);

  await R.runRent(db, { periodKey: OCT, orgId: a.org.id });
  assert.equal((await invoicesOf(a.org.id)).length, 1);
  assert.equal((await invoicesOf(b.org.id)).length, 0);
});

/*
 * Two leases in one run must not be handed the same reference —
 * @@unique([orgId, ref]) would refuse the second and lose it a month's rent.
 * And the numbering is the platform's own, not a second scheme invented here.
 */
test("many leases in one run are numbered apart, in the platform's own sequence", { skip }, async () => {
  const { org, cookie } = await company();
  for (let i = 0; i < 5; i++) await lease(org.id, { unitRef: `A-10${i}` });

  const out = await R.runRent(db, { periodKey: OCT, orgId: org.id });
  assert.equal(out.raised, 5);

  const invs = await invoicesOf(org.id);
  assert.equal(new Set(invs.map((i) => i.ref)).size, 5, "five distinct references");
  for (const i of invs) assert.match(i.ref, /^INV-\d{4}$/, `${i.ref} is not the house format`);

  /* And an invoice raised by hand afterwards continues the same sequence
     rather than starting a second one. */
  const byHand = await call("/invoices", { method: "POST", cookie, body: {} });
  assert.equal(byHand.status, 201);
  assert.match(byHand.json.invoice.ref, /^INV-\d{4}$/);
  assert.ok(!invs.some((i) => i.ref === byHand.json.invoice.ref), "and it is a new number");
});

/* ====================================================================== *
 * THE CONFIGURATION A LANDLORD ACTUALLY SETS
 * ====================================================================== */

test("rent day and billing frequency are settable, and persist", { skip }, async () => {
  const { org, cookie } = await company();
  const l = await lease(org.id);

  const saved = await call(`/leases/${l.id}`, {
    method: "PATCH", cookie, body: { rentDay: 15, billing: "QUARTERLY" },
  });
  assert.equal(saved.status, 200, saved.text.slice(0, 200));

  /* Read back through the API, not the object we just sent. */
  const read = await call(`/leases/${l.id}`, { cookie });
  assert.equal(read.json.lease.rentDay, 15);
  assert.equal(read.json.lease.billing, "QUARTERLY");

  /* And it is what the billing then uses. */
  await db.lease.update({ where: { id: l.id }, data: { startsOn: new Date("2026-10-01T00:00:00Z") } });
  await R.runRent(db, { periodKey: OCT, orgId: org.id });
  const [inv] = await invoicesOf(org.id);
  assert.equal(inv!.dueOn?.toISOString().slice(0, 10), "2026-10-15");
});

/*
 * A rent day of 0 or 99 is not a number to be clamped quietly at billing time.
 * It is a lease stating something impossible, and only the person typing it
 * knows what they meant.
 */
for (const bad of [0, 32, -1, 99]) {
  test(`a rent day of ${bad} is refused`, { skip }, async () => {
    const { org, cookie } = await company();
    const l = await lease(org.id);
    const res = await call(`/leases/${l.id}`, {
      method: "PATCH", cookie, body: { rentDay: bad },
    });
    assert.ok(res.status >= 400, `${bad} was accepted`);
    assert.match(res.text, /between 1 and 31/i);
  });
}

test("a billing frequency PALTAS does not have is refused", { skip }, async () => {
  const { org, cookie } = await company();
  const l = await lease(org.id);
  const res = await call(`/leases/${l.id}`, {
    method: "PATCH", cookie, body: { billing: "FORTNIGHTLY" },
  });
  assert.ok(res.status >= 400);
  assert.match(res.text, /MONTHLY|QUARTERLY|YEARLY/);
});

/* ====================================================================== *
 * WHAT THE CONSOLE IS TOLD
 * ====================================================================== */

test("automation status reports what would happen, from the same rule as the run", { skip }, async () => {
  const { org, cookie } = await company();
  await db.organization.update({ where: { id: org.id }, data: { autoRent: false } });
  await lease(org.id);
  await lease(org.id, { rent: 0n, unitRef: "A-200" });                       /* no rent */
  await lease(org.id, { billing: "QUARTERLY", startsOn: null, unitRef: "A-300" });

  const res = await call("/rent/automation", { cookie });
  assert.equal(res.status, 200, res.text.slice(0, 200));

  assert.equal(res.json.autoRent, false, "off until asked for");
  assert.equal(res.json.leases.live, 3);
  assert.equal(res.json.leases.billableThisPeriod, 1, "only the one that can be billed");

  const why = res.json.passedOver.map((p: Wire) => p.why).join(" | ");
  assert.equal(res.json.passedOver.length, 2);
  assert.match(why, /no rent is recorded/);
  assert.match(why, /start date/, "the backend's own quarterly rule, explained");
});

test("automation status reports what has been raised, per period", { skip }, async () => {
  const { org, cookie } = await company();
  await lease(org.id);
  await R.runRent(db, { periodKey: OCT, orgId: org.id });
  await R.runRent(db, { periodKey: "2026-11", orgId: org.id });

  const res = await call("/rent/automation", { cookie });
  const periods = res.json.history.map((h: Wire) => h.periodKey);
  assert.deepEqual(periods.sort(), ["2026-10", "2026-11"]);
  assert.equal(res.json.history[0].invoices, 1);
  assert.equal(res.json.history[0].currency, "KES", "in the lease's own currency");
});

/* It must not invent per-company numbers a JobRun cannot give. */
test("automation status does not claim skipped or error counts", { skip }, async () => {
  const { org, cookie } = await company();
  await lease(org.id);
  const res = await call("/rent/automation", { cookie });
  assert.ok(!("skipped" in res.json), "a JobRun counts every company at once");
  assert.ok(!("errors" in res.json));
  assert.ok(!("nextRunAt" in res.json), "when the scheduler next beats is not a promise");
});

test("one company cannot see or change another's rent automation", { skip }, async () => {
  const a = await company();
  const b = await company();
  await lease(a.org.id);

  const mine = await call("/rent/automation", { cookie: b.cookie });
  assert.equal(mine.json.leases.live, 0, "it sees its own, which is none");

  const l = await db.lease.findFirst({ where: { orgId: a.org.id } });
  const reach = await call(`/leases/${l!.id}`, {
    method: "PATCH", cookie: b.cookie, body: { rentDay: 9 },
  });
  assert.ok(reach.status === 404 || reach.status === 403, `got ${reach.status}`);
  const after = await db.lease.findUnique({ where: { id: l!.id } });
  assert.equal(after!.rentDay, 1, "and it did not change");
});

/*
 * WHO MAY SWITCH AUTOMATIC BILLING ON.
 *
 * Letting PALTAS create invoices for real tenants is an owner's decision, not
 * an operational one — so the settings endpoint requires people:delete, which
 * OWNER, MANAGER and GM hold and nobody else does. FINANCE is the interesting
 * refusal: it may raise an invoice by hand all day, and still may not hand the
 * job to a machine.
 */
for (const [role, allowed] of [
  ["OWNER", true], ["MANAGER", true],
  ["FINANCE", false], ["LEASING", false], ["OPERATIONS", false],
] as const) {
  test(`${role} ${allowed ? "may" : "may not"} switch automatic rent on`, { skip }, async () => {
    const { org, cookie } = await company({ role });
    await db.organization.update({ where: { id: org.id }, data: { autoRent: false } });

    const res = await call("/organization/settings", {
      method: "PATCH", cookie, body: { autoRent: true },
    });

    if (allowed) {
      assert.equal(res.status, 200, res.text.slice(0, 160));
    } else {
      assert.ok(res.status === 403 || res.status === 404, `${role} got ${res.status}`);
    }
    const after = await db.organization.findUnique({ where: { id: org.id } });
    assert.equal(after!.autoRent, allowed,
      allowed ? "it was switched on" : "and it was not switched on behind the refusal");
  });
}

/* Editing what a lease bills is a property decision, and separate from the
   one above — a role may be able to do one and not the other. */
for (const [role, allowed] of [["OWNER", true], ["HOUSEKEEPING", false]] as const) {
  test(`${role} ${allowed ? "may" : "may not"} change a lease's billing`, { skip }, async () => {
    const { org, cookie } = await company({ role });
    const l = await lease(org.id);
    const res = await call(`/leases/${l.id}`, {
      method: "PATCH", cookie, body: { rentDay: 9 },
    });
    if (allowed) assert.equal(res.status, 200, res.text.slice(0, 160));
    else assert.ok(res.status === 403 || res.status === 404, `${role} got ${res.status}`);

    const after = await db.lease.findUnique({ where: { id: l.id } });
    assert.equal(after!.rentDay, allowed ? 9 : 1);
  });
}
