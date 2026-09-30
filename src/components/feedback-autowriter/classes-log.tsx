"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import type { AutowriterReview, ReviewQueueItem } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";
import { Disclosure, Tag } from "./atoms";
import { STATE_TONE, stateLabel } from "./class-states";
import { minutes, usd, when } from "./format";
import { targetForClass, type DrawerTarget } from "./item-drawer";
import { ARM_LABEL } from "./model-labels";
import { REVIEW_STATUS_LABEL, matchesFilter, verdictLabel, type ReviewFilter } from "./review-helpers";

// ----------------------------------------------------------------------------
// All classes: every class the page knows, newest first, with filters. A posted
// class opens its review, a held one its hold; reviewed posts and their verdict
// history are reached from here.
// ----------------------------------------------------------------------------

export interface ClassLogRow {
  wiseSessionId: string;
  tutor: string;
  tutorKey: string;
  className: string | null;
  classEndedAt: string | null;
  state: string;
  /** What to say under the state: a transcript-first fallback, or that a person wrote a held class. */
  note: string | null;
  arm: string | null;
  /** Null for a held class older than the rows the dashboard loads in full. */
  evidence: string | null;
  latencyMinutes: number | null;
  /** Null when the row comes from the review data alone (it carries no cost). */
  costUsd: number | null;
  /** The class's review, when the review data has one. */
  review: ReviewQueueItem | null;
  /** The drawer the row opens. */
  target: DrawerTarget | null;
}

const WRITTEN = "Written by a person since";

function minutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const value = (new Date(to).getTime() - new Date(from).getTime()) / 60_000;
  return Number.isNaN(value) ? null : Math.round(value * 10) / 10;
}

/**
 * Every class the page knows, latest class first (classes without a time last):
 * 1. the dashboard's recent classes;
 * 2. every held class not among them (a hold stays in the log however old it is);
 * 3. every posted class of the review data not among them (so an older reviewed post is still reachable).
 */
export function buildClassesLog(
  dashboard: Pick<AutowriterDashboard, "recent" | "holds" | "failedPosts">,
  review: Pick<AutowriterReview, "queue"> | null,
): ClassLogRow[] {
  const queue = new Map((review?.queue ?? []).map((item) => [item.wiseSessionId, item]));
  const holds = new Map(dashboard.holds.map((hold) => [hold.wiseSessionId, hold]));
  const rows = new Map<string, ClassLogRow>();
  const target = (wiseSessionId: string) => targetForClass(wiseSessionId, dashboard, review);

  for (const row of dashboard.recent) {
    rows.set(row.wiseSessionId, {
      wiseSessionId: row.wiseSessionId,
      tutor: row.tutor.replace(/ Online$/u, ""),
      tutorKey: row.tutorKey,
      className: row.className,
      classEndedAt: row.scheduledEndAt,
      state: row.state,
      note: holds.get(row.wiseSessionId)?.resolvedBy === "tutor_wrote" ? WRITTEN : row.summaryFallback?.label ?? null,
      arm: row.arm,
      evidence: row.evidence,
      latencyMinutes: row.latencyMinutes,
      costUsd: row.costUsd,
      review: queue.get(row.wiseSessionId) ?? null,
      target: target(row.wiseSessionId),
    });
  }
  for (const hold of dashboard.holds) {
    if (rows.has(hold.wiseSessionId)) continue;
    rows.set(hold.wiseSessionId, {
      wiseSessionId: hold.wiseSessionId, tutor: hold.tutor.replace(/ Online$/u, ""), tutorKey: hold.tutorKey, className: hold.className,
      classEndedAt: hold.classEndedAt, state: "held", note: hold.resolvedBy === "tutor_wrote" ? WRITTEN : null, arm: null, evidence: null,
      latencyMinutes: null, costUsd: null, review: null, target: target(hold.wiseSessionId),
    });
  }
  for (const item of queue.values()) {
    if (rows.has(item.wiseSessionId)) continue;
    rows.set(item.wiseSessionId, {
      wiseSessionId: item.wiseSessionId, tutor: item.tutor.replace(/ Online$/u, ""), tutorKey: item.tutorKey, className: item.className,
      classEndedAt: item.classEndedAt, state: item.firstShot.outcome, note: null, arm: item.firstShot.arm, evidence: item.firstShot.evidence,
      latencyMinutes: minutesBetween(item.classEndedAt, item.firstShot.postStartedAt), costUsd: null, review: item, target: target(item.wiseSessionId),
    });
  }
  const time = (value: string | null) => value ? new Date(value).getTime() : Number.NEGATIVE_INFINITY;
  return [...rows.values()].toSorted((a, b) => time(b.classEndedAt) - time(a.classEndedAt) || a.wiseSessionId.localeCompare(b.wiseSessionId));
}

