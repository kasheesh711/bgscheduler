// Progress Tests — Wise booking write path.
//
// A human admin confirms each progress-test booking; this module records the
// intended booking (always, for audit), runs a fail-closed availability
// pre-check, and — only when WISE_SESSION_CREATE_VERIFIED is on — performs the
// real Wise session-create write. The locally-stored booked test date drives the
// automatic cycle reset regardless of whether Wise was actually written, so a
// dry-run/manual booking still advances the cycle once the date passes.
//
// Mirrors the LINE dry-run gate (src/lib/wise/operations.ts confirmLineWiseAction):
// flag off → status manual_required, NO Wise call; flag on → real write.
//
// Never log secrets, PII, or feedback text.

import { revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createWiseClient, type WiseClient } from "@/lib/wise/client";
import {
  checkTeacherAvailabilityForSessions,
  scheduleWiseSession,
  type WiseSessionAvailabilityResponse,
} from "@/lib/wise/fetchers";
import {
  PROGRESS_TESTS_CACHE_TAG,
  wiseSessionCreateVerified,
} from "./config";
import {
  insertBooking,
  loadCycleState,
  markLedgerRowAsProgressTest,
  resolveTeacherUserIdForCanonicalKey,
  upsertCycleState,
  type ProgressTestBookingRecord,
  type ProgressTestCycleStateInsert,
  type ProgressTestCycleStateRecord,
} from "./db";
import type { ProgressTestBookingMode, ProgressTestScheduleMethod } from "./types";

const PROGRESS_TEST_SESSION_TITLE = "Progress Test";

/** Terminal/intermediate status of a booking row (mirrors the schema pgEnum). */
export type ProgressTestBookingStatus =
  (typeof schema.progressTestBookingStatusEnum.enumValues)[number];

/** Minimal actor identity recorded on a booking row (already authorized upstream). */
export interface ProgressTestActor {
  email?: string | null;
  name?: string | null;
}

/** Input for confirming a progress-test booking (the admin-confirmed write path). */
export interface ConfirmProgressTestBookingInput {
  enrollmentKey: string;
  scheduledTestStart: Date;
  scheduledTestEnd: Date;
  location?: string | null;
  /** How this test is being scheduled ("after_class" | "parent_pick"). */
  scheduleMethod: ProgressTestScheduleMethod;
  actor?: ProgressTestActor;
  db?: Database;
  client?: WiseClient;
  instituteId?: string;
}

/** Outcome of a confirm-booking attempt. */
export interface ConfirmProgressTestBookingResult {
  booking: ProgressTestBookingRecord;
  status: ProgressTestBookingStatus;
  wiseSessionId: string | null;
  bookingMode: ProgressTestBookingMode | null;
  message: string;
}

/** Input for recording a booking an admin already made directly in Wise. */
export interface MarkProgressTestBookedManuallyInput {
  enrollmentKey: string;
  wiseSessionId: string;
  scheduledTestStart?: Date | null;
  scheduleMethod?: ProgressTestScheduleMethod;
  location?: string | null;
  actor?: ProgressTestActor;
  db?: Database;
}

/** Input for marking a progress test complete (manual cycle-roll override). */
export interface MarkProgressTestCompleteInput {
  enrollmentKey: string;
  actor?: ProgressTestActor;
  db?: Database;
}

function normalizeActor(actor: ProgressTestActor | undefined): { email: string | null; name: string | null } {
  return {
    email: actor?.email?.trim().toLowerCase() || null,
    name: actor?.name?.trim() || null,
  };
}

function resolveInstituteId(explicit: string | undefined): string {
  return explicit ?? process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
}

/**
 * Detects whether an availability response reports any conflict (fail-closed).
 *
 * Treats either per-session flag (`conflict` or `hasConflict`) as a blocker;
 * anything ambiguous is left to the caller. A malformed/empty response carries
 * no positive proof of availability, so the caller must still treat it as safe
 * only when no conflict flag is set.
 *
 * @returns true when at least one returned session is marked conflicting.
 */
