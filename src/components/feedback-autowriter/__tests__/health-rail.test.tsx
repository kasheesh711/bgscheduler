import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AutowriterReview } from "@/lib/feedback-autowriter/review-data";
import { HealthRail, LowerBoundBar, ReviewUnavailable, splitGateSentence } from "../health-rail";
import { dashboardFixture, reviewFixture } from "./fixtures";

type Gate = AutowriterReview["gate"];

function render(gate: Partial<Gate> = {}): string {
  const review = reviewFixture();
  return renderToStaticMarkup(<HealthRail dashboard={dashboardFixture()} review={{ ...review, gate: { ...review.gate, ...gate } }} unavailableReason={null} />);
}

describe("HealthRail", () => {
  it("states the gate as one sentence, with only the criteria that are not met", () => {
    const html = render();
    expect(html).toContain("Pilot health");
    expect(html).toContain("23 Sep – 6 Oct · 14-day window");
    expect(html).toContain("Accuracy gate · Blocked");
    // "Gate blocked until 13 Oct: critical on 29 Sep." in the card's two sizes of type.
    expect(html).toContain(">Gate blocked until 13 Oct<");
    expect(html).toContain("Critical on 29 Sep. A critical error blocks the gate; keep reviewing posts.");
    expect(html).toContain("Not met");
    expect(html).toContain("1 critical verdict(s) in the window");
    expect(html).toContain("accuracy lower bound 79% &lt; 80% (46/51)");
    expect(html).toContain("3 required post(s) not yet reviewed");
    // Criteria that are met are not listed.
    expect(html).not.toContain("No unresolved critical flags");
    expect(html).not.toContain("Coverage ≥ 70%");
    // The lower-bound bar, marked at 70% and 80%.
    expect(html).toContain('aria-valuenow="79"');
    expect(html).toContain("70% head start");
    expect(html).toContain("80% pass");
  });

  it("has a sentence for every gate status", () => {
    const sentences: Array<[Partial<Gate>, string, string]> = [
      [{ status: "blocked_critical" }, "Blocked", "Gate blocked until 13 Oct"],
      [{ status: "blocked_critical", blockedUntil: null, criticalVerdicts: 0, unresolvedCriticalFlags: 2 }, "Blocked", "Gate blocked"],
      [{ status: "insufficient_data", reviewed: 0, accurate: 0, wilsonLower: 0 }, "Not enough reviews", "Not enough reviews yet"],
      [{ status: "below_head_start", wilsonLower: 0.6123 }, "Below head start", "Below head start"],
      [{ status: "head_start", wilsonLower: 0.7225 }, "Head start", "Head start"],
      [{ status: "pass", wilsonLower: 0.84, reasons: [] }, "Passed", "Gate passed"],
    ];
    for (const [gate, status, headline] of sentences) {
      const html = render(gate);
      expect(html).toContain(`Accuracy gate · ${status}`);
      expect(html).toContain(`>${headline}<`);
    }
    expect(render({ status: "blocked_critical", blockedUntil: null, criticalVerdicts: 0, unresolvedCriticalFlags: 2 })).toContain("2 critical flags to be judged.");
    expect(render({ status: "below_head_start", wilsonLower: 0.6123 })).toContain("Lower bound 61%, needs 70%.");
    expect(render({ status: "head_start", wilsonLower: 0.7225 })).toContain("Lower bound 72%, needs 80%.");
    const passed = render({ status: "pass", wilsonLower: 0.84, reasons: [] });
    expect(passed).toContain("Accuracy meets the bar.");
    expect(passed).toContain('data-gate-status="pass"');
    expect(passed).not.toContain("Not met");
    // Nothing reviewed: no lower bound to show.
    expect(render({ status: "insufficient_data", reviewed: 0, accurate: 0, wilsonLower: 0 })).toContain("Wilson LB —");
  });

  it("shows accuracy and coverage over the gate window with their counts, and how far coverage is from its floor", () => {
    const html = render();
    expect(html).toContain("No real fix needed");
    expect(html).toContain("90.1%");
    expect(html).toContain("46 / 51 reviewed");
    expect(html).toContain("Wilson LB 79%");
    expect(html).toContain("Eligible classes posted");
    expect(html).toContain("76.7%");
    expect(html).toContain("86 / 112");
    expect(html).toContain("6.7 pp above floor");
    expect(html.match(/7-day average \d/gu)).toHaveLength(2);
    // Two charts, each named for a screen reader, and each saying it reads the counts stored each hour (the figures are live).
    expect(html.match(/<canvas/gu)).toHaveLength(2);
    expect(html.match(/title="Drawn from the daily counts the review job stores each hour"/gu)).toHaveLength(2);
    expect(html).toContain("with the 80% bar and any day with a critical verdict");
    expect(render({ coverage: 0.629, coverageNum: 17, coverageDen: 27 })).toContain("7.1 pp below floor");
    expect(render({ coverage: null, coverageNum: 0, coverageDen: 0 })).toContain("No eligible classes yet");
  });

  it("says where today's classes stand, in place of the old number cards", () => {
    const html = render();
    expect(html).toContain("Today");
    expect(html).toContain("6 Oct · classes ending today in Bangkok");
    for (const label of ["Posted", "Waiting for a recording", "Held", "Tutor wrote first", "Out of scope"]) expect(html).toContain(`>${label}<`);
    expect(html).not.toContain("Posted to Wise");
  });

  it("keeps the Today line and says why there is no quality data when the review data is unavailable", () => {
    const missing = renderToStaticMarkup(<HealthRail dashboard={dashboardFixture()} review={null} unavailableReason="review_tables_missing" />);
    expect(missing).toContain("migration 0101");
    expect(missing).toContain("Waiting for a recording");
    expect(missing).not.toContain("Accuracy gate");
    expect(missing).not.toContain("<canvas");
    const failed = renderToStaticMarkup(<HealthRail dashboard={dashboardFixture()} review={null} unavailableReason="load_failed" />);
    expect(failed).toContain("could not load");
  });
});

describe("splitGateSentence", () => {
  it("splits the sentence at its colon, and keeps one without a colon whole", () => {
    expect(splitGateSentence("Gate blocked until 13 Oct: critical on 29 Sep.")).toEqual({ headline: "Gate blocked until 13 Oct", detail: "Critical on 29 Sep." });
    expect(splitGateSentence("Head start: lower bound 85%; the gate still waits for coverage of 70% (now 62%)."))
      .toEqual({ headline: "Head start", detail: "Lower bound 85%; the gate still waits for coverage of 70% (now 62%)." });
    expect(splitGateSentence("Not enough reviews yet.")).toEqual({ headline: "Not enough reviews yet", detail: null });
  });
});

describe("LowerBoundBar", () => {
  it("marks the 70% head start and 80% pass on the lower-bound bar", () => {
    const html = renderToStaticMarkup(<LowerBoundBar value={0.72} headStart={0.7} pass={0.8} />);
    expect(html).toContain("left:70%");
    expect(html).toContain("left:80%");
    expect(html).toContain("width:72%");
    expect(html).toContain('aria-valuenow="72"');
  });
});

describe("ReviewUnavailable", () => {
  it("says a missing migration and a load failure apart", () => {
    expect(renderToStaticMarkup(<ReviewUnavailable reason="review_tables_missing" />)).toContain("migration 0101");
    const failed = renderToStaticMarkup(<ReviewUnavailable reason="load_failed" />);
    expect(failed).toContain("could not load");
    expect(failed).not.toContain("migration 0101");
  });
});
