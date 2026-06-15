import { describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import {
  attentionScore,
  buildCompetitorMatrix,
  currentWarRoomBounds,
} from "@/lib/competitor-intelligence/war-room";

type EntityRow = typeof schema.competitorEntities.$inferSelect;
type SourceRow = typeof schema.competitorSources.$inferSelect;
type EvidenceRow = typeof schema.competitorEvidenceItems.$inferSelect;
type SerpRow = typeof schema.competitorSerpObservations.$inferSelect;

const NOW = new Date("2026-06-18T05:00:00.000Z");

function daysAgo(days: number) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function entity(id: string, displayName: string, kind: "competitor" | "own_brand" = "competitor"): EntityRow {
  return {
    id,
    slug: displayName.toLowerCase().replace(/\s+/g, "-"),
    displayName,
    kind,
    categoryTags: ["test prep"],
    marketPosition: null,
    websiteUrl: null,
    confidence: 1,
    discoveredBy: "seed",
    discoveryMetadata: {},
    active: true,
    archivedAt: null,
    createdAt: daysAgo(120),
    updatedAt: daysAgo(1),
  };
}

function source(id: string, entityId: string, sourceType: "website" | "instagram" | "facebook", lastError: string | null = null): SourceRow {
  return {
    id,
    entityId,
    sourceType,
    label: sourceType,
    url: `https://example.com/${id}`,
    handle: null,
    provider: sourceType === "website" ? "internal" : "apify",
    priority: 80,
    status: "active",
    reliability: sourceType === "website" ? "reliable" : "best_effort",
    captureMedia: true,
    bestEffort: sourceType !== "website",
    config: {},
    lastRunAt: daysAgo(1),
    lastSuccessAt: lastError ? null : daysAgo(1),
    lastError,
    createdByEmail: "test@example.com",
    updatedByEmail: "test@example.com",
    createdAt: daysAgo(120),
    updatedAt: daysAgo(1),
  };
}

function evidence(overrides: Partial<EvidenceRow> & { id: string; entityId: string; daysAgo: number }): EvidenceRow {
  const { daysAgo: ageDays, id, entityId, ...rest } = overrides;
  const observedAt = daysAgo(ageDays);
  return {
    id,
    itemKey: `ci:${id}`,
    entityId,
    sourceId: null,
    sourceRunId: null,
    channel: "instagram",
    category: "test_prep",
    title: "SAT score gains",
    summary: "SAT score gains",
    contentText: "SAT score gains",
    canonicalUrl: `https://example.com/${overrides.id}`,
    language: "en",
    observedAt,
    publishedAt: null,
    impactScore: 5,
    confidence: 0.8,
    evidenceStatus: "captured",
    reviewStatus: "new",
    pricingSignal: false,
    taskSuggestionStatus: "none",
    metrics: { likes: 120, comments: 12 },
    raw: {},
    createdAt: observedAt,
    updatedAt: observedAt,
    ...rest,
  };
}

function serp(entityId: string, rankAbsolute: number): SerpRow {
  return {
    id: `serp-${entityId}`,
    observationKey: `serp:${entityId}`,
    keywordId: "keyword-1",
    entityId,
    sourceRunId: null,
    observedAt: daysAgo(2),
    keyword: "sat prep bangkok",
    language: "en",
    location: "Bangkok,Bangkok,Thailand",
    device: "mobile",
    resultType: "organic",
    rankAbsolute,
    rankGroup: 1,
    title: "SAT prep",
    url: "https://example.com/sat",
    displayUrl: "example.com",
    snippet: "SAT prep",
    isBeGifted: false,
    raw: {},
    createdAt: daysAgo(2),
  };
}

describe("competitor War Room BI", () => {
  it("computes Bangkok weekly and 90-day bounds", () => {
    expect(currentWarRoomBounds(NOW)).toEqual({
      weekStart: "2026-06-15",
      weekEnd: "2026-06-21",
      lookbackStart: "2026-03-24",
      lookbackEnd: "2026-06-21",
    });
  });

  it("scores and sorts competitors from 90-day channel activity", () => {
    const entities = [
      entity("begifted", "BeGifted", "own_brand"),
      entity("ignite", "Ignite"),
      entity("quiet", "Quiet School"),
    ];
    const sources = [
      source("begifted-web", "begifted", "website"),
      source("ignite-ig", "ignite", "instagram"),
      source("ignite-fb", "ignite", "facebook"),
      source("quiet-ig", "quiet", "instagram", "Apify skipped"),
    ];
    const evidenceRows = [
      evidence({ id: "own-1", entityId: "begifted", daysAgo: 6, channel: "website", category: "market_activity", metrics: {} }),
      evidence({ id: "ignite-1", entityId: "ignite", daysAgo: 2 }),
      evidence({ id: "ignite-2", entityId: "ignite", daysAgo: 3, pricingSignal: true, category: "pricing_offer" }),
      evidence({ id: "ignite-3", entityId: "ignite", daysAgo: 4 }),
      evidence({ id: "ignite-4", entityId: "ignite", daysAgo: 9 }),
      evidence({ id: "ignite-5", entityId: "ignite", daysAgo: 20 }),
      evidence({ id: "old", entityId: "ignite", daysAgo: 120, channel: "website", category: "admissions" }),
      evidence({ id: "quiet-1", entityId: "quiet", daysAgo: 30, impactScore: 2, metrics: {} }),
    ];

    const { matrix, drilldowns } = buildCompetitorMatrix({
      entities,
      sources,
      evidence: evidenceRows,
      serpObservations: [serp("ignite", 3)],
      bounds: currentWarRoomBounds(NOW),
      generatedAt: NOW,
    });

    expect(matrix[0]).toMatchObject({
      entityId: "ignite",
      displayName: "Ignite",
      activeChannels: ["instagram"],
      topTheme: "Test prep",
      offerSignalCount: 1,
      cadenceTrend: "up",
    });
    expect(matrix[0].attentionScore).toBeGreaterThan(matrix[1].attentionScore);
    expect(matrix[0].channelCounts.website).toBeUndefined();
    expect(matrix[0].beGiftedGap).toContain("BeGifted");
    expect(matrix.find((row) => row.entityId === "quiet")?.coverageWarnings[0]).toContain("Apify skipped");
    expect(drilldowns.ignite.weeklyTimeline[0].topEvidence[0].title).toBe("SAT score gains");
  });

  it("keeps attention score explainable through weighted components", () => {
    expect(attentionScore({
      activity: 100,
      burst: 50,
      engagement: 20,
      seo: 80,
      offer: 25,
      coverage: 100,
    })).toBe(68);
  });
});
