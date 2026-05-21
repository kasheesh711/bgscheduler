import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { loadFilterOptions } from "@/lib/data/filters";
import { loadTutorList } from "@/lib/data/tutors";
import { executeRangeSearch } from "@/lib/search/range-search";
import { formatSlotTime, getRecommendedSlots } from "@/lib/search/recommend";
import {
  aiSchedulerModel,
  aiSchedulerRequestSchema,
  bangkokTodayIso,
  isAiSchedulerConfigured,
  parseSchedulingRequestWithOpenAi,
  redactAiSchedulerInput,
  resolveAiSchedulerFilters,
  resolveAiSchedulerTutorNames,
  type AiSchedulerOption,
  type AiSchedulerParse,
  type AiSchedulerParsedRequest,
  type AiSchedulerResponse,
  type AiSchedulerSolvedRequest,
} from "@/lib/ai/scheduler";

type LogStatus = "solved" | "needs_clarification" | "failed";
type AiSchedulerResponseWithoutLog =
  | Omit<Extract<AiSchedulerResponse, { status: "needs_clarification" }>, "logId">
  | Omit<Extract<AiSchedulerResponse, { status: "solved" }>, "logId">;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function jsonPayload(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

async function writeAiSchedulerRun(
  db: Database,
  input: {
    createdByEmail?: string | null;
    status: LogStatus;
    inputPreviewRedacted: string;
    model: string | null;
    latencyMs: number;
    parsedPayload?: unknown;
    solverPayload?: unknown;
    warnings?: string[];
    errorMessage?: string | null;
  },
): Promise<string> {
  try {
    const [row] = await db
      .insert(schema.aiSchedulerRuns)
      .values({
        createdByEmail: input.createdByEmail ?? null,
        status: input.status,
        inputPreviewRedacted: input.inputPreviewRedacted,
        model: input.model,
        latencyMs: input.latencyMs,
        parsedPayload: jsonPayload(input.parsedPayload),
        solverPayload: jsonPayload(input.solverPayload),
        warnings: input.warnings ?? [],
        errorMessage: input.errorMessage ?? null,
      })
      .returning({ id: schema.aiSchedulerRuns.id });
    return row?.id ?? "unlogged";
  } catch (error) {
    console.error("Failed to write AI scheduler run", error);
    return "unlogged";
  }
}

function parsedFieldsFromParse(parse: Extract<AiSchedulerParse, { status: "parsed" }>): AiSchedulerParsedRequest {
  return {
    searchMode: parse.searchMode,
    dayOfWeek: parse.dayOfWeek,
    date: parse.date,
    startTime: parse.startTime,
    endTime: parse.endTime,
    durationMinutes: parse.durationMinutes,
    mode: parse.mode,
    filters: parse.filters,
    tutorNames: parse.tutorNames,
    assumptions: parse.assumptions,
    parentRequestSummary: parse.parentRequestSummary,
  };
}

function buildOptions(rangeResponse: Awaited<ReturnType<typeof executeRangeSearch>>): AiSchedulerOption[] {
  return getRecommendedSlots(rangeResponse, 5).map((slot, index) => ({
    id: `assistant-option-${slot.subSlotIndex}`,
    rank: index + 1,
    start: slot.start,
    end: slot.end,
    confidence: slot.confidence,
    reasons: slot.reasons,
    tutors: slot.availableTutors.slice(0, 3).map((tutor) => ({
      tutorGroupId: tutor.tutorGroupId,
      displayName: tutor.displayName,
      supportedModes: tutor.supportedModes,
    })),
  }));
}

function dayLabel(parsed: AiSchedulerSolvedRequest): string {
  if (parsed.searchMode === "one_time" && parsed.date) {
    return parsed.date;
  }
  if (parsed.searchMode === "recurring" && parsed.dayOfWeek !== undefined) {
    return `every ${DAY_NAMES[parsed.dayOfWeek]}`;
  }
  return "the requested day";
}

function subjectLabel(parsed: AiSchedulerSolvedRequest): string {
  return [parsed.filters.subject, parsed.filters.curriculum, parsed.filters.level]
    .filter(Boolean)
    .join(" ") || "tuition";
}

function buildParentMessageDraft(parsed: AiSchedulerSolvedRequest, options: AiSchedulerOption[]): string {
  if (options.length === 0) {
    return [
      `Hi! I checked ${subjectLabel(parsed)} for ${dayLabel(parsed)} between ${formatSlotTime(parsed.startTime, parsed.endTime)}.`,
      "I do not have a confirmed available tutor in that window yet. Could you share another day or time range?",
    ].join("\n");
  }

  const lines = options.map((option) => {
    const tutorNames = option.tutors.map((tutor) => tutor.displayName).join(" or ");
    return `• ${dayLabel(parsed)}, ${formatSlotTime(option.start, option.end)}${tutorNames ? ` — ${tutorNames}` : ""}`;
  });

  return [
    `Hi! Here ${options.length === 1 ? "is" : "are"} ${options.length} option${options.length === 1 ? "" : "s"} for ${subjectLabel(parsed)}:`,
    "",
    ...lines,
    "",
    "Let me know which works best and I will confirm.",
  ].join("\n");
}

function clarificationResponse(
  parse: Extract<AiSchedulerParse, { status: "needs_clarification" }>,
): Extract<AiSchedulerResponseWithoutLog, { status: "needs_clarification" }> {
  return {
    status: "needs_clarification",
    partial: parse.partial,
    clarifyingQuestions: parse.clarifyingQuestions,
    warnings: parse.warnings,
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
    const [filterOptions, tutorList] = await Promise.all([
      loadFilterOptions(db),
      loadTutorList(db),
    ]);

    const modelParse = await parseSchedulingRequestWithOpenAi({
      adminInput: parsedBody.data.input,
      todayBangkok: bangkokTodayIso(),
      filterOptions,
      tutorList,
    });

    let responseBody: AiSchedulerResponseWithoutLog;
    let logStatus: LogStatus = modelParse.status === "parsed" ? "solved" : "needs_clarification";
    let warnings = [...modelParse.warnings];

    if (modelParse.status === "needs_clarification") {
      responseBody = clarificationResponse(modelParse);
    } else {
      const parsedFields = parsedFieldsFromParse(modelParse);
      const filterResolution = resolveAiSchedulerFilters(parsedFields.filters, filterOptions);
      const tutorResolution = resolveAiSchedulerTutorNames(parsedFields.tutorNames, tutorList);
      const issues = [...filterResolution.issues, ...tutorResolution.issues];

      if (issues.length > 0) {
        logStatus = "needs_clarification";
        warnings = [...warnings, ...issues];
        responseBody = {
          status: "needs_clarification",
          partial: {
            ...parsedFields,
            filters: filterResolution.filters,
          },
          clarifyingQuestions: issues.map((issue) => issue.includes("Please clarify") ? issue : `${issue} Please clarify.`),
          warnings,
        };
      } else {
        const solvedRequest: AiSchedulerSolvedRequest = {
          ...parsedFields,
          filters: filterResolution.filters,
          tutorGroupIds: tutorResolution.matchedTutors.map((tutor) => tutor.tutorGroupId),
          matchedTutors: tutorResolution.matchedTutors,
        };
        const rangeResponse = await executeRangeSearch(db, {
          searchMode: solvedRequest.searchMode,
          dayOfWeek: solvedRequest.searchMode === "recurring" ? solvedRequest.dayOfWeek : undefined,
          date: solvedRequest.searchMode === "one_time" ? solvedRequest.date : undefined,
          startTime: solvedRequest.startTime,
          endTime: solvedRequest.endTime,
          durationMinutes: solvedRequest.durationMinutes,
          mode: solvedRequest.mode,
          filters: solvedRequest.filters,
          tutorGroupIds: solvedRequest.tutorGroupIds.length > 0 ? solvedRequest.tutorGroupIds : undefined,
        });
        const options = buildOptions(rangeResponse);
        warnings = [...warnings, ...rangeResponse.warnings];
        if (options.length === 0) {
          warnings.push("No proven available tutor options were found in the requested window.");
        }
        responseBody = {
          status: "solved",
          parsedRequest: solvedRequest,
          options,
          parentMessageDraft: buildParentMessageDraft(solvedRequest, options),
          snapshotMeta: rangeResponse.snapshotMeta,
          warnings,
        };
      }
    }

    const logId = await writeAiSchedulerRun(db, {
      createdByEmail: session.user?.email,
      status: logStatus,
      inputPreviewRedacted,
      model,
      latencyMs: Date.now() - startedAt,
      parsedPayload: modelParse,
      solverPayload: responseBody,
      warnings,
    });

    return NextResponse.json({ ...responseBody, logId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI scheduling failed";
    const logId = await writeAiSchedulerRun(db, {
      createdByEmail: session.user?.email,
      status: "failed",
      inputPreviewRedacted,
      model,
      latencyMs: Date.now() - startedAt,
      warnings: [],
      errorMessage: message,
    });
    return NextResponse.json(
      { error: "AI scheduling failed", detail: message, logId },
      { status: 502 },
    );
  }
}
