"use client";

import { useMemo, type ReactNode } from "react";
import { Shield } from "lucide-react";
import { ChartCanvas } from "@/components/sales-dashboard/chart-canvas";
import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import { gateSentence } from "@/lib/feedback-autowriter/gate-sentence";
import type { AutowriterReview, AutowriterReviewUnavailable } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";
import { Panel, TONE_TEXT, type Tone } from "./atoms";
import { buildMiniRateChartConfig, lastValue, railSeries } from "./chart-configs";
import { autowriterChartColors } from "./chart-palette";
import { dayMonth, percent, threshold } from "./format";

// ----------------------------------------------------------------------------
// The health rail: the accuracy gate as one sentence, accuracy and coverage
// over the gate's 14 days, and where today's classes stand.
// ----------------------------------------------------------------------------

type Gate = AutowriterReview["gate"];

export const GATE_STATUS_LABEL: Record<Gate["status"], string> = {
  pass: "Passed",
  head_start: "Head start",
  below_head_start: "Below head start",
  insufficient_data: "Not enough reviews yet",
  blocked_critical: "Blocked: critical error",
};

/** The status in a word or two, for the gate card's top line. */
const GATE_STATUS_SHORT: Record<Gate["status"], string> = {
  pass: "Passed",
  head_start: "Head start",
  below_head_start: "Below head start",
  insufficient_data: "Not enough reviews",
  blocked_critical: "Blocked",
};

/** What the status means. Every online tutor is on the roster (cohort 5), so the gate is an accuracy bar, not a roster step. */
const GATE_MEANING: Record<Gate["status"], string> = {
  pass: "Accuracy meets the bar.",
  head_start: "Accuracy is close to the bar; keep reviewing posts.",
  below_head_start: "Accuracy is below the bar; keep reviewing posts.",
  insufficient_data: "The gate can say nothing until posts of the window are reviewed.",
  blocked_critical: "A critical error blocks the gate; keep reviewing posts.",
};

const GATE_TONE: Record<Gate["status"], { card: string; tone: Tone; rule: string }> = {
  pass: { card: "border-available/30 bg-available/10", tone: "green", rule: "border-available/25" },
  head_start: { card: "border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950", tone: "blue", rule: "border-sky-200 dark:border-sky-900" },
  below_head_start: { card: "border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950", tone: "amber", rule: "border-amber-200 dark:border-amber-900" },
  insufficient_data: { card: "border-border bg-muted/40", tone: "neutral", rule: "border-border" },
  blocked_critical: { card: "border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950", tone: "amber", rule: "border-amber-200 dark:border-amber-900" },
};

/**
 * The gate's sentence as a headline and what follows its colon ("Gate blocked until 13 Oct" / "Critical on 29 Sep."),
 * for the card's two sizes of type. A sentence without a colon is all headline.
 */
export function splitGateSentence(sentence: string): { headline: string; detail: string | null } {
  const at = sentence.indexOf(": ");
  if (at < 0) return { headline: sentence.replace(/\.$/u, ""), detail: null };
  const detail = sentence.slice(at + 2);
  return { headline: sentence.slice(0, at), detail: detail.charAt(0).toUpperCase() + detail.slice(1) };
}

/** Lower-bound bar with the 70% (head start) and 80% (pass) marks. */
export function LowerBoundBar({ value, headStart, pass }: { value: number; headStart: number; pass: number }) {
  return (
    <div className="space-y-1">
      <div className="relative h-2 w-full overflow-visible rounded-full bg-foreground/10" role="meter" aria-label="Accuracy lower bound"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
        <div className={cn("h-2 rounded-full", value >= pass ? "bg-available" : value >= headStart ? "bg-sky-500" : "bg-amber-500")}
          style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
        {[headStart, pass].map((mark) => (
          <div key={mark} className="absolute -top-1 h-4 w-px bg-foreground/60" style={{ left: `${mark * 100}%` }} />
        ))}
      </div>
      <div className="relative h-4 text-[10px] whitespace-nowrap text-muted-foreground">
        <span className="absolute -translate-x-full pr-1" style={{ left: `${headStart * 100}%` }}>{threshold(headStart)} head start</span>
        <span className="absolute pl-1" style={{ left: `${pass * 100}%` }}>{threshold(pass)} pass</span>
      </div>
    </div>
  );
}

