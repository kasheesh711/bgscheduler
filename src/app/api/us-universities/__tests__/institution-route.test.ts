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
import { getInstitutionProfile } from "@/lib/us-universities/data";
import { GET } from "../institutions/[unitId]/route";

const authMock = auth as unknown as Mock;

const PROFILE_FIXTURE = {
  unitId: 100,
  instName: "Test University",
  city: "Palo Alto",
  stateAbbr: "CA",
  control: 2,
  acceptanceRate: 8,
  completions: [],
  topMajors: [{ cip2: "11", label: "Computer Science", count: 120 }],
};

function institutionRequest(): Request {
  return new Request("http://localhost/api/us-universities/institutions/100");
}

function ctx(unitId: string) {
  return { params: Promise.resolve({ unitId }) };
}

describe("GET /api/us-universities/institutions/[unitId]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-05-21T00:00:00.000Z" });
    vi.mocked(getInstitutionProfile).mockResolvedValue(PROFILE_FIXTURE as never);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(institutionRequest(), ctx("100"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getInstitutionProfile).not.toHaveBeenCalled();
  });

  it("returns 200 with the profile when found", async () => {
    const res = await GET(institutionRequest(), ctx("100"));

    expect(res.status).toBe(200);
    expect(getInstitutionProfile).toHaveBeenCalledWith(100);
    await expect(res.json()).resolves.toEqual(PROFILE_FIXTURE);
  });

  it("returns 404 when the institution is missing", async () => {
    vi.mocked(getInstitutionProfile).mockResolvedValue(null as never);

    const res = await GET(institutionRequest(), ctx("100"));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Institution not found" });
  });

  it("returns 400 when the unitId param is non-numeric", async () => {
    const res = await GET(institutionRequest(), ctx("abc"));

    expect(res.status).toBe(400);
    expect(getInstitutionProfile).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: unknown };
    expect(body.error).toBeDefined();
  });
});
