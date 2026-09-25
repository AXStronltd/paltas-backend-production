/**
 * ====================================================================== *
 * THE AUTHORITY LAYER — the guarantees.
 *
 * One sentence decides whether this feature is safe or is a surveillance
 * platform: "government = see everything" must never become true. These tests
 * assert the shape that keeps it false, because the failure is silent — a
 * mandate that quietly widens looks exactly like one that works.
 * ====================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLASS_RANK, SECURITY_CLASS, AUTHORITY_CLASS, OFF_LADDER, ALL_CLASSES,
  clearanceFor, mayRead,
} from "../src/domain/classification.ts";
import { normalisePath, contains, mayDataset, whyNotDataset } from "../src/modules/authority/domain/jurisdiction.ts";
/* Source is read through one helper so a rename to .ts cannot make this
   scanner silently find nothing. See test/src-files.js. */
import { sourceText, handlerText } from "./src-files.js";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(join(HERE, "prisma/schema.prisma"), "utf8");
const routes = sourceText("modules", "authority", "api", "routes.js");
const jurisdiction = sourceText("modules", "authority", "domain", "jurisdiction.js");
const context = sourceText("modules", "property-dna", "domain", "context.js");

/* ---------------------------------------------------------------- *
 * 1. NO WILDCARD ANYWHERE
 * ---------------------------------------------------------------- */

test("a mandate names datasets, and there is no value meaning all", () => {
  const block = schema.slice(schema.indexOf("enum AuthorityDataset {"));
  const values = block.slice(0, block.indexOf("}")).split("\n")
    .map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l));

  assert.ok(values.length > 5, "the dataset list is gone");
  for (const forbidden of ["ALL", "ANY", "EVERYTHING", "WILDCARD", "FULL"]) {
    assert.ok(!values.includes(forbidden),
      `AuthorityDataset has a ${forbidden} value — the widest mandate must ` +
      `still be a list somebody wrote down and somebody else can read back`);
  }
  /* And nothing in the model grants every dataset in one flag. */
  assert.ok(!/allDatasets|datasetsAll|fullAccess/i.test(schema),
    "a mandate can grant everything through a flag");
});

test("no dataset names owner-only, legal or security information", () => {
  /*
   * The dataset list is what an authority can be granted. If a dataset ever
   * meant "the ownership records" or "the security configuration", a mandate
   * could reach them without anything else in the system changing.
   */
  const block = schema.slice(schema.indexOf("enum AuthorityDataset {"));
  const values = block.slice(0, block.indexOf("}")).split("\n").map((l) => l.trim());
  for (const leak of ["HERITAGE", "SUCCESSION", "OWNERSHIP_PRIVATE", "VALUATION",
                      "SECURITY", "CCTV", "ACCESS_CONTROL", "FAMILY", "CORRESPONDENCE"]) {
    assert.ok(!values.includes(leak), `AuthorityDataset includes ${leak}`);
  }
});

/* ---------------------------------------------------------------- *
 * 2. AN AUTHORITY IS NOT A SENIOR CUSTOMER
 * ---------------------------------------------------------------- */

test("an authority clearance climbs nowhere", () => {
  /*
   * This is the single most important assertion in the file. An authority
   * arrives with a mandate rather than a rank, and what it gets is the
   * authority room plus the public floor — never a rank that climbs toward a
   * family's papers.
   */
  const asAuthority = clearanceFor(
    { role: "OWNER" },                       /* senior at its OWN organization */
    [],
    { within: true, datasets: ["PERMITS"], jurisdiction: { path: "KE/NAIROBI" } }
  );

  assert.equal(asAuthority.label, "AUTHORITY");
  assert.equal(asAuthority.rank, CLASS_RANK.PUBLIC, "an authority was given a rank that climbs");
  assert.equal(mayRead(asAuthority, AUTHORITY_CLASS), true, "the check would be vacuous");

  for (const cls of ["OWNER_ONLY", "LEGAL_RESTRICTED", "CONFIDENTIAL", "RESTRICTED", "INTERNAL"]) {
    assert.equal(mayRead(asAuthority, cls), false,
      `an authority reached ${cls} information about somebody's property`);
  }
  assert.equal(mayRead(asAuthority, SECURITY_CLASS), false,
    "an authority reached the building's security configuration");
});

