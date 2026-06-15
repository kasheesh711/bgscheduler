import { z } from "zod";
import type { CompetitorMatrixRow, NormalizedCompetitorItem } from "./types";

export const COMPETITOR_AI_PROMPT_VERSION = "competitor-intel-2026-06-15-v1";
export const DEFAULT_COMPETITOR_AI_MODEL = "gpt-5.4-mini";

const briefSchema = z.object({
  executiveSummary: z.string(),
  whatChanged: z.array(z.string()).max(8),
  whyItMatters: z.array(z.string()).max(8),
  recommendedResponses: z.array(z.string()).max(8),
  confidence: z.number().min(0).max(1),
  taskSuggestions: z.array(z.object({
    itemKey: z.string().nullable(),
    title: z.string(),
    description: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    labels: z.array(z.string()).max(6),
    confidence: z.number().min(0).max(1),
  })).max(12),
  keywordSuggestions: z.array(z.object({
    keyword: z.string(),
    language: z.enum(["en", "th"]),
    confidence: z.number().min(0).max(1),
  })).max(12),
  competitorSuggestions: z.array(z.object({
    name: z.string(),
    url: z.string().nullable(),
    confidence: z.number().min(0).max(1),
  })).max(8),
});

export type CompetitorAiBrief = z.infer<typeof briefSchema>;

const warRoomInsightSchema = z.object({
  executiveSummary: z.string(),
  confidence: z.number().min(0).max(1),
  contentAngles: z.array(z.object({
    entityId: z.string().nullable(),
    title: z.string(),
    rationale: z.string(),
    suggestedChannel: z.enum(["website", "instagram", "facebook", "multi_channel"]),
    cta: z.string(),
    confidence: z.number().min(0).max(1),
    evidenceItemKeys: z.array(z.string()).max(6),
  })).max(12),
});

export type CompetitorWarRoomAiInsights = z.infer<typeof warRoomInsightSchema>;

interface OpenAiResponsePayload {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
}

export function competitorAiModel(): string {
  return process.env.OPENAI_COMPETITOR_INTEL_MODEL?.trim()
    || process.env.OPENAI_SCHEDULER_MODEL?.trim()
    || DEFAULT_COMPETITOR_AI_MODEL;
}

