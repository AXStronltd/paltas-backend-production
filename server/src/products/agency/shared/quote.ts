/*
 * The price of a stay, from the host's own configuration: each night's price (a set price for that date, otherwise
 * the listing's nightly rate) + the cleaning fee + the service fee (% of the nights) + tax (% of all of it).
 * No price lives in code. Also: is the stay allowed (minimum nights, guests, dates) and are the nights free?
 */
import type { marketplace } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { addDays } from "../../../lib/dates.js";
import type { ListingRow } from "../listings/listings.repo.js";
import { daysBetween, shareOf } from "./util.js";

/** The longest stay one booking may hold. */
export const MAX_NIGHTS = 90;

/** Statuses that hold nights on the calendar (the exclusion constraint uses the same list). */
export const HOLDING = ["confirmed", "checked_in", "completed"] as const;

export async function nightlyPrices(
  db: Db,
  l: ListingRow,
  from: string,
  to: string,
): Promise<{ date: string; priceMinor: number }[]> {
  const set = new Map(
    (
      await db.rows<{ date: string; price_minor: number }>(
        "SELECT date, price_minor FROM agency_stay_rates WHERE listing_id = $1 AND date >= $2 AND date < $3",
        [l.id, from, to],
      )
    ).map((r) => [r.date, r.price_minor]),
  );
  const out: { date: string; priceMinor: number }[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push({ date: d, priceMinor: set.get(d) ?? l.price_minor });
  return out;
}

/** Are these nights free of confirmed stays and blocks (ignoring one stay, e.g. the one being confirmed)? */
export async function nightsFree(db: Db, listingId: string, checkIn: string, checkOut: string, except?: string) {
  return !(await db.row(
    `SELECT 1 FROM agency_stays WHERE listing_id = $1 AND status = ANY($4)
       AND daterange(check_in, check_out, '[)') && daterange($2::date, $3::date, '[)') AND id IS DISTINCT FROM $5`,
    [listingId, checkIn, checkOut, HOLDING, except ?? null],
  ));
}

export async function quote(
  db: Db,
  l: ListingRow,
  q: { checkIn: string; checkOut: string; guests: number },
  today: string,
): Promise<marketplace.StayQuote> {
  const problems: string[] = [];
  const nights = daysBetween(q.checkIn, q.checkOut);
  if (l.purpose !== "stay") problems.push("This listing is not a stay");
  if (nights < 1) problems.push("Check-out must be after check-in");
  if (q.checkIn < today) problems.push("Check-in cannot be in the past");
  if (nights > MAX_NIGHTS) problems.push(`A booking can hold at most ${MAX_NIGHTS} nights`);
  if (nights >= 1 && nights < l.min_nights) problems.push(`The host asks for at least ${l.min_nights} nights`);
  if (l.max_guests !== null && q.guests > l.max_guests) problems.push(`At most ${l.max_guests} guests`);
  const ok = nights >= 1 && nights <= MAX_NIGHTS;
  const nightly = ok ? await nightlyPrices(db, l, q.checkIn, q.checkOut) : [];
  const accommodation = nightly.reduce((a, n) => a + n.priceMinor, 0);
  const cleaning = ok ? l.cleaning_fee_minor : 0;
  const service = shareOf(accommodation, l.service_fee_bp);
  const tax = shareOf(accommodation + cleaning + service, l.tax_bp);
  const free = ok ? await nightsFree(db, l.id, q.checkIn, q.checkOut) : false;
  if (ok && !free) problems.push("Some of these nights are already booked");
  return {
    checkIn: q.checkIn,
    checkOut: q.checkOut,
    nights: Math.max(nights, 0),
    currency: l.currency,
    nightly,
    accommodationMinor: accommodation,
    cleaningMinor: cleaning,
    serviceFeeMinor: service,
    taxMinor: tax,
    totalMinor: accommodation + cleaning + service + tax,
    available: free,
    problems,
  };
}
