/*
 * THE availability record: one hotel_inventory row per room type and night. The front desk, the booking engine,
 * group blocks and every channel take rooms from it, and only here:
 *
 *   - rows are locked (SELECT … FOR UPDATE, in date order) before they change, so two bookings for the last room
 *     queue behind each other and the second one sees it gone;
 *   - the database refuses sold + held + out-of-order above the room count (constraint hotel_no_overbooking), even
 *     for code that skips this module.
 *
 * Every change queues an availability update for each connected channel (the channel-manager boundary).
 */
import { newId } from "../../../lib/ids.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import type { HotelAdapters } from "../integrations/adapters.js";
import { addDays } from "./dates.js";
import { priceFor, stopSold, type RateBook } from "./rates.js";

interface InventoryRow {
  date: string;
  total: number;
  sold: number;
  held: number;
  ooo: number;
}

export const freeOf = (r: InventoryRow) => Math.max(0, r.total - r.sold - r.held - r.ooo);

/** Make sure a row exists for each night in [from, to); the total is the room type's number of rooms. */
export async function ensureInventory(
  t: Db,
  orgId: string,
  propertyId: string,
  roomTypeId: string,
  from: string,
  to: string,
): Promise<void> {
  if (to <= from) return;
  await t.run(
    `INSERT INTO hotel_inventory (org_id, property_id, room_type_id, date, total)
     SELECT $1, $2, $3, d::date, (SELECT count(*)::int FROM hotel_rooms WHERE room_type_id = $3)
     FROM generate_series($4::date, $5::date - 1, interval '1 day') AS d
     ON CONFLICT (room_type_id, date) DO NOTHING`,
    [orgId, propertyId, roomTypeId, from, to],
  );
}

async function lockRows(t: Db, roomTypeId: string, from: string, to: string): Promise<InventoryRow[]> {
  return t.rows<InventoryRow>(
    `SELECT date, total, sold, held, ooo FROM hotel_inventory
     WHERE room_type_id = $1 AND date >= $2 AND date < $3 ORDER BY date FOR UPDATE`,
    [roomTypeId, from, to],
  );
}

export type InventoryMove =
  /** sell from general availability */
  | "sell"
  /** give back sold rooms (cancellation, no-show, early departure) */
  | "unsell"
  /** hold for a group block */
  | "hold"
  /** give back held rooms (cut-off release) */
  | "release"
  /** a held room picked up by a group booking (held → sold) */
  | "pickup"
  /** a picked-up group room given back to its block (sold → held) */
  | "unpick"
  /** a room out of order */
  | "ooo"
  /** a room back in order */
  | "unooo";

const TAKES_FREE: InventoryMove[] = ["sell", "hold", "ooo"];

/** Move `count` rooms of a type for each night in [from, to). Refused (409) when a night has no free room. */
export async function moveInventory(
  t: Db,
  o: { orgId: string; propertyId: string; roomTypeId: string; from: string; to: string; count?: number },
  move: InventoryMove,
): Promise<void> {
  const n = o.count ?? 1;
  if (o.to <= o.from || n <= 0) return;
  await ensureInventory(t, o.orgId, o.propertyId, o.roomTypeId, o.from, o.to);
  const rows = await lockRows(t, o.roomTypeId, o.from, o.to);
  if (TAKES_FREE.includes(move)) {
    const full = rows.filter((r) => freeOf(r) < n).map((r) => r.date);
    if (full.length) {
      throw fail.conflict(
        move === "ooo"
          ? `No free room of this type on ${full.join(", ")} — move the bookings before taking a room out of order`
          : `Sold out on ${full.join(", ")}`,
        { soldOut: full },
      );
    }
  }
  const set: Record<InventoryMove, string> = {
    sell: "sold = sold + $4",
    unsell: "sold = sold - $4",
    hold: "held = held + $4",
    release: "held = held - $4",
    pickup: "held = held - $4, sold = sold + $4",
    unpick: "held = held + $4, sold = sold - $4",
    ooo: "ooo = ooo + $4",
    unooo: "ooo = ooo - $4",
  };
  await t.run(`UPDATE hotel_inventory SET ${set[move]} WHERE room_type_id = $1 AND date >= $2 AND date < $3`, [
    o.roomTypeId,
    o.from,
    o.to,
    n,
  ]);
}

/** A room added to a type: every existing night gains one room. */
export async function refreshTotals(t: Db, roomTypeId: string): Promise<void> {
  await t.run(
    `UPDATE hotel_inventory SET total = (SELECT count(*)::int FROM hotel_rooms WHERE room_type_id = $1)
     WHERE room_type_id = $1`,
    [roomTypeId],
  );
}

export interface DayAvailability extends InventoryRow {
  available: number;
  closed: boolean;
}

/** Availability per night as one channel (null = direct / booking engine) sees it. */
export async function availabilityOf(
  t: Db,
  o: { orgId: string; propertyId: string; roomTypeId: string; from: string; to: string },
  book: RateBook,
  channelId: string | null,
): Promise<DayAvailability[]> {
  await ensureInventory(t, o.orgId, o.propertyId, o.roomTypeId, o.from, o.to);
  const rows = await t.rows<InventoryRow>(
    "SELECT date, total, sold, held, ooo FROM hotel_inventory WHERE room_type_id = $1 AND date >= $2 AND date < $3 ORDER BY date",
    [o.roomTypeId, o.from, o.to],
  );
  return rows.map((r) => {
    const closed = stopSold(book, o.roomTypeId, channelId, r.date);
    return { ...r, closed, available: closed ? 0 : freeOf(r) };
  });
}

/** Prices of every active plan for one room type and night (the rates a channel or the booking engine sells). */
export function sellableRates(book: RateBook, roomTypeId: string, date: string) {
  const out: { ratePlanId: string; code: string; amountMinor: number }[] = [];
  for (const p of book.plans.values()) {
    const amount = p.active ? priceFor(book, p.id, roomTypeId, date) : null;
    if (amount != null) out.push({ ratePlanId: p.id, code: p.code, amountMinor: amount });
  }
  return out;
}

/** Queue the new availability of [from, to) for every active channel of the hotel. */
export async function queueAri(
  t: Db,
  adapters: HotelAdapters,
  book: RateBook,
  o: { orgId: string; propertyId: string; roomTypeId: string; from: string; to: string },
): Promise<void> {
  const to = o.to > o.from ? o.to : addDays(o.from, 1);
  const channels = await t.rows<{ id: string }>(
    "SELECT id FROM hotel_channels WHERE property_id = $1 AND active ORDER BY code",
    [o.propertyId],
  );
  for (const c of channels) {
    const days = (await availabilityOf(t, { ...o, to }, book, c.id)).map((d) => ({
      date: d.date,
      available: d.available,
      closed: d.closed,
      rates: sellableRates(book, o.roomTypeId, d.date),
    }));
    const status = adapters.channels.push({ channelId: c.id, roomTypeId: o.roomTypeId, days });
    await t.run(
      `INSERT INTO hotel_ari_outbox (id, org_id, property_id, channel_id, room_type_id, date_from, date_to, payload, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [newId("ari"), o.orgId, o.propertyId, c.id, o.roomTypeId, o.from, addDays(to, -1), JSON.stringify(days), status],
    );
  }
}
