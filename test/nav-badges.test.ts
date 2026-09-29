/* ======================================================================
 * THE SIDEBAR DOES NOT INVENT RECORDS.
 *
 * Almas LTD signed in to a console whose every screen correctly said zero —
 * no buildings, no units, no tenancies — beside a sidebar reading
 * "Units 2 · Leases & tenancies 4 · Pipeline 8". None of those existed.
 *
 * They were not stale counts from a cache. They were literals left in the
 * navigation from the demo era:
 *
 *     ["units",   "◫", "Units",              2],
 *     ["rentals", "◫", "Leases & tenancies", 4],
 *
 * A badge is a promise that something is waiting. Twenty-six of them were
 * promising a new customer records it did not have, on the first screen it
 * ever saw.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const file = join(FE, "assets", "console.js");
const skip = existsSync(file) ? false : `no frontend at ${FE}`;

/**
 * A nav item is `[key, icon, label, count?, subheading?]`, and navSection
 * draws the badge as `ct ? <span class="ct">…</span> : ""`. So the rule is
 * about position 4 holding a truthy literal, not about the array's length:
 * the three items under Finance keep a falsy 0 there so their sub-heading
 * stays at position 5.
 */
/*
 * NOT ANCHORED TO THE START OF A LINE.
 *
 * The first version of this was, and it passed while fourteen badges were
 * still live — every nav item written inline, like
 * `items: [["command", "◈", "Command centre", 6]]`, and the whole agent
 * console, whose groups are declared several to a line. A rule that only
 * holds for code formatted one particular way is not the rule.
 */
const WITH_COUNT =
  /\["[a-z_]+"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*[1-9]\d*/g;

test("no navigation item ships a hardcoded count", { skip }, () => {
  const src = readFileSync(file, "utf8");
  const found = src.match(WITH_COUNT) || [];
  assert.deepEqual(found, [],
    `${found.length} nav item(s) still carry an invented badge:\n  `
    + found.map((f) => f.trim()).join("\n  ")
    + "\n\nA badge must come from the company's own records or not be drawn.");
});

test("the badge is drawn only when there is something to draw", { skip }, () => {
  /*
   * The guard is what makes removing the literals sufficient: with nothing at
   * position 4, `ct` is undefined and no element is produced. If this ever
   * became an unconditional span, every item would render an empty badge and
   * the test above would still pass.
   */
  const src = readFileSync(file, "utf8");
  assert.match(src, /\$\{ct \? `<span class="ct">\$\{ct\}<\/span>` : ""\}/,
    "navSection no longer guards the badge on a truthy count");
});
