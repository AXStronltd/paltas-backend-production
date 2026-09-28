/* ======================================================================
 * RENT THAT RAISES ITSELF.
 *
 * ── WHAT WAS MISSING ───────────────────────────────────────────────────
 *
 * Lease has carried a rent figure from the beginning, and nothing said WHEN it
 * was owed. So nothing could raise it: every rent invoice was typed by hand,
 * for every unit, every month, for ever. It is the single largest piece of
 * manual work PALTAS was asking a letting business to keep doing.
 *
 * ── RAISED ONCE, WHATEVER HAPPENS ──────────────────────────────────────
 *
 * The scheduler's claim guarantees one RUN per period. It does NOT guarantee
 * that a run which died half way does not redo the leases it already reached,
 * and that is the one that is about money.
 *
 * So each lease's month is recorded in RentCharge, whose
 * (orgId, leaseId, periodKey) is unique in the database, and the row is
 * written IN THE SAME TRANSACTION as the invoice. A second attempt at a month
 * already charged is refused by Postgres rather than by a query that raced.
 * A lease that fails is skipped and the rest of the run carries on.
 *
 * ── IT IS OFF UNTIL A COMPANY ASKS FOR IT ──────────────────────────────
 *
 * `Organization.autoRent` is false by default. Every company using PALTAS
 * today invoices rent by hand, and PALTAS cannot see what was billed outside
 * it — so switching this on for everybody at once would raise the current
 * month a second time for every tenant whose invoice was already typed.
 *
 * ── IT NEVER INVENTS HISTORY ───────────────────────────────────────────
 *
 * A run raises rent for the period it is in and no other. Deploying in the
 * middle of October raises October, not October and every month since the
 * lease began — a system that quietly bills somebody eight months of arrears
 * because it was switched on is worse than one that bills nothing.
 *
 * ── THE AMOUNT IS COPIED, NOT REFERENCED ───────────────────────────────
 *
 * What was charged is written onto the RentCharge as well as the invoice. A
 * rent review changes the lease; it must not change what last March says.
 * ====================================================================== */

import type { Db } from "../db.ts";
import type { $Enums, Prisma } from "@prisma/client";
import { LIVE_LEASE_STATES } from "./occupancy.ts";
import { postForInvoice } from "./posting.ts";

/** The month a run covers: "2026-10". */
export const rentPeriod = (now: Date) => now.toISOString().slice(0, 7);

/** First instant of a period, in UTC. */
export function periodStart(periodKey: string): Date {
  const [y, m] = periodKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
}

/** Last instant of a period, in UTC. */
export function periodEnd(periodKey: string): Date {
  const [y, m] = periodKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0, 23, 59, 59, 999));
}

/**
 * THE DAY RENT FALLS DUE, in a month that may be too short for it.
 *
 * A lease due on the 31st is due on the 30th in April and the 28th in
 * February. The alternative — skipping the month, or rolling into the next —
 * means a tenant is never billed in February, which is the kind of thing
 * nobody notices for a year.
 */
export function dueDate(periodKey: string, rentDay: number): Date {
  const [y, m] = periodKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const day = Math.min(Math.max(Math.trunc(rentDay) || 1, 1), lastDay);
  return new Date(Date.UTC(y!, m! - 1, day));
}

/** Whole months from one period to another. */
function monthsBetween(from: Date, periodKey: string): number {
  const [y, m] = periodKey.split("-").map(Number);
  return (y! - from.getUTCFullYear()) * 12 + (m! - 1 - from.getUTCMonth());
}

export interface LeaseForRent {
  readonly id: string;
  readonly rent: bigint;
  readonly currency: string;
  readonly rentDay: number;
  readonly billing: $Enums.LeaseBilling;
  readonly startsOn: Date | null;
  readonly endsOn: Date | null;
  readonly status: $Enums.LeaseStatus;
}

/**
 * IS RENT DUE ON THIS LEASE, IN THIS MONTH?
 *
 * Four questions, and each of them has bitten somebody:
 *
 *   · Is the lease live? ACTIVE and NOTICE both are — a tenant serving notice
 *     still owes rent, and that is why LIVE_LEASE_STATES is shared with
 *     occupancy rather than restated here.
 *   · Had it started? A lease beginning in November owes nothing in October.
 *   · Had it ended? One that ended in September owes nothing in October.
 *     A lease ending mid-October is still charged for October — stopping rent
 *     because the month is not finished would be the wrong way round.
 *   · Is this one of ITS months? Quarterly and yearly leases are counted from
 *     the month they started, not from January.
 */
