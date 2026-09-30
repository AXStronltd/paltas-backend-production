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

function consoleFor(country: string | null) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8")
    + "\n;window.__M=MARKET_NOW;window.__cur=reportCur;window.__inM=inM;"
    + "window.__setMarket=function(v){market=v;};",
    "console.js");
  const P = w.win["PALTAS"] as Foreign;
  /* null means genuinely signed out — no session at all, rather than a
     session with a blank country, which is a different thing. */
  if (country !== null) {
    P.Session.create({
      email: "a@b.c", name: "A Person", company: "A Company",
      products: ["PROPERTY_MANAGEMENT"], role: "OWNER",
      preferred: "PROPERTY_MANAGEMENT", country,
    });
  }
  return {
    market: () => (w.win["__M"] as () => string)(),
    cur: () => (w.win["__cur"] as () => string)(),
    inM: (row: { m?: string }) => (w.win["__inM"] as (r: unknown) => boolean)(row),
    /* Drift the snapshot, the way an asynchronous session or a country change
       does in a browser. */
    setMarket: (m: string) => (w.win["__setMarket"] as (v: string) => void)(m),
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

test("the filter asks the company, not a snapshot taken at load", { skip }, () => {
  /*
   * THE BUG THIS EXISTS FOR, FOUND ON THE LIVE CONSOLE.
   *
   * `market` is assigned once while console.js evaluates. The session usually
   * arrives after that, and a company's country can change later — so the
   * variable drifts from the truth. It had: `market` said "ae" while Almas
   * LTD was registered in Kenya, and its one property was filtered out of its
   * own Portfolio screen. Nothing threw. The company simply had no buildings.
   *
   * Moving the company and NOT touching the stale variable is exactly that
   * situation, reproduced.
   */
  const c = consoleFor("ke");
  c.setMarket("ae");
  assert.equal(c.inM({ m: "ke" }), true,
    "a stale market snapshot hid the company's own row");
  assert.equal(c.cur(), "KES",
    "finance reported in a currency the company does not keep its books in");
});

test("signed out, nothing is hidden", { skip }, () => {
  /* No company means no filter — an empty product is a worse answer than a
     row from a market nobody chose, and the hydrator cannot produce one. */
  const c = consoleFor(null);
  for (const m of ["ke", "ae", "us"]) {
    assert.equal(c.inM({ m }), true, `${m} rows were hidden with no company`);
  }
  assert.equal(c.inM({}), true, "a row with no market was hidden");
});
