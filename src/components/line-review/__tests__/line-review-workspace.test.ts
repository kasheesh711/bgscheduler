import { describe, expect, it } from "vitest";
import {
  LINE_REVIEW_WORKSPACE_TABS,
  MAPPING_VALIDATION_HEADER_MODE,
  studentLinkVisibilityForReview,
} from "@/components/line-review/line-review-workspace";
import {
  MAPPING_VALIDATION_ADMIN_DEFAULT_SCOPE,
  MAPPING_VALIDATION_LEAD_DEFAULT_SCOPE,
} from "@/components/line-review/mapping-validation-workspace";
import {
  optimisticValidationPageState,
  validationPageCacheKey,
  validationRangeLabel,
} from "@/components/line-review/link-validation-panel";
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

  it("uses a standalone header for mapping validation", () => {
    expect(MAPPING_VALIDATION_HEADER_MODE).toBe("standalone");
  });

  it("defaults lead and admin validation queues to the intended scopes", () => {
    expect(MAPPING_VALIDATION_LEAD_DEFAULT_SCOPE).toBe("all");
    expect(MAPPING_VALIDATION_ADMIN_DEFAULT_SCOPE).toBe("my");
  });
});

describe("Mapping validation pagination helpers", () => {
  const task = {
    id: "link-1",
    status: "suggested",
    validationAssignedToEmail: "admin@example.com",
  } as never;

  it("keys cached pages by run, scope, page, and page size", () => {
    expect(validationPageCacheKey("run-1", "all", 2, 100)).toBe("run-1:all:2:100");
    expect(validationPageCacheKey(null, "my", 1, 100)).toBe("all-runs:my:1:100");
  });

  it("formats paged row ranges", () => {
    expect(validationRangeLabel({ page: 1, pageSize: 100, total: 678, pageCount: 7 })).toBe("1-100 of 678");
    expect(validationRangeLabel({ page: 7, pageSize: 100, total: 678, pageCount: 7 })).toBe("601-678 of 678");
    expect(validationRangeLabel({ page: 1, pageSize: 100, total: 0, pageCount: 0 })).toBe("0 shown");
  });

  it("optimistically removes suggested rows from open scopes", () => {
    const next = optimisticValidationPageState({
      tasks: [task],
      pagination: { page: 1, pageSize: 100, total: 678, pageCount: 7 },
      taskId: "link-1",
      scope: "all",
    });

    expect(next.task).toBe(task);
    expect(next.tasks).toEqual([]);
    expect(next.pagination.total).toBe(677);
    expect(next.pagination.pageCount).toBe(7);
  });

  it("leaves reviewed scopes unchanged for rollback-safe behavior", () => {
    const next = optimisticValidationPageState({
      tasks: [task],
      pagination: { page: 1, pageSize: 100, total: 17, pageCount: 1 },
      taskId: "link-1",
      scope: "verified",
    });

    expect(next.tasks).toEqual([task]);
    expect(next.pagination.total).toBe(17);
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