export function rentDueIn(lease: LeaseForRent, periodKey: string): boolean {
  if (!LIVE_LEASE_STATES.includes(lease.status)) return false;
  if (lease.rent <= 0n) return false;

  const start = periodStart(periodKey);
  const end = periodEnd(periodKey);

  if (lease.startsOn && lease.startsOn > end) return false;
  if (lease.endsOn && lease.endsOn < start) return false;

  if (lease.billing === "MONTHLY") return true;

  /* A lease with no start date has no anchor to count quarters from. Charging
     it monthly would be a guess, so it is left for a person. */
  if (!lease.startsOn) return false;

  const months = monthsBetween(lease.startsOn, periodKey);
  if (months < 0) return false;
  return lease.billing === "QUARTERLY" ? months % 3 === 0 : months % 12 === 0;
}

export interface RentRunResult {
  readonly periodKey: string;
  readonly scanned: number;
  readonly raised: number;
  readonly skipped: number;
  readonly notes: readonly string[];
}

/**
 * RAISE THIS PERIOD'S RENT.
 *
 * `orgId` narrows it to one company, for a person who wants to run their own
 * without touching anybody else's.
 */
export async function runRent(
  db: Db, { periodKey, orgId = null, userId = null }:
  { periodKey: string; orgId?: string | null; userId?: string | null },
): Promise<RentRunResult> {
  const end = periodEnd(periodKey);

  const leases = await db.lease.findMany({
    where: {
      status: { in: [...LIVE_LEASE_STATES] },
      rent: { gt: 0 },
      ...(orgId ? { orgId } : {}),
      /*
       * ONLY COMPANIES THAT ASKED FOR IT.
       *
       * Every company on PALTAS today raises rent by hand. Charging all of
       * them the moment this ships would bill this month a second time for
       * every tenant whose invoice was already typed, and PALTAS cannot see
       * what was billed outside it. So a company opts in when its leases carry
       * the right day and amount and it has stopped invoicing by hand.
       */
      org: { autoRent: true },
      /* Not started yet, or already over, decided in Postgres so a portfolio
         of ten thousand leases is not read to reject most of them. */
      OR: [{ startsOn: null }, { startsOn: { lte: end } }],
    },
    select: {
      id: true, orgId: true, ref: true, rent: true, currency: true,
      rentDay: true, billing: true, startsOn: true, endsOn: true, status: true,
      tenantId: true, unitRef: true,
    },
  });

  const notes: string[] = [];
  let raised = 0, skipped = 0, scanned = 0;

  for (const lease of leases) {
    if (!rentDueIn(lease, periodKey)) continue;
    scanned += 1;
    try {
      const out = await raiseOne(db, lease, periodKey, userId);
      if (out.raised) raised += 1; else skipped += 1;
      /* Rent was raised but not booked — a real thing to know, and not a
         failure of the run. Reported once per reason rather than once per
         lease, or a portfolio with no chart of accounts fills the record. */
      if (out.notBooked && !notes.includes(out.notBooked)) notes.push(out.notBooked);
    } catch (e) {
      skipped += 1;
      /* One lease must not stop the rest of a portfolio, let alone the rest of
         the platform. Named, so somebody can go and look at it. */
      if (notes.length < 20) {
        notes.push(`${lease.ref}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { periodKey, scanned, raised, skipped, notes };
}

interface LeaseRow extends LeaseForRent {
  readonly orgId: string;
  readonly ref: string;
  readonly tenantId: string | null;
  readonly unitRef: string;
}

/**
 * ONE LEASE, ONE MONTH.
 *
 * Returns false when the month was already charged — which is an ordinary
 * outcome on a re-run, not a failure.
 *
 * The invoice, its line and the RentCharge are written in ONE transaction. If
 * any of them fails, none of them happened, and the month is still chargeable.
 * Writing the charge afterwards would leave an invoice nothing records, which
 * is exactly how a tenant gets billed twice.
 */
interface RaiseOutcome {
  /** False when the month was already charged — ordinary on a re-run. */
  readonly raised: boolean;
  /** Why the ledger entry did not happen, when it did not. */
  readonly notBooked: string | null;
}

async function raiseOne(
  db: Db, lease: LeaseRow, periodKey: string, userId: string | null,
): Promise<RaiseOutcome> {
  const already = await db.rentCharge.findUnique({
    where: { orgId_leaseId_periodKey: { orgId: lease.orgId, leaseId: lease.id, periodKey } },
    select: { id: true },
  });
  if (already) return { raised: false, notBooked: null };

  const due = dueDate(periodKey, lease.rentDay);
  const detail = `Rent — ${monthName(periodKey)}${lease.unitRef ? `, ${lease.unitRef}` : ""}`;

  let invoiceId: string | null = null;
  try {
    invoiceId = await db.$transaction(async (tx) => {
      const ref = await nextInvoiceRef(tx, lease.orgId);
      const invoice = await tx.invoice.create({
        data: {
          orgId: lease.orgId, ref,
          partyId: lease.tenantId, leaseId: lease.id,
          source: "lease", sourceId: lease.id,
          currency: lease.currency,
          issuedOn: periodStart(periodKey), dueOn: due,
          /* Raised, not drafted. A draft owes nothing, appears in no arrears
             and posts to no ledger, which would make the whole run decorative.
             The total is the line's, computed here rather than sent — the same
             rule recomputeInvoice keeps. */
          status: "SENT",
          total: lease.rent, paid: 0n,
          note: `Raised automatically for ${periodKey}.`,
          lines: {
            /* A line carries no orgId: it belongs to its invoice, and the
               invoice belongs to the company. */
            create: [{ detail, quantity: 1, unitPrice: lease.rent, taxBps: 0 }],
          },
        },
        select: { id: true },
      });

      /* The guarantee. Same transaction, so an invoice without a charge — or a
         charge without an invoice — cannot exist. */
      await tx.rentCharge.create({
        data: {
          orgId: lease.orgId, leaseId: lease.id, periodKey,
          invoiceId: invoice.id, amount: lease.rent,
          currency: lease.currency, dueOn: due,
        },
      });

      return invoice.id;
    });
  } catch (e) {
    /*
     * Another run got there first. The unique index did its job, and this is
     * the ordinary outcome of two attempts at one month — not an error worth
     * telling anybody about.
     */
    if (isUniqueViolation(e)) return { raised: false, notBooked: null };
    throw e;
  }

  /*
   * AND BOOK IT — after the invoice exists, never before.
   *
   * postForInvoice does not throw: no chart of accounts, a closed period or a
   * foreign currency all come back as a stated reason. Rent that was raised
   * must not be un-raised because the books are not set up yet.
   */
  const full = await db.invoice.findFirst({
    where: { id: invoiceId, orgId: lease.orgId }, include: { lines: true },
  });
  let notBooked: string | null = null;
  if (full) {
    const booked = await postForInvoice(db, { orgId: lease.orgId, invoice: full, userId });
    notBooked = booked.skipped || null;
  }
  return { raised: true, notBooked };
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];

function monthName(periodKey: string): string {
  const [y, m] = periodKey.split("-").map(Number);
  return `${MONTHS[(m! - 1) % 12]} ${y}`;
}

function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && "code" in e
    && (e as { code?: unknown }).code === "P2002");
}

/**
 * THE NEXT INVOICE REFERENCE FOR THIS COMPANY.
 *
 * DELIBERATELY THE SAME MECHANISM THE REST OF PALTAS USES. The registry numbers
 * a new invoice from a Counter row named `invoices:<orgId>` and formats it
 * INV-0001 (http/resource.ts, nextNumber). A rent run inventing its own scheme
 * — INV-2026-0001, say — would give one company two sequences for one kind of
 * document, and the first time somebody sorted their invoices they would find
 * two of everything interleaved.
 *
 * Taken inside the transaction, so two leases in the same run cannot be handed
 * the same number: `@@unique([orgId, ref])` would refuse the second and lose
 * that lease a month's rent.
 */
async function nextInvoiceRef(tx: Prisma.TransactionClient, orgId: string): Promise<string> {
  const name = `invoices:${orgId}`;
  const row = await tx.counter.upsert({
    where: { name },
    create: { name, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `INV-${String(row.value).padStart(4, "0")}`;
}
