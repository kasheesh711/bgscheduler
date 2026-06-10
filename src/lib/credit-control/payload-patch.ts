// ---------------------------------------------------------------------------
// Payload patch helpers — pure client-side optimistic updates
//
// The dashboard shell applies these to its in-memory DashboardPayload so user
// actions render instantly instead of waiting on a full payload rebuild. The
// server stays authoritative: every mutation is followed by a background
// refresh whose payload replaces the locally patched one.
// ---------------------------------------------------------------------------

import type {
  ActionState,
  DashboardPayload,
  InactiveStudentSummary,
  StudentQueueRow,
} from "@/types/credit-control";

/** Worklist rows captured before an optimistic removal, used to revert/undo. */
export interface RemovedQueueRows {
  queueRow: StudentQueueRow | null;
  queueAllRow: StudentQueueRow | null;
}

/** Minimal student shape needed to build an optimistic inactive entry. */
export interface InactiveEntrySource {
  studentKey: string;
  student: string;
  parent: string;
  packages: ReadonlyArray<{ currentRemaining: number }>;
}

/**
 * Patch a student's follow-up action state across every list the UI reads:
 * `students` (detail pane), `studentQueue` (at-risk worklist), and
 * `studentQueueAll` (search-all worklist) — so optimistic action pills also
 * show on rows surfaced by an active search. Untouched rows keep their
 * references so memoized row components skip re-rendering.
 */
export function patchActionStateInPayload(
  payload: DashboardPayload,
  studentKey: string,
  actionState: ActionState | null,
): DashboardPayload {
  const patchRows = (rows: StudentQueueRow[]) =>
    rows.map((row) => (row.studentKey === studentKey ? { ...row, actionState } : row));

  return {
    ...payload,
    students: payload.students.map((student) =>
      student.studentKey === studentKey ? { ...student, actionState } : student,
    ),
    studentQueue: patchRows(payload.studentQueue),
    studentQueueAll: payload.studentQueueAll
      ? patchRows(payload.studentQueueAll)
      : payload.studentQueueAll,
  };
}

/**
 * Build the inactive-list entry shown while the server reconciles a manual
 * removal. Mirrors POST /api/credit-control/inactive: `source: "manual"` and
 * `removedAtRemaining` summed from the packages' current remaining credits.
 */
export function buildOptimisticInactiveEntry(
  student: InactiveEntrySource,
  markedAt: string,
): InactiveStudentSummary {
  return {
    studentKey: student.studentKey,
    student: student.student,
    parent: student.parent,
    source: "manual",
    markedAt,
    removedAtRemaining: student.packages.reduce((sum, pkg) => sum + pkg.currentRemaining, 0),
  };
}

/** Capture a student's worklist rows before removal so a revert/undo can re-insert them. */
export function captureWorklistRows(
  payload: DashboardPayload,
  studentKey: string,
): RemovedQueueRows {
  return {
    queueRow: payload.studentQueue.find((row) => row.studentKey === studentKey) ?? null,
    queueAllRow:
      payload.studentQueueAll?.find((row) => row.studentKey === studentKey) ?? null,
  };
}

/**
 * Optimistically remove a student from the worklist after "mark inactive".
 * Deliberately leaves `students` and `calendar` untouched: calendar entries
 * address `students` by `studentIndex`, so removing from `students` would
 * shift indices and mis-target `openStudentByIndex` until the background
 * refresh lands. The worklist itself only reads the queue arrays.
 */
export function removeStudentFromWorklist(
  payload: DashboardPayload,
  studentKey: string,
  inactiveEntry: InactiveStudentSummary,
): DashboardPayload {
  return {
    ...payload,
    studentQueue: payload.studentQueue.filter((row) => row.studentKey !== studentKey),
    studentQueueAll: payload.studentQueueAll
      ? payload.studentQueueAll.filter((row) => row.studentKey !== studentKey)
      : payload.studentQueueAll,
    inactiveStudents: [
      ...(payload.inactiveStudents ?? []).filter((entry) => entry.studentKey !== studentKey),
      inactiveEntry,
    ],
  };
}

/**
 * Inverse of removeStudentFromWorklist — reverts a failed removal or applies
 * an optimistic restore/undo. Re-inserted rows are appended; the shell
 * re-sorts the worklist client-side, so position does not matter. When no
 * rows were captured (restoring a student removed in an earlier session),
 * only the inactive entry is dropped and the background refresh re-adds the
 * worklist rows.
 */
export function restoreStudentToWorklist(
  payload: DashboardPayload,
  studentKey: string,
  removed: RemovedQueueRows | null,
): DashboardPayload {
  const studentQueue =
    removed?.queueRow && !payload.studentQueue.some((row) => row.studentKey === studentKey)
      ? [...payload.studentQueue, removed.queueRow]
      : payload.studentQueue;
  const studentQueueAll =
    removed?.queueAllRow &&
    payload.studentQueueAll &&
    !payload.studentQueueAll.some((row) => row.studentKey === studentKey)
      ? [...payload.studentQueueAll, removed.queueAllRow]
      : payload.studentQueueAll;

  return {
    ...payload,
    studentQueue,
    studentQueueAll,
    inactiveStudents: (payload.inactiveStudents ?? []).filter(
      (entry) => entry.studentKey !== studentKey,
    ),
  };
}
