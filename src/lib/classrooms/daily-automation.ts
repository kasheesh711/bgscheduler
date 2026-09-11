import type { Database } from "@/lib/db";
import { getDb } from "@/lib/db";
import { addBangkokDays, todayBangkok } from "@/lib/room-capacity/dates";
import { runClassroomMorningAutomation } from "./morning-automation";
import { getClassroomAssignmentForDate } from "./data";
import { sendScheduleEmailsForRun, type ScheduleEmailSendResult } from "./schedule-email";
import { sendAdminClassroomScheduleEmail } from "./admin-schedule-email";

/** The 17:00 Bangkok preparation shares the normal Wise sync's single-flight guard. */
export async function prepareNextDayClassrooms(db: Database = getDb(), now = new Date()) {
  return runClassroomMorningAutomation(db, {
    startDate: addBangkokDays(todayBangkok(now), 1),
    sendEmails: false,
    maxSyncWaitMs: 10 * 60 * 1000,
  });
}

/** Deliver the saved plan; never regenerate rooms during the evening delivery window. */
export async function deliverNextDayClassroomSchedules(db: Database = getDb(), now = new Date()) {
  const today = todayBangkok(now);
  const assignmentDate = addBangkokDays(today, 1);
  const preparedAfter = new Date(`${today}T17:00:00+07:00`);
  let teacherEmail: ScheduleEmailSendResult["summary"] | undefined;
  let teacherEmailError: string | undefined;
  try {
    const detail = await getClassroomAssignmentForDate(db, assignmentDate);
    if (!detail.run || new Date(detail.run.createdAt).getTime() < preparedAfter.getTime()) {
      teacherEmailError = "The next-day classroom plan has not been prepared since 17:00 Bangkok.";
    } else {
      const result = await sendScheduleEmailsForRun(db, detail.run.id, "cron@classroom-schedule-email", undefined, { mode: "failed_only" });
      teacherEmail = result.summary;
    }
  } catch (error) {
    teacherEmailError = error instanceof Error ? error.message : "Tutor schedule delivery failed";
  }
  // A tutor delivery failure must not suppress the admin's actionable summary.
  const adminEmail = await sendAdminClassroomScheduleEmail(db, {
    now, assignmentDate, preparedAfter,
    additionalBlockers: teacherEmailError ? [teacherEmailError] : [],
  });
  const ok = !teacherEmailError && !teacherEmail?.failed && !teacherEmail?.blocked
    && !["failed", "partial", "pending"].includes(adminEmail.status);
  const errorSummary = ok ? undefined : teacherEmailError ?? adminEmail.errorSummary
    ?? `Next-day schedule delivery incomplete: ${teacherEmail?.failed ?? 0} tutor failures, ${teacherEmail?.blocked ?? 0} blocked tutors; admin summary ${adminEmail.status}.`;
  return { ok, assignmentDate, teacherEmail, teacherEmailError, adminEmail, errorSummary };
}
