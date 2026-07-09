import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  UPCOMING_DEADLINES_DEFAULT_LIMIT,
  UPCOMING_DEADLINES_MAX_LIMIT,
  buildCaseCalendar,
  getUpcomingDeadlines,
  getUpcomingDeadlinesForCases,
} from "@/lib/admissions/calendar";
import type { Database } from "@/lib/db";

const CASE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CASE_ID = "44444444-4444-4444-8444-444444444444";

// 12:00 Asia/Bangkok on 2026-07-09 → Bangkok "today" is 2026-07-09.
const NOW = new Date("2026-07-09T05:00:00Z");

const CALENDAR_ITEM_KEYS = [
  "caseId",
  "date",
  "id",
  "overdue",
  "ownerRole",
  "source",
  "title",
];

interface TaskRowInput {
  id: string;
  caseId?: string;
  title?: string;
  owner?: string;
  status?: string;
  dueDate: string | null;
}

function makeTaskRow(input: TaskRowInput) {
  return {
    id: input.id,
    caseId: input.caseId ?? CASE_ID,
    title: input.title ?? `Task ${input.id}`,
    owner: input.owner ?? "student",
    status: input.status ?? "not_started",
    dueDate: input.dueDate,
  };
}

/**
 * Mock read db for the task collector: select(fields).from().where() resolves
 * the provided rows. The where clause is ignored, so date-window filtering and
 * ordering must be proven in process. EVERY collector receives the same rows
 * — task-shaped rows have no `deadline`/`testDate`/`registrationDeadline`
 * fields, so the application, essay, and testing collectors all fail-closed
 * skip them (these suites exercise the task source alone).
 */
function makeTaskDb(rows: Array<Record<string, unknown>>) {
  const select = vi.fn(() => ({
    from: () => ({ where: async () => rows }),
  }));
  const db = { select } as unknown as Database;
  return { db, select };
}

interface CollegeRowInput {
  id: string;
  caseId?: string;
  instName?: string;
  round?: string;
  deadline: string | null;
  appStatus?: string;
}

function makeCollegeRow(input: CollegeRowInput) {
  return {
    id: input.id,
    caseId: input.caseId ?? CASE_ID,
    instName: input.instName ?? `College ${input.id}`,
    round: input.round ?? "rd",
    deadline: input.deadline,
    appStatus: input.appStatus ?? "researching",
  };
}

interface EssayRowInput {
  id: string;
  caseId?: string;
  prompt?: string;
  status?: string;
  counselorStage?: string | null;
  deadline: string | null;
}

function makeEssayRow(input: EssayRowInput) {
  return {
    id: input.id,
    caseId: input.caseId ?? CASE_ID,
    prompt: input.prompt ?? `Essay ${input.id}`,
    status: input.status ?? "drafting",
    counselorStage: input.counselorStage ?? null,
    deadline: input.deadline,
  };
}

interface SittingRowInput {
  id: string;
  caseId?: string;
  testType?: string;
  testDate: string;
  registrationDeadline?: string | null;
  actualScore?: string | null;
}

function makeSittingRow(input: SittingRowInput) {
  return {
    id: input.id,
    caseId: input.caseId ?? CASE_ID,
    testType: input.testType ?? "sat",
    testDate: input.testDate,
    registrationDeadline: input.registrationDeadline ?? null,
    actualScore: input.actualScore ?? null,
  };
}

/**
 * Queue-based mock db for multi-source aggregation, one entry per collector
 * in registration order: task, application, essay, testing (omitted sources
 * read []). Merge/sort/overdue behavior is proven in process.
 */
function makeSourcesDb(
  taskRows: Array<Record<string, unknown>>,
  collegeRows: Array<Record<string, unknown>>,
  essayRows: Array<Record<string, unknown>> = [],
  sittingRows: Array<Record<string, unknown>> = [],
) {
  const queue = [taskRows, collegeRows, essayRows, sittingRows];
  let i = 0;
  const select = vi.fn(() => {
    const rows = queue[i++] ?? [];
    return { from: () => ({ where: async () => rows }) };
  });
  const db = { select } as unknown as Database;
  return { db, select };
}

