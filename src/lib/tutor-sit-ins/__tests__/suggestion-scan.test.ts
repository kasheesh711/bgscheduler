import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import type { Database } from "@/lib/db";
import type { IndexedTutorGroup } from "@/lib/search/index";
import type { Assignment } from "../repository";
import { resolveObserver } from "../access";
import { type Lesson, SitInError } from "../model";
import { createSuggestionScan, snapshotAvailable, suggestionsFor, type Sources } from "../sources";

vi.mock("../access", () => ({ resolveObserver: vi.fn() }));
vi.mock("date-fns-tz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("date-fns-tz")>();
  return { ...actual, fromZonedTime: vi.fn(actual.fromZonedTime) };
});

const now = new Date("2026-09-30T00:00:00Z");
const assignment = {
  observerEmail: "head@example.test", canonicalKey: "target",
  department: "science", coverageScope: "science",
} as Assignment;
const lesson: Lesson = {
  id: "lesson", classId: "class", tutorKey: "target", tutorName: "Tutor",
  title: "Science", scopes: ["science"], departments: ["science"],
  start: "2026-10-05T03:00:00Z", end: "2026-10-05T04:00:00Z",
  status: "UPCOMING", location: "Room", modality: "onsite",
  participants: [{ studentKey: "student", studentName: "Student", parentName: "Parent", familyKey: "family" }],
};
let sources: Sources, head: IndexedTutorGroup, db: Database;
let bookings: Array<{ startTime: Date; endTime: Date }>;
let bookingReads: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  bookings = [];
  head = {
    id: "head", canonicalKey: "head", wiseRecords: [{ wiseTeacherId: "onsite" }],
    availabilityWindows: [{ weekday: 1, startMinute: 540, endMinute: 1080 }],
    leavesCompleteThrough: new Date("2027-01-01"), leaves: [], sessionBlocks: [],
  } as unknown as IndexedTutorGroup;
  sources = {
    lessons: [{ ...lesson }], index: { snapshotId: "snapshot", tutorGroups: [head] },
    accounts: [{ canonicalKey: "head", wiseTeacherId: "onsite", wiseUserId: "user", status: "active", lastSnapshotId: "snapshot" }],
  } as Sources;
  bookingReads = vi.fn(() => Promise.resolve(bookings));
  db = { select: () => ({ from: () => ({ where: bookingReads }) }) } as unknown as Database;
  vi.mocked(resolveObserver).mockResolvedValue({
    email: assignment.observerEmail!, role: "observer", canonicalKey: "head",
    departments: ["science"], scopes: ["science"], name: "Head",
  });
});

