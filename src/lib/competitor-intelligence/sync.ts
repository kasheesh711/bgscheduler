import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  COMPETITOR_AI_PROMPT_VERSION,
  competitorAiModel,
  deterministicBrief,
  generateCompetitorBriefWithOpenAi,
  isCompetitorAiConfigured,
} from "./ai";
import { monthStartIso, providerHardCapUsd, wouldExceedBudget } from "./budget";
import {
  findEvidenceItemsByKeys,
  listActiveCompetitorSources,
  listActiveSerpKeywords,
  loadEntitiesByDomain,
  seedDefaultCompetitorSources,
  upsertDiscoveredKeyword,
} from "./data";
import { stableHash } from "./normalization";
import {
  fetchApifySocialSource,
  fetchDataForSeoKeyword,
  fetchWebsiteSource,
  getSeededSerpSource,
} from "./providers";
import { regenerateWarRoomSnapshot } from "./war-room";
import type {
  CompetitorSourceType,
  CompetitorSyncTrigger,
  NormalizedCompetitorItem,
  NormalizedSerpObservation,
  ProviderFetchResult,
} from "./types";

type SourceRow = typeof schema.competitorSources.$inferSelect;
type EntityRow = typeof schema.competitorEntities.$inferSelect;
type KeywordRow = typeof schema.competitorSerpKeywords.$inferSelect;

export const STALE_RUNNING_COMPETITOR_SYNC_MS = 20 * 60 * 1000;
const STALE_RUNNING_COMPETITOR_SYNC_ERROR =
  "Competitor intelligence sync marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.";

interface RunCounts {
  sourceCount: number;
  sourceSuccessCount: number;
  sourceFailedCount: number;
  sourceSkippedCount: number;
  itemCount: number;
  newItemCount: number;
  assetCount: number;
  aiRunCount: number;
  taskSuggestionCount: number;
  budgetSkippedCount: number;
}

export interface CompetitorSyncResult extends RunCounts {
  runId: string;
  status: "success" | "failed";
  seeded: {
    entities: number;
    sources: number;
    keywords: number;
  };
  errorSummary: string | null;
}

function bangkokDateIso(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}

export async function failStaleRunningCompetitorSyncs(db: Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_COMPETITOR_SYNC_MS);
  const staleRuns = await db
    .update(schema.competitorSyncRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorSummary: STALE_RUNNING_COMPETITOR_SYNC_ERROR,
    })
    .where(and(
      eq(schema.competitorSyncRuns.status, "running"),
      lt(schema.competitorSyncRuns.startedAt, cutoff),
    ))
    .returning({ id: schema.competitorSyncRuns.id });

  const staleRunIds = staleRuns.map((row) => row.id);
  if (!staleRunIds.length) return 0;

  await Promise.all([
    db.update(schema.competitorSourceRuns)
      .set({
        status: "failed",
        finishedAt: now,
        errorSummary: STALE_RUNNING_COMPETITOR_SYNC_ERROR,
      })
      .where(and(
        eq(schema.competitorSourceRuns.status, "running"),
        inArray(schema.competitorSourceRuns.syncRunId, staleRunIds),
      )),
    db.update(schema.competitorAiRuns)
      .set({
        status: "failed",
        finishedAt: now,
        errorSummary: STALE_RUNNING_COMPETITOR_SYNC_ERROR,
      })
      .where(and(
        eq(schema.competitorAiRuns.status, "running"),
        inArray(schema.competitorAiRuns.syncRunId, staleRunIds),
      )),
  ]);

  return staleRunIds.length;
}

function sourceEstimateUsd(source: SourceRow): number {
  if (source.sourceType === "instagram" || source.sourceType === "facebook") {
    const limit = Number(source.config?.["limit"]) || 12;
    const cost = Number(process.env.COMPETITOR_APIFY_COST_PER_ITEM_USD ?? 0.01);
    return limit * (Number.isFinite(cost) ? cost : 0.01);
  }
  return 0;
}

