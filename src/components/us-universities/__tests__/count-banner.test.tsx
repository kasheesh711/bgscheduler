import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CountBanner } from "../count-banner";

describe("CountBanner", () => {
  it("renders count and total with an aria-live region", () => {
    const html = renderToStaticMarkup(<CountBanner count={1234} total={2000} />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("1,234");
    expect(html).toContain("of 2,000");
    expect(html).toContain("tabular-nums");
  });

  it("renders an em-dash for a null count (never 0)", () => {
    const html = renderToStaticMarkup(<CountBanner count={null} total={2000} />);
    expect(html).toContain("—");
    expect(html).not.toContain(">0<");
  });

  it("renders an em-dash while loading even if a count is supplied", () => {
    const html = renderToStaticMarkup(<CountBanner count={50} total={2000} loading />);
    expect(html).toContain("—");
    expect(html).not.toContain("50");
  });
});
