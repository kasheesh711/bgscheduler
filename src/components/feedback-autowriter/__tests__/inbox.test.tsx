import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildInbox, filterInbox } from "@/lib/feedback-autowriter/inbox";
import type { AutowriterReviewUnavailable } from "@/lib/feedback-autowriter/review-data";
import { Inbox } from "../inbox";
import { FIXTURE_NOW, SESSION, dashboardFixture, quietDashboardFixture, quietReviewFixture, reviewFixture } from "./fixtures";

const NOW = new Date(FIXTURE_NOW);

function render(options: {
  tutorKey?: string | null;
  review?: ReturnType<typeof reviewFixture> | null;
  /** Why the review data is missing, when `review` is null (a failed load by default). */
  reason?: AutowriterReviewUnavailable["reason"];
  dashboard?: ReturnType<typeof dashboardFixture>;
  canControl?: boolean;
} = {}): string {
  const dashboard = options.dashboard ?? dashboardFixture();
  const review = options.review === undefined ? reviewFixture() : options.review;
  const items = filterInbox(buildInbox(dashboard, review, { now: NOW }), options.tutorKey ?? null);
  return renderToStaticMarkup(
    <Inbox items={items} dashboard={dashboard} review={review} now={NOW} filteredTo={options.tutorKey ?? null}
      reviewUnavailable={review === null ? options.reason ?? "load_failed" : null} canControl={options.canControl ?? true} onOpen={() => undefined} />,
  );
}

/** The `data-group` attributes in document order. */
const groupsOf = (html: string) => [...html.matchAll(/data-group="([a-z_]+)"/gu)].map((match) => match[1]);

