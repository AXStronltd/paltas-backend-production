/*
 * Labour planning: standards (minutes per occupied room, per restaurant cover, per event guest, or fixed per day by
 * department), the staff schedule (one person never has two overlapping shifts — exclusion constraint), the hours the
 * forecast needs against the hours scheduled, and labour cost per occupied room from the payroll postings in the
 * ledger. Planners see names and departments only — never pay.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { PAYROLL_ACCOUNT } from "../accounts.js";
import type { HotelDeps } from "../deps.js";
import { at } from "../outlets/outlets.service.js";
import * as F from "../reports/figures.js";
import type { HotelScope } from "../shared/access.js";
import { addDays, nightsOf } from "../shared/dates.js";

type Standard = z.output<typeof hotel.LabourStandard>;

interface ShiftRow {
  id: string;
  staff_id: string;
  name: string;
  department: hotel.StaffDepartment;
  date: string;
  start_time: string;
  end_time: string;
  minutes: number;
}

const toShift = (r: ShiftRow): hotel.StaffShiftOut => ({
  id: r.id,
  staffId: r.staff_id,
  name: r.name,
  department: r.department,
  date: r.date,
  start: r.start_time,
  end: r.end_time,
  minutes: r.minutes,
});

const SHIFT_SELECT = `SELECT sh.*, p.name FROM hotel_staff_shifts sh JOIN hotel_staff_pay p ON p.id = sh.staff_id`;
const DEPTS: hotel.StaffDepartment[] = ["rooms", "fnb", "spa", "other", "admin"];

export function labourService(d: HotelDeps) {
  const { db } = d.core;

  async function standards(propertyId: string): Promise<Standard[]> {
    const rows = await db.rows<{
      department: hotel.StaffDepartment;
      basis: Standard["basis"];
      minutes_per_unit: number;
    }>("SELECT * FROM hotel_labour_standards WHERE property_id = $1 ORDER BY department, basis", [propertyId]);
    return rows.map((r) => ({ department: r.department, basis: r.basis, minutesPerUnit: r.minutes_per_unit }));
  }

  return {
    async setStandards(s: HotelScope, list: Standard[]) {
      if (new Set(list.map((x) => `${x.department}|${x.basis}`)).size !== list.length)
        throw fail.invalid("One standard per department and basis");
      await db.tx(async (t) => {
        await t.run("DELETE FROM hotel_labour_standards WHERE property_id = $1", [s.property.id]);
        for (const x of list)
          await t.run(
            "INSERT INTO hotel_labour_standards (property_id, department, basis, org_id, minutes_per_unit) VALUES ($1,$2,$3,$4,$5)",
            [s.property.id, x.department, x.basis, s.orgId, x.minutesPerUnit],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Labour standards set",
          target: s.property.id,
          after: list,
        });
      });
      return { standards: await standards(s.property.id) };
    },

    async staff(s: HotelScope) {
      const rows = await db.rows<{ id: string; name: string; department: hotel.StaffDepartment }>(
        "SELECT id, name, department FROM hotel_staff_pay WHERE property_id = $1 AND active ORDER BY department, name",
        [s.property.id],
      );
      return { staff: rows };
    },

    async schedule(s: HotelScope, shifts: { staffId: string; date: string; start: string; end: string }[]) {
      const ids: string[] = [];
      await db.tx(async (t) => {
        for (const x of shifts) {
          const st = await t.row<{ department: string }>(
            "SELECT department FROM hotel_staff_pay WHERE property_id = $1 AND id = $2 AND active",
            [s.property.id, x.staffId],
          );
          if (!st) throw fail.notFound("Staff member not found at this hotel");
          const from = at(x.date, x.start);
          const to = x.end > x.start ? at(x.date, x.end) : at(addDays(x.date, 1), x.end);
          const minutes = Math.round(
            (Date.parse(to.replace(" ", "T") + "Z") - Date.parse(from.replace(" ", "T") + "Z")) / 60_000,
          );
          const id = newId("hsh");
          try {
            await t.run(
              `INSERT INTO hotel_staff_shifts (id, org_id, property_id, staff_id, department, date, start_time, end_time, starts_at,
                 ends_at, minutes, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [
                id,
                s.orgId,
                s.property.id,
                x.staffId,
                st.department,
                x.date,
                x.start,
                x.end,
                from,
                to,
                minutes,
                s.userId,
              ],
            );
          } catch (e) {
            if ((e as { code?: string }).code === "23P01")
              throw fail.conflict(`That person already has a shift overlapping ${x.date} ${x.start}–${x.end}`);
            throw e;
          }
          ids.push(id);
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Shifts scheduled",
          target: s.property.id,
          detail: `${shifts.length}`,
        });
      });
      const rows = await db.rows<ShiftRow>(
        `${SHIFT_SELECT} WHERE sh.id = ANY($1::text[]) ORDER BY sh.date, sh.start_time`,
        [ids],
      );
      return { shifts: rows.map(toShift) };
    },

    async list(s: HotelScope, from: string, to: string) {
      const rows = await db.rows<ShiftRow>(
        `${SHIFT_SELECT} WHERE sh.property_id = $1 AND sh.date BETWEEN $2 AND $3 ORDER BY sh.date, sh.start_time, p.name`,
        [s.property.id, from, to],
      );
      return { shifts: rows.map(toShift) };
    },

    async plan(s: HotelScope, from: string, to: string) {
      const std = await standards(s.property.id);
      const days = [];
      for (const date of nightsOf(from, addDays(to, 1))) {
        const c = await db.row<{ occupied: number; covers: number; guests: number }>(
          `SELECT
             (SELECT count(*)::int FROM hotel_stays WHERE property_id = $1 AND status IN ('reserved', 'in_house', 'checked_out')
                AND arrival <= $2 AND departure > $2) AS occupied,
             (SELECT COALESCE(sum(covers), 0)::int FROM hotel_table_bookings WHERE property_id = $1 AND date = $2
                AND status IN ('booked', 'seated', 'completed')) AS covers,
             (SELECT COALESCE(sum(pax), 0)::int FROM hotel_events WHERE property_id = $1 AND date = $2
                AND status IN ('contract', 'billed')) AS guests`,
          [s.property.id, date],
        );
        const scheduled = await db.rows<{ department: hotel.StaffDepartment; minutes: number }>(
          "SELECT department, sum(minutes)::int AS minutes FROM hotel_staff_shifts WHERE property_id = $1 AND date = $2 GROUP BY department",
          [s.property.id, date],
        );
        const units = {
          per_occupied_room: c?.occupied ?? 0,
          per_cover: c?.covers ?? 0,
          per_event_guest: c?.guests ?? 0,
          fixed_per_day: 1,
        };
        days.push({
          date,
          occupiedRooms: units.per_occupied_room,
          covers: units.per_cover,
          eventGuests: units.per_event_guest,
          departments: DEPTS.map((dep) => {
            const required = std
              .filter((x) => x.department === dep)
              .reduce((n, x) => n + x.minutesPerUnit * units[x.basis], 0);
            const have = scheduled.find((x) => x.department === dep)?.minutes ?? 0;
            return { department: dep, requiredMinutes: required, scheduledMinutes: have, gapMinutes: have - required };
          }),
        });
      }
      const totals = await F.ledgerTotals(db, s.property.id, from, to);
      const cost = Object.values(PAYROLL_ACCOUNT).reduce((n, a) => n + totals.net(a), 0);
      const sold = await F.roomsSold(db, s.property.id, from, to);
      return {
        days,
        labourCostMinor: cost,
        roomsSold: sold,
        labourCostPerOccupiedRoomMinor: sold > 0 ? Math.round(cost / sold) : 0,
        method:
          "Rules: hours needed = the hotel's labour standards × rooms occupied (on the books), restaurant covers booked and event guests; cost from the payroll postings in the ledger",
      };
    },
  };
}

export type LabourService = ReturnType<typeof labourService>;
