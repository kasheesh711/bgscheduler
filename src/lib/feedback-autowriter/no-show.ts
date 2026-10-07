import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { chooseStudentDisplayName } from "./prompt";
import { scheduledWindow, studentParticipants, type AutowriterSessionDetail } from "./session";

/**
 * A student who never joined while the tutor waited (7 Oct: Avi 0 s, Ras about 12 min). Such a class is held like any
 * low-attendance class; this module only recognises it and prepares the standard note a person may post with one
 * click from the dashboard. It never posts by itself: Wise attendance can miss a lesson held outside the Wise room.
 */

/** At most this long in the room still counts as "did not join" (a join-and-drop, a stray reconnect). */
export const NO_SHOW_STUDENT_MAX_SECONDS = 60;
/** The tutor must have waited at least this long for the note to say they waited. */
export const NO_SHOW_TUTOR_MIN_MINUTES = 10;
export const NO_SHOW_NOTE_VERSION = 1;

export interface NoShowFacts {
  version: typeof NO_SHOW_NOTE_VERSION;
  studentSeconds: number;
  tutorMinutes: number;
  scheduledMinutes: number;
  /** The standard note, ready to post. Its performance line matches the deduction exemption (`missed_or_no_show`). */
  note: FeedbackFieldAnswers;
}

const ATTENDANCE_HOLD = /^attendance_\d+pct$/u;

/** The one student never joined and the tutor waited; null for anything else (several students, unknown durations). */
export function detectNoShow(detail: AutowriterSessionDetail, reason: string | null): NoShowFacts | null {
  if (!reason || !ATTENDANCE_HOLD.test(reason)) return null;
  const students = studentParticipants(detail);
  if (students.length !== 1) return null;
  const [student] = students;
  if (student.inMeetingSeconds === null || student.inMeetingSeconds > NO_SHOW_STUDENT_MAX_SECONDS) return null;
  // The tutor's longest entry: Wise may list them twice (two accounts, a reconnect).
  const tutorSeconds = Math.max(0, ...detail.participants
    .filter((participant) => participant.isTeacher === true)
    .map((participant) => participant.inMeetingDuration ?? participant.duration ?? 0));
  const tutorMinutes = Math.floor(tutorSeconds / 60);
  if (tutorMinutes < NO_SHOW_TUTOR_MIN_MINUTES) return null;
  const name = chooseStudentDisplayName(student.name || "the student");
  return {
    version: NO_SHOW_NOTE_VERSION,
    studentSeconds: student.inMeetingSeconds,
    tutorMinutes,
    scheduledMinutes: scheduledWindow(detail).minutes,
    note: noShowNote(name, tutorMinutes),
  };
}

export function noShowNote(studentName: string, tutorMinutes: number): FeedbackFieldAnswers {
  return {
    topics: "1. No lesson: the student did not join",
    performance: `Student did not attend the class. I waited in the online classroom for about ${tutorMinutes} minutes and ${studentName} did not join.`,
    improvement: `1. Please let us know in advance if ${studentName} cannot make a class, so we can reschedule.`,
    homework: "",
  };
}

/** `metadata.noShow` of a held row, when it holds the current note version. */
export function readNoShow(metadata: unknown): NoShowFacts | null {
  const value = metadata && typeof metadata === "object" ? (metadata as { noShow?: unknown }).noShow : null;
  if (!value || typeof value !== "object") return null;
  const facts = value as Partial<NoShowFacts>;
  if (facts.version !== NO_SHOW_NOTE_VERSION || typeof facts.tutorMinutes !== "number" || !facts.note) return null;
  const note = facts.note as Partial<FeedbackFieldAnswers>;
  if (typeof note.topics !== "string" || typeof note.performance !== "string" || typeof note.improvement !== "string") return null;
  return facts as NoShowFacts;
}
