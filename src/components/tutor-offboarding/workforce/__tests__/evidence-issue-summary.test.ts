import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidenceIssueSummary } from "../evidence-issue-summary";

describe("large repeated evidence issues", () => {
  it("renders one counted row per code/message without losing the total or mutating evidence", () => {
    const issues = Array.from({ length: 18_000 }, (_, id) => ({ code: "UNMAPPED", message: "Academic mapping needs review.", entityId: `session${id}` }));
    issues.push({ code: "UNMAPPED", message: "Title missing.", entityId: "last" });
    const html = renderToStaticMarkup(createElement(EvidenceIssueSummary, { issues }));
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).toContain("18,001 evidence issues");
    expect(html).toContain("18,000 occurrences");
    expect(html).toContain("Title missing.");
    expect(html).toContain("Individual evidence remains in the report and CSV.");
    expect(issues).toHaveLength(18_001);
    expect(issues.at(-1)?.entityId).toBe("last");
  });
  it("renders nothing for no issues and keeps different issue codes distinct", () => {
    expect(renderToStaticMarkup(createElement(EvidenceIssueSummary, { issues: [] }))).toBe("");
    const html = renderToStaticMarkup(createElement(EvidenceIssueSummary, { issues: [{ code: "A", message: "Review." }, { code: "B", message: "Review." }] }));
    expect(html.match(/<li /g)).toHaveLength(2);
  });
});
