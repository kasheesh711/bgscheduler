import type { ChartConfiguration, ChartDataset, TooltipItem } from "chart.js";
import type { ChartThemeColors } from "@/components/sales-dashboard/chart-canvas";
import { GATE_THRESHOLDS, addDays } from "@/lib/feedback-autowriter/quality";
import type { AutowriterReview } from "@/lib/feedback-autowriter/review-data";
import type { TrendDay } from "@/lib/feedback-autowriter/trends";
import { dayMonth, minutes as minutesText, percent, threshold, usdPerClass } from "./format";

/**
 * The Chart.js configurations of the autowriter dashboard: the four trend charts and the rail's two mini charts.
 * Pure: a series and a palette in, a configuration out, so every dataset is unit-tested without a canvas.
 * A day without data is `null` in every series (`spanGaps: false`): a gap in the line, never a zero.
 */

/** The colours of a chart, all derived from the theme's tokens (`chartPalette`). */
export interface AutowriterChartColors {
  /** The 7-day lines of the rates and of the minutes to post. */
  line: string;
  /** The daily points of those series, and the thin line joining them. */
  point: string;
  pointLine: string;
  /** The Wilson lower bound and the cost per class, with their daily points. */
  second: string;
  secondPoint: string;
  secondPointLine: string;
  /** The dashed target lines. */
  target: string;
  /** A day with a critical verdict. */
  critical: string;
  /** The card behind the chart: the ring around a marker. */
  surface: string;
  grid: string;
  text: string;
  transcriptBar: string;
  summaryBar: string;
}

/** A colour with an alpha: `oklch(L C H)` tokens and hex fallbacks; anything else (already translucent) as it is. */
export function withAlpha(color: string, alpha: number): string {
  const value = color.trim();
  const hex = /^#([0-9a-f]{6})$/iu.exec(value);
  if (hex) {
    const channels = Number.parseInt(hex[1], 16);
    return `rgba(${channels >> 16}, ${(channels >> 8) & 255}, ${channels & 255}, ${alpha})`;
  }
  const oklch = /^oklch\(([^/)]+)\)$/iu.exec(value);
  return oklch ? `oklch(${oklch[1].trim()} / ${alpha})` : value;
}

/** The dashboard's palette from the theme's chart tokens (`chartColors()`), the conflict red and the card colour. */
export function chartPalette(theme: ChartThemeColors, extra: { conflict: string; card: string }): AutowriterChartColors {
  const [sky, , violet, green] = theme.chart;
  return {
    line: sky,
    point: withAlpha(sky, 0.45),
    pointLine: withAlpha(sky, 0.25),
    second: violet,
    secondPoint: withAlpha(violet, 0.45),
    secondPointLine: withAlpha(violet, 0.22),
    target: withAlpha(green, 0.85),
    critical: extra.conflict,
    surface: extra.card,
    grid: theme.border,
    text: theme.mutedForeground,
    transcriptBar: withAlpha(sky, 0.65),
    summaryBar: withAlpha(theme.mutedForeground, 0.22),
  };
}

/** The datasets' names: what the tooltips say and what the tests look datasets up by. */
export const SERIES = {
  dailyAccuracy: "Daily accuracy",
  accuracy7d: "7-day average",
  wilson: "14-day Wilson lower bound",
  passTarget: `${threshold(GATE_THRESHOLDS.passLowerBound)} target`,
  critical: "Critical verdict",
  dailyCoverage: "Daily coverage",
  coverage7d: "7-day average",
  coverageFloor: `${threshold(GATE_THRESHOLDS.minCoverage)} minimum coverage`,
  minutes: "Minutes to post",
  minutes7d: "Minutes to post · 7-day",
  cost: "Cost per class",
  cost7d: "Cost per class · 7-day",
  transcript: "Transcript",
  summary: "Summary only",
  transcriptShare: "7-day transcript share",
} as const;

type Series = Array<number | null>;
type LineDataset = ChartDataset<"line", Series>;

