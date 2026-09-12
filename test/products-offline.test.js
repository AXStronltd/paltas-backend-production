/* ====================================================================== *
 * THE PRODUCT API, ACTUALLY RUN.
 *
 * Same tests as products-api.test.js — the real Express app, the real
 * routers, real HTTP over a real socket — but with rows kept in memory by
 * test/fake-prisma.js instead of in PostgreSQL.
 *
 * This exists because `@prisma/client` cannot be generated in the
 * environment this was written in, and "somebody will run it later" is not
 * a way to find out whether 150 endpoints work.
 *
 * WHAT IT DOES NOT REPLACE: the real end-to-end run. The fake proves the
 * 4,000 lines above the database; migration.test.js proves the SQL beneath
 * it; only products-api.test.js against real PostgreSQL proves the join.
 * Run that too.
 *
 * Needs Node's module mocking:
 *     node --experimental-test-module-mocks --test test/*.test.js
 * `npm test` passes the flag. Without it this file skips rather than fails,
 * because a Node that cannot mock modules is not a broken service.
 * ====================================================================== */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { RESOURCES } from "../src/domain/registry.js";

process.env.DATABASE_URL ||= "postgresql://fake@127.0.0.1:5432/fake";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = typeof mock.module === "function"
  ? false
  : "run with --experimental-test-module-mocks (npm test does)";

let db, createApp;

if (!skip) {
  const { createFakeDb } = await import("./fake-prisma.js");
  db = createFakeDb();

  /* The one substitution. Everything downstream of src/db.js is the real
     code, unaware that anything is unusual. */
  mock.module("../src/db.js", {
    namedExports: { db, closeDb: async () => {} },
  });

  ({ createApp } = await import("../src/server.js"));
}

/* ---------------------------------------------------------------- rig */

let server, base;

async function boot() {
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

async function company({ products, role, subscription = "ACTIVE", verification = "COMPLETE" }) {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Company ${n}`,
      subscription: { create: { status: subscription } },
      verification: { create: { status: verification } },
      workspace: { create: { preferred: products[0] } },
      entitlements: { create: products.map((p) => ({ product: p })) },
    },
  });
  const email = `person${n}@example.com`;
  const user = await db.user.create({
    data: { email, name: `Person ${n}`, googleSub: "sub_" + email },
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

const EVERYTHING = ["PROPERTY_MANAGEMENT", "HOTEL_MANAGEMENT", "AGENT_HOST", "SECURITY_MANAGEMENT"];

/**
 * The fields a resource needs, filled with something plausible.
 *
 * `made` maps a model name to an id already created in this company, so a
 * required reference — zones.siteId, say — gets a REAL site rather than a
 * string. Filling it with a label would make every such create fail for the
 * wrong reason and hide whatever the test was actually looking for.
 */
function sample(r, label, made = {}) {
  const body = {};
  for (const key of r.required || []) {
    const kind = r.fields[key];
    if (kind.startsWith("id:")) {
      const id = made[kind.slice(3)];
      assert.ok(id, `the sweep needs a ${kind.slice(3)} before it can create this`);
      body[key] = id;
      continue;
    }
    body[key] = kind === "int" || kind === "money" || kind === "float" ? 1
              : kind === "bool" ? true
              : kind === "date" ? "2026-01-01"
              : label;
  }
  return body;
}

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

/* ================================================================ *
 * 1. THE WALL BETWEEN TWO COMPANIES.
 * ================================================================ */

test("one company cannot read, change or delete another's rows", { skip }, async () => {
  const a = await company({ products: EVERYTHING, role: "OWNER" });
  const b = await company({ products: EVERYTHING, role: "OWNER" });

  const made = await call("/sites", {
    method: "POST", cookie: a.cookie, body: { name: "A's headquarters", city: "Nairobi" },
  });
  assert.equal(made.status, 201, made.text);
  const id = made.json.site.id;

  const list = await call("/sites", { cookie: b.cookie });
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.sites.filter((s) => s.id === id).length, 0,
    "one company's list contained another company's site");

  /* NOT FOUND, not FORBIDDEN — a 403 confirms the row exists, and that is
     how two companies on one platform enumerate each other. */
  assert.equal((await call(`/sites/${id}`, { cookie: b.cookie })).status, 404);
  assert.equal((await call(`/sites/${id}`, {
    method: "PATCH", cookie: b.cookie, body: { name: "Mine now" } })).status, 404);
  assert.equal((await call(`/sites/${id}`, { method: "DELETE", cookie: b.cookie })).status, 404);

  const still = await call(`/sites/${id}`, { cookie: a.cookie });
  assert.equal(still.json.site.name, "A's headquarters", "the other company changed it anyway");
});

/* The count comes from the registry, not from a number typed here: it said 28
   for as long as there were 43 resources, and a stale number in a test name is
   a quiet claim that the sweep is smaller than it is. */
test(`the wall holds for every one of the ${Object.keys(RESOURCES).length} resources`,
  { skip }, async () => {
  const a = await company({ products: EVERYTHING, role: "OWNER" });
  const b = await company({ products: EVERYTHING, role: "OWNER" });

  const created = {};
  for (const [slug, r] of Object.entries(RESOURCES)) {
    /* Nothing creates these through the staff API — see `noCreate`. Their wall
       is covered by the guest portal's own tests, where the caller is a guest. */
    if (r.noCreate) continue;
    const made = await call(`/${slug}`, {
      method: "POST", cookie: a.cookie, body: sample(r, `A's ${slug}`, created),
    });
    assert.equal(made.status, 201, `could not create a ${slug}: ${made.text}`);
    const row = Object.values(made.json)[0];
    created[r.model] = row?.id;
    assert.ok(row && row.id, `${slug}: the response has no row — ${made.text}`);

    assert.equal((await call(`/${slug}/${row.id}`, { cookie: b.cookie })).status, 404,
      `${slug}: company B read company A's row`);

    const listed = await call(`/${slug}`, { cookie: b.cookie });
    assert.equal(listed.status, 200, `${slug}: ${listed.text}`);
    assert.equal((listed.json[slug] || []).filter((x) => x.id === row.id).length, 0,
      `${slug}: company A's row appeared in company B's list`);
  }
});

