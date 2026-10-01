/* ====================================================================== *
 * FROM A BUSINESS EVENT TO A JOURNAL ENTRY.
 *
 * The ledger has been postable since it got routes, and until now the only
 * thing that posted to it was a person typing an entry by hand. An invoice
 * issued, a payment banked and an expense recorded left no trace in the
 * books at all — so the journal was a place to write things down rather than
 * an account of the business.
 *
 * This is the bridge. Four events, four entries:
 *
 *   invoice issued      Dr  Accounts receivable      the gross
 *                       Cr  Rent (or other income)   the net
 *                       Cr  Tax payable              the tax, where there is any
 *
 *   payment received    Dr  Bank or Cash             what arrived
 *                       Cr  Accounts receivable      the receivable it clears
 *
 *   payment voided      the mirror of its own entry, through reverseJournal
 *
 *   expense recorded    Dr  the category's account   what was spent
 *                       Cr  Accounts payable         what is owed for it
 *
 * ── THE RULE THAT SHAPES EVERYTHING HERE ───────────────────────────────
 *
 * BOOKKEEPING NEVER BLOCKS MONEY.
 *
 * Every function below returns a result; none of them throws into the path
 * that recorded the payment. A tenant's rent is banked whether or not this
 * service can decide which account to put it in, because the alternative is
 * refusing to record money that has already arrived — over a chart of
 * accounts nobody has set up yet.
 *
 * That matters immediately: no existing company has a chart. If posting were
 * required, every invoice and every payment in production would start failing
 * the moment this shipped. So a company with no chart simply does not get
 * automatic postings, and is told that is why.
 *
 * What it is NOT is silent. Every skip carries a reason, the caller returns
 * it in the response, and the routes write it to the audit log. A drift
 * between the business records and the books is always visible and always
 * explained.
 *
 * ── AND IT NEVER POSTS TWICE ───────────────────────────────────────────
 *
 * JournalEntry carries sourceType and sourceId. Before posting anything, the
 * bridge asks whether that source already has an entry. Recomputing an
 * invoice, retrying a request, or a double-submit on a bad connection must
 * not book the same rent twice.
 * ====================================================================== */

import type { Db } from "../db.ts";

import { postJournal, reverseJournal, LedgerError } from "./ledger.ts";
import type { JournalLineInput } from "./ledger.ts";
import { country as marketCountry } from "./market.ts";

/* ---------------------------------------------------------------- *
 * WHICH ACCOUNT
 *
 * By CODE, resolved against the company's own chart — never by id and never
 * by position. An accountant renames "Rent" to "Rental income" and the
 * posting still lands; they withdraw 4000 entirely and the posting is
 * skipped with a reason, rather than landing somewhere plausible.
 * ---------------------------------------------------------------- */

export const ACCOUNTS = {
  receivable: "1100",
  bank: "1000",
  cash: "1010",
  payable: "2000",
  /**
   * SOMEBODY ELSE'S MONEY, SITTING IN THIS COMPANY'S ACCOUNT.
   *
   * A tenancy deposit is a LIABILITY, not income — the company owes it back.
   * The code has been in the starting chart from the beginning with nothing
   * posting to it, which is the whole gap `postForDeposit` closes: a company
   * booking deposits as revenue overstates what it earned, pays tax on money
   * it must return, and reads its own bank balance as spendable when part of
   * it belongs to its tenants.
   */
  depositsHeld: "2100",
  taxPayable: "2300",
  rent: "4000",
  otherIncome: "4090",
  otherExpense: "5900",
};

/** Cash in hand is cash; everything else arrives through a bank. */
const BY_METHOD: Readonly<Record<string, string>> = {
  CASH: ACCOUNTS.cash,
  BANK: ACCOUNTS.bank,
  MPESA: ACCOUNTS.bank,
  CARD: ACCOUNTS.bank,
  CHEQUE: ACCOUNTS.bank,
  OTHER: ACCOUNTS.bank,
};

/**
 * The expense categories the console offers, mapped to the starting chart.
 *
 * Anything unrecognised books to "other operating expenses" rather than being
 * refused: a cost that happened belongs in the books under a coarse heading,
 * not left out of them because nobody has defined a fine one.
 */
