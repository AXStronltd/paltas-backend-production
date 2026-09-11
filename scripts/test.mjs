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

if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  console.log(
    "  No TEST_DATABASE_URL — the tests that need a real PostgreSQL will skip.\n" +
    "  See RUN.md for the one-line way to start one.\n");
}

const child = spawn(process.execPath, args, {
  cwd: ROOT,
  stdio: "inherit",
  /* Node prints its own experimental warnings on stderr for every file;
     one line about a flag we deliberately chose is noise. */
  env: { ...process.env, NODE_NO_WARNINGS: "1" },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
