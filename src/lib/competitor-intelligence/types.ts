export type CompetitorSourceType = "website" | "sitemap" | "instagram" | "facebook" | "serp" | "manual";
export type CompetitorSourceStatus = "active" | "disabled" | "needs_review" | "archived";
export type CompetitorEntityKind = "competitor" | "own_brand";
export type CompetitorTaskStatus = "todo" | "in_progress" | "blocked" | "done" | "ignored";
export type CompetitorSyncTrigger = "cron" | "manual" | "backfill";

export interface NormalizedCompetitorItem {
  itemKey: string;
  channel: string;
  category: string;
  title: string;
  summary: string;
  contentText: string;
  canonicalUrl: string | null;
  language: string | null;
  publishedAt: Date | null;
  impactScore: number;
  confidence: number;
  pricingSignal: boolean;
  metrics: Record<string, unknown>;
  raw: Record<string, unknown>;
  assetUrls: string[];
}

export interface NormalizedSerpObservation {
  observationKey: string;
  keyword: string;
  language: string;
  location: string;
  device: string;
  resultType: string;
  rankAbsolute: number | null;
  rankGroup: number | null;
  title: string | null;
  url: string | null;
  displayUrl: string | null;
  snippet: string | null;
  isBeGifted: boolean;
  raw: Record<string, unknown>;
}

export interface ProviderFetchResult {
  items: NormalizedCompetitorItem[];
  serpObservations?: NormalizedSerpObservation[];
  fetchedCount: number;
  usageUnits: number;
  estimatedCostUsd: number;
  skippedReason?: string;
  metadata?: Record<string, unknown>;
}

export interface CompetitorDashboardPayload {
  checkedAt: string;
  brief: {
    id: string | null;
    briefDate: string;
    title: string;
    executiveSummary: string;
    whatChanged: string[];
    whyItMatters: string[];
    recommendedResponses: string[];
    confidence: number;
    coverageScore: number;
    seoVisibilityScore: number;
    openTaskCount: number;
    budgetUsageRatio: number;
    sourceHealth: Record<string, unknown>;
  };
  kpis: {
    coveragePercent: number;
    seoVisibilityScore: number;
    openTaskCount: number;
    budgetUsedPercent: number;
    highImpactMoves: number;
    sourceFailures: number;
  };
  entities: Array<{
    id: string;
    slug: string;
    displayName: string;
    kind: CompetitorEntityKind;
    categoryTags: string[];
    active: boolean;
    sourceCount: number;
    latestItemAt: string | null;
  }>;
  sources: Array<{
    id: string;
    entityId: string;
    entityName: string;
    sourceType: CompetitorSourceType;
    label: string;
    url: string;
    provider: string;
    priority: number;
    status: CompetitorSourceStatus;
    reliability: string;
    bestEffort: boolean;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  }>;
  recentItems: Array<{
    id: string;
    entityName: string;
    channel: string;
    category: string;
    title: string;
    summary: string | null;
    canonicalUrl: string | null;
    observedAt: string;
    publishedAt: string | null;
    impactScore: number;
    confidence: number;
    pricingSignal: boolean;
    reviewStatus: string;
    assetCount: number;
  }>;
  serp: Array<{
    keyword: string;
    language: string;
    location: string;
    device: string;
    status: CompetitorSourceStatus;
    autoTracked: boolean;
    confidence: number;
    latestObservedAt: string | null;
    bestBeGiftedRank: number | null;
    bestCompetitorRank: number | null;
  }>;
  taskSuggestions: Array<{
    id: string;
    title: string;
    description: string;
    priority: string;
    dueDate: string | null;
    labels: string[];
    confidence: number;
    itemTitle: string | null;
    competitorName: string | null;
    status: string;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    status: CompetitorTaskStatus;
    priority: string;
    ownerEmail: string | null;
    dueDate: string | null;
    labels: string[];
    itemTitle: string | null;
    competitorName: string | null;
    updatedAt: string;
  }>;
  runs: Array<{
    id: string;
    status: string;
    triggerType: CompetitorSyncTrigger;
    startedAt: string;
    finishedAt: string | null;
    sourceCount: number;
    sourceSuccessCount: number;
    sourceFailedCount: number;
    sourceSkippedCount: number;
    itemCount: number;
    newItemCount: number;
    budgetSkippedCount: number;
    errorSummary: string | null;
  }>;
  usage: Array<{
    usageMonth: string;
    provider: string;
    sourceType: CompetitorSourceType;
    usageUnits: number;
    estimatedCostUsd: number;
    hardCapUsd: number;
    capped: boolean;
  }>;
}
