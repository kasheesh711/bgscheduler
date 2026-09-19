import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WeekendAllocationReport } from "../weekend-allocation-report";
import { weekendReportFixture } from "@/lib/classrooms/__tests__/fixtures/weekend-report";

describe("versioned weekend allocation report", () => {
  it("shows separate saved, Wise-verified and hypothetical outcomes with blocked-day warnings", () => {
    const html = renderToStaticMarkup(<WeekendAllocationReport report={weekendReportFixture} />);
    for (const text of ["Allocation saved", "saturday-run", "Allocation withheld", "Source data incomplete", "8 confirmed by live read-back, 2 pending",
      "Proposed student switches", "Student B", "not a confirmed switching rate", "Teach elsewhere — classroom released", "Recommendations do not clear readiness warnings"]) expect(html).toContain(text);
    expect(html).not.toContain("10 classes · 0 without rooms");
  });
  it("keeps old payloads compatible and gives each day a unique overflow heading", () => {
    expect(renderToStaticMarkup(<WeekendAllocationReport report={{ ...weekendReportFixture, version: undefined }} />)).toBe("");
    const report = structuredClone(weekendReportFixture);
    report.days[1] = { ...report.days[0], date: "2026-09-27" };
    const html = renderToStaticMarkup(<WeekendAllocationReport report={report} />);
    expect(html.match(/id="weekend-overflow-2026-09-26"/g)).toHaveLength(1);
    expect(html.match(/id="weekend-overflow-2026-09-27"/g)).toHaveLength(1);
  });
});
