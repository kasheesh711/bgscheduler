// Progress Tests — nightly sync orchestrator.
//
// Folds attended-with-credit classes (from the ACTIVE credit-control snapshot)
// into the durable cross-snapshot attendance ledger, resolves each session's
// teacher via the ACTIVE Wise snapshot identity groups (the proven payroll
// recipe), recomputes per-enrollment cycle state through the pure engine, and
// records due/approaching counts on the run row.
//
// Fail-isolated: per-row identity gaps never abort the run (they surface as
// "Needs Review" downstream via the engine's issues), and idempotent upserts
// keyed by stable identifiers let a failed run self-heal on the next pass.
//
// Step 5 wires notifications: enrollments newly transitioning to approaching get
// an AI summary of the teacher's recent feedback and a teacher heads-up email.
// That step is fail-isolated in its own try/catch — a notification/AI error is
// logged and never fails the sync run (the engine recomputes which enrollments
// *should* notify, and idempotency keys keep re-runs from re-sending).

import { revalidateTag } from "next/cache";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { WiseClient } from "@/lib/wise/client";
import { fetchAllTeachers } from "@/lib/wise/fetchers";
import type { WiseSession } from "@/lib/wise/types";
import {
  getWiseSessionTeacherUserId,
  getWiseTeacherDisplayName,
  getWiseTeacherUserId,
} from "@/lib/wise/types";
import type { ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import {
  PROGRESS_TESTS_CACHE_TAG,
  PROGRESS_TEST_APPROACHING_AT,
  PROGRESS_TEST_COUNTING_START,
  buildEnrollmentKey,
} from "./config";
import {
  appendLedgerRows,
  loadActiveCreditControlSnapshotSessions,
  loadActiveIdentityEntries,
  loadCycleStates,
  loadFeedbackNotesByEnrollment,
  loadLedgerByEnrollment,
  storeCycleAiSummary,
  upsertCycleState,
  type CreditControlAttendedSession,
  type ProgressTestCycleStateRecord,
  type ProgressTestIdentityEntry,
  type ProgressTestLedgerInsert,
  type ProgressTestLedgerRecord,
} from "./db";
import {
  computeProgressTestStates,
  type ProgressTestEnrollmentInput,
  type ProgressTestEnrollmentResult,
  type ProgressTestLedgerRow,
} from "./engine";
import { generateProgressTestSummary } from "./ai-summary";
import {
  runTeacherHeadsUpNotifications,
  type TeacherHeadsUpEnrollment,
} from "./teacher-heads-up";
import type { ProgressTestAiSummary } from "./types";

const SESSION_PAGE_SIZE = 1000;
const ERROR_SUMMARY_MAX_LENGTH = 2_000;

/** Outcome summary returned to callers and surfaced in the run row + cron audit. */
export interface ProgressTestSyncResult {
  success: boolean;
  ledgerRowCount: number;
  enrollmentCount: number;
  approachingCount: number;
  dueCount: number;
  unresolvedTeacherCount: number;
  notificationCount: number;
  errorSummary?: string;
}

/** Resolved teacher identity for a single Wise session. */
interface SessionTeacherIdentity {
  wiseTeacherUserId: string | null;
  wiseTeacherId: string | null;
  tutorCanonicalKey: string | null;
  tutorDisplayName: string | null;
}

/** Dependencies for runProgressTestSync — explicit for unit testing. */
export interface ProgressTestSyncDeps {
  db: Database;
  client: WiseClient;
  instituteId: string;
  now?: Date;
  syncRunId: string;
  /** Overridable email sender for the teacher heads-up step (defaults to Apps Script). */
  sender?: ScheduleEmailSender;
}

function shortErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "Progress test sync failed";
  if (message.length <= ERROR_SUMMARY_MAX_LENGTH) return message;
  return `${message.slice(0, ERROR_SUMMARY_MAX_LENGTH)}... [truncated ${message.length - ERROR_SUMMARY_MAX_LENGTH} chars]`;
}

/**
 * Fetches raw Wise PAST sessions across the counting window for teacher resolution.
 *
 * The credit-control snapshot stores attendance but NOT teacher identity, so we
 * pull the raw Wise sessions (which carry teacherId/userId) and key them by
 * wiseSessionId. Paginated by date like the payroll past-session fetch.
 *
 * @returns the raw Wise sessions covering [startDate, endDate] (Bangkok-aware ISO bounds).
 */
