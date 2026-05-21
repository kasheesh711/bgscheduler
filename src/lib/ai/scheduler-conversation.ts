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
  businessRequirements?: SchedulerBusinessRequirements;
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
  businessRequirements: SchedulerBusinessRequirements;
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
  confidence: "Best fit" | "Strong fit" | "Good fit";
  tutors: SchedulerSuggestionTutor[];
  availableTutorCount: number;
  reasons: string[];
  parentReady: boolean;
  requestedSlotId?: string;
}

export interface SchedulerAssistantResult {
  state: SchedulerResolvedState;
  suggestions: SchedulerSuggestion[];
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
  businessRequirements: modelBusinessRequirementsSchema,
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
    "businessRequirements",
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
      businessRequirements: businessRequirementsToState(parsed.businessRequirements),
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
    businessRequirements: mergeBusinessRequirements(existing?.businessRequirements, incoming.businessRequirements),
    requestedSlots: incoming.requestedSlots?.length ? incoming.requestedSlots : existing?.requestedSlots,
    explicitUnknownFilters: mergeList(existing?.explicitUnknownFilters, incoming.explicitUnknownFilters),
    explicitUnknownBusinessRequirements: mergeList(existing?.explicitUnknownBusinessRequirements, incoming.explicitUnknownBusinessRequirements),
    tutorNames: mergeList(existing?.tutorNames, incoming.tutorNames),
    tutorExclusions: mergeList(existing?.tutorExclusions, incoming.tutorExclusions),
    assumptions: mergeList(existing?.assumptions, incoming.assumptions),
    unresolvedQuestions: mergeList(existing?.unresolvedQuestions, incoming.unresolvedQuestions),
  };

  if (merged.searchMode === "one_time") {
    delete merged.dayOfWeek;
  }
  if (merged.searchMode === "recurring") {
    delete merged.date;
  }

  return merged;
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

