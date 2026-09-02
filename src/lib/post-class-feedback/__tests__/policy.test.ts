import { describe, expect, it } from "vitest";
import {
  assessFeedbackContent,
  calculateFeedbackDeadline,
  countUnicodeCodePoints,
  deriveEventTimingEvidence,
  evaluateSessionCompliance,
  evaluateSessionEligibility,
  feedbackSubmitterRole,
  isPlaceholderFeedback,
} from "../policy";
import type { FeedbackEventEvidence, FeedbackFieldAnswers, FeedbackVersion } from "../types";

const completeFields = (suffix = ""): FeedbackFieldAnswers => ({
  topics: `${"Algebraic equations, worked examples, and checking strategies were covered in a structured sequence. ".repeat(2)}${suffix}`,
  performance: "The student explained each method clearly, corrected calculation errors, and applied the final check independently. ".repeat(2),
  improvement: "Next, the student should practise mixed word problems because choosing the correct method will build confidence. ".repeat(2),
  homework: "",
});

function version(input: {
  fields?: FeedbackFieldAnswers;
  sourceCreatedAt?: string | null;
  observedAt: string;
  id?: string;
}): FeedbackVersion {
  return {
    submissionId: input.id ?? "submission-1",
    profile: "teacher",
    answers: [],
    fields: input.fields ?? completeFields(),
    contentHash: input.id ?? "hash-1",
    sourceCreatedAt: input.sourceCreatedAt === null || input.sourceCreatedAt === undefined
      ? null
      : new Date(input.sourceCreatedAt),
    sourceTimestampTrustworthy: input.sourceCreatedAt !== null && input.sourceCreatedAt !== undefined,
    observedAt: new Date(input.observedAt),
    actorWiseUserId: null,
    provenance: "unknown",
  };
}

