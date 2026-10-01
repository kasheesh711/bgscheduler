import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ limit: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }),
  }),
}));
vi.mock("../analytics-db", () => ({ loadAnalyticsEvidence: vi.fn() }));
vi.mock("../signals", () => ({ loadFeedTimestamps: vi.fn() }));
vi.mock("../decisions", () => ({ listDecisions: vi.fn() }));
vi.mock("../termination-sync", () => ({ loadTerminationSnapshot: vi.fn() }));
import { loadAnalyticsEvidence } from "../analytics-db";
import { loadFeedTimestamps } from "../signals";
import { listDecisions } from "../decisions";
import { loadTerminationSnapshot } from "../termination-sync";
import { loadTutorOffboardingAnalytics } from "../analytics-service";
import { compileAnalyticsEvidence } from "../analytics";
const NOW = "2026-10-01T05:00:00.000Z";
function evidence(id = "snap", at = NOW) {
  return compileAnalyticsEvidence({
    signals: {
      snapshotId: id,
      snapshotCreatedAt: at,
      generatedAt: NOW,
      people: [],
      taughtDates: {},
    },
    catalog: [],
    qualifications: [],
    history: [],
    upcoming: [],
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.limit.mockResolvedValue([{ id: "snap", at: new Date(NOW) }]);
  vi.mocked(loadAnalyticsEvidence).mockResolvedValue(evidence());
  vi.mocked(loadFeedTimestamps).mockResolvedValue({
    tutorSnapshot: NOW,
    progressTests: NOW,
    postClass: NOW,
    wiseActivity: NOW,
    leaveRequests: NOW,
  });
  vi.mocked(listDecisions).mockResolvedValue([]);
  vi.mocked(loadTerminationSnapshot).mockResolvedValue({
    rows: [],
    checkedAt: null,
    lastError: null,
  });
});
describe("analytics report service", () => {
  it("returns no_snapshot without an active snapshot", async () => {
    mocks.limit.mockResolvedValueOnce([]);
    expect(await loadTutorOffboardingAnalytics()).toEqual({
      available: false,
      reason: "no_snapshot",
    });
    expect(loadAnalyticsEvidence).not.toHaveBeenCalled();
  });
  it("returns typed migration unavailability using nested SQLSTATE", async () => {
    vi.mocked(loadTerminationSnapshot).mockRejectedValue({
      cause: { code: "42703" },
    });
    expect(await loadTutorOffboardingAnalytics()).toEqual({
      available: false,
      reason: "not_set_up",
    });
  });
  it("exposes source errors without leaking the raw error", async () => {
    vi.mocked(loadTerminationSnapshot).mockRejectedValue(
      new Error("private SQL params"),
    );
    const report = await loadTutorOffboardingAnalytics();
    expect(report).toMatchObject({
      available: true,
      terminationSource: { status: "error" },
    });
    expect(JSON.stringify(report)).not.toContain("private SQL params");
  });
  it("retries once when the snapshot rotates during compilation", async () => {
    const old = "2026-10-01T04:30:00.000Z";
    mocks.limit
      .mockResolvedValueOnce([{ id: "old" }])
      .mockResolvedValueOnce([{ id: "snap", at: new Date(NOW) }]);
    vi.mocked(loadAnalyticsEvidence).mockResolvedValueOnce(
      evidence("old", old),
    );
    vi.mocked(loadFeedTimestamps).mockResolvedValueOnce({
      tutorSnapshot: old,
      progressTests: NOW,
      postClass: NOW,
      wiseActivity: NOW,
      leaveRequests: NOW,
    });
    expect(await loadTutorOffboardingAnalytics()).toMatchObject({
      available: true,
      snapshotCreatedAt: NOW,
    });
    expect(loadAnalyticsEvidence).toHaveBeenCalledTimes(2);
  });
  it("returns load_failed after repeated inconsistent reads", async () => {
    vi.mocked(loadAnalyticsEvidence).mockResolvedValue(null);
    expect(await loadTutorOffboardingAnalytics()).toEqual({
      available: false,
      reason: "load_failed",
    });
    expect(loadAnalyticsEvidence).toHaveBeenCalledTimes(2);
  });
  it("fails closed if the active snapshot disappears after cached compilation", async () => {
    mocks.limit
      .mockResolvedValueOnce([{ id: "snap" }])
      .mockResolvedValueOnce([]);
    expect(await loadTutorOffboardingAnalytics()).toEqual({
      available: false,
      reason: "no_snapshot",
    });
  });
  it("passes framework abandoned-render signals through without logging them", async () => {
    const abandoned = { digest: "HANGING_PROMISE_REJECTION" };
    vi.mocked(loadTerminationSnapshot).mockRejectedValue(abandoned);
    await expect(loadTutorOffboardingAnalytics()).rejects.toBe(abandoned);
  });
});
