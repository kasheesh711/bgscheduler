import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PriceLadder, ladderBars } from "../price-ladder";

describe("ladderBars", () => {
  it("scales each present value to a percentage of the max present value", () => {
    const bars = ladderBars([
      { label: "Tuition", value: 30000 },
      { label: "Room & board", value: 15000 },
      { label: "Net price", value: 60000 },
    ]);
    expect(bars[0].widthPct).toBe(50);
    expect(bars[1].widthPct).toBe(25);
    expect(bars[2].widthPct).toBe(100);
    expect(bars[2].display).toBe("$60,000");
  });

  it("renders a missing value with no bar (widthPct null) and an em dash display", () => {
    const bars = ladderBars([
      { label: "Tuition", value: 30000 },
      { label: "Aid", value: null },
    ]);
    expect(bars[1].widthPct).toBeNull();
    expect(bars[1].value).toBeNull();
    expect(bars[1].display).toBe("—");
  });

  it("yields all-null bars when no value is present (no division by zero)", () => {
    const bars = ladderBars([
      { label: "A", value: null },
      { label: "B", value: undefined },
    ]);
    expect(bars.every((b) => b.widthPct === null)).toBe(true);
  });

  it("treats a non-finite value as absent", () => {
    const bars = ladderBars([{ label: "A", value: Number.NaN }]);
    expect(bars[0].widthPct).toBeNull();
    expect(bars[0].display).toBe("—");
  });
});

describe("PriceLadder", () => {
  it("renders each label and its formatted value", () => {
    const html = renderToStaticMarkup(
      <PriceLadder items={[{ label: "Tuition", value: 30000 }]} />,
    );
    expect(html).toContain("Tuition");
    expect(html).toContain("$30,000");
    expect(html).toContain("role=\"img\"");
  });

  it("shows an em dash for a missing value", () => {
    const html = renderToStaticMarkup(
      <PriceLadder items={[{ label: "Net price", value: null }]} />,
    );
    expect(html).toContain("Net price");
    expect(html).toContain("—");
  });
});
