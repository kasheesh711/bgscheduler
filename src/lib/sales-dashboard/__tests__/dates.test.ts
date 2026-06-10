import { describe, expect, it } from "vitest";
import {
  addMonths,
  currentBangkokDate,
  currentBangkokMonthEnd,
  currentBangkokMonthStart,
  monthShortLabel,
  monthStartOf,
  monthsInRange,
} from "@/lib/sales-dashboard/dates";

describe("sales dashboard Bangkok dates", () => {
  it("uses Bangkok date boundaries for current month helpers", () => {
    const bangkokMayFirst = new Date("2026-04-30T17:00:00.000Z");

    expect(currentBangkokDate(bangkokMayFirst)).toBe("2026-05-01");
    expect(currentBangkokMonthStart(bangkokMayFirst)).toBe("2026-05-01");
    expect(currentBangkokMonthEnd(bangkokMayFirst)).toBe("2026-05-31");
  });

  it("does not roll into the next Bangkok month before Bangkok midnight", () => {
    const bangkokAprilThirtieth = new Date("2026-04-30T16:59:59.000Z");

    expect(currentBangkokDate(bangkokAprilThirtieth)).toBe("2026-04-30");
    expect(currentBangkokMonthStart(bangkokAprilThirtieth)).toBe("2026-04-01");
    expect(currentBangkokMonthEnd(bangkokAprilThirtieth)).toBe("2026-04-30");
  });
});

describe("pure month-key helpers", () => {
  it("derives the month start of an ISO date", () => {
    expect(monthStartOf("2026-03-15")).toBe("2026-03-01");
  });

  it("adds months across year boundaries in both directions", () => {
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(addMonths("2025-11-01", 3)).toBe("2026-02-01");
  });

  it("builds inclusive month ranges and returns empty for reversed ranges", () => {
    expect(monthsInRange("2025-11-15", "2026-02-03")).toEqual([
      "2025-11-01",
      "2025-12-01",
      "2026-01-01",
      "2026-02-01",
    ]);
    expect(monthsInRange("2026-05-01", "2026-04-30")).toEqual([]);
  });

  it("formats short month labels and returns unparseable input unchanged", () => {
    expect(monthShortLabel("2026-04-01")).toBe("Apr 26");
    expect(monthShortLabel("garbage")).toBe("garbage");
  });
});
