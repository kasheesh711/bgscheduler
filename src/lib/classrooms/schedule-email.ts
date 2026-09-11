import { createHash } from "node:crypto";
import { teacherEmailLogoUrl } from "@/lib/teacher-emails/brand";
import { teacherEmailPublicBaseUrl as publicBaseUrl } from "@/lib/teacher-emails/config";
import { buildTeachingScheduleEmail, formatTeacherEmailDate, teachingScheduleSubject } from "@/lib/teacher-emails/templates";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { scheduleRecipientEmail } from "@/lib/tutor-onboarding/planner";
import { REMOTE_NO_ROOM_NEEDED } from "./assignment-engine";
import { buildTeacherSchedule } from "./schedule-projection";
import { notifiedTutorKeys } from "./notification-state";
import { isOnsiteSessionType, sessionModeLabel } from "./session-mode";

type ClassroomRun = typeof schema.classroomAssignmentRuns.$inferSelect;
const FLOOR_PLAN_MAP_VERSION = "2026-05-18-corridor";

interface AssignmentEmailRow {
  id: string;
  groupId: string;
  canonicalKey: string;
  tutorDisplayName: string;
  startMinute: number;
  endMinute: number;
  sessionType: string | null;
  assignedRoom: string;
  status: "assigned" | "needs_review" | "no_room" | "remote";
  publishStatus?: string;
  publishPending?: boolean;
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

export interface ScheduleEmailRoomStep {
  order: number;
  time: string;
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
  roomSteps: ScheduleEmailRoomStep[];
  mapImageUrl: string;
  usualRooms?: string[];
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

export type ScheduleEmailSenderKey = "primary" | "backup";
export type ScheduleEmailSendMode = "selected" | "failed_only";

export interface ScheduleEmailPreviewOptions {
  senderKey?: ScheduleEmailSenderKey;
}

export interface ScheduleEmailSendOptions {
  recipientGroupIds?: string[];
  senderKey?: ScheduleEmailSenderKey;
  mode?: ScheduleEmailSendMode;
  backupSender?: ScheduleEmailSender;
}

interface AppsScriptEmailResponse {
  ok?: boolean;
  id?: string;
  remainingQuota?: number;
  error?: string;
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
    senderKey: ScheduleEmailSenderKey;
    emailRunId: string;
  }>;
  preview: ScheduleEmailPreview;
  failover?: {
    triggered: boolean;
    fromEmailRunId: string;
    toEmailRunId?: string;
    reason: string;
    attempted: number;
    sent: number;
    failed: number;
  };
}

interface AppsScriptSenderConfig {
  url: string | undefined;
  secret: string | undefined;
  urlEnvName: string;
  secretEnvName: string;
}

function formatMinute(minute: number): string {
  const normalized = Math.max(0, minute);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
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

function physicalRoomLabel(row: Pick<AssignmentEmailRow, "status" | "assignedRoom">): string | null {
  if (row.status !== "assigned") return null;
  if (row.assignedRoom === REMOTE_NO_ROOM_NEEDED) return null;
  return row.assignedRoom.trim() || null;
}

function toBlock(row: AssignmentEmailRow): ScheduleEmailBlock {
  return {
    rowId: row.id,
    time: `${formatMinute(row.startMinute)}-${formatMinute(row.endMinute)}`,
    studentOrClass: studentOrClass(row),
    subject: classLabel(row),
    mode: sessionModeLabel(row.sessionType),
    room: roomLabel(row),
  };
}

function toRoomSteps(rows: AssignmentEmailRow[]): ScheduleEmailRoomStep[] {
  return rows
    .map((row) => ({
      time: `${formatMinute(row.startMinute)}-${formatMinute(row.endMinute)}`,
      room: physicalRoomLabel(row),
    }))
    .filter((step): step is { time: string; room: string } => Boolean(step.room))
    .map((step, index) => ({
      order: index + 1,
      time: step.time,
      room: step.room,
    }));
}

function floorPlanMapUrl(roomSteps: ScheduleEmailRoomStep[]): string {
  const rooms = [...new Set(roomSteps.map((step) => step.room))];
  const url = new URL("/api/classrooms/floor-plan-map", publicBaseUrl());
  if (rooms.length > 0) {
    url.searchParams.set("rooms", rooms.join("|"));
  }
  url.searchParams.set("v", FLOOR_PLAN_MAP_VERSION);
  return url.toString();
}

function appsScriptSenderConfig(senderKey: ScheduleEmailSenderKey): AppsScriptSenderConfig {
  if (senderKey === "backup") {
    return {
      url: process.env.SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL?.trim(),
      secret: process.env.SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET?.trim(),
      urlEnvName: "SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL",
      secretEnvName: "SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET",
    };
  }

  return {
    url: process.env.SCHEDULE_EMAIL_APPS_SCRIPT_URL?.trim(),
    secret: process.env.SCHEDULE_EMAIL_APPS_SCRIPT_SECRET?.trim(),
    urlEnvName: "SCHEDULE_EMAIL_APPS_SCRIPT_URL",
    secretEnvName: "SCHEDULE_EMAIL_APPS_SCRIPT_SECRET",
  };
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
      startMinute: schema.classroomAssignmentRows.startMinute,
      endMinute: schema.classroomAssignmentRows.endMinute,
      sessionType: schema.classroomAssignmentRows.sessionType,
      assignedRoom: schema.classroomAssignmentRows.assignedRoom,
      status: schema.classroomAssignmentRows.status,
      publishStatus: schema.classroomAssignmentRows.publishStatus,
      publishPending: sql<boolean>`exists (select 1 from ${schema.classroomPublishJobs} where ${schema.classroomPublishJobs.runId} = ${schema.classroomAssignmentRows.runId}
        and ${schema.classroomPublishJobs.status} in ('pending', 'running'))`,
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

function emailConfigBlockers(senderKey: ScheduleEmailSenderKey = "primary"): ScheduleEmailBlocker[] {
  const config = appsScriptSenderConfig(senderKey);
  const blockers: ScheduleEmailBlocker[] = [];
  if (!config.url) {
    blockers.push({
      type: "missing_email_config",
      message: `${config.urlEnvName} is not configured.`,
    });
  }
  if (!config.secret) {
    blockers.push({
      type: "missing_email_config",
      message: `${config.secretEnvName} is not configured.`,
    });
  }
  return blockers;
}

export async function getScheduleEmailPreview(
  db: Database,
  runId: string,
  options: ScheduleEmailPreviewOptions = {},
): Promise<ScheduleEmailPreview> {
  const run = await loadRun(db, runId);
  const rows = await loadRows(db, runId);
  const subject = teachingScheduleSubject(formatTeacherEmailDate(run.assignmentDate));
  const hardBlockers: ScheduleEmailBlocker[] = [...emailConfigBlockers(options.senderKey ?? "primary")];
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
    rowsByGroup.set(row.canonicalKey.toLowerCase(), [...(rowsByGroup.get(row.canonicalKey.toLowerCase()) ?? []), row]);
  }

  const canonicalKeys = [...new Set(rows.map((row) => row.canonicalKey))];
  const contacts = await loadContactByCanonicalKey(db, canonicalKeys);
  const recipients: ScheduleEmailRecipient[] = [];
  const previews: ScheduleEmailPreviewItem[] = [];
  const dateLabel = formatTeacherEmailDate(run.assignmentDate);

  const schedule = buildTeacherSchedule(rows, run.assignmentDate, run.changeSummary ?? {});
  for (const [canonicalKey, groupRows] of rowsByGroup) {
    const first = groupRows[0];
    const groupId = first.groupId;
    const projected = schedule.tutors.find(tutor => tutor.canonicalKey === canonicalKey);
    const usualRooms = projected?.usualRooms ?? [];
    const contact = contacts.get(first.canonicalKey);
    const email = scheduleRecipientEmail(contact);
    const missingEmail = !email;
    const groupUnfinalizedRows = groupRows.filter((row) => row.status === "needs_review" || row.status === "no_room" || row.publishStatus === "failed"
      || (row.status === "assigned" && isOnsiteSessionType(row.sessionType) && (row.publishStatus !== "success" || row.publishPending)));
    const rowBlockReason = groupUnfinalizedRows.length > 0
      ? `${groupUnfinalizedRows.length} schedule row${groupUnfinalizedRows.length === 1 ? "" : "s"} still need assignment review or successful Wise publishing`
      : null;
    if (missingEmail) {
      blockers.push({
        type: "missing_recipient_email",
        groupId,
        tutorDisplayName: first.tutorDisplayName,
        message: `${first.tutorDisplayName} has no valid email address configured.`,
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
      ? "Missing valid email address"
      : rowBlockReason;

    const recipient: ScheduleEmailRecipient = {
      groupId,
      canonicalKey: first.canonicalKey,
      tutorDisplayName: first.tutorDisplayName,
      email,
      status: blockReason ? "blocked" : "ready",
      blockReason,
    };
    const sortedGroupRows = groupRows.sort((a, b) => a.startMinute - b.startMinute);
    const blocks = sortedGroupRows.map(row => {
      const block = toBlock(row);
      const projectedBlock = projected?.blocks.find(item => item.rowId === row.id);
      return { ...block, room: projectedBlock ? `${projectedBlock.room}${projectedBlock.outsideUsualRooms ? " (outside usual rooms)" : ""}${projectedBlock.shortGapChange ? " — room change" : ""}` : block.room };
    });
    const roomSteps = toRoomSteps(sortedGroupRows);
    const mapImageUrl = floorPlanMapUrl(roomSteps);
    previews.push({
      recipient,
      usualRooms,
      ...buildTeachingScheduleEmail({
        tutorDisplayName: first.tutorDisplayName,
        dateLabel,
        blocks,
        usualRooms,
        mapUrl: roomSteps.length ? mapImageUrl : null,
        logoUrl: teacherEmailLogoUrl(publicBaseUrl()),
      }),
      blocks,
      roomSteps,
      mapImageUrl,
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

export function createAppsScriptScheduleEmailSender(
  senderKey: ScheduleEmailSenderKey = "primary",
): ScheduleEmailSender {
  return {
    async sendEmail(input) {
      const config = appsScriptSenderConfig(senderKey);
      if (!config.url) throw new Error(`${config.urlEnvName} is not configured`);
      if (!config.secret) throw new Error(`${config.secretEnvName} is not configured`);

      const senderName = process.env.SCHEDULE_EMAIL_SENDER_NAME?.trim() || "BeGifted";
      const replyTo = process.env.SCHEDULE_EMAIL_REPLY_TO?.trim() || "kevhsh7@gmail.com";
      const response = await fetch(config.url, {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          secret: config.secret,
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
          senderName,
          replyTo,
          idempotencyKey: input.idempotencyKey,
        }),
      });

      const json = await response.json().catch(() => null) as AppsScriptEmailResponse | null;
      if (!response.ok) {
        throw new Error(json?.error ?? `Apps Script returned HTTP ${response.status}`);
      }
      if (!json?.ok) {
        throw new Error(json?.error ?? "Apps Script email send failed");
      }
      return { id: json.id ?? `apps-script:${input.idempotencyKey}` };
    },
  };
}

function contentHash(item: ScheduleEmailPreviewItem): string {
  return createHash("sha256")
    .update(item.subject)
    .update("\0")
    .update(item.text)
    .update("\0")
    .update(item.html)
    .digest("hex")
    .slice(0, 16);
}

function idempotencyKey(assignmentDate: string, item: ScheduleEmailPreviewItem): string {
  return `classroom-schedule:${assignmentDate}:${item.recipient.canonicalKey}:${contentHash(item)}`.slice(0, 256);
}

function isQuotaExhaustionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("mailapp daily recipient quota is exhausted") ||
    (normalized.includes("quota") && normalized.includes("exhaust"));
}

async function loadSentRecipientGroupIds(db: Database, assignmentRunId: string): Promise<Set<string>> {
  const rows = await db
    .select({ groupId: schema.classroomScheduleEmailRecipients.groupId })
    .from(schema.classroomScheduleEmailRecipients)
    .where(and(
      eq(schema.classroomScheduleEmailRecipients.assignmentRunId, assignmentRunId),
      eq(schema.classroomScheduleEmailRecipients.status, "sent"),
    ));
  return new Set(rows.map((row) => row.groupId));
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

interface EmailRunCounts {
  attempted: number;
  success: number;
  failed: number;
  blocked: number;
}

type ScheduleEmailSendRecipientResult = ScheduleEmailSendResult["recipients"][number];

function isReadyEmailItem(item: ScheduleEmailPreviewItem): boolean {
  return item.recipient.status === "ready" && Boolean(item.recipient.email);
}

function emptyEmailRunCounts(): EmailRunCounts {
  return {
    attempted: 0,
    success: 0,
    failed: 0,
    blocked: 0,
  };
}

function emailRunStatus(counts: EmailRunCounts): string {
  if (counts.failed > 0) return counts.success > 0 || counts.blocked > 0 ? "partial" : "failed";
  if (counts.success > 0) return counts.blocked > 0 ? "partial" : "sent";
  return "blocked";
}

function sendSummaryFromRecipients(recipients: ScheduleEmailSendRecipientResult[]): ScheduleEmailSendResult["summary"] {
  return recipients.reduce<ScheduleEmailSendResult["summary"]>((summary, recipient) => {
    if (recipient.sendStatus === "sent") {
      summary.attempted += 1;
      summary.success += 1;
    } else if (recipient.sendStatus === "failed") {
      summary.attempted += 1;
      summary.failed += 1;
    } else {
      summary.blocked += 1;
    }
    return summary;
  }, {
    attempted: 0,
    success: 0,
    failed: 0,
    blocked: 0,
  });
}

function toSendRecipientResult(
  item: ScheduleEmailPreviewItem,
  input: {
    sendStatus: "sent" | "failed" | "blocked";
    resendEmailId?: string | null;
    error?: string | null;
    senderKey: ScheduleEmailSenderKey;
    emailRunId: string;
  },
): ScheduleEmailSendRecipientResult {
  return {
    ...item.recipient,
    sendStatus: input.sendStatus,
    resendEmailId: input.resendEmailId ?? null,
    error: input.error ?? null,
    senderKey: input.senderKey,
    emailRunId: input.emailRunId,
  };
}

function setFinalRecipientResult(
  recipients: ScheduleEmailSendRecipientResult[],
  result: ScheduleEmailSendRecipientResult,
): void {
  const existingIndex = recipients.findIndex((recipient) => recipient.groupId === result.groupId);
  if (existingIndex === -1) {
    recipients.push(result);
    return;
  }
  recipients[existingIndex] = result;
}

async function createScheduleEmailRun(
  db: Database,
  input: {
    assignmentRunId: string;
    status: string;
    subject: string;
    createdBy: string | null;
    blockedCount: number;
  },
): Promise<typeof schema.classroomScheduleEmailRuns.$inferSelect> {
  const [emailRun] = await db
    .insert(schema.classroomScheduleEmailRuns)
    .values({
      assignmentRunId: input.assignmentRunId,
      status: input.status,
      subject: input.subject,
      createdBy: input.createdBy,
      blockedCount: input.blockedCount,
    })
    .returning();
  return emailRun;
}

async function finalizeScheduleEmailRun(
  db: Database,
  emailRunId: string,
  counts: EmailRunCounts,
): Promise<void> {
  await db
    .update(schema.classroomScheduleEmailRuns)
    .set({
      status: emailRunStatus(counts),
      attemptedCount: counts.attempted,
      successCount: counts.success,
      failedCount: counts.failed,
      blockedCount: counts.blocked,
      updatedAt: new Date(),
    })
    .where(eq(schema.classroomScheduleEmailRuns.id, emailRunId));
}

async function recordRecipientOutcome(
  db: Database,
  input: {
    assignmentRunId: string;
    emailRunId: string;
    item: ScheduleEmailPreviewItem;
    senderKey: ScheduleEmailSenderKey;
    sendStatus: "sent" | "failed" | "blocked";
    resendEmailId?: string | null;
    error?: string | null;
    counts: EmailRunCounts;
    finalRecipients?: ScheduleEmailSendRecipientResult[];
  },
): Promise<void> {
  if (input.sendStatus === "sent") {
    input.counts.success += 1;
  } else if (input.sendStatus === "failed") {
    input.counts.failed += 1;
  } else {
    input.counts.blocked += 1;
  }

  await insertRecipientResult(db, {
    emailRunId: input.emailRunId,
    assignmentRunId: input.assignmentRunId,
    recipient: input.item.recipient,
    status: input.sendStatus,
    resendEmailId: input.resendEmailId,
    error: input.error,
  });

  if (input.finalRecipients) {
    setFinalRecipientResult(input.finalRecipients, toSendRecipientResult(input.item, {
      sendStatus: input.sendStatus,
      resendEmailId: input.resendEmailId,
      error: input.error,
      senderKey: input.senderKey,
      emailRunId: input.emailRunId,
    }));
  }
}

async function recordStoppedRecipients(
  db: Database,
  input: {
    assignmentRunId: string;
    emailRunId: string;
    items: ScheduleEmailPreviewItem[];
    senderKey: ScheduleEmailSenderKey;
    reason: string;
    counts: EmailRunCounts;
    finalRecipients: ScheduleEmailSendRecipientResult[];
  },
): Promise<void> {
  for (const item of input.items) {
    if (!isReadyEmailItem(item)) {
      const error = item.recipient.blockReason ?? "Recipient is blocked";
      await recordRecipientOutcome(db, {
        assignmentRunId: input.assignmentRunId,
        emailRunId: input.emailRunId,
        item,
        senderKey: input.senderKey,
        sendStatus: "blocked",
        error,
        counts: input.counts,
        finalRecipients: input.finalRecipients,
      });
      continue;
    }

    input.counts.attempted += 1;
    await recordRecipientOutcome(db, {
      assignmentRunId: input.assignmentRunId,
      emailRunId: input.emailRunId,
      item,
      senderKey: input.senderKey,
      sendStatus: "failed",
      error: `${input.reason}; send stopped before this recipient.`,
      counts: input.counts,
      finalRecipients: input.finalRecipients,
    });
  }
}

async function sendBackupFailoverEmails(input: {
  assignmentDate: string;
  db: Database;
  runId: string;
  createdBy: string | null;
  subject: string;
  reason: string;
  fromEmailRunId: string;
  items: ScheduleEmailPreviewItem[];
  finalRecipients: ScheduleEmailSendRecipientResult[];
  backupSender?: ScheduleEmailSender;
}): Promise<NonNullable<ScheduleEmailSendResult["failover"]>> {
  const backupRun = await createScheduleEmailRun(input.db, {
    assignmentRunId: input.runId,
    status: "pending",
    subject: input.subject,
    createdBy: input.createdBy,
    blockedCount: 0,
  });
  const counts = emptyEmailRunCounts();
  const sentGroupIds = await loadSentRecipientGroupIds(input.db, input.runId);
  const backupConfigErrors = emailConfigBlockers("backup").map((blocker) => blocker.message);
  const backupSender = input.backupSender ?? createAppsScriptScheduleEmailSender("backup");

  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index];
    if (!isReadyEmailItem(item)) {
      const error = item.recipient.blockReason ?? "Recipient is blocked";
      await recordRecipientOutcome(input.db, {
        assignmentRunId: input.runId,
        emailRunId: backupRun.id,
        item,
        senderKey: "backup",
        sendStatus: "blocked",
        error,
        counts,
        finalRecipients: input.finalRecipients,
      });
      continue;
    }

    if (sentGroupIds.has(item.recipient.groupId)) {
      await recordRecipientOutcome(input.db, {
        assignmentRunId: input.runId,
        emailRunId: backupRun.id,
        item,
        senderKey: "backup",
        sendStatus: "blocked",
        error: "Recipient already has a sent schedule email for this assignment run.",
        counts,
        finalRecipients: input.finalRecipients,
      });
      continue;
    }

    if (backupConfigErrors.length > 0) {
      await recordRecipientOutcome(input.db, {
        assignmentRunId: input.runId,
        emailRunId: backupRun.id,
        item,
        senderKey: "backup",
        sendStatus: "failed",
        error: `Backup sender unavailable: ${backupConfigErrors.join(" ")}`,
        counts,
        finalRecipients: input.finalRecipients,
      });
      continue;
    }

    counts.attempted += 1;
    try {
      const sent = await backupSender.sendEmail({
        to: item.recipient.email as string,
        subject: item.subject,
        html: item.html,
        text: item.text,
        idempotencyKey: idempotencyKey(input.assignmentDate, item),
      });
      sentGroupIds.add(item.recipient.groupId);
      await recordRecipientOutcome(input.db, {
        assignmentRunId: input.runId,
        emailRunId: backupRun.id,
        item,
        senderKey: "backup",
        sendStatus: "sent",
        resendEmailId: sent.id,
        counts,
        finalRecipients: input.finalRecipients,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Email send failed";
      await recordRecipientOutcome(input.db, {
        assignmentRunId: input.runId,
        emailRunId: backupRun.id,
        item,
        senderKey: "backup",
        sendStatus: "failed",
        error: message,
        counts,
        finalRecipients: input.finalRecipients,
      });

      if (isQuotaExhaustionError(message)) {
        await recordStoppedRecipients(input.db, {
          assignmentRunId: input.runId,
          emailRunId: backupRun.id,
          items: input.items.slice(index + 1),
          senderKey: "backup",
          reason: message,
          counts,
          finalRecipients: input.finalRecipients,
        });
        break;
      }
    }
  }

  await finalizeScheduleEmailRun(input.db, backupRun.id, counts);
  return {
    triggered: true,
    fromEmailRunId: input.fromEmailRunId,
    toEmailRunId: backupRun.id,
    reason: input.reason,
    attempted: counts.attempted,
    sent: counts.success,
    failed: counts.failed,
  };
}

export async function sendScheduleEmailsForRun(
  db: Database,
  runId: string,
  createdBy: string | null,
  sender?: ScheduleEmailSender,
  options: ScheduleEmailSendOptions = {},
): Promise<ScheduleEmailSendResult> {
  const senderKey = options.senderKey ?? "primary";
  const mode = options.mode ?? "selected";
  const resolvedSender = sender ?? createAppsScriptScheduleEmailSender(senderKey);
  const autoFailoverEnabled = senderKey === "primary" && (mode === "selected" || mode === "failed_only");
  const preview = await getScheduleEmailPreview(db, runId, { senderKey });
  const selectedGroupIds = options.recipientGroupIds === undefined
    ? null
    : new Set(options.recipientGroupIds);
  let previewItems = selectedGroupIds
    ? preview.previews.filter((item) => selectedGroupIds.has(item.recipient.groupId))
    : preview.previews;

  if (mode === "failed_only") {
    const sentKeys = await notifiedTutorKeys(db, preview.assignmentDate);
    previewItems = previewItems.filter(item => !sentKeys.has(item.recipient.canonicalKey.toLowerCase()));
    // A rerun after all deliveries succeeded is a no-op, not a new blocked email attempt.
    if (previewItems.length === 0 && preview.previews.length > 0) return { summary: sendSummaryFromRecipients([]), recipients: [], preview };
  }

  const selectedReadyCount = previewItems.filter((item) => item.recipient.status === "ready" && item.recipient.email).length;
  const selectedBlockedCount = previewItems.length - selectedReadyCount;
  const hasHardBlockers = preview.hardBlockers.length > 0;
  const sendable = !hasHardBlockers && selectedReadyCount > 0;

  const emailRun = await createScheduleEmailRun(db, {
    assignmentRunId: runId,
    status: sendable ? "pending" : "blocked",
    subject: preview.subject,
    createdBy,
    blockedCount: sendable ? selectedBlockedCount : previewItems.length,
  });

  const recipients: ScheduleEmailSendResult["recipients"] = [];
  if (!sendable) {
    const counts = emptyEmailRunCounts();
    for (const item of previewItems) {
      const hardBlockerText = preview.hardBlockers.map((blocker) => blocker.message).join(" ");
      const error = item.recipient.blockReason || hardBlockerText || "No selected ready schedule emails to send";
      await recordRecipientOutcome(db, {
        assignmentRunId: runId,
        emailRunId: emailRun.id,
        item,
        senderKey,
        sendStatus: "blocked",
        error,
        counts,
        finalRecipients: recipients,
      });
    }
    await finalizeScheduleEmailRun(db, emailRun.id, counts);
    return {
      summary: sendSummaryFromRecipients(recipients),
      recipients,
      preview,
    };
  }

  const counts = emptyEmailRunCounts();
  let failover: ScheduleEmailSendResult["failover"];
  for (let index = 0; index < previewItems.length; index += 1) {
    const item = previewItems[index];
    if (!isReadyEmailItem(item)) {
      const error = item.recipient.blockReason ?? "Recipient is blocked";
      await recordRecipientOutcome(db, {
        assignmentRunId: runId,
        emailRunId: emailRun.id,
        item,
        senderKey,
        sendStatus: "blocked",
        error,
        counts,
        finalRecipients: recipients,
      });
      continue;
    }

    counts.attempted += 1;
    try {
      const sent = await resolvedSender.sendEmail({
        to: item.recipient.email as string,
        subject: item.subject,
        html: item.html,
        text: item.text,
        idempotencyKey: idempotencyKey(preview.assignmentDate, item),
      });
      await recordRecipientOutcome(db, {
        assignmentRunId: runId,
        emailRunId: emailRun.id,
        item,
        senderKey,
        sendStatus: "sent",
        resendEmailId: sent.id,
        counts,
        finalRecipients: recipients,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Email send failed";
      await recordRecipientOutcome(db, {
        assignmentRunId: runId,
        emailRunId: emailRun.id,
        item,
        senderKey,
        sendStatus: "failed",
        error: message,
        counts,
        finalRecipients: autoFailoverEnabled && isQuotaExhaustionError(message) ? undefined : recipients,
      });

      if (isQuotaExhaustionError(message)) {
        if (autoFailoverEnabled) {
          const remainingBlockedItems = previewItems.slice(index + 1).filter((remaining) => !isReadyEmailItem(remaining));
          for (const remaining of remainingBlockedItems) {
            const remainingError = remaining.recipient.blockReason ?? "Recipient is blocked";
            await recordRecipientOutcome(db, {
              assignmentRunId: runId,
              emailRunId: emailRun.id,
              item: remaining,
              senderKey,
              sendStatus: "blocked",
              error: remainingError,
              counts,
              finalRecipients: recipients,
            });
          }
          await finalizeScheduleEmailRun(db, emailRun.id, counts);
          failover = await sendBackupFailoverEmails({
            assignmentDate: preview.assignmentDate,
            db,
            runId,
            createdBy,
            subject: preview.subject,
            reason: message,
            fromEmailRunId: emailRun.id,
            items: previewItems.slice(index).filter(isReadyEmailItem),
            finalRecipients: recipients,
            backupSender: options.backupSender,
          });
        } else {
          await recordStoppedRecipients(db, {
            assignmentRunId: runId,
            emailRunId: emailRun.id,
            items: previewItems.slice(index + 1),
            senderKey,
            reason: message,
            counts,
            finalRecipients: recipients,
          });
        }
        break;
      }
    }
  }

  if (!failover) {
    await finalizeScheduleEmailRun(db, emailRun.id, counts);
  }

  return {
    summary: sendSummaryFromRecipients(recipients),
    recipients,
    preview,
    ...(failover ? { failover } : {}),
  };
}
