/* ======================================================================
 * WHAT IS OWED, AND HOW LATE IT IS.
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────
 *
 * The Collections screen was built on the premise that a receivable IS a
 * transaction: it read the merged cash list and filtered `flow === "in"`.
 * Every row that survives that filter is a PAYMENT — money that has already
 * arrived — so Outstanding, Overdue, the aging buckets and every tenant
 * balance were structurally zero for real data. Not wrong by a little: zero,
 * always, for every company.
 *
 * A receivable is not a payment. It is an INVOICE that has not been paid in
 * full, which is a different table and the opposite state.
 *
 * ── NOTHING HERE IS STORED, AND THAT IS THE DESIGN ─────────────────────
 *
 * `Invoice.total` and `Invoice.paid` are computed by the server on every
 * write and cannot be sent by a client (see recomputeInvoice). Open balance
 * is their difference. So AR needs no table of its own, and cannot drift from
 * the invoices it describes — which is the failure of every system that keeps
 * a second copy of the balance.
 *
 * ── WHY AGING IS COMPUTED FROM `dueOn` AND NOT FROM `status` ───────────
 *
 * recomputeInvoice DOES set OVERDUE, but only when something recomputes the
 * invoice. An invoice that quietly passes its due date with no payment
 * activity is never touched again, so its status still reads SENT. PALTAS has
 * no scheduler, so there is nothing to sweep them.
 *
 * Reading `status` would therefore under-report arrears — the one number a
 * landlord checks first. Aging is measured from `dueOn` against the date
 * asked for, every time. A status column whose truth depends on today's date
 * is always stale, and deriving it is cheaper than a nightly job.
 *
 * ── CURRENCIES ARE NEVER ADDED TOGETHER ────────────────────────────────
 *
 * A company can hold property in more than one country, so its receivables
 * can be in more than one currency. Totals are reported PER CURRENCY and the
 * report says when it found more than one. There is no exchange-rate source
 * in PALTAS and this file does not invent one.
 * ====================================================================== */

import type { Db } from "../db.ts";
import type { $Enums } from "@prisma/client";

/** A day, in milliseconds. Aging is whole days, never fractions. */
const DAY = 86_400_000;

/**
 * THE BUCKETS.
 *
 * `CURRENT` is not yet due. `DUE` is due today. Everything after is late by
 * the number of days it is late, which is what a collections call is about.
 */
export type Bucket = "CURRENT" | "DUE" | "D1_30" | "D31_60" | "D61_90" | "D90_PLUS";

export const BUCKETS: ReadonlyArray<{ key: Bucket; label: string }> = [
  { key: "CURRENT", label: "Not yet due" },
  { key: "DUE", label: "Due today" },
  { key: "D1_30", label: "1 – 30 days" },
  { key: "D31_60", label: "31 – 60 days" },
  { key: "D61_90", label: "61 – 90 days" },
  { key: "D90_PLUS", label: "Over 90 days" },
];

/** Which bucket a number of days late falls in. */
export function bucketFor(daysLate: number): Bucket {
  if (daysLate < 0) return "CURRENT";
  if (daysLate === 0) return "DUE";
  if (daysLate <= 30) return "D1_30";
  if (daysLate <= 60) return "D31_60";
  if (daysLate <= 90) return "D61_90";
  return "D90_PLUS";
}

/**
 * Whole days between two dates, by CALENDAR DAY rather than elapsed time.
 *
 * An invoice due yesterday at 09:00 is one day late at 08:00 this morning,
 * not zero. Comparing timestamps would say zero and quietly keep it out of
 * arrears for most of a working day.
 */
function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / DAY);
}

/** One open invoice. Money as decimal strings — BigInt does not survive JSON. */
export interface Receivable {
  readonly invoiceId: string;
  readonly ref: string;
  readonly partyId: string | null;
  readonly partyName: string;
  readonly currency: string;
  readonly total: string;
  readonly paid: string;
  /** total − paid. Always greater than zero, or it would not be here. */
  readonly open: string;
  readonly issuedOn: Date | null;
  readonly dueOn: Date | null;
  /** Negative when not yet due, 0 on the day, positive when late. */
  readonly daysLate: number | null;
  readonly bucket: Bucket;
  readonly status: $Enums.InvoiceStatus;
  readonly leaseId: string | null;
  readonly contractId: string | null;
}

