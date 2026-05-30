import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn() }));
vi.mock("@/lib/payroll/data", () => ({
  addPayrollAdjustment: vi.fn(),
  deletePayrollAdjustment: vi.fn(),
  getPayrollPayload: vi.fn(),
  updatePayrollReview: vi.fn(),
}));
vi.mock("@/lib/payroll/sync", () => ({
  PayrollSyncAlreadyRunningError: class PayrollSyncAlreadyRunningError extends Error {
    constructor() {
      super("Payroll sync is already running");
      this.name = "PayrollSyncAlreadyRunningError";
    }
  },
  runPayrollSync: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { addPayrollAdjustment, getPayrollPayload, updatePayrollReview } from "@/lib/payroll/data";
import { PayrollSyncAlreadyRunningError, runPayrollSync } from "@/lib/payroll/sync";
import { GET as getPayroll } from "../route";
import { POST as addAdjustment } from "../adjustments/route";
import { PATCH as patchReview } from "../review/route";
import { POST as postSync } from "../sync/route";

const authMock = auth as unknown as Mock;

const payrollPayload = {
  month: "2026-05",
  payrollMonth: "2026-05-01",
  review: { status: "draft", notes: "", approvedByEmail: null, approvedByName: null, approvedAt: null, updatedAt: null },
  lastSync: null,
  summary: { issueCount: 0 },
  tutors: [],
  issues: [],
  adjustments: [],
};

function request(url: string, body?: unknown) {
  return new NextRequest(url, body === undefined
    ? undefined
    : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
}

describe("payroll API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(getDb).mockReturnValue({ db: true } as never);
    vi.mocked(createWiseClient).mockReturnValue({ client: true } as never);
    vi.mocked(getPayrollPayload).mockResolvedValue(payrollPayload as never);
    vi.mocked(runPayrollSync).mockResolvedValue({ syncRunId: "run-1", status: "success" } as never);
    vi.mocked(addPayrollAdjustment).mockResolvedValue({ id: "adj-1" } as never);
  });

  it("requires auth before returning payroll payload", async () => {
    authMock.mockResolvedValue(null);

    const res = await getPayroll(new NextRequest("http://test.local/api/payroll?month=2026-05"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("passes month query to payroll data service", async () => {
    const res = await getPayroll(new NextRequest("http://test.local/api/payroll?month=2026-05"));

    expect(res.status).toBe(200);
    expect(getPayrollPayload).toHaveBeenCalledWith({ db: true }, "2026-05");
  });

  it("returns 400 for invalid month errors", async () => {
    vi.mocked(getPayrollPayload).mockRejectedValue(new Error("Invalid month. Expected YYYY-MM.") as never);

    const res = await getPayroll(new NextRequest("http://test.local/api/payroll?month=May"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid month. Expected YYYY-MM." });
  });

  it("runs manual Wise payroll sync", async () => {
    const res = await postSync(request("http://test.local/api/payroll/sync", { month: "2026-05" }));

    expect(res.status).toBe(200);
    expect(runPayrollSync).toHaveBeenCalledWith(
      { db: true },
      { client: true },
      "696e1f4d90102225641cc413",
      "2026-05",
      { maxEventPages: 1000 },
    );
  });

  it("returns 409 when payroll sync is already running", async () => {
    vi.mocked(runPayrollSync).mockRejectedValue(new PayrollSyncAlreadyRunningError() as never);

    const res = await postSync(request("http://test.local/api/payroll/sync", { month: "2026-05" }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Payroll sync is already running" });
  });

  it("updates review status and notes", async () => {
    const res = await patchReview(new NextRequest("http://test.local/api/payroll/review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month: "2026-05", status: "approved", notes: "checked" }),
    }));

    expect(res.status).toBe(200);
    expect(updatePayrollReview).toHaveBeenCalledWith({ db: true }, {
      month: "2026-05",
      status: "approved",
      notes: "checked",
      actorEmail: "admin@example.com",
      actorName: "Admin",
    });
  });

  it("adds manual adjustment rows", async () => {
    const res = await addAdjustment(request("http://test.local/api/payroll/adjustments", {
      month: "2026-05",
      description: "Manual correction",
      hours: 1,
      amount: 700,
    }));

    expect(res.status).toBe(200);
    expect(addPayrollAdjustment).toHaveBeenCalledWith({ db: true }, expect.objectContaining({
      month: "2026-05",
      description: "Manual correction",
      hours: 1,
      amount: 700,
      actorEmail: "admin@example.com",
    }));
  });
});
