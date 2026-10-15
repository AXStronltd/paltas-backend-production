// SQL for hotel set-up records (room types, rooms, channels, outlets, company accounts, guests) and their API shape.
import type { hotel } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import type { IntegrationState } from "../integrations/adapters.js";
import { fromBp } from "../shared/property.js";

export interface RoomTypeRow {
  id: string;
  property_id: string;
  code: string;
  name: string;
  capacity_adults: number;
  capacity_children: number;
  beds: string;
  size_sqm: number | null;
  amenities: string[];
  room_count: number;
}

export interface RoomRow {
  id: string;
  property_id: string;
  room_type_id: string;
  number: string;
  floor: string;
  attributes: string[];
  hk_status: hotel.RoomOut["housekeeping"];
  service_status: hotel.RoomOut["service"];
  eco_mode: boolean;
  hk_started_at: string | null;
  hk_finished_at: string | null;
  occupied: boolean;
}

export async function roomTypes(db: Db, propertyId: string): Promise<RoomTypeRow[]> {
  return db.rows<RoomTypeRow>(
    `SELECT t.*, (SELECT count(*)::int FROM hotel_rooms r WHERE r.room_type_id = t.id) AS room_count
     FROM hotel_room_types t WHERE t.property_id = $1 ORDER BY t.code`,
    [propertyId],
  );
}

export async function roomType(db: Db, propertyId: string, id: string): Promise<RoomTypeRow> {
  const t = (await roomTypes(db, propertyId)).find((r) => r.id === id);
  if (!t) throw fail.invalid("Unknown room type for this hotel");
  return t;
}

const ROOM_SELECT = `SELECT r.*, EXISTS (SELECT 1 FROM hotel_stays s WHERE s.room_id = r.id AND s.status = 'in_house') AS occupied
  FROM hotel_rooms r`;

export async function rooms(db: Db, propertyId: string): Promise<RoomRow[]> {
  return db.rows<RoomRow>(`${ROOM_SELECT} WHERE r.property_id = $1 ORDER BY r.number`, [propertyId]);
}

export async function room(db: Db, propertyId: string, id: string, lock = false): Promise<RoomRow> {
  if (lock) await db.run("SELECT 1 FROM hotel_rooms WHERE id = $1 AND property_id = $2 FOR UPDATE", [id, propertyId]);
  const r = await db.row<RoomRow>(`${ROOM_SELECT} WHERE r.property_id = $1 AND r.id = $2`, [propertyId, id]);
  if (!r) throw fail.notFound("Room not found");
  return r;
}

export const toRoomType = (t: RoomTypeRow): hotel.RoomTypeOut => ({
  id: t.id,
  code: t.code,
  name: t.name,
  capacityAdults: t.capacity_adults,
  capacityChildren: t.capacity_children,
  beds: t.beds,
  sizeSqm: t.size_sqm,
  amenities: t.amenities,
  roomCount: t.room_count,
});

export const toRoom = (r: RoomRow): hotel.RoomOut => ({
  id: r.id,
  number: r.number,
  roomTypeId: r.room_type_id,
  floor: r.floor,
  attributes: r.attributes,
  housekeeping: r.hk_status,
  service: r.service_status,
  occupancy: r.occupied ? "occupied" : "vacant",
  ecoMode: r.eco_mode,
});

export interface ChannelRow {
  id: string;
  property_id: string;
  code: string;
  name: string;
  provider: string;
  commission_bp: number;
  active: boolean;
}

export const toChannel = (c: ChannelRow, integration: IntegrationState): hotel.ChannelOut => ({
  id: c.id,
  code: c.code,
  name: c.name,
  provider: c.provider,
  commissionPct: fromBp(c.commission_bp),
  active: c.active,
  integration,
});

export interface OutletRow {
  id: string;
  property_id: string;
  code: string;
  name: string;
  department: "rooms" | "fnb" | "spa" | "other";
  staff_user_ids: string[];
}

export const toOutlet = (o: OutletRow): hotel.OutletOut => ({
  id: o.id,
  code: o.code,
  name: o.name,
  department: o.department,
  staffUserIds: o.staff_user_ids,
});

export interface GuestRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  id_number: string | null;
  nationality: string | null;
  vip: boolean;
  preferences: Record<string, string>;
  allergies: string | null;
  marketing_consent: boolean;
  notes: string;
  stay_count: number;
}

export const GUEST_SELECT = `SELECT g.*, (SELECT count(*)::int FROM hotel_reservations r WHERE r.guest_id = g.id
    AND EXISTS (SELECT 1 FROM hotel_stays s WHERE s.reservation_id = r.id AND s.status IN ('in_house', 'checked_out'))) AS stay_count
  FROM hotel_guests g`;

export const toGuest = (g: GuestRow): hotel.GuestOut => ({
  id: g.id,
  name: g.name,
  email: g.email,
  phone: g.phone,
  nationality: g.nationality,
  vip: g.vip,
  preferences: g.preferences,
  allergies: g.allergies,
  marketingConsent: g.marketing_consent,
  notes: g.notes,
  stayCount: g.stay_count,
});
