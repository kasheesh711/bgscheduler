import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "@/lib/db/schema";
import type { IndexedTutorGroup } from "@/lib/search/index";
import { ensureIndex } from "@/lib/search/index";
import { configSchema, instant, type HiringConfig } from "../model";
import { headWeek, visitClashes } from "../head-schedule";

vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));

const NOW = new Date("2026-10-30T05:00:00Z"); // Friday. The next week starts Mon 2 Nov.
const MON = "2026-11-02";
const TUE = "2026-11-03";
const week = (days: number[], start = "10:00", end = "16:00") =>
  Array.from({ length: 7 }, (_, d) => (days.includes(d) ? { start, end } : null));
const head = (canonicalKey: string, extra = {}) => ({
  canonicalKey,
  subjects: ["Mathematics" as const],
  email: `${canonicalKey.toLowerCase()}@example.com`,
  ...extra,
});
const block = (date: string, from: number, to: number, extra = {}) => ({
  startTime: instant(date, from),
  endTime: instant(date, to),
  weekday: 0,
  startMinute: from,
  endMinute: to,
  isBlocking: true,
  wiseTeacherId: "w",
  ...extra,
});
const group = (
  canonicalKey: string,
  extra: Partial<IndexedTutorGroup> = {},
): IndexedTutorGroup => ({
  id: canonicalKey,
  canonicalKey,
  displayName: `${canonicalKey} Full Name`,
  supportedModes: ["onsite"],
  qualifications: [],
  wiseRecords: [],
  availabilityWindows: [],
  leaves: [],
  leavesCompleteThrough: new Date("2026-12-31"),
  sessionBlocks: [],
  dataIssues: [],
  ...extra,
});
const enrol = (canonicalKey: string) => ({
  canonicalKey,
  loginEmail: `${canonicalKey}@example.com`,
  startDate: "2026-01-01",
  endDate: null,
  active: true,
});
const schedule = (canonicalKey: string, w: unknown) => ({
  id: `${canonicalKey}-v1`,
  canonicalKey,
  effectiveFrom: "2026-01-01",
  week: w,
  revision: 1,
});
const CANDIDATE = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const VISIT = "00000000-0000-4000-8000-0000000000b1";
const VISIT_2 = "00000000-0000-4000-8000-0000000000b2";
const row = (
  kind: "paper" | "mock",
  date: string,
  from: number,
  to: number,
  extra: Record<string, unknown> = {},
) => ({
  candidateId: CANDIDATE,
  kind,
  subjects: ["Mathematics"],
  status: "confirmed",
  visitId: VISIT,
  interviewerKey: kind === "mock" ? "Peat" : null,
  startTime: instant(date, from),
  endTime: instant(date, to),
  ...extra,
});
// A visit on Mon 2 Nov: exam 10:00-12:00, mock 12:00-13:00 with Peat.
const visit = (extra: Record<string, unknown> = {}) => [
  row("paper", MON, 600, 720, extra),
  row("mock", MON, 720, 780, extra),
];

type Fixture = {
  groups?: IndexedTutorGroup[];
  bookings?: unknown[];
  observations?: unknown[];
  syncedAt?: Date;
  indexFails?: boolean;
};
const peat = {
  groups: [group("Peat")],
  schedules: [schedule("Peat", week([1, 2, 3, 4, 5]))],
  enrollments: [enrol("Peat")],
};
function run(
  f: Fixture & { schedules?: unknown[]; enrollments?: unknown[]; exceptions?: unknown[] } = {},
  key = "Peat",
  weekStart = MON,
  config: Partial<HiringConfig> = { interviewers: [head("Peat")] },
  now = NOW,
) {
  if (f.indexFails) vi.mocked(ensureIndex).mockRejectedValue(new Error("no snapshot"));
  else
    vi.mocked(ensureIndex).mockResolvedValue({
      snapshotId: "snap",
      syncedAt: f.syncedAt ?? new Date(now.getTime() - 60_000),
      tutorGroups: f.groups ?? peat.groups,
    } as never);
  const rows = new Map<unknown, unknown[]>([
    [s.hiringBookings, f.bookings ?? []],
    [s.tutorSitInObservations, f.observations ?? []],
    [s.tutorAttendanceSchedules, f.schedules ?? peat.schedules],
    [s.tutorAttendanceExceptions, f.exceptions ?? []],
    [s.tutorAttendanceEnrollments, f.enrollments ?? peat.enrollments],
    [
      s.hiringCandidates,
      [
        { id: CANDIDATE, name: "Nina Porter" },
        { id: OTHER, name: "Lena Ross" },
      ],
    ],
  ]);
  // Only select() exists, so any write would throw. The real query filters bookings to confirmed in SQL.
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const all = rows.get(table) ?? [];
        const kept =
          table === s.hiringBookings
            ? all.filter((r) => (r as { status: string }).status === "confirmed")
            : all;
        return Object.assign(Promise.resolve(all), {
          where: () => Promise.resolve(kept),
        });
      },
    }),
  };
  return headWeek(db as never, configSchema.parse(config), key, weekStart, now);
}

