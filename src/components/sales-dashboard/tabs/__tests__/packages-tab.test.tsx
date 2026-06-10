import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AdditionalMixMonthAgg,
  PackageMonthAgg,
  SalesDimensionsPayload,
} from "@/lib/sales-dashboard/types";
import {
  buildPackageMixShift,
  filterToMonthRange,
  formatMonthShort,
  PackagesTab,
  resolveSeedBand,
  summarizeAdditionalMix,
  summarizePackageBands,
} from "../packages-tab";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=packages"),
}));

function makePackageAgg(overrides: Partial<PackageMonthAgg> = {}): PackageMonthAgg {
  return {
    packageBand: "20h",
    packageLabel: "20 Hours",
    hours: 20,
    month: "2026-03-01",
    rev: 40_000,
    count: 2,
    totalHoursSold: 40,
    ...overrides,
  };
}

function makeAdditionalAgg(overrides: Partial<AdditionalMixMonthAgg> = {}): AdditionalMixMonthAgg {
  return {
    month: "2026-03-01",
    salesType: "Books",
    rev: 1_500,
    count: 3,
    ...overrides,
  };
}

function makeDimensions(overrides: Partial<SalesDimensionsPayload> = {}): SalesDimensionsPayload {
  return {
    months: ["2026-02-01", "2026-03-01"],
    reps: [],
    repFunnels: [],
    programs: [],
    packages: [
      makePackageAgg({ month: "2026-02-01", rev: 60_000, count: 3, totalHoursSold: 60 }),
      makePackageAgg({ month: "2026-03-01", rev: 40_000, count: 2, totalHoursSold: 40 }),
      makePackageAgg({
        packageBand: "Trial",
        packageLabel: "Trial",
        hours: null,
        month: "2026-03-01",
        rev: 2_000,
        count: 4,
        totalHoursSold: null,
      }),
    ],
    additionalMix: [makeAdditionalAgg()],
    students: [],
    targetMonthlyRevenue: null,
    unparsedPackageCount: 3,
    generatedAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterToMonthRange", () => {
  const rows = [
    makePackageAgg({ month: "2026-01-01" }),
    makePackageAgg({ month: "2026-02-01" }),
    makePackageAgg({ month: "2026-03-01" }),
    makePackageAgg({ month: "2026-04-01" }),
  ];

  it("includes boundary months that only partially overlap the range", () => {
    const result = filterToMonthRange(rows, "2026-02-15", "2026-03-20");
    expect(result.map((row) => row.month)).toEqual(["2026-02-01", "2026-03-01"]);
  });

  it("treats blank bounds as open-ended", () => {
    expect(filterToMonthRange(rows, "", "")).toHaveLength(4);
    expect(filterToMonthRange(rows, "2026-03-01", "").map((row) => row.month)).toEqual([
      "2026-03-01",
      "2026-04-01",
    ]);
    expect(filterToMonthRange(rows, "", "2026-01-31").map((row) => row.month)).toEqual(["2026-01-01"]);
  });

  it("returns empty for a range with no overlapping months", () => {
    expect(filterToMonthRange(rows, "2027-01-01", "2027-02-01")).toEqual([]);
  });
});

