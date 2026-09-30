/* ======================================================================
 * A PRICE IS QUOTED IN THE VISITOR'S OWN CURRENCY, OR NOT YET AT ALL.
 *
 * The first screen of business signup shows four product cards with a price
 * on each — and it is shown BEFORE anybody is asked where their company is.
 * It rendered `money(price, "ke")`: Kenya, hard-coded, so a developer in
 * Dubai and a landlord in Texas were both quoted in shillings.
 *
 * market.js states the principle it was breaking a few hundred lines above,
 * in startCountry():
 *
 *   "a pre-filled country is an answer the customer did not give, and on this
 *    form it decides their currency, their documents and how they get paid"
 *
 * A price in the wrong currency is that same wrong answer, said in money.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";
import type { Foreign } from "./wire.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const file = join(FE, "assets", "market.js");
const skip = existsSync(file) ? false : `no frontend at ${FE}`;

/** market.js under a DOM, with its price helper handed out. */
function market() {
  const w = makeWindow({ href: "https://paltas.io/auth/business.html" });
  w.win["PALTAS_PAGE"] = "business";
  w.loadCode(readFileSync(join(FE, "assets", "market-config.js"), "utf8"), "market-config.js");
  w.loadCode(readFileSync(file, "utf8") + "\n;window.__price=fitPriceLine;", "market.js");
  return (w.win["__price"] as (k: string, c?: string) => string);
}

test("no country named means no price claimed", { skip }, () => {
  const line = market()("property", "");
  assert.doesNotMatch(line, /Ksh|KES|AED|USD|\$/,
    "a currency was quoted to somebody who has not said where they are");
  assert.match(line, /your own currency/i, "and it must say why there is no figure yet");
});

test("a Kenyan company is quoted in shillings", { skip }, () => {
  const line = market()("property", "KE");
  assert.match(line, /64,?000/);
});

test("a UAE company is quoted in dirhams, not shillings", { skip }, () => {
  /* The bug, named. This said Ksh 64,000 to a company in Dubai. */
  const line = market()("property", "AE");
  assert.match(line, /1,?900/, `expected the AED price, got: ${line}`);
  assert.doesNotMatch(line, /64,?000/, "it is still quoting the Kenyan figure");
});

test("a US company is quoted in dollars", { skip }, () => {
  const line = market()("property", "US");
  assert.match(line, /560/);
  assert.doesNotMatch(line, /64,?000/);
});

test("every product is priced in every live market", { skip }, () => {
  const price = market();
  for (const product of ["property", "agent", "hotel", "security"]) {
    for (const country of ["KE", "AE", "US"]) {
      const line = price(product, country);
      assert.match(line, /a month after the trial/,
        `${product} has no price for ${country}`);
    }
  }
});

test("a country outside the live markets is priced on the rail it bills on",
  { skip }, () => {
    /*
     * Corrected from my first assumption. Nigeria is not unpriced — COUNTRIES
     * maps every country to BILLING_RAIL[code] || "us", and market.js says so
     * plainly: "everywhere else is billed on the nearest rail and TOLD so, on
     * the form, rather than finding out from an invoice". So USD is the right
     * and honest answer, not a guess.
     */
    const line = market()("property", "NG");
    assert.match(line, /560/, `expected the US-rail price, got: ${line}`);
    assert.doesNotMatch(line, /64,?000/, "it must not fall back to Kenya");
  });

test("the source carries no hard-coded market for a price", { skip }, () => {
  const src = readFileSync(file, "utf8");
  assert.doesNotMatch(src, /money\([^)]*\.price,\s*"ke"\)/,
    "a price is still being formatted as Kenyan regardless of the visitor");
});
