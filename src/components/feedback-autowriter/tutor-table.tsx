"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import { isOpenHold } from "@/lib/feedback-autowriter/inbox";
import { GATE_THRESHOLDS, bangkokDateKey, gateWindow } from "@/lib/feedback-autowriter/quality";
import type { AutowriterReview, QualityTutorRow } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";
import { CountChip, Panel, Tag, TONE_TEXT, Upper, type Tone } from "./atoms";
import { count, dayMonth, percent, threshold } from "./format";
import type { ControlHandler } from "./system-line";

// ----------------------------------------------------------------------------
// The tutor table: one row per roster tutor, the dashboard's row joined to the
// review payload's by `tutorKey`. Every figure covers the gate's 14 days.
// Clicking a row sets the page's tutor filter. Built to stay readable as the pilot grows: a search, four views, sortable
// columns, one line per tutor, and the tutors with nothing in the window folded into a row of chips under the table.
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

const AVATAR_TONES = [
  "bg-sky-100/70 text-sky-700 dark:bg-sky-950 dark:text-sky-200",
  "bg-emerald-100/60 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-amber-100/60 text-amber-700 dark:bg-amber-950 dark:text-amber-200",
  "bg-violet-100/60 text-violet-700 dark:bg-violet-950 dark:text-violet-200",
  "bg-teal-100/60 text-teal-700 dark:bg-teal-950 dark:text-teal-200",
] as const;

/** A tutor keeps their avatar colour whatever the table's order or view. */
function avatarTone(tutorKey: string): string {
  let sum = 0;
  for (const char of tutorKey) sum += char.codePointAt(0) ?? 0;
  return AVATAR_TONES[sum % AVATAR_TONES.length];
}

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

/** Below the pass bar or with a critical verdict: the accuracy is not in the green. */
function belowBar(row: TutorTableRow): boolean {
  return (row.accuracy !== null && row.accuracy < GATE_THRESHOLDS.passLowerBound) || (row.quality?.critical ?? 0) > 0;
}

function belowFloor(row: TutorTableRow): boolean {
  const coverage = row.quality?.coverage ?? null;
  return coverage !== null && coverage < GATE_THRESHOLDS.minCoverage;
}

/** Something about the tutor asks for a look: below a bar, a critical verdict, an open hold, a post to review, or partly on. */
export function needsAttention(row: TutorTableRow): boolean {
  return belowBar(row) || belowFloor(row) || row.openHolds > 0 || (row.quality?.requiredPending ?? 0) > 0 || row.partlyEnabled;
}

/**
 * Nothing in the window: no text in Wise (or nothing posted, without the review data), no hold, no eligible class
 * missed, and nothing that needs attention. A tutor whose classes all went unposted keeps a full row.
 */
export function hasNoActivity(row: TutorTableRow): boolean {
  const posts = row.quality ? row.quality.textsInWise : row.posted;
  return posts === 0 && row.holds === 0 && row.openHolds === 0 && (row.quality?.coverageDen ?? 0) === 0 && !needsAttention(row);
}

function isOff(row: TutorTableRow): boolean {
  return !row.enabled && !row.partlyEnabled;
}

export type TutorView = "all" | "attention" | "no_posts" | "off";

const VIEWS: Array<{ view: TutorView; label: string; test: (row: TutorTableRow) => boolean }> = [
  { view: "all", label: "All", test: () => true },
  { view: "attention", label: "Needs attention", test: needsAttention },
  { view: "no_posts", label: "No posts yet", test: hasNoActivity },
  { view: "off", label: "Off", test: isOff },
];

/** The tutors of a view whose name holds the search (any case). */
export function filterTutorRows(rows: readonly TutorTableRow[], { view, query }: { view: TutorView; query: string }): TutorTableRow[] {
  const needle = query.trim().toLowerCase();
  const test = VIEWS.find((entry) => entry.view === view)?.test ?? (() => true);
  return rows.filter((row) => test(row) && (needle === "" || row.displayName.toLowerCase().includes(needle)));
}

export type TutorSortKey = "name" | "accuracy" | "lowerBound" | "coverage" | "holds" | "realFixes";
export interface TutorSort { key: TutorSortKey; dir: "asc" | "desc" }

/** The table's first order: best accuracy first, as `buildTutorRows` returns them. */
export const DEFAULT_TUTOR_SORT: TutorSort = { key: "accuracy", dir: "desc" };

