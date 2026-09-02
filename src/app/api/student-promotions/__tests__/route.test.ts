import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/student-promotions/data", () => ({
  WISE_SESSION_SUBJECT_UPDATE_CONFIRMATION: "apply-future-session-subjects",
  applyStudentPromotionFutureSessionActions: vi.fn(),
  applyVerifiedStudentPromotionRun: vi.fn(),
  createStudentPromotionDryRun: vi.fn(),
  getLatestStudentPromotionRunDetail: vi.fn(),
  getStudentPromotionRunDetail: vi.fn(),
  reviewStudentPromotionPayRateImpact: vi.fn(),
  runStudentPromotionReadback: vi.fn(),
  updateStudentPromotionGraduationDisposition: vi.fn(),
  verifyStudentPromotionRun: vi.fn(),
}));

import { auth } from "@/lib/auth";
import {
  applyStudentPromotionFutureSessionActions,
  applyVerifiedStudentPromotionRun,
  createStudentPromotionDryRun,
  getLatestStudentPromotionRunDetail,
  getStudentPromotionRunDetail,
  reviewStudentPromotionPayRateImpact,
  runStudentPromotionReadback,
  updateStudentPromotionGraduationDisposition,
  verifyStudentPromotionRun,
} from "@/lib/student-promotions/data";
import { GET as getRuns, POST as postRun } from "../runs/route";
import { GET as getRun } from "../runs/[runId]/route";
import { POST as verifyRun } from "../runs/[runId]/verify/route";
import { POST as applyRun } from "../runs/[runId]/apply/route";
import { POST as applyFutureSessions } from "../runs/[runId]/future-sessions/apply/route";
import { POST as readbackRun } from "../runs/[runId]/readback/route";
import { PATCH as updateGraduationAction } from "../runs/[runId]/graduation-actions/[actionId]/route";
import { PATCH as reviewPayRateImpact } from "../runs/[runId]/pay-rate-impacts/[impactId]/review/route";
import { GET as cronApply } from "@/app/api/internal/student-promotions/july-1/route";

const authMock = auth as unknown as Mock;
const detail = {
  run: { id: "run-1", status: "draft" },
  gradeActions: [],
  courseActions: [],
  futureSessionActions: [],
  graduationActions: [],
  payRateImpacts: [],
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

function nestedCtx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

describe("student promotion routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(getLatestStudentPromotionRunDetail).mockResolvedValue(detail as never);
    vi.mocked(getStudentPromotionRunDetail).mockResolvedValue(detail as never);
    vi.mocked(createStudentPromotionDryRun).mockResolvedValue(detail as never);
    vi.mocked(verifyStudentPromotionRun).mockResolvedValue({ ...detail, run: { id: "run-1", status: "verified" } } as never);
    vi.mocked(applyVerifiedStudentPromotionRun).mockResolvedValue({ ...detail, run: { id: "run-1", status: "applied" } } as never);
    vi.mocked(applyStudentPromotionFutureSessionActions).mockResolvedValue({ ...detail, run: { id: "run-1", status: "applied" } } as never);
    vi.mocked(updateStudentPromotionGraduationDisposition).mockResolvedValue(detail as never);
    vi.mocked(reviewStudentPromotionPayRateImpact).mockResolvedValue(detail as never);
    vi.mocked(runStudentPromotionReadback).mockResolvedValue({ runId: "run-1", gradeRows: [], courseRows: [] } as never);
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

  it("runs a read-only readback check", async () => {
    const res = await readbackRun(
      request("http://test.local/api/student-promotions/runs/run-1/readback", {}),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(runStudentPromotionReadback).toHaveBeenCalledWith({ runId: "run-1" });
  });

  it("requires explicit confirmation before applying future session subjects", async () => {
    const res = await applyFutureSessions(
      request("http://test.local/api/student-promotions/runs/run-1/future-sessions/apply", {}),
      ctx(),
    );

    expect(res.status).toBe(400);
    expect(applyStudentPromotionFutureSessionActions).not.toHaveBeenCalled();
  });

  it("applies future session subjects with exact confirmation", async () => {
    const res = await applyFutureSessions(
      request("http://test.local/api/student-promotions/runs/run-1/future-sessions/apply", {
        confirm: "apply-future-session-subjects",
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(applyStudentPromotionFutureSessionActions).toHaveBeenCalledWith({
      runId: "run-1",
      actor: { email: "admin@example.com", name: "Admin" },
    });
  });

  it("updates a Year 13 graduation disposition", async () => {
    const res = await updateGraduationAction(
      request("http://test.local/api/student-promotions/runs/run-1/graduation-actions/graduation-1", {
        disposition: "university",
      }),
      nestedCtx({ runId: "run-1", actionId: "graduation-1" }),
    );

    expect(res.status).toBe(200);
    expect(updateStudentPromotionGraduationDisposition).toHaveBeenCalledWith({
      runId: "run-1",
      actionId: "graduation-1",
      disposition: "university",
      actor: { email: "admin@example.com", name: "Admin" },
    });
  });

  it("marks a pay-rate impact reviewed", async () => {
    const res = await reviewPayRateImpact(
      request("http://test.local/api/student-promotions/runs/run-1/pay-rate-impacts/pay-1/review", {
        status: "verified_correct",
      }),
      nestedCtx({ runId: "run-1", impactId: "pay-1" }),
    );

    expect(res.status).toBe(200);
    expect(reviewStudentPromotionPayRateImpact).toHaveBeenCalledWith({
      runId: "run-1",
      impactId: "pay-1",
      status: "verified_correct",
      note: null,
      actor: { email: "admin@example.com", name: "Admin" },
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
  });
});