test("an authority whose mandate does not reach a property gets nothing", () => {
  const outside = clearanceFor({ role: "OWNER" }, [],
    { within: false, why: "no mandate here", datasets: [] });
  assert.equal(outside.rank, -1, "an out-of-jurisdiction authority kept a usable clearance");
  for (const cls of ALL_CLASSES) {
    assert.equal(mayRead(outside, cls), false, `it still reached ${cls}`);
  }
});

test("a customer never reaches the authority room by seniority alone", () => {
  /*
   * AUTHORITY_RESTRICTED is asymmetric ON PURPOSE: a building's own people
   * see the permits on their building from RESTRICTED up, and an authority
   * never reads down into OWNER_ONLY. Both halves are asserted, because
   * dropping either one is a plausible "simplification".
   */
  const guard = clearanceFor({ role: "GUARD" }, []);      /* PUBLIC */
  assert.equal(mayRead(guard, AUTHORITY_CLASS), false,
    "a guard reached the official record on the property");

  const manager = clearanceFor({ role: "MANAGER" }, []);  /* CONFIDENTIAL */
  assert.equal(mayRead(manager, AUTHORITY_CLASS), true,
    "the building's manager cannot see the permit on their own building");
  assert.equal(manager.authority, false,
    "a customer was marked as an authority");
});

test("the off-ladder classes are off the ladder", () => {
  for (const cls of OFF_LADDER) {
    assert.equal(CLASS_RANK[cls], undefined, `${cls} became a rung, so climbing now reaches it`);
    assert.ok(ALL_CLASSES.includes(cls));
  }
});

/* ---------------------------------------------------------------- *
 * 3. JURISDICTION
 * ---------------------------------------------------------------- */

test("jurisdiction containment cannot be fooled by a prefix", () => {
  assert.equal(contains("KE/NAIROBI", "KE/NAIROBI"), true);
  assert.equal(contains("KE/NAIROBI", "KE/NAIROBI/WESTLANDS"), true);
  assert.equal(contains("KE", "KE/NAIROBI"), true);

  /* The separator is the whole point: KE/NAIRO is not a place. */
  assert.equal(contains("KE/NAIRO", "KE/NAIROBI"), false,
    "a mandate over a partial name reached a real jurisdiction");
  assert.equal(contains("KE/NAIROBI/WESTLANDS", "KE/NAIROBI"), false,
    "a district mandate reached the whole county");
  assert.equal(contains("", "KE/NAIROBI"), false, "an empty mandate reached everything");
  assert.equal(contains("KE/NAIROBI", ""), false);
});

test("a path is normalised so two spellings cannot mean two places", () => {
  assert.equal(normalisePath(["ke", "Nairobi"]), "KE/NAIROBI");
  assert.equal(normalisePath("ke/nairobi/"), "KE/NAIROBI");
  assert.equal(normalisePath(["KE", "", "NAIROBI"]), "KE/NAIROBI");
  /* Anything that is not a letter, digit or hyphen is dropped, so a path
     cannot be smuggled through with punctuation. */
  assert.equal(normalisePath(["KE", "NAIROBI/../MOMBASA"]), "KE/NAIROBIMOMBASA");
});