const BY_CATEGORY: Readonly<Record<string, string>> = {
  maintenance: "5000",
  repairs: "5010",
  utility: "5020",
  utilities: "5020",
  cleaning: "5030",
  security: "5040",
  insurance: "5050",
  salary: "5070",
  salaries: "5070",
  contractor: "5080",
  professional: "5090",
  tax: "5110",
  levy: ACCOUNTS.otherExpense,
  supplies: ACCOUNTS.otherExpense,
  marketing: ACCOUNTS.otherExpense,
};

/* ---------------------------------------------------------------- *
 * SHARED PLUMBING
 * ---------------------------------------------------------------- */

/**
 * The company's reporting currency, from its own country.
 *
 * Shared with routes/ledger.js so a hand-posted entry and an automatic one
 * can never disagree about what currency this company reports in.
 */
export async function reportingCurrencyFor(db: Db, orgId: string): Promise<string | null> {
  const org = await db.organization.findFirst({
    where: { id: orgId }, select: { country: true },
  });
  const c = org && org.country ? marketCountry(String(org.country).toUpperCase()) : null;
  return c && c.currency ? c.currency : null;
}

/**
 * The next journal reference for this company.
 *
 * The SAME counter series routes/ledger.js uses. Two series would hand out
 * JE-0007 twice — once to a hand-posted entry and once to an automatic one —
 * and the unique constraint would then reject whichever arrived second, which
 * is a payment failing because of a bookkeeping collision.
 */
export async function nextJournalRef(db: Db, orgId: string): Promise<string> {
  const name = `ledger-entries:${orgId}`;
  const row = await db.counter.upsert({
    where: { name }, create: { name, value: 1 }, update: { value: { increment: 1 } },
  });
  return `JE-${String(row.value).padStart(4, "0")}`;
}

/** This company's chart, by code — or null where it has none. */
/** One account of a company's chart, as the posting path reads it. */
interface ChartRow {
  readonly id: string;
  readonly code: string;
  readonly postable: boolean;
  readonly active: boolean;
}

async function chartFor(db: Db, orgId: string): Promise<Map<string, ChartRow> | null> {
  const rows = await db.ledgerAccount.findMany({
    where: { orgId }, select: { id: true, code: true, postable: true, active: true },
  });
  if (!rows.length) return null;
  return new Map(rows.map((a) => [a.code, a] as const));
}

/** An account that will take a posting, or null with the reason left to the caller. */
function usable(chart: Map<string, ChartRow>, code: string): ChartRow | null {
  const a = chart.get(code);
  if (!a || !a.postable || !a.active) return null;
  return a;
}

/** Has this business row already been booked? */
async function alreadyPosted(
  db: Db, orgId: string, sourceType: string, sourceId: string,
) {
  const existing = await db.journalEntry.findFirst({
    where: { orgId, sourceType, sourceId },
    select: { id: true, ref: true },
  });
  return existing || null;
}

/**
 * WHICH PROPERTY, WHICH TENANT, WHICH UNIT.
 *
 * JournalLine carries siteId, buildingId, unitId, leaseId and partyId, and is
 * indexed on three of them. Those columns are what make a statement PER
 * ENTITY possible: a tenant's statement is their lines, a property's is its
 * lines, and neither can be reconstructed afterwards from an account total.
 *
 * The bridge did not set any of them at first, so every automatic entry was
 * booked against the company and nothing else — the books balanced, the
 * reports were right, and "what does this tenant owe" had no answer. They are
 * filled in here, once, at the moment the entry is posted, because the link
 * from a lease to its unit and site is known then and gone later.
 *
 * ── THE PROPERTY GOES ON EVERY LINE; THE PARTY DOES NOT ────────────────
 *
 * siteId, buildingId, unitId and leaseId belong on BOTH sides of the entry:
 * a property's statement wants the rent it earned as much as the receivable
 * it raised, and property profitability is exactly the income and expense
 * lines carrying a site.
 *
 * partyId belongs only on the line the party is the COUNTERPARTY TO — the
 * receivable or the payable. Putting it on the income line as well was the
 * first thing this did, and it made every tenant statement net to zero: the
 * tenant appeared to be charged on the receivable and credited on the income,
 * so somebody who owed a full month's rent read as square. A tenant is not a
 * party to the company's revenue. They are a party to their own debt.
 */
