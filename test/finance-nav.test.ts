/* ======================================================================
 * FINANCE, GROUPED THE WAY MONEY MOVES — AND HONEST ABOUT THE GAPS.
 *
 * The requested structure names nine groups and about forty entries. Roughly
 * half have a screen. The rest are listed here BY NAME rather than added to
 * the menu, because a menu item that opens nothing teaches somebody the
 * product is broken — and this console has spent a week having exactly that
 * removed.
 *
 * Several already have a working API behind them: accounting periods can be
 * closed and reopened, receivables are real, tax rules are time-bounded. They
 * are screens waiting to be written, not capabilities waiting to be invented,
 * and this file is where that distinction is kept.
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

const GROUPS = [
  "Money in", "Money out", "Property finance", "Banking",
  "Accounting", "Tax & compliance", "Capital", "Statements & reports",
];

/**
 * Asked for, and not built. Each is a screen that does not exist — not a
 * menu entry somebody forgot.
 *
 * Kept as a list so it is read and gets shorter, in the same spirit as the
 * unoffered lookups and the undeclared reminders.
 */
const NOT_BUILT: Record<string, string> = {
  "Bills": "a supplier bill is not a model; purchase orders and goods receipts are",
  "Suppliers": "suppliers are Parties of kind VENDOR, and live under Operations",
  "Payables": "no AP ageing screen; the ledger has the accounts",
  "Tenant Balances": "per-tenant arrears exist in receivables and Client 360, not as a screen",
  "Service Charges": "no ServiceCharge model at all",
  "Deposits": "a deposit is a BigInt on lease/contract/offer, with no held/returned lifecycle",
  "Bank Accounts": "the API has /banking/accounts; no screen lists them",
  "M-PESA": "a payment METHOD, not a screen — it appears on payments and reconciliation",
  "General Ledger": "the Journal screen is the nearest; no GL view",
  "Periods": "POST /ledger/periods/:id/close and /reopen work; no screen drives them",
  "Closing": "same as Periods",
  "Tax Codes": "only rates exist, and they are time-bounded",
  "Tax Periods": "no tax period model",
  "Tax Reports": "no tax reporting screen",
  "Budgets": "a BigInt on Project, not a budgeting capability",
  "Forecast": "not built",
  "Scenarios": "not built",
};

function financeGroup() {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(file, "utf8")
    + "\n;window.__nav=navFor;window.__S=SCREENS;", "console.js");
  const P = w.win["PALTAS"] as Foreign;
  P.Session.create({ email: "a@b.c", name: "A Person", company: "Almas LTD",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER",
    preferred: "PROPERTY_MANAGEMENT", country: "ke" });
  const nav = Array.from((w.win["__nav"] as (s: string) => Foreign[])("property") || []);
  const fin = nav.find((g: Foreign) => g.title === "Finance");
  assert.ok(fin, "there is no Finance section");
  return { items: Array.from(fin.items as Foreign[]), screens: w.win["__S"] as Record<string, unknown> };
}

test("finance carries the groups, in the order money moves", { skip }, () => {
  const { items } = financeGroup();
  const seen: string[] = [];
  for (const it of items) {
    const sub = String((it as Foreign[])[4] || "");
    if (sub && seen[seen.length - 1] !== sub) seen.push(sub);
  }
  assert.deepEqual(seen, GROUPS, `groups came out as: ${seen.join(" | ")}`);
});

test("each group's entries sit together", { skip }, () => {
  /* navSection draws a sub-heading when the value CHANGES, so a group split
     in two draws its heading twice and reads as two different things. */
  const { items } = financeGroup();
  const order = items.map((it) => String((it as Foreign[])[4] || ""));
  const firstSeen = new Map<string, number>();
  order.forEach((s, i) => { if (s && !firstSeen.has(s)) firstSeen.set(s, i); });
  for (const [sub, first] of firstSeen) {
    const last = order.lastIndexOf(sub);
    const between = order.slice(first, last + 1).filter((x) => x !== sub);
    assert.deepEqual(between, [], `"${sub}" is split by ${between.join(", ")}`);
  }
});

test("every finance entry opens a screen that exists", { skip }, () => {
  /* The whole reason the missing half is a list in this file and not a menu. */
  const { items, screens } = financeGroup();
  const dead = items
    .map((it) => String((it as Foreign[])[0]))
    .filter((key) => typeof screens[key] !== "function");
  assert.deepEqual(dead, [], `finance offers ${dead.join(", ")}, which open nothing`);
});

test("what was asked for and is not built is written down, not quietly dropped",
  { skip }, () => {
    const { items } = financeGroup();
    const labels = new Set(items.map((it) => String((it as Foreign[])[2]).toLowerCase()));
    /* If one of these ever gets a screen it should leave this list, and this
       is what makes that happen rather than the list going stale. */
    const built = Object.keys(NOT_BUILT).filter((n) => labels.has(n.toLowerCase()));
    assert.deepEqual(built, [],
      `${built.join(", ")} now has a menu entry — take it off the not-built list`);
    assert.ok(Object.keys(NOT_BUILT).length >= 15,
      "the gap list has shrunk without the tests noticing");
  });
