// ----------------------------------------------------------------------------
// LINE report bot — `/report <code> [days | from to]` replies with the
// family's Parent Report print link for a chosen Bangkok date window.
//
// Shares the schedule bot's spine: both routers (schedule-bot.ts DM path,
// schedule-bot-group.ts group path) dispatch here on the "report" verb AFTER
// their own admin gate has passed, so SCHED-BOT-01 / GRP-BOT-02 are inherited.
// This module adds one gate of its own:
//
//   REP-BOT-G1  Staff chats only, fail closed AND fully silent — the verbatim
//               mirror of CRED-BOT-G1. In a group, every /report command
//               requires the chat's stored audience to be exactly "staff",
//               read raw via credit-bot's rawStaffGroup. A missing row, a
//               "family" audience, or any unexpected value produces NO reply
//               at all: the reply names every family member, and even the
//               help must never appear where a parent can read it.
//
// The linked page itself is auth-gated (redirects to /login), so the URL is
// safe to send; the staff gate protects the reply text, not the page.
// ----------------------------------------------------------------------------

import type { Database } from "@/lib/db";
import {
  HELP_PATTERN,
  REPORT_COMMAND_PATTERN,
} from "@/lib/line/schedule-bot-command";
import { rawStaffGroup, resolveFamilyStudents } from "@/lib/line/credit-bot";
import {
  REPORT_HELP,
  REPORT_INVALID_RANGE,
  REPORT_NO_SNAPSHOT,
  reportLinkReply,
  reportNotExact,
} from "@/lib/line/schedule-bot-copy";
import { REPORT_MAX_STUDENTS, buildReportSearch } from "@/lib/student-report/params";
import { addBangkokDays, todayBangkok } from "@/lib/room-capacity/dates";

/** Default trailing window, matching /credit's report link and the workspace preset. */
const DEFAULT_WINDOW_DAYS = 30;

const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;

export type ReportBotAction =
  | "report_help"
  | "report_silent_audience"
  | "report_no_snapshot"
  | "report_not_exact"
  | "report_invalid_range"
  | "report_link";

export interface ReportCommandContext {
  db: Database;
  lineUserId: string;
  /** Text after the /report prefix, already trimmed by detectTrigger. */
  command: string;
  surface: { kind: "dm" } | { kind: "group"; groupId: string };
  /** Sends one text message back into the originating conversation. */
  respond: (text: string) => Promise<void>;
  now: () => Date;
  baseUrl: string;
}

type ResolvedWindow =
  | { valid: true; from: string; to: string; days: number | null }
  | { valid: false };

/**
 * Turns the pattern's captures into an inclusive Bangkok window, rejecting
 * out-of-bounds day counts, impossible calendar dates, and reversed ranges
 * BEFORE any database read. A date is real exactly when it survives the
 * addBangkokDays(d, 0) round trip — 2026-02-31 normalizes to 2026-03-03 and
 * is refused rather than silently shifted.
 */
function resolveWindow(
  daysArg: string | undefined,
  fromArg: string | undefined,
  toArg: string | undefined,
  now: Date,
): ResolvedWindow {
  if (fromArg && toArg) {
    if (addBangkokDays(fromArg, 0) !== fromArg) return { valid: false };
    if (addBangkokDays(toArg, 0) !== toArg) return { valid: false };
    if (fromArg > toArg) return { valid: false };
    return { valid: true, from: fromArg, to: toArg, days: null };
  }
  const days = daysArg === undefined ? DEFAULT_WINDOW_DAYS : Number(daysArg);
  if (days < MIN_WINDOW_DAYS || days > MAX_WINDOW_DAYS) return { valid: false };
  const to = todayBangkok(now);
  return { valid: true, from: addBangkokDays(to, -days), to, days };
}

/**
 * Routes one /report command from either surface. The caller's admin gate has
 * already passed; this function owns the staff-chat gate, the window grammar,
 * and the link reply.
 *
 * 1. REP-BOT-G1 — every group use, help included, exits silently unless the
 *    chat's raw audience is "staff".
 * 2. Empty command or an explicit help word replies the command forms.
 * 3. An unparseable command (multi-word query, malformed date, lone date)
 *    also replies help; a parsed-but-impossible window replies the specific
 *    range error instead.
 * 4. Family resolution (shared with /credit) — no-snapshot and not-exact each
 *    get their own copy.
 * 5. The reply lists every family member and links the Parent Report print
 *    page for the window; tutor feedback stays at its default (included).
 */
export async function handleReportCommand(
  ctx: ReportCommandContext,
): Promise<{ handled: true; action: ReportBotAction }> {
  if (ctx.surface.kind === "group" && !(await rawStaffGroup(ctx.db, ctx.surface.groupId))) {
    return { handled: true, action: "report_silent_audience" };
  }

  const command = ctx.command.trim();
  if (!command || HELP_PATTERN.test(command)) {
    await ctx.respond(REPORT_HELP);
    return { handled: true, action: "report_help" };
  }

  const match = REPORT_COMMAND_PATTERN.exec(command);
  if (!match) {
    await ctx.respond(REPORT_HELP);
    return { handled: true, action: "report_help" };
  }
  const [, code, daysArg, fromArg, toArg] = match;

  const window = resolveWindow(daysArg, fromArg, toArg, ctx.now());
  if (!window.valid) {
    await ctx.respond(REPORT_INVALID_RANGE);
    return { handled: true, action: "report_invalid_range" };
  }

  const family = await resolveFamilyStudents(ctx.db, code);
  if (family.status === "no_snapshot") {
    await ctx.respond(REPORT_NO_SNAPSHOT);
    return { handled: true, action: "report_no_snapshot" };
  }
  if (family.status === "not_exact") {
    await ctx.respond(reportNotExact(code, family.candidates));
    return { handled: true, action: "report_not_exact" };
  }

  const linkedKeys = family.students
    .map((student) => student.studentKey)
    .slice(0, REPORT_MAX_STUDENTS);
  const url = `${ctx.baseUrl}/student-report/report?${buildReportSearch({
    studentKeys: linkedKeys,
    from: window.from,
    to: window.to,
  })}`;

  await ctx.respond(reportLinkReply({
    students: family.students,
    from: window.from,
    to: window.to,
    days: window.days,
    url,
    truncatedCount: family.students.length - linkedKeys.length,
  }));
  return { handled: true, action: "report_link" };
}
