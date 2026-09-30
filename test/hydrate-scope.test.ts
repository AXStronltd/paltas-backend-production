/* ======================================================================
 * A CUSTOMER'S CONSOLE DOES NOT ASK FOR PALTAS'S OWN RECORDS.
 *
 * The hydrator offered every adapter to every console, and eleven of them
 * point at /platform — the staff console. So a property company signing in
 * asked for the list of every organization on the platform, its users, its
 * plans, its moderation queue and its compliance cases. It was correctly
 * refused each time, and each refusal wrote a row into THAT COMPANY'S audit
 * trail: Almas LTD's read eleven refusals against one real action, before it
 * had done anything at all.
 *
 * Three costs, and the third is the one that matters. Eleven wasted requests
 * per load. An audit trail nobody will read. And refusals that look exactly
 * like somebody probing the platform, which is the signal you want left clean.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";
import type { Foreign } from "./wire.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const file = join(FE, "assets", "paltas-hydrate.js");
const skip = existsSync(file) ? false : `no frontend at ${FE}`;

function hydrateFor(system: string | null) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  if (system) w.win["PALTAS_BOOT"] = { system };
  w.loadCode(readFileSync(file, "utf8"), "paltas-hydrate.js");
  const H = (w.win["PALTAS"] as Foreign).Hydrate;
  return { names: H.adapters() as string[], all: H._adapt as Record<string, Foreign> };
}

const staffOnly = (all: Record<string, Foreign>) =>
  Object.keys(all).filter((n) => typeof all[n]?.path === "string"
                             && String(all[n].path).startsWith("/platform"));

test("the staff adapters are still there to be got wrong", { skip }, () => {
  /* If this ever reaches zero the test below passes for the wrong reason. */
  const { all } = hydrateFor("property");
  assert.ok(staffOnly(all).length >= 10,
    `expected the platform adapters to exist, found ${staffOnly(all).length}`);
});

test("a property console asks for none of them", { skip }, () => {
  const { names, all } = hydrateFor("property");
  const leaked = staffOnly(all).filter((n) => names.includes(n));
  assert.deepEqual(leaked, [],
    `a customer console would ask for, and be refused, ${leaked.length} staff endpoint(s): ${leaked.join(", ")}`);
});

test("nor does an agent, hotel or security console", { skip }, () => {
  for (const system of ["agent", "hotel", "security"]) {
    const { names, all } = hydrateFor(system);
    const leaked = staffOnly(all).filter((n) => names.includes(n));
    assert.deepEqual(leaked, [], `the ${system} console asks for ${leaked.join(", ")}`);
  }
});

test("a console with no system at all asks for none either", { skip }, () => {
  /* The signed-out and marketplace cases. Asking as nobody is still asking. */
  const { names, all } = hydrateFor(null);
  const leaked = staffOnly(all).filter((n) => names.includes(n));
  assert.deepEqual(leaked, []);
});

test("the staff console still gets them, or it has no data at all", { skip }, () => {
  const { names, all } = hydrateFor("platform");
  const missing = staffOnly(all).filter((n) => !names.includes(n));
  assert.deepEqual(missing, [],
    `the platform console can no longer load ${missing.join(", ")}`);
});

test("every other adapter is still offered to a customer", { skip }, () => {
  /* The fix must narrow exactly one thing. A console that quietly stopped
     loading its own leases would be a far worse bug than the one fixed. */
  const { names, all } = hydrateFor("property");
  const expected = Object.keys(all).filter((n) => !staffOnly(all).includes(n));
  assert.deepEqual(names.sort(), expected.sort());
});
