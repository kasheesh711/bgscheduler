import type { Database } from "@/lib/db";
import {
  aiSchedulerModel,
  isAiSchedulerConfigured,
  redactAiSchedulerInput,
} from "@/lib/ai/scheduler";
import { buildConversationTitle, type SchedulerConversationMessageForPrompt } from "@/lib/ai/scheduler-conversation";
import {
  createSchedulerFeedback,
  createSchedulerConversation,
  createSchedulerMessage,
  getSchedulerConversationWithMessages,
  logSchedulerRun,
  touchSchedulerConversationAfterMessage,
} from "@/lib/ai/scheduler-data";
import { executeSchedulerTurn, schedulerRunMetadata } from "@/lib/ai/scheduler-service";
import { fetchLineProfile, pushLineTextMessage } from "@/lib/line/client";
import { classifyLineSchedulerMessage, type LineSchedulerClassification } from "@/lib/line/classifier";
import {
  createLineSchedulerReview,
  getLineMessageForProcessing,
  getLineSchedulerReview,
  getLineSchedulerReviewByInboundMessage,
  insertOutboundLineMessage,
  linkLineThreadConversation,
  loadRecentLineMessages,
  patchLineSchedulerReview,
  updateLineContactProfile,
  updateLineMessageClassification,
  updateLineMessageClassificationFeedback,
  type LineReviewActor,
  type LineSchedulerReviewDto,
} from "@/lib/line/data";
import {
  ensureLineContactStudentLinkSuggestions,
  listVerifiedLineStudentKeys,
} from "@/lib/line/student-links";
import { v5 as uuidv5 } from "uuid";

const LINE_ACTOR = {
  email: "line-webhook@begifted.local",
  name: "LINE Webhook",
};
const LINE_SCHEDULER_REVIEW_RETRY_NAMESPACE = "5c7e94bf-f5e3-4864-bc8f-f3865c2f4c05";

function asRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function messagesForPrompt(
  messages: { role: "admin" | "parent" | "assistant" | "system"; content: string }[],
): SchedulerConversationMessageForPrompt[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function selectedSuggestionPayload(suggestions: unknown[]): Record<string, unknown> | null {
  const first = suggestions[0];
  return first && typeof first === "object" && !Array.isArray(first)
    ? asRecord(first)
    : null;
}

function selectedTutorIdsFromSuggestion(suggestion: Record<string, unknown> | null): string[] {
  const tutors = Array.isArray(suggestion?.tutors) ? suggestion.tutors : [];
  return tutors
    .map((tutor) => tutor && typeof tutor === "object" && !Array.isArray(tutor)
      ? (tutor as Record<string, unknown>).tutorGroupId
      : null)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .slice(0, 12);
}

function schedulerReviewRetryKey(reviewId: string): string {
  return uuidv5(`line-scheduler-review:${reviewId}`, LINE_SCHEDULER_REVIEW_RETRY_NAMESPACE);
}

async function recordPostSendAudit(label: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`Failed to record LINE scheduler ${label}`, error);
  }
}

function reviewAgeMs(review: LineSchedulerReviewDto): number {
  return Date.now() - new Date(review.createdAt).getTime();
}

