// Progress Tests — typed Drizzle helpers for the durable ledger + cycle state.
//
// The attendance ledger and cycle state are CROSS-SNAPSHOT (they survive Wise +
// credit-control snapshot rotation), so reads/writes here are keyed by stable
// identifiers (wiseSessionId/wiseStudentId, enrollmentKey) rather than a
// snapshot id. Source attendance comes from the ACTIVE credit-control snapshot.

import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { PROGRESS_TEST_COUNTING_START, buildEnrollmentKey } from "./config";

/** Insert shape for a progress-test booking audit row. */
export type ProgressTestBookingInsert = typeof schema.progressTestBookings.$inferInsert;

/** A persisted booking audit row. */
export type ProgressTestBookingRecord = typeof schema.progressTestBookings.$inferSelect;

/** Active Wise snapshot identity entry (the payroll teacher-resolution recipe shape). */
export interface ProgressTestIdentityEntry {
  wiseTeacherId: string;
  wiseUserId: string | null;
  canonicalKey: string;
  displayName: string;
}

/** One attended-with-credit session sourced from the active credit-control snapshot. */
export interface CreditControlAttendedSession {
  wiseSessionId: string;
  wiseClassId: string;
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  subject: string;
  scheduledStartTime: Date;
  creditApplied: number;
  meetingStatus: string;
}

/** A persisted ledger row read back for counting. */
export type ProgressTestLedgerRecord = typeof schema.progressTestAttendanceLedger.$inferSelect;

/** A persisted cycle-state row. */
export type ProgressTestCycleStateRecord = typeof schema.progressTestCycleState.$inferSelect;

/** Insert/upsert shape for ledger rows. */
export type ProgressTestLedgerInsert = typeof schema.progressTestAttendanceLedger.$inferInsert;

/** Insert/upsert shape for a cycle-state row. */
export type ProgressTestCycleStateInsert = typeof schema.progressTestCycleState.$inferInsert;

/**
 * Loads attended-with-credit sessions from the ACTIVE credit-control snapshot.
 *
 * 1. Resolve the active credit-control snapshot (most recent where active=true).
 * 2. Select its `creditControlSessions` filtered to ENDED + creditApplied>0 +
 *    sessionKind 'past' + scheduledStartTime >= PROGRESS_TEST_COUNTING_START.
 *
 * @returns the attended sessions to fold into the durable ledger, or [] when no
 *   active snapshot exists yet.
 */
export async function loadActiveCreditControlSnapshotSessions(
  db: Database = getDb(),
): Promise<CreditControlAttendedSession[]> {
  const [snapshot] = await db
    .select({ id: schema.creditControlSnapshots.id })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .orderBy(desc(schema.creditControlSnapshots.generatedAt))
    .limit(1);

  if (!snapshot) return [];

  const rows = await db
    .select({
      wiseSessionId: schema.creditControlSessions.wiseSessionId,
      wiseClassId: schema.creditControlSessions.wiseClassId,
      wiseStudentId: schema.creditControlSessions.wiseStudentId,
      studentKey: schema.creditControlSessions.studentKey,
      studentName: schema.creditControlSessions.studentName,
      subject: schema.creditControlSessions.subject,
      scheduledStartTime: schema.creditControlSessions.scheduledStartTime,
      creditApplied: schema.creditControlSessions.creditApplied,
      meetingStatus: schema.creditControlSessions.meetingStatus,
    })
    .from(schema.creditControlSessions)
    .where(and(
      eq(schema.creditControlSessions.snapshotId, snapshot.id),
      eq(schema.creditControlSessions.sessionKind, "past"),
      eq(schema.creditControlSessions.meetingStatus, "ENDED"),
      gt(schema.creditControlSessions.creditApplied, 0),
      gte(schema.creditControlSessions.scheduledStartTime, PROGRESS_TEST_COUNTING_START),
    ));

  return rows;
}

/** One per-class teacher feedback note for the AI summary. */
export interface ProgressTestFeedbackNoteRecord {
  scheduledStartTime: Date;
  teacherFeedback: string;
}

