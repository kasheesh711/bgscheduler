// ----------------------------------------------------------------------------
// LINE schedule bot — group chat path.
//
// An admin @-mentions the Official Account inside a family group and the bot
// posts that student's schedule link into the same group. Because the admin
// chooses the destination simply by choosing where to type, no identity
// resolution is involved: the groupId arrives on the webhook event.
//
// This is what lifts the feature past the seven students the DM path can reach.
// The DM path must resolve a parent's Messaging-API user ID through a verified
// contact link, and almost none exist (the OA-resolver harvested chat-surface
// chatIds from a different namespace, all since quarantined).
//
// Gates — the DM path's four, re-weighted for a group destination:
//
//   GRP-BOT-01  Self-mention required. `mention.mentionees[].isSelf` must be
//               true. Ordinary conversation in the group is never a command.
//   GRP-BOT-02  Sender allowlist. Only LINE user IDs in
//               LINE_SCHEDULE_BOT_ADMIN_IDS are served, and a non-admin gets
//               NO reply at all — a parent in the group must not learn the bot
//               exists, let alone probe the student roster with it.
//   GRP-BOT-03  Exact code only. Fuzzy matching is the main cause of
//               wrong-student sends; anything short of one exact nickname-code
//               hit lists candidates and sends nothing.
//   GRP-BOT-04  Confirm on first sight per group. Exact matching cannot catch
//               the right code typed in the WRONG family's group, so the first
//               time a student appears in a given group the bot asks. Repeat
//               requests for a student this group has already received go
//               straight through.
//   GRP-BOT-05  Non-empty month — never post a blank calendar to parents.
//
// The verified-student-link gate is deliberately NOT applied here: the
// destination is the group everyone is already in, so it would block delivery
// without protecting anyone.
// ----------------------------------------------------------------------------

import { and, desc, eq } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { pushLineTextMessage, replyLineMessage } from "@/lib/line/client";
import { readMentionees } from "@/lib/line/mentions";
import { searchCurrentLineStudents } from "@/lib/line/student-links";
import {
  COMMAND_PATTERN,
  HELP_PATTERN,
  NO_PATTERN,
  YES_PATTERN,
  detectTrigger,
  exactCodeMatches,
  type TriggerKind,
} from "@/lib/line/schedule-bot-command";
import { isScheduleBotAdmin } from "@/lib/line/schedule-bot";
import {
  getStudentMonthlySchedule,
  parseStudentDisplay,
} from "@/lib/student-schedule/data";
import {
  DEFAULT_LINK_TTL_DAYS,
  mintStudentScheduleLink,
  studentScheduleLinkUrl,
} from "@/lib/student-schedule/links";
import { getMonthKey, isMonthKey } from "@/lib/calendar/month-grid";
import { todayBangkok } from "@/lib/room-capacity/dates";
import {
  GROUP_CANCELLED,
  GROUP_HELP,
  GROUP_NO_SNAPSHOT,
  GROUP_PENDING_EXPIRED,
  GROUP_SEND_FAILED,
  adminScheduleLinkReply,
  groupConfirmPrompt,
  groupEmptyMonth,
  groupNotExactCode,
  parentSchedulePushMessage,
} from "@/lib/line/schedule-bot-copy";

const PENDING_TTL_MINUTES = 5;
const MAX_CANDIDATES = 5;
const DEFAULT_BASE_URL = "https://bgscheduler.vercel.app";

// Command grammar is shared with the 1:1 path — see schedule-bot-command.ts.

export interface GroupBotDeps {
  reply: typeof replyLineMessage;
  push: typeof pushLineTextMessage;
  now: () => Date;
  baseUrl: string;
  ttlDays: number;
}

export interface GroupBotResult {
  handled: boolean;
  action?:
    | "help"
    | "not_exact"
    | "empty_month"
    | "awaiting_confirm"
    | "sent"
    | "cancelled"
    | "pending_expired"
    | "no_snapshot"
    | "send_failed";
}

function resolveDeps(overrides: Partial<GroupBotDeps> = {}): GroupBotDeps {
  return {
    reply: overrides.reply ?? replyLineMessage,
    push: overrides.push ?? pushLineTextMessage,
    now: overrides.now ?? (() => new Date()),
    baseUrl: overrides.baseUrl
      ?? process.env.APP_BASE_URL?.trim()
      ?? DEFAULT_BASE_URL,
    ttlDays: overrides.ttlDays
      ?? (Number(process.env.STUDENT_SCHEDULE_LINK_TTL_DAYS) || DEFAULT_LINK_TTL_DAYS),
  };
}

