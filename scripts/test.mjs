#!/usr/bin/env node
/* ====================================================================== *
 * `npm test`, on whatever Node you happen to have.
 *
 * Some of this suite runs the real Express app against an in-memory
 * stand-in for Prisma, which needs Node's module mocking:
 *
 *     node --experimental-test-module-mocks --test test/*.test.js
 *
 * That flag arrived in Node 22.3. On anything older, Node does not ignore
 * it — it refuses to start at all:
 *
 *     node: bad option: --experimental-test-module-mocks
 *
 * `npm test` would then fail instantly, every test would appear broken,
 * and the cause would be the runner rather than a single line of this
 * service. So the flag is added only when it will be understood, and when
 * it is not, the files that need it skip themselves and say so.
 *
 * frontend-contract.test.js is the same arrangement for the OTHER repository:
 * it loads the frontend's real script tags under a small DOM and checks the
 * two repositories still agree. It looks for `../paltas-frontend 2` beside
 * this one, or wherever PALTAS_FRONTEND points, and skips when neither is
 * there — a backend checkout on its own is not a broken backend.
 *
 * Everything else — the schema against a real PostgreSQL, the rules, the
 * contract coverage — runs on any Node 18 or later.
 * ====================================================================== */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Node 22.3.0 is where `mock.module()` landed. */
function supportsModuleMocks() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 3);
}

const files = readdirSync(join(ROOT, "test"))
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => join("test", f))
  .sort();

const args = ["--test", ...files];
const mocks = supportsModuleMocks();
if (mocks) args.unshift("--experimental-test-module-mocks");

if (!mocks) {
  console.log(
    "\n  Node " + process.versions.node + " cannot mock modules " +
    "(needs 22.3 or later).\n" +
    "  The tests that run the real app against an in-memory database will\n" +
    "  skip. Everything else runs. Upgrading Node turns them back on.\n");
}

/* ====================================================================== *
 * A URL THAT IS SET IS NOT A DATABASE THAT WORKS.
 *
 * This used to check only whether the variable EXISTED. A placeholder then
 * sailed straight through — and
 *
 *     DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
 *
 * is a real thing to have in a shell, left behind by a deploy guide. Every
 * file that needs a database then tried to connect, and the run ended in
 * dozens of failures reading
 *
 *     code: 28000   routine: InitializeSessionUserId
 *
 * which is PostgreSQL saying THE ROLE DOES NOT EXIST. A configuration
 * problem, reported as though the product were broken — and the "this will
 * skip" notice never printed, because the variable was set.
 *
 * So the connection is tried once, here. When it does not work, the tests
 * that need it skip and the reason is printed in full: the role, the host,
 * and what to do. Nothing is hidden and nothing is weakened — the tests are
 * not made to pass, they are made to say honestly that they did not run.
 * ====================================================================== */

const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
let database = false;

if (!dbUrl) {
  console.log(
    "  No TEST_DATABASE_URL — the tests that need a real PostgreSQL will skip.\n" +
    "  See RUN.md for the one-line way to start one.\n");
} else {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    database = true;
  } catch (e) {
    const { explain, redact } = await import("../test/db-help.js");
    const help = explain(e, dbUrl);
    console.log("\n" + "─".repeat(72));
    console.log(help || `Could not use the database at ${redact(dbUrl)}:\n  ${e.message}`);
    console.log("─".repeat(72));
    console.log(
      "\n  So the tests that need a real PostgreSQL will SKIP rather than fail.\n" +
      "  Everything else runs. Fix the setting above and they come back.\n");
  }
}

/* Hidden from the children when it does not work, so they take the same
   skip path as a machine with no database at all — rather than each one
   rediscovering the same broken connection and failing differently. */
const env = { ...process.env, NODE_NO_WARNINGS: "1" };
if (!database) {
  delete env.TEST_DATABASE_URL;
  delete env.DATABASE_URL;
}

const child = spawn(process.execPath, args, {
  cwd: ROOT,
  stdio: "inherit",
  /* Node prints its own experimental warnings on stderr for every file;
     one line about a flag we deliberately chose is noise. */
  env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
