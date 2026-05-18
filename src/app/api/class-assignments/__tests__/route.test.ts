import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/classrooms/data", () => ({
  assertIsoDate: vi.fn((value: string) => {
    if (value === "bad-date") throw new Error("Invalid date. Expected YYYY-MM-DD.");
    return value;
  }),
  StaleClassroomAssignmentSnapshotError: class StaleClassroomAssignmentSnapshotError extends Error {
    code = "STALE_ASSIGNMENT_SNAPSHOT";
    latestSyncFinishedAt: string | null;
    staleAgeMs: number | null;

    constructor(meta: { latestSyncFinishedAt: string | null; staleAgeMs: number | null }) {
      super("Class assignment data is stale");
      this.latestSyncFinishedAt = meta.latestSyncFinishedAt;
      this.staleAgeMs = meta.staleAgeMs;
    }
  },
  createClassroomPublishJob: vi.fn(),
  getClassroomPublishJobProgress: vi.fn(),
  getClassroomAssignmentForDate: vi.fn(),
  runClassroomAssignment: vi.fn(),
  updateClassroomAssignmentOverride: vi.fn(),
  publishClassroomAssignmentRun: vi.fn(),
  runClassroomPublishJob: vi.fn(),
}));
vi.mock("@/lib/classrooms/schedule-email", () => ({
  getScheduleEmailPreview: vi.fn(),
  sendScheduleEmailsForRun: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  createClassroomPublishJob,
  getClassroomPublishJobProgress,
  getClassroomAssignmentForDate,
  runClassroomAssignment,
  StaleClassroomAssignmentSnapshotError,
  runClassroomPublishJob,
  updateClassroomAssignmentOverride,
} from "@/lib/classrooms/data";
import {
  getScheduleEmailPreview,
  sendScheduleEmailsForRun,
} from "@/lib/classrooms/schedule-email";
import { GET as getAssignments } from "../route";
import { POST as runAssignments } from "../run/route";
import { PATCH as patchOverride } from "../runs/[runId]/rows/[rowId]/route";
import { POST as publishAssignments } from "../runs/[runId]/publish/route";
import { GET as getPublishProgress } from "../runs/[runId]/publish/[jobId]/route";
import { GET as previewScheduleEmail } from "../runs/[runId]/schedule-email/preview/route";
import { POST as sendScheduleEmail } from "../runs/[runId]/schedule-email/send/route";

const authMock = auth as unknown as Mock;

const detail = {
  run: { id: "run-1", assignmentDate: "2026-05-14" },
  rows: [],
  rooms: [],
  snapshotMeta: {
    snapshotId: "snap-1",
    latestSyncFinishedAt: "2026-05-14T00:00:00.000Z",
    staleAgeMs: 0,
    fresh: true,
  },
  liveRoomBlocks: [],
  roomConflictWarnings: [],
};

const schedulePreview = {
  ready: true,
  sendable: true,
  assignmentRunId: "run-1",
  assignmentDate: "2026-05-14",
  subject: "BeGifted schedule for 14/5/2026",
  hardBlockers: [],
  blockers: [],
  readyCount: 1,
  blockedCount: 0,
  recipients: [],
  previews: [],
};

const publishProgress = {
  jobId: "job-1",
  runId: "run-1",
  status: "pending",
  totalCount: 1,
  eligibleCount: 1,
  completedCount: 0,
  successCount: 0,
  failedCount: 0,
  skippedCount: 0,
  remainingCount: 1,
  elapsedMs: null,
  estimatedRemainingMs: null,
  lastError: null,
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-05-14T00:00:00.000Z",
  updatedAt: "2026-05-14T00:00:00.000Z",
};

describe("class assignment routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" } });
    vi.mocked(getDb).mockReturnValue({ db: true } as never);
    vi.mocked(getClassroomAssignmentForDate).mockResolvedValue(detail as never);
    vi.mocked(runClassroomAssignment).mockResolvedValue(detail as never);
    vi.mocked(updateClassroomAssignmentOverride).mockResolvedValue(detail as never);
    vi.mocked(createClassroomPublishJob).mockResolvedValue(publishProgress as never);
    vi.mocked(getClassroomPublishJobProgress).mockResolvedValue({ progress: publishProgress, detail } as never);
    vi.mocked(runClassroomPublishJob).mockResolvedValue({ progress: publishProgress, detail } as never);
    vi.mocked(getScheduleEmailPreview).mockResolvedValue(schedulePreview as never);
    vi.mocked(sendScheduleEmailsForRun).mockResolvedValue({
      summary: { attempted: 1, success: 1, failed: 0, blocked: 0 },
      recipients: [],
      preview: schedulePreview,
    } as never);
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const res = await getAssignments(new NextRequest("http://test.local/api/class-assignments?date=2026-05-14"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects invalid dates", async () => {
    const res = await getAssignments(new NextRequest("http://test.local/api/class-assignments?date=bad-date"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid date. Expected YYYY-MM-DD." });
  });

  it("creates a run with the requested override policy", async () => {
    const req = new NextRequest("http://test.local/api/class-assignments/run", {
      method: "POST",
      body: JSON.stringify({ date: "2026-05-14", forceReassign: true }),
    });

    const res = await runAssignments(req);

    expect(res.status).toBe(200);
    expect(runClassroomAssignment).toHaveBeenCalledWith(
      { db: true },
      {
        date: "2026-05-14",
        forceReassign: true,
        createdBy: "admin@example.com",
      },
    );
  });

  it("returns 409 when the classroom snapshot is stale", async () => {
    vi.mocked(runClassroomAssignment).mockRejectedValue(new StaleClassroomAssignmentSnapshotError({
      latestSyncFinishedAt: "2026-05-14T00:00:00.000Z",
      staleAgeMs: 16 * 60 * 1000,
    }) as never);
    const req = new NextRequest("http://test.local/api/class-assignments/run", {
      method: "POST",
      body: JSON.stringify({ date: "2026-05-14", forceReassign: true }),
    });

    const res = await runAssignments(req);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Class assignment data is stale",
      code: "STALE_ASSIGNMENT_SNAPSHOT",
      latestSyncFinishedAt: "2026-05-14T00:00:00.000Z",
      staleAgeMs: 16 * 60 * 1000,
    });
  });

  it("updates an override and recalculates the run", async () => {
    const req = new NextRequest("http://test.local/api/class-assignments/runs/run-1/rows/row-1", {
      method: "PATCH",
      body: JSON.stringify({ overrideRoom: "Joy" }),
    });

    const res = await patchOverride(req, {
      params: Promise.resolve({ runId: "run-1", rowId: "row-1" }),
    });

    expect(res.status).toBe(200);
    expect(updateClassroomAssignmentOverride).toHaveBeenCalledWith(
      { db: true },
      { runId: "run-1", rowId: "row-1", overrideRoom: "Joy" },
    );
  });

  it("starts a publish job and returns progress", async () => {
    const res = await publishAssignments(new Request("http://test.local/api/class-assignments/runs/run-1/publish"), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(202);
    expect(createClassroomPublishJob).toHaveBeenCalledWith(
      { db: true },
      { runId: "run-1", createdBy: "admin@example.com" },
    );
    await expect(res.json()).resolves.toEqual({
      jobId: "job-1",
      progress: publishProgress,
    });
  });

  it("returns publish job progress", async () => {
    const res = await getPublishProgress(
      new Request("http://test.local/api/class-assignments/runs/run-1/publish/job-1"),
      { params: Promise.resolve({ runId: "run-1", jobId: "job-1" }) },
    );

    expect(res.status).toBe(200);
    expect(getClassroomPublishJobProgress).toHaveBeenCalledWith({ db: true }, "run-1", "job-1");
    await expect(res.json()).resolves.toEqual({ progress: publishProgress, detail });
  });

  it("previews teacher schedule emails", async () => {
    const res = await previewScheduleEmail(
      new Request("http://test.local/api/class-assignments/runs/run-1/schedule-email/preview"),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(res.status).toBe(200);
    expect(getScheduleEmailPreview).toHaveBeenCalledWith({ db: true }, "run-1");
    await expect(res.json()).resolves.toEqual(schedulePreview);
  });

  it("sends teacher schedule emails with the signed-in admin as creator", async () => {
    const res = await sendScheduleEmail(
      new Request("http://test.local/api/class-assignments/runs/run-1/schedule-email/send", {
        method: "POST",
      }),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(res.status).toBe(200);
    expect(sendScheduleEmailsForRun).toHaveBeenCalledWith(
      { db: true },
      "run-1",
      "admin@example.com",
      undefined,
      {},
    );
    await expect(res.json()).resolves.toEqual({
      summary: { attempted: 1, success: 1, failed: 0, blocked: 0 },
      recipients: [],
      preview: schedulePreview,
    });
  });

  it("sends teacher schedule emails only for selected recipient group ids", async () => {
    const res = await sendScheduleEmail(
      new Request("http://test.local/api/class-assignments/runs/run-1/schedule-email/send", {
        method: "POST",
        body: JSON.stringify({ recipientGroupIds: ["group-1", "group-2"] }),
      }),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(res.status).toBe(200);
    expect(sendScheduleEmailsForRun).toHaveBeenCalledWith(
      { db: true },
      "run-1",
      "admin@example.com",
      undefined,
      { recipientGroupIds: ["group-1", "group-2"] },
    );
  });

  it("rejects invalid selected recipient group ids", async () => {
    const res = await sendScheduleEmail(
      new Request("http://test.local/api/class-assignments/runs/run-1/schedule-email/send", {
        method: "POST",
        body: JSON.stringify({ recipientGroupIds: ["group-1", 123] }),
      }),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "recipientGroupIds must be an array of strings.",
    });
    expect(sendScheduleEmailsForRun).not.toHaveBeenCalled();
  });

  it("returns conflict when schedule email send is blocked", async () => {
    vi.mocked(sendScheduleEmailsForRun).mockResolvedValue({
      summary: { attempted: 0, success: 0, failed: 0, blocked: 1 },
      recipients: [],
      preview: {
        ...schedulePreview,
        ready: false,
        sendable: false,
        blockedCount: 1,
        blockers: [{ type: "missing_recipient_email", message: "Missing email" }],
      },
    } as never);

    const res = await sendScheduleEmail(
      new Request("http://test.local/api/class-assignments/runs/run-1/schedule-email/send", {
        method: "POST",
      }),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(res.status).toBe(409);
  });
});
