import { expect, it } from "vitest";
import { paperDistribution } from "../paper-distribution";

it("includes zero scores, uses population spread, and handles subjects with no variance", () => {
  expect(paperDistribution([100, 0, 60, 60])).toEqual({
    scores: [0, 60, 60, 100], mean: 55, median: 60, sd: Math.sqrt(1275),
  });
  expect(paperDistribution([67.1, 67.1, 67.1])?.sd).toBe(0);
  expect(paperDistribution([80])).toEqual({ scores: [80], mean: 80, median: 80, sd: 0 });
  expect(paperDistribution([])).toBeNull();
});