function sortValue(row: TutorTableRow, key: Exclude<TutorSortKey, "name">): number | null {
  const quality = row.quality;
  switch (key) {
    case "accuracy": return row.accuracy;
    case "lowerBound": return quality && quality.reviewed > 0 ? quality.wilsonLower : null;
    case "coverage": return quality?.coverage ?? null;
    case "holds": return row.holds;
    case "realFixes": return quality ? row.realFixes : null;
  }
}

/** Sorted by one column; a tutor without that figure always last, ties by name. */
export function sortTutorRows(rows: readonly TutorTableRow[], { key, dir }: TutorSort): TutorTableRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: TutorTableRow, b: TutorTableRow) => a.displayName.localeCompare(b.displayName);
  if (key === "name") return rows.toSorted((a, b) => sign * byName(a, b));
  return rows.toSorted((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === null || right === null) return left === right ? byName(a, b) : left === null ? 1 : -1;
    return sign * (left - right) || byName(a, b);
  });
}

/** Clicking a column sorts by it (names A–Z first, figures highest first); clicking it again turns the order round. */
function nextSort(current: TutorSort, key: TutorSortKey): TutorSort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "name" ? "asc" : "desc" };
}

function statusOf(row: Pick<TutorTableRow, "enabled" | "partlyEnabled">): { label: string; tone: Tone } {
  return row.enabled ? { label: "On", tone: "green" } : row.partlyEnabled ? { label: "Partly on", tone: "amber" } : { label: "Off", tone: "neutral" };
}

const HEAD = "h-auto bg-muted/40 px-5 py-[9px] text-[10px] font-medium text-muted-foreground";
const CELL = "px-5 py-2 text-[11px]";
const SMALL = "ml-[5px] text-[10px] font-normal text-muted-foreground";
const DASH = <span className="text-muted-foreground">—</span>;

/**
 * Accuracy and its Wilson lower bound on one 0–100% track: the band runs from the bound to the accuracy, the dot is
 * the accuracy, the two hairlines are the head-start and pass bars.
 */
export function IntervalBar({ accuracy, lower, amber }: { accuracy: number; lower: number; amber: boolean }) {
  const clamp = (value: number) => Math.max(0, Math.min(1, value)) * 100;
  const label = `Accuracy ${percent(accuracy)}, lower bound ${percent(lower)}; head start at ${threshold(GATE_THRESHOLDS.headStartLowerBound)}, pass at ${threshold(GATE_THRESHOLDS.passLowerBound)}`;
  return (
    <span role="img" aria-label={label} title={label} className="relative inline-block h-1.5 w-24 shrink-0 rounded-full bg-foreground/10 align-middle">
      <span className={cn("absolute inset-y-0 rounded-full", amber ? "bg-amber-500/35" : "bg-available/35")}
        style={{ left: `${clamp(lower)}%`, width: `${Math.max(0, clamp(accuracy) - clamp(lower))}%` }} />
      {[GATE_THRESHOLDS.headStartLowerBound, GATE_THRESHOLDS.passLowerBound].map((mark) => (
        <span key={mark} aria-hidden className="absolute -top-[3px] h-3 w-px bg-foreground/35" style={{ left: `${mark * 100}%` }} />
      ))}
      <span aria-hidden className={cn("absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card", amber ? "bg-amber-500" : "bg-available")}
        style={{ left: `${clamp(accuracy)}%` }} />
    </span>
  );
}

