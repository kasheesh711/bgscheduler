"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import { isOpenHold } from "@/lib/feedback-autowriter/inbox";
import { GATE_THRESHOLDS, bangkokDateKey, gateWindow } from "@/lib/feedback-autowriter/quality";
import type { AutowriterReview, QualityTutorRow } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";
import { Panel, Tag, TONE_TEXT } from "./atoms";
import { count, dayMonth, percent } from "./format";
import type { ControlHandler } from "./system-line";

// ----------------------------------------------------------------------------
// The tutor table: one row per roster tutor, the dashboard's row joined to the
// review payload's by `tutorKey`. Every figure covers the gate's 14 days.
// Clicking a row sets the page's tutor filter.
// ----------------------------------------------------------------------------

type DashboardTutor = AutowriterDashboard["tutors"][number];

export interface TutorTableRow extends Pick<DashboardTutor, "tutorKey" | "displayName" | "wiseUserIds" | "enabled" | "partlyEnabled" | "posted"> {
  /** The tutor's review figures of the window; null while the review data is unavailable. */
  quality: QualityTutorRow | null;
  /** accurate ÷ reviewed; null when nothing was reviewed. */
  accuracy: number | null;
  /** Reviewed posts that needed a real fix (a major or critical verdict). */
  realFixes: number;
  /** Classes of the window that are held now, and those among all the tutor's holds still waiting for someone. */
  holds: number;
  openHolds: number;
}

const PHASE_LABEL: Record<QualityTutorRow["phase"], string> = {
  full_review: "Every post (new)",
  sampled: "30% sample + flagged",
};

const AVATAR_TONES = [
  "bg-sky-100/70 text-sky-700 dark:bg-sky-950 dark:text-sky-200",
  "bg-emerald-100/60 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-amber-100/60 text-amber-700 dark:bg-amber-950 dark:text-amber-200",
  "bg-violet-100/60 text-violet-700 dark:bg-violet-950 dark:text-violet-200",
  "bg-teal-100/60 text-teal-700 dark:bg-teal-950 dark:text-teal-200",
] as const;

/** The 14 Bangkok dates the table covers: the review window, or the same window counted from `now`. */
function windowOf(review: Pick<AutowriterReview, "window"> | null, now: Date): { start: string; end: string } {
  return review ? review.window : gateWindow(bangkokDateKey(now));
}

/**
 * One row per roster tutor, best accuracy first (tutors without a review last, by name). A hold counts in the window
 * by its class's Bangkok date; one without a class time is counted, since nobody can say it is older.
 */
export function buildTutorRows(
  dashboard: Pick<AutowriterDashboard, "tutors" | "holds">,
  review: Pick<AutowriterReview, "tutors" | "window"> | null,
  now: Date,
): TutorTableRow[] {
  const window = windowOf(review, now);
  const quality = new Map((review?.tutors ?? []).map((row) => [row.tutorKey, row]));
  return dashboard.tutors.map((tutor): TutorTableRow => {
    const row = quality.get(tutor.tutorKey) ?? null;
    const holds = dashboard.holds.filter((hold) => hold.tutorKey === tutor.tutorKey);
    return {
      tutorKey: tutor.tutorKey,
      displayName: tutor.displayName,
      wiseUserIds: tutor.wiseUserIds,
      enabled: tutor.enabled,
      partlyEnabled: tutor.partlyEnabled,
      posted: tutor.posted,
      quality: row,
      accuracy: row && row.reviewed > 0 ? row.accurate / row.reviewed : null,
      realFixes: row ? row.reviewed - row.accurate : 0,
      holds: holds.filter((hold) => !hold.classEndedAt || bangkokDateKey(new Date(hold.classEndedAt)) >= window.start).length,
      openHolds: holds.filter((hold) => isOpenHold(hold, now)).length,
    };
  }).toSorted((a, b) => (b.accuracy ?? -1) - (a.accuracy ?? -1) || a.displayName.localeCompare(b.displayName));
}

