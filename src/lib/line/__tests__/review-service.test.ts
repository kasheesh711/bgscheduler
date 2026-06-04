import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/line/client", () => ({
  fetchLineProfile: vi.fn(),
  pushLineTextMessage: vi.fn(),
}));
vi.mock("@/lib/line/data", () => ({
  createLineSchedulerReview: vi.fn(),
  getLineMessageForProcessing: vi.fn(),
  getLineSchedulerReview: vi.fn(),
  getLineSchedulerReviewByInboundMessage: vi.fn(),
  insertOutboundLineMessage: vi.fn(),
  linkLineThreadConversation: vi.fn(),
  loadRecentLineMessages: vi.fn(),
  patchLineSchedulerReview: vi.fn(),
  updateLineContactProfile: vi.fn(),
  updateLineMessageClassification: vi.fn(),
  updateLineMessageClassificationFeedback: vi.fn(),
}));
vi.mock("@/lib/line/student-links", () => ({
  ensureLineContactStudentLinkSuggestions: vi.fn(),
  listVerifiedLineStudentKeys: vi.fn(),
}));
vi.mock("@/lib/ai/scheduler-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/scheduler-data")>();
  return {
    ...actual,
    createSchedulerFeedback: vi.fn(),
  };
});

import { createSchedulerFeedback } from "@/lib/ai/scheduler-data";
import { pushLineTextMessage } from "@/lib/line/client";
import {
  createLineSchedulerReview,
  getLineMessageForProcessing,
  getLineSchedulerReview,
  getLineSchedulerReviewByInboundMessage,
  insertOutboundLineMessage,
  patchLineSchedulerReview,
  updateLineMessageClassificationFeedback,
} from "@/lib/line/data";
import {
  acceptLineSchedulerReviewNoSend,
  approveLineSchedulerReview,
  dismissLineSchedulerReview,
  promoteLineMessageToReview,
  rejectLineSchedulerReview,
} from "@/lib/line/review-service";
import { listVerifiedLineStudentKeys } from "@/lib/line/student-links";

const pendingReview = {
  id: "review-1",
  threadId: "thread-1",
  contactId: "contact-1",
  lineUserId: "line-user-1",
  contactDisplayName: "K. Parent",
  inboundMessageId: "line-msg-1",
  conversationId: "conv-1",
  schedulerMessageId: "assistant-msg-1",
  schedulerRunId: "run-1",
  classifierCategory: "scheduling_request",
  classifierConfidence: 0.92,
  classifierSummary: "Needs a Sunday Math class",
  classifierRationale: null,
  status: "pending_review" as const,
  intentType: "new_request" as const,
  intentPayload: {},
  proposedDraft: "Draft message",
  selectedSuggestion: null,
  finalText: null,
  rejectionReason: null,
  reasonCategory: null,
  staffCorrection: null,
  selectedTutorIds: ["tutor-1"],
  studentLinkOverride: false,
  verifiedStudentKeys: [],
  matchedStudentKeys: [],
  candidateSessions: [],
  proposedWiseActions: [],
  adminSelectedSessionIds: [],
  writebackStatus: "not_applicable" as const,
  sendLineMessageId: null,
  sendResponse: null,
  sendError: null,
  reviewedByEmail: null,
  reviewedByName: null,
  reviewedAt: null,
  createdAt: "2026-05-20T00:00:00.000Z",
  updatedAt: "2026-05-20T00:00:00.000Z",
};

