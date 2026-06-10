import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProgramMonthAgg, SalesDimensionsPayload } from "@/lib/sales-dashboard/types";

// Chart.js cannot initialize in the node test environment; replace the shared
// canvas with an inspectable stub (the panel only passes a config through).
vi.mock("@/components/sales-dashboard/chart-canvas", () => ({
  chartColors: () => ({
    chart: ["#c1", "#c2", "#c3", "#c4", "#c5"],
    border: "#border",
    mutedForeground: "#muted",
  }),
  ChartCanvas: ({ config, active }: { config: { type?: string; data?: { labels?: unknown[]; datasets?: { label?: string }[] } }; active?: boolean }) => (
    <div
      data-testid="chart-canvas"
      data-type={config.type}
      data-active={String(active)}
      data-labels={JSON.stringify(config.data?.labels ?? [])}
      data-series={JSON.stringify((config.data?.datasets ?? []).map((dataset) => dataset.label))}
    />
  ),
}));

import {
  ProgramsTab,
  buildProgramMonthlySeries,
  buildProgramTableRows,
  buildShareSegments,
  compareProgramRows,
  formatMonthLabel,
  previousMonthOf,
  toMonthStart,
} from "../programs-tab";

function makeAgg(overrides: Partial<ProgramMonthAgg> = {}): ProgramMonthAgg {
  return {
    program: "Math",
    month: "2026-01-01",
    rev: 10000,
    count: 1,
    students: 1,
    revT: 0,
    revN: 10000,
    revR: 0,
    ...overrides,
  };
}

const FIXTURE_PROGRAMS: ProgramMonthAgg[] = [
  makeAgg({ program: "Math", month: "2026-01-01", rev: 30000, revT: 2000, revN: 20000, revR: 8000, count: 3, students: 3 }),
  makeAgg({ program: "Math", month: "2026-02-01", rev: 50000, revT: 0, revN: 30000, revR: 20000, count: 4, students: 4 }),
  makeAgg({ program: "English", month: "2026-02-01", rev: 20000, revT: 5000, revN: 15000, revR: 0, count: 2, students: 2 }),
  // Outside the test range — must be excluded from range rows but still
  // reachable for MoM lookups when it is the previous calendar month.
  makeAgg({ program: "Coding", month: "2025-12-01", rev: 99999, revN: 99999, count: 5, students: 5 }),
];

const ALL_MONTHS = ["2025-12-01", "2026-01-01", "2026-02-01"];

