import { describe, expect, it } from "vitest";

import {
  resolveReportWindow,
  snapshotDataBounds,
  windowWarnings,
} from "../window";

describe("resolveReportWindow", () => {
  it("uses a half-open boundary after the inclusive Bangkok end date", () => {
    const window = resolveReportWindow("2026-08-15", "2026-08-17");
    const lateOnToDate = new Date("2026-08-17T16:30:00.000Z");
    const nextBangkokMidnight = new Date("2026-08-17T17:00:00.000Z");

    expect(lateOnToDate.getTime()).toBeLessThan(window.endUtc.getTime());
    expect(nextBangkokMidnight).toEqual(window.endUtc);
  });

  it("ends at the next Bangkok day and gives a single day exactly 24 hours", () => {
    const window = resolveReportWindow("2026-08-17", "2026-08-17");

    expect(window.startUtc.toISOString()).toBe("2026-08-16T17:00:00.000Z");
    expect(window.endUtc.toISOString()).toBe("2026-08-17T17:00:00.000Z");
    expect(window.endUtc.getTime() - window.startUtc.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("formats same-year, cross-year, and single-day labels", () => {
    expect(resolveReportWindow("2026-05-15", "2026-08-17").label).toBe(
      "15 May – 17 Aug 2026",
    );
    expect(resolveReportWindow("2025-12-15", "2026-01-17").label).toBe(
      "15 Dec 2025 – 17 Jan 2026",
    );
    expect(resolveReportWindow("2026-08-17", "2026-08-17").label).toBe("17 Aug 2026");
  });
});

describe("snapshotDataBounds", () => {
  it("derives the retained date floor and ceiling from a fixed snapshot instant", () => {
    expect(snapshotDataBounds(new Date("2026-08-17T05:00:00.000Z"))).toEqual({
      floorDateKey: "2026-04-19",
      ceilingDateKey: "2027-02-13",
    });
  });
});

describe("windowWarnings", () => {
  const bounds = { floorDateKey: "2026-05-01", ceilingDateKey: "2026-08-31" };

  it.each([
    ["neither", "2026-05-01", "2026-08-31", false, false],
    ["floor only", "2026-04-30", "2026-08-31", true, false],
    ["ceiling only", "2026-05-01", "2026-09-01", false, true],
    ["both", "2026-04-30", "2026-09-01", true, true],
  ])("flags %s side", (_label, from, to, floorWarning, ceilingWarning) => {
    expect(windowWarnings(resolveReportWindow(from, to), bounds)).toEqual({
      floorWarning,
      ceilingWarning,
    });
  });
});
