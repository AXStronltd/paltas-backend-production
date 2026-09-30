/* ======================================================================
 * EVERYTHING ABOUT ONE BUYER, CALCULATED AND NEVER STORED.
 *
 * Ported from paltas-dev-core's Buyer360. Its rule is the one that matters
 * and it is carried across whole: EVERY FIGURE IS DERIVED. Nothing here is
 * a column somebody updates, because a stored balance is a balance that
 * goes stale, and the moment it disagrees with the invoices nobody can
 * tell which one is lying.
 *
 * ── WHAT IT IS FOR ────────────────────────────────────────────────────
 *
 * A buyer rings up and asks what they owe. Today that answer is assembled
 * by a person opening three screens — the contract for the price, the
 * invoice list for what has been billed, the payment list for what has
 * arrived — and doing the subtraction in their head. They get it wrong,
 * and the buyer is told a figure the books do not hold.
 *
 * ── WHY THE PAID FIGURE IS NOT THE PAYMENT TOTAL ──────────────────────
 *
 * A payment can exceed what is owed. dev-core holds the excess as buyer
 * credit rather than losing it, and that is right: money a buyer has
 * genuinely sent must never vanish because no invoice was open to take it.
 * So `paid` and `credit` are reported apart. A buyer with a credit is not
 * a buyer in arrears, and a report that nets the two would hide both.
 * ====================================================================== */

import type { Db } from "../db.ts";
import { notFound } from "../http/errors.ts";

export interface BuyerPosition {
  readonly currency: string;
  /** The contract price, which is what was agreed however it is billed. */
  readonly price: string;
  /** Raised as invoices, tax included. */
  readonly invoiced: string;
  /** Received and not voided. */
  readonly received: string;
  /** Still owed on what has been BILLED — not on the whole price. */
  readonly outstanding: string;
  /** Sent, but with no open invoice to take it. Never netted off arrears. */
  readonly credit: string;
  /** Of the price, not yet billed at all. */
  readonly unbilled: string;
  /** Overdue, by the invoice dates. */
  readonly overdue: string;
}

export interface BuyerScheduleLine {
  readonly seq: number;
  readonly description: string;
  readonly amount: string;
  readonly dueOn: Date | null;
  readonly milestone: string | null;
  readonly invoiced: boolean;
  readonly state: "paid" | "part-paid" | "billed" | "due" | "awaiting stage" | "scheduled";
}

export interface Buyer360 {
  readonly contract: {
    readonly id: string; readonly ref: string; readonly status: string;
    readonly signedOn: Date | null;
  };
  readonly buyer: { readonly id: string; readonly name: string; readonly phone: string } | null;
  readonly unit: { readonly id: string; readonly ref: string } | null;
  readonly position: BuyerPosition;
  readonly schedule: readonly BuyerScheduleLine[];
  readonly payments: readonly {
    readonly id: string; readonly receivedAt: Date; readonly amount: string;
    readonly method: string; readonly reference: string;
    /** Confirmed against a bank statement. See domain/banking.ts. */
    readonly confirmed: boolean;
  }[];
}

/**
 * Assemble the buyer's position from the records, in one read.
 *
 * The invoice total is taken from the invoice's own stored total rather than
 * recomputed from its lines: `recomputeInvoice` already owns that sum, and a
 * second implementation of it here would eventually disagree with the first.
 */
