"use client";

import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, RefreshCw, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { PostClassFeedbackPayload } from "@/types/post-class-feedback";

import { EmptyPanel, KpiCell, formatMoney } from "./feedback-ui";

// ── Payout run ──────────────────────────────────────────────────────────
//
// Per-tutor review of a 26th-to-25th window, then one explicit publish. The
// per-deduction approve/waive decisions stay in the Deductions tab and stay
// individual; the only batch action here is the publish, and it acts solely on
// deductions a human already approved.

interface PayoutRunLine {
  id: string;
  canonicalTutorKey: string | null;
  tutorName: string | null;
  wiseSessionId: string;
  studentNames: string[];
  scheduledStartAt: string;
  deadlineAt: string;
  tutorSubmittedAt: string | null;
  amountMinor: number;
  reason: string;
  matchStatus: "pending" | "matched" | "unmatched" | "ambiguous" | "no_sheet";
  sheetName: string | null;
  matchedRowNumber: number | null;
  insertedRowNumber: number | null;
  writeStatus: "pending" | "written" | "failed" | "skipped";
  writeError: string | null;
}

interface PayoutRunCoverage {
  eligibleSessions: number;
  unavailableSessions: number;
  pendingReviewDeductions: number;
  approvedDeductions: number;
  unmappedTutorKeys: string[];
  nullTutorKeyLines: number;
  blockingGlobalSourceIssues: number;
}

interface PayoutRunView {
  run: { id: string; anchorMonth: string; status: string; version: number; csvUrl: string | null };
  window: { anchorMonth: string; windowStart: string; windowEnd: string };
  coverage: PayoutRunCoverage;
  lines: PayoutRunLine[];
  csvError: string | null;
  stoppedEarly: boolean;
}

