import { describe, expect, it } from "vitest";
import { buildPackageMixFromSales } from "../package-mix";

describe("room capacity package mix aggregation", () => {
  it("aggregates paid sales into per-student package-hour and revenue buckets", () => {
    const mix = buildPackageMixFromSales([
      { packageHours: 10, revenueThb: 12_000, studentCount: 1, sourceLabel: "Apr" },
      { packageHours: 20, revenueThb: 24_000, studentCount: 2, sourceLabel: "Apr" },
      { packageHours: 30, revenueThb: 42_000, studentCount: 1, sourceLabel: "May" },
      { packageHours: 0, revenueThb: 10_000, studentCount: 1, sourceLabel: "Ignored" },
    ]);

    expect(mix).toHaveLength(2);
    expect(mix[0]).toMatchObject({
      packageHourBucket: "10h",
      packageHours: 10,
      averageRevenueThb: 12_000,
      observedSaleCount: 2,
      observedStudentCount: 3,
    });
    expect(mix[0].share).toBeCloseTo(0.75);
    expect(mix[1]).toMatchObject({
      packageHourBucket: "30h",
      averageRevenueThb: 42_000,
      observedSaleCount: 1,
      observedStudentCount: 1,
      share: 0.25,
    });
  });
});
