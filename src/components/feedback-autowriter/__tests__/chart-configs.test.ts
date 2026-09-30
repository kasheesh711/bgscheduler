import type { ChartConfiguration } from "chart.js";
import { describe, expect, it } from "vitest";
import type { TrendDay } from "@/lib/feedback-autowriter/trends";
import {
  SERIES,
  buildAccuracyChartConfig,
  buildCoverageChartConfig,
  buildEvidenceChartConfig,
  buildMiniRateChartConfig,
  buildSpeedCostChartConfig,
  chartPalette,
  lastValue,
  namedDates,
  percentAxisMin,
  railSeries,
  withAlpha,
  type AutowriterChartColors,
} from "../chart-configs";
import { reviewFixture, trendsFixture } from "./fixtures";

const THEME = {
  chart: ["oklch(0.55 0.14 230)", "oklch(0.65 0.1 75)", "oklch(0.5 0.1 300)", "oklch(0.6 0.15 155)", "oklch(0.45 0.08 250)"],
  border: "oklch(0.91 0.008 85)",
  mutedForeground: "oklch(0.5 0.01 250)",
};
const COLORS: AutowriterChartColors = chartPalette(THEME, { conflict: "oklch(0.65 0.2 25)", card: "oklch(0.993 0.003 85)" });

type Dataset = Record<string, unknown> & { label: string; data: Array<number | null> };
const datasets = (config: ChartConfiguration) => config.data.datasets as unknown as Dataset[];
const dataset = (config: ChartConfiguration, label: string) => {
  const found = datasets(config).filter((entry) => entry.label === label);
  if (found.length !== 1) throw new Error(`expected one dataset named ${label}, found ${found.length}`);
  return found[0];
};
type Scale = Record<string, unknown> & { ticks: { callback?: (value: number, index: number) => string } };
const scales = (config: ChartConfiguration) => (config.options as { scales: Record<string, Scale> }).scales;
type TooltipOptions = { filter: (item: unknown) => boolean; callbacks: { label: (item: unknown) => string } };
const tooltipOf = (config: ChartConfiguration) => (config.options as unknown as { plugins: { tooltip: TooltipOptions } }).plugins.tooltip;
const tip = (config: ChartConfiguration, label: string, dataIndex: number) => {
  const item = { dataIndex, dataset: { label } };
  return tooltipOf(config).filter(item) ? tooltipOf(config).callbacks.label(item) : null;
};

/** One day of a series: nothing happened unless the patch says so. */
function day(date: string, patch: Partial<TrendDay> = {}): TrendDay {
  return {
    date, reviewed: 0, accurate: 0, critical: 0, accuracy: null, accuracy7d: null, wilson14d: null, posted: 0, eligible: 0, coverage: null, coverage7d: null,
    minutesToPost: null, minutesToPost7d: null, costUsd: 0, costPerClass: null, costPerClass7d: null, fromSummary: 0, fromTranscript: 0, transcriptShare7d: null,
    writers: { sol: 0, luna: 0, glm: 0 }, ...patch,
  };
}

const DAYS: TrendDay[] = [
  day("2026-10-01", { reviewed: 4, accurate: 3, accuracy: 0.75, accuracy7d: 0.75, wilson14d: 0.3, posted: 3, eligible: 4, coverage: 0.75, coverage7d: 0.75, minutesToPost: 12, minutesToPost7d: 12, costUsd: 0.12, costPerClass: 0.04, costPerClass7d: 0.04, fromSummary: 1, fromTranscript: 2, transcriptShare7d: 2 / 3 }),
  // A day without a class: a gap in every series.
  day("2026-10-02", { accuracy7d: 0.75, wilson14d: 0.3, coverage7d: 0.75, minutesToPost7d: 12, costPerClass7d: 0.04, transcriptShare7d: 2 / 3 }),
  // A critical verdict on a day with reviews.
  day("2026-10-03", { reviewed: 2, accurate: 1, critical: 1, accuracy: 0.5, accuracy7d: 4 / 6, wilson14d: 0.3, posted: 2, eligible: 2, coverage: 1, coverage7d: 5 / 6, minutesToPost: 80, minutesToPost7d: 40, costUsd: 0.1, costPerClass: 0.05, costPerClass7d: 0.044, fromSummary: 2, fromTranscript: 0, transcriptShare7d: 0.4 }),
  // A critical verdict on a post that was not sampled: no accuracy of its own that day.
  day("2026-10-04", { critical: 2, accuracy7d: 4 / 6, wilson14d: 0.3 }),
];

