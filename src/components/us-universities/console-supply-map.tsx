"use client";

// ── Console supply locator (optional, toggle-gated) ────────────────────
// Scatters a pin for each CURRENTLY-LOADED row with mappable coordinates.
// LOCATOR dot-map only — no aggregation, no fetch, no derived metric; pins
// come straight from row lat/lng. Optional + isolated: the Console may mount
// it or omit it without touching any other view.

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { buildDotMapPoints } from "@/lib/us-universities/dot-map";
import type { IpedsInstitutionSummary } from "@/lib/us-universities/types";
import { UsDotMap } from "./us-dot-map";

/** Accessible summary of how many loaded rows are plottable. */
export function supplyMapAriaLabel(plottedCount: number, totalCount: number): string {
  return `Showing ${plottedCount} of ${totalCount} loaded schools with mappable locations`;
}

export interface ConsoleSupplyMapProps {
  rows: IpedsInstitutionSummary[];
  open: boolean;
  onToggle: (next: boolean) => void;
  className?: string;
}

/**
 * Render the toggle and, when open, the locator scatter of loaded rows.
 * When open with nothing plottable, shows a muted note instead of the map.
 */
export function ConsoleSupplyMap({
  rows,
  open,
  onToggle,
  className,
}: ConsoleSupplyMapProps): React.ReactElement {
  const points = open ? buildDotMapPoints(rows) : [];
  return (
    <div className={cn("space-y-2", className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onToggle(!open)}
        aria-pressed={open}
      >
        {open ? "Hide supply map" : "Show supply map"}
      </Button>
      {open && points.length > 0 && (
        <UsDotMap
          points={points}
          ariaLabel={supplyMapAriaLabel(points.length, rows.length)}
        />
      )}
      {open && points.length === 0 && (
        <p className="text-sm text-muted-foreground">No mappable locations</p>
      )}
    </div>
  );
}