function makeDimensions(overrides: Partial<SalesDimensionsPayload> = {}): SalesDimensionsPayload {
  return {
    months: ALL_MONTHS,
    reps: [],
    repFunnels: [],
    programs: FIXTURE_PROGRAMS,
    packages: [],
    additionalMix: [],
    students: [],
    targetMonthlyRevenue: null,
    unparsedPackageCount: 0,
    generatedAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

const RANGE = { from: "2026-01-01", to: "2026-03-31", includeTrials: true, allMonths: ALL_MONTHS };

describe("month helpers", () => {
  it("derives month starts and previous calendar months (incl. year boundary)", () => {
    expect(toMonthStart("2026-03-15")).toBe("2026-03-01");
    expect(previousMonthOf("2026-03-01")).toBe("2026-02-01");
    expect(previousMonthOf("2026-01-01")).toBe("2025-12-01");
  });

  it("formats month labels", () => {
    expect(formatMonthLabel("2026-04-01")).toBe("Apr 26");
    expect(formatMonthLabel("garbage")).toBe("garbage");
  });
});

describe("buildProgramTableRows", () => {
  it("aggregates only months inside the range and computes share + avg ticket", () => {
    const rows = buildProgramTableRows(FIXTURE_PROGRAMS, RANGE);

    expect(rows.map((row) => row.program)).toEqual(["Math", "English"]);
    const math = rows[0];
    expect(math.rev).toBe(80000);
    expect(math.txn).toBe(7);
    expect(math.studentMonths).toBe(7);
    expect(math.avgTicket).toBeCloseTo(80000 / 7);
    expect(math.share).toBeCloseTo(0.8);
    const english = rows[1];
    expect(english.rev).toBe(20000);
    expect(english.share).toBeCloseTo(0.2);
    // Coding sits entirely outside the range.
    expect(rows.some((row) => row.program === "Coding")).toBe(false);
  });

  it("computes MoM movement against the previous calendar month", () => {
    const rows = buildProgramTableRows(FIXTURE_PROGRAMS, RANGE);

    const math = rows.find((row) => row.program === "Math")!;
    expect(math.momDelta).toBe(20000); // 50,000 (Feb) - 30,000 (Jan)
    expect(math.momPct).toBeCloseTo(20000 / 30000);

    // English has no Jan revenue: delta vs 0, pct null.
    const english = rows.find((row) => row.program === "English")!;
    expect(english.momDelta).toBe(20000);
    expect(english.momPct).toBeNull();
  });

  it("returns null movement when the previous calendar month has no data at all", () => {
    const rows = buildProgramTableRows(
      FIXTURE_PROGRAMS.filter((agg) => agg.month !== "2026-01-01"),
      { ...RANGE, from: "2026-02-01", allMonths: ["2025-12-01", "2026-02-01"] },
    );
    expect(rows.find((row) => row.program === "Math")!.momDelta).toBeNull();
  });

  it("excludes trial revenue from revenue, share, and movement when includeTrials=false", () => {
    const rows = buildProgramTableRows(FIXTURE_PROGRAMS, { ...RANGE, includeTrials: false });

    const math = rows.find((row) => row.program === "Math")!;
    expect(math.rev).toBe(78000); // 80,000 - 2,000 trial
    expect(math.txn).toBe(7); // counts keep all rows
    const english = rows.find((row) => row.program === "English")!;
    expect(english.rev).toBe(15000);
    expect(math.share).toBeCloseTo(78000 / 93000);
    expect(math.momDelta).toBe(50000 - 28000); // Feb 50,000 vs Jan 30,000-2,000
  });

  it("returns an empty array when no months fall inside the range", () => {
    expect(buildProgramTableRows(FIXTURE_PROGRAMS, { ...RANGE, from: "2027-01-01", to: "2027-12-31" })).toEqual([]);
  });
});

describe("buildProgramMonthlySeries", () => {
  it("emits one series per program with zero-filled months, sorted by range revenue", () => {
    const { months, series } = buildProgramMonthlySeries(FIXTURE_PROGRAMS, {
      from: "2026-01-01",
      to: "2026-03-31",
      includeTrials: true,
    });

    expect(months).toEqual(["2026-01-01", "2026-02-01"]);
    expect(series.map((entry) => entry.program)).toEqual(["Math", "English"]);
    expect(series[0].values).toEqual([30000, 50000]);
    expect(series[1].values).toEqual([0, 20000]);
    expect(series.every((entry) => !entry.isOther)).toBe(true);
  });

  it("folds programs beyond the top limit into Other", () => {
    const { series } = buildProgramMonthlySeries(FIXTURE_PROGRAMS, {
      from: "2026-01-01",
      to: "2026-03-31",
      includeTrials: true,
      topLimit: 1,
    });

    expect(series.map((entry) => entry.program)).toEqual(["Math", "Other"]);
    expect(series[1].isOther).toBe(true);
    expect(series[1].values).toEqual([0, 20000]); // English folded in
  });

  it("returns an empty shape for an empty range", () => {
    expect(buildProgramMonthlySeries([], { from: "2026-01-01", to: "2026-01-31", includeTrials: true }))
      .toEqual({ months: [], series: [] });
  });
});

describe("buildShareSegments", () => {
  it("keeps top programs and folds the rest into Other", () => {
    const rows = buildProgramTableRows(FIXTURE_PROGRAMS, RANGE);
    const segments = buildShareSegments(rows, 1);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ program: "Math", isOther: false });
    expect(segments[1].program).toBe("Other");
    expect(segments[1].share).toBeCloseTo(0.2);
  });
});

