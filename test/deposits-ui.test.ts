/* ======================================================================
 * WHAT A COMPANY SEES OF THE MONEY IT IS HOLDING.
 *
 * The backend rules are proved in deposits.test.ts. This is the other half of
 * "complete": a rule the server enforces and the screen does not offer is a
 * button that gets refused, and a rule the screen offers and the server does
 * not enforce is worse. These pin the three places the two have to agree.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const consoleJs = join(FE, "assets", "console.js");
const skip = existsSync(consoleJs) ? false : `no frontend at ${FE}`;

/** A signed-in finance console, holding the deposits it is told to hold. */
function deposits(rows: Record<string, unknown>[]) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode("window.PALTAS = { Market: { lookup: function () { return null; },"
    + " countries: function () { return []; } } };", "market-stub.js");
  w.loadCode(readFileSync(consoleJs, "utf8")
    + "\n;window.__d=DEPOSITS;window.__s=SCREENS;window.__nav=navFor;"
    + "window.__full=moneyInFull;window.__t=TENANTS;", "console.js");

  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({
    email: "a@b.c", name: "A Person", company: "A Co",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER",
    preferred: "PROPERTY_MANAGEMENT", country: "ke",
  });

  const d = w.win["__d"] as Record<string, unknown>[];
  d.length = 0;
  for (const r of rows) d.push(r);
  return {
    win: w.win,
    html: () => ((w.win["__s"] as Record<string, () => string>)["fin_deposits"])(),
    leases: () => ((w.win["__s"] as Record<string, () => string>)["rentals"])(),
    tenants: w.win["__t"] as Record<string, unknown>[],
    nav: w.win["__nav"] as (sys: string) => { title: string; items: unknown[][] }[],
    full: w.win["__full"] as (n: number, cur?: string) => string,
  };
}

const DEP = {
  m: "all", id: "d1", ref: "DEP-0001", tenant: "Grace Wanjiru", unit: "A-101",
  leaseId: "l1", required: 270000, received: 270000, deducted: 0, returned: 0,
  held: 270000, cur: "KES", status: "HELD", account: "Deposit account",
  disputeReason: "", movements: [], rowId: "d1",
};

test("the screen exists, and the sidebar reaches it", { skip }, () => {
  /*
   * A screen with no way to it is a screen nobody uses. It belongs under
   * Property finance rather than Money in, because taking a deposit earns the
   * company nothing.
   */
  const d = deposits([]);
  assert.equal(typeof (d.win["__s"] as Record<string, unknown>)["fin_deposits"], "function");

  const finance = d.nav("property").find((g) => g.title === "Finance");
  assert.ok(finance, "there is no Finance section");
  const item = finance.items.find((i) => i[0] === "fin_deposits");
  assert.ok(item, "the sidebar cannot reach the deposits screen");
  assert.equal(item[4], "Property finance",
    `it is filed under ${item[4]} — taking a deposit is not money in`);
});

