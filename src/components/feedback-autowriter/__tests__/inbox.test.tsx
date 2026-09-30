import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildInbox, filterInbox } from "@/lib/feedback-autowriter/inbox";
import { Inbox } from "../inbox";
import { FIXTURE_NOW, SESSION, dashboardFixture, quietDashboardFixture, quietReviewFixture, reviewFixture } from "./fixtures";

const NOW = new Date(FIXTURE_NOW);

function render(options: { tutorKey?: string | null; review?: ReturnType<typeof reviewFixture> | null; dashboard?: ReturnType<typeof dashboardFixture> } = {}): string {
  const dashboard = options.dashboard ?? dashboardFixture();
  const review = options.review === undefined ? reviewFixture() : options.review;
  const items = filterInbox(buildInbox(dashboard, review, { now: NOW }), options.tutorKey ?? null);
  return renderToStaticMarkup(
    <Inbox items={items} dashboard={dashboard} review={review} now={NOW} filteredTo={options.tutorKey ?? null}
      reviewUnavailable={review === null} onOpen={() => undefined} />,
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

  it("names a tutor who is not on the roster by their label", () => {
    const dashboard = dashboardFixture();
    const stranger = { ...dashboard.holds[1], wiseSessionId: SESSION.benHeldRecording, tutor: "Someone Else", tutorKey: "6a00000000000000000000ff" };
    const html = render({ dashboard: { ...dashboard, holds: [stranger] }, review: null });
    expect(html).toContain("Someone Else · Recording too short");
  });
});
