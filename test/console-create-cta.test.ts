/* ======================================================================
 * A CREATE BUTTON OPENS A FORM SOMEBODY CAN SEE.
 *
 * newOpen() only sets state. The panel is drawn by whichever screen calls
 * newPanel(), and the command centre calls none — so every create button on
 * the first screen a new company sees set NEW and then rendered a screen with
 * nowhere to put it. "＋ Add building" highlighted and nothing happened,
 * directly beneath a panel promising "each of these opens the same form the
 * section itself uses".
 *
 * Eight quick actions, plus Add a property, Add unit, Create lease and Raise
 * invoice. The ninth quick action, Upload document, already went somewhere
 * else with a comment explaining exactly this — so the failure mode was known
 * and fixed once, for one button.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const file = join(FE, "assets", "console.js");
const skip = existsSync(file) ? false : `no frontend at ${FE}`;

/** The command centre, from its definition to the next screen's. */
function commandCentre(src: string): string {
  const from = src.indexOf("SCREENS.command = ");
  assert.ok(from > 0, "SCREENS.command not found");
  const next = src.indexOf("SCREENS.", src.indexOf("\n};", from));
  return src.slice(from, next > from ? next : undefined);
}

test("the command centre draws no create panel — so it must not open one",
  { skip }, () => {
    const cc = commandCentre(readFileSync(file, "utf8"));
    /* The premise. If this ever stops holding, the rule below can relax —
       but then it should relax deliberately, not silently. */
    assert.doesNotMatch(cc, /newPanel\(/,
      "the command centre now draws a panel; revisit this whole file");
    assert.doesNotMatch(cc, /newOpen/,
      "a create button on the command centre opens a form with nowhere to draw");
  });

test("its create buttons go to the screen that owns the form", { skip }, () => {
  const cc = commandCentre(readFileSync(file, "utf8"));
  const uses = cc.match(/goAdd/g) || [];
  assert.ok(uses.length >= 5,
    `expected the command centre's create buttons to use goAdd, found ${uses.length}`);
});

test("goAdd navigates before it opens", { skip }, () => {
  /*
   * The order is the whole fix. Opening first and navigating after would
   * render the panel once on the screen that cannot draw it, which is the
   * bug with an extra step.
   */
  const src = readFileSync(file, "utf8");
  const from = src.indexOf("ACTIONS.goAdd");
  assert.ok(from > 0, "goAdd is gone");
  const body = src.slice(from, from + 500);
  const setsScreen = body.indexOf("screen = to");
  const opens = body.indexOf("newOpen(to)");
  assert.ok(setsScreen > 0 && opens > 0, "goAdd no longer does both");
  assert.ok(setsScreen < opens, "goAdd opens the form before choosing the screen");
});
