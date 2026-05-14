import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/classrooms/data", () => ({
  assertIsoDate: vi.fn((value: string) => {
    if (value === "bad-date") throw new Error("Invalid date. Expected YYYY-MM-DD.");
    return value;
  }),
  getClassroomAssignmentForDate: vi.fn(),
  runClassroomAssignment: vi.fn(),
  updateClassroomAssignmentOverride: vi.fn(),
  publishClassroomAssignmentRun: vi.fn(),
}));
vi.mock("@/lib/classrooms/schedule-email", () => ({
  getScheduleEmailPreview: vi.fn(),
  sendScheduleEmailsForRun: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  getClassroomAssignmentForDate,
  publishClassroomAssignmentRun,
  runClassroomAssignment,
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
import { GET as previewScheduleEmail } from "../runs/[runId]/schedule-email/preview/route";
import { POST as sendScheduleEmail } from "../runs/[runId]/schedule-email/send/route";

const authMock = auth as unknown as Mock;

const detail = {
  run: { id: "run-1", assignmentDate: "2026-05-14" },
  rows: [],
  rooms: [],
};

const schedulePreview = {
  ready: true,
  assignmentRunId: "run-1",
  assignmentDate: "2026-05-14",
  subject: "BeGifted schedule for 14/5/2026",
  blockers: [],
  recipients: [],
  previews: [],
};

describe("class assignment routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" } });
    vi.mocked(getDb).mockReturnValue({ db: true } as never);
    vi.mocked(getClassroomAssignmentForDate).mockResolvedValue(detail as never);
    vi.mocked(runClassroomAssignment).mockResolvedValue(detail as never);
    vi.mocked(updateClassroomAssignmentOverride).mockResolvedValue(detail as never);
    vi.mocked(publishClassroomAssignmentRun).mockResolvedValue({
      detail,
      summary: { attempted: 1, success: 1, skipped: 0, failed: 0 },
    } as never);
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

  it("publishes a run through the service and returns per-row results", async () => {
    const res = await publishAssignments(new Request("http://test.local/api/class-assignments/runs/run-1/publish"), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(200);
    expect(publishClassroomAssignmentRun).toHaveBeenCalledWith({ db: true }, "run-1");
    await expect(res.json()).resolves.toEqual({
      detail,
      summary: { attempted: 1, success: 1, skipped: 0, failed: 0 },
    });
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
    );
    await expect(res.json()).resolves.toEqual({
      summary: { attempted: 1, success: 1, failed: 0, blocked: 0 },
      recipients: [],
      preview: schedulePreview,
    });
  });

  it("returns conflict when schedule email send is blocked", async () => {
    vi.mocked(sendScheduleEmailsForRun).mockResolvedValue({
      summary: { attempted: 0, success: 0, failed: 0, blocked: 1 },
      recipients: [],
      preview: { ...schedulePreview, ready: false, blockers: [{ type: "missing_recipient_email", message: "Missing email" }] },
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
