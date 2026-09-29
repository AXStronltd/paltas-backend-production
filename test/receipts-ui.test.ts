/* ======================================================================
 * THE PAYMENT HISTORY OFFERS A RECEIPT ONLY WHEN THERE CAN BE ONE.
 *
 * The screen has carried "download receipt" since it was written, with
 * nothing behind it. The failure to avoid now is the opposite one: a button
 * that is always there and fails on click, which teaches somebody the
 * product is broken rather than that the money is not confirmed yet.
 *
 * Three states, and they are genuinely different — issued, issuable, and not
 * yet — so the row says which, and when it cannot, why.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const skip = existsSync(join(FE, "assets", "console.js"))
  ? false
  : `no frontend at ${FE}`;

const ROWS = [
  { m: "ke", at: "12 Sep", amount: 500, cur: "KES", method: "Cash", ref: "—",
    inv: "INV-0001", voided: false, st: "Received", sc: "p-g", why: "",
    receipt: { id: "r1", ref: "RCP-0001", basis: "TAKEN_IN_PERSON", voided: false },
    canReceipt: false, whyNoReceipt: "", id: "p1" },
  { m: "ke", at: "13 Sep", amount: 900, cur: "KES", method: "M-Pesa", ref: "QGR7",
    inv: "INV-0002", voided: false, st: "Received", sc: "p-g", why: "",
    receipt: null, canReceipt: true, whyNoReceipt: "", id: "p2" },
  { m: "ke", at: "14 Sep", amount: 300, cur: "KES", method: "Bank", ref: "FT26",
    inv: "INV-0003", voided: false, st: "Received", sc: "p-g", why: "",
    receipt: null, canReceipt: false,
    whyNoReceipt: "Nothing confirms that payment yet. Reconcile it against the statement line.",
    id: "p3" },
];

function open(rows = ROWS) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8")
    + "\n;window.__S=SCREENS;window.__A=ACTIONS;"
    + "\n;PAYHIST.length=0;" + rows.map(() => "").join("")
    + "\n;window.__setRows=function(rs){PAYHIST.length=0;rs.forEach(function(r){PAYHIST.push(r);});};",
    "console.js");
  (w.win["__setRows"] as (r: unknown[]) => void)(rows);
  return {
    html: () => (w.win["__S"] as Record<string, () => string>)["fin_history"]!(),
    win: w.win as Record<string, unknown>,
  };
}

test("a payment with a receipt shows its number and what it rests on", { skip }, () => {
  const html = open().html();
  assert.match(html, /RCP-0001/);
  assert.match(html, /Received in person/,
    "the row does not say what the receipt rests on");
});

test("a confirmed payment without one offers to issue it", { skip }, () => {
  const html = open().html();
  assert.match(html, /data-act="receiptIssue" data-arg="p2"/);
});

test("an unconfirmed payment is not offered a button that would fail", { skip }, () => {
  const html = open().html();
  assert.doesNotMatch(html, /data-act="receiptIssue" data-arg="p3"/,
    "a button was offered for money nothing confirms — it would fail on click");
  assert.match(html, /Reconcile it against the statement line/,
    "the row must say what would make it issuable");
});

test("a voided receipt is shown as void, not as missing", { skip }, () => {
  /* The customer still has their copy. A row that simply offered to issue a
     new one would hide that a document is out there carrying that number. */
  const rows = [{ ...ROWS[0]!, receipt: { ...ROWS[0]!.receipt!, voided: true } }];
  const html = open(rows).html();
  assert.match(html, /RCP-0001 void/);
  assert.doesNotMatch(html, /data-act="receiptIssue"/);
});

test("the screen states the rule it is enforcing", { skip }, () => {
  const html = open().html();
  assert.match(html, /issued once and never edited/i);
});

test("the action exists and is reachable from the console", { skip }, () => {
  const c = open();
  const actions = c.win["__A"] as Record<string, unknown>;
  assert.equal(typeof actions["receiptIssue"], "function",
    "the button has no action behind it");
});
