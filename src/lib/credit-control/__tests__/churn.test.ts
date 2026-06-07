import { describe, expect, it } from "vitest";
import { aggregateStudentRemaining, computeChurnTransitions } from "@/lib/credit-control/churn";

const NOW = new Date("2026-06-07T00:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

function student(studentKey: string, totalRemaining: number) {
  return { studentKey, studentName: studentKey.toUpperCase(), parentName: "Parent", totalRemaining };
}

describe("aggregateStudentRemaining", () => {
  it("sums remaining credits per student, ignoring excluded packages", () => {
    const rows = [
      { studentKey: "a", studentName: "A", parentName: "PA", remainingCredits: 3, excludedReason: null },
      { studentKey: "a", studentName: "A", parentName: "PA", remainingCredits: -1, excludedReason: null },
      { studentKey: "a", studentName: "A", parentName: "PA", remainingCredits: 99, excludedReason: "pretest" },
      { studentKey: "b", studentName: "B", parentName: "PB", remainingCredits: 0, excludedReason: null },
    ];

    const agg = aggregateStudentRemaining(rows);
    const byKey = Object.fromEntries(agg.map((s) => [s.studentKey, s.totalRemaining]));

    expect(byKey).toEqual({ a: 2, b: 0 });
  });
});

describe("computeChurnTransitions", () => {
  const base = { tracking: [], inactive: [], now: NOW, thresholdDays: 45 };

  it("sets zeroSince on the first <=0 observation", () => {
    const tx = computeChurnTransitions({ ...base, students: [student("a", 0)] });
    expect(tx.zeroUpserts).toHaveLength(1);
    expect(tx.zeroUpserts[0].zeroSince).toEqual(NOW);
    expect(tx.toInactivate).toHaveLength(0);
  });

  it("preserves zeroSince and auto-removes after >= threshold days at <=0", () => {
    const tx = computeChurnTransitions({
      ...base,
      students: [student("a", -1)],
      tracking: [{ studentKey: "a", zeroSince: daysAgo(45) }],
    });
    expect(tx.toInactivate.map((t) => t.studentKey)).toEqual(["a"]);
    expect(tx.toInactivate[0].removedAtRemaining).toBe(-1);
    expect(tx.zeroClears).toContain("a");
    expect(tx.zeroUpserts).toHaveLength(0);
  });

  it("keeps tracking without removing while below the threshold", () => {
    const tx = computeChurnTransitions({
      ...base,
      students: [student("a", 0)],
      tracking: [{ studentKey: "a", zeroSince: daysAgo(10) }],
    });
    expect(tx.toInactivate).toHaveLength(0);
    expect(tx.zeroUpserts[0].zeroSince).toEqual(daysAgo(10));
  });

  it("clears tracking when a student recovers above zero", () => {
    const tx = computeChurnTransitions({
      ...base,
      students: [student("a", 4)],
      tracking: [{ studentKey: "a", zeroSince: daysAgo(10) }],
    });
    expect(tx.zeroClears).toEqual(["a"]);
    expect(tx.toInactivate).toHaveLength(0);
    expect(tx.zeroUpserts).toHaveLength(0);
  });

  it("reactivates an auto-churned student on any positive balance", () => {
    const tx = computeChurnTransitions({
      ...base,
      students: [student("a", 5)],
      inactive: [{ studentKey: "a", source: "auto-churn", removedAtRemaining: 0 }],
    });
    expect(tx.toReactivate).toEqual(["a"]);
  });

  it("does not reactivate when the balance rises but stays non-positive", () => {
    const tx = computeChurnTransitions({
      ...base,
      students: [student("a", -1)],
      inactive: [{ studentKey: "a", source: "auto-churn", removedAtRemaining: -3 }],
    });
    expect(tx.toReactivate).toHaveLength(0);
  });

  it("reactivates a manually-removed student only on a genuine top-up above their prior balance", () => {
    const stillBelow = computeChurnTransitions({
      ...base,
      students: [student("a", 8)],
      inactive: [{ studentKey: "a", source: "manual", removedAtRemaining: 10 }],
    });
    expect(stillBelow.toReactivate).toHaveLength(0);

    const toppedUp = computeChurnTransitions({
      ...base,
      students: [student("a", 12)],
      inactive: [{ studentKey: "a", source: "manual", removedAtRemaining: 10 }],
    });
    expect(toppedUp.toReactivate).toEqual(["a"]);
  });
});
