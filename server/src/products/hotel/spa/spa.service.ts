/*
 * Spa and activities: treatments (one guest) and activities (a group up to the activity's capacity) with their
 * therapist / guide, treatment room or studio and time. The database never lets a therapist or a room be booked
 * twice for overlapping times (exclusion constraints); guests of the same activity session share the guide.
 * A booking from the front desk, online or for an in-house guest is completed by charging the guest's room (in house,
 * folio not blocked) or by recording payment now, with the department's taxes.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps } from "../deps.js";
import { at } from "../outlets/outlets.service.js";
import type { HotelScope } from "../shared/access.js";
import { lockBusinessDate } from "../shared/posting.js";
import type { Settlement, Settler } from "../shared/settle.js";

interface ServiceRow {
  id: string;
  code: string;
  name: string;
  kind: "treatment" | "activity";
  department: "spa" | "other";
  duration_min: number;
  price_minor: number;
  capacity: number;
  active: boolean;
}

interface BookingRow {
  id: string;
  service_id: string;
  service_name: string;
  provider_id: string;
  resource_id: string | null;
  guest_name: string;
  stay_id: string | null;
  starts_at: string;
  ends_at: string;
  participants: number;
  source: hotel.ServiceBookingOut["source"];
  status: hotel.ServiceBookingOut["status"];
  price_minor: number;
  folio_id: string | null;
  room_number: string | null;
}

const toService = (r: ServiceRow): z.output<typeof hotel.SpaService> => ({
  id: r.id,
  code: r.code,
  name: r.name,
  kind: r.kind,
  department: r.department,
  durationMinutes: r.duration_min,
  priceMinor: r.price_minor,
  capacity: r.capacity,
  active: r.active,
});

/** "2026-10-12 16:00:00" or an ISO string → date and HH:MM. */
const split = (ts: string) => {
  const v = ts.replace("T", " ");
  return { date: v.slice(0, 10), time: v.slice(11, 16) };
};

const toBooking = (r: BookingRow): hotel.ServiceBookingOut => ({
  id: r.id,
  serviceId: r.service_id,
  serviceName: r.service_name,
  providerId: r.provider_id,
  resourceId: r.resource_id,
  guestName: r.guest_name,
  stayId: r.stay_id,
  date: split(r.starts_at).date,
  start: split(r.starts_at).time,
  end: split(r.ends_at).time,
  participants: r.participants,
  source: r.source,
  status: r.status,
  priceMinor: r.price_minor * r.participants,
  folioId: r.folio_id,
});

const BOOKING_SELECT = `SELECT b.id, b.service_id, sv.name AS service_name, b.provider_id, b.resource_id, b.guest_name,
  b.stay_id, to_char(b.starts_at, 'YYYY-MM-DD HH24:MI') AS starts_at, to_char(b.ends_at, 'YYYY-MM-DD HH24:MI') AS ends_at,
  b.participants, b.source, b.status, sv.price_minor, b.folio_id, rm.number AS room_number
  FROM hotel_service_bookings b JOIN hotel_services sv ON sv.id = b.service_id
  LEFT JOIN hotel_stays st ON st.id = b.stay_id LEFT JOIN hotel_rooms rm ON rm.id = st.room_id`;

