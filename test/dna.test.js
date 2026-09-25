/**
 * ====================================================================== *
 * PROPERTY DNA — the guarantees.
 *
 * The behaviour that matters here is NEGATIVE: what a person does not
 * receive. That is the hardest kind to keep, because nothing visibly breaks
 * when it stops being true — a leak looks like a feature working.
 *
 * So these tests assert the shape of the enforcement rather than only its
 * output: that the classification ladder is ordered as written, that redact()
 * DELETES rather than nulls, that there is no route to edit a memory, that
 * succession cannot conclude in one person's hands, and that Property DNA did
 * not quietly become a seventh product.
 * ====================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLASS_RANK, SECURITY_CLASS, ALL_CLASSES, RELATION_CEILING, ROLE_CEILING,
  clearanceFor, mayRead, visibleRows, redact, withheldSummary, publicProfile,
} from "../src/domain/classification.ts";
import { refFor, SUCCESSION_NEXT, SUCCESSION_TERMINAL, mayAdvance } from "../src/domain/dna.ts";
/* Source is read through one helper so a rename to .ts cannot make this
   scanner silently find nothing. See test/src-files.js. */
import { sourceText, handlerText } from "./src-files.js";

/* fileURLToPath, not .pathname: this repository's directory name contains a
   space, and .pathname hands back "paltas-backend%202". */
const HERE = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(join(HERE, "prisma/schema.prisma"), "utf8");
const routes = sourceText("routes", "dna.js");
const domain = sourceText("domain", "dna.js");
/* Identity moved into the module when Property DNA was split up; the rule it
   has to keep did not move. */
const identity = sourceText("modules", "property-dna", "domain", "identity.js");
const classification = sourceText("domain", "classification.js");

const FE = process.env.PALTAS_FRONTEND || resolve(HERE, "..", "paltas-frontend 2");
const skipFE = existsSync(join(FE, "assets", "console.js")) ? undefined : `no frontend at ${FE}`;

/* ---------------------------------------------------------------- *
 * 1. NOT A SEVENTH PRODUCT
 * ---------------------------------------------------------------- */

test("Property DNA is a layer, not a product somebody can be sold", () => {
  /*
   * The brief was explicit and the schema is where it would be broken first:
   * a PROPERTY_DNA in the Product enum would make it purchasable, put it in
   * the signup picker, and give every existing company a product they did not
   * buy.
   */
  const block = schema.slice(schema.indexOf("enum Product {"));
  const values = block.slice(0, block.indexOf("}")).split("\n")
    .map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l));

  assert.ok(!values.includes("PROPERTY_DNA"),
    "PROPERTY_DNA is in the Product enum, which makes it a seventh product");
  assert.deepEqual(values.sort(), [
    "AGENT_HOST", "GUEST_PORTAL", "HOTEL_MANAGEMENT", "PLATFORM",
    "PROPERTY_MANAGEMENT", "SECURITY_MANAGEMENT",
  ], "the set of products changed");

  /* And it must hang off the property that already exists, not a second one. */
  assert.ok(/model PropertyDna \{[\s\S]*?siteId String @unique/.test(schema),
    "PropertyDna is not 1:1 with Site — a second property model would leave " +
    "two answers to “which property is this?”");
  assert.ok(!/^model Property \{/m.test(schema),
    "a separate Property model was introduced alongside Site");
});

/* ---------------------------------------------------------------- *
 * 2. THE CLASSIFICATION LADDER
 * ---------------------------------------------------------------- */

test("the classification ladder is ordered, and security sits off it", () => {
  assert.deepEqual(
    Object.entries(CLASS_RANK).sort((a, b) => a[1] - b[1]).map(([k]) => k),
    ["PUBLIC", "INTERNAL", "RESTRICTED", "CONFIDENTIAL", "OWNER_ONLY", "LEGAL_RESTRICTED"],
    "the ladder changed order; every clearance check depends on it"
  );

  /*
   * SECURITY_RESTRICTED is deliberately not a rung.
   *
   * On a ladder, the top sees everything below — so an owner would inherit
   * the gate layout, the camera map and the unwatched hours. That is the
   * document a thief wants most and an owner has no operational need for, so
   * it is granted on its own terms instead.
   */
  assert.equal(CLASS_RANK[SECURITY_CLASS], undefined,
    "SECURITY_RESTRICTED became a rung on the ladder, so climbing now reaches it");
  assert.ok(ALL_CLASSES.includes(SECURITY_CLASS));

  const top = { rank: CLASS_RANK.LEGAL_RESTRICTED, label: "LEGAL_RESTRICTED", security: false, via: "test" };
  assert.equal(mayRead(top, "OWNER_ONLY"), true);
  assert.equal(mayRead(top, SECURITY_CLASS), false,
    "the highest rung reached security-restricted data without the security right");
});

