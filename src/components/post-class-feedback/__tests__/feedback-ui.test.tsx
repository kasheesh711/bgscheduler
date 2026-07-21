import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FeedbackSessionRow } from "@/types/post-class-feedback";
import { OutcomeBadge, feedbackOutcome, formatRate } from "../feedback-ui";

function session(overrides: Partial<FeedbackSessionRow> = {}): FeedbackSessionRow {
  const answer = { characters: 25, meaningful: true };
  return {
    id: "session-1",
    wiseSessionId: "wise-1",
    classId: "class-1",
    className: "Physics – M.4",
    subject: "Physics",
    tutorKey: "tutor-1",
    tutorName: "Nattapong J.",
    students: ["Pakorn"],
    scheduledStartAt: "2026-07-01T10:00:00.000Z",
    scheduledEndAt: "2026-07-01T11:00:00.000Z",
    deadlineAt: "2026-07-03T16:59:59.000Z",
    eligible: true,
    eligibilityReason: "ended_positive_credits",
    sourceStatus: "ready",
    contentStatus: "substantive",
    timingStatus: "on_time",
    combinedCharacterCount: 325,
    required: { topics: answer, performance: answer, improvement: answer },
    versionCount: 1,
    observedAt: "2026-07-02T10:02:00.000Z",
    reminder: { lastKind: null, lastSentAt: null, status: "none", attempts: 0 },
    deduction: null,
    ai: { suspect: false, confirmedConcerns: 0, pendingConcerns: 0, concerns: [] },
    sourceIssueContext: [],
    wiseUrl: "https://example.test/wise/session-1",
    ...overrides,
  };
}

describe("post-class feedback outcome presentation", () => {
  it("keeps source-paused status ahead of content or timing", () => {
    expect(feedbackOutcome(session({ sourceStatus: "form_drift", timingStatus: "late" }))).toBe("source_paused");
  });

  it("distinguishes a late substantive backfill from missing feedback", () => {
    expect(feedbackOutcome(session({ timingStatus: "late", contentStatus: "substantive" }))).toBe("late");
    expect(feedbackOutcome(session({ timingStatus: "late", contentStatus: "blank" }))).toBe("missing");
  });

  it("renders timing-unknown as its own benefit-of-doubt state", () => {
    const markup = renderToStaticMarkup(<OutcomeBadge session={session({ timingStatus: "unknown" })} />);
    expect(markup).toContain("Timing unknown");
  });

  it("places known ineligible sessions in an explicit excluded state", () => {
    const excluded = session({
      eligible: false,
      eligibilityReason: "missed_or_no_show",
      contentStatus: "missing",
      timingStatus: "late",
    });
    expect(feedbackOutcome(excluded)).toBe("excluded");
    expect(renderToStaticMarkup(<OutcomeBadge session={excluded} />)).toContain("Excluded");
  });

  it("keeps ambiguous billing evidence paused instead of calling it missing", () => {
    expect(feedbackOutcome(session({
      eligible: false,
      eligibilityReason: "billing_evidence_missing",
      contentStatus: "missing",
      timingStatus: "late",
    }))).toBe("source_paused");
  });

  it("formats either fractional or percentage API rates consistently", () => {
    expect(formatRate(0.74)).toBe("74.0%");
    expect(formatRate(74)).toBe("74.0%");
  });
});
