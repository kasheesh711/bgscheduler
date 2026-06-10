"use client";

import { useMemo, useState } from "react";
import type { ChartConfiguration } from "chart.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChartCanvas,
  chartColors,
  type ChartThemeColors,
} from "@/components/sales-dashboard/chart-canvas";
import { TransactionsTable } from "@/components/sales-dashboard/transactions-table";
import { formatCurrency, formatPercent } from "@/lib/sales-dashboard/format";
import { PACKAGE_BANDS } from "@/lib/sales-dashboard/package-hours";
import type {
  AdditionalMixMonthAgg,
  ExploreSeed,
  PackageMonthAgg,
  SalesTabProps,
} from "@/lib/sales-dashboard/types";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------------------
// Packages panel — package-size mix for the tabbed workspace. Hours-band
// histogram (count <-> revenue toggle), per-band summary table (avg package
// value, avg price/hour, hours sold), 100%-stacked monthly mix-shift chart,
// additional-revenue mix by salesType, and fail-soft visibility notes
// (unparsedPackageCount + "additional rows excluded"). All data arrives via
// the locked SalesTabProps contract; rows are fetched only through
// <TransactionsTable>.
// ----------------------------------------------------------------------------

const BAND_RANK = new Map<string, number>(PACKAGE_BANDS.map((band, index) => [band, index]));

