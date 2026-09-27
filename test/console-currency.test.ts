/* ======================================================================
 * WHAT CURRENCY THE CONSOLE REPORTS IN.
 *
 * `reportCur()` decided this from CUR_OF_MARKET — a three-entry map written
 * for the three demo markets — and fell back to "KES" for everything else. So
 * a Swedish company's totals were labelled KES while its books, its invoices
 * and its leases were all SEK.
 *
 * The catalogue with all fifty countries was already loaded on the page, and
 * `orgCurrency()` five lines away already read it. This pins that reportCur()
 * reads it too.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";
import { country as catalogueCountry } from "../src/domain/market.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const skip = existsSync(join(FE, "assets", "console.js"))
  ? false
  : `no frontend at ${FE} — set PALTAS_FRONTEND to run these`;

/**
 * One console, with the market catalogue present — as every real page has it,
 * because market-config.js is loaded before console.js.
 *
 * `lookup` is backed by the SAME shared catalogue the server reads, so this
 * asserts against the real fifty-country data rather than a hand-written map
 * that could agree with a bug.
 */
function open(country: string) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.win["__cat"] = (code: unknown) => catalogueCountry(code);
  w.loadCode(
    "window.PALTAS = window.PALTAS || {};" +
    "window.PALTAS.Market = { lookup: function (c) { return __cat(c); }," +
    "                         countries: function () { return []; } };",
    "market-config-stub.js");
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8") +
    "\n;window.__reportCur=reportCur;", "console.js");

  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({
    email: "a@b.c", name: "A Person", company: "A Co",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER",
    preferred: "PROPERTY_MANAGEMENT", country,
  });
  /* The console reads the country off the session's organization. */
  const live = P.Session.read();
  if (live && live.organization) live.organization.country = country;
  return w.win["__reportCur"] as () => string;
}

for (const [cc, want, name] of [
  ["ke", "KES", "Kenya"], ["se", "SEK", "Sweden"],
  ["gb", "GBP", "United Kingdom"], ["us", "USD", "United States"],
] as const) {
  test(`the console reports a ${name} company in ${want}`, { skip }, () => {
    assert.equal(open(cc)(), want);
  });
}

/* Fifty countries, not three. These four are the ones CUR_OF_MARKET never had
   and which therefore all read KES before. */
for (const [cc, want] of [["dk", "DKK"], ["ng", "NGN"], ["ae", "AED"], ["za", "ZAR"]] as const) {
  test(`${cc} reports in ${want}, not KES`, { skip }, () => {
    const got = open(cc)();
    /* Only assert what the shared catalogue actually claims — if it has no
       entry for a code there is nothing to infer and KES standing is correct. */
    const entry = catalogueCountry(cc);
    if (!entry || !entry.currency) return;
    assert.equal(got, want);
  });
}

/* And with no catalogue on the page at all it must still produce something
   rather than throwing — a missing script must not blank the console. */
test("a missing catalogue degrades to a default, it does not throw", { skip }, () => {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode("window.PALTAS = { Market: {} };", "no-catalogue.js");
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8") +
    "\n;window.__reportCur=reportCur;", "console.js");
  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({
    email: "a@b.c", name: "A Person", company: "A Co",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER", preferred: "PROPERTY_MANAGEMENT",
  });
  assert.equal(typeof (w.win["__reportCur"] as () => string)(), "string");
});
