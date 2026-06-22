"use client";

// ── US locator dot-map (inline SVG, no dependency) ─────────────────────
// A LOCATOR dot-map: plots raw institution lat/lng as pins over a committed,
// SIMPLIFIED single-path continental-US silhouette. This is NOT a filterable
// choropleth and carries no aggregated data — each pin is one institution.
// Renders deterministic SVG (no effects/fetch); degrades to null when there
// is nothing plottable. Colors use OKLCH semantic tokens only.

import { cn } from "@/lib/utils";
import type { DotMapPoint } from "@/lib/us-universities/dot-map";
import { DOT_MAP_VIEWBOX } from "@/lib/us-universities/dot-map";

// Deliberately approximate: a single closed path tracing a rough continental
// outline sized to DOT_MAP_VIEWBOX (960×600). Not geographically precise —
// it exists only to give pins a recognisable frame of reference.
const US_OUTLINE_PATH =
  "M40 180 L120 120 L300 90 L520 70 L760 60 L900 110 L920 200 " +
  "L880 300 L840 360 L800 420 L720 470 L640 510 L520 540 L400 540 " +
  "L300 510 L220 470 L150 410 L90 330 L50 250 Z";

export interface UsDotMapProps {
  points: DotMapPoint[];
  ariaLabel: string;
  /** Out-of-bounds label (AK/HI/territory) shown when there are no pins. */
  chipLabel?: string | null;
  className?: string;
  /** Highlighted pin (e.g. the dossier subject). */
  activeUnitId?: number | null;
}

/**
 * Render the locator map. Returns null when nothing is plottable (no points
 * and no out-of-bounds chip), so callers can mount it unconditionally.
 */
export function UsDotMap({
  points,
  ariaLabel,
  chipLabel,
  className,
  activeUnitId,
}: UsDotMapProps): React.ReactElement | null {
  const hasChip = typeof chipLabel === "string" && chipLabel.length > 0;
  if (points.length === 0 && !hasChip) return null;

  if (points.length === 0 && hasChip) {
    return (
      <div
        role="img"
        aria-label={ariaLabel}
        className={cn(
          "flex items-center justify-center rounded-md border bg-muted/40 px-3 py-6",
          className,
        )}
      >
        <span className="rounded-full border border-border bg-card px-3 py-1 text-sm font-medium text-muted-foreground tabular-nums">
          {chipLabel}
        </span>
      </div>
    );
  }

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${DOT_MAP_VIEWBOX.width} ${DOT_MAP_VIEWBOX.height}`}
      className={cn("h-auto w-full rounded-md border bg-muted/30", className)}
    >
      <path
        d={US_OUTLINE_PATH}
        className="fill-muted stroke-border"
        strokeWidth={2}
        aria-hidden="true"
      />
      {points.map((point) => {
        const isActive = activeUnitId != null && point.unitId === activeUnitId;
        return (
          <circle
            key={point.unitId}
            cx={point.x}
            cy={point.y}
            r={isActive ? 9 : 6}
            className={cn(
              "fill-primary",
              isActive && "stroke-primary",
            )}
            strokeWidth={isActive ? 3 : 0}
            fillOpacity={isActive ? 1 : 0.7}
          >
            <title>{point.name}</title>
          </circle>
        );
      })}
    </svg>
  );
}
