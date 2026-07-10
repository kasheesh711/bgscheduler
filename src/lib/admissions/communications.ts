import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import {
  admissionsCaseMembers,
  admissionsCases,
  admissionsCounselors,
  admissionsNotificationLog,
  admissionsNotificationOutbox,
} from "@/lib/db/schema";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
} from "./audit";
import { roleAtLeast } from "./config";
import {
  deliverAdmissionsOutboxBestEffort,
  queueDirectMessageOutbox,
  type AdmissionsNotificationPrefs,
} from "./notifications";
import { isUuidShaped } from "./members";
import type { CaseAccess } from "./types";

export interface NotificationPreferencesDto {
  announcements: "default" | "digest" | "off";
  tasks: "default" | "digest" | "off";
  comments: "default" | "digest" | "off";
  deadlineReminders: "mandatory";
}

function toDto(value: AdmissionsNotificationPrefs | null): NotificationPreferencesDto {
  return {
    announcements: value?.announcements ?? "default",
    tasks: value?.tasks ?? "default",
    comments: value?.comments ?? "default",
    deadlineReminders: "mandatory",
  };
}

function toStored(input: Omit<NotificationPreferencesDto, "deadlineReminders">): AdmissionsNotificationPrefs | null {
  const result: AdmissionsNotificationPrefs = {};
  if (input.announcements !== "default") result.announcements = input.announcements;
  if (input.tasks !== "default") result.tasks = input.tasks;
  if (input.comments !== "default") result.comments = input.comments;
  return Object.keys(result).length ? result : null;
}

export async function getNotificationPreferences(
  caseId: string,
  email: string,
  db: Database = getDb(),
): Promise<NotificationPreferencesDto> {
  const rows = await db.select({ prefs: admissionsCaseMembers.notificationPrefs })
    .from(admissionsCaseMembers).where(and(
      eq(admissionsCaseMembers.caseId, caseId),
      eq(admissionsCaseMembers.email, email.trim().toLowerCase()),
      inArray(admissionsCaseMembers.status, ["active", "invited"]),
    )).limit(1);
  if (!rows[0]) throw new Error("NotFound");
  return toDto(rows[0].prefs);
}

export async function updateNotificationPreferences(input: {
  access: CaseAccess;
  announcements: "default" | "digest" | "off";
  tasks: "default" | "digest" | "off";
  comments: "default" | "digest" | "off";
}, db: Database = getDb()): Promise<NotificationPreferencesDto> {
  const stored = toStored(input);
  return withAuditedTransaction(async (tx) => {
    const rows = await tx.select().from(admissionsCaseMembers).where(and(
      eq(admissionsCaseMembers.caseId, input.access.caseId),
      eq(admissionsCaseMembers.email, input.access.email.trim().toLowerCase()),
      inArray(admissionsCaseMembers.status, ["active", "invited"]),
    )).limit(1);
    const row = rows[0];
    if (!row) throw new Error("NotFound");
    await tx.update(admissionsCaseMembers).set({
      notificationPrefs: stored,
      updatedAt: new Date(),
    }).where(eq(admissionsCaseMembers.id, row.id));
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "case_member",
      entityId: row.id,
      action: "update_notification_preferences",
      diff: computeFieldDiff(
        { notificationPrefs: row.notificationPrefs },
        { notificationPrefs: stored },
        ["notificationPrefs"],
      ),
    });
    return toDto(stored);
  }, db);
}

export async function sendCaseDirectMessage(input: {
  access: CaseAccess;
  recipientMemberId: string;
  senderName: string;
  subject: string;
  body: string;
  idempotencyKey: string;
}, db: Database = getDb()): Promise<{
  outboxId: string;
  deliveryStatus: "sent" | "queued" | "superseded";
  providerMessageId: string | null;
  idempotentReplay: boolean;
}> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.idempotencyKey)) throw new Error("Invalid idempotency key");
  const dedupeKey = `direct-message:${input.access.caseId}:${input.idempotencyKey.toLowerCase()}`;

  const queued = await withAuditedTransaction(async (tx) => {
    const rows = await tx.select({
      id: admissionsCaseMembers.id,
      email: admissionsCaseMembers.email,
      role: admissionsCaseMembers.role,
      familyPortalOpen: admissionsCases.familyPortalOpen,
      caseStatus: admissionsCases.status,
    }).from(admissionsCaseMembers)
      .innerJoin(admissionsCases, eq(admissionsCaseMembers.caseId, admissionsCases.id))
      .where(and(
        eq(admissionsCaseMembers.id, input.recipientMemberId),
        eq(admissionsCaseMembers.caseId, input.access.caseId),
        eq(admissionsCaseMembers.status, "active"),
        isNull(admissionsCases.deletedAt),
        or(
          ne(admissionsCaseMembers.role, "counselor"),
          sql<boolean>`EXISTS (
            SELECT 1 FROM ${admissionsCounselors}
            WHERE ${admissionsCounselors.email} = ${admissionsCaseMembers.email}
              AND ${admissionsCounselors.active} = true
          )`,
        ),
      )).limit(1);
    const recipient = rows[0];
    if (!recipient) throw new Error("NotFound");
    if (!["active", "committed"].includes(recipient.caseStatus)) throw new Error("Conflict");
    if (recipient.role !== "counselor" && !recipient.familyPortalOpen) throw new Error("Conflict");

    const row = await queueDirectMessageOutbox(tx, {
      caseId: input.access.caseId,
      memberId: recipient.id,
      recipientEmail: recipient.email,
      senderName: input.senderName,
      subject: input.subject,
      body: input.body,
      dedupeKey,
    });
    if (row.inserted) {
      await writeAuditLog(tx, {
        caseId: input.access.caseId,
        actorEmail: input.access.email,
        actorRole: input.access.role,
        entityType: "direct_message",
        entityId: row.id,
        action: "queue",
        diff: {
          recipientEmail: { old: null, new: recipient.email },
          subject: { old: null, new: input.subject.trim() },
        },
      });
    }
    return row;
  }, db);

  // Provider delivery starts only after the outbox row and audit entry commit.
  await deliverAdmissionsOutboxBestEffort([queued.id], db);

  const outboxRows = await db.select({
    status: admissionsNotificationOutbox.status,
    providerMessageId: admissionsNotificationOutbox.providerMessageId,
  }).from(admissionsNotificationOutbox)
    .where(eq(admissionsNotificationOutbox.id, queued.id))
    .limit(1);
  const outbox = outboxRows[0];
  if (!outbox) throw new Error("NotFound");

  const logRows = await db.select({
    providerMessageId: admissionsNotificationLog.resendEmailId,
  }).from(admissionsNotificationLog)
    .where(eq(admissionsNotificationLog.dedupeKey, dedupeKey))
    .limit(1);
  const log = logRows[0];
  const deliveryStatus = log
    ? "sent"
    : outbox.status === "sent"
      ? "superseded"
      : "queued";

  return {
    outboxId: queued.id,
    deliveryStatus,
    providerMessageId: log?.providerMessageId ?? outbox.providerMessageId ?? null,
    idempotentReplay: !queued.inserted,
  };
}