describe("LINE scheduler review actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getLineSchedulerReview).mockResolvedValue(pendingReview);
    vi.mocked(listVerifiedLineStudentKeys).mockResolvedValue(["student::parent"]);
    vi.mocked(createSchedulerFeedback).mockResolvedValue({} as never);
    vi.mocked(pushLineTextMessage).mockImplementation(async (input) => ({
      retryKey: input.retryKey ?? "generated-retry",
      sentMessageId: "line-out-1",
      response: { sentMessages: [{ id: "line-out-1" }] },
    }));
    vi.mocked(patchLineSchedulerReview).mockImplementation(async (_db, _reviewId, input) => ({
      ...pendingReview,
      status: input.status,
      finalText: input.finalText ?? null,
      rejectionReason: input.rejectionReason ?? null,
      reasonCategory: input.reasonCategory ?? null,
      staffCorrection: input.staffCorrection ?? null,
      selectedTutorIds: input.selectedTutorIds ?? [],
      studentLinkOverride: input.studentLinkOverride ?? false,
      verifiedStudentKeys: input.verifiedStudentKeys ?? [],
      sendLineMessageId: input.sendLineMessageId ?? null,
      sendResponse: input.sendResponse ?? null,
      reviewedByEmail: "admin@example.com",
      reviewedByName: "Admin",
      reviewedAt: "2026-05-20T00:01:00.000Z",
      updatedAt: "2026-05-20T00:01:00.000Z",
    }));
  });

  it("push-sends exactly once when a pending review is approved", async () => {
    const review = await approveLineSchedulerReview({
      db: {} as never,
      reviewId: "review-1",
      finalText: "Approved text",
      actor: { email: "admin@example.com", name: "Admin" },
    });

    expect(pushLineTextMessage).toHaveBeenCalledWith({
      to: "line-user-1",
      text: "Approved text",
      retryKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    });
    expect(insertOutboundLineMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      threadId: "thread-1",
      contactId: "contact-1",
      lineMessageId: "line-out-1",
      text: "Approved text",
    }));
    expect(patchLineSchedulerReview).toHaveBeenCalledWith(expect.anything(), "review-1", expect.objectContaining({
      status: "approved_sent",
      finalText: "Approved text",
      verifiedStudentKeys: ["student::parent"],
      sendLineMessageId: "line-out-1",
    }));
    expect(createSchedulerFeedback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "edit",
      selectedTutorIds: ["tutor-1"],
      editedParentDraft: "Approved text",
      lineReviewId: "review-1",
      classifierConfidence: 0.92,
      timeToReviewMs: expect.any(Number),
    }));
    expect(review?.status).toBe("approved_sent");
  });

  it("keeps the review approved when post-send audit logging fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(insertOutboundLineMessage).mockRejectedValueOnce(new Error("outbound audit failed") as never);
    vi.mocked(createSchedulerFeedback).mockRejectedValueOnce(new Error("feedback failed") as never);

    try {
      const review = await approveLineSchedulerReview({
        db: {} as never,
        reviewId: "review-1",
        finalText: "Approved text",
        actor: { email: "admin@example.com", name: "Admin" },
      });

      expect(pushLineTextMessage).toHaveBeenCalledTimes(1);
      expect(patchLineSchedulerReview).toHaveBeenCalledWith(expect.anything(), "review-1", expect.objectContaining({
        status: "approved_sent",
        finalText: "Approved text",
        sendLineMessageId: "line-out-1",
      }));
      expect(review?.status).toBe("approved_sent");
      expect(consoleError).toHaveBeenCalledTimes(2);
      expect(vi.mocked(patchLineSchedulerReview).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(insertOutboundLineMessage).mock.invocationCallOrder[0],
      );
      expect(vi.mocked(patchLineSchedulerReview).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(createSchedulerFeedback).mock.invocationCallOrder[0],
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("reuses the same retry key if a sent review has to be retried after a DB failure", async () => {
    vi.mocked(patchLineSchedulerReview).mockRejectedValueOnce(new Error("temporary DB failure"));

    await expect(approveLineSchedulerReview({
      db: {} as never,
      reviewId: "review-1",
      finalText: "Approved text",
      actor: { email: "admin@example.com", name: "Admin" },
    })).rejects.toThrow(/temporary DB failure/);
    await approveLineSchedulerReview({
      db: {} as never,
      reviewId: "review-1",
      finalText: "Approved text",
      actor: { email: "admin@example.com", name: "Admin" },
    });

    expect(pushLineTextMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pushLineTextMessage).mock.calls[0][0].retryKey).toBe(
      vi.mocked(pushLineTextMessage).mock.calls[1][0].retryKey,
    );
  });

  it("does not push-send before a student link is verified or overridden", async () => {
    vi.mocked(listVerifiedLineStudentKeys).mockResolvedValue([]);

    await expect(approveLineSchedulerReview({
      db: {} as never,
      reviewId: "review-1",
      finalText: "Approved text",
      actor: { email: "admin@example.com", name: "Admin" },
    })).rejects.toThrow(/Verify a LINE student link/);

    expect(pushLineTextMessage).not.toHaveBeenCalled();
    expect(insertOutboundLineMessage).not.toHaveBeenCalled();
    expect(patchLineSchedulerReview).not.toHaveBeenCalled();
  });

  it("does not push-send when an approval request is repeated after completion", async () => {
    vi.mocked(getLineSchedulerReview).mockResolvedValue({
      ...pendingReview,
      status: "approved_sent",
      sendLineMessageId: "line-out-1",
    });

    const review = await approveLineSchedulerReview({
      db: {} as never,
      reviewId: "review-1",
      finalText: "Approved text",
      actor: { email: "admin@example.com", name: "Admin" },
    });

    expect(pushLineTextMessage).not.toHaveBeenCalled();
    expect(patchLineSchedulerReview).not.toHaveBeenCalled();
    expect(review?.status).toBe("approved_sent");
  });

  it("marks a good recommendation as accepted without LINE send", async () => {
    await acceptLineSchedulerReviewNoSend({
      db: {} as never,
      reviewId: "review-1",
      finalText: "Staff already sent this",
      actor: { email: "admin@example.com", name: "Admin" },
    });

    expect(pushLineTextMessage).not.toHaveBeenCalled();
    expect(patchLineSchedulerReview).toHaveBeenCalledWith(expect.anything(), "review-1", expect.objectContaining({
      status: "accepted_no_send",
      finalText: "Staff already sent this",
    }));
  });

  it("requires and stores rejection reason plus staff correction", async () => {
    await expect(rejectLineSchedulerReview({
      db: {} as never,
      reviewId: "review-1",
      reasonCategory: "wrong_availability",
      rejectionReason: "",
      staffCorrection: "Use Saturday instead",
      actor: { email: "admin@example.com", name: "Admin" },
    })).rejects.toThrow(/category, reason, and staff correction/);

    await rejectLineSchedulerReview({
      db: {} as never,
      reviewId: "review-1",
      reasonCategory: "wrong_availability",
      rejectionReason: "Wrong day",
      staffCorrection: "Use Saturday instead",
      actor: { email: "admin@example.com", name: "Admin" },
    });

    expect(pushLineTextMessage).not.toHaveBeenCalled();
    expect(patchLineSchedulerReview).toHaveBeenCalledWith(expect.anything(), "review-1", expect.objectContaining({
      status: "rejected",
      reasonCategory: "wrong_availability",
      rejectionReason: "Wrong day",
      staffCorrection: "Use Saturday instead",
    }));
    expect(createSchedulerFeedback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "reject",
      rejectionReason: "Wrong day",
      staffCorrection: "Use Saturday instead",
      lineReviewId: "review-1",
      classifierConfidence: 0.92,
      timeToReviewMs: expect.any(Number),
    }));
  });

  it("records a dismiss feedback row when a review is dismissed", async () => {
    await dismissLineSchedulerReview({
      db: {} as never,
      reviewId: "review-1",
      rejectionReason: "Duplicate",
      actor: { email: "admin@example.com", name: "Admin" },
    });

    expect(createSchedulerFeedback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "dismiss",
      lineReviewId: "review-1",
      classifierConfidence: 0.92,
      timeToReviewMs: expect.any(Number),
    }));
    expect(patchLineSchedulerReview).toHaveBeenCalledWith(expect.anything(), "review-1", expect.objectContaining({
      status: "dismissed",
    }));
  });
});

