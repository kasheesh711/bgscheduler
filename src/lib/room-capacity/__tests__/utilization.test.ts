import { describe, expect, it } from "vitest";
import {
  aggregateRoomUtilization,
  parseUtilizationWeekdays,
  ROOM_UTILIZATION_OPEN_MINUTES,
  wiseSessionToUtilizationRow,
  type RoomUtilizationSession,
} from "../utilization";

const rooms = [
  { name: "Focus", capacity: 2, category: "standard" as const, active: true, sortOrder: 1 },
  { name: "Joy (TV)", capacity: 3, category: "standard" as const, active: true, sortOrder: 2 },
  { name: "I learned (online)", capacity: 1, category: "online_only" as const, active: true, sortOrder: 3 },
  { name: "Closed", capacity: 3, category: "standard" as const, active: false, sortOrder: 4 },
];

function row(overrides: Partial<RoomUtilizationSession> = {}): RoomUtilizationSession {
  return {
    id: overrides.id ?? "row-1",
    wiseSessionId: overrides.wiseSessionId ?? "session-1",
    startTime: overrides.startTime ?? new Date("2026-03-02T03:00:00.000Z"),
    endTime: overrides.endTime ?? new Date("2026-03-02T04:00:00.000Z"),
    utilizationDate: overrides.utilizationDate ?? "2026-03-02",
    weekday: overrides.weekday ?? 1,
    startMinute: overrides.startMinute ?? 10 * 60,
    endMinute: overrides.endMinute ?? 11 * 60,
    wiseStatus: overrides.wiseStatus ?? "ENDED",
    sessionType: overrides.sessionType ?? "OFFLINE",
    rawLocation: overrides.rawLocation === undefined ? "Focus" : overrides.rawLocation,
    normalizedRoomLabel: overrides.normalizedRoomLabel === undefined ? "Focus" : overrides.normalizedRoomLabel,
    studentCount: overrides.studentCount ?? 1,
    syncedAt: overrides.syncedAt ?? new Date("2026-05-18T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-05-18T00:00:00.000Z"),
  };
}

describe("room utilization aggregation", () => {
  it("uses active room count and fixed open hours for the denominator", () => {
    const result = aggregateRoomUtilization({
      rows: [row()],
      rooms,
      startDate: "2026-03-02",
      endDate: "2026-03-02",
      generatedAt: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(result.summary.activeRoomCount).toBe(3);
    expect(result.summary.availableMinutes).toBe(3 * ROOM_UTILIZATION_OPEN_MINUTES);
    expect(result.summary.occupiedMinutes).toBe(60);
    expect(result.summary.utilizationPct).toBe(2.4);
    expect(result.range.weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("excludes cancelled and missed statuses from occupied minutes", () => {
    const result = aggregateRoomUtilization({
      rows: [
        row({ wiseSessionId: "ended", wiseStatus: "ENDED" }),
        row({ wiseSessionId: "cancelled", wiseStatus: "CANCELLED" }),
        row({ wiseSessionId: "missed", wiseStatus: "MISSED" }),
      ],
      rooms,
      startDate: "2026-03-02",
      endDate: "2026-03-02",
    });

    expect(result.summary.occupiedMinutes).toBe(60);
    expect(result.dataQuality.excludedStatusCount).toBe(2);
    expect(result.daily[0].excludedStatusCount).toBe(2);
  });

  it("reports missing and unknown rooms without counting them as utilized room time", () => {
    const result = aggregateRoomUtilization({
      rows: [
        row({ wiseSessionId: "known" }),
        row({ wiseSessionId: "missing", rawLocation: null, normalizedRoomLabel: null }),
        row({ wiseSessionId: "unknown", rawLocation: "Storage", normalizedRoomLabel: "Storage" }),
      ],
      rooms,
      startDate: "2026-03-02",
      endDate: "2026-03-02",
    });

    expect(result.summary.occupiedMinutes).toBe(60);
    expect(result.dataQuality.missingLocationCount).toBe(1);
    expect(result.dataQuality.unknownRoomCount).toBe(1);
    expect(result.dataQuality.missingLocationMinutes).toBe(60);
    expect(result.dataQuality.unknownRoomMinutes).toBe(60);
  });

  it("clips sessions to the 07:00-21:00 open window", () => {
    const result = aggregateRoomUtilization({
      rows: [
        row({ wiseSessionId: "early", startMinute: 6 * 60 + 30, endMinute: 7 * 60 + 30 }),
        row({ wiseSessionId: "late", startMinute: 20 * 60 + 30, endMinute: 21 * 60 + 30 }),
      ],
      rooms,
      startDate: "2026-03-02",
      endDate: "2026-03-02",
    });

    expect(result.summary.occupiedMinutes).toBe(60);
  });

  it("double-counts overlapping room time and reports overlap pressure", () => {
    const result = aggregateRoomUtilization({
      rows: [
        row({ wiseSessionId: "a", startMinute: 10 * 60, endMinute: 12 * 60 }),
        row({ wiseSessionId: "b", startMinute: 10 * 60 + 30, endMinute: 11 * 60 + 30 }),
      ],
      rooms,
      startDate: "2026-03-02",
      endDate: "2026-03-02",
    });

    expect(result.summary.occupiedMinutes).toBe(180);
    expect(result.dataQuality.overlapMinutes).toBe(60);
    expect(result.rooms.find((roomResult) => roomResult.roomName === "Focus")?.overlapMinutes).toBe(60);
  });

  it("filters denominator and sessions by selected weekdays", () => {
    const result = aggregateRoomUtilization({
      rows: [
        row({ wiseSessionId: "monday" }),
        row({ wiseSessionId: "saturday", utilizationDate: "2026-03-07", weekday: 6 }),
      ],
      rooms,
      startDate: "2026-03-02",
      endDate: "2026-03-07",
      weekdays: [1],
    });

    expect(result.range.weekdays).toEqual([1]);
    expect(result.daily.map((day) => day.date)).toEqual(["2026-03-02"]);
    expect(result.summary.availableMinutes).toBe(3 * ROOM_UTILIZATION_OPEN_MINUTES);
    expect(result.summary.occupiedMinutes).toBe(60);
    expect(result.summary.sessionCount).toBe(1);
  });

  it("parses weekday filter tokens", () => {
    expect(parseUtilizationWeekdays("mon,3,sunday")).toEqual([0, 1, 3]);
    expect(parseUtilizationWeekdays(null)).toBeUndefined();
    expect(() => parseUtilizationWeekdays("monday,funday")).toThrow("Invalid weekdays");
  });

  it("derives Bangkok date and room label from Wise sessions without keeping PII fields", () => {
    const converted = wiseSessionToUtilizationRow({
      _id: "wise-1",
      scheduledStartTime: "2026-03-01T17:30:00.000Z",
      scheduledEndTime: "2026-03-01T18:30:00.000Z",
      meetingStatus: "ENDED",
      type: "OFFLINE",
      location: "Joy",
      studentCount: 2,
      title: "Should not be persisted",
      classId: { name: "Student Name" },
    });

    expect(converted).toMatchObject({
      wiseSessionId: "wise-1",
      utilizationDate: "2026-03-02",
      weekday: 1,
      startMinute: 30,
      endMinute: 90,
      rawLocation: "Joy",
      normalizedRoomLabel: "Joy",
      studentCount: 2,
    });
    expect(converted).not.toHaveProperty("title");
    expect(converted).not.toHaveProperty("studentName");
  });
});
