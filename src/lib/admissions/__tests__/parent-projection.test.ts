import { beforeEach, describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the projection
// can be unit-tested without a real database. Every sibling data source is
// mocked and seeded with POISONED staff-only values — the tests then assert
// the serialized parent payload carries none of them (design §2.3 leak-test
// matrix, PRD success criterion 4). Only the case-header query runs against
// the fake chainable db below.
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/announcements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/announcements")>()),
  listAnnouncementsForCase: vi.fn(),
}));
vi.mock("@/lib/admissions/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/calendar")>()),
  getUpcomingDeadlines: vi.fn(),
}));
vi.mock("@/lib/admissions/checklists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/checklists")>()),
  computeProgress: vi.fn(),
}));
vi.mock("@/lib/admissions/colleges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/colleges")>()),
  listCollegesForCase: vi.fn(),
}));
vi.mock("@/lib/admissions/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/notes")>()),
  listNotesForRole: vi.fn(),
}));
vi.mock("@/lib/admissions/student-home", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/student-home")>()),
  getPhaseProgress: vi.fn(),
}));
vi.mock("@/lib/admissions/testing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/testing")>()),
  listSittingsForCase: vi.fn(),
}));

import {
  listAnnouncementsForCase,
  type AdmissionsAnnouncementDto,
} from "@/lib/admissions/announcements";
import { getUpcomingDeadlines, type CalendarItem } from "@/lib/admissions/calendar";
import { computeProgress } from "@/lib/admissions/checklists";
import {
  listCollegesForCase,
  type AdmissionsCollegeListRowDto,
} from "@/lib/admissions/colleges";
import { listNotesForRole } from "@/lib/admissions/notes";
import {
  buildParentDashboard,
  PARENT_ANNOUNCEMENTS_LIMIT,
  PARENT_UPCOMING_DEADLINES_LIMIT,
  type ParentDashboard,
} from "@/lib/admissions/parent-projection";
import {
  getPhaseProgress,
  type AdmissionsPhaseProgress,
} from "@/lib/admissions/student-home";
import {
  listSittingsForCase,
  type AdmissionsTestSittingDto,
} from "@/lib/admissions/testing";
import type { AdmissionsNoteDto } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";

// Bangkok noon on 2026-07-09 → todayKey "2026-07-09".
const NOW = new Date("2026-07-09T05:00:00Z");

// Poisoned staff-only values seeded through the mocks. The leak-test matrix
// asserts NONE of them survive into the serialized parent payload.
const POISON_STAFF_NOTE = "SECRET-STAFF-NOTE";
const POISON_AID_NOTES = "SECRET-AID-NOTES";
const POISON_AID_OFFERED = "987654.32";
const POISON_COUNSELOR_EMAIL = "secret.counselor@example.com";
const POISON_STUDENT_EMAIL = "student.secret@example.com";
const POISON_WISE_KEY = "WISE-KEY-SECRET";
const POISON_UNRELEASED_SCORE = "1590";
const POISON_TARGET_SCORE = "SECRET-TARGET-SCORE";
const POISON_ACCOMMODATIONS = "SECRET-ACCOMMODATIONS";
// The essays module (owner of counselorStage) is never queried by the
// projection; the value below sits in FORBIDDEN_VALUES so a future edit that
// wires essays into the parent payload trips the matrix.
const POISON_COUNSELOR_STAGE = "SECRET-COUNSELOR-STAGE";

const mockComputeProgress = vi.mocked(computeProgress);
const mockGetPhaseProgress = vi.mocked(getPhaseProgress);
const mockListCollegesForCase = vi.mocked(listCollegesForCase);
const mockGetUpcomingDeadlines = vi.mocked(getUpcomingDeadlines);
const mockListAnnouncementsForCase = vi.mocked(listAnnouncementsForCase);
const mockListSittingsForCase = vi.mocked(listSittingsForCase);
const mockListNotesForRole = vi.mocked(listNotesForRole);

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

/**
 * Case-header row as the projection's column-scoped select returns it —
 * deliberately FATTENED with poisoned extra columns to prove the projection
 * assembles field-by-field and never spreads a row.
 */
function poisonedHeaderRow(): Record<string, unknown> {
  return {
    status: "active",
    studentFullName: "Nong Prae",
    cohortName: "Class of 2027",
    wiseStudentKey: POISON_WISE_KEY,
    studentEmail: POISON_STUDENT_EMAIL,
  };
}