export function isCompetitorAiConfigured(): boolean {
  return process.env.ENABLE_COMPETITOR_AI !== "false" && Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function deterministicBrief(items: NormalizedCompetitorItem[], briefDate: string): CompetitorAiBrief {
  const sorted = [...items].sort((a, b) => b.impactScore - a.impactScore);
  const top = sorted.slice(0, 5);
  const whatChanged = top.map((item) => `${item.channel}: ${item.title}`);
  const pricingCount = items.filter((item) => item.pricingSignal).length;
  const highImpactCount = items.filter((item) => item.impactScore >= 6).length;
  return {
    executiveSummary: items.length
      ? `${items.length} competitor signals were captured for ${briefDate}. ${highImpactCount} are high impact and ${pricingCount} include pricing or offer evidence.`
      : `No new competitor evidence was captured for ${briefDate}. Check source health for skipped or failed coverage.`,
    whatChanged,
    whyItMatters: [
      pricingCount ? "Pricing and offer changes can affect BeGifted positioning and parent objections." : "Activity volume and messaging shifts indicate where competitors are focusing attention.",
      highImpactCount ? "High-impact moves should be reviewed for marketing or product response." : "No high-impact move crossed the default threshold.",
    ],
    recommendedResponses: top.slice(0, 3).map((item) =>
      item.pricingSignal
        ? `Validate the pricing evidence for "${item.title}" and compare against BeGifted offers.`
        : `Review "${item.title}" and decide whether a response campaign or sales talking point is needed.`
    ),
    confidence: items.length ? 0.66 : 0.5,
    taskSuggestions: top
      .filter((item) => item.impactScore >= 4 || item.pricingSignal)
      .slice(0, 6)
      .map((item) => ({
        itemKey: item.itemKey,
        title: item.pricingSignal ? `Review pricing signal: ${item.title}` : `Review competitor move: ${item.title}`,
        description: item.pricingSignal
          ? "Confirm the evidence and decide whether BeGifted should adjust positioning, sales scripts, or packaging."
          : "Assess the move and decide whether a marketing, admissions, or tutoring response is needed.",
        priority: item.impactScore >= 7 ? "high" : "medium",
        labels: [item.category, item.channel],
        confidence: Math.min(0.9, 0.55 + item.impactScore / 20),
      })),
    keywordSuggestions: [],
    competitorSuggestions: [],
  };
}

export function parseWarRoomAiInsights(value: unknown): CompetitorWarRoomAiInsights {
  return warRoomInsightSchema.parse(value);
}

export function deterministicWarRoomInsights(input: {
  matrix: CompetitorMatrixRow[];
  evidence: NormalizedCompetitorItem[];
}): CompetitorWarRoomAiInsights {
  const topRows = input.matrix.filter((row) => row.kind === "competitor").slice(0, 5);
  const topEvidence = input.evidence
    .filter((item) => item.impactScore >= 4 || item.pricingSignal)
    .slice(0, 12);
  const topNames = topRows.slice(0, 3).map((row) => row.displayName).join(", ") || "tracked competitors";

  return {
    executiveSummary: topRows.length
      ? `${topNames} are driving the highest 90-day channel attention. Prioritize BeGifted content angles that respond to repeated themes, campaign bursts, and offer signals.`
      : "No 90-day competitor channel pattern is ready yet. Add sources or run a sync to build the War Room matrix.",
    confidence: topRows.length ? 0.68 : 0.45,
    contentAngles: topRows.slice(0, 6).map((row, index) => {
      const evidence = topEvidence
        .filter((item) => item.raw?.entitySlug === row.slug || item.title.toLowerCase().includes(row.topTheme.toLowerCase()))
        .slice(0, 3);
      const fallbackEvidence = evidence.length ? evidence : topEvidence.slice(index, index + 2);
      const channel = row.activeChannels.includes("instagram")
        ? "instagram"
        : row.activeChannels.includes("facebook")
          ? "facebook"
          : row.activeChannels.includes("website")
            ? "website"
            : "multi_channel";
      return {
        entityId: row.entityId,
        title: row.recommendedAngle || `Create a BeGifted response angle for ${row.displayName}`,
        rationale: `${row.displayName} shows ${row.burstLabel.toLowerCase()} with a top theme of ${row.topTheme}. ${row.beGiftedGap}`,
        suggestedChannel: channel,
        cta: "Ask parents to book a consultation or message BeGifted for fit guidance.",
        confidence: Math.min(0.9, 0.55 + row.attentionScore / 250),
        evidenceItemKeys: fallbackEvidence.map((item) => item.itemKey),
      };
    }),
  };
}

export async function generateCompetitorBriefWithOpenAi(items: NormalizedCompetitorItem[], briefDate: string): Promise<CompetitorAiBrief> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return deterministicBrief(items, briefDate);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: competitorAiModel(),
      store: false,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "You are building an internal competitor intelligence brief for BeGifted Education in Bangkok.",
                "Use only the provided source facts. Do not invent prices, events, competitors, dates, or rankings.",
                "Return concise executive text and actionable task suggestions.",
              ].join("\n"),
            },
          ],
        },
        {
          role: "user",
          content: [{
            type: "input_text",
            text: JSON.stringify({
              briefDate,
              items: items.slice(0, 80).map((item) => ({
                itemKey: item.itemKey,
                channel: item.channel,
                category: item.category,
                title: item.title,
                summary: item.summary,
                contentText: item.contentText.slice(0, 1000),
                canonicalUrl: item.canonicalUrl,
                impactScore: item.impactScore,
                pricingSignal: item.pricingSignal,
                metrics: item.metrics,
              })),
            }),
          }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "competitor_intelligence_brief",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "executiveSummary",
              "whatChanged",
              "whyItMatters",
              "recommendedResponses",
              "confidence",
              "taskSuggestions",
              "keywordSuggestions",
              "competitorSuggestions",
            ],
            properties: {
              executiveSummary: { type: "string" },
              whatChanged: { type: "array", items: { type: "string" } },
              whyItMatters: { type: "array", items: { type: "string" } },
              recommendedResponses: { type: "array", items: { type: "string" } },
              confidence: { type: "number" },
              taskSuggestions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["itemKey", "title", "description", "priority", "labels", "confidence"],
                  properties: {
                    itemKey: { type: ["string", "null"] },
                    title: { type: "string" },
                    description: { type: "string" },
                    priority: { type: "string", enum: ["low", "medium", "high"] },
                    labels: { type: "array", items: { type: "string" } },
                    confidence: { type: "number" },
                  },
                },
              },
              keywordSuggestions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["keyword", "language", "confidence"],
                  properties: {
                    keyword: { type: "string" },
                    language: { type: "string", enum: ["en", "th"] },
                    confidence: { type: "number" },
                  },
                },
              },
              competitorSuggestions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "url", "confidence"],
                  properties: {
                    name: { type: "string" },
                    url: { type: ["string", "null"] },
                    confidence: { type: "number" },
                  },
                },
              },
            },
          },
        },
        verbosity: "low",
      },
    }),
  });

  const payload = await response.json().catch(() => null) as OpenAiResponsePayload | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `OpenAI competitor brief failed (${response.status})`);
  }
  const text = extractOutputText(payload);
  const parsed = JSON.parse(text) as unknown;
  return briefSchema.parse(parsed);
}