test("an id in a body must name a row in the caller's own company", { skip }, async () => {
  const a = await company({ products: EVERYTHING, role: "OWNER" });
  const b = await company({ products: EVERYTHING, role: "OWNER" });

  const site = await call("/sites", {
    method: "POST", cookie: b.cookie, body: { name: "B's site" },
  });
  assert.equal(site.status, 201, site.text);

  const attempt = await call("/buildings", {
    method: "POST", cookie: a.cookie,
    body: { name: "A's block", siteId: site.json.site.id },
  });
  assert.equal(attempt.status, 400, "a building was attached to another company's site");
  assert.match(attempt.json.message, /does not name anything this company has/);
});

/* ================================================================ *
 * 2. ENTITLEMENT AND ROLE.
 * ================================================================ */

test("a company that has not bought a product cannot reach it", { skip }, async () => {
  const c = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });

  const rooms = await call("/rooms", { cookie: c.cookie });
  assert.equal(rooms.status, 403, "a company without Hotel Management reached rooms");
  assert.match(rooms.json.message, /does not include hotel management/i);

  assert.equal((await call("/units", { cookie: c.cookie })).status, 200,
    "its own product stopped working too — this is meant to be a wall, not an outage");
});

test("a guard writes the security log and can delete none of it", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "GUARD" });

  const made = await call("/visits", {
    method: "POST", cookie: c.cookie, body: { visitor: "A caller", purpose: "Meeting" },
  });
  assert.equal(made.status, 201, made.text);

  const decided = await call(`/visits/${made.json.visit.id}/decide`, {
    method: "POST", cookie: c.cookie, body: { decision: "approved" },
  });
  assert.equal(decided.status, 200, decided.text);
  assert.equal(decided.json.visit.status, "APPROVED");
  assert.ok(decided.json.visit.decidedBy, "nobody was recorded as having decided");

  assert.equal((await call(`/visits/${made.json.visit.id}`, {
    method: "DELETE", cookie: c.cookie })).status, 403, "a guard deleted a visit record");

  assert.equal((await call("/invoices", { cookie: c.cookie })).status, 403,
    "a guard can read the company's money");
});

