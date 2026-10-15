/*
 * The organisation's own loyalty programme (chain-wide: one per organisation, members are guest profiles).
 *
 *   earn     at check-out of a reservation's last room: floor(room revenue before tax ÷ revenue per point), plus the
 *            tier's bonus. The points' value is accrued: loyalty cost 5700 / loyalty liability 2400.
 *   redeem   at booking: the points leave the member's balance at once and are credited on the guest folio — at
 *            check-in, or immediately when the guest is in house (loyalty liability 2400 / guest ledger 1150).
 *            A cancelled or no-show booking gives pending points back.
 *   adjust   corrections by an approver, with the liability moved by the points' value.
 * Tier: the highest tier reached by stays or lifetime points. Member rate: the tier's discount at booking.
 * So the liability 2400 always equals (points held + points pending redemption) × point value.
 */
import type { hotel } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { FoliosService } from "../folios/folios.service.js";
import { cr, dr, postToLedger } from "../shared/posting.js";

export interface ProgrammeRow {
  org_id: string;
  name: string;
  minor_per_point: number;
  point_value_minor: number;
  tiers: hotel.LoyaltyProgrammeOut["tiers"];
}

export interface MemberRow {
  id: string;
  org_id: string;
  guest_id: string;
  number: string;
  tier: string;
  points: number;
  lifetime_points: number;
  stays: number;
  joined_on: string;
  guest_name?: string;
  pending?: number;
}

interface EntryRow {
  id: string;
  kind: hotel.LoyaltyEntryOut["kind"];
  points: number;
  value_minor: number;
  property_id: string;
  reservation_id: string | null;
  status: hotel.LoyaltyEntryOut["status"];
  note: string;
  created_at: string;
}

export const programmeOf = (t: Db, orgId: string) =>
  t.row<ProgrammeRow>("SELECT * FROM hotel_loyalty_programmes WHERE org_id = $1", [orgId]);

const MEMBER_SELECT = `SELECT m.*, g.name AS guest_name,
  COALESCE((SELECT -sum(e.points) FROM hotel_loyalty_entries e WHERE e.member_id = m.id AND e.kind = 'redeem'
            AND e.status = 'pending'), 0)::bigint AS pending
  FROM hotel_loyalty_members m JOIN hotel_guests g ON g.id = m.guest_id`;

export async function memberRow(t: Db, orgId: string, id: string, lock = false): Promise<MemberRow> {
  const m = await t.row<MemberRow>(
    `${MEMBER_SELECT} WHERE m.org_id = $1 AND m.id = $2${lock ? " FOR UPDATE OF m" : ""}`,
    [orgId, id],
  );
  if (!m) throw fail.notFound("Member not found");
  return m;
}

export async function memberOfGuest(t: Db, guestId: string, lock = false): Promise<MemberRow | null> {
  return t.row<MemberRow>(`${MEMBER_SELECT} WHERE m.guest_id = $1${lock ? " FOR UPDATE OF m" : ""}`, [guestId]);
}

export const toMember = (m: MemberRow): hotel.LoyaltyMemberOut => ({
  id: m.id,
  number: m.number,
  guestId: m.guest_id,
  guestName: m.guest_name ?? "",
  tier: m.tier,
  points: m.points,
  lifetimePoints: m.lifetime_points,
  stays: m.stays,
  joinedOn: m.joined_on,
  pendingPoints: m.pending ?? 0,
});

export const toEntry = (e: EntryRow): hotel.LoyaltyEntryOut => ({
  id: e.id,
  kind: e.kind,
  points: e.points,
  valueMinor: e.value_minor,
  propertyId: e.property_id,
  reservationId: e.reservation_id,
  status: e.status,
  note: e.note,
  at: e.created_at,
});

export async function entryRow(t: Db, id: string) {
  return toEntry((await t.row<EntryRow>("SELECT * FROM hotel_loyalty_entries WHERE id = $1", [id])) as EntryRow);
}

export async function entriesOf(t: Db, memberId: string) {
  return (
    await t.rows<EntryRow>("SELECT * FROM hotel_loyalty_entries WHERE member_id = $1 ORDER BY seq", [memberId])
  ).map(toEntry);
}

