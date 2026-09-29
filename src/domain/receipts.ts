/* ====================================================================== *
 * PROOF THAT MONEY WAS RECEIVED.
 *
 * ── WHY THIS IS NOT A VIEW OF A PAYMENT ───────────────────────────────
 *
 * The payment history screen offers "download receipt" and "send receipt",
 * and neither had anything behind it. The obvious fix — render a Payment on
 * demand — is wrong, and the reason is the whole of this file.
 *
 * A payment is the company's own record. It gets corrected: a reference is
 * retyped, a party is renamed, an invoice is re-pointed. A receipt is a
 * document somebody OUTSIDE the company is holding, and what it said when
 * they got it must still be what it says when they bring it back. Rendering
 * it live means the customer's copy and the company's copy quietly disagree,
 * and the company's version always wins an argument it should not be in.
 *
 * So a receipt copies every field it prints, at issue, and nothing edits one
 * afterwards.
 *
 * ── WHAT "CONFIRMED" MEANS, GIVEN THIS SERVICE'S OWN MODEL ────────────
 *
 * The standard says official receipts may only come from confirmed payments.
 * Payment has no status enum, deliberately, and its comment says why:
 *
 *     "a card payment is confirmed by the processor and a cash receipt by
 *      the person who took it"
 *
 * while `reconciledAt` answers a different question — whether anybody has
 * seen this money arrive on a statement.
 *
 * So requiring reconciliation would refuse a receipt for every cash and
 * M-Pesa payment a property company takes, which is most of them, and would
 * contradict the model's own reasoning. Requiring nothing would print
 * "received with thanks" for money that may never have existed.
 *
 * The answer is that confirmation is three tests, not one, and the receipt
 * says which one it stands on rather than implying the strongest.
 * ====================================================================== */

import type { $Enums } from "@prisma/client";
import { badRequest } from "../http/errors.ts";

/** The payment fields this file needs. Narrow on purpose. */
export interface ConfirmablePayment {
  readonly amount: bigint;
  readonly method: $Enums.PaymentMethod;
  readonly reference: string;
  readonly providerRef: string;
  readonly receivedBy: string;
  readonly reconciledAt: Date | null;
  readonly voided: boolean;
}

/**
 * What a receipt for this payment would rest on, or null if nothing.
 *
 * Strongest first, and it stops at the first that holds — a reconciled card
 * payment is reported as BANK_RECONCILED because that is the better evidence,
 * not as PROVIDER_CONFIRMED because the code happened to check that first.
 */
export function basisFor(p: ConfirmablePayment): $Enums.ReceiptBasis | null {
  /* Seen on a statement and matched. The only basis not resting on somebody's
     word, so it outranks the others even when they also hold. */
  if (p.reconciledAt) return "BANK_RECONCILED";

  /*
   * A THIRD PARTY SAYS SO.
   *
   * Both columns count, and they are not duplicates. `providerRef` is the
   * processor's machine id (a Stripe `pi_...`). `reference` is, in the
   * schema's own words, "the provider's own identifier — an M-Pesa code, a
   * card charge id" — which is exactly the same kind of evidence for the
   * rails that do not go through a processor.
   *
   * Restricted to the methods where a reference IS a provider's word. On a
   * cheque or a bank transfer the same column holds a number a person typed
   * off a slip, and a typed number is not confirmation of anything.
   */
  const fromProvider = p.method === "MPESA" || p.method === "CARD";
  if (p.providerRef.trim() || (fromProvider && p.reference.trim())) {
    return "PROVIDER_CONFIRMED";
  }

  /* Cash, counted by hand. Nothing outside the company witnessed it, so the
     receipt names who took it — that is the whole of the evidence, and saying
     so plainly is better than dressing it as something checkable. */
  if (p.method === "CASH") return "TAKEN_IN_PERSON";

  return null;
}

/**
 * Why this payment cannot be receipted, as a sentence for the person holding
 * the screen — or null when it can.
 *
 * Returns the reason rather than throwing so a list can show which payments
 * are receiptable without a try/catch per row.
 */
export function whyNotReceiptable(p: ConfirmablePayment): string | null {
  if (p.voided) {
    return "That payment was voided. A receipt for money the company has said "
         + "it did not keep would contradict its own books.";
  }
  if (p.amount <= 0n) {
    return "That is a refund, not a receipt. Money going out is evidenced by "
         + "the payment record and the ledger entry behind it.";
  }
  if (!basisFor(p)) {
    /* The only method that reaches here with nothing is a bank transfer or a
       cheque nobody has matched — and for those, reconciliation is precisely
       the thing that makes them true. Say that, rather than "not confirmed". */
    return "Nothing confirms that payment yet. A transfer or a cheque is "
         + "confirmed when it appears on a bank statement — reconcile it "
         + "against the statement line and the receipt can be issued.";
  }
  return null;
}

/** The same rule, for a route that should stop. */
export function requireReceiptable(p: ConfirmablePayment): $Enums.ReceiptBasis {
  const why = whyNotReceiptable(p);
  if (why) throw badRequest(why);
  /* Non-null by construction: whyNotReceiptable returns a reason whenever
     basisFor does not. Asserted rather than assumed so a future edit to one
     without the other fails here rather than writing a receipt with no basis. */
  const basis = basisFor(p);
  if (!basis) throw badRequest("Nothing confirms that payment yet.");
  return basis;
}

/** How a basis reads on the document itself. */
export const BASIS_WORDS: Readonly<Record<$Enums.ReceiptBasis, string>> = {
  BANK_RECONCILED: "Confirmed against the bank statement",
  PROVIDER_CONFIRMED: "Confirmed by the payment provider",
  TAKEN_IN_PERSON: "Received in person",
};
