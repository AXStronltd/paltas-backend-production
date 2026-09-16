/* ====================================================================== *
 * ONE SET OF ROLES, SAID THE SAME WAY IN THREE PLACES.
 *
 * A role is defined three times in this system, and all three have to agree or
 * somebody is locked out of their own company:
 *
 *   prisma/schema.prisma   enum Role   — what may be STORED on a membership
 *   src/domain/access.js   ROLE_AREAS  — what the server ENFORCES
 *   assets/console.js      ROLES       — what a person SEES and picks from
 *
 * Drift between them is silent and asymmetric:
 *
 *   in the console but not the enum  -> the invite is accepted by the form and
 *                                       rejected by the database
 *   in the enum but not access.js    -> levelFor() finds nothing and the person
 *                                       can reach nothing, with no error
 *   in access.js but not the console -> a real role nobody can be given
 *
 * And the display names matter as much as the keys, because staff are invited
 * BY THE NAME: "an email invitation carrying the role you choose".
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { ROLE_AREAS, AREAS, LEVELS } from "../src/domain/access.js";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const CONSOLE = join(FE, "assets/console.js");
const skipFE = existsSync(CONSOLE) ? undefined : `no frontend at ${FE}`;

/** The enum, read from the schema rather than restated here. */
function schemaRoles() {
  const src = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("enum Role {"));
  const body = block.slice(block.indexOf("{") + 1, block.indexOf("}"));
  return body
    .split("\n")
    .map((l) => l.replace(/\/\/.*/, "").replace(/\/\*[\s\S]*?\*\//g, "").trim())
    .filter((l) => /^[A-Z][A-Z_]*$/.test(l));
}

/** The console's table, read the same way — one source, not a copy. */
function consoleRoles() {
  const src = readFileSync(CONSOLE, "utf8");
  const start = src.indexOf("  var ROLES = {");
  let depth = 1, i = start + "  var ROLES = {".length;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  const block = src.slice(start, i);
  const out = {};
  for (const m of block.matchAll(/key:\s*"([A-Z_]+)",\s*name:\s*"([^"]+)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

test("the database and the server agree on which roles exist", () => {
  const db = schemaRoles().sort();
  const code = Object.keys(ROLE_AREAS).sort();

  assert.ok(db.length >= 15, `only ${db.length} roles parsed from the schema — check the parser`);
  assert.deepEqual(code, db,
    "a role the server enforces cannot be stored, or a stored role has no permissions");
});

test("every role names a real level in every real area", () => {
  for (const [role, areas] of Object.entries(ROLE_AREAS)) {
    for (const [area, level] of Object.entries(areas)) {
      assert.ok(AREAS.includes(area),
        `${role} grants "${area}", which is not one of the ${AREAS.length} areas`);
      assert.ok(LEVELS.includes(level),
        `${role} grants "${level}" on ${area}, which is not a level`);
    }
    for (const area of AREAS) {
      assert.ok(area in areas,
        `${role} says nothing about "${area}" — levelFor() would find undefined`);
    }
  }
});

test("only the two company-wide roles hold everything", () => {
  /*
   * A guard against the quiet widening of a role. If a specialist ever ends up
   * with "manage" across the board, this says so before a customer does.
   */
  const total = Object.entries(ROLE_AREAS)
    .filter(([, a]) => AREAS.every((x) => a[x] === "manage"))
    .map(([r]) => r)
    .sort();
  assert.deepEqual(total, ["MANAGER", "OWNER"],
    "a role other than OWNER/MANAGER now manages every area of the business");
});

test("a guard can record but never erase", () => {
  /*
   * Named explicitly because it is the one whose reasoning is easiest to lose:
   * a guard who can delete a visit can delete the record of who they waved
   * through, and the log stops being evidence.
   */
  assert.equal(ROLE_AREAS.GUARD.security, "write",
    "a guard may log visits and incidents, never delete them");
  assert.equal(ROLE_AREAS.GUARD.finance, "none");
});

test("a guest is not staff", () => {
  for (const area of AREAS) {
    assert.equal(ROLE_AREAS.GUEST[area], "none",
      `GUEST reaches ${area} — the guest portal reads a guest's own stay, nothing else`);
  }
});

test("the console offers exactly the roles the server knows", { skip: skipFE }, () => {
  const shown = Object.keys(consoleRoles()).sort();
  const known = Object.keys(ROLE_AREAS).sort();
  assert.deepEqual(shown, known,
    "the console offers a role the server does not know, or hides one it does");
});

test("no two roles are shown by the same name", { skip: skipFE }, () => {
  /*
   * THE BUG THIS EXISTS FOR.
   *
   * OWNER and HOST were both displayed as "Owner", and they are not close:
   * OWNER holds the whole company with admin: true, HOST is one person pinned
   * to Agent & Host with no finance and no security. Staff are invited by the
   * displayed name, so the picker offered the dangerous choice and the narrow
   * one under one word — and choosing wrong either hands over the business or
   * locks somebody out of it.
   */
  const names = consoleRoles();
  const byName = {};
  for (const [key, name] of Object.entries(names)) {
    (byName[name] = byName[name] || []).push(key);
  }
  const clashes = Object.entries(byName).filter(([, keys]) => keys.length > 1);
  assert.deepEqual(clashes, [],
    "two roles share one label, so an invitation cannot tell them apart: " +
    clashes.map(([n, k]) => `${n} = ${k.join(" + ")}`).join(", "));
});

test("every role has a name a person could read", { skip: skipFE }, () => {
  for (const [key, name] of Object.entries(consoleRoles())) {
    assert.ok(name && name.trim().length > 1, `${key} has no display name`);
    assert.ok(!/^[A-Z_]+$/.test(name),
      `${key} is shown as the raw enum "${name}" rather than words`);
  }
});

test("PALTAS's own staff roles are marked as PALTAS's", { skip: skipFE }, () => {
  /*
   * MARKETING, COMPLIANCE and PUBLISHER are platform staff, not a customer's
   * employees. A customer admin scrolling a role list must not be able to
   * mistake one for a job at their own company.
   */
  const names = consoleRoles();
  for (const key of ["MARKETING", "COMPLIANCE", "PUBLISHER"]) {
    assert.match(names[key], /^PALTAS /,
      `${key} reads as a customer's own role; it is PALTAS staff`);
  }
});