export async function processLineMessageForScheduler(
  db: Database,
  lineMessageId: string,
): Promise<{ review: LineSchedulerReviewDto | null; category?: string }> {
  const lineMessage = await getLineMessageForProcessing(db, lineMessageId);
  if (!lineMessage || !lineMessage.text.trim()) return { review: null };

  const profile = await fetchLineProfile(lineMessage.lineUserId).catch(() => null);
  await updateLineContactProfile(db, lineMessage.lineUserId, profile).catch(() => undefined);
  await ensureLineContactStudentLinkSuggestions(
    db,
    lineMessage.contactId,
    profile?.displayName ?? lineMessage.contactDisplayName,
  ).catch(() => undefined);

  const recentMessages = await loadRecentLineMessages(db, lineMessage.threadId);
  const classification = await classifyLineSchedulerMessage({
    messageText: lineMessage.text,
    recentMessages,
  });
  await updateLineMessageClassification(db, lineMessage.id, classification);

  if (classification.category !== "scheduling_request" && classification.category !== "scheduling_change") {
    return { review: null, category: classification.category };
  }

  if (!isAiSchedulerConfigured()) {
    const review = await createLineSchedulerReview(db, {
      threadId: lineMessage.threadId,
      contactId: lineMessage.contactId,
      inboundMessageId: lineMessage.id,
      conversationId: lineMessage.aiSchedulerConversationId,
      classification,
      proposedDraft: "",
      selectedSuggestion: null,
      selectedTutorIds: [],
    });
    return { review, category: classification.category };
  }

  const startedAt = Date.now();
  const model = aiSchedulerModel();
  let conversationId = lineMessage.aiSchedulerConversationId;
  if (!conversationId) {
    const label = lineMessage.contactDisplayName || "LINE parent";
    const conversation = await createSchedulerConversation(db, LINE_ACTOR, {
      title: `LINE: ${label}`,
      customerParentName: lineMessage.contactDisplayName ?? undefined,
      customerContact: lineMessage.lineUserId,
      notes: `Imported from LINE user ${lineMessage.lineUserId}`,
    });
    conversationId = conversation.id;
    await linkLineThreadConversation(db, lineMessage.threadId, conversationId);
  }

  const existing = await getSchedulerConversationWithMessages(db, conversationId);
  if (!existing) {
    throw new Error("Linked scheduler conversation was not found");
  }

  const parentMessage = await createSchedulerMessage(db, {
    conversationId,
    role: "parent",
    content: lineMessage.text,
    actor: { email: null, name: lineMessage.contactDisplayName || "LINE parent" },
  });

  try {
    const execution = await executeSchedulerTurn({
      db,
      currentState: existing.conversation.extractedState,
      messages: messagesForPrompt([
        ...existing.messages,
        parentMessage,
      ]),
      sourceText: lineMessage.text,
    });
    const { extraction, assistantResult, latencyBreakdownMs } = execution;
    const assistantPayload = asRecord({
      ...assistantResult,
      extractedState: extraction.state,
      line: {
        sourceMessageId: lineMessage.id,
        classifierCategory: classification.category,
      },
    });
    const assistantMessage = await createSchedulerMessage(db, {
      conversationId,
      role: "assistant",
      content: assistantResult.assistantMessage,
      structuredPayload: assistantPayload,
      model,
      latencyMs: Date.now() - startedAt,
      actor: { email: null, name: "AI Scheduler" },
    });

    const shouldAutoTitle = existing.conversation.title.startsWith("LINE:");
    const conversation = await touchSchedulerConversationAfterMessage(db, conversationId, {
      extractedState: assistantResult.state,
      title: shouldAutoTitle
        ? extraction.title ?? buildConversationTitle(assistantResult.state, lineMessage.text)
        : undefined,
      customerParentName: assistantResult.state.parentName ?? lineMessage.contactDisplayName ?? undefined,
      customerStudentName: assistantResult.state.studentName,
      customerContact: assistantResult.state.contact ?? lineMessage.lineUserId,
    });
    const logId = await logSchedulerRun(db, {
      conversationId,
      messageId: assistantMessage.id,
      createdByEmail: LINE_ACTOR.email,
      status: assistantResult.parentReady ? "solved" : "needs_clarification",
      inputPreviewRedacted: redactAiSchedulerInput(lineMessage.text),
      model,
      latencyMs: Date.now() - startedAt,
      ...schedulerRunMetadata(latencyBreakdownMs),
      parsedPayload: asRecord(extraction),
      solverPayload: assistantPayload,
      warnings: assistantResult.warnings,
    });
    const selectedSuggestion = selectedSuggestionPayload(assistantResult.suggestions);
    const review = await createLineSchedulerReview(db, {
      threadId: lineMessage.threadId,
      contactId: lineMessage.contactId,
      inboundMessageId: lineMessage.id,
      conversationId: conversation?.id ?? conversationId,
      schedulerMessageId: assistantMessage.id,
      schedulerRunId: logId === "unlogged" ? null : logId,
      classification,
      proposedDraft: assistantResult.parentMessageDraft,
      selectedSuggestion,
      selectedTutorIds: selectedTutorIdsFromSuggestion(selectedSuggestion),
    });

    return { review, category: classification.category };
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI scheduling failed";
    const assistantMessage = await createSchedulerMessage(db, {
      conversationId,
      role: "assistant",
      content: "I could not process this LINE scheduling message. Please review it manually.",
      structuredPayload: { error: message, line: { sourceMessageId: lineMessage.id } },
      model,
      latencyMs: Date.now() - startedAt,
      actor: { email: null, name: "AI Scheduler" },
    });
    await touchSchedulerConversationAfterMessage(db, conversationId);
    const logId = await logSchedulerRun(db, {
      conversationId,
      messageId: assistantMessage.id,
      createdByEmail: LINE_ACTOR.email,
      status: "failed",
      inputPreviewRedacted: redactAiSchedulerInput(lineMessage.text),
      model,
      latencyMs: Date.now() - startedAt,
      ...schedulerRunMetadata({
        totalMs: Date.now() - startedAt,
        dbMs: 0,
        modelMs: 0,
        searchMs: 0,
      }),
      errorMessage: message,
    });
    const review = await createLineSchedulerReview(db, {
      threadId: lineMessage.threadId,
      contactId: lineMessage.contactId,
      inboundMessageId: lineMessage.id,
      conversationId,
      schedulerMessageId: assistantMessage.id,
      schedulerRunId: logId === "unlogged" ? null : logId,
      classification,
      proposedDraft: "",
      selectedSuggestion: null,
      selectedTutorIds: [],
    });
    return { review, category: classification.category };
  }
}