describe("the palette", () => {
  it("adds an alpha to a theme token and to a fallback hex, and leaves a translucent colour alone", () => {
    expect(withAlpha("oklch(0.55 0.14 230)", 0.4)).toBe("oklch(0.55 0.14 230 / 0.4)");
    expect(withAlpha("#3b82f6", 0.5)).toBe("rgba(59, 130, 246, 0.5)");
    expect(withAlpha("oklch(1 0 0 / 10%)", 0.4)).toBe("oklch(1 0 0 / 10%)");
    expect(withAlpha("rebeccapurple", 0.4)).toBe("rebeccapurple");
  });

  it("derives every colour from the theme's tokens", () => {
    expect(COLORS).toMatchObject({
      line: THEME.chart[0], second: THEME.chart[2], critical: "oklch(0.65 0.2 25)", surface: "oklch(0.993 0.003 85)", grid: THEME.border, text: THEME.mutedForeground,
      point: "oklch(0.55 0.14 230 / 0.45)", target: "oklch(0.6 0.15 155 / 0.85)",
    });
  });
});

describe("percentAxisMin", () => {
  it("starts a percentage axis a tenth below the lowest value, within the usual band and never below zero", () => {
    expect(percentAxisMin([[0.84, 0.9, null], [0.79]], 0.6)).toBe(0.6);
    expect(percentAxisMin([[0.84, 0.52, null]], 0.6)).toBe(0.5);
    expect(percentAxisMin([[0, 1]], 0.6)).toBe(0);
    expect(percentAxisMin([[null], []], 0.6)).toBe(0.6);
    expect(percentAxisMin([[0.7]], 0.6)).toBe(0.6);
  });
});

describe("namedDates", () => {
  it("names about five dates of an axis, always the last one", () => {
    const named = (count: number) => {
      const labels = Array.from({ length: count }, (_, index) => `d${index}`);
      return labels.map((label, index) => namedDates(labels)(label, index)).filter(Boolean);
    };
    expect(named(14)).toEqual(["d1", "d4", "d7", "d10", "d13"]);
    expect(named(30)).toEqual(["d5", "d11", "d17", "d23", "d29"]);
    expect(named(90)).toEqual(["d17", "d35", "d53", "d71", "d89"]);
    expect(named(3)).toEqual(["d0", "d1", "d2"]);
    expect(named(1)).toEqual(["d0"]);
    expect(named(0)).toEqual([]);
  });
});