describe("post-class feedback policy", () => {
  it("anchors the deadline to the Bangkok scheduled-end date plus two calendar days", () => {
    // 20:00Z is already 03:00 on 1 February in Bangkok.
    const deadline = calculateFeedbackDeadline(new Date("2026-01-31T20:00:00.000Z"));
    expect(deadline.toISOString()).toBe("2026-02-03T16:59:59.999Z");
  });

  it("counts raw Unicode code points without UTF-16 surrogate inflation", () => {
    expect(countUnicodeCodePoints("ก 😀\n ")).toBe(5);
    expect(assessFeedbackContent({
      topics: "ก".repeat(100),
      performance: "ข".repeat(100),
      improvement: "ค".repeat(98) + "  ",
      homework: "",
    }).combinedRawCharacterCount).toBe(300);
  });

  it("rejects English and Thai placeholders and punctuation-only answers", () => {
    expect(isPlaceholderFeedback(" N/A. ")).toBe(true);
    expect(isPlaceholderFeedback(" N / A ")).toBe(true);
    expect(isPlaceholderFeedback("ไม่มีอะไร")).toBe(true);
    expect(isPlaceholderFeedback("...?!")).toBe(true);
    expect(isPlaceholderFeedback("12345 😀")).toBe(true);
    expect(isPlaceholderFeedback("無回答")).toBe(true);
    expect(isPlaceholderFeedback("ไม่มีครับ")).toBe(true);
    expect(isPlaceholderFeedback("ไม่มีค่ะ")).toBe(true);
    expect(isPlaceholderFeedback("ไม่มีอะไรครับ")).toBe(true);
    expect(isPlaceholderFeedback(
      "วันนี้เรียนเรื่องสมการ ไม่มีอะไรขัดข้อง และนักเรียนอธิบายขั้นตอนได้ชัดเจนครับ",
    )).toBe(false);
    expect(isPlaceholderFeedback("good ".repeat(80))).toBe(true);
    expect(isPlaceholderFeedback("N/A ".repeat(80))).toBe(true);
    expect(isPlaceholderFeedback("ดี ".repeat(120))).toBe(true);
    expect(isPlaceholderFeedback("great ".repeat(80))).toBe(true);
    expect(isPlaceholderFeedback("abc ".repeat(100))).toBe(true);
    expect(isPlaceholderFeedback("ยอดเยี่ยม ".repeat(80))).toBe(true);
    expect(isPlaceholderFeedback("ตั้งสมการ แล้วตรวจคำตอบ ".repeat(30))).toBe(true);
    expect(isPlaceholderFeedback("a".repeat(300))).toBe(true);
    expect(isPlaceholderFeedback("ก".repeat(300))).toBe(true);
    expect(isPlaceholderFeedback(
      "The lesson compared algebraic terms, and algebraic notation was repeated intentionally for clarity.",
    )).toBe(false);
  });

  it("allows a no-improvement claim only with a positive goal and rationale", () => {
    expect(isPlaceholderFeedback("No improvement needed.")).toBe(true);
    expect(isPlaceholderFeedback("No improvement is needed.")).toBe(true);
    expect(isPlaceholderFeedback("Nothing more to work on.")).toBe(true);
    expect(isPlaceholderFeedback(
      "No improvement is needed; next we will practise proofs because this will build confidence.",
    )).toBe(false);
    expect(isPlaceholderFeedback(
      "ไม่ต้องปรับปรุง ต่อไปจะฝึกโจทย์ประยุกต์เพื่อพัฒนาความมั่นใจ",
    )).toBe(false);
  });

  it("requires all three fields and a combined minimum of 300 raw characters", () => {
    expect(assessFeedbackContent(completeFields()).compliant).toBe(true);
    expect(assessFeedbackContent({ ...completeFields(), topics: "" }).compliant).toBe(false);
    expect(assessFeedbackContent({
      topics: "T".repeat(99),
      performance: "P".repeat(100),
      improvement: "I".repeat(100),
      homework: "H".repeat(1000),
    }).compliant).toBe(false);
  });

  it("requires ENDED plus positive credits or explicit payout eligibility", () => {
    expect(evaluateSessionEligibility({ meetingStatus: "ENDED", creditsConsumed: 1 }).eligible).toBe(true);
    expect(evaluateSessionEligibility({ meetingStatus: "ENDED", creditsConsumed: 0, payoutEligible: true }).eligible).toBe(true);
    expect(evaluateSessionEligibility({ meetingStatus: "MISSED", creditsConsumed: 1 }).reason)
      .toBe("missed_or_no_show");
    expect(evaluateSessionEligibility({ meetingStatus: "ENDED", creditsConsumed: 0, payoutEligible: false }).status).toBe("ineligible");
    expect(evaluateSessionEligibility({ meetingStatus: "ENDED", creditsConsumed: 0 }).status).toBe("ambiguous");
    expect(evaluateSessionEligibility({
      meetingStatus: "ENDED",
      attendanceStatus: "NO SHOW",
      creditsConsumed: 1,
    }).reason).toBe("missed_or_no_show");
  });

  it("excludes missed, OTHER, trial, and complimentary sessions even when credits are positive", () => {
    expect(evaluateSessionEligibility({
      meetingStatus: "ENDED",
      attendanceStatus: "NO_SHOW",
      creditsConsumed: 1,
    }).reason).toBe("missed_or_no_show");
    expect(evaluateSessionEligibility({
      meetingStatus: "ENDED",
      attendanceStatus: "CANCELLED",
      creditsConsumed: 1,
    }).reason).toBe("cancelled");
    expect(evaluateSessionEligibility({
      meetingStatus: "ENDED",
      submissionSessionStatuses: ["CANCELED"],
      creditsConsumed: 1,
    }).reason).toBe("cancelled");
    expect(evaluateSessionEligibility({
      meetingStatus: "CANCELLED",
      creditsConsumed: 1,
    }).reason).toBe("cancelled");
    expect(evaluateSessionEligibility({
      meetingStatus: "ENDED",
      sessionType: "OTHER",
      creditsConsumed: 1,
    }).reason).toBe("excluded_session_type");
    expect(evaluateSessionEligibility({
      meetingStatus: "ENDED",
      sessionType: "TRIAL",
      creditsConsumed: 1,
    }).reason).toBe("complimentary_or_trial");
    expect(evaluateSessionEligibility({
      meetingStatus: "ENDED",
      complimentaryOrTrial: true,
      creditsConsumed: 1,
    }).reason).toBe("complimentary_or_trial");
  });

  it("uses classroom classType before modality type and honors submission attendance evidence", () => {
    expect(evaluateSessionEligibility({
      meetingStatus: "ENDED",
      classType: "REGULAR",
      sessionType: "OTHER",
      creditsConsumed: 1,
    }).reason).toBe("ended_positive_credits");
    expect(evaluateSessionEligibility({
      meetingStatus: "ENDED",
      classType: "OTHER",
      sessionType: "OFFLINE",
      creditsConsumed: 1,
    }).reason).toBe("excluded_session_type");
    expect(evaluateSessionEligibility({
      meetingStatus: "ENDED",
      submissionSessionStatuses: ["ENDED", "NO SHOW"],
      creditsConsumed: 1,
    }).reason).toBe("missed_or_no_show");
  });

  it("locks a compliant state proven before the deadline against a later regression", () => {
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      enforcementMode: "live",
      versions: [
        version({ id: "good", sourceCreatedAt: "2026-07-02T10:00:00.000Z", observedAt: "2026-07-02T10:01:00.000Z" }),
        version({
          id: "regressed",
          fields: { ...completeFields(), topics: "N/A" },
          sourceCreatedAt: "2026-07-04T00:00:00.000Z",
          observedAt: "2026-07-04T00:01:00.000Z",
        }),
      ],
    });
    expect(result.timingStatus).toBe("on_time");
    expect(result.onTimeComplianceLocked).toBe(true);
    expect(result.violation).toBe(false);
  });

  it("locks an earlier compliant pre-deadline version despite a later pre-deadline regression", () => {
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      enforcementMode: "live",
      versions: [
        version({
          id: "good-first",
          sourceCreatedAt: "2026-07-02T10:00:00.000Z",
          observedAt: "2026-07-02T10:01:00.000Z",
        }),
        version({
          id: "regressed-before-deadline",
          fields: { ...completeFields(), topics: "N/A" },
          sourceCreatedAt: "2026-07-03T10:00:00.000Z",
          observedAt: "2026-07-03T10:01:00.000Z",
        }),
      ],
    });
    expect(result.timingStatus).toBe("on_time");
    expect(result.onTimeVersionKey).toBe("good-first:good-first");
    expect(result.onTimeComplianceLocked).toBe(true);
    expect(result.violation).toBe(false);
  });

  it("treats the exact deadline boundary as due and considers only explicit teacher profiles", () => {
    const scheduledEndAt = new Date("2026-07-01T10:00:00.000Z");
    const deadlineAt = calculateFeedbackDeadline(scheduledEndAt);
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt,
      now: deadlineAt,
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      enforcementMode: "live",
      versions: [{
        ...version({
          sourceCreatedAt: "2026-07-02T10:00:00.000Z",
          observedAt: "2026-07-02T10:01:00.000Z",
        }),
        profile: null,
      }],
    });
    expect(result.due).toBe(true);
    expect(result.contentStatus).toBe("missing");
    expect(result.violation).toBe(true);
  });

  it("keeps a late backfill as a remediated violation", () => {
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      enforcementMode: "live",
      versions: [version({
        sourceCreatedAt: "2026-07-04T00:00:00.000Z",
        observedAt: "2026-07-04T00:01:00.000Z",
      })],
    });
    expect(result.timingStatus).toBe("late");
    expect(result.violation).toBe(true);
    expect(result.remediatedLate).toBe(true);
    expect(result.deductionCandidate).toBe(true);
  });

  it("treats an untrusted creation timestamp after the deadline as proof of lateness", () => {
    const createdLate = {
      ...version({
        sourceCreatedAt: "2026-07-04T00:00:00.000Z",
        observedAt: "2026-07-04T00:01:00.000Z",
      }),
      sourceTimestampTrustworthy: false,
      sourceTimestampKind: "created" as const,
    };
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      enforcementMode: "live",
      versions: [createdLate],
    });
    expect(result.timingStatus).toBe("late");
    expect(result.violation).toBe(true);
    expect(result.remediatedLate).toBe(true);
  });

  it("orders distinct untrusted submissions by Wise creation time", () => {
    const older = {
      ...version({
        id: "older",
        sourceCreatedAt: "2026-07-04T00:00:00.000Z",
        observedAt: "2026-07-05T00:00:00.000Z",
      }),
      sourceTimestampTrustworthy: false,
      sourceTimestampKind: "created" as const,
    };
    const newer = {
      ...version({
        id: "newer",
        sourceCreatedAt: "2026-07-04T01:00:00.000Z",
        observedAt: "2026-07-05T00:00:00.000Z",
      }),
      sourceTimestampTrustworthy: false,
      sourceTimestampKind: "created" as const,
    };
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      enforcementMode: "live",
      versions: [newer, older],
    });
    expect(result.governingVersionKey).toBe("newer:newer");
  });

  it("gives timing-unknown compliant feedback the benefit of the doubt", () => {
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      enforcementMode: "live",
      versions: [version({ sourceCreatedAt: null, observedAt: "2026-07-04T00:01:00.000Z" })],
    });
    expect(result.timingStatus).toBe("unknown");
    expect(result.rawOnTimeCompliant).toBe(false);
    expect(result.adjustedCompliant).toBe(true);
    expect(result.violation).toBe(false);
    expect(result.deductionCandidate).toBe(false);
  });

  it("does not let an untimestamped backfill erase a previously proven violation", () => {
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      enforcementMode: "live",
      previousOnTimeLock: {
        locked: false,
        versionKey: null,
        provedAt: new Date("2026-07-03T17:00:00.000Z"),
        violationLocked: true,
      },
      versions: [version({ sourceCreatedAt: null, observedAt: "2026-07-04T00:01:00.000Z" })],
    });
    expect(result.timingStatus).toBe("unknown");
    expect(result.adjustedCompliant).toBe(false);
    expect(result.violation).toBe(true);
    expect(result.remediatedLate).toBe(true);
    expect(result.deductionCandidate).toBe(true);
  });

  it("ignores historical locks produced by a different policy or mapping", () => {
    const staleLock = {
      locked: true,
      versionKey: "old-mapping-version",
      provedAt: new Date("2026-07-02T10:00:00.000Z"),
      violationLocked: false,
      policyVersion: 1,
      mappingVersion: 1,
    };
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      policyVersion: 1,
      mappingVersion: 2,
      enforcementMode: "live",
      previousOnTimeLock: staleLock,
      versions: [],
    });
    expect(result.onTimeComplianceLocked).toBe(false);
    expect(result.violation).toBe(true);
  });

  it("invalidates a lock when Wise corrects the canonical scheduled end and deadline", () => {
    const oldEnd = new Date("2026-07-01T10:00:00.000Z");
    const correctedEnd = new Date("2026-07-04T10:00:00.000Z");
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: correctedEnd,
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      policyVersion: 1,
      mappingVersion: 1,
      enforcementMode: "live",
      previousOnTimeLock: {
        locked: false,
        versionKey: null,
        provedAt: new Date("2026-07-03T17:00:00.000Z"),
        violationLocked: true,
        policyVersion: 1,
        mappingVersion: 1,
        scheduledEndAt: oldEnd,
        deadlineAt: calculateFeedbackDeadline(oldEnd),
      },
      versions: [],
    });
    expect(result.due).toBe(false);
    expect(result.violation).toBe(false);
    expect(result.timingStatus).toBe("not_due");
  });

  it("lets newly discovered trustworthy pre-deadline proof overturn an absence lock", () => {
    const scheduledEndAt = new Date("2026-07-01T10:00:00.000Z");
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt,
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      policyVersion: 1,
      mappingVersion: 1,
      enforcementMode: "live",
      previousOnTimeLock: {
        locked: false,
        versionKey: null,
        provedAt: new Date("2026-07-03T17:00:00.000Z"),
        violationLocked: true,
        policyVersion: 1,
        mappingVersion: 1,
        scheduledEndAt,
        deadlineAt: calculateFeedbackDeadline(scheduledEndAt),
      },
      versions: [version({
        id: "late-discovered-proof",
        sourceCreatedAt: "2026-07-02T10:00:00.000Z",
        observedAt: "2026-07-05T00:00:00.000Z",
      })],
    });
    expect(result.timingStatus).toBe("on_time");
    expect(result.violation).toBe(false);
    expect(result.onTimeComplianceLocked).toBe(true);
  });

  it("does not turn a pre-deadline observation into an invented Wise source timestamp", () => {
    const result = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      now: new Date("2026-07-02T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      enforcementMode: "live",
      versions: [version({ sourceCreatedAt: null, observedAt: "2026-07-02T00:00:00.000Z" })],
    });
    expect(result.timingStatus).toBe("unknown");
    expect(result.rawOnTimeCompliant).toBe(false);
    expect(result.adjustedCompliant).toBe(true);
  });

  it("does not assess a session whose source is broken", () => {
    const paused = evaluateSessionCompliance({
      sourceStatus: "form_drift",
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      enforcementMode: "live",
      versions: [],
    });
    expect(paused.assessed).toBe(false);
    expect(paused.deductionCandidate).toBe(false);
  });

  it("observes pre-activation sessions but never makes them a deduction candidate", () => {
    // Historical sessions are assessed so past timeliness is visible, while
    // the enforcement boundary stays absolute.
    const historical = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: new Date("2026-06-30T10:00:00.000Z"),
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      enforcementMode: "live",
      versions: [],
    });
    expect(historical.policyApplies).toBe(false);
    expect(historical.assessed).toBe(true);
    expect(historical.deductionCandidate).toBe(false);
  });

  it("keeps a paused feature fully unassessed regardless of evidence", () => {
    const paused = evaluateSessionCompliance({
      sourceStatus: "ready",
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      now: new Date("2026-07-05T00:00:00.000Z"),
      policyEffectiveAt: new Date("2026-06-01T00:00:00.000Z"),
      enforcementMode: "paused",
      versions: [],
    });
    expect(paused.assessed).toBe(false);
    expect(paused.deductionCandidate).toBe(false);
  });
});