/** "Showing Anna ×": the page's tutor filter, with the button that clears it. */
export function TutorFilterChip({ name, onClear }: { name: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-[7px] rounded-[5px] border border-sky-200 bg-sky-50 py-1 pr-1 pl-[9px] text-[11px] text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
      Showing {name}
      <button type="button" aria-label="Clear the tutor filter" onClick={onClear}
        className="grid size-5 place-items-center rounded hover:bg-sky-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none dark:hover:bg-sky-900">
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}

const HEAD = "h-auto bg-muted/40 px-5 py-[11px] text-[10px] font-medium text-muted-foreground";
const CELL = "px-5 py-3.5 text-[11px]";
const SMALL = "ml-[5px] text-[10px] font-normal text-muted-foreground";

export function TutorTable({ dashboard, review, now, selectedTutorKey, onSelect, canControl, busy, onControl }: {
  dashboard: Pick<AutowriterDashboard, "tutors" | "holds" | "windowDays">;
  /** The review data, or null while it is unavailable. */
  review: AutowriterReview | null;
  now: Date;
  selectedTutorKey: string | null;
  /** Sets the page's tutor filter; null clears it. */
  onSelect: (tutorKey: string | null) => void;
  canControl: boolean;
  busy: boolean;
  onControl: ControlHandler;
}) {
  const rows = buildTutorRows(dashboard, review, now);
  const window = windowOf(review, now);
  const on = rows.filter((row) => row.enabled || row.partlyEnabled).length;
  return (
    <section id="autowriter-tutors" aria-labelledby="autowriter-tutors-title" className="scroll-mt-4">
      <div className="mt-7 mb-[13px] flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h2 id="autowriter-tutors-title" className="text-[15px] font-[650] tracking-[-0.02em]">Tutors</h2>
          <span className="text-[11px] text-muted-foreground">
            {rows.length} in the pilot · {on} switched on · last {review?.window.days ?? GATE_THRESHOLDS.windowDays} days
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground">Click a tutor to filter the to-do list and the charts.</span>
      </div>
      <Panel>
        <Table className="text-[11px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD, "w-1/4")}>Tutor</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>Accuracy <span aria-hidden className="text-muted-foreground/60">↓</span></TableHead>
              <TableHead className={cn(HEAD, "text-right")}>Lower bound</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>Coverage</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>Holds</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>Real fixes</TableHead>
              <TableHead className={HEAD}>Review</TableHead>
              <TableHead className={HEAD}>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => {
              const selected = row.tutorKey === selectedTutorKey;
              const quality = row.quality;
              const belowBar = row.accuracy !== null && row.accuracy < GATE_THRESHOLDS.passLowerBound;
              const belowFloor = quality?.coverage !== null && quality?.coverage !== undefined && quality.coverage < GATE_THRESHOLDS.minCoverage;
              return (
                <TableRow key={row.tutorKey} aria-selected={selected} data-tutor-row={row.tutorKey}
                  onClick={() => onSelect(selected ? null : row.tutorKey)}
                  className={cn("cursor-pointer", selected ? "bg-sky-50 hover:bg-sky-50 dark:bg-sky-950 dark:hover:bg-sky-950" : "hover:bg-muted/40")}>
                  <TableCell className={CELL}>
                    <button type="button" aria-pressed={selected} className="flex w-full items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      onClick={(event) => { event.stopPropagation(); onSelect(selected ? null : row.tutorKey); }}>
                      <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-[7px] text-[11px] font-semibold", AVATAR_TONES[index % AVATAR_TONES.length])}>
                        {row.displayName.charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-[550] text-foreground">{row.displayName}</span>
                        <span className="mt-[3px] block text-[10px] text-muted-foreground">
                          {quality
                            ? `${count(quality.textsInWise, "post")} in Wise · ${quality.requiredPending} to review`
                            : `${row.posted} posted in ${count(dashboard.windowDays, "day")}`}
                        </span>
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className={cn(CELL, "text-right tabular-nums")}>
                    {row.accuracy === null || !quality ? <span className="text-muted-foreground">—</span> : (
                      <>
                        <span className={cn("font-[550]", TONE_TEXT[belowBar ? "amber" : "green"])}>{percent(row.accuracy)}</span>
                        <span className={SMALL}>{quality.accurate} / {quality.reviewed}</span>
                      </>
                    )}
                  </TableCell>
                  <TableCell className={cn(CELL, "text-right tabular-nums")}>
                    {quality && quality.reviewed > 0 ? percent(quality.wilsonLower) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className={cn(CELL, "text-right tabular-nums")}>
                    {!quality || quality.coverage === null ? <span className="text-muted-foreground">—</span> : (
                      <>
                        <span className={belowFloor ? cn("font-[550]", TONE_TEXT.amber) : undefined}>{percent(quality.coverage)}</span>
                        <span className={SMALL}>{quality.coverageNum} / {quality.coverageDen}</span>
                      </>
                    )}
                  </TableCell>
                  <TableCell className={cn(CELL, "text-right tabular-nums")}>
                    {row.holds}<span className={SMALL}>{row.openHolds} open</span>
                  </TableCell>
                  <TableCell className={cn(CELL, "text-right tabular-nums")}>
                    {!quality ? <span className="text-muted-foreground">—</span> : (
                      <>
                        {row.realFixes}
                        {quality.critical > 0 ? <span className={cn(SMALL, "text-conflict")}>{quality.critical} critical</span> : null}
                      </>
                    )}
                  </TableCell>
                  <TableCell className={CELL}>{quality ? PHASE_LABEL[quality.phase] : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className={CELL}>
                    <div className="flex items-center gap-2">
                      <Tag tone={row.enabled ? "green" : row.partlyEnabled ? "amber" : "neutral"}>{row.enabled ? "On" : row.partlyEnabled ? "Partly on" : "Off"}</Tag>
                      {canControl ? (
                        <Button size="xs" variant="ghost" disabled={busy} className="h-6 px-1.5 text-[10px] text-muted-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            onControl({ action: "tutor", wiseUserIds: row.wiseUserIds, enabled: !row.enabled },
                              `${row.enabled ? "Turn off" : "Turn on"} the autowriter for ${row.displayName} (both Wise accounts)?`);
                          }}>
                          {row.enabled ? "Turn off" : "Turn on"}
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t bg-muted/20 px-5 py-[11px] text-[10px] text-muted-foreground">
          <span>
            {review
              ? "Accuracy, the lower bound and real fixes use owner-reviewed posts. Holds are the classes held in these days, not only the open ones."
              : "The review data is unavailable: accuracy, coverage and fixes cannot be shown."}
          </span>
          <span>{dayMonth(window.start)} – {dayMonth(window.end)}</span>
        </div>
      </Panel>
    </section>
  );
}
