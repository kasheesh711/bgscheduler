import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { getDb } from "@/lib/db";
import {
  aiSchedulerModel,
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
  type SchedulerRequestedSlot,
  type SchedulerSuggestion,
} from "@/lib/ai/scheduler-conversation";
import { ensureIndex } from "@/lib/search/index";
import { listActiveProposalHolds } from "@/lib/proposals/data";

type SchedulerRunRow = typeof schema.aiSchedulerRuns.$inferSelect;
type SchedulerMessageRow = typeof schema.aiSchedulerMessages.$inferSelect;

type Verdict = "accurate" | "mixed" | "bad" | "critical";
type EvaluationView = "production" | "replay";

interface ExpectedSlot {
  searchMode?: "recurring" | "one_time";
  dayOfWeek?: number;
  date?: string;
  start: string;
  end: string;
  exact?: boolean;
}

interface ExpectedDateRange {
  startDate: string;
  endDate: string;
}

interface CaseDefinition {
  idPrefix: string;
  admin: string;
  label: string;
  expectedSubjects?: string[];
  expectedSubjectFamily?: string;
  expectedSearchedSubjects?: string[];
  expectedLevel?: string;
  expectedStudent?: string;
  expectedMode?: "online" | "onsite" | "either";
  expectedDurationMinutes?: number;
  expectedSlots?: ExpectedSlot[];
  expectedDateRange?: ExpectedDateRange;
  expectedClarification?: boolean;
  requireNoSuggestions?: boolean;
  requiresAvailabilitySummary?: boolean;
  requiresParentReady?: boolean;
  multiSubjectRequest?: boolean;
  staleQuestionPatterns?: RegExp[];
  notes: string;
}

interface ScoreBreakdown {
  extraction: number;
  constraints: number;
  qualificationTutorProfile: number;
  safety: number;
  usefulness: number;
}

interface EvaluatedRun {
  view: EvaluationView;
  runId: string;
  conversationId: string | null;
  admin: string;
  label: string;
  input: string;
  score: number;
  verdict: Verdict;
  status: "parent_ready" | "needs_clarification";
  assistantMessage: string;
  parentMessageDraft: string;
  questions: string[];
  warnings: string[];
  suggestions: Array<{
    subject?: string;
    day: string;
    start: string;
    end: string;
    tutors: string[];
    requestedSlotId?: string;
  }>;
  availabilitySummary?: SchedulerAssistantResult["availabilitySummary"];
  state: SchedulerAssistantResult["state"];
  scoreBreakdown: ScoreBreakdown;
  notes: string[];
  concerns: string[];
}

