import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CapacityReport, CapacityTutor, HiringNeed } from "@/lib/hiring/capacity";
import { CapacityScreen, CapacityView, needReason } from "../capacity-screen";

const row = (given: number, booked: number) => ({
  given,
  booked,
  remaining: given - booked,
  outside: 0,
  utilization: given ? booked / given : null,
});
const block = (key: "weekday" | "saturday" | "sunday", given: number, booked: number, hire = 0) => ({
  key,
  given,
  booked,
  used: given ? booked / given : null,
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
const need = (subject: HiringNeed["subject"], patch: Partial<HiringNeed> = {}): HiringNeed => ({
  subject,
  wiseSubjects: [subject],
  hiring: true,
  rank: 1,
  tutors: 2,
  tutorKeys: ["Both", "Solo"],
  idle: [],
  blocks: [block("weekday", 20, 8), block("saturday", 10, 5), block("sunday", 12, 6)],
  hire: 0,
  status: "enough",
  tightest: "sunday",
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
      blocks: [block("weekday", 20, 8), block("saturday", 10, 7), block("sunday", 12, 11, 2)],
    }),
    need("Mathematics", { status: "watch", blocks: [block("weekday", 20, 8), block("saturday", 10, 7), block("sunday", 12, 8)] }),
    need("Thai"),
  ],
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
  it("leads with what to hire, in words", () => {
    const html = view();
    expect(html).toContain("Hire this month");
    expect(html).toContain("1 subject needs a new tutor");
    expect(html).toContain("more than 75% full");
    expect(html).not.toContain("Wise data is old");
    expect(view(report({ needs: [need("Thai")] }))).toContain("No new tutor needed");
  });

  it("gives each subject one status and one reason", () => {
    const html = view();
    expect(html).toContain(">Hire 2<");
    expect(html).toContain("Sundays are 92% full · 2 tutors · 1 more with no classes: check first · Hiring is switched off in Rules and setup");
    expect(html).toContain(">Nearly full<");
    expect(html).toContain(">Enough tutors<");
    expect(html.indexOf(">Physics<")).toBeLessThan(html.indexOf(">Mathematics<"));
    // The working stays closed until a subject is clicked.
    expect(html).not.toContain("are over the limit");
  });

  it("keeps the tutors with no classes and all the hours behind a click", () => {
    const html = view();
    expect(html).toContain("<summary>1 tutor with no classes · 1 not counted</summary>");
    expect(html).toContain("Wise hours or leave did not load");
    expect(html).toContain("<summary>All hours and all tutors</summary>");
    expect(html).toContain("All tutors (3)");
    expect(html).toContain("1.3 h a week of classes have a title");
  });

  it("warns when the Wise data is old, and when a reload fails", () => {
    expect(view(report({ stale: true }))).toContain("Wise data is old");
    expect(view(report(), "Server error.")).toContain("Could not reload, so these are the earlier numbers. Server error.");
  });
});

describe("needReason", () => {
  it("names the fullest busy block", () => {
    expect(needReason(need("Thai", { tutors: 1 }))).toBe("Sundays are 50% full · 1 tutor");
    expect(needReason(need("Thai", { tightest: null }))).toBe("No busy hours in Wise · 2 tutors");
  });
});

describe("CapacityScreen", () => {
  it("does not load before the tab opens", () => {
    expect(renderToStaticMarkup(<CapacityScreen active={false} />)).toContain("Loading capacity…");
  });
});
