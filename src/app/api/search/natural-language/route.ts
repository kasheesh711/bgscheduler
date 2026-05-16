import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { loadFilterOptions } from "@/lib/data/filters";
import { loadTutorList } from "@/lib/data/tutors";
import {
  bangkokTodayIso,
  naturalLanguageSearchRequestSchema,
  redactNaturalLanguageInput,
  resolveParsedFilters,
  resolveTutorNames,
  type NaturalLanguageSearchParse,
  type NaturalLanguageSearchResponse,
  type ParsedNaturalLanguageFields,
} from "@/lib/search/natural-language";
import {
  isNaturalLanguageSearchConfigured,
  naturalLanguageSearchModel,
  parseNaturalLanguageSearchWithOpenAi,
} from "@/lib/ai/natural-language-search";

type LogStatus = "parsed" | "needs_clarification" | "failed";

function jsonPayload(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

async function writeParseLog(
  db: Database,
  input: {
    createdByEmail?: string | null;
    status: LogStatus;
    inputPreviewRedacted: string;
    model: string | null;
    latencyMs: number;
    parsedPayload?: unknown;
    warnings?: string[];
    errorMessage?: string | null;
  },
): Promise<string> {
  try {
    const [row] = await db
      .insert(schema.naturalLanguageSearchParses)
      .values({
        createdByEmail: input.createdByEmail ?? null,
        status: input.status,
        inputPreviewRedacted: input.inputPreviewRedacted,
        model: input.model,
        latencyMs: input.latencyMs,
        parsedPayload: jsonPayload(input.parsedPayload),
        warnings: input.warnings ?? [],
        errorMessage: input.errorMessage ?? null,
      })
      .returning({ id: schema.naturalLanguageSearchParses.id });
    return row?.id ?? "unlogged";
  } catch (error) {
    console.error("Failed to write natural language search parse log", error);
    return "unlogged";
  }
}

function parsedFieldsFromParse(parse: Extract<NaturalLanguageSearchParse, { status: "parsed" }>): ParsedNaturalLanguageFields {
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

  const parsedBody = naturalLanguageSearchRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  if (!isNaturalLanguageSearchConfigured()) {
    return NextResponse.json(
      { error: "Natural language search is not configured" },
      { status: 503 },
    );
  }

  const db = getDb();
  const startedAt = Date.now();
  const inputPreviewRedacted = redactNaturalLanguageInput(parsedBody.data.input);
  const model = naturalLanguageSearchModel();

  try {
    const [filterOptions, tutorList] = await Promise.all([
      loadFilterOptions(db),
      loadTutorList(db),
    ]);

    const modelParse = await parseNaturalLanguageSearchWithOpenAi({
      adminInput: parsedBody.data.input,
      todayBangkok: bangkokTodayIso(),
      filterOptions,
      tutorList,
    });

    let responseBody: NaturalLanguageSearchResponse;
    let logStatus: LogStatus = modelParse.status;
    let warnings = [...modelParse.warnings];

    if (modelParse.status === "needs_clarification") {
      responseBody = {
        status: "needs_clarification",
        clarifyingQuestions: modelParse.clarifyingQuestions,
        partial: modelParse.partial,
        warnings,
        logId: "",
      };
    } else {
      const parsedFields = parsedFieldsFromParse(modelParse);
      const filterResolution = resolveParsedFilters(parsedFields.filters, filterOptions);
      const tutorResolution = resolveTutorNames(parsedFields.tutorNames, tutorList);
      const issues = [...filterResolution.issues, ...tutorResolution.issues];

      if (issues.length > 0) {
        logStatus = "needs_clarification";
        warnings = [...warnings, ...issues];
        responseBody = {
          status: "needs_clarification",
          clarifyingQuestions: issues.map((issue) => `${issue} Please clarify.`),
          partial: {
            ...parsedFields,
            filters: filterResolution.filters,
          },
          warnings,
          logId: "",
        };
      } else {
        responseBody = {
          status: "parsed",
          parsed: {
            ...parsedFields,
            filters: filterResolution.filters,
            tutorGroupIds: tutorResolution.matchedTutors.map((tutor) => tutor.tutorGroupId),
            matchedTutors: tutorResolution.matchedTutors,
          },
          warnings,
          logId: "",
        };
      }
    }

    const logId = await writeParseLog(db, {
      createdByEmail: session.user?.email,
      status: logStatus,
      inputPreviewRedacted,
      model,
      latencyMs: Date.now() - startedAt,
      parsedPayload: responseBody,
      warnings,
    });

    return NextResponse.json({ ...responseBody, logId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Natural language parsing failed";
    const logId = await writeParseLog(db, {
      createdByEmail: session.user?.email,
      status: "failed",
      inputPreviewRedacted,
      model,
      latencyMs: Date.now() - startedAt,
      warnings: [],
      errorMessage: message,
    });
    return NextResponse.json(
      { error: "Natural language parsing failed", detail: message, logId },
      { status: 502 },
    );
  }
}
