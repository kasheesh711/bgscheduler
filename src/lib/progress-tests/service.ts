// Progress Tests — server service for the dashboard page + admin actions.
//
// getProgressTestsPayload() reads the durable cross-snapshot cycle-state rows
// and shapes them into the dashboard contract (rows + summary counts + distinct
// subjects + last-synced timestamp). It deliberately does NOT use Next's
// "use cache" in v1: the book/mark-complete/resend actions mutate cycle state in
// place, and a cached read would serve stale rows immediately after an action.
//
// The action wrappers (bookTest/markComplete/resendTeacherEmail) are thin
// adapters over the booking + teacher-heads-up modules so the API routes stay
// uniform (auth -> Zod -> service -> error response). Each returns the freshly
// reloaded dashboard row so the client can patch its table without a full refetch.
//
// Never log secrets, PII, or feedback text — only counts and error messages.

import { addMinutes } from "date-fns";
import { desc } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  PROGRESS_TEST_DEFAULT_DURATION_MINUTES,
  PROGRESS_TEST_THRESHOLD,
} from "./config";
import {
  loadCycleState,
  loadCycleStates,
  type ProgressTestCycleStateRecord,
} from "./db";
import {
  confirmProgressTestBooking,
  markProgressTestComplete,
  type ProgressTestActor,
} from "./booking";
import {
  runTeacherHeadsUpNotifications,
  type TeacherHeadsUpResult,
} from "./teacher-heads-up";
import type {
  ProgressTestAiSummary,
  ProgressTestBookingMode,
  ProgressTestRow,
  ProgressTestsPayload,
  ProgressTestStatus,
  ProgressTestsSummary,
} from "./types";

/** Input for booking a progress test from the dashboard. */
export interface BookProgressTestInput {
  enrollmentKey: string;
  testDate: Date;
  location?: string | null;
  actor?: ProgressTestActor;
}

/** Input for the admin "mark complete" / "resend email" actions. */
export interface ProgressTestActionInput {
  enrollmentKey: string;
  actor?: ProgressTestActor;
}

/**
 * Parses the parent name out of a credit-control student key.
 *
 * Student keys are `"<student>::<parent>"` (buildDashboardStudentKey); the
 * cycle-state row stores the key + the display student name but not the parent
 * separately, so we recover the parent segment for the dashboard.
 *
 * @returns the parent segment, or "" when the key has no parent part.
 */
function parentNameFromStudentKey(studentKey: string): string {
  const [, parent] = studentKey.split("::");
  return parent?.trim() ?? "";
}

/**
 * Coerces a stored cycle-state AI summary (loose JSON) into the typed shape.
 *
 * The summary is persisted as untyped jsonb; treat it defensively and return null
 * unless it carries the four expected fields with the right primitive shapes
 * (fail-closed: a malformed blob shows no summary rather than a broken card).
 *
 * @returns the typed AI summary, or null when absent/malformed.
 */
function toAiSummary(value: Record<string, unknown> | null): ProgressTestAiSummary | null {
  if (!value || typeof value !== "object") return null;
  const headline = value.headline;
  const strengths = value.strengths;
  const focusAreas = value.focusAreas;
  const recommendation = value.recommendation;
  if (
    typeof headline !== "string" ||
    typeof recommendation !== "string" ||
    !Array.isArray(strengths) ||
    !Array.isArray(focusAreas)
  ) {
    return null;
  }
  return {
    headline,
    strengths: strengths.filter((item): item is string => typeof item === "string"),
    focusAreas: focusAreas.filter((item): item is string => typeof item === "string"),
    recommendation,
  };
}

