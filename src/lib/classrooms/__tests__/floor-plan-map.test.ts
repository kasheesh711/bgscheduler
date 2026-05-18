import { describe, expect, it } from "vitest";
import { FLOOR_PLAN_GUIDE_PATH } from "../floor-plan";
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

  it("renders the corridor guide path and keeps the Do It marker inside the room", () => {
    const svg = renderFloorPlanMapSvg(["Do It", "Joy (TV)"]);

    expect(svg).toContain(`d="${FLOOR_PLAN_GUIDE_PATH}"`);
    expect(svg).toContain('d="M600 300c0-37 45-55 155-55h0c110 0 155 18 155 55v50H600z"');
    expect(svg).toContain('<circle cx="650" cy="315"');
    expect(svg).toContain(">1</text>");
    expect(svg).toContain(">2</text>");
  });

  it("escapes unknown selected room input by ignoring rooms outside the floor plan", () => {
    const svg = renderFloorPlanMapSvg(["<script>alert(1)</script>"]);

    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("alert(1)");
  });
});