describe("compareProgramRows", () => {
  const rows = buildProgramTableRows(FIXTURE_PROGRAMS, RANGE);

  it("sorts numerically and alphabetically with direction", () => {
    const byRevAsc = [...rows].sort((left, right) => compareProgramRows(left, right, "rev", "asc"));
    expect(byRevAsc.map((row) => row.program)).toEqual(["English", "Math"]);
    const byNameDesc = [...rows].sort((left, right) => compareProgramRows(left, right, "program", "desc"));
    expect(byNameDesc.map((row) => row.program)).toEqual(["Math", "English"]);
  });

  it("sorts null MoM movement last on descending sort", () => {
    const withNull = [...rows, { ...rows[0], program: "Zero", momDelta: null, momPct: null }];
    const sorted = withNull.sort((left, right) => compareProgramRows(left, right, "mom", "desc"));
    expect(sorted.at(-1)!.program).toBe("Zero");
  });
});

describe("ProgramsTab rendering", () => {
  it("renders a skeleton while dimensions load", () => {
    const html = renderToStaticMarkup(
      <ProgramsTab dimensions={null} loading={true} from="2026-01-01" to="2026-03-31" />,
    );
    expect(html).toContain("Loading sales dimensions");
    expect(html).toContain("animate-pulse");
  });

  it("renders an unavailable message when dimensions failed to load", () => {
    const html = renderToStaticMarkup(
      <ProgramsTab dimensions={null} loading={false} from="2026-01-01" to="2026-03-31" />,
    );
    expect(html).toContain("Sales dimensions are unavailable");
  });

  it("renders the table, share strip, chart, and exclusion note with data", () => {
    const html = renderToStaticMarkup(
      <ProgramsTab dimensions={makeDimensions()} loading={false} from="2026-01-01" to="2026-03-31" />,
    );

    expect(html).toContain("Math");
    expect(html).toContain("English");
    expect(html).toContain("Share of revenue");
    expect(html).toContain("data-testid=\"chart-canvas\"");
    expect(html).toContain("Monthly revenue by program");
    expect(html).toContain("Additional-revenue rows are excluded from program groupings.");
    expect(html).toContain("MoM compares Feb 26 vs Jan 26");
    // Out-of-range program never leaks into the panel.
    expect(html).not.toContain("Coding");
    // No program selected yet — no detail drill.
    expect(html).not.toContain("program-detail");
  });

  it("renders an empty state when the range has no program revenue", () => {
    const html = renderToStaticMarkup(
      <ProgramsTab dimensions={makeDimensions()} loading={false} from="2027-01-01" to="2027-12-31" />,
    );
    expect(html).toContain("No program revenue in the selected period.");
  });

  it("does not unlock MoM movement off an additional-only previous month", () => {
    // dimensions.months says January exists (additional revenue only), but no
    // program row carries that month — MoM must stay gated off.
    const html = renderToStaticMarkup(
      <ProgramsTab
        dimensions={makeDimensions({
          months: ["2026-01-01", "2026-02-01"],
          programs: [
            makeAgg({ program: "Math", month: "2026-02-01", rev: 50000, revN: 50000, count: 4, students: 4 }),
          ],
        })}
        loading={false}
        from="2026-02-01"
        to="2026-02-28"
      />,
    );
    expect(html).toContain("No previous month in the data for MoM movement");
    expect(html).not.toContain("MoM compares");
  });

  it("consumes an explore seed by opening the program detail with its transactions drill", () => {
    const html = renderToStaticMarkup(
      <ProgramsTab
        dimensions={makeDimensions()}
        loading={false}
        from="2026-01-01"
        to="2026-03-31"
        seed={{ tab: "programs", program: "Math" }}
      />,
    );

    expect(html).toContain("data-testid=\"program-detail\"");
    expect(html).toContain("Math — program detail");
    expect(html).toContain("Revenue split");
    // TransactionsTable mounts in its loading state (fetch happens client-side).
    expect(html).toContain("Valid until");
  });
});
