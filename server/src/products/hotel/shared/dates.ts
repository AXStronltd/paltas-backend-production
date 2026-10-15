// Night arithmetic on "YYYY-MM-DD" business dates. A stay from arrival to departure occupies the nights
// arrival … departure - 1.
import { addDays } from "../../../lib/dates.js";

export { addDays };

/** The nights of a stay: every date from `from` up to, not including, `to`. */
export function nightsOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

/** Day of week, Monday = 0 … Sunday = 6. */
export function weekdayIndex(date: string): number {
  return (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7;
}
