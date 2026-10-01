/* ======================================================================
 * A MERGED ROW HAS TO KNOW WHICH TABLE IT CAME FROM.
 *
 * Three lifecycles — payments, expenses, owner payouts — are merged into one
 * cash list, and every action that CHANGES a row needs to know which resource
 * to send the change to. `src` is how it knows.
 *
 * It was set three times in the payments branch (a copy-paste of the same
 * comment, once per table) and not at all in the other two. The last of the
 * three won, so payments worked by accident and the other two rows arrived
 * with `src` undefined — which meant:
 *
 *   finApprove   passed its own `r.src !== "expenses"` guard (undefined is
 *                falsy), reached finWrite, and told the customer their real
 *                expense was "part of the sample ledger"
 *   finRelease   the same, for every owner payout
 *
 * Approve-for-payment and Release-payout were therefore dead for every real
 * company, and the message blamed the data.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const file = join(FE, "assets", "paltas-hydrate.js");
const skip = existsSync(file) ? false : `no frontend at ${FE}`;

/** The three branches of the merged cash list, by the table each reads. */
function branches(src: string): Record<string, string> {
  const merge = src.match(/LEDGER: \{ slugs: \[[^\]]*\], merge:[\s\S]*?\n    \}\}/);
  assert.ok(merge, "the merged cash list is gone");
  const out: Record<string, string> = {};
  const parts = merge[0].split(/\(by\.(\w+) \|\| \[\]\)\.forEach/);
  /* [before, name, body, name, body, ...] */
  for (let i = 1; i < parts.length; i += 2) out[parts[i]!] = parts[i + 1]!;
  return out;
}

test("every merged branch says which table it came from, exactly once", { skip }, () => {
  const found = branches(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(found).sort(), ["expenses", "payments", "payouts"],
    "the three branches are not the three expected");

  for (const [table, body] of Object.entries(found)) {
    const says = [...body.matchAll(/src: "(\w+)"/g)].map((m) => m[1]!);
    assert.equal(says.length, 1,
      `the ${table} branch sets src ${says.length} times: ${says.join(", ")} — `
      + "more than one and the last wins by accident, none and the row cannot be changed");
    assert.equal(says[0], table,
      `a ${table} row says it came from ${says[0]} — its changes would be sent to the wrong resource`);
  }
});

test("the guards that read it refuse on a mismatch, not on a blank", { skip }, () => {
  /*
   * `r.src && r.src !== "expenses"` passes when src is undefined, which is how
   * a missing value turned into a wrong message instead of a refusal. Pinned
   * so that if the shape ever goes back, this says why it matters.
   */
  const consoleJs = join(FE, "assets", "console.js");
  if (!existsSync(consoleJs)) return;
  const src = readFileSync(consoleJs, "utf8");
  assert.match(src, /if \(!r\.rowId \|\| !r\.src\)/,
    "finWrite no longer checks that it knows where to send the change");
});