function collegeRow(
  overrides: Partial<AdmissionsCollegeListRowDto> = {},
): AdmissionsCollegeListRowDto {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    caseId: CASE_ID,
    unitId: 166027,
    instName: "Harvard University",
    city: "Cambridge",
    stateAbbr: "MA",
    country: "United States",
    isManual: false,
    round: "rea",
    deadline: "2026-11-01",
    appStatus: "applying",
    category: "reach",
    aidOffered: POISON_AID_OFFERED,
    aidNotes: POISON_AID_NOTES,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    stats: {
      dataYear: "2023-24",
      acceptanceRate: 3.4,
      totalPriceInState: 82866,
      avgNetPrice: 19491,
      gradRateBach6yr: 98,
    },
    stale: false,
    completeness: {
      recsAgreed: 1,
      recsSubmitted: 0,
      recsTotal: 2,
      transcriptSent: false,
      schoolReportSent: false,
      scoreSendsSent: 0,
      complete: false,
    },
    ...overrides,
  };
}

function calendarItem(overrides: Partial<CalendarItem> = {}): CalendarItem {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    caseId: CASE_ID,
    source: "task",
    title: "Submit each application before its deadline",
    date: "2026-07-15",
    overdue: false,
    ownerRole: "student",
    ...overrides,
  };
}

