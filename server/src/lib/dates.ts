// Small calendar helpers for "YYYY-MM-DD" business dates (UTC, no time zones involved).
// addDays/addMonths are the shared rules' own helpers, so billing dates match the browser exactly.
import { entitlements } from "@paltas/contracts";

export const addDays = entitlements.addDays;
export const addMonths = entitlements.addMonths;

/** "2026-10-14" → "October 2026" */
export function monthName(date: string): string {
  const d = new Date(date.slice(0, 7) + "-01T00:00:00Z");
  return d.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
