/*
 * Rooms: the live status board, housekeeping (attendants' own rooms, supervisor inspection), maintenance tickets
 * that take rooms out of order (and out of inventory), lost and found, minibar and outlet charges to rooms.
 *
 * Status machine per room:  occupancy (vacant | occupied, from the stays)  ×  housekeeping (dirty → cleaning →
 * clean → inspected)  ×  service (in service | out of order | out of service). Check-out sets the room dirty;
 * inspection (or clean, where the hotel allows) makes it ready for the front desk.
 */
import { roleCan, type hotel, type z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps } from "../deps.js";
import type { FoliosService } from "../folios/folios.service.js";
import * as folioRepo from "../folios/folios.repo.js";
import type { HotelScope } from "../shared/access.js";
import { addDays } from "../shared/dates.js";
import { moveInventory, queueAri } from "../shared/inventory.js";
import { lockBusinessDate } from "../shared/posting.js";
import { loadRateBook } from "../shared/rates.js";
import * as setup from "../setup/setup.repo.js";

interface TicketRow {
  id: string;
  room_id: string | null;
  title: string;
  kind: "corrective" | "preventive";
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "resolved";
  ooo_from: string | null;
  ooo_to: string | null;
  out_of_service: boolean;
  due_date: string | null;
  note: string;
  created_by: string | null;
  resolved_by: string | null;
}

interface LostRow {
  id: string;
  room_id: string | null;
  item: string;
  found_on: string;
  photo_ref: string | null;
  guest_contacted: boolean;
  status: "held" | "returned" | "disposed";
}

const toTicket = (t: TicketRow): hotel.MaintenanceTicketOut => ({
  id: t.id,
  roomId: t.room_id,
  title: t.title,
  kind: t.kind,
  priority: t.priority,
  status: t.status,
  outOfOrderFrom: t.ooo_from,
  outOfOrderTo: t.ooo_to,
  dueDate: t.due_date,
  createdBy: t.created_by,
  resolvedBy: t.resolved_by,
  note: t.note,
});

const toLost = (l: LostRow): hotel.LostItemOut => ({
  id: l.id,
  roomId: l.room_id,
  item: l.item,
  foundOn: l.found_on,
  photoRef: l.photo_ref,
  guestContacted: l.guest_contacted,
  status: l.status,
});

