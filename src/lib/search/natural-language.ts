import { z } from "zod";
import type { FilterOptions } from "@/lib/data/filters";
import type { TutorListItem } from "@/lib/data/tutors";

export type NaturalLanguageSearchStatus = "parsed" | "needs_clarification";
export type NaturalLanguageSearchMode = "recurring" | "one_time";
export type NaturalLanguageDeliveryMode = "online" | "onsite" | "either";
export type NaturalLanguageDuration = 60 | 90 | 120;

export interface ParsedNaturalLanguageFields {
  searchMode: NaturalLanguageSearchMode;
  dayOfWeek?: number;
  date?: string;
  startTime: string;
  endTime: string;
  durationMinutes: NaturalLanguageDuration;
  mode: NaturalLanguageDeliveryMode;
  filters: {
    subject?: string;
    curriculum?: string;
    level?: string;
  };
  tutorNames: string[];
}

export type NaturalLanguageSearchParse =
  | (ParsedNaturalLanguageFields & {
      status: "parsed";
      warnings: string[];
    })
  | {
      status: "needs_clarification";
      clarifyingQuestions: string[];
      partial: Partial<ParsedNaturalLanguageFields>;
      warnings: string[];
    };

export type NaturalLanguageSearchResponse =
  | {
      status: "parsed";
      parsed: ParsedNaturalLanguageFields & {
        tutorGroupIds: string[];
        matchedTutors: { tutorGroupId: string; displayName: string }[];
      };
      warnings: string[];
      logId: string;
    }
  | {
      status: "needs_clarification";
      clarifyingQuestions: string[];
      partial: Partial<ParsedNaturalLanguageFields>;
      warnings: string[];
      logId: string;
    };

const HH_MM_RE = /^\d{2}:\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const nullableFilterSchema = z.object({
  subject: z.string().nullable(),
  curriculum: z.string().nullable(),
  level: z.string().nullable(),
}).strict();

const nullableParsedFieldsSchema = z.object({
  searchMode: z.enum(["recurring", "one_time"]).nullable(),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  date: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  durationMinutes: z.union([z.literal(60), z.literal(90), z.literal(120)]).nullable(),
  mode: z.enum(["online", "onsite", "either"]).nullable(),
  filters: nullableFilterSchema.nullable(),
  tutorNames: z.array(z.string()).nullable(),
}).strict();

// Flat object shape keeps strict JSON Schema compatibility simple for the
// Responses API. normalizeModelParse converts it to the public discriminated union.
export const modelNaturalLanguageParseSchema = z.object({
  status: z.enum(["parsed", "needs_clarification"]),
  searchMode: z.enum(["recurring", "one_time"]).nullable(),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  date: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  durationMinutes: z.union([z.literal(60), z.literal(90), z.literal(120)]).nullable(),
  mode: z.enum(["online", "onsite", "either"]).nullable(),
  filters: nullableFilterSchema,
  tutorNames: z.array(z.string()),
  warnings: z.array(z.string()),
  clarifyingQuestions: z.array(z.string()),
  partial: nullableParsedFieldsSchema,
}).strict();

export const naturalLanguageSearchRequestSchema = z.object({
  input: z.string().trim().min(1).max(1000),
}).strict();

export const openAiNaturalLanguageJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "searchMode",
    "dayOfWeek",
    "date",
    "startTime",
    "endTime",
    "durationMinutes",
    "mode",
    "filters",
    "tutorNames",
    "warnings",
    "clarifyingQuestions",
    "partial",
  ],
  properties: {
    status: { type: "string", enum: ["parsed", "needs_clarification"] },
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
    tutorNames: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    clarifyingQuestions: { type: "array", items: { type: "string" } },
    partial: {
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
        "tutorNames",
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
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["subject", "curriculum", "level"],
              properties: {
                subject: { anyOf: [{ type: "string" }, { type: "null" }] },
                curriculum: { anyOf: [{ type: "string" }, { type: "null" }] },
                level: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
            },
            { type: "null" },
          ],
        },
        tutorNames: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
      },
    },
  },
} as const;

