"use client";

import { useMemo, type ReactNode } from "react";
import type { ChartConfiguration } from "chart.js";
import { Shield } from "lucide-react";
import { ChartCanvas } from "@/components/sales-dashboard/chart-canvas";
import { gateSentence } from "@/lib/feedback-autowriter/gate-sentence";
import { HOLD_REASON_CATEGORIES, HOLD_REASON_CATEGORY_LABELS } from "@/lib/feedback-autowriter/hold-reasons";
import { GATE_THRESHOLDS } from "@/lib/feedback-autowriter/quality";
import type { AutowriterReview, AutowriterReviewUnavailable } from "@/lib/feedback-autowriter/review-data";
import type { AutowriterTrends, TrendDay, TrendRangeDays } from "@/lib/feedback-autowriter/trends";
import { cn } from "@/lib/utils";
import { Panel, TONE_TEXT, Upper, type Tone } from "./atoms";
import {
  SERIES,
  buildAccuracyChartConfig,
  buildCoverageChartConfig,
  buildEvidenceChartConfig,
  buildSpeedCostChartConfig,
  lastValue,
  type AutowriterChartColors,
} from "./chart-configs";
import { autowriterChartColors } from "./chart-palette";
import { count, dayMonth, minutes, percent, usd, usdPerClass } from "./format";
import { ReviewUnavailable } from "./health-rail";
import { ARM_LABEL } from "./model-labels";

// ----------------------------------------------------------------------------
// "How the pilot is trending": four charts over the chosen range (daily values
// and a pooled 7-day average), each with its figure, its legend and a footer.
// The range and the tutor filter drive the charts and their totals; the footers
// that come from the review payload cover the gate's 14 days and say so.
// ----------------------------------------------------------------------------

/** The ranges the trends route accepts (`TREND_RANGES`). */
const RANGES: readonly TrendRangeDays[] = [14, 30, 90];

const GATE_NOTE_TONE: Record<AutowriterReview["gate"]["status"], Tone> = {
  pass: "green", head_start: "blue", below_head_start: "amber", insufficient_data: "neutral", blocked_critical: "amber",
};

/** Whole days from one Bangkok date key to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * What to say when the series begin inside the range: "since 29 Sep", and while there are fewer than 7 days of
 * history, that the 7-day lines cover only the days there are. Null when the range is full of history.
 */
export function trendSinceNote(trends: Pick<AutowriterTrends, "since" | "range">): string | null {
  if (trends.since === null) return "no data in this range yet";
  if (trends.since <= trends.range.start) return null;
  const history = daysBetween(trends.since, trends.range.end) + 1;
  return history < 7
    ? `since ${dayMonth(trends.since)} · the 7-day lines cover the ${count(history, "day")} there ${history === 1 ? "is" : "are"}`
    : `since ${dayMonth(trends.since)}`;
}

