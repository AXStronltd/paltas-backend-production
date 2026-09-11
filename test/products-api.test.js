/* ====================================================================== *
 * THE PRODUCT API, END TO END.
 *
 * The framework in http/resource.js makes one promise and the whole design
 * rests on it: EVERY endpoint it builds is scoped to one company,
 * permission-checked, and unable to write a field its resource did not
 * declare. tenancy.test.js proves that about the SOURCE. This proves it
 * about the RUNNING SERVICE, with two real companies in one real database
 * trying to read each other.
 *
 * ── WHY THIS MAY SKIP ──────────────────────────────────────────────────
 *
 * Same reason as api.test.js: it needs a generated Prisma client, and
 * `prisma generate` downloads an engine from binaries.prisma.sh. The
 * environment this was written in cannot reach that host, so THESE TESTS
 * HAVE NEVER RUN. They are written to run on the first machine that can:
 *
 *     npx prisma generate
 *     TEST_DATABASE_URL=postgresql://…  npm test
 *
 * Until they are green, the product API has been proved correct by
 * reading and by static analysis, and by nothing else.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { RESOURCES } from "../src/domain/registry.js";

/* Reading the migrations off disk is db-help.js's job now, so the filesystem
   and path imports this file used to need have gone with it. */
import { freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

/* This file's own schema. It DROPs and rebuilds on every run, so it must not
   be a schema any other test file is reading — see db-help.js. Prisma is
   pointed at it HERE, before src/db.js is imported, because the client reads
   DATABASE_URL once when it is constructed. */
const SCHEMA = "test_products";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping product API tests";
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
      ? "RUN `npx prisma generate` FIRST — the product API end-to-end tests cannot run without it"
      : "database unreachable: " + m.slice(0, 90);
  }
}

/* ---------------------------------------------------------------- rig */

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

