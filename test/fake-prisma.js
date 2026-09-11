/* ====================================================================== *
 * A PRISMA CLIENT THAT KEEPS ITS ROWS IN MEMORY.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────
 *
 * The product API is 150 endpoints and, until this file, not one of them
 * had ever executed. They could not: `@prisma/client` has to be generated
 * from a binary downloaded at install time, and every environment available
 * here is blocked from that host. So the end-to-end tests skipped, and 150
 * routes sat unrun.
 *
 * "It will be tested on somebody else's laptop" is not a plan. This is the
 * other half: a client shaped like Prisma's, holding rows in JavaScript
 * objects, so the REAL Express app, the REAL routers, the REAL guards and
 * the REAL money arithmetic all run here, now, against something.
 *
 * ── WHAT IT DOES AND DOES NOT PROVE ────────────────────────────────────
 *
 * It proves: routing, the guards, organization scoping, permissions, input
 * cleaning, reference checking, numbering, totals, status transitions,
 * error shapes, status codes. Every bug in the 4,000 lines written above
 * the database.
 *
 * It does NOT prove: that the SQL is right. That is `test/migration.test.js`,
 * which runs the real migrations against a real PostgreSQL and compares the
 * result to schema.prisma column by column. The two together cover the
 * ground; neither alone does, and this file is not a reason to skip the
 * real end-to-end run on a machine that can do it.
 *
 * ── THE ONE RULE IT FOLLOWS ────────────────────────────────────────────
 *
 * IT IS BUILT FROM schema.prisma, not written by hand. Models, fields,
 * types, defaults, relations and unique constraints are all parsed out of
 * the same file the real client is generated from. A fake that drifts from
 * the schema is worse than no fake at all — it passes tests about a
 * database nobody has.
 *
 * AND IT IS STRICT. Anything it does not understand throws, loudly, naming
 * itself. A fake that quietly ignores an operator it has not implemented
 * turns a real bug into a green tick, which is the whole failure mode this
 * kind of thing is famous for.
 * ====================================================================== */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ====================================================================== *
 * READING THE SCHEMA.
 * ====================================================================== */

const uncomment = (t) =>
  t.replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function parseSchema() {
  const text = readFileSync(join(HERE, "..", "prisma", "schema.prisma"), "utf8");
  const models = new Map();
  const enums = new Map();

  for (const m of text.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm)) {
    enums.set(m[1], uncomment(m[2]).split(/\s+/).filter(Boolean));
  }

  for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const name = m[1];
    const body = uncomment(m[2]);
    const fields = [];
    const uniques = [];

    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith("@@unique(")) {
        uniques.push(line.match(/\[([^\]]*)\]/)[1].split(",").map((s) => s.trim()));
        continue;
      }
      if (line.startsWith("@@")) continue;

      const f = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
      if (!f) continue;
      const [, fname, ftype, mod = "", rest = ""] = f;
      const relArgs = rest.match(/@relation\(([^)]*)\)/)?.[1] ?? null;

      const field = {
        name: fname,
        type: ftype,
        list: mod === "[]",
        optional: mod === "?",
        isId: /@id\b/.test(rest),
        unique: /@unique\b/.test(rest),
        updatedAt: /@updatedAt\b/.test(rest),
        default: defaultOf(rest),
        relation: relArgs === null ? null : {
          name: relArgs.match(/^\s*"([^"]+)"/)?.[1] ?? "",
          fields: relArgs.match(/fields:\s*\[([^\]]*)\]/)?.[1]?.split(",").map((s) => s.trim()) ?? null,
          references: relArgs.match(/references:\s*\[([^\]]*)\]/)?.[1]?.split(",").map((s) => s.trim()) ?? null,
        },
      };
      if (field.unique) uniques.push([fname]);
      fields.push(field);
    }
    models.set(name, { name, fields, uniques });
  }
  return { models, enums };
}

