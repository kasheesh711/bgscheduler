import { eq, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  DEFAULT_CONTACT_ALIASES,
  buildDefaultTutorContacts,
} from "./tutor-contacts";
import { REMOTE_NO_ROOM_NEEDED } from "./assignment-engine";
import { sessionModeLabel } from "./session-mode";

type ClassroomRun = typeof schema.classroomAssignmentRuns.$inferSelect;

interface AssignmentEmailRow {
  id: string;
  groupId: string;
  canonicalKey: string;
  tutorDisplayName: string;
  startTime: Date;
  endTime: Date;
  startMinute: number;
  endMinute: number;
  sessionType: string | null;
  assignedRoom: string;
  status: "assigned" | "needs_review" | "no_room" | "remote";
  studentName: string | null;
  subject: string | null;
  classType: string | null;
  title: string | null;
}

export interface ScheduleEmailBlock {
  rowId: string;
  time: string;
  studentOrClass: string;
  subject: string;
  mode: string;
  room: string;
}

export interface ScheduleEmailRecipient {
  groupId: string;
  canonicalKey: string;
  tutorDisplayName: string;
  email: string | null;
  status: "ready" | "blocked";
  blockReason: string | null;
}

export interface ScheduleEmailPreviewItem {
  recipient: ScheduleEmailRecipient;
  subject: string;
  html: string;
  text: string;
  blocks: ScheduleEmailBlock[];
}

export interface ScheduleEmailBlocker {
  type: "no_rows" | "unfinalized_rows" | "missing_recipient_email" | "missing_email_config";
  message: string;
  groupId?: string;
  tutorDisplayName?: string;
  rowIds?: string[];
}

export interface ScheduleEmailPreview {
  ready: boolean;
  sendable: boolean;
  assignmentRunId: string;
  assignmentDate: string;
  subject: string;
  hardBlockers: ScheduleEmailBlocker[];
  blockers: ScheduleEmailBlocker[];
  readyCount: number;
  blockedCount: number;
  recipients: ScheduleEmailRecipient[];
  previews: ScheduleEmailPreviewItem[];
}

export interface ScheduleEmailSendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

export interface ScheduleEmailSender {
  sendEmail(input: ScheduleEmailSendInput): Promise<{ id: string }>;
}

export interface ScheduleEmailSendResult {
  summary: {
    attempted: number;
    success: number;
    failed: number;
    blocked: number;
  };
  recipients: Array<ScheduleEmailRecipient & {
    sendStatus: "sent" | "failed" | "blocked";
    resendEmailId: string | null;
    error: string | null;
  }>;
  preview: ScheduleEmailPreview;
}

function aliasMapFromRows(rows: Array<{ fromKey: string; toKey: string }>): Map<string, string> {
  const aliases = new Map(DEFAULT_CONTACT_ALIASES);
  for (const row of rows) {
    aliases.set(row.fromKey.toLowerCase(), row.toKey);
  }
  return aliases;
}

export async function ensureDefaultTutorContacts(db: Database): Promise<void> {
  const aliases = await db
    .select({
      fromKey: schema.tutorAliases.fromKey,
      toKey: schema.tutorAliases.toKey,
    })
    .from(schema.tutorAliases);
  const defaults = buildDefaultTutorContacts(undefined, aliasMapFromRows(aliases));
  if (defaults.length === 0) return;

  const existing = await db
    .select({ canonicalKey: schema.tutorContacts.canonicalKey })
    .from(schema.tutorContacts);
  const existingKeys = new Set(existing.map((row) => row.canonicalKey));
  const missing = defaults.filter((contact) => !existingKeys.has(contact.canonicalKey));
  if (missing.length === 0) return;

  await db
    .insert(schema.tutorContacts)
    .values(missing.map((contact) => ({
      canonicalKey: contact.canonicalKey,
      displayName: contact.displayName,
      onsiteEmail: contact.onsiteEmail,
      onlineEmail: contact.onlineEmail,
      onsitePhone: contact.onsitePhone,
      onlinePhone: contact.onlinePhone,
      sourceNames: contact.sourceNames,
    })))
    .onConflictDoNothing({ target: schema.tutorContacts.canonicalKey });
}

function formatRunDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return `${day}/${month}/${year}`;
}

function formatBangkokTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function classLabel(row: Pick<AssignmentEmailRow, "subject" | "classType" | "title">): string {
  return row.subject || row.classType || row.title || "-";
}

function studentOrClass(row: Pick<AssignmentEmailRow, "studentName" | "title">): string {
  return row.studentName || row.title || "Untitled class";
}

function roomLabel(row: Pick<AssignmentEmailRow, "status" | "assignedRoom">): string {
  if (row.status === "remote" || row.assignedRoom === REMOTE_NO_ROOM_NEEDED) {
    return "Remote / no room needed";
  }
  return row.assignedRoom;
}

