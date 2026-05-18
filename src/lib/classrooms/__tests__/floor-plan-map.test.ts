import { describe, expect, it } from "vitest";
import { renderFloorPlanMapSvg } from "../floor-plan-map";

describe("floor plan map email SVG", () => {
  it("renders highlighted route markers for selected rooms", () => {
    const svg = renderFloorPlanMapSvg(["Focus", "Go All In (TV)"]);

    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="BeGifted floor plan"');
    expect(svg).toContain(">1</text>");
    expect(svg).toContain(">2</text>");
    expect(svg).toContain("Go All In");
    expect(svg).toContain("(TV)");
  });

  it("escapes unknown selected room input by ignoring rooms outside the floor plan", () => {
    const svg = renderFloorPlanMapSvg(["<script>alert(1)</script>"]);

    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("alert(1)");
  });
});
