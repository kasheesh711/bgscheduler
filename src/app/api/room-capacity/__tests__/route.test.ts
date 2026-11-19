import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/room-capacity/utilization", async () => {
  const actual = await vi.importActual<typeof import("@/lib/room-capacity/utilization")>(
    "@/lib/room-capacity/utilization",
  );
  return {
    ...actual,
    getRoomUtilization: vi.fn(),
  };
});

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getRoomUtilization } from "@/lib/room-capacity/utilization";
import { GET as getUtilization } from "../utilization/route";

const authMock = auth as unknown as Mock;

const utilizationResponse = {
  range: {
    startDate: "2026-03-01",
    endDate: "2026-05-18",
    generatedAt: "2026-05-18T00:00:00.000Z",
    openStartMinute: 420,
    openEndMinute: 1260,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
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
    vi.mocked(getRoomUtilization).mockResolvedValue(utilizationResponse as never);
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
    expect(getRoomUtilization).toHaveBeenCalledWith({ db: true }, { startDate: null, endDate: null, weekdays: undefined });
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
      { startDate: "2026-03-01", endDate: "2026-03-31", weekdays: undefined },
    );
  });

  it("passes utilization weekday filters", async () => {
    const res = await getUtilization(
      new NextRequest("http://test.local/api/room-capacity/utilization?weekdays=mon,wed,6"),
    );

    expect(res.status).toBe(200);
    expect(getRoomUtilization).toHaveBeenCalledWith(
      { db: true },
      { startDate: null, endDate: null, weekdays: [1, 3, 6] },
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

  it("returns 400 for invalid utilization weekdays", async () => {
    const res = await getUtilization(
      new NextRequest("http://test.local/api/room-capacity/utilization?weekdays=mon,funday"),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Invalid weekdays. Expected comma-separated weekday numbers 0-6 or names.",
    });
  });
});
