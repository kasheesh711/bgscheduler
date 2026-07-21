"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  Check,
  ExternalLink,
  FileClock,
  History,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  FeedbackCapabilities,
  FeedbackMutationRequest,
  FeedbackQuestionAnswer,
  FeedbackSessionDetailVersion,
  FeedbackSessionRow,
  FeedbackSourceAnswer,
  FeedbackWaiverCategory,
  PostClassFeedbackSessionDetail,
} from "@/types/post-class-feedback";
import {
  EligibilityBadge,
  EmptyPanel,
  OutcomeBadge,
  SourceBadge,
  formatBangkokDate,
  formatEligibilityReason,
} from "./feedback-ui";

const WAIVER_CATEGORIES: Array<{ value: FeedbackWaiverCategory; label: string }> = [
  { value: "wise_system_outage", label: "Wise / system outage" },
  { value: "incorrect_session_tutor_data", label: "Incorrect session or tutor data" },
  { value: "pre_approved_exception", label: "Pre-approved exception" },
  { value: "tutor_emergency", label: "Tutor emergency" },
  { value: "duplicate_system_error", label: "Duplicate / system error" },
  { value: "other", label: "Other" },
];

type ReviewDialogState =
  | { kind: "review"; action: "approve" | "waive" | "reopen" }
  | {
    kind: "ai";
    action: "confirm" | "dismiss";
    concernId: string;
    expectedVersion: number;
  }
  | null;

export function exactWiseAnswerText(answer: FeedbackSourceAnswer): string {
  if (typeof answer.rawAnswer === "string") return answer.rawAnswer;
  if (answer.rawAnswer !== null && answer.rawAnswer !== undefined) {
    try {
      return JSON.stringify(answer.rawAnswer, null, 2);
    } catch {
      return answer.text;
    }
  }
  return answer.text;
}

function AnswerRow({ label, answer }: { label: string; answer: FeedbackQuestionAnswer }) {
  return (
    <div className="border-b px-3 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <span className={cn(
            "flex size-4 items-center justify-center rounded-full",
            answer.meaningful ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700",
          )}>
            {answer.meaningful ? <Check className="size-3" /> : <X className="size-3" />}
          </span>
          {label}
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">{answer.characters} characters</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/85">
        {answer.text || <span className="italic text-muted-foreground">No answer observed.</span>}
      </p>
    </div>
  );
}

function ExactAnswer({ answer, index }: { answer: FeedbackSourceAnswer; index: number }) {
  const text = exactWiseAnswerText(answer);
  return (
    <div className="rounded-lg border bg-background/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold">{answer.questionText || `Wise question ${index + 1}`}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
            <span>question ID: {answer.questionId || "not supplied"}</span>
            <span>answer ID: {answer.id || "not supplied"}</span>
            {answer.type ? <span>type: {answer.type}</span> : null}
          </div>
        </div>
        <Badge variant="outline">Exact Wise answer</Badge>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">
        {text || <span className="italic text-muted-foreground">Blank answer</span>}
      </p>
    </div>
  );
}

function EvidenceMetadata({ version }: { version: FeedbackSessionDetailVersion }) {
  return (
    <div className="grid overflow-hidden rounded-lg border bg-card sm:grid-cols-2 xl:grid-cols-4">
      <div className="border-b p-3 sm:border-r xl:border-b-0">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Submission</div>
        <div className="mt-1 break-all font-mono text-xs">{version.submissionId || "Not supplied by Wise"}</div>
      </div>
      <div className="border-b p-3 xl:border-r xl:border-b-0">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Source timestamp</div>
        <div className="mt-1 text-xs font-medium">{formatBangkokDate(version.submittedAt, true)}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          {version.sourceTimestampTrustworthy ? `Trustworthy ${version.sourceTimestampKind} time` : "Untrusted — timing benefit of doubt"}
        </div>
      </div>
      <div className="border-b p-3 sm:border-r sm:border-b-0">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Observed</div>
        <div className="mt-1 text-xs font-medium">{formatBangkokDate(version.observedAt, true)}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">Immutable local observation</div>
      </div>
      <div className="p-3">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Provenance / actor</div>
        <div className="mt-1 text-xs font-medium capitalize">{version.provenance}</div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {version.actorName || version.actorWiseUserId || "Actor not provable"} · profile {version.profile}
        </div>
      </div>
      <div className="border-t p-3 sm:col-span-2 xl:col-span-4">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Content hash</div>
        <div className="mt-1 break-all font-mono text-[11px]">{version.contentHash}</div>
      </div>
    </div>
  );
}

