/* ====================================================================== *
 * PALTAS CONNECT, END TO END.
 *
 * channels.test.js proves things about the SOURCE. This proves them about the
 * running service, with two real companies in one real database:
 *
 *   the sync REFUSES with 503 and says why, rather than answering 200
 *   the roll-up counts what happened and excludes what did not
 *   commission is computed from integer minor units, not from a display figure
 *   a reservation cannot be attributed to another company's channel
 *
 * Same rig and the same schema discipline as products-api.test.js: its own
 * Postgres schema, dropped and rebuilt on every run.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

const SCHEMA = "test_connect";
process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping PALTAS Connect API tests";
let createApp, db, pg, channels;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
    ({ createApp } = await import("../src/server.js"));
    channels = await import("../src/domain/channels.ts");
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = String(e && e.message);
    skip = /did not initialize|locate the Query Engine|generate/.test(m)
      ? "RUN `npx prisma generate` FIRST"
      : "database unreachable: " + m.slice(0, 90);
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
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, json, text };
}

let seq = 0;

async function hotel(role = "OWNER") {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Hotel ${n}`,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "HOTEL_MANAGEMENT" } },
      entitlements: { create: [{ product: "HOTEL_MANAGEMENT" }] },
    },
  });
  const email = `gm${n}@example.com`;
  const user = await db.user.upsert({
    where: { email },
    create: { email, name: `GM ${n}`, googleSub: "sub_" + email },
    update: {},
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: org.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
  return { org, user, cookie: `paltas_session=${token}` };
}

if (!skip) { test.before(boot); }
test.beforeEach(() => { if (channels) channels.clear(); });
test.after(async () => {
  if (channels) channels.clear();
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (skip) console.log("\n  PALTAS CONNECT API TESTS DID NOT RUN.\n  " + skip + "\n");
});

/* ================================================================ *
 * 1. THE REFUSAL, OVER HTTP.
 * ================================================================ */

test("a sync with no channel manager attached answers 503, not 200", { skip }, async () => {
  const a = await hotel();
  const ch = await db.channel.create({
    data: { orgId: a.org.id, name: "Booking.com", status: "LIVE", commissionBps: 1500 },
  });

  const r = await call(`/channels/${ch.id}/sync`, { method: "POST", cookie: a.cookie });

  assert.equal(r.status, 503,
    `a sync that did nothing must not answer 200. Got ${r.status}: ${r.text.slice(0, 160)}`);
  assert.match(r.json.message, /channel manager/i,
    "the operator must be told what is missing");
  assert.match(r.json.message, /credentials/i,
    "and that it is a commercial gap rather than an outage");
  assert.ok(!/went wrong at our end/.test(r.json.message),
    "this surfaced as a generic 500 — the error is not being exposed");
});

test("a refused sync does not stamp lastSyncAt", { skip }, async () => {
  const a = await hotel();
  const ch = await db.channel.create({
    data: { orgId: a.org.id, name: "Expedia", status: "LIVE" },
  });

  await call(`/channels/${ch.id}/sync`, { method: "POST", cookie: a.cookie });

  const after = await db.channel.findUnique({ where: { id: ch.id } });
  assert.equal(after.lastSyncAt, null,
    "the row now reads as synced. That is the defect this endpoint replaced: " +
    "a channel that looks current when nothing was pushed to it.");
});

test("a sync that works stamps the row and reports real counts", { skip }, async () => {
  const a = await hotel();
  const ch = await db.channel.create({
    data: { orgId: a.org.id, name: "Airbnb", status: "DISCONNECTED" },
  });

  channels.register({
    name: "test-manager",
    async sync() { return { pushed: 7, pulled: 2 }; },
  });

  const r = await call(`/channels/${ch.id}/sync`, { method: "POST", cookie: a.cookie });
  assert.equal(r.status, 200, r.text.slice(0, 160));
  assert.equal(r.json.sync.pushed, 7);
  assert.equal(r.json.sync.pulled, 2);

  const after = await db.channel.findUnique({ where: { id: ch.id } });
  assert.ok(after.lastSyncAt instanceof Date, "a real sync must be stamped");
  assert.equal(after.status, "LIVE");
});

test("a paused channel is not handed inventory", { skip }, async () => {
  const a = await hotel();
  const ch = await db.channel.create({
    data: { orgId: a.org.id, name: "Agoda", status: "PAUSED" },
  });
  channels.register({ name: "m", async sync() { return { pushed: 1, pulled: 0 }; } });

  const r = await call(`/channels/${ch.id}/sync`, { method: "POST", cookie: a.cookie });
  assert.equal(r.status, 409, "a paused channel must refuse before it is pushed rooms");
});

test("syncing all reports each channel and marks the failures", { skip }, async () => {
  const a = await hotel();
  await db.channel.createMany({
    data: [
      { orgId: a.org.id, name: "One", status: "LIVE" },
      { orgId: a.org.id, name: "Two", status: "LIVE" },
      { orgId: a.org.id, name: "Idle", status: "DISCONNECTED" },
    ],
  });

  const r = await call("/channels/sync", { method: "POST", cookie: a.cookie });
  assert.equal(r.status, 200, "the batch call itself succeeds; the channels inside it failed");
  assert.equal(r.json.results.length, 2, "only LIVE channels are synced");
  assert.equal(r.json.synced, 0);
  assert.equal(r.json.failed, 2);
  assert.ok(r.json.results.every((x) => x.ok === false && x.why),
    "each failure must carry its reason");

  const rows = await db.channel.findMany({ where: { orgId: a.org.id, name: { in: ["One", "Two"] } } });
  assert.ok(rows.every((c) => c.status === "ERROR"),
    "a channel that could not be synced must not still read LIVE");
});

