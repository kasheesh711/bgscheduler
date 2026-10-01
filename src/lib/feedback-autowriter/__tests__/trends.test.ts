import { describe, expect, it } from "vitest";
import { wilsonLowerBound } from "../quality";
import {
  TREND_LOOKBACK_DAYS,
  TREND_RANGES,
  buildAutowriterTrends,
  median,
  percentile,
  pooledRate,
  rollingWilson,
  type TrendDay,
  type TrendSourceRows,
} from "../trends";

describe("pooledRate", () => {
  it("sums the numerators and the denominators over the date and the six days before, then divides", () => {
    expect(pooledRate([1, 2, 3], [2, 2, 4], 2)).toBe(6 / 8);
    // A day with two classes cannot swing it: pooled 11/12, where the mean of the daily ratios would be 0.75.
    expect(pooledRate([1, 10], [2, 10], 1)).toBe(11 / 12);
    // Only the last seven entries count.
    const ones = Array.from({ length: 10 }, () => 1);
    expect(pooledRate([100, 100, 100, 1, 1, 1, 1, 1, 1, 1], ones.map(() => 2), 9)).toBe(7 / 14);
    expect(pooledRate([100, 100, 100, 1, 1, 1, 1, 1, 1, 1], ones, 9, 8)).toBe(107 / 8);
  });

  it("covers the days available when there are fewer than seven", () => {
    expect(pooledRate([3, 1], [4, 4], 0)).toBe(3 / 4);
    expect(pooledRate([3, 1], [4, 4], 1)).toBe(4 / 8);
    expect(pooledRate([3], [4], 0, 1)).toBe(3 / 4);
  });

  it("is null when the pooled denominator is 0, and skips a day without data inside the window", () => {
    expect(pooledRate([0, 0], [0, 0], 1)).toBeNull();
    expect(pooledRate([], [], 0)).toBeNull();
    // Entries past the end of the series are days without data.
    expect(pooledRate([1], [2], 5)).toBe(1 / 2);
    expect(pooledRate([1], [2], 7)).toBeNull();
    expect(pooledRate([2, 0, 0, 1], [2, 0, 0, 2], 3)).toBe(3 / 4);
    // A zero numerator over a real denominator is a real 0, not a gap.
    expect(pooledRate([0, 0], [3, 1], 1)).toBe(0);
  });
});

describe("rollingWilson", () => {
  it("is the Wilson lower bound of the counts pooled over the date and the 13 days before", () => {
    const accurate = [2, 0, 2, 0, 5];
    const reviewed = [3, 0, 2, 1, 5];
    expect(rollingWilson(accurate, reviewed, 0)).toBe(wilsonLowerBound(2, 3));
    expect(rollingWilson(accurate, reviewed, 3)).toBe(wilsonLowerBound(4, 6));
    expect(rollingWilson(accurate, reviewed, 4)).toBe(wilsonLowerBound(9, 11));
    expect(rollingWilson(accurate, reviewed, 4, 2)).toBe(wilsonLowerBound(5, 6));
    // Day 15 no longer counts day 1.
    const long = Array.from({ length: 15 }, () => 1);
    expect(rollingWilson([0, ...long.slice(1)], long, 14)).toBe(wilsonLowerBound(14, 14));
    expect(rollingWilson([0, ...long.slice(1)], long, 13)).toBe(wilsonLowerBound(13, 14));
  });

  it("is null when nothing was reviewed in the window — never a bound of 0", () => {
    expect(rollingWilson([0, 0], [0, 0], 1)).toBeNull();
    expect(rollingWilson([], [], 0)).toBeNull();
    // Reviewed, none accurate: a real 0.
    expect(rollingWilson([0], [4], 0)).toBe(0);
  });
});

describe("median and percentile", () => {
  it("takes the middle value, or the mean of the two middle ones", () => {
    expect(median([])).toBeNull();
    expect(median([3])).toBe(3);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([60, 10, 40, 35])).toBe(37.5);
    const values = [9, 1, 5];
    median(values);
    expect(values).toEqual([9, 1, 5]);
  });

  it("takes the nearest-rank percentile", () => {
    expect(percentile([], 90)).toBeNull();
    expect(percentile([7], 90)).toBe(7);
    const tenToOne = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(percentile(tenToOne, 90)).toBe(9);
    expect(percentile(tenToOne, 91)).toBe(10);
    expect(percentile(tenToOne, 50)).toBe(5);
    expect(percentile(tenToOne, 100)).toBe(10);
    expect(percentile(tenToOne, 0)).toBe(1);
    expect(percentile([40, 60, 35, 10, 90], 90)).toBe(90);
    expect(tenToOne[0]).toBe(10);
  });
});

