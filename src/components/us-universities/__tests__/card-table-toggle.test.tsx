import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardTableToggle } from "../card-table-toggle";

describe("CardTableToggle", () => {
  it("marks the cards button pressed when view is cards", () => {
    const html = renderToStaticMarkup(<CardTableToggle view="cards" onChange={() => {}} />);
    expect(html).toContain("Card view");
    expect(html).toContain("Table view");
    // The cards control reports pressed.
    expect(html).toMatch(/aria-label="Card view"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/aria-label="Table view"[^>]*aria-pressed="false"/);
  });

  it("marks the table button pressed when view is table", () => {
    const html = renderToStaticMarkup(<CardTableToggle view="table" onChange={() => {}} />);
    expect(html).toMatch(/aria-label="Table view"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/aria-label="Card view"[^>]*aria-pressed="false"/);
  });
});
