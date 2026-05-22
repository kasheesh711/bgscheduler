import type { Database } from "@/lib/db";
import {
  bangkokTodayIso,
} from "@/lib/ai/scheduler";
import {
  extractSchedulerStateWithOpenAi,
  filterOptionsFromIndex,
  mergeSchedulerState,
  solveSchedulerTurn,
  tutorListFromIndex,
  type SchedulerAssistantResult,
  type SchedulerConversationMessageForPrompt,
  type SchedulerExtractedState,
} from "@/lib/ai/scheduler-conversation";
import type { SchedulerLatencyBreakdown } from "@/lib/ai/scheduler-data";
import type { ProposalHoldSummary } from "@/lib/proposals/types";
import { listActiveProposalHolds } from "@/lib/proposals/data";
import { ensureIndex, type SearchIndex } from "@/lib/search/index";

export const AI_SCHEDULER_VERSION = "scheduler-2026-05-22-observability";
export const AI_SCHEDULER_PROMPT_VERSION = "prompt-2026-05-22-state-extraction-v1";

export interface SchedulerExecutionResult {
  index: SearchIndex;
  extraction: Awaited<ReturnType<typeof extractSchedulerStateWithOpenAi>>;
  mergedState: SchedulerExtractedState;
  assistantResult: SchedulerAssistantResult;
  latencyBreakdownMs: SchedulerLatencyBreakdown;
}

export function emptySchedulerLatencyBreakdown(): SchedulerLatencyBreakdown {
  return {
    totalMs: 0,
    dbMs: 0,
    modelMs: 0,
    searchMs: 0,
  };
}

export function schedulerRunMetadata(latencyBreakdownMs: SchedulerLatencyBreakdown) {
  return {
    schedulerVersion: AI_SCHEDULER_VERSION,
    promptVersion: AI_SCHEDULER_PROMPT_VERSION,
    latencyBreakdownMs,
  };
}

export async function executeSchedulerTurn(input: {
  db: Database;
  currentState: SchedulerExtractedState;
  messages: SchedulerConversationMessageForPrompt[];
  sourceText?: string;
  todayBangkok?: string;
  activeProposalHolds?: ProposalHoldSummary[];
}): Promise<SchedulerExecutionResult> {
  const totalStartedAt = Date.now();
  const latency = emptySchedulerLatencyBreakdown();

  const dbStartedAt = Date.now();
  const index = await ensureIndex(input.db);
  const activeProposalHoldsPromise = input.activeProposalHolds
    ? Promise.resolve(input.activeProposalHolds)
    : listActiveProposalHolds(input.db);
  latency.dbMs += Date.now() - dbStartedAt;

  const filterOptions = filterOptionsFromIndex(index);
  const tutorList = tutorListFromIndex(index);

  const modelStartedAt = Date.now();
  const extraction = await extractSchedulerStateWithOpenAi({
    currentState: input.currentState,
    messages: input.messages,
    todayBangkok: input.todayBangkok ?? bangkokTodayIso(),
    filterOptions,
    tutorList,
  });
  latency.modelMs += Date.now() - modelStartedAt;

  const mergedState = mergeSchedulerState(input.currentState, extraction.state);

  const holdsStartedAt = Date.now();
  const activeProposalHolds = await activeProposalHoldsPromise;
  latency.dbMs += Date.now() - holdsStartedAt;

  const searchStartedAt = Date.now();
  const assistantResult = solveSchedulerTurn({
    index,
    extractedState: mergedState,
    sourceText: input.sourceText,
    filterOptions,
    tutorList,
    activeProposalHolds,
  });
  latency.searchMs += Date.now() - searchStartedAt;
  latency.totalMs = Date.now() - totalStartedAt;

  return {
    index,
    extraction,
    mergedState,
    assistantResult: {
      ...assistantResult,
      latencyBreakdownMs: latency,
    },
    latencyBreakdownMs: latency,
  };
}
