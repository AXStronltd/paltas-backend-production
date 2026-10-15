/*
 * Night audit and income audit, per hotel.
 *
 * Night audit closes the hotel's business date. It is refused, with every reason, while:
 *   - a cashier shift is open;
 *   - a guest due out has not checked out (or been extended);
 *   - a folio is out of balance (a closed folio with a balance, or the day's folio lines differing from the guest
 *     ledger postings);
 *   - a charge voided on the day still awaits its second-person approval (a void posts at once; the day cannot close
 *     until someone other than the person who voided approves it);
 *   - arrivals are still pending and the auditor has not asked to process them as no-shows.
 * When nothing blocks it, in ONE transaction: no-shows are processed by policy, each in-house room night is charged
 * with its taxes (and channel commission), group blocks past their cut-off are released, the daily report is stored
 * from the ledger, the day is opened for income audit, and the business date rolls forward.
 *
 * Income audit lists rates charged below the rate plan (rate overrides — there is no separate approval for them, so
 * the income audit is that approval) and voids without approval; the income auditor signs the day off, which makes
 * the day's revenue final. The sign-off must come from someone other than the person who ran the night audit and
 * other than anyone who made a rate override it acknowledges.
 */
import type { hotel } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { FoliosService } from "../folios/folios.service.js";
import type { ReportsService } from "../reports/reports.service.js";
import { ledgerTotals } from "../reports/figures.js";
import type { ReservationsService } from "../reservations/reservations.service.js";
import type { HotelScope } from "../shared/access.js";
import { addDays } from "../shared/dates.js";
import { cr, dr, postToLedger } from "../shared/posting.js";
import { findProperty } from "../shared/property.js";

