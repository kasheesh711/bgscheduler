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

export type TriggerKind = "prefix" | "mention" | "none";

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
