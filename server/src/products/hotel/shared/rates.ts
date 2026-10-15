/*
 * Rate plans, prices and restrictions of one hotel, loaded once per request.
 * Price of a night = the season / day-of-week price covering it (the shortest season wins, so a one-night price set
 * by revenue management overrides a longer season), else the plan's base rate; a derived plan takes its parent's
 * price and applies its percentage (e.g. BAR − 10 %).
 */
import type { hotel } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { fromBp } from "./property.js";
import { nightsOf, weekdayIndex } from "./dates.js";

export interface RatePlanRow {
  id: string;
  property_id: string;
  code: string;
  name: string;
  kind: hotel.RatePlan["kind"];
  parent_id: string | null;
  derived_bp: number | null;
  breakfast_included: boolean;
  refundable: boolean;
  free_cancel_days: number;
  cancel_fee_nights: number;
  no_show_fee_nights: number;
  corporate_account_id: string | null;
  active: boolean;
}

interface SeasonRow {
  id: string;
  rate_plan_id: string;
  room_type_id: string;
  name: string;
  date_from: string;
  date_to: string;
  amount_minor: number;
  weekday_minor: (number | null)[] | null;
}

export interface RestrictionRow {
  id: string;
  room_type_id: string | null;
  rate_plan_id: string | null;
  channel_id: string | null;
  date_from: string;
  date_to: string;
  min_stay: number | null;
  max_stay: number | null;
  cta: boolean;
  ctd: boolean;
  stop_sell: boolean;
}

export interface RateBook {
  plans: Map<string, RatePlanRow>;
  base: Map<string, number>;
  seasons: SeasonRow[];
  restrictions: RestrictionRow[];
}

export async function loadRateBook(db: Db, propertyId: string): Promise<RateBook> {
  const plans = await db.rows<RatePlanRow>("SELECT * FROM hotel_rate_plans WHERE property_id = $1 ORDER BY code", [
    propertyId,
  ]);
  const base = await db.rows<{ rate_plan_id: string; room_type_id: string; amount_minor: number }>(
    `SELECT pr.* FROM hotel_rate_prices pr JOIN hotel_rate_plans p ON p.id = pr.rate_plan_id WHERE p.property_id = $1`,
    [propertyId],
  );
  const seasons = await db.rows<SeasonRow>(
    `SELECT s.* FROM hotel_rate_seasons s JOIN hotel_rate_plans p ON p.id = s.rate_plan_id
     WHERE p.property_id = $1 ORDER BY s.date_from, s.id`,
    [propertyId],
  );
  const restrictions = await db.rows<RestrictionRow>(
    "SELECT * FROM hotel_restrictions WHERE property_id = $1 ORDER BY date_from, id",
    [propertyId],
  );
  return {
    plans: new Map(plans.map((p) => [p.id, p])),
    base: new Map(base.map((b) => [`${b.rate_plan_id}|${b.room_type_id}`, b.amount_minor])),
    // bigint[] arrives as strings
    seasons: seasons.map((s) => ({
      ...s,
      weekday_minor: s.weekday_minor?.map((v) => (v == null ? null : Number(v))) ?? null,
    })),
    restrictions,
  };
}

/** The plan's price for one night, or null when the plan has no price for this room type. */
export function priceFor(book: RateBook, planId: string, roomTypeId: string, date: string, depth = 0): number | null {
  const plan = book.plans.get(planId);
  if (!plan || depth > 5) return null;
  if (plan.kind === "derived" && plan.parent_id) {
    const parent = priceFor(book, plan.parent_id, roomTypeId, date, depth + 1);
    return parent == null ? null : Math.round((parent * (10_000 + (plan.derived_bp ?? 0))) / 10_000);
  }
  const span = (s: SeasonRow) => Date.parse(s.date_to) - Date.parse(s.date_from);
  const season = book.seasons
    .filter(
      (s) => s.rate_plan_id === planId && s.room_type_id === roomTypeId && s.date_from <= date && s.date_to >= date,
    )
    .reduce<SeasonRow | undefined>((best, s) => (!best || span(s) < span(best) ? s : best), undefined);
  if (season) return season.weekday_minor?.[weekdayIndex(date)] ?? season.amount_minor;
  return book.base.get(`${planId}|${roomTypeId}`) ?? null;
}