describe("buildCaseCalendar", () => {
  it("throws NotFound for a malformed caseId without querying", async () => {
    const { db, select } = makeTaskDb([]);

    await expect(buildCaseCalendar("nope", { from: "2026-07-01", to: "2026-07-31" }, NOW, db))
      .rejects.toThrow("NotFound");
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects malformed or inverted windows before querying", async () => {
    const { db, select } = makeTaskDb([]);

    await expect(buildCaseCalendar(CASE_ID, { from: "July 1", to: "2026-07-31" }, NOW, db))
      .rejects.toThrow(/Invalid from/);
    await expect(buildCaseCalendar(CASE_ID, { from: "2026-07-01", to: "31/07/2026" }, NOW, db))
      .rejects.toThrow(/Invalid to/);
    await expect(buildCaseCalendar(CASE_ID, { from: "2026-07-31", to: "2026-07-01" }, NOW, db))
      .rejects.toThrow(/from must be on or before to/);
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps only tasks inside the inclusive window, sorted date ascending", async () => {
    const { db } = makeTaskDb([
      makeTaskRow({ id: "t-before", dueDate: "2026-06-30" }),
      makeTaskRow({ id: "t-from", dueDate: "2026-07-01" }),
      makeTaskRow({ id: "t-mid", dueDate: "2026-07-15" }),
      makeTaskRow({ id: "t-to", dueDate: "2026-07-31" }),
      makeTaskRow({ id: "t-after", dueDate: "2026-08-01" }),
    ]);

    const items = await buildCaseCalendar(
      CASE_ID,
      { from: "2026-07-01", to: "2026-07-31" },
      NOW,
      db,
    );

    expect(items.map((item) => item.id)).toEqual(["t-from", "t-mid", "t-to"]);
    expect(items.every((item) => item.source === "task")).toBe(true);
    expect(items.every((item) => item.caseId === CASE_ID)).toBe(true);
    expect(Object.keys(items[0]).sort()).toEqual(CALENDAR_ITEM_KEYS);
  });

  it("flags open past-due tasks overdue; today and future dates are not overdue", async () => {
    const { db } = makeTaskDb([
      makeTaskRow({ id: "t-past", dueDate: "2026-07-05" }),
      makeTaskRow({ id: "t-today", dueDate: "2026-07-09" }),
      makeTaskRow({ id: "t-future", dueDate: "2026-07-20" }),
    ]);

    const items = await buildCaseCalendar(
      CASE_ID,
      { from: "2026-07-01", to: "2026-07-31" },
      NOW,
      db,
    );

    expect(items.map((item) => [item.id, item.overdue])).toEqual([
      ["t-past", true],
      ["t-today", false],
      ["t-future", false],
    ]);
  });

  it("never flags a done task overdue, but still shows it on the grid", async () => {
    const { db } = makeTaskDb([
      makeTaskRow({ id: "t-done-past", status: "done", dueDate: "2026-07-02" }),
      makeTaskRow({ id: "t-open-past", status: "in_progress", dueDate: "2026-07-02" }),
    ]);

    const items = await buildCaseCalendar(
      CASE_ID,
      { from: "2026-07-01", to: "2026-07-31" },
      NOW,
      db,
    );

    expect(items.map((item) => [item.id, item.overdue])).toEqual([
      ["t-done-past", false],
      ["t-open-past", true],
    ]);
  });

  it("carries the task owner as ownerRole and skips malformed due dates (fail-closed)", async () => {
    const { db } = makeTaskDb([
      makeTaskRow({ id: "t-parent", owner: "parent", dueDate: "2026-07-10" }),
      makeTaskRow({ id: "t-bad-date", dueDate: "next week" }),
      makeTaskRow({ id: "t-null-date", dueDate: null }),
    ]);

    const items = await buildCaseCalendar(
      CASE_ID,
      { from: "2026-07-01", to: "2026-07-31" },
      NOW,
      db,
    );

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("t-parent");
    expect(items[0].ownerRole).toBe("parent");
  });
});

