/* ======================================================================
 * A COMPANY'S COUNTRY IS SETTLED WHEN IT REGISTERS. IT IS NOT A VIEW.
 *
 * Every console carried a picker — All markets, Kenya, UAE, USA — and two
 * things were wrong with it.
 *
 * A Kenyan company whose user clicked UAE watched its own data disappear:
 * every hydrated row is stamped with the ORGANIZATION'S country, so the
 * filter matched nothing and every screen went empty.
 *
 * And "All markets" was the default, on which MARKET_NOW() fell back to
 * "ke" — so a company in Dubai saw its own money labelled KES. That is the
 * thing the standard names outright: never hardcode Kenya into generic logic.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";
import type { Foreign } from "./wire.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const skip = existsSync(join(FE, "assets", "console.js"))
  ? false
  : `no frontend at ${FE}`;

function consoleFor(country: string) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8")
    + "\n;window.__M=MARKET_NOW;window.__inM=inM;window.__market=function(){return market;};",
    "console.js");
  const P = w.win["PALTAS"] as Foreign;
  P.Session.create({
    email: "a@b.c", name: "A Person", company: "A Company",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER",
    preferred: "PROPERTY_MANAGEMENT", country,
  });
  return {
    market: () => (w.win["__M"] as () => string)(),
    inM: (row: { m: string }) => (w.win["__inM"] as (r: unknown) => boolean)(row),
  };
}

test("no console ships a market picker any more", { skip }, () => {
  const dir = join(FE, "dashboard");
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".html"))
    .filter((f) => /id="mkt"|data-m="/.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(offenders, [],
    `${offenders.join(", ")} still offer a country the company has already settled`);
});

test("removing it did not leave a listener reaching for a missing element", { skip }, () => {
  /*
   * The whole console is one file; an unguarded getElementById("mkt") would
   * throw at load and blank the page — which is exactly how GUIDE did it for
   * two days this week.
   */
  const src = readFileSync(join(FE, "assets", "console.js"), "utf8");
  assert.doesNotMatch(src, /document\.getElementById\("mkt"\)\.addEventListener/,
    "the market listener is unguarded and the element is gone");
});

test("a UAE company sees its own market, not Kenya", { skip }, () => {
  /* The bug, named: on the old default this returned "ke" and every figure on
     the screen was labelled in shillings. */
  assert.equal(consoleFor("ae").market(), "ae");
});

test("a Kenyan company still sees Kenya", { skip }, () => {
  assert.equal(consoleFor("ke").market(), "ke");
});

test("a company's own rows are never filtered out from under it", { skip }, () => {
  /* Hydrated rows carry the organization's country. Whatever the console
     thinks the market is, its own data has to pass. */
  for (const country of ["ke", "ae", "us"]) {
    const c = consoleFor(country);
    assert.equal(c.inM({ m: country }), true,
      `a ${country} company cannot see its own rows`);
  }
});