test("an unknown classification is refused, not waved through", () => {
  const top = { rank: 99, label: "X", security: true, via: "test" };
  assert.equal(mayRead(top, "MADE_UP"), false);
  assert.equal(mayRead(top, undefined), false);
  assert.equal(mayRead(null, "PUBLIC"), false);
  /* A row with no class is treated as INTERNAL, not as public: the failure
     that matters is the one that leaks. */
  const anon = visibleRows([{ id: 1 }], { rank: CLASS_RANK.PUBLIC, label: "PUBLIC", security: false });
  assert.equal(anon.length, 0, "a row with no classification was shown to a PUBLIC clearance");
});

test("a company role never reaches owner-only, however senior", () => {
  /*
   * A managing agent runs other people's buildings — that is the whole
   * business. Seniority at the company is not standing on the property, and
   * nothing in ROLE_CEILING may say otherwise.
   */
  for (const [role, ceiling] of Object.entries(ROLE_CEILING)) {
    assert.ok(CLASS_RANK[ceiling] < CLASS_RANK.OWNER_ONLY,
      `the role ${role} reaches ${ceiling}; no role may reach owner-only data ` +
      `without a relationship to the property`);
  }
  const boss = clearanceFor({ role: "OWNER" }, []);
  assert.equal(mayRead(boss, "OWNER_ONLY"), false,
    "the company's own OWNER read owner-only data on a property they have no relationship to");
  assert.equal(mayRead(boss, "CONFIDENTIAL"), true, "the check would be vacuous");
});

test("a relationship raises a person, and its own cap can lower them", () => {
  const asOwner = clearanceFor({ role: "GUEST" },
    [{ relation: "OWNER", clearance: "LEGAL_RESTRICTED", active: true }]);
  assert.equal(asOwner.label, "LEGAL_RESTRICTED",
    "a property owner holding no company role was not raised by the relationship");
  assert.match(asOwner.via, /OWNER of this property/);

  /* An owner may deliberately narrow a co-owner. The lower of the two wins. */
  const narrowed = clearanceFor({ role: "GUEST" },
    [{ relation: "CO_OWNER", clearance: "CONFIDENTIAL", active: true }]);
  assert.equal(narrowed.label, "CONFIDENTIAL",
    "an explicit narrower clearance on the relationship was ignored");

  /* An ended relationship grants nothing. */
  const ended = clearanceFor({ role: "GUEST" },
    [{ relation: "OWNER", clearance: "LEGAL_RESTRICTED", active: false }]);
  assert.equal(mayRead(ended, "OWNER_ONLY"), false,
    "an ended relationship still granted owner-only access");

  /* A named heir is not yet an owner. */
  assert.equal(RELATION_CEILING.BENEFICIARY, "CONFIDENTIAL",
    "a beneficiary was given owner-level access to the family's records");
});

/* ---------------------------------------------------------------- *
 * 3. REDACTION — absent, not null
 * ---------------------------------------------------------------- */

test("a field the caller may not read is absent, not null", () => {
  /*
   * A null tells a reader that something exists and they cannot see it. On an
   * ownership record that is itself a disclosure — it confirms a private
   * valuation was recorded. The key must not be in the object at all.
   */
  const row = { holder: "The Hassan Family Trust", basis: "Deed 1998", active: true };
  const spec = {
    holder: { from: "holder", class: "OWNER_ONLY" },
    basis: { from: "basis", class: "LEGAL_RESTRICTED" },
    active: { from: "active", class: "CONFIDENTIAL" },
  };
  const manager = { rank: CLASS_RANK.CONFIDENTIAL, label: "CONFIDENTIAL", security: false, via: "role" };
  const out = redact(row, spec, manager);

  assert.ok(!("holder" in out), "the holder key survived redaction as a null or empty value");
  assert.ok(!("basis" in out), "the basis key survived redaction");
  assert.equal(out.active, true, "the check would be vacuous");
  assert.equal(JSON.stringify(out).includes("Hassan"), false,
    "the redacted object still serialises the private value");
});

