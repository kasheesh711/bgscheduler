import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/competitor-intelligence/data", () => ({
  getCompetitorIntelligencePayload: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getCompetitorIntelligencePayload } from "@/lib/competitor-intelligence/data";
import { GET } from "../route";

const authMock = auth as unknown as Mock;

describe("competitor intelligence dashboard route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: {
        email: "marketing@example.com",
        name: "Marketing",
        role: "admin",
        allowedPages: null,
      },
    });
    vi.mocked(getCompetitorIntelligencePayload).mockResolvedValue({
      checkedAt: "2026-06-15T01:25:00.000Z",
      weeklyWarRoom: {
        id: "war-room-1",
        weekStart: "2026-06-15",
        weekEnd: "2026-06-21",
        lookbackStart: "2026-03-24",
        lookbackEnd: "2026-06-21",
        generatedAt: "2026-06-15T01:25:00.000Z",
        confidence: 0.82,
        executiveSummary: "Competitor cadence is rising in test prep.",
        status: "ready",
        sourceHealth: { active: 8, healthy: 7 },
      },
      competitorMatrix: [{
        entityId: "competitor-1",
        slug: "ignite",
        displayName: "Ignite",
        kind: "competitor",
        categoryTags: ["test prep"],
        attentionScore: 74,
        scoreComponents: {
          activity: 80,
          burst: 60,
          engagement: 50,
          seo: 70,
          offer: 25,
          coverage: 100,
        },
        cadencePerWeek: 3.2,
        cadenceTrend: "up",
        activeChannels: ["instagram", "serp"],
        channelCounts: { instagram: 20, serp: 8 },
        burstLabel: "Rising cadence",
        topTheme: "Test prep",
        topThemeCount: 12,
        seoVisibility: 70,
        offerSignalCount: 1,
        beGiftedGap: "BeGifted cadence trails by 2.0 posts/signals per week.",
        recommendedAngle: "Create outcome-led test prep content with clear parent proof points.",
        latestEvidenceAt: "2026-06-14T04:00:00.000Z",
        coverageWarnings: [],
      }],
      contentAngles: [{
        id: "angle-1",
        suggestionId: "suggestion-1",
        entityId: "competitor-1",
        competitorName: "Ignite",
        title: "SAT proof-point carousel",
        rationale: "Ignite is increasing SAT cadence.",
        suggestedChannel: "instagram",
        cta: "Book a consultation",
        confidence: 0.8,
        status: "suggested",
        evidence: [{
          itemId: "item-1",
          title: "SAT campaign",
          channel: "instagram",
          canonicalUrl: "https://example.com/post",
          observedAt: "2026-06-14T04:00:00.000Z",
        }],
      }],
      scoreDrilldowns: {
        "competitor-1": {
          entityId: "competitor-1",
          generatedAt: "2026-06-15T01:25:00.000Z",
          formula: "30% activity + 20% burst + 15% engagement + 15% SEO + 10% offers + 10% source coverage",
          components: {
            activity: 80,
            burst: 60,
            engagement: 50,
            seo: 70,
            offer: 25,
            coverage: 100,
          },
          weeklyTimeline: [{
            weekStart: "2026-06-08",
            activityCount: 3,
            channels: { instagram: 3 },
            topEvidence: [{
              itemId: "item-1",
              title: "SAT campaign",
              channel: "instagram",
              canonicalUrl: "https://example.com/post",
              observedAt: "2026-06-14T04:00:00.000Z",
              impactScore: 8,
            }],
          }],
        },
      },
      ownBrandSources: [],
      brief: {
        id: null,
        briefDate: "2026-06-15",
        title: "Daily Market Brief",
        executiveSummary: "",
        whatChanged: [],
        whyItMatters: [],
        recommendedResponses: [],
        confidence: 0,
        coverageScore: 0,
        seoVisibilityScore: 0,
        openTaskCount: 0,
        budgetUsageRatio: 0,
        sourceHealth: {},
      },
      kpis: {
        coveragePercent: 88,
        seoVisibilityScore: 70,
        openTaskCount: 1,
        budgetUsedPercent: 12,
        highImpactMoves: 4,
        sourceFailures: 1,
      },
      entities: [],
      sources: [],
      recentItems: [],
      serp: [],
      taskSuggestions: [],
      tasks: [],
      runs: [],
      usage: [],
    } as never);
  });

  it("requires competitor intelligence access", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(getCompetitorIntelligencePayload).not.toHaveBeenCalled();
  });

  it("returns the weekly War Room payload contract", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      weeklyWarRoom: {
        weekStart: "2026-06-15",
        status: "ready",
        sourceHealth: { active: 8, healthy: 7 },
      },
      competitorMatrix: [{
        displayName: "Ignite",
        attentionScore: 74,
        scoreComponents: { seo: 70, coverage: 100 },
        beGiftedGap: expect.stringContaining("cadence trails"),
      }],
      contentAngles: [{
        suggestionId: "suggestion-1",
        title: "SAT proof-point carousel",
        status: "suggested",
      }],
      scoreDrilldowns: {
        "competitor-1": {
          weeklyTimeline: [{
            topEvidence: [expect.objectContaining({ itemId: "item-1" })],
          }],
        },
      },
    });
  });
});
