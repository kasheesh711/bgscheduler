// Progress Tests — shared configuration constants and key builders.
//
// The counting window starts at 2026-03-01 (Asia/Bangkok), the post-migration
// boundary used elsewhere (see ROOM_UTILIZATION_HISTORY_START in
// src/lib/room-capacity/utilization.ts). Earlier Wise data is unreliable.

/** Inclusive start of the attended-with-credit counting window (Asia/Bangkok). */
export const PROGRESS_TEST_COUNTING_START = new Date("2026-03-01T00:00:00+07:00");

/** A student is "due" for a progress test after this many attended-with-credit classes. */
export const PROGRESS_TEST_THRESHOLD = 8;

/** The most-frequent teacher is notified once the count reaches this value (before the 7th class). */
export const PROGRESS_TEST_APPROACHING_AT = 6;

/** Next.js cache tag swept after a progress-test sync. */
export const PROGRESS_TESTS_CACHE_TAG = "progress-tests";

/** A progress-test sync run still marked `running` past this age is treated as abandoned. */
export const STALE_RUNNING_PROGRESS_TEST_SYNC_MS = 20 * 60 * 1000;

/**
 * Builds the per-student-per-subject enrollment key used as the cycle-state PK
 * and the ledger grouping key.
 *
 * @returns `${wiseClassId}|${wiseStudentId}` — the canonical enrollment identifier.
 */
export function buildEnrollmentKey(wiseClassId: string, wiseStudentId: string): string {
  return `${wiseClassId}|${wiseStudentId}`;
}