/**
 * The dimensions a line carries. `where` goes on every line of an entry;
 * `who` only on the one the party is the counterparty to.
 */
interface Dimensions {
  where: {
    siteId: string | null; buildingId: string | null;
    unitId: string | null; leaseId: string | null;
  };
  who: { partyId: string | null };
}

async function dimensionsFor(
  db: Db,
  orgId: string,
  { leaseId, partyId }: { leaseId?: string | null; partyId?: string | null },
): Promise<Dimensions> {
  /* `where` is stamped on every line; `who` only on the counterparty's. */
  const out: Dimensions = {
    where: { siteId: null, buildingId: null, unitId: null, leaseId: leaseId || null },
    who: { partyId: partyId || null },
  };
  if (!leaseId) return out;

  const lease = await db.lease.findFirst({
    where: { id: leaseId, orgId },
    select: { tenantId: true, unit: { select: { id: true, siteId: true, buildingId: true } } },
  });
  if (!lease) return out;

  /* The tenant on the lease, where the caller did not already name a party. */
  if (!out.who.partyId) out.who.partyId = lease.tenantId || null;
  if (lease.unit) {
    out.where.unitId = lease.unit.id;
    out.where.siteId = lease.unit.siteId || null;
    out.where.buildingId = lease.unit.buildingId || null;
  }
  return out;
}

/**
 * WHAT EVERY FUNCTION IN THIS FILE RETURNS.
 *
 * `posted` or `skipped`, never neither and never both — which is the whole
 * of "bookkeeping never blocks money" written as a type: a caller cannot
 * read a posted entry without having handled the case where there is none.
 */
export type PostingResult =
  | { posted: JournalEntryWithLines; skipped: null; reversed?: string }
  | { posted: null; skipped: string; existing?: { id: string; ref: string } };

/** A posted entry with its lines, as postJournal returns one. */
export type JournalEntryWithLines = Awaited<ReturnType<typeof postJournal>>;

const skip = (reason: string): PostingResult => ({ posted: null, skipped: reason });
const big = (v: unknown): bigint =>
  (typeof v === "bigint" ? v : BigInt((v as string | number | null | undefined) || 0));

/**
 * Everything the four events below share.
 *
 * Returns either the posted entry or a stated reason. It does not throw: a
 * LedgerError here means the books could not take the entry — a closed
 * period, a withdrawn account — and that is never a reason to undo a payment
 * that has already been taken.
 */
/** Everything the four events below hand `book()`. */
interface BookInput {
  readonly orgId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly date: Date;
  readonly memo: string;
  readonly lines: readonly JournalLineInput[];
  readonly currency?: string | null;
  readonly userId?: string | null;
}

async function book(
  db: Db,
  { orgId, sourceType, sourceId, date, memo, lines, currency, userId }: BookInput,
): Promise<PostingResult> {
  const done = await alreadyPosted(db, orgId, sourceType, sourceId);
  if (done) return { posted: null, skipped: `already booked as ${done.ref}`, existing: done };

  const baseCurrency = await reportingCurrencyFor(db, orgId);
  if (!baseCurrency) {
    return skip("this company's reporting currency is not known — set its country, or post by hand");
  }
  /*
   * A business row in a currency other than the books' would need a rate,
   * and this bridge has no business inventing one. The entry is skipped and
   * said so; a person posts it with the rate they actually used.
   */
  if (currency && currency !== baseCurrency) {
    return skip(`this is in ${currency} and the books are in ${baseCurrency} — post it by hand with the rate used`);
  }

  try {
    const entry = await postJournal(db, {
      orgId,
      ref: await nextJournalRef(db, orgId),
      date, memo, lines,
      currency: baseCurrency, baseCurrency,
      sourceType, sourceId,
      postedById: userId || null,
    });
    return { posted: entry, skipped: null };
  } catch (e) {
    if (e instanceof LedgerError) return skip(e.message);
    throw e;   /* a real fault, not a refusal */
  }
}

