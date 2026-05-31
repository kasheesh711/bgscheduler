import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { fetchGoogleSheetRows } from "@/lib/sales-dashboard/sheets";
import { hasSheetsReadScope, hasSheetsWriteScope } from "@/lib/sales-dashboard/google-oauth";
import {
  createAppsScriptScheduleEmailSender,
  type ScheduleEmailSender,
} from "@/lib/classrooms/schedule-email";
import {
  APP_BASE_URL,
  LEAVE_REQUESTS_CONNECTED_EMAIL,
  LEAVE_REQUESTS_SHEET_NAME,
  LEAVE_REQUESTS_SPREADSHEET_ID,
  LEAVE_REQUESTS_SPREADSHEET_URL,
} from "./config";
import { initialWorkflowStatus, insertLeaveRequestLog, recomputeAffectedSessionsForRequest } from "./data";
import { buildTutorMatcher, type TutorMatch } from "./matching";
import { parseLeaveRequestSheetRows, type ParsedLeaveRequestRow } from "./parser";

export class LeaveRequestSyncAlreadyRunningError extends Error {
  constructor() {
    super("Leave request sync is already running.");
    this.name = "LeaveRequestSyncAlreadyRunningError";
  }
}

export interface SyncLeaveRequestsOptions {
  triggerType: "manual" | "cron";
  actorEmail?: string | null;
  actorName?: string | null;
  connectedEmail?: string | null;
  sender?: ScheduleEmailSender;
}

export interface SyncLeaveRequestsResult {
  syncRunId: string;
  scannedRowCount: number;
  insertedCount: number;
  updatedCount: number;
  notificationCount: number;
}

function isRunningConflict(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("leave_request_sync_runs_single_running_idx");
}

export async function resolveLeaveRequestsConnectedEmail(
  db: Database,
  actorEmail: string | null | undefined,
  requiresWrite = false,
): Promise<string> {
  const configured = LEAVE_REQUESTS_CONNECTED_EMAIL.trim().toLowerCase();
  if (configured) return configured;
  const actor = actorEmail?.trim().toLowerCase();
  if (actor && !requiresWrite) return actor;

  const rows = await db
    .select({ email: schema.googleOAuthTokens.email, scope: schema.googleOAuthTokens.scope })
    .from(schema.googleOAuthTokens)
    .orderBy(asc(schema.googleOAuthTokens.updatedAt));
  if (actor && rows.some((item) => item.email === actor && hasSheetsWriteScope(item.scope))) return actor;
  const row = rows.find((item) => requiresWrite ? hasSheetsWriteScope(item.scope) : hasSheetsReadScope(item.scope));
  if (!row) throw new Error("No connected Google Sheets account is available for leave request sync.");
  return row.email;
}

function valuesForParsedRow(
  parsed: ParsedLeaveRequestRow,
  match: TutorMatch,
  syncRunId: string,
): Omit<typeof schema.leaveRequests.$inferInsert, "spreadsheetId" | "sheetName"> {
  return {
    sourceRowNumber: parsed.sourceRowNumber,
    sourceFingerprint: parsed.sourceFingerprint,
    sourceSubmittedAt: parsed.sourceSubmittedAt,
    tutorName: parsed.tutorName || "(missing tutor)",
    tutorEmail: parsed.tutorEmail,
    startDate: parsed.startDate,
    endDate: parsed.endDate,
    timePeriod: parsed.timePeriod,
    specificTimeText: parsed.specificTimeText,
    leaveStartTime: parsed.leaveStartTime,
    leaveEndTime: parsed.leaveEndTime,
    startMinute: parsed.startMinute,
    endMinute: parsed.endMinute,
    normalizationStatus: parsed.normalizationStatus,
    normalizationError: parsed.normalizationError,
    reportedHasClasses: parsed.reportedHasClasses,
    reportedAffectedClasses: parsed.reportedAffectedClasses,
    makeupOptions: parsed.makeupOptions,
    reason: parsed.reason,
    certificateUrl: parsed.certificateUrl,
    situationText: parsed.situationText,
    policyAgreement: parsed.policyAgreement,
    daysNotice: parsed.daysNotice,
    lateNotice: parsed.lateNotice,
    adminFee: parsed.adminFee,
    emergencyUsed: parsed.emergencyUsed,
    sourceSheetStatus: parsed.sourceSheetStatus,
    tutorGroupId: match.tutorGroupId,
    tutorCanonicalKey: match.tutorCanonicalKey,
    tutorDisplayName: match.tutorDisplayName,
    matchConfidence: match.matchConfidence,
    matchReason: match.matchReason,
    rawValues: parsed.rawValues,
    lastSyncRunId: syncRunId,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  };
}

