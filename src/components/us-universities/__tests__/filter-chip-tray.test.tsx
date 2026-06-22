import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilterChipTray } from "../filter-chip-tray";
import type { UsUniversitiesOverview } from "@/lib/us-universities/types";

const OVERVIEW: UsUniversitiesOverview = {
  dataYear: "2024-25",
  totalInstitutions: 200,
  withAcceptanceRate: 180,
  avgAcceptanceRate: 62.5,
  states: [],
  controls: [],
  acceptanceBuckets: [],
  scatter: [],
  cip2Options: [],
  lastImportedAt: null,
};

describe("FilterChipTray", () => {
  it("renders nothing when no filters are active", () => {
    const html = renderToStaticMarkup(
      <FilterChipTray filters={{}} overview={OVERVIEW} onClear={() => {}} onClearAll={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("renders a chip per active facet plus a Clear all control", () => {
    const html = renderToStaticMarkup(
      <FilterChipTray
        filters={{ states: ["CA"], maxAcceptance: 25 }}
        overview={OVERVIEW}
        onClear={() => {}}
        onClearAll={() => {}}
      />,
    );
    expect(html).toContain("Remove filter CA");
    expect(html).toContain("Accept ≤25%");
    expect(html).toContain("Clear all");
  });
});
