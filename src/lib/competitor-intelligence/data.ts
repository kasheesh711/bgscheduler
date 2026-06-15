import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { DEFAULT_COMPETITOR_ENTITIES, DEFAULT_SERP_KEYWORDS } from "./default-sources";
import { buildEvidenceItemKey, classifyMarketCategory, scoreImpact } from "./normalization";
import type {
  CompetitorDashboardPayload,
  CompetitorSourceStatus,
  CompetitorSourceType,
  CompetitorTaskStatus,
} from "./types";

type EntityRow = typeof schema.competitorEntities.$inferSelect;
type SourceRow = typeof schema.competitorSources.$inferSelect;
type EvidenceRow = typeof schema.competitorEvidenceItems.$inferSelect;
type BriefRow = typeof schema.competitorBriefs.$inferSelect;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function compact(value: string | null | undefined, max = 220): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sourceReliability(type: CompetitorSourceType, bestEffort?: boolean) {
  if (bestEffort || type === "instagram" || type === "facebook") return "best_effort";
  return "reliable";
}

export async function seedDefaultCompetitorSources(actorEmail: string | null, db: Database = getDb()) {
  const seededEntities: EntityRow[] = [];
  const seededSources: SourceRow[] = [];
  const actor = actorEmail?.trim().toLowerCase() || "system@competitor-intelligence.local";

  for (const entity of DEFAULT_COMPETITOR_ENTITIES) {
    const now = new Date();
    const [row] = await db.insert(schema.competitorEntities)
      .values({
        slug: entity.slug,
        displayName: entity.displayName,
        kind: entity.kind,
        categoryTags: entity.categoryTags,
        marketPosition: entity.marketPosition ?? null,
        websiteUrl: entity.websiteUrl ?? null,
        discoveryMetadata: { seededAt: now.toISOString() },
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.competitorEntities.slug,
        set: {
          displayName: entity.displayName,
          kind: entity.kind,
          categoryTags: entity.categoryTags,
          marketPosition: entity.marketPosition ?? null,
          websiteUrl: entity.websiteUrl ?? null,
          updatedAt: now,
        },
      })
      .returning();
    seededEntities.push(row);

    for (const source of entity.sources) {
      const [sourceRow] = await db.insert(schema.competitorSources)
        .values({
          entityId: row.id,
          sourceType: source.type,
          label: source.label,
          url: source.url,
          handle: source.handle ?? null,
          provider: source.provider,
          priority: source.priority,
          reliability: source.reliability ?? sourceReliability(source.type, source.bestEffort),
          bestEffort: source.bestEffort ?? false,
          createdByEmail: actor,
          updatedByEmail: actor,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.competitorSources.entityId,
            schema.competitorSources.sourceType,
            schema.competitorSources.url,
          ],
          set: {
            label: source.label,
            handle: source.handle ?? null,
          provider: source.provider,
          priority: source.priority,
          reliability: source.reliability ?? sourceReliability(source.type, source.bestEffort),
          bestEffort: source.bestEffort ?? false,
          updatedByEmail: actor,
          updatedAt: now,
        },
        })
        .returning();
      seededSources.push(sourceRow);
    }
  }

  for (const keyword of DEFAULT_SERP_KEYWORDS) {
    await db.insert(schema.competitorSerpKeywords)
      .values({
        keyword: keyword.keyword,
        language: keyword.language,
        location: keyword.location,
        device: keyword.device,
        discoveredBy: "seed",
        confidence: 1,
        autoTracked: true,
        approvedByEmail: actor,
        approvedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.competitorSerpKeywords.keyword,
          schema.competitorSerpKeywords.language,
          schema.competitorSerpKeywords.location,
          schema.competitorSerpKeywords.device,
        ],
        set: {
          autoTracked: true,
          confidence: 1,
          approvedByEmail: actor,
          approvedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }

  return { entities: seededEntities.length, sources: seededSources.length, keywords: DEFAULT_SERP_KEYWORDS.length };
}

export async function listActiveCompetitorSources(db: Database = getDb()) {
  return db
    .select({
      source: schema.competitorSources,
      entity: schema.competitorEntities,
    })
    .from(schema.competitorSources)
    .innerJoin(schema.competitorEntities, eq(schema.competitorSources.entityId, schema.competitorEntities.id))
    .where(and(
      eq(schema.competitorSources.status, "active"),
      eq(schema.competitorEntities.active, true),
    ))
    .orderBy(desc(schema.competitorSources.priority), schema.competitorEntities.displayName);
}

export async function listActiveSerpKeywords(db: Database = getDb()) {
  return db
    .select()
    .from(schema.competitorSerpKeywords)
    .where(eq(schema.competitorSerpKeywords.status, "active"))
    .orderBy(desc(schema.competitorSerpKeywords.confidence), schema.competitorSerpKeywords.keyword);
}

function emptyBrief(): CompetitorDashboardPayload["brief"] {
  return {
    id: null,
    briefDate: todayIso(),
    title: "Daily Market Brief",
    executiveSummary: "No competitor brief has been generated yet. Run the competitor intelligence sync to seed sources and build the first daily brief.",
    whatChanged: [],
    whyItMatters: [],
    recommendedResponses: [],
    confidence: 0,
    coverageScore: 0,
    seoVisibilityScore: 0,
    openTaskCount: 0,
    budgetUsageRatio: 0,
    sourceHealth: {},
  };
}

function briefDto(row: BriefRow | null): CompetitorDashboardPayload["brief"] {
  if (!row) return emptyBrief();
  return {
    id: row.id,
    briefDate: row.briefDate,
    title: row.title,
    executiveSummary: row.executiveSummary,
    whatChanged: row.whatChanged,
    whyItMatters: row.whyItMatters,
    recommendedResponses: row.recommendedResponses,
    confidence: row.confidence,
    coverageScore: row.coverageScore,
    seoVisibilityScore: row.seoVisibilityScore,
    openTaskCount: row.openTaskCount,
    budgetUsageRatio: row.budgetUsageRatio,
    sourceHealth: row.sourceHealth,
  };
}

export async function getCompetitorIntelligencePayload(db: Database = getDb()): Promise<CompetitorDashboardPayload> {
  const [
    entities,
    sourceRows,
    latestBriefRows,
    itemRows,
    keywordRows,
    observationRows,
    suggestionRows,
    taskRows,
    runRows,
    usageRows,
    assetCounts,
  ] = await Promise.all([
    db.select().from(schema.competitorEntities).orderBy(schema.competitorEntities.displayName),
    db.select({
      source: schema.competitorSources,
      entity: schema.competitorEntities,
    }).from(schema.competitorSources)
      .innerJoin(schema.competitorEntities, eq(schema.competitorSources.entityId, schema.competitorEntities.id))
      .orderBy(schema.competitorEntities.displayName, schema.competitorSources.sourceType),
    db.select().from(schema.competitorBriefs).orderBy(desc(schema.competitorBriefs.briefDate)).limit(1),
    db.select({
      item: schema.competitorEvidenceItems,
      entity: schema.competitorEntities,
    }).from(schema.competitorEvidenceItems)
      .innerJoin(schema.competitorEntities, eq(schema.competitorEvidenceItems.entityId, schema.competitorEntities.id))
      .orderBy(desc(schema.competitorEvidenceItems.observedAt))
      .limit(80),
    db.select().from(schema.competitorSerpKeywords).orderBy(schema.competitorSerpKeywords.keyword),
    db.select().from(schema.competitorSerpObservations).orderBy(desc(schema.competitorSerpObservations.observedAt)).limit(300),
    db.select({
      suggestion: schema.competitorTaskSuggestions,
      item: schema.competitorEvidenceItems,
      entity: schema.competitorEntities,
    }).from(schema.competitorTaskSuggestions)
      .leftJoin(schema.competitorEvidenceItems, eq(schema.competitorTaskSuggestions.itemId, schema.competitorEvidenceItems.id))
      .leftJoin(schema.competitorEntities, eq(schema.competitorEvidenceItems.entityId, schema.competitorEntities.id))
      .where(eq(schema.competitorTaskSuggestions.status, "suggested"))
      .orderBy(desc(schema.competitorTaskSuggestions.confidence), desc(schema.competitorTaskSuggestions.createdAt))
      .limit(24),
    db.select({
      task: schema.competitorTasks,
      item: schema.competitorEvidenceItems,
      entity: schema.competitorEntities,
    }).from(schema.competitorTasks)
      .leftJoin(schema.competitorEvidenceItems, eq(schema.competitorTasks.itemId, schema.competitorEvidenceItems.id))
      .leftJoin(schema.competitorEntities, eq(schema.competitorEvidenceItems.entityId, schema.competitorEntities.id))
      .orderBy(desc(schema.competitorTasks.updatedAt))
      .limit(50),
    db.select().from(schema.competitorSyncRuns).orderBy(desc(schema.competitorSyncRuns.startedAt)).limit(12),
    db.select().from(schema.competitorVendorUsage).orderBy(desc(schema.competitorVendorUsage.usageMonth), schema.competitorVendorUsage.provider),
    db.select({
      itemId: schema.competitorAssets.itemId,
      count: sql<number>`count(*)::int`,
    }).from(schema.competitorAssets).groupBy(schema.competitorAssets.itemId),
  ]);

  const sourceCountByEntity = new Map<string, number>();
  const latestItemByEntity = new Map<string, string>();
  for (const row of sourceRows) {
    sourceCountByEntity.set(row.entity.id, (sourceCountByEntity.get(row.entity.id) ?? 0) + 1);
  }
  for (const row of itemRows) {
    if (!latestItemByEntity.has(row.entity.id)) latestItemByEntity.set(row.entity.id, row.item.observedAt.toISOString());
  }
  const assetCountByItem = new Map(assetCounts.map((row) => [row.itemId, Number(row.count)]));
  const observationsByKeyword = new Map<string, typeof observationRows>();
  for (const observation of observationRows) {
    const rows = observationsByKeyword.get(observation.keywordId) ?? [];
    rows.push(observation);
    observationsByKeyword.set(observation.keywordId, rows);
  }
  const latestBrief = latestBriefRows[0] ?? null;
  const openTasks = taskRows.filter((row) => !["done", "ignored"].includes(row.task.status));
  const highImpactMoves = itemRows.filter((row) => row.item.impactScore >= 6).length;
  const sourceFailures = sourceRows.filter((row) => row.source.lastError).length;
  const activeSourceCount = sourceRows.filter((row) => row.source.status === "active").length;
  const healthySourceCount = sourceRows.filter((row) => row.source.status === "active" && !row.source.lastError).length;
  const estimatedCost = usageRows.reduce((sum, row) => sum + row.estimatedCostUsd, 0);
  const hardCap = usageRows.reduce((sum, row) => sum + row.hardCapUsd, 0);

  return {
    checkedAt: new Date().toISOString(),
    brief: briefDto(latestBrief),
    kpis: {
      coveragePercent: activeSourceCount ? Math.round((healthySourceCount / activeSourceCount) * 100) : 0,
      seoVisibilityScore: latestBrief?.seoVisibilityScore ?? 0,
      openTaskCount: openTasks.length,
      budgetUsedPercent: hardCap > 0 ? Math.round(Math.min(100, estimatedCost / hardCap * 100)) : 0,
      highImpactMoves,
      sourceFailures,
    },
    entities: entities.map((entity) => ({
      id: entity.id,
      slug: entity.slug,
      displayName: entity.displayName,
      kind: entity.kind,
      categoryTags: entity.categoryTags,
      active: entity.active,
      sourceCount: sourceCountByEntity.get(entity.id) ?? 0,
      latestItemAt: latestItemByEntity.get(entity.id) ?? null,
    })),
    sources: sourceRows.map(({ source, entity }) => ({
      id: source.id,
      entityId: entity.id,
      entityName: entity.displayName,
      sourceType: source.sourceType,
      label: source.label,
      url: source.url,
      provider: source.provider,
      priority: source.priority,
      status: source.status,
      reliability: source.reliability,
      bestEffort: source.bestEffort,
      lastRunAt: iso(source.lastRunAt),
      lastSuccessAt: iso(source.lastSuccessAt),
      lastError: compact(source.lastError),
    })),
    recentItems: itemRows.map(({ item, entity }) => ({
      id: item.id,
      entityName: entity.displayName,
      channel: item.channel,
      category: item.category,
      title: item.title,
      summary: item.summary,
      canonicalUrl: item.canonicalUrl,
      observedAt: item.observedAt.toISOString(),
      publishedAt: iso(item.publishedAt),
      impactScore: item.impactScore,
      confidence: item.confidence,
      pricingSignal: item.pricingSignal,
      reviewStatus: item.reviewStatus,
      assetCount: assetCountByItem.get(item.id) ?? 0,
    })),
    serp: keywordRows.map((keyword) => {
      const observations = observationsByKeyword.get(keyword.id) ?? [];
      const begiftedRanks = observations.filter((row) => row.isBeGifted && row.rankAbsolute !== null).map((row) => row.rankAbsolute!);
      const competitorRanks = observations.filter((row) => !row.isBeGifted && row.rankAbsolute !== null).map((row) => row.rankAbsolute!);
      return {
        keyword: keyword.keyword,
        language: keyword.language,
        location: keyword.location,
        device: keyword.device,
        status: keyword.status,
        autoTracked: keyword.autoTracked,
        confidence: keyword.confidence,
        latestObservedAt: iso(observations[0]?.observedAt),
        bestBeGiftedRank: begiftedRanks.length ? Math.min(...begiftedRanks) : null,
        bestCompetitorRank: competitorRanks.length ? Math.min(...competitorRanks) : null,
      };
    }),
    taskSuggestions: suggestionRows.map(({ suggestion, item, entity }) => ({
      id: suggestion.id,
      title: suggestion.title,
      description: suggestion.description,
      priority: suggestion.priority,
      dueDate: suggestion.dueDate,
      labels: suggestion.labels,
      confidence: suggestion.confidence,
      itemTitle: item?.title ?? null,
      competitorName: entity?.displayName ?? null,
      status: suggestion.status,
    })),
    tasks: taskRows.map(({ task, item, entity }) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      ownerEmail: task.ownerEmail,
      dueDate: task.dueDate,
      labels: task.labels,
      itemTitle: item?.title ?? null,
      competitorName: entity?.displayName ?? null,
      updatedAt: task.updatedAt.toISOString(),
    })),
    runs: runRows.map((run) => ({
      id: run.id,
      status: run.status,
      triggerType: run.triggerType,
      startedAt: run.startedAt.toISOString(),
      finishedAt: iso(run.finishedAt),
      sourceCount: run.sourceCount,
      sourceSuccessCount: run.sourceSuccessCount,
      sourceFailedCount: run.sourceFailedCount,
      sourceSkippedCount: run.sourceSkippedCount,
      itemCount: run.itemCount,
      newItemCount: run.newItemCount,
      budgetSkippedCount: run.budgetSkippedCount,
      errorSummary: compact(run.errorSummary),
    })),
    usage: usageRows.map((row) => ({
      usageMonth: row.usageMonth,
      provider: row.provider,
      sourceType: row.sourceType,
      usageUnits: row.usageUnits,
      estimatedCostUsd: row.estimatedCostUsd,
      hardCapUsd: row.hardCapUsd,
      capped: row.capped,
    })),
  };
}