/* ====================================================================== *
 * MONEY IN — an invoice issued
 * ====================================================================== */

/**
 * Dr receivable, Cr income, Cr tax.
 *
 * Posted when an invoice is ISSUED, not when the row is created: an invoice
 * is created empty and its lines are added afterwards, so booking it on
 * create would book a total of nothing.
 *
 * Tax is split out rather than folded into income, because it is not income
 * — it is money held for a tax authority, and a P&L that counts it overstates
 * what the business earned.
 */
/**
 * An invoice as this bridge reads it. Money arrives as BigInt from Prisma;
 * `big()` below is the one place it is coerced.
 */
export interface InvoiceForPosting {
  readonly id: string;
  readonly ref: string;
  readonly total: unknown;
  readonly currency?: string | null;
  readonly issuedOn?: Date | null;
  readonly leaseId?: string | null;
  readonly partyId?: string | null;
  readonly lines?: readonly {
    unitPrice?: unknown; quantity?: number | null; taxBps?: number | null;
  }[];
}

export async function postForInvoice(
  db: Db,
  { orgId, invoice, userId }:
    { orgId: string; invoice: InvoiceForPosting; userId?: string | null },
): Promise<PostingResult> {
  const chart = await chartFor(db, orgId);
  if (!chart) return skip("no chart of accounts — seed one to book invoices automatically");

  const total = big(invoice.total);
  if (total <= 0n) return skip("an invoice with no total has nothing to book");

  /* Tax comes off the lines, where the rate lives. */
  let tax = 0n;
  for (const l of invoice.lines || []) {
    const net = big(l.unitPrice) * BigInt(l.quantity || 1);
    tax += (net * BigInt(l.taxBps || 0)) / 10000n;
  }
  const net = total - tax;

  const receivable = usable(chart, ACCOUNTS.receivable);
  /* Rent where the invoice is against a lease; other property income where
     it is not. Neither is a guess about the amount — only about the heading. */
  const incomeCode = invoice.leaseId ? ACCOUNTS.rent : ACCOUNTS.otherIncome;
  const income = usable(chart, incomeCode) || usable(chart, ACCOUNTS.otherIncome);
  if (!receivable) return skip(`account ${ACCOUNTS.receivable} is missing or closed to postings`);
  if (!income) return skip(`account ${incomeCode} is missing or closed to postings`);

  const dim = await dimensionsFor(db, orgId, {
    leaseId: invoice.leaseId, partyId: invoice.partyId,
  });

  const lines: JournalLineInput[] = [
    /* The customer is the counterparty to the receivable, and to nothing else
       in this entry. */
    { accountId: receivable.id, debit: Number(total), memo: `Invoice ${invoice.ref}`, ...dim.where, ...dim.who },
    { accountId: income.id, credit: Number(net), memo: `Invoice ${invoice.ref}`, ...dim.where },
  ];
  if (tax > 0n) {
    const taxAcct = usable(chart, ACCOUNTS.taxPayable);
    if (!taxAcct) return skip(`account ${ACCOUNTS.taxPayable} is missing, and this invoice carries tax`);
    lines.push({ accountId: taxAcct.id, credit: Number(tax), memo: "Tax on " + invoice.ref, ...dim.where });
  }

  return book(db, {
    orgId, sourceType: "invoice", sourceId: invoice.id,
    date: invoice.issuedOn || new Date(),
    memo: `Invoice ${invoice.ref}`,
    currency: invoice.currency, lines, userId,
  });
}

/* ====================================================================== *
 * MONEY IN — a payment received
 * ====================================================================== */

/**
 * Dr bank or cash, Cr receivable.
 *
 * A payment NOT against an invoice is skipped deliberately. There is no
 * receivable for it to clear, and the alternative — crediting income —
 * decides on the customer's behalf that money in hand has been earned. That
 * is a revenue-recognition judgement, and this bridge does not make it.
 */
/** A payment as this bridge reads it. */
export interface PaymentForPosting {
  readonly id: string;
  readonly amount: unknown;
  readonly method?: string | null;
  readonly currency?: string | null;
  readonly reference?: string | null;
  readonly receivedAt?: Date | null;
  readonly invoiceId?: string | null;
}

