/* ======================================================================
 * WHAT MAKES A RECEIPT TRUE.
 *
 * The standard says official receipts may only be generated from confirmed
 * payments. This service has no PaymentStatus column, deliberately — its own
 * comment says a card payment is confirmed by the processor and a cash
 * receipt by the person who took it, while reconciledAt answers whether
 * anybody has seen the money on a statement.
 *
 * So "confirmed" is three tests, not one. Requiring reconciliation would
 * refuse a receipt for every cash and M-Pesa payment a property company
 * takes; requiring nothing would print "received with thanks" for money that
 * may never have arrived. These tests pin the line between the two.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";

import { basisFor, whyNotReceiptable, BASIS_WORDS } from "../src/domain/receipts.ts";

type P = Parameters<typeof basisFor>[0];

function payment(over: Partial<P> = {}): P {
  return {
    amount: 50_000n, method: "CASH", reference: "", providerRef: "",
    receivedBy: "A Person", reconciledAt: null, voided: false, ...over,
  };
}

test("a bank statement outranks everything else", () => {
  /* A reconciled card payment is reported as reconciled, not as
     provider-confirmed — the better evidence is the one to name. */
  assert.equal(basisFor(payment({
    method: "CARD", providerRef: "pi_123", reconciledAt: new Date(),
  })), "BANK_RECONCILED");
});

test("a provider's own identifier confirms a card or an M-Pesa payment", () => {
  assert.equal(basisFor(payment({ method: "CARD", providerRef: "pi_123" })), "PROVIDER_CONFIRMED");
  assert.equal(basisFor(payment({ method: "MPESA", reference: "QGR7TY12XZ" })), "PROVIDER_CONFIRMED");
});

test("a number typed off a slip is not a provider's word", () => {
  /*
   * `reference` holds an M-Pesa code on one row and whatever somebody wrote
   * on the cheque stub on the next. Treating both as confirmation would make
   * a receipt issuable for a cheque nobody has banked.
   */
  assert.equal(basisFor(payment({ method: "CHEQUE", reference: "004521" })), null);
  assert.equal(basisFor(payment({ method: "BANK", reference: "FT26091234" })), null);
});

test("cash is confirmed by the person who took it, and says so", () => {
  assert.equal(basisFor(payment({ method: "CASH" })), "TAKEN_IN_PERSON");
  assert.match(BASIS_WORDS.TAKEN_IN_PERSON, /in person/i);
});

test("an unbanked transfer is refused, and told what would fix it", () => {
  const why = whyNotReceiptable(payment({ method: "BANK", reference: "FT26091234" }));
  assert.ok(why, "an unconfirmed transfer must not be receiptable");
  assert.match(String(why), /reconcile/i,
    "the refusal must name the thing that would make it issuable");
});

test("a voided payment can never be receipted", () => {
  /* Even cash, which would otherwise pass — the company has said it did not
     keep this money, and a receipt would contradict its own books. */
  const why = whyNotReceiptable(payment({ voided: true }));
  assert.match(String(why), /voided/i);
});

test("a refund is not a receipt", () => {
  const why = whyNotReceiptable(payment({ amount: -50_000n }));
  assert.match(String(why), /refund/i);
});

test("every basis has words for the document", () => {
  for (const basis of ["BANK_RECONCILED", "PROVIDER_CONFIRMED", "TAKEN_IN_PERSON"] as const) {
    assert.ok(BASIS_WORDS[basis], `${basis} would print blank on the receipt`);
  }
});
