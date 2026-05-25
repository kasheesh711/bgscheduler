import { describe, expect, it, vi } from "vitest";
import {
  syncWiseBeforeAssignment,
  waitForFreshAssignmentSnapshot,
} from "../sync-flow";
import type { AssignmentDetail, AssignmentSnapshotMeta } from "../types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function assignmentDetail(snapshotMeta: Partial<AssignmentSnapshotMeta>): AssignmentDetail {
  return {
    run: null,
    rows: [],
    rooms: [],
    snapshotMeta: {
      snapshotId: snapshotMeta.snapshotId ?? "snap-1",
      latestSyncFinishedAt: snapshotMeta.latestSyncFinishedAt ?? "2026-05-25T05:36:16.000Z",
      staleAgeMs: snapshotMeta.staleAgeMs ?? 0,
      fresh: snapshotMeta.fresh ?? true,
    },
    liveRoomBlocks: [],
    roomConflictWarnings: [],
  };
}

describe("class assignment sync flow", () => {
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
