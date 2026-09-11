/* ====================================================================== *
 * DOES THE MIGRATION ACTUALLY BUILD THE SCHEMA IT CLAIMS TO?
 *
 * Two files describe this database. `schema.prisma` is what the application
 * code believes; `prisma/migrations/*.sql` is what the database is actually
 * made of. Normally Prisma generates the second from the first and they
 * cannot disagree.
 *
 * Here they can. The schema engine is downloaded from binaries.prisma.sh,
 * this environment cannot reach that host, and so the migrations were
 * written out by hand from the schema. That is a perfectly ordinary way to
 * work — plenty of teams hand-write migrations — but it has one failure
 * mode, and it is nasty:
 *
 *     A column that exists in schema.prisma and not in the migration
 *     produces working code, a green unit-test run, and a 500 on the first
 *     real request, in production, because Prisma writes a column the
 *     database has never heard of.
 *
 * So the migrations are run against a real PostgreSQL and the resulting
 * database is compared to the schema, field by field, index by index, key
 * by key. Every disagreement is a failure, in both directions: a column the
 * migration forgot, and a column the migration invented.
 *
 * Requires a database:
 *   TEST_DATABASE_URL=postgresql://… npm test
 * Without one this file skips, like the others.
 *
 * IT STILL IS NOT `npx prisma migrate status`. Run that too, on a machine
 * with internet, before deploying. This catches the mistakes a parser can
 * see; Prisma is the authority on the rest.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { connectOrExplain, freshSchema, poolInSchema } from "./db-help.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const skip = URL_ ? false : "no TEST_DATABASE_URL — skipping migration tests";

/* This file's own schema. It DROPs and rebuilds on every run, so it must not
   be a schema any other test file is reading — see db-help.js. */
const SCHEMA = "test_migration";

const schema = readFileSync(join(HERE, "..", "prisma", "schema.prisma"), "utf8");

/* ---------------------------------------------------------------- *
 * The schema side.
 * ---------------------------------------------------------------- */

function uncomment(t) {
  return t.replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const MODELS = new Map(
  [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => [m[1], uncomment(m[2])])
);
const ENUMS = new Map(
  [...schema.matchAll(/^enum (\w+) \{([\s\S]*?)\}/gm)]
    .map((m) => [m[1], uncomment(m[2]).split(/\s+/).filter(Boolean)])
);

/** Prisma's scalar types, mapped the way its PostgreSQL connector maps them. */
const SQL_TYPE = {
  String: "text", Int: "integer", BigInt: "bigint", Float: "double precision",
  Boolean: "boolean", DateTime: "timestamp without time zone", Json: "jsonb",
  Decimal: "numeric", Bytes: "bytea",
};

function fieldsOf(body) {
  const out = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("@@")) continue;
    const m = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
    if (!m) continue;
    const [, name, type, mod = "", rest = ""] = m;
    const args = rest.match(/@relation\(([^)]*)\)/)?.[1] ?? null;
    out.push({
      name, type, list: mod === "[]", optional: mod === "?", rest,
      relFields: args?.match(/fields:\s*\[([^\]]*)\]/)?.[1] ?? null,
      onDelete: args?.match(/onDelete:\s*(\w+)/)?.[1] ?? null,
    });
  }
  return out;
}

const attrs = (body, kind) =>
  [...body.matchAll(new RegExp(`@@${kind}\\(\\[([^\\]]*)\\]\\)`, "g"))]
    .map((m) => m[1].split(",").map((s) => s.trim()));

/* ---------------------------------------------------------------- *
 * The database side. Built once, from the migrations, exactly as
 * `prisma migrate deploy` would apply them.
 * ---------------------------------------------------------------- */

let pool;
let db = null;

