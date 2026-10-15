/*
 * Cron schedules in a time zone, without a dependency.
 *
 *   minute hour day-of-month month day-of-week      e.g. "0 2 * * *" (02:00 every day), "30 6 1 * *" (06:30 on the 1st)
 *
 * Each field takes "*", a number, a range "a-b", a step "* /n" or "a-b/n", or a comma list of these. Day of week is
 * 0–6 from Sunday (7 is also Sunday). As in classic cron, when both day fields are restricted a day matching EITHER
 * runs. Times are wall-clock times in the job's IANA time zone (e.g. "Africa/Nairobi"); a time that does not exist
 * on a daylight-saving change day runs at the first moment after it.
 */

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

function field(text: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Cron ${f.name}: "${part}" is not valid`);
    const from = m[1] === "*" ? f.min : Number(m[2]);
    const to = m[1] === "*" ? f.max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? f.max : from;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (from < f.min || to > f.max || from > to || step < 1)
      throw new Error(`Cron ${f.name}: "${part}" is outside ${f.min}–${f.max}`);
    for (let v = from; v <= to; v += step) out.add(f.name === "day of week" && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronSchedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Use five fields: minute hour day-of-month month day-of-week");
  const [mi, h, d, mo, wd] = parts as [string, string, string, string, string];
  return {
    minutes: field(mi, FIELDS[0]),
    hours: field(h, FIELDS[1]),
    days: field(d, FIELDS[2]),
    months: field(mo, FIELDS[3]),
    weekdays: field(wd, FIELDS[4]),
    daysRestricted: d !== "*",
    weekdaysRestricted: wd !== "*",
  };
}

/** Throws a clear error when the time zone is not an IANA zone this server knows. */
export function checkTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    throw new Error(`Unknown time zone "${tz}" — use an IANA name such as Africa/Nairobi`);
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock time in tz at this instant, as a "naive" UTC timestamp (ms) with the same fields. */
function wallClock(instantMs: number, tz: string): number {
  const p = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(instantMs))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
}

/** The instant at which the wall clock in tz shows this naive time (the first one after it, in a DST gap). */
function instantOf(naiveMs: number, tz: string): number {
  const a = naiveMs - (wallClock(naiveMs, tz) - naiveMs);
  if (wallClock(a, tz) === naiveMs) return a;
  const b = naiveMs - (wallClock(a, tz) - a);
  if (wallClock(b, tz) === naiveMs) return b;
  // in a DST gap that wall time never shows: take the first minute after it that does (the moment of the change)
  let t = Math.min(a, b);
  while (wallClock(t, tz) < naiveMs) t += 60_000;
  return t;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The first moment strictly after `after` matching the schedule, or null if none within ~5 years. */
export function nextFire(schedule: CronSchedule | string, after: Date, tz = "UTC"): Date | null {
  const s = typeof schedule === "string" ? parseCron(schedule) : schedule;
  // start at the next whole minute, in wall-clock time
  let t = Math.floor(wallClock(after.getTime(), tz) / MINUTE) * MINUTE + MINUTE;
  const limit = t + 5 * 366 * DAY;
  while (t < limit) {
    const d = new Date(t);
    if (!s.months.has(d.getUTCMonth() + 1)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      continue;
    }
    const dom = s.days.has(d.getUTCDate());
    const dow = s.weekdays.has(d.getUTCDay());
    const dayOk =
      s.daysRestricted && s.weekdaysRestricted
        ? dom || dow
        : s.daysRestricted
          ? dom
          : s.weekdaysRestricted
            ? dow
            : true;
    if (!dayOk) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    if (!s.hours.has(d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!s.minutes.has(d.getUTCMinutes())) {
      t += MINUTE;
      continue;
    }
    const instant = instantOf(t, tz);
    if (instant > after.getTime()) return new Date(instant);
    t += MINUTE;
  }
  return null;
}

/** The period key of a fire time: its wall-clock time in the job's zone, "YYYY-MM-DDTHH:MM". */
export function periodKey(instant: Date, tz = "UTC"): string {
  return new Date(wallClock(instant.getTime(), tz)).toISOString().slice(0, 16);
}
