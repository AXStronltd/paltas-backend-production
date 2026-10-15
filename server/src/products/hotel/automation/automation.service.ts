/*
 * What runs by itself:
 *   - the night audit at the hotel's set time: turning it on registers the hotel's schedule with the PALTAS
 *     scheduler (job "hotel.night_audit", cron at the audit time in the hotel's time zone); the job calls
 *     audit.runScheduled() and then the daily automation for the new business date;
 *   - the daily automation: pre-arrival messages for arrivals within the hotel's pre-arrival days (recorded in the
 *     outbox once per reservation) and a ticket for every preventive maintenance plan that falls due.
 * Booking confirmations and post-stay surveys are recorded by the booking and check-out themselves.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { HotelScope } from "../shared/access.js";
import { addDays } from "../shared/dates.js";
import { messageGuest } from "../shared/outbox.js";
import { findProperty, fromBp, toBp, type PropertyRow } from "../shared/property.js";

export const NIGHT_AUDIT_JOB = "hotel.night_audit";

export const toSettings = (p: PropertyRow): hotel.ExtensionSettings => ({
  autoNightAudit: { enabled: p.auto_audit_enabled, time: p.auto_audit_time, processNoShows: p.auto_audit_no_shows },
  preArrivalDays: p.pre_arrival_days,
  ffeReservePct: fromBp(p.ffe_reserve_bp),
  carbonGramsPerKwh: p.carbon_g_per_kwh,
  linenChangeNights: p.linen_change_nights,
  overtimeMultiplierPct: p.overtime_bp / 100,
  standardDayHours: p.standard_day_hours,
  invoice: { legalName: p.legal_name, taxId: p.tax_id, address: p.address },
});

interface PlanRow {
  id: string;
  title: string;
  asset_label: string;
  room_id: string | null;
  every_days: number;
  next_due: string;
  active: boolean;
}

const toPlan = (p: PlanRow): hotel.MaintenancePlanOut => ({
  id: p.id,
  title: p.title,
  assetLabel: p.asset_label,
  roomId: p.room_id,
  everyDays: p.every_days,
  nextDue: p.next_due,
  active: p.active,
});

export function automationService(d: HotelDeps) {
  const { core } = d;
  const { db } = core;

  /** Pre-arrival messages and preventive tickets due on the business date. */
  async function daily(t: Db, op: HotelOp) {
    const bd = op.property.business_date;
    let preArrival = 0;
    if (op.property.pre_arrival_days > 0) {
      const due = await t.rows<{ id: string }>(
        `SELECT DISTINCT r.id FROM hotel_reservations r JOIN hotel_stays s ON s.reservation_id = r.id
         WHERE r.property_id = $1 AND s.status = 'reserved' AND r.arrival > $2 AND r.arrival <= $3
           AND NOT EXISTS (SELECT 1 FROM hotel_messages m WHERE m.reservation_id = r.id AND m.template = 'pre_arrival')
         ORDER BY r.id`,
        [op.property.id, bd, addDays(bd, op.property.pre_arrival_days)],
      );
      for (const r of due) if (await messageGuest(t, d, op, "pre_arrival", r.id)) preArrival++;
    }
    let tickets = 0;
    const plans = await t.rows<PlanRow>(
      "SELECT * FROM hotel_maintenance_plans WHERE property_id = $1 AND active AND next_due <= $2 ORDER BY id FOR UPDATE",
      [op.property.id, bd],
    );
    for (const p of plans) {
      const made = await t.run(
        `INSERT INTO hotel_maintenance (id, org_id, property_id, room_id, title, kind, priority, due_date, plan_id, created_by)
         VALUES ($1,$2,$3,$4,$5,'preventive','normal',$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          newId("hmt"),
          op.orgId,
          op.property.id,
          p.room_id,
          `${p.asset_label}: ${p.title}`,
          p.next_due,
          p.id,
          op.userId,
        ],
      );
      tickets += made;
      let next = p.next_due;
      while (next <= bd) next = addDays(next, p.every_days);
      await t.run("UPDATE hotel_maintenance_plans SET next_due = $2 WHERE id = $1", [p.id, next]);
    }
    return { preArrival, preventiveTickets: tickets };
  }

  return {
    daily,

    getSettings: (s: HotelScope) => toSettings(s.property),

    async updateSettings(s: HotelScope, b: z.output<typeof hotel.updateExtensionSettings.body>) {
      await db.tx(async (t) => {
        const p = await findProperty(t, s.orgId, s.property.id, true);
        const a = b.autoNightAudit;
        await t.run(
          `UPDATE hotel_properties SET
             auto_audit_enabled = COALESCE($2, auto_audit_enabled), auto_audit_time = COALESCE($3, auto_audit_time),
             auto_audit_no_shows = COALESCE($4, auto_audit_no_shows), pre_arrival_days = COALESCE($5, pre_arrival_days),
             ffe_reserve_bp = COALESCE($6, ffe_reserve_bp), carbon_g_per_kwh = COALESCE($7, carbon_g_per_kwh),
             linen_change_nights = COALESCE($8, linen_change_nights), overtime_bp = COALESCE($9, overtime_bp),
             standard_day_hours = COALESCE($10, standard_day_hours), legal_name = COALESCE($11, legal_name),
             tax_id = COALESCE($12, tax_id), address = COALESCE($13, address)
           WHERE id = $1`,
          [
            p.id,
            a?.enabled ?? null,
            a?.time ?? null,
            a?.processNoShows ?? null,
            b.preArrivalDays ?? null,
            b.ffeReservePct == null ? null : toBp(b.ffeReservePct),
            b.carbonGramsPerKwh ?? null,
            b.linenChangeNights ?? null,
            b.overtimeMultiplierPct == null ? null : b.overtimeMultiplierPct * 100,
            b.standardDayHours ?? null,
            b.invoice?.legalName ?? null,
            b.invoice?.taxId ?? null,
            b.invoice?.address ?? null,
          ],
        );
        const after = await findProperty(t, s.orgId, s.property.id);
        if (after.auto_audit_enabled) {
          const [hh, mm] = after.auto_audit_time.split(":");
          await core.scheduler.ensureJob(t, {
            key: NIGHT_AUDIT_JOB,
            orgId: s.orgId,
            targetId: after.id,
            label: `Night audit — ${after.name}`,
            cron: `${Number(mm)} ${Number(hh)} * * *`,
            timezone: after.timezone,
          });
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Hotel automation and finance settings changed",
          target: p.id,
          before: toSettings(p),
          after: toSettings(after),
        });
      });
      return toSettings(await findProperty(db, s.orgId, s.property.id));
    },

    async run(s: HotelScope) {
      const out = await db.tx((t) => daily(t, s));
      return { ...out, messaging: d.adapters.messaging.state };
    },

    // ---------------------------------------------------------------- preventive maintenance plans
    async listPlans(s: HotelScope) {
      const rows = await db.rows<PlanRow>(
        "SELECT * FROM hotel_maintenance_plans WHERE property_id = $1 ORDER BY next_due, id",
        [s.property.id],
      );
      return { plans: rows.map(toPlan) };
    },

    async createPlan(s: HotelScope, b: z.output<typeof hotel.createMaintenancePlan.body>) {
      const id = newId("hmp");
      await db.tx(async (t) => {
        if (
          b.roomId &&
          !(await t.row("SELECT 1 FROM hotel_rooms WHERE property_id = $1 AND id = $2", [s.property.id, b.roomId]))
        )
          throw fail.notFound("Room not found");
        await t.run(
          `INSERT INTO hotel_maintenance_plans (id, org_id, property_id, title, asset_label, room_id, every_days, next_due, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, s.orgId, s.property.id, b.title, b.assetLabel, b.roomId ?? null, b.everyDays, b.firstDue, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Preventive maintenance plan added",
          target: id,
          detail: `${b.assetLabel}: ${b.title} every ${b.everyDays} day(s)`,
        });
      });
      return toPlan((await db.row<PlanRow>("SELECT * FROM hotel_maintenance_plans WHERE id = $1", [id])) as PlanRow);
    },
  };
}

export type AutomationService = ReturnType<typeof automationService>;