/** `@default(...)` with balanced parens — `@default(now())` breaks a lazy regex. */
function defaultOf(rest) {
  const i = rest.indexOf("@default(");
  if (i < 0) return null;
  let j = i + "@default(".length, depth = 1;
  while (j < rest.length && depth) {
    if (rest[j] === "(") depth++;
    else if (rest[j] === ")") depth--;
    j++;
  }
  return rest.slice(i + "@default(".length, j - 1).trim();
}

const { models: MODELS, enums: ENUMS } = parseSchema();

/**
 * WHICH COLUMN IS THE PRIMARY KEY.
 *
 * Almost every model uses `id`. `Counter` does not — its key is `name`:
 *
 *     model Counter { name String @id  value Int @default(0) }
 *
 * The first version of this file assumed `id` everywhere and stored every
 * counter under the key `undefined`, which meant ONE counter row for the
 * whole database instead of one per company per resource. Reference numbers
 * then collided across resources, and the failure looked like a bug in the
 * product's numbering rather than in the fake. Assumptions like that are
 * exactly what makes a fake worse than no fake, so it is read from the
 * schema.
 */
const idOf = (model) => (model.fields.find((f) => f.isId) || { name: "id" }).name;

/** `Site` → `site`, the accessor Prisma exposes. */
const accessorOf = (model) => model.charAt(0).toLowerCase() + model.slice(1);
const MODEL_BY_ACCESSOR = new Map([...MODELS.keys()].map((m) => [accessorOf(m), m]));

/* ====================================================================== *
 * ERRORS SHAPED LIKE PRISMA'S.
 *
 * The routes catch `e.code === "P2002"` and turn it into a sentence. If
 * this threw a plain Error the route's handling would never run, and the
 * test would prove the opposite of what it claims.
 * ====================================================================== */

function prismaError(code, message, meta) {
  const e = new Error(message);
  e.code = code;
  e.meta = meta;
  e.clientVersion = "fake";
  return e;
}

const boom = (what) => {
  throw new Error(
    `fake-prisma does not implement ${what}.\n` +
    `It is deliberately strict: silently ignoring this would turn a real bug ` +
    `into a passing test. Implement it here, or use the real end-to-end tests.`);
};

/* ====================================================================== *
 * MATCHING A `where`.
 * ====================================================================== */

function matchesValue(actual, expected, field) {
  if (expected === null) return actual === null || actual === undefined;

  if (expected instanceof Date) {
    return actual instanceof Date && actual.getTime() === expected.getTime();
  }

  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    for (const [op, v] of Object.entries(expected)) {
      switch (op) {
        case "equals": if (!matchesValue(actual, v, field)) return false; break;
        case "not": if (matchesValue(actual, v, field)) return false; break;
        case "in": if (!v.some((x) => matchesValue(actual, x, field))) return false; break;
        case "notIn": if (v.some((x) => matchesValue(actual, x, field))) return false; break;
        case "gt": if (!(cmp(actual, v) > 0)) return false; break;
        case "gte": if (!(cmp(actual, v) >= 0)) return false; break;
        case "lt": if (!(cmp(actual, v) < 0)) return false; break;
        case "lte": if (!(cmp(actual, v) <= 0)) return false; break;
        case "contains": {
          const a = String(actual ?? "");
          const b = String(v);
          const ci = expected.mode === "insensitive";
          if (!(ci ? a.toLowerCase().includes(b.toLowerCase()) : a.includes(b))) return false;
          break;
        }
        case "mode": break;                       // handled with `contains`
        case "has": if (!Array.isArray(actual) || !actual.includes(v)) return false; break;
        default: boom(`the where operator "${op}"`);
      }
    }
    return true;
  }

  return actual === expected;
}

