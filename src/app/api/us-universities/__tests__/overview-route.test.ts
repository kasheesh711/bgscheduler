import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/us-universities/data", () => ({
  getUsUniversitiesOverview: vi.fn(),
  searchInstitutions: vi.fn(),
  getInstitutionProfile: vi.fn(),
  getCompareInstitutions: vi.fn(),
  getInstitutionsForExport: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getUsUniversitiesOverview } from "@/lib/us-universities/data";
import { GET } from "../route";

const authMock = auth as unknown as Mock;

const OVERVIEW_FIXTURE = {
  totalInstitutions: 2,
  dataYear: 2024,
  stateFacets: [{ stateAbbr: "CA", count: 1 }],
  controlFacets: [{ control: 1, label: "Public", count: 2 }],
  acceptanceBuckets: [{ label: "Under 10%", count: 1 }],
  cip2Options: [{ cip2: "11", label: "Computer Science", count: 5 }],
  scatter: [{ unitId: 100, acceptanceRate: 12, avgNetPrice: 20000 }],
};

describe("GET /api/us-universities (overview)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-05-21T00:00:00.000Z" });
    vi.mocked(getUsUniversitiesOverview).mockResolvedValue(OVERVIEW_FIXTURE as never);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getUsUniversitiesOverview).not.toHaveBeenCalled();
  });

  it("returns 200 with the overview payload for a signed-in admin", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(getUsUniversitiesOverview).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual(OVERVIEW_FIXTURE);
  });

  it("returns 500 when the data layer throws", async () => {
    vi.mocked(getUsUniversitiesOverview).mockRejectedValue(new Error("db down") as never);

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "db down" });
  });
});
