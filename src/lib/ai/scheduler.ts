import { z } from "zod";
import type { FilterOptions } from "@/lib/data/filters";
import type { TutorListItem } from "@/lib/data/tutors";
import type { SnapshotMeta } from "@/lib/search/types";
import type { SchedulerAvailabilitySummary, SchedulerResolvedState } from "@/lib/ai/scheduler-conversation";
import { resolveAcademicFilters } from "@/lib/ai/academic-levels";

export const DEFAULT_AI_SCHEDULER_MODEL = "gpt-5.4-mini";

export type AiSchedulerSearchMode = "recurring" | "one_time";
export type AiSchedulerDeliveryMode = "online" | "onsite" | "either";
export type AiSchedulerDuration = 60 | 90 | 120;

export interface AiSchedulerParsedRequest {
  searchMode: AiSchedulerSearchMode;
  dayOfWeek?: number;
  date?: string;
  startTime: string;
  endTime: string;
  durationMinutes: AiSchedulerDuration;
  mode: AiSchedulerDeliveryMode;
  filters: {
    subject?: string;
    curriculum?: string;
    level?: string;
  };
  tutorNames: string[];
  assumptions: string[];
  parentRequestSummary?: string;
}

export type AiSchedulerParse =
  | (AiSchedulerParsedRequest & {
      status: "parsed";
      warnings: string[];
    })
  | {
      status: "needs_clarification";
      clarifyingQuestions: string[];
      partial: Partial<AiSchedulerParsedRequest>;
      warnings: string[];
    };

export interface AiSchedulerMatchedTutor {
  tutorGroupId: string;
  displayName: string;
}

export interface AiSchedulerSolvedRequest extends AiSchedulerParsedRequest {
  tutorGroupIds: string[];
  matchedTutors: AiSchedulerMatchedTutor[];
}

export interface AiSchedulerOption {
  id: string;
  rank: number;
  start: string;
  end: string;
  confidence: "Best fit" | "Strong fit" | "Good fit";
  reasons: string[];
  tutors: {
    tutorGroupId: string;
    displayName: string;
    supportedModes: string[];
  }[];
}

export type AiSchedulerResponse =
  | {
      status: "needs_clarification";
      partial: Partial<AiSchedulerParsedRequest>;
      clarifyingQuestions: string[];
      warnings: string[];
      logId: string;
    }
  | {
      status: "solved";
      parsedRequest: AiSchedulerSolvedRequest;
      options: AiSchedulerOption[];
      parentMessageDraft: string;
      snapshotMeta: SnapshotMeta;
      warnings: string[];
      logId: string;
    }
  | {
      status: "availability_summary";
      state: SchedulerResolvedState;
      availabilitySummary: SchedulerAvailabilitySummary;
      assistantMessage: string;
      parentMessageDraft: string;
      snapshotMeta: SnapshotMeta;
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
  assumptions: z.array(z.string()).nullable(),
  parentRequestSummary: z.string().nullable(),
}).strict();

export const modelAiSchedulerParseSchema = z.object({
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
  assumptions: z.array(z.string()),
  parentRequestSummary: z.string().nullable(),
  warnings: z.array(z.string()),
  clarifyingQuestions: z.array(z.string()),
  partial: nullableParsedFieldsSchema,
}).strict();

export const aiSchedulerRequestSchema = z.object({
  input: z.string().trim().min(1).max(6000),
}).strict();

export const openAiSchedulerJsonSchema = {
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
    "assumptions",
    "parentRequestSummary",
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
    assumptions: { type: "array", items: { type: "string" } },
    parentRequestSummary: { anyOf: [{ type: "string" }, { type: "null" }] },
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
        "assumptions",
        "parentRequestSummary",
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
        assumptions: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
        parentRequestSummary: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
  },
} as const;

