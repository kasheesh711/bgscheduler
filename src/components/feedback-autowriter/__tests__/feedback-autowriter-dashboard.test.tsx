import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

// A closed popover renders nothing on the server: show the Controls menu's content inline.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ render }: { render: (props: Record<string, unknown>) => React.ReactNode }) => <>{render({})}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import type { AutowriterReview, AutowriterReviewUnavailable } from "@/lib/feedback-autowriter/review-data";
import type { AutowriterTrends } from "@/lib/feedback-autowriter/trends";
import { FeedbackAutowriterDashboard } from "../feedback-autowriter-dashboard";
import { dashboardFixture, quietDashboardFixture, quietReviewFixture, reviewFixture, shortHistoryTrendsFixture, trendsFixture } from "./fixtures";

function render(options: {
  data?: AutowriterDashboard;
  review?: AutowriterReview | AutowriterReviewUnavailable | null;
  trends?: AutowriterTrends | null;
  canControl?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    <FeedbackAutowriterDashboard
      initialData={options.data ?? dashboardFixture()}
      initialReview={options.review === undefined ? reviewFixture() : options.review}
      initialTrends={options.trends === undefined ? trendsFixture() : options.trends}
      canControl={options.canControl ?? false}
    />,
  );
}

const SOURCE = fs.readFileSync(path.join(__dirname, "../feedback-autowriter-dashboard.tsx"), "utf8");