export interface AgingRow {
  readonly bucket: Bucket;
  readonly label: string;
  readonly count: number;
  readonly amount: string;
}

/** What one tenant, buyer or owner owes across all their open invoices. */
export interface PartyBalance {
  readonly partyId: string | null;
  readonly name: string;
  readonly currency: string;
  readonly open: string;
  readonly invoiceCount: number;
  /** The worst of their invoices, which is what decides who to ring first. */
  readonly oldestDaysLate: number;
  readonly bucket: Bucket;
}

/** Everything reported in one currency. Currencies are never mixed. */
export interface CurrencyBook {
  readonly currency: string;
  readonly open: string;
  readonly notYetDue: string;
  readonly overdue: string;
  readonly aging: readonly AgingRow[];
  readonly parties: readonly PartyBalance[];
}

export interface ReceivablesReport {
  readonly asAt: Date;
  readonly books: readonly CurrencyBook[];
  readonly invoices: readonly Receivable[];
  /** True when more than one currency is owed. Nothing is converted. */
  readonly mixed: boolean;
  readonly invoiceCount: number;
}

export interface ReceivablesQuery {
  readonly orgId: string;
  /** The date arrears are measured against. Defaults to now. */
  readonly asAt?: Date | null;
  readonly partyId?: string | null;
  readonly siteId?: string | null;
  readonly unitId?: string | null;
}

/*
 * A DRAFT IS NOT OWED AND A VOID IS NOT OWED.
 *
 * Both are decisions rather than states money put the invoice in — an unsent
 * invoice has not been asked for, and a cancelled one has been withdrawn.
 * Counting either as arrears would invent a debt.
 */
const NOT_OWED: ReadonlySet<string> = new Set(["DRAFT", "VOID"]);

/**
 * WHAT IS OWED.
 *
 * One query for the invoices, one for the leases when a property filter is
 * asked for. An open invoice is `total > paid`; the filter is applied in
 * Postgres rather than by reading every invoice this company ever raised.
 */
export async function receivables(
  db: Db, q: ReceivablesQuery,
): Promise<ReceivablesReport> {
  const asAt = q.asAt || new Date();

  /*
   * A PROPERTY FILTER REACHES AN INVOICE THROUGH ITS LEASE.
   *
   * An invoice names a lease, and a lease names a unit, and a unit names a
   * site — there is no siteId on an invoice and putting one there would be a
   * second place for the same fact to be wrong. So the leases are resolved
   * first and the invoices asked for by lease.
   */
  let leaseIds: string[] | null = null;
  if (q.siteId || q.unitId) {
    const leases = await db.lease.findMany({
      where: {
        orgId: q.orgId,
        ...(q.unitId ? { unitId: q.unitId } : {}),
        ...(q.siteId ? { unit: { siteId: q.siteId } } : {}),
      },
      select: { id: true },
    });
    leaseIds = leases.map((l) => l.id);
    /* No lease there means nothing is owed there — not "no filter". */
    if (leaseIds.length === 0) {
      return { asAt, books: [], invoices: [], mixed: false, invoiceCount: 0 };
    }
  }

  const rows = await db.invoice.findMany({
    where: {
      orgId: q.orgId,
      status: { notIn: [...NOT_OWED] as $Enums.InvoiceStatus[] },
      ...(q.partyId ? { partyId: q.partyId } : {}),
      ...(leaseIds ? { leaseId: { in: leaseIds } } : {}),
    },
    select: {
      id: true, ref: true, partyId: true, currency: true,
      total: true, paid: true, credited: true, issuedOn: true, dueOn: true, status: true,
      leaseId: true, contractId: true,
      party: { select: { name: true } },
    },
    orderBy: [{ dueOn: "asc" }, { ref: "asc" }],
  });

  const open: Receivable[] = [];
  for (const r of rows) {
    /*
     * LESS WHAT WAS WAIVED. A credit note is not money, so it is not in
     * `paid` — but it is very much not owed either, and arrears that chase a
     * bill the company itself withdrew are worse than arrears that are wrong
     * by the same amount: somebody gets a letter about it.
     */
    const owing = r.total - r.paid - r.credited;
    /* Nothing owed is not a receivable. An OVERPAYMENT is not a negative
       receivable either — it is a credit, and netting it against somebody
       else's arrears is how a statement stops being true. */
    if (owing <= 0n) continue;

    const daysLate = r.dueOn ? daysBetween(r.dueOn, asAt) : null;
    open.push({
      invoiceId: r.id, ref: r.ref,
      partyId: r.partyId, partyName: r.party?.name || "—",
      currency: (r.currency || "").toUpperCase(),
      total: r.total.toString(), paid: r.paid.toString(), open: owing.toString(),
      issuedOn: r.issuedOn, dueOn: r.dueOn,
      daysLate,
      /* An invoice with no due date cannot be late. It is owed, and it sits in
         CURRENT until somebody dates it, rather than being called arrears on
         the strength of a date nobody set. */
      bucket: daysLate === null ? "CURRENT" : bucketFor(daysLate),
      status: r.status,
      leaseId: r.leaseId, contractId: r.contractId,
    });
  }

  return {
    asAt,
    books: booksOf(open),
    invoices: open,
    mixed: new Set(open.map((o) => o.currency)).size > 1,
    invoiceCount: open.length,
  };
}

