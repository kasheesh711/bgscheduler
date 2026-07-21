import { describe, expect, it } from "vitest";

import {
  isPostClassTerminalReminderFailure,
  isPostClassAssessmentInDenominator,
  postClassSourceIssueCrossedDeadline,
  rankPostClassTutorMetrics,
} from "../metrics";

const deadlineAt = new Date("2026-07-03T16:59:59.999Z");
const assessment = {
  sourceReady: true,
  rawOnTime: false,
  adjustedCompliant: false,
  assessedAt: new Date("2026-07-04T00:00:00.000Z"),
};
const session = { eligible: true, sourceStatus: "ready", deadlineAt };

describe("post-class reminder failure metrics", () => {
  it("counts only terminal failed deliveries", () => {
    expect(isPostClassTerminalReminderFailure({
      status: "failed",
      attemptCount: 1,
      nextAttemptAt: new Date("2026-07-21T03:30:00.000Z"),
    })).toBe(false);
    expect(isPostClassTerminalReminderFailure({
      status: "failed",
      attemptCount: 4,
      nextAttemptAt: null,
    })).toBe(true);
    expect(isPostClassTerminalReminderFailure({
      status: "failed",
      attemptCount: 1,
      nextAttemptAt: null,
    })).toBe(true);
    expect(isPostClassTerminalReminderFailure({
      status: "sent",
      attemptCount: 1,
      nextAttemptAt: null,
    })).toBe(false);
  });
});

describe("post-class assessed denominator", () => {
  it("includes an eligible, source-ready session after its deadline", () => {
    expect(isPostClassAssessmentInDenominator(session, assessment)).toBe(true);
  });

  it("excludes ineligible sessions even if a stale assessment says they are due", () => {
    expect(isPostClassAssessmentInDenominator({ ...session, eligible: false }, assessment)).toBe(false);
  });

  it("excludes source-paused sessions and not-yet-due incomplete sessions", () => {
    expect(isPostClassAssessmentInDenominator({ ...session, sourceStatus: "unavailable" }, assessment)).toBe(false);
    expect(isPostClassAssessmentInDenominator(session, {
      ...assessment,
      assessedAt: new Date("2026-07-03T12:00:00.000Z"),
    })).toBe(false);
  });

  it("includes compliant sessions before the deadline", () => {
    expect(isPostClassAssessmentInDenominator(session, {
      ...assessment,
      adjustedCompliant: true,
      assessedAt: new Date("2026-07-03T12:00:00.000Z"),
    })).toBe(true);
  });
});

describe("post-class tutor ranking", () => {
  it("excludes zero-denominator tutors and orders by compliance, violations, then name", () => {
    expect(rankPostClassTutorMetrics([
      { tutorName: "Not due", assessed: 0, adjustedComplianceRate: null, unresolvedViolations: 0 },
      { tutorName: "Zara", assessed: 2, adjustedComplianceRate: 0.5, unresolvedViolations: 1 },
      { tutorName: "Amy", assessed: 2, adjustedComplianceRate: 0.5, unresolvedViolations: 2 },
      { tutorName: "Ben", assessed: 2, adjustedComplianceRate: 0, unresolvedViolations: 1 },
    ]).map((row) => row.tutorName)).toEqual(["Ben", "Amy", "Zara"]);
  });
});

describe("post-class source issue context", () => {
  const deadline = new Date("2026-07-03T16:59:59.999Z");

  it("includes only matching issue episodes that actually span the deadline", () => {
    expect(postClassSourceIssueCrossedDeadline({
      sessionId: "session-1",
      scope: "session",
      firstSeenAt: new Date("2026-07-03T12:00:00.000Z"),
      resolvedAt: new Date("2026-07-03T18:00:00.000Z"),
    }, "session-1", deadline)).toBe(true);
    expect(postClassSourceIssueCrossedDeadline({
      sessionId: "session-1",
      scope: "session",
      firstSeenAt: new Date("2026-07-04T00:00:00.000Z"),
      resolvedAt: null,
    }, "session-1", deadline)).toBe(false);
    expect(postClassSourceIssueCrossedDeadline({
      sessionId: null,
      scope: "global",
      firstSeenAt: new Date("2026-07-03T12:00:00.000Z"),
      resolvedAt: new Date("2026-07-03T14:00:00.000Z"),
    }, "session-1", deadline)).toBe(false);
  });
});