async function fetchWisePastSessions(
  client: WiseClient,
  instituteId: string,
  startDate: Date,
  endDate: Date,
): Promise<WiseSession[]> {
  const sessions: WiseSession[] = [];
  for (let pageNumber = 1; ; pageNumber += 1) {
    const response = await client.get<{
      data?: { sessions?: WiseSession[]; page_count?: number };
    }>(`/institutes/${instituteId}/sessions`, {
      status: "PAST",
      paginateBy: "DATE",
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      page_number: String(pageNumber),
      page_size: String(SESSION_PAGE_SIZE),
    });
    const pageSessions = response.data?.sessions ?? [];
    sessions.push(...pageSessions);
    const pageCount = response.data?.page_count ?? pageNumber;
    if (pageNumber >= pageCount || pageSessions.length === 0) break;
  }
  return sessions;
}

/**
 * Builds a wiseSessionId -> resolved teacher identity map (payroll recipe).
 *
 * 1. Index identity entries by wiseUserId and by wiseTeacherId.
 * 2. Index teachers by wiseUserId so a session's user id can recover its teacher id.
 * 3. For each Wise session, read its teacher user id and resolve the canonical
 *    key by user id first, then by the teacher's wise teacher id; display name
 *    falls back to the Wise teacher name. Unresolved sessions still get a map
 *    entry with null identity (fail-closed routing happens in the engine).
 *
 * @returns a Map from wiseSessionId to its resolved (possibly null) teacher identity.
 */
export function buildSessionTeacherMap(
  sessions: WiseSession[],
  teachers: Awaited<ReturnType<typeof fetchAllTeachers>>,
  identities: ProgressTestIdentityEntry[],
): Map<string, SessionTeacherIdentity> {
  const identityByTeacherId = new Map(identities.map((entry) => [entry.wiseTeacherId, entry]));
  const identityByUserId = new Map(
    identities
      .filter((entry) => entry.wiseUserId)
      .map((entry) => [entry.wiseUserId!, entry]),
  );

  const teacherByUserId = new Map<string, { wiseTeacherId: string; displayName: string }>();
  for (const teacher of teachers) {
    const wiseUserId = getWiseTeacherUserId(teacher);
    if (wiseUserId) {
      teacherByUserId.set(wiseUserId, {
        wiseTeacherId: teacher._id,
        displayName: getWiseTeacherDisplayName(teacher),
      });
    }
  }

  const map = new Map<string, SessionTeacherIdentity>();
  for (const session of sessions) {
    // The session's teacher reference may be a Wise user id OR a teacher id
    // (getWiseSessionTeacherUserId falls back to teacherId). Resolve tolerantly
    // through both index types so either form recovers the identity group; an
    // unresolved session still gets a null-identity entry (fail-closed in the engine).
    const teacherRef = getWiseSessionTeacherUserId(session) ?? null;
    const teacher = teacherRef ? teacherByUserId.get(teacherRef) : undefined;
    const identity = (teacherRef ? identityByUserId.get(teacherRef) : undefined)
      ?? (teacherRef ? identityByTeacherId.get(teacherRef) : undefined)
      ?? (teacher ? identityByTeacherId.get(teacher.wiseTeacherId) : undefined);
    map.set(session._id, {
      wiseTeacherUserId: teacher ? teacherRef : identity?.wiseUserId ?? null,
      wiseTeacherId: teacher?.wiseTeacherId ?? identity?.wiseTeacherId ?? session.teacherId ?? null,
      tutorCanonicalKey: identity?.canonicalKey ?? null,
      tutorDisplayName: identity?.displayName ?? teacher?.displayName ?? null,
    });
  }
  return map;
}

/**
 * Builds the ledger upsert rows from credit-control attendance + teacher map.
 *
 * Each attended-with-credit session becomes one ledger row keyed by
 * (wiseSessionId, wiseStudentId). Teacher identity columns come from the Wise
 * session map; countsTowardCycle defaults true and isProgressTest defaults false
 * — a row is marked isProgressTest only when its session id matches the
 * enrollment's stored bookedTestWiseSessionId.
 *
 * @returns the ledger insert rows to upsert.
 */
