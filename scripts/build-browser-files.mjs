// Generates the browser copies of shared TypeScript code into browser/, so the HTML workspaces and the server run
// the SAME code:
//   browser/entitlements.js      ← contracts/src/entitlements/rules.ts   (global PaltasEntitlements)
//   browser/paltas-api-client.js ← api-client/src                         (global PaltasApi; for connecting the pages to the API)
// The front-end repository (AXStronltd/paltas-frontend) keeps an identical copy of each file in its shared/ folder:
// after changing the rules, copy both files there and rebuild the pages (source/build.sh inlines entitlements.js).
//
//   node scripts/build-browser-files.mjs           write the files (run `npm run build` first)
//   node scripts/build-browser-files.mjs --check   fail if a committed file is out of date
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const check = process.argv.includes("--check");

const TARGETS = [
  {
    entry: here("../contracts/dist/entitlements/rules.js"),
    out: here("../browser/entitlements.js"),
    global: "PaltasEntitlements",
    about:
      "PALTAS entitlement rules: ONE implementation shared by the browser workspaces (front end: shared/entitlements.js,\n" +
      "   inlined into platform.js by source/build.sh) and the PALTAS server, which imports the TypeScript source directly.",
    source: "paltas-backend-production contracts/src/entitlements/rules.ts",
    minify: false,
  },
  {
    entry: here("../api-client/dist/browser.js"),
    out: here("../browser/paltas-api-client.js"),
    global: "PaltasApi",
    about: "Typed PALTAS API client for the browser workspaces (not yet wired into the pages).",
    source: "paltas-backend-production api-client/src",
    minify: true,
  },
];

async function generate(t) {
  const result = await build({
    entryPoints: [t.entry],
    bundle: true,
    format: "iife",
    globalName: "__paltasBundle",
    platform: "browser",
    target: "es2019",
    write: false,
    legalComments: "none",
    minify: t.minify,
  });
  const body = result.outputFiles[0].text;
  return (
    `/* GENERATED FILE — do not edit. Source: ${t.source}\n` +
    `   Rebuild in the backend repository with: npm run browser:build (writes browser/), then copy to the front end's shared/\n` +
    `   ${t.about} */\n` +
    `(function (root) {\n` +
    `${body}` +
    `  var api = Object.assign({}, __paltasBundle);\n` +
    `  if (typeof module === "object" && module && module.exports) module.exports = api;\n` +
    `  if (root) root.${t.global} = api;\n` +
    `})(typeof self !== "undefined" ? self : this);\n`
  );
}

let stale = 0;
for (const t of TARGETS) {
  const next = await generate(t);
  const now = await readFile(t.out, "utf8").catch(() => "");
  if (check) {
    if (now !== next) {
      stale++;
      console.error(`Out of date: ${t.out} — run: npm run browser:build`);
    }
  } else if (now !== next) {
    await writeFile(t.out, next);
    console.warn(`Wrote ${t.out}`);
  }
}
if (stale) process.exit(1);
