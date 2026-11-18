import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CapacityReport, CapacityTutor, HiringNeed } from "@/lib/hiring/capacity";
import type { DemandSubject } from "@/lib/hiring/demand";
import { CapacityScreen, CapacityView, demandTrend, NeedDetail, needReason } from "../capacity-screen";

const row = (given: number, booked: number) => ({
  given,
  booked,
  remaining: given - booked,
  outside: 0,
  utilization: given ? booked / given : null,
});
const block = (key: "weekday" | "saturday" | "sunday", given: number, booked: number, hire = 0, givers = 2) => ({
  key,
  given,
  booked,
  used: given ? booked / given : null,
  givers,
  hire,
});
const tutor = (key: string, subjects: string[], given: number, booked: number, patch: Partial<CapacityTutor> = {}): CapacityTutor => ({
  ...row(given, booked),
  key,
  name: key,
  subjects,
  idle: false,
  busy: { weekday: { given: 0, booked: 0 }, saturday: { given: 0, booked: 0 }, sunday: { given: 6, booked: 5 } },
  leave: 0,
  leaveUnknown: false,
  issues: [],
  ...patch,
});
const starts = (subject: string, months: [number, number, number], patch: Partial<DemandSubject> = {}): DemandSubject => ({
  subject,
  onHiringList: true,
  started: months[0] + months[1] + months[2],
  months,
  active: 50,
  levels: [
    { level: "Y9-11 / G8-10 (Int.)", started: months[0] + months[1] },
    { level: "Y2-8 / G1-7 (Int.)", started: months[2] },
  ],
  ...patch,
});
const need = (subject: HiringNeed["subject"], patch: Partial<HiringNeed> = {}): HiringNeed => ({
  subject,
  wiseSubjects: [subject],
  hiring: true,
  rank: 1,
  tutors: 2,
  tutorKeys: ["Both", "Solo"],
  idle: [],
  review: 0,
  blocks: [block("weekday", 20, 8), block("saturday", 10, 5), block("sunday", 12, 6)],
  hire: 0,
  status: "enough",
  tightest: "sunday",
  demand: null,
  score: 0,
  ...patch,
});
const report = (patch: Partial<CapacityReport> = {}): CapacityReport => ({
  from: "2026-11-18",
  to: "2026-12-15",
  weeks: 4,
  syncedAt: "2026-11-17T05:00:00.000Z",
  stale: false,
  totals: { ...row(30, 21), tutors: 3 },
  needs: [
    need("Physics", {
      hire: 2,
      status: "hire",
      hiring: false,
      idle: ["Rest"],
      review: 1,
      blocks: [block("weekday", 20, 8), block("saturday", 10, 7), block("sunday", 12, 11, 2)],
      demand: starts("Physics", [4, 8, 12]),
      score: 22,
    }),
    need("Mathematics", {
      status: "watch",
      blocks: [block("weekday", 20, 8), block("saturday", 10, 7), block("sunday", 12, 8)],
      demand: starts("Mathematics", [10, 5, 5]),
      score: 13.3,
    }),
    need("Thai"),
  ],
  demand: {
    from: "2026-08-20",
    to: "2026-11-17",
    started: 60,
    unknown: 4,
    subjects: [starts("Science (general)", [5, 5, 6], { onHiringList: false })],
  },
  subjects: [
    { ...row(20, 18), subject: "Physics", hiringSubject: "Physics", hiring: false, rank: 2, tutors: 1, tutorKeys: ["Both"], bookedHere: 6, levels: [] },
    { ...row(30, 21), subject: "Math", hiringSubject: "Mathematics", hiring: true, rank: 1, tutors: 2, tutorKeys: ["Both", "Solo"], bookedHere: 15, levels: [] },
  ],
  tutors: [
    tutor("Both", ["Math", "Physics"], 20, 18, { outside: 1.5, leave: 2 }),
    tutor("Solo", ["Math"], 10, 3, { leaveUnknown: true }),
    tutor("Rest", ["Physics"], 40, 0, { idle: true }),
  ],
  needsReview: [tutor("Unsure", [], 0, 0, { issues: ["completeness"] })],
  unidentified: 1.25,
  ...patch,
});
const view = (r = report(), error?: string) =>
  renderToStaticMarkup(<CapacityView report={r} reload={() => {}} busy={false} error={error} />);

