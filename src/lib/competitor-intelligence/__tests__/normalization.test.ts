import { describe, expect, it, vi } from "vitest";
import {
  buildEvidenceItemKey,
  extractWebsiteSignals,
  normalizeApifyFacebookItem,
  normalizeApifyInstagramItem,
  normalizeDataForSeoItems,
} from "@/lib/competitor-intelligence/normalization";

describe("competitor intelligence normalization", () => {
  it("builds stable evidence keys from canonical source facts", () => {
    const keyA = buildEvidenceItemKey({
      entitySlug: "crimson-thailand",
      channel: "website",
      canonicalUrl: "https://example.com/course/?b=2&a=1#section",
      contentText: "SAT bootcamp",
    });
    const keyB = buildEvidenceItemKey({
      entitySlug: "crimson-thailand",
      channel: "website",
      canonicalUrl: "https://example.com/course/?a=1&b=2",
      contentText: "SAT bootcamp",
    });

    expect(keyA).toBe(keyB);
  });

  it("extracts website pricing and course signals", () => {
    const item = extractWebsiteSignals(
      "<html><head><title>SAT Intensive Course</title><meta name=\"description\" content=\"Early bird THB 12,000 for Bangkok students\"></head></html>",
      "https://competitor.example/sat",
      "competitor",
    );

    expect(item.channel).toBe("website");
    expect(item.category).toBe("pricing_offer");
    expect(item.pricingSignal).toBe(true);
    expect(item.impactScore).toBeGreaterThanOrEqual(4);
  });

  it("normalizes Apify Instagram posts with metrics and media", () => {
    const item = normalizeApifyInstagramItem({
      caption: "IELTS workshop this weekend",
      shortCode: "ABC123",
      timestamp: "2026-06-14T08:00:00.000Z",
      likesCount: 150,
      commentsCount: 25,
      displayUrl: "https://cdn.example/post.jpg",
    }, "edusmith");

    expect(item.channel).toBe("instagram");
    expect(item.canonicalUrl).toBe("https://www.instagram.com/p/ABC123");
    expect(item.assetUrls).toEqual(["https://cdn.example/post.jpg"]);
    expect(item.impactScore).toBeGreaterThanOrEqual(5);
  });

  it("normalizes Apify Facebook posts", () => {
    const item = normalizeApifyFacebookItem({
      postText: "New university admissions webinar",
      postUrl: "https://facebook.com/post/1",
      time: "2026-06-14T08:00:00.000Z",
      shares: 12,
    }, "ignite");

    expect(item.channel).toBe("facebook");
    expect(item.category).toBe("event_campaign");
    expect(item.canonicalUrl).toBe("https://facebook.com/post/1");
  });

  it("parses DataForSEO rank observations with daily keys", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
    const first = normalizeDataForSeoItems({
      keyword: "sat prep bangkok",
      language: "en",
      location: "Bangkok,Bangkok,Thailand",
      device: "mobile",
      items: [
        {
          type: "organic",
          rank_absolute: 2,
          rank_group: 1,
          title: "BeGifted SAT",
          url: "https://www.begifted.com/sat",
          domain: "begifted.com",
          description: "SAT prep",
        },
      ],
    })[0];

    vi.setSystemTime(new Date("2026-06-16T00:00:00.000Z"));
    const second = normalizeDataForSeoItems({
      keyword: "sat prep bangkok",
      language: "en",
      location: "Bangkok,Bangkok,Thailand",
      device: "mobile",
      items: [
        {
          type: "organic",
          rank_absolute: 2,
          title: "BeGifted SAT",
          url: "https://www.begifted.com/sat",
          domain: "begifted.com",
        },
      ],
    })[0];
    vi.useRealTimers();

    expect(first.isBeGifted).toBe(true);
    expect(first.rankAbsolute).toBe(2);
    expect(first.observationKey).not.toBe(second.observationKey);
  });
});
