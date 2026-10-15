// SQL for reservations and stays, and their API shape.
import type { hotel } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { GUEST_SELECT, toGuest, type GuestRow } from "../setup/setup.repo.js";

export interface ReservationRow {
  id: string;
  org_id: string;
  property_id: string;
  number: string;
  guest_id: string;
  arrival: string;
  departure: string;
  source: hotel.Reservation["source"];
  channel_id: string | null;
  external_ref: string | null;
  corporate_account_id: string | null;
  group_block_id: string | null;
  special_requests: string;
  cancelled_reason: string | null;
  id_captured: boolean;
  id_document_ref: string | null;
  nationality: string | null;
  signature_ref: string | null;
  arrival_time: string | null;
  precheckin_at: string | null;
}

export interface StayRow {
  id: string;
  org_id: string;
  property_id: string;
  reservation_id: string;
  room_type_id: string;
  rate_plan_id: string;
  room_id: string | null;
  room_number: string | null;
  adults: number;
  children: number;
  arrival: string;
  departure: string;
  status: hotel.Stay["status"];
  from_block: boolean;
}

export async function reservationRow(db: Db, propertyId: string, id: string, lock = false): Promise<ReservationRow> {
  const r = await db.row<ReservationRow>(
    `SELECT * FROM hotel_reservations WHERE property_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [propertyId, id],
  );
  if (!r) throw fail.notFound("Reservation not found");
  return r;
}

const STAY_SELECT = `SELECT s.*, r.number AS room_number FROM hotel_stays s LEFT JOIN hotel_rooms r ON r.id = s.room_id`;

export async function stayRow(db: Db, propertyId: string, id: string, lock = false): Promise<StayRow> {
  if (lock) await db.run("SELECT 1 FROM hotel_stays WHERE id = $1 AND property_id = $2 FOR UPDATE", [id, propertyId]);
  const s = await db.row<StayRow>(`${STAY_SELECT} WHERE s.property_id = $1 AND s.id = $2`, [propertyId, id]);
  if (!s) throw fail.notFound("Stay not found");
  return s;
}

export async function staysOf(db: Db, reservationId: string): Promise<StayRow[]> {
  return db.rows<StayRow>(`${STAY_SELECT} WHERE s.reservation_id = $1 ORDER BY s.id`, [reservationId]);
}

export async function toStay(db: Db, s: StayRow): Promise<hotel.Stay> {
  const nights = await db.rows<{ date: string; rate_minor: number; plan_rate_minor: number; posted: boolean }>(
    `SELECT n.date, n.rate_minor, n.plan_rate_minor,
       EXISTS (SELECT 1 FROM hotel_folio_lines l WHERE l.stay_id = n.stay_id AND l.night_date = n.date AND l.kind = 'charge') AS posted
     FROM hotel_stay_nights n WHERE n.stay_id = $1 ORDER BY n.date`,
    [s.id],
  );
  const folios = await db.rows<{ id: string }>("SELECT id FROM hotel_folios WHERE stay_id = $1 ORDER BY number", [
    s.id,
  ]);
  return {
    id: s.id,
    reservationId: s.reservation_id,
    roomTypeId: s.room_type_id,
    ratePlanId: s.rate_plan_id,
    roomId: s.room_id,
    roomNumber: s.room_number,
    adults: s.adults,
    children: s.children,
    arrival: s.arrival,
    departure: s.departure,
    status: s.status,
    folioIds: folios.map((f) => f.id),
    nights: nights.map((n) => ({
      date: n.date,
      rateMinor: n.rate_minor,
      planRateMinor: n.plan_rate_minor,
      posted: n.posted,
    })),
  };
}

function overallStatus(stays: hotel.Stay[]): hotel.Reservation["status"] {
  const st = stays.map((s) => s.status);
  if (st.includes("in_house")) return "in_house";
  if (st.includes("waitlisted")) return "waitlisted";
  if (st.includes("reserved")) return "confirmed";
  if (st.every((x) => x === "cancelled")) return "cancelled";
  if (st.every((x) => x === "no_show" || x === "cancelled")) return "no_show";
  return "checked_out";
}

export async function toReservation(db: Db, r: ReservationRow): Promise<hotel.Reservation> {
  const g = (await db.row<GuestRow>(`${GUEST_SELECT} WHERE g.id = $1`, [r.guest_id])) as GuestRow;
  const stays: hotel.Stay[] = [];
  for (const s of await staysOf(db, r.id)) stays.push(await toStay(db, s));
  const earlier = await db.row<{ n: number }>(
    `SELECT count(*)::int AS n FROM hotel_reservations x WHERE x.guest_id = $1 AND x.id <> $2 AND x.created_at <=
       (SELECT created_at FROM hotel_reservations WHERE id = $2)`,
    [r.guest_id, r.id],
  );
  const deposits = await db.rows<{
    id: string;
    amount_minor: number;
    method: hotel.PaymentMethod;
    reference: string;
    received_date: string;
    applied_folio_id: string | null;
  }>("SELECT * FROM hotel_deposits WHERE reservation_id = $1 ORDER BY received_date, id", [r.id]);
  return {
    id: r.id,
    number: r.number,
    propertyId: r.property_id,
    status: overallStatus(stays),
    guest: { ...toGuest(g), returning: (earlier?.n ?? 0) > 0 },
    arrival: r.arrival,
    departure: r.departure,
    nights: Math.max(0, ...stays.map((s) => s.nights.length)),
    source: r.source,
    channelId: r.channel_id,
    externalRef: r.external_ref,
    corporateAccountId: r.corporate_account_id,
    groupBlockId: r.group_block_id,
    specialRequests: r.special_requests,
    roomTotalMinor: stays.reduce((n, s) => n + s.nights.reduce((m, x) => m + x.rateMinor, 0), 0),
    preCheckIn: r.precheckin_at
      ? {
          idCaptured: r.id_captured,
          idDocumentRef: r.id_document_ref ?? "",
          nationality: r.nationality,
          signatureRef: r.signature_ref ?? "",
          arrivalTime: r.arrival_time,
          at: r.precheckin_at,
        }
      : null,
    deposits: deposits.map((x) => ({
      id: x.id,
      amountMinor: x.amount_minor,
      method: x.method,
      reference: x.reference,
      receivedOn: x.received_date,
      appliedToFolioId: x.applied_folio_id,
    })),
    cancelledReason: r.cancelled_reason,
    stays,
  };
}
