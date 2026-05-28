"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { signIn } from "next-auth/react";
import Chart from "chart.js/auto";
import type { ChartConfiguration, ChartDataset } from "chart.js";
import {
  Archive,
  CalendarClock,
  Database,
  LinkIcon,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  currentBangkokDate,
  currentBangkokMonthEnd,
  currentBangkokMonthStart,
} from "@/lib/sales-dashboard/dates";
import type {
  SalesAdditionalDayAggregate,
  SalesDashboardPayload,
  SalesDashboardSourceSummary,
  SalesDayAggregate,
} from "@/lib/sales-dashboard/types";

type RevenueMode = "normal" | "add" | "combined" | "yoy" | "mom";
type ProgramMode = "normal" | "add";
type PaymentMode = "dow" | "week";
type SourceForm = {
  spreadsheetUrl: string;
  sourceMonth: string;
  label: string;
  normalSheetName: string;
  additionalSheetName: string;
};
type ImportSummary = {
  message?: string;
  sourceCount?: number;
  importedSourceCount?: number;
  normalRows?: number;
  additionalRows?: number;
};

const SHEETS_SCOPE = "openid email profile https://www.googleapis.com/auth/spreadsheets.readonly";
const PERIODS = [
  { key: "all", label: "All" },
  { key: "y2025", label: "2025" },
  { key: "y2026", label: "2026" },
  { key: "q1", label: "Q1 2026" },
  { key: "thismonth", label: "This Month" },
] as const;

function formatCurrency(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 1_000_000) {
    return `฿${(rounded / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  }
  return `฿${rounded.toLocaleString("en-US")}`;
}

function formatDateTime(value: string | null): string {
  if (!value) return "Never imported";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function todayIso(): string {
  return currentBangkokDate();
}

function shortMonth(monthLabel: string): string {
  const [ym, monthName] = monthLabel.split(" ");
  const year = ym?.slice(2, 4) ?? "";
  return `${monthName ?? ym} '${year}`;
}

function filterByRange<T extends { d: string }>(rows: T[], from: string, to: string): T[] {
  return rows.filter((row) => row.d >= from && row.d <= to);
}

function groupNormalByMonth(rows: SalesDayAggregate[]) {
  const map = new Map<string, SalesDayAggregate>();
  for (const row of rows) {
    const key = row.m;
    const existing = map.get(key) ?? {
      d: row.d,
      m: key,
      rev: 0,
      trial: 0,
      newS: 0,
      renew: 0,
      count: 0,
      revT: 0,
      revN: 0,
      revR: 0,
      pkgs: {},
      prgs: {},
      reps: {},
      dow: "",
    };
    existing.rev += row.rev;
    existing.trial += row.trial;
    existing.newS += row.newS;
    existing.renew += row.renew;
    existing.count += row.count;
    existing.revT += row.revT;
    existing.revN += row.revN;
    existing.revR += row.revR;
    map.set(key, existing);
  }
  return [...map.values()].sort((left, right) => left.m.localeCompare(right.m));
}

function groupAdditionalByMonth(rows: SalesAdditionalDayAggregate[]) {
  const map = new Map<string, SalesAdditionalDayAggregate>();
  for (const row of rows) {
    const existing = map.get(row.m) ?? { d: row.d, m: row.m, rev: 0, count: 0 };
    existing.rev += row.rev;
    existing.count += row.count;
    map.set(row.m, existing);
  }
  return [...map.values()].sort((left, right) => left.m.localeCompare(right.m));
}

function addCounts(target: Record<string, number>, values: Record<string, number>) {
  for (const [key, value] of Object.entries(values)) target[key] = (target[key] ?? 0) + value;
}

