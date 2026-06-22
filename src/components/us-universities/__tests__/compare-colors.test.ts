import { describe, expect, it } from "vitest";
import { compareColorIndex } from "../compare-colors";

describe("compareColorIndex", () => {
  it("returns the position of the unit id in the ordered list", () => {
    expect(compareColorIndex(110, [110, 220, 330])).toBe(0);
    expect(compareColorIndex(220, [110, 220, 330])).toBe(1);
    expect(compareColorIndex(330, [110, 220, 330])).toBe(2);
  });

  it("clamps a 5th-or-later position into the 0..4 chart range", () => {
    // orderedIds longer than MAX_COMPARE should never exceed index 4.
    expect(compareColorIndex(60, [10, 20, 30, 40, 50, 60])).toBe(4);
    expect(compareColorIndex(50, [10, 20, 30, 40, 50, 60])).toBe(4);
  });

  it("returns 0 for an id not present in the ordered list (fail-safe color)", () => {
    expect(compareColorIndex(999, [110, 220])).toBe(0);
    expect(compareColorIndex(1, [])).toBe(0);
  });
});
