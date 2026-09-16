import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import type * as s from "@/lib/db/schema";
import {
  fetchTeacherAvailability,
  fetchWiseSessionDetail,
} from "@/lib/wise/fetchers";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import { resolveObserver } from "../access";
import { calendarBusy } from "../calendar";
import { verifyLiveLesson, type Sources } from "../sources";
import { HEADS, type Lesson } from "../model";
import type { WiseSession } from "@/lib/wise/types";

vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn(() => ({})) }));
vi.mock("@/lib/wise/fetchers", () => ({
  fetchTeacherAvailability: vi.fn(),
  fetchWiseSessionDetail: vi.fn(),
}));
vi.mock("@/lib/wise/day-sessions", () => ({
  fetchWiseSessionsForBangkokDates: vi.fn(),
}));
vi.mock("../access", () => ({ resolveObserver: vi.fn() }));
vi.mock("../calendar", () => ({ calendarBusy: vi.fn() }));

const lesson: Lesson = {
  id: "lesson",
  classId: "class",
  tutorKey: "target",
  tutorName: "Tutor",
  title: "Physics",
  start: "2026-10-01T03:00:00.000Z",
  end: "2026-10-01T04:00:00.000Z",
  status: "UPCOMING",
  location: null,
  modality: "online",
  departments: ["physics"],
  participants: [
    {
      studentKey: "student",
      studentName: "Learner",
      familyKey: "family",
      parentName: "Parent",
    },
  ],
};
const assignment = {
  observerEmail: HEADS[0].email,
  canonicalKey: "target",
  department: "physics",
} as typeof s.tutorSitInAssignments.$inferSelect;
const now = new Date("2026-09-29T03:00:00Z");
const live: WiseSession = {
  _id: lesson.id,
  classId: lesson.classId,
  userId: "target-user",
  scheduledStartTime: lesson.start,
  scheduledEndTime: lesson.end,
  meetingStatus: "UPCOMING",
  type: "SCHEDULED",
  title: "Physics",
  students: ["wise-student"],
};
let sources: Sources, db: Database;
beforeEach(() => {
  vi.resetAllMocks();
  sources = {
    index: { snapshotId: "snapshot" },
    snapshotId: "students",
    mappings: [],
    contacts: [],
    lessons: [lesson],
    accounts: [
      {
        canonicalKey: "head",
        wiseUserId: "head-online",
        status: "active",
        wiseTeacherId: "teacher-online",
        lastSnapshotId: "snapshot",
      },
      {
        canonicalKey: "head",
        wiseUserId: "head-onsite",
        status: "active",
        wiseTeacherId: "teacher-onsite",
        lastSnapshotId: "snapshot",
      },
      {
        canonicalKey: "target",
        wiseUserId: "target-user",
        status: "active",
        wiseTeacherId: "target-teacher",
        lastSnapshotId: "snapshot",
      },
    ],
  } as unknown as Sources;
  const where = vi
    .fn()
    .mockResolvedValueOnce([{ id: "students" }])
    .mockResolvedValue([
      { wiseStudentId: "wise-student", studentKey: "student" },
    ]);
  db = { select: () => ({ from: () => ({ where }) }) } as unknown as Database;
  vi.mocked(resolveObserver).mockResolvedValue({
    email: HEADS[0].email,
    role: "observer",
    departments: ["physics"],
    canonicalKey: "head",
    name: "Head",
  });
  vi.mocked(fetchTeacherAvailability).mockResolvedValue({
    workingHours: {
      slots: [{ day: "thursday", startTime: "09:00", endTime: "18:00" }],
    },
    leaves: [],
  });
  vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([live]);
  vi.mocked(fetchWiseSessionDetail).mockResolvedValue({
    ...live,
    students: undefined,
    participants: ["other-non-student-id"],
  });
  vi.mocked(calendarBusy).mockResolvedValue([]);
});
const verify = () => verifyLiveLesson(assignment, lesson, sources, db, { now });
describe("live booking verification", () => {
  it("uses dated institute sessions, every linked Wise account, and the actual student-list contract", async () => {
    expect((await verify()).lesson.modality).toBe("online");
    expect(fetchTeacherAvailability).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(fetchTeacherAvailability)
        .mock.calls.map((c) => c[2])
        .sort(),
    ).toEqual(["head-online", "head-onsite"]);
    expect(fetchWiseSessionsForBangkokDates).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      ["2026-10-01"],
      expect.objectContaining({ now }),
    );
    expect(calendarBusy).toHaveBeenCalledWith(
      HEADS[0].email,
      new Date(lesson.start),
      new Date(lesson.end),
      db,
      undefined,
    );
  });
  it("releases a cancelled head class but retains an overlapping class on the other account", async () => {
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([
      live,
      {
        ...live,
        _id: "head-class",
        userId: "head-online",
        meetingStatus: "CANCELLED",
      },
    ]);
    await expect(verify()).resolves.toBeDefined();
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([
      live,
      { ...live, _id: "head-class", userId: "head-onsite" },
    ]);
    await expect(verify()).rejects.toMatchObject({ code: "HEAD_UNAVAILABLE" });
  });
  it.each([
    { meetingStatus: "CANCELLED" },
    { userId: "head-online" },
    { scheduledStartTime: "2026-10-01T03:15:00Z" },
    { students: ["another-student"] },
    { title: "Chemistry" },
  ])("rejects changed lesson evidence %j", async (change) => {
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([
      { ...live, ...change },
    ]);
    await expect(verify()).rejects.toMatchObject({ code: "LESSON_CHANGED" });
  });
  it("uses an explicit department mapping instead of the level-only subject field", async () => {
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([
      { ...live, title: "Year 9", subject: "Secondary" },
    ]);
    sources.mappings = [
      { classId: "class", departments: ["physics", "iseb"] },
    ] as Sources["mappings"];
    await expect(verify()).resolves.toBeDefined();
  });
  it("fails closed if either account lacks leave evidence or disappeared from the current snapshot", async () => {
    vi.mocked(fetchTeacherAvailability).mockResolvedValueOnce({
      workingHours: { slots: [] },
    });
    await expect(verify()).rejects.toThrow("verified completely");
    sources.accounts[1].lastSnapshotId = "old";
    await expect(verify()).rejects.toThrow("identity review");
  });
  it.each(["absent", "identity_conflict", "unknown"])(
    "blocks live confirmation for a current but %s account",
    async (status) => {
      sources.accounts[1].status = status;
      await expect(verify()).rejects.toThrow("identity review");
      expect(fetchTeacherAvailability).not.toHaveBeenCalled();
    },
  );
  it("rejects personal Google conflicts and unavailable Google evidence", async () => {
    vi.mocked(calendarBusy).mockResolvedValue([
      { start: new Date(lesson.start), end: new Date(lesson.end) },
    ]);
    await expect(verify()).rejects.toMatchObject({ code: "HEAD_UNAVAILABLE" });
    vi.mocked(calendarBusy).mockRejectedValue(new Error("Provider unavailable"));
    await expect(verify()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });
});
