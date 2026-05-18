import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/room-capacity/data", () => ({
  getRoomCapacityMonth: vi.fn(),
  getRoomCapacityForecast: vi.fn(),
}));
vi.mock("@/lib/room-capacity/utilization", () => ({
  getRoomUtilization: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getRoomCapacityForecast, getRoomCapacityMonth } from "@/lib/room-capacity/data";
import { getRoomUtilization } from "@/lib/room-capacity/utilization";
import { GET as getForecast } from "../forecast/route";
import { GET as getMonth } from "../month/route";
import { GET as getUtilization } from "../utilization/route";

const authMock = auth as unknown as Mock;

const monthResponse = {
  range: { startDate: "2026-05-15", endDate: "2026-05-31", generatedAt: "2026-05-15T00:00:00.000Z" },
  snapshotMeta: { snapshotId: "snapshot-1", syncedAt: "2026-05-15T00:00:00.000Z" },
  rooms: [],
  kpis: {
    currentOvercapIntervals: 0,
    impactedRooms: 0,
    projectedNoRoomSessions: 0,
    unmatchedCurrentAllocations: 0,
    peakLoadRatio: 0,
  },
  current: { overcaps: [], unmatchedAllocations: [], heatmapCells: [], daySummaries: [] },
  projected: { overcaps: [], noRoomRows: [], heatmapCells: [], daySummaries: [] },
};

const forecastResponse = {
  model: {
    status: "ready",
    modelRunId: "model-1",
    sourceLabel: "Projection",
    forecastStart: "2026-06-01",
    forecastEnd: "2027-05-01",
    importedAt: "2026-05-15T00:00:00.000Z",
  },
  scenario: "Base",
  scenarios: ["Base"],
  generatedAt: "2026-05-15T00:00:00.000Z",
  weekdayResults: [],
  weekendDemandBreakpoint: {
    preferenceSource: "current_wise_schedule",
    policy: "preferred_slot_only",
    openHours: { startMinute: 420, endMinute: 1260 },
    weekendDemandShare: 0.4,
    combined: {
      breakpointMonth: "2026-09-01",
      status: "reached",
      capturedRevenueThb: 100_000,
      lostRevenueThb: 120_000,
      lostRevenuePct: 0.545,
      capturedStudents: 10,
      lostStudents: 12,
      remainingOpenCapacityMinutes: 3000,
      topLostPreferredSlots: [],
      topOpenNonCapturedSlots: [],
    },
    byDay: [],
  },
  weekendDemandCaptureReadiness: {
    ready: true,
    reasonCodes: [],
    packageMixRows: 12,
    scenarioDriverRows: 12,
    activePhysicalRooms: 24,
    seedSessionRows: 500,
    weekendOnsiteSessionRows: 200,
    weekendPreferenceBuckets: 20,
    weekendDemandShare: 0.42,
    generatedAt: "2026-05-15T00:00:00.000Z",
  },
  monthlyDrivers: [],
};

const utilizationResponse = {
  range: {
    startDate: "2026-03-01",
    endDate: "2026-05-18",
    generatedAt: "2026-05-18T00:00:00.000Z",
    openStartMinute: 420,
    openEndMinute: 1260,
  },
  lastSyncedAt: "2026-05-18T00:00:00.000Z",
  summary: {
    activeRoomCount: 24,
    occupiedMinutes: 12_000,
    availableMinutes: 48_000,
    utilizationPct: 25,
    sessionCount: 200,
  },
  daily: [],
  monthly: [],
  rooms: [],
  dataQuality: {
    missingLocationCount: 1,
    missingLocationMinutes: 60,
    unknownRoomCount: 1,
    unknownRoomMinutes: 60,
    excludedStatusCount: 2,
    excludedStatusMinutes: 120,
    overlapMinutes: 30,
  },
};

describe("room capacity API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" } });
    vi.mocked(getDb).mockReturnValue({ db: true } as never);
    vi.mocked(getRoomCapacityMonth).mockResolvedValue(monthResponse as never);
    vi.mocked(getRoomCapacityForecast).mockResolvedValue(forecastResponse as never);
    vi.mocked(getRoomUtilization).mockResolvedValue(utilizationResponse as never);
  });

  it("requires auth for the month endpoint", async () => {
    authMock.mockResolvedValue(null);

    const res = await getMonth(new NextRequest("http://test.local/api/room-capacity/month"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("uses service defaults for today-through-month-end without persisting runs", async () => {
    const res = await getMonth(new NextRequest("http://test.local/api/room-capacity/month"));

    expect(res.status).toBe(200);
    expect(getRoomCapacityMonth).toHaveBeenCalledWith({ db: true }, { startDate: null, endDate: null });
    await expect(res.json()).resolves.toMatchObject({ range: { startDate: "2026-05-15", endDate: "2026-05-31" } });
  });

  it("passes explicit month date range query parameters", async () => {
    const res = await getMonth(
      new NextRequest("http://test.local/api/room-capacity/month?startDate=2026-05-20&endDate=2026-05-31"),
    );

    expect(res.status).toBe(200);
    expect(getRoomCapacityMonth).toHaveBeenCalledWith(
      { db: true },
      { startDate: "2026-05-20", endDate: "2026-05-31" },
    );
  });

  it("defaults forecast scenario to Base", async () => {
    const res = await getForecast(new NextRequest("http://test.local/api/room-capacity/forecast"));

    expect(res.status).toBe(200);
    expect(getRoomCapacityForecast).toHaveBeenCalledWith({ db: true }, { scenario: "Base" });
    await expect(res.json()).resolves.toMatchObject({
      scenario: "Base",
      model: { status: "ready" },
      weekendDemandBreakpoint: { combined: { breakpointMonth: "2026-09-01" } },
      weekendDemandCaptureReadiness: { ready: true, packageMixRows: 12 },
    });
  });

  it("returns a missing forecast response before aggregate tables exist", async () => {
    vi.mocked(getRoomCapacityForecast).mockRejectedValue(new Error('relation "room_capacity_model_runs" does not exist') as never);

    const res = await getForecast(new NextRequest("http://test.local/api/room-capacity/forecast?scenario=Bull"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      scenario: "Bull",
      model: { status: "missing" },
      weekendDemandBreakpoint: null,
      weekendDemandCaptureReadiness: null,
      monthlyDrivers: [],
    });
    expect(body.weekdayResults).toHaveLength(7);
  });

  it("requires auth for utilization", async () => {
    authMock.mockResolvedValue(null);

    const res = await getUtilization(new NextRequest("http://test.local/api/room-capacity/utilization"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("uses utilization defaults when no date range is provided", async () => {
    const res = await getUtilization(new NextRequest("http://test.local/api/room-capacity/utilization"));

    expect(res.status).toBe(200);
    expect(getRoomUtilization).toHaveBeenCalledWith({ db: true }, { startDate: null, endDate: null });
    await expect(res.json()).resolves.toMatchObject({
      summary: { utilizationPct: 25, activeRoomCount: 24 },
      dataQuality: { missingLocationCount: 1, overlapMinutes: 30 },
    });
  });

  it("passes explicit utilization date range query parameters", async () => {
    const res = await getUtilization(
      new NextRequest("http://test.local/api/room-capacity/utilization?startDate=2026-03-01&endDate=2026-03-31"),
    );

    expect(res.status).toBe(200);
    expect(getRoomUtilization).toHaveBeenCalledWith(
      { db: true },
      { startDate: "2026-03-01", endDate: "2026-03-31" },
    );
  });

  it("returns 400 for invalid utilization ranges", async () => {
    vi.mocked(getRoomUtilization).mockRejectedValue(new Error("Invalid date range. startDate must be before or equal to endDate.") as never);

    const res = await getUtilization(
      new NextRequest("http://test.local/api/room-capacity/utilization?startDate=2026-05-01&endDate=2026-03-01"),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Invalid date range. startDate must be before or equal to endDate.",
    });
  });
});
