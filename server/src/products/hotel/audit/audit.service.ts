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
 * the income audit is that approval), sanctioned discounts (promo codes, member rates), comps and discounts on
 * charges (approved or not), voids without approval, outlet takings paid outside a cashier shift and any difference
 * between rooms occupied and room nights charged; with each outlet's takings (in shift, outside, to rooms). The
 * income auditor signs the day off, which makes the day's revenue final. The sign-off must come from someone other
 * than the person who ran the night audit and other than anyone who made a rate override it acknowledges.
 *
 * Automatic night audit: the PALTAS scheduler calls runScheduled() at the hotel's audit time (job
 * "hotel.night_audit"); before noon it closes the previous business day. A blocked run is recorded with its reasons
 * and the managers are alerted through the outbox; it does not retry until the next scheduled time.
 */
import type { hotel } from "@paltas/contracts";
import { recordAudit, type Actor } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { ApiError, fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { FoliosService } from "../folios/folios.service.js";
import type { ReportsService } from "../reports/reports.service.js";
import { ledgerTotals } from "../reports/figures.js";
import type { ReservationsService } from "../reservations/reservations.service.js";
import type { HotelScope } from "../shared/access.js";
import { addDays } from "../shared/dates.js";
import { messageManagers } from "../shared/outbox.js";
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
      attribute_fee_minor: number;
      requested_attributes: string[];
    }>(
      `SELECT s.id, rm.number AS room_number, n.rate_minor, r.channel_id, c.commission_bp, r.number AS reservation_number,
         s.attribute_fee_minor, s.requested_attributes
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
      // room features sold with the stay (attribute-based selling), charged with each night
      if (s.attribute_fee_minor > 0)
        await folios.charge(t, op, folioId, {
          department: "rooms",
          description: `Room ${s.room_number} features (${s.requested_attributes.join(", ")}) — night of ${date}`,
          net: s.attribute_fee_minor,
          stayId: s.id,
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
         AND n.discount_kind IS NULL
         AND NOT EXISTS (SELECT 1 FROM hotel_folio_lines v WHERE v.voids_line_id = l.id)
       ORDER BY rm.number`,
      [propertyId, date],
    );
  }

  /** Allowances (comps and discounts) given on the day, with who gave and who approved them. */
  async function allowances(t: Db, propertyId: string, date: string) {
    return t.rows<{
      id: string;
      description: string;
      total_minor: number;
      created_by: string | null;
      allowance_approved_by: string | null;
    }>(
      `SELECT id, description, total_minor, created_by, allowance_approved_by FROM hotel_folio_lines
       WHERE property_id = $1 AND business_date = $2 AND kind = 'allowance' ORDER BY seq`,
      [propertyId, date],
    );
  }

  /** Each outlet's takings of the day: paid now (inside / outside a cashier shift) and charged to rooms. */
  async function outletTakings(t: Db, propertyId: string, date: string) {
    return t.rows<{
      outlet_id: string;
      name: string;
      paid: number;
      in_shift: number;
      outside: number;
      to_rooms: number;
    }>(
      `WITH sales AS (
         SELECT DISTINCT l.outlet_id, l.folio_id, f.stay_id IS NOT NULL AS to_room
         FROM hotel_folio_lines l JOIN hotel_folios f ON f.id = l.folio_id
         WHERE l.property_id = $1 AND l.business_date = $2 AND l.kind = 'charge' AND l.outlet_id IS NOT NULL)
       SELECT o.id AS outlet_id, o.name,
         COALESCE((SELECT -sum(p.total_minor) FROM hotel_folio_lines p JOIN sales s ON s.folio_id = p.folio_id
                   WHERE s.outlet_id = o.id AND NOT s.to_room AND p.kind = 'payment'), 0)::bigint AS paid,
         COALESCE((SELECT -sum(p.total_minor) FROM hotel_folio_lines p JOIN sales s ON s.folio_id = p.folio_id
                   WHERE s.outlet_id = o.id AND NOT s.to_room AND p.kind = 'payment' AND p.shift_id IS NOT NULL), 0)::bigint AS in_shift,
         COALESCE((SELECT -sum(p.total_minor) FROM hotel_folio_lines p JOIN sales s ON s.folio_id = p.folio_id
                   WHERE s.outlet_id = o.id AND NOT s.to_room AND p.kind = 'payment' AND p.shift_id IS NULL), 0)::bigint AS outside,
         COALESCE((SELECT sum(c.total_minor) FROM hotel_folio_lines c JOIN sales s ON s.folio_id = c.folio_id
                   WHERE s.outlet_id = o.id AND s.to_room AND c.kind = 'charge' AND c.outlet_id = o.id
                     AND c.business_date = $2), 0)::bigint AS to_rooms
       FROM hotel_outlets o WHERE o.property_id = $1 ORDER BY o.code`,
      [propertyId, date],
    );
  }

  /** Rooms occupied on the night (guests checked in and staying over it) vs room nights charged for it. */
  async function occupancyCheck(t: Db, propertyId: string, date: string) {
    const r = await t.row<{ occupied: number; charged: number }>(
      `SELECT
         (SELECT count(*)::int FROM hotel_stays WHERE property_id = $1 AND status IN ('in_house', 'checked_out')
            AND checked_in_at IS NOT NULL AND arrival <= $2 AND departure > $2) AS occupied,
         (SELECT count(*)::int FROM hotel_folio_lines l WHERE l.property_id = $1 AND l.kind = 'charge' AND l.night_date = $2
            AND NOT EXISTS (SELECT 1 FROM hotel_folio_lines v WHERE v.voids_line_id = l.id)) AS charged`,
      [propertyId, date],
    );
    return { occupied: r?.occupied ?? 0, charged: r?.charged ?? 0 };
  }

  async function findings(t: Db, propertyId: string, date: string): Promise<hotel.IncomeAuditFindingOut[]> {
    const low = await rateOverrides(t, propertyId, date);
    const voids = await t.rows<{ id: string; description: string; total_minor: number }>(
      `SELECT id, description, total_minor FROM hotel_folio_lines
       WHERE property_id = $1 AND business_date = $2 AND kind = 'void' AND void_approved_by IS NULL ORDER BY seq`,
      [propertyId, date],
    );
    const discounted = await t.rows<{
      id: string;
      room: string | null;
      night_date: string;
      rate: number;
      plan: number;
      kind: string;
      ref: string;
    }>(
      `SELECT l.id, rm.number AS room, l.night_date, n.rate_minor AS rate, n.plan_rate_minor AS plan,
         n.discount_kind AS kind, n.discount_ref AS ref
       FROM hotel_folio_lines l
       JOIN hotel_stay_nights n ON n.stay_id = l.stay_id AND n.date = l.night_date
       JOIN hotel_stays s ON s.id = l.stay_id
       LEFT JOIN hotel_rooms rm ON rm.id = s.room_id
       WHERE l.property_id = $1 AND l.business_date = $2 AND l.kind = 'charge' AND n.discount_kind IS NOT NULL
         AND n.rate_minor < n.plan_rate_minor
         AND NOT EXISTS (SELECT 1 FROM hotel_folio_lines v WHERE v.voids_line_id = l.id)
       ORDER BY rm.number`,
      [propertyId, date],
    );
    const given = await allowances(t, propertyId, date);
    const outlets = await outletTakings(t, propertyId, date);
    const occ = await occupancyCheck(t, propertyId, date);
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
      ...discounted.map((l) => ({
        code: "DISCOUNT" as const,
        message: `Room ${l.room ?? "—"}, night of ${l.night_date}: ${l.kind === "promo" ? "promo code" : "member rate"} ${l.ref} — charged ${l.rate}, rate plan ${l.plan}`,
        ref: l.id,
        amountMinor: l.plan - l.rate,
      })),
      ...given.map((a) => ({
        code: a.allowance_approved_by ? ("ALLOWANCE" as const) : ("ALLOWANCE_WITHOUT_APPROVAL" as const),
        message: `${a.description} (${-a.total_minor})${a.allowance_approved_by ? "" : " — not approved yet"}`,
        ref: a.id,
        amountMinor: -a.total_minor,
      })),
      ...outlets
        .filter((o) => o.outside > 0)
        .map((o) => ({
          code: "OUTLET_TAKINGS_OUTSIDE_SHIFT" as const,
          message: `${o.name}: ${o.outside} of ${o.paid} paid now was taken outside any cashier shift`,
          ref: o.outlet_id,
          amountMinor: o.outside,
        })),
      ...(occ.occupied !== occ.charged
        ? [
            {
              code: "ROOM_REVENUE_VS_OCCUPANCY" as const,
              message: `${occ.charged} room night(s) charged for ${occ.occupied} room(s) occupied on ${date}`,
              ref: date,
              amountMinor: 0,
            },
          ]
        : []),
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
      outletTakings: (await outletTakings(t, propertyId, date)).map((o) => ({
        outletId: o.outlet_id,
        name: o.name,
        paidMinor: o.paid,
        inShiftMinor: o.in_shift,
        outsideShiftMinor: o.outside,
        roomChargesMinor: o.to_rooms,
      })),
      occupancyCheck: await occupancyCheck(t, propertyId, date),
    };
  }

  /** Close the business day for `op` (a member, or the scheduler acting as the system). */
  async function run(op: HotelOp, processNoShows: boolean) {
    const out = await db.tx(async (t) => {
      const property = await findProperty(t, op.orgId, op.property.id, true);
      const o: HotelOp = { orgId: op.orgId, userId: op.userId, actor: op.actor, property };
      const date = property.business_date;
      const b = await blocks(t, property.id, date, processNoShows);
      if (b.length) return { blocked: b, date, report: null };
      for (const p of await pendingArrivals(t, property.id, date))
        await reservations.cancelOrNoShow(o, p.reservation_id, "no_show", "No-show processed by the night audit", t);
      await postRoomNights(t, o);
      await reservations.releaseCutoffs(t, o, date);
      const managers = await messageManagers(t, d, o, "daily_report", { date });
      const report: hotel.DailyReport = {
        ...(await reports.dailyReport(t, property, date)),
        distribution: managers
          ? `Recorded in the outbox for ${managers} manager(s) — not e-mailed (no e-mail provider connected)`
          : "Stored for the managers — not e-mailed (no e-mail provider connected)",
      };
      await t.run(
        "INSERT INTO hotel_daily_reports (property_id, business_date, org_id, report) VALUES ($1, $2, $3, $4)",
        [property.id, date, op.orgId, JSON.stringify(report)],
      );
      await t.run(
        "INSERT INTO hotel_income_audits (property_id, business_date, org_id, night_audit_by) VALUES ($1, $2, $3, $4)",
        [property.id, date, op.orgId, op.userId],
      );
      await t.run("UPDATE hotel_properties SET business_date = $2 WHERE id = $1", [property.id, addDays(date, 1)]);
      await t.run(
        "INSERT INTO hotel_night_audits (id, org_id, property_id, business_date, status, run_by) VALUES ($1,$2,$3,$4,'completed',$5)",
        [newId("hna"), op.orgId, property.id, date, op.userId],
      );
      await recordAudit(t, {
        actor: op.actor,
        orgId: op.orgId,
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
          [newId("hna"), op.orgId, op.property.id, out.date, JSON.stringify(out.blocked), op.userId],
        );
        await recordAudit(t, {
          actor: op.actor,
          orgId: op.orgId,
          action: "Night audit blocked",
          target: op.property.id,
          detail: out.blocked.map((x) => x.message).join(" | "),
        });
      });
      throw fail.conflict(`Night audit blocked: ${out.blocked.map((x) => x.message).join(" · ")}`, {
        blocks: out.blocked,
      });
    }
    return { closedDate: out.date, businessDate: addDays(out.date, 1), report: out.report as hotel.DailyReport };
  }

  const SCHEDULER: Actor = { userId: null, role: "system:scheduler" };

  /**
   * The scheduled night audit of one hotel (called by the PALTAS scheduler at the hotel's audit time, in its time
   * zone). An audit time before noon closes the day before `localDate`; from noon on it closes `localDate` itself.
   * Returns one line for the scheduler's run log; a blocked audit is recorded and the managers alerted.
   */
  async function runScheduled(j: { orgId: string; propertyId: string; localDate: string }): Promise<string> {
    const property = await findProperty(db, j.orgId, j.propertyId);
    if (!property.auto_audit_enabled) return `Automatic night audit is off for ${property.name} — nothing done`;
    const closes = property.auto_audit_time < "12:00" ? addDays(j.localDate, -1) : j.localDate;
    if (property.business_date > closes)
      return `${property.name}: business date ${property.business_date} is not due for closing yet — nothing done`;
    const op: HotelOp = { orgId: j.orgId, userId: null, actor: SCHEDULER, property };
    try {
      const r = await run(op, property.auto_audit_no_shows);
      return `${property.name}: night audit for ${r.closedDate} completed; business date now ${r.businessDate}`;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
      const blocks = ((e.details as { blocks?: hotel.AuditBlockOut[] } | undefined)?.blocks ?? []).map(
        (b) => b.message,
      );
      await db.tx((t) =>
        messageManagers(t, d, op, "audit_blocked", {
          date: property.business_date,
          reasons: blocks.join("; ") || e.message,
        }),
      );
      return `${property.name}: night audit for ${property.business_date} blocked — ${blocks.join(" · ") || e.message}`;
    }
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

    run,
    runScheduled,

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
