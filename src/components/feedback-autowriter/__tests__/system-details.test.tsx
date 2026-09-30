import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SystemDetails } from "../system-details";
import { dashboardFixture, quietDashboardFixture, reviewFixture } from "./fixtures";

function render(options: { dashboard?: ReturnType<typeof dashboardFixture>; review?: ReturnType<typeof reviewFixture> | null } = {}): string {
  return renderToStaticMarkup(
    <SystemDetails dashboard={options.dashboard ?? dashboardFixture()} review={options.review === undefined ? reviewFixture() : options.review} onOpen={() => undefined} />,
  );
}

describe("SystemDetails", () => {
  it("keeps every section collapsed until it is opened", () => {
    const html = render();
    expect(html.match(/<details/gu)).toHaveLength(6);
    expect(html).not.toMatch(/<details[^>]*\sopen/u);
    for (const title of ["By day", "The gate in full", "By tutor", "Totals, cost and speed", "Wise webhooks", "Incidents and the review job"]) expect(html).toContain(title);
  });

  it("has the daily table for exact numbers", () => {
    const html = render();
    expect(html).toContain("Cosmetic / major / critical");
    expect(html).toContain("2026-10-06");
    expect(html).toContain("2026-09-23");
    expect(html).toContain("Classes fixed");
    expect(render({ review: { ...reviewFixture(), daily: [] } })).toContain("No metrics yet — the review job runs hourly at :27.");
  });

  it("lists every gate criterion against its threshold, met or not", () => {
    const html = render();
    expect(html).toContain("Blocked: critical error");
    expect(html).toContain("Accuracy lower bound ≥ 80%");
    // A measured ratio is rounded down: 79.03% reads 79%, never a rounded-up value.
    expect(html).toContain("79% (46/51 accurate)");
    expect(html).toContain("No critical verdicts");
    expect(html).toContain("No unresolved critical flags");
    expect(html).toContain("No unexplained API write to Wise");
    expect(html).toContain("0 not acknowledged");
    expect(html).toContain("Coverage ≥ 70%");
    expect(html).toContain("76.7% (86/112)");
    expect(html).toContain("No flagged post waiting for review");
    expect(html).toContain("Every required post reviewed");
    expect(html).toContain("3 waiting");
    expect(html).toContain("Every posted first shot recorded");
    expect(html).toContain("0 missing");
    expect(html).toContain("5 tutors → next step 8");
    expect(html).toContain("Last nightly evaluation 2026-10-05: Blocked: critical error.");
    expect(html).toContain("Misses: 26.");
    expect(render({ review: { ...reviewFixture(), gate: { ...reviewFixture().gate, lastDaily: null } } })).toContain("No nightly evaluation yet.");
  });

  it("has each tutor's raw counts", () => {
    const html = render();
    for (const heading of ["Classes", "Shadow", "Tutor wrote", "Median to post", "Texts in Wise", "Waiting", "Classes fixed"]) expect(html).toContain(`>${heading}</th>`);
    expect(html).toContain("11.8 min");
    expect(html).toContain("classes of the last 7 days · reviews of the last 14 days");
  });

  it("has the window's totals, the cost by model and by day, the time to post by evidence and the fallbacks", () => {
    const html = render();
    expect(html).toContain("Classes seen");
    expect(html).toContain("(40 confirmed)");
    expect(html).toContain("Drafts judged unfaithful");
    expect(html).toContain("12%");
    expect(html).toContain("Cost by model");
    expect(html).toContain("GPT-6.1 Sol");
    expect(html).toContain("GPT-6 Luna");
    expect(html).toContain("GLM Flash");
    expect(html).toContain("Soniox transcription");
    expect(html).toContain("Cost by day (Bangkok)");
    expect(html).toContain("Class end → posted, by evidence");
    expect(html).toContain("From the transcript");
    expect(html).toContain("55.0 min");
    expect(html).toContain("1.2 h");
    expect(html).toContain("Back to the summary (transcript first) · 2");
    expect(html).toContain("No recording after 3 h — from summary");
    const quiet = render({ dashboard: { ...quietDashboardFixture(), summaryFallbacks: [], fallbackShare: null } });
    expect(quiet).toContain("No class fell back to the summary in this window.");
    expect(quiet).toContain("no drafts yet");
    // The old row of number cards is gone.
    expect(html).not.toContain("Posted to Wise");
    // Who last changed the controls, for every admin to read (the system line has it on hover only).
    expect(html).toContain("Controls (mode, pause, tutor switches) last changed by owner@example.com · 29 Sep, 15:07");
    const never = dashboardFixture();
    expect(render({ dashboard: { ...never, control: { ...never.control, updatedBy: null } } })).not.toContain("last changed by");
  });

  it("labels Sol's cost as Sol", () => {
    const dashboard = dashboardFixture();
    const html = render({ dashboard: { ...dashboard, cost: { ...dashboard.cost, byModel: [{ model: "openai/gpt-6.1-sol", role: "writer", calls: 3, costUsd: 0.12 }] } }, review: null });
    expect(html.match(/GPT-6\.1 Sol/gu)).toHaveLength(1);
    expect(html).not.toContain("GPT-6 Luna");
  });

  it("lists the Wise webhooks of the last day by event and outcome", () => {
    const html = render();
    expect(html).toContain("MeetingEndedEvent");
    expect(html).toContain("RecordingCompletedEvent");
    expect(html).toContain("not_roster");
    expect(html).toContain("last delivery 6 Oct, 15:31");
  });

  it("lists every incident, acknowledged ones too, each opening in the drawer, and the review job's last run", () => {
    const review = reviewFixture();
    const html = render({ review: { ...review, lastRun: { ...review.lastRun!, dailyGateSkipped: "activity_mirror_stale: last successful Wise activity sync never" } } });
    expect(html).toContain("Critical verdict: Wrong person");
    expect(html).toContain("push sent");
    expect(html).toContain("push FAILED — not delivered");
    expect(html).toContain("email: relay down");
    expect(html).toContain("acknowledged by owner@example.com");
    expect(html).toContain("A first shot could not be proven against the POST body yet");
    expect(html.match(/>\s*Open\s*<\/button>/gu)).toHaveLength(3);
    // Acknowledging happens in the drawer, not here.
    expect(html).not.toContain("Acknowledge<");
    expect(html).toContain("Review job: succeeded · started 6 Oct, 15:27 · nightly gate not recorded yet (activity_mirror_stale");
    expect(render({ review: { ...review, incidents: [], lastRun: null } })).toContain("Review job: has not run yet");
  });

  it("leaves out what the review data feeds when it is unavailable, and keeps the rest", () => {
    const html = render({ review: null });
    expect(html.match(/<details/gu)).toHaveLength(3);
    expect(html).not.toContain("The gate in full");
    expect(html).not.toContain("Incidents and the review job");
    expect(html).toContain("By tutor");
    expect(html).toContain("Cost by model");
    expect(html).toContain("MeetingEndedEvent");
  });
});
