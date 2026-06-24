import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/student-promotions/data", () => ({
  applyVerifiedStudentPromotionRun: vi.fn(),
  createStudentPromotionDryRun: vi.fn(),
  getLatestStudentPromotionRunDetail: vi.fn(),
  getStudentPromotionRunDetail: vi.fn(),
  verifyStudentPromotionRun: vi.fn(),
}));
vi.mock("@/lib/data-health/cron-audit", () => ({
  withCronInvocationAudit: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import {
  applyVerifiedStudentPromotionRun,
  createStudentPromotionDryRun,
  getLatestStudentPromotionRunDetail,
  getStudentPromotionRunDetail,
  verifyStudentPromotionRun,
} from "@/lib/student-promotions/data";
import { GET as getRuns, POST as postRun } from "../runs/route";
import { GET as getRun } from "../runs/[runId]/route";
import { POST as verifyRun } from "../runs/[runId]/verify/route";
import { POST as applyRun } from "../runs/[runId]/apply/route";
import { GET as cronApply } from "@/app/api/internal/student-promotions/july-1/route";

const authMock = auth as unknown as Mock;
const detail = {
  run: { id: "run-1", status: "draft" },
  gradeActions: [],
  courseActions: [],
  summary: {},
};

function request(url: string, body?: unknown, headers?: Record<string, string>) {
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ctx(runId = "run-1") {
  return { params: Promise.resolve({ runId }) };
}

describe("student promotion routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(withCronInvocationAudit).mockImplementation((_, handler) => handler());
    vi.mocked(getLatestStudentPromotionRunDetail).mockResolvedValue(detail as never);
    vi.mocked(getStudentPromotionRunDetail).mockResolvedValue(detail as never);
    vi.mocked(createStudentPromotionDryRun).mockResolvedValue(detail as never);
    vi.mocked(verifyStudentPromotionRun).mockResolvedValue({ ...detail, run: { id: "run-1", status: "verified" } } as never);
    vi.mocked(applyVerifiedStudentPromotionRun).mockResolvedValue({ ...detail, run: { id: "run-1", status: "applied" } } as never);
    process.env.CRON_SECRET = "secret";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires auth for the latest run", async () => {
    authMock.mockResolvedValue(null);

    const res = await getRuns();

    expect(res.status).toBe(401);
  });

  it("creates a dry-run audit as the current admin", async () => {
    const res = await postRun();

    expect(res.status).toBe(201);
    expect(createStudentPromotionDryRun).toHaveBeenCalledWith({
      actor: { email: "admin@example.com", name: "Admin" },
    });
  });

  it("loads a specific run", async () => {
    const res = await getRun(request("http://test.local/api/student-promotions/runs/run-1"), ctx());

    expect(res.status).toBe(200);
    expect(getStudentPromotionRunDetail).toHaveBeenCalledWith("run-1");
  });

  it("requires endpoint confirmation before verifying a run", async () => {
    const res = await verifyRun(
      request("http://test.local/api/student-promotions/runs/run-1/verify", {
        endpointVerificationNote: "checked",
      }),
      ctx(),
    );

    expect(res.status).toBe(400);
    expect(verifyStudentPromotionRun).not.toHaveBeenCalled();
  });

  it("verifies a run with an endpoint note", async () => {
    const res = await verifyRun(
      request("http://test.local/api/student-promotions/runs/run-1/verify", {
        endpointVerificationConfirmed: true,
        endpointVerificationNote: "verified with no-op record",
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(verifyStudentPromotionRun).toHaveBeenCalledWith({
      runId: "run-1",
      actor: { email: "admin@example.com", name: "Admin" },
      endpointVerificationNote: "verified with no-op record",
    });
  });

  it("requires explicit apply confirmation for manual apply", async () => {
    const res = await applyRun(
      request("http://test.local/api/student-promotions/runs/run-1/apply", {}),
      ctx(),
    );

    expect(res.status).toBe(400);
    expect(applyVerifiedStudentPromotionRun).not.toHaveBeenCalled();
  });

  it("applies a verified run manually", async () => {
    const res = await applyRun(
      request("http://test.local/api/student-promotions/runs/run-1/apply", {
        confirm: "apply-student-promotions",
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(applyVerifiedStudentPromotionRun).toHaveBeenCalledWith({
      runId: "run-1",
      actor: { email: "admin@example.com", name: "Admin" },
      trigger: "admin",
    });
  });

  it("protects the internal cron endpoint with CRON_SECRET", async () => {
    const res = await cronApply(request("http://test.local/api/internal/student-promotions/july-1"));

    expect(res.status).toBe(401);
  });

  it("runs cron apply with a valid bearer secret", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T17:05:00.000Z"));

    const res = await cronApply(request(
      "http://test.local/api/internal/student-promotions/july-1",
      undefined,
      { authorization: "Bearer secret" },
    ));

    expect(res.status).toBe(200);
    expect(applyVerifiedStudentPromotionRun).toHaveBeenCalledWith({ trigger: "cron" });
    expect(withCronInvocationAudit).toHaveBeenCalledWith(
      { jobKey: "student_promotions_july_1", triggerSource: "cron", requestMethod: "GET" },
      expect.any(Function),
    );
  });

  it("blocks the cron outside the July 1, 2026 Bangkok target date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-06-30T17:05:00.000Z"));

    const res = await cronApply(request(
      "http://test.local/api/internal/student-promotions/july-1",
      undefined,
      { authorization: "Bearer secret" },
    ));

    expect(res.status).toBe(409);
    expect(applyVerifiedStudentPromotionRun).not.toHaveBeenCalled();
    expect(withCronInvocationAudit).toHaveBeenCalledWith(
      { jobKey: "student_promotions_july_1", triggerSource: "cron", requestMethod: "GET" },
      expect.any(Function),
    );
  });
});
