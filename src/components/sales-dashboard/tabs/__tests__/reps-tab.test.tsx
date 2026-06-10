import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepMonthAgg, SalesDimensionsPayload } from "@/lib/sales-dashboard/types";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock("@/components/sales-dashboard/chart-canvas", () => ({
  chartColors: () => ({
    chart: ["#c1", "#c2", "#c3", "#c4", "#c5"],
    border: "#border",
    mutedForeground: "#muted",
  }),
  ChartCanvas: ({ config }: { config: { type?: string } }) => (
    <div data-testid="chart-canvas" data-chart-type={config.type} />
  ),
}));

vi.mock("@/components/sales-dashboard/transactions-table", () => ({
  TransactionsTable: ({ filter, from, to }: { filter: { rep?: string }; from?: string; to?: string }) => (
    <div data-testid="transactions-table" data-filter-rep={filter.rep} data-from={from} data-to={to} />
  ),
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  buildRepMonthlySeries,
  buildRepRail,
  buildRepRangeStats,
  computePaceVsTarget,
  repKeyOf,
  RepsTab,
} from "../reps-tab";

function makeRepMonth(overrides: Partial<RepMonthAgg> & Pick<RepMonthAgg, "rep" | "month">): RepMonthAgg {
  return {
    rev: 0,
    count: 0,
    revT: 0,
    revN: 0,
    revR: 0,
    cntT: 0,
    cntN: 0,
    cntR: 0,
    ...overrides,
  };
}

function makeDimensions(overrides: Partial<SalesDimensionsPayload> = {}): SalesDimensionsPayload {
  return {
    months: ["2026-04-01", "2026-05-01"],
    reps: [
      makeRepMonth({ rep: "Aom", month: "2026-04-01", rev: 40_000, count: 4, revN: 40_000, cntN: 4 }),
      makeRepMonth({ rep: "Aom", month: "2026-05-01", rev: 60_000, count: 5, revT: 10_000, cntT: 2, revR: 50_000, cntR: 3 }),
      makeRepMonth({ rep: "Bee", month: "2026-05-01", rev: 20_000, count: 2, revN: 20_000, cntN: 2 }),
    ],
    repFunnels: [
      { rep: "Aom", trialsHandled: 10, trialsConverted: 4, medianDaysToConvert: 7, topPrograms: [{ name: "Math", rev: 80_000 }], topPackages: [{ band: "20h", rev: 70_000 }] },
      { rep: "Bee", trialsHandled: 0, trialsConverted: 0, medianDaysToConvert: null, topPrograms: [], topPackages: [] },
    ],
    programs: [],
    packages: [],
    additionalMix: [],
    students: [],
    targetMonthlyRevenue: 1_000_000,
    unparsedPackageCount: 0,
    generatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockNavigation(query: string) {
  vi.mocked(useRouter).mockReturnValue({ replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/sales-dashboard");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>,
  );
}

// Month-key helpers (addMonths/monthsInRange/monthShortLabel) moved to
// @/lib/sales-dashboard/dates — covered by dates.test.ts.
describe("repKeyOf", () => {
  it("normalizes rep keys with trim, lowercase, and whitespace collapse", () => {
    expect(repKeyOf("  AOM   Smith ")).toBe("aom smith");
  });
});

describe("buildRepRail", () => {
  it("range-filters months, computes share, and sorts by revenue descending", () => {
    const rail = buildRepRail(makeDimensions().reps, "2026-05-01", "2026-05-31");
    expect(rail.map((entry) => entry.rep)).toEqual(["Aom", "Bee"]);
    expect(rail[0].rev).toBe(60_000);
    expect(rail[0].count).toBe(5);
    expect(rail[0].share).toBeCloseTo(0.75);
    expect(rail[1].share).toBeCloseTo(0.25);
  });

  it("computes delta vs the previous equal-length window and nulls it when that window is empty", () => {
    const rail = buildRepRail(makeDimensions().reps, "2026-05-01", "2026-05-31");
    const aom = rail.find((entry) => entry.key === "aom");
    const bee = rail.find((entry) => entry.key === "bee");
    // Aom: May 60k vs April 40k → +50%. Bee has no April revenue → null.
    expect(aom?.deltaPct).toBeCloseTo(0.5);
    expect(bee?.deltaPct).toBeNull();
  });

  it("collapses display-name variants of the same rep into one row", () => {
    const rail = buildRepRail(
      [
        makeRepMonth({ rep: "Aom", month: "2026-05-01", rev: 10_000, count: 1 }),
        makeRepMonth({ rep: "  aom ", month: "2026-05-01", rev: 5_000, count: 1 }),
      ],
      "2026-05-01",
      "2026-05-31",
    );
    expect(rail).toHaveLength(1);
    expect(rail[0].rev).toBe(15_000);
    expect(rail[0].count).toBe(2);
  });

  it("never caps the rail (all reps listed, no slice(0,10))", () => {
    const reps = Array.from({ length: 14 }, (_, index) =>
      makeRepMonth({ rep: `Rep ${String(index).padStart(2, "0")}`, month: "2026-05-01", rev: 1_000 + index, count: 1 }),
    );
    expect(buildRepRail(reps, "2026-05-01", "2026-05-31")).toHaveLength(14);
  });
});

describe("buildRepRangeStats / buildRepMonthlySeries", () => {
  it("aggregates range totals and the enrollment-type mix", () => {
    const stats = buildRepRangeStats(makeDimensions().reps, "aom", "2026-04-01", "2026-05-31");
    expect(stats.rev).toBe(100_000);
    expect(stats.count).toBe(9);
    expect(stats.avgTicket).toBeCloseTo(100_000 / 9);
    expect(stats.cntT).toBe(2);
    expect(stats.cntN).toBe(4);
    expect(stats.cntR).toBe(3);
    expect(stats.revT + stats.revN + stats.revR).toBe(100_000);
  });

  it("zero-fills months with no data in the monthly series", () => {
    const series = buildRepMonthlySeries(makeDimensions().reps, "bee", "2026-04-01", "2026-06-30");
    expect(series.months).toEqual(["2026-04-01", "2026-05-01", "2026-06-01"]);
    expect(series.labels).toEqual(["Apr 26", "May 26", "Jun 26"]);
    expect(series.revN).toEqual([0, 20_000, 0]);
    expect(series.revT).toEqual([0, 0, 0]);
  });
});

describe("computePaceVsTarget", () => {
  it("returns null when the sheet target is absent (fallback-only)", () => {
    expect(computePaceVsTarget(makeDimensions().reps, "aom", "2026-05-01", "2026-05-31", null)).toBeNull();
  });

  it("returns null for reps with no revenue history", () => {
    expect(computePaceVsTarget(makeDimensions().reps, "ghost", "2026-05-01", "2026-05-31", 1_000_000)).toBeNull();
  });

  it("apportions the target by whole-history share and measures pace on the range", () => {
    // Whole history: Aom 100k of 120k total → share 5/6.
    // Target for 1 month: 1,000,000 × 5/6 ≈ 833,333. May revenue 60k → pace 7.2%.
    const pace = computePaceVsTarget(makeDimensions().reps, "aom", "2026-05-01", "2026-05-31", 1_000_000);
    expect(pace).not.toBeNull();
    expect(pace!.share).toBeCloseTo(100_000 / 120_000);
    expect(pace!.target).toBeCloseTo(1_000_000 * (100_000 / 120_000));
    expect(pace!.pacePct).toBeCloseTo(60_000 / (1_000_000 * (100_000 / 120_000)));
  });
});

describe("RepsTab rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigation("tab=reps");
  });

  it("shows skeletons while dimensions load", () => {
    const html = renderToStaticMarkup(
      <RepsTab dimensions={null} loading from="2026-05-01" to="2026-05-31" />,
    );
    expect(html).toContain("Loading sales dimensions…");
    expect(html).toContain("animate-pulse");
  });

  it("renders the full rail, KPI row, conversion mix, trend chart, and rep-filtered transactions", () => {
    const html = renderToStaticMarkup(
      <RepsTab dimensions={makeDimensions()} loading={false} from="2026-05-01" to="2026-05-31" />,
    );
    // Rail lists both reps; top-revenue rep (Aom) is selected by default.
    expect(html).toContain("Aom");
    expect(html).toContain("Bee");
    expect(html).toContain("฿60,000");
    expect(html).toContain("฿20,000");
    // KPI row + funnel conversion (4/10 → 40%).
    expect(html).toContain("Trial conversion");
    expect(html).toContain("40%");
    expect(html).toContain("4/10 converted");
    // Conversion mix by enrollment type.
    expect(html).toContain("Conversion mix (enrollment types)");
    expect(html).toContain("New Student");
    expect(html).toContain("Renewal");
    // Monthly trend chart mounts through ChartCanvas.
    expect(html).toContain("data-testid=\"chart-canvas\"");
    expect(html).toContain("data-chart-type=\"bar\"");
    // Transactions are fetched only via <TransactionsTable> with the rep filter.
    expect(html).toContain("data-filter-rep=\"Aom\"");
    expect(html).toContain("data-from=\"2026-05-01\"");
    expect(html).toContain("data-to=\"2026-05-31\"");
    // Top programs/packages from the whole-history funnel.
    expect(html).toContain("Top programs");
    expect(html).toContain("Top packages");
    expect(html).toContain("Whole history");
    // Additional-revenue exclusion note (graft C).
    expect(html).toContain("Additional-revenue rows are excluded from rep groupings.");
  });

  it("labels pace as an indicative share-based target and hides it when the target is fallback-only", () => {
    const withTarget = renderToStaticMarkup(
      <RepsTab dimensions={makeDimensions()} loading={false} from="2026-05-01" to="2026-05-31" />,
    );
    expect(withTarget).toContain("indicative share-based target");

    const withoutTarget = renderToStaticMarkup(
      <RepsTab
        dimensions={makeDimensions({ targetMonthlyRevenue: null })}
        loading={false}
        from="2026-05-01"
        to="2026-05-31"
      />,
    );
    expect(withoutTarget).not.toContain("indicative share-based target");
  });

  it("selects the seeded rep from any display variant", () => {
    const html = renderToStaticMarkup(
      <RepsTab
        dimensions={makeDimensions()}
        loading={false}
        from="2026-05-01"
        to="2026-05-31"
        seed={{ tab: "reps", rep: "  BEE " }}
      />,
    );
    expect(html).toContain("data-filter-rep=\"Bee\"");
  });

  it("honors the ?rep= deep link", () => {
    mockNavigation("tab=reps&rep=bee");
    const html = renderToStaticMarkup(
      <RepsTab dimensions={makeDimensions()} loading={false} from="2026-05-01" to="2026-05-31" />,
    );
    expect(html).toContain("data-filter-rep=\"Bee\"");
  });

  it("renders an empty-rail message when the range has no rep activity", () => {
    const html = renderToStaticMarkup(
      <RepsTab dimensions={makeDimensions()} loading={false} from="2025-01-01" to="2025-01-31" />,
    );
    expect(html).toContain("No rep transactions in this range.");
    expect(html).toContain("Select a rep to see their drill-down.");
  });
});