// Braces matter: a returned mock would run as the test's cleanup function.
beforeEach(() => {
  vi.mocked(ensureIndex).mockReset();
});

describe("head week", () => {
  it("returns office hours per day, null when out of office", async () => {
    const w = await run({
      schedules: [schedule("Peat", week([2, 3, 4, 5]))], // Tue-Fri
    });
    expect(w.weekStart).toBe(MON);
    expect(w.days.map((d) => d.date)).toEqual([
      "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
    ]);
    expect(w.days[0].office).toBeNull();
    expect(w.days[1].office).toEqual({ start: "10:00", end: "16:00" });
    expect(w).toMatchObject({ key: "Peat", name: "Peat Full Name", subjects: ["Mathematics"], limit: 2 });
  });

  it("uses the fallback week for a head who is not enrolled", async () => {
    const w = await run(
      { groups: [group("Gift")], schedules: [], enrollments: [] },
      "Gift",
      MON,
      { interviewers: [head("Gift", { fallbackWeek: week([1, 2]) })] },
    );
    expect(w.days.map((d) => d.office !== null)).toEqual([true, true, false, false, false]);
  });

  it("shows Wise classes, leave and sit-ins as times only, with no student names", async () => {
    const w = await run({
      groups: [
        group("Peat", {
          sessionBlocks: [
            block(MON, 900, 960, {
              title: "Secret Student maths",
              studentName: "Secret Student",
              studentCount: 1,
              subject: "Mathematics",
              wiseSessionId: "sess-1",
            }),
            block(TUE, 600, 660, { isBlocking: false, studentName: "Cancelled Kid" }),
          ],
          leaves: [{ startTime: instant(TUE, 780), endTime: instant(TUE, 840) }],
        }),
      ],
      observations: [
        {
          observerCanonicalKey: "Peat",
          startTime: instant(MON, 660),
          endTime: instant(MON, 720),
          lesson: { studentName: "Lesson Student" },
        },
        { observerCanonicalKey: "Ek", startTime: instant(MON, 660), endTime: instant(MON, 720) },
      ],
    });
    expect(w.days[0].blocks).toEqual([
      { kind: "sit_in", start: "11:00", end: "12:00", clash: false },
      { kind: "wise", start: "15:00", end: "16:00", clash: false },
    ]);
    // A cancelled (non-blocking) class is not drawn.
    expect(w.days[1].blocks).toEqual([{ kind: "leave", start: "13:00", end: "14:00", clash: false }]);
    const json = JSON.stringify(w);
    for (const hidden of ["Secret Student", "Cancelled Kid", "Lesson Student", "sess-1", "title", "studentName"])
      expect(json).not.toContain(hidden);
  });

  it("shows the mock as busy and the exam as not needing the head, with the candidate name", async () => {
    const w = await run({ bookings: visit() });
    expect(w.days[0].blocks).toEqual([
      { kind: "exam", start: "10:00", end: "12:00", candidateId: CANDIDATE, candidate: "Nina Porter", subject: "Mathematics", clash: false },
      { kind: "mock", start: "12:00", end: "13:00", candidateId: CANDIDATE, candidate: "Nina Porter", subject: "Mathematics", clash: false },
    ]);
    expect(w.visits).toEqual([
      {
        candidateId: CANDIDATE,
        candidate: "Nina Porter",
        subject: "Mathematics",
        examStart: instant(MON, 600).toISOString(),
        mockStart: instant(MON, 720).toISOString(),
        mockEnd: instant(MON, 780).toISOString(),
        clash: false,
      },
    ]);
    expect(w.mocks).toBe(1);
    expect(w.stale).toBe(false);
  });

  it("marks a mock clash when a Wise session overlaps", async () => {
    const w = await run({
      bookings: visit(),
      groups: [group("Peat", { sessionBlocks: [block(MON, 750, 840)] })],
    });
    const mock = w.days[0].blocks.find((b) => b.kind === "mock")!;
    expect(mock.clash).toBe(true);
    expect(w.visits[0].clash).toBe(true);
    // The visit stays where it is.
    expect(w.visits[0].mockStart).toBe(instant(MON, 720).toISOString());
  });

  it("marks a mock clash for leave and for a sit-in", async () => {
    const leave = await run({
      bookings: visit(),
      groups: [group("Peat", { leaves: [{ startTime: instant(MON, 700), endTime: instant(MON, 730) }] })],
    });
    expect(leave.visits[0].clash).toBe(true);
    const sitIn = await run({
      bookings: visit(),
      observations: [{ observerCanonicalKey: "Peat", startTime: instant(MON, 770), endTime: instant(MON, 830) }],
    });
    expect(sitIn.visits[0].clash).toBe(true);
  });

  it("does not mark an exam-only overlap as a clash", async () => {
    const w = await run({
      bookings: visit(),
      groups: [group("Peat", { sessionBlocks: [block(MON, 600, 720)] })], // a class during the exam only
    });
    expect(w.visits[0].clash).toBe(false);
    expect(w.days[0].blocks.every((b) => !b.clash)).toBe(true);
    expect(w.days[0].blocks.map((b) => b.kind).sort()).toEqual(["exam", "mock", "wise"]);
  });

  it("excludes cancelled and no-show bookings", async () => {
    const w = await run({
      bookings: [...visit({ status: "cancelled" }), ...visit({ status: "no_show", visitId: VISIT_2, candidateId: OTHER })],
    });
    expect(w.days.every((d) => d.blocks.length === 0)).toBe(true);
    expect(w.visits).toEqual([]);
    expect(w.mocks).toBe(0);
  });

  it("shows only this head's mocks, and the exam of a visit whose mock is with this head", async () => {
    const w = await run({
      bookings: [
        ...visit(),
        // A visit whose mock is with Ek: nothing of it shows for Peat.
        row("paper", TUE, 600, 720, { visitId: VISIT_2, candidateId: OTHER }),
        row("mock", TUE, 720, 780, { visitId: VISIT_2, candidateId: OTHER, interviewerKey: "Ek" }),
      ],
    });
    expect(w.days[1].blocks).toEqual([]);
    expect(w.visits).toHaveLength(1);
    expect(w.mocks).toBe(1);
  });

  it("counts an old-flow mock as a busy hour and toward the weekly limit, but not as a visit", async () => {
    const w = await run({ bookings: [row("mock", TUE, 660, 720, { visitId: null })] });
    expect(w.mocks).toBe(1);
    expect(w.days[1].blocks).toMatchObject([{ kind: "mock", candidate: "Nina Porter" }]);
    expect(w.visits).toEqual([]);
  });

  it("returns stale data with stale true instead of withholding it", async () => {
    const old = new Date(NOW.getTime() - 3 * 3600 * 1000);
    const w = await run({
      bookings: visit(),
      syncedAt: old,
      groups: [group("Peat", { sessionBlocks: [block(MON, 900, 960)] })],
    });
    expect(w.stale).toBe(true);
    expect(w.staleReason).toBe("snapshot");
    expect(w.days[0].blocks.map((b) => b.kind)).toContain("wise");
    // No identity in the index, or no index at all, is stale too and the bookings still show.
    expect((await run({ bookings: visit(), groups: [] })).stale).toBe(true);
    const none = await run({ bookings: visit(), indexFails: true });
    expect(none.stale).toBe(true);
    expect(none.visits).toHaveLength(1);
    expect(none.name).toBe("Peat");
    // Leave known only to a date before the end of the week cannot prove the week is clear.
    const ahead = await run({ groups: [group("Peat", { leavesCompleteThrough: instant(TUE, 0) })] });
    expect([ahead.stale, ahead.staleReason]).toEqual([true, "beyond_leave"]);
    // Unknown leave coverage is a snapshot problem, and good data has no reason.
    expect((await run({ groups: [group("Peat", { leavesCompleteThrough: null })] })).staleReason).toBe("snapshot");
    expect((await run({})).staleReason).toBeNull();
  });

  it("changes week at Bangkok midnight, not UTC", async () => {
    // Sun 1 Nov 23:30 Bangkok is still the week of Mon 26 Oct; Mon 2 Nov 00:30 Bangkok starts the next.
    const sunday = new Date("2026-11-01T16:30:00Z");
    const monday = new Date("2026-11-01T17:30:00Z");
    await expect(run({}, "Peat", MON, undefined, sunday)).resolves.toMatchObject({ weekStart: MON });
    await expect(run({}, "Peat", "2026-10-26", undefined, sunday)).resolves.toMatchObject({ weekStart: "2026-10-26" });
    await expect(run({}, "Peat", "2026-10-26", undefined, monday)).rejects.toMatchObject({ status: 400 });
    await expect(run({}, "Peat", MON, undefined, monday)).resolves.toMatchObject({ weekStart: MON });
  });

  it("refuses an unknown head and a week before the current week", async () => {
    await expect(run({}, "Nobody")).rejects.toMatchObject({ status: 404 });
    await expect(run({}, "Peat", "2026-10-19")).rejects.toMatchObject({ status: 400 });
    // The Wednesday of an earlier week is refused too; a day inside the current week is the current week.
    await expect(run({}, "Peat", "2026-10-21")).rejects.toMatchObject({ status: 400 });
    const midWeek = new Date("2026-11-04T05:00:00Z");
    expect((await run({}, "Peat", "2026-11-05", undefined, midWeek)).weekStart).toBe(MON);
  });
});

