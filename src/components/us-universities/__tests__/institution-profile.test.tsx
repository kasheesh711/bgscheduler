import { describe, expect, it } from "vitest";
import { buildAdmissionsTrendChartData } from "../institution-profile";
import {
  admissionRequirements,
  formatPct,
  formatRatio,
  formatUsd,
} from "@/lib/us-universities/format";
import type { AdmissionsTrendPoint } from "@/lib/us-universities/types";

const EM_DASH = "—";

function trendPoint(overrides: Partial<AdmissionsTrendPoint>): AdmissionsTrendPoint {
  return {
    dataYear: "2020-21",
    acceptanceRate: null,
    yieldRate: null,
    applicantsTotal: null,
    admitsTotal: null,
    enrolledTotal: null,
    satReadingP25: null,
    satReadingP75: null,
    satMathP25: null,
    satMathP75: null,
    actCompositeP25: null,
    actCompositeP75: null,
    ...overrides,
  };
}

describe("formatUsd", () => {
  it("formats with a dollar sign and thousands separators", () => {
    expect(formatUsd(12_500)).toBe("$12,500");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(1_234_567)).toBe("$1,234,567");
  });

  it("renders a missing value as an em dash, never 0", () => {
    expect(formatUsd(null)).toBe(EM_DASH);
    expect(formatUsd(undefined)).toBe(EM_DASH);
    expect(formatUsd(Number.NaN)).toBe(EM_DASH);
  });
});

describe("formatPct", () => {
  it("appends a percent sign and trims to one decimal", () => {
    expect(formatPct(15)).toBe("15%");
    expect(formatPct(42.34)).toBe("42.3%");
    expect(formatPct(0)).toBe("0%");
  });

  it("renders a missing value as an em dash, never 0%", () => {
    expect(formatPct(null)).toBe(EM_DASH);
    expect(formatPct(undefined)).toBe(EM_DASH);
    expect(formatPct(Number.NaN)).toBe(EM_DASH);
  });
});

describe("formatRatio", () => {
  it("renders as N:1", () => {
    expect(formatRatio(14)).toBe("14:1");
    expect(formatRatio(8.5)).toBe("8.5:1");
  });

  it("renders a missing value as an em dash", () => {
    expect(formatRatio(null)).toBe(EM_DASH);
    expect(formatRatio(undefined)).toBe(EM_DASH);
  });
});

describe("admissionRequirements", () => {
  it("maps codes to labels and requirement levels in ADMCON order", () => {
    const reqs = admissionRequirements({
      ADMCON1: 1, // Secondary school GPA → Required
      ADMCON7: 2, // Admission test scores → Recommended
      ADMCON11: 5, // Personal statement → Considered but not required
    });
    expect(reqs).toEqual([
      { key: "ADMCON1", label: "Secondary school GPA", level: "Required" },
      { key: "ADMCON7", label: "Admission test scores", level: "Recommended" },
      {
        key: "ADMCON11",
        label: "Personal statement or essay",
        level: "Considered but not required",
      },
    ]);
  });

  it("filters out null codes and 'Not considered' (code 3)", () => {
    const reqs = admissionRequirements({
      ADMCON1: 1,
      ADMCON2: null,
      ADMCON3: 3, // Not considered → dropped
      ADMCON5: null,
    });
    expect(reqs).toEqual([
      { key: "ADMCON1", label: "Secondary school GPA", level: "Required" },
    ]);
  });

  it("returns an empty list for null/undefined input", () => {
    expect(admissionRequirements(null)).toEqual([]);
    expect(admissionRequirements(undefined)).toEqual([]);
    expect(admissionRequirements({})).toEqual([]);
  });

  it("drops unknown value codes defensively", () => {
    expect(admissionRequirements({ ADMCON1: 99 })).toEqual([]);
  });
});

describe("buildAdmissionsTrendChartData", () => {
  it("derives labels from the years and maps acceptance + yield datasets", () => {
    const trend: AdmissionsTrendPoint[] = [
      trendPoint({ dataYear: "2020-21", acceptanceRate: 30, yieldRate: 12 }),
      trendPoint({ dataYear: "2021-22", acceptanceRate: 28, yieldRate: 14 }),
      trendPoint({ dataYear: "2022-23", acceptanceRate: 25, yieldRate: 15 }),
    ];

    const data = buildAdmissionsTrendChartData(trend);

    expect(data.labels).toEqual(["2020-21", "2021-22", "2022-23"]);
    expect(data.datasets).toHaveLength(2);
    expect(data.datasets[0].label).toBe("Acceptance rate %");
    expect(data.datasets[0].data).toEqual([30, 28, 25]);
    expect(data.datasets[1].label).toBe("Yield rate %");
    expect(data.datasets[1].data).toEqual([12, 14, 15]);
  });

  it("drops null/NaN points (never plots 0) while keeping the year labels", () => {
    const trend: AdmissionsTrendPoint[] = [
      trendPoint({ dataYear: "2020-21", acceptanceRate: 30 }),
      trendPoint({ dataYear: "2021-22", acceptanceRate: null }),
      trendPoint({ dataYear: "2022-23", acceptanceRate: Number.NaN }),
    ];

    const data = buildAdmissionsTrendChartData(trend);

    expect(data.labels).toEqual(["2020-21", "2021-22", "2022-23"]);
    // null/NaN become null (gap), never 0.
    expect(data.datasets[0].data).toEqual([30, null, null]);
  });

  it("yields an all-null dataset when a metric is missing every year", () => {
    const trend: AdmissionsTrendPoint[] = [
      trendPoint({ dataYear: "2020-21", acceptanceRate: 30 }),
      trendPoint({ dataYear: "2021-22", acceptanceRate: 28 }),
    ];

    const data = buildAdmissionsTrendChartData(trend);

    // Yield rate is null for every year → the plotted series carries no real points.
    expect(data.datasets[1].data).toEqual([null, null]);
    expect((data.datasets[1].data as (number | null)[]).filter((v) => v != null)).toHaveLength(0);
  });

  it("returns empty labels and datasets for an empty trend", () => {
    const data = buildAdmissionsTrendChartData([]);
    expect(data.labels).toEqual([]);
    expect(data.datasets[0].data).toEqual([]);
    expect(data.datasets[1].data).toEqual([]);
  });
});
