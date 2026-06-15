import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  competitorAiModel,
  deterministicWarRoomInsights,
  generateWarRoomInsightsWithOpenAi,
  isCompetitorAiConfigured,
  type CompetitorWarRoomAiInsights,
} from "./ai";
import { stableHash } from "./normalization";
import type {
  CompetitorContentAngle,
  CompetitorEntityKind,
  CompetitorMatrixRow,
  CompetitorScoreComponents,
  CompetitorScoreDrilldown,
  NormalizedCompetitorItem,
} from "./types";

export const WAR_ROOM_LOOKBACK_DAYS = 90;
export const WAR_ROOM_PROMPT_VERSION = "competitor-war-room-2026-06-15-v1";

type EntityRow = typeof schema.competitorEntities.$inferSelect;
type SourceRow = typeof schema.competitorSources.$inferSelect;
type EvidenceRow = typeof schema.competitorEvidenceItems.$inferSelect;
type SerpObservationRow = typeof schema.competitorSerpObservations.$inferSelect;
type WarRoomSnapshotRow = typeof schema.competitorWarRoomSnapshots.$inferSelect;

interface WarRoomBounds {
  weekStart: string;
  weekEnd: string;
  lookbackStart: string;
  lookbackEnd: string;
}

function bangkokDateIso(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function bangkokNoon(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00+07:00`);
}

function addDaysIso(isoDate: string, days: number): string {
  const date = bangkokNoon(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return bangkokDateIso(date);
}

function dateFromBangkokStart(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00+07:00`);
}

export function currentWarRoomBounds(now = new Date()): WarRoomBounds {
  const today = bangkokDateIso(now);
  const noon = bangkokNoon(today);
  const dayOfWeek = noon.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const weekStart = addDaysIso(today, -daysSinceMonday);
  const weekEnd = addDaysIso(weekStart, 6);
  const lookbackEnd = weekEnd;
  const lookbackStart = addDaysIso(lookbackEnd, -(WAR_ROOM_LOOKBACK_DAYS - 1));
  return { weekStart, weekEnd, lookbackStart, lookbackEnd };
}

