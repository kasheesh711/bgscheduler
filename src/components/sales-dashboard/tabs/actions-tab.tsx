"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ChartConfiguration } from "chart.js";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Database,
  Loader2,
  ShieldAlert,
  Target,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ChartCanvas, chartColors } from "@/components/sales-dashboard/chart-canvas";
import { CsvExportButton } from "@/components/sales-dashboard/csv-export-button";
import type { CsvColumn } from "@/lib/sales-dashboard/csv";
import { formatCurrency } from "@/lib/sales-dashboard/format";
import type {
  SalesActionItem,
  SalesActionPrimaryAction,
  SalesActionsPayload,
} from "@/lib/sales-dashboard/actions";
import { cn } from "@/lib/utils";

interface ActionsTabProps {
  from: string;
  to: string;
  active?: boolean;
  onOpenSources?: () => void;
}

export interface SalesActionExportRow {
  id: string;
  family: string;
  severity: string;
  title: string;
  detail: string;
  value: string;
  valueAmount: number | null;
  valueUnit: string;
  rankScore: number;
  primaryAction: string;
  primaryActionKind: string;
  primaryActionEnabled: boolean;
  primaryActionHref: string;
  matchStatus: string;
  salesStudent: string;
  creditStudent: string;
  evidence: string[];
}

export const SALES_ACTION_EXPORT_COLUMNS: CsvColumn<SalesActionExportRow>[] = [
  { key: "id", header: "ID", value: (row) => row.id },
  { key: "family", header: "Family", value: (row) => row.family },
  { key: "severity", header: "Severity", value: (row) => row.severity },
  { key: "title", header: "Title", value: (row) => row.title },
  { key: "detail", header: "Detail", value: (row) => row.detail },
  { key: "value", header: "Value", value: (row) => row.value },
  { key: "valueAmount", header: "Value Amount", value: (row) => row.valueAmount },
  { key: "valueUnit", header: "Value Unit", value: (row) => row.valueUnit },
  { key: "rankScore", header: "Rank Score", value: (row) => row.rankScore },
  { key: "primaryAction", header: "Primary Action", value: (row) => row.primaryAction },
  { key: "primaryActionKind", header: "Primary Action Kind", value: (row) => row.primaryActionKind },
  { key: "primaryActionEnabled", header: "Primary Action Enabled", value: (row) => row.primaryActionEnabled },
  { key: "primaryActionHref", header: "Primary Action Href", value: (row) => row.primaryActionHref },
  { key: "matchStatus", header: "Match Status", value: (row) => row.matchStatus },
  { key: "salesStudent", header: "Sales Student", value: (row) => row.salesStudent },
  { key: "creditStudent", header: "Credit Student", value: (row) => row.creditStudent },
  { key: "evidence", header: "Evidence", value: (row) => row.evidence },
];

export function buildSalesActionExportRows(payload: SalesActionsPayload): SalesActionExportRow[] {
  return payload.items.map((item) => ({
    id: item.id,
    family: item.family,
    severity: item.severity,
    title: item.title,
    detail: item.detail,
    value: item.value?.label ?? "",
    valueAmount: item.value?.amount ?? null,
    valueUnit: item.value?.unit ?? "",
    rankScore: item.rankScore,
    primaryAction: item.primaryAction.label,
    primaryActionKind: item.primaryAction.kind,
    primaryActionEnabled: item.primaryAction.enabled,
    primaryActionHref: item.primaryAction.href ?? "",
    matchStatus: item.match.status,
    salesStudent: item.match.salesStudentName ?? "",
    creditStudent: item.match.creditStudentName ?? "",
    evidence: item.evidence.map((entry) => `${entry.label}: ${entry.value}`),
  }));
}