/** Hydration-safe legend/table dot colors (resolved by CSS, not JS). */
const BAND_CSS_COLOR: Record<string, string> = {
  Trial: "var(--chart-1)",
  "1-10h": "var(--chart-2)",
  "20h": "var(--chart-3)",
  "30h": "var(--chart-4)",
  "40h+": "var(--chart-5)",
  Other: "var(--muted-foreground)",
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface PackageBandSummary {
  band: string;
  /** Most-sold package label inside the band (representative example). */
  packageLabel: string;
  txnCount: number;
  revenue: number;
  /** Share of total package revenue in the selected range (0..1). */
  revenueShare: number;
  /** revenue / txnCount; null when the band has no transactions. */
  avgPackageValue: number | null;
  /** revenue / hoursSold; null for bands without parsed hours (Trial/Other). */
  avgPricePerHour: number | null;
  /** Total parsed hours sold; null for bands without parsed hours. */
  hoursSold: number | null;
}

export interface PackageMixShift {
  months: string[];
  /** One series per band present in range; shares are % of month revenue. */
  series: { band: string; shares: number[] }[];
}

export interface AdditionalMixSummary {
  salesType: string;
  revenue: number;
  count: number;
  /** Share of total additional revenue in the selected range (0..1). */
  share: number;
}

function bandRank(band: string): number {
  return BAND_RANK.get(band) ?? PACKAGE_BANDS.length;
}

/**
 * Filter month-grain aggregate rows to the shell period range. A month is
 * included when it overlaps [from, to] (boundary months count even when the
 * range covers them only partially). Blank bounds are open-ended.
 */
export function filterToMonthRange<T extends { month: string }>(rows: T[], from: string, to: string): T[] {
  const fromMonth = from.trim() ? `${from.slice(0, 7)}-01` : null;
  const toMonth = to.trim() ? `${to.slice(0, 7)}-01` : null;
  return rows.filter(
    (row) => (fromMonth === null || row.month >= fromMonth) && (toMonth === null || row.month <= toMonth),
  );
}

/**
 * Collapse (band, month) cells into one summary per band, ordered by the
 * canonical PACKAGE_BANDS sequence (unknown bands defensively last).
 *
 * 1. Sum revenue/count/hours across months; pick the label from the cell with
 *    the most transactions as the representative package.
 * 2. avgPackageValue = revenue / txnCount.
 * 3. avgPricePerHour = revenue / hoursSold — exact for numeric bands (every
 *    row there has parsed hours); null for Trial/Other.
 */
export function summarizePackageBands(rows: PackageMonthAgg[]): PackageBandSummary[] {
  const cells = new Map<string, {
    band: string;
    label: string;
    labelCount: number;
    txnCount: number;
    revenue: number;
    hoursSold: number;
    hoursRows: number;
  }>();
  let totalRevenue = 0;

  for (const row of rows) {
    totalRevenue += row.rev;
    const cell = cells.get(row.packageBand) ?? {
      band: row.packageBand,
      label: row.packageLabel,
      labelCount: -1,
      txnCount: 0,
      revenue: 0,
      hoursSold: 0,
      hoursRows: 0,
    };
    cell.txnCount += row.count;
    cell.revenue += row.rev;
    if (row.count > cell.labelCount) {
      cell.label = row.packageLabel;
      cell.labelCount = row.count;
    }
    if (row.totalHoursSold !== null) {
      cell.hoursSold += row.totalHoursSold;
      cell.hoursRows += 1;
    }
    cells.set(row.packageBand, cell);
  }

  return [...cells.values()]
    .map((cell) => ({
      band: cell.band,
      packageLabel: cell.label,
      txnCount: cell.txnCount,
      revenue: cell.revenue,
      revenueShare: totalRevenue > 0 ? cell.revenue / totalRevenue : 0,
      avgPackageValue: cell.txnCount > 0 ? cell.revenue / cell.txnCount : null,
      avgPricePerHour: cell.hoursRows > 0 && cell.hoursSold > 0 ? cell.revenue / cell.hoursSold : null,
      hoursSold: cell.hoursRows > 0 ? cell.hoursSold : null,
    }))
    .sort((left, right) => bandRank(left.band) - bandRank(right.band) || left.band.localeCompare(right.band));
}

/**
 * Build the 100%-stacked mix-shift series: for every month in range, each
 * band's share of that month's package revenue (in %, summing to 100 for
 * months with revenue).
 */
export function buildPackageMixShift(rows: PackageMonthAgg[]): PackageMixShift {
  const months = [...new Set(rows.map((row) => row.month))].sort((left, right) => left.localeCompare(right));
  const monthIndex = new Map(months.map((month, index) => [month, index]));
  const monthRevenue = new Array<number>(months.length).fill(0);
  for (const row of rows) {
    monthRevenue[monthIndex.get(row.month)!] += row.rev;
  }

  const bands = [...new Set(rows.map((row) => row.packageBand))]
    .sort((left, right) => bandRank(left) - bandRank(right) || left.localeCompare(right));
  const series = bands.map((band) => ({ band, shares: new Array<number>(months.length).fill(0) }));
  const seriesByBand = new Map(series.map((entry) => [entry.band, entry]));

  for (const row of rows) {
    const index = monthIndex.get(row.month)!;
    const total = monthRevenue[index];
    if (total <= 0) continue;
    seriesByBand.get(row.packageBand)!.shares[index] += (row.rev / total) * 100;
  }

  return { months, series };
}

/**
 * Aggregate range-filtered additional-revenue cells by salesType, sorted by
 * revenue descending. Returns range totals alongside the per-type entries so
 * the panel can surface the "excluded from the bands above" count.
 */
export function summarizeAdditionalMix(rows: AdditionalMixMonthAgg[]): {
  entries: AdditionalMixSummary[];
  totalRevenue: number;
  totalCount: number;
} {
  const byType = new Map<string, { revenue: number; count: number }>();
  let totalRevenue = 0;
  let totalCount = 0;
  for (const row of rows) {
    totalRevenue += row.rev;
    totalCount += row.count;
    const entry = byType.get(row.salesType) ?? { revenue: 0, count: 0 };
    entry.revenue += row.rev;
    entry.count += row.count;
    byType.set(row.salesType, entry);
  }
  const entries = [...byType.entries()]
    .map(([salesType, entry]) => ({
      salesType,
      revenue: entry.revenue,
      count: entry.count,
      share: totalRevenue > 0 ? entry.revenue / totalRevenue : 0,
    }))
    .sort((left, right) => right.revenue - left.revenue || left.salesType.localeCompare(right.salesType));
  return { entries, totalRevenue, totalCount };
}

/** Resolve a GM cross-link seed to a known package band (else null). */
export function resolveSeedBand(seed: ExploreSeed | undefined): string | null {
  if (!seed?.band) return null;
  return (PACKAGE_BANDS as readonly string[]).includes(seed.band) ? seed.band : null;
}

/** "2026-03-01" → "Mar '26" (matches the GM command-center axis labels). */
export function formatMonthShort(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  const name = MONTH_NAMES[index];
  if (!name) return month.slice(0, 7);
  return `${name} '${month.slice(2, 4)}`;
}

function bandChartColor(band: string, colors: ChartThemeColors): string {
  const rank = BAND_RANK.get(band);
  if (band === "Other" || rank === undefined) return colors.mutedForeground;
  return colors.chart[rank % colors.chart.length];
}

// ----------------------------------------------------------------------------
// Panel
// ----------------------------------------------------------------------------

type HistogramMode = "count" | "revenue";

export function PackagesTab({ dimensions, loading, from, to, seed, active = true }: SalesTabProps) {
  const [histogramMode, setHistogramMode] = useState<HistogramMode>("count");

  // Consume GM cross-link seeds during render (sanctioned derived-state
  // adjustment — mirrors workspace-tabs.tsx).
  const seedBand = resolveSeedBand(seed);
  const [trackedSeedBand, setTrackedSeedBand] = useState<string | null>(seedBand);
  const [selectedBand, setSelectedBand] = useState<string | null>(seedBand);
  if (seedBand !== trackedSeedBand) {
    setTrackedSeedBand(seedBand);
    if (seedBand) setSelectedBand(seedBand);
  }

  const view = useMemo(() => {
    if (!dimensions) return null;
    const packageRows = filterToMonthRange(dimensions.packages, from, to);
    const bands = summarizePackageBands(packageRows);
    const totals = bands.reduce(
      (accumulator, band) => {
        accumulator.revenue += band.revenue;
        accumulator.txnCount += band.txnCount;
        if (band.hoursSold !== null) {
          accumulator.hoursSold = (accumulator.hoursSold ?? 0) + band.hoursSold;
        }
        return accumulator;
      },
      { revenue: 0, txnCount: 0, hoursSold: null as number | null },
    );
    return {
      bands,
      totals: {
        ...totals,
        avgPackageValue: totals.txnCount > 0 ? totals.revenue / totals.txnCount : null,
      },
      mixShift: buildPackageMixShift(packageRows),
      additional: summarizeAdditionalMix(filterToMonthRange(dimensions.additionalMix, from, to)),
    };
  }, [dimensions, from, to]);

  const histogramConfig = useMemo<ChartConfiguration | null>(() => {
    if (!view || view.bands.length === 0) return null;
    const colors = chartColors();
    return {
      type: "bar",
      data: {
        labels: view.bands.map((band) => band.band),
        datasets: [
          {
            label: histogramMode === "count" ? "Packages sold" : "Revenue",
            data: view.bands.map((band) => (histogramMode === "count" ? band.txnCount : band.revenue)),
            backgroundColor: view.bands.map((band) => bandChartColor(band.band, colors)),
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false } },
          y: {
            grid: { color: "rgba(0,0,0,0.05)" },
            ticks: {
              precision: 0,
              callback: (value) =>
                histogramMode === "count"
                  ? Number(value).toLocaleString("en-US")
                  : formatCurrency(Number(value), true),
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) =>
                histogramMode === "count"
                  ? ` ${Number(ctx.raw).toLocaleString("en-US")} package${Number(ctx.raw) === 1 ? "" : "s"}`
                  : ` ${formatCurrency(Number(ctx.raw))}`,
            },
          },
        },
      },
    };
  }, [view, histogramMode]);

  const mixShiftConfig = useMemo<ChartConfiguration | null>(() => {
    if (!view || view.mixShift.months.length === 0) return null;
    const colors = chartColors();
    return {
      type: "bar",
      data: {
        labels: view.mixShift.months.map(formatMonthShort),
        datasets: view.mixShift.series.map((series) => ({
          label: series.band,
          data: series.shares,
          backgroundColor: bandChartColor(series.band, colors),
          stack: "mix",
          borderRadius: 2,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: {
            stacked: true,
            min: 0,
            max: 100,
            grid: { color: "rgba(0,0,0,0.05)" },
            ticks: { callback: (value) => `${value}%` },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${Number(ctx.raw).toFixed(1)}%`,
            },
          },
        },
      },
    };
  }, [view]);

  if (!view) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Packages</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {loading
            ? "Loading sales dimensions…"
            : "Sales dimensions are unavailable. Re-open the tab or refresh the page to retry."}
        </p>
        {loading ? (
          <div className="mt-4 space-y-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-10 animate-pulse rounded-md bg-muted/50" />
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  const { bands, totals, additional } = view;
  const hasPackages = bands.length > 0;

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Package revenue" value={formatCurrency(totals.revenue)} />
        <StatCard label="Packages sold" value={totals.txnCount.toLocaleString("en-US")} />
        <StatCard
          label="Avg package value"
          value={totals.avgPackageValue !== null ? formatCurrency(totals.avgPackageValue) : "—"}
        />
        <StatCard
          label="Hours sold"
          value={totals.hoursSold !== null ? `${totals.hoursSold.toLocaleString("en-US")}h` : "—"}
        />
      </div>

      {!hasPackages ? (
        <section className="rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-sm text-muted-foreground">No package sales in the selected period.</p>
        </section>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            {/* Hours-distribution histogram */}
            <section className="flex min-h-[300px] flex-col rounded-lg border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">Hours distribution</h2>
                  <p className="text-xs text-muted-foreground">
                    Package sales by hours band in the selected period (month grain — boundary months
                    count whole; the transactions drill filters by exact dates)
                  </p>
                </div>
                <div className="flex items-center gap-0.5 rounded-md border p-0.5">
                  <Button
                    size="sm"
                    variant={histogramMode === "count" ? "secondary" : "ghost"}
                    className="h-6 px-2 text-xs"
                    aria-pressed={histogramMode === "count"}
                    onClick={() => setHistogramMode("count")}
                  >
                    Count
                  </Button>
                  <Button
                    size="sm"
                    variant={histogramMode === "revenue" ? "secondary" : "ghost"}
                    className="h-6 px-2 text-xs"
                    aria-pressed={histogramMode === "revenue"}
                    onClick={() => setHistogramMode("revenue")}
                  >
                    Revenue
                  </Button>
                </div>
              </div>
              {histogramConfig ? (
                <ChartCanvas
                  config={histogramConfig}
                  className="mt-4"
                  active={active}
                  ariaLabel={histogramMode === "count" ? "Packages sold by hours band" : "Package revenue by hours band"}
                />
              ) : null}
            </section>

            {/* 100%-stacked monthly mix shift */}
            <section className="flex min-h-[300px] flex-col rounded-lg border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">Mix shift over time</h2>
                  <p className="text-xs text-muted-foreground">Each band&apos;s share of monthly package revenue</p>
                </div>
                <div className="flex flex-wrap justify-end gap-2 text-xs">
                  {view.mixShift.series.map((series) => (
                    <BandLegendDot key={series.band} band={series.band} />
                  ))}
                </div>
              </div>
              {mixShiftConfig ? (
                <ChartCanvas
                  config={mixShiftConfig}
                  className="mt-4"
                  active={active}
                  ariaLabel="Each band's share of monthly package revenue"
                />
              ) : null}
            </section>
          </div>

          {/* Per-band summary table */}
          <section className="rounded-lg border bg-card shadow-sm">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Package bands</h2>
              <p className="text-xs text-muted-foreground">
                Click a band to filter the transactions below.
                {dimensions && dimensions.unparsedPackageCount > 0
                  ? ` ${dimensions.unparsedPackageCount.toLocaleString("en-US")} package value${dimensions.unparsedPackageCount === 1 ? "" : "s"} across all history could not be parsed into an hours band — grouped under "Other"; revenue is retained.`
                  : ""}
              </p>
            </div>
            <Table className="text-sm">
              <TableHeader>
                <TableRow className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  <TableHead className="pl-4">Band</TableHead>
                  <TableHead>Top package</TableHead>
                  <TableHead className="text-right">Txn</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                  <TableHead className="text-right">Avg package value</TableHead>
                  <TableHead className="text-right">Avg ฿/hour</TableHead>
                  <TableHead className="pr-4 text-right">Hours sold</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bands.map((band) => {
                  const selected = band.band === selectedBand;
                  return (
                    <TableRow
                      key={band.band}
                      className={cn("cursor-pointer hover:bg-muted/50", selected && "bg-muted/60 hover:bg-muted/60")}
                      onClick={() => setSelectedBand(selected ? null : band.band)}
                    >
                      <TableCell className="pl-4 font-medium whitespace-nowrap">
                        {/* Keyboard path for the row's filter action — the row
                            onClick is a pointer-only convenience target
                            (aria-selected is invalid on plain-table rows). */}
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedBand(selected ? null : band.band);
                          }}
                          className="inline-flex items-center gap-2 underline-offset-2 hover:underline focus-visible:underline"
                        >
                          <span
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: BAND_CSS_COLOR[band.band] ?? "var(--muted-foreground)" }}
                          />
                          {band.band}
                        </button>
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-muted-foreground">{band.packageLabel || "—"}</TableCell>
                      <TableCell className="text-right">{band.txnCount.toLocaleString("en-US")}</TableCell>
                      <TableCell className="text-right font-medium">{formatCurrency(band.revenue)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{formatPercent(band.revenueShare)}</TableCell>
                      <TableCell className="text-right">
                        {band.avgPackageValue !== null ? formatCurrency(band.avgPackageValue) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {band.avgPricePerHour !== null ? formatCurrency(band.avgPricePerHour) : "—"}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        {band.hoursSold !== null ? `${band.hoursSold.toLocaleString("en-US")}h` : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>
        </>
      )}

      {/* Additional-revenue mix by salesType */}
      {additional.totalCount > 0 ? (
        <section className="rounded-lg border bg-card shadow-sm">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Additional revenue by sales type</h2>
            <p className="text-xs text-muted-foreground">
              {additional.totalCount.toLocaleString("en-US")} additional-revenue row{additional.totalCount === 1 ? "" : "s"} in
              this range are excluded from the package bands and histogram above — shown separately here.
            </p>
          </div>
          <Table className="text-sm">
            <TableHeader>
              <TableRow className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <TableHead className="pl-4">Sales type</TableHead>
                <TableHead className="text-right">Txn</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="pr-4 text-right">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {additional.entries.map((entry) => (
                <TableRow key={entry.salesType}>
                  <TableCell className="pl-4 font-medium">{entry.salesType || "Unspecified"}</TableCell>
                  <TableCell className="text-right">{entry.count.toLocaleString("en-US")}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(entry.revenue)}</TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground">{formatPercent(entry.share)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}

      {/* Transactions */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Transactions</h2>
          {selectedBand ? (
            <>
              <Badge variant="secondary">{selectedBand}</Badge>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setSelectedBand(null)}>
                Clear filter
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">All transactions in the selected period</span>
          )}
        </div>
        {selectedBand ? (
          <p className="text-xs text-muted-foreground">
            Band filters match normal package sales only — additional-revenue rows are excluded.
          </p>
        ) : null}
        <TransactionsTable
          filter={selectedBand ? { band: selectedBand } : {}}
          from={from.trim() ? from : undefined}
          to={to.trim() ? to : undefined}
        />
      </section>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Small presentational helpers
// ----------------------------------------------------------------------------

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tracking-tight tabular-nums">{value}</div>
    </div>
  );
}

function BandLegendDot({ band }: { band: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: BAND_CSS_COLOR[band] ?? "var(--muted-foreground)" }}
      />
      {band}
    </span>
  );
}