describe("task + application source aggregation", () => {
  it("merges both sources into one date-ordered calendar (CM-100)", async () => {
    const { db, select } = makeSourcesDb(
      [
        makeTaskRow({ id: "t-early", dueDate: "2026-07-05" }),
        makeTaskRow({ id: "t-late", dueDate: "2026-07-20" }),
      ],
      [
        makeCollegeRow({
          id: "c-mid",
          instName: "Harvard University",
          round: "ed",
          deadline: "2026-07-10",
        }),
      ],
    );

    const items = await buildCaseCalendar(
      CASE_ID,
      { from: "2026-07-01", to: "2026-07-31" },
      NOW,
      db,
    );

    // One query per registered source (task, application, essay, testing).
    expect(select).toHaveBeenCalledTimes(4);
    expect(items.map((item) => [item.id, item.source])).toEqual([
      ["t-early", "task"],
      ["c-mid", "application"],
      ["t-late", "task"],
    ]);
    expect(items[1]).toMatchObject({
      caseId: CASE_ID,
      title: "Harvard University — ED deadline",
      date: "2026-07-10",
      ownerRole: null,
    });
    expect(Object.keys(items[1]).sort()).toEqual(CALENDAR_ITEM_KEYS);
  });

  it("stamps overdue on open past application deadlines, never on submitted ones", async () => {
    const { db } = makeSourcesDb(
      [],
      [
        makeCollegeRow({ id: "c-open-past", deadline: "2026-07-01", appStatus: "applying" }),
        makeCollegeRow({ id: "c-submitted-past", deadline: "2026-07-01", appStatus: "submitted" }),
        makeCollegeRow({ id: "c-open-future", deadline: "2026-07-20" }),
      ],
    );

    const items = await buildCaseCalendar(
      CASE_ID,
      { from: "2026-07-01", to: "2026-07-31" },
      NOW,
      db,
    );

    expect(items.map((item) => [item.id, item.overdue])).toEqual([
      ["c-open-past", true],
      ["c-submitted-past", false],
      ["c-open-future", false],
    ]);
  });

  it("orders same-date items across sources deterministically (application before task)", async () => {
    const { db } = makeSourcesDb(
      [makeTaskRow({ id: "same-day-task", dueDate: "2026-07-10" })],
      [makeCollegeRow({ id: "same-day-app", deadline: "2026-07-10" })],
    );

    const items = await buildCaseCalendar(
      CASE_ID,
      { from: "2026-07-01", to: "2026-07-31" },
      NOW,
      db,
    );

    expect(items.map((item) => item.source)).toEqual(["application", "task"]);
  });

  it("excludes submitted/complete applications from the deadlines panel but keeps open ones (CM-102)", async () => {
    const { db } = makeSourcesDb(
      [
        makeTaskRow({ id: "t-open", dueDate: "2026-07-15" }),
        makeTaskRow({ id: "t-done", status: "done", dueDate: "2026-07-03" }),
      ],
      [
        makeCollegeRow({ id: "c-overdue", deadline: "2026-07-01", appStatus: "applying" }),
        makeCollegeRow({ id: "c-complete", deadline: "2026-07-02", appStatus: "complete" }),
        makeCollegeRow({ id: "c-future", deadline: "2026-08-01" }),
      ],
    );

    const items = await getUpcomingDeadlines(CASE_ID, 10, NOW, db);

    expect(items.map((item) => [item.id, item.source, item.overdue])).toEqual([
      ["c-overdue", "application", true],
      ["t-open", "task", false],
      ["c-future", "application", false],
    ]);
  });
});