describe("promoteLineMessageToReview", () => {
  const lineMessage = {
    id: "line-msg-9",
    threadId: "thread-9",
    contactId: "contact-9",
    lineUserId: "line-user-9",
    contactDisplayName: "Missed Parent",
    text: "Can we move Sunday math?",
    createdAt: "2026-05-20T00:00:00.000Z",
    aiSchedulerConversationId: "conv-9",
    classifierCategory: "unclear",
    classifierConfidence: 0.4,
    classifierSummary: "Possibly a reschedule",
    classifierRationale: "Mentions a day but no clear intent",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getLineMessageForProcessing).mockResolvedValue(lineMessage);
    vi.mocked(getLineSchedulerReviewByInboundMessage).mockResolvedValue(null);
    vi.mocked(updateLineMessageClassificationFeedback).mockResolvedValue({
      id: lineMessage.id,
      classifierCategory: "unclear",
      classificationReviewedCategory: "scheduling_request",
      classificationReviewedCorrect: false,
    });
    vi.mocked(createLineSchedulerReview).mockResolvedValue({ id: "review-9" } as never);
  });

  it("records the classification correction and creates a review", async () => {
    const result = await promoteLineMessageToReview({
      db: {} as never,
      lineMessageId: "line-msg-9",
      actor: { email: "admin@example.com", name: "Admin" },
    });

    expect(updateLineMessageClassificationFeedback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      messageId: "line-msg-9",
      reviewedCategory: "scheduling_request",
    }));
    expect(createLineSchedulerReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      inboundMessageId: "line-msg-9",
      conversationId: "conv-9",
      proposedDraft: "",
    }));
    expect(result.alreadyExisted).toBe(false);
    expect(result.review).toEqual({ id: "review-9" });
  });

  it("is idempotent when a review already exists", async () => {
    vi.mocked(getLineSchedulerReviewByInboundMessage).mockResolvedValue({ id: "review-existing" } as never);

    const result = await promoteLineMessageToReview({
      db: {} as never,
      lineMessageId: "line-msg-9",
      actor: { email: "admin@example.com", name: "Admin" },
    });

    expect(result.alreadyExisted).toBe(true);
    expect(createLineSchedulerReview).not.toHaveBeenCalled();
    expect(updateLineMessageClassificationFeedback).not.toHaveBeenCalled();
  });

  it("returns null when the message is missing", async () => {
    vi.mocked(getLineMessageForProcessing).mockResolvedValue(null);

    const result = await promoteLineMessageToReview({
      db: {} as never,
      lineMessageId: "missing",
      actor: { email: "admin@example.com", name: "Admin" },
    });

    expect(result.review).toBeNull();
    expect(createLineSchedulerReview).not.toHaveBeenCalled();
  });
});