function buildLedgerRows(
  sessions: CreditControlAttendedSession[],
  teacherBySessionId: Map<string, SessionTeacherIdentity>,
  cycleStates: Map<string, ProgressTestCycleStateRecord>,
): ProgressTestLedgerInsert[] {
  return sessions.map((session) => {
    const enrollmentKey = buildEnrollmentKey(session.wiseClassId, session.wiseStudentId);
    const teacher = teacherBySessionId.get(session.wiseSessionId);
    const bookedTestWiseSessionId = cycleStates.get(enrollmentKey)?.bookedTestWiseSessionId ?? null;
    const isProgressTest = bookedTestWiseSessionId !== null
      && bookedTestWiseSessionId === session.wiseSessionId;
    return {
      enrollmentKey,
      wiseSessionId: session.wiseSessionId,
      wiseClassId: session.wiseClassId,
      wiseStudentId: session.wiseStudentId,
      studentKey: session.studentKey,
      studentName: session.studentName,
      subject: session.subject,
      scheduledStartTime: session.scheduledStartTime,
      creditApplied: session.creditApplied,
      meetingStatus: session.meetingStatus,
      wiseTeacherUserId: teacher?.wiseTeacherUserId ?? null,
      wiseTeacherId: teacher?.wiseTeacherId ?? null,
      tutorCanonicalKey: teacher?.tutorCanonicalKey ?? null,
      tutorDisplayName: teacher?.tutorDisplayName ?? null,
      isProgressTest,
      countsTowardCycle: true,
    } satisfies ProgressTestLedgerInsert;
  });
}

/** Maps a persisted ledger record to the engine's lightweight row shape. */
function toEngineRow(record: ProgressTestLedgerRecord): ProgressTestLedgerRow {
  return {
    enrollmentKey: record.enrollmentKey,
    wiseSessionId: record.wiseSessionId,
    wiseStudentId: record.wiseStudentId,
    wiseClassId: record.wiseClassId,
    scheduledStartTime: record.scheduledStartTime,
    creditApplied: record.creditApplied,
    meetingStatus: record.meetingStatus,
    sessionKind: "past",
    isProgressTest: record.isProgressTest,
    countsTowardCycle: record.countsTowardCycle,
    tutorCanonicalKey: record.tutorCanonicalKey,
  };
}

/**
 * Computes the most-frequent tutor across an enrollment's counted classes.
 *
 * Most frequent in the current cycle by canonical key; ties break toward the
 * most recent class (latest scheduledStartTime). Rows that count toward the
 * cycle but have no resolvable tutor are ignored here (they surface as a
 * fail-closed issue via the engine).
 *
 * @returns the winning canonical key + display name, or nulls when none resolved.
 */
export function computeMostFrequentTutor(
  records: ProgressTestLedgerRecord[],
  cycleStart: Date,
): { canonicalKey: string | null; displayName: string | null } {
  const floor = cycleStart.getTime();
  const tally = new Map<string, { displayName: string | null; count: number; lastSeen: number }>();

  for (const record of records) {
    if (!record.countsTowardCycle || record.isProgressTest) continue;
    if (record.scheduledStartTime.getTime() < floor) continue;
    const key = record.tutorCanonicalKey;
    if (!key) continue;
    const startMs = record.scheduledStartTime.getTime();
    const existing = tally.get(key);
    if (existing) {
      existing.count += 1;
      if (startMs > existing.lastSeen) {
        existing.lastSeen = startMs;
        existing.displayName = record.tutorDisplayName ?? existing.displayName;
      }
    } else {
      tally.set(key, { displayName: record.tutorDisplayName ?? null, count: 1, lastSeen: startMs });
    }
  }

  let winnerKey: string | null = null;
  let winner: { displayName: string | null; count: number; lastSeen: number } | null = null;
  for (const [key, entry] of tally) {
    if (
      !winner ||
      entry.count > winner.count ||
      (entry.count === winner.count && entry.lastSeen > winner.lastSeen)
    ) {
      winnerKey = key;
      winner = entry;
    }
  }

  return { canonicalKey: winnerKey, displayName: winner?.displayName ?? null };
}

/**
 * Resolves the latest counted class date in an enrollment's current cycle.
 *
 * @returns the most recent eligible class start, or null when none count.
 */
