import { WiseSession } from "@/lib/wise/types";
import { toLocalTime, getLocalWeekday, getLocalMinuteOfDay } from "./timezone";

export interface NormalizedSessionBlock {
  wiseSessionId: string;
  wiseTeacherId: string;
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
      studentName: session.classId?.name,
      subject: session.classId?.subject,
      classType: session.classId?.classType,
      recurrenceId: session.metadata?.recurrenceId,
    });
  }

  return blocks;
}
