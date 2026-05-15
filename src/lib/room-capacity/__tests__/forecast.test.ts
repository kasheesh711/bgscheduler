import { describe, expect, it } from "vitest";
import type { SearchIndex } from "@/lib/search/index";
import { expandDemandForMonth, simulateSaturation } from "../forecast";
import type { RoomCapacityDemandMixRow, RoomCapacityForecastDriver, RoomCapacityRoom } from "../types";

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
      builtAt: new Date("2026-05-15T00:00:00.000Z"),
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
});