export interface ClassLogFilter {
  /** `all` keeps every class; the others keep the posted classes whose review matches. */
  review: ReviewFilter;
  /** A state of the ledger, or null for any. */
  state: string | null;
  tutorKey: string | null;
  evidence: "summary" | "transcript" | null;
}

export function filterClassesLog(rows: readonly ClassLogRow[], filter: ClassLogFilter): ClassLogRow[] {
  return rows.filter((row) =>
    (filter.review === "all" || (row.review !== null && matchesFilter(row.review, filter.review)))
    && (filter.state === null || row.state === filter.state)
    && (filter.tutorKey === null || row.tutorKey === filter.tutorKey)
    && (filter.evidence === null || row.evidence === filter.evidence));
}

/**
 * The states the State filter offers: those the log's rows have, by their label — and the chosen one even when no row
 * has it any more (a reload may have moved its last class on), so the filter in force is never an invisible one.
 */
export function stateOptions(rows: readonly ClassLogRow[], selected: string | null): string[] {
  return [...new Set([...rows.map((row) => row.state), ...(selected ? [selected] : [])])]
    .toSorted((a, b) => stateLabel(a).localeCompare(stateLabel(b)));
}

const HEAD = "h-auto bg-muted/40 px-3 py-2.5 text-[10px] font-medium text-muted-foreground first:pl-5 last:pr-5";
const CELL = "px-3 py-2.5 align-top text-[11px] first:pl-5 last:pr-5";
const SELECT = "h-7 rounded-md border bg-background px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

