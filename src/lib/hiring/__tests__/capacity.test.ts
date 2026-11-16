import { describe, expect, it } from "vitest";
import type { IndexedTutorGroup } from "@/lib/search/index";
import { buildCapacityReport, classSubject } from "../capacity";
import { instant, type HiringConfig } from "../model";

// Tuesday noon in Bangkok. The period is Wed 18 Nov to Tue 15 Dec 2026: four of each weekday.
const NOW = new Date("2026-11-17T05:00:00Z");
const MON = "2026-11-23";
const TUE = "2026-11-24";
const HOUR = 3_600_000;

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const hours = (day: number, from: number, to: number, wiseTeacherId = "w") => ({
  weekday: day,
  startMinute: from * 60,
  endMinute: to * 60,
  modality: "onsite",
  wiseTeacherId,
});
const lesson = (date: string, from: number, to: number, title = "In-Person Session-Math", extra = {}) => ({
  startTime: instant(date, from * 60),
  endTime: instant(date, to * 60),
  weekday: weekday(date),
  startMinute: from * 60,
  endMinute: to * 60,
  isBlocking: true,
  wiseTeacherId: "w",
  title,
  ...extra,
});
const tag = (subject: string, level = "Y9-11") => ({ subject, curriculum: "International", level });
const group = (canonicalKey: string, extra: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup => ({
  id: canonicalKey,
  canonicalKey,
  displayName: canonicalKey,
  supportedModes: ["onsite"],
  qualifications: [tag("Math")],
  wiseRecords: [],
  availabilityWindows: [hours(1, 10, 14)], // Monday 10:00–14:00 = 4 h a week.
  leaves: [],
  leavesCompleteThrough: new Date("2027-01-31"),
  sessionBlocks: [],
  dataIssues: [],
  ...extra,
});
const report = (groups: IndexedTutorGroup[], priority: HiringConfig["subjectPriority"] = []) =>
  buildCapacityReport({ groups, syncedAt: NOW, priority, now: NOW });

describe("buildCapacityReport", () => {
  it("covers four weeks from tomorrow and shows hours per week", () => {
    const r = report([group("A", { sessionBlocks: [lesson(MON, 10, 12)] })]);
    expect([r.from, r.to, r.weeks]).toEqual(["2026-11-18", "2026-12-15", 4]);
    // 16 h given and 2 h booked in the period.
    expect(r.tutors[0]).toMatchObject({ given: 4, booked: 0.5, remaining: 3.5, outside: 0, utilization: 0.125 });
    expect(r.totals).toMatchObject({ tutors: 1, given: 4, booked: 0.5, remaining: 3.5 });
  });

  it("counts the online and onsite records of one person once", () => {
    const r = report([group("A", { availabilityWindows: [hours(1, 10, 14, "onsite"), hours(1, 12, 16, "online")] })]);
    expect(r.tutors[0].given).toBe(6); // 10:00–16:00, not 4 + 4.
  });

  it("takes leave out of the given hours", () => {
    const leave = { startTime: instant(MON, 600), endTime: instant(MON, 720) };
    // Leave has no weekday or minute of its own. Any class in the snapshot, here a cancelled one, fixes its clock.
    const anchor = lesson(TUE, 9, 10, undefined, { isBlocking: false });
    const r = report([group("A", { leaves: [leave], sessionBlocks: [anchor] })]);
    expect(r.tutors[0]).toMatchObject({ given: 3.5, leave: 0.5, remaining: 3.5 });
  });

  it("CAP-01: a Physics class also uses the Maths hour of the same tutor", () => {
    const both = group("Both", {
      qualifications: [tag("Math"), tag("Physics")],
      sessionBlocks: [lesson(MON, 10, 12, "In-Person Session-Physics")],
    });
    const r = report([both, group("MathOnly")]);
    const row = (subject: string) => r.subjects.find((s) => s.subject === subject)!;
    expect(row("Math")).toMatchObject({ tutors: 2, given: 8, booked: 0.5, bookedHere: 0, remaining: 7.5 });
    expect(row("Physics")).toMatchObject({ tutors: 1, given: 4, booked: 0.5, bookedHere: 0.5, remaining: 3.5 });
    expect(row("Math").tutorKeys).toEqual(["Both", "MathOnly"]);
    // The pools overlap: 8 + 4 is more than the 8 h the two tutors give.
    expect(r.totals).toMatchObject({ tutors: 2, given: 8, booked: 0.5, remaining: 7.5 });
    expect(r.unidentified).toBe(0);
  });

  it("reports a class title that names none of the tutor's subjects", () => {
    const r = report([
      group("Both", { qualifications: [tag("Math"), tag("Physics")], sessionBlocks: [lesson(MON, 10, 12, "Live Session")] }),
    ]);
    expect(r.unidentified).toBe(0.5);
    expect(r.subjects.map((s) => s.bookedHere)).toEqual([0, 0]);
    expect(r.totals.booked).toBe(0.5); // Still booked time.
  });

  it("keeps a class outside the given hours out of the rate", () => {
    const r = report([group("A", { sessionBlocks: [lesson(TUE, 18, 19)] })]);
    expect(r.tutors[0]).toMatchObject({ given: 4, booked: 0, remaining: 4, outside: 0.25, utilization: 0 });
  });

  it("ignores a cancelled class, a class today and a class after the period", () => {
    const r = report([
      group("A", {
        sessionBlocks: [
          lesson(MON, 10, 11, undefined, { isBlocking: false }),
          lesson("2026-11-17", 20, 21),
          lesson("2026-12-21", 10, 11),
        ],
      }),
    ]);
    expect(r.tutors[0]).toMatchObject({ booked: 0, outside: 0, remaining: 4 });
  });

  it("CAP-04: lists a tutor with an identity issue for review and leaves them out of the totals", () => {
    const r = report([
      group("Good"),
      group("Unsure", { dataIssues: [{ type: "alias", message: "x" }, { type: "tag", message: "y" }] }),
      group("Tagged", { dataIssues: [{ type: "tag", message: "y" }] }),
    ]);
    expect(r.needsReview.map((t) => [t.key, t.issues])).toEqual([["Unsure", ["alias"]]]);
    expect(r.tutors.map((t) => t.key)).toEqual(["Good", "Tagged"]);
    expect(r.totals).toMatchObject({ tutors: 2, given: 8 });
    expect(r.subjects[0].tutors).toBe(2);
  });

  it("leaves out an account with hours but no subject and no class", () => {
    const r = report([group("Staff", { qualifications: [] }), group("NoHours", { availabilityWindows: [] })]);
    expect(r.tutors).toEqual([]);
    expect(r.totals).toMatchObject({ tutors: 0, given: 0, utilization: null });
  });

  it("shows a tutor with classes but no Wise hours, with no rate", () => {
    const r = report([group("A", { availabilityWindows: [], sessionBlocks: [lesson(MON, 10, 12)] })]);
    expect(r.tutors[0]).toMatchObject({ given: 0, booked: 0, outside: 0.5, utilization: null });
  });

  it("reads a snapshot written by the UTC production sync", () => {
    // That writer stores Bangkok wall-clock time as if it were UTC: seven hours late.
    const late = (d: Date) => new Date(d.getTime() + 7 * HOUR);
    const cls = lesson(MON, 10, 12);
    const r = report([
      group("A", {
        sessionBlocks: [{ ...cls, startTime: late(cls.startTime), endTime: late(cls.endTime) }],
        leaves: [{ startTime: late(instant(MON, 780)), endTime: late(instant(MON, 840)) }],
      }),
    ]);
    expect(r.tutors[0]).toMatchObject({ given: 3.75, leave: 0.25, booked: 0.5, outside: 0 });
  });

  it("adds a level row for each curriculum and level, with the tutor's full hours", () => {
    const r = report([
      group("A", { qualifications: [tag("Math", "Y9-11"), tag("Math", "Y12-13"), tag("Math", "Y9-11")] }),
      group("B", { qualifications: [tag("Math", "Y9-11")] }),
    ]);
    expect(r.subjects[0].levels.map((l) => [l.level, l.tutors, l.given])).toEqual([
      ["Y9-11", 2, 8],
      ["Y12-13", 1, 4],
    ]);
  });

  it("puts the tightest subject first and shows its Hiring switch and priority", () => {
    const r = report(
      [
        group("M", { sessionBlocks: [lesson(MON, 10, 11)] }),
        group("P", { qualifications: [tag("Physics")], sessionBlocks: [lesson(MON, 10, 13, "Physics")] }),
        group("S", { qualifications: [tag("Science")] }),
      ],
      [
        { subject: "Physics", hiring: true },
        { subject: "Mathematics", hiring: false },
      ],
    );
    expect(r.subjects.map((s) => [s.subject, s.hiringSubject, s.hiring, s.rank])).toEqual([
      ["Physics", "Physics", true, 1],
      ["Math", "Mathematics", false, 2],
      ["Science", null, null, null],
    ]);
  });

  it("flags leave that is not known to the end of the period, and old Wise data", () => {
    const r = buildCapacityReport({
      groups: [group("A", { leavesCompleteThrough: new Date("2026-12-01") }), group("B")],
      syncedAt: new Date(NOW.getTime() - 2 * HOUR),
      priority: [],
      now: NOW,
    });
    expect(r.tutors.map((t) => t.leaveUnknown)).toEqual([true, false]);
    expect(r.stale).toBe(true);
    expect(report([]).stale).toBe(false);
  });
});

describe("classSubject", () => {
  it("gives the only subject without reading the title", () => {
    expect(classSubject("Live Session", ["Math"])).toBe("Math");
    expect(classSubject(undefined, [])).toBeNull();
  });

  it("matches the title to one of the tutor's own subjects", () => {
    const subjects = ["ComSci", "EFL", "Literature", "Math", "MathVR", "Science"];
    expect(classSubject("In-Person Session- Com sci", subjects)).toBe("ComSci");
    expect(classSubject("Live Session-Mathematics (Cancelled)", subjects)).toBe("Math");
    expect(classSubject("In-Person Session-MathVR", subjects)).toBe("MathVR");
    expect(classSubject("In-Person Session-Computer Science", subjects)).toBe("ComSci");
    expect(classSubject("In-Person Session-English Literature", subjects)).toBe("Literature");
    expect(classSubject("In-Person Session-English", subjects)).toBe("EFL");
    expect(classSubject("In-Person Session-Sci", subjects)).toBe("Science");
    expect(classSubject("In-Person Session - SAT Math", subjects)).toBe("Math");
    expect(classSubject("In-Person Session - NVR", [...subjects, "NonVR"])).toBe("NonVR");
    expect(classSubject("In-Person Session - Eng VR", [...subjects, "EnglishVR"])).toBe("EnglishVR");
    expect(classSubject("In-Person Session-Chemistry", subjects)).toBeNull();
    expect(classSubject("In-Person Session", subjects)).toBeNull();
  });
});
