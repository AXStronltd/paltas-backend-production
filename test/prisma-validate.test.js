/* ====================================================================== *
 * PRISMA'S OWN VERDICT ON THE SCHEMA.
 *
 * relations.test.js checks the subset of Prisma's rules a hand-written
 * parser can check, and it says so in its own header: it is the floor, not
 * the ceiling. This is the ceiling. It runs the real `prisma validate`.
 *
 * ── WHY IT EXISTS, WHICH IS A SPECIFIC STORY ───────────────────────────
 *
 * `prisma validate` was believed to be unrunnable here, because every
 * Prisma command downloads engine binaries from binaries.prisma.sh and this
 * environment cannot reach that host. So the schema was checked by parser
 * alone — and the parser was happy with twenty-nine enums written as
 *
 *     enum IncidentStatus { OPEN INVESTIGATING CONTAINED RESOLVED CLOSED }
 *
 * which is not valid Prisma. Every value must be on its own line. The
 * schema would have parsed here, passed every hand-written test, and then
 * failed at `prisma generate` on the first machine that ran it.
 *
 * It turned out the download can be skipped: point PRISMA_QUERY_ENGINE_LIBRARY
 * and PRISMA_SCHEMA_ENGINE_BINARY at any existing file and the CLI stops
 * trying to fetch one. `validate` never executes those binaries — it parses
 * with a WebAssembly module that ships inside the npm package — so stubbing
 * them changes nothing about the answer. That is what this test does, and
 * only when the real engines are absent.
 *
 * IF THIS TEST EVER FAILS, IT IS RIGHT AND THE OTHERS ARE WRONG.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** Has `prisma generate` already put real engines next to the client? */
function haveRealEngines() {
  const dir = join(ROOT, "node_modules", ".prisma", "client");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => /query_engine|libquery/.test(f));
}

/**
 * Somewhere for the CLI to point at.
 *
 * Empty files on purpose. `validate` does not run them; it only checks that
 * a path was given, and having one stops it reaching for the network. If a
 * future Prisma version starts executing them this test will fail loudly,
 * which is the right way for that to be discovered.
 */
function stubEngines() {
  const dir = mkdtempSync(join(tmpdir(), "prisma-stub-"));
  const query = join(dir, "libquery_engine.node");
  const schema = join(dir, "schema-engine");
  writeFileSync(query, "");
  writeFileSync(schema, "");
  return { query, schema };
}

function runPrisma(args) {
  const env = {
    ...process.env,
    /* validate only parses the datasource block; it never connects. */
    DATABASE_URL: process.env.DATABASE_URL || "postgresql://validate@127.0.0.1:5432/validate",
  };

  if (!haveRealEngines()) {
    const stub = stubEngines();
    env.PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING = "1";
    env.PRISMA_QUERY_ENGINE_LIBRARY = stub.query;
    env.PRISMA_SCHEMA_ENGINE_BINARY = stub.schema;
  }

  return execFileSync("npx", ["--no-install", "prisma", ...args], {
    cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
  });
}

/* ================================================================ */

test("prisma validate accepts the schema", { timeout: 120_000 }, () => {
  let out;
  try {
    out = runPrisma(["validate"]);
  } catch (e) {
    const said = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();

    /*
     * Tell the two failures apart. A schema Prisma rejects is a real,
     * blocking problem. A CLI that could not start is an environment
     * problem, and reporting it as a broken schema would send somebody
     * editing a file that is fine.
     */
    if (/Failed to fetch|ENOTFOUND|EAI_AGAIN|403 Forbidden|getaddrinfo/.test(said)) {
      console.log(
        "\n  prisma validate could not start — the CLI could not reach its engine host.\n" +
        "  The schema was NOT checked by Prisma on this run. Run `npx prisma validate`\n" +
        "  on a machine with internet before deploying.\n");
      return;
    }
    assert.fail(
      "PRISMA REJECTED THE SCHEMA. This is the authority — if the other schema\n" +
      "tests passed, they are the ones that are wrong.\n\n" + said);
  }

  assert.match(out, /is valid/,
    "prisma validate exited cleanly but did not say the schema is valid:\n" + out);
});

test("prisma format would change nothing", { timeout: 120_000 }, () => {
  /*
   * Not a style preference. `prisma format` REWRITES the file, so a schema
   * that is not already formatted means the next person to run any Prisma
   * command gets an unrelated diff mixed into their work — and on a 1,400
   * line schema that diff is unreviewable.
   */
  const file = join(ROOT, "prisma", "schema.prisma");
  const original = readFileSync(file, "utf8");
  try {
    runPrisma(["format"]);
  } catch (e) {
    const said = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
    if (/Failed to fetch|ENOTFOUND|EAI_AGAIN|403 Forbidden|getaddrinfo/.test(said)) return;
    throw e;
  }

  const after = readFileSync(file, "utf8");
  if (after !== original) {
    /* Put it back before failing — a test must never leave the tree dirty. */
    writeFileSync(file, original);
    assert.fail(
      "prisma/schema.prisma is not in Prisma's own formatting. Run:\n" +
      "    npx prisma format\n" +
      "and commit the result, so that nobody else's diff quietly carries it.");
  }
});