function scopeKeyFor(groupId: string): string {
  return `group:${groupId}`;
}

/**
 * Answers into the originating group. Prefers the reply token (free, no quota,
 * no stored destination) and falls back to a push at the group ID when the
 * one-minute token window has closed — a schedule lookup can outlive it.
 */
async function say(
  deps: GroupBotDeps,
  { groupId, replyToken }: { groupId: string; replyToken: string | null },
  text: string,
): Promise<void> {
  if (replyToken) {
    try {
      await deps.reply({ replyToken, text });
      return;
    } catch (error) {
      console.error("[schedule-bot-group] reply failed, falling back to push", error);
    }
  }
  await deps.push({ to: groupId, text });
}

/** True when this group has already received this student's schedule (GRP-BOT-04). */
export async function groupHasSeenStudent(
  db: Database,
  groupId: string,
  studentKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.lineGroupScheduleSends.id })
    .from(schema.lineGroupScheduleSends)
    .where(and(
      eq(schema.lineGroupScheduleSends.groupId, groupId),
      eq(schema.lineGroupScheduleSends.studentKey, studentKey),
    ))
    .limit(1);
  return Boolean(row);
}

/**
 * Narrows a directory search to entries whose bracketed nickname code matches
 * the query EXACTLY (GRP-BOT-03). `searchCurrentLineStudents` ranks substring
 * and parent-name hits too, which is right for an admin staring at a web UI but
 * far too loose when the result is posted into a family's chat.
 */
/**
 * Routes one command from a group chat.
 *
 * @returns `{handled: false}` with no reply when the bot was not mentioned or
 *   the sender is not an allowlisted admin.
 */
export async function handleScheduleBotGroupCommand(
  {
    db,
    groupId,
    lineUserId,
    text,
    replyToken,
    message,
  }: {
    db: Database;
    groupId: string;
    lineUserId: string;
    text: string;
    replyToken: string | null;
    message?: Record<string, unknown>;
  },
  overrides: Partial<GroupBotDeps> = {},
): Promise<GroupBotResult> {
  // GRP-BOT-01 — the message must address the bot, by typed prefix or mention.
  const mentionees = readMentionees(message ?? {});
  const { kind, command } = detectTrigger(text, mentionees);
  if (kind === "none") {
    trace({ groupId, lineUserId, trigger: "none" });
    return { handled: false };
  }

  // GRP-BOT-02 — silent for anyone who is not an allowlisted admin. Note the
  // command text is NOT traced here: a parent who happens to type "/schedule"
  // must not have their message copied into our logs.
  if (!isScheduleBotAdmin(lineUserId)) {
    trace({ groupId, lineUserId, trigger: kind, admin: false });
    return { handled: false };
  }

  const deps = resolveDeps(overrides);
  const target = { groupId, replyToken };
  if (!command) {
    await say(deps, target, GROUP_HELP);
    return { handled: true, action: "help" };
  }

  if (HELP_PATTERN.test(command)) {
    await say(deps, target, GROUP_HELP);
    return { handled: true, action: "help" };
  }

  if (NO_PATTERN.test(command)) {
    await clearPending(db, lineUserId, groupId);
    await say(deps, target, GROUP_CANCELLED);
    return { handled: true, action: "cancelled" };
  }

  if (YES_PATTERN.test(command)) {
    return confirmGroupSend(db, deps, target, lineUserId);
  }

  const match = COMMAND_PATTERN.exec(command);
  if (!match) {
    // Addressed the bot but the rest is not a command — say so rather than
    // going silent, since the sender is a known admin expecting a reply.
    trace({ groupId, lineUserId, trigger: kind, admin: true, command, outcome: "unparsed" });
    await say(deps, target, GROUP_HELP);
    return { handled: true, action: "help" };
  }

  const query = match[1];
  const monthKey = match[2] ?? getMonthKey(todayBangkok(deps.now()));
  const pushToParent = Boolean(match[3]);
  if (!isMonthKey(monthKey)) {
    await say(deps, target, GROUP_HELP);
    return { handled: true, action: "help" };
  }

  trace({ groupId, lineUserId, trigger: kind, admin: true, command, outcome: pushToParent ? "send" : "reply" });
  return startGroupSend(db, deps, target, lineUserId, query, monthKey, pushToParent);
}

