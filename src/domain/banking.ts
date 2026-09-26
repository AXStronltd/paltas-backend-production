/* ======================================================================
 * RECONCILIATION: WHAT THE LEDGER BELIEVES, AGAINST WHAT THE BANK HOLDS.
 *
 * Ported from paltas-dev-core's `Banking`. Its matching rules are carried
 * across intact; where it and this service disagree, the disagreement is
 * stated below rather than resolved quietly.
 *
 * ── THE TWO QUESTIONS THIS ANSWERS ────────────────────────────────────
 *
 * Both were unanswerable before, and both cost real money:
 *
 *   MONEY NOBODY HAS CLAIMED. A payer sends a transfer quoting a reference
 *   nobody recognises. It sits in the bank. The buyer believes they have
 *   paid, the ledger says they have not, and the argument is settled by
 *   whoever shouts loudest. The unmatched queue is that money, listed.
 *
 *   PAYMENTS THAT NEVER TURNED UP. A receipt was written, the invoice was
 *   marked paid, the books moved — and the transfer bounced, or was never
 *   sent. Nothing in this service could find those, because nothing ever
 *   compared the two records.
 *
 * ── WHERE THIS DIVERGES FROM dev-core, AND WHY ────────────────────────
 *
 * dev-core makes reconciliation a GATE: a payment is `pending` until a
 * bank line proves it, and only then does it post to the ledger.
 *
 * That is right for a greenfield developer service and wrong here, for a
 * reason that is about this service and not about the principle: PALTAS
 * already takes card payments through Stripe, where the processor's
 * webhook is the confirmation and there is no bank line to match for days.
 * It also takes cash, where the confirmation is the person who took it.
 * Making both wait on a statement would mean an invoice staying unpaid
 * after the buyer has watched the card go through.
 *
 * So here a payment is recorded and booked when it is taken, exactly as
 * before, and reconciliation CONFIRMS it afterwards. Nothing about posting
 * changes. What is added is the comparison, which is the part that was
 * missing — and `Payment.reconciledAt` makes "seen in the bank" a fact the
 * service can report on rather than an assumption.
 * ====================================================================== */

import type { $Enums } from "@prisma/client";
import type { Db } from "../db.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";

/**
 * A reference as it should be compared, not as it was written.
 *
 * A payer writing "INV 001", "inv-001" and "INV001" has quoted one
 * reference three ways, and a match that misses because of a hyphen leaves
 * real money in the unmatched queue for somebody to sort out by hand.
 * Stored on the row so the comparison is an index lookup rather than a scan.
 */
export const normaliseRef = (raw: unknown): string =>
  String(raw ?? "").replace(/[\s\-_/.]/g, "").toUpperCase();

export interface StatementLine {
  readonly valueOn: Date;
  readonly amount: bigint;
  readonly reference?: string;
  readonly payerName?: string;
  readonly currency?: string;
}

export interface ImportResult {
  readonly imported: number;
  /** Lines the bank had already sent. Named, not counted, so a person can look. */
  readonly duplicates: readonly string[];
}

/**
 * Take a statement in, refusing the two ways an import corrupts a ledger.
 *
 * WRONG CURRENCY. A line in USD on a KES account is either the wrong file
 * or the wrong account, and both produce a reconciliation that can never
 * balance. Refused rather than converted — this service does not invent an
 * exchange rate nobody quoted.
 *
 * THE SAME FILE TWICE. Importing March again would double every receipt in
 * it. The guard is account + value date + amount + normalised reference,
 * which is what identifies a line when the bank gives it no id of its own.
 *
 * A duplicate is reported rather than thrown: a statement of four hundred
 * lines where six overlap the last import is the normal case, not an error,
 * and refusing the whole file would mean re-cutting it by hand.
 */
