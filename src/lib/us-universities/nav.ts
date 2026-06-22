// ── US Universities navigation hrefs (pure, exported for tests) ─────────
// Console <-> Dossier links thread the active filters AND the shortlist so a
// round-trip preserves both. Shortlist source of truth is the ?compare= param.

import { buildSearchQuery } from "@/components/us-universities/institution-table";
import type { FilterParams } from "@/lib/us-universities/types";

/** Append `&compare=<ids>` to a query string, or nothing when the list is empty. */
function withCompare(query: string, compareIds: number[]): string {
  if (compareIds.length === 0) return query;
  return `${query}&compare=${encodeURIComponent(compareIds.join(","))}`;
}

/** Deep link to a single institution's dossier, carrying filters + shortlist. */
export function dossierHref(
  unitId: number,
  filters: FilterParams,
  compareIds: number[]
): string {
  const query = withCompare(buildSearchQuery(filters), compareIds);
  return `/us-universities/${unitId}?${query}`;
}

/** Link back to the Console (browse) with filters + shortlist restored. */
export function consoleHref(filters: FilterParams, compareIds: number[]): string {
  const query = withCompare(buildSearchQuery(filters), compareIds);
  return `/us-universities?${query}`;
}
