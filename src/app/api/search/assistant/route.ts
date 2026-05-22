import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  aiSchedulerModel,
  aiSchedulerRequestSchema,
  isAiSchedulerConfigured,
  redactAiSchedulerInput,
  type AiSchedulerOption,
  type AiSchedulerParsedRequest,
  type AiSchedulerResponse,
  type AiSchedulerSolvedRequest,
} from "@/lib/ai/scheduler";
import {
  type SchedulerAssistantResult,
  type SchedulerResolvedState,
  type SchedulerSuggestion,
} from "@/lib/ai/scheduler-conversation";
import { logSchedulerRun } from "@/lib/ai/scheduler-data";
import { executeSchedulerTurn, schedulerRunMetadata } from "@/lib/ai/scheduler-service";

type AiSchedulerResponseWithoutLog =
  | Omit<Extract<AiSchedulerResponse, { status: "needs_clarification" }>, "logId">
  | Omit<Extract<AiSchedulerResponse, { status: "solved" }>, "logId">
  | Omit<Extract<AiSchedulerResponse, { status: "availability_summary" }>, "logId">;

function asRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function parsedPartialFromState(state: SchedulerResolvedState): Partial<AiSchedulerParsedRequest> {
  const firstSlot = state.requestedSlots[0];
  return {
    searchMode: firstSlot?.searchMode ?? state.searchMode,
    dayOfWeek: firstSlot?.dayOfWeek ?? state.dayOfWeek,
    date: firstSlot?.date ?? state.date,
    startTime: firstSlot?.startTime ?? state.startTime,
    endTime: firstSlot?.endTime ?? state.endTime,
    durationMinutes: firstSlot?.durationMinutes ?? state.durationMinutes,
    mode: state.mode,
    filters: state.filters,
    tutorNames: state.tutorNames,
    assumptions: state.assumptions,
    parentRequestSummary: state.parentRequestSummary,
  };
}

function optionFromSuggestion(suggestion: SchedulerSuggestion): AiSchedulerOption {
  return {
    id: suggestion.id,
    rank: suggestion.rank,
    start: suggestion.start,
    end: suggestion.end,
    confidence: suggestion.confidence,
    reasons: suggestion.reasons,
    tutors: suggestion.tutors.slice(0, 3).map((tutor) => ({
      tutorGroupId: tutor.tutorGroupId,
      displayName: tutor.displayName,
      supportedModes: tutor.supportedModes,
    })),
  };
}

function solvedRequestFromResult(result: SchedulerAssistantResult): AiSchedulerSolvedRequest {
  const state = result.state;
  const firstSlot = state.requestedSlots[0];
  const firstSuggestion = result.suggestions[0];
  const searchMode = firstSlot?.searchMode ?? firstSuggestion?.searchMode ?? state.searchMode;
  return {
    searchMode,
    dayOfWeek: searchMode === "recurring"
      ? firstSlot?.dayOfWeek ?? firstSuggestion?.dayOfWeek ?? state.dayOfWeek
      : undefined,
    date: searchMode === "one_time"
      ? firstSlot?.date ?? firstSuggestion?.date ?? state.date
      : undefined,
    startTime: firstSlot?.startTime ?? firstSuggestion?.start ?? state.startTime ?? "00:00",
    endTime: firstSlot?.endTime ?? firstSuggestion?.end ?? state.endTime ?? "00:00",
    durationMinutes: firstSlot?.durationMinutes ?? firstSuggestion?.durationMinutes ?? state.durationMinutes,
    mode: state.mode,
    filters: state.filters,
    tutorNames: state.tutorNames,
    assumptions: state.assumptions,
    parentRequestSummary: state.parentRequestSummary,
    tutorGroupIds: [],
    matchedTutors: [],
  };
}

function shouldReturnAvailabilitySummary(result: SchedulerAssistantResult): result is SchedulerAssistantResult & {
  availabilitySummary: NonNullable<SchedulerAssistantResult["availabilitySummary"]>;
} {
  return Boolean(
    result.parentReady &&
    result.availabilitySummary &&
    (result.state.subjectIntent || result.state.filters.subject),
  );
}

function responseFromSchedulerResult(result: SchedulerAssistantResult): AiSchedulerResponseWithoutLog {
  if (shouldReturnAvailabilitySummary(result)) {
    return {
      status: "availability_summary",
      state: result.state,
      availabilitySummary: result.availabilitySummary,
      assistantMessage: result.assistantMessage,
      parentMessageDraft: result.parentMessageDraft,
      snapshotMeta: result.snapshotMeta,
      warnings: result.warnings,
    };
  }

  if (!result.parentReady) {
    return {
      status: "needs_clarification",
      partial: parsedPartialFromState(result.state),
      clarifyingQuestions: result.questions.length > 0
        ? result.questions
        : ["Please clarify the scheduling details before sending this to a parent."],
      warnings: result.warnings,
    };
  }

  return {
    status: "solved",
    parsedRequest: solvedRequestFromResult(result),
    options: result.suggestions.map(optionFromSuggestion),
    parentMessageDraft: result.parentMessageDraft,
    snapshotMeta: result.snapshotMeta,
    warnings: result.warnings,
  };
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedBody = aiSchedulerRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  if (!isAiSchedulerConfigured()) {
    return NextResponse.json(
      { error: "AI scheduler is not configured" },
      { status: 503 },
    );
  }

  const db = getDb();
  const startedAt = Date.now();
  const inputPreviewRedacted = redactAiSchedulerInput(parsedBody.data.input);
  const model = aiSchedulerModel();

  try {
    const execution = await executeSchedulerTurn({
      db,
      currentState: {},
      messages: [{ role: "admin", content: parsedBody.data.input }],
      sourceText: parsedBody.data.input,
    });
    const responseBody = responseFromSchedulerResult(execution.assistantResult);
    const logId = await logSchedulerRun(db, {
      createdByEmail: session.user?.email,
      status: execution.assistantResult.parentReady ? "solved" : "needs_clarification",
      inputPreviewRedacted,
      model,
      latencyMs: Date.now() - startedAt,
      ...schedulerRunMetadata(execution.latencyBreakdownMs),
      parsedPayload: asRecord(execution.extraction),
      solverPayload: asRecord(execution.assistantResult),
      warnings: execution.assistantResult.warnings,
    });

    return NextResponse.json({ ...responseBody, logId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI scheduling failed";
    const logId = await logSchedulerRun(db, {
      createdByEmail: session.user?.email,
      status: "failed",
      inputPreviewRedacted,
      model,
      latencyMs: Date.now() - startedAt,
      ...schedulerRunMetadata({
        totalMs: Date.now() - startedAt,
        dbMs: 0,
        modelMs: 0,
        searchMs: 0,
      }),
      warnings: [],
      errorMessage: message,
    });
    return NextResponse.json(
      { error: "AI scheduling failed", detail: message, logId },
      { status: 502 },
    );
  }
}
