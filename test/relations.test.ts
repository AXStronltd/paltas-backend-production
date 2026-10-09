/* ====================================================================== *
 * THE SCHEMA CHECKER WE HAD TO WRITE OURSELVES.
 *
 * `prisma validate` would normally catch everything in this file. It cannot
 * run here: Prisma downloads its engine binaries from binaries.prisma.sh at
 * first use, and this build environment cannot reach that host. So a schema
 * mistake would not surface until `prisma migrate deploy` ran at container
 * start on Render — which is to say, in front of customers, with the service
 * refusing to boot.
 *
 * That is not an acceptable place to find a missing back-relation, so the
 * subset of Prisma's rules that a plain parser CAN check is checked here:
 *
 *   - every relation has both halves, and they agree on a name
 *   - exactly one half carries fields/references
 *   - every referenced model and enum exists
 *   - every relation field's foreign key column is declared
 *   - a nullable foreign key never cascades, and a required one never
 *     SetNulls (Postgres cannot put a null in a NOT NULL column, and the
 *     migration would fail on the first delete rather than at deploy)
 *   - names are unique
 *
 * THIS IS NOT A SUBSTITUTE FOR `npx prisma validate`. Run that on a machine
 * that can reach the internet before any deploy. This is the floor, not the
 * ceiling.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Wire } from "./wire.ts";
import { present } from "./wire.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(HERE, "..", "prisma", "schema.prisma"), "utf8");

/* ---------------------------------------------------------------- *
 * A small parser. Prisma's grammar is bigger than this; the blocks and
 * fields this service actually uses are not.
 * ---------------------------------------------------------------- */

/**
 * Strip comments so a commented-out field is not parsed as a field.
 *
 * Both kinds: a whole comment line, and a trailing one after real code. The
 * first version of this missed trailing comments and reported `enum Role
 * repeats a value` because two of its comments contained the word "the" —
 * a test that cries wolf is worse than no test, so it strips both.
 */
function uncomment(text: Wire) {
  return text
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function blocks(kind: Wire) {
  const out = new Map();
  const re = new RegExp(`^${kind} (\\w+) \\{([\\s\\S]*?)^\\}`, "gm");
  for (const m of schema.matchAll(re)) out.set(m[1], uncomment(m[2]));
  return out;
}

const MODELS = blocks("model");
const ENUMS = new Map(
  [...schema.matchAll(/^enum (\w+) \{([\s\S]*?)\}/gm)].map((m) => [m[1], uncomment(m[2])])
);

/** Prisma's own scalars. Anything else must be a model or an enum. */
const SCALARS = new Set([
  "String", "Int", "BigInt", "Float", "Decimal", "Boolean",
  "DateTime", "Json", "Bytes", "Unsupported",
]);

/**
 * The fields of a model.
 *
 * A field line is `name Type modifiers`. Block-level attributes start with
 * `@@`, so they are skipped by requiring the line to open with a word.
 */
function fields(body: Wire) {
  const out = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("@@") || line.startsWith("//")) continue;
    const m = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
    if (!m) continue;
    const [, name, type, mod = "", rest = ""] = m;
    const rel = rest.match(/@relation\(([^)]*)\)/);
    const args = rel ? rel[1] : null;
    out.push({
      name,
      type,
      list: mod === "[]",
      optional: mod === "?",
      rest,
      hasRelation: Boolean(rel),
      /* @relation("LeaseTenant", fields: [...]) — the name is the one bare
         string argument, and it is always first when present. */
      relationName: args ? (args.match(/^\s*"([^"]+)"/)?.[1] ?? "") : "",
      relFields: args ? (args.match(/fields:\s*\[([^\]]*)\]/)?.[1] ?? null) : null,
      onDelete: args ? (args.match(/onDelete:\s*(\w+)/)?.[1] ?? null) : null,
    });
  }
  return out;
}

/** Every field of every model, parsed once. */
const PARSED = new Map([...MODELS].map(([name, body]) => [name, fields(body)]));

/** The relation fields of a model: those whose type is another model. */
const relationsOf = (model: string) =>
  present(PARSED.get(model), `${model} was never parsed`).filter((f) => MODELS.has(f.type));

