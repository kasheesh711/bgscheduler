// ----------------------------------------------------------------------------
// Shared command grammar for the schedule bot.
//
// Both surfaces parse the same thing: a 1:1 DM to the Official Account
// (schedule-bot.ts) and a message in a group the OA belongs to
// (schedule-bot-group.ts). Keeping the grammar here means the two can never
// drift, and avoids an import cycle between them.
// ----------------------------------------------------------------------------

import { mentionsSelf, stripMentions, type LineMentionee } from "@/lib/line/mentions";
import { nicknameCodes, normalizeLineStudentCode } from "@/lib/line/student-links";

/**
 * Text trigger.
 *
 * An @-mention of the Official Account can only be produced in the LINE mobile
 * app — the desktop/web client shows no bot in its mention picker — so a typed
 * prefix is the trigger that works everywhere. The mention path is kept as an
 * additional trigger for mobile users who prefer it.
 */
export const TRIGGER_PREFIX = "/schedule";

/** `<code> [YYYY-MM] [send]`. */
export const COMMAND_PATTERN = /^([A-Za-z0-9._\-฀-๿]{2,40})(?:\s+(\d{4}-\d{2}))?(?:\s+(send))?$/i;

export const YES_PATTERN = /^(yes|y|ยืนยัน|ใช่|ok|okay)$/i;
export const NO_PATTERN = /^(no|n|cancel|ยกเลิก|ไม่)$/i;
export const HELP_PATTERN = /^(help|\?|ช่วย)$/i;

/**
 * Answers to the one-time "is this chat family-facing or staff-only?" question,
 * and the `setup <audience>` verb that changes it later.
 */
export const FAMILY_PATTERN = /^(family|parent|ครอบครัว|ผู้ปกครอง)$/i;
export const STAFF_PATTERN = /^(staff|internal|admin|ทีมงาน)$/i;
export const SETUP_PATTERN = /^setup\s+(family|parent|staff|internal|admin)$/i;

/** `setup instant` switches a chat's confirm gate off; `setup confirm` restores it (GRP-BOT-07). */
export const SETUP_MODE_PATTERN = /^setup\s+(instant|confirm)$/i;

/**
 * The short words the bot asks people to reply with.
 *
 * The prompts say "Reply FAMILY or STAFF" and "Reply YES", so these must work
 * WITHOUT the /schedule prefix — otherwise the bot ignores the exact answer it
 * just asked for. Callers accept a bare answer only when an allowlisted admin
 * has a live pending question in that conversation; everything else still
 * requires an explicit trigger.
 */
export const ANSWER_PATTERN = new RegExp(
  `^(${[YES_PATTERN, NO_PATTERN, FAMILY_PATTERN, STAFF_PATTERN]
    .map((pattern) => pattern.source.replace(/^\^\(|\)\$$/g, ""))
    .join("|")})$`,
  "i",
);

export type GroupAudience = "family" | "staff";

/** Maps a FAMILY/STAFF reply (or a `setup <x>` argument) to the stored value. */
export function parseAudience(value: string): GroupAudience | null {
  if (FAMILY_PATTERN.test(value)) return "family";
  if (STAFF_PATTERN.test(value)) return "staff";
  return null;
}

export type TriggerKind = "prefix" | "mention" | "answer" | "none";

/**
 * Detects how (or whether) a message addresses the bot, returning the command
 * with the trigger removed.
 *
 * Pass `[]` for mentionees in a 1:1 conversation — there is nothing to mention
 * there, so only the prefix applies.
 */
export function detectTrigger(
  text: string,
  mentionees: readonly LineMentionee[],
): { kind: TriggerKind; command: string } {
  const trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith(TRIGGER_PREFIX)) {
    return { kind: "prefix", command: trimmed.slice(TRIGGER_PREFIX.length).trim() };
  }
  if (mentionsSelf(mentionees)) {
    return { kind: "mention", command: stripMentions(text, mentionees) };
  }
  return { kind: "none", command: "" };
}

/**
 * Narrows a directory search to entries whose bracketed nickname code matches
 * the query EXACTLY.
 *
 * `searchCurrentLineStudents` also ranks substring and parent-name hits, which
 * is right for an admin scanning a web UI but far too loose when the result is
 * a link to a specific child's schedule.
 */
export function exactCodeMatches<T extends { studentName: string }>(
  query: string,
  candidates: readonly T[],
): T[] {
  const normalized = normalizeLineStudentCode(query);
  if (!normalized) return [];
  return candidates.filter((candidate) =>
    nicknameCodes(candidate.studentName).includes(normalized));
}
