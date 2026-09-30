/* ======================================================================
 * A BLANK THAT IS NOT BLANK SAYS SO.
 *
 * 121 enum columns carry a database default. Most are statuses and right —
 * a new thing starts DRAFT, a new unit VACANT. A handful are CLASSIFICATIONS,
 * and there the default asserts a fact nobody stated:
 *
 *   Site.kind       RESIDENTIAL   a Dubai office tower, filed as homes
 *   Unit.kind       ONE_BED       a retail shop, filed as a one-bed flat
 *   Building.condition GOOD       an unsurveyed building, in good condition
 *
 * Almas Tower is recorded RESIDENTIAL today for exactly this reason: the Kind
 * select showed "—", the field was left alone, and the column did the rest.
 *
 * The service is not inventing anything — the column has always had that
 * default. What was missing was saying so, on the form, before somebody
 * agrees to it without being asked.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const consoleJs = join(FE, "assets", "console.js");
const skip = existsSync(consoleJs) ? false : `no frontend at ${FE}`;

const schema = readFileSync(
  resolve(process.cwd(), "prisma", "schema.prisma"), "utf8");

/** The @default on a model's column, or null. */
function defaultOf(model: string, column: string): string | null {
  const m = schema.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m"));
  if (!m) return null;
  const f = m[1]!.match(new RegExp(`^\\s+${column}\\s+\\w+\\s+@default\\((\\w+)\\)`, "m"));
  return f ? f[1]! : null;
}

test("the classifications that caused this still carry their defaults", () => {
  /* If one of these loses its default the disclosure is unnecessary, and
     this test should be the thing that says so rather than a silent no-op. */
  assert.equal(defaultOf("Site", "kind"), "RESIDENTIAL");
  assert.equal(defaultOf("Unit", "kind"), "ONE_BED");
  assert.equal(defaultOf("Building", "condition"), "GOOD");
});

test("the form service reads the defaults from the schema, not a copy", () => {
  /*
   * A second copy of 121 defaults would be wrong within a week. Reading the
   * same file Prisma generates from is what stops the two disagreeing.
   */
  const src = readFileSync(resolve(process.cwd(), "src", "routes", "forms.ts"), "utf8");
  assert.match(src, /schema\.prisma/,
    "the defaults are kept somewhere other than the schema");
  assert.match(src, /fallback/, "the field does not carry what blank will record");
});

test("a fallback is offered only where the person has a blank to leave", () => {
  const src = readFileSync(resolve(process.cwd(), "src", "routes", "forms.ts"), "utf8");
  assert.match(src, /if \(dflt && !field\.required\)/,
    "a required field has no blank to explain, and saying 'or else Residential' "
    + "beside one somebody must answer is noise");
});

test("the console says it on the blank option itself", { skip }, () => {
  const src = readFileSync(consoleJs, "utf8");
  assert.match(src, /f\.fallback \? `— \$\{esc\(enumWord\(f\.fallback\)\)\} unless you say otherwise`/,
    "the select still shows a bare dash where the answer is already decided");
});

test("a field with no default still reads as a plain blank", { skip }, () => {
  /* Most enums on most forms have no default worth mentioning; adding a
     sentence to every one of them would bury the three that matter. */
  const src = readFileSync(consoleJs, "utf8");
  assert.match(src, /: "—"\}<\/option>/,
    "there is no plain-blank branch left");
});
