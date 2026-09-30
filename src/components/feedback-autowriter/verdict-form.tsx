"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ReviewQueueItem } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";
import {
  CATEGORIES,
  DOWNGRADE_LABEL,
  SEVERITIES,
  buildVerdictRequest,
  downgradeFor,
  hasHarshJudgement,
  type Category,
  type Severity,
} from "./review-helpers";

/**
 * The owner's Approve / Needs fix controls for one posted class. `onRecorded` runs after a verdict was stored
 * (`recorded`) and after the server refused a stale page (`stale`, HTTP 409): both reload the class, and the form
 * keeps its error in the second case.
 */
export function VerdictForm({ item, onRecorded, initialMode = "idle" }: {
  item: ReviewQueueItem;
  onRecorded: (outcome: "recorded" | "stale") => Promise<void> | void;
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
        if (response.status === 409) await onRecorded("stale");
        return;
      }
      setMessage({ error: false, text: "Verdict recorded." });
      reset();
      await onRecorded("recorded");
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