/** A smooth line without points: a moving average, a bound, a target. */
function line(label: string, data: Series, color: string, width: number, extra: Partial<LineDataset> = {}): LineDataset {
  return {
    type: "line", label, data, borderColor: color, backgroundColor: color, borderWidth: width, pointRadius: 0, pointHoverRadius: 0,
    tension: 0.3, spanGaps: false, clip: 8, ...extra,
  };
}

/** Daily values: points joined by a thin line that breaks at a day without data. */
function points(label: string, data: Series, color: string, joining: string, extra: Partial<LineDataset> = {}): LineDataset {
  return {
    type: "line", label, data, borderColor: joining, borderWidth: 1, backgroundColor: color, pointBackgroundColor: color, pointBorderColor: color,
    pointHoverBackgroundColor: color, pointHoverBorderColor: color, pointRadius: 3, pointHoverRadius: 4, tension: 0, spanGaps: false, clip: 8, ...extra,
  };
}

/** A dashed horizontal line at a threshold. */
function targetLine(label: string, value: number, length: number, colors: AutowriterChartColors): LineDataset {
  return line(label, Array.from({ length }, () => value), colors.target, 1, { borderDash: [4, 4], tension: 0 });
}

const COMMON = { responsive: true, maintainAspectRatio: false, animation: false } as const;

/**
 * Which dates of an axis are named: about five, counted back from the last one, so the latest date always is
 * (the first may not be; the section's heading gives the range).
 */
export function namedDates(labels: readonly string[]): (value: string | number, index: number) => string {
  const last = labels.length - 1;
  const step = Math.max(1, Math.ceil(last / 5));
  return (_value, index) => (last - index) % step === 0 ? labels[index] ?? "" : "";
}

function dateAxis(colors: AutowriterChartColors, labels: readonly string[], stacked = false) {
  return {
    stacked,
    border: { display: false },
    grid: { display: false },
    ticks: { color: colors.text, font: { size: 10 }, maxRotation: 0, autoSkip: false, callback: namedDates(labels) },
  };
}

/**
 * The floor of a percentage axis: the tenth below the lowest value shown, never above `ceiling` (so the usual band is
 * readable) and never below zero.
 */
export function percentAxisMin(series: readonly Series[], ceiling: number): number {
  const values = series.flat().filter((value): value is number => value !== null);
  const lowest = Math.min(ceiling, ...values);
  return Math.max(0, Math.floor(lowest * 10 + 1e-9) / 10);
}

function percentAxis(colors: AutowriterChartColors, min: number) {
  // Ten-point steps; twenty when the axis has to reach far down.
  const stepSize = 1 - min > 0.6 ? 0.2 : 0.1;
  return {
    min: stepSize === 0.2 ? Math.floor(min / 0.2 + 1e-9) * 0.2 : min,
    max: 1,
    border: { display: false },
    grid: { color: colors.grid },
    ticks: { color: colors.text, font: { size: 10 }, stepSize, callback: (value: string | number) => `${Math.round(Number(value) * 100)}%` },
  };
}

/** A tooltip that lists the day's series by `describe`; a series it returns null for is left out. */
function tooltip(describe: (item: TooltipItem<"line" | "bar">) => string | null) {
  return {
    mode: "index" as const,
    intersect: false,
    filter: (item: TooltipItem<"line" | "bar">) => describe(item) !== null,
    callbacks: { label: (item: TooltipItem<"line" | "bar">) => ` ${describe(item) ?? ""}` },
  };
}

const labelsOf = (days: readonly TrendDay[]) => days.map((day) => dayMonth(day.date));

/**
 * Accuracy and the gate: daily accuracy points, the 7-day average, the rolling 14-day Wilson lower bound, the dashed
 * pass bar, and a red marker on every day with a critical verdict: at that day's accuracy, on the average when the
 * day has none of its own, and on the axis's floor when it has neither (a critical verdict on a post that was not
 * sampled, in a week without a required review) — never at a value below the axis, where it would not be drawn.
 */
