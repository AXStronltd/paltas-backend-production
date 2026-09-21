/* ====================================================================== *
 * WHAT A REQUEST BODY IS ALLOWED TO BECOME.
 *
 * Every create and every update in the product API goes through clean().
 * It is the last thing between a hand-written JSON body and the database,
 * and the three failures it prevents are each the kind that is discovered
 * by a customer rather than by a developer:
 *
 *   - a field that is not declared reaching a column          (orgId, total)
 *   - an amount of money that is not an integer               (1500.004)
 *   - a required field arriving empty and being stored blank
 *
 * These run without a database, which is the point of clean() living in
 * domain/ rather than in http/.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { clean } from "../src/domain/input.js";
import { RESOURCES } from "../src/domain/registry.js";

const INVOICE = RESOURCES.invoices;
const PAYMENT = RESOURCES.payments;
const VISIT = RESOURCES.visits;
const SITE = RESOURCES.sites;

/* ================================================================ */

test("a field nobody declared cannot be written, however it is sent", () => {
  /*
   * THE ONE THAT MATTERS MOST. `orgId` in a body is the whole tenancy rule
   * in one line: if it could be written, a customer could file their
   * invoice under another company by sending one extra key.
   */
  const out = clean(INVOICE, {
    note: "Fine",
    orgId: "some-other-company",
    total: 999999,
    paid: 999999,
    ref: "INV-0001",
    id: "chosen-by-me",
    createdAt: "2020-01-01",
  }, { partial: true });

  assert.deepEqual(out, { note: "Fine" });
  for (const k of ["orgId", "total", "paid", "ref", "id", "createdAt"]) {
    assert.ok(!(k in out), `${k} survived clean()`);
  }
});

test("money is a whole number of minor units, and never negative", () => {
  assert.deepEqual(clean(PAYMENT, { amount: 150000 }, { partial: true }), { amount: 150000 });

  /* A float is rounded rather than refused: a browser that computed
     1500 * 100 in floating point can genuinely produce 149999.99999999997,
     and refusing that would be refusing a correct payment. */
  assert.deepEqual(clean(PAYMENT, { amount: 149999.99999999997 }, { partial: true }), { amount: 150000 });

  assert.throws(() => clean(PAYMENT, { amount: "lots" }, { partial: true }), /must be a number/);
  assert.throws(() => clean(PAYMENT, { amount: 1e30 }, { partial: true }), /too large/);

  /* Negative money on a resource is always a bug or an attempt. The one
     legitimate negative — a refund — is a payment with its own endpoint
     and its own sign, and a folio line, which is not cleaned here. */
  assert.throws(() => clean(RESOURCES.leases, { rent: -1 }, { partial: true }), /cannot be negative/);
  assert.throws(() => clean(RESOURCES.expenses, { amount: -500 }, { partial: true }), /cannot be negative/);
});

test("a required field that is missing or blank is refused, by name", () => {
  assert.throws(() => clean(VISIT, {}, { partial: false }), /visitor is required/);
  assert.throws(() => clean(VISIT, { visitor: "   " }, { partial: false }), /visitor is required/);

  /* And a partial update does not demand them — that is what PATCH means. */
  assert.deepEqual(clean(VISIT, { purpose: "Delivery" }, { partial: true }), { purpose: "Delivery" });
});

test("an error names every problem, not only the first", () => {
  /* A form that reveals one mistake at a time is a form people fill in five
     times. The message is the first; `details` is all of them. */
  try {
    clean(RESOURCES.deals, { value: "x", fee: "y" }, { partial: true });
    assert.fail("should have thrown");
  } catch (e) {
    assert.equal(e.status, 400);
    assert.ok(Array.isArray(e.details) && e.details.length === 2, "only one problem reported");
  }
});

test("null clears a field; undefined leaves it alone", () => {
  /*
   * The distinction the whole PATCH semantics rests on. Without it there is
   * no way to empty a date — sending "" would be a bad date and sending
   * nothing would change nothing.
   */
  assert.deepEqual(clean(RESOURCES.leases, { endsOn: null }, { partial: true }), { endsOn: null });
  assert.deepEqual(clean(RESOURCES.leases, { endsOn: undefined }, { partial: true }), {});
  assert.deepEqual(clean(RESOURCES.leases, { endsOn: "" }, { partial: true }), { endsOn: null });
});

test("a date that is not a date is refused rather than stored as an epoch", () => {
  assert.throws(() => clean(RESOURCES.leases, { startsOn: "next tuesday" }, { partial: true }),
    /startsOn is not a date/);
  const out = clean(RESOURCES.leases, { startsOn: "2026-03-01" }, { partial: true });
  assert.ok(out.startsOn instanceof Date);
  assert.equal(out.startsOn.toISOString().slice(0, 10), "2026-03-01");
});

