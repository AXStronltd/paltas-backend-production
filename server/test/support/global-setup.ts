/*
 * Runs once before all tests: builds a template database (migrations + catalogue). Each test file then gets its
 * own copy (CREATE DATABASE … TEMPLATE), so tests are isolated and can run in parallel.
 *
 * Needs a PostgreSQL server. Set PALTAS_TEST_PG to an admin connection URL, e.g.
 *   PALTAS_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres
 * (default: postgres://paltas@127.0.0.1:55432/postgres — the throw-away cluster scripts/local-postgres.sh starts).
 */
import pg from "pg";
import { connect } from "../../dist/db/database.js";
import { migrate } from "../../dist/db/migrate.js";
import { seedCatalogue } from "../../dist/core/catalogue/catalogue.seed.js";

/** Each test run gets its own template, so two runs at the same time never drop each other's. */
export const templateName = () => process.env.PALTAS_TEST_TEMPLATE ?? "paltas_test_template";
export function safeTestAdminUrl(value: string): string {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Database tests require an isolated PostgreSQL server on localhost");
  }
  return url.toString();
}
export const adminUrl = () =>
  safeTestAdminUrl(process.env.PALTAS_TEST_PG ?? "postgres://paltas@127.0.0.1:55432/postgres");
export const dbUrl = (name: string) => {
  const u = new URL(adminUrl());
  u.pathname = "/" + name;
  return u.toString();
};

export default async function setup() {
  // set before the test workers start, so they inherit it
  process.env.PALTAS_TEST_TEMPLATE = `paltas_test_template_${process.pid}_${Date.now().toString(36)}`;
  const TEMPLATE = templateName();
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect().catch((e: Error) => {
    throw new Error("Tests need isolated local PostgreSQL (set PALTAS_TEST_PG)", { cause: e });
  });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE}`);
  } finally {
    await admin.end();
  }
  const db = connect(dbUrl(TEMPLATE), 1);
  try {
    await migrate(db);
    await seedCatalogue(db);
  } finally {
    await db.close();
  }
  return async () => {
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
    await a.end();
  };
}
