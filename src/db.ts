import { PrismaClient } from "@prisma/client";

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