function toBlock(row: AssignmentEmailRow): ScheduleEmailBlock {
  return {
    rowId: row.id,
    time: `${formatBangkokTime(row.startTime)}-${formatBangkokTime(row.endTime)}`,
    studentOrClass: studentOrClass(row),
    subject: classLabel(row),
    mode: sessionModeLabel(row.sessionType),
    room: roomLabel(row),
  };
}

function renderHtmlEmail(input: {
  tutorDisplayName: string;
  dateLabel: string;
  blocks: ScheduleEmailBlock[];
}): string {
  const rows = input.blocks.map((block) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:monospace;white-space:nowrap;">${escapeHtml(block.time)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(block.studentOrClass)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(block.subject)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(block.mode)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600;">${escapeHtml(block.room)}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f8fafc;color:#0f172a;font-family:Arial,sans-serif;">
    <div style="max-width:760px;margin:0 auto;padding:24px;">
      <h1 style="font-size:20px;margin:0 0 4px;">BeGifted schedule</h1>
      <p style="margin:0 0 20px;color:#475569;">${escapeHtml(input.tutorDisplayName)} - ${escapeHtml(input.dateLabel)}</p>
      <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;">
        <thead>
          <tr style="background:#f1f5f9;text-align:left;">
            <th style="padding:8px;border-bottom:1px solid #e5e7eb;">Time</th>
            <th style="padding:8px;border-bottom:1px solid #e5e7eb;">Student/Class</th>
            <th style="padding:8px;border-bottom:1px solid #e5e7eb;">Subject</th>
            <th style="padding:8px;border-bottom:1px solid #e5e7eb;">Mode</th>
            <th style="padding:8px;border-bottom:1px solid #e5e7eb;">Room</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </body>
</html>`;
}

function renderTextEmail(input: {
  tutorDisplayName: string;
  dateLabel: string;
  blocks: ScheduleEmailBlock[];
}): string {
  const lines = [
    `BeGifted schedule for ${input.tutorDisplayName} - ${input.dateLabel}`,
    "",
    "Time | Student/Class | Subject | Mode | Room",
    ...input.blocks.map((block) =>
      `${block.time} | ${block.studentOrClass} | ${block.subject} | ${block.mode} | ${block.room}`,
    ),
  ];
  return lines.join("\n");
}

async function loadRun(db: Database, runId: string): Promise<ClassroomRun> {
  const [run] = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Assignment run not found");
  return run;
}

async function loadRows(db: Database, runId: string): Promise<AssignmentEmailRow[]> {
  const rows = await db
    .select({
      id: schema.classroomAssignmentRows.id,
      groupId: schema.classroomAssignmentRows.groupId,
      canonicalKey: schema.tutorIdentityGroups.canonicalKey,
      tutorDisplayName: schema.classroomAssignmentRows.tutorDisplayName,
      startTime: schema.classroomAssignmentRows.startTime,
      endTime: schema.classroomAssignmentRows.endTime,
      startMinute: schema.classroomAssignmentRows.startMinute,
      endMinute: schema.classroomAssignmentRows.endMinute,
      sessionType: schema.classroomAssignmentRows.sessionType,
      assignedRoom: schema.classroomAssignmentRows.assignedRoom,
      status: schema.classroomAssignmentRows.status,
      studentName: schema.classroomAssignmentRows.studentName,
      subject: schema.classroomAssignmentRows.subject,
      classType: schema.classroomAssignmentRows.classType,
      title: schema.classroomAssignmentRows.title,
    })
    .from(schema.classroomAssignmentRows)
    .innerJoin(
      schema.tutorIdentityGroups,
      eq(schema.classroomAssignmentRows.groupId, schema.tutorIdentityGroups.id),
    )
    .where(eq(schema.classroomAssignmentRows.runId, runId));

  return rows
    .map((row) => ({
      ...row,
      startTime: new Date(row.startTime),
      endTime: new Date(row.endTime),
    }))
    .sort((a, b) => {
      if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
      return a.tutorDisplayName.localeCompare(b.tutorDisplayName);
    });
}

async function loadContactByCanonicalKey(
  db: Database,
  canonicalKeys: string[],
): Promise<Map<string, typeof schema.tutorContacts.$inferSelect>> {
  if (canonicalKeys.length === 0) return new Map();
  const contacts = await db
    .select()
    .from(schema.tutorContacts)
    .where(inArray(schema.tutorContacts.canonicalKey, canonicalKeys));
  return new Map(contacts.filter((contact) => contact.active).map((contact) => [contact.canonicalKey, contact]));
}

function emailConfigBlockers(): ScheduleEmailBlocker[] {
  const blockers: ScheduleEmailBlocker[] = [];
  if (!process.env.RESEND_API_KEY?.trim()) {
    blockers.push({
      type: "missing_email_config",
      message: "RESEND_API_KEY is not configured.",
    });
  }
  if (!process.env.SCHEDULE_EMAIL_FROM?.trim()) {
    blockers.push({
      type: "missing_email_config",
      message: "SCHEDULE_EMAIL_FROM is not configured.",
    });
  }
  return blockers;
}

export async function getScheduleEmailPreview(
  db: Database,
  runId: string,
): Promise<ScheduleEmailPreview> {
  await ensureDefaultTutorContacts(db);
  const run = await loadRun(db, runId);
  const rows = await loadRows(db, runId);
  const subject = `BeGifted schedule for ${formatRunDate(run.assignmentDate)}`;
  const hardBlockers: ScheduleEmailBlocker[] = [...emailConfigBlockers()];
  const blockers: ScheduleEmailBlocker[] = [...hardBlockers];

  if (rows.length === 0) {
    const blocker: ScheduleEmailBlocker = {
      type: "no_rows",
      message: "This assignment run has no schedule rows to email.",
    };
    hardBlockers.push(blocker);
    blockers.push(blocker);
  }

  const rowsByGroup = new Map<string, AssignmentEmailRow[]>();
  for (const row of rows) {
    rowsByGroup.set(row.groupId, [...(rowsByGroup.get(row.groupId) ?? []), row]);
  }

  const canonicalKeys = [...new Set(rows.map((row) => row.canonicalKey))];
  const contacts = await loadContactByCanonicalKey(db, canonicalKeys);
  const recipients: ScheduleEmailRecipient[] = [];
  const previews: ScheduleEmailPreviewItem[] = [];
  const dateLabel = formatRunDate(run.assignmentDate);

  for (const [groupId, groupRows] of rowsByGroup) {
    const first = groupRows[0];
    const contact = contacts.get(first.canonicalKey);
    const email = contact?.onsiteEmail?.trim() || null;
    const missingEmail = !email;
    const groupUnfinalizedRows = groupRows.filter((row) => row.status === "needs_review" || row.status === "no_room");
    const rowBlockReason = groupUnfinalizedRows.length > 0
      ? `${groupUnfinalizedRows.length} schedule row${groupUnfinalizedRows.length === 1 ? "" : "s"} still need assignment review`
      : null;
    if (missingEmail) {
      blockers.push({
        type: "missing_recipient_email",
        groupId,
        tutorDisplayName: first.tutorDisplayName,
        message: `${first.tutorDisplayName} has no non-online email address configured.`,
      });
    }
    if (rowBlockReason) {
      blockers.push({
        type: "unfinalized_rows",
        groupId,
        tutorDisplayName: first.tutorDisplayName,
        message: `${first.tutorDisplayName}: ${rowBlockReason}.`,
        rowIds: groupUnfinalizedRows.map((row) => row.id),
      });
    }

    const blockReason = missingEmail
      ? "Missing non-online email address"
      : rowBlockReason;

    const recipient: ScheduleEmailRecipient = {
      groupId,
      canonicalKey: first.canonicalKey,
      tutorDisplayName: first.tutorDisplayName,
      email,
      status: blockReason ? "blocked" : "ready",
      blockReason,
    };
    const blocks = groupRows.sort((a, b) => a.startMinute - b.startMinute).map(toBlock);
    previews.push({
      recipient,
      subject,
      html: renderHtmlEmail({ tutorDisplayName: first.tutorDisplayName, dateLabel, blocks }),
      text: renderTextEmail({ tutorDisplayName: first.tutorDisplayName, dateLabel, blocks }),
      blocks,
    });
    recipients.push(recipient);
  }

  recipients.sort((a, b) => a.tutorDisplayName.localeCompare(b.tutorDisplayName));
  previews.sort((a, b) => a.recipient.tutorDisplayName.localeCompare(b.recipient.tutorDisplayName));
  const readyCount = recipients.filter((recipient) => recipient.status === "ready").length;
  const blockedCount = recipients.length - readyCount;

  return {
    ready: blockers.length === 0,
    sendable: hardBlockers.length === 0 && readyCount > 0,
    assignmentRunId: run.id,
    assignmentDate: run.assignmentDate,
    subject,
    hardBlockers,
    blockers,
    readyCount,
    blockedCount,
    recipients,
    previews,
  };
}

export function createResendScheduleEmailSender(): ScheduleEmailSender {
  return {
    async sendEmail(input) {
      const apiKey = process.env.RESEND_API_KEY?.trim();
      const from = process.env.SCHEDULE_EMAIL_FROM?.trim();
      if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
      if (!from) throw new Error("SCHEDULE_EMAIL_FROM is not configured");

      const body: Record<string, unknown> = {
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      };
      const replyTo = process.env.SCHEDULE_EMAIL_REPLY_TO?.trim();
      if (replyTo) body.reply_to = replyTo;

      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => null) as { id?: string; message?: string; error?: string } | null;
      if (!response.ok) {
        throw new Error(json?.message ?? json?.error ?? `Resend returned HTTP ${response.status}`);
      }
      if (!json?.id) {
        throw new Error("Resend response did not include an email id");
      }
      return { id: json.id };
    },
  };
}

function idempotencyKey(runId: string, canonicalKey: string): string {
  return `classroom-schedule:${runId}:${canonicalKey}`.slice(0, 256);
}

async function insertRecipientResult(
  db: Database,
  input: {
    emailRunId: string;
    assignmentRunId: string;
    recipient: ScheduleEmailRecipient;
    status: "sent" | "failed" | "blocked";
    resendEmailId?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await db.insert(schema.classroomScheduleEmailRecipients).values({
    emailRunId: input.emailRunId,
    assignmentRunId: input.assignmentRunId,
    groupId: input.recipient.groupId,
    canonicalKey: input.recipient.canonicalKey,
    tutorDisplayName: input.recipient.tutorDisplayName,
    recipientEmail: input.recipient.email,
    status: input.status,
    resendEmailId: input.resendEmailId ?? null,
    error: input.error ?? null,
  });
}

export async function sendScheduleEmailsForRun(
  db: Database,
  runId: string,
  createdBy: string | null,
  sender: ScheduleEmailSender = createResendScheduleEmailSender(),
): Promise<ScheduleEmailSendResult> {
  const preview = await getScheduleEmailPreview(db, runId);
  const [emailRun] = await db
    .insert(schema.classroomScheduleEmailRuns)
    .values({
      assignmentRunId: runId,
      status: preview.sendable ? "pending" : "blocked",
      subject: preview.subject,
      createdBy,
      blockedCount: preview.blockedCount,
    })
    .returning();

  const recipients: ScheduleEmailSendResult["recipients"] = [];
  if (!preview.sendable) {
    for (const item of preview.previews) {
      const hardBlockerText = preview.hardBlockers.map((blocker) => blocker.message).join(" ");
      const error = item.recipient.blockReason || hardBlockerText || "Schedule email preview is blocked";
      await insertRecipientResult(db, {
        emailRunId: emailRun.id,
        assignmentRunId: runId,
        recipient: item.recipient,
        status: "blocked",
        error,
      });
      recipients.push({
        ...item.recipient,
        sendStatus: "blocked",
        resendEmailId: null,
        error,
      });
    }
    return {
      summary: { attempted: 0, success: 0, failed: 0, blocked: preview.previews.length },
      recipients,
      preview,
    };
  }

  let success = 0;
  let failed = 0;
  let blocked = 0;
  let attempted = 0;
  for (const item of preview.previews) {
    if (item.recipient.status === "blocked" || !item.recipient.email) {
      blocked += 1;
      const error = item.recipient.blockReason ?? "Recipient is blocked";
      await insertRecipientResult(db, {
        emailRunId: emailRun.id,
        assignmentRunId: runId,
        recipient: item.recipient,
        status: "blocked",
        error,
      });
      recipients.push({
        ...item.recipient,
        sendStatus: "blocked",
        resendEmailId: null,
        error,
      });
      continue;
    }

    attempted += 1;
    try {
      const sent = await sender.sendEmail({
        to: item.recipient.email,
        subject: item.subject,
        html: item.html,
        text: item.text,
        idempotencyKey: idempotencyKey(runId, item.recipient.canonicalKey),
      });
      success += 1;
      await insertRecipientResult(db, {
        emailRunId: emailRun.id,
        assignmentRunId: runId,
        recipient: item.recipient,
        status: "sent",
        resendEmailId: sent.id,
      });
      recipients.push({
        ...item.recipient,
        sendStatus: "sent",
        resendEmailId: sent.id,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Email send failed";
      failed += 1;
      await insertRecipientResult(db, {
        emailRunId: emailRun.id,
        assignmentRunId: runId,
        recipient: item.recipient,
        status: "failed",
        error: message,
      });
      recipients.push({
        ...item.recipient,
        sendStatus: "failed",
        resendEmailId: null,
        error: message,
      });
    }
  }

  const status =
    failed > 0
      ? success > 0
        ? "partial"
        : "failed"
      : blocked > 0
        ? "partial"
        : "sent";
  await db
    .update(schema.classroomScheduleEmailRuns)
    .set({
      status,
      attemptedCount: attempted,
      successCount: success,
      failedCount: failed,
      blockedCount: blocked,
      updatedAt: new Date(),
    })
    .where(eq(schema.classroomScheduleEmailRuns.id, emailRun.id));

  return {
    summary: {
      attempted,
      success,
      failed,
      blocked,
    },
    recipients,
    preview,
  };
}
