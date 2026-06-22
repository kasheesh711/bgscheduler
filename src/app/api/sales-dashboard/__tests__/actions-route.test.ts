import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/sales-dashboard/data", () => ({
  getSalesDashboardPayload: vi.fn(),
  getSalesDimensionsPayload: vi.fn(),
}));
vi.mock("@/lib/credit-control/service", () => ({
  getCreditControlPayload: vi.fn(),
}));
vi.mock("@/lib/sales-dashboard/actions", () => ({
  buildSalesActionsPayload: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getCreditControlPayload } from "@/lib/credit-control/service";
import { buildSalesActionsPayload } from "@/lib/sales-dashboard/actions";
import { getSalesDashboardPayload, getSalesDimensionsPayload } from "@/lib/sales-dashboard/data";
import type { SalesActionsPayload } from "@/lib/sales-dashboard/actions";
import type { SalesDashboardPayload, SalesDimensionsPayload } from "@/lib/sales-dashboard/types";
import type { DashboardPayload } from "@/types/credit-control";
import { GET as getActions } from "../actions/route";

const authMock = auth as unknown as Mock;

const actionPayload: SalesActionsPayload = {
  generatedAt: "2026-06-15T00:00:00.000Z",
  mode: "current",
  modeLabel: "Current-month action mode",
  period: {
    from: "2026-06-01",
    to: "2026-06-30",
    currentMonthStart: "2026-06-01",
    currentMonthEnd: "2026-06-30",
    isCurrentMonth: true,
  },
  kpis: {
    projectedNormalSales: 1,
    targetGap: 2,
    matchedAtRiskValue: 3,
    actionsReady: 4,
    target: 5,
    normalSales: 6,
    dailyPaceNeeded: 7,
  },
  chart: { points: [], annotations: [] },
  items: [],
  dependencyWarnings: [],
  matchStats: {
    unique: 0,
    ambiguous: 0,
    unmatched: 0,
    creditControlAvailable: true,
    creditControlAccessible: true,
  },
};

function request(query: string): NextRequest {
  return new NextRequest(`http://test.local/api/sales-dashboard/actions${query}`);
}

describe("GET /api/sales-dashboard/actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: { email: "admin@example.com", allowedPages: null },
      expires: "2026-06-21T00:00:00.000Z",
    });
    vi.mocked(getSalesDashboardPayload).mockResolvedValue({ normalDays: [] } as unknown as SalesDashboardPayload);
    vi.mocked(getSalesDimensionsPayload).mockResolvedValue({ students: [] } as unknown as SalesDimensionsPayload);
    vi.mocked(getCreditControlPayload).mockResolvedValue({ students: [] } as unknown as DashboardPayload);
    vi.mocked(buildSalesActionsPayload).mockReturnValue(actionPayload);
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const res = await getActions(request("?from=2026-06-01&to=2026-06-30"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getSalesDashboardPayload).not.toHaveBeenCalled();
    expect(getCreditControlPayload).not.toHaveBeenCalled();
  });

  it("validates required date query parameters", async () => {
    const res = await getActions(request("?from=06-01-2026&to=2026-06-30"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid query");
    expect(body.details.fieldErrors.from).toBeTruthy();
    expect(getSalesDashboardPayload).not.toHaveBeenCalled();
  });

  it("returns an action payload and reads Credit Control without clearing recovered states", async () => {
    const res = await getActions(request("?from=2026-06-01&to=2026-06-30"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(actionPayload);
    expect(getSalesDashboardPayload).toHaveBeenCalledWith("admin@example.com");
    expect(getCreditControlPayload).toHaveBeenCalledWith(undefined, { clearRecoveredActionStates: false });
    expect(buildSalesActionsPayload).toHaveBeenCalledWith(expect.objectContaining({
      creditControlError: null,
      from: "2026-06-01",
      to: "2026-06-30",
      canAccessCreditControl: true,
    }));
  });

  it("keeps returning Sales-only actions when Credit Control fails", async () => {
    vi.mocked(getCreditControlPayload).mockRejectedValue(new Error("credit table missing"));

    const res = await getActions(request("?from=2026-06-01&to=2026-06-30"));

    expect(res.status).toBe(200);
    expect(buildSalesActionsPayload).toHaveBeenCalledWith(expect.objectContaining({
      creditControl: null,
      creditControlError: "credit table missing",
    }));
  });

  it("gates Credit Control action links for restricted users", async () => {
    authMock.mockResolvedValue({
      user: { email: "sales@example.com", allowedPages: ["/sales-dashboard"] },
      expires: "2026-06-21T00:00:00.000Z",
    });

    const res = await getActions(request("?from=2026-06-01&to=2026-06-30"));

    expect(res.status).toBe(200);
    expect(buildSalesActionsPayload).toHaveBeenCalledWith(expect.objectContaining({
      canAccessCreditControl: false,
    }));
  });
});