describe("visit clashes for the candidate table", () => {
  const bookings = (extra: Record<string, unknown>[] = []) => [
    ...visit(),
    { ...row("mock", TUE, 720, 780, { candidateId: OTHER, visitId: VISIT_2, interviewerKey: "Ek" }) },
    ...extra,
  ];
  const dbWith = (observations: unknown[] = []) => ({
    select: () => ({
      from: () => ({ where: () => Promise.resolve(observations) }),
    }),
  });

  it("lists the candidates whose booked mock clashes, from one index read for all heads", async () => {
    vi.mocked(ensureIndex).mockResolvedValue({
      snapshotId: "snap",
      syncedAt: new Date(NOW.getTime() - 60_000),
      tutorGroups: [
        group("Peat", { sessionBlocks: [block(MON, 750, 840)] }),
        group("Ek", { sessionBlocks: [block(TUE, 0, 60)] }),
      ],
    } as never);
    const result = await visitClashes(dbWith() as never, bookings() as never, NOW);
    expect(result).toEqual({ candidateIds: [CANDIDATE], stale: false });
    expect(ensureIndex).toHaveBeenCalledTimes(1);
  });

  it("skips the index when no future mock is booked, and ignores past and cancelled mocks", async () => {
    const past = new Date("2026-11-10T00:00:00Z");
    expect(await visitClashes(dbWith() as never, bookings() as never, past)).toEqual({ candidateIds: [], stale: false });
    expect(await visitClashes(dbWith() as never, visit({ status: "cancelled" }) as never, NOW)).toEqual({ candidateIds: [], stale: false });
    expect(ensureIndex).not.toHaveBeenCalled();
  });

  it("reports stale instead of failing when the sit-in select fails", async () => {
    vi.mocked(ensureIndex).mockResolvedValue({
      snapshotId: "snap",
      syncedAt: new Date(NOW.getTime() - 60_000),
      tutorGroups: [group("Peat"), group("Ek")],
    } as never);
    const db = { select: () => ({ from: () => ({ where: () => Promise.reject(new Error("relation does not exist")) }) }) };
    expect(await visitClashes(db as never, bookings() as never, NOW)).toEqual({ candidateIds: [], stale: true });
  });

  it("reports stale instead of failing when the index cannot be read", async () => {
    vi.mocked(ensureIndex).mockRejectedValue(new Error("no snapshot"));
    expect(await visitClashes(dbWith() as never, bookings() as never, NOW)).toEqual({ candidateIds: [], stale: true });
  });
});