function hasAvailabilityConflict(response: WiseSessionAvailabilityResponse): boolean {
  return (response.sessions ?? []).some(
    (session) => session.conflict === true || session.hasConflict === true,
  );
}

/**
 * Builds the full cycle-state upsert shape from a loaded record.
 *
 * upsertCycleState takes a complete insert row, so we start from the persisted
 * record and let callers override only the fields they change.
 *
 * @returns the cycle-state insert row mirroring the loaded record.
 */
function cycleStateToInsert(record: ProgressTestCycleStateRecord): ProgressTestCycleStateInsert {
  return {
    enrollmentKey: record.enrollmentKey,
    wiseStudentId: record.wiseStudentId,
    wiseClassId: record.wiseClassId,
    studentKey: record.studentKey,
    studentName: record.studentName,
    subject: record.subject,
    currentCount: record.currentCount,
    currentCycleStart: record.currentCycleStart,
    cycleIndex: record.cycleIndex,
    status: record.status,
    bookedTestWiseSessionId: record.bookedTestWiseSessionId,
    bookedTestDate: record.bookedTestDate,
    bookedTestBookingMode: record.bookedTestBookingMode,
    scheduleMethod: record.scheduleMethod,
    bookedTestLocation: record.bookedTestLocation,
    atHomeSelectedAt: record.atHomeSelectedAt,
    atHomeSubmittedAt: record.atHomeSubmittedAt,
    teacherNotifiedAt: record.teacherNotifiedAt,
    teacherNotifiedForCycle: record.teacherNotifiedForCycle,
    mostFrequentTutorCanonicalKey: record.mostFrequentTutorCanonicalKey,
    mostFrequentTutorDisplayName: record.mostFrequentTutorDisplayName,
    lastAiSummary: record.lastAiSummary,
    lastAiSummaryAt: record.lastAiSummaryAt,
    lastClassDate: record.lastClassDate,
    updatedByEmail: record.updatedByEmail,
  };
}

/**
 * Confirms a progress-test booking after a human admin's explicit request.
 *
 * 1. Record the intended booking in progress_test_bookings (status recorded,
 *    dryRun true) with the intended Wise body + endpoint string as requestPayload
 *    — always, before any network call, so every attempt is auditable.
 * 2. Load the enrollment's cycle state, resolve the Wise classId (cycle_state
 *    wiseClassId) and the teacher userId (most-frequent tutor's canonicalKey →
 *    a ledger wiseTeacherUserId). If either cannot be resolved, finalize the
 *    booking as manual_required and stop (no Wise call).
 * 3. Availability pre-check via checkTeacherAvailabilityForSessions; ABORT
 *    fail-closed (status failed) on any reported conflict — never book over one.
 * 4. Gate on WISE_SESSION_CREATE_VERIFIED: when off, finalize manual_required
 *    with NO Wise call; when on, call scheduleWiseSession and finalize
 *    wise_created, storing the returned sessionId.
 * 5. Update cycle_state to scheduled (bookedTestDate/bookedTestWiseSessionId/
 *    bookedTestBookingMode), mark the matching ledger row as the progress test
 *    (excluded from counting), and revalidate the progress-tests cache tag.
 *
 * @returns the persisted booking row, final status, any Wise session id, and a message.
 */
