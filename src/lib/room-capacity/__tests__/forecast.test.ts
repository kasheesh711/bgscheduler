import { describe, expect, it } from "vitest";
import type { SearchIndex } from "@/lib/search/index";
import {
  buildWeekendDemandCaptureReadiness,
  expandDemandForMonth,
  expandWeekendDemandForMonth,
  simulateSaturation,
  simulateWeekendDemandBreakpoint,
  weekendPreferenceDistributionFromSchedule,
} from "../forecast";
import type {
  RoomCapacityDemandMixRow,
  RoomCapacityForecastDriver,
  RoomCapacityPackageMixRow,
  RoomCapacityRoom,
  RoomCapacitySession,
} from "../types";

const room: RoomCapacityRoom = {
  id: "room-1",
  name: "Focus",
  capacity: 1,
  hasTv: false,
  category: "standard",
  active: true,
  sortOrder: 1,
};

function driver(overrides: Partial<RoomCapacityForecastDriver> = {}): RoomCapacityForecastDriver {
  return {
    scenario: "Base",
    month: "2026-06-01",
    newPaidStudents: 1,
    forecastConsumedHours: 1,
    scheduledHours: 0,
    capacityUtilizationPct: 0,
    capacityExceeded: false,
    projectedRevenueThb: 0,
    ...overrides,
  };
}

function mix(overrides: Partial<RoomCapacityDemandMixRow> = {}): RoomCapacityDemandMixRow {
  return {
    weekday: 1,
    startMinute: 9 * 60,
    durationMinutes: 60,
    mode: "onsite",
    studentCount: 1,
    subject: "Math",
    classType: "ONE_TO_ONE",
    share: 1,
    observedSessions: 1,
    ...overrides,
  };
}

function packageMix(overrides: Partial<RoomCapacityPackageMixRow> = {}): RoomCapacityPackageMixRow {
  return {
    packageHourBucket: "1h",
    packageHours: 1,
    averageRevenueThb: 100,
    share: 1,
    observedSaleCount: 1,
    observedStudentCount: 1,
    sourceLabel: "test",
    ...overrides,
  };
}

function session(overrides: Partial<RoomCapacitySession> = {}): RoomCapacitySession {
  return {
    id: "session-1",
    groupId: "group-1",
    tutorDisplayName: "Tutor A",
    wiseTeacherId: "teacher-1",
    wiseTeacherUserId: null,
    wiseSessionId: "wise-session-1",
    wiseClassId: null,
    startTime: new Date("2026-06-06T02:00:00.000Z"),
    endTime: new Date("2026-06-06T03:00:00.000Z"),
    date: "2026-06-06",
    weekday: 6,
    startMinute: 9 * 60,
    endMinute: 10 * 60,
    wiseStatus: "SCHEDULED",
    sessionType: "OFFLINE",
    currentWiseLocation: "Focus",
    studentCount: 1,
    subject: "Math",
    classType: "ONE_TO_ONE",
    title: "Math",
    ...overrides,
  };
}

