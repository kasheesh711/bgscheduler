"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeActiveFilters } from "@/lib/us-universities/active-filters";
import type { FilterParams, UsUniversitiesOverview } from "@/lib/us-universities/types";

// ----------------------------------------------------------------------------
// Active-filter chip tray — renders describeActiveFilters() as removable pills.
// Each pill clears its facet via the shell-supplied onClear(patch); a trailing
// "Clear all" wipes every active facet. Renders nothing when no filter is set,
// so the sub-header collapses cleanly when results are unfiltered.
// ----------------------------------------------------------------------------

export interface FilterChipTrayProps {
  filters: FilterParams;
  overview: UsUniversitiesOverview;
  /** Apply one chip's clear patch (facet → undefined, page reset). */
  onClear: (patch: Partial<FilterParams>) => void;
  /** Reset every active facet at once. */
  onClearAll: () => void;
}

export function FilterChipTray({ filters, overview, onClear, onClearAll }: FilterChipTrayProps) {
  const chips = describeActiveFilters(filters, overview);
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => onClear(chip.clear)}
          aria-label={`Remove filter ${chip.label}`}
          className="inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
        >
          {chip.label}
          <X aria-hidden className="size-3 text-muted-foreground" />
        </button>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={onClearAll}
        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
      >
        Clear all
      </Button>
    </div>
  );
}
