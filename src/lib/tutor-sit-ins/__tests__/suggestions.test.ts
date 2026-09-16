import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import type { IndexedTutorGroup } from "@/lib/search/index";
import type { Assignment } from "../repository";
import { calendarBusy } from "../calendar";
import { resolveObserver } from "../access";
import { suggestionsFor, snapshotAvailable, type Sources } from "../sources";
import { SitInError, type Lesson } from "../model";
vi.mock("../calendar", () => ({ calendarBusy: vi.fn() }));
vi.mock("../access", () => ({ resolveObserver: vi.fn() }));
const now = new Date("2026-09-30T00:00:00Z");
const lesson: Lesson = {
  id: "lesson",
  classId: "class",
  tutorKey: "target",
  tutorName: "Tutor",
  title: "Science",
  scopes: ["science"],
  departments: ["science"],
  start: "2026-10-05T03:00:00Z",
  end: "2026-10-05T04:00:00Z",
  status: "UPCOMING",
  location: "Room",
  modality: "onsite",
  participants: [
    {
      studentKey: "student",
      studentName: "Student",
      parentName: "Parent",
      familyKey: "family",
    },
  ],
};
const assignment = {
  observerEmail: "observer@example.test",
  canonicalKey: "target",
  department: "science",
  coverageScope: "science",
} as Assignment;
let sources: Sources, db: Database, head: IndexedTutorGroup;
let bookings: Array<{ startTime: Date; endTime: Date }>;
beforeEach(() => {
  vi.resetAllMocks();
  bookings = [];
  head = {
    id: "head",
    canonicalKey: "head",
    displayName: "Head",
    supportedModes: ["unresolved"],
    qualifications: [],
    wiseRecords: [
      { wiseTeacherId: "onsite", wiseDisplayName: "Head", isOnline: false },
      {
        wiseTeacherId: "online",
        wiseDisplayName: "Head Online",
        isOnline: true,
      },
    ],
    availabilityWindows: [
      {
        weekday: 1,
        startMinute: 540,
        endMinute: 1080,
        modality: "unresolved",
        wiseTeacherId: "onsite",
      },
    ],
    leaves: [],
    leavesCompleteThrough: new Date("2027-01-01"),
    sessionBlocks: [],
    dataIssues: [
      { type: "modality", message: "Online session on onsite account" },
      { type: "qualification", message: "Qualification unmapped" },
    ],
  };
  sources = {
    lessons: [lesson],
    index: { snapshotId: "snapshot", tutorGroups: [head] },
    accounts: ["onsite", "online"].map((id) => ({
      canonicalKey: "head",
      wiseTeacherId: id,
      wiseUserId: id,
      status: "active",
      lastSnapshotId: "snapshot",
    })),
  } as Sources;
  db = {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(bookings) }),
    }),
  } as unknown as Database;
  vi.mocked(resolveObserver).mockResolvedValue({
    email: assignment.observerEmail!,
    role: "observer",
    canonicalKey: "head",
    departments: ["science"],
    scopes: ["science"],
    name: "Head",
  });
  vi.mocked(calendarBusy).mockRejectedValue(
    new SitInError(409, "Connect Calendar first.", "CALENDAR_RECONNECT"),
  );
});
const suggest = () => suggestionsFor(assignment, sources, db, now);
describe("observation-specific availability", () => {
  it.each(["absent", "identity_conflict", "unknown"])(
    "blocks a current but %s linked account",
    async (status) => {
      sources.accounts[1].status = status;
      expect(snapshotAvailable(sources, "head", lesson)).toBe(false);
      await expect(suggest()).rejects.toThrow("identity verification");
    },
  );
  it("uses time evidence across verified accounts, independent of labels and qualifications", async () => {
    expect(snapshotAvailable(sources, "head", lesson)).toBe(true);
    expect(await suggest()).toMatchObject([
      { verification: "wise_only", issues: [{ category: "calendar" }] },
    ]);
  });
  it("blocks the whole lesson for classes on either account, and releases only the cancelled occurrence", async () => {
    head.sessionBlocks = [
      {
        startTime: new Date("2026-10-05T10:30:00Z"),
        endTime: new Date("2026-10-05T11:30:00Z"),
        weekday: 1,
        startMinute: 630,
        endMinute: 690,
        wiseTeacherId: "online",
        isBlocking: true,
      },
    ];
    expect(await suggest()).toEqual([]);
    head.sessionBlocks[0].isBlocking = false;
    expect(await suggest()).toHaveLength(1);
    head.sessionBlocks.push({
      ...head.sessionBlocks[0],
      wiseTeacherId: "onsite",
      isBlocking: true,
    });
    expect(await suggest()).toEqual([]);
    head.sessionBlocks[1].startTime = new Date("2026-10-12T10:30:00Z");
    head.sessionBlocks[1].endTime = new Date("2026-10-12T11:30:00Z");
    expect(await suggest()).toHaveLength(1);
  });
  it("checks full working windows, Bangkok leave intervals and incomplete account evidence", () => {
    head.availabilityWindows[0].endMinute = 630;
    expect(snapshotAvailable(sources, "head", lesson)).toBe(false);
    head.availabilityWindows[0].endMinute = 1080;
    head.leaves = [
      {
        startTime: new Date("2026-10-05T09:00:00Z"),
        endTime: new Date("2026-10-05T10:30:00Z"),
      },
    ];
    expect(snapshotAvailable(sources, "head", lesson)).toBe(false);
    head.leaves = [];
    sources.accounts.pop();
    expect(snapshotAvailable(sources, "head", lesson)).toBe(false);
  });
  it("keeps unknown Wise coverage blocked with a retryable cause", async () => {
    head.leavesCompleteThrough = now;
    await expect(suggest()).rejects.toMatchObject({
      code: "WISE_VERIFICATION_PENDING",
    });
    expect(calendarBusy).not.toHaveBeenCalled();
  });
  it("rejects competing observations and less than 24 hours notice", async () => {
    bookings.push({
      startTime: new Date(lesson.start),
      endTime: new Date(lesson.end),
    });
    expect(await suggest()).toEqual([]);
    bookings = [];
    expect(
      await suggestionsFor(
        assignment,
        sources,
        db,
        new Date("2026-10-04T03:00:01Z"),
      ),
    ).toEqual([]);
  });
  it("distinguishes connected, busy, disconnected and temporarily unavailable Google calendars", async () => {
    vi.mocked(calendarBusy).mockResolvedValue([]);
    expect(await suggest()).toMatchObject([{ verification: "verified" }]);
    vi.mocked(calendarBusy).mockResolvedValue([
      { start: new Date(lesson.start), end: new Date(lesson.end) },
    ]);
    expect(await suggest()).toEqual([]);
    vi.mocked(calendarBusy).mockRejectedValue(new Error("429"));
    expect(await suggest()).toMatchObject([
      { verification: "wise_only", issues: [{ code: "CALENDAR_UNAVAILABLE" }] },
    ]);
  });
  it("blocks only the affected incomplete lesson, with no borrowing of another roster", async () => {
    sources.lessons.push({ ...lesson, id: "incomplete", participants: [] });
    expect((await suggest()).map((s) => s.sessionId)).toEqual(["lesson"]);
    sources.lessons = [sources.lessons[1]];
    await expect(suggest()).rejects.toMatchObject({ code: "STUDENT_ROSTER" });
  });
  it("caches Calendar availability across a refresh without changing the result", async () => {
    const cache = new Map();
    const a = await suggestionsFor(assignment, sources, db, now, cache);
    expect(await suggestionsFor(assignment, sources, db, now, cache)).toEqual(
      a,
    );
    expect(calendarBusy).toHaveBeenCalledTimes(1);
  });
});