function serpEstimateUsd(): number {
  const cost = Number(process.env.COMPETITOR_DATAFORSEO_COST_PER_QUERY_USD ?? 0.002);
  return Number.isFinite(cost) ? cost : 0.002;
}

async function budgetWouldBlock(
  db: Database,
  provider: string,
  sourceType: CompetitorSourceType,
  nextEstimatedCostUsd: number,
) {
  const usageMonth = monthStartIso();
  const [row] = await db
    .select()
    .from(schema.competitorVendorUsage)
    .where(and(
      eq(schema.competitorVendorUsage.usageMonth, usageMonth),
      eq(schema.competitorVendorUsage.provider, provider),
      eq(schema.competitorVendorUsage.sourceType, sourceType),
    ))
    .limit(1);
  const hardCapUsd = providerHardCapUsd(provider, sourceType);
  return wouldExceedBudget({
    provider,
    sourceType,
    usageMonth,
    hardCapUsd,
    estimatedCostUsd: row?.estimatedCostUsd ?? 0,
  }, nextEstimatedCostUsd);
}

async function recordVendorUsage(
  db: Database,
  input: {
    provider: string;
    sourceType: CompetitorSourceType;
    usageUnits: number;
    estimatedCostUsd: number;
  },
) {
  if (input.usageUnits <= 0 && input.estimatedCostUsd <= 0) return;
  const usageMonth = monthStartIso();
  const hardCapUsd = providerHardCapUsd(input.provider, input.sourceType);
  const [current] = await db
    .select()
    .from(schema.competitorVendorUsage)
    .where(and(
      eq(schema.competitorVendorUsage.usageMonth, usageMonth),
      eq(schema.competitorVendorUsage.provider, input.provider),
      eq(schema.competitorVendorUsage.sourceType, input.sourceType),
    ))
    .limit(1);
  const usageUnits = (current?.usageUnits ?? 0) + input.usageUnits;
  const estimatedCostUsd = (current?.estimatedCostUsd ?? 0) + input.estimatedCostUsd;
  await db.insert(schema.competitorVendorUsage)
    .values({
      usageMonth,
      provider: input.provider,
      sourceType: input.sourceType,
      usageUnits,
      estimatedCostUsd,
      hardCapUsd,
      capped: hardCapUsd > 0 && estimatedCostUsd >= hardCapUsd,
    })
    .onConflictDoUpdate({
      target: [
        schema.competitorVendorUsage.usageMonth,
        schema.competitorVendorUsage.provider,
        schema.competitorVendorUsage.sourceType,
      ],
      set: {
        usageUnits,
        estimatedCostUsd,
        hardCapUsd,
        capped: hardCapUsd > 0 && estimatedCostUsd >= hardCapUsd,
        updatedAt: new Date(),
      },
    });
}

async function fetchSource(source: SourceRow, entity: EntityRow): Promise<ProviderFetchResult> {
  if (source.sourceType === "website" || source.sourceType === "sitemap") {
    return fetchWebsiteSource(source, entity);
  }
  if (source.sourceType === "instagram" || source.sourceType === "facebook") {
    return fetchApifySocialSource(source, entity);
  }
  return {
    items: [],
    fetchedCount: 0,
    usageUnits: 0,
    estimatedCostUsd: 0,
    skippedReason: `${source.sourceType} sources are handled by their dedicated provider path`,
  };
}

