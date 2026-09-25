/* ====================================================================== *
 * AN OFFER, AND WHAT ACCEPTING ONE DOES TO EVERYTHING ELSE.
 *
 * An offer is the step between a lead and a reservation, and accepting one is
 * not a status change — it reserves a unit, opens a reservation, and closes
 * every rival offer on that flat. All of it happens or none of it does.
 *
 * So most of what is below is about the CONSEQUENCES rather than the row. The
 * failure this guards against is the half-completed sale: a unit marked
 * reserved with no reservation behind it, or two buyers each told yes.
 *
 *     npx prisma generate
 *     TEST_DATABASE_URL=postgresql://…  npm test
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_offers";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping offer tests";
let dbHelp = null;
let createApp, db, pg;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
    ({ createApp } = await import("../src/server.ts"));
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
  const me = await db.session.findFirst({
    where: { tokenHash: crypto.createHash("sha256").update(token).digest("hex") },
    select: { orgId: true },
  });
  return { cookie, session, orgId: me.orgId };
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


/** The chart, seeded, as a code → id map. */
async function chartOf(cookie) {
  await call("/ledger/accounts/seed", { method: "POST", cookie });
  const { json } = await call("/ledger/accounts", { cookie });
  return Object.fromEntries(json.accounts.map((a) => [a.code, a.id]));
}

/** The same company, seen by somebody with a narrower role. */
async function asRole(owner, role) {
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
 * A SALE, END TO END
 * ====================================================================== */

/** A buyer, a project, a unit and an offer on it. */
async function offerOn(cookie, { price = 12_000_000, discount = 0, deposit = 1_000_000, validUntil } = {}) {
  const k = ++seq;
  const site = await call("/sites", { method: "POST", cookie, body: { name: `Site ${k}`, city: "Nairobi" } });
  const project = await call("/projects", { method: "POST", cookie, body: { name: `Tower ${k}`, city: "Nairobi" } });
  const unit = await call("/units", { method: "POST", cookie,
    body: { ref: `U-${100 + k}`, siteId: site.json.site.id, projectId: project.json.project.id } });
  const buyer = await call("/parties", { method: "POST", cookie, body: { name: `Buyer ${k}`, kind: "BUYER" } });

  const offer = await call("/offers", { method: "POST", cookie,
    body: {
      buyerId: buyer.json.party.id, projectId: project.json.project.id,
      unitId: unit.json.unit.id, price, discount, deposit,
      currency: "KES", paymentPlan: "30/70 on completion",
      ...(validUntil ? { validUntil } : {}),
    } });
  assert.equal(offer.status, 201, offer.text.slice(0, 200));
  return {
    offerId: offer.json.offer.id, unitId: unit.json.unit.id,
    buyerId: buyer.json.party.id, projectId: project.json.project.id,
    ref: offer.json.offer.ref,
  };
}

const unitOf = (cookie, id) => call(`/units/${id}`, { cookie });

test("an offer is created as a draft, with a reference", { skip }, async () => {
  const { cookie } = await company();
  const o = await offerOn(cookie);
  const { json } = await call(`/offers/${o.offerId}`, { cookie });
  assert.equal(json.offer.status, "DRAFT");
  assert.match(json.offer.ref, /^OFF-\d{4}$/);
  /* Nothing has happened to the unit yet. */
  const u = await unitOf(cookie, o.unitId);
  assert.equal(u.json.unit.status, "VACANT");
});

test("status cannot be written directly — it is moved by an act", { skip }, async () => {
  /*
   * THE DESIGN THIS FILE EXISTS TO PROTECT. A writable status is a state
   * machine anybody can step around: marked accepted, unit still on the
   * market, no reservation anywhere.
   */
  const { cookie } = await company();
  const o = await offerOn(cookie);
  await call(`/offers/${o.offerId}`, { method: "PATCH", cookie, body: { status: "ACCEPTED" } });

  const after = await call(`/offers/${o.offerId}`, { cookie });
  assert.equal(after.json.offer.status, "DRAFT", "status was written straight onto the row");
  const u = await unitOf(cookie, o.unitId);
  assert.equal(u.json.unit.status, "VACANT", "a unit was reserved without a reservation");
});

test("an offer walks draft to sent to viewed", { skip }, async () => {
  const { cookie } = await company();
  const o = await offerOn(cookie);

  const sent = await call(`/offers/${o.offerId}/send`, { method: "POST", cookie });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.offer.status, "SENT");
  assert.ok(sent.json.offer.sentAt, "it was not stamped as sent");

  const viewed = await call(`/offers/${o.offerId}/view`, { method: "POST", cookie });
  assert.equal(viewed.json.offer.status, "VIEWED");

  /* Opened again is still first opened once. */
  const again = await call(`/offers/${o.offerId}/view`, { method: "POST", cookie });
  assert.equal(again.json.already, true);
  assert.equal(again.json.offer.viewedAt, viewed.json.offer.viewedAt, "the first view was overwritten");
});