// Promote a message the AI did NOT escalate (false negative) into a pending
// review. Records the classification correction, then creates a pending_review
// row with an empty draft — identical to the no-AI webhook path. Never sends.
export async function promoteLineMessageToReview(input: {
  db: Database;
  lineMessageId: string;
  actor: LineReviewActor;
}): Promise<{ review: LineSchedulerReviewDto | null; alreadyExisted: boolean }> {
  const lineMessage = await getLineMessageForProcessing(input.db, input.lineMessageId);
  if (!lineMessage || !lineMessage.text.trim()) {
    return { review: null, alreadyExisted: false };
  }

  const existing = await getLineSchedulerReviewByInboundMessage(input.db, lineMessage.id);
  if (existing) {
    return { review: existing, alreadyExisted: true };
  }

  await recordPostSendAudit("classification feedback", () => updateLineMessageClassificationFeedback(input.db, {
    messageId: lineMessage.id,
    reviewedCategory: "scheduling_request",
    actor: input.actor,
  }));

  const classification: LineSchedulerClassification = {
    category: "scheduling_request",
    confidence: lineMessage.classifierConfidence ?? 0,
    summary: lineMessage.classifierSummary?.trim() || "Promoted from the missed-message queue",
    rationale: lineMessage.classifierRationale?.trim() || "Manually promoted by an admin from the missed-message queue.",
  };

  const review = await createLineSchedulerReview(input.db, {
    threadId: lineMessage.threadId,
    contactId: lineMessage.contactId,
    inboundMessageId: lineMessage.id,
    conversationId: lineMessage.aiSchedulerConversationId,
    classification,
    proposedDraft: "",
    selectedSuggestion: null,
    selectedTutorIds: [],
  });

  return { review, alreadyExisted: false };
}

export async function approveLineSchedulerReview(input: {
  db: Database;
  reviewId: string;
  finalText: string;
  selectedTutorIds?: string[];
  studentLinkOverride?: boolean;
  actor: LineReviewActor;
}): Promise<LineSchedulerReviewDto | null> {
  const review = await getLineSchedulerReview(input.db, input.reviewId);
  if (!review) return null;
  if (review.status !== "pending_review") return review;

  const verifiedStudentKeys = await listVerifiedLineStudentKeys(input.db, review.contactId);
  if (verifiedStudentKeys.length === 0 && !input.studentLinkOverride) {
    throw new Error("Verify a LINE student link or mark this contact as unmatched before sending");
  }

  const finalText = input.finalText.trim() || review.proposedDraft.trim();
  if (!finalText) throw new Error("Final LINE message cannot be empty");
  const selectedTutorIds = input.selectedTutorIds ?? review.selectedTutorIds;
  const retryKey = schedulerReviewRetryKey(review.id);

  const pushResult = await pushLineTextMessage({
    to: review.lineUserId,
    text: finalText,
    retryKey,
  });

  const sentReview = await patchLineSchedulerReview(input.db, input.reviewId, {
    status: "approved_sent",
    finalText,
    selectedTutorIds,
    studentLinkOverride: Boolean(input.studentLinkOverride),
    verifiedStudentKeys,
    sendLineMessageId: pushResult.sentMessageId,
    sendResponse: {
      ...pushResult.response,
      retryKey: pushResult.retryKey,
    },
    actor: input.actor,
  });

  await recordPostSendAudit("outbound message", () => insertOutboundLineMessage(input.db, {
    threadId: review.threadId,
    contactId: review.contactId,
    lineMessageId: pushResult.sentMessageId,
    text: finalText,
    raw: {
      ...pushResult.response,
      retryKey: pushResult.retryKey,
    },
  }));
  await recordPostSendAudit("scheduler feedback", () => createSchedulerFeedback(input.db, {
    conversationId: review.conversationId,
    messageId: review.schedulerMessageId,
    schedulerRunId: review.schedulerRunId,
    action: finalText === review.proposedDraft.trim() ? "accept" : "edit",
    selectedTutorIds,
    editedParentDraft: finalText === review.proposedDraft.trim() ? null : finalText,
    lineReviewId: review.id,
    classifierConfidence: review.classifierConfidence,
    timeToReviewMs: reviewAgeMs(review),
    actor: input.actor,
  }));

  return sentReview;
}

