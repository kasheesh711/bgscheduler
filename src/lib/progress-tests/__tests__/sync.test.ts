import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Database } from "@/lib/db";
import type { WiseClient } from "@/lib/wise/client";
import type { WiseSession, WiseTeacher } from "@/lib/wise/types";
import { PROGRESS_TEST_COUNTING_START } from "@/lib/progress-tests/config";
import type {
  CreditControlAttendedSession,
  ProgressTestCycleStateInsert,
  ProgressTestCycleStateRecord,
  ProgressTestLedgerInsert,
  ProgressTestLedgerRecord,
} from "@/lib/progress-tests/db";
import {
  appendLedgerRows,
  loadActiveCreditControlSnapshotSessions,
  loadActiveIdentityEntries,
  loadCycleStates,
  loadFeedbackNotesByEnrollment,
  loadLedgerByEnrollment,
  storeCycleAiSummary,
  upsertCycleState,
} from "@/lib/progress-tests/db";
import { fetchAllTeachers } from "@/lib/wise/fetchers";
import { generateProgressTestSummary } from "@/lib/progress-tests/ai-summary";
import { runTeacherHeadsUpNotifications } from "@/lib/progress-tests/teacher-heads-up";
import {
  buildSessionTeacherMap,
  computeMostFrequentTutor,
  runProgressTestSync,
} from "@/lib/progress-tests/sync";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/wise/fetchers", () => ({ fetchAllTeachers: vi.fn() }));
vi.mock("@/lib/progress-tests/db", () => ({
  loadActiveCreditControlSnapshotSessions: vi.fn(),
  loadActiveIdentityEntries: vi.fn(),
  appendLedgerRows: vi.fn(),
  loadLedgerByEnrollment: vi.fn(),
  loadCycleStates: vi.fn(),
  loadFeedbackNotesByEnrollment: vi.fn(),
  storeCycleAiSummary: vi.fn(),
  upsertCycleState: vi.fn(),
}));
vi.mock("@/lib/progress-tests/ai-summary", () => ({ generateProgressTestSummary: vi.fn() }));
vi.mock("@/lib/progress-tests/teacher-heads-up", () => ({ runTeacherHeadsUpNotifications: vi.fn() }));

// ── Builders ────────────────────────────────────────────────────────────

const START_MS = PROGRESS_TEST_COUNTING_START.getTime();

function dayAfterStart(days: number): Date {
  return new Date(START_MS + days * 24 * 60 * 60 * 1000);
}

function fakeClient(): WiseClient {
  return { get: vi.fn().mockResolvedValue({ data: { sessions: [], page_count: 1 } }) } as unknown as WiseClient;
}

function makeAttendedSession(
  overrides: Partial<CreditControlAttendedSession> & Pick<CreditControlAttendedSession, "wiseSessionId">,
): CreditControlAttendedSession {
  return {
    wiseClassId: "class-1",
    wiseStudentId: "student-1",
    studentKey: "ada|parent",
    studentName: "Ada Lovelace",
    subject: "Math",
    scheduledStartTime: dayAfterStart(1),
    creditApplied: 1,
    meetingStatus: "ENDED",
    ...overrides,
  };
}

function makeLedgerRecord(
  overrides: Partial<ProgressTestLedgerRecord> & Pick<ProgressTestLedgerRecord, "wiseSessionId">,
): ProgressTestLedgerRecord {
  return {
    id: `ledger-${overrides.wiseSessionId}`,
    enrollmentKey: "class-1|student-1",
    wiseClassId: "class-1",
    wiseStudentId: "student-1",
    studentKey: "ada|parent",
    studentName: "Ada Lovelace",
    subject: "Math",
    scheduledStartTime: dayAfterStart(1),
    creditApplied: 1,
    meetingStatus: "ENDED",
    wiseTeacherUserId: "user-a",
    wiseTeacherId: "teacher-a",
    tutorCanonicalKey: "alice",
    tutorDisplayName: "Alice",
    isProgressTest: false,
    countsTowardCycle: true,
    firstObservedSnapshotId: null,
    capturedAt: dayAfterStart(1),
    updatedAt: dayAfterStart(1),
    ...overrides,
  };
}

