import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AutowriterTrends } from "@/lib/feedback-autowriter/trends";
import { TrendCharts, daysAtFloor, trendSinceNote } from "../trend-charts";
import { reviewFixture, shortHistoryTrendsFixture, trendsFixture } from "./fixtures";

function render(options: { trends?: AutowriterTrends | null; review?: ReturnType<typeof reviewFixture> | null; rangeDays?: 14 | 30 | 90; filteredTo?: string | null; loading?: boolean } = {}): string {
  return renderToStaticMarkup(
    <TrendCharts trends={options.trends === undefined ? trendsFixture() : options.trends} review={options.review === undefined ? reviewFixture() : options.review}
      unavailableReason={options.review === null ? "load_failed" : null} rangeDays={options.rangeDays ?? 14} onRangeChange={() => undefined}
      loading={options.loading ?? false} filteredTo={options.filteredTo ?? null} />,
  );
}

describe("TrendCharts", () => {
  it("draws the four charts, each with its figure for the range", () => {
    const html = render();
    expect(html).toContain("How the pilot is trending");
    expect(html).toContain("23 Sep – 6 Oct · Bangkok dates · all tutors");
    expect(html.match(/<canvas/gu)).toHaveLength(4);
    expect(html).toContain("Accuracy &amp; gate");
    expect(html).toContain("90.1%");
    expect(html).toContain("46 of 51 reviewed");
    expect(html).toContain(">Coverage<");
    expect(html).toContain("76.7%");
    expect(html).toContain("86 of 112 eligible");
    expect(html).toContain("Speed &amp; cost");
    expect(html).toContain("14-day median");
    expect(html).toMatch(/12\.4<small[^>]*>min<\/small>/u);
    expect(html).toContain("per posted class");
    expect(html).toContain("Evidence &amp; models");
    expect(html).toContain("62%");
    expect(html).toContain("54 of 86 from the transcript");
  });

  it("explains every series in a legend outside the canvas", () => {
    const html = render();
    for (const label of [
      "Daily points", "7-day moving average", "14-day Wilson lower bound", "80% target", "Critical verdict", "70% minimum coverage",
      "Minutes to post · left axis", "Cost per class · right axis", "Transcript", "Summary only", "7-day transcript share",
    ]) expect(html).toContain(label);
    expect(html).toContain("LB today: 79%");
    expect(html).toContain("7-day average: 80.7%");
  });

  it("puts what the charts cannot show in the footers: the gate, fix rounds, misses and exclusions, totals, writers and holds", () => {
    const html = render();
    expect(html).toContain("Gate blocked until 13 Oct: critical on 29 Sep.");
    // From the review payload: the gate's 14 days, whatever the range.
    expect(html).toContain("Reviews · last 14 days");
    expect(html).toMatch(/Reviewed <strong[^>]*>51<\/strong>/u);
    expect(html).toMatch(/Waiting <strong[^>]*>3<\/strong>/u);
    expect(html).toMatch(/Flagged <strong[^>]*>1<\/strong>/u);
    expect(html).toMatch(/Critical <strong[^>]*>1<\/strong>/u);
    expect(html).toContain("Fix rounds per post · last 14 days");
    expect(html).toMatch(/None <strong[^>]*>38<\/strong>/u);
    expect(html).toMatch(/Unresolved <strong[^>]*>8<\/strong>/u);
    expect(html).toContain("Misses · last 14 days");
    for (const label of ["Held", "Written after our draft", "Expired", "Failed", "Never seen", "Tutor wrote first", "Data quality", "Tutor switched off", "Not live (shadow/off)", "Out of scope", "Still in progress"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("of which absence");
    expect(html).toContain("At or above the floor on 12 of 14 days.");
    // From the trends payload: the chosen range.
    expect(html).toContain("classes posted · p90");
    expect(html).toContain("1.2 h");
    expect(html).toContain("Writer · last 14 days");
    expect(html).toMatch(/GPT-6\.1 Sol <strong[^>]*>70 · 81%<\/strong>/u);
    expect(html).toMatch(/GPT-6 Luna <strong[^>]*>12 · 13%<\/strong>/u);
    expect(html).toMatch(/GLM Flash <strong[^>]*>4 · 4%<\/strong>/u);
    expect(html).toContain("9 holds · last 14 days");
    expect(html).toMatch(/Data quality <b[^>]*>5<\/b>/u);
    expect(html).toMatch(/Judge <b[^>]*>3<\/b>/u);
    expect(html).toMatch(/Validation <b[^>]*>1<\/b>/u);
    expect(html).not.toContain("Billing or form");
  });

  it("offers the 14, 30 and 90 day ranges and marks the one chosen", () => {
    const html = render({ rangeDays: 30, trends: trendsFixture(30) });
    expect(html).toMatch(/aria-pressed="false"[^>]*>14 days</u);
    expect(html).toMatch(/aria-pressed="true"[^>]*>30 days</u);
    expect(html).toMatch(/aria-pressed="false"[^>]*>90 days</u);
    expect(html).toContain("7 Sep – 6 Oct");
    // The series begin inside the range: the page says since when.
    expect(html).toContain("since 23 Sep");
    expect(html).toContain("Writer · last 30 days");
    // The review payload's footers do not follow the range.
    expect(html).toContain("Fix rounds per post · last 14 days");
  });

  it("says since when there is data, and that the 7-day lines are short, while history is short", () => {
    const html = render({ trends: shortHistoryTrendsFixture() });
    expect(html).toContain("since 5 Oct · the 7-day lines cover the 2 days there are");
    expect(html).toContain("No class was held.");
    expect(html).toContain("0 holds · last 14 days");
  });

  it("says whose series these are when the page is filtered to a tutor, and when they are reloading", () => {
    const anna = render({ filteredTo: "Anna" });
    expect(anna).toContain("Anna only");
    // The footers from the review payload stay the whole pilot's, and say so.
    expect(anna).toContain("Reviews · all tutors · last 14 days");
    expect(anna).toContain("Fix rounds per post · all tutors · last 14 days");
    expect(anna).toContain("Misses · all tutors · last 14 days");
    expect(anna).toContain("The pilot&#x27;s gate: Gate blocked until 13 Oct: critical on 29 Sep.");
    expect(render()).not.toContain("all tutors · last");
    expect(render({ loading: true })).toContain("loading…");
  });

  it("says so when the trends could not load, and shows the quality message when the review data is unavailable", () => {
    const noTrends = render({ trends: null });
    expect(noTrends).toContain("The trend charts could not load.");
    expect(noTrends).not.toContain("<canvas");
    expect(noTrends).toContain("14 days");
    const noReview = render({ review: null });
    expect(noReview).toContain("The quality data could not load.");
    expect(noReview).not.toContain("<canvas");
  });
});

describe("trendSinceNote", () => {
  const range = { start: "2026-09-23", end: "2026-10-06", days: 14 as const };

  it("says nothing when the history reaches back before the range", () => {
    expect(trendSinceNote({ since: "2026-09-10", range })).toBeNull();
    expect(trendSinceNote({ since: "2026-09-23", range })).toBeNull();
  });

  it("says since when, and how short the 7-day lines are, until there are 7 days of history", () => {
    expect(trendSinceNote({ since: "2026-09-29", range })).toBe("since 29 Sep");
    expect(trendSinceNote({ since: "2026-09-30", range })).toBe("since 30 Sep");
    expect(trendSinceNote({ since: "2026-10-01", range })).toBe("since 1 Oct · the 7-day lines cover the 6 days there are");
    expect(trendSinceNote({ since: "2026-10-06", range })).toBe("since 6 Oct · the 7-day lines cover the 1 day there is");
    expect(trendSinceNote({ since: null, range })).toBe("no data in this range yet");
  });
});

describe("daysAtFloor", () => {
  it("counts the days with a value that reached the floor, leaving out the days without one", () => {
    const days = trendsFixture(30).days;
    expect(daysAtFloor(days, 0.7)).toEqual({ at: 12, of: 14 });
    expect(daysAtFloor([], 0.7)).toEqual({ at: 0, of: 0 });
  });
});
