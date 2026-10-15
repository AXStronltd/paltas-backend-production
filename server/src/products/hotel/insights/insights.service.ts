/*
 * Dashboards and reports from the hotel's own records (no sensors, no external AI):
 *   - revenue by outlet (folio lines) and F&B cost % by outlet (stock used by recipe or issued to the outlet);
 *   - housekeeping productivity per attendant and out-of-order room nights; today's cleaning order by rules
 *     (arrivals first, then check-outs, vacant dirty rooms, stay-overs; by floor) with linen changes due; an
 *     attendant finishing a room with the checklist, damage opening a maintenance ticket;
 *   - sustainability: energy, water, waste and carbon per occupied room from meter readings staff record.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { REVENUE_ACCOUNT } from "../accounts.js";
import type { HotelDeps } from "../deps.js";
import * as F from "../reports/figures.js";
import type { RoomsService } from "../rooms/rooms.service.js";
import type { HotelScope } from "../shared/access.js";
import { daysBetween } from "../shared/dates.js";
import { toMilli } from "../stock/stock.service.js";

/** What an attendant confirms before a room counts as cleaned. */
export const HK_CHECKLIST = ["bed", "bathroom", "amenities", "minibar", "floor"];

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 100 : 0);
const two = (n: number) => Math.round(n * 100) / 100;

