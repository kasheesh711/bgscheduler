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

describe("hiring need (CAP-05)", () => {
  const SUNDAYS = ["2026-11-22", "2026-11-29", "2026-12-06", "2026-12-13"];
  // A Physics tutor who gives Sunday 09:00–13:00 and teaches `booked` hours of it each Sunday.
  const sundayTutor = (key: string, booked: number, extra: Partial<IndexedTutorGroup> = {}) =>
    group(key, {
      qualifications: [tag("Physics")],
      availabilityWindows: [hours(0, 9, 13)],
      sessionBlocks: booked ? SUNDAYS.map((date) => lesson(date, 9, 9 + booked, "In-Person Session-Physics")) : [],
      ...extra,
    });
  const need = (groups: IndexedTutorGroup[], subject = "Physics") => report(groups).needs.find((n) => n.subject === subject)!;

  it("asks for a tutor when the busy hours are over 75% full", () => {
    const n = need([sundayTutor("P", 4)]);
    // 4 h booked of 4 h. 75% is 3 h, so 1 h is over. One tutor adds 3 h at 75%: one hire.
    expect(n).toMatchObject({ hire: 1, status: "hire", tightest: "sunday", tutors: 1, tutorKeys: ["P"], idle: [] });
    expect(n.blocks.find((b) => b.key === "sunday")).toEqual({ key: "sunday", given: 4, booked: 4, used: 1, givers: 1, hire: 1 });
    expect(n.blocks.find((b) => b.key === "weekday")).toEqual({ key: "weekday", given: 0, booked: 0, used: null, givers: 0, hire: 0 });
  });

  it("asks for more tutors when a larger pool is full", () => {
    // 20 h booked of 20 h. 75% is 15 h, so 5 h are over. One tutor adds 3 h: two hires.
    expect(need(["A", "B", "C", "D", "E"].map((key) => sundayTutor(key, 4))).hire).toBe(2);
  });

  it("says nearly full at the limit and enough below 60%", () => {
    expect(need([sundayTutor("P", 3)])).toMatchObject({ hire: 0, status: "watch" });
    expect(need([sundayTutor("P", 2)])).toMatchObject({ hire: 0, status: "enough" });
  });

  it("does not count a tutor with no class as capacity, and names that tutor", () => {
    const n = need([sundayTutor("P", 4), sundayTutor("Idle", 0)]);
    expect(n).toMatchObject({ hire: 1, tutors: 1, idle: ["Idle"] });
    expect(n.blocks.find((b) => b.key === "sunday")!.given).toBe(4);
    const r = report([sundayTutor("P", 4), sundayTutor("Idle", 0)]);
    expect(r.tutors.map((t) => [t.key, t.idle])).toEqual([["P", false], ["Idle", true]]);
    expect(r.totals.given).toBe(8); // The all-hours view still shows the idle tutor.
  });

  it("reads only the busy hours", () => {
    // Monday 10:00–14:00 is not a busy block, so a full Monday morning does not ask for a hire.
    const morning = group("M", { sessionBlocks: [MON, "2026-11-30", "2026-12-07", "2026-12-14"].map((d) => lesson(d, 10, 14)) });
    const r = report([morning]);
    expect(r.tutors[0]).toMatchObject({ utilization: 1, busy: { weekday: { given: 0, booked: 0 } } });
    expect(r.needs[0]).toMatchObject({ subject: "Mathematics", hire: 0, status: "enough", tightest: null });
    const evening = group("E", { availabilityWindows: [hours(1, 14, 22)] });
    expect(report([evening]).tutors[0].busy.weekday).toEqual({ given: 4, booked: 0 }); // 16:00–20:00 only.
  });

  it("makes one row for the Hiring subject of two Wise tags, with its switch and priority", () => {
    const r = buildCapacityReport({
      groups: [
        sundayTutor("A", 4, { qualifications: [tag("EFL"), tag("Science")] }),
        sundayTutor("B", 1, { qualifications: [tag("ESL")] }),
      ],
      syncedAt: NOW,
      priority: [
        { subject: "Physics", hiring: true },
        { subject: "EFL/ESL", hiring: false },
      ],
      now: NOW,
    });
    expect(r.needs).toHaveLength(1); // Science has no Hiring subject.
    expect(r.needs[0]).toMatchObject({ subject: "EFL/ESL", wiseSubjects: ["EFL", "ESL"], tutors: 2, hiring: false, rank: 2 });
  });

  it("takes the hours one tutor gives as the average of tutors who give different hours", () => {
    // Sunday: A gives 09:00–18:00 (9 h) and B gives 09:00–12:00 (3 h); both are full. 12 h booked of 12 h.
    // The limit is 9 h, so 3 h are over. A tutor gives 6 h on average, 4.5 h at 75%: one hire.
    const full = (key: string, to: number) =>
      sundayTutor(key, 0, { availabilityWindows: [hours(0, 9, to)], sessionBlocks: SUNDAYS.map((d) => lesson(d, 9, to, "Physics")) });
    const n = need([full("A", 18), full("B", 12)]);
    expect(n.blocks.find((b) => b.key === "sunday")).toMatchObject({ given: 12, booked: 12, givers: 2, hire: 1 });
  });

  it("names the block that sets the number, not a fuller block that asks for fewer people", () => {
    const WEEKDAYS = Array.from({ length: 28 }, (_, i) => new Date(Date.UTC(2026, 10, 18 + i, 12)))
      .filter((d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5)
      .map((d) => d.toISOString().slice(0, 10));
    // Ten tutors give every weekday 16:00–20:00 and teach 18 of the 20 h: 90% full, 2 hires.
    const evening = (key: string) =>
      group(key, {
        qualifications: [tag("Physics")],
        availabilityWindows: [1, 2, 3, 4, 5].map((d) => hours(d, 16, 20)),
        sessionBlocks: WEEKDAYS.flatMap((d) => (weekday(d) === 5 ? [lesson(d, 16, 18, "Physics")] : [lesson(d, 16, 20, "Physics")])),
      });
    // One tutor gives Saturday 09:00–13:00 and teaches all of it: 100% full, 1 hire.
    const saturday = group("Sat", {
      qualifications: [tag("Physics")],
      availabilityWindows: [hours(6, 9, 13)],
      sessionBlocks: ["2026-11-21", "2026-11-28", "2026-12-05", "2026-12-12"].map((d) => lesson(d, 9, 13, "Physics")),
    });
    const n = need([...Array.from({ length: 10 }, (_, i) => evening(`E${i}`)), saturday]);
    expect(n.blocks.map((b) => [b.key, b.used, b.hire])).toEqual([
      ["weekday", 0.9, 2],
      ["saturday", 1, 1],
      ["sunday", null, 0],
    ]);
    expect(n).toMatchObject({ hire: 2, tightest: "weekday" });
  });

  it("counts a class in a busy hour that is outside the tutor's listed hours", () => {
    // The tutor lists Monday 10:00–14:00 only and teaches every Monday 16:00–20:00.
    const r = report([
      group("A", {
        qualifications: [tag("Physics")],
        sessionBlocks: [MON, "2026-11-30", "2026-12-07", "2026-12-14"].map((d) => lesson(d, 16, 20, "Physics")),
      }),
    ]);
    expect(r.tutors[0]).toMatchObject({ booked: 0, outside: 4, busy: { weekday: { given: 4, booked: 4 } } });
    expect(r.needs[0]).toMatchObject({ subject: "Physics", hire: 1, status: "hire", tightest: "weekday" });
  });

  it("does not say enough when no tutor with a class can be measured", () => {
    const idleOnly = need([sundayTutor("Idle", 0)]);
    expect(idleOnly).toMatchObject({ status: "unknown", hire: 0, tutors: 0, idle: ["Idle"], review: 0, tightest: null });
    // The only tutor failed to load: the subject stays on the list.
    const r = report([sundayTutor("Lost", 4, { leavesCompleteThrough: NOW })]);
    expect(r.needs).toHaveLength(1);
    expect(r.needs[0]).toMatchObject({ subject: "Physics", status: "unknown", tutors: 0, review: 1, hire: 0 });
    expect(r.needs[0].blocks.every((b) => b.given === 0)).toBe(true);
  });

  it("puts the largest need first", () => {
    const r = report([
      sundayTutor("P", 4),
      sundayTutor("C", 3, { qualifications: [tag("Chemistry")] }),
      sundayTutor("B", 1, { qualifications: [tag("Biology")] }),
    ]);
    expect(r.needs.map((n) => [n.subject, n.status])).toEqual([
      ["Physics", "hire"],
      ["Chemistry", "watch"],
      ["Biology", "enough"],
    ]);
  });
});

describe("edges", () => {
  it("sends a tutor to review when Wise did not load their hours in the last sync", () => {
    // A failed fetch sets the leave watermark to the sync time, which is before the period.
    const r = report([group("A", { leavesCompleteThrough: NOW }), group("B", { leavesCompleteThrough: null })]);
    expect(r.needsReview.map((t) => [t.key, t.issues])).toEqual([["A", ["completeness"]], ["B", ["completeness"]]]);
    expect(r.totals.tutors).toBe(0);
    expect(r.needs.map((n) => [n.subject, n.status, n.review, n.tutors])).toEqual([["Mathematics", "unknown", 2, 0]]);
  });

  it("clips a class at the end of the period and keeps given = booked + free", () => {
    // Tuesday 15 December is the last day. The class runs 23:00–01:00, so one hour is in the period.
    const late = { ...lesson("2026-12-15", 23, 24), endTime: instant("2026-12-16", 60), endMinute: 60 };
    const r = report([group("A", { sessionBlocks: [late, lesson(MON, 10, 12)] })]);
    const t = r.tutors[0];
    expect(t.outside).toBe(0.25);
    expect(t.booked + t.remaining).toBe(t.given);
  });

  it("still counts a class whose weekday does not match its time", () => {
    // The clock cannot be proven from the row, so it takes the shift of the snapshot.
    const odd = lesson(MON, 10, 12, undefined, { weekday: 3 });
    const r = report([group("A", { sessionBlocks: [lesson(TUE, 9, 10, undefined, { isBlocking: false }), odd] })]);
    expect(r.tutors[0].booked).toBe(0.5);
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
    expect(classSubject("In-Person Session - IGCSE Geometry", ["Geo", "Math"])).toBe("Math");
    expect(classSubject("In-Person Session - Maths Verbal Reasoning", ["Math", "MathVR"])).toBe("MathVR");
    expect(classSubject("In-Person Session - Engineering", ["EFL", "Physics"])).toBeNull();
    expect(classSubject("In-Person Session - Maths VR", subjects)).toBe("MathVR");
    expect(classSubject("In-Person Session - English Lit", subjects)).toBe("Literature");
    expect(classSubject("In-Person Session - Geometry", ["Geo", "Math"])).toBe("Math");
    expect(classSubject("In-Person Session - Bio", ["Biology", "Chemistry"])).toBe("Biology");
    expect(classSubject("In-Person Session - English as a Second Language", ["Econ", "Math"])).toBeNull();
    expect(classSubject("In-Person Session - ภาษาไทย", ["Math", "Thai"])).toBe("Thai");
    expect(classSubject("In-Person Session-Chemistry", subjects)).toBeNull();
    expect(classSubject("In-Person Session", subjects)).toBeNull();
  });
});
