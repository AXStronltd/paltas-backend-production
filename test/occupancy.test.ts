/* ======================================================================
 * A UNIT'S STATUS IS THE ONE ANSWER EVERY PRODUCT READS.
 *
 * Marketplace decides what to list from it. Sales decides what may be
 * offered. Property Management counts vacancies with it. Development
 * reports inventory from it. So a unit that is wrong is wrong in four
 * places at once, and that is what these tests are for.
 *
 * Before domain/occupancy.ts existed, two of the five UnitStatus values
 * were unreachable — nothing in the service could produce OCCUPIED or
 * NOTICE. The first test here fails outright against that version, which
 * is the point of writing it this way round.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

import { portOf, present } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";

process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const skip = DB ? false : "no TEST_DATABASE_URL — skipping occupancy tests";

const SCHEMA = "occupancy_test";
let createApp: typeof import("../src/server.ts")["createApp"];
let db: typeof import("../src/db.ts")["db"];
let pg: typeof import("pg")["default"];
let server: import("node:http").Server;
let base: string;
let seq = 0;

if (!skip) {
  process.env.DATABASE_URL = urlForSchema(String(DB), SCHEMA);
  ({ default: pg } = await import("pg"));
  const pool = poolInSchema(pg, String(DB), SCHEMA);
  try {
    await freshSchema(pool, SCHEMA);
  } catch (e) {
    /* explain() answers null when it has nothing to add beyond the driver's
       own message. Rethrowing the original beats an Error reading "null". */
    const said = explain(e, String(DB));
    throw said ? new Error(said) : e;
  } finally {
    await pool.end();
  }
  ({ createApp } = await import("../src/server.ts"));
  ({ db } = await import("../src/db.ts"));
  server = http.createServer(createApp());
  await new Promise<void>((r) => { server.listen(0, () => r()); });
  base = `http://127.0.0.1:${portOf(server)}`;
}