function cmp(a, b) {
  if (a === null || a === undefined) return -1;
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

function matches(row, where, model) {
  if (!where) return true;

  for (const [key, value] of Object.entries(where)) {
    if (key === "AND") {
      if (!(Array.isArray(value) ? value : [value]).every((w) => matches(row, w, model))) return false;
      continue;
    }
    if (key === "OR") {
      if (!value.some((w) => matches(row, w, model))) return false;
      continue;
    }
    if (key === "NOT") {
      if ((Array.isArray(value) ? value : [value]).some((w) => matches(row, w, model))) return false;
      continue;
    }

    /* A compound unique arrives as `userId_orgId: { userId, orgId }`. */
    const field = model.fields.find((f) => f.name === key);
    if (!field && key.includes("_")) {
      const parts = key.split("_");
      if (parts.every((p) => model.fields.some((f) => f.name === p))) {
        if (!parts.every((p) => matchesValue(row[p], value[p], p))) return false;
        continue;
      }
    }
    if (!field) boom(`a where on unknown field "${model.name}.${key}"`);

    /* Filtering THROUGH a relation is not supported, and saying so beats
       pretending the filter applied. */
    if (field.relation && MODELS.has(field.type)) {
      boom(`a where through the relation "${model.name}.${key}"`);
    }

    if (!matchesValue(row[key], value, key)) return false;
  }
  return true;
}

/* ====================================================================== *
 * THE STORE.
 * ====================================================================== */

export function createFakeDb() {
  /** model name → id → row */
  const tables = new Map([...MODELS.keys()].map((m) => [m, new Map()]));

  const rowsOf = (model) => [...tables.get(model).values()];

  /* ---------------------------------------------------------------- */

  function applyDefaults(model, data) {
    const out = { ...data };
    for (const f of model.fields) {
      if (f.list && MODELS.has(f.type)) continue;
      if (MODELS.has(f.type)) continue;                 // relation, not a column

      if (out[f.name] === undefined) {
        if (f.default === null || f.default === undefined) {
          if (f.list) { out[f.name] = []; continue; }
          if (f.updatedAt) { out[f.name] = new Date(); continue; }
          if (f.optional) { out[f.name] = null; continue; }
          /*
           * Prisma refuses a missing required column, and so does this. A
           * fake that quietly writes `undefined` here would let a route
           * forget a required field and still pass.
           */
          throw prismaError("P2011",
            `Null constraint violation on ${model.name}.${f.name}`, { target: [f.name] });
        }
        out[f.name] = evalDefault(f);
      }
      if (f.updatedAt && out[f.name] === undefined) out[f.name] = new Date();
    }
    return out;
  }

  function evalDefault(f) {
    const d = f.default;
    if (d === "now()") return new Date();
    if (d.startsWith("cuid(") || d.startsWith("uuid(")) {
      return "c" + crypto.randomBytes(12).toString("hex");
    }
    if (d.startsWith('"')) return d.slice(1, -1);
    if (d === "true") return true;
    if (d === "false") return false;
    if (/^-?\d+$/.test(d)) return Number(d);
    if (d === "[]") return [];
    if (ENUMS.has(f.type)) return d;
    boom(`the default \`${d}\` on ${f.name}`);
  }

  function checkUnique(model, row, ignoreId) {
    const key = idOf(model);
    for (const cols of model.uniques) {
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      const clash = rowsOf(model.name).find(
        (r) => r[key] !== ignoreId && cols.every((c) => r[c] === row[c]));
      if (clash) {
        throw prismaError("P2002",
          `Unique constraint failed on the fields: (${cols.join(",")})`, { target: cols });
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * include / select
   * ---------------------------------------------------------------- */

  function hydrate(modelName, row, include, select) {
    if (!row) return row;

    if (select) {
      const out = {};
      for (const [key, want] of Object.entries(select)) {
        if (!want) continue;
        out[key] = row[key];
      }
      return out;
    }

    const out = { ...row };
    if (!include) return out;

    const model = MODELS.get(modelName);
    for (const [key, spec] of Object.entries(include)) {
      if (!spec) continue;
      const field = model.fields.find((f) => f.name === key);
      if (!field || !MODELS.has(field.type)) boom(`an include of "${modelName}.${key}"`);

      const other = MODELS.get(field.type);
      const opts = spec === true ? {} : spec;

      if (field.relation?.fields) {
        /* This side holds the foreign key. */
        const fk = row[field.relation.fields[0]];
        const ref = field.relation.references[0];
        const found = fk == null ? null : rowsOf(field.type).find((r) => r[ref] === fk);
        out[key] = found ? hydrate(field.type, found, opts.include, opts.select) : null;
        continue;
      }

      /* The other side holds it. Pair by relation name when there is more
         than one link between the two models. */
      const back = other.fields.find(
        (f) => f.type === modelName && f.relation?.fields &&
               (!field.relation?.name || f.relation.name === field.relation.name));
      if (!back) boom(`the back-relation for "${modelName}.${key}"`);

      const fkCol = back.relation.fields[0];
      let kids = rowsOf(field.type).filter((r) => r[fkCol] === row.id);
      if (opts.where) kids = kids.filter((r) => matches(r, opts.where, other));
      if (opts.orderBy) kids = sortRows(kids, opts.orderBy);

      out[key] = field.list
        ? kids.map((r) => hydrate(field.type, r, opts.include, opts.select))
        : (kids[0] ? hydrate(field.type, kids[0], opts.include, opts.select) : null);
    }
    return out;
  }

  function sortRows(rows, orderBy) {
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        for (const [field, dir] of Object.entries(spec)) {
          if (typeof dir === "object") boom("ordering through a relation");
          const d = cmp(a[field], b[field]);
          if (d !== 0) return dir === "desc" ? -d : d;
        }
      }
      return 0;
    });
  }

  /* ---------------------------------------------------------------- *
   * The delegate every model gets.
   * ---------------------------------------------------------------- */

  function delegate(modelName) {
    const model = MODELS.get(modelName);
    const table = tables.get(modelName);

    const find = (where) => rowsOf(modelName).filter((r) => matches(r, where, model));

    return {
      async findMany(args = {}) {
        let rows = find(args.where);
        rows = args.orderBy ? sortRows(rows, args.orderBy) : rows;

        if (args.cursor) {
          const at = rows.findIndex((r) => r.id === args.cursor.id);
          rows = at < 0 ? [] : rows.slice(at + (args.skip || 0));
        } else if (args.skip) {
          rows = rows.slice(args.skip);
        }
        if (args.take !== undefined) rows = rows.slice(0, args.take);

        return rows.map((r) => hydrate(modelName, r, args.include, args.select));
      },

      async findFirst(args = {}) {
        const rows = args.orderBy ? sortRows(find(args.where), args.orderBy) : find(args.where);
        return rows.length ? hydrate(modelName, rows[0], args.include, args.select) : null;
      },

      async findUnique(args = {}) {
        const rows = find(args.where);
        return rows.length ? hydrate(modelName, rows[0], args.include, args.select) : null;
      },

      async count(args = {}) {
        return find(args.where).length;
      },

      async create(args = {}) {
        const nested = {};
        const data = {};
        for (const [k, v] of Object.entries(args.data || {})) {
          const f = model.fields.find((x) => x.name === k);
          if (f && MODELS.has(f.type)) nested[k] = v;
          else data[k] = v;
        }

        const row = applyDefaults(model, data);
        checkUnique(model, row);
        table.set(row[idOf(model)], row);

        /* `create: { … }` and `create: [ … ]` on a relation — organizations.js
           builds a whole company in one call. */
        for (const [key, spec] of Object.entries(nested)) {
          const field = model.fields.find((f) => f.name === key);
          const other = MODELS.get(field.type);
          const back = other.fields.find(
            (f) => f.type === modelName && f.relation?.fields &&
                   (!field.relation?.name || f.relation.name === field.relation.name));
          if (!back) boom(`a nested write on "${modelName}.${key}"`);
          const fk = back.relation.fields[0];

          for (const [op, payload] of Object.entries(spec)) {
            if (op !== "create") boom(`the nested write "${op}"`);
            for (const one of (Array.isArray(payload) ? payload : [payload])) {
              await delegate(field.type).create({ data: { ...one, [fk]: row[idOf(model)] } });
            }
          }
        }

        return hydrate(modelName, row, args.include, args.select);
      },

      async update(args = {}) {
        const rows = find(args.where);
        if (!rows.length) {
          throw prismaError("P2025", "An operation failed because it depends on one or more records that were required but not found.");
        }
        const row = rows[0];
        const key = row[idOf(model)];
        const next = { ...row, ...writeable(model, args.data, row) };
        checkUnique(model, next, key);
        table.set(key, next);
        return hydrate(modelName, next, args.include, args.select);
      },

      async updateMany(args = {}) {
        const rows = find(args.where);
        for (const row of rows) {
          const key = row[idOf(model)];
          const next = { ...row, ...writeable(model, args.data, row) };
          checkUnique(model, next, key);
          table.set(key, next);
        }
        return { count: rows.length };
      },

      async upsert(args = {}) {
        const rows = find(args.where);
        if (rows.length) {
          return this.update({ where: args.where, data: args.update, include: args.include });
        }
        return this.create({ data: args.create, include: args.include });
      },

      async delete(args = {}) {
        const rows = find(args.where);
        if (!rows.length) throw prismaError("P2025", "Record to delete does not exist.");
        cascade(modelName, rows[0]);
        table.delete(rows[0][idOf(model)]);
        return rows[0];
      },

      async deleteMany(args = {}) {
        const rows = find(args.where);
        for (const r of rows) { cascade(modelName, r); table.delete(r[idOf(model)]); }
        return { count: rows.length };
      },
    };
  }

  /** `{ increment: 1 }` and friends, plus @updatedAt. */
  function writeable(model, data, current) {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) {
      const f = model.fields.find((x) => x.name === k);
      if (!f) boom(`a write to unknown field "${model.name}.${k}"`);
      if (MODELS.has(f.type)) boom(`a nested update on "${model.name}.${k}"`);

      if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
        if ("increment" in v) { out[k] = (current[k] || 0) + v.increment; continue; }
        if ("decrement" in v) { out[k] = (current[k] || 0) - v.decrement; continue; }
        if ("set" in v) { out[k] = v.set; continue; }
        boom(`the update operator on "${k}"`);
      }
      out[k] = v;
    }
    for (const f of model.fields) if (f.updatedAt) out[f.name] = new Date();
    return out;
  }

  /**
   * Cascade and SetNull, so deleting a company behaves as the schema says.
   */
  function cascade(modelName, row) {
    for (const [otherName, other] of MODELS) {
      for (const f of other.fields) {
        if (f.type !== modelName || !f.relation?.fields) continue;
        const fk = f.relation.fields[0];
        const mine = row[idOf(MODELS.get(modelName))];
        const kids = [...tables.get(otherName).values()].filter((r) => r[fk] === mine);
        if (!kids.length) continue;

        const otherKey = idOf(other);
        const rule = f.optional ? "SetNull" : "Cascade";
        for (const kid of kids) {
          if (rule === "Cascade") {
            cascade(otherName, kid);
            tables.get(otherName).delete(kid[otherKey]);
          } else {
            tables.get(otherName).set(kid[otherKey], { ...kid, [fk]: null });
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */

  const db = {
    async $queryRaw() { return [{ "?column?": 1 }]; },
    async $executeRaw() { return 0; },
    async $disconnect() {},
    async $transaction(arg) {
      /* No rollback. Every transaction in this service is a set of writes
         that either all make sense or none do, and the routes are what is
         under test — not Postgres's atomicity, which migration.test.js and
         the real end-to-end run cover. */
      if (typeof arg === "function") return arg(db);
      return Promise.all(arg);
    },
    /** Everything in the store, for a test that wants to look directly. */
    __tables: tables,
    __reset() { for (const t of tables.values()) t.clear(); },
  };

  for (const [accessor, modelName] of MODEL_BY_ACCESSOR) {
    db[accessor] = delegate(modelName);
  }
  return db;
}

export { MODELS, MODEL_BY_ACCESSOR };