// 12:00 in Bangkok on 6 Oct: the 14-day range is 23 Sep – 6 Oct, read from 10 Sep.
const NOW = new Date("2026-10-06T05:00:00.000Z");
const APPROVE = { verdict: "approve", severity: null } as const;
const COSMETIC = { verdict: "needs_fix", severity: "cosmetic" } as const;
const FACTUAL = { verdict: "needs_fix", severity: "factual" } as const;
const CRITICAL = { verdict: "needs_fix", severity: "critical" } as const;

type ClassRow = TrendSourceRows["classes"][number];
function posted(date: string, patch: Partial<ClassRow>): ClassRow {
  return { date, state: "verified", reason: "verified", arm: "sol", evidence: "summary", minutesToPost: null, costUsd: 0, ...patch };
}
function held(date: string, reason: string, costUsd: number): ClassRow {
  return { date, state: "held", reason, arm: null, evidence: "summary", minutesToPost: null, costUsd };
}

/** Live data from 29 Sep, as in production: a critical verdict, a day without classes (1 Oct), and nothing since 2 Oct. */
function source(overrides: Partial<TrendSourceRows> = {}): TrendSourceRows {
  return {
    now: NOW,
    days: 14,
    tutorKey: "*",
    metrics: [
      { date: "2026-09-29", posted: 4, eligible: 6 },
      { date: "2026-09-30", posted: 2, eligible: 2 },
      // The review job stores a row for every date, classes or not.
      { date: "2026-10-01", posted: 0, eligible: 0 },
      { date: "2026-10-02", posted: 1, eligible: 4 },
    ],
    reviews: [
      { date: "2026-09-29", inclusionReason: "new_tutor", verdict: APPROVE },
      { date: "2026-09-29", inclusionReason: "new_tutor", verdict: COSMETIC },
      { date: "2026-09-29", inclusionReason: "random_sample", verdict: CRITICAL },
      // A voluntary review of a post that was not sampled never counts; a required one without a verdict not yet.
      { date: "2026-09-29", inclusionReason: "not_sampled", verdict: APPROVE },
      { date: "2026-09-29", inclusionReason: "new_tutor", verdict: null },
      { date: "2026-09-30", inclusionReason: "new_tutor", verdict: APPROVE },
      { date: "2026-09-30", inclusionReason: "new_tutor", verdict: APPROVE },
      { date: "2026-10-02", inclusionReason: "new_tutor", verdict: FACTUAL },
      // A critical verdict counts whatever the sampling.
      { date: "2026-10-02", inclusionReason: "not_sampled", verdict: CRITICAL },
    ],
    classes: [
      posted("2026-09-29", { minutesToPost: 40, costUsd: 0.04 }),
      posted("2026-09-29", { arm: "luna", evidence: "transcript", minutesToPost: 60, costUsd: 0.11 }),
      held("2026-09-29", "sol:unfaithful:a claim", 0.05),
      held("2026-09-29", "recording_too_short", 0.02),
      { date: "2026-09-29", state: "skipped_human", reason: "human_submission", arm: null, evidence: "summary", minutesToPost: null, costUsd: 0 },
      posted("2026-09-30", { state: "awaiting_event", evidence: "transcript", minutesToPost: 35, costUsd: 0.1 }),
      posted("2026-09-30", { arm: "glm", minutesToPost: 10, costUsd: 0.01 }),
      posted("2026-10-02", { state: "posting", evidence: "transcript", minutesToPost: 90, costUsd: 0.12 }),
      held("2026-10-02", "error:boom", 0),
    ],
    ...overrides,
  };
}

const EMPTY_DAY: Omit<TrendDay, "date"> = {
  reviewed: 0, accurate: 0, critical: 0, accuracy: null, accuracy7d: null, wilson14d: null,
  posted: 0, eligible: 0, coverage: null, coverage7d: null,
  minutesToPost: null, minutesToPost7d: null, costUsd: 0, costPerClass: null, costPerClass7d: null,
  fromSummary: 0, fromTranscript: 0, transcriptShare7d: null, writers: { sol: 0, luna: 0, glm: 0 },
};

