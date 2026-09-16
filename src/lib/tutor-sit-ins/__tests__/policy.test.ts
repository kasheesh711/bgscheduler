import { describe, expect, it } from "vitest";
import {
  currentQuarter,
  defaultQuarter,
  FIRST_QUARTER,
  NOTICE_MS,
  quarterBounds,
  quarterSchema,
  requireNotice,
  titleDepartments,
} from "../model";
import { EMPTY_REPORT, reportScore, RUBRIC } from "../rubric";
import {
  assertLiveHeadFree,
  lessonModality,
  sameLesson,
  teachingEvidence,
} from "../sources";
import type { Lesson } from "../model";
import type { WiseSession } from "@/lib/wise/types";
const lesson: Lesson = {
  id: "lesson",
  classId: "class",
  tutorKey: "target",
  tutorName: "Tutor",
  title: "ISEB English",
  start: "2026-10-01T03:00:00Z",
  end: "2026-10-01T04:30:00Z",
  status: "UPCOMING",
  location: "Room A",
  modality: "onsite",
  departments: ["english", "iseb"],
  participants: [
    {
      studentKey: "s",
      studentName: "Learner",
      parentName: "Parent",
      familyKey: "family",
    },
  ],
};
const working = [{ weekday: 4, startMinute: 540, endMinute: 1020 }];
const session = (
  userId: string,
  status = "UPCOMING",
  start = lesson.start,
  end = lesson.end,
): WiseSession => ({
  _id: "busy",
  userId,
  scheduledStartTime: start,
  scheduledEndTime: end,
  meetingStatus: status,
});
describe("quarterly observation policy", () => {
  it("starts Q4 at Bangkok midnight and retains the original reporting quarter", () => {
    expect(quarterBounds(FIRST_QUARTER)).toEqual({
      start: new Date("2026-09-30T17:00:00Z"),
      end: new Date("2026-12-31T17:00:00Z"),
    });
    expect(currentQuarter(new Date("2026-12-31T16:59:59Z"))).toBe("2026-Q4");
    expect(currentQuarter(new Date("2026-12-31T17:00:00Z"))).toBe("2027-Q1");
    expect(defaultQuarter(new Date("2026-09-01"))).toBe(FIRST_QUARTER);
    expect(quarterSchema.safeParse("2026-Q3").success).toBe(false);
  });
  it("allows exactly 24 hours and refuses shorter notice", () => {
    const now = new Date("2026-10-01T03:00:00Z");
    expect(() => requireNotice(new Date(+now + NOTICE_MS), now)).not.toThrow();
    expect(() => requireNotice(new Date(+now + NOTICE_MS - 1), now)).toThrow(
      "24 hours",
    );
  });
  it("uses title evidence, keeps ISEB separate, and refuses level-only or generic science guesses", () => {
    expect(titleDepartments("Y6 ISEB Maths and English")).toEqual([
      "maths",
      "english",
      "iseb",
    ]);
    expect(titleDepartments("Year 7–9")).toEqual([]);
    expect(titleDepartments("IGCSE Science")).toEqual([]);
    expect(
      teachingEvidence(
        { ...lesson, status: "CANCELLED" },
        new Date("2026-09-01"),
      ),
    ).toBe(false);
    expect(
      teachingEvidence({ ...lesson, status: "ENDED" }, new Date("2026-11-01")),
    ).toBe(true);
  });
});
describe("native rubric", () => {
  const all = (rating: 10 | 7 | 4 | 1) => ({
    ...EMPTY_REPORT,
    scores: Object.fromEntries(
      RUBRIC.sections.flatMap((s) => s.criteria.map((c) => [c.id, rating])),
    ),
    strengths: "Clear explanation",
    priorities: "Use more checks",
    nextSteps: "Ask a hinge question",
    occurred: true,
  });
  it("has the exact 30/30/20/20 section maxima and ten criteria", () => {
    expect(RUBRIC.sections.map((s) => s.criteria.length * 10)).toEqual([
      30, 30, 20, 20,
    ]);
    for (const rating of [10, 7, 4, 1] as const)
      expect(reportScore(RUBRIC, all(rating), true)).toBe(rating * 10);
  });
  it("preserves incomplete drafts but rejects incomplete or invalid submissions", () => {
    expect(reportScore(RUBRIC, EMPTY_REPORT)).toBeNull();
    expect(() => reportScore(RUBRIC, EMPTY_REPORT, true)).toThrow(
      "Complete all ten",
    );
    expect(() =>
      reportScore(RUBRIC, { ...all(10), occurred: false }, true),
    ).toThrow();
    expect(() =>
      reportScore(RUBRIC, { ...all(10), strengths: " " }, true),
    ).toThrow();
    expect(() =>
      reportScore(RUBRIC, { ...all(10), scores: { inaccurate: 10 } }, false),
    ).toThrow("do not match");
    expect(() =>
      reportScore(RUBRIC, { ...all(10), notes: { wrong: "Evidence" } }, false),
    ).toThrow();
  });
});
describe("full-lesson observer availability", () => {
  it("uses the verified Wise mode contract: SCHEDULED is online, OFFLINE is onsite", () => {
    expect(lessonModality("SCHEDULED")).toBe("online");
    expect(lessonModality("OFFLINE")).toBe("onsite");
    expect(lessonModality("FUTURE")).toBeNull();
  });
  it("blocks both linked Wise accounts and even partial conflicts", () => {
    for (const id of ["onsite-head", "online-head"])
      expect(() =>
        assertLiveHeadFree(
          lesson,
          [
            session(
              id,
              "UPCOMING",
              "2026-10-01T04:00:00Z",
              "2026-10-01T05:00:00Z",
            ),
          ],
          new Set(["onsite-head", "online-head"]),
          working,
          [],
        ),
      ).toThrow("own class");
  });
  it("a dated cancellation releases that occurrence, while another class still blocks", () => {
    expect(() =>
      assertLiveHeadFree(
        lesson,
        [session("onsite-head", "CANCELLED")],
        new Set(["onsite-head"]),
        working,
        [],
      ),
    ).not.toThrow();
    expect(() =>
      assertLiveHeadFree(
        lesson,
        [session("onsite-head", "CANCELLED"), session("online-head")],
        new Set(["onsite-head", "online-head"]),
        working,
        [],
      ),
    ).toThrow();
    expect(() =>
      assertLiveHeadFree(
        lesson,
        [
          session(
            "onsite-head",
            "UPCOMING",
            lesson.end,
            "2026-10-01T05:00:00Z",
          ),
        ],
        new Set(["onsite-head"]),
        working,
        [],
      ),
    ).not.toThrow();
  });
  it("requires full working-window coverage, respects leave, and fails on unknown overlapping teachers", () => {
    expect(() =>
      assertLiveHeadFree(
        lesson,
        [],
        new Set(),
        [{ ...working[0], endMinute: 660 }],
        [],
      ),
    ).toThrow("working hours");
    expect(() =>
      assertLiveHeadFree(lesson, [], new Set(), working, [
        { startTime: lesson.start, endTime: lesson.end },
      ]),
    ).toThrow("leave");
    expect(() =>
      assertLiveHeadFree(lesson, [session("")], new Set(), working, []),
    ).toThrow("unresolved teacher");
  });
  it("changes in participants invalidate the previous arrangement", () => {
    expect(
      sameLesson(lesson, {
        ...lesson,
        participants: [...lesson.participants].reverse(),
      }),
    ).toBe(true);
    expect(sameLesson(lesson, { ...lesson, participants: [] })).toBe(false);
    expect(sameLesson(lesson, { ...lesson, tutorKey: "replacement" })).toBe(
      false,
    );
  });
});
