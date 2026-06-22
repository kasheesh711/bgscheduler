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
import { getInstitutionsForExport } from "@/lib/us-universities/data";
import { GET } from "../export/route";

const authMock = auth as unknown as Mock;

// One summary-ish row; institutionsToCsv is the REAL implementation (not mocked).
const EXPORT_ROW = {
  unitId: 100,
  instName: "Test University",
  city: "Palo Alto",
  stateAbbr: "CA",
  control: 2,
  acceptanceRate: 8,
};

function exportRequest(query = ""): Request {
  return new Request(`http://localhost/api/us-universities/export${query}`);
}

describe("GET /api/us-universities/export", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-05-21T00:00:00.000Z" });
    vi.mocked(getInstitutionsForExport).mockResolvedValue([EXPORT_ROW] as never);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(exportRequest("?states=CA"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getInstitutionsForExport).not.toHaveBeenCalled();
  });

  it("returns 200 CSV with the correct content-type for a signed-in admin", async () => {
    const res = await GET(exportRequest("?states=CA"));

    expect(res.status).toBe(200);
    expect(getInstitutionsForExport).toHaveBeenCalledTimes(1);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("us-universities.csv");

    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("Test University");
  });

  it("returns a CSV (header-only acceptable) when there are no rows", async () => {
    vi.mocked(getInstitutionsForExport).mockResolvedValue([] as never);

    const res = await GET(exportRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    expect(typeof body).toBe("string");
  });
});
