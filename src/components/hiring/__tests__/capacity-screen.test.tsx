import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CapacityReport, CapacityTutor } from "@/lib/hiring/capacity";
import { CapacityScreen, CapacityView } from "../capacity-screen";

const row = (given: number, booked: number) => ({
  given,
  booked,
  remaining: given - booked,
  outside: 0,
  utilization: given ? booked / given : null,
});
const tutor = (key: string, subjects: string[], given: number, booked: number, patch: Partial<CapacityTutor> = {}): CapacityTutor => ({
  ...row(given, booked),
  key,
  name: key,
  subjects,
  leave: 0,
  leaveUnknown: false,
  issues: [],
  ...patch,
});
const report = (patch: Partial<CapacityReport> = {}): CapacityReport => ({
  from: "2026-11-18",
  to: "2026-12-15",
  weeks: 4,
  syncedAt: "2026-11-17T05:00:00.000Z",
  stale: false,
  totals: { ...row(30, 21), tutors: 2 },
  subjects: [
    {
      ...row(20, 18),
      subject: "Physics",
      hiringSubject: "Physics",
      hiring: true,
      rank: 2,
      tutors: 1,
      tutorKeys: ["Both"],
      bookedHere: 6,
      levels: [{ ...row(20, 18), curriculum: "International", level: "Y12-13", tutors: 1 }],
    },
    { ...row(30, 21), subject: "Math", hiringSubject: "Mathematics", hiring: false, rank: 5, tutors: 2, tutorKeys: ["Both", "Solo"], bookedHere: 15, levels: [] },
    { ...row(0, 0), subject: "Science", hiringSubject: null, hiring: null, rank: null, tutors: 0, tutorKeys: [], bookedHere: 0, levels: [] },
  ],
  tutors: [tutor("Both", ["Math", "Physics"], 20, 18, { outside: 1.5, leave: 2 }), tutor("Solo", ["Math"], 10, 3, { leaveUnknown: true })],
  needsReview: [tutor("Unsure", [], 0, 0, { issues: ["alias"] })],
  unidentified: 1.25,
  ...patch,
});
const view = (r = report()) => renderToStaticMarkup(<CapacityView report={r} reload={() => {}} busy={false} />);

describe("CapacityView", () => {
  it("shows the company rate and hours per week", () => {
    const html = view();
    expect(html).toContain("Utilization · 18 Nov to 15 Dec");
    expect(html).toContain(">70%<");
    expect(html).toContain(">30.0<");
    expect(html).toContain("Per week · 30% free");
    expect(html).toContain("1 more need review");
    expect(html).not.toContain("Wise data is old");
  });

  it("shows each subject with its Hiring switch, and no switch for a subject Hiring does not have", () => {
    const html = view();
    expect(html).toContain("Hiring · priority 2");
    expect(html).toContain("Not hiring");
    expect(html.match(/priority \d|Not hiring/g)).toHaveLength(2);
    // Physics: 6 of 20 h in this subject, 12 h in other subjects.
    expect(html).toContain('style="width:30%"');
    expect(html).toContain('style="width:60%"');
    expect(html).toContain(">90%<");
  });

  it("lists every tutor, then the tutors that are not in the totals", () => {
    const html = view();
    expect(html).toContain("By tutor (2)");
    expect(html).toContain("2.0 h leave");
    expect(html).toContain("Leave not known to the end");
    expect(html).toContain("Needs review (1) · not in the totals");
    expect(html).toContain("Tutor identity not confirmed in Wise data · No hours in Wise");
    expect(html).toContain("1.3 h a week of classes have a title");
  });

  it("warns when the Wise data is old", () => {
    expect(view(report({ stale: true }))).toContain("Wise data is old");
  });
});

describe("CapacityScreen", () => {
  it("does not load before the tab opens", () => {
    expect(renderToStaticMarkup(<CapacityScreen active={false} />)).toContain("Loading capacity…");
  });
});