test("an enum is normalised, so a form's wording still saves", () => {
  /* "checked in" and "CHECKED_IN" are the same thing to a person. The
     database only accepts one of them, and turning the other into a 500
     helps nobody. */
  assert.equal(clean(RESOURCES.reservations, { status: "checked in" }, { partial: true }).status, "CHECKED_IN");
  assert.equal(clean(RESOURCES.reservations, { status: "checked-in" }, { partial: true }).status, "CHECKED_IN");
  assert.equal(clean(VISIT, { status: "approved" }, { partial: true }).status, "APPROVED");
});

test("text has a ceiling, and the ceiling says what it is", () => {
  assert.throws(() => clean(SITE, { name: "x".repeat(400) }, { partial: true }), /longer than 300/);
  assert.throws(() => clean(SITE, { note: "x".repeat(5000) }, { partial: true }), /longer than 4000/);
  /* A long note is fine — that is what a note is for. */
  assert.ok(clean(SITE, { note: "x".repeat(3999) }, { partial: true }).note.length === 3999);
});

test("an empty id clears the link rather than storing an empty string", () => {
  /*
   * `unitId: ""` from a cleared <select> would otherwise be written as the
   * empty string, which is not null and not a real id — so the foreign key
   * rejects it and the customer sees a 500 for clearing a dropdown.
   */
  assert.deepEqual(clean(RESOURCES.leases, { unitId: "" }, { partial: true }), { unitId: null });
  assert.deepEqual(clean(RESOURCES.leases, { unitId: "u_1" }, { partial: true }), { unitId: "u_1" });
});

test("a body that is not an object is a bad request, not a crash", () => {
  for (const body of [null, undefined, "a string", 42, []]) {
    assert.throws(() => clean(VISIT, body, { partial: false }), /required/,
      `clean() did not handle ${JSON.stringify(body)}`);
    assert.deepEqual(clean(VISIT, body, { partial: true }), {});
  }
});

test("every resource can be created from its own required fields alone", () => {
  /*
   * A sweep rather than a case: if a declaration ever requires a field whose
   * kind cannot accept a plain string, every create against that resource
   * fails and no single test would have named it.
   */
  for (const [slug, r] of Object.entries(RESOURCES)) {
    const body = {};
    for (const key of r.required || []) {
      const kind = r.fields[key];
      assert.ok(kind, `${slug} requires "${key}", which it does not declare as a field`);
      body[key] = kind === "int" || kind === "money" || kind === "float" ? 1
                : kind === "bool" ? true
                : kind === "date" ? "2026-01-01"
                : "Something";
    }
    const out = clean(r, body, { partial: false });
    for (const key of r.required || []) {
      assert.ok(out[key] !== undefined && out[key] !== null && out[key] !== "",
        `${slug}: "${key}" is required but did not survive clean()`);
    }
  }
});

test("an enum value the schema does not have is refused, not a 500", () => {
  /*
   * THE BUG THIS EXISTS TO PREVENT, FOUND DURING THE PRE-CLIENT AUDIT.
   *
   * clean() normalised the spelling of an enum — "Needs work" to NEEDS_WORK —
   * and then passed ANYTHING through. A value the enum does not hold reached
   * Prisma, Prisma threw, and the caller was told "Something went wrong at
   * our end. Quote reference …" — a 500, for a word they had typed.
   *
   * POST /payouts with status "PAID" did exactly that: PayoutStatus has SENT,
   * not PAID. The person who typed it is told the system is broken, and the
   * error log fills with faults that are not faults.
   *
   * It is their input, so it is a 400, and it names what is allowed.
   */
  const r = { fields: { status: "enum:PayoutStatus" }, required: [] };

  assert.throws(
    () => clean(r, { status: "PAID" }, { partial: true }),
    (e) => e.status === 400 && /has to be one of/.test(e.message) && /SENT/.test(e.message),
    "an invented enum value was accepted, and will 500 at the database"
  );

  /* The spellings a console sends must still work — this is a guard, not a
     new rule about how people write things. */
  assert.deepEqual(clean(r, { status: "Sent" }, { partial: true }), { status: "SENT" });
  assert.deepEqual(clean(r, { status: "SENT" }, { partial: true }), { status: "SENT" });

  /* And a document kind, because the same branch serves every enum. */
  const d = { fields: { kind: "enum:DocumentKind" }, required: [] };
  assert.deepEqual(clean(d, { kind: "Ownership" }, { partial: true }), { kind: "OWNERSHIP" });
  assert.throws(() => clean(d, { kind: "MAGIC" }, { partial: true }), /has to be one of/);

  /* An enum this cannot resolve is left alone rather than refused: a missing
     generated client must not start rejecting values that are in fact valid. */
  const unknown = { fields: { state: "enum:NotAnEnumAnywhere" }, required: [] };
  assert.deepEqual(clean(unknown, { state: "anything" }, { partial: true }), { state: "ANYTHING" });
});
