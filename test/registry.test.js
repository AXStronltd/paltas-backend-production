/* ====================================================================== *
 * THE REGISTRY AND THE SCHEMA, KEPT HONEST ABOUT EACH OTHER.
 *
 * registry.js says which fields a request may write. schema.prisma says
 * which columns exist. When they disagree the failure is silent in the worst
 * possible direction:
 *
 *   - a field in the registry that is NOT in the schema → every create
 *     against that resource throws a Prisma "Unknown argument" at run time,
 *     500, in production, on the first customer who fills the form in.
 *
 *   - a field in the schema that IS NOT in the registry → the form saves and
 *     the value is silently dropped. Nobody sees an error. The customer sees
 *     their note disappear and concludes the product loses data.
 *
 * The second is worse, and neither is catchable by reading. So both
 * directions are checked here, and the fields that are deliberately not
 * writable are named with the reason they are not.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCES } from "../src/domain/registry.js";
import { AREAS, ROLE_AREAS, LEVELS, allows, levelFor, whyNotArea } from "../src/domain/access.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(HERE, "..", "prisma", "schema.prisma"), "utf8");

const uncomment = (t) =>
  t.replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const MODELS = new Map(
  [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => [m[1], uncomment(m[2])])
);
const ENUMS = new Map(
  [...schema.matchAll(/^enum (\w+) \{([\s\S]*?)\}/gm)]
    .map((m) => [m[1], uncomment(m[2]).split(/\s+/).filter(Boolean)])
);

function fieldsOf(model) {
  const body = MODELS.get(model);
  const out = new Map();
  if (!body) return out;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("@@")) continue;
    const m = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
    if (!m) continue;
    out.set(m[1], { type: m[2], list: m[3] === "[]", optional: m[3] === "?", rest: m[4] || "" });
  }
  return out;
}

/** `site` → `Site`. */
const modelName = (accessor) => accessor.charAt(0).toUpperCase() + accessor.slice(1);

/**
 * Columns no request may ever write, and why.
 *
 * Each of these would be a security or correctness hole if a caller could
 * set it, so they are excluded from the registry ON PURPOSE and named here
 * rather than left to look like an oversight.
 */
const NEVER_WRITABLE = {
  id: "assigned by the database",
  orgId: "comes from the session, never from the request — that is the whole tenancy rule",
  ref: "allocated per company by the framework; a caller choosing one could collide or impersonate",
  code: "same as ref — a pass code is allocated, never chosen by the person it admits",
  createdAt: "set once, by the database",
  updatedAt: "set by Prisma on every write",
  closedAt: "set by the status change that closes it, not sent alongside it",
  voided: "a payment is voided through its own endpoint, with a reason",
  voidReason: "written by the void endpoint",
  voidedAt: "written by the void endpoint",
  closed: "a folio is closed by closing it",
  total: "computed from the invoice lines; a caller who can send a total can send zero",
  paid: "computed from the payments; same reason",
  net: "gross minus fees — a third number that must follow from the other two",
};

/* ================================================================ */

test("every resource names a model that exists", () => {
  for (const [slug, r] of Object.entries(RESOURCES)) {
    assert.ok(MODELS.has(modelName(r.model)),
      `resource "${slug}" declares model "${r.model}", and schema.prisma has no model ${modelName(r.model)}`);
  }
});

test("every field a request may write is a real column", () => {
  const problems = [];
  for (const [slug, r] of Object.entries(RESOURCES)) {
    const cols = fieldsOf(modelName(r.model));
    for (const [name, kind] of Object.entries(r.fields)) {
      const col = cols.get(name);
      if (!col) {
        problems.push(`${slug}.${name} — in the registry, NOT in ${modelName(r.model)}. ` +
                      `Every create against this resource would throw.`);
        continue;
      }
      /* And the kind has to match, or the value is coerced into a column that
         cannot hold it. */
      const want = {
        string: "String", text: "String", int: "Int", money: "Int",
        float: "Float", bool: "Boolean", date: "DateTime", json: "Json",
      }[kind] || (kind.startsWith("enum:") ? kind.slice(5)
                : kind.startsWith("id:") ? "String" : null);
      assert.ok(want, `${slug}.${name} has unknown kind "${kind}"`);
      if (col.type !== want) {
        problems.push(`${slug}.${name} — registry says ${kind} (${want}), schema says ${col.type}`);
      }
      if (kind.startsWith("enum:")) {
        assert.ok(ENUMS.has(kind.slice(5)), `${slug}.${name} names enum ${kind.slice(5)}, which does not exist`);
      }
      if (kind.startsWith("id:")) {
        assert.ok(MODELS.has(modelName(kind.slice(3))),
          `${slug}.${name} points at model "${kind.slice(3)}", which does not exist`);
      }
    }
  }
  assert.deepEqual(problems, [], "registry.js and schema.prisma disagree:\n  " + problems.join("\n  "));
});

test("every column is either writable or deliberately not", () => {
  /*
   * THE SILENT ONE. A column the registry forgot is a form field that saves,
   * returns 200, and drops the value. The customer sees their note vanish and
   * concludes the product loses data — and there is no error anywhere to
   * find.
   */
  const problems = [];
  for (const [slug, r] of Object.entries(RESOURCES)) {
    const cols = fieldsOf(modelName(r.model));
    for (const [name, col] of cols) {
      if (name in r.fields) continue;
      if (name in NEVER_WRITABLE) continue;
      if (MODELS.has(col.type)) continue;              // a relation, written via its id
      problems.push(
        `${slug}: ${modelName(r.model)}.${name} (${col.type}) can be written by nothing. ` +
        `Add it to the resource's fields, or to NEVER_WRITABLE in this test with the reason.`);
    }
  }
  assert.deepEqual(problems, [], "Columns nothing can set:\n  " + problems.join("\n  "));
});