export function redactNaturalLanguageInput(input: string): string {
  return input
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, (match) => {
      const trimmed = match.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return match;
      const withoutPlus = trimmed.replace(/^\+/, "");
      return /\D/.test(withoutPlus) || trimmed.startsWith("+") ? "[phone]" : match;
    })
    .replace(/\b\d{8,}\b/g, "[number]")
    .slice(0, 500);
}

function nullableToUndefined<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value;
}

function compactFilters(filters: z.infer<typeof nullableFilterSchema> | null | undefined) {
  return {
    subject: nullableToUndefined(filters?.subject),
    curriculum: nullableToUndefined(filters?.curriculum),
    level: nullableToUndefined(filters?.level),
  };
}

function compactPartial(partial: z.infer<typeof nullableParsedFieldsSchema>): Partial<ParsedNaturalLanguageFields> {
  const compacted: Partial<ParsedNaturalLanguageFields> = {};
  if (partial.searchMode) compacted.searchMode = partial.searchMode;
  if (partial.dayOfWeek !== null) compacted.dayOfWeek = partial.dayOfWeek;
  if (partial.date) compacted.date = partial.date;
  if (partial.startTime) compacted.startTime = partial.startTime;
  if (partial.endTime) compacted.endTime = partial.endTime;
  if (partial.durationMinutes) compacted.durationMinutes = partial.durationMinutes;
  if (partial.mode) compacted.mode = partial.mode;
  const filters = compactFilters(partial.filters);
  if (filters.subject || filters.curriculum || filters.level) compacted.filters = filters;
  if (partial.tutorNames && partial.tutorNames.length > 0) compacted.tutorNames = partial.tutorNames;
  return compacted;
}

