/* ====================================================================== *
 * THE SCHEDULER RUNS WORK EXACTLY ONCE.
 *
 * That is the only thing a scheduler is really for, and the only thing that is
 * hard. Running work is easy; running a month's rent exactly once across a
 * restart, a deploy and two web instances is not, and getting it wrong means
 * charging somebody twice.
 *
 * The guarantee is a UNIQUE (job, periodKey) in Postgres, claimed BEFORE any
 * work happens. These tests hold it to that — including the two failures an
 * in-memory lock cannot survive: two processes racing, and a claim left behind
 * by a process that died mid-run.
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
const SCHEMA = "test_scheduler";

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
      name: `Job Co ${n}`, country,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `job${n}@example.com`, name: `Person ${n}`, orgId: org.id,
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


/* ---------------------------------------------------------------- rig */

let S: typeof import("../src/domain/scheduler.ts");
if (!skip) S = await import("../src/domain/scheduler.ts");

/** A job that counts how many times it actually ran. */
function counter(over: Partial<import("../src/domain/scheduler.ts").Job> = {}) {
  const calls: string[] = [];
  const job = {
    key: "test-job-" + Math.random().toString(36).slice(2, 8),
    title: "A test job", why: "To prove it runs once.",
    period: (now: Date) => now.toISOString().slice(0, 10),
    run: async (ctx: import("../src/domain/scheduler.ts").JobContext) => {
      calls.push(ctx.periodKey);
      return { scanned: 1, changed: 1 };
    },
    ...over,
  } as import("../src/domain/scheduler.ts").Job;
  return { job, calls };
}

const DAY = new Date("2026-09-28T09:00:00.000Z");

/* ====================================================================== *
 * ONCE PER PERIOD
 * ====================================================================== */

test("a job runs once for its period, and not again", { skip }, async () => {
  const { job, calls } = counter();

  const first = await S.runJob(db, job, DAY);
  assert.equal(first.ran, true);
  assert.equal(first.changed, 1);

  /* Same period, an hour later — a later tick on the same day. */
  const again = await S.runJob(db, job, new Date("2026-09-28T10:00:00.000Z"));
  assert.equal(again.ran, false);
  assert.match(String(again.skipped), /already done/);

  assert.deepEqual(calls, ["2026-09-28"], "the work happened exactly once");
});

test("the next period runs again", { skip }, async () => {
  const { job, calls } = counter();
  await S.runJob(db, job, DAY);
  await S.runJob(db, job, new Date("2026-09-29T09:00:00.000Z"));
  assert.deepEqual(calls, ["2026-09-28", "2026-09-29"]);
});

/*
 * TWO PROCESSES AT ONCE. This is the case an in-memory lock cannot cover and
 * the reason the claim is a database constraint rather than a variable.
 */
test("two processes racing the same period produce one run", { skip }, async () => {
  const { job, calls } = counter();
  const outcomes = await Promise.all([
    S.runJob(db, job, DAY), S.runJob(db, job, DAY),
    S.runJob(db, job, DAY), S.runJob(db, job, DAY),
  ]);

  assert.equal(outcomes.filter((o) => o.ran).length, 1, "exactly one ran");
  assert.equal(outcomes.filter((o) => !o.ran).length, 3, "the rest were refused");
  assert.equal(calls.length, 1, "and the work happened once");
});

/* ====================================================================== *
 * A CLAIM LEFT BEHIND BY A PROCESS THAT DIED
 * ====================================================================== */

/*
 * A deploy in the middle of a run is the ordinary way this happens. Left
 * alone the claim would block that period for ever, so a stale one is taken
 * over — but only after long enough that a slow run is never mistaken for a
 * dead one.
 */
test("a stale claim is taken over so the period is not blocked for ever", { skip }, async () => {
  const { job, calls } = counter();
  await db.jobRun.create({
    data: {
      job: job.key, periodKey: "2026-09-28", status: "RUNNING",
      startedAt: new Date(DAY.getTime() - 45 * 60_000),   /* 45 minutes ago */
    },
  });

  const out = await S.runJob(db, job, DAY);
  assert.equal(out.ran, true, "the abandoned period was picked up");
  assert.equal(calls.length, 1);

  const rows = await db.jobRun.findMany({ where: { job: job.key } });
  assert.equal(rows.length, 1, "it took the claim over rather than making a second");
  assert.equal(rows[0]!.status, "SUCCEEDED");
});

test("a claim that is merely slow is left alone", { skip }, async () => {
  const { job, calls } = counter();
  await db.jobRun.create({
    data: {
      job: job.key, periodKey: "2026-09-28", status: "RUNNING",
      startedAt: new Date(DAY.getTime() - 2 * 60_000),    /* 2 minutes ago */
    },
  });

  const out = await S.runJob(db, job, DAY);
  assert.equal(out.ran, false, "a run in progress must not be started twice");
  assert.equal(calls.length, 0);
});

/* And two processes both finding the same stale claim still produce one run. */
test("two takers of one stale claim still produce one run", { skip }, async () => {
  const { job, calls } = counter();
  await db.jobRun.create({
    data: {
      job: job.key, periodKey: "2026-09-28", status: "RUNNING",
      startedAt: new Date(DAY.getTime() - 45 * 60_000),
    },
  });

  const outcomes = await Promise.all([
    S.runJob(db, job, DAY), S.runJob(db, job, DAY), S.runJob(db, job, DAY),
  ]);
  assert.equal(outcomes.filter((o) => o.ran).length, 1);
  assert.equal(calls.length, 1);
});

