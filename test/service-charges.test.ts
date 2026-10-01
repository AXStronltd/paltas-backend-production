/* ======================================================================
 * THE OTHER THING A TENANT PAYS.
 *
 * Security, cleaning, water, lifts, the generator, insurance — the costs of
 * the BUILDING rather than of the unit. A property company's second revenue
 * line after rent, and until now PALTAS could not bill it at all.
 *
 * ── TWO LINES, ONE INVOICE ─────────────────────────────────────────────
 *
 * A tenant pays both on the same day for the same month. Billing them
 * separately sends two invoices, two due dates and two reminders for one
 * tenancy, and they arrive at Collections as two debts from one person.
 *
 * But two LINES, not one summed figure: a tenant asking "what is the service
 * charge" is asking something the invoice has to answer, and a landlord's
 * rent roll must not quietly include the lift.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESOURCES } from "../src/domain/registry.ts";
import { CONSOLE_FORMS } from "../src/domain/console-map.ts";

test("a lease can carry one, and it is money the landlord sets", () => {
  const leases = (RESOURCES as unknown as Record<string, { fields: Record<string, string> }>)["leases"];
  assert.ok(leases, "the leases resource is gone");
  assert.equal(leases.fields["serviceCharge"], "money",
    "a service charge that cannot be set is a service charge nobody can bill");
});

test("it is its own field, never folded into rent", () => {
  /*
   * The distinction the whole feature turns on. A company that raised the
   * rent to cover the lift can answer neither "what is our rent roll" nor
   * "what did the building cost the tenants" — and in most markets the two
   * are governed differently: rent is negotiated, a service charge is meant
   * to be a share of real cost.
   */
  const leases = (RESOURCES as unknown as Record<string, { fields: Record<string, string> }>)["leases"];
  assert.ok(leases.fields["rent"], "rent is gone");
  assert.notEqual(leases.fields["rent"], undefined);
  assert.ok("serviceCharge" in leases.fields);
});

test("the lease form offers it", () => {
  const form = (CONSOLE_FORMS as Record<string, { fields: Record<string, string> }>)["rentals"];
  assert.ok(form, "there is no lease form");
  const has = Object.values(form.fields).includes("serviceCharge");
  assert.ok(has, "a landlord cannot enter it, so no tenancy will ever have one");
});

test("neither field is required — a tenancy with no service charge is ordinary", () => {
  /*
   * Most residential lets have none. Requiring it would refuse every lease a
   * company has today, and every import.
   */
  const leases = (RESOURCES as unknown as Record<string, { required?: readonly string[] }>)["leases"];
  assert.ok(!(leases.required || []).includes("serviceCharge"));
});

test("the run bills it as a second line, on the same invoice", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/domain/rent.ts", import.meta.url), "utf8"));

  assert.match(src, /Service charge — \$\{monthName\(periodKey\)\}/,
    "the second line is not built");
  assert.match(src, /if \(service > 0n\)/,
    "a lease with no service charge would get an empty line");
  assert.match(src, /const total = lease\.rent \+ service;/,
    "the invoice total does not include it, so the tenant is under-billed");
});

test("what was charged is recorded beside what the rent was", async () => {
  /*
   * RentCharge.amount stays the RENT alone. Every row written before today
   * means exactly what it meant then — a re-read of last year's billing has
   * to give last year's answer — so the service charge is a new column, not a
   * change of meaning in an old one.
   */
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/domain/rent.ts", import.meta.url), "utf8"));
  assert.match(src, /amount: lease\.rent, serviceCharge: service,/,
    "the charge record does not say what the service charge was");

  const schema = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8"));
  const rc = schema.match(/^model RentCharge \{([\s\S]*?)^\}/m);
  assert.ok(rc && /serviceCharge\s+BigInt\s+@default\(0\)/.test(rc[1]!),
    "RentCharge cannot record it");
});

test("existing leases start at zero, so nothing begins charging by itself", async () => {
  /*
   * The migration's whole caution. A column appearing must not bill anybody:
   * every lease in production bills exactly what it billed yesterday until
   * somebody sets a figure.
   */
  const schema = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8"));
  const lease = schema.match(/^model Lease \{([\s\S]*?)^\}/m);
  assert.ok(lease && /serviceCharge\s+BigInt\s+@default\(0\)/.test(lease[1]!),
    "it has no zero default, so the column's arrival changes what tenants owe");
});

test("it is not confused with an operational service", () => {
  /*
   * The standard warns about exactly this: "Service = operational/service
   * catalog item. Service Charge = financial property charge. Do not confuse
   * the two." A maintenance callout must not land on a rent invoice.
   */
  const hotel = (RESOURCES as unknown as Record<string, { model: string }>)["services"];
  if (hotel) {
    assert.notEqual(hotel.model, "lease",
      "the operational service catalogue and the tenancy charge are the same thing");
  }
  const leases = (RESOURCES as unknown as Record<string, { area: string }>)["leases"];
  assert.equal(leases.area, "property", "a service charge belongs to the tenancy, not to a catalogue");
});