describe("one loaded-source suggestion scan", () => {
  it.each(["clear", "leave", "busy", "cancelled", "adjacent", "cross-midnight", "identity", "incomplete", "modality"])(
    "matches uncached availability and review reasons for %s evidence", (scenario) => {
      const candidate = sources.lessons[0];
      if (scenario === "leave") head.leaves = [{ startTime: new Date("2026-10-05T09:30:00Z"), endTime: new Date("2026-10-05T10:30:00Z") }];
      if (["busy", "cancelled", "adjacent"].includes(scenario)) head.sessionBlocks = [{
        startTime: new Date(scenario === "adjacent" ? "2026-10-05T11:00:00Z" : "2026-10-05T10:30:00Z"),
        endTime: new Date("2026-10-05T12:00:00Z"), isBlocking: scenario !== "cancelled",
      }] as IndexedTutorGroup["sessionBlocks"];
      if (scenario === "cross-midnight") candidate.end = "2026-10-05T18:00:00Z";
      if (scenario === "identity") sources.accounts[0].status = "absent";
      if (scenario === "incomplete") head.leavesCompleteThrough = now;
      if (scenario === "modality") candidate.modality = null;
      const expectedReasons = new Set<string>();
      const expected = snapshotAvailable(sources, "head", candidate, expectedReasons);
      const scan = createSuggestionScan(sources);
      for (let attempt = 0; attempt < 2; attempt++) {
        const reasons = new Set<string>();
        expect(scan.available("head", candidate, reasons)).toBe(expected);
        expect(reasons).toEqual(expectedReasons);
      }
    },
  );

  it("converts each visited snapshot timestamp once instead of once per lesson scan", () => {
    head.sessionBlocks = Array.from({ length: 100 }, (_, i) => ({
      startTime: new Date(Date.UTC(2026, 8, 1, 9, i)),
      endTime: new Date(Date.UTC(2026, 8, 1, 10, i)), isBlocking: true,
    })) as IndexedTutorGroup["sessionBlocks"];
    const candidates = Array.from({ length: 60 }, (_, i) => ({ ...lesson, id: String(i) }));
    const expected = candidates.map((candidate) => snapshotAvailable(sources, "head", candidate));
    const uncachedConversions = vi.mocked(fromZonedTime).mock.calls.length;
    expect(uncachedConversions).toBe(12_000);
    vi.mocked(fromZonedTime).mockClear();
    const scan = createSuggestionScan(sources);
    expect(candidates.map((candidate) => scan.available("head", candidate, new Set()))).toEqual(expected);
    expect(vi.mocked(fromZonedTime)).toHaveBeenCalledTimes(200);
    candidates.forEach((candidate) => scan.available("head", candidate, new Set()));
    expect(vi.mocked(fromZonedTime)).toHaveBeenCalledTimes(200);
  });

  it("reuses snapshot checks while rereading grants, competing bookings and notice", async () => {
    const scan = createSuggestionScan(sources);
    const suggest = (time = now) => suggestionsFor(assignment, sources, db, time, scan);
    expect(await suggest()).toHaveLength(1);
    bookings.push({ startTime: new Date(lesson.start), endTime: new Date(lesson.end) });
    expect(await suggest()).toEqual([]);
    bookings = [];
    expect(await suggest(new Date("2026-10-04T03:00:01Z"))).toEqual([]);
    vi.mocked(resolveObserver).mockRejectedValueOnce(new SitInError(403, "Access revoked"));
    await expect(suggest()).rejects.toMatchObject({ status: 403 });
    expect(resolveObserver).toHaveBeenCalledTimes(4);
    expect(bookingReads).toHaveBeenCalledTimes(2);
  });

  it("checks a rebound observer rather than reusing the old head's result", async () => {
    const scan = createSuggestionScan(sources);
    expect(await suggestionsFor(assignment, sources, db, now, scan)).toHaveLength(1);
    const current = await vi.mocked(resolveObserver).mock.results[0].value;
    vi.mocked(resolveObserver).mockResolvedValue({ ...current, canonicalKey: "new-head" });
    await expect(suggestionsFor(assignment, sources, db, now, scan)).rejects.toMatchObject({ code: "IDENTITY_REVIEW" });
  });

  it("does not reuse a scan for a newly loaded source or a subsequent refresh", async () => {
    const old = createSuggestionScan(sources);
    expect(await suggestionsFor(assignment, sources, db, now, old)).toHaveLength(1);
    const changed = {
      ...sources, index: { ...sources.index, snapshotId: "next", tutorGroups: [{ ...head, leavesCompleteThrough: now }] },
      accounts: sources.accounts.map((account) => ({ ...account, lastSnapshotId: "next" })),
    } as Sources;
    await expect(suggestionsFor(assignment, changed, db, now, old)).rejects.toMatchObject({ code: "WISE_VERIFICATION_PENDING" });
    head.leavesCompleteThrough = now;
    await expect(suggestionsFor(assignment, sources, db, now)).rejects.toMatchObject({ code: "WISE_VERIFICATION_PENDING" });
  });

  it("retains original lazy failure behavior and never caches a thrown error", () => {
    head.sessionBlocks = [{ startTime: new Date(NaN), endTime: new Date(NaN), isBlocking: true }] as IndexedTutorGroup["sessionBlocks"];
    const scan = createSuggestionScan(sources);
    expect(() => snapshotAvailable(sources, "head", lesson)).toThrow(RangeError);
    expect(() => scan.available("head", lesson, new Set())).toThrow(RangeError);
    expect(() => scan.available("head", lesson, new Set())).toThrow(RangeError);
  });
});