describe("buildAccuracyChartConfig", () => {
  const config = buildAccuracyChartConfig(DAYS, COLORS);

  it("draws the daily points, the 7-day line and the 14-day lower bound, leaving a day without data as a gap", () => {
    expect(config.data.labels).toEqual(["1 Oct", "2 Oct", "3 Oct", "4 Oct"]);
    expect(dataset(config, SERIES.dailyAccuracy)).toMatchObject({ data: [0.75, null, 0.5, null], spanGaps: false, pointRadius: 3 });
    expect(dataset(config, SERIES.accuracy7d)).toMatchObject({ data: [0.75, 0.75, 4 / 6, 4 / 6], pointRadius: 0, borderColor: COLORS.line, spanGaps: false });
    expect(dataset(config, SERIES.wilson)).toMatchObject({ data: [0.3, 0.3, 0.3, 0.3], borderColor: COLORS.second });
    // Never a zero where there is nothing.
    expect(datasets(config).flatMap((entry) => entry.data)).not.toContain(0);
  });

  it("draws the 80% bar as a dashed line across the whole range", () => {
    expect(dataset(config, "80% target")).toMatchObject({ data: [0.8, 0.8, 0.8, 0.8], borderDash: [4, 4], pointRadius: 0, borderColor: COLORS.target });
  });

  it("marks a day with a critical verdict in red: at its accuracy, or on the average when it has none", () => {
    const marker = dataset(config, SERIES.critical);
    expect(marker.data).toEqual([null, null, 0.5, 4 / 6]);
    expect(marker).toMatchObject({ showLine: false, pointBackgroundColor: COLORS.critical, pointBorderColor: COLORS.surface, pointRadius: 5 });
    // The marker is drawn over the lines: it comes first.
    expect(datasets(config)[0].label).toBe(SERIES.critical);
    // No critical verdict anywhere: no marker at all.
    expect(dataset(buildAccuracyChartConfig(DAYS.slice(0, 2), COLORS), SERIES.critical).data).toEqual([null, null]);
  });

  it("keeps the marker on the chart when its day has neither an accuracy nor an average: on the axis's floor", () => {
    // A critical verdict on a post that was not sampled, in a week without a required review: nothing to sit on.
    const days = [
      day("2026-10-01", { reviewed: 5, accurate: 5, accuracy: 1, accuracy7d: 1, wilson14d: 0.9 }),
      day("2026-10-09", { critical: 1, wilson14d: 0.9 }),
    ];
    const lonely = buildAccuracyChartConfig(days, COLORS);
    const floor = scales(lonely).y.min;
    // The axis does not reach down for the marker (zero is not an accuracy), and the marker is not below the axis.
    expect(floor).toBe(0.6);
    expect(dataset(lonely, SERIES.critical).data).toEqual([null, floor]);
    // The floor follows the axis when the values pull it down, in the twenty-point steps of a long axis too.
    const low = buildAccuracyChartConfig([day("2026-10-01", { reviewed: 4, accurate: 1, accuracy: 0.25, accuracy7d: 0.25, wilson14d: 0.1 }), days[1]], COLORS);
    expect(scales(low).y.min).toBe(0);
    expect(dataset(low, SERIES.critical).data).toEqual([null, 0]);
    const mid = buildAccuracyChartConfig([day("2026-10-01", { reviewed: 2, accurate: 1, accuracy: 0.5, accuracy7d: 0.5, wilson14d: 0.35 }), days[1]], COLORS);
    expect(dataset(mid, SERIES.critical).data).toEqual([null, scales(mid).y.min]);
    expect(scales(mid).y.min).toBeCloseTo(0.2);
  });

  it("reaches down to the lowest value shown and says what a day's numbers are", () => {
    expect(scales(config).y).toMatchObject({ min: 0.2, max: 1 });
    expect(scales(config).y.ticks.callback?.(0.8, 0)).toBe("80%");
    // Four days: every date is named, the last one for sure.
    expect([0, 1, 2, 3].map((index) => scales(config).x.ticks.callback?.(index, index))).toEqual(["1 Oct", "2 Oct", "3 Oct", "4 Oct"]);
    expect(scales(buildAccuracyChartConfig([day("2026-10-01", { accuracy: 0.9, accuracy7d: 0.9, wilson14d: 0.75 })], COLORS)).y).toMatchObject({ min: 0.6, max: 1 });
    expect(tip(config, SERIES.dailyAccuracy, 0)).toBe(" Daily accuracy: 75% (3 of 4 reviewed)");
    expect(tip(config, SERIES.dailyAccuracy, 1)).toBe(" Daily accuracy: — (0 of 0 reviewed)");
    expect(tip(config, SERIES.wilson, 0)).toBe(" 14-day Wilson lower bound: 30%");
    expect(tip(config, SERIES.critical, 3)).toBe(" Critical verdict: 2");
    // The target line is not a reading of the day.
    expect(tip(config, "80% target", 0)).toBeNull();
  });
});

describe("buildCoverageChartConfig", () => {
  const config = buildCoverageChartConfig(DAYS, COLORS);

  it("draws daily coverage, its 7-day line and the dashed 70% floor, with gaps for days without a class", () => {
    expect(dataset(config, SERIES.dailyCoverage).data).toEqual([0.75, null, 1, null]);
    expect(dataset(config, SERIES.coverage7d).data).toEqual([0.75, 0.75, 5 / 6, null]);
    expect(dataset(config, "70% minimum coverage")).toMatchObject({ data: [0.7, 0.7, 0.7, 0.7], borderDash: [4, 4] });
    expect(scales(config).y).toMatchObject({ min: 0.6, max: 1 });
    expect(tip(config, SERIES.dailyCoverage, 0)).toBe(" Daily coverage: 75% (3 of 4 eligible)");
  });
});