export function auditService(
  d: HotelDeps,
  x: { folios: FoliosService; reservations: ReservationsService; reports: ReportsService },
) {
  const { core } = d;
  const { db } = core;
  const { folios, reservations, reports } = x;

  async function pendingArrivals(t: Db, propertyId: string, date: string) {
    return t.rows<{ reservation_id: string; number: string }>(
      `SELECT DISTINCT s.reservation_id, r.number FROM hotel_stays s JOIN hotel_reservations r ON r.id = s.reservation_id
       WHERE s.property_id = $1 AND s.status = 'reserved' AND s.arrival <= $2 ORDER BY r.number`,
      [propertyId, date],
    );
  }

  async function blocks(
    t: Db,
    propertyId: string,
    date: string,
    processNoShows: boolean,
  ): Promise<hotel.AuditBlockOut[]> {
    const out: hotel.AuditBlockOut[] = [];
    const shifts = await t.rows<{ id: string; name: string; business_date: string }>(
      `SELECT c.id, u.name, c.business_date FROM hotel_cashier_shifts c JOIN users u ON u.id = c.user_id
       WHERE c.property_id = $1 AND c.status = 'open' ORDER BY c.opened_at`,
      [propertyId],
    );
    for (const sh of shifts)
      out.push({
        code: "OPEN_CASHIER_SHIFT",
        message: `The cashier shift of ${sh.name} (opened on ${sh.business_date}) is still open — close it first`,
        refs: [sh.id],
      });
    const due = await t.rows<{ id: string; number: string | null }>(
      `SELECT s.id, r.number FROM hotel_stays s LEFT JOIN hotel_rooms r ON r.id = s.room_id
       WHERE s.property_id = $1 AND s.status = 'in_house' AND s.departure <= $2 ORDER BY r.number`,
      [propertyId, date],
    );
    if (due.length)
      out.push({
        code: "DEPARTURE_NOT_CHECKED_OUT",
        message: `Due out but not checked out: room(s) ${due.map((r) => r.number).join(", ")} — check out or extend`,
        refs: due.map((r) => r.id),
      });
    const closed = await t.rows<{ id: string; number: string; n: number }>(
      `SELECT f.id, f.number, sum(l.total_minor)::bigint AS n FROM hotel_folios f JOIN hotel_folio_lines l ON l.folio_id = f.id
       WHERE f.property_id = $1 AND f.status = 'closed' GROUP BY f.id, f.number HAVING sum(l.total_minor) <> 0`,
      [propertyId],
    );
    if (closed.length)
      out.push({
        code: "FOLIO_OUT_OF_BALANCE",
        message: `Closed folio(s) with a balance: ${closed.map((f) => `${f.number} (${f.n})`).join(", ")}`,
        refs: closed.map((f) => f.id),
      });
    const lines = await t.row<{ n: number }>(
      "SELECT COALESCE(sum(total_minor), 0)::bigint AS n FROM hotel_folio_lines WHERE property_id = $1 AND business_date = $2",
      [propertyId, date],
    );
    const ledger = (await ledgerTotals(t, propertyId, date, date)).net(ACC.guestLedger);
    if ((lines?.n ?? 0) !== ledger)
      out.push({
        code: "FOLIO_OUT_OF_BALANCE",
        message: `The day's folio lines (${lines?.n ?? 0}) differ from the guest-ledger postings (${ledger})`,
        refs: [],
      });
    const voids = await t.rows<{ id: string; description: string }>(
      `SELECT id, description FROM hotel_folio_lines
       WHERE property_id = $1 AND business_date = $2 AND kind = 'void' AND void_approved_by IS NULL ORDER BY seq`,
      [propertyId, date],
    );
    if (voids.length)
      out.push({
        code: "UNAPPROVED_VOIDS",
        message: `${voids.length} void(s) await approval by someone other than the person who voided: ${voids.map((v) => v.description).join("; ")}`,
        refs: voids.map((v) => v.id),
      });
    const pending = await pendingArrivals(t, propertyId, date);
    if (pending.length && !processNoShows)
      out.push({
        code: "PENDING_NO_SHOWS",
        message: `Arrivals not checked in: ${pending.map((p) => p.number).join(", ")} — check them in, cancel them, or run the audit with processNoShows to charge no-shows by policy`,
        refs: pending.map((p) => p.reservation_id),
      });
    return out;
  }

  /** Charge tonight's room and tax for every guest in house (once per night), with channel commission. */
  async function postRoomNights(t: Db, op: HotelOp): Promise<number> {
    const date = op.property.business_date;
    const stays = await t.rows<{
      id: string;
      room_number: string;
      rate_minor: number;
      channel_id: string | null;
      commission_bp: number | null;
      reservation_number: string;
    }>(
      `SELECT s.id, rm.number AS room_number, n.rate_minor, r.channel_id, c.commission_bp, r.number AS reservation_number
       FROM hotel_stays s
       JOIN hotel_rooms rm ON rm.id = s.room_id
       JOIN hotel_reservations r ON r.id = s.reservation_id
       JOIN hotel_stay_nights n ON n.stay_id = s.id AND n.date = $2
       LEFT JOIN hotel_channels c ON c.id = r.channel_id
       WHERE s.property_id = $1 AND s.status = 'in_house'
         AND NOT EXISTS (SELECT 1 FROM hotel_folio_lines l WHERE l.stay_id = s.id AND l.night_date = $2 AND l.kind = 'charge')
       ORDER BY rm.number`,
      [op.property.id, date],
    );
    for (const s of stays) {
      const folioId = await folios.folioFor(t, s.id, "rooms");
      await folios.charge(t, op, folioId, {
        department: "rooms",
        description: `Room ${s.room_number} — night of ${date}`,
        net: s.rate_minor,
        nights: 1,
        stayId: s.id,
        nightDate: date,
        channelId: s.channel_id,
      });
      const commission = s.commission_bp ? Math.round((s.rate_minor * s.commission_bp) / 10_000) : 0;
      if (commission > 0)
        await postToLedger(t, core, {
          orgId: op.orgId,
          propertyId: op.property.id,
          date,
          kind: "commission",
          memo: `Channel commission — ${s.reservation_number}, night of ${date}`,
          ref: `commission:${s.id}:${date}`,
          channelId: s.channel_id,
          lines: [dr(ACC.commissions, commission), cr(ACC.payables, commission)],
        });
    }
    return stays.length;
  }

  /** Who set each rate below plan charged on the day (the reservation's maker). */
  async function rateOverrides(t: Db, propertyId: string, date: string) {
    return t.rows<{ id: string; room: string; night_date: string; rate: number; plan: number; made_by: string | null }>(
      `SELECT l.id, rm.number AS room, l.night_date, n.rate_minor AS rate, n.plan_rate_minor AS plan, r.created_by AS made_by
       FROM hotel_folio_lines l
       JOIN hotel_stay_nights n ON n.stay_id = l.stay_id AND n.date = l.night_date
       JOIN hotel_stays s ON s.id = l.stay_id
       JOIN hotel_reservations r ON r.id = s.reservation_id
       LEFT JOIN hotel_rooms rm ON rm.id = s.room_id
       WHERE l.property_id = $1 AND l.business_date = $2 AND l.kind = 'charge' AND n.rate_minor < n.plan_rate_minor
         AND NOT EXISTS (SELECT 1 FROM hotel_folio_lines v WHERE v.voids_line_id = l.id)
       ORDER BY rm.number`,
      [propertyId, date],
    );
  }

  async function findings(t: Db, propertyId: string, date: string): Promise<hotel.IncomeAuditFindingOut[]> {
    const low = await rateOverrides(t, propertyId, date);
    const voids = await t.rows<{ id: string; description: string; total_minor: number }>(
      `SELECT id, description, total_minor FROM hotel_folio_lines
       WHERE property_id = $1 AND business_date = $2 AND kind = 'void' AND void_approved_by IS NULL ORDER BY seq`,
      [propertyId, date],
    );
    return [
      ...low.map((l) => ({
        code: "RATE_BELOW_PLAN" as const,
        message: `Room ${l.room}, night of ${l.night_date}: charged ${l.rate}, rate plan ${l.plan}`,
        ref: l.id,
        amountMinor: l.plan - l.rate,
      })),
      ...voids.map((v) => ({
        code: "VOID_WITHOUT_APPROVAL" as const,
        message: `${v.description} (${-v.total_minor}) was voided without approval`,
        ref: v.id,
        amountMinor: -v.total_minor,
      })),
    ];
  }

  async function incomeAudit(t: Db, propertyId: string, date: string): Promise<hotel.IncomeAuditOut> {
    const row = await t.row<{
      signed_off_by: string | null;
      signed_off_at: string | null;
      note: string | null;
    }>("SELECT * FROM hotel_income_audits WHERE property_id = $1 AND business_date = $2", [propertyId, date]);
    if (!row) throw fail.notFound("No closed day to audit — run the night audit first");
    return {
      propertyId,
      businessDate: date,
      findings: await findings(t, propertyId, date),
      signedOffBy: row.signed_off_by,
      signedOffAt: row.signed_off_at,
      note: row.note,
      final: !!row.signed_off_by,
    };
  }

  return {
    async check(s: HotelScope) {
      const date = s.property.business_date;
      const b = await blocks(db, s.property.id, date, false);
      const pending = await pendingArrivals(db, s.property.id, date);
      return {
        businessDate: date,
        blocks: b,
        pendingArrivals: pending.map((p) => p.number),
        canRun: b.every((x) => x.code === "PENDING_NO_SHOWS"),
      };
    },

    async run(s: HotelScope, processNoShows: boolean) {
      const out = await db.tx(async (t) => {
        const property = await findProperty(t, s.orgId, s.property.id, true);
        const op: HotelOp = { orgId: s.orgId, userId: s.userId, actor: s.actor, property };
        const date = property.business_date;
        const b = await blocks(t, property.id, date, processNoShows);
        if (b.length) return { blocked: b, date, report: null };
        for (const p of await pendingArrivals(t, property.id, date))
          await reservations.cancelOrNoShow(op, p.reservation_id, "no_show", "No-show processed by the night audit", t);
        await postRoomNights(t, op);
        await reservations.releaseCutoffs(t, op, date);
        const report = await reports.dailyReport(t, property, date);
        await t.run(
          "INSERT INTO hotel_daily_reports (property_id, business_date, org_id, report) VALUES ($1, $2, $3, $4)",
          [property.id, date, s.orgId, JSON.stringify(report)],
        );
        await t.run(
          "INSERT INTO hotel_income_audits (property_id, business_date, org_id, night_audit_by) VALUES ($1, $2, $3, $4)",
          [property.id, date, s.orgId, s.userId],
        );
        await t.run("UPDATE hotel_properties SET business_date = $2 WHERE id = $1", [property.id, addDays(date, 1)]);
        await t.run(
          "INSERT INTO hotel_night_audits (id, org_id, property_id, business_date, status, run_by) VALUES ($1,$2,$3,$4,'completed',$5)",
          [newId("hna"), s.orgId, property.id, date, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Night audit completed",
          target: property.id,
          detail: `${date} closed · occupancy ${report.occupancyPct}% · revenue ${report.revenue.total}`,
        });
        return { blocked: null, report, date };
      });
      if (out.blocked) {
        await db.tx(async (t) => {
          await t.run(
            "INSERT INTO hotel_night_audits (id, org_id, property_id, business_date, status, blocks, run_by) VALUES ($1,$2,$3,$4,'blocked',$5,$6)",
            [newId("hna"), s.orgId, s.property.id, out.date, JSON.stringify(out.blocked), s.userId],
          );
          await recordAudit(t, {
            actor: s.actor,
            orgId: s.orgId,
            action: "Night audit blocked",
            target: s.property.id,
            detail: out.blocked.map((x) => x.message).join(" | "),
          });
        });
        throw fail.conflict(`Night audit blocked: ${out.blocked.map((x) => x.message).join(" · ")}`, {
          blocks: out.blocked,
        });
      }
      return { closedDate: out.date, businessDate: addDays(out.date, 1), report: out.report as hotel.DailyReport };
    },

    async dailyReport(s: HotelScope, date: string): Promise<hotel.DailyReport> {
      const r = await db.row<{ report: hotel.DailyReport }>(
        "SELECT report FROM hotel_daily_reports WHERE property_id = $1 AND business_date = $2",
        [s.property.id, date],
      );
      if (!r) throw fail.notFound("No daily report for this date — the night audit has not closed it");
      return r.report;
    },

    getIncomeAudit: (s: HotelScope, date: string) => incomeAudit(db, s.property.id, date),

    async signOff(s: HotelScope, date: string, note: string, acknowledge: boolean) {
      await db.tx(async (t) => {
        const row = await t.row<{ night_audit_by: string | null; signed_off_by: string | null }>(
          "SELECT night_audit_by, signed_off_by FROM hotel_income_audits WHERE property_id = $1 AND business_date = $2 FOR UPDATE",
          [s.property.id, date],
        );
        if (!row) throw fail.notFound("No closed day to audit — run the night audit first");
        if (row.signed_off_by) throw fail.conflict("This day is already signed off");
        if (row.night_audit_by === s.userId)
          throw fail.separationOfDuties("You ran this night audit — someone else must sign off the income audit");
        const mine = (await rateOverrides(t, s.property.id, date)).filter((o) => o.made_by === s.userId);
        if (mine.length)
          throw fail.separationOfDuties(
            `You set the rate below plan for room(s) ${mine.map((o) => o.room).join(", ")} — someone else must acknowledge it`,
          );
        const open = await findings(t, s.property.id, date);
        if (open.length && !acknowledge)
          throw fail.conflict(`${open.length} finding(s) to acknowledge before sign-off`, { findings: open });
        await t.run(
          `UPDATE hotel_income_audits SET signed_off_by = $3, signed_off_at = now(), note = $4, findings = $5
           WHERE property_id = $1 AND business_date = $2`,
          [s.property.id, date, s.userId, note, JSON.stringify(open)],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Income audit signed off",
          target: `${s.property.id}:${date}`,
          detail: `${open.length} finding(s) acknowledged · ${note}`,
        });
      });
      return incomeAudit(db, s.property.id, date);
    },
  };
}

export type AuditService = ReturnType<typeof auditService>;