export async function confirmProgressTestBooking(
  input: ConfirmProgressTestBookingInput,
): Promise<ConfirmProgressTestBookingResult> {
  const db = input.db ?? getDb();
  const instituteId = resolveInstituteId(input.instituteId);
  const actor = normalizeActor(input.actor);
  const location = input.location?.trim() || null;

  const cycleState = await loadCycleState(input.enrollmentKey, db);
  const [fallbackClassId, fallbackStudentId] = input.enrollmentKey.split("|");
  const wiseClassId = cycleState?.wiseClassId ?? fallbackClassId ?? "";
  const wiseStudentId = cycleState?.wiseStudentId ?? fallbackStudentId ?? "";
  const cycleIndex = cycleState?.cycleIndex ?? 0;

  // Step 2 (resolve teacher early so the audit payload reflects the intended call).
  const canonicalKey = cycleState?.mostFrequentTutorCanonicalKey ?? null;
  const teacherUserId = canonicalKey
    ? await resolveTeacherUserIdForCanonicalKey(canonicalKey, db)
    : null;

  const endpoint = `/teacher/classes/${wiseClassId}/sessions`;
  const intendedBody = {
    userId: teacherUserId,
    title: PROGRESS_TEST_SESSION_TITLE,
    sessions: [
      {
        type: "SINGLE",
        scheduledStartTime: input.scheduledTestStart.toISOString(),
        scheduledEndTime: input.scheduledTestEnd.toISOString(),
        ...(location ? { location } : {}),
      },
    ],
  };

  // Step 1: record the intended booking (audit) before any network call.
  const booking = await insertBooking({
    enrollmentKey: input.enrollmentKey,
    cycleIndex,
    status: "recorded",
    dryRun: true,
    scheduledTestDate: input.scheduledTestStart,
    wiseClassId,
    wiseStudentId,
    wiseTeacherUserId: teacherUserId,
    location,
    requestPayload: { endpoint, body: intendedBody },
    createdByEmail: actor.email,
    createdByName: actor.name,
  }, db);

  // Step 2 (gate): without a class id or a resolvable teacher we cannot book in
  // Wise — record manual_required and let an admin book it directly.
  if (!wiseClassId || !teacherUserId) {
    const message = !wiseClassId
      ? "Cannot resolve the Wise class for this enrollment; book the progress test manually."
      : "Cannot resolve the most-frequent teacher's Wise user id; book the progress test manually.";
    await finalizeBooking(db, booking.id, {
      status: "manual_required",
      errorMessage: message,
    });
    await applyScheduledCycleState(db, {
      cycleState,
      enrollmentKey: input.enrollmentKey,
      wiseClassId,
      wiseStudentId,
      bookedTestDate: input.scheduledTestStart,
      bookedTestWiseSessionId: null,
      bookingMode: "manual",
      scheduleMethod: input.scheduleMethod,
      location,
      actorEmail: actor.email,
    });
    revalidateTag(PROGRESS_TESTS_CACHE_TAG, { expire: 0 });
    return {
      booking,
      status: "manual_required",
      wiseSessionId: null,
      bookingMode: "manual",
      message,
    };
  }

  // Step 3: availability pre-check — abort fail-closed on any conflict.
  const availability = await checkTeacherAvailabilityForSessions(input.client ?? createWiseClient(), instituteId, {
    teacherId: teacherUserId,
    sessions: [
      {
        teacherId: teacherUserId,
        classId: wiseClassId,
        scheduledStartTime: input.scheduledTestStart.toISOString(),
        scheduledEndTime: input.scheduledTestEnd.toISOString(),
        type: "SINGLE",
      },
    ],
    ...(location ? { locationToCheck: location } : {}),
  });

  if (hasAvailabilityConflict(availability)) {
    const message = "Wise reports a scheduling conflict for the teacher at this time; booking aborted.";
    await finalizeBooking(db, booking.id, {
      status: "failed",
      errorMessage: message,
      responsePayload: { availability: availability as Record<string, unknown> },
    });
    revalidateTag(PROGRESS_TESTS_CACHE_TAG, { expire: 0 });
    return { booking, status: "failed", wiseSessionId: null, bookingMode: null, message };
  }

  // Step 4: gate on the verified flag.
  if (!wiseSessionCreateVerified()) {
    const message =
      "Wise session-create write is not verified in this environment; recorded locally — book the progress test manually.";
    await finalizeBooking(db, booking.id, { status: "manual_required", errorMessage: message });
    await applyScheduledCycleState(db, {
      cycleState,
      enrollmentKey: input.enrollmentKey,
      wiseClassId,
      wiseStudentId,
      bookedTestDate: input.scheduledTestStart,
      bookedTestWiseSessionId: null,
      bookingMode: "manual",
      scheduleMethod: input.scheduleMethod,
      location,
      actorEmail: actor.email,
    });
    revalidateTag(PROGRESS_TESTS_CACHE_TAG, { expire: 0 });
    return { booking, status: "manual_required", wiseSessionId: null, bookingMode: "manual", message };
  }

  // Step 4 (write): flag on — perform the real Wise create.
  const client = input.client ?? createWiseClient();
  const created = await scheduleWiseSession(client, {
    classId: wiseClassId,
    userId: teacherUserId,
    title: PROGRESS_TEST_SESSION_TITLE,
    scheduledStartTime: input.scheduledTestStart.toISOString(),
    scheduledEndTime: input.scheduledTestEnd.toISOString(),
    ...(location ? { location } : {}),
  });

  await finalizeBooking(db, booking.id, {
    status: "wise_created",
    dryRun: false,
    wiseSessionId: created.sessionId,
    responsePayload: { sessionId: created.sessionId },
  });

  // Step 5: update cycle state to scheduled + flag the booked ledger row.
  await applyScheduledCycleState(db, {
    cycleState,
    enrollmentKey: input.enrollmentKey,
    wiseClassId,
    wiseStudentId,
    bookedTestDate: input.scheduledTestStart,
    bookedTestWiseSessionId: created.sessionId,
    bookingMode: "wise",
    scheduleMethod: input.scheduleMethod,
    location,
    actorEmail: actor.email,
  });
  if (created.sessionId) {
    await markLedgerRowAsProgressTest(created.sessionId, wiseStudentId, db);
  }
  revalidateTag(PROGRESS_TESTS_CACHE_TAG, { expire: 0 });

  return {
    booking,
    status: "wise_created",
    wiseSessionId: created.sessionId,
    bookingMode: "wise",
    message: "Progress test booked into Wise.",
  };
}

