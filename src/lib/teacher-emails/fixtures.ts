import { buildFeedbackReminderEmail, buildFeedbackTestEmail, buildProgressTestEmail, buildTeachingScheduleEmail, formatTeacherEmailDate, type FeedbackReminderItem, type TeachingScheduleEmailInput } from "./templates";
import type { TeacherEmailContent } from "./render";

/** Synthetic records only. Safe to render without a database or mail sender. */
export function teacherEmailFixtures(logoUrl: string): Array<{ id: string; name: string; content: TeacherEmailContent }> {
  const schedule: TeachingScheduleEmailInput = {
    logoUrl, tutorDisplayName: "Alex Morgan", dateLabel: formatTeacherEmailDate("2026-09-12"),
    usualRooms: ["Focus", "Think Outside the Box"],
    mapUrl: "https://bgscheduler.vercel.app/api/classrooms/floor-plan-map?rooms=Focus%7CThink%20Outside%20the%20Box",
    blocks: [
      { time: "09:00-10:00", studentOrClass: "Maya Bennett", subject: "Mathematics", mode: "Onsite", room: "Focus" },
      { time: "10:00-11:00", studentOrClass: "Oliver Chen", subject: "Science", mode: "Onsite", room: "Think Outside the Box — room change" },
      { time: "11:30-12:30", studentOrClass: "Lina & Noah", subject: "English", mode: "Remote", room: "Remote / no room needed" },
      { time: "13:00-14:00", studentOrClass: "Sam Rivera", subject: "Mathematics", mode: "Onsite", room: "Focus" },
      { time: "14:00-15:00", studentOrClass: "Chanya Siripongchai-Wattanakul & Alexander Montgomery-Wellington", subject: "International curriculum — extended mathematics problem-solving workshop", mode: "Onsite", room: "Cool (outside usual rooms) — room change" },
    ],
  };
  const progress = {
    logoUrl, tutorDisplayName: "Alex Morgan", studentName: "Maya Bennett", subject: "Mathematics", currentCount: 6, threshold: 8,
    dashboardUrl: "https://bgscheduler.vercel.app/progress-tests",
    aiSummary: {
      headline: "Maya is becoming more confident explaining her mathematical reasoning.",
      strengths: ["Identifies equivalent fractions accurately.", "Explains each step when solving familiar problems."],
      focusAreas: ["Check the operation before starting a multi-step word problem.", "Practise converting between fractions and decimals."],
      recommendation: "Include a short mixed-format practice set and ask Maya to explain how she checks each answer.",
    },
  };
  const items: FeedbackReminderItem[] = [
    { className: "Mathematics · Year 8", students: "Maya Bennett", sessionDate: "10 Sep 2026, 10:00", deadline: "12 Sep 2026, 23:59", characters: 120, reasons: ["combined_characters:120/300"], wiseUrl: "https://web.wise.live/teacher/classes/sample-class/sessions/sample-session" },
    { className: "Science · Year 9", students: "Student name unavailable", sessionDate: "10 Sep 2026, 11:00", deadline: "12 Sep 2026, 23:59", characters: 350, reasons: ["all_fields_placeholder"], wiseUrl: "https://web.wise.live" },
  ];
  return [
    { id: "schedule-mixed", name: "Schedule · mixed modes and room changes", content: buildTeachingScheduleEmail(schedule) },
    { id: "schedule-onsite", name: "Schedule · one onsite class", content: buildTeachingScheduleEmail({ ...schedule, blocks: schedule.blocks.slice(0, 1), usualRooms: [] }) },
    { id: "schedule-remote", name: "Schedule · remote only", content: buildTeachingScheduleEmail({ ...schedule, blocks: [schedule.blocks[2]], usualRooms: [], mapUrl: null }) },
    { id: "progress-summary", name: "Progress test · AI summary", content: buildProgressTestEmail(progress) },
    { id: "progress-fallback", name: "Progress test · no summary", content: buildProgressTestEmail({ ...progress, tutorDisplayName: null, subject: "", aiSummary: null }) },
    { id: "feedback-day-after", name: "Feedback · day-after checkpoint", content: buildFeedbackReminderEmail({ logoUrl, tutorDisplayName: "Alex Morgan", items: items.slice(0, 1) }) },
    { id: "feedback-deadline", name: "Feedback · deadline checkpoint", content: buildFeedbackReminderEmail({ logoUrl, tutorDisplayName: null, items }) },
    { id: "feedback-test", name: "Feedback · delivery test", content: buildFeedbackTestEmail({ logoUrl, workspaceUrl: "https://bgscheduler.vercel.app/post-class-feedback" }) },
  ];
}
