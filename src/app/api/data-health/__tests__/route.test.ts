import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/data-health/dashboard", () => ({ getDataHealthDashboardPayload: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDataHealthDashboardPayload } from "@/lib/data-health/dashboard";
import { GET } from "@/app/api/data-health/route";

const authMock = auth as unknown as Mock;

const payload = {
  checkedAt: "2026-06-01T00:00:00.000Z",
  overall: {
    status: "healthy",
    headline: "Operations are healthy",
    detail: "All good",
    healthyCount: 7,
    lateCount: 0,
    failingCount: 0,
    runningCount: 0,
    unknownCount: 0,
    manualOnlyCount: 1,
  },
  cronJobs: [],
  dataDomains: [],
  wiseSnapshot: {
    activeSnapshotId: "snap-1",
    lastSuccessfulSync: "2026-06-01T00:00:00.000Z",
    lastFailedSync: null,
    lastFailureError: null,
    staleAgeMs: 0,
    staleMinutes: 0,
    stats: null,
  },
  issueSummary: {},
  issueDetails: {
    unresolvedAliases: [],
    unresolvedModality: [],
    unmappedTags: [],
  },
  recentRuns: [],
  manualActions: [],
  lastSuccessfulSync: "2026-06-01T00:00:00.000Z",
  lastFailedSync: null,
  lastFailureError: null,
  staleAgeMs: 0,
  staleMinutes: 0,
  activeSnapshotId: "snap-1",
  stats: null,
  issuesByType: {},
  unresolvedAliases: [],
  unresolvedModality: [],
  unmappedTags: [],
  recentSyncs: [],
};

describe("GET /api/data-health", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "kevhsh7@gmail.com" } });
    vi.mocked(getDataHealthDashboardPayload).mockResolvedValue(payload as never);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns the v2 dashboard response while preserving stale-banner fields", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      overall: { status: "healthy" },
      wiseSnapshot: { activeSnapshotId: "snap-1" },
      lastSuccessfulSync: "2026-06-01T00:00:00.000Z",
      staleAgeMs: 0,
      recentSyncs: [],
    });
  });

  it("returns 500 JSON when aggregation fails", async () => {
    vi.mocked(getDataHealthDashboardPayload).mockRejectedValue(new Error("DB exploded") as never);

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
  });
});
