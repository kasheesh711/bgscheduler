import { describe, expect, it, vi } from "vitest";
import {
  syncWiseBeforeAssignment,
  readAssignmentDetailResponse,
  waitForFreshAssignmentSnapshot,
} from "../sync-flow";
import type { AssignmentDetail, AssignmentSnapshotMeta } from "../types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function assignmentDetail(snapshotMeta: Partial<AssignmentSnapshotMeta>): AssignmentDetail {
  const meta = {
    snapshotId: snapshotMeta.snapshotId ?? "snap-1",
    latestSyncFinishedAt: snapshotMeta.latestSyncFinishedAt ?? "2026-05-25T05:36:16.000Z",
    staleAgeMs: snapshotMeta.staleAgeMs ?? 0,
    fresh: snapshotMeta.fresh ?? true,
    ...(snapshotMeta.syncErrorSummary ? { syncErrorSummary: snapshotMeta.syncErrorSummary } : {}),
  };
  return {
    run: null,
    rows: [],
    rooms: [],
    snapshotMeta: meta,
    activeSnapshotMeta: meta,
    liveRoomBlocks: [],
    roomConflictWarnings: [],
  };
}

describe("class assignment sync flow", () => {
  it("continues from a promoted snapshot even when teacher review issues remain", async () => {
    const errorSummary = "1 Wise teacher contact account needs review; 10 sessions reference teachers absent from the Wise roster";
    const fetcher = vi.fn(async () => jsonResponse({ success: false, outcome: "partial", promotedSnapshotId: "snap-new", errorSummary }));
    const result = await syncWiseBeforeAssignment({ date: "2026-09-09", fetcher });
    expect(result.sync).toMatchObject({ outcome: "partial", errorSummary });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses active snapshot freshness despite an old saved assignment and retains partial-sync warnings", async () => {
    let clock = Date.parse("2026-05-25T05:30:00Z");
    let polls = 0;
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("sync-wise")) return jsonResponse({ outcome: "running", skipped: true, alreadyRunning: true, runningStartedAt: new Date(clock).toISOString() }, 202);
      const detail = assignmentDetail({ fresh: false, snapshotId: "old-saved", latestSyncFinishedAt: "2026-05-25T04:00:00Z" });
      if (++polls > 1) detail.activeSnapshotMeta = { snapshotId: "new-active", fresh: true, staleAgeMs: 0, latestSyncFinishedAt: new Date(clock).toISOString(), syncErrorSummary: "Teacher needs review" };
      return jsonResponse(detail);
    });
    const result = await syncWiseBeforeAssignment({ date: "2026-05-25", fetcher, now: () => clock, sleep: async ms => { clock += ms; } });
    expect(result.latestDetail?.snapshotMeta.snapshotId).toBe("old-saved");
    expect(result.latestDetail?.activeSnapshotMeta).toMatchObject({ snapshotId: "new-active", syncErrorSummary: "Teacher needs review" });
    expect(polls).toBe(2);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("sync-wise"))).toHaveLength(1);
  });

  it.each([
    [{ errorSummary: "Specific sync failure", error: "General error" }, "Specific sync failure"],
    [{ errorSummary: " ", error: "Sign in again" }, "Sign in again"],
    [{ errorSummary: { unexpected: true }, error: ["invalid"] }, "Wise sync failed with HTTP 500"],
  ])("shows the most useful error in a failed response %j", async (body, message) => {
    await expect(syncWiseBeforeAssignment({ date: "2026-09-09", fetcher: async () => jsonResponse(body, 500) })).rejects.toThrow(message);
  });

  it.each(["<html>Gateway failed</html>", "", "null", "[1,2]"])("handles malformed/non-object failure body %j", async body => {
    await expect(syncWiseBeforeAssignment({ date: "2026-09-09", fetcher: async () => new Response(body, { status: 502 }) })).rejects.toThrow("Wise sync failed with HTTP 502");
  });

  it.each([{}, { success: true, promotedSnapshotId: null }, { success: true, promotedSnapshotId: 123 }, { outcome: "failed", promotedSnapshotId: "unexpected" }])("rejects an unproven promotion %j", async body => {
    await expect(syncWiseBeforeAssignment({ date: "2026-09-09", fetcher: async () => jsonResponse(body) })).rejects.toThrow("did not promote a fresh snapshot");
  });

  it("shows a readable error for an invalid assignment/polling payload", async () => {
    await expect(readAssignmentDetailResponse(new Response("<html>Timeout</html>", { status: 504 }))).rejects.toThrow("Unable to load classroom assignments (HTTP 504)");
    const oldServer = assignmentDetail({});
    await expect(readAssignmentDetailResponse(jsonResponse({ ...oldServer, activeSnapshotMeta: undefined }))).rejects.toThrow("Unable to read the current Wise snapshot");
  });

  it("proceeds immediately when Wise sync promotes a snapshot", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      success: true,
      promotedSnapshotId: "snap-new",
    }));

    const result = await syncWiseBeforeAssignment({
      date: "2026-05-25",
      fetcher: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      waitedForRunningSync: false,
      latestDetail: null,
      sync: { promotedSnapshotId: "snap-new" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/sync-wise", { method: "POST" });
  });

  it("waits for an already-running Wise sync to promote a fresh snapshot before continuing", async () => {
    let currentTime = Date.parse("2026-05-25T05:30:00.000Z");
    const messages: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/sync-wise") {
        return jsonResponse({
          success: true,
          skipped: true,
          alreadyRunning: true,
          promotedSnapshotId: null,
          runningStartedAt: "2026-05-25T05:30:33.000Z",
        }, 202);
      }
      return jsonResponse(
        fetchMock.mock.calls.length < 3
          ? assignmentDetail({
            latestSyncFinishedAt: "2026-05-25T05:29:00.000Z",
            fresh: true,
          })
          : assignmentDetail({
            latestSyncFinishedAt: "2026-05-25T05:36:16.000Z",
            fresh: true,
          }),
      );
    });

    const result = await syncWiseBeforeAssignment({
      date: "2026-05-25",
      fetcher: fetchMock as unknown as typeof fetch,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;
      },
      pollIntervalMs: 1_000,
      timeoutMs: 10_000,
      onMessage: (message) => messages.push(message),
    });

    expect(result.waitedForRunningSync).toBe(true);
    expect(result.latestDetail?.snapshotMeta.latestSyncFinishedAt).toBe("2026-05-25T05:36:16.000Z");
    expect(messages).toEqual(["Wise sync already running; waiting for fresh snapshot..."]);
    expect(fetchMock).toHaveBeenCalledWith("/api/class-assignments?date=2026-05-25");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed when a completed sync does not promote a snapshot", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      success: true,
      promotedSnapshotId: null,
      errorSummary: "Too many unresolved identity groups.",
    }));

    await expect(syncWiseBeforeAssignment({
      date: "2026-05-25",
      fetcher: fetchMock as unknown as typeof fetch,
    })).rejects.toThrow("Too many unresolved identity groups.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out when polling never observes a fresh promoted snapshot from the running sync", async () => {
    let currentTime = Date.parse("2026-05-25T05:30:00.000Z");
    const fetchMock = vi.fn(async () => jsonResponse(assignmentDetail({
      latestSyncFinishedAt: "2026-05-25T05:29:00.000Z",
      fresh: true,
    })));

    await expect(waitForFreshAssignmentSnapshot({
      date: "2026-05-25",
      runningStartedAtMs: Date.parse("2026-05-25T05:30:33.000Z"),
      fetcher: fetchMock as unknown as typeof fetch,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;
      },
      pollIntervalMs: 500,
      timeoutMs: 1_000,
    })).rejects.toThrow("Wise sync is still running or did not promote a fresh snapshot within 12 minutes.");

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