function topEntries(values: Record<string, number>, limit = 8) {
  return Object.entries(values).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function ChartCanvas({
  config,
  className,
}: {
  config: ChartConfiguration;
  className?: string;
}) {
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

function KpiCard({
  label,
  value,
  detail,
  tone = "sky",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "sky" | "amber" | "green" | "red" | "navy";
}) {
  const toneClass = {
    sky: "bg-sky-500",
    amber: "bg-amber-500",
    green: "bg-emerald-500",
    red: "bg-red-500",
    navy: "bg-primary",
  }[tone];
  return (
    <div className="relative overflow-hidden rounded-lg border bg-card px-4 py-3 shadow-sm">
      <div className={cn("absolute inset-x-0 top-0 h-1", toneClass)} />
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
  controls,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  controls?: ReactNode;
}) {
  return (
    <section className="flex min-h-[320px] flex-col rounded-lg border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
        {controls}
      </div>
      {children}
    </section>
  );
}

export function SalesDashboardShell() {
  const [data, setData] = useState<SalesDashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("all");
  const [from, setFrom] = useState("2025-04-01");
  const [to, setTo] = useState(todayIso());
  const [revenueMode, setRevenueMode] = useState<RevenueMode>("normal");
  const [programMode, setProgramMode] = useState<ProgramMode>("normal");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("dow");
  const [sourceForm, setSourceForm] = useState({
    spreadsheetUrl: "",
    sourceMonth: todayIso().slice(0, 7),
    label: "",
    normalSheetName: "",
    additionalSheetName: "",
  });
  const [busyAction, setBusyAction] = useState("");

  async function load() {
    setError("");
    try {
      const response = await fetch("/api/sales-dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
      const payload = (await response.json()) as SalesDashboardPayload;
      setData(payload);
      const allDates = [...payload.normalDays, ...payload.addDays].map((row) => row.d).sort();
      if (allDates.length > 0 && period === "all") {
        setFrom(allDates[0]);
        setTo(allDates.at(-1)!);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load sales dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function applyPeriod(next: typeof period) {
    setPeriod(next);
    if (next === "all" && data) {
      const allDates = [...data.normalDays, ...data.addDays].map((row) => row.d).sort();
      setFrom(allDates[0] ?? "2025-04-01");
      setTo(allDates.at(-1) ?? todayIso());
    }
    if (next === "y2025") {
      setFrom("2025-04-01");
      setTo("2025-12-31");
    }
    if (next === "y2026") {
      setFrom("2026-01-01");
      setTo(todayIso());
    }
    if (next === "q1") {
      setFrom("2026-01-01");
      setTo("2026-03-31");
    }
    if (next === "thismonth") {
      setFrom(currentBangkokMonthStart());
      setTo(currentBangkokMonthEnd());
    }
  }

  async function runAction(actionName: string, action: () => Promise<void>) {
    setBusyAction(actionName);
    setError("");
    setMessage("");
    try {
      await action();
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Request failed");
    } finally {
      setBusyAction("");
    }
  }

  async function requestJson(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(url, {
      ...init,
      headers,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  async function postJson(url: string, body: unknown = {}) {
    return requestJson(url, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async function patchJson(url: string, body: unknown = {}) {
    return requestJson(url, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async function deleteJson(url: string) {
    return requestJson(url, { method: "DELETE" });
  }

  async function seedHistoricalSources() {
    await runAction("seed", async () => {
      const payload = await postJson("/api/sales-dashboard/sources/seed") as { count?: number };
      setMessage(`Seeded ${payload.count ?? 0} historical sources. Run Backfill all next to import rows.`);
    });
  }

  async function backfillAllSources() {
    await runAction("backfill", async () => {
      const payload = await postJson("/api/sales-dashboard/import", { mode: "backfill" }) as ImportSummary;
      setMessage(payload.message ?? "Backfill completed.");
    });
  }

  async function refreshLiveMonths() {
    if (!data?.sources.length) {
      setMessage("No sources configured. Seed historical sources first.");
      return;
    }
    await runAction("refresh", async () => {
      const payload = await postJson("/api/sales-dashboard/import", { mode: "refreshable" }) as ImportSummary;
      setMessage(payload.message ?? "Refresh completed.");
    });
  }

  async function addSource() {
    await runAction("source-add", async () => {
      await postJson("/api/sales-dashboard/sources", {
        ...sourceForm,
        label: sourceForm.label || undefined,
        normalSheetName: sourceForm.normalSheetName || undefined,
        additionalSheetName: sourceForm.additionalSheetName || undefined,
      });
      setSourceForm({ spreadsheetUrl: "", sourceMonth: todayIso().slice(0, 7), label: "", normalSheetName: "", additionalSheetName: "" });
      setMessage("Source saved.");
    });
  }

  const filtered = useMemo(() => {
    if (!data) return { normalDays: [], addDays: [] };
    return {
      normalDays: filterByRange(data.normalDays, from, to),
      addDays: filterByRange(data.addDays, from, to),
    };
  }, [data, from, to]);

  const aggregates = useMemo(() => {
    const pkgCount: Record<string, number> = {};
    const progCount: Record<string, number> = {};
    const repRev: Record<string, number> = {};
    const repCount: Record<string, number> = {};
    const dayCount: Record<string, number> = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
    const dayRev: Record<string, number> = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
    let normalRevenue = 0;
    let additionalRevenue = 0;
    let normalTxn = 0;
    let additionalTxn = 0;
    let trials = 0;
    let newStudents = 0;
    let renewals = 0;

    for (const row of filtered.normalDays) {
      normalRevenue += row.rev;
      normalTxn += row.count;
      trials += row.trial;
      newStudents += row.newS;
      renewals += row.renew;
      addCounts(pkgCount, row.pkgs);
      addCounts(progCount, row.prgs);
      if (row.dow) {
        dayCount[row.dow] = (dayCount[row.dow] ?? 0) + row.count;
        dayRev[row.dow] = (dayRev[row.dow] ?? 0) + row.rev;
      }
      for (const [rep, value] of Object.entries(row.reps)) {
        repRev[rep] = (repRev[rep] ?? 0) + value.rev;
        repCount[rep] = (repCount[rep] ?? 0) + value.count;
      }
    }
    for (const row of filtered.addDays) {
      additionalRevenue += row.rev;
      additionalTxn += row.count;
    }

    const trialCohort = (data?.trialCohort ?? []).filter((row) => row.trialDate >= from && row.trialDate <= to);
    const trialConverted = trialCohort.filter((row) => row.convertedDate !== null && row.convertedDate <= to).length;
    const retentionCohort = (data?.retentionCohort ?? []).filter((row) => row.decisionDate >= from && row.decisionDate <= to);
    const retained = retentionCohort.filter((row) => row.renewedDate !== null).length;
    const churned = retentionCohort.filter((row) => row.status === "Churned").length;
    const repRows = Object.keys(repRev)
      .map((name) => ({ name, revenue: repRev[name], count: repCount[name] ?? 0 }))
      .sort((a, b) => b.revenue - a.revenue);
    return {
      pkgCount,
      progCount,
      dayCount,
      dayRev,
      normalRevenue,
      additionalRevenue,
      totalRevenue: normalRevenue + additionalRevenue,
      normalTxn,
      additionalTxn,
      trials,
      newStudents,
      renewals,
      trialCohortSize: trialCohort.length,
      trialConverted,
      retentionCohortSize: retentionCohort.length,
      retained,
      churned,
      repRows,
    };
  }, [data?.retentionCohort, data?.trialCohort, filtered, from, to]);

  const monthlyNormal = useMemo(() => groupNormalByMonth(filtered.normalDays), [filtered.normalDays]);
  const monthlyAdditional = useMemo(() => groupAdditionalByMonth(filtered.addDays), [filtered.addDays]);
  const monthlyAdditionalByLabel = useMemo(() => new Map(monthlyAdditional.map((row) => [row.m, row])), [monthlyAdditional]);

  const revenueConfig = useMemo<ChartConfiguration>(() => {
    const labels = Array.from(new Set([...monthlyNormal.map((row) => row.m), ...monthlyAdditional.map((row) => row.m)])).sort();
    const normalByLabel = new Map(monthlyNormal.map((row) => [row.m, row]));
    if (revenueMode === "add") {
      return barConfig(labels.map(shortMonth), [{
        label: "Additional",
        data: labels.map((label) => monthlyAdditionalByLabel.get(label)?.rev ?? 0),
        backgroundColor: "#E8712B",
      }], true);
    }
    if (revenueMode === "combined") {
      return barConfig(labels.map(shortMonth), [
        { label: "New", data: labels.map((label) => normalByLabel.get(label)?.revN ?? 0), backgroundColor: "#34D399", stack: "sales" },
        { label: "Renewal", data: labels.map((label) => normalByLabel.get(label)?.revR ?? 0), backgroundColor: "#FBBF24", stack: "sales" },
        { label: "Trial", data: labels.map((label) => normalByLabel.get(label)?.revT ?? 0), backgroundColor: "#60A5FA", stack: "sales" },
        { label: "Additional", data: labels.map((label) => monthlyAdditionalByLabel.get(label)?.rev ?? 0), backgroundColor: "#E8712B", stack: "sales" },
      ], true, true);
    }
    if (revenueMode === "yoy" || revenueMode === "mom") {
      const latest = labels.at(-1);
      const latestDate = latest?.slice(0, 7);
      let compareDate = "";
      if (latestDate) {
        const [year, month] = latestDate.split("-").map(Number);
        if (revenueMode === "yoy") compareDate = `${year - 1}-${String(month).padStart(2, "0")}`;
        else compareDate = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
      }
      const latestLabel = labels.find((label) => label.startsWith(latestDate ?? "")) ?? latest ?? "";
      const compareLabel = labels.find((label) => label.startsWith(compareDate)) ?? compareDate;
      const valueFor = (label: string) => (normalByLabel.get(label)?.rev ?? 0) + (monthlyAdditionalByLabel.get(label)?.rev ?? 0);
      return barConfig(["Comparison", "Selected"], [{
        label: revenueMode === "yoy" ? "YoY" : "MoM",
        data: [valueFor(compareLabel), valueFor(latestLabel)],
        backgroundColor: ["rgba(0,48,135,0.35)", "#003087"],
      }], true);
    }
    return barConfig(labels.map(shortMonth), [
      { label: "New", data: labels.map((label) => normalByLabel.get(label)?.revN ?? 0), backgroundColor: "#34D399", stack: "sales" },
      { label: "Renewal", data: labels.map((label) => normalByLabel.get(label)?.revR ?? 0), backgroundColor: "#FBBF24", stack: "sales" },
      { label: "Trial", data: labels.map((label) => normalByLabel.get(label)?.revT ?? 0), backgroundColor: "#60A5FA", stack: "sales" },
    ], true, true);
  }, [monthlyAdditional, monthlyAdditionalByLabel, monthlyNormal, revenueMode]);

  const pipelineConfig = useMemo<ChartConfiguration>(() => lineConfig(
    monthlyNormal.map((row) => shortMonth(row.m)),
    [
      { label: "Trials", data: monthlyNormal.map((row) => row.trial), borderColor: "#60A5FA", backgroundColor: "rgba(96,165,250,0.10)" },
      { label: "New Students", data: monthlyNormal.map((row) => row.newS), borderColor: "#34D399", backgroundColor: "rgba(52,211,153,0.10)" },
      { label: "Renewals", data: monthlyNormal.map((row) => row.renew), borderColor: "#FBBF24", backgroundColor: "rgba(251,191,36,0.12)" },
    ],
  ), [monthlyNormal]);

  const packageConfig = useMemo<ChartConfiguration>(() => horizontalBarConfig(topEntries(aggregates.pkgCount)), [aggregates.pkgCount]);
  const programConfig = useMemo<ChartConfiguration>(() => {
    const values = programMode === "normal" ? aggregates.progCount : data?.addPkgCount ?? {};
    return horizontalBarConfig(topEntries(values), programMode === "normal" ? "#0145A8" : "#E8712B");
  }, [aggregates.progCount, data?.addPkgCount, programMode]);
  const paymentConfig = useMemo<ChartConfiguration>(() => {
    if (paymentMode === "week") {
      const bands = ["1-5", "6-10", "11-15", "16-20", "21-25", "26-31"];
      const counts = [0, 0, 0, 0, 0, 0];
      for (const row of filtered.normalDays) {
        const day = Number(row.d.slice(8, 10));
        const index = day <= 5 ? 0 : day <= 10 ? 1 : day <= 15 ? 2 : day <= 20 ? 3 : day <= 25 ? 4 : 5;
        counts[index] += row.count;
      }
      return barConfig(bands, [{ label: "Transactions", data: counts, backgroundColor: "#E8712B" }], false);
    }
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return barConfig(days, [{ label: "Transactions", data: days.map((day) => aggregates.dayCount[day] ?? 0), backgroundColor: "#003087" }], false);
  }, [aggregates.dayCount, filtered.normalDays, paymentMode]);

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading sales dashboard...</div>;
  }

  const conversion = aggregates.trialCohortSize > 0 ? Math.round((aggregates.trialConverted / aggregates.trialCohortSize) * 100) : 0;
  const retentionRate = aggregates.retentionCohortSize > 0 ? Math.round((aggregates.retained / aggregates.retentionCohortSize) * 100) : 0;
  const replacement = aggregates.churned > 0 ? (aggregates.trialConverted / aggregates.churned).toFixed(2) : "—";
  const sourceCount = (data?.sources ?? []).filter((source) => source.status !== "archived").length;
  const hasSources = sourceCount > 0;
  const hasImportedRows = (data?.totalTxn ?? 0) + (data?.totalAddTxn ?? 0) > 0;
  const failedSources = (data?.sources ?? []).filter((source) => source.status !== "archived" && source.lastImportError);

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex items-center justify-between border-b bg-card px-4 py-3 lg:px-6">
        <div>
          <h1 className="text-base font-semibold text-primary">Sales Dashboard</h1>
          <p className="text-xs text-muted-foreground">Last updated {formatDateTime(data?.lastUpdated ?? null)}</p>
        </div>
        <div className="flex items-center gap-2">
          {!data?.token.connected ? (
            <Button
              variant="outline"
              onClick={() => signIn("google", { callbackUrl: "/sales-dashboard" }, {
                prompt: "consent",
                access_type: "offline",
                scope: SHEETS_SCOPE,
              })}
            >
              <ShieldCheck className="size-4" />
              Connect Google Sheets
            </Button>
          ) : (
            <Badge variant="secondary">{data.token.email}</Badge>
          )}
          <Button
            variant="outline"
            disabled={!hasSources || busyAction === "refresh"}
            title={!hasSources ? "No sources configured. Seed historical sources first." : undefined}
            onClick={() => void refreshLiveMonths()}
          >
            {busyAction === "refresh" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Refresh live months
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-b bg-card px-4 py-2 lg:px-6">
        <div className="flex items-center gap-2">
          {PERIODS.map((item) => (
            <Button
              key={item.key}
              size="sm"
              variant={period === item.key ? "default" : "outline"}
              onClick={() => applyPeriod(item.key)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input type="date" value={from} onChange={(event) => { setPeriod("all"); setFrom(event.target.value); }} className="w-36" />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="date" value={to} onChange={(event) => { setPeriod("all"); setTo(event.target.value); }} className="w-36" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 lg:px-6">
        {error ? <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
        {message ? <div className="mb-3 rounded-md border border-available/30 bg-available/10 px-3 py-2 text-sm text-available">{message}</div> : null}
        {failedSources.length > 0 ? (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <div className="font-medium">{failedSources.length} source{failedSources.length === 1 ? "" : "s"} failed the last import</div>
            <div className="mt-1 text-xs">
              {failedSources.slice(0, 3).map((source) => `${source.label}: ${source.lastImportError}`).join(" · ")}
              {failedSources.length > 3 ? ` · +${failedSources.length - 3} more` : ""}
            </div>
          </div>
        ) : null}

        {!hasSources || !hasImportedRows ? (
          <SalesDashboardSetupState
            connected={Boolean(data?.token.connected)}
            hasSources={hasSources}
            sourceCount={sourceCount}
            busyAction={busyAction}
            onConnect={() => signIn("google", { callbackUrl: "/sales-dashboard" }, {
              prompt: "consent",
              access_type: "offline",
              scope: SHEETS_SCOPE,
            })}
            onSeed={seedHistoricalSources}
            onBackfill={backfillAllSources}
          />
        ) : null}

        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <KpiCard label="Normal Sales" value={formatCurrency(aggregates.normalRevenue)} detail={`${aggregates.normalTxn.toLocaleString("en-US")} transactions`} tone="sky" />
          <KpiCard label="Additional Sales" value={formatCurrency(aggregates.additionalRevenue)} detail={`${aggregates.additionalTxn.toLocaleString("en-US")} transactions`} tone="amber" />
          <KpiCard label="Total Revenue" value={formatCurrency(aggregates.totalRevenue)} detail={`${(aggregates.normalTxn + aggregates.additionalTxn).toLocaleString("en-US")} transactions total`} tone="navy" />
          <KpiCard label="Trial Cohort Conversion" value={`${conversion}%`} detail={`${aggregates.trialConverted} converted / ${aggregates.trialCohortSize} first trials`} tone="green" />
          <KpiCard label="Retention Rate" value={`${retentionRate}%`} detail={`${aggregates.retained} retained / ${aggregates.retentionCohortSize} decisions`} tone="amber" />
          <KpiCard label="Churned · Replacement" value={`${aggregates.churned} churned`} detail={`Replacement ${replacement}x · ${aggregates.trialConverted} trial conversions`} tone="red" />
        </div>

        <GoalTracker normalRevenue={aggregates.normalRevenue} monthlyNormal={monthlyNormal} />

        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <ChartCard
            title="Monthly Revenue"
            controls={<Segmented value={revenueMode} onChange={(value) => setRevenueMode(value as RevenueMode)} options={["normal", "add", "combined", "yoy", "mom"]} />}
          >
            <ChartCanvas config={revenueConfig} />
          </ChartCard>
          <ChartCard title="Pipeline Health" subtitle="Trial to New Student to Renewal per month">
            <ChartCanvas config={pipelineConfig} />
          </ChartCard>
          <SalesRepRanking rows={aggregates.repRows} />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <ChartCard title="Package Hours" subtitle="Transaction count · Normal Sales">
            <ChartCanvas config={packageConfig} />
          </ChartCard>
          <ChartCard
            title="Program"
            controls={<Segmented value={programMode} onChange={(value) => setProgramMode(value as ProgramMode)} options={["normal", "add"]} />}
          >
            <ChartCanvas config={programConfig} />
          </ChartCard>
          <ChartCard
            title="Payment Concentration"
            controls={<Segmented value={paymentMode} onChange={(value) => setPaymentMode(value as PaymentMode)} options={["dow", "week"]} />}
          >
            <ChartCanvas config={paymentConfig} />
          </ChartCard>
        </div>

        <SourceManager
          sources={data?.sources ?? []}
          form={sourceForm}
          setForm={setSourceForm}
          busyAction={busyAction}
          runAction={runAction}
          postJson={postJson}
          patchJson={patchJson}
          deleteJson={deleteJson}
          addSource={addSource}
          seedHistoricalSources={seedHistoricalSources}
          backfillAllSources={backfillAllSources}
        />
      </div>
    </main>
  );
}

function SalesDashboardSetupState({
  connected,
  hasSources,
  sourceCount,
  busyAction,
  onConnect,
  onSeed,
  onBackfill,
}: {
  connected: boolean;
  hasSources: boolean;
  sourceCount: number;
  busyAction: string;
  onConnect: () => void;
  onSeed: () => Promise<void>;
  onBackfill: () => Promise<void>;
}) {
  return (
    <section className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-4 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-sky-950">
            {hasSources ? "Sources are configured, but no rows have been imported" : "No monthly sources configured"}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-sky-900/80">
            {hasSources
              ? `${sourceCount} monthly sources are ready. Run Backfill all to load historical rows into Postgres.`
              : connected
                ? "Google Sheets is connected, but the dashboard has no monthly sheet sources yet. Seed the historical source list, then run Backfill all."
                : "Connect Google Sheets first, then seed the historical source list and run Backfill all."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!connected ? (
            <Button variant="outline" onClick={onConnect}>
              <ShieldCheck className="size-4" />
              Connect Google Sheets
            </Button>
          ) : null}
          <Button onClick={() => void onSeed()} disabled={!connected || busyAction === "seed"}>
            {busyAction === "seed" ? <Loader2 className="size-4 animate-spin" /> : <Database className="size-4" />}
            Seed historical sources
          </Button>
          <Button variant="outline" onClick={() => void onBackfill()} disabled={!hasSources || busyAction === "backfill"}>
            {busyAction === "backfill" ? <Loader2 className="size-4 animate-spin" /> : <CalendarClock className="size-4" />}
            Backfill all
          </Button>
        </div>
      </div>
    </section>
  );
}

function GoalTracker({ normalRevenue, monthlyNormal }: { normalRevenue: number; monthlyNormal: SalesDayAggregate[] }) {
  const goal = 4_000_000;
  const currentMonth = currentBangkokDate().slice(0, 7);
  const completed = monthlyNormal.filter((row) => {
    return row.m.slice(0, 7) < currentMonth;
  });
  const fy26 = completed.filter((row) => row.m.startsWith("2026-"));
  const average = fy26.length ? fy26.reduce((sum, row) => sum + row.rev, 0) / fy26.length : normalRevenue;
  const display = normalRevenue || average;
  const pct = Math.min(100, Math.round((display / goal) * 100));
  const gap = Math.max(0, goal - display);
  return (
    <section className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-amber-950">Goal Tracker · ฿4M/mo</h2>
          <p className="text-xs text-amber-900/75">{formatCurrency(gap)} gap against the normal-sales monthly target</p>
        </div>
        <Badge className="bg-amber-600 text-white">{pct}%</Badge>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/80">
        <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-sky-500" style={{ width: `${pct}%` }} />
      </div>
    </section>
  );
}

function SalesRepRanking({ rows }: { rows: Array<{ name: string; revenue: number; count: number }> }) {
  const max = rows[0]?.revenue || 1;
  return (
    <ChartCard title="Sales Rep Ranking" subtitle="Revenue · Normal Sales">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 text-left">#</th>
              <th className="py-2 text-left">Name</th>
              <th className="py-2 text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((row, index) => (
              <tr key={row.name} className="border-b last:border-0">
                <td className="py-2 text-muted-foreground">{index + 1}</td>
                <td className="py-2">
                  <div className="font-medium">{row.name}</div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((row.revenue / max) * 100)}%` }} />
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{row.count} transactions</div>
                </td>
                <td className="py-2 text-right font-semibold text-primary">{formatCurrency(row.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

function SourceManager({
  sources,
  form,
  setForm,
  busyAction,
  runAction,
  postJson,
  patchJson,
  deleteJson,
  addSource,
  seedHistoricalSources,
  backfillAllSources,
}: {
  sources: SalesDashboardSourceSummary[];
  form: SourceForm;
  setForm: Dispatch<SetStateAction<SourceForm>>;
  busyAction: string;
  runAction: (actionName: string, action: () => Promise<void>) => Promise<void>;
  postJson: (url: string, body?: unknown) => Promise<unknown>;
  patchJson: (url: string, body?: unknown) => Promise<unknown>;
  deleteJson: (url: string) => Promise<unknown>;
  addSource: () => Promise<void>;
  seedHistoricalSources: () => Promise<void>;
  backfillAllSources: () => Promise<void>;
}) {
  const activeSources = sources.filter((source) => source.status !== "archived");
  const archivedSources = sources.filter((source) => source.status === "archived");

  return (
    <section className="mt-4 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Monthly Sources</h2>
          <p className="text-xs text-muted-foreground">{activeSources.length} active Google Sheet sources · {archivedSources.length} archived</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void seedHistoricalSources()}>
            {busyAction === "seed" ? <Loader2 className="size-4 animate-spin" /> : <Database className="size-4" />}
            Seed historical
          </Button>
          <Button variant="outline" onClick={() => void backfillAllSources()}>
            {busyAction === "backfill" ? <Loader2 className="size-4 animate-spin" /> : <CalendarClock className="size-4" />}
            Backfill all
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 lg:grid-cols-[1.8fr_0.7fr_0.9fr_0.8fr_0.8fr_auto]">
        <Input placeholder="Google Sheet URL" value={form.spreadsheetUrl} onChange={(event) => setForm((current) => ({ ...current, spreadsheetUrl: event.target.value }))} />
        <Input type="month" value={form.sourceMonth} onChange={(event) => setForm((current) => ({ ...current, sourceMonth: event.target.value }))} />
        <Input placeholder="Label" value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} />
        <Input placeholder="Normal tab" value={form.normalSheetName} onChange={(event) => setForm((current) => ({ ...current, normalSheetName: event.target.value }))} />
        <Input placeholder="Additional tab" value={form.additionalSheetName} onChange={(event) => setForm((current) => ({ ...current, additionalSheetName: event.target.value }))} />
        <Button onClick={() => void addSource()} disabled={!form.spreadsheetUrl || busyAction === "source-add"}>
          {busyAction === "source-add" ? <Loader2 className="size-4 animate-spin" /> : <LinkIcon className="size-4" />}
          Save
        </Button>
      </div>

      <div className="mt-4 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 text-left">Month</th>
              <th className="py-2 text-left">Status</th>
              <th className="py-2 text-left">Rows</th>
              <th className="py-2 text-left">Imported</th>
              <th className="py-2 text-left">Account</th>
              <th className="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {activeSources.map((source) => (
              <tr key={source.id} className="border-b last:border-0">
                <td className="py-2">
                  <div className="font-medium">{source.label}</div>
                  <div className="text-xs text-muted-foreground">{source.sourceMonth.slice(0, 7)}</div>
                </td>
                <td className="py-2">
                  <Badge variant={source.status === "finalized" ? "secondary" : "outline"}>{source.status}</Badge>
                  {source.lastImportError ? (
                    <div className="mt-1 max-w-[260px] text-xs text-destructive">Last import failed: {source.lastImportError}</div>
                  ) : null}
                </td>
                <td className="py-2 text-xs text-muted-foreground">{source.lastNormalRowCount} normal · {source.lastAdditionalRowCount} additional</td>
                <td className="py-2 text-xs text-muted-foreground">{formatDateTime(source.lastImportedAt)}</td>
                <td className="py-2 text-xs text-muted-foreground">{source.connectedEmail}</td>
                <td className="py-2">
                  <div className="flex justify-end gap-1">
                    <Button size="icon-sm" variant="outline" title="Import source" onClick={() => void runAction(`import-${source.id}`, async () => {
                      await postJson("/api/sales-dashboard/import", { sourceId: source.id, allowFinalized: source.status === "finalized" && window.confirm("Refresh finalized source?") });
                    })}>
                      {busyAction === `import-${source.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                    </Button>
                    {source.status === "finalized" ? (
                      <Button size="icon-sm" variant="outline" title="Reopen" onClick={() => void runAction(`reopen-${source.id}`, async () => {
                        await patchJson(`/api/sales-dashboard/sources/${source.id}`, { status: "reopened" });
                      })}>
                        <RotateCcw className="size-3.5" />
                      </Button>
                    ) : null}
                    <Button size="icon-sm" variant="outline" title="Archive source" disabled={source.status === "refreshing"} onClick={() => void runAction(`archive-${source.id}`, async () => {
                      if (!window.confirm(`Archive ${source.label}? Imported rows and import history will be kept and can be restored later.`)) return;
                      await deleteJson(`/api/sales-dashboard/sources/${source.id}`);
                    })}>
                      {busyAction === `archive-${source.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {archivedSources.length > 0 ? (
        <details className="mt-4 rounded-md border bg-muted/20 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Archived sources ({archivedSources.length})</summary>
          <div className="mt-3 overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 text-left">Month</th>
                  <th className="py-2 text-left">Archived</th>
                  <th className="py-2 text-left">Rows kept</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {archivedSources.map((source) => (
                  <tr key={source.id} className="border-b last:border-0">
                    <td className="py-2">
                      <div className="font-medium">{source.label}</div>
                      <div className="text-xs text-muted-foreground">{source.sourceMonth.slice(0, 7)}</div>
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {formatDateTime(source.archivedAt)}
                      {source.archivedByEmail ? <div>{source.archivedByEmail}</div> : null}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">{source.lastNormalRowCount} normal · {source.lastAdditionalRowCount} additional</td>
                    <td className="py-2">
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => void runAction(`restore-${source.id}`, async () => {
                          await patchJson(`/api/sales-dashboard/sources/${source.id}`, { status: "active" });
                        })}>
                          {busyAction === `restore-${source.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                          Restore
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: string[] }) {
  return (
    <div className="flex gap-1">
      {options.map((option) => (
        <Button key={option} size="xs" variant={value === option ? "default" : "outline"} onClick={() => onChange(option)} className="capitalize">
          {option}
        </Button>
      ))}
    </div>
  );
}

function barConfig(labels: string[], datasets: ChartDataset<"bar">[], currency = false, stacked = false): ChartConfiguration {
  return {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked, grid: { display: false } },
        y: {
          stacked,
          grid: { color: "rgba(0,0,0,0.05)" },
          ticks: { callback: (value) => currency ? formatCurrency(Number(value)) : String(value) },
        },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${currency ? formatCurrency(Number(ctx.raw)) : ctx.raw}` } } },
    },
  };
}

function lineConfig(labels: string[], datasets: ChartDataset<"line">[]): ChartConfiguration {
  return {
    type: "line",
    data: { labels, datasets: datasets.map((dataset) => ({ ...dataset, fill: true, tension: 0.35, pointRadius: 3 })) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.05)" } } },
      plugins: { legend: { display: false } },
    },
  };
}

function horizontalBarConfig(entries: Array<[string, number]>, color = "#0145A8"): ChartConfiguration {
  return {
    type: "bar",
    data: {
      labels: entries.map(([label]) => label.length > 24 ? `${label.slice(0, 23)}…` : label),
      datasets: [{ label: "Transactions", data: entries.map(([, value]) => value), backgroundColor: color, borderRadius: 4 }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.05)" } }, y: { grid: { display: false } } },
      plugins: { legend: { display: false } },
    },
  };
}