describe("CapacityView", () => {
  it("leads with the top of the list, in words", () => {
    const html = view();
    expect(html).toContain("Top priorities");
    expect(html).toContain(">Physics · Mathematics<");
    expect(html).toContain("New students are counted from 20 Aug to 17 Nov.");
    expect(html).toContain("above 75% of the hours students come");
    expect(html).not.toContain("Wise data is old");
    expect(html).not.toContain("could not load");
    expect(view(report({ needs: [need("Thai")] }))).toContain("No new tutor needed");
    // A subject over the limit is named even with no new student.
    expect(view(report({ needs: [need("History", { hire: 1, status: "hire" })] }))).toContain(">History<");
  });

  it("shows each subject with its new students, how full the tutors are, and what to do", () => {
    const html = view();
    expect(html).toContain('aria-label="1. Physics: 24 new students, hire 2.');
    expect(html).toContain(">24<");
    expect(html).toContain(">rising<");
    expect(html).toContain(">falling<");
    expect(html).toContain(">Hire 2<");
    expect(html).toContain(">92%<");
    expect(html).toContain(
      "Sunday peak 10:00–16:00: 92% full · 2 tutors · 1 more with no classes: check first · 1 of 4 not loaded from Wise · Hiring is switched off in Rules and setup",
    );
    expect(html).toContain(">Nearly full<");
    expect(html).toContain(">Enough tutors<");
    expect(html.indexOf(">Physics<")).toBeLessThan(html.indexOf(">Mathematics<"));
    // The working stays closed until a subject is clicked.
    expect(html).not.toContain("are over");
  });

  it("shows the new students of subjects that are not on the Hiring list", () => {
    const html = view();
    expect(html).toContain("New students in subjects that are not on the Hiring list");
    expect(html).toContain(">Science (general)<");
    expect(html).toContain(">16<");
  });

  it("keeps the tutors with no classes and all the hours behind a click", () => {
    const html = view();
    expect(html).toContain("<summary>1 tutor with no classes · 1 not counted</summary>");
    expect(html).toContain("Wise hours or leave did not load");
    expect(html).toContain("<summary>All hours and all tutors</summary>");
    expect(html).toContain("All tutors (3)");
    expect(html).toContain("1.3 h a week of classes have a title");
  });

  it("warns when the Wise data is old, when a reload fails, and when the new-student numbers are missing", () => {
    expect(view(report({ stale: true }))).toContain("Wise data is old");
    expect(view(report(), "Server error.")).toContain("Could not reload, so these are the earlier numbers. Server error.");
    const html = view(report({ demand: null }));
    expect(html).toContain("The new-student numbers could not load.");
    expect(html).not.toContain("not on the Hiring list");
  });
});

describe("demandTrend", () => {
  it("compares the last 30 days with the first 30, and says nothing for a few students", () => {
    expect(demandTrend({ started: 24, months: [4, 8, 12] })).toBe("rising");
    expect(demandTrend({ started: 20, months: [10, 5, 5] })).toBe("falling");
    expect(demandTrend({ started: 31, months: [10, 10, 11] })).toBe("steady");
    expect(demandTrend({ started: 6, months: [1, 1, 4] })).toBe("");
    expect(demandTrend({ started: 10, months: [0, 10, 0] })).toBe("steady");
  });
});

describe("needReason", () => {
  it("names the block that decides", () => {
    expect(needReason(need("Thai", { tutors: 1 }))).toBe("Sunday peak 10:00–16:00: 50% full · 1 tutor");
    expect(needReason(need("Thai", { tightest: null }))).toBe("No busy hours in Wise · 2 tutors");
  });

  it("does not call a subject fine when no tutor with classes could be read", () => {
    const none = need("Thai", { tutors: 0, tutorKeys: [], status: "unknown", tightest: null, idle: ["Rest"], review: 2 });
    expect(needReason(none)).toBe("No tutor with classes to measure · 1 more with no classes: check first · 2 of 3 not loaded from Wise");
    expect(view(report({ needs: [none] }))).toContain(">Not known<");
  });
});

describe("NeedDetail", () => {
  it("shows a sum that a reader can repeat and that ends on the number", () => {
    // 40 h given by 10 tutors, 38 h booked. The limit is 30 h, so 8 h are over. A tutor gives 4 h, 3 h at 75%: 8 ÷ 3 → 3.
    const physics = need("Physics", {
      hire: 3,
      status: "hire",
      tightest: "weekday",
      idle: ["Rest"],
      review: 1,
      blocks: [block("weekday", 40, 38, 3, 10), block("saturday", 10, 9, 1, 2), block("sunday", 12, 6)],
    });
    const html = renderToStaticMarkup(<NeedDetail need={physics} report={report()} />);
    expect(html).toContain(
      "Weekday evenings 16:00–20:00: 38.0 h are booked. The limit is 75% of 40.0 h = 30.0 h, so 8.0 h are over. One tutor gives about 4.0 h in these hours, and 75% of that is 3.0 h. 8.0 ÷ 3.0, rounded up, makes 3 new tutors.",
    );
    expect(html).toContain("not counted: Rest.");
    expect(html).toContain("1 tutor of this subject did not load from Wise in the last sync and is not counted.");
    expect(html).toContain("38.0 of 40.0 h a week booked");
  });

  it("shows the new students by 30 days and by level, and why the subject has its place", () => {
    const physics = need("Physics", { demand: starts("Physics", [4, 8, 12]), score: 22, blocks: [block("sunday", 12, 11)] });
    const html = renderToStaticMarkup(<NeedDetail need={physics} report={report()} />);
    expect(html).toContain("New students: 24 in the last 90 days");
    expect(html).toContain("20 Aug to 18 Sep");
    expect(html).toContain("19 Sep to 18 Oct");
    expect(html).toContain("19 Oct to 17 Nov");
    expect(html).toContain("Y9-11 / G8-10 (Int.)");
    expect(html).toContain("50 students had a Physics class in the last 30 days.");
    expect(html).toContain("Place in the list: 24 new students × 92% full = 22.");
  });

  it("has no sum when no hire is needed", () => {
    expect(renderToStaticMarkup(<NeedDetail need={need("Thai")} report={report()} />)).not.toContain("rounded up");
  });
});

describe("CapacityScreen", () => {
  it("does not load before the tab opens", () => {
    expect(renderToStaticMarkup(<CapacityScreen active={false} />)).toContain("Loading capacity…");
  });

  it("holds the shape of the report while it loads, so nothing jumps", () => {
    const html = renderToStaticMarkup(<CapacityScreen active={false} />);
    expect(html).toContain('role="status"');
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(7);
  });
});