describe("summarizePackageBands", () => {
  it("merges month cells per band and computes value metrics", () => {
    const summaries = summarizePackageBands([
      makePackageAgg({ month: "2026-02-01", rev: 60_000, count: 3, totalHoursSold: 60 }),
      makePackageAgg({ month: "2026-03-01", rev: 40_000, count: 2, totalHoursSold: 40 }),
    ]);
    expect(summaries).toHaveLength(1);
    const band = summaries[0];
    expect(band.band).toBe("20h");
    expect(band.txnCount).toBe(5);
    expect(band.revenue).toBe(100_000);
    expect(band.avgPackageValue).toBe(20_000);
    expect(band.avgPricePerHour).toBe(1_000); // 100,000 / 100h
    expect(band.hoursSold).toBe(100);
    expect(band.revenueShare).toBe(1);
  });

  it("keeps hour metrics null for bands without parsed hours", () => {
    const summaries = summarizePackageBands([
      makePackageAgg({ packageBand: "Trial", packageLabel: "Trial", hours: null, totalHoursSold: null, rev: 2_000, count: 4 }),
    ]);
    expect(summaries[0].avgPricePerHour).toBeNull();
    expect(summaries[0].hoursSold).toBeNull();
    expect(summaries[0].avgPackageValue).toBe(500);
  });

  it("orders bands canonically and shares sum to one", () => {
    const summaries = summarizePackageBands([
      makePackageAgg({ packageBand: "Other", packageLabel: "???", hours: null, totalHoursSold: null, rev: 1_000, count: 1 }),
      makePackageAgg({ packageBand: "40h+", packageLabel: "40 Hours", hours: 40, totalHoursSold: 80, rev: 50_000, count: 2 }),
      makePackageAgg({ packageBand: "Trial", packageLabel: "Trial", hours: null, totalHoursSold: null, rev: 2_000, count: 4 }),
      makePackageAgg({ rev: 47_000, count: 3 }),
    ]);
    expect(summaries.map((entry) => entry.band)).toEqual(["Trial", "20h", "40h+", "Other"]);
    const shareSum = summaries.reduce((sum, entry) => sum + entry.revenueShare, 0);
    expect(shareSum).toBeCloseTo(1, 10);
  });

  it("picks the most-sold label as the representative package", () => {
    const summaries = summarizePackageBands([
      makePackageAgg({ month: "2026-02-01", packageLabel: "20 ชม.", count: 1 }),
      makePackageAgg({ month: "2026-03-01", packageLabel: "20 Hours", count: 7 }),
    ]);
    expect(summaries[0].packageLabel).toBe("20 Hours");
  });
});

describe("buildPackageMixShift", () => {
  it("computes per-month shares that sum to 100 and sorts months", () => {
    const mix = buildPackageMixShift([
      makePackageAgg({ month: "2026-03-01", rev: 30_000 }),
      makePackageAgg({ packageBand: "Trial", packageLabel: "Trial", hours: null, totalHoursSold: null, month: "2026-03-01", rev: 10_000 }),
      makePackageAgg({ month: "2026-02-01", rev: 50_000 }),
    ]);
    expect(mix.months).toEqual(["2026-02-01", "2026-03-01"]);
    expect(mix.series.map((series) => series.band)).toEqual(["Trial", "20h"]);

    for (let index = 0; index < mix.months.length; index += 1) {
      const monthTotal = mix.series.reduce((sum, series) => sum + series.shares[index], 0);
      expect(monthTotal).toBeCloseTo(100, 8);
    }

    const trial = mix.series.find((series) => series.band === "Trial")!;
    expect(trial.shares[0]).toBe(0); // no trials in February
    expect(trial.shares[1]).toBeCloseTo(25, 8);
  });

  it("returns empty months for no rows", () => {
    expect(buildPackageMixShift([])).toEqual({ months: [], series: [] });
  });
});

describe("summarizeAdditionalMix", () => {
  it("aggregates across months by salesType with revenue-descending order", () => {
    const result = summarizeAdditionalMix([
      makeAdditionalAgg({ month: "2026-02-01", salesType: "Books", rev: 1_000, count: 2 }),
      makeAdditionalAgg({ month: "2026-03-01", salesType: "Books", rev: 1_500, count: 3 }),
      makeAdditionalAgg({ month: "2026-03-01", salesType: "Exam fee", rev: 7_500, count: 1 }),
    ]);
    expect(result.totalRevenue).toBe(10_000);
    expect(result.totalCount).toBe(6);
    expect(result.entries.map((entry) => entry.salesType)).toEqual(["Exam fee", "Books"]);
    expect(result.entries[0].share).toBeCloseTo(0.75, 10);
    expect(result.entries[1].count).toBe(5);
  });

  it("handles empty input without dividing by zero", () => {
    expect(summarizeAdditionalMix([])).toEqual({ entries: [], totalRevenue: 0, totalCount: 0 });
  });
});

