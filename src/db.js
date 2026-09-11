import { PrismaClient } from "@prisma/client";

/*
 * One client for the process. Prisma opens a connection pool; making a second
 * client makes a second pool, and on a small Render instance that is how you
 * run a database out of connections without a single extra user arriving.
 */
export const db = new PrismaClient({
  log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"],
});

export async function closeDb() {
  await db.$disconnect();
}
