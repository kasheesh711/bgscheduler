import { describe, expect, it } from "vitest";
import {
  PROVEN_TUTOR_KEYS,
  addDays,
  bangkokDateKey,
  bangkokDayBounds,
  buildDailyMetrics,
  classifyCoverage,
  computeGateFacts,
  coverageRatio,
  dailyGateDate,
  emptyCoverageCounts,
  evaluateGate,
  gateWindow,
  isAccurate,
  nextExpansionSize,
  reviewInclusion,
  wilsonLowerBound,
  type GateInput,
} from "../quality";

const gate = (overrides: Partial<GateInput> = {}): GateInput => ({
  reviewed: 20, accurate: 20, criticalVerdicts: 0, unresolvedCriticalFlags: 0, pendingFlaggedReviews: 0,
  coverageNum: 8, coverageDen: 10, ...overrides,
});

describe("wilsonLowerBound (two-sided 95%)", () => {
  it("matches reference values", () => {
    expect(wilsonLowerBound(20, 20)).toBeCloseTo(0.839, 3);
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, 5)).toBe(0);
    expect(wilsonLowerBound(24, 25)).toBeCloseTo(0.8046, 4);
  });

  it("needs 9 clean reviews for the head start and 16 to pass; one factual error pushes the pass to 25", () => {
    expect(wilsonLowerBound(8, 8)).toBeLessThan(0.7);
    expect(wilsonLowerBound(9, 9)).toBeGreaterThanOrEqual(0.7);
    expect(wilsonLowerBound(15, 15)).toBeLessThan(0.8);
    expect(wilsonLowerBound(16, 16)).toBeGreaterThanOrEqual(0.8);
    expect(wilsonLowerBound(23, 24)).toBeLessThan(0.8);
    expect(wilsonLowerBound(24, 25)).toBeGreaterThanOrEqual(0.8);
  });
});

describe("isAccurate", () => {
  it("counts approvals and cosmetic fixes only", () => {
    expect(isAccurate({ verdict: "approve", severity: null })).toBe(true);
    expect(isAccurate({ verdict: "needs_fix", severity: "cosmetic" })).toBe(true);
    expect(isAccurate({ verdict: "needs_fix", severity: "factual" })).toBe(false);
    expect(isAccurate({ verdict: "needs_fix", severity: "critical" })).toBe(false);
  });
});

describe("classifyCoverage", () => {
  it.each([
    ["verified", "verified", "posted"],
    ["awaiting_event", null, "posted"],
    ["skipped_human", "human_submission", "excluded_tutor_first"],
    ["skipped_scope", "tutor_off_at_deadline", "excluded_tutor_off"],
    ["skipped_scope", "class_type_GROUP", "excluded_scope"],
    ["held", "student_count_0", "excluded_absent"],
    ["held", "attendance_30pct", "excluded_absent"],
    ["held", "student_not_wise_user", "excluded_absent"],
    ["held", "glm:unfaithful:…", "miss_held"],
    ["expired", "deadline_passed_or_too_close", "miss_expired"],
    ["rejected", null, "miss_failed"],
    ["unknown_outcome", null, "miss_failed"],
    ["verify_failed", null, "miss_failed"],
    ["pending", null, "pending"],
    ["posting", null, "pending"],
    ["awaiting_recording", "thai_summary", "pending"],
    ["would_submit", "shadow", "pending"],
  ] as const)("%s (%s) → %s", (state, reason, expected) => {
    expect(classifyCoverage({ state, reason })).toBe(expected);
  });

  it("leaves in-person classes out entirely", () => {
    expect(classifyCoverage({ state: "skipped_scope", reason: "session_type_OFFLINE" })).toBeNull();
    expect(classifyCoverage({ state: "skipped_scope", reason: "session_type_in_person_title" })).toBeNull();
  });

  it("counts a class the autowriter never saw only when proven online one-to-one", () => {
    expect(classifyCoverage({ state: null, reason: null, provenOnlineOneToOne: true })).toBe("miss_unseen");
    expect(classifyCoverage({ state: null, reason: null, provenOnlineOneToOne: false })).toBeNull();
  });

  it("coverage is posted over posted plus misses", () => {
    const counts = { ...emptyCoverageCounts(), posted: 7, miss_held: 2, miss_unseen: 1, excluded_tutor_first: 5, pending: 3 };
    expect(coverageRatio(counts)).toEqual({ num: 7, den: 10, ratio: 0.7 });
    expect(coverageRatio(emptyCoverageCounts()).ratio).toBeNull();
  });
});

