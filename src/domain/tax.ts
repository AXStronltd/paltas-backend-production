/* ======================================================================
 * TAX, AS DATED RULES RATHER THAN A NUMBER IN A FORM.
 *
 * ── WHAT THIS REPLACES ────────────────────────────────────────────────
 *
 * `InvoiceLine.taxBps` was the only record of a rate, and it was typed in
 * by hand, line by line. That meant:
 *
 *   · nothing said where 1600 came from, or who decided it;
 *   · nothing stopped a person entering 1800 on one line and 1600 on the
 *     next of the same invoice;
 *   · "what was the rate in March" had no answer once it had changed;
 *   · a tax code nobody had configured produced a silent zero, which is
 *     the single most expensive kind of wrong in this area — an invoice
 *     that charges no VAT looks completely normal.
 *
 * A rate is now a row with an effective date. A rate change is a NEW row,
 * never an edit, because an invoice raised under the old rule has to go on
 * reading the same way for as long as it is kept.
 *
 * ── WHAT DOES NOT CHANGE ──────────────────────────────────────────────
 *
 * `InvoiceLine.taxBps` still holds the resolved rate, and posting.ts still
 * computes tax from it. This module DECIDES the rate; the line RECORDS it.
 * Having the line look the rule up at read time would mean a five-year-old
 * invoice silently restating itself the day somebody adds a new rule.
 *
 * Money stays BigInt minor units and rates stay whole basis points, which
 * is what this service already used everywhere. There is no Money wrapper
 * here: `(net * BigInt(bps)) / 10000n` is exact, and a second numeric
 * representation alongside the first is a bug waiting for a rounding test.
 * ====================================================================== */

import type { $Enums } from "@prisma/client";
import type { Db } from "../db.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";

/** The end of time, for comparing an open-ended rule. */
const FOREVER = new Date("9999-12-31T00:00:00.000Z");

/**
 * The code that means "outside the scope of tax".
 *
 * Spelled out rather than left as an absent value, because "no tax applies
 * to this" and "nobody has said what tax applies to this" are different
 * facts and only one of them is safe to invoice on.
 */
export const OUT_OF_SCOPE = "NONE";

export interface TaxAsked {
  readonly orgId: string;
  readonly country: string;
  readonly taxCode: string;
  /** The date the rate is asked for — an invoice's own date, never today. */
  readonly on: Date;
}

export interface TaxAnswer {
  readonly taxCode: string;
  readonly rateBp: number;
  readonly label: string;
  readonly ruleId: string | null;
  readonly kind: $Enums.TaxKind | null;
}

/** Tax on a tax-exclusive base, in minor units. Exact, integer-only. */
export const taxOn = (base: bigint, rateBp: number): bigint =>
  (base * BigInt(rateBp)) / 10000n;

/**
 * The rule in force for this code on this date, or nothing.
 *
 * Deliberately returns null rather than throwing: a caller listing rules
 * wants the gap shown, and a caller invoicing wants it refused. Those are
 * different needs and `rateFor` below is the one that refuses.
 */
export async function ruleFor(
  db: Db, { orgId, country, taxCode, on }: TaxAsked,
) {
  return db.taxRule.findFirst({
    where: {
      orgId, country, taxCode,
      effectiveFrom: { lte: on },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
}

/**
 * THE RATE TO PUT ON A LINE — OR A REFUSAL NAMING WHAT IS MISSING.
 *
 * An unknown code is an error and never a zero. A missing rule means
 * somebody has not yet told this service what tax applies, and inventing
 * "none" on their behalf produces an invoice that is quietly short.
 */
export async function rateFor(db: Db, asked: TaxAsked): Promise<TaxAnswer> {
  if (asked.taxCode === OUT_OF_SCOPE) {
    return {
      taxCode: OUT_OF_SCOPE, rateBp: 0, ruleId: null, kind: null,
      label: "Outside the scope of tax",
    };
  }

  const rule = await ruleFor(db, asked);
  if (!rule) {
    throw badRequest(
      `No ${asked.taxCode} rule for ${asked.country} on ` +
      `${asked.on.toISOString().slice(0, 10)}. Add the confirmed rate before ` +
      `invoicing against this code — charging nothing is not the safe default.`);
  }

  return {
    taxCode: rule.taxCode, rateBp: rule.rateBp, ruleId: rule.id,
    kind: rule.kind, label: rule.label || rule.taxCode,
  };
}

export interface NewRule {
  readonly country: string;
  readonly taxCode: string;
  readonly kind?: $Enums.TaxKind;
  readonly rateBp: number;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date | null;
  readonly confirmedBy: string;
  readonly label?: string;
}

/**
 * Record a rate, refusing the two ways a tax table goes wrong.
 *
 * OVERLAP. Two rules covering the same day for the same code means the
 * answer to "what is the rate" depends on which row is read first. The
 * existing rule has to be ended before a new one starts, which is also
 * how a real rate change happens: the old rate ran until a date.
 *
 * UNCONFIRMED. `confirmedBy` is a name, not a tick. A rate nobody will put
 * their name to is not a rate this service will apply to a customer's
 * invoice, and the person who changed it in six months' time is exactly
 * who the auditor will ask for.
 */
export async function addRule(db: Db, orgId: string, rule: NewRule) {
  if (!Number.isInteger(rule.rateBp) || rule.rateBp < 0 || rule.rateBp > 10000) {
    throw badRequest(
      "A tax rate is whole basis points from 0 to 10000 — 1600 is 16%. " +
      "Fractions of a basis point are not a rate any authority publishes.");
  }
  if (!rule.confirmedBy.trim()) {
    throw badRequest(
      "A tax rate needs the name of whoever confirmed it. This is the answer " +
      "to “who said 16%”, and somebody will ask.");
  }
  if (rule.effectiveTo && rule.effectiveTo < rule.effectiveFrom) {
    throw badRequest("The rule ends before it starts.");
  }

  const clash = await db.taxRule.findFirst({
    where: {
      orgId, country: rule.country, taxCode: rule.taxCode,
      effectiveFrom: { lte: rule.effectiveTo ?? FOREVER },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: rule.effectiveFrom } }],
    },
  });
  if (clash) {
    const until = clash.effectiveTo
      ? `to ${clash.effectiveTo.toISOString().slice(0, 10)}`
      : "with no end date";
    throw conflict(
      `${rule.taxCode} already has a rule from ` +
      `${clash.effectiveFrom.toISOString().slice(0, 10)} ${until}. ` +
      `End that one the day before this starts — two rates covering one day ` +
      `means the answer depends on which row is read first.`);
  }

  return db.taxRule.create({
    data: {
      orgId, country: rule.country, taxCode: rule.taxCode,
      kind: rule.kind ?? "OUTPUT", rateBp: rule.rateBp,
      effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo ?? null,
      confirmedBy: rule.confirmedBy.trim(), label: rule.label ?? "",
    },
  });
}

/**
 * Close an open rule so a new rate can start the next day.
 *
 * The only edit this table allows. Everything else about a rule that has
 * been applied to an invoice is history.
 */
export async function endRule(
  db: Db, orgId: string, id: string, effectiveTo: Date,
) {
  const rule = await db.taxRule.findFirst({ where: { id, orgId } });
  if (!rule) throw notFound("That tax rule does not exist.");
  if (effectiveTo < rule.effectiveFrom) {
    throw badRequest("A rule cannot end before the day it started.");
  }
  return db.taxRule.update({ where: { id: rule.id }, data: { effectiveTo } });
}
