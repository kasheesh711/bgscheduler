// Progress Tests — pure counting & cycle engine.
//
// This module is intentionally free of DB/Next imports: it takes pre-fetched
// ledger rows + cycle state per enrollment and computes where each student sits
// in their 8-class progress-test cycle. DB queries live in db.ts / sync.ts.
//
// Counting window starts at PROGRESS_TEST_COUNTING_START (2026-03-01, Bangkok);
// earlier Wise data is unreliable and excluded. Fail-closed: an enrollment with
// no resolvable teacher is still counted but surfaced as an issue so it routes
// to "Needs Review" downstream rather than being silently dropped.

import {
  PROGRESS_TEST_APPROACHING_AT,
  PROGRESS_TEST_COUNTING_START,
  PROGRESS_TEST_THRESHOLD,
} from "./config";
import type { ProgressTestStatus } from "./types";

/** One attended-with-credit ledger row, as consumed by the counting engine. */
export interface ProgressTestLedgerRow {
  enrollmentKey: string;
  wiseSessionId: string;
  wiseStudentId: string;
  wiseClassId: string;
  scheduledStartTime: Date;
  creditApplied: number;
  meetingStatus: string;
  sessionKind: string;
  isProgressTest: boolean;
  countsTowardCycle: boolean;
  tutorCanonicalKey: string | null;
}

/** Persisted cycle state for an enrollment, as consumed by the counting engine. */
export interface ProgressTestCycleStateInput {
  enrollmentKey: string;
  cycleIndex: number;
  currentCycleStart: Date | null;
  bookedTestWiseSessionId: string | null;
  bookedTestDate: Date | null;
  teacherNotifiedForCycle: number | null;
}

/** Per-enrollment input bundle: ledger rows + (optional) prior cycle state. */
export interface ProgressTestEnrollmentInput {
  enrollmentKey: string;
  ledgerRows: ProgressTestLedgerRow[];
  cycleState: ProgressTestCycleStateInput | null;
}

/** Inputs to the engine: all enrollments plus the evaluation timestamp. */
export interface ComputeProgressTestStatesInput {
  enrollments: ProgressTestEnrollmentInput[];
  now: Date;
}

/** Computed cycle outcome for a single enrollment. */
export interface ProgressTestEnrollmentResult {
  enrollmentKey: string;
  currentCount: number;
  cycleIndex: number;
  currentCycleStart: Date;
  status: ProgressTestStatus;
  cycleResetTriggered: boolean;
  shouldNotifyTeacher: boolean;
}

/** A non-fatal observation about an enrollment (e.g. unresolved teacher). */
export interface ProgressTestIssue {
  type: "unresolved-teacher";
  enrollmentKey: string;
  message: string;
}

/** Pipeline result: per-enrollment outcomes plus collected issues. */
export interface ProgressTestStatesResult {
  result: ProgressTestEnrollmentResult[];
  issues: ProgressTestIssue[];
}

/**
 * Whether a ledger/session row counts as an attended-with-credit class.
 *
 * Matches the locked rule: meetingStatus ENDED (case-insensitive) AND a positive
 * credit was applied AND it is a past session.
 *
 * @returns true when the row is an attended-with-credit past class.
 */
export function isAttendedWithCredit(
  row: Pick<ProgressTestLedgerRow, "meetingStatus" | "creditApplied" | "sessionKind">,
): boolean {
  return (
    row.meetingStatus.toUpperCase() === "ENDED" &&
    row.creditApplied > 0 &&
    row.sessionKind === "past"
  );
}

/**
 * Resolves the inclusive start of the current counting cycle.
 *
 * @returns the later of PROGRESS_TEST_COUNTING_START and lastCompletedTestDate,
 *   so a new cycle never counts classes from before the global window or before
 *   the previous test.
 */
export function resolveCycleStart(lastCompletedTestDate: Date | null): Date {
  if (lastCompletedTestDate && lastCompletedTestDate.getTime() > PROGRESS_TEST_COUNTING_START.getTime()) {
    return lastCompletedTestDate;
  }
  return PROGRESS_TEST_COUNTING_START;
}

/**
 * Computes the current cycle outcome for a single enrollment.
 *
 * 1. Resolve the cycle floor as max(COUNTING_START, currentCycleStart).
 * 2. Filter ledger rows to that floor, keeping only rows that count toward the
 *    cycle (countsTowardCycle && !isProgressTest) and excluding the booked test
 *    session by wiseSessionId. currentCount = filtered length.
 * 3. Reset: if a test was booked and its date has passed (now > bookedTestDate),
 *    roll the cycle (cycleIndex++, cycle start = bookedTestDate, drop booked
 *    fields + notify marker) and recount from the new floor → status completed,
 *    cycleResetTriggered true.
 * 4. Otherwise run the state machine: a future booked test → scheduled; count at
 *    or above the threshold (8) → due; count exactly at the approaching mark (6)
 *    → approaching (and shouldNotifyTeacher when the teacher has not yet been
 *    notified for this cycle); else accumulating.
 *
 * @returns the per-enrollment result the caller persists to cycle state.
 */
