import { describe, expect, it } from "vitest";

import {
  defaultFootTrafficRange,
  latestCompletedBangkokDate,
  mondayWeekStart,
  validateFootTrafficRange,
  weekEnd,
} from "../dates";

describe("onsite foot-traffic dates", () => {
  it("uses the fixed March–September research preset", () => {
    expect(defaultFootTrafficRange(new Date("2026-09-04T00:30:00.000Z"))).toEqual({
      startDate: "2026-03-01",
      endDate: "2026-09-30",
    });
  });

  it("uses the latest fully completed Bangkok day", () => {
    expect(latestCompletedBangkokDate(new Date("2026-09-04T00:30:00.000Z"))).toBe("2026-09-03");
    expect(latestCompletedBangkokDate(new Date("2026-09-03T16:59:59.000Z"))).toBe("2026-09-02");
  });

  it("groups every day into a Monday–Sunday week", () => {
    expect(mondayWeekStart("2026-03-01")).toBe("2026-02-23");
    expect(mondayWeekStart("2026-03-02")).toBe("2026-03-02");
    expect(mondayWeekStart("2026-03-08")).toBe("2026-03-02");
    expect(weekEnd("2026-03-02")).toBe("2026-03-08");
  });

  it("rejects pre-history, impossible, reversed and overlong ranges", () => {
    expect(() => validateFootTrafficRange("2026-02-28", "2026-03-01")).toThrow("history begins");
    expect(() => validateFootTrafficRange("2026-03-40", "2026-04-01")).toThrow("real calendar");
    expect(() => validateFootTrafficRange("2026-04-01", "2026-03-01")).toThrow("startDate");
    expect(() => validateFootTrafficRange("2026-03-01", "2027-03-02")).toThrow("366 days");
  });
});