describe("buildSpeedCostChartConfig", () => {
  const config = buildSpeedCostChartConfig(DAYS, COLORS);

  it("puts the minutes on the left axis and the cost on the right one", () => {
    expect(dataset(config, SERIES.minutes)).toMatchObject({ data: [12, null, 80, null], yAxisID: "y" });
    expect(dataset(config, SERIES.minutes7d)).toMatchObject({ data: [12, 12, 40, null], yAxisID: "y", borderColor: COLORS.line });
    expect(dataset(config, SERIES.cost)).toMatchObject({ data: [0.04, null, 0.05, null], yAxisID: "y1" });
    expect(dataset(config, SERIES.cost7d)).toMatchObject({ data: [0.04, 0.04, 0.044, null], yAxisID: "y1", borderColor: COLORS.second });
    expect(scales(config).y).toMatchObject({ position: "left", beginAtZero: true });
    expect(scales(config).y1).toMatchObject({ position: "right", grid: { drawOnChartArea: false } });
    expect(scales(config).y.ticks.callback?.(12, 0)).toBe("12m");
    expect(scales(config).y1.ticks.callback?.(0.04, 0)).toBe("$0.040");
    expect(tip(config, SERIES.minutes, 2)).toBe(" Minutes to post: 1.3 h (median)");
    expect(tip(config, SERIES.cost7d, 2)).toBe(" Cost per class · 7-day: $0.044");
  });
});

describe("buildEvidenceChartConfig", () => {
  const config = buildEvidenceChartConfig(DAYS, COLORS);

  it("stacks the classes posted from the transcript and from the summary, with no bar on a day without a post", () => {
    expect(config.type).toBe("bar");
    const transcript = dataset(config, SERIES.transcript);
    const summary = dataset(config, SERIES.summary);
    expect(transcript).toMatchObject({ type: "bar", data: [2, null, 0, null], stack: "evidence", yAxisID: "y" });
    expect(summary).toMatchObject({ type: "bar", data: [1, null, 2, null], stack: "evidence", yAxisID: "y" });
    expect(scales(config).x).toMatchObject({ stacked: true });
    expect(scales(config).y).toMatchObject({ stacked: true, beginAtZero: true });
  });

  it("draws the 7-day transcript share as a line on its own 0–100% axis", () => {
    expect(dataset(config, SERIES.transcriptShare)).toMatchObject({ type: "line", data: [2 / 3, 2 / 3, 0.4, null], yAxisID: "y1", spanGaps: false });
    expect(scales(config).y1).toMatchObject({ position: "right", min: 0, max: 1 });
    expect(scales(config).y1.ticks.callback?.(0.5, 0)).toBe("50%");
    expect(tip(config, SERIES.transcriptShare, 2)).toBe(" 7-day transcript share: 40%");
    expect(tip(config, SERIES.summary, 2)).toBe(" Summary only: 2");
  });
});