const REPORT_DATE = "2026-05-21";
const BANGKOK_DAY_START_UTC = new Date("2026-05-20T17:00:00.000Z");
const BANGKOK_DAY_END_UTC = new Date("2026-05-21T17:00:00.000Z");
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const CASES: CaseDefinition[] = [
  {
    idPrefix: "22ae7e92",
    admin: "Care KT",
    label: "Writing Y6, first week of July",
    expectedSubjectFamily: "English-family",
    expectedSearchedSubjects: ["EFL", "ESL", "Literature"],
    expectedLevel: "Y2-8",
    expectedDurationMinutes: 60,
    expectedDateRange: { startDate: "2026-07-01", endDate: "2026-07-07" },
    requiresAvailabilitySummary: true,
    requiresParentReady: true,
    notes: "First week of July should be interpreted as July 1-7 and answered with a broad proven availability summary, not only a day/time clarification.",
  },
  {
    idPrefix: "1d7e8733",
    admin: "Care KT",
    label: "Writing Y6, Mon-Sun 10:00-18:00 in July",
    expectedSubjectFamily: "English-family",
    expectedSearchedSubjects: ["EFL", "ESL", "Literature"],
    expectedLevel: "Y2-8",
    expectedMode: "either",
    expectedSlots: [
      { searchMode: "recurring", dayOfWeek: 1, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 2, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 3, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 4, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 5, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 6, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 0, start: "10:00", end: "18:00" },
    ],
    expectedDurationMinutes: 60,
    staleQuestionPatterns: [
      /which day\/time in the first week of july/i,
      /what day and time in the first week of july/i,
      /which weekday or exact date should i search for that time/i,
    ],
    notes: "After Mon-Sun and a time range are supplied, the stale first-week day/time question should be cleared.",
  },
  {
    idPrefix: "64b87983",
    admin: "Care KT",
    label: "Writing Y6, Mon-Sun 10:00-18:00 in July, 90 minutes",
    expectedSubjectFamily: "English-family",
    expectedSearchedSubjects: ["EFL", "ESL", "Literature"],
    expectedLevel: "Y2-8",
    expectedMode: "either",
    expectedDurationMinutes: 90,
    expectedSlots: [
      { searchMode: "recurring", dayOfWeek: 1, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 2, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 3, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 4, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 5, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 6, start: "10:00", end: "18:00" },
      { searchMode: "recurring", dayOfWeek: 0, start: "10:00", end: "18:00" },
    ],
    staleQuestionPatterns: [
      /which day\/time in the first week of july/i,
      /what day and time in the first week of july/i,
      /which weekday or exact date should i search for that time/i,
    ],
    notes: "Once duration is known, the system should search or safely explain no match, not repeat the stale question.",
  },
  {
    idPrefix: "07f84f99",
    admin: "Panida",
    label: "Ellen Emma onsite Math/English/Science, 30 May-3 June 09:00-12:00",
    expectedSubjects: ["Math", "English", "Science"],
    expectedStudent: "Ellen Emma",
    expectedMode: "onsite",
    expectedSlots: [
      { searchMode: "one_time", date: "2026-05-30", start: "09:00", end: "12:00" },
      { searchMode: "one_time", date: "2026-05-31", start: "09:00", end: "12:00" },
      { searchMode: "one_time", date: "2026-06-01", start: "09:00", end: "12:00" },
      { searchMode: "one_time", date: "2026-06-02", start: "09:00", end: "12:00" },
      { searchMode: "one_time", date: "2026-06-03", start: "09:00", end: "12:00" },
    ],
    multiSubjectRequest: true,
    staleQuestionPatterns: [/which weekday or exact date should i search for that time/i],
    notes: "The request asks for Math, English, and Science; Math-only parent-ready output is unsafe.",
  },
  {
    idPrefix: "e760661c",
    admin: "Panida",
    label: "Ellen Emma explicit date list Math/English/Science, 09:00-12:00",
    expectedSubjects: ["Math", "English", "Science"],
    expectedStudent: "Ellen Emma",
    expectedMode: "onsite",
    expectedSlots: [
      { searchMode: "one_time", date: "2026-05-30", start: "09:00", end: "12:00" },
      { searchMode: "one_time", date: "2026-05-31", start: "09:00", end: "12:00" },
      { searchMode: "one_time", date: "2026-06-01", start: "09:00", end: "12:00" },
      { searchMode: "one_time", date: "2026-06-02", start: "09:00", end: "12:00" },
      { searchMode: "one_time", date: "2026-06-03", start: "09:00", end: "12:00" },
    ],
    multiSubjectRequest: true,
    staleQuestionPatterns: [/which weekday or exact date should i search for that time/i],
    notes: "The system should preserve all explicit dates and run subject-specific searches instead of treating English/Science as unmapped or suggesting Math-only options.",
  },
  {
    idPrefix: "def92a2f",
    admin: "Natchasmith",
    label: "Maze 11+/13+ English 13:00-14:00, no day",
    expectedSubjects: ["EnglishVR"],
    expectedLevel: "11+/13+",
    expectedStudent: "maze",
    expectedClarification: true,
    requireNoSuggestions: true,
    notes: "Missing weekday/date should block broad search and ask for the day/date.",
  },
  {
    idPrefix: "12bfcf0e",
    admin: "Kevin",
    label: "Maze follow-up: Saturday",
    expectedSubjects: ["EnglishVR"],
    expectedLevel: "11+/13+",
    expectedStudent: "maze",
    expectedMode: "either",
    expectedSlots: [{ searchMode: "recurring", dayOfWeek: 6, start: "13:00", end: "14:00", exact: true }],
    expectedDurationMinutes: 60,
    requiresParentReady: true,
    staleQuestionPatterns: [/which weekday or exact date should i search for that time/i],
    notes: "Saturday supplies the missing day; the prior clarification question should be cleared.",
  },
];

