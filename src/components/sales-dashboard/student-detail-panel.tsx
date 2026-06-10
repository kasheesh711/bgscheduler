"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TransactionsTable } from "@/components/sales-dashboard/transactions-table";
import { formatCurrency } from "@/lib/sales-dashboard/format";
import { buildCoverageWindows } from "@/lib/sales-dashboard/student-journey";
import type {
  CoverageWindow,
  SlimTransaction,
  StudentDirectoryEntry,
  StudentLiveStatus,
} from "@/lib/sales-dashboard/types";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------------------
// Student detail panel — centered dialog below xl, right-hand side panel at
// xl+. Shows the purchase history (via the shared <TransactionsTable>), the
// coverage-window renewal timeline (buildCoverageWindows over the student's
// fetched slim transactions), the trial-conversion marker, and the live churn
// rule spelled out. Nickname-identity caveat is surfaced, never hidden.
// ----------------------------------------------------------------------------

/** Badge variant per live status — shared with the Students directory rows. */
export const STATUS_BADGE_VARIANTS: Record<
  StudentLiveStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  Active: "default",
  Retained: "secondary",
  Pending: "outline",
  Churned: "destructive",
  "Trial-only": "outline",
};

/** The live churn rule, spelled out verbatim wherever a status is shown. */
export const CHURN_RULE_TEXT =
  "Churn rule: a student counts as churned when no payment lands within 14 days after the package's valid-until date.";

const SEGMENT_CLASSES: Record<CoverageWindow["status"], string> = {
  covered: "bg-available/40",
  open: "bg-available/80",
  gap: "bg-blocked/50",
};

const SEGMENT_LABELS: Record<CoverageWindow["status"], string> = {
  covered: "Covered",
  open: "Open coverage",
  gap: "Gap",
};

const JOURNEY_PAGE_SIZE = 1000;

/** Whole days between two ISO dates (UTC math; inputs are date-only strings). */
export function daysBetweenIso(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86_400_000,
  );
}

export interface ConversionMarker {
  trialDate: string;
  convertedDate: string | null;
  daysToConvert: number | null;
}

/**
 * Derive the trial-conversion marker from a student's slim transactions.
 *
 * 1. Only `kind: "normal"` rows participate, in payment-date order.
 * 2. The marker anchors on the student's first Trial row.
 * 3. Conversion is the first "New Student" row strictly after the trial date
 *    (mirrors the trial-cohort rule); null when the trial never converted.
 */
export function deriveConversionMarker(rows: SlimTransaction[]): ConversionMarker | null {
  const normal = rows
    .filter((row) => row.kind === "normal")
    .sort((left, right) => left.date.localeCompare(right.date));
  const trial = normal.find((row) => row.enrollmentType === "Trial");
  if (!trial) return null;
  const conversion =
    normal.find((row) => row.enrollmentType === "New Student" && row.date > trial.date) ?? null;
  return {
    trialDate: trial.date,
    convertedDate: conversion?.date ?? null,
    daysToConvert: conversion ? daysBetweenIso(trial.date, conversion.date) : null,
  };
}

export interface TimelineSegment extends CoverageWindow {
  days: number;
}