test("what was withheld is reported as counts, never as contents", () => {
  const rows = [
    { class: "OWNER_ONLY", holder: "The Hassan Family Trust" },
    { class: "OWNER_ONLY", holder: "Yusuf Hassan" },
    { class: "INTERNAL", holder: "Visible" },
  ];
  const manager = { rank: CLASS_RANK.CONFIDENTIAL, label: "CONFIDENTIAL", security: false, via: "role" };
  const summary = withheldSummary(rows, manager);
  assert.deepEqual(summary, { OWNER_ONLY: 2 });
  assert.equal(JSON.stringify(summary).includes("Hassan"), false,
    "the withheld summary named a value it was meant to be hiding");
});

/* ---------------------------------------------------------------- *
 * 4. THE PUBLIC SHAPE
 * ---------------------------------------------------------------- */

test("there is exactly one public shape, and it is opt-in", () => {
  const dna = {
    ref: "PALTAS-PROP-KE-NAI-00000001", publicProfile: false,
    publicSummary: "A quiet estate", verification: "VERIFIED",
    verifiedBy: "PALTAS", verifiedNote: "internal note",
  };
  const site = { name: "Nairobi Heights", kind: "RESIDENTIAL", city: "Nairobi", country: "ke", address: "12 Quiet Lane" };

  assert.equal(publicProfile(dna, site), null,
    "a property published without anybody turning a public profile on");

  const on = publicProfile({ ...dna, publicProfile: true }, site);
  assert.deepEqual(Object.keys(on).sort(),
    ["city", "country", "kind", "name", "ref", "summary", "verified"],
    "the public shape gained or lost a field — this is the one place that " +
    "decides what the marketplace may ever learn");
  assert.ok(!("address" in on), "the street address reached the public shape");
  assert.ok(!("verifiedNote" in on), "an internal verification note reached the public shape");
});

/* ---------------------------------------------------------------- *
 * 5. THE MEMORY IS APPEND-ONLY
 * ---------------------------------------------------------------- */

test("there is no way to edit or delete a property's memory", () => {
  /*
   * A record somebody may later be asked to rely on is worth less if it can
   * be quietly tidied. A correction is a NEW event saying what changed.
   */
  const timelineRoutes = routes.match(/dnaRoutes\.(get|post|put|patch|delete)\([^)]*timeline[^)]*\)/g) || [];
  assert.ok(timelineRoutes.length >= 2, "the timeline routes are gone");
  for (const r of timelineRoutes) {
    assert.ok(!/\.(put|patch|delete)\(/.test(r),
      `a route offers to change a recorded event: ${r}`);
  }
  assert.ok(!/propertyTimelineEvent\.(update|delete|updateMany|deleteMany)/.test(routes + domain),
    "something updates or deletes a timeline event");
  assert.ok(!/successionStep\.(update|delete|updateMany|deleteMany)/.test(routes + domain),
    "something rewrites the trail of moves a succession case made");
});

/* ---------------------------------------------------------------- *
 * 6. SUCCESSION IS NOT A LEGAL CONCLUSION
 * ---------------------------------------------------------------- */

test("no succession transition transfers a property to anybody", () => {
  /*
   * PALTAS is a place to assemble and track documentation. Who inherits is
   * decided by people and by law, with an authority PALTAS does not have.
   * Reaching COMPLETED records that a documented process concluded — and the
   * code must contain nothing that moves a holder as a consequence.
   */
  assert.deepEqual(SUCCESSION_NEXT.COMPLETED, [], "a completed case can still be moved");
  assert.ok(SUCCESSION_TERMINAL.has("COMPLETED") && SUCCESSION_TERMINAL.has("CANCELLED"));

  const both = routes + domain;
  assert.ok(!/propertyOwnershipRecord\.(create|update|updateMany)[\s\S]{0,400}?SUCCESSION_COMPLETED/.test(both),
    "completing a succession case writes an ownership record as a side effect");
  assert.ok(/advanceCase/.test(routes), "cases move by some route other than the machine");

  /* Every move must be declared. An undeclared status is a status nobody
     reviewed. */
  const declared = new Set(Object.keys(SUCCESSION_NEXT));
  for (const [from, tos] of Object.entries(SUCCESSION_NEXT)) {
    for (const to of tos) {
      assert.ok(declared.has(to), `${from} can move to ${to}, which is not a declared status`);
    }
  }
});