export function buildAccuracyChartConfig(days: readonly TrendDay[], colors: AutowriterChartColors): ChartConfiguration {
  const daily = days.map((day) => day.accuracy);
  const average = days.map((day) => day.accuracy7d);
  const wilson = days.map((day) => day.wilson14d);
  const axis = percentAxis(colors, percentAxisMin([daily, average, wilson], 0.6));
  const critical = days.map((day) => day.critical > 0 ? day.accuracy ?? day.accuracy7d ?? axis.min : null);
  return {
    type: "line",
    data: {
      labels: labelsOf(days),
      datasets: [
        {
          type: "line", label: SERIES.critical, data: critical, showLine: false, pointRadius: 5, pointHoverRadius: 6, pointBorderWidth: 2,
          pointBackgroundColor: colors.critical, pointBorderColor: colors.surface, pointHoverBackgroundColor: colors.critical,
          pointHoverBorderColor: colors.surface, borderColor: colors.critical, backgroundColor: colors.critical, clip: 8,
        },
        line(SERIES.accuracy7d, average, colors.line, 2.5),
        line(SERIES.wilson, wilson, colors.second, 2),
        points(SERIES.dailyAccuracy, daily, colors.point, colors.pointLine),
        targetLine(SERIES.passTarget, GATE_THRESHOLDS.passLowerBound, days.length, colors),
      ],
    },
    options: {
      ...COMMON,
      interaction: { mode: "index", intersect: false },
      scales: { x: dateAxis(colors, labelsOf(days)), y: axis },
      plugins: {
        legend: { display: false },
        tooltip: tooltip((item) => {
          const day = days[item.dataIndex];
          switch (item.dataset.label) {
            case SERIES.dailyAccuracy: return `${SERIES.dailyAccuracy}: ${percent(day.accuracy)} (${day.accurate} of ${day.reviewed} reviewed)`;
            case SERIES.accuracy7d: return `${SERIES.accuracy7d}: ${percent(day.accuracy7d)}`;
            case SERIES.wilson: return `${SERIES.wilson}: ${percent(day.wilson14d)}`;
            case SERIES.critical: return `${SERIES.critical}: ${day.critical}`;
            default: return null;
          }
        }),
      },
    },
  };
}

/** Coverage: daily posted ÷ eligible, the 7-day average and the dashed floor. */
export function buildCoverageChartConfig(days: readonly TrendDay[], colors: AutowriterChartColors): ChartConfiguration {
  const daily = days.map((day) => day.coverage);
  const average = days.map((day) => day.coverage7d);
  return {
    type: "line",
    data: {
      labels: labelsOf(days),
      datasets: [
        line(SERIES.coverage7d, average, colors.line, 2.5),
        points(SERIES.dailyCoverage, daily, colors.point, colors.pointLine),
        targetLine(SERIES.coverageFloor, GATE_THRESHOLDS.minCoverage, days.length, colors),
      ],
    },
    options: {
      ...COMMON,
      interaction: { mode: "index", intersect: false },
      scales: { x: dateAxis(colors, labelsOf(days)), y: percentAxis(colors, percentAxisMin([daily, average], 0.6)) },
      plugins: {
        legend: { display: false },
        tooltip: tooltip((item) => {
          const day = days[item.dataIndex];
          switch (item.dataset.label) {
            case SERIES.dailyCoverage: return `${SERIES.dailyCoverage}: ${percent(day.coverage)} (${day.posted} of ${day.eligible} eligible)`;
            case SERIES.coverage7d: return `${SERIES.coverage7d}: ${percent(day.coverage7d)}`;
            default: return null;
          }
        }),
      },
    },
  };
}

