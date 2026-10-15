// Cron schedules in a time zone: field syntax, day-of-month / day-of-week rules, time zones and daylight saving.
import { describe, expect, it } from "vitest";
import { checkTimezone, nextFire, parseCron, periodKey } from "../dist/core/scheduler/cron.js";

const at = (iso: string) => new Date(iso);
const next = (cron: string, after: string, tz = "UTC") => nextFire(cron, at(after), tz)?.toISOString();

describe("cron schedules", () => {
  it("parses fields with lists, ranges and steps, and refuses anything else", () => {
    const s = parseCron("*/15 6-8,20 1 */3 1-5");
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect([...s.hours]).toEqual([6, 7, 8, 20]);
    expect([...s.months]).toEqual([1, 4, 7, 10]);
    expect([...parseCron("0 0 * * 7").weekdays]).toEqual([0]); // 7 is Sunday too
    expect(() => parseCron("0 2 * *")).toThrow(/five fields/);
    expect(() => parseCron("60 2 * * *")).toThrow(/minute/);
    expect(() => parseCron("0 2 31-1 * *")).toThrow(/day of month/);
    expect(() => parseCron("0 2 * * MON")).toThrow(/day of week/);
    expect(() => checkTimezone("Mars/Olympus")).toThrow(/Unknown time zone/);
    expect(() => checkTimezone("Africa/Nairobi")).not.toThrow();
  });

  it("finds the next fire time strictly after a moment, in UTC", () => {
    expect(next("17 * * * *", "2026-10-11T10:17:00Z")).toBe("2026-10-11T11:17:00.000Z");
    expect(next("17 * * * *", "2026-10-11T10:16:59Z")).toBe("2026-10-11T10:17:00.000Z");
    expect(next("5 0 * * *", "2026-12-31T23:59:00Z")).toBe("2027-01-01T00:05:00.000Z");
    expect(next("0 9 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T09:00:00.000Z"); // leap day
  });

  it("runs at the wall-clock time of the job's zone (a hotel's 02:00 night audit in Nairobi is 23:00 UTC)", () => {
    expect(next("0 2 * * *", "2026-10-11T00:00:00Z", "Africa/Nairobi")).toBe("2026-10-11T23:00:00.000Z");
    expect(periodKey(at("2026-10-11T23:00:00Z"), "Africa/Nairobi")).toBe("2026-10-12T02:00");
    expect(periodKey(at("2026-10-11T23:00:00Z"))).toBe("2026-10-11T23:00");
  });

  it("when both day fields are restricted, a day matching either runs (classic cron)", () => {
    // the 15th, or any Monday — after Fri 2026-10-09: Mon 12th comes first, then the 15th (a Thursday)
    expect(next("0 8 15 * 1", "2026-10-09T09:00:00Z")).toBe("2026-10-12T08:00:00.000Z");
    expect(next("0 8 15 * 1", "2026-10-12T09:00:00Z")).toBe("2026-10-15T08:00:00.000Z");
    // weekdays only
    expect(next("30 6 * * 1-5", "2026-10-09T07:00:00Z")).toBe("2026-10-12T06:30:00.000Z");
  });

  it("handles daylight saving: a missing local time runs at the first moment after it; a repeated one once", () => {
    // London springs forward on 2026-03-29 at 01:00 → 02:00: 01:30 does not exist; runs at 02:00 BST (01:00 UTC)
    expect(next("30 1 * * *", "2026-03-28T12:00:00Z", "Europe/London")).toBe("2026-03-29T01:00:00.000Z");
    // the day after, 01:30 BST is 00:30 UTC
    expect(next("30 1 * * *", "2026-03-29T12:00:00Z", "Europe/London")).toBe("2026-03-30T00:30:00.000Z");
    // falls back on 2026-10-25 (01:00–02:00 happens twice): the job runs once that day, then next day at 01:30 GMT
    const first = next("30 1 * * *", "2026-10-24T12:00:00Z", "Europe/London") as string;
    expect(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]).toContain(first);
    expect(next("30 1 * * *", "2026-10-25T01:30:00Z", "Europe/London")).toBe("2026-10-26T01:30:00.000Z");
  });
});