export async function updateCompetitorSourceStatus(
  sourceId: string,
  status: CompetitorSourceStatus,
  actorEmail: string,
  db: Database = getDb(),
) {
  const [row] = await db.update(schema.competitorSources)
    .set({ status, updatedByEmail: actorEmail, updatedAt: new Date() })
    .where(eq(schema.competitorSources.id, sourceId))
    .returning();
  if (!row) throw new Error("Source not found");
  return row;
}

export async function acceptCompetitorTaskSuggestion(
  suggestionId: string,
  actorEmail: string,
  db: Database = getDb(),
) {
  const [suggestion] = await db
    .select()
    .from(schema.competitorTaskSuggestions)
    .where(eq(schema.competitorTaskSuggestions.id, suggestionId))
    .limit(1);
  if (!suggestion) throw new Error("Task suggestion not found");
  if (suggestion.status !== "suggested") throw new Error("Task suggestion is not open");

  const [task] = await db.insert(schema.competitorTasks)
    .values({
      itemId: suggestion.itemId,
      briefId: suggestion.briefId,
      suggestionId: suggestion.id,
      title: suggestion.title,
      description: suggestion.description,
      priority: suggestion.priority,
      dueDate: suggestion.dueDate,
      labels: suggestion.labels,
      ownerEmail: suggestion.suggestedOwnerEmail,
      createdByEmail: actorEmail,
      updatedByEmail: actorEmail,
    })
    .returning();

  await Promise.all([
    db.update(schema.competitorTaskSuggestions)
      .set({
        status: "accepted",
        acceptedTaskId: task.id,
        acceptedAt: new Date(),
        acceptedByEmail: actorEmail,
      })
      .where(eq(schema.competitorTaskSuggestions.id, suggestion.id)),
    db.insert(schema.competitorTaskEvents).values({
      taskId: task.id,
      eventType: "created_from_suggestion",
      actorEmail,
      payload: { suggestionId: suggestion.id },
    }),
  ]);
  return task;
}