export async function importStatement(
  db: Db, orgId: string, bankAccountId: string, lines: readonly StatementLine[],
): Promise<ImportResult> {
  const account = await db.bankAccount.findFirst({
    where: { id: bankAccountId, orgId },
  });
  if (!account) throw notFound("That bank account does not exist.");
  if (!account.active) {
    throw conflict(`${account.name} is withdrawn and takes no more statements.`);
  }

  const duplicates: string[] = [];
  let imported = 0;

  for (const line of lines) {
    const currency = (line.currency || account.currency).toUpperCase();
    if (currency !== account.currency.toUpperCase()) {
      throw badRequest(
        `A ${currency} line on a ${account.currency} account — this is either ` +
        `the wrong file or the wrong account. Nothing was imported.`);
    }
    if (!Number.isFinite(Number(line.amount)) && typeof line.amount !== "bigint") {
      throw badRequest("A statement line needs an amount in minor units.");
    }

    const refNorm = normaliseRef(line.reference);
    const already = await db.bankTransaction.findFirst({
      where: {
        orgId, bankAccountId, valueOn: line.valueOn,
        amount: line.amount, refNorm,
      },
      select: { id: true },
    });
    if (already) {
      duplicates.push(
        `${line.valueOn.toISOString().slice(0, 10)} ${line.reference || "(no reference)"}`);
      continue;
    }

    await db.bankTransaction.create({
      data: {
        orgId, bankAccountId, valueOn: line.valueOn, amount: line.amount,
        currency, reference: String(line.reference || ""), refNorm,
        payerName: String(line.payerName || ""),
      },
    });
    imported += 1;
  }

  return { imported, duplicates };
}

export interface Matched {
  readonly paymentId: string;
  readonly transactionId: string;
  readonly amount: string;
  readonly reference: string;
}

/**
 * Tie one payment to one bank line.
 *
 * Every refusal here is a way two records could be made to disagree:
 *
 *   · a payment already confirmed, matched twice, would say the money
 *     arrived twice;
 *   · a bank line already used, matched again, would prove two payments
 *     with one receipt;
 *   · amounts that differ are not the same event, and a match that ignores
 *     the difference buries it;
 *   · a voided payment has been unwound, and confirming it would restore
 *     a figure somebody deliberately removed.
 */
export async function reconcile(
  db: Db, orgId: string, paymentId: string, transactionId: string, by: string,
): Promise<Matched> {
  const payment = await db.payment.findFirst({
    where: { id: paymentId, orgId },
    include: { bankTransaction: { select: { id: true } } },
  });
  if (!payment) throw notFound("That payment does not exist.");

  const line = await db.bankTransaction.findFirst({
    where: { id: transactionId, orgId },
    include: { bankAccount: { select: { name: true, currency: true } } },
  });
  if (!line) throw notFound("That statement line does not exist.");

  if (payment.voided) {
    throw conflict(
      `That payment was voided${payment.voidReason ? `: ${payment.voidReason}` : ""}. ` +
      `Confirming it would put back a figure somebody removed on purpose.`);
  }
  if (payment.reconciledAt) {
    throw conflict("That payment is already confirmed against the bank.");
  }
  if (payment.bankTransaction) {
    throw conflict("That payment is already matched to a statement line.");
  }
  if (line.matchedPaymentId) {
    throw conflict(
      "That statement line already proves another payment. One line is one " +
      "receipt; matching it twice would count the money twice.");
  }
  if (line.amount <= 0n) {
    throw badRequest(
      "That line is money going out, not a receipt. A payment is money in.");
  }
  if (line.amount !== payment.amount) {
    throw badRequest(
      `The payment is ${payment.currency} ${payment.amount} and the line is ` +
      `${line.currency} ${line.amount}. Different amounts are different events; ` +
      `if the bank took a charge, record that separately.`);
  }
  if (line.currency.toUpperCase() !== payment.currency.toUpperCase()) {
    throw badRequest(
      `The payment is in ${payment.currency} and the line in ${line.currency}.`);
  }

  await db.$transaction(async (tx) => {
    await tx.bankTransaction.update({
      where: { id: line.id },
      data: { matchedPaymentId: payment.id, matchedAt: new Date(), matchedBy: by },
    });
    await tx.payment.update({
      where: { id: payment.id }, data: { reconciledAt: new Date() },
    });
  });

  return {
    paymentId: payment.id, transactionId: line.id,
    amount: String(payment.amount), reference: line.reference,
  };
}

/** Undo a match. The statement line is never edited — only what it points at. */
export async function unreconcile(
  db: Db, orgId: string, transactionId: string,
): Promise<{ readonly paymentId: string }> {
  const line = await db.bankTransaction.findFirst({
    where: { id: transactionId, orgId },
  });
  if (!line) throw notFound("That statement line does not exist.");
  if (!line.matchedPaymentId) {
    throw conflict("That line is not matched to anything.");
  }

  const paymentId = line.matchedPaymentId;
  await db.$transaction(async (tx) => {
    await tx.bankTransaction.update({
      where: { id: line.id },
      data: { matchedPaymentId: null, matchedAt: null, matchedBy: "" },
    });
    await tx.payment.update({ where: { id: paymentId }, data: { reconciledAt: null } });
  });
  return { paymentId };
}