/**
 * Records a progress test an admin booked directly in Wise.
 *
 * 1. Record a manual_confirmed booking row carrying the supplied wiseSessionId.
 * 2. Set cycle_state to scheduled (manual mode), storing the session id + booked
 *    date, and mark the matching ledger row as the progress test.
 * 3. Revalidate the progress-tests cache tag.
 *
 * @returns the persisted booking row.
 */
export async function markProgressTestBookedManually(
  input: MarkProgressTestBookedManuallyInput,
): Promise<ProgressTestBookingRecord> {
  const db = input.db ?? getDb();
  const actor = normalizeActor(input.actor);
  const cycleState = await loadCycleState(input.enrollmentKey, db);
  const [fallbackClassId, fallbackStudentId] = input.enrollmentKey.split("|");
  const wiseClassId = cycleState?.wiseClassId ?? fallbackClassId ?? "";
  const wiseStudentId = cycleState?.wiseStudentId ?? fallbackStudentId ?? "";
  const bookedTestDate = input.scheduledTestStart ?? cycleState?.bookedTestDate ?? null;

  const booking = await insertBooking({
    enrollmentKey: input.enrollmentKey,
    cycleIndex: cycleState?.cycleIndex ?? 0,
    status: "manual_confirmed",
    dryRun: false,
    scheduledTestDate: bookedTestDate,
    wiseClassId,
    wiseStudentId,
    wiseSessionId: input.wiseSessionId,
    requestPayload: { mode: "manual_confirmed" },
    createdByEmail: actor.email,
    createdByName: actor.name,
  }, db);

  await applyScheduledCycleState(db, {
    cycleState,
    enrollmentKey: input.enrollmentKey,
    wiseClassId,
    wiseStudentId,
    bookedTestDate,
    bookedTestWiseSessionId: input.wiseSessionId,
    bookingMode: "manual",
    scheduleMethod: input.scheduleMethod ?? "parent_pick",
    location: input.location?.trim() || null,
    actorEmail: actor.email,
  });
  await markLedgerRowAsProgressTest(input.wiseSessionId, wiseStudentId, db);
  revalidateTag(PROGRESS_TESTS_CACHE_TAG, { expire: 0 });

  return booking;
}