export async function updateCompetitorTask(
  taskId: string,
  input: {
    status?: CompetitorTaskStatus;
    ownerEmail?: string | null;
    priority?: string;
    dueDate?: string | null;
    labels?: string[];
  },
  actorEmail: string,
  db: Database = getDb(),
) {
  const completedAt = input.status === "done" ? new Date() : input.status ? null : undefined;
  const [task] = await db.update(schema.competitorTasks)
    .set({
      ...("status" in input ? { status: input.status } : {}),
      ...("ownerEmail" in input ? { ownerEmail: input.ownerEmail } : {}),
      ...("priority" in input ? { priority: input.priority } : {}),
      ...("dueDate" in input ? { dueDate: input.dueDate } : {}),
      ...("labels" in input ? { labels: input.labels } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      updatedByEmail: actorEmail,
      updatedAt: new Date(),
    })
    .where(eq(schema.competitorTasks.id, taskId))
    .returning();
  if (!task) throw new Error("Task not found");
  await db.insert(schema.competitorTaskEvents).values({
    taskId,
    eventType: "updated",
    actorEmail,
    payload: input,
  });
  return task;
}

export async function createManualCompetitorEvidence(
  input: {
    entityId: string;
    title: string;
    contentText: string;
    canonicalUrl?: string | null;
    pricingSignal?: boolean;
  },
  actorEmail: string,
  db: Database = getDb(),
) {
  const [entity] = await db
    .select()
    .from(schema.competitorEntities)
    .where(eq(schema.competitorEntities.id, input.entityId))
    .limit(1);
  if (!entity) throw new Error("Competitor not found");

  const text = `${input.title}\n${input.contentText}`;
  const category = classifyMarketCategory(text);
  const item: Omit<EvidenceRow, "id" | "createdAt" | "updatedAt"> = {
    itemKey: buildEvidenceItemKey({
      entitySlug: entity.slug,
      channel: "manual",
      canonicalUrl: input.canonicalUrl,
      contentText: text,
      publishedAt: null,
    }),
    entityId: entity.id,
    sourceId: null,
    sourceRunId: null,
    channel: "manual",
    category,
    title: input.title,
    summary: input.contentText.slice(0, 240),
    contentText: input.contentText,
    canonicalUrl: input.canonicalUrl ?? null,
    language: /[\u0E00-\u0E7F]/.test(text) ? "th" : "en",
    observedAt: new Date(),
    publishedAt: null,
    impactScore: scoreImpact(text, {}),
    confidence: 0.7,
    evidenceStatus: "manual",
    reviewStatus: "new",
    pricingSignal: input.pricingSignal ?? category === "pricing_offer",
    taskSuggestionStatus: "none",
    metrics: {},
    raw: { actorEmail },
  };

  const [row] = await db.insert(schema.competitorEvidenceItems)
    .values(item)
    .onConflictDoUpdate({
      target: schema.competitorEvidenceItems.itemKey,
      set: {
        title: item.title,
        summary: item.summary,
        contentText: item.contentText,
        canonicalUrl: item.canonicalUrl,
        category: item.category,
        pricingSignal: item.pricingSignal,
        observedAt: item.observedAt,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function upsertDiscoveredKeyword(
  input: { keyword: string; language: "en" | "th"; confidence: number },
  db: Database = getDb(),
) {
  const devices = ["mobile", "desktop"] as const;
  for (const device of devices) {
    await db.insert(schema.competitorSerpKeywords)
      .values({
        keyword: input.keyword,
        language: input.language,
        location: "Bangkok, Thailand",
        device,
        discoveredBy: "ai",
        confidence: input.confidence,
        autoTracked: input.confidence >= 0.8,
        status: input.confidence >= 0.8 ? "active" : "needs_review",
        metadata: { source: "competitor-ai" },
      })
      .onConflictDoUpdate({
        target: [
          schema.competitorSerpKeywords.keyword,
          schema.competitorSerpKeywords.language,
          schema.competitorSerpKeywords.location,
          schema.competitorSerpKeywords.device,
        ],
        set: {
          confidence: sql`greatest(${schema.competitorSerpKeywords.confidence}, ${input.confidence})`,
          autoTracked: input.confidence >= 0.8,
          status: input.confidence >= 0.8 ? "active" : "needs_review",
          updatedAt: new Date(),
        },
      });
  }
}

export async function loadEntitiesByDomain(db: Database = getDb()) {
  const entities = await db.select().from(schema.competitorEntities);
  const pairs: Array<[string, string]> = [];
  for (const entity of entities) {
    if (entity.websiteUrl) {
      try {
        pairs.push([new URL(entity.websiteUrl).hostname.replace(/^www\./, ""), entity.id]);
      } catch {
        // ignore invalid editorial URLs
      }
    }
    pairs.push([slugify(entity.displayName), entity.id]);
  }
  return pairs;
}

export async function findEvidenceItemsByKeys(itemKeys: string[], db: Database = getDb()) {
  if (itemKeys.length === 0) return [];
  return db
    .select()
    .from(schema.competitorEvidenceItems)
    .where(inArray(schema.competitorEvidenceItems.itemKey, itemKeys));
}