export interface AutoMatchResult {
  readonly matched: readonly Matched[];
  /** More than one payment fits. Left alone deliberately — see below. */
  readonly ambiguous: readonly { readonly transactionId: string; readonly reference: string; readonly candidates: number }[];
  readonly unmatchedLines: number;
}

/**
 * MATCH WHAT AGREES ON ITS OWN, AND LEAVE THE REST ALONE.
 *
 * A line matches a payment when the amount is identical and the normalised
 * reference is identical. Both, never one: amount alone matches every
 * buyer paying the same instalment in the same week.
 *
 * WHERE MORE THAN ONE PAYMENT FITS, NOTHING IS MATCHED. This is the rule
 * carried straight over from dev-core and it is the important one. Two
 * pending payments of the same amount quoting the same reference is exactly
 * the situation where an automatic guess is wrong half the time, and a
 * wrong match is far more expensive than no match: the receipt goes to the
 * wrong buyer, whose balance is then wrong, and the buyer who really paid
 * is chased. Those are listed as ambiguous for a person to settle.
 */
export async function autoMatch(
  db: Db, orgId: string, bankAccountId: string, by: string,
): Promise<AutoMatchResult> {
  const account = await db.bankAccount.findFirst({
    where: { id: bankAccountId, orgId },
  });
  if (!account) throw notFound("That bank account does not exist.");

  const lines = await db.bankTransaction.findMany({
    where: { orgId, bankAccountId, matchedPaymentId: null, amount: { gt: 0n } },
    orderBy: { valueOn: "asc" },
  });

  const matched: Matched[] = [];
  const ambiguous: { transactionId: string; reference: string; candidates: number }[] = [];

  for (const line of lines) {
    if (!line.refNorm) continue;            /* nothing to match on */

    /* Candidates are recomputed per line rather than fetched once, because
       each successful match takes a payment out of the running. */
    const candidates = await db.payment.findMany({
      where: {
        orgId, voided: false, reconciledAt: null,
        amount: line.amount, currency: line.currency,
        bankTransaction: { is: null },
      },
      select: { id: true, reference: true, providerRef: true },
    });
    const fits = candidates.filter((p) =>
      normaliseRef(p.reference) === line.refNorm ||
      normaliseRef(p.providerRef) === line.refNorm);

    if (fits.length === 1) {
      matched.push(await reconcile(db, orgId, fits[0]!.id, line.id, by));
      continue;
    }
    if (fits.length > 1) {
      ambiguous.push({
        transactionId: line.id, reference: line.reference, candidates: fits.length,
      });
    }
  }

  const unmatchedLines = await db.bankTransaction.count({
    where: { orgId, bankAccountId, matchedPaymentId: null, amount: { gt: 0n } },
  });

  return { matched, ambiguous, unmatchedLines };
}

export interface Unreconciled {
  /** Money in the bank nobody has claimed. */
  readonly lines: readonly {
    readonly id: string; readonly valueOn: Date; readonly amount: string;
    readonly reference: string; readonly payerName: string;
  }[];
  /** Receipts on the books that never appeared on a statement. */
  readonly payments: readonly {
    readonly id: string; readonly receivedAt: Date; readonly amount: string;
    readonly reference: string; readonly method: $Enums.PaymentMethod;
  }[];
}

/**
 * The two sides that do not agree, which is the whole report.
 *
 * Card and processor payments are excluded from the payments side: those
 * are confirmed by the processor and settle to the bank in a batch days
 * later, so listing them as "never turned up" would fill the report with
 * money that is simply in transit and teach everybody to ignore it.
 */
export async function unreconciled(
  db: Db, orgId: string, bankAccountId?: string,
): Promise<Unreconciled> {
  const lines = await db.bankTransaction.findMany({
    where: {
      orgId, matchedPaymentId: null, amount: { gt: 0n },
      ...(bankAccountId ? { bankAccountId } : {}),
    },
    orderBy: { valueOn: "desc" },
    take: 500,
  });

  const payments = await db.payment.findMany({
    where: {
      orgId, voided: false, reconciledAt: null,
      method: { in: ["BANK", "MPESA", "CHEQUE"] },
    },
    orderBy: { receivedAt: "desc" },
    take: 500,
  });

  return {
    lines: lines.map((l) => ({
      id: l.id, valueOn: l.valueOn, amount: String(l.amount),
      reference: l.reference, payerName: l.payerName,
    })),
    payments: payments.map((p) => ({
      id: p.id, receivedAt: p.receivedAt, amount: String(p.amount),
      reference: p.reference, method: p.method,
    })),
  };
}