test("refusing somebody entry needs a reason on the record", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "SECURITY_MANAGER" });
  const made = await call("/visits", {
    method: "POST", cookie: c.cookie, body: { visitor: "Someone" },
  });
  const bare = await call(`/visits/${made.json.visit.id}/decide`, {
    method: "POST", cookie: c.cookie, body: { decision: "refused" },
  });
  assert.equal(bare.status, 400, bare.text);
  assert.match(bare.json.message, /reason/i);
});

test("a cancelled subscription closes the door without deleting anything", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "OWNER", subscription: "CANCELED" });
  const res = await call("/sites", { cookie: c.cookie });
  assert.equal(res.status, 403, res.text);
  assert.match(res.json.message, /nothing has been deleted/i);
});

test("a late invoice is not a lockout", { skip }, async () => {
  /* PAST_DUE stays open on purpose. Taking a hotel's front desk away over a
     late payment turns a slow payer into a former customer. */
  const c = await company({ products: EVERYTHING, role: "OWNER", subscription: "PAST_DUE" });
  assert.equal((await call("/sites", { cookie: c.cookie })).status, 200);
});

/* ================================================================ *
 * 3. MONEY.
 * ================================================================ */

test("an invoice total is computed from its lines, and cannot be sent", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "FINANCE" });

  const made = await call("/invoices", {
    method: "POST", cookie: c.cookie,
    body: { currency: "KES", status: "SENT", total: 1, paid: 999999 },
  });
  assert.equal(made.status, 201, made.text);
  const invoice = made.json.invoice;
  assert.equal(invoice.total, 0, "a client set an invoice total");
  assert.equal(invoice.paid, 0, "a client set an amount paid");
  assert.match(invoice.ref, /^INV-\d{4}$/, `reference was ${invoice.ref}`);

  const withLine = await call(`/invoices/${invoice.id}/lines`, {
    method: "POST", cookie: c.cookie,
    body: { detail: "March rent", quantity: 2, unitPrice: 150000, taxBps: 1600 },
  });
  assert.equal(withLine.status, 201, withLine.text);
  assert.equal(withLine.json.invoice.total, 348000,
    "the total is not (2 × 150000) plus 16% tax");

  const part = await call("/payments", {
    method: "POST", cookie: c.cookie,
    body: { invoiceId: invoice.id, amount: 100000, method: "MPESA", reference: "ABC123" },
  });
  assert.equal(part.status, 201, part.text);
  assert.equal(part.json.invoice.paid, 100000);
  assert.equal(part.json.invoice.status, "PART_PAID");

  const rest = await call("/payments", {
    method: "POST", cookie: c.cookie,
    body: { invoiceId: invoice.id, amount: 248000, method: "MPESA", reference: "ABC124" },
  });
  assert.equal(rest.status, 201, rest.text);
  assert.equal(rest.json.invoice.paid, 348000);
  assert.equal(rest.json.invoice.status, "PAID");
});

test("the same payment reference cannot be banked twice", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "FINANCE" });
  const body = { amount: 5000, method: "MPESA", reference: "SAME-CODE" };

  assert.equal((await call("/payments", { method: "POST", cookie: c.cookie, body })).status, 201);

  const second = await call("/payments", { method: "POST", cookie: c.cookie, body });
  assert.equal(second.status, 409, "the same M-Pesa code was recorded twice");
  assert.match(second.json.message, /already recorded/i);
});

test("a payment is voided with a reason, never deleted", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "FINANCE" });
  const invoice = (await call("/invoices", {
    method: "POST", cookie: c.cookie, body: { status: "SENT" },
  })).json.invoice;
  await call(`/invoices/${invoice.id}/lines`, {
    method: "POST", cookie: c.cookie, body: { detail: "Fee", unitPrice: 20000 },
  });
  const payment = (await call("/payments", {
    method: "POST", cookie: c.cookie,
    body: { invoiceId: invoice.id, amount: 20000, method: "CASH", reference: "R1" },
  })).json.payment;

  const deleted = await call(`/payments/${payment.id}`, { method: "DELETE", cookie: c.cookie });
  assert.equal(deleted.status, 403, "a payment was deleted");
  assert.match(deleted.json.message, /voided, never deleted/i);

  assert.equal((await call(`/payments/${payment.id}/void`, {
    method: "POST", cookie: c.cookie, body: {} })).status, 400,
    "a payment was voided with no reason");

  const voided = await call(`/payments/${payment.id}/void`, {
    method: "POST", cookie: c.cookie, body: { reason: "Keyed against the wrong invoice" },
  });
  assert.equal(voided.status, 200, voided.text);
  assert.equal(voided.json.payment.voided, true);
  assert.match(voided.json.payment.voidReason, /wrong invoice/);
  assert.equal(voided.json.invoice.paid, 0, "the money came back but the invoice still says paid");
  assert.notEqual(voided.json.invoice.status, "PAID");
});

