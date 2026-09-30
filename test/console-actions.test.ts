/* ======================================================================
 * A BUTTON'S ARGUMENT REACHES ITS ACTION.
 *
 * The console writes an action's argument two ways:
 *
 *   data-act="clientOpen::p_1"            the act() helper's form
 *   data-act="clientOpen" data-arg="p_1"  the hand-written form
 *
 * Only the first was ever read. `data-arg` appeared on twenty-four buttons
 * and was read by nothing, so each called its action with `undefined` —
 * Client 360's Open, Buyer 360's tabs, Property DNA, reconciliation matching
 * and the command centre's quick actions all did nothing when clicked.
 *
 * It survived every UI suite because they call the ACTION and never the
 * button: `c.act("clientOpen", "p1")` hands the argument over directly, so it
 * arrived in the test and nowhere else. This file clicks.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";
import type { Foreign } from "./wire.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const file = join(FE, "assets", "console.js");
const skip = existsSync(file) ? false : `no frontend at ${FE}`;

/** The console, with its click dispatcher reachable. */
function boot() {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(file, "utf8") + "\n;window.__A=ACTIONS;", "console.js");
  return w;
}

/**
 * What the dispatcher would hand an action for a given button.
 *
 * Read from the source rather than simulated, because the shim's event model
 * is not the browser's and a hand-rolled closest() would be testing itself.
 */
function dispatcherSource(): string {
  const src = readFileSync(file, "utf8");
  const from = src.indexOf("One listener for every action on every screen");
  assert.ok(from > 0, "the dispatcher comment is gone — has it been rewritten?");
  return src.slice(from, from + 1200);
}

test("the dispatcher reads both spellings of an argument", { skip }, () => {
  const d = dispatcherSource();
  assert.match(d, /dataset\.act\.split\("::"\)/, "the :: form is no longer read");
  assert.match(d, /dataset\.arg/,
    "data-arg is written on buttons across the console and read by nothing — "
    + "every one of them calls its action with undefined");
});

test("every action reached only by data-arg exists", { skip }, () => {
  /*
   * A button carrying an argument the dispatcher now delivers, to an action
   * that does not exist, is the same dead button wearing a different hat.
   */
  const src = readFileSync(file, "utf8");
  const named = [...src.matchAll(/data-act="([a-zA-Z_]+)" data-arg=/g)]
    .map((m) => m[1]!)
    .filter((v, i, a) => a.indexOf(v) === i);
  assert.ok(named.length >= 10, `expected the hand-written form to be in use, found ${named.length}`);

  const A = boot().win["__A"] as Record<string, unknown>;
  const missing = named.filter((n) => typeof A[n] !== "function");
  assert.deepEqual(missing, [], `buttons point at actions that do not exist: ${missing.join(", ")}`);
});

test("the actions that were dead are the ones this had to fix", { skip }, () => {
  /*
   * Named so the fix cannot be quietly narrowed later. These are real
   * controls a customer clicks: opening a client, opening a buyer, matching a
   * bank line, and adding anything at all from the command centre.
   */
  const src = readFileSync(file, "utf8");
  for (const action of ["clientOpen", "buyerOpen", "reconMatch", "goAdd", "receiptIssue"]) {
    assert.match(src, new RegExp(`data-act="${action}" data-arg=`),
      `${action} no longer uses the form this fix exists for`);
  }
  assert.match(dispatcherSource(), /dataset\.arg/);
});

test("the :: form still wins where a button carries both", { skip }, () => {
  /* It is the older convention and the one act() emits; changing which one
     takes precedence would move every act() button's argument silently. */
  const d = dispatcherSource();
  assert.match(d, /packed !== undefined \? packed : b\.dataset\.arg/,
    "precedence is not stated, so it is whatever the expression happens to do");
});
