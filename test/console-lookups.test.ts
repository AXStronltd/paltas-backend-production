/* ======================================================================
 * A PICKER OFFERS WHAT THE COMPANY ACTUALLY HAS.
 *
 * Adding `siteId` to the buildings form put a "Property" dropdown on screen,
 * and it offered "No property yet" to a company with a property. The field
 * was right; the list behind it was never loaded.
 *
 * Each screen hydrates the arrays IT displays, so the Buildings screen has
 * BUILDINGS and has never heard of PROPS. A create form's pickers read other
 * screens' arrays, so opening one has to ask for them.
 *
 * The failure mode is quiet and expensive: the control looks finished, the
 * customer concludes they have not created the parent record yet, and goes
 * and makes a second one.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";
import { CONSOLE_FORMS } from "../src/domain/console-map.ts";
import { RESOURCES } from "../src/domain/registry.ts";
import type { Foreign } from "./wire.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const file = join(FE, "assets", "console.js");
const skip = existsSync(file) ? false : `no frontend at ${FE}`;

/** The lookup names the API will actually send, from the registry itself. */
function lookupsInUse(): string[] {
  const out = new Set<string>();
  const reg = RESOURCES as unknown as Record<string, { fields: Record<string, string> }>;
  for (const form of Object.values(CONSOLE_FORMS)) {
    const resource = reg[(form as { resource: string }).resource];
    if (!resource) continue;
    for (const api of Object.values((form as { fields: Record<string, string> }).fields)) {
      const kind = resource.fields[api];
      if (typeof kind === "string" && kind.startsWith("id:")) out.add(kind.slice(3));
    }
  }
  return [...out].sort();
}

function consoleWin() {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(file, "utf8")
    + "\n;window.__L=LOOKUP_ARRAYS;window.__F=formOptions;", "console.js");
  return w.win as Record<string, unknown>;
}

/*
 * THE FOUR THAT CANNOT BE OFFERED YET, WITH THE REASON EACH.
 *
 * Listed rather than left to fail, and listed rather than silently skipped —
 * the point of the list is that it is short, read, and gets shorter.
 */
const NOT_OFFERED: Record<string, string> = {
  acquisition: "LAND's rows carry no database id — the row is shaped for a table, "
             + "which shows a ref, and a picker has to post the id",
  lease: "TENANTS carries no database id, same reason",
  task: "TASKS carries no database id, same reason",
  parcel: "a Parcel is the AUTHORITY'S record of land, reached through Property DNA "
        + "rather than a staff resource. Nothing hydrates one",
};

test("every lookup the API can send is either offered or explained", { skip }, () => {
  const declared = consoleWin()["__L"] as Record<string, string[]>;
  const unexplained = lookupsInUse().filter((l) => !declared[l] && !NOT_OFFERED[l]);
  assert.deepEqual(unexplained, [],
    `these pickers would be empty however many records the company has, and `
    + `nothing says why: ${unexplained.join(", ")}`);
});

test("the unoffered list is only what it claims to be", { skip }, () => {
  /* If one becomes offerable and stays on the list, the list stops being read.
     If one is dropped from the registry entirely, the same. */
  const declared = consoleWin()["__L"] as Record<string, string[]>;
  const inUse = new Set(lookupsInUse());
  const stale = Object.keys(NOT_OFFERED)
    .filter((l) => declared[l] || !inUse.has(l));
  assert.deepEqual(stale, [],
    `these are listed as unoffered but are offered, or no longer exist: ${stale.join(", ")}`);
});

test("the pickers that WERE empty are now offered", { skip }, () => {
  /* Named, so the fix cannot quietly shrink back to the original five. */
  const declared = consoleWin()["__L"] as Record<string, string[]>;
  for (const l of ["site", "building", "unit", "project", "party",
                   "contract", "decision", "document", "inspection",
                   "meeting", "projectPhase", "rfi", "rfq"]) {
    assert.ok(declared[l]?.length, `${l} has no array behind its picker`);
  }
});

test("the arrays named are ones the hydrator can actually fill", { skip }, () => {
  /* A name with a typo is the same empty dropdown, arrived at differently. */
  const hyd = readFileSync(join(FE, "assets", "paltas-hydrate.js"), "utf8");
  const declared = consoleWin()["__L"] as Record<string, string[]>;
  const unknown: string[] = [];
  for (const [lookup, arrays] of Object.entries(declared)) {
    for (const name of arrays) {
      if (!new RegExp(`\\b${name}: *\\{`).test(hyd)) unknown.push(`${lookup} -> ${name}`);
    }
  }
  assert.deepEqual(unknown, [], `no adapter fills these: ${unknown.join(", ")}`);
});

test("opening a form asks for the arrays its pickers read", { skip }, () => {
  const src = readFileSync(file, "utf8");
  const from = src.indexOf("ACTIONS.newOpen");
  const body = src.slice(from, src.indexOf("\n};", from));
  assert.match(body, /LOOKUP_ARRAYS\[f\.lookup\]/,
    "newOpen does not collect the arrays behind its pickers");
  assert.match(body, /H\.loadAll\(wanted/,
    "it collects them and never asks for them");
});

test("the form is drawn first and the lists fill after", { skip }, () => {
  /*
   * Deliberate: waiting on three lists before showing anything makes the
   * button feel broken, and the first thing anybody does is type the name.
   */
  const src = readFileSync(file, "utf8");
  const from = src.indexOf("ACTIONS.newOpen");
  const body = src.slice(from, src.indexOf("\n};", from));
  assert.ok(body.indexOf("render();") < body.indexOf("H.loadAll"),
    "it waits for the lists before drawing the form");
});