test("the search scope comes from the mandate, never from the request", () => {
  /*
   * A query parameter may make a search SMALLER. If `path` could widen it,
   * the whole jurisdiction model would be advisory.
   */
  const search = routes.slice(routes.indexOf('authorityRoutes.get("/authority/properties"'));
  assert.match(search.slice(0, 2600), /const paths = \[\.\.\.new Set\(mandates\.map/,
    "the search scope is no longer derived from the mandates");
  assert.match(search.slice(0, 2600), /scope = asked \? paths\.filter/,
    "an asked-for path no longer narrows within the mandate");
  assert.match(search.slice(0, 2600), /No mandate of this authority covers/,
    "asking outside the mandate no longer returns nothing");
});

test("a dataset the mandate does not name is refused, with the reason", () => {
  const a = { within: true, datasets: ["PERMITS", "ZONING"], jurisdiction: { path: "KE/NAIROBI" }, verified: true };
  assert.equal(mayDataset(a, "PERMITS"), true);
  assert.equal(mayDataset(a, "REGISTRATION"), false);
  assert.equal(mayDataset(null, "PERMITS"), false);
  assert.equal(mayDataset({ within: false, datasets: ["PERMITS"] }, "PERMITS"), false,
    "an out-of-jurisdiction mandate still granted its datasets");
  assert.match(whyNotDataset(a, "REGISTRATION", "this") || "", /REGISTRATION/);
});

/* ---------------------------------------------------------------- *
 * 4. VERIFICATION AND THE CROSS-TENANT READ
 * ---------------------------------------------------------------- */

test("an unverified authority holds no mandate", () => {
  assert.match(jurisdiction, /if \(!profile\.verified\)/,
    "an authority's mandates apply before PALTAS has verified the body");
  assert.match(routes, /if \(!profile\.verified\)[\s\S]{0,200}throw forbidden/,
    "the authority interface no longer checks verification");
});

test("the cross-tenant read is narrow, deliberate and cannot write", () => {
  /*
   * An authority resolving a property by site alone is the ONE legitimate
   * cross-tenant read in this service. Three things keep it safe, and all
   * three are asserted: it happens only for an authority profile, a mandate
   * that does not reach the property returns 404, and it never creates a row
   * inside somebody else's tenant.
   */
  assert.match(context, /const authorityProfile = await db\.authorityProfile\.findFirst/,
    "the cross-tenant branch is no longer gated on being an authority");
  assert.match(context, /if \(authorityProfile && !authority\?\.within\) throw hidden\(\);/,
    "an authority with no mandate here is no longer given a 404");
  assert.match(context, /const orgId = dna\.orgId;/,
    "records are no longer scoped to the property's own company");
  /* dnaFor() writes. It must be on the customer branch only. */
  const branch = context.slice(context.indexOf("const dna = authorityProfile"), context.indexOf("const orgId = dna.orgId"));
  assert.match(branch, /db\.propertyDna\.findFirst/, "the authority branch is gone");
  assert.ok(!/authorityProfile\s*\?\s*await dnaFor/.test(branch),
    "an authority glancing at a property creates a record in the owner's tenant");
});

/* ---------------------------------------------------------------- *
 * 5. FILING, ASKING, AND WHAT NEITHER GRANTS
 * ---------------------------------------------------------------- */

test("a company cannot file an official record against its own property", () => {
  const post = routes.slice(routes.indexOf('authorityRoutes.post("/properties/:siteId/authority"'));
  assert.match(post.slice(0, 1200), /if \(!clearance\.authority\)[\s\S]{0,300}throw forbidden/,
    "a company can now record its own permit and have it read as official");
  assert.match(post.slice(0, 1200), /if \(!authority\.mayWrite\)/,
    "a read-only mandate can write");
  assert.match(post.slice(0, 2400), /verification: "AUTHORITY_VERIFIED"/,
    "a filed record no longer says the authority verified it");
});

test("a request grants nothing, and a grant cannot exceed the ask", () => {
  const decide = handlerText(routes, "/authority/requests/:id/decide", "authorityRoutes");
  assert.match(decide, /const extra = granted\.filter\(\(d\) => !found\.datasets\.includes\(d\)\)/,
    "a company can grant a dataset the authority never asked for");
  assert.match(decide, /PARTIALLY_APPROVED/,
    "a partial grant is recorded as a full one");
  /*
   * THE DECISION BELONGS TO THE COMPANY, NOT THE AUTHORITY.
   *
   * The request is looked up scoped to the CALLER'S OWN organization, so an
   * authority cannot reach a request filed against somebody else's property
   * and approve it for itself.
   *
   * This matched the literal `orgId: req.actor.orgId` and broke when the
   * route read the actor through a helper. What matters is the pair: the
   * lookup is scoped by the caller's own org, and that org does not come
   * from the request.
   */
  assert.match(decide, /orgId:\s*(req\.)?actor(Of\([^)]*\))?\.orgId/,
    "an authority can decide its own request");
  assert.doesNotMatch(decide, /orgId:\s*(String\()?req\.(body|params|query)/,
    "the request is looked up by an organization the caller sent");

  const submit = handlerText(routes, '"/authority/requests"', "authorityRoutes");
  assert.match(submit, /status: "SUBMITTED"/,
    "a submitted request starts in a state that already grants something");
  assert.match(submit, /This grants no access/,
    "the response no longer says that asking is not receiving");
});

test("consent is one basis among several, not the only one", () => {
  /*
   * Modelling everything as consent would make the record dishonest: a
   * registry does not ask an owner's permission to hold a title.
   */
  const block = schema.slice(schema.indexOf("enum DataAccessBasis {"));
  const values = block.slice(0, block.indexOf("}")).split("\n")
    .map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l));
  assert.ok(values.includes("OWNER_CONSENT"));
  assert.ok(values.includes("LEGAL_AUTHORITY"));
  assert.ok(values.length >= 5, "the basis list collapsed toward consent only");
});