test("the order of the steps is enforced", { skip }, async () => {
  const { cookie } = await company();
  const o = await offerOn(cookie);

  /* A draft has not been sent, so it cannot have been viewed or decided. */
  assert.equal((await call(`/offers/${o.offerId}/view`, { method: "POST", cookie })).status, 409);
  assert.equal((await call(`/offers/${o.offerId}/accept`, { method: "POST", cookie })).status, 409);

  await call(`/offers/${o.offerId}/send`, { method: "POST", cookie });
  /* And it cannot be sent twice. */
  assert.equal((await call(`/offers/${o.offerId}/send`, { method: "POST", cookie })).status, 409);
});

test("accepting reserves the unit and opens a reservation", { skip }, async () => {
  /* THE WHOLE POINT. One act, four consequences, all of them or none. */
  const { cookie } = await company();
  const o = await offerOn(cookie, { price: 12_000_000, discount: 500_000, deposit: 1_000_000 });
  await call(`/offers/${o.offerId}/send`, { method: "POST", cookie });

  const res = await call(`/offers/${o.offerId}/accept`, { method: "POST", cookie });
  assert.equal(res.status, 201, res.text.slice(0, 220));

  assert.equal(res.json.offer.status, "ACCEPTED");
  assert.match(res.json.reservation.ref, /^CON-\d{4}$/);
  assert.equal(res.json.reservation.status, "RESERVED");

  /* What was AGREED, not what was asked — price less the discount. */
  assert.equal(Number(res.json.reservation.price), 11_500_000);
  assert.equal(Number(res.json.reservation.deposit), 1_000_000);

  /* The unit is off the market, from the same act. Marketplace reads this. */
  const u = await unitOf(cookie, o.unitId);
  assert.equal(u.json.unit.status, "RESERVED", "the unit is still on sale");

  /* And the chain is traceable in both directions. */
  const back = await call(`/offers/${o.offerId}`, { cookie });
  assert.equal(back.json.offer.contract.ref, res.json.reservation.ref);
  assert.equal(res.json.reservation.offerId, o.offerId);
});

test("accepting one offer closes every rival on that unit", { skip }, async () => {
  /*
   * Two buyers, one flat. Leaving the loser SENT means somebody is still
   * being chased for a unit that is gone.
   */
  const { cookie } = await company();
  const a = await offerOn(cookie, { price: 10_000_000 });

  const rival = await call("/offers", { method: "POST", cookie,
    body: { buyerId: a.buyerId, projectId: a.projectId, unitId: a.unitId, price: 9_000_000, currency: "KES" } });
  await call(`/offers/${rival.json.offer.id}/send`, { method: "POST", cookie });
  await call(`/offers/${a.offerId}/send`, { method: "POST", cookie });

  const res = await call(`/offers/${a.offerId}/accept`, { method: "POST", cookie });
  assert.equal(res.json.supersededOffers, 1, "the rival offer was left live");

  const loser = await call(`/offers/${rival.json.offer.id}`, { cookie });
  assert.equal(loser.json.offer.status, "EXPIRED");
});