export async function generateWarRoomInsightsWithOpenAi(input: {
  matrix: CompetitorMatrixRow[];
  evidence: NormalizedCompetitorItem[];
  weekStart: string;
  weekEnd: string;
  lookbackStart: string;
  lookbackEnd: string;
}): Promise<CompetitorWarRoomAiInsights> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return deterministicWarRoomInsights(input);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: competitorAiModel(),
      store: false,
      input: [
        {
          role: "system",
          content: [{
            type: "input_text",
            text: [
              "You create a weekly marketing War Room brief for BeGifted Education in Bangkok.",
              "Use only provided matrix rows and evidence facts.",
              "Do not invent prices, rankings, dates, channels, competitors, or campaign claims.",
              "Content angles must be practical planning suggestions, not full ad copy.",
            ].join("\n"),
          }],
        },
        {
          role: "user",
          content: [{
            type: "input_text",
            text: JSON.stringify({
              weekStart: input.weekStart,
              weekEnd: input.weekEnd,
              lookbackStart: input.lookbackStart,
              lookbackEnd: input.lookbackEnd,
              matrix: input.matrix.slice(0, 16),
              evidence: input.evidence.slice(0, 80).map((item) => ({
                itemKey: item.itemKey,
                channel: item.channel,
                category: item.category,
                title: item.title,
                summary: item.summary,
                canonicalUrl: item.canonicalUrl,
                impactScore: item.impactScore,
                pricingSignal: item.pricingSignal,
                metrics: item.metrics,
              })),
            }),
          }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "competitor_war_room_weekly_insights",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["executiveSummary", "confidence", "contentAngles"],
            properties: {
              executiveSummary: { type: "string" },
              confidence: { type: "number" },
              contentAngles: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["entityId", "title", "rationale", "suggestedChannel", "cta", "confidence", "evidenceItemKeys"],
                  properties: {
                    entityId: { type: ["string", "null"] },
                    title: { type: "string" },
                    rationale: { type: "string" },
                    suggestedChannel: {
                      type: "string",
                      enum: ["website", "instagram", "facebook", "multi_channel"],
                    },
                    cta: { type: "string" },
                    confidence: { type: "number" },
                    evidenceItemKeys: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        verbosity: "low",
      },
    }),
  });

  const payload = await response.json().catch(() => null) as OpenAiResponsePayload | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `OpenAI War Room insights failed (${response.status})`);
  }
  const text = extractOutputText(payload);
  return parseWarRoomAiInsights(JSON.parse(text) as unknown);
}

function extractOutputText(payload: OpenAiResponsePayload | null): string {
  if (!payload) throw new Error("OpenAI response was empty");
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
