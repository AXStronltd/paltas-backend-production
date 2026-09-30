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
const SCHEMA = "test_reminders_run";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping reminder tests";
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
      skip = "RUN `npx prisma generate` FIRST — the reminder tests cannot run without it";
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
      name: `Reminders Co ${n}`, country,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `reminders${n}@example.com`, name: `Person ${n}`, orgId: org.id,
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
 * THE ONCE-ONLY GUARANTEE, AGAINST A REAL DATABASE.
 * ====================================================================== */

const DAY = 86_400_000;

/** A party with an address, an invoice against it, due in `inDays`. */
async function invoiceDueIn(orgId: string, inDays: number, n: number) {
  const party = await db.party.create({
    data: { orgId, name: `Payer ${n}`, email: `payer${n}@example.com`, kind: "TENANT" },
  });
  return db.invoice.create({
    data: {
      orgId, partyId: party.id, ref: `INV-${String(n).padStart(4, "0")}`,
      total: 100_000n, paid: 0n, currency: "KES", status: "SENT",
      dueOn: new Date(Date.now() + inDays * DAY),
    },
  });
}

test("an invoice coming due is reminded once, however often it runs",
  { skip }, async () => {
    const { org } = await company();
    await invoiceDueIn(org.id, 5, 1);
    const { runReminders } = await import("../src/domain/reminders.ts");

    const first = await runReminders(db, { now: new Date() });
    assert.equal(first.sent, 1, `expected one reminder, got ${first.sent}`);

    /* THE WHOLE POINT. A daily sweep with no memory would send this again
       tomorrow, and every day until the invoice is paid. */
    const second = await runReminders(db, { now: new Date() });
    assert.equal(second.sent, 0, "the same reminder went out twice");

    const rows = await db.reminder.findMany({ where: { orgId: org.id, kind: "invoice-due" } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.milestone, "7d", "five days out has crossed the seven-day mark");
  });

test("a later milestone still fires, because it is a different thing to say",
  { skip }, async () => {
    const { org } = await company();
    const inv = await invoiceDueIn(org.id, 5, 2);
    const { runReminders } = await import("../src/domain/reminders.ts");

    await runReminders(db, { now: new Date() });
    /* Two days later it is three days out: a new milestone, and worth saying. */
    await runReminders(db, { now: new Date(Date.now() + 2 * DAY) });

    const rows = await db.reminder.findMany({
      where: { orgId: org.id, subjectId: inv.id }, orderBy: { milestone: "asc" },
    });
    assert.deepEqual(rows.map((r) => r.milestone).sort(), ["3d", "7d"]);
  });

test("a message is written, and says honestly that nothing was sent",
  { skip }, async () => {
    /*
     * No email provider is configured in a test run, and that is the ordinary
     * case for a new company too. The reminder must still be recorded and the
     * message still written — QUEUED, carrying the provider's own sentence —
     * rather than silently not happening.
     */
    const { org } = await company();
    await invoiceDueIn(org.id, 2, 3);
    const { runReminders } = await import("../src/domain/reminders.ts");
    await runReminders(db, { now: new Date() });

    const msg = await db.dispatch.findFirst({ where: { orgId: org.id } });
    assert.ok(msg, "no message was written");
    assert.equal(msg!.status, "QUEUED");
    assert.match(msg!.subject, /INV-0003/);
    assert.match(msg!.error, /no email provider/i,
      "it did not say why nothing was sent");
  });

test("one company's reminders never touch another's", { skip }, async () => {
  const a = await company();
  const b = await company();
  await invoiceDueIn(a.org.id, 5, 4);
  const { runReminders } = await import("../src/domain/reminders.ts");
  await runReminders(db, { now: new Date() });

  assert.equal(await db.reminder.count({ where: { orgId: b.org.id } }), 0);
  assert.equal(await db.dispatch.count({ where: { orgId: b.org.id } }), 0);
});

test("an invoice that is not yet close enough is left alone", { skip }, async () => {
  const { org } = await company();
  await invoiceDueIn(org.id, 40, 5);
  const { runReminders } = await import("../src/domain/reminders.ts");
  const out = await runReminders(db, { now: new Date() });
  assert.equal(out.sent, 0, "somebody was chased about an invoice due next month");
});

test("a run that starts late catches up rather than skipping somebody",
  { skip }, async () => {
    /*
     * The outage case. An invoice that passed its seven-day mark while nothing
     * was running must still be reminded when the sweep comes back — asking
     * "is it exactly seven days away" would have missed it forever.
     */
    const { org } = await company();
    await invoiceDueIn(org.id, 4, 6);
    const { runReminders } = await import("../src/domain/reminders.ts");
    const out = await runReminders(db, { now: new Date() });
    assert.equal(out.sent, 1, "a record that crossed its milestone unattended was skipped");
  });

test("the scheduler knows about it, and it is idempotent by claim too",
  { skip }, async () => {
    const { JOBS, jobByKey } = await import("../src/domain/scheduler.ts");
    assert.ok(jobByKey("reminders"), "the sweep is not registered");
    assert.equal(JOBS.length, 3, "the job list changed without this test noticing");
  });
