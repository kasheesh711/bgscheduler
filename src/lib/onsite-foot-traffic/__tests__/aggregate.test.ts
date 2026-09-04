import { describe, expect, it } from "vitest";

import { aggregateFootTraffic } from "../aggregate";
import type { FootTrafficSessionRecord, FootTrafficVisitRecord } from "../types";

function session(id: string, date: string, roomName = "Focus", visits = 1): FootTrafficSessionRecord {
  return {
    wiseSessionId: id,
    attendanceDate: date,
    scheduledStartAt: new Date(`${date}T03:00:00.000Z`),
    scheduledEndAt: new Date(`${date}T04:00:00.000Z`),
    wiseStatus: "ENDED",
    sessionType: "OFFLINE",
    normalizedLocation: roomName,
    roomName,
    roomCategory: "standard",
    subject: "Math",
    tutorName: "Tutor",
    scheduledStudentCount: visits,
    participantCount: visits,
    countedVisitCount: visits,
    missingAttendanceEvidenceCount: 0,
    missingStableIdCount: 0,
    isCountedOnsite: true,
    exclusionReason: null,
  };
}

function visit(sessionId: string, date: string, fingerprint: string | null): FootTrafficVisitRecord {
  return { wiseSessionId: sessionId, participantKey: fingerprint ?? `${sessionId}-anon`, studentFingerprint: fingerprint, attendanceDate: date, consumedCredits: 1 };
}

const sessions = [
  session("s1", "2026-03-02"),
  session("s2", "2026-03-09"),
  session("s3", "2026-09-03", "Joy (TV)"),
];
const visits = [
  visit("s1", "2026-03-02", "same-student"),
  visit("s2", "2026-03-09", "same-student"),
  visit("s3", "2026-09-03", null),
];

function result(overrides: Record<string, unknown> = {}) {
  return aggregateFootTraffic({
    sessions,
    visits,
    filters: { startDate: "2026-03-01", endDate: "2026-09-30" },
    latestCompletedDate: "2026-09-03",
    coverageStartDate: "2026-03-01",
    coverageEndDate: "2026-09-03",
    dataAsOf: "2026-09-03",
    lastSuccessfulSyncAt: "2026-09-04T01:00:00.000Z",
    sourceSyncRunId: "run-1",
    availableRooms: ["Focus", "Joy (TV)", "Never Used"],
    ...overrides,
  });
}

describe("onsite foot-traffic aggregation", () => {
  it("counts visits, distinct identified students, classes and averages", () => {
    const data = result();
    expect(data.summary).toEqual({
      studentVisits: 3,
      uniqueStudents: 1,
      onsiteClasses: 3,
      averageVisitsPerClass: 1,
      unidentifiedVisits: 1,
    });
    expect(data.meta.effectiveEndDate).toBe("2026-09-03");
    expect(data.meta.isEndDateCapped).toBe(true);
    expect(data.meta.isSeptemberMonthToDate).toBe(true);
  });

  it("fills zero weeks/months and marks only boundary periods partial", () => {
    const data = result();
    expect(data.monthly.map((row) => row.key)).toEqual([
      "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
    ]);
    expect(data.monthly.find((row) => row.key === "2026-04")?.studentVisits).toBe(0);
    expect(data.monthly.find((row) => row.key === "2026-03")?.isPartial).toBe(false);
    expect(data.monthly.find((row) => row.key === "2026-09")?.isPartial).toBe(true);
    expect(data.weekly.find((row) => row.key === "2026-03-02")?.studentVisits).toBe(1);
    expect(data.weekly[0].isPartial).toBe(true);
  });

  it("computes uniqueness independently within each aggregate grain", () => {
    const data = result();
    expect(data.summary.uniqueStudents).toBe(1);
    expect(data.monthly.find((row) => row.key === "2026-03")?.uniqueStudents).toBe(1);
    expect(data.weekly.filter((row) => row.studentVisits > 0).slice(0, 2).map((row) => row.uniqueStudents)).toEqual([1, 1]);
  });

  it("applies room and weekday filters and retains zero-value active rooms", () => {
    const data = result({ filters: { startDate: "2026-03-01", endDate: "2026-09-30", rooms: ["Focus"], weekdays: [1] } });
    expect(data.summary.studentVisits).toBe(2);
    expect(data.byRoom).toHaveLength(1);
    expect(data.byRoom[0].label).toBe("Focus");
    const allRooms = result().byRoom;
    expect(allRooms.find((row) => row.label === "Never Used")?.studentVisits).toBe(0);
  });

  it("returns an explicit empty state when no successful coverage exists", () => {
    const data = result({ coverageStartDate: null, coverageEndDate: null, dataAsOf: null });
    expect(data.summary.studentVisits).toBe(0);
    expect(data.weekly).toEqual([]);
    expect(data.meta.coverageEndDate).toBeNull();
  });
});