export function roomsService(d: HotelDeps, folios: FoliosService) {
  const { core, adapters } = d;
  const { db } = core;

  const ready = (p: HotelScope["property"], r: setup.RoomRow) =>
    !r.occupied &&
    r.service_status === "in_service" &&
    (p.require_inspection ? r.hk_status === "inspected" : r.hk_status === "clean" || r.hk_status === "inspected");

  /** The in-house stay in a room, and the folio this department's charges go to (refused if blocked). */
  async function chargeTarget(t: Db, s: HotelScope, roomId: string, department: hotel.HotelDepartment) {
    const stay = await t.row<{ id: string }>(
      "SELECT id FROM hotel_stays WHERE property_id = $1 AND room_id = $2 AND status = 'in_house'",
      [s.property.id, roomId],
    );
    if (!stay) throw fail.conflict("No guest is in house in this room — take payment on the spot");
    const folioId = await folios.folioFor(t, stay.id, department);
    const f = await folioRepo.folioRow(t, s.property.id, folioId, true);
    if (f.blocked)
      throw fail.conflict(
        `This guest's folio is blocked (${f.blocked_reason ?? "no reason given"}) — take payment on the spot`,
      );
    return { stayId: stay.id, folioId };
  }

  async function lineOut(t: Db, folioId: string, lineId: string) {
    const l = (await folioRepo.lines(t, folioId)).find((x) => x.id === lineId) as folioRepo.LineRow;
    return { folioId, line: folioRepo.toLine(l) };
  }

  return {
    async board(s: HotelScope) {
      const bd = s.property.business_date;
      const types = new Map((await setup.roomTypes(db, s.property.id)).map((t) => [t.id, t.code]));
      const assigned = new Map(
        (
          await db.rows<{ room_id: string; attendant_user_id: string }>(
            "SELECT room_id, attendant_user_id FROM hotel_hk_assignments WHERE property_id = $1 AND date = $2",
            [s.property.id, bd],
          )
        ).map((a) => [a.room_id, a.attendant_user_id]),
      );
      const arrivals = new Set(
        (
          await db.rows<{ room_id: string }>(
            "SELECT room_id FROM hotel_stays WHERE property_id = $1 AND status = 'reserved' AND arrival = $2 AND room_id IS NOT NULL",
            [s.property.id, bd],
          )
        ).map((r) => r.room_id),
      );
      const departures = new Set(
        (
          await db.rows<{ room_id: string }>(
            "SELECT room_id FROM hotel_stays WHERE property_id = $1 AND status = 'in_house' AND departure <= $2",
            [s.property.id, bd],
          )
        ).map((r) => r.room_id),
      );
      const rooms = (await setup.rooms(db, s.property.id)).map((r) => ({
        ...setup.toRoom(r),
        roomTypeCode: types.get(r.room_type_id) ?? "",
        assignedTo: assigned.get(r.id) ?? null,
        arrivalToday: arrivals.has(r.id),
        departureToday: departures.has(r.id),
        ready: ready(s.property, r),
        startedAt: r.hk_started_at,
        finishedAt: r.hk_finished_at,
      }));
      const timed = rooms.filter((r) => r.startedAt && r.finishedAt && r.finishedAt > r.startedAt);
      const arrivalsToday = await db.row<{ n: number }>(
        "SELECT count(*)::int AS n FROM hotel_stays WHERE property_id = $1 AND status = 'reserved' AND arrival = $2",
        [s.property.id, bd],
      );
      return {
        businessDate: bd,
        rooms,
        figures: {
          toClean: rooms.filter((r) => r.service === "in_service" && ["dirty", "cleaning"].includes(r.housekeeping))
            .length,
          averageCleanMinutes: timed.length
            ? Math.round(
                timed.reduce(
                  (n, r) => n + (Date.parse(r.finishedAt as string) - Date.parse(r.startedAt as string)),
                  0,
                ) /
                  timed.length /
                  60_000,
              )
            : null,
          outOfOrder: rooms.filter((r) => r.service === "out_of_order").length,
          readyForArrivals: rooms.filter((r) => r.ready).length,
          arrivalsToday: arrivalsToday?.n ?? 0,
        },
      };
    },

    async setHousekeeping(s: HotelScope, roomId: string, status: hotel.RoomOut["housekeeping"]) {
      await db.tx(async (t) => {
        const r = await setup.room(t, s.property.id, roomId, true);
        if (status === "inspected") {
          if (!roleCan(s.role, "hotel.housekeeping.inspect"))
            throw fail.roleNotAllowed("Only a housekeeping supervisor can inspect a room");
          if (r.hk_status !== "clean") throw fail.conflict(`Room ${r.number} must be clean before inspection`);
        } else if (!roleCan(s.role, "hotel.housekeeping.inspect")) {
          // attendants work only on their own rooms for the day
          const mine = await t.row(
            "SELECT 1 FROM hotel_hk_assignments WHERE property_id = $1 AND room_id = $2 AND date = $3 AND attendant_user_id = $4",
            [s.property.id, roomId, s.property.business_date, s.userId],
          );
          if (!mine) throw fail.forbidden(`Room ${r.number} is not on your list today`);
        }
        // a clean that was started and is now finished counts for housekeeping productivity
        if (status === "clean" && r.hk_status === "cleaning" && r.hk_started_at)
          await t.run(
            `INSERT INTO hotel_hk_cleans (id, org_id, property_id, room_id, attendant, business_date, minutes)
             SELECT $1, $2, $3, id, $4, $5, GREATEST(0, round(extract(epoch FROM now() - hk_started_at) / 60))::int
             FROM hotel_rooms WHERE id = $6`,
            [newId("hkc"), s.orgId, s.property.id, s.userId, s.property.business_date, roomId],
          );
        await t.run(
          `UPDATE hotel_rooms SET hk_status = $2,
             hk_started_at = CASE WHEN $2 = 'cleaning' THEN now() ELSE hk_started_at END,
             hk_finished_at = CASE WHEN $2 = 'clean' THEN now() ELSE hk_finished_at END
           WHERE id = $1`,
          [roomId, status],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Room status changed",
          target: r.number,
          detail: `${r.hk_status} → ${status}`,
        });
      });
      return setup.toRoom(await setup.room(db, s.property.id, roomId));
    },

    async assign(s: HotelScope, attendantUserId: string, roomIds: string[]) {
      const m = await db.row<{ role: string }>(
        "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
        [s.orgId, attendantUserId],
      );
      if (!m || !["housekeeping_attendant", "housekeeping_supervisor"].includes(m.role))
        throw fail.invalid("Assign rooms to a housekeeping attendant or supervisor");
      const known = new Set((await setup.rooms(db, s.property.id)).map((r) => r.id));
      if (roomIds.some((id) => !known.has(id))) throw fail.invalid("Every room must belong to this hotel");
      const date = s.property.business_date;
      await db.tx(async (t) => {
        for (const id of roomIds)
          await t.run(
            `INSERT INTO hotel_hk_assignments (room_id, date, org_id, property_id, attendant_user_id) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (room_id, date) DO UPDATE SET attendant_user_id = EXCLUDED.attendant_user_id`,
            [id, date, s.orgId, s.property.id, attendantUserId],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Housekeeping rooms assigned",
          target: attendantUserId,
          detail: `${roomIds.length} room(s) on ${date}`,
        });
      });
      return { date, attendantUserId, roomIds };
    },

    async minibar(
      s: HotelScope,
      roomId: string,
      items: { description: string; quantity: number; unitMinor: number }[],
    ) {
      return db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const r = await setup.room(t, s.property.id, roomId);
        const { stayId, folioId } = await chargeTarget(t, s, roomId, "fnb");
        const net = items.reduce((n, i) => n + i.quantity * i.unitMinor, 0);
        const lineId = await folios.charge(t, s, folioId, {
          department: "fnb",
          description: `Minibar: ${items.map((i) => `${i.quantity} × ${i.description}`).join(", ")}`,
          net,
          stayId,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Minibar posted",
          target: r.number,
          detail: `${net}`,
        });
        return lineOut(t, folioId, lineId);
      });
    },

    async outletCharge(s: HotelScope, outletId: string, b: z.output<typeof hotel.outletCharge.body>) {
      return db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const o = await t.row<setup.OutletRow>("SELECT * FROM hotel_outlets WHERE property_id = $1 AND id = $2", [
          s.property.id,
          outletId,
        ]);
        if (!o) throw fail.notFound("Outlet not found");
        if (s.role === "outlet_staff" && !o.staff_user_ids.includes(s.userId))
          throw fail.forbidden(`You do not work at ${o.name}`);
        const r = await t.row<{ id: string }>("SELECT id FROM hotel_rooms WHERE property_id = $1 AND number = $2", [
          s.property.id,
          b.roomNumber,
        ]);
        if (!r) throw fail.notFound(`No room ${b.roomNumber}`);
        const { stayId, folioId } = await chargeTarget(t, s, r.id, o.department);
        const lineId = await folios.charge(t, s, folioId, {
          department: o.department,
          description: `${o.name}: ${b.description}`,
          net: b.amountMinor,
          outletId: o.id,
          stayId,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Outlet charge to room",
          target: b.roomNumber,
          detail: `${o.name} · ${b.description} · ${b.amountMinor}`,
        });
        return lineOut(t, folioId, lineId);
      });
    },

    // ---------------------------------------------------------------- maintenance
    async listTickets(s: HotelScope, status?: "open" | "resolved") {
      const rows = await db.rows<TicketRow>(
        "SELECT * FROM hotel_maintenance WHERE property_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at, id",
        [s.property.id, status ?? null],
      );
      return { tickets: rows.map(toTicket) };
    },

    async createTicket(s: HotelScope, b: z.output<typeof hotel.createMaintenance.body>) {
      const id = newId("hmt");
      await db.tx(async (t) => {
        const r = b.roomId ? await setup.room(t, s.property.id, b.roomId, true) : null;
        if (b.outOfOrder && r) {
          if (b.outOfOrder.to < s.property.business_date)
            throw fail.invalid("The out-of-order period has already passed");
          if (r.service_status === "out_of_order") throw fail.conflict(`Room ${r.number} is already out of order`);
          const starts = b.outOfOrder.from <= s.property.business_date;
          if (starts && r.occupied) throw fail.conflict(`Room ${r.number} is occupied — move the guest first`);
          const inv = {
            orgId: s.orgId,
            propertyId: s.property.id,
            roomTypeId: r.room_type_id,
            from: b.outOfOrder.from < s.property.business_date ? s.property.business_date : b.outOfOrder.from,
            to: addDays(b.outOfOrder.to, 1),
          };
          await moveInventory(t, inv, "ooo");
          await t.run("UPDATE hotel_rooms SET service_status = 'out_of_order' WHERE id = $1", [r.id]);
          await queueAri(t, adapters, await loadRateBook(t, s.property.id), inv);
        } else if (b.outOfService && r) {
          await t.run("UPDATE hotel_rooms SET service_status = 'out_of_service' WHERE id = $1", [r.id]);
        }
        await t.run(
          `INSERT INTO hotel_maintenance (id, org_id, property_id, room_id, title, kind, priority, ooo_from, ooo_to, out_of_service, due_date, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            s.orgId,
            s.property.id,
            b.roomId ?? null,
            b.title,
            b.kind,
            b.priority,
            b.outOfOrder?.from ?? null,
            b.outOfOrder?.to ?? null,
            !!b.outOfService && !b.outOfOrder,
            b.dueDate ?? null,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Maintenance ticket opened",
          target: id,
          detail: `${b.title}${r ? ` · room ${r.number}` : ""}${b.outOfOrder ? ` · out of order ${b.outOfOrder.from}–${b.outOfOrder.to}` : ""}`,
        });
      });
      return toTicket((await db.row<TicketRow>("SELECT * FROM hotel_maintenance WHERE id = $1", [id])) as TicketRow);
    },

    async resolveTicket(s: HotelScope, id: string, note: string) {
      await db.tx(async (t) => {
        const k = await t.row<TicketRow>(
          "SELECT * FROM hotel_maintenance WHERE property_id = $1 AND id = $2 FOR UPDATE",
          [s.property.id, id],
        );
        if (!k) throw fail.notFound("Ticket not found");
        if (k.status === "resolved") throw fail.conflict("Already resolved");
        if (k.room_id && (k.ooo_from || k.out_of_service)) {
          const r = await setup.room(t, s.property.id, k.room_id, true);
          if (k.ooo_from && k.ooo_to) {
            // nights still ahead go back into inventory
            const from = k.ooo_from > s.property.business_date ? k.ooo_from : s.property.business_date;
            const inv = {
              orgId: s.orgId,
              propertyId: s.property.id,
              roomTypeId: r.room_type_id,
              from,
              to: addDays(k.ooo_to, 1),
            };
            await moveInventory(t, inv, "unooo");
            await queueAri(t, adapters, await loadRateBook(t, s.property.id), inv);
          }
          await t.run("UPDATE hotel_rooms SET service_status = 'in_service', hk_status = 'dirty' WHERE id = $1", [
            r.id,
          ]);
        }
        await t.run(
          "UPDATE hotel_maintenance SET status = 'resolved', resolved_by = $2, resolved_at = now(), note = $3 WHERE id = $1",
          [id, s.userId, note],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Maintenance ticket resolved",
          target: id,
          detail: note,
        });
      });
      return toTicket((await db.row<TicketRow>("SELECT * FROM hotel_maintenance WHERE id = $1", [id])) as TicketRow);
    },

    // ---------------------------------------------------------------- lost and found
    async listLost(s: HotelScope) {
      return {
        items: (
          await db.rows<LostRow>("SELECT * FROM hotel_lost_found WHERE property_id = $1 ORDER BY found_on DESC, id", [
            s.property.id,
          ])
        ).map(toLost),
      };
    },

    async createLost(s: HotelScope, b: z.output<typeof hotel.createLostFound.body>) {
      if (b.roomId) await setup.room(db, s.property.id, b.roomId);
      const id = newId("hlf");
      await db.tx(async (t) => {
        await t.run(
          `INSERT INTO hotel_lost_found (id, org_id, property_id, room_id, item, found_on, photo_ref, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            s.orgId,
            s.property.id,
            b.roomId ?? null,
            b.item,
            s.property.business_date,
            b.photoRef ?? null,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Lost property recorded",
          target: id,
          detail: b.item,
        });
      });
      return toLost((await db.row<LostRow>("SELECT * FROM hotel_lost_found WHERE id = $1", [id])) as LostRow);
    },

    async updateLost(s: HotelScope, id: string, b: z.output<typeof hotel.updateLostFound.body>) {
      await db.tx(async (t) => {
        const l = await t.row<LostRow>("SELECT * FROM hotel_lost_found WHERE property_id = $1 AND id = $2 FOR UPDATE", [
          s.property.id,
          id,
        ]);
        if (!l) throw fail.notFound("Item not found");
        await t.run(
          "UPDATE hotel_lost_found SET guest_contacted = COALESCE($2, guest_contacted), status = COALESCE($3, status) WHERE id = $1",
          [id, b.guestContacted ?? null, b.status ?? null],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Lost property updated",
          target: id,
          before: toLost(l),
          after: b,
        });
      });
      return toLost((await db.row<LostRow>("SELECT * FROM hotel_lost_found WHERE id = $1", [id])) as LostRow);
    },
  };
}

export type RoomsService = ReturnType<typeof roomsService>;