export function insightsService(d: HotelDeps, x: { rooms: RoomsService }) {
  const { db } = d.core;
  const { rooms } = x;

  return {
    async outlets(s: HotelScope, from: string, to: string) {
      const rows = await db.rows<{
        id: string;
        name: string;
        department: "rooms" | "fnb" | "spa" | "other";
        revenue: number;
        covers: number;
        cost: number;
      }>(
        `SELECT o.id, o.name, o.department,
           COALESCE((SELECT sum(l.net_minor) FROM hotel_folio_lines l WHERE l.outlet_id = o.id AND l.business_date BETWEEN $2 AND $3
                     AND l.kind IN ('charge', 'void', 'allowance')), 0)::bigint AS revenue,
           COALESCE((SELECT sum(covers) FROM hotel_pos_orders p WHERE p.outlet_id = o.id AND p.status = 'settled'
                     AND p.business_date BETWEEN $2 AND $3), 0)::int AS covers,
           COALESCE((SELECT -sum(m.value_minor) FROM hotel_stock_moves m WHERE m.outlet_id = o.id AND m.business_date BETWEEN $2 AND $3
                     AND m.kind IN ('sale', 'issue', 'waste')), 0)::bigint AS cost
         FROM hotel_outlets o WHERE o.property_id = $1 ORDER BY o.code`,
        [s.property.id, from, to],
      );
      const totals = await F.ledgerTotals(db, s.property.id, from, to);
      const fnbRevenue = totals.credit(REVENUE_ACCOUNT.fnb);
      const fnbCost = totals.net("5200");
      return {
        outlets: rows.map((r) => ({
          outletId: r.id,
          name: r.name,
          department: r.department,
          revenueMinor: r.revenue,
          covers: r.covers,
          costOfSalesMinor: r.cost,
          costPct: pct(r.cost, r.revenue),
        })),
        fnbRevenueMinor: fnbRevenue,
        fnbCostOfSalesMinor: fnbCost,
        fnbCostPct: pct(fnbCost, fnbRevenue),
      };
    },

    async housekeeping(s: HotelScope, from: string, to: string) {
      const rows = await db.rows<{ attendant: string | null; n: number; avg: number | null }>(
        `SELECT attendant, count(*)::int AS n, round(avg(minutes), 1)::float AS avg FROM hotel_hk_cleans
         WHERE property_id = $1 AND business_date BETWEEN $2 AND $3 GROUP BY attendant ORDER BY attendant`,
        [s.property.id, from, to],
      );
      const all = await db.row<{ n: number; avg: number | null }>(
        `SELECT count(*)::int AS n, round(avg(minutes), 1)::float AS avg FROM hotel_hk_cleans
         WHERE property_id = $1 AND business_date BETWEEN $2 AND $3`,
        [s.property.id, from, to],
      );
      return {
        attendants: rows.map((r) => ({ userId: r.attendant, roomsCleaned: r.n, averageMinutes: r.avg })),
        roomsCleaned: all?.n ?? 0,
        averageMinutes: all?.avg ?? null,
        outOfOrderRoomNights: await F.outOfOrder(db, s.property.id, from, to),
      };
    },

    async plan(s: HotelScope) {
      const bd = s.property.business_date;
      const list = await db.rows<{
        id: string;
        number: string;
        floor: string;
        hk_status: hotel.RoomOut["housekeeping"];
        service_status: string;
        assigned: string | null;
        in_house_arrival: string | null;
        in_house_departure: string | null;
        linen_reuse: boolean | null;
        arriving: boolean;
        left_today: boolean;
      }>(
        `SELECT r.id, r.number, r.floor, r.hk_status, r.service_status, a.attendant_user_id AS assigned,
           ih.arrival AS in_house_arrival, ih.departure AS in_house_departure, ih.linen_reuse,
           EXISTS (SELECT 1 FROM hotel_stays x WHERE x.room_id = r.id AND x.status = 'reserved' AND x.arrival = $2) AS arriving,
           EXISTS (SELECT 1 FROM hotel_stays x WHERE x.room_id = r.id AND x.status = 'checked_out'
                   AND x.checked_out_at IS NOT NULL AND x.departure <= $2) AS left_today
         FROM hotel_rooms r
         LEFT JOIN hotel_hk_assignments a ON a.room_id = r.id AND a.date = $2
         LEFT JOIN LATERAL (SELECT st.arrival, st.departure, res.linen_reuse FROM hotel_stays st
                            JOIN hotel_reservations res ON res.id = st.reservation_id
                            WHERE st.room_id = r.id AND st.status = 'in_house' LIMIT 1) ih ON true
         WHERE r.property_id = $1 AND r.service_status = 'in_service'`,
        [s.property.id, bd],
      );
      const ready = (hk: string) =>
        s.property.require_inspection ? hk === "inspected" : ["clean", "inspected"].includes(hk);
      const out = [];
      for (const r of list) {
        let task: "arrival_prep" | "checkout" | "stayover" | "vacant_dirty" | null = null;
        let linen = false;
        if (r.in_house_arrival) {
          task = "stayover";
          const n = daysBetween(r.in_house_arrival, bd);
          const every = s.property.linen_change_nights * (r.linen_reuse ? 2 : 1);
          linen = n > 0 && n % every === 0;
        } else if (r.arriving && !ready(r.hk_status)) task = "arrival_prep";
        else if (r.hk_status === "dirty" || r.hk_status === "cleaning")
          task = r.left_today ? "checkout" : "vacant_dirty";
        if (!task) continue;
        const priority = { arrival_prep: 1, checkout: 2, vacant_dirty: 3, stayover: 4 }[task];
        out.push({
          roomId: r.id,
          number: r.number,
          floor: r.floor,
          task,
          priority,
          linenChange: task === "checkout" || linen,
          assignedTo: r.assigned,
          housekeeping: r.hk_status,
        });
      }
      out.sort(
        (a, b) =>
          a.priority - b.priority ||
          a.floor.localeCompare(b.floor) ||
          a.number.localeCompare(b.number, "en", { numeric: true }),
      );
      return {
        date: bd,
        rooms: out,
        method:
          "Rules: rooms for today's arrivals first, then check-outs, vacant dirty rooms, stay-overs — floor by floor; linen every N nights (twice as long for guests who reuse)",
      };
    },

    async reportClean(s: HotelScope, roomId: string, b: z.output<typeof hotel.reportHousekeeping.body>) {
      const missing = HK_CHECKLIST.filter((k) => b.checklist[k] !== true);
      if (missing.length) throw fail.invalid(`Tick every checklist item: ${missing.join(", ")}`);
      const room = await rooms.setHousekeeping(s, roomId, "clean");
      const out = await db.tx(async (t) => {
        const clean = await t.row<{ id: string; minutes: number }>(
          "SELECT id, minutes FROM hotel_hk_cleans WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1",
          [roomId],
        );
        let ticketId: string | null = null;
        if (b.damage) {
          ticketId = newId("hmt");
          await t.run(
            `INSERT INTO hotel_maintenance (id, org_id, property_id, room_id, title, kind, priority, note, created_by)
             VALUES ($1,$2,$3,$4,$5,'corrective','normal',$6,$7)`,
            [
              ticketId,
              s.orgId,
              s.property.id,
              roomId,
              `Damage reported by housekeeping: ${b.damage.note}`,
              b.damage.photoRef ? `Photo: ${b.damage.photoRef}` : "",
              s.userId,
            ],
          );
          await recordAudit(t, {
            actor: s.actor,
            orgId: s.orgId,
            action: "Damage reported",
            target: room.number,
            detail: b.damage.note,
          });
        }
        if (clean)
          await t.run("UPDATE hotel_hk_cleans SET checklist = $2, ticket_id = $3 WHERE id = $1", [
            clean.id,
            JSON.stringify(b.checklist),
            ticketId,
          ]);
        return { ticketId, minutes: clean?.minutes ?? 0 };
      });
      return { room, ...out };
    },

    async recordMeters(s: HotelScope, readings: { date: string; kind: string; quantity: number }[]) {
      await db.tx(async (t) => {
        for (const r of readings)
          await t.run(
            `INSERT INTO hotel_meter_readings (property_id, date, kind, org_id, qty_milli, recorded_by) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (property_id, date, kind) DO UPDATE SET qty_milli = EXCLUDED.qty_milli, recorded_by = EXCLUDED.recorded_by`,
            [s.property.id, r.date, r.kind, s.orgId, toMilli(r.quantity), s.userId],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Meter readings recorded",
          target: s.property.id,
          detail: `${readings.length}`,
        });
      });
      return { recorded: readings.length };
    },

    async sustainability(s: HotelScope, from: string, to: string) {
      const m = await db.rows<{ kind: string; qty: number; days: number }>(
        `SELECT kind, sum(qty_milli)::bigint AS qty, count(DISTINCT date)::int AS days FROM hotel_meter_readings
         WHERE property_id = $1 AND date BETWEEN $2 AND $3 GROUP BY kind`,
        [s.property.id, from, to],
      );
      const days = await db.row<{ n: number }>(
        "SELECT count(DISTINCT date)::int AS n FROM hotel_meter_readings WHERE property_id = $1 AND date BETWEEN $2 AND $3",
        [s.property.id, from, to],
      );
      const get = (k: string) => (m.find((x) => x.kind === k)?.qty ?? 0) / 1000;
      const energy = get("energy_kwh");
      const carbon = (energy * s.property.carbon_g_per_kwh) / 1000;
      const occupied = await F.roomsSold(db, s.property.id, from, to);
      const per = (n: number) => (occupied > 0 ? two(n / occupied) : 0);
      const linen = await db.row<{ n: number }>(
        `SELECT count(DISTINCT r.id)::int AS n FROM hotel_reservations r JOIN hotel_stays st ON st.reservation_id = r.id
         WHERE r.property_id = $1 AND r.linen_reuse AND st.arrival <= $3 AND st.departure > $2
           AND st.status IN ('reserved', 'in_house', 'checked_out')`,
        [s.property.id, from, to],
      );
      const eco = await db.row<{ n: number }>(
        `SELECT count(*)::int AS n FROM hotel_room_commands WHERE property_id = $1 AND command = 'eco_on'
           AND created_at::date BETWEEN $2 AND $3`,
        [s.property.id, from, to],
      );
      return {
        occupiedRooms: occupied,
        totals: {
          energyKwh: two(energy),
          waterM3: two(get("water_m3")),
          wasteKg: two(get("waste_kg")),
          carbonKg: two(carbon),
        },
        perOccupiedRoom: {
          energyKwh: per(energy),
          waterM3: per(get("water_m3")),
          wasteKg: per(get("waste_kg")),
          carbonKg: per(carbon),
        },
        readingDays: days?.n ?? 0,
        linenReuseStays: linen?.n ?? 0,
        ecoModeCommands: eco?.n ?? 0,
        method:
          "From the meter readings staff record and the hotel's own carbon factor per kWh; occupied rooms are the room nights charged (ledger)",
        sensors: d.adapters.sensors.state,
      };
    },
  };
}

export type InsightsService = ReturnType<typeof insightsService>;
