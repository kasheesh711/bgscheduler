import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TUTOR_SORT, IntervalBar, TutorFilterChip, TutorTable, buildTutorRows, filterTutorRows, hasNoActivity, needsAttention, sortTutorRows,
} from "../tutor-table";
import { FIXTURE_NOW, dashboardFixture, reviewFixture } from "./fixtures";

const NOW = new Date(FIXTURE_NOW);

/** The fixtures plus two tutors with nothing in the window: Fah switched on, Gun switched off. */
function withQuietTutors() {
  const dashboard = dashboardFixture();
  const review = reviewFixture();
  const base = dashboard.tutors[0];
  const quiet = (tutorKey: string, enabled: boolean) => ({
    ...base, tutorKey, displayName: tutorKey, wiseUserIds: [`${tutorKey}-1`], enabled, partlyEnabled: false,
    seen: 0, posted: 0, shadowDrafts: 0, held: 0, skippedHuman: 0, expired: 0, failed: 0, medianLatencyMinutes: null, costUsd: 0,
  });
  const emptyQuality = (tutorKey: string) => ({ ...review.tutors.find((row) => row.tutorKey === "Emma")!, tutorKey, displayName: tutorKey });
  return {
    dashboard: { ...dashboard, tutors: [...dashboard.tutors, quiet("Fah", true), quiet("Gun", false)] },
    review: { ...review, tutors: [...review.tutors, emptyQuality("Fah"), emptyQuality("Gun")] },
  };
}

function render(options: {
  canControl?: boolean;
  selected?: string | null;
  review?: ReturnType<typeof reviewFixture> | null;
  dashboard?: ReturnType<typeof dashboardFixture>;
} = {}): string {
  return renderToStaticMarkup(
    <TutorTable dashboard={options.dashboard ?? dashboardFixture()} review={options.review === undefined ? reviewFixture() : options.review} now={NOW}
      selectedTutorKey={options.selected ?? null} onSelect={() => undefined} canControl={options.canControl ?? false} busy={false} onControl={() => undefined} />,
  );
}

