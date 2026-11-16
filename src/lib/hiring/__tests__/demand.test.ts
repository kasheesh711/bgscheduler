import { describe, expect, it, vi } from "vitest";
import type { HiringNeed } from "../capacity";
import { buildDemand, demandSubject, OTHER_SUBJECT, prioritise, type DemandReport, type EnrolmentRow } from "../demand";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));

// Tuesday noon in Bangkok.
const NOW = new Date("2026-11-17T05:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const row = (student: string, title: string, firstAgo: number, patch: Partial<EnrolmentRow> = {}): EnrolmentRow => ({
  student,
  classId: `class-${student}`,
  title,
  level: "Y9-11 / G8-10 (Int.)",
  tutor: "T",
  first: daysAgo(firstAgo),
  last: daysAgo(Math.min(firstAgo, 3)),
  ...patch,
});
const demand = (rows: EnrolmentRow[], tutorTags = new Map<string, string[]>()) => buildDemand({ rows, tutorTags, now: NOW });
const subject = (d: DemandReport, name: string) => d.subjects.find((s) => s.subject === name)!;

describe("demandSubject", () => {
  it("reads the Hiring subject from the class title", () => {
    expect(demandSubject("In-Person Session - Math")).toBe("Mathematics");
    expect(demandSubject("Live Session-EFL (Cancelled)")).toBe("EFL/ESL");
    expect(demandSubject("On-site Session - English")).toBe("EFL/ESL");
    expect(demandSubject("In-Person Session-Bio")).toBe("Biology");
    expect(demandSubject("In-Person Session - Trial Math")).toBe("Mathematics");
    expect(demandSubject("In-Person Session - French")).toBe("French");
    expect(demandSubject("Live Session - Psycology")).toBe("Psychology");
  });

  it("keeps a plain name for a subject that is not on the Hiring list", () => {
    expect(demandSubject("In-Person Session - Science")).toBe("Science (general)");
    expect(demandSubject("In-Person Session-Non VR")).toBe("11+ reasoning");
    expect(demandSubject("In-Person Session - Interview Prep")).toBe(OTHER_SUBJECT);
  });

  it("gives an untitled class the subject of a tutor with one Hiring subject", () => {
    expect(demandSubject("In-Person Session", ["Math", "MathVR", "Others"])).toBe("Mathematics");
    expect(demandSubject("In-Person Session", ["Math", "Physics"])).toBe(OTHER_SUBJECT);
    expect(demandSubject("")).toBe(OTHER_SUBJECT);
  });
});

describe("buildDemand", () => {
  it("counts a first class in the last 90 days as a start, in its 30-day block", () => {
    const d = demand([row("a", "Math", 80), row("b", "Math", 45), row("c", "Math", 5), row("d", "Math", 0), row("old", "Math", 120)]);
    expect([d.from, d.to]).toEqual(["2026-08-20", "2026-11-17"]);
    expect(subject(d, "Mathematics")).toMatchObject({ started: 4, months: [1, 1, 2], active: 5, onHiringList: true });
    expect(d.started).toBe(4);
  });

  it("does not count a class that is 90 days old or a class after now", () => {
    const d = demand([row("edge", "Math", 90, { last: daysAgo(40) }), row("future", "Math", -1)]);
    expect(d.started).toBe(0);
  });

  it("counts a new subject in the same course, and a new course, as starts", () => {
    const d = demand([
      row("a", "Math", 200),
      row("a", "Physics", 10), // The same Wise class, a new subject.
      row("a", "Math", 20, { classId: "class-a-next-level", level: "Y12-13 / G11-12 (Int.)" }),
    ]);
    expect(subject(d, "Physics").started).toBe(1);
    expect(subject(d, "Mathematics")).toMatchObject({ started: 1, active: 2 });
    expect(subject(d, "Mathematics").levels).toEqual([{ level: "Y12-13 / G11-12 (Int.)", started: 1 }]);
  });

  it("joins the titles of one subject, so an old course is not a new start under a new spelling", () => {
    const d = demand([row("a", "In-Person Session - Math", 200), row("a", "Live Session-Mathematics", 10)]);
    expect(subject(d, "Mathematics").started).toBe(0);
  });

  it("gives an untitled class the subject this student has with this tutor", () => {
    const d = demand([
      row("a", "In-Person Session - Physics", 200),
      row("a", "In-Person Session", 10), // Same student, course and tutor: still Physics, not a start.
      row("b", "In-Person Session", 10, { tutor: "Solo" }),
      row("c", "In-Person Session", 10, { tutor: "Many" }),
    ], new Map([["Solo", ["Chemistry"]], ["Many", ["Math", "Physics"]]]));
    expect(subject(d, "Physics").started).toBe(0);
    expect(subject(d, "Chemistry").started).toBe(1);
    expect(subject(d, OTHER_SUBJECT).started).toBe(1);
    expect(d.unknown).toBe(1);
  });

  it("lists the levels of the starts, largest first", () => {
    const d = demand([
      row("a", "Math", 10, { level: "Y2-8 / G1-7 (Int.)" }),
      row("b", "Math", 10, { level: "Y2-8 / G1-7 (Int.)" }),
      row("c", "Math", 10),
      row("d", "Math", 10, { level: null }),
    ]);
    expect(subject(d, "Mathematics").levels).toEqual([
      { level: "Y2-8 / G1-7 (Int.)", started: 2 },
      { level: "Level not known", started: 1 },
      { level: "Y9-11 / G8-10 (Int.)", started: 1 },
    ]);
  });

  it("orders the subjects by starts", () => {
    const d = demand([row("a", "Physics", 10), row("b", "Math", 10), row("c", "Math", 10), row("d", "Science", 10)]);
    expect(d.subjects.map((s) => [s.subject, s.started, s.onHiringList])).toEqual([
      ["Mathematics", 2, true],
      ["Physics", 1, true],
      ["Science (general)", 1, false],
    ]);
  });
});

