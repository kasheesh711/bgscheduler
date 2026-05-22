import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { getDb } from "@/lib/db";
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
import { aiSchedulerModel, bangkokTodayIso } from "@/lib/ai/scheduler";
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
  const critical = parentReadyWithLedgerFailure ||
    Boolean(result.parentReady && concerns.some((concern) => /Expected date range|Missing expected slot/.test(concern)));
  if (parentReadyWithLedgerFailure) concerns.push("Parent-ready result contained an unresolved constraint ledger item.");

  return { score: Math.max(0, score), critical, concerns };
}

async function loadCases(): Promise<EvalCase[]> {
  const file = path.join(process.cwd(), "docs", "ai-scheduler-eval-cases.json");
  return JSON.parse(await readFile(file, "utf8")) as EvalCase[];
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
    loadCases(),
    ensureIndex(db),
    listActiveProposalHolds(db),
  ]);
  const filterOptions = filterOptionsFromIndex(index);
  const tutorList = tutorListFromIndex(index);
  const results = [];

  for (const testCase of cases) {
    const result = await runCase(testCase, { filterOptions, tutorList, index, activeProposalHolds });
    const score = scoreCase(testCase, result);
    results.push({
      id: testCase.id,
      label: testCase.label,
      score: score.score,
      critical: score.critical,
      concerns: score.concerns,
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
  const payload = {
    generatedAt: new Date().toISOString(),
    model: aiSchedulerModel(),
    snapshotId: index.snapshotId,
    profileVersion: index.profileVersion,
    totalScore,
    maxScore,
    criticalCount,
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
    `Snapshot: \`${payload.snapshotId}\``,
    `Score: ${totalScore}/${maxScore}`,
    `Critical failures: ${criticalCount}`,
    "",
    "| Case | Score | Parent-ready | Critical | Concerns |",
    "| --- | ---: | --- | --- | --- |",
    ...results.map((result) => `| ${result.label} | ${result.score}/10 | ${result.parentReady ? "yes" : "no"} | ${result.critical ? "yes" : "no"} | ${result.concerns.join("; ") || "None"} |`),
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
