import { describe, expect, it } from "vitest";
import type { FeedbackSessionRow } from "@/types/post-class-feedback";
import { filterFeedbackSessions } from "../operations-tab";

function row(id: string, tutorName: string, student: string, overrides: Partial<FeedbackSessionRow> = {}): FeedbackSessionRow {
  const answer = { characters: 100, meaningful: true };
  return {
    id,
    wiseSessionId: `wise-${id}`,
    classId: `class-${id}`,
    className: "English – M.3",
    subject: "English",
    tutorKey: `tutor-${id}`,
    tutorName,
    students: [student],
    scheduledStartAt: "2026-07-01T10:00:00.000Z",
    scheduledEndAt: "2026-07-01T11:00:00.000Z",
    deadlineAt: "2026-07-03T16:59:59.000Z",
    eligible: true,
    eligibilityReason: "ended_positive_credits",
    sourceStatus: "ready",
    contentStatus: "substantive",
    timingStatus: "on_time",
    submittedBy: "tutor",
    combinedCharacterCount: 300,
    required: { topics: answer, performance: answer, improvement: answer },
    versionCount: 1,
    observedAt: null,
    reminder: { lastKind: null, lastSentAt: null, status: "none", attempts: 0 },
    deduction: null,
    ai: { suspect: false, confirmedConcerns: 0, pendingConcerns: 0, concerns: [] },
    sourceIssueContext: [],
    wiseUrl: "",
    ...overrides,
  };
}

describe("post-class operations filters", () => {
  const sessions = [
    row("1", "Nattapong J.", "Pakorn"),
    row("2", "Kanyarat S.", "Nichat", { timingStatus: "late", contentStatus: "blank", reminder: { lastKind: "deadline_day", lastSentAt: null, status: "failed", attempts: 3 } }),
    row("3", "Akasit P.", "Phattharaphon", { sourceStatus: "identity_review" }),
    row("4", "Warin S.", "Kanda", { eligible: false, eligibilityReason: "complimentary_or_trial", contentStatus: "missing", timingStatus: "late" }),
  ];

  it("matches canonical tutor and student names case-insensitively", () => {
    const filters = { query: "pakorn", outcome: "all", reminder: "all", source: "all", submitter: "all" } as const;
    expect(filterFeedbackSessions(sessions, filters).map((item) => item.id)).toEqual(["1"]);
  });

  it("combines objective outcome and reminder failure filters", () => {
    const filters = { query: "", outcome: "missing", reminder: "failed", source: "all", submitter: "all" } as const;
    expect(filterFeedbackSessions(sessions, filters).map((item) => item.id)).toEqual(["2"]);
  });

  it("surfaces identity review sessions under source-paused", () => {
    const filters = { query: "", outcome: "source_paused", reminder: "all", source: "all", submitter: "all" } as const;
    expect(filterFeedbackSessions(sessions, filters).map((item) => item.id)).toEqual(["3"]);
  });

  it("labels known ineligible sessions as excluded instead of missing or late", () => {
    const filters = { query: "", outcome: "excluded", reminder: "all", source: "all", submitter: "all" } as const;
    expect(filterFeedbackSessions(sessions, filters).map((item) => item.id)).toEqual(["4"]);
  });
});
