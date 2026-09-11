import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/classrooms/daily-automation", () => ({
  prepareNextDayClassrooms: vi.fn(),
  deliverNextDayClassroomSchedules: vi.fn(),
}));

import { prepareNextDayClassrooms, deliverNextDayClassroomSchedules } from "@/lib/classrooms/daily-automation";
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
    vi.mocked(prepareNextDayClassrooms).mockResolvedValue({
      ok: true,
      automationBatchId: "batch-1",
      startDate: "2026-05-26",
      endDate: "2026-06-01",
      sync: { mode: "reused", syncRunId: "sync-1", finishedAt: "2026-05-25T23:35:00.000Z" },
      dates: [],
    });
    vi.mocked(deliverNextDayClassroomSchedules).mockResolvedValue({
      ok: true, assignmentDate: "2026-05-26", adminEmail: { status: "sent", emailRunId: "email-run-1" },
    } as never);
  });

  it("rejects morning automation without the cron secret", async () => {
    const res = await morningGET(cronRequest("/api/internal/class-assignments/morning"));

    expect(res.status).toBe(401);
    expect(prepareNextDayClassrooms).not.toHaveBeenCalled();
  });

  it("runs morning automation with the cron secret", async () => {
    const res = await morningGET(cronRequest("/api/internal/class-assignments/morning", "test-secret"));

    expect(res.status).toBe(200);
    expect(prepareNextDayClassrooms).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({ ok: true, automationBatchId: "batch-1" }));
  });

  it("reports incomplete morning work and partial admin delivery as failures", async () => {
    vi.mocked(prepareNextDayClassrooms).mockResolvedValueOnce({ ok: false, dates: [], errorSummary: "2 classes without rooms" } as never);
    const morning = await morningGET(cronRequest("/api/internal/class-assignments/morning", "test-secret"));
    expect(morning.status).toBe(500);
    expect(await morning.json()).toMatchObject({ errorSummary: "2 classes without rooms" });
    vi.mocked(deliverNextDayClassroomSchedules).mockResolvedValueOnce({ ok: false, adminEmail: { status: "partial", success: 1, failed: 1 } } as never);
    expect((await adminEmailGET(cronRequest("/api/internal/class-assignments/admin-email", "test-secret"))).status).toBe(500);
  });

  it("rejects admin email without the cron secret", async () => {
    const res = await adminEmailGET(cronRequest("/api/internal/class-assignments/admin-email", "bad-secret"));

    expect(res.status).toBe(401);
    expect(deliverNextDayClassroomSchedules).not.toHaveBeenCalled();
  });

  it("runs admin email with the cron secret", async () => {
    const res = await adminEmailGET(cronRequest("/api/internal/class-assignments/admin-email", "test-secret"));

    expect(res.status).toBe(200);
    expect(deliverNextDayClassroomSchedules).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({ ok: true, adminEmail: { status: "sent", emailRunId: "email-run-1" } }));
  });
});
