import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "@/lib/db/schema";
import type { IndexedTutorGroup } from "@/lib/search/index";
import { ensureIndex } from "@/lib/search/index";
import { configSchema, instant, type HiringConfig } from "../model";
import {
  assignHead,
  availableVisitSlots,
  headInOffice,
} from "../availability";

vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));

const NOW = new Date("2026-10-30T05:00:00Z"); // Friday; the next 5 business dates are Mon 2 to Fri 6 Nov.
const week = (days: number[], start = "10:00", end = "16:00") =>
  Array.from({ length: 7 }, (_, d) => (days.includes(d) ? { start, end } : null));
const head = (canonicalKey: string, extra = {}) => ({
  canonicalKey,
  subjects: ["Mathematics" as const],
  email: `${canonicalKey.toLowerCase()}@example.com`,
  ...extra,
});
const group = (
  canonicalKey: string,
  extra: Partial<IndexedTutorGroup> = {},
): IndexedTutorGroup => ({
  id: canonicalKey,
  canonicalKey,
  displayName: canonicalKey,
  supportedModes: ["onsite"],
  qualifications: [],
  wiseRecords: [],
  availabilityWindows: [], // No Wise working hours. The saved office hours decide.
  leaves: [],
  leavesCompleteThrough: new Date("2026-12-31"),
  sessionBlocks: [],
  dataIssues: [],
  ...extra,
});
const block = (date: string, from: number, to: number, isBlocking = true) => ({
  startTime: instant(date, from),
  endTime: instant(date, to),
  weekday: 0,
  startMinute: from,
  endMinute: to,
  isBlocking,
  wiseTeacherId: "w",
});
const schedule = (canonicalKey: string, w: unknown, effectiveFrom = "2026-01-01") => ({
  id: `${canonicalKey}-${effectiveFrom}`,
  canonicalKey,
  effectiveFrom,
  week: w,
  revision: 1,
});
const enrol = (canonicalKey: string) => ({
  canonicalKey,
  loginEmail: `${canonicalKey}@example.com`,
  startDate: "2026-01-01",
  endDate: null,
  active: true,
});
const booking = (
  date: string,
  kind: "paper" | "mock",
  from: number,
  to: number,
  extra: Record<string, unknown> = {},
) => ({
  kind,
  status: "confirmed",
  interviewerKey: kind === "mock" ? "Peat" : null,
  startTime: instant(date, from),
  endTime: instant(date, to),
  ...extra,
});

type Fixture = {
  groups?: IndexedTutorGroup[];
  bookings?: unknown[];
  observations?: unknown[];
  schedules?: unknown[];
  exceptions?: unknown[];
  enrollments?: unknown[];
  syncedAt?: Date;
};
function run(
  config: Partial<HiringConfig>,
  f: Fixture = {},
  subject: "Mathematics" | "Chemistry" = "Mathematics",
  now = NOW,
) {
  vi.mocked(ensureIndex).mockResolvedValue({
    snapshotId: "snap",
    syncedAt: f.syncedAt ?? new Date(now.getTime() - 60_000),
    tutorGroups: f.groups ?? [],
  } as never);
  const rows = new Map<unknown, unknown[]>([
    [s.hiringBookings, f.bookings ?? []],
    [s.tutorSitInObservations, f.observations ?? []],
    [s.tutorAttendanceSchedules, f.schedules ?? []],
    [s.tutorAttendanceExceptions, f.exceptions ?? []],
    [s.tutorAttendanceEnrollments, f.enrollments ?? []],
  ]);
  // Only select() exists, so any write by availableVisitSlots would throw.
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const all = rows.get(table) ?? [];
        // The real query filters bookings to status = confirmed in SQL.
        const kept = table === s.hiringBookings
          ? all.filter((r) => (r as { status: string }).status === "confirmed")
          : all;
        return Object.assign(Promise.resolve(all), {
          where: () => Promise.resolve(kept),
        });
      },
    }),
  };
  return availableVisitSlots(
    db as never,
    configSchema.parse(config),
    subject,
    now,
  );
}
const ek = {
  groups: [group("Ek")],
  enrollments: [enrol("Ek")],
  schedules: [schedule("Ek", week([1, 2, 3, 4]))],
};