describe("four-source aggregation (task + application + essay + testing)", () => {
  it("merges all four sources into one date-ordered calendar", async () => {
    const { db, select } = makeSourcesDb(
      [makeTaskRow({ id: "t-first", dueDate: "2026-07-05" })],
      [
        makeCollegeRow({
          id: "c-second",
          instName: "Harvard University",
          round: "ed",
          deadline: "2026-07-10",
        }),
      ],
      [makeEssayRow({ id: "e-fourth", prompt: "Why us?", deadline: "2026-07-15" })],
      [
        makeSittingRow({
          id: "s-1",
          testType: "sat",
          testDate: "2026-07-20",
          registrationDeadline: "2026-07-12",
        }),
      ],
    );

    const items = await buildCaseCalendar(
      CASE_ID,
      { from: "2026-07-01", to: "2026-07-31" },
      NOW,
      db,
    );

    expect(select).toHaveBeenCalledTimes(4);
    expect(items.map((item) => [item.id, item.source, item.title])).toEqual([
      ["t-first", "task", "Task t-first"],
      ["c-second", "application", "Harvard University — ED deadline"],
      ["s-1:registration", "testing", "SAT registration deadline"],
      ["e-fourth", "essay", "Essay: Why us?"],
      ["s-1:sitting", "testing", "SAT sitting"],
    ]);
    // Essay/testing entries are student work; each carries the full DTO shape.
    expect(items[2].ownerRole).toBe("student");
    expect(items[3].ownerRole).toBe("student");
    expect(Object.keys(items[3]).sort()).toEqual(CALENDAR_ITEM_KEYS);
  });

  it("stamps overdue on open past essay/testing dates, never on finished ones", async () => {
    const { db } = makeSourcesDb(
      [],
      [],
      [
        makeEssayRow({ id: "e-open-past", deadline: "2026-07-01" }),
        makeEssayRow({ id: "e-final-past", deadline: "2026-07-01", counselorStage: "final" }),
      ],
      [
        makeSittingRow({ id: "s-open", testDate: "2026-07-02" }),
        makeSittingRow({ id: "s-scored", testDate: "2026-07-02", actualScore: "1450" }),
      ],
    );

    const items = await buildCaseCalendar(
      CASE_ID,
      { from: "2026-07-01", to: "2026-07-31" },
      NOW,
      db,
    );

    expect(items.map((item) => [item.id, item.overdue])).toEqual([
      ["e-final-past", false],
      ["e-open-past", true],
      ["s-open:sitting", true],
      ["s-scored:sitting", false],
    ]);
  });

  it("drops finished essays and scored sittings from the deadlines panel (CM-102)", async () => {
    const { db } = makeSourcesDb(
      [makeTaskRow({ id: "t-open", dueDate: "2026-07-18" })],
      [],
      [
        makeEssayRow({ id: "e-open", deadline: "2026-07-14" }),
        // Student-set status "final" completes the essay even without a
        // counselor stage (effective stage = counselorStage ?? status).
        makeEssayRow({ id: "e-status-final", status: "final", deadline: "2026-07-01" }),
      ],
      [
        makeSittingRow({
          id: "s-open",
          testType: "ielts",
          testDate: "2026-07-16",
          registrationDeadline: "2026-07-02",
        }),
        makeSittingRow({ id: "s-scored", testDate: "2026-07-03", actualScore: "1500" }),
      ],
    );

    const items = await getUpcomingDeadlines(CASE_ID, 10, NOW, db);

    expect(items.map((item) => [item.id, item.source, item.overdue])).toEqual([
      ["s-open:registration", "testing", true],
      ["e-open", "essay", false],
      ["s-open:sitting", "testing", false],
      ["t-open", "task", false],
    ]);
    expect(items[0].title).toBe("IELTS registration deadline");
  });
});