/**
 * Marks a progress test complete, immediately rolling the cycle (manual override).
 *
 * The primary reset is automatic when the booked test date passes (handled by
 * the nightly sync engine); this is the admin's manual override. It bumps
 * cycleIndex, sets currentCycleStart = now, clears the booked + notify fields,
 * resets currentCount to 0, and returns status to accumulating so the next cycle
 * starts fresh. No-ops when the enrollment has no cycle state.
 *
 * @returns true when a cycle was rolled; false when no cycle state existed.
 */
export async function markProgressTestComplete(
  input: MarkProgressTestCompleteInput,
): Promise<boolean> {
  const db = input.db ?? getDb();
  const actor = normalizeActor(input.actor);
  const cycleState = await loadCycleState(input.enrollmentKey, db);
  if (!cycleState) return false;

  const now = new Date();
  await upsertCycleState({
    ...cycleStateToInsert(cycleState),
    currentCount: 0,
    currentCycleStart: now,
    cycleIndex: cycleState.cycleIndex + 1,
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
    updatedByEmail: actor.email,
  }, db);
  revalidateTag(PROGRESS_TESTS_CACHE_TAG, { expire: 0 });

  return true;
}

/** Input for the at-home option actions. */
export interface AtHomeOptionInput {
  enrollmentKey: string;
  actor?: ProgressTestActor;
  db?: Database;
}

/**
 * Logs that an enrollment's progress test will be taken AT HOME (no Wise booking).
 *
 * Records an audit row and sets the cycle state to "scheduled" with
 * scheduleMethod="at_home" + atHomeSelectedAt=now (clearing any prior booked/at-home
 * fields). The student is no longer "due" while the at-home test is outstanding;
 * markAtHomeSubmitted later rolls the cycle. No-ops when no cycle state exists.
 *
 * @returns true when the at-home option was recorded; false when the enrollment was unknown.
 */
export async function selectAtHomeOption(input: AtHomeOptionInput): Promise<boolean> {
  const db = input.db ?? getDb();
  const actor = normalizeActor(input.actor);
  const cycleState = await loadCycleState(input.enrollmentKey, db);
  if (!cycleState) return false;

  const now = new Date();
  await insertBooking({
    enrollmentKey: input.enrollmentKey,
    cycleIndex: cycleState.cycleIndex,
    status: "recorded",
    dryRun: true,
    scheduledTestDate: null,
    wiseClassId: cycleState.wiseClassId,
    wiseStudentId: cycleState.wiseStudentId,
    requestPayload: { mode: "at_home_selected" },
    createdByEmail: actor.email,
    createdByName: actor.name,
  }, db);

  await upsertCycleState({
    ...cycleStateToInsert(cycleState),
    status: "scheduled",
    scheduleMethod: "at_home",
    bookedTestWiseSessionId: null,
    bookedTestDate: null,
    bookedTestBookingMode: null,
    bookedTestLocation: null,
    atHomeSelectedAt: now,
    atHomeSubmittedAt: null,
    updatedByEmail: actor.email,
  }, db);
  revalidateTag(PROGRESS_TESTS_CACHE_TAG, { expire: 0 });

  return true;
}

/**
 * Logs that an at-home progress test has been submitted, then rolls the cycle.
 *
 * Records an audit row (its createdAt is the submission time) and immediately
 * rolls the cycle (cycleIndex+1, currentCount=0, status accumulating, clearing the
 * booked + at-home + notify fields) — i.e. the at-home submission counts as the
 * test done, exactly like markProgressTestComplete. No-ops when no cycle state exists.
 *
 * @returns true when the submission rolled the cycle; false when the enrollment was unknown.
 */
