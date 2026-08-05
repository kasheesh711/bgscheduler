// ----------------------------------------------------------------------------
// LINE schedule bot — an admin DMs a student code, the bot pushes that child's
// monthly schedule link to the parent.
//
// This module can send a message about a child to a phone number the operator
// did not type, so it is written to fail closed at four independent gates. All
// four must pass before pushLineTextMessage is reached:
//
//   SCHED-BOT-01  Sender allowlist. Only LINE user IDs in
//                 LINE_SCHEDULE_BOT_ADMIN_IDS are served. Everyone else gets
//                 `handled: false` and NO reply, so a parent messaging the OA
//                 sees no evidence the bot exists and the normal classifier
//                 path runs untouched.
//   SCHED-BOT-02  Verified link only. The recipient is resolved exclusively
//                 from line_contact_student_links rows with status='verified'
//                 and isPhantom=false. Suggested/rejected/missing → refuse.
//                 There is no name-matching fallback, by design.
//   SCHED-BOT-03  Explicit confirm. The first message never sends. A pending
//                 row (5 min TTL) is written and the admin must reply YES.
//                 Ambiguity at any step lists candidates and picks nothing.
//   SCHED-BOT-04  Non-empty month. A month with zero classes refuses rather
//                 than pushing a blank calendar to a parent.
//
// Ordering note: the router runs BEFORE classifyLineSchedulerMessage so an
// admin command never costs an OpenAI call and never lands in the parent
// scheduling queue.
// ----------------------------------------------------------------------------

import { v5 as uuidv5 } from "uuid";
import { and, eq } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { pushLineTextMessage } from "@/lib/line/client";
import { searchCurrentLineStudents } from "@/lib/line/student-links";
import {
  ANSWER_PATTERN,
  COMMAND_PATTERN,
  HELP_PATTERN,
  NO_PATTERN,
  YES_PATTERN,
  detectTrigger,
  exactCodeMatches,
} from "@/lib/line/schedule-bot-command";
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
  ADMIN_CANCELLED,
  ADMIN_HELP,
  ADMIN_NO_SNAPSHOT,
  ADMIN_PENDING_EXPIRED,
  ADMIN_SEND_FAILED,
  adminAmbiguous,
  adminConfirmPrompt,
  adminScheduleLinkReply,
  adminEmptyMonth,
  adminMultipleContacts,
  adminNoVerifiedContact,
  adminNotFound,
  adminSent,
  parentSchedulePushMessage,
} from "@/lib/line/schedule-bot-copy";

/** Namespace for deterministic push retry keys (mirrors review-service). */
const SCHEDULE_BOT_RETRY_NAMESPACE = "6f6d9a1e-4f2b-4a0f-9c7a-1d5f0b3e8a24";

const PENDING_TTL_MINUTES = 5;
const MAX_CANDIDATES = 5;
const DEFAULT_BASE_URL = "https://bgscheduler.vercel.app";

// Command grammar is shared with the group path — see schedule-bot-command.ts.

export interface ScheduleBotDeps {
  /** Injected so tests never reach api.line.me. */
  push: typeof pushLineTextMessage;
  now: () => Date;
  baseUrl: string;
  ttlDays: number;
}

export interface ScheduleBotResult {
  handled: boolean;
  /** Set only for handled commands; useful for tests and log assertions. */
  action?:
    | "help"
    | "not_found"
    | "ambiguous"
    | "no_verified_contact"
    | "multiple_contacts"
    | "empty_month"
    | "awaiting_confirm"
    | "sent"
    | "cancelled"
    | "pending_expired"
    | "no_snapshot"
    | "send_failed";
}

/**
 * Parses LINE_SCHEDULE_BOT_ADMIN_IDS. Blank entries are dropped; an empty or
 * unset value yields an empty set, which disables the bot (SCHED-BOT-01).
 */
export function scheduleBotAdminIds(raw = process.env.LINE_SCHEDULE_BOT_ADMIN_IDS): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function isScheduleBotAdmin(lineUserId: string, raw?: string): boolean {
  const ids = scheduleBotAdminIds(raw);
  return ids.size > 0 && ids.has(lineUserId);
}

function resolveDeps(overrides: Partial<ScheduleBotDeps> = {}): ScheduleBotDeps {
  return {
    push: overrides.push ?? pushLineTextMessage,
    now: overrides.now ?? (() => new Date()),
    baseUrl: overrides.baseUrl
      ?? process.env.APP_BASE_URL?.trim()
      ?? DEFAULT_BASE_URL,
    ttlDays: overrides.ttlDays
      ?? (Number(process.env.STUDENT_SCHEDULE_LINK_TTL_DAYS) || DEFAULT_LINK_TTL_DAYS),
  };
}

