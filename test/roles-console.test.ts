/* ====================================================================== *
 * EVERY ROLE, IN EVERY PRODUCT, THROUGH THE DOOR IT ACTUALLY MEETS.
 *
 * A company does not sign up one person. It signs up an owner, who then
 * invites a manager, a finance lead, a caretaker, a front desk and a guard —
 * and each of them must land somewhere that works. The failure this file
 * exists to catch is the quiet one: a role that signs in successfully and
 * arrives at an empty console, or at a screen that throws.
 *
 * ── THE THREE RULES, IN ORDER ──────────────────────────────────────────
 *
 *   `only`   pins a role to ONE product. A security administrator has no
 *            business inside a hotel's console even as an employee of the
 *            hotel, and openable() is where that is enforced.
 *   `sees`   null means the whole product; otherwise an allow-list per
 *            product. What is not named is not reachable.
 *   navFor() turns those into the menu this person gets.
 *
 * Testing navFor() alone walks straight past the first rule. An earlier
 * version of this did exactly that and reported a security administrator
 * holding 27 screens inside a property company he cannot enter at all.
 * So the door is asked first, and the menu only after it opens.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";
import { CONSOLE_FORMS } from "../src/domain/console-map.ts";
import type { Wire, Foreign } from "./wire.ts";
import { said } from "./threw.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const skip = existsSync(join(FE, "assets", "console.js"))
  ? false
  : `no frontend at ${FE} — set PALTAS_FRONTEND to run these`;

const PRODUCTS = {
  PROPERTY_MANAGEMENT: "property",
  AGENT_HOST: "agent",
  HOTEL_MANAGEMENT: "hotel",
  SECURITY_MANAGEMENT: "security",
};

/* PALTAS's own staff and the guest portal are not company roles. */
const NOT_COMPANY_ROLES = new Set(["MARKETING", "COMPLIANCE", "PUBLISHER", "GUEST"]);

/**
 * The products this session may open, as a HOST array.
 *
 * openable() builds its array inside the vm realm, so it carries that realm's
 * Array.prototype. assert/strict compares prototypes, which makes an empty
 * array from in there unequal to an empty array out here — the assertion fails
 * while printing "actual: [], expected: []". Copying across is what makes the
 * comparison mean what it looks like.
 */
function opensFor(G: Wire) {
  return [...(G.openable() || [])].map((p) => p.key || p);
}

/** One console, signed in as one role of one product. */
function open(product: string, role: string) {
  const page = (PRODUCTS as Record<string, string>)[product];
  const w = makeWindow({ href: `https://paltas.io/dashboard/${page}.html` });
  w.win["PALTAS_BOOT"] = { system: page };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8") +
    "\n;window.__navFor=navFor;window.__first=firstScreenOf;window.__S=SCREENS;",
    "console.js");

  const G = (w.win["PALTAS"] as Foreign).Session;
  G.create({
    email: "person@example.com", name: "A Person", company: "A Company",
    products: [product], role, preferred: product,
  });
  return { w, G };
}

test("the door agrees with the role table for every role and product", { skip }, () => {
  const { G } = open("PROPERTY_MANAGEMENT", "OWNER");
  const ROLES = G.ROLES;
  const disagreements = [];

  for (const product of Object.keys(PRODUCTS)) {
    for (const key of Object.keys(ROLES)) {
      if (NOT_COMPANY_ROLES.has(key)) continue;
      const role = ROLES[key];

      /* What the table says: pinned elsewhere, or not named for this product. */
      const pinnedElsewhere = Boolean(role.only && role.only !== product);
      const expected = !pinnedElsewhere &&
        (role.sees === null || Boolean(role.sees && role.sees[product]));

      const { G: g } = open(product, key);
      const opens = opensFor(g);
      const got = opens.includes(product);

      if (got !== expected) {
        disagreements.push(
          `${product}/${key}: the door says ${got ? "open" : "closed"}, ` +
          `the role table says ${expected ? "open" : "closed"}`);
      }
    }
  }
  assert.deepEqual(disagreements, [], disagreements.join("\n   "));
});

test("a role pinned to one product cannot enter another", { skip }, () => {
  /*
   * The rule with teeth. SECURITY_MANAGER is `only: SECURITY_MANAGEMENT`, so
   * being an employee of a hotel does not put them inside the hotel console —
   * where the whole of finance lives, because that role's `sees` is null.
   */
  for (const product of ["PROPERTY_MANAGEMENT", "AGENT_HOST", "HOTEL_MANAGEMENT"]) {
    const { G } = open(product, "SECURITY_MANAGER");
    const opens = opensFor(G);
    assert.deepEqual(opens, [],
      `a security administrator was let into ${product}, where "sees: null" ` +
      `would hand them the entire console`);
  }

  /* And is let into its own. */
  const { G } = open("SECURITY_MANAGEMENT", "SECURITY_MANAGER");
  assert.deepEqual(opensFor(G), ["SECURITY_MANAGEMENT"]);
});