export async function markAtHomeSubmitted(input: AtHomeOptionInput): Promise<boolean> {
  const db = input.db ?? getDb();
  const actor = normalizeActor(input.actor);
  const cycleState = await loadCycleState(input.enrollmentKey, db);
  if (!cycleState) return false;

  const now = new Date();
  await insertBooking({
    enrollmentKey: input.enrollmentKey,
    cycleIndex: cycleState.cycleIndex,
    status: "manual_confirmed",
    dryRun: true,
    scheduledTestDate: cycleState.atHomeSelectedAt,
    wiseClassId: cycleState.wiseClassId,
    wiseStudentId: cycleState.wiseStudentId,
    requestPayload: { mode: "at_home_submitted" },
    createdByEmail: actor.email,
    createdByName: actor.name,
  }, db);

  await upsertCycleState({
    ...cycleStateToInsert(cycleState),
    currentCount: 0,
    currentCycleStart: now,
    cycleIndex: cycleState.cycleIndex + 1,
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
    updatedByEmail: actor.email,
  }, db);
  revalidateTag(PROGRESS_TESTS_CACHE_TAG, { expire: 0 });

  return true;
}

/**
 * Finalizes a booking row with its terminal status + optional payloads.
 */
async function finalizeBooking(
  db: Database,
  bookingId: string,
  patch: {
    status: ProgressTestBookingStatus;
    dryRun?: boolean;
    wiseSessionId?: string | null;
    errorMessage?: string | null;
    responsePayload?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db
    .update(schema.progressTestBookings)
    .set({
      status: patch.status,
      ...(patch.dryRun !== undefined ? { dryRun: patch.dryRun } : {}),
      ...(patch.wiseSessionId !== undefined ? { wiseSessionId: patch.wiseSessionId } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      ...(patch.responsePayload !== undefined ? { responsePayload: patch.responsePayload } : {}),
    })
    .where(eq(schema.progressTestBookings.id, bookingId));
}

/**
 * Writes the "scheduled" cycle-state transition for a booked enrollment.
 *
 * Preserves all other cycle fields (count/cycleIndex/tutor/etc.) and overlays
 * the booked-test fields + status so the engine treats the enrollment as
 * scheduled until the date passes (then auto-resets). When no prior cycle state
 * exists, seeds a minimal scheduled row keyed by the enrollment.
 */
async function applyScheduledCycleState(
  db: Database,
  params: {
    cycleState: ProgressTestCycleStateRecord | null;
    enrollmentKey: string;
    wiseClassId: string;
    wiseStudentId: string;
    bookedTestDate: Date | null;
    bookedTestWiseSessionId: string | null;
    bookingMode: ProgressTestBookingMode;
    scheduleMethod: ProgressTestScheduleMethod;
    location: string | null;
    actorEmail: string | null;
  },
): Promise<void> {
  const base: ProgressTestCycleStateInsert = params.cycleState
    ? cycleStateToInsert(params.cycleState)
    : {
      enrollmentKey: params.enrollmentKey,
      wiseStudentId: params.wiseStudentId,
      wiseClassId: params.wiseClassId,
      studentKey: "",
      studentName: "",
      subject: "",
      currentCount: 0,
      currentCycleStart: null,
      cycleIndex: 0,
      status: "scheduled",
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
    };

  await upsertCycleState({
    ...base,
    status: "scheduled",
    bookedTestDate: params.bookedTestDate,
    bookedTestWiseSessionId: params.bookedTestWiseSessionId,
    bookedTestBookingMode: params.bookingMode,
    scheduleMethod: params.scheduleMethod,
    bookedTestLocation: params.location,
    // A Wise/parent-pick booking is not at-home; clear any prior at-home state.
    atHomeSelectedAt: null,
    atHomeSubmittedAt: null,
    updatedByEmail: params.actorEmail,
  }, db);
}
