import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sync/run-wise-sync", () => ({
  runWiseSyncRequest: vi.fn(),
}));

import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";
import { ensureFreshWiseSyncForClassroomAutomation } from "../morning-automation";

function syncRow(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "sync-1",
    status: overrides.status ?? "success",
    startedAt: overrides.startedAt ?? new Date("2026-05-25T23:30:00.000Z"),
    finishedAt: overrides.finishedAt ?? new Date("2026-05-25T23:40:00.000Z"),
  };
}

function makeDbSelect(responses: unknown[][]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(responses.shift() ?? []),
          })),
        })),
      })),
    })),
  };
}

describe("ensureFreshWiseSyncForClassroomAutomation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reuses a fresh successful Wise sync", async () => {
    const db = makeDbSelect([
      [syncRow({ id: "fresh-sync", finishedAt: new Date("2026-05-25T23:43:00.000Z") })],
    ]);

    const result = await ensureFreshWiseSyncForClassroomAutomation(db as never, {
      now: new Date("2026-05-25T23:45:00.000Z"),
      maxWaitMs: 0,
    });

    expect(result).toEqual({
      mode: "reused",
      syncRunId: "fresh-sync",
      finishedAt: "2026-05-25T23:43:00.000Z",
    });
    expect(runWiseSyncRequest).not.toHaveBeenCalled();
  });

  it("triggers a Wise sync when no fresh sync exists", async () => {
    const freshFinishedAt = new Date();
    const db = makeDbSelect([
      [syncRow({ id: "stale-sync", finishedAt: new Date("2026-05-25T23:00:00.000Z") })],
      [],
      [syncRow({ id: "triggered-sync", finishedAt: freshFinishedAt })],
    ]);
    vi.mocked(runWiseSyncRequest).mockResolvedValue(Response.json({
      success: true,
      syncRunId: "triggered-sync",
    }) as never);

    const result = await ensureFreshWiseSyncForClassroomAutomation(db as never, {
      now: new Date("2026-05-25T23:45:00.000Z"),
      maxWaitMs: 0,
    });

    expect(result).toEqual({
      mode: "triggered",
      syncRunId: "triggered-sync",
      finishedAt: freshFinishedAt.toISOString(),
    });
    expect(runWiseSyncRequest).toHaveBeenCalledTimes(1);
  });
});
