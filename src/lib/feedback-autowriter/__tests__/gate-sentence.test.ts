import { describe, expect, it } from "vitest";
import { gateSentence } from "../gate-sentence";
import { evaluateGate, wilsonLowerBound, type GateInput } from "../quality";
import type { AutowriterReview } from "../review-data";

type Gate = AutowriterReview["gate"];

function gate(overrides: Partial<Gate> = {}): Gate {
  return {
    status: "head_start", wilsonLower: 0.7225, coverage: 0.889, reasons: [],
    reviewed: 10, accurate: 10, criticalVerdicts: 0, unresolvedCriticalFlags: 0, pendingFlaggedReviews: 0, requiredPending: 0,
    unrecordedPosts: 0, unexplainedApiWrites: 0, coverageNum: 8, coverageDen: 9,
    thresholds: { passLowerBound: 0.8, headStartLowerBound: 0.7, minCoverage: 0.7 },
    lastDaily: null, currentTutors: 5, nextExpansionSize: 8, blockedUntil: null,
    ...overrides,
  };
}

describe("gateSentence", () => {
  it("says until when a critical verdict blocks the gate, and which class it was", () => {
    expect(gateSentence(gate({ status: "blocked_critical", criticalVerdicts: 1, blockedUntil: "2026-10-13" })))
      .toBe("Gate blocked until 13 Oct: critical on 29 Sep.");
    // Across a month and a year boundary; single-digit days are not padded.
    expect(gateSentence(gate({ status: "blocked_critical", criticalVerdicts: 2, blockedUntil: "2027-01-05" })))
      .toBe("Gate blocked until 5 Jan: critical on 22 Dec.");
  });

  it("names what blocks the gate when it is not a verdict", () => {
    expect(gateSentence(gate({ status: "blocked_critical", unresolvedCriticalFlags: 2 }))).toBe("Gate blocked: 2 critical flags to be judged.");
    expect(gateSentence(gate({ status: "blocked_critical", unresolvedCriticalFlags: 1, unexplainedApiWrites: 3 }))).toBe("Gate blocked: 1 critical flag to be judged.");
    expect(gateSentence(gate({ status: "blocked_critical", unexplainedApiWrites: 1 }))).toBe("Gate blocked: 1 API write to Wise that no post explains.");
    expect(gateSentence(gate({ status: "blocked_critical", unexplainedApiWrites: 2 }))).toBe("Gate blocked: 2 API writes to Wise that no post explains.");
    // A verdict the page could not date, and a block with nothing to name: still a sentence.
    expect(gateSentence(gate({ status: "blocked_critical", criticalVerdicts: 1 }))).toBe("Gate blocked: 1 critical verdict in the window.");
    expect(gateSentence(gate({ status: "blocked_critical" }))).toBe("Gate blocked by a critical error.");
  });

  it("gives the lower bound against the bar it has not reached, rounded down", () => {
    expect(gateSentence(gate())).toBe("Head start: lower bound 72%, needs 80%.");
    // 79.999% never reads as the 80% the status says it missed.
    expect(gateSentence(gate({ wilsonLower: 0.79999 }))).toBe("Head start: lower bound 79%, needs 80%.");
    expect(gateSentence(gate({ status: "below_head_start", wilsonLower: 0.6123 }))).toBe("Below head start: lower bound 61%, needs 70%.");
    expect(gateSentence(gate({ status: "below_head_start", wilsonLower: 0.69999 }))).toBe("Below head start: lower bound 69%, needs 70%.");
    expect(gateSentence(gate({ status: "below_head_start", wilsonLower: 0 }))).toBe("Below head start: lower bound 0%, needs 70%.");
  });

  it("says what the gate still waits for when the accuracy is there", () => {
    const ready = { wilsonLower: 0.853 };
    expect(gateSentence(gate({ ...ready, coverage: 0.629 }))).toBe("Head start: lower bound 85%; the gate still waits for coverage of 70% (now 62%).");
    expect(gateSentence(gate({ ...ready, coverage: null }))).toBe("Head start: lower bound 85%; the gate still waits for eligible classes.");
    expect(gateSentence(gate({ ...ready, pendingFlaggedReviews: 1, requiredPending: 4 }))).toBe("Head start: lower bound 85%; the gate still waits for 1 flagged post to be reviewed.");
    expect(gateSentence(gate({ ...ready, requiredPending: 2 }))).toBe("Head start: lower bound 85%; the gate still waits for 2 required posts to be reviewed.");
    expect(gateSentence(gate({ ...ready, unrecordedPosts: 1 }))).toBe("Head start: lower bound 85%; the gate still waits for 1 posted class to be recorded.");
    expect(gateSentence(gate({ ...ready, unrecordedPosts: 3 }))).toBe("Head start: lower bound 85%; the gate still waits for 3 posted classes to be recorded.");
  });

  it("says when there is nothing to judge yet, and when the gate has passed", () => {
    expect(gateSentence(gate({ status: "insufficient_data", wilsonLower: 0, reviewed: 0, accurate: 0 }))).toBe("Not enough reviews yet.");
    expect(gateSentence(gate({ status: "pass", wilsonLower: 0.84 }))).toBe("Gate passed: ready to add 3 tutors.");
    expect(gateSentence(gate({ status: "pass", wilsonLower: 0.84, currentTutors: 2, nextExpansionSize: 3 }))).toBe("Gate passed: ready to add 1 tutor.");
  });

  it("agrees with the gate's own evaluation for every status", () => {
    const facts = (overrides: Partial<GateInput>): GateInput => ({
      reviewed: 20, accurate: 20, criticalVerdicts: 0, unresolvedCriticalFlags: 0, pendingFlaggedReviews: 0, requiredPending: 0,
      unrecordedPosts: 0, unexplainedApiWrites: 0, coverageNum: 8, coverageDen: 10, ...overrides,
    });
    const sentence = (input: GateInput, blockedUntil: string | null = null) => {
      const result = evaluateGate(input);
      return [result.status, gateSentence(gate({ ...input, ...result, blockedUntil }))];
    };
    expect(sentence(facts({}))).toEqual(["pass", "Gate passed: ready to add 3 tutors."]);
    expect(sentence(facts({ reviewed: 0, accurate: 0 }))).toEqual(["insufficient_data", "Not enough reviews yet."]);
    expect(wilsonLowerBound(9, 9)).toBeGreaterThanOrEqual(0.7);
    expect(sentence(facts({ reviewed: 9, accurate: 9 }))).toEqual(["head_start", "Head start: lower bound 70%, needs 80%."]);
    expect(sentence(facts({ reviewed: 8, accurate: 8 }))).toEqual(["below_head_start", "Below head start: lower bound 67%, needs 70%."]);
    expect(sentence(facts({ coverageNum: 6 }))).toEqual(["head_start", "Head start: lower bound 83%; the gate still waits for coverage of 70% (now 60%)."]);
    expect(sentence(facts({ criticalVerdicts: 1 }), "2026-10-13")).toEqual(["blocked_critical", "Gate blocked until 13 Oct: critical on 29 Sep."]);
  });
});
