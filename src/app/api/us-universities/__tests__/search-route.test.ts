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
import { searchInstitutions } from "@/lib/us-universities/data";
import { GET } from "../search/route";

const authMock = auth as unknown as Mock;

const SEARCH_FIXTURE = {
  rows: [
    { unitId: 100, instName: "Test University", city: "Palo Alto", stateAbbr: "CA", control: 2, acceptanceRate: 8 },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

function searchRequest(query = ""): Request {
  return new Request(`http://localhost/api/us-universities/search${query}`);
}

describe("GET /api/us-universities/search", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-05-21T00:00:00.000Z" });
    vi.mocked(searchInstitutions).mockResolvedValue(SEARCH_FIXTURE as never);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(searchRequest("?search=Test"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(searchInstitutions).not.toHaveBeenCalled();
  });

  it("returns 200 with the paginated result set", async () => {
    const res = await GET(searchRequest("?search=Test&states=CA&control=2&page=1&pageSize=25"));

    expect(res.status).toBe(200);
    expect(searchInstitutions).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual(SEARCH_FIXTURE);
  });

  it("forwards parsed filters to the data layer", async () => {
    await GET(searchRequest("?search=Test&states=CA,NY&control=1,2&maxNetPrice=30000&minGradRate=70&sort=acceptanceRate&dir=asc"));

    expect(searchInstitutions).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "Test",
        states: ["CA", "NY"],
        control: [1, 2],
        maxNetPrice: 30000,
        minGradRate: 70,
        sort: "acceptanceRate",
        dir: "asc",
      }),
    );
  });

  it("returns 400 when a numeric param fails Zod coercion", async () => {
    // page=abc coerces to NaN and fails .int().positive() in FilterQuerySchema.
    const res = await GET(searchRequest("?page=abc"));

    expect(res.status).toBe(400);
    expect(searchInstitutions).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: unknown };
    expect(body.error).toBeDefined();
  });
});
