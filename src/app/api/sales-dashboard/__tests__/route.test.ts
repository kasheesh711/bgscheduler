import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/sales-dashboard/data", () => ({
  getSalesDashboardPayload: vi.fn(),
  importAllSalesSources: vi.fn(),
  importRefreshableSalesSources: vi.fn(),
  importSalesDashboardSource: vi.fn(),
  listSalesDashboardSources: vi.fn(),
}));

import { auth } from "@/lib/auth";
import {
  getSalesDashboardPayload,
  importAllSalesSources,
  importRefreshableSalesSources,
  importSalesDashboardSource,
  listSalesDashboardSources,
} from "@/lib/sales-dashboard/data";
import { MissingGoogleSheetsTokenError } from "@/lib/sales-dashboard/google-oauth";
import { GET as getDashboard } from "../route";
import { POST as importDashboard } from "../import/route";

const authMock = auth as unknown as Mock;

function request(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/sales-dashboard/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("sales dashboard API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-05-21T00:00:00.000Z" });
    vi.mocked(getSalesDashboardPayload).mockResolvedValue({ ok: true } as never);
    vi.mocked(importAllSalesSources).mockResolvedValue([{ sourceId: "source-1", normalRows: 10, additionalRows: 2 }] as never);
    vi.mocked(importRefreshableSalesSources).mockResolvedValue([{ sourceId: "source-2", normalRows: 3, additionalRows: 1 }] as never);
    vi.mocked(importSalesDashboardSource).mockResolvedValue({ sourceId: "source-3" } as never);
    vi.mocked(listSalesDashboardSources).mockResolvedValue([{ id: "source-2" }] as never);
  });

  it("requires auth before returning the dashboard payload", async () => {
    authMock.mockResolvedValue(null);

    const res = await getDashboard();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getSalesDashboardPayload).not.toHaveBeenCalled();
  });

  it("returns the Postgres-backed dashboard payload for the signed-in admin", async () => {
    const res = await getDashboard();

    expect(res.status).toBe(200);
    expect(getSalesDashboardPayload).toHaveBeenCalledWith("admin@example.com");
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("runs backfill imports with the signed-in admin email", async () => {
    const res = await importDashboard(request({ mode: "backfill" }));

    expect(res.status).toBe(200);
    expect(importAllSalesSources).toHaveBeenCalledWith("admin@example.com");
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      results: [{ sourceId: "source-1", normalRows: 10, additionalRows: 2 }],
      sourceCount: 1,
      importedSourceCount: 1,
      normalRows: 10,
      additionalRows: 2,
      message: "Backfilled 1 sources: 10 normal rows and 2 additional rows.",
    });
  });

  it("refreshes a selected source and protects finalized sources unless allowed", async () => {
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const res = await importDashboard(request({ sourceId, allowFinalized: true }));

    expect(res.status).toBe(200);
    expect(importSalesDashboardSource).toHaveBeenCalledWith(sourceId, {
      triggerType: "manual",
      actorEmail: "admin@example.com",
      allowFinalized: true,
    });
  });

  it("returns 409 when the admin has not connected Google Sheets", async () => {
    vi.mocked(importRefreshableSalesSources).mockRejectedValue(new MissingGoogleSheetsTokenError() as never);

    const res = await importDashboard(request({ mode: "refreshable" }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Google Sheets access is not connected for this account." });
  });

  it("returns an explicit no-op response when refresh is requested before sources are configured", async () => {
    vi.mocked(listSalesDashboardSources).mockResolvedValue([] as never);

    const res = await importDashboard(request({ mode: "refreshable" }));

    expect(res.status).toBe(200);
    expect(importRefreshableSalesSources).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      ok: true,
      results: [],
      sourceCount: 0,
      importedSourceCount: 0,
      normalRows: 0,
      additionalRows: 0,
      message: "No sources configured. Seed historical sources first.",
    });
  });

  it("returns row-count summaries after refreshable imports", async () => {
    const res = await importDashboard(request({ mode: "refreshable" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      sourceCount: 1,
      importedSourceCount: 1,
      normalRows: 3,
      additionalRows: 1,
      message: "Refreshed 1 live-month sources: 3 normal rows and 1 additional rows.",
    });
  });
});