export async function buyer360(
  db: Db, orgId: string, contractId: string,
): Promise<Buyer360> {
  const contract = await db.contract.findFirst({
    where: { id: contractId, orgId },
    include: {
      buyer: { select: { id: true, name: true, phone: true } },
      unit: { select: { id: true, ref: true } },
    },
  });
  if (!contract) throw notFound("That contract does not exist.");

  const invoices = await db.invoice.findMany({
    where: { orgId, contractId, status: { not: "VOID" } },
    select: { id: true, total: true, paid: true, credited: true, dueOn: true, status: true },
  });

  const payments = await db.payment.findMany({
    where: { orgId, voided: false, invoice: { contractId } },
    orderBy: { receivedAt: "desc" },
    select: {
      id: true, receivedAt: true, amount: true, method: true,
      reference: true, reconciledAt: true,
    },
  });

  const plan = await db.paymentPlan.findFirst({
    where: { orgId, contractId, supersededAt: null },
    include: { instalments: { orderBy: { seq: "asc" } } },
  });

  const invoiced = invoices.reduce((a, i) => a + i.total, 0n);
  const receivedOnInvoices = invoices.reduce((a, i) => a + i.paid, 0n);
  /* Waived, not received — so it is not in `receivedOnInvoices` and must not
     be. It still stops the buyer owing it, which is the next line down. */
  const creditedOnInvoices = invoices.reduce((a, i) => a + i.credited, 0n);
  const receivedAll = payments.reduce((a, p) => a + p.amount, 0n);

  /*
   * Outstanding is measured against what has been BILLED, not the price.
   *
   * A buyer eighteen months into a five-year plan is not in arrears for the
   * instalments that have not fallen due. Reporting the whole unpaid price as
   * outstanding would put every buyer permanently in the red and make the
   * figure useless for spotting the ones who really are behind. What is not
   * yet billed is reported separately, as `unbilled`.
   */
  const outstanding = invoiced - receivedOnInvoices - creditedOnInvoices;

  /* Money that arrived with no open invoice to take it. Held, never lost. */
  const credit = receivedAll > receivedOnInvoices ? receivedAll - receivedOnInvoices : 0n;

  const today = new Date();
  /* A credited invoice is not late. Chasing somebody for a bill the company
     itself withdrew is worse than being wrong by the amount — they get a
     letter about it. */
  const overdue = invoices
    .filter((i) => i.dueOn && i.dueOn < today && i.total > i.paid + i.credited)
    .reduce((a, i) => a + (i.total - i.paid - i.credited), 0n);

  const scheduled = plan?.instalments ?? [];
  const byInvoice = new Map(invoices.map((i) => [i.id, i]));

  const schedule: BuyerScheduleLine[] = scheduled.map((i) => {
    const invoice = i.invoiceId ? byInvoice.get(i.invoiceId) : undefined;
    const state: BuyerScheduleLine["state"] =
      /* Settled is settled, however: money in, or written off. */
      invoice && invoice.paid + invoice.credited >= invoice.total ? "paid"
        : invoice && (invoice.paid > 0n || invoice.credited > 0n) ? "part-paid"
          : invoice ? "billed"
            : i.milestone && !i.dueOn ? "awaiting stage"
              : i.dueOn && i.dueOn <= today ? "due"
                : "scheduled";
    return {
      seq: i.seq, description: i.description, amount: String(i.amount),
      dueOn: i.dueOn, milestone: i.milestone,
      invoiced: Boolean(i.invoiceId), state,
    };
  });

  const planned = scheduled.reduce((a, i) => a + i.amount, 0n);
  /* Unbilled is measured against the plan when there is one, and against the
     price when there is not — a contract with no plan has its whole price
     ahead of it, which is true and worth saying. */
  const unbilled = (planned > 0n ? planned : contract.price) - invoiced;

  return {
    contract: {
      id: contract.id, ref: contract.ref, status: contract.status,
      signedOn: contract.signedOn,
    },
    buyer: contract.buyer
      ? { id: contract.buyer.id, name: contract.buyer.name, phone: contract.buyer.phone }
      : null,
    unit: contract.unit ? { id: contract.unit.id, ref: contract.unit.ref } : null,
    position: {
      currency: contract.currency,
      price: String(contract.price),
      invoiced: String(invoiced),
      received: String(receivedAll),
      outstanding: String(outstanding > 0n ? outstanding : 0n),
      credit: String(credit),
      unbilled: String(unbilled > 0n ? unbilled : 0n),
      overdue: String(overdue),
    },
    schedule,
    payments: payments.map((p) => ({
      id: p.id, receivedAt: p.receivedAt, amount: String(p.amount),
      method: p.method, reference: p.reference,
      confirmed: Boolean(p.reconciledAt),
    })),
  };
}
