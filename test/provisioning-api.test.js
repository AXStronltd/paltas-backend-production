/* ====================================================================== *
 * PROVISIONING, END TO END.
 *
 * Putting a company on a product is the one staff action that changes what a
 * customer can open and what they will be billed for. So what is tested here
 * is mostly the door and the paper trail:
 *
 *   only PALTAS staff can reach it
 *   PLATFORM cannot be handed out by a typo
 *   the customer's own audit trail records it, naming who did it
 *   taking a product away suspends it and never deletes it
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_provisioning";
process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping provisioning tests";
let createApp, db, pg;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.js"));
    ({ createApp } = await import("../src/server.js"));
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = String(e && e.message);
    skip = /did not initialize|locate the Query Engine|generate/.test(m)
      ? "RUN `npx prisma generate` FIRST" : "database unreachable: " + m.slice(0, 90);
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
  try { json = JSON.parse(text); } catch { /* not all responses are JSON */ }
  return { status: res.status, json, text };
}

let seq = 0;
async function company({ products, role = "OWNER", name }) {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: name || `Company ${n}`,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: products[0] || "" } },
      entitlements: { create: products.map((p) => ({ product: p })) },
    },
  });
  const email = `p${n}@example.com`;
  const user = await db.user.upsert({
    where: { email },
    create: { email, name: `Person ${n}`, googleSub: "sub_" + email },
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

const GRANT = "/provisioning/entitlements";

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (skip) console.log("\n  PROVISIONING TESTS DID NOT RUN.\n  " + skip + "\n");
});

/* ================================================================ *
 * THE DOOR.
 * ================================================================ */

test("a customer cannot put themselves on a product", { skip }, async () => {
  const them = await company({ products: ["AGENT_HOST"], name: "Kabole LTD" });
  const r = await call(GRANT, {
    method: "POST", cookie: them.cookie,
    body: { orgId: them.org.id, product: "PROPERTY_MANAGEMENT" },
  });
  assert.equal(r.status, 403,
    "a company granted itself a product — that is free software and a billing hole");

  const held = await db.entitlement.findMany({ where: { orgId: them.org.id } });
  assert.deepEqual(held.map((e) => e.product), ["AGENT_HOST"]);
});

test("signing in is required", { skip }, async () => {
  const r = await call(GRANT, { method: "POST", body: { orgId: "x", product: "AGENT_HOST" } });
  assert.equal(r.status, 401);
});

test("the staff console itself stays read-only", { skip }, async () => {
  /* The rule this file was split out to preserve: /platform/* refuses writes. */
  const staff = await company({ products: ["PLATFORM"], role: "OWNER" });
  const r = await call("/platform/entitlements", {
    method: "POST", cookie: staff.cookie,
    body: { orgId: staff.org.id, product: "AGENT_HOST" },
  });
  assert.ok(r.status === 404 || r.status === 403 || r.status === 401,
    `POST /platform/entitlements answered ${r.status} — the console must stay read-only`);
});

/* ================================================================ *
 * THE GRANT.
 * ================================================================ */

test("PALTAS staff put a company on a product, and it takes effect", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "OWNER", name: "PALTAS" });
  const them = await company({ products: ["AGENT_HOST"], name: "Kabole Ltd" });

  const r = await call(GRANT, {
    method: "POST", cookie: staff.cookie,
    body: { orgId: them.org.id, product: "PROPERTY_MANAGEMENT" },
  });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  assert.equal(r.json.entitlement.product, "PROPERTY_MANAGEMENT");
  assert.equal(r.json.entitlement.status, "ACTIVE");
  assert.equal(r.json.company.name, "Kabole Ltd");

  /* Sorted in JS, not by the database: `product` is a Postgres enum and enums
     order by DECLARATION, not alphabetically — PROPERTY_MANAGEMENT is declared
     first, so orderBy asc does not mean what it looks like it means. */
  const held = await db.entitlement.findMany({
    where: { orgId: them.org.id, status: "ACTIVE" },
  });
  assert.deepEqual(held.map((e) => e.product).sort(),
    ["AGENT_HOST", "PROPERTY_MANAGEMENT"]);
});

test("granting twice does not give them two of it", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "OWNER" });
  const them = await company({ products: [] });

  for (let i = 0; i < 2; i++) {
    const r = await call(GRANT, {
      method: "POST", cookie: staff.cookie,
      body: { orgId: them.org.id, product: "HOTEL_MANAGEMENT" },
    });
    assert.equal(r.status, 201, r.text.slice(0, 160));
  }
  assert.equal(await db.entitlement.count({ where: { orgId: them.org.id } }), 1,
    "a second grant wrote a second row the company can never use");
});

