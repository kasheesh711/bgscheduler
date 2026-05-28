"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import {
  CalendarClock,
  Database,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SalesDashboardCommandCenter } from "@/components/sales-dashboard/gm-command-center";
import { SourceManager, type SourceForm } from "@/components/sales-dashboard/source-manager";
import {
  currentBangkokDate,
  currentBangkokMonthEnd,
  currentBangkokMonthStart,
} from "@/lib/sales-dashboard/dates";
import type { SalesDashboardPayload } from "@/lib/sales-dashboard/types";

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

function todayIso(): string {
  return currentBangkokDate();
}

function newSourceForm(): SourceForm {
  return {
    spreadsheetUrl: "",
    sourceMonth: todayIso().slice(0, 7),
    label: "",
    normalSheetName: "",
    additionalSheetName: "",
  };
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

export function SalesDashboardShell() {
  const [data, setData] = useState<SalesDashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("thismonth");
  const [from, setFrom] = useState(currentBangkokMonthStart());
  const [to, setTo] = useState(currentBangkokMonthEnd());
  const [sourceForm, setSourceForm] = useState<SourceForm>(newSourceForm);
  const [busyAction, setBusyAction] = useState("");
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);

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
    const sourceCount = (data?.sources ?? []).filter((source) => source.status !== "archived").length;
    if (!sourceCount) {
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
      setSourceForm(newSourceForm());
      setMessage("Source saved.");
    });
  }

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading sales dashboard...</div>;
  }

  const sourceCount = (data?.sources ?? []).filter((source) => source.status !== "archived").length;
  const hasSources = sourceCount > 0;
  const hasImportedRows = (data?.totalTxn ?? 0) + (data?.totalAddTxn ?? 0) > 0;
  const failedSources = (data?.sources ?? []).filter((source) => source.status !== "archived" && source.lastImportError);

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex flex-col gap-3 border-b bg-card px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-6">
        <div>
          <h1 className="text-base font-semibold text-primary">Sales Dashboard</h1>
          <p className="text-xs text-muted-foreground">Last updated {formatDateTime(data?.lastUpdated ?? null)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          <Button variant="outline" onClick={() => setSourceDialogOpen(true)}>
            <Database className="size-4" />
            Data Sources & Imports
          </Button>
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

      <div className="flex flex-col gap-3 border-b bg-card px-4 py-2 lg:flex-row lg:items-center lg:justify-between lg:px-6">
        <div className="flex flex-wrap items-center gap-2">
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

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 lg:px-6">
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

        {data && hasSources && hasImportedRows ? (
          <SalesDashboardCommandCenter data={data} from={from} to={to} />
        ) : null}
      </div>

      <Dialog open={sourceDialogOpen} onOpenChange={setSourceDialogOpen}>
        <DialogContent className="max-h-[86vh] w-[calc(100vw-2rem)] overflow-auto sm:max-w-6xl">
          <DialogHeader className="min-w-0">
            <DialogTitle>Data Sources & Imports</DialogTitle>
            <DialogDescription>
              Google Sheets setup, backfills, import status, source archival, and restore controls.
            </DialogDescription>
          </DialogHeader>
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
        </DialogContent>
      </Dialog>
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