function makeCycleStateRecord(
  overrides: Partial<ProgressTestCycleStateRecord>,
): ProgressTestCycleStateRecord {
  return {
    enrollmentKey: "class-1|student-1",
    wiseStudentId: "student-1",
    wiseClassId: "class-1",
    studentKey: "ada|parent",
    studentName: "Ada Lovelace",
    subject: "Math",
    currentCount: 0,
    currentCycleStart: PROGRESS_TEST_COUNTING_START,
    cycleIndex: 0,
    status: "accumulating",
    bookedTestWiseSessionId: null,
    bookedTestDate: null,
    bookedTestBookingMode: null,
    scheduleMethod: null,
    bookedTestLocation: null,
    atHomeSelectedAt: null,
    atHomeSubmittedAt: null,
    teacherNotifiedAt: null,
    teacherNotifiedForCycle: null,
    mostFrequentTutorCanonicalKey: null,
    mostFrequentTutorDisplayName: null,
    lastAiSummary: null,
    lastAiSummaryAt: null,
    lastClassDate: null,
    updatedByEmail: null,
    updatedAt: PROGRESS_TEST_COUNTING_START,
    ...overrides,
  };
}

function finalizingDb(): Database {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  } as unknown as Database;
}

const loadSessionsMock = loadActiveCreditControlSnapshotSessions as unknown as Mock;
const loadIdentitiesMock = loadActiveIdentityEntries as unknown as Mock;
const appendLedgerMock = appendLedgerRows as unknown as Mock;
const loadLedgerMock = loadLedgerByEnrollment as unknown as Mock;
const loadCycleStatesMock = loadCycleStates as unknown as Mock;
const loadFeedbackNotesMock = loadFeedbackNotesByEnrollment as unknown as Mock;
const storeCycleAiSummaryMock = storeCycleAiSummary as unknown as Mock;
const upsertCycleStateMock = upsertCycleState as unknown as Mock;
const fetchTeachersMock = fetchAllTeachers as unknown as Mock;
const generateSummaryMock = generateProgressTestSummary as unknown as Mock;
const runHeadsUpMock = runTeacherHeadsUpNotifications as unknown as Mock;

