import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkforceDashboard } from "../dashboard";
import { WorkforceFilters } from "../filters";
import { SubjectMatrix } from "../subject-matrix";
import { UtilizationTable } from "../utilization-table";
import {
  GrowthView,
  growthFilters,
  updateCourseOverride,
} from "../growth-view";
import { GrowthFlowChart } from "../growth-charts";
import { activate } from "../charts";
import { workforceFixture } from "../fixtures";
import {
  growthPreviewFixture,
  workforcePreviewFixture,
} from "../preview-fixtures";
import {
  fetchGrowthReport,
  fetchGrowthDetail,
  fetchGrowthExport,
} from "../growth-requests";
const filters = workforceFixture().query;
afterEach(() => vi.unstubAllGlobals());
describe("D3 workforce redesign", () => {
  it("starts with graphics and collapses the filter form and raw turnover data", () => {
    const html = renderToStaticMarkup(
      <WorkforceDashboard
        report={workforceFixture()}
        onQueryChange={() => {}}
      />,
    );
    expect(html).toContain('role="tablist"');
    for (const view of ["Overview", "Supply &amp; demand", "Tutors", "Growth"])
      expect(html).toContain(view);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Workforce movement");
    expect(html).toContain("Overall supply &amp; booked demand");
    expect(html).toContain("<svg");
    expect(html).not.toContain("<canvas");
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Filters/);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).toContain("3 ÷ 60 × 100 = 5%");
  });
  it("makes chart selection available with Enter and Space", () => {
    const selected = vi.fn(),
      preventDefault = vi.fn();
    for (const key of ["Enter", " "])
      activate({ key, preventDefault }, selected);
    expect(selected).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    activate({ key: "ArrowDown", preventDefault }, selected);
    expect(selected).toHaveBeenCalledTimes(2);
  });
  it("renders shared scales, unknown cells and all three rates without clamping", () => {
    const fixture = workforceFixture(),
      matrix = renderToStaticMarkup(
        <SubjectMatrix
          rows={fixture.subjects}
          months={fixture.months.map((m) => m.month)}
          onSelect={() => {}}
        />,
      ),
      people = renderToStaticMarkup(
        <UtilizationTable people={fixture.people} onSelect={() => {}} />,
      );
    expect(matrix).toContain("patternUnits");
    expect(matrix).toContain("Unavailable ≠ zero");
    expect(matrix).toContain('aria-label="Expand Mathematics"');
    expect(matrix).toContain("0 h");
    expect(matrix).toContain("Unavailable");
    for (const label of [
      "Reserved utilization",
      "Credit-consumed utilization",
      "Recorded teaching utilization",
      "125%",
      "100%",
      "View data &amp; exceptions",
    ])
      expect(people).toContain(label);
  });
  it("enforces the institution-wide growth request while preserving academic/date filters", () => {
    const selected = {
      ...filters,
      role: "tutor" as const,
      modality: "online" as const,
      subject: "Physics",
      curriculum: "IGCSE",
      level: "G10",
    };
    expect(growthFilters(selected)).toEqual({
      ...selected,
      role: "all",
      modality: "all",
    });
    const html = renderToStaticMarkup(
      <WorkforceFilters
        query={selected}
        subjects={workforceFixture().subjects}
        growthScope
        onChange={() => {}}
      />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
  it("keys overrides by exact course identity, preserves other courses and removes cleared assumptions", () => {
    const a = "Math|IGCSE|G10",
      b = "Math|Alevel|G12";
    const initial = {
      bufferPercent: 20,
      subjects: {
        [a]: { newStudentHours: 4, churnStudentHours: 1 },
        [b]: { newStudentHours: 8 },
      },
    };
    const next = updateCourseOverride(initial, a, "newStudentHours", "0");
    expect(next.subjects?.[a].newStudentHours).toBe(0);
    expect(next.subjects?.[b]).toEqual(initial.subjects[b]);
    const cleared = updateCourseOverride(next, a, "newStudentHours", "");
    expect(cleared.subjects?.[a]).toEqual({ churnStudentHours: 1 });
    expect(initial.subjects[a].newStudentHours).toBe(4);
  });
  it("shows observed flows, signed loss axis, starting cohort, unknown forecasts and hiring benchmarks", () => {
    const report = growthPreviewFixture(),
      flow = renderToStaticMarkup(
        <GrowthFlowChart
          rows={report.flows.months.filter((r) => r.subject === "Mathematics")}
          onSelect={() => {}}
        />,
      ),
      html = renderToStaticMarkup(
        <GrowthView filters={filters} initial={report} />,
      );
    expect(flow).toContain("−5");
    expect(flow).toContain("Starting cohort · excluded from growth averages");
    for (const text of [
      "All teaching staff · all modes",
      "Three-month monthly mean",
      "Jun 2026",
      "Aug 2026",
      "Flat demand",
      "Course hiring estimates",
      "Mean matching",
      "total offered",
      "known",
      "Reset to measured model",
      "Unavailable",
    ]) {
      if (text === "known") expect(html).toContain("Known / eligible");
      else expect(html).toContain(text);
    }
    expect(html).not.toContain("May–July");
  });
  it("shows unavailable projection month when an academic filter returns no courses", () => {
    const selected = { ...filters, subject: "Unmapped subject" },
      report = growthPreviewFixture(selected),
      html = renderToStaticMarkup(
        <GrowthView filters={selected} initial={report} />,
      );
    expect(html).toContain("Projection unavailable");
    expect(html).not.toContain("Invalid Date");
  });
  it("uses a coherent varied preview, exact averages and twelve projection points per course", () => {
    const workforce = workforcePreviewFixture(),
      growth = growthPreviewFixture();
    expect(
      new Set(workforce.months.map((m) => m.turnoverPercent.value)).size,
    ).toBeGreaterThan(3);
    expect(growth.flows.commonWindow).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
    for (const avg of growth.flows.averages.filter(
      (a) => a.subject !== "English",
    )) {
      const rows = growth.flows.months.filter(
        (m) => m.courseKey === avg.courseKey && avg.months.includes(m.month),
      );
      expect(rows.every((r) => r.mature && !r.provisional)).toBe(true);
      expect(rows.reduce((n, r) => n + r.newStudentHours.value!, 0) / 3).toBe(
        avg.newStudentHours.value,
      );
      expect(
        rows.reduce((n, r) => n + r.reactivatedStudentHours.value!, 0) / 3,
      ).toBeCloseTo(avg.reactivatedStudentHours.value!);
      expect(
        rows.reduce((n, r) => n + r.churnStudentHours.value!, 0) / 3,
      ).toBeCloseTo(avg.churnStudentHours.value!);
      expect(
        growth.forecast.months.filter((m) => m.courseKey === avg.courseKey),
      ).toHaveLength(12);
    }
    expect(
      growth.flows.averages.slice(0, 3).map((a) => a.newStudentHours.value),
    ).toEqual([2, 3, 5]);
  });
});
describe("Growth UI requests", () => {
  const signal = new AbortController().signal;
  it("GETs measured defaults and POSTs explicit scenario inputs with no saved writes", async () => {
    const report = growthPreviewFixture(),
      fetch = vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify(report), {
            headers: { "Content-Type": "application/json" },
          }),
      );
    vi.stubGlobal("fetch", fetch);
    await fetchGrowthReport(report.query, signal, true);
    expect(fetch.mock.calls[0][0]).toContain("growth?from=");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", signal });
    const scenario = {
      ...report.query,
      assumptions: {
        bufferPercent: 20,
        subjects: {
          [report.forecast.inputs[0].courseKey]: { newStudentHours: 8 },
        },
      },
    };
    await fetchGrowthReport(scenario, signal);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(scenario);
    expect(fetch.mock.calls[1][1].method).toBe("POST");
  });
  it("rejects missing metrics rather than displaying zero forecasts", async () => {
    const report = growthPreviewFixture();
    delete (report.forecast.months[0] as unknown as Record<string, unknown>)
      .bookedTutorHours;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(report))),
    );
    await expect(fetchGrowthReport(report.query, signal)).rejects.toThrow(
      "incomplete",
    );
  });
  it("preserves revision errors and refuses a mismatched detail or non-CSV export", async () => {
    const report = growthPreviewFixture(),
      query = {
        ...report.query,
        reportRevision: report.reportRevision,
        kind: "cohort" as const,
        key: "course",
      };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Report changed" }), {
          status: 409,
        }),
      ),
    );
    await expect(fetchGrowthDetail(query, signal)).rejects.toMatchObject({
      status: 409,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            reportRevision: "different",
            sessions: [],
            events: [],
            observations: [],
            exceptions: [],
            contributors: {},
          }),
        ),
      ),
    );
    await expect(fetchGrowthDetail(query, signal)).rejects.toThrow(
      "incomplete",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(
      fetchGrowthExport(
        report.query,
        report.reportRevision,
        "forecast",
        signal,
      ),
    ).rejects.toThrow("CSV");
  });
});
