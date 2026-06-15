import { describe, expect, it } from "vitest";
import { deterministicBrief, parseWarRoomAiInsights } from "@/lib/competitor-intelligence/ai";
import type { NormalizedCompetitorItem } from "@/lib/competitor-intelligence/types";

function item(overrides: Partial<NormalizedCompetitorItem> = {}): NormalizedCompetitorItem {
  return {
    itemKey: "ci:test",
    channel: "instagram",
    category: "pricing_offer",
    title: "SAT offer",
    summary: "New SAT course THB 12,000",
    contentText: "New SAT course THB 12,000",
    canonicalUrl: "https://example.com/sat",
    language: "en",
    publishedAt: null,
    impactScore: 8,
    confidence: 0.8,
    pricingSignal: true,
    metrics: {},
    raw: {},
    assetUrls: [],
    ...overrides,
  };
}

describe("competitor intelligence AI fallback", () => {
  it("creates source-bound task suggestions without inventing facts", () => {
    const brief = deterministicBrief([item()], "2026-06-15");

    expect(brief.executiveSummary).toContain("1 competitor signals");
    expect(brief.whatChanged[0]).toContain("SAT offer");
    expect(brief.taskSuggestions[0]).toMatchObject({
      itemKey: "ci:test",
      priority: "high",
    });
    expect(brief.keywordSuggestions).toEqual([]);
    expect(brief.competitorSuggestions).toEqual([]);
  });

  it("validates weekly War Room content-angle JSON", () => {
    expect(parseWarRoomAiInsights({
      executiveSummary: "Ignite is increasing SAT cadence.",
      confidence: 0.8,
      contentAngles: [{
        entityId: "ignite",
        title: "Create outcome-led SAT proof content",
        rationale: "Competitor evidence shows repeated SAT score claims.",
        suggestedChannel: "instagram",
        cta: "Message BeGifted for a consultation.",
        confidence: 0.77,
        evidenceItemKeys: ["ci:test"],
      }],
    }).contentAngles[0]).toMatchObject({
      suggestedChannel: "instagram",
      evidenceItemKeys: ["ci:test"],
    });

    expect(() => parseWarRoomAiInsights({
      executiveSummary: "Bad channel",
      confidence: 0.8,
      contentAngles: [{
        entityId: null,
        title: "Post everywhere",
        rationale: "Unsupported channel should fail",
        suggestedChannel: "tiktok",
        cta: "Message us",
        confidence: 0.7,
        evidenceItemKeys: [],
      }],
    })).toThrow();
  });
});
