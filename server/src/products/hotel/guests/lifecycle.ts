/*
 * What happens to a guest automatically along the stay, inside the transaction of the step that triggers it:
 *   booked       booking confirmation recorded (outbox, once per reservation)
 *   checked in   extras booked with the reservation charged to the folio (once), pending loyalty redemptions
 *                credited, and a "prepare the room" task with the guest's preferences
 *   checked out  loyalty points earned (last room of the reservation) and the post-stay survey recorded
 *   cancelled    extras not yet charged are dropped and pending redeemed points go back to the member
 */
import type { Db } from "../../../db/database.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { FoliosService } from "../folios/folios.service.js";
import { messageGuest } from "../shared/outbox.js";
import type { SaleDepartment } from "../shared/settle.js";
import type { Loyalty } from "./loyalty.js";

export function lifecycle(d: HotelDeps, x: { folios: FoliosService; loyalty: Loyalty }) {
  const { folios, loyalty } = x;

  return {
    async booked(t: Db, op: HotelOp, reservationId: string) {
      await messageGuest(t, d, op, "confirmation", reservationId);
    },

    async checkedIn(t: Db, op: HotelOp, s: { stayId: string; reservationId: string; folioId: string; room: string }) {
      const extras = await t.rows<{
        id: string;
        description: string;
        department: SaleDepartment;
        amount_minor: number;
      }>(
        "SELECT * FROM hotel_reservation_upsells WHERE reservation_id = $1 AND status = 'pending' ORDER BY department, description, id FOR UPDATE",
        [s.reservationId],
      );
      for (const u of extras) {
        const folioId = await folios.folioFor(t, s.stayId, u.department);
        const lineId = await folios.charge(t, op, folioId, {
          department: u.department,
          description: u.description,
          net: u.amount_minor,
          stayId: s.stayId,
        });
        await t.run("UPDATE hotel_reservation_upsells SET status = 'posted', line_id = $2 WHERE id = $1", [
          u.id,
          lineId,
        ]);
      }
      await loyalty.applyPending(t, op, s.reservationId, s.folioId);
      const g = await t.row<{ name: string; preferences: Record<string, string>; vip: boolean }>(
        "SELECT g.name, g.preferences, g.vip FROM hotel_reservations r JOIN hotel_guests g ON g.id = r.guest_id WHERE r.id = $1",
        [s.reservationId],
      );
      const prefs = Object.entries(g?.preferences ?? {}).map(([k, v]) => `${k}: ${v}`);
      if (g && (prefs.length || g.vip))
        await t.run(
          `INSERT INTO hotel_requests (id, org_id, property_id, stay_id, reservation_id, kind, text, source, created_by)
           VALUES ($1,$2,$3,$4,$5,'housekeeping',$6,'staff',$7)`,
          [
            newId("hrq"),
            op.orgId,
            op.property.id,
            s.stayId,
            s.reservationId,
            `Prepare room ${s.room} for ${g.name}${g.vip ? " (VIP)" : ""}${prefs.length ? ": " + prefs.join(", ") : ""}`,
            op.userId,
          ],
        );
    },

    async checkedOut(t: Db, op: HotelOp, reservationId: string) {
      await loyalty.earn(t, op, reservationId);
      const open = await t.row<{ n: number }>(
        "SELECT count(*)::int AS n FROM hotel_stays WHERE reservation_id = $1 AND status IN ('reserved', 'in_house')",
        [reservationId],
      );
      if (!open?.n) await messageGuest(t, d, op, "post_stay_survey", reservationId);
    },

    async closed(t: Db, op: HotelOp, reservationId: string) {
      await t.run(
        "UPDATE hotel_reservation_upsells SET status = 'cancelled' WHERE reservation_id = $1 AND status = 'pending'",
        [reservationId],
      );
      await loyalty.reversePending(t, op, reservationId);
    },
  };
}

export type Lifecycle = ReturnType<typeof lifecycle>;