export async function postForPayment(
  db: Db,
  { orgId, payment, invoice, userId }: {
    orgId: string;
    payment: PaymentForPosting;
    invoice?: InvoiceForPosting | null;
    userId?: string | null;
  },
): Promise<PostingResult> {
  const chart = await chartFor(db, orgId);
  if (!chart) return skip("no chart of accounts — seed one to book payments automatically");

  const amount = big(payment.amount);
  if (amount <= 0n) return skip("a payment of nothing has nothing to book");
  if (!payment.invoiceId) {
    return skip("this payment is not against an invoice, so there is no receivable to clear — post it by hand");
  }

  const intoCode = BY_METHOD[String(payment.method)] || ACCOUNTS.bank;
  const into = usable(chart, intoCode);
  const receivable = usable(chart, ACCOUNTS.receivable);
  if (!into) return skip(`account ${intoCode} is missing or closed to postings`);
  if (!receivable) return skip(`account ${ACCOUNTS.receivable} is missing or closed to postings`);

  /* The payment's own row names no party — it clears an invoice, and the
     invoice is what knows whose it was. */
  const dim = await dimensionsFor(db, orgId, {
    leaseId: invoice ? invoice.leaseId : null, partyId: invoice ? invoice.partyId : null,
  });

  return book(db, {
    orgId, sourceType: "payment", sourceId: payment.id,
    date: payment.receivedAt || new Date(),
    memo: `Payment ${payment.reference || ""}`.trim() + (invoice ? ` for ${invoice.ref}` : ""),
    currency: payment.currency,
    lines: [
      { accountId: into.id, debit: Number(amount), memo: String(payment.method || ""), ...dim.where },
      /* Clearing THEIR receivable, so this is the line that is theirs. */
      { accountId: receivable.id, credit: Number(amount), memo: invoice ? invoice.ref : "", ...dim.where, ...dim.who },
    ],
    userId,
  });
}

/* ====================================================================== *
 * MONEY BACK, AND MONEY WAIVED — the two that undo an invoice
 * ====================================================================== */

/** A credit note as this bridge reads it. */
export interface CreditNoteForPosting {
  readonly id: string;
  readonly ref: string;
  readonly amount: bigint | number;
  readonly taxBps: number;
  readonly currency: string;
  readonly issuedOn: Date;
}

/**
 * A CREDIT NOTE IS AN INVOICE RUN BACKWARDS, AND NOTHING ELSE.
 *
 * Cr receivable — they owe less. Dr income — the company earned less than it
 * said. Dr tax payable for the tax inside it, because a bill that is being
 * withdrawn takes its VAT with it; leaving that credited would have the
 * company remit tax on revenue it gave back.
 *
 * Deliberately the mirror of postForInvoice rather than a reversal of the
 * original entry: a credit note is usually PART of an invoice, and reversing
 * the whole entry to re-post the difference would leave two corrections in
 * the ledger where the business did one thing.
 */
export async function postForCreditNote(
  db: Db,
  { orgId, note, invoice, userId }: {
    orgId: string;
    note: CreditNoteForPosting;
    invoice: InvoiceForPosting;
    userId?: string | null;
  },
): Promise<PostingResult> {
  const chart = await chartFor(db, orgId);
  if (!chart) return skip("no chart of accounts — seed one to book credit notes automatically");

  const gross = big(note.amount);
  if (gross <= 0n) return skip("a credit note of nothing has nothing to book");

  /* The tax inside the gross, not on top of it — the same arithmetic the
     invoice used, so the two agree to the shilling. */
  const tax = (gross * BigInt(note.taxBps || 0)) / BigInt(10000 + (note.taxBps || 0));
  const net = gross - tax;

  const receivable = usable(chart, ACCOUNTS.receivable);
  const incomeCode = invoice.leaseId ? ACCOUNTS.rent : ACCOUNTS.otherIncome;
  const income = usable(chart, incomeCode) || usable(chart, ACCOUNTS.otherIncome);
  if (!receivable) return skip(`account ${ACCOUNTS.receivable} is missing or closed to postings`);
  if (!income) return skip(`account ${incomeCode} is missing or closed to postings`);

  const dim = await dimensionsFor(db, orgId, {
    leaseId: invoice.leaseId, partyId: invoice.partyId,
  });

  const lines: JournalLineInput[] = [
    { accountId: receivable.id, credit: Number(gross), memo: `Credit ${note.ref}`, ...dim.where, ...dim.who },
    { accountId: income.id, debit: Number(net), memo: `Credit ${note.ref}`, ...dim.where },
  ];
  if (tax > 0n) {
    const taxAcct = usable(chart, ACCOUNTS.taxPayable);
    if (!taxAcct) return skip(`account ${ACCOUNTS.taxPayable} is missing, and this credit note carries tax`);
    lines.push({ accountId: taxAcct.id, debit: Number(tax), memo: "Tax on " + note.ref, ...dim.where });
  }

  return book(db, {
    orgId, sourceType: "credit-note", sourceId: note.id,
    date: note.issuedOn || new Date(),
    memo: `Credit note ${note.ref} against ${invoice.ref}`,
    currency: note.currency,
    lines, userId,
  });
}