/** Maps a persisted cycle-state record to a dashboard row. */
function toProgressTestRow(record: ProgressTestCycleStateRecord): ProgressTestRow {
  return {
    enrollmentKey: record.enrollmentKey,
    wiseStudentId: record.wiseStudentId,
    wiseClassId: record.wiseClassId,
    studentKey: record.studentKey,
    studentName: record.studentName,
    parentName: parentNameFromStudentKey(record.studentKey),
    subject: record.subject,
    currentCount: record.currentCount,
    threshold: PROGRESS_TEST_THRESHOLD,
    cycleIndex: record.cycleIndex,
    status: record.status as ProgressTestStatus,
    mostFrequentTutorCanonicalKey: record.mostFrequentTutorCanonicalKey,
    mostFrequentTutorDisplayName: record.mostFrequentTutorDisplayName,
    teacherNotifiedAt: record.teacherNotifiedAt?.toISOString() ?? null,
    teacherNotifiedForCycle: record.teacherNotifiedForCycle,
    bookedTestWiseSessionId: record.bookedTestWiseSessionId,
    bookedTestDate: record.bookedTestDate?.toISOString() ?? null,
    bookedTestBookingMode: (record.bookedTestBookingMode as ProgressTestBookingMode | null) ?? null,
    lastClassDate: record.lastClassDate?.toISOString() ?? null,
    lastAiSummary: toAiSummary(record.lastAiSummary),
    lastAiSummaryAt: record.lastAiSummaryAt?.toISOString() ?? null,
    updatedByEmail: record.updatedByEmail,
    updatedAt: record.updatedAt?.toISOString() ?? null,
  };
}

/** Tallies dashboard rows by lifecycle status for the summary cards. */
function buildSummary(rows: ProgressTestRow[]): ProgressTestsSummary {
  const summary: ProgressTestsSummary = {
    accumulating: 0,
    approaching: 0,
    due: 0,
    scheduled: 0,
    completed: 0,
    total: rows.length,
  };
  for (const row of rows) {
    summary[row.status] += 1;
  }
  return summary;
}

/**
 * Reads the most recent progress-test sync run's finish timestamp.
 *
 * @returns the latest finished/started run timestamp as ISO, or null when no run exists.
 */
async function loadLastSyncedAt(db: Database): Promise<string | null> {
  const [run] = await db
    .select({
      startedAt: schema.progressTestSyncRuns.startedAt,
      finishedAt: schema.progressTestSyncRuns.finishedAt,
    })
    .from(schema.progressTestSyncRuns)
    .orderBy(desc(schema.progressTestSyncRuns.startedAt))
    .limit(1);

  if (!run) return null;
  return (run.finishedAt ?? run.startedAt).toISOString();
}

/**
 * Builds the progress-tests dashboard payload from durable cycle-state rows.
 *
 * 1. Load every persisted cycle-state row (cross-snapshot, keyed by enrollment).
 * 2. Map each to a dashboard row, sorted by current cycle progress (highest
 *    first) so due/approaching students surface at the top.
 * 3. Tally summary counts by status, collect the distinct subjects, and read the
 *    last sync timestamp.
 *
 * Reads fresh on every call (no "use cache") so the table reflects book/
 * mark-complete/resend actions immediately.
 *
 * @returns the full dashboard payload (rows + summary + subjects + timestamps).
 */
