"use client";

import { useEffect, useMemo, useRef } from "react";
import Chart from "chart.js/auto";
import type { ChartConfiguration } from "chart.js";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  Gauge,
  TrendingUp,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  buildGmDashboardInsights,
  type GmDashboardInsights,
  type GmException,
  type MixInsightRow,
  type MonthlyRevenueInsight,
  type SalesTeamInsightRow,
} from "@/lib/sales-dashboard/gm-insights";
import type { SalesDashboardPayload } from "@/lib/sales-dashboard/types";
import { cn } from "@/lib/utils";

interface SalesDashboardCommandCenterProps {
  data: SalesDashboardPayload;
  from: string;
  to: string;
}

export function SalesDashboardCommandCenter({ data, from, to }: SalesDashboardCommandCenterProps) {
  const insights = useMemo(() => buildGmDashboardInsights(data, { from, to }), [data, from, to]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <RevenuePaceSurface insights={insights} />
        <ExceptionsRail exceptions={insights.exceptions} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(520px,0.95fr)]">
        <RevenueTrendPanel rows={insights.monthlyRevenue} />
        <SalesTeamTable rows={insights.salesTeam} />
      </div>

      <InsightsPanel insights={insights} />
    </div>
  );
}

function RevenuePaceSurface({ insights }: { insights: GmDashboardInsights }) {
  const { revenuePace: pace, pipeline } = insights;
  const projectedGood = pace.projectedNormalRevenue >= pace.target;
  const actualWidth = `${Math.min(100, pace.goalProgressPct)}%`;
  const projectedWidth = `${Math.min(100, pace.projectedProgressPct)}%`;

  return (
    <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="border-b bg-gradient-to-r from-primary/10 via-card to-amber-100/70 px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Gauge className="size-3.5 text-primary" />
              Revenue Pace
            </div>
            <div className="mt-2 flex flex-wrap items-end gap-x-3 gap-y-1">
              <span className="text-4xl font-semibold tracking-tight text-foreground">{formatCurrency(pace.normalRevenue)}</span>
              <span className="pb-1 text-sm text-muted-foreground">normal sales MTD</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-right sm:grid-cols-3 lg:min-w-[430px]">
            <MetricInline label="Target" value={formatCurrency(pace.target)} />
            <MetricInline label="Projected" value={formatCurrency(pace.projectedNormalRevenue)} tone={projectedGood ? "good" : "risk"} />
            <MetricInline label="Needed/day" value={formatCurrency(pace.dailyPaceNeeded)} />
          </div>
        </div>
      </div>

      <div className="px-4 py-4">
        <div className="relative h-12 rounded-lg border bg-muted/40">
          <div className="absolute inset-y-0 left-0 rounded-l-lg bg-primary/18" style={{ width: projectedWidth }} />
          <div className="absolute inset-y-0 left-0 rounded-l-lg bg-primary" style={{ width: actualWidth }} />
          <div className="absolute inset-y-0 right-0 w-px bg-foreground/40" />
          <div
            className={cn(
              "absolute top-1/2 h-7 w-px -translate-y-1/2",
              projectedGood ? "bg-available" : "bg-amber-500",
            )}
            style={{ left: projectedWidth }}
          />
          <div className="absolute inset-0 flex items-center justify-between px-3 text-xs font-medium">
            <span className="text-primary-foreground drop-shadow-sm">{pace.goalProgressPct}% actual</span>
            <span className="text-foreground/70">Goal line</span>
          </div>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <MetricInline label="Current gap" value={formatCurrency(pace.currentGap)} tone={pace.currentGap > 0 ? "risk" : "good"} />
          <MetricInline label="Pace gap" value={formatCurrency(pace.projectedGap)} tone={pace.projectedGap > 0 ? "risk" : "good"} />
          <MetricInline label="Additional sales" value={formatCurrency(pace.additionalRevenue)} detail={`${pace.additionalTransactions} txn`} />
          <MetricInline label="Total revenue" value={formatCurrency(pace.totalRevenue)} detail={`${pace.normalTransactions + pace.additionalTransactions} txn`} />
        </div>

        <div className="mt-4 grid gap-2 border-t pt-3 md:grid-cols-4">
          <PipelineStat label="Trial conversion" value={formatPercent(pipeline.conversionRate)} detail={`${pipeline.trialConverted}/${pipeline.trialCohortSize} converted`} />
          <PipelineStat label="Retention" value={formatPercent(pipeline.retentionRate)} detail={`${pipeline.retained}/${pipeline.retentionCohortSize} retained`} />
          <PipelineStat label="Replacement" value={pipeline.replacementRatio === null ? "-" : `${pipeline.replacementRatio.toFixed(2)}x`} detail={`${pipeline.churned} churned`} />
          <PipelineStat label="Pipeline mix" value={`${pipeline.newStudents} new`} detail={`${pipeline.trials} trials · ${pipeline.renewals} renewals`} />
        </div>
      </div>
    </section>
  );
}

