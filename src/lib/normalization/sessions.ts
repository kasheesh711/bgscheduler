import {
  WiseSession,
  getWiseSessionClassId,
  getWiseSessionClassName,
  getWiseSessionClassSubject,
  getWiseSessionClassType,
  getWiseSessionTeacherUserId,
} from "@/lib/wise/types";
import { toLocalTime, getLocalWeekday, getLocalMinuteOfDay } from "./timezone";

export interface NormalizedSessionBlock {
  wiseSessionId: string;
  wiseTeacherId: string;
  wiseTeacherUserId?: string;
  wiseClassId?: string;
  startTime: Date;
  endTime: Date;
  weekday: number;
  startMinute: number;
  endMinute: number;
  wiseStatus: string;
  isBlocking: boolean;
  title?: string;
  sessionType?: string;
  location?: string;
  studentName?: string;
  studentCount?: number;
  studentIds?: string[] | null;
  subject?: string;
  classType?: string;
  recurrenceId?: string;
}

// Statuses that do NOT block
const NON_BLOCKING_STATUSES = new Set([
  "CANCELLED",
  "CANCELED",
  "COMPLETED",
  "MISSED",
  "NO_SHOW",
]);

/**
 * Determine if a session status is blocking.
 * Unknown statuses default to blocking (fail-closed).
 */
export function isBlockingStatus(status: string | undefined): boolean {
  if (!status) return true; // fail-closed
  const upper = status.toUpperCase();
  if (NON_BLOCKING_STATUSES.has(upper)) return false;
  return true; // Unknown statuses remain blocking (fail-closed)
}

export function sessionStudentIds(session: WiseSession): string[] | null {
  // Participants may include the teacher; only the authoritative students field is a roster.
  if (!Array.isArray(session.students)) return null;
  const ids = session.students.map(v => typeof v === "string" ? v : v?._id);
  if (ids.some(id => typeof id !== "string" || !id.trim())) return null;
  return [...new Set(ids as string[])];
}

/**
 * Normalize Wise future sessions into session blocks.
 * Converts UTC to Asia/Bangkok and classifies blocking status.
 */
export function normalizeSessions(
  wiseSessions: WiseSession[],
  teacherIdResolver: (session: WiseSession) => string | null
): NormalizedSessionBlock[] {
  const blocks: NormalizedSessionBlock[] = [];

  for (const session of wiseSessions) {
    const teacherId = teacherIdResolver(session);
    if (!teacherId) continue;

    const startLocal = toLocalTime(session.scheduledStartTime);
    const endLocal = toLocalTime(session.scheduledEndTime);

    blocks.push({
      wiseSessionId: session._id,
      wiseTeacherId: teacherId,
      wiseTeacherUserId: getWiseSessionTeacherUserId(session),
      wiseClassId: getWiseSessionClassId(session),
      startTime: startLocal,
      endTime: endLocal,
      weekday: getLocalWeekday(session.scheduledStartTime),
      startMinute: getLocalMinuteOfDay(session.scheduledStartTime),
      endMinute: getLocalMinuteOfDay(session.scheduledEndTime),
      wiseStatus: session.meetingStatus ?? "UNKNOWN",
      isBlocking: isBlockingStatus(session.meetingStatus),
      title: session.title,
      sessionType: session.type,
      location: session.location,
      studentName: getWiseSessionClassName(session),
      studentCount: typeof session.studentCount === "number" ? session.studentCount : undefined,
      studentIds: sessionStudentIds(session),
      subject: getWiseSessionClassSubject(session),
      classType: getWiseSessionClassType(session),
      recurrenceId: session.metadata?.recurrenceId,
    });
  }

  return blocks;
}
