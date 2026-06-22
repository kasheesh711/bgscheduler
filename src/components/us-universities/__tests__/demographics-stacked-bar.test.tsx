import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DemographicsStackedBar, demographicSegments } from "../demographics-stacked-bar";

describe("demographicSegments", () => {
  it("keeps only non-null segments and assigns cumulative offsets", () => {
    const segs = demographicSegments([
      { key: "white", label: "White", pct: 50 },
      { key: "black", label: "Black", pct: null },
      { key: "hispanic", label: "Hispanic", pct: 30 },
    ]);
    expect(segs.map((s) => s.key)).toEqual(["white", "hispanic"]);
    expect(segs[0].offsetPct).toBe(0);
    expect(segs[0].widthPct).toBe(50);
    expect(segs[1].offsetPct).toBe(50);
    expect(segs[1].widthPct).toBe(30);
  });

  it("drops NaN and undefined percentages (fail-closed)", () => {
    const segs = demographicSegments([
      { key: "a", label: "A", pct: Number.NaN },
      { key: "b", label: "B", pct: undefined },
    ]);
    expect(segs).toEqual([]);
  });

  it("returns an empty list when nothing is present", () => {
    expect(demographicSegments([])).toEqual([]);
  });
});

describe("DemographicsStackedBar", () => {
  it("renders a labelled segment with its percentage", () => {
    const html = renderToStaticMarkup(
      <DemographicsStackedBar inputs={[{ key: "white", label: "White", pct: 60 }]} />,
    );
    expect(html).toContain("White");
    expect(html).toContain("60%");
    expect(html).toContain("role=\"img\"");
  });

  it("renders nothing-of-substance when all inputs are null", () => {
    const html = renderToStaticMarkup(
      <DemographicsStackedBar inputs={[{ key: "white", label: "White", pct: null }]} />,
    );
    expect(html).toContain("—");
  });
});