describe("runProgressTestSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchTeachersMock.mockResolvedValue([]);
    loadSessionsMock.mockResolvedValue([]);
    loadIdentitiesMock.mockResolvedValue([]);
    loadCycleStatesMock.mockResolvedValue(new Map());
    loadLedgerMock.mockResolvedValue(new Map());
    appendLedgerMock.mockResolvedValue(undefined);
    upsertCycleStateMock.mockResolvedValue(undefined);
    loadFeedbackNotesMock.mockResolvedValue(new Map());
    storeCycleAiSummaryMock.mockResolvedValue(undefined);
    generateSummaryMock.mockResolvedValue({ status: "skipped", reason: "not configured" });
    runHeadsUpMock.mockResolvedValue({ attempted: 0, sent: 0, failed: 0, unresolved: 0, outcomes: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("upserts one idempotent ledger row per attended session (dedup is the unique index)", async () => {
    loadSessionsMock.mockResolvedValue([
      makeAttendedSession({ wiseSessionId: "s1" }),
      makeAttendedSession({ wiseSessionId: "s2", scheduledStartTime: dayAfterStart(2) }),
    ]);

    const result = await runProgressTestSync({
      db: finalizingDb(),
      client: fakeClient(),
      instituteId: "institute-1",
      now: dayAfterStart(10),
      syncRunId: "run-1",
    });

    expect(result.success).toBe(true);
    expect(result.ledgerRowCount).toBe(2);
    expect(appendLedgerMock).toHaveBeenCalledTimes(1);
    const rows = appendLedgerMock.mock.calls[0][0] as ProgressTestLedgerInsert[];
    expect(rows.map((row) => row.wiseSessionId)).toEqual(["s1", "s2"]);
    expect(rows.every((row) => row.enrollmentKey === "class-1|student-1")).toBe(true);
    // Idempotent: a re-run with the same source produces byte-identical upsert rows.
    appendLedgerMock.mockClear();
    await runProgressTestSync({
      db: finalizingDb(),
      client: fakeClient(),
      instituteId: "institute-1",
      now: dayAfterStart(10),
      syncRunId: "run-2",
    });
    const rerunRows = appendLedgerMock.mock.calls[0][0] as ProgressTestLedgerInsert[];
    expect(rerunRows).toEqual(rows);
  });

  it("flags the booked-test session row isProgressTest from prior cycle state", async () => {
    loadSessionsMock.mockResolvedValue([
      makeAttendedSession({ wiseSessionId: "s1" }),
      makeAttendedSession({ wiseSessionId: "booked-test", scheduledStartTime: dayAfterStart(9) }),
    ]);
    loadCycleStatesMock.mockResolvedValue(
      new Map([[
        "class-1|student-1",
        makeCycleStateRecord({ bookedTestWiseSessionId: "booked-test" }),
      ]]),
    );

    await runProgressTestSync({
      db: finalizingDb(),
      client: fakeClient(),
      instituteId: "institute-1",
      now: dayAfterStart(10),
      syncRunId: "run-1",
    });

    const rows = appendLedgerMock.mock.calls[0][0] as ProgressTestLedgerInsert[];
    expect(rows.find((row) => row.wiseSessionId === "s1")?.isProgressTest).toBe(false);
    expect(rows.find((row) => row.wiseSessionId === "booked-test")?.isProgressTest).toBe(true);
  });

  it("resolves teacher identity from the active Wise snapshot (payroll recipe)", async () => {
    loadSessionsMock.mockResolvedValue([makeAttendedSession({ wiseSessionId: "s1" })]);
    fetchTeachersMock.mockResolvedValue([
      { _id: "teacher-a", userId: { _id: "user-a", name: "Alice Teacher" } } as WiseTeacher,
    ]);
    loadIdentitiesMock.mockResolvedValue([
      { wiseTeacherId: "teacher-a", wiseUserId: "user-a", canonicalKey: "alice", displayName: "Alice" },
    ]);
    const client = {
      get: vi.fn().mockResolvedValue({
        data: {
          sessions: [{ _id: "s1", userId: "user-a", scheduledStartTime: dayAfterStart(1).toISOString(), scheduledEndTime: dayAfterStart(1).toISOString() }],
          page_count: 1,
        },
      }),
    } as unknown as WiseClient;

    await runProgressTestSync({
      db: finalizingDb(),
      client,
      instituteId: "institute-1",
      now: dayAfterStart(10),
      syncRunId: "run-1",
    });

    const rows = appendLedgerMock.mock.calls[0][0] as ProgressTestLedgerInsert[];
    const row = rows.find((candidate) => candidate.wiseSessionId === "s1");
    expect(row?.tutorCanonicalKey).toBe("alice");
    expect(row?.tutorDisplayName).toBe("Alice");
    expect(row?.wiseTeacherUserId).toBe("user-a");
    expect(row?.wiseTeacherId).toBe("teacher-a");
  });

  it("leaves teacher identity null and surfaces an unresolved-teacher count when the session has no match", async () => {
    loadSessionsMock.mockResolvedValue([makeAttendedSession({ wiseSessionId: "s1" })]);
    loadLedgerMock.mockResolvedValue(
      new Map([[
        "class-1|student-1",
        [makeLedgerRecord({ wiseSessionId: "s1", tutorCanonicalKey: null, tutorDisplayName: null })],
      ]]),
    );

    const result = await runProgressTestSync({
      db: finalizingDb(),
      client: fakeClient(),
      instituteId: "institute-1",
      now: dayAfterStart(10),
      syncRunId: "run-1",
    });

    const rows = appendLedgerMock.mock.calls[0][0] as ProgressTestLedgerInsert[];
    expect(rows[0].tutorCanonicalKey).toBeNull();
    expect(result.unresolvedTeacherCount).toBe(1);
  });

  it("rolls the cycle over when the booked test date has passed", async () => {
    const ledger = Array.from({ length: 8 }, (_, index) =>
      makeLedgerRecord({ wiseSessionId: `s${index}`, scheduledStartTime: dayAfterStart(index + 1) }),
    );
    loadLedgerMock.mockResolvedValue(new Map([["class-1|student-1", ledger]]));
    loadCycleStatesMock.mockResolvedValue(
      new Map([[
        "class-1|student-1",
        makeCycleStateRecord({
          cycleIndex: 0,
          currentCount: 8,
          status: "scheduled",
          bookedTestWiseSessionId: "booked-test",
          bookedTestDate: dayAfterStart(9),
          teacherNotifiedForCycle: 0,
        }),
      ]]),
    );

    await runProgressTestSync({
      db: finalizingDb(),
      client: fakeClient(),
      instituteId: "institute-1",
      now: dayAfterStart(20), // now > bookedTestDate → reset
      syncRunId: "run-1",
    });

    expect(upsertCycleStateMock).toHaveBeenCalledTimes(1);
    const upserted = upsertCycleStateMock.mock.calls[0][0] as ProgressTestCycleStateInsert;
    expect(upserted.cycleIndex).toBe(1);
    expect(upserted.status).toBe("completed");
    expect(upserted.currentCycleStart).toEqual(dayAfterStart(9));
    expect(upserted.bookedTestWiseSessionId).toBeNull();
    expect(upserted.bookedTestDate).toBeNull();
    expect(upserted.teacherNotifiedForCycle).toBeNull();
    // After reset the cycle floor advances past every prior class → fresh count 0.
    expect(upserted.currentCount).toBe(0);
  });

  it("records due and approaching counts on the result", async () => {
    const dueLedger = Array.from({ length: 8 }, (_, index) =>
      makeLedgerRecord({
        wiseSessionId: `due-${index}`,
        enrollmentKey: "class-1|student-due",
        wiseStudentId: "student-due",
        scheduledStartTime: dayAfterStart(index + 1),
      }),
    );
    const approachingLedger = Array.from({ length: 6 }, (_, index) =>
      makeLedgerRecord({
        wiseSessionId: `appr-${index}`,
        enrollmentKey: "class-2|student-appr",
        wiseClassId: "class-2",
        wiseStudentId: "student-appr",
        scheduledStartTime: dayAfterStart(index + 1),
      }),
    );
    loadLedgerMock.mockResolvedValue(new Map([
      ["class-1|student-due", dueLedger],
      ["class-2|student-appr", approachingLedger],
    ]));
    // Tracked cycles (not first observation) so the count-based state machine
    // reaches "due" at position 8 and "approaching" at position 6.
    loadCycleStatesMock.mockResolvedValue(new Map([
      ["class-1|student-due", makeCycleStateRecord({ enrollmentKey: "class-1|student-due", wiseStudentId: "student-due", cycleIndex: 0 })],
      ["class-2|student-appr", makeCycleStateRecord({ enrollmentKey: "class-2|student-appr", wiseClassId: "class-2", wiseStudentId: "student-appr", cycleIndex: 0 })],
    ]));

    const result = await runProgressTestSync({
      db: finalizingDb(),
      client: fakeClient(),
      instituteId: "institute-1",
      now: dayAfterStart(20),
      syncRunId: "run-1",
    });

    expect(result.dueCount).toBe(1);
    expect(result.approachingCount).toBe(1);
    expect(result.enrollmentCount).toBe(2);
  });

  it("fires the teacher heads-up step for a newly-approaching enrollment with its AI summary", async () => {
    const approachingLedger = Array.from({ length: 6 }, (_, index) =>
      makeLedgerRecord({
        wiseSessionId: `appr-${index}`,
        enrollmentKey: "class-1|student-1",
        scheduledStartTime: dayAfterStart(index + 1),
        tutorCanonicalKey: "alice",
        tutorDisplayName: "Alice",
      }),
    );
    loadLedgerMock.mockResolvedValue(new Map([["class-1|student-1", approachingLedger]]));
    // Tracked cycle (not first observation) so reaching position 6 fires the heads-up.
    loadCycleStatesMock.mockResolvedValue(new Map([
      ["class-1|student-1", makeCycleStateRecord({ cycleIndex: 0, teacherNotifiedForCycle: null })],
    ]));
    generateSummaryMock.mockResolvedValue({
      status: "ok",
      summary: { headline: "h", strengths: [], focusAreas: [], recommendation: "r" },
      model: "gpt-5.4-mini",
      sessionsUsed: 6,
    });

    const result = await runProgressTestSync({
      db: finalizingDb(),
      client: fakeClient(),
      instituteId: "institute-1",
      now: dayAfterStart(20),
      syncRunId: "run-1",
    });

    expect(result.success).toBe(true);
    // The AI summary is generated for the approaching enrollment and stored on cycle state.
    expect(generateSummaryMock).toHaveBeenCalledTimes(1);
    expect(storeCycleAiSummaryMock).toHaveBeenCalledWith(
      "class-1|student-1",
      { headline: "h", strengths: [], focusAreas: [], recommendation: "r" },
      expect.any(Date),
      expect.anything(),
    );
    // The heads-up sender is invoked with the resolved tutor + summary.
    expect(runHeadsUpMock).toHaveBeenCalledTimes(1);
    const headsUpArgs = runHeadsUpMock.mock.calls[0][1];
    expect(headsUpArgs.syncRunId).toBe("run-1");
    expect(headsUpArgs.enrollments).toHaveLength(1);
    expect(headsUpArgs.enrollments[0]).toMatchObject({
      enrollmentKey: "class-1|student-1",
      cycleIndex: 0,
      currentCount: 6,
      mostFrequentTutorCanonicalKey: "alice",
      mostFrequentTutorDisplayName: "Alice",
    });
    expect(headsUpArgs.enrollments[0].aiSummary).toEqual({
      headline: "h",
      strengths: [],
      focusAreas: [],
      recommendation: "r",
    });
  });

  it("does NOT re-notify an enrollment already notified for the current cycle", async () => {
    const approachingLedger = Array.from({ length: 6 }, (_, index) =>
      makeLedgerRecord({ wiseSessionId: `appr-${index}`, scheduledStartTime: dayAfterStart(index + 1) }),
    );
    loadLedgerMock.mockResolvedValue(new Map([["class-1|student-1", approachingLedger]]));
    // Prior state already records a heads-up sent for cycle 0 → engine clears shouldNotifyTeacher.
    loadCycleStatesMock.mockResolvedValue(
      new Map([["class-1|student-1", makeCycleStateRecord({ cycleIndex: 0, teacherNotifiedForCycle: 0 })]]),
    );

    await runProgressTestSync({
      db: finalizingDb(),
      client: fakeClient(),
      instituteId: "institute-1",
      now: dayAfterStart(20),
      syncRunId: "run-1",
    });

    // No second heads-up: re-running the sync sends nothing new for this cycle.
    expect(runHeadsUpMock).not.toHaveBeenCalled();
    expect(generateSummaryMock).not.toHaveBeenCalled();
  });

  it("is fail-isolated: a throwing heads-up step does not fail the sync run", async () => {
    const approachingLedger = Array.from({ length: 6 }, (_, index) =>
      makeLedgerRecord({ wiseSessionId: `appr-${index}`, scheduledStartTime: dayAfterStart(index + 1) }),
    );
    loadLedgerMock.mockResolvedValue(new Map([["class-1|student-1", approachingLedger]]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runHeadsUpMock.mockRejectedValue(new Error("email provider down"));

    const result = await runProgressTestSync({
      db: finalizingDb(),
      client: fakeClient(),
      instituteId: "institute-1",
      now: dayAfterStart(20),
      syncRunId: "run-1",
    });

    expect(result.success).toBe(true);
    expect(result.notificationCount).toBe(0);
    expect(result.approachingCount).toBe(1);
    errorSpy.mockRestore();
  });

  it("fails the run row (not the process) when a step throws", async () => {
    loadSessionsMock.mockRejectedValue(new Error("credit snapshot read failed"));

    const result = await runProgressTestSync({
      db: finalizingDb(),
      client: fakeClient(),
      instituteId: "institute-1",
      now: dayAfterStart(10),
      syncRunId: "run-1",
    });

    expect(result.success).toBe(false);
    expect(result.errorSummary).toContain("credit snapshot read failed");
    expect(upsertCycleStateMock).not.toHaveBeenCalled();
  });
});

describe("computeMostFrequentTutor", () => {
  it("returns the most frequent tutor, breaking ties toward the most recent class", () => {
    const records = [
      makeLedgerRecord({ wiseSessionId: "a1", tutorCanonicalKey: "alice", tutorDisplayName: "Alice", scheduledStartTime: dayAfterStart(1) }),
      makeLedgerRecord({ wiseSessionId: "b1", tutorCanonicalKey: "bob", tutorDisplayName: "Bob", scheduledStartTime: dayAfterStart(2) }),
      makeLedgerRecord({ wiseSessionId: "b2", tutorCanonicalKey: "bob", tutorDisplayName: "Bob", scheduledStartTime: dayAfterStart(5) }),
      makeLedgerRecord({ wiseSessionId: "a2", tutorCanonicalKey: "alice", tutorDisplayName: "Alice", scheduledStartTime: dayAfterStart(3) }),
    ];
    expect(computeMostFrequentTutor(records, PROGRESS_TEST_COUNTING_START)).toEqual({
      canonicalKey: "bob",
      displayName: "Bob",
    });
  });

  it("breaks a frequency tie toward the tutor of the most recent class", () => {
    const records = [
      makeLedgerRecord({ wiseSessionId: "a1", tutorCanonicalKey: "alice", tutorDisplayName: "Alice", scheduledStartTime: dayAfterStart(1) }),
      makeLedgerRecord({ wiseSessionId: "b1", tutorCanonicalKey: "bob", tutorDisplayName: "Bob", scheduledStartTime: dayAfterStart(4) }),
    ];
    expect(computeMostFrequentTutor(records, PROGRESS_TEST_COUNTING_START)).toEqual({
      canonicalKey: "bob",
      displayName: "Bob",
    });
  });

  it("ignores unresolved-tutor and progress-test rows", () => {
    const records = [
      makeLedgerRecord({ wiseSessionId: "x", tutorCanonicalKey: null, scheduledStartTime: dayAfterStart(9) }),
      makeLedgerRecord({ wiseSessionId: "pt", tutorCanonicalKey: "carol", tutorDisplayName: "Carol", isProgressTest: true, scheduledStartTime: dayAfterStart(8) }),
      makeLedgerRecord({ wiseSessionId: "a1", tutorCanonicalKey: "alice", tutorDisplayName: "Alice", scheduledStartTime: dayAfterStart(1) }),
    ];
    expect(computeMostFrequentTutor(records, PROGRESS_TEST_COUNTING_START)).toEqual({
      canonicalKey: "alice",
      displayName: "Alice",
    });
  });
});

describe("buildSessionTeacherMap", () => {
  it("resolves by user id first, then by teacher id, leaving unknowns null", () => {
    const sessions: WiseSession[] = [
      { _id: "by-user", userId: "user-a", scheduledStartTime: "", scheduledEndTime: "" },
      { _id: "by-teacher", teacherId: "teacher-b", scheduledStartTime: "", scheduledEndTime: "" },
      { _id: "unknown", userId: "ghost", scheduledStartTime: "", scheduledEndTime: "" },
    ];
    const teachers: WiseTeacher[] = [
      { _id: "teacher-a", userId: { _id: "user-a", name: "Alice" } },
      { _id: "teacher-b", userId: { _id: "user-b", name: "Bob" } },
    ];
    const identities = [
      { wiseTeacherId: "teacher-a", wiseUserId: "user-a", canonicalKey: "alice", displayName: "Alice" },
      { wiseTeacherId: "teacher-b", wiseUserId: "user-b", canonicalKey: "bob", displayName: "Bob" },
    ];

    const map = buildSessionTeacherMap(sessions, teachers, identities);

    expect(map.get("by-user")).toMatchObject({ tutorCanonicalKey: "alice", wiseTeacherUserId: "user-a", wiseTeacherId: "teacher-a" });
    expect(map.get("by-teacher")).toMatchObject({ tutorCanonicalKey: "bob", wiseTeacherId: "teacher-b" });
    expect(map.get("unknown")).toMatchObject({ tutorCanonicalKey: null, tutorDisplayName: null });
  });
});