/* ================================================================ */

test("the parser found the schema", () => {
  assert.ok(MODELS.size >= 40, `only ${MODELS.size} models parsed — has the file moved?`);
  assert.ok(ENUMS.size >= 20, `only ${ENUMS.size} enums parsed`);
  assert.ok(MODELS.has("Organization") && MODELS.has("Invoice"));
});

test("every field's type is a scalar, a model or an enum", () => {
  const unknown = [];
  for (const [model, fs] of PARSED) {
    for (const f of fs) {
      if (SCALARS.has(f.type) || MODELS.has(f.type) || ENUMS.has(f.type)) continue;
      unknown.push(`${model}.${f.name} : ${f.type}`);
    }
  }
  assert.deepEqual(unknown, [],
    "These types are not declared anywhere:\n  " + unknown.join("\n  "));
});

test("every relation has both halves", () => {
  /*
   * THE FAILURE THIS CATCHES, AND WHY IT IS FIRST.
   *
   * `Party.invoices Invoice[]` with no Invoice model at all is what the
   * schema looked like an hour before this test existed. Prisma would have
   * refused to generate; without Prisma, nothing would have said a word
   * until deploy.
   */
  const missing = [];
  for (const [model, fs] of PARSED) {
    for (const f of relationsOf(model)) {
      const other = present(PARSED.get(f.type), `${f.type} was never parsed`);
      /*
       * A SELF-RELATION IS A RELATION TO A DIFFERENT FIELD, NOT TO ITSELF.
       *
       * Jurisdiction.parent points at Jurisdiction and so does
       * Jurisdiction.children — the tree a jurisdiction forms. With model ===
       * f.type the naive filter below finds BOTH of them plus the field it
       * started from, and reports two halves where Prisma requires exactly
       * the pair. Excluding the field itself is what makes the count right
       * for a self-relation and changes nothing for every other one.
       */
      const back = other.filter((g) => g.type === model && g.name !== f.name);
      if (back.length === 0) {
        missing.push(
          `${model}.${f.name} points at ${f.type}, but ${f.type} has no field ` +
          `of type ${model} pointing back`);
        continue;
      }
      /* With more than one, the relation NAME is what pairs them, and every
         side must carry it — otherwise Prisma cannot tell which goes with
         which, and neither can a reader. */
      if (back.length > 1 || relationsOf(model).filter((g) => g.type === f.type).length > 1) {
        assert.ok(f.relationName,
          `${model}.${f.name}: ${model} and ${f.type} are related more than once, ` +
          `so every side needs a name — @relation("SomeName", ...)`);
        const named = back.filter((g) => g.relationName === f.relationName);
        assert.equal(named.length, 1,
          `${model}.${f.name} has relation name "${f.relationName}", but ${f.type} ` +
          `has ${named.length} fields with that name (expected exactly 1)`);
      }
    }
  }
  assert.deepEqual(missing, [],
    "Incomplete relations — Prisma will refuse to generate:\n  " + missing.join("\n  "));
});

test("exactly one side of each relation holds the foreign key", () => {
  const wrong = [];
  for (const [model, fs] of PARSED) {
    for (const f of relationsOf(model)) {
      if (f.list) {
        if (f.relFields) wrong.push(`${model}.${f.name} is a list AND holds fields: — a list side never does`);
        continue;
      }
      const back = present(PARSED.get(f.type), `${f.type} was never parsed`).filter(
        (g) => g.type === model && g.name !== f.name &&
               (!f.relationName || g.relationName === f.relationName));
      const other = back[0];
      if (!other) continue;               // reported by the test above
      const both = Boolean(f.relFields) && Boolean(other.relFields);
      const neither = !f.relFields && !other.relFields;
      if (both) wrong.push(`${model}.${f.name} and ${f.type}.${other.name} both hold fields:`);
      if (neither && !other.list) {
        wrong.push(`neither ${model}.${f.name} nor ${f.type}.${other.name} holds fields: — ` +
                   `one of them must own the foreign key`);
      }
    }
  }
  assert.deepEqual(wrong, [], "Foreign key placement:\n  " + wrong.join("\n  "));
});