/**
 * One structured line per inbound command attempt.
 *
 * This path was completely invisible in production for hours — group events
 * are not persisted, and both entry gates returned silently — so every exit
 * now leaves a trace. IDs are truncated, and `command` is only ever recorded
 * for allowlisted admins so a parent's message text never reaches the logs.
 */
function trace(fields: {
  groupId: string;
  lineUserId: string;
  trigger: TriggerKind;
  admin?: boolean;
  command?: string;
  outcome?: string;
}): void {
  const short = (value: string) => (value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-3)}` : value);
  const parts = [
    `chat=${short(fields.groupId)}`,
    `sender=${short(fields.lineUserId)}`,
    `trigger=${fields.trigger}`,
  ];
  if (fields.admin !== undefined) parts.push(`admin=${fields.admin ? "yes" : "no"}`);
  if (fields.admin && fields.command !== undefined) parts.push(`command=${JSON.stringify(fields.command)}`);
  if (fields.outcome) parts.push(`outcome=${fields.outcome}`);
  console.log(`[schedule-bot] ${parts.join(" ")}`);
}

async function clearPending(
  db: Database,
  lineUserId: string,
  groupId: string,
): Promise<void> {
  await db
    .delete(schema.lineScheduleBotPending)
    .where(and(
      eq(schema.lineScheduleBotPending.lineUserId, lineUserId),
      eq(schema.lineScheduleBotPending.scopeKey, scopeKeyFor(groupId)),
    ));
}

async function startGroupSend(
  db: Database,
  deps: GroupBotDeps,
  target: { groupId: string; replyToken: string | null },
  lineUserId: string,
  query: string,
  monthKey: string,
  pushToParent: boolean,
): Promise<GroupBotResult> {
  const candidates = await searchCurrentLineStudents(db, query, MAX_CANDIDATES);

  // GRP-BOT-03 — exactly one exact code hit, or nothing is sent.
  const exact = exactCodeMatches(query, candidates);
  if (exact.length !== 1) {
    await say(deps, target, groupNotExactCode(query, candidates.map((row) => ({
      code: parseStudentDisplay(row.studentName).code,
      studentName: row.studentName,
    }))));
    return { handled: true, action: "not_exact" };
  }

  const student = exact[0];
  const schedule = await getStudentMonthlySchedule(db, {
    studentKey: student.studentKey,
    monthKey,
  });
  if (!schedule) {
    await say(deps, target, GROUP_NO_SNAPSHOT);
    return { handled: true, action: "no_snapshot" };
  }

  // GRP-BOT-05 — never post an empty calendar.
  if (schedule.sessions.length === 0) {
    await say(deps, target, groupEmptyMonth(student.studentName, monthKey));
    return { handled: true, action: "empty_month" };
  }

  // Default path: the link goes back to whoever asked, in the conversation they
  // asked in. The requester IS the recipient, so there is no third party to
  // mis-address — GRP-BOT-04's confirm step would be pure friction here and is
  // skipped. Only the explicit `send` verb targets a parent.
  if (!pushToParent) {
    return deliver(db, deps, target, {
      lineUserId,
      studentKey: student.studentKey,
      wiseStudentId: student.wiseStudentId,
      studentName: student.studentName,
      monthKey,
      sessionCount: schedule.sessions.length,
      audience: "requester",
    });
  }

  // GRP-BOT-04 — a student this chat has already received goes straight out.
  if (await groupHasSeenStudent(db, target.groupId, student.studentKey)) {
    return deliver(db, deps, target, {
      lineUserId,
      studentKey: student.studentKey,
      wiseStudentId: student.wiseStudentId,
      studentName: student.studentName,
      monthKey,
      sessionCount: schedule.sessions.length,
      audience: "parent",
    });
  }

  const now = deps.now();
  const expiresAt = new Date(now.getTime() + PENDING_TTL_MINUTES * 60 * 1000);
  const pendingRow = {
    lineUserId,
    scopeKey: scopeKeyFor(target.groupId),
    groupId: target.groupId,
    studentKey: student.studentKey,
    wiseStudentId: student.wiseStudentId,
    studentName: student.studentName,
    parentName: student.parentName ?? "",
    targetLineUserId: "",
    targetDisplayName: "",
    monthKey,
    sessionCount: schedule.sessions.length,
    expiresAt,
  };

  await db
    .insert(schema.lineScheduleBotPending)
    .values(pendingRow)
    .onConflictDoUpdate({
      target: [
        schema.lineScheduleBotPending.lineUserId,
        schema.lineScheduleBotPending.scopeKey,
      ],
      set: { ...pendingRow, createdAt: now },
    });

  await say(deps, target, groupConfirmPrompt({
    studentName: student.studentName,
    code: parseStudentDisplay(student.studentName).code,
    monthKey,
    sessionCount: schedule.sessions.length,
    ttlMinutes: PENDING_TTL_MINUTES,
  }));

  return { handled: true, action: "awaiting_confirm" };
}

async function confirmGroupSend(
  db: Database,
  deps: GroupBotDeps,
  target: { groupId: string; replyToken: string | null },
  lineUserId: string,
): Promise<GroupBotResult> {
  const now = deps.now();
  const [pending] = await db
    .select()
    .from(schema.lineScheduleBotPending)
    .where(and(
      eq(schema.lineScheduleBotPending.lineUserId, lineUserId),
      eq(schema.lineScheduleBotPending.scopeKey, scopeKeyFor(target.groupId)),
    ))
    .orderBy(desc(schema.lineScheduleBotPending.createdAt))
    .limit(1);

  if (!pending || pending.expiresAt.getTime() <= now.getTime()) {
    if (pending) await clearPending(db, lineUserId, target.groupId);
    await say(deps, target, GROUP_PENDING_EXPIRED);
    return { handled: true, action: "pending_expired" };
  }

  return deliver(db, deps, target, {
    lineUserId,
    studentKey: pending.studentKey,
    wiseStudentId: pending.wiseStudentId,
    studentName: pending.studentName,
    monthKey: pending.monthKey,
    sessionCount: pending.sessionCount,
    audience: "parent",
  });
}

/**
 * Mints the link, posts it into the originating conversation, and records the
 * send.
 *
 * `audience` only selects the wording. Either way the message lands in the chat
 * the command came from — for "requester" that is an admin who will forward it
 * by hand; for "parent" it is the Thai template the family reads directly.
 */
async function deliver(
  db: Database,
  deps: GroupBotDeps,
  target: { groupId: string; replyToken: string | null },
  student: {
    lineUserId: string;
    studentKey: string;
    wiseStudentId: string;
    studentName: string;
    monthKey: string;
    sessionCount: number;
    audience: "requester" | "parent";
  },
): Promise<GroupBotResult> {
  let token: string;
  let expiresAt: Date;
  let linkId: string;
  try {
    ({ token, expiresAt, id: linkId } = await mintStudentScheduleLink(db, {
      studentKey: student.studentKey,
      wiseStudentId: student.wiseStudentId,
      studentName: student.studentName,
      monthKey: student.monthKey,
      createdByLineUserId: student.lineUserId,
      sentToGroupId: target.groupId,
      ttlDays: deps.ttlDays,
      now: deps.now(),
    }));
  } catch (error) {
    // Minting failed, so nothing was sent — but messaging still works, so the
    // group is told rather than left in silence.
    console.error("[schedule-bot-group] mint failed", error);
    await say(deps, target, GROUP_SEND_FAILED).catch(() => undefined);
    return { handled: true, action: "send_failed" };
  }

  const url = studentScheduleLinkUrl(deps.baseUrl, token);
  const display = parseStudentDisplay(student.studentName);
  const text = student.audience === "parent"
    ? parentSchedulePushMessage({
      shortName: display.shortName,
      monthKey: student.monthKey,
      url,
      expiresAt,
    })
    : adminScheduleLinkReply({
      studentName: student.studentName,
      code: display.code,
      monthKey: student.monthKey,
      sessionCount: student.sessionCount,
      url,
      expiresAt,
    });

  try {
    await say(deps, target, text);
  } catch (error) {
    // Both reply and push failed — there is no channel left to apologise on.
    console.error("[schedule-bot-group] delivery failed", error);
    await clearPending(db, student.lineUserId, target.groupId).catch(() => undefined);
    return { handled: true, action: "send_failed" };
  }

  await clearPending(db, student.lineUserId, target.groupId).catch(() => undefined);

  // Audit, and the record that lets a repeat request skip the confirm step.
  await db
    .insert(schema.lineGroupScheduleSends)
    .values({
      groupId: target.groupId,
      studentKey: student.studentKey,
      studentName: student.studentName,
      monthKey: student.monthKey,
      requestedByLineUserId: student.lineUserId,
      linkId,
    })
    .catch((error) => {
      console.error("[schedule-bot-group] send audit failed", error);
    });

  return { handled: true, action: "sent" };
}