function announcement(
  overrides: Partial<AdmissionsAnnouncementDto> = {},
): AdmissionsAnnouncementDto {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    cohortId: "55555555-5555-4555-8555-555555555555",
    caseId: null,
    title: "Essay workshop this Saturday",
    body: "Bring your current personal statement draft.",
    authorEmail: POISON_COUNSELOR_EMAIL,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function sitting(
  overrides: Partial<AdmissionsTestSittingDto> = {},
): AdmissionsTestSittingDto {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    caseId: CASE_ID,
    testType: "sat",
    testDate: "2026-08-22",
    registrationDeadline: "2026-07-18",
    targetScore: POISON_TARGET_SCORE,
    actualScore: null,
    scoreReleasedToParent: false,
    accommodations: POISON_ACCOMMODATIONS,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function note(overrides: Partial<AdmissionsNoteDto> = {}): AdmissionsNoteDto {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    caseId: CASE_ID,
    authorEmail: POISON_COUNSELOR_EMAIL,
    body: "Great progress on the college list this week.",
    visibility: "shared_with_family",
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

function phaseRing(
  overrides: Partial<AdmissionsPhaseProgress> = {},
): AdmissionsPhaseProgress {
  return {
    phase: "about_you",
    label: "About You",
    done: 1,
    total: 2,
    percent: 50,
    verifiedCount: 1,
    ...overrides,
  };
}

/** Builds the dashboard with every source poisoned (leak-matrix fixture). */
async function buildPoisonedDashboard(): Promise<ParentDashboard> {
  mockComputeProgress.mockResolvedValue({ done: 3, total: 10, percent: 30, verifiedCount: 2 });
  mockGetPhaseProgress.mockResolvedValue([phaseRing()]);
  mockListCollegesForCase.mockResolvedValue([collegeRow()]);
  mockGetUpcomingDeadlines.mockResolvedValue([calendarItem()]);
  mockListAnnouncementsForCase.mockResolvedValue([announcement()]);
  mockListSittingsForCase.mockResolvedValue([
    // Unreleased score: the raw value must never serialize.
    sitting({ actualScore: POISON_UNRELEASED_SCORE, scoreReleasedToParent: false }),
  ]);
  mockListNotesForRole.mockResolvedValue([
    note(),
    // Poisoned staff-only note: even if the notes layer regressed and returned
    // it to a parent reader, the projection must drop it (defense in depth).
    note({
      id: "88888888-8888-4888-8888-888888888888",
      body: POISON_STAFF_NOTE,
      visibility: "staff_only",
    }),
  ]);
  const db = fakeDb([[poisonedHeaderRow()]]);
  return buildParentDashboard(CASE_ID, { now: NOW }, db as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockComputeProgress.mockResolvedValue({ done: 0, total: 0, percent: 0, verifiedCount: 0 });
  mockGetPhaseProgress.mockResolvedValue([]);
  mockListCollegesForCase.mockResolvedValue([]);
  mockGetUpcomingDeadlines.mockResolvedValue([]);
  mockListAnnouncementsForCase.mockResolvedValue([]);
  mockListSittingsForCase.mockResolvedValue([]);
  mockListNotesForRole.mockResolvedValue([]);
});

describe("buildParentDashboard", () => {
  it("assembles the closed DTO field-by-field from all sources", async () => {
    const dashboard = await buildPoisonedDashboard();

    expect(dashboard.studentName).toBe("Nong Prae");
    expect(dashboard.cohortName).toBe("Class of 2027");
    expect(dashboard.caseStatus).toBe("active");
    expect(dashboard.progress).toEqual({ done: 3, total: 10, percent: 30 });
    expect(dashboard.phaseProgress).toEqual([
      { phase: "about_you", label: "About You", done: 1, total: 2, percent: 50 },
    ]);
    expect(dashboard.collegeList).toEqual([
      {
        instName: "Harvard University",
        round: "rea",
        roundLabel: "REA",
        appStatus: "applying",
        deadline: "2026-11-01",
        category: "reach",
      },
    ]);
    expect(dashboard.upcomingDeadlines).toEqual([
      {
        source: "task",
        title: "Submit each application before its deadline",
        date: "2026-07-15",
        overdue: false,
      },
    ]);
    expect(dashboard.announcements).toEqual([
      {
        title: "Essay workshop this Saturday",
        body: "Bring your current personal statement draft.",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    expect(dashboard.testingMilestones).toEqual([
      {
        testType: "sat",
        testDate: "2026-08-22",
        registered: false,
        taken: false,
        scoreReceived: true,
      },
    ]);
    expect(dashboard.sharedNotes).toEqual([
      {
        body: "Great progress on the college list this week.",
        createdAt: "2026-07-05T00:00:00.000Z",
      },
    ]);

    expect(mockGetUpcomingDeadlines).toHaveBeenCalledWith(
      CASE_ID,
      PARENT_UPCOMING_DEADLINES_LIMIT,
      NOW,
      expect.anything(),
    );
    expect(mockListNotesForRole).toHaveBeenCalledWith(CASE_ID, "parent", expect.anything());
  });

  it("exposes exactly the documented key sets and nothing more", async () => {
    const dashboard = await buildPoisonedDashboard();

    expect(Object.keys(dashboard).sort()).toEqual([
      "announcements",
      "caseStatus",
      "cohortName",
      "collegeList",
      "phaseProgress",
      "progress",
      "sharedNotes",
      "studentName",
      "testingMilestones",
      "upcomingDeadlines",
    ]);
    expect(Object.keys(dashboard.progress).sort()).toEqual(["done", "percent", "total"]);
    expect(Object.keys(dashboard.phaseProgress[0]).sort()).toEqual([
      "done",
      "label",
      "percent",
      "phase",
      "total",
    ]);
    expect(Object.keys(dashboard.collegeList[0]).sort()).toEqual([
      "appStatus",
      "category",
      "deadline",
      "instName",
      "round",
      "roundLabel",
    ]);
    expect(Object.keys(dashboard.upcomingDeadlines[0]).sort()).toEqual([
      "date",
      "overdue",
      "source",
      "title",
    ]);
    expect(Object.keys(dashboard.announcements[0]).sort()).toEqual([
      "body",
      "createdAt",
      "title",
    ]);
    expect(Object.keys(dashboard.testingMilestones[0]).sort()).toEqual([
      "registered",
      "scoreReceived",
      "taken",
      "testDate",
      "testType",
    ]);
    expect(Object.keys(dashboard.sharedNotes[0]).sort()).toEqual(["body", "createdAt"]);
  });

  it("throws NotFound for a malformed caseId without touching any source", async () => {
    const db = fakeDb([]);

    await expect(
      buildParentDashboard("nope", { now: NOW }, db as never),
    ).rejects.toThrow("NotFound");
    expect(mockComputeProgress).not.toHaveBeenCalled();
    expect(mockListNotesForRole).not.toHaveBeenCalled();
  });

  it("throws NotFound when the case is missing or soft-deleted", async () => {
    const db = fakeDb([[]]);

    await expect(
      buildParentDashboard(CASE_ID, { now: NOW }, db as never),
    ).rejects.toThrow("NotFound");
  });

  it("caps announcements at the parent limit, newest first", async () => {
    mockListAnnouncementsForCase.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) =>
        announcement({
          id: `44444444-4444-4444-8444-4444444444${String(i).padStart(2, "0")}`,
          title: `Announcement ${i}`,
        }),
      ),
    );
    const db = fakeDb([[poisonedHeaderRow()]]);

    const dashboard = await buildParentDashboard(CASE_ID, { now: NOW }, db as never);

    expect(dashboard.announcements).toHaveLength(PARENT_ANNOUNCEMENTS_LIMIT);
    expect(dashboard.announcements[0].title).toBe("Announcement 0");
  });
});

describe("testing milestones (CM-83)", () => {
  async function milestonesFor(sittings: AdmissionsTestSittingDto[]) {
    mockListSittingsForCase.mockResolvedValue(sittings);
    const db = fakeDb([[poisonedHeaderRow()]]);
    const dashboard = await buildParentDashboard(CASE_ID, { now: NOW }, db as never);
    return dashboard.testingMilestones;
  }

  it("marks registered when the registration deadline passed or is absent", async () => {
    const milestones = await milestonesFor([
      sitting({ registrationDeadline: null }),
      sitting({ registrationDeadline: "2026-07-08" }),
      sitting({ registrationDeadline: "2026-07-09" }),
      sitting({ registrationDeadline: "2026-07-10" }),
    ]);

    expect(milestones.map((m) => m.registered)).toEqual([true, true, false, false]);
  });

  it("marks taken only when the test date is strictly before today (Bangkok)", async () => {
    const milestones = await milestonesFor([
      sitting({ testDate: "2026-07-08" }),
      sitting({ testDate: "2026-07-09" }),
      sitting({ testDate: "2026-07-10" }),
    ]);

    expect(milestones.map((m) => m.taken)).toEqual([true, false, false]);
  });

  it("attaches the numeric score ONLY when released; the key is omitted otherwise", async () => {
    const milestones = await milestonesFor([
      sitting({ actualScore: "1450", scoreReleasedToParent: true }),
      sitting({ actualScore: POISON_UNRELEASED_SCORE, scoreReleasedToParent: false }),
      sitting({ actualScore: null, scoreReleasedToParent: true }),
    ]);

    expect(milestones[0].score).toBe(1450);
    expect(milestones[0].scoreReceived).toBe(true);
    expect("score" in milestones[1]).toBe(false);
    expect(milestones[1].scoreReceived).toBe(true);
    expect("score" in milestones[2]).toBe(false);
    expect(milestones[2].scoreReceived).toBe(false);
  });

  it("omits the score key for released but non-numeric scores (fail-closed)", async () => {
    const milestones = await milestonesFor([
      sitting({ actualScore: "1450 (R720/M730)", scoreReleasedToParent: true }),
    ]);

    expect("score" in milestones[0]).toBe(false);
    expect(milestones[0].scoreReceived).toBe(true);
  });
});

describe("leak-test matrix (design §2.3, PRD success criterion 4)", () => {
  // Forbidden DTO keys: staff/internal fields that must never appear in a
  // serialized parent payload, asserted as `"key"` JSON-key substrings.
  const FORBIDDEN_KEYS = [
    "aidOffered",
    "aidNotes",
    "counselorStage",
    "completeness",
    "stats",
    "wiseStudentKey",
    "studentEmail",
    "authorEmail",
    "email",
    "actualScore",
    "targetScore",
    "accommodations",
    "scoreReleasedToParent",
    "verifiedCount",
    "verifiedByEmail",
    "verifiedAt",
    "visibility",
    "ownerRole",
    "unitId",
    "caseId",
    "id",
    "actorEmail",
    "actorRole",
    "diff",
  ];

  // Poisoned values seeded through the mocks; none may survive serialization.
  const FORBIDDEN_VALUES = [
    POISON_STAFF_NOTE,
    POISON_AID_NOTES,
    POISON_AID_OFFERED,
    POISON_COUNSELOR_EMAIL,
    POISON_STUDENT_EMAIL,
    POISON_WISE_KEY,
    POISON_UNRELEASED_SCORE,
    POISON_TARGET_SCORE,
    POISON_ACCOMMODATIONS,
    POISON_COUNSELOR_STAGE,
    "staff_only",
  ];

  it("serializes with zero forbidden keys", async () => {
    const serialized = JSON.stringify(await buildPoisonedDashboard());

    for (const key of FORBIDDEN_KEYS) {
      expect(serialized, `forbidden key leaked: ${key}`).not.toContain(`"${key}":`);
    }
  });

  it("serializes with zero poisoned values", async () => {
    const serialized = JSON.stringify(await buildPoisonedDashboard());

    for (const value of FORBIDDEN_VALUES) {
      expect(serialized, `poisoned value leaked: ${value}`).not.toContain(value);
    }
    // No email address of any kind survives (announcements/notes author
    // identity is dropped; member emails are never fetched).
    expect(serialized).not.toContain("@example.com");
  });

  it("drops staff_only note bodies even when the notes layer returns them", async () => {
    const dashboard = await buildPoisonedDashboard();

    expect(dashboard.sharedNotes).toHaveLength(1);
    expect(JSON.stringify(dashboard.sharedNotes)).not.toContain(POISON_STAFF_NOTE);
  });
});
