import { describe, expect, it, vi } from "vitest";

// Mock heavy server-side dependencies so pure param helpers can be unit-tested
// without pulling in next-auth, next/navigation, or the DB layer.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/us-universities/data", () => ({ getInstitutionProfile: vi.fn() }));
vi.mock("@/components/us-universities/institution-dossier", () => ({ InstitutionDossier: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));

import { parseCompareParam, parseFilterParams, parseUnitId } from "../page";

describe("parseUnitId", () => {
  it("parses a positive integer", () => {
    expect(parseUnitId("166027")).toBe(166027);
  });
  it("rejects non-numeric, zero, and negative ids", () => {
    expect(parseUnitId("abc")).toBeNull();
    expect(parseUnitId("0")).toBeNull();
    expect(parseUnitId("-5")).toBeNull();
  });
});

describe("parseCompareParam", () => {
  it("parses a comma list of positive ints, capped at MAX_COMPARE (4)", () => {
    expect(parseCompareParam("1,2,3")).toEqual([1, 2, 3]);
    expect(parseCompareParam("1,2,3,4,5,6")).toEqual([1, 2, 3, 4]);
  });
  it("drops invalid entries and returns [] for undefined/blank", () => {
    expect(parseCompareParam("1,x,-2,0,7")).toEqual([1, 7]);
    expect(parseCompareParam(undefined)).toEqual([]);
    expect(parseCompareParam("")).toEqual([]);
  });
});

describe("parseFilterParams", () => {
  it("reconstructs filters from search-param shape", () => {
    const f = parseFilterParams({
      search: "tech", states: "CA,NY", control: "1,2",
      minAcceptance: "10", maxAcceptance: "40", maxNetPrice: "30000",
      minGradRate: "70", cip2: "11", sort: "acceptanceRate", dir: "desc",
      page: "2", pageSize: "50",
    });
    expect(f.search).toBe("tech");
    expect(f.states).toEqual(["CA", "NY"]);
    expect(f.control).toEqual([1, 2]);
    expect(f.minAcceptance).toBe(10);
    expect(f.maxNetPrice).toBe(30000);
    expect(f.cip2).toBe("11");
    expect(f.sort).toBe("acceptanceRate");
    expect(f.dir).toBe("desc");
    expect(f.page).toBe(2);
  });

  it("omits absent params and ignores an invalid dir", () => {
    const f = parseFilterParams({ dir: "sideways" });
    expect(f.search).toBeUndefined();
    expect(f.states).toBeUndefined();
    expect(f.dir).toBeUndefined();
  });
});