describe("the rail's mini charts", () => {
  it("turns the review payload's daily rows into series over every date of the window", () => {
    const series = railSeries(reviewFixture());
    expect(series.labels).toHaveLength(14);
    expect(series.labels[0]).toBe("23 Sep");
    expect(series.labels.at(-1)).toBe("6 Oct");
    expect(series.accuracy[0]).toBe(1);
    expect(series.accuracy[6]).toBe(0.5);
    expect(series.critical).toEqual([false, false, false, false, false, false, true, false, false, false, false, false, false, false]);
    // Nothing before the window here: the first 7-day value pools the one day there is; the last pools the last seven.
    expect(series.accuracy7d[0]).toBe(1);
    expect(series.accuracy7d.at(-1)).toBeCloseTo((3 + 4 + 3 + 4 + 4 + 4 + 1) / (3 + 4 + 4 + 4 + 4 + 4 + 2), 10);
    expect(series.coverage7d.at(-1)).toBeCloseTo((6 + 7 + 6 + 7 + 6 + 7 + 7) / (8 + 9 + 8 + 8 + 8 + 8 + 8), 10);
    expect(lastValue(series.coverage7d)).toBe(series.coverage7d.at(-1));
  });

  it("leaves a date without a row, or without reviews, as a gap", () => {
    const review = reviewFixture();
    const series = railSeries({
      window: { start: "2026-10-03", end: "2026-10-06", days: 4 },
      daily: [
        { ...review.daily[0], date: "2026-10-06", reviewed: 0, accurate: 0, posted: 2, eligible: 4, critical: 0 },
        { ...review.daily[0], date: "2026-10-04", reviewed: 2, accurate: 1, posted: 0, eligible: 0, critical: 0 },
      ],
      lookback: [],
    });
    expect(series.labels).toEqual(["3 Oct", "4 Oct", "5 Oct", "6 Oct"]);
    expect(series.accuracy).toEqual([null, 0.5, null, null]);
    expect(series.accuracy7d).toEqual([null, 0.5, 0.5, 0.5]);
    expect(series.coverage).toEqual([null, null, null, 0.5]);
    expect(series.coverage7d).toEqual([null, null, null, 0.5]);
    expect(lastValue(series.accuracy)).toBe(0.5);
    expect(lastValue([null, null])).toBeNull();
    expect(railSeries({ window: { start: "2026-10-05", end: "2026-10-06", days: 2 }, daily: [], lookback: [] }).accuracy7d).toEqual([null, null]);
  });

  it("pools the window's first dates with the six dates before it, as the trend charts do", () => {
    const review = reviewFixture();
    const row = (date: string, reviewed: number, accurate: number, posted: number, eligible: number) => ({ ...review.daily[0], date, reviewed, accurate, posted, eligible, critical: 0 });
    const series = railSeries({
      window: { start: "2026-10-05", end: "2026-10-06", days: 2 },
      daily: [row("2026-10-06", 2, 1, 3, 4), row("2026-10-05", 4, 4, 2, 4)],
      lookback: [
        // Seven days before 5 Oct: no part of its 7-day value (29 Sep – 5 Oct), nor of anything else.
        { date: "2026-09-28", reviewed: 100, accurate: 0, posted: 0, eligible: 100 },
        { date: "2026-09-29", reviewed: 4, accurate: 2, posted: 1, eligible: 4 },
        { date: "2026-10-02", reviewed: 2, accurate: 2, posted: 4, eligible: 4 },
      ],
    });
    // Only the window's dates are drawn, with their own daily values.
    expect(series.labels).toEqual(["5 Oct", "6 Oct"]);
    expect(series.accuracy).toEqual([1, 0.5]);
    expect(series.coverage).toEqual([0.5, 0.75]);
    // 5 Oct pools 29 Sep – 5 Oct; 6 Oct pools 30 Sep – 6 Oct (29 Sep has left it).
    expect(series.accuracy7d).toEqual([(2 + 2 + 4) / (4 + 2 + 4), (2 + 4 + 1) / (2 + 4 + 2)]);
    expect(series.coverage7d).toEqual([(1 + 4 + 2) / (4 + 4 + 4), (4 + 2 + 3) / (4 + 4 + 4)]);
    expect(series.critical).toEqual([false, false]);
  });

  it("draws a mini chart with only its first and last date, its target and its critical days", () => {
    const series = railSeries(reviewFixture());
    const config = buildMiniRateChartConfig({ labels: series.labels, daily: series.accuracy, average: series.accuracy7d, target: 0.8, critical: series.critical }, COLORS);
    expect(dataset(config, "Target")).toMatchObject({ borderDash: [4, 4], data: Array.from({ length: 14 }, () => 0.8) });
    expect(dataset(config, SERIES.critical).data.filter((value) => value !== null)).toEqual([0.5]);
    const tick = scales(config).x.ticks.callback!;
    expect([tick(0, 0), tick(5, 5), tick(13, 13)]).toEqual(["23 Sep", "", "6 Oct"]);
    // A critical day with no value and no average sits on the axis's floor, never below it.
    const lonely = buildMiniRateChartConfig({ labels: ["5 Oct", "6 Oct"], daily: [0.9, null], average: [0.9, null], target: 0.8, critical: [false, true] }, COLORS);
    expect(scales(lonely).y.min).toBe(0.7);
    expect(dataset(lonely, SERIES.critical).data).toEqual([null, 0.7]);
    // The coverage chart marks nothing.
    const coverage = buildMiniRateChartConfig({ labels: series.labels, daily: series.coverage, average: series.coverage7d, target: 0.7 }, COLORS);
    expect(datasets(coverage).map((entry) => entry.label)).toEqual(["7-day average", "Daily value", "Target"]);
    expect(scales(coverage).y).toMatchObject({ min: 0.6, max: 1 });
  });
});

describe("the fixture the visual check renders", () => {
  it("has a series for each chart", () => {
    const { days } = trendsFixture();
    expect(days).toHaveLength(14);
    for (const build of [buildAccuracyChartConfig, buildCoverageChartConfig, buildSpeedCostChartConfig, buildEvidenceChartConfig]) {
      expect(build(days, COLORS).data.labels).toHaveLength(14);
    }
  });
});
