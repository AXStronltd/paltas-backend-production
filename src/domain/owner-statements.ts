/* ======================================================================
 * WHAT WE COLLECTED, WHAT WE SPENT, WHAT WE KEPT, WHAT YOU ARE OWED.
 *
 * A managing agent does not own the building. It collects the rent, pays the
 * costs, keeps a fee and sends the rest on — and once a month it has to show
 * the owner the arithmetic. An owner who cannot see that arithmetic has no way
 * to tell a fee from a mistake.
 *
 * ── WHY THE ROUTE DOES NOT JUST ADD THINGS UP ─────────────────────────
 *
 * Four decisions in here are each a way to be quietly wrong about somebody
 * else's money, so each is in one place with its reasoning beside it:
 *
 *   WHOSE RENT IS THIS      an agreement covers a site or ONE unit of it, and
 *                           an agent managing one flat in a block must not be
 *                           credited with the block's rent
 *   COLLECTED vs BILLED     they differ by exactly the arrears, which is the
 *                           number an owner and an agent argue about
 *   WHAT THE FEE IS OF      three real contracts, not interchangeable
 *   WHICH COSTS             only what somebody marked recoverable, and the
 *                           rest reported rather than silently absorbed
 *
 * ── AND WHY IT IS FROZEN ──────────────────────────────────────────────
 *
 * The owner is holding a copy. If the figures recomputed later — an invoice
 * credited, an expense re-categorised, a lease backdated — our copy and theirs
 * would stop agreeing, and theirs is the one in the email. So the computation
 * below produces a PREVIEW, and issuing writes every line down.
 * ====================================================================== */

import { badRequest } from "../http/errors.ts";

export type Basis = "COLLECTED" | "BILLED" | "FIXED";

export interface AgreementForStatement {
  readonly id: string;
  readonly basis: string;
  readonly feeBps: number;
  readonly feeFixed: bigint;
  readonly currency: string;
  readonly siteId: string | null;
  readonly unitId: string | null;
  readonly status: string;
  readonly startsOn: Date | null;
  readonly endsOn: Date | null;
}

/** A line of the statement, before it is written down. */
export interface DraftLine {
  readonly at: Date;
  readonly kind: "RENT" | "SERVICE_CHARGE" | "OTHER_INCOME" | "COST" | "FEE" | "PAYOUT";
  readonly detail: string;
  /** Signed: positive is due to the owner, negative is taken off. */
  readonly amount: bigint;
  readonly sourceType?: string;
  readonly sourceId?: string;
  readonly ref?: string;
}

export interface Totals {
  readonly collected: bigint;
  readonly billed: bigint;
  readonly costs: bigint;
  readonly fee: bigint;
  readonly net: bigint;
  readonly opening: bigint;
  readonly paidOut: bigint;
  readonly closing: bigint;
  readonly costsLeftOff: number;
  readonly costsLeftOffTotal: bigint;
}

/* ---------------------------------------------------------------- *
 * THE FEE
 * ---------------------------------------------------------------- */

/**
 * WHAT THE COMPANY KEEPS, and the only part of a statement that is its own
 * revenue.
 *
 * Rounded DOWN, deliberately and in the owner's favour. A half-cent has to go
 * somewhere, and the party that wrote the contract and does the arithmetic is
 * not the party it should go to.
 */
export function feeOn(
  agreement: Pick<AgreementForStatement, "basis" | "feeBps" | "feeFixed">,
  { collected, billed }: { collected: bigint; billed: bigint },
): bigint {
  if (agreement.basis === "FIXED") {
    const flat = agreement.feeFixed;
    return flat > 0n ? flat : 0n;
  }
  const bps = BigInt(Math.max(0, Math.round(agreement.feeBps)));
  if (bps <= 0n) return 0n;
  /*
   * COLLECTED is the default and the common contract: no rent collected, no
   * fee. BILLED pays the agent for letting the unit rather than for chasing
   * it, and is the arrangement that can leave an owner paying a fee on money
   * nobody received — which is exactly why the statement shows both figures.
   */
  const base = agreement.basis === "BILLED" ? billed : collected;
  if (base <= 0n) return 0n;
  /* Integer arithmetic throughout. Never Number(): a KES portfolio passes
     2^53 minor units long before it passes anything else. */
  return (base * bps) / 10_000n;
}

/**
 * The period's arithmetic, in the order the document reads.
 *
 * `net` is what the period produced; `closing` is what is still owed once the
 * balance brought forward and the money already sent are taken into account.
 * They are different numbers and an owner needs both: one answers "what did
 * September come to", the other "what do you owe me".
 */
export function totalsFor({
  collected, billed, costs, fee, opening, paidOut, costsLeftOff, costsLeftOffTotal,
}: {
  collected: bigint; billed: bigint; costs: bigint; fee: bigint;
  opening: bigint; paidOut: bigint;
  costsLeftOff: number; costsLeftOffTotal: bigint;
}): Totals {
  const net = collected - costs - fee;
  return {
    collected, billed, costs, fee, net, opening, paidOut,
    closing: opening + net - paidOut,
    costsLeftOff, costsLeftOffTotal,
  };
}

/**
 * The statement's own lines must add up to its own net. Checked rather than
 * trusted, because the two are built by different code paths and a statement
 * whose lines disagree with its total is the one an owner will find.
 */
export function linesAgree(lines: readonly DraftLine[], totals: Totals): boolean {
  const sum = lines
    .filter((l) => l.kind !== "PAYOUT")
    .reduce((t, l) => t + l.amount, 0n);
  return sum === totals.net;
}

