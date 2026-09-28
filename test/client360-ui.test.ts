/* ======================================================================
 * CLIENT 360, ON A SCREEN.
 *
 * One person, everything — assembled by the server from the systems that own
 * each part. The screen's whole job is to show it without working anything out
 * again: a client screen is the one somebody reads down the telephone to a
 * customer, so a figure on it disagreeing with Collections would be believed.
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

function grace(over: Record<string, unknown> = {}) {
  return {
    party: { id: "p1", name: "Grace Wanjiru", kind: "CONTACT",
             email: "grace@example.com", phone: "+254700000000",
             city: "Nairobi", country: "ke", source: "Walk-in", status: "ACTIVE",
             tags: "vip", note: "Prefers WhatsApp.", since: null,
             createdAt: "2026-01-01T00:00:00.000Z",
             nextFollowUpOn: "2026-09-20T00:00:00.000Z",
             assignedTo: { id: "u1", name: "A Person", email: "a@b.c" } },
    relationship: { tenant: true, buyer: false, lead: true, activeLeases: 1 },
    leases: [{ id: "l1", ref: "L-0001", unitRef: "A-101", status: "ACTIVE",
               rent: "13500000", currency: "KES", startsOn: null,
               endsOn: "2026-12-31T00:00:00.000Z" }],
    contracts: [], offers: [], deals: [], viewings: [], reservations: [],
    leads: [{ id: "ld1", name: "Grace Wanjiru", stage: "QUALIFIED",
              source: "Walk-in", budget: "0", currency: "KES",
              nextFollowUpOn: null }],
    documents: [{ id: "d1", name: "National ID", kind: "IDENTITY",
                  expiresAt: "2030-01-01T00:00:00.000Z", mimeType: "application/pdf",
                  bytes: 1024, createdAt: "2026-01-02T00:00:00.000Z" }],
    finance: { billed: [{ currency: "KES", invoiced: "27000000",
                          received: "13500000", invoices: 2 }],
               arrears: [{ currency: "KES", outstanding: "13500000",
                           overdue: "13500000" }],
               openInvoices: 1, recentPayments: [] },
    activity: [{ id: "a1", at: "2026-09-27T09:12:00.000Z", actorName: "A Person",
                 action: "payment.receive", entity: "payment", entityId: "pm1" }],
    ...over,
  };
}

function open(payload: unknown, { signedIn = true } = {}) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8") +
    "\n;window.__S=SCREENS;window.__A=ACTIONS;window.__C=function(){return CLIENT;};",
    "console.js");
  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({ email: "a@b.c", name: "A Person", company: "Almas It",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER", preferred: "PROPERTY_MANAGEMENT" });
  const asked: string[] = [];
  if (signedIn) {
    P.Data = { configured: () => true, create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      request: (path: string) => {
        asked.push(path);
        return payload === null
          ? Promise.reject(new Error("that client could not be found"))
          : Promise.resolve(payload);
      } };
  }
  return {
    asked, win: w.win as Record<string, any>,
    html: () => (w.win["__S"] as Record<string, () => string>)["pm_client"]!(),
    act: (k: string, a?: unknown) =>
      (w.win["__A"] as Record<string, (x?: unknown) => unknown>)[k]!(a),
    settle: async () => { await new Promise((r) => setTimeout(r, 5)); },
  };
}

test("opening a client asks for that client", { skip }, async () => {
  const c = open(grace());
  c.act("clientOpen", "p1");
  await c.settle();
  assert.deepEqual(c.asked, ["/clients/p1/360"]);
});

test("with nobody chosen it says so and offers the list", { skip }, () => {
  const c = open(grace());
  const html = c.html();
  assert.match(html, /No client chosen/);
  assert.match(html, /data-act="setupGo" data-arg="pm_buyers"/);
});

test("the relationship is shown as counted, not as typed", { skip }, async () => {
  const c = open(grace());
  c.act("clientOpen", "p1");
  await c.settle();
  const html = c.html();
  assert.match(html, /Grace Wanjiru/);
  assert.match(html, /p-g">Tenant/, "they hold a live lease, so they are a tenant");
  assert.match(html, /p-n">contact/, "even though the column says contact");
  assert.match(html, /Came from a lead/);
});

test("identity, ownership and the next follow-up are all there", { skip }, async () => {
  const c = open(grace());
  c.act("clientOpen", "p1");
  await c.settle();
  const html = c.html();
  assert.match(html, /grace@example\.com/);
  assert.match(html, /\+254700000000/);
  assert.match(html, /Nairobi/);
  assert.match(html, /Walk-in/);
  assert.match(html, /Looked after by/);
  assert.match(html, /2026-09-20/, "the follow-up date");
});

test("money is finance's figure, and says so", { skip }, async () => {
  const c = open(grace());
  c.act("clientOpen", "p1");
  await c.settle();
  const html = c.html();
  assert.match(html, /KES 270,000/, "invoiced");
  assert.match(html, /KES 135,000/, "received and still owing");
  assert.match(html, /Finance is the authority here/);
  assert.match(html, /data-go="fin_collect"/);
});

test("a role without finance sees the relationship but not the money", { skip }, async () => {
  const c = open(grace({ finance: null }));
  c.act("clientOpen", "p1");
  await c.settle();
  const html = c.html();
  assert.match(html, /Money is not shown on this account/);
  assert.doesNotMatch(html, /KES 270,000/);
  assert.match(html, /Grace Wanjiru/, "the relationship is still there");
});

test("their records are listed, each with somewhere to go", { skip }, async () => {
  const c = open(grace());
  c.act("clientOpen", "p1");
  await c.settle();
  const html = c.html();
  assert.match(html, /L-0001/, "their tenancy");
  assert.match(html, /A-101/);
  assert.match(html, /National ID/, "their document");
  assert.match(html, /payment receive/, "their history");
  for (const go of ["rentals", "documents", "ad_trail", "ag_leads"]) {
    assert.match(html, new RegExp(`data-go="${go}"`), `nothing goes to ${go}`);
  }
});

/* An empty section must explain itself rather than look broken. */
test("sections with nothing in them say what would put something there", { skip }, async () => {
  const c = open(grace({ leases: [], documents: [], contracts: [], leads: [] }));
  c.act("clientOpen", "p1");
  await c.settle();
  const html = c.html();
  assert.match(html, /A lease against a unit is what makes somebody a tenant/);
  assert.match(html, /No documents are filed against this client/);
  assert.match(html, /No enquiry is recorded against this client/);
});

test("a refusal is shown in the server's words", { skip }, async () => {
  const c = open(null);
  c.act("clientOpen", "p1");
  await c.settle();
  assert.match(c.html(), /could not be found/);
});

/* The list is the way in, and it has to carry the id to open. */
test("the clients list opens a client", { skip }, () => {
  const src = readFileSync(join(FE, "assets", "console.js"), "utf8");
  const list = src.slice(src.indexOf("SCREENS.pm_buyers"), src.indexOf("SCREENS.pm_buyers") + 3000);
  assert.match(list, /data-act="clientOpen" data-arg="\$\{esc\(x\.id\)\}"/,
    "the clients list has no way to open a client");
});