describe("buildAutowriterTrends", () => {
  const trends = buildAutowriterTrends(source());
  const day = (date: string) => trends.days.find((entry) => entry.date === date)!;

  it("has one entry per Bangkok date of the range, oldest first, ending today", () => {
    expect(trends).toMatchObject({
      generatedAt: "2026-10-06T05:00:00.000Z", tutorKey: "*", range: { start: "2026-09-23", end: "2026-10-06", days: 14 },
    });
    expect(trends.days.map((entry) => entry.date)).toEqual([
      "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29",
      "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06",
    ]);
    for (const days of TREND_RANGES) {
      const built = buildAutowriterTrends(source({ days }));
      expect(built.days).toHaveLength(days);
      expect(built.range).toEqual({ start: built.days[0].date, end: "2026-10-06", days });
    }
    // Just after midnight in Bangkok the range already ends on the new day.
    expect(buildAutowriterTrends(source({ now: new Date("2026-10-06T17:30:00.000Z") })).range.end).toBe("2026-10-07");
  });

  it("says since when there is data, and leaves the days before it as gaps — nulls, never zero ratios", () => {
    expect(trends.since).toBe("2026-09-29");
    for (const date of ["2026-09-23", "2026-09-28"]) expect(day(date)).toEqual({ date, ...EMPTY_DAY });
    expect(buildAutowriterTrends(source({ metrics: [], reviews: [], classes: [] })).since).toBeNull();
    // A stored metric row of a day without classes is not data.
    expect(buildAutowriterTrends(source({ metrics: [{ date: "2026-09-25", posted: 0, eligible: 0 }], reviews: [], classes: [] })).since).toBeNull();
  });

  it("counts accuracy from required reviews with a verdict, and critical verdicts whatever the sampling", () => {
    expect(day("2026-09-29")).toMatchObject({ reviewed: 3, accurate: 2, critical: 1, accuracy: 2 / 3, accuracy7d: 2 / 3, wilson14d: wilsonLowerBound(2, 3) });
    expect(day("2026-09-30")).toMatchObject({ reviewed: 2, accurate: 2, critical: 0, accuracy: 1, accuracy7d: 4 / 5, wilson14d: wilsonLowerBound(4, 5) });
    expect(day("2026-10-02")).toMatchObject({ reviewed: 1, accurate: 0, critical: 1, accuracy: 0, accuracy7d: 4 / 6, wilson14d: wilsonLowerBound(4, 6) });
  });

  it("keeps the pooled values going through a day without data, and drops a day once it leaves the window", () => {
    expect(day("2026-10-01")).toMatchObject({
      reviewed: 0, accuracy: null, accuracy7d: 4 / 5, wilson14d: wilsonLowerBound(4, 5),
      posted: 0, eligible: 0, coverage: null, coverage7d: 6 / 8,
      minutesToPost: null, minutesToPost7d: 37.5, costUsd: 0, costPerClass: null, costPerClass7d: 0.0825, transcriptShare7d: 2 / 4,
    });
    // 5 Oct still pools 29 Sep; 6 Oct no longer does. The 14-day bound keeps it.
    expect(day("2026-10-05")).toMatchObject({ accuracy: null, accuracy7d: 4 / 6, coverage7d: 7 / 12, minutesToPost7d: 40, costPerClass7d: 0.09, transcriptShare7d: 3 / 5 });
    expect(day("2026-10-06")).toMatchObject({
      accuracy7d: 2 / 3, wilson14d: wilsonLowerBound(4, 6), coverage7d: 3 / 6, minutesToPost7d: 35, costPerClass7d: 0.0767, transcriptShare7d: 2 / 3,
    });
  });

  it("takes coverage from the stored pair of the date", () => {
    expect(day("2026-09-29")).toMatchObject({ posted: 4, eligible: 6, coverage: 4 / 6, coverage7d: 4 / 6 });
    expect(day("2026-09-30")).toMatchObject({ posted: 2, eligible: 2, coverage: 1, coverage7d: 6 / 8 });
    expect(day("2026-10-02")).toMatchObject({ posted: 1, eligible: 4, coverage: 1 / 4, coverage7d: 7 / 12 });
  });

  it("measures speed, cost, evidence and writers over the classes posted with that class date", () => {
    expect(day("2026-09-29")).toMatchObject({
      minutesToPost: 50, minutesToPost7d: 50, costUsd: 0.22, costPerClass: 0.11, costPerClass7d: 0.11,
      fromSummary: 1, fromTranscript: 1, transcriptShare7d: 1 / 2, writers: { sol: 1, luna: 1, glm: 0 },
    });
    // A POST still awaiting its event counts as posted; the pooled median is over the classes, not the daily medians.
    expect(day("2026-09-30")).toMatchObject({
      minutesToPost: 22.5, minutesToPost7d: 37.5, costUsd: 0.11, costPerClass: 0.055, costPerClass7d: 0.0825,
      fromSummary: 1, fromTranscript: 1, transcriptShare7d: 2 / 4, writers: { sol: 1, luna: 0, glm: 1 },
    });
    expect(day("2026-10-02")).toMatchObject({
      minutesToPost: 90, minutesToPost7d: 40, costUsd: 0.12, costPerClass: 0.12, costPerClass7d: 0.09,
      fromSummary: 0, fromTranscript: 1, transcriptShare7d: 3 / 5, writers: { sol: 1, luna: 0, glm: 0 },
    });
  });

  it("totals the range: counts, the median and p90 over every posted class, cost, and holds by category", () => {
    expect(trends.totals).toEqual({
      reviewed: 6, accurate: 4, critical: 2, posted: 7, eligible: 12,
      medianMinutesToPost: 40, p90MinutesToPost: 90,
      costUsd: 0.45, costPerClass: 0.09,
      fromSummary: 2, fromTranscript: 3, writers: { sol: 3, luna: 1, glm: 1 },
      holdsByCategory: { data_quality: 1, judge: 1, validation: 0, billing_or_form: 0, error: 1, other: 0 },
    });
    const empty = buildAutowriterTrends(source({ metrics: [], reviews: [], classes: [] }));
    expect(empty.totals).toMatchObject({ reviewed: 0, posted: 0, medianMinutesToPost: null, p90MinutesToPost: null, costUsd: 0, costPerClass: null });
    expect(empty.days.every((entry) => entry.accuracy === null && entry.coverage === null && entry.wilson14d === null)).toBe(true);
  });

  it("uses the look-back for the rolling values of the first dates, but never for the days or the totals", () => {
    const base = source();
    const lookedBack = buildAutowriterTrends(source({
      reviews: [
        ...base.reviews,
        // 12 Sep: inside the 14-day window of 23 Sep (10–23 Sep), outside its 7-day one (17–23 Sep).
        { date: "2026-09-12", inclusionReason: "new_tutor", verdict: APPROVE },
        { date: "2026-09-12", inclusionReason: "new_tutor", verdict: FACTUAL },
        // 18 Sep: inside both.
        { date: "2026-09-18", inclusionReason: "new_tutor", verdict: APPROVE },
        // Before the first date read, and after today: ignored.
        { date: "2026-09-09", inclusionReason: "new_tutor", verdict: FACTUAL },
        { date: "2026-10-07", inclusionReason: "new_tutor", verdict: FACTUAL },
      ],
      metrics: [...base.metrics, { date: "2026-09-20", posted: 3, eligible: 4 }],
      classes: [...base.classes, posted("2026-09-22", { evidence: "transcript", minutesToPost: 15, costUsd: 0.2 }), held("2026-09-21", "speakers_unclear", 0.03)],
    }));
    expect(TREND_LOOKBACK_DAYS).toBe(13);
    expect(lookedBack.since).toBe("2026-09-12");
    expect(lookedBack.days[0]).toMatchObject({
      date: "2026-09-23", reviewed: 0, accuracy: null, accuracy7d: 1, wilson14d: wilsonLowerBound(2, 3),
      coverage: null, coverage7d: 3 / 4, minutesToPost: null, minutesToPost7d: 15, costUsd: 0, costPerClass7d: 0.23, transcriptShare7d: 1,
    });
    // 26 Sep: the 14-day window (13–26 Sep) has left 12 Sep behind.
    expect(lookedBack.days[3]).toMatchObject({ date: "2026-09-26", wilson14d: wilsonLowerBound(1, 1) });
    expect(lookedBack.totals).toEqual(trends.totals);
    expect(lookedBack.days).toHaveLength(14);
  });

  it("passes the tutor through", () => {
    expect(buildAutowriterTrends(source({ tutorKey: "Anna" })).tutorKey).toBe("Anna");
  });
});