/* ---------------------------------------------------------------- *
 * WHAT A PERIOD IS
 * ---------------------------------------------------------------- */

/**
 * A month, as a pair of instants: [first moment of the month, first moment of
 * the next).
 *
 * HALF-OPEN, which is the only way to tile months without a gap or an overlap.
 * A statement built with an inclusive end date on the last day of the month
 * loses everything that happened after midnight on the 31st — or counts it
 * twice, if the next statement starts on the 31st.
 */
export function monthRange(periodKey: string): { from: Date; to: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodKey || "").trim());
  if (!m) {
    throw badRequest(
      "A period is a month, written as 2026-09. A statement covers one period, "
      + "and an owner comparing two of them has to be able to tell which.");
  }
  const year = Number(m[1]), month = Number(m[2]);
  if (month < 1 || month > 12) throw badRequest(`There is no month ${m[2]}.`);
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    to: new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1)),
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"];

/** "2026-09" -> "September 2026", for the document's own heading. */
export function periodName(periodKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodKey || ""));
  if (!m) return String(periodKey || "");
  const i = Number(m[2]) - 1;
  return i >= 0 && i < 12 ? `${MONTHS[i]} ${m[1]}` : String(periodKey);
}

/* ---------------------------------------------------------------- *
 * THE REFUSALS
 * ---------------------------------------------------------------- */

/** Why no statement can be issued for this agreement — or null. */
export function whyNotIssuable(
  agreement: AgreementForStatement,
  { from, to }: { from: Date; to: Date },
): string | null {
  if (agreement.status === "DRAFT") {
    return "That agreement is still a draft. A statement issued under one "
         + "nobody has agreed to is a document the owner never consented to "
         + "the terms of.";
  }
  if (!agreement.siteId) {
    return "That agreement does not say which property it covers — the property "
         + "it named has been deleted. There is no way to tell whose rent is "
         + "whose, and a statement would be a guess with a reference number on it.";
  }
  /*
   * A PERIOD OUTSIDE THE AGREEMENT IS NOT A PERIOD THE AGREEMENT EXPLAINS.
   *
   * Billing an owner a management fee for a month before they engaged the
   * company, or after they left, is charging for work nobody asked for. The
   * comparison is against the half-open period: an agreement that ended on the
   * 1st covers nothing in that month.
   */
  if (agreement.startsOn && agreement.startsOn >= to) {
    return `That agreement does not start until `
         + `${agreement.startsOn.toISOString().slice(0, 10)}, which is after this `
         + `period ends. There is nothing it can account for.`;
  }
  if (agreement.endsOn && agreement.endsOn <= from) {
    return `That agreement ended on ${agreement.endsOn.toISOString().slice(0, 10)}, `
         + `before this period began.`;
  }
  return null;
}

export function requireIssuable(
  agreement: AgreementForStatement, range: { from: Date; to: Date },
): void {
  const why = whyNotIssuable(agreement, range);
  if (why) throw badRequest(why);
}

/**
 * Why this is not a usable agreement to write down — or null.
 *
 * Checked at create and at every edit, because a fee rate that drifts out of
 * range between the two is a fee somebody will be charged.
 */
export function whyNotAnAgreement(
  { basis, feeBps, feeFixed, siteId, unitId }: {
    basis?: string | null; feeBps?: number | null; feeFixed?: number | null;
    siteId?: string | null; unitId?: string | null;
  },
): string | null {
  /*
   * A PROPERTY, ALWAYS — and a unit only to NARROW it.
   *
   * An agent managing a single flat is managing a flat in a building, so the
   * property is known either way. Making the site the required half and the
   * unit the optional narrowing removes a "one of two" invariant that nothing
   * could express, and leaves one question to answer: whose rent is this.
   */
  if (!siteId) {
    return "An agreement has to say which property it covers. Without that, "
         + "nothing can decide whose rent it accounts for — and if it is one "
         + "unit of that property, name the unit as well.";
  }
  const b = String(basis || "COLLECTED");
  if (b !== "COLLECTED" && b !== "BILLED" && b !== "FIXED") {
    return `${b} is not a fee basis. A fee is a share of what was collected, a `
         + `share of what was billed, or a flat amount.`;
  }
  if (b === "FIXED") {
    if (!feeFixed || Math.round(Number(feeFixed)) <= 0) {
      return "A fixed fee needs an amount. A flat fee of nothing is a free "
           + "mandate, which is a thing to write down deliberately rather than "
           + "by leaving a box empty.";
    }
  } else {
    const bps = Math.round(Number(feeBps || 0));
    if (bps < 0) return "A fee rate cannot be negative.";
    /*
     * A CEILING, BECAUSE THE TYPO IS SILENT.
     *
     * Basis points catch people out: somebody meaning 10% types 10 and is paid
     * 0.1%, or means 1000 and types 10000 and takes the entire rent. The
     * second is the one that matters, and 50% is far above any real management
     * fee — letting fees reach 10% of rent, block management rather less.
     */
    if (bps > 5_000) {
      return `${bps} basis points is ${(bps / 100).toFixed(2)}% of the rent. `
           + `A management fee above 50% is almost always a basis-point typo — `
           + `10% is 1000, not 10000.`;
    }
  }
  return null;
}

export function requireAnAgreement(input: Parameters<typeof whyNotAnAgreement>[0]): void {
  const why = whyNotAnAgreement(input);
  if (why) throw badRequest(why);
}
