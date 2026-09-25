/* ====================================================================== *
 * WHERE THE SOURCE IS, AND WHAT IT IS CALLED THIS WEEK.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────
 *
 * Twenty-nine test files in this suite read the service's own source AS
 * TEXT. They are the ones that prove things no runtime test can: that every
 * query is scoped to one company, that no hand-written route is shadowed by
 * a generated one, that every file the server reads is copied into the
 * image. They are the most valuable tests here.
 *
 * Every one of them filtered on `.js`.
 *
 * That was fine while the service was JavaScript and becomes a quiet
 * disaster the moment any of it is not: a scanner that filters `.js` over a
 * directory of `.ts` files does not fail. It finds nothing, checks nothing,
 * and PASSES — and the tenancy scanner is the one standing between one
 * company and another company's data.
 *
 * So the extension lives in exactly one place now, and every scanner asks
 * this file rather than deciding for itself.
 *
 * ── AND WHY EACH FUNCTION REFUSES AN EMPTY RESULT ──────────────────────
 *
 * Because the failure above is invisible by construction. A scanner that
 * checked nothing reports the same green tick as one that checked seventy
 * files, and nobody reads a green tick closely. Every function below throws
 * when it finds nothing, so the loud failure happens here instead of the
 * silent one happening everywhere.
 *
 * NOTHING HERE POINTS AT THE FRONTEND. That repository stays JavaScript,
 * and `frontend-contract.test.js` reads its assets with its own `.js`
 * filter on purpose.
 * ====================================================================== */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root, and the service's source directory. */
export const ROOT = join(HERE, "..");
export const SRC = join(ROOT, "src");

/**
 * The extensions a source file may have.
 *
 * `.js` first, deliberately: while the service is mostly JavaScript that is
 * the common case, and during the migration a module may briefly exist as
 * both — in which case reading the one that is actually imported matters.
 * Node resolves the specifier in the import, so whichever the code says is
 * the one that runs; this order only decides which a scanner reads first,
 * and `sourceText` below refuses outright if both are present.
 */
export const SOURCE_EXTENSIONS = [".js", ".ts"];

const isSource = (name) => SOURCE_EXTENSIONS.some((e) => name.endsWith(e));

/**
 * Read one source file by name, whatever it is written in.
 *
 * `sourceText("routes", "products.js")` finds `routes/products.js` or
 * `routes/products.ts`. The `.js` in the argument is a convenience, not a
 * claim — callers name the module and this decides the rest.
 */
export function sourceText(...parts) {
  const path = resolveSource(...parts);
  return readFileSync(path, "utf8");
}

/** The path `sourceText` would read, for a test that wants to name it. */
export function resolveSource(...parts) {
  const rel = join(...parts);
  const base = join(SRC, rel).replace(/\.(js|ts)$/, "");
  const found = SOURCE_EXTENSIONS
    .map((e) => base + e)
    .filter((p) => existsSync(p));

  if (!found.length) {
    throw new Error(
      `No source file at ${rel} (tried ${SOURCE_EXTENSIONS.join(" and ")}). ` +
      `If it was renamed or deleted, the test naming it has to be updated — ` +
      `which is the loud failure this is meant to be.`);
  }
  /*
   * BOTH would mean two versions of one module, one of which is dead and
   * neither of which a reader can identify. During a migration that is the
   * single easiest mistake to make and the hardest to see.
   */
  if (found.length > 1) {
    throw new Error(
      `${rel} exists as BOTH ${SOURCE_EXTENSIONS.join(" and ")}. One of them is ` +
      `dead code that still looks correct. Delete the one nothing imports.`);
  }
  return found[0];
}

/**
 * Every source file directly inside one directory under `src/`.
 *
 * Not recursive — `sourceFiles("routes")` is the routes, not the routes and
 * everything below them. `allSourceFiles()` is the recursive one.
 */
export function sourceFiles(...parts) {
  const dir = join(SRC, ...parts);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(
      `No directory at src/${join(...parts)}. A scanner pointed at a directory that ` +
      `does not exist finds nothing, and finding nothing is how a guard passes without ` +
      `checking anything.`);
  }
  const found = entries.filter(isSource).map((f) => join(dir, f));
  if (!found.length) {
    throw new Error(
      `No source files in src/${join(...parts)}. A scanner that finds nothing ` +
      `reports the same green tick as one that checked seventy files, so this ` +
      `refuses rather than passing quietly.`);
  }
  return found;
}

/** Every source file anywhere under `src/`, with its path. */
export function allSourceFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (isSource(entry.name)) found.push(p);
    }
  };
  walk(SRC);
  if (!found.length) {
    throw new Error("No source files under src/ at all — the scanner is looking in the wrong place.");
  }
  return found;
}

/*
 * ── AND THE SECOND HALF OF THE SAME PROBLEM ────────────────────────────
 *
 * Reading a file by name whatever its extension was only half of it. The
 * scanners also COMPARE names: the tenancy scanner's exemption list says
 * `file: "comms-webhook.js"` and matches it against what readdir returned.
 *
 * That half was missed, and it surfaced the first time a named file became
 * TypeScript — the exemption stopped matching, the scanner reported a
 * cross-tenant query in a file that had not changed a character, and the
 * suite went red.
 *
 * RED IS THE SAFE DIRECTION and it is why this was a ten-minute fix rather
 * than a silent hole. The comparison at line 437 of tenancy.test.js is the
 * dangerous shape of the same bug: `if (name === "platform.js") continue`
 * SKIPS, so the mismatch there would have started checking a file that is
 * cross-tenant by design and buried the real finding in false ones.
 *
 * So names are compared here too, in one place, by the same rule.
 */

/** "comms-webhook.js" and "comms-webhook.ts" are the same source file. */
export function sameSource(a, b) {
  return baseName(a) === baseName(b);
}

/** A source file's name without whichever extension it is written in. */
export function baseName(name) {
  return String(name).replace(/\.(js|ts)$/, "");
}