/**
 * Loads attended-with-credit teacher feedback notes for the given enrollments.
 *
 * Reads the ACTIVE credit-control snapshot's `creditControlSessions` (the same
 * attended-with-credit filter as the ledger source), selecting only sessions for
 * the requested enrollment keys and keeping rows with non-empty teacherFeedback.
 * Used by the nightly sync to feed the AI summary when an enrollment first
 * reaches the approaching threshold. Never logs the feedback text.
 *
 * @returns a Map from enrollmentKey to its feedback notes (ascending start time),
 *   or an empty Map when no active snapshot or no enrollment keys are given.
 */
export async function loadFeedbackNotesByEnrollment(
  enrollmentKeys: string[],
  db: Database = getDb(),
): Promise<Map<string, ProgressTestFeedbackNoteRecord[]>> {
  if (enrollmentKeys.length === 0) return new Map();

  const [snapshot] = await db
    .select({ id: schema.creditControlSnapshots.id })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .orderBy(desc(schema.creditControlSnapshots.generatedAt))
    .limit(1);

  if (!snapshot) return new Map();

  const wantedKeys = new Set(enrollmentKeys);
  const rows = await db
    .select({
      wiseClassId: schema.creditControlSessions.wiseClassId,
      wiseStudentId: schema.creditControlSessions.wiseStudentId,
      scheduledStartTime: schema.creditControlSessions.scheduledStartTime,
      teacherFeedback: schema.creditControlSessions.teacherFeedback,
    })
    .from(schema.creditControlSessions)
    .where(and(
      eq(schema.creditControlSessions.snapshotId, snapshot.id),
      eq(schema.creditControlSessions.sessionKind, "past"),
      eq(schema.creditControlSessions.meetingStatus, "ENDED"),
      gt(schema.creditControlSessions.creditApplied, 0),
      gte(schema.creditControlSessions.scheduledStartTime, PROGRESS_TEST_COUNTING_START),
    ))
    .orderBy(schema.creditControlSessions.scheduledStartTime);

  const byEnrollment = new Map<string, ProgressTestFeedbackNoteRecord[]>();
  for (const row of rows) {
    const enrollmentKey = buildEnrollmentKey(row.wiseClassId, row.wiseStudentId);
    if (!wantedKeys.has(enrollmentKey)) continue;
    const feedback = row.teacherFeedback?.trim();
    if (!feedback) continue;
    const existing = byEnrollment.get(enrollmentKey);
    const note: ProgressTestFeedbackNoteRecord = {
      scheduledStartTime: row.scheduledStartTime,
      teacherFeedback: feedback,
    };
    if (existing) {
      existing.push(note);
    } else {
      byEnrollment.set(enrollmentKey, [note]);
    }
  }
  return byEnrollment;
}

/**
 * Stores the generated AI summary on an enrollment's cycle-state row.
 *
 * Sets lastAiSummary (as plain JSON) + lastAiSummaryAt without touching the cycle
 * counters. No-ops are impossible — the row exists because the recompute upserted
 * it earlier in the same sync pass.
 *
 * @returns nothing.
 */
export async function storeCycleAiSummary(
  enrollmentKey: string,
  summary: Record<string, unknown>,
  now: Date,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(schema.progressTestCycleState)
    .set({ lastAiSummary: summary, lastAiSummaryAt: now, updatedAt: now })
    .where(eq(schema.progressTestCycleState.enrollmentKey, enrollmentKey));
}

/**
 * Loads the ACTIVE Wise snapshot's identity-group members joined to their groups.
 *
 * Mirrors the payroll recipe (src/lib/payroll/sync.ts): one row per identity
 * member on the active Wise snapshot, carrying the group's canonicalKey and
 * displayName, used to resolve a session teacher to a stable canonical key.
 *
 * @returns the identity entries for teacher resolution (empty when no active snapshot).
 */
