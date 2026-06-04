// Progress Tests — AI summary of a teacher's recent per-class feedback.
//
// Mirrors the OpenAI Responses pattern in src/lib/ai/scheduler.ts (structured
// json_schema output, reasoning effort "low") and reuses its exported
// `extractOutputText` so both modules parse the same payload shape. Fail-closed
// on content (PT-AI-01): sparse/empty feedback short-circuits BEFORE any API
// call and never fabricates; disabled/no-key returns skipped; any error returns
// failed. Never log the feedback text — only the error message + a non-PII
// context (the note count).

import { z } from "zod";
import { DEFAULT_AI_SCHEDULER_MODEL, extractOutputText } from "@/lib/ai/scheduler";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import type { ProgressTestAiSummary, ProgressTestAiSummaryResult } from "./types";

/** One attended-with-credit class note fed into the summary. */
export interface ProgressTestFeedbackNote {
  scheduledStartTime: Date;
  teacherFeedback: string;
}

/** Most recent N notes to consider; the model never sees more than this. */
const MAX_NOTES = 8;
/** A summary needs at least this many non-empty notes, else it is sparse. */
const MIN_MEANINGFUL_NOTES = 2;
/** A summary needs at least this much combined feedback text, else it is sparse. */
const MIN_TOTAL_CHARS = 80;
/** Per-note feedback is truncated to this many characters in the prompt. */
const MAX_NOTE_CHARS = 1500;

const progressTestAiSummarySchema = z
  .object({
    headline: z.string(),
    strengths: z.array(z.string()),
    focusAreas: z.array(z.string()),
    recommendation: z.string(),
  })
  .strict();

const openAiProgressTestSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "strengths", "focusAreas", "recommendation"],
  properties: {
    headline: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    focusAreas: { type: "array", items: { type: "string" } },
    recommendation: { type: "string" },
  },
} as const;

/** Structurally compatible with scheduler's non-exported OpenAiResponsePayload. */
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

/**
 * Whether the progress-test AI summary is configured for this environment.
 *
 * Mirrors isAiSchedulerConfigured() (src/lib/ai/scheduler.ts): requires an
 * OpenAI key and the shared ENABLE_AI_SCHEDULER flag not set to "false".
 *
 * @returns true only when OPENAI_API_KEY is present and AI is not disabled.
 */
export function isProgressTestAiConfigured(): boolean {
  return (
    process.env.ENABLE_AI_SCHEDULER !== "false" &&
    Boolean(process.env.OPENAI_API_KEY?.trim())
  );
}

/**
 * Model used for the progress-test summary.
 *
 * @returns OPENAI_PROGRESS_TEST_MODEL when set, else the scheduler default.
 */
export function progressTestAiModel(): string {
  return process.env.OPENAI_PROGRESS_TEST_MODEL?.trim() || DEFAULT_AI_SCHEDULER_MODEL;
}

