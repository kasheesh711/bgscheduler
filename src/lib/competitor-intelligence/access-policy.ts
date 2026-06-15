export const COMPETITOR_INTELLIGENCE_ROUTE = "/competitor-intelligence";

export function hasCompetitorIntelligenceAccess(
  allowedPages: string[] | null | undefined,
  role: string | null | undefined,
): boolean {
  if (role && role !== "admin") return false;
  if (!allowedPages) return true;
  return allowedPages.some((page) =>
    page === COMPETITOR_INTELLIGENCE_ROUTE ||
    page.startsWith(`${COMPETITOR_INTELLIGENCE_ROUTE}/`)
  );
}
