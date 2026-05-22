import { z } from "zod";
import { parseTimeToMinutes } from "@/lib/normalization/timezone";
import { proposalHoldBlocksSearchSlot, weekdayForIsoDate } from "@/lib/proposals/overlap";
import type { ProposalHoldSummary } from "@/lib/proposals/types";
import { executeSearch } from "@/lib/search/engine";
import type { IndexedTutorGroup, SearchIndex } from "@/lib/search/index";
import type { FilterOptions } from "@/lib/data/filters";
import type { TutorListItem } from "@/lib/data/tutors";
import {
  aiSchedulerModel,
  extractOutputText,
  isAiSchedulerConfigured,
} from "@/lib/ai/scheduler";
import {
  recoverFiltersFromUnknowns,
  resolveAcademicFilters,
  type AcademicLevelResolution,
} from "@/lib/ai/academic-levels";
import { TEACHING_STYLE_VOCABULARY } from "@/lib/tutor-profile-vocabulary";
import type { SearchFilters, SnapshotMeta, TutorResult } from "@/lib/search/types";

export const DEFAULT_CONVERSATIONAL_DURATION = 60;
export const DEFAULT_CONVERSATIONAL_MODE = "either";
export const MAX_SCHEDULER_SUGGESTIONS = 8;

export type SchedulerSearchMode = "recurring" | "one_time";
export type SchedulerDeliveryMode = "online" | "onsite" | "either";
export type SchedulerDuration = 60 | 90 | 120;

export interface SchedulerRequestedSlot {
  id?: string;
  searchMode?: SchedulerSearchMode;
  dayOfWeek?: number;
  date?: string;
  startTime?: string;
  endTime?: string;
  durationMinutes?: SchedulerDuration;
}

export interface SchedulerDateRange {
  startDate: string;
  endDate: string;
}

export interface SchedulerSubjectIntent {
  family: "english" | "single";
  label: string;
  canonicalSubjects: string[];
  skillTags: string[];
  curriculum?: string;
  level?: string;
  source: "deterministic" | "model";
}

export interface SchedulerExtractedState {
  searchMode?: SchedulerSearchMode;
  dayOfWeek?: number;
  date?: string;
  startTime?: string;
  endTime?: string;
  durationMinutes?: SchedulerDuration;
  mode?: SchedulerDeliveryMode;
  filters?: SearchFilters;
  academicLevelResolution?: AcademicLevelResolution;
  subjectIntent?: SchedulerSubjectIntent;
  subjectRequests?: SearchFilters[];
  businessRequirements?: SchedulerBusinessRequirements;
  dateRange?: SchedulerDateRange;
  requestedSlots?: SchedulerRequestedSlot[];
  explicitUnknownFilters?: string[];
  explicitUnknownBusinessRequirements?: string[];
  tutorNames?: string[];
  tutorExclusions?: string[];
  parentName?: string;
  studentName?: string;
  contact?: string;
  negativeFeedback?: boolean;
  assumptions?: string[];
  unresolvedQuestions?: string[];
  parentRequestSummary?: string;
}

export interface SchedulerResolvedState extends SchedulerExtractedState {
  durationMinutes: SchedulerDuration;
  mode: SchedulerDeliveryMode;
  filters: SearchFilters;
  subjectIntent?: SchedulerSubjectIntent;
  subjectRequests: SearchFilters[];
  businessRequirements: SchedulerBusinessRequirements;
  dateRange?: SchedulerDateRange;
  requestedSlots: SchedulerRequestedSlot[];
  explicitUnknownFilters: string[];
  explicitUnknownBusinessRequirements: string[];
  tutorNames: string[];
  tutorExclusions: string[];
  negativeFeedback: boolean;
  assumptions: string[];
  unresolvedQuestions: string[];
}

export type SchedulerEnglishProficiency =
  | "native"
  | "near-native"
  | "fluent"
  | "conversational"
  | "basic"
  | "unknown";

export interface SchedulerBusinessRequirements {
  englishProficiency?: SchedulerEnglishProficiency;
  youngLearnerAge?: number;
  strengthTags?: string[];
  curriculumExperience?: string[];
  teachingStyleTags?: string[];
  schoolKeywords?: string[];
}

export interface SchedulerSuggestionTutor {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
}

export interface SchedulerSuggestion {
  id: string;
  rank: number;
  searchMode: SchedulerSearchMode;
  dayOfWeek?: number;
  date?: string;
  start: string;
  end: string;
  durationMinutes: SchedulerDuration;
  mode: SchedulerDeliveryMode;
  subject?: string;
  confidence: "Best fit" | "Strong fit" | "Good fit";
  tutors: SchedulerSuggestionTutor[];
  availableTutorCount: number;
  reasons: string[];
  parentReady: boolean;
  requestedSlotId?: string;
}

export interface SchedulerAvailabilityWindowSummary {
  date: string;
  weekday: number;
  start: string;
  end: string;
  mode: SchedulerDeliveryMode;
}

export interface SchedulerAvailabilityTutorSummary {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  matchedSubjects: string[];
  windows: SchedulerAvailabilityWindowSummary[];
}

export interface SchedulerAvailabilityReviewSummary {
  tutorGroupId: string;
  displayName: string;
  reasons: string[];
}

export interface SchedulerAvailabilitySummary {
  dateRange: SchedulerDateRange;
  filters: SearchFilters;
  searchedFilters: SearchFilters[];
  subjectIntent?: SchedulerSubjectIntent;
  durationMinutes: SchedulerDuration;
  mode: SchedulerDeliveryMode;
  searchProvenance: {
    snapshotId: string;
    profileVersion: string;
    activeProposalHoldCount: number;
  };
  tutors: SchedulerAvailabilityTutorSummary[];
  needsReview: SchedulerAvailabilityReviewSummary[];
}

export type SchedulerConstraintStatus = "proven" | "needs_clarification" | "not_applicable";
export type SchedulerConstraintEvidence = "model" | "deterministic" | "default" | "not_provided";

export interface SchedulerConstraintLedgerItem {
  key:
    | "search_mode"
    | "slot"
    | "date_range"
    | "duration"
    | "delivery_mode"
    | "academic_filter"
    | "subject_requests"
    | "tutor_include"
    | "tutor_exclude"
    | "business_requirement"
    | "negative_feedback";
  label: string;
  requested: string | null;
  normalized: string | null;
  evidence: SchedulerConstraintEvidence;
  status: SchedulerConstraintStatus;
  message: string;
}

export interface SchedulerAssistantResult {
  state: SchedulerResolvedState;
  suggestions: SchedulerSuggestion[];
  availabilitySummary?: SchedulerAvailabilitySummary;
  constraintLedger: SchedulerConstraintLedgerItem[];
  latencyBreakdownMs?: {
    totalMs: number;
    dbMs: number;
    modelMs: number;
    searchMs: number;
  };
  parentMessageDraft: string;
  assistantMessage: string;
  snapshotMeta: SnapshotMeta;
  warnings: string[];
  questions: string[];
  parentReady: boolean;
}

interface SchedulerCandidateSlot {
  id: string;
  requestedSlotId?: string;
  searchMode: SchedulerSearchMode;
  dayOfWeek?: number;
  date?: string;
  start: string;
  end: string;
  durationMinutes: SchedulerDuration;
  mode: SchedulerDeliveryMode;
}

export interface SchedulerConversationMessageForPrompt {
  role: "admin" | "parent" | "assistant" | "system";
  content: string;
}

const HH_MM_RE = /^\d{2}:\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const nullableFilterSchema = z.object({
  subject: z.string().nullable(),
  curriculum: z.string().nullable(),
  level: z.string().nullable(),
}).strict();

const modelDateRangeSchema = z.object({
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
}).strict();

const modelBusinessRequirementsSchema = z.object({
  englishProficiency: z.enum(["native", "near-native", "fluent", "conversational", "basic", "unknown"]).nullable(),
  youngLearnerAge: z.number().int().min(3).max(20).nullable(),
  strengthTags: z.array(z.string()),
  curriculumExperience: z.array(z.string()),
  teachingStyleTags: z.array(z.string()),
  schoolKeywords: z.array(z.string()),
}).strict();

const modelRequestedSlotSchema = z.object({
  id: z.string().nullable(),
  searchMode: z.enum(["recurring", "one_time"]).nullable(),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  date: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  durationMinutes: z.union([z.literal(60), z.literal(90), z.literal(120)]).nullable(),
}).strict();

const modelSchedulerExtractionSchema = z.object({
  searchMode: z.enum(["recurring", "one_time"]).nullable(),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  date: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  durationMinutes: z.union([z.literal(60), z.literal(90), z.literal(120)]).nullable(),
  mode: z.enum(["online", "onsite", "either"]).nullable(),
  filters: nullableFilterSchema,
  subjectRequests: z.array(nullableFilterSchema),
  businessRequirements: modelBusinessRequirementsSchema,
  dateRange: modelDateRangeSchema.nullable(),
  requestedSlots: z.array(modelRequestedSlotSchema),
  explicitUnknownFilters: z.array(z.string()),
  explicitUnknownBusinessRequirements: z.array(z.string()),
  tutorNames: z.array(z.string()),
  tutorExclusions: z.array(z.string()),
  parentName: z.string().nullable(),
  studentName: z.string().nullable(),
  contact: z.string().nullable(),
  negativeFeedback: z.boolean(),
  assumptions: z.array(z.string()),
  unresolvedQuestions: z.array(z.string()),
  parentRequestSummary: z.string().nullable(),
  title: z.string().nullable(),
}).strict();

export type ModelSchedulerExtraction = z.infer<typeof modelSchedulerExtractionSchema>;

export const openAiSchedulerExtractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "searchMode",
    "dayOfWeek",
    "date",
    "startTime",
    "endTime",
    "durationMinutes",
    "mode",
    "filters",
    "subjectRequests",
    "businessRequirements",
    "dateRange",
    "requestedSlots",
    "explicitUnknownFilters",
    "explicitUnknownBusinessRequirements",
    "tutorNames",
    "tutorExclusions",
    "parentName",
    "studentName",
    "contact",
    "negativeFeedback",
    "assumptions",
    "unresolvedQuestions",
    "parentRequestSummary",
    "title",
  ],
  properties: {
    searchMode: { anyOf: [{ type: "string", enum: ["recurring", "one_time"] }, { type: "null" }] },
    dayOfWeek: { anyOf: [{ type: "integer", minimum: 0, maximum: 6 }, { type: "null" }] },
    date: { anyOf: [{ type: "string" }, { type: "null" }] },
    startTime: { anyOf: [{ type: "string" }, { type: "null" }] },
    endTime: { anyOf: [{ type: "string" }, { type: "null" }] },
    durationMinutes: { anyOf: [{ type: "integer", enum: [60, 90, 120] }, { type: "null" }] },
    mode: { anyOf: [{ type: "string", enum: ["online", "onsite", "either"] }, { type: "null" }] },
    filters: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "curriculum", "level"],
      properties: {
        subject: { anyOf: [{ type: "string" }, { type: "null" }] },
        curriculum: { anyOf: [{ type: "string" }, { type: "null" }] },
        level: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
    subjectRequests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "curriculum", "level"],
        properties: {
          subject: { anyOf: [{ type: "string" }, { type: "null" }] },
          curriculum: { anyOf: [{ type: "string" }, { type: "null" }] },
          level: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
    dateRange: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["startDate", "endDate"],
          properties: {
            startDate: { anyOf: [{ type: "string" }, { type: "null" }] },
            endDate: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
        { type: "null" },
      ],
    },
    requestedSlots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "searchMode", "dayOfWeek", "date", "startTime", "endTime", "durationMinutes"],
        properties: {
          id: { anyOf: [{ type: "string" }, { type: "null" }] },
          searchMode: { anyOf: [{ type: "string", enum: ["recurring", "one_time"] }, { type: "null" }] },
          dayOfWeek: { anyOf: [{ type: "integer", minimum: 0, maximum: 6 }, { type: "null" }] },
          date: { anyOf: [{ type: "string" }, { type: "null" }] },
          startTime: { anyOf: [{ type: "string" }, { type: "null" }] },
          endTime: { anyOf: [{ type: "string" }, { type: "null" }] },
          durationMinutes: { anyOf: [{ type: "integer", enum: [60, 90, 120] }, { type: "null" }] },
        },
      },
    },
    explicitUnknownFilters: { type: "array", items: { type: "string" } },
    businessRequirements: {
      type: "object",
      additionalProperties: false,
      required: ["englishProficiency", "youngLearnerAge", "strengthTags", "curriculumExperience", "teachingStyleTags", "schoolKeywords"],
      properties: {
        englishProficiency: {
          anyOf: [
            { type: "string", enum: ["native", "near-native", "fluent", "conversational", "basic", "unknown"] },
            { type: "null" },
          ],
        },
        youngLearnerAge: { anyOf: [{ type: "integer", minimum: 3, maximum: 20 }, { type: "null" }] },
        strengthTags: { type: "array", items: { type: "string" } },
        curriculumExperience: { type: "array", items: { type: "string" } },
        teachingStyleTags: { type: "array", items: { type: "string" } },
        schoolKeywords: { type: "array", items: { type: "string" } },
      },
    },
    explicitUnknownBusinessRequirements: { type: "array", items: { type: "string" } },
    tutorNames: { type: "array", items: { type: "string" } },
    tutorExclusions: { type: "array", items: { type: "string" } },
    parentName: { anyOf: [{ type: "string" }, { type: "null" }] },
    studentName: { anyOf: [{ type: "string" }, { type: "null" }] },
    contact: { anyOf: [{ type: "string" }, { type: "null" }] },
    negativeFeedback: { type: "boolean" },
    assumptions: { type: "array", items: { type: "string" } },
    unresolvedQuestions: { type: "array", items: { type: "string" } },
    parentRequestSummary: { anyOf: [{ type: "string" }, { type: "null" }] },
    title: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const;