function SortHead({ label, sortKey, sort, onSort, right = true, className }: {
  label: string;
  sortKey: TutorSortKey;
  sort: TutorSort;
  onSort: (key: TutorSortKey) => void;
  right?: boolean;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <TableHead aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={cn(HEAD, right && "text-right", className)}>
      <button type="button" onClick={() => onSort(sortKey)}
        className={cn("inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50", active && "text-foreground")}>
        {label}
        <span aria-hidden className={active ? undefined : "invisible"}>{sort.dir === "asc" ? "↑" : "↓"}</span>
      </button>
    </TableHead>
  );
}

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
  const [query, setQuery] = useState("");
  const [view, setView] = useState<TutorView>("all");
  const [sort, setSort] = useState<TutorSort>(DEFAULT_TUTOR_SORT);
  const rows = buildTutorRows(dashboard, review, now);
  const window = windowOf(review, now);
  const days = review?.window.days ?? GATE_THRESHOLDS.windowDays;
  const on = rows.filter((row) => row.enabled || row.partlyEnabled).length;
  const shown = sortTutorRows(filterTutorRows(rows, { view, query }), sort);
  const active = shown.filter((row) => !hasNoActivity(row));
  const quiet = shown.filter(hasNoActivity);
  const searched = filterTutorRows(rows, { view: "all", query });
  const toggle = (row: TutorTableRow) => onControl({ action: "tutor", wiseUserIds: row.wiseUserIds, enabled: !row.enabled },
    `${row.enabled ? "Turn off" : "Turn on"} the autowriter for ${row.displayName} (both Wise accounts)?`);
  const select = (row: TutorTableRow) => onSelect(row.tutorKey === selectedTutorKey ? null : row.tutorKey);
  return (
    <section id="autowriter-tutors" aria-labelledby="autowriter-tutors-title" className="scroll-mt-4">
      <div className="mt-7 mb-[13px] flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h2 id="autowriter-tutors-title" className="text-[15px] font-[650] tracking-[-0.02em]">Tutors</h2>
          <span className="text-[11px] text-muted-foreground">
            {rows.length} in the pilot · {on} switched on · last {days} days
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a tutor" aria-label="Find a tutor"
            className="h-7 w-44 rounded-md bg-card px-2 text-[11px] md:text-[11px]" />
          <div className="flex rounded-md border bg-card p-0.5" role="group" aria-label="Which tutors to show">
            {VIEWS.map((entry) => (
              <button key={entry.view} type="button" aria-pressed={view === entry.view} onClick={() => setView(entry.view)}
                className={cn("rounded px-2 py-1 text-[11px] font-[550] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  view === entry.view ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
                {entry.label} <span className="font-normal tabular-nums opacity-70">{searched.filter(entry.test).length}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <Panel>
        {active.length > 0 ? (
          <Table className="text-[11px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortHead label="Tutor" sortKey="name" sort={sort} onSort={(key) => setSort(nextSort(sort, key))} right={false} className="w-[34%]" />
                <SortHead label="Accuracy" sortKey="accuracy" sort={sort} onSort={(key) => setSort(nextSort(sort, key))} right={false} />
                <SortHead label="Lower bound" sortKey="lowerBound" sort={sort} onSort={(key) => setSort(nextSort(sort, key))} />
                <SortHead label="Coverage" sortKey="coverage" sort={sort} onSort={(key) => setSort(nextSort(sort, key))} />
                <SortHead label="Holds" sortKey="holds" sort={sort} onSort={(key) => setSort(nextSort(sort, key))} />
                <SortHead label="Real fixes" sortKey="realFixes" sort={sort} onSort={(key) => setSort(nextSort(sort, key))} />
                <TableHead className={HEAD}>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {active.map((row) => {
                const selected = row.tutorKey === selectedTutorKey;
                const quality = row.quality;
                const status = statusOf(row);
                const amber = belowBar(row);
                return (
                  <TableRow key={row.tutorKey} data-state={selected ? "selected" : undefined} data-tutor-row={row.tutorKey} onClick={() => select(row)}
                    className={cn("cursor-pointer", selected ? "bg-sky-50 hover:bg-sky-50 dark:bg-sky-950 dark:hover:bg-sky-950" : "hover:bg-muted/40")}>
                    <TableCell className={CELL}>
                      <button type="button" aria-pressed={selected} className="flex w-full max-w-[420px] items-center gap-2.5 text-left whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        onClick={(event) => { event.stopPropagation(); select(row); }}>
                        <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-md text-[10px] font-semibold", avatarTone(row.tutorKey))}>
                          {row.displayName.charAt(0).toUpperCase()}
                        </span>
                        <span className="shrink-0 font-[550] text-foreground">{row.displayName}</span>
                        {quality?.phase === "sampled" ? <Tag tone="blue">Sampled</Tag> : null}
                        <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                          {quality
                            ? `${count(quality.textsInWise, "post")} in Wise · ${quality.requiredPending} to review`
                            : `${row.posted} posted in ${count(dashboard.windowDays, "day")}`}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell className={cn(CELL, "tabular-nums")}>
                      {row.accuracy === null || !quality ? DASH : (
                        <span className="flex items-center gap-2.5 whitespace-nowrap">
                          <span className="w-[86px]">
                            <span className={cn("font-[550]", TONE_TEXT[amber ? "amber" : "green"])}>{percent(row.accuracy)}</span>
                            <span className={SMALL}>{quality.accurate} / {quality.reviewed}</span>
                          </span>
                          <IntervalBar accuracy={row.accuracy} lower={quality.wilsonLower} amber={amber} />
                        </span>
                      )}
                    </TableCell>
                    <TableCell className={cn(CELL, "text-right tabular-nums")}>
                      {quality && quality.reviewed > 0 ? percent(quality.wilsonLower) : DASH}
                    </TableCell>
                    <TableCell className={cn(CELL, "text-right tabular-nums whitespace-nowrap")}>
                      {!quality || quality.coverage === null ? DASH : (
                        <>
                          <span className={belowFloor(row) ? cn("font-[550]", TONE_TEXT.amber) : undefined}>{percent(quality.coverage)}</span>
                          <span className={SMALL}>{quality.coverageNum} / {quality.coverageDen}</span>
                        </>
                      )}
                    </TableCell>
                    <TableCell className={cn(CELL, "text-right tabular-nums whitespace-nowrap")}>
                      <span className={row.holds === 0 ? "text-muted-foreground" : undefined}>{row.holds}</span>
                      <span className={cn(SMALL, row.openHolds > 0 && cn("font-[550]", TONE_TEXT.amber))}>{row.openHolds} open</span>
                    </TableCell>
                    <TableCell className={cn(CELL, "text-right tabular-nums whitespace-nowrap")}>
                      {!quality ? DASH : (
                        <>
                          <span className={row.realFixes === 0 ? "text-muted-foreground" : undefined}>{row.realFixes}</span>
                          {quality.critical > 0 ? <span className={cn(SMALL, "text-conflict")}>{quality.critical} critical</span> : null}
                        </>
                      )}
                    </TableCell>
                    <TableCell className={CELL}>
                      <div className="flex items-center gap-2">
                        <Tag tone={status.tone}>{status.label}</Tag>
                        {canControl ? (
                          <Button size="xs" variant="ghost" disabled={busy} className="h-6 px-1.5 text-[10px] text-muted-foreground"
                            aria-label={`${row.enabled ? "Turn off" : "Turn on"} ${row.displayName}`}
                            onClick={(event) => { event.stopPropagation(); toggle(row); }}>
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
        ) : null}
        {quiet.length > 0 ? (
          <div data-group="no-posts" className={cn("px-5 py-3", active.length > 0 && "border-t")}>
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              {/* Without the review data, "posted" covers the dashboard's own window. */}
              <Upper>No posts in these {review ? days : dashboard.windowDays} days</Upper>
              <CountChip>{quiet.length}</CountChip>
              <span className="text-[10px] text-muted-foreground">Nothing posted or held yet.</span>
            </div>
            <ul className="flex flex-wrap gap-1.5">
              {quiet.map((row) => {
                const selected = row.tutorKey === selectedTutorKey;
                const status = statusOf(row);
                return (
                  <li key={row.tutorKey} data-tutor-chip={row.tutorKey}
                    className={cn("flex items-center overflow-hidden rounded-md border text-[11px]",
                      selected ? "border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950" : "bg-card")}>
                    <button type="button" aria-pressed={selected} onClick={() => select(row)}
                      className="flex items-center gap-1.5 py-1 pr-2 pl-1 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
                      <span aria-hidden className={cn("grid size-5 shrink-0 place-items-center rounded text-[10px] font-semibold", avatarTone(row.tutorKey))}>
                        {row.displayName.charAt(0).toUpperCase()}
                      </span>
                      <span className="font-[550] whitespace-nowrap">{row.displayName}</span>
                      <span className={cn("text-[10px]", TONE_TEXT[status.tone])}>{status.label}</span>
                    </button>
                    {canControl ? (
                      <button type="button" disabled={busy} onClick={() => toggle(row)} aria-label={`${row.enabled ? "Turn off" : "Turn on"} ${row.displayName}`}
                        className="self-stretch border-l px-1.5 text-[10px] text-muted-foreground outline-none hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset disabled:opacity-50">
                        {row.enabled ? "Turn off" : "Turn on"}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {shown.length === 0 ? (
          <p className="px-5 py-6 text-center text-[11px] text-muted-foreground">
            {query.trim() ? `No tutor in this view matches “${query.trim()}”.` : "No tutor in this view."}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t bg-muted/20 px-5 py-[11px] text-[10px] text-muted-foreground">
          <span>
            {review
              ? "Accuracy, the lower bound and real fixes use owner-reviewed posts. Holds are the classes held in these days, not only the open ones."
              : "The review data is unavailable: accuracy, coverage and fixes cannot be shown."}
            {" "}Click a tutor to filter the to-do list and the charts.
          </span>
          <span>{dayMonth(window.start)} – {dayMonth(window.end)}</span>
        </div>
      </Panel>
    </section>
  );
}
