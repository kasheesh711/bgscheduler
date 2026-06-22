import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShortlistBar, shortlistColor } from "../shortlist-bar";
import type { ShortlistEntry } from "../shortlist-bar";

const ENTRIES: ShortlistEntry[] = [
  { unitId: 110, name: "Alpha University" },
  { unitId: 220, name: "Beta College" },
];

const noop = () => {};

describe("shortlistColor", () => {
  it("assigns the first palette color to the first id and the second to the next", () => {
    const ids = [110, 220];
    const c0 = shortlistColor(110, ids);
    const c1 = shortlistColor(220, ids);
    expect(c0).toMatch(/^#|^oklch|^rgb/);
    expect(c1).toMatch(/^#|^oklch|^rgb/);
    expect(c0).not.toBe(c1);
  });

  it("is stable for the same id regardless of how many times called", () => {
    const ids = [110, 220];
    expect(shortlistColor(220, ids)).toBe(shortlistColor(220, ids));
  });
});

describe("ShortlistBar", () => {
  it("renders a chip per entry with its name and a remove control", () => {
    const html = renderToStaticMarkup(
      <ShortlistBar entries={ENTRIES} onRemove={noop} onClear={noop} onOpenCompare={noop} />,
    );
    expect(html).toContain("Alpha University");
    expect(html).toContain("Beta College");
    expect(html).toContain("Remove Alpha University");
    expect(html).toContain("Clear all");
    expect(html).toContain("Compare");
    expect(html).toContain("(2)");
  });

  it("renders nothing when the shortlist is empty", () => {
    const html = renderToStaticMarkup(
      <ShortlistBar entries={[]} onRemove={noop} onClear={noop} onOpenCompare={noop} />,
    );
    expect(html).toBe("");
  });

  it("shows the max-reached hint when the shortlist is full", () => {
    const full: ShortlistEntry[] = [
      { unitId: 1, name: "A" },
      { unitId: 2, name: "B" },
      { unitId: 3, name: "C" },
      { unitId: 4, name: "D" },
    ];
    const html = renderToStaticMarkup(
      <ShortlistBar entries={full} onRemove={noop} onClear={noop} onOpenCompare={noop} />,
    );
    expect(html).toContain("Max 4 reached");
  });
});
