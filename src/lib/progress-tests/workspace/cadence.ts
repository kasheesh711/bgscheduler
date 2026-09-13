import type { ProgressTestIdentityEntry } from "../db";

export function verifiedInstructor(userId: string | null, teacherId: string | null, identities: ProgressTestIdentityEntry[]) {
  const matches = identities.filter(i => (!!userId && (i.wiseUserId === userId || i.wiseTeacherId === userId)) || (!!teacherId && (i.wiseTeacherId === teacherId || i.wiseUserId === teacherId)));
  if (new Set(matches.map(i => i.canonicalKey)).size !== 1) return null;
  return matches[0] ?? null;
}
export type Attendance = { sessionId: string; studentId: string; courseId: string; ownerKey: string | null; start: Date; status: string; credit: number };
export const seriesKey = (owner: string, course: string, student: string) => JSON.stringify([owner, course, student]);
export function countedAttendance(rows: Attendance[], launch: Date, now: Date) {
  const groups = new Map<string, string[]>();
  const latest = new Map(rows.map(row => [JSON.stringify([row.sessionId, row.studentId]), row]));
  for (const r of [...latest.values()].sort((a,b) => a.start.getTime() - b.start.getTime() || a.sessionId.localeCompare(b.sessionId))) {
    if (!r.ownerKey || r.start < launch || r.start > now || r.status !== "ENDED" || !Number.isFinite(r.credit) || r.credit <= 0) continue;
    const key = seriesKey(r.ownerKey, r.courseId, r.studentId);
    groups.set(key, [...(groups.get(key) ?? []), r.sessionId]);
  }
  return groups;
}
export const needsReminder = (count: number, cycle: number, notified: boolean) => !notified && count >= (cycle - 1) * 8 + 6;
