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

/** Number of full 8-class blocks completed for a given attended-class count. */
function blocksCompleted(count: number): number {
  return Math.floor(count / PROGRESS_TEST_THRESHOLD);
}

/** Clamps a raw block position into the [0, threshold] display range. */
function clampPosition(rawPosition: number): number {
  if (rawPosition < 0) return 0;
  if (rawPosition > PROGRESS_TEST_THRESHOLD) return PROGRESS_TEST_THRESHOLD;
  return rawPosition;
}

/**
 * Computes the current cycle outcome for a single enrollment (count-based model).
 *
 * `currentCount` is the student's position WITHIN their current block of 8 (e.g.
 * 86 attended classes → 6/8), not the lifetime total. `count` is all
 * attended-with-credit ledger rows in the window, excluding progress tests + the
 * booked test session; `cycleIndex` is the number of 8-class blocks already
 * accounted for (assumed-tested at baseline + actually tested since); position =
 * count − cycleIndex×8.
 *
 * Fresh-start baseline: on first observation the enrollment is assumed up-to-date
 * (cycleIndex = blocksCompleted(count)), so a long-standing student shows their
 * current position and is NOT immediately "due" — a test becomes due only once
 * they complete their NEXT block of 8 from now on.
 *
 * 1. Count cycle-eligible ledger rows (excluding progress tests + the booked test).
 * 2. Reset (precedence): if a booked test's date has passed, account that test
 *    (cycleIndex + 1), recompute position, return status completed.
 * 3. Resolve cycleIndex: blocksCompleted(count) on first observation, else stored.
 * 4. position = count − cycleIndex×8. State machine: future booked test →
 *    scheduled; position ≥ 8 → due; position == 6 → approaching (+ notify unless
 *    suppressed); else accumulating.
 *
 * Cutover/first-observation suppression: a brand-new enrollment already at/after
 * the approaching mark (position ≥ 6) is treated as already-notified for this
 * block, so re-baselining the whole roster never blasts heads-up emails.
 *
 * @returns the per-enrollment result the caller persists to cycle state.
 */
export function computeEnrollmentCycle(
  input: ProgressTestEnrollmentInput,
  now: Date,
): ProgressTestEnrollmentResult {
  const { enrollmentKey, ledgerRows, cycleState } = input;
  const isFirstObservation = cycleState === null;
  const bookedTestDate = cycleState?.bookedTestDate ?? null;
  const bookedTestWiseSessionId = cycleState?.bookedTestWiseSessionId ?? null;

  // Step 1: lifetime attended-with-credit count for this enrollment, excluding
  // the booked test session and any row already flagged as a progress test.
  const count = countCycleRows(ledgerRows, bookedTestWiseSessionId);

  // Step 2 (precedence): a booked test whose date has passed accounts one block.
  if (bookedTestDate && now.getTime() > bookedTestDate.getTime()) {
    const cycleIndex = (cycleState?.cycleIndex ?? blocksCompleted(count)) + 1;
    return {
      enrollmentKey,
      currentCount: clampPosition(count - cycleIndex * PROGRESS_TEST_THRESHOLD),
      cycleIndex,
      currentCycleStart: resolveCycleStart(bookedTestDate),
      status: "completed",
      cycleResetTriggered: true,
      shouldNotifyTeacher: false,
    };
  }

  // Step 3: baseline the block counter so first-seen students are assumed up-to-date.
  const cycleIndex = isFirstObservation
    ? blocksCompleted(count)
    : cycleState?.cycleIndex ?? blocksCompleted(count);

  // Step 4: position within the current block + state machine.
  const rawPosition = count - cycleIndex * PROGRESS_TEST_THRESHOLD;

  let status: ProgressTestStatus;
  let shouldNotifyTeacher = false;
  if (bookedTestDate && now.getTime() <= bookedTestDate.getTime()) {
    status = "scheduled";
  } else if (rawPosition >= PROGRESS_TEST_THRESHOLD) {
    status = "due";
  } else if (rawPosition === PROGRESS_TEST_APPROACHING_AT) {
    status = "approaching";
    // Suppress the heads-up on first observation (cutover re-baseline) so we never
    // re-blast teachers for blocks already in progress; resume for future blocks.
    shouldNotifyTeacher =
      !isFirstObservation && cycleState?.teacherNotifiedForCycle !== cycleIndex;
  } else {
    status = "accumulating";
  }

  return {
    enrollmentKey,
    currentCount: clampPosition(rawPosition),
    cycleIndex,
    currentCycleStart: resolveCycleStart(cycleState?.currentCycleStart ?? null),
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
 * Counts cycle-eligible ledger rows in the counting window for an enrollment.
 *
 * Keeps attended-with-credit rows at/after COUNTING_START that are not themselves
 * a progress test and not the currently booked test session. (The ledger only
 * stores rows at/after COUNTING_START; the window is re-checked defensively.)
 * This is the cumulative attended count from which the block position is derived.
 */
function countCycleRows(
  rows: ProgressTestLedgerRow[],
  bookedTestWiseSessionId: string | null,
): number {
  const floor = PROGRESS_TEST_COUNTING_START.getTime();
  return rows.filter((row) => {
    if (!row.countsTowardCycle) return false;
    if (row.isProgressTest) return false;
    if (row.scheduledStartTime.getTime() < floor) return false;
    if (bookedTestWiseSessionId && row.wiseSessionId === bookedTestWiseSessionId) return false;
    return true;
  }).length;
}
