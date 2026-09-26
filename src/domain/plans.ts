/* ======================================================================
 * PAYMENT PLANS, AND THE ONE THING THEY MUST NEVER GET WRONG.
 *
 * Ported from paltas-dev-core's `buildPlan`. The arithmetic is carried
 * across exactly, including where the rounding goes; only the money type
 * changes, from its Money wrapper to the BigInt minor units this service
 * already uses everywhere.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────
 *
 * The instalments add up to the contract price EXACTLY.
 *
 * Not approximately, and not after somebody adjusts the last figure by
 * hand. A plan that totals one shilling more than the price means a buyer
 * who pays every instalment in full still owes money and cannot complete;
 * one shilling less means a flat is handed over with a balance nobody will
 * ever collect. Both are discovered at the worst possible moment — at
 * handover, in front of the buyer.
 *
 * So the division is integer, and the LAST instalment carries the
 * remainder. That is dev-core's rule and it is the right one: the error
 * lands in one place, deliberately, rather than being spread across twelve
 * lines where it compounds.
 *
 * ── WHY A CONSTRUCTION-LINKED LINE HAS NO DATE ────────────────────────
 *
 * Because nobody knows it yet. `dueOn` stays null until the milestone is
 * certified, and that is the honest answer rather than missing data: a
 * buyer cannot be billed for a stage the building has not reached, and
 * inventing a date would produce an arrears figure for money nobody owes.
 * ====================================================================== */

import type { $Enums } from "@prisma/client";
import type { Db } from "../db.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";

/** A share of a whole, in basis points. 10000 is all of it. */
const ALL = 10_000;

/**
 * A share of an amount, rounded half-away-from-zero.
 *
 * The same rule as dev-core's `applyRateBp`. Integer throughout: a deposit
 * of "16.5% of 4,995,000" must land on a whole number of minor units, and
 * which whole number must not depend on floating point.
 */
export function shareOf(amount: bigint, bp: number): bigint {
  if (!Number.isInteger(bp)) throw badRequest("A share is whole basis points.");
  const negative = amount < 0n;
  const size = negative ? -amount : amount;
  const raw = size * BigInt(bp);
  /* +5000 before the divide is the rounding: it carries a half upward. */
  const rounded = (raw + 5000n) / BigInt(ALL);
  return negative ? -rounded : rounded;
}

/**
 * Split an amount into `parts`, with the remainder on the LAST part.
 *
 * dev-core's `splitEven`. The remainder goes in one named place so that a
 * plan of 12 instalments on 1,000,001 is eleven of 83,333 and one of
 * 83,338 — which adds up — rather than twelve of 83,333 and a missing 5.
 */
export function splitEven(total: bigint, parts: number): bigint[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw badRequest("A plan needs a whole, positive number of instalments.");
  }
  const each = total / BigInt(parts);
  const out = Array.from({ length: parts }, () => each);
  out[parts - 1] = each + (total - each * BigInt(parts));
  return out;
}

export interface MilestoneShare {
  readonly name: string;
  readonly shareBp: number;
}

export type PlanInput =
  | {
      readonly kind: "TIME_BASED";
      readonly depositBp: number;
      /** How many instalments AFTER the deposit. */
      readonly count: number;
      readonly firstDue: Date;
      readonly everyMonths: number;
    }
  | {
      readonly kind: "CONSTRUCTION_LINKED";
      readonly depositBp: number;
      readonly depositDue: Date;
      readonly milestones: readonly MilestoneShare[];
    };

export interface DraftInstalment {
  readonly seq: number;
  readonly description: string;
  readonly amount: bigint;
  readonly dueOn: Date | null;
  readonly milestone: string | null;
}

/** Add months without rolling a 31st into the following month. */
function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  /* Clamp: 31 January plus one month is 28 or 29 February, never 3 March.
     dev-core's dates module does the same, and a plan that silently slid a
     due date into the next month would misstate arrears every February. */
  const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastOfMonth));
  return d;
}

/**
 * Build the schedule. Pure — nothing is written, so it can be shown to
 * somebody before they agree to it.
 *
 * `alreadyPaid` is the reservation fee, if one was taken. It appears as the
 * first line, marked as already paid, and is deducted from the deposit —
 * so the plan shows the whole price and not the price minus something the
 * buyer has to remember.
 */
