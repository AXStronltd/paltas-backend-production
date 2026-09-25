/* ======================================================================
 * WHAT A LEASE DOES TO THE UNIT IT IS FOR.
 *
 * ── THE DEFECT THIS FILE CLOSES ───────────────────────────────────────
 *
 * A Unit has five statuses. Until this file existed, exactly two lines in
 * the whole service ever wrote one: accepting an offer set RESERVED, and
 * cancelling a contract put it back to VACANT. Nothing else, anywhere,
 * moved a unit — so OCCUPIED and NOTICE were unreachable values in a live
 * schema, and three things were quietly wrong:
 *
 *   1. Signing a lease did not occupy the unit. Lease.unitId pointed at it
 *      and the unit stayed VACANT, so a fully let building reported as
 *      entirely vacant — including on the vacancy count in routes/products.
 *
 *   2. A let unit could be sold out from under its tenant. The offer path
 *      refuses a unit that is already RESERVED; a leased unit was not
 *      RESERVED, it was VACANT, so it could be listed, offered and
 *      reserved while somebody was living in it.
 *
 *   3. A sold, paid-for, handed-over unit stayed RESERVED for ever.
 *
 * The unit's availability is read by Marketplace, CRM, Sales and
 * Development alike — one state, one place, which is right. It was simply
 * three transitions short, so every one of those readers was being told
 * something untrue.
 *
 * ── THE MAP IS THE SCHEMA'S OWN ───────────────────────────────────────
 *
 * LeaseStatus and UnitStatus already line up name for name, NOTICE
 * included. That is not a coincidence — the pairing was designed and the
 * wiring was never written. This file writes it and nothing more; it
 * invents no new state and changes no enum.
 * ====================================================================== */

import type { $Enums } from "@prisma/client";
import type { Db } from "../db.ts";

/**
 * What a lease in each state means for its unit.
 *
 * `null` is "this lease says nothing about the unit" and is not the same as
 * VACANT. A DRAFT lease is a document somebody is still writing; it must not
 * empty a flat that is occupied under the lease it is replacing.
 */
export const OCCUPANCY: Readonly<Record<$Enums.LeaseStatus, $Enums.UnitStatus | null>> = {
  DRAFT: null,
  ACTIVE: "OCCUPIED",
  NOTICE: "NOTICE",
  ENDED: "VACANT",
  TERMINATED: "VACANT",
};

/**
 * THE UNIT STATUSES A LEASE IS ALLOWED TO MOVE.
 *
 * A lease governs letting. It does not govern a sale, so it may never write
 * over RESERVED — that would erase a reservation, and a reservation is a
 * buyer's claim backed by an accepted offer and a contract. Nor may it touch
 * OFF_MARKET, which is a deliberate act by somebody who took the unit out of
 * service.
 *
 * Refusing is the whole point: the two states left out are the two where a
 * lease and a sale disagree about the same flat, and that disagreement must
 * be visible rather than resolved by whichever write happened to land last.
 */
const LEASE_MAY_MOVE: ReadonlySet<$Enums.UnitStatus> = new Set<$Enums.UnitStatus>([
  "VACANT", "OCCUPIED", "NOTICE",
]);

/** A unit somebody is living in, or is about to stop living in. */
export const LET_STATES: ReadonlySet<$Enums.UnitStatus> = new Set<$Enums.UnitStatus>([
  "OCCUPIED", "NOTICE",
]);

/** The lease states that hold a unit — the ones that block a sale. */
export const LIVE_LEASE_STATES: readonly $Enums.LeaseStatus[] = ["ACTIVE", "NOTICE"];

export type OccupancyResult =
  | { readonly changed: true; readonly from: $Enums.UnitStatus; readonly to: $Enums.UnitStatus }
  | { readonly changed: false; readonly why: string };

export interface LeaseForOccupancy {
  readonly orgId: string;
  readonly unitId?: string | null;
  readonly status: $Enums.LeaseStatus;
}

/**
 * Move the unit to match the lease, or say why it was left alone.
 *
 * DOES NOT THROW, and the reason is never swallowed — it comes back so the
 * caller can put it in the response and the audit trail. The same argument
 * as domain/posting.ts: a lease that has been agreed must not be refused
 * because its unit is in an awkward state. What must not happen is the
 * awkward state going unmentioned.
 */
export async function syncUnitToLease(
  db: Db, lease: LeaseForOccupancy,
): Promise<OccupancyResult> {
  if (!lease.unitId) return { changed: false, why: "The lease does not name a unit." };

  const want = OCCUPANCY[lease.status];
  if (!want) {
    return { changed: false, why: `A ${lease.status} lease does not decide whether a unit is occupied.` };
  }

  const unit = await db.unit.findFirst({
    where: { id: lease.unitId, orgId: lease.orgId },
    select: { id: true, ref: true, status: true },
  });
  if (!unit) return { changed: false, why: "The unit on this lease no longer exists." };

  if (unit.status === want) return { changed: false, why: "" };

  if (!LEASE_MAY_MOVE.has(unit.status)) {
    return {
      changed: false,
      why: `${unit.ref} is ${unit.status} and a lease may not change that. ` +
           `A reserved or off-market unit is settled by the sale or by whoever ` +
           `withdrew it, not by a letting.`,
    };
  }

  await db.unit.update({ where: { id: unit.id }, data: { status: want } });
  return { changed: true, from: unit.status, to: want };
}

/**
 * Is this unit held by a live lease?
 *
 * Asked before a sale reserves it. The unit's own status is not enough on
 * its own: it is the answer to "is this let", but a lease row is the
 * evidence, and a unit whose status drifted for any reason should not be
 * sellable while a tenant has a signed agreement on it.
 */
export async function liveLeaseOn(
  db: Db, orgId: string, unitId: string,
): Promise<{ readonly ref: string; readonly status: $Enums.LeaseStatus } | null> {
  const lease = await db.lease.findFirst({
    where: { orgId, unitId, status: { in: [...LIVE_LEASE_STATES] } },
    select: { ref: true, status: true },
    orderBy: { createdAt: "desc" },
  });
  return lease ?? null;
}
