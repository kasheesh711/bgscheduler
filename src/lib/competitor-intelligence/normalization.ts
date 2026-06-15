import { createHash } from "node:crypto";
import type { NormalizedCompetitorItem, NormalizedSerpObservation } from "./types";

const PRICE_PATTERN = /(?:฿|THB|บาท|\b\d{1,3}(?:,\d{3})+\b|\b\d{4,6}\s*(?:baht|thb)\b)/i;
const EVENT_PATTERN = /(webinar|workshop|open house|bootcamp|คอร์ส|สัมมนา|เวิร์กช็อป|event)/i;
const TEST_PREP_PATTERN = /(sat|ielts|toefl|ged|igcse|a-level|ap\b|ib\b|สอบ|ติว)/i;
const ADMISSIONS_PATTERN = /(admission|university|college|essay|portfolio|interview|เรียนต่อ|สมัคร|consult)/i;
const HOMESCHOOL_PATTERN = /(homeschool|home school|alternative education|โฮมสคูล)/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dateValue(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

export function canonicalizeUrl(input: string | null | undefined): string | null {
  const text = input?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    url.hash = "";
    url.searchParams.sort();
    return url.toString().replace(/\/$/, "");
  } catch {
    return text.replace(/\/$/, "");
  }
}

export function buildEvidenceItemKey(input: {
  entitySlug: string;
  channel: string;
  canonicalUrl?: string | null;
  publishedAt?: Date | null;
  contentText?: string | null;
}): string {
  const basis = [
    input.entitySlug,
    input.channel,
    canonicalizeUrl(input.canonicalUrl) ?? "",
    input.publishedAt?.toISOString() ?? "",
    (input.contentText ?? "").slice(0, 500),
  ].join("|");
  return `ci:${stableHash(basis)}`;
}

export function classifyMarketCategory(text: string): string {
  if (PRICE_PATTERN.test(text)) return "pricing_offer";
  if (EVENT_PATTERN.test(text)) return "event_campaign";
  if (TEST_PREP_PATTERN.test(text)) return "test_prep";
  if (ADMISSIONS_PATTERN.test(text)) return "admissions";
  if (HOMESCHOOL_PATTERN.test(text)) return "homeschool";
  return "market_activity";
}

export function scoreImpact(text: string, metrics: Record<string, unknown>): number {
  let score = 1;
  if (PRICE_PATTERN.test(text)) score += 3;
  if (EVENT_PATTERN.test(text)) score += 2;
  if (TEST_PREP_PATTERN.test(text) || ADMISSIONS_PATTERN.test(text)) score += 1;
  const likes = numberValue(metrics.likes) ?? numberValue(metrics.likesCount) ?? 0;
  const comments = numberValue(metrics.comments) ?? numberValue(metrics.commentsCount) ?? 0;
  const views = numberValue(metrics.views) ?? numberValue(metrics.videoViewCount) ?? 0;
  if (likes >= 100) score += 1;
  if (comments >= 20) score += 1;
  if (views >= 1000) score += 1;
  return Math.min(10, score);
}

export function extractWebsiteSignals(html: string, sourceUrl: string, entitySlug: string): NormalizedCompetitorItem {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || sourceUrl;
  const description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim()
    || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim()
    || "";
  const text = `${title}\n${description}`.trim();
  const canonicalUrl = canonicalizeUrl(sourceUrl);
  const category = classifyMarketCategory(text);
  const publishedAt = null;
  return {
    itemKey: buildEvidenceItemKey({ entitySlug, channel: "website", canonicalUrl, publishedAt, contentText: text }),
    channel: "website",
    category,
    title,
    summary: description || "Website content snapshot captured.",
    contentText: text,
    canonicalUrl,
    language: /[\u0E00-\u0E7F]/.test(text) ? "th" : "en",
    publishedAt,
    impactScore: scoreImpact(text, {}),
    confidence: 0.8,
    pricingSignal: PRICE_PATTERN.test(text),
    metrics: {},
    raw: { title, description, sourceUrl },
    assetUrls: [],
  };
}

export function normalizeApifyInstagramItem(rawValue: unknown, entitySlug: string): NormalizedCompetitorItem {
  const raw = asRecord(rawValue);
  const caption = stringValue(raw.caption) || stringValue(raw.text) || stringValue(raw.alt) || "";
  const shortCode = stringValue(raw.shortCode);
  const url = canonicalizeUrl(stringValue(raw.url) || (shortCode ? `https://www.instagram.com/p/${shortCode}/` : ""));
  const publishedAt = dateValue(raw.timestamp) ?? dateValue(raw.takenAt) ?? dateValue(raw.createdAt);
  const title = caption.split(/\n/)[0]?.slice(0, 120) || "Instagram activity";
  const metrics = {
    likes: numberValue(raw.likesCount ?? raw.likes),
    comments: numberValue(raw.commentsCount ?? raw.comments),
    views: numberValue(raw.videoViewCount ?? raw.videoPlayCount ?? raw.views),
  };
  const assetUrls = [raw.displayUrl, raw.imageUrl, raw.videoUrl]
    .map((value) => stringValue(value))
    .filter(Boolean);
  const category = classifyMarketCategory(caption);
  return {
    itemKey: buildEvidenceItemKey({ entitySlug, channel: "instagram", canonicalUrl: url, publishedAt, contentText: caption }),
    channel: "instagram",
    category,
    title,
    summary: caption.slice(0, 240),
    contentText: caption,
    canonicalUrl: url,
    language: /[\u0E00-\u0E7F]/.test(caption) ? "th" : "en",
    publishedAt,
    impactScore: scoreImpact(caption, metrics),
    confidence: 0.75,
    pricingSignal: PRICE_PATTERN.test(caption),
    metrics,
    raw,
    assetUrls,
  };
}

