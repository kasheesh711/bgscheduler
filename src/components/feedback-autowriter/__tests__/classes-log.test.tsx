import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClassesLog, buildClassesLog, filterClassesLog, stateOptions, type ClassLogFilter } from "../classes-log";
import { APPROVED, SESSION, dashboardFixture, queueItem, reviewFixture } from "./fixtures";

const ANY: ClassLogFilter = { review: "all", state: null, tutorKey: null, evidence: null };
const ids = (rows: ReadonlyArray<{ wiseSessionId: string }>) => rows.map((row) => row.wiseSessionId);

function render(options: { tutorKey?: string | null; review?: ReturnType<typeof reviewFixture> | null; dashboard?: ReturnType<typeof dashboardFixture> } = {}): string {
  return renderToStaticMarkup(
    <ClassesLog dashboard={options.dashboard ?? dashboardFixture()} review={options.review === undefined ? reviewFixture() : options.review}
      tutorKey={options.tutorKey ?? null} onTutorChange={() => undefined} onOpen={() => undefined} />,
  );
}

function rowOf(html: string, wiseSessionId: string): string {
  const row = new RegExp(`<tr[^>]*data-class-row="${wiseSessionId}"[^>]*>(.*?)</tr>`, "u").exec(html);
  if (!row) throw new Error(`no row for ${wiseSessionId}`);
  return row[1].replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

describe("buildClassesLog", () => {
  const rows = buildClassesLog(dashboardFixture(), reviewFixture());
  const row = (wiseSessionId: string) => rows.find((entry) => entry.wiseSessionId === wiseSessionId)!;

  it("lists the recent classes, every hold, and the review data's older posts, latest class first", () => {
    // 15 recent classes, plus two posts only the review data has (2 Oct and 29 Sep).
    expect(rows).toHaveLength(17);
    expect(ids(rows).slice(0, 2)).toEqual([SESSION.annaToReview, SESSION.benToReview]);
    expect(ids(rows).slice(-3)).toEqual([SESSION.annaReviewed, SESSION.emmaHeldStale, SESSION.benCritical]);
    // Every hold is in the log, the written one and the stale one included.
    for (const hold of dashboardFixture().holds) expect(row(hold.wiseSessionId).state).toBe("held");
    expect(row(SESSION.daoHeldWritten).note).toBe("Written by a person since");
    expect(row(SESSION.emmaHeldStale).note).toBeNull();
  });

  it("opens a posted class as its review, a held one as its hold, and says what a row from the review data alone lacks", () => {
    expect(row(SESSION.annaToReview)).toMatchObject({ target: { kind: "review" }, review: { status: "needs_review" }, arm: "sol", evidence: "transcript", latencyMinutes: 72 });
    expect(row(SESSION.chaiHeldJudge)).toMatchObject({ target: { kind: "hold" }, review: null });
    expect(row(SESSION.benFailed)).toMatchObject({ target: { kind: "failed_post" }, state: "verify_failed" });
    expect(row(SESSION.annaShadow)).toMatchObject({ target: { kind: "class" }, state: "would_submit" });
    expect(row(SESSION.benFlagged)).toMatchObject({ note: "No recording after 3 h — from summary", review: { status: "flagged" } });
    // Only the review data knows this older post: its state is the post's outcome, its cost is not known here.
    expect(row(SESSION.benCritical)).toMatchObject({
      state: "verified", arm: "glm", evidence: "summary", latencyMinutes: 4, costUsd: null, target: { kind: "review" }, tutor: "Ben",
    });
  });

  it("keeps a held class that is older than the recent rows, and strips the account suffix from a tutor's name", () => {
    const dashboard = dashboardFixture();
    const log = buildClassesLog({
      ...dashboard,
      recent: [{ ...dashboard.recent[0], tutor: "Anna Online" }],
      holds: [{ ...dashboard.holds[0], wiseSessionId: "old-hold", tutor: "Ben Online", classEndedAt: null }],
    }, null);
    expect(log.map((entry) => [entry.wiseSessionId, entry.tutor, entry.state, entry.evidence, entry.costUsd])).toEqual([
      [SESSION.annaToReview, "Anna", "verified", "transcript", 0.0452],
      // No class time: last.
      ["old-hold", "Ben", "held", null, null],
    ]);
    // Without the review data a posted class opens on its own.
    expect(log[0].target).toEqual({ kind: "class", wiseSessionId: SESSION.annaToReview });
  });
});

describe("filterClassesLog", () => {
  const rows = buildClassesLog(dashboardFixture(), reviewFixture());

  it("filters by state, tutor and evidence", () => {
    expect(filterClassesLog(rows, ANY)).toHaveLength(17);
    expect(filterClassesLog(rows, { ...ANY, state: "held" })).toHaveLength(5);
    expect(ids(filterClassesLog(rows, { ...ANY, state: "held", tutorKey: "Chai" }))).toEqual([SESSION.chaiHeldJudge]);
    expect(filterClassesLog(rows, { ...ANY, tutorKey: "Emma" })).toHaveLength(2);
    expect(filterClassesLog(rows, { ...ANY, evidence: "summary", tutorKey: "Ben" }).every((row) => row.evidence === "summary")).toBe(true);
    expect(filterClassesLog(rows, { ...ANY, evidence: "transcript", state: "verified", tutorKey: "Anna" })).toHaveLength(2);
  });

  it("filters the posted classes by where their review stands", () => {
    expect(ids(filterClassesLog(rows, { ...ANY, review: "required" }))).toEqual([SESSION.annaToReview, SESSION.benToReview, SESSION.chaiToReview]);
    expect(ids(filterClassesLog(rows, { ...ANY, review: "flagged" }))).toEqual([SESSION.benFlagged]);
    expect(filterClassesLog(rows, { ...ANY, review: "required", tutorKey: "Dao" })).toEqual([]);
  });
});

describe("stateOptions", () => {
  const rows = buildClassesLog(dashboardFixture(), reviewFixture());

  it("offers the states the rows have, once each, in the order of their labels", () => {
    const options = stateOptions(rows, null);
    expect(new Set(options).size).toBe(options.length);
    expect(new Set(options)).toEqual(new Set(rows.map((row) => row.state)));
    // Held, Out of scope, Posted, …: by the label the owner reads, not by the state's own name.
    expect(options.indexOf("held")).toBeLessThan(options.indexOf("skipped_scope"));
    expect(options.indexOf("skipped_scope")).toBeLessThan(options.indexOf("verified"));
  });

  it("keeps the chosen state when a reload leaves no class in it, so the filter in force stays visible", () => {
    expect(rows.some((row) => row.state === "generating")).toBe(false);
    expect(stateOptions(rows, null)).not.toContain("generating");
    expect(stateOptions(rows, "generating")).toContain("generating");
    // The table is empty under it, and the select still says why.
    expect(filterClassesLog(rows, { ...ANY, state: "generating" })).toEqual([]);
    // A state the rows do have is not listed twice.
    expect(stateOptions(rows, "held").filter((state) => state === "held")).toHaveLength(1);
  });
});

describe("ClassesLog", () => {
  it("is collapsed by default and lists each class with its state, review, writer, time to post and cost", () => {
    const html = render();
    expect(html).toMatch(/^<details(?![^>]*\sopen)/u);
    expect(html).toContain("All classes");
    expect(html).toContain("17 of 17 shown");
    expect(rowOf(html, SESSION.annaToReview)).toBe("6 Oct, 13:00 Anna Year 9 Maths Posted Needs review GPT-6.1 Sol · transcript 1.2 h $0.05 Review");
    expect(rowOf(html, SESSION.benToReview)).toBe("6 Oct, 11:00 Ben Year 8 English Posted Needs review GPT-6 Luna 2.5 min $0.0094 Review");
    // Waiting for its recording: nobody has written it yet, and it will be written from the transcript.
    expect(rowOf(html, SESSION.daoWaiting)).toBe("6 Oct, 10:00 Dao SAT Reading Waiting for the recording — — · transcript — $0.00 Open");
    expect(rowOf(html, SESSION.benFlagged)).toContain("Posted No recording after 3 h — from summary Flagged · Approved GPT-6 Luna 3.1 h");
    expect(rowOf(html, SESSION.chaiHeldJudge)).toContain("Held — GPT-6.1 Sol · transcript");
    expect(rowOf(html, SESSION.daoHeldWritten)).toContain("Held Written by a person since");
    expect(rowOf(html, SESSION.benCritical)).toContain("Reviewed · Needs fix · critical · Wrong person GLM Flash 4.0 min — Review");
    expect(rowOf(html, SESSION.annaTutorFirst)).toContain("Tutor wrote it");
    expect(rowOf(html, SESSION.emmaOutOfScope)).toContain("Out of scope");
    expect(rowOf(html, SESSION.annaShadow)).toContain("Shadow draft");
    // The written text is in the drawer, never in the table.
    expect(html).not.toContain("Rotations and reflections");
  });

  it("offers the state, tutor and evidence filters, and the review filter counted from the database totals", () => {
    const review = reviewFixture();
    const html = render({ review: { ...review, queueTotals: { needsReview: 40, flagged: 3, all: 350, shown: 2 } } });
    expect(html).toContain("Needs review (40)");
    expect(html).toContain("Flagged (3)");
    expect(html).toContain("All classes");
    expect(html).toContain("Showing 2 of 350 posts with a review row: every flagged and unreviewed class, then the latest reviewed ones.");
    for (const label of ['aria-label="State"', 'aria-label="Tutor"', 'aria-label="Evidence"', "Any state", "All tutors", "Any evidence", ">Waiting for the recording</option>", ">Emma</option>"]) {
      expect(html).toContain(label);
    }
    // The whole queue is on the page: nothing to say.
    expect(render({ review: { ...review, queueTotals: { needsReview: 3, flagged: 1, all: 7, shown: 7 } } })).not.toContain("posts with a review row");
  });

  it("follows the page's tutor filter", () => {
    const html = render({ tutorKey: "Dao" });
    expect(html).toContain("2 of 17 shown");
    expect(html).toMatch(/<option value="Dao" selected="">Dao<\/option>/u);
    expect(html).not.toContain("Year 9 Maths");
  });

  it("names the writer of a Sol draft as Sol, never as another model", () => {
    const dashboard = dashboardFixture();
    const html = render({ dashboard: { ...dashboard, holds: [], failedPosts: [], recent: [{ ...dashboard.recent[0], arm: "sol", evidence: "summary" }] }, review: null });
    expect(html.match(/GPT-6\.1 Sol/gu)).toHaveLength(1);
    expect(html).not.toContain("GPT-6 Luna");
    expect(html).not.toContain("GLM Flash");
    expect(html).not.toContain("· transcript");
    // No review data: no review filter, and the post opens on its own.
    expect(html).not.toContain("Needs review");
    expect(html).toContain(">Open</button>");
  });

  it("says when the page holds only the latest classes of the window, and is silent when it holds them all", () => {
    const dashboard = dashboardFixture();
    // The fixture's 15 recent rows are the latest of 58 classes.
    const capped = render();
    expect(capped).toContain("the latest 15 of 58 classes of the last 7 days, every held class, and the posts of the review data");
    expect(capped).toContain("Showing the latest 15 of the 58 classes of the last 7 days.");
    const whole = render({ dashboard: { ...dashboard, totals: { ...dashboard.totals, seen: dashboard.recent.length } } });
    expect(whole).toContain("the last 7 days, every held class, and the posts of the review data");
    expect(whole).not.toContain("the latest 15 of");
    expect(whole).not.toContain("Showing the latest");
  });

  it("says when there is no class, and when no class matches", () => {
    const fixture = dashboardFixture();
    const dashboard = { ...fixture, totals: { ...fixture.totals, seen: 0 } };
    const empty = render({ dashboard: { ...dashboard, holds: [], failedPosts: [], recent: [] }, review: null });
    expect(empty).toContain("No classes handled in this window yet.");
    expect(empty).not.toContain("Showing the latest");
    const review = reviewFixture();
    const onlyReviewed = { ...review, queue: [queueItem(SESSION.chaiReviewed, "Chai", "2026-10-04", "17:00", { status: "reviewed", currentVerdict: APPROVED })] };
    expect(render({ tutorKey: "Emma", dashboard: { ...dashboard, holds: [], failedPosts: [], recent: [] }, review: onlyReviewed })).toContain("No class matches these filters.");
  });
});
