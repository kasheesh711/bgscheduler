import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => "db") }));
vi.mock("@/lib/home/summary", () => ({ getHomeSummaryPayload: vi.fn() }));

import { auth } from "@/lib/auth";
import { getHomeSummaryPayload } from "@/lib/home/summary";
import { GET } from "@/app/api/home/summary/route";

const authMock = auth as unknown as Mock;

describe("GET /api/home/summary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: { email: "admin@example.com", allowedPages: ["/progress-tests", "/student-promotions"] },
    });
    vi.mocked(getHomeSummaryPayload).mockResolvedValue({
      generatedAt: "2026-06-05T09:00:00.000Z",
      actions: [],
      freshness: {
        status: "ok",
        checkedAt: "2026-06-05T09:00:00.000Z",
        overallStatus: "healthy",
        overallHeadline: "Healthy",
        staleAgeMs: 0,
        staleMinutes: 0,
        wiseSnapshotLastSuccess: "2026-06-05T09:00:00.000Z",
        cronCounts: { healthy: 1, late: 0, failing: 0, running: 0, manualOnly: 0, unknown: 0 },
        googleSheets: { connected: true, writeConnected: true, email: "admin@example.com", lastError: null },
        error: null,
      },
    });
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("passes session access into the summary payload", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(getHomeSummaryPayload).toHaveBeenCalledWith({
      allowedPages: ["/progress-tests", "/student-promotions"],
      email: "admin@example.com",
    }, "db");
  });

  it("returns 500 JSON when summary aggregation fails", async () => {
    vi.mocked(getHomeSummaryPayload).mockRejectedValue(new Error("summary failed") as never);

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "summary failed" });
  });
});
