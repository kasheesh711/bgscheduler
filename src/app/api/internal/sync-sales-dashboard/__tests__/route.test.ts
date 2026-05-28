import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/sales-dashboard/data", () => ({
  importActiveSalesDashboardProjectionSource: vi.fn(),
  importRefreshableSalesSources: vi.fn(),
}));

import { auth } from "@/lib/auth";
import {
  importActiveSalesDashboardProjectionSource,
  importRefreshableSalesSources,
} from "@/lib/sales-dashboard/data";
import { MissingGoogleSheetsTokenError } from "@/lib/sales-dashboard/google-oauth";
import { GET, POST } from "../route";

const authMock = auth as unknown as Mock;

function request(secret?: string, method: "GET" | "POST" = "POST"): NextRequest {
  const headers = secret === undefined ? undefined : { authorization: `Bearer ${secret}` };
  return new NextRequest("http://test.local/api/internal/sync-sales-dashboard", { method, headers });
}

describe("GET/POST /api/internal/sync-sales-dashboard", () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "test-secret";
    authMock.mockResolvedValue(null);
    vi.mocked(importRefreshableSalesSources).mockResolvedValue([{ sourceId: "source-1" }] as never);
    vi.mocked(importActiveSalesDashboardProjectionSource).mockResolvedValue({ sourceId: "projection-1" } as never);
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  it("requires the cron secret for GET", async () => {
    const res = await GET(request("wrong-secret", "GET"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(importRefreshableSalesSources).not.toHaveBeenCalled();
  });

  it("runs refreshable imports with cron actor when the secret is valid", async () => {
    const res = await GET(request("test-secret", "GET"));

    expect(res.status).toBe(200);
    expect(importRefreshableSalesSources).toHaveBeenCalledWith({
      triggerType: "cron",
      actorEmail: "cron@begifted.local",
    });
    expect(importActiveSalesDashboardProjectionSource).toHaveBeenCalledWith({
      triggerType: "cron",
      actorEmail: "cron@begifted.local",
    });
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      results: [{ sourceId: "source-1" }],
      projectionResult: { sourceId: "projection-1" },
    });
  });

  it("allows a signed-in admin to trigger POST manually without the cron secret", async () => {
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-05-21T00:00:00.000Z" });

    const res = await POST(request(undefined));

    expect(res.status).toBe(200);
    expect(importRefreshableSalesSources).toHaveBeenCalledWith({
      triggerType: "cron",
      actorEmail: "admin@example.com",
    });
    expect(importActiveSalesDashboardProjectionSource).toHaveBeenCalledWith({
      triggerType: "cron",
      actorEmail: "admin@example.com",
    });
  });

  it("returns 409 when cron cannot access connected Sheets tokens", async () => {
    vi.mocked(importRefreshableSalesSources).mockRejectedValue(new MissingGoogleSheetsTokenError() as never);

    const res = await GET(request("test-secret", "GET"));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Google Sheets access is not connected for this account." });
  });
});
