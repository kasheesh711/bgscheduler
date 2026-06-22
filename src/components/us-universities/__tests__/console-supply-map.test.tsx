import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConsoleSupplyMap, supplyMapAriaLabel } from "../console-supply-map";
import type { IpedsInstitutionSummary } from "@/lib/us-universities/types";

function row(
  overrides: Partial<IpedsInstitutionSummary> & { unitId: number },
): IpedsInstitutionSummary {
  return {
    unitId: overrides.unitId,
    instName: overrides.instName ?? `U${overrides.unitId}`,
    latitude: overrides.latitude ?? null,
    longitude: overrides.longitude ?? null,
    // remaining columns are irrelevant to the map; cast keeps the test lean.
  } as unknown as IpedsInstitutionSummary;
}

describe("supplyMapAriaLabel", () => {
  it("states how many of the loaded rows are mappable", () => {
    expect(supplyMapAriaLabel(42, 50)).toBe(
      "Showing 42 of 50 loaded schools with mappable locations",
    );
  });
});

describe("ConsoleSupplyMap", () => {
  const rows = [
    row({ unitId: 1, latitude: 37, longitude: -95.5 }),
    row({ unitId: 2, latitude: null, longitude: null }),
  ];

  it("renders only the toggle when closed (no svg)", () => {
    const html = renderToStaticMarkup(
      <ConsoleSupplyMap rows={rows} open={false} onToggle={() => {}} />,
    );
    expect(html).toContain("<button");
    expect(html).not.toContain("<svg");
  });

  it("renders the map with one pin per plottable row when open", () => {
    const html = renderToStaticMarkup(
      <ConsoleSupplyMap rows={rows} open onToggle={() => {}} />,
    );
    expect(html).toContain("<svg");
    expect(html.match(/<circle/g) ?? []).toHaveLength(1);
  });

  it("shows a muted note when open with no mappable rows", () => {
    const html = renderToStaticMarkup(
      <ConsoleSupplyMap
        rows={[row({ unitId: 9, latitude: null, longitude: null })]}
        open
        onToggle={() => {}}
      />,
    );
    expect(html).not.toContain("<svg");
    expect(html).toContain("No mappable locations");
  });
});