/** On how many of the days with a value the value reached the floor: "13 of 14". */
export function daysAtFloor(days: readonly TrendDay[], floor: number): { at: number; of: number } {
  const values = days.flatMap((day) => day.coverage === null ? [] : [day.coverage]);
  return { at: values.filter((value) => value >= floor).length, of: values.length };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function Legend({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[10px] text-muted-foreground", className)}>{children}</div>;
}

/** One legend entry: a swatch drawn in the DOM with the colour token the canvas uses. */
function Key({ mark, children }: { mark: "dot" | "line" | "line-second" | "dash" | "critical" | "bar" | "bar-muted"; children: ReactNode }) {
  const swatch: Record<typeof mark, string> = {
    dot: "size-[5px] rounded-full bg-chart-1/45",
    line: "h-0.5 w-[15px] bg-chart-1",
    "line-second": "h-0.5 w-[15px] bg-chart-3",
    dash: "w-[15px] border-t border-dashed border-chart-4",
    critical: "size-[7px] rounded-full bg-conflict",
    bar: "size-[7px] rounded-[2px] bg-chart-1/65",
    "bar-muted": "size-[7px] rounded-[2px] bg-muted-foreground/25",
  };
  return <span className="flex items-center gap-[5px]"><i aria-hidden className={cn("inline-block", swatch[mark])} />{children}</span>;
}

function Figure({ value, unit, caption }: { value: string; unit?: string; caption: string }) {
  return (
    <div className="text-right">
      <div className="text-[23px] leading-[1.1] font-semibold tracking-[-0.035em] tabular-nums">
        {value}{unit ? <small className="ml-1 text-[10px] font-normal tracking-normal text-muted-foreground">{unit}</small> : null}
      </div>
      <div className="mt-1.5 text-[10px] whitespace-nowrap text-muted-foreground">{caption}</div>
    </div>
  );
}

/** A small bordered count: a fix-round bucket, a kind of miss, a writer. A count of zero is never coloured. */
function Pill({ label, value, tone = "neutral" }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border bg-muted/30 px-1.5 py-1 text-[10px] leading-none", tone !== "neutral" && value !== 0 && TONE_TEXT[tone])}>
      {label} <strong className="font-[550] tabular-nums text-foreground">{value}</strong>
    </span>
  );
}

function Chart({ build, days, ariaLabel, className = "h-[194px]" }: {
  build: (days: readonly TrendDay[], colors: AutowriterChartColors) => ChartConfiguration;
  days: readonly TrendDay[];
  ariaLabel: string;
  className?: string;
}) {
  const config = useMemo(() => build(days, autowriterChartColors()), [build, days]);
  return <ChartCanvas config={config} className={cn("mt-[15px] flex-none", className)} ariaLabel={ariaLabel} />;
}

function TrendCard({ title, subtitle, figure, children }: { title: string; subtitle: string; figure: ReactNode; children: ReactNode }) {
  return (
    <Panel className="flex flex-col px-5 pt-[19px] pb-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="mb-1.5 text-[13px] font-semibold">{title}</h3>
          <div className="text-[10px] text-muted-foreground">{subtitle}</div>
        </div>
        {figure}
      </div>
      {children}
    </Panel>
  );
}

/** The bottom of a card: a rule, then what the chart cannot show. */
function Footer({ children }: { children: ReactNode }) {
  return <div className="mt-auto pt-3"><div className="space-y-2 border-t pt-3 text-[10px] leading-[1.6] text-muted-foreground">{children}</div></div>;
}

/** "last 14 days", and that the figures are everyone's while the charts above them are one tutor's. */
function windowLabel(review: AutowriterReview, filtered: boolean): string {
  return `${filtered ? "all tutors · " : ""}last ${review.window.days} days`;
}

function AccuracyCard({ trends, review, filtered }: { trends: AutowriterTrends; review: AutowriterReview; filtered: boolean }) {
  const { totals, days } = trends;
  const { fixRounds, gate } = review;
  return (
    <TrendCard title="Accuracy & gate" subtitle="Reviewed posts that needed no real fix"
      figure={<Figure value={percent(ratio(totals.accurate, totals.reviewed))} caption={`${totals.accurate} of ${totals.reviewed} reviewed`} />}>
      <Chart build={buildAccuracyChartConfig} days={days}
        ariaLabel="Daily accuracy, its 7-day average, the rolling 14-day Wilson lower bound, the 80% bar and the days with a critical verdict" />
      <Legend className="mt-2 justify-between">
        <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
          <Key mark="line-second">{SERIES.wilson}</Key>
          <Key mark="dash">{SERIES.passTarget}</Key>
          <Key mark="critical">{SERIES.critical}</Key>
        </span>
        <span>LB today: {percent(lastValue(days.map((day) => day.wilson14d)))}</span>
      </Legend>
      <Footer>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className={cn("flex items-center gap-[5px]", TONE_TEXT[GATE_NOTE_TONE[gate.status]])}>
            <Shield aria-hidden className="size-3" strokeWidth={1.6} />{filtered ? "The pilot's gate: " : ""}{gateSentence(gate)}
          </span>
          <span>A cosmetic fix still counts as accurate.</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Upper className="mr-1 text-[9px]">Reviews · {windowLabel(review, filtered)}</Upper>
          <Pill label="Reviewed" value={gate.reviewed} />
          <Pill label="Waiting" value={gate.requiredPending} tone="amber" />
          <Pill label="Flagged" value={gate.pendingFlaggedReviews} tone="amber" />
          <Pill label="Critical" value={gate.criticalVerdicts} tone="red" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Upper className="mr-1 text-[9px]">Fix rounds per post · {windowLabel(review, filtered)}</Upper>
          <Pill label="None" value={fixRounds.zero} tone="green" />
          <Pill label="One" value={fixRounds.one} />
          <Pill label="Two" value={fixRounds.two} />
          <Pill label="3+" value={fixRounds.threePlus} tone="amber" />
          <Pill label="Unresolved" value={fixRounds.unresolved} tone="amber" />
        </div>
      </Footer>
    </TrendCard>
  );
}

function CoverageCard({ trends, review, filtered }: { trends: AutowriterTrends; review: AutowriterReview; filtered: boolean }) {
  const { totals, days } = trends;
  const { coverage } = review;
  const floor = GATE_THRESHOLDS.minCoverage;
  const above = daysAtFloor(days, floor);
  return (
    <TrendCard title="Coverage" subtitle="Classes posted ÷ eligible classes"
      figure={<Figure value={percent(ratio(totals.posted, totals.eligible))} caption={`${totals.posted} of ${totals.eligible} eligible`} />}>
      <Chart build={buildCoverageChartConfig} days={days} ariaLabel="Daily coverage, its 7-day average and the 70% floor" />
      <Legend className="mt-2 justify-between">
        <Key mark="dash">{SERIES.coverageFloor}</Key>
        <span>7-day average: {percent(lastValue(days.map((day) => day.coverage7d)))}</span>
      </Legend>
      <Footer>
        {above.of > 0 ? (
          <div className={TONE_TEXT[above.at === above.of ? "green" : "neutral"]}>
            At or above the floor on {above.at} of {count(above.of, "day")}.
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Upper className="mr-1 text-[9px]">Misses · {windowLabel(review, filtered)}</Upper>
          <Pill label="Held" value={coverage.miss_held} tone="amber" />
          <Pill label="Written after our draft" value={coverage.miss_late} tone="amber" />
          <Pill label="Expired" value={coverage.miss_expired} tone="amber" />
          <Pill label="Failed" value={coverage.miss_failed} tone="amber" />
          <Pill label="Never seen" value={coverage.miss_unseen} tone="amber" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Upper className="mr-1 text-[9px]">Left out</Upper>
          <Pill label="Tutor wrote first" value={coverage.excluded_tutor_first} />
          <Pill label="Data quality" value={coverage.excluded_data_quality} />
          <Pill label="Tutor switched off" value={coverage.excluded_tutor_off} />
          <Pill label="Not live (shadow/off)" value={coverage.excluded_not_live} />
          <Pill label="Out of scope" value={coverage.excluded_scope} />
          <Pill label="Still in progress" value={coverage.pending} />
        </div>
      </Footer>
    </TrendCard>
  );
}

function SpeedCostCard({ trends }: { trends: AutowriterTrends }) {
  const { totals, days, range } = trends;
  const posted = totals.fromSummary + totals.fromTranscript;
  const median = totals.medianMinutesToPost;
  return (
    <TrendCard title="Speed & cost" subtitle="Class end → post in Wise · writer, judge and transcription spend"
      figure={(
        <div className="flex gap-[22px]">
          <Figure value={median === null ? "—" : (median < 60 ? median : median / 60).toFixed(1)} unit={median === null ? undefined : median < 60 ? "min" : "h"}
            caption={`${range.days}-day median`} />
          <Figure value={usdPerClass(totals.costPerClass)} caption="per posted class" />
        </div>
      )}>
      <Chart build={buildSpeedCostChartConfig} days={days}
        ariaLabel="Median minutes from class end to the post, and the cost per posted class, each with its 7-day average" />
      <Legend className="mt-2">
        <Key mark="line">Minutes to post · left axis</Key>
        <Key mark="line-second">Cost per class · right axis</Key>
      </Legend>
      <Footer>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span>
            Range: <b className="font-[550] text-foreground">{usd(totals.costUsd)}</b> spent · {count(posted, "class", "classes")} posted · p90{" "}
            <b className="font-[550] text-foreground">{minutes(totals.p90MinutesToPost)}</b>
          </span>
          <span>
            7-day: <b className="font-[550] text-foreground">{minutes(lastValue(days.map((day) => day.minutesToPost7d)))} · {usdPerClass(lastValue(days.map((day) => day.costPerClass7d)))}</b>
          </span>
        </div>
      </Footer>
    </TrendCard>
  );
}

const HOLD_BAR_TONE = ["bg-amber-500/70", "bg-amber-400/60", "bg-amber-300/70", "bg-amber-200", "bg-amber-100", "bg-muted"] as const;

function EvidenceCard({ trends }: { trends: AutowriterTrends }) {
  const { totals, days, range } = trends;
  const posted = totals.fromSummary + totals.fromTranscript;
  const written = totals.writers.sol + totals.writers.luna + totals.writers.glm;
  const holds = HOLD_REASON_CATEGORIES.map((category) => ({ category, held: totals.holdsByCategory[category] })).filter((entry) => entry.held > 0);
  const held = holds.reduce((sum, entry) => sum + entry.held, 0);
  return (
    <TrendCard title="Evidence & models" subtitle="What each post was written from · who wrote it"
      figure={<Figure value={percent(ratio(totals.fromTranscript, posted), 0)} caption={`${totals.fromTranscript} of ${posted} from the transcript`} />}>
      <Legend className="mt-3.5">
        <Key mark="bar">{SERIES.transcript}</Key>
        <Key mark="bar-muted">{SERIES.summary}</Key>
        <Key mark="line">{SERIES.transcriptShare}</Key>
      </Legend>
      <Chart build={buildEvidenceChartConfig} days={days} className="mt-2 h-[150px]"
        ariaLabel="Classes posted per day from the transcript and from the summary, and the 7-day transcript share" />
      <Footer>
        <div className="flex flex-wrap justify-between gap-x-[18px] gap-y-3">
          <div>
            <Upper className="mb-[7px] block text-[9px]">Writer · last {range.days} days</Upper>
            <div className="flex flex-wrap gap-[7px]">
              {(["sol", "luna", "glm"] as const).map((arm) => (
                <Pill key={arm} label={ARM_LABEL[arm]} value={<>{totals.writers[arm]} · {percent(ratio(totals.writers[arm], written), 0)}</>} />
              ))}
            </div>
          </div>
          <div className="min-w-[158px]">
            <Upper className="mb-[7px] block text-[9px]">{count(held, "hold")} · last {range.days} days</Upper>
            {held > 0 ? (
              <>
                <div className="flex flex-wrap gap-x-[9px] gap-y-1">
                  {holds.map((entry) => <span key={entry.category}>{HOLD_REASON_CATEGORY_LABELS[entry.category]} <b className="font-[550] text-foreground">{entry.held}</b></span>)}
                </div>
                <div aria-hidden className="mt-[9px] flex h-1 gap-0.5">
                  {holds.map((entry, index) => (
                    <span key={entry.category} className={cn("rounded-[2px]", HOLD_BAR_TONE[index])} style={{ width: `${(entry.held / held) * 100}%` }} />
                  ))}
                </div>
              </>
            ) : <span>No class was held.</span>}
          </div>
        </div>
      </Footer>
    </TrendCard>
  );
}

export function TrendCharts({ trends: answer, review, unavailableReason, rangeDays, onRangeChange, loading, filteredTo }: {
  /**
   * The series of the range and the tutor filter; the trends route's typed answer when the review tables are missing
   * (migration 0101 not applied); null when they could not load.
   */
  trends: AutowriterTrends | AutowriterReviewUnavailable | null;
  /** The review data (the footers read it), or null while it is unavailable. */
  review: AutowriterReview | null;
  unavailableReason: AutowriterReviewUnavailable["reason"] | null;
  rangeDays: TrendRangeDays;
  onRangeChange: (days: TrendRangeDays) => void;
  loading: boolean;
  /** The name of the tutor the page is filtered to: the series are theirs. */
  filteredTo: string | null;
}) {
  const trends = answer && !("available" in answer) ? answer : null;
  const missing = answer && "available" in answer ? answer.reason : null;
  const since = trends ? trendSinceNote(trends) : null;
  return (
    <section id="autowriter-trends" aria-labelledby="autowriter-trends-title" className="scroll-mt-4">
      <div className="mt-7 mb-[13px] flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h2 id="autowriter-trends-title" className="text-[15px] font-[650] tracking-[-0.02em]">How the pilot is trending</h2>
          <span className="text-[11px] text-muted-foreground">
            {trends ? `${dayMonth(trends.range.start)} – ${dayMonth(trends.range.end)} · Bangkok dates · ` : ""}
            {filteredTo ? `${filteredTo} only` : "all tutors"}
            {since ? ` · ${since}` : ""}
            {loading ? " · loading…" : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <Legend>
            <Key mark="dot">Daily points</Key>
            <Key mark="line">7-day moving average</Key>
          </Legend>
          <div className="flex rounded-md border bg-card p-0.5" role="group" aria-label="Range of the trend charts">
            {RANGES.map((days) => (
              <button key={days} type="button" aria-pressed={rangeDays === days} onClick={() => onRangeChange(days)}
                className={cn("rounded px-2 py-1 text-[11px] font-[550] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  rangeDays === days ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
                {days} days
              </button>
            ))}
          </div>
        </div>
      </div>
      {!review || missing ? <ReviewUnavailable reason={review ? missing : unavailableReason} /> : !trends ? (
        <p role="status" className="rounded-[10px] border bg-card px-4 py-8 text-center text-xs text-muted-foreground">
          The trend charts could not load. Refresh to try again; if it keeps failing, check the server logs.
        </p>
      ) : (
        <div className={cn("grid gap-[18px] lg:grid-cols-2", loading && "opacity-60")}>
          <AccuracyCard trends={trends} review={review} filtered={filteredTo !== null} />
          <CoverageCard trends={trends} review={review} filtered={filteredTo !== null} />
          <SpeedCostCard trends={trends} />
          <EvidenceCard trends={trends} />
        </div>
      )}
    </section>
  );
}
