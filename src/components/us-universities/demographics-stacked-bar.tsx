"use client";

// ----------------------------------------------------------------------------
// Demographics stacked bar — a single inline-SVG horizontal bar split into the
// present racial/residency segments. Fail-closed: a null/NaN percentage is NOT
// a zero-width segment, it is dropped entirely. Segmentation math
// (demographicSegments) is pure and exported for direct unit testing.
// ----------------------------------------------------------------------------

import { EM_DASH, formatPct } from "@/lib/us-universities/format";
import { chartColors } from "@/components/sales-dashboard/chart-canvas";
import { cn } from "@/lib/utils";

export interface DemographicInput {
  key: string;
  label: string;
  pct: number | null | undefined;
}

export interface DemographicSegment {
  key: string;
  label: string;
  pct: number;
  offsetPct: number;
  widthPct: number;
}

/** Keep only present (finite) percentages, in order, with cumulative offsets. */
export function demographicSegments(
  inputs: ReadonlyArray<DemographicInput>,
): DemographicSegment[] {
  const out: DemographicSegment[] = [];
  let offset = 0;
  for (const input of inputs) {
    const pct = input.pct;
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
    out.push({ key: input.key, label: input.label, pct, offsetPct: offset, widthPct: pct });
    offset += pct;
  }
  return out;
}

export function DemographicsStackedBar({
  inputs,
  className,
}: {
  inputs: ReadonlyArray<DemographicInput>;
  className?: string;
}): React.JSX.Element {
  const segments = demographicSegments(inputs);
  const colors = chartColors();
  const palette = colors.chart;

  if (segments.length === 0) {
    return <p className={cn("text-sm text-muted-foreground", className)}>{EM_DASH}</p>;
  }

  const ariaLabel = segments.map((s) => `${s.label}: ${formatPct(s.pct)}`).join("; ");

  return (
    <div className={cn("space-y-3", className)} role="img" aria-label={`Student body — ${ariaLabel}`}>
      <svg
        viewBox="0 0 100 6"
        preserveAspectRatio="none"
        className="h-2.5 w-full overflow-hidden rounded-full"
        aria-hidden="true"
      >
        <rect x="0" y="0" width="100" height="6" fill={colors.mutedForeground} opacity={0.12} />
        {segments.map((seg, i) => (
          <rect
            key={seg.key}
            x={seg.offsetPct}
            y="0"
            width={seg.widthPct}
            height="6"
            fill={palette[i % palette.length]}
          />
        ))}
      </svg>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {segments.map((seg, i) => (
          <li key={seg.key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block size-2.5 rounded-sm"
              style={{ backgroundColor: palette[i % palette.length] }}
            />
            <span className="text-muted-foreground">{seg.label}</span>
            <span className="tabular-nums text-foreground">{formatPct(seg.pct)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
