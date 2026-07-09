import { beforeEach, describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the domain
// functions can be unit-tested without a real database. The sibling data
// sources buildThisWeek merges are mocked so ranking is tested in isolation;
// getPhaseProgress runs against the fake chainable db below.
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/calendar")>()),
  getUpcomingDeadlines: vi.fn(),
}));
vi.mock("@/lib/admissions/essays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/essays")>()),
  listEssaysForCase: vi.fn(),
}));
vi.mock("@/lib/admissions/sections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/sections")>()),
  listSectionStates: vi.fn(),
}));

import {
  getUpcomingDeadlines,
  UPCOMING_DEADLINES_MAX_LIMIT,
  type CalendarItem,
} from "@/lib/admissions/calendar";
import { listEssaysForCase, type AdmissionsEssayListRowDto } from "@/lib/admissions/essays";
import { listSectionStates, type AdmissionsSectionSummary } from "@/lib/admissions/sections";
import {
  buildThisWeek,
  getPhaseProgress,
  isPhaseSeasonRelevant,
  THIS_WEEK_DEFAULT_LIMIT,
} from "@/lib/admissions/student-home";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ESSAY_ID = "22222222-2222-4222-8222-222222222222";
const ESSAY_ID_B = "33333333-3333-4333-8333-333333333333";

// Bangkok noon on 2026-07-09 → todayKey "2026-07-09"; 7-day horizon
// "2026-07-16"; 30-day essay horizon "2026-08-08".
const NOW = new Date("2026-07-09T05:00:00Z");

const mockGetUpcomingDeadlines = vi.mocked(getUpcomingDeadlines);
const mockListEssaysForCase = vi.mocked(listEssaysForCase);
const mockListSectionStates = vi.mocked(listSectionStates);

function calendarItem(overrides: Partial<CalendarItem> = {}): CalendarItem {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    caseId: CASE_ID,
    source: "task",
    title: "Draft the activities list",
    date: "2026-07-12",
    overdue: false,
    ownerRole: "student",
    ...overrides,
  };
}

function essayRow(overrides: Partial<AdmissionsEssayListRowDto> = {}): AdmissionsEssayListRowDto {
  return {
    id: ESSAY_ID,
    caseId: CASE_ID,
    listItemId: null,
    prompt: "Personal statement",
    status: "drafting",
    counselorStage: null,
    deadline: "2026-08-01",
    driveUrl: null,
    lastStudentUpdateAt: "2026-06-01T00:00:00Z",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    stalenessDays: 20,
    effectiveStage: "drafting",
    ...overrides,
  };
}

function sectionSummary(
  overrides: Partial<AdmissionsSectionSummary> = {},
): AdmissionsSectionSummary {
  return {
    sectionKey: "about_you",
    title: "About You",
    state: "draft",
    submittedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUpcomingDeadlines.mockResolvedValue([]);
  mockListEssaysForCase.mockResolvedValue([]);
  mockListSectionStates.mockResolvedValue([]);
});