/** Speed and cost: the median minutes from class end to the post on the left axis, the cost per posted class on the right. */
export function buildSpeedCostChartConfig(days: readonly TrendDay[], colors: AutowriterChartColors): ChartConfiguration {
  return {
    type: "line",
    data: {
      labels: labelsOf(days),
      datasets: [
        line(SERIES.minutes7d, days.map((day) => day.minutesToPost7d), colors.line, 2.5, { yAxisID: "y" }),
        line(SERIES.cost7d, days.map((day) => day.costPerClass7d), colors.second, 2, { yAxisID: "y1" }),
        points(SERIES.minutes, days.map((day) => day.minutesToPost), colors.point, colors.pointLine, { yAxisID: "y" }),
        points(SERIES.cost, days.map((day) => day.costPerClass), colors.secondPoint, colors.secondPointLine, { yAxisID: "y1", pointRadius: 2.5 }),
      ],
    },
    options: {
      ...COMMON,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: dateAxis(colors, labelsOf(days)),
        y: {
          position: "left",
          beginAtZero: true,
          border: { display: false },
          grid: { color: colors.grid },
          ticks: { color: colors.text, font: { size: 10 }, maxTicksLimit: 6, callback: (value: string | number) => `${Number(value)}m` },
        },
        y1: {
          position: "right",
          beginAtZero: true,
          border: { display: false },
          grid: { drawOnChartArea: false },
          ticks: { color: colors.text, font: { size: 10 }, maxTicksLimit: 6, callback: (value: string | number) => usdPerClass(Number(value)) },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: tooltip((item) => {
          const day = days[item.dataIndex];
          switch (item.dataset.label) {
            case SERIES.minutes: return `${SERIES.minutes}: ${minutesText(day.minutesToPost)} (median)`;
            case SERIES.minutes7d: return `${SERIES.minutes7d}: ${minutesText(day.minutesToPost7d)}`;
            case SERIES.cost: return `${SERIES.cost}: ${usdPerClass(day.costPerClass)}`;
            case SERIES.cost7d: return `${SERIES.cost7d}: ${usdPerClass(day.costPerClass7d)}`;
            default: return null;
          }
        }),
      },
    },
  };
}