/** Verified, non-phantom LINE contacts for a student (SCHED-BOT-02). */
export async function verifiedContactsForStudent(
  db: Database,
  studentKey: string,
): Promise<Array<{ contactId: string; lineUserId: string; displayName: string }>> {
  const rows = await db
    .select({
      contactId: schema.lineContacts.id,
      lineUserId: schema.lineContacts.lineUserId,
      displayName: schema.lineContacts.displayName,
    })
    .from(schema.lineContactStudentLinks)
    .innerJoin(
      schema.lineContacts,
      eq(schema.lineContactStudentLinks.contactId, schema.lineContacts.id),
    )
    .where(and(
      eq(schema.lineContactStudentLinks.studentKey, studentKey),
      eq(schema.lineContactStudentLinks.status, "verified"),
      eq(schema.lineContactStudentLinks.isPhantom, false),
    ));

  const byLineUserId = new Map<string, { contactId: string; lineUserId: string; displayName: string }>();
  for (const row of rows) {
    if (!row.lineUserId) continue;
    byLineUserId.set(row.lineUserId, {
      contactId: row.contactId,
      lineUserId: row.lineUserId,
      displayName: row.displayName?.trim() || "this contact",
    });
  }
  return [...byLineUserId.values()];
}

async function reply(
  deps: ScheduleBotDeps,
  lineUserId: string,
  text: string,
): Promise<void> {
  try {
    await deps.push({ to: lineUserId, text });
  } catch (error) {
    // A failed reply to an operator must never bubble into the webhook.
    console.error("[schedule-bot] reply failed", error);
  }
}

/** Confirm state for this module is always DM-scoped; groups use "group:<id>". */
const DM_SCOPE = "dm";

/** True when a confirmation is outstanding for this admin's DM thread. */
async function hasPendingDm(db: Database, lineUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.lineScheduleBotPending.id })
    .from(schema.lineScheduleBotPending)
    .where(and(
      eq(schema.lineScheduleBotPending.lineUserId, lineUserId),
      eq(schema.lineScheduleBotPending.scopeKey, DM_SCOPE),
    ))
    .limit(1);
  return Boolean(row);
}

async function clearPending(db: Database, lineUserId: string): Promise<void> {
  await db
    .delete(schema.lineScheduleBotPending)
    .where(and(
      eq(schema.lineScheduleBotPending.lineUserId, lineUserId),
      eq(schema.lineScheduleBotPending.scopeKey, DM_SCOPE),
    ));
}

/**
 * Routes one inbound admin message.
 *
 * @returns `{handled: false}` when the message is not a schedule-bot command or
 *   the sender is not an allowlisted admin — the caller must then continue with
 *   its normal processing as if this module did not exist.
 */
export async function handleScheduleBotCommand(
  {
    db,
    lineUserId,
    text,
  }: { db: Database; lineUserId: string; text: string },
  overrides: Partial<ScheduleBotDeps> = {},
): Promise<ScheduleBotResult> {
  // SCHED-BOT-01 — silent for everyone else.
  if (!isScheduleBotAdmin(lineUserId)) return { handled: false };

  const deps = resolveDeps(overrides);
  const raw = text.trim();
  if (!raw) return { handled: false };

  // A command must be explicitly addressed to the bot. Without this, ANY short
  // message an admin sends the OA was treated as a student code — typing "ok"
  // got back "No student matches ok" — and it swallowed staff messages that
  // belonged in the normal review queue.
  // A bare YES/NO is accepted when a confirmation is outstanding, because the
  // prompt asks for exactly that and does not mention the prefix.
  const trigger = detectTrigger(raw, []);
  if (trigger.kind === "none") {
    if (!ANSWER_PATTERN.test(raw) || !(await hasPendingDm(db, lineUserId))) {
      return { handled: false };
    }
    trigger.kind = "answer";
    trigger.command = raw;
  }
  const trimmed = trigger.command;
  if (!trimmed) {
    await reply(deps, lineUserId, ADMIN_HELP);
    return { handled: true, action: "help" };
  }

  if (HELP_PATTERN.test(trimmed)) {
    await reply(deps, lineUserId, ADMIN_HELP);
    return { handled: true, action: "help" };
  }

  if (NO_PATTERN.test(trimmed)) {
    await clearPending(db, lineUserId);
    await reply(deps, lineUserId, ADMIN_CANCELLED);
    return { handled: true, action: "cancelled" };
  }

  if (YES_PATTERN.test(trimmed)) {
    return confirmPendingSend(db, deps, lineUserId);
  }

  const match = COMMAND_PATTERN.exec(trimmed);
  if (!match) {
    await reply(deps, lineUserId, ADMIN_HELP);
    return { handled: true, action: "help" };
  }

  const query = match[1];
  const monthKey = match[2] ?? getMonthKey(todayBangkok(deps.now()));
  const pushToParent = Boolean(match[3]);
  if (!isMonthKey(monthKey)) {
    await reply(deps, lineUserId, ADMIN_HELP);
    return { handled: true, action: "help" };
  }

  // Default: hand the link back to the admin who asked, so they can forward it
  // themselves. Only the explicit `send` verb resolves and messages a parent,
  // which is what requires a verified contact link (and reaches ~7 students).
  if (!pushToParent) {
    return replyWithLink(db, deps, lineUserId, query, monthKey);
  }

  return startSend(db, deps, lineUserId, query, monthKey);
}