async function introspect() {
  if (db) return db;
  pool = poolInSchema(pg, URL_, SCHEMA);

  const probe = new pg.Client({ connectionString: URL_ });
  await connectOrExplain(probe, URL_);
  await probe.end();

  await freshSchema(pool, SCHEMA);

  const columns = await pool.query(`
    SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = '${SCHEMA}'`);

  const indexes = await pool.query(`
    SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = '${SCHEMA}'`);

  const fks = await pool.query(`
    SELECT con.conname   AS name,
           rel.relname   AS "table",
           con.confdeltype AS on_delete
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE con.contype = 'f' AND n.nspname = '${SCHEMA}'`);

  const enums = await pool.query(`
    SELECT t.typname AS name, e.enumlabel AS value
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = '${SCHEMA}'
     ORDER BY t.typname, e.enumsortorder`);

  const byTable = new Map();
  for (const c of columns.rows) {
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, new Map());
    byTable.get(c.table_name).set(c.column_name, c);
  }
  const enumValues = new Map();
  for (const r of enums.rows) {
    if (!enumValues.has(r.name)) enumValues.set(r.name, []);
    enumValues.get(r.name).push(r.value);
  }

  db = {
    tables: byTable,
    indexes: new Map(indexes.rows.map((r) => [r.indexname, r])),
    fks: new Map(fks.rows.map((r) => [r.name, r])),
    enums: enumValues,
  };
  return db;
}

test.after(async () => { if (pool) await pool.end(); });

/* ================================================================ */

test("the migrations apply, and build every table the schema declares", { skip }, async () => {
  const d = await introspect();
  const missing = [...MODELS.keys()].filter((m) => !d.tables.has(m));
  assert.deepEqual(missing, [],
    "schema.prisma declares these models, but no migration creates a table for them:\n  " +
    missing.join("\n  ") +
    "\n\nPrisma would query a table that does not exist — a 500 on the first request.");
});

test("the migrations create no table the schema does not declare", { skip }, async () => {
  const d = await introspect();
  const extra = [...d.tables.keys()].filter(
    (t) => !MODELS.has(t) && t !== "_prisma_migrations");
  assert.deepEqual(extra, [],
    "The database has tables schema.prisma knows nothing about:\n  " + extra.join("\n  ") +
    "\n\nEither the model was deleted and the migration was not, or the table is a typo.");
});

test("every column exists, with the right type and nullability", { skip }, async () => {
  const d = await introspect();
  const problems = [];

  for (const [model, body] of MODELS) {
    const table = d.tables.get(model);
    if (!table) continue;                          // reported above

    for (const f of fieldsOf(body)) {
      if (MODELS.has(f.type)) continue;            // a relation, not a column

      const col = table.get(f.name);
      if (!col) {
        problems.push(`${model}.${f.name} — declared in schema.prisma, MISSING from the database`);
        continue;
      }

      /*
       * A SCALAR LIST IS A COLUMN, AND MISSING THAT MATTERED.
       *
       * `countries String[]` on Promotion is a text[] column. The first
       * version of this test skipped every list, so it reported all six of
       * Promotion's targeting columns as "in the database, NOT in
       * schema.prisma" — six false alarms, which is exactly how a test
       * teaches people to stop reading it. Postgres calls the type ARRAY
       * and names the element type with a leading underscore.
       */
      const want = f.list
        ? "_" + (ENUMS.has(f.type) ? f.type : SQL_TYPE[f.type]).replace(/ .*/, "")
        : (ENUMS.has(f.type) ? f.type : SQL_TYPE[f.type]);
      const got = (f.list || ENUMS.has(f.type)) ? col.udt_name : col.data_type;
      if (want && got !== want) {
        problems.push(`${model}.${f.name} — schema says ${f.type}${f.list ? "[]" : ""} (${want}), database has ${got}`);
      }

      /* A list is never NOT NULL in Prisma's mapping — an empty list is a
         value, so nullability does not apply. */
      const nullable = col.is_nullable === "YES";
      if (!f.list && nullable !== f.optional) {
        problems.push(
          `${model}.${f.name} — schema says ${f.optional ? "optional" : "required"}, ` +
          `database column is ${nullable ? "nullable" : "NOT NULL"}` +
          (f.optional ? "" : " — a write with this field absent would be rejected by the database " +
                             "even though Prisma allows it"));
      }
    }

    /* And the other direction: a column nothing reads is either a forgotten
       model field or dead weight, and both want looking at. */
    const declared = new Set(fieldsOf(body).filter((f) => !MODELS.has(f.type)).map((f) => f.name));
    for (const name of table.keys()) {
      if (!declared.has(name)) problems.push(`${model}.${name} — in the database, NOT in schema.prisma`);
    }
  }

  assert.deepEqual(problems, [],
    "schema.prisma and the migrations disagree:\n  " + problems.join("\n  "));
});

