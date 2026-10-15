/**
 * The business date and time. Production uses the real UTC clock; tests and demos may pin "today"
 * (PALTAS_TODAY), which the server refuses in production.
 */
export interface Clock {
  /** Today's business date, "YYYY-MM-DD" (UTC). */
  today(): string;
  now(): Date;
}

export function systemClock(fixedToday?: string | null): Clock & { setToday(d: string | null): void } {
  let pinned = fixedToday ?? null;
  return {
    today: () => pinned ?? new Date().toISOString().slice(0, 10),
    now: () => new Date(),
    setToday(d) {
      pinned = d;
    },
  };
}