test.after(async () => {
  if (skip) return;
  await new Promise<void>((r) => { server.close(() => r()); });
  await db.$disconnect();
});

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
  try { json = JSON.parse(text); } catch { /* not every reply is JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** A property company with an owner signed in. */
async function company() {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Occupancy ${n} Ltd`,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const email = `owner${n}@occupancy.test`;
  const user = await db.user.create({
    data: { email, name: `Owner ${n}`, googleSub: "sub_" + email },
  });
  await db.membership.create({
    data: { userId: user.id, orgId: org.id, role: "OWNER" },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: org.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return { org, user, cookie: `paltas_session=${token}` };
}

/** A unit, through the API the console uses. */
async function unit(cookie: string) {
  const n = ++seq;
  const made = await call("/units", {
    method: "POST", cookie, body: { ref: `UNIT-${n}`, name: `Flat ${n}` },
  });
  assert.equal(made.status, 201, made.text.slice(0, 200));
  return made.json.unit;
}

const statusOf = async (id: string): Promise<string> =>
  present(await db.unit.findUnique({ where: { id } }), "the unit is gone").status;

/* ==================================================================== *
 * THE THREE TRANSITIONS THAT DID NOT EXIST.
 * ==================================================================== */

test("an active lease occupies its unit", { skip }, async () => {
  const { cookie } = await company();
  const u = await unit(cookie);
  assert.equal(u.status, "VACANT", "a new unit starts vacant");

  const lease = await call("/leases", {
    method: "POST", cookie,
    body: { unitId: u.id, tenantName: "A Tenant", rent: 45000, status: "ACTIVE" },
  });
  assert.equal(lease.status, 201, lease.text.slice(0, 240));

  assert.equal(await statusOf(u.id), "OCCUPIED",
    "*** signing a lease did not occupy the unit. A fully let building " +
    "reports as entirely vacant, and the vacancy count on the dashboard " +
    "reads the same column. ***");

  assert.equal(lease.json.occupancy?.to, "OCCUPIED",
    "the reply does not say what it did to the unit");
});

test("a lease under notice puts the unit under notice", { skip }, async () => {
  const { cookie } = await company();
  const u = await unit(cookie);
  const made = await call("/leases", {
    method: "POST", cookie,
    body: { unitId: u.id, tenantName: "B Tenant", rent: 30000, status: "ACTIVE" },
  });
  assert.equal(await statusOf(u.id), "OCCUPIED");

  const noticed = await call(`/leases/${made.json.lease.id}`, {
    method: "PATCH", cookie, body: { status: "NOTICE" },
  });
  assert.equal(noticed.status, 200, noticed.text.slice(0, 200));
  assert.equal(await statusOf(u.id), "NOTICE",
    "a unit under notice is neither occupied for ever nor already empty — " +
    "it is the state a letting team works from, and it was unreachable");
});

test("ending a lease puts the unit back on the market", { skip }, async () => {
  const { cookie } = await company();
  const u = await unit(cookie);
  const made = await call("/leases", {
    method: "POST", cookie,
    body: { unitId: u.id, tenantName: "C Tenant", rent: 30000, status: "ACTIVE" },
  });
  assert.equal(await statusOf(u.id), "OCCUPIED");

  for (const [to, expected] of [["ENDED", "VACANT"], ["ACTIVE", "OCCUPIED"], ["TERMINATED", "VACANT"]]) {
    const moved = await call(`/leases/${made.json.lease.id}`, {
      method: "PATCH", cookie, body: { status: to },
    });
    assert.equal(moved.status, 200, moved.text.slice(0, 200));
    assert.equal(await statusOf(u.id), expected,
      `a ${to} lease should leave its unit ${expected}`);
  }
});

test("a draft lease occupies nothing", { skip }, async () => {
  const { cookie } = await company();
  const u = await unit(cookie);
  const made = await call("/leases", {
    method: "POST", cookie,
    body: { unitId: u.id, tenantName: "D Tenant", rent: 30000, status: "DRAFT" },
  });
  assert.equal(made.status, 201, made.text.slice(0, 200));
  assert.equal(await statusOf(u.id), "VACANT",
    "a lease somebody is still drafting emptied or filled a real flat");
  assert.match(String(made.json.occupancy?.unchanged), /DRAFT/,
    "the reply should say why the unit was left alone");
});

/* ==================================================================== *
 * WHERE A LETTING AND A SALE DISAGREE ABOUT THE SAME FLAT.
 * ==================================================================== */

test("a lease may not move a unit that is reserved for sale", { skip }, async () => {
  const { cookie, org } = await company();
  const u = await unit(cookie);
  await db.unit.update({ where: { id: u.id }, data: { status: "RESERVED" } });

  const made = await call("/leases", {
    method: "POST", cookie,
    body: { unitId: u.id, tenantName: "E Tenant", rent: 30000, status: "ACTIVE" },
  });
  assert.equal(made.status, 201, "the lease itself is a real agreement and is kept");
  assert.equal(await statusOf(u.id), "RESERVED",
    "*** a letting erased a buyer's reservation ***");
  assert.match(String(made.json.occupancy?.unchanged), /RESERVED/,
    "the disagreement must be stated, not silently resolved");

  const trail = await db.auditEvent.findMany({
    where: { orgId: org.id, action: "unit.occupancy" },
  });
  assert.equal(trail.length, 0, "nothing moved, so nothing should be recorded as moving");
});

test("a unit already sold is not put back on the market by a letting", { skip }, async () => {
  const { cookie } = await company();
  const u = await unit(cookie);
  await db.unit.update({ where: { id: u.id }, data: { status: "OFF_MARKET" } });

  await call("/leases", {
    method: "POST", cookie,
    body: { unitId: u.id, tenantName: "F Tenant", rent: 30000, status: "ENDED" },
  });
  assert.equal(await statusOf(u.id), "OFF_MARKET",
    "a finished lease dragged a withdrawn unit back into the available count");
});

/* ==================================================================== *
 * THE AUDIT TRAIL, BECAUSE A UNIT MOVING IS A THING THAT HAPPENED.
 * ==================================================================== */

test("every occupancy change is on the record", { skip }, async () => {
  const { cookie, org } = await company();
  const u = await unit(cookie);
  const made = await call("/leases", {
    method: "POST", cookie,
    body: { unitId: u.id, tenantName: "G Tenant", rent: 30000, status: "ACTIVE" },
  });
  await call(`/leases/${made.json.lease.id}`, {
    method: "PATCH", cookie, body: { status: "ENDED" },
  });

  const trail = await db.auditEvent.findMany({
    where: { orgId: org.id, action: "unit.occupancy", entityId: u.id },
    orderBy: { at: "asc" },
  });
  assert.equal(trail.length, 2, "two moves, two rows");
  assert.deepEqual(
    trail.map((e) => [(e.detail as Wire).from, (e.detail as Wire).to]),
    [["VACANT", "OCCUPIED"], ["OCCUPIED", "VACANT"]],
    "the trail should say where the unit went, not merely that it moved");
  assert.ok(trail.every((e) => e.actorName), "an occupancy change with nobody attached to it");
});

test("writing the same status twice does not record a move", { skip }, async () => {
  const { cookie, org } = await company();
  const u = await unit(cookie);
  const made = await call("/leases", {
    method: "POST", cookie,
    body: { unitId: u.id, tenantName: "H Tenant", rent: 30000, status: "ACTIVE" },
  });
  await call(`/leases/${made.json.lease.id}`, {
    method: "PATCH", cookie, body: { status: "ACTIVE", rent: 31000 },
  });

  const trail = await db.auditEvent.findMany({
    where: { orgId: org.id, action: "unit.occupancy", entityId: u.id },
  });
  assert.equal(trail.length, 1,
    "editing the rent on a live lease wrote a second 'the unit became occupied' row");
  assert.equal(await statusOf(u.id), "OCCUPIED");
});

/* ==================================================================== *
 * ORGANIZATION ISOLATION — a lease may only move its OWN company's unit.
 * ==================================================================== */

test("a lease cannot move another company's unit", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const theirUnit = await unit(theirs.cookie);

  const made = await call("/leases", {
    method: "POST", cookie: mine.cookie,
    body: { unitId: theirUnit.id, tenantName: "I Tenant", rent: 30000, status: "ACTIVE" },
  });
  assert.ok(made.status === 201 || made.status === 400 || made.status === 404,
    `unexpected ${made.status}: ${made.text.slice(0, 160)}`);

  assert.equal(await statusOf(theirUnit.id), "VACANT",
    "*** one company's lease occupied another company's flat ***");
});

/* ==================================================================== *
 * A SITTING TENANT IS NOT PART OF THE INVENTORY.
 *
 * The offer path has always refused a unit held by another SALE. It had
 * nothing to say about a letting, because before this work a let flat
 * read as VACANT — so the whole accept path was open on a property
 * somebody was living in.
 * ==================================================================== */

test("a let unit cannot be sold out from under its tenant", { skip }, async () => {
  const { cookie } = await company();
  const u = await unit(cookie);

  await call("/leases", {
    method: "POST", cookie,
    body: { unitId: u.id, tenantName: "Sitting Tenant", rent: 60000, status: "ACTIVE" },
  });
  assert.equal(await statusOf(u.id), "OCCUPIED");

  const buyer = await call("/parties", {
    method: "POST", cookie, body: { name: "A Buyer", kind: "BUYER" },
  });
  const offer = await call("/offers", {
    method: "POST", cookie,
    body: { unitId: u.id, buyerId: buyer.json.party.id, price: 9_000_000 },
  });
  assert.equal(offer.status, 201, offer.text.slice(0, 200));
  await call(`/offers/${offer.json.offer.id}/send`, { method: "POST", cookie });

  const accepted = await call(`/offers/${offer.json.offer.id}/accept`, {
    method: "POST", cookie,
  });
  assert.equal(accepted.status, 409,
    "*** a flat with a sitting tenant was reserved for a buyer ***");
  assert.match(String(accepted.json.message), /let under/i,
    "the refusal should name the lease, so somebody can act on it");

  assert.equal(await statusOf(u.id), "OCCUPIED",
    "the refused sale still moved the unit");
});

test("a unit whose lease has ended can be sold", { skip }, async () => {
  const { cookie } = await company();
  const u = await unit(cookie);
  const lease = await call("/leases", {
    method: "POST", cookie,
    body: { unitId: u.id, tenantName: "Former Tenant", rent: 60000, status: "ACTIVE" },
  });
  await call(`/leases/${lease.json.lease.id}`, {
    method: "PATCH", cookie, body: { status: "ENDED" },
  });
  assert.equal(await statusOf(u.id), "VACANT");

  const buyer = await call("/parties", {
    method: "POST", cookie, body: { name: "B Buyer", kind: "BUYER" },
  });
  const offer = await call("/offers", {
    method: "POST", cookie,
    body: { unitId: u.id, buyerId: buyer.json.party.id, price: 9_000_000 },
  });
  await call(`/offers/${offer.json.offer.id}/send`, { method: "POST", cookie });
  const accepted = await call(`/offers/${offer.json.offer.id}/accept`, {
    method: "POST", cookie,
  });
  assert.equal(accepted.status, 201,
    `an empty flat should be sellable: ${accepted.text.slice(0, 200)}`);
  assert.equal(await statusOf(u.id), "RESERVED");
});

/* ==================================================================== *
 * THE END OF THE SALE. A unit stayed RESERVED for ever before this.
 * ==================================================================== */

test("completing a sale takes the unit off the market for good", { skip }, async () => {
  const { cookie } = await company();
  const u = await unit(cookie);
  const buyer = await call("/parties", {
    method: "POST", cookie, body: { name: "C Buyer", kind: "BUYER" },
  });
  const offer = await call("/offers", {
    method: "POST", cookie,
    body: { unitId: u.id, buyerId: buyer.json.party.id, price: 1_000_000 },
  });
  await call(`/offers/${offer.json.offer.id}/send`, { method: "POST", cookie });
  const accepted = await call(`/offers/${offer.json.offer.id}/accept`, {
    method: "POST", cookie,
  });
  assert.equal(accepted.status, 201, accepted.text.slice(0, 200));
  const contractId = accepted.json.reservation.id;
  assert.equal(await statusOf(u.id), "RESERVED");

  await call(`/contracts/${contractId}/status`, {
    method: "POST", cookie, body: { status: "SOLD" },
  });
  /* Money reaches a contract through an invoice, which is where the total is
     recomputed — see the balance gate in routes/handover.ts. */
  const inv = await call("/invoices", {
    method: "POST", cookie, body: { contractId, currency: "KES", issuedOn: "2026-01-01" },
  });
  assert.equal(inv.status, 201, inv.text.slice(0, 220));
  const line = await call(`/invoices/${inv.json.invoice.id}/lines`, {
    method: "POST", cookie,
    body: { detail: "Full price", quantity: 1, unitPrice: 1_000_000 },
  });
  assert.equal(line.status, 201, line.text.slice(0, 220));
  const pay = await call("/payments", {
    method: "POST", cookie,
    body: {
      invoiceId: inv.json.invoice.id, amount: 1_000_000, currency: "KES",
      method: "BANK", reference: `OCC-${Date.now()}`,
    },
  });
  assert.equal(pay.status, 201, pay.text.slice(0, 220));

  const done = await call(`/contracts/${contractId}/status`, {
    method: "POST", cookie, body: { status: "COMPLETED" },
  });
  assert.equal(done.status, 200, done.text.slice(0, 240));

  assert.equal(await statusOf(u.id), "OFF_MARKET",
    "*** a sold, paid-for, completed unit is still showing as merely " +
    "reserved. It never leaves the sales pipeline and never counts as sold. ***");
  assert.equal(done.json.soldUnit?.status, "OFF_MARKET",
    "the reply does not say the unit was taken off the market");
});