test("a unit already reserved refuses a second acceptance", { skip }, async () => {
  const { cookie } = await company();
  const a = await offerOn(cookie);
  await call(`/offers/${a.offerId}/send`, { method: "POST", cookie });
  await call(`/offers/${a.offerId}/accept`, { method: "POST", cookie });

  /* A fresh offer on the same unit, made after the reservation exists. */
  const later = await call("/offers", { method: "POST", cookie,
    body: { buyerId: a.buyerId, unitId: a.unitId, price: 13_000_000, currency: "KES" } });
  await call(`/offers/${later.json.offer.id}/send`, { method: "POST", cookie });

  const res = await call(`/offers/${later.json.offer.id}/accept`, { method: "POST", cookie });
  assert.equal(res.status, 409, "the same unit was sold twice");
  assert.match(res.json.message, /already reserved/i);
});

test("an offer past its date cannot be accepted, and says so everywhere", { skip }, async () => {
  const { cookie } = await company();
  const o = await offerOn(cookie, { validUntil: new Date(Date.now() - 864e5).toISOString() });
  await db.offer.update({ where: { id: o.offerId }, data: { status: "SENT", sentAt: new Date() } });

  const res = await call(`/offers/${o.offerId}/accept`, { method: "POST", cookie });
  assert.equal(res.status, 409, "a lapsed offer was accepted");

  /* And the row itself is corrected, so no other reader still thinks it live. */
  const after = await call(`/offers/${o.offerId}`, { cookie });
  assert.equal(after.json.offer.status, "EXPIRED");

  const u = await unitOf(cookie, o.unitId);
  assert.equal(u.json.unit.status, "VACANT");
});

test("rejecting needs a reason, and keeps it", { skip }, async () => {
  const { cookie } = await company();
  const o = await offerOn(cookie);
  await call(`/offers/${o.offerId}/send`, { method: "POST", cookie });

  assert.equal((await call(`/offers/${o.offerId}/reject`, { method: "POST", cookie, body: {} })).status, 400);

  const res = await call(`/offers/${o.offerId}/reject`, {
    method: "POST", cookie, body: { reason: "Bought elsewhere" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.offer.status, "REJECTED");
  assert.equal(res.json.offer.declineReason, "Bought elsewhere");

  /* A rejected offer leaves the unit alone. */
  const u = await unitOf(cookie, o.unitId);
  assert.equal(u.json.unit.status, "VACANT");
});

test("the pipeline is what is still in play, and corrects what lapsed", { skip }, async () => {
  const { cookie } = await company();
  const live = await offerOn(cookie, { price: 5_000_000 });
  await call(`/offers/${live.offerId}/send`, { method: "POST", cookie });
  const dead = await offerOn(cookie, { price: 8_000_000, validUntil: new Date(Date.now() - 864e5).toISOString() });
  await db.offer.update({ where: { id: dead.offerId }, data: { status: "SENT" } });

  const { json } = await call("/offers/pipeline", { cookie });
  assert.equal(json.count, 1, "a lapsed offer was counted as live");
  assert.equal(json.expiredNow, 1);
  assert.equal(Number(json.value), 5_000_000);
  assert.equal(json.byStatus.sent, 1);
});

test("one company's offers are invisible to another", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const o = await offerOn(theirs.cookie);

  assert.equal((await call(`/offers/${o.offerId}`, { cookie: mine.cookie })).status, 404);
  assert.equal((await call(`/offers/${o.offerId}/accept`, { method: "POST", cookie: mine.cookie })).status, 404);
  const list = await call("/offers/pipeline", { cookie: mine.cookie });
  assert.equal(list.json.count, 0);
});

test("every move is recorded", { skip }, async () => {
  const { orgId, cookie } = await company();
  const o = await offerOn(cookie);
  await call(`/offers/${o.offerId}/send`, { method: "POST", cookie });
  await call(`/offers/${o.offerId}/accept`, { method: "POST", cookie });

  const events = await db.auditEvent.findMany({
    where: { orgId, action: { startsWith: "offer." } },
    select: { action: true },
  });
  const actions = new Set(events.map((e) => e.action));
  assert.ok(actions.has("offer.send"), "sending was not recorded");
  assert.ok(actions.has("offer.accept"), "accepting a sale was not recorded");
});
