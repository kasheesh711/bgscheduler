"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONTROL_LABELS, INST_SIZE_LABELS } from "@/lib/us-universities/constants";
import { formatInt, formatPct, formatSatRange } from "@/lib/us-universities/format";
import type { IpedsInstitutionListItem } from "@/lib/us-universities/types";
import { cn } from "@/lib/utils";
import { acceptanceDelta } from "./institution-table";

// ────────────────────────────────────────────────────────────────────────────
// Institution gallery card — the default (card view) presentation of a search
// result. Pure presenter: name + location, control/size badges (omitted when
// the code is null/unmapped — fail-closed), a compact stat grid (all numeric
// nulls render EM_DASH via the format.ts helpers), acceptance delta vs prior
// year (omitted when prior-year data is null), and an Add-to-shortlist button
// mirroring the table row's disabled/label/aria semantics.
// ────────────────────────────────────────────────────────────────────────────

export interface InstitutionCardProps {
  row: IpedsInstitutionListItem;
  inCompare: boolean;
  compareFull: boolean;
  onSelect: (unitId: number) => void;
  onAddCompare: (unitId: number) => void;
}

interface StatProps {
  label: string;
  value: string;
}

function Stat({ label, value }: StatProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function InstitutionCard({
  row,
  inCompare,
  compareFull,
  onSelect,
  onAddCompare,
}: InstitutionCardProps) {
  const controlLabel = row.control != null ? CONTROL_LABELS[row.control] : undefined;
  const sizeLabel = row.instSize != null ? INST_SIZE_LABELS[row.instSize] : undefined;
  const location = [row.city, row.stateAbbr].filter(Boolean).join(", ");
  const delta = acceptanceDelta(row);

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => onSelect(row.unitId)}
          className="text-left text-base font-semibold text-foreground hover:underline"
        >
          {row.instName}
        </button>
        {location ? <p className="text-xs text-muted-foreground">{location}</p> : null}
      </div>

      {controlLabel || sizeLabel ? (
        <div className="flex flex-wrap gap-1.5">
          {controlLabel ? (
            <span className="rounded-full border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {controlLabel}
            </span>
          ) : null}
          {sizeLabel ? (
            <span className="rounded-full border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {sizeLabel}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <Stat label="Acceptance" value={formatPct(row.acceptanceRate)} />
        <Stat label="SAT (read)" value={formatSatRange(row.satReadingP25, row.satReadingP75)} />
        <Stat label="Enrollment" value={formatInt(row.enrollmentTotal)} />
        <Stat label="Grad 6yr" value={formatPct(row.gradRateBach6yr)} />
        <Stat label="Net price" value={formatInt(row.avgNetPrice, "$")} />
        {delta ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Acceptance Δ
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-xs font-medium tabular-nums",
                delta.direction === "down" ? "text-available" : "text-destructive",
              )}
            >
              {delta.direction === "flat" ? (
                <span className="text-muted-foreground">0pp</span>
              ) : (
                <>
                  {delta.direction === "down" ? (
                    <ArrowDown aria-hidden className="size-3" />
                  ) : (
                    <ArrowUp aria-hidden className="size-3" />
                  )}
                  {Math.abs(Math.round(delta.points * 10) / 10)}pp
                </>
              )}
            </span>
          </div>
        ) : null}
      </div>

      <div className="mt-auto flex justify-end pt-1">
        <Button
          variant={inCompare ? "secondary" : "outline"}
          size="sm"
          disabled={inCompare || compareFull}
          onClick={() => onAddCompare(row.unitId)}
          aria-label={
            inCompare
              ? `${row.instName} is already in compare`
              : `Add ${row.instName} to compare`
          }
        >
          {inCompare ? "Added" : "Compare"}
        </Button>
      </div>
    </div>
  );
}
