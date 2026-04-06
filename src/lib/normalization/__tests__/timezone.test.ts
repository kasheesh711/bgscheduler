import { describe, it, expect } from "vitest";
import { toLocalTime, getLocalWeekday, getLocalMinuteOfDay, parseTimeToMinutes } from "../timezone";

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
