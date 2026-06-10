"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartConfiguration } from "chart.js";
import { ArrowDownRight, ArrowUpRight, ChevronDown, ChevronUp, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChartCanvas, chartColors } from "@/components/sales-dashboard/chart-canvas";
import { TransactionsTable } from "@/components/sales-dashboard/transactions-table";
import { formatCurrency, formatPercent } from "@/lib/sales-dashboard/format";
import type { ExploreSeed, ProgramMonthAgg, SalesTabProps } from "@/lib/sales-dashboard/types";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------------------
// Programs panel — program/subject split for the tabbed workspace. Aggregates
// the month-grain ProgramMonthAgg dimension into a range view: sortable table
// (revenue, txn, students, avg ticket, share, MoM movement), share-of-revenue
// strip, stacked monthly mix chart (top-6 + Other), per-program T/N/R split,
// and a program-filtered transactions drill. Additional-revenue rows are
// excluded from program groupings (surfaced as a muted note).
// ----------------------------------------------------------------------------

const TOP_SERIES_LIMIT = 6;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface ProgramRangeRow {
  program: string;
  rev: number;
  txn: number;
  /** Sum of per-month distinct students — students active in several months count once per month. */
  studentMonths: number;
  avgTicket: number;
  share: number;
  /** Latest in-range month vs the previous calendar month; null when no comparison exists. */
  momDelta: number | null;
  momPct: number | null;
}

export interface ProgramRangeOptions {
  from: string;
  to: string;
  includeTrials: boolean;
  /** All months ("YYYY-MM-01") present in the live data — gates MoM comparability. */
  allMonths: string[];
}

export interface ProgramMonthlySeries {
  months: string[];
  series: { program: string; values: number[]; isOther: boolean }[];
}

export interface ProgramShareSegment {
  program: string;
  share: number;
  isOther: boolean;
}

export type ProgramSortKey = "program" | "rev" | "txn" | "studentMonths" | "avgTicket" | "share" | "mom";

/** First day of the month containing an ISO date ("YYYY-MM-DD" → "YYYY-MM-01"). */
export function toMonthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Previous calendar month of a "YYYY-MM-01" month key. */
export function previousMonthOf(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const previousYear = monthNumber === 1 ? year - 1 : year;
  const previousNumber = monthNumber === 1 ? 12 : monthNumber - 1;
  return `${previousYear}-${String(previousNumber).padStart(2, "0")}-01`;
}

/** Short axis label for a "YYYY-MM-01" month key, e.g. "Apr 26". */
export function formatMonthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const name = MONTH_NAMES[monthNumber - 1];
  return name ? `${name} ${String(year).slice(2)}` : month;
}

function rowRevenue(agg: ProgramMonthAgg, includeTrials: boolean): number {
  return includeTrials ? agg.rev : agg.rev - agg.revT;
}

/**
 * Aggregate month-grain program rows into range-scoped table rows.
 *
 * 1. Only months overlapping [from..to] are included (month grain — partial
 *    months are counted whole).
 * 2. MoM movement compares the latest in-range month against the previous
 *    calendar month (which may sit outside the range); when that month has no
 *    data at all, movement is null.
 * 3. With includeTrials=false, trial revenue is removed from revenue, share,
 *    avg ticket, and movement; txn and student counts keep all rows.
 */
export function buildProgramTableRows(programs: ProgramMonthAgg[], options: ProgramRangeOptions): ProgramRangeRow[] {
  const fromMonth = toMonthStart(options.from);
  const toMonth = toMonthStart(options.to);
  const inRange = programs.filter((agg) => agg.month >= fromMonth && agg.month <= toMonth);
  if (inRange.length === 0) return [];

  const grouped = new Map<string, { rev: number; txn: number; studentMonths: number }>();
  let latestMonth = "";
  for (const agg of inRange) {
    if (agg.month > latestMonth) latestMonth = agg.month;
    const entry = grouped.get(agg.program) ?? { rev: 0, txn: 0, studentMonths: 0 };
    entry.rev += rowRevenue(agg, options.includeTrials);
    entry.txn += agg.count;
    entry.studentMonths += agg.students;
    grouped.set(agg.program, entry);
  }

  const prevMonth = previousMonthOf(latestMonth);
  const prevMonthHasData = options.allMonths.includes(prevMonth);
  const totalRev = [...grouped.values()].reduce((sum, entry) => sum + entry.rev, 0);

  // MoM lookups read the FULL programs array so the previous month can sit
  // outside the selected range.
  const revByProgramMonth = new Map<string, number>();
  for (const agg of programs) {
    if (agg.month !== latestMonth && agg.month !== prevMonth) continue;
    const key = `${agg.program}|${agg.month}`;
    revByProgramMonth.set(key, (revByProgramMonth.get(key) ?? 0) + rowRevenue(agg, options.includeTrials));
  }

  return [...grouped.entries()]
    .map(([program, entry]) => {
      const current = revByProgramMonth.get(`${program}|${latestMonth}`) ?? 0;
      const previous = revByProgramMonth.get(`${program}|${prevMonth}`) ?? 0;
      const comparable = prevMonthHasData && (current !== 0 || previous !== 0);
      const momDelta = comparable ? current - previous : null;
      return {
        program,
        rev: entry.rev,
        txn: entry.txn,
        studentMonths: entry.studentMonths,
        avgTicket: entry.txn > 0 ? entry.rev / entry.txn : 0,
        share: totalRev > 0 ? entry.rev / totalRev : 0,
        momDelta,
        momPct: momDelta !== null && previous > 0 ? momDelta / previous : null,
      };
    })
    .sort((left, right) => right.rev - left.rev || left.program.localeCompare(right.program));
}