function resolveRequestedSlots(
  state: SchedulerExtractedState,
  searchMode: SchedulerSearchMode,
  durationMinutes: SchedulerDuration,
  assumptions: string[],
): SchedulerRequestedSlot[] {
  const resolved = (state.requestedSlots ?? [])
    .map((slot, index) => resolveRequestedSlot(slot, { searchMode, durationMinutes, assumptions }, index))
    .filter((slot): slot is SchedulerRequestedSlot => Boolean(slot));

  if (resolved.length > 0) return resolved;
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

export function resolveSchedulerState(state: SchedulerExtractedState): SchedulerResolvedState {
  const assumptions = [...(state.assumptions ?? [])];
  const unresolvedQuestions = [...(state.unresolvedQuestions ?? [])];
  let searchMode = state.searchMode;

  if (!searchMode && typeof state.dayOfWeek === "number") {
    searchMode = "recurring";
    assumptions.push("Bare weekday was treated as a recurring weekly request.");
  } else if (searchMode === "one_time" && !state.date && typeof state.dayOfWeek === "number") {
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
    ...state,
    searchMode,
    durationMinutes: state.durationMinutes ?? DEFAULT_CONVERSATIONAL_DURATION,
    mode: state.mode ?? DEFAULT_CONVERSATIONAL_MODE,
    filters: state.filters ?? {},
    businessRequirements: state.businessRequirements ?? {},
    requestedSlots: resolveRequestedSlots(
      state,
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
    unresolvedQuestions: uniqueStrings(unresolvedQuestions),
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
  return [state.filters.subject, state.filters.curriculum, state.filters.level].filter(Boolean).join(" ") || "tuition";
}

export function buildSchedulerParentDraft(input: {
  state: SchedulerResolvedState;
  suggestions: SchedulerSuggestion[];
  questions: string[];
  parentReady: boolean;
}): string {
  const subject = subjectLabel(input.state);
  if (input.suggestions.length === 0) {
    return [
      `Hi! I checked ${subject} availability but could not find a confirmed matching tutor yet.`,
      "Could you share another day or time range?",
    ].join("\n");
  }

  const lines = input.suggestions.slice(0, 4).map((suggestion) => {
    const tutors = suggestion.tutors.slice(0, 3).map((tutor) => tutor.displayName).join(" or ");
    return `- ${formatSuggestionDay(suggestion)}, ${formatSlotTime(suggestion.start, suggestion.end)}${tutors ? ` with ${tutors}` : ""}`;
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
  questions: string[];
  warnings: string[];
  parentReady: boolean;
}): string {
  if (input.suggestions.length === 0) {
    const question = input.questions[0] ?? "Could you share another day or time range?";
    return `I could not find a proven available option yet. ${question}`;
  }

  const lead = input.parentReady
    ? `I found ${input.suggestions.length} proven option${input.suggestions.length === 1 ? "" : "s"}.`
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
    "- If the admin gives a start time and duration but no end time, set requestedSlots.endTime to start plus duration.",
    "- Do not mention times only in assumptions; structured requestedSlots must contain the same day/date/time facts.",
    "- Missing duration should be null; the app will default to 60 minutes.",
    "- Missing delivery mode should be null; the app will default to either.",
    "- Missing subject/curriculum/level is allowed. Preserve raw admin/parent level phrases such as Y10, Year 5, Grade 10, 11+, or ม.4 in filters.level. The app maps them to Wise levels safely.",
    "- Use only valid subject/curriculum values when there is a clear match. Do not invent canonical Wise levels; keep the raw requested level instead.",
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
  if (state.requestedSlots.length === 0 && !state.startTime && (typeof state.dayOfWeek === "number" || state.date)) {
    questions.push("What start time should I search for that day?");
  }
  if (hasUnstructuredSlotEvidence(state)) {
    questions.push("I detected day/time details in the request but could not safely structure them. Please confirm the exact day/date and time window.");
  }
  return questions;
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

export function solveSchedulerTurn(input: {
  index: SearchIndex;
  extractedState: SchedulerExtractedState;
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
  activeProposalHolds: ProposalHoldSummary[];
}): SchedulerAssistantResult {
  const state = resolveSchedulerState(input.extractedState);
  const recovered = recoverFiltersFromUnknowns({
    filters: state.filters,
    explicitUnknownFilters: state.explicitUnknownFilters,
    options: input.filterOptions,
  });
  const filterResolution = resolveSchedulerFilters(recovered.filters, input.filterOptions);
  const academicLevelResolution = filterResolution.academicLevelResolution ?? recovered.academicLevelResolution;
  const tutorResolution = resolveSchedulerTutorNames(state.tutorNames, input.tutorList, state.tutorExclusions);
  const questions = uniqueStrings([
    ...state.unresolvedQuestions,
    ...schedulerGuardQuestions(state),
    ...filterResolution.issues,
    ...recovered.remainingUnknowns.map((issue) => `${issue} is not mapped to an active Wise qualification. Please clarify.`),
    ...state.explicitUnknownBusinessRequirements.map((issue) => `${issue} is not mapped to a verified tutor profile field. Please clarify.`),
    ...tutorResolution.questions,
  ]);
  const warnings = uniqueStrings([
    ...filterResolution.issues,
    ...recovered.remainingUnknowns,
    ...state.explicitUnknownBusinessRequirements,
    ...tutorResolution.warnings,
  ]);
  const parentReady = questions.length === 0;
  const resolvedState: SchedulerResolvedState = {
    ...state,
    filters: filterResolution.filters,
    academicLevelResolution,
    explicitUnknownFilters: recovered.remainingUnknowns,
    unresolvedQuestions: questions,
  };

  const shouldSuppressBroadSearch = state.negativeFeedback ||
    (state.requestedSlots.length === 0 && state.startTime && typeof state.dayOfWeek !== "number" && !state.date) ||
    (state.requestedSlots.length === 0 && !state.startTime && (typeof state.dayOfWeek === "number" || Boolean(state.date))) ||
    hasUnstructuredSlotEvidence(state);
  const search = shouldSuppressBroadSearch
    ? emptySearchResult(input.index, ["Skipped broad scheduler search because explicit constraints were not safely structured."])
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
    questions,
    parentReady,
  });
  const assistantMessage = buildSchedulerAssistantMessage({
    suggestions: search.suggestions,
    questions,
    warnings: allWarnings,
    parentReady,
  });

  return {
    state: resolvedState,
    suggestions: search.suggestions,
    parentMessageDraft,
    assistantMessage,
    snapshotMeta: search.snapshotMeta,
    warnings: allWarnings,
    questions,
    parentReady,
  };
}
