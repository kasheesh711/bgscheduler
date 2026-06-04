"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Play,
  Radio,
  RefreshCw,
  ShieldAlert,
  TimerReset,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import type { CronJobStatus, DataHealthDashboardPayload } from "@/lib/data-health/types";
import { cn } from "@/lib/utils";

function statusTone(status: CronJobStatus): string {
  if (status === "healthy") return "border-available/30 bg-available/10 text-available";
  if (status === "running") return "border-sky-300 bg-sky-50 text-sky-800";
  if (status === "late") return "border-amber-300 bg-amber-50 text-amber-900";
  if (status === "failing") return "border-destructive/30 bg-destructive/10 text-destructive";
  if (status === "manual-only") return "border-muted bg-muted text-muted-foreground";
  return "border-slate-300 bg-slate-50 text-slate-700";
}

function StatusGlyph({ status, className }: { status: CronJobStatus; className?: string }) {
  if (status === "healthy") return <CheckCircle2 className={className} />;
  if (status === "running") return <TimerReset className={className} />;
  if (status === "late") return <Clock3 className={className} />;
  if (status === "failing") return <XCircle className={className} />;
  if (status === "manual-only") return <Play className={className} />;
  return <AlertTriangle className={className} />;
}

function StatusBadge({ status }: { status: CronJobStatus }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 capitalize", statusTone(status))}>
      <StatusGlyph status={status} className="size-3.5" />
      {status.replace("-", " ")}
    </Badge>
  );
}

function timeLabel(value: string | null): string {
  return value ? formatBangkokDateTime(value) : "-";
}

