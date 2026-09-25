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
import { RESOURCES } from "../src/domain/registry.ts";

/* Reading the migrations off disk is db-help.js's job now, so the filesystem
   and path imports this file used to need have gone with it. */
import { freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
import { portOf } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";
import { present } from "./wire.ts";

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
    skip = /did not initialize|locate the Query Engine|generate/.test(m)
      ? "RUN `npx prisma generate` FIRST — the product API end-to-end tests cannot run without it"
      : "database unreachable: " + m.slice(0, 90);
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
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, json, text };
}

let seq = 0;

/** A company holding some products, with one signed-in person in a role. */
async function company({ products, role, subscription = "ACTIVE" }: { products: Wire; role: Wire; subscription?: Wire }) {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Company ${n}`,
      subscription: { create: { status: subscription } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: products[0] } },
      entitlements: { create: products.map((p: Wire) => ({ product: p })) },
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
  assert.equal(list.json.sites.filter((s: Wire) => s.id === id).length, 0,
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


  async function idOf(model: Wire) {
    if (referenced.has(model)) return referenced.get(model);
    const found = Object.entries(RESOURCES).find(([, d]) => d.model === model);
    assert.ok(found, `nothing in the registry declares model "${model}"`);
    const [refSlug, refDecl] = found;
    const made = await call(`/${refSlug}`, {
      method: "POST", cookie: a.cookie, body: await bodyFor(refSlug, refDecl),
    });
    assert.equal(made.status, 201,
      `could not create the ${refSlug} a required reference needs: ${made.text}`);
    const id = (Object.values(made.json)[0] as Wire).id;
    referenced.set(model, id);
    return id;
  }

  async function bodyFor(slug: string, r: Wire) {
    const body: Record<string, Wire> = {};
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
    /* Nothing creates these through the staff API — see `noCreate`. Their wall
       is covered by the guest portal's own tests, where the caller is a guest. */
    if (r.noCreate) continue;
    const body = await bodyFor(slug, r);
    const made = await call(`/${slug}`, { method: "POST", cookie: a.cookie, body });
    assert.equal(made.status, 201, `could not create a ${slug}: ${made.text}`);

    const row: Wire = Object.values(made.json)[0];
    const seen = await call(`/${slug}/${row.id}`, { cookie: b.cookie });
    assert.equal(seen.status, 404, `${slug}: company B could read company A's row`);

    const listed = await call(`/${slug}`, { cookie: b.cookie });
    assert.equal(listed.status, 200, `${slug}: ${listed.text}`);
    const rows = listed.json[slug] || [];
    assert.equal(rows.filter((x: Wire) => x.id === row.id).length, 0,
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

test("money at the scale this platform actually deals in", { skip }, async () => {
  /*
   * THE BUG THIS TEST EXISTS FOR.
   *
   * Money is a count of MINOR UNITS, which is right. It was stored in
   * Prisma's `Int` — PostgreSQL INT4 — which caps at 2,147,483,647 minor
   * units, or KES 21,474,836. Against the figures in the product:
   *
   *     Riverside Court, Nairobi      96,000,000,000 minor    45x over
   *     Marina Vista Tower, Dubai    410,000,000,000 minor   190x over
   *     Hudson Yards 41, New York    540,000,000,000 minor   250x over
   *
   * It did not round and it did not truncate. PostgreSQL refused the write
   * and the API answered 500: "Unable to fit integer value into an INT4".
   * Every property worth more than about twenty-one million shillings was
   * unsaveable.
   *
   * It survived because development figures were RENTS, which fit, and
   * product figures are VALUATIONS, which do not.
   */
  const a = await company({ products: EVERYTHING, role: "OWNER" });

  for (const [name, value] of [["Riverside Court", 96_000_000_000],
                               ["Marina Vista Tower", 410_000_000_000],
                               ["Hudson Yards 41", 540_000_000_000]]) {
    const made = await call("/sites", { method: "POST", cookie: a.cookie,
      body: { name, value, kind: "RESIDENTIAL" } });
    assert.equal(made.status, 201, `${name} could not be stored: ${made.text}`);
    assert.equal(made.json.site.value, value, `${name} came back changed`);
    /* A JSON number, not a string — 135 screens do arithmetic on this. */
    assert.equal(typeof made.json.site.value, "number");
  }

  /* And it survives the round trip out of the database. */
  const back = await call("/sites", { cookie: a.cookie });
  const hudson = back.json.sites.find((s: Wire) => s.name === "Hudson Yards 41");
  assert.equal(hudson.value, 540_000_000_000);
});

test("an invoice total is exact at that scale, and still rounds tax the same way", { skip }, async () => {
  const a = await company({ products: EVERYTHING, role: "OWNER" });
  const inv = await call("/invoices", { method: "POST", cookie: a.cookie,
    body: { currency: "KES", status: "SENT" } });
  const id = inv.json.invoice.id;

  /* 540,000,000,000 at 16% = 86,400,000,000 tax. Exact, not approximately. */
  await call(`/invoices/${id}/lines`, { method: "POST", cookie: a.cookie,
    body: { detail: "Sale", quantity: 1, unitPrice: 540_000_000_000, taxBps: 1600 } });
  const big = await call(`/invoices/${id}`, { cookie: a.cookie });
  assert.equal(big.json.invoice.total, 626_400_000_000);

  /*
   * ROUNDING, NOT TRUNCATION.
   *
   * BigInt division truncates toward zero; the Number version used
   * Math.round. On a 16% line that is one minor unit per line — the kind of
   * discrepancy that makes a customer's books disagree with their invoice by
   * a few cents and nobody can say why. 333 * 0.16 = 53.28, which rounds to
   * 53, so the total is 386 and not 385.
   */
  const inv2 = await call("/invoices", { method: "POST", cookie: a.cookie,
    body: { currency: "KES", status: "SENT" } });
  await call(`/invoices/${inv2.json.invoice.id}/lines`, { method: "POST", cookie: a.cookie,
    body: { detail: "rounding", quantity: 1, unitPrice: 333, taxBps: 1600 } });
  const r = await call(`/invoices/${inv2.json.invoice.id}`, { cookie: a.cookie });
  assert.equal(r.json.invoice.total, 386, "tax is being truncated instead of rounded");
});

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
  assert.ok(events.every((e: Wire) => e.byName), "an event does not say who made it");

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

/* ================================================================ *
 * THE TWO LISTS THE FRAMEWORK CANNOT BUILD.
 *
 * Membership has no orgId of its own in the sense the framework needs, and
 * FolioLine is two joins from its company. Both are therefore hand-written,
 * which means neither inherits the wall the framework gives everything else
 * — so each one gets its own tests rather than riding on the tenancy sweep.
 * ================================================================ */

test("the staff directory lists this company's people and nobody else's",
  { skip }, async () => {
  const mine = await company({ products: ["PROPERTY_MANAGEMENT"], role: "MANAGER" });
  const other = await company({ products: ["PROPERTY_MANAGEMENT"], role: "MANAGER" });

  const r = await call("/members", { cookie: mine.cookie });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.json.members.length, 1, "expected exactly this company's one member");
  assert.equal(r.json.members[0].role, "MANAGER");
  assert.ok(r.json.members[0].name, "a directory with no names is not a directory");

  /* The other company's person must not appear, by name or by id. */
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes(other.user.id), "another company's user id leaked");
  assert.ok(!body.includes(other.org.id), "another company's org id leaked");
});