function currentAnchorMonth(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = read("year");
  const month = read("month");
  // On or after the 26th the current month's run has closed, so the anchor
  // rolls forward — the same rule as `currentPayoutRunWindow`.
  if (read("day") >= 26) {
    return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

const WRITE_TONE: Record<PayoutRunLine["writeStatus"], string> = {
  written: "border-emerald-300 bg-emerald-50 text-emerald-800",
  failed: "border-red-300 bg-red-50 text-red-800",
  skipped: "border-amber-300 bg-amber-50 text-amber-900",
  pending: "border-sky-300 bg-sky-50 text-sky-800",
};

function BlockingBanner({ coverage, window }: { coverage: PayoutRunCoverage; window: PayoutRunView["window"] }) {
  const unreconciledRatio = coverage.eligibleSessions > 0
    ? coverage.unavailableSessions / coverage.eligibleSessions
    : 0;
  const problems: string[] = [];
  if (coverage.blockingGlobalSourceIssues > 0) {
    problems.push(`${coverage.blockingGlobalSourceIssues} open blocking source issue(s) — source health is unproven`);
  }
  if (unreconciledRatio > 0.02) {
    problems.push(`${coverage.unavailableSessions} of ${coverage.eligibleSessions} sessions in ${window.windowStart} – ${window.windowEnd} have no trustworthy Wise evidence, so this deduction list is incomplete`);
  }
  if (coverage.pendingReviewDeductions > 0) {
    problems.push(`${coverage.pendingReviewDeductions} deduction(s) still awaiting review`);
  }
  if (coverage.unmappedTutorKeys.length > 0) {
    problems.push(`No payout sheet mapped for: ${coverage.unmappedTutorKeys.join(", ")}`);
  }
  if (coverage.nullTutorKeyLines > 0) {
    problems.push(`${coverage.nullTutorKeyLines} deduction(s) have no resolved tutor`);
  }
  if (problems.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
      <div className="flex items-center gap-2 font-semibold">
        <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden="true" />
        Before publishing
      </div>
      <ul className="mt-2 list-disc space-y-1 pl-9">
        {problems.map((problem) => <li key={problem}>{problem}</li>)}
      </ul>
    </div>
  );
}

export function PayoutsTab({ payload }: { payload: PostClassFeedbackPayload }) {
  const [anchorMonth, setAnchorMonth] = useState(currentAnchorMonth);
  const [view, setView] = useState<PayoutRunView | null>(null);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch("/api/post-class-feedback/payout-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null) as (PayoutRunView & { error?: string }) | null;
    if (!response.ok) throw new Error(json?.error || "The payout run request failed.");
    return json as PayoutRunView;
  }, []);

  const preview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await call({ action: "preview", anchorMonth }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The preview failed.");
    } finally {
      setLoading(false);
    }
  }, [anchorMonth, call]);

  const publish = useCallback(async () => {
    if (!view) return;
    setPublishing(true);
    setError(null);
    try {
      setView(await call({
        action: "publish",
        anchorMonth,
        expectedVersion: view.run.version,
        // Echo the exact counts shown above, so acknowledging is a decision
        // about numbers the operator has actually seen.
        acknowledgements: {
          pendingReviewDeductions: view.coverage.pendingReviewDeductions,
          unavailableSessions: view.coverage.unavailableSessions,
        },
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The publish failed.");
    } finally {
      setPublishing(false);
    }
  }, [anchorMonth, call, view]);

  const byTutor = useMemo(() => {
    const groups = new Map<string, { name: string; lines: PayoutRunLine[] }>();
    for (const line of view?.lines ?? []) {
      // Keyed on identity, not display name.
      const key = line.canonicalTutorKey ?? `unresolved:${line.id}`;
      const group = groups.get(key) ?? { name: line.tutorName ?? "Tutor needs review", lines: [] };
      group.lines.push(line);
      groups.set(key, group);
    }
    return [...groups.entries()].toSorted(([, a], [, b]) => a.name.localeCompare(b.name));
  }, [view]);

  if (!payload.capabilities.finance) {
    return (
      <div className="rounded-xl border bg-card shadow-sm">
        <EmptyPanel title="Finance access required" detail="Publishing a payout run needs the finance capability." kind="paused" />
      </div>
    );
  }

  const written = view?.lines.filter((line) => line.writeStatus === "written").length ?? 0;
  const failed = view?.lines.filter((line) => line.writeStatus === "failed").length ?? 0;
  const skipped = view?.lines.filter((line) => line.writeStatus === "skipped").length ?? 0;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-4 shadow-sm">
        <label className="grid gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Payout month
          <Input
            type="month"
            className="w-40 bg-card"
            value={anchorMonth}
            onChange={(event) => setAnchorMonth(event.target.value)}
          />
        </label>
        <Button variant="outline" disabled={loading} onClick={() => void preview()}>
          <RefreshCw className={cn(loading && "animate-spin")} />
          {loading ? "Loading…" : "Load run"}
        </Button>
        {view ? (
          <>
            <Badge variant="outline" className="h-8 px-3">
              {view.window.windowStart} – {view.window.windowEnd}
            </Badge>
            <Badge
              variant="outline"
              className={cn("h-8 px-3 capitalize", view.run.status === "published"
                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                : "border-sky-300 bg-sky-50 text-sky-800")}
            >
              {view.run.status}
            </Badge>
            <Button
              className="ml-auto"
              disabled={publishing || view.lines.length === 0}
              onClick={() => void publish()}
            >
              <Send />
              {publishing ? "Publishing…" : "Publish to payout sheets"}
            </Button>
          </>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      ) : null}

      {view ? (
        <>
          <BlockingBanner coverage={view.coverage} window={view.window} />

          {view.stoppedEarly ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              The run stopped at its time budget with lines still pending. Press publish again to continue where it left off.
            </div>
          ) : null}
          {view.csvError ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              The sheets were written but the summary CSV upload failed: {view.csvError}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <KpiCell label="Approved" value={String(view.coverage.approvedDeductions)} />
            <KpiCell label="Total" value={formatMoney(view.lines.reduce((sum, line) => sum + line.amountMinor / 100, 0))} />
            <KpiCell label="Written" value={String(written)} />
            <KpiCell label="Failed" value={String(failed)} />
            <KpiCell label="Skipped" value={String(skipped)} />
          </div>

          {view.run.csvUrl ? (
            <a
              className="inline-flex w-fit items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-sm hover:bg-accent"
              href={view.run.csvUrl}
              target="_blank"
              rel="noreferrer"
            >
              <FileSpreadsheet className="size-4" />
              Summary CSV in Drive
            </a>
          ) : null}

          {byTutor.length === 0 ? (
            <div className="rounded-xl border bg-card shadow-sm">
              <EmptyPanel
                title="Nothing to publish"
                detail={`No approved deductions fall in ${view.window.windowStart} – ${view.window.windowEnd}.`}
                kind="empty"
              />
            </div>
          ) : byTutor.map(([key, group]) => (
            <section key={key} className="rounded-xl border bg-card shadow-sm">
              <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                <span className="font-semibold">{group.name}</span>
                <Badge variant="outline">{group.lines.length} deduction{group.lines.length === 1 ? "" : "s"}</Badge>
                <span className="text-sm text-muted-foreground">
                  {formatMoney(group.lines.reduce((sum, line) => sum + line.amountMinor / 100, 0))}
                </span>
                {group.lines.every((line) => line.writeStatus === "written") ? (
                  <CheckCircle2 className="ml-auto size-4 text-emerald-600" aria-label="All written" />
                ) : null}
              </header>
              <div className="divide-y">
                {group.lines.map((line) => (
                  <div key={line.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[1fr_auto]">
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {line.studentNames.join(", ") || "No student on record"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(line.scheduledStartAt).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false })}
                        {" · "}{line.reason}
                        {line.tutorSubmittedAt
                          ? ` · submitted ${new Date(line.tutorSubmittedAt).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false })}`
                          : " · no tutor submission observed"}
                      </div>
                      {line.writeError ? (
                        <div className="mt-1 text-xs text-amber-800">{line.writeError}</div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 justify-self-start sm:justify-self-end">
                      <span className="tabular-nums">{formatMoney(-line.amountMinor / 100)}</span>
                      <Badge variant="outline" className={cn("capitalize", WRITE_TONE[line.writeStatus])}>
                        {line.writeStatus}
                      </Badge>
                      {line.insertedRowNumber ? (
                        <span className="text-xs text-muted-foreground">
                          {line.sheetName}!{line.insertedRowNumber}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </>
      ) : (
        <div className="rounded-xl border bg-card shadow-sm">
          <EmptyPanel
            title="No payout run loaded"
            detail="Choose a payout month and load the run to review its deductions per tutor."
            kind="empty"
          />
        </div>
      )}
    </div>
  );
}
