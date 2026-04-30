import { describe, it, expect } from "vitest";
import { toZonedTime } from "date-fns-tz";
import { TIMEZONE, toLocalTime, getLocalWeekday, getLocalMinuteOfDay, parseTimeToMinutes } from "../timezone";

describe("parseTimeToMinutes", () => {
  it("parses HH:mm to minutes", () => {
    expect(parseTimeToMinutes("09:00")).toBe(540);
    expect(parseTimeToMinutes("14:30")).toBe(870);
    expect(parseTimeToMinutes("00:00")).toBe(0);
    expect(parseTimeToMinutes("23:59")).toBe(1439);
  });
});

describe("toLocalTime", () => {
  it("converts UTC to Asia/Bangkok (UTC+7)", () => {
    // 2024-01-15 02:00 UTC = 2024-01-15 09:00 Bangkok
    const local = toLocalTime("2024-01-15T02:00:00Z");
    expect(local.getHours()).toBe(9);
  });
});

describe("getLocalWeekday", () => {
  it("returns correct weekday in Bangkok timezone", () => {
    // 2024-01-15 is Monday
    // At 20:00 UTC = 03:00 next day (Tuesday) in Bangkok
    const weekday = getLocalWeekday("2024-01-15T20:00:00Z");
    expect(weekday).toBe(2); // Tuesday
  });
});

describe("getLocalMinuteOfDay", () => {
  it("returns minutes since midnight in Bangkok", () => {
    // 02:00 UTC = 09:00 Bangkok = 540 minutes
    const minutes = getLocalMinuteOfDay("2024-01-15T02:00:00Z");
    expect(minutes).toBe(540);
  });
});

describe("toZonedTime round-trip — REL-08 lock-in", () => {
  // Asserts the observable behavior that downstream consumers rely on:
  //   .getDay() / .getHours() / .getMinutes() / .toDateString() return
  //   Bangkok-local wallclock values when the input is a UTC instant.
  // This locks the contract used by:
  //   - src/app/api/compare/route.ts getCurrentMonday()
  //   - src/hooks/use-compare.ts getCurrentMonday()
  //   - src/components/compare/week-overview.tsx today-indicator state
  //   - src/components/compare/calendar-grid.tsx today-indicator state

  it("converts a UTC instant at 17:00Z into Bangkok-local 00:00 next-day", () => {
    // 17:00 UTC + 7h offset = 00:00 Bangkok next calendar day
    const bkk = toZonedTime(new Date("2026-04-29T17:00:00Z"), TIMEZONE);
    expect(bkk.getDay()).toBe(4); // Thursday (next day in Bangkok)
    expect(bkk.getHours()).toBe(0);
    expect(bkk.getMinutes()).toBe(0);
    expect(bkk.getDate()).toBe(30);
  });

  it("converts a UTC instant at 05:00Z into Bangkok-local 12:00 same-day", () => {
    // 05:00 UTC + 7h = 12:00 Bangkok same calendar day
    const bkk = toZonedTime(new Date("2026-04-29T05:00:00Z"), TIMEZONE);
    expect(bkk.getDay()).toBe(3); // Wednesday
    expect(bkk.getHours()).toBe(12);
    expect(bkk.getMinutes()).toBe(0);
    expect(bkk.getDate()).toBe(29);
  });

  it("toDateString is consistent across the UTC midnight boundary", () => {
    const a = toZonedTime(new Date("2026-04-29T16:59:00Z"), TIMEZONE); // 23:59 BKK Wed
    const b = toZonedTime(new Date("2026-04-29T17:01:00Z"), TIMEZONE); // 00:01 BKK Thu
    expect(a.toDateString()).not.toBe(b.toDateString());
  });
});

describe("Day boundary — UTC 17:00 = Bangkok 00:00 next day", () => {
  it("getLocalWeekday returns NEXT day's weekday at UTC 17:00", () => {
    // 2026-04-29T17:00:00Z is Wed at UTC, Thu at Bangkok (UTC+7)
    expect(getLocalWeekday("2026-04-29T17:00:00Z")).toBe(4); // Thursday
  });

  it("getLocalWeekday returns SAME day's weekday at UTC 16:59", () => {
    // 1 minute before midnight crossover — still Wednesday in Bangkok
    expect(getLocalWeekday("2026-04-29T16:59:00Z")).toBe(3); // Wednesday
  });

  it("getLocalMinuteOfDay is 0 at the BKK midnight crossover", () => {
    // BKK 00:00 = UTC 17:00 of previous day
    expect(getLocalMinuteOfDay("2026-04-29T17:00:00Z")).toBe(0);
  });

  it("getLocalMinuteOfDay is 1439 at the BKK pre-midnight tick", () => {
    // BKK 23:59 = UTC 16:59 of same day
    expect(getLocalMinuteOfDay("2026-04-29T16:59:00Z")).toBe(23 * 60 + 59);
  });

  it("date arithmetic across UTC midnight stays consistent in BKK", () => {
    // Two timestamps 9 hours apart in UTC; toZonedTime should preserve the
    // elapsed time when converted to BKK.
    const a = toZonedTime(new Date("2026-04-29T16:00:00Z"), TIMEZONE); // 23:00 BKK Wed
    const b = toZonedTime(new Date("2026-04-30T01:00:00Z"), TIMEZONE); // 08:00 BKK Thu
    expect(b.getTime() - a.getTime()).toBe(9 * 3600_000); // exactly 9 hours
  });

  it("slot-time arithmetic: 90-min slot starting at BKK 00:00 ends at 01:30 same day", () => {
    // The slot crosses no further boundaries — both endpoints are on Thursday in BKK.
    const slotStart = toZonedTime(new Date("2026-04-29T17:00:00Z"), TIMEZONE);
    const slotEnd = new Date(slotStart.getTime() + 90 * 60_000);
    expect(slotEnd.getHours()).toBe(1);
    expect(slotEnd.getMinutes()).toBe(30);
    expect(slotEnd.getDay()).toBe(slotStart.getDay()); // still Thursday
  });
});