export function ClassesLog({ dashboard, review, tutorKey, onTutorChange, onOpen }: {
  dashboard: Pick<AutowriterDashboard, "recent" | "holds" | "failedPosts" | "tutors" | "windowDays" | "totals">;
  /** The review data, or null while it is unavailable. */
  review: AutowriterReview | null;
  /** The page's tutor filter: the log follows it, and its own tutor choice sets it. */
  tutorKey: string | null;
  onTutorChange: (tutorKey: string | null) => void;
  onOpen: (target: DrawerTarget) => void;
}) {
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [state, setState] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<"summary" | "transcript" | null>(null);
  const rows = useMemo(() => buildClassesLog(dashboard, review), [dashboard, review]);
  const shown = filterClassesLog(rows, { review: reviewFilter, state, tutorKey, evidence });
  const states = stateOptions(rows, state);
  // The dashboard loads the text of the latest classes only: an older class of the window is in the log when it is
  // held or has a review row, and not otherwise.
  const latest = dashboard.recent.length;
  const capped = latest < dashboard.totals.seen;
  // Exact counts from the database: the review data itself may hold a subset (every flagged and unreviewed class is in it).
  const reviewOptions: Array<{ key: ReviewFilter; label: string }> = [
    { key: "all", label: "All classes" },
    { key: "required", label: `Needs review (${review?.queueTotals.needsReview ?? 0})` },
    { key: "flagged", label: `Flagged (${review?.queueTotals.flagged ?? 0})` },
  ];
  return (
    <Disclosure title="All classes" count={rows.length}
      hint={`${capped ? `the latest ${latest} of ${dashboard.totals.seen} classes of the last ${dashboard.windowDays} days` : `the last ${dashboard.windowDays} days`}, every held class, and the posts of the review data`}>
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
        {review ? (
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Review filter">
            {reviewOptions.map((option) => (
              <button key={option.key} type="button" aria-pressed={reviewFilter === option.key} onClick={() => setReviewFilter(option.key)}
                className={cn("rounded px-2 py-1 text-[11px] font-[550] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  reviewFilter === option.key ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        <select aria-label="State" className={SELECT} value={state ?? ""} onChange={(event) => setState(event.target.value || null)}>
          <option value="">Any state</option>
          {states.map((value) => <option key={value} value={value}>{stateLabel(value)}</option>)}
        </select>
        <select aria-label="Tutor" className={SELECT} value={tutorKey ?? ""} onChange={(event) => onTutorChange(event.target.value || null)}>
          <option value="">All tutors</option>
          {dashboard.tutors.map((tutor) => <option key={tutor.tutorKey} value={tutor.tutorKey}>{tutor.displayName}</option>)}
        </select>
        <select aria-label="Evidence" className={SELECT} value={evidence ?? ""}
          onChange={(event) => setEvidence(event.target.value === "summary" || event.target.value === "transcript" ? event.target.value : null)}>
          <option value="">Any evidence</option>
          <option value="transcript">Transcript</option>
          <option value="summary">Summary</option>
        </select>
        <span className="ml-auto text-[10px] text-muted-foreground">{shown.length} of {rows.length} shown</span>
      </div>
      {capped ? (
        <p className="border-b px-5 py-2 text-[10px] text-muted-foreground">
          Showing the latest {latest} of the {dashboard.totals.seen} classes of the last {dashboard.windowDays} days. An older one is listed only when
          it is held or has a review row, so the filters count the classes shown, not the whole window.
        </p>
      ) : null}
      {review && review.queueTotals.shown < review.queueTotals.all ? (
        <p className="border-b px-5 py-2 text-[10px] text-muted-foreground">
          Showing {review.queueTotals.shown} of {review.queueTotals.all} posts with a review row: every flagged and unreviewed class, then the latest reviewed ones.
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="px-5 py-8 text-center text-xs text-muted-foreground">
          {rows.length === 0 ? "No classes handled in this window yet." : "No class matches these filters."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={HEAD}>Class ended (Bangkok)</TableHead>
              <TableHead className={HEAD}>Tutor</TableHead>
              <TableHead className={HEAD}>Class</TableHead>
              <TableHead className={HEAD}>Status</TableHead>
              <TableHead className={HEAD}>Review</TableHead>
              <TableHead className={HEAD}>Written by</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>To post</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>Cost</TableHead>
              <TableHead className={HEAD}><span className="sr-only">Open</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((row) => {
              const target = row.target;
              return (
                <TableRow key={row.wiseSessionId} data-class-row={row.wiseSessionId} className="hover:bg-muted/40">
                  <TableCell className={CELL}>{when(row.classEndedAt)}</TableCell>
                  <TableCell className={CELL}>{row.tutor}</TableCell>
                  <TableCell className={cn(CELL, "max-w-48 truncate")} title={row.className ?? undefined}>{row.className ?? "—"}</TableCell>
                  <TableCell className={CELL}>
                    <Tag tone={STATE_TONE[row.state] ?? "neutral"}>{stateLabel(row.state)}</Tag>
                    {row.note ? <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">{row.note}</div> : null}
                  </TableCell>
                  <TableCell className={cn(CELL, "whitespace-normal")}>
                    {row.review ? (
                      <>
                        <span className={row.review.status === "reviewed" ? undefined : "font-[550]"}>{REVIEW_STATUS_LABEL[row.review.status]}</span>
                        {row.review.currentVerdict ? <span className="text-muted-foreground"> · {verdictLabel(row.review.currentVerdict)}</span> : null}
                      </>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className={CELL}>
                    {(row.arm && (ARM_LABEL[row.arm] ?? row.arm)) ?? "—"}
                    {row.evidence === "transcript" ? <span className="ml-1 text-[10px] uppercase text-muted-foreground">· transcript</span> : null}
                  </TableCell>
                  <TableCell className={cn(CELL, "text-right tabular-nums")}>{minutes(row.latencyMinutes)}</TableCell>
                  <TableCell className={cn(CELL, "text-right tabular-nums")}>{usd(row.costUsd)}</TableCell>
                  <TableCell className={cn(CELL, "text-right")}>
                    {target ? (
                      <Button size="xs" variant="outline" className="h-6 rounded-md px-2 text-[10px] font-[550]" onClick={() => onOpen(target)}>
                        {target.kind === "review" ? "Review" : "Open"}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Disclosure>
  );
}