export async function loadActiveIdentityEntries(
  db: Database = getDb(),
): Promise<ProgressTestIdentityEntry[]> {
  return db
    .select({
      wiseTeacherId: schema.tutorIdentityGroupMembers.wiseTeacherId,
      wiseUserId: schema.tutorIdentityGroupMembers.wiseUserId,
      canonicalKey: schema.tutorIdentityGroups.canonicalKey,
      displayName: schema.tutorIdentityGroups.displayName,
    })
    .from(schema.tutorIdentityGroupMembers)
    .innerJoin(
      schema.tutorIdentityGroups,
      eq(schema.tutorIdentityGroupMembers.groupId, schema.tutorIdentityGroups.id),
    )
    .innerJoin(
      schema.snapshots,
      eq(schema.snapshots.id, schema.tutorIdentityGroups.snapshotId),
    )
    .where(eq(schema.snapshots.active, true));
}

/**
 * Upserts attendance ledger rows idempotently.
 *
 * Conflicts on the (wiseSessionId, wiseStudentId) unique index refresh the
 * mutable attendance fields (meetingStatus/creditApplied/isProgressTest/
 * countsTowardCycle) and updatedAt, while preserving first-observation
 * provenance (firstObservedSnapshotId/capturedAt) so the ledger remains a
 * durable record of when each class was first seen.
 *
 * @returns nothing; no-ops on an empty input.
 */
export async function appendLedgerRows(
  rows: ProgressTestLedgerInsert[],
  db: Database = getDb(),
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(schema.progressTestAttendanceLedger)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        schema.progressTestAttendanceLedger.wiseSessionId,
        schema.progressTestAttendanceLedger.wiseStudentId,
      ],
      set: {
        meetingStatus: sql`excluded.meeting_status`,
        creditApplied: sql`excluded.credit_applied`,
        isProgressTest: sql`excluded.is_progress_test`,
        countsTowardCycle: sql`excluded.counts_toward_cycle`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Loads all ledger rows grouped by enrollment key, ordered by start time.
 *
 * @returns a Map from enrollmentKey to that enrollment's ledger rows (ascending
 *   scheduledStartTime), ready to feed the counting engine.
 */
export async function loadLedgerByEnrollment(
  db: Database = getDb(),
): Promise<Map<string, ProgressTestLedgerRecord[]>> {
  const rows = await db
    .select()
    .from(schema.progressTestAttendanceLedger)
    .orderBy(
      schema.progressTestAttendanceLedger.enrollmentKey,
      schema.progressTestAttendanceLedger.scheduledStartTime,
    );

  const byEnrollment = new Map<string, ProgressTestLedgerRecord[]>();
  for (const row of rows) {
    const existing = byEnrollment.get(row.enrollmentKey);
    if (existing) {
      existing.push(row);
    } else {
      byEnrollment.set(row.enrollmentKey, [row]);
    }
  }
  return byEnrollment;
}

/**
 * Loads all persisted cycle-state rows, keyed by enrollment key.
 *
 * @returns a Map from enrollmentKey to its cycle state for state recomputation.
 */
export async function loadCycleStates(
  db: Database = getDb(),
): Promise<Map<string, ProgressTestCycleStateRecord>> {
  const rows = await db.select().from(schema.progressTestCycleState);
  return new Map(rows.map((row) => [row.enrollmentKey, row]));
}

/**
 * Upserts a single enrollment's cycle state.
 *
 * Conflicts on the enrollmentKey primary key overwrite the recomputed cycle
 * fields and stamp updatedAt.
 *
 * @returns nothing.
 */