test("the machine refuses a skipped step and a terminal case", () => {
  assert.equal(mayAdvance("DRAFT", "INITIATED"), null);
  assert.match(mayAdvance("INITIATED", "COMPLETED") || "", /not COMPLETED/,
    "a case jumped from initiated straight to completed");
  assert.match(mayAdvance("COMPLETED", "DISPUTED") || "", /cannot be moved again/,
    "a completed case was reopened instead of a new one being started");
  assert.match(mayAdvance("NONSENSE", "DRAFT") || "", /not a status/);
});

test("the person who opens a case cannot also approve it", () => {
  /*
   * One signature is not a process. This is the only place in Property DNA
   * where two different people are required, and it is required because the
   * outcome is a record about somebody's estate.
   */
  const guard = handlerText(routes, "succession/:caseId/advance", "dnaRoutes");

  /*
   * THE OPENER IS COMPARED AGAINST THE SIGNED-IN PERSON.
   *
   * This matched the literal `found.openedById === req.session.userId` and
   * broke when the handler read the session through a helper — a test
   * failing over punctuation while the rule it guards was untouched.
   *
   * What matters is the pair: the comparison is against the SESSION's user,
   * and it is not against anybody the request named. A handler comparing
   * the opener to a user id out of the body would let one person do both.
   */
  assert.match(guard, /found\.openedById === (req\.)?session(Of\([^)]*\))?\.userId/,
    "the opener of a succession case is no longer stopped from approving it");
  assert.doesNotMatch(guard, /found\.openedById === (String\()?req\.(body|params|query)/,
    "the opener is compared against a user id the caller sent");
  assert.match(guard, /"APPROVED"[\s\S]{0,60}"COMPLETED"/,
    "the two-person rule no longer covers both approving and completing");
});

/* ---------------------------------------------------------------- *
 * 7. NOTHING IS INFERRED OR INVENTED
 * ---------------------------------------------------------------- */