/** A company holding some products, with one signed-in person in a role. */
async function company({ products, role, subscription = "ACTIVE" }) {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Company ${n}`,
      subscription: { create: { status: subscription } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: products[0] } },
      entitlements: { create: products.map((p) => ({ product: p })) },
    },
  });
  const email = `person${n}@example.com`;
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

const EVERYTHING = ["PROPERTY_MANAGEMENT", "HOTEL_MANAGEMENT", "AGENT_HOST", "SECURITY_MANAGEMENT"];

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (skip) {
    console.log("\n  THE PRODUCT API END-TO-END TESTS DID NOT RUN.\n  " + skip + "\n");
  }
});

/* ================================================================ *
 * 1. THE WALL BETWEEN TWO COMPANIES.
 * ================================================================ */

test("one company cannot read, change or delete another's rows", { skip }, async () => {
  const a = await company({ products: EVERYTHING, role: "OWNER" });
  const b = await company({ products: EVERYTHING, role: "OWNER" });

  const made = await call("/sites", {
    method: "POST", cookie: a.cookie,
    body: { name: "A's headquarters", city: "Nairobi" },
  });
  assert.equal(made.status, 201, made.text);
  const id = made.json.site.id;

  /* B's list does not contain it. */
  const list = await call("/sites", { cookie: b.cookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.sites.filter((s) => s.id === id).length, 0,
    "one company's list contained another company's site");

  /*
   * And asking for it by id is NOT FOUND, not FORBIDDEN. A 403 would itself
   * confirm the row exists, which is how two companies on one platform
   * enumerate each other by watching which ids answer differently.
   */
  const direct = await call(`/sites/${id}`, { cookie: b.cookie });
  assert.equal(direct.status, 404, "asking for another company's row did not 404");

  const patched = await call(`/sites/${id}`, {
    method: "PATCH", cookie: b.cookie, body: { name: "Mine now" },
  });
  assert.equal(patched.status, 404);

  const deleted = await call(`/sites/${id}`, { method: "DELETE", cookie: b.cookie });
  assert.equal(deleted.status, 404);

  /* A's row is untouched. */
  const still = await call(`/sites/${id}`, { cookie: a.cookie });
  assert.equal(still.json.site.name, "A's headquarters");
});

test("the wall holds for every resource, not only the one somebody tested", { skip }, async () => {
  /*
   * A SWEEP, ON PURPOSE. The framework builds all of these the same way, so
   * one of them being wrong means the framework is wrong — but a resource
   * declaration can also be wrong on its own, and then only that one leaks.
   * Checking each is cheap; finding out from a customer is not.
   */
  const a = await company({ products: EVERYTHING, role: "OWNER" });
  const b = await company({ products: EVERYTHING, role: "OWNER" });

  /*
   * A REQUIRED REFERENCE NEEDS A REAL ROW BEHIND IT.
   *
   * `zones.siteId` is `id:site`, it is NOT NULL, and the framework checks
   * that an id in a body names a row in the CALLER'S OWN company — which is
   * exactly the wall this file is about. So a generated string is refused
   * with a 400, and that is the server being right and this sweep being
   * lazy. Build the row the reference points at instead of special-casing
   * zones, so the next resource that gains a required reference is covered
   * by the same four lines.
   */
  const referenced = new Map();                 // model → an id of A's own

  async function idOf(model) {
    if (referenced.has(model)) return referenced.get(model);
    const found = Object.entries(RESOURCES).find(([, d]) => d.model === model);
    assert.ok(found, `nothing in the registry declares model "${model}"`);
    const [refSlug, refDecl] = found;
    const made = await call(`/${refSlug}`, {
      method: "POST", cookie: a.cookie, body: await bodyFor(refSlug, refDecl),
    });
    assert.equal(made.status, 201,
      `could not create the ${refSlug} a required reference needs: ${made.text}`);
    const id = Object.values(made.json)[0].id;
    referenced.set(model, id);
    return id;
  }

  async function bodyFor(slug, r) {
    const body = {};
    for (const key of r.required || []) {
      const kind = r.fields[key];
      body[key] = kind.startsWith("id:") ? await idOf(kind.slice(3))
                : kind === "int" || kind === "money" || kind === "float" ? 1
                : kind === "bool" ? true
                : kind === "date" ? "2026-01-01"
                : `A's ${slug}`;
    }
    return body;
  }

  for (const [slug, r] of Object.entries(RESOURCES)) {
    const body = await bodyFor(slug, r);
    const made = await call(`/${slug}`, { method: "POST", cookie: a.cookie, body });
    assert.equal(made.status, 201, `could not create a ${slug}: ${made.text}`);

    const row = Object.values(made.json)[0];
    const seen = await call(`/${slug}/${row.id}`, { cookie: b.cookie });
    assert.equal(seen.status, 404, `${slug}: company B could read company A's row`);

    const listed = await call(`/${slug}`, { cookie: b.cookie });
    assert.equal(listed.status, 200, `${slug}: ${listed.text}`);
    const rows = listed.json[slug] || [];
    assert.equal(rows.filter((x) => x.id === row.id).length, 0,
      `${slug}: company A's row appeared in company B's list`);
  }
});

test("an id in a body must name a row in the caller's own company", { skip }, async () => {
  /*
   * The subtler half of the wall. The row lands in the right company — but
   * joined to a stranger's, and every screen that follows the relation then
   * reads across. The foreign keys do not stop this: they only check the row
   * exists somewhere.
   */
  const a = await company({ products: EVERYTHING, role: "OWNER" });
  const b = await company({ products: EVERYTHING, role: "OWNER" });

  const site = await call("/sites", {
    method: "POST", cookie: b.cookie, body: { name: "B's site" },
  });
  assert.equal(site.status, 201);

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

  /* And its own product still works, so this is a wall and not an outage. */
  const units = await call("/units", { cookie: c.cookie });
  assert.equal(units.status, 200);
});