/** Group into one book per currency. Nothing crosses a currency. */
function booksOf(open: readonly Receivable[]): CurrencyBook[] {
  const byCurrency = new Map<string, Receivable[]>();
  for (const o of open) {
    const list = byCurrency.get(o.currency);
    if (list) list.push(o); else byCurrency.set(o.currency, [o]);
  }

  const books: CurrencyBook[] = [];
  for (const [currency, list] of [...byCurrency].sort((a, b) => a[0].localeCompare(b[0]))) {
    let total = 0n, notYetDue = 0n, overdue = 0n;
    const counts = new Map<Bucket, { count: number; amount: bigint }>();

    for (const o of list) {
      const amount = BigInt(o.open);
      total += amount;
      if (o.bucket === "CURRENT") notYetDue += amount; else overdue += amount;
      const cell = counts.get(o.bucket) || { count: 0, amount: 0n };
      cell.count += 1; cell.amount += amount;
      counts.set(o.bucket, cell);
    }

    /* Every bucket is reported, including the empty ones — a row that
       disappears when it reaches zero makes an aging profile impossible to
       read across two dates. */
    const aging: AgingRow[] = BUCKETS.map(({ key, label }) => {
      const cell = counts.get(key);
      return { bucket: key, label, count: cell?.count || 0, amount: (cell?.amount || 0n).toString() };
    });

    books.push({
      currency,
      open: total.toString(),
      notYetDue: notYetDue.toString(),
      overdue: overdue.toString(),
      aging,
      parties: partiesOf(list, currency),
    });
  }
  return books;
}

/** Who owes what, worst first — which is the order somebody works in. */
function partiesOf(list: readonly Receivable[], currency: string): PartyBalance[] {
  const by = new Map<string, { name: string; open: bigint; count: number; worst: number }>();
  for (const o of list) {
    /* An invoice with no party still has to appear somewhere, or the parties
       will not add up to the total and nobody will know why. */
    const key = o.partyId || "";
    const cell = by.get(key) || { name: o.partyName, open: 0n, count: 0, worst: Number.NEGATIVE_INFINITY };
    cell.open += BigInt(o.open);
    cell.count += 1;
    if (o.daysLate !== null && o.daysLate > cell.worst) cell.worst = o.daysLate;
    by.set(key, cell);
  }

  return [...by].map(([partyId, cell]) => {
    const worst = cell.worst === Number.NEGATIVE_INFINITY ? -1 : cell.worst;
    return {
      partyId: partyId || null, name: cell.name, currency,
      open: cell.open.toString(), invoiceCount: cell.count,
      oldestDaysLate: worst,
      bucket: bucketFor(worst),
    };
  }).sort((a, b) =>
    /* Latest first, then largest — a big arrear at 90 days outranks a small
       one, and both outrank anything not yet due. */
    b.oldestDaysLate - a.oldestDaysLate || (BigInt(b.open) > BigInt(a.open) ? 1 : -1));
}