/**
 * A REFUND IS A PAYMENT RUN BACKWARDS.
 *
 * Cr bank or cash — the money left. Dr receivable — the invoice is owed
 * again, which is the part people forget: giving money back does not cancel
 * the bill, it un-collects it. If the bill should go too, that is a credit
 * note, and the two together are how a cancelled sale is recorded.
 *
 * Needed as its own function because postForPayment() skips anything at or
 * below zero — "a payment of nothing has nothing to book" — so a refund
 * recorded as a negative payment reached the books as silence.
 */
export async function postForRefund(
  db: Db,
  { orgId, payment, invoice, userId }: {
    orgId: string;
    payment: PaymentForPosting;
    invoice?: InvoiceForPosting | null;
    userId?: string | null;
  },
): Promise<PostingResult> {
  const chart = await chartFor(db, orgId);
  if (!chart) return skip("no chart of accounts — seed one to book refunds automatically");

  /* Stored negative, booked as a positive in the other direction. */
  const amount = -big(payment.amount);
  if (amount <= 0n) return skip("that is not a refund — the amount is not negative");
  if (!payment.invoiceId) {
    return skip("this refund is not against an invoice, so there is no receivable to reopen — post it by hand");
  }

  const fromCode = BY_METHOD[String(payment.method)] || ACCOUNTS.bank;
  const from = usable(chart, fromCode);
  const receivable = usable(chart, ACCOUNTS.receivable);
  if (!from) return skip(`account ${fromCode} is missing or closed to postings`);
  if (!receivable) return skip(`account ${ACCOUNTS.receivable} is missing or closed to postings`);

  const dim = await dimensionsFor(db, orgId, {
    leaseId: invoice ? invoice.leaseId : null, partyId: invoice ? invoice.partyId : null,
  });

  return book(db, {
    orgId, sourceType: "refund", sourceId: payment.id,
    date: payment.receivedAt || new Date(),
    memo: `Refund ${payment.reference || ""}`.trim() + (invoice ? ` of ${invoice.ref}` : ""),
    currency: payment.currency,
    lines: [
      { accountId: receivable.id, debit: Number(amount), memo: invoice ? invoice.ref : "", ...dim.where, ...dim.who },
      { accountId: from.id, credit: Number(amount), memo: String(payment.method || ""), ...dim.where },
    ],
    userId,
  });
}

/* ====================================================================== *
 * MONEY HELD, AND NOT OWNED — a tenancy deposit
 * ====================================================================== */

/** A deposit movement as this bridge reads it. */
export interface DepositMovementForPosting {
  readonly id: string;
  readonly kind: string;
  readonly amount: bigint | number;
  readonly currency: string;
  readonly reason?: string | null;
  readonly at: Date;
  readonly method?: string | null;
  readonly invoiceId?: string | null;
}

