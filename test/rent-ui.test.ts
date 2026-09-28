/* ======================================================================
 * SWITCHING AUTOMATIC RENT ON, FROM A SCREEN.
 *
 * The backend refuses to bill a company that has not asked. This is where they
 * ask, and it is the most consequential button in the product: pressing it
 * lets PALTAS create invoices for real tenants.
 *
 * So the thing these tests care about most is that it CANNOT be pressed by
 * accident, and that the warning it carries is the true one — PALTAS cannot
 * see invoices raised outside PALTAS, so a landlord who has been typing rent
 * by hand and switches this on bills this month twice.
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

/** What GET /rent/automation returns. */
function status(over: Record<string, unknown> = {}) {
  return {
    autoRent: false,
    period: "2026-10",
    leases: { live: 3, billableThisPeriod: 2, onDefaultDay: 3, onDefaultBilling: 2 },
    passedOver: [
      { id: "l2", ref: "L-0002", unitRef: "A-200", why: "no rent is recorded on this lease" },
    ],
    history: [
      { periodKey: "2026-09", currency: "KES", invoices: 2, amount: "27000000" },
    ],
    ...over,
  };
}

function open(payload: unknown, { signedIn = true } = {}) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8") +
    "\n;window.__S=SCREENS;window.__A=ACTIONS;window.__R=function(){return RENT;};",
    "console.js");
  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({
    email: "a@b.c", name: "A Person", company: "A Co",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER", preferred: "PROPERTY_MANAGEMENT",
  });

  const sent: Array<{ path: string; body: unknown }> = [];
  if (signedIn) {
    P.Data = {
      configured: () => true, create: () => Promise.resolve({}), update: () => Promise.resolve({}),
      request: (path: string, opts?: { body?: unknown }) => {
        sent.push({ path, body: opts?.body });
        if (path.startsWith("/rent/automation")) return Promise.resolve(payload);
        return Promise.resolve({});
      },
    };
  }
  return {
    sent,
    win: w.win as Record<string, any>,
    html: () => (w.win["__S"] as Record<string, () => string>)["fin_rent"]!(),
    act: (k: string, a?: unknown) =>
      (w.win["__A"] as Record<string, (x?: unknown) => unknown>)[k]!(a),
    settle: async () => {
      (w.win["__S"] as Record<string, () => string>)["fin_rent"]!();
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}

test("it asks the server what the state is", { skip }, async () => {
  const c = open(status());
  await c.settle();
  assert.ok(c.sent.some((s) => s.path.startsWith("/rent/automation")));
});

test("a company that has not asked for it sees OFF", { skip }, async () => {
  const c = open(status());
  await c.settle();
  const html = c.html();
  assert.match(html, />Off</);
  assert.doesNotMatch(html, />On</);
  assert.match(html, /Switch it on/);
});

/*
 * THE MOST IMPORTANT TEST HERE. Pressing "Switch it on" must ASK, not act —
 * this button lets PALTAS create invoices for real tenants.
 */
test("switching it on asks first, and sends nothing until confirmed", { skip }, async () => {
  const c = open(status());
  await c.settle();

  /*
   * THE BUTTON, NOT THE ACTION.
   *
   * Calling rentAsk() proves rentAsk asks. It does not prove the button is
   * wired to it — and a primary button pointing at rentEnable would switch
   * automatic billing on in one click, with the confirmation still sitting in
   * the file unreached. That is the failure this asserts against.
   */
  const off = c.html();
  assert.match(off, /data-act="rentAsk::x"[^>]*>Switch it on</,
    "the enable button must ask, not act");
  assert.doesNotMatch(off, /data-act="rentEnable/,
    "nothing on the unconfirmed screen may enable it directly");

  c.act("rentAsk");
  const asking = c.html();
  assert.match(asking, /Switch automatic rent invoicing on\?/);
  assert.equal(c.sent.filter((s) => s.path === "/organization/settings").length, 0,
    "nothing was changed by opening the question");

  c.act("rentCancel");
  assert.doesNotMatch(c.html(), /Switch automatic rent invoicing on\?/);
  assert.equal(c.sent.filter((s) => s.path === "/organization/settings").length, 0);
});

test("the confirmation carries the warning that matters", { skip }, async () => {
  const c = open(status());
  await c.settle();
  c.act("rentAsk");
  const html = c.html();

  assert.match(html, /can create invoices for\s+your active leases/,
    "what it will do");
  assert.match(html, /correct\s+rent amount, rent day and billing frequency/,
    "what to check first");
  assert.match(html, /cannot see invoices raised outside PALTAS/i,
    "the duplicate-billing warning — this is the one that must not be hidden");
  assert.match(html, /stopped creating these same rent\s+invoices by hand/i);
  assert.match(html, /raises nothing by itself/i, "and that enabling is not billing");
  assert.match(html, /October 2026/, "the period the next run would cover");
});

test("confirming sends the change, and the screen reads the answer back", { skip }, async () => {
  const c = open(status());
  await c.settle();
  c.act("rentAsk");
  c.act("rentEnable");
  await new Promise((r) => setTimeout(r, 5));

  const patch = c.sent.find((s) => s.path === "/organization/settings");
  assert.ok(patch, "it was sent");
  /* The property, not the object: the body was built inside the vm realm, so
     its prototype differs and assert/strict compares prototypes — the same
     trap roles-console.test.ts documents. */
  assert.equal((patch!.body as Record<string, unknown>)["autoRent"], true);
  assert.ok(c.sent.filter((s) => s.path.startsWith("/rent/automation")).length >= 2,
    "and it re-reads rather than assuming it worked");
});

test("a company that has asked for it sees ON, and can switch it off", { skip }, async () => {
  const c = open(status({ autoRent: true }));
  await c.settle();
  const html = c.html();
  assert.match(html, />On</);
  assert.match(html, /Switch it off/);
  assert.match(html, /next run covers <\/b>|next run covers/i);
});

/* Readiness must name the leases it would pass over, and why — never fill in a
   value nobody chose. */
test("it lists the leases it would pass over, with the reason", { skip }, async () => {
  const c = open(status());
  await c.settle();
  const html = c.html();
  assert.match(html, /L-0002/);
  assert.match(html, /no rent is recorded on this lease/);
  assert.match(html, /Nothing here is guessed at/);
});

test("it shows what has already been raised, in the lease's currency", { skip }, async () => {
  const c = open(status());
  await c.settle();
  const html = c.html();
  assert.match(html, /September 2026/);
  assert.match(html, /KES 270,000/, "27,000,000 minor units, in the currency it was raised in");
});

test("a company with no leases is told what to do first", { skip }, async () => {
  const c = open(status({ leases: { live: 0, billableThisPeriod: 0, onDefaultDay: 0, onDefaultBilling: 0 } }));
  await c.settle();
  const html = c.html();
  assert.match(html, /ready to configure/);
  assert.match(html, /Create your leases first/);
  /* emptyState renders the action and its argument as two attributes. */
  assert.match(html, /data-act="newOpen" data-arg="rentals"/,
    "the button goes to the real lease form");
});

test("signed out, it says so rather than showing a sample", { skip }, async () => {
  const c = open(status(), { signedIn: false });
  await c.settle();
  assert.match(c.html(), /Sign in to your company/);
});

/* ======================================================================
 * THE LEASE FORM
 * ====================================================================== */

test("the lease form asks for rent day and billing frequency, and explains them", { skip }, async () => {
  const { CONSOLE_FORMS } = await import("../src/domain/console-map.ts");
  const spec = CONSOLE_FORMS["rentals"]!;
  const fields = Object.values(spec.fields);
  assert.ok(fields.includes("rentDay"), "rent day is on the form");
  assert.ok(fields.includes("billing"), "billing frequency is on the form");

  const hints = spec.hints || {};
  assert.match(String(hints["rentDay"]), /when PALTAS raises the rent invoice/i);
  assert.match(String(hints["rentDay"]), /last day of that month/i,
    "day 31 in a short month bills on the last day — never 'skips the month'");
  assert.doesNotMatch(String(hints["rentDay"]), /skip/i);
  assert.match(String(hints["billing"]), /every month/i);
  assert.match(String(hints["billing"]), /month the lease\s+starts/i,
    "quarterly and yearly are anchored to the lease start month");
});

/* A hint the service sends and the console never renders is a hint nobody
   reads. */
test("the console renders a field's help text", { skip }, () => {
  const src = readFileSync(join(FE, "assets", "console.js"), "utf8");
  assert.match(src, /f\.hint \? `<span class="sub">\$\{esc\(f\.hint\)\}<\/span>` : ""/,
    "the form does not show the help text the service sends with it");
});

/* §11: changing rent must never read as rewriting what was already billed. */
test("the lease screen says a rent change does not rewrite history", { skip }, () => {
  const src = readFileSync(join(FE, "assets", "console.js"), "utf8");
  assert.match(src, /Changes to a lease's rent apply to future billing/);
  assert.match(src, /existing invoices and\s+payments are not rewritten/i);
});
