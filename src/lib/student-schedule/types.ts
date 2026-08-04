// ----------------------------------------------------------------------------
// Student monthly schedule — wire + domain types.
//
// The payload is rendered in three places (admin workspace, print/PDF report,
// public parent page), so every display string is precomputed server-side in
// Asia/Bangkok. Clients never re-derive a date or a time from a raw instant.
// ----------------------------------------------------------------------------

/** Shown when Wise reports no teacher for a session (fail-closed, never guessed). */
export const TEACHER_TBC = "Teacher TBC";

export interface StudentScheduleSession {
  wiseSessionId: string;
  /** Bangkok calendar day, "YYYY-MM-DD". */
  dateKey: string;
  /** ISO instant of the session start (kept for sorting/debugging). */
  startTime: string;
  endTime: string | null;
  /** "HH:mm" in Bangkok. */
  startLabel: string;
  /** "HH:mm" in Bangkok; empty when Wise gave no end time. */
  endLabel: string;
  subject: string;
  packageName: string;
  /** Resolved teacher, or TEACHER_TBC. Never blank. */
  teacherName: string;
  durationMinutes: number;
  meetingStatus: string;
}

export interface StudentScheduleStudent {
  studentKey: string;
  wiseStudentId: string;
  studentName: string;
  parentName: string;
  /** Nickname code parsed out of the Wise name, e.g. "Aadhu.Sr". Null if absent. */
  code: string | null;
  /** Display nickname without the family suffix, e.g. "Aadhu". Falls back to the full name. */
  shortName: string;
}

export interface StudentSchedulePayload {
  student: StudentScheduleStudent;
  /** "YYYY-MM". */
  monthKey: string;
  /** "August 2026". */
  monthLabel: string;
  sessions: StudentScheduleSession[];
  /** ISO instant the payload was assembled. */
  generatedAt: string;
}
