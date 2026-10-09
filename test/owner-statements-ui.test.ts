/* ====================================================================== *
 * THE OWNER STATEMENTS SCREEN, ACTUALLY RENDERED.
 *
 * frontend-contract.test.ts proves the console LOADS and that the two
 * repositories still name the same endpoints. It does not render anything, so
 * it cannot tell you that a screen draws the figures the API sent — and for
 * this screen that is the only question worth asking. It is a document about
 * somebody else's money, and a wrong number on it is not a cosmetic fault.
 *
 * So this drives the whole path, in the real order:
 *
 *     the route's own JSON  ->  the hydrator's adapters  ->  the live array
 *     ->  connect()'s wrapper  ->  SCREENS.fin_owner  ->  the markup
 *
 * The fixtures below are the shapes src/routes/products.ts answers with,
 * money as minor-unit strings exactly as it leaves the wire. Nothing here
 * reimplements the arithmetic: the point is that the screen SHOWS what the
 * server computed, including the two refusals it must not paint over —
 * a month that cannot be issued, and a month already issued.
 *
 * WHERE IS THE FRONTEND? PALTAS_FRONTEND, or beside this repo as
 * `../paltas-frontend 2`. Without it these skip, like the other cross-repo
 * tests — a backend checkout on its own is not a broken backend.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";
import type { Foreign } from "./wire.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");

const skip = existsSync(join(FE, "assets", "console.js"))
  ? false
  : `no frontend at ${FE} — set PALTAS_FRONTEND to run these`;

/* Exactly what the routes answer, money as minor-unit strings like the wire. */
const AGREEMENT_ROWS = [
  { id: "ag1", ref: "MGT-0001", basis: "COLLECTED", feeBps: 1000, feeFixed: "0",
    currency: "KES", status: "ACTIVE", startsOn: "2026-01-01T00:00:00.000Z",
    endsOn: null, note: "", unitId: null,
    owner: { id: "p1", name: "Amina Yusuf" },
    site: { id: "s1", name: "Riverside Court", city: "Nairobi", currency: "KES" },
    unit: null },
  { id: "ag2", ref: "MGT-0002", basis: "FIXED", feeBps: 0, feeFixed: "2500000",
    currency: "KES", status: "DRAFT", startsOn: null, endsOn: null, note: "",
    unitId: "u9",
    owner: { id: "p2", name: "Juma Otieno" },
    site: { id: "s2", name: "Marina Vista", city: "Mombasa", currency: "KES" },
    unit: { id: "u9", ref: "C-402", siteId: "s2" } },
];

const STATEMENT_ROWS = [
  { id: "st1", ref: "OS-0001", agreementId: "ag1", currency: "KES",
    periodFrom: "2026-09-01T00:00:00.000Z", periodTo: "2026-10-01T00:00:00.000Z",
    collected: "13500000", billed: "13500000", costs: "1800000", fee: "1350000",
    net: "10350000", opening: "0", paidOut: "0", closing: "10350000",
    costsLeftOff: 1, costsLeftOffTotal: "400000",
    issuedOn: "2026-10-02T09:00:00.000Z", issuedByName: "Ahmed Akboole",
    voided: false, voidReason: "", note: "",
    agreement: { id: "ag1", ref: "MGT-0001" },
    owner: { id: "p1", name: "Amina Yusuf" },
    lines: [
      { id: "l1", at: "2026-09-03T00:00:00.000Z", kind: "RENT",
        detail: "Rent received — A-101", amount: "13500000", ref: "INV-0001" },
    ] },
];

