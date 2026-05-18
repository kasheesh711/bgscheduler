// web/src/lib/dashboard/action-helpers.ts
// SVC-03 — Sync helper functions for follow-up action state.
//
// Co-located with actions.ts but split out so actions.ts can carry the
// 'use server' file directive (which requires every export be an async
// function — Next.js 16 SWC enforces this at build time, not just runtime).
// These helpers were originally in actions.ts; the SVC-03 split keeps the
// public API surface stable via re-export from actions.ts (server-side
// callers can still write `import { ... } from "@/lib/credit-control/actions"`).
//
// Imported by service.ts, route handlers, sheets/actions.ts (Wave 5
// deletion), build.ts, and the test suite. All consumers are server-side
// or test — there is no client-component caller.
import { formatDate, parseDate } from "@/lib/credit-control/helpers";
import type { ActionState, StudentActionStatus, StudentRecord } from "@/types/credit-control";

const VALID_STATUSES: StudentActionStatus[] = ["contacted", "pending-callback", "resolved"];

export function normalizeStudentActionStatus(status: unknown): StudentActionStatus | null {
  const normalized = String(status ?? "").trim().toLowerCase();
  return VALID_STATUSES.includes(normalized as StudentActionStatus)
    ? (normalized as StudentActionStatus)
    : null;
}

export function sanitizeStudentActionState(
  actionState: ActionState | null | undefined,
  today: Date,
): ActionState | null {
  if (!actionState || !actionState.status || !normalizeStudentActionStatus(actionState.status)) {
    return null;
  }

  return {
    status: actionState.status,
    updatedAt: actionState.updatedAt,
    updatedByName: actionState.updatedByName || "",
    isToday: isActionStateToday(actionState.updatedAt, today),
  };
}

export function attachActionStatesToStudents(
  students: StudentRecord[],
  today: Date,
  actionStatesByKey: Record<string, ActionState | null>,
) {
  students.forEach((student) => {
    student.actionState = sanitizeStudentActionState(actionStatesByKey[student.studentKey], today);
  });
}

export function isActionStateToday(updatedAt: string, today: Date) {
  const parsed = parseDate(updatedAt);
  return !!parsed && formatDate(parsed) === formatDate(today);
}
