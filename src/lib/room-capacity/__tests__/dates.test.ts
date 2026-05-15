import { afterEach, describe, expect, it, vi } from "vitest";
import { datesBetweenBangkok, defaultRoomCapacityRange } from "../dates";

describe("room capacity Bangkok date helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to today through the last day of the Bangkok month inclusive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T18:30:00.000Z"));

    const range = defaultRoomCapacityRange();

    expect(range).toEqual({ startDate: "2026-05-15", endDate: "2026-05-31" });
    expect(datesBetweenBangkok(range.startDate, range.endDate)).toHaveLength(17);
    expect(datesBetweenBangkok(range.startDate, range.endDate).at(-1)).toBe("2026-05-31");
  });
});
