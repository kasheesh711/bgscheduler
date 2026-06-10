"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ChartConfiguration } from "chart.js";
import { ArrowDownRight, ArrowUpRight, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ChartCanvas, chartColors } from "@/components/sales-dashboard/chart-canvas";
import { TransactionsTable } from "@/components/sales-dashboard/transactions-table";
import { formatCurrency, formatPercent } from "@/lib/sales-dashboard/format";
import type { RepFunnel, RepMonthAgg, SalesTabProps } from "@/lib/sales-dashboard/types";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------------------
// Reps tab — per-rep drill-down over the month-grain dimensions payload.
// Left rail: full rep list for the selected range (revenue, txn, share bar,
// delta vs the previous equal window). Right: KPI row, enrollment-type
// conversion mix, pace vs an indicative share-based target, stacked monthly
// T/N/R trend, top programs/packages, and the rep's transactions.
// All range math is recomputed client-side from RepMonthAgg — the landing
// payload is never touched. Deep link: ?rep= (any display variant).
// ----------------------------------------------------------------------------

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_RANGE_MONTHS = 240;

/** Same trim/lowercase/collapse rule the dimensions builder and /transactions route apply. */
export function repKeyOf(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** "YYYY-MM-DD" → "YYYY-MM-01". */
export function monthStartOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Pure month arithmetic on "YYYY-MM-01" keys (no Date construction). */
export function addMonths(month: string, delta: number): string {
  const zeroBased = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  const year = Math.floor(zeroBased / 12);
  const monthIndex = ((zeroBased % 12) + 12) % 12;
  return `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-01`;
}

/** Inclusive calendar month starts covering [from, to]; empty when from > to. */
export function monthsInRange(from: string, to: string): string[] {
  const start = monthStartOf(from);
  const end = monthStartOf(to);
  if (!from || !to || start > end) return [];
  const months: string[] = [];
  for (let month = start; month <= end && months.length < MAX_RANGE_MONTHS; month = addMonths(month, 1)) {
    months.push(month);
  }
  return months;
}

/** "2026-04-01" → "Apr 26". */
export function monthShortLabel(month: string): string {
  return `${MONTH_SHORT[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7)} ${month.slice(2, 4)}`;
}

export interface RepRailEntry {
  key: string;
  rep: string;
  rev: number;
  count: number;
  /** Share of all-rep revenue inside the selected range. */
  share: number;
  /** Revenue delta vs the previous equal-length month window; null when that window had none. */
  deltaPct: number | null;
}

/**
 * Build the left-rail entries from the month-grain rep aggregates.
 *
 * 1. Range-filter months between monthStart(from) and monthStart(to).
 * 2. The comparison window is the equal number of calendar months immediately
 *    before the range (recomputed from the same month grain).
 * 3. Reps are keyed by repKeyOf so display variants collapse to one row.
 * 4. Full list, revenue-descending — never capped.
 */
export function buildRepRail(reps: RepMonthAgg[], from: string, to: string): RepRailEntry[] {
  const months = monthsInRange(from, to);
  if (months.length === 0) return [];
  const monthSet = new Set(months);
  const previousSet = new Set(
    monthsInRange(addMonths(months[0], -months.length), addMonths(months[0], -1)),
  );

  const byKey = new Map<string, { rep: string; rev: number; count: number; prevRev: number }>();
  for (const agg of reps) {
    const key = repKeyOf(agg.rep);
    if (!key) continue;
    const entry = byKey.get(key) ?? { rep: agg.rep, rev: 0, count: 0, prevRev: 0 };
    if (monthSet.has(agg.month)) {
      entry.rev += agg.rev;
      entry.count += agg.count;
    }
    if (previousSet.has(agg.month)) entry.prevRev += agg.rev;
    byKey.set(key, entry);
  }

  const active = [...byKey.entries()].filter(([, entry]) => entry.count > 0);
  const totalRev = active.reduce((sum, [, entry]) => sum + entry.rev, 0);
  return active
    .map(([key, entry]) => ({
      key,
      rep: entry.rep,
      rev: entry.rev,
      count: entry.count,
      share: totalRev > 0 ? entry.rev / totalRev : 0,
      deltaPct: entry.prevRev > 0 ? (entry.rev - entry.prevRev) / entry.prevRev : null,
    }))
    .sort((left, right) => right.rev - left.rev || left.rep.localeCompare(right.rep));
}

export interface RepRangeStats {
  rev: number;
  count: number;
  avgTicket: number | null;
  revT: number;
  revN: number;
  revR: number;
  cntT: number;
  cntN: number;
  cntR: number;
}

/** Range-scoped totals + enrollment-type (Trial / New Student / Renewal) mix for one rep. */
export function buildRepRangeStats(reps: RepMonthAgg[], repKey: string, from: string, to: string): RepRangeStats {
  const monthSet = new Set(monthsInRange(from, to));
  const stats: RepRangeStats = { rev: 0, count: 0, avgTicket: null, revT: 0, revN: 0, revR: 0, cntT: 0, cntN: 0, cntR: 0 };
  for (const agg of reps) {
    if (!monthSet.has(agg.month) || repKeyOf(agg.rep) !== repKey) continue;
    stats.rev += agg.rev;
    stats.count += agg.count;
    stats.revT += agg.revT;
    stats.revN += agg.revN;
    stats.revR += agg.revR;
    stats.cntT += agg.cntT;
    stats.cntN += agg.cntN;
    stats.cntR += agg.cntR;
  }
  stats.avgTicket = stats.count > 0 ? stats.rev / stats.count : null;
  return stats;
}

export interface RepMonthlySeries {
  months: string[];
  labels: string[];
  revT: number[];
  revN: number[];
  revR: number[];
}

/** Zero-filled monthly T/N/R revenue series for one rep across the range months. */
export function buildRepMonthlySeries(reps: RepMonthAgg[], repKey: string, from: string, to: string): RepMonthlySeries {
  const months = monthsInRange(from, to);
  const index = new Map(months.map((month, position) => [month, position]));
  const revT = months.map(() => 0);
  const revN = months.map(() => 0);
  const revR = months.map(() => 0);
  for (const agg of reps) {
    const position = index.get(agg.month);
    if (position === undefined || repKeyOf(agg.rep) !== repKey) continue;
    revT[position] += agg.revT;
    revN[position] += agg.revN;
    revR[position] += agg.revR;
  }
  return { months, labels: months.map(monthShortLabel), revT, revN, revR };
}

export interface PaceVsTarget {
  /** Indicative range target: monthly target x months in range x whole-history revenue share. */
  target: number;
  /** Whole-history revenue share used to apportion the team target. */
  share: number;
  /** Range revenue / target. */
  pacePct: number;
}

/**
 * Indicative share-based pace vs target. Returns null (badge hidden) when the
 * sheet target is absent (fallback-only), the range is empty, or the rep has
 * no revenue history to derive a share from.
 */
export function computePaceVsTarget(
  reps: RepMonthAgg[],
  repKey: string,
  from: string,
  to: string,
  targetMonthlyRevenue: number | null,
): PaceVsTarget | null {
  if (targetMonthlyRevenue === null || targetMonthlyRevenue <= 0) return null;
  const months = monthsInRange(from, to);
  if (months.length === 0) return null;
  let repHistoryRev = 0;
  let allHistoryRev = 0;
  for (const agg of reps) {
    allHistoryRev += agg.rev;
    if (repKeyOf(agg.rep) === repKey) repHistoryRev += agg.rev;
  }
  if (allHistoryRev <= 0 || repHistoryRev <= 0) return null;
  const share = repHistoryRev / allHistoryRev;
  const target = targetMonthlyRevenue * months.length * share;
  const monthSet = new Set(months);
  let rangeRev = 0;
  for (const agg of reps) {
    if (monthSet.has(agg.month) && repKeyOf(agg.rep) === repKey) rangeRev += agg.rev;
  }
  return { target, share, pacePct: target > 0 ? rangeRev / target : 0 };
}

// ----------------------------------------------------------------------------
// Panel
// ----------------------------------------------------------------------------

const MIX_SEGMENTS = [
  { label: "Trial", colorVar: "var(--chart-1)", rev: (stats: RepRangeStats) => stats.revT, count: (stats: RepRangeStats) => stats.cntT },
  { label: "New Student", colorVar: "var(--chart-4)", rev: (stats: RepRangeStats) => stats.revN, count: (stats: RepRangeStats) => stats.cntN },
  { label: "Renewal", colorVar: "var(--chart-2)", rev: (stats: RepRangeStats) => stats.revR, count: (stats: RepRangeStats) => stats.cntR },
] as const;

export function RepsTab({ dimensions, loading, from, to, seed }: SalesTabProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isActiveTab = (searchParams.get("tab") ?? "overview") === "reps";
  const urlRep = searchParams.get("rep");

  const [selectedKey, setSelectedKey] = useState<string | null>(() => {
    const initial = seed?.rep ?? urlRep;
    return initial ? repKeyOf(initial) : null;
  });
  const [trackedUrlRep, setTrackedUrlRep] = useState(urlRep);

  // Follow back/forward navigation: adopt ?rep= when it changes underneath us
  // (sanctioned derived-state adjustment, mirrors workspace-tabs).
  if (urlRep !== trackedUrlRep) {
    setTrackedUrlRep(urlRep);
    if (urlRep) setSelectedKey(repKeyOf(urlRep));
  }

  // Consume GM cross-link seeds: any display variant resolves via repKeyOf.
  useEffect(() => {
    if (!seed?.rep) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot seed handoff from the shell, consumed immediately
    setSelectedKey(repKeyOf(seed.rep));
  }, [seed]);

  const selectRep = useCallback((key: string, displayName: string) => {
    setSelectedKey(key);
    const params = new URLSearchParams(searchParams.toString());
    params.set("rep", displayName);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const repAggs = useMemo(() => dimensions?.reps ?? [], [dimensions]);
  const rail = useMemo(() => buildRepRail(repAggs, from, to), [repAggs, from, to]);
  const rangeMonthCount = useMemo(() => monthsInRange(from, to).length, [from, to]);

  const effectiveKey = selectedKey ?? rail[0]?.key ?? null;
  const selectedFunnel: RepFunnel | null = useMemo(() => {
    if (!effectiveKey || !dimensions) return null;
    return dimensions.repFunnels.find((funnel) => repKeyOf(funnel.rep) === effectiveKey) ?? null;
  }, [dimensions, effectiveKey]);

  const selectedDisplayName = useMemo(() => {
    if (!effectiveKey) return null;
    return (
      rail.find((entry) => entry.key === effectiveKey)?.rep
      ?? selectedFunnel?.rep
      ?? (seed?.rep && repKeyOf(seed.rep) === effectiveKey ? seed.rep.trim() : null)
      ?? (urlRep && repKeyOf(urlRep) === effectiveKey ? urlRep.trim() : null)
      ?? effectiveKey
    );
  }, [effectiveKey, rail, selectedFunnel, seed, urlRep]);

  const rangeStats = useMemo(
    () => (effectiveKey ? buildRepRangeStats(repAggs, effectiveKey, from, to) : null),
    [repAggs, effectiveKey, from, to],
  );
  const monthlySeries = useMemo(
    () => (effectiveKey ? buildRepMonthlySeries(repAggs, effectiveKey, from, to) : null),
    [repAggs, effectiveKey, from, to],
  );
  const pace = useMemo(
    () => (effectiveKey ? computePaceVsTarget(repAggs, effectiveKey, from, to, dimensions?.targetMonthlyRevenue ?? null) : null),
    [repAggs, effectiveKey, from, to, dimensions],
  );

  const trendConfig = useMemo<ChartConfiguration | null>(() => {
    if (!monthlySeries || monthlySeries.months.length === 0) return null;
    const colors = chartColors();
    return {
      type: "bar",
      data: {
        labels: monthlySeries.labels,
        datasets: [
          { label: "Trial", data: monthlySeries.revT, backgroundColor: colors.chart[0], stack: "rep", borderRadius: 3 },
          { label: "New Student", data: monthlySeries.revN, backgroundColor: colors.chart[3], stack: "rep", borderRadius: 3 },
          { label: "Renewal", data: monthlySeries.revR, backgroundColor: colors.chart[1], stack: "rep", borderRadius: 3 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: colors.mutedForeground } },
          y: {
            stacked: true,
            grid: { color: colors.border },
            ticks: {
              color: colors.mutedForeground,
              callback: (value) => formatCurrency(Number(value), true),
            },
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
  }, [monthlySeries]);

  if (loading) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Reps</h2>
        <p className="mt-1 text-xs text-muted-foreground">Loading sales dimensions…</p>
        <div className="mt-4 grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-14 animate-pulse rounded-md bg-muted/50" />
            ))}
          </div>
          <div className="space-y-3">
            <div className="h-20 animate-pulse rounded-md bg-muted/50" />
            <div className="h-48 animate-pulse rounded-md bg-muted/50" />
            <div className="h-32 animate-pulse rounded-md bg-muted/50" />
          </div>
        </div>
      </section>
    );
  }

  if (!dimensions) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Reps</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Sales dimensions are unavailable. Import a monthly source, then revisit this tab.
        </p>
      </section>
    );
  }

  const conversionRate = selectedFunnel && selectedFunnel.trialsHandled > 0
    ? selectedFunnel.trialsConverted / selectedFunnel.trialsHandled
    : null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Sales Reps</h2>
          <p className="text-xs text-muted-foreground">
            Range-scoped per-rep breakdown. Additional-revenue rows are excluded from rep groupings.
          </p>
        </div>
        {rangeMonthCount > 0 ? (
          <span className="text-xs text-muted-foreground">
            Deltas vs previous {rangeMonthCount} month{rangeMonthCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="self-start rounded-lg border bg-card p-2 shadow-sm">
          {rail.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No rep transactions in this range.
            </p>
          ) : (
            <div className="space-y-1">
              {rail.map((entry) => {
                const isSelected = entry.key === effectiveKey;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => selectRep(entry.key, entry.rep)}
                    aria-pressed={isSelected}
                    className={cn(
                      "w-full rounded-md border px-3 py-2 text-left transition-colors",
                      isSelected ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-muted/50",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{entry.rep}</span>
                      <DeltaBadge deltaPct={entry.deltaPct} />
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>{formatCurrency(entry.rev)}</span>
                      <span>{entry.count} txn · {formatPercent(entry.share)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, Math.round(entry.share * 100))}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        {effectiveKey && selectedDisplayName && rangeStats ? (
          <div className="min-w-0 space-y-4">
            <div className="rounded-lg border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold tracking-tight">{selectedDisplayName}</h3>
                  <p className="text-xs text-muted-foreground">{from} to {to}</p>
                </div>
                {pace ? (
                  <Badge variant="outline" className="h-auto whitespace-normal py-1">
                    <Target className="size-3" />
                    <span>
                      Pace {formatPercent(pace.pacePct)} of {formatCurrency(pace.target, true)} — indicative share-based target ({formatPercent(pace.share)} of team)
                    </span>
                  </Badge>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
                <StatBlock label="Revenue" value={formatCurrency(rangeStats.rev)} />
                <StatBlock label="Transactions" value={String(rangeStats.count)} />
                <StatBlock
                  label="Avg ticket"
                  value={rangeStats.avgTicket === null ? "—" : formatCurrency(rangeStats.avgTicket)}
                />
                <StatBlock
                  label="Trial conversion"
                  value={conversionRate === null ? "—" : formatPercent(conversionRate)}
                  detail={
                    selectedFunnel
                      ? `${selectedFunnel.trialsConverted}/${selectedFunnel.trialsHandled} converted${selectedFunnel.medianDaysToConvert === null ? "" : ` · median ${Math.round(selectedFunnel.medianDaysToConvert)}d`} (whole history)`
                      : undefined
                  }
                />
              </div>

              <div className="mt-4 border-t pt-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Conversion mix (enrollment types)
                </div>
                {rangeStats.rev > 0 ? (
                  <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-muted">
                    {MIX_SEGMENTS.map((segment) => {
                      const width = (segment.rev(rangeStats) / rangeStats.rev) * 100;
                      if (width <= 0) return null;
                      return (
                        <div
                          key={segment.label}
                          className="h-full"
                          style={{ width: `${width}%`, backgroundColor: segment.colorVar }}
                        />
                      );
                    })}
                  </div>
                ) : null}
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {MIX_SEGMENTS.map((segment) => (
                    <div key={segment.label} className="flex items-start gap-2">
                      <span
                        className="mt-1 size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: segment.colorVar }}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium">{segment.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {segment.count(rangeStats)} txn · {formatCurrency(segment.rev(rangeStats))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {trendConfig ? (
              <div className="flex min-h-[280px] flex-col rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">Monthly trend</h3>
                    <p className="text-xs text-muted-foreground">Trial, new-student, and renewal revenue by month</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2 text-xs">
                    <LegendDot colorVar="var(--chart-1)" label="Trial" />
                    <LegendDot colorVar="var(--chart-4)" label="New" />
                    <LegendDot colorVar="var(--chart-2)" label="Renewal" />
                  </div>
                </div>
                <ChartCanvas config={trendConfig} active={isActiveTab} className="mt-3" />
              </div>
            ) : null}

            {selectedFunnel && (selectedFunnel.topPrograms.length > 0 || selectedFunnel.topPackages.length > 0) ? (
              <div className="grid gap-4 md:grid-cols-2">
                <TopRevenueList
                  title="Top programs"
                  rows={selectedFunnel.topPrograms.map((row) => ({ name: row.name, rev: row.rev }))}
                />
                <TopRevenueList
                  title="Top packages"
                  rows={selectedFunnel.topPackages.map((row) => ({ name: row.band, rev: row.rev }))}
                />
              </div>
            ) : null}

            <div>
              <h3 className="mb-2 text-sm font-semibold">Transactions</h3>
              <TransactionsTable filter={{ rep: selectedDisplayName }} from={from} to={to} />
            </div>
          </div>
        ) : (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground shadow-sm">
            Select a rep to see their drill-down.
          </div>
        )}
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// Small presentational pieces
// ----------------------------------------------------------------------------

function DeltaBadge({ deltaPct }: { deltaPct: number | null }) {
  if (deltaPct === null) {
    return <span className="shrink-0 text-[10px] text-muted-foreground">no prior</span>;
  }
  const up = deltaPct >= 0;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium",
        up ? "text-available" : "text-conflict",
      )}
    >
      {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
      {Math.abs(Math.round(deltaPct * 100))}%
    </span>
  );
}

function StatBlock({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold tracking-tight">{value}</div>
      {detail ? <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function LegendDot({ colorVar, label }: { colorVar: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span className="size-2.5 rounded-full" style={{ backgroundColor: colorVar }} />
      {label}
    </span>
  );
}

function TopRevenueList({ title, rows }: { title: string; rows: { name: string; rev: number }[] }) {
  const maxRev = rows.reduce((max, row) => Math.max(max, row.rev), 0);
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Whole history</span>
      </div>
      <div className="mt-3 space-y-2">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No revenue recorded.</p>
        ) : (
          rows.map((row) => (
            <div key={row.name}>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-medium">{row.name || "Unspecified"}</span>
                <span className="shrink-0 text-muted-foreground">{formatCurrency(row.rev)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/70"
                  style={{ width: maxRev > 0 ? `${Math.max(2, Math.round((row.rev / maxRev) * 100))}%` : "0%" }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