test("a guard writes the security log and can delete none of it", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "GUARD" });

  const made = await call("/visits", {
    method: "POST", cookie: c.cookie,
    body: { visitor: "A caller", purpose: "Meeting" },
  });
  assert.equal(made.status, 201, made.text);

  const decided = await call(`/visits/${made.json.visit.id}/decide`, {
    method: "POST", cookie: c.cookie, body: { decision: "approved" },
  });
  assert.equal(decided.status, 200, decided.text);
  assert.equal(decided.json.visit.status, "APPROVED");
  assert.ok(decided.json.visit.decidedBy, "nobody was recorded as having decided");

  const gone = await call(`/visits/${made.json.visit.id}`, { method: "DELETE", cookie: c.cookie });
  assert.equal(gone.status, 403, "a guard deleted a visit record");

  /* And a guard sees no money at all. */
  const money = await call("/invoices", { cookie: c.cookie });
  assert.equal(money.status, 403);
});

test("refusing somebody entry needs a reason on the record", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "SECURITY_MANAGER" });
  const made = await call("/visits", {
    method: "POST", cookie: c.cookie, body: { visitor: "Someone" },
  });
  const bare = await call(`/visits/${made.json.visit.id}/decide`, {
    method: "POST", cookie: c.cookie, body: { decision: "refused" },
  });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /reason/i);
});

test("a cancelled subscription closes the door without deleting anything", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "OWNER", subscription: "CANCELED" });
  const res = await call("/sites", { cookie: c.cookie });
  assert.equal(res.status, 403);
  assert.match(res.json.message, /nothing has been deleted/i);
});

/* ================================================================ *
 * 3. MONEY.
 * ================================================================ */

test("an invoice total is computed from its lines, and cannot be sent", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "FINANCE" });

  const made = await call("/invoices", {
    method: "POST", cookie: c.cookie,
    /* The lie is in the body on purpose. */
    body: { currency: "KES", status: "SENT", total: 1, paid: 999999 },
  });
  assert.equal(made.status, 201, made.text);
  const invoice = made.json.invoice;
  assert.equal(invoice.total, 0, "a client set an invoice total");
  assert.equal(invoice.paid, 0, "a client set an amount paid");
  assert.match(invoice.ref, /^INV-\d{4}$/, `reference was ${invoice.ref}`);

  /* 150,000 minor units plus 16% tax, twice over. */
  const withLine = await call(`/invoices/${invoice.id}/lines`, {
    method: "POST", cookie: c.cookie,
    body: { detail: "March rent", quantity: 2, unitPrice: 150000, taxBps: 1600 },
  });
  assert.equal(withLine.status, 201, withLine.text);
  assert.equal(withLine.json.invoice.total, 348000, "the total is not lines plus tax");

  /* Paying part of it moves the status, and the server decides that too. */
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
  assert.equal(rest.json.invoice.status, "PAID");
  assert.equal(rest.json.invoice.paid, 348000);
});

test("the same payment reference cannot be banked twice", { skip }, async () => {
  /* The ordinary way this happens is a double submit on a phone with a bad
     signal, not fraud — and the customer must not be charged twice for it. */
  const c = await company({ products: EVERYTHING, role: "FINANCE" });
  const body = { amount: 5000, method: "MPESA", reference: "SAME-CODE" };

  const first = await call("/payments", { method: "POST", cookie: c.cookie, body });
  assert.equal(first.status, 201, first.text);

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

  const bare = await call(`/payments/${payment.id}/void`, {
    method: "POST", cookie: c.cookie, body: {},
  });
  assert.equal(bare.status, 400, "a payment was voided with no reason");

  const voided = await call(`/payments/${payment.id}/void`, {
    method: "POST", cookie: c.cookie, body: { reason: "Keyed against the wrong invoice" },
  });
  assert.equal(voided.status, 200, voided.text);
  assert.equal(voided.json.payment.voided, true);
  assert.match(voided.json.payment.voidReason, /wrong invoice/);

  /* The row is still there, and the invoice is owed again. */
  assert.equal(voided.json.invoice.paid, 0);
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
    method: "POST", cookie: c.cookie,
    body: { detail: "Room, 2 nights", amount: 240000 },
  });

  const early = await call(`/reservations/${stay.id}/folio/close`, {
    method: "POST", cookie: c.cookie, body: {},
  });
  assert.equal(early.status, 409, "a hotel bill closed with money outstanding");
  assert.match(early.json.message, /does not balance/i);

  /* A payment on a folio is a line with the sign reversed — the one place a
     negative amount is right. */
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

