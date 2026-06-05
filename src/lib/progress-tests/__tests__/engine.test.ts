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

function cycleState(overrides: Partial<ProgressTestCycleStateInput> = {}): ProgressTestCycleStateInput {
  return {
    enrollmentKey: ENROLLMENT_KEY,
    cycleIndex: 0,
    currentCycleStart: null,
    bookedTestWiseSessionId: null,
    bookedTestDate: null,
    teacherNotifiedForCycle: null,
    atHomeSelectedAt: null,
    atHomeSubmittedAt: null,
    ...overrides,
  };
}

function enrollment(
  ledgerRows: ProgressTestLedgerRow[],
  state: ProgressTestCycleStateInput | null = null,
): ProgressTestEnrollmentInput {
  return { enrollmentKey: ENROLLMENT_KEY, ledgerRows, cycleState: state };
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

describe("computeEnrollmentCycle — counting + window", () => {
  const now = new Date("2026-07-01T03:00:00+07:00");

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
    const state = cycleState({
      bookedTestWiseSessionId: "booked-test",
      bookedTestDate: new Date("2026-09-01T03:00:00+07:00"),
      teacherNotifiedForCycle: 0,
    });
    const outcome = computeEnrollmentCycle(enrollment(rows, state), now);
    // 5 real classes; booked-test and flagged-test both excluded.
    expect(outcome.currentCount).toBe(5);
    expect(outcome.status).toBe("scheduled");
  });
});

describe("computeEnrollmentCycle — fresh-start baseline (position in current block)", () => {
  const now = new Date("2026-07-01T03:00:00+07:00");

  it("shows a long-standing student's position within their current block of 8 (86 -> 6/8)", () => {
    const outcome = computeEnrollmentCycle(enrollment(attendedRows(86)), now);
    expect(outcome.currentCount).toBe(6); // 86 mod 8
    expect(outcome.cycleIndex).toBe(10); // floor(86 / 8) blocks assumed already tested
    expect(outcome.status).toBe("approaching");
    // First observation at/after the approaching mark suppresses the heads-up.
    expect(outcome.shouldNotifyTeacher).toBe(false);
  });

  it("treats a student at an exact multiple of 8 as up-to-date (88 -> 0/8, not due)", () => {
    const outcome = computeEnrollmentCycle(enrollment(attendedRows(88)), now);
    expect(outcome.currentCount).toBe(0);
    expect(outcome.cycleIndex).toBe(11);
    expect(outcome.status).toBe("accumulating");
  });

  it("is not due on first observation regardless of lifetime classes", () => {
    for (const n of [8, 16, 47, 63, 86]) {
      const outcome = computeEnrollmentCycle(enrollment(attendedRows(n)), now);
      expect(outcome.status).not.toBe("due");
    }
  });
});

describe("computeEnrollmentCycle — approaching + notifications", () => {
  const now = new Date("2026-07-01T03:00:00+07:00");

  it("flags a tracked enrollment reaching position 6 for the teacher heads-up", () => {
    // Tracked cycle (cycleIndex 0, not yet notified): 6 classes -> position 6.
    const outcome = computeEnrollmentCycle(
      enrollment(attendedRows(6), cycleState({ cycleIndex: 0, teacherNotifiedForCycle: null })),
      now,
    );
    expect(outcome.currentCount).toBe(6);
    expect(outcome.status).toBe("approaching");
    expect(outcome.shouldNotifyTeacher).toBe(true);
  });

  it("does not re-notify once notified for the same cycle", () => {
    const outcome = computeEnrollmentCycle(
      enrollment(attendedRows(6), cycleState({ cycleIndex: 0, teacherNotifiedForCycle: 0 })),
      now,
    );
    expect(outcome.status).toBe("approaching");
    expect(outcome.shouldNotifyTeacher).toBe(false);
  });
});

describe("computeEnrollmentCycle — due + scheduled + reset (going forward)", () => {
  const now = new Date("2026-07-01T03:00:00+07:00");

  it("marks due when the student completes a new block beyond the baseline", () => {
    // Baseline cycleIndex 0; 8 attended -> position 8 -> due.
    const outcome = computeEnrollmentCycle(enrollment(attendedRows(8), cycleState({ cycleIndex: 0 })), now);
    expect(outcome.currentCount).toBe(8);
    expect(outcome.status).toBe("due");
    expect(outcome.shouldNotifyTeacher).toBe(false);
  });

  it("caps the displayed position at 8 when a student is overdue", () => {
    // cycleIndex 0, 11 attended -> raw position 11 -> displayed 8/8, due.
    const outcome = computeEnrollmentCycle(enrollment(attendedRows(11), cycleState({ cycleIndex: 0 })), now);
    expect(outcome.currentCount).toBe(8);
    expect(outcome.status).toBe("due");
  });

  it("is scheduled when a test is booked in the future", () => {
    const state = cycleState({
      cycleIndex: 0,
      bookedTestWiseSessionId: "booked-test",
      bookedTestDate: new Date("2026-09-01T03:00:00+07:00"),
    });
    const outcome = computeEnrollmentCycle(enrollment(attendedRows(8), state), now);
    expect(outcome.status).toBe("scheduled");
    expect(outcome.cycleResetTriggered).toBe(false);
  });

  it("treats an at-home-selected enrollment as scheduled even when it would otherwise be due", () => {
    const outcome = computeEnrollmentCycle(
      enrollment(
        attendedRows(8),
        cycleState({ cycleIndex: 0, atHomeSelectedAt: new Date("2026-06-01T03:00:00+07:00") }),
      ),
      now,
    );
    expect(outcome.status).toBe("scheduled");
    expect(outcome.shouldNotifyTeacher).toBe(false);
  });

  it("accounts a block when the booked test date passes (cycleIndex + 1) and recomputes position", () => {
    const testDate = new Date("2026-05-01T03:00:00+07:00");
    // 11 attended-with-credit total, cycleIndex 0 booked test now in the past.
    const state = cycleState({
      cycleIndex: 0,
      bookedTestWiseSessionId: "booked-test",
      bookedTestDate: testDate,
      teacherNotifiedForCycle: 0,
    });
    const outcome = computeEnrollmentCycle(enrollment(attendedRows(11), state), now);
    expect(outcome.cycleResetTriggered).toBe(true);
    expect(outcome.status).toBe("completed");
    expect(outcome.cycleIndex).toBe(1);
    expect(outcome.currentCycleStart.getTime()).toBe(testDate.getTime());
    // position = 11 - 1*8 = 3 toward the next block.
    expect(outcome.currentCount).toBe(3);
  });
});

describe("computeProgressTestStates", () => {
  const now = new Date("2026-07-01T03:00:00+07:00");

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
