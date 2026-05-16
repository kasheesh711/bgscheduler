import {
  buildNaturalLanguagePrompt,
  normalizeModelParse,
  openAiNaturalLanguageJsonSchema,
  type NaturalLanguageSearchParse,
} from "@/lib/search/natural-language";
import type { FilterOptions } from "@/lib/data/filters";
import type { TutorListItem } from "@/lib/data/tutors";

export const DEFAULT_NATURAL_LANGUAGE_MODEL = "gpt-5.4-mini";

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

export function naturalLanguageSearchModel(): string {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_NATURAL_LANGUAGE_MODEL;
}

export function isNaturalLanguageSearchConfigured(): boolean {
  return process.env.ENABLE_NATURAL_LANGUAGE_SEARCH !== "false" &&
    Boolean(process.env.OPENAI_API_KEY?.trim());
}

function extractOutputText(payload: OpenAiResponsePayload): string {
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

export async function parseNaturalLanguageSearchWithOpenAi(input: {
  adminInput: string;
  todayBangkok: string;
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
}): Promise<NaturalLanguageSearchParse> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || process.env.ENABLE_NATURAL_LANGUAGE_SEARCH === "false") {
    throw new Error("Natural language search is not configured");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: naturalLanguageSearchModel(),
      input: [
        {
          role: "system",
          content: "You convert admin scheduling text into validated search-form JSON only.",
        },
        {
          role: "user",
          content: buildNaturalLanguagePrompt(input),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "natural_language_search_parse",
          strict: true,
          schema: openAiNaturalLanguageJsonSchema,
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

  return normalizeModelParse(json);
}