test("a folio takes charges and refuses to close out of balance", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "FRONT_DESK" });
  const stay = (await call("/reservations", {
    method: "POST", cookie: c.cookie,
    body: { guestName: "A guest", nights: 2, currency: "KES" },
  })).json.reservation;

  const opened = await call(`/reservations/${stay.id}/folio`, { cookie: c.cookie });
  assert.equal(opened.status, 200, opened.text);
  assert.equal(opened.json.balance, 0);

  await call(`/reservations/${stay.id}/folio/lines`, {
    method: "POST", cookie: c.cookie, body: { detail: "Room, 2 nights", amount: 240000 },
  });

  const early = await call(`/reservations/${stay.id}/folio/close`, {
    method: "POST", cookie: c.cookie, body: {},
  });
  assert.equal(early.status, 409, "a hotel bill closed with money outstanding");
  assert.match(early.json.message, /does not balance/i);

  /* The one place a negative amount is right: a payment on a folio. */
  await call(`/reservations/${stay.id}/folio/lines`, {
    method: "POST", cookie: c.cookie,
    body: { kind: "payment", detail: "Card", amount: -240000 },
  });
  const closed = await call(`/reservations/${stay.id}/folio/close`, {
    method: "POST", cookie: c.cookie, body: {},
  });
  assert.equal(closed.status, 200, closed.text);
  assert.equal(closed.json.balance, 0);
});

/* ================================================================ *
 * 4. THE FRAMEWORK'S OWN PROMISES.
 * ================================================================ */

test("a list is paged, and the ceiling cannot be raised by asking", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "OWNER" });
  for (let i = 0; i < 12; i++) {
    await call("/parties", { method: "POST", cookie: c.cookie, body: { name: `Contact ${i}` } });
  }
  const page = await call("/parties?limit=3", { cookie: c.cookie });
  assert.equal(page.status, 200, page.text);
  assert.equal(page.json.parties.length, 3);
  assert.ok(page.json.nextCursor, "no cursor was offered for the next page");

  const next = await call(`/parties?limit=3&cursor=${page.json.nextCursor}`, { cookie: c.cookie });
  assert.equal(next.json.parties.length, 3);
  assert.notEqual(next.json.parties[0].id, page.json.parties[0].id, "the cursor did not move");

  const huge = await call("/parties?limit=100000", { cookie: c.cookie });
  assert.ok(huge.json.parties.length <= 100, "a caller raised the page ceiling by asking");
});

test("searching finds rows and still cannot cross a company", { skip }, async () => {
  const a = await company({ products: EVERYTHING, role: "OWNER" });
  const b = await company({ products: EVERYTHING, role: "OWNER" });
  await call("/parties", { method: "POST", cookie: a.cookie, body: { name: "Wanjiru Kamau" } });
  await call("/parties", { method: "POST", cookie: b.cookie, body: { name: "Wanjiru Otieno" } });

  const mine = await call("/parties?q=wanjiru", { cookie: a.cookie });
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.json.parties.length, 1, "a search crossed the wall");
  assert.match(mine.json.parties[0].name, /Kamau/);
});

test("a work order keeps a history nobody can edit", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "OPERATIONS" });
  const made = await call("/work-orders", {
    method: "POST", cookie: c.cookie,
    body: { title: "Dripping tap", kind: "PLUMBING", priority: "HIGH" },
  });
  assert.equal(made.status, 201, made.text);
  const id = made.json.workOrder.id;

  await call(`/work-orders/${id}`, { method: "PATCH", cookie: c.cookie, body: { status: "IN_PROGRESS" } });
  await call(`/work-orders/${id}`, { method: "PATCH", cookie: c.cookie, body: { status: "DONE" } });

  const read = await call(`/work-orders/${id}`, { cookie: c.cookie });
  assert.equal(read.status, 200, read.text);
  const events = read.json.workOrder.events || [];
  assert.ok(events.length >= 3, `expected created + two changes, got ${events.length}`);
  assert.equal(events[0].what, "created");
  assert.ok(events.every((e) => e.byName), "an event does not say who made it");

  assert.equal((await call(`/work-orders/${id}/events/${events[0].id}`, {
    method: "PATCH", cookie: c.cookie, body: { what: "never happened" } })).status, 404,
    "a work order's history could be edited");
});

