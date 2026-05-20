import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  aiSchedulerModel,
  bangkokTodayIso,
  isAiSchedulerConfigured,
  redactAiSchedulerInput,
} from "@/lib/ai/scheduler";
import {
  buildConversationTitle,
  extractSchedulerStateWithOpenAi,
  filterOptionsFromIndex,
  mergeSchedulerState,
  solveSchedulerTurn,
  tutorListFromIndex,
  type SchedulerConversationMessageForPrompt,
} from "@/lib/ai/scheduler-conversation";
import {
  createSchedulerMessage,
  getSchedulerConversationWithMessages,
  logSchedulerRun,
  touchSchedulerConversationAfterMessage,
} from "@/lib/ai/scheduler-data";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { listActiveProposalHolds } from "@/lib/proposals/data";

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
}).strict();

type MessageRouteContext = { params: Promise<{ conversationId: string }> };

function actorFromSession(session: { user?: { email?: string | null; name?: string | null } } | null) {
  return {
    email: session?.user?.email ?? null,
    name: session?.user?.name ?? null,
  };
}

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

async function conversationIdFromContext(ctx: MessageRouteContext) {
  const params = await ctx.params;
  return params.conversationId;
}

export async function POST(
  request: NextRequest,
  ctx: MessageRouteContext,
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isAiSchedulerConfigured()) {
    return NextResponse.json({ error: "AI scheduler is not configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const conversationId = await conversationIdFromContext(ctx);
  const db = getDb();
  const existing = await getSchedulerConversationWithMessages(db, conversationId);
  if (!existing) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }
  if (existing.conversation.status === "archived") {
    return NextResponse.json({ error: "Archived conversations cannot receive new messages" }, { status: 409 });
  }

  const actor = actorFromSession(session);
  const startedAt = Date.now();
  const model = aiSchedulerModel();
  const adminMessage = await createSchedulerMessage(db, {
    conversationId,
    role: "admin",
    content: parsed.data.content,
    actor,
  });

  try {
    const index = await ensureIndex(db);
    const activeProposalHoldsPromise = listActiveProposalHolds(db);
    const filterOptions = filterOptionsFromIndex(index);
    const tutorList = tutorListFromIndex(index);
    const extraction = await extractSchedulerStateWithOpenAi({
      currentState: existing.conversation.extractedState,
      messages: messagesForPrompt([
        ...existing.messages,
        adminMessage,
      ]),
      todayBangkok: bangkokTodayIso(),
      filterOptions,
      tutorList,
    });
    const mergedState = mergeSchedulerState(existing.conversation.extractedState, extraction.state);
    const activeProposalHolds = await activeProposalHoldsPromise;
    const assistantResult = solveSchedulerTurn({
      index,
      extractedState: mergedState,
      filterOptions,
      tutorList,
      activeProposalHolds,
    });
    const assistantPayload = asRecord({
      ...assistantResult,
      extractedState: extraction.state,
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

    const shouldAutoTitle = existing.conversation.title === "Untitled scheduler chat";
    const conversation = await touchSchedulerConversationAfterMessage(db, conversationId, {
      extractedState: assistantResult.state,
      title: shouldAutoTitle
        ? extraction.title ?? buildConversationTitle(assistantResult.state, parsed.data.content)
        : undefined,
      customerParentName: assistantResult.state.parentName,
      customerStudentName: assistantResult.state.studentName,
      customerContact: assistantResult.state.contact,
    });
    const logId = await logSchedulerRun(db, {
      conversationId,
      messageId: assistantMessage.id,
      createdByEmail: actor.email,
      status: assistantResult.parentReady ? "solved" : "needs_clarification",
      inputPreviewRedacted: redactAiSchedulerInput(parsed.data.content),
      model,
      latencyMs: Date.now() - startedAt,
      parsedPayload: asRecord(extraction),
      solverPayload: assistantPayload,
      warnings: assistantResult.warnings,
    });

    return NextResponse.json({
      conversation,
      messages: [adminMessage, assistantMessage],
      assistantResult,
      logId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI scheduling failed";
    const assistantMessage = await createSchedulerMessage(db, {
      conversationId,
      role: "assistant",
      content: "I could not process that message. Please try again or use the manual search while I recover.",
      structuredPayload: { error: message },
      model,
      latencyMs: Date.now() - startedAt,
      actor: { email: null, name: "AI Scheduler" },
    });
    await touchSchedulerConversationAfterMessage(db, conversationId);
    const logId = await logSchedulerRun(db, {
      conversationId,
      messageId: assistantMessage.id,
      createdByEmail: actor.email,
      status: "failed",
      inputPreviewRedacted: redactAiSchedulerInput(parsed.data.content),
      model,
      latencyMs: Date.now() - startedAt,
      errorMessage: message,
    });
    return NextResponse.json(
      {
        error: "AI scheduling failed",
        detail: message,
        messages: [adminMessage, assistantMessage],
        logId,
      },
      { status: 502 },
    );
  }
}
