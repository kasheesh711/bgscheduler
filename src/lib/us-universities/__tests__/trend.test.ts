import { describe, it, expect } from "vitest";
import { shapeAdmissionsTrend, priorDataYearOf } from "../trend";
import type { AdmissionsTrendPoint } from "../types";

function point(dataYear: string, acceptanceRate: number | null): { unitId: number } & AdmissionsTrendPoint {
  return {
    unitId: 100,
    dataYear,
    acceptanceRate,
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
  };
}

describe("shapeAdmissionsTrend", () => {
  it("groups by unit and sorts ascending by year", () => {
    const out = shapeAdmissionsTrend([
      point("2024-25", 4),
      point("2020-21", 7),
      { ...point("2022-23", 5), unitId: 200 },
    ]);
    expect(out.get(100)?.map((p) => p.dataYear)).toEqual(["2020-21", "2024-25"]);
    expect(out.get(100)?.[0].acceptanceRate).toBe(7);
    expect(out.get(200)?.map((p) => p.dataYear)).toEqual(["2022-23"]);
  });

  it("returns an empty map for no rows", () => {
    expect(shapeAdmissionsTrend([]).size).toBe(0);
  });

  it("preserves null metrics (fail-closed)", () => {
    const out = shapeAdmissionsTrend([point("2024-25", null)]);
    expect(out.get(100)?.[0].acceptanceRate).toBeNull();
  });
});

describe("priorDataYearOf", () => {
  it("returns the prior academic-year label", () => {
    expect(priorDataYearOf("2024-25")).toBe("2023-24");
    expect(priorDataYearOf("2021-22")).toBe("2020-21");
  });
  it("returns null for an unparseable label", () => {
    expect(priorDataYearOf("nope")).toBeNull();
  });
});
