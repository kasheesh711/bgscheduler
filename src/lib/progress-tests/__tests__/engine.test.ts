import { describe, expect, it } from "vitest";
import { PROGRESS_TEST_COUNTING_START } from "../config";
import {
  computeEnrollmentCycle,
  computeProgressTestStates,
  isAttendedWithCredit,
  resolveCycleStart,
  type ProgressTestCycleStateInput,
  type ProgressTestEnrollmentInput,
  type ProgressTestLedgerRow,
} from "../engine";

const ENROLLMENT_KEY = "class-1|student-1";

/** Builds a counted attended-with-credit ledger row with sane defaults. */
function ledgerRow(overrides: Partial<ProgressTestLedgerRow> = {}): ProgressTestLedgerRow {
  return {
    enrollmentKey: ENROLLMENT_KEY,
    wiseSessionId: `session-${Math.random().toString(36).slice(2)}`,
    wiseStudentId: "student-1",
    wiseClassId: "class-1",
    scheduledStartTime: new Date("2026-03-15T03:00:00+07:00"),
    creditApplied: 1,
    meetingStatus: "ENDED",
    sessionKind: "past",
    isProgressTest: false,
    countsTowardCycle: true,
    tutorCanonicalKey: "celeste",
    ...overrides,
  };
}

/** Builds N counted rows spaced one day apart, all inside the window. */
function attendedRows(count: number, start = "2026-03-10T03:00:00+07:00"): ProgressTestLedgerRow[] {
  const base = new Date(start).getTime();
  return Array.from({ length: count }, (_, index) =>
    ledgerRow({
      wiseSessionId: `session-${index}`,
      scheduledStartTime: new Date(base + index * 24 * 60 * 60 * 1000),
    }),
  );
}

function enrollment(
  ledgerRows: ProgressTestLedgerRow[],
  cycleState: ProgressTestCycleStateInput | null = null,
): ProgressTestEnrollmentInput {
  return { enrollmentKey: ENROLLMENT_KEY, ledgerRows, cycleState };
}

describe("isAttendedWithCredit", () => {
  it("accepts ENDED past sessions with positive credit", () => {
    expect(isAttendedWithCredit({ meetingStatus: "ended", creditApplied: 1, sessionKind: "past" })).toBe(true);
  });

  it("rejects rows missing any condition", () => {
    expect(isAttendedWithCredit({ meetingStatus: "CANCELLED", creditApplied: 1, sessionKind: "past" })).toBe(false);
    expect(isAttendedWithCredit({ meetingStatus: "ENDED", creditApplied: 0, sessionKind: "past" })).toBe(false);
    expect(isAttendedWithCredit({ meetingStatus: "ENDED", creditApplied: 1, sessionKind: "future" })).toBe(false);
  });
});

describe("resolveCycleStart", () => {
  it("returns the counting-window start when there is no prior test", () => {
    expect(resolveCycleStart(null).getTime()).toBe(PROGRESS_TEST_COUNTING_START.getTime());
  });

  it("returns the later of the window start and the last completed test", () => {
    const later = new Date("2026-05-01T00:00:00+07:00");
    expect(resolveCycleStart(later).getTime()).toBe(later.getTime());
    const earlier = new Date("2026-01-01T00:00:00+07:00");
    expect(resolveCycleStart(earlier).getTime()).toBe(PROGRESS_TEST_COUNTING_START.getTime());
  });
});