/**
 * Build the stacked monthly series for the range: top programs by range
 * revenue keep their own series; everything else folds into "Other" (only
 * present when there are more programs than the limit).
 */
export function buildProgramMonthlySeries(
  programs: ProgramMonthAgg[],
  options: { from: string; to: string; includeTrials: boolean; topLimit?: number },
): ProgramMonthlySeries {
  const topLimit = options.topLimit ?? TOP_SERIES_LIMIT;
  const fromMonth = toMonthStart(options.from);
  const toMonth = toMonthStart(options.to);
  const inRange = programs.filter((agg) => agg.month >= fromMonth && agg.month <= toMonth);
  const months = [...new Set(inRange.map((agg) => agg.month))].sort((left, right) => left.localeCompare(right));
  if (months.length === 0) return { months: [], series: [] };

  const totals = new Map<string, number>();
  for (const agg of inRange) {
    totals.set(agg.program, (totals.get(agg.program) ?? 0) + rowRevenue(agg, options.includeTrials));
  }
  const ranked = [...totals.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([program]) => program);
  const top = ranked.slice(0, topLimit);

  const monthIndex = new Map(months.map((month, index) => [month, index]));
  const series = top.map((program) => ({ program, values: months.map(() => 0), isOther: false }));
  const other = { program: "Other", values: months.map(() => 0), isOther: true };
  const seriesByProgram = new Map(series.map((entry) => [entry.program, entry]));
  for (const agg of inRange) {
    const target = seriesByProgram.get(agg.program) ?? other;
    const index = monthIndex.get(agg.month);
    if (index !== undefined) target.values[index] += rowRevenue(agg, options.includeTrials);
  }
  if (ranked.length > topLimit) series.push(other);
  return { months, series };
}

/** Share-of-revenue segments for the strip visual: top programs + "Other". */
export function buildShareSegments(rows: ProgramRangeRow[], topLimit = TOP_SERIES_LIMIT): ProgramShareSegment[] {
  const ranked = [...rows].sort((left, right) => right.rev - left.rev || left.program.localeCompare(right.program));
  const segments = ranked
    .slice(0, topLimit)
    .filter((row) => row.share > 0)
    .map((row) => ({ program: row.program, share: row.share, isOther: false }));
  const restShare = ranked.slice(topLimit).reduce((sum, row) => sum + row.share, 0);
  if (restShare > 0) segments.push({ program: "Other", share: restShare, isOther: true });
  return segments;
}

/** Stable comparator behind the sortable table headers. */
export function compareProgramRows(
  left: ProgramRangeRow,
  right: ProgramRangeRow,
  key: ProgramSortKey,
  direction: "asc" | "desc",
): number {
  const factor = direction === "asc" ? 1 : -1;
  if (key === "program") return factor * left.program.localeCompare(right.program);
  if (key === "mom") {
    const leftValue = left.momDelta ?? Number.NEGATIVE_INFINITY;
    const rightValue = right.momDelta ?? Number.NEGATIVE_INFINITY;
    return factor * (leftValue - rightValue) || left.program.localeCompare(right.program);
  }
  return factor * (left[key] - right[key]) || left.program.localeCompare(right.program);
}

