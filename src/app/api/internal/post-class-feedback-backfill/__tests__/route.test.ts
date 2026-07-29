import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/data-health/cron-audit", () => ({
  withCronInvocationAudit: vi.fn(
    async (_input: unknown, operation: () => Promise<Response>) => operation(),
  ),
}));
vi.mock("@/lib/internal/cron-auth", () => ({
  rejectInvalidCronSecret: vi.fn(() => null),
}));
vi.mock("@/lib/post-class-feedback/backfill-job", () => ({
  runPostClassBackfillJob: vi.fn(),
}));
vi.mock("@/lib/post-class-feedback/backfill-window", () => ({
  findOldestUnreconciledBackfillWindow: vi.fn(),
}));
vi.mock("@/lib/post-class-feedback/repository", () => ({
  PostClassFeedbackSyncAlreadyRunningError:
    class PostClassFeedbackSyncAlreadyRunningError extends Error {},
}));

import { runPostClassBackfillJob } from "@/lib/post-class-feedback/backfill-job";
import { findOldestUnreconciledBackfillWindow } from "@/lib/post-class-feedback/backfill-window";
import { GET } from "../route";

function request(query = ""): NextRequest {
  return new NextRequest(
    `http://test.local/api/internal/post-class-feedback-backfill${query}`,
    { method: "GET" },
  );
}

describe("GET /api/internal/post-class-feedback-backfill", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findOldestUnreconciledBackfillWindow).mockResolvedValue({
      startDate: "2026-07-01",
      endDate: "2026-07-07",
    });
    vi.mocked(runPostClassBackfillJob).mockResolvedValue({
      status: "success",
    } as never);
  });

  it("caps the scheduled rolling backfill at 50 detail calls per batch", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(runPostClassBackfillJob).toHaveBeenCalledWith({
      startDate: "2026-07-01",
      endDate: "2026-07-07",
      detailCap: 50,
      maxBatches: 1,
    });
  });

  it("keeps an explicit bounded detail cap for a targeted recovery pass", async () => {
    const response = await GET(request(
      "?startDate=2026-06-01&endDate=2026-06-30&detailCap=300&maxBatches=2",
    ));

    expect(response.status).toBe(200);
    expect(runPostClassBackfillJob).toHaveBeenCalledWith({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      detailCap: 300,
      maxBatches: 2,
    });
  });
});