/* ====================================================================== *
 * FAILURE
 * ====================================================================== */

/*
 * A failed run KEEPS its claim. Retrying a broken job every quarter of an hour
 * turns one fault into a stampede, and the row is the record of what went
 * wrong for whoever looks.
 */
test("a job that throws is recorded, and does not retry on the next tick", { skip }, async () => {
  let calls = 0;
  const job = {
    key: "test-fails-" + Math.random().toString(36).slice(2, 8),
    title: "A failing job", why: "To prove a failure is recorded.",
    period: (now: Date) => now.toISOString().slice(0, 10),
    run: async () => { calls += 1; throw new Error("the supplier said no"); },
  } as import("../src/domain/scheduler.ts").Job;

  const out = await S.runJob(db, job, DAY);
  assert.equal(out.ran, true);
  assert.match(String(out.error), /the supplier said no/);

  const row = await db.jobRun.findFirst({ where: { job: job.key } });
  assert.equal(row!.status, "FAILED");
  assert.match(row!.error, /the supplier said no/);

  const again = await S.runJob(db, job, DAY);
  assert.equal(again.ran, false, "it does not hammer a broken job");
  assert.equal(calls, 1);
});

/* A scheduler that can take the process down takes the website with it. */
test("tick never throws, whatever a job does", { skip }, async () => {
  const runs = await S.tick(db, DAY);
  assert.ok(Array.isArray(runs));
  /* And a second tick in the same period is a no-op rather than a repeat. */
  const again = await S.tick(db, DAY);
  assert.equal(again.every((r) => !r.ran), true, "the same period is not redone");
});

/* ====================================================================== *
 * THE JOB THAT SHIPS WITH IT
 * ====================================================================== */

/*
 * An invoice that passes its due date keeps saying SENT, because nothing
 * recomputes it. That is why domain/receivables.ts ages from `dueOn` rather
 * than trusting the column — and why every list filtered BY that column
 * under-reports arrears until this runs.
 */
test("the overdue sweep marks a passed-due invoice overdue", { skip }, async () => {
  const { cookie } = await company();

  const made = await call("/invoices", {
    method: "POST", cookie, body: { dueOn: "2026-09-01" },
  });
  const id = made.json.invoice.id;
  await call(`/invoices/${id}/lines`, {
    method: "POST", cookie, body: { detail: "Rent", quantity: 1, unitPrice: 100000 },
  });
  await call(`/invoices/${id}`, { method: "PATCH", cookie, body: { status: "SENT" } });
  /* Exactly what time passing looks like: nothing touched it. */
  await db.invoice.update({ where: { id }, data: { status: "SENT" } });

  const sweep = S.JOBS.find((j) => j.key === "invoice-overdue")!;
  assert.ok(sweep, "the sweep is registered");
  /*
   * A DATE OF ITS OWN, because the tick test above runs the real jobs and so
   * claims this one's period for DAY. Reusing DAY here made the sweep skip and
   * the test fail for a reason that had nothing to do with sweeping — which is
   * the claim working exactly as intended.
   */
  const out = await S.runJob(db, sweep, new Date("2026-10-01T09:00:00.000Z"));
  assert.equal(out.ran, true);
  assert.ok(out.changed >= 1, `nothing was marked overdue: ${JSON.stringify(out)}`);

  const after = await db.invoice.findUnique({ where: { id } });
  assert.equal(after!.status, "OVERDUE");
});

test("the sweep leaves a paid invoice and an undated one alone", { skip }, async () => {
  const { cookie } = await company();

  /* Paid in full, and past its date. */
  const paidId = (await call("/invoices", {
    method: "POST", cookie, body: { dueOn: "2026-09-01" } })).json.invoice.id;
  await call(`/invoices/${paidId}/lines`, {
    method: "POST", cookie, body: { detail: "Rent", quantity: 1, unitPrice: 50000 } });
  await call(`/invoices/${paidId}`, { method: "PATCH", cookie, body: { status: "SENT" } });
  await call("/payments", { method: "POST", cookie,
    body: { invoiceId: paidId, amount: 50000, method: "MPESA", reference: "SWEEP-PAID-1" } });

  /* Owed, but nobody dated it — it cannot be late. */
  const undatedId = (await call("/invoices", { method: "POST", cookie, body: {} })).json.invoice.id;
  await call(`/invoices/${undatedId}/lines`, {
    method: "POST", cookie, body: { detail: "Rent", quantity: 1, unitPrice: 70000 } });
  await call(`/invoices/${undatedId}`, { method: "PATCH", cookie, body: { status: "SENT" } });

  const sweep = S.JOBS.find((j) => j.key === "invoice-overdue")!;
  await S.runJob(db, sweep, new Date("2026-10-05T09:00:00.000Z"));

  assert.equal((await db.invoice.findUnique({ where: { id: paidId } }))!.status, "PAID");
  assert.equal((await db.invoice.findUnique({ where: { id: undatedId } }))!.status, "SENT");
});

/* Every job has to explain itself, or the list becomes names nobody dares
   delete. */
test("every registered job says what it is and why it exists", { skip }, () => {
  assert.ok(S.JOBS.length > 0);
  for (const j of S.JOBS) {
    assert.ok(j.key && j.title && j.why, `${j.key} is not described`);
    assert.ok(j.why.length > 20, `${j.key}'s reason is too thin to be useful`);
    assert.equal(typeof j.period(DAY), "string");
  }
  const keys = S.JOBS.map((j) => j.key);
  assert.equal(new Set(keys).size, keys.length, "two jobs share a key");
});
