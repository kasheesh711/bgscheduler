// ── US Universities — chart cross-filter helpers ───────────────────────
// Pure mappers that translate an Overview chart click (acceptance band,
// state bar, control slice) into a FilterParams patch the Console merges
// into the live browse query. topStates mirrors buildStateBarData's sort so
// a bar index resolves to the same StateFacet the chart rendered.

import type { AcceptanceBucket, FilterParams, StateFacet } from "./types";

/** Acceptance-rate band → min/max acceptance filter bounds. */
export function acceptanceBucketToFilter(b: AcceptanceBucket): Partial<FilterParams> {
  return { minAcceptance: b.min, maxAcceptance: b.max };
}

/** A state abbreviation → single-state filter. */
export function stateToFilter(state: string): Partial<FilterParams> {
  return { states: [state] };
}

/** A control code (1 Public / 2 nonprofit / 3 for-profit) → single-control filter. */
export function controlToFilter(control: number): Partial<FilterParams> {
  return { control: [control] };
}

/**
 * Top-N states by institution count, descending — the SAME ordering as
 * buildStateBarData so the chart's bar index maps back to the right state.
 * Copies before sorting so the source array is never mutated.
 */
export function topStates(states: StateFacet[], topN = 15): StateFacet[] {
  return [...states].sort((a, b) => b.count - a.count).slice(0, topN);
}
