import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { workforceFixture, metric } from "../fixtures";
import {
  formatMetric,
  visibleSubjectRows,
  heatDomain,
  heatTone,
  changeFilter,
} from "../presentation";
import { WorkforceDashboard } from "../dashboard";
describe("workforce presentation", () => {
  it("keeps unknown distinct from a confirmed zero", () => {
    expect(formatMetric(metric(null))).toBe("Unavailable");
    expect(formatMetric(metric(0), "h")).toBe("0 h");
    expect(heatTone(metric(null), 10)).toBe("unknown");
    expect(heatTone(metric(0), 10)).toBe(0);
  });
  it("expands hierarchy without merging monthly rows and uses one comparable domain", () => {
    const rows = workforceFixture().subjects;
    expect(
      visibleSubjectRows(rows, new Set()).every((r) => r.depth === 0),
    ).toBe(true);
    expect(
      visibleSubjectRows(rows, new Set(["Mathematics"])).filter(
        (r) => r.depth === 1,
      ),
    ).toHaveLength(3);
    expect(
      visibleSubjectRows(
        rows,
        new Set(["Mathematics", "Mathematics/IGCSE"]),
      ).filter((r) => r.depth === 2),
    ).toHaveLength(3);
    expect(heatDomain(rows, "freeHours")).toBe(7);
  });
  it("resets dependent filters and constrains selected month to changed dates", () => {
    const query = {
      ...workforceFixture().query,
      subject: "Math",
      curriculum: "IGCSE",
      level: "G10",
    };
    expect(changeFilter(query, "subject", "Physics")).toEqual({
      ...query,
      subject: "Physics",
      curriculum: undefined,
      level: undefined,
    });
    expect(changeFilter(query, "to", "2026-09-30").viewMonth).toBe("2026-09");
  });
  it("renders selected-month math, all three rates, shared hours and quality without inventing history", () => {
    const html = renderToStaticMarkup(
      <WorkforceDashboard
        report={workforceFixture()}
        onQueryChange={() => {}}
      />,
    );
    for (const text of [
      "3 ÷ 60 × 100 = 5%",
      "Reserved utilization",
      "Credit-consumed utilization",
      "Recorded teaching utilization",
      "7 h",
      "Unavailable",
      "125%",
      "Approved leave",
      "Student bookings",
      "Shared capacity",
      "Source quality",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("shortage");
  });
});
