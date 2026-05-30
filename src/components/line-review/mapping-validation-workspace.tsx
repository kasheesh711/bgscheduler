"use client";

import type { ReactNode } from "react";
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
  Users,
  X,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LinkValidationPanel } from "./link-validation-panel";
import type {
  LineLinkValidationReviewerSummary,
  LineLinkValidationScope,
  LineLinkValidationSummary,
  LineOaResolverRun,
} from "./types";
import { formatDateTime, jsonFetch } from "./utils";

export const MAPPING_VALIDATION_LEAD_DEFAULT_SCOPE = "all";
export const MAPPING_VALIDATION_ADMIN_DEFAULT_SCOPE = "my";

function reviewerName(reviewer: LineLinkValidationReviewerSummary): string {
  return reviewer.name || reviewer.email;
}

function runLabel(run: LineOaResolverRun): string {
  return `${run.id.slice(0, 8)} / ${run.status} / ${formatDateTime(run.createdAt)}`;
}

export function MappingValidationWorkspace({
  onOpenResolver,
  refreshKey,
  workspaceTabs,
}: {
  onOpenResolver: () => void;
  refreshKey: number;
  workspaceTabs: ReactNode;
}) {
  const [runs, setRuns] = useState<LineOaResolverRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runSelectionTouched, setRunSelectionTouched] = useState(false);
  const [summary, setSummary] = useState<LineLinkValidationSummary | null>(null);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [busy, setBusy] = useState<"runs" | "summary" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const canViewTracker = summary?.canViewTracker === true;
  const defaultValidationScope = useMemo<LineLinkValidationScope>(
    () => (canViewTracker ? MAPPING_VALIDATION_LEAD_DEFAULT_SCOPE : MAPPING_VALIDATION_ADMIN_DEFAULT_SCOPE),
    [canViewTracker],
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
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="shrink-0 border-b border-border bg-card px-4 py-2 lg:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {workspaceTabs}
            <div className="hidden h-7 border-l border-border lg:block" />
            <div className="flex min-w-0 items-center gap-2 text-base font-semibold text-foreground">
              <UserCheck className="size-4 text-primary" />
              <span className="truncate">Mapping Validation</span>
            </div>
            <CompactSummary summary={summary} />
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <select
              aria-label="Resolver run"
              className="h-8 max-w-[310px] rounded-lg border border-input bg-background px-2 text-sm text-foreground"
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
            <RunMeta run={selectedRun} />
            <Button type="button" size="sm" variant="outline" onClick={() => setAssignmentOpen((open) => !open)}>
              <Users />
              Assign work
            </Button>
            {canViewTracker ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setProgressOpen(true)}>
                <BarChart3 />
                Progress
              </Button>
            ) : null}
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

        {message ? (
          <div className="mt-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground">
            {message}
          </div>
        ) : null}
      </div>

      <LinkValidationPanel
        runId={selectedRunId}
        className="min-h-0 flex-1 rounded-none border-0"
        onChanged={loadSummary}
        refreshKey={refreshKey}
        defaultScope={defaultValidationScope}
        assignmentOpen={assignmentOpen}
        onAssignmentOpenChange={setAssignmentOpen}
      />

      {canViewTracker && progressOpen ? (
        <div className="absolute inset-y-0 right-0 z-30 flex w-full justify-end bg-background/25 backdrop-blur-[1px]">
          <aside className="h-full w-[min(460px,calc(100vw-1rem))] border-l border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <BarChart3 className="size-4 text-primary" />
                Validation Progress
              </div>
              <Button type="button" size="icon" variant="ghost" onClick={() => setProgressOpen(false)}>
                <X />
                <span className="sr-only">Close progress</span>
              </Button>
            </div>
            <div className="h-[calc(100%-45px)] overflow-y-auto p-3">
              <ProgressSidebar summary={summary} />
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}

function CompactSummary({ summary }: { summary: LineLinkValidationSummary | null }) {
  if (!summary?.canViewTracker) {
    return (
      <span className="text-xs text-muted-foreground">
        Verify LINE account to student-code mappings.
      </span>
    );
  }

  const items = [
    ["Total", summary.totals.total],
    ["Remaining", summary.totals.remaining],
    ["Assigned", summary.totals.assigned],
    ["Verified", summary.totals.verified],
    ["Rejected", summary.totals.rejected],
    ["Complete", `${summary.totals.completionRate}%`],
  ];

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {items.map(([label, value]) => (
        <span key={label} className="rounded-md border border-border bg-background px-2 py-1">
          <span className="text-foreground">{value}</span> {label}
        </span>
      ))}
      {summary.totals.unassigned > 0 ? (
        <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300">
          {summary.totals.unassigned} unassigned
        </span>
      ) : null}
    </div>
  );
}

function RunMeta({ run }: { run: LineOaResolverRun | null }) {
  if (!run) {
    return <span className="hidden text-xs text-muted-foreground xl:inline">All runs</span>;
  }

  return (
    <div className="hidden items-center gap-1.5 text-xs text-muted-foreground 2xl:flex">
      <Badge variant={run.status === "active" ? "default" : "outline"}>{run.status}</Badge>
      <span>{run.totalRows} rows</span>
      <span>{run.matchedRows + run.ambiguousRows} captured</span>
      <span>{run.committedRows} committed</span>
    </div>
  );
}

function ProgressSidebar({ summary }: { summary: LineLinkValidationSummary }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <ProgressTotal label="Remaining" value={summary.totals.remaining} />
        <ProgressTotal label="Verified" value={summary.totals.verified} />
        <ProgressTotal label="Complete" value={`${summary.totals.completionRate}%`} />
      </div>

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

function ProgressTotal({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border bg-background px-2 py-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}
