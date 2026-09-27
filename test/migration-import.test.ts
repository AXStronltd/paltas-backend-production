/* ======================================================================
 * MIGRATION: THE FOUNDATION THAT DECIDES WHETHER ANYBODY GOES LIVE.
 *
 * A property company arriving with 200 units, 180 tenants and 180 leases
 * in a spreadsheet faced about 560 forms before this existed. The tests
 * that matter here are not the happy path — it is the ones about what
 * happens when the file is wrong, because the first attempt always is:
 *
 *   · all or nothing, so nobody is left half-migrated;
 *   · a preview that cannot differ from the commit;
 *   · an existing record is never overwritten, because the client WILL
 *     run the file again after fixing it;
 *   · two tenants with the same name are never merged into one.
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
const skip = DB ? false : "no TEST_DATABASE_URL — skipping migration tests";

const SCHEMA = "migration_test";
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

async function company(role: import("@prisma/client").$Enums.Role = "OWNER") {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Move ${n} Ltd`, country: "ke",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const email = `move${n}@example.test`;
  const user = await db.user.create({
    data: { email, name: `Person ${n}`, googleSub: "sub_" + email },
  });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
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

const UNIT = (ref: string, over: Record<string, unknown> = {}) =>
  ({ kind: "unit", ref, rent: "45000.00", currency: "KES", ...over });
const TENANT = (name: string, email = "", over: Record<string, unknown> = {}) =>
  ({ kind: "tenant", name, email, ...over });
const LEASE = (ref: string, unitRef: string, over: Record<string, unknown> = {}) =>
  ({ kind: "lease", ref, unitRef, rent: "45000.00", deposit: "90000.00",
     startsOn: "2026-01-01", endsOn: "2026-12-31", tenantName: "A Tenant", ...over });

const preview = (cookie: string, rows: unknown[]) =>
  call("/organizations/migration/preview", { method: "POST", cookie, body: { rows } });
const commit = (cookie: string, rows: unknown[]) =>
  call("/organizations/migration/commit", { method: "POST", cookie, body: { rows } });

/* ==================================================================== *
 * THE WHOLE CHAIN, IN ONE FILE.
 * ==================================================================== */

test("units, tenants and leases arrive together and are linked", { skip }, async () => {
  const { cookie, org } = await company();

  const rows = [
    UNIT("A-101"), UNIT("A-102"),
    TENANT("Wanjiru Kamau", "wanjiru@example.test"),
    LEASE("LSE-1", "A-101", { tenantEmail: "wanjiru@example.test", tenantName: "Wanjiru Kamau" }),
  ];

  const shown = await preview(cookie, rows);
  assert.equal(shown.status, 200, shown.text.slice(0, 240));
  assert.equal(shown.json.created, 4, "all four rows should be new");
  assert.equal(shown.json.clean, true);
  assert.equal(await db.unit.count({ where: { orgId: org.id } }), 0,
    "*** the preview wrote to the database ***");

  const done = await commit(cookie, rows);
  assert.equal(done.status, 201, done.text.slice(0, 240));
  assert.equal(done.json.created, 4);

  assert.equal(await db.unit.count({ where: { orgId: org.id } }), 2);
  assert.equal(await db.party.count({ where: { orgId: org.id, kind: "TENANT" } }), 1);

  /* The lease must be JOINED to its unit and tenant, not merely carry their
     names as text — otherwise the rent roll cannot find it. */
  const lease = present(
    await db.lease.findFirst({ where: { orgId: org.id }, include: { unit: true, tenant: true } }),
    "no lease");
  assert.equal(lease.unit?.ref, "A-101", "*** the lease was not linked to its unit ***");
  assert.equal(lease.tenant?.email, "wanjiru@example.test",
    "*** the lease was not linked to its tenant ***");
  assert.equal(lease.rent, 4_500_000n, "45,000.00 should be 4,500,000 minor units");
});

test("a lease may reference a unit created in the same file", { skip }, async () => {
  const { cookie, org } = await company();
  /* Deliberately lease-before-unit: a spreadsheet's sheets are in whatever
     order the client's system exported them. */
  const done = await commit(cookie, [LEASE("LSE-9", "B-200"), UNIT("B-200")]);
  assert.equal(done.status, 201, done.text.slice(0, 240));
  const lease = present(
    await db.lease.findFirst({ where: { orgId: org.id }, include: { unit: true } }), "no lease");
  assert.equal(lease.unit?.ref, "B-200",
    "a lease could not reach a unit that the same import was creating");
});

