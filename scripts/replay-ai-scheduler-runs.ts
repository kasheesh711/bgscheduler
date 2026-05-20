import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
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

interface ExpectedSlot {
  searchMode?: "recurring" | "one_time";
  dayOfWeek?: number;
  date?: string;
  start: string;
  end: string;
  exact?: boolean;
}

interface BaselineCase {
  idPrefix: string;
  admin: string;
  label: string;
  oldScore: number;
  oldVerdict: Verdict;
  expectedSubject?: string;
  expectedLevel?: string;
  expectedStudent?: string;
  expectedMode?: "online" | "onsite" | "either";
  expectedSlots?: ExpectedSlot[];
  expectedClarification?: boolean;
  requireNoSuggestions?: boolean;
  negativeFeedback?: boolean;
  forbidTutors?: string[];
  notes: string;
}

interface ReplayCaseResult {
  runId: string;
  conversationId: string | null;
  admin: string;
  label: string;
  input: string;
  oldScore: number;
  oldVerdict: Verdict;
  newScore: number;
  newVerdict: Verdict;
  scoreDelta: number;
  resultStatus: "parent_ready" | "needs_clarification";
  assistantMessage: string;
  questions: string[];
  warnings: string[];
  suggestions: Array<{
    day: string;
    start: string;
    end: string;
    tutors: string[];
    requestedSlotId?: string;
  }>;
  state: SchedulerAssistantResult["state"];
  scoreNotes: string[];
  concernFlags: string[];
}

