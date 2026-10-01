/* ======================================================================
 * MONEY THE COMPANY IS HOLDING, AND DOES NOT OWN.
 *
 * A tenancy deposit is the TENANT's money. The company holds it against
 * damage and arrears, and gives back whatever is left. Every rule in this
 * file follows from that one sentence, and from the fact that the person the
 * money belongs to is not in the room when these decisions are made.
 *
 * ── WHAT IS HELD IS A SUM, NEVER A STORED FIGURE ──────────────────────
 *
 *     held = sum(RECEIVED) − sum(DEDUCTED) − sum(RETURNED)
 *
 * over the movements, counting none that is void. A stored running total is a
 * second truth, and it drifts the first time anything is voided — which is
 * exactly when somebody is already unhappy. The amount of somebody else's
 * money in your account is the worst figure in the system to be approximately
 * right about.
 *
 * ── THE TWO CEILINGS ──────────────────────────────────────────────────
 *
 * You cannot deduct more than is held, and you cannot return more than is
 * held. They are the same number here, unlike a credit note and a refund
 * where the two ceilings differ: both acts take money out of the same pot.
 *
 * ── WHY A DEDUCTION NEEDS A SENTENCE ──────────────────────────────────
 *
 * A deduction is a company keeping somebody else's money. The tenant is
 * entitled to know what for, and in most jurisdictions entitled to contest
 * it. "Deducted 40,000" with no reason is indefensible in any forum that
 * might later ask, so the reason is required rather than encouraged.
 *
 * ── WHAT THIS FILE DOES NOT DO ────────────────────────────────────────
 *
 * It implements no country's deposit-protection scheme. Several jurisdictions
 * require a deposit to sit in a designated or insured account, within a fixed
 * number of days, with prescribed wording served on the tenant. PALTAS records
 * which account it is in and when everything happened — the facts those
 * schemes ask for — and does not pretend to administer any of them. Building
 * one country's rules into generic logic would be wrong for the other
 * forty-nine.
 * ====================================================================== */

import { badRequest } from "../http/errors.ts";

/** A movement as these rules read it. Positive amount; the kind is direction. */
export interface MovementForSum {
  readonly kind: string;
  readonly amount: bigint;
  readonly voided: boolean;
}

/** A deposit as these rules read it. */
export interface DepositForRules {
  readonly required: bigint;
  readonly currency: string;
  readonly disputed: boolean;
}

export const KINDS = ["RECEIVED", "DEDUCTED", "RETURNED"] as const;
export type MovementKind = (typeof KINDS)[number];

/** The plain-words version of each, for a sentence a customer reads. */
export const KIND_WORDS: Readonly<Record<string, string>> = {
  RECEIVED: "received",
  DEDUCTED: "deducted",
  RETURNED: "returned",
};

function total(movements: readonly MovementForSum[], kind: MovementKind): bigint {
  let out = 0n;
  for (const m of movements) {
    /* A void is excluded from every sum — which is what makes voiding a
       mistaken deduction give the tenant their money back in the only sense
       that matters. */
    if (m.voided || m.kind !== kind) continue;
    out += m.amount;
  }
  return out;
}

export const receivedOn = (ms: readonly MovementForSum[]): bigint => total(ms, "RECEIVED");
export const deductedOn = (ms: readonly MovementForSum[]): bigint => total(ms, "DEDUCTED");
export const returnedOn = (ms: readonly MovementForSum[]): bigint => total(ms, "RETURNED");

/**
 * WHAT IS BEING HELD RIGHT NOW. The figure the whole feature exists for.
 *
 * Floored at zero. It cannot legitimately go negative — both ceilings prevent
 * it — but a reader of this number must never be handed a negative liability,
 * because a caller comparing against one would allow the next deduction.
 */
export function heldOn(movements: readonly MovementForSum[]): bigint {
  const held = receivedOn(movements) - deductedOn(movements) - returnedOn(movements);
  return held > 0n ? held : 0n;
}

/**
 * WHERE THIS DEPOSIT IS IN ITS LIFECYCLE.
 *
 * Computed from the movements every time anything is written, never accepted
 * from a request: a client that can name its own status can say SETTLED over
 * money it is still holding.
 *
 * `disputed` wins over everything, because it is the one piece of state that
 * is a DECISION rather than a sum, and a recompute of the figures must not be
 * able to erase it.
 */
export function statusFor(
  deposit: DepositForRules,
  movements: readonly MovementForSum[],
): "DUE" | "PARTIAL" | "HELD" | "DISPUTED" | "SETTLED" {
  if (deposit.disputed) return "DISPUTED";

  const received = receivedOn(movements);
  /* Nothing has ever arrived. Not the same as settled: one is a debt the
     landlord should chase, the other is a tenancy that is finished with. */
  if (received <= 0n) return "DUE";

  const held = heldOn(movements);
  if (held <= 0n) return "SETTLED";

  /* Short of what the agreement asks for — whether it arrived short or has
     been eaten into by deductions. This is the state a landlord acts on. */
  if (held < deposit.required) return "PARTIAL";
  return "HELD";
}

/* ---------------------------------------------------------------- *
 * TAKING IT IN
 * ---------------------------------------------------------------- */

/** Why this deposit cannot take money of this size — or null. */
export function whyNotReceivable(
  deposit: DepositForRules, amount: number, currency?: string | null,
): string | null {
  const bad = notAnAmount(amount, "A deposit receipt");
  if (bad) return bad;
  const wrong = notSameCurrency(deposit, currency);
  if (wrong) return wrong;
  /*
   * MORE THAN THE AGREEMENT ASKS FOR IS ALLOWED, deliberately. Rents rise and
   * deposits are topped up to match; a tenant paying a round number rather
   * than the exact figure is ordinary. Refusing it would be refusing money
   * that has already arrived, which no record-keeping system should do.
   */
  return null;
}