/**
 * THE THREE DIRECTIONS A DEPOSIT MOVES, AND NONE OF THEM IS REVENUE.
 *
 * RECEIVED   Dr bank/cash, Cr deposits held.
 *            The money is in the account and the company owes it back. The
 *            one posting people get wrong, by crediting income — which
 *            overstates earnings and taxes money that has to be returned.
 *
 * DEDUCTED   Dr deposits held, and then it depends what it was kept FOR:
 *            against an invoice  Cr receivable — the arrears are settled out
 *                                of money already in hand, so the debt goes
 *                                and no new cash appears.
 *            anything else       Cr other income — damage, cleaning, keys. The
 *                                company really does keep this, so it really
 *                                is income, in the period it was kept. The
 *                                repair it pays for is its own expense.
 *
 * RETURNED   Dr deposits held, Cr bank/cash. The liability is discharged and
 *            the money leaves. Never touches income in either direction.
 *
 * The liability account is debited in all three of the last two cases because
 * every one of them makes the company owe the tenant less.
 */
export async function postForDeposit(
  db: Db,
  { orgId, movement, userId }: {
    orgId: string;
    movement: DepositMovementForPosting;
    userId?: string | null;
  },
): Promise<PostingResult> {
  const chart = await chartFor(db, orgId);
  if (!chart) return skip("no chart of accounts — seed one to book deposits automatically");

  const amount = big(movement.amount);
  if (amount <= 0n) return skip("a movement of nothing has nothing to book");

  const held = usable(chart, ACCOUNTS.depositsHeld);
  if (!held) {
    return skip(`account ${ACCOUNTS.depositsHeld} (tenant deposits held) is missing or closed `
      + `to postings — a deposit cannot be booked as anything else without `
      + `turning somebody else's money into revenue`);
  }

  /* Cash in hand is cash, everything else arrives and leaves through a bank —
     the same rule a payment follows, so the two cannot disagree. */
  const cashCode = BY_METHOD[String(movement.method)] || ACCOUNTS.bank;

  if (movement.kind === "RECEIVED") {
    const into = usable(chart, cashCode);
    if (!into) return skip(`account ${cashCode} is missing or closed to postings`);
    return book(db, {
      orgId, sourceType: "deposit-movement", sourceId: movement.id,
      date: movement.at, memo: "Deposit received",
      currency: movement.currency,
      lines: [
        { accountId: into.id, debit: Number(amount), memo: String(movement.method || "") },
        /* The company owes this back. That is the whole entry. */
        { accountId: held.id, credit: Number(amount), memo: movement.reason || "" },
      ],
      userId,
    });
  }

  if (movement.kind === "RETURNED") {
    const out = usable(chart, cashCode);
    if (!out) return skip(`account ${cashCode} is missing or closed to postings`);
    return book(db, {
      orgId, sourceType: "deposit-movement", sourceId: movement.id,
      date: movement.at, memo: "Deposit returned",
      currency: movement.currency,
      lines: [
        { accountId: held.id, debit: Number(amount), memo: movement.reason || "" },
        { accountId: out.id, credit: Number(amount), memo: String(movement.method || "") },
      ],
      userId,
    });
  }

  if (movement.kind === "DEDUCTED") {
    /*
     * AGAINST ARREARS, the credit clears the debt — no income, because the
     * rent was already recognised when the invoice was raised. Crediting
     * income here would count the same rent twice.
     */
    if (movement.invoiceId) {
      const receivable = usable(chart, ACCOUNTS.receivable);
      if (!receivable) return skip(`account ${ACCOUNTS.receivable} is missing or closed to postings`);
      return book(db, {
        orgId, sourceType: "deposit-movement", sourceId: movement.id,
        date: movement.at, memo: "Deposit applied to arrears",
        currency: movement.currency,
        lines: [
          { accountId: held.id, debit: Number(amount), memo: movement.reason || "" },
          { accountId: receivable.id, credit: Number(amount), memo: movement.reason || "" },
        ],
        userId,
      });
    }

    /* Damage, cleaning, keys. The company keeps it, so it is income — and the
       cost of putting the damage right is its own expense, separately. */
    const income = usable(chart, ACCOUNTS.otherIncome);
    if (!income) return skip(`account ${ACCOUNTS.otherIncome} is missing or closed to postings`);
    return book(db, {
      orgId, sourceType: "deposit-movement", sourceId: movement.id,
      date: movement.at, memo: "Deposit retained",
      currency: movement.currency,
      lines: [
        { accountId: held.id, debit: Number(amount), memo: movement.reason || "" },
        { accountId: income.id, credit: Number(amount), memo: movement.reason || "" },
      ],
      userId,
    });
  }

  return skip(`a deposit movement of kind ${movement.kind} has no booking rule`);
}

