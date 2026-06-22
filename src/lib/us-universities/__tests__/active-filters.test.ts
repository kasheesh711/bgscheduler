import { describe, expect, it } from "vitest";
import { describeActiveFilters } from "../active-filters";
import type { FilterParams, UsUniversitiesOverview } from "@/lib/us-universities/types";

const OVERVIEW: UsUniversitiesOverview = {
  dataYear: "2024-25",
  totalInstitutions: 200,
  withAcceptanceRate: 180,
  avgAcceptanceRate: 62.5,
  states: [],
  controls: [],
  acceptanceBuckets: [],
  acceptanceTrend: [],
  scatter: [],
  cip2Options: [],
  lastImportedAt: null,
};

describe("describeActiveFilters", () => {
  it("returns no chips for an empty / default filter", () => {
    expect(describeActiveFilters({ sort: "instName", dir: "asc", page: 1, pageSize: 50 }, OVERVIEW)).toEqual([]);
  });

  it("emits one chip per state with a clear patch that resets page", () => {
    const chips = describeActiveFilters({ states: ["CA", "TX"] }, OVERVIEW);
    expect(chips.map((c) => c.key)).toEqual(["state:CA", "state:TX"]);
    expect(chips[0]).toMatchObject({ label: "CA", clear: { states: undefined, page: 1 } });
  });

  it("collapses min/max acceptance into a single acceptance chip", () => {
    expect(describeActiveFilters({ maxAcceptance: 25 }, OVERVIEW)[0]).toMatchObject({
      key: "acceptance",
      label: "Accept ≤25%",
      clear: { minAcceptance: undefined, maxAcceptance: undefined, page: 1 },
    });
    expect(describeActiveFilters({ minAcceptance: 10 }, OVERVIEW)[0].label).toBe("Accept ≥10%");
    expect(describeActiveFilters({ minAcceptance: 10, maxAcceptance: 25 }, OVERVIEW)[0].label).toBe("Accept 10–25%");
  });

  it("labels control, net price, grad rate, cip2, and search", () => {
    const filters: FilterParams = {
      control: [1],
      maxNetPrice: 30000,
      minGradRate: 70,
      cip2: "11",
      search: "tech",
    };
    const byKey = Object.fromEntries(describeActiveFilters(filters, OVERVIEW).map((c) => [c.key, c.label]));
    expect(byKey["control:1"]).toBe("Public");
    expect(byKey["netPrice"]).toBe("Net ≤ $30,000");
    expect(byKey["gradRate"]).toBe("Grad ≥ 70%");
    expect(byKey["cip2"]).toBe("Computer & Information Sciences");
    expect(byKey["search"]).toBe(`"tech"`);
  });

  it("ignores blank search and unknown control codes gracefully", () => {
    expect(describeActiveFilters({ search: "   " }, OVERVIEW)).toEqual([]);
    const chips = describeActiveFilters({ control: [99] }, OVERVIEW);
    expect(chips[0]).toMatchObject({ key: "control:99", label: "Control 99" });
  });
});
