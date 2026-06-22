import { describe, it, expect } from "vitest";
import { resolveSortKey, clampPagination, buildInstitutionConditions } from "../query";

describe("resolveSortKey", () => {
  it("passes a whitelisted key through", () => expect(resolveSortKey("acceptanceRate")).toBe("acceptanceRate"));
  it("falls back to default on injection attempt", () => expect(resolveSortKey("name; DROP TABLE")).toBe("instName"));
  it("falls back to default on undefined", () => expect(resolveSortKey(undefined)).toBe("instName"));
});

describe("clampPagination", () => {
  it("clamps pageSize to the max", () => expect(clampPagination({ pageSize: 9999 }).pageSize).toBe(100));
  it("floors page to 1", () => expect(clampPagination({ page: 0 }).page).toBe(1));
  it("computes offset from page + pageSize", () => {
    const r = clampPagination({ page: 3, pageSize: 50 });
    expect(r.offset).toBe(100);
    expect(r.limit).toBe(50);
  });
  it("defaults to page 1, pageSize 50", () => {
    const r = clampPagination({});
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(50);
  });
});

describe("buildInstitutionConditions", () => {
  it("always scopes by data year", () => {
    expect(buildInstitutionConditions({}, "2024-25")).toHaveLength(1);
  });
  it("adds one condition per active filter", () => {
    const c = buildInstitutionConditions(
      {
        search: "yale",
        states: ["CA", "NY"],
        control: [1],
        minAcceptance: 5,
        maxAcceptance: 50,
        maxNetPrice: 30000,
        minGradRate: 80,
      },
      "2024-25",
    );
    expect(c).toHaveLength(8);
  });
  it("ignores blank search", () => {
    expect(buildInstitutionConditions({ search: "   " }, "2024-25")).toHaveLength(1);
  });
});