describe("FeedbackAutowriterDashboard", () => {
  it("lays the page out as the mockup: system line, the to-do list beside the health rail, trends, tutors, details", () => {
    const html = render();
    const order = ["Feedback Autowriter", "Mode LIVE", "What needs you", "Pilot health", "How the pilot is trending", "Click a tutor to filter", "All classes", "The gate in full"]
      .map((text) => html.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(html).toContain("A little attention. Then back to teaching.");
    expect(html).toContain("Tuesday, 6 October 2026");
    expect(html).toContain("In-person classes stay with the tutor and are not shown here.");
    expect(html).toContain("Updated 15:35");
    expect(html).toContain(">Refresh<");
    // The to-do list has two thirds of the width, the rail one.
    expect(html).toMatch(/lg:grid-cols-3[^>]*><section[^>]*lg:col-span-2/u);
  });

  it("has no row of number cards and no tabs", () => {
    const html = render({ canControl: true });
    expect(html).not.toContain("Posted to Wise");
    expect(html).not.toMatch(/grid-cols-9\b/u);
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain("From recording");
    // What the cards said is on the Today line and in the details.
    expect(html).toContain("Waiting for a recording");
    expect(html).toContain("Tutor wrote first");
  });

  it("shows the tutors, the classes with their writers and evidence, the cost and the Wise webhooks", () => {
    const html = render();
    for (const tutor of ["Anna", "Ben", "Chai", "Dao", "Emma"]) expect(html).toContain(tutor);
    expect(html).toContain("Partly on");
    expect(html).toContain("Year 9 Maths");
    expect(html).toContain("GPT-6.1 Sol");
    expect(html).toContain("GPT-6 Luna");
    expect(html).toContain("· transcript");
    expect(html).toContain("2.5 min");
    expect(html).toContain("MeetingEndedEvent");
    expect(html).toContain("Cost by model");
    // A class's text is read in the drawer: the page itself never prints it.
    expect(html).not.toContain("Rotations and reflections on the coordinate grid");
  });

  it("shows transcript first: waiting for the recording, fallbacks by cause and time to post by evidence", () => {
    const html = render();
    expect(html).toContain("Waiting for the recording");
    expect(html).toContain("No recording after 3 h — from summary");
    expect(html).toContain("Back to the summary (transcript first)");
    expect(html).toContain("Class end → posted, by evidence");
    expect(html).toContain("From the transcript");
    expect(html).toContain("55.0 min");
    expect(html).toContain("1.2 h");
    expect(html).toContain("Transcript first: on");
    const quiet = render({ data: quietDashboardFixture({ summaryFallbacks: [] }), review: quietReviewFixture(), trends: shortHistoryTrendsFixture() });
    expect(quiet).toContain("No class fell back to the summary in this window.");
  });

  it("shows owner controls only to the owner", () => {
    const shadow = dashboardFixture({ control: { ...dashboardFixture().control, mode: "shadow" } });
    const viewer = render({ data: shadow });
    const owner = render({ data: shadow, canControl: true });
    expect(viewer).not.toContain("Go live");
    expect(viewer).not.toContain("Controls");
    expect(viewer).not.toContain(">Pause<");
    expect(viewer).not.toContain(">Turn off<");
    expect(viewer).not.toContain(">Turn on<");
    expect(owner).toContain("Controls");
    expect(owner).toContain("Go live");
    expect(owner).toContain(">Pause<");
    expect(owner).toContain(">Turn on<");
  });

  it("is read-only for an admin who is not the owner: nothing to switch, record or acknowledge", () => {
    const html = render();
    expect(html).not.toContain("verdict-controls");
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Acknowledge<");
    expect(html).not.toContain("Controls");
    expect(html).toContain("Only the owner records verdicts.");
    expect(render({ canControl: true })).not.toContain("Only the owner records verdicts.");
    // Everything is still there to read and to open.
    expect(html).toContain("What needs you");
    expect(html.match(/>Review<\/button>/gu)?.length).toBeGreaterThan(0);
    expect(html).toContain("Expansion gate");
  });

  it("makes a halt impossible to miss", () => {
    const halted = dashboardFixture({ control: { ...dashboardFixture().control, haltedAt: "2026-10-06T02:00:00.000Z", haltReason: "unknown outcome for the feedback POST on x" } });
    const html = render({ data: halted, canControl: true });
    expect(html).toContain("Posting is halted");
    expect(html).toContain("unknown outcome for the feedback POST on x");
    expect(html).toContain(">Resume<");
    expect(html).toContain("Posting is halted. That needs you first.");
    // The banner sits directly under the system line, above the to-do list.
    expect(html.indexOf("Mode LIVE")).toBeLessThan(html.indexOf('role="alert"'));
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf("What needs you"));
    expect(render({ data: halted })).not.toContain(">Resume<");
  });

  it("says when nothing needs the owner", () => {
    const html = render({ data: quietDashboardFixture(), review: quietReviewFixture(), trends: shortHistoryTrendsFixture() });
    expect(html).toContain("Nothing needs you. Back to teaching.");
    expect(html).toContain("Nothing needs you.");
    expect(html).toContain("0 open");
    expect(html).toContain("Not enough reviews yet");
    expect(html).toContain("since 5 Oct");
  });

  it("keeps the to-do list to holds and failed posts, and says why there is no quality data, before migration 0101", () => {
    const html = render({ review: { available: false, reason: "review_tables_missing" }, trends: null });
    expect(html).toContain("What needs you");
    expect(html).toContain("4 open");
    expect(html).toContain("Recording too short");
    expect(html).toContain("A post did not verify in Wise");
    expect(html).not.toContain("To review");
    // The rail and the trends say what is missing; the page is not blank.
    expect(html.match(/Quality data is not available yet \(the review tables are created by migration 0101\)\./gu)).toHaveLength(2);
    expect(html).not.toContain("<canvas");
    expect(html).toContain("Last review run: unknown");
    expect(html).toContain("All classes");
    expect(html).toContain("Cost by model");
  });

  it("says a load failure apart from a missing migration, and renders without any review data", () => {
    const failed = render({ review: { available: false, reason: "load_failed" }, trends: null });
    expect(failed.match(/The quality data could not load\./gu)).toHaveLength(2);
    expect(failed).not.toContain("migration 0101");
    const none = render({ review: null, trends: null });
    expect(none).toContain("What needs you");
    expect(none).toContain("The quality data could not load.");
  });

  it("says so in the trends area when only the trends could not load", () => {
    const html = render({ trends: null });
    expect(html).toContain("The trend charts could not load.");
    // The rail's two charts still draw from the review data.
    expect(html.match(/<canvas/gu)).toHaveLength(2);
    expect(html).toContain("Expansion gate");
    expect(render().match(/<canvas/gu)).toHaveLength(6);
  });

  it("polls with the house pattern (abortable, sequenced): the dashboard every 60 s, the review data every 5 min", () => {
    expect(SOURCE).toContain("AbortController");
    expect(SOURCE).toContain("requestSequence");
    expect(SOURCE).toContain("60_000");
    expect(SOURCE).toContain("const REVIEW_POLL_MS = 5 * 60_000;");
    expect(SOURCE).toContain("window.setInterval(() => void load(), DASHBOARD_POLL_MS)");
    expect(SOURCE).toContain("window.setInterval(() => void loadReview(), REVIEW_POLL_MS)");
  });

  it("filters the to-do list on the client and reloads the trends when the tutor or the range changes", () => {
    expect(SOURCE).toContain("filterInbox(inbox, tutorKey)");
    expect(SOURCE).toContain("void loadTrends(rangeDays, key);");
    expect(SOURCE).toContain("void loadTrends(days, tutorKey);");
    expect(SOURCE).toContain("/api/feedback-autowriter/trends?");
    // After an action everything the page shows is loaded again.
    expect(SOURCE).toContain("await Promise.all([load(), loadReview(), loadTrends(rangeDays, tutorKey)]);");
    // No trends request on mount: the first series come with the page.
    expect(SOURCE).not.toMatch(/useEffect\(\(\) => \{\s*void loadTrends/u);
  });
});