async function upsertLeaveRequestRow(
  db: Database,
  parsed: ParsedLeaveRequestRow,
  match: TutorMatch,
  syncRunId: string,
) {
  const [existing] = await db
    .select()
    .from(schema.leaveRequests)
    .where(and(
      eq(schema.leaveRequests.spreadsheetId, LEAVE_REQUESTS_SPREADSHEET_ID),
      eq(schema.leaveRequests.sheetName, LEAVE_REQUESTS_SHEET_NAME),
      eq(schema.leaveRequests.sourceRowNumber, parsed.sourceRowNumber),
    ))
    .limit(1);
  const values = valuesForParsedRow(parsed, match, syncRunId);

  if (!existing || existing.spreadsheetId !== LEAVE_REQUESTS_SPREADSHEET_ID || existing.sheetName !== LEAVE_REQUESTS_SHEET_NAME) {
    const workflowStatus = initialWorkflowStatus({
      normalizationStatus: parsed.normalizationStatus,
      matchConfidence: match.matchConfidence,
      sourceSheetStatus: parsed.sourceSheetStatus,
    });
    const [inserted] = await db
      .insert(schema.leaveRequests)
      .values({
        spreadsheetId: LEAVE_REQUESTS_SPREADSHEET_ID,
        sheetName: LEAVE_REQUESTS_SHEET_NAME,
        ...values,
        workflowStatus,
        unread: true,
      })
      .returning();
    await insertLeaveRequestLog(db, {
      leaveRequestId: inserted.id,
      actionType: "source_inserted",
      status: "success",
      message: `Synced new Form Responses 1 row ${parsed.sourceRowNumber}.`,
      requestPayload: { sourceRowNumber: parsed.sourceRowNumber },
    });
    return { row: inserted, inserted: true, updated: false };
  }

  const fingerprintChanged = existing.sourceFingerprint !== parsed.sourceFingerprint;
  const matchChanged = existing.tutorGroupId !== match.tutorGroupId || existing.matchConfidence !== match.matchConfidence;
  const statusChanged = existing.sourceSheetStatus !== parsed.sourceSheetStatus;
  const workflowStatus =
    (existing.workflowStatus === "new" || existing.workflowStatus === "needs_review") &&
    (parsed.normalizationStatus !== "ok" || match.matchConfidence === "unmatched")
      ? "needs_review"
      : existing.workflowStatus;

  const [updated] = await db
    .update(schema.leaveRequests)
    .set({
      ...values,
      workflowStatus,
      unread: existing.unread || fingerprintChanged,
    })
    .where(eq(schema.leaveRequests.id, existing.id))
    .returning();

  if (fingerprintChanged || matchChanged || statusChanged) {
    await insertLeaveRequestLog(db, {
      leaveRequestId: updated.id,
      actionType: fingerprintChanged ? "source_updated" : "source_refreshed",
      status: "success",
      message: `Refreshed Form Responses 1 row ${parsed.sourceRowNumber}.`,
      requestPayload: { sourceRowNumber: parsed.sourceRowNumber, fingerprintChanged, matchChanged, statusChanged },
    });
  }
  return { row: updated, inserted: false, updated: fingerprintChanged || matchChanged || statusChanged };
}

async function loadAdminEmails(db: Database): Promise<string[]> {
  const rows = await db
    .select({ email: schema.adminUsers.email })
    .from(schema.adminUsers)
    .orderBy(asc(schema.adminUsers.email));
  return [...new Set(rows.map((row) => row.email.trim().toLowerCase()).filter(Boolean))];
}

