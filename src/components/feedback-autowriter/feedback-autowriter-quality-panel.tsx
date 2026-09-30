"use client";

import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBangkokIsoDate, formatBangkokShortDateTime } from "@/lib/bangkok-time";
import { floorPercent } from "@/lib/feedback-autowriter/quality";
import type { AutowriterReview } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";

export const GATE_STATUS_LABEL: Record<AutowriterReview["gate"]["status"], string> = {
  pass: "Expansion ready",
  head_start: "Head start",
  below_head_start: "Below head start",
  insufficient_data: "Not enough reviews yet",
  blocked_critical: "Blocked: critical error",
};

const GATE_STATUS_TONE: Record<AutowriterReview["gate"]["status"], string> = {
  pass: "border-available/30 bg-available/10 text-available",
  head_start: "border-sky-300 bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  below_head_start: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  insufficient_data: "border-muted-foreground/30 text-muted-foreground",
  blocked_critical: "border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200",
};

/** A measured ratio, rounded down (79.99…% never reads as the 80% it missed). */
function percent(value: number | null): string {
  return value === null ? "—" : floorPercent(value);
}

/** A threshold (round by definition). */
function threshold(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function Criterion({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <li className="flex items-start justify-between gap-3 py-1.5">
      <span className="flex items-center gap-2">
        <span aria-hidden className={cn("inline-block size-2 rounded-full", ok ? "bg-available" : "bg-red-500")} />
        <span>{label}</span>
        <span className="sr-only">{ok ? "met" : "not met"}</span>
      </span>
      <span className="text-right font-medium tabular-nums">{value}</span>
    </li>
  );
}

function Card({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border bg-card", className)}>
      <h2 className="border-b px-4 py-3 text-sm font-semibold">{title}</h2>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function Chip({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "good" | "miss" | "muted" }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs", {
      "border-available/30 text-available": tone === "good",
      "border-amber-300 text-amber-800 dark:text-amber-300": tone === "miss",
      "text-muted-foreground": tone === "muted",
    })}>
      {label} <strong className="tabular-nums">{value}</strong>
    </span>
  );
}

/** Lower-bound bar with the 70% (head start) and 80% (pass) marks. */
export function LowerBoundBar({ value, headStart, pass }: { value: number; headStart: number; pass: number }) {
  return (
    <div className="space-y-1">
      <div className="relative h-3 w-full overflow-visible rounded-full bg-muted" role="meter" aria-label="Accuracy lower bound"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
        <div className={cn("h-3 rounded-full", value >= pass ? "bg-available" : value >= headStart ? "bg-sky-500" : "bg-amber-500")}
          style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
        {[headStart, pass].map((mark) => (
          <div key={mark} className="absolute -top-1 h-5 w-px bg-foreground/70" style={{ left: `${mark * 100}%` }} />
        ))}
      </div>
      <div className="relative h-4 text-[10px] text-muted-foreground">
        <span className="absolute -translate-x-1/2" style={{ left: `${headStart * 100}%` }}>{threshold(headStart)} head start</span>
        <span className="absolute translate-x-1" style={{ left: `${pass * 100}%` }}>{threshold(pass)} pass</span>
      </div>
    </div>
  );
}