describe("Inbox", () => {
  it("lists what needs the owner in groups, in the list's order, each with its count and the total", () => {
    const html = render();
    expect(html).toContain("What needs you");
    // 1 incident, 3 holds still waiting (not the written one, not the stale one), 4 posts to review, 1 failed post.
    expect(html).toContain("9 open");
    expect(groupsOf(html)).toEqual(["incident", "hold", "review", "failed_post"]);
    expect(html).toMatch(/Incidents<\/span><span[^>]*>1<\/span>/u);
    expect(html).toMatch(/Held<\/span><span[^>]*>3<\/span>/u);
    expect(html).toMatch(/To review<\/span><span[^>]*>4<\/span>/u);
    expect(html).toMatch(/Failed posts<\/span><span[^>]*>1<\/span>/u);
    // Groups of later PRs are absent until their data exists.
    expect(html).not.toContain("Decisions");
    expect(html).not.toContain("Expansion");
    expect(html).toContain("Nothing urgent is hidden below.");
    expect(html).toContain("Synced at 15:35");
  });

  it("counts the classes that wait, not the rows: a class with an incident and a post to review is one", () => {
    const busy = reviewFixture();
    const aboutFlagged = { ...busy.incidents[0], id: "44444444-4444-4444-8444-444444444444", wiseSessionId: SESSION.benFlagged };
    const html = render({ review: { ...busy, incidents: [...busy.incidents, aboutFlagged] } });
    // Two incidents now, and still nine classes: Ben's flagged post has both a row to review and an incident.
    expect(html).toMatch(/Incidents<\/span><span[^>]*>2<\/span>/u);
    expect(html).toContain("9 open");
    expect(html).not.toContain("10 open");
  });

  it("says when the review data is older than the classes: it is polled less often", () => {
    // Loaded in the same minute: one time is enough.
    expect(render()).not.toContain("reviews at");
    const html = render({ review: { ...reviewFixture(), generatedAt: "2026-10-06T08:31:10.000Z" } });
    expect(html).toContain("Synced at 15:35 · reviews at 15:31");
    expect(render({ review: null })).not.toContain("reviews at");
    // From another day: with its date, even at the same time of day.
    expect(render({ review: { ...reviewFixture(), generatedAt: "2026-10-05T08:35:00.000Z" } })).toContain("Synced at 15:35 · reviews at 5 Oct, 15:35");
  });

  it("gives every row one action: Review for a post, Open for the rest", () => {
    const html = render();
    expect(html.match(/>Review<\/button>/gu)).toHaveLength(4);
    expect(html.match(/>Open<\/button>/gu)).toHaveLength(5);
  });

  it("shows a post to review with its tutor, class time, evidence and writer", () => {
    const html = render();
    expect(html).toMatch(/Anna <span[^>]*>· 6 Oct, 13:00 class<\/span>/u);
    expect(html).toContain(">Transcript<");
    expect(html).toContain("Year 9 Maths · Posted 14:12 · GPT-6.1 Sol");
    expect(html).toContain(">Summary<");
    expect(html).toContain("Year 8 English · Posted 11:03 · GPT-6 Luna");
    // A flagged post says why, from the flag's source — never the flag's note.
    expect(html).toContain(">Flagged<");
    expect(html).toContain("Year 8 English · Posted 18:06 · GPT-6 Luna · changed in Wise after posting");
    expect(html).not.toContain("Saved again in Wise after the approval");
    // The feedback itself never rides in the list.
    expect(html).not.toContain("Rotations and reflections");
  });

  it("shows a hold with its reason in plain words and a countdown: red under 6 hours, amber under 24", () => {
    const html = render();
    expect(html).toContain("Anna · The student&#x27;s attendance shows 0%");
    expect(html).toMatch(/text-conflict[^>]*>Deadline passed 15 h ago</u);
    expect(html).toContain("Ben · Recording too short");
    expect(html).toMatch(/border-amber-200[^>]*>Deadline in 8 h</u);
    expect(html).toContain("4 Oct, 12:00 class · Year 8 English · Held · due 6 Oct, 23:59");
    expect(html).toContain("Chai · The judge found a claim the record does not support");
    expect(html).toMatch(/bg-muted\/40 text-muted-foreground[^>]*>Deadline in 32 h</u);
    expect(html).toContain("5 Oct, 14:00 class · A-level Chemistry · Held · due 7 Oct, 23:59 · draft stored");
    // A person wrote Dao's class, and Emma's deadline is days gone: neither waits for the owner.
    expect(html).not.toContain("Speakers unclear");
    expect(html).not.toContain("Transcript too short");
    // The judge's quote in the reason is lesson text: it stays out of the list.
    expect(html).not.toContain("finished the whole past paper");
  });

  it("shows an incident under its tutor and a failed post by what happened", () => {
    const html = render();
    expect(html).toContain("A critical error was found in a post");
    expect(html).toContain("Critical · 29 Sep");
    expect(html).toContain("Ben · Critical verdict: Wrong person (recorded by owner@example.com)");
    expect(html).toContain("Ben · A post did not verify in Wise");
    expect(html).toContain(">Verify failed<");
  });

  it("narrows to one tutor and says so", () => {
    const html = render({ tutorKey: "Chai" });
    expect(html).toContain("filtered to Chai");
    expect(html).toContain("2 open");
    expect(groupsOf(html)).toEqual(["hold", "review"]);
    expect(html).not.toContain("Anna");
    expect(html).not.toContain("Ben");
    // Ben's list keeps the incident about his class.
    expect(groupsOf(render({ tutorKey: "Ben" }))).toEqual(["incident", "hold", "review", "failed_post"]);
  });

  it("says when nothing needs the owner", () => {
    const html = render({ dashboard: quietDashboardFixture(), review: quietReviewFixture() });
    expect(html).toContain("Nothing needs you.");
    expect(html).toContain("0 open");
    expect(groupsOf(html)).toEqual([]);
    expect(html).not.toContain("<button");
    expect(render({ tutorKey: "Dao" })).toContain("Dao has no post to review, no held class and no failed post.");
  });

  it("still lists the holds and the failed posts when the review data is unavailable, and says what is missing", () => {
    const html = render({ review: null });
    expect(groupsOf(html)).toEqual(["hold", "failed_post"]);
    expect(html).toContain("4 open");
    expect(html).toContain("could not load");
    expect(render()).not.toContain("could not load");
  });

  it("never says nothing needs the owner when the posts to review and the incidents could not load", () => {
    const quiet = quietDashboardFixture();
    const failed = render({ dashboard: quiet, review: null, reason: "load_failed" });
    expect(failed).toContain("Posts to review and incidents could not load — Refresh to try again.");
    expect(failed).toContain("Held classes and failed posts did load: there are none.");
    expect(failed).toContain("0 open");
    expect(failed).not.toContain("Nothing needs you");
    // The empty state says it once: no footer repeating it, and no "nothing urgent is hidden" while incidents are missing.
    expect(failed).not.toContain("so this list has the held classes and the failed posts only");
    expect(failed).not.toContain("Nothing urgent is hidden below.");
    expect(failed).toContain("Held classes and failed posts only.");
    const missing = render({ dashboard: quiet, review: null, reason: "review_tables_missing" });
    expect(missing).toContain("Posts to review and incidents are not available yet — migration 0101 creates their tables.");
    expect(missing).not.toContain("Nothing needs you");
    expect(render({ dashboard: quiet, review: null, tutorKey: "Dao" })).toContain("Held classes and failed posts did load: Dao has none.");
    // With the review data, an empty list is good news.
    expect(render({ dashboard: quiet, review: quietReviewFixture() })).toContain("Nothing needs you.");
  });

  it("tells an admin who is not the owner that the list is read-only, with the same items to open", () => {
    const viewer = render({ canControl: false });
    expect(viewer).toContain("Only the owner records verdicts.");
    expect(viewer).toContain("9 open");
    expect(viewer.match(/>Review<\/button>/gu)).toHaveLength(4);
    expect(render()).not.toContain("Only the owner records verdicts.");
  });

  it("names a tutor who is not on the roster by their label", () => {
    const dashboard = dashboardFixture();
    const stranger = { ...dashboard.holds[1], wiseSessionId: SESSION.benHeldRecording, tutor: "Someone Else", tutorKey: "6a00000000000000000000ff" };
    const html = render({ dashboard: { ...dashboard, holds: [stranger] }, review: null });
    expect(html).toContain("Someone Else · Recording too short");
  });
});
