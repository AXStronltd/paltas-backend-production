/* ====================================================================== *
 * GIVING MONEY BACK, AND WRITING IT OFF.
 *
 * Two different acts that people say in the same breath, and the difference
 * is whether anything moves.
 *
 *   A CREDIT NOTE says the bill was wrong, or is being waived. Nothing
 *   leaves the bank. What changes is how much somebody owes.
 *
 *   A REFUND is money going back out. What somebody owes does not change —
 *   they paid, and now they have been paid back, and the invoice returns to
 *   being owed.
 *
 * Folding either into the other is the classic property-ledger mistake. A
 * credit note recorded as a payment reports cash that never arrived, so the
 * collections screen lies and the rent roll shows a month collected that was
 * in fact written off. A refund recorded as a credit note hides real money
 * leaving the building.
 *
 * ── THE TWO CEILINGS ───────────────────────────────────────────────────
 *
 * Neither act may exceed what it is undoing, and the two ceilings are not the
 * same number.
 *
 * You cannot credit more than is still owed — crediting a paid invoice does
 * not owe the customer anything, it just makes the invoice nonsense. If they
 * have paid and the bill was wrong, the money goes back: that is a refund.
 *
 * You cannot refund more than actually arrived against that payment. Refunding
 * an invoice's full value when half of it was paid sends out money the company
 * never took.
 * ====================================================================== */

import { badRequest } from "../http/errors.ts";

export interface InvoiceForCredit {
  readonly total: bigint;
  readonly paid: bigint;
  readonly credited: bigint;
  readonly status: string;
  readonly currency: string;
}

/** What is still owed: what was billed, less cash in, less what was waived. */
export function owedOn(inv: InvoiceForCredit): bigint {
  const owed = inv.total - inv.paid - inv.credited;
  /* Never negative. An overpaid invoice owes nothing; it does not owe minus
     five thousand, and a caller comparing against that would allow a credit
     note that makes the arithmetic worse. */
  return owed > 0n ? owed : 0n;
}

/**
 * Why this invoice cannot take a credit note of this size — or null.
 *
 * Amount arrives as a number from a request body and is checked here rather
 * than at the boundary, because "a whole number of minor units" and "not more
 * than is owed" are the same question asked twice otherwise.
 */
export function whyNotCreditable(inv: InvoiceForCredit, amount: number): string | null {
  if (!Number.isFinite(amount) || Math.round(amount) !== amount || amount <= 0) {
    return "A credit note is a whole number of minor units, and more than zero. "
         + "To give money back that has already been paid, refund the payment instead.";
  }
  if (inv.status === "VOID") {
    return "That invoice is void, so there is nothing left to credit. A void "
         + "invoice is already owed by nobody.";
  }
  if (inv.status === "DRAFT") {
    return "That invoice has not been issued yet. Change the draft rather than "
         + "crediting something nobody has been asked to pay.";
  }
  const owed = owedOn(inv);
  if (owed <= 0n) {
    return "Nothing is owed on that invoice, so a credit note would change "
         + "nothing. If the money should go back, refund the payment.";
  }
  if (BigInt(amount) > owed) {
    return `That is more than is owed. ${owed} is outstanding, after what has `
         + `been paid and already credited.`;
  }
  return null;
}

export function requireCreditable(inv: InvoiceForCredit, amount: number): bigint {
  const why = whyNotCreditable(inv, amount);
  if (why) throw badRequest(why);
  return BigInt(amount);
}

export interface PaymentForRefund {
  readonly amount: bigint;
  readonly voided: boolean;
  readonly currency: string;
  /** What has already been sent back against this payment, as a positive. */
  readonly refunded: bigint;
}

/** What is left of this payment to give back. */
export function refundableOn(p: PaymentForRefund): bigint {
  if (p.voided || p.amount <= 0n) return 0n;
  const left = p.amount - p.refunded;
  return left > 0n ? left : 0n;
}

/** Why this payment cannot be refunded by this much — or null. */
export function whyNotRefundable(p: PaymentForRefund, amount: number): string | null {
  if (!Number.isFinite(amount) || Math.round(amount) !== amount || amount <= 0) {
    return "A refund is a whole number of minor units, and more than zero.";
  }
  if (p.voided) {
    return "That payment was voided, so the company never kept the money. "
         + "There is nothing to send back.";
  }
  if (p.amount <= 0n) {
    return "That is already a refund. Refunding a refund would send the money "
         + "out twice.";
  }
  const left = refundableOn(p);
  if (left <= 0n) {
    return "That payment has already been refunded in full.";
  }
  if (BigInt(amount) > left) {
    return `That is more than was received. ${left} of that payment is left to `
         + `refund, after what has already gone back.`;
  }
  return null;
}

export function requireRefundable(p: PaymentForRefund, amount: number): bigint {
  const why = whyNotRefundable(p, amount);
  if (why) throw badRequest(why);
  return BigInt(amount);
}
