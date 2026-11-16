import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import type { HiringNeed } from "../capacity";
import {
  buildDemand,
  demandSubject,
  hiringCapacity,
  OTHER_SUBJECT,
  prioritise,
  type DemandReport,
  type EnrolmentRow,
} from "../demand";

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

  it("reads short and mixed English titles", () => {
    expect(demandSubject("In-Person Session - Eng")).toBe("EFL/ESL");
    expect(demandSubject("In-Person Session - Eng Lit")).toBe("English Literature");
    expect(demandSubject("In-Person Session - Eng VR")).toBe("11+ reasoning");
    expect(demandSubject("In-Person Session - Writing")).toBe("EFL/ESL");
    expect(demandSubject("In-Person Session - Literature writing")).toBe("English Literature");
    expect(demandSubject("In-Person Session - Engineering")).toBe(OTHER_SUBJECT);
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

  it("puts a class in the block of its Bangkok date, whatever the hour", () => {
    // Now is 17 Nov 12:00 in Bangkok. The blocks are 20 Aug–18 Sep, 19 Sep–18 Oct and 19 Oct–17 Nov.
    const at = (iso: string) => ({ first: new Date(iso), last: new Date(iso) });
    const d = demand([
      row("a", "Math", 0, at("2026-10-18T16:00:00Z")), // 18 Oct 23:00 Bangkok: the middle block.
      row("b", "Math", 0, at("2026-10-18T17:30:00Z")), // 19 Oct 00:30 Bangkok: the last block.
      row("c", "Math", 0, at("2026-08-19T16:00:00Z")), // 19 Aug 23:00 Bangkok: before the period.
      row("d", "Math", 0, at("2026-08-19T17:30:00Z")), // 20 Aug 00:30 Bangkok: the first day.
    ]);
    expect(subject(d, "Mathematics")).toMatchObject({ started: 3, months: [1, 1, 1] });
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

  it("scores with the block the row names, and scores 0 when only tutors with no class are left", () => {
    const two = need("Physics", null, {
      tightest: "weekday",
      blocks: [{ ...block(0.9), key: "weekday", hire: 2 }, { ...block(1), key: "saturday", hire: 1 }],
    });
    const idleOnly = need("Chemistry", null, { tutors: 0, idle: ["Rest"], status: "unknown", tightest: null });
    const rows = prioritise([idleOnly, two], starts([["Physics", 10], ["Chemistry", 10]]), []);
    expect(rows.map((r) => [r.subject, r.score])).toEqual([
      ["Physics", 9],
      ["Chemistry", 0],
    ]);
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

describe("hiringCapacity", () => {
  const index = { tutorGroups: [], syncedAt: NOW } as never;
  const db = (execute: () => Promise<unknown>) => ({ execute }) as unknown as Database;
  afterEach(() => vi.restoreAllMocks());

  it("still gives the tutor hours when the new-student read fails, and logs the error name only", async () => {
    vi.mocked(ensureIndex).mockResolvedValue(index);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("connection string with a secret"), { name: "NeonDbError" });
    const report = await hiringCapacity([], db(() => Promise.reject(failure)), NOW);
    expect(report).toMatchObject({ demand: null, needs: [], from: "2026-11-18" });
    expect(log.mock.calls).toEqual([["[hiring-capacity] demand read failed", "NeonDbError"]]);
  });

  it("joins the new students, and keeps Hiring subjects out of the other-subjects list", async () => {
    vi.mocked(ensureIndex).mockResolvedValue(index);
    const at = (ago: number) => daysAgo(ago).toISOString();
    const rows = [
      { student: "a", class_id: "c1", title: "In-Person Session - French", tutor: null, level: "Y9-11", first: at(5), last: at(5) },
      { student: "b", class_id: "c2", title: "In-Person Session - Science", tutor: null, level: "Y2-8", first: at(5), last: at(5) },
    ];
    const report = await hiringCapacity([], db(() => Promise.resolve({ rows })), NOW);
    expect(report.needs.map((n) => [n.subject, n.status, n.demand?.started])).toEqual([["French", "unknown", 1]]);
    expect(report.demand).toMatchObject({ from: "2026-08-20", to: "2026-11-17", started: 2 });
    expect(report.demand!.subjects.map((d) => d.subject)).toEqual(["Science (general)"]);
  });
});
