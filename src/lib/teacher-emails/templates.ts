import { renderTeacherEmail, type EmailSection, type TeacherEmailContent } from "./render";

interface EmailBrandInput { logoUrl: string }

export interface TeachingScheduleEmailInput extends EmailBrandInput {
  tutorDisplayName: string;
  dateLabel: string;
  blocks: Array<{ time: string; studentOrClass: string; subject: string; mode: string; room: string }>;
  usualRooms?: string[];
  /** Null for an entirely remote schedule. */
  mapUrl: string | null;
}

export function formatTeacherEmailDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function teachingScheduleSubject(dateLabel: string): string {
  return `[BeGifted] Teaching schedule — ${dateLabel}`;
}

export function buildTeachingScheduleEmail(input: TeachingScheduleEmailInput): TeacherEmailContent {
  const sections: EmailSection[] = input.blocks.map(block => ({
    kicker: block.time,
    heading: block.studentOrClass,
    details: [
      { label: "Subject", value: block.subject },
      { label: "Mode", value: block.mode },
      { label: "Room", value: block.room },
    ],
  }));
  if (input.usualRooms?.length) {
    sections.push({ heading: "Your usual rooms", paragraphs: [input.usualRooms.join(" · ")] });
  }
  if (input.mapUrl) {
    sections.push({
      heading: "Find your classroom",
      paragraphs: ["Your assigned rooms are highlighted on the school map. Follow the times and room names in your agenda above."],
      action: { label: "View school map", url: input.mapUrl },
    });
  }
  return renderTeacherEmail({
    subject: teachingScheduleSubject(input.dateLabel),
    preheader: `${input.blocks.length} ${input.blocks.length === 1 ? "class" : "classes"} · Your times, students and rooms for ${input.dateLabel}.`,
    category: "Your teaching day", title: "Teaching schedule", subtitle: `${input.tutorDisplayName} · ${input.dateLabel}`,
    greeting: `Hi ${input.tutorDisplayName},`,
    paragraphs: ["Here is your teaching schedule. Please check the room for each class, including any room-change notices."],
    sections, logoUrl: input.logoUrl, footerNote: "All class times are Bangkok time (UTC+7).",
  });
}

export interface ProgressTestEmailInput extends EmailBrandInput {
  tutorDisplayName: string | null;
  studentName: string;
  subject: string;
  currentCount: number;
  threshold: number;
  dashboardUrl: string;
  aiSummary: { headline: string; strengths: string[]; focusAreas: string[]; recommendation: string } | null;
}

export function buildProgressTestEmail(input: ProgressTestEmailInput): TeacherEmailContent {
  const subject = input.subject || "class";
  const summary = input.aiSummary;
  const sections: EmailSection[] = [{
    heading: "Prepare for the progress test",
    paragraphs: ["Please let the student know a progress test is coming up after the next class so they can prepare."],
    details: [
      { label: "Student", value: input.studentName },
      { label: "Subject", value: subject },
      { label: "Cycle progress", value: `${input.currentCount} of ${input.threshold}` },
    ],
  }];
  if (summary) {
    sections.push({ kicker: "AI-generated summary", heading: "Recent learning", paragraphs: [summary.headline] });
    if (summary.strengths.length) sections.push({ heading: "Strengths", bullets: summary.strengths });
    if (summary.focusAreas.length) sections.push({ heading: "Focus areas", bullets: summary.focusAreas });
    if (summary.recommendation.trim()) sections.push({ heading: "Recommendation", paragraphs: [summary.recommendation] });
  } else {
    sections.push({ heading: "Review recent classes", paragraphs: ["There is not enough recent feedback for an AI summary. Please review the student's recent classes before the test."] });
  }
  sections.push({ heading: "Progress Tests", action: { label: "Open Progress Tests", url: input.dashboardUrl } });
  return renderTeacherEmail({
    subject: `[BeGifted] Progress test coming up for ${input.studentName} (${subject})`,
    preheader: `${input.studentName} · ${subject} · ${input.currentCount} of ${input.threshold} classes this cycle.`,
    category: "Student progress", title: "A progress test is coming up", subtitle: `${input.studentName} · ${subject}`,
    greeting: `Hi ${input.tutorDisplayName || "there"},`,
    paragraphs: [`${input.studentName} is approaching a progress test. Here is what to prepare for the next class.`],
    sections, logoUrl: input.logoUrl,
  });
}

export interface FeedbackReminderItem {
  className: string;
  students: string;
  sessionDate: string;
  deadline: string;
  characters: number;
  reasons: string[];
  wiseUrl: string;
}

export const feedbackReminderSubject = "[BeGifted] Post-class feedback reminder";

export function feedbackReasonLabel(reason: string): string {
  const characters = /^combined_characters:(\d+)\/(\d+)$/.exec(reason);
  if (characters) return `Feedback has ${characters[1]} of the ${characters[2]} required combined characters.`;
  if (reason === "all_fields_placeholder") return "Replace placeholder or repeated filler text with meaningful feedback about the class.";
  // Older assessments may still contain per-field diagnostic reasons. Keep
  // their information without introducing a new requirement or policy rule.
  const fields: Record<string, string> = {
    topics: "Topics covered", performance: "Student performance",
    improvement: "Areas for improvement", homework: "Homework",
  };
  const [field, details] = reason.split(":", 2);
  const readable = (value: string) => value.replaceAll("_", " ").replaceAll("+", ", ");
  return details ? `${fields[field] ?? readable(field)}: ${readable(details)}` : readable(reason);
}

export function buildFeedbackReminderEmail(input: EmailBrandInput & {
  tutorDisplayName: string | null;
  items: FeedbackReminderItem[];
}): TeacherEmailContent {
  return renderTeacherEmail({
    subject: feedbackReminderSubject,
    preheader: `${input.items.length} ${input.items.length === 1 ? "class needs" : "classes need"} attention. Review the deadlines and complete feedback in Wise.`,
    category: "Post-class feedback", title: "Complete your class feedback",
    greeting: `Hi ${input.tutorDisplayName || "there"},`,
    paragraphs: ["Please complete the required post-class feedback in Wise for the classes below. Check each deadline and the items that need attention."],
    sections: input.items.map(item => ({
      kicker: `Deadline · ${item.deadline} (Bangkok)`,
      heading: item.className,
      details: [
        { label: "Students", value: item.students },
        { label: "Session", value: `${item.sessionDate} (Bangkok)` },
        { label: "Current combined character count", value: String(item.characters) },
        { label: "Needs attention", value: item.reasons.length ? item.reasons.map(feedbackReasonLabel).join(" ") : "Required feedback is incomplete." },
      ],
      action: { label: "Open Wise session", url: item.wiseUrl },
    })),
    logoUrl: input.logoUrl,
    footerNote: "All dates and times are Bangkok time (UTC+7). Feedback text is intentionally not included in this email.",
  });
}

export function buildFeedbackTestEmail(input: EmailBrandInput & { workspaceUrl: string }): TeacherEmailContent {
  return renderTeacherEmail({
    subject: "[BeGifted] Post-class feedback email test", preheader: "Your feedback email delivery test was successful.",
    category: "Delivery test", title: "Email delivery is working", greeting: "Hello,",
    paragraphs: ["Email delivery for the post-class feedback workspace is working. This is a test message; no class feedback is requested."],
    sections: [{ heading: "Post-class feedback", action: { label: "Open the workspace", url: input.workspaceUrl } }],
    logoUrl: input.logoUrl,
  });
}
