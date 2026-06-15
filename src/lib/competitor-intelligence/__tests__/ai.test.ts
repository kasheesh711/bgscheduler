import { describe, expect, it } from "vitest";
import { deterministicBrief } from "@/lib/competitor-intelligence/ai";
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
});