function resolveLastClassDate(records: ProgressTestLedgerRecord[], cycleStart: Date): Date | null {
  const floor = cycleStart.getTime();
  let latest: Date | null = null;
  for (const record of records) {
    if (!record.countsTowardCycle || record.isProgressTest) continue;
    if (record.scheduledStartTime.getTime() < floor) continue;
    if (!latest || record.scheduledStartTime.getTime() > latest.getTime()) {
      latest = record.scheduledStartTime;
    }
  }
  return latest;
}

/**
 * Builds the cycle-state upsert row for one enrollment from the engine result.
 *
 * On a reset (cycleResetTriggered) the booked-test fields and the
 * teacherNotifiedForCycle marker are cleared and currentCycleStart advances to
 * the (now past) booked test date — so the next cycle counts only fresh classes.
 *
 * @returns the cycle-state insert/upsert row.
 */
function buildCycleStateRow(
  outcome: ProgressTestEnrollmentResult,
  records: ProgressTestLedgerRecord[],
  prior: ProgressTestCycleStateRecord | null,
): typeof schema.progressTestCycleState.$inferInsert {
  const reset = outcome.cycleResetTriggered;
  // First observation = the enrollment had no prior cycle state (true for every
  // row on the one-time re-baseline). Suppress the heads-up for students already
  // at/after the approaching mark so re-baselining never re-blasts teachers.
  const isFirstObservation = prior === null;
  const suppressHeadsUp =
    isFirstObservation && outcome.currentCount >= PROGRESS_TEST_APPROACHING_AT;
  const sample = records[0];
  const [wiseClassId, wiseStudentId] = outcome.enrollmentKey.split("|");
  const tutor = computeMostFrequentTutor(records, outcome.currentCycleStart);

  return {
    enrollmentKey: outcome.enrollmentKey,
    wiseStudentId: sample?.wiseStudentId ?? wiseStudentId ?? "",
    wiseClassId: sample?.wiseClassId ?? wiseClassId ?? "",
    studentKey: sample?.studentKey ?? prior?.studentKey ?? "",
    studentName: sample?.studentName ?? prior?.studentName ?? "",
    subject: sample?.subject ?? prior?.subject ?? "",
    currentCount: outcome.currentCount,
    currentCycleStart: outcome.currentCycleStart,
    cycleIndex: outcome.cycleIndex,
    status: outcome.status,
    bookedTestWiseSessionId: reset ? null : prior?.bookedTestWiseSessionId ?? null,
    bookedTestDate: reset ? null : prior?.bookedTestDate ?? null,
    bookedTestBookingMode: reset ? null : prior?.bookedTestBookingMode ?? null,
    scheduleMethod: reset ? null : prior?.scheduleMethod ?? null,
    bookedTestLocation: reset ? null : prior?.bookedTestLocation ?? null,
    atHomeSelectedAt: reset ? null : prior?.atHomeSelectedAt ?? null,
    atHomeSubmittedAt: reset ? null : prior?.atHomeSubmittedAt ?? null,
    teacherNotifiedAt: reset ? null : prior?.teacherNotifiedAt ?? null,
    teacherNotifiedForCycle: reset
      ? null
      : suppressHeadsUp
        ? outcome.cycleIndex
        : prior?.teacherNotifiedForCycle ?? null,
    mostFrequentTutorCanonicalKey: tutor.canonicalKey,
    mostFrequentTutorDisplayName: tutor.displayName,
    lastAiSummary: prior?.lastAiSummary ?? null,
    lastAiSummaryAt: prior?.lastAiSummaryAt ?? null,
    lastClassDate: resolveLastClassDate(records, outcome.currentCycleStart),
    updatedByEmail: prior?.updatedByEmail ?? null,
  };
}

/** A newly-approaching enrollment captured during recompute for step 6. */
interface NotifyingEnrollment {
  enrollmentKey: string;
  cycleIndex: number;
  studentName: string;
  subject: string;
  currentCount: number;
  mostFrequentTutorCanonicalKey: string | null;
  mostFrequentTutorDisplayName: string | null;
}

/**
 * Generates AI summaries for newly-approaching enrollments and sends the teacher
 * heads-up emails (step 6).
 *
 * 1. Load the last-8 attended-with-credit feedback notes per notifying enrollment
 *    from the active credit-control snapshot.
 * 2. For each enrollment, generate the AI summary (fail-closed: sparse/skipped/
 *    failed yields no summary, and the heads-up email falls back gracefully); a
 *    usable summary is stored on the cycle-state row for reuse in the email + UI.
 * 3. Send the heads-up emails via runTeacherHeadsUpNotifications, which stamps
 *    teacherNotifiedAt/teacherNotifiedForCycle on each successful send.
 *
 * Never logs the feedback text or the summary. Returns 0 when there is nothing to
 * notify; the caller wraps this in its own try/catch so any failure is isolated.
 *
 * @returns the number of heads-up emails successfully sent.
 */
