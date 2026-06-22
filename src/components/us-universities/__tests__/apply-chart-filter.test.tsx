import { describe, expect, it } from "vitest";
import { applyChartFilter } from "../institution-table";
import type { FilterParams } from "@/lib/us-universities/types";

describe("applyChartFilter", () => {
  it("merges a patch over the current filters and resets page to 1", () => {
    const base: FilterParams = { sort: "instName", dir: "asc", page: 7, pageSize: 50 };
    const next = applyChartFilter(base, { states: ["CA"] });
    expect(next).toEqual({
      sort: "instName",
      dir: "asc",
      page: 1,
      pageSize: 50,
      states: ["CA"],
    });
  });

  it("overwrites overlapping facets and always pins page to 1 even if the patch sets a page", () => {
    const base: FilterParams = { states: ["TX"], minAcceptance: 10, page: 3 };
    const next = applyChartFilter(base, { states: ["CA"], maxAcceptance: 25, page: 9 });
    expect(next.states).toEqual(["CA"]);
    expect(next.minAcceptance).toBe(10);
    expect(next.maxAcceptance).toBe(25);
    expect(next.page).toBe(1);
  });

  it("does not mutate the input", () => {
    const base: FilterParams = { page: 4, states: ["NY"] };
    const next = applyChartFilter(base, { control: [1] });
    expect(base).toEqual({ page: 4, states: ["NY"] });
    expect(next).not.toBe(base);
  });
});
