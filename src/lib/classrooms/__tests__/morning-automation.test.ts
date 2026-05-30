import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sync/run-wise-sync", () => ({
  runWiseSyncRequest: vi.fn(),
}));

vi.mock("@/lib/wise/client", () => ({
  createWiseClient: vi.fn(() => ({ wise: true })),
}));

vi.mock("@/lib/wise/fetchers", () => ({
  fetchAllFutureSessions: vi.fn(),
}));

vi.mock("../data", () => ({
  CLASSROOM_ASSIGNMENT_FRESHNESS_MS: 15 * 60 * 1000,
  publishClassroomAssignmentRun: vi.fn(),
  runIncrementalClassroomAssignment: vi.fn(),
  selectAutomationPublishTargetRowIds: vi.fn(),
}));

vi.mock("../schedule-email", () => ({
  sendScheduleEmailsForRun: vi.fn(),
}));

import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";
import { createWiseClient } from "@/lib/wise/client";
import { fetchAllFutureSessions } from "@/lib/wise/fetchers";
import {
  publishClassroomAssignmentRun,
  runIncrementalClassroomAssignment,
  selectAutomationPublishTargetRowIds,
} from "../data";
import { sendScheduleEmailsForRun } from "../schedule-email";
import {
  ensureFreshWiseSyncForClassroomAutomation,
  runClassroomMorningAutomation,
} from "../morning-automation";

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

function assignmentDetail(date: string) {
  return {
    run: { id: `run-${date}`, assignmentDate: date },
    rows: [
      {
        id: `row-${date}`,
        changeType: "changed",
      },
    ],
    events: [{ id: `event-${date}` }],
  };
}

function mockMorningDependencies() {
  vi.mocked(createWiseClient).mockReturnValue({ wise: true } as never);
  vi.mocked(fetchAllFutureSessions).mockResolvedValue([] as never);
  vi.mocked(runIncrementalClassroomAssignment).mockImplementation(async (_db, input) =>
    assignmentDetail(input.date) as never
  );
  vi.mocked(selectAutomationPublishTargetRowIds).mockResolvedValue(["row-1"] as never);
  vi.mocked(publishClassroomAssignmentRun).mockResolvedValue({
    summary: { attempted: 1, success: 1, skipped: 0, failed: 0 },
  } as never);
  vi.mocked(sendScheduleEmailsForRun).mockResolvedValue({
    summary: { attempted: 2, success: 2, failed: 0, blocked: 0 },
    recipients: [],
    preview: {},
  } as never);
}

describe("runClassroomMorningAutomation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockMorningDependencies();
  });

  it("sends tutor schedule emails for today only after publishing today's assignments", async () => {
    const db = makeDbSelect([
      [syncRow({ id: "fresh-sync", finishedAt: new Date() })],
    ]);

    const result = await runClassroomMorningAutomation(db as never, {
      startDate: "2026-05-26",
      automationBatchId: "batch-1",
      liveSessions: [],
    });

    expect(runIncrementalClassroomAssignment).toHaveBeenCalledTimes(7);
    expect(publishClassroomAssignmentRun).toHaveBeenCalledTimes(7);
    expect(sendScheduleEmailsForRun).toHaveBeenCalledTimes(1);
    expect(sendScheduleEmailsForRun).toHaveBeenCalledWith(
      db,
      "run-2026-05-26",
      "cron@classroom-schedule-email",
      undefined,
      { mode: "failed_only" },
    );
    expect(vi.mocked(publishClassroomAssignmentRun).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(sendScheduleEmailsForRun).mock.invocationCallOrder[0]);
    expect(result.dates[0].scheduleEmail).toEqual({
      summary: { attempted: 2, success: 2, failed: 0, blocked: 0 },
    });
    expect(result.dates.slice(1).every((dateResult) => dateResult.scheduleEmail === undefined)).toBe(true);
  });

  it("captures tutor schedule email errors without failing assignment automation", async () => {
    const db = makeDbSelect([
      [syncRow({ id: "fresh-sync", finishedAt: new Date() })],
    ]);
    vi.mocked(sendScheduleEmailsForRun).mockRejectedValue(new Error("Apps Script unavailable"));

    const result = await runClassroomMorningAutomation(db as never, {
      startDate: "2026-05-26",
      automationBatchId: "batch-1",
      liveSessions: [],
    });

    expect(result.ok).toBe(true);
    expect(result.dates).toHaveLength(7);
    expect(result.dates[0].scheduleEmail).toBeUndefined();
    expect(result.dates[0].scheduleEmailError).toBe("Apps Script unavailable");
    expect(result.dates[0].publishSummary).toEqual({ attempted: 1, success: 1, skipped: 0, failed: 0 });
  });
});
