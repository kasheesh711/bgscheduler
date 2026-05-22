import type { Database } from "@/lib/db";
import {
  aiSchedulerModel,
  isAiSchedulerConfigured,
  redactAiSchedulerInput,
} from "@/lib/ai/scheduler";
import { buildConversationTitle, type SchedulerConversationMessageForPrompt } from "@/lib/ai/scheduler-conversation";
import {
  createSchedulerConversation,
  createSchedulerMessage,
  getSchedulerConversationWithMessages,
  logSchedulerRun,
  touchSchedulerConversationAfterMessage,
} from "@/lib/ai/scheduler-data";
import { executeSchedulerTurn, schedulerRunMetadata } from "@/lib/ai/scheduler-service";
import { fetchLineProfile, pushLineTextMessage } from "@/lib/line/client";
import { classifyLineSchedulerMessage } from "@/lib/line/classifier";
import {
  createLineSchedulerReview,
  getLineMessageForProcessing,
  getLineSchedulerReview,
  insertOutboundLineMessage,
  linkLineThreadConversation,
  loadRecentLineMessages,
  patchLineSchedulerReview,
  updateLineContactProfile,
  updateLineMessageClassification,
  type LineReviewActor,
  type LineSchedulerReviewDto,
} from "@/lib/line/data";

const LINE_ACTOR = {
  email: "line-webhook@begifted.local",
  name: "LINE Webhook",
};

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

export async function processLineMessageForScheduler(
  db: Database,
  lineMessageId: string,
): Promise<{ review: LineSchedulerReviewDto | null; category?: string }> {
  const lineMessage = await getLineMessageForProcessing(db, lineMessageId);
  if (!lineMessage || !lineMessage.text.trim()) return { review: null };

  void fetchLineProfile(lineMessage.lineUserId)
    .then((profile) => updateLineContactProfile(db, lineMessage.lineUserId, profile))
    .catch(() => undefined);

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
    const review = await createLineSchedulerReview(db, {
      threadId: lineMessage.threadId,
      contactId: lineMessage.contactId,
      inboundMessageId: lineMessage.id,
      conversationId: conversation?.id ?? conversationId,
      schedulerMessageId: assistantMessage.id,
      schedulerRunId: logId === "unlogged" ? null : logId,
      classification,
      proposedDraft: assistantResult.parentMessageDraft,
      selectedSuggestion: selectedSuggestionPayload(assistantResult.suggestions),
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
    });
    return { review, category: classification.category };
  }
}

export async function approveLineSchedulerReview(input: {
  db: Database;
  reviewId: string;
  finalText: string;
  actor: LineReviewActor;
}): Promise<LineSchedulerReviewDto | null> {
  const review = await getLineSchedulerReview(input.db, input.reviewId);
  if (!review) return null;
  if (review.status !== "pending_review") return review;

  const finalText = input.finalText.trim() || review.proposedDraft.trim();
  if (!finalText) throw new Error("Final LINE message cannot be empty");

  const pushResult = await pushLineTextMessage({
    to: review.lineUserId,
    text: finalText,
  });
  await insertOutboundLineMessage(input.db, {
    threadId: review.threadId,
    contactId: review.contactId,
    lineMessageId: pushResult.sentMessageId,
    text: finalText,
    raw: {
      ...pushResult.response,
      retryKey: pushResult.retryKey,
    },
  });

  return patchLineSchedulerReview(input.db, input.reviewId, {
    status: "approved_sent",
    finalText,
    sendLineMessageId: pushResult.sentMessageId,
    sendResponse: {
      ...pushResult.response,
      retryKey: pushResult.retryKey,
    },
    actor: input.actor,
  });
}

export async function acceptLineSchedulerReviewNoSend(input: {
  db: Database;
  reviewId: string;
  finalText?: string;
  actor: LineReviewActor;
}): Promise<LineSchedulerReviewDto | null> {
  const review = await getLineSchedulerReview(input.db, input.reviewId);
  if (!review) return null;
  if (review.status !== "pending_review") return review;

  return patchLineSchedulerReview(input.db, input.reviewId, {
    status: "accepted_no_send",
    finalText: input.finalText?.trim() || review.proposedDraft,
    actor: input.actor,
  });
}

export async function rejectLineSchedulerReview(input: {
  db: Database;
  reviewId: string;
  rejectionReason: string;
  staffCorrection: string;
  actor: LineReviewActor;
}): Promise<LineSchedulerReviewDto | null> {
  const review = await getLineSchedulerReview(input.db, input.reviewId);
  if (!review) return null;
  if (review.status !== "pending_review") return review;

  const rejectionReason = input.rejectionReason.trim();
  const staffCorrection = input.staffCorrection.trim();
  if (!rejectionReason || !staffCorrection) {
    throw new Error("Rejected recommendations require a reason and staff correction");
  }

  return patchLineSchedulerReview(input.db, input.reviewId, {
    status: "rejected",
    rejectionReason,
    staffCorrection,
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

  return patchLineSchedulerReview(input.db, input.reviewId, {
    status: "dismissed",
    rejectionReason: input.rejectionReason?.trim() || null,
    actor: input.actor,
  });
}