test("every enum holds exactly the values the schema declares, in order", { skip }, async () => {
  const d = await introspect();
  /* Only enums the schema actually uses on a column — an unused enum type is
     not created by Prisma either. */
  const used = new Set();
  for (const [, body] of MODELS) for (const f of fieldsOf(body)) if (ENUMS.has(f.type)) used.add(f.type);

  for (const name of used) {
    const got = d.enums.get(name);
    assert.ok(got, `enum "${name}" is used by a column but no migration creates the type`);
    assert.deepEqual(got, ENUMS.get(name),
      `enum "${name}" differs between schema.prisma and the database. ` +
      `Order matters to Prisma as well as membership.`);
  }
});

test("every index the schema asks for exists", { skip }, async () => {
  const d = await introspect();
  const missing = [];

  for (const [model, body] of MODELS) {
    for (const cols of attrs(body, "index")) {
      const name = `${model}_${cols.join("_")}_idx`;
      if (!d.indexes.has(name)) missing.push(`${name}  (@@index([${cols.join(", ")}]) on ${model})`);
    }
    for (const cols of attrs(body, "unique")) {
      const name = `${model}_${cols.join("_")}_key`;
      if (!d.indexes.has(name)) missing.push(`${name}  (@@unique([${cols.join(", ")}]) on ${model})`);
    }
    for (const f of fieldsOf(body)) {
      if (f.list || MODELS.has(f.type)) continue;
      if (!/@unique\b/.test(f.rest)) continue;
      const name = `${model}_${f.name}_key`;
      if (!d.indexes.has(name)) missing.push(`${name}  (@unique on ${model}.${f.name})`);
    }
  }

  assert.deepEqual(missing, [],
    "Indexes declared in schema.prisma that the migrations never create:\n  " +
    missing.join("\n  ") +
    "\n\nA missing @@unique is not slow — it is a duplicate the database will accept.");
});

test("every foreign key exists, and deletes the way the schema says", { skip }, async () => {
  const d = await introspect();
  const problems = [];

  /* Postgres records the rule as one character. */
  const RULE = { a: "NoAction", r: "Restrict", c: "Cascade", n: "SetNull", d: "SetDefault" };

  for (const [model, body] of MODELS) {
    for (const f of fieldsOf(body)) {
      if (!f.relFields) continue;
      for (const col of f.relFields.split(",").map((s) => s.trim()).filter(Boolean)) {
        const name = `${model}_${col}_fkey`;
        const fk = d.fks.get(name);
        if (!fk) {
          problems.push(
            `${name} is missing. ${model}.${col} would then be a plain string ` +
            `that can point at a row which no longer exists.`);
          continue;
        }
        /* Prisma's own defaults when onDelete is not written out. */
        const optional = fieldsOf(body).find((g) => g.name === col)?.optional;
        const want = f.onDelete || (optional ? "SetNull" : "Restrict");
        const got = RULE[fk.on_delete];
        if (got !== want) {
          problems.push(
            `${name} deletes with ${got}, but schema.prisma says ${want}. ` +
            `Prisma trusts the schema and the database enforces itself, so they ` +
            `disagree about what happens when the parent row goes.`);
        }
      }
    }
  }

  assert.deepEqual(problems, [],
    "Foreign keys:\n  " + problems.join("\n  "));
});

