import { createHash } from "node:crypto";
import { isBlockingStatus } from "@/lib/normalization/sessions";
import { getWiseSessionTeacherUserId, getWiseTeacherUserId, type WiseTeacher, type WiseSession } from "@/lib/wise/types";
import type { RemovalMode } from "./removal-types";

export function removalMode(env: Record<string, string | undefined> = process.env): RemovalMode {
  return env.VERCEL_ENV === "production" && env.WISE_TEACHER_REMOVAL_VERIFIED === "true" ? "live" : "manual";
}
export function assertCompleteRoster(roster: WiseTeacher[]): void {
  if (!Array.isArray(roster) || !roster.length) throw new Error("A complete nonempty Wise roster is required.");
  const ids = new Set<string>(); const users = new Set<string>();
  for (const teacher of roster) {
    if (!teacher || typeof teacher !== "object") throw new Error("Wise roster identities are incomplete or duplicated.");
    const user = getWiseTeacherUserId(teacher);
    if (!teacher?._id?.trim() || !user?.trim() || ids.has(teacher._id) || users.has(user)) throw new Error("Wise roster identities are incomplete or duplicated.");
    ids.add(teacher._id); users.add(user);
  }
}
// Only fields material to identity and eligibility belong in the drift check.
export function accountFingerprint(teacher: WiseTeacher): string {
  const user = typeof teacher.userId === "object" ? teacher.userId : null;
  return createHash("sha256").update(JSON.stringify({ id: teacher._id, user: getWiseTeacherUserId(teacher),
    name: user?.name ?? teacher.name ?? null, email: user?.email ?? null, activated: user?.activated ?? null,
    relation: teacher.relation ?? null, status: teacher.status ?? null, joinedOn: teacher.joinedOn ?? null,
    classes: teacher.classes ?? null, tags: teacher.tags ?? null })).digest("hex");
}
export function personUnsafeReason(input: { expected: WiseTeacher[]; current: WiseTeacher[]; sessions: WiseSession[]; blocked: boolean; now: Date }): string | null {
  if (input.blocked) return "Wise identity is ambiguous.";
  const expected = new Map(input.expected.map(t => [t._id, t]));
  if (!input.current.length || input.current.length !== expected.size || input.current.some(t => !expected.has(t._id))) return "Wise account membership changed; create a new preview.";
  for (const current of input.current) {
    if (accountFingerprint(current) !== accountFingerprint(expected.get(current._id)!)) return "Wise account details changed; create a new preview.";
    if (current.relation !== "TEACHER" || !Array.isArray(current.classes)) return "Wise account has staff access or unknown details.";
  }
  const userIds = new Set(input.current.flatMap(t => [t._id, getWiseTeacherUserId(t)]));
  if (input.sessions.some(s => isBlockingStatus(s.meetingStatus) && (!Number.isFinite(Date.parse(s.scheduledStartTime)) || !Number.isFinite(Date.parse(s.scheduledEndTime)) || Date.parse(s.scheduledEndTime) <= Date.parse(s.scheduledStartTime)))) return "Upcoming class details are incomplete.";
  const blocking = input.sessions.filter(s => isBlockingStatus(s.meetingStatus) && Date.parse(s.scheduledEndTime) > input.now.getTime());
  if (blocking.some(s => !getWiseSessionTeacherUserId(s) && !s.teacherId)) return "Upcoming class ownership is incomplete.";
  if (blocking.some(s => userIds.has(getWiseSessionTeacherUserId(s)) || userIds.has(s.teacherId))) return "Person has an ongoing or upcoming class.";
  return null;
}
