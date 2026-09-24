import { PrismaClient } from "@prisma/client";

import type { ModelKey } from "./domain/registry-types.ts";

/* ====================================================================== *
 * THE DATABASE.
 *
 * ONE CLIENT FOR THE PROCESS. Prisma opens a connection pool; a second
 * client opens a second pool, and on a small Render instance that is how a
 * database runs out of connections without a single extra user arriving.
 *
 * ── WHY NOT THE `pg` DRIVER ADAPTER ────────────────────────────────────
 *
 * Prisma can talk to Postgres through node-postgres instead of its own
 * native query-engine binary, which would remove a 15 MB download from the
 * image build and the openssl dependency from the container. That is
 * genuinely tempting on this project, where a Prisma engine has already
 * cost a deploy once.
 *
 * It is not done here, for one reason: it could not be tested. The
 * environment this was written in cannot reach binaries.prisma.sh at all,
 * so `prisma generate` never completed and the adapter path never ran.
 * Putting an unverified change on the path every single request takes —
 * to save a download — is the trade the wrong way round.
 *
 * So this is the ordinary, well-trodden setup, which works wherever the
 * engine can be fetched, and Render can fetch it. If the adapter is wanted
 * later it is a small change to this file plus `previewFeatures =
 * ["driverAdapters"]` in the schema — made somewhere it can be run first.
 *
 * `DB_POOL_MAX` is worth knowing about before it bites: Render's starter
 * Postgres allows a modest number of connections, shared with the migration
 * that runs at container start and any psql session left open. Prisma's
 * default pool can be larger than is wise there.
 * ====================================================================== */

/**
 * The client every module in this service shares.
 *
 * ITS TYPE IS THE POINT OF THE WHOLE MIGRATION. `db` is imported by 36
 * modules, and from here on every one of them gets a checked answer: a
 * misspelt column, a `where` on a field that is not there, a `select` that
 * cannot produce the field a caller then reads — all of them stop compiling
 * rather than failing on whichever request reaches them first.
 *
 * Nothing about the runtime behaviour changes. Prisma generated these types
 * all along; nothing was asking for them.
 */
export const db = new PrismaClient({
  log: process.env["PRISMA_LOG"] === "1" ? ["query", "warn", "error"] : ["warn", "error"],
});

/**
 * The type of that client, for anything that needs to name it.
 *
 * Exported because the framework reaches models through a variable —
 * `db[resource.model]` — and typing that needs something to key off. It is
 * also what a test double would have to satisfy; see the note in
 * test/fake-prisma.js about why the in-memory stand-in does not try.
 */
export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await db.$disconnect();
}

/* ====================================================================== *
 * REACHING A MODEL CHOSEN AT RUN TIME.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS HERE AND NOWHERE ELSE ───────────────
 *
 * The resource framework is generic over 132 models by construction: one
 * declaration names `model: "rfi"` and the same forty lines of code then
 * serve rfis, tasks, defects and everything else. So it has to reach
 * `db.rfi` through a variable, and no amount of care makes
 * `db[someModelName].findFirst(args)` type-check on its own — Prisma gives
 * every model its own argument types, and indexing by a union of 132 keys
 * produces a union of 132 incompatible signatures that no call can satisfy.
 *
 * This is the one place in the service where that is resolved, and it is
 * resolved with ONE cast rather than an `any` spread through the framework:
 *
 *   - the shape below names ONLY the six methods the framework actually
 *     calls, so it is a promise about a small surface rather than about
 *     Prisma;
 *   - everything comes back as `Record<string, unknown>`, NOT `any`, so
 *     every caller still has to narrow what it reads. An `any` here would
 *     have silently become the type of every row in the service.
 *
 * ── AND IT IS FENCED ───────────────────────────────────────────────────
 *
 * Exporting this makes it reachable from anywhere, which would be a way to
 * query a model without the scoping scanner being able to see which table
 * was touched. test/tenancy.test.js refuses `delegate(` outside the
 * framework for exactly that reason — the same rule it already applies to
 * `db[…]`, and the reason this replaced it: dynamic access used to happen in
 * two files and now happens in one.
 * ====================================================================== */

/** A row as the framework sees it: columns it cannot know, values it must narrow. */
export type Row = Record<string, unknown>;

/** The six methods the resource framework calls, and nothing else. */
export interface ModelDelegate {
  findMany(args?: unknown): Promise<Row[]>;
  findFirst(args?: unknown): Promise<Row | null>;
  create(args: unknown): Promise<Row>;
  updateMany(args: unknown): Promise<{ count: number }>;
  deleteMany(args: unknown): Promise<{ count: number }>;
  count(args?: unknown): Promise<number>;
}

/**
 * `delegate("rfi")` is `db.rfi`, narrowed to what the framework uses.
 *
 * The model name is typed, so a misspelt one is still a compile error — the
 * cast gives up the ARGUMENT types, not the model list.
 */
export function delegate(model: ModelKey): ModelDelegate {
  const client = db as unknown as Record<ModelKey, ModelDelegate>;
  const found = client[model];
  if (!found) {
    /* Unreachable while ModelKey comes from Prisma's own generated names, and
       worth saying out loud anyway: a stale client is how that stops being
       true, and registry.test.js checks the two lists agree. */
    throw new Error(`the Prisma client has no model "${model}" — run \`prisma generate\``);
  }
  return found;
}
