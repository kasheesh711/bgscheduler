import { describe, expect, it, vi } from "vitest";
import { buildIgcseRoster } from "../build";
import {
  CURRENT_STUDENT_FUTURE_DAYS,
  CURRENT_STUDENT_PAST_DAYS,
  mapSessionsToRosterInput,
  resolveStudents,
  type FutureSessionRow,
  type PastSessionRow,
} from "../load";

const NOW = new Date("2026-10-14T00:00:00.000Z");
const IGCSE_BAND = "Y9-11 / G8-10 (Int.)";
const day = (offset: number) => new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000);

let seq = 0;
const future = (overrides: Partial<FutureSessionRow> = {}): FutureSessionRow => ({
  wiseSessionId: `f-${seq++}`, wiseClassId: "c1", recurrenceId: null, title: "In-Person Session-Biology",
  wiseTeacherId: "t1", wiseTeacherUserId: "u1", startTime: day(1), wiseStatus: "UPCOMING",
  subject: IGCSE_BAND, studentIds: ["s1"], ...overrides,
});
const past = (overrides: Partial<PastSessionRow> = {}): PastSessionRow => ({
  wiseSessionId: `p-${seq++}`, wiseClassId: "c1", recurrenceId: null, wiseTeacherUserId: "u1",
  startTime: day(-1), finalStatus: "ENDED", band: IGCSE_BAND, studentIds: ["s1"], ...overrides,
});