/* ======================================================================
 * AND WHAT THE LANDLORD SEES.
 *
 * The rule the screen has to hold is the same one the invoice holds: the two
 * figures are shown together and never added together. A rent roll that
 * quietly includes the lift tells a landlord their rents are higher than they
 * are, and a valuer the wrong yield off the same number.
 * ====================================================================== */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const noFe = existsSync(join(FE, "assets", "console.js"))
  ? false
  : `no frontend at ${FE} — set PALTAS_FRONTEND to run these`;

/** A signed-in console, with the leases it is told to have. */
function rentals(leases: Record<string, unknown>[]) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode("window.PALTAS = { Market: { lookup: function () { return null; },"
    + " countries: function () { return []; } } };", "market-stub.js");
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8")
    + "\n;window.__t=TENANTS;window.__s=SCREENS;window.__money=money;"
    + "window.__full=moneyInFull;", "console.js");

  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({
    email: "a@b.c", name: "A Person", company: "A Co",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER",
    preferred: "PROPERTY_MANAGEMENT", country: "ke",
  });

  /* The seed tenancies would drown the two this test is about. Emptied in
     place, because the screen closed over the array. */
  const t = w.win["__t"] as Record<string, unknown>[];
  t.length = 0;
  for (const l of leases) t.push(l);

  const html = ((w.win["__s"] as Record<string, () => string>)["rentals"])();
  return {
    html,
    money: w.win["__money"] as (n: number) => string,
    full: w.win["__full"] as (n: number, cur?: string) => string,
  };
}

const LEASE = {
  m: "all", n: "A Tenant", u: "A-1", since: "Oct 2026", ends: null,
  score: 0, band: "—", rec: "—", cur: "KES", rentDay: 1, billing: "MONTHLY",
  starts: null, id: "l1",
};

test("the leases table has a column for it", { skip: noFe }, () => {
  const { html } = rentals([{ ...LEASE, rent: 100_000, svc: 15_000 }]);
  assert.match(html, /<th>Service charge<\/th>/,
    "a landlord cannot see what any tenancy is being charged");
});

test("the figure is shown, in the lease's own currency", { skip: noFe }, () => {
  const { html, full } = rentals([{ ...LEASE, rent: 100_000, svc: 15_000, cur: "AED" }]);
  assert.ok(html.includes(full(15_000, "AED")),
    "the service charge is not on the row");
});

test("THE RENT ROLL IS THE RENT — the service charge is not added into it",
  { skip: noFe }, () => {
    /*
     * The whole reason the field exists separately. If this ever fails,
     * somebody has summed the two, and every rent figure in the company is
     * overstated by the cost of the building.
     */
    const { html, money } = rentals([
      { ...LEASE, id: "a", rent: 100_000, svc: 40_000 },
      { ...LEASE, id: "b", n: "Another", rent: 200_000, svc: 60_000 },
    ]);
    assert.ok(html.includes(`${money(300_000)}</div>`) || html.includes(money(300_000)),
      `the rent roll does not read ${money(300_000)}`);
    assert.ok(!html.includes(money(400_000)),
      `the rent roll reads ${money(400_000)} — the service charges have been added into the rent`);
    /* And the total IS reported, just not as rent. */
    assert.ok(html.includes(`Plus ${money(100_000)} in service charges`),
      "the service charge total is nowhere on the screen");
  });

test("a tenancy with none shows nothing, not a charge of zero", { skip: noFe }, () => {
  /*
   * Most residential lets have no service charge at all. "KES 0.00" in the
   * column claims one was agreed and set to nothing, which invites the
   * question of who agreed it.
   */
  const { html, full } = rentals([{ ...LEASE, rent: 100_000, svc: 0 }]);
  /* The CELL, not the page: "Collected this month" is legitimately zero on a
     company that has taken no money, and that zero is a fact. */
  assert.ok(!html.includes(`<td class="num">${full(0, "KES")}</td>`),
    "it prints a zero charge against the tenancy");
  assert.match(html, /<td class="num">—<\/td>/, "the cell is not left blank");
  assert.ok(!/in service charges/.test(html),
    "it offers a service charge total when there are none");
});

test("the hydrator carries it off the lease", { skip: noFe }, () => {
  /*
   * The screen can only show what the adapter put on the row. This is the
   * join that broke every other time a field was added: schema, API and
   * screen all correct, and the row arriving without the value.
   */
  const src = readFileSync(join(FE, "assets", "paltas-hydrate.js"), "utf8");
  const lease = src.match(/TENANTS: \{ slug: "leases", row: function[\s\S]*?\n    \}\}/);
  assert.ok(lease, "the leases adapter is gone");
  assert.match(lease[0], /svc: major\(r\.serviceCharge\)/,
    "the lease row arrives without its service charge, so the column is always blank");
});