async function storeEvidenceItems(
  db: Database,
  input: {
    source: SourceRow;
    sourceRunId: string;
    entityId: string;
    items: NormalizedCompetitorItem[];
  },
) {
  if (input.items.length === 0) return { itemCount: 0, newItemCount: 0, assetCount: 0 };
  const existing = await findEvidenceItemsByKeys(input.items.map((item) => item.itemKey), db);
  const existingKeys = new Set(existing.map((item) => item.itemKey));
  let assetCount = 0;

  for (const item of input.items) {
    const [row] = await db.insert(schema.competitorEvidenceItems)
      .values({
        itemKey: item.itemKey,
        entityId: input.entityId,
        sourceId: input.source.id,
        sourceRunId: input.sourceRunId,
        channel: item.channel,
        category: item.category,
        title: item.title,
        summary: item.summary,
        contentText: item.contentText,
        canonicalUrl: item.canonicalUrl,
        language: item.language,
        observedAt: new Date(),
        publishedAt: item.publishedAt,
        impactScore: item.impactScore,
        confidence: item.confidence,
        evidenceStatus: "captured",
        reviewStatus: "new",
        pricingSignal: item.pricingSignal,
        metrics: item.metrics,
        raw: item.raw,
      })
      .onConflictDoUpdate({
        target: schema.competitorEvidenceItems.itemKey,
        set: {
          sourceId: input.source.id,
          sourceRunId: input.sourceRunId,
          category: item.category,
          title: item.title,
          summary: item.summary,
          contentText: item.contentText,
          canonicalUrl: item.canonicalUrl,
          language: item.language,
          observedAt: new Date(),
          publishedAt: item.publishedAt,
          impactScore: item.impactScore,
          confidence: item.confidence,
          pricingSignal: item.pricingSignal,
          metrics: item.metrics,
          raw: item.raw,
          updatedAt: new Date(),
        },
      })
      .returning();

    for (const assetUrl of item.assetUrls.slice(0, 4)) {
      const [asset] = await db.insert(schema.competitorAssets)
        .values({
          itemId: row.id,
          assetType: /\.(mp4|mov|webm)(?:$|\?)/i.test(assetUrl) ? "video" : "image",
          storageProvider: "source_url",
          storageKey: `source:${stableHash(assetUrl)}`,
          sourceUrl: assetUrl,
          metadata: { archiveStatus: "blob_not_configured" },
        })
        .onConflictDoNothing()
        .returning();
      if (asset) assetCount += 1;
    }
  }

  return {
    itemCount: input.items.length,
    newItemCount: input.items.filter((item) => !existingKeys.has(item.itemKey)).length,
    assetCount,
  };
}

function entityIdForObservation(observation: NormalizedSerpObservation, domainPairs: Array<[string, string]>): string | null {
  const haystack = `${observation.url ?? ""} ${observation.displayUrl ?? ""} ${observation.title ?? ""}`.toLowerCase();
  const match = domainPairs.find(([key]) => key && haystack.includes(key.toLowerCase()));
  return match?.[1] ?? null;
}

async function storeSerpObservations(
  db: Database,
  input: {
    keyword: KeywordRow;
    sourceRunId: string;
    observations: NormalizedSerpObservation[];
    domainPairs: Array<[string, string]>;
  },
) {
  let inserted = 0;
  for (const observation of input.observations) {
    const [row] = await db.insert(schema.competitorSerpObservations)
      .values({
        observationKey: observation.observationKey,
        keywordId: input.keyword.id,
        entityId: entityIdForObservation(observation, input.domainPairs),
        sourceRunId: input.sourceRunId,
        observedAt: new Date(),
        keyword: observation.keyword,
        language: observation.language,
        location: observation.location,
        device: observation.device,
        resultType: observation.resultType,
        rankAbsolute: observation.rankAbsolute,
        rankGroup: observation.rankGroup,
        title: observation.title,
        url: observation.url,
        displayUrl: observation.displayUrl,
        snippet: observation.snippet,
        isBeGifted: observation.isBeGifted,
        raw: observation.raw,
      })
      .onConflictDoNothing()
      .returning();
    if (row) inserted += 1;
  }
  return inserted;
}

async function sourceHealth(db: Database) {
  const rows = await db.select().from(schema.competitorSources);
  const active = rows.filter((row) => row.status === "active");
  const healthy = active.filter((row) => !row.lastError);
  const byType = active.reduce<Record<string, { active: number; healthy: number }>>((acc, row) => {
    acc[row.sourceType] ??= { active: 0, healthy: 0 };
    acc[row.sourceType].active += 1;
    if (!row.lastError) acc[row.sourceType].healthy += 1;
    return acc;
  }, {});
  return {
    active: active.length,
    healthy: healthy.length,
    failed: active.length - healthy.length,
    byType,
  };
}

