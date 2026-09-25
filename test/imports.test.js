/* ====================================================================== *
 * EVERY IMPORT NAMES A FILE THAT IS REALLY THERE.
 *
 * ── WHY THIS IS NOT ALREADY IMPLIED BY THE TESTS PASSING ───────────────
 *
 * It nearly is, and "nearly" is the problem. A broken specifier only fails
 * when something imports the module that contains it, and this service has
 * routes that no test imports directly — the suite reaches them through
 * createApp(), which imports everything, so most breakage does surface. Most.
 *
 * ── AND WHY IT MATTERS DURING THIS MIGRATION SPECIFICALLY ──────────────
 *
 * Node does NOT map `./errors.js` onto `errors.ts`. Verified: it throws
 * ERR_MODULE_NOT_FOUND, from a .js importer and from a .ts one alike. So the
 * moment a file is converted, every specifier naming it has to change too —
 * and there were twenty-eight of them for one small file.
 *
 * Missing one is not a subtle bug. It is a module that cannot load. But it is
 * a module that cannot load IN PRODUCTION, at import time, in a container that
 * then dies before it listens — which on Render looks exactly like "the push
 * did nothing", because the previous instance keeps serving.
 *
 * tsc catches this too, and this catches it in the same second as the edit,
 * for the test files that tsc is not asked to check.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { allSourceFiles, ROOT } from "./src-files.ts";
import { readdirSync } from "node:fs";

/** `from "./x.js"`, `from "../y/z.ts"` — static imports and re-exports. */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s+["'](\.[^"']+)["']/g;

/**
 * Comments do not import anything.
 *
 * This file's own prose names `./x.js` as an example, and the first version
 * of this scanner reported itself. Blanking comments while keeping the line
 * count is the same trick tenancy.test.js uses, and for the same reason: a
 * false alarm is what gets a test deleted.
 */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function specifiersIn(raw) {
  const text = code(raw);
  const out = [];
  for (const m of text.matchAll(SPECIFIER)) out.push(m[1]);
  /* Dynamic imports too — `await import("./x.js")` is just as breakable. */
  for (const m of text.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

function unresolved(files) {
  const bad = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const spec of specifiersIn(text)) {
      const target = resolve(dirname(file), spec);
      if (existsSync(target)) continue;
      /*
       * A directory import resolves through its index, which this service
       * does not use — but checking costs nothing and a false alarm here
       * would be the kind that gets a test deleted.
       */
      if (existsSync(join(target, "index.js")) || existsSync(join(target, "index.ts"))) continue;
      bad.push(`${file.replace(ROOT + "/", "")} imports "${spec}", which does not exist`);
    }
  }
  return bad;
}

test("every relative import in src/ names a file that exists", () => {
  const bad = unresolved(allSourceFiles());
  assert.deepEqual(bad, [],
    "These specifiers point at nothing:\n  " + bad.join("\n  ") +
    "\n\n  During the TypeScript migration this is almost always a file that " +
    "became .ts while an importer still says .js. Node does not map one onto " +
    "the other — it throws ERR_MODULE_NOT_FOUND at import time, which in a " +
    "container means it dies before it listens.");
});

test("every relative import in test/ names a file that exists", () => {
  /*
   * The tests are not compiled, so tsc never checks these. This is the only
   * thing that does — and the test suite reads src/ by path in 29 files, so
   * it is not a small surface.
   */
  const files = readdirSync(join(ROOT, "test"))
    .filter((f) => f.endsWith(".js") || f.endsWith(".ts"))
    .map((f) => join(ROOT, "test", f));
  assert.ok(files.length > 50, `only ${files.length} test files found — wrong directory?`);

  const bad = unresolved(files);
  assert.deepEqual(bad, [], "These specifiers point at nothing:\n  " + bad.join("\n  "));
});

test("the scanner is actually reading specifiers", () => {
  /*
   * The vacuous-pass defence, again. A regex that stopped matching would
   * report every file as clean, and this whole file would be a green tick
   * over nothing.
   */
  const counted = allSourceFiles()
    .reduce((n, f) => n + specifiersIn(readFileSync(f, "utf8")).length, 0);
  assert.ok(counted > 150,
    `only ${counted} relative imports were found across src/ — the pattern has ` +
    "stopped matching and this file is checking nothing");
});
