// ----------------------------------------------------------------------------
// Every string the LINE schedule bot can emit, and the public schedule page's
// two states.
//
// Split from the router so the wording is reviewable and testable without
// standing up a database or a LINE client. Pure functions only — no IO, no
// clock (callers pass dates in).
//
// Audience split:
//   • PARENT-facing copy is Thai-first with a short English tail. It names the
//     student's NICKNAME, never the full legal name, so a misdelivered link
//     leaks as little as possible.
//   • ADMIN-facing copy is English — staff already work in an English UI.
// ----------------------------------------------------------------------------

import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { formatMonthLabel } from "@/lib/calendar/month-grid";

const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

const DMY_PARTS_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: BANGKOK_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/**
 * "2026-08" → "สิงหาคม 2026".
 *
 * Years stay Gregorian to match the website, the printed PDF and Wise. To show
 * พ.ศ. instead, add 543 to `year` here — this is the single place that decides.
 */
export function formatThaiMonth(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return monthKey;
  const year = Number(match[1]);
  const name = THAI_MONTHS[Number(match[2]) - 1];
  return name ? `${name} ${year}` : monthKey;
}

/**
 * Bangkok D/M/YYYY, the repo-wide date convention. Built from parts because
 * Intl zero-pads ("04/09/2026") and the rest of the app renders "4/9/2026".
 */
export function formatBangkokDmy(value: Date): string {
  const parts = new Map(
    DMY_PARTS_FORMATTER.formatToParts(value).map((part) => [part.type, part.value]),
  );
  const day = Number(parts.get("day"));
  const month = Number(parts.get("month"));
  const year = parts.get("year");
  return `${day}/${month}/${year}`;
}

// ── Parent-facing ───────────────────────────────────────────────────────

/**
 * The only message a parent receives. States that the link self-updates, which
 * heads off the "is this still current?" follow-up, and gives an explicit
 * expiry so an old link's failure is not a surprise.
 */
export function parentSchedulePushMessage({
  shortName,
  monthKey,
  url,
  expiresAt,
}: {
  shortName: string;
  monthKey: string;
  url: string;
  expiresAt: Date;
}): string {
  const thaiMonth = formatThaiMonth(monthKey);
  const englishMonth = formatMonthLabel(monthKey);
  const expiry = formatBangkokDmy(expiresAt);
  return [
    "สวัสดีค่ะ 😊",
    `ตารางเรียนเดือน${thaiMonth} ของน้อง${shortName} ค่ะ`,
    "",
    url,
    "",
    `กดลิงก์เพื่อดูตารางทั้งเดือนได้เลยค่ะ ลิงก์ใช้ได้ถึงวันที่ ${expiry}`,
    "หากตารางมีการเปลี่ยนแปลง ลิงก์นี้จะอัปเดตให้อัตโนมัติค่ะ",
    "มีข้อสงสัยสอบถามได้ตลอดนะคะ 🙏",
    "",
    "BeGifted Education",
    "",
    "—",
    `Hi! Here is ${shortName}'s class schedule for ${englishMonth}:`,
    `${url} · valid until ${expiry}. The link updates automatically if the schedule changes.`,
  ].join("\n");
}

// ── Public page ─────────────────────────────────────────────────────────

export const PUBLIC_PAGE_COPY = {
  title: "ตารางเรียน / Class Schedule",
  brand: "BeGifted Education",
  updatedPrefix: "อัปเดตล่าสุด",
  teacherLabel: "ครู",
  emptyMonth: "เดือนนี้ยังไม่มีคาบเรียนค่ะ / No classes scheduled this month.",
  /**
   * Shown for EVERY resolution failure — expired, revoked, unknown, malformed.
   * Keeping one message means the page cannot be used to probe which tokens
   * ever existed.
   */
  expired: [
    "ลิงก์นี้หมดอายุแล้วค่ะ",
    "กรุณาติดต่อ BeGifted เพื่อขอลิงก์ใหม่",
    "",
    "This link has expired. Please contact BeGifted for a new one.",
  ].join("\n"),
} as const;

// ── Admin-facing ────────────────────────────────────────────────────────

export interface ScheduleBotCandidate {
  code: string | null;
  studentName: string;
}

/**
 * The confirm prompt. Echoes student, month, class count AND recipient so a
 * mistyped code is visible before anything is pushed — this is the last human
 * checkpoint before a message reaches a parent. Keep all four fields.
 */
export function adminConfirmPrompt({
  studentName,
  code,
  monthKey,
  sessionCount,
  recipientDisplayName,
  parentName,
  ttlMinutes,
}: {
  studentName: string;
  code: string | null;
  monthKey: string;
  sessionCount: number;
  recipientDisplayName: string;
  parentName: string;
  ttlMinutes: number;
}): string {
  const who = code ? `${studentName} (${code})` : studentName;
  const parentSuffix = parentName.trim() ? ` (parent: ${parentName.trim()})` : "";
  return [
    `📅 ${who}`,
    `Month: ${formatMonthLabel(monthKey)} · ${sessionCount} ${sessionCount === 1 ? "class" : "classes"}`,
    `Send to: ${recipientDisplayName}${parentSuffix}`,
    "",
    `Reply YES to send, or NO to cancel. Expires in ${ttlMinutes} min.`,
  ].join("\n");
}