function MetricInline({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "good" | "risk";
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 truncate text-lg font-semibold tracking-tight",
          tone === "good" && "text-available",
          tone === "risk" && "text-conflict",
        )}
      >
        {value}
      </div>
      {detail ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function PipelineStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold">{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function ExceptionsRail({ exceptions }: { exceptions: GmException[] }) {
  return (
    <aside className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">GM Exceptions</h2>
          <p className="text-xs text-muted-foreground">Items that need management attention</p>
        </div>
        <Badge variant={exceptions.length ? "destructive" : "secondary"}>
          {exceptions.length || "Clear"}
        </Badge>
      </div>

      <div className="mt-4 space-y-2">
        {exceptions.length === 0 ? (
          <div className="rounded-md border border-available/25 bg-available/8 px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-available">
              <CheckCircle2 className="size-4" />
              No active exceptions
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Pace, conversion, retention, and source freshness are inside configured thresholds.</p>
          </div>
        ) : (
          exceptions.map((item) => <ExceptionRow key={item.id} item={item} />)
        )}
      </div>
    </aside>
  );
}

function ExceptionRow({ item }: { item: GmException }) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        item.severity === "critical" && "border-destructive/30 bg-destructive/10",
        item.severity === "warning" && "border-amber-300/60 bg-amber-50",
        item.severity === "info" && "border-primary/20 bg-primary/8",
      )}
    >
      <div className="flex items-start gap-2">
        {item.severity === "critical" ? (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm font-medium">{item.title}</div>
            {item.value ? <div className="text-xs font-semibold">{item.value}</div> : null}
          </div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{item.detail}</p>
        </div>
      </div>
    </div>
  );
}

