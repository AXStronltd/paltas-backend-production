/* ======================================================================
 * THE SIDEBAR IS THE ELEVEN BUSINESS AREAS, IN ORDER.
 *
 * The standard names them and names the sequence, and the sequence is not
 * arbitrary: it follows the working day — what needs attention, then what the
 * company owns, then what it is building, selling, running, saying and
 * banking, with the filing and the settings last.
 *
 * The property console shipped fourteen sections in declaration order, with
 * three the standard does not list (Marketplace & stays, Marketing, Capital),
 * two under other names (Cases & operations, People), and Administration
 * appended at runtime — so the settings landed in the middle of the working
 * areas.
 *
 * The three are folded rather than dropped. A sidebar with a section per
 * feature is the tree the standard says not to build, but hiding a screen
 * that works is worse than showing it in the wrong place.
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

/** The eleven, in the standard's order. */
const AREAS = [
  "Command centre", "Portfolio", "Projects & development", "CRM & sales",
  "Operations", "Communications", "Finance", "Documents",
  "Analytics & reports", "Staff & permissions", "Administration",
];

function navFor(system: string, role = "OWNER") {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system };
  w.loadCode(readFileSync(file, "utf8") + "\n;window.__nav=navFor;", "console.js");
  const P = w.win["PALTAS"] as Foreign;
  P.Session.create({ email: "a@b.c", name: "A Person", company: "A Company",
    products: ["PROPERTY_MANAGEMENT"], role,
    preferred: "PROPERTY_MANAGEMENT", country: "ke" });
  /*
   * COPIED INTO A HOST ARRAY, and that is not tidiness.
   *
   * navFor() builds its array inside the vm context, so it is that realm's
   * Array — and assert.deepEqual compares prototypes, so two arrays with
   * byte-identical contents fail against each other. The failure prints the
   * same JSON twice, which is a confusing half-hour if you have not met it.
   */
  return Array.from(
    (w.win["__nav"] as (s: string) => Foreign[])(system) || [],
    (g: Foreign) => String(g.title || ""),
  );
}

test("the property console shows the named areas, in the named order", { skip }, () => {
  const named = navFor("property").filter((t) => AREAS.includes(t));
  const want = AREAS.filter((a) => named.includes(a));
  assert.deepEqual(named, want,
    `rendered: ${named.join(" | ")}\n  expected: ${want.join(" | ")}`);
});

test("the settings are last, not in the middle of the work", { skip }, () => {
  const titles = navFor("property");
  const admin = titles.indexOf("Administration");
  assert.ok(admin >= 0, "Administration is missing");
  for (const area of ["Portfolio", "Finance", "Operations", "CRM & sales"]) {
    assert.ok(titles.indexOf(area) < admin,
      `${area} comes after Administration — it is appended at runtime, and an ` +
      `append lands wherever the push happens unless something sorts it`);
  }
});

test("nothing the standard does not name is a section of its own", { skip }, () => {
  const titles = navFor("property");
  for (const gone of ["Marketplace & stays", "Marketing", "Capital",
                      "Cases & operations", "People"]) {
    assert.ok(!titles.includes(gone), `"${gone}" is still a section`);
  }
});

test("and none of their screens was lost on the way", { skip }, () => {
  /*
   * The point of folding rather than deleting. Every screen that had a
   * section of its own still has a way in — a customer who used Promotions
   * yesterday must still find it today.
   */
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(file, "utf8") + "\n;window.__nav=navFor;", "console.js");
  const P = w.win["PALTAS"] as Foreign;
  P.Session.create({ email: "a@b.c", name: "A Person", company: "A Company",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER",
    preferred: "PROPERTY_MANAGEMENT", country: "ke" });
  const reachable = new Set(
    ((w.win["__nav"] as (s: string) => Foreign[])("property") || [])
      .flatMap((g) => (g.items || []).map((it: Foreign) => String(it[0]))),
  );
  for (const screen of ["pm_market", "shortstay", "mk_promos", "investments",
                        "maintenance", "staff"]) {
    assert.ok(reachable.has(screen), `${screen} has no way in from the sidebar`);
  }
});

test("the sidebar stays a list of areas, not a tree of functions", { skip }, () => {
  /* "Do NOT use a permanent giant navigation tree." Eleven is the number the
     standard gives; a console that grows a twelfth top-level area should be a
     decision somebody made, not a drift nobody noticed. */
  const titles = navFor("property");
  assert.ok(titles.length <= 12,
    `${titles.length} top-level sections: ${titles.join(", ")}`);
});