// Deadline for a session ending 2026-06-01 is 2026-06-03T16:59:59.999Z.
const DEADLINE = new Date("2026-06-03T16:59:59.999Z");
const COVERAGE_FROM = new Date("2026-05-27T00:00:00.000Z");

function event(input: {
  at: string;
  role?: string | null;
  autoSubmitted?: boolean | null;
  id?: string;
}): FeedbackEventEvidence {
  return {
    eventId: input.id ?? `event-${input.at}`,
    sessionId: "session-1",
    eventTimestamp: new Date(input.at),
    autoSubmitted: input.autoSubmitted ?? null,
    actorWiseUserId: null,
    actorName: null,
    actorRole: input.role ?? null,
  };
}

describe("feedbackSubmitterRole", () => {
  it("classifies an auto-submission as AUTO even though it carries no actor", () => {
    expect(feedbackSubmitterRole(event({ at: "2026-06-02T01:00:00.000Z", autoSubmitted: true }))).toBe("AUTO");
  });

  it("prefers the auto flag over a populated actor role", () => {
    const role = feedbackSubmitterRole(
      event({ at: "2026-06-02T01:00:00.000Z", role: "TEACHER", autoSubmitted: true }),
    );
    expect(role).toBe("AUTO");
  });

  it("normalizes the Wise actor role and falls back to UNKNOWN", () => {
    expect(feedbackSubmitterRole(event({ at: "2026-06-02T01:00:00.000Z", role: "teacher" }))).toBe("TEACHER");
    expect(feedbackSubmitterRole(event({ at: "2026-06-02T01:00:00.000Z", role: "ADMIN" }))).toBe("ADMIN");
    expect(feedbackSubmitterRole(event({ at: "2026-06-02T01:00:00.000Z", role: null }))).toBe("UNKNOWN");
  });
});