describe("buildThisWeek", () => {
  it("ranks overdue calendar items first, then upcoming, then nudges, capped at the limit", async () => {
    mockGetUpcomingDeadlines.mockResolvedValue([
      calendarItem({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
        title: "Overdue task",
        date: "2026-07-01",
        overdue: true,
      }),
      calendarItem({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
        source: "application",
        title: "MIT — ED deadline",
        date: "2026-07-12",
      }),
    ]);
    mockListEssaysForCase.mockResolvedValue([
      essayRow({ id: ESSAY_ID, prompt: "Why us?", deadline: "2026-07-25", stalenessDays: null }),
      essayRow({ id: ESSAY_ID_B, prompt: "Community essay", deadline: "2026-08-01" }),
    ]);
    mockListSectionStates.mockResolvedValue([
      sectionSummary(),
      sectionSummary({ sectionKey: "q_and_a_survey", title: "Q&A Survey", state: "submitted" }),
      sectionSummary({ sectionKey: "personality", title: "Personality" }),
    ]);

    const actions = await buildThisWeek(CASE_ID, { now: NOW }, {} as never);

    expect(actions).toHaveLength(THIS_WEEK_DEFAULT_LIMIT);
    expect(actions.map((action) => action.anchor)).toEqual([
      "task:aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      "application:aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
      `essay:${ESSAY_ID}`,
      `essay:${ESSAY_ID_B}`,
      "section:about_you",
    ]);
    expect(actions[0]).toMatchObject({
      kind: "task",
      title: "Overdue task",
      dueDate: "2026-07-01",
      overdue: true,
    });
    expect(actions[2]).toMatchObject({
      kind: "essay",
      title: "Update essay: Why us?",
      dueDate: "2026-07-25",
      overdue: false,
    });
    expect(actions[4]).toMatchObject({
      kind: "section",
      title: "Complete section: About You",
      dueDate: null,
      overdue: false,
    });

    expect(mockGetUpcomingDeadlines).toHaveBeenCalledWith(
      CASE_ID,
      UPCOMING_DEADLINES_MAX_LIMIT,
      NOW,
      expect.anything(),
    );
  });

  it("drops calendar items beyond the 7-day window", async () => {
    mockGetUpcomingDeadlines.mockResolvedValue([
      calendarItem({ date: "2026-07-16", title: "On the horizon" }),
      calendarItem({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000009",
        date: "2026-07-17",
        title: "Too far out",
      }),
    ]);

    const actions = await buildThisWeek(CASE_ID, { now: NOW }, {} as never);

    expect(actions.map((action) => action.title)).toEqual(["On the horizon"]);
  });

  it("nudges only essays that are stale enough with a near-enough deadline", async () => {
    mockListEssaysForCase.mockResolvedValue([
      essayRow({ id: ESSAY_ID, stalenessDays: 13 }),
      essayRow({ id: ESSAY_ID_B, stalenessDays: 14 }),
      essayRow({
        id: "44444444-4444-4444-8444-444444444444",
        stalenessDays: 30,
        deadline: "2026-09-15",
      }),
      essayRow({
        id: "55555555-5555-4555-8555-555555555555",
        stalenessDays: 30,
        deadline: null,
      }),
      essayRow({
        id: "66666666-6666-4666-8666-666666666666",
        stalenessDays: 30,
        effectiveStage: "final",
      }),
    ]);

    const actions = await buildThisWeek(CASE_ID, { now: NOW }, {} as never);

    expect(actions.map((action) => action.anchor)).toEqual([`essay:${ESSAY_ID_B}`]);
  });

  it("marks an overdue essay-deadline nudge as overdue", async () => {
    mockListEssaysForCase.mockResolvedValue([
      essayRow({ deadline: "2026-07-05", stalenessDays: 21 }),
    ]);

    const actions = await buildThisWeek(CASE_ID, { now: NOW }, {} as never);

    expect(actions[0]).toMatchObject({ kind: "essay", dueDate: "2026-07-05", overdue: true });
  });

  it("dedupes an essay nudge already present as a calendar item", async () => {
    // The registered essay collector surfaces the same essay as a calendar
    // item (source "essay"); the nudge pass must not duplicate it.
    mockGetUpcomingDeadlines.mockResolvedValue([
      calendarItem({
        id: ESSAY_ID,
        source: "essay",
        title: "Essay: Personal statement",
        date: "2026-07-10",
      }),
    ]);
    mockListEssaysForCase.mockResolvedValue([
      essayRow({ id: ESSAY_ID, deadline: "2026-07-10", stalenessDays: 21 }),
    ]);

    const actions = await buildThisWeek(CASE_ID, { now: NOW }, {} as never);

    expect(actions).toHaveLength(1);
    expect(actions[0].anchor).toBe(`essay:${ESSAY_ID}`);
    expect(actions[0].title).toBe("Essay: Personal statement");
  });

  it("clamps the limit to at least one action", async () => {
    mockListSectionStates.mockResolvedValue([
      sectionSummary(),
      sectionSummary({ sectionKey: "personality", title: "Personality" }),
    ]);

    const actions = await buildThisWeek(CASE_ID, { now: NOW, limit: 0 }, {} as never);

    expect(actions).toHaveLength(1);
  });

  it("throws NotFound for a malformed caseId", async () => {
    await expect(buildThisWeek("nope", { now: NOW }, {} as never)).rejects.toThrow("NotFound");
    expect(mockGetUpcomingDeadlines).not.toHaveBeenCalled();
  });
});

