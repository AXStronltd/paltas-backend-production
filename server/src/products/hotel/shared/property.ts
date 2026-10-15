/*
 * A hotel property as stored, and as the API shows it. Percentages are stored as basis points (1 % = 100) so the
 * tax engine works in integers only.
 */
import type { hotel } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";

export interface PropertyRow {
  id: string;
  org_id: string;
  name: string;
  country: string;
  city: string;
  timezone: string;
  check_in_time: string;
  check_out_time: string;
  business_date: string;
  vat_bp: number;
  service_charge_bp: number;
  service_charge_departments: hotel.HotelDepartment[];
  vat_on_service_charge: boolean;
  levy_kind: "none" | "per_night" | "percent_of_room";
  levy_name: string;
  levy_amount_minor: number;
  levy_bp: number;
  require_inspection: boolean;
  welcome_temp_c: number;
  eco_temp_c: number;
  faq: hotel.Property["faq"];
  usali: hotel.UsaliMapping;
  currency: string;
  room_count: number;
}

const SELECT = `SELECT p.*, o.currency,
  (SELECT count(*)::int FROM hotel_rooms r WHERE r.property_id = p.id) AS room_count
  FROM hotel_properties p JOIN organisations o ON o.id = p.org_id`;

export const toBp = (pct: number): number => Math.round(pct * 100);
export const fromBp = (bp: number): number => bp / 100;

export async function findProperty(db: Db, orgId: string, propertyId: string, lock = false): Promise<PropertyRow> {
  const p = await db.row<PropertyRow>(`${SELECT} WHERE p.org_id = $1 AND p.id = $2${lock ? " FOR UPDATE OF p" : ""}`, [
    orgId,
    propertyId,
  ]);
  if (!p) throw fail.notFound("Hotel not found");
  return p;
}

export async function listPropertyRows(db: Db, orgId: string): Promise<PropertyRow[]> {
  return db.rows<PropertyRow>(`${SELECT} WHERE p.org_id = $1 ORDER BY p.name`, [orgId]);
}

export function toProperty(p: PropertyRow): hotel.Property {
  return {
    id: p.id,
    name: p.name,
    country: p.country,
    city: p.city,
    currency: p.currency,
    timezone: p.timezone,
    checkInTime: p.check_in_time,
    checkOutTime: p.check_out_time,
    businessDate: p.business_date,
    tax: {
      vatPct: fromBp(p.vat_bp),
      serviceChargePct: fromBp(p.service_charge_bp),
      serviceChargeDepartments: p.service_charge_departments,
      vatOnServiceCharge: p.vat_on_service_charge,
      levy: {
        kind: p.levy_kind,
        name: p.levy_name,
        amountMinor: p.levy_amount_minor,
        pct: fromBp(p.levy_bp),
      },
    },
    requireInspection: p.require_inspection,
    welcomeTemperatureC: p.welcome_temp_c,
    ecoTemperatureC: p.eco_temp_c,
    faq: p.faq,
    usali: p.usali,
    roomCount: p.room_count,
  };
}
