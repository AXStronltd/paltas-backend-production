/* ======================================================================
 * RECORDING A PAYMENT, FROM A SCREEN.
 *
 * `POST /payments` was written, careful and complete, and no button ever
 * called it. What the console had instead was ACTIONS.finCollectNow, which
 * moved a row in the tab's own memory and said "it has moved out of
 * receivables and into cash". Nothing was sent anywhere and a refresh put it
 * back.
 *
 * These tests hold the replacement to the three promises it makes:
 *   1. An UNPAID invoice is visible at all — the old invoice book grouped
 *      payments, so an invoice nobody had paid had nothing to group.
 *   2. The form refuses what the server would refuse, before sending it.
 *   3. What it sends is what POST /payments expects: minor units, and no
 *      currency, because the server takes that from the invoice.
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
  : `no frontend at ${FE} — set PALTAS_FRONTEND to run these`;

interface Created { slug: string; body: Record<string, unknown> }

/** One console, signed in, with the data layer recorded rather than called. */
function open() {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8") +
    "\n;window.__S=SCREENS;window.__A=ACTIONS;window.__INV=INVOICES;" +
    "\n;window.__PAY=function(){return PAY;};",
    "console.js");

  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({
    email: "person@example.com", name: "A Person", company: "A Company",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER", preferred: "PROPERTY_MANAGEMENT",
  });

  const created: Created[] = [];
  let fail: Error | null = null;
  P.Data = {
    configured: () => true,
    create: (slug: string, body: Record<string, unknown>) => {
      created.push({ slug, body });
      return fail ? Promise.reject(fail) : Promise.resolve({ id: "pay_1" });
    },
    update: () => Promise.resolve({}),
  };
  return {
    w, created,
    failWith: (e: Error) => { fail = e; },
    S: w.win["__S"] as Record<string, () => string>,
    A: w.win["__A"] as Record<string, (a?: unknown) => unknown>,
    INV: w.win["__INV"] as Record<string, unknown>[],
    pay: w.win["__PAY"] as () => Record<string, any> | null,
    field: (name: string, value: string) => {
      const el = (w.win["document"] as any).querySelector(`[data-pf="${name}"]`);
      el.value = value;
    },
  };
}

/** An invoice in exactly the shape the INVOICES adapter produces. */
function invoice(over: Record<string, unknown> = {}) {
  return {
    m: "all", id: "inv_1", no: "INV-2026-0041",
    party: { type: "tenant", name: "Grace Wanjiru" },
    cur: "KES", gross: 142000, paid: 0, owing: 142000,
    status: "sent", date: "2026-09-01", due: "2026-09-05",
    prop: "", unit: "", lineCount: 1, note: "",
    ...over,
  };
}

test("an unpaid invoice is on the screen, with what it owes", { skip }, () => {
  const c = open();
  c.INV.push(invoice());
  const html = c.S["fin_invoices"]();

  assert.match(html, /INV-2026-0041/, "the invoice is listed");
  assert.match(html, /Record payment/, "and it offers to take the money");
  /* The figure that used to be structurally zero, because `owing` was the sum
     of the payments minus the payments. */
  assert.ok(/1,420,00|142,000/.test(html), `the outstanding figure is shown:\n${html.slice(0, 400)}`);
});

test("a fully paid invoice does not offer to take money again", { skip }, () => {
  const c = open();
  c.INV.push(invoice({ paid: 142000, owing: 0, status: "paid" }));
  assert.doesNotMatch(c.S["fin_invoices"](), /Record payment/);
});

test("a draft invoice does not offer it either — nobody has been asked yet", { skip }, () => {
  const c = open();
  c.INV.push(invoice({ status: "draft" }));
  assert.doesNotMatch(c.S["fin_invoices"](), /Record payment/);
});

/*
 * VOID is one of the API's six invoice statuses and was missing from
 * INV_STATES, so the table read INV_STATES["void"][1] and threw. A blank page
 * is how that looked to somebody using it.
 */
test("a void invoice renders instead of taking the page down", { skip }, () => {
  const c = open();
  c.INV.push(invoice({ status: "void" }));
  const html = c.S["fin_invoices"]();
  assert.match(html, /Void/);
  assert.doesNotMatch(html, /Record payment/);
});

test("the form opens against the invoice, defaulted to what is owed", { skip }, () => {
  const c = open();
  c.INV.push(invoice());
  c.A["invPay"]("inv_1");
  const p = c.pay();
  assert.equal(p?.["id"], "inv_1");
  assert.equal(p?.["v"].amount, "142000", "defaulted to the outstanding amount");
  assert.match(c.S["fin_invoices"](), /Record a payment against INV-2026-0041/);
});

test("it refuses a payment with no reference, and sends nothing", { skip }, () => {
  const c = open();
  c.INV.push(invoice());
  c.A["invPay"]("inv_1");
  c.field("amount", "142000");
  c.field("reference", "");
  c.field("method", "MPESA");
  c.A["paySave"]();

  assert.equal(c.created.length, 0, "nothing was sent");
  assert.match(String(c.pay()?.["err"]), /reference/i);
});

test("it refuses nothing-at-all as an amount", { skip }, () => {
  const c = open();
  c.INV.push(invoice());
  c.A["invPay"]("inv_1");
  c.field("amount", "0");
  c.field("reference", "QGR7X8K2LM");
  c.A["paySave"]();

  assert.equal(c.created.length, 0);
  assert.match(String(c.pay()?.["err"]), /more than nothing/i);
});

/*
 * THE SHAPE ON THE WIRE. Two things here are the whole point:
 *
 *   MINOR UNITS. The screen works in what a person types; the API works in
 *   minor units. 142000 typed is 14,200,000 sent.
 *
 *   NO CURRENCY. The server takes it from the invoice. A client that can name
 *   the currency can name the wrong one, and two currencies added together is
 *   a wrong total that looks right.
 */
test("what it sends is what POST /payments expects", { skip }, () => {
  const c = open();
  c.INV.push(invoice());
  c.A["invPay"]("inv_1");
  c.field("amount", "142000");
  c.field("reference", "QGR7X8K2LM");
  c.field("method", "MPESA");
  c.field("receivedAt", "2026-09-23");
  c.field("receivedBy", "A Person");
  c.A["paySave"]();

  assert.equal(c.created.length, 1, "one payment was sent");
  const { slug, body } = c.created[0]!;
  assert.equal(slug, "payments");
  assert.equal(body["invoiceId"], "inv_1");
  assert.equal(body["amount"], 14200000, "minor units");
  assert.equal(body["method"], "MPESA");
  assert.equal(body["reference"], "QGR7X8K2LM");
  assert.ok(!("currency" in body), "the currency is the server's to decide");
});

/* A card payment arrives through Stripe's webhook with the provider's own
   reference. Offering it here would create a second row for the same money. */
test("CARD is not offered as a way to hand money over", { skip }, () => {
  const c = open();
  c.INV.push(invoice());
  c.A["invPay"]("inv_1");
  const html = c.S["fin_invoices"]();
  assert.doesNotMatch(html, /value="CARD"/);
  assert.match(html, /value="MPESA"/);
});

test("the server's refusal is shown in its own words", { skip }, async () => {
  const c = open();
  c.INV.push(invoice());
  c.failWith(new Error("A mpesa payment with reference “QGR7X8K2LM” is already recorded."));
  c.A["invPay"]("inv_1");
  c.field("amount", "142000");
  c.field("reference", "QGR7X8K2LM");
  c.A["paySave"]();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(String(c.pay()?.["err"]), /already recorded/);
});
