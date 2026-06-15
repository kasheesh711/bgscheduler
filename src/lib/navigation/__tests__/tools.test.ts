import { describe, expect, it } from "vitest";
import {
  activeSection,
  canAccessHref,
  filterToolsByAccess,
  NAV_TOOLS,
  shortcutTools,
  visibleSections,
} from "@/lib/navigation/tools";

describe("navigation tool registry", () => {
  it("groups tools by business function in the chosen section order", () => {
    const sections = visibleSections(null);

    expect(sections.map((section) => section.label)).toEqual([
      "Scheduling & Tutors",
      "Student Lifecycle",
      "Finance & Revenue",
      "Market Intelligence",
      "Data & Audit",
    ]);
    expect(sections[0].tools.map((tool) => tool.href)).toContain("/leave-requests");
    expect(sections[1].tools.map((tool) => tool.href)).toEqual(["/progress-tests", "/student-promotions"]);
    expect(sections[3].tools.map((tool) => tool.href)).toEqual(["/competitor-intelligence"]);
  });

  it("filters tools by restricted allowedPages", () => {
    const tools = filterToolsByAccess(NAV_TOOLS, ["/progress-tests"]);

    expect(tools.map((tool) => tool.href)).toEqual(["/progress-tests"]);
    expect(canAccessHref("/", ["/progress-tests"])).toBe(false);
    expect(canAccessHref("/api/home/summary", ["/progress-tests"])).toBe(false);
  });

  it("allows Home only for full admins or multi-page restricted users", () => {
    expect(canAccessHref("/", null)).toBe(true);
    expect(canAccessHref("/", [])).toBe(false);
    expect(canAccessHref("/", ["/progress-tests"])).toBe(false);
    expect(canAccessHref("/", ["/progress-tests", "/student-promotions"])).toBe(true);
  });

  it("detects active sections and curated shortcuts", () => {
    expect(activeSection("/credit-control", null)).toBe("finance-revenue");
    expect(activeSection("/competitor-intelligence", null)).toBe("market-intelligence");
    expect(shortcutTools(null).map((tool) => tool.href)).toEqual([
      "/scheduler",
      "/search",
      "/class-assignments",
      "/data-health",
    ]);
  });
});