const REPORT_DATE = "2026-05-20";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const BASELINES: BaselineCase[] = [
  {
    idPrefix: "6950b017",
    admin: "Kevin",
    label: "Physics, Sundays, 5-7pm",
    oldScore: 6,
    oldVerdict: "mixed",
    expectedSubject: "Physics",
    expectedStudent: "Rita",
    expectedSlots: [{ searchMode: "recurring", dayOfWeek: 0, start: "17:00", end: "19:00" }],
    notes: "Should preserve Sunday 17:00-19:00 and avoid unrelated days.",
  },
  {
    idPrefix: "407a50cc",
    admin: "Kevin",
    label: "Physics tutor Sunday around 1pm",
    oldScore: 8,
    oldVerdict: "accurate",
    expectedSubject: "Physics",
    expectedClarification: true,
    requireNoSuggestions: true,
    notes: "Around 1pm without duration/recurrence should remain a clarification turn.",
  },
  {
    idPrefix: "241e185f",
    admin: "Kevin",
    label: "Physics, 24 May Sunday, recurring, 60 min",
    oldScore: 8,
    oldVerdict: "accurate",
    expectedSubject: "Physics",
    expectedSlots: [{ searchMode: "recurring", dayOfWeek: 0, start: "13:00", end: "14:00", exact: true }],
    notes: "Should preserve recurring Sunday around 13:00 for 60 minutes.",
  },
  {
    idPrefix: "caf4c429",
    admin: "Kevin",
    label: "Thai urgent Chemistry tonight/tomorrow",
    oldScore: 9,
    oldVerdict: "accurate",
    expectedSubject: "Chemistry",
    expectedClarification: true,
    requireNoSuggestions: true,
    notes: "Multiple urgent alternatives should ask for a concrete date/time.",
  },
  {
    idPrefix: "841efaff",
    admin: "Kevin",
    label: "Chemistry follow-up, 60 min, onsite, 24 May 6pm",
    oldScore: 7,
    oldVerdict: "mixed",
    expectedSubject: "Chemistry",
    expectedLevel: "Y9-11",
    expectedMode: "onsite",
    expectedSlots: [{ searchMode: "one_time", date: "2026-05-24", start: "18:00", end: "19:00", exact: true }],
    notes: "Should preserve onsite, International/Y10, 24 May, and exact 18:00-19:00.",
  },
  {
    idPrefix: "05bd5e6e",
    admin: "Kevin",
    label: "N' Rita, every Sunday at 6pm",
    oldScore: 4,
    oldVerdict: "critical",
    expectedStudent: "Rita",
    expectedSlots: [{ searchMode: "recurring", dayOfWeek: 0, start: "18:00", end: "19:00", exact: true }],
    notes: "Exact 18:00 request must not return 19:00 first.",
  },
  {
    idPrefix: "643f05ad",
    admin: "Suphitsara",
    label: "Henry Year 5 Math, Saturday 10-11",
    oldScore: 7,
    oldVerdict: "mixed",
    expectedSubject: "Math",
    expectedLevel: "Year 5",
    expectedStudent: "Henry",
    expectedSlots: [{ searchMode: "recurring", dayOfWeek: 6, start: "10:00", end: "11:00", exact: true }],
    notes: "Should keep Saturday 10:00-11:00 Math for Henry.",
  },
  {
    idPrefix: "2649f228",
    admin: "Suphitsara",
    label: "Henry follow-up: on site only",
    oldScore: 5,
    oldVerdict: "mixed",
    expectedSubject: "Math",
    expectedLevel: "Year 5",
    expectedStudent: "Henry",
    expectedMode: "onsite",
    expectedSlots: [{ searchMode: "recurring", dayOfWeek: 6, start: "10:00", end: "11:00", exact: true }],
    notes: "Should update only delivery mode while preserving Henry's Math slot.",
  },
  {
    idPrefix: "50edd166",
    admin: "Suphitsara",
    label: "Ing Ing English writing, Sat/Sun 9-12 onsite",
    oldScore: 2,
    oldVerdict: "critical",
    expectedSubject: "English",
    expectedStudent: "Ing Ing",
    expectedMode: "onsite",
    expectedSlots: [
      { searchMode: "recurring", dayOfWeek: 6, start: "09:00", end: "12:00" },
      { searchMode: "recurring", dayOfWeek: 0, start: "09:00", end: "12:00" },
    ],
    notes: "Should reset stale Henry/Math state and search only the weekend 09:00-12:00 windows.",
  },
  {
    idPrefix: "9aa6bcf6",
    admin: "Natchasmith",
    label: "Maze 11+/13+ English, 13-14",
    oldScore: 6,
    oldVerdict: "mixed",
    expectedSubject: "English",
    expectedStudent: "maze",
    expectedClarification: true,
    requireNoSuggestions: true,
    notes: "Missing weekday/date should block broad suggestions.",
  },
  {
    idPrefix: "ccccb44a",
    admin: "Natchasmith",
    label: "Maze follow-up: recurring",
    oldScore: 5,
    oldVerdict: "mixed",
    expectedSubject: "English",
    expectedStudent: "maze",
    expectedClarification: true,
    requireNoSuggestions: true,
    notes: "Recurring still lacks a weekday, so it should ask for the day.",
  },
  {
    idPrefix: "4ec80617",
    admin: "Suphitsara",
    label: "Thames.Te Math replacing June, Thu 5-6 online",
    oldScore: 7,
    oldVerdict: "mixed",
    expectedSubject: "Math",
    expectedStudent: "Thames.Te",
    expectedMode: "online",
    expectedSlots: [{ searchMode: "recurring", dayOfWeek: 4, start: "17:00", end: "18:00", exact: true }],
    forbidTutors: ["June"],
    notes: "Replacement wording should exclude June while preserving Thursday online Math.",
  },
  {
    idPrefix: "91b86850",
    admin: "Suphitsara",
    label: "Deenoh/Deenah NonVR replacing June, Saturday onsite",
    oldScore: 2,
    oldVerdict: "critical",
    expectedSubject: "NonVR",
    expectedStudent: "Deenoh",
    expectedMode: "onsite",
    expectedClarification: true,
    requireNoSuggestions: true,
    forbidTutors: ["June"],
    notes: "No Saturday time is given; should ask for time and not suggest June.",
  },
  {
    idPrefix: "2b6a0a0c",
    admin: "Suphitsara",
    label: "Praad Math Sunday 12:00",
    oldScore: 1,
    oldVerdict: "critical",
    expectedSubject: "Math",
    expectedStudent: "Praad",
    expectedSlots: [{ searchMode: "recurring", dayOfWeek: 0, start: "12:00", end: "13:00", exact: true }],
    forbidTutors: ["June"],
    notes: "Should reset stale Deenoh/June/NonVR state and derive 12:00-13:00.",
  },
  {
    idPrefix: "e41c2a25",
    admin: "Care KT",
    label: "Econ Y10 for เอิง, Fri 18:30-19:30 and Sat 13:00-14:00",
    oldScore: 1,
    oldVerdict: "critical",
    expectedSubject: "Econ",
    expectedLevel: "Y9-11",
    expectedStudent: "เอิง",
    expectedSlots: [
      { searchMode: "recurring", dayOfWeek: 5, start: "18:30", end: "19:30", exact: true },
      { searchMode: "recurring", dayOfWeek: 6, start: "13:00", end: "14:00", exact: true },
    ],
    notes: "Priority regression: must not return Monday/Tuesday.",
  },
  {
    idPrefix: "0a56281f",
    admin: "Care KT",
    label: "Care KT negative feedback: ไม่เริ่ด",
    oldScore: 1,
    oldVerdict: "critical",
    negativeFeedback: true,
    expectedClarification: true,
    requireNoSuggestions: true,
    notes: "Negative feedback should ask what to change instead of repeating suggestions.",
  },
];

