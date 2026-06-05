import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/credit-control/service", () => ({ getCreditControlPayload: vi.fn() }));
vi.mock("@/lib/data-health/dashboard", () => ({ getDataHealthDashboardPayload: vi.fn() }));
vi.mock("@/lib/leave-requests/data", () => ({ listLeaveRequests: vi.fn() }));
vi.mock("@/lib/sales-dashboard/google-oauth", () => ({ getGoogleTokenStatus: vi.fn() }));
vi.mock("@/lib/payroll/data", () => ({ getPayrollPayload: vi.fn() }));
vi.mock("@/lib/wise-activity/reconciliation", () => ({ getWiseReconciliationActionSummary: vi.fn() }));

import { getCreditControlPayload } from "@/lib/credit-control/service";
import { getDataHealthDashboardPayload } from "@/lib/data-health/dashboard";
import { listLeaveRequests } from "@/lib/leave-requests/data";
import { getPayrollPayload } from "@/lib/payroll/data";
import { getGoogleTokenStatus } from "@/lib/sales-dashboard/google-oauth";
import { getWiseReconciliationActionSummary } from "@/lib/wise-activity/reconciliation";
import { getHomeSummaryPayload } from "@/lib/home/summary";

function dataHealthPayload() {
  return {
    checkedAt: "2026-06-05T09:00:00.000Z",
    overall: {
      status: "late",
      headline: "One cron is late",
      detail: "6 healthy, 1 late, 2 failing, 0 running, 1 manual-only.",
      healthyCount: 6,
      lateCount: 1,
      failingCount: 2,
      runningCount: 0,
      unknownCount: 0,
      manualOnlyCount: 1,
    },
    staleAgeMs: 1_200_000,
    staleMinutes: 20,
    lastSuccessfulSync: "2026-06-05T08:40:00.000Z",
  };
}

function fakeDb() {
  let selectCall = 0;
  return {
    select: vi.fn(() => {
      selectCall += 1;
      if (selectCall === 1) {
        return {
          from: () => ({
            where: async () => [{ count: "5" }],
          }),
        };
      }
      return {
        from: () => ({
          where: () => ({
            groupBy: async () => [
              { status: "due", count: "3" },
              { status: "approaching", count: "2" },
            ],
          }),
        }),
      };
    }),
  };
}

describe("getHomeSummaryPayload", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listLeaveRequests).mockResolvedValue({
      cards: { total: 10, new: 6, needsReview: 1, sheetWriteFailed: 0, affectedClasses: 20 },
      unreadActionCount: 7,
      timeline: [],
      requests: [],
    } as never);
    vi.mocked(getCreditControlPayload).mockResolvedValue({
      summary: { queue: { students: 11 }, packages: { notify: 4 } },
    } as never);
    vi.mocked(getPayrollPayload).mockResolvedValue({
      summary: { issueCount: 6, unresolvedTutorCount: 1 },
    } as never);
    vi.mocked(getWiseReconciliationActionSummary).mockResolvedValue({
      selectedSourceLabel: "June Sales",
      selectedSourceMonth: "2026-06-01",
      saleRows: 10,
      rowsWithPersistedCandidates: 5,
      rowsNeedingReview: 9,
      coverageStatus: "partial",
    });
    vi.mocked(getDataHealthDashboardPayload).mockResolvedValue(dataHealthPayload() as never);
    vi.mocked(getGoogleTokenStatus).mockResolvedValue({
      connected: true,
      writeConnected: true,
      email: "admin@example.com",
      expiresAt: null,
      lastError: null,
    } as never);
  });

  it("maps action counts and freshness into an access-filtered hub payload", async () => {
    const payload = await getHomeSummaryPayload(
      { allowedPages: null, email: "admin@example.com" },
      fakeDb() as never,
    );

    expect(Object.fromEntries(payload.actions.map((action) => [action.id, action.value]))).toMatchObject({
      leaveRequests: 7,
      lineReviews: 5,
      progressTests: 5,
      creditControl: 11,
      payroll: 6,
      wiseReconciliation: 9,
      dataHealth: 3,
    });
    expect(payload.freshness.cronCounts).toMatchObject({ healthy: 6, late: 1, failing: 2 });
    expect(payload.freshness.googleSheets.writeConnected).toBe(true);
  });

  it("keeps other items available when one source fails", async () => {
    vi.mocked(getPayrollPayload).mockRejectedValue(new Error("Payroll unavailable") as never);

    const payload = await getHomeSummaryPayload(
      { allowedPages: null, email: "admin@example.com" },
      fakeDb() as never,
    );

    const payroll = payload.actions.find((action) => action.id === "payroll");
    expect(payroll).toMatchObject({
      status: "error",
      value: null,
      error: "Payroll unavailable",
    });
    expect(payload.actions.find((action) => action.id === "leaveRequests")?.value).toBe(7);
  });

  it("omits inaccessible action queues for restricted users", async () => {
    const payload = await getHomeSummaryPayload(
      { allowedPages: ["/progress-tests"], email: "teacher@example.com" },
      fakeDb() as never,
    );

    expect(payload.actions.map((action) => action.id)).toEqual(["progressTests"]);
  });
});