function normalizeLookup(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function compactString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTime(value: string | null | undefined): string | undefined {
  const trimmed = compactString(value);
  return trimmed && HH_MM_RE.test(trimmed) ? trimmed : undefined;
}

function normalizeDate(value: string | null | undefined): string | undefined {
  const trimmed = compactString(value);
  return trimmed && ISO_DATE_RE.test(trimmed) ? trimmed : undefined;
}

function uniqueStrings(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = normalizeLookup(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function mergeList(existing: string[] | undefined, incoming: string[] | undefined): string[] {
  return uniqueStrings([...(existing ?? []), ...(incoming ?? [])]);
}

function normalizeRequestedSlots(slots: z.infer<typeof modelRequestedSlotSchema>[]): SchedulerRequestedSlot[] {
  return slots
    .map((slot) => ({
      id: compactString(slot.id),
      searchMode: slot.searchMode ?? undefined,
      dayOfWeek: slot.dayOfWeek ?? undefined,
      date: normalizeDate(slot.date),
      startTime: normalizeTime(slot.startTime),
      endTime: normalizeTime(slot.endTime),
      durationMinutes: slot.durationMinutes ?? undefined,
    }))
    .filter((slot) => (
      slot.searchMode ||
      typeof slot.dayOfWeek === "number" ||
      slot.date ||
      slot.startTime ||
      slot.endTime ||
      slot.durationMinutes
    ));
}

function nullableFiltersToState(filters: ModelSchedulerExtraction["filters"]): SearchFilters {
  return {
    subject: compactString(filters.subject),
    curriculum: compactString(filters.curriculum),
    level: compactString(filters.level),
  };
}

function normalizeSubjectRequests(requests: ModelSchedulerExtraction["subjectRequests"]): SearchFilters[] {
  return requests
    .map(nullableFiltersToState)
    .filter((filters) => filters.subject || filters.curriculum || filters.level);
}

function normalizeDateRange(range: ModelSchedulerExtraction["dateRange"] | undefined): SchedulerDateRange | undefined {
  const startDate = normalizeDate(range?.startDate);
  const endDate = normalizeDate(range?.endDate);
  if (!startDate || !endDate || endDate < startDate) return undefined;
  return { startDate, endDate };
}

function canonicalSchedulerSubject(rawSubject: string | undefined, options: FilterOptions): string | undefined {
  const compacted = rawSubject?.trim();
  if (!compacted) return undefined;

  const exact = options.subjects.find((subject) => normalizeLookup(subject) === normalizeLookup(compacted));
  if (exact) return exact;
  return compacted;
}

function applySchedulerFilterAliases(filters: SearchFilters, options: FilterOptions): SearchFilters {
  const subject = canonicalSchedulerSubject(filters.subject, options);
  return {
    ...filters,
    subject,
  };
}

function recoverSchedulerFilters(input: {
  filters: SearchFilters;
  explicitUnknownFilters: string[];
  options: FilterOptions;
}): {
  filters: SearchFilters;
  academicLevelResolution?: AcademicLevelResolution;
  remainingUnknowns: string[];
} {
  const filters = applySchedulerFilterAliases(input.filters, input.options);
  const remainingUnknowns: string[] = [];

  for (const unknown of input.explicitUnknownFilters) {
    const subject = canonicalSchedulerSubject(unknown, input.options);
    if (!filters.subject && subject && subject !== unknown) {
      filters.subject = subject;
      continue;
    }
    remainingUnknowns.push(unknown);
  }

  const recovered = recoverFiltersFromUnknowns({
    filters,
    explicitUnknownFilters: remainingUnknowns,
    options: input.options,
  });

  return {
    ...recovered,
    filters: applySchedulerFilterAliases(recovered.filters, input.options),
  };
}

const ENGLISH_FAMILY_SUBJECTS = ["EFL", "ESL", "Literature", "EnglishVR"];

function schedulerIntentText(state: SchedulerExtractedState): string {
  return [
    state.filters?.subject,
    state.filters?.level,
    state.parentRequestSummary,
    ...(state.explicitUnknownFilters ?? []),
    ...(state.assumptions ?? []),
  ].filter(Boolean).join(" ");
}

function stateWithSchedulerSourceText(
  state: SchedulerExtractedState,
  sourceText: string | undefined,
): SchedulerExtractedState {
  const compactedSourceText = compactString(sourceText);
  if (!compactedSourceText) return state;
  const summary = compactString(state.parentRequestSummary);
  if (summary && normalizeLookup(summary).includes(normalizeLookup(compactedSourceText))) return state;
  return {
    ...state,
    parentRequestSummary: [summary, compactedSourceText].filter(Boolean).join("\n"),
  };
}

function inferRawLevelFromText(text: string): string | undefined {
  const year = text.match(/\b(?:y|year)\s*(\d{1,2})\b/i);
  if (year) return `Y${Number(year[1])}`;
  const plus = text.match(/\b(11|13|16)\s*\+/);
  if (plus?.[1] === "11" || plus?.[1] === "13") return "11+/13+";
  if (plus?.[1] === "16") return "16+";
  return undefined;
}

function mentionsEnglishFamily(text: string): boolean {
  const normalized = normalizeLookup(text);
  return /\b(?:english|eng|writing|literature|efl|esl)\b/i.test(text) ||
    normalized.includes("วิชา writing");
}

function mentionsExamEnglish(text: string, level: string | undefined): boolean {
  const normalized = normalizeLookup(text);
  return level === "11+/13+" ||
    level === "16+" ||
    normalized.includes("englishvr") ||
    normalized.includes("nonvr") ||
    normalized.includes("11+") ||
    normalized.includes("13+") ||
    normalized.includes("16+") ||
    normalized.includes("entrance") ||
    normalized.includes("exam prep");
}

function activeSubjectsForLevel(input: {
  index: SearchIndex;
  subjects: string[];
  level?: string;
  curriculum?: string;
}): string[] {
  const wanted = new Set(input.subjects.map(normalizeLookup));
  const seen = new Set<string>();
  const active = new Set<string>();
  for (const group of input.index.tutorGroups) {
    for (const qualification of group.qualifications) {
      if (!wanted.has(normalizeLookup(qualification.subject))) continue;
      if (input.level && normalizeLookup(qualification.level) !== normalizeLookup(input.level)) continue;
      if (input.curriculum && normalizeLookup(qualification.curriculum) !== normalizeLookup(input.curriculum)) continue;
      const key = normalizeLookup(qualification.subject);
      if (seen.has(key)) continue;
      seen.add(key);
      active.add(qualification.subject);
    }
  }
  return input.subjects
    .map((subject) => [...active].find((activeSubject) => normalizeLookup(activeSubject) === normalizeLookup(subject)))
    .filter((subject): subject is string => Boolean(subject));
}

function buildEnglishSubjectIntent(input: {
  state: SchedulerExtractedState;
  filters: SearchFilters;
  index: SearchIndex;
  options: FilterOptions;
}): SchedulerSubjectIntent | undefined {
  const text = schedulerIntentText(input.state);
  if (!mentionsEnglishFamily(text)) return undefined;

  const levelResolution = resolveAcademicFilters({ level: input.filters.level }, input.options);
  const level = levelResolution.filters.level ?? input.filters.level;
  const curriculum = input.filters.curriculum ?? (
    level === "Y2-8" || level === "Y9-11" || level === "Y12-13" ? "International" : undefined
  );
  const skillTags = normalizeLookup(text).includes("writing") ? ["writing"] : [];

  if (mentionsExamEnglish(text, level)) {
    const englishVr = activeSubjectsForLevel({
      index: input.index,
      subjects: ["EnglishVR"],
      level,
    });
    if (englishVr.length === 0) return undefined;
    return {
      family: "english",
      label: "English exam-prep",
      canonicalSubjects: englishVr,
      skillTags,
      curriculum: input.filters.curriculum,
      level,
      source: "deterministic",
    };
  }

  const canonicalSubjects = activeSubjectsForLevel({
    index: input.index,
    subjects: ENGLISH_FAMILY_SUBJECTS,
    level,
    curriculum,
  });
  if (canonicalSubjects.length === 0) return undefined;
  return {
    family: "english",
    label: "English-family",
    canonicalSubjects,
    skillTags,
    curriculum,
    level,
    source: "deterministic",
  };
}

function applyDeterministicSchedulerIntent(input: {
  state: SchedulerResolvedState;
  index: SearchIndex;
  options: FilterOptions;
}): SchedulerResolvedState {
  const text = schedulerIntentText(input.state);
  const inferredLevel = input.state.filters.level ?? inferRawLevelFromText(text);
  const provisionalFilters = {
    ...input.state.filters,
    level: inferredLevel,
  };
  const provisionalLevel = resolveAcademicFilters({ level: inferredLevel }, input.options).filters.level ?? inferredLevel;
  const provisionalCurriculum = provisionalFilters.curriculum ?? (
    provisionalLevel === "Y2-8" || provisionalLevel === "Y9-11" || provisionalLevel === "Y12-13" ? "International" : undefined
  );
  const subjectIntent = buildEnglishSubjectIntent({
    state: { ...input.state, filters: { ...provisionalFilters, curriculum: provisionalCurriculum } },
    filters: { ...provisionalFilters, curriculum: provisionalCurriculum },
    index: input.index,
    options: input.options,
  }) ?? input.state.subjectIntent;

  if (!subjectIntent || subjectIntent.canonicalSubjects.length === 0) {
    return {
      ...input.state,
      filters: provisionalFilters,
    };
  }

  const subjectRequests = subjectIntent.canonicalSubjects.map((subject) => ({
    subject,
    curriculum: subjectIntent.curriculum,
    level: subjectIntent.level,
  }));
  const existingNonEnglishSubjectRequests = (input.state.subjectRequests ?? [])
    .filter((request) => !mentionsEnglishFamily(request.subject ?? ""));

  return {
    ...input.state,
    subjectIntent,
    filters: {
      ...input.state.filters,
      subject: subjectRequests[0]?.subject,
      curriculum: subjectIntent.curriculum ?? input.state.filters.curriculum,
      level: subjectIntent.level ?? input.state.filters.level ?? inferredLevel,
    },
    subjectRequests: mergeSubjectRequests(undefined, [...subjectRequests, ...existingNonEnglishSubjectRequests]),
    explicitUnknownFilters: (input.state.explicitUnknownFilters ?? []).filter((unknown) => !mentionsEnglishFamily(unknown)),
  };
}

function businessRequirementsToState(
  businessRequirements: ModelSchedulerExtraction["businessRequirements"] | undefined,
): SchedulerBusinessRequirements {
  return {
    englishProficiency: businessRequirements?.englishProficiency ?? undefined,
    youngLearnerAge: businessRequirements?.youngLearnerAge ?? undefined,
    strengthTags: uniqueStrings(businessRequirements?.strengthTags ?? []),
    curriculumExperience: uniqueStrings(businessRequirements?.curriculumExperience ?? []),
    teachingStyleTags: uniqueStrings(businessRequirements?.teachingStyleTags ?? []),
    schoolKeywords: uniqueStrings(businessRequirements?.schoolKeywords ?? []),
  };
}

function mergeBusinessRequirements(
  existing: SchedulerBusinessRequirements | undefined,
  incoming: SchedulerBusinessRequirements | undefined,
): SchedulerBusinessRequirements {
  return {
    englishProficiency: incoming?.englishProficiency ?? existing?.englishProficiency,
    youngLearnerAge: incoming?.youngLearnerAge ?? existing?.youngLearnerAge,
    strengthTags: mergeList(existing?.strengthTags, incoming?.strengthTags),
    curriculumExperience: mergeList(existing?.curriculumExperience, incoming?.curriculumExperience),
    teachingStyleTags: mergeList(existing?.teachingStyleTags, incoming?.teachingStyleTags),
    schoolKeywords: mergeList(existing?.schoolKeywords, incoming?.schoolKeywords),
  };
}

export function normalizeSchedulerExtraction(raw: unknown): {
  state: SchedulerExtractedState;
  title?: string;
} {
  const parsed = modelSchedulerExtractionSchema.parse(raw);
  return {
    state: {
      searchMode: parsed.searchMode ?? undefined,
      dayOfWeek: parsed.dayOfWeek ?? undefined,
      date: normalizeDate(parsed.date),
      startTime: normalizeTime(parsed.startTime),
      endTime: normalizeTime(parsed.endTime),
      durationMinutes: parsed.durationMinutes ?? undefined,
      mode: parsed.mode ?? undefined,
      filters: nullableFiltersToState(parsed.filters),
      subjectRequests: normalizeSubjectRequests(parsed.subjectRequests),
      businessRequirements: businessRequirementsToState(parsed.businessRequirements),
      dateRange: normalizeDateRange(parsed.dateRange),
      requestedSlots: normalizeRequestedSlots(parsed.requestedSlots),
      explicitUnknownFilters: uniqueStrings(parsed.explicitUnknownFilters),
      explicitUnknownBusinessRequirements: uniqueStrings(parsed.explicitUnknownBusinessRequirements),
      tutorNames: uniqueStrings(parsed.tutorNames),
      tutorExclusions: uniqueStrings(parsed.tutorExclusions),
      parentName: compactString(parsed.parentName),
      studentName: compactString(parsed.studentName),
      contact: compactString(parsed.contact),
      negativeFeedback: parsed.negativeFeedback,
      assumptions: uniqueStrings(parsed.assumptions),
      unresolvedQuestions: uniqueStrings(parsed.unresolvedQuestions),
      parentRequestSummary: compactString(parsed.parentRequestSummary),
    },
    title: compactString(parsed.title),
  };
}

function slotKey(slot: SchedulerRequestedSlot): string {
  return [
    slot.searchMode ?? "",
    slot.dayOfWeek ?? "",
    slot.date ?? "",
    slot.startTime ?? "",
    slot.endTime ?? "",
  ].join(":");
}

function differs(existing: string | undefined, incoming: string | undefined): boolean {
  return Boolean(existing && incoming && normalizeLookup(existing) !== normalizeLookup(incoming));
}

function filtersKey(filters: SearchFilters | undefined): string {
  return [
    filters?.subject ?? "",
    filters?.curriculum ?? "",
    filters?.level ?? "",
  ].map(normalizeLookup).join(":");
}

function mergeSubjectRequests(existing: SearchFilters[] | undefined, incoming: SearchFilters[] | undefined): SearchFilters[] {
  const source = incoming?.length ? incoming : existing ?? [];
  const seen = new Set<string>();
  const result: SearchFilters[] = [];
  for (const filters of source) {
    const key = filtersKey(filters);
    if (!key.replace(/:/g, "")) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(filters);
  }
  return result;
}

function isIndependentSchedulingRequest(
  existing: SchedulerExtractedState | null | undefined,
  incoming: SchedulerExtractedState,
): boolean {
  if (!existing) return false;
  if (differs(existing.studentName, incoming.studentName)) return true;
  if (differs(existing.filters?.subject, incoming.filters?.subject)) return true;
  if (incoming.requestedSlots && incoming.requestedSlots.length > 0) {
    const existingSlots = existing.requestedSlots ?? [];
    if (existingSlots.length > 0) {
      const incomingKey = incoming.requestedSlots.map(slotKey).join("|");
      const existingKey = existingSlots.map(slotKey).join("|");
      if (incomingKey && existingKey && incomingKey !== existingKey) return true;
    }
  }
  return false;
}

export function mergeSchedulerState(
  existing: SchedulerExtractedState | null | undefined,
  incoming: SchedulerExtractedState,
): SchedulerExtractedState {
  if (isIndependentSchedulingRequest(existing, incoming)) {
    return {
      ...incoming,
      parentName: incoming.parentName ?? existing?.parentName,
      contact: incoming.contact ?? existing?.contact,
      subjectRequests: incoming.subjectRequests ?? [],
      dateRange: incoming.dateRange,
      requestedSlots: incoming.requestedSlots ?? [],
      explicitUnknownFilters: incoming.explicitUnknownFilters ?? [],
      explicitUnknownBusinessRequirements: incoming.explicitUnknownBusinessRequirements ?? [],
      businessRequirements: incoming.businessRequirements ?? {},
      tutorNames: incoming.tutorNames ?? [],
      tutorExclusions: incoming.tutorExclusions ?? [],
      assumptions: incoming.assumptions ?? [],
      unresolvedQuestions: incoming.unresolvedQuestions ?? [],
    };
  }

  const merged: SchedulerExtractedState = {
    ...existing,
    ...incoming,
    filters: {
      ...(existing?.filters ?? {}),
      ...(incoming.filters ?? {}),
    },
    subjectRequests: mergeSubjectRequests(existing?.subjectRequests, incoming.subjectRequests),
    dateRange: incoming.dateRange ?? existing?.dateRange,
    businessRequirements: mergeBusinessRequirements(existing?.businessRequirements, incoming.businessRequirements),
    requestedSlots: incoming.requestedSlots?.length ? incoming.requestedSlots : existing?.requestedSlots,
    explicitUnknownFilters: mergeList(existing?.explicitUnknownFilters, incoming.explicitUnknownFilters),
    explicitUnknownBusinessRequirements: mergeList(existing?.explicitUnknownBusinessRequirements, incoming.explicitUnknownBusinessRequirements),
    tutorNames: mergeList(existing?.tutorNames, incoming.tutorNames),
    tutorExclusions: mergeList(existing?.tutorExclusions, incoming.tutorExclusions),
    assumptions: mergeList(existing?.assumptions, incoming.assumptions),
    unresolvedQuestions: pruneStaleQuestions(
      mergeList(existing?.unresolvedQuestions, incoming.unresolvedQuestions),
      {
        ...existing,
        ...incoming,
        requestedSlots: incoming.requestedSlots?.length ? incoming.requestedSlots : existing?.requestedSlots,
        dateRange: incoming.dateRange ?? existing?.dateRange,
        subjectRequests: mergeSubjectRequests(existing?.subjectRequests, incoming.subjectRequests),
      },
    ),
  };

  if (merged.searchMode === "one_time") {
    delete merged.dayOfWeek;
  }
  if (merged.searchMode === "recurring") {
    delete merged.date;
  }

  return merged;
}

function pruneStaleQuestions(questions: string[], state: SchedulerExtractedState): string[] {
  const hasCompleteSlots = (state.requestedSlots ?? []).some((slot) => (
    slot.startTime &&
    slot.endTime &&
    (typeof slot.dayOfWeek === "number" || slot.date)
  )) || Boolean(
    state.startTime &&
    state.endTime &&
    (typeof state.dayOfWeek === "number" || state.date),
  );
  const hasDateRange = Boolean(state.dateRange?.startDate && state.dateRange?.endDate);
  const hasMultipleSubjects = (state.subjectRequests ?? []).length > 1;

  return questions.filter((question) => {
    const normalized = normalizeLookup(question);
    if ((hasCompleteSlots || hasDateRange) && (
      normalized.includes("which weekday or exact date") ||
      normalized.includes("which day/time") ||
      normalized.includes("what exact day/time") ||
      normalized.includes("what start time should i search") ||
      normalized.includes("could not safely structure")
    )) {
      return false;
    }
    if (hasMultipleSubjects && (
      normalized.includes("all 3 subjects") ||
      normalized.includes("all three subjects") ||
      normalized.includes("separate tutors by subject")
    )) {
      return false;
    }
    return true;
  });
}

function addMinutes(time: string, minutes: number): string | undefined {
  const start = parseTimeToMinutes(time);
  const end = start + minutes;
  if (end <= start || end > 24 * 60) return undefined;
  return formatMinute(end);
}

function resolveRequestedSlot(
  slot: SchedulerRequestedSlot,
  fallback: {
    searchMode: SchedulerSearchMode;
    durationMinutes: SchedulerDuration;
    assumptions: string[];
  },
  index: number,
): SchedulerRequestedSlot | null {
  const searchMode = slot.searchMode ?? (slot.date ? "one_time" : typeof slot.dayOfWeek === "number" ? "recurring" : fallback.searchMode);
  const durationMinutes = slot.durationMinutes ?? fallback.durationMinutes;
  const startTime = normalizeTime(slot.startTime);
  const endTime = normalizeTime(slot.endTime) ?? (startTime ? addMinutes(startTime, durationMinutes) : undefined);
  if (!startTime || !endTime) return null;
  if (parseTimeToMinutes(endTime) <= parseTimeToMinutes(startTime)) return null;
  if (searchMode === "recurring" && typeof slot.dayOfWeek !== "number") return null;
  if (searchMode === "one_time" && !slot.date) return null;
  if (!slot.endTime && endTime) {
    fallback.assumptions.push(`Slot ${index + 1}: end time was derived from start time plus ${durationMinutes} minutes.`);
  }

  return {
    id: slot.id ?? `requested-${index + 1}`,
    searchMode,
    dayOfWeek: searchMode === "recurring" ? slot.dayOfWeek : undefined,
    date: searchMode === "one_time" ? slot.date : undefined,
    startTime,
    endTime,
    durationMinutes,
  };
}

function parseProseTimeRange(text: string): { startTime: string; endTime: string } | undefined {
  const toMinute = (rawHour: string, rawMinute: string | undefined, suffix: string | undefined) => {
    let hour = Number(rawHour);
    const minute = Number(rawMinute ?? 0);
    const normalizedSuffix = suffix?.toLowerCase();
    if (normalizedSuffix === "pm" && hour < 12) hour += 12;
    if (normalizedSuffix === "am" && hour === 12) hour = 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
  };

  const pattern = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|\bto\b|\band\b|ถึง|และ)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi;
  for (const match of text.matchAll(pattern)) {
    if (!match[2] && !match[3] && !match[5] && !match[6]) continue;
    const startMinute = toMinute(match[1], match[2], match[3]);
    let endMinute = toMinute(match[4], match[5], match[6]);
    if (startMinute === null || endMinute === null) continue;
    if (!match[6] && match[3]?.toLowerCase() === "pm" && endMinute < 12 * 60) {
      endMinute += 12 * 60;
    }
    if (endMinute <= startMinute && !match[6] && endMinute < 12 * 60) {
      endMinute += 12 * 60;
    }
    if (endMinute <= startMinute || endMinute > 24 * 60) continue;
    return { startTime: formatMinute(startMinute), endTime: formatMinute(endMinute) };
  }
  return undefined;
}

function recoverAllWeekRequestedSlotsFromText(
  state: SchedulerExtractedState,
  durationMinutes: SchedulerDuration,
  assumptions: string[],
): SchedulerRequestedSlot[] {
  const text = [
    state.parentRequestSummary,
    ...(state.assumptions ?? []),
  ].filter(Boolean).join(" ");
  if (!text) return [];
  const normalized = normalizeLookup(text);
  const allWeek = /\bmon(?:day)?\s*(?:-|–|—|\bto\b|\bthrough\b)\s*sun(?:day)?\b/i.test(text) ||
    normalized.includes("monday through sunday") ||
    normalized.includes("mon-sun");
  if (!allWeek) return [];
  const timeRange = parseProseTimeRange(text);
  if (!timeRange) return [];
  assumptions.push("Mon-Sun prose time range was recovered into structured recurring weekday slots.");
  return [1, 2, 3, 4, 5, 6, 0].map((dayOfWeek, index) => ({
    id: `requested-${index + 1}`,
    searchMode: "recurring",
    dayOfWeek,
    startTime: timeRange.startTime,
    endTime: timeRange.endTime,
    durationMinutes,
  }));
}

function recoverDateRangeRequestedSlotsFromText(
  state: SchedulerExtractedState,
  durationMinutes: SchedulerDuration,
  assumptions: string[],
): SchedulerRequestedSlot[] {
  if (!state.dateRange) return [];
  const text = [
    state.parentRequestSummary,
    ...(state.assumptions ?? []),
  ].filter(Boolean).join(" ");
  if (!text) return [];
  const timeRange = parseProseTimeRange(text);
  if (!timeRange) return [];
  assumptions.push("Date-range prose time range was recovered into structured one-time slots.");
  return isoDatesInRange(state.dateRange).map((date, index) => ({
    id: `requested-${index + 1}`,
    searchMode: "one_time",
    date,
    startTime: timeRange.startTime,
    endTime: timeRange.endTime,
    durationMinutes,
  }));
}

function resolveRequestedSlots(
  state: SchedulerExtractedState,
  searchMode: SchedulerSearchMode,
  durationMinutes: SchedulerDuration,
  assumptions: string[],
): SchedulerRequestedSlot[] {
  const resolved = (state.requestedSlots ?? [])
    .map((slot, index) => resolveRequestedSlot(slot, { searchMode, durationMinutes, assumptions }, index))
    .filter((slot): slot is SchedulerRequestedSlot => Boolean(slot));

  const recoveredAllWeekSlots = recoverAllWeekRequestedSlotsFromText(state, durationMinutes, assumptions);
  if (recoveredAllWeekSlots.length > 0) {
    const resolvedIsRecurringAllWeek = resolved.length >= recoveredAllWeekSlots.length &&
      resolved.every((slot) => slot.searchMode === "recurring" && typeof slot.dayOfWeek === "number");
    if (!resolvedIsRecurringAllWeek) return recoveredAllWeekSlots;
  }
  if (resolved.length > 0) return resolved;
  const recoveredDateRangeSlots = recoverDateRangeRequestedSlotsFromText(state, durationMinutes, assumptions);
  if (recoveredDateRangeSlots.length > 0) return recoveredDateRangeSlots;
  if (!state.startTime) return [];
  if (typeof state.dayOfWeek !== "number" && !state.date) return [];

  const scalarSlot = resolveRequestedSlot({
    searchMode,
    dayOfWeek: state.dayOfWeek,
    date: state.date,
    startTime: state.startTime,
    endTime: state.endTime,
    durationMinutes,
  }, { searchMode, durationMinutes, assumptions }, 0);

  return scalarSlot ? [scalarSlot] : [];
}

const MONTH_NAME_TO_NUMBER: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const WEEKDAY_PATTERNS: Array<{ dayOfWeek: number; pattern: RegExp }> = [
  { dayOfWeek: 0, pattern: /\b(?:sun|sunday)\b|วันอาทิตย์/i },
  { dayOfWeek: 1, pattern: /\b(?:mon|monday)\b|วันจันทร์/i },
  { dayOfWeek: 2, pattern: /\b(?:tue|tues|tuesday)\b|วันอังคาร/i },
  { dayOfWeek: 3, pattern: /\b(?:wed|weds|wednesday)\b|วันพุธ/i },
  { dayOfWeek: 4, pattern: /\b(?:thu|thur|thurs|thursday)\b|วันพฤหัส/i },
  { dayOfWeek: 5, pattern: /\b(?:fri|friday)\b|วันศุกร์/i },
  { dayOfWeek: 6, pattern: /\b(?:sat|saturday)\b|วันเสาร์/i },
];

function inferWeekdayFromText(state: SchedulerExtractedState): number | undefined {
  const text = [
    state.parentRequestSummary,
    ...(state.assumptions ?? []),
  ].filter(Boolean).join(" ");
  if (!text) return undefined;
  return WEEKDAY_PATTERNS.find((entry) => entry.pattern.test(text))?.dayOfWeek;
}

function inferFirstWeekDateRange(state: SchedulerExtractedState): SchedulerDateRange | undefined {
  const text = [
    state.parentRequestSummary,
    ...(state.assumptions ?? []),
  ].filter(Boolean).join(" ");
  if (!text) return undefined;
  const normalized = normalizeLookup(text);
  const mentionsFirstWeek = /\bfirst\s+week\b/i.test(text) || normalized.includes("week แรก");
  if (!mentionsFirstWeek) return undefined;
  const monthEntry = Object.entries(MONTH_NAME_TO_NUMBER)
    .sort((a, b) => b[0].length - a[0].length)
    .find(([name]) => new RegExp(`\\b${name}\\b`, "i").test(text));
  if (!monthEntry) return undefined;
  const yearMatch = text.match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
  const month = monthEntry[1];
  const monthText = String(month).padStart(2, "0");
  return {
    startDate: `${year}-${monthText}-01`,
    endDate: `${year}-${monthText}-07`,
  };
}

export function resolveSchedulerState(state: SchedulerExtractedState): SchedulerResolvedState {
  const assumptions = [...(state.assumptions ?? [])];
  const unresolvedQuestions = [...(state.unresolvedQuestions ?? [])];
  let searchMode = state.searchMode;
  const dayOfWeek = typeof state.dayOfWeek === "number" ? state.dayOfWeek : inferWeekdayFromText(state);
  const dateRange = state.dateRange ?? inferFirstWeekDateRange(state);
  const stateWithInferredDay = { ...state, dayOfWeek };
  if (typeof dayOfWeek === "number" && typeof state.dayOfWeek !== "number") {
    assumptions.push(`${dayName(dayOfWeek)} was recovered from the request text.`);
  }
  if (dateRange && !state.dateRange) {
    assumptions.push(`First week date range was interpreted as ${dateRange.startDate} through ${dateRange.endDate}.`);
  }

  if (!searchMode && typeof dayOfWeek === "number") {
    searchMode = "recurring";
    assumptions.push("Bare weekday was treated as a recurring weekly request.");
  } else if (searchMode === "one_time" && !state.date && typeof dayOfWeek === "number") {
    searchMode = "recurring";
    assumptions.push("A weekday without an exact date cannot be a one-time search, so I treated it as recurring weekly.");
  } else if (!searchMode && state.date) {
    searchMode = "one_time";
  } else if (!searchMode) {
    searchMode = "recurring";
    assumptions.push("No exact date was provided, so I searched recurring weekly availability.");
  }

  if (!state.durationMinutes) {
    assumptions.push("Class duration was not specified, so I used the 60-minute institutional default.");
  }

  if (!state.mode) {
    assumptions.push("Delivery mode was not specified, so I considered both online and onsite options.");
  }

  return {
    ...stateWithInferredDay,
    searchMode,
    durationMinutes: state.durationMinutes ?? DEFAULT_CONVERSATIONAL_DURATION,
    mode: state.mode ?? DEFAULT_CONVERSATIONAL_MODE,
    filters: state.filters ?? {},
    subjectRequests: mergeSubjectRequests(undefined, state.subjectRequests),
    businessRequirements: state.businessRequirements ?? {},
    dateRange,
    requestedSlots: resolveRequestedSlots(
      stateWithInferredDay,
      searchMode,
      state.durationMinutes ?? DEFAULT_CONVERSATIONAL_DURATION,
      assumptions,
    ),
    explicitUnknownFilters: state.explicitUnknownFilters ?? [],
    explicitUnknownBusinessRequirements: state.explicitUnknownBusinessRequirements ?? [],
    tutorNames: state.tutorNames ?? [],
    tutorExclusions: state.tutorExclusions ?? [],
    negativeFeedback: state.negativeFeedback ?? false,
    assumptions: uniqueStrings(assumptions),
    unresolvedQuestions: uniqueStrings(pruneStaleQuestions(unresolvedQuestions, { ...stateWithInferredDay, dateRange })),
  };
}

export function filterOptionsFromIndex(index: SearchIndex): FilterOptions {
  const subjects = new Set<string>();
  const curriculums = new Set<string>();
  const levels = new Set<string>();
  for (const group of index.tutorGroups) {
    for (const q of group.qualifications) {
      subjects.add(q.subject);
      curriculums.add(q.curriculum);
      levels.add(q.level);
    }
  }
  return {
    subjects: [...subjects].sort(),
    curriculums: [...curriculums].sort(),
    levels: [...levels].sort(),
  };
}

export function tutorListFromIndex(index: SearchIndex): TutorListItem[] {
  return index.tutorGroups
    .map((group) => ({
      tutorGroupId: group.id,
      displayName: group.displayName,
      supportedModes: group.supportedModes,
      subjects: [...new Set(group.qualifications.map((q) => q.subject))].sort(),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function resolveSchedulerFilters(
  filters: SearchFilters,
  options: FilterOptions,
): ReturnType<typeof resolveAcademicFilters> {
  return resolveAcademicFilters(filters, options);
}

export function resolveSchedulerTutorNames(
  tutorNames: string[],
  tutorList: TutorListItem[],
  tutorExclusions: string[] = [],
): {
  matchedTutorIds: Set<string>;
  excludedTutorIds: Set<string>;
  questions: string[];
  warnings: string[];
} {
  const matchedTutorIds = new Set<string>();
  const excludedTutorIds = new Set<string>();
  const questions: string[] = [];
  const warnings: string[] = [];

  const resolveName = (rawName: string, intent: "include" | "exclude") => {
    const name = rawName.trim();
    if (!name) return;
    const normalized = normalizeLookup(name);
    let matches = tutorList.filter((tutor) => normalizeLookup(tutor.displayName) === normalized);
    if (matches.length === 0) {
      matches = tutorList.filter((tutor) => normalizeLookup(tutor.displayName).includes(normalized));
    }

    if (matches.length === 1) {
      if (intent === "include") matchedTutorIds.add(matches[0].tutorGroupId);
      else excludedTutorIds.add(matches[0].tutorGroupId);
    } else if (matches.length > 1) {
      questions.push(`Which ${name} did the parent mean: ${matches.slice(0, 5).map((t) => t.displayName).join(", ")}?`);
      warnings.push(`Tutor "${name}" was ambiguous, so I did not ${intent === "include" ? "restrict" : "exclude from"} the search yet.`);
    } else {
      questions.push(`Which tutor did the parent mean by "${name}"?`);
      warnings.push(`Tutor "${name}" did not match an active tutor, so I searched all tutors.`);
    }
  };

  for (const rawName of tutorNames) {
    resolveName(rawName, "include");
  }
  for (const rawName of tutorExclusions) {
    resolveName(rawName, "exclude");
  }

  return { matchedTutorIds, excludedTutorIds, questions, warnings };
}

function dayFloorMinute(weekday: number, hasExplicitTime: boolean): number {
  if (hasExplicitTime) return 0;
  return weekday >= 1 && weekday <= 5 ? 15 * 60 : 0;
}

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function pushSlot(
  slots: SchedulerCandidateSlot[],
  seen: Set<string>,
  input: {
    searchMode: SchedulerSearchMode;
    weekday: number;
    date?: string;
    startMinute: number;
    durationMinutes: SchedulerDuration;
    mode: SchedulerDeliveryMode;
  },
) {
  const endMinute = input.startMinute + input.durationMinutes;
  const start = formatMinute(input.startMinute);
  const end = formatMinute(endMinute);
  const key = `${input.searchMode}:${input.date ?? input.weekday}:${start}:${end}:${input.mode}`;
  if (seen.has(key)) return;
  seen.add(key);
  slots.push({
    id: `assistant-${slots.length}`,
    searchMode: input.searchMode,
    dayOfWeek: input.searchMode === "recurring" ? input.weekday : undefined,
    date: input.searchMode === "one_time" ? input.date : undefined,
    start,
    end,
    durationMinutes: input.durationMinutes,
    mode: input.mode,
  });
}

export function generateSchedulerCandidateSlots(
  index: SearchIndex,
  state: SchedulerResolvedState,
): {
  slots: SchedulerCandidateSlot[];
  warnings: string[];
} {
  const slots: SchedulerCandidateSlot[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const explicitStart = state.startTime ? parseTimeToMinutes(state.startTime) : null;
  const explicitEnd = state.endTime ? parseTimeToMinutes(state.endTime) : null;
  const hasExplicitTime = explicitStart !== null || explicitEnd !== null;
  const duration = state.durationMinutes;

  if (state.requestedSlots.length > 0) {
    for (const requested of state.requestedSlots) {
      if (!requested.startTime || !requested.endTime || !requested.searchMode) continue;
      const weekday = requested.searchMode === "one_time" && requested.date
        ? weekdayForIsoDate(requested.date)
        : requested.dayOfWeek;
      if (typeof weekday !== "number") continue;
      const durationMinutes = requested.durationMinutes ?? state.durationMinutes;
      const startMinute = parseTimeToMinutes(requested.startTime);
      const endMinute = parseTimeToMinutes(requested.endTime);
      if (endMinute - startMinute < durationMinutes) {
        warnings.push(`Requested slot ${requested.id ?? slots.length + 1} is shorter than ${durationMinutes} minutes.`);
        continue;
      }

      const baseSlotId = requested.id ?? `requested-${slots.length + 1}`;
      for (let cursor = startMinute; cursor + durationMinutes <= endMinute; cursor += 30) {
        const start = formatMinute(cursor);
        const end = formatMinute(cursor + durationMinutes);
        const key = `${requested.searchMode}:${requested.date ?? weekday}:${start}:${end}:${state.mode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({
          id: cursor === startMinute && cursor + durationMinutes === endMinute
            ? baseSlotId
            : `${baseSlotId}-${start.replace(":", "")}`,
          requestedSlotId: baseSlotId,
          searchMode: requested.searchMode,
          dayOfWeek: requested.searchMode === "recurring" ? weekday : undefined,
          date: requested.searchMode === "one_time" ? requested.date : undefined,
          start,
          end,
          durationMinutes,
          mode: state.mode,
        });
      }
    }
    if (slots.length === 0) {
      warnings.push("The requested slots were incomplete, so I could not safely search them.");
    }
    return { slots, warnings };
  }

  const targetWeekdays = state.searchMode === "one_time" && state.date
    ? [weekdayForIsoDate(state.date)]
    : typeof state.dayOfWeek === "number"
      ? [state.dayOfWeek]
      : [1, 2, 3, 4, 5, 6, 0];

  if (state.searchMode === "one_time" && !state.date) {
    warnings.push("No exact date was available, so I searched recurring weekly availability instead.");
  }

  for (const weekday of targetWeekdays) {
    const windows = index.tutorGroups.flatMap((group) => group.availabilityWindows.filter((w) => w.weekday === weekday));
    for (const window of windows) {
      if (state.mode !== "either" && window.modality !== "both" && window.modality !== state.mode) continue;
      const floor = dayFloorMinute(weekday, hasExplicitTime);
      const lower = Math.max(window.startMinute, floor, explicitStart ?? 0);
      const upper = Math.min(window.endMinute, explicitEnd ?? 24 * 60);
      if (upper - lower < duration) continue;

      const firstStart = Math.ceil(lower / 30) * 30;
      for (let cursor = firstStart; cursor + duration <= upper; cursor += 30) {
        pushSlot(slots, seen, {
          searchMode: state.searchMode === "one_time" && state.date ? "one_time" : "recurring",
          weekday,
          date: state.date,
          startMinute: cursor,
          durationMinutes: duration,
          mode: state.mode,
        });
      }
    }
  }

  if (slots.length === 0) {
    warnings.push("No candidate slots could be generated from the current Wise availability windows.");
  }

  slots.sort((a, b) => {
    const aDay = a.dayOfWeek ?? (a.date ? weekdayForIsoDate(a.date) : 0);
    const bDay = b.dayOfWeek ?? (b.date ? weekdayForIsoDate(b.date) : 0);
    const dayOrder = (day: number) => (day === 0 ? 7 : day);
    return dayOrder(aDay) - dayOrder(bDay) || a.start.localeCompare(b.start);
  });

  return { slots, warnings };
}

function slotBlockedByProposalHold(
  hold: ProposalHoldSummary,
  tutor: TutorResult,
  slot: { dayOfWeek?: number; date?: string; start: string; end: string },
  searchMode: SchedulerSearchMode,
): boolean {
  const weekday = searchMode === "recurring"
    ? slot.dayOfWeek
    : slot.date
      ? weekdayForIsoDate(slot.date)
      : undefined;
  if (weekday === undefined) return false;
  return hold.tutorCanonicalKey === tutor.tutorCanonicalKey &&
    proposalHoldBlocksSearchSlot(hold, {
      searchMode,
      weekday,
      date: slot.date,
      startMinute: parseTimeToMinutes(slot.start),
      endMinute: parseTimeToMinutes(slot.end),
    });
}

function groupHasDataIssue(group: IndexedTutorGroup, tutorGroupId: string): boolean {
  return group.id === tutorGroupId && group.dataIssues.length > 0;
}

const ENGLISH_PROFICIENCY_RANK: Record<SchedulerEnglishProficiency, number> = {
  unknown: 0,
  basic: 1,
  conversational: 2,
  fluent: 3,
  "near-native": 4,
  native: 5,
};

function normalizeRequirement(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function hasBusinessRequirements(requirements: SchedulerBusinessRequirements): boolean {
  return Boolean(
    requirements.englishProficiency && requirements.englishProficiency !== "unknown" ||
    requirements.youngLearnerAge ||
    requirements.strengthTags?.length ||
    requirements.curriculumExperience?.length ||
    requirements.schoolKeywords?.length
  );
}

function includesAll(profileValues: string[] | undefined, requiredValues: string[] | undefined): boolean {
  const profileSet = new Set((profileValues ?? []).map(normalizeRequirement));
  return (requiredValues ?? []).every((value) => profileSet.has(normalizeRequirement(value)));
}

function educationMatchesKeywords(group: IndexedTutorGroup, keywords: string[] | undefined): boolean {
  if (!keywords?.length) return true;
  const education = group.businessProfile?.education ?? [];
  if (education.length === 0) return false;
  const haystack = education
    .map((entry) => [
      entry.institution,
      entry.country,
      entry.program,
      entry.notes,
    ].filter(Boolean).join(" "))
    .join(" ")
    .toLowerCase();
  return keywords.every((keyword) => haystack.includes(normalizeRequirement(keyword)));
}

function matchesBusinessRequirements(
  group: IndexedTutorGroup,
  requirements: SchedulerBusinessRequirements,
): boolean {
  if (!hasBusinessRequirements(requirements)) return true;
  const profile = group.businessProfile;
  if (!profile) return false;

  if (requirements.englishProficiency && requirements.englishProficiency !== "unknown") {
    const profileRank = ENGLISH_PROFICIENCY_RANK[profile.englishProficiency] ?? 0;
    const requiredRank = ENGLISH_PROFICIENCY_RANK[requirements.englishProficiency] ?? 0;
    if (profileRank < requiredRank) return false;
  }

  if (requirements.youngLearnerAge) {
    if (profile.youngLearnerFit !== "comfortable") return false;
    if (profile.youngestComfortableAge === null) return false;
    if (profile.youngestComfortableAge > requirements.youngLearnerAge) return false;
  }

  if (!includesAll(profile.strengthTags, requirements.strengthTags)) return false;
  if (!includesAll(profile.curriculumExperience, requirements.curriculumExperience)) return false;
  if (!educationMatchesKeywords(group, requirements.schoolKeywords)) return false;
  return true;
}

function teachingStyleScore(
  group: IndexedTutorGroup,
  requirements: SchedulerBusinessRequirements,
): number {
  const requested = requirements.teachingStyleTags ?? [];
  if (requested.length === 0) return 0;
  const profileTags = new Set((group.businessProfile?.teachingStyleTags ?? []).map(normalizeRequirement));
  return requested.reduce((score, tag) => (
    profileTags.has(normalizeRequirement(tag)) ? score + 1 : score
  ), 0);
}

function suggestionDayScore(slot: { dayOfWeek?: number; date?: string }): number {
  const day = slot.dayOfWeek ?? (slot.date ? weekdayForIsoDate(slot.date) : 0);
  return day === 0 ? 7 : day;
}

function buildReasons(
  tutors: SchedulerSuggestionTutor[],
  parentReady: boolean,
  teachingStyleTags: string[] | undefined,
): string[] {
  const reasons = [`${tutors.length} proven available tutor${tutors.length === 1 ? "" : "s"}`];
  const modes = new Set(tutors.flatMap((tutor) => tutor.supportedModes));
  if (modes.has("online") && modes.has("onsite")) reasons.push("Online and onsite choices");
  else if (modes.has("online")) reasons.push("Online options");
  else if (modes.has("onsite")) reasons.push("Onsite options");
  if (teachingStyleTags?.length) reasons.push("Teaching style preference considered");
  if (!parentReady) reasons.push("Needs clarification before sending to parent");
  return reasons;
}

export function runSchedulerSearch(input: {
  index: SearchIndex;
  state: SchedulerResolvedState;
  activeProposalHolds: ProposalHoldSummary[];
  matchedTutorIds?: Set<string>;
  excludedTutorIds?: Set<string>;
  parentReady: boolean;
}): {
  suggestions: SchedulerSuggestion[];
  snapshotMeta: SnapshotMeta;
  warnings: string[];
} {
  const generated = generateSchedulerCandidateSlots(input.index, input.state);
  const warnings = [...generated.warnings];
  if (generated.slots.length === 0) {
    return {
      suggestions: [],
      snapshotMeta: {
        snapshotId: input.index.snapshotId,
        syncedAt: input.index.syncedAt.toISOString(),
        stale: false,
      },
      warnings,
    };
	  }

  const searches = generated.slots.map((slot) => ({
    slot,
    response: executeSearch(input.index, {
      searchMode: slot.searchMode,
      slots: [slot],
      filters: input.state.filters,
    }),
  }));
  for (const { response } of searches) {
    warnings.push(...response.warnings);
  }
  const snapshotMeta = searches[0]?.response.snapshotMeta ?? {
    snapshotId: input.index.snapshotId,
    syncedAt: input.index.syncedAt.toISOString(),
    stale: false,
  };

  const groupById = new Map(input.index.tutorGroups.map((group) => [group.id, group]));
  const businessContextRequired = hasBusinessRequirements(input.state.businessRequirements);
  let businessFilteredCount = 0;
  const entries = searches
    .map(({ slot, response }) => {
      const result = response.perSlotResults[0];
      const tutors = result.available
        .filter((tutor) => {
          if (input.matchedTutorIds && input.matchedTutorIds.size > 0 && !input.matchedTutorIds.has(tutor.tutorGroupId)) {
            return false;
          }
          if (input.excludedTutorIds?.has(tutor.tutorGroupId)) {
            return false;
          }
          const group = groupById.get(tutor.tutorGroupId);
          if (!group || groupHasDataIssue(group, tutor.tutorGroupId)) return false;
          if (!matchesBusinessRequirements(group, input.state.businessRequirements)) {
            businessFilteredCount += 1;
            return false;
          }
          return !input.activeProposalHolds.some((hold) => slotBlockedByProposalHold(hold, tutor, slot, slot.searchMode));
        })
        .map((tutor) => ({
          tutorGroupId: tutor.tutorGroupId,
          displayName: tutor.displayName,
          supportedModes: tutor.supportedModes,
          styleScore: teachingStyleScore(groupById.get(tutor.tutorGroupId)!, input.state.businessRequirements),
        }))
        .sort((a, b) => (
          b.styleScore - a.styleScore ||
          a.displayName.localeCompare(b.displayName)
        ))
        .map((tutor) => ({
          tutorGroupId: tutor.tutorGroupId,
          displayName: tutor.displayName,
          supportedModes: tutor.supportedModes,
        }));

      return {
        slot,
        tutors,
        styleScore: tutors.reduce((score, tutor) => (
          score + teachingStyleScore(groupById.get(tutor.tutorGroupId)!, input.state.businessRequirements)
        ), 0),
      };
    })
    .filter((entry) => entry.tutors.length > 0);

  const sortedEntries = input.state.requestedSlots.length > 0
    ? entries
    : entries.sort((a, b) => (
      b.styleScore - a.styleScore ||
      b.tutors.length - a.tutors.length ||
      suggestionDayScore(a.slot) - suggestionDayScore(b.slot) ||
      a.slot.start.localeCompare(b.slot.start)
    ));

  const suggestions = sortedEntries
    .slice(0, MAX_SCHEDULER_SUGGESTIONS)
    .map((entry, index) => {
      const confidence: SchedulerSuggestion["confidence"] =
        index === 0 ? "Best fit" : index < 3 ? "Strong fit" : "Good fit";
      return {
        id: `suggestion-${index + 1}`,
        rank: index + 1,
        searchMode: entry.slot.searchMode,
        dayOfWeek: entry.slot.dayOfWeek,
        date: entry.slot.date,
        start: entry.slot.start,
        end: entry.slot.end,
        durationMinutes: entry.slot.durationMinutes,
        mode: input.state.mode,
        confidence,
        tutors: entry.tutors.slice(0, 4),
        availableTutorCount: entry.tutors.length,
        reasons: buildReasons(entry.tutors, input.parentReady, input.state.businessRequirements.teachingStyleTags),
        parentReady: input.parentReady,
        requestedSlotId: input.state.requestedSlots.length > 0 ? entry.slot.requestedSlotId ?? entry.slot.id : undefined,
      };
    });

  if (suggestions.length === 0) {
    warnings.push("No proven available tutors were found after applying Wise data and active proposal holds.");
  }
  if (businessContextRequired && businessFilteredCount > 0 && suggestions.length === 0) {
    warnings.push("No tutors matched the verified tutor profile requirements.");
  }

  return { suggestions, snapshotMeta, warnings };
}

function isoDatesInRange(range: SchedulerDateRange): string[] {
  const dates: string[] = [];
  const start = new Date(`${range.startDate}T00:00:00.000Z`);
  const end = new Date(`${range.endDate}T00:00:00.000Z`);
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

function generateDateRangeAvailabilitySlots(
  index: SearchIndex,
  state: SchedulerResolvedState,
): SchedulerCandidateSlot[] {
  if (!state.dateRange) return [];
  const duration = state.durationMinutes;
  const explicitStart = state.startTime ? parseTimeToMinutes(state.startTime) : null;
  const explicitEnd = state.endTime ? parseTimeToMinutes(state.endTime) : null;
  const slots: SchedulerCandidateSlot[] = [];
  const seen = new Set<string>();

  for (const date of isoDatesInRange(state.dateRange)) {
    const weekday = weekdayForIsoDate(date);
    const windows = index.tutorGroups.flatMap((group) => group.availabilityWindows.filter((window) => window.weekday === weekday));
    for (const window of windows) {
      if (state.mode !== "either" && window.modality !== "both" && window.modality !== state.mode) continue;
      const lower = Math.max(window.startMinute, explicitStart ?? 0);
      const upper = Math.min(window.endMinute, explicitEnd ?? 24 * 60);
      if (upper - lower < duration) continue;
      const firstStart = Math.ceil(lower / 30) * 30;
      for (let cursor = firstStart; cursor + duration <= upper; cursor += 30) {
        const start = formatMinute(cursor);
        const end = formatMinute(cursor + duration);
        const key = `${date}:${start}:${end}:${state.mode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({
          id: `range-${slots.length + 1}`,
          searchMode: "one_time",
          date,
          start,
          end,
          durationMinutes: duration,
          mode: state.mode,
        });
      }
    }
  }

  return slots.sort((a, b) => (
    (a.date ?? "").localeCompare(b.date ?? "") ||
    a.start.localeCompare(b.start)
  ));
}

function searchFiltersForState(state: SchedulerResolvedState): SearchFilters[] {
  if (state.subjectIntent?.canonicalSubjects.length) {
    return state.subjectIntent.canonicalSubjects.map((subject) => ({
      subject,
      curriculum: state.subjectIntent?.curriculum ?? state.filters.curriculum,
      level: state.subjectIntent?.level ?? state.filters.level,
    }));
  }
  if (state.subjectRequests.length > 1) return state.subjectRequests;
  return [state.filters];
}

function buildDateRangeAvailabilitySummary(input: {
  index: SearchIndex;
  state: SchedulerResolvedState;
  activeProposalHolds: ProposalHoldSummary[];
  matchedTutorIds?: Set<string>;
  excludedTutorIds?: Set<string>;
}): {
  availabilitySummary?: SchedulerAvailabilitySummary;
  snapshotMeta: SnapshotMeta;
  warnings: string[];
} {
  const snapshotMeta = {
    snapshotId: input.index.snapshotId,
    syncedAt: input.index.syncedAt.toISOString(),
    stale: false,
  };
  if (!input.state.dateRange) {
    return { snapshotMeta, warnings: [] };
  }

  const slots = generateDateRangeAvailabilitySlots(input.index, input.state);
  const searchedFilters = searchFiltersForState(input.state);
  const warnings: string[] = [];
  const groupById = new Map(input.index.tutorGroups.map((group) => [group.id, group]));
  const tutorWindows = new Map<string, SchedulerAvailabilityTutorSummary & { windowKeys: Set<string>; matchedSubjectKeys: Set<string> }>();
  const reviewMap = new Map<string, SchedulerAvailabilityReviewSummary>();
  let businessFilteredCount = 0;

  for (const slot of slots) {
    for (const filters of searchedFilters) {
      const response = executeSearch(input.index, {
        searchMode: "one_time",
        slots: [slot],
        filters,
      });
      warnings.push(...response.warnings);
      const result = response.perSlotResults[0];

      for (const tutor of result.available) {
        if (input.matchedTutorIds && input.matchedTutorIds.size > 0 && !input.matchedTutorIds.has(tutor.tutorGroupId)) {
          continue;
        }
        if (input.excludedTutorIds?.has(tutor.tutorGroupId)) continue;
        const group = groupById.get(tutor.tutorGroupId);
        if (!group || groupHasDataIssue(group, tutor.tutorGroupId)) continue;
        if (!matchesBusinessRequirements(group, input.state.businessRequirements)) {
          businessFilteredCount += 1;
          continue;
        }
        if (input.activeProposalHolds.some((hold) => slotBlockedByProposalHold(hold, tutor, slot, "one_time"))) {
          continue;
        }

        const entry = tutorWindows.get(tutor.tutorGroupId) ?? {
          tutorGroupId: tutor.tutorGroupId,
          displayName: tutor.displayName,
          supportedModes: tutor.supportedModes,
          matchedSubjects: [],
          windows: [],
          windowKeys: new Set<string>(),
          matchedSubjectKeys: new Set<string>(),
        };
        const subject = filters.subject ?? "Any subject";
        const subjectKey = normalizeLookup(subject);
        if (!entry.matchedSubjectKeys.has(subjectKey)) {
          entry.matchedSubjectKeys.add(subjectKey);
          entry.matchedSubjects.push(subject);
        }
        const date = slot.date!;
        const windowKey = `${date}:${slot.start}:${slot.end}:${input.state.mode}`;
        if (!entry.windowKeys.has(windowKey)) {
          entry.windowKeys.add(windowKey);
          entry.windows.push({
            date,
            weekday: weekdayForIsoDate(date),
            start: slot.start,
            end: slot.end,
            mode: input.state.mode,
          });
        }
        tutorWindows.set(tutor.tutorGroupId, entry);
      }

      for (const tutor of result.needsReview) {
        if (input.matchedTutorIds && input.matchedTutorIds.size > 0 && !input.matchedTutorIds.has(tutor.tutorGroupId)) {
          continue;
        }
        if (input.excludedTutorIds?.has(tutor.tutorGroupId)) continue;
        const entry = reviewMap.get(tutor.tutorGroupId) ?? {
          tutorGroupId: tutor.tutorGroupId,
          displayName: tutor.displayName,
          reasons: [],
        };
        entry.reasons = uniqueStrings([...entry.reasons, ...tutor.reasons.map((reason) => `${filters.subject ?? "Subject"}: ${reason}`)]);
        reviewMap.set(tutor.tutorGroupId, entry);
      }
    }
  }

  const tutors = [...tutorWindows.values()]
    .map((entry) => ({
      tutorGroupId: entry.tutorGroupId,
      displayName: entry.displayName,
      supportedModes: entry.supportedModes,
      matchedSubjects: entry.matchedSubjects.sort(),
      windows: entry.windows.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start)),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  if (slots.length === 0) {
    warnings.push("No candidate availability windows could be generated for the requested date range.");
  } else if (tutors.length === 0) {
    warnings.push("No proven available tutors were found for the requested date range after applying Wise data and active proposal holds.");
  }
  if (hasBusinessRequirements(input.state.businessRequirements) && businessFilteredCount > 0 && tutors.length === 0) {
    warnings.push("No tutors matched the verified tutor profile requirements.");
  }

  return {
    availabilitySummary: {
      dateRange: input.state.dateRange,
      filters: input.state.filters,
      searchedFilters,
      subjectIntent: input.state.subjectIntent,
      durationMinutes: input.state.durationMinutes,
      mode: input.state.mode,
      searchProvenance: {
        snapshotId: input.index.snapshotId,
        profileVersion: input.index.profileVersion,
        activeProposalHoldCount: input.activeProposalHolds.length,
      },
      tutors,
      needsReview: [...reviewMap.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    },
    snapshotMeta,
    warnings: uniqueStrings(warnings),
  };
}

function dayName(day: number): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day] ?? "the requested day";
}

export function formatSuggestionDay(suggestion: Pick<SchedulerSuggestion, "searchMode" | "dayOfWeek" | "date">): string {
  if (suggestion.searchMode === "one_time" && suggestion.date) return suggestion.date;
  if (typeof suggestion.dayOfWeek === "number") return `every ${dayName(suggestion.dayOfWeek)}`;
  return "the requested day";
}

function formatSlotTime(start: string, end: string): string {
  const fmt = (time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    const suffix = hour >= 12 ? "pm" : "am";
    const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return minute === 0 ? `${hour12}${suffix}` : `${hour12}:${String(minute).padStart(2, "0")}${suffix}`;
  };
  return `${fmt(start)}-${fmt(end)}`;
}

function subjectLabel(state: SchedulerResolvedState): string {
  if (state.subjectIntent) {
    return [
      state.subjectIntent.label,
      state.subjectIntent.level,
      state.subjectIntent.curriculum,
    ].filter(Boolean).join(" ");
  }
  return [state.filters.subject, state.filters.curriculum, state.filters.level].filter(Boolean).join(" ") || "tuition";
}

function searchedFiltersLabel(filters: SearchFilters[]): string {
  const subjects = [...new Set(filters.map((filter) => filter.subject).filter(Boolean))];
  const level = filters.find((filter) => filter.level)?.level;
  const curriculum = filters.find((filter) => filter.curriculum)?.curriculum;
  return [
    subjects.length ? subjects.join(", ") : undefined,
    level,
    curriculum,
  ].filter(Boolean).join(" ");
}

function formatAvailabilityDate(date: string, weekday: number): string {
  const [, monthRaw, dayRaw] = date.split("-");
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${dayName(weekday).slice(0, 3)} ${day} ${monthNames[month - 1] ?? monthRaw}`;
}

function mergeAvailabilityRanges(windows: SchedulerAvailabilityWindowSummary[]): Array<{
  date: string;
  weekday: number;
  ranges: Array<{ start: string; end: string }>;
}> {
  const byDate = new Map<string, { weekday: number; ranges: Array<{ start: number; end: number }> }>();
  for (const window of windows) {
    const entry = byDate.get(window.date) ?? { weekday: window.weekday, ranges: [] };
    entry.ranges.push({
      start: parseTimeToMinutes(window.start),
      end: parseTimeToMinutes(window.end),
    });
    byDate.set(window.date, entry);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entry]) => {
      const merged: Array<{ start: number; end: number }> = [];
      for (const range of entry.ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
        const current = merged[merged.length - 1];
        if (current && range.start <= current.end) {
          current.end = Math.max(current.end, range.end);
        } else {
          merged.push({ ...range });
        }
      }
      return {
        date,
        weekday: entry.weekday,
        ranges: merged.map((range) => ({
          start: formatMinute(range.start),
          end: formatMinute(range.end),
        })),
      };
    });
}

function formatAvailabilityWindows(windows: SchedulerAvailabilityWindowSummary[], dateLimit = 3): string {
  const grouped = mergeAvailabilityRanges(windows);
  const visible = grouped.slice(0, dateLimit);
  const parts = visible.map((entry) => (
    `${formatAvailabilityDate(entry.date, entry.weekday)}: ${entry.ranges.map((range) => `${range.start}-${range.end}`).join(", ")}`
  ));
  const remainingDates = grouped.length - visible.length;
  return `${parts.join("; ")}${remainingDates > 0 ? `; +${remainingDates} more day${remainingDates === 1 ? "" : "s"}` : ""}`;
}

function formatTutorAvailabilityLine(
  tutor: SchedulerAvailabilityTutorSummary,
  index: number,
): string {
  const subjects = tutor.matchedSubjects.length > 0 ? ` (${tutor.matchedSubjects.join("/")})` : "";
  return `${index + 1}. ${tutor.displayName}${subjects} - ${formatAvailabilityWindows(tutor.windows)}`;
}

function subjectLabelForSuggestion(state: SchedulerResolvedState, suggestion: SchedulerSuggestion): string {
  if (!suggestion.subject) return subjectLabel(state);
  return [suggestion.subject, state.filters.curriculum, state.filters.level].filter(Boolean).join(" ");
}

export function buildSchedulerParentDraft(input: {
  state: SchedulerResolvedState;
  suggestions: SchedulerSuggestion[];
  availabilitySummary?: SchedulerAvailabilitySummary;
  questions: string[];
  parentReady: boolean;
}): string {
  const subject = subjectLabel(input.state);
  if (input.availabilitySummary) {
    const summary = input.availabilitySummary;
    if (summary.tutors.length === 0) {
      return [
        `Hi! I checked ${subject} availability from ${summary.dateRange.startDate} to ${summary.dateRange.endDate}, but could not find a confirmed matching tutor yet.`,
        `Search checked: ${searchedFiltersLabel(summary.searchedFilters)}. Wise snapshot ${summary.searchProvenance.snapshotId}; profile version ${summary.searchProvenance.profileVersion}; active holds applied: ${summary.searchProvenance.activeProposalHoldCount}.`,
        "Could you share another date range or a narrower time preference?",
      ].join("\n");
    }
    const visibleTutors = summary.tutors.slice(0, 8);
    const lines = visibleTutors.map(formatTutorAvailabilityLine);
    const remainingTutors = summary.tutors.slice(visibleTutors.length);
    return [
      `Hi! I found ${summary.tutors.length} confirmed ${subject} tutor${summary.tutors.length === 1 ? "" : "s"} from ${summary.dateRange.startDate} to ${summary.dateRange.endDate}.`,
      `Checked: ${searchedFiltersLabel(summary.searchedFilters)}.`,
      "",
      "Available options:",
      ...lines,
      ...(remainingTutors.length > 0
        ? ["", `More available tutors: ${remainingTutors.map((tutor) => tutor.displayName).join(", ")}.`]
        : []),
      "",
      "Let me know which tutor and time you prefer and I will confirm.",
    ].join("\n");
  }

  if (input.suggestions.length === 0) {
    return [
      `Hi! I checked ${subject} availability but could not find a confirmed matching tutor yet.`,
      "Could you share another day or time range?",
    ].join("\n");
  }

  const lines = input.suggestions.slice(0, 4).map((suggestion) => {
    const tutors = suggestion.tutors.slice(0, 3).map((tutor) => tutor.displayName).join(" or ");
    const suggestionSubject = suggestion.subject ? `${subjectLabelForSuggestion(input.state, suggestion)}: ` : "";
    return `- ${suggestionSubject}${formatSuggestionDay(suggestion)}, ${formatSlotTime(suggestion.start, suggestion.end)}${tutors ? ` with ${tutors}` : ""}`;
  });

  if (!input.parentReady) {
    return [
      `Hi! I found some possible timing options for ${subject}, but I need to confirm one detail first:`,
      ...input.questions.slice(0, 2).map((question) => `- ${question}`),
      "",
      "Tentatively, these windows look possible:",
      ...lines,
    ].join("\n");
  }

  return [
    `Hi! Here are the best available options I found for ${subject}:`,
    "",
    ...lines,
    "",
    "Let me know which one works best and I will confirm.",
  ].join("\n");
}

export function buildSchedulerAssistantMessage(input: {
  suggestions: SchedulerSuggestion[];
  availabilitySummary?: SchedulerAvailabilitySummary;
  questions: string[];
  warnings: string[];
  parentReady: boolean;
}): string {
  if (input.availabilitySummary) {
    const summary = input.availabilitySummary;
    if (summary.tutors.length === 0) {
      const question = input.questions[0] ? ` ${input.questions[0]}` : "";
      return `I searched ${searchedFiltersLabel(summary.searchedFilters)} from ${summary.dateRange.startDate} to ${summary.dateRange.endDate} and found no proven available tutors.${question}`;
    }
    const names = summary.tutors.slice(0, 5).map((tutor) => tutor.displayName).join(", ");
    const more = summary.tutors.length > 5 ? `, +${summary.tutors.length - 5} more` : "";
    return `I searched ${searchedFiltersLabel(summary.searchedFilters)} and found ${summary.tutors.length} qualified tutor${summary.tutors.length === 1 ? "" : "s"} with proven availability from ${summary.dateRange.startDate} to ${summary.dateRange.endDate}: ${names}${more}.`;
  }

  if (input.suggestions.length === 0) {
    const question = input.questions[0] ?? "Could you share another day or time range?";
    return `I could not find a proven available option yet. ${question}`;
  }

  const representedSubjects = new Set(input.suggestions.map((suggestion) => suggestion.subject).filter(Boolean));
  const lead = input.parentReady
    ? representedSubjects.size > 1
      ? `I found proven options across ${representedSubjects.size} subjects.`
      : `I found ${input.suggestions.length} proven option${input.suggestions.length === 1 ? "" : "s"}.`
    : `I found tentative timing options, but one detail still needs confirmation.`;
  const top = input.suggestions[0];
  const tutorNames = top.tutors.slice(0, 3).map((tutor) => tutor.displayName).join(", ");
  const detail = `Best fit: ${formatSuggestionDay(top)}, ${formatSlotTime(top.start, top.end)}${tutorNames ? ` (${tutorNames})` : ""}.`;
  const question = input.questions.length > 0 ? ` ${input.questions[0]}` : "";
  return `${lead} ${detail}${question}`;
}

export function buildConversationTitle(state: SchedulerExtractedState, fallback?: string): string {
  const parts = [
    state.studentName,
    state.filters?.subject,
    state.filters?.level,
    state.requestedSlots?.length ? `${state.requestedSlots.length} requested slot${state.requestedSlots.length === 1 ? "" : "s"}` : undefined,
    state.date,
    typeof state.dayOfWeek === "number" ? dayName(state.dayOfWeek) : undefined,
  ].filter(Boolean);
  if (parts.length > 0) return parts.slice(0, 3).join(" · ");
  return fallback?.trim().slice(0, 80) || "Untitled scheduler chat";
}

export function buildSchedulerExtractionPrompt(input: {
  todayBangkok: string;
  currentState: SchedulerExtractedState;
  messages: SchedulerConversationMessageForPrompt[];
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
}): string {
  const newestAdminMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === "admin" || message.role === "parent")?.content ?? "";
  const transcript = input.messages
    .slice(-12)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
  const teachingStyleTags = TEACHING_STYLE_VOCABULARY.map((entry) => entry.tag).join(", ");

  return [
    "Extract BeGifted scheduling details from this ongoing admin-parent scheduling chat.",
    `Today in Asia/Bangkok is ${input.todayBangkok}. Resolve explicit relative dates against this date.`,
    "",
    "Behavior rules:",
    "- Return newly known or still-valid scheduling state. Preserve prior state when the newest parent/admin message does not contradict it.",
    "- Admin messages are authoritative over parent messages. The newest parent message is authoritative over older parent context.",
    "- If the newest parent/admin message names a different student, subject, or day/time from the saved state, return only the newest request's scheduling state.",
    "- Never return the saved state unchanged when the newest parent/admin message contains a different student/class request.",
    "- If a bare weekday appears without an exact date, treat it as recurring weekly and add an assumption.",
    "- Put every explicit requested day/date + time window into requestedSlots. For multiple days/times, include one requestedSlots item per requested slot.",
    "- For broad date-range requests without an exact time, set dateRange and leave requestedSlots empty so the app can summarize all proven tutor availability.",
    "- Interpret 'first week of July' / 'Week แรกของ July' as July 1 through July 7. Use the year implied by today unless the message explicitly gives another year.",
    "- If the admin gives a start time and duration but no end time, set requestedSlots.endTime to start plus duration.",
    "- Do not mention times only in assumptions; structured requestedSlots must contain the same day/date/time facts.",
    "- Missing duration should be null; the app will default to 60 minutes.",
    "- Missing delivery mode should be null; the app will default to either.",
    "- Missing subject/curriculum/level is allowed. Preserve raw admin/parent level phrases such as Y10, Year 5, Grade 10, 11+, or ม.4 in filters.level. The app maps them to Wise levels safely.",
    "- Use only valid subject/curriculum values when there is a clear match. Do not invent canonical Wise levels; keep the raw requested level instead.",
    "- For school-level English, English writing, and writing requests, preserve the raw subject in filters if unsure; the app maps it to the active English-family Wise subjects for that level. Example: writing Y6 means English/writing for International Y2-8.",
    "- Use EnglishVR for explicit exam-prep English such as 11+/13+, 16+, VR, entrance exam, or exam-prep wording.",
    "- When the request asks for multiple subjects such as Math/English/Science, put each subject as a separate subjectRequests entry. Keep filters as the primary or first subject for backward compatibility.",
    "- Unknown explicit academic filters go in explicitUnknownFilters, but do not put known subjects like English, Math, or English writing there when the subject is clear.",
    `- Supported teachingStyleTags are: ${teachingStyleTags}.`,
    "- Put non-Wise tutor fit requirements into businessRequirements: English ability, school background, writing strength, exam-prep fit, young learner age, teaching style, or curriculum experience.",
    "- If the request gives a specific young learner age, put it in businessRequirements.youngLearnerAge. If it only says younger kids with no age, ask for the age instead of guessing.",
    "- Put teaching style preferences such as patient, structured, interactive, exam-focused, concept-first, practice-heavy, gentle, high-accountability, or writing-feedback in businessRequirements.teachingStyleTags. These influence ranking only.",
    "- If a tutor fit requirement is real but cannot fit englishProficiency, youngLearnerAge, strengthTags, curriculumExperience, teachingStyleTags, or schoolKeywords, put it in explicitUnknownBusinessRequirements.",
    "- tutorNames should contain names the parent/admin explicitly requested; the app resolves ambiguity.",
    "- tutorExclusions should contain tutor names that should not be suggested. Thai replacement wording like 'แทนครูจูน' means exclude June, not request June.",
    "- Set negativeFeedback true for feedback-only messages such as 'ไม่เริ่ด', 'not good', or 'wrong'; ask what to change instead of repeating suggestions.",
    "- unresolvedQuestions should be short, concrete questions for only the important details still blocking a parent-ready answer.",
    "- Support English and Thai text.",
    "",
    `Valid subjects: ${input.filterOptions.subjects.join(", ") || "(none)"}`,
    `Valid curriculums: ${input.filterOptions.curriculums.join(", ") || "(none)"}`,
    `Valid levels: ${input.filterOptions.levels.join(", ") || "(none)"}`,
    `Active tutors: ${input.tutorList.map((tutor) => tutor.displayName).join(", ") || "(none)"}`,
    "",
    `Current saved state JSON:\n${JSON.stringify(input.currentState)}`,
    "",
    `Newest parent/admin message:\n${newestAdminMessage}`,
    "",
    `Transcript:\n${transcript}`,
  ].join("\n");
}

export async function extractSchedulerStateWithOpenAi(input: {
  currentState: SchedulerExtractedState;
  messages: SchedulerConversationMessageForPrompt[];
  todayBangkok: string;
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
}): Promise<{ state: SchedulerExtractedState; title?: string }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || !isAiSchedulerConfigured()) {
    throw new Error("AI scheduler is not configured");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: aiSchedulerModel(),
      store: false,
      input: [
        {
          role: "system",
          content: "You extract evolving BeGifted scheduling state as strict JSON. You never decide availability.",
        },
        {
          role: "user",
          content: buildSchedulerExtractionPrompt(input),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "ai_scheduler_conversation_extract",
          strict: true,
          schema: openAiSchedulerExtractionJsonSchema,
        },
        verbosity: "low",
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `OpenAI returned HTTP ${response.status}`);
  }
  const text = extractOutputText(payload);
  return normalizeSchedulerExtraction(JSON.parse(text));
}

function hasUnstructuredSlotEvidence(state: SchedulerResolvedState): boolean {
  if (state.requestedSlots.length > 0) return false;
  const text = [
    state.parentRequestSummary,
    ...(state.assumptions ?? []),
  ].filter(Boolean).join(" ").toLowerCase();
  if (!text) return false;
  const hasDay = /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|วันจันทร์|วันอังคาร|วันพุธ|วันพฤหัส|วันศุกร์|วันเสาร์|วันอาทิตย์|mon|tue|wed|thu|fri|sat|sun)/i.test(text);
  const hasTime = /(\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b|\b\d{1,2}\s*-\s*\d{1,2}\s*(?:am|pm)?\b)/i.test(text);
  return hasDay && hasTime;
}

function schedulerGuardQuestions(state: SchedulerResolvedState): string[] {
  const questions: string[] = [];
  if (state.negativeFeedback) {
    questions.push("What should I change about the previous options: day/time, subject/level, tutor, or mode?");
  }
  if (state.requestedSlots.length === 0 && state.startTime && typeof state.dayOfWeek !== "number" && !state.date) {
    questions.push("Which weekday or exact date should I search for that time?");
  }
  if (!state.dateRange && state.requestedSlots.length === 0 && !state.startTime && (typeof state.dayOfWeek === "number" || state.date)) {
    questions.push("What start time should I search for that day?");
  }
  if (hasUnstructuredSlotEvidence(state)) {
    questions.push("I detected day/time details in the request but could not safely structure them. Please confirm the exact day/date and time window.");
  }
  return questions;
}

function ledgerItem(input: Omit<SchedulerConstraintLedgerItem, "message"> & { message?: string }): SchedulerConstraintLedgerItem {
  return {
    ...input,
    message: input.message ?? (
      input.status === "proven"
        ? "Constraint is represented in normalized scheduler state."
        : input.status === "needs_clarification"
          ? "Constraint is missing, ambiguous, or not safely structured."
          : "Constraint was not part of the request."
    ),
  };
}

function formatFiltersForLedger(filters: SearchFilters | undefined): string | null {
  const value = [filters?.subject, filters?.curriculum, filters?.level].filter(Boolean).join(" / ");
  return value || null;
}

function formatSlotForLedger(slot: SchedulerRequestedSlot): string {
  const day = slot.searchMode === "one_time"
    ? slot.date ?? "one-time"
    : typeof slot.dayOfWeek === "number"
      ? dayName(slot.dayOfWeek)
      : "recurring";
  return [
    day,
    slot.startTime && slot.endTime ? `${slot.startTime}-${slot.endTime}` : undefined,
    slot.durationMinutes ? `${slot.durationMinutes} min` : undefined,
  ].filter(Boolean).join(" ");
}

function buildConstraintLedger(input: {
  state: SchedulerResolvedState;
  questions: string[];
  filterIssues: string[];
  subjectRequestIssues: string[];
  unknownFilters: string[];
  unknownBusinessRequirements: string[];
  tutorQuestions: string[];
}): SchedulerConstraintLedgerItem[] {
  const state = input.state;
  const questionText = normalizeLookup(input.questions.join(" "));
  const hasSlotQuestion = questionText.includes("weekday") ||
    questionText.includes("exact date") ||
    questionText.includes("start time") ||
    questionText.includes("day/time") ||
    questionText.includes("safely structure");
  const hasCompleteSlot = state.requestedSlots.some((slot) => (
    slot.searchMode &&
    (typeof slot.dayOfWeek === "number" || slot.date) &&
    slot.startTime &&
    slot.endTime &&
    slot.durationMinutes
  ));
  const hasDateRange = Boolean(state.dateRange?.startDate && state.dateRange?.endDate);
  const filtersLabel = formatFiltersForLedger(state.filters);
  const hasSubjectRequests = state.subjectRequests.length > 0;
  const hasBusinessRequirementsRequested = hasBusinessRequirements(state.businessRequirements) ||
    state.explicitUnknownBusinessRequirements.length > 0;

  return [
    ledgerItem({
      key: "search_mode",
      label: "Search mode",
      requested: state.searchMode ?? null,
      normalized: state.searchMode ?? null,
      evidence: state.assumptions.some((assumption) => /recurring|one-time|exact date/i.test(assumption)) ? "deterministic" : "model",
      status: state.searchMode ? "proven" : "needs_clarification",
    }),
    ledgerItem({
      key: "slot",
      label: "Day/date and time",
      requested: state.parentRequestSummary ?? null,
      normalized: hasCompleteSlot
        ? state.requestedSlots.map(formatSlotForLedger).join("; ")
        : state.startTime && state.endTime
          ? `${state.startTime}-${state.endTime}`
          : null,
      evidence: state.requestedSlots.length > 0 ? "model" : hasSlotQuestion ? "not_provided" : "deterministic",
      status: hasCompleteSlot || hasDateRange ? "proven" : hasSlotQuestion ? "needs_clarification" : "not_applicable",
      message: hasDateRange && !hasCompleteSlot
        ? "Broad date range is proven; exact slot selection is intentionally deferred."
        : undefined,
    }),
    ledgerItem({
      key: "date_range",
      label: "Date range",
      requested: state.parentRequestSummary ?? null,
      normalized: hasDateRange ? `${state.dateRange!.startDate} to ${state.dateRange!.endDate}` : null,
      evidence: hasDateRange && state.assumptions.some((assumption) => /date range|first week/i.test(assumption)) ? "deterministic" : "model",
      status: hasDateRange ? "proven" : "not_applicable",
    }),
    ledgerItem({
      key: "duration",
      label: "Duration",
      requested: state.durationMinutes ? `${state.durationMinutes} min` : null,
      normalized: `${state.durationMinutes} min`,
      evidence: state.assumptions.some((assumption) => /duration was not specified/i.test(assumption)) ? "default" : "model",
      status: state.durationMinutes ? "proven" : "needs_clarification",
    }),
    ledgerItem({
      key: "delivery_mode",
      label: "Delivery mode",
      requested: state.mode,
      normalized: state.mode,
      evidence: state.assumptions.some((assumption) => /delivery mode was not specified/i.test(assumption)) ? "default" : "model",
      status: state.mode ? "proven" : "needs_clarification",
    }),
    ledgerItem({
      key: "academic_filter",
      label: "Academic filter",
      requested: state.parentRequestSummary ?? null,
      normalized: filtersLabel,
      evidence: state.academicLevelResolution ? "deterministic" : filtersLabel ? "model" : "not_provided",
      status: input.filterIssues.length > 0 || input.unknownFilters.length > 0 ? "needs_clarification" : filtersLabel ? "proven" : "not_applicable",
      message: input.filterIssues[0] ?? input.unknownFilters[0] ?? undefined,
    }),
    ledgerItem({
      key: "subject_requests",
      label: "Subject requests",
      requested: state.parentRequestSummary ?? null,
      normalized: hasSubjectRequests ? state.subjectRequests.map(formatFiltersForLedger).filter(Boolean).join("; ") : null,
      evidence: state.subjectIntent ? "deterministic" : hasSubjectRequests ? "model" : "not_provided",
      status: input.subjectRequestIssues.length > 0 ? "needs_clarification" : hasSubjectRequests ? "proven" : "not_applicable",
      message: input.subjectRequestIssues[0] ?? undefined,
    }),
    ledgerItem({
      key: "tutor_include",
      label: "Tutor include",
      requested: state.tutorNames.join(", ") || null,
      normalized: state.tutorNames.join(", ") || null,
      evidence: state.tutorNames.length > 0 ? "model" : "not_provided",
      status: state.tutorNames.length === 0 ? "not_applicable" : input.tutorQuestions.length > 0 ? "needs_clarification" : "proven",
      message: input.tutorQuestions[0] ?? undefined,
    }),
    ledgerItem({
      key: "tutor_exclude",
      label: "Tutor exclude",
      requested: state.tutorExclusions.join(", ") || null,
      normalized: state.tutorExclusions.join(", ") || null,
      evidence: state.tutorExclusions.length > 0 ? "model" : "not_provided",
      status: state.tutorExclusions.length === 0 ? "not_applicable" : input.tutorQuestions.length > 0 ? "needs_clarification" : "proven",
      message: input.tutorQuestions[0] ?? undefined,
    }),
    ledgerItem({
      key: "business_requirement",
      label: "Tutor profile fit",
      requested: hasBusinessRequirementsRequested ? JSON.stringify(state.businessRequirements) : null,
      normalized: hasBusinessRequirements(state.businessRequirements) ? JSON.stringify(state.businessRequirements) : null,
      evidence: hasBusinessRequirementsRequested ? "model" : "not_provided",
      status: input.unknownBusinessRequirements.length > 0 ? "needs_clarification" : hasBusinessRequirements(state.businessRequirements) ? "proven" : "not_applicable",
      message: input.unknownBusinessRequirements[0] ?? undefined,
    }),
    ledgerItem({
      key: "negative_feedback",
      label: "Negative feedback",
      requested: state.negativeFeedback ? "yes" : null,
      normalized: state.negativeFeedback ? "ask what to change" : null,
      evidence: state.negativeFeedback ? "model" : "not_provided",
      status: state.negativeFeedback ? "needs_clarification" : "not_applicable",
      message: state.negativeFeedback ? "Feedback-only messages must clarify what to change before producing new parent-ready output." : undefined,
    }),
  ];
}

function emptySearchResult(index: SearchIndex, warnings: string[]) {
  return {
    suggestions: [],
    snapshotMeta: {
      snapshotId: index.snapshotId,
      syncedAt: index.syncedAt.toISOString(),
      stale: false,
    },
    warnings,
  };
}

function hasFilterValue(filters: SearchFilters): boolean {
  return Boolean(filters.subject || filters.curriculum || filters.level);
}

function resolveSubjectRequestFilters(input: {
  subjectRequests: SearchFilters[];
  fallbackFilters: SearchFilters;
  options: FilterOptions;
}): {
  filters: SearchFilters[];
  issues: string[];
} {
  const issues: string[] = [];
  const seen = new Set<string>();
  const filters: SearchFilters[] = [];

  for (const request of input.subjectRequests) {
    const rawFilters = {
      ...input.fallbackFilters,
      ...request,
    };
    const recovered = recoverSchedulerFilters({
      filters: rawFilters,
      explicitUnknownFilters: [],
      options: input.options,
    });
    const resolved = resolveSchedulerFilters(recovered.filters, input.options);
    issues.push(...resolved.issues, ...recovered.remainingUnknowns.map((issue) => `${issue} is not mapped to an active Wise qualification. Please clarify.`));
    if (!hasFilterValue(resolved.filters)) continue;
    const key = filtersKey(resolved.filters);
    if (seen.has(key)) continue;
    seen.add(key);
    filters.push(resolved.filters);
  }

  return { filters, issues: uniqueStrings(issues) };
}

function runSubjectSpecificSchedulerSearch(input: {
  index: SearchIndex;
  state: SchedulerResolvedState;
  subjectRequests: SearchFilters[];
  activeProposalHolds: ProposalHoldSummary[];
  matchedTutorIds?: Set<string>;
  excludedTutorIds?: Set<string>;
  parentReady: boolean;
}): {
  suggestions: SchedulerSuggestion[];
  snapshotMeta: SnapshotMeta;
  warnings: string[];
} {
  const warnings: string[] = [];
  const searches = input.subjectRequests.map((filters) => ({
    filters,
    search: runSchedulerSearch({
      index: input.index,
      state: { ...input.state, filters },
      activeProposalHolds: input.activeProposalHolds,
      matchedTutorIds: input.matchedTutorIds,
      excludedTutorIds: input.excludedTutorIds,
      parentReady: input.parentReady,
    }),
  }));

  for (const entry of searches) {
    warnings.push(...entry.search.warnings);
  }

  const firstBySubject: SchedulerSuggestion[] = [];
  const rest: SchedulerSuggestion[] = [];
  for (const entry of searches) {
    const tagged = entry.search.suggestions.map((suggestion) => ({
      ...suggestion,
      subject: entry.filters.subject,
    }));
    if (tagged[0]) firstBySubject.push(tagged[0]);
    rest.push(...tagged.slice(1));
  }

  const selected = [...firstBySubject, ...rest]
    .slice(0, MAX_SCHEDULER_SUGGESTIONS)
    .map((suggestion, index) => ({
      ...suggestion,
      id: `suggestion-${index + 1}`,
      rank: index + 1,
      confidence: index === 0 ? "Best fit" as const : index < 3 ? "Strong fit" as const : "Good fit" as const,
    }));

  const snapshotMeta = searches[0]?.search.snapshotMeta ?? {
    snapshotId: input.index.snapshotId,
    syncedAt: input.index.syncedAt.toISOString(),
    stale: false,
  };

  return { suggestions: selected, snapshotMeta, warnings: uniqueStrings(warnings) };
}

export function solveSchedulerTurn(input: {
  index: SearchIndex;
  extractedState: SchedulerExtractedState;
  sourceText?: string;
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
  activeProposalHolds: ProposalHoldSummary[];
}): SchedulerAssistantResult {
  const state = applyDeterministicSchedulerIntent({
    state: resolveSchedulerState(stateWithSchedulerSourceText(input.extractedState, input.sourceText)),
    index: input.index,
    options: input.filterOptions,
  });
  const recovered = recoverSchedulerFilters({
    filters: state.filters,
    explicitUnknownFilters: state.explicitUnknownFilters,
    options: input.filterOptions,
  });
  const filterResolution = resolveSchedulerFilters(recovered.filters, input.filterOptions);
  const academicLevelResolution = filterResolution.academicLevelResolution ?? recovered.academicLevelResolution;
  const subjectRequestResolution = resolveSubjectRequestFilters({
    subjectRequests: state.subjectRequests,
    fallbackFilters: filterResolution.filters,
    options: input.filterOptions,
  });
  const tutorResolution = resolveSchedulerTutorNames(state.tutorNames, input.tutorList, state.tutorExclusions);
  const questions = uniqueStrings([
    ...state.unresolvedQuestions,
    ...schedulerGuardQuestions(state),
    ...filterResolution.issues,
    ...subjectRequestResolution.issues,
    ...recovered.remainingUnknowns.map((issue) => `${issue} is not mapped to an active Wise qualification. Please clarify.`),
    ...state.explicitUnknownBusinessRequirements.map((issue) => `${issue} is not mapped to a verified tutor profile field. Please clarify.`),
    ...tutorResolution.questions,
  ]);
  const warnings = uniqueStrings([
    ...filterResolution.issues,
    ...subjectRequestResolution.issues,
    ...recovered.remainingUnknowns,
    ...state.explicitUnknownBusinessRequirements,
    ...tutorResolution.warnings,
  ]);
  const resolvedState: SchedulerResolvedState = {
    ...state,
    filters: filterResolution.filters,
    subjectIntent: state.subjectIntent,
    subjectRequests: subjectRequestResolution.filters,
    academicLevelResolution,
    explicitUnknownFilters: recovered.remainingUnknowns,
    unresolvedQuestions: questions,
  };
  const constraintLedger = buildConstraintLedger({
    state: resolvedState,
    questions,
    filterIssues: filterResolution.issues,
    subjectRequestIssues: subjectRequestResolution.issues,
    unknownFilters: recovered.remainingUnknowns,
    unknownBusinessRequirements: state.explicitUnknownBusinessRequirements,
    tutorQuestions: tutorResolution.questions,
  });
  const parentReady = questions.length === 0 &&
    constraintLedger.every((item) => item.status !== "needs_clarification");

  const shouldSuppressBroadSearch = state.negativeFeedback ||
    (state.requestedSlots.length === 0 && state.startTime && typeof state.dayOfWeek !== "number" && !state.date) ||
    (!state.dateRange && state.requestedSlots.length === 0 && !state.startTime && (typeof state.dayOfWeek === "number" || Boolean(state.date))) ||
    hasUnstructuredSlotEvidence(state);
  const shouldBuildAvailabilitySummary = !shouldSuppressBroadSearch &&
    Boolean(resolvedState.dateRange) &&
    resolvedState.requestedSlots.length === 0;
  const availabilitySearch = shouldBuildAvailabilitySummary
    ? buildDateRangeAvailabilitySummary({
      index: input.index,
      state: resolvedState,
      activeProposalHolds: input.activeProposalHolds,
      matchedTutorIds: tutorResolution.matchedTutorIds,
      excludedTutorIds: tutorResolution.excludedTutorIds,
    })
    : undefined;
  const search = shouldSuppressBroadSearch
    ? emptySearchResult(input.index, ["Skipped broad scheduler search because explicit constraints were not safely structured."])
    : shouldBuildAvailabilitySummary
      ? {
        suggestions: [],
        snapshotMeta: availabilitySearch?.snapshotMeta ?? {
          snapshotId: input.index.snapshotId,
          syncedAt: input.index.syncedAt.toISOString(),
          stale: false,
        },
        warnings: availabilitySearch?.warnings ?? [],
      }
      : resolvedState.subjectRequests.length > 1
        ? runSubjectSpecificSchedulerSearch({
          index: input.index,
          state: resolvedState,
          subjectRequests: resolvedState.subjectRequests,
          activeProposalHolds: input.activeProposalHolds,
          matchedTutorIds: tutorResolution.matchedTutorIds,
          excludedTutorIds: tutorResolution.excludedTutorIds,
          parentReady,
        })
        : runSchedulerSearch({
      index: input.index,
      state: resolvedState,
      activeProposalHolds: input.activeProposalHolds,
      matchedTutorIds: tutorResolution.matchedTutorIds,
      excludedTutorIds: tutorResolution.excludedTutorIds,
      parentReady,
    });
  const allWarnings = uniqueStrings([...warnings, ...search.warnings]);
  const parentMessageDraft = buildSchedulerParentDraft({
    state: resolvedState,
    suggestions: search.suggestions,
    availabilitySummary: availabilitySearch?.availabilitySummary,
    questions,
    parentReady,
  });
  const assistantMessage = buildSchedulerAssistantMessage({
    suggestions: search.suggestions,
    availabilitySummary: availabilitySearch?.availabilitySummary,
    questions,
    warnings: allWarnings,
    parentReady,
  });

  return {
    state: resolvedState,
    suggestions: search.suggestions,
    availabilitySummary: availabilitySearch?.availabilitySummary,
    constraintLedger,
    parentMessageDraft,
    assistantMessage,
    snapshotMeta: search.snapshotMeta,
    warnings: allWarnings,
    questions,
    parentReady,
  };
}