export function buildPlan(
  price: bigint, alreadyPaid: bigint, plan: PlanInput,
): DraftInstalment[] {
  if (price <= 0n) throw badRequest("A plan needs a contract price.");
  if (plan.depositBp < 0 || plan.depositBp > ALL) {
    throw badRequest("A deposit is between 0 and 100% of the price.");
  }

  const deposit = shareOf(price, plan.depositBp);
  if (deposit < alreadyPaid) {
    throw badRequest(
      `The deposit works out at ${deposit} but ${alreadyPaid} has already been ` +
      `taken as a reservation fee. A deposit cannot be less than what the buyer ` +
      `has already handed over.`);
  }

  const out: DraftInstalment[] = [];
  let seq = 0;

  if (alreadyPaid > 0n) {
    out.push({
      seq: seq++, description: "Reservation fee (already paid)",
      amount: alreadyPaid, dueOn: null, milestone: null,
    });
  }

  out.push({
    seq: seq++,
    description: alreadyPaid > 0n ? "Deposit (less reservation fee)" : "Deposit",
    amount: deposit - alreadyPaid,
    dueOn: plan.kind === "TIME_BASED" ? plan.firstDue : plan.depositDue,
    milestone: null,
  });

  const balance = price - deposit;

  if (plan.kind === "TIME_BASED") {
    if (plan.count <= 0 || plan.everyMonths <= 0) {
      throw badRequest("An instalment count and an interval must both be positive.");
    }
    splitEven(balance, plan.count).forEach((amount, i) => {
      out.push({
        seq: seq++, description: `Instalment ${i + 1} of ${plan.count}`,
        amount, dueOn: addMonths(plan.firstDue, plan.everyMonths * (i + 1)),
        milestone: null,
      });
    });
  } else {
    if (!plan.milestones.length) {
      throw badRequest("A construction-linked plan needs at least one milestone.");
    }
    const total = plan.milestones.reduce((a, m) => a + m.shareBp, 0);
    if (total !== ALL) {
      throw badRequest(
        `The milestone shares add up to ${(total / 100).toFixed(2)}%, not 100%. ` +
        `A plan that does not account for the whole balance leaves money nobody ` +
        `will ever invoice.`);
    }
    let allocated = 0n;
    plan.milestones.forEach((m, i) => {
      const last = i === plan.milestones.length - 1;
      /* The last share takes the remainder, so the total is exact. */
      const amount = last ? balance - allocated : shareOf(balance, m.shareBp);
      allocated += amount;
      out.push({
        seq: seq++, description: `On ${m.name}`, amount,
        dueOn: null, milestone: m.name,
      });
    });
  }

  /* The invariant, checked rather than trusted. If this ever throws it is a
     bug in the arithmetic above, not in the caller's input — which is worth
     telling apart in a message somebody has to read at two in the morning. */
  const sum = out.reduce((a, i) => a + i.amount, 0n);
  if (sum !== price) {
    throw new Error(
      `PLAN ARITHMETIC IS WRONG: the instalments total ${sum} against a price ` +
      `of ${price}. This is a defect in buildPlan, not in what was asked for.`);
  }

  return out;
}

/** The plan that governs this contract, or nothing. */
export async function livePlanFor(db: Db, orgId: string, contractId: string) {
  return db.paymentPlan.findFirst({
    where: { orgId, contractId, supersededAt: null },
    include: { instalments: { orderBy: { seq: "asc" } } },
  });
}

/**
 * Write a plan against a contract, superseding whatever it had.
 *
 * Superseding rather than editing, because the old plan is what somebody
 * agreed to and a re-plan is a new agreement. An instalment that has
 * already been invoiced blocks it: the buyer has been billed under the old
 * terms and that bill has to be settled or credited first.
 */
export async function setPlan(
  db: Db, orgId: string, contractId: string, input: PlanInput, by: string,
) {
  const contract = await db.contract.findFirst({ where: { id: contractId, orgId } });
  if (!contract) throw notFound("That contract does not exist.");

  const existing = await livePlanFor(db, orgId, contractId);
  if (existing) {
    const invoiced = existing.instalments.filter((i) => i.invoiceId);
    if (invoiced.length) {
      throw conflict(
        `${invoiced.length} instalment(s) on the current plan have already been ` +
        `invoiced. Credit or settle those before re-planning — the buyer has a ` +
        `bill under the old terms.`);
    }
  }

  const draft = buildPlan(contract.price, contract.deposit, input);

  return db.$transaction(async (tx) => {
    if (existing) {
      await tx.paymentPlan.update({
        where: { id: existing.id },
        data: { supersededAt: new Date(), supersededBy: by },
      });
    }
    const plan = await tx.paymentPlan.create({
      data: {
        orgId, contractId, kind: input.kind as $Enums.PaymentPlanKind,
        currency: contract.currency, depositBp: input.depositBp,
        instalments: {
          create: draft.map((d) => ({
            orgId, seq: d.seq, description: d.description, amount: d.amount,
            dueOn: d.dueOn, milestone: d.milestone,
          })),
        },
      },
      include: { instalments: { orderBy: { seq: "asc" } } },
    });
    return plan;
  });
}

/**
 * A stage was reached: its instalments become due.
 *
 * Only ever forward. An instalment that already has a date is left alone —
 * certifying the same milestone twice must not move a due date a buyer has
 * already been given, and must not invoice anything a second time.
 */
export async function certifyMilestone(
  db: Db, orgId: string, milestone: string, dueOn: Date,
): Promise<{ readonly made: number }> {
  const name = milestone.trim();
  if (!name) throw badRequest("Certifying a stage needs its name.");

  const waiting = await db.paymentInstalment.findMany({
    where: {
      orgId, milestone: name, dueOn: null,
      plan: { supersededAt: null },
    },
    select: { id: true },
  });

  if (waiting.length) {
    await db.paymentInstalment.updateMany({
      where: { id: { in: waiting.map((w) => w.id) } },
      data: { dueOn },
    });
  }
  return { made: waiting.length };
}

/**
 * Instalments that are due and not yet invoiced.
 *
 * The list a scheduled job would work through — see the README of
 * paltas-dev-core, which calls for this daily. PALTAS has no job runner
 * yet, so for now this is a screen and an endpoint somebody presses, and
 * the query is the same one a job will use when there is one.
 */
export async function dueUninvoiced(db: Db, orgId: string, asAt: Date) {
  return db.paymentInstalment.findMany({
    where: {
      orgId, invoiceId: null, dueOn: { not: null, lte: asAt },
      plan: { supersededAt: null },
    },
    include: {
      plan: {
        select: {
          currency: true,
          contract: {
            select: {
              id: true, ref: true,
              buyer: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { dueOn: "asc" },
    take: 500,
  });
}