test("nobody is let in to an empty console", { skip }, () => {
  /*
   * Signing in successfully and arriving at a blank page is worse than being
   * refused: the refusal says something, the blank page looks broken.
   */
  const empty = [];
  const { G: table } = open("PROPERTY_MANAGEMENT", "OWNER");

  for (const product of Object.keys(PRODUCTS)) {
    for (const key of Object.keys(table.ROLES)) {
      if (NOT_COMPANY_ROLES.has(key)) continue;
      const { w, G } = open(product, key);
      const opens = opensFor(G);
      if (!opens.includes(product)) continue;

      const groups = (w.win["__navFor"] as Foreign)((PRODUCTS as Record<string, string>)[product]) || [];
      const items = groups.flatMap((g: Wire) => (g.items || []).map((i: Wire) => i[0]));
      if (!items.length) { empty.push(`${product}/${key}`); continue; }

      /* And they land on their OWN first screen — a guard on his shift, not
         on the company's command centre. */
      const landing = (w.win["__first"] as Foreign)((PRODUCTS as Record<string, string>)[product]);
      if (!landing || !items.includes(landing)) {
        empty.push(`${product}/${key}: lands on ${landing}, which is not in its own menu`);
      }
    }
  }
  assert.deepEqual(empty, [], "roles let in with nowhere to go:\n   " + empty.join("\n   "));
});

test("every screen a role is given actually renders", { skip }, () => {
  /* A menu item that throws when clicked is worse than one that is absent. */
  const broken = [];
  const { G: table } = open("PROPERTY_MANAGEMENT", "OWNER");

  for (const product of Object.keys(PRODUCTS)) {
    for (const key of Object.keys(table.ROLES)) {
      if (NOT_COMPANY_ROLES.has(key)) continue;
      const { w, G } = open(product, key);
      const opens = opensFor(G);
      if (!opens.includes(product)) continue;

      const groups = (w.win["__navFor"] as Foreign)((PRODUCTS as Record<string, string>)[product]) || [];
      for (const g of groups) {
        for (const [screen] of g.items || []) {
          const fn = (w.win["__S"] as Foreign)[screen];
          if (typeof fn !== "function") { broken.push(`${product}/${key}: ${screen} is not a screen`); continue; }
          try {
            const html = String(fn() ?? "");
            if (html.trim().length < 20) broken.push(`${product}/${key}: ${screen} rendered empty`);
          } catch (e) {
            broken.push(`${product}/${key}: ${screen} threw ${said(e).slice(0, 60)}`);
          }
        }
      }
    }
  }
  assert.deepEqual(broken, [], "screens a role can open but cannot use:\n   " + broken.join("\n   "));

  /*
   * AND IT ACTUALLY RENDERED THEM.
   *
   * The loop above reports what broke, which is worth nothing if it walked an
   * empty menu — every screen in the product would be "fine" because none was
   * tried. So a handful of the newest screens are named: they were the last
   * ones added to the table, and if the table is not being read they are the
   * first ones that would silently stop being checked.
   */
  const { w } = open("PROPERTY_MANAGEMENT", "OPERATIONS");
  const reached = new Set(
    ((w.win["__navFor"] as Foreign)("property") || []).flatMap((g: Wire) => (g.items || []).map((i: Wire) => i[0])));

  /* Procurement belongs to FINANCE, not operations — committing the company
     to pay somebody is a money decision even before any money moves. So it is
     checked through the role that actually has it. */
  const { w: fin } = open("PROPERTY_MANAGEMENT", "FINANCE");
  const byFinance = new Set(
    ((fin.win["__navFor"] as Foreign)("property") || []).flatMap((g: Wire) => (g.items || []).map((i: Wire) => i[0])));
  for (const screen of ["pm_rfqs", "pm_orders", "pm_variations",
                        "pm_land", "pm_feasibility"]) {
    assert.ok(byFinance.has(screen), `${screen} was never reached, so nothing above tested it`);
    assert.ok(!reached.has(screen),
      `${screen} is reachable by OPERATIONS — a site manager could commit the company to pay`);
  }
  for (const screen of ["pm_meetings", "pm_decisions", "pm_tasks", "pm_mywork",
                        "co_outbox", "co_messages", "co_campaigns",
                        "pm_rfis", "pm_submittals", "pm_inspections",
                        "pm_defects", "pm_diary",
                        "pm_drawings", "pm_permits",
                        "pm_team", "pm_handover", "pm_project_report"]) {
    assert.ok(reached.has(screen), `${screen} was never reached, so nothing above tested it`);
  }
});