describe("resolveSeedBand", () => {
  it("accepts known bands and rejects unknown or missing seeds", () => {
    expect(resolveSeedBand({ tab: "packages", band: "20h" })).toBe("20h");
    expect(resolveSeedBand({ tab: "packages", band: "Trial" })).toBe("Trial");
    expect(resolveSeedBand({ tab: "packages", band: "999h" })).toBeNull();
    expect(resolveSeedBand({ tab: "packages" })).toBeNull();
    expect(resolveSeedBand(undefined)).toBeNull();
  });
});

describe("formatMonthShort", () => {
  it("formats month starts like the GM command-center axis labels", () => {
    expect(formatMonthShort("2026-03-01")).toBe("Mar '26");
    expect(formatMonthShort("2025-12-01")).toBe("Dec '25");
  });

  it("falls back to the raw year-month for malformed input", () => {
    expect(formatMonthShort("2026-13-01")).toBe("2026-13");
  });
});

describe("PackagesTab", () => {
  it("renders the loading skeleton while dimensions are in flight", () => {
    const html = renderToStaticMarkup(
      <PackagesTab dimensions={null} loading from="2026-02-01" to="2026-03-31" />,
    );
    expect(html).toContain("Loading sales dimensions");
    expect(html).toContain("animate-pulse");
  });

  it("renders an unavailable message when the fetch failed", () => {
    const html = renderToStaticMarkup(
      <PackagesTab dimensions={null} loading={false} from="2026-02-01" to="2026-03-31" />,
    );
    expect(html).toContain("Sales dimensions are unavailable");
  });

  it("renders KPIs, band table, mix sections, and fail-soft notes", () => {
    const html = renderToStaticMarkup(
      <PackagesTab dimensions={makeDimensions()} loading={false} from="2026-02-01" to="2026-03-31" />,
    );
    // KPI strip — average package value over 100,000 + 2,000 across 9 txns.
    expect(html).toContain("Avg package value");
    expect(html).toContain("฿102,000"); // package revenue total
    expect(html).toContain("Hours distribution");
    expect(html).toContain("Mix shift over time");
    // Band table rows.
    expect(html).toContain("20h");
    expect(html).toContain("Trial");
    expect(html).toContain("Avg ฿/hour");
    // unparsedPackageCount fail-soft note.
    expect(html).toContain("could not be parsed into an hours band");
    expect(html).toContain("revenue is retained");
    // Additional-revenue exclusion note + per-type mix.
    expect(html).toContain("excluded from the package bands and histogram above");
    expect(html).toContain("Additional revenue by sales type");
    expect(html).toContain("Books");
  });

  it("scopes bands and additional mix to the shell period range", () => {
    const html = renderToStaticMarkup(
      <PackagesTab dimensions={makeDimensions()} loading={false} from="2026-03-01" to="2026-03-31" />,
    );
    // Only March rows: 40,000 (20h) + 2,000 (Trial).
    expect(html).toContain("฿42,000");
    expect(html).not.toContain("฿102,000");
  });

  it("shows the empty state when no package rows fall inside the range", () => {
    const html = renderToStaticMarkup(
      <PackagesTab
        dimensions={makeDimensions({ additionalMix: [] })}
        loading={false}
        from="2027-01-01"
        to="2027-01-31"
      />,
    );
    expect(html).toContain("No package sales in the selected period");
    expect(html).not.toContain("Additional revenue by sales type");
  });

  it("pre-selects the band from a GM cross-link seed", () => {
    const html = renderToStaticMarkup(
      <PackagesTab
        dimensions={makeDimensions()}
        loading={false}
        from="2026-02-01"
        to="2026-03-31"
        seed={{ tab: "packages", band: "20h" }}
      />,
    );
    expect(html).toContain("Clear filter");
    expect(html).toContain("aria-selected=\"true\"");
    expect(html).toContain("additional-revenue rows are excluded");
  });

  it("omits the unparsed note when every package value parsed", () => {
    const html = renderToStaticMarkup(
      <PackagesTab
        dimensions={makeDimensions({ unparsedPackageCount: 0 })}
        loading={false}
        from="2026-02-01"
        to="2026-03-31"
      />,
    );
    expect(html).not.toContain("could not be parsed into an hours band");
  });
});
