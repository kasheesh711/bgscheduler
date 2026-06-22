import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OverviewCharts,
  buildAcceptanceBarData,
  buildAcceptanceTrendData,
  buildControlDoughnutData,
  buildScatterData,
  buildStateBarData,
} from "../overview-charts";
import type {
  AcceptanceBucket,
  AcceptanceTrendPoint,
  ControlFacet,
  ScatterPoint,
  StateFacet,
  UsUniversitiesOverview,
} from "@/lib/us-universities/types";

const PALETTE = ["#3b82f6", "#e67e22", "#7c3aed", "#10b981", "#64748b"];

const BUCKETS: AcceptanceBucket[] = [
  { label: "Under 20%", min: 0, max: 20, count: 12 },
  { label: "20–50%", min: 20, max: 50, count: 40 },
  { label: "Over 50%", min: 50, max: 100, count: 88 },
];

const SCATTER: ScatterPoint[] = [
  { unitId: 1, name: "Public U", cost: 25_000, gradRate: 70, control: 1 },
  { unitId: 2, name: "Nonprofit U", cost: 55_000, gradRate: 90, control: 2 },
  { unitId: 3, name: "For-profit U", cost: 18_000, gradRate: 40, control: 3 },
  { unitId: 4, name: "No grad", cost: 30_000, gradRate: null, control: 1 },
  { unitId: 5, name: "No cost", cost: null, gradRate: 60, control: 2 },
];

const STATES: StateFacet[] = Array.from({ length: 18 }, (_, index) => ({
  state: `S${String(index).padStart(2, "0")}`,
  count: 100 - index,
}));

const CONTROLS: ControlFacet[] = [
  { control: 1, label: "Public", count: 50 },
  { control: 2, label: "Private nonprofit", count: 30 },
  { control: 3, label: "Private for-profit", count: 5 },
];

const ACCEPTANCE_TREND: AcceptanceTrendPoint[] = [
  { dataYear: "2020-21", avgAcceptance: 60, n: 120 },
  { dataYear: "2021-22", avgAcceptance: null, n: 0 },
  { dataYear: "2022-23", avgAcceptance: 56, n: 125 },
  { dataYear: "2023-24", avgAcceptance: 54, n: 130 },
  { dataYear: "2024-25", avgAcceptance: 53, n: 135 },
];

describe("buildAcceptanceBarData", () => {
  it("maps bucket labels and counts onto the dataset in order", () => {
    const data = buildAcceptanceBarData(BUCKETS, "#000");
    expect(data.labels).toEqual(["Under 20%", "20–50%", "Over 50%"]);
    expect(data.datasets[0].data).toEqual([12, 40, 88]);
    expect(data.datasets[0].backgroundColor).toBe("#000");
  });
});

describe("buildScatterData", () => {
  it("drops points missing cost or gradRate and groups by control", () => {
    const { datasets } = buildScatterData(SCATTER, PALETTE);
    expect(datasets).toHaveLength(3);
    expect(datasets[0].label).toBe("Public");
    expect(datasets[0].data).toEqual([
      { x: 25_000, y: 70, unitId: 1, name: "Public U" },
    ]);
    // The Public point with a null gradRate (unitId 4) is excluded.
    expect(datasets[0].data.some((d) => d.unitId === 4)).toBe(false);
    expect(datasets[1].data).toEqual([
      { x: 55_000, y: 90, unitId: 2, name: "Nonprofit U" },
    ]);
    // The nonprofit point with a null cost (unitId 5) is excluded.
    expect(datasets[1].data.some((d) => d.unitId === 5)).toBe(false);
    expect(datasets[2].data).toEqual([
      { x: 18_000, y: 40, unitId: 3, name: "For-profit U" },
    ]);
  });
});

describe("buildStateBarData", () => {
  it("keeps only the top N states sorted by count descending", () => {
    const data = buildStateBarData(STATES, "#000", 15);
    expect(data.labels).toHaveLength(15);
    expect(data.labels[0]).toBe("S00");
    expect(data.datasets[0].data[0]).toBe(100);
    expect(data.labels).not.toContain("S17");
  });
});

describe("buildControlDoughnutData", () => {
  it("uses facet labels and counts", () => {
    const data = buildControlDoughnutData(CONTROLS, PALETTE);
    expect(data.labels).toEqual(["Public", "Private nonprofit", "Private for-profit"]);
    expect(data.datasets[0].data).toEqual([50, 30, 5]);
  });
});

describe("buildAcceptanceTrendData", () => {
  it("uses years as labels and avgAcceptance as values, dropping null years", () => {
    const data = buildAcceptanceTrendData(ACCEPTANCE_TREND, "#000");
    expect(data.labels).toEqual(["2020-21", "2022-23", "2023-24", "2024-25"]);
    expect(data.datasets[0].data).toEqual([60, 56, 54, 53]);
    // The 2021-22 point with a null avgAcceptance is excluded (never plotted as 0).
    expect(data.labels).not.toContain("2021-22");
    expect(data.datasets[0].data).not.toContain(0);
    expect(data.datasets[0].borderColor).toBe("#000");
  });
});

describe("OverviewCharts onFilter affordance", () => {
  const overview: UsUniversitiesOverview = {
    dataYear: "2024-25",
    totalInstitutions: 140,
    withAcceptanceRate: 130,
    avgAcceptanceRate: 55,
    states: STATES,
    controls: CONTROLS,
    acceptanceBuckets: BUCKETS,
    scatter: SCATTER,
    cip2Options: [],
    acceptanceTrend: ACCEPTANCE_TREND,
    lastImportedAt: null,
  };

  it("renders a click-to-filter hint when onFilter is provided", () => {
    const html = renderToStaticMarkup(
      <OverviewCharts overview={overview} active onSelect={() => {}} onFilter={() => {}} />,
    );
    expect(html).toContain("Click to filter");
  });

  it("omits the click-to-filter hint when onFilter is absent (back-compat)", () => {
    const html = renderToStaticMarkup(
      <OverviewCharts overview={overview} active onSelect={() => {}} />,
    );
    expect(html).not.toContain("Click to filter");
  });
});

describe("OverviewCharts rendering", () => {
  const overview: UsUniversitiesOverview = {
    dataYear: "2024-25",
    totalInstitutions: 140,
    withAcceptanceRate: 130,
    avgAcceptanceRate: 55,
    states: STATES,
    controls: CONTROLS,
    acceptanceBuckets: BUCKETS,
    scatter: SCATTER,
    cip2Options: [],
    acceptanceTrend: ACCEPTANCE_TREND,
    lastImportedAt: null,
  };

  it("renders all five chart card titles", () => {
    const html = renderToStaticMarkup(
      <OverviewCharts overview={overview} active onSelect={() => {}} />,
    );
    expect(html).toContain("Admissions selectivity");
    expect(html).toContain("Cost vs. 6-year graduation rate");
    expect(html).toContain("Universities by state");
    expect(html).toContain("Public vs. private mix");
    expect(html).toContain("Acceptance rate over time");
  });
});