test("every ＋ form has a screen that can open it", { skip }, () => {
  /*
   * A FORM NOBODY CAN REACH IS DEAD WEIGHT, and it is invisible: the spec is
   * served by GET /console/forms, every field of it is checked against the
   * API by console-forms.test.js, and it passes — while no button anywhere
   * opens it.
   *
   * `pm_quotes` was exactly that for a while. It is opened from inside the
   * RFQ panel now, because a quote belongs to a request and a list of quotes
   * detached from what was asked for is not useful — which is why it never
   * got a screen of its own and why the gap was easy to miss.
   *
   * So the rule is not "every form has a screen of the same name". It is
   * "something opens it".
   */
  const { w } = open("PROPERTY_MANAGEMENT", "OWNER");
  const js = readFileSync(join(FE, "assets", "console.js"), "utf8");

  /*
   * `documents` is the one exemption, and it is the opposite case: that screen
   * has a REAL upload button (data-act="docPick") which does something a
   * generated form cannot — it picks a file. Its form spec is kept because
   * aliasesFor() reads it for the field names, not because anybody opens it.
   */
  const HAS_ITS_OWN = new Set(["documents"]);

  const orphans = [];
  for (const screen of Object.keys(CONSOLE_FORMS)) {
    if (HAS_ITS_OWN.has(screen)) continue;
    const opens = js.includes(`newOpen::${screen}`);
    const drawn = js.includes(`newPanel("${screen}")`);
    if (!opens || !drawn) {
      orphans.push(`${screen}${!opens ? " — nothing calls newOpen for it" : ""}` +
                   `${!drawn ? " — no screen draws its panel" : ""}`);
    }
  }
  assert.deepEqual(orphans, [],
    "Forms the console serves that nobody can reach:\n   " + orphans.join("\n   ") +
    "\n\n  Either give it a button, or delete it from console-map.js.");
  /* And it really read the table. */
  assert.ok(Object.keys(CONSOLE_FORMS).length > 20, "the form table stopped loading");
  assert.ok((w.win["__S"] as Foreign), "the console stopped loading");
});

test("the role table is not quietly empty", { skip }, () => {
  /* Every assertion above iterates the role table. If it ever stops loading,
     they would all pass by iterating nothing. */
  const { G } = open("PROPERTY_MANAGEMENT", "OWNER");
  const company = Object.keys(G.ROLES).filter((k) => !NOT_COMPANY_ROLES.has(k));
  assert.ok(company.length >= 12, `only ${company.length} company roles found`);
  for (const k of ["OWNER", "MANAGER", "FINANCE", "GUARD", "FRONT_DESK", "HOUSEKEEPING"]) {
    assert.ok(G.ROLES[k], `${k} is missing from the role table`);
  }
  assert.equal(G.ROLES.OWNER.sees, null, "an owner stopped seeing the whole product");
  assert.equal(G.ROLES.SECURITY_MANAGER.only, "SECURITY_MANAGEMENT");
});

/* ==================================================================== *
 * NO DEAD BUTTONS: THE SIDEBAR MAY NOT OFFER WHAT THE API REFUSES.
 *
 * The console draws its nav from its own role table. The service decides
 * from ROLE_AREAS in domain/access.ts. Nothing made the two agree, and
 * they did not: five roles in the property console, six in agent, one in
 * hotel and eight in security were handed the FULL product sidebar —
 * general ledger, trial balance, P&L and all — because `allowed()`
 * answers null both for "this role sees everything" and for "this role
 * has a table with no entry for this product", and navFor() read the two
 * as the same thing.
 *
 * This test closes the loop by walking the only bridge that exists
 * between the two vocabularies: CONSOLE_FORMS maps a screen to a
 * resource, and the registry gives that resource its area. A screen whose
 * ＋ button posts to an area the role cannot write is a dead button, and
 * that is exactly what the brief forbids.
 * ==================================================================== */

test("the form map never offers a create the service refuses", { skip }, async () => {
  const { RESOURCES } = await import("../src/domain/registry.ts");
  const { whyNotArea, ROLE_AREAS } = await import("../src/domain/access.ts");

  /* What GET /console/forms would serve this role — the same filter the
     route applies, over the same two tables. */
  const servedTo = (role: string): string[] =>
    Object.entries(CONSOLE_FORMS)
      .filter(([, spec]) => {
        const r = RESOURCES[spec.resource];
        return r && !whyNotArea({ role }, r.area, "create", r.area);
      })
      .map(([screen]) => screen);

  const offending: string[] = [];
  let checked = 0;

  for (const role of Object.keys(ROLE_AREAS)) {
    for (const screen of servedTo(role)) {
      const spec = CONSOLE_FORMS[screen];
      const r = RESOURCES[spec!.resource];
      checked += 1;
      const why = whyNotArea({ role }, r!.area, "create", r!.area);
      if (why) offending.push(`${role}: ${screen} -> ${spec!.resource} (${r!.area}) — ${why}`);
    }
  }

  assert.ok(checked > 150,
    `only ${checked} role/form pairs were checked, so this proves nothing — ` +
    `the form map or the registry has stopped matching`);
  assert.deepEqual(offending, [],
    "a ＋ button was offered to somebody the service will refuse:\n    " +
    offending.join("\n    "));

  /* And the filter really filters, or the test above passes on everything. */
  const owner = servedTo("OWNER").length;
  const engineer = servedTo("ENGINEERING").length;
  assert.ok(engineer < owner,
    `an engineer is offered the same ${owner} forms an owner is. The permission ` +
    `filter on /console/forms is not doing anything.`);
  assert.ok(engineer > 0, "an engineer was left with no form at all, which is not right either");
});