function normalize(value: string | undefined | null): string {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function includesNormalized(value: string | undefined | null, needle: string): boolean {
  return normalize(value).includes(normalize(needle));
}

function stateHaystack(result: SchedulerAssistantResult): string {
  return [
    result.state.filters.subject,
    result.state.filters.curriculum,
    result.state.filters.level,
    result.state.subjectIntent?.label,
    result.state.subjectIntent?.family,
    ...(result.state.subjectIntent?.canonicalSubjects ?? []),
    result.availabilitySummary?.subjectIntent?.label,
    result.availabilitySummary?.subjectIntent?.family,
    ...(result.availabilitySummary?.subjectIntent?.canonicalSubjects ?? []),
    ...(result.state.subjectRequests ?? []).flatMap((filters) => [filters.subject, filters.curriculum, filters.level]),
    result.availabilitySummary?.filters.subject,
    result.availabilitySummary?.filters.curriculum,
    result.availabilitySummary?.filters.level,
    ...(result.availabilitySummary?.searchedFilters ?? []).flatMap((filters) => [filters.subject, filters.curriculum, filters.level]),
    ...(result.availabilitySummary?.tutors ?? []).flatMap((tutor) => [tutor.displayName, ...tutor.matchedSubjects]),
    ...result.suggestions.map((suggestion) => suggestion.subject),
    result.state.studentName,
    result.state.parentRequestSummary,
    result.assistantMessage,
    result.parentMessageDraft,
    ...(result.state.explicitUnknownFilters ?? []),
    ...(result.state.assumptions ?? []),
  ].filter(Boolean).join(" ");
}

function dayLabel(suggestion: Pick<SchedulerSuggestion, "searchMode" | "date" | "dayOfWeek">): string {
  if (suggestion.searchMode === "one_time" && suggestion.date) return suggestion.date;
  if (typeof suggestion.dayOfWeek === "number") return DAY_NAMES[suggestion.dayOfWeek] ?? `day ${suggestion.dayOfWeek}`;
  return "unknown";
}

function slotWithin(actual: { start: string; end: string }, expected: ExpectedSlot): boolean {
  if (expected.exact) return actual.start === expected.start && actual.end === expected.end;
  return actual.start >= expected.start && actual.end <= expected.end;
}

function suggestionMatchesSlot(suggestion: SchedulerSuggestion, expected: ExpectedSlot): boolean {
  if (expected.searchMode && suggestion.searchMode !== expected.searchMode) return false;
  if (typeof expected.dayOfWeek === "number" && suggestion.dayOfWeek !== expected.dayOfWeek) return false;
  if (expected.date && suggestion.date !== expected.date) return false;
  return slotWithin(suggestion, expected);
}

function requestedSlotMatchesSlot(slot: SchedulerRequestedSlot, expected: ExpectedSlot): boolean {
  if (expected.searchMode && slot.searchMode !== expected.searchMode) return false;
  if (typeof expected.dayOfWeek === "number" && slot.dayOfWeek !== expected.dayOfWeek) return false;
  if (expected.date && slot.date !== expected.date) return false;
  if (!slot.startTime || !slot.endTime) return false;
  return slotWithin({ start: slot.startTime, end: slot.endTime }, expected);
}

function countMatchedSlots(result: SchedulerAssistantResult, expectedSlots: ExpectedSlot[]): number {
  return expectedSlots.filter((expected) => (
    result.state.requestedSlots.some((slot) => requestedSlotMatchesSlot(slot, expected)) ||
    result.suggestions.some((suggestion) => suggestionMatchesSlot(suggestion, expected))
  )).length;
}

function allSuggestionsWithinExpectedSlots(result: SchedulerAssistantResult, expectedSlots: ExpectedSlot[]): boolean {
  if (expectedSlots.length === 0 || result.suggestions.length === 0) return true;
  return result.suggestions.every((suggestion) => expectedSlots.some((expected) => suggestionMatchesSlot(suggestion, expected)));
}

function dateRangeMatches(result: SchedulerAssistantResult, expected: ExpectedDateRange): boolean {
  const ranges = [
    result.state.dateRange,
    result.availabilitySummary?.dateRange,
  ].filter(Boolean);
  return ranges.some((range) => range?.startDate === expected.startDate && range?.endDate === expected.endDate);
}

function hasStaleQuestion(caseDef: CaseDefinition, result: SchedulerAssistantResult): boolean {
  const text = `${result.assistantMessage} ${result.questions.join(" ")}`;
  return (caseDef.staleQuestionPatterns ?? []).some((pattern) => pattern.test(text));
}

function verdictFor(score: number, critical: boolean): Verdict {
  if (critical) return "critical";
  if (score >= 8) return "accurate";
  if (score >= 5) return "mixed";
  return "bad";
}

function subjectRepresentationCount(caseDef: CaseDefinition, result: SchedulerAssistantResult): number {
  const haystack = stateHaystack(result);
  return (caseDef.expectedSubjects ?? []).filter((subject) => includesNormalized(haystack, subject)).length;
}

function searchedSubjectCount(caseDef: CaseDefinition, result: SchedulerAssistantResult): number {
  const haystack = stateHaystack(result);
  return (caseDef.expectedSearchedSubjects ?? []).filter((subject) => includesNormalized(haystack, subject)).length;
}

function scoreResult(caseDef: CaseDefinition, result: SchedulerAssistantResult): {
  score: number;
  verdict: Verdict;
  breakdown: ScoreBreakdown;
  notes: string[];
  concerns: string[];
} {
  const notes: string[] = [];
  const concerns: string[] = [];
  const expectedSlots = caseDef.expectedSlots ?? [];
  const staleQuestion = hasStaleQuestion(caseDef, result);

  let extraction = 2;
  const extractionMisses: string[] = [];
  const representedSubjects = subjectRepresentationCount(caseDef, result);
  if (caseDef.expectedSubjects?.length) {
    if (representedSubjects === 0) extractionMisses.push(`subject ${caseDef.expectedSubjects.join("/")}`);
    else if (representedSubjects < caseDef.expectedSubjects.length) extraction = Math.min(extraction, 1);
  }
  if (caseDef.expectedSubjectFamily && !includesNormalized(stateHaystack(result), caseDef.expectedSubjectFamily)) {
    extractionMisses.push(`subject family ${caseDef.expectedSubjectFamily}`);
  }
  if (caseDef.expectedSearchedSubjects?.length) {
    const searchedCount = searchedSubjectCount(caseDef, result);
    if (searchedCount === 0) {
      extractionMisses.push(`searched subjects ${caseDef.expectedSearchedSubjects.join("/")}`);
    } else if (searchedCount < caseDef.expectedSearchedSubjects.length) {
      extraction = Math.min(extraction, 1);
      concerns.push(`Only ${searchedCount}/${caseDef.expectedSearchedSubjects.length} expected English-family subject(s) were represented.`);
    }
  }
  if (caseDef.expectedLevel && !includesNormalized(result.state.filters.level, caseDef.expectedLevel)) {
    extractionMisses.push(`level ${caseDef.expectedLevel}`);
  }
  if (caseDef.expectedStudent && !includesNormalized(result.state.studentName, caseDef.expectedStudent)) {
    extractionMisses.push(`student ${caseDef.expectedStudent}`);
  }
  if (caseDef.expectedMode && result.state.mode !== caseDef.expectedMode) {
    extractionMisses.push(`mode ${caseDef.expectedMode}`);
  }
  if (caseDef.expectedDurationMinutes && result.state.durationMinutes !== caseDef.expectedDurationMinutes) {
    extractionMisses.push(`duration ${caseDef.expectedDurationMinutes}`);
  }
  if (extractionMisses.length >= 3) extraction = 0;
  else if (extractionMisses.length > 0) extraction = Math.min(extraction, 1);
  if (extractionMisses.length > 0) concerns.push(`Missing/wrong extraction: ${extractionMisses.join(", ")}.`);
  if (caseDef.expectedSubjects && representedSubjects > 0 && representedSubjects < caseDef.expectedSubjects.length) {
    concerns.push(`Only ${representedSubjects}/${caseDef.expectedSubjects.length} requested subject(s) were represented.`);
  }

  let constraints = 2;
  const matchedSlotCount = countMatchedSlots(result, expectedSlots);
  const suggestionsWithinSlots = allSuggestionsWithinExpectedSlots(result, expectedSlots);
  if (caseDef.expectedDateRange) {
    if (dateRangeMatches(result, caseDef.expectedDateRange)) {
      notes.push("Expected date range was preserved.");
    } else {
      constraints = 0;
      concerns.push(`Expected date range ${caseDef.expectedDateRange.startDate} to ${caseDef.expectedDateRange.endDate} was not preserved.`);
    }
  }
  if (expectedSlots.length > 0) {
    if (matchedSlotCount === expectedSlots.length && suggestionsWithinSlots) {
      notes.push("Explicit date/day/time constraints were preserved.");
    } else if (matchedSlotCount > 0 && suggestionsWithinSlots) {
      constraints = 1;
      concerns.push(`Only ${matchedSlotCount}/${expectedSlots.length} expected slot(s) were preserved.`);
    } else {
      constraints = 0;
      concerns.push("Explicit date/day/time constraints were not preserved.");
    }
    if (!suggestionsWithinSlots) {
      concerns.push("One or more suggestions fell outside the requested slot(s).");
    }
  }
  if (caseDef.requireNoSuggestions && result.suggestions.length > 0) {
    constraints = Math.min(constraints, 1);
    concerns.push("Clarification case returned tentative suggestions.");
  }

  let qualificationTutorProfile = 2;
  if (caseDef.requiresAvailabilitySummary) {
    if (!result.availabilitySummary) {
      qualificationTutorProfile = 0;
      concerns.push("Required broad availability summary was not returned.");
    } else if (result.availabilitySummary.tutors.length === 0) {
      qualificationTutorProfile = Math.min(qualificationTutorProfile, 1);
      concerns.push("Broad availability summary was returned, but it found no proven available tutors in the active Wise data.");
    }
  }
  if (caseDef.expectedSubjectFamily && !includesNormalized(stateHaystack(result), caseDef.expectedSubjectFamily)) {
    qualificationTutorProfile = 0;
    concerns.push(`Expected ${caseDef.expectedSubjectFamily} subject-family search was not represented.`);
  }
  if (caseDef.multiSubjectRequest) {
    const representedCount = subjectRepresentationCount(caseDef, result);
    const subject = result.state.filters.subject ?? "";
    const unknowns = result.state.explicitUnknownFilters ?? [];
    const hasOnlyMathFilter = representedCount < (caseDef.expectedSubjects?.length ?? 0) &&
      includesNormalized(subject, "Math") &&
      !includesNormalized(stateHaystack(result), "Science");
    if (result.parentReady && hasOnlyMathFilter) {
      qualificationTutorProfile = 0;
      concerns.push("Multi-subject request was collapsed to Math-only parent-ready output.");
    } else if (representedCount < (caseDef.expectedSubjects?.length ?? 0)) {
      qualificationTutorProfile = Math.min(qualificationTutorProfile, 1);
      concerns.push(`Multi-subject request represented only ${representedCount}/${caseDef.expectedSubjects?.length ?? 0} requested subjects.`);
    } else if (unknowns.some((value) => /English|Science/i.test(value))) {
      qualificationTutorProfile = Math.min(qualificationTutorProfile, 1);
      concerns.push("English/Science remained in explicit unknown filters instead of being handled as subject-specific searches.");
    }
  }

  let safety = 2;
  const violatesExplicitConstraint = expectedSlots.length > 0 && !suggestionsWithinSlots && result.suggestions.length > 0;
  if (caseDef.expectedClarification) {
    if (result.parentReady) {
      safety = 0;
      concerns.push("Marked parent-ready when clarification was expected.");
    } else if (caseDef.requireNoSuggestions && result.suggestions.length > 0) {
      safety = 1;
    }
  }
  if (caseDef.requiresParentReady && !result.parentReady) {
    safety = Math.min(safety, 1);
    concerns.push("Stayed in clarification mode after all required constraints were supplied.");
  }
  if (caseDef.requiresAvailabilitySummary && !result.availabilitySummary) {
    safety = result.parentReady ? 0 : Math.min(safety, 1);
  }
  if (caseDef.multiSubjectRequest && result.parentReady && qualificationTutorProfile === 0) {
    safety = 0;
  }
  if (violatesExplicitConstraint) {
    safety = result.parentReady ? 0 : Math.min(safety, 1);
  }
  if (staleQuestion) {
    safety = Math.min(safety, 1);
    concerns.push("Stale clarification question remained after the missing information was supplied.");
  }

  let usefulness = 2;
  if (staleQuestion) {
    usefulness = 0;
  } else if (caseDef.requiresAvailabilitySummary) {
    if (!result.availabilitySummary) usefulness = 0;
    else if (result.availabilitySummary.tutors.length === 0) usefulness = Math.min(usefulness, 1);
  } else if (caseDef.multiSubjectRequest) {
    usefulness = qualificationTutorProfile === 0 ? 0 : qualificationTutorProfile === 1 ? 1 : 2;
  } else if (caseDef.expectedClarification || caseDef.requireNoSuggestions) {
    if (result.questions.length === 0) usefulness = 0;
    else if (result.suggestions.length > 0) usefulness = 1;
  } else if (caseDef.requiresParentReady && !result.parentReady) {
    usefulness = result.suggestions.length > 0 ? 1 : 0;
  }

  const critical = Boolean(
    (result.parentReady && qualificationTutorProfile === 0) ||
    (result.parentReady && violatesExplicitConstraint) ||
    (result.parentReady && caseDef.requiresAvailabilitySummary && !result.availabilitySummary)
  );
  const breakdown = {
    extraction,
    constraints,
    qualificationTutorProfile,
    safety,
    usefulness,
  };
  const score = extraction + constraints + qualificationTutorProfile + safety + usefulness;
  notes.push(caseDef.notes);
  notes.push(`Rubric components: extraction ${extraction}/2, constraints ${constraints}/2, qualification/tutor/profile ${qualificationTutorProfile}/2, safety ${safety}/2, usefulness ${usefulness}/2.`);
  return { score, verdict: verdictFor(score, critical), breakdown, notes, concerns };
}

function adminMessageForRun(
  run: SchedulerRunRow,
  messagesByConversation: Map<string, SchedulerMessageRow[]>,
): string {
  if (!run.conversationId || !run.messageId) return run.inputPreviewRedacted;
  const messages = messagesByConversation.get(run.conversationId) ?? [];
  const assistant = messages.find((message) => message.id === run.messageId);
  if (!assistant) return run.inputPreviewRedacted;
  const admin = [...messages]
    .filter((message) => message.role === "admin" && message.createdAt <= assistant.createdAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return admin?.content ?? run.inputPreviewRedacted;
}

function resultFromProductionRun(run: SchedulerRunRow): SchedulerAssistantResult {
  const solver = (run.solverPayload ?? {}) as Partial<SchedulerAssistantResult> & {
    extractedState?: SchedulerExtractedState;
  };
  const parsed = (run.parsedPayload ?? {}) as { state?: SchedulerExtractedState };
  const state = solver.state ?? parsed.state ?? {};
  return {
    state: state as SchedulerAssistantResult["state"],
    suggestions: solver.suggestions ?? [],
    parentMessageDraft: solver.parentMessageDraft ?? "",
    assistantMessage: solver.assistantMessage ?? "",
    snapshotMeta: solver.snapshotMeta ?? {
      snapshotId: "",
      syncedAt: "",
      stale: false,
    },
    warnings: [...(run.warnings ?? []), ...(solver.warnings ?? [])],
    questions: solver.questions ?? [],
    parentReady: solver.parentReady ?? run.status === "solved",
    availabilitySummary: solver.availabilitySummary,
  };
}

function evaluatedRunFromResult(input: {
  view: EvaluationView;
  run: SchedulerRunRow;
  caseDef: CaseDefinition;
  adminInput: string;
  result: SchedulerAssistantResult;
}): EvaluatedRun {
  const score = scoreResult(input.caseDef, input.result);
  return {
    view: input.view,
    runId: input.run.id,
    conversationId: input.run.conversationId ?? null,
    admin: input.caseDef.admin,
    label: input.caseDef.label,
    input: input.adminInput,
    score: score.score,
    verdict: score.verdict,
    status: input.result.parentReady ? "parent_ready" : "needs_clarification",
    assistantMessage: input.result.assistantMessage,
    parentMessageDraft: input.result.parentMessageDraft,
    questions: input.result.questions,
    warnings: input.result.warnings,
    suggestions: input.result.suggestions.map((suggestion) => ({
      subject: suggestion.subject,
      day: dayLabel(suggestion),
      start: suggestion.start,
      end: suggestion.end,
      tutors: suggestion.tutors.map((tutor) => tutor.displayName),
      requestedSlotId: suggestion.requestedSlotId,
    })),
    availabilitySummary: input.result.availabilitySummary,
    state: input.result.state,
    scoreBreakdown: score.breakdown,
    notes: score.notes,
    concerns: score.concerns,
  };
}

function formatSuggestions(result: EvaluatedRun): string {
  if (result.suggestions.length === 0) return "None";
  return result.suggestions
    .map((suggestion) => `${suggestion.subject ? `${suggestion.subject}: ` : ""}${suggestion.day} ${suggestion.start}-${suggestion.end}${suggestion.tutors.length ? ` (${suggestion.tutors.join(", ")})` : ""}`)
    .join("; ");
}

function formatAvailabilitySummary(result: EvaluatedRun): string {
  const summary = result.availabilitySummary;
  if (!summary) return "None";
  const tutors = summary.tutors.slice(0, 8).map((tutor) => `${tutor.displayName} (${tutor.windows.length} windows)`);
  const more = summary.tutors.length > 8 ? `; +${summary.tutors.length - 8} tutors` : "";
  const searched = summary.searchedFilters
    .map((filters) => [filters.subject, filters.level, filters.curriculum].filter(Boolean).join(" "))
    .join(", ");
  return `${summary.dateRange.startDate} to ${summary.dateRange.endDate}; searched ${searched}; ${summary.tutors.length} tutor(s): ${tutors.join("; ")}${more}`;
}

function markdownTable(rows: string[][]): string[] {
  return rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, "/")).join(" | ")} |`);
}

function aggregateConcerns(results: EvaluatedRun[]): string[] {
  const seen = new Set<string>();
  const concerns: string[] = [];
  for (const result of results) {
    for (const concern of result.concerns) {
      const key = normalize(concern);
      if (seen.has(key)) continue;
      seen.add(key);
      concerns.push(concern);
    }
  }
  return concerns;
}

function concernBullets(results: EvaluatedRun[]): string[] {
  const concerns = aggregateConcerns(results);
  return concerns.length ? concerns.map((concern) => `- ${concern}`) : ["- None."];
}

function totals(results: EvaluatedRun[]): {
  score: number;
  max: number;
  accurate: number;
  mixed: number;
  bad: number;
  critical: number;
} {
  return {
    score: results.reduce((sum, result) => sum + result.score, 0),
    max: results.length * 10,
    accurate: results.filter((result) => result.verdict === "accurate").length,
    mixed: results.filter((result) => result.verdict === "mixed").length,
    bad: results.filter((result) => result.verdict === "bad").length,
    critical: results.filter((result) => result.verdict === "critical").length,
  };
}

function formatUtcSecond(value: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace(".000Z", " UTC").replace(/\.\d{3}Z$/, " UTC");
}

function buildProductionAudit(input: {
  results: EvaluatedRun[];
  profileCount: number;
  profileMaxUpdatedAt: string | null;
}): string {
  const total = totals(input.results);
  const tableRows = input.results.map((result) => [
    `\`${result.runId.slice(0, 8)}\``,
    result.admin,
    result.label,
    result.status === "parent_ready" ? "parent-ready" : "clarify",
    `${result.score}/10`,
    result.verdict,
    result.concerns.length ? result.concerns.join("; ") : "None",
  ]);
  const details = input.results.map((result) => [
    `### ${result.runId.slice(0, 8)} - ${result.label}`,
    "",
    `- Admin: ${result.admin}.`,
    `- Input: ${result.input.replace(/\n/g, " ")}`,
    `- Score: ${result.score}/10 (${result.verdict}); status: ${result.status}.`,
    `- Assistant: ${result.assistantMessage || "(empty)"}`,
    `- Availability summary: ${formatAvailabilitySummary(result)}.`,
    `- Suggestions: ${formatSuggestions(result)}.`,
    `- Questions: ${result.questions.length ? result.questions.join(" / ") : "None"}.`,
    `- Notes: ${result.notes.join(" ")}`,
    result.concerns.length ? `- Concerns: ${result.concerns.join(" ")}` : "- Concerns: None.",
  ].join("\n"));

  return [
    `# AI Scheduler Accuracy Audit - ${REPORT_DATE}`,
    "",
    "## Summary",
    "",
    `This audit scored the 7 production AI scheduler runs logged on ${REPORT_DATE} in Asia/Bangkok (UTC range ${BANGKOK_DAY_START_UTC.toISOString()} to ${BANGKOK_DAY_END_UTC.toISOString()}). It evaluates what admins actually saw in production, without changing production rows.`,
    "",
    `Production total score: ${total.score}/${total.max}. Verdict mix: ${total.accurate} accurate, ${total.mixed} mixed, ${total.bad} bad, ${total.critical} critical.`,
    "",
    `Tutor profile seed state at evaluation time: ${input.profileCount} active profiles, latest update ${formatUtcSecond(input.profileMaxUpdatedAt)}.`,
    "",
    "Scoring uses the same 10-point rubric as the May 20 audit: extraction, explicit constraints, qualification/tutor/profile safety, parent-ready safety, and usefulness.",
    "",
    "## Scored Runs",
    "",
    "| Run | Admin | Request | Status | Score | Verdict | Notes |",
    "| --- | --- | --- | --- | ---: | --- | --- |",
    ...markdownTable(tableRows),
    "",
    "## Areas Of Concern",
    "",
    ...concernBullets(input.results),
    "",
    "## Run Details",
    "",
    ...details,
    "",
  ].join("\n");
}