test("an imported lease does not occupy its unit until somebody looks", { skip }, async () => {
  const { cookie, org } = await company();
  await commit(cookie, [UNIT("C-1"), LEASE("LSE-C", "C-1")]);

  const unit = present(await db.unit.findFirst({ where: { orgId: org.id } }), "no unit");
  assert.equal(unit.status, "VACANT",
    "*** the import filled a building on its own. Nothing is left for the client " +
    "to check against their own records, and the vacancy figure changed before " +
    "anybody confirmed the data. ***");
  const lease = present(await db.lease.findFirst({ where: { orgId: org.id } }), "no lease");
  assert.equal(lease.status, "DRAFT", "an imported lease should arrive as a draft");
});

/* ==================================================================== *
 * ALL OR NOTHING.
 * ==================================================================== */

test("one bad row stops the whole import", { skip }, async () => {
  const { cookie, org } = await company();
  const done = await commit(cookie, [
    UNIT("D-1"), UNIT("D-2"),
    UNIT("", { ref: "" }),          /* no reference */
    UNIT("D-3"),
  ]);
  assert.equal(done.status, 400,
    "*** the good rows went in and the bad one did not, so the client now has a " +
    "half-migrated company and no way to tell which half ***");
  assert.match(String(done.json.message), /none were/i);
  assert.equal(await db.unit.count({ where: { orgId: org.id } }), 0);
});

test("the preview names every row that cannot be imported, not just the first", { skip }, async () => {
  const { cookie } = await company();
  const shown = await preview(cookie, [
    UNIT("E-1"),
    UNIT("", { ref: "" }),
    UNIT("E-2", { rent: "not a number" }),
    { kind: "spaceship", ref: "X" },
  ]);
  assert.equal(shown.json.refused, 3, "a client fixing a file one error at a time gives up");
  assert.equal(shown.json.clean, false);
  const refused = shown.json.rows.filter((r: Wire) => r.outcome === "refuse");
  assert.ok(refused.every((r: Wire) => r.why), "every refusal should say why");
  assert.ok(refused.every((r: Wire) => r.line), "and which line of their file it was");
  assert.match(String(refused[2].why), /spaceship/,
    "the refusal should quote back what it did not understand");
});

/* ==================================================================== *
 * THE CLIENT WILL RUN IT AGAIN.
 * ==================================================================== */

test("running the same file twice adds nothing the second time", { skip }, async () => {
  const { cookie, org } = await company();
  const rows = [UNIT("F-1"), TENANT("Otieno Were", "otieno@example.test"), LEASE("LSE-F", "F-1")];

  assert.equal((await commit(cookie, rows)).json.created, 3);
  const again = await commit(cookie, rows);
  assert.equal(again.status, 201, again.text.slice(0, 240));
  assert.equal(again.json.created, 0, "*** a second run duplicated the company ***");
  assert.equal(again.json.skipped, 3);

  assert.equal(await db.unit.count({ where: { orgId: org.id } }), 1);
  assert.equal(await db.lease.count({ where: { orgId: org.id } }), 1);
  assert.equal(await db.party.count({ where: { orgId: org.id } }), 1);
});

test("an existing record is never overwritten by a re-run", { skip }, async () => {
  const { cookie, org } = await company();
  await commit(cookie, [UNIT("G-1", { rent: "45000.00" })]);

  /* Somebody corrects the rent in the console. */
  await db.unit.updateMany({ where: { orgId: org.id, ref: "G-1" }, data: { rent: 5_000_000n } });

  /* Then the client re-runs the original file, which still has the old rent. */
  const again = await commit(cookie, [UNIT("G-1", { rent: "45000.00" })]);
  assert.equal(again.json.skipped, 1);

  const unit = present(await db.unit.findFirst({ where: { orgId: org.id } }), "no unit");
  assert.equal(unit.rent, 5_000_000n,
    "*** a re-run overwrote a correction somebody had made in the console ***");
});