test("a scan produces suggestions, and none are invented", () => {
  /*
   * There is no extraction provider in this deployment. The temptation is to
   * fill the screen with plausible rooms and appliances; that is the same
   * fabrication as an invented listing, told about somebody's home.
   */
  assert.match(routes, /available: false/, "the scan endpoint claims a provider it does not have");
  assert.ok(!/findings:\s*\[\s*\{/.test(routes),
    "the scan endpoint returns findings it manufactured");
  assert.match(schema, /model PropertyScanFinding \{[\s\S]*?verified\s+Boolean\s+@default\(false\)/,
    "a scan finding now defaults to verified");
  assert.match(schema, /model PropertyScanFinding \{[\s\S]*?confidence Int\?/,
    "a finding no longer carries a confidence");
});

test("the AI boundary filters before it assembles, not after", () => {
  /*
   * A model that has been shown a will cannot be asked to forget it, and
   * “the prompt said not to mention it” is not access control. The clearance
   * has to be applied while the context is built.
   */
  const fn = domain.slice(domain.indexOf("export function aiContext"));
  assert.match(fn, /visibleRows\(timeline, clearance\)/,
    "the AI context includes the timeline without filtering it");
  assert.match(fn, /visibleRows\(ownership, clearance\)/,
    "the AI context includes ownership records without filtering them");
  assert.match(routes, /answer: null/, "the AI endpoint claims to have answered something");
  assert.match(routes, /provider: \{[\s\S]{0,120}available: false/,
    "the AI endpoint claims a provider it does not have");
});

test("a property is verified by PALTAS, not by its own company", () => {
  const v = routes.slice(routes.indexOf('dnaRoutes.post("/properties/:siteId/verification"'));
  assert.match(v.slice(0, 1400), /body\.state === "VERIFIED"[\s\S]{0,80}throw forbidden/,
    "a company can mark its own property verified, which makes the badge worthless");
});

/* ---------------------------------------------------------------- *
 * 8. TENANCY AND AUDIT
 * ---------------------------------------------------------------- */

test("every Property DNA query is scoped to one company", () => {
  /*
   * The same rule the rest of the service follows. Checked here as well as in
   * tenancy.test.js because these routes are hand-written rather than built
   * by the resource framework, so nothing scopes them automatically.
   */
  const queries = routes.match(/db\.\w+\.(findMany|findFirst|count|update|create|createMany)\(\{[\s\S]{0,220}?\}\)/g) || [];
  assert.ok(queries.length > 10, "the routes stopped querying anything");
  for (const q of queries) {
    if (/db\.auditEvent\.create/.test(q)) continue;           /* writes orgId explicitly */
    assert.ok(/orgId/.test(q), `a query is not scoped to an organization:\n${q.slice(0, 160)}`);
  }
});

test("reading a confidential record is auditable, not only writing one", () => {
  /*
   * Who LOOKED at an ownership record or a succession case is the question
   * asked after something goes wrong, and it cannot be answered later if it
   * was not recorded at the time.
   */
  for (const action of [
    "dna.ownership.read", "dna.succession.read", "dna.ownership.create",
    "dna.succession.open", "dna.succession.advance", "dna.ai.context",
  ]) {
    assert.ok(routes.includes(`"${action}"`), `${action} is no longer audited`);
  }
});

/* ---------------------------------------------------------------- *
 * 9. THE IDENTIFIER
 * ---------------------------------------------------------------- */

test("the property identifier is readable, and its sequence is per company", () => {
  assert.equal(
    refFor({ country: "ke", city: "Nairobi" }, 1234),
    "PALTAS-PROP-KE-NAI-00001234"
  );
  /* A property with nothing recorded still gets a well-formed identifier. */
  assert.match(refFor({}, 1), /^PALTAS-PROP-XX-XXX-00000001$/);

  /*
   * Per organization, not global. A global counter would tell every customer
   * how many properties every other customer has.
   */
  assert.match(identity, /db\.propertyDna\.count\(\{ where: \{ orgId \} \}\)/,
    "the identifier sequence is no longer counted per organization");
  assert.match(schema, /@@unique\(\[orgId, ref\]\)/,
    "two properties in one company could take the same identifier");
});

/* ---------------------------------------------------------------- *
 * 10. THE CONSOLE SHOWS WHAT THE SERVER SENT
 * ---------------------------------------------------------------- */

test("the console filters nothing itself, and says so where it matters", { skip: skipFE }, () => {
  const js = readFileSync(join(FE, "assets", "console.js"), "utf8");
  const marker = js.indexOf("PALTAS PROPERTY DNA — the console screen");
  assert.ok(marker > 0, "the Property DNA screen is gone");
  /*
   * Start at the comment's OPENER, not at its text.
   *
   * Slicing from the header line left the tail of a block comment with no
   * "/*" in front of it, so the comment stripper below had nothing to pair
   * and the prose survived — including the line that quotes the anti-pattern
   * by name. The test then found its own explanation and failed on it.
   */
  const at = js.lastIndexOf("/*", marker);
  /* Bounded to the DNA screen. An overshoot picks up the rest of the console,
     where `role === "HOST"` is a legitimate line about something else. */
  const end = js.indexOf("function dnaAi", at);
  const ui = js.slice(at, end > 0 ? js.indexOf("\n}", end) : at + 20000);

  /* Tabs are hidden from the access map the server sent — and every endpoint
     checks again, so the map is a courtesy rather than a control. */
  assert.match(ui, /DNA_TABS\.filter\(function \(t\) \{ return !t\[2\] \|\| may\[t\[2\]\]; \}\)/,
    "the console no longer uses the server's access map to choose tabs");
  /* Comments describe the rule and quote the anti-pattern by name, so they
     have to go before matching or the test finds its own explanation. */
  const code = ui.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/role === ['"]owner['"]|isOwner|user\.role ===/.test(code),
    "the console decides access from a role it holds locally");

  /* The padlocks. Confidentiality a person can see. */
  for (const label of ["Owner only", "Legal restricted", "Security restricted"]) {
    assert.ok(ui.includes(label), `the ${label} marker is gone from the console`);
  }
  /* And the line that tells somebody a refusal came from the server. */
  assert.match(ui, /never sent to your browser/,
    "the console no longer explains that a refusal is enforced server-side");
});
