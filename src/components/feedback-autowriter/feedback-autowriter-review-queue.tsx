"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { downgradeOf } from "@/lib/feedback-autowriter/quality";
import type { AutowriterReview, ReviewQueueItem } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";
import { FIELD_LABELS, when } from "./format";
import { ARM_LABEL } from "./model-labels";

const FILTERS = [
  { key: "required", label: "Needs review" },
  { key: "flagged", label: "Flagged" },
  { key: "all", label: "All" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

const STATUS_LABEL: Record<ReviewQueueItem["status"], string> = {
  needs_review: "Needs review",
  flagged: "Flagged",
  reviewed: "Reviewed",
  optional: "Not sampled",
};

const STATUS_TONE: Record<ReviewQueueItem["status"], string> = {
  needs_review: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  flagged: "border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200",
  reviewed: "border-available/30 bg-available/10 text-available",
  optional: "border-muted-foreground/30 text-muted-foreground",
};

const ACTOR_LABEL: Record<string, string> = {
  autowriter_first: "Autowriter — first post",
  autowriter_correction: "Autowriter — correction",
  autowriter_policy: "Autowriter — policy re-post (not a fix)",
  api_actor_unmatched: "Wise API user — no recorded post",
  owner_web: "Owner (Wise web)",
  tutor: "Tutor",
  other_staff: "Other staff",
  student: "Student",
  auto: "Wise auto-submission",
};

// The stored severity "factual" is the owner's "major": a real fix, not accurate.
const SEVERITIES = [
  { value: "cosmetic", label: "Cosmetic (still accurate)" },
  { value: "factual", label: "Major (real fix)" },
  { value: "critical", label: "Critical" },
] as const;
type Severity = (typeof SEVERITIES)[number]["value"];

const CATEGORIES = [
  { value: "wrong_person", label: "Wrong person" },
  { value: "billing_status", label: "Billing or status error" },
  { value: "invented_content", label: "Invented content" },
  { value: "should_not_have_posted", label: "Should not have posted" },
] as const;
type Category = (typeof CATEGORIES)[number]["value"];

const SEVERITY_SHORT: Record<Severity, string> = { cosmetic: "cosmetic", factual: "Major (real fix)", critical: "critical" };

const OUTCOME_LABEL: Record<string, string> = {
  verify_failed: "Landed but did not verify — Wise may differ",
  unknown_outcome: "Outcome unknown — may be in Wise",
  rejected: "Refused by Wise, but the submission changed",
};

/** Measured fixes per actor, e.g. "Tutor 1, Autowriter — correction 1". */
export function measuredFixesLabel(byActor: Record<string, number>): string {
  return Object.entries(byActor).filter(([, count]) => count > 0).toSorted(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${ACTOR_LABEL[kind] ?? kind} ${count}`).join(", ");
}

export function matchesFilter(item: ReviewQueueItem, filter: Filter): boolean {
  if (filter === "required") return item.required && item.currentVerdict === null;
  if (filter === "flagged") return item.openFlags.length > 0;
  return true;
}

const DOWNGRADE_LABEL = { critical: "critical", factual: "major" } as const;

export function verdictLabel(verdict: NonNullable<ReviewQueueItem["currentVerdict"]>): string {
  const downgraded = verdict.downgradedFrom ? ` (downgraded from ${DOWNGRADE_LABEL[verdict.downgradedFrom]})` : "";
  if (verdict.verdict === "approve") return `Approved${downgraded}`;
  const category = verdict.criticalCategory ? ` · ${CATEGORIES.find((option) => option.value === verdict.criticalCategory)?.label}` : "";
  const severity = verdict.severity ? SEVERITY_SHORT[verdict.severity] : "—";
  return `Needs fix · ${severity}${category}${downgraded}`;
}

/** What a new verdict would downgrade on this class (a harsher current verdict or a critical flag), or null. */
export function downgradeFor(
  item: Pick<ReviewQueueItem, "currentVerdict" | "openFlags">,
  verdict: "approve" | "needs_fix",
  severity: Severity | null,
): "critical" | "factual" | null {
  return downgradeOf({
    current: item.currentVerdict ? { verdict: item.currentVerdict.verdict, severity: item.currentVerdict.severity } : null,
    openCriticalFlag: item.openFlags.some((flag) => flag.suggestedSeverity === "critical"),
    next: { verdict, severity: verdict === "approve" ? null : severity ?? "cosmetic" },
  });
}

/** The class carries a major or critical judgement a milder verdict would downgrade. */
export function hasHarshJudgement(item: Pick<ReviewQueueItem, "currentVerdict" | "openFlags">): boolean {
  return downgradeFor(item, "approve", null) !== null;
}

export interface VerdictFormState {
  severity: Severity | null;
  category: Category | null;
  note: string;
  downgradeConfirmed: boolean;
}

/**
 * The verdict request for the owner's choice, pinned to what the page shows (first shot, current verdict, open
 * flags), or why it cannot be sent yet. Needs fix never defaults to a severity.
 */
export function buildVerdictRequest(
  item: Pick<ReviewQueueItem, "wiseSessionId" | "firstShot" | "currentVerdict" | "openFlags">,
  verdict: "approve" | "needs_fix",
  form: VerdictFormState,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (verdict === "needs_fix" && form.severity === null) return { ok: false, error: "Choose a severity." };
  if (verdict === "needs_fix" && form.severity === "critical" && form.category === null) return { ok: false, error: "Choose the critical category." };
  const severity = verdict === "needs_fix" ? form.severity : null;
  const downgrade = downgradeFor(item, verdict, severity);
  if (downgrade && !form.note.trim()) return { ok: false, error: `A downgrade from ${DOWNGRADE_LABEL[downgrade]} needs a note saying why.` };
  if (downgrade && !form.downgradeConfirmed) return { ok: false, error: `Confirm the downgrade from ${DOWNGRADE_LABEL[downgrade]}.` };
  return {
    ok: true,
    body: {
      wiseSessionId: item.wiseSessionId,
      fieldsSha256: item.firstShot.fieldsSha256,
      currentVerdictId: item.currentVerdict?.id ?? null,
      seenFlagIds: item.openFlags.map((flag) => flag.id),
      verdict,
      severity,
      criticalCategory: severity === "critical" ? form.category : null,
      note: form.note.trim() || null,
      ...(downgrade ? { confirmDowngrade: true } : {}),
    },
  };
}

function Fields({ fields }: { fields: Record<string, string> }) {
  return (
    <div className="space-y-2">
      {Object.entries(FIELD_LABELS).map(([key, label]) => (
        <div key={key}>
          <div className="text-[11px] font-medium">{label}</div>
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{fields[key] || "—"}</p>
        </div>
      ))}
    </div>
  );
}

export function VerdictForm({ item, onRecorded, initialMode = "idle" }: {
  item: ReviewQueueItem;
  onRecorded: () => Promise<void> | void;
  initialMode?: "idle" | "needs_fix";
}) {
  const [mode, setMode] = useState<"idle" | "needs_fix">(initialMode);
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [category, setCategory] = useState<Category | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const reset = () => {
    setMode("idle");
    setSeverity(null);
    setCategory(null);
    setNote("");
  };

  const submit = async (verdict: "approve" | "needs_fix") => {
    const chosenSeverity = verdict === "needs_fix" ? severity : null;
    const downgrade = verdict === "needs_fix" && chosenSeverity === null ? null : downgradeFor(item, verdict, chosenSeverity);
    if (downgrade && !note.trim()) {
      setMessage({ error: true, text: `This class has a ${DOWNGRADE_LABEL[downgrade]} judgement: say in the note why you are downgrading it.` });
      return;
    }
    const downgradeConfirmed = Boolean(downgrade) && window.confirm(
      `Downgrade a ${DOWNGRADE_LABEL[downgrade ?? "critical"].toUpperCase()} judgement? A verdict judges the first shot as posted, `
        + "not the corrected text. This is recorded with your note.",
    );
    if (downgrade && !downgradeConfirmed) return;
    if (verdict === "needs_fix" && chosenSeverity === "critical"
      && !window.confirm("Record a CRITICAL verdict? It blocks expansion and pushes an alert.")) return;
    const request = buildVerdictRequest(item, verdict, { severity, category, note, downgradeConfirmed });
    if (!request.ok) {
      setMessage({ error: true, text: request.error });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/feedback-autowriter/verdicts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const json = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        setMessage({ error: true, text: typeof json?.error === "string" ? json.error : `HTTP ${response.status}` });
        // A stale page (a new verdict or flag since it loaded): show the class as it is now.
        if (response.status === 409) await onRecorded();
        return;
      }
      setMessage({ error: false, text: "Verdict recorded." });
      reset();
      await onRecorded();
    } catch {
      setMessage({ error: true, text: "Could not record the verdict." });
    } finally {
      setBusy(false);
    }
  };

  const needsFixReady = severity !== null && (severity !== "critical" || category !== null);
  const harsh = hasHarshJudgement(item);
  const noteField = (
    <label className="text-xs sm:col-span-2">
      Note{harsh ? " (required for a milder verdict)" : ""}
      <Textarea aria-label="Verdict note" className="mt-1" value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)}
        placeholder={harsh ? "Why the first shot was not that bad after all" : "What was wrong, in a sentence"} />
    </label>
  );
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3" data-testid="verdict-controls">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void submit("approve")}>Approve</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode(mode === "needs_fix" ? "idle" : "needs_fix")}>
          Needs fix
        </Button>
        {message ? <span role="status" className={cn("text-xs", message.error ? "text-red-700" : "text-available")}>{message.text}</span> : null}
      </div>
      {harsh ? (
        <p className="text-xs text-red-700 dark:text-red-300">
          This class has a major or critical judgement of its first shot. A milder verdict downgrades it: it needs a note and
          your confirmation. To answer a new flag without changing the judgement, record the same severity again.
        </p>
      ) : null}
      {harsh && mode !== "needs_fix" ? <div className="grid gap-2 sm:grid-cols-2">{noteField}</div> : null}
      {mode === "needs_fix" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            Severity
            <select aria-label="Severity" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" value={severity ?? ""}
              onChange={(event) => setSeverity(event.target.value ? event.target.value as Severity : null)}>
              <option value="" disabled>Choose a severity…</option>
              {SEVERITIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {severity === "critical" ? (
            <label className="text-xs">
              Category
              <select aria-label="Critical category" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" value={category ?? ""}
                onChange={(event) => setCategory(event.target.value ? event.target.value as Category : null)}>
                <option value="" disabled>Choose a category…</option>
                {CATEGORIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          ) : null}
          {noteField}
          <div className="sm:col-span-2">
            <Button size="sm" variant="destructive" disabled={busy || !needsFixReady} onClick={() => void submit("needs_fix")}>Record needs fix</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QueueItem({ item, canControl, onRecorded }: { item: ReviewQueueItem; canControl: boolean; onRecorded: () => Promise<void> | void }) {
  const reconstructed = item.firstShot.provenance === "backfill";
  return (
    <details className="rounded-lg border bg-card" open={item.status === "flagged"}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-sm">
        <span className="whitespace-nowrap font-medium">{when(item.classEndedAt)}</span>
        <span className="whitespace-nowrap">{item.tutor}</span>
        <span className="max-w-64 truncate text-muted-foreground" title={item.className ?? undefined}>{item.className ?? "—"}</span>
        <Badge variant="outline" className={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
        {item.currentVerdict ? <Badge variant="outline">{verdictLabel(item.currentVerdict)}</Badge> : null}
        {item.changed ? <Badge variant="outline" className="border-violet-300 text-violet-800 dark:text-violet-200">Changed since first post</Badge> : null}
        {item.measuredFixCount > 0 ? (
          <span className="text-xs text-muted-foreground">
            {item.measuredFixCount} measured fix{item.measuredFixCount === 1 ? "" : "es"} ({measuredFixesLabel(item.measuredFixesByActor)})
          </span>
        ) : null}
      </summary>
      <div className="space-y-4 border-t px-4 py-3">
        {item.openFlags.length > 0 ? (
          <ul className="space-y-1 text-xs text-red-700 dark:text-red-300">
            {item.openFlags.map((flag) => (
              <li key={flag.id}>
                Flag ({flag.source}{flag.suggestedSeverity ? `, suggested ${flag.suggestedSeverity}` : ""}): {flag.note ?? "—"}
              </li>
            ))}
          </ul>
        ) : null}
        {item.firstShot.outcome !== "verified" ? (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
            {OUTCOME_LABEL[item.firstShot.outcome] ?? item.firstShot.outcome}
            {item.firstShot.problems.length > 0 ? ` (${item.firstShot.problems.join(", ")})` : ""}. Open the class in Wise and judge what is there.
          </p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">First shot</h3>
              <Badge variant="outline" className="text-[10px]">
                {reconstructed ? "reconstructed · hash-verified" : "recorded at post · hash-verified"}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                posted {when(item.firstShot.postStartedAt)}
                {item.firstShot.arm ? ` · ${ARM_LABEL[item.firstShot.arm] ?? item.firstShot.arm}` : ""}
                {item.firstShot.evidence === "transcript" ? " · transcript" : ""}
              </span>
            </div>
            <Fields fields={item.firstShot.fields} />
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Current text</h3>
              <span className="text-[11px] text-muted-foreground">
                {item.current.source === "wise_feedback_version" ? "as Class Feedback last read it from Wise"
                  : item.current.source === "correction" ? "the last verified correction"
                    : item.current.source === "policy" ? "the owner's policy re-post (not a fix)" : "unchanged since the first post"}
                {item.current.at ? ` · ${when(item.current.at)}` : ""}
              </span>
            </div>
            {item.changed ? (
              <div className="space-y-2" data-testid="first-shot-diff">
                {item.diff.map((entry) => (
                  <div key={entry.field}>
                    <div className="text-[11px] font-medium">{FIELD_LABELS[entry.field]}</div>
                    <p className="whitespace-pre-wrap text-xs">
                      {entry.segments.map((segment, index) => segment.kind === "same"
                        ? <span key={index} className="text-muted-foreground">{segment.text}</span>
                        : segment.kind === "removed"
                          ? <del key={index} className="bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200">{segment.text}</del>
                          : <ins key={index} className="bg-green-100 text-green-900 no-underline dark:bg-green-950 dark:text-green-200">{segment.text}</ins>)}
                    </p>
                  </div>
                ))}
              </div>
            ) : <p className="text-xs text-muted-foreground">Same as the first shot.</p>}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-semibold">Saves in Wise</h3>
            {item.fixEvents.length === 0 ? <p className="text-xs text-muted-foreground">No activity events mirrored yet.</p> : (
              <ul className="space-y-0.5 text-xs">
                {item.fixEvents.map((event) => (
                  <li key={event.wiseEventId} className="flex justify-between gap-2">
                    <span>
                      {ACTOR_LABEL[event.actorKind] ?? event.actorKind}
                      {event.counted ? <strong className="ml-1 text-amber-700">· fix</strong> : null}
                      {event.countsAsFix && !event.counted ? <span className="ml-1 text-muted-foreground">· after approval — not counted</span> : null}
                    </span>
                    <span className="text-muted-foreground">{when(event.at)}</span>
                  </li>
                ))}
              </ul>
            )}
            {item.corrections.length > 0 ? (
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                {item.corrections.map((correction, index) => (
                  <li key={index}>
                    {correction.kind === "policy" ? "Policy re-post (not a fix)" : "Correction"} by {correction.actor} ({correction.outcome})
                    {" · "}{correction.reason ?? "—"} · {when(correction.at)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">Verdicts</h3>
            {item.verdicts.length === 0 ? <p className="text-xs text-muted-foreground">No verdict yet.</p> : (
              <ul className="space-y-1 text-xs">
                {item.verdicts.map((verdict) => (
                  <li key={verdict.id} className={cn(!verdict.current && "text-muted-foreground line-through")}>
                    {verdictLabel(verdict)} · {verdict.reviewer} · {when(verdict.createdAt)}{verdict.note ? ` — ${verdict.note}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {canControl ? <VerdictForm item={item} onRecorded={onRecorded} /> : (
          <p className="text-xs text-muted-foreground">Read-only: only Kevin records verdicts.</p>
        )}
        {item.wiseUrl ? <a className="text-xs text-primary underline" href={item.wiseUrl} target="_blank" rel="noreferrer">Open in Wise</a> : null}
      </div>
    </details>
  );
}

export function FeedbackAutowriterReviewQueue({ review, canControl, onRecorded }: {
  review: AutowriterReview;
  canControl: boolean;
  onRecorded: () => Promise<void> | void;
}) {
  const [filter, setFilter] = useState<Filter>("required");
  // Exact counts from the database: the queue itself may be a subset (every flagged and unreviewed class is in it).
  const counts: Record<Filter, number> = {
    required: review.queueTotals.needsReview,
    flagged: review.queueTotals.flagged,
    all: review.queueTotals.all,
  };
  const items = review.queue.filter((item) => matchesFilter(item, filter));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Review filter">
          {FILTERS.map((option) => (
            <Button key={option.key} size="xs" variant={filter === option.key ? "default" : "ghost"} onClick={() => setFilter(option.key)}>
              {option.label} ({counts[option.key]})
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Every post is reviewed until the tutor&apos;s cohort passes a gate. Judge the first shot: cosmetic fixes still count as accurate.
        </p>
      </div>
      {review.queueTotals.shown < review.queueTotals.all ? (
        <p className="text-xs text-muted-foreground">
          Showing {review.queueTotals.shown} of {review.queueTotals.all}: every flagged and unreviewed class, then the latest reviewed ones.
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">Nothing here.</p>
      ) : items.map((item) => <QueueItem key={item.wiseSessionId} item={item} canControl={canControl} onRecorded={onRecorded} />)}
    </div>
  );
}
