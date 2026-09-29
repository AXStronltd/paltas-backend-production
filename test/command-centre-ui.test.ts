/* ======================================================================
 * THE COMMAND CENTRE IS NOT BLANK FOR A COMPANY THAT HAS RECORDS.
 *
 * It counted everything THROUGH SITES and gated its whole content area on
 * whether a property existed. `Unit.siteId` and `Lease.unitId` are both
 * optional, so a company holding two units and four tenancies with no property
 * record saw an empty page offering to help it add its first property — which
 * it had been using for weeks.
 *
 * The first test is that company.
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

/** Almas Tower's actual shape: units and tenancies, no property record. */
function almas(over: Record<string, unknown> = {}) {
  return {
    asAt: "2026-09-28T00:00:00.000Z",
    portfolio: { sites: 0, buildings: 0, units: 2, occupied: 1, vacant: 1,
                 reserved: 0, offMarket: 0, notice: 0, occupancyPct: 50 },
    leases: { live: 4, expiringSoon: [
      { id: "l1", ref: "L-0001", unitRef: "A-101", tenantName: "Grace Wanjiru",
        endsOn: "2026-10-15T00:00:00.000Z", rent: "13500000", currency: "KES" },
    ] },
    operations: { openCases: 3, urgentCases: 1 },
    finance: {
      books: [{ currency: "KES", outstanding: "27000000", overdue: "13500000",
                notYetDue: "13500000", aging: [
        { bucket: "CURRENT", label: "Not yet due", count: 1, amount: "13500000" },
        { bucket: "D31_60", label: "31 – 60 days", count: 1, amount: "13500000" },
      ] }],
      mixed: false, openInvoices: 2,
      collectedThisMonth: [{ currency: "KES", amount: "9000000", count: 3 }],
      expensesThisMonth: [{ currency: "KES", amount: "2500000", count: 2 }],
    },
    attention: [
      { kind: "rent-overdue", what: "Grace Wanjiru — INV-0007 is 45 days late",
        entity: "invoice", entityId: "i7", when: "2026-08-14T00:00:00.000Z",
        priority: "high", screen: "fin_collect" },
    ],
    activity: [
      { id: "a1", at: "2026-09-27T09:12:00.000Z", actorName: "A Person",
        action: "payment.receive", entity: "payment", entityId: "p1" },
    ],
    ...over,
  };
}