function buildReplayEvaluation(input: {
  productionResults: EvaluatedRun[];
  replayResults: EvaluatedRun[];
  rawPath: string;
  model: string;
  snapshotId: string;
  profileVersion: string;
  profileCount: number;
  profileMaxUpdatedAt: string | null;
}): string {
  const productionTotals = totals(input.productionResults);
  const replayTotals = totals(input.replayResults);
  const replayByRun = new Map(input.replayResults.map((result) => [result.runId, result]));
  const improved = input.productionResults.filter((prod) => (replayByRun.get(prod.runId)?.score ?? prod.score) > prod.score).length;
  const regressed = input.productionResults.filter((prod) => (replayByRun.get(prod.runId)?.score ?? prod.score) < prod.score).length;

  const rows = input.productionResults.map((prod) => {
    const replay = replayByRun.get(prod.runId);
    const delta = replay ? replay.score - prod.score : 0;
    return [
      `\`${prod.runId.slice(0, 8)}\``,
      prod.admin,
      prod.label,
      `${prod.score} (${prod.verdict})`,
      replay ? `${replay.score} (${replay.verdict})` : "missing",
      delta > 0 ? `+${delta}` : String(delta),
      replay ? (replay.status === "parent_ready" ? "parent-ready" : "clarify") : "missing",
      replay?.concerns.length ? replay.concerns.join("; ") : "None",
    ];
  });

  const detailSections = input.replayResults.map((result) => {
    const production = input.productionResults.find((candidate) => candidate.runId === result.runId);
    const delta = production ? result.score - production.score : 0;
    return [
      `### ${result.runId.slice(0, 8)} - ${result.label}`,
      "",
      production ? `- Production score: ${production.score}/10 (${production.verdict}); replay score: ${result.score}/10 (${result.verdict}); delta: ${delta > 0 ? `+${delta}` : delta}.` : `- Replay score: ${result.score}/10 (${result.verdict}).`,
      `- Replay status: ${result.status}.`,
      `- Replay assistant: ${result.assistantMessage || "(empty)"}`,
      `- Replay availability summary: ${formatAvailabilitySummary(result)}.`,
      `- Replay suggestions: ${formatSuggestions(result)}.`,
      `- Replay questions: ${result.questions.length ? result.questions.join(" / ") : "None"}.`,
      `- Notes: ${result.notes.join(" ")}`,
      result.concerns.length ? `- Concerns: ${result.concerns.join(" ")}` : "- Concerns: None.",
    ].join("\n");
  });

  return [
    `# AI Scheduler Replay Evaluation - ${REPORT_DATE}`,
    "",
    "## Summary",
    "",
    `Replayed the same 7 production AI scheduler turns read-only against the current scheduler conversation flow using \`${input.model}\`, active Wise snapshot \`${input.snapshotId}\`, and search index profile version \`${input.profileVersion}\`. OpenAI calls used \`store:false\`; no production rows were inserted or updated.`,
    "",
    `Tutor profile seed state: ${input.profileCount} active profiles, latest update ${formatUtcSecond(input.profileMaxUpdatedAt)}.`,
    "",
    `Production total score: ${productionTotals.score}/${productionTotals.max}. Replay total score: ${replayTotals.score}/${replayTotals.max}. Improved: ${improved}. Regressed: ${regressed}. Replay remaining critical: ${replayTotals.critical}.`,
    "",
    `Raw replay JSON artifact: \`${input.rawPath}\`.`,
    "",
    "## Comparison Table",
    "",
    "| Run | Admin | Request | Production | Replay | Delta | Replay Status | Replay Concerns |",
    "| --- | --- | --- | --- | --- | ---: | --- | --- |",
    ...markdownTable(rows),
    "",
    "## Remaining Concerns",
    "",
    ...concernBullets(input.replayResults),
    "",
    "## Run Details",
    "",
    ...detailSections,
    "",
  ].join("\n");
}

