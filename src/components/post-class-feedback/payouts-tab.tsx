"use client";

import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldOff,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { PostClassFeedbackPayload } from "@/types/post-class-feedback";

import { EmptyPanel, KpiCell, formatMoney } from "./feedback-ui";

type PayoutRunStatus = "draft" | "publishing" | "partial" | "published" | "closed";
type PayoutWriteStatus = "pending" | "written" | "failed" | "skipped";

interface PayoutRunLine {
  id: string;
  kind?: "deduction" | "correction";
  lineKind?: "deduction" | "correction";
  deductionId?: string;
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
  masterRowNumber?: number | null;
  insertedRowNumber?: number | null;
  sheetRowNumber?: number | null;
  writeStatus: PayoutWriteStatus;
  writeError: string | null;
}

export interface PayoutRunCoverage {
  eligibleSessions: number;
  readySessions?: number;
  nonReadySessions?: number;
  unavailableSessions?: number;
  formDriftSessions?: number;
  identityReviewSessions?: number;
  pendingReviewDeductions: number;
  unprovenApprovedDeductions?: number;
  approvedDeductions: number;
  unmappedTutorKeys: string[];
  nullTutorKeyLines: number;
  blockingGlobalSourceIssues: number;
}

interface PayoutRunException {
  id: string;
  kind: string;
  status: "open" | "resolved";
  message?: string;
  reason?: string;
  deductionId?: string | null;
  adjustmentId?: string | null;
  tutorName?: string | null;
  version?: number;
  resolutionNote?: string | null;
  resolutionReference?: string | null;
  externalReference?: string | null;
}

interface PayoutAdjustment {
  id: string;
  deductionId: string;
  sourceLineId: string | null;
  kind: "waiver" | "reversal";
  status: "pending" | "written" | "failed" | "exception" | "superseded";
  amountMinor: number;
  currency: string;
  reason: string;
  sheetRowNumber: number | null;
  writeError: string | null;
}

export interface PayoutRunView {
  run: {
    id: string;
    anchorMonth: string;
    status: PayoutRunStatus;
    version: number;
    csvUrl: string | null;
    csvStatus?: "pending" | "uploaded" | "failed";
    leaseExpiresAt?: string | null;
    previewToken?: string | null;
  } | null;
  window: {
    anchorMonth: string;
    windowStart: string;
    windowEnd: string;
    closed?: boolean;
  };
  coverage: PayoutRunCoverage;
  lines: PayoutRunLine[];
  adjustments?: PayoutAdjustment[];
  exceptions?: PayoutRunException[];
  policyVersion?: number;
  previewToken?: string | null;
  csvError: string | null;
  stoppedEarly: boolean;
  writeCapability: {
    enabled: boolean;
    target?: "scratch" | "production" | null;
    reason: string | null;
  };
}

interface TutorOption {
  key: string;
  name: string;
}

interface ExceptionDraft {
  note: string;
  externalReference: string;
}