async function seoVisibilityScore(db: Database): Promise<number> {
  const observations = await db
    .select()
    .from(schema.competitorSerpObservations)
    .orderBy(desc(schema.competitorSerpObservations.observedAt))
    .limit(300);
  const byKeyword = new Map<string, number[]>();
  for (const row of observations) {
    if (!row.isBeGifted || row.rankAbsolute === null) continue;
    const key = `${row.keyword}|${row.language}|${row.location}|${row.device}`;
    const ranks = byKeyword.get(key) ?? [];
    ranks.push(row.rankAbsolute);
    byKeyword.set(key, ranks);
  }
  const scores = [...byKeyword.values()].map((ranks) => {
    const best = Math.min(...ranks);
    return Math.max(0, 100 - (best - 1) * 5);
  });
  if (scores.length === 0) return 0;
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

async function budgetRatio(db: Database): Promise<number> {
  const usageMonth = monthStartIso();
  const rows = await db
    .select()
    .from(schema.competitorVendorUsage)
    .where(eq(schema.competitorVendorUsage.usageMonth, usageMonth));
  const cap = rows.reduce((sum, row) => sum + row.hardCapUsd, 0);
  const cost = rows.reduce((sum, row) => sum + row.estimatedCostUsd, 0);
  return cap > 0 ? Math.min(1, cost / cap) : 0;
}

async function insertTaskSuggestions(
  db: Database,
  input: {
    briefId: string;
    aiRunId: string;
    suggestions: Array<{
      itemKey: string | null;
      title: string;
      description: string;
      priority: "low" | "medium" | "high";
      labels: string[];
      confidence: number;
    }>;
  },
) {
  const itemKeys = input.suggestions.map((suggestion) => suggestion.itemKey).filter(Boolean) as string[];
  const items = await findEvidenceItemsByKeys(itemKeys, db);
  const itemByKey = new Map(items.map((item) => [item.itemKey, item.id]));
  let inserted = 0;

  for (const suggestion of input.suggestions) {
    const itemId = suggestion.itemKey ? itemByKey.get(suggestion.itemKey) ?? null : null;
    const [existing] = await db
      .select()
      .from(schema.competitorTaskSuggestions)
      .where(and(
        eq(schema.competitorTaskSuggestions.title, suggestion.title),
        itemId
          ? eq(schema.competitorTaskSuggestions.itemId, itemId)
          : sql`${schema.competitorTaskSuggestions.itemId} IS NULL`,
        eq(schema.competitorTaskSuggestions.status, "suggested"),
      ))
      .limit(1);
    if (existing) continue;

    await db.insert(schema.competitorTaskSuggestions).values({
      briefId: input.briefId,
      itemId,
      aiRunId: input.aiRunId,
      title: suggestion.title,
      description: suggestion.description,
      priority: suggestion.priority,
      labels: suggestion.labels,
      confidence: suggestion.confidence,
    });
    inserted += 1;
  }
  return inserted;
}

async function upsertDiscoveredCompetitors(
  db: Database,
  suggestions: Array<{ name: string; url: string | null; confidence: number }>,
) {
  for (const suggestion of suggestions.filter((item) => item.confidence >= 0.8)) {
    const slug = suggestion.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `ai-${stableHash(suggestion.name)}`;
    await db.insert(schema.competitorEntities)
      .values({
        slug,
        displayName: suggestion.name,
        kind: "competitor",
        categoryTags: ["auto-discovered"],
        websiteUrl: suggestion.url,
        confidence: suggestion.confidence,
        discoveredBy: "ai",
        discoveryMetadata: { needsReview: true },
        active: false,
      })
      .onConflictDoUpdate({
        target: schema.competitorEntities.slug,
        set: {
          confidence: sql`greatest(${schema.competitorEntities.confidence}, ${suggestion.confidence})`,
          discoveryMetadata: { needsReview: true, latestSuggestedUrl: suggestion.url },
          updatedAt: new Date(),
        },
      });
  }
}

export async function runCompetitorIntelligenceSync(input: {
  triggerType: CompetitorSyncTrigger;
  actorEmail?: string | null;
  db?: Database;
}): Promise<CompetitorSyncResult> {
  const db = input.db ?? getDb();
  const actorEmail = input.actorEmail ?? (input.triggerType === "cron" ? "cron@begifted.local" : null);
  await failStaleRunningCompetitorSyncs(db, new Date());
  const [running] = await db
    .select()
    .from(schema.competitorSyncRuns)
    .where(eq(schema.competitorSyncRuns.status, "running"))
    .limit(1);
  if (running) {
    throw new Error("Competitor intelligence sync is already running");
  }
  const [run] = await db.insert(schema.competitorSyncRuns)
    .values({
      triggerType: input.triggerType,
      actorEmail,
    })
    .returning();

  const counts: RunCounts = {
    sourceCount: 0,
    sourceSuccessCount: 0,
    sourceFailedCount: 0,
    sourceSkippedCount: 0,
    itemCount: 0,
    newItemCount: 0,
    assetCount: 0,
    aiRunCount: 0,
    taskSuggestionCount: 0,
    budgetSkippedCount: 0,
  };
  const errors: string[] = [];
  const capturedItems: NormalizedCompetitorItem[] = [];
  let aiFailed = false;
  let warRoomFailed = false;
  let seeded = { entities: 0, sources: 0, keywords: 0 };

  try {
    seeded = await seedDefaultCompetitorSources(actorEmail, db);
    const sources = await listActiveCompetitorSources(db);
    counts.sourceCount += sources.filter((row) => row.source.sourceType !== "serp").length;

    for (const { source, entity } of sources) {
      if (source.sourceType === "serp") continue;
      const [sourceRun] = await db.insert(schema.competitorSourceRuns)
        .values({
          syncRunId: run.id,
          sourceId: source.id,
          entityId: entity.id,
          provider: source.provider,
          sourceType: source.sourceType,
        })
        .returning();
      await db.update(schema.competitorSources)
        .set({ lastRunAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.competitorSources.id, source.id));

      const estimate = sourceEstimateUsd(source);
      if (await budgetWouldBlock(db, source.provider, source.sourceType, estimate)) {
        const skippedReason = "Monthly vendor budget cap reached";
        counts.sourceSkippedCount += 1;
        counts.budgetSkippedCount += 1;
        await Promise.all([
          db.update(schema.competitorSourceRuns)
            .set({ status: "success", finishedAt: new Date(), skippedReason })
            .where(eq(schema.competitorSourceRuns.id, sourceRun.id)),
          db.update(schema.competitorSources)
            .set({ lastError: skippedReason, updatedAt: new Date() })
            .where(eq(schema.competitorSources.id, source.id)),
        ]);
        continue;
      }

      try {
        const result = await fetchSource(source, entity);
        await recordVendorUsage(db, {
          provider: source.provider,
          sourceType: source.sourceType,
          usageUnits: result.usageUnits,
          estimatedCostUsd: result.estimatedCostUsd,
        });
        const stored = await storeEvidenceItems(db, {
          source,
          sourceRunId: sourceRun.id,
          entityId: entity.id,
          items: result.items,
        });
        capturedItems.push(...result.items);
        counts.itemCount += stored.itemCount;
        counts.newItemCount += stored.newItemCount;
        counts.assetCount += stored.assetCount;
        if (result.skippedReason) counts.sourceSkippedCount += 1;
        else counts.sourceSuccessCount += 1;
        await Promise.all([
          db.update(schema.competitorSourceRuns)
            .set({
              status: "success",
              finishedAt: new Date(),
              fetchedCount: result.fetchedCount,
              itemCount: stored.itemCount,
              newItemCount: stored.newItemCount,
              assetCount: stored.assetCount,
              skippedReason: result.skippedReason,
              usageUnits: result.usageUnits,
              estimatedCostUsd: result.estimatedCostUsd,
              metadata: result.metadata ?? {},
            })
            .where(eq(schema.competitorSourceRuns.id, sourceRun.id)),
          db.update(schema.competitorSources)
            .set({
              lastSuccessAt: result.skippedReason ? source.lastSuccessAt : new Date(),
              lastError: result.skippedReason ?? null,
              updatedAt: new Date(),
            })
            .where(eq(schema.competitorSources.id, source.id)),
        ]);
      } catch (error) {
        const message = compactError(error);
        counts.sourceFailedCount += 1;
        errors.push(`${entity.displayName} ${source.sourceType}: ${message}`);
        await Promise.all([
          db.update(schema.competitorSourceRuns)
            .set({ status: "failed", finishedAt: new Date(), errorSummary: message })
            .where(eq(schema.competitorSourceRuns.id, sourceRun.id)),
          db.update(schema.competitorSources)
            .set({ lastError: message, updatedAt: new Date() })
            .where(eq(schema.competitorSources.id, source.id)),
        ]);
      }
    }

    const serpSource = await getSeededSerpSource(db);
    const keywords = serpSource ? await listActiveSerpKeywords(db) : [];
    const domainPairs = await loadEntitiesByDomain(db);
    counts.sourceCount += keywords.length;
    for (const keyword of keywords) {
      if (!serpSource) break;
      const [sourceRun] = await db.insert(schema.competitorSourceRuns)
        .values({
          syncRunId: run.id,
          sourceId: serpSource.id,
          entityId: serpSource.entityId,
          provider: "dataforseo",
          sourceType: "serp",
          metadata: { keywordId: keyword.id, keyword: keyword.keyword },
        })
        .returning();
      const estimate = serpEstimateUsd();
      if (await budgetWouldBlock(db, "dataforseo", "serp", estimate)) {
        const skippedReason = "Monthly SERP budget cap reached";
        counts.sourceSkippedCount += 1;
        counts.budgetSkippedCount += 1;
        await db.update(schema.competitorSourceRuns)
          .set({ status: "success", finishedAt: new Date(), skippedReason })
          .where(eq(schema.competitorSourceRuns.id, sourceRun.id));
        continue;
      }

      try {
        const result = await fetchDataForSeoKeyword(keyword);
        await recordVendorUsage(db, {
          provider: "dataforseo",
          sourceType: "serp",
          usageUnits: result.usageUnits,
          estimatedCostUsd: result.estimatedCostUsd,
        });
        const observations = result.serpObservations ?? [];
        const inserted = await storeSerpObservations(db, {
          keyword,
          sourceRunId: sourceRun.id,
          observations,
          domainPairs,
        });
        if (result.skippedReason) counts.sourceSkippedCount += 1;
        else counts.sourceSuccessCount += 1;
        await db.update(schema.competitorSourceRuns)
          .set({
            status: "success",
            finishedAt: new Date(),
            fetchedCount: result.fetchedCount,
            itemCount: observations.length,
            newItemCount: inserted,
            skippedReason: result.skippedReason,
            usageUnits: result.usageUnits,
            estimatedCostUsd: result.estimatedCostUsd,
            metadata: { ...(result.metadata ?? {}), keywordId: keyword.id },
          })
          .where(eq(schema.competitorSourceRuns.id, sourceRun.id));
      } catch (error) {
        const message = compactError(error);
        counts.sourceFailedCount += 1;
        errors.push(`${keyword.keyword} SERP: ${message}`);
        await db.update(schema.competitorSourceRuns)
          .set({ status: "failed", finishedAt: new Date(), errorSummary: message })
          .where(eq(schema.competitorSourceRuns.id, sourceRun.id));
      }
    }

    const aiStartedAt = Date.now();
    const [aiRun] = await db.insert(schema.competitorAiRuns)
      .values({
        syncRunId: run.id,
        runType: "daily_brief",
        model: competitorAiModel(),
        promptVersion: COMPETITOR_AI_PROMPT_VERSION,
        inputItemCount: capturedItems.length,
      })
      .returning();
    counts.aiRunCount = 1;
    try {
      const briefDate = bangkokDateIso();
      const aiBrief = isCompetitorAiConfigured()
        ? await generateCompetitorBriefWithOpenAi(capturedItems, briefDate)
        : deterministicBrief(capturedItems, briefDate);
      await db.update(schema.competitorAiRuns)
        .set({
          status: "success",
          output: aiBrief,
          finishedAt: new Date(),
          latencyMs: Date.now() - aiStartedAt,
        })
        .where(eq(schema.competitorAiRuns.id, aiRun.id));

      for (const keyword of aiBrief.keywordSuggestions.filter((item) => item.confidence >= 0.7)) {
        await upsertDiscoveredKeyword(keyword, db);
      }
      await upsertDiscoveredCompetitors(db, aiBrief.competitorSuggestions);

      const health = await sourceHealth(db);
      const [brief] = await db.insert(schema.competitorBriefs)
        .values({
          briefDate,
          syncRunId: run.id,
          aiRunId: aiRun.id,
          title: "Daily Market Brief",
          executiveSummary: aiBrief.executiveSummary,
          whatChanged: aiBrief.whatChanged,
          whyItMatters: aiBrief.whyItMatters,
          recommendedResponses: aiBrief.recommendedResponses,
          confidence: aiBrief.confidence,
          coverageScore: health.active ? Math.round((health.healthy / health.active) * 100) : 0,
          seoVisibilityScore: await seoVisibilityScore(db),
          openTaskCount: 0,
          budgetUsageRatio: await budgetRatio(db),
          sourceHealth: health,
        })
        .onConflictDoUpdate({
          target: schema.competitorBriefs.briefDate,
          set: {
            syncRunId: run.id,
            aiRunId: aiRun.id,
            executiveSummary: aiBrief.executiveSummary,
            whatChanged: aiBrief.whatChanged,
            whyItMatters: aiBrief.whyItMatters,
            recommendedResponses: aiBrief.recommendedResponses,
            confidence: aiBrief.confidence,
            coverageScore: health.active ? Math.round((health.healthy / health.active) * 100) : 0,
            seoVisibilityScore: await seoVisibilityScore(db),
            budgetUsageRatio: await budgetRatio(db),
            sourceHealth: health,
            updatedAt: new Date(),
          },
        })
        .returning();
      counts.taskSuggestionCount = await insertTaskSuggestions(db, {
        briefId: brief.id,
        aiRunId: aiRun.id,
        suggestions: aiBrief.taskSuggestions,
      });
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.competitorTasks)
        .where(sql`${schema.competitorTasks.status} NOT IN ('done', 'ignored')`);
      await db.update(schema.competitorBriefs)
        .set({ openTaskCount: Number(count), updatedAt: new Date() })
        .where(eq(schema.competitorBriefs.id, brief.id));
    } catch (error) {
      aiFailed = true;
      const message = compactError(error);
      errors.push(`AI brief: ${message}`);
      await db.update(schema.competitorAiRuns)
        .set({
          status: "failed",
          errorSummary: message,
          finishedAt: new Date(),
          latencyMs: Date.now() - aiStartedAt,
        })
        .where(eq(schema.competitorAiRuns.id, aiRun.id));
    }

    try {
      const warRoom = await regenerateWarRoomSnapshot({
        db,
        syncRunId: run.id,
        actorEmail,
      });
      counts.aiRunCount += warRoom.aiRunCount;
      counts.taskSuggestionCount += warRoom.contentAngleCount;
    } catch (error) {
      warRoomFailed = true;
      const message = compactError(error);
      errors.push(`War Room snapshot: ${message}`);
    }

    const status = aiFailed || warRoomFailed ? "failed" : "success";
    const errorSummary = errors.length ? errors.slice(0, 6).join("; ") : null;
    await db.update(schema.competitorSyncRuns)
      .set({
        status,
        finishedAt: new Date(),
        ...counts,
        errorSummary,
        metadata: { seeded },
      })
      .where(eq(schema.competitorSyncRuns.id, run.id));
    return { runId: run.id, status, seeded, errorSummary, ...counts };
  } catch (error) {
    const message = compactError(error);
    await db.update(schema.competitorSyncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        ...counts,
        errorSummary: message,
        metadata: { seeded },
      })
      .where(eq(schema.competitorSyncRuns.id, run.id));
    return { runId: run.id, status: "failed", seeded, errorSummary: message, ...counts };
  }
}