async function loadMessagesByConversation(conversationIds: string[]): Promise<Map<string, SchedulerMessageRow[]>> {
  const db = getDb();
  const messages = await db
    .select()
    .from(schema.aiSchedulerMessages)
    .where(inArray(schema.aiSchedulerMessages.conversationId, conversationIds))
    .orderBy(schema.aiSchedulerMessages.createdAt);

  const messagesByConversation = new Map<string, SchedulerMessageRow[]>();
  for (const message of messages) {
    const existing = messagesByConversation.get(message.conversationId) ?? [];
    existing.push(message);
    messagesByConversation.set(message.conversationId, existing);
  }
  return messagesByConversation;
}

async function main() {
  loadEnvConfig(process.cwd());
  process.env.OPENAI_SCHEDULER_MODEL = "gpt-5.4-mini";

  const db = getDb();
  const runsForDay = await db
    .select()
    .from(schema.aiSchedulerRuns)
    .where(and(
      gte(schema.aiSchedulerRuns.createdAt, BANGKOK_DAY_START_UTC),
      lt(schema.aiSchedulerRuns.createdAt, BANGKOK_DAY_END_UTC),
    ))
    .orderBy(schema.aiSchedulerRuns.createdAt);

  const targetRuns = CASES.map((caseDef) => {
    const run = runsForDay.find((candidate) => candidate.id.startsWith(caseDef.idPrefix));
    if (!run) throw new Error(`Missing production run ${caseDef.idPrefix}`);
    return run;
  });

  const conversationIds = Array.from(new Set(targetRuns.map((run) => run.conversationId).filter(Boolean))) as string[];
  const messagesByConversation = await loadMessagesByConversation(conversationIds);

  const productionResults = targetRuns.map((run) => {
    const caseDef = CASES.find((candidate) => run.id.startsWith(candidate.idPrefix));
    if (!caseDef) throw new Error(`Missing case definition for ${run.id}`);
    return evaluatedRunFromResult({
      view: "production",
      run,
      caseDef,
      adminInput: adminMessageForRun(run, messagesByConversation),
      result: resultFromProductionRun(run),
    });
  });

  const [index, activeProposalHolds, profileInfo] = await Promise.all([
    ensureIndex(db),
    listActiveProposalHolds(db),
    db
      .select({
        count: sql<string>`count(*)::text`,
        maxUpdatedAt: sql<string | null>`max(${schema.tutorBusinessProfiles.updatedAt})::text`,
      })
      .from(schema.tutorBusinessProfiles)
      .where(eq(schema.tutorBusinessProfiles.active, true)),
  ]);
  const filterOptions = filterOptionsFromIndex(index);
  const tutorList = tutorListFromIndex(index);
  const profileCount = Number(profileInfo[0]?.count ?? 0);
  const profileMaxUpdatedAt = profileInfo[0]?.maxUpdatedAt ?? null;

  const replayCandidateRuns = await db
    .select()
    .from(schema.aiSchedulerRuns)
    .where(and(
      inArray(schema.aiSchedulerRuns.conversationId, conversationIds),
      lt(schema.aiSchedulerRuns.createdAt, BANGKOK_DAY_END_UTC),
    ))
    .orderBy(schema.aiSchedulerRuns.createdAt);

  const stateByConversation = new Map<string, SchedulerExtractedState>();
  const promptMessagesByConversation = new Map<string, SchedulerConversationMessageForPrompt[]>();
  const targetCaseByRunPrefix = new Map(CASES.map((caseDef) => [caseDef.idPrefix, caseDef]));
  const replayResults: EvaluatedRun[] = [];

  for (const run of replayCandidateRuns) {
    const caseDef = [...targetCaseByRunPrefix.entries()].find(([prefix]) => run.id.startsWith(prefix))?.[1];
    const conversationId = run.conversationId ?? null;
    if (!conversationId) continue;
    const adminInput = adminMessageForRun(run, messagesByConversation);
    const currentState = stateByConversation.get(conversationId) ?? {};
    const priorMessages = promptMessagesByConversation.get(conversationId) ?? [];
    const promptMessages: SchedulerConversationMessageForPrompt[] = [
      ...priorMessages,
      { role: "admin", content: adminInput },
    ];

    const extraction = await extractSchedulerStateWithOpenAi({
      currentState,
      messages: promptMessages,
      todayBangkok: bangkokTodayIso(run.createdAt),
      filterOptions,
      tutorList,
    });
    const mergedState = mergeSchedulerState(currentState, extraction.state);
    const assistantResult = solveSchedulerTurn({
      index,
      extractedState: mergedState,
      sourceText: adminInput,
      filterOptions,
      tutorList,
      activeProposalHolds,
    });

    stateByConversation.set(conversationId, assistantResult.state);
    promptMessagesByConversation.set(conversationId, [
      ...promptMessages,
      { role: "assistant", content: assistantResult.assistantMessage },
    ]);

    if (caseDef) {
      replayResults.push(evaluatedRunFromResult({
        view: "replay",
        run,
        caseDef,
        adminInput,
        result: assistantResult,
      }));
      console.log(`${run.id.slice(0, 8)} ${caseDef.label}: replay ${replayResults[replayResults.length - 1].score}/10`);
    }
  }

  const rawDir = "/tmp/bgscheduler";
  await mkdir(rawDir, { recursive: true });
  const rawPath = path.join(rawDir, `ai-scheduler-replay-${REPORT_DATE}.json`);
  await writeFile(rawPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    reportDate: REPORT_DATE,
    bangkokUtcRange: {
      start: BANGKOK_DAY_START_UTC.toISOString(),
      end: BANGKOK_DAY_END_UTC.toISOString(),
    },
    model: aiSchedulerModel(),
    snapshotId: index.snapshotId,
    profileVersion: index.profileVersion,
    profileCount,
    profileMaxUpdatedAt,
    productionResults,
    replayResults,
  }, null, 2)}\n`);

  const productionPath = path.join(process.cwd(), "docs", `ai-scheduler-audit-${REPORT_DATE}.md`);
  const replayPath = path.join(process.cwd(), "docs", `ai-scheduler-replay-eval-${REPORT_DATE}.md`);
  await writeFile(productionPath, buildProductionAudit({
    results: productionResults,
    profileCount,
    profileMaxUpdatedAt,
  }));
  await writeFile(replayPath, buildReplayEvaluation({
    productionResults,
    replayResults,
    rawPath,
    model: aiSchedulerModel(),
    snapshotId: index.snapshotId,
    profileVersion: index.profileVersion,
    profileCount,
    profileMaxUpdatedAt,
  }));
  console.log(`Wrote ${path.relative(process.cwd(), productionPath)}`);
  console.log(`Wrote ${path.relative(process.cwd(), replayPath)}`);
  console.log(`Wrote ${rawPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
