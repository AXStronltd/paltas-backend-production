/* ======================================================================
 * A CUSTOMER NEVER SEES THE SEED ROWS AS ITS OWN.
 *
 * The console's arrays arrive full. That content is the marketplace's demo
 * data — right for a visitor deciding whether to sign up, wrong for a company
 * that already has. Until now it showed until hydration replaced it, so a
 * brand-new customer's first sight of their portfolio was "Riverside Court",
 * "Nairobi Heights" and "Kilimani Suites", presented as theirs.
 *
 * Found by walking Almas LTD's live console: PROPS held four seed properties
 * on first paint and one real one — Almas Tower — a second later.
 *
 * Two halves, because the session can arrive before OR after this file:
 *   register()  in-app navigation, where sessionStorage already holds it
 *   load()      a cold tab, where the bridge fills it after both files run
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

/** The hydrator, with a session or without one. */
function hydrator({ signedIn }: { signedIn: boolean }) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  /* A minimal stand-in for what console.js provides. The real Session is
     defined there, and this file only ever asks it one question. */
  (w.win as Record<string, unknown>)["PALTAS"] = {
    Session: { read: () => (signedIn ? { signedIn: true, organization: { country: "ke" } } : null) },
    Data: { configured: () => true, list: () => new Promise(() => {}), request: () => new Promise(() => {}) },
  };
  w.loadCode(readFileSync(file, "utf8"), "paltas-hydrate.js");
  return (w.win as Record<string, Foreign>)["PALTAS"].Hydrate;
}

test("a signed-in company's arrays are emptied the moment they are registered",
  { skip }, () => {
    const H = hydrator({ signedIn: true });
    /* PROPS has an adapter, so something will refill it. */
    const rows = [{ name: "Riverside Court" }, { name: "Kilimani Suites" }];
    H.register("PROPS", rows);
    assert.equal(rows.length, 0,
      "a customer would see two properties that are not theirs");
  });

test("a visitor keeps them — the marketplace is what they are for", { skip }, () => {
  const H = hydrator({ signedIn: false });
  const rows = [{ name: "Riverside Court" }, { name: "Kilimani Suites" }];
  H.register("PROPS", rows);
  assert.equal(rows.length, 2,
    "the signed-out marketplace lost the content it exists to show");
});

test("an array nothing can refill is left alone", { skip }, () => {
  /*
   * The failure this guard prevents is worse than the bug. Emptying an array
   * with no adapter behind it leaves that screen blank forever, with nothing
   * on its way to fill it.
   */
  const H = hydrator({ signedIn: true });
  const rows = [{ n: "something no adapter loads" }];
  H.register("NOT_AN_ADAPTER_NAME", rows);
  assert.equal(rows.length, 1, "a screen was emptied with nothing coming to refill it");
});

test("on a cold tab they go as soon as the request leaves", { skip }, () => {
  /*
   * register() cannot help here: on a first load the session arrives through
   * the bridge AFTER this file and console.js have both run, so nobody is
   * signed in at registration time. The request going out is the next
   * earliest honest moment.
   */
  const H = hydrator({ signedIn: false });
  const rows = [{ name: "Riverside Court" }];
  H.register("PROPS", rows);
  assert.equal(rows.length, 1, "precondition: a visitor still has them");

  H.load("PROPS");            /* never resolves — the state under test is mid-flight */
  assert.equal(rows.length, 0,
    "seed rows stayed on screen while the real ones were being fetched");
  assert.equal(H.state("PROPS").status, "loading");
});

test("the file still says why, where the next person will look", { skip }, () => {
  /* This rule already existed for failures — "an error empties the array
     rather than leaving yesterday's rows, or the seed rows, looking current".
     The reasoning is the same and belongs beside it. */
  const src = readFileSync(file, "utf8");
  assert.match(src, /EMPTIED WHEN THE ASKING STARTS/);
  assert.match(src, /NEVER SEES THE SEED ROWS/);
});