describe("evaluateGate", () => {
  it("passes with LB ≥ 80%, no critical, coverage ≥ 70% and no pending flagged review", () => {
    const result = evaluateGate(gate());
    expect(result.status).toBe("pass");
    expect(result.reasons).toEqual([]);
  });

  it("reports insufficient data when nothing was reviewed", () => {
    expect(evaluateGate(gate({ reviewed: 0, accurate: 0 })).status).toBe("insufficient_data");
  });

  it("blocks on a critical verdict or an unresolved critical flag, whatever the accuracy", () => {
    expect(evaluateGate(gate({ criticalVerdicts: 1 })).status).toBe("blocked_critical");
    expect(evaluateGate(gate({ unresolvedCriticalFlags: 1, reviewed: 0, accurate: 0 })).status).toBe("blocked_critical");
  });

  it("gives the head start at LB ≥ 70% but not a pass below 80%", () => {
    expect(evaluateGate(gate({ reviewed: 10, accurate: 10 })).status).toBe("head_start");
    expect(evaluateGate(gate({ reviewed: 8, accurate: 8 })).status).toBe("below_head_start");
  });

  it("does not pass while a flagged post waits for review, or with coverage under 70%", () => {
    const flagged = evaluateGate(gate({ pendingFlaggedReviews: 1 }));
    expect(flagged.status).toBe("head_start");
    expect(flagged.reasons).toContain("1 flagged post(s) waiting for review");
    expect(evaluateGate(gate({ coverageNum: 6, coverageDen: 10 })).status).toBe("head_start");
    expect(evaluateGate(gate({ coverageNum: 0, coverageDen: 0 })).status).toBe("head_start");
  });
});

describe("computeGateFacts", () => {
  const window = { start: "2026-09-17", end: "2026-09-30" };
  it("counts required reviews with verdicts only, criticals whatever the sampling, and live coverage", () => {
    const facts = computeGateFacts({
      window,
      unresolvedCriticalFlags: 0,
      reviews: [
        { bangkokDate: "2026-09-29", inclusionReason: "new_tutor", verdict: { verdict: "approve", severity: null }, hasOpenFlag: false },
        { bangkokDate: "2026-09-29", inclusionReason: "new_tutor", verdict: { verdict: "needs_fix", severity: "factual" }, hasOpenFlag: false },
        { bangkokDate: "2026-09-29", inclusionReason: "new_tutor", verdict: null, hasOpenFlag: true },
        // A voluntary review of a post that was not sampled never counts toward accuracy …
        { bangkokDate: "2026-09-29", inclusionReason: "not_sampled", verdict: { verdict: "approve", severity: null }, hasOpenFlag: false },
        // … but a critical one still blocks.
        { bangkokDate: "2026-09-30", inclusionReason: "not_sampled", verdict: { verdict: "needs_fix", severity: "critical" }, hasOpenFlag: false },
        { bangkokDate: "2026-09-01", inclusionReason: "new_tutor", verdict: { verdict: "approve", severity: null }, hasOpenFlag: true },
      ],
      metrics: [
        { metricDate: "2026-09-29", tutorKey: "*", liveMode: true, posted: 8, eligible: 9 },
        { metricDate: "2026-09-28", tutorKey: "*", liveMode: false, posted: 0, eligible: 4 },
        { metricDate: "2026-09-29", tutorKey: "Mimi", liveMode: true, posted: 6, eligible: 6 },
      ],
    });
    expect(facts).toEqual({
      reviewed: 2, accurate: 1, criticalVerdicts: 1, unresolvedCriticalFlags: 0, pendingFlaggedReviews: 1,
      coverageNum: 8, coverageDen: 9,
    });
  });
});

