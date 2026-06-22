"use client";

// ----------------------------------------------------------------------------
// Price ladder — inline-SVG horizontal bars for the Cost section. Bars scale to
// the largest PRESENT value (fail-closed: a missing/NaN value gets no bar and an
// em-dash label, never a zero-length bar). The scaling math (ladderBars) is pure
// and exported for direct unit testing.
// ----------------------------------------------------------------------------

import { EM_DASH, formatUsd } from "@/lib/us-universities/format";
import { chartColors } from "@/components/sales-dashboard/chart-canvas";
import { cn } from "@/lib/utils";

export interface LadderItem {
  label: string;
  value: number | null | undefined;
}

export interface LadderBar {
  label: string;
  value: number | null;
  widthPct: number | null;
  display: string;
}

function present(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Scale ladder items to percentage widths of the maximum present value.
 * Absent values (null/undefined/NaN) get widthPct=null and an em-dash display.
 */
export function ladderBars(items: ReadonlyArray<LadderItem>): LadderBar[] {
  const values = items.map((i) => present(i.value));
  const max = values.reduce<number>((m, v) => (v != null && v > m ? v : m), 0);
  return items.map((item, idx) => {
    const value = values[idx];
    const widthPct = value != null && max > 0 ? Math.round((value / max) * 1000) / 10 : null;
    return {
      label: item.label,
      value,
      widthPct,
      display: value != null ? formatUsd(value) : EM_DASH,
    };
  });
}

export function PriceLadder({
  items,
  className,
}: {
  items: ReadonlyArray<LadderItem>;
  className?: string;
}): React.JSX.Element {
  const bars = ladderBars(items);
  const colors = chartColors();
  const ariaLabel = bars.map((b) => `${b.label}: ${b.display}`).join("; ");
  return (
    <div
      className={cn("space-y-2", className)}
      role="img"
      aria-label={`Cost breakdown — ${ariaLabel}`}
    >
      {bars.map((bar) => (
        <div key={bar.label} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-muted-foreground">{bar.label}</span>
            <span
              className={cn(
                "tabular-nums",
                bar.value == null ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {bar.display}
            </span>
          </div>
          <svg
            viewBox="0 0 100 6"
            preserveAspectRatio="none"
            className="h-1.5 w-full overflow-hidden rounded-full"
            aria-hidden="true"
          >
            <rect x="0" y="0" width="100" height="6" fill={colors.mutedForeground} opacity={0.12} />
            {bar.widthPct != null && (
              <rect x="0" y="0" width={bar.widthPct} height="6" fill={colors.chart[0]} rx="3" />
            )}
          </svg>
        </div>
      ))}
    </div>
  );
}