/** Why there is no quality data: the review tables are not there yet, or their load failed. */
export function ReviewUnavailable({ reason }: { reason: AutowriterReviewUnavailable["reason"] | null }) {
  return (
    <p className="rounded-[10px] border bg-card px-4 py-8 text-center text-xs text-muted-foreground">
      {reason === "review_tables_missing"
        ? "Quality data is not available yet (the review tables are created by migration 0101)."
        : "The quality data could not load. Refresh to try again; if it keeps failing, check the server logs."}
    </p>
  );
}

function GateCard({ gate }: { gate: Gate }) {
  const tone = GATE_TONE[gate.status];
  const { headline, detail } = splitGateSentence(gateSentence(gate));
  return (
    <div className={cn("rounded-[7px] border p-3.5", tone.card)} data-gate-status={gate.status}>
      <div className={cn("flex items-center gap-[7px] text-[11px] font-semibold uppercase tracking-[0.04em]", TONE_TEXT[tone.tone])}>
        <Shield aria-hidden className="size-4" strokeWidth={1.6} />
        Accuracy gate · {GATE_STATUS_SHORT[gate.status]}
      </div>
      <h3 className="mt-2.5 text-base font-semibold tracking-[-0.03em]">{headline}</h3>
      <p className="mt-1.5 text-[11px] leading-[1.6] text-foreground/60">{detail ? `${detail} ` : ""}{GATE_MEANING[gate.status]}</p>
      {gate.reasons.length > 0 ? (
        <div className={cn("mt-3 border-t pt-2.5 text-[10px] leading-[1.6]", tone.rule)}>
          <span className={cn("font-semibold", TONE_TEXT[tone.tone])}>Not met</span>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-3.5 text-foreground/65">
            {gate.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      ) : null}
      <div className={cn("mt-3 border-t pt-2.5", tone.rule)}>
        <div className="mb-1.5 flex items-baseline justify-between text-[10px] text-foreground/60">
          <span>Accuracy lower bound (Wilson 95%)</span>
          <span className="text-xs font-semibold tabular-nums text-foreground">{gate.reviewed > 0 ? percent(gate.wilsonLower) : "—"}</span>
        </div>
        <LowerBoundBar value={gate.wilsonLower} headStart={gate.thresholds.headStartLowerBound} pass={gate.thresholds.passLowerBound} />
      </div>
    </div>
  );
}

function MiniChart({ labels, daily, average, target, critical, ariaLabel, className }: {
  labels: readonly string[];
  daily: Array<number | null>;
  average: Array<number | null>;
  target: number;
  critical?: readonly boolean[];
  ariaLabel: string;
  className: string;
}) {
  const config = useMemo(
    () => buildMiniRateChartConfig({ labels, daily, average, target, critical }, autowriterChartColors()),
    [labels, daily, average, target, critical],
  );
  return <ChartCanvas config={config} className={cn("flex-none", className)} ariaLabel={ariaLabel} />;
}

function HealthBlock({ label, value, counts, chart, foot }: { label: string; value: string; counts: string; chart: ReactNode; foot: ReactNode }) {
  return (
    <div className="border-b pt-[21px] pb-[15px]">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-[550]">{label}</h3>
        <div className="text-xl font-semibold tracking-[-0.035em] tabular-nums">
          {value} <small className="text-[10px] font-normal tracking-normal text-muted-foreground">{counts}</small>
        </div>
      </div>
      {/* The figure above is counted now; the chart reads the daily counts the review job stores each hour. */}
      <div className="mt-2.5" title="Drawn from the daily counts the review job stores each hour">{chart}</div>
      <div className="mt-1 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">{foot}</div>
    </div>
  );
}

function TodayBlock({ today }: { today: AutowriterDashboard["today"] }) {
  const rows: Array<[string, number]> = [
    ["Posted", today.posted],
    ["Waiting for a recording", today.awaitingRecording],
    ["Held", today.held],
    ["Tutor wrote first", today.skippedHuman],
    ["Out of scope", today.skippedScope],
  ];
  return (
    <div className="mt-auto pt-[18px]">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">Today</h3>
        <span className="text-[10px] text-muted-foreground">{dayMonth(today.date)} · classes ending today in Bangkok</span>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-y-2.5 text-[10px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn("text-right font-[550] tabular-nums", value === 0 && "font-normal text-muted-foreground")}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function HealthRail({ dashboard, review, unavailableReason, className }: {
  dashboard: Pick<AutowriterDashboard, "today">;
  /** The review data, or null while it is unavailable. */
  review: AutowriterReview | null;
  unavailableReason: AutowriterReviewUnavailable["reason"] | null;
  className?: string;
}) {
  const series = useMemo(() => review ? railSeries(review) : null, [review]);
  return (
    <Panel aria-labelledby="autowriter-health-title" className={cn("flex flex-col px-5 pt-5 pb-[15px]", className)}>
      <div className="mb-[17px] flex items-center justify-between">
        <h2 id="autowriter-health-title" className="text-sm font-[650] tracking-[-0.02em]">Pilot health</h2>
        <span className="text-[11px] text-muted-foreground">
          {review ? `${dayMonth(review.window.start)} – ${dayMonth(review.window.end)} · ${review.window.days}-day window` : "14-day window"}
        </span>
      </div>
      {review && series ? (
        <>
          <GateCard gate={review.gate} />
          <HealthBlock
            label="No real fix needed"
            value={review.gate.reviewed > 0 ? percent(review.gate.accurate / review.gate.reviewed) : "—"}
            counts={`${review.gate.accurate} / ${review.gate.reviewed} reviewed`}
            chart={(
              <MiniChart labels={series.labels} daily={series.accuracy} average={series.accuracy7d} target={review.gate.thresholds.passLowerBound}
                critical={series.critical} className="h-[94px]"
                ariaLabel="Daily accuracy and its 7-day average over the gate window, with the 80% bar and any day with a critical verdict" />
            )}
            foot={(
              <>
                <span className="flex items-center gap-1"><i aria-hidden className="inline-block h-0.5 w-[15px] bg-chart-1" />7-day average {percent(lastValue(series.accuracy7d))}</span>
                <span className={review.gate.reviewed === 0 ? undefined : TONE_TEXT[review.gate.wilsonLower >= review.gate.thresholds.passLowerBound ? "green" : "amber"]}>
                  Wilson LB {review.gate.reviewed > 0 ? percent(review.gate.wilsonLower) : "—"}
                </span>
              </>
            )}
          />
          <HealthBlock
            label="Eligible classes posted"
            value={percent(review.gate.coverage)}
            counts={`${review.gate.coverageNum} / ${review.gate.coverageDen}`}
            chart={(
              <MiniChart labels={series.labels} daily={series.coverage} average={series.coverage7d} target={review.gate.thresholds.minCoverage}
                className="h-[75px]" ariaLabel="Daily coverage and its 7-day average over the gate window, with the 70% floor" />
            )}
            foot={(
              <>
                <span>7-day average {percent(lastValue(series.coverage7d))}</span>
                <CoverageMargin coverage={review.gate.coverage} floor={review.gate.thresholds.minCoverage} />
              </>
            )}
          />
        </>
      ) : <ReviewUnavailable reason={unavailableReason} />}
      <TodayBlock today={dashboard.today} />
    </Panel>
  );
}

/** How far coverage is from its floor, in percentage points, rounded down: "6.8 pp above floor". */
function CoverageMargin({ coverage, floor }: { coverage: number | null; floor: number }) {
  if (coverage === null) return <span>No eligible classes yet</span>;
  const points = Math.floor(Math.abs(coverage - floor) * 1000 + 1e-9) / 10;
  return coverage >= floor
    ? <span className={TONE_TEXT.green}>{points} pp above floor</span>
    : <span className={TONE_TEXT.amber}>{points} pp below floor</span>;
}