describe("dashboard with a failing clash check", () => {
  it("still returns when the sit-in select rejects", async () => {
    vi.mocked(ensureIndex).mockResolvedValue({
      snapshotId: "snap",
      syncedAt: new Date(),
      tutorGroups: [group("Peat")],
    } as never);
    const future = new Date("2099-01-05T05:00:00Z");
    const mock = {
      ...row("mock", MON, 720, 780),
      startTime: future,
      endTime: new Date(future.getTime() + 3600_000),
    };
    const rows = new Map<unknown, unknown[]>([[s.hiringBookings, [mock]]]);
    // Any chain of where/orderBy/limit resolves to the table's rows; the sit-in table rejects.
    const chain = (table: unknown): unknown =>
      new Proxy(() => {}, {
        get: (_t, prop) =>
          prop === "then"
            ? table === s.tutorSitInObservations
              ? (_ok: unknown, bad: (e: Error) => void) => bad(new Error("relation does not exist"))
              : (ok: (v: unknown[]) => void) => ok(rows.get(table) ?? [])
            : () => chain(table),
      });
    const db = { select: () => ({ from: (table: unknown) => chain(table) }) };
    const { dashboard } = await import("../service");
    const data = await dashboard(db as never);
    expect(data.visitClashes).toEqual({ candidateIds: [], stale: true });
    expect(data.bookings).toHaveLength(1);
  });
});