describe("prioritise (CAP-06)", () => {
  const block = (used: number | null) => ({ key: "sunday" as const, given: 10, booked: (used ?? 0) * 10, used, givers: 1, hire: 0 });
  const need = (name: HiringNeed["subject"], used: number | null, patch: Partial<HiringNeed> = {}): HiringNeed => ({
    subject: name,
    wiseSubjects: [],
    hiring: true,
    rank: 1,
    tutors: 3,
    tutorKeys: [],
    idle: [],
    review: 0,
    blocks: [block(used)],
    hire: 0,
    status: "enough",
    tightest: "sunday",
    demand: null,
    score: 0,
    ...patch,
  });
  const starts = (list: [string, number][]) =>
    demand(list.flatMap(([title, n]) => Array.from({ length: n }, (_, i) => row(`${title}-${i}`, title, 10))));

  it("puts many new students with nearly full tutors above a full subject with few", () => {
    const rows = prioritise(
      [need("History", 0.97, { hire: 1, status: "hire" }), need("Mathematics", 0.75, { status: "watch" }), need("Physics", 0.5)],
      starts([["History", 1], ["Math", 40], ["Physics", 10]]),
      [],
    );
    expect(rows.map((r) => [r.subject, r.demand?.started, Math.round(r.score)])).toEqual([
      ["Mathematics", 40, 30],
      ["Physics", 10, 5],
      ["History", 1, 1],
    ]);
  });

  it("adds a Hiring subject that has new students and no tutor in Wise", () => {
    const rows = prioritise([need("Mathematics", 0.5)], starts([["Math", 2], ["French", 3], ["Science", 9]]), [
      { subject: "French", hiring: false },
    ]);
    // Nobody can take a French student, so its starts count in full. Science is not on the Hiring list.
    expect(rows.map((r) => [r.subject, r.status, r.tutors, r.score])).toEqual([
      ["French", "unknown", 0, 3],
      ["Mathematics", "enough", 3, 1],
    ]);
    expect(rows[0]).toMatchObject({ hiring: false, rank: 1, hire: 0 });
  });

  it("keeps the order by need for subjects with no new students", () => {
    const rows = prioritise(
      [need("Thai", 0.4), need("History", 0.9, { hire: 1, status: "hire" }), need("Geography", 0.7, { status: "watch" })],
      starts([]),
      [],
    );
    expect(rows.map((r) => [r.subject, r.score, r.demand])).toEqual([
      ["History", 0, null],
      ["Geography", 0, null],
      ["Thai", 0, null],
    ]);
  });
});