/* ---------------------------------------------------------------- *
 * 6. THE TRUST LAYER
 * ---------------------------------------------------------------- */

test("an authority saying so and PALTAS checking are different values", () => {
  const block = schema.slice(schema.indexOf("enum VerificationState {"));
  const values = block.slice(0, block.indexOf("}")).split("\n")
    .map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l));
  for (const v of ["AUTHORITY_VERIFIED", "VERIFIED", "USER_PROVIDED", "IMPORTED", "DISPUTED", "EXPIRED"]) {
    assert.ok(values.includes(v), `VerificationState lost ${v}`);
  }
  assert.notEqual(values.indexOf("AUTHORITY_VERIFIED"), values.indexOf("VERIFIED"),
    "authority-verified and PALTAS-verified collapsed into one value");

  const p = schema.slice(schema.indexOf("enum Provenance {"));
  const provs = p.slice(0, p.indexOf("}")).split("\n").map((l) => l.trim());
  for (const v of ["GOVERNMENT", "LAND_REGISTRY", "PLANNING_AUTHORITY", "OWNER_SUPPLIED", "AI_SCAN"]) {
    assert.ok(provs.includes(v), `Provenance lost ${v}`);
  }
});

test("land is not a property, and neither is single", () => {
  /*
   * One parcel can carry several buildings and one development can span
   * several parcels. A column on either side would have said otherwise.
   */
  assert.match(schema, /model PropertyParcel \{/, "the parcel-to-property join is gone");
  assert.match(schema, /model PropertyParcel \{[\s\S]*?@@unique\(\[parcelId, siteId\]\)/,
    "the same parcel can be linked to the same property twice");
  /*
   * Bounded to the Site block. `[\s\S]*?` is lazy but unbounded — it will run
   * past the closing brace until it finds the text somewhere else in the
   * file, and `parcelId String` legitimately exists on PropertyParcel. The
   * regex matched a model three hundred lines away and called it a failure.
   */
  const siteBlock = schema.slice(schema.indexOf("model Site {"));
  const site = siteBlock.slice(0, siteBlock.indexOf("\n}"));
  assert.ok(!/parcelId\s+String/.test(site),
    "a property carries a single parcel id, which says one parcel is one property");
  assert.match(schema, /model Parcel \{[\s\S]*?fromParcelIds/,
    "subdivision and consolidation are no longer recordable");
});

test("an authority read is audited in the property's own tenant", () => {
  /*
   * "Who looked at my building" is a question the building's owner has to be
   * able to answer. An audit row filed in the authority's organization would
   * be invisible to them.
   */
  assert.match(context, /orgId: orgId \|\| req\.actor\.orgId/,
    "the audit writer no longer accepts the property's tenant");
  assert.match(routes, /"authority\.records\.read"/, "reading official records is not audited");
  assert.match(routes, /"authority\.search"/, "an authority's search is not audited");
  assert.match(routes, /"authority\.request\.decide"/, "the decision on a request is not audited");
});