/** Evidence: stacked bars of the classes posted from the transcript and from the summary, and the 7-day transcript share. */
export function buildEvidenceChartConfig(days: readonly TrendDay[], colors: AutowriterChartColors): ChartConfiguration {
  // A day without a post has no bar at all.
  const bar = (pick: (day: TrendDay) => number) => days.map((day) => day.fromSummary + day.fromTranscript > 0 ? pick(day) : null);
  return {
    type: "bar",
    data: {
      labels: labelsOf(days),
      datasets: [
        line(SERIES.transcriptShare, days.map((day) => day.transcriptShare7d), colors.line, 2.2, { yAxisID: "y1" }),
        {
          type: "bar", label: SERIES.transcript, data: bar((day) => day.fromTranscript), backgroundColor: colors.transcriptBar,
          hoverBackgroundColor: colors.transcriptBar, stack: "evidence", yAxisID: "y", maxBarThickness: 22,
        },
        {
          type: "bar", label: SERIES.summary, data: bar((day) => day.fromSummary), backgroundColor: colors.summaryBar,
          hoverBackgroundColor: colors.summaryBar, stack: "evidence", yAxisID: "y", maxBarThickness: 22, borderRadius: { topLeft: 2, topRight: 2 },
        },
      ],
    },
    options: {
      ...COMMON,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: dateAxis(colors, labelsOf(days), true),
        y: {
          stacked: true,
          position: "left",
          beginAtZero: true,
          border: { display: false },
          grid: { color: colors.grid },
          ticks: { color: colors.text, font: { size: 10 }, precision: 0, maxTicksLimit: 5 },
        },
        y1: {
          position: "right",
          min: 0,
          max: 1,
          border: { display: false },
          grid: { drawOnChartArea: false },
          ticks: { color: colors.text, font: { size: 10 }, stepSize: 0.5, callback: (value: string | number) => `${Math.round(Number(value) * 100)}%` },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: tooltip((item) => {
          const day = days[item.dataIndex];
          switch (item.dataset.label) {
            case SERIES.transcript: return `${SERIES.transcript}: ${day.fromTranscript}`;
            case SERIES.summary: return `${SERIES.summary}: ${day.fromSummary}`;
            case SERIES.transcriptShare: return `${SERIES.transcriptShare}: ${percent(day.transcriptShare7d, 0)}`;
            default: return null;
          }
        }),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The health rail's mini charts: the gate window's 14 days, all tutors
// ---------------------------------------------------------------------------

/** The gate window day by day, oldest first: what the rail's two mini charts draw. */
export interface RailSeries {
  /** The window's dates as "23 Sep". */
  labels: string[];
  accuracy: Series;
  accuracy7d: Series;
  coverage: Series;
  coverage7d: Series;
  /** A critical verdict on a class of that date. */
  critical: boolean[];
}

/** Σ numerators ÷ Σ denominators over an entry and the `span − 1` before it (fewer at the start); null over nothing. */
function pooled(numerators: readonly number[], denominators: readonly number[], index: number, span: number): number | null {
  let numerator = 0;
  let denominator = 0;
  for (let at = Math.max(0, index - span + 1); at <= index; at += 1) {
    numerator += numerators[at];
    denominator += denominators[at];
  }
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * The review payload's daily rows as series over every date of its window. A date without a row, or without reviews
 * (or eligible classes), is a gap. The 7-day values pool the date and the six before it inside the window.
 */
export function railSeries(review: Pick<AutowriterReview, "window" | "daily">): RailSeries {
  const dates: string[] = [];
  for (let date = review.window.start; date <= review.window.end; date = addDays(date, 1)) dates.push(date);
  const rows = new Map(review.daily.map((row) => [row.date, row]));
  const column = (pick: (row: AutowriterReview["daily"][number]) => number) => dates.map((date) => {
    const row = rows.get(date);
    return row ? pick(row) : 0;
  });
  const reviewed = column((row) => row.reviewed);
  const accurate = column((row) => row.accurate);
  const posted = column((row) => row.posted);
  const eligible = column((row) => row.eligible);
  return {
    labels: dates.map(dayMonth),
    accuracy: dates.map((_, index) => pooled(accurate, reviewed, index, 1)),
    accuracy7d: dates.map((_, index) => pooled(accurate, reviewed, index, 7)),
    coverage: dates.map((_, index) => pooled(posted, eligible, index, 1)),
    coverage7d: dates.map((_, index) => pooled(posted, eligible, index, 7)),
    critical: column((row) => row.critical).map((count) => count > 0),
  };
}

/** The latest value of a series that has one; null when it has none. */
export function lastValue(series: Series): number | null {
  return series.findLast((value): value is number => value !== null) ?? null;
}

/**
 * A rail mini chart: daily points, the 7-day line and the dashed target, with only the first and last date on the
 * axis. `critical` marks days in red (the accuracy chart): at the day's value, on the 7-day line, or on the axis's
 * floor when the day has neither.
 */
export function buildMiniRateChartConfig(
  input: { labels: readonly string[]; daily: Series; average: Series; target: number; critical?: readonly boolean[] },
  colors: AutowriterChartColors,
): ChartConfiguration {
  const last = input.labels.length - 1;
  const floor = percentAxisMin([input.daily, input.average, [input.target - 0.1]], 1);
  const marked = input.critical ? input.daily.map((value, index) => input.critical?.[index] ? value ?? input.average[index] ?? floor : null) : null;
  return {
    type: "line",
    data: {
      labels: [...input.labels],
      datasets: [
        ...(marked ? [{
          type: "line" as const, label: SERIES.critical, data: marked, showLine: false, pointRadius: 4, pointHoverRadius: 4, pointBorderWidth: 1.5,
          pointBackgroundColor: colors.critical, pointBorderColor: colors.surface, pointHoverBackgroundColor: colors.critical,
          pointHoverBorderColor: colors.surface, borderColor: colors.critical, backgroundColor: colors.critical, clip: 8,
        }] : []),
        line("7-day average", input.average, colors.line, 2.3),
        points("Daily value", input.daily, colors.point, colors.pointLine, { pointRadius: 2.5, pointHoverRadius: 2.5 }),
        targetLine("Target", input.target, input.labels.length, colors),
      ],
    },
    options: {
      ...COMMON,
      events: [],
      scales: {
        x: {
          border: { display: false },
          grid: { display: false },
          ticks: {
            color: colors.text, font: { size: 10 }, maxRotation: 0, autoSkip: false, align: "inner",
            callback: (_value: string | number, index: number) => index === 0 || index === last ? input.labels[index] : "",
          },
        },
        y: {
          min: floor,
          max: 1,
          border: { display: false },
          grid: { color: colors.grid },
          ticks: { display: false, maxTicksLimit: 4 },
        },
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  };
}
