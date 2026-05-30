"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  UserCheck,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LinkValidationPanel } from "./link-validation-panel";
import type {
  LineLinkValidationReviewerSummary,
  LineLinkValidationSummary,
  LineOaResolverRun,
} from "./types";
import { formatDateTime, jsonFetch } from "./utils";

function StatCard({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold leading-none text-foreground">{value}</div>
      {detail ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function reviewerName(reviewer: LineLinkValidationReviewerSummary): string {
  return reviewer.name || reviewer.email;
}

function runLabel(run: LineOaResolverRun): string {
  return `${run.id.slice(0, 8)} / ${run.status} / ${formatDateTime(run.createdAt)}`;
}

export function MappingValidationWorkspace({
  onOpenResolver,
  refreshKey,
}: {
  onOpenResolver: () => void;
  refreshKey: number;
}) {
  const [runs, setRuns] = useState<LineOaResolverRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runSelectionTouched, setRunSelectionTouched] = useState(false);
  const [summary, setSummary] = useState<LineLinkValidationSummary | null>(null);
  const [busy, setBusy] = useState<"runs" | "summary" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const loadRuns = useCallback(async () => {
    setBusy("runs");
    setMessage(null);
    try {
      const payload = await jsonFetch<{ runs: LineOaResolverRun[] }>(
        "/api/line/contacts/oa-resolver/runs?limit=20",
      );
      setRuns(payload.runs);
      setSelectedRunId((current) => {
        if (current === null && runSelectionTouched) return null;
        if (current && payload.runs.some((run) => run.id === current)) return current;
        return payload.runs[0]?.id ?? null;
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load resolver runs");
    } finally {
      setBusy(null);
    }
  }, [runSelectionTouched]);

  const loadSummary = useCallback(async () => {
    setBusy("summary");
    setMessage(null);
    try {
      const params = new URLSearchParams();
      if (selectedRunId) params.set("runId", selectedRunId);
      const query = params.toString();
      const payload = await jsonFetch<{ summary: LineLinkValidationSummary }>(
        `/api/line/contacts/link-validation/summary${query ? `?${query}` : ""}`,
      );
      setSummary(payload.summary);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load validation tracker");
    } finally {
      setBusy(null);
    }
  }, [selectedRunId]);

  function refreshAll() {
    void Promise.all([loadRuns(), loadSummary()]);
  }

  useEffect(() => {
    void loadRuns();
  }, [loadRuns, refreshKey]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary, refreshKey]);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="shrink-0 border-b border-border bg-card/45 px-4 py-3 lg:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-base font-semibold text-foreground">
              <UserCheck className="size-4 text-primary" />
              Mapping Validation
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Assign suggested LINE account mappings, open LINE OA to check them, then verify or reject.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={refreshAll} disabled={Boolean(busy)}>
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
            <Button type="button" size="sm" onClick={onOpenResolver}>
              <ScanSearch />
              Run Bulk OA Resolver
            </Button>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Resolver run
            <select
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
              value={selectedRunId ?? ""}
              onChange={(event) => {
                setRunSelectionTouched(true);
                setSelectedRunId(event.target.value || null);
              }}
            >
              <option value="">All resolver runs</option>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {runLabel(run)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-end gap-2 text-xs text-muted-foreground">
            {selectedRun ? (
              <>
                <Badge variant={selectedRun.status === "active" ? "default" : "outline"}>{selectedRun.status}</Badge>
                <span>{selectedRun.totalRows} worklist rows</span>
                <span>{selectedRun.matchedRows + selectedRun.ambiguousRows} captured</span>
                <span>{selectedRun.committedRows} committed</span>
              </>
            ) : (
              <span>Showing validation links across every committed resolver run.</span>
            )}
          </div>
        </div>

        {message ? (
          <div className="mt-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground">
            {message}
          </div>
        ) : null}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 xl:grid-cols-[minmax(0,1fr)_420px] xl:overflow-hidden">
        <div className="flex min-h-0 flex-col gap-3">
          {summary?.canViewTracker ? (
            <LeadTracker summary={summary} />
          ) : (
            <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
              Your queue opens on <span className="font-medium text-foreground">My assignments</span>. Leads can see the cross-admin tracker here.
            </div>
          )}

          <LinkValidationPanel
            runId={selectedRunId}
            className="min-h-[480px] flex-1"
            onChanged={loadSummary}
            refreshKey={refreshKey}
          />
        </div>

        <aside className="min-h-0 overflow-y-auto rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <BarChart3 className="size-4 text-primary" />
            Validation Progress
          </div>
          {summary?.canViewTracker ? (
            <ProgressSidebar summary={summary} />
          ) : (
            <div className="mt-3 rounded-md border border-dashed border-border bg-background p-3 text-sm text-muted-foreground">
              Tracker access is limited to LINE validation leads.
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function LeadTracker({ summary }: { summary: LineLinkValidationSummary }) {
  return (
    <div className="grid gap-2 md:grid-cols-3 2xl:grid-cols-6">
      <StatCard label="Total links" value={summary.totals.total} />
      <StatCard label="Remaining" value={summary.totals.remaining} detail={`${summary.totals.unassigned} unassigned`} />
      <StatCard label="Assigned" value={summary.totals.assigned} />
      <StatCard label="Verified" value={summary.totals.verified} />
      <StatCard label="Rejected" value={summary.totals.rejected} />
      <StatCard label="Complete" value={`${summary.totals.completionRate}%`} />
    </div>
  );
}

function ProgressSidebar({ summary }: { summary: LineLinkValidationSummary }) {
  return (
    <div className="mt-3 space-y-3">
      <div className="space-y-2">
        {summary.reviewers.map((reviewer) => {
          const active = reviewer.remaining + reviewer.verified + reviewer.rejected > 0;
          return (
            <div
              key={reviewer.email}
              className={cn(
                "rounded-md border border-border bg-background p-2",
                !active && "opacity-60",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{reviewerName(reviewer)}</div>
                  <div className="truncate text-xs text-muted-foreground">{reviewer.email}</div>
                </div>
                <Badge variant={reviewer.remaining === 0 && active ? "default" : "outline"}>
                  {reviewer.completionRate}%
                </Badge>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[11px] text-muted-foreground">
                <div>
                  <div className="font-semibold text-foreground">{reviewer.remaining}</div>
                  left
                </div>
                <div>
                  <div className="font-semibold text-foreground">{reviewer.assigned}</div>
                  assigned
                </div>
                <div>
                  <div className="font-semibold text-foreground">{reviewer.verified}</div>
                  verified
                </div>
                <div>
                  <div className="font-semibold text-foreground">{reviewer.rejected}</div>
                  rejected
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-md border border-border bg-background p-2">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground">
          <Clock className="size-3.5 text-primary" />
          Recent activity
        </div>
        {summary.recentActivity.length === 0 ? (
          <div className="text-xs text-muted-foreground">No validations yet for this filter.</div>
        ) : (
          <div className="space-y-2">
            {summary.recentActivity.map((task) => (
              <div key={task.id} className="rounded-md border border-border bg-card px-2 py-1.5 text-xs">
                <div className="flex items-center gap-1.5">
                  {task.status === "verified" ? (
                    <ShieldCheck className="size-3.5 text-available" />
                  ) : (
                    <XCircle className="size-3.5 text-destructive" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                    {task.studentKey}
                  </span>
                  {task.status === "verified" ? (
                    <CheckCircle2 className="size-3.5 text-available" />
                  ) : null}
                </div>
                <div className="mt-0.5 truncate text-muted-foreground">
                  {task.reviewedByName || task.reviewedByEmail || "Unknown reviewer"}
                </div>
                <div className="truncate text-muted-foreground">
                  {task.reviewedAt ? formatDateTime(task.reviewedAt) : formatDateTime(task.updatedAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
