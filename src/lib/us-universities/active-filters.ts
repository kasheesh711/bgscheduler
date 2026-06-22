import { CONTROL_LABELS, cip2Label } from "@/lib/us-universities/constants";
import type { FilterParams, UsUniversitiesOverview } from "@/lib/us-universities/types";

// ── Active-filter chip derivation ──────────────────────────────────────
// Turns the current FilterParams into a flat, ordered list of removable
// chips. Each chip carries a `clear` patch (the facet → undefined + page 1)
// that the tray applies via the shell's setFilters updater. Pure + testable;
// `overview` is threaded for forward-compat label enrichment but labels are
// derived only from the filter values + static constant maps.

export interface ActiveChip {
  key: string;
  label: string;
  clear: Partial<FilterParams>;
}

/** Locale-grouped dollar label, e.g. 30000 → "$30,000". */
function usd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * Describe every active filter facet as a removable chip, in a stable order:
 * states → acceptance → control → net price → grad rate → major → search.
 * Blank search is skipped; unknown control codes fall back to "Control {n}".
 */
export function describeActiveFilters(
  filters: FilterParams,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  overview: UsUniversitiesOverview,
): ActiveChip[] {
  const chips: ActiveChip[] = [];

  for (const state of filters.states ?? []) {
    chips.push({
      key: `state:${state}`,
      label: state,
      clear: { states: undefined, page: 1 },
    });
  }

  const hasMin = filters.minAcceptance != null;
  const hasMax = filters.maxAcceptance != null;
  if (hasMin || hasMax) {
    const label = hasMin && hasMax
      ? `Accept ${filters.minAcceptance}–${filters.maxAcceptance}%`
      : hasMax
        ? `Accept ≤${filters.maxAcceptance}%`
        : `Accept ≥${filters.minAcceptance}%`;
    chips.push({
      key: "acceptance",
      label,
      clear: { minAcceptance: undefined, maxAcceptance: undefined, page: 1 },
    });
  }

  for (const control of filters.control ?? []) {
    chips.push({
      key: `control:${control}`,
      label: CONTROL_LABELS[control] ?? `Control ${control}`,
      clear: { control: undefined, page: 1 },
    });
  }

  if (filters.maxNetPrice != null) {
    chips.push({
      key: "netPrice",
      label: `Net ≤ ${usd(filters.maxNetPrice)}`,
      clear: { maxNetPrice: undefined, page: 1 },
    });
  }

  if (filters.minGradRate != null) {
    chips.push({
      key: "gradRate",
      label: `Grad ≥ ${filters.minGradRate}%`,
      clear: { minGradRate: undefined, page: 1 },
    });
  }

  if (filters.cip2 && filters.cip2 !== "") {
    chips.push({
      key: "cip2",
      label: cip2Label(filters.cip2),
      clear: { cip2: undefined, page: 1 },
    });
  }

  const search = filters.search?.trim();
  if (search) {
    chips.push({
      key: "search",
      label: `"${search}"`,
      clear: { search: undefined, page: 1 },
    });
  }

  return chips;
}
