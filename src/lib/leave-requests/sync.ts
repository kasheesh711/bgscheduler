import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
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
  LEAVE_NORMALIZATION_MODEL, LEAVE_NORMALIZATION_PROMPT_VERSION, LEAVE_SYNC_ABANDONED_MS,
} from "./config";
import { initialWorkflowStatus } from "./data";
import { buildTutorMatcher, type TutorMatch } from "./matching";
import { parseLeaveRequestSheetRows, type ParsedLeaveRequestRow } from "./parser";
import { normalizationInput, normalizationKey } from "./normalization";
import { processLeaveNormalizations } from "./processing";
import { syncLeaveRoster } from "./roster";
import { allocateDueLeaveWork, reconcileLeaveWork } from "./work-reconcile";
import { setWorkState } from "./work-data";
import { flushLeaveWritebacks } from "./writeback";
import { todayBangkok } from "@/lib/room-capacity/dates";

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
  suppressNotifications?: boolean;
  normalizationBudgetMs?: number;
}

export interface SyncLeaveRequestsResult {
  syncRunId: string;
  scannedRowCount: number;
  insertedCount: number;
  updatedCount: number;
  notificationCount: number;
  reconciliation?: { changed: number; matchedClasses: number; remaining: number };
  processing?: { processed: number; failed: number; remaining: number; serviceError?: string | null };
}

interface GoogleSheetsTokenCandidate {
  email: string;
  scope: string | null;
  accessTokenCiphertext?: string | null;
  refreshTokenCiphertext?: string | null;
  expiresAt?: Date | null;
  lastError?: string | null;
}

const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

function isRunningConflict(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("leave_request_sync_runs_single_running_idx");
}

export function isRevokedGoogleSheetsTokenError(error: string | null | undefined): boolean {
  return /expired|revoked|invalid_grant/i.test(error ?? "");
}

function normalizeEmail(email: string | null | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}

function hasUsableTokenMaterial(row: GoogleSheetsTokenCandidate, now: Date): boolean {
  if (!row.accessTokenCiphertext) return false;
  const expiresAt = row.expiresAt?.getTime() ?? 0;
  if (!expiresAt || expiresAt > now.getTime() + TOKEN_REFRESH_SKEW_MS) return true;
  return Boolean(row.refreshTokenCiphertext);
}

function isHealthySheetsToken(
  row: GoogleSheetsTokenCandidate,
  options: { requiresWrite: boolean; now: Date },
): boolean {
  if (isRevokedGoogleSheetsTokenError(row.lastError)) return false;
  if (!hasUsableTokenMaterial(row, options.now)) return false;
  return options.requiresWrite ? hasSheetsWriteScope(row.scope) : hasSheetsReadScope(row.scope);
}

function isHealthyWriteToken(row: GoogleSheetsTokenCandidate, now: Date): boolean {
  return isHealthySheetsToken(row, { requiresWrite: true, now });
}

export function selectLeaveRequestsConnectedEmail(
  input: {
    configuredEmail?: string | null;
    actorEmail?: string | null;
    requiresWrite?: boolean;
    tokenRows: GoogleSheetsTokenCandidate[];
    now?: Date;
  },
): string | null {
  const now = input.now ?? new Date();
  const requiresWrite = input.requiresWrite ?? false;
  const configured = normalizeEmail(input.configuredEmail);
  const actor = normalizeEmail(input.actorEmail);
  const rows = input.tokenRows.map((row) => ({
    ...row,
    email: normalizeEmail(row.email),
  }));
  const rowByEmail = new Map(rows.map((row) => [row.email, row]));

  if (configured) {
    const configuredRow = rowByEmail.get(configured);
    if (!configuredRow || isHealthySheetsToken(configuredRow, { requiresWrite, now })) return configured;
  }

  const actorRow = actor ? rowByEmail.get(actor) : null;
  if (actorRow && isHealthySheetsToken(actorRow, { requiresWrite, now })) return actor;

  const writeToken = rows.find((row) => isHealthyWriteToken(row, now));
  if (writeToken) return writeToken.email;
  if (requiresWrite) return null;

  const actorReadRow = actor ? rowByEmail.get(actor) : null;
  if (actorReadRow && isHealthySheetsToken(actorReadRow, { requiresWrite: false, now })) return actor;

  return rows.find((row) => isHealthySheetsToken(row, { requiresWrite: false, now }))?.email ?? null;
}