function evidenceDate(item: Pick<EvidenceRow, "publishedAt" | "observedAt">): Date {
  return item.publishedAt ?? item.observedAt;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function metricNumber(metrics: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = metrics[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/,/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function themeLabel(category: string | null | undefined): string {
  switch (category) {
    case "pricing_offer":
      return "Pricing / offers";
    case "event_campaign":
      return "Events / campaigns";
    case "test_prep":
      return "Test prep";
    case "admissions":
      return "Admissions";
    case "homeschool":
      return "Homeschool";
    case "market_activity":
      return "General market activity";
    default:
      return "Uncategorized";
  }
}

function componentScores(input: {
  totalItems: number;
  last14Items: number;
  previous14Items: number;
  engagementUnits: number;
  seoVisibility: number | null;
  offerSignals: number;
  healthySourceCount: number;
  activeSourceCount: number;
}): CompetitorScoreComponents {
  const burstDelta = input.last14Items - input.previous14Items;
  return {
    activity: clampScore(input.totalItems * 8),
    burst: clampScore((input.last14Items > 0 ? 30 : 0) + burstDelta * 15),
    engagement: clampScore(Math.log10(input.engagementUnits + 1) * 28),
    seo: input.seoVisibility === null ? 0 : clampScore(input.seoVisibility),
    offer: clampScore(input.offerSignals * 25),
    coverage: input.activeSourceCount > 0
      ? clampScore((input.healthySourceCount / input.activeSourceCount) * 100)
      : 0,
  };
}

export function attentionScore(components: CompetitorScoreComponents): number {
  return clampScore(
    components.activity * 0.3
    + components.burst * 0.2
    + components.engagement * 0.15
    + components.seo * 0.15
    + components.offer * 0.1
    + components.coverage * 0.1,
  );
}

function seoVisibility(entityId: string, observations: SerpObservationRow[]): number | null {
  const ranks = observations
    .filter((row) => row.entityId === entityId && row.rankAbsolute !== null)
    .map((row) => row.rankAbsolute!);
  if (ranks.length === 0) return null;
  const bestRankByKeyword = new Map<string, number>();
  for (const row of observations) {
    if (row.entityId !== entityId || row.rankAbsolute === null) continue;
    const key = `${row.keyword}|${row.language}|${row.location}|${row.device}`;
    bestRankByKeyword.set(key, Math.min(bestRankByKeyword.get(key) ?? row.rankAbsolute, row.rankAbsolute));
  }
  const scores = [...bestRankByKeyword.values()].map((rank) => Math.max(0, 100 - (rank - 1) * 5));
  return clampScore(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function sourceCounts(entityId: string, sources: SourceRow[]) {
  const rows = sources.filter((source) => source.entityId === entityId);
  const active = rows.filter((source) => source.status === "active");
  return {
    activeSourceCount: active.length,
    healthySourceCount: active.filter((source) => !source.lastError).length,
    warnings: active
      .filter((source) => source.lastError)
      .map((source) => `${source.label}: ${source.lastError}`),
  };
}

function recommendedAngle(row: {
  displayName: string;
  topTheme: string;
  cadencePerWeek: number;
  activeChannels: string[];
  kind: CompetitorEntityKind;
}): string {
  if (row.kind === "own_brand") return "Use BeGifted as the baseline for response planning.";
  if (row.topTheme === "Pricing / offers") {
    return `Prepare BeGifted value messaging against ${row.displayName}'s offer activity.`;
  }
  if (row.topTheme === "Events / campaigns") {
    return `Plan a BeGifted campaign angle around ${row.displayName}'s event push.`;
  }
  if (row.topTheme === "Admissions") {
    return "Refresh admissions proof points and parent-facing consultation CTAs.";
  }
  if (row.topTheme === "Test prep") {
    return "Create outcome-led test prep content with clear parent proof points.";
  }
  if (row.cadencePerWeek >= 3) {
    return "Increase BeGifted posting cadence around the strongest repeated competitor theme.";
  }
  if (row.activeChannels.length === 0) {
    return "Add or repair sources before planning a response angle.";
  }
  return "Review the evidence timeline and decide whether a BeGifted response is needed.";
}

function beGiftedGap(row: CompetitorMatrixRow, ownBrand: CompetitorMatrixRow | null): string {
  if (row.kind === "own_brand") return "Own-brand baseline.";
  if (!ownBrand) return "BeGifted baseline sources are not configured yet.";
  const missingChannels = row.activeChannels.filter((channel) => !ownBrand.activeChannels.includes(channel));
  if (missingChannels.length) {
    return `BeGifted has no captured ${missingChannels.join(", ")} baseline for this competitor's active channel mix.`;
  }
  if (row.cadencePerWeek > ownBrand.cadencePerWeek + 1) {
    return `BeGifted cadence trails by ${(row.cadencePerWeek - ownBrand.cadencePerWeek).toFixed(1)} posts/signals per week.`;
  }
  if (row.topTheme !== ownBrand.topTheme && row.topThemeCount > 0) {
    return `Competitor emphasis on ${row.topTheme.toLowerCase()} is not BeGifted's current top captured theme.`;
  }
  return "No major BeGifted messaging gap detected from captured sources.";
}

function weekStartForDate(date: Date): string {
  const isoDate = bangkokDateIso(date);
  const noon = bangkokNoon(isoDate);
  const daysSinceMonday = (noon.getUTCDay() + 6) % 7;
  return addDaysIso(isoDate, -daysSinceMonday);
}

function buildDrilldown(input: {
  entityId: string;
  components: CompetitorScoreComponents;
  items: EvidenceRow[];
  generatedAt: Date;
}): CompetitorScoreDrilldown {
  const byWeek = new Map<string, EvidenceRow[]>();
  for (const item of input.items) {
    const key = weekStartForDate(evidenceDate(item));
    byWeek.set(key, [...(byWeek.get(key) ?? []), item]);
  }

  return {
    entityId: input.entityId,
    generatedAt: input.generatedAt.toISOString(),
    formula: "30% activity + 20% burst + 15% engagement + 15% SEO + 10% offers + 10% source coverage",
    components: input.components,
    weeklyTimeline: [...byWeek.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([weekStart, rows]) => ({
        weekStart,
        activityCount: rows.length,
        channels: rows.reduce<Record<string, number>>((acc, item) => {
          acc[item.channel] = (acc[item.channel] ?? 0) + 1;
          return acc;
        }, {}),
        topEvidence: [...rows]
          .sort((a, b) => b.impactScore - a.impactScore)
          .slice(0, 5)
          .map((item) => ({
            itemId: item.id,
            title: item.title,
            channel: item.channel,
            canonicalUrl: item.canonicalUrl,
            observedAt: item.observedAt.toISOString(),
            impactScore: item.impactScore,
          })),
      })),
  };
}

export function buildCompetitorMatrix(input: {
  entities: EntityRow[];
  sources: SourceRow[];
  evidence: EvidenceRow[];
  serpObservations: SerpObservationRow[];
  bounds: WarRoomBounds;
  generatedAt?: Date;
}): {
  matrix: CompetitorMatrixRow[];
  drilldowns: Record<string, CompetitorScoreDrilldown>;
} {
  const generatedAt = input.generatedAt ?? new Date();
  const lookbackStart = dateFromBangkokStart(input.bounds.lookbackStart).getTime();
  const last14Start = generatedAt.getTime() - 14 * 24 * 60 * 60 * 1000;
  const previous14Start = generatedAt.getTime() - 28 * 24 * 60 * 60 * 1000;

  const rows = input.entities
    .filter((entity) => entity.active)
    .map((entity) => {
      const items = input.evidence.filter((item) => (
        item.entityId === entity.id && evidenceDate(item).getTime() >= lookbackStart
      ));
      const channelCounts = items.reduce<Record<string, number>>((acc, item) => {
        acc[item.channel] = (acc[item.channel] ?? 0) + 1;
        return acc;
      }, {});
      const activeChannels = Object.keys(channelCounts).sort();
      const categoryCounts = items.reduce<Record<string, number>>((acc, item) => {
        acc[item.category] = (acc[item.category] ?? 0) + 1;
        return acc;
      }, {});
      const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
      const last14Items = items.filter((item) => evidenceDate(item).getTime() >= last14Start).length;
      const previous14Items = items.filter((item) => {
        const time = evidenceDate(item).getTime();
        return time >= previous14Start && time < last14Start;
      }).length;
      const engagementUnits = items.reduce((sum, item) => {
        const metrics = item.metrics;
        return sum
          + metricNumber(metrics, ["likes", "likesCount"])
          + metricNumber(metrics, ["comments", "commentsCount"]) * 3
          + metricNumber(metrics, ["shares", "sharesCount"]) * 5
          + metricNumber(metrics, ["views", "videoViewCount", "videoPlayCount"]) / 25;
      }, 0);
      const sourceHealth = sourceCounts(entity.id, input.sources);
      const seo = seoVisibility(entity.id, input.serpObservations);
      const components = componentScores({
        totalItems: items.length,
        last14Items,
        previous14Items,
        engagementUnits,
        seoVisibility: seo,
        offerSignals: items.filter((item) => item.pricingSignal).length,
        activeSourceCount: sourceHealth.activeSourceCount,
        healthySourceCount: sourceHealth.healthySourceCount,
      });
      const cadencePerWeek = Number((items.length / (WAR_ROOM_LOOKBACK_DAYS / 7)).toFixed(1));
      const cadenceTrend = last14Items > previous14Items ? "up" : last14Items < previous14Items ? "down" : "flat";
      const burstLabel = last14Items >= previous14Items + 3
        ? "Channel burst"
        : last14Items > 0 && cadenceTrend === "up"
          ? "Rising cadence"
          : cadenceTrend === "down"
            ? "Cooling"
            : "Stable";
      const latest = [...items].sort((a, b) => evidenceDate(b).getTime() - evidenceDate(a).getTime())[0];
      const row: CompetitorMatrixRow = {
        entityId: entity.id,
        slug: entity.slug,
        displayName: entity.displayName,
        kind: entity.kind,
        categoryTags: entity.categoryTags,
        attentionScore: attentionScore(components),
        scoreComponents: components,
        cadencePerWeek,
        cadenceTrend,
        activeChannels,
        channelCounts,
        burstLabel,
        topTheme: themeLabel(topCategory[0]),
        topThemeCount: topCategory[1],
        seoVisibility: seo,
        offerSignalCount: items.filter((item) => item.pricingSignal).length,
        beGiftedGap: "",
        recommendedAngle: "",
        latestEvidenceAt: iso(latest ? evidenceDate(latest) : null),
        coverageWarnings: sourceHealth.warnings,
      };
      row.recommendedAngle = recommendedAngle(row);
      return { row, items };
    });

  const ownBrand = rows.find(({ row }) => row.kind === "own_brand")?.row ?? null;
  const matrix = rows
    .map(({ row }) => ({
      ...row,
      beGiftedGap: beGiftedGap(row, ownBrand),
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "competitor" ? -1 : 1;
      return b.attentionScore - a.attentionScore || a.displayName.localeCompare(b.displayName);
    });
  const drilldowns = Object.fromEntries(rows.map(({ row, items }) => [
    row.entityId,
    buildDrilldown({
      entityId: row.entityId,
      components: row.scoreComponents,
      items,
      generatedAt,
    }),
  ]));

  return { matrix, drilldowns };
}

function evidenceToNormalized(item: EvidenceRow, entity: EntityRow): NormalizedCompetitorItem {
  return {
    itemKey: item.itemKey,
    channel: item.channel,
    category: item.category,
    title: item.title,
    summary: item.summary ?? "",
    contentText: item.contentText ?? "",
    canonicalUrl: item.canonicalUrl,
    language: item.language,
    publishedAt: item.publishedAt,
    impactScore: item.impactScore,
    confidence: item.confidence,
    pricingSignal: item.pricingSignal,
    metrics: item.metrics,
    raw: { ...item.raw, entitySlug: entity.slug },
    assetUrls: [],
  };
}

async function insertContentAngleSuggestions(
  db: Database,
  input: {
    insights: CompetitorWarRoomAiInsights;
    evidenceByKey: Map<string, EvidenceRow>;
    aiRunId: string | null;
    actorEmail: string | null;
  },
): Promise<CompetitorContentAngle[]> {
  const angles: CompetitorContentAngle[] = [];
  for (const angle of input.insights.contentAngles) {
    const evidence = angle.evidenceItemKeys
      .map((key) => input.evidenceByKey.get(key))
      .filter(Boolean) as EvidenceRow[];
    const primaryItem = evidence[0] ?? null;
    const title = angle.title.slice(0, 180);
    const description = `${angle.rationale}\n\nCTA: ${angle.cta}`;
    const [existing] = await db
      .select()
      .from(schema.competitorTaskSuggestions)
      .where(and(
        eq(schema.competitorTaskSuggestions.title, title),
        eq(schema.competitorTaskSuggestions.status, "suggested"),
        primaryItem
          ? eq(schema.competitorTaskSuggestions.itemId, primaryItem.id)
          : sql`${schema.competitorTaskSuggestions.itemId} IS NULL`,
      ))
      .limit(1);
    const suggestion = existing ?? (await db.insert(schema.competitorTaskSuggestions)
      .values({
        itemId: primaryItem?.id ?? null,
        aiRunId: input.aiRunId,
        title,
        description,
        priority: angle.confidence >= 0.75 ? "high" : "medium",
        labels: ["content_angle", angle.suggestedChannel],
        suggestedOwnerEmail: input.actorEmail ?? null,
        confidence: angle.confidence,
      })
      .returning())[0];

    angles.push({
      id: `angle:${stableHash(`${title}|${angle.entityId ?? ""}`)}`,
      suggestionId: suggestion?.id ?? null,
      entityId: angle.entityId,
      competitorName: null,
      title,
      rationale: angle.rationale,
      suggestedChannel: angle.suggestedChannel,
      cta: angle.cta,
      confidence: angle.confidence,
      status: suggestion?.status ?? "suggested",
      evidence: evidence.slice(0, 4).map((item) => ({
        itemId: item.id,
        title: item.title,
        channel: item.channel,
        canonicalUrl: item.canonicalUrl,
        observedAt: item.observedAt.toISOString(),
      })),
    });
  }
  return angles;
}

function contentAnglesWithNames(angles: CompetitorContentAngle[], entities: EntityRow[]) {
  const byId = new Map(entities.map((entity) => [entity.id, entity.displayName]));
  return angles.map((angle) => ({
    ...angle,
    competitorName: angle.entityId ? byId.get(angle.entityId) ?? null : null,
  }));
}

async function sourceHealth(db: Database) {
  const rows = await db.select().from(schema.competitorSources);
  const active = rows.filter((row) => row.status === "active");
  const healthy = active.filter((row) => !row.lastError);
  return {
    active: active.length,
    healthy: healthy.length,
    failed: active.length - healthy.length,
    byType: active.reduce<Record<string, { active: number; healthy: number }>>((acc, row) => {
      acc[row.sourceType] ??= { active: 0, healthy: 0 };
      acc[row.sourceType].active += 1;
      if (!row.lastError) acc[row.sourceType].healthy += 1;
      return acc;
    }, {}),
  };
}

export async function regenerateWarRoomSnapshot(input: {
  db?: Database;
  syncRunId?: string | null;
  actorEmail?: string | null;
  now?: Date;
} = {}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const bounds = currentWarRoomBounds(now);
  const lookbackStartDate = dateFromBangkokStart(bounds.lookbackStart);
  const [entities, sources, itemRows, serpRows] = await Promise.all([
    db.select().from(schema.competitorEntities).orderBy(schema.competitorEntities.displayName),
    db.select().from(schema.competitorSources),
    db.select()
      .from(schema.competitorEvidenceItems)
      .where(gte(schema.competitorEvidenceItems.observedAt, lookbackStartDate))
      .orderBy(desc(schema.competitorEvidenceItems.observedAt))
      .limit(500),
    db.select()
      .from(schema.competitorSerpObservations)
      .where(gte(schema.competitorSerpObservations.observedAt, lookbackStartDate))
      .orderBy(desc(schema.competitorSerpObservations.observedAt))
      .limit(1000),
  ]);
  const { matrix, drilldowns } = buildCompetitorMatrix({
    entities,
    sources,
    evidence: itemRows,
    serpObservations: serpRows,
    bounds,
    generatedAt: now,
  });
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const normalizedEvidence = itemRows
    .map((item) => {
      const entity = entityById.get(item.entityId);
      return entity ? evidenceToNormalized(item, entity) : null;
    })
    .filter(Boolean) as NormalizedCompetitorItem[];
  const evidenceByKey = new Map(itemRows.map((item) => [item.itemKey, item]));
  let aiRunId: string | null = null;
  let insights: CompetitorWarRoomAiInsights = deterministicWarRoomInsights({
    matrix,
    evidence: normalizedEvidence,
  });
  const metadata: Record<string, unknown> = {};
  const aiStartedAt = Date.now();

  if (isCompetitorAiConfigured()) {
    const [aiRun] = await db.insert(schema.competitorAiRuns)
      .values({
        syncRunId: input.syncRunId ?? null,
        runType: "weekly_war_room",
        model: competitorAiModel(),
        promptVersion: WAR_ROOM_PROMPT_VERSION,
        inputItemCount: normalizedEvidence.length,
      })
      .returning();
    aiRunId = aiRun.id;
    try {
      insights = await generateWarRoomInsightsWithOpenAi({
        matrix,
        evidence: normalizedEvidence,
        ...bounds,
      });
      await db.update(schema.competitorAiRuns)
        .set({
          status: "success",
          output: insights,
          finishedAt: new Date(),
          latencyMs: Date.now() - aiStartedAt,
        })
        .where(eq(schema.competitorAiRuns.id, aiRun.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "War Room AI failed";
      metadata.aiError = message;
      metadata.aiFallback = true;
      await db.update(schema.competitorAiRuns)
        .set({
          status: "failed",
          errorSummary: message,
          finishedAt: new Date(),
          latencyMs: Date.now() - aiStartedAt,
        })
        .where(eq(schema.competitorAiRuns.id, aiRun.id));
    }
  }

  const contentAngles = contentAnglesWithNames(await insertContentAngleSuggestions(db, {
    insights,
    evidenceByKey,
    aiRunId,
    actorEmail: input.actorEmail ?? null,
  }), entities);
  const health = await sourceHealth(db);
  const [snapshot] = await db.insert(schema.competitorWarRoomSnapshots)
    .values({
      weekStart: bounds.weekStart,
      weekEnd: bounds.weekEnd,
      lookbackStart: bounds.lookbackStart,
      lookbackEnd: bounds.lookbackEnd,
      syncRunId: input.syncRunId ?? null,
      aiRunId,
      status: metadata.aiFallback ? "ai_fallback" : "ready",
      confidence: insights.confidence,
      executiveSummary: insights.executiveSummary,
      matrix: matrix as unknown as Record<string, unknown>[],
      contentAngles: contentAngles as unknown as Record<string, unknown>[],
      scoreDrilldowns: drilldowns,
      sourceHealth: health,
      metadata,
      generatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.competitorWarRoomSnapshots.weekStart,
      set: {
        weekEnd: bounds.weekEnd,
        lookbackStart: bounds.lookbackStart,
        lookbackEnd: bounds.lookbackEnd,
        syncRunId: input.syncRunId ?? null,
        aiRunId,
        status: metadata.aiFallback ? "ai_fallback" : "ready",
        confidence: insights.confidence,
        executiveSummary: insights.executiveSummary,
        matrix: matrix as unknown as Record<string, unknown>[],
        contentAngles: contentAngles as unknown as Record<string, unknown>[],
        scoreDrilldowns: drilldowns,
        sourceHealth: health,
        metadata,
        generatedAt: now,
        updatedAt: now,
      },
    })
    .returning();

  return {
    snapshot,
    aiRunId,
    aiRunCount: aiRunId ? 1 : 0,
    contentAngleCount: contentAngles.length,
  };
}

export function emptyWarRoomSnapshot(now = new Date()) {
  const bounds = currentWarRoomBounds(now);
  return {
    weeklyWarRoom: {
      id: null,
      ...bounds,
      generatedAt: null,
      confidence: 0,
      executiveSummary: "No weekly War Room snapshot has been generated yet. Run competitor intelligence sync to build the matrix.",
      status: "empty",
      sourceHealth: {},
    },
    competitorMatrix: [],
    contentAngles: [],
    scoreDrilldowns: {},
  };
}

export function warRoomSnapshotDto(row: WarRoomSnapshotRow | null) {
  if (!row) return emptyWarRoomSnapshot();
  return {
    weeklyWarRoom: {
      id: row.id,
      weekStart: row.weekStart,
      weekEnd: row.weekEnd,
      lookbackStart: row.lookbackStart,
      lookbackEnd: row.lookbackEnd,
      generatedAt: row.generatedAt.toISOString(),
      confidence: row.confidence,
      executiveSummary: row.executiveSummary,
      status: row.status,
      sourceHealth: row.sourceHealth,
    },
    competitorMatrix: row.matrix as unknown as CompetitorMatrixRow[],
    contentAngles: row.contentAngles as unknown as CompetitorContentAngle[],
    scoreDrilldowns: row.scoreDrilldowns as unknown as Record<string, CompetitorScoreDrilldown>,
  };
}

export async function latestWarRoomSnapshot(db: Database = getDb()) {
  const [row] = await db
    .select()
    .from(schema.competitorWarRoomSnapshots)
    .orderBy(desc(schema.competitorWarRoomSnapshots.weekStart))
    .limit(1);
  return row ?? null;
}

export async function refreshContentAngleStatuses(db: Database, angles: CompetitorContentAngle[]) {
  const suggestionIds = angles.map((angle) => angle.suggestionId).filter(Boolean) as string[];
  if (!suggestionIds.length) return angles;
  const rows = await db
    .select()
    .from(schema.competitorTaskSuggestions)
    .where(inArray(schema.competitorTaskSuggestions.id, suggestionIds));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return angles.map((angle) => {
    const suggestion = angle.suggestionId ? byId.get(angle.suggestionId) : null;
    return suggestion ? { ...angle, status: suggestion.status } : angle;
  });
}