/** The cells of one tutor's row, tags stripped. */
function rowOf(html: string, tutorKey: string): string {
  const row = new RegExp(`<tr[^>]*data-tutor-row="${tutorKey}"[^>]*>(.*?)</tr>`, "u").exec(html);
  if (!row) throw new Error(`no row for ${tutorKey}`);
  return row[1].replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

describe("buildTutorRows", () => {
  it("joins the dashboard's tutors to the review payload's by key, best accuracy first", () => {
    const rows = buildTutorRows(dashboardFixture(), reviewFixture(), NOW);
    expect(rows.map((row) => row.tutorKey)).toEqual(["Anna", "Chai", "Ben", "Dao", "Emma"]);
    expect(rows[0]).toMatchObject({ accuracy: 19 / 20, realFixes: 1, holds: 1, openHolds: 1, enabled: true, quality: { coverageNum: 33, coverageDen: 39 } });
    expect(rows[2]).toMatchObject({ tutorKey: "Ben", accuracy: 14 / 17, realFixes: 3, holds: 1, openHolds: 1, quality: { critical: 1 } });
    // Dao's hold was written by a person: held in the window, no longer open.
    expect(rows[3]).toMatchObject({ tutorKey: "Dao", accuracy: null, realFixes: 0, holds: 1, openHolds: 0, enabled: false, partlyEnabled: true });
    // Emma's is days past its deadline.
    expect(rows[4]).toMatchObject({ tutorKey: "Emma", holds: 1, openHolds: 0, enabled: false, partlyEnabled: false });
  });

  it("counts a hold in the window by its class's Bangkok date, and an undated one too", () => {
    const dashboard = dashboardFixture();
    const old = { ...dashboard.holds[0], wiseSessionId: "old", tutorKey: "Anna", classEndedAt: "2026-09-22T16:59:00.000Z", deadlineAt: "2026-09-24T16:59:59.999Z" };
    const firstDay = { ...old, wiseSessionId: "first-day", classEndedAt: "2026-09-22T17:00:00.000Z" };
    const undated = { ...old, wiseSessionId: "undated", classEndedAt: null, deadlineAt: null };
    const anna = (holds: typeof dashboard.holds) => buildTutorRows({ ...dashboard, holds }, reviewFixture(), NOW).find((row) => row.tutorKey === "Anna")!;
    // 23:59 on 22 Sep in Bangkok is before the window; midnight is its first day.
    expect(anna([old])).toMatchObject({ holds: 0, openHolds: 0 });
    expect(anna([firstDay])).toMatchObject({ holds: 1, openHolds: 0 });
    expect(anna([undated])).toMatchObject({ holds: 1, openHolds: 1 });
  });

  it("still lists every tutor, without review figures, while the review data is unavailable", () => {
    const rows = buildTutorRows(dashboardFixture(), null, NOW);
    expect(rows.map((row) => row.tutorKey)).toEqual(["Anna", "Ben", "Chai", "Dao", "Emma"]);
    expect(rows.every((row) => row.quality === null && row.accuracy === null && row.realFixes === 0)).toBe(true);
    expect(rows[0]).toMatchObject({ holds: 1, openHolds: 1 });
  });
});

describe("tutor views and order", () => {
  const { dashboard, review } = withQuietTutors();
  const rows = buildTutorRows(dashboard, review, NOW);
  const keys = (list: Array<{ tutorKey: string }>) => list.map((row) => row.tutorKey);

  it("folds only the tutors with no post and no hold in the window into the quiet group", () => {
    // Dao has no post in Wise but a held class: still in the table. Emma's hold is in the window too.
    expect(keys(rows.filter(hasNoActivity))).toEqual(["Fah", "Gun"]);
    const unreviewed = buildTutorRows(dashboard, null, NOW);
    expect(keys(unreviewed.filter(hasNoActivity))).toEqual(["Fah", "Gun"]);
  });

  it("keeps a tutor whose eligible classes all went unposted in the table, not in the quiet group", () => {
    const missed = rows.find((row) => row.tutorKey === "Fah")!;
    const row = { ...missed, quality: { ...missed.quality!, coverage: 0, coverageNum: 0, coverageDen: 5 } };
    expect(needsAttention(row)).toBe(true);
    expect(hasNoActivity(row)).toBe(false);
  });

  it("needs attention: below a bar, a critical verdict, an open hold, a post to review, or partly on", () => {
    expect(keys(rows.filter(needsAttention))).toEqual(["Anna", "Chai", "Ben", "Dao"]);
    expect(needsAttention(rows.find((row) => row.tutorKey === "Fah")!)).toBe(false);
  });

  it("filters by view and by name, in any case", () => {
    expect(keys(filterTutorRows(rows, { view: "all", query: "" }))).toHaveLength(7);
    expect(keys(filterTutorRows(rows, { view: "no_posts", query: "" }))).toEqual(["Fah", "Gun"]);
    expect(keys(filterTutorRows(rows, { view: "off", query: "" }))).toEqual(["Emma", "Gun"]);
    expect(keys(filterTutorRows(rows, { view: "all", query: "  bE " }))).toEqual(["Ben"]);
    expect(keys(filterTutorRows(rows, { view: "off", query: "ann" }))).toEqual([]);
  });

  it("sorts by any column, a tutor without the figure last in both directions, ties by name", () => {
    expect(keys(sortTutorRows(rows, DEFAULT_TUTOR_SORT))).toEqual(keys(rows));
    expect(keys(sortTutorRows(rows, { key: "accuracy", dir: "asc" }))).toEqual(["Ben", "Chai", "Anna", "Dao", "Emma", "Fah", "Gun"]);
    expect(keys(sortTutorRows(rows, { key: "name", dir: "desc" }))).toEqual(["Gun", "Fah", "Emma", "Dao", "Chai", "Ben", "Anna"]);
    const byHolds = keys(sortTutorRows(rows, { key: "holds", dir: "desc" }));
    expect(byHolds.slice(-2)).toEqual(["Fah", "Gun"]);
    // Coverage: Dao, Emma, Fah and Gun have none, last in both directions.
    expect(keys(sortTutorRows(rows, { key: "coverage", dir: "asc" })).slice(-4)).toEqual(["Dao", "Emma", "Fah", "Gun"]);
    expect(keys(sortTutorRows(rows, { key: "coverage", dir: "desc" })).slice(-4)).toEqual(["Dao", "Emma", "Fah", "Gun"]);
    const byFixes = keys(sortTutorRows(buildTutorRows(dashboard, null, NOW), { key: "realFixes", dir: "asc" }));
    expect(byFixes).toEqual(["Anna", "Ben", "Chai", "Dao", "Emma", "Fah", "Gun"]);
  });
});

describe("TutorTable", () => {
  it("shows one line per tutor: accuracy with its interval, lower bound, coverage, holds, real fixes and status", () => {
    const html = render();
    expect(html).toContain("5 in the pilot · 4 switched on · last 14 days");
    expect(html).toContain("Click a tutor to filter the to-do list and the charts.");
    for (const heading of ["Tutor", "Accuracy", "Lower bound", "Coverage", "Holds", "Real fixes", "Status"]) expect(html).toContain(`${heading}`);
    // The review phase is the same for every new tutor: the column is gone, a sampled tutor gets a tag.
    expect(html).not.toContain("Every post (new)");
    expect(rowOf(html, "Anna")).toBe("A Anna 21 posts in Wise · 1 to review 95% 19 / 20 76.3% 84.6% 33 / 39 1 1 open 1 On");
    expect(rowOf(html, "Ben")).toBe("B Ben 19 posts in Wise · 1 to review 82.3% 14 / 17 58.9% 68.4% 26 / 38 1 1 open 3 1 critical On");
    expect(rowOf(html, "Dao")).toBe("D Dao 0 posts in Wise · 0 to review — — — 1 0 open 0 Partly on");
    expect(rowOf(html, "Emma")).toContain("Off");
    expect(html).toContain("23 Sep – 6 Oct");
    // In the green only at the pass bar and without a critical verdict: Ben's 82.3% has one.
    expect(html).toMatch(/text-amber-700[^>]*>82\.3%</u);
    expect(html).toMatch(/color-mix[^>]*>95%</u);
    expect(html).toMatch(/text-amber-700[^>]*>68\.4%</u);
    expect(html).toContain('aria-label="Accuracy 95%, lower bound 76.3%; head start at 70%, pass at 80%"');
    expect(html).not.toContain("Median to post");
  });

  it("offers a search, four views with their counts, and sortable columns", () => {
    const { dashboard, review } = withQuietTutors();
    const html = render({ dashboard, review });
    expect(html).toContain('aria-label="Find a tutor"');
    const text = html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
    for (const view of ["All 7", "Needs attention 4", "No posts yet 2", "Off 2"]) expect(text).toContain(view);
    expect(html).toMatch(/aria-sort="descending"[^>]*>(?:(?!<\/th>).)*Accuracy/u);
    expect(html.match(/aria-sort="none"/gu)).toHaveLength(5);
  });

  it("folds the tutors with nothing in the window into a row of chips under the table", () => {
    const { dashboard, review } = withQuietTutors();
    const html = render({ dashboard, review, selected: "Fah" });
    expect(html).not.toContain('data-tutor-row="Fah"');
    expect(html).toContain('data-tutor-chip="Fah"');
    expect(html).toContain('data-tutor-chip="Gun"');
    expect(html).toContain("No posts in these 14 days");
    expect(html).toMatch(/data-tutor-chip="Fah"[^>]*border-sky-200/u);
    expect(html).not.toContain(">Turn off<");
    const owner = render({ dashboard, review, canControl: true });
    // Three on in the table and Fah's chip; Dao (partly on), Emma and Gun can be turned on.
    expect(owner.match(/>Turn off</gu)).toHaveLength(4);
    expect(owner.match(/>Turn on</gu)).toHaveLength(3);
    expect(owner).toContain('aria-label="Turn off Fah"');
    expect(owner).toContain('aria-label="Turn on Gun"');
  });

  it("gives the On / Off switch to the owner only", () => {
    const viewer = render();
    const owner = render({ canControl: true });
    expect(viewer).not.toContain(">Turn off<");
    expect(viewer).not.toContain(">Turn on<");
    expect(owner.match(/>Turn off</gu)).toHaveLength(3);
    // A tutor who is partly on is switched on for every account.
    expect(owner.match(/>Turn on</gu)).toHaveLength(2);
    expect(owner).toContain("Partly on");
  });

  it("highlights the tutor the page is filtered to", () => {
    const html = render({ selected: "Chai" });
    expect(html).toMatch(/<tr[^>]*data-state="selected"[^>]*data-tutor-row="Chai"/u);
    expect(html.match(/data-state="selected"/gu)).toHaveLength(1);
    // The tutor's button says so to a screen reader (the other pressed button is the "All" view).
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*>C</u);
    expect(html.match(/aria-pressed="true"/gu)).toHaveLength(2);
    expect(render()).not.toContain('data-state="selected"');
    expect(render().match(/aria-pressed="true"/gu)).toHaveLength(1);
  });

  it("keeps the status and the holds when the review data is unavailable", () => {
    const html = render({ review: null });
    expect(rowOf(html, "Anna")).toBe("A Anna 15 posted in 7 days — — — 1 1 open — On");
    expect(html).toContain("The review data is unavailable");
  });
});

describe("IntervalBar", () => {
  it("draws the band from the lower bound to the accuracy, with the two bars marked", () => {
    const html = renderToStaticMarkup(<IntervalBar accuracy={0.9} lower={0.6} amber={false} />);
    expect(html).toContain("left:60%");
    expect(html).toMatch(/width:30(?:\.\d+)?%/u);
    expect(html).toContain("left:70%");
    expect(html).toContain("left:80%");
    expect(html).toContain("left:90%");
    expect(renderToStaticMarkup(<IntervalBar accuracy={0.5} lower={0.2} amber />)).toContain("bg-amber-500");
  });
});

describe("TutorFilterChip", () => {
  it("names the tutor the page shows and offers to clear the filter", () => {
    const html = renderToStaticMarkup(<TutorFilterChip name="Anna" onClear={() => undefined} />);
    expect(html).toContain("Showing Anna");
    expect(html).toContain('aria-label="Clear the tutor filter"');
  });
});
