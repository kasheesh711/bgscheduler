import { expect, it } from "vitest";
import { paperProfileSummary } from "../paper-profile-summary";
import { paperDistribution } from "../paper-distribution";

it("includes zero scores, uses population spread, and handles subjects with no variance", () => {
  expect(paperDistribution([100, 0, 60, 60])).toEqual({
    scores: [0, 60, 60, 100], mean: 55, median: 60, sd: Math.sqrt(1275),
  });
  expect(paperDistribution([67.1, 67.1, 67.1])?.sd).toBe(0);
  expect(paperDistribution([80])).toEqual({ scores: [80], mean: 80, median: 80, sd: 0 });
  expect(paperDistribution([])).toBeNull();
});

it("keeps legacy form prose from becoming a qualification claim or a fourth sentence", () => {
  const pre = {
    sourceRow: 1, submittedAt: "", degree: "Bachelor's, Master's", field: "English. Degree in progress.",
    subjects: "English Language", curricula: "I have not taught IB.", yearGroups: "", english: "", englishEvidence: "",
    experience: "", portfolio: "", availability: "", weeklyHours: "", motivation: "", teachingApproach: "",
  };
  const summary = paperProfileSummary(pre, null, "English Language");
  expect(summary.match(/[.!?]/g)).toHaveLength(3);
  expect(summary).toContain("master's degree");
  expect(summary).toContain("English Language");
  expect(summary).not.toMatch(/in progress|in English|include IB/);
});