describe("computeEnrollmentCycle", () => {
  const now = new Date("2026-06-01T03:00:00+07:00");

  it("counts only classes on or after 2026-03-01", () => {
    const rows = [
      ledgerRow({ wiseSessionId: "old-1", scheduledStartTime: new Date("2026-02-20T03:00:00+07:00") }),
      ledgerRow({ wiseSessionId: "old-2", scheduledStartTime: new Date("2026-02-28T23:59:00+07:00") }),
      ledgerRow({ wiseSessionId: "in-1", scheduledStartTime: new Date("2026-03-01T00:00:00+07:00") }),
      ledgerRow({ wiseSessionId: "in-2", scheduledStartTime: new Date("2026-03-05T03:00:00+07:00") }),
    ];
    const outcome = computeEnrollmentCycle(enrollment(rows), now);
    expect(outcome.currentCount).toBe(2);
    expect(outcome.status).toBe("accumulating");
    expect(outcome.cycleResetTriggered).toBe(false);
  });

  it("excludes the booked progress-test session by id and any isProgressTest row", () => {
    const rows = [
      ...attendedRows(5),
      ledgerRow({ wiseSessionId: "booked-test", scheduledStartTime: new Date("2026-04-01T03:00:00+07:00") }),
      ledgerRow({ wiseSessionId: "flagged-test", isProgressTest: true, scheduledStartTime: new Date("2026-04-02T03:00:00+07:00") }),
    ];
    const cycleState: ProgressTestCycleStateInput = {
      enrollmentKey: ENROLLMENT_KEY,
      cycleIndex: 0,
      currentCycleStart: null,
      bookedTestWiseSessionId: "booked-test",
      // Future booked date so this is the scheduled branch, not a reset.
      bookedTestDate: new Date("2026-09-01T03:00:00+07:00"),
      teacherNotifiedForCycle: 0,
    };
    const outcome = computeEnrollmentCycle(enrollment(rows, cycleState), now);
    // 5 real classes; booked-test and flagged-test both excluded.
    expect(outcome.currentCount).toBe(5);
    expect(outcome.status).toBe("scheduled");
  });

  it("marks an enrollment due at the threshold of 8", () => {
    const outcome = computeEnrollmentCycle(enrollment(attendedRows(8)), now);
    expect(outcome.currentCount).toBe(8);
    expect(outcome.status).toBe("due");
    expect(outcome.shouldNotifyTeacher).toBe(false);
  });

  it("marks an enrollment approaching at 6 and flags the teacher notification", () => {
    const outcome = computeEnrollmentCycle(enrollment(attendedRows(6)), now);
    expect(outcome.currentCount).toBe(6);
    expect(outcome.status).toBe("approaching");
    expect(outcome.shouldNotifyTeacher).toBe(true);
  });

  it("does not re-notify the teacher once notified for the same cycle", () => {
    const cycleState: ProgressTestCycleStateInput = {
      enrollmentKey: ENROLLMENT_KEY,
      cycleIndex: 0,
      currentCycleStart: null,
      bookedTestWiseSessionId: null,
      bookedTestDate: null,
      teacherNotifiedForCycle: 0,
    };
    const outcome = computeEnrollmentCycle(enrollment(attendedRows(6), cycleState), now);
    expect(outcome.status).toBe("approaching");
    expect(outcome.shouldNotifyTeacher).toBe(false);
  });

  it("is scheduled when a test is booked in the future", () => {
    const cycleState: ProgressTestCycleStateInput = {
      enrollmentKey: ENROLLMENT_KEY,
      cycleIndex: 0,
      currentCycleStart: null,
      bookedTestWiseSessionId: "booked-test",
      bookedTestDate: new Date("2026-09-01T03:00:00+07:00"),
      teacherNotifiedForCycle: 0,
    };
    const outcome = computeEnrollmentCycle(enrollment(attendedRows(8), cycleState), now);
    expect(outcome.status).toBe("scheduled");
    expect(outcome.cycleResetTriggered).toBe(false);
  });

  it("resets the cycle once the booked test date passes and recounts the next cycle", () => {
    const testDate = new Date("2026-05-01T03:00:00+07:00");
    // 8 classes before the test (counted in the prior cycle), 3 after it.
    const beforeTest = attendedRows(8, "2026-03-10T03:00:00+07:00");
    const afterTest = [
      ledgerRow({ wiseSessionId: "after-1", scheduledStartTime: new Date("2026-05-05T03:00:00+07:00") }),
      ledgerRow({ wiseSessionId: "after-2", scheduledStartTime: new Date("2026-05-12T03:00:00+07:00") }),
      ledgerRow({ wiseSessionId: "after-3", scheduledStartTime: new Date("2026-05-19T03:00:00+07:00") }),
    ];
    const cycleState: ProgressTestCycleStateInput = {
      enrollmentKey: ENROLLMENT_KEY,
      cycleIndex: 0,
      currentCycleStart: null,
      bookedTestWiseSessionId: "booked-test",
      bookedTestDate: testDate,
      teacherNotifiedForCycle: 0,
    };
    const outcome = computeEnrollmentCycle(enrollment([...beforeTest, ...afterTest], cycleState), now);
    expect(outcome.cycleResetTriggered).toBe(true);
    expect(outcome.status).toBe("completed");
    expect(outcome.cycleIndex).toBe(1);
    expect(outcome.currentCycleStart.getTime()).toBe(testDate.getTime());
    // Only the 3 post-test classes count toward the new cycle.
    expect(outcome.currentCount).toBe(3);
  });
});

describe("computeProgressTestStates", () => {
  const now = new Date("2026-06-01T03:00:00+07:00");

  it("returns a per-enrollment result plus issues for unresolved teachers", () => {
    const resolved = enrollment(attendedRows(6));
    const unresolved: ProgressTestEnrollmentInput = {
      enrollmentKey: "class-2|student-2",
      ledgerRows: attendedRows(3, "2026-03-12T03:00:00+07:00").map((row) => ({
        ...row,
        enrollmentKey: "class-2|student-2",
        tutorCanonicalKey: null,
      })),
      cycleState: null,
    };

    const { result, issues } = computeProgressTestStates({
      enrollments: [resolved, unresolved],
      now,
    });

    expect(result).toHaveLength(2);
    expect(result.find((row) => row.enrollmentKey === ENROLLMENT_KEY)?.status).toBe("approaching");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ type: "unresolved-teacher", enrollmentKey: "class-2|student-2" });
  });

  it("emits no issue when counted rows have a resolved teacher", () => {
    const { issues } = computeProgressTestStates({ enrollments: [enrollment(attendedRows(2))], now });
    expect(issues).toHaveLength(0);
  });
});
