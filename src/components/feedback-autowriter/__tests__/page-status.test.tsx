import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RESHOWN_RELOAD_MS, StatusLines, reloadsWhenShown, staleReviewMessage } from "../page-status";

describe("reloadsWhenShown", () => {
  it("reloads a page shown again after a visit elsewhere, never on its first mount", () => {
    const now = 1_790_000_000_000;
    expect(reloadsWhenShown(null, now)).toBe(false);
    expect(reloadsWhenShown(now - 5 * 60_000, now)).toBe(true);
    expect(reloadsWhenShown(now - RESHOWN_RELOAD_MS, now)).toBe(true);
    // React runs effects twice in development: a hide and a show in the same moment is not a visit.
    expect(reloadsWhenShown(now, now)).toBe(false);
    expect(reloadsWhenShown(now - RESHOWN_RELOAD_MS + 1, now)).toBe(false);
  });
});

describe("staleReviewMessage", () => {
  const DASHBOARD = "2026-10-06T08:35:00.000Z";

  it("says nothing while the review data refreshes", () => {
    expect(staleReviewMessage(null, "2026-10-06T08:31:00.000Z", DASHBOARD)).toBeNull();
  });

  it("says why, and as of when the review data on the page is: a time today, a date and a time before", () => {
    expect(staleReviewMessage("HTTP 500", "2026-10-06T08:31:00.000Z", DASHBOARD))
      .toBe("Review data not refreshed (HTTP 500). The posts to review, the incidents and the pilot health are as of 15:31.");
    expect(staleReviewMessage("The review data could not load.", "2026-10-05T08:31:00.000Z", DASHBOARD))
      .toBe("Review data not refreshed (The review data could not load). The posts to review, the incidents and the pilot health are as of 5 Oct, 15:31.");
    // No review data on the page at all: nothing to date.
    expect(staleReviewMessage("no answer", null, DASHBOARD)).toBe("Review data not refreshed (no answer).");
  });
});

describe("StatusLines", () => {
  it("shows every problem, each on its line, and the note of the last action beside them", () => {
    const html = renderToStaticMarkup(<StatusLines problems={["Not saved (HTTP 500). The controls are as they were.", null, "Review data not refreshed (no answer)."]} note="Saved." />);
    expect(html.match(/<p>/gu)).toHaveLength(2);
    expect(html).toContain('data-status="problems"');
    expect(html).toContain("Not saved (HTTP 500).");
    expect(html).toContain("Review data not refreshed (no answer).");
    // A problem does not hide the note: a Pause that was saved says so while the review data cannot refresh.
    expect(html).toContain('data-status="note"');
    expect(html.indexOf("Review data not refreshed")).toBeLessThan(html.indexOf("Saved."));
  });

  it("shows the note alone, and nothing at all when there is nothing to say", () => {
    const note = renderToStaticMarkup(<StatusLines problems={[null, null]} note="Saved." />);
    expect(note).toContain("Saved.");
    expect(note).not.toContain('data-status="problems"');
    expect(renderToStaticMarkup(<StatusLines problems={[null]} note={null} />)).toBe("");
  });
});