/** Trims and collapses internal whitespace in a feedback string. */
function normalizeFeedback(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Selects the meaningful notes to summarize from a teacher's recent classes.
 *
 * 1. Keep only the last MAX_NOTES (the freshest classes).
 * 2. Normalize whitespace and drop notes whose feedback is empty.
 * 3. Sort most-recent-first so the prompt leads with the latest class.
 *
 * @returns the cleaned, most-recent-first notes (feedback already normalized).
 */
function selectMeaningfulNotes(
  notes: ProgressTestFeedbackNote[],
): ProgressTestFeedbackNote[] {
  return notes
    .slice(-MAX_NOTES)
    .map((note) => ({
      scheduledStartTime: note.scheduledStartTime,
      teacherFeedback: normalizeFeedback(note.teacherFeedback),
    }))
    .filter((note) => note.teacherFeedback.length > 0)
    .sort((a, b) => b.scheduledStartTime.getTime() - a.scheduledStartTime.getTime());
}

/**
 * Builds the user-message prompt: the meaningful notes most-recent-first, each
 * Bangkok-dated and truncated to MAX_NOTE_CHARS.
 *
 * @returns the multi-line prompt body listing the dated feedback notes.
 */
function buildProgressTestSummaryPrompt(notes: ProgressTestFeedbackNote[]): string {
  const lines = notes.map((note, index) => {
    const date = formatBangkokDateTime(note.scheduledStartTime, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const feedback = note.teacherFeedback.slice(0, MAX_NOTE_CHARS);
    return `Class ${index + 1} (${date}): ${feedback}`;
  });

  return [
    "Summarize this teacher's own feedback across their student's recent classes",
    "to help the teacher prepare a progress test and brief the student.",
    "Use ONLY the notes below. Do not invent details that are not present.",
    "If the notes are thin, return fewer or empty bullets rather than guessing.",
    "",
    "Teacher feedback notes (most recent first):",
    ...lines,
  ].join("\n");
}

/**
 * Generates a structured AI summary of a teacher's recent per-class feedback.
 *
 * 1. Gate on configuration (OPENAI_API_KEY + ENABLE_AI_SCHEDULER) → skipped.
 * 2. Select meaningful notes; if fewer than MIN_MEANINGFUL_NOTES or under
 *    MIN_TOTAL_CHARS of combined feedback → sparse (NO API call, no fabrication).
 * 3. POST the Responses API with strict json_schema structured output, reasoning
 *    effort "low", mirroring the AI scheduler.
 * 4. Parse with extractOutputText + JSON.parse + a strict Zod safeParse; any
 *    failure (HTTP, parse, schema) → failed. Never throws; logs only the error
 *    message + the note count (never the feedback text).
 *
 * @param notes - attended-with-credit classes carrying the teacher's feedback.
 * @returns a fail-closed result union: ok | sparse | skipped | failed.
 */
export async function generateProgressTestSummary(
  notes: ProgressTestFeedbackNote[],
): Promise<ProgressTestAiSummaryResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!isProgressTestAiConfigured() || !apiKey) {
    return { status: "skipped", reason: "AI summary is not configured" };
  }

  const meaningfulNotes = selectMeaningfulNotes(notes);
  const totalChars = meaningfulNotes.reduce(
    (sum, note) => sum + note.teacherFeedback.length,
    0,
  );
  if (meaningfulNotes.length < MIN_MEANINGFUL_NOTES || totalChars < MIN_TOTAL_CHARS) {
    return {
      status: "sparse",
      reason: "Not enough teacher feedback to summarize",
      sessionsUsed: meaningfulNotes.length,
    };
  }

  const model = progressTestAiModel();

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: {
          effort: "low",
        },
        input: [
          {
            role: "system",
            content:
              "You summarize a tutor's own per-class feedback for a student into a short progress-test brief. Use only the provided notes; never fabricate. Prefer fewer or empty bullets over guessing.",
          },
          {
            role: "user",
            content: buildProgressTestSummaryPrompt(meaningfulNotes),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "progress_test_summary",
            strict: true,
            schema: openAiProgressTestSummaryJsonSchema,
          },
          verbosity: "low",
        },
      }),
    });

    const payload = (await response.json().catch(() => null)) as OpenAiResponsePayload | null;
    if (!response.ok) {
      return {
        status: "failed",
        error: payload?.error?.message ?? `OpenAI returned HTTP ${response.status}`,
      };
    }

    const text = extractOutputText(payload);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: "failed", error: "OpenAI response was not valid JSON" };
    }

    const parsed = progressTestAiSummarySchema.safeParse(json);
    if (!parsed.success) {
      return { status: "failed", error: "OpenAI response did not match the summary schema" };
    }

    const summary: ProgressTestAiSummary = {
      headline: parsed.data.headline,
      strengths: parsed.data.strengths,
      focusAreas: parsed.data.focusAreas,
      recommendation: parsed.data.recommendation,
    };

    return { status: "ok", summary, model, sessionsUsed: meaningfulNotes.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Failed to generate progress-test summary";
    console.error(`progress-test ai-summary failed (notes=${meaningfulNotes.length}): ${error}`);
    return { status: "failed", error };
  }
}