test("the staff directory says how many sites, never which", { skip }, async () => {
  /*
   * A directory that lists every gate each guard covers is a map of where the
   * company is thin. The count answers "is this person site-restricted?",
   * which is what the screen needs.
   */
  const c = await company({ products: ["SECURITY_MANAGEMENT"], role: "MANAGER" });
  const site = await db.site.create({ data: { orgId: c.org.id, name: "North Gate" } });
  await db.membership.updateMany({
    where: { orgId: c.org.id }, data: { scope: { sites: [site.id] } } });

  const r = await call("/members", { cookie: c.cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.members[0].scope, { sites: 1 });
  assert.ok(!JSON.stringify(r.json).includes(site.id), "a site id leaked into the directory");
});

test("the staff directory cannot be written through", { skip }, async () => {
  /* A role is changed through the membership flow. A directory that accepts
     PATCH is a directory somebody promotes themselves in. */
  const c = await company({ products: ["PROPERTY_MANAGEMENT"], role: "MANAGER" });
  for (const [method, path] of [["POST", "/members"], ["PATCH", "/members/x"],
                                ["DELETE", "/members/x"]]) {
    const r = await call(path, { method, body: { role: "OWNER" }, cookie: c.cookie });
    assert.ok(r.status === 404 || r.status === 405,
      `${method} ${path} answered ${r.status} — the directory is writable`);
  }
  const after = present(await db.membership.findFirst({ where: { orgId: c.org.id } }), "no after — the row this test made is gone");
  assert.equal(after.role, "MANAGER", "the role changed");
});

test("folio lines are scoped through their folio, and need the hotel product",
  { skip }, async () => {
  const hotel = await company({ products: ["HOTEL_MANAGEMENT"], role: "MANAGER" });
  const other = await company({ products: ["HOTEL_MANAGEMENT"], role: "MANAGER" });

  /* One charge in each company, so "scoped" means something. */
  const pair: [typeof hotel, string][] = [[hotel, "mine"], [other, "theirs"]];
  for (const [c, tag] of pair) {
    const res = await db.reservation.create({
      data: { orgId: c.org.id, ref: "RES-" + tag, guestName: "Guest " + tag,
              roomNumber: "101", nights: 2, rate: 1000n },
    });
    const folio = await db.folio.create({ data: { orgId: c.org.id, reservationId: res.id } });
    await db.folioLine.create({
      data: { folioId: folio.id, kind: "charge", detail: "Room " + tag, amount: 1000n },
    });
  }

  const r = await call("/folio-lines", { cookie: hotel.cookie });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const rows = r.json["folio-lines"];
  assert.equal(rows.length, 1, "expected one line — got " + rows.length);
  assert.match(rows[0].detail, /mine/);
  assert.equal(rows[0].roomNumber, "101", "the room is what makes the line readable");
  assert.ok(!("postedBy" in rows[0]), "postedBy is staff information, not a report line");
  assert.ok(!JSON.stringify(r.json).includes("theirs"), "another company's charge leaked");

  /* A company without the product has no folios to read. */
  const noHotel = await company({ products: ["PROPERTY_MANAGEMENT"], role: "MANAGER" });
  const denied = await call("/folio-lines", { cookie: noHotel.cookie });
  assert.equal(denied.status, 403, "a company with no hotel product read folio lines");
});

/* ====================================================================== *
 * DOCUMENTS — THE FILE, AND WHO MAY REACH IT.
 * ====================================================================== */

test("a document's storage columns cannot be written by a caller", { skip }, async () => {
  /*
   * These four describe the FILE, and the server writes them from what storage
   * actually reports. A caller that can set storageKey can point its own row
   * at another company's object and then ask PALTAS to sign a link to it.
   */
  const a = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });
  const made = await call("/documents", { method: "POST", cookie: a.cookie,
    body: { name: "Certificate of Incorporation", kind: "OTHER" } });
  assert.equal(made.status, 201, made.text.slice(0, 200));
  const id = made.json.document.id;

  const tried = await call(`/documents/${id}`, { method: "PATCH", cookie: a.cookie,
    body: {
      name: "Renamed",
      storageKey: "org/somebody-else/documents/x/secret.pdf",
      bytes: 999, mimeType: "application/pdf", checksum: "forged",
    } });
  assert.equal(tried.status, 200);

  const row = present(await db.document.findUnique({ where: { id } }), "no row — the row this test made is gone");
  assert.equal(row.name, "Renamed", "an ordinary field stopped being writable");
  assert.equal(row.storageKey, "", "*** a caller set its own storage key ***");
  assert.equal(row.bytes, 0, "a caller claimed a file size");
  assert.equal(row.checksum, "", "a caller supplied the checksum meant to detect tampering");
  assert.equal(row.mimeType, "", "a caller claimed a file type");
});