function shortTime(value: string | null): string {
  if (!value) return "-";
  return formatBangkokDateTime(value, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function durationLabel(value: number | null): string {
  if (value === null) return "-";
  if (value < 1000) return `${value}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function numberLabel(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "-";
}

function isDashboardPayload(value: unknown): value is DataHealthDashboardPayload {
  return typeof value === "object" && value !== null && "overall" in value && "cronJobs" in value;
}

function HealthMetric({ label, value, status }: { label: string; value: string | number; status?: CronJobStatus }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div className={cn("mt-2 text-2xl font-semibold tracking-tight", status === "failing" && "text-destructive", status === "late" && "text-amber-700")}>
        {value}
      </div>
    </div>
  );
}

function Timeline({ data }: { data: DataHealthDashboardPayload }) {
  const scheduledJobs = data.cronJobs.filter((job) => !job.manualOnly);
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Next expected cron</h2>
          <p className="text-xs text-muted-foreground">UTC schedules evaluated against Bangkok operating windows</p>
        </div>
        <Badge variant="outline">{scheduledJobs.length} scheduled</Badge>
      </div>
      <div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-4">
        {scheduledJobs.map((job) => (
          <div key={job.key} className="rounded-md border bg-background px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{job.label}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{job.cadenceLabel}</div>
              </div>
              <StatusBadge status={job.status} />
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full",
                  job.status === "healthy" && "bg-available",
                  job.status === "running" && "bg-sky-500",
                  job.status === "late" && "bg-amber-500",
                  job.status === "failing" && "bg-destructive",
                  job.status === "unknown" && "bg-slate-400",
                )}
                style={{ width: job.status === "healthy" ? "78%" : job.status === "running" ? "52%" : "100%" }}
              />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
              <div>
                <span className="font-medium text-foreground">Last</span>
                <div>{shortTime(job.lastSeenAt)}</div>
              </div>
              <div>
                <span className="font-medium text-foreground">Next</span>
                <div>{shortTime(job.nextExpectedAt)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function QuickActions({
  data,
  busyJob,
  onRun,
}: {
  data: DataHealthDashboardPayload;
  busyJob: string | null;
  onRun: (key: string) => void;
}) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Manual controls</h2>
        <p className="text-xs text-muted-foreground">Session-gated operational triggers</p>
      </div>
      <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-4">
        {data.manualActions.map((action) => (
          <Button
            key={action.key}
            variant={action.dangerous ? "outline" : "secondary"}
            size="sm"
            className={cn("justify-start gap-2", action.dangerous && "border-amber-300 bg-amber-50 text-amber-950 hover:bg-amber-100")}
            disabled={busyJob !== null}
            onClick={() => onRun(action.key)}
            title={action.confirmationLabel ?? `Run ${action.label}`}
          >
            {busyJob === action.key ? <RefreshCw className="size-4 animate-spin" /> : action.dangerous ? <ShieldAlert className="size-4" /> : <Play className="size-4" />}
            <span className="truncate">{action.label}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}

function CronControlPlane({ data }: { data: DataHealthDashboardPayload }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Cron control plane</h2>
          <p className="text-xs text-muted-foreground">Direct audit rows supersede run-table inference as new crons fire</p>
        </div>
        <Badge variant="outline">{data.cronJobs.length} jobs</Badge>
      </div>
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Proof</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.cronJobs.map((job) => (
              <TableRow key={job.key}>
                <TableCell>
                  <div className="font-medium">{job.label}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{job.path}</div>
                </TableCell>
                <TableCell><StatusBadge status={job.status} /></TableCell>
                <TableCell>
                  <div className="text-sm">{job.proof === "direct" ? "Direct" : job.proof === "inferred" ? "Inferred" : "None"}</div>
                  <div className="max-w-52 text-xs text-muted-foreground">{job.healthDetail}</div>
                </TableCell>
                <TableCell>{shortTime(job.lastSeenAt)}</TableCell>
                <TableCell>
                  <div className="text-xs text-muted-foreground">Last {shortTime(job.lastExpectedAt)}</div>
                  <div className="text-xs text-muted-foreground">Next {shortTime(job.nextExpectedAt)}</div>
                </TableCell>
                <TableCell className="text-right font-mono text-xs">{durationLabel(job.durationMs)}</TableCell>
                <TableCell className="max-w-72 truncate text-xs text-destructive">{job.errorSummary ?? "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function DataFreshness({ data }: { data: DataHealthDashboardPayload }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Data freshness</h2>
        <p className="text-xs text-muted-foreground">Domain snapshots and sidecar syncs powering the site</p>
      </div>
      <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-4">
        {data.dataDomains.map((domain) => (
          <div key={domain.key} className="rounded-md border bg-background px-3 py-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{domain.label}</div>
                <div className="mt-1 text-xs text-muted-foreground">{domain.detail}</div>
              </div>
              <StatusBadge status={domain.status} />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase text-muted-foreground">Freshness</div>
                <div className="mt-1 text-sm font-medium">{domain.freshnessLabel}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase text-muted-foreground">Records</div>
                <div className="mt-1 truncate text-sm font-medium">{domain.recordCountLabel}</div>
              </div>
            </div>
            {domain.issueCount > 0 && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-950">
                {domain.issueCount} issue{domain.issueCount === 1 ? "" : "s"} need attention
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function WiseSnapshot({ data }: { data: DataHealthDashboardPayload }) {
  const stats = data.wiseSnapshot.stats;
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Wise snapshot fidelity</h2>
          <p className="text-xs text-muted-foreground">Active search snapshot and fail-closed normalization counters</p>
        </div>
        <Badge variant="outline" className="font-mono">{data.wiseSnapshot.activeSnapshotId?.slice(0, 8) ?? "no snapshot"}</Badge>
      </div>
      <div className="grid gap-3 p-3 lg:grid-cols-[1fr_1.3fr]">
        <div className="grid grid-cols-2 gap-3">
          <HealthMetric label="Wise teachers" value={numberLabel(stats?.totalWiseTeachers)} />
          <HealthMetric label="Identity groups" value={numberLabel(stats?.totalIdentityGroups)} />
          <HealthMetric label="Resolved" value={numberLabel(stats?.resolvedGroups)} />
          <HealthMetric label="Unresolved" value={numberLabel(stats?.unresolvedGroups)} status={stats?.unresolvedGroups ? "late" : "healthy"} />
          <HealthMetric label="Future sessions" value={numberLabel(stats?.totalFutureSessions)} />
          <HealthMetric label="Total issues" value={numberLabel(stats?.totalDataIssues)} status={stats?.totalDataIssues ? "late" : "healthy"} />
        </div>
        <div className="rounded-md border bg-background p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-[10px] font-semibold uppercase text-muted-foreground">Last successful Wise sync</div>
              <div className="mt-1 text-sm font-medium">{timeLabel(data.wiseSnapshot.lastSuccessfulSync)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase text-muted-foreground">Last failed Wise sync</div>
              <div className="mt-1 text-sm font-medium">{timeLabel(data.wiseSnapshot.lastFailedSync)}</div>
            </div>
          </div>
          {data.wiseSnapshot.lastFailureError && (
            <div className="mt-3 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {data.wiseSnapshot.lastFailureError}
            </div>
          )}
          <div className="mt-4">
            <div className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">Issues by type</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.issueSummary).length ? Object.entries(data.issueSummary).map(([type, count]) => (
                <Badge key={type} variant="outline" className="text-xs">
                  {type}: {count}
                </Badge>
              )) : <span className="text-sm text-muted-foreground">No snapshot issues recorded.</span>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function IssueTable({
  title,
  rows,
  firstLabel,
}: {
  title: string;
  rows: Array<{ entityName: string; message: string; issueType?: string }>;
  firstLabel: string;
}) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Badge variant="outline">{rows.length}</Badge>
      </div>
      <div className="max-h-80 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{firstLabel}</TableHead>
              <TableHead>Issue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? rows.slice(0, 80).map((row, index) => (
              <TableRow key={`${row.entityName}-${index}`}>
                <TableCell className="font-medium">
                  {row.entityName || "-"}
                  {row.issueType && (
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      {row.issueType === "conflict_model" ? "session" : "group"}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{row.message}</TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={2} className="h-20 text-center text-sm text-muted-foreground">Clear</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function NormalizationIssues({ data }: { data: DataHealthDashboardPayload }) {
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <IssueTable title="Unresolved aliases" rows={data.issueDetails.unresolvedAliases} firstLabel="Teacher" />
      <IssueTable title="Modality issues" rows={data.issueDetails.unresolvedModality} firstLabel="Group / Session" />
      <IssueTable title="Unmapped tags" rows={data.issueDetails.unmappedTags} firstLabel="Tag" />
    </div>
  );
}

function RecentRuns({ data }: { data: DataHealthDashboardPayload }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Unified run history</h2>
          <p className="text-xs text-muted-foreground">Recent durable runs across the operational subsystems</p>
        </div>
        <Badge variant="outline">{data.recentRuns.length} rows</Badge>
      </div>
      <div className="max-h-[520px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Finished</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Count</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.recentRuns.map((run) => (
              <TableRow key={`${run.jobKey}-${run.id}`}>
                <TableCell>
                  <div className="font-medium">{run.label}</div>
                  <div className="text-[11px] text-muted-foreground">{run.triggerType ?? run.id.slice(0, 8)}</div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={run.status === "failed" ? "destructive" : run.status === "running" ? "secondary" : "outline"}
                    className="capitalize"
                  >
                    {run.status}
                  </Badge>
                </TableCell>
                <TableCell>{shortTime(run.startedAt)}</TableCell>
                <TableCell>{shortTime(run.finishedAt)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{durationLabel(run.durationMs)}</TableCell>
                <TableCell className="text-sm">{run.countLabel}</TableCell>
                <TableCell className="max-w-80 truncate text-xs text-destructive">{run.errorSummary ?? "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export function DataHealthDashboard({ initialData }: { initialData: DataHealthDashboardPayload }) {
  const [data, setData] = useState(initialData);
  const [refreshing, setRefreshing] = useState(false);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const sortedJobs = useMemo(
    () => [...data.cronJobs].sort((a, b) => a.label.localeCompare(b.label)),
    [data.cronJobs],
  );

  async function refresh() {
    setRefreshing(true);
    setMessage(null);
    try {
      const response = await fetch("/api/data-health");
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok || !isDashboardPayload(payload)) {
        const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `HTTP ${response.status}`;
        throw new Error(message);
      }
      setData(payload);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to refresh";
      setMessage(`Refresh failed: ${text}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function runJob(jobKey: string) {
    const action = data.manualActions.find((item) => item.key === jobKey);
    if (!action) return;
    if (action.dangerous) {
      const confirmed = window.confirm(action.confirmationLabel ?? "Run this job now?");
      if (!confirmed) return;
    }

    setBusyJob(jobKey);
    setMessage(null);
    try {
      const response = await fetch(`/api/data-health/jobs/${jobKey}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: action.dangerous }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      setMessage(`${action.label} triggered successfully.`);
      await refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : "Run failed";
      setMessage(`${action.label} failed: ${text}`);
    } finally {
      setBusyJob(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Data Health</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Checked {formatBangkokDateTime(data.checkedAt)} · Active snapshot {data.activeSnapshotId?.slice(0, 8) ?? "none"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing || busyJob !== null} className="gap-2">
          <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {message && (
        <div
          role="status"
          className={cn(
            "rounded-lg border px-4 py-2 text-sm",
            message.includes("failed") ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-available/30 bg-available/10 text-available",
          )}
        >
          {message}
        </div>
      )}

      <section className={cn("rounded-lg border px-4 py-4", statusTone(data.overall.status))}>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_640px]">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-background/80 p-2">
              <StatusGlyph status={data.overall.status} className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{data.overall.headline}</h2>
              <p className="mt-1 text-sm opacity-85">{data.overall.detail}</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <HealthMetric label="Healthy" value={data.overall.healthyCount} status="healthy" />
            <HealthMetric label="Late" value={data.overall.lateCount} status="late" />
            <HealthMetric label="Failing" value={data.overall.failingCount} status="failing" />
            <HealthMetric label="Running" value={data.overall.runningCount} status="running" />
            <HealthMetric label="Unknown" value={data.overall.unknownCount} status="unknown" />
            <HealthMetric label="Manual" value={data.overall.manualOnlyCount} status="manual-only" />
          </div>
        </div>
      </section>

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <Timeline data={{ ...data, cronJobs: sortedJobs }} />
        <QuickActions data={data} busyJob={busyJob} onRun={runJob} />
      </div>

      <div className="grid gap-4">
        <CronControlPlane data={{ ...data, cronJobs: sortedJobs }} />
        <DataFreshness data={data} />
        <WiseSnapshot data={data} />
        <NormalizationIssues data={data} />
        <RecentRuns data={data} />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Card className="rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Radio className="size-4 text-primary" />
            Direct audit
          </div>
          <div className="mt-2 text-sm">{data.cronJobs.filter((job) => job.proof === "direct").length} jobs have cron invocation rows.</div>
        </Card>
        <Card className="rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Database className="size-4 text-primary" />
            Run-table inference
          </div>
          <div className="mt-2 text-sm">{data.cronJobs.filter((job) => job.proof === "inferred").length} jobs are using durable run evidence.</div>
        </Card>
        <Card className="rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Activity className="size-4 text-primary" />
            Wise snapshot stale
          </div>
          <div className="mt-2 text-sm">{data.staleAgeMs !== null && data.staleAgeMs > 90 * 60 * 1000 ? "Yes" : "No"}</div>
        </Card>
      </div>
    </div>
  );
}