test("the isolation rule is true of the real database, not just the schema", { skip }, async () => {
  /*
   * tenancy.test.js proves this about the text of schema.prisma. This proves
   * it about the database that the migrations actually build — which is the
   * one a customer's data will be in.
   */
  const d = await introspect();
  const RULE = { a: "NoAction", r: "Restrict", c: "Cascade", n: "SetNull", d: "SetDefault" };
  const wrong = [];

  for (const [model, cols] of d.tables) {
    if (model === "_prisma_migrations" || !cols.has("orgId")) continue;
    if (model === "Session") continue;              // a reference; see tenancy.test.js

    const fk = d.fks.get(`${model}_orgId_fkey`);
    if (!fk) { wrong.push(`${model} has an orgId column with no foreign key at all`); continue; }
    if (RULE[fk.on_delete] !== "Cascade") {
      wrong.push(`${model}.orgId deletes with ${RULE[fk.on_delete]} — deleting a company ` +
                 `would leave its ${model} rows behind, orphaned and still readable`);
    }

    const indexed = [...d.indexes.values()].some(
      (i) => i.tablename === model && /\(\s*"?orgId"?/.test(i.indexdef));
    if (!indexed) wrong.push(`${model} has no index beginning with orgId`);
  }

  assert.deepEqual(wrong, [], "Multi-tenant isolation, in the database itself:\n  " + wrong.join("\n  "));
});

test("deleting a company really does take all six products with it", { skip }, async () => {
  /*
   * The constraints above say it should. This makes it happen: one company,
   * a row in every product, then a DELETE, then a count. Cascade rules are
   * easy to get subtly wrong across four levels of depth, and the failure —
   * a customer's data surviving the deletion of the customer — is one that
   * has to be found here rather than by a regulator.
   */
  await introspect();
  const q = (t, p) => pool.query(t, p);
  const id = "cascade_" + Math.random().toString(36).slice(2, 8);

  await q(`INSERT INTO "Organization"("id","name","updatedAt") VALUES ($1,$2,now())`, [id, "Doomed Ltd"]);
  await q(`INSERT INTO "Site"("id","orgId","name","updatedAt") VALUES ($1,$2,'Site',now())`, [id, id]);
  await q(`INSERT INTO "Party"("id","orgId","name","updatedAt") VALUES ($1,$2,'A Tenant',now())`, [id, id]);
  await q(`INSERT INTO "Lease"("id","orgId","tenantId","ref","updatedAt") VALUES ($1,$2,$3,'L-1',now())`, [id, id, id]);
  await q(`INSERT INTO "Invoice"("id","orgId","partyId","leaseId","ref","updatedAt") VALUES ($1,$2,$3,$4,'INV-1',now())`, [id, id, id, id]);
  await q(`INSERT INTO "InvoiceLine"("id","invoiceId","detail") VALUES ($1,$2,'Rent')`, [id, id]);
  await q(`INSERT INTO "Payment"("id","orgId","invoiceId","amount","updatedAt") VALUES ($1,$2,$3,150000,now())`, [id, id, id]);
  await q(`INSERT INTO "Reservation"("id","orgId","ref","updatedAt") VALUES ($1,$2,'R-1',now())`, [id, id]);
  await q(`INSERT INTO "Folio"("id","orgId","reservationId","updatedAt") VALUES ($1,$2,$3,now())`, [id, id, id]);
  await q(`INSERT INTO "FolioLine"("id","folioId","amount") VALUES ($1,$2,5000)`, [id, id]);
  await q(`INSERT INTO "Listing"("id","orgId","title","updatedAt") VALUES ($1,$2,'A flat',now())`, [id, id]);
  await q(`INSERT INTO "Incident"("id","orgId","ref","title","updatedAt") VALUES ($1,$2,'INC-1','Something happened',now())`, [id, id]);
  await q(`INSERT INTO "IncidentEvent"("id","incidentId","what","status") VALUES ($1,$2,'opened','OPEN')`, [id, id]);
  await q(`INSERT INTO "WorkOrder"("id","orgId","ref","title","updatedAt") VALUES ($1,$2,'WO-1','A dripping tap',now())`, [id, id]);
  await q(`INSERT INTO "WorkOrderEvent"("id","workOrderId","what","status") VALUES ($1,$2,'raised','OPEN')`, [id, id]);

  await q(`DELETE FROM "Organization" WHERE "id" = $1`, [id]);

  const TABLES = ["Site", "Party", "Lease", "Invoice", "InvoiceLine", "Payment",
                  "Reservation", "Folio", "FolioLine", "Listing", "Incident",
                  "IncidentEvent", "WorkOrder", "WorkOrderEvent"];
  const left = [];
  for (const t of TABLES) {
    const { rows } = await q(`SELECT count(*)::int AS n FROM "${t}" WHERE "id" = $1`, [id]);
    if (rows[0].n !== 0) left.push(t);
  }
  assert.deepEqual(left, [],
    "These rows outlived the company that owned them:\n  " + left.join("\n  ") +
    "\n\nThe data of a customer who has left is still in the database, and still " +
    "belongs to an organization id that can be reused.");
});
