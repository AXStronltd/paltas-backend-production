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

const uncomment = (t: string): string =>
  t.replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* ====================================================================== *
 * THE SCHEMA, AS THIS FILE UNDERSTANDS IT.
 *
 * These describe what `parseSchema()` reads out of schema.prisma, and so
 * they describe the fake's own idea of a database. Writing them down is
 * more than tidiness: the whole value of this file is that it is BUILT from
 * the schema rather than written by hand, and a shape nobody stated is a
 * shape that can quietly stop matching the schema it came from.
 * ====================================================================== */

/** One relation's arguments, as `@relation(...)` states them. */
export interface RelationSpec {
  readonly name: string;
  /** The columns on THIS model. Null where the relation names none. */
  readonly fields: string[] | null;
  readonly references: string[] | null;
}

/** One column. */
export interface FieldSpec {
  readonly name: string;
  readonly type: string;
  readonly list: boolean;
  readonly optional: boolean;
  readonly isId: boolean;
  readonly unique: boolean;
  readonly updatedAt: boolean;
  /** The text inside `@default(...)`, or null where there is none. */
  readonly default: string | null;
  readonly relation: RelationSpec | null;
}

/** One model, and every way its rows must stay distinct. */
export interface ModelSpec {
  readonly name: string;
  readonly fields: FieldSpec[];
  /** Each entry is one constraint: a list of the columns it spans. */
  readonly uniques: string[][];
}

/** A row, as this fake stores one. Columns are whatever the schema declared. */
export type Row = Record<string, unknown>;

/**
 * ONE MODEL'S ACCESSOR — `db.offer`, `db.organization`, and 130 more.
 *
 * The operations this stand-in implements, which is a shorter list than the
 * real client's on purpose: anything not here throws by name rather than
 * being quietly ignored, because a fake that drops an operation turns a real
 * bug into a green tick.
 *
 * The rows come back as `Row` — the schema's columns, read as what they are.
 * A test asserting on one is asserting about a shape the fake built from
 * schema.prisma, and the assertion is what checks it.
 */
export interface FakeDelegate {
  findMany(args?: QueryArgs): Promise<Row[]>;
  findFirst(args?: QueryArgs): Promise<Row | null>;
  findUnique(args?: QueryArgs): Promise<Row | null>;
  count(args?: QueryArgs): Promise<number>;
  create(args?: QueryArgs): Promise<Row>;
  update(args?: QueryArgs): Promise<Row>;
  updateMany(args?: QueryArgs): Promise<{ count: number }>;
  upsert(args?: QueryArgs): Promise<Row>;
  delete(args?: QueryArgs): Promise<Row>;
  deleteMany(args?: QueryArgs): Promise<{ count: number }>;
}

/**
 * The stand-in client, as a test holds one.
 *
 * An intersection rather than an interface with an index signature: the four
 * `$` methods and the two `__` ones have their own shapes, and the model
 * accessors are attached by name in a loop from MODEL_BY_ACCESSOR. Declaring
 * 132 of those here would be the hand-written copy of schema.prisma this
 * whole file exists to avoid.
 */
export type FakeDb = {
  $queryRaw(): Promise<{ "?column?": number }[]>;
  $executeRaw(): Promise<number>;
  $disconnect(): Promise<void>;
  $transaction(arg: unknown): Promise<unknown>;
  /** Everything in the store, for a test that wants to look directly. */
  __tables: Map<string, Map<string, Row>>;
  __reset(): void;
} & Record<string, FakeDelegate>;

/**
 * WHAT THIS FAKE UNDERSTANDS OF A PRISMA QUERY.
 *
 * Every field it reads, and no more — which makes this list the fake's
 * supported surface, written down. Anything a caller sends that is not here
 * is not silently ignored: `boom()` throws naming it, because a fake that
 * quietly drops a `where` turns a real bug into a green tick.
 *
 * The values are `unknown` rather than Prisma's own generic types. This is a
 * stand-in built by parsing schema.prisma as text; it has no access to the
 * generated types and inventing an approximation of them here would be a
 * second source of truth, which is the one thing this file exists to avoid.
 */
export interface QueryArgs {
  where?: unknown;
  data?: unknown;
  select?: unknown;
  include?: unknown;
  orderBy?: unknown;
  take?: number;
  skip?: number;
  cursor?: { id?: unknown } & Record<string, unknown>;
  /** `upsert` only. */
  create?: unknown;
  update?: unknown;
}

