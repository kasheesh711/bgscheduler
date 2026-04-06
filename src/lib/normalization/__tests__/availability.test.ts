import { describe, it, expect } from "vitest";
import { normalizeWorkingHours, deduplicateWindows } from "../availability";
import type { WiseWorkingHourSlot } from "@/lib/wise/types";

describe("normalizeWorkingHours", () => {
  it("converts Wise slots to recurring windows", () => {
    const slots: WiseWorkingHourSlot[] = [
      { day: 1, startTime: "09:00", endTime: "17:00" },
      { day: 3, startTime: "10:00", endTime: "20:00" },
    ];

    const result = normalizeWorkingHours(slots);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ weekday: 1, startMinute: 540, endMinute: 1020 });
    expect(result[1]).toEqual({ weekday: 3, startMinute: 600, endMinute: 1200 });
  });

  it("handles empty slots", () => {
    expect(normalizeWorkingHours(undefined)).toEqual([]);
    expect(normalizeWorkingHours([])).toEqual([]);
  });

  it("skips zero-length windows", () => {
    const slots: WiseWorkingHourSlot[] = [
      { day: 1, startTime: "09:00", endTime: "09:00" },
    ];
    expect(normalizeWorkingHours(slots)).toEqual([]);
  });
});

describe("deduplicateWindows", () => {
  it("merges overlapping windows on same weekday", () => {
    const windows = [
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 660, endMinute: 900 },
    ];
    const result = deduplicateWindows(windows);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ weekday: 1, startMinute: 540, endMinute: 900 });
  });

  it("keeps non-overlapping windows separate", () => {
    const windows = [
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 780, endMinute: 900 },
    ];
    const result = deduplicateWindows(windows);
    expect(result).toHaveLength(2);
  });

  it("keeps different weekdays separate", () => {
    const windows = [
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 2, startMinute: 540, endMinute: 720 },
    ];
    const result = deduplicateWindows(windows);
    expect(result).toHaveLength(2);
  });
});
