import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TutorFilterChip, TutorTable, buildTutorRows } from "../tutor-table";
import { FIXTURE_NOW, dashboardFixture, reviewFixture } from "./fixtures";

const NOW = new Date(FIXTURE_NOW);

function render(options: { canControl?: boolean; selected?: string | null; review?: ReturnType<typeof reviewFixture> | null } = {}): string {
  return renderToStaticMarkup(
    <TutorTable dashboard={dashboardFixture()} review={options.review === undefined ? reviewFixture() : options.review} now={NOW}
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

describe("TutorTable", () => {
  it("shows one row per tutor: accuracy, lower bound, coverage, holds, real fixes, review phase and status", () => {
    const html = render();
    expect(html).toContain("5 in the pilot · 4 switched on · last 14 days");
    expect(html).toContain("Click a tutor to filter the to-do list and the charts.");
    for (const heading of ["Tutor", "Accuracy", "Lower bound", "Coverage", "Holds", "Real fixes", "Review", "Status"]) expect(html).toContain(`${heading}`);
    expect(rowOf(html, "Anna")).toBe("A Anna 21 posts in Wise · 1 to review 95% 19 / 20 76.3% 84.6% 33 / 39 1 1 open 1 Every post (new) On");
    expect(rowOf(html, "Ben")).toBe("B Ben 19 posts in Wise · 1 to review 82.3% 14 / 17 58.9% 68.4% 26 / 38 1 1 open 3 1 critical Every post (new) On");
    expect(rowOf(html, "Dao")).toBe("D Dao 0 posts in Wise · 0 to review — — — 1 0 open 0 Every post (new) Partly on");
    expect(rowOf(html, "Emma")).toContain("Off");
    expect(html).toContain("23 Sep – 6 Oct");
    // The old tables' columns of raw counts are gone from this table.
    expect(html).not.toContain("Median to post");
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
    expect(html).toMatch(/<tr[^>]*aria-selected="true"[^>]*data-tutor-row="Chai"/u);
    expect(html.match(/aria-selected="true"/gu)).toHaveLength(1);
    expect(html.match(/aria-pressed="true"/gu)).toHaveLength(1);
    expect(render().match(/aria-selected="true"/gu)).toBeNull();
  });

  it("keeps the status and the holds when the review data is unavailable", () => {
    const html = render({ review: null });
    expect(rowOf(html, "Anna")).toBe("A Anna 15 posted in 7 days — — — 1 1 open — — On");
    expect(html).toContain("The review data is unavailable");
  });
});

describe("TutorFilterChip", () => {
  it("names the tutor the page shows and offers to clear the filter", () => {
    const html = renderToStaticMarkup(<TutorFilterChip name="Anna" onClear={() => undefined} />);
    expect(html).toContain("Showing Anna");
    expect(html).toContain('aria-label="Clear the tutor filter"');
  });
});
