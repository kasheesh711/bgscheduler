import { describe, expect, it } from "vitest";
import {
  normalizeLeaveWindow,
  parseLeaveRequestSheetRows,
  parseSheetDate,
  parseSpecificTimeWindow,
} from "../parser";

const headers = [
  "Timestamp",
  "Tutor Name",
  "Email Address",
  "Start Leave Date",
  "End Leave Date",
  "Time Period of Leave",
  "If Specific Time",
  "Scheduled classes",
  "Affected class count",
  "Make-up options",
  "Reason",
  "Medical certificate",
  "Situation",
  "Agreement",
  "Days Notice",
  "Late Notice",
  "Admin Fee",
  "Emergency Used",
  "Status",
];

describe("leave request parser", () => {
  it("normalizes formatted full-day rows and preserves raw values", () => {
    const [row] = parseLeaveRequestSheetRows([
      headers,
      [
        "31/05/2026 10:15:00",
        "Tutor One",
        "Tutor@One.com",
        "01/06/2026",
        "02/06/2026",
        "Full Day",
        "",
        "Yes",
        "3",
        "Can do Friday",
        "Sick",
        "https://drive.google.com/file",
        "Fever",
        "Yes",
        "2",
        "Late",
        "500",
        "1",
        "New",
      ],
    ]);

    expect(row).toMatchObject({
      sourceRowNumber: 2,
      tutorName: "Tutor One",
      tutorEmail: "tutor@one.com",
      startDate: "2026-06-01",
      endDate: "2026-06-02",
      startMinute: 0,
      endMinute: 1440,
      normalizationStatus: "ok",
      reportedAffectedClasses: "3",
      daysNotice: 2,
      adminFee: 500,
      emergencyUsed: 1,
      sourceSheetStatus: "New",
    });
    expect(row.rawValues["Tutor Name"]).toBe("Tutor One");
  });

  it("parses Google serial dates as Bangkok-local date values", () => {
    expect(parseSheetDate(46174)).toBe("2026-06-01");
  });

  it("maps partial-day windows to Bangkok minute ranges", () => {
    expect(normalizeLeaveWindow({
      startDate: "2026-06-01",
      endDate: "2026-06-01",
      timePeriod: "Morning",
      specificTimeText: null,
    })).toMatchObject({ startMinute: 0, endMinute: 720, normalizationStatus: "ok" });
    expect(normalizeLeaveWindow({
      startDate: "2026-06-01",
      endDate: "2026-06-01",
      timePeriod: "Afternoon",
      specificTimeText: null,
    })).toMatchObject({ startMinute: 720, endMinute: 1020, normalizationStatus: "ok" });
    expect(normalizeLeaveWindow({
      startDate: "2026-06-01",
      endDate: "2026-06-01",
      timePeriod: "Evening",
      specificTimeText: null,
    })).toMatchObject({ startMinute: 1020, endMinute: 1440, normalizationStatus: "ok" });
  });

  it("parses common specific-time formats", () => {
    expect(parseSpecificTimeWindow("10:30-12:00")).toMatchObject({ startMinute: 630, endMinute: 720, error: null });
    expect(parseSpecificTimeWindow("4pm to 6pm")).toMatchObject({ startMinute: 960, endMinute: 1080, error: null });
    expect(parseSpecificTimeWindow("10-1pm")).toMatchObject({ startMinute: 600, endMinute: 780, error: null });
    expect(parseSpecificTimeWindow("4 to 6pm")).toMatchObject({ startMinute: 960, endMinute: 1080, error: null });
    expect(parseSpecificTimeWindow("Before 13:00")).toMatchObject({ startMinute: 0, endMinute: 780, error: null });
    expect(parseSpecificTimeWindow("16.00 onwards")).toMatchObject({ startMinute: 960, endMinute: 1440, error: null });
  });

  it("marks ambiguous specific times and invalid date ranges for review", () => {
    expect(parseSpecificTimeWindow("after lunch")).toMatchObject({
      startMinute: null,
      endMinute: null,
      error: expect.stringContaining("Could not parse"),
    });
    expect(normalizeLeaveWindow({
      startDate: "2026-06-03",
      endDate: "2026-06-01",
      timePeriod: "Full Day",
      specificTimeText: null,
    })).toMatchObject({ normalizationStatus: "needs_review" });
  });

  it("skips missing empty rows", () => {
    expect(parseLeaveRequestSheetRows([headers, [], ["", "", ""]])).toHaveLength(0);
  });
});