test("the company's own audit trail records it, and names who did it", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "OWNER", name: "PALTAS Ops" });
  const them = await company({ products: [] });

  await call(GRANT, {
    method: "POST", cookie: staff.cookie,
    body: { orgId: them.org.id, product: "SECURITY_MANAGEMENT" },
  });

  const rows = await db.auditEvent.findMany({
    where: { orgId: them.org.id, action: "provisioning.entitlement.granted" },
  });
  assert.equal(rows.length, 1,
    "the customer cannot see that their products changed, or who changed them");
  assert.equal(rows[0].actorId, staff.user.id);
  assert.ok(rows[0].actorName, "the audit row does not name the member of staff");

  /* And it is THEIR trail, not ours. */
  const ours = await db.auditEvent.count({
    where: { orgId: staff.org.id, action: "provisioning.entitlement.granted" },
  });
  assert.equal(ours, 0, "the grant was filed against PALTAS instead of the customer");
});

/* ================================================================ *
 * WHAT IT REFUSES.
 * ================================================================ */

test("PLATFORM cannot be handed out by a typo", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "OWNER" });
  const them = await company({ products: [] });

  const slip = await call(GRANT, {
    method: "POST", cookie: staff.cookie,
    body: { orgId: them.org.id, product: "PLATFORM" },
  });
  assert.equal(slip.status, 400,
    "staff access to every company on PALTAS arrived by the same door as a product");
  assert.match(slip.json.message, /confirmStaffAccess/);
  assert.equal(await db.entitlement.count({ where: { orgId: them.org.id } }), 0);

  /* Said out loud, it is allowed — otherwise a second staff account could
     never be made without a database prompt. */
  const meant = await call(GRANT, {
    method: "POST", cookie: staff.cookie,
    body: { orgId: them.org.id, product: "PLATFORM", confirmStaffAccess: true },
  });
  assert.equal(meant.status, 201, meant.text.slice(0, 160));
});

test("a product that does not exist is refused", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "OWNER" });
  const them = await company({ products: [] });
  for (const product of ["", "PROPERTY", "EVERYTHING", "agent_host_pro"]) {
    const r = await call(GRANT, {
      method: "POST", cookie: staff.cookie,
      body: { orgId: them.org.id, product },
    });
    assert.equal(r.status, 400, `"${product}" was accepted as a product`);
  }
  assert.equal(await db.entitlement.count({ where: { orgId: them.org.id } }), 0);
});

test("a company that does not exist is refused", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "OWNER" });
  const r = await call(GRANT, {
    method: "POST", cookie: staff.cookie,
    body: { orgId: "not-a-real-company", product: "AGENT_HOST" },
  });
  assert.equal(r.status, 404);
});

/* ================================================================ *
 * TAKING IT AWAY.
 * ================================================================ */

test("removing a product suspends it and never deletes it", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "OWNER" });
  const them = await company({ products: ["HOTEL_MANAGEMENT"] });
  const row = await db.entitlement.findFirst({ where: { orgId: them.org.id } });

  const r = await call(`${GRANT}/${row.id}/suspend`, {
    method: "POST", cookie: staff.cookie, body: { why: "moved to annual billing" },
  });
  assert.equal(r.status, 200, r.text.slice(0, 160));
  assert.equal(r.json.entitlement.status, "SUSPENDED");

  const after = await db.entitlement.findUnique({ where: { id: row.id } });
  assert.ok(after, "the row was deleted — it can no longer answer when they had it");
  assert.equal(after.status, "SUSPENDED");

  const audit = await db.auditEvent.findFirst({
    where: { orgId: them.org.id, action: "provisioning.entitlement.suspended" },
  });
  assert.ok(audit, "the customer cannot see that a product was taken away");
  assert.equal(audit.detail.why, "moved to annual billing");
});

test("suspending twice is refused rather than silently repeated", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "OWNER" });
  const them = await company({ products: ["AGENT_HOST"] });
  const row = await db.entitlement.findFirst({ where: { orgId: them.org.id } });

  await call(`${GRANT}/${row.id}/suspend`, { method: "POST", cookie: staff.cookie });
  const again = await call(`${GRANT}/${row.id}/suspend`, { method: "POST", cookie: staff.cookie });
  assert.equal(again.status, 409);
});

test("a suspended product can be sold back", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "OWNER" });
  const them = await company({ products: ["AGENT_HOST"] });
  const row = await db.entitlement.findFirst({ where: { orgId: them.org.id } });

  await call(`${GRANT}/${row.id}/suspend`, { method: "POST", cookie: staff.cookie });
  const back = await call(GRANT, {
    method: "POST", cookie: staff.cookie,
    body: { orgId: them.org.id, product: "AGENT_HOST" },
  });
  assert.equal(back.status, 201);
  assert.equal(back.json.entitlement.status, "ACTIVE");
  assert.equal(await db.entitlement.count({ where: { orgId: them.org.id } }), 1,
    "selling it back created a second row instead of reviving the first");
});
