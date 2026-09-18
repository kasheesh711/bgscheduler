import type { StudentModeEvidence, StudentHistoryTier } from "./overflow-types";

export interface ModeObservation {
  wiseSessionId: string;
  studentId: string;
  rosterKey: string;
  mode: "onsite" | "online" | "unknown";
  scheduledStartAt: string;
  scheduledEndAt: string;
  observedAt: string;
  attended: boolean;
  cancelled: boolean;
}

export function unknownStudentEvidence(studentId: string): StudentModeEvidence {
  return { studentId, tier: "unknown", verifiedSwitches: 0, observedOnsiteLessons: 0,
    onlineAttended: 0, attendedLessons: 0, adjustedFrequency: 0, firstLessonAt: null,
    lastLessonAt: null, lastOnlineAt: null, lookbackDays: 180 };
}

/** Count lessons, not syncs. Absent attendance or an absent prior mode is never inferred. */
export function studentModeEvidence(observations: ModeObservation[], studentIds: string[], now: Date): Map<string, StudentModeEvidence> {
  const result = new Map(studentIds.map(id => [id, unknownStudentEvidence(id)]));
  const cutoff = now.getTime() - 180 * 86_400_000;
  const lessons = new Map<string, ModeObservation[]>();
  for (const observation of observations) {
    if (!result.has(observation.studentId) || !Number.isFinite(Date.parse(observation.observedAt))
      || Date.parse(observation.observedAt) > now.getTime()) continue;
    const key = `${observation.studentId}:${observation.wiseSessionId}`;
    lessons.set(key, [...(lessons.get(key) ?? []), observation]);
  }
  for (const entries of lessons.values()) {
    const sorted = entries.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)
      || Number(a.cancelled) - Number(b.cancelled) || Number(a.attended) - Number(b.attended)
      || Number(b.rosterKey.startsWith("attendance-only:")) - Number(a.rosterKey.startsWith("attendance-only:"))
      || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const lastObserved = sorted.at(-1)!;
    const direct = sorted.filter(row => !row.rosterKey.startsWith("attendance-only:"));
    const finalDirect = direct.at(-1);
    // A repeated attendance fallback must not erase a stronger authoritative final observation.
    const last = lastObserved.rosterKey.startsWith("attendance-only:") && finalDirect?.attended
      && !finalDirect.cancelled && finalDirect.mode === lastObserved.mode
      && finalDirect.scheduledStartAt === lastObserved.scheduledStartAt
      && finalDirect.scheduledEndAt === lastObserved.scheduledEndAt ? finalDirect : lastObserved;
    const start = Date.parse(last.scheduledStartAt), end = Date.parse(last.scheduledEndAt);
    if (start < cutoff || end >= now.getTime() || !Number.isFinite(start) || !Number.isFinite(end)
      || last.cancelled || !last.attended || last.mode === "unknown") continue;
    const evidence = result.get(last.studentId)!;
    const sameLesson = direct.filter(row => row.rosterKey === last.rosterKey
      && row.scheduledStartAt === last.scheduledStartAt && row.scheduledEndAt === last.scheduledEndAt);
    const onsite = sameLesson.find(row => row.mode === "onsite" && !row.cancelled);
    // The whole observation chain must have the same roster; no reassignment by name or membership inference.
    const rosterStable = direct.every(row => row.rosterKey === last.rosterKey);
    const switched = last.mode === "online" && rosterStable && onsite && !sameLesson.some(row => row.cancelled)
      && sameLesson.some(row => row.mode === "online" && !row.cancelled && Date.parse(row.observedAt) > Date.parse(onsite.observedAt));
    evidence.attendedLessons++;
    if (onsite) evidence.observedOnsiteLessons++;
    if (switched) evidence.verifiedSwitches++;
    if (last.mode === "online") {
      evidence.onlineAttended++;
      if (!evidence.lastOnlineAt || last.scheduledStartAt > evidence.lastOnlineAt) evidence.lastOnlineAt = last.scheduledStartAt;
    }
    if (!evidence.firstLessonAt || last.scheduledStartAt < evidence.firstLessonAt) evidence.firstLessonAt = last.scheduledStartAt;
    if (!evidence.lastLessonAt || last.scheduledStartAt > evidence.lastLessonAt) evidence.lastLessonAt = last.scheduledStartAt;
  }
  for (const evidence of result.values()) {
    evidence.tier = evidence.verifiedSwitches ? "verified_switches" : evidence.onlineAttended
      ? "online_attendance" : evidence.attendedLessons ? "onsite_only" : "unknown";
    evidence.adjustedFrequency = evidence.verifiedSwitches
      ? evidence.verifiedSwitches / (evidence.observedOnsiteLessons + 3)
      : evidence.onlineAttended / (evidence.attendedLessons + 3);
  }
  return result;
}

const TIERS: Record<StudentHistoryTier, number> = { verified_switches: 0, online_attendance: 1, onsite_only: 2, unknown: 3 };
export function compareStudentEvidence(a: StudentModeEvidence, b: StudentModeEvidence): number {
  return TIERS[a.tier] - TIERS[b.tier] || b.adjustedFrequency - a.adjustedFrequency
    || (b.tier === "verified_switches" ? b.observedOnsiteLessons - a.observedOnsiteLessons : b.attendedLessons - a.attendedLessons)
    || (b.lastOnlineAt ?? b.lastLessonAt ?? "").localeCompare(a.lastOnlineAt ?? a.lastLessonAt ?? "");
}
