import { describe, expect, it } from "vitest";
import {
  LINE_REVIEW_WORKSPACE_TABS,
  studentLinkVisibilityForReview,
} from "@/components/line-review/line-review-workspace";
import { getResolutionStepStates } from "@/components/line-review/resolution-board";

const baseReview = {
  id: "review-1",
  contactId: "contact-1",
  lineUserId: "line-user-1",
  contactDisplayName: "K. Parent",
  classifierCategory: "scheduling_request",
  classifierConfidence: 0.9,
  classifierSummary: null,
  classifierRationale: null,
  status: "pending_review",
  intentType: "cancel_one_off",
  intentPayload: {},
  proposedDraft: "",
  finalText: null,
  selectedTutorIds: [],
  studentLinkOverride: false,
  verifiedStudentKeys: [],
  matchedStudentKeys: [],
  candidateSessions: [],
  proposedWiseActions: [],
  adminSelectedSessionIds: [],
  writebackStatus: "manual_required",
  createdAt: "2026-05-29T01:00:00.000Z",
  updatedAt: "2026-05-29T01:00:00.000Z",
} as const;

const verifiedLink = {
  id: "link-1",
  contactId: "contact-1",
  wiseStudentId: "wise-student-1",
  studentKey: "ada::li",
  studentName: "Ada.Li",
  parentName: "Parent Li",
  status: "verified",
  confidence: 1,
} as const;

describe("LINE review student link visibility", () => {
  it("surfaces a newly verified selected-contact link", () => {
    const visibility = studentLinkVisibilityForReview({
      review: baseReview as never,
      activeLinks: [verifiedLink] as never,
      isSelected: true,
    });

    expect(visibility).toEqual({
      label: "Verified student",
      variant: "default",
    });
  });

  it("shows a missing-link warning when no selected-contact link is verified", () => {
    const visibility = studentLinkVisibilityForReview({
      review: baseReview as never,
      activeLinks: [],
      isSelected: true,
    });

    expect(visibility).toEqual({
      label: "No verified student",
      variant: "destructive",
    });
  });

  it("uses review matched-student evidence for non-selected queue cards", () => {
    const visibility = studentLinkVisibilityForReview({
      review: {
        ...baseReview,
        matchedStudentKeys: ["ada::li", "aya::li"],
      } as never,
      activeLinks: [],
      isSelected: false,
    });

    expect(visibility.label).toBe("Multi-child verified");
  });
});

describe("LINE review workspace navigation", () => {
  it("exposes AI review and mapping validation as top-level tabs", () => {
    expect(LINE_REVIEW_WORKSPACE_TABS.map((tab) => tab.label)).toEqual([
      "AI Review Queue",
      "Mapping Validation",
    ]);
  });
});

describe("LINE review resolution board state", () => {
  it("blocks operational work when the student is not linked", () => {
    const states = getResolutionStepStates({
      review: {
        ...baseReview,
        intentPayload: {
          issues: ["Verify this LINE contact's student code before suggesting operational Wise actions."],
        },
      } as never,
      links: [],
      candidates: [],
      actions: [],
      selectedSessionCount: 0,
    });

    expect(states.student).toBe("blocked");
    expect(states.session).toBe("blocked");
  });

  it("marks ambiguous session matches as attention until an admin selects one", () => {
    const states = getResolutionStepStates({
      review: baseReview as never,
      links: [verifiedLink] as never,
      candidates: [
        { wiseSessionId: "session-1", score: 72 },
        { wiseSessionId: "session-2", score: 70 },
      ] as never,
      actions: [],
      selectedSessionCount: 0,
    });

    expect(states.student).toBe("complete");
    expect(states.session).toBe("attention");
  });

  it("allows Wise action review after a verified student and selected session", () => {
    const states = getResolutionStepStates({
      review: baseReview as never,
      links: [verifiedLink] as never,
      candidates: [{ wiseSessionId: "session-1", score: 92 }] as never,
      actions: [{ id: "action-1" }] as never,
      selectedSessionCount: 1,
    });

    expect(states.session).toBe("complete");
    expect(states.wiseAction).toBe("ready");
  });
});