test("IT SAYS THE MONEY IS NOT THE COMPANY'S", { skip }, () => {
  /*
   * The one sentence that has to be on this screen. Everything else is
   * arithmetic; this is the part somebody has to read before they spend it.
   */
  const html = deposits([DEP]).html();
  assert.match(html, /not the company's money/i);
  assert.match(html, /2100 Tenant deposits\s*held/i,
    "it does not say where this is booked, so nobody can check it is not income");
});

test("held is received less deducted less returned, and shown as the figure", { skip }, () => {
  const d = deposits([{ ...DEP, received: 270000, deducted: 40000, returned: 30000, held: 200000 }]);
  const html = d.html();
  assert.ok(html.includes(d.full(200000, "KES")), "the held figure is not on the row");
});

test("a deduction is not offered when there is nothing to take", { skip }, () => {
  /* The server refuses it. A button that is always refused teaches people to
     ignore refusals. */
  const html = deposits([{ ...DEP, received: 270000, returned: 270000, held: 0, status: "SETTLED" }]).html();
  assert.ok(!html.includes("dep-out::d1"), "it offers a deduction out of nothing");
  assert.ok(!html.includes("dep-back::d1"), "it offers to return nothing");
});

test("A DISPUTE HIDES DEDUCT AND KEEPS RETURN", { skip }, () => {
  /*
   * The asymmetry the whole feature turns on, and the screen has to match it:
   * a company must not keep taking more while the tenant is objecting, and
   * must still be able to give money back — several jurisdictions require the
   * undisputed part to go back promptly whatever else is unresolved.
   */
  const html = deposits([{ ...DEP, status: "DISPUTED", disputeReason: "Tenant contests the cleaning" }]).html();
  assert.ok(!html.includes("dep-out::d1"), "a deduction is offered during a dispute");
  assert.ok(html.includes("dep-back::d1"), "a return is blocked during a dispute");
  assert.ok(html.includes("dep-resolve::d1"), "there is no way to resolve it");
  assert.match(html, /contests the cleaning/, "it does not say what is disputed");
});

test("the states a landlord acts on are counted", { skip }, () => {
  const html = deposits([
    { ...DEP, id: "a", status: "DUE", received: 0, held: 0 },
    { ...DEP, id: "b", status: "PARTIAL", received: 100000, held: 100000 },
    { ...DEP, id: "c", status: "DISPUTED" },
  ]).html();
  assert.match(html, /Agreed, not received/);
  assert.match(html, /Short of the agreement/);
  assert.match(html, /In dispute/);
});

test("nothing kept shows as nothing, not as a deduction of zero", { skip }, () => {
  /* Most tenancies end with nothing kept. "KES 0.00" in that column reads as a
     deduction somebody decided on and set to nothing. */
  const d = deposits([DEP]);
  const html = d.html();
  assert.ok(!html.includes(`<td>${d.full(0, "KES")}</td>`), "it prints a zero deduction");
});

test("an account nobody has named is said so, not left blank", { skip }, () => {
  /* Several jurisdictions require a company to be able to name the account a
     deposit sits in. Silence reads as "it is somewhere". */
  const html = deposits([{ ...DEP, account: "" }]).html();
  assert.match(html, /no account named/);
});

test("THE LEASES SCREEN IS WHERE A DEPOSIT IS OPENED", { skip }, () => {
  /*
   * The lifecycle needs an entry point in the product, or every rule behind it
   * is unreachable. The lease is where it belongs: the agreed figure and the
   * currency come off the tenancy.
   */
  const d = deposits([]);
  d.tenants.length = 0;
  d.tenants.push({
    m: "all", id: "l1", n: "Grace Wanjiru", u: "A-101", since: "Oct 2026",
    rent: 135000, svc: 0, deposit: 270000, cur: "KES", rentDay: 1,
    billing: "MONTHLY", score: 0, ends: null,
  });

  const html = d.leases();
  assert.match(html, /<th>Deposit<\/th>/, "the leases table does not mention a deposit");
  assert.ok(html.includes('data-pre="dep-open::l1"'),
    "there is no way to open a deposit against a tenancy, so the feature is unreachable");
  assert.ok(html.includes(d.full(270000, "KES")), "it does not say what was agreed");
});

test("a tenancy that already has one points at it instead", { skip }, () => {
  const d = deposits([{ ...DEP, leaseId: "l1", held: 270000 }]);
  d.tenants.length = 0;
  d.tenants.push({
    m: "all", id: "l1", n: "Grace Wanjiru", u: "A-101", since: "Oct 2026",
    rent: 135000, svc: 0, deposit: 270000, cur: "KES", rentDay: 1,
    billing: "MONTHLY", score: 0, ends: null,
  });

  const html = d.leases();
  assert.ok(!html.includes('data-pre="dep-open::l1"'),
    "it offers to open a second deposit on a tenancy that has one");
  assert.match(html, /DEP-0001/);
  assert.match(html, /held/);
});

test("every deposit button declares itself, so the label dispatcher leaves it alone",
  { skip }, () => {
    /*
     * The console has a last-resort dispatcher that matches a button by its
     * visible LABEL. `data-pre` was missing from its exclusion list, so every
     * Clear, Issue, Waive, Deduct and Return fell through to it as well —
     * harmless until the first label that collides with a screen name.
     */
    const src = readFileSync(consoleJs, "utf8");
    const guard = src.match(/if \(b\.hasAttribute\("data-act"\)[\s\S]*?return;/);
    assert.ok(guard, "the label dispatcher's exclusion list is gone");
    assert.match(guard[0], /hasAttribute\("data-pre"\)/,
      "a data-pre button is still dispatched twice");
  });

test("the deduction prompt refuses an empty reason before anything is sent", { skip }, () => {
  /*
   * Asked here as well as refused by the server. A tenant is entitled to the
   * sentence, and a round trip that comes back 400 teaches somebody to type a
   * full stop into the box.
   */
  const src = readFileSync(consoleJs, "utf8");
  const ask = src.match(/function depAsk\([\s\S]*?\n\}/);
  assert.ok(ask, "depAsk is gone");
  assert.match(ask[0], /length < 5/, "an empty reason is sent to the server to be refused");
  assert.match(ask[0], /entitled/, "it does not say why the reason is needed");
});

test("deposit-funded settlements are kept out of cash received", { skip }, () => {
  /*
   * When arrears come out of a deposit the invoice really is paid, so a Payment
   * is the honest record — but no cash arrived. It arrived months earlier, as
   * the deposit. Counting it again overstates collected, available cash and
   * revenue all at once.
   */
  const src = readFileSync(join(FE, "assets", "paltas-hydrate.js"), "utf8");
  const payments = src.match(/\(by\.payments \|\| \[\]\)\.forEach\(function \(r\) \{[\s\S]*?\n      \}\);/);
  assert.ok(payments, "the payments branch of the merged cash list is gone");
  assert.match(payments[0], /if \(r\.fromDepositId\) return;/,
    "a deposit-funded settlement is counted as cash arriving, so the same money is counted twice");
});

test("the held figure the banking screens show is the real one where one exists", { skip }, () => {
  /*
   * Those tiles have always read "Deposits held" out of the sample ledger's two
   * demo rows, so for a real company they said nothing. Real deposits are the
   * answer where a company has any; the demo rows stand only while it has none.
   */
  const src = readFileSync(consoleJs, "utf8");
  assert.match(src, /const deposits = depositsHeldNow\(\)\s*\|\|/,
    "the banking tiles do not prefer real deposits");
  const fn = src.match(/function depositsHeldNow\(\)[\s\S]*?\n\}/);
  assert.ok(fn, "depositsHeldNow is gone");
  assert.match(fn[0], /sumIn\(/,
    "it adds across currencies by hand instead of through sumIn, so two currencies "
    + "would be summed at a rate nobody set");
});