beforeEach(() => vi.mocked(ensureIndex).mockReset());

describe("visit slots", () => {
  it("offers Ek Mon–Thu and never Friday", async () => {
    const slots = await run({ interviewers: [head("Ek")] }, ek);
    expect([...new Set(slots.map((x) => x.date))]).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ]);
  });

  it("uses the fallback week for Gift", async () => {
    const gift = head("Gift", { fallbackWeek: week([1, 2, 3, 4, 5]) });
    const slots = await run({ interviewers: [gift] }, { groups: [group("Gift")] });
    expect(slots.map((x) => x.date)).toContain("2026-11-06");
    expect(slots.every((x) => x.interviewerKey === "Gift")).toBe(true);
    // No saved hours at all: nothing is offered.
    expect(
      await run({ interviewers: [head("Gift")] }, { groups: [group("Gift")] }),
    ).toEqual([]);
    // An enrolled head ignores the fallback week.
    expect(
      await run(
        { interviewers: [head("Ek", { fallbackWeek: week([5]) })] },
        { ...ek, schedules: [schedule("Ek", week([1]))] },
      ).then((r) => r.map((x) => x.date)),
    ).not.toContain("2026-11-06");
  });

  it("needs no Wise working hours, but a class or leave blocks the mock hour", async () => {
    const cfg = { interviewers: [head("Ek")] };
    const times = (g: IndexedTutorGroup) =>
      run(cfg, { ...ek, groups: [g] }).then((r) =>
        r.filter((x) => x.date === "2026-11-02").map((x) => x.examStart),
      );
    const base = await times(group("Ek"));
    expect(base).toHaveLength(4);
    // The mock of the 10:00 exam is 12:00–13:00.
    const withClass = await times(
      group("Ek", { sessionBlocks: [block("2026-11-02", 750, 780)] }),
    );
    expect(withClass).toEqual(base.filter((_, i) => i !== 0));
    const cancelled = await times(
      group("Ek", { sessionBlocks: [block("2026-11-02", 720, 780, false)] }),
    );
    expect(cancelled).toEqual(base);
    const withLeave = await times(
      group("Ek", {
        leaves: [
          { startTime: instant("2026-11-02", 0), endTime: instant("2026-11-03", 0) },
        ],
      }),
    );
    expect(withLeave).toEqual([]);
    expect(await times(group("Ek", { leavesCompleteThrough: null }))).toEqual([]);
    // Leave coverage that stops before the mock hour is incomplete.
    expect(
      await times(
        group("Ek", { leavesCompleteThrough: instant("2026-11-02", 780) }),
      ),
    ).toEqual([base[0]]);
  });

  it("a Wise class during the exam does not block the head", async () => {
    const slots = await run(
      { interviewers: [head("Ek")] },
      { ...ek, groups: [group("Ek", { sessionBlocks: [block("2026-11-02", 600, 720)] })] },
    );
    // Exam 10:00–12:00 overlaps the class. Mock 12:00–13:00 does not.
    expect(slots.some((x) => x.date === "2026-11-02" && x.examStart === instant("2026-11-02", 600).toISOString())).toBe(true);
  });

  it("starts exams on the hour from 10:00 to 13:00, with the mock right after", async () => {
    const slots = (await run({ interviewers: [head("Ek")] }, ek)).filter(
      (x) => x.date === "2026-11-02",
    );
    expect(slots).toEqual(
      [600, 660, 720, 780].map((m) => ({
        date: "2026-11-02",
        examStart: instant("2026-11-02", m).toISOString(),
        mockStart: instant("2026-11-02", m + 120).toISOString(),
        mockEnd: instant("2026-11-02", m + 180).toISOString(),
        interviewerKey: "Ek",
        subject: "Mathematics",
      })),
    );
  });

  it("follows a changed visit window", async () => {
    const starts = async (window: Partial<HiringConfig>) =>
      (await run(
        { interviewers: [head("Ek")], ...window },
        { ...ek, schedules: [schedule("Ek", week([1], "09:00", "18:00"))] },
      ))
        .filter((x) => x.date === "2026-11-02")
        .map((x) => x.examStart);
    const at = (...hours: number[]) =>
      hours.map((h) => instant("2026-11-02", h * 60).toISOString());
    // End 17:00: the last exam starts 14:00, mock 16:00–17:00.
    expect(await starts({ visitEndMinute: 1020 })).toEqual(at(10, 11, 12, 13, 14));
    // Start 10:30 rounds up to 11:00.
    expect(await starts({ visitStartMinute: 630 })).toEqual(at(11, 12, 13));
  });

  it("refuses when exam capacity is full", async () => {
    const full = await run(
      { interviewers: [head("Ek")], paperCapacity: 1 },
      { ...ek, bookings: [booking("2026-11-02", "paper", 600, 720)] },
    );
    // 10:00 and 11:00 exams overlap the held exam. 12:00 and 13:00 do not.
    expect(
      full.filter((x) => x.date === "2026-11-02").map((x) => x.examStart),
    ).toEqual([instant("2026-11-02", 720), instant("2026-11-02", 780)].map((d) => d.toISOString()));
    const room = await run(
      { interviewers: [head("Ek")], paperCapacity: 2 },
      { ...ek, bookings: [booking("2026-11-02", "paper", 600, 720)] },
    );
    expect(room.filter((x) => x.date === "2026-11-02")).toHaveLength(4);
  });

  it("removes a head at the weekly mock limit", async () => {
    const cfg = {
      interviewers: [head("Peat")],
      onsiteLimits: { perWeek: 3, unbooked: 2, perHeadPerWeek: 2, perSubject: 2 },
    };
    const fixture = (extra: unknown[]) => ({
      groups: [group("Peat")],
      enrollments: [enrol("Peat")],
      schedules: [schedule("Peat", week([1, 2, 3, 4, 5]))],
      bookings: extra,
    });
    // Two confirmed mocks in the Bangkok week of 2 Nov (Mon–Sun).
    const two = [
      booking("2026-11-03", "mock", 900, 960),
      booking("2026-11-06", "mock", 900, 960),
    ];
    expect(await run(cfg, fixture(two))).toEqual([]);
    // Cancelled and no-show mocks free the place.
    const freed = [
      booking("2026-11-03", "mock", 900, 960),
      booking("2026-11-06", "mock", 900, 960, { status: "cancelled" }),
      booking("2026-11-04", "mock", 900, 960, { status: "no_show" }),
    ];
    expect((await run(cfg, fixture(freed))).length).toBeGreaterThan(0);
    // Mocks in the previous week do not count. Sunday 1 Nov belongs to the week of 26 Oct.
    const other = [
      booking("2026-10-28", "mock", 900, 960),
      booking("2026-11-01", "mock", 600, 660),
    ];
    expect((await run(cfg, fixture(other))).length).toBeGreaterThan(0);
    // The limit is per head: another head is not affected.
    const both = await run(
      { ...cfg, interviewers: [head("Peat"), head("Ek")] },
      {
        ...fixture(two),
        groups: [group("Peat"), group("Ek")],
        enrollments: [enrol("Peat"), enrol("Ek")],
        schedules: [schedule("Peat", week([1, 2, 3, 4, 5])), schedule("Ek", week([1, 2, 3, 4, 5]))],
      },
    );
    expect(both.length).toBeGreaterThan(0);
    expect(both.every((x) => x.interviewerKey === "Ek")).toBe(true);
  });

  it("shows each time once and assigns the head with fewer mocks", async () => {
    const f = {
      groups: [group("Peat"), group("Ek")],
      enrollments: [enrol("Peat"), enrol("Ek")],
      schedules: [schedule("Peat", week([1, 2, 3, 4, 5])), schedule("Ek", week([1, 2, 3, 4, 5]))],
    };
    const cfg = { interviewers: [head("Peat"), head("Ek")] };
    const tie = await run(cfg, f);
    const times = tie.map((x) => x.examStart);
    expect(new Set(times).size).toBe(times.length);
    expect(tie.every((x) => x.interviewerKey === "Peat")).toBe(true); // Tie: earlier in settings.
    // Peat has one mock that week: Ek gets the visits, except where Ek is busy.
    const busy = await run(cfg, {
      ...f,
      groups: [group("Peat"), group("Ek", { sessionBlocks: [block("2026-11-02", 720, 780)] })],
      bookings: [booking("2026-11-06", "mock", 900, 960)],
    });
    const first = (key: string) => busy.find((x) => x.date === "2026-11-02" && x.examStart === instant("2026-11-02", 600).toISOString() && x.interviewerKey === key);
    expect(first("Ek")).toBeUndefined(); // Ek has a class in the 12:00 mock hour, so Peat takes it.
    expect(first("Peat")).toBeDefined();
    expect(
      busy.find((x) => x.date === "2026-11-02" && x.examStart === instant("2026-11-02", 660).toISOString())
        ?.interviewerKey,
    ).toBe("Ek");
  });

  it("excludes weekends and closed dates", async () => {
    const f = {
      groups: [group("Gift")],
    };
    const cfg = {
      interviewers: [head("Gift", { fallbackWeek: week([0, 1, 2, 3, 4, 5, 6]) })],
      holidays: ["2026-11-03"],
    };
    const dates = [...new Set((await run(cfg, f)).map((x) => x.date))];
    expect(dates).toEqual(["2026-11-02", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"]);
    // Thursday evening: the next dates skip the weekend.
    const later = await run(cfg, f, "Mathematics", new Date("2026-11-05T12:00:00Z"));
    expect([...new Set(later.map((x) => x.date))]).toEqual([
      "2026-11-06",
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ]);
  });

  it("offers only heads for the subject", async () => {
    const f = { groups: [group("Mimi")] };
    const cfg = { interviewers: [head("Mimi", { subjects: ["Chemistry"], fallbackWeek: week([1]) })] };
    expect(await run(cfg, f, "Mathematics")).toEqual([]);
    expect((await run(cfg, f, "Chemistry")).length).toBeGreaterThan(0);
  });

  it("holds a head for hiring and sit-in clashes", async () => {
    const cfg = { interviewers: [head("Ek")] };
    const sitIn = await run(cfg, {
      ...ek,
      observations: [
        { observerCanonicalKey: "Ek", startTime: instant("2026-11-02", 720), endTime: instant("2026-11-02", 780) },
      ],
    });
    expect(sitIn.some((x) => x.date === "2026-11-02" && x.examStart === instant("2026-11-02", 600).toISOString())).toBe(false);
    // An old-flow mock on the head's calendar blocks the same hour.
    const old = await run(cfg, {
      ...ek,
      bookings: [booking("2026-11-02", "mock", 720, 780, { interviewerKey: "Ek" })],
    });
    expect(old.some((x) => x.date === "2026-11-02" && x.examStart === instant("2026-11-02", 600).toISOString())).toBe(false);
  });

  it("stays fail-closed on stale Wise data and identity, leave or session data issues", async () => {
    const cfg = { interviewers: [head("Ek")] };
    await expect(
      run(cfg, { ...ek, syncedAt: new Date(NOW.getTime() - 91 * 60_000) }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      run(cfg, { ...ek, syncedAt: new Date(NOW.getTime() + 120_000) }),
    ).rejects.toMatchObject({ status: 409 });
    // A head missing from the index (unresolved identity) is never offered.
    expect(await run(cfg, { ...ek, groups: [] })).toEqual([]);
    const issue = (type: string, message: string) => ({ type, message });
    const withIssue = (i: { type: string; message: string }) =>
      run(cfg, { ...ek, groups: [group("Ek", { dataIssues: [i] })] });
    // Real data_issue_type values. A blocked head has no session rows, so it would look free.
    const blocking = [
      issue("alias", "identity_collision: nickname \"Ek\" matched 2 teachers"),
      issue("completeness", "Failed to fetch leave data for teacher \"Ek\": 500"),
      issue("completeness", 'Wise session s1 references teacher u1 absent from the teacher roster. Restore/correct that teacher in Wise; the next sync will retry automatically.'),
      issue("completeness", "Something new went wrong"), // unknown completeness message fails closed
    ];
    for (const i of blocking) expect(await withIssue(i)).toEqual([]);
    // These do not block: Wise hours and modality are not used, and tag and model notes are not data gaps.
    const allowed = [
      issue("completeness", 'Failed to fetch availability for teacher "Ek": Wise 500'),
      issue("completeness", 'Failed to fetch availability for teacher "Ek": missing Wise user id'),
      issue("tag", 'Unmapped Wise tag: "x"'),
      issue("modality", 'Cannot determine modality for "Ek" — insufficient evidence'),
      issue("conflict_model", "x"),
    ];
    for (const i of allowed) expect((await withIssue(i)).length).toBeGreaterThan(0);
  });
});

describe("headInOffice", () => {
  const ctx = (extra = {}) => ({
    schedules: [] as never[],
    exceptions: [] as never[],
    enrollments: [] as never[],
    ...extra,
  });
  it("does not apply a schedule version before its effective date", () => {
    const c = ctx({
      enrollments: [enrol("Ek")],
      schedules: [
        schedule("Ek", week([1]), "2026-11-01"),
        schedule("Ek", week([2]), "2026-11-10"),
      ],
    });
    const ek = head("Ek");
    // Mon 2 Nov and Tue 3 Nov use the first version only.
    expect(headInOffice(ek, "2026-11-02", 600, 660, c)).toBe(true);
    expect(headInOffice(ek, "2026-11-03", 600, 660, c)).toBe(false);
    // Tue 10 Nov is the first day of the second version. Mon 9 Nov still uses the first.
    expect(headInOffice(ek, "2026-11-09", 600, 660, c)).toBe(true);
    expect(headInOffice(ek, "2026-11-10", 600, 660, c)).toBe(true);
    expect(headInOffice(ek, "2026-11-16", 600, 660, c)).toBe(false);
    // Only a future version exists: no hours yet.
    expect(
      headInOffice(ek, "2026-11-04", 600, 660, ctx({ enrollments: [enrol("Ek")], schedules: [schedule("Ek", week([3]), "2026-12-01")] })),
    ).toBe(false);
  });
  it("needs the whole hour inside the window and honours exceptions and enrolment", () => {
    const ek = head("Ek");
    const base = { enrollments: [enrol("Ek")], schedules: [schedule("Ek", week([1], "10:00", "16:00"))] };
    expect(headInOffice(ek, "2026-11-02", 900, 960, ctx(base))).toBe(true);
    expect(headInOffice(ek, "2026-11-02", 960, 1020, ctx(base))).toBe(false);
    expect(headInOffice(ek, "2026-11-02", 570, 630, ctx(base))).toBe(false);
    const excused = (canonicalKey: string | null) => ({
      id: "x", canonicalKey, date: "2026-11-02", kind: "excused", start: null, end: null, reason: "r", revision: 1,
    });
    expect(headInOffice(ek, "2026-11-02", 600, 660, ctx({ ...base, exceptions: [excused("Ek")] }))).toBe(false);
    expect(headInOffice(ek, "2026-11-02", 600, 660, ctx({ ...base, exceptions: [excused(null)] }))).toBe(false);
    expect(headInOffice(ek, "2026-11-02", 600, 660, ctx({ ...base, enrollments: [{ ...enrol("Ek"), active: false }] }))).toBe(false);
    expect(headInOffice(ek, "2026-11-02", 600, 660, ctx({ ...base, enrollments: [{ ...enrol("Ek"), endDate: "2026-11-01" }] }))).toBe(false);
    // A fallback-week head closed by a global closure is also out.
    const gift = head("Gift", { fallbackWeek: week([1]) });
    expect(headInOffice(gift, "2026-11-02", 600, 660, ctx())).toBe(true);
    expect(headInOffice(gift, "2026-11-02", 600, 660, ctx({ exceptions: [excused(null)] }))).toBe(false);
  });
});

describe("assignHead", () => {
  it("takes the head with fewer mocks, and the earlier head on a tie", () => {
    expect(assignHead([{ key: "Peat", weekMocks: 1 }, { key: "Ek", weekMocks: 0 }])).toBe("Ek");
    expect(assignHead([{ key: "Peat", weekMocks: 1 }, { key: "Ek", weekMocks: 1 }])).toBe("Peat");
  });
});
