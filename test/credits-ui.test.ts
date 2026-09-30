/* ======================================================================
 * THE TWO WAYS TO UNDO AN INVOICE, AND KEEPING THEM APART ON SCREEN.
 *
 * A credit note says the bill was wrong; a refund says the money goes back.
 * The backend keeps `credited` out of `paid` so a collections figure cannot
 * report cash that never arrived — and the console can put that straight back
 * the moment it draws them in one column, or offers one button where somebody
 * meant the other.
 *
 * So: separate columns, separate controls, on separate screens — the credit
 * on the invoice, the refund on the payment, because only one of them can be
 * decided from a payment row.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";
import type { Foreign } from "./wire.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const skip = existsSync(join(FE, "assets", "console.js"))
  ? false
  : `no frontend at ${FE}`;

const INV = [
  { m: "ke", id: "i1", no: "INV-0001", party: { type: "tenant", name: "Grace Wanjiru" },
    cur: "KES", gross: 100_000, paid: 0, credited: 0, owing: 100_000,
    status: "sent", date: "1 Sep", due: "1 Oct", prop: "", unit: "", lineCount: 1, note: "" },
  { m: "ke", id: "i2", no: "INV-0002", party: { type: "tenant", name: "Mwangi Holdings" },
    cur: "KES", gross: 80_000, paid: 20_000, credited: 60_000, owing: 0,
    status: "paid", date: "1 Sep", due: "1 Oct", prop: "", unit: "", lineCount: 1, note: "" },
];

const PAYS = [
  { m: "ke", at: "12 Sep", amount: 50_000, cur: "KES", method: "Cash", ref: "—",
    inv: "INV-0001", voided: false, st: "Received", sc: "p-g", why: "",
    receipt: null, canReceipt: true, whyNoReceipt: "", id: "p1" },
  { m: "ke", at: "13 Sep", amount: -20_000, cur: "KES", method: "Cash", ref: "refund",
    inv: "INV-0001", voided: false, st: "Received", sc: "p-g", why: "",
    receipt: null, canReceipt: false, whyNoReceipt: "That is a refund", id: "p2" },
  { m: "ke", at: "14 Sep", amount: 10_000, cur: "KES", method: "Cash", ref: "—",
    inv: "INV-0001", voided: true, st: "Void", sc: "p-n", why: "taken in error",
    receipt: null, canReceipt: false, whyNoReceipt: "voided", id: "p3" },
];

function open() {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8")
    + "\n;window.__S=SCREENS;window.__A=ACTIONS;"
    + "\n;window.__seed=function(inv,pay){INVOICES.length=0;inv.forEach(function(r){INVOICES.push(r);});"
    + "PAYHIST.length=0;pay.forEach(function(r){PAYHIST.push(r);});};",
    "console.js");
  const P = w.win["PALTAS"] as Foreign;
  P.Session.create({ email: "a@b.c", name: "A Person", company: "Almas LTD",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER",
    preferred: "PROPERTY_MANAGEMENT", country: "ke" });
  (w.win["__seed"] as (a: unknown[], b: unknown[]) => void)(INV, PAYS);
  const S = w.win["__S"] as Record<string, () => string>;
  return {
    invoices: () => S["fin_invoices"]!(),
    history: () => S["fin_history"]!(),
    actions: w.win["__A"] as Record<string, unknown>,
  };
}

test("credited has its own column, never folded into paid", { skip }, () => {
  const html = open().invoices();
  assert.match(html, /<th>Credited<\/th>/,
    "a credited amount hidden inside Paid reports cash that never arrived");
});

test("an owing invoice is offered both, and they are different words", { skip }, () => {
  /* act() packs the argument into data-act with "::" — the other spelling,
     data-arg, is what the dispatcher had to be taught to read. Both reach
     their action now; these buttons use the first. */
  const html = open().invoices();
  assert.match(html, /data-act="invPay::i1"/, "no way to take money");
  assert.match(html, /data-act="invCredit::i1"/, "no way to write it off");
});

test("a settled invoice is offered neither", { skip }, () => {
  /* The server refuses a credit note on an invoice that owes nothing and says
     to refund instead. Offering the button anyway would be one that fails. */
  const html = open().invoices();
  assert.doesNotMatch(html, /data-act="invCredit::i2"/);
});

test("the credit panel says no money moves, and where a refund lives", { skip }, () => {
  const c = open();
  (c.actions["invCredit"] as (id: string) => void)("i1");
  const html = c.invoices();
  assert.match(html, /No money moves/i);
  assert.match(html, /refund/i, "it must point to the other act by name");
  assert.match(html, /data-cf="amount"/);
  assert.match(html, /data-cf="reason"/);
});

test("the credit form opens on what is owed, not what was billed", { skip }, () => {
  const c = open();
  (c.actions["invCredit"] as (id: string) => void)("i1");
  assert.match(c.invoices(), /data-cf="amount"[^>]*value="100000"/,
    "it offered an amount the server would refuse");
});

test("a payment that arrived can be refunded", { skip }, () => {
  const html = open().history();
  assert.match(html, /data-act="payRefund" data-arg="p1"/);
});

test("a refund and a voided payment are not offered a refund", { skip }, () => {
  const html = open().history();
  assert.doesNotMatch(html, /data-act="payRefund" data-arg="p2"/,
    "refunding a refund sends the money out twice");
  assert.doesNotMatch(html, /data-act="payRefund" data-arg="p3"/,
    "the company never kept a voided payment");
});

test("the refund panel says the invoice is owed again", { skip }, () => {
  const c = open();
  (c.actions["payRefund"] as (id: string) => void)("p1");
  const html = c.history();
  assert.match(html, /owed again/i,
    "giving money back un-collects the bill; it does not cancel it");
  assert.match(html, /data-rf="amount"/);
  assert.match(html, /data-rf="reason"/);
});

test("opening a credit closes any payment form on the same invoice", { skip }, () => {
  /* Two forms about one invoice, one of them forgotten, is how somebody
     records a payment they meant to write off. */
  const c = open();
  (c.actions["invPay"] as (id: string) => void)("i1");
  (c.actions["invCredit"] as (id: string) => void)("i1");
  const html = c.invoices();
  assert.match(html, /data-cf="reason"/, "the credit form is not open");
  assert.doesNotMatch(html, /data-pf="method"/, "the payment form is still open beside it");
});

test("every control has an action behind it", { skip }, () => {
  const a = open().actions;
  for (const k of ["invCredit", "crnSave", "crnClose", "payRefund", "rfndSave", "rfndClose"]) {
    assert.equal(typeof a[k], "function", `${k} is offered but does nothing`);
  }
});