/**
 * Resolves the student, mints a link, and replies to the requesting admin.
 * Nothing is sent to any third party on this path, so it needs neither a
 * verified contact link nor a confirmation step.
 */
async function replyWithLink(
  db: Database,
  deps: ScheduleBotDeps,
  lineUserId: string,
  query: string,
  monthKey: string,
): Promise<ScheduleBotResult> {
  const matches = await searchCurrentLineStudents(db, query, MAX_CANDIDATES);
  const exact = exactCodeMatches(query, matches);

  if (matches.length === 0) {
    await reply(deps, lineUserId, adminNotFound(query));
    return { handled: true, action: "not_found" };
  }
  if (exact.length !== 1) {
    await reply(deps, lineUserId, adminAmbiguous(query, matches.map((row) => ({
      code: parseStudentDisplay(row.studentName).code,
      studentName: row.studentName,
    }))));
    return { handled: true, action: "ambiguous" };
  }

  const student = exact[0];
  const schedule = await getStudentMonthlySchedule(db, {
    studentKey: student.studentKey,
    monthKey,
  });
  if (!schedule) {
    await reply(deps, lineUserId, ADMIN_NO_SNAPSHOT);
    return { handled: true, action: "no_snapshot" };
  }
  if (schedule.sessions.length === 0) {
    await reply(deps, lineUserId, adminEmptyMonth(student.studentName, monthKey));
    return { handled: true, action: "empty_month" };
  }

  const { token, expiresAt } = await mintStudentScheduleLink(db, {
    studentKey: student.studentKey,
    wiseStudentId: student.wiseStudentId,
    studentName: student.studentName,
    monthKey,
    createdByLineUserId: lineUserId,
    ttlDays: deps.ttlDays,
    now: deps.now(),
  });

  const display = parseStudentDisplay(student.studentName);
  await reply(deps, lineUserId, adminScheduleLinkReply({
    studentName: student.studentName,
    code: display.code,
    monthKey,
    sessionCount: schedule.sessions.length,
    url: studentScheduleLinkUrl(deps.baseUrl, token),
    expiresAt,
  }));

  return { handled: true, action: "sent" };
}

async function startSend(
  db: Database,
  deps: ScheduleBotDeps,
  lineUserId: string,
  query: string,
  monthKey: string,
): Promise<ScheduleBotResult> {
  const matches = await searchCurrentLineStudents(db, query, MAX_CANDIDATES);

  if (matches.length === 0) {
    await reply(deps, lineUserId, adminNotFound(query));
    return { handled: true, action: "not_found" };
  }

  // SCHED-BOT-03 — ambiguity never auto-picks.
  if (matches.length > 1) {
    await reply(deps, lineUserId, adminAmbiguous(query, matches.map((row) => ({
      code: parseStudentDisplay(row.studentName).code,
      studentName: row.studentName,
    }))));
    return { handled: true, action: "ambiguous" };
  }

  const student = matches[0];

  // SCHED-BOT-02 — verified link required.
  const contacts = await verifiedContactsForStudent(db, student.studentKey);
  if (contacts.length === 0) {
    await reply(deps, lineUserId, adminNoVerifiedContact(student.studentName));
    return { handled: true, action: "no_verified_contact" };
  }
  if (contacts.length > 1) {
    await reply(deps, lineUserId, adminMultipleContacts(student.studentName, contacts));
    return { handled: true, action: "multiple_contacts" };
  }

  const schedule = await getStudentMonthlySchedule(db, {
    studentKey: student.studentKey,
    monthKey,
  });
  if (!schedule) {
    await reply(deps, lineUserId, ADMIN_NO_SNAPSHOT);
    return { handled: true, action: "no_snapshot" };
  }

  // SCHED-BOT-04 — never push an empty calendar.
  if (schedule.sessions.length === 0) {
    await reply(deps, lineUserId, adminEmptyMonth(student.studentName, monthKey));
    return { handled: true, action: "empty_month" };
  }

  const recipient = contacts[0];
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + PENDING_TTL_MINUTES * 60 * 1000);

  await db
    .insert(schema.lineScheduleBotPending)
    .values({
      lineUserId,
      scopeKey: DM_SCOPE,
      studentKey: student.studentKey,
      wiseStudentId: student.wiseStudentId,
      studentName: student.studentName,
      parentName: student.parentName ?? "",
      targetLineUserId: recipient.lineUserId,
      targetDisplayName: recipient.displayName,
      monthKey,
      sessionCount: schedule.sessions.length,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.lineScheduleBotPending.lineUserId,
        schema.lineScheduleBotPending.scopeKey,
      ],
      set: {
        studentKey: student.studentKey,
        wiseStudentId: student.wiseStudentId,
        studentName: student.studentName,
        parentName: student.parentName ?? "",
        targetLineUserId: recipient.lineUserId,
        targetDisplayName: recipient.displayName,
        monthKey,
        sessionCount: schedule.sessions.length,
        expiresAt,
        createdAt: now,
      },
    });

  await reply(deps, lineUserId, adminConfirmPrompt({
    studentName: student.studentName,
    code: parseStudentDisplay(student.studentName).code,
    monthKey,
    sessionCount: schedule.sessions.length,
    recipientDisplayName: recipient.displayName,
    parentName: student.parentName ?? "",
    ttlMinutes: PENDING_TTL_MINUTES,
  }));

  return { handled: true, action: "awaiting_confirm" };
}