const MIN_PUBLISH_REASON_LENGTH = 10;

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
  if (read("day") >= 26) {
    return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

const WRITE_TONE: Record<PayoutWriteStatus, string> = {
  written: "border-emerald-300 bg-emerald-50 text-emerald-800",
  failed: "border-red-300 bg-red-50 text-red-800",
  skipped: "border-amber-300 bg-amber-50 text-amber-900",
  pending: "border-sky-300 bg-sky-50 text-sky-800",
};

const RUN_TONE: Record<PayoutRunStatus, string> = {
  draft: "border-sky-300 bg-sky-50 text-sky-800",
  publishing: "border-blue-300 bg-blue-50 text-blue-800",
  partial: "border-amber-300 bg-amber-50 text-amber-900",
  published: "border-emerald-300 bg-emerald-50 text-emerald-800",
  closed: "border-slate-300 bg-slate-50 text-slate-800",
};

export function payoutNonReadySessionCount(coverage: PayoutRunCoverage): number {
  if (coverage.nonReadySessions !== undefined) return coverage.nonReadySessions;
  return (coverage.unavailableSessions ?? 0)
    + (coverage.formDriftSessions ?? 0)
    + (coverage.identityReviewSessions ?? 0);
}

export function payoutPreviewToken(view: PayoutRunView): string | null {
  return view.previewToken ?? view.run?.previewToken ?? null;
}

/** A crashed CSV retry is recoverable only once its durable lease expires. */
export function payoutCsvRetryAvailable(
  view: PayoutRunView,
  now = Date.now(),
): boolean {
  if (view.run?.csvStatus === "failed") return true;
  if (view.run?.csvStatus !== "pending"
    || (view.run.status !== "partial" && view.run.status !== "published")) {
    return false;
  }
  if (!view.run.leaseExpiresAt) return true;
  const expiry = Date.parse(view.run.leaseExpiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

export function payoutRunHasLiveOperationLease(
  view: PayoutRunView,
  now = Date.now(),
): boolean {
  if (!view.run?.leaseExpiresAt) return view.run?.status === "publishing";
  const expiry = Date.parse(view.run.leaseExpiresAt);
  return !Number.isFinite(expiry) || expiry > now;
}

export function buildPayoutPublishBody(input: {
  view: PayoutRunView;
  anchorMonth: string;
  tutorFilter: string | null;
  reason: string;
}): Record<string, unknown> {
  const previewToken = payoutPreviewToken(input.view);
  if (!previewToken) throw new Error("Reload the preview before publishing.");
  const expectedVersion = input.view.run?.version;
  if (!expectedVersion || expectedVersion < 1) {
    throw new Error("Reload the preview before publishing.");
  }
  const reason = input.reason.trim();
  if (reason.length < MIN_PUBLISH_REASON_LENGTH) {
    throw new Error(`Enter a publish reason of at least ${MIN_PUBLISH_REASON_LENGTH} characters.`);
  }
  return {
    action: "publish",
    anchorMonth: input.anchorMonth,
    expectedVersion,
    previewToken,
    ...(input.tutorFilter ? { tutorFilter: input.tutorFilter } : {}),
    acknowledgements: {
      confirmed: true,
      reason,
      pendingReviewDeductions: input.view.coverage.pendingReviewDeductions,
      nonReadySessions: payoutNonReadySessionCount(input.view.coverage),
    },
  };
}

function BlockingBanner({
  coverage,
  window,
}: {
  coverage: PayoutRunCoverage;
  window: PayoutRunView["window"];
}) {
  const nonReadySessions = payoutNonReadySessionCount(coverage);
  const unreconciledRatio = coverage.eligibleSessions > 0
    ? nonReadySessions / coverage.eligibleSessions
    : 0;
  const problems: string[] = [];
  if (coverage.blockingGlobalSourceIssues > 0) {
    problems.push(`${coverage.blockingGlobalSourceIssues} open blocking source issue(s) — source health is unproven`);
  }
  if ((coverage.unprovenApprovedDeductions ?? 0) > 0) {
    problems.push(
      `${coverage.unprovenApprovedDeductions} approved deduction(s) no longer have proven eligible, source-ready evidence and cannot be published`,
    );
  }
  if (unreconciledRatio > 0.02) {
    problems.push(`${nonReadySessions} of ${coverage.eligibleSessions} sessions in ${window.windowStart} – ${window.windowEnd} are not source-ready, so the deduction list is incomplete`);
  }
  if (coverage.pendingReviewDeductions > 0) {
    problems.push(`${coverage.pendingReviewDeductions} deduction(s) still await review`);
  }
  if (coverage.unmappedTutorKeys.length > 0) {
    problems.push(`No exact master-ledger identity is mapped for: ${coverage.unmappedTutorKeys.join(", ")}`);
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

function lineAmount(line: PayoutRunLine): number {
  if (line.kind === "correction" || line.lineKind === "correction") {
    return Math.abs(line.amountMinor) / 100;
  }
  return line.amountMinor < 0 ? line.amountMinor / 100 : -line.amountMinor / 100;
}

export function payoutLineRowNumber(
  line: Pick<PayoutRunLine, "masterRowNumber" | "insertedRowNumber" | "sheetRowNumber">,
): number | null {
  return line.masterRowNumber ?? line.insertedRowNumber ?? line.sheetRowNumber ?? null;
}

export function PayoutsTab({ payload }: { payload: PostClassFeedbackPayload }) {
  const [anchorMonth, setAnchorMonth] = useState(currentAnchorMonth);
  const [tutorFilter, setTutorFilter] = useState<string | null>(null);
  const [tutorOptions, setTutorOptions] = useState<TutorOption[]>([]);
  const [view, setView] = useState<PayoutRunView | null>(null);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [retryingCsv, setRetryingCsv] = useState(false);
  const [resolvingExceptionId, setResolvingExceptionId] = useState<string | null>(null);
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [publishReason, setPublishReason] = useState("");
  const [exceptionDrafts, setExceptionDrafts] = useState<Record<string, ExceptionDraft>>({});
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

  const resetConfirmation = useCallback(() => {
    setConfirmingPublish(false);
    setPublishConfirmed(false);
    setPublishReason("");
  }, []);

  const preview = useCallback(async () => {
    setLoading(true);
    setError(null);
    resetConfirmation();
    try {
      const next = await call({
        action: "preview",
        anchorMonth,
        ...(tutorFilter ? { tutorFilter } : {}),
      });
      setView(next);
      if (!tutorFilter) {
        const options = new Map<string, string>();
        for (const line of next.lines) {
          if (line.canonicalTutorKey) {
            options.set(line.canonicalTutorKey, line.tutorName ?? line.canonicalTutorKey);
          }
        }
        setTutorOptions(
          [...options].map(([key, name]) => ({ key, name }))
            .toSorted((a, b) => a.name.localeCompare(b.name)),
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The preview failed.");
    } finally {
      setLoading(false);
    }
  }, [anchorMonth, call, resetConfirmation, tutorFilter]);

  const publish = useCallback(async () => {
    if (!view) return;
    setPublishing(true);
    setError(null);
    try {
      const body = buildPayoutPublishBody({
        view,
        anchorMonth,
        tutorFilter,
        reason: publishReason,
      });
      setView(await call(body));
      resetConfirmation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The publish failed.");
    } finally {
      setPublishing(false);
    }
  }, [anchorMonth, call, publishReason, resetConfirmation, tutorFilter, view]);

  const retryCsv = useCallback(async () => {
    if (!view) return;
    setRetryingCsv(true);
    setError(null);
    try {
      setView(await call({
        action: "retry_csv",
        anchorMonth,
        expectedVersion: view.run?.version ?? 0,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The CSV upload retry failed.");
    } finally {
      setRetryingCsv(false);
    }
  }, [anchorMonth, call, view]);

  const resolveException = useCallback(async (exception: PayoutRunException) => {
    const draft = exceptionDrafts[exception.id] ?? { note: "", externalReference: "" };
    if (draft.note.trim().length < MIN_PUBLISH_REASON_LENGTH || !draft.externalReference.trim()) {
      setError("Exception resolution needs a note of at least 10 characters and an external reference.");
      return;
    }
    setResolvingExceptionId(exception.id);
    setError(null);
    try {
      await call({
        action: "resolve_exception",
        exceptionId: exception.id,
        expectedVersion: exception.version ?? view?.run?.version ?? 0,
        note: draft.note.trim(),
        externalReference: draft.externalReference.trim(),
      });
      setView(await call({
        action: "preview",
        anchorMonth,
        ...(tutorFilter ? { tutorFilter } : {}),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The exception could not be resolved.");
    } finally {
      setResolvingExceptionId(null);
    }
  }, [anchorMonth, call, exceptionDrafts, tutorFilter, view?.run?.version]);

  const byTutor = useMemo(() => {
    const groups = new Map<string, { name: string; lines: PayoutRunLine[] }>();
    for (const line of view?.lines ?? []) {
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

  const adjustments = view?.adjustments ?? [];
  const written = view?.lines.filter((line) => line.writeStatus === "written").length ?? 0;
  const failed = (view?.lines.filter((line) => line.writeStatus === "failed").length ?? 0)
    + adjustments.filter((adjustment) => adjustment.status === "failed").length;
  const skipped = view?.lines.filter((line) => line.writeStatus === "skipped").length ?? 0;
  const openExceptions = view?.exceptions?.filter((exception) => exception.status === "open") ?? [];
  const googleReady = Boolean(payload.payoutGoogle?.sheetsWriteReady && payload.payoutGoogle.driveReady);
  const writeEnabled = Boolean(view?.writeCapability.enabled);
  const publishBlocked = !view
    || !writeEnabled
    || !googleReady
    || payoutRunHasLiveOperationLease(view)
    || view.run?.status === "closed"
    || view.coverage.blockingGlobalSourceIssues > 0
    || (view.coverage.unprovenApprovedDeductions ?? 0) > 0
    || !payoutPreviewToken(view);
  const confirmReady = publishConfirmed
    && publishReason.trim().length >= MIN_PUBLISH_REASON_LENGTH;
  const csvRetryAvailable = view ? payoutCsvRetryAvailable(view) : false;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-4 shadow-sm">
        <label className="grid gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Payout month
          <Input
            type="month"
            className="w-40 bg-card"
            value={anchorMonth}
            onChange={(event) => {
              setAnchorMonth(event.target.value);
              setView(null);
              resetConfirmation();
            }}
          />
        </label>
        <label className="grid gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Canary tutor
          <select
            className="h-8 min-w-52 rounded-lg border border-input bg-card px-2 text-sm"
            value={tutorFilter ?? ""}
            onChange={(event) => {
              setTutorFilter(event.target.value || null);
              setView(null);
              resetConfirmation();
            }}
          >
            <option value="">All approved tutors</option>
            {tutorOptions.map((tutor) => (
              <option key={tutor.key} value={tutor.key}>{tutor.name} · {tutor.key}</option>
            ))}
          </select>
        </label>
        <Button variant="outline" disabled={loading} onClick={() => void preview()}>
          <RefreshCw className={cn(loading && "animate-spin")} />
          {loading ? "Loading…" : "Load preview"}
        </Button>
        {view ? (
          <>
            <Badge variant="outline" className="h-8 px-3">
              {view.window.windowStart} – {view.window.windowEnd}
            </Badge>
            <Badge variant="outline" className={cn(
              "h-8 px-3 capitalize",
              RUN_TONE[view.run?.status ?? "draft"],
            )}>
              {view.run?.status ?? "draft"}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "h-8 px-3 capitalize",
                view.writeCapability.target === "production"
                  ? "border-red-300 bg-red-50 text-red-800"
                  : "border-violet-300 bg-violet-50 text-violet-800",
              )}
            >
              {view.writeCapability.target ?? "unconfigured"} target
            </Badge>
            <Button
              className="ml-auto"
              disabled={publishing || publishBlocked}
              onClick={() => setConfirmingPublish(true)}
            >
              <Send />
              Review publish
            </Button>
          </>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</div>
      ) : null}

      {view && !view.writeCapability.enabled ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <ShieldOff className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-semibold">Payout writes are disabled</div>
            <p>{view.writeCapability.reason ?? "Set POST_CLASS_PAYOUT_WRITES_ENABLED=true only for the approved production write window."}</p>
          </div>
        </div>
      ) : null}

      {view && !googleReady ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          The pinned payout account needs both Google Sheets write and Drive file access. Use Reconnect Google before publishing.
        </div>
      ) : null}

      {view ? (
        <>
          <BlockingBanner coverage={view.coverage} window={view.window} />

          {confirmingPublish ? (
            <section className="grid gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
              <div>
                <h3 className="font-semibold">
                  Confirm {tutorFilter ? "canary" : "full"} publish to Feedback Deductions
                  {" · "}{view.writeCapability.target ?? "unconfigured"} target
                </h3>
                <p className="mt-1 text-blue-900">
                  This publishes the exact preview token for version {view.run?.version ?? 0}.
                  {" "}Policy version {view.policyVersion ?? "unknown"}; coverage is
                  {" "}{view.coverage.readySessions ?? 0}/{view.coverage.eligibleSessions} ready,
                  {" "}{payoutNonReadySessionCount(view.coverage)} non-ready, and
                  {" "}{view.coverage.pendingReviewDeductions} pending review.
                  {tutorFilter ? ` Only canonical tutor ${tutorFilter} is included; the overall run remains partial while other required lines remain.` : ""}
                </p>
              </div>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={publishConfirmed}
                  onChange={(event) => setPublishConfirmed(event.target.checked)}
                />
                <span>
                  I checked this preview, its source-coverage exceptions, the exact tutor scope, and the dedicated
                  <strong> Feedback Deductions</strong> tab on the
                  <strong> {view.writeCapability.target ?? "unconfigured"}</strong> target.
                </span>
              </label>
              <label className="grid gap-1 font-medium">
                Publish reason
                <Textarea
                  value={publishReason}
                  onChange={(event) => setPublishReason(event.target.value)}
                  placeholder="Why this run is safe to publish, including any acknowledged exceptions…"
                />
                <span className="text-xs font-normal text-blue-800">
                  Required and audited; minimum {MIN_PUBLISH_REASON_LENGTH} characters.
                </span>
              </label>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={resetConfirmation}>Cancel</Button>
                <Button
                  disabled={publishing || !confirmReady || publishBlocked}
                  onClick={() => void publish()}
                >
                  <Send />
                  {publishing ? "Publishing…" : "Confirm publish"}
                </Button>
              </div>
            </section>
          ) : null}

          {view.stoppedEarly ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              The run stopped at its time budget with lines still pending. Load a fresh preview before continuing.
            </div>
          ) : null}
          {view.csvError || csvRetryAvailable ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <span className="mr-auto">
                {view.csvError
                  ? <>Ledger rows are already durable, but the summary CSV upload failed: {view.csvError}</>
                  : <>A prior CSV retry lease expired before its outcome was saved. Re-run the CSV-only step.</>}
              </span>
              <Button
                variant="outline"
                disabled={retryingCsv || !writeEnabled || !googleReady}
                onClick={() => void retryCsv()}
              >
                <RotateCcw className={cn(retryingCsv && "animate-spin")} />
                {retryingCsv ? "Retrying…" : "Retry CSV only"}
              </Button>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <KpiCell label="Approved" value={String(view.coverage.approvedDeductions)} />
            <KpiCell
              label="Net change"
              value={formatMoney(
                view.lines.reduce((sum, line) => sum + lineAmount(line), 0)
                + adjustments.reduce((sum, adjustment) => sum + adjustment.amountMinor / 100, 0),
              )}
            />
            <KpiCell label="Written" value={String(written)} />
            <KpiCell label="Failed" value={String(failed)} />
            <KpiCell label="Skipped" value={String(skipped)} />
          </div>

          {view.run?.csvUrl ? (
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

          {openExceptions.length > 0 ? (
            <section className="rounded-xl border bg-card shadow-sm">
              <header className="flex items-center gap-2 border-b px-4 py-3">
                <Wrench className="size-4 text-amber-600" />
                <h3 className="font-semibold">Post-close exceptions</h3>
                <Badge variant="outline">{openExceptions.length} open</Badge>
              </header>
              <div className="divide-y">
                {openExceptions.map((exception) => {
                  const draft = exceptionDrafts[exception.id] ?? { note: "", externalReference: "" };
                  return (
                    <div key={exception.id} className="grid gap-3 p-4">
                      <div>
                        <Badge variant="outline" className="capitalize">{exception.kind.replaceAll("_", " ")}</Badge>
                        <span className="ml-2 font-medium">
                          {exception.tutorName
                            ?? view.lines.find((line) => line.deductionId === exception.deductionId)?.tutorName
                            ?? "Payout exception"}
                        </span>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {exception.message ?? exception.reason ?? "Finance review is required."}
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="grid gap-1 text-sm font-medium">
                          Resolution note
                          <Textarea
                            value={draft.note}
                            onChange={(event) => setExceptionDrafts((current) => ({
                              ...current,
                              [exception.id]: { ...draft, note: event.target.value },
                            }))}
                            placeholder="Explain the reviewed correction…"
                          />
                        </label>
                        <label className="grid content-start gap-1 text-sm font-medium">
                          External reference
                          <Input
                            value={draft.externalReference}
                            onChange={(event) => setExceptionDrafts((current) => ({
                              ...current,
                              [exception.id]: { ...draft, externalReference: event.target.value },
                            }))}
                            placeholder="Ticket, ledger row, or approval reference"
                          />
                        </label>
                      </div>
                      <Button
                        className="justify-self-end"
                        variant="outline"
                        disabled={resolvingExceptionId === exception.id}
                        onClick={() => void resolveException(exception)}
                      >
                        {resolvingExceptionId === exception.id ? "Resolving…" : "Resolve exception"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {adjustments.length > 0 ? (
            <section className="rounded-xl border bg-card shadow-sm">
              <header className="flex items-center gap-2 border-b px-4 py-3">
                <RotateCcw className="size-4 text-blue-600" />
                <h3 className="font-semibold">Compensating corrections</h3>
                <Badge variant="outline">{adjustments.length}</Badge>
              </header>
              <div className="divide-y">
                {adjustments.map((adjustment) => (
                  <div key={adjustment.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[1fr_auto]">
                    <div>
                      <div className="font-medium capitalize">{adjustment.kind} correction</div>
                      <div className="text-xs text-muted-foreground">{adjustment.reason}</div>
                      {adjustment.writeError ? (
                        <div className="mt-1 text-xs text-amber-800">{adjustment.writeError}</div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 justify-self-start sm:justify-self-end">
                      <span className="tabular-nums">{formatMoney(adjustment.amountMinor / 100)}</span>
                      <Badge variant="outline" className="capitalize">{adjustment.status}</Badge>
                      {adjustment.sheetRowNumber ? (
                        <span className="text-xs text-muted-foreground">
                          Deductions tab row {adjustment.sheetRowNumber}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
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
                <Badge variant="outline">{group.lines.length} line{group.lines.length === 1 ? "" : "s"}</Badge>
                <span className="text-sm text-muted-foreground">
                  {formatMoney(group.lines.reduce((sum, line) => sum + lineAmount(line), 0))}
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
                        {" · "}{line.kind === "correction" || line.lineKind === "correction"
                          ? "Correction"
                          : line.reason}
                        {line.tutorSubmittedAt
                          ? ` · submitted ${new Date(line.tutorSubmittedAt).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false })}`
                          : " · no tutor submission observed"}
                      </div>
                      {line.writeError ? (
                        <div className="mt-1 text-xs text-amber-800">{line.writeError}</div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 justify-self-start sm:justify-self-end">
                      <span className="tabular-nums">{formatMoney(lineAmount(line))}</span>
                      <Badge variant="outline" className={cn("capitalize", WRITE_TONE[line.writeStatus])}>
                        {line.writeStatus}
                      </Badge>
                      {payoutLineRowNumber(line) ? (
                        <span className="text-xs text-muted-foreground">
                          Deductions tab row {payoutLineRowNumber(line)}
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
            detail="Choose a payout month and load a read-only preview. Publishing always requires a fresh token and an explicit confirmation."
            kind="empty"
          />
        </div>
      )}
    </div>
  );
}