/* ====================================================================== *
 * MONEY OUT — an expense recorded
 * ====================================================================== */

/**
 * Dr the category's account, Cr payable.
 *
 * Credited to payable rather than straight to bank, because an Expense here
 * records that a cost was INCURRED. Whether it has been paid is a separate
 * fact this model does not carry, and booking it as though the bank had
 * already moved would misstate the cash position.
 */
/** An expense as this bridge reads it. */
export interface ExpenseForPosting {
  /* The two development dimensions, carried onto every line of the entry so
     "what did the foundations come to" is a query. See the JournalLine model. */
  readonly costCodeId?: string | null;
  readonly projectId?: string | null;
  readonly id: string;
  readonly amount: unknown;
  readonly category?: string | null;
  readonly currency?: string | null;
  readonly detail?: string | null;
  readonly spentOn?: Date | null;
  readonly siteId?: string | null;
  readonly partyId?: string | null;
}

export async function postForExpense(
  db: Db,
  { orgId, expense, userId }:
    { orgId: string; expense: ExpenseForPosting; userId?: string | null },
): Promise<PostingResult> {
  const chart = await chartFor(db, orgId);
  if (!chart) return skip("no chart of accounts — seed one to book expenses automatically");

  const amount = big(expense.amount);
  if (amount <= 0n) return skip("an expense of nothing has nothing to book");

  const code = BY_CATEGORY[String(expense.category || "").toLowerCase()] || ACCOUNTS.otherExpense;
  const cost = usable(chart, code) || usable(chart, ACCOUNTS.otherExpense);
  const payable = usable(chart, ACCOUNTS.payable);
  if (!cost) return skip(`account ${code} is missing or closed to postings`);
  if (!payable) return skip(`account ${ACCOUNTS.payable} is missing or closed to postings`);

  return book(db, {
    orgId, sourceType: "expense", sourceId: expense.id,
    date: expense.spentOn || new Date(),
    memo: expense.detail || "Expense",
    currency: expense.currency,
    /*
     * An expense already names its property and its vendor. It now also names
     * its development and its cost code, and BOTH lines carry them — the cost
     * side so spend groups by code, and the payable side so the same grouping
     * works from what is still owed rather than only from what is booked.
     */
    lines: [
      { accountId: cost.id, debit: Number(amount), memo: expense.category || "",
        siteId: expense.siteId || null,
        projectId: expense.projectId || null, costCodeId: expense.costCodeId || null },
      /* What is owed to the vendor is the vendor's line. */
      { accountId: payable.id, credit: Number(amount), memo: expense.detail || "",
        siteId: expense.siteId || null, partyId: expense.partyId || null,
        projectId: expense.projectId || null, costCodeId: expense.costCodeId || null },
    ],
    userId,
  });
}

/* ====================================================================== *
 * UNDOING ONE
 * ====================================================================== */

/**
 * Reverse whatever a business row was booked as.
 *
 * Voiding a payment does not delete its entry — the ledger has no such
 * operation and should not. It posts the mirror, so the original, the
 * correction and the stated reason are all in the history.
 */
export async function reverseFor(
  db: Db,
  { orgId, sourceType, sourceId, reason, userId }: {
    orgId: string; sourceType: string; sourceId: string;
    reason?: string | null; userId?: string | null;
  },
): Promise<PostingResult> {
  const original = await db.journalEntry.findFirst({
    where: { orgId, sourceType, sourceId, status: "POSTED" },
    select: { id: true, ref: true },
  });
  if (!original) return skip("this was never booked, so there is nothing to reverse");

  try {
    const entry = await reverseJournal(db, {
      orgId, entryId: original.id,
      ref: await nextJournalRef(db, orgId),
      date: new Date(),
      reason: reason || "Voided",
      postedById: userId || null,
    });
    return { posted: entry, skipped: null, reversed: original.ref };
  } catch (e) {
    if (e instanceof LedgerError) return skip(e.message);
    throw e;
  }
}