/* ================================================================ *
 * 2. THE ROLL-UP.
 * ================================================================ */

async function stay(orgId, channelId, { rate, status = "CONFIRMED", ref }) {
  return db.reservation.create({
    data: { orgId, channelId, ref, guestName: "G", rate: BigInt(rate), status },
  });
}

test("the roll-up counts only stays that happened, and attributes by key", { skip }, async () => {
  const a = await hotel();
  const bk = await db.channel.create({
    data: { orgId: a.org.id, name: "Booking.com", status: "LIVE", commissionBps: 1500 },
  });

  /* 250.00 + 150.00 countable; a cancellation and a no-show that must not count. */
  await stay(a.org.id, bk.id, { rate: 25_000, ref: "R1" });
  await stay(a.org.id, bk.id, { rate: 15_000, ref: "R2" });
  await stay(a.org.id, bk.id, { rate: 99_900, ref: "R3", status: "CANCELLED" });
  await stay(a.org.id, bk.id, { rate: 88_800, ref: "R4", status: "NO_SHOW" });
  /* And one the front desk took, attributed to nobody. */
  await stay(a.org.id, null, { rate: 50_000, ref: "R5" });

  const r = await call("/connect/rollup", { cookie: a.cookie });
  assert.equal(r.status, 200, r.text.slice(0, 160));

  const row = r.json.channels.find((c) => c.id === bk.id);
  assert.equal(row.reservations, 2, "a cancellation and a no-show were counted");
  assert.equal(row.revenueMinor, 40_000, "revenue must be the sum of countable stays, in minor units");
  /* 15% of 400.00 is 60.00 — taken from the integer, not from a rounded display value. */
  assert.equal(row.commissionMinor, 6_000, "commission must be revenue * bps / 10000");
  assert.equal(r.json.unattributed, 1,
    "the front-desk stay must be reported as unattributed, not spread across channels");
});

test("a channel with no reservations reports zero rather than being omitted", { skip }, async () => {
  const a = await hotel();
  const ch = await db.channel.create({
    data: { orgId: a.org.id, name: "Quiet", status: "LIVE", commissionBps: 1200 },
  });
  const r = await call("/connect/rollup", { cookie: a.cookie });
  const row = r.json.channels.find((c) => c.id === ch.id);
  assert.ok(row, "every channel must appear, so the screen can list it");
  assert.equal(row.reservations, 0);
  assert.equal(row.revenueMinor, 0);
  assert.equal(row.commissionMinor, 0);
});

test("the roll-up states the basis it was computed on", { skip }, async () => {
  const a = await hotel();
  const r = await call("/connect/rollup", { cookie: a.cookie });
  assert.ok(r.json.basis && r.json.basis.length > 40,
    "a figure an operator will act on must say what it counted");
  assert.equal(r.json.days, 30);
  assert.ok(r.json.since, "the window must be stated, not implied");
});

/* ================================================================ *
 * 3. THE WALL.
 * ================================================================ */

test("one hotel's channels are invisible to another", { skip }, async () => {
  const a = await hotel();
  const b = await hotel();
  await db.channel.create({
    data: { orgId: b.org.id, name: "B's private channel", status: "LIVE" },
  });

  const r = await call("/connect/rollup", { cookie: a.cookie });
  assert.equal(r.status, 200);
  assert.ok(!r.json.channels.some((c) => c.name === "B's private channel"),
    "the roll-up leaked another company's channel");
});

test("a reservation cannot be attributed to another company's channel", { skip }, async () => {
  const a = await hotel();
  const b = await hotel();
  const theirs = await db.channel.create({
    data: { orgId: b.org.id, name: "Theirs", status: "LIVE" },
  });

  const r = await call("/reservations", {
    method: "POST", cookie: a.cookie,
    body: { guestName: "Guest", channelId: theirs.id },
  });

  assert.equal(r.status, 400,
    "the framework must refuse an id that names a row in another company — " +
    "the foreign key alone only checks the channel exists somewhere");
  assert.match(r.json.message, /channelId/,
    "the refusal must name the field that was wrong");
});

test("syncing another company's channel is refused", { skip }, async () => {
  const a = await hotel();
  const b = await hotel();
  const theirs = await db.channel.create({
    data: { orgId: b.org.id, name: "Theirs", status: "LIVE" },
  });
  channels.register({ name: "m", async sync() { return { pushed: 1, pulled: 1 }; } });

  const r = await call(`/channels/${theirs.id}/sync`, { method: "POST", cookie: a.cookie });
  assert.equal(r.status, 404,
    "'exists but is not yours' must be indistinguishable from 'does not exist'");

  const after = await db.channel.findUnique({ where: { id: theirs.id } });
  assert.equal(after.lastSyncAt, null, "another company's channel was synced");
});

/* ================================================================ *
 * 4. WHO MAY.
 * ================================================================ */

test("signing in is required", { skip }, async () => {
  const a = await hotel();
  const ch = await db.channel.create({ data: { orgId: a.org.id, name: "X", status: "LIVE" } });

  for (const [path, method] of [
    ["/connect/rollup", "GET"], ["/connect/status", "GET"],
    [`/channels/${ch.id}/sync`, "POST"], ["/channels/sync", "POST"],
  ]) {
    const r = await call(path, { method });
    assert.equal(r.status, 401, `${method} ${path} is reachable without a session`);
  }
});

test("status reports the gap and carries no credential", { skip }, async () => {
  const a = await hotel();
  const r = await call("/connect/status", { cookie: a.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.connected, false);
  assert.ok(r.json.why.length > 40);
  assert.deepEqual(Object.keys(r.json).sort(),
    ["capabilities", "connected", "label", "name", "why"]);
});