/** Attach a duration (min 1 day, drives flex-grow widths) to each window. */
export function computeTimelineSegments(windows: CoverageWindow[]): TimelineSegment[] {
  return windows.map((window) => ({
    ...window,
    days: Math.max(daysBetweenIso(window.from, window.until), 1),
  }));
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border bg-muted/20 px-2.5 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold">{value}</div>
      {sub ? <div className="text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export interface StudentDetailBodyProps {
  student: StudentDirectoryEntry;
  /** Bangkok-local ISO date used for the open-coverage cut. */
  today: string;
  /** Fetched slim transactions (whole history); null while loading/errored. */
  journeyRows: SlimTransaction[] | null;
  journeyTotal: number;
  journeyLoading: boolean;
  journeyError: string;
}

/**
 * Dialog body content, exported separately so it can be rendered (and tested)
 * without the portal-backed Dialog wrapper.
 */
export function StudentDetailBody({
  student,
  today,
  journeyRows,
  journeyTotal,
  journeyLoading,
  journeyError,
}: StudentDetailBodyProps) {
  const windows = journeyRows ? buildCoverageWindows(journeyRows, today) : [];
  const segments = computeTimelineSegments(windows);
  const conversion = journeyRows ? deriveConversionMarker(journeyRows) : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label="Lifetime revenue" value={formatCurrency(student.totalRevenue)} />
        <Kpi
          label="Purchases"
          value={`${student.txnCount + student.addTxnCount}`}
          sub={`${student.txnCount} package · ${student.addTxnCount} additional`}
        />
        <Kpi label="First seen" value={student.firstSeen} />
        <Kpi label="Last payment" value={student.lastPaymentDate} />
      </div>

      <section className="rounded-md border px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_BADGE_VARIANTS[student.status]}>{student.status}</Badge>
          <span className="text-[11px] text-muted-foreground">recomputed (live)</span>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Latest valid until</dt>
            <dd className="font-medium">{student.latestValidUntil ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Renewal decision by</dt>
            <dd className="font-medium">{student.decisionDate ?? "—"}</dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] text-muted-foreground">{CHURN_RULE_TEXT}</p>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Renewal timeline
        </h3>
        {journeyLoading ? (
          <div className="mt-2 h-8 animate-pulse rounded bg-muted/50" />
        ) : journeyError ? (
          <p className="mt-2 text-xs text-destructive">{journeyError}</p>
        ) : segments.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No package coverage to chart — no transaction carries a valid-until date.
          </p>
        ) : (
          <>
            <div className="mt-2 flex h-7 w-full overflow-hidden rounded-md border">
              {segments.map((segment, index) => (
                <div
                  key={`${segment.from}-${segment.until}-${index}`}
                  className={cn(
                    "h-full min-w-[14px] border-r last:border-r-0",
                    SEGMENT_CLASSES[segment.status],
                  )}
                  style={{ flexGrow: segment.days }}
                  title={`${SEGMENT_LABELS[segment.status]}: ${segment.from} → ${segment.until} (${segment.days}d)`}
                />
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {(Object.keys(SEGMENT_LABELS) as CoverageWindow["status"][]).map((status) => (
                <span key={status} className="inline-flex items-center gap-1">
                  <span className={cn("size-2 rounded-full", SEGMENT_CLASSES[status])} />
                  {SEGMENT_LABELS[status]}
                </span>
              ))}
            </div>
            <ul className="mt-2 space-y-1">
              {segments.map((segment, index) => (
                <li
                  key={`${segment.from}-${segment.until}-row-${index}`}
                  className="flex flex-wrap items-center gap-2 text-xs"
                >
                  <span className={cn("size-2 shrink-0 rounded-full", SEGMENT_CLASSES[segment.status])} />
                  <span className="font-medium whitespace-nowrap">
                    {segment.from} → {segment.until}
                  </span>
                  <span className="text-muted-foreground">
                    {SEGMENT_LABELS[segment.status]} · {segment.days}d
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {!journeyLoading && !journeyError && journeyRows ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {conversion
              ? conversion.convertedDate
                ? `Trial ${conversion.trialDate} → converted ${conversion.convertedDate} (${conversion.daysToConvert} days)`
                : `Trial ${conversion.trialDate} — never converted`
              : "No trial recorded for this student."}
          </p>
        ) : null}
        {journeyRows && journeyTotal > journeyRows.length ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Timeline built from the most recent {journeyRows.length.toLocaleString("en-US")} of{" "}
            {journeyTotal.toLocaleString("en-US")} transactions.
          </p>
        ) : null}
      </section>

      {student.displayNameVariants.length > 1 ? (
        <section className="rounded-md border border-dashed px-3 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Matched by nickname
          </h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            These spellings collapse into one student entry — verify they are the same person.
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {student.displayNameVariants.map((variant) => (
              <Badge key={variant} variant="outline" className="text-[10px]">
                {variant}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}

      <section className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border px-3 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Programs</h3>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {student.programs.length > 0 ? (
              student.programs.map((program) => (
                <Badge key={program} variant="secondary" className="text-[10px]">
                  {program}
                </Badge>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>
        </div>
        <div className="rounded-md border px-3 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reps</h3>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {student.reps.length > 0 ? (
              student.reps.map((rep) => (
                <Badge key={rep} variant="outline" className="text-[10px]">
                  {rep}
                </Badge>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Purchase history
        </h3>
        <p className="mt-1 text-[11px] text-muted-foreground">
          All recorded transactions for this student, whole history (package + additional).
        </p>
        <TransactionsTable filter={{ student: student.key }} className="mt-2" />
      </section>
    </div>
  );
}

interface JourneyState {
  rows: SlimTransaction[] | null;
  total: number;
  loading: boolean;
  error: string;
}

export interface StudentDetailPanelProps {
  /** The selected directory entry; the panel is closed while null. */
  student: StudentDirectoryEntry | null;
  /** Bangkok-local ISO date (computed once by the Students tab). */
  today: string;
  onClose: () => void;
}

/**
 * Per-student journey panel. Owns its own whole-history transactions fetch
 * (AbortController + per-key cache) for the coverage timeline; the purchase
 * list itself renders through the shared <TransactionsTable>.
 */
export function StudentDetailPanel({ student, today, onClose }: StudentDetailPanelProps) {
  const [journey, setJourney] = useState<JourneyState>({ rows: null, total: 0, loading: false, error: "" });
  const cacheRef = useRef(new Map<string, { rows: SlimTransaction[]; total: number }>());
  const abortRef = useRef<AbortController | null>(null);
  const studentKey = student?.key ?? null;

  useEffect(() => {
    if (!studentKey) return;
    const cached = cacheRef.current.get(studentKey);
    if (cached) {
      setJourney({ rows: cached.rows, total: cached.total, loading: false, error: "" });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setJourney({ rows: null, total: 0, loading: true, error: "" });

    fetch(
      `/api/sales-dashboard/transactions?student=${encodeURIComponent(studentKey)}&limit=${JOURNEY_PAGE_SIZE}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          rows?: SlimTransaction[];
          total?: number;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(body.error || `Student journey request failed (${response.status})`);
        }
        const rows = body.rows ?? [];
        const total = body.total ?? rows.length;
        cacheRef.current.set(studentKey, { rows, total });
        setJourney({ rows, total, loading: false, error: "" });
      })
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return;
        setJourney({
          rows: null,
          total: 0,
          loading: false,
          error: fetchError instanceof Error ? fetchError.message : "Failed to load student journey",
        });
      });

    return () => controller.abort();
  }, [studentKey]);

  return (
    <Dialog
      open={student !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl xl:top-0 xl:right-0 xl:bottom-0 xl:left-auto xl:h-dvh xl:max-h-none xl:w-[600px] xl:max-w-[600px] xl:translate-x-0 xl:translate-y-0 xl:rounded-none xl:border-l"
      >
        {student ? (
          <>
            <DialogHeader className="border-b px-4 py-3 pr-12">
              <DialogTitle className="truncate">{student.displayName}</DialogTitle>
              <DialogDescription>
                Student journey — purchases, renewal coverage, and live churn status.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <StudentDetailBody
                student={student}
                today={today}
                journeyRows={journey.rows}
                journeyTotal={journey.total}
                journeyLoading={journey.loading}
                journeyError={journey.error}
              />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