export function computeEnrollmentCycle(
  input: ProgressTestEnrollmentInput,
  now: Date,
): ProgressTestEnrollmentResult {
  const { enrollmentKey, ledgerRows, cycleState } = input;
  const cycleIndex = cycleState?.cycleIndex ?? 0;
  const bookedTestDate = cycleState?.bookedTestDate ?? null;
  const bookedTestWiseSessionId = cycleState?.bookedTestWiseSessionId ?? null;

  // Step 3 (precedence): a booked test whose date has passed resets the cycle.
  if (bookedTestDate && now.getTime() > bookedTestDate.getTime()) {
    const nextCycleStart = resolveCycleStart(bookedTestDate);
    const currentCount = countCycleRows(ledgerRows, nextCycleStart, null);
    return {
      enrollmentKey,
      currentCount,
      cycleIndex: cycleIndex + 1,
      currentCycleStart: nextCycleStart,
      status: "completed",
      cycleResetTriggered: true,
      shouldNotifyTeacher: false,
    };
  }

  // Steps 1-2: count within the current cycle, excluding the booked test session.
  const cycleStart = resolveCycleStart(cycleState?.currentCycleStart ?? null);
  const currentCount = countCycleRows(ledgerRows, cycleStart, bookedTestWiseSessionId);

  // Step 4: state machine.
  let status: ProgressTestStatus;
  let shouldNotifyTeacher = false;
  if (bookedTestDate && now.getTime() <= bookedTestDate.getTime()) {
    status = "scheduled";
  } else if (currentCount >= PROGRESS_TEST_THRESHOLD) {
    status = "due";
  } else if (currentCount === PROGRESS_TEST_APPROACHING_AT) {
    status = "approaching";
    shouldNotifyTeacher = cycleState?.teacherNotifiedForCycle !== cycleIndex;
  } else {
    status = "accumulating";
  }

  return {
    enrollmentKey,
    currentCount,
    cycleIndex,
    currentCycleStart: cycleStart,
    status,
    cycleResetTriggered: false,
    shouldNotifyTeacher,
  };
}

/**
 * Computes cycle outcomes for every enrollment.
 *
 * 1. Run computeEnrollmentCycle for each enrollment at the shared `now`.
 * 2. Collect a fail-closed issue for any enrollment whose counted classes have
 *    no resolvable teacher (so it surfaces as "Needs Review" downstream rather
 *    than being treated as fully resolved).
 *
 * @returns the { result, issues } pipeline shape.
 */
export function computeProgressTestStates(
  input: ComputeProgressTestStatesInput,
): ProgressTestStatesResult {
  const result: ProgressTestEnrollmentResult[] = [];
  const issues: ProgressTestIssue[] = [];

  for (const enrollment of input.enrollments) {
    const outcome = computeEnrollmentCycle(enrollment, input.now);
    result.push(outcome);

    const hasCountedRows = enrollment.ledgerRows.some(
      (row) => row.countsTowardCycle && !row.isProgressTest,
    );
    const hasResolvedTeacher = enrollment.ledgerRows.some(
      (row) => row.tutorCanonicalKey !== null && row.tutorCanonicalKey !== "",
    );
    if (hasCountedRows && !hasResolvedTeacher) {
      issues.push({
        type: "unresolved-teacher",
        enrollmentKey: enrollment.enrollmentKey,
        message: `No resolvable teacher for enrollment "${enrollment.enrollmentKey}" — routed to Needs Review`,
      });
    }
  }

  return { result, issues };
}

/**
 * Counts cycle-eligible ledger rows at or after `cycleStart`.
 *
 * Keeps rows that count toward the cycle and are not themselves a progress test,
 * scheduled at/after the cycle floor, and not the currently booked test session.
 */
function countCycleRows(
  rows: ProgressTestLedgerRow[],
  cycleStart: Date,
  bookedTestWiseSessionId: string | null,
): number {
  const floor = cycleStart.getTime();
  return rows.filter((row) => {
    if (!row.countsTowardCycle) return false;
    if (row.isProgressTest) return false;
    if (row.scheduledStartTime.getTime() < floor) return false;
    if (bookedTestWiseSessionId && row.wiseSessionId === bookedTestWiseSessionId) return false;
    return true;
  }).length;
}