function parseSchema(): { models: Map<string, ModelSpec>; enums: Map<string, string[]> } {
  const text = readFileSync(join(HERE, "..", "prisma", "schema.prisma"), "utf8");
  const models = new Map<string, ModelSpec>();
  const enums = new Map<string, string[]>();

  for (const m of text.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm)) {
    enums.set(String(m[1]), uncomment(String(m[2])).split(/\s+/).filter(Boolean));
  }

  for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const name = String(m[1]);
    const body = uncomment(String(m[2]));
    const fields: FieldSpec[] = [];
    const uniques: string[][] = [];

    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith("@@unique(")) {
        const spanned = line.match(/\[([^\]]*)\]/)?.[1] ?? "";
        uniques.push(spanned.split(",").map((s) => s.trim()));
        continue;
      }
      if (line.startsWith("@@")) continue;

      const f = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
      if (!f) continue;
      const [, fname, ftype, mod = "", rest = ""] = f;
      const relArgs = rest.match(/@relation\(([^)]*)\)/)?.[1] ?? null;

      const field: FieldSpec = {
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
function defaultOf(rest: string): string | null {
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
const idOf = (model: ModelSpec): string =>
  (model.fields.find((f) => f.isId) ?? { name: "id" }).name;

/** `Site` → `site`, the accessor Prisma exposes. */
const accessorOf = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1);
const MODEL_BY_ACCESSOR = new Map<string, string>(
  [...MODELS.keys()].map((m) => [accessorOf(m), m] as const));

/* ====================================================================== *
 * ERRORS SHAPED LIKE PRISMA'S.
 *
 * The routes catch `e.code === "P2002"` and turn it into a sentence. If
 * this threw a plain Error the route's handling would never run, and the
 * test would prove the opposite of what it claims.
 * ====================================================================== */

/**
 * An error shaped like Prisma's.
 *
 * The routes catch `e.code === "P2002"`, so these three fields are the
 * contract — a plain Error would take a different path through the handler
 * and the test would prove the opposite of what it claims.
 */
export interface FakePrismaError extends Error {
  code: string;
  meta: unknown;
  clientVersion: string;
}

function prismaError(code: string, message: string, meta?: unknown): FakePrismaError {
  const e = new Error(message) as FakePrismaError;
  e.code = code;
  e.meta = meta;
  e.clientVersion = "fake";
  return e;
}

const boom = (what: string): never => {
  throw new Error(
    `fake-prisma does not implement ${what}.\n` +
    `It is deliberately strict: silently ignoring this would turn a real bug ` +
    `into a passing test. Implement it here, or use the real end-to-end tests.`);
};

/* ====================================================================== *
 * MATCHING A `where`.
 * ====================================================================== */

/**
 * `field` is the COLUMN NAME, and nothing below reads it.
 *
 * It is threaded through the recursive calls and never consulted — left as
 * it was found rather than removed, because the day this fake needs to say
 * WHICH column an unsupported operator was used on, it is already here.
 */
function matchesValue(actual: unknown, expected: unknown, field?: string): boolean {
  if (expected === null) return actual === null || actual === undefined;

  if (expected instanceof Date) {
    return actual instanceof Date && actual.getTime() === expected.getTime();
  }

  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const clause = expected as Record<string, unknown>;
    for (const [op, v] of Object.entries(clause)) {
      switch (op) {
        case "equals": if (!matchesValue(actual, v, field)) return false; break;
        case "not": if (matchesValue(actual, v, field)) return false; break;
        case "in":
          if (!asList(v).some((x) => matchesValue(actual, x, field))) return false;
          break;
        case "notIn":
          if (asList(v).some((x) => matchesValue(actual, x, field))) return false;
          break;
        case "gt": if (!(cmp(actual, v) > 0)) return false; break;
        case "gte": if (!(cmp(actual, v) >= 0)) return false; break;
        case "lt": if (!(cmp(actual, v) < 0)) return false; break;
        case "lte": if (!(cmp(actual, v) <= 0)) return false; break;
        case "contains": {
          const a = String(actual ?? "");
          const b = String(v);
          const ci = clause["mode"] === "insensitive";
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

function cmp(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return -1;
  const x = a instanceof Date ? a.getTime() : (a as number | string);
  const y = b instanceof Date ? b.getTime() : (b as number | string);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * A `where` operator's operand, as a list.
 *
 * `in` and `notIn` take one, and a caller that sends a bare value rather
 * than an array is asking a question this fake can still answer. Refusing
 * would be stricter than Prisma without being more correct.
 */
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

function matches(row: Row, where: unknown, model: ModelSpec): boolean {
  if (!where) return true;

  for (const [key, value] of Object.entries(where)) {
    if (key === "AND") {
      if (!asList(value).every((w) => matches(row, w as Row, model))) return false;
      continue;
    }
    if (key === "OR") {
      if (!asList(value).some((w) => matches(row, w as Row, model))) return false;
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
      const compound = (value ?? {}) as Record<string, unknown>;
      if (parts.every((p) => model.fields.some((f) => f.name === p))) {
        if (!parts.every((p) => matchesValue(row[p], compound[p], p))) return false;
        continue;
      }
    }
    if (!field) return boom(`a where on unknown field "${model.name}.${key}"`);

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
  const tables = new Map<string, Map<string, Row>>(
    [...MODELS.keys()].map((m) => [m, new Map<string, Row>()] as const));

  /**
   * Every row of one model.
   *
   * `tables` was built from MODELS above, so a name that reached here is one
   * this fake knows — but a typo in a caller would otherwise read
   * `undefined.values()` three frames away from the mistake.
   */
  const rowsOf = (model: string): Row[] => {
    const table = tables.get(model);
    if (!table) return boom(`the model "${model}"`);
    return [...table.values()];
  };

  /* ---------------------------------------------------------------- */

  function applyDefaults(model: ModelSpec, data: Row): Row {
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

  function evalDefault(f: FieldSpec): unknown {
    const d = f.default;
    if (d === null) return undefined;
    if (d === "now()") return new Date();
    if (d.startsWith("cuid(") || d.startsWith("uuid(")) {
      return "c" + crypto.randomBytes(12).toString("hex");
    }
    /*
     * A Json column's default is written in the schema as a quoted string
     * CONTAINING json — `scope Json @default("{\"all\": true}")`. Real Prisma
     * hands back the parsed object. So must this: returning the raw text would
     * give every caller a string where production gives an object, and a fake
     * that disagrees with the service on a field's TYPE is worse than no fake,
     * because the tests still pass.
     *
     * Found by site scope. `Membership.scope` arrived here as the characters
     * `{\"all\": true}`, so `scope.all` was undefined, so the filter read an
     * unrestricted member as a restricted one and refused a legitimate write.
     */
    if (f.type === "Json" && d.startsWith('"')) return JSON.parse(JSON.parse(d));
    if (d.startsWith('"')) return d.slice(1, -1);
    if (d === "true") return true;
    if (d === "false") return false;
    if (/^-?\d+$/.test(d)) return Number(d);
    if (d === "[]") return [];
    if (ENUMS.has(f.type)) return d;
    boom(`the default \`${d}\` on ${f.name}`);
  }

  function checkUnique(model: ModelSpec, row: Row, ignoreId?: unknown): void {
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

  /* A row in yields a row out; only a missing row comes back missing. Said as
     two overloads so `findMany`, which maps over rows it already has, is not
     forced to hand every caller a `Row | null` it can never contain. */
  function hydrate(
    modelName: string, row: Row, include?: unknown, select?: unknown,
  ): Row;
  function hydrate(
    modelName: string, row: Row | null, include?: unknown, select?: unknown,
  ): Row | null;
  function hydrate(
    modelName: string, row: Row | null, include?: unknown, select?: unknown,
  ): Row | null {
    if (!row) return row;

    if (select) {
      const out: Row = {};
      for (const [key, want] of Object.entries(select)) {
        if (!want) continue;
        out[key] = row[key];
      }
      return out;
    }

    const out = { ...row };
    if (!include) return out;

    const model = MODELS.get(modelName);
    if (!model) return boom(`the model "${modelName}"`);

    for (const [key, spec] of Object.entries(include as Record<string, unknown>)) {
      if (!spec) continue;
      const field = model.fields.find((f) => f.name === key);
      if (!field || !MODELS.has(field.type)) {
        return boom(`an include of "${modelName}.${key}"`);
      }

      const other = MODELS.get(field.type);
      if (!other) return boom(`the model "${field.type}"`);
      /* `include: { unit: true }` and `include: { unit: { select } }` are the
         same request with and without options. */
      const opts = (spec === true ? {} : spec) as {
        include?: unknown; select?: unknown; where?: unknown; orderBy?: unknown;
      };

      if (field.relation?.fields) {
        /* This side holds the foreign key. */
        const fk = row[String(field.relation.fields[0])];
        const ref = String(field.relation.references?.[0] ?? "id");
        const found = fk == null ? null : rowsOf(field.type).find((r) => r[ref] === fk);
        out[key] = found ? hydrate(field.type, found, opts.include, opts.select) : null;
        continue;
      }

      /* The other side holds it. Pair by relation name when there is more
         than one link between the two models. */
      const back = other.fields.find(
        (f) => f.type === modelName && f.relation?.fields &&
               (!field.relation?.name || f.relation.name === field.relation.name));
      if (!back?.relation?.fields) {
        return boom(`the back-relation for "${modelName}.${key}"`);
      }

      const fkCol = String(back.relation.fields[0]);
      let kids = rowsOf(field.type).filter((r) => r[fkCol] === row["id"]);
      if (opts.where) kids = kids.filter((r) => matches(r, opts.where, other));
      if (opts.orderBy) kids = sortRows(kids, opts.orderBy);

      const first = kids[0];
      out[key] = field.list
        ? kids.map((r) => hydrate(field.type, r, opts.include, opts.select))
        : (first ? hydrate(field.type, first, opts.include, opts.select) : null);
    }
    return out;
  }

  function sortRows(rows: readonly Row[], orderBy: unknown): Row[] {
    const specs = asList(orderBy) as Record<string, unknown>[];
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

  function delegate(modelName: string) {
    const model = MODELS.get(modelName);
    const table = tables.get(modelName);
    /* Both came from MODELS above, so a name that reached here is one this
       fake knows — and a typo in a caller is named rather than read off
       undefined three frames later. */
    if (!model || !table) return boom(`the model "${modelName}"`);

    const find = (where?: unknown): Row[] =>
      rowsOf(modelName).filter((r) => matches(r, where, model));

    return {
      async findMany(args: QueryArgs = {}) {
        let rows = find(args.where);
        rows = args.orderBy ? sortRows(rows, args.orderBy) : rows;

        const cursor = args.cursor;
        if (cursor) {
          const at = rows.findIndex((r) => r["id"] === cursor["id"]);
          rows = at < 0 ? [] : rows.slice(at + (args.skip || 0));
        } else if (args.skip) {
          rows = rows.slice(args.skip);
        }
        if (args.take !== undefined) rows = rows.slice(0, args.take);

        return rows.map((r) => hydrate(modelName, r, args.include, args.select));
      },

      async findFirst(args: QueryArgs = {}) {
        const rows = args.orderBy ? sortRows(find(args.where), args.orderBy) : find(args.where);
        return rows.length ? hydrate(modelName, rows[0], args.include, args.select) : null;
      },

      async findUnique(args: QueryArgs = {}) {
        const rows = find(args.where);
        return rows.length ? hydrate(modelName, rows[0], args.include, args.select) : null;
      },

      async count(args: QueryArgs = {}) {
        return find(args.where).length;
      },

      async create(args: QueryArgs = {}) {
        /* Relations go one way and columns the other: a create may carry a
           whole company's worth of nested rows, and those are written after
           the parent exists. */
        const nested: Row = {};
        const data: Row = {};
        for (const [k, v] of Object.entries((args.data ?? {}) as Row)) {
          const f = model.fields.find((x) => x.name === k);
          if (f && MODELS.has(f.type)) nested[k] = v;
          else data[k] = v;
        }

        const row = applyDefaults(model, data);
        checkUnique(model, row);
        table.set(String(row[idOf(model)]), row);

        /* `create: { … }` and `create: [ … ]` on a relation — organizations.js
           builds a whole company in one call. */
        for (const [key, spec] of Object.entries(nested)) {
          const field = model.fields.find((f) => f.name === key);
          const other = field ? MODELS.get(field.type) : undefined;
          if (!field || !other) return boom(`a nested write on "${modelName}.${key}"`);

          const back = other.fields.find(
            (f) => f.type === modelName && f.relation?.fields &&
                   (!field.relation?.name || f.relation.name === field.relation.name));
          if (!back?.relation?.fields) {
            return boom(`a nested write on "${modelName}.${key}"`);
          }
          const fk = String(back.relation.fields[0]);

          for (const [op, payload] of Object.entries((spec ?? {}) as Row)) {
            if (op !== "create") boom(`the nested write "${op}"`);
            for (const one of asList(payload)) {
              await delegate(field.type).create({
                data: { ...(one as Row), [fk]: row[idOf(model)] },
              });
            }
          }
        }

        return hydrate(modelName, row, args.include, args.select);
      },

      async update(args: QueryArgs = {}) {
        const rows = find(args.where);
        if (!rows.length) {
          throw prismaError("P2025", "An operation failed because it depends on one or more records that were required but not found.");
        }
        const row = rows[0] as Row;
        const key = String(row[idOf(model)]);
        const next = { ...row, ...writeable(model, args.data, row) };
        checkUnique(model, next, key);
        table.set(key, next);
        return hydrate(modelName, next, args.include, args.select);
      },

      async updateMany(args: QueryArgs = {}) {
        const rows = find(args.where);
        for (const row of rows) {
          const key = String(row[idOf(model)]);
          const next = { ...row, ...writeable(model, args.data, row) };
          checkUnique(model, next, key);
          table.set(key, next);
        }
        return { count: rows.length };
      },

      async upsert(args: QueryArgs = {}) {
        const rows = find(args.where);
        if (rows.length) {
          return this.update({ where: args.where, data: args.update, include: args.include });
        }
        return this.create({ data: args.create, include: args.include });
      },

      async delete(args: QueryArgs = {}) {
        const rows = find(args.where);
        const gone = rows[0];
        if (!gone) throw prismaError("P2025", "Record to delete does not exist.");
        cascade(modelName, gone);
        table.delete(String(gone[idOf(model)]));
        return gone;
      },

      async deleteMany(args: QueryArgs = {}) {
        const rows = find(args.where);
        for (const r of rows) { cascade(modelName, r); table.delete(String(r[idOf(model)])); }
        return { count: rows.length };
      },
    };
  }

  /** `{ increment: 1 }` and friends, plus @updatedAt. */
  function writeable(model: ModelSpec, data: unknown, current?: Row): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(data || {})) {
      const f = model.fields.find((x) => x.name === k);
      if (!f) return boom(`a write to unknown field "${model.name}.${k}"`);
      if (MODELS.has(f.type)) boom(`a nested update on "${model.name}.${k}"`);

      if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
        const op = v as Record<string, unknown>;
        /* `increment` and `decrement` only ever apply to an existing row —
           `create` has no current value to move. */
        const was = Number(current?.[k] ?? 0);
        if ("increment" in op) { out[k] = was + Number(op["increment"]); continue; }
        if ("decrement" in op) { out[k] = was - Number(op["decrement"]); continue; }
        if ("set" in op) { out[k] = op["set"]; continue; }
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
  function cascade(modelName: string, row: Row): void {
    for (const [otherName, other] of MODELS) {
      for (const f of other.fields) {
        if (f.type !== modelName || !f.relation?.fields) continue;
        const fk = String(f.relation.fields[0]);
        const parent = MODELS.get(modelName);
        if (!parent) return boom(`the model "${modelName}"`);
        const mine = row[idOf(parent)];
        const kids = rowsOf(otherName).filter((r) => r[fk] === mine);
        if (!kids.length) continue;

        const otherKey = idOf(other);
        const rule = f.optional ? "SetNull" : "Cascade";
        const otherTable = tables.get(otherName);
        if (!otherTable) return boom(`the model "${otherName}"`);
        for (const kid of kids) {
          if (rule === "Cascade") {
            cascade(otherName, kid);
            otherTable.delete(String(kid[otherKey]));
          } else {
            otherTable.set(String(kid[otherKey]), { ...kid, [fk]: null });
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */

  /**
   * THE CLIENT ITSELF.
   *
   * One model accessor per model, added below the literal — which is why the
   * type carries an index signature. It is `unknown` rather than a delegate
   * type: the accessors are attached by name in a loop, and declaring them
   * individually would mean restating all 132 models here, which is the
   * hand-written copy of the schema this file exists to avoid.
   *
   * A test reaches them as `db.offer.findMany(...)`, and what it gets back
   * is the same shape the real client returns — a Row, checked by the
   * assertions the test then makes about it.
   */
  /* Built in two steps: the literal below, then one accessor per model. The
     cast is on the line before the loop that completes it. */
  const db = {
    async $queryRaw() { return [{ "?column?": 1 }]; },
    async $executeRaw() { return 0; },
    async $disconnect() {},
    async $transaction(arg: unknown) {
      /* No rollback. Every transaction in this service is a set of writes
         that either all make sense or none do, and the routes are what is
         under test — not Postgres's atomicity, which migration.test.js and
         the real end-to-end run cover. */
      if (typeof arg === "function") return arg(db);
      return Promise.all(arg as readonly unknown[]);
    },
    /** Everything in the store, for a test that wants to look directly. */
    __tables: tables,
    __reset() { for (const t of tables.values()) t.clear(); },
  };

  const client = db as unknown as FakeDb;
  for (const [accessor, modelName] of MODEL_BY_ACCESSOR) {
    client[accessor] = delegate(modelName) as FakeDelegate;
  }
  return client;
}

export { MODELS, MODEL_BY_ACCESSOR };