const PREVIEW = {
  totals: { collected: "13500000", billed: "13500000", costs: "1800000", fee: "1350000",
            net: "10350000", opening: "0", paidOut: "0", closing: "10350000",
            costsLeftOff: 1, costsLeftOffTotal: "400000" },
  lines: [
    { at: "2026-09-03T00:00:00.000Z", kind: "RENT", detail: "Rent received — A-101",
      amount: "13500000", sourceType: "payment", sourceId: "pay1", ref: "INV-0001" },
    { at: "2026-09-10T00:00:00.000Z", kind: "COST", detail: "Lift service contract",
      amount: "-1800000", sourceType: "expense", sourceId: "e1", ref: "maintenance" },
    { at: "2026-10-01T00:00:00.000Z", kind: "FEE",
      detail: "Management fee — 10.00% of rent collected",
      amount: "-1350000", sourceType: "agreement", sourceId: "ag1", ref: "MGT-0001" },
  ],
  agreement: { id: "ag1", ref: "MGT-0001", currency: "KES" },
  period: { key: "2026-09", name: "September 2026",
            from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
  broughtForwardFrom: null, why: null, issued: null,
};

/* What GET /console/forms serves for this screen, scope and all. */
const FORM_SPEC = {
  resource: "management-agreements",
  label: "＋ New management agreement",
  product: "PROPERTY_MANAGEMENT",
  area: "finance",
  fields: [
    { name: "ownerId", label: "Contact", kind: "id:party", required: true, lookup: "party" },
    { name: "siteId", label: "Property", kind: "id:site", required: true, lookup: "site" },
    { name: "currency", label: "Currency", kind: "string", required: true },
    { name: "unitId", label: "Unit", kind: "id:unit", required: false,
      lookup: "unit", scope: "siteId" },
    { name: "basis", label: "Basis", kind: "enum:FeeBasis", required: false,
      options: ["COLLECTED", "BILLED", "FIXED"] },
    { name: "feeBps", label: "Fee bps", kind: "int", required: false },
  ],
};

const OWED = { currencies: [{ currency: "KES", owed: "10350000", agreements: 2, neverStated: 1 }],
               owners: [] };

async function boot(over: Record<string, unknown> = {}) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  (w.win["PALTAS_BOOT"] as Foreign) = { system: "property" };
  for (const f of ["assets/market-config.js", "assets/paltas-data.js", "assets/paltas-hydrate.js"]) {
    w.loadCode(readFileSync(join(FE, f), "utf8"), f);
  }
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8") +
    "\n;window.__S = SCREENS; window.__NAV = navFor; window.__OWN = () => OWN;" +
    "\n;window.__ACT = ACTIONS; window.__NEW = () => NEW;", "console.js");

  const P = w.win["PALTAS"] as Foreign;
  P.Session.create({ email: "a@b.co", name: "A", company: "A Company",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER", country: "KE" });

  const LISTS: Record<string, unknown[]> = {
    "management-agreements": AGREEMENT_ROWS,
    "owner-statements": STATEMENT_ROWS,
    sites: [
      { id: "s1", name: "Riverside Court", kind: "RESIDENTIAL", city: "Nairobi" },
      { id: "s2", name: "Marina Vista", kind: "RESIDENTIAL", city: "Mombasa" },
    ],
    units: [
      { id: "u1", ref: "A-101", siteId: "s1", kind: "APARTMENT", status: "OCCUPIED" },
      { id: "u2", ref: "A-102", siteId: "s1", kind: "APARTMENT", status: "VACANT" },
      { id: "u9", ref: "C-402", siteId: "s2", kind: "APARTMENT", status: "VACANT" },
    ],
    parties: [], listings: [],
    ...(over["lists"] as Record<string, unknown[]> || {}),
  };
  P.Data.configured = () => true;
  P.Data.list = (slug: string) =>
    Promise.resolve({ status: "ready", rows: LISTS[slug] || [] });
  P.Data.request = (path: string) => {
    if (path.indexOf("/owners-owed") === 0) return Promise.resolve(over["owed"] ?? OWED);
    if (path.indexOf("/management-agreements/") === 0 && path.indexOf("/statement") > 0) {
      return Promise.resolve(over["preview"] ?? PREVIEW);
    }
    if (path.indexOf("/console/forms") === 0) {
      return Promise.resolve({ forms: over["forms"] ?? { fin_owner: FORM_SPEC } });
    }
    return Promise.resolve({});
  };

  const H = P.Hydrate;
  const wants = ["AGREEMENTS", "OWNER_STMTS", "PROPS", "UNITS",
                 "BUYERS", "VENDORS", "AG_CLIENTS"];
  await new Promise<void>((done) => { if (!H.loadAll(wants, done)) done(); });
  return w.win;
}

async function paint(w: Foreign) {
  const S = w["__S"] as Record<string, Foreign>;
  /* Two paints: the first fires the screen's own background fetches. */
  S["fin_owner"]();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return String(S["fin_owner"]());
}

test("fin_owner is a screen and sits in the property navigation", { skip }, async () => {
  const w = await boot();
  assert.equal(typeof (w["__S"] as Record<string, Foreign>)["fin_owner"], "function");
  const groups = (w["__NAV"] as Foreign)("property") as { title: string; items: [string, string, string][] }[];
  const g = groups.find((x) => x.items.some((i) => i[0] === "fin_owner"));
  assert.ok(g, "fin_owner is in no navigation group");
  const item = g.items.find((i) => i[0] === "fin_owner") as [string, string, string];
  assert.equal(item[2], "Owner statements");
  assert.equal(g.title, "Finance");
});

test("the API's own shapes render, through the adapters, with nothing broken", { skip }, async () => {
  const w = await boot();
  const OWN = (w["__OWN"] as Foreign)() as Record<string, unknown>;
  const html0 = await paint(w);
  assert.match(html0, /Owner statements/, "the screen did not reach its own markup");

  /* Pick the agreement, the way the button does. */
  OWN["agreementId"] = "ag1"; OWN["period"] = "2026-09";
  OWN["preview"] = PREVIEW;
  const html = String((w["__S"] as Record<string, Foreign>)["fin_owner"]());

  for (const want of [
    "MGT-0001", "MGT-0002", "Amina Yusuf", "Juma Otieno",
    "Riverside Court", "Marina Vista",
    "10.00% of rent collected", "25000 a month",
    "the whole property", "unit C-402 only",
    "September 2026", "Rent collected", "KES 135,000",
    "Our management fee", "KES 13,500",
    "Net for the month", "KES 103,500", "Still owed to you",
    "Lift service contract", "Owed to owners", "Never stated",
    "was not charged to the owner", "Issue September 2026",
    'data-pre="own-issue::ag1"', 'data-pre="own-void::st1"',
    "OS-0001", "Ahmed Akboole",
  ]) {
    assert.ok(html.includes(want), `the rendered screen is missing: ${want}`);
  }
  for (const bad of ["undefined", "NaN", "[object Object]", "${", "null"]) {
    assert.ok(!html.includes(bad), `the rendered screen contains "${bad}"`);
  }
});

test("a month the server would refuse offers no Issue button", { skip }, async () => {
  const w = await boot({
    preview: { ...PREVIEW, why:
      "MGT-0001 is still a draft. An owner who has never consented to these "
      + "terms cannot be billed under them." },
  });
  const OWN = (w["__OWN"] as Foreign)() as Record<string, unknown>;
  await paint(w);
  OWN["agreementId"] = "ag1"; OWN["period"] = "2026-09";
  OWN["preview"] = { ...PREVIEW, why: "MGT-0001 is still a draft. An owner who has never consented to these terms cannot be billed under them." };
  const html = String((w["__S"] as Record<string, Foreign>)["fin_owner"]());
  assert.match(html, /still a draft/, "the server's own refusal is not shown");
  assert.ok(!html.includes("own-issue"), "Issue is offered for a month that would be refused");
});

test("an already-issued month says so instead of offering to issue again", { skip }, async () => {
  const w = await boot();
  const OWN = (w["__OWN"] as Foreign)() as Record<string, unknown>;
  await paint(w);
  OWN["agreementId"] = "ag1"; OWN["period"] = "2026-09";
  OWN["preview"] = { ...PREVIEW,
    issued: { id: "st1", ref: "OS-0001", voided: false, issuedOn: "2026-10-02T09:00:00.000Z" } };
  const html = String((w["__S"] as Record<string, Foreign>)["fin_owner"]());
  assert.match(html, /OS-0001 already covers this month/);
  assert.ok(!html.includes("own-issue"), "a second statement for the month is offered");
});

test("with no agreements it says what an agreement is for, and offers to add one", { skip }, async () => {
  const w = await boot({ lists: { "management-agreements": [], "owner-statements": [] } });
  const html = await paint(w);
  assert.match(html, /No management agreements yet/);
  assert.match(html, /would read as its own\s+revenue/);
  assert.match(html, /data-act="newOpen::fin_owner"/, "no way to create an agreement");
});

test("the unit picker waits for a property, then offers only that property's units",
  { skip }, async () => {
  /*
   * THE FIELD THAT COULD NOT BE ASKED BEFORE.
   *
   * Naming a unit narrows the agreement to one flat of a block. Unscoped, the
   * picker offered every unit the company owns labelled by bare reference —
   * "A-101", "A-102", "C-402" — so across two properties most answers were
   * wrong, and each wrong one is a round trip ending in "C-402 is not in
   * Riverside Court". The list has to be the units of the property chosen.
   */
  const w = await boot();
  const S = w["__S"] as Record<string, Foreign>;
  const ACT = w["__ACT"] as Record<string, Foreign>;

  await ACT["newOpen"]("fin_owner");
  const NEW = (w["__NEW"] as Foreign)() as Record<string, Record<string, string>>;
  assert.ok(NEW, "the form did not open");

  /*
   * READ THE PICKER, NOT THE PAGE. "C-402" also appears in the agreements
   * table below, as the unit one of the fixtures is narrowed to — so asserting
   * against the whole screen passes and fails for the wrong reasons.
   */
  const picker = () => {
    const html = String(S["fin_owner"]());
    const at = html.indexOf('<select data-nf="unitId"');
    assert.ok(at > 0, "there is no unit picker on the form");
    return html.slice(at, html.indexOf("</select>", at));
  };

  /* Nothing chosen yet: the picker says what to answer first rather than
     offering a list in which most answers would be refused. */
  const before = picker();
  assert.match(before, /Choose the property first/,
    "the unit picker does not wait for the property it is narrowed by");
  assert.match(before, /disabled/, "it is offerable before a property is chosen");
  assert.ok(!before.includes("A-101"),
    "units are offered before a property has been chosen");

  /* A property chosen — only its own units, and the other building's gone. */
  NEW["values"]["siteId"] = "s1";
  const after = picker();
  assert.ok(after.includes("A-101"), "the chosen property's units are not offered");
  assert.ok(after.includes("A-102"), "only one of the property's units is offered");
  assert.ok(!after.includes("C-402"),
    "a unit from ANOTHER property is offered — the scope is being ignored");
  assert.ok(!after.includes("disabled"),
    "the picker is still disabled after the property was chosen");

  /* The other property gives the other answer, which is the whole point. */
  NEW["values"]["siteId"] = "s2";
  const other = picker();
  assert.ok(other.includes("C-402"), "the second property's unit is not offered");
  assert.ok(!other.includes("A-101"), "the first property's units survived the change");
});

test("an empty picker offers no value at all, rather than its own sentence",
  { skip }, async () => {
  /*
   * An <option> with no value attribute has a value of its own TEXT, and these
   * selects are read with `el.value` rather than submitted as a form — so an
   * empty picker used to hand the API `siteId: "No property yet"`. That passed
   * the console's own "required field was answered" check and came back as
   * "that property does not exist", telling somebody their choice was wrong
   * when they had never been offered one.
   */
  const w = await boot({ lists: { sites: [], units: [], "management-agreements": [],
                                  "owner-statements": [] } });
  const S = w["__S"] as Record<string, Foreign>;
  const ACT = w["__ACT"] as Record<string, Foreign>;
  await ACT["newOpen"]("fin_owner");

  const html = String(S["fin_owner"]());
  assert.match(html, /No property yet/, "an empty picker does not say so");
  assert.ok(!/<option>No /.test(html),
    "a placeholder option carries no value attribute, so its own text is what " +
    "would be posted");
  assert.match(html, /<option value="">No property yet<\/option>/,
    "the placeholder does not post an empty answer");
});