describe("room capacity forecast simulation", () => {
  it("converts monthly forecast hours into deterministic weekday/time demand buckets", () => {
    const demands = expandDemandForMonth(driver({ forecastConsumedHours: 10 }), [
      mix({ weekday: 1, startMinute: 9 * 60, durationMinutes: 60, share: 0.5 }),
      mix({ weekday: 2, startMinute: 10 * 60, durationMinutes: 120, share: 0.5 }),
    ]);

    expect(demands).toHaveLength(7);
    expect(demands.filter((demand) => demand.weekday === 1)).toHaveLength(5);
    expect(demands.filter((demand) => demand.weekday === 2)).toHaveLength(2);
    expect(demands[0]).toMatchObject({ date: "2026-06-01", weekday: 1, startMinute: 9 * 60 });
  });

  it("marks room-slot saturation when recurring demand can no longer fit room slots", () => {
    const results = simulateSaturation({
      rooms: [room],
      seedSessions: [],
      demandMix: [mix()],
      drivers: [driver({ forecastConsumedHours: 6 })],
      searchIndex: null,
    });

    const monday = results.find((result) => result.weekday === 1);
    expect(monday).toMatchObject({
      roomSlotFullDate: "2026-06-01",
      roomSlotReason: "1-student onsite class at 540",
    });
  });

  it("marks room+tutor saturation when no strict qualified tutor is available", () => {
    const emptyIndex: SearchIndex = {
      snapshotId: "snapshot-1",
      profileVersion: "0:",
      builtAt: new Date("2026-05-15T00:00:00.000Z"),
      syncedAt: new Date("2026-05-15T00:00:00.000Z"),
      tutorGroups: [],
      byWeekday: new Map(),
    };

    const results = simulateSaturation({
      rooms: [room],
      seedSessions: [],
      demandMix: [mix()],
      drivers: [driver({ forecastConsumedHours: 1 })],
      searchIndex: emptyIndex,
    });

    const monday = results.find((result) => result.weekday === 1);
    expect(monday).toMatchObject({
      roomSlotFullDate: null,
      roomTutorFullDate: "2026-06-01",
      roomTutorReason: "No qualified available tutor",
    });
  });

  it("builds weekend preference distribution from student-hour weighted Wise schedule", () => {
    const { preferenceMix, weekendDemandShare } = weekendPreferenceDistributionFromSchedule([
      session({ id: "sat", weekday: 6, studentCount: 2 }),
      session({ id: "sun", date: "2026-06-07", weekday: 0, startMinute: 10 * 60, endMinute: 11 * 60, studentCount: 1 }),
      session({ id: "mon", date: "2026-06-08", weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60, studentCount: 1 }),
    ], [room]);

    expect(weekendDemandShare).toBeCloseTo(0.75);
    expect(preferenceMix).toHaveLength(2);
    expect(preferenceMix[0]).toMatchObject({ weekday: 6, startMinute: 9 * 60, share: expect.closeTo(2 / 3) });
    expect(preferenceMix[1]).toMatchObject({ weekday: 0, startMinute: 10 * 60, share: expect.closeTo(1 / 3) });
  });

  it("reports weekend demand capture readiness when all inputs are present", () => {
    const readiness = buildWeekendDemandCaptureReadiness({
      rooms: [room],
      seedSessions: [session()],
      packageMix: [packageMix()],
      drivers: [driver()],
    });

    expect(readiness).toMatchObject({
      ready: true,
      reasonCodes: [],
      packageMixRows: 1,
      scenarioDriverRows: 1,
      activePhysicalRooms: 1,
      seedSessionRows: 1,
      weekendOnsiteSessionRows: 1,
      weekendPreferenceBuckets: 1,
      weekendDemandShare: 1,
    });
  });

  it("reports missing package mix readiness", () => {
    const readiness = buildWeekendDemandCaptureReadiness({
      rooms: [room],
      seedSessions: [session()],
      packageMix: [],
      drivers: [driver()],
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.reasonCodes).toContain("missing_package_mix");
  });

  it("reports missing scenario driver readiness", () => {
    const readiness = buildWeekendDemandCaptureReadiness({
      rooms: [room],
      seedSessions: [session()],
      packageMix: [packageMix()],
      drivers: [],
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.reasonCodes).toContain("missing_scenario_drivers");
  });

  it("reports no active physical room readiness", () => {
    const readiness = buildWeekendDemandCaptureReadiness({
      rooms: [{ ...room, active: false }],
      seedSessions: [session()],
      packageMix: [packageMix()],
      drivers: [driver()],
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.reasonCodes).toContain("no_active_physical_rooms");
  });

  it("reports missing weekend onsite schedule readiness", () => {
    const readiness = buildWeekendDemandCaptureReadiness({
      rooms: [room],
      seedSessions: [session({ weekday: 1, date: "2026-06-08" })],
      packageMix: [packageMix()],
      drivers: [driver()],
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.reasonCodes).toContain("no_weekend_onsite_schedule");
    expect(readiness.weekendPreferenceBuckets).toBe(0);
  });

  it("expands new paid students into deterministic package and preferred-slot demand", () => {
    const demands = expandWeekendDemandForMonth(
      driver({ newPaidStudents: 10 }),
      [packageMix({ packageHourBucket: "10h", packageHours: 10, share: 0.6 }), packageMix({ packageHourBucket: "30h", packageHours: 30, share: 0.4 })],
      [mix({ weekday: 6, share: 0.5 }), mix({ weekday: 0, startMinute: 10 * 60, share: 0.5 })],
      1,
    );

    expect(demands).toHaveLength(10);
    expect(demands.filter((demand) => demand.packageHourBucket === "10h")).toHaveLength(6);
    expect(demands.filter((demand) => demand.weekday === 6)).toHaveLength(5);
  });

  it("counts a lead as lost when the exact preferred slot is full while other weekend slots are open", () => {
    const result = simulateWeekendDemandBreakpoint({
      rooms: [room],
      seedSessions: [session()],
      packageMix: [packageMix()],
      drivers: [driver({ newPaidStudents: 1 })],
    });

    expect(result?.combined).toMatchObject({
      breakpointMonth: "2026-06-01",
      status: "reached",
      capturedRevenueThb: 0,
      lostRevenueThb: 100,
      capturedStudents: 0,
      lostStudents: 1,
    });
    expect(result?.combined.topLostPreferredSlots[0]).toMatchObject({ weekday: 6, startMinute: 9 * 60 });
    expect(result?.combined.remainingOpenCapacityMinutes).toBeGreaterThan(0);
  });

  it("marks extrapolated breakpoint after imported forecast horizon", () => {
    const result = simulateWeekendDemandBreakpoint({
      rooms: [room],
      seedSessions: [session({ date: "2026-05-16", weekday: 6 })],
      packageMix: [packageMix()],
      drivers: [
        driver({ month: "2026-06-01", newPaidStudents: 3 }),
        driver({ month: "2026-07-01", newPaidStudents: 4 }),
        driver({ month: "2026-08-01", newPaidStudents: 5 }),
      ],
      maxExtrapolatedMonths: 12,
    });

    expect(result?.combined.status).toBe("reached_extrapolated");
    expect(result?.combined.breakpointMonth).toMatch(/^2026-|^2027-/);
  }, 30_000);
});
