/*
 * Abuse limits for the public marketplace: a fixed window per caller address and action. Searches and submissions
 * have separate budgets (MARKETPLACE_SEARCH_PER_MINUTE, MARKETPLACE_SUBMIT_PER_HOUR). Kept in this server's memory:
 * behind several servers each one applies the limit to what it receives. Per-person caps (open requests per listing)
 * are checked in the database by the services.
 */
import { fail } from "../../../http/errors.js";

interface Window {
  count: number;
  resetAt: number;
}

export interface PublicLimits {
  searchPerMinute: number;
  submitPerHour: number;
}

export function publicLimiter(limits: PublicLimits, now: () => number = Date.now) {
  const windows = new Map<string, Window>();
  let checks = 0;

  function hit(key: string, max: number, windowMs: number, message: string): void {
    const t = now();
    // drop finished windows now and then, so the map stays small
    if (++checks % 500 === 0) for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
    const w = windows.get(key);
    if (!w || w.resetAt <= t) {
      windows.set(key, { count: 1, resetAt: t + windowMs });
      return;
    }
    if (++w.count > max) throw fail.tooManyAttempts(message);
  }

  return {
    /** Reading listings, availability and quotes. */
    read(ip: string): void {
      hit(`read:${ip}`, limits.searchPerMinute, 60_000, "Too many searches from this address — wait a minute");
    },
    /** Enquiries, offers, bookings, reviews and business requests. */
    submit(ip: string): void {
      hit(`submit:${ip}`, limits.submitPerHour, 3_600_000, "Too many requests from this address — try again later");
    },
  };
}

export type PublicLimiter = ReturnType<typeof publicLimiter>;