async function runTeacherHeadsUpStep(
  db: Database,
  syncRunId: string,
  notifying: NotifyingEnrollment[],
  now: Date,
  sender: ScheduleEmailSender | undefined,
): Promise<number> {
  if (notifying.length === 0) return 0;

  const feedbackByEnrollment = await loadFeedbackNotesByEnrollment(
    notifying.map((enrollment) => enrollment.enrollmentKey),
    db,
  );

  const enrollments: TeacherHeadsUpEnrollment[] = [];
  for (const enrollment of notifying) {
    let aiSummary: ProgressTestAiSummary | null = null;
    const notes = feedbackByEnrollment.get(enrollment.enrollmentKey) ?? [];
    const summaryResult = await generateProgressTestSummary(notes);
    if (summaryResult.status === "ok") {
      aiSummary = summaryResult.summary;
      await storeCycleAiSummary(
        enrollment.enrollmentKey,
        summaryResult.summary as unknown as Record<string, unknown>,
        now,
        db,
      );
    }
    enrollments.push({
      enrollmentKey: enrollment.enrollmentKey,
      cycleIndex: enrollment.cycleIndex,
      studentName: enrollment.studentName,
      subject: enrollment.subject,
      currentCount: enrollment.currentCount,
      mostFrequentTutorCanonicalKey: enrollment.mostFrequentTutorCanonicalKey,
      mostFrequentTutorDisplayName: enrollment.mostFrequentTutorDisplayName,
      aiSummary,
    });
  }

  const result = await runTeacherHeadsUpNotifications(db, { syncRunId, enrollments, sender });
  return result.sent;
}

/**
 * Runs one progress-test sync pass against a pre-acquired run row.
 *
 * 1. Load attended-with-credit sessions from the active credit-control snapshot.
 * 2. Resolve each session's teacher via the active Wise snapshot identity groups
 *    (the payroll recipe), pulling raw Wise PAST sessions + teachers.
 * 3. Upsert the durable ledger (idempotent on wiseSessionId+wiseStudentId),
 *    marking a row isProgressTest only when it is the enrollment's booked test.
 * 4. Recompute per-enrollment cycle state through the pure engine, computing the
 *    most-frequent tutor, and upsert progress_test_cycle_state (handling resets).
 * 5. For enrollments newly transitioning to approaching (shouldNotifyTeacher),
 *    generate the AI summary from the last-8 attended feedback notes, store it on
 *    cycle state, and send the teacher heads-up email. Fail-isolated: a
 *    notification/AI error is caught + logged and never fails the sync run.
 * 6. Record due/approaching/notification counts and finalize the run row, then
 *    revalidate the progress-tests cache tag. Any earlier throw fails only this
 *    run row (the per-row upserts self-heal on the next pass).
 *
 * @returns a summary of ledger/enrollment/due/approaching/notification counts.
 */
