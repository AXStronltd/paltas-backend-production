#!/usr/bin/env node
/* ====================================================================== *
 * RENAME ONE MODULE TO .ts, AND FIX EVERY SPECIFIER THAT NAMED IT.
 *
 *     node scripts/to-typescript.mjs src/config.js
 *
 * ── WHY THIS IS A SCRIPT AND NOT A SEQUENCE OF SED COMMANDS ────────────
 *
 * Because it has to happen about seventy more times, and the failure mode
 * of getting it wrong is not a type error. Node does not map `./config.js`
 * onto `config.ts` — it throws ERR_MODULE_NOT_FOUND at IMPORT time, which in
 * a container means the process dies before it listens, and on Render that
 * looks exactly like a push that did nothing.
 *
 * So the one mechanical step that must never be skipped is done by something
 * that cannot forget it, and test/imports.test.js proves the result.
 *
 * It does NOT convert the code. It moves the file and rewrites the
 * specifiers; adding types is the part that needs a person.
 * ====================================================================== */

import { readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/to-typescript.mjs src/path/to/module.js");
  process.exit(1);
}

const from = resolve(ROOT, target);
if (!existsSync(from)) {
  console.error(`${target} does not exist`);
  process.exit(1);
}
if (!from.endsWith(".js")) {
  console.error(`${target} is not a .js file`);
  process.exit(1);
}
const to = from.replace(/\.js$/, ".ts");
if (existsSync(to)) {
  /* Both would mean two versions of one module, one of them dead and still
     looking correct. test/src-files.js refuses this too. */
  console.error(`${relative(ROOT, to)} already exists — one of the two is dead code`);
  process.exit(1);
}

/** Every .js and .ts under a directory. */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); continue; }
    if (p.endsWith(".js") || p.endsWith(".ts") || p.endsWith(".mjs")) out.push(p);
  }
  return out;
}

renameSync(from, to);

/*
 * A specifier names the module RELATIVE TO THE FILE THAT WRITES IT, so the
 * same module is "./config.js" here and "../../config.js" there. Rewriting by
 * text alone would need one pattern per depth; resolving each specifier and
 * comparing paths needs none, and cannot match something that merely looks
 * similar.
 */
const searched = [join(ROOT, "src"), join(ROOT, "test"), join(ROOT, "scripts")];
const files = searched.filter(existsSync).flatMap((d) => walk(d));

let changed = 0;
let rewritten = 0;
const spec = /(["'])(\.[^"']*?)\.js\1/g;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  let touched = false;

  const next = text.replace(spec, (whole, quote, path) => {
    const points = resolve(dirname(file), path + ".js");
    if (points !== from) return whole;
    touched = true;
    rewritten += 1;
    return `${quote}${path}.ts${quote}`;
  });

  if (touched) {
    writeFileSync(file, next);
    changed += 1;
  }
}

console.log(`${relative(ROOT, from)} -> ${relative(ROOT, to)}`);
console.log(`${rewritten} specifier${rewritten === 1 ? "" : "s"} updated across ${changed} file${changed === 1 ? "" : "s"}`);
console.log("\nnow: add the types, then");
console.log("  npm run typecheck && npm test");