/** Prices for each night of a stay; refuses a plan that is inactive or has no price. */
export function stayPrices(book: RateBook, planId: string, roomTypeId: string, arrival: string, departure: string) {
  const plan = book.plans.get(planId);
  if (!plan) throw fail.invalid("Unknown rate plan for this hotel");
  if (!plan.active) throw fail.conflict(`Rate plan ${plan.code} is not on sale`);
  return nightsOf(arrival, departure).map((date) => {
    const amount = priceFor(book, planId, roomTypeId, date);
    if (amount == null) throw fail.invalid(`Rate plan ${plan.code} has no price for this room type on ${date}`);
    return { date, amount };
  });
}

const applies = (r: RestrictionRow, roomTypeId: string, planId: string | null, channelId: string | null) =>
  (r.room_type_id == null || r.room_type_id === roomTypeId) &&
  (r.rate_plan_id == null || planId == null || r.rate_plan_id === planId) &&
  (r.channel_id == null || r.channel_id === channelId);

/** Stop-sell for this room type, channel (null = direct) and night. */
export function stopSold(book: RateBook, roomTypeId: string, channelId: string | null, date: string): boolean {
  return book.restrictions.some(
    (r) => r.stop_sell && applies(r, roomTypeId, null, channelId) && r.date_from <= date && r.date_to >= date,
  );
}

/** The first restriction a stay breaks, as a message for the person booking, or null. */
export function restrictionProblem(
  book: RateBook,
  q: { roomTypeId: string; ratePlanId: string; channelId: string | null; arrival: string; departure: string },
): string | null {
  const nights = nightsOf(q.arrival, q.departure);
  for (const r of book.restrictions) {
    if (!applies(r, q.roomTypeId, q.ratePlanId, q.channelId)) continue;
    const covers = (d: string) => r.date_from <= d && r.date_to >= d;
    if (r.stop_sell && nights.some(covers)) return "Stop-sell: this room type is closed for sale on these dates";
    if (r.cta && covers(q.arrival)) return `Closed to arrival on ${q.arrival}`;
    if (r.ctd && covers(q.departure)) return `Closed to departure on ${q.departure}`;
    if (covers(q.arrival) && r.min_stay != null && nights.length < r.min_stay)
      return `Minimum stay is ${r.min_stay} nights for an arrival on ${q.arrival}`;
    if (covers(q.arrival) && r.max_stay != null && nights.length > r.max_stay)
      return `Maximum stay is ${r.max_stay} nights for an arrival on ${q.arrival}`;
  }
  return null;
}

export function toRestriction(r: RestrictionRow): hotel.RestrictionOut {
  return {
    roomTypeId: r.room_type_id,
    ratePlanId: r.rate_plan_id,
    channelId: r.channel_id,
    from: r.date_from,
    to: r.date_to,
    minStay: r.min_stay,
    maxStay: r.max_stay,
    closedToArrival: r.cta,
    closedToDeparture: r.ctd,
    stopSell: r.stop_sell,
  };
}

export function toRatePlan(book: RateBook, p: RatePlanRow): hotel.RatePlan {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    kind: p.kind,
    parentId: p.parent_id,
    derivedPct: p.derived_bp == null ? null : fromBp(p.derived_bp),
    breakfastIncluded: p.breakfast_included,
    corporateAccountId: p.corporate_account_id,
    policy: {
      refundable: p.refundable,
      freeCancelDays: p.free_cancel_days,
      cancelFeeNights: p.cancel_fee_nights,
      noShowFeeNights: p.no_show_fee_nights,
    },
    active: p.active,
    baseRates: [...book.base.entries()]
      .filter(([k]) => k.startsWith(p.id + "|"))
      .map(([k, amount]) => ({ roomTypeId: k.slice(p.id.length + 1), amountMinor: amount })),
    seasons: book.seasons
      .filter((s) => s.rate_plan_id === p.id)
      .map((s) => ({
        name: s.name,
        roomTypeId: s.room_type_id,
        from: s.date_from,
        to: s.date_to,
        amountMinor: s.amount_minor,
        ...(s.weekday_minor ? { weekdayAmountsMinor: s.weekday_minor } : {}),
      })),
  };
}