test("the same reference twice in one file is refused, not silently deduplicated", { skip }, async () => {
  const { cookie } = await company();
  const shown = await preview(cookie, [UNIT("H-1"), UNIT("H-1", { rent: "99000.00" })]);
  assert.equal(shown.json.refused, 1,
    "two rows for one unit with different rents is a mistake in the file, and " +
    "choosing one of them silently picks a number nobody chose");
  assert.match(String(shown.json.rows[1].why), /twice in the file/i);
});

/* ==================================================================== *
 * TWO PEOPLE ARE NOT ONE PERSON.
 * ==================================================================== */

test("two tenants with the same name and no email stay two people", { skip }, async () => {
  const { cookie, org } = await company();
  const done = await commit(cookie, [TENANT("John Kamau"), TENANT("John Kamau")]);
  assert.equal(done.status, 201, done.text.slice(0, 240));
  assert.equal(await db.party.count({ where: { orgId: org.id } }), 2,
    "*** two tenants who happen to share a name were merged into one. Two rows a " +
    "human can merge is a minute's work; one record for two people is a lease " +
    "billed to the wrong person. ***");
  assert.ok(done.json.rows.every((r: Wire) => !r.why || /new person/i.test(String(r.why))),
    "a row that could not be matched should say so rather than passing silently");
});

test("a tenant already on file is matched by email, not duplicated", { skip }, async () => {
  const { cookie, org } = await company();
  await db.party.create({
    data: { orgId: org.id, name: "Existing Person", email: "here@example.test", kind: "TENANT" },
  });
  const done = await commit(cookie, [TENANT("Spelled Differently", "here@example.test")]);
  assert.equal(done.json.skipped, 1, "an email already on file should match");
  assert.equal(await db.party.count({ where: { orgId: org.id } }), 1);
});

/* ==================================================================== *
 * A LEASE CANNOT POINT AT NOTHING.
 * ==================================================================== */

test("a lease whose unit is nowhere is refused, and says so", { skip }, async () => {
  const { cookie } = await company();
  const shown = await preview(cookie, [LEASE("LSE-X", "NO-SUCH-UNIT")]);
  assert.equal(shown.json.refused, 1);
  assert.match(String(shown.json.rows[0].why), /No unit NO-SUCH-UNIT/,
    "the refusal should name the unit it could not find");
  assert.match(String(shown.json.rows[0].why), /not in this file either/,
    "and say that it looked in the file as well as the database");
});

test("a lease that ends before it starts is refused", { skip }, async () => {
  const { cookie } = await company();
  const shown = await preview(cookie, [
    UNIT("I-1"),
    LEASE("LSE-I", "I-1", { startsOn: "2026-06-01", endsOn: "2026-01-01" }),
  ]);
  assert.equal(shown.json.refused, 1);
  assert.match(String(shown.json.rows[1].why), /ends before it starts/i);
});

/* ==================================================================== *
 * WHOSE COMPANY IS BEING MIGRATED, AND WHO MAY DO IT.
 * ==================================================================== */

test("an import only ever writes to the caller's own company", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  await commit(mine.cookie, [UNIT("J-1")]);
  assert.equal(await db.unit.count({ where: { orgId: theirs.org.id } }), 0,
    "*** one company's import reached another company ***");
  assert.equal(await db.unit.count({ where: { orgId: mine.org.id } }), 1);
});

test("adding one unit is not the same right as replacing the inventory", { skip }, async () => {
  /* OPERATIONS holds property at write — it may create a unit. An import
     writes hundreds at once, so it wants full control of the area. */
  const { cookie } = await company("OPERATIONS");
  const tried = await commit(cookie, [UNIT("K-1")]);
  assert.equal(tried.status, 403, "operations replaced a company's inventory");
  assert.match(String(tried.json.message), /full control/i,
    "the refusal should explain the distinction, not merely refuse");
});

test("an import is on the record, as one act with its counts", { skip }, async () => {
  const { cookie, org } = await company();
  await commit(cookie, [UNIT("L-1"), UNIT("L-2"), TENANT("Someone", "someone@example.test")]);

  const trail = await db.auditEvent.findMany({
    where: { orgId: org.id, action: "organization.migration" },
  });
  assert.equal(trail.length, 1,
    "an import is one decision somebody made; four hundred rows in the trail " +
    "would bury the day it happened");
  const detail = present(trail[0], "no row").detail as Wire;
  assert.equal(detail.created, 3, "the trail should say how much came in");
  assert.equal(detail.rows, 3);
});