test("every foreign key column is declared", () => {
  const missing = [];
  for (const [model, fs] of PARSED) {
    const names = new Set(fs.map((f) => f.name));
    for (const f of relationsOf(model)) {
      if (!f.relFields) continue;
      for (const col of f.relFields.split(",").map((s: Wire) => s.trim()).filter(Boolean)) {
        if (!names.has(col)) missing.push(`${model}.${f.name} references column "${col}", which does not exist`);
      }
    }
  }
  assert.deepEqual(missing, [], "Undeclared foreign key columns:\n  " + missing.join("\n  "));
});

test("a delete rule and its column's nullability agree", () => {
  /*
   * Postgres cannot write a null into a NOT NULL column. `onDelete: SetNull`
   * on a required foreign key is therefore not a slow leak or a design
   * smell — it is a delete that will fail, at run time, the first time a
   * customer removes a site. Prisma catches this; so does this.
   */
  const wrong = [];
  for (const [model, fs] of PARSED) {
    const by = new Map(fs.map((f) => [f.name, f]));
    for (const f of relationsOf(model)) {
      if (!f.relFields || !f.onDelete) continue;
      for (const col of f.relFields.split(",").map((s: Wire) => s.trim()).filter(Boolean)) {
        const c = by.get(col);
        if (!c) continue;
        if (f.onDelete === "SetNull" && !c.optional) {
          wrong.push(`${model}.${f.name} is onDelete: SetNull but ${model}.${col} is required — ` +
                     `the delete would fail rather than null the column`);
        }
        /*
         * SiteEvent is one row pointing at ONE of five registers — an RFI, a
         * submittal, an inspection, a defect or a diary — with the other four
         * columns null. Every one of them is therefore optional, and every one
         * of them must still cascade: an event about a deleted RFI, with its
         * rfiId nulled, is a row saying that something happened to something.
         *
         * The guard's reasoning — optional means the row can stand alone — is
         * right for an ordinary parent and wrong for a discriminated union,
         * where "optional" means "not THIS one" rather than "none".
         */
        if (f.onDelete === "Cascade" && c.optional
            && model !== "Session" && model !== "SiteEvent") {
          wrong.push(`${model}.${f.name} cascades on an optional column ${model}.${col} — ` +
                     `if it is optional the row can stand alone, so Cascade deletes rows ` +
                     `that did not have to die`);
        }
      }
    }
  }
  assert.deepEqual(wrong, [], "Delete rules:\n  " + wrong.join("\n  "));
});

