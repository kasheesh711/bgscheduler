import { z } from "zod";
import {
  aiSchedulerModel,
  extractOutputText,
  isAiSchedulerConfigured,
} from "@/lib/ai/scheduler";

export type LineSchedulerClassifierCategory =
  | "scheduling_request"
  | "scheduling_change"
  | "non_scheduling"
  | "unclear";

export interface LineSchedulerClassification {
  category: LineSchedulerClassifierCategory;
  confidence: number;
  summary: string;
  rationale: string;
}

const lineClassificationSchema = z.object({
  category: z.enum(["scheduling_request", "scheduling_change", "non_scheduling", "unclear"]),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(500),
  rationale: z.string().max(800),
}).strict();

export const openAiLineClassificationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "confidence", "summary", "rationale"],
  properties: {
    category: {
      type: "string",
      enum: ["scheduling_request", "scheduling_change", "non_scheduling", "unclear"],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string" },
    rationale: { type: "string" },
  },
} as const;

function buildLineClassificationPrompt(input: {
  messageText: string;
  recentMessages: Array<{ direction: "inbound" | "outbound"; text: string; createdAt: string }>;
}): string {
  const recent = input.recentMessages
    .slice(-8)
    .map((message) => `${message.direction.toUpperCase()} ${message.createdAt}: ${message.text}`)
    .join("\n");

  return [
    "Classify a LINE Official Account parent message for BeGifted scheduling operations.",
    "Return strict JSON only.",
    "",
    "Categories:",
    "- scheduling_request: parent asks for a new class, tutor, time, subject, availability, or options.",
    "- scheduling_change: parent asks to move, cancel, replace, reschedule, switch mode, or change an existing class.",
    "- non_scheduling: greetings, payment, credit, homework, general admin, or non-scheduling chat.",
    "- unclear: possibly scheduling-related but insufficient or ambiguous.",
    "",
    "Rules:",
    "- Support English and Thai.",
    "- If the message includes day/time/tutor/subject/class movement intent, classify as scheduling_request or scheduling_change.",
    "- Do not classify payment/credit/billing questions as scheduling unless they also ask to schedule/change a class.",
    "- Keep summary short and safe for an admin queue.",
    "",
    `Current message:\n${input.messageText}`,
    "",
    `Recent thread context:\n${recent || "(none)"}`,
  ].join("\n");
}

export function normalizeLineSchedulerClassification(raw: unknown): LineSchedulerClassification {
  const parsed = lineClassificationSchema.parse(raw);
  return {
    category: parsed.category,
    confidence: parsed.confidence,
    summary: parsed.summary.trim(),
    rationale: parsed.rationale.trim(),
  };
}

export async function classifyLineSchedulerMessage(input: {
  messageText: string;
  recentMessages: Array<{ direction: "inbound" | "outbound"; text: string; createdAt: string }>;
}): Promise<LineSchedulerClassification> {
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
          content: "You classify BeGifted LINE parent messages for scheduling automation. You never solve availability.",
        },
        {
          role: "user",
          content: buildLineClassificationPrompt(input),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "line_scheduler_classification",
          strict: true,
          schema: openAiLineClassificationJsonSchema,
        },
        verbosity: "low",
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `OpenAI returned HTTP ${response.status}`);
  }
  return normalizeLineSchedulerClassification(JSON.parse(extractOutputText(payload)));
}