export async function acceptLineSchedulerReviewNoSend(input: {
  db: Database;
  reviewId: string;
  finalText?: string;
  selectedTutorIds?: string[];
  studentLinkOverride?: boolean;
  actor: LineReviewActor;
}): Promise<LineSchedulerReviewDto | null> {
  const review = await getLineSchedulerReview(input.db, input.reviewId);
  if (!review) return null;
  if (review.status !== "pending_review") return review;

  const finalText = input.finalText?.trim() || review.proposedDraft;
  const selectedTutorIds = input.selectedTutorIds ?? review.selectedTutorIds;
  const verifiedStudentKeys = await listVerifiedLineStudentKeys(input.db, review.contactId);
  await createSchedulerFeedback(input.db, {
    conversationId: review.conversationId,
    messageId: review.schedulerMessageId,
    schedulerRunId: review.schedulerRunId,
    action: finalText.trim() === review.proposedDraft.trim() ? "accept" : "edit",
    selectedTutorIds,
    editedParentDraft: finalText.trim() === review.proposedDraft.trim() ? null : finalText,
    lineReviewId: review.id,
    classifierConfidence: review.classifierConfidence,
    timeToReviewMs: reviewAgeMs(review),
    actor: input.actor,
  });

  return patchLineSchedulerReview(input.db, input.reviewId, {
    status: "accepted_no_send",
    finalText,
    selectedTutorIds,
    studentLinkOverride: Boolean(input.studentLinkOverride),
    verifiedStudentKeys,
    actor: input.actor,
  });
}

export async function rejectLineSchedulerReview(input: {
  db: Database;
  reviewId: string;
  rejectionReason: string;
  reasonCategory: string;
  staffCorrection: string;
  rejectedTutorIds?: string[];
  actor: LineReviewActor;
}): Promise<LineSchedulerReviewDto | null> {
  const review = await getLineSchedulerReview(input.db, input.reviewId);
  if (!review) return null;
  if (review.status !== "pending_review") return review;

  const rejectionReason = input.rejectionReason.trim();
  const reasonCategory = input.reasonCategory.trim();
  const staffCorrection = input.staffCorrection.trim();
  if (!rejectionReason || !reasonCategory || !staffCorrection) {
    throw new Error("Rejected recommendations require a category, reason, and staff correction");
  }
  const verifiedStudentKeys = await listVerifiedLineStudentKeys(input.db, review.contactId);
  const rejectedTutorIds = input.rejectedTutorIds ?? review.selectedTutorIds;
  await createSchedulerFeedback(input.db, {
    conversationId: review.conversationId,
    messageId: review.schedulerMessageId,
    schedulerRunId: review.schedulerRunId,
    action: "reject",
    rejectedTutorIds,
    rejectionReason,
    staffCorrection,
    lineReviewId: review.id,
    classifierConfidence: review.classifierConfidence,
    timeToReviewMs: reviewAgeMs(review),
    actor: input.actor,
  });

  return patchLineSchedulerReview(input.db, input.reviewId, {
    status: "rejected",
    rejectionReason,
    reasonCategory,
    staffCorrection,
    selectedTutorIds: rejectedTutorIds,
    verifiedStudentKeys,
    actor: input.actor,
  });
}

export async function dismissLineSchedulerReview(input: {
  db: Database;
  reviewId: string;
  rejectionReason?: string;
  actor: LineReviewActor;
}): Promise<LineSchedulerReviewDto | null> {
  const review = await getLineSchedulerReview(input.db, input.reviewId);
  if (!review) return null;
  if (review.status !== "pending_review") return review;

  await recordPostSendAudit("scheduler feedback", () => createSchedulerFeedback(input.db, {
    conversationId: review.conversationId,
    messageId: review.schedulerMessageId,
    schedulerRunId: review.schedulerRunId,
    action: "dismiss",
    rejectionReason: input.rejectionReason?.trim() || null,
    lineReviewId: review.id,
    classifierConfidence: review.classifierConfidence,
    timeToReviewMs: reviewAgeMs(review),
    actor: input.actor,
  }));

  return patchLineSchedulerReview(input.db, input.reviewId, {
    status: "dismissed",
    rejectionReason: input.rejectionReason?.trim() || null,
    actor: input.actor,
  });
}