export function adminNotFound(query: string): string {
  return `No student matches "${query}". Check the code on /student-schedule, or search by name.`;
}

export function adminAmbiguous(query: string, candidates: ScheduleBotCandidate[]): string {
  const lines = candidates.map((candidate) => (
    candidate.code
      ? `• ${candidate.code} — ${candidate.studentName}`
      : `• ${candidate.studentName}`
  ));
  return [
    `${candidates.length} students match "${query}" — reply with the full code:`,
    ...lines,
  ].join("\n");
}

export function adminNoVerifiedContact(studentName: string): string {
  return `${studentName} has no verified LINE contact, so I can't send anything. Verify the link in /line-review first, then try again.`;
}

export function adminMultipleContacts(
  studentName: string,
  contacts: Array<{ displayName: string }>,
): string {
  const lines = contacts.map((contact, index) => `${index + 1}. ${contact.displayName}`);
  return [
    `${studentName} has ${contacts.length} verified contacts — reply 1${contacts.length === 2 ? " or 2" : `-${contacts.length}`}:`,
    ...lines,
  ].join("\n");
}

export function adminSent(recipientDisplayName: string, expiresAt: Date): string {
  return `✅ Sent to ${recipientDisplayName}. Link expires ${formatBangkokDmy(expiresAt)}.`;
}

export function adminEmptyMonth(studentName: string, monthKey: string): string {
  return `${studentName} has no classes in ${formatMonthLabel(monthKey)}. Nothing sent.`;
}

// ── Group-chat replies ──────────────────────────────────────────────────
//
// These land in a family group, so parents read them too. Keep them short and
// free of internal jargon; never name another family's student.

/**
 * Confirm prompt for a student this group has not received before. Names the
 * student and the month so a right-code-wrong-group mistake is caught before
 * the link reaches the wrong family.
 */
export function groupConfirmPrompt({
  studentName,
  code,
  monthKey,
  sessionCount,
  ttlMinutes,
}: {
  studentName: string;
  code: string | null;
  monthKey: string;
  sessionCount: number;
  ttlMinutes: number;
}): string {
  const who = code ? `${studentName} (${code})` : studentName;
  return [
    `📅 ${who}`,
    `${formatMonthLabel(monthKey)} · ${sessionCount} ${sessionCount === 1 ? "class" : "classes"}`,
    "",
    `Send this schedule to this chat? Reply YES within ${ttlMinutes} min.`,
  ].join("\n");
}

/**
 * Shown when the code is not an exact match. The group path never fuzzy-picks:
 * a near-miss lists options and sends nothing.
 */
export function groupNotExactCode(query: string, candidates: ScheduleBotCandidate[]): string {
  if (candidates.length === 0) return `No student matches "${query}".`;
  return [
    `"${query}" isn't an exact code. Reply with the full code:`,
    ...candidates.map((candidate) => (
      candidate.code
        ? `• ${candidate.code} — ${candidate.studentName}`
        : `• ${candidate.studentName}`
    )),
  ].join("\n");
}

export function groupEmptyMonth(studentName: string, monthKey: string): string {
  return `${studentName} has no classes in ${formatMonthLabel(monthKey)}.`;
}

export const GROUP_PENDING_EXPIRED = "That confirmation expired. Mention me with the student code again.";
export const GROUP_CANCELLED = "Cancelled — nothing was sent.";
export const GROUP_HELP = [
  "Mention me with a student code to post their schedule here.",
  "Example: Aadhu.Sr — or Aadhu.Sr 2026-09 for a specific month.",
].join("\n");
export const GROUP_SEND_FAILED = "Couldn't post the schedule just now. Please try again.";
export const GROUP_NO_SNAPSHOT = "Schedule data isn't available right now. Please try again shortly.";

export const ADMIN_PENDING_EXPIRED = "That confirmation expired. Send the student code again.";
export const ADMIN_CANCELLED = "Cancelled — nothing was sent.";
export const ADMIN_HELP = [
  "Send a student code (e.g. Aadhu.Sr) for this month, or \"Aadhu.Sr 2026-09\" for a specific month.",
  "YES confirms, NO cancels.",
].join("\n");
export const ADMIN_SEND_FAILED = "Could not send the LINE message. Nothing was delivered — try again, or send the link manually from /student-schedule.";
export const ADMIN_NO_SNAPSHOT = "No active credit-control snapshot yet, so I can't read schedules. Try again after the next sync.";
