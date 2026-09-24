/* ====================================================================== *
 * THE BUILD, AND THE ONE THING ABOUT IT THAT CAN STOP THE CONTAINER.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────
 *
 * `src/domain/market.js` reads `contract/market-config.js` with readFileSync
 * AT IMPORT TIME, and it resolves the path relative to its own module:
 *
 *     const HERE = dirname(fileURLToPath(import.meta.url));
 *     join(HERE, "..", "..", "contract", "market-config.js")
 *
 * That is correct from `src/domain/` and correct from `dist/domain/` — and
 * wrong from `dist/src/domain/`, which is exactly what TypeScript emits if
 * `rootDir` is ever widened to include a file outside `src/`. tsc does that
 * silently: adding one test or script to the program moves every output file
 * down a level and says nothing.
 *
 * The failure is not a type error or a failing request. It is a container
 * that throws ENOENT on import and dies before it listens — which on Render
 * looks identical to "the push did nothing", because the previous instance
 * keeps serving.
 *
 * So the depth is asserted here rather than discovered there.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/*
 * READ BY TYPESCRIPT, NOT BY A REGEX.
 *
 * tsconfig.json carries comments, so JSON.parse cannot read it — and the
 * obvious workaround is worse than it looks. Stripping /* … *\/ with a regex
 * ate the middle of this very file's own `"src/**\/*"` glob, because that
 * string contains something a comment-stripper reads as an empty block
 * comment. The test then reported `["src*"]` and failed for a reason that had
 * nothing to do with the code.
 *
 * TypeScript is a dependency now, so its own parser does it correctly.
 */
const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config;

test("the compiler is pinned to the depth the runtime file read depends on", () => {
  const o = config.compilerOptions;
  assert.equal(o.rootDir, "src",
    'rootDir must be "src". Anything else moves dist/domain/market.js to a ' +
    "different depth, and its readFileSync of contract/market-config.js then " +
    "resolves one level wrong — a container that dies on import.");
  assert.equal(o.outDir, "dist", "outDir must be dist/, which is what the image copies");

  /* And the program must not reach outside src/, because that is what widens
     rootDir without anybody asking for it. */
  assert.deepEqual(config.include, ["src/**/*"],
    "the program includes something outside src/, which silently changes rootDir");
  for (const outside of ["test", "scripts", "prisma"]) {
    assert.ok((config.exclude || []).includes(outside),
      `${outside}/ is not excluded, so a stray import from it would widen rootDir`);
  }
});

test("the emitted tree mirrors the source tree, file for file", { skip: skipUnbuilt() }, () => {
  /*
   * Not a count — a path-by-path comparison. A count can match while two files
   * have swapped depth, and depth is the whole point.
   */
  const srcFiles = walk(join(ROOT, "src")).map((p) => relative(join(ROOT, "src"), p));
  const distFiles = walk(join(ROOT, "dist"))
    .map((p) => relative(join(ROOT, "dist"), p))
    .filter((p) => !p.endsWith(".map"));

  const expected = srcFiles.map((p) => p.replace(/\.ts$/, ".js")).sort();
  assert.deepEqual(distFiles.sort(), expected,
    "dist/ does not mirror src/. Every path must match, because the service " +
    "resolves at least one runtime file relative to its own module.");
});

test("the compiled market module still finds the contract file", { skip: skipUnbuilt() }, () => {
  /*
   * The assertion that actually matters, done by arithmetic rather than by
   * trusting the two tests above: from wherever the compiled module lands,
   * `../../contract/market-config.js` must be the real one.
   */
  const compiled = join(ROOT, "dist", "domain", "market.js");
  assert.ok(existsSync(compiled), "dist/domain/market.js was not emitted");

  const resolved = join(dirname(compiled), "..", "..", "contract", "market-config.js");
  assert.ok(existsSync(resolved),
    `the compiled market module resolves its contract file to ${relative(ROOT, resolved)}, ` +
    "which does not exist. The container would throw ENOENT on import and die " +
    "before it listened.");
});

/* ---------------------------------------------------------------- */

/**
 * `npm test` runs on a checkout that may never have been built, and a test
 * that fails because nobody ran `tsc` is a test that gets ignored. CI builds
 * the image, which builds the source, so the real enforcement happens there.
 */
function skipUnbuilt() {
  return existsSync(join(ROOT, "dist", "server.js"))
    ? false
    : "dist/ has not been built — run `npm run build` (CI does, via docker build)";
}

function walk(dir) {
  const out = [];
  const go = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { go(p); continue; }
      if (p.endsWith(".js") || p.endsWith(".ts")) out.push(p);
    }
  };
  go(dir);
  return out;
}