describe("mapSessionsToRosterInput", () => {
  it("keeps only non-cancelled sessions inside the current-student window and drops tutor ids", () => {
    const { packages, sessions, studentIds } = mapSessionsToRosterInput([
      future({ studentIds: ["s-in"], startTime: day(CURRENT_STUDENT_FUTURE_DAYS) }),
      future({ studentIds: ["s-late"], startTime: day(CURRENT_STUDENT_FUTURE_DAYS + 1) }),
      future({ studentIds: ["s-cancel"], wiseStatus: "CANCELLED", title: "In-Person Session-Biology (Cancelled)" }),
      future({ studentIds: ["s-cancel-title"], title: "In-Person Session-Biology (Cancelled)" }),
      future({ studentIds: null }),
    ], [
      past({ studentIds: ["s-past"], startTime: day(-CURRENT_STUDENT_PAST_DAYS) }),
      past({ studentIds: ["s-old"], startTime: day(-CURRENT_STUDENT_PAST_DAYS - 1) }),
      past({ studentIds: ["s-pcancel"], finalStatus: "CANCELLED" }),
      past({ studentIds: ["u-online"], startTime: day(-2) }),
    ], new Set(["u-online"]), NOW);

    expect(studentIds).toEqual(["s-in", "s-past"]);
    expect(packages).toEqual([
      { wiseClassId: "c1", wiseStudentId: "s-in", packageName: "c1", subject: IGCSE_BAND, excludedReason: null },
      { wiseClassId: "c1", wiseStudentId: "s-past", packageName: "c1", subject: IGCSE_BAND, excludedReason: null },
    ]);
    // The null-roster row and the tutor-only row still count as sessions of their teacher.
    expect(sessions).toEqual([{
      wiseClassId: "c1", title: "In-Person Session-Biology", wiseTeacherUserId: "u1", wiseTeacherId: "t1",
      lastStart: day(CURRENT_STUDENT_FUTURE_DAYS), sessionCount: 4,
    }]);
  });

  it("titles a past session by recurrence first, then by class and teacher, and skips sessions the snapshot lists", () => {
    const shared = "shared-session";
    const { sessions, packages } = mapSessionsToRosterInput([
      future({ wiseSessionId: shared, startTime: day(0.5) }),
      future({ title: "In-Person Session-Biology", startTime: day(30) }),
      future({ title: "In-Person Session-Physics", recurrenceId: "r-phys", startTime: day(30) }),
      future({ title: "In-Person Session-Chemistry", wiseTeacherUserId: "u2", wiseTeacherId: "t2", startTime: day(30) }),
    ], [
      past({ wiseSessionId: shared, startTime: day(0.5) }),
      past({ startTime: day(-2) }),
      past({ startTime: day(-2.5), recurrenceId: "r-phys" }),
      past({ startTime: day(-3), wiseTeacherUserId: "u2" }),
      past({ startTime: day(-4), wiseTeacherUserId: "u-gone", studentIds: ["s2"] }),
    ], new Set(), NOW);

    expect(sessions).toEqual([
      { wiseClassId: "c1", title: "In-Person Session-Biology", wiseTeacherUserId: "u1", wiseTeacherId: "t1", lastStart: day(0.5), sessionCount: 2 },
      { wiseClassId: "c1", title: "In-Person Session-Physics", wiseTeacherUserId: "u1", wiseTeacherId: "t1", lastStart: day(-2.5), sessionCount: 1 },
      { wiseClassId: "c1", title: "In-Person Session-Chemistry", wiseTeacherUserId: "u2", wiseTeacherId: "t2", lastStart: day(-3), sessionCount: 1 },
    ]);
    // A teacher with no upcoming title in a mixed class still makes the student current.
    expect(packages.map((row) => row.wiseStudentId)).toEqual(["s1", "s2"]);
  });

  it("uses the class's only upcoming title and band when the past session lacks them", () => {
    const { sessions, packages } = mapSessionsToRosterInput([
      future({ wiseClassId: "c2", title: "Live Session-Math", wiseTeacherUserId: "u-new", wiseTeacherId: "t-new", startTime: day(20) }),
    ], [
      past({ wiseClassId: "c2", wiseTeacherUserId: "u-old", startTime: day(-1), band: "" }),
    ], new Set(), NOW);

    expect(sessions).toEqual([
      { wiseClassId: "c2", title: "Live Session-Math", wiseTeacherUserId: "u-old", wiseTeacherId: null, lastStart: day(-1), sessionCount: 1 },
    ]);
    expect(packages[0].subject).toBe(IGCSE_BAND);
  });

  it("feeds the builder so recent sessions count toward co-teaching", () => {
    const mapped = mapSessionsToRosterInput([
      future({ startTime: day(2) }),
      future({ startTime: day(9) }),
      future({ wiseTeacherUserId: "u2", wiseTeacherId: "t2", startTime: day(5) }),
    ], [
      past({ wiseTeacherUserId: "u2", startTime: day(-2) }),
      past({ wiseTeacherUserId: "u2", startTime: day(-5) }),
    ], new Set(), NOW);

    const roster = buildIgcseRoster({
      packages: mapped.packages,
      sessions: mapped.sessions,
      students: [{ wiseStudentId: "s1", studentName: "Student One", email: "s1@example.test" }],
      accounts: [
        { wiseTeacherId: "t1", wiseUserId: "u1", canonicalKey: "tutor-a", isOnlineVariant: false, email: "a@example.test" },
        { wiseTeacherId: "t2", wiseUserId: "u2", canonicalKey: "tutor-b", isOnlineVariant: false, email: "b@example.test" },
      ],
      contacts: [
        { canonicalKey: "tutor-a", displayName: "Tutor A", primaryEmail: "a@example.test", onsiteEmail: null, onlineEmail: null, active: true },
        { canonicalKey: "tutor-b", displayName: "Tutor B", primaryEmail: "b@example.test", onsiteEmail: null, onlineEmail: null, active: true },
      ],
      mappings: [{
        id: "m1", classId: null, sourceValue: "In-Person Session-Biology", subject: "Biology", curriculum: null, level: null,
        revision: 1, reviewedBy: "reviewer@example.test", reviewedAt: "2026-09-01T00:00:00.000Z",
      }],
      qualifications: [],
    }, NOW);

    // Tutor B has 1 upcoming + 2 recent sessions, so both teachers are linked.
    expect(roster.links.map((link) => [link.tutorEmail, link.studentEmail, link.syllabus])).toEqual([
      ["a@example.test", "s1@example.test", "0610"],
      ["b@example.test", "s1@example.test", "0610"],
    ]);
    expect(roster.unmapped).toEqual([]);
  });
});

describe("resolveStudents", () => {
  const stored = [{ wiseStudentId: "s1", studentName: "One", email: "one@example.test" }];

  it("does not read Wise when every student is stored", async () => {
    const fetchStudents = vi.fn();
    expect(await resolveStudents(stored, ["s1"], fetchStudents)).toEqual(stored);
    expect(fetchStudents).not.toHaveBeenCalled();
  });

  it("adds only the unknown students from one Wise read", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchStudents = vi.fn().mockResolvedValue([
      { wiseStudentId: "s1", studentName: "One (Wise)", email: null },
      { wiseStudentId: "s2", studentName: "Two", email: "two@example.test" },
      { wiseStudentId: "s3", studentName: "Not current", email: "three@example.test" },
    ]);
    expect(await resolveStudents(stored, ["s1", "s2"], fetchStudents)).toEqual([
      ...stored, { wiseStudentId: "s2", studentName: "Two", email: "two@example.test" },
    ]);
    expect(fetchStudents).toHaveBeenCalledTimes(1);
  });

  it("fails when the Wise read fails, so no student is dropped", async () => {
    await expect(resolveStudents(stored, ["s1", "s2"], vi.fn().mockRejectedValue(new Error("429"))))
      .rejects.toThrow("429");
  });
});
