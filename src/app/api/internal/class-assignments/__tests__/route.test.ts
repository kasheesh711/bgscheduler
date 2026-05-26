import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/classrooms/morning-automation", () => ({
  runClassroomMorningAutomation: vi.fn(),
}));

vi.mock("@/lib/classrooms/admin-schedule-email", () => ({
  sendAdminClassroomScheduleEmail: vi.fn(),
}));

import { runClassroomMorningAutomation } from "@/lib/classrooms/morning-automation";
import { sendAdminClassroomScheduleEmail } from "@/lib/classrooms/admin-schedule-email";
import { GET as morningGET } from "../morning/route";
import { GET as adminEmailGET } from "../admin-email/route";

function cronRequest(path: string, secret?: string) {
  return new NextRequest(`http://test.local${path}`, {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("internal classroom assignment automation routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "test-secret";
    vi.mocked(runClassroomMorningAutomation).mockResolvedValue({
      ok: true,
      automationBatchId: "batch-1",
      startDate: "2026-05-26",
      endDate: "2026-06-01",
      sync: { mode: "reused", syncRunId: "sync-1", finishedAt: "2026-05-25T23:35:00.000Z" },
      dates: [],
    });
    vi.mocked(sendAdminClassroomScheduleEmail).mockResolvedValue({
      status: "sent",
      assignmentDate: "2026-05-26",
      assignmentRunId: "run-1",
      emailRunId: "email-run-1",
      attempted: 2,
      success: 2,
      failed: 0,
      message: "Admin classroom schedule email sent.",
    });
  });

  it("rejects morning automation without the cron secret", async () => {
    const res = await morningGET(cronRequest("/api/internal/class-assignments/morning"));

    expect(res.status).toBe(401);
    expect(runClassroomMorningAutomation).not.toHaveBeenCalled();
  });

  it("runs morning automation with the cron secret", async () => {
    const res = await morningGET(cronRequest("/api/internal/class-assignments/morning", "test-secret"));

    expect(res.status).toBe(200);
    expect(runClassroomMorningAutomation).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({ ok: true, automationBatchId: "batch-1" }));
  });

  it("rejects admin email without the cron secret", async () => {
    const res = await adminEmailGET(cronRequest("/api/internal/class-assignments/admin-email", "bad-secret"));

    expect(res.status).toBe(401);
    expect(sendAdminClassroomScheduleEmail).not.toHaveBeenCalled();
  });

  it("runs admin email with the cron secret", async () => {
    const res = await adminEmailGET(cronRequest("/api/internal/class-assignments/admin-email", "test-secret"));

    expect(res.status).toBe(200);
    expect(sendAdminClassroomScheduleEmail).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({ status: "sent", emailRunId: "email-run-1" }));
  });
});