function parseMinute(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validateParsedFields(parsed: ParsedNaturalLanguageFields): void {
  if (parsed.searchMode === "recurring" && parsed.dayOfWeek === undefined) {
    throw new Error("Recurring search needs a weekday");
  }
  if (parsed.searchMode === "one_time" && (!parsed.date || !isValidIsoDate(parsed.date))) {
    throw new Error("One-time search needs a valid YYYY-MM-DD date");
  }
  if (!HH_MM_RE.test(parsed.startTime) || !HH_MM_RE.test(parsed.endTime)) {
    throw new Error("Parsed time must use HH:mm format");
  }
  const startMinute = parseMinute(parsed.startTime);
  const endMinute = parseMinute(parsed.endTime);
  if (endMinute <= startMinute) {
    throw new Error("Parsed end time must be after start time");
  }
}

export function normalizeModelParse(raw: unknown): NaturalLanguageSearchParse {
  const parsed = modelNaturalLanguageParseSchema.parse(raw);

  if (parsed.status === "needs_clarification") {
    return {
      status: "needs_clarification",
      clarifyingQuestions: parsed.clarifyingQuestions.length > 0
        ? parsed.clarifyingQuestions
        : ["Can you clarify the day/date, time range, and class duration?"],
      partial: compactPartial(parsed.partial),
      warnings: parsed.warnings,
    };
  }

  if (
    !parsed.searchMode ||
    !parsed.startTime ||
    !parsed.endTime ||
    !parsed.durationMinutes ||
    !parsed.mode
  ) {
    throw new Error("Parsed response is missing required search fields");
  }

  const normalized: ParsedNaturalLanguageFields & { status: "parsed"; warnings: string[] } = {
    status: "parsed",
    searchMode: parsed.searchMode,
    dayOfWeek: nullableToUndefined(parsed.dayOfWeek),
    date: nullableToUndefined(parsed.date),
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    durationMinutes: parsed.durationMinutes,
    mode: parsed.mode,
    filters: compactFilters(parsed.filters),
    tutorNames: parsed.tutorNames,
    warnings: parsed.warnings,
  };

  validateParsedFields(normalized);
  return normalized;
}

function normalizeLookup(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function findCaseInsensitiveOption(value: string | undefined, options: string[]): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeLookup(value);
  return options.find((option) => normalizeLookup(option) === normalized);
}

export function resolveParsedFilters(
  filters: ParsedNaturalLanguageFields["filters"] | undefined,
  options: FilterOptions,
): {
  filters: ParsedNaturalLanguageFields["filters"];
  issues: string[];
} {
  const issues: string[] = [];
  const resolved: ParsedNaturalLanguageFields["filters"] = {};

  const subject = findCaseInsensitiveOption(filters?.subject, options.subjects);
  if (filters?.subject && !subject) issues.push(`Subject "${filters.subject}" is not an active filter option.`);
  if (subject) resolved.subject = subject;

  const curriculum = findCaseInsensitiveOption(filters?.curriculum, options.curriculums);
  if (filters?.curriculum && !curriculum) issues.push(`Curriculum "${filters.curriculum}" is not an active filter option.`);
  if (curriculum) resolved.curriculum = curriculum;

  const level = findCaseInsensitiveOption(filters?.level, options.levels);
  if (filters?.level && !level) issues.push(`Level "${filters.level}" is not an active filter option.`);
  if (level) resolved.level = level;

  return { filters: resolved, issues };
}

export function resolveTutorNames(
  tutorNames: string[],
  tutorList: TutorListItem[],
): {
  matchedTutors: { tutorGroupId: string; displayName: string }[];
  issues: string[];
} {
  const issues: string[] = [];
  const matchedTutors: { tutorGroupId: string; displayName: string }[] = [];
  const seen = new Set<string>();

  for (const rawName of tutorNames) {
    const name = rawName.trim();
    if (!name) continue;
    const normalized = normalizeLookup(name);
    let matches = tutorList.filter((tutor) => normalizeLookup(tutor.displayName) === normalized);
    if (matches.length === 0) {
      matches = tutorList.filter((tutor) => normalizeLookup(tutor.displayName).includes(normalized));
    }
    if (matches.length === 1) {
      const match = matches[0];
      if (!seen.has(match.tutorGroupId)) {
        seen.add(match.tutorGroupId);
        matchedTutors.push({ tutorGroupId: match.tutorGroupId, displayName: match.displayName });
      }
      continue;
    }
    if (matches.length === 0) {
      issues.push(`Tutor "${name}" did not match an active tutor.`);
    } else {
      issues.push(`Tutor "${name}" matched multiple active tutors: ${matches.slice(0, 5).map((t) => t.displayName).join(", ")}.`);
    }
  }

  return { matchedTutors, issues };
}

export function buildNaturalLanguagePrompt(input: {
  adminInput: string;
  todayBangkok: string;
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
}): string {
  return [
    "Parse the admin's English scheduling request into strict JSON for the BeGifted tutor search form.",
    `Today in Asia/Bangkok is ${input.todayBangkok}. Resolve today, tomorrow, this weekday, and next weekday against this date.`,
    "",
    "Rules:",
    "- Never decide tutor availability.",
    "- Use recurring only when the request says every, weekly, recurring, or gives plural weekdays.",
    "- A bare weekday without recurring/weekly/every/explicit date is ambiguous; return needs_clarification.",
    "- Explicit dates and relative dates are one_time.",
    "- Missing class duration is ambiguous.",
    "- Supported durations are 60, 90, and 120 minutes only; unsupported durations need clarification.",
    "- Missing delivery mode defaults to either and must add a warning.",
    "- Only use subject, curriculum, and level values from the valid lists.",
    "- tutorNames may include requested tutor names, but IDs are resolved by the server.",
    "",
    `Valid subjects: ${input.filterOptions.subjects.join(", ") || "(none)"}`,
    `Valid curriculums: ${input.filterOptions.curriculums.join(", ") || "(none)"}`,
    `Valid levels: ${input.filterOptions.levels.join(", ") || "(none)"}`,
    `Active tutors: ${input.tutorList.map((t) => t.displayName).join(", ") || "(none)"}`,
    "",
    `Admin request: ${input.adminInput}`,
  ].join("\n");
}

export function bangkokTodayIso(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
