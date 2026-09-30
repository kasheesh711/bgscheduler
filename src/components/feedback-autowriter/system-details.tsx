"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import type { AutowriterReview } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";
import { Disclosure, Tag, Upper } from "./atoms";
import { count, dayMonth, minutes, percent, threshold, usd, when } from "./format";
import { GATE_STATUS_LABEL } from "./health-rail";
import type { DrawerTarget } from "./item-drawer";
import { modelLabel } from "./model-labels";

// ----------------------------------------------------------------------------
// The details, collapsed by default: the exact numbers behind the page. The
// daily table, the gate's every criterion, the tutors' raw counts, cost and
// speed, the Wise webhooks, every incident and the review job's last run.
// ----------------------------------------------------------------------------

const HEAD = "h-auto bg-muted/40 px-3 py-2.5 text-[10px] font-medium text-muted-foreground first:pl-5 last:pr-5";
const CELL = "px-3 py-2.5 text-[11px] first:pl-5 last:pr-5";
const NUMBER = cn(CELL, "text-right tabular-nums");
const NUMBER_HEAD = cn(HEAD, "text-right");

function Criterion({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <li className="flex items-start justify-between gap-3 py-1.5">
      <span className="flex items-center gap-2">
        <span aria-hidden className={cn("inline-block size-2 rounded-full", ok ? "bg-available" : "bg-conflict")} />
        <span>{label}</span>
        <span className="sr-only">{ok ? "met" : "not met"}</span>
      </span>
      <span className="text-right font-[550] tabular-nums">{value}</span>
    </li>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xs font-[550] tabular-nums">{children}</dd>
    </div>
  );
}