export async function getProgressTestsPayload(db: Database = getDb()): Promise<ProgressTestsPayload> {
  const [cycleStates, lastSyncedAt] = await Promise.all([
    loadCycleStates(db),
    loadLastSyncedAt(db),
  ]);

  const rows = [...cycleStates.values()]
    .map(toProgressTestRow)
    .sort((a, b) => {
      if (b.currentCount !== a.currentCount) return b.currentCount - a.currentCount;
      return a.studentName.localeCompare(b.studentName);
    });

  const subjects = [...new Set(rows.map((row) => row.subject).filter((subject) => subject.length > 0))].sort(
    (a, b) => a.localeCompare(b),
  );

  return {
    rows,
    summary: buildSummary(rows),
    subjects,
    lastSyncedAt,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Loads a single enrollment's dashboard row after a mutating action.
 *
 * @returns the freshly mapped row, or null when the enrollment has no cycle state.
 */
async function reloadRow(enrollmentKey: string, db: Database): Promise<ProgressTestRow | null> {
  const record = await loadCycleState(enrollmentKey, db);
  return record ? toProgressTestRow(record) : null;
}

/** Outcome of the book-test action returned to the API route. */
export interface BookProgressTestServiceResult {
  status: string;
  wiseSessionId: string | null;
  bookingMode: ProgressTestBookingMode | null;
  message: string;
  row: ProgressTestRow | null;
}

/**
 * Books a progress test for an enrollment (admin-confirmed).
 *
 * Derives the session end from the supplied start plus the default test duration,
 * delegates the audited + flag-gated Wise write to confirmProgressTestBooking,
 * and reloads the updated cycle-state row for the client.
 *
 * @returns the booking status/message plus the refreshed dashboard row.
 */
export async function bookTest(
  input: BookProgressTestInput,
  db: Database = getDb(),
): Promise<BookProgressTestServiceResult> {
  const scheduledTestEnd = addMinutes(input.testDate, PROGRESS_TEST_DEFAULT_DURATION_MINUTES);
  const result = await confirmProgressTestBooking({
    enrollmentKey: input.enrollmentKey,
    scheduledTestStart: input.testDate,
    scheduledTestEnd,
    location: input.location ?? null,
    actor: input.actor,
    db,
  });

  return {
    status: result.status,
    wiseSessionId: result.wiseSessionId,
    bookingMode: result.bookingMode,
    message: result.message,
    row: await reloadRow(input.enrollmentKey, db),
  };
}

/**
 * Marks an enrollment's progress test complete (manual cycle-roll override).
 *
 * Delegates the cycle roll to markProgressTestComplete and reloads the updated
 * row. A no-op (no existing cycle state) returns a null row so the route can
 * surface a 404.
 *
 * @returns the refreshed dashboard row, or null when the enrollment was unknown.
 */
export async function markComplete(
  input: ProgressTestActionInput,
  db: Database = getDb(),
): Promise<ProgressTestRow | null> {
  const rolled = await markProgressTestComplete({
    enrollmentKey: input.enrollmentKey,
    actor: input.actor,
    db,
  });
  if (!rolled) return null;
  return reloadRow(input.enrollmentKey, db);
}

/** Outcome of the resend-email action returned to the API route. */
export interface ResendTeacherEmailServiceResult {
  outcome: TeacherHeadsUpResult["outcomes"][number] | null;
  row: ProgressTestRow | null;
}

/**
 * Resends the teacher heads-up email for an enrollment (one-off).
 *
 * 1. Load the enrollment's cycle state; an unknown enrollment yields a null
 *    outcome + row so the route can return 404.
 * 2. Build a single heads-up enrollment from the stored cycle fields (reusing the
 *    persisted AI summary), and send it via runTeacherHeadsUpNotifications, which
 *    is idempotent per cycle and stamps teacherNotifiedAt on success.
 * 3. Reload the updated row for the client.
 *
 * @returns the per-enrollment send outcome plus the refreshed dashboard row.
 */
export async function resendTeacherEmail(
  input: ProgressTestActionInput,
  db: Database = getDb(),
): Promise<ResendTeacherEmailServiceResult> {
  const record = await loadCycleState(input.enrollmentKey, db);
  if (!record) return { outcome: null, row: null };

  const result = await runTeacherHeadsUpNotifications(db, {
    syncRunId: `manual-resend:${input.enrollmentKey}`,
    enrollments: [
      {
        enrollmentKey: record.enrollmentKey,
        cycleIndex: record.cycleIndex,
        studentName: record.studentName,
        subject: record.subject,
        currentCount: record.currentCount,
        mostFrequentTutorCanonicalKey: record.mostFrequentTutorCanonicalKey,
        mostFrequentTutorDisplayName: record.mostFrequentTutorDisplayName,
        aiSummary: toAiSummary(record.lastAiSummary),
      },
    ],
  });

  return {
    outcome: result.outcomes[0] ?? null,
    row: await reloadRow(input.enrollmentKey, db),
  };
}