describe("getUpcomingDeadlines", () => {
  it("throws NotFound for a malformed caseId without querying", async () => {
    const { db, select } = makeTaskDb([]);

    await expect(getUpcomingDeadlines("nope", 5, NOW, db)).rejects.toThrow("NotFound");
    expect(select).not.toHaveBeenCalled();
  });

  it("sorts by urgency — overdue first (longest-overdue at the top), then by date", async () => {
    const { db } = makeTaskDb([
      makeTaskRow({ id: "t-future-far", dueDate: "2026-08-01" }),
      makeTaskRow({ id: "t-overdue-old", dueDate: "2026-06-20" }),
      makeTaskRow({ id: "t-future-near", dueDate: "2026-07-12" }),
      makeTaskRow({ id: "t-overdue-recent", dueDate: "2026-07-07" }),
    ]);

    const items = await getUpcomingDeadlines(CASE_ID, 10, NOW, db);

    expect(items.map((item) => item.id)).toEqual([
      "t-overdue-old",
      "t-overdue-recent",
      "t-future-near",
      "t-future-far",
    ]);
    expect(items.map((item) => item.overdue)).toEqual([true, true, false, false]);
  });

  it("excludes done tasks and applies the limit after sorting", async () => {
    const { db } = makeTaskDb([
      makeTaskRow({ id: "t-done", status: "done", dueDate: "2026-07-01" }),
      makeTaskRow({ id: "t-1", dueDate: "2026-07-10" }),
      makeTaskRow({ id: "t-2", dueDate: "2026-07-11" }),
      makeTaskRow({ id: "t-3", dueDate: "2026-07-12" }),
    ]);

    const items = await getUpcomingDeadlines(CASE_ID, 2, NOW, db);

    expect(items.map((item) => item.id)).toEqual(["t-1", "t-2"]);
  });

  it("clamps a hostile limit into [1, max]", async () => {
    const rows = [
      makeTaskRow({ id: "t-1", dueDate: "2026-07-10" }),
      makeTaskRow({ id: "t-2", dueDate: "2026-07-11" }),
    ];
    const { db } = makeTaskDb(rows);

    const zeroLimit = await getUpcomingDeadlines(CASE_ID, 0, NOW, db);
    expect(zeroLimit).toHaveLength(1);

    const hugeLimit = await getUpcomingDeadlines(CASE_ID, 1_000_000, NOW, db);
    expect(hugeLimit).toHaveLength(2);
    expect(UPCOMING_DEADLINES_DEFAULT_LIMIT).toBeLessThanOrEqual(UPCOMING_DEADLINES_MAX_LIMIT);
  });
});

describe("getUpcomingDeadlinesForCases", () => {
  it("returns [] for an empty caseload without querying", async () => {
    const { db, select } = makeTaskDb([]);

    const items = await getUpcomingDeadlinesForCases([], 5, NOW, db);

    expect(items).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("drops malformed caseIds instead of failing the whole caseload view", async () => {
    const { db, select } = makeTaskDb([]);

    const items = await getUpcomingDeadlinesForCases(["nope", "also-bad"], 5, NOW, db);

    expect(items).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("merges cases into one urgency-ordered list with a shared limit (CM-101)", async () => {
    const { db } = makeTaskDb([
      makeTaskRow({ id: "a-future", caseId: CASE_ID, dueDate: "2026-07-15" }),
      makeTaskRow({ id: "b-overdue", caseId: OTHER_CASE_ID, dueDate: "2026-07-01" }),
      makeTaskRow({ id: "a-overdue", caseId: CASE_ID, dueDate: "2026-06-25" }),
      makeTaskRow({ id: "b-future", caseId: OTHER_CASE_ID, dueDate: "2026-07-10" }),
    ]);

    const items = await getUpcomingDeadlinesForCases([CASE_ID, OTHER_CASE_ID], 3, NOW, db);

    expect(items.map((item) => [item.id, item.caseId])).toEqual([
      ["a-overdue", CASE_ID],
      ["b-overdue", OTHER_CASE_ID],
      ["b-future", OTHER_CASE_ID],
    ]);
    expect(items.map((item) => item.overdue)).toEqual([true, true, false]);
  });

  it("breaks same-date ties by caseId then id for a stable cross-case order", async () => {
    const { db } = makeTaskDb([
      makeTaskRow({ id: "z-task", caseId: OTHER_CASE_ID, dueDate: "2026-07-10" }),
      makeTaskRow({ id: "b-task", caseId: CASE_ID, dueDate: "2026-07-10" }),
      makeTaskRow({ id: "a-task", caseId: CASE_ID, dueDate: "2026-07-10" }),
    ]);

    const items = await getUpcomingDeadlinesForCases([CASE_ID, OTHER_CASE_ID], 10, NOW, db);

    // CASE_ID (2222…) sorts before OTHER_CASE_ID (4444…); ids ascend within.
    expect(items.map((item) => item.id)).toEqual(["a-task", "b-task", "z-task"]);
  });
});
