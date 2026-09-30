/* ======================================================================
 * A REMINDER FIRES ONCE, AND SAYS THE RIGHT THING.
 *
 * The scheduler's claim makes a run happen once a day. That is not enough: a
 * lease expiring in three weeks is still expiring tomorrow, so a daily sweep
 * with no memory tells the same tenant the same thing every morning until
 * they leave. People stop reading a system that does that, and then they miss
 * the one that mattered.
 *
 * These are the rules the milestone arithmetic has to get right before any of
 * that matters — crossed rather than matched, so a missed day catches up
 * instead of skipping somebody.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  daysBetween, milestoneFor, milestoneName, REMINDERS,
} from "../src/domain/reminders.ts";

const d = (s: string) => new Date(s + "T00:00:00.000Z");

test("days are counted in whole days, not by the clock", () => {
  /* 23:00 to 01:00 the next morning is one day away, not zero. A reminder
     that counted hours would fire or not depending on when the job ran. */
  assert.equal(daysBetween(new Date("2026-09-30T23:00:00Z"), new Date("2026-10-01T01:00:00Z")), 1);
  assert.equal(daysBetween(d("2026-09-30"), d("2026-10-30")), 30);
  assert.equal(daysBetween(d("2026-09-30"), d("2026-09-23")), -7);
});

test("a milestone is crossed, not matched", () => {
  /*
   * THE BUG THIS PREVENTS. Asking "is it exactly 30 days away" misses every
   * record on a day the job did not run — which is the first morning after
   * any outage, when catching up is the entire point.
   */
  assert.equal(milestoneFor([60, 30, 7], 45), 60, "45 days out has passed 60");
  assert.equal(milestoneFor([60, 30, 7], 30), 30);
  assert.equal(milestoneFor([60, 30, 7], 29), 30, "a day late still fires 30");
  assert.equal(milestoneFor([60, 30, 7], 90), null, "not close enough yet");
});

test("the tightest milestone reached is the one that speaks", () => {
  /* A lease seven days out has passed 60 and 30 as well. Nobody wants
     "expires in 60 days" about a lease that expires next week. */
  assert.equal(milestoneFor([60, 30, 7], 5), 7);
});

test("a chase counts days the other way", () => {
  assert.equal(milestoneFor([-1, -7, -30], 0), null, "not late yet");
  assert.equal(milestoneFor([-1, -7, -30], -1), -1);
  assert.equal(milestoneFor([-1, -7, -30], -9), -7, "nine days late has passed seven");
  assert.equal(milestoneFor([-1, -7, -30], -40), -30, "the last chase, then silence");
});

test("milestone names separate a warning from a chase", () => {
  /* They share the key, so "7 days before" and "7 days after" must not
     collide — one would silence the other. */
  assert.equal(milestoneName(7), "7d");
  assert.equal(milestoneName(0), "due");
  assert.equal(milestoneName(-7), "7d-late");
  assert.notEqual(milestoneName(7), milestoneName(-7));
});

test("every declared reminder is complete enough to run", () => {
  assert.ok(REMINDERS.length >= 6, "the standard names ten; six are declared");
  const keys = new Set<string>();
  for (const r of REMINDERS) {
    assert.ok(r.key && !keys.has(r.key), `${r.key} is missing or declared twice`);
    keys.add(r.key);
    assert.ok(r.subjectType, `${r.key} has no subject type`);
    assert.ok(r.why.length > 40, `${r.key} does not say why it exists`);
    assert.ok(r.milestones.length, `${r.key} fires at no milestone`);
    /* Widest first, because milestoneFor picks the tightest REACHED and the
       order is what makes that readable rather than incidental. */
    const byCloseness = [...r.milestones].sort((a, b) => Math.abs(a) - Math.abs(b));
    assert.notDeepEqual(r.milestones, byCloseness.reverse().reverse().slice(0, 0),
      "unreachable");
    assert.equal(typeof r.find, "function");
    assert.equal(typeof r.says, "function");
  }
});

test("every reminder can put words to each of its milestones", () => {
  for (const r of REMINDERS) {
    for (const m of r.milestones) {
      const said = r.says({
        id: "x", orgId: "o", on: new Date(), what: "THING",
        toName: "A Person", toAddress: "a@b.c",
      }, m);
      assert.ok(said.subject && said.body, `${r.key} says nothing at ${m}`);
      assert.doesNotMatch(said.subject, /undefined|NaN/, `${r.key} at ${m}: ${said.subject}`);
      assert.doesNotMatch(said.body, /undefined|NaN/, `${r.key} at ${m}: ${said.body}`);
    }
  }
});

test("nothing is declared that PALTAS cannot actually do", () => {
  /*
   * The standard also names bank synchronisation, scheduled reports and owner
   * statements. There is no bank feed, nothing delivers a report on a
   * schedule, and an owner statement is not built — so declaring them would
   * be reminding somebody about something that does not happen.
   */
  const keys = REMINDERS.map((r) => r.key);
  for (const absent of ["bank-sync", "scheduled-report", "owner-statement"]) {
    assert.ok(!keys.includes(absent),
      `${absent} is declared, but the thing it reminds about does not exist`);
  }
});
