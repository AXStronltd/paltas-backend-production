/*
 * Hotel figures read from the SAME ledger postings Finance sees: posted journals linked to the hotel and its
 * business dates. Room nights sold come from the night audit's room charges; rooms available from the one
 * inventory record (rooms out of order excluded).
 */
import type { hotel } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { REVENUE_ACCOUNT } from "../accounts.js";

export type DeptAmounts = { rooms: number; fnb: number; spa: number; other: number; noshow: number; total: number };

export interface LedgerTotals {
  /** debit − credit per account code */
  net(code: string): number;
  /** credit − debit (income, liabilities) */
  credit(code: string): number;
}

export async function ledgerTotals(
  db: Db,
  propertyId: string,
  from: string,
  to: string,
  kinds?: string[],
): Promise<LedgerTotals> {
  const rows = await db.rows<{ code: string; dr: number; cr: number }>(
    `SELECT l.account_code AS code, sum(l.debit_minor)::bigint AS dr, sum(l.credit_minor)::bigint AS cr
     FROM hotel_ledger_links k
     JOIN journal_entries e ON e.id = k.journal_id AND e.status = 'posted'
     JOIN journal_lines l ON l.entry_id = e.id
     WHERE k.property_id = $1 AND k.business_date BETWEEN $2 AND $3 AND ($4::text[] IS NULL OR k.kind = ANY($4::text[]))
     GROUP BY l.account_code`,
    [propertyId, from, to, kinds ?? null],
  );
  const m = new Map(rows.map((r) => [r.code, r.dr - r.cr]));
  return { net: (c) => m.get(c) ?? 0, credit: (c) => -(m.get(c) ?? 0) };
}

export function revenueOf(t: LedgerTotals): DeptAmounts {
  const r = {
    rooms: t.credit(REVENUE_ACCOUNT.rooms),
    fnb: t.credit(REVENUE_ACCOUNT.fnb),
    spa: t.credit(REVENUE_ACCOUNT.spa),
    other: t.credit(REVENUE_ACCOUNT.other),
    noshow: t.credit(REVENUE_ACCOUNT.noshow),
  };
  return { ...r, total: r.rooms + r.fnb + r.spa + r.other + r.noshow };
}

/** Net revenue by department summed from the folio lines (charges less voids) — must equal the ledger. */
export async function folioRevenue(db: Db, propertyId: string, from: string, to: string): Promise<DeptAmounts> {
  const rows = await db.rows<{ department: hotel.HotelDepartment; n: number }>(
    `SELECT department, sum(net_minor)::bigint AS n FROM hotel_folio_lines
     WHERE property_id = $1 AND business_date BETWEEN $2 AND $3 AND kind IN ('charge', 'void') GROUP BY department`,
    [propertyId, from, to],
  );
  const get = (d: hotel.HotelDepartment) => rows.find((r) => r.department === d)?.n ?? 0;
  const r = { rooms: get("rooms"), fnb: get("fnb"), spa: get("spa"), other: get("other"), noshow: get("noshow") };
  return { ...r, total: r.rooms + r.fnb + r.spa + r.other + r.noshow };
}

/** Room nights charged by the night audit (not voided) in the period. */
export async function roomsSold(db: Db, propertyId: string, from: string, to: string): Promise<number> {
  const r = await db.row<{ n: number }>(
    `SELECT count(*)::int AS n FROM hotel_folio_lines l
     WHERE l.property_id = $1 AND l.kind = 'charge' AND l.night_date BETWEEN $2 AND $3
       AND NOT EXISTS (SELECT 1 FROM hotel_folio_lines v WHERE v.voids_line_id = l.id)`,
    [propertyId, from, to],
  );
  return r?.n ?? 0;
}

/** Room nights available in the period: every room of every type, less rooms out of order. */
export async function roomsAvailable(db: Db, propertyId: string, from: string, to: string): Promise<number> {
  const r = await db.row<{ n: number }>(
    `SELECT COALESCE(sum(COALESCE(i.total, t.n) - COALESCE(i.ooo, 0)), 0)::int AS n
     FROM generate_series($2::date, $3::date, interval '1 day') AS d
     CROSS JOIN (SELECT rt.id, (SELECT count(*)::int FROM hotel_rooms r WHERE r.room_type_id = rt.id) AS n
                 FROM hotel_room_types rt WHERE rt.property_id = $1) AS t
     LEFT JOIN hotel_inventory i ON i.room_type_id = t.id AND i.date = d::date`,
    [propertyId, from, to],
  );
  return r?.n ?? 0;
}

export async function outOfOrder(db: Db, propertyId: string, from: string, to: string): Promise<number> {
  const r = await db.row<{ n: number }>(
    "SELECT COALESCE(sum(ooo), 0)::int AS n FROM hotel_inventory WHERE property_id = $1 AND date BETWEEN $2 AND $3",
    [propertyId, from, to],
  );
  return r?.n ?? 0;
}

export async function paymentsByMethod(db: Db, propertyId: string, from: string, to: string) {
  const rows = await db.rows<{ method: hotel.PaymentMethod; n: number }>(
    `SELECT method, -sum(total_minor)::bigint AS n FROM hotel_folio_lines
     WHERE property_id = $1 AND kind = 'payment' AND business_date BETWEEN $2 AND $3 GROUP BY method`,
    [propertyId, from, to],
  );
  const get = (m: hotel.PaymentMethod) => rows.find((r) => r.method === m)?.n ?? 0;
  const p = {
    cash: get("cash"),
    card: get("card"),
    mobile_money: get("mobile_money"),
    bank_transfer: get("bank_transfer"),
  };
  return { ...p, total: p.cash + p.card + p.mobile_money + p.bank_transfer };
}

export async function depositsReceived(db: Db, propertyId: string, from: string, to: string): Promise<number> {
  const r = await db.row<{ n: number }>(
    "SELECT COALESCE(sum(amount_minor), 0)::bigint AS n FROM hotel_deposits WHERE property_id = $1 AND received_date BETWEEN $2 AND $3",
    [propertyId, from, to],
  );
  return r?.n ?? 0;
}

/** Ratios rounded to whole minor units; occupancy to two decimals. */
export function ratios(o: { roomRevenue: number; totalRevenue: number; sold: number; available: number }) {
  const div = (a: number, b: number) => (b > 0 ? Math.round(a / b) : 0);
  return {
    occupancyPct: o.available > 0 ? Math.round((o.sold / o.available) * 10_000) / 100 : 0,
    adrMinor: div(o.roomRevenue, o.sold),
    revparMinor: div(o.roomRevenue, o.available),
    trevparMinor: div(o.totalRevenue, o.available),
  };
}
