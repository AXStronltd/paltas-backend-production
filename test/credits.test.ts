/* ======================================================================
 * TWO ACTS PEOPLE SAY IN THE SAME BREATH.
 *
 * A credit note says the bill was wrong, or is waived — nothing leaves the
 * bank, and what changes is how much somebody owes. A refund is money going
 * back out; what they owe does not change, because they paid and have now
 * been paid back, and the invoice is owed again.
 *
 * Folding either into the other is the classic property-ledger mistake. A
 * credit note counted as a payment reports cash that never arrived. A refund
 * counted as a credit note hides real money leaving the building.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  owedOn, refundableOn, whyNotCreditable, whyNotRefundable,
} from "../src/domain/credits.ts";

const inv = (o: Partial<Parameters<typeof owedOn>[0]> = {}) => ({
  total: 100_000n, paid: 0n, credited: 0n, status: "SENT", currency: "KES", ...o,
});
const pay = (o: Partial<Parameters<typeof refundableOn>[0]> = {}) => ({
  amount: 100_000n, voided: false, currency: "KES", refunded: 0n, ...o,
});

test("owed is what was billed, less cash in, less what was waived", () => {
  assert.equal(owedOn(inv({ paid: 30_000n, credited: 20_000n })), 50_000n);
});

test("owed never goes negative", () => {
  /* An overpaid invoice owes nothing. It does not owe minus five thousand,
     and a caller comparing against that would allow a credit note that makes
     the arithmetic worse. */
  assert.equal(owedOn(inv({ paid: 150_000n })), 0n);
});

test("a credit note may not exceed what is still owed", () => {
  assert.equal(whyNotCreditable(inv(), 100_000), null);
  assert.match(String(whyNotCreditable(inv(), 100_001)), /more than is owed/);
  assert.match(String(whyNotCreditable(inv({ paid: 60_000n }), 50_000)), /more than is owed/);
});

test("a paid invoice is refunded, not credited", () => {
  /*
   * The distinction the whole file turns on. Crediting a settled invoice does
   * not owe the customer anything — it just makes the invoice nonsense. If
   * the bill was wrong and they have paid, the money goes back.
   */
  const why = whyNotCreditable(inv({ paid: 100_000n }), 10_000);
  assert.match(String(why), /refund/i, "it must say what to do instead");
});

test("a draft or void invoice cannot be credited", () => {
  assert.match(String(whyNotCreditable(inv({ status: "DRAFT" }), 10_000)), /not been issued/);
  assert.match(String(whyNotCreditable(inv({ status: "VOID" }), 10_000)), /void/i);
});

test("a credit note is a positive whole number", () => {
  for (const bad of [0, -5_000, 1.5, NaN, Infinity]) {
    assert.ok(whyNotCreditable(inv(), bad), `${bad} was accepted`);
  }
});

test("a refund may not exceed what actually arrived", () => {
  assert.equal(whyNotRefundable(pay(), 100_000), null);
  assert.match(String(whyNotRefundable(pay(), 100_001)), /more than was received/);
  assert.match(String(whyNotRefundable(pay({ refunded: 70_000n }), 40_000)), /more than was received/);
});

test("what is left to refund counts what has already gone back", () => {
  assert.equal(refundableOn(pay({ refunded: 70_000n })), 30_000n);
  assert.equal(refundableOn(pay({ refunded: 100_000n })), 0n);
});

test("a voided payment cannot be refunded — the company never kept it", () => {
  assert.match(String(whyNotRefundable(pay({ voided: true }), 10_000)), /voided/i);
  assert.equal(refundableOn(pay({ voided: true })), 0n);
});

test("a refund cannot itself be refunded", () => {
  /* Sending the money out twice, on the strength of one arrival. */
  assert.match(String(whyNotRefundable(pay({ amount: -50_000n }), 10_000)), /already a refund/i);
});

test("the two ceilings are genuinely different numbers", () => {
  /*
   * Half paid. 50,000 may be credited — the unpaid half — and 50,000 may be
   * refunded, the half that arrived. Using one ceiling for both would let a
   * company give back money it never took.
   */
  const i = inv({ paid: 50_000n });
  const p = pay({ amount: 50_000n });
  assert.equal(owedOn(i), 50_000n);
  assert.equal(refundableOn(p), 50_000n);
  assert.ok(whyNotCreditable(i, 60_000), "credited past what is owed");
  assert.ok(whyNotRefundable(p, 60_000), "refunded past what arrived");
});