function ByDay({ review }: { review: AutowriterReview }) {
  return (
    <Disclosure title="By day" count={review.daily.length} hint={`Bangkok dates · last ${review.window.days} days`}>
      {review.daily.length === 0 ? (
        <p className="px-5 py-6 text-center text-xs text-muted-foreground">No metrics yet — the review job runs hourly at :27.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={HEAD}>Date</TableHead>
              <TableHead className={HEAD}>Mode</TableHead>
              <TableHead className={NUMBER_HEAD}>Posted</TableHead>
              <TableHead className={NUMBER_HEAD}>Reviewed</TableHead>
              <TableHead className={NUMBER_HEAD}>Accurate</TableHead>
              <TableHead className={NUMBER_HEAD}>Cosmetic / major / critical</TableHead>
              <TableHead className={NUMBER_HEAD}>Coverage</TableHead>
              <TableHead className={NUMBER_HEAD}>Classes fixed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {review.daily.map((row) => (
              <TableRow key={row.date}>
                <TableCell className={CELL}>{row.date}</TableCell>
                <TableCell className={CELL}>{row.liveMode ? "Live" : <span className="text-muted-foreground">Not live</span>}</TableCell>
                <TableCell className={NUMBER}>{row.posted}</TableCell>
                <TableCell className={NUMBER}>{row.reviewed}/{row.required}</TableCell>
                <TableCell className={NUMBER}>{row.accurate}</TableCell>
                <TableCell className={NUMBER}>{row.cosmetic} / {row.factual} / {row.critical}</TableCell>
                <TableCell className={NUMBER}>{percent(row.coverage)} <span className="text-muted-foreground">({row.posted}/{row.eligible})</span></TableCell>
                <TableCell className={NUMBER}>{row.measuredFixClasses}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Disclosure>
  );
}

function GateInFull({ review }: { review: AutowriterReview }) {
  const { gate, coverage } = review;
  const misses = coverage.miss_held + coverage.miss_late + coverage.miss_expired + coverage.miss_failed + coverage.miss_unseen;
  return (
    <Disclosure title="The gate in full" hint={GATE_STATUS_LABEL[gate.status]}>
      <div className="grid gap-x-8 gap-y-4 px-5 py-4 lg:grid-cols-2">
        <div>
          <Upper className="block">Every criterion</Upper>
          <ul className="mt-1 divide-y text-[11px]">
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
        </div>
        <div className="space-y-3 text-[11px] leading-[1.6] text-muted-foreground">
          <p>
            Rolling {review.window.days} days, {dayMonth(review.window.start)} – {dayMonth(review.window.end)} (Bangkok)
            {gate.lastDaily
              ? `. Last nightly evaluation ${gate.lastDaily.date}: ${GATE_STATUS_LABEL[gate.lastDaily.status]}.`
              : ". No nightly evaluation yet."}
          </p>
          <p>
            Roster: {gate.currentTutors} tutors → next step {gate.nextExpansionSize} (+50%, rounded up) once the gate passes and
            you confirm. A lower bound of {threshold(gate.thresholds.headStartLowerBound)} starts the head start for the next tutors.
          </p>
          <p>
            Misses: {misses}. Each class is judged by the mode and its tutor&apos;s switch during its own posting window.
            Excluded and in-progress classes count on neither side; in-person classes are not counted. A hold for the
            class&apos;s own data (recording, speakers, transcript, absence, not a Wise user) is left out; a hold on our
            drafts (unfaithful, validation, format) is a miss.
          </p>
        </div>
      </div>
    </Disclosure>
  );
}

function ByTutor({ dashboard, review }: { dashboard: AutowriterDashboard; review: AutowriterReview | null }) {
  const quality = new Map((review?.tutors ?? []).map((row) => [row.tutorKey, row]));
  return (
    <Disclosure title="By tutor" count={dashboard.tutors.length}
      hint={`classes of the last ${count(dashboard.windowDays, "day")}${review ? ` · reviews of the last ${review.window.days} days` : ""}`}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={HEAD}>Tutor</TableHead>
            <TableHead className={NUMBER_HEAD}>Classes</TableHead>
            <TableHead className={NUMBER_HEAD}>Posted</TableHead>
            <TableHead className={NUMBER_HEAD}>Shadow</TableHead>
            <TableHead className={NUMBER_HEAD}>Held</TableHead>
            <TableHead className={NUMBER_HEAD}>Tutor wrote</TableHead>
            <TableHead className={NUMBER_HEAD}>Expired</TableHead>
            <TableHead className={NUMBER_HEAD}>Failed</TableHead>
            <TableHead className={NUMBER_HEAD}>Median to post</TableHead>
            <TableHead className={NUMBER_HEAD}>Cost</TableHead>
            <TableHead className={NUMBER_HEAD}>Texts in Wise</TableHead>
            <TableHead className={NUMBER_HEAD}>Reviewed</TableHead>
            <TableHead className={NUMBER_HEAD}>Accurate</TableHead>
            <TableHead className={NUMBER_HEAD}>Waiting</TableHead>
            <TableHead className={NUMBER_HEAD}>Classes fixed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {dashboard.tutors.map((tutor) => {
            const row = quality.get(tutor.tutorKey);
            return (
              <TableRow key={tutor.tutorKey}>
                <TableCell className={cn(CELL, "font-[550]")}>{tutor.displayName}</TableCell>
                <TableCell className={NUMBER}>{tutor.seen}</TableCell>
                <TableCell className={NUMBER}>{tutor.posted}</TableCell>
                <TableCell className={NUMBER}>{tutor.shadowDrafts}</TableCell>
                <TableCell className={NUMBER}>{tutor.held}</TableCell>
                <TableCell className={NUMBER}>{tutor.skippedHuman}</TableCell>
                <TableCell className={NUMBER}>{tutor.expired}</TableCell>
                <TableCell className={NUMBER}>{tutor.failed}</TableCell>
                <TableCell className={NUMBER}>{minutes(tutor.medianLatencyMinutes)}</TableCell>
                <TableCell className={NUMBER}>{usd(tutor.costUsd)}</TableCell>
                <TableCell className={NUMBER}>{row ? row.textsInWise : "—"}</TableCell>
                <TableCell className={NUMBER}>{row ? row.reviewed : "—"}</TableCell>
                <TableCell className={NUMBER}>{row ? row.accurate : "—"}</TableCell>
                <TableCell className={NUMBER}>{row ? row.requiredPending : "—"}</TableCell>
                <TableCell className={NUMBER}>{row ? row.measuredFixClasses : "—"}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Disclosure>
  );
}

function CostAndSpeed({ dashboard }: { dashboard: AutowriterDashboard }) {
  const { totals, latency, cost } = dashboard;
  const fallbacks = dashboard.summaryFallbacks.reduce((sum, entry) => sum + entry.count, 0);
  return (
    <Disclosure title="Totals, cost and speed" hint={`last ${count(dashboard.windowDays, "day")}`}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-b px-5 py-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Classes seen">{totals.seen}</Stat>
        <Stat label="Posted">{totals.posted} <span className="font-normal text-muted-foreground">({totals.verified} confirmed)</span></Stat>
        <Stat label="Posted from a transcript">{totals.fromTranscript}</Stat>
        <Stat label="Shadow drafts">{totals.shadowDrafts}</Stat>
        <Stat label="Waiting for a recording">{totals.awaitingRecording}</Stat>
        <Stat label="Held for a person">{totals.held}</Stat>
        <Stat label="Tutor wrote first">{totals.skippedHuman}</Stat>
        <Stat label="Out of scope">{totals.skippedScope}</Stat>
        <Stat label="Expired / failed">{totals.expired} / {totals.failed}</Stat>
        <Stat label="Class end → posted">
          {minutes(latency.medianMinutes)} <span className="font-normal text-muted-foreground">(p90 {minutes(latency.p90Minutes)} · {count(latency.samples, "post")})</span>
        </Stat>
        <Stat label="Model cost">{usd(cost.totalUsd)} <span className="font-normal text-muted-foreground">({usd(cost.perDraftUsd)} per draft)</span></Stat>
        <Stat label="Drafts judged unfaithful">{dashboard.judgeRejections}</Stat>
        <Stat label="Written by the Luna fallback">{dashboard.fallbackShare === null ? "no drafts yet" : `${Math.round(dashboard.fallbackShare * 100)}%`}</Stat>
      </dl>
      <div className="grid lg:grid-cols-2">
        <div className="border-b lg:border-r">
          <Upper className="block px-5 pt-3 pb-1">Cost by model</Upper>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={HEAD}>Model</TableHead><TableHead className={HEAD}>Role</TableHead>
                <TableHead className={NUMBER_HEAD}>Calls</TableHead><TableHead className={NUMBER_HEAD}>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cost.byModel.map((entry) => (
                <TableRow key={`${entry.role}-${entry.model}`}>
                  <TableCell className={CELL} title={entry.model}>{modelLabel(entry.model)}</TableCell>
                  <TableCell className={cn(CELL, "capitalize")}>{entry.role}</TableCell>
                  <TableCell className={NUMBER}>{entry.calls}</TableCell>
                  <TableCell className={NUMBER}>{usd(entry.costUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="border-b">
          <Upper className="block px-5 pt-3 pb-1">Cost by day (Bangkok)</Upper>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={HEAD}>Date</TableHead><TableHead className={NUMBER_HEAD}>Drafts</TableHead>
                <TableHead className={NUMBER_HEAD}>Posted</TableHead><TableHead className={NUMBER_HEAD}>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cost.byDay.map((entry) => (
                <TableRow key={entry.date}>
                  <TableCell className={CELL}>{entry.date}</TableCell>
                  <TableCell className={NUMBER}>{entry.drafts}</TableCell>
                  <TableCell className={NUMBER}>{entry.posted}</TableCell>
                  <TableCell className={NUMBER}>{usd(entry.costUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="border-b lg:border-r lg:border-b-0">
          <Upper className="block px-5 pt-3 pb-1">Class end → posted, by evidence</Upper>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={HEAD}>Written from</TableHead><TableHead className={NUMBER_HEAD}>Posts</TableHead>
                <TableHead className={NUMBER_HEAD}>Median</TableHead><TableHead className={NUMBER_HEAD}>p90</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latency.byRoute.map((entry) => (
                <TableRow key={entry.route}>
                  <TableCell className={CELL}>{entry.label}</TableCell>
                  <TableCell className={NUMBER}>{entry.samples}</TableCell>
                  <TableCell className={NUMBER}>{minutes(entry.medianMinutes)}</TableCell>
                  <TableCell className={NUMBER}>{minutes(entry.p90Minutes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div>
          <Upper className="block px-5 pt-3 pb-1">Back to the summary (transcript first) · {fallbacks}</Upper>
          {dashboard.summaryFallbacks.length === 0 ? (
            <p className="px-5 py-5 text-xs text-muted-foreground">No class fell back to the summary in this window.</p>
          ) : (
            <ul className="space-y-1.5 px-5 py-3 text-[11px]">
              {dashboard.summaryFallbacks.map((entry) => (
                <li key={entry.cause} className="flex justify-between gap-3"><span>{entry.label}</span><span className="tabular-nums">{entry.count}</span></li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Disclosure>
  );
}

function Webhooks({ webhooks }: { webhooks: AutowriterDashboard["webhooks"] }) {
  const deliveries = webhooks.byEvent.reduce((sum, entry) => sum + entry.count, 0);
  return (
    <Disclosure title="Wise webhooks" count={deliveries} hint={`last 24 hours · last delivery ${when(webhooks.lastReceivedAt)}`}>
      <div className="grid gap-x-8 gap-y-4 px-5 py-4 text-[11px] sm:grid-cols-2">
        <div>
          <Upper className="mb-1.5 block">Events</Upper>
          {webhooks.byEvent.length === 0 ? <p className="text-muted-foreground">No delivery in the last 24 hours.</p> : (
            <ul className="space-y-1">
              {webhooks.byEvent.map((entry) => <li key={entry.eventName} className="flex justify-between gap-3"><span>{entry.eventName}</span><span className="tabular-nums">{entry.count}</span></li>)}
            </ul>
          )}
        </div>
        <div>
          <Upper className="mb-1.5 block">Outcomes</Upper>
          <ul className="space-y-1">
            {webhooks.byOutcome.map((entry) => <li key={entry.outcome} className="flex justify-between gap-3"><span>{entry.outcome}</span><span className="tabular-nums">{entry.count}</span></li>)}
          </ul>
        </div>
      </div>
    </Disclosure>
  );
}

function Incidents({ review, onOpen }: { review: AutowriterReview; onOpen: (target: DrawerTarget) => void }) {
  const run = review.lastRun;
  return (
    <Disclosure title="Incidents and the review job" count={review.incidents.length} hint="acknowledged ones too">
      {review.incidents.length === 0 ? <p className="px-5 py-5 text-xs text-muted-foreground">No incident.</p> : (
        <ul className="divide-y text-[11px]">
          {review.incidents.map((incident) => (
            <li key={incident.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5">
              <Tag tone={incident.severity === "critical" ? "red" : "neutral"}>{incident.severity}</Tag>
              <span className="min-w-0 flex-1">{incident.summary}</span>
              <span className="text-[10px] text-muted-foreground">
                {when(incident.createdAt)}
                {incident.severity === "critical" ? ` · push ${incident.pushStatus === "failed" ? "FAILED — not delivered" : incident.pushStatus}` : ""}
                {incident.lastPushError ? ` · ${incident.lastPushError}` : ""}
                {incident.acknowledgedAt ? ` · acknowledged by ${incident.acknowledgedBy ?? "—"} ${when(incident.acknowledgedAt)}` : ""}
              </span>
              <Button size="xs" variant="outline" className="h-6 rounded-md px-2 text-[10px] font-[550]" onClick={() => onOpen({ kind: "incident", incidentId: incident.id })}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t px-5 py-3 text-[11px] text-muted-foreground">
        Review job: {run
          ? `${run.status} · started ${when(run.startedAt)}${run.errorSummary ? ` · ${run.errorSummary}` : ""}${run.dailyGateSkipped ? ` · nightly gate not recorded yet (${run.dailyGateSkipped})` : ""}`
          : "has not run yet"}
      </p>
    </Disclosure>
  );
}

export function SystemDetails({ dashboard, review, onOpen }: {
  dashboard: AutowriterDashboard;
  /** The review data, or null while it is unavailable: its sections are then left out. */
  review: AutowriterReview | null;
  onOpen: (target: DrawerTarget) => void;
}) {
  return (
    <>
      {review ? <ByDay review={review} /> : null}
      {review ? <GateInFull review={review} /> : null}
      <ByTutor dashboard={dashboard} review={review} />
      <CostAndSpeed dashboard={dashboard} />
      <Webhooks webhooks={dashboard.webhooks} />
      {review ? <Incidents review={review} onOpen={onOpen} /> : null}
    </>
  );
}
