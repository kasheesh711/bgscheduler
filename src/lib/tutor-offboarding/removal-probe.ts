import { getWiseTeacherDisplayName, getWiseTeacherUserId, getWiseUserId, type WiseSession, type WiseTeacher } from "@/lib/wise/types";

export const REMOVAL_PROBE_NAME = "ZZ BGS Removal Probe";
export const REMOVAL_PROBE_CONFIRMATION = "remove-probe-teacher";

export class RemovalProbeGuardError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "RemovalProbeGuardError";
  }
}

export interface RemovalProbeInput { teacherId: string; confirmation: string }
export interface RemovalProbeDependencies {
  readBefore: () => Promise<{ roster: WiseTeacher[]; sessions: WiseSession[] }>;
  removeOnce: (userId: string) => Promise<{ status: "sent" | "rejected" | "unknown"; httpStatus?: number | null }>;
  readAfter: () => Promise<WiseTeacher[]>;
}

export function validateRemovalProbeInput(input: RemovalProbeInput): void {
  if (!/^[a-f0-9]{24}$/i.test(input.teacherId)) throw new RemovalProbeGuardError("explicit_teacher_id_required");
  if (input.confirmation !== REMOVAL_PROBE_CONFIRMATION) throw new RemovalProbeGuardError("typed_confirmation_required");
}

function validateRoster(roster: WiseTeacher[]): void {
  if (!Array.isArray(roster) || roster.length === 0 || roster.some(t => !t?._id || !getWiseTeacherUserId(t)) || new Set(roster.map(t => t._id)).size !== roster.length) {
    throw new RemovalProbeGuardError("complete_nonempty_roster_required");
  }
}

/** This stricter guard is for the owner-created dummy only; it never selects an ordinary tutor. */
export function findRemovalProbeTarget(input: RemovalProbeInput, roster: WiseTeacher[], sessions: WiseSession[]): WiseTeacher {
  validateRemovalProbeInput(input);
  validateRoster(roster);
  const target = roster.find(t => t._id === input.teacherId);
  if (!target) throw new RemovalProbeGuardError("probe_teacher_not_present");
  const names = [getWiseTeacherDisplayName(target), target.name].filter((n): n is string => Boolean(n?.trim()));
  if (!names.length || names.some(n => !n.startsWith(REMOVAL_PROBE_NAME))) throw new RemovalProbeGuardError("probe_name_required");
  if (target.relation !== "TEACHER") throw new RemovalProbeGuardError("probe_must_be_teacher");
  if (!Array.isArray(target.classes) || target.classes.length !== 0) throw new RemovalProbeGuardError("probe_must_have_no_courses");
  const userId = getWiseTeacherUserId(target)!;
  if (roster.filter(t => getWiseTeacherUserId(t) === userId).length !== 1) throw new RemovalProbeGuardError("probe_user_must_be_unique");
  if (!Array.isArray(sessions)) throw new RemovalProbeGuardError("complete_session_read_required");
  for (const session of sessions) {
    const ids = [getWiseUserId(session.userId), session.teacherId].filter((id): id is string => Boolean(id));
    if (ids.length === 0) throw new RemovalProbeGuardError("session_teacher_unknown");
    if (ids.includes(userId) || ids.includes(target._id)) throw new RemovalProbeGuardError("probe_must_have_no_sessions");
  }
  return target;
}

/** No retry or alternate ID exists in this runner. Errors expose no response body or credentials. */
export async function runRemovalProbe(input: RemovalProbeInput, deps: RemovalProbeDependencies) {
  validateRemovalProbeInput(input);
  const before = await deps.readBefore();
  const target = findRemovalProbeTarget(input, before.roster, before.sessions);
  const userId = getWiseTeacherUserId(target)!;
  let requestOutcome: "sent" | "rejected" | "unknown" = "sent";
  let httpStatus: number | null = null;
  try {
    const result = await deps.removeOnce(userId);
    requestOutcome = result.status;
    httpStatus = result.httpStatus ?? null;
  } catch (error) {
    const candidate = typeof error === "object" && error !== null && "status" in error ? error.status : null;
    httpStatus = typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599 ? candidate : null;
    requestOutcome = httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 ? "rejected" : "unknown";
  }
  let readback: "absent" | "present" | "unknown" = "unknown";
  try {
    const after = await deps.readAfter();
    validateRoster(after);
    readback = after.some(t => t._id === target._id || getWiseTeacherUserId(t) === userId) ? "present" : "absent";
  } catch { /* A failed read cannot prove the request failed. Never send again. */ }
  return {
    teacherId: target._id, userId, requestOutcome, httpStatus, readback,
    endpointVerified: requestOutcome === "sent" && readback === "absent",
    nextStep: requestOutcome === "sent" && readback === "absent"
      ? "Re-invite this dummy in Wise, record whether its user ID is unchanged, and record the results before enabling live removal."
      : "Do not retry or substitute the teacher ID. Inspect the dummy in Wise and resolve the result before enabling live removal.",
  };
}
