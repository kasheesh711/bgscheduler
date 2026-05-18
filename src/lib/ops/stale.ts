// API stale warnings tolerate 30-minute Pro cron + recovery headroom.
export const API_STALE_THRESHOLD_MS = 90 * 60 * 1000;
export const APP_STALE_BANNER_THRESHOLD_MS = 2 * 60 * 60 * 1000;
export const STALE_SEARCH_WARNING =
  "Search data may be stale — last sync was more than 90 minutes ago";
export const STALE_BANNER_TEXT =
  "Tutor data may be outdated. Last successful sync was over 2 hours ago.";
export const STALE_BANNER_LINK_LABEL = "View data health";
export const STALE_BANNER_SESSION_KEY = "bgscheduler:stale-banner-dismissed";

export function isApiSnapshotStale(staleAgeMs: number): boolean {
  return staleAgeMs > API_STALE_THRESHOLD_MS;
}

export function shouldShowStaleBanner(staleAgeMs: number | null): boolean {
  return staleAgeMs !== null && staleAgeMs > APP_STALE_BANNER_THRESHOLD_MS;
}