export function ActionsTab({ from, to, active = true, onOpenSources }: ActionsTabProps) {
  const [payload, setPayload] = useState<SalesActionsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");

    fetch(`/api/sales-dashboard/actions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || `Actions request failed (${response.status})`);
        }
        setPayload(body as SalesActionsPayload);
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load sales actions");
        setPayload(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [from, to]);

  if (loading && !payload) return <ActionsSkeleton />;
  if (error && !payload) {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {error}
      </div>
    );
  }
  if (!payload) return null;

  return (
    <ActionsCockpit
      payload={payload}
      active={active}
      loading={loading}
      error={error}
      onOpenSources={onOpenSources}
    />
  );
}

export function ActionsCockpit({
  payload,
  active = true,
  loading = false,
  error = "",
  onOpenSources,
}: {
  payload: SalesActionsPayload;
  active?: boolean;
  loading?: boolean;
  error?: string;
  onOpenSources?: () => void;
}) {
  const chartConfig = useMemo(() => buildPaceChartConfig(payload), [payload]);
  const exportRows = useMemo(() => buildSalesActionExportRows(payload), [payload]);

  return (
    <section className="flex flex-col gap-4" aria-label="Sales action cockpit">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">GM action cockpit</h2>
            <Badge variant={payload.mode === "current" ? "default" : "outline"}>{payload.modeLabel}</Badge>
            {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {payload.period.from} to {payload.period.to}
            {payload.mode === "historical" ? " · Credit handoffs show current-state context." : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
          <CsvExportButton
            filename={`sales-dashboard-actions-${payload.period.from}-to-${payload.period.to}.csv`}
            rows={exportRows}
            columns={SALES_ACTION_EXPORT_COLUMNS}
          >
            Actions CSV
          </CsvExportButton>
        </div>
      </div>

      {payload.dependencyWarnings.length > 0 ? (
        <div className="grid gap-2">
          {payload.dependencyWarnings.map((warning) => (
            <div
              key={warning.id}
              className="flex gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"
            >
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <div>
                <div className="font-medium">{warning.title}</div>
                <div className="text-xs opacity-90">{warning.detail}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={<TrendingUp className="size-4" />}
          label="Projected normal sales"
          value={formatCurrency(payload.kpis.projectedNormalSales, true)}
          detail={`${formatCurrency(payload.kpis.normalSales, true)} booked`}
        />
        <KpiCard
          icon={<Target className="size-4" />}
          label="Target gap"
          value={formatCurrency(payload.kpis.targetGap, true)}
          detail={`${formatCurrency(payload.kpis.target, true)} target`}
          tone={payload.kpis.targetGap > 0 ? "warning" : "good"}
        />
        <KpiCard
          icon={<ShieldAlert className="size-4" />}
          label="Matched at-risk value"
          value={formatCurrency(payload.kpis.matchedAtRiskValue, true)}
          detail={`${payload.matchStats.unique} unique Credit match${payload.matchStats.unique === 1 ? "" : "es"}`}
          tone={payload.kpis.matchedAtRiskValue > 0 ? "critical" : "neutral"}
        />
        <KpiCard
          icon={<CheckCircle2 className="size-4" />}
          label="Actions ready"
          value={String(payload.kpis.actionsReady)}
          detail={`${payload.items.length} ranked signal${payload.items.length === 1 ? "" : "s"}`}
          tone={payload.kpis.actionsReady > 0 ? "good" : "neutral"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(420px,1.1fr)]">
        <section className="rounded-md border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Pace and forecast</h3>
              <p className="mt-1 text-xs text-muted-foreground">Normal sales against the Base projection and monthly target.</p>
            </div>
            {payload.chart.annotations.length > 0 ? (
              <Badge variant="outline">{payload.chart.annotations.length} drivers</Badge>
            ) : null}
          </div>
          <div className="mt-4 h-64">
            {payload.chart.points.length > 0 ? (
              <ChartCanvas
                config={chartConfig}
                className="h-full"
                ariaLabel="Sales pace and forecast chart"
                active={active}
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                No projection series available
              </div>
            )}
          </div>
          {payload.chart.annotations.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {payload.chart.annotations.map((annotation) => (
                <span
                  key={annotation.id}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-xs",
                    annotation.severity === "critical"
                      ? "border-destructive/30 bg-destructive/10 text-destructive"
                      : annotation.severity === "warning"
                        ? "border-amber-300/70 bg-amber-50 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"
                        : "border-border bg-muted text-muted-foreground",
                  )}
                >
                  <span className="truncate">{annotation.label}</span>
                </span>
              ))}
            </div>
          ) : null}
        </section>

        <section className="rounded-md border bg-card">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold">Ranked action feed</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Revenue recovery first, with Sales-only and data-trust work kept in the same queue.
              </p>
            </div>
            <Badge variant="secondary">{payload.items.length}</Badge>
          </div>

          {payload.items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No action signals for this period.
            </div>
          ) : (
            <div className="divide-y">
              {payload.items.map((item) => (
                <ActionFeedRow key={item.id} item={item} onOpenSources={onOpenSources} />
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function KpiCard({
  icon,
  label,
  value,
  detail,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "good" | "warning" | "critical";
}) {
  return (
    <div className={cn(
      "rounded-md border bg-card p-3",
      tone === "good" ? "border-available/30" : "",
      tone === "warning" ? "border-amber-300/70" : "",
      tone === "critical" ? "border-destructive/30" : "",
    )}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <div className="mt-2 text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function ActionFeedRow({ item, onOpenSources }: { item: SalesActionItem; onOpenSources?: () => void }) {
  return (
    <article className="grid gap-3 px-4 py-3 md:grid-cols-[1fr_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityIcon severity={item.severity} />
          <Badge variant={item.severity === "critical" ? "destructive" : item.severity === "warning" ? "outline" : "secondary"}>
            {familyLabel(item.family)}
          </Badge>
          {item.value ? <span className="text-xs font-medium tabular-nums text-muted-foreground">{item.value.label}</span> : null}
        </div>
        <h4 className="mt-2 text-sm font-semibold leading-snug">{item.title}</h4>
        <p className="mt-1 break-words text-sm text-muted-foreground">{item.detail}</p>
        {item.evidence.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.evidence.map((entry) => (
              <span key={`${item.id}-${entry.label}`} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{entry.label}:</span> {entry.value}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <PrimaryActionButton action={item.primaryAction} onOpenSources={onOpenSources} />
    </article>
  );
}

function PrimaryActionButton({
  action,
  onOpenSources,
}: {
  action: SalesActionPrimaryAction;
  onOpenSources?: () => void;
}) {
  if (!action.enabled || action.kind === "none") {
    return (
      <Button size="sm" variant="outline" disabled title={action.reason}>
        {action.label}
      </Button>
    );
  }
  if (action.kind === "source-manager") {
    return (
      <Button size="sm" variant="outline" onClick={onOpenSources} disabled={!onOpenSources}>
        <Database className="size-3.5" />
        {action.label}
      </Button>
    );
  }
  if (!action.href) {
    return (
      <Button size="sm" variant="outline" disabled title={action.reason}>
        {action.label}
      </Button>
    );
  }
  return (
    <Link
      href={action.href}
      className={buttonVariants({ size: "sm", variant: action.kind === "credit-control" ? "default" : "outline" })}
      title={action.reason}
    >
      {action.label}
      <ArrowUpRight className="size-3.5" />
    </Link>
  );
}

function SeverityIcon({ severity }: { severity: SalesActionItem["severity"] }) {
  if (severity === "critical") return <AlertTriangle className="size-4 text-destructive" />;
  if (severity === "warning") return <AlertTriangle className="size-4 text-amber-600" />;
  return <CheckCircle2 className="size-4 text-muted-foreground" />;
}

function familyLabel(family: SalesActionItem["family"]): string {
  switch (family) {
    case "renewal_rescue":
      return "Renewal";
    case "target_gap":
      return "Target";
    case "trial_conversion":
      return "Trial";
    case "rep_recovery":
      return "Rep";
    case "data_trust":
      return "Data";
  }
}

function buildPaceChartConfig(payload: SalesActionsPayload): ChartConfiguration {
  const colors = chartColors();
  const labels = payload.chart.points.map((point) => point.label);
  return {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Actual normal sales",
          data: payload.chart.points.map((point) => point.actualNormalRevenue),
          backgroundColor: colors.chart[0],
          borderColor: colors.chart[0],
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          type: "line",
          label: "Base projection",
          data: payload.chart.points.map((point) => point.baseProjectedRevenue),
          borderColor: colors.chart[1],
          backgroundColor: colors.chart[1],
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 2,
        },
        {
          type: "line",
          label: "Monthly target",
          data: payload.chart.points.map((point) => point.target),
          borderColor: colors.chart[3],
          backgroundColor: colors.chart[3],
          borderWidth: 2,
          borderDash: [5, 4],
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, color: colors.mutedForeground } },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatCurrency(Number(context.parsed.y ?? 0), true)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: colors.mutedForeground },
        },
        y: {
          grid: { color: colors.border },
          ticks: {
            color: colors.mutedForeground,
            callback: (value) => formatCurrency(Number(value), true),
          },
        },
      },
    },
  };
}

function ActionsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="h-8 w-56 animate-pulse rounded-md bg-muted" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-24 animate-pulse rounded-md bg-muted" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(420px,1.1fr)]">
        <div className="h-80 animate-pulse rounded-md bg-muted" />
        <div className="h-80 animate-pulse rounded-md bg-muted" />
      </div>
    </div>
  );
}