export async function upsertCycleState(
  input: ProgressTestCycleStateInsert,
  db: Database = getDb(),
): Promise<void> {
  await db
    .insert(schema.progressTestCycleState)
    .values(input)
    .onConflictDoUpdate({
      target: schema.progressTestCycleState.enrollmentKey,
      set: {
        wiseStudentId: input.wiseStudentId,
        wiseClassId: input.wiseClassId,
        studentKey: input.studentKey,
        studentName: input.studentName,
        subject: input.subject,
        currentCount: input.currentCount,
        currentCycleStart: input.currentCycleStart,
        cycleIndex: input.cycleIndex,
        status: input.status,
        bookedTestWiseSessionId: input.bookedTestWiseSessionId,
        bookedTestDate: input.bookedTestDate,
        bookedTestBookingMode: input.bookedTestBookingMode,
        teacherNotifiedAt: input.teacherNotifiedAt,
        teacherNotifiedForCycle: input.teacherNotifiedForCycle,
        mostFrequentTutorCanonicalKey: input.mostFrequentTutorCanonicalKey,
        mostFrequentTutorDisplayName: input.mostFrequentTutorDisplayName,
        lastAiSummary: input.lastAiSummary,
        lastAiSummaryAt: input.lastAiSummaryAt,
        lastClassDate: input.lastClassDate,
        updatedByEmail: input.updatedByEmail,
        updatedAt: new Date(),
      },
    });
}

/**
 * Loads a single enrollment's cycle state by key.
 *
 * @returns the cycle-state row, or null when the enrollment has none yet.
 */
export async function loadCycleState(
  enrollmentKey: string,
  db: Database = getDb(),
): Promise<ProgressTestCycleStateRecord | null> {
  const [row] = await db
    .select()
    .from(schema.progressTestCycleState)
    .where(eq(schema.progressTestCycleState.enrollmentKey, enrollmentKey))
    .limit(1);
  return row ?? null;
}

/**
 * Inserts a progress-test booking audit row and returns it.
 *
 * Every booking attempt — dry-run, manual, or a real Wise create — is recorded
 * here for an immutable audit trail (requestPayload carries the intended body +
 * endpoint string). Never store secrets/PII in the payload.
 *
 * @returns the persisted booking row (with its generated id).
 */
export async function insertBooking(
  input: ProgressTestBookingInsert,
  db: Database = getDb(),
): Promise<ProgressTestBookingRecord> {
  const [row] = await db
    .insert(schema.progressTestBookings)
    .values(input)
    .returning();
  return row;
}

/**
 * Resolves a Wise teacher userId for a tutor canonical key from the ledger.
 *
 * The cycle-state row stores only the most-frequent tutor's canonicalKey; the
 * Wise create-session call needs a teacher userId. Each ledger row carries both,
 * so we pick the most recent ledger row for that canonical key that has a
 * non-null wiseTeacherUserId.
 *
 * @returns the resolved teacher userId, or null when none can be found.
 */
export async function resolveTeacherUserIdForCanonicalKey(
  canonicalKey: string,
  db: Database = getDb(),
): Promise<string | null> {
  const [row] = await db
    .select({ wiseTeacherUserId: schema.progressTestAttendanceLedger.wiseTeacherUserId })
    .from(schema.progressTestAttendanceLedger)
    .where(and(
      eq(schema.progressTestAttendanceLedger.tutorCanonicalKey, canonicalKey),
      sql`${schema.progressTestAttendanceLedger.wiseTeacherUserId} IS NOT NULL`,
    ))
    .orderBy(desc(schema.progressTestAttendanceLedger.scheduledStartTime))
    .limit(1);
  return row?.wiseTeacherUserId ?? null;
}

/**
 * Marks the ledger row for a booked test session as a progress test.
 *
 * Sets isProgressTest=true and countsTowardCycle=false on the matching
 * (wiseSessionId, wiseStudentId) ledger row so the booked test is excluded from
 * the cycle count. No-ops when the row does not exist yet (the nightly sync will
 * fold it in once Wise reports it as attended).
 *
 * @returns nothing.
 */
export async function markLedgerRowAsProgressTest(
  wiseSessionId: string,
  wiseStudentId: string,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(schema.progressTestAttendanceLedger)
    .set({ isProgressTest: true, countsTowardCycle: false, updatedAt: new Date() })
    .where(and(
      eq(schema.progressTestAttendanceLedger.wiseSessionId, wiseSessionId),
      eq(schema.progressTestAttendanceLedger.wiseStudentId, wiseStudentId),
    ));
}