test("names are unique", () => {
  const seen = new Map();
  for (const m of schema.matchAll(/^(model|enum) (\w+) \{/gm)) {
    const prev = seen.get(m[2]);
    assert.ok(!prev, `"${m[2]}" is declared twice — as a ${prev} and as a ${m[1]}`);
    seen.set(m[2], m[1]);
  }

  for (const [model, fs] of PARSED) {
    const names = new Set();
    for (const f of fs) {
      assert.ok(!names.has(f.name), `${model}.${f.name} is declared twice`);
      names.add(f.name);
    }
  }

  for (const [name, body] of ENUMS) {
    const values = body.split(/[\s\n]+/).filter(Boolean);
    assert.equal(new Set(values).size, values.length, `enum ${name} repeats a value`);
  }
});

test("every model has an id and timestamps, or says why not", () => {
  /* Join and line tables legitimately have no updatedAt; an append-only
     event table has no updatedAt BY DESIGN, because nothing updates it. */
  const APPEND_ONLY = new Set([
    "PromotionEvent", "WorkOrderEvent", "IncidentEvent", "AuditEvent",
    "FolioLine", "InvoiceLine", "Counter", "Entitlement",
    /*
     * ONE LINE OF AN OWNER STATEMENT, FROZEN WITH IT.
     *
     * The owner is holding a copy of the document these lines make up. A line
     * that could be updated is a line that stops matching the copy in their
     * inbox — so a wrong statement is VOIDED and re-issued, which produces new
     * lines rather than editing these. The route offers no PATCH and no DELETE
     * for one, and owner-statements.test.js asserts it.
     */
    "OwnerStatementLine",
    /* What a tokenisation provider told us, and when. Nothing updates it: if
       the provider later contradicts itself that is a NEW row, so the
       disagreement stays visible instead of being overwritten. */
    "TokenEvent",
    /*
     * A PROPERTY'S MEMORY, AND THE MOVES A SUCCESSION CASE MADE.
     *
     * Neither is ever updated, and that is the guarantee rather than an
     * omission: a correction to the timeline is a NEW event saying what
     * changed, and a case that goes back to UNDER_REVIEW gets another step
     * rather than an edited one. Both are records somebody may later be
     * asked to rely on, and a record that can be quietly tidied is worth
     * less than one that cannot. The routes offer no PATCH and no DELETE
     * for either, and dna.test.js asserts it.
     */
    "PropertyTimelineEvent", "SuccessionStep",
    /*
     * THE MOVES A DECISION MADE.
     *
     * A decision register whose history can be edited is not a register — the
     * point of it is that somebody can later ask who approved something, when,
     * and what was said at the time. A correction is a NEW event, and the route
     * offers no PATCH and no DELETE for one.
     *
     * Same reasoning as WorkOrderEvent and IncidentEvent above, and the same
     * shape: `at` and nothing else, because a row that is never updated has
     * nothing to say about when it last was.
     */
    "DecisionEvent",
    /* A comment on a task is a thing somebody said at a moment. Editing one
       would rewrite a conversation, so there is no PATCH for it and nothing
       for an updatedAt to record. */
    "TaskComment",
    /*
     * EVERY STATE A MESSAGE HAS BEEN IN.
     *
     * The row that answers "when did you tell them, and how do you know?".
     * Its `at` is the moment it was reported — by a person pressing send, or
     * by the carrier's callback — and a row that could be updated afterwards
     * answers neither question. There is no PATCH for one, and an updatedAt
     * would only offer a second clock to disagree with the first.
     */
    "DispatchEvent",
    /*
     * EVERY MOVE ANY OF THE FIVE SITE REGISTERS MAKES.
     *
     * One table rather than five because they are the same shape — what
     * happened, to what, who said so, when — and five near-identical event
     * tables is five places to remember to write to. It is what somebody
     * reads in a dispute, so there is no PATCH for one and nothing an
     * updatedAt could record.
     */
    "SiteEvent",
    /*
     * EVERY MOVE A PERMIT MAKES. Read when an authority asks when the
     * application went in, which is a question with one right answer and no
     * appetite for a row that was edited afterwards.
     */
    "PermitEvent",
    /*
     * ONE SIDE OF ONE POSTED JOURNAL ENTRY.
     *
     * It has no updatedAt because it is never updated, and that is the whole
     * guarantee the ledger rests on: a posted entry is immutable, and a
     * correction is a REVERSING entry that says what it reverses and why.
     * A line that could be edited after posting would make every report
     * derived from it unprovable, which is exactly what an auditor is
     * checking for. ledger.test.js asserts the original's lines still read
     * as posted after a reversal.
     */
    "JournalLine",
    /*
     * A JOIN ROW between land and what is built on it. It records that this
     * parcel carries this property; if that stops being true the row is
     * removed, never edited into meaning something else. There is no field on
     * it that an update could change.
     */
    "PropertyParcel",
  ]);
  for (const [model, fs] of PARSED) {
    const names = new Set(fs.map((f) => f.name));
    assert.ok(names.has("id") || model === "Counter", `${model} has no id`);
    if (APPEND_ONLY.has(model)) continue;
    /*
     * StripeEvent's clock is `receivedAt`, and the distinction is the point:
     * the row records when STRIPE DELIVERED an event, not when PALTAS made a
     * record. Calling it createdAt would invite somebody to read it as the
     * latter and reconcile against the wrong instant.
     */
    assert.ok(names.has("createdAt") || (model === "StripeEvent" && names.has("receivedAt")),
      `${model} has no createdAt`);
    assert.ok(names.has("updatedAt"),
      `${model} has no updatedAt. If that is deliberate because nothing ever ` +
      `updates it, add it to APPEND_ONLY in this test with that reason.`);
  }
});
