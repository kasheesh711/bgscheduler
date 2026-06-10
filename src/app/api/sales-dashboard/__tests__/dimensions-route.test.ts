import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/sales-dashboard/data", () => ({
  getSalesDimensionsPayload: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getSalesDimensionsPayload } from "@/lib/sales-dashboard/data";
import type { SalesDimensionsPayload } from "@/lib/sales-dashboard/types";
import { GET as getDimensions } from "../dimensions/route";

const authMock = auth as unknown as Mock;

const payload: SalesDimensionsPayload = {
  months: ["2026-01-01"],
  reps: [{ rep: "Alice", month: "2026-01-01", rev: 1_000, count: 1, revT: 0, revN: 1_000, revR: 0, cntT: 0, cntN: 1, cntR: 0 }],
  repFunnels: [{ rep: "Alice", trialsHandled: 1, trialsConverted: 1, medianDaysToConvert: 7, topPrograms: [], topPackages: [] }],
  programs: [],
  packages: [],
  additionalMix: [],
  students: [],
  targetMonthlyRevenue: null,
  unparsedPackageCount: 0,
  generatedAt: "2026-06-01T00:00:00.000Z",
};

describe("GET /api/sales-dashboard/dimensions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-06-21T00:00:00.000Z" });
    vi.mocked(getSalesDimensionsPayload).mockResolvedValue(payload);
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const res = await getDimensions();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getSalesDimensionsPayload).not.toHaveBeenCalled();
  });

  it("returns the cached dimensions payload shape", async () => {
    const res = await getDimensions();

    expect(res.status).toBe(200);
    const body = await res.json() as SalesDimensionsPayload;
    expect(body).toEqual(payload);
    expect(Object.keys(body).sort()).toEqual([
      "additionalMix",
      "generatedAt",
      "months",
      "packages",
      "programs",
      "repFunnels",
      "reps",
      "students",
      "targetMonthlyRevenue",
      "unparsedPackageCount",
    ]);
  });

  it("returns 500 with the error message when the data layer fails", async () => {
    vi.mocked(getSalesDimensionsPayload).mockRejectedValue(new Error("relation missing"));

    const res = await getDimensions();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "relation missing" });
  });

  it("is backed by the sales-dashboard cache tag in the data layer", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/lib/sales-dashboard/data.ts"),
      "utf8",
    );
    const fnIndex = source.indexOf("export async function getSalesDimensionsPayload");
    expect(fnIndex).toBeGreaterThan(-1);
    const body = source.slice(fnIndex, fnIndex + 600);
    expect(body).toContain("\"use cache\"");
    expect(body).toContain("cacheTag(SALES_DASHBOARD_CACHE_TAG)");
    expect(body).toContain("cacheLife({ stale: 60, revalidate: 60, expire: 300 })");
  });
});
