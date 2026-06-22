// ── Compare-set toggle logic (pure, unit-testable) ──────────────────────
// URL-driven shortlist mutations shared by the Console and the Dossier.
// Add-only with dedupe + cap; remove via removeCompareId (separate path).

import { MAX_COMPARE } from "@/lib/us-universities/constants";

/**
 * Return a new id set with `unitId` appended.
 * No-ops when the id is already present or the set is at `MAX_COMPARE`.
 * Never mutates the input array.
 */
export function addCompareId(ids: number[], unitId: number): number[] {
  if (ids.includes(unitId) || ids.length >= MAX_COMPARE) return ids;
  return [...ids, unitId];
}

/**
 * Return a new id set with `unitId` removed.
 * No-ops when the id is not present.
 * Never mutates the input array.
 */
export function removeCompareId(ids: number[], unitId: number): number[] {
  return ids.filter((id) => id !== unitId);
}