describe("deriveEventTimingEvidence", () => {
  it("proves on_time from a tutor-authored event before the deadline", () => {
    const result = deriveEventTimingEvidence({
      events: [event({ at: "2026-06-02T01:00:00.000Z", role: "TEACHER" })],
      deadlineAt: DEADLINE,
      eventCoverageFrom: COVERAGE_FROM,
    });
    expect(result.status).toBe("on_time");
    expect(result.provenAt?.toISOString()).toBe("2026-06-02T01:00:00.000Z");
    expect(result.source).toBe("activity_event");
  });

  it("takes the earliest qualifying event when a tutor edits their feedback", () => {
    const result = deriveEventTimingEvidence({
      events: [
        event({ at: "2026-06-05T09:00:00.000Z", role: "TEACHER", id: "late-edit" }),
        event({ at: "2026-06-02T01:00:00.000Z", role: "TEACHER", id: "original" }),
      ],
      deadlineAt: DEADLINE,
      eventCoverageFrom: COVERAGE_FROM,
    });
    expect(result.status).toBe("on_time");
    expect(result.provenAt?.toISOString()).toBe("2026-06-02T01:00:00.000Z");
  });

  it("proves late when the tutor submitted only after the deadline", () => {
    const result = deriveEventTimingEvidence({
      events: [event({ at: "2026-06-05T09:00:00.000Z", role: "TEACHER" })],
      deadlineAt: DEADLINE,
      eventCoverageFrom: COVERAGE_FROM,
    });
    expect(result.status).toBe("late");
    expect(result.provenAt?.toISOString()).toBe("2026-06-05T09:00:00.000Z");
  });

  it("does not let an admin submitting on the tutor's behalf prove compliance", () => {
    const result = deriveEventTimingEvidence({
      events: [event({ at: "2026-06-02T01:00:00.000Z", role: "ADMIN" })],
      deadlineAt: DEADLINE,
      eventCoverageFrom: COVERAGE_FROM,
    });
    expect(result.status).toBe("late");
    expect(result.provenAt).toBeNull();
    expect(result.submitterRoles).toEqual(["ADMIN"]);
  });

  it("does not let an auto-submission prove compliance", () => {
    const result = deriveEventTimingEvidence({
      events: [event({ at: "2026-06-02T01:00:00.000Z", autoSubmitted: true })],
      deadlineAt: DEADLINE,
      eventCoverageFrom: COVERAGE_FROM,
    });
    expect(result.status).toBe("late");
    expect(result.submitterRoles).toEqual(["AUTO"]);
  });

  it("reports every distinct submitter role seen on the session", () => {
    const result = deriveEventTimingEvidence({
      events: [
        event({ at: "2026-06-02T01:00:00.000Z", autoSubmitted: true, id: "a" }),
        event({ at: "2026-06-02T02:00:00.000Z", role: "ADMIN", id: "b" }),
        event({ at: "2026-06-02T03:00:00.000Z", role: "TEACHER", id: "c" }),
      ],
      deadlineAt: DEADLINE,
      eventCoverageFrom: COVERAGE_FROM,
    });
    expect(result.status).toBe("on_time");
    expect(result.submitterRoles).toEqual(["ADMIN", "AUTO", "TEACHER"]);
  });

  it("fails closed to unknown when the deadline predates event coverage", () => {
    const result = deriveEventTimingEvidence({
      events: [],
      deadlineAt: new Date("2026-04-10T16:59:59.999Z"),
      eventCoverageFrom: COVERAGE_FROM,
    });
    expect(result.status).toBe("unknown");
    expect(result.source).toBe("none");
  });

  it("fails closed to unknown when no feedback events have ever been collected", () => {
    const result = deriveEventTimingEvidence({
      events: [],
      deadlineAt: DEADLINE,
      eventCoverageFrom: null,
    });
    expect(result.status).toBe("unknown");
    expect(result.source).toBe("none");
  });

  it("still proves on_time for a pre-coverage session when a tutor event exists", () => {
    // Absence is not evidence before coverage, but presence is always evidence.
    const result = deriveEventTimingEvidence({
      events: [event({ at: "2026-04-09T01:00:00.000Z", role: "TEACHER" })],
      deadlineAt: new Date("2026-04-10T16:59:59.999Z"),
      eventCoverageFrom: COVERAGE_FROM,
    });
    expect(result.status).toBe("on_time");
  });
});