describe("isPhaseSeasonRelevant", () => {
  it("unlocks Transition in senior spring (March of the graduation year)", () => {
    expect(isPhaseSeasonRelevant("transition", 2027, new Date("2027-02-15T05:00:00Z"))).toBe(false);
    expect(isPhaseSeasonRelevant("transition", 2027, new Date("2027-03-15T05:00:00Z"))).toBe(true);
  });

  it("unlocks Decisions & Aid in December of senior year", () => {
    expect(isPhaseSeasonRelevant("decisions_aid", 2027, new Date("2026-11-15T05:00:00Z"))).toBe(false);
    expect(isPhaseSeasonRelevant("decisions_aid", 2027, new Date("2026-12-15T05:00:00Z"))).toBe(true);
  });

  it("unlocks Applications in August of senior year", () => {
    expect(isPhaseSeasonRelevant("applications", 2027, new Date("2026-07-15T05:00:00Z"))).toBe(false);
    expect(isPhaseSeasonRelevant("applications", 2027, new Date("2026-08-15T05:00:00Z"))).toBe(true);
  });

  it("keeps early phases always relevant and everything relevant after graduation", () => {
    expect(isPhaseSeasonRelevant("about_you", 2027, new Date("2025-01-15T05:00:00Z"))).toBe(true);
    expect(isPhaseSeasonRelevant("transition", 2027, new Date("2027-09-15T05:00:00Z"))).toBe(true);
  });
});

describe("getPhaseProgress", () => {
  interface FakeDb {
    select: () => unknown;
  }

  /** Minimal chainable select-only fake (queue order = query order). */
  function fakeDb(queue: unknown[][]): FakeDb {
    let i = 0;
    function selectBuilder(rows: unknown[]) {
      const b: Record<string, unknown> = {};
      for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit"]) {
        b[method] = () => b;
      }
      (b as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return b;
    }
    return { select: () => selectBuilder(queue[i++] ?? []) };
  }

  const TASK_ROWS = [
    { phase: "about_you", status: "done", verifiedAt: new Date("2026-06-01T00:00:00Z") },
    { phase: "about_you", status: "not_started", verifiedAt: null },
    { phase: "applications", status: "in_progress", verifiedAt: null },
    { phase: "transition", status: "not_started", verifiedAt: null },
    { phase: "custom", status: "done", verifiedAt: null },
  ];

  it("rolls up per-phase progress and hides out-of-season phases", async () => {
    const db = fakeDb([[{ graduationYear: 2027 }], TASK_ROWS]);

    // Feb 2027: transition (unlocks March) is hidden; applications is open.
    const rings = await getPhaseProgress(
      CASE_ID,
      { now: new Date("2027-02-15T05:00:00Z") },
      db as never,
    );

    expect(rings.map((ring) => ring.phase)).toEqual(["about_you", "applications"]);
    expect(rings[0]).toMatchObject({
      phase: "about_you",
      label: "About You",
      done: 1,
      total: 2,
      percent: 50,
      verifiedCount: 1,
    });
    expect(rings[1]).toMatchObject({ phase: "applications", done: 0, total: 1, percent: 0 });
  });

  it("shows Transition once senior spring arrives", async () => {
    const db = fakeDb([[{ graduationYear: 2027 }], TASK_ROWS]);

    const rings = await getPhaseProgress(
      CASE_ID,
      { now: new Date("2027-03-15T05:00:00Z") },
      db as never,
    );

    expect(rings.map((ring) => ring.phase)).toEqual([
      "about_you",
      "applications",
      "transition",
    ]);
  });

  it("omits phases with zero tasks and non-canonical phases", async () => {
    const db = fakeDb([
      [{ graduationYear: 2027 }],
      [{ phase: "custom", status: "done", verifiedAt: null }],
    ]);

    const rings = await getPhaseProgress(
      CASE_ID,
      { now: new Date("2027-03-15T05:00:00Z") },
      db as never,
    );

    expect(rings).toEqual([]);
  });

  it("throws NotFound when the case is missing", async () => {
    const db = fakeDb([[]]);

    await expect(
      getPhaseProgress(CASE_ID, { now: NOW }, db as never),
    ).rejects.toThrow("NotFound");
  });

  it("throws NotFound for a malformed caseId", async () => {
    const db = fakeDb([]);

    await expect(getPhaseProgress("nope", { now: NOW }, db as never)).rejects.toThrow("NotFound");
  });
});