async function confirmPendingSend(
  db: Database,
  deps: ScheduleBotDeps,
  lineUserId: string,
): Promise<ScheduleBotResult> {
  const now = deps.now();
  const [pending] = await db
    .select()
    .from(schema.lineScheduleBotPending)
    .where(and(
      eq(schema.lineScheduleBotPending.lineUserId, lineUserId),
      eq(schema.lineScheduleBotPending.scopeKey, DM_SCOPE),
    ))
    .limit(1);

  // SCHED-BOT-03 — no live pending row means nothing is sent, full stop.
  if (!pending || pending.expiresAt.getTime() <= now.getTime()) {
    if (pending) await clearPending(db, lineUserId);
    await reply(deps, lineUserId, ADMIN_PENDING_EXPIRED);
    return { handled: true, action: "pending_expired" };
  }

  const { token, expiresAt } = await mintStudentScheduleLink(db, {
    studentKey: pending.studentKey,
    wiseStudentId: pending.wiseStudentId,
    studentName: pending.studentName,
    monthKey: pending.monthKey,
    createdByLineUserId: lineUserId,
    sentToLineUserId: pending.targetLineUserId,
    ttlDays: deps.ttlDays,
    now,
  });

  const url = studentScheduleLinkUrl(deps.baseUrl, token);
  const message = parentSchedulePushMessage({
    shortName: parseStudentDisplay(pending.studentName).shortName,
    monthKey: pending.monthKey,
    url,
    expiresAt,
  });

  try {
    await deps.push({
      to: pending.targetLineUserId,
      text: message,
      // Deterministic per (pending row, recipient) so a webhook retry cannot
      // double-send the same schedule.
      retryKey: uuidv5(
        `schedule-bot:${lineUserId}:${pending.studentKey}:${pending.monthKey}:${pending.createdAt.toISOString()}`,
        SCHEDULE_BOT_RETRY_NAMESPACE,
      ),
    });
  } catch (error) {
    console.error("[schedule-bot] parent push failed", error);
    await clearPending(db, lineUserId);
    await reply(deps, lineUserId, ADMIN_SEND_FAILED);
    return { handled: true, action: "send_failed" };
  }

  await clearPending(db, lineUserId);
  await recordOutboundAudit(db, pending.targetLineUserId, message);
  await reply(deps, lineUserId, adminSent(pending.targetDisplayName, expiresAt));

  return { handled: true, action: "sent" };
}

/**
 * Mirrors the push into line_messages so the parent's thread shows what was
 * sent. Best-effort: the message has already been delivered, so an audit
 * failure must not surface as a send failure.
 */
async function recordOutboundAudit(
  db: Database,
  targetLineUserId: string,
  text: string,
): Promise<void> {
  try {
    const [contact] = await db
      .select({ id: schema.lineContacts.id })
      .from(schema.lineContacts)
      .where(eq(schema.lineContacts.lineUserId, targetLineUserId))
      .limit(1);
    if (!contact) return;

    const [thread] = await db
      .select({ id: schema.lineThreads.id })
      .from(schema.lineThreads)
      .where(eq(schema.lineThreads.contactId, contact.id))
      .limit(1);
    if (!thread) return;

    await db.insert(schema.lineMessages).values({
      threadId: thread.id,
      contactId: contact.id,
      direction: "outbound",
      messageType: "text",
      text,
      eventTimestamp: new Date(),
      raw: { source: "schedule-bot" },
    });
  } catch (error) {
    console.error("[schedule-bot] outbound audit failed", error);
  }
}