function notificationText(requests: Array<typeof schema.leaveRequests.$inferSelect>): { subject: string; text: string; html: string } {
  const subject = `[BeGifted] ${requests.length} new tutor leave request${requests.length === 1 ? "" : "s"}`;
  const lines = requests.map((request) => {
    const date = request.startDate && request.endDate && request.startDate !== request.endDate
      ? `${request.startDate} to ${request.endDate}`
      : request.startDate ?? "date needs review";
    return `- ${request.tutorName} (${date}) - ${request.affectedClassCount} Wise class(es) affected`;
  });
  const dashboardUrl = `${APP_BASE_URL.replace(/\/$/, "")}/leave-requests`;
  const text = [
    subject,
    "",
    ...lines,
    "",
    `Open dashboard: ${dashboardUrl}`,
    `Source sheet: ${LEAVE_REQUESTS_SPREADSHEET_URL}`,
  ].join("\n");
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;color:#0f172a">
      <h2 style="margin:0 0 12px">New tutor leave requests</h2>
      <ul>
        ${requests.map((request) => `<li><strong>${escapeHtml(request.tutorName)}</strong> ${escapeHtml(request.startDate ?? "date needs review")} - ${request.affectedClassCount} Wise class(es) affected</li>`).join("")}
      </ul>
      <p><a href="${dashboardUrl}">Open Leave Requests dashboard</a></p>
      <p style="color:#64748b;font-size:12px">Source: Form Responses 1 only. Leave Analytics and Emergency Tracker are ignored.</p>
    </div>
  `;
  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendNewRequestNotifications(
  db: Database,
  syncRunId: string,
  requests: Array<typeof schema.leaveRequests.$inferSelect>,
  sender: ScheduleEmailSender,
): Promise<number> {
  if (requests.length === 0) return 0;
  const recipients = await loadAdminEmails(db);
  if (recipients.length === 0) return 0;
  const content = notificationText(requests);
  let successRows = 0;

  for (const recipient of recipients) {
    const idempotencyKey = `leave-requests:${syncRunId}:${recipient}`;
    let providerMessageId: string | null = null;
    let error: string | null = null;
    try {
      const sent = await sender.sendEmail({
        to: recipient,
        subject: content.subject,
        text: content.text,
        html: content.html,
        idempotencyKey,
      });
      providerMessageId = sent.id;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Leave request notification failed";
    }

    for (const request of requests) {
      await db
        .insert(schema.leaveRequestNotifications)
        .values({
          syncRunId,
          leaveRequestId: request.id,
          recipientEmail: recipient,
          status: error ? "failed" : "success",
          providerMessageId,
          error,
          idempotencyKey: `leave-request:new:${request.id}:${recipient}`,
          sentAt: error ? null : new Date(),
        })
        .onConflictDoNothing({ target: schema.leaveRequestNotifications.idempotencyKey });
      if (!error) successRows += 1;
    }
  }

  return successRows;
}

export async function syncLeaveRequests(
  db: Database,
  options: SyncLeaveRequestsOptions,
): Promise<SyncLeaveRequestsResult> {
  let syncRunId = "";
  try {
    const [run] = await db
      .insert(schema.leaveRequestSyncRuns)
      .values({
        triggerType: options.triggerType,
        actorEmail: options.actorEmail ?? null,
        metadata: {
          spreadsheetId: LEAVE_REQUESTS_SPREADSHEET_ID,
          sheetName: LEAVE_REQUESTS_SHEET_NAME,
        },
      })
      .returning({ id: schema.leaveRequestSyncRuns.id });
    syncRunId = run.id;
  } catch (error) {
    if (isRunningConflict(error)) throw new LeaveRequestSyncAlreadyRunningError();
    throw error;
  }

  try {
    const connectedEmail = options.connectedEmail?.trim().toLowerCase()
      || await resolveLeaveRequestsConnectedEmail(db, options.actorEmail);
    const rows = await fetchGoogleSheetRows(connectedEmail, LEAVE_REQUESTS_SPREADSHEET_ID, LEAVE_REQUESTS_SHEET_NAME);
    const parsedRows = parseLeaveRequestSheetRows(rows);
    const matcher = await buildTutorMatcher(db);
    const newRequests: Array<typeof schema.leaveRequests.$inferSelect> = [];
    let insertedCount = 0;
    let updatedCount = 0;

    for (const parsed of parsedRows) {
      const match = matcher.match({ tutorName: parsed.tutorName, tutorEmail: parsed.tutorEmail });
      const result = await upsertLeaveRequestRow(db, parsed, match, syncRunId);
      const affectedCount = await recomputeAffectedSessionsForRequest(db, result.row);
      result.row.affectedClassCount = affectedCount;
      if (result.inserted) {
        insertedCount += 1;
        newRequests.push(result.row);
      }
      if (result.updated) updatedCount += 1;
    }

    const notificationCount = await sendNewRequestNotifications(
      db,
      syncRunId,
      newRequests,
      options.sender ?? createAppsScriptScheduleEmailSender(),
    );

    await db
      .update(schema.leaveRequestSyncRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        scannedRowCount: parsedRows.length,
        insertedCount,
        updatedCount,
        notificationCount,
        metadata: {
          spreadsheetId: LEAVE_REQUESTS_SPREADSHEET_ID,
          sheetName: LEAVE_REQUESTS_SHEET_NAME,
          connectedEmail,
          activeSnapshotId: matcher.snapshotId,
        },
      })
      .where(eq(schema.leaveRequestSyncRuns.id, syncRunId));

    return {
      syncRunId,
      scannedRowCount: parsedRows.length,
      insertedCount,
      updatedCount,
      notificationCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Leave request sync failed";
    await db
      .update(schema.leaveRequestSyncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorSummary: message,
      })
      .where(eq(schema.leaveRequestSyncRuns.id, syncRunId));
    throw error;
  }
}
