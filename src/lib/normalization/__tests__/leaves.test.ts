import { describe, it, expect } from "vitest";
import { normalizeLeaves, deduplicateLeaves } from "../leaves";
import type { WiseLeave } from "@/lib/wise/types";

describe("normalizeLeaves", () => {
  it("converts UTC leaves to local time", () => {
    const leaves: WiseLeave[] = [
      {
        _id: "l1",
        startTime: "2024-01-15T02:00:00Z", // 09:00 Bangkok
        endTime: "2024-01-15T10:00:00Z", // 17:00 Bangkok
      },
    ];

    const result = normalizeLeaves(leaves);
    expect(result).toHaveLength(1);
    expect(result[0].startTime.getHours()).toBe(9);
    expect(result[0].endTime.getHours()).toBe(17);
  });

  it("handles empty leaves", () => {
    expect(normalizeLeaves([])).toEqual([]);
  });
});

describe("deduplicateLeaves", () => {
  it("merges overlapping leave windows", () => {
    const leaves = [
      { startTime: new Date("2024-01-15T09:00:00"), endTime: new Date("2024-01-15T14:00:00") },
      { startTime: new Date("2024-01-15T12:00:00"), endTime: new Date("2024-01-15T17:00:00") },
    ];

    const result = deduplicateLeaves(leaves);
    expect(result).toHaveLength(1);
    expect(result[0].startTime.getHours()).toBe(9);
    expect(result[0].endTime.getHours()).toBe(17);
  });

  it("keeps non-overlapping leaves separate", () => {
    const leaves = [
      { startTime: new Date("2024-01-15T09:00:00"), endTime: new Date("2024-01-15T12:00:00") },
      { startTime: new Date("2024-01-16T09:00:00"), endTime: new Date("2024-01-16T12:00:00") },
    ];

    const result = deduplicateLeaves(leaves);
    expect(result).toHaveLength(2);
  });
});
