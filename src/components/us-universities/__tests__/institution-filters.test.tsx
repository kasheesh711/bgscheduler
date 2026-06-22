import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ALL_OPTION,
  InstitutionFilters,
  mergeFilter,
  parseNumericInput,
} from "../institution-filters";
import type { Cip2Option, FilterParams, StateFacet } from "@/lib/us-universities/types";

const STATES: StateFacet[] = [
  { state: "CA", count: 120 },
  { state: "NY", count: 90 },
];

const CIP2: Cip2Option[] = [
  { cip2: "11", label: "Computer & Information Sciences" },
  { cip2: "14", label: "Engineering" },
];

describe("mergeFilter", () => {
  it("shallow-merges a patch over the current value without mutating the input", () => {
    const value: FilterParams = { search: "mit", page: 3 };
    const next = mergeFilter(value, { search: "stanford", page: 1 });
    expect(next).toEqual({ search: "stanford", page: 1 });
    expect(value).toEqual({ search: "mit", page: 3 });
  });

  it("can clear a field by patching it to undefined", () => {
    const next = mergeFilter({ states: ["CA"] }, { states: undefined, page: 1 });
    expect(next.states).toBeUndefined();
    expect(next.page).toBe(1);
  });
});

describe("parseNumericInput", () => {
  it("returns undefined for blank or non-numeric input", () => {
    expect(parseNumericInput("")).toBeUndefined();
    expect(parseNumericInput("   ")).toBeUndefined();
    expect(parseNumericInput("abc")).toBeUndefined();
  });

  it("parses numeric strings", () => {
    expect(parseNumericInput("25")).toBe(25);
    expect(parseNumericInput(" 0 ")).toBe(0);
    expect(parseNumericInput("12.5")).toBe(12.5);
  });
});

describe("InstitutionFilters rendering", () => {
  // NOTE: base-ui Select renders its options/placeholder in a portal that does
  // not emit under renderToStaticMarkup, so we assert on the always-rendered
  // labels, trigger aria-labels, and the controlled text/number inputs.
  it("renders the search box, field labels, and select triggers", () => {
    const html = renderToStaticMarkup(
      <InstitutionFilters
        states={STATES}
        cip2Options={CIP2}
        value={{}}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Search institutions");
    expect(html).toContain("Filter by state");
    expect(html).toContain("Filter by control");
    expect(html).toContain("Filter by major");
    expect(html).toContain("Max accept %");
    expect(html).toContain("Max net price");
    expect(html).toContain("Min grad %");
  });

  it("reflects an existing search value and numeric range value", () => {
    expect(ALL_OPTION).toBe("__all__");
    const html = renderToStaticMarkup(
      <InstitutionFilters
        states={STATES}
        cip2Options={CIP2}
        value={{ search: "berkeley", maxAcceptance: 20 }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('value="berkeley"');
    expect(html).toContain('value="20"');
  });
});