function open(payload: unknown, { signedIn = true } = {}) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8") +
    "\n;window.__S=SCREENS;window.__A=ACTIONS;", "console.js");
  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({ email: "a@b.c", name: "A Person", company: "Almas It",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER", preferred: "PROPERTY_MANAGEMENT" });
  const asked: string[] = [];
  if (signedIn) {
    P.Data = { configured: () => true, create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      request: (p: string) => { asked.push(p); return Promise.resolve(payload); } };
  }
  return {
    asked, win: w.win as Record<string, any>,
    html: () => (w.win["__S"] as Record<string, () => string>)["command"]!(),
    settle: async () => {
      (w.win["__S"] as Record<string, () => string>)["command"]!();
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}

test("it asks one endpoint rather than counting for itself", { skip }, async () => {
  const c = open(almas());
  await c.settle();
  assert.deepEqual(c.asked, ["/command-centre"]);
});

/* THE DEFECT. Two units and four tenancies, no property record. */
test("a company with units and tenancies but no property is not blank", { skip }, async () => {
  const c = open(almas());
  await c.settle();
  const html = c.html();

  assert.doesNotMatch(html, /Start with your first property/,
    "it must not offer to set up a company that is already running");
  assert.match(html, /<b>2<\/b><span>Units/, "its units are counted");
  assert.match(html, /<b>4<\/b><span>Active tenancies/, "and its tenancies");
  assert.match(html, /<b>50%<\/b><span>Occupancy/);
  assert.match(html, /<b>3<\/b><span>Open cases/);
});

test("every tile goes somewhere real", { skip }, async () => {
  const c = open(almas());
  await c.settle();
  const html = c.html();
  for (const go of ["portfolio", "units", "rentals", "maintenance",
                    "fin_collect", "fin_history", "fin_expenses"]) {
    assert.match(html, new RegExp(`data-go="${go}"`), `nothing navigates to ${go}`);
  }
  assert.doesNotMatch(html, /href="#"/, "no placeholder links");
});

test("money is shown per currency, from the invoices' own", { skip }, async () => {
  const c = open(almas());
  await c.settle();
  const html = c.html();
  assert.match(html, /KES 270,000/, "outstanding");
  assert.match(html, /KES 135,000/, "overdue");
  assert.match(html, /KES 90,000/, "collected this month");
  assert.match(html, /KES 25,000/, "spent this month");
});

/*
 * Omitted, not zeroed. A finance section full of noughts tells somebody they
 * have no money, which is a different statement from "this is not yours".
 */
test("a role without finance sees no money, and is told why", { skip }, async () => {
  const c = open(almas({ finance: null }));
  await c.settle();
  const html = c.html();
  assert.match(html, /Money is not shown on this account/);
  assert.doesNotMatch(html, /KES 0/);
  assert.doesNotMatch(html, /Outstanding<\/span>/, "no outstanding tile at all");
  assert.match(html, /<b>2<\/b><span>Units/, "but the rest of the business is still there");
});

test("what needs attention names the record and where to go", { skip }, async () => {
  const c = open(almas());
  await c.settle();
  const html = c.html();
  assert.match(html, /Needs your attention/);
  assert.match(html, /45 days late/);
  assert.match(html, /p-r">high/, "priority is shown");
  assert.match(html, /data-go="fin_collect"/, "and it goes to the screen that answers it");
});

test("tenancies ending soon are listed, in the lease's currency", { skip }, async () => {
  const c = open(almas());
  await c.settle();
  const html = c.html();
  assert.match(html, /Tenancies ending soon/);
  assert.match(html, /Grace Wanjiru/);
  assert.match(html, /2026-10-15/);
  assert.match(html, /KES 135,000/);
});

test("activity is the audit trail, and says so", { skip }, async () => {
  const c = open(almas());
  await c.settle();
  const html = c.html();
  assert.match(html, /Recent activity/);
  assert.match(html, /payment receive/);
  assert.match(html, /A Person/);
  assert.match(html, /This is your audit trail/);
  assert.match(html, /data-go="ad_trail"/);
});

/* A genuinely empty company must be told what to do, not shown a wall. */
test("a brand new company is told where to start", { skip }, async () => {
  const c = open(almas({
    portfolio: { sites: 0, buildings: 0, units: 0, occupied: 0, vacant: 0,
                 reserved: 0, offMarket: 0, notice: 0, occupancyPct: null },
    leases: { live: 0, expiringSoon: [] },
    operations: { openCases: 0, urgentCases: 0 },
    attention: [], activity: [],
    finance: { books: [], mixed: false, openInvoices: 0,
               collectedThisMonth: [], expensesThisMonth: [] },
  }));
  await c.settle();
  const html = c.html();
  assert.match(html, /No properties, units or tenancies yet/);
  /* goAdd: the command centre draws no newPanel(), so newOpen() would set
     NEW and render a screen with nowhere to put the form. */
  assert.match(html, /data-act="goAdd" data-arg="portfolio"/, "with a real action");
  assert.match(html, /data-arg="units"/);
  assert.match(html, /data-arg="rentals"/);
  assert.doesNotMatch(html, /Needs your attention/, "no empty scaffolding");
});

test("a failure says so rather than reading as an empty business", { skip }, async () => {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8") +
    "\n;window.__S=SCREENS;", "console.js");
  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({ email: "a@b.c", name: "A", company: "C",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER", preferred: "PROPERTY_MANAGEMENT" });
  P.Data = { configured: () => true, create: () => Promise.resolve({}),
    update: () => Promise.resolve({}),
    request: () => Promise.reject(new Error("the ledger is not open to this account")) };

  const S = w.win["__S"] as Record<string, () => string>;
  S["command"]!();
  await new Promise((r) => setTimeout(r, 5));
  const html = S["command"]!();
  assert.match(html, /not open to this account/);
  assert.doesNotMatch(html, /No properties, units or tenancies yet/,
    "a failure is not the same claim as an empty company");
});

/* §16: creating something must be reflected without a manual page reload. */
test("creating a record makes the centre re-read", { skip }, () => {
  const src = readFileSync(join(FE, "assets", "console.js"), "utf8");
  const save = src.slice(src.indexOf("ACTIONS.newSave"), src.indexOf("SCREENS.documents"));
  assert.match(save, /ccRefresh\(\)/,
    "the command centre is not told when something is created");
  const pay = src.slice(src.indexOf("ACTIONS.paySave"), src.indexOf("function payPanel"));
  assert.match(pay, /ccRefresh\(\)/,
    "the command centre is not told when a payment is recorded");
});