export function ProgramsTab({ dimensions, loading, from, to, seed }: SalesTabProps) {
  const [includeTrials, setIncludeTrials] = useState(true);
  const [sortKey, setSortKey] = useState<ProgramSortKey>("rev");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [selectedProgram, setSelectedProgram] = useState<string | null>(null);
  const [consumedSeed, setConsumedSeed] = useState<ExploreSeed | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panelVisible, setPanelVisible] = useState(true);

  // One-shot GM cross-link seed consumption (render-time derived state, same
  // sanctioned pattern as workspace-tabs URL adoption).
  if (seed && seed !== consumedSeed) {
    setConsumedSeed(seed);
    if (seed.program) setSelectedProgram(seed.program);
  }

  // Track panel visibility so ChartCanvas can resize on tab re-activation —
  // the panel stays mounted (keepMounted) but hidden while another tab is up.
  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setPanelVisible(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(
    () => (dimensions
      ? buildProgramTableRows(dimensions.programs, { from, to, includeTrials, allMonths: dimensions.months })
      : []),
    [dimensions, from, to, includeTrials],
  );
  const sortedRows = useMemo(
    () => [...rows].sort((left, right) => compareProgramRows(left, right, sortKey, sortDirection)),
    [rows, sortKey, sortDirection],
  );
  const monthly = useMemo(
    () => (dimensions
      ? buildProgramMonthlySeries(dimensions.programs, { from, to, includeTrials })
      : { months: [], series: [] }),
    [dimensions, from, to, includeTrials],
  );
  const segments = useMemo(() => buildShareSegments(rows), [rows]);

  const chartConfig = useMemo<ChartConfiguration>(() => {
    const colors = chartColors();
    return {
      type: "bar",
      data: {
        labels: monthly.months.map(formatMonthLabel),
        datasets: monthly.series.map((entry, index) => ({
          label: entry.program,
          data: entry.values,
          backgroundColor: seriesColor(colors, index, entry.isOther),
          stack: "programs",
          borderRadius: 3,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: colors.mutedForeground } },
          y: {
            stacked: true,
            grid: { color: colors.border },
            ticks: { color: colors.mutedForeground, callback: (value) => formatCurrency(Number(value), true) },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${formatCurrency(Number(ctx.raw))}`,
            },
          },
        },
      },
    };
  }, [monthly]);

  // Per-program T/N/R revenue split over the range — always the full split
  // (trials included) so the toggle never hides what the mix actually is.
  const detail = useMemo(() => {
    if (!selectedProgram || !dimensions) return null;
    const fromMonth = toMonthStart(from);
    const toMonth = toMonthStart(to);
    let rev = 0;
    let revT = 0;
    let revN = 0;
    let revR = 0;
    let txn = 0;
    for (const agg of dimensions.programs) {
      if (agg.program !== selectedProgram) continue;
      if (agg.month < fromMonth || agg.month > toMonth) continue;
      rev += agg.rev;
      revT += agg.revT;
      revN += agg.revN;
      revR += agg.revR;
      txn += agg.count;
    }
    return { rev, revT, revN, revR, otherRev: Math.max(0, rev - revT - revN - revR), txn };
  }, [selectedProgram, dimensions, from, to]);

  if (loading && !dimensions) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Programs</h2>
        <p className="mt-1 text-xs text-muted-foreground">Loading sales dimensions…</p>
        <div className="mt-4 space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-10 animate-pulse rounded-md bg-muted/50" />
          ))}
        </div>
      </section>
    );
  }

  if (!dimensions) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Programs</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Sales dimensions are unavailable. Re-open this tab or refresh the page to retry.
        </p>
      </section>
    );
  }

  const totalRev = rows.reduce((sum, row) => sum + row.rev, 0);
  const totalTxn = rows.reduce((sum, row) => sum + row.txn, 0);
  const latestMonth = monthly.months.at(-1) ?? null;
  const prevMonth = latestMonth ? previousMonthOf(latestMonth) : null;
  const momComparable = prevMonth !== null && dimensions.months.includes(prevMonth);
  const colors = chartColors();
  const selectedRow = selectedProgram ? rows.find((row) => row.program === selectedProgram) ?? null : null;

  const handleSort = (key: ProgramSortKey) => {
    if (key === sortKey) {
      setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection(key === "program" ? "asc" : "desc");
    }
  };

  return (
    <div ref={rootRef} className="space-y-4">
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold">Programs</h2>
            <p className="text-xs text-muted-foreground">
              Revenue and student mix by program, {monthly.months.length} month{monthly.months.length === 1 ? "" : "s"} in range (month grain)
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={includeTrials ? "default" : "outline"}
              onClick={() => setIncludeTrials((value) => !value)}
            >
              {includeTrials ? "Trials included" : "Trials excluded"}
            </Button>
          </div>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Metric label="Program revenue" value={formatCurrency(totalRev)} />
          <Metric label="Programs" value={String(rows.length)} />
          <Metric label="Transactions" value={totalTxn.toLocaleString("en-US")} />
        </div>

        {segments.length > 0 ? (
          <div className="mt-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Share of revenue</div>
            <div className="mt-1.5 flex h-3 overflow-hidden rounded-full bg-muted">
              {segments.map((segment, index) => (
                <div
                  key={segment.program}
                  title={`${segment.program}: ${formatPercent(segment.share)}`}
                  style={{
                    width: `${segment.share * 100}%`,
                    backgroundColor: seriesColor(colors, index, segment.isOther),
                  }}
                />
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {segments.map((segment, index) => (
                <span key={segment.program} className="inline-flex items-center gap-1.5">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: seriesColor(colors, index, segment.isOther) }}
                  />
                  {segment.program} · {formatPercent(segment.share)}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <p className="mt-3 text-xs text-muted-foreground">
          Additional-revenue rows are excluded from program groupings.
          {!includeTrials ? " Trial revenue is excluded from revenue, share, and movement; transaction and student counts still include trials." : ""}
        </p>
      </section>

      {rows.length === 0 ? (
        <section className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground shadow-sm">
          No program revenue in the selected period.
        </section>
      ) : (
        <>
          <section className="flex min-h-[320px] flex-col rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Monthly revenue by program</h3>
                <p className="text-xs text-muted-foreground">Top {TOP_SERIES_LIMIT} programs by range revenue; the rest fold into Other</p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {monthly.series.map((entry, index) => (
                <span key={entry.program} className="inline-flex items-center gap-1.5">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: seriesColor(colors, index, entry.isOther) }}
                  />
                  {entry.program}
                </span>
              ))}
            </div>
            <ChartCanvas config={chartConfig} className="mt-3" active={panelVisible} />
          </section>

          <section className="rounded-lg border bg-card shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">Program breakdown</h3>
                <p className="text-xs text-muted-foreground">
                  {momComparable && latestMonth && prevMonth
                    ? `MoM compares ${formatMonthLabel(latestMonth)} vs ${formatMonthLabel(prevMonth)}`
                    : "No previous month in the data for MoM movement"}
                </p>
              </div>
            </div>
            <div className="overflow-auto">
              <Table className="min-w-[760px] text-sm">
                <TableHeader>
                  <TableRow className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    <SortableHead label="Program" column="program" activeKey={sortKey} direction={sortDirection} onSort={handleSort} className="pl-4" />
                    <SortableHead label="Revenue" column="rev" activeKey={sortKey} direction={sortDirection} onSort={handleSort} align="right" />
                    <SortableHead label="Txn" column="txn" activeKey={sortKey} direction={sortDirection} onSort={handleSort} align="right" />
                    <SortableHead label="Students" column="studentMonths" activeKey={sortKey} direction={sortDirection} onSort={handleSort} align="right" />
                    <SortableHead label="Avg ticket" column="avgTicket" activeKey={sortKey} direction={sortDirection} onSort={handleSort} align="right" />
                    <SortableHead label="Share" column="share" activeKey={sortKey} direction={sortDirection} onSort={handleSort} align="right" />
                    <SortableHead label="MoM" column="mom" activeKey={sortKey} direction={sortDirection} onSort={handleSort} align="right" className="pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRows.map((row) => (
                    <TableRow
                      key={row.program}
                      onClick={() => setSelectedProgram((current) => (current === row.program ? null : row.program))}
                      aria-selected={row.program === selectedProgram}
                      className={cn(
                        "cursor-pointer hover:bg-muted/50",
                        row.program === selectedProgram && "bg-primary/5",
                      )}
                    >
                      <TableCell className="pl-4">
                        <div className="max-w-[220px] truncate font-medium">{row.program || "Unspecified"}</div>
                        <div className="mt-1 h-1.5 max-w-[160px] overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${Math.round(row.share * 100)}%` }}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-semibold text-primary">{formatCurrency(row.rev)}</TableCell>
                      <TableCell className="text-right">{row.txn.toLocaleString("en-US")}</TableCell>
                      <TableCell className="text-right">{row.studentMonths.toLocaleString("en-US")}</TableCell>
                      <TableCell className="text-right">{formatCurrency(row.avgTicket)}</TableCell>
                      <TableCell className="text-right">{formatPercent(row.share)}</TableCell>
                      <TableCell className="pr-4 text-right">
                        <MovementDelta delta={row.momDelta} pct={row.momPct} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="border-t px-4 py-2 text-xs text-muted-foreground">
              Students are distinct per month and summed across the months in range.
            </div>
          </section>
        </>
      )}

      {selectedProgram && detail ? (
        <section data-testid="program-detail" className="rounded-lg border bg-card shadow-sm">
          <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold">{selectedProgram || "Unspecified"} — program detail</h3>
              <p className="text-xs text-muted-foreground">
                {detail.txn.toLocaleString("en-US")} transaction{detail.txn === 1 ? "" : "s"} · {formatCurrency(detail.rev)} in range (all enrollment types)
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSelectedProgram(null)} aria-label="Clear selected program">
              <X className="size-4" />
            </Button>
          </div>

          <div className="space-y-4 px-4 py-4">
            {selectedRow ? (
              <div className="grid gap-3 sm:grid-cols-4">
                <Metric label="Revenue" value={formatCurrency(selectedRow.rev)} />
                <Metric label="Share" value={formatPercent(selectedRow.share)} />
                <Metric label="Avg ticket" value={formatCurrency(selectedRow.avgTicket)} />
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">MoM</div>
                  <div className="mt-0.5 text-sm font-semibold">
                    <MovementDelta delta={selectedRow.momDelta} pct={selectedRow.momPct} />
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No revenue for this program in the selected period.</p>
            )}

            {detail.rev > 0 ? (
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Revenue split</div>
                <div className="mt-1.5 flex h-3 overflow-hidden rounded-full bg-muted">
                  {splitSegments(detail).map((segment) => (
                    <div
                      key={segment.label}
                      title={`${segment.label}: ${formatCurrency(segment.value)}`}
                      style={{ width: `${(segment.value / detail.rev) * 100}%`, backgroundColor: segment.color }}
                    />
                  ))}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {splitSegments(detail).map((segment) => (
                    <span key={segment.label} className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ backgroundColor: segment.color }} />
                      {segment.label} · {formatCurrency(segment.value)}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <TransactionsTable filter={{ program: selectedProgram }} from={from} to={to} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Presentational helpers
// ----------------------------------------------------------------------------

interface ProgramSplit {
  revT: number;
  revN: number;
  revR: number;
  otherRev: number;
}

function splitSegments(split: ProgramSplit): { label: string; value: number; color: string }[] {
  return [
    { label: "New", value: split.revN, color: "var(--chart-4)" },
    { label: "Renewal", value: split.revR, color: "var(--chart-2)" },
    { label: "Trial", value: split.revT, color: "var(--chart-1)" },
    { label: "Other", value: split.otherRev, color: "var(--muted-foreground)" },
  ].filter((segment) => segment.value > 0);
}

function seriesColor(colors: { chart: string[]; border: string; mutedForeground: string }, index: number, isOther: boolean): string {
  if (isOther) return colors.border;
  return index < colors.chart.length ? colors.chart[index] : colors.mutedForeground;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold">{value}</div>
    </div>
  );
}

function MovementDelta({ delta, pct }: { delta: number | null; pct: number | null }) {
  if (delta === null) return <span className="text-xs text-muted-foreground">—</span>;
  const positive = delta >= 0;
  return (
    <span className={cn("inline-flex items-center justify-end gap-1 font-medium", positive ? "text-available" : "text-conflict")}>
      {positive ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
      <span>{formatCurrency(Math.abs(delta), true)}</span>
      {pct !== null ? <span className="text-xs opacity-80">({positive ? "+" : "-"}{formatPercent(Math.abs(pct))})</span> : null}
    </span>
  );
}

function SortableHead({
  label,
  column,
  activeKey,
  direction,
  onSort,
  align,
  className,
}: {
  label: string;
  column: ProgramSortKey;
  activeKey: ProgramSortKey;
  direction: "asc" | "desc";
  onSort: (key: ProgramSortKey) => void;
  align?: "right";
  className?: string;
}) {
  const isActive = column === activeKey;
  return (
    <TableHead className={cn(align === "right" && "text-right", className)}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground",
          align === "right" && "justify-end",
          isActive && "text-foreground",
        )}
      >
        {label}
        {isActive
          ? direction === "asc"
            ? <ChevronUp className="size-3" />
            : <ChevronDown className="size-3" />
          : <ChevronsUpDown className="size-3 opacity-50" />}
      </button>
    </TableHead>
  );
}