function AcknowledgeButton({ incidentId, onChanged }: { incidentId: string; onChanged: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acknowledge = async () => {
    if (!window.confirm("Acknowledge this incident? Its pushes stop and it no longer keeps the review job red.")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/feedback-autowriter/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge", incidentId }),
      });
      if (!response.ok) {
        const json = await response.json().catch(() => null) as { error?: unknown } | null;
        setError(typeof json?.error === "string" ? json.error : `HTTP ${response.status}`);
        return;
      }
      await onChanged();
    } catch {
      setError("Could not acknowledge.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void acknowledge()}>Acknowledge</Button>
      {error ? <span role="status" className="text-xs text-red-700">{error}</span> : null}
    </span>
  );
}

export function FeedbackAutowriterQualityPanel({ review, canControl = false, onChanged = () => undefined }: {
  review: AutowriterReview;
  /** The owner may acknowledge incidents. */
  canControl?: boolean;
  onChanged?: () => Promise<void> | void;
}) {
  const { gate, coverage } = review;
  const misses = coverage.miss_held + coverage.miss_late + coverage.miss_expired + coverage.miss_failed + coverage.miss_unseen;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Expansion gate" className="lg:col-span-2">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline" className={cn("text-sm", GATE_STATUS_TONE[gate.status])}>{GATE_STATUS_LABEL[gate.status]}</Badge>
            <span className="text-xs text-muted-foreground">
              Rolling {review.window.days} days · {formatBangkokIsoDate(review.window.start)} – {formatBangkokIsoDate(review.window.end)} (Bangkok)
              {gate.lastDaily ? ` · last nightly evaluation ${gate.lastDaily.date}: ${GATE_STATUS_LABEL[gate.lastDaily.status]}` : " · no nightly evaluation yet"}
            </span>
          </div>
          <div className="mt-4 space-y-1">
            <div className="flex items-baseline justify-between text-sm">
              <span>Accuracy lower bound (Wilson 95%)</span>
              <span className="text-lg font-semibold tabular-nums">{percent(gate.wilsonLower)}</span>
            </div>
            <LowerBoundBar value={gate.wilsonLower} headStart={gate.thresholds.headStartLowerBound} pass={gate.thresholds.passLowerBound} />
          </div>
          <ul className="mt-3 divide-y text-sm">
            <Criterion ok={gate.reviewed > 0 && gate.wilsonLower >= gate.thresholds.passLowerBound}
              label={`Accuracy lower bound ≥ ${threshold(gate.thresholds.passLowerBound)}`}
              value={`${percent(gate.wilsonLower)} (${gate.accurate}/${gate.reviewed} accurate)`} />
            <Criterion ok={gate.criticalVerdicts === 0} label="No critical verdicts" value={String(gate.criticalVerdicts)} />
            <Criterion ok={gate.unresolvedCriticalFlags === 0} label="No unresolved critical flags" value={String(gate.unresolvedCriticalFlags)} />
            <Criterion ok={gate.unexplainedApiWrites === 0} label="No unexplained API write to Wise" value={`${gate.unexplainedApiWrites} not acknowledged`} />
            <Criterion ok={gate.coverage !== null && gate.coverage >= gate.thresholds.minCoverage}
              label={`Coverage ≥ ${threshold(gate.thresholds.minCoverage)}`}
              value={`${percent(gate.coverage)} (${gate.coverageNum}/${gate.coverageDen})`} />
            <Criterion ok={gate.pendingFlaggedReviews === 0} label="No flagged post waiting for review" value={String(gate.pendingFlaggedReviews)} />
            <Criterion ok={gate.requiredPending === 0} label="Every required post reviewed" value={`${gate.requiredPending} waiting`} />
            <Criterion ok={gate.unrecordedPosts === 0} label="Every posted first shot recorded" value={`${gate.unrecordedPosts} missing`} />
          </ul>
          {gate.reasons.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">{gate.reasons.join(" · ")}</p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            Roster: {gate.currentTutors} tutors → next step {gate.nextExpansionSize} (+50%, rounded up) once the gate passes and
            you confirm. A lower bound of {threshold(gate.thresholds.headStartLowerBound)} starts the head start for the next tutors.
          </p>
        </Card>
        <Card title="Coverage (window)">
          <p className="text-sm">
            <strong className="text-lg tabular-nums">{percent(gate.coverage)}</strong>
            <span className="text-muted-foreground"> posted of eligible ({gate.coverageNum}/{gate.coverageDen})</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Chip label="Posted" value={coverage.posted} tone="good" />
            <Chip label="Held" value={coverage.miss_held} tone="miss" />
            <Chip label="Written after our draft" value={coverage.miss_late} tone="miss" />
            <Chip label="Expired" value={coverage.miss_expired} tone="miss" />
            <Chip label="Failed" value={coverage.miss_failed} tone="miss" />
            <Chip label="Never seen" value={coverage.miss_unseen} tone="miss" />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip label="Tutor wrote first" value={coverage.excluded_tutor_first} tone="muted" />
            <Chip label="Data quality" value={coverage.excluded_data_quality} tone="muted" />
            <Chip label="Tutor switched off" value={coverage.excluded_tutor_off} tone="muted" />
            <Chip label="Not live (shadow/off)" value={coverage.excluded_not_live} tone="muted" />
            <Chip label="Out of scope" value={coverage.excluded_scope} tone="muted" />
            <Chip label="Still in progress" value={coverage.pending} tone="muted" />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Misses: {misses}. Each class is judged by the mode and its tutor&apos;s switch during its own posting window.
            Excluded and in-progress classes count on neither side; in-person classes are not counted. A hold for the
            class&apos;s own data (recording, speakers, transcript, absence, not a Wise user) is left out; a hold on our
            drafts (unfaithful, validation, format) is a miss.
          </p>
          <div className="mt-4 border-t pt-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Fix rounds per post</div>
            <div className="flex flex-wrap gap-1.5">
              <Chip label="0" value={review.fixRounds.zero} tone="good" />
              <Chip label="1" value={review.fixRounds.one} />
              <Chip label="2" value={review.fixRounds.two} />
              <Chip label="3+" value={review.fixRounds.threePlus} tone="miss" />
              <Chip label="Unresolved" value={review.fixRounds.unresolved} tone="miss" />
            </div>
          </div>
        </Card>
      </div>

      <Card title="By day (Bangkok)">
        {review.daily.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No metrics yet — the review job runs hourly at :27.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead className="text-right">Posted</TableHead>
                <TableHead className="text-right">Reviewed</TableHead>
                <TableHead className="text-right">Accurate</TableHead>
                <TableHead className="text-right">Cosmetic / major / critical</TableHead>
                <TableHead className="text-right">Coverage</TableHead>
                <TableHead className="text-right">Classes fixed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {review.daily.map((row) => (
                <TableRow key={row.date}>
                  <TableCell>{row.date}</TableCell>
                  <TableCell>{row.liveMode ? "Live" : <span className="text-muted-foreground">Not live</span>}</TableCell>
                  <TableCell className="text-right">{row.posted}</TableCell>
                  <TableCell className="text-right">{row.reviewed}/{row.required}</TableCell>
                  <TableCell className="text-right">{row.accurate}</TableCell>
                  <TableCell className="text-right">{row.cosmetic} / {row.factual} / {row.critical}</TableCell>
                  <TableCell className="text-right">{percent(row.coverage)} <span className="text-muted-foreground">({row.posted}/{row.eligible})</span></TableCell>
                  <TableCell className="text-right">{row.measuredFixClasses}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card title="By tutor (window)">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tutor</TableHead>
              <TableHead>Review</TableHead>
              <TableHead className="text-right">Texts in Wise</TableHead>
              <TableHead className="text-right">Reviewed</TableHead>
              <TableHead className="text-right">Accurate</TableHead>
              <TableHead className="text-right">Lower bound</TableHead>
              <TableHead className="text-right">Coverage</TableHead>
              <TableHead className="text-right">Waiting</TableHead>
              <TableHead className="text-right">Classes fixed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {review.tutors.map((tutor) => (
              <TableRow key={tutor.tutorKey}>
                <TableCell className="font-medium">{tutor.displayName}</TableCell>
                <TableCell>{tutor.phase === "full_review" ? "Every post (new)" : "30% sample + flagged"}</TableCell>
                <TableCell className="text-right">{tutor.textsInWise}</TableCell>
                <TableCell className="text-right">{tutor.reviewed}</TableCell>
                <TableCell className="text-right">{tutor.accurate}</TableCell>
                <TableCell className="text-right">{tutor.reviewed > 0 ? percent(tutor.wilsonLower) : "—"}</TableCell>
                <TableCell className="text-right">{percent(tutor.coverage)}</TableCell>
                <TableCell className="text-right">{tutor.requiredPending}</TableCell>
                <TableCell className="text-right">{tutor.measuredFixClasses}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card title="Incidents">
        {review.incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {review.incidents.map((incident) => (
              <li key={incident.id} className="flex flex-wrap items-start gap-2">
                <Badge variant={incident.severity === "critical" ? "destructive" : "outline"}>{incident.severity}</Badge>
                <span className="flex-1">{incident.summary}</span>
                <span className="text-xs text-muted-foreground">
                  {formatBangkokShortDateTime(incident.createdAt)}
                  {incident.severity === "critical" ? ` · push ${incident.pushStatus === "failed" ? "FAILED — not delivered" : incident.pushStatus}` : ""}
                  {incident.lastPushError ? ` · ${incident.lastPushError}` : ""}
                  {incident.acknowledgedAt ? ` · acknowledged by ${incident.acknowledgedBy ?? "—"} ${formatBangkokShortDateTime(incident.acknowledgedAt)}` : ""}
                </span>
                {canControl && incident.severity === "critical" && !incident.acknowledgedAt
                  ? <AcknowledgeButton incidentId={incident.id} onChanged={onChanged} /> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Review job: {review.lastRun
            ? `${review.lastRun.status} · started ${formatBangkokShortDateTime(review.lastRun.startedAt)}${review.lastRun.errorSummary ? ` · ${review.lastRun.errorSummary}` : ""}${review.lastRun.dailyGateSkipped ? ` · nightly gate not recorded yet (${review.lastRun.dailyGateSkipped})` : ""}`
            : "has not run yet"}
        </p>
      </Card>
    </div>
  );
}
