/* ====================================================================== *
 * THE RELATIONSHIP LAYER.
 *
 * PALTAS already had the CRM entities — Party with nine kinds, Lead, Deal,
 * Viewing, Offer, Reservation, Contract, Meeting, Task, Campaign, Message, all
 * as registry resources, org-scoped and audited. What it did not have were the
 * links that make them a relationship system:
 *
 *   a lead could not become a client   (Lead had no partyId)
 *   a lead could not be telephoned     (no email, no phone)
 *   nothing was assigned to anybody    (no owner on client, lead or deal)
 *   there was no next action           (no follow-up date anywhere)
 *
 * These test those links, and Client 360 — which assembles a relationship from
 * the systems that own each part and stores nothing of its own.
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
const SCHEMA = "test_crm";

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
      name: `CRM Co ${n}`, country,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      /*
       * BOTH PRODUCTS, because the CRM pipeline is gated behind AGENT_HOST:
       * leads, deals, viewings and messages all sit in the `agent` area, so a
       * pure property-management company is refused them outright. Whether
       * Almas should hold that entitlement is a commercial decision and not
       * one a test may make — this grants it so the CRM can be tested at all.
       */
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }, { product: "AGENT_HOST" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `crm${n}@example.com`, name: `Person ${n}`, orgId: org.id,
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


let C: typeof import("../src/domain/client360.ts");
let CC: typeof import("../src/domain/command-centre.ts");
if (!skip) {
  C = await import("../src/domain/client360.ts");
  CC = await import("../src/domain/command-centre.ts");
}

const client = (orgId: string, over: Record<string, unknown> = {}) =>
  db.party.create({ data: { orgId, name: "Grace Wanjiru", kind: "TENANT", ...over } });

/* ====================================================================== *
 * A LEAD CAN BECOME A CLIENT
 * ====================================================================== */

test("a lead carries contact details and can be telephoned", { skip }, async () => {
  const { cookie } = await company();
  const made = await call("/leads", { method: "POST", cookie, body: {
    name: "Peter Kamau", email: "peter@example.com", phone: "+254700000000",
    wants: "2 bed, Kilimani", budget: 13500000, source: "Walk-in" } });
  assert.equal(made.status, 201, made.text.slice(0, 200));
  assert.equal(made.json.lead.email, "peter@example.com");
  assert.equal(made.json.lead.phone, "+254700000000");
});

/* THE LINK THAT DID NOT EXIST. */
test("a lead can be attached to the client it became", { skip }, async () => {
  const { org, cookie } = await company();
  const party = await client(org.id, { name: "Peter Kamau", kind: "BUYER" });
  const lead = await call("/leads", { method: "POST", cookie,
    body: { name: "Peter Kamau", source: "Walk-in" } });

  const linked = await call(`/leads/${lead.json.lead.id}`, {
    method: "PATCH", cookie, body: { partyId: party.id } });
  assert.equal(linked.status, 200, linked.text.slice(0, 200));

  /* And the client can now be asked where they came from. */
  const three60 = await C.client360(db, { orgId: org.id, partyId: party.id, money: true });
  assert.equal(three60!.leads.length, 1);
  assert.equal(three60!.leads[0]!.source, "Walk-in");
  assert.equal(three60!.relationship.lead, true);
});

test("the pipeline has the stages a pipeline actually has", { skip }, async () => {
  const { cookie } = await company();
  const made = await call("/leads", { method: "POST", cookie, body: { name: "A" } });
  for (const stage of ["CONTACTED", "QUALIFIED", "VIEWING", "NEGOTIATION"]) {
    const moved = await call(`/leads/${made.json.lead.id}`, {
      method: "PATCH", cookie, body: { stage } });
    assert.equal(moved.status, 200, `${stage}: ${moved.text.slice(0, 120)}`);
    /* Persisted, not merely shown. */
    const back = await call(`/leads/${made.json.lead.id}`, { cookie });
    assert.equal(back.json.lead.stage, stage);
  }
});

test("a stage PALTAS does not have is refused", { skip }, async () => {
  const { cookie } = await company();
  const made = await call("/leads", { method: "POST", cookie, body: { name: "A" } });
  const bad = await call(`/leads/${made.json.lead.id}`, {
    method: "PATCH", cookie, body: { stage: "ALMOST" } });
  assert.ok(bad.status >= 400);
});

/* ====================================================================== *
 * SOMEBODY OWNS THE RELATIONSHIP
 * ====================================================================== */

test("a client, a lead and an opportunity can each be assigned", { skip }, async () => {
  const { org, user, cookie } = await company();
  const party = await client(org.id);

  for (const [path, id] of [
    ["/parties", party.id],
    ["/leads", (await call("/leads", { method: "POST", cookie, body: { name: "L" } })).json.lead.id],
    ["/deals", (await call("/deals", { method: "POST", cookie, body: { name: "D" } })).json.deal.id],
  ] as const) {
    const res = await call(`${path}/${id}`, {
      method: "PATCH", cookie, body: { assignedToId: user.id } });
    assert.equal(res.status, 200, `${path}: ${res.text.slice(0, 150)}`);
  }

  const after = await db.party.findUnique({ where: { id: party.id } });
  assert.equal(after!.assignedToId, user.id);
});

/*
 * A member of staff leaving must not delete the clients they looked after.
 * SetNull is the whole reason the column is not a Cascade.
 */
test("removing a member of staff keeps their clients", { skip }, async () => {
  const { org, user, cookie } = await company();
  const party = await client(org.id);
  await call(`/parties/${party.id}`, { method: "PATCH", cookie,
    body: { assignedToId: user.id } });

  await db.user.delete({ where: { id: user.id } });

  const after = await db.party.findUnique({ where: { id: party.id } });
  assert.ok(after, "the client is still here");
  assert.equal(after!.assignedToId, null, "just no longer assigned to anybody");
});

/* ====================================================================== *
 * FOLLOW-UPS REACH THE PERSON WHO OWES THEM
 * ====================================================================== */

test("a follow-up that has come due appears in the command centre", { skip }, async () => {
  const { org, cookie } = await company();
  const party = await client(org.id, { name: "Grace Wanjiru" });
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await call(`/parties/${party.id}`, { method: "PATCH", cookie,
    body: { nextFollowUpOn: yesterday } });

  const cc = await CC.commandCentre(db, { orgId: org.id, money: true });
  const item = cc.attention.find((a) => a.kind === "follow-up-due");
  assert.ok(item, `nothing raised: ${JSON.stringify(cc.attention)}`);
  assert.match(item!.what, /Grace Wanjiru/);
  assert.equal(item!.entityId, party.id, "it names the record");
});

test("a lead's follow-up appears too, unless the lead is closed", { skip }, async () => {
  const { org, cookie } = await company();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const live = await call("/leads", { method: "POST", cookie, body: { name: "Live lead" } });
  await call(`/leads/${live.json.lead.id}`, { method: "PATCH", cookie,
    body: { nextFollowUpOn: yesterday, stage: "QUALIFIED" } });
  const dead = await call("/leads", { method: "POST", cookie, body: { name: "Lost lead" } });
  await call(`/leads/${dead.json.lead.id}`, { method: "PATCH", cookie,
    body: { nextFollowUpOn: yesterday, stage: "LOST" } });

  const cc = await CC.commandCentre(db, { orgId: org.id, money: true });
  const items = cc.attention.filter((a) => a.kind === "lead-follow-up-due");
  assert.equal(items.length, 1, "a lost lead is not chased");
  assert.match(items[0]!.what, /Live lead/);
});

test("a follow-up in the future is not yet due", { skip }, async () => {
  const { org, cookie } = await company();
  const party = await client(org.id);
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await call(`/parties/${party.id}`, { method: "PATCH", cookie,
    body: { nextFollowUpOn: nextWeek } });

  const cc = await CC.commandCentre(db, { orgId: org.id, money: true });
  assert.equal(cc.attention.filter((a) => a.kind === "follow-up-due").length, 0);
});

/* ====================================================================== *
 * CLIENT 360
 * ====================================================================== */

test("a client's relationship is counted, not declared", { skip }, async () => {
  const { org } = await company();
  const party = await client(org.id, { kind: "CONTACT" });   /* recorded as a plain contact */
  const unit = await db.unit.create({ data: { orgId: org.id, ref: "A-101" } });
  await db.lease.create({ data: { orgId: org.id, ref: "L-1", tenantId: party.id,
    unitId: unit.id, status: "ACTIVE", rent: 13500000n } });

  const out = await C.client360(db, { orgId: org.id, partyId: party.id, money: true });
  assert.equal(out!.party.kind, "CONTACT", "the column still says contact");
  assert.equal(out!.relationship.tenant, true, "but they hold a live lease, so they are a tenant");
  assert.equal(out!.relationship.activeLeases, 1);
  assert.equal(out!.leases.length, 1);
});

test("a client's arrears are finance's figure, not a second one", { skip }, async () => {
  const { org, cookie } = await company();
  const party = await client(org.id);
  const inv = await call("/invoices", { method: "POST", cookie,
    body: { partyId: party.id, dueOn: "2026-08-01" } });
  await call(`/invoices/${inv.json.invoice.id}/lines`, { method: "POST", cookie,
    body: { detail: "Rent", quantity: 1, unitPrice: 13500000 } });
  await call(`/invoices/${inv.json.invoice.id}`, { method: "PATCH", cookie,
    body: { status: "SENT" } });

  const out = await C.client360(db, { orgId: org.id, partyId: party.id, money: true });
  assert.equal(out!.finance!.arrears[0]!.outstanding, "13500000");

  /* The same number Collections shows for that client. */
  const ar = await call(`/ledger/receivables?partyId=${party.id}`, { cookie });
  assert.equal(ar.json.books[0].open, out!.finance!.arrears[0]!.outstanding);
});

test("a role that may not see money gets a client with no finance", { skip }, async () => {
  const { org } = await company();
  const party = await client(org.id);
  const out = await C.client360(db, { orgId: org.id, partyId: party.id, money: false });
  assert.equal(out!.finance, null);
  assert.ok(out!.party.name, "but the relationship is still there");
});

test("a client's history is the audit trail, and includes their records", { skip }, async () => {
  const { org, cookie } = await company();
  const party = await client(org.id);
  await call("/invoices", { method: "POST", cookie, body: { partyId: party.id } });

  const out = await C.client360(db, { orgId: org.id, partyId: party.id, money: true });
  assert.ok(out!.activity.length > 0, "something is recorded");
  assert.ok(out!.activity.every((a) => typeof a.entity === "string"));
});

test("another company's client is hidden, not reported missing", { skip }, async () => {
  const a = await company();
  const b = await company();
  const party = await client(a.org.id);

  const out = await C.client360(db, { orgId: b.org.id, partyId: party.id, money: true });
  assert.equal(out, null);

  const res = await call(`/clients/${party.id}/360`, { cookie: b.cookie });
  assert.equal(res.status, 404, "whether it exists is not their business");
});

test("a client with nothing yet reads as empty, not broken", { skip }, async () => {
  const { org } = await company();
  const party = await client(org.id);
  const out = await C.client360(db, { orgId: org.id, partyId: party.id, money: true });
  assert.deepEqual(out!.leases, []);
  assert.deepEqual(out!.offers, []);
  assert.equal(out!.relationship.tenant, false);
  assert.equal(out!.finance!.openInvoices, 0);
});

/*
 * A CLIENT CANNOT BE ASSIGNED TO SOMEBODY IN ANOTHER COMPANY.
 *
 * This is what checking a user reference by MEMBERSHIP buys. The previous
 * clause filtered User by an `orgId` column that does not exist, so the check
 * threw rather than refusing — every `id:user` field answered 500 the first
 * time anybody set it, and two existed before the CRM added more.
 */
test("a client cannot be assigned to another company's staff", { skip }, async () => {
  const a = await company();
  const b = await company();
  const party = await client(a.org.id);

  const res = await call(`/parties/${party.id}`, {
    method: "PATCH", cookie: a.cookie, body: { assignedToId: b.user.id } });
  assert.ok(res.status >= 400 && res.status < 500,
    `expected a refusal, got ${res.status}: ${res.text.slice(0, 150)}`);

  const after = await db.party.findUnique({ where: { id: party.id } });
  assert.equal(after!.assignedToId, null, "and nobody was assigned");
});

test("a user reference that does not exist is refused, not a 500", { skip }, async () => {
  const { org, cookie } = await company();
  const party = await client(org.id);
  const res = await call(`/parties/${party.id}`, {
    method: "PATCH", cookie, body: { assignedToId: "nobody" } });
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
});

/* ====================================================================== *
 * A DOCUMENT CAN SAY WHOSE IT IS
 * ====================================================================== */

/*
 * `about` was free text, so "this client's documents" could only be guessed at
 * by matching a name — which shows one client's identity document under
 * another client's name on a screen somebody reads to a customer.
 */
test("a client's documents are theirs, asked of the database", { skip }, async () => {
  const { org, cookie } = await company();
  const mine = await client(org.id, { name: "Grace Wanjiru" });
  const theirs = await client(org.id, { name: "Grace Wanjeri" });   /* very nearly the same name */

  const made = await call("/documents", { method: "POST", cookie, body: {
    name: "National ID", kind: "IDENTITY", partyId: mine.id } });
  assert.equal(made.status, 201, made.text.slice(0, 200));
  await call("/documents", { method: "POST", cookie, body: {
    name: "National ID", kind: "IDENTITY", partyId: theirs.id } });

  const out = await C.client360(db, { orgId: org.id, partyId: mine.id, money: true });
  assert.equal(out!.documents.length, 1, "one document, not two nearly-identical names");
  assert.equal(out!.documents[0]!.id, made.json.document.id);
  assert.equal(out!.documents[0]!.name, "National ID");
});

test("a document about a property belongs to nobody, and stays that way", { skip }, async () => {
  const { org, cookie } = await company();
  const party = await client(org.id);
  await call("/documents", { method: "POST", cookie, body: {
    name: "Title deed", kind: "OTHER", about: "Almas Tower" } });

  const out = await C.client360(db, { orgId: org.id, partyId: party.id, money: true });
  assert.deepEqual(out!.documents, [],
    "`about` is still the right column for a subject that is not a person");
});

/* Removing a contact must not delete their signed lease. */
test("removing a client keeps their documents", { skip }, async () => {
  const { org, cookie } = await company();
  const party = await client(org.id);
  const doc = await call("/documents", { method: "POST", cookie, body: {
    name: "Signed lease", kind: "LEASE", partyId: party.id } });

  await db.party.delete({ where: { id: party.id } });

  const after = await db.document.findUnique({ where: { id: doc.json.document.id } });
  assert.ok(after, "the document is still here");
  assert.equal(after!.partyId, null, "just no longer attached to anybody");
});

test("a document cannot be attached to another company's client", { skip }, async () => {
  const a = await company();
  const b = await company();
  const theirs = await client(b.org.id);
  const res = await call("/documents", { method: "POST", cookie: a.cookie, body: {
    name: "X", kind: "OTHER", partyId: theirs.id } });
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
});