export function normalizeApifyFacebookItem(rawValue: unknown, entitySlug: string): NormalizedCompetitorItem {
  const raw = asRecord(rawValue);
  const content = stringValue(raw.text) || stringValue(raw.message) || stringValue(raw.postText) || "";
  const url = canonicalizeUrl(stringValue(raw.url) || stringValue(raw.postUrl) || stringValue(raw.facebookUrl));
  const publishedAt = dateValue(raw.time) ?? dateValue(raw.timestamp) ?? dateValue(raw.createdAt);
  const title = content.split(/\n/)[0]?.slice(0, 120) || "Facebook activity";
  const metrics = {
    likes: numberValue(raw.likes ?? raw.likesCount),
    comments: numberValue(raw.comments ?? raw.commentsCount),
    shares: numberValue(raw.shares ?? raw.sharesCount),
  };
  const media = Array.isArray(raw.media) ? raw.media : [];
  const assetUrls = [
    stringValue(raw.image),
    stringValue(raw.imageUrl),
    ...media.map((item) => stringValue(asRecord(item).url)),
  ].filter(Boolean);
  const category = classifyMarketCategory(content);
  return {
    itemKey: buildEvidenceItemKey({ entitySlug, channel: "facebook", canonicalUrl: url, publishedAt, contentText: content }),
    channel: "facebook",
    category,
    title,
    summary: content.slice(0, 240),
    contentText: content,
    canonicalUrl: url,
    language: /[\u0E00-\u0E7F]/.test(content) ? "th" : "en",
    publishedAt,
    impactScore: scoreImpact(content, metrics),
    confidence: 0.72,
    pricingSignal: PRICE_PATTERN.test(content),
    metrics,
    raw,
    assetUrls,
  };
}

export function normalizeDataForSeoItems(input: {
  keyword: string;
  language: string;
  location: string;
  device: string;
  items: unknown[];
}): NormalizedSerpObservation[] {
  const observedDate = new Date().toISOString().slice(0, 10);
  return input.items.map((value, index) => {
    const raw = asRecord(value);
    const url = canonicalizeUrl(stringValue(raw.url));
    const title = stringValue(raw.title);
    const domain = stringValue(raw.domain) || stringValue(raw.breadcrumb);
    const resultType = stringValue(raw.type) || "organic";
    const rankAbsolute = numberValue(raw.rank_absolute) ?? numberValue(raw.rankAbsolute) ?? index + 1;
    const rankGroup = numberValue(raw.rank_group) ?? numberValue(raw.rankGroup) ?? null;
    const basis = `${observedDate}|${input.keyword}|${input.language}|${input.location}|${input.device}|${resultType}|${rankAbsolute}|${url ?? title}`;
    return {
      observationKey: `serp:${stableHash(basis)}`,
      keyword: input.keyword,
      language: input.language,
      location: input.location,
      device: input.device,
      resultType,
      rankAbsolute,
      rankGroup,
      title: title || null,
      url,
      displayUrl: domain || null,
      snippet: stringValue(raw.description ?? raw.snippet) || null,
      isBeGifted: Boolean(url?.toLowerCase().includes("begifted") || domain.toLowerCase().includes("begifted")),
      raw,
    };
  });
}

export function buildTaskSuggestionSeed(item: Pick<NormalizedCompetitorItem, "category" | "title" | "impactScore" | "pricingSignal">) {
  if (item.impactScore < 4 && !item.pricingSignal) return null;
  const priority = item.impactScore >= 7 ? "high" : item.impactScore >= 5 ? "medium" : "low";
  const title = item.pricingSignal
    ? `Review pricing signal: ${item.title}`
    : `Plan response to competitor move: ${item.title}`;
  const description = item.pricingSignal
    ? "Validate the offer/pricing evidence and decide whether BeGifted should adjust positioning or messaging."
    : "Review this market activity and decide whether a marketing, sales, or product response is needed.";
  return {
    title: title.slice(0, 180),
    description,
    priority,
    labels: [item.category, item.pricingSignal ? "pricing" : "campaign"],
    confidence: Math.min(0.9, 0.55 + item.impactScore / 20),
  };
}
