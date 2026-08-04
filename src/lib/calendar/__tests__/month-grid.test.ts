import { describe, expect, it } from "vitest";

import {
  CALENDAR_DAY_HEADERS,
  addMonths,
  buildMonthGrid,
  dayOfMonth,
  formatDateOnly,
  formatMonthLabel,
  getMondayKey,
  getMonthKey,
  getMonthWindow,
  isMonthKey,
} from "@/lib/calendar/month-grid";

describe("month-grid", () => {
  it("builds a 42-cell Monday-start grid", () => {
    const cells = buildMonthGrid("2026-08");
    expect(cells).toHaveLength(42);
    // 2026-08-01 is a Saturday, so the grid starts on Monday 2026-07-27.
    expect(cells[0].dateKey).toBe("2026-07-27");
    expect(cells[0].inMonth).toBe(false);
    expect(CALENDAR_DAY_HEADERS[0]).toBe("Mo");
  });

  it("flags in-month cells only for the requested month", () => {
    const cells = buildMonthGrid("2026-08");
    const inMonth = cells.filter((cell) => cell.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth[0].dateKey).toBe("2026-08-01");
    expect(inMonth.at(-1)?.dateKey).toBe("2026-08-31");
  });

  it("handles a leap-year February", () => {
    expect(getMonthWindow("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(getMonthWindow("2027-02")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
  });

  it("crosses year boundaries in both directions", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-06", 12)).toBe("2027-06");
  });

  it("throws on a malformed month key rather than guessing", () => {
    expect(() => addMonths("2026-6", 1)).toThrow(/Invalid month key/);
    expect(() => getMonthWindow("nope", )).toThrow(/Invalid month key/);
    expect(isMonthKey("2026-13")).toBe(true); // shape check only, not a range check
    expect(isMonthKey("2026-6")).toBe(false);
  });

  it("resolves the Monday of any week", () => {
    expect(getMondayKey("2026-08-01")).toBe("2026-07-27"); // Saturday
    expect(getMondayKey("2026-07-27")).toBe("2026-07-27"); // Monday itself
    expect(getMondayKey("2026-08-02")).toBe("2026-07-27"); // Sunday ends the week
  });

  it("formats labels and dates in the repo conventions", () => {
    expect(formatMonthLabel("2026-08")).toBe("August 2026");
    expect(formatMonthLabel("garbage")).toBe("garbage");
    expect(formatDateOnly("2026-08-04")).toBe("4/8/2026");
    expect(getMonthKey("2026-08-04")).toBe("2026-08");
    expect(dayOfMonth("2026-08-04")).toBe(4);
  });
});
