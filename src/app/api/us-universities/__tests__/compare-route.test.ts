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
import { getCompareInstitutions } from "@/lib/us-universities/data";
import { GET } from "../compare/route";

const authMock = auth as unknown as Mock;

const COMPARE_FIXTURE = [
  { unitId: 1, instName: "Alpha University", control: 1, acceptanceRate: 20, topMajor: { cip2: "11", label: "Computer Science", count: 40 } },
  { unitId: 2, instName: "Beta College", control: 2, acceptanceRate: 12, topMajor: null },
];

function compareRequest(query = ""): Request {
  return new Request(`http://localhost/api/us-universities/compare${query}`);
}

describe("GET /api/us-universities/compare", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-05-21T00:00:00.000Z" });
    vi.mocked(getCompareInstitutions).mockResolvedValue(COMPARE_FIXTURE as never);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(compareRequest("?ids=1,2"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getCompareInstitutions).not.toHaveBeenCalled();
  });

  it("returns 200 with the compared institutions for ids=1,2", async () => {
    const res = await GET(compareRequest("?ids=1,2"));

    expect(res.status).toBe(200);
    expect(getCompareInstitutions).toHaveBeenCalledWith([1, 2]);
    await expect(res.json()).resolves.toEqual({ institutions: COMPARE_FIXTURE });
  });

  it("returns 400 when the ids param is missing", async () => {
    const res = await GET(compareRequest());

    expect(res.status).toBe(400);
    expect(getCompareInstitutions).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: unknown };
    expect(body.error).toBeDefined();
  });

  it("returns 400 when ids contains no parseable integers", async () => {
    const res = await GET(compareRequest("?ids=foo,bar"));

    expect(res.status).toBe(400);
    expect(getCompareInstitutions).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ error: "No valid institution ids" });
  });
});
