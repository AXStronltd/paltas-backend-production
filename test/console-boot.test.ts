/* ======================================================================
 * THE CONSOLE DRAWS ITSELF AT ALL.
 *
 * Every other UI suite in this repository calls a screen function directly —
 * `SCREENS.command()` — and asserts the HTML it returns. That proves the
 * screens are right. It does not prove anything ever puts one on the page,
 * and on 27 Sep 2026 nothing did: `render()` threw on first paint and every
 * signed-in console came up blank while 1,433 tests stayed green.
 *
 * The cause was ordering. `if (gate()) render();` sits at the end of chunk
 * js44; `var GUIDE = {…}` is declared in js45, a thousand lines later, and
 * render() reads it through sectionGuide(). `var` hoisting makes GUIDE
 * `undefined` rather than a ReferenceError, so the first paint died with
 * "Cannot read properties of undefined (reading 'command')".
 *
 * These tests exercise the renderer, not a screen.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";
import type { Foreign } from "./wire.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const skip = existsSync(join(FE, "assets", "console.js"))
  ? false
  : `no frontend at ${FE} — set PALTAS_FRONTEND to run these`;

/*
 * `render` and `gate` are file-scope functions in console.js, so the only way
 * to reach them is the same trick the other suites use for SCREENS: append a
 * line that hands them out. Nothing in the product depends on these names.
 */
/** A real v2 session blob, produced by the product rather than hand-written. */
function sessionBlob(): string {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8"), "console.js");
  (w.win["PALTAS"] as Foreign).Session.create({
    email: "a@b.c", name: "A Person", company: "Almas LTD",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER",
    preferred: "PROPERTY_MANAGEMENT",
  });
  const blob = (w.win["sessionStorage"] as Foreign).getItem("paltas");
  assert.ok(blob, "the product did not write a session to sessionStorage");
  return String(blob);
}

/*
 * THE SESSION EXISTS BEFORE THE SCRIPT RUNS. That is the whole point.
 *
 * The other suites call Session.create() AFTER loadCode, so during evaluation
 * there is no session, gate() returns false, and the boot render never fires.
 * That is exactly why a crash on first paint could survive 1,433 green tests.
 * A real browser arrives with the session already in sessionStorage.
 */
function boot() {
  const blob = sessionBlob();
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  (w.win["sessionStorage"] as Foreign).setItem("paltas", blob);
  w.loadCode(
    readFileSync(join(FE, "assets", "console.js"), "utf8")
      + "\n;window.__render=render;window.__gate=gate;window.__guide=(typeof GUIDE);",
    "console.js",
  );
  return w;
}

test("the guidance table is defined by the time the file has loaded",
  { skip }, () => {
    const w = boot();
    /*
     * The failure this catches is `"undefined"`, which is what a hoisted
     * `var` reads as when the reader runs before the assignment.
     */
    assert.equal(w.win["__guide"], "object",
      "GUIDE is not initialised — anything that reads it during boot will throw");
  });

test("booting with a session fills the content area", { skip }, async () => {
  /*
   * boot() itself is the assertion: if the file throws while evaluating, this
   * line never returns. No render() call here on purpose — calling it
   * afterwards proves nothing, because by then the whole file has loaded and
   * GUIDE exists no matter where the boot call sits.
   */
  const w = boot();

  /*
   * Let the deferred boot run. The fix schedules the first paint on a
   * microtask so the whole file is defined before anything is drawn, so a
   * synchronous assertion here would be checking too early.
   */
  await new Promise((r) => setTimeout(r, 5));

  /*
   * render() paints the shell and then fills #page with
   * crumbs() + sectionGuide() + the screen. The crash landed between those
   * two, which is why the live symptom was a complete sidebar beside an
   * empty content area rather than a blank tab.
   */
  const page = (w.win["document"] as Foreign).getElementById("page");
  assert.ok(page, "there is no #page element to draw into");
  assert.ok(String(page.innerHTML || "").length > 0,
    "the shell painted but the content area stayed empty");
});

test("a signed-in console is what boot decides to draw", { skip }, () => {
  const w = boot();
  const gate = w.win["__gate"] as () => boolean;
  /* If this is false the boot render never runs, which is exactly why a
     suite that never signs in could not have caught the crash. */
  assert.equal(gate(), true, "a resolved session must open the console");
});
