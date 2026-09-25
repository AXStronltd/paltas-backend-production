/* ====================================================================== *
 * THE SCHEMA, AGAINST A REAL POSTGRES.
 *
 * Not "does Prisma accept the file" — does the database actually refuse the
 * things the design says it refuses. A unique index nobody has ever tried to
 * violate is a comment, not a constraint.
 *
 * Run with a Postgres available:
 *   TEST_DATABASE_URL=postgresql://… node --test test/
 * Without one, the whole file skips rather than failing, so `npm test` is
 * useful on a laptop with no database.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { connectOrExplain, freshSchema, poolInSchema } from "./db-help.ts";
import type { Wire } from "./wire.ts";

/* Reading the migrations is db-help.js's job now, so the filesystem and path
   imports this file used to need have gone with it. */
const URL_ = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

const skip = URL_ ? false : "no TEST_DATABASE_URL — skipping database tests";

/* This file's own schema. It DROPs and rebuilds on every run, so it must not
   be a schema any other test file is reading — see db-help.js. */
const SCHEMA = "test_schema";

let pool: import("pg").Pool;
let ready = false;

async function connect() {
  if (ready) return pool;
  pool = poolInSchema(pg, URL_, SCHEMA);

  /*
   * Prove the connection works BEFORE running a migration, so a
   * configuration problem reads as a configuration problem. Without this the
   * first thing that fails is a CREATE TYPE, and the natural — and entirely
   * wrong — response to that is to start editing the schema.
   */
  const probe = new pg.Client({ connectionString: URL_ });
  await connectOrExplain(probe, URL_);
  await probe.end();
  /* Rebuild from nothing on every run: a test that depends on what the last
     run left behind is a test that passes once.

     EVERY migration, in order — not just the first. A second migration that
     has never been applied in a test is a second migration nobody has run. */
  await freshSchema(pool, SCHEMA);
  ready = true;
  return pool;
}

/* `pg` rows are whatever the catalogue query selected. */
const q = (text: string, params?: unknown[]): Promise<{ rows: Wire[] }> =>
  pool.query(text, params);

/** The minimum rows a company needs, made the way POST /organizations makes them. */
async function makeCompany({ id, email, product = "HOTEL_MANAGEMENT", role = "OWNER" }: { id: Wire; email: Wire; product?: Wire; role?: Wire }) {
  await q(`INSERT INTO "User"("id","email","name","updatedAt") VALUES ($1,$2,$3,now())`,
    [`u_${id}`, email, `User ${id}`]);
  await q(`INSERT INTO "Organization"("id","name","updatedAt") VALUES ($1,$2,now())`,
    [`o_${id}`, `Company ${id}`]);
  await q(`INSERT INTO "Subscription"("id","orgId","status","updatedAt") VALUES ($1,$2,'TRIALING',now())`,
    [`s_${id}`, `o_${id}`]);
  await q(`INSERT INTO "Entitlement"("id","orgId","product") VALUES ($1,$2,$3)`,
    [`e_${id}`, `o_${id}`, product]);
  await q(`INSERT INTO "Membership"("id","userId","orgId","role") VALUES ($1,$2,$3,$4)`,
    [`m_${id}`, `u_${id}`, `o_${id}`, role]);
  await q(`INSERT INTO "Verification"("id","orgId","updatedAt") VALUES ($1,$2,now())`,
    [`v_${id}`, `o_${id}`]);
  await q(`INSERT INTO "Workspace"("id","orgId","updatedAt") VALUES ($1,$2,now())`,
    [`w_${id}`, `o_${id}`]);
  return { userId: `u_${id}`, orgId: `o_${id}` };
}

async function refuses(fn: Wire, what: Wire) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  assert.ok(threw, `the database accepted ${what} and should not have`);
  return threw;
}