/** The highest tier the member has reached by stays or lifetime points. */
export function tierFor(p: ProgrammeRow, stays: number, lifetime: number): string {
  let tier = p.tiers[0]?.code ?? "MEMBER";
  for (const x of p.tiers) if (stays >= x.minStays || lifetime >= x.minPoints) tier = x.code;
  return tier;
}

/** The member-rate discount (basis points) of a guest, or 0 when not a member. */
export async function memberDiscountBp(
  t: Db,
  orgId: string,
  guestId: string | null,
): Promise<{ bp: number; tier: string | null }> {
  if (!guestId) return { bp: 0, tier: null };
  const p = await programmeOf(t, orgId);
  const m = await memberOfGuest(t, guestId);
  if (!p || !m) return { bp: 0, tier: null };
  const tier = p.tiers.find((x) => x.code === m.tier);
  return { bp: Math.round((tier?.discountPct ?? 0) * 100), tier: m.tier };
}

export async function enrol(t: Db, op: { orgId: string; actor: HotelOp["actor"] }, guestId: string, today: string) {
  const p = await programmeOf(t, op.orgId);
  if (!p) throw fail.conflict("Set up the loyalty programme first");
  if (!(await t.row("SELECT 1 FROM hotel_guests WHERE org_id = $1 AND id = $2", [op.orgId, guestId])))
    throw fail.notFound("Guest not found");
  if (await memberOfGuest(t, guestId)) throw fail.conflict("This guest is already a member");
  const id = newId("hlm");
  await t.run(
    "INSERT INTO hotel_loyalty_members (id, org_id, guest_id, number, tier, joined_on) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, op.orgId, guestId, await nextNumber(t, op.orgId, "LOY", 6), tierFor(p, 0, 0), today],
  );
  await recordAudit(t, { actor: op.actor, orgId: op.orgId, action: "Loyalty member enrolled", target: id });
  return id;
}

