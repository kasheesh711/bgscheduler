import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsDotMap } from "../us-dot-map";
import type { DotMapPoint } from "@/lib/us-universities/dot-map";

const POINTS: DotMapPoint[] = [
  { unitId: 1, name: "Mid U", x: 400, y: 300 },
  { unitId: 2, name: "East U", x: 700, y: 200 },
];

describe("UsDotMap", () => {
  it("renders an SVG with the accessible label and one circle per point", () => {
    const html = renderToStaticMarkup(
      <UsDotMap points={POINTS} ariaLabel="Locations of 2 schools" />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Locations of 2 schools"');
    // 2 pins + nothing else circular in the base markup.
    expect(html.match(/<circle/g) ?? []).toHaveLength(2);
  });

  it("renders the silhouette outline path", () => {
    const html = renderToStaticMarkup(
      <UsDotMap points={POINTS} ariaLabel="map" />,
    );
    expect(html).toContain("<path");
  });

  it("returns nothing when there are no points and no chip", () => {
    const html = renderToStaticMarkup(<UsDotMap points={[]} ariaLabel="map" />);
    expect(html).toBe("");
  });

  it("renders an out-of-bounds chip when points are empty but a chipLabel is given", () => {
    const html = renderToStaticMarkup(
      <UsDotMap points={[]} ariaLabel="map" chipLabel="AK" />,
    );
    expect(html).toContain("AK");
    expect(html.match(/<circle/g) ?? []).toHaveLength(0);
  });

  it("emits an accessible name list of plotted school names", () => {
    const html = renderToStaticMarkup(
      <UsDotMap points={POINTS} ariaLabel="map" />,
    );
    expect(html).toContain("Mid U");
    expect(html).toContain("East U");
  });
});
