/* ====================================================================== *
 * THE 45 ENDPOINTS THE PRODUCT NAMES OUT LOUD, AND WHICH ONES EXIST.
 *
 * `contract/backend.md` §3 lists 45 endpoints, and its own sentence about
 * them is the point:
 *
 *     "Every one of these is spoken aloud by the interface when clicked,
 *      so the frontend and the backlog cannot drift apart."
 *
 * §2 — the 27 create forms — is fully served, and console-forms.test.js
 * posts every one of them at the running API to prove it. §3 is different:
 * most of it is not built, and pretending otherwise would be worse than
 * saying so.
 *
 * ── WHY THIS TEST PASSES WHILE MOST OF §3 IS MISSING ───────────────────
 *
 * Because an unbuilt endpoint is not a bug. It is a decision, and the
 * failure this file guards against is a DIFFERENT one: forgetting. The
 * list below has to name every line of §3 and say which of three things it
 * is. If §3 grows a line, or one is quietly served, or one is quietly
 * dropped, this test fails until somebody looks at it and decides again.
 *
 * So the number to watch is not "how many pass". It is `SERVED`, and it
 * should go up.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCES } from "../src/domain/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(HERE, "..", "contract", "backend.md"), "utf8");
const products = readFileSync(join(HERE, "..", "src", "routes", "products.js"), "utf8");

/** `| \`POST\` | \`/hotel/rooms\` | A room, its type… |` */
function parseNamed() {
  const from = md.indexOf("## 3. Endpoints named");
  const to = md.indexOf("## 4. What is already complete");
  assert.ok(from > 0 && to > from, "§3 is no longer in contract/backend.md");

  const rows = [];
  for (const line of md.slice(from, to).split("\n")) {
    const m = line.match(/^\|\s*`(GET|POST|PUT|PATCH|DELETE)`\s*\|\s*`([^`]+)`\s*\|/);
    if (m) rows.push({ verb: m[1], path: m[2] });
  }
  return rows;
}

const NAMED = parseNamed();

/* ====================================================================== *
 * THE DECISION, ONE LINE PER ENDPOINT.
 *
 *   served    — this API answers it today
 *   later     — a real feature, not built yet, and the reason it can wait
 *   elsewhere — not this service's job at all
 * ====================================================================== */

const STATUS = {
  /* ---- served today ------------------------------------------------ */
  "POST /property/payments":
    ["served", "POST /payments, which writes a receipt and recomputes the invoice"],
  "POST /hotel/reservations":
    ["served", "POST /reservations, with the same fields h_reservations collects"],
  "POST /hotel/rooms":
    ["served", "POST /rooms, with type, floor and housekeeping state"],
  "POST /agent/clients":
    ["served", "POST /parties — one contact table for owners, buyers, tenants and guests"],
  "POST /operations/tasks":
    ["served", "POST /work-orders — a turnover task is a work order with a kind"],
  "POST /security/control-room/events":
    ["served", "POST /incidents, whose history is append-only"],
  "POST /organizations/{id}/invitations":
    ["later", "invitations need email delivery, which this service does not have yet"],

  /* ---- real, and waiting ------------------------------------------- */
  "GET /{system}/{screen}/export?format=csv":
    ["later", "every list is already scoped and paged; export is the same query with a different writer"],
  "GET /finance/ledger/export?format=xlsx":
    ["later", "same, once there is a ledger view to export"],
  "POST /{system}/reports":
    ["later", "needs a queue and somewhere to put the result; nothing else is blocked by it"],
  "POST /{system}/{screen}/import":
    ["later", "row-by-row validation with reasons — the validation exists in clean(), the CSV half does not"],
  "GET /{system}/reports/daily":
    ["later", "needs the property's own timezone, which is not modelled yet"],
  "GET /hotel/reports/night-audit":
    ["later", "depends on the daily close above"],
  "POST /hotel/finance/post":
    ["later", "posts to an accounting integration that has not been chosen"],
  "POST /property/payments/reconcile":
    ["later", "matching bank lines to invoices; the invoice side is built, the bank feed is not"],
  "POST /property/payments/requests":
    ["later", "sends a payment link on the tenant's channel — needs messaging"],
  "POST /property/investors/reports":
    ["later", "investors are not modelled yet"],
  "POST /notifications/test":
    ["later", "needs a notification channel to test"],
  "PUT /{system}/settings":
    ["later", "per-product settings are not modelled yet"],
  "GET /listings/{id}/preview":
    ["later", "renders the public view of a listing; the listing itself is served"],
  "GET /agents/{id}":
    ["later", "a public agent page — a marketplace concern, see §4c"],
  "POST /security/passes/scan":
    ["later", "the desk fallback for the guard app; passes are served, scanning is not"],
  "POST /hotel/rooms/{id}/block":
    ["later", "needs a date-range availability model, which rooms do not have yet"],
  "POST /listings/{id}/calendar/block":
    ["later", "same, across channels"],
  "GET /hotel/lost-found":
    ["later", "items logged against rooms and guests — no model for them yet"],
  "POST /hotel/reservations?source=walk-in":
    ["later", "a reservation and a check-in in one step; the reservation half is served"],
  "POST /property/rent-runs":
    ["later", "raises this month's invoice against every live lease — leases and invoices are both served, the run is not"],
  "POST /property/units/{id}/short-stay":
    ["later", "moves a unit from long let to nightly; needs rates and calendars"],
  "POST /hotel/stays/{id}/check-out":
    ["later", "closes the folio and releases the room; folio close is served, the rest is not"],
  "POST /hotel/stays/{id}/check-in":
    ["later", "assigns a room and takes the balance"],
  "PUT /listings/{id}/price":
    ["later", "repricing across channels, with history"],
  "POST /hotel/groups/enquiries":
    ["later", "a block of rooms held against dates for an event — not modelled"],
  "POST /security/access/cards":
    ["later", "an access card bound to doors; passes are the nearest thing served"],
  "POST /security/approvals":
    ["served", "POST /visits/:id/decide records who decided and why"],
  "POST /security/shifts/cover":
    ["later", "filling a shift and telling both guards — needs messaging"],
  "POST /{system}/pricing/rules":
    ["later", "a condition, an adjustment and the dates it applies — not modelled"],
  "POST /messages":
    ["later", "messaging is not built at all, on any channel"],
  "GET /onboarding/next":
    ["later", "the frontend owns onboarding today"],
  "PUT /{system}/{screen}":
    ["served", "PATCH /<resource>/:id, on all 28 resources"],

  /* ---- somebody else's job ----------------------------------------- */
  "GET https://paltas.io":
    ["elsewhere", "a link to the public marketplace, not an API call"],
  "POST /platform/companies/invitations":
    ["later", "PALTAS staff tooling — inviting a company to onboard"],
  "POST /platform/hotels":
    ["later", "PALTAS staff tooling — POST /organizations does this for a customer signing themselves up"],
  "POST /platform/security-firms":
    ["later", "PALTAS staff tooling — the same shape as /platform/hotels"],
  "POST /platform/plans":
    ["later", "needs the Plan/AddOn layer, which is waiting on two product decisions — see AUDIT.md"],
  "POST /platform/compliance/cases":
    ["later", "PALTAS staff tooling — a case against a company, with an owner and a due date"],
};

/* ================================================================ */

test("§3 still lists 45 endpoints", () => {
  assert.equal(NAMED.length, 45,
    `§3 now lists ${NAMED.length} endpoints, not 45.`);
});

test("every endpoint the product names has been decided about", () => {
  const undecided = [];
  for (const { verb, path } of NAMED) {
    if (!STATUS[`${verb} ${path}`]) undecided.push(`${verb} ${path}`);
  }
  assert.deepEqual(undecided, [],
    "The product speaks these endpoint names aloud and nobody has said what they are:\n  " +
    undecided.join("\n  ") +
    "\n\nAdd each to STATUS in this file as served / later / elsewhere, with the reason. " +
    "The point is that no named endpoint is ever simply forgotten.");
});

test("nothing in the decision list has fallen out of the contract", () => {
  /* A stale entry is a claim about a feature the product no longer names. */
  const live = new Set(NAMED.map((n) => `${n.verb} ${n.path}`));
  const stale = Object.keys(STATUS).filter((k) => !live.has(k));
  assert.deepEqual(stale, [],
    "These are decided about but no longer in §3:\n  " + stale.join("\n  "));
});

test("every reason is a reason, not a shrug", () => {
  for (const [endpoint, [state, why]] of Object.entries(STATUS)) {
    assert.ok(["served", "later", "elsewhere"].includes(state),
      `${endpoint} has state "${state}"`);
    assert.ok(why && why.length > 15,
      `${endpoint} says "${why}" — that does not tell the next person anything`);
  }
});

test("everything claimed as served really is", () => {
  /*
   * The dangerous half of this file. A line marked `served` that is not is a
   * promise in a document, and documents are believed.
   */
  const broken = [];
  for (const [endpoint, [state, why]] of Object.entries(STATUS)) {
    if (state !== "served") continue;

    /* The claim names what serves it. Check that thing exists. */
    const resource = why.match(/\/([a-z-]+)(?:\/|,|$| )/)?.[1];
    const hand = why.match(/(POST|GET|PATCH|DELETE) (\/[\w:/-]+)/);

    if (resource && RESOURCES[resource]) continue;
    if (hand && products.includes(`"${hand[2].replace(/:id/g, ":id")}"`)) continue;
    if (/PATCH \/<resource>\/:id/.test(why)) continue;

    broken.push(`${endpoint} is marked served by "${why}", and that does not exist`);
  }
  assert.deepEqual(broken, [], broken.join("\n  "));
});

test("the served count is recorded, and is expected to go up", () => {
  const served = Object.values(STATUS).filter(([s]) => s === "served").length;
  /*
   * A floor, not a target. If this fails because the number went UP, raise
   * it and be pleased. If it fails because the number went DOWN, something
   * that used to work has stopped.
   */
  assert.ok(served >= 8,
    `only ${served} of the 45 named endpoints are served — that is fewer than before, ` +
    `so something that used to work has stopped`);
});