function RevenueTrendPanel({ rows }: { rows: MonthlyRevenueInsight[] }) {
  const config = useMemo<ChartConfiguration>(() => ({
    type: "bar",
    data: {
      labels: rows.map((row) => row.shortLabel),
      datasets: [
        { label: "New", data: rows.map((row) => row.newRevenue), backgroundColor: "#34D399", stack: "sales", borderRadius: 3 },
        { label: "Renewal", data: rows.map((row) => row.renewalRevenue), backgroundColor: "#FBBF24", stack: "sales", borderRadius: 3 },
        { label: "Trial", data: rows.map((row) => row.trialRevenue), backgroundColor: "#60A5FA", stack: "sales", borderRadius: 3 },
        { label: "Additional", data: rows.map((row) => row.additionalRevenue), backgroundColor: "#E8712B", stack: "sales", borderRadius: 3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: {
          stacked: true,
          grid: { color: "rgba(0,0,0,0.05)" },
          ticks: { callback: (value) => formatCurrency(Number(value), true) },
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
  }), [rows]);

  return (
    <section className="flex min-h-[360px] flex-col rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Revenue Trend</h2>
          <p className="text-xs text-muted-foreground">New, renewal, trial, and additional sales</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2 text-xs">
          <LegendDot color="#34D399" label="New" />
          <LegendDot color="#FBBF24" label="Renewal" />
          <LegendDot color="#60A5FA" label="Trial" />
          <LegendDot color="#E8712B" label="Additional" />
        </div>
      </div>
      <ChartCanvas config={config} className="mt-4" />
    </section>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function SalesTeamTable({ rows }: { rows: SalesTeamInsightRow[] }) {
  const maxRevenue = rows[0]?.revenue || 1;

  return (
    <section className="min-h-[360px] rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Sales Team</h2>
          <p className="text-xs text-muted-foreground">Revenue quality, mix, and movement vs previous equivalent period</p>
        </div>
        <Users className="size-4 text-muted-foreground" />
      </div>
      <div className="overflow-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-4 py-2 text-left">Rep</th>
              <th className="px-3 py-2 text-right">Revenue</th>
              <th className="px-3 py-2 text-left">Mix</th>
              <th className="px-3 py-2 text-right">AOV</th>
              <th className="px-3 py-2 text-right">Share</th>
              <th className="px-4 py-2 text-right">Vs prev.</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">No sales rep rows in this period.</td>
              </tr>
            ) : (
              rows.slice(0, 10).map((row) => (
                <tr key={row.name} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.name || "Unassigned"}</div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((row.revenue / maxRevenue) * 100)}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{row.count} transactions</div>
                  </td>
                  <td className="px-3 py-3 text-right font-semibold text-primary">{formatCurrency(row.revenue)}</td>
                  <td className="px-3 py-3">
                    <MixBars row={row} />
                  </td>
                  <td className="px-3 py-3 text-right">{formatCurrency(row.averageOrderValue)}</td>
                  <td className="px-3 py-3 text-right">{formatPercent(row.revenueShare)}</td>
                  <td className="px-4 py-3 text-right">
                    <Delta value={row.deltaRevenue} pct={row.deltaPct} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MixBars({ row }: { row: SalesTeamInsightRow }) {
  const total = Math.max(1, row.trialCount + row.newCount + row.renewalCount);
  return (
    <div className="min-w-[150px]">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        <div className="bg-emerald-400" style={{ width: `${(row.newCount / total) * 100}%` }} />
        <div className="bg-amber-400" style={{ width: `${(row.renewalCount / total) * 100}%` }} />
        <div className="bg-sky-400" style={{ width: `${(row.trialCount / total) * 100}%` }} />
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {row.newCount} N · {row.renewalCount} R · {row.trialCount} T
      </div>
    </div>
  );
}

function Delta({ value, pct }: { value: number; pct: number | null }) {
  const positive = value >= 0;
  return (
    <div className={cn("inline-flex items-center justify-end gap-1 font-medium", positive ? "text-available" : "text-conflict")}>
      {positive ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
      <span>{formatCurrency(Math.abs(value), true)}</span>
      {pct !== null ? <span className="text-xs opacity-80">({positive ? "+" : "-"}{formatPercent(Math.abs(pct))})</span> : null}
    </div>
  );
}

function InsightsPanel({ insights }: { insights: GmDashboardInsights }) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-3 border-b pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold">Insights</h2>
          <p className="text-xs text-muted-foreground">Compact drill-downs without adding more dashboard cards</p>
        </div>
        <TrendingUp className="hidden size-4 text-muted-foreground sm:block" />
      </div>
      <Tabs defaultValue="program" className="mt-3">
        <TabsList>
          <TabsTrigger value="program">Program mix</TabsTrigger>
          <TabsTrigger value="package">Package mix</TabsTrigger>
          <TabsTrigger value="payment">Payment concentration</TabsTrigger>
        </TabsList>
        <TabsContent value="program" className="pt-3">
          <InsightRows rows={insights.programMix} empty="No program rows in this period." />
        </TabsContent>
        <TabsContent value="package" className="pt-3">
          <InsightRows rows={insights.packageMix} empty="No package rows in this period." />
        </TabsContent>
        <TabsContent value="payment" className="pt-3">
          <InsightRows rows={insights.paymentConcentration} empty="No payment rows in this period." showRevenue />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function InsightRows({ rows, empty, showRevenue = false }: { rows: MixInsightRow[]; empty: string; showRevenue?: boolean }) {
  const max = rows[0]?.count || 1;
  if (rows.length === 0) {
    return <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">{empty}</div>;
  }
  return (
    <div className="grid gap-x-6 gap-y-2 lg:grid-cols-2">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_76px] items-center gap-3">
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-sm font-medium">{row.label || "Unspecified"}</span>
              <span className="text-xs text-muted-foreground">{formatPercent(row.share)}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((row.count / max) * 100)}%` }} />
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div className="font-medium text-foreground">{row.count} txn</div>
            {showRevenue ? <div>{formatCurrency(row.revenue, true)}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChartCanvas({ config, className }: { config: ChartConfiguration; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const chart = new Chart(canvasRef.current, config);
    return () => chart.destroy();
  }, [config]);

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <canvas ref={canvasRef} />
    </div>
  );
}

function formatCurrency(value: number, compact = false): string {
  const rounded = Math.round(value);
  if (compact && Math.abs(rounded) >= 1_000_000) {
    return `฿${(rounded / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  }
  if (compact && Math.abs(rounded) >= 1_000) {
    return `฿${Math.round(rounded / 1_000).toLocaleString("en-US")}k`;
  }
  if (Math.abs(rounded) >= 1_000_000) {
    return `฿${(rounded / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  }
  return `฿${rounded.toLocaleString("en-US")}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
