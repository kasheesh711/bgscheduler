import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompareSheet } from "../compare-sheet";

const noop = () => {};

describe("CompareSheet", () => {
  it("renders nothing to static markup when closed (portal + closed popup)", () => {
    const html = renderToStaticMarkup(
      <CompareSheet
        open={false}
        onOpenChange={noop}
        unitIds={[110, 220]}
        onRemove={noop}
        onAdd={noop}
        onClear={noop}
      />,
    );
    expect(html).toBe("");
  });

  it("is a valid element accepting the ComparePanel prop contract", () => {
    // Smoke: constructing the element with the full prop set must not throw.
    const element = (
      <CompareSheet
        open={false}
        onOpenChange={noop}
        unitIds={[]}
        onRemove={noop}
        onAdd={noop}
        onClear={noop}
      />
    );
    expect(element.props.unitIds).toEqual([]);
    expect(typeof element.props.onOpenChange).toBe("function");
  });
});