interface OpenAiResponsePayload {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
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

function compactPartial(partial: z.infer<typeof nullableParsedFieldsSchema>): Partial<AiSchedulerParsedRequest> {
  const compacted: Partial<AiSchedulerParsedRequest> = {};
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
  if (partial.assumptions && partial.assumptions.length > 0) compacted.assumptions = partial.assumptions;
  if (partial.parentRequestSummary) compacted.parentRequestSummary = partial.parentRequestSummary;
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

function collectBoundedSearchIssues(parsed: {
  searchMode: AiSchedulerSearchMode | null;
  dayOfWeek: number | null;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: AiSchedulerDuration | null;
}): string[] {
  const issues: string[] = [];
  if (!parsed.searchMode) {
    issues.push("Is this a one-time class or a recurring weekly class?");
  } else if (parsed.searchMode === "recurring" && parsed.dayOfWeek === null) {
    issues.push("Which weekday should we search for the recurring class?");
  } else if (parsed.searchMode === "one_time" && (!parsed.date || !isValidIsoDate(parsed.date))) {
    issues.push("What exact class date should we search? Please use a specific date.");
  }

  if (!parsed.startTime || !parsed.endTime) {
    issues.push("What time window should we search?");
  } else if (!HH_MM_RE.test(parsed.startTime) || !HH_MM_RE.test(parsed.endTime)) {
    issues.push("What time window should we search? Please use a clear start and end time.");
  } else if (parseMinute(parsed.endTime) <= parseMinute(parsed.startTime)) {
    issues.push("The end time needs to be after the start time.");
  } else if (parsed.durationMinutes && parseMinute(parsed.endTime) - parseMinute(parsed.startTime) < parsed.durationMinutes) {
    issues.push("The time window is shorter than the requested class duration.");
  }

  if (!parsed.durationMinutes) {
    issues.push("How long is the class: 60, 90, or 120 minutes?");
  }

  return issues;
}

export function normalizeAiSchedulerModelParse(raw: unknown): AiSchedulerParse {
  const parsed = modelAiSchedulerParseSchema.parse(raw);
  const warnings = [...parsed.warnings];

  if (parsed.status === "needs_clarification") {
    return {
      status: "needs_clarification",
      clarifyingQuestions: parsed.clarifyingQuestions.length > 0
        ? parsed.clarifyingQuestions
        : ["Can you clarify the date or weekday, time window, and class duration?"],
      partial: compactPartial(parsed.partial),
      warnings,
    };
  }

  if (!parsed.mode) {
    parsed.mode = "either";
    warnings.push("Delivery mode was not specified, so both online and onsite options were considered.");
  }

  const boundedIssues = collectBoundedSearchIssues(parsed);
  if (boundedIssues.length > 0) {
    return {
      status: "needs_clarification",
      clarifyingQuestions: boundedIssues,
      partial: compactPartial({
        searchMode: parsed.searchMode,
        dayOfWeek: parsed.dayOfWeek,
        date: parsed.date,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        durationMinutes: parsed.durationMinutes,
        mode: parsed.mode,
        filters: parsed.filters,
        tutorNames: parsed.tutorNames,
        assumptions: parsed.assumptions,
        parentRequestSummary: parsed.parentRequestSummary,
      }),
      warnings,
    };
  }

  return {
    status: "parsed",
    searchMode: parsed.searchMode!,
    dayOfWeek: nullableToUndefined(parsed.dayOfWeek),
    date: nullableToUndefined(parsed.date),
    startTime: parsed.startTime!,
    endTime: parsed.endTime!,
    durationMinutes: parsed.durationMinutes!,
    mode: parsed.mode,
    filters: compactFilters(parsed.filters),
    tutorNames: parsed.tutorNames,
    assumptions: parsed.assumptions,
    parentRequestSummary: nullableToUndefined(parsed.parentRequestSummary),
    warnings,
  };
}

function normalizeLookup(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function resolveAiSchedulerFilters(
  filters: AiSchedulerParsedRequest["filters"] | undefined,
  options: FilterOptions,
): {
  filters: AiSchedulerParsedRequest["filters"];
  issues: string[];
} {
  return resolveAcademicFilters(filters ?? {}, options);
}

export function resolveAiSchedulerTutorNames(
  tutorNames: string[],
  tutorList: TutorListItem[],
): {
  matchedTutors: AiSchedulerMatchedTutor[];
  issues: string[];
} {
  const issues: string[] = [];
  const matchedTutors: AiSchedulerMatchedTutor[] = [];
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

export function redactAiSchedulerInput(input: string): string {
  return input
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, (match) => {
      const trimmed = match.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return match;
      const withoutPlus = trimmed.replace(/^\+/, "");
      return /\D/.test(withoutPlus) || trimmed.startsWith("+") ? "[phone]" : match;
    })
    .replace(/\b\d{8,}\b/g, "[number]")
    .slice(0, 600);
}

export function bangkokTodayIso(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function aiSchedulerModel(): string {
  return process.env.OPENAI_SCHEDULER_MODEL?.trim() || DEFAULT_AI_SCHEDULER_MODEL;
}

export function isAiSchedulerConfigured(): boolean {
  return process.env.ENABLE_AI_SCHEDULER !== "false" &&
    Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function extractOutputText(payload: OpenAiResponsePayload | null): string {
  if (!payload) {
    throw new Error("OpenAI response was empty");
  }
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if ((content.type === "output_text" || content.type === "text") && content.text?.trim()) {
        return content.text;
      }
    }
  }

  throw new Error("OpenAI response did not include output text");
}

export function buildAiSchedulerPrompt(input: {
  adminInput: string;
  todayBangkok: string;
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
}): string {
  return [
    "Parse the pasted parent/admin scheduling chat into one bounded BeGifted tutor-search request.",
    `Today in Asia/Bangkok is ${input.todayBangkok}. Resolve today, tomorrow, this weekday, and next weekday against this date.`,
    "",
    "Rules:",
    "- Never decide tutor availability. The application will run the Wise-backed search after your parse.",
    "- Return exactly one bounded search. If the thread contains multiple independent students/classes, ask for clarification.",
    "- Use recurring only when the request says every, weekly, recurring, or clearly asks for an ongoing class.",
    "- A bare weekday without recurring/weekly/every/explicit date is ambiguous; return needs_clarification.",
    "- Explicit dates and relative dates are one_time.",
    "- A concrete search needs day/date, start time, end time, and class duration.",
    "- Supported durations are 60, 90, and 120 minutes only; unsupported or missing duration needs clarification.",
    "- If delivery mode is missing, set mode to null. The app will default to either and show a warning.",
    "- Use only subject and curriculum values from the valid lists. Preserve raw level phrases like Y10, Year 5, Grade 10, 11+, or ม.4 in filters.level; the app maps them safely.",
    "- tutorNames may include requested tutor names, but IDs are resolved by the server.",
    "- Support English and Thai parent text.",
    "",
    `Valid subjects: ${input.filterOptions.subjects.join(", ") || "(none)"}`,
    `Valid curriculums: ${input.filterOptions.curriculums.join(", ") || "(none)"}`,
    `Valid levels: ${input.filterOptions.levels.join(", ") || "(none)"}`,
    `Active tutors: ${input.tutorList.map((t) => t.displayName).join(", ") || "(none)"}`,
    "",
    `Pasted request:\n${input.adminInput}`,
  ].join("\n");
}

export async function parseSchedulingRequestWithOpenAi(input: {
  adminInput: string;
  todayBangkok: string;
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
}): Promise<AiSchedulerParse> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || process.env.ENABLE_AI_SCHEDULER === "false") {
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
          content: "You convert BeGifted parent scheduling messages into strict search JSON only.",
        },
        {
          role: "user",
          content: buildAiSchedulerPrompt(input),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "ai_scheduler_parse",
          strict: true,
          schema: openAiSchedulerJsonSchema,
        },
        verbosity: "low",
      },
    }),
  });

  const payload = (await response.json().catch(() => null)) as OpenAiResponsePayload | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `OpenAI returned HTTP ${response.status}`);
  }
  if (!payload) {
    throw new Error("OpenAI response was empty");
  }

  const text = extractOutputText(payload);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("OpenAI response was not valid JSON");
  }

  return normalizeAiSchedulerModelParse(json);
}