export async function runProgressTestSync(deps: ProgressTestSyncDeps): Promise<ProgressTestSyncResult> {
  const { db, client, instituteId, syncRunId } = deps;
  const now = deps.now ?? new Date();

  try {
    // Step 1: attended-with-credit sessions from the active credit-control snapshot.
    const attendedSessions = await loadActiveCreditControlSnapshotSessions(db);

    // Step 2: resolve teacher identity per session via the active Wise snapshot.
    const [teachers, identities, wiseSessions] = await Promise.all([
      fetchAllTeachers(client, instituteId),
      loadActiveIdentityEntries(db),
      fetchWisePastSessions(client, instituteId, PROGRESS_TEST_COUNTING_START, now),
    ]);
    const teacherBySessionId = buildSessionTeacherMap(wiseSessions, teachers, identities);

    // Step 3: upsert the durable ledger (booked-test rows flagged via prior state).
    const priorCycleStates = await loadCycleStates(db);
    const ledgerRows = buildLedgerRows(attendedSessions, teacherBySessionId, priorCycleStates);
    await appendLedgerRows(ledgerRows, db);

    // Step 4: recompute cycle state per enrollment through the pure engine.
    const ledgerByEnrollment = await loadLedgerByEnrollment(db);
    const enrollments: ProgressTestEnrollmentInput[] = [...ledgerByEnrollment.entries()].map(
      ([enrollmentKey, records]) => {
        const cycleState = priorCycleStates.get(enrollmentKey) ?? null;
        return {
          enrollmentKey,
          ledgerRows: records.map(toEngineRow),
          cycleState: cycleState
            ? {
              enrollmentKey,
              cycleIndex: cycleState.cycleIndex,
              currentCycleStart: cycleState.currentCycleStart,
              bookedTestWiseSessionId: cycleState.bookedTestWiseSessionId,
              bookedTestDate: cycleState.bookedTestDate,
              teacherNotifiedForCycle: cycleState.teacherNotifiedForCycle,
              atHomeSelectedAt: cycleState.atHomeSelectedAt,
              atHomeSubmittedAt: cycleState.atHomeSubmittedAt,
            }
            : null,
        };
      },
    );

    const { result, issues } = computeProgressTestStates({ enrollments, now });

    let approachingCount = 0;
    let dueCount = 0;
    const notifying: NotifyingEnrollment[] = [];
    for (const outcome of result) {
      if (outcome.status === "approaching") approachingCount += 1;
      if (outcome.status === "due") dueCount += 1;
      const records = ledgerByEnrollment.get(outcome.enrollmentKey) ?? [];
      const prior = priorCycleStates.get(outcome.enrollmentKey) ?? null;
      await upsertCycleState(buildCycleStateRow(outcome, records, prior), db);

      // Capture enrollments newly transitioning to approaching for step 5.
      if (outcome.shouldNotifyTeacher) {
        const tutor = computeMostFrequentTutor(records, outcome.currentCycleStart);
        const sample = records.find((record) => record.countsTowardCycle && !record.isProgressTest) ?? records[0];
        notifying.push({
          enrollmentKey: outcome.enrollmentKey,
          cycleIndex: outcome.cycleIndex,
          studentName: sample?.studentName ?? prior?.studentName ?? "the student",
          subject: sample?.subject ?? prior?.subject ?? "",
          currentCount: outcome.currentCount,
          mostFrequentTutorCanonicalKey: tutor.canonicalKey,
          mostFrequentTutorDisplayName: tutor.displayName,
        });
      }
    }

    const unresolvedTeacherCount = issues.length;

    // Step 5: generate AI summaries + send teacher heads-up emails. Fail-isolated
    // — a notification/AI error must never fail the sync run.
    let notificationCount = 0;
    try {
      notificationCount = await runTeacherHeadsUpStep(db, syncRunId, notifying, now, deps.sender);
    } catch (notifyError) {
      const message = notifyError instanceof Error ? notifyError.message : "Teacher heads-up step failed";
      console.error(`progress-test sync teacher heads-up step failed: ${message}`);
    }

    // Step 6: finalize the run row + sweep the cache.
    await db
      .update(schema.progressTestSyncRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        ledgerRowCount: ledgerRows.length,
        enrollmentCount: result.length,
        approachingCount,
        dueCount,
        notificationCount,
        metadata: {
          attendedSessions: attendedSessions.length,
          wiseSessionsFetched: wiseSessions.length,
          unresolvedTeacherCount,
          notificationCount,
        },
      })
      .where(eq(schema.progressTestSyncRuns.id, syncRunId));

    revalidateTag(PROGRESS_TESTS_CACHE_TAG, { expire: 0 });

    return {
      success: true,
      ledgerRowCount: ledgerRows.length,
      enrollmentCount: result.length,
      approachingCount,
      dueCount,
      unresolvedTeacherCount,
      notificationCount,
    };
  } catch (error) {
    const errorSummary = shortErrorSummary(error);
    await db
      .update(schema.progressTestSyncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorSummary,
        metadata: sql`${schema.progressTestSyncRuns.metadata} || ${JSON.stringify({ error: errorSummary })}::jsonb`,
      })
      .where(eq(schema.progressTestSyncRuns.id, syncRunId));

    return {
      success: false,
      ledgerRowCount: 0,
      enrollmentCount: 0,
      approachingCount: 0,
      dueCount: 0,
      unresolvedTeacherCount: 0,
      notificationCount: 0,
      errorSummary,
    };
  }
}
