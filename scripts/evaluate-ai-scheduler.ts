import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { desc, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
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
import { aiSchedulerModel, aiSchedulerReasoningEffort, bangkokTodayIso } from "@/lib/ai/scheduler";
import { getSchedulerConversationWithMessages } from "@/lib/ai/scheduler-data";
import { listActiveProposalHolds } from "@/lib/proposals/data";
import { ensureIndex } from "@/lib/search/index";

type CaseMessage = SchedulerConversationMessageForPrompt;

interface ExpectedSlot {
  searchMode?: "recurring" | "one_time";
  dayOfWeek?: number;
  date?: string;
  start: string;
  end: string;
}

interface EvalCase {
  id: string;
  label: string;
  messages: CaseMessage[];
  expect: {
    parentReady?: boolean;
    requiresClarification?: boolean;
    requiresAvailabilitySummary?: boolean;
    noSuggestions?: boolean;
    subjects?: string[];
    level?: string;
    mode?: "online" | "onsite" | "either";
    studentName?: string;
    tutorExclusions?: string[];
    forbiddenTutorNames?: string[];
    mustNotAsk?: string[];
    parentDraftIncludes?: string[];
    requiresEvidence?: boolean;
    requiresProfileEvidence?: boolean;
    dateRange?: { startDate: string; endDate: string };
    slots?: ExpectedSlot[];
  };
}

function normalize(value: string | undefined | null): string {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function stateHaystack(result: SchedulerAssistantResult): string {
  return [
    result.state.filters.subject,
    result.state.filters.curriculum,
    result.state.filters.level,
    result.state.subjectIntent?.label,
    ...(result.state.subjectIntent?.canonicalSubjects ?? []),
    ...(result.state.subjectRequests ?? []).flatMap((filters) => [filters.subject, filters.curriculum, filters.level]),
    ...(result.availabilitySummary?.searchedFilters ?? []).flatMap((filters) => [filters.subject, filters.curriculum, filters.level]),
    ...result.suggestions.map((suggestion) => suggestion.subject),
    result.assistantMessage,
    result.parentMessageDraft,
  ].filter(Boolean).join(" ");
}

function questionHaystack(result: SchedulerAssistantResult): string {
  return [
    result.assistantMessage,
    ...result.questions,
    ...result.constraintLedger.map((item) => item.message),
  ].filter(Boolean).join(" ");
}

function suggestionTutorHaystack(result: SchedulerAssistantResult): string {
  return result.suggestions
    .flatMap((suggestion) => suggestion.tutors.map((tutor) => tutor.displayName))
    .join(" ");
}

function suggestionEvidenceHaystack(result: SchedulerAssistantResult): string {
  return result.suggestions.flatMap((suggestion) => [
    ...suggestion.reasons,
    ...suggestion.tutors.flatMap((tutor) => tutor.profileEvidence ?? []),
  ]).join(" ");
}

function slotMatches(actual: { searchMode: string; dayOfWeek?: number; date?: string; start: string; end: string }, expected: ExpectedSlot): boolean {
  if (expected.searchMode && actual.searchMode !== expected.searchMode) return false;
  if (typeof expected.dayOfWeek === "number" && actual.dayOfWeek !== expected.dayOfWeek) return false;
  if (expected.date && actual.date !== expected.date) return false;
  return actual.start === expected.start && actual.end === expected.end;
}

function scoreCase(testCase: EvalCase, result: SchedulerAssistantResult): { score: number; critical: boolean; concerns: string[] } {
  const concerns: string[] = [];
  let score = 10;

  if (typeof testCase.expect.parentReady === "boolean" && result.parentReady !== testCase.expect.parentReady) {
    score -= 3;
    concerns.push(`Expected parentReady=${testCase.expect.parentReady}, got ${result.parentReady}.`);
  }
  if (testCase.expect.requiresClarification && result.questions.length === 0) {
    score -= 2;
    concerns.push("Expected a clarification question.");
  }
  if (testCase.expect.requiresAvailabilitySummary && !result.availabilitySummary) {
    score -= 3;
    concerns.push("Expected an availability summary.");
  }
  if (testCase.expect.noSuggestions && result.suggestions.length > 0) {
    score -= 2;
    concerns.push("Expected no tentative suggestions.");
  }
  if (testCase.expect.dateRange) {
    const actual = result.state.dateRange ?? result.availabilitySummary?.dateRange;
    if (actual?.startDate !== testCase.expect.dateRange.startDate || actual?.endDate !== testCase.expect.dateRange.endDate) {
      score -= 2;
      concerns.push(`Expected date range ${testCase.expect.dateRange.startDate} to ${testCase.expect.dateRange.endDate}.`);
    }
  }
  for (const subject of testCase.expect.subjects ?? []) {
    if (!normalize(stateHaystack(result)).includes(normalize(subject))) {
      score -= 1;
      concerns.push(`Missing subject ${subject}.`);
    }
  }
  if (testCase.expect.level && !normalize(stateHaystack(result)).includes(normalize(testCase.expect.level))) {
    score -= 1;
    concerns.push(`Missing level ${testCase.expect.level}.`);
  }
  if (testCase.expect.mode && result.state.mode !== testCase.expect.mode) {
    score -= 1;
    concerns.push(`Expected mode ${testCase.expect.mode}, got ${result.state.mode}.`);
  }
  if (testCase.expect.studentName && !normalize(result.state.studentName).includes(normalize(testCase.expect.studentName))) {
    score -= 1;
    concerns.push(`Missing student ${testCase.expect.studentName}.`);
  }
  for (const tutorName of testCase.expect.tutorExclusions ?? []) {
    const normalized = normalize(tutorName);
    const hasStateExclusion = result.state.tutorExclusions.some((name) => normalize(name).includes(normalized));
    const wasSuggested = normalize(suggestionTutorHaystack(result)).includes(normalized);
    if (!hasStateExclusion || wasSuggested) {
      score -= 2;
      concerns.push(`Tutor exclusion was not preserved for ${tutorName}.`);
    }
  }
  for (const tutorName of testCase.expect.forbiddenTutorNames ?? []) {
    if (normalize(suggestionTutorHaystack(result)).includes(normalize(tutorName))) {
      score -= 3;
      concerns.push(`Forbidden tutor ${tutorName} was suggested.`);
    }
  }
  for (const staleQuestion of testCase.expect.mustNotAsk ?? []) {
    if (normalize(questionHaystack(result)).includes(normalize(staleQuestion))) {
      score -= 2;
      concerns.push(`Stale/forbidden question remained: ${staleQuestion}.`);
    }
  }
  for (const phrase of testCase.expect.parentDraftIncludes ?? []) {
    if (!normalize(result.parentMessageDraft).includes(normalize(phrase))) {
      score -= 1;
      concerns.push(`Parent draft missing "${phrase}".`);
    }
  }
  if (testCase.expect.requiresEvidence && result.suggestions.length > 0 && !suggestionEvidenceHaystack(result).trim()) {
    score -= 1;
    concerns.push("Suggested tutors did not include ranking evidence.");
  }
  if (testCase.expect.requiresProfileEvidence && !/(?:^|\s)(?:profile|notes):/i.test(suggestionEvidenceHaystack(result))) {
    score -= 1;
    concerns.push("Expected profile or note-derived evidence.");
  }
  for (const expected of testCase.expect.slots ?? []) {
    const matched = result.suggestions.some((suggestion) => slotMatches(suggestion, expected)) ||
      result.state.requestedSlots.some((slot) => {
        const searchMode = slot.searchMode ?? result.state.searchMode;
        if (!searchMode || !slot.startTime || !slot.endTime) return false;
        return slotMatches({
          searchMode,
          dayOfWeek: slot.dayOfWeek,
          date: slot.date,
          start: slot.startTime,
          end: slot.endTime,
        }, expected);
      });
    if (!matched) {
      score -= 2;
      concerns.push(`Missing expected slot ${expected.start}-${expected.end}.`);
    }
  }

  const parentReadyWithLedgerFailure = result.parentReady &&
    result.constraintLedger.some((item) => item.status === "needs_clarification");
  const parentReadyWithForbiddenTutor = Boolean(result.parentReady && (testCase.expect.forbiddenTutorNames ?? [])
    .some((tutorName) => normalize(suggestionTutorHaystack(result)).includes(normalize(tutorName))));
  const critical = parentReadyWithLedgerFailure ||
    parentReadyWithForbiddenTutor ||
    Boolean(result.parentReady && concerns.some((concern) => /Expected date range|Missing expected slot|Forbidden tutor/.test(concern)));
  if (parentReadyWithLedgerFailure) concerns.push("Parent-ready result contained an unresolved constraint ledger item.");
  if (parentReadyWithForbiddenTutor) concerns.push("Parent-ready result included a forbidden tutor.");

  return { score: Math.max(0, score), critical, concerns };
}

async function loadFeedbackCases(db: Database): Promise<EvalCase[]> {
  let rows: Array<typeof schema.aiSchedulerFeedback.$inferSelect>;
  try {
    rows = await db
      .select()
      .from(schema.aiSchedulerFeedback)
      .where(inArray(schema.aiSchedulerFeedback.action, ["edit", "reject"]))
      .orderBy(desc(schema.aiSchedulerFeedback.createdAt))
      .limit(100);
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
    const code = typeof cause === "object" && cause && "code" in cause ? cause.code : undefined;
    if (code === "42P01") {
      console.warn("Skipping AI scheduler feedback eval cases because ai_scheduler_feedback does not exist yet.");
      return [];
    }
    throw error;
  }

  const cases: EvalCase[] = [];
  for (const row of rows) {
    if (!row.conversationId || !row.messageId) continue;
    const conversation = await getSchedulerConversationWithMessages(db, row.conversationId);
    if (!conversation) continue;
    const targetIndex = conversation.messages.findIndex((message) => message.id === row.messageId);
    if (targetIndex <= 0) continue;
    const messages = conversation.messages
      .slice(0, targetIndex)
      .filter((message) => message.role !== "assistant")
      .map((message) => ({ role: message.role, content: message.content }));
    if (messages.length === 0) continue;
    const labelDetail = row.action === "reject"
      ? row.rejectionReason ?? "Rejected scheduler draft"
      : "Edited scheduler draft";
    cases.push({
      id: `feedback-${row.id}`,
      label: `Feedback ${new Date(row.createdAt).toISOString().slice(0, 10)}: ${labelDetail}`.slice(0, 140),
      messages,
      expect: row.action === "reject"
        ? {
            parentReady: false,
            requiresClarification: true,
            noSuggestions: true,
          }
        : {
            parentReady: true,
            parentDraftIncludes: row.editedParentDraft
              ? row.editedParentDraft
                .split(/\s+/)
                .filter((word) => word.length > 3)
                .slice(0, 3)
              : undefined,
          },
    });
  }
  return cases;
}

async function loadCases(db: Database): Promise<EvalCase[]> {
  const file = path.join(process.cwd(), "docs", "ai-scheduler-eval-cases.json");
  const staticCases = JSON.parse(await readFile(file, "utf8")) as EvalCase[];
  const feedbackCases = await loadFeedbackCases(db);
  return [...staticCases, ...feedbackCases];
}

async function runCase(testCase: EvalCase, context: {
  filterOptions: ReturnType<typeof filterOptionsFromIndex>;
  tutorList: ReturnType<typeof tutorListFromIndex>;
  index: Awaited<ReturnType<typeof ensureIndex>>;
  activeProposalHolds: Awaited<ReturnType<typeof listActiveProposalHolds>>;
}): Promise<SchedulerAssistantResult> {
  let currentState: SchedulerExtractedState = {};
  const promptMessages: SchedulerConversationMessageForPrompt[] = [];
  let result: SchedulerAssistantResult | null = null;

  for (const message of testCase.messages) {
    promptMessages.push(message);
    const extraction = await extractSchedulerStateWithOpenAi({
      currentState,
      messages: promptMessages,
      todayBangkok: bangkokTodayIso(),
      filterOptions: context.filterOptions,
      tutorList: context.tutorList,
    });
    currentState = mergeSchedulerState(currentState, extraction.state);
    result = solveSchedulerTurn({
      index: context.index,
      extractedState: currentState,
      sourceText: message.content,
      filterOptions: context.filterOptions,
      tutorList: context.tutorList,
      activeProposalHolds: context.activeProposalHolds,
    });
    currentState = result.state;
    promptMessages.push({ role: "assistant", content: result.assistantMessage });
  }

  if (!result) throw new Error(`Eval case ${testCase.id} has no messages.`);
  return result;
}

async function main() {
  loadEnvConfig(process.cwd());
  const db = getDb();
  const [cases, index, activeProposalHolds] = await Promise.all([
    loadCases(db),
    ensureIndex(db),
    listActiveProposalHolds(db),
  ]);
  const filterOptions = filterOptionsFromIndex(index);
  const tutorList = tutorListFromIndex(index);
  const results = [];

  for (const testCase of cases) {
    const startedAt = Date.now();
    const result = await runCase(testCase, { filterOptions, tutorList, index, activeProposalHolds });
    const latencyMs = Date.now() - startedAt;
    const score = scoreCase(testCase, result);
    results.push({
      id: testCase.id,
      label: testCase.label,
      score: score.score,
      critical: score.critical,
      concerns: score.concerns,
      latencyMs,
      parentReady: result.parentReady,
      assistantMessage: result.assistantMessage,
      questions: result.questions,
      suggestions: result.suggestions.map((suggestion) => ({
        subject: suggestion.subject,
        searchMode: suggestion.searchMode,
        dayOfWeek: suggestion.dayOfWeek,
        date: suggestion.date,
        start: suggestion.start,
        end: suggestion.end,
        tutors: suggestion.tutors.map((tutor) => tutor.displayName),
      })),
      availabilitySummary: result.availabilitySummary,
      constraintLedger: result.constraintLedger,
    });
    console.log(`${testCase.id}: ${score.score}/10${score.critical ? " CRITICAL" : ""}`);
  }

  const totalScore = results.reduce((sum, result) => sum + result.score, 0);
  const maxScore = results.length * 10;
  const criticalCount = results.filter((result) => result.critical).length;
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const latencyAt = (percentile: number) => latencies.length === 0
    ? 0
    : latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * percentile))];
  const payload = {
    generatedAt: new Date().toISOString(),
    model: aiSchedulerModel(),
    reasoningEffort: aiSchedulerReasoningEffort(),
    snapshotId: index.snapshotId,
    profileVersion: index.profileVersion,
    totalScore,
    maxScore,
    criticalCount,
    latencyMs: {
      p50: latencyAt(0.5),
      p95: latencyAt(0.95),
      max: latencies.at(-1) ?? 0,
    },
    results,
  };

  const rawDir = "/tmp/bgscheduler";
  await mkdir(rawDir, { recursive: true });
  const rawPath = path.join(rawDir, "ai-scheduler-eval-latest.json");
  await writeFile(rawPath, `${JSON.stringify(payload, null, 2)}\n`);

  const report = [
    "# AI Scheduler Evaluation",
    "",
    `Generated: ${payload.generatedAt}`,
    `Model: \`${payload.model}\``,
    `Reasoning effort: \`${payload.reasoningEffort}\``,
    `Snapshot: \`${payload.snapshotId}\``,
    `Score: ${totalScore}/${maxScore}`,
    `Critical failures: ${criticalCount}`,
    `Latency: p50 ${payload.latencyMs.p50}ms · p95 ${payload.latencyMs.p95}ms · max ${payload.latencyMs.max}ms`,
    "",
    "| Case | Score | Latency | Parent-ready | Critical | Concerns |",
    "| --- | ---: | ---: | --- | --- | --- |",
    ...results.map((result) => `| ${result.label} | ${result.score}/10 | ${result.latencyMs}ms | ${result.parentReady ? "yes" : "no"} | ${result.critical ? "yes" : "no"} | ${result.concerns.join("; ") || "None"} |`),
    "",
    `Raw JSON: \`${rawPath}\``,
    "",
  ].join("\n");
  await writeFile(path.join(process.cwd(), "docs", "ai-scheduler-eval-latest.md"), report);

  if (criticalCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