export async function resolveLeaveRequestsConnectedEmail(
  db: Database,
  actorEmail: string | null | undefined,
  requiresWrite = false,
): Promise<string> {
  const rows = await db
    .select({
      email: schema.googleOAuthTokens.email,
      scope: schema.googleOAuthTokens.scope,
      accessTokenCiphertext: schema.googleOAuthTokens.accessTokenCiphertext,
      refreshTokenCiphertext: schema.googleOAuthTokens.refreshTokenCiphertext,
      expiresAt: schema.googleOAuthTokens.expiresAt,
      lastError: schema.googleOAuthTokens.lastError,
    })
    .from(schema.googleOAuthTokens)
    .orderBy(desc(schema.googleOAuthTokens.updatedAt));
  const selected = selectLeaveRequestsConnectedEmail({
    configuredEmail: LEAVE_REQUESTS_CONNECTED_EMAIL,
    actorEmail,
    requiresWrite,
    tokenRows: rows,
  });
  if (selected) return selected;
  throw new Error("No healthy Google Sheets account is available for leave request sync. Reconnect Google Sheets for the leave request connected account.");
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

export async function importLeaveSourceRows(db: Database, parsedRows: ParsedLeaveRequestRow[], matcher: Awaited<ReturnType<typeof buildTutorMatcher>>, syncRunId: string) {
  const [existing, cachedRevisions] = await Promise.all([
    db.select().from(schema.leaveRequests).where(and(eq(schema.leaveRequests.spreadsheetId, LEAVE_REQUESTS_SPREADSHEET_ID), eq(schema.leaveRequests.sheetName, LEAVE_REQUESTS_SHEET_NAME))),
    db.select({ requestId: schema.leaveNormalizations.requestId, inputKey: schema.leaveNormalizations.inputKey, status: schema.leaveNormalizations.status, error: schema.leaveNormalizations.error }).from(schema.leaveNormalizations),
  ]);
  const byRow = new Map(existing.map((row) => [row.sourceRowNumber, row]));
  const cached = new Map(cachedRevisions.map((row) => [`${row.requestId}:${row.inputKey}`, row]));
  const changes: Array<typeof schema.leaveRequests.$inferInsert> = [];
  for (const parsed of parsedRows) {
    const old = byRow.get(parsed.sourceRowNumber);
    const match = matcher.match({ tutorName: parsed.tutorName, tutorEmail: parsed.tutorEmail });
    const inputKey = normalizationKey(normalizationInput(parsed));
    if (old?.sourceFingerprint === parsed.sourceFingerprint && old.currentNormalizationKey === inputKey && old.tutorCanonicalKey === match.tutorCanonicalKey) continue;
    const changed = old?.currentNormalizationKey !== inputKey;
    const previousInterpretation = old ? cached.get(`${old.id}:${inputKey}`) : undefined;
    changes.push({ ...valuesForParsedRow(parsed, match, syncRunId), spreadsheetId: LEAVE_REQUESTS_SPREADSHEET_ID, sheetName: LEAVE_REQUESTS_SHEET_NAME, currentNormalizationKey: inputKey,
      normalizationStatus: changed ? previousInterpretation?.status === "ok" ? "ok" : previousInterpretation?.status === "failed" ? "failed" : "pending" : old.normalizationStatus,
      normalizationError: changed ? previousInterpretation?.error ?? null : old.normalizationError,
      workflowStatus: old?.workflowStatus ?? initialWorkflowStatus({ ...parsed, matchConfidence: match.matchConfidence }),
      unread: old?.unread ?? true });
  }
  const saved: Array<typeof schema.leaveRequests.$inferSelect> = [];
  for (let offset = 0; offset < changes.length; offset += 50) {
    const values = changes.slice(offset, offset + 50);
    const fields = Object.keys(values[0]).filter((key) => !["workflowStatus", "unread", "spreadsheetId", "sheetName", "sourceRowNumber"].includes(key));
    const columns = schema.leaveRequests;
    const set = Object.fromEntries(fields.map((key) => [key, sql.raw(`excluded."${(columns[key as keyof typeof columns] as { name: string }).name}"`)]));
    const rows = await db.insert(schema.leaveRequests).values(values).onConflictDoUpdate({ target: [schema.leaveRequests.spreadsheetId, schema.leaveRequests.sheetName, schema.leaveRequests.sourceRowNumber], set }).returning();
    saved.push(...rows);
    await db.insert(schema.leaveRequestActivityLogs).values(rows.map((row) => ({ leaveRequestId: row.id, actionType: byRow.has(row.sourceRowNumber) ? "source_updated" : "source_inserted", message: `Imported source row ${row.sourceRowNumber}.`, requestPayload: { sourceRowNumber: row.sourceRowNumber, sourceFingerprint: row.sourceFingerprint } })));
  }
  // A prior kill between source upsert and revision insert is repaired on the next run.
  const all = new Map(existing.map((r) => [r.sourceRowNumber, r]));
  saved.forEach((r) => all.set(r.sourceRowNumber, r));
  const parsedByRow = new Map(parsedRows.map((r) => [r.sourceRowNumber, r]));
  const revisions = [...all.values()].filter((r) => parsedByRow.has(r.sourceRowNumber)).map((row) => ({ requestId: row.id, inputKey: row.currentNormalizationKey!, model: LEAVE_NORMALIZATION_MODEL, promptVersion: LEAVE_NORMALIZATION_PROMPT_VERSION, input: normalizationInput(parsedByRow.get(row.sourceRowNumber)!) }));
  for (let offset = 0; offset < revisions.length; offset += 100) await db.insert(schema.leaveNormalizations).values(revisions.slice(offset, offset + 100)).onConflictDoNothing();
  return { inserted: saved.filter((r) => !byRow.has(r.sourceRowNumber)), updated: saved.filter((r) => byRow.has(r.sourceRowNumber)), migrating: existing.some((r) => !r.currentNormalizationKey) || existing.length === 0 };
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
    return `- ${request.tutorName} (${date})`;
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
        ${requests.map((request) => `<li><strong>${escapeHtml(request.tutorName)}</strong> ${escapeHtml(request.startDate ?? "date unresolved")}</li>`).join("")}
      </ul>
      <p><a href="${dashboardUrl}">Open the daily Leave Requests queue</a></p>
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

export async function recoverAbandonedLeaveRuns(db: Database, now = new Date()) {
  return db.update(schema.leaveRequestSyncRuns).set({ status: "failed", finishedAt: now, errorSummary: "Recovered abandoned Leave Requests sync after 20 minutes." })
    .where(and(eq(schema.leaveRequestSyncRuns.status, "running"), lt(schema.leaveRequestSyncRuns.startedAt, new Date(now.getTime() - LEAVE_SYNC_ABANDONED_MS)))).returning({ id: schema.leaveRequestSyncRuns.id });
}

export async function syncLeaveRequests(db: Database, options: SyncLeaveRequestsOptions): Promise<SyncLeaveRequestsResult> {
  await recoverAbandonedLeaveRuns(db);
  let syncRunId = "";
  try {
    const [run] = await db.insert(schema.leaveRequestSyncRuns).values({ triggerType: options.triggerType, actorEmail: options.actorEmail ?? null, metadata: { spreadsheetId: LEAVE_REQUESTS_SPREADSHEET_ID, sheetName: LEAVE_REQUESTS_SHEET_NAME } }).returning({ id: schema.leaveRequestSyncRuns.id });
    syncRunId = run.id;
  } catch (error) {
    if (isRunningConflict(error) || (error instanceof Error && String(error.cause).includes("leave_request_sync_runs_single_running_idx"))) throw new LeaveRequestSyncAlreadyRunningError();
    throw error;
  }
  try {
    const today = todayBangkok();
    const connectedEmail = options.connectedEmail?.trim().toLowerCase() || await resolveLeaveRequestsConnectedEmail(db, options.actorEmail);
    let parsedRows: ParsedLeaveRequestRow[];
    try {
      parsedRows = parseLeaveRequestSheetRows(await fetchGoogleSheetRows(connectedEmail, LEAVE_REQUESTS_SPREADSHEET_ID, LEAVE_REQUESTS_SHEET_NAME));
      if (!parsedRows.length) throw new Error("Leave source returned no submissions; existing work has been retained.");
    } catch (error) {
      const [prior] = await db.select().from(schema.leaveWorkState).where(eq(schema.leaveWorkState.key, "source"));
      await setWorkState(db, "source", { ...prior?.value, error: error instanceof Error ? error.message : "Source read failed." });
      throw error;
    }
    const matcher = await buildTutorMatcher(db);
    const imported = await importLeaveSourceRows(db, parsedRows, matcher, syncRunId);
    await setWorkState(db, "source", { readAt: new Date().toISOString(), rowCount: parsedRows.length, error: null });
    await db.update(schema.leaveRequestSyncRuns).set({ scannedRowCount: parsedRows.length, insertedCount: imported.inserted.length, updatedCount: imported.updated.length }).where(eq(schema.leaveRequestSyncRuns.id, syncRunId));
    try {
      const roster = await syncLeaveRoster(db, connectedEmail, today);
      await setWorkState(db, "roster", { readAt: roster.fetchedAt, missingMonths: roster.missingMonths, error: roster.missingMonths.includes(today.slice(0, 7)) ? "This month's admin roster is missing. Due work remains unassigned." : null });
    } catch (error) {
      const [prior] = await db.select().from(schema.leaveWorkState).where(eq(schema.leaveWorkState.key, "roster"));
      await setWorkState(db, "roster", { ...prior?.value, error: error instanceof Error ? error.message : "Roster read failed." });
    }
    const processing = await processLeaveNormalizations(db, { budgetMs: options.normalizationBudgetMs, retryFailures: options.triggerType === "manual" });
    await setWorkState(db, "processing", { ...processing, error: processing.serviceError });
    let reconciliation: SyncLeaveRequestsResult["reconciliation"];
    try { reconciliation = await reconcileLeaveWork(db, today); }
    catch (error) {
      const [prior] = await db.select().from(schema.leaveWorkState).where(eq(schema.leaveWorkState.key, "classes"));
      await setWorkState(db, "classes", { ...prior?.value, error: error instanceof Error ? error.message : "Class reconciliation failed." });
      throw error;
    }
    await allocateDueLeaveWork(db, today);
    // Writeback failures retry independently; checkoffs and source imports remain durable.
    const writer = await resolveLeaveRequestsConnectedEmail(db, options.actorEmail, true).catch(() => null);
    if (writer) await flushLeaveWritebacks(db, writer);
    const notificationCount = imported.migrating || options.suppressNotifications ? 0 : await sendNewRequestNotifications(db, syncRunId, imported.inserted, options.sender ?? createAppsScriptScheduleEmailSender());
    const result = { syncRunId, scannedRowCount: parsedRows.length, insertedCount: imported.inserted.length, updatedCount: imported.updated.length, notificationCount, processing, reconciliation };
    await db.update(schema.leaveRequestSyncRuns).set({ status: "success", finishedAt: new Date(), notificationCount, metadata: { connectedEmail, processing, reconciliation, catchUpEmailsSuppressed: imported.migrating || !!options.suppressNotifications } }).where(eq(schema.leaveRequestSyncRuns.id, syncRunId));
    return result;
  } catch (error) {
    await db.update(schema.leaveRequestSyncRuns).set({ status: "failed", finishedAt: new Date(), errorSummary: error instanceof Error ? error.message : "Leave request sync failed." }).where(eq(schema.leaveRequestSyncRuns.id, syncRunId));
    throw error;
  }
}