describe("reviewInclusion", () => {
  it("reviews every post of an unproven tutor (all of them in Phase 1)", () => {
    expect(PROVEN_TUTOR_KEYS.size).toBe(0);
    expect(reviewInclusion({ tutorProven: false, draw: 0.99 })).toEqual({ reason: "new_tutor", probability: 1 });
  });

  it("samples 30% of a proven tutor's posts from the stored draw", () => {
    expect(reviewInclusion({ tutorProven: true, draw: 0.29 })).toEqual({ reason: "random_sample", probability: 0.3 });
    expect(reviewInclusion({ tutorProven: true, draw: 0.3 })).toEqual({ reason: "not_sampled", probability: 0.3 });
  });
});

describe("nextExpansionSize", () => {
  it("grows by half, rounded up: 5 → 8 → 12 → 18", () => {
    const sizes = [5];
    for (let step = 0; step < 3; step += 1) sizes.push(nextExpansionSize(sizes.at(-1)!));
    expect(sizes).toEqual([5, 8, 12, 18]);
  });
});

describe("Bangkok dates", () => {
  it("keys, shifts and bounds dates in Bangkok", () => {
    expect(bangkokDateKey(new Date("2026-09-29T17:30:00Z"))).toBe("2026-09-30");
    expect(addDays("2026-10-01", -2)).toBe("2026-09-29");
    expect(bangkokDayBounds("2026-09-29")).toEqual({
      start: new Date("2026-09-28T17:00:00.000Z"), end: new Date("2026-09-29T17:00:00.000Z"),
    });
    expect(gateWindow("2026-09-30")).toEqual({ start: "2026-09-17", end: "2026-09-30" });
  });

  it("evaluates today's gate from 22:00 Bangkok, yesterday's before", () => {
    expect(dailyGateDate(new Date("2026-09-29T15:27:00Z"))).toBe("2026-09-29");
    expect(dailyGateDate(new Date("2026-09-29T14:27:00Z"))).toBe("2026-09-28");
  });
});

describe("buildDailyMetrics", () => {
  it("rolls classes and reviews into per-tutor rows plus the all-tutor row", () => {
    const rows = buildDailyMetrics({
      tutorKeys: ["Mimi", "Ek"],
      classes: [
        { tutorKey: "Mimi", coverage: "posted" },
        { tutorKey: "Mimi", coverage: "posted" },
        { tutorKey: "Ek", coverage: "posted" },
        { tutorKey: "Ek", coverage: "miss_held" },
        { tutorKey: "Ek", coverage: "excluded_tutor_first" },
        { tutorKey: "Ek", coverage: null },
      ],
      reviews: [
        { tutorKey: "Mimi", inclusionReason: "new_tutor", verdict: { verdict: "needs_fix", severity: "cosmetic" }, measuredFixCount: 1, correctionsVerified: 1 },
        { tutorKey: "Mimi", inclusionReason: "new_tutor", verdict: null, measuredFixCount: 0, correctionsVerified: 0 },
        { tutorKey: "Ek", inclusionReason: "new_tutor", verdict: { verdict: "needs_fix", severity: "factual" }, measuredFixCount: 0, correctionsVerified: 0 },
      ],
    });
    const all = rows.find((row) => row.tutorKey === "*")!;
    expect(all).toMatchObject({
      posted: 3, required: 3, reviewed: 2, requiredPending: 1, accurate: 1, cosmetic: 1, factual: 1, critical: 0,
      eligible: 4, held: 1, excludedTutorFirst: 1, measuredFixClasses: 1, correctionsVerified: 1,
    });
    expect(rows.find((row) => row.tutorKey === "Ek")).toMatchObject({ posted: 1, eligible: 2, held: 1 });
    expect(rows.map((row) => row.tutorKey)).toEqual(["Mimi", "Ek", "*"]);
  });
});