test("one company cannot reach another's document, by id or by key", { skip }, async () => {
  const a = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });
  const b = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });

  const mine = await call("/documents", { method: "POST", cookie: a.cookie,
    body: { name: "Title Deed", kind: "OTHER" } });
  const id = mine.json.document.id;

  /* Straight at it, with a valid session of the wrong company. */
  for (const path of [`/documents/${id}`, `/documents/${id}/download-url`]) {
    const r = await call(path, { cookie: b.cookie });
    assert.equal(r.status, 404,
      `${path} answered ${r.status} to another company — 404 is the only answer that ` +
      `does not confirm the document exists`);
  }
  const post = await call(`/documents/${id}/upload-url`, { method: "POST", cookie: b.cookie,
    body: { filename: "x.pdf", contentType: "application/pdf", bytes: 10 } });
  assert.equal(post.status, 404, "another company could start an upload onto this document");
});

test("without storage configured, uploading says so instead of half working", { skip }, async () => {
  /* The test environment sets no R2 credentials, which is the same state
     production is in until they are added — so this is the real behaviour
     today, not a hypothetical one. */
  const a = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });
  const made = await call("/documents", { method: "POST", cookie: a.cookie,
    body: { name: "KRA PIN certificate", kind: "OTHER" } });
  const id = made.json.document.id;

  const up = await call(`/documents/${id}/upload-url`, { method: "POST", cookie: a.cookie,
    body: { filename: "pin.pdf", contentType: "application/pdf", bytes: 1024 } });
  assert.equal(up.status, 400, "an upload URL was issued with no storage behind it");
  assert.match(up.json.message, /not available/i);
  assert.ok(!/R2_|SECRET|KEY/.test(up.json.message),
    "an environment variable name was returned to a customer: " + up.json.message);

  /* The document itself is unharmed — recording it still works, which is what
     the product could already do. */
  const still = await call(`/documents/${id}`, { cookie: a.cookie });
  assert.equal(still.status, 200);
  assert.equal(still.json.document.name, "KRA PIN certificate");

  /* And the console can ask, rather than discovering it at the upload. */
  const status = await call("/storage/status", { cookie: a.cookie });
  assert.equal(status.status, 200);
  assert.equal(status.json.storage.connected, false);
  assert.ok(status.json.storage.maxBytes > 0, "the limit is not published");
  assert.ok(status.json.storage.accepts.includes("application/pdf"));
});

