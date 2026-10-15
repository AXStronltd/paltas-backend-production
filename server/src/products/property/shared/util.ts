// Small date and money helpers for Property Management ("YYYY-MM-DD" dates, integer minor units, basis points).
import { addDays, addMonths } from "../../../lib/dates.js";

export { addDays, addMonths };

/** "2026-10" → "2026-10-31" */
export function lastDay(month: string): string {
  return addDays(addMonths(`${month}-01`, 1), -1);
}

export const monthOf = (date: string) => date.slice(0, 7);

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

/** A month's due date for a due day, e.g. ("2026-10", 5) → "2026-10-05". */
export const dueDateIn = (month: string, day: number) => `${month}-${String(day).padStart(2, "0")}`;

/** 10.5 % → 1050 basis points. */
export const toBp = (pct: number) => Math.round(pct * 100);
export const toPct = (bp: number) => bp / 100;

/** amount × rate, rounded to the nearest minor unit (half away from zero). */
export function applyBp(amount: number, bp: number): number {
  const v = (amount * bp) / 10_000;
  return Math.sign(v) * Math.round(Math.abs(v));
}

/**
 * Split an amount in proportion to weights, in whole minor units, so the parts add up exactly (largest remainder).
 * Used to spread a part payment over an invoice's lines.
 */
export function splitProportionally(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const parts = raw.map((r) => Math.floor(r));
  let left = amount - parts.reduce((s, p) => s + p, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    parts[o.i] = (parts[o.i] ?? 0) + 1;
    left--;
  }
  return parts;
}

export const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
