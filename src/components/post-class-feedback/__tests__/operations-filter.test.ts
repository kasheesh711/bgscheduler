import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  FeedbackEligibilityReason,
  FeedbackSessionRow,
  PostClassFeedbackPayload,
} from "@/types/post-class-feedback";
import { OperationsTab, filterFeedbackSessions } from "../operations-tab";

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
    submittedAt: "2026-07-22T14:41:00.000Z",
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
    row("5", "Pimchanok T.", "Araya", { eligible: false, eligibilityReason: "cancelled", contentStatus: "missing", timingStatus: "late" }),
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
    expect(filterFeedbackSessions(sessions, filters).map((item) => item.id)).toEqual(["4", "5"]);
  });

  it("finds cancelled sessions by their eligibility label", () => {
    const filters = { query: "cancelled", outcome: "all", reminder: "all", source: "all", submitter: "all" } as const;
    expect(filterFeedbackSessions(sessions, filters).map((item) => item.id)).toEqual(["5"]);
  });

  it("renders the empty state for an unmatched search without throwing", () => {
    const filters = { query: "zzzz-no-match", outcome: "all", reminder: "all", source: "all", submitter: "all" } as const;
    const matches = filterFeedbackSessions(sessions, filters);
    let markup = "";

    expect(() => {
      markup = renderToStaticMarkup(createElement(OperationsTab, {
        payload: {
          sessions: matches,
          capabilities: { viewer: true, reviewer: false, finance: false, accessManager: false },
        } as PostClassFeedbackPayload,
        submitting: false,
        onMutation: async () => undefined,
      }));
    }).not.toThrow();
    expect(matches).toEqual([]);
    expect(markup).toContain("No sessions match");
  });

  it("keeps unknown and null eligibility values searchable", () => {
    const unusual = [
      row("6", "Unknown reason", "Student", {
        eligibilityReason: "future_wise_state" as FeedbackEligibilityReason,
      }),
      row("7", "No evidence", "Student", { eligibilityReason: null }),
    ];

    expect(filterFeedbackSessions(unusual, {
      query: "future_wise_state",
      outcome: "all",
      reminder: "all",
      source: "all",
      submitter: "all",
    }).map((item) => item.id)).toEqual(["6"]);
    expect(filterFeedbackSessions(unusual, {
      query: "eligibility evidence unavailable",
      outcome: "all",
      reminder: "all",
      source: "all",
      submitter: "all",
    }).map((item) => item.id)).toEqual(["7"]);
  });

  it("normalizes only string search values when payload text is malformed", () => {
    const malformed = row("8", "Fallback", "Still searchable", {
      tutorName: null as unknown as string,
      className: null as unknown as string,
      subject: undefined as unknown as string,
      wiseSessionId: 8 as unknown as string,
      students: [null as unknown as string, "Still searchable"],
    });

    expect(() => filterFeedbackSessions([malformed], {
      query: "still searchable",
      outcome: "all",
      reminder: "all",
      source: "all",
      submitter: "all",
    })).not.toThrow();
    expect(filterFeedbackSessions([malformed], {
      query: "still searchable",
      outcome: "all",
      reminder: "all",
      source: "all",
      submitter: "all",
    }).map((item) => item.id)).toEqual(["8"]);
  });
});