test("a property carries its own occupancy and rent roll", { skip }, async () => {
  /*
   * THE TWO HEADLINE NUMBERS OF A PROPERTY BUSINESS, WHICH READ ZERO.
   *
   * Occupancy and rent roll live in OTHER tables — units carry the status,
   * leases carry the rent — so a site row could not answer either. The
   * console showed 0 for both and said so honestly: "no endpoint computes
   * them, and a plausible-looking number on a portfolio screen is the kind of
   * figure that gets reported upwards."
   *
   * That was the right refusal and the wrong end state: an owner opened their
   * portfolio and saw 0% occupancy across a full building. GET /sites counts
   * both now, from the rows the caller can already see.
   */
  const c = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });

  const site = (await call("/sites", { method: "POST", cookie: c.cookie,
    body: { name: "Riverside Court", city: "Nairobi", country: "ke", kind: "RESIDENTIAL" } })).json.site;

  /* Three units: two occupied, one empty. */
  const units = [];
  for (const [ref, status] of [["A1", "OCCUPIED"], ["A2", "OCCUPIED"], ["A3", "VACANT"]]) {
    units.push((await call("/units", { method: "POST", cookie: c.cookie,
      body: { siteId: site.id, ref, status } })).json.unit);
  }
  const tenant = (await call("/parties", { method: "POST", cookie: c.cookie,
    body: { name: "A Tenant" } })).json.party;

  /* Two active leases, and one that has ended — which is not income. */
  for (const u of units.slice(0, 2)) {
    await call("/leases", { method: "POST", cookie: c.cookie,
      body: { unitId: u.id, tenantId: tenant.id, rent: 50000, currency: "KES",
              startsOn: "2026-01-01", status: "ACTIVE" } });
  }
  await call("/leases", { method: "POST", cookie: c.cookie,
    body: { unitId: units[2].id, tenantId: tenant.id, rent: 99000, currency: "KES",
            startsOn: "2020-01-01", status: "ENDED" } });

  const listed = (await call("/sites", { cookie: c.cookie })).json.sites;
  const mine = listed.find((s: Wire) => s.id === site.id);
  assert.ok(mine, "the property did not come back from /sites");

  assert.equal(mine.let, 2,
    `occupancy says ${mine.let} of the property's units are let; two are`);
  assert.equal(String(mine.rent), "100000",
    `the rent roll says ${mine.rent}; two active leases at 50000 are 100000 — ` +
    `an ENDED lease is not income and must not be counted`);
});

