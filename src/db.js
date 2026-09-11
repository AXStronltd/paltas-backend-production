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

export const db = new PrismaClient({
  log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"],
});

export async function closeDb() {
  await db.$disconnect();
}
