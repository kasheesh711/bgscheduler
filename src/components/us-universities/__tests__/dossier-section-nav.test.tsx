import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DossierSectionNav, resolveActiveSection } from "../dossier-section-nav";

const sections = [
  { id: "admissions", label: "Admissions" },
  { id: "cost", label: "Cost" },
  { id: "outcomes", label: "Outcomes" },
];

describe("resolveActiveSection", () => {
  it("returns the first section (by declared order) that is currently visible", () => {
    expect(resolveActiveSection(sections, ["outcomes", "cost"])).toBe("cost");
    expect(resolveActiveSection(sections, ["admissions"])).toBe("admissions");
  });

  it("returns null when nothing is visible", () => {
    expect(resolveActiveSection(sections, [])).toBeNull();
  });

  it("ignores visible ids that are not declared sections", () => {
    expect(resolveActiveSection(sections, ["unknown", "outcomes"])).toBe("outcomes");
  });
});

describe("DossierSectionNav", () => {
  it("renders an anchor link for each section pointing at its id", () => {
    const html = renderToStaticMarkup(<DossierSectionNav sections={sections} activeId="cost" />);
    expect(html).toContain("href=\"#admissions\"");
    expect(html).toContain("href=\"#cost\"");
    expect(html).toContain("Outcomes");
    expect(html).toContain("aria-current=\"true\"");
  });
});