test("the roll-up does not leak another company's units", { skip }, async () => {
  /* It joins through units and leases, so it has to be scoped like everything
     else. A roll-up is a query, and a query that forgets its company is the
     one bug this service exists to not have. */
  const a = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });
  const b = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });

  const theirs = (await call("/sites", { method: "POST", cookie: b.cookie,
    body: { name: "Not Yours", city: "Mombasa", country: "ke", kind: "RESIDENTIAL" } })).json.site;
  await call("/units", { method: "POST", cookie: b.cookie,
    body: { siteId: theirs.id, ref: "B1", status: "OCCUPIED" } });

  const mine = (await call("/sites", { method: "POST", cookie: a.cookie,
    body: { name: "Mine", city: "Nairobi", country: "ke", kind: "RESIDENTIAL" } })).json.site;

  const listed = (await call("/sites", { cookie: a.cookie })).json.sites;
  assert.equal(listed.length, 1, "one company saw another's properties");
  assert.equal(listed[0].id, mine.id);
  assert.equal(listed[0].let, 0, "an empty property counted another company's occupied unit");
});

test("a unit says who lives in it and when they leave", { skip }, async () => {
  /*
   * Both belong to the LEASE, not the unit, so the row could not answer
   * either and every unit showed "—" in both columns. On a letting screen
   * that is the whole point missing: a unit list that cannot say who lives
   * there is a spreadsheet of door numbers.
   */
  const c = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });
  const site = (await call("/sites", { method: "POST", cookie: c.cookie,
    body: { name: "Riverside", city: "Nairobi", country: "ke", kind: "RESIDENTIAL" } })).json.site;
  const u1 = (await call("/units", { method: "POST", cookie: c.cookie,
    body: { siteId: site.id, ref: "A1", status: "OCCUPIED" } })).json.unit;
  const u2 = (await call("/units", { method: "POST", cookie: c.cookie,
    body: { siteId: site.id, ref: "A2", status: "VACANT" } })).json.unit;
  const tenant = (await call("/parties", { method: "POST", cookie: c.cookie,
    body: { name: "Grace Wanjiru" } })).json.party;

  await call("/leases", { method: "POST", cookie: c.cookie,
    body: { unitId: u1.id, tenantId: tenant.id, rent: 50000, currency: "KES",
            startsOn: "2026-01-01", endsOn: "2027-01-01", status: "ACTIVE" } });
  /* An ENDED lease on the empty unit — who USED to live there is a different
     and much worse answer to put in a column headed "Tenant". */
  await call("/leases", { method: "POST", cookie: c.cookie,
    body: { unitId: u2.id, tenantId: tenant.id, rent: 40000, currency: "KES",
            startsOn: "2020-01-01", endsOn: "2021-01-01", status: "ENDED" } });

  const units = (await call("/units", { cookie: c.cookie })).json.units;
  const a1 = units.find((u: Wire) => u.ref === "A1");
  const a2 = units.find((u: Wire) => u.ref === "A2");

  assert.equal(a1.tenantName, "Grace Wanjiru", "an occupied unit does not name its tenant");
  assert.ok(a1.leaseEndsOn, "an occupied unit does not say when the lease ends");
  assert.equal(a2.tenantName, "", "an empty unit named a tenant whose lease has ended");
});

test("a building counts its own units instead of waiting to be told", { skip }, async () => {
  /* `unitCount` is a column somebody types in, and nobody does — so a
     building with forty units read 0 on its own screen. */
  const c = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });
  const site = (await call("/sites", { method: "POST", cookie: c.cookie,
    body: { name: "Riverside", city: "Nairobi", country: "ke", kind: "RESIDENTIAL" } })).json.site;
  const b = (await call("/buildings", { method: "POST", cookie: c.cookie,
    body: { siteId: site.id, name: "Block A" } })).json.building;

  assert.equal(
    (await call("/buildings", { cookie: c.cookie })).json.buildings.find((x: Wire) => x.id === b.id).unitCount,
    0, "an empty building should count nothing yet");

  for (const [ref, status] of [["A1", "OCCUPIED"], ["A2", "OCCUPIED"], ["A3", "VACANT"]]) {
    await call("/units", { method: "POST", cookie: c.cookie,
      body: { siteId: site.id, buildingId: b.id, ref, status } });
  }

  const back = (await call("/buildings", { cookie: c.cookie })).json.buildings.find((x: Wire) => x.id === b.id);
  assert.equal(back.unitCount, 3, "the building did not count the units it holds");
  assert.equal(back.let, 2, "the building did not count how many are let");

  /* And the property agrees — the portfolio said "10 units" beside a units
     screen counting 3, which is the first thing a client notices. */
  const s = (await call("/sites", { cookie: c.cookie })).json.sites.find((x: Wire) => x.id === site.id);
  assert.equal(s.unitCount, 3, "the property and its buildings disagree about how many units exist");
  assert.equal(s.let, 2);
});