/** The database's double-booking guards, as clear answers. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    if (err.code === "23P01")
      throw fail.conflict(
        err.constraint === "hotel_resource_not_double_booked"
          ? "That room is already booked at this time"
          : "That therapist / guide is already booked at this time",
      );
    throw e;
  }
}

export function spaService(d: HotelDeps, x: { settle: Settler }) {
  const { db } = d.core;
  const { settle } = x;

  async function bookingRow(t: Db, propertyId: string, id: string, lock = false): Promise<BookingRow> {
    if (lock)
      await t.run("SELECT 1 FROM hotel_service_bookings WHERE property_id = $1 AND id = $2 FOR UPDATE", [
        propertyId,
        id,
      ]);
    const r = await t.row<BookingRow>(`${BOOKING_SELECT} WHERE b.property_id = $1 AND b.id = $2`, [propertyId, id]);
    if (!r) throw fail.notFound("Booking not found");
    return r;
  }

  const one = async (sql: string, params: unknown[]) => {
    const r = await db.row<Record<string, unknown>>(sql, params);
    if (!r) throw fail.notFound("Not found");
    return r;
  };

  return {
    async setup(s: HotelScope) {
      const services = await db.rows<ServiceRow>("SELECT * FROM hotel_services WHERE property_id = $1 ORDER BY code", [
        s.property.id,
      ]);
      const providers = await db.rows<{
        id: string;
        name: string;
        kind: z.output<typeof hotel.SpaProvider>["kind"];
        user_id: string | null;
        active: boolean;
      }>("SELECT * FROM hotel_providers WHERE property_id = $1 ORDER BY name", [s.property.id]);
      const resources = await db.rows<{
        id: string;
        name: string;
        kind: z.output<typeof hotel.SpaResource>["kind"];
        active: boolean;
      }>("SELECT * FROM hotel_resources WHERE property_id = $1 ORDER BY name", [s.property.id]);
      return {
        services: services.map(toService),
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          userId: p.user_id,
          active: p.active,
        })),
        resources: resources.map((r) => ({ id: r.id, name: r.name, kind: r.kind, active: r.active })),
      };
    },

    async createService(s: HotelScope, b: z.output<typeof hotel.createSpaService.body>) {
      const id = newId("hsv");
      await db.tx(async (t) => {
        if (await t.row("SELECT 1 FROM hotel_services WHERE property_id = $1 AND code = $2", [s.property.id, b.code]))
          throw fail.conflict(`${b.code} already exists`);
        await t.run(
          `INSERT INTO hotel_services (id, org_id, property_id, code, name, kind, department, duration_min, price_minor, capacity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            s.orgId,
            s.property.id,
            b.code,
            b.name,
            b.kind,
            b.department,
            b.durationMinutes,
            b.priceMinor,
            b.capacity,
          ],
        );
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Spa / activity added", target: b.code });
      });
      return toService((await one("SELECT * FROM hotel_services WHERE id = $1", [id])) as unknown as ServiceRow);
    },

    async createProvider(s: HotelScope, b: z.output<typeof hotel.createSpaProvider.body>) {
      const id = newId("hpv");
      await db.tx(async (t) => {
        if (
          b.userId &&
          !(await t.row("SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2", [s.orgId, b.userId]))
        )
          throw fail.invalid("That person is not a member of this organisation");
        await t.run(
          "INSERT INTO hotel_providers (id, org_id, property_id, name, kind, user_id) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, s.orgId, s.property.id, b.name, b.kind, b.userId ?? null],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Therapist / guide added",
          target: id,
          detail: b.name,
        });
      });
      return { id, name: b.name, kind: b.kind, userId: b.userId ?? null, active: true };
    },

    async createResource(s: HotelScope, b: z.output<typeof hotel.createSpaResource.body>) {
      const id = newId("hrs");
      await db.tx(async (t) => {
        await t.run("INSERT INTO hotel_resources (id, org_id, property_id, name, kind) VALUES ($1,$2,$3,$4,$5)", [
          id,
          s.orgId,
          s.property.id,
          b.name,
          b.kind,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Spa room / resource added",
          target: id,
          detail: b.name,
        });
      });
      return { id, name: b.name, kind: b.kind, active: true };
    },

    async list(s: HotelScope, date?: string) {
      const rows = await db.rows<BookingRow>(
        `${BOOKING_SELECT} WHERE b.property_id = $1 AND ($2::date IS NULL OR b.starts_at::date = $2) ORDER BY b.starts_at, b.created_at, b.id`,
        [s.property.id, date ?? null],
      );
      return { bookings: rows.map(toBooking) };
    },

    async book(s: HotelScope, b: z.output<typeof hotel.bookService.body>) {
      const id = newId("hsk");
      await db.tx(async (t) => {
        const sv = await t.row<ServiceRow>(
          "SELECT * FROM hotel_services WHERE property_id = $1 AND id = $2 FOR UPDATE",
          [s.property.id, b.serviceId],
        );
        if (!sv?.active) throw fail.notFound("Treatment or activity not found");
        if (sv.kind === "treatment" && b.participants !== 1) throw fail.invalid("A treatment is for one guest");
        if (b.date < s.property.business_date) throw fail.invalid("That date has passed");
        const p = await t.row<{ active: boolean }>(
          "SELECT active FROM hotel_providers WHERE property_id = $1 AND id = $2",
          [s.property.id, b.providerId],
        );
        if (!p?.active) throw fail.notFound("Therapist / guide not found");
        if (
          b.resourceId &&
          !(await t.row("SELECT 1 FROM hotel_resources WHERE property_id = $1 AND id = $2 AND active", [
            s.property.id,
            b.resourceId,
          ]))
        )
          throw fail.notFound("Room / resource not found");
        let stayId: string | null = null;
        let guestName = b.guestName ?? "";
        if (b.roomNumber) {
          const st = await t.row<{ id: string; name: string }>(
            `SELECT st.id, g.name FROM hotel_stays st JOIN hotel_rooms r ON r.id = st.room_id
             JOIN hotel_reservations res ON res.id = st.reservation_id JOIN hotel_guests g ON g.id = res.guest_id
             WHERE st.property_id = $1 AND r.number = $2 AND st.status = 'in_house'`,
            [s.property.id, b.roomNumber],
          );
          if (!st) throw fail.conflict(`No guest is in house in room ${b.roomNumber}`);
          stayId = st.id;
          guestName ||= st.name;
        }
        const from = at(b.date, b.start);
        const to = at(b.date, b.start, sv.duration_min);
        // an activity session (same activity, same start) holds up to its capacity and shares its guide and room
        const sessionKey = sv.kind === "activity" ? `${sv.id}@${from}` : id;
        if (sv.kind === "activity") {
          const booked = await t.row<{ n: number; other: number }>(
            `SELECT COALESCE(sum(participants), 0)::int AS n,
               count(*) FILTER (WHERE provider_id <> $3 OR resource_id IS DISTINCT FROM $4)::int AS other
             FROM hotel_service_bookings WHERE session_key = $1 AND property_id = $2 AND status IN ('booked', 'completed')`,
            [sessionKey, s.property.id, b.providerId, b.resourceId ?? null],
          );
          if (booked?.other) throw fail.conflict("This session already has its guide and room — book the same ones");
          if ((booked?.n ?? 0) + b.participants > sv.capacity)
            throw fail.conflict(
              `${sv.name} at ${b.start} has ${Math.max(0, sv.capacity - (booked?.n ?? 0))} place(s) left`,
            );
        }
        await guarded(() =>
          t.run(
            `INSERT INTO hotel_service_bookings (id, org_id, property_id, service_id, provider_id, resource_id, guest_name, stay_id,
               starts_at, ends_at, participants, session_key, source, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              id,
              s.orgId,
              s.property.id,
              sv.id,
              b.providerId,
              b.resourceId ?? null,
              guestName,
              stayId,
              from,
              to,
              b.participants,
              sessionKey,
              b.roomNumber ? "in_house" : b.source,
              s.userId,
            ],
          ),
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Spa / activity booked",
          target: sv.code,
          detail: `${guestName} · ${b.date} ${b.start} · ${b.participants}`,
        });
      });
      return toBooking(await bookingRow(db, s.property.id, id));
    },

    async complete(s: HotelScope, bookingId: string, b: Settlement) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const r = await bookingRow(t, s.property.id, bookingId, true);
        if (r.status !== "booked") throw fail.conflict(`This booking is ${r.status}`);
        const sv = (await t.row<ServiceRow>("SELECT * FROM hotel_services WHERE id = $1", [
          r.service_id,
        ])) as ServiceRow;
        const sale = await settle.settle(t, s, {
          name: `${sv.name} — ${r.guest_name}`,
          lines: [
            {
              department: sv.department,
              description: `${sv.name}${r.participants > 1 ? ` × ${r.participants}` : ""} — ${r.guest_name}`,
              net: sv.price_minor * r.participants,
            },
          ],
          settlement: b,
          ...(r.stay_id && b.roomNumber ? { stayId: r.stay_id } : {}),
        });
        await t.run("UPDATE hotel_service_bookings SET status = 'completed', folio_id = $2 WHERE id = $1", [
          r.id,
          sale.folioId,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: sale.mode === "room" ? "Treatment charged to room" : "Treatment paid",
          target: r.id,
          detail: sv.name,
        });
      });
      return toBooking(await bookingRow(db, s.property.id, bookingId));
    },

    async cancel(s: HotelScope, bookingId: string, b: { reason: string; noShow: boolean }) {
      await db.tx(async (t) => {
        const r = await bookingRow(t, s.property.id, bookingId, true);
        if (r.status !== "booked") throw fail.conflict(`This booking is ${r.status}`);
        await t.run("UPDATE hotel_service_bookings SET status = $2, cancel_reason = $3 WHERE id = $1", [
          r.id,
          b.noShow ? "no_show" : "cancelled",
          b.reason,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: b.noShow ? "Spa / activity no-show" : "Spa / activity cancelled",
          target: r.id,
          detail: b.reason,
        });
      });
      return toBooking(await bookingRow(db, s.property.id, bookingId));
    },
  };
}

export type SpaService = ReturnType<typeof spaService>;