test("every write is recorded, with who did it", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "OWNER" });
  const made = await call("/parties", {
    method: "POST", cookie: c.cookie, body: { name: "Audited Contact" },
  });
  assert.equal(made.status, 201, made.text);
  await call(`/parties/${made.json.party.id}`, {
    method: "PATCH", cookie: c.cookie, body: { phone: "+254700000000" },
  });

  const events = await db.auditEvent.findMany({
    where: { orgId: c.org.id, entityId: made.json.party.id },
    orderBy: { at: "asc" },
  });
  assert.equal(events.length, 2, `expected a create and an update, got ${events.length}`);
  assert.equal(events[0].action, "create");
  assert.equal(events[1].action, "update");
  assert.equal(events[0].actorId, c.user.id);
  assert.ok(events[0].actorName, "the audit log does not name who acted");
});

test("the summary counts only what the role may see", { skip }, async () => {
  const owner = await company({ products: EVERYTHING, role: "OWNER" });
  await call("/invoices", { method: "POST", cookie: owner.cookie, body: { status: "SENT" } });

  const full = await call("/summary", { cookie: owner.cookie });
  assert.equal(full.status, 200, full.text);
  assert.ok("unpaidInvoices" in full.json.counts);
  assert.ok("visitorsWaiting" in full.json.counts);

  const guard = await company({ products: EVERYTHING, role: "GUARD" });
  const narrow = await call("/summary", { cookie: guard.cookie });
  assert.equal(narrow.status, 200, narrow.text);
  assert.ok("visitorsWaiting" in narrow.json.counts, "a guard cannot see the gate queue");
  assert.ok(!("unpaidInvoices" in narrow.json.counts),
    "a guard's summary carried how much the company is owed — that number is itself information");
});

test("an anonymous caller gets 401 everywhere, not a crash", { skip }, async () => {
  for (const path of ["/sites", "/invoices", "/visits", "/summary"]) {
    const res = await call(path);
    assert.equal(res.status, 401, `${path} answered an anonymous caller with ${res.status}`);
  }
});

test("a bad body is a 400 that names the field, not a 500", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "OWNER" });

  const missing = await call("/visits", { method: "POST", cookie: c.cookie, body: {} });
  assert.equal(missing.status, 400, missing.text);
  assert.match(missing.json.message, /visitor is required/);

  const nonsense = await call("/leases", {
    method: "POST", cookie: c.cookie, body: { rent: "a lot", startsOn: "next tuesday" },
  });
  assert.equal(nonsense.status, 400, nonsense.text);
  assert.ok(Array.isArray(nonsense.json.details), "the reply named only one of two problems");

  const empty = await call("/parties", { method: "POST", cookie: c.cookie, body: { name: "X" } });
  const nothing = await call(`/parties/${empty.json.party.id}`, {
    method: "PATCH", cookie: c.cookie, body: {},
  });
  assert.equal(nothing.status, 400, nothing.text);
  assert.match(nothing.json.message, /Nothing to change/i);
});

test("numbering is per company, and starts again for each", { skip }, async () => {
  /* Two customers must not be able to infer each other's volume from a
     reference number, and neither may be handed a duplicate. */
  const a = await company({ products: EVERYTHING, role: "OWNER" });
  const b = await company({ products: EVERYTHING, role: "OWNER" });

  const a1 = await call("/invoices", { method: "POST", cookie: a.cookie, body: {} });
  const a2 = await call("/invoices", { method: "POST", cookie: a.cookie, body: {} });
  const b1 = await call("/invoices", { method: "POST", cookie: b.cookie, body: {} });

  assert.equal(a1.json.invoice.ref, "INV-0001");
  assert.equal(a2.json.invoice.ref, "INV-0002");
  assert.equal(b1.json.invoice.ref, "INV-0001",
    "the second company's numbering carried on from the first company's");
});
