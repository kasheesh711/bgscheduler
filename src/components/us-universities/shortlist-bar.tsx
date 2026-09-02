"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { chartColors } from "@/components/sales-dashboard/chart-canvas";
import { cn } from "@/lib/utils";
import { MAX_COMPARE } from "@/lib/us-universities/constants";
import { compareColorIndex } from "./compare-colors";

// ─────────────────────────────────────────────────────────────────────────────
// Slim sticky bottom dock summarizing the compare shortlist (the `?compare=`
// set). Renders one colored, removable chip per school, a Clear-all control,
// and a "Compare (N)" button that opens the compare sheet. Color per school is
// derived from its position in the shortlist via compareColorIndex so the dock,
// the sheet, and any chart share one palette. Returns null when empty.
// ─────────────────────────────────────────────────────────────────────────────

export interface ShortlistEntry {
  unitId: number;
  name: string;
}

export interface ShortlistBarProps {
  entries: ShortlistEntry[];
  onRemove: (unitId: number) => void;
  onClear: () => void;
  onOpenCompare: () => void;
}

/** Hex/OKLCH color for a school given the ordered shortlist (SSR-safe). */
export function shortlistColor(unitId: number, orderedIds: number[]): string {
  const palette = chartColors().chart;
  return palette[compareColorIndex(unitId, orderedIds) % palette.length];
}

export function ShortlistBar({
  entries,
  onRemove,
  onClear,
  onOpenCompare,
}: ShortlistBarProps): React.JSX.Element | null {
  if (entries.length === 0) return null;

  const orderedIds = entries.map((e) => e.unitId);
  const atCapacity = entries.length >= MAX_COMPARE;

  return (
    <div className="sticky bottom-0 z-30 mt-auto border-t border-border bg-card/95 px-4 py-3 backdrop-blur supports-backdrop-filter:bg-card/80 md:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium text-muted-foreground">Shortlist</span>
        <ul className="flex flex-1 flex-wrap items-center gap-2" aria-label="Compare shortlist">
          {entries.map((entry) => (
            <li
              key={entry.unitId}
              className="flex items-center gap-2 rounded-full border border-border bg-background py-1 pr-1 pl-2.5 text-sm"
            >
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: shortlistColor(entry.unitId, orderedIds) }}
                aria-hidden="true"
              />
              <span className="max-w-44 truncate text-foreground">{entry.name}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${entry.name}`}
                onClick={() => onRemove(entry.unitId)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex shrink-0 items-center gap-2">
          {atCapacity ? (
            <span className="text-xs text-muted-foreground">Max {MAX_COMPARE} reached</span>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear all
          </Button>
          <Button
            size="sm"
            onClick={onOpenCompare}
            disabled={entries.length === 0}
            className={cn(entries.length === 0 && "pointer-events-none opacity-50")}
          >
            Compare ({entries.length})
          </Button>
        </div>
      </div>
    </div>
  );
}
