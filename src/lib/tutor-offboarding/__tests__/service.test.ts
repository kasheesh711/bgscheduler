import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../signals", () => ({ loadOffboardingSignals: vi.fn(), loadFeedTimestamps: vi.fn() }));
vi.mock("../decisions", () => ({ listDecisions: vi.fn() }));
vi.mock("../grants", () => ({ listGrants: vi.fn() }));
vi.mock("../termination-sync", () => ({ loadTerminationSnapshot: vi.fn() }));

import { loadFeedTimestamps, loadOffboardingSignals } from "../signals";
import { listDecisions } from "../decisions";
import { listGrants } from "../grants";
import { loadTerminationSnapshot } from "../termination-sync";
import { loadTutorOffboardingDashboard } from "../service";
import type { OffboardingSignals } from "../types";

const viewer = { email: "admin@example.com", isOwner: false, canRemove: false };
const NOW = "2026-10-01T05:00:00.000Z";
function signals(at = NOW): OffboardingSignals {
  return { snapshotId: "snap", snapshotCreatedAt: at, generatedAt: NOW, people: [], taughtDates: {} };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadOffboardingSignals).mockResolvedValue(signals());
  vi.mocked(loadFeedTimestamps).mockResolvedValue({ tutorSnapshot: NOW, progressTests: NOW, postClass: NOW, wiseActivity: NOW, leaveRequests: NOW });
  vi.mocked(listDecisions).mockResolvedValue([]);
  vi.mocked(listGrants).mockResolvedValue([]);
  vi.mocked(loadTerminationSnapshot).mockResolvedValue({ rows: [], checkedAt: null, lastError: null });
});

describe("loadTutorOffboardingDashboard", () => {
  it("returns typed unavailability when any migration column is missing", async () => {
    vi.mocked(loadTerminationSnapshot).mockRejectedValue({ cause: { code: "42703" } });
    expect(await loadTutorOffboardingDashboard(viewer)).toEqual({ available: false, reason: "not_set_up", viewer });
  });

  it("passes abandoned-render signals through source error handling", async () => {
    const error = { digest: "HANGING_PROMISE_REJECTION" };
    vi.mocked(loadTerminationSnapshot).mockRejectedValue(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loadTutorOffboardingDashboard(viewer)).rejects.toBe(error);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("reports a source read failure visibly while preserving the dashboard", async () => {
    vi.mocked(loadTerminationSnapshot).mockRejectedValue(new Error("private query with note"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await loadTutorOffboardingDashboard(viewer);
    expect(result).toMatchObject({ available: true, terminationSource: { status: "error" } });
    expect(log).toHaveBeenCalledWith("[tutor-offboarding:termination-source]", { errorName: "Error", sqlState: null });
    log.mockRestore();
  });

  it("reloads cached signals when their snapshot timestamp differs from the fresh snapshot", async () => {
    vi.mocked(loadOffboardingSignals).mockResolvedValueOnce(signals("2026-10-01T04:30:00.000Z")).mockResolvedValueOnce(signals());
    const result = await loadTutorOffboardingDashboard(viewer);
    expect(loadOffboardingSignals).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ available: true, snapshotCreatedAt: NOW });
  });

  it("rechecks a cached empty result once an active snapshot exists", async () => {
    vi.mocked(loadOffboardingSignals).mockResolvedValueOnce(null).mockResolvedValueOnce(signals());
    expect(await loadTutorOffboardingDashboard(viewer)).toMatchObject({ available: true });
    expect(loadOffboardingSignals).toHaveBeenCalledTimes(2);
  });

  it("reads grants only for owners", async () => {
    await loadTutorOffboardingDashboard(viewer);
    expect(listGrants).not.toHaveBeenCalled();
    await loadTutorOffboardingDashboard({ ...viewer, isOwner: true });
    expect(listGrants).toHaveBeenCalledTimes(1);
  });

  it("returns no_snapshot for an empty active roster snapshot", async () => {
    vi.mocked(loadOffboardingSignals).mockResolvedValue(null);
    expect(await loadTutorOffboardingDashboard(viewer)).toEqual({ available: false, reason: "no_snapshot", viewer });
  });
});