function DetailLoading() {
  return (
    <div className="flex min-h-80 items-center justify-center" aria-live="polite" aria-busy="true">
      <div className="text-center text-sm text-muted-foreground">
        <LoaderCircle className="mx-auto mb-3 size-6 animate-spin text-sky-600" aria-hidden="true" />
        Loading exact Wise evidence…
      </div>
    </div>
  );
}

function DetailBody({
  detail,
  session,
  selectedVersionId,
  onSelectVersion,
  onAiReview,
  canReview,
  submitting,
}: {
  detail: PostClassFeedbackSessionDetail;
  session: FeedbackSessionRow;
  selectedVersionId: string | null;
  onSelectVersion: (id: string | null) => void;
  onAiReview: (input: { concernId: string; expectedVersion: number; action: "confirm" | "dismiss" }) => void;
  canReview: boolean;
  submitting: boolean;
}) {
  const versions = detail.evidence.versions;
  const selectedVersion = selectedVersionId
    ? versions.find((version) => version.id === selectedVersionId) ?? null
    : null;
  const currentProjectionMissing = detail.session.latestFeedbackVersionId === null;

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-muted/15 p-3 sm:p-4">
      <div className="grid overflow-hidden rounded-lg border bg-card sm:grid-cols-2 xl:grid-cols-4">
        <div className="border-b p-3 sm:border-r xl:border-b-0">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Eligibility</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <EligibilityBadge eligible={detail.session.eligible} reason={detail.session.eligibilityReason} />
            <span className="text-[11px] text-muted-foreground">{formatEligibilityReason(detail.session.eligibilityReason)}</span>
          </div>
        </div>
        <div className="border-b p-3 xl:border-r xl:border-b-0">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Source</div>
          <div className="mt-1"><SourceBadge status={detail.session.sourceStatus} /></div>
        </div>
        <div className="border-b p-3 sm:border-r sm:border-b-0">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Billing evidence</div>
          <div className="mt-1 text-xs font-medium tabular-nums">{detail.session.creditsConsumed.toLocaleString()} credits</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{detail.session.payableEligible ? "Tutor payout-eligible" : "No payout eligibility observed"}</div>
        </div>
        <div className="p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Deadline</div>
          <div className="mt-1 text-xs font-medium">{formatBangkokDate(detail.session.deadlineAt, true)}</div>
        </div>
      </div>

      {!detail.session.eligible ? (
        <div className={cn(
          "flex gap-2 rounded-lg border p-3 text-xs",
          detail.session.eligibilityReason === "billing_evidence_missing"
            ? "border-violet-200 bg-violet-50 text-violet-950 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-100"
            : "border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
        )}>
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {detail.session.eligibilityReason === "billing_evidence_missing"
            ? "Eligibility is paused until billing or payout evidence is resolved. This session cannot be enforced."
            : `This session is excluded from feedback obligations: ${formatEligibilityReason(detail.session.eligibilityReason)}.`}
        </div>
      ) : detail.session.sourceStatus !== "ready" ? (
        <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Enforcement is paused for this session. Source or identity evidence must be resolved before reminders or deductions can proceed.
        </div>
      ) : null}

      <section className="rounded-lg border bg-card p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-xs font-semibold"><History className="size-4 text-sky-600" />Immutable feedback history</h3>
            <p className="mt-1 text-xs text-muted-foreground">{versions.length} teacher-profile version{versions.length === 1 ? "" : "s"}, newest observation first.</p>
          </div>
          <Badge variant="outline">Current Wise detail is canonical</Badge>
        </div>
        {versions.length > 0 ? (
          <div className="mt-3 flex max-w-full gap-2 overflow-x-auto pb-1" role="group" aria-label="Feedback versions">
            {currentProjectionMissing ? (
              <button
                type="button"
                onClick={() => onSelectVersion(null)}
                className={cn(
                  "min-w-48 rounded-lg border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selectedVersionId === null ? "border-amber-300 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" : "hover:bg-muted/50",
                )}
                aria-pressed={selectedVersionId === null}
              >
                <span className="block font-semibold">Current projection</span>
                <span className="mt-1 block text-[10px] text-muted-foreground">No teacher feedback in the latest Wise detail</span>
              </button>
            ) : null}
            {versions.map((version, index) => {
              const governing = version.id === detail.session.latestFeedbackVersionId;
              return (
                <button
                  type="button"
                  key={version.id}
                  onClick={() => onSelectVersion(version.id)}
                  className={cn(
                    "min-w-48 rounded-lg border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selectedVersion?.id === version.id ? "border-sky-300 bg-sky-50 text-sky-950 dark:bg-sky-950/30 dark:text-sky-100" : "hover:bg-muted/50",
                  )}
                  aria-pressed={selectedVersion?.id === version.id}
                >
                  <span className="flex items-center justify-between gap-2 font-semibold">
                    Version {versions.length - index}
                    {governing ? <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[9px] text-emerald-800">Governing</Badge> : null}
                  </span>
                  <span className="mt-1 block text-[10px] text-muted-foreground">Observed {formatBangkokDate(version.observedAt, true)}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{version.submissionId || version.contentHash.slice(0, 12)}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">No teacher-profile feedback version has been observed.</p>
        )}
      </section>

      {currentProjectionMissing && !selectedVersion ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          Current Wise session detail contains no teacher feedback. Historical observations remain available above and cannot be erased from the audit record.
        </div>
      ) : selectedVersion ? (
        <>
          <EvidenceMetadata version={selectedVersion} />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <section className="overflow-hidden rounded-lg border bg-card">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <h3 className="text-xs font-semibold">Mapped required fields</h3>
                <span className="text-[11px] tabular-nums text-muted-foreground">{selectedVersion.combinedCharacterCount} total characters</span>
              </div>
              <AnswerRow label="Topics covered" answer={selectedVersion.required.topics} />
              <AnswerRow label="How the student did in class" answer={selectedVersion.required.performance} />
              <AnswerRow label="Need more work on" answer={selectedVersion.required.improvement} />
              <div className="px-3 py-3">
                <div className="flex items-center justify-between gap-2 text-xs font-medium">
                  <span>Homework / due date</span>
                  <Badge variant="outline">Not required</Badge>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/85">
                  {selectedVersion.homework || <span className="italic text-muted-foreground">No homework provided.</span>}
                </p>
              </div>
            </section>

            <section className="rounded-lg border bg-card p-3">
              <h3 className="text-xs font-semibold">Exact Wise answers</h3>
              <p className="mt-1 text-xs text-muted-foreground">Question labels, IDs, and answer whitespace are shown as stored from Wise.</p>
              {selectedVersion.answers.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {selectedVersion.answers.map((answer, index) => (
                    <ExactAnswer key={`${answer.id ?? answer.questionId ?? "answer"}:${index}`} answer={answer} index={index} />
                  ))}
                </div>
              ) : (
                <p className="mt-3 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">This submission contains no Wise answers.</p>
              )}
            </section>
          </div>
        </>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-lg border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-xs font-semibold"><FileClock className="size-4 text-sky-600" />Assessment history</h3>
            <Badge variant="outline">Append-only</Badge>
          </div>
          {detail.assessments.length > 0 ? (
            <div className="mt-3 space-y-2">
              {detail.assessments.map((assessment) => (
                <div key={assessment.id} className="rounded-lg border bg-background/70 p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{formatBangkokDate(assessment.assessedAt, true)}</span>
                    <Badge variant="outline" className="capitalize">{assessment.enforcementMode}</Badge>
                    <Badge variant="outline" className="capitalize">{assessment.timingStatus.replaceAll("_", " ")}</Badge>
                    {assessment.objectiveViolation ? <Badge variant="outline" className="border-red-200 bg-red-50 text-red-800">Objective violation</Badge> : null}
                  </div>
                  <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                    <span>Policy v{assessment.policyVersion} · mapping v{assessment.mappingVersion}</span>
                    <span>{assessment.combinedRawCharCount} characters · {assessment.requiredFieldsPassed ? "fields passed" : "fields failed"}</span>
                    <span>{assessment.rawOnTime ? "Raw on-time" : "Not proven on-time"}</span>
                    <span>{assessment.adjustedCompliant ? "Adjusted compliant" : assessment.remediatedLate ? "Remediated late" : "Not adjusted compliant"}</span>
                  </div>
                  {assessment.fieldFailures.length > 0 ? <p className="mt-2 text-[11px] text-red-700">{assessment.fieldFailures.join(" · ")}</p> : null}
                  {assessment.timingEvidence ? <p className="mt-1 text-[11px] text-muted-foreground">Timing evidence: {assessment.timingEvidence.replaceAll("_", " ")}</p> : null}
                </div>
              ))}
            </div>
          ) : <p className="mt-3 text-xs text-muted-foreground">No assessment has been recorded.</p>}
        </section>

        <section className="rounded-lg border bg-card p-3">
          <h3 className="text-xs font-semibold">Wise event associations</h3>
          <p className="mt-1 text-xs text-muted-foreground">Events accelerate discovery; session detail remains canonical.</p>
          {detail.evidence.eventAssociations.length > 0 ? (
            <div className="mt-3 space-y-2">
              {detail.evidence.eventAssociations.map((event) => (
                <div key={event.id} className="rounded-lg border bg-background/70 p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold">{event.wiseEventId}</span>
                    <Badge variant="outline">{event.autoSubmitted === null ? "Unknown provenance" : event.autoSubmitted ? "Auto" : "Manual"}</Badge>
                    {event.linkConfidence !== null ? <span className="text-[11px] text-muted-foreground">{Math.round(event.linkConfidence * 100)}% link confidence</span> : null}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">{formatBangkokDate(event.eventTimestamp, true)} · version {event.feedbackVersionId || "not linked"}</div>
                </div>
              ))}
            </div>
          ) : <p className="mt-3 text-xs text-muted-foreground">No activity event is associated with this session.</p>}
        </section>
      </div>

      <section className="rounded-lg border bg-card p-3">
        <h3 className="text-xs font-semibold">Source issue history</h3>
        {detail.sourceIssues.length > 0 ? (
          <div className="mt-3 space-y-2">
            {detail.sourceIssues.map((issue) => (
              <div key={issue.id} className="flex gap-3 rounded-lg border bg-background/70 p-3 text-xs">
                <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", issue.status === "open" ? "text-amber-600" : "text-muted-foreground")} aria-hidden="true" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{issue.issueType.replaceAll("_", " ")}</span>
                    <Badge variant="outline" className="capitalize">{issue.scope}</Badge>
                    <Badge variant="outline" className="capitalize">{issue.status}</Badge>
                    {issue.blocksEnforcement ? <span className="text-[11px] text-amber-700">Blocks enforcement</span> : null}
                  </div>
                  <p className="mt-1 text-muted-foreground">{issue.message}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    First seen {formatBangkokDate(issue.firstSeenAt, true)} · last seen {formatBangkokDate(issue.lastSeenAt, true)}
                    {issue.resolvedAt ? ` · resolved ${formatBangkokDate(issue.resolvedAt, true)}` : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="mt-2 text-xs text-muted-foreground">No session or global source issue was recorded.</p>}
      </section>

      {session.ai.concerns && session.ai.concerns.length > 0 ? (
        <section className="rounded-lg border bg-card p-3">
          <h3 className="flex items-center gap-2 text-xs font-semibold"><Bot className="size-4 text-sky-600" />AI quality advisory</h3>
          <p className="mt-1 text-xs text-muted-foreground">AI findings are advisory and cannot create a deduction.</p>
          <div className="mt-3 space-y-2">
            {session.ai.concerns.map((concern) => (
              <div key={concern.id} className="rounded-lg border bg-background/70 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium capitalize">{concern.dimension.replaceAll("_", " ")}</span>
                  <Badge variant="outline" className="capitalize">{concern.decision}</Badge>
                  {concern.confidence !== null ? <span className="text-[11px] text-muted-foreground">{Math.round(concern.confidence * 100)}% confidence</span> : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{concern.summary}</p>
                {concern.decision === "pending" && canReview ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="outline" size="xs" disabled={submitting} onClick={() => onAiReview({
                      concernId: concern.id,
                      expectedVersion: concern.version,
                      action: "confirm",
                    })}>Confirm concern</Button>
                    <Button variant="ghost" size="xs" disabled={submitting} onClick={() => onAiReview({
                      concernId: concern.id,
                      expectedVersion: concern.version,
                      action: "dismiss",
                    })}>Dismiss</Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function SessionDetailDialog({
  session,
  capabilities,
  submitting,
  refreshToken,
  onOpenChange,
  onMutation,
}: {
  session: FeedbackSessionRow | null;
  capabilities: FeedbackCapabilities;
  submitting: boolean;
  refreshToken: number;
  onOpenChange: (open: boolean) => void;
  onMutation: (request: FeedbackMutationRequest) => Promise<void>;
}) {
  const [detail, setDetail] = useState<PostClassFeedbackSessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [reviewDialog, setReviewDialog] = useState<ReviewDialogState>(null);
  const [note, setNote] = useState("");
  const [waiverCategory, setWaiverCategory] = useState<FeedbackWaiverCategory>("wise_system_outage");
  const requestSequence = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const loadDetail = useCallback(async () => {
    if (!session) return;
    const sequence = ++requestSequence.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const response = await fetch(`/api/post-class-feedback/sessions/${encodeURIComponent(session.id)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as PostClassFeedbackSessionDetail | { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload && "error" in payload && payload.error ? payload.error : "Could not load exact Wise feedback.");
      }
      if (!payload || !("session" in payload) || !("evidence" in payload)) {
        throw new Error("Wise feedback detail returned an invalid response.");
      }
      if (sequence !== requestSequence.current) return;
      setDetail(payload as PostClassFeedbackSessionDetail);
      setSelectedVersionId(payload.session.latestFeedbackVersionId);
    } catch (cause) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load exact Wise feedback.");
      setDetail(null);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (!session) {
      controllerRef.current?.abort();
      setDetail(null);
      setError(null);
      return;
    }
    void loadDetail();
    return () => controllerRef.current?.abort();
  }, [loadDetail, refreshToken, session]);

  const currentReview = detail?.review;
  const deduction = session?.deduction;
  const reviewStatus = currentReview?.status ?? deduction?.status ?? "none";
  const reviewVersion = currentReview?.version ?? deduction?.version ?? 0;
  const deductionId = currentReview?.id ?? deduction?.id ?? null;
  const deductionAmount = currentReview ? currentReview.amountMinor / 100 : deduction?.amount ?? 0;
  const aiConcerns = useMemo(() => session?.ai.concerns ?? [], [session]);
  const dialogTitle = reviewDialog?.kind === "ai"
    ? `${reviewDialog.action === "confirm" ? "Confirm" : "Dismiss"} AI concern`
    : reviewDialog?.action === "approve"
      ? "Approve deduction"
      : reviewDialog?.action === "waive"
        ? "Waive violation"
        : "Reopen deduction review";
  const noteRequired = reviewDialog?.kind === "ai" || reviewDialog?.action === "waive" || reviewDialog?.action === "reopen";

  async function submitReview() {
    if (!reviewDialog || !session || (noteRequired && !note.trim())) return;
    if (reviewDialog.kind === "ai") {
      await onMutation({
        endpoint: "/api/post-class-feedback/ai-review",
        body: {
          concernId: reviewDialog.concernId,
          action: reviewDialog.action,
          note: note.trim(),
          expectedVersion: reviewDialog.expectedVersion,
          idempotencyKey: crypto.randomUUID(),
        },
      });
    } else if (deductionId) {
      await onMutation({
        endpoint: "/api/post-class-feedback/review",
        body: {
          deductionId,
          action: reviewDialog.action,
          note: note.trim(),
          ...(reviewDialog.action === "waive" ? { waiverCategory } : {}),
          expectedVersion: reviewVersion,
          idempotencyKey: crypto.randomUUID(),
        },
      });
    }
    setReviewDialog(null);
    setNote("");
  }

  return (
    <Dialog open={Boolean(session)} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(92vh,980px)] max-h-[92vh] w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1180px,calc(100vw-2rem))]">
        {session ? (
          <>
            <DialogHeader className="border-b px-4 py-3 pr-14">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <DialogTitle className="truncate text-base">{session.className || session.subject}</DialogTitle>
                  <DialogDescription className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="inline-flex items-center gap-1"><CalendarClock className="size-3.5" />{formatBangkokDate(session.scheduledStartAt, true)}</span>
                    <span className="inline-flex items-center gap-1"><UserRound className="size-3.5" />{session.tutorName}</span>
                    <span>{session.students.join(", ") || "Unknown student"}</span>
                    <span className="font-mono">{session.wiseSessionId}</span>
                  </DialogDescription>
                </div>
                <OutcomeBadge session={session} />
              </div>
            </DialogHeader>

            {loading && !detail ? <DetailLoading /> : error ? (
              <div role="alert" className="min-h-0 flex-1 overflow-auto">
                <EmptyPanel
                  kind="error"
                  title="Could not load session evidence"
                  detail={error}
                  action={<Button variant="outline" size="sm" onClick={() => void loadDetail()}><RefreshCw />Try again</Button>}
                />
              </div>
            ) : detail ? (
              <DetailBody
                detail={detail}
                session={{ ...session, ai: { ...session.ai, concerns: aiConcerns } }}
                selectedVersionId={selectedVersionId}
                onSelectVersion={setSelectedVersionId}
                onAiReview={({ concernId, expectedVersion, action }) => setReviewDialog({
                  kind: "ai",
                  action,
                  concernId,
                  expectedVersion,
                })}
                canReview={capabilities.reviewer}
                submitting={submitting}
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-2 border-t bg-card px-3 py-2.5 sm:px-4">
              <div className="mr-auto">
                <div className="text-xs font-semibold">Review actions</div>
                <div className="text-[11px] text-muted-foreground">
                  {capabilities.reviewer ? "Reviewer access enabled" : "Viewer only — reviewer access is required"}
                </div>
              </div>
              {session.wiseUrl ? (
                <Button nativeButton={false} render={<a href={session.wiseUrl} target="_blank" rel="noreferrer" />} variant="outline" size="sm">
                  Open in Wise <ExternalLink data-icon="inline-end" />
                </Button>
              ) : null}
              {reviewStatus === "pending_review" ? (
                <>
                  <Button size="sm" disabled={!capabilities.reviewer || submitting || !detail} onClick={() => setReviewDialog({ kind: "review", action: "approve" })}>
                    <ShieldCheck />Approve ฿{deductionAmount}
                  </Button>
                  <Button variant="outline" size="sm" disabled={!capabilities.reviewer || submitting || !detail} onClick={() => setReviewDialog({ kind: "review", action: "waive" })}>
                    Waive
                  </Button>
                </>
              ) : reviewStatus === "approved" ? (
                <Button variant="outline" size="sm" disabled={!capabilities.reviewer || submitting || !detail} onClick={() => setReviewDialog({ kind: "review", action: "reopen" })}>
                  Reopen review
                </Button>
              ) : null}
            </div>

            <Dialog open={reviewDialog !== null} onOpenChange={(open) => { if (!open) { setReviewDialog(null); setNote(""); } }}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>{dialogTitle}</DialogTitle>
                  <DialogDescription>This creates an immutable audit entry. AI decisions remain separate from financial decisions.</DialogDescription>
                </DialogHeader>
                {reviewDialog?.action === "waive" ? (
                  <label className="grid gap-1.5 text-xs font-medium">
                    Waiver category
                    <select
                      className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                      value={waiverCategory}
                      onChange={(event) => setWaiverCategory(event.target.value as FeedbackWaiverCategory)}
                    >
                      {WAIVER_CATEGORIES.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
                    </select>
                  </label>
                ) : null}
                <label className="grid gap-1.5 text-xs font-medium">
                  {noteRequired ? "Required audit note" : "Audit note (optional)"}
                  <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Explain the evidence and decision…" />
                </label>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setReviewDialog(null)}>Cancel</Button>
                  <Button disabled={submitting || (noteRequired && !note.trim())} onClick={() => void submitReview()}>{submitting ? "Saving…" : "Confirm"}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