export function loyalty(d: HotelDeps, folios: FoliosService) {
  const { core } = d;

  /** Credit a redemption on the stay's guest folio (liability 2400 → guest ledger 1150). */
  async function applyRedemption(t: Db, op: HotelOp, entryId: string, folioId: string) {
    const e = await t.row<{ id: string; points: number; value_minor: number; status: string }>(
      "SELECT id, points, value_minor, status FROM hotel_loyalty_entries WHERE id = $1 FOR UPDATE",
      [entryId],
    );
    if (!e || e.status !== "pending") return;
    const value = -e.value_minor;
    const lineId = newId("hfl");
    const journalId = await postToLedger(t, core, {
      orgId: op.orgId,
      propertyId: op.property.id,
      date: op.property.business_date,
      kind: "loyalty",
      memo: `Loyalty points redeemed (${-e.points} points)`,
      ref: `loyalty-redeem:${e.id}`,
      lines: [dr(ACC.loyalty, value), cr(ACC.guestLedger, value)],
    });
    await folios.insertLine(t, op, folioId, {
      id: lineId,
      kind: "loyalty",
      description: `Loyalty reward — ${-e.points} points`,
      net: -value,
      journalId,
    });
    await t.run("UPDATE hotel_loyalty_entries SET status = 'done', line_id = $2, journal_id = $3 WHERE id = $1", [
      e.id,
      lineId,
      journalId,
    ]);
  }

  /** The guest-paid folio of an in-house stay of the reservation, if any. */
  async function guestFolioOf(t: Db, reservationId: string): Promise<string | null> {
    const f = await t.row<{ id: string }>(
      `SELECT f.id FROM hotel_folios f JOIN hotel_stays s ON s.id = f.stay_id
       WHERE f.reservation_id = $1 AND s.status = 'in_house' AND f.status = 'open' AND f.payer = 'guest'
       ORDER BY f.created_at, f.number LIMIT 1`,
      [reservationId],
    );
    return f?.id ?? null;
  }

  return {
    applyRedemption,

    async redeem(t: Db, op: HotelOp, reservationId: string, points: number): Promise<string> {
      const p = await programmeOf(t, op.orgId);
      if (!p) throw fail.conflict("Set up the loyalty programme first");
      const r = await t.row<{ guest_id: string; number: string }>(
        "SELECT guest_id, number FROM hotel_reservations WHERE property_id = $1 AND id = $2 FOR UPDATE",
        [op.property.id, reservationId],
      );
      if (!r) throw fail.notFound("Reservation not found");
      const live = await t.row<{ n: number }>(
        "SELECT count(*)::int AS n FROM hotel_stays WHERE reservation_id = $1 AND status IN ('reserved', 'in_house')",
        [reservationId],
      );
      if (!live?.n) throw fail.conflict("Points are redeemed on a booking that is confirmed or in house");
      const m = await memberOfGuest(t, r.guest_id, true);
      if (!m) throw fail.conflict("This guest is not a loyalty member");
      if (points > m.points) throw fail.conflict(`The member has ${m.points} point(s)`);
      await t.run("UPDATE hotel_loyalty_members SET points = points - $2 WHERE id = $1", [m.id, points]);
      const id = newId("hle");
      await t.run(
        `INSERT INTO hotel_loyalty_entries (id, org_id, member_id, property_id, kind, points, value_minor, reservation_id,
           status, note, created_by)
         VALUES ($1,$2,$3,$4,'redeem',$5,$6,$7,'pending',$8,$9)`,
        [
          id,
          op.orgId,
          m.id,
          op.property.id,
          -points,
          -points * p.point_value_minor,
          reservationId,
          `Redeemed on ${r.number}`,
          op.userId,
        ],
      );
      const folioId = await guestFolioOf(t, reservationId);
      if (folioId) await applyRedemption(t, op, id, folioId);
      await recordAudit(t, {
        actor: op.actor,
        orgId: op.orgId,
        action: "Loyalty points redeemed",
        target: r.number,
        detail: `${points} point(s) · ${points * p.point_value_minor}`,
      });
      return id;
    },

    /** Check-in: credit the reservation's pending redemptions on the new folio. */
    async applyPending(t: Db, op: HotelOp, reservationId: string, folioId: string) {
      const pending = await t.rows<{ id: string }>(
        "SELECT id FROM hotel_loyalty_entries WHERE reservation_id = $1 AND kind = 'redeem' AND status = 'pending' ORDER BY seq",
        [reservationId],
      );
      for (const e of pending) await applyRedemption(t, op, e.id, folioId);
    },

    /** Cancellation or no-show: points redeemed but not yet credited go back to the member. */
    async reversePending(t: Db, op: HotelOp, reservationId: string) {
      const pending = await t.rows<{ id: string; member_id: string; points: number; value_minor: number }>(
        "SELECT * FROM hotel_loyalty_entries WHERE reservation_id = $1 AND kind = 'redeem' AND status = 'pending' FOR UPDATE",
        [reservationId],
      );
      for (const e of pending) {
        await t.run("UPDATE hotel_loyalty_entries SET status = 'reversed' WHERE id = $1", [e.id]);
        await t.run("UPDATE hotel_loyalty_members SET points = points + $2 WHERE id = $1", [e.member_id, -e.points]);
        await t.run(
          `INSERT INTO hotel_loyalty_entries (id, org_id, member_id, property_id, kind, points, value_minor, reservation_id,
             note, created_by)
           VALUES ($1,$2,$3,$4,'reverse',$5,$6,$7,'Booking cancelled — redeemed points returned',$8)`,
          [newId("hle"), op.orgId, e.member_id, op.property.id, -e.points, -e.value_minor, reservationId, op.userId],
        );
      }
    },

    /** Check-out of the reservation's last room: points for its room revenue, accrued as a liability. */
    async earn(t: Db, op: HotelOp, reservationId: string): Promise<number> {
      const p = await programmeOf(t, op.orgId);
      if (!p) return 0;
      const open = await t.row<{ n: number }>(
        "SELECT count(*)::int AS n FROM hotel_stays WHERE reservation_id = $1 AND status IN ('reserved', 'in_house')",
        [reservationId],
      );
      if (open?.n) return 0;
      const r = await t.row<{ guest_id: string; number: string }>(
        "SELECT guest_id, number FROM hotel_reservations WHERE id = $1",
        [reservationId],
      );
      const m = r ? await memberOfGuest(t, r.guest_id, true) : null;
      if (!r || !m) return 0;
      const rev = await t.row<{ n: number }>(
        `SELECT COALESCE(sum(l.net_minor), 0)::bigint AS n FROM hotel_folio_lines l JOIN hotel_folios f ON f.id = l.folio_id
         WHERE f.reservation_id = $1 AND l.department = 'rooms' AND l.kind IN ('charge', 'void', 'allowance')`,
        [reservationId],
      );
      const tier = p.tiers.find((x) => x.code === m.tier);
      const base = Math.floor(Math.max(0, rev?.n ?? 0) / p.minor_per_point);
      const points = Math.floor((base * (100 + (tier?.earnBonusPct ?? 0))) / 100);
      const stays = m.stays + 1;
      const lifetime = m.lifetime_points + points;
      await t.run(
        "UPDATE hotel_loyalty_members SET points = points + $2, lifetime_points = $3, stays = $4, tier = $5 WHERE id = $1",
        [m.id, points, lifetime, stays, tierFor(p, stays, lifetime)],
      );
      if (points <= 0) return 0;
      const value = points * p.point_value_minor;
      const journalId = await postToLedger(t, core, {
        orgId: op.orgId,
        propertyId: op.property.id,
        date: op.property.business_date,
        kind: "loyalty",
        memo: `Loyalty points earned — ${r.number} (${points} points)`,
        ref: `loyalty-earn:${reservationId}`,
        lines: [dr(ACC.loyaltyCost, value), cr(ACC.loyalty, value)],
      });
      await t.run(
        `INSERT INTO hotel_loyalty_entries (id, org_id, member_id, property_id, kind, points, value_minor, reservation_id,
           journal_id, note, created_by)
         VALUES ($1,$2,$3,$4,'earn',$5,$6,$7,$8,$9,$10)`,
        [
          newId("hle"),
          op.orgId,
          m.id,
          op.property.id,
          points,
          value,
          reservationId,
          journalId,
          `Stay ${r.number}`,
          op.userId,
        ],
      );
      return points;
    },

    async adjust(t: Db, op: HotelOp, memberId: string, points: number, reason: string): Promise<string> {
      const p = await programmeOf(t, op.orgId);
      if (!p) throw fail.conflict("Set up the loyalty programme first");
      const m = await memberRow(t, op.orgId, memberId, true);
      if (m.points + points < 0) throw fail.conflict(`The member has ${m.points} point(s)`);
      const value = Math.abs(points) * p.point_value_minor;
      const id = newId("hle");
      const journalId = await postToLedger(t, core, {
        orgId: op.orgId,
        propertyId: op.property.id,
        date: op.property.business_date,
        kind: "loyalty",
        memo: `Loyalty points ${points > 0 ? "added" : "removed"} (${points}): ${reason}`,
        ref: `loyalty-adjust:${id}`,
        lines:
          points > 0
            ? [dr(ACC.loyaltyCost, value), cr(ACC.loyalty, value)]
            : [dr(ACC.loyalty, value), cr(ACC.loyaltyCost, value)],
      });
      const lifetime = m.lifetime_points + Math.max(0, points);
      await t.run(
        "UPDATE hotel_loyalty_members SET points = points + $2, lifetime_points = $3, tier = $4 WHERE id = $1",
        [m.id, points, lifetime, tierFor(p, m.stays, lifetime)],
      );
      await t.run(
        `INSERT INTO hotel_loyalty_entries (id, org_id, member_id, property_id, kind, points, value_minor, journal_id, note,
           created_by)
         VALUES ($1,$2,$3,$4,'adjust',$5,$6,$7,$8,$9)`,
        [id, op.orgId, m.id, op.property.id, points, points > 0 ? value : -value, journalId, reason, op.userId],
      );
      await recordAudit(t, {
        actor: op.actor,
        orgId: op.orgId,
        action: "Loyalty points adjusted",
        target: m.number,
        detail: `${points}: ${reason}`,
      });
      return id;
    },
  };
}

export type Loyalty = ReturnType<typeof loyalty>;