test("a list is capped however large a limit is asked for", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "OWNER" });
  for (let i = 0; i < 12; i++) {
    await call("/parties", { method: "POST", cookie: c.cookie, body: { name: `Contact ${i}` } });
  }
  const page = await call("/parties?limit=3", { cookie: c.cookie });
  assert.equal(page.json.parties.length, 3);
  assert.ok(page.json.nextCursor, "no cursor was offered for the next page");

  const next = await call(`/parties?limit=3&cursor=${page.json.nextCursor}`, { cookie: c.cookie });
  assert.equal(next.json.parties.length, 3);
  assert.notEqual(next.json.parties[0].id, page.json.parties[0].id, "the cursor did not move");

  /* And a limit nobody should be able to ask for is refused silently rather
     than obeyed — a script with no pagination does this by accident. */
  const huge = await call("/parties?limit=100000", { cookie: c.cookie });
  assert.ok(huge.json.parties.length <= 100, "a caller raised the page ceiling by asking");
});

test("searching finds rows and still cannot cross a company", { skip }, async () => {
  const a = await company({ products: EVERYTHING, role: "OWNER" });
  const b = await company({ products: EVERYTHING, role: "OWNER" });
  await call("/parties", { method: "POST", cookie: a.cookie, body: { name: "Wanjiru Kamau" } });
  await call("/parties", { method: "POST", cookie: b.cookie, body: { name: "Wanjiru Otieno" } });

  const mine = await call("/parties?q=wanjiru", { cookie: a.cookie });
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

  await call(`/work-orders/${id}`, {
    method: "PATCH", cookie: c.cookie, body: { status: "IN_PROGRESS" },
  });
  await call(`/work-orders/${id}`, {
    method: "PATCH", cookie: c.cookie, body: { status: "DONE" },
  });

  const read = await call(`/work-orders/${id}`, { cookie: c.cookie });
  const events = read.json.workOrder.events || [];
  assert.ok(events.length >= 3, `expected created + two changes, got ${events.length}`);
  assert.equal(events[0].what, "created");
  assert.ok(events.every((e) => e.byName), "an event does not say who made it");

  /* There is no endpoint that edits one, which is what append-only means. */
  const edit = await call(`/work-orders/${id}/events/${events[0].id}`, {
    method: "PATCH", cookie: c.cookie, body: { what: "never happened" },
  });
  assert.equal(edit.status, 404, "a work order's history could be edited");
});

test("every write is recorded, with who did it", { skip }, async () => {
  const c = await company({ products: EVERYTHING, role: "OWNER" });
  const made = await call("/parties", {
    method: "POST", cookie: c.cookie, body: { name: "Audited Contact" },
  });
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
  assert.equal(narrow.status, 200);
  assert.ok("visitorsWaiting" in narrow.json.counts, "a guard cannot see the gate queue");
  assert.ok(!("unpaidInvoices" in narrow.json.counts),
    "a guard's summary carried how much the company is owed — the number is itself information");
});

test("signing out of the product API is the same as never signing in", { skip }, async () => {
  for (const path of ["/sites", "/invoices", "/visits", "/summary"]) {
    const res = await call(path);
    assert.equal(res.status, 401, `${path} answered an anonymous caller with ${res.status}`);
  }
});
