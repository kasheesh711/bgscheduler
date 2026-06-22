import { describe, expect, it } from "vitest";
import {
  bestIndexForMetric,
  buildSatChartConfig,
  formatRange,
} from "../compare-panel";
import type { CompareInstitution } from "@/lib/us-universities/types";

function institution(overrides: Partial<CompareInstitution> = {}): CompareInstitution {
  return {
    dataYear: "2024-25",
    unitId: 1,
    instName: "Test University",
    stateAbbr: "CA",
    control: 1,
    satReadingP25: 600,
    satReadingP75: 700,
    satMathP25: 620,
    satMathP75: 740,
    actCompositeP25: null,
    actCompositeP75: null,
    topMajor: null,
    // The remaining IpedsInstitutionSummary columns are not exercised by the
    // pure helpers under test; cast through unknown to keep the fixture small.
    ...overrides,
  } as CompareInstitution;
}

describe("bestIndexForMetric", () => {
  it("returns the highest index when direction is high", () => {
    expect(bestIndexForMetric([10, 30, 20], "high")).toBe(1);
  });

  it("returns the lowest index when direction is low", () => {
    expect(bestIndexForMetric([10, 30, 20], "low")).toBe(0);
  });

  it("ignores nulls and still finds the best real value", () => {
    expect(bestIndexForMetric([null, 50, null, 90], "high")).toBe(3);
    expect(bestIndexForMetric([null, 50, null, 90], "low")).toBe(1);
  });

  it("returns null when fewer than two real values exist (nothing to compare)", () => {
    expect(bestIndexForMetric([null, 42, null], "high")).toBeNull();
    expect(bestIndexForMetric([null, null], "low")).toBeNull();
    expect(bestIndexForMetric([], "high")).toBeNull();
  });

  it("resolves ties to the first occurrence", () => {
    expect(bestIndexForMetric([15, 15, 5], "high")).toBe(0);
    expect(bestIndexForMetric([5, 5, 15], "low")).toBe(0);
  });
});

describe("formatRange", () => {
  it("renders a full p25–p75 band", () => {
    expect(formatRange(600, 700)).toBe("600–700");
  });

  it("collapses a missing endpoint to an em dash but keeps the present one", () => {
    expect(formatRange(null, 700)).toBe("—–700");
    expect(formatRange(600, null)).toBe("600–—");
  });

  it("renders a single em dash when both endpoints are missing", () => {
    expect(formatRange(null, null)).toBe("—");
  });
});

describe("buildSatChartConfig", () => {
  const colors = {
    chart: ["#a", "#b", "#c", "#d", "#e"],
    border: "#ccc",
    mutedForeground: "#999",
  };

  it("builds a floating-bar config from combined reading+math SAT bands", () => {
    const config = buildSatChartConfig(
      [institution({ unitId: 1, instName: "Alpha" })],
      colors,
    );
    expect(config).not.toBeNull();
    expect(config?.type).toBe("bar");
    const data = config?.data.datasets[0].data as [number, number][];
    expect(data[0]).toEqual([1220, 1440]);
    expect(config?.data.labels).toEqual(["Alpha"]);
  });

  it("omits schools missing either SAT endpoint", () => {
    const config = buildSatChartConfig(
      [
        institution({ unitId: 1, instName: "Has SAT" }),
        institution({ unitId: 2, instName: "No Math", satMathP25: null, satMathP75: null }),
      ],
      colors,
    );
    expect(config?.data.labels).toEqual(["Has SAT"]);
  });

  it("returns null when no school has a complete SAT band", () => {
    const config = buildSatChartConfig(
      [institution({ satReadingP25: null, satReadingP75: null })],
      colors,
    );
    expect(config).toBeNull();
  });
});
