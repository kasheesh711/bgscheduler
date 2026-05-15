import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/room-capacity/data", () => ({
  getRoomCapacityMonth: vi.fn(),
  getRoomCapacityForecast: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getRoomCapacityForecast, getRoomCapacityMonth } from "@/lib/room-capacity/data";
import { GET as getForecast } from "../forecast/route";
import { GET as getMonth } from "../month/route";

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
  monthlyDrivers: [],
};

describe("room capacity API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" } });
    vi.mocked(getDb).mockReturnValue({ db: true } as never);
    vi.mocked(getRoomCapacityMonth).mockResolvedValue(monthResponse as never);
    vi.mocked(getRoomCapacityForecast).mockResolvedValue(forecastResponse as never);
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
    await expect(res.json()).resolves.toMatchObject({ scenario: "Base", model: { status: "ready" } });
  });

  it("returns a missing forecast response before aggregate tables exist", async () => {
    vi.mocked(getRoomCapacityForecast).mockRejectedValue(new Error('relation "room_capacity_model_runs" does not exist') as never);

    const res = await getForecast(new NextRequest("http://test.local/api/room-capacity/forecast?scenario=Bull"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ scenario: "Bull", model: { status: "missing" }, monthlyDrivers: [] });
    expect(body.weekdayResults).toHaveLength(7);
  });
});