test("a resource that numbers its rows has somewhere to put the number", () => {
  for (const [slug, r] of Object.entries(RESOURCES)) {
    if (!r.numbered) continue;
    const col = r.numbered;
    const cols = fieldsOf(modelName(r.model));
    assert.ok(cols.has(col),
      `${slug} is numbered on "${col}" but ${modelName(r.model)} has no such column`);
    assert.ok(!(col in r.fields),
      `${slug} allocates its own ${col} AND lets a caller send one. Two sources for one ` +
      `number is how two companies' invoices come to share a reference.`);
    assert.ok(MODELS.get(modelName(r.model)).includes(`@@unique([orgId, ${col}])`),
      `${slug} numbers its rows but ${modelName(r.model)} does not enforce ` +
      `@@unique([orgId, ${col}]) — so two requests racing can be handed the same ` +
      `number and the database will accept both`);
  }
});

test("every searchable field is a text column that exists", () => {
  /* `?q=` builds a `contains` filter. Pointed at a column that is not there,
     Prisma throws; pointed at an Int it throws differently. Both are a 500 on
     the search box, which is the feature people try first. */
  for (const [slug, r] of Object.entries(RESOURCES)) {
    const cols = fieldsOf(modelName(r.model));
    for (const f of r.search || []) {
      const col = cols.get(f);
      assert.ok(col, `${slug} searches "${f}", which ${modelName(r.model)} does not have`);
      assert.equal(col.type, "String", `${slug} searches "${f}", which is a ${col.type}`);
    }
  }
});

test("every include asks for named columns, never a whole related row", () => {
  /*
   * `include: { tenant: true }` returns every column of the tenant — email,
   * phone, private note — inside a list that was only meant to show a name.
   * That is how personal data reaches a screen nobody audited, so it is
   * refused here rather than at review time.
   */
  for (const [slug, r] of Object.entries(RESOURCES)) {
    for (const [rel, spec] of Object.entries(r.include || {})) {
      if (rel === "lines") continue;          // a line table carries no personal data
      assert.ok(spec && typeof spec === "object" && spec.select,
        `${slug}.include.${rel} has no select — it would return every column of the ` +
        `related row, including any personal detail on it`);
    }
  }
});

test("every resource belongs to an area the access table knows", () => {
  for (const [slug, r] of Object.entries(RESOURCES)) {
    assert.ok(AREAS.includes(r.area), `resource "${slug}" is in area "${r.area}", which does not exist`);
  }
});

test("every area is reachable by somebody, and no role has a level that is not a level", () => {
  for (const [role, row] of Object.entries(ROLE_AREAS)) {
    for (const [area, level] of Object.entries(row)) {
      assert.ok(AREAS.includes(area), `role ${role} names area "${area}", which does not exist`);
      assert.ok(LEVELS.includes(level), `role ${role} has level "${level}" in ${area}`);
    }
    for (const area of AREAS) {
      assert.ok(area in row, `role ${role} says nothing about "${area}" — silence is not a decision`);
    }
  }

  /* An area only OWNER can reach is an area the product does not really have. */
  for (const area of AREAS) {
    const who = Object.keys(ROLE_AREAS).filter((r) => ROLE_AREAS[r][area] !== "none");
    assert.ok(who.length >= 3,
      `only ${who.join(", ")} can reach "${area}" — check that is intended`);
  }
});

test("a guard may write the security log and delete none of it", () => {
  /*
   * The single most important row in the access table, so it is asserted
   * rather than left to be read. A guard who can delete a visit can delete
   * the record of the person they waved through.
   */
  const guard = { role: "GUARD" };
  assert.equal(levelFor(guard, "security"), "write");
  assert.ok(allows(guard, "security", "create"));
  assert.ok(allows(guard, "security", "update"));
  assert.ok(!allows(guard, "security", "delete"), "a guard can delete the security log");
  assert.ok(!allows(guard, "finance", "list"), "a guard can read the company's money");
  assert.ok(!allows(guard, "hotel", "list"));

  const why = whyNotArea(guard, "security", "delete", "visits");
  assert.match(why, /not delete|only write/i);
  assert.ok(why.length > 40, "the refusal does not tell them what to do instead");
});

test("nobody outside the company's staff reaches a product at all", () => {
  for (const role of ["GUEST", "MARKETING", "COMPLIANCE", "PUBLISHER", "PROMO_CONTRIBUTOR"]) {
    for (const area of AREAS) {
      assert.equal(levelFor({ role }, area), "none",
        `${role} can reach ${area}. PALTAS staff review promotions; they do not read a ` +
        `customer's leases, and a guest is not staff at all.`);
    }
  }
  /* And an unknown role grants nothing rather than everything. */
  assert.equal(levelFor({ role: "SUPERUSER" }, "finance"), "none");
  assert.equal(levelFor(null, "finance"), "none");
});

test("finance can see everything and change only money", () => {
  const f = { role: "FINANCE" };
  assert.ok(allows(f, "finance", "delete"));
  assert.ok(allows(f, "property", "list"), "finance cannot read a lease it must invoice against");
  assert.ok(!allows(f, "property", "create"), "finance can write a lease");
  assert.ok(!allows(f, "security", "create"));
});
