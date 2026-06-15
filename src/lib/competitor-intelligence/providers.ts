import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  extractWebsiteSignals,
  normalizeApifyFacebookItem,
  normalizeApifyInstagramItem,
  normalizeDataForSeoItems,
} from "./normalization";
import type { ProviderFetchResult } from "./types";

type SourceRow = typeof schema.competitorSources.$inferSelect;
type EntityRow = typeof schema.competitorEntities.$inferSelect;
type KeywordRow = typeof schema.competitorSerpKeywords.$inferSelect;

const WEBSITE_TIMEOUT_MS = 10_000;
const APIFY_INSTAGRAM_ACTOR = process.env.APIFY_INSTAGRAM_ACTOR || "apify/instagram-scraper";
const APIFY_FACEBOOK_ACTOR = process.env.APIFY_FACEBOOK_ACTOR || "apify/facebook-posts-scraper";
const DATAFORSEO_BANGKOK_CITY_LOCATION = "Bangkok,Bangkok,Thailand";

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function basicAuth(login: string, password: string): string {
  return Buffer.from(`${login}:${password}`).toString("base64");
}

function dataForSeoLocationName(location: string): string {
  return location.trim().toLowerCase() === "bangkok, thailand"
    ? DATAFORSEO_BANGKOK_CITY_LOCATION
    : location;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = WEBSITE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "BGSchedulerCompetitorIntelligence/1.0",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWebsiteSource(source: SourceRow, entity: EntityRow): Promise<ProviderFetchResult> {
  const response = await fetchWithTimeout(source.url);
  if (!response.ok) {
    throw new Error(`Website fetch failed (${response.status})`);
  }
  const html = await response.text();
  const item = extractWebsiteSignals(html, source.url, entity.slug);
  return {
    items: [item],
    fetchedCount: 1,
    usageUnits: 1,
    estimatedCostUsd: 0,
    metadata: { bytes: html.length },
  };
}

async function runApifyActor(actor: string, body: Record<string, unknown>): Promise<unknown[]> {
  const token = process.env.APIFY_API_TOKEN?.trim();
  if (!token) {
    return [];
  }
  const actorId = actor.replace("/", "~");
  const response = await fetchWithTimeout(
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    60_000,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Apify actor failed (${response.status})${text ? `: ${text.slice(0, 180)}` : ""}`);
  }
  const payload = await response.json().catch(() => []);
  return Array.isArray(payload) ? payload : [];
}

export async function fetchApifySocialSource(source: SourceRow, entity: EntityRow): Promise<ProviderFetchResult> {
  if (!process.env.APIFY_API_TOKEN?.trim()) {
    return {
      items: [],
      fetchedCount: 0,
      usageUnits: 0,
      estimatedCostUsd: 0,
      skippedReason: "APIFY_API_TOKEN is not configured",
    };
  }

  const limit = Number(source.config?.["limit"]) || 12;
  const rawItems = source.sourceType === "instagram"
    ? await runApifyActor(APIFY_INSTAGRAM_ACTOR, {
      directUrls: [source.url],
      resultsType: "posts",
      resultsLimit: limit,
      addParentData: false,
    })
    : await runApifyActor(APIFY_FACEBOOK_ACTOR, {
      startUrls: [{ url: source.url }],
      resultsLimit: limit,
    });
  const items = rawItems.map((item) =>
    source.sourceType === "instagram"
      ? normalizeApifyInstagramItem(item, entity.slug)
      : normalizeApifyFacebookItem(item, entity.slug)
  );
  return {
    items,
    fetchedCount: rawItems.length,
    usageUnits: rawItems.length || 1,
    estimatedCostUsd: (rawItems.length || 1) * envNumber("COMPETITOR_APIFY_COST_PER_ITEM_USD", 0.01),
    metadata: { actor: source.sourceType === "instagram" ? APIFY_INSTAGRAM_ACTOR : APIFY_FACEBOOK_ACTOR },
  };
}

export async function fetchDataForSeoKeyword(keyword: KeywordRow): Promise<ProviderFetchResult> {
  const login = process.env.DATAFORSEO_LOGIN?.trim();
  const password = process.env.DATAFORSEO_PASSWORD?.trim();
  if (!login || !password) {
    return {
      items: [],
      serpObservations: [],
      fetchedCount: 0,
      usageUnits: 0,
      estimatedCostUsd: 0,
      skippedReason: "DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD are not configured",
    };
  }

  const response = await fetchWithTimeout(
    "https://api.dataforseo.com/v3/serp/google/organic/live/regular",
    {
      method: "POST",
      headers: {
        "authorization": `Basic ${basicAuth(login, password)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([{
        keyword: keyword.keyword,
        language_code: keyword.language,
        location_name: dataForSeoLocationName(keyword.location),
        device: keyword.device,
      }]),
    },
    60_000,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DataForSEO request failed (${response.status})${text ? `: ${text.slice(0, 180)}` : ""}`);
  }
  const payload = await response.json().catch(() => null) as {
    tasks?: Array<{ result?: Array<{ items?: unknown[] }> }>;
  } | null;
  const items = payload?.tasks?.[0]?.result?.[0]?.items ?? [];
  return {
    items: [],
    serpObservations: normalizeDataForSeoItems({
      keyword: keyword.keyword,
      language: keyword.language,
      location: keyword.location,
      device: keyword.device,
      items,
    }),
    fetchedCount: items.length,
    usageUnits: 1,
    estimatedCostUsd: envNumber("COMPETITOR_DATAFORSEO_COST_PER_QUERY_USD", 0.002),
    metadata: { provider: "dataforseo", resultCount: items.length },
  };
}

export async function getSeededSerpSource(db: Database): Promise<SourceRow | null> {
  const [row] = await db
    .select()
    .from(schema.competitorSources)
    .where(eq(schema.competitorSources.sourceType, "serp"))
    .limit(1);
  return row ?? null;
}