export function requireReceivable(
  deposit: DepositForRules, amount: number, currency?: string | null,
): bigint {
  const why = whyNotReceivable(deposit, amount, currency);
  if (why) throw badRequest(why);
  return BigInt(amount);
}

/* ---------------------------------------------------------------- *
 * KEEPING SOME OF IT
 * ---------------------------------------------------------------- */

/** Why this much cannot be deducted — or null. */
export function whyNotDeductible(
  deposit: DepositForRules,
  movements: readonly MovementForSum[],
  amount: number,
  currency?: string | null,
): string | null {
  const bad = notAnAmount(amount, "A deduction");
  if (bad) return bad;
  const wrong = notSameCurrency(deposit, currency);
  if (wrong) return wrong;

  /*
   * A DISPUTE STOPS DEDUCTIONS AND NOTHING ELSE.
   *
   * A company must not keep taking more out of the money it is holding while
   * the person it belongs to is objecting to what has been taken already.
   * Returning money stays allowed throughout — giving it back is never the
   * harmful direction, and several jurisdictions require the undisputed part
   * to go back promptly.
   */
  if (deposit.disputed) {
    return "This deposit is in dispute, so nothing further can be deducted "
         + "from it. Resolve the dispute first, or return what is not in "
         + "question — a return is never blocked.";
  }

  const held = heldOn(movements);
  if (held <= 0n) {
    const received = receivedOn(movements);
    return received <= 0n
      ? "Nothing has been received against this deposit, so there is nothing "
        + "to deduct from. Record the money arriving first."
      : "Nothing is left of this deposit. It has all been deducted or "
        + "returned already.";
  }
  if (BigInt(amount) > held) {
    return `That is more than is being held. ${held} is left, after what has `
         + `already been deducted and returned. A company cannot keep money it `
         + `does not have — if the tenant owes more than the deposit covers, `
         + `the rest is a debt, not a deduction.`;
  }
  return null;
}

export function requireDeductible(
  deposit: DepositForRules,
  movements: readonly MovementForSum[],
  amount: number,
  currency?: string | null,
): bigint {
  const why = whyNotDeductible(deposit, movements, amount, currency);
  if (why) throw badRequest(why);
  return BigInt(amount);
}

/* ---------------------------------------------------------------- *
 * GIVING IT BACK
 * ---------------------------------------------------------------- */

/** Why this much cannot be returned — or null. */
export function whyNotReturnable(
  deposit: DepositForRules,
  movements: readonly MovementForSum[],
  amount: number,
  currency?: string | null,
): string | null {
  const bad = notAnAmount(amount, "A return");
  if (bad) return bad;
  const wrong = notSameCurrency(deposit, currency);
  if (wrong) return wrong;

  /* Deliberately NOT blocked by a dispute. See whyNotDeductible. */

  const held = heldOn(movements);
  if (held <= 0n) {
    const received = receivedOn(movements);
    return received <= 0n
      ? "Nothing has been received against this deposit, so there is nothing "
        + "to give back."
      : "Nothing is left of this deposit to return.";
  }
  if (BigInt(amount) > held) {
    return `That is more than is being held. ${held} is left — returning more `
         + `would be the company's own money going out, which is not a deposit `
         + `return.`;
  }
  return null;
}

export function requireReturnable(
  deposit: DepositForRules,
  movements: readonly MovementForSum[],
  amount: number,
  currency?: string | null,
): bigint {
  const why = whyNotReturnable(deposit, movements, amount, currency);
  if (why) throw badRequest(why);
  return BigInt(amount);
}

/* ---------------------------------------------------------------- *
 * SHARED REFUSALS
 * ---------------------------------------------------------------- */

function notAnAmount(amount: number, what: string): string | null {
  if (!Number.isFinite(amount) || Math.round(amount) !== amount || amount <= 0) {
    return `${what} is a whole number of minor units, and more than zero. `
         + `The direction is which act this is, never the sign of the amount.`;
  }
  return null;
}

/**
 * ONE DEPOSIT, ONE CURRENCY.
 *
 * There is no exchange-rate source in this service and adding a silent 1:1
 * fallback has been refused everywhere else, so it is refused here too. A
 * deposit taken in KES is held, deducted and returned in KES; money arriving
 * in another currency is a different thing that needs a rate somebody stands
 * behind.
 */
function notSameCurrency(deposit: DepositForRules, currency?: string | null): string | null {
  if (!currency) return null;
  if (String(currency).toUpperCase() === String(deposit.currency).toUpperCase()) return null;
  return `This deposit is held in ${deposit.currency}. ${currency} would need an `
       + `exchange rate, and this service has no rate source it would stand `
       + `behind — record it in ${deposit.currency}, at the rate you used.`;
}

/**
 * THE SENTENCE A DEDUCTION CANNOT GO WITHOUT.
 *
 * Shared with the route so the length and the wording are in one place. Five
 * characters is not a quality bar — it stops an empty box and a full stop.
 */
export function whyNotAReason(reason: string, what: string): string | null {
  if (String(reason || "").trim().length < 5) {
    return `${what} needs a reason. This is somebody else's money, and they `
         + `are entitled to the sentence explaining what happened to it — `
         + `whoever reads this in six months will have only that sentence.`;
  }
  return null;
}