test("the migration applies to an empty database", { skip }, async () => {
  await connect();
  const { rows } = await q(
    `SELECT tablename FROM pg_tables WHERE schemaname='${SCHEMA}' ORDER BY 1`);
  const names = rows.map((r) => r.tablename);
  for (const t of ["User", "Session", "Organization", "Subscription", "Entitlement",
                   "Membership", "Verification", "Workspace", "Promotion",
                   "PromotionEvent", "Counter"]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
});

test("every enum holds exactly the values the frontend reads", { skip }, async () => {
  await connect();
  const want = {
    SubscriptionStatus: ["TRIALING", "ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED"],
    VerificationStatus: ["NOT_STARTED", "PENDING", "ADDITIONAL_INFORMATION_REQUIRED",
                         "REJECTED", "COMPLETE"],
    Product: ["PROPERTY_MANAGEMENT", "AGENT_HOST", "HOTEL_MANAGEMENT",
              "SECURITY_MANAGEMENT", "GUEST_PORTAL", "PLATFORM"],
    PromotionStatus: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED",
                      "RESUBMITTED", "MARKETING_APPROVED", "FINAL_APPROVED",
                      "SCHEDULED", "PUBLISHED", "PAUSED", "EXPIRED", "REJECTED"],
  };
  for (const [type, values] of Object.entries(want)) {
    /*
     * THE NAMESPACE FILTER IS NOT OPTIONAL. Every test file that needs a
     * database builds the whole schema in one of its own, so `SubscriptionStatus`
     * exists several times over in this server. Without `nspname` this asked
     * for all of them at once and compared four copies against five values.
     */
    const { rows } = await q(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE t.typname = $1 AND n.nspname = '${SCHEMA}'
       ORDER BY e.enumsortorder`, [type]);
    assert.deepEqual(rows.map((r) => r.enumlabel), values, `${type} does not match`);
  }
});

test("a role the frontend knows about is a role the database accepts", { skip }, async () => {
  await connect();
  const { rows } = await q(
    `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE t.typname = 'Role' AND n.nspname = '${SCHEMA}'`);
  const have = new Set(rows.map((r) => r.enumlabel));
  /* The three that carry the promotion workflow, and the narrow contributor
     role. If any of these is missing, a person cannot be given their job. */
  for (const r of ["MARKETING", "COMPLIANCE", "PUBLISHER", "PROMO_CONTRIBUTOR",
                   "GM", "FRONT_DESK", "HOUSEKEEPING", "ENGINEERING", "FNB", "GUEST", "GUARD"]) {
    assert.ok(have.has(r), `Role enum is missing ${r}`);
  }
});

test("a company cannot hold the same product twice", { skip }, async () => {
  await connect();
  await makeCompany({ id: "dup", email: "dup@example.com" });
  await refuses(
    () => q(`INSERT INTO "Entitlement"("id","orgId","product") VALUES ('e_dup2','o_dup','HOTEL_MANAGEMENT')`),
    "a second HOTEL_MANAGEMENT entitlement for one company");

  /* A different product is fine — that is a company with two consoles. */
  await q(`INSERT INTO "Entitlement"("id","orgId","product") VALUES ('e_dup3','o_dup','AGENT_HOST')`);
  const { rows } = await q(`SELECT count(*)::int n FROM "Entitlement" WHERE "orgId"='o_dup'`);
  assert.equal(rows[0].n, 2);
});

test("a person cannot be a member of one company twice", { skip }, async () => {
  await connect();
  await makeCompany({ id: "mem", email: "mem@example.com" });
  await refuses(
    () => q(`INSERT INTO "Membership"("id","userId","orgId","role") VALUES ('m_mem2','u_mem','o_mem','MANAGER')`),
    "a second membership in the same company");
});

test("two promotions cannot share a reference", { skip }, async () => {
  await connect();
  const { userId, orgId } = await makeCompany({ id: "ref", email: "ref@example.com" });
  const ins = (id: Wire, ref: Wire) => q(
    `INSERT INTO "Promotion"("id","ref","orgId","createdById","updatedAt") VALUES ($1,$2,$3,$4,now())`,
    [id, ref, orgId, userId]);
  await ins("p1", "PR-0001");
  await refuses(() => ins("p2", "PR-0001"), "a duplicate promotion reference");
});

test("deleting a company takes its promotions with it, and nothing else's", { skip }, async () => {
  await connect();
  const a = await makeCompany({ id: "ca", email: "ca@example.com" });
  const b = await makeCompany({ id: "cb", email: "cb@example.com" });
  await q(`INSERT INTO "Promotion"("id","ref","orgId","createdById","updatedAt")
           VALUES ('pa','PR-A',$1,$2,now()), ('pb','PR-B',$3,$4,now())`,
    [a.orgId, a.userId, b.orgId, b.userId]);
  await q(`INSERT INTO "PromotionEvent"("id","promotionId","what","status")
           VALUES ('ea','pa','created','DRAFT')`);

  await q(`DELETE FROM "Organization" WHERE id=$1`, [a.orgId]);

  const gone = await q(`SELECT count(*)::int n FROM "Promotion" WHERE id='pa'`);
  assert.equal(gone.rows[0].n, 0, "the deleted company's promotion survived");
  const events = await q(`SELECT count(*)::int n FROM "PromotionEvent" WHERE id='ea'`);
  assert.equal(events.rows[0].n, 0, "its history survived");
  const other = await q(`SELECT count(*)::int n FROM "Promotion" WHERE id='pb'`);
  assert.equal(other.rows[0].n, 1, "another company's promotion was deleted too");
});

test("deleting a person does NOT delete the promotions they wrote", { skip }, async () => {
  await connect();
  const { userId, orgId } = await makeCompany({ id: "auth", email: "auth@example.com" });
  await q(`INSERT INTO "Promotion"("id","ref","orgId","createdById","updatedAt")
           VALUES ('pz','PR-Z',$1,$2,now())`, [orgId, userId]);

  /* RESTRICT. A trading company's promotions must not vanish because somebody
     left and their account was tidied up. */
  await refuses(() => q(`DELETE FROM "User" WHERE id=$1`, [userId]),
    "deleting the author of a live promotion");
});

test("a reviewer leaving does not erase who made the decision", { skip }, async () => {
  await connect();
  const { userId, orgId } = await makeCompany({ id: "rev", email: "rev@example.com" });
  await q(`INSERT INTO "User"("id","email","name","updatedAt")
           VALUES ('u_gone','gone@paltas.io','Grace Wambui',now())`);
  await q(`INSERT INTO "Promotion"("id","ref","orgId","createdById","updatedAt")
           VALUES ('pr','PR-R',$1,$2,now())`, [orgId, userId]);
  await q(`INSERT INTO "PromotionEvent"("id","promotionId","what","why","status","byId","byName")
           VALUES ('er','pr','changes requested','Please remove the claim.','CHANGES_REQUESTED','u_gone','Grace Wambui')`);

  await q(`DELETE FROM "User" WHERE id='u_gone'`);

  const { rows } = await q(`SELECT "byId","byName","why" FROM "PromotionEvent" WHERE id='er'`);
  assert.equal(rows[0].byId, null, "the relation should be cleared");
  assert.equal(rows[0].byName, "Grace Wambui", "the name should survive");
  assert.equal(rows[0].why, "Please remove the claim.", "the message should survive");
});

test("the promotion counter cannot hand out the same number twice", { skip }, async () => {
  await connect();
  await q(`DELETE FROM "Counter" WHERE name='promotion'`);

  /* Twenty concurrent increments. If this used count()+1 they would collide;
     an atomic UPDATE … RETURNING cannot. */
  const bump = () => q(
    `INSERT INTO "Counter"("name","value") VALUES ('promotion',1)
     ON CONFLICT ("name") DO UPDATE SET "value" = "Counter"."value" + 1
     RETURNING "value"`);
  const results = await Promise.all(Array.from({ length: 20 }, bump));
  const values = results.map((r) => r.rows[0].value).sort((a, b) => a - b);
  assert.deepEqual(values, Array.from({ length: 20 }, (_, i) => i + 1),
    "the counter handed out a duplicate or skipped a number");
});

test("the public feed's index is the one the query uses", { skip }, async () => {
  await connect();
  const { rows } = await q(
    `SELECT indexname FROM pg_indexes
      WHERE tablename='Promotion' AND schemaname='${SCHEMA}'`);
  const names = rows.map((r) => r.indexname);
  assert.ok(names.includes("Promotion_status_startDate_endDate_idx"),
    "the public feed has no index to use");
});

test.after(async () => { if (pool) await pool.end(); });