function normalize(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function includesNormalized(value: string | undefined, needle: string): boolean {
  return normalize(value).includes(normalize(needle));
}

function bangkokIsoFor(date: Date): string {
  return bangkokTodayIso(date);
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

function suggestedTutorNames(result: SchedulerAssistantResult): string[] {
  return result.suggestions.flatMap((suggestion) => suggestion.tutors.map((tutor) => tutor.displayName));
}

function hasForbiddenTutor(result: SchedulerAssistantResult, names: string[] = []): boolean {
  const tutors = suggestedTutorNames(result);
  return names.some((name) => tutors.some((tutor) => normalize(tutor) === normalize(name)));
}

function hasAnyRelevantQuestion(result: SchedulerAssistantResult): boolean {
  const text = result.questions.join(" ");
  return Boolean(text.trim());
}

function verdictFor(score: number, critical: boolean): Verdict {
  if (critical) return "critical";
  if (score >= 8) return "accurate";
  if (score >= 5) return "mixed";
  return "bad";
}

function scoreReplay(caseDef: BaselineCase, result: SchedulerAssistantResult): {
  score: number;
  verdict: Verdict;
  notes: string[];
  concerns: string[];
} {
  const notes: string[] = [];
  const concerns: string[] = [];
  const expectedSlots = caseDef.expectedSlots ?? [];

  let extraction = 2;
  const extractionMisses: string[] = [];
  if (caseDef.expectedSubject && !includesNormalized(result.state.filters.subject, caseDef.expectedSubject)) {
    extractionMisses.push(`subject ${caseDef.expectedSubject}`);
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
  if (caseDef.negativeFeedback && !result.state.negativeFeedback) {
    extractionMisses.push("negative feedback flag");
  }
  if (extractionMisses.length >= 3) extraction = 0;
  else if (extractionMisses.length > 0) extraction = 1;
  if (extractionMisses.length > 0) concerns.push(`Missing/wrong extraction: ${extractionMisses.join(", ")}.`);

  let constraints = 2;
  const matchedSlotCount = countMatchedSlots(result, expectedSlots);
  const suggestionsWithinSlots = allSuggestionsWithinExpectedSlots(result, expectedSlots);
  if (expectedSlots.length > 0) {
    if (matchedSlotCount === expectedSlots.length && suggestionsWithinSlots) {
      notes.push("Explicit day/time constraints were preserved.");
    } else if (matchedSlotCount > 0 && suggestionsWithinSlots) {
      constraints = 1;
      concerns.push(`Only ${matchedSlotCount}/${expectedSlots.length} expected slot(s) were preserved.`);
    } else {
      constraints = 0;
      concerns.push("Explicit day/time constraints were not preserved.");
    }
    if (!suggestionsWithinSlots) {
      concerns.push("One or more suggestions fell outside the requested slot(s).");
    }
  }
  if (caseDef.requireNoSuggestions && result.suggestions.length > 0) {
    constraints = Math.min(constraints, 1);
    concerns.push("Clarification case still returned tentative suggestions.");
  }

  let qualificationTutor = 2;
  if (hasForbiddenTutor(result, caseDef.forbidTutors)) {
    qualificationTutor = 0;
    concerns.push(`Suggested excluded tutor(s): ${caseDef.forbidTutors?.join(", ")}.`);
  } else if (caseDef.forbidTutors?.length) {
    notes.push(`Excluded tutor(s) were not suggested: ${caseDef.forbidTutors.join(", ")}.`);
  }
  if (caseDef.expectedSubject && !includesNormalized(result.state.filters.subject, caseDef.expectedSubject)) {
    qualificationTutor = Math.min(qualificationTutor, 1);
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
  } else if (violatesExplicitConstraint) {
    safety = result.parentReady ? 0 : 1;
  } else if (!result.parentReady && expectedSlots.length > 0 && result.suggestions.length > 0) {
    safety = 1;
    notes.push("Output stayed tentative despite finding matching slot(s).");
  }

  let usefulness = 2;
  if (caseDef.negativeFeedback) {
    const asksWhatToChange = /what should i change|change about|เปลี่ยน|แก้/i.test(result.questions.join(" ") + " " + result.assistantMessage);
    if (result.suggestions.length > 0) usefulness = 0;
    else if (!asksWhatToChange) usefulness = 1;
  } else if (caseDef.expectedClarification || caseDef.requireNoSuggestions) {
    if (!hasAnyRelevantQuestion(result)) usefulness = 0;
    else if (result.suggestions.length > 0) usefulness = 1;
  } else if (expectedSlots.length > 0) {
    if (result.suggestions.length > 0 && suggestionsWithinSlots) usefulness = 2;
    else if (!result.parentReady && hasAnyRelevantQuestion(result)) usefulness = 1;
    else if (result.suggestions.length === 0) usefulness = 1;
    else usefulness = 0;
  }

  const critical = Boolean(result.parentReady && (
    violatesExplicitConstraint ||
    hasForbiddenTutor(result, caseDef.forbidTutors) ||
    (caseDef.negativeFeedback && result.suggestions.length > 0)
  ));

  const score = extraction + constraints + qualificationTutor + safety + usefulness;
  const verdict = verdictFor(score, critical);
  notes.push(`Rubric components: extraction ${extraction}/2, constraints ${constraints}/2, qualification/tutor ${qualificationTutor}/2, safety ${safety}/2, usefulness ${usefulness}/2.`);
  return { score, verdict, notes, concerns };
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

function buildMarkdown(results: ReplayCaseResult[], rawPath: string, model: string, snapshotId: string): string {
  const totalOld = results.reduce((sum, result) => sum + result.oldScore, 0);
  const totalNew = results.reduce((sum, result) => sum + result.newScore, 0);
  const improved = results.filter((result) => result.newScore > result.oldScore).length;
  const regressed = results.filter((result) => result.newScore < result.oldScore).length;
  const care = results.find((result) => result.runId.startsWith("e41c2a25"));
  const critical = results.filter((result) => result.newVerdict === "critical");

  const rows = results.map((result) => [
    `\`${result.runId.slice(0, 8)}\``,
    result.admin,
    result.label.replace(/\|/g, "/"),
    `${result.oldScore} (${result.oldVerdict})`,
    `${result.newScore} (${result.newVerdict})`,
    result.scoreDelta > 0 ? `+${result.scoreDelta}` : String(result.scoreDelta),
    result.resultStatus === "parent_ready" ? "parent-ready" : "clarify",
    result.concernFlags.length ? result.concernFlags.join("; ").replace(/\|/g, "/") : "None",
  ].join(" | "));

  const detailSections = results.map((result) => [
    `### ${result.runId.slice(0, 8)} - ${result.label}`,
    "",
    `- Old score: ${result.oldScore} (${result.oldVerdict}); new score: ${result.newScore} (${result.newVerdict}); delta: ${result.scoreDelta > 0 ? `+${result.scoreDelta}` : result.scoreDelta}.`,
    `- New status: ${result.resultStatus}.`,
    `- Assistant: ${result.assistantMessage}`,
    `- Suggestions: ${result.suggestions.length > 0 ? result.suggestions.map((suggestion) => `${suggestion.day} ${suggestion.start}-${suggestion.end}${suggestion.tutors.length ? ` (${suggestion.tutors.join(", ")})` : ""}`).join("; ") : "None"}.`,
    `- Questions: ${result.questions.length > 0 ? result.questions.join(" / ") : "None"}.`,
    `- Notes: ${result.scoreNotes.join(" ")}`,
    result.concernFlags.length ? `- Concerns: ${result.concernFlags.join(" ")}` : "- Concerns: None.",
  ].join("\n"));

  return [
    `# AI Scheduler Replay Evaluation - ${REPORT_DATE}`,
    "",
    "## Summary",
    "",
    `Replayed all ${results.length} production AI scheduler runs read-only against the current scheduler conversation flow using \`${model}\` and the active Wise snapshot \`${snapshotId}\`. OpenAI calls used \`store:false\`; no production rows were inserted or updated.`,
    "",
    `Old total score: ${totalOld}/${results.length * 10}. New total score: ${totalNew}/${results.length * 10}. Improved: ${improved}. Regressed: ${regressed}. Remaining critical: ${critical.length}.`,
    "",
    care
      ? `Care KT Econ regression: new output status is ${care.resultStatus}; suggestions are ${care.suggestions.length ? care.suggestions.map((suggestion) => `${suggestion.day} ${suggestion.start}-${suggestion.end}`).join(", ") : "none"}. Monday/Tuesday leakage: ${care.suggestions.some((suggestion) => ["Monday", "Tuesday"].includes(suggestion.day)) ? "YES" : "NO"}.`
      : "Care KT Econ regression: case not found.",
    "",
    `Raw replay JSON artifact: \`${rawPath}\`.`,
    "",
    "## Comparison Table",
    "",
    "| Run | Admin | Request | Old | New | Delta | New Status | Concerns |",
    "| --- | --- | --- | --- | --- | ---: | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
    "",
    "## Remaining Concerns",
    "",
    critical.length > 0
      ? critical.map((result) => `- \`${result.runId.slice(0, 8)}\` ${result.label}: ${result.concernFlags.join(" ") || "Critical verdict."}`).join("\n")
      : "- No replayed run scored as critical under the audit rubric.",
    "",
    "Other cases that remain below accurate:",
    ...results
      .filter((result) => result.newVerdict !== "accurate")
      .map((result) => `- \`${result.runId.slice(0, 8)}\` ${result.label}: ${result.newScore}/10 (${result.newVerdict}). ${result.concernFlags[0] ?? "Safe but still not fully useful."}`),
    "",
    "## Run Details",
    "",
    ...detailSections,
    "",
  ].join("\n");
}

async function main() {
  loadEnvConfig(process.cwd());
  process.env.OPENAI_SCHEDULER_MODEL = "gpt-5.4-mini";

  const db = getDb();
  const [runs, messages, index, activeProposalHolds] = await Promise.all([
    db.select().from(schema.aiSchedulerRuns).orderBy(schema.aiSchedulerRuns.createdAt),
    db.select().from(schema.aiSchedulerMessages).orderBy(schema.aiSchedulerMessages.createdAt),
    ensureIndex(db),
    listActiveProposalHolds(db),
  ]);
  const filterOptions = filterOptionsFromIndex(index);
  const tutorList = tutorListFromIndex(index);

  const messagesByConversation = new Map<string, SchedulerMessageRow[]>();
  for (const message of messages) {
    const existing = messagesByConversation.get(message.conversationId) ?? [];
    existing.push(message);
    messagesByConversation.set(message.conversationId, existing);
  }

  const stateByConversation = new Map<string, SchedulerExtractedState>();
  const promptMessagesByConversation = new Map<string, SchedulerConversationMessageForPrompt[]>();
  const results: ReplayCaseResult[] = [];

  for (const baseline of BASELINES) {
    const run = runs.find((candidate) => candidate.id.startsWith(baseline.idPrefix));
    if (!run) {
      throw new Error(`Missing production run ${baseline.idPrefix}`);
    }
    const adminInput = adminMessageForRun(run, messagesByConversation);
    const conversationId = run.conversationId ?? null;
    const currentState = conversationId ? stateByConversation.get(conversationId) ?? {} : {};
    const priorMessages = conversationId ? promptMessagesByConversation.get(conversationId) ?? [] : [];
    const promptMessages: SchedulerConversationMessageForPrompt[] = [
      ...priorMessages,
      { role: "admin", content: adminInput },
    ];

    const extraction = await extractSchedulerStateWithOpenAi({
      currentState,
      messages: promptMessages,
      todayBangkok: bangkokIsoFor(run.createdAt),
      filterOptions,
      tutorList,
    });
    const mergedState = mergeSchedulerState(currentState, extraction.state);
    const assistantResult = solveSchedulerTurn({
      index,
      extractedState: mergedState,
      filterOptions,
      tutorList,
      activeProposalHolds,
    });
    const score = scoreReplay(baseline, assistantResult);

    if (conversationId) {
      stateByConversation.set(conversationId, assistantResult.state);
      promptMessagesByConversation.set(conversationId, [
        ...promptMessages,
        { role: "assistant", content: assistantResult.assistantMessage },
      ]);
    }

    results.push({
      runId: run.id,
      conversationId,
      admin: baseline.admin,
      label: baseline.label,
      input: adminInput,
      oldScore: baseline.oldScore,
      oldVerdict: baseline.oldVerdict,
      newScore: score.score,
      newVerdict: score.verdict,
      scoreDelta: score.score - baseline.oldScore,
      resultStatus: assistantResult.parentReady ? "parent_ready" : "needs_clarification",
      assistantMessage: assistantResult.assistantMessage,
      questions: assistantResult.questions,
      warnings: assistantResult.warnings,
      suggestions: assistantResult.suggestions.map((suggestion) => ({
        day: dayLabel(suggestion),
        start: suggestion.start,
        end: suggestion.end,
        tutors: suggestion.tutors.map((tutor) => tutor.displayName),
        requestedSlotId: suggestion.requestedSlotId,
      })),
      state: assistantResult.state,
      scoreNotes: score.notes,
      concernFlags: score.concerns,
    });

    console.log(`${run.id.slice(0, 8)} ${baseline.label}: ${score.score}/10 ${score.verdict}`);
  }

  const rawDir = path.join(os.tmpdir(), "bgscheduler");
  await mkdir(rawDir, { recursive: true });
  const rawPath = path.join(rawDir, `ai-scheduler-replay-${REPORT_DATE}.json`);
  await writeFile(rawPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    model: aiSchedulerModel(),
    snapshotId: index.snapshotId,
    results,
  }, null, 2)}\n`);

  const reportPath = path.join(process.cwd(), "docs", `ai-scheduler-replay-eval-${REPORT_DATE}.md`);
  const report = buildMarkdown(results, rawPath, aiSchedulerModel(), index.snapshotId);
  await writeFile(reportPath, report);
  console.log(`Wrote ${path.relative(process.cwd(), reportPath)}`);
  console.log(`Wrote ${rawPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
