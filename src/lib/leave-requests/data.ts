import { and, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { bangkokDateKey, bangkokDateStartUtc, addBangkokDays, minuteToTimeLabel } from "@/lib/room-capacity/dates";
import { updateGoogleSheetCell } from "@/lib/sales-dashboard/sheets";
import { MissingGoogleSheetsTokenError } from "@/lib/sales-dashboard/google-oauth";
import { LEAVE_REQUESTS_STATUS_COLUMN } from "./config";

export const LEAVE_WORKFLOW_STATUSES = [
  "new",
  "needs_review",
  "in_progress",
  "done",
  "ignored",
  "canceled_by_tutor",
] as const;

export type LeaveWorkflowStatus = typeof LEAVE_WORKFLOW_STATUSES[number];

export interface LeaveRequestListFilters {
  status?: string;
  q?: string;
  startDate?: string;
  endDate?: string;
  summaryOnly?: boolean;
}

export interface LeaveRequestStatusUpdateInput {
  workflowStatus?: LeaveWorkflowStatus;
  staffNote?: string | null;
  sheetStatusText?: string | null;
  retrySheetWrite?: boolean;
  actorEmail?: string | null;
  actorName?: string | null;
  connectedEmail?: string | null;
}

export interface WiseCancelPreviewInput {
  affectedSessionIds: string[];
  actorEmail?: string | null;
  actorName?: string | null;
}

export interface AffectedLineContact {
  linkId: string;
  contactId: string;
  lineUserId: string;
  displayName: string | null;
  linkedParentLabel: string | null;
  linkedStudentLabel: string | null;
  lineChatUrl: string | null;
}

export interface AffectedStudentContact {
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string | null;
  lineContacts: AffectedLineContact[];
}

export interface AffectedSessionContactRow {
  wiseSessionId: string;
  wiseStudentId: string;
  studentKey: string;
  sessionStudentName: string;
  studentName: string | null;
  parentName: string | null;
  lineLinkId: string | null;
  lineLinkStatus: string | null;
  lineEvidence: Record<string, unknown> | null;
  lineContactId: string | null;
  lineUserId: string | null;
  lineDisplayName: string | null;
  linkedParentLabel: string | null;
  linkedStudentLabel: string | null;
}

const LINE_CHAT_USER_PATTERN = /^U[a-fA-F0-9]{32}$/u;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function trustedLineChatUrlFromEvidence(
  evidence: Record<string, unknown> | null | undefined,
  expectedLineUserId?: string | null,
): string | null {
  const raw = stringOrNull(evidence?.originalUrl) ?? stringOrNull(evidence?.lineChatUrl);
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.hostname !== "chat.line.biz") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[1] !== "chat") return null;

  const [lineOaAccountId, , lineUserId] = parts;
  if (!LINE_CHAT_USER_PATTERN.test(lineOaAccountId) || !LINE_CHAT_USER_PATTERN.test(lineUserId)) return null;
  if (expectedLineUserId && lineUserId !== expectedLineUserId) return null;
  return url.toString();
}

export function buildAffectedSessionStudentRosters(
  rows: AffectedSessionContactRow[],
): Map<string, AffectedStudentContact[]> {
  const sessions = new Map<string, Map<string, AffectedStudentContact>>();

  for (const row of rows) {
    let students = sessions.get(row.wiseSessionId);
    if (!students) {
      students = new Map();
      sessions.set(row.wiseSessionId, students);
    }

    const studentId = row.studentKey || row.wiseStudentId;
    const existing = students.get(studentId);
    const student = existing ?? {
      wiseStudentId: row.wiseStudentId,
      studentKey: row.studentKey,
      studentName: row.studentName?.trim() || row.sessionStudentName,
      parentName: row.parentName?.trim() || null,
      lineContacts: [],
    };

    if (row.lineLinkStatus === "verified" && row.lineLinkId && row.lineContactId && row.lineUserId) {
      const alreadyAdded = student.lineContacts.some((contact) => contact.linkId === row.lineLinkId);
      if (!alreadyAdded) {
        student.lineContacts.push({
          linkId: row.lineLinkId,
          contactId: row.lineContactId,
          lineUserId: row.lineUserId,
          displayName: row.lineDisplayName,
          linkedParentLabel: row.linkedParentLabel,
          linkedStudentLabel: row.linkedStudentLabel,
          lineChatUrl: trustedLineChatUrlFromEvidence(row.lineEvidence, row.lineUserId),
        });
      }
    }

    students.set(studentId, student);
  }

  return new Map([...sessions.entries()].map(([sessionId, students]) => [
    sessionId,
    [...students.values()].sort((left, right) => left.studentName.localeCompare(right.studentName)),
  ]));
}

function statusLabel(status: LeaveWorkflowStatus): string {
  return {
    new: "New",
    needs_review: "Needs review",
    in_progress: "In progress",
    done: "Done",
    ignored: "Ignored",
    canceled_by_tutor: "Canceled by tutor",
  }[status];
}

export function initialWorkflowStatus(input: {
  normalizationStatus: string;
  matchConfidence: string;
  sourceSheetStatus: string | null;
}): LeaveWorkflowStatus {
  const source = input.sourceSheetStatus?.trim().toLowerCase() ?? "";
  if (source.includes("done") || source.includes("complete") || source.includes("approved")) return "done";
  if (source.includes("ignore")) return "ignored";
  if (source.includes("cancel")) return "canceled_by_tutor";
  if (input.normalizationStatus !== "ok" || input.matchConfidence === "unmatched") return "needs_review";
  return "new";
}

export async function insertLeaveRequestLog(
  db: Database,
  input: typeof schema.leaveRequestActivityLogs.$inferInsert,
): Promise<void> {
  await db.insert(schema.leaveRequestActivityLogs).values(input);
}

function buildListConditions(filters: LeaveRequestListFilters) {
  const conditions = [];
  if (filters.status && filters.status !== "all") {
    conditions.push(eq(schema.leaveRequests.workflowStatus, filters.status as LeaveWorkflowStatus));
  }
  if (filters.startDate) {
    conditions.push(gte(schema.leaveRequests.startDate, filters.startDate));
  }
  if (filters.endDate) {
    conditions.push(lte(schema.leaveRequests.startDate, filters.endDate));
  }
  if (filters.q?.trim()) {
    const query = `%${filters.q.trim()}%`;
    conditions.push(or(
      ilike(schema.leaveRequests.tutorName, query),
      ilike(schema.leaveRequests.tutorEmail, query),
      ilike(schema.leaveRequests.tutorDisplayName, query),
      ilike(schema.leaveRequests.reason, query),
      ilike(schema.leaveRequests.sourceSheetStatus, query),
    ));
  }
  return conditions;
}

function dateRangeFromRows(rows: Array<typeof schema.leaveRequests.$inferSelect>) {
  const dates = [...new Set(rows.map((row) => row.startDate).filter((date): date is string => Boolean(date)))].sort();
  return dates.slice(0, 28).map((date) => {
    const dayRows = rows.filter((row) => row.startDate === date);
    return {
      date,
      total: dayRows.length,
      needsAction: dayRows.filter((row) => row.workflowStatus === "new" || row.workflowStatus === "needs_review" || row.sheetWriteStatus === "failed").length,
      affectedClasses: dayRows.reduce((total, row) => total + row.affectedClassCount, 0),
    };
  });
}

export async function listLeaveRequests(db: Database, filters: LeaveRequestListFilters = {}) {
  const conditions = buildListConditions(filters);
  const rows = await db
    .select()
    .from(schema.leaveRequests)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.leaveRequests.sourceSubmittedAt), desc(schema.leaveRequests.createdAt))
    .limit(filters.summaryOnly ? 200 : 500);

  const cards = {
    total: rows.length,
    new: rows.filter((row) => row.workflowStatus === "new").length,
    needsReview: rows.filter((row) => row.workflowStatus === "needs_review").length,
    sheetWriteFailed: rows.filter((row) => row.sheetWriteStatus === "failed").length,
    affectedClasses: rows.reduce((total, row) => total + row.affectedClassCount, 0),
  };

  const unreadActionCount = rows.filter((row) =>
    row.workflowStatus === "new" ||
    row.workflowStatus === "needs_review" ||
    row.sheetWriteStatus === "failed"
  ).length;

  return {
    cards,
    unreadActionCount,
    timeline: dateRangeFromRows(rows),
    requests: filters.summaryOnly ? [] : rows.map((row) => ({
      id: row.id,
      sourceRowNumber: row.sourceRowNumber,
      sourceSubmittedAt: row.sourceSubmittedAt?.toISOString() ?? null,
      tutorName: row.tutorName,
      tutorEmail: row.tutorEmail,
      tutorDisplayName: row.tutorDisplayName,
      matchConfidence: row.matchConfidence,
      startDate: row.startDate,
      endDate: row.endDate,
      timePeriod: row.timePeriod,
      specificTimeText: row.specificTimeText,
      leaveStartTime: row.leaveStartTime?.toISOString() ?? null,
      leaveEndTime: row.leaveEndTime?.toISOString() ?? null,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
      normalizationStatus: row.normalizationStatus,
      normalizationError: row.normalizationError,
      reportedAffectedClasses: row.reportedAffectedClasses,
      sourceSheetStatus: row.sourceSheetStatus,
      workflowStatus: row.workflowStatus,
      staffNote: row.staffNote,
      sheetWriteStatus: row.sheetWriteStatus,
      sheetWriteError: row.sheetWriteError,
      affectedClassCount: row.affectedClassCount,
      cancellationPreviewCount: row.cancellationPreviewCount,
      unread: row.unread,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function getLeaveRequestDetail(db: Database, id: string) {
  const [request] = await db
    .select()
    .from(schema.leaveRequests)
    .where(eq(schema.leaveRequests.id, id))
    .limit(1);
  if (!request) return null;

  const [affectedSessions, activityLog] = await Promise.all([
    db
      .select()
      .from(schema.leaveRequestAffectedSessions)
      .where(eq(schema.leaveRequestAffectedSessions.leaveRequestId, id))
      .orderBy(schema.leaveRequestAffectedSessions.startTime),
    db
      .select()
      .from(schema.leaveRequestActivityLogs)
      .where(eq(schema.leaveRequestActivityLogs.leaveRequestId, id))
      .orderBy(desc(schema.leaveRequestActivityLogs.createdAt)),
  ]);

  const studentRosters = await loadAffectedSessionStudentRosters(db, affectedSessions);

  return {
    request: {
      ...request,
      sourceSubmittedAt: request.sourceSubmittedAt?.toISOString() ?? null,
      leaveStartTime: request.leaveStartTime?.toISOString() ?? null,
      leaveEndTime: request.leaveEndTime?.toISOString() ?? null,
      firstSeenAt: request.firstSeenAt.toISOString(),
      lastSeenAt: request.lastSeenAt.toISOString(),
      statusUpdatedAt: request.statusUpdatedAt?.toISOString() ?? null,
      sheetWrittenAt: request.sheetWrittenAt?.toISOString() ?? null,
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
    },
    affectedSessions: affectedSessions.map((session) => ({
      ...session,
      startTime: session.startTime.toISOString(),
      endTime: session.endTime.toISOString(),
      createdAt: session.createdAt.toISOString(),
      students: studentRosters.get(session.wiseSessionId) ?? [],
    })),
    activityLog: activityLog.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    })),
  };
}

async function loadAffectedSessionStudentRosters(
  db: Database,
  affectedSessions: Array<typeof schema.leaveRequestAffectedSessions.$inferSelect>,
): Promise<Map<string, AffectedStudentContact[]>> {
  const wiseSessionIds = [...new Set(affectedSessions.map((session) => session.wiseSessionId).filter(Boolean))];
  if (wiseSessionIds.length === 0) return new Map();

  const [creditSnapshot] = await db
    .select({ id: schema.creditControlSnapshots.id })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .limit(1);
  if (!creditSnapshot) return new Map();

  const rows = await db
    .select({
      wiseSessionId: schema.creditControlSessions.wiseSessionId,
      wiseStudentId: schema.creditControlSessions.wiseStudentId,
      studentKey: schema.creditControlSessions.studentKey,
      sessionStudentName: schema.creditControlSessions.studentName,
      studentName: schema.creditControlStudents.studentName,
      parentName: schema.creditControlStudents.parentName,
      lineLinkId: schema.lineContactStudentLinks.id,
      lineLinkStatus: schema.lineContactStudentLinks.status,
      lineEvidence: schema.lineContactStudentLinks.evidence,
      lineContactId: schema.lineContacts.id,
      lineUserId: schema.lineContacts.lineUserId,
      lineDisplayName: schema.lineContacts.displayName,
      linkedParentLabel: schema.lineContacts.linkedParentLabel,
      linkedStudentLabel: schema.lineContacts.linkedStudentLabel,
    })
    .from(schema.creditControlSessions)
    .leftJoin(schema.creditControlStudents, and(
      eq(schema.creditControlStudents.snapshotId, creditSnapshot.id),
      eq(schema.creditControlStudents.wiseStudentId, schema.creditControlSessions.wiseStudentId),
    ))
    .leftJoin(schema.lineContactStudentLinks, and(
      eq(schema.lineContactStudentLinks.studentKey, schema.creditControlSessions.studentKey),
      eq(schema.lineContactStudentLinks.status, "verified"),
    ))
    .leftJoin(schema.lineContacts, eq(schema.lineContacts.id, schema.lineContactStudentLinks.contactId))
    .where(and(
      eq(schema.creditControlSessions.snapshotId, creditSnapshot.id),
      eq(schema.creditControlSessions.sessionKind, "future"),
      inArray(schema.creditControlSessions.wiseSessionId, wiseSessionIds),
    ))
    .orderBy(schema.creditControlSessions.studentName, schema.lineContacts.displayName);

  return buildAffectedSessionStudentRosters(rows);
}

function overlapMinutes(
  requestStartMinute: number | null,
  requestEndMinute: number | null,
  sessionStartMinute: number,
  sessionEndMinute: number,
): number {
  const start = requestStartMinute ?? 0;
  const end = requestEndMinute ?? 1440;
  return Math.max(0, Math.min(end, sessionEndMinute) - Math.max(start, sessionStartMinute));
}

export async function recomputeAffectedSessionsForRequest(
  db: Database,
  request: Pick<typeof schema.leaveRequests.$inferSelect,
    "id" | "tutorGroupId" | "startDate" | "endDate" | "startMinute" | "endMinute" | "normalizationStatus"
  >,
): Promise<number> {
  await db
    .delete(schema.leaveRequestAffectedSessions)
    .where(eq(schema.leaveRequestAffectedSessions.leaveRequestId, request.id));

  if (!request.tutorGroupId || !request.startDate || !request.endDate) {
    await db
      .update(schema.leaveRequests)
      .set({ affectedClassCount: 0, updatedAt: new Date() })
      .where(eq(schema.leaveRequests.id, request.id));
    return 0;
  }

  const [activeSnapshot] = await db
    .select({ id: schema.snapshots.id })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);
  if (!activeSnapshot) return 0;

  const rangeStart = bangkokDateStartUtc(request.startDate);
  const rangeEnd = bangkokDateStartUtc(addBangkokDays(request.endDate, 1));
  const sessions = await db
    .select({
      snapshotId: schema.futureSessionBlocks.snapshotId,
      groupId: schema.futureSessionBlocks.groupId,
      wiseTeacherId: schema.futureSessionBlocks.wiseTeacherId,
      wiseTeacherUserId: schema.futureSessionBlocks.wiseTeacherUserId,
      wiseClassId: schema.futureSessionBlocks.wiseClassId,
      wiseSessionId: schema.futureSessionBlocks.wiseSessionId,
      startTime: schema.futureSessionBlocks.startTime,
      endTime: schema.futureSessionBlocks.endTime,
      weekday: schema.futureSessionBlocks.weekday,
      startMinute: schema.futureSessionBlocks.startMinute,
      endMinute: schema.futureSessionBlocks.endMinute,
      wiseStatus: schema.futureSessionBlocks.wiseStatus,
      sessionType: schema.futureSessionBlocks.sessionType,
      location: schema.futureSessionBlocks.location,
      studentName: schema.futureSessionBlocks.studentName,
      studentCount: schema.futureSessionBlocks.studentCount,
      subject: schema.futureSessionBlocks.subject,
      classType: schema.futureSessionBlocks.classType,
      title: schema.futureSessionBlocks.title,
    })
    .from(schema.futureSessionBlocks)
    .where(and(
      eq(schema.futureSessionBlocks.snapshotId, activeSnapshot.id),
      eq(schema.futureSessionBlocks.groupId, request.tutorGroupId),
      eq(schema.futureSessionBlocks.isBlocking, true),
      gte(schema.futureSessionBlocks.startTime, rangeStart),
      lt(schema.futureSessionBlocks.startTime, rangeEnd),
    ))
    .orderBy(schema.futureSessionBlocks.startTime);

  const rows = sessions.flatMap((session) => {
    const date = bangkokDateKey(session.startTime);
    if (date < request.startDate! || date > request.endDate!) return [];
    const overlap = overlapMinutes(request.startMinute, request.endMinute, session.startMinute, session.endMinute);
    if (overlap <= 0) return [];
    return [{
      leaveRequestId: request.id,
      snapshotId: session.snapshotId,
      groupId: session.groupId,
      wiseTeacherId: session.wiseTeacherId,
      wiseTeacherUserId: session.wiseTeacherUserId,
      wiseClassId: session.wiseClassId,
      wiseSessionId: session.wiseSessionId,
      startTime: session.startTime,
      endTime: session.endTime,
      weekday: session.weekday,
      startMinute: session.startMinute,
      endMinute: session.endMinute,
      wiseStatus: session.wiseStatus,
      sessionType: session.sessionType,
      location: session.location,
      studentName: session.studentName,
      studentCount: session.studentCount,
      subject: session.subject,
      classType: session.classType,
      title: session.title,
      overlapMinutes: overlap,
    }];
  });

  if (rows.length > 0) {
    await db.insert(schema.leaveRequestAffectedSessions).values(rows);
  }
  await db
    .update(schema.leaveRequests)
    .set({
      affectedClassCount: rows.length,
      cancellationPreviewCount: request.normalizationStatus === "ok" ? rows.filter((row) => row.wiseClassId && row.wiseSessionId).length : 0,
      updatedAt: new Date(),
    })
    .where(eq(schema.leaveRequests.id, request.id));
  return rows.length;
}

export async function updateLeaveRequestWorkflow(
  db: Database,
  id: string,
  input: LeaveRequestStatusUpdateInput,
) {
  const [current] = await db
    .select()
    .from(schema.leaveRequests)
    .where(eq(schema.leaveRequests.id, id))
    .limit(1);
  if (!current) return null;

  const workflowStatus = input.workflowStatus ?? current.workflowStatus;
  if (!LEAVE_WORKFLOW_STATUSES.includes(workflowStatus)) {
    throw new Error("Invalid leave request status.");
  }

  const now = new Date();
  const requestedSheetText = input.sheetStatusText?.trim()
    || (input.retrySheetWrite ? current.sourceSheetStatus ?? statusLabel(workflowStatus) : statusLabel(workflowStatus));
  const shouldWriteSheet = Boolean(input.sheetStatusText !== undefined || input.retrySheetWrite || input.workflowStatus);

  await db
    .update(schema.leaveRequests)
    .set({
      workflowStatus,
      staffNote: input.staffNote === undefined ? current.staffNote : input.staffNote,
      unread: false,
      sheetWriteStatus: shouldWriteSheet ? "pending" : current.sheetWriteStatus,
      sheetWriteError: shouldWriteSheet ? null : current.sheetWriteError,
      statusUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.leaveRequests.id, id));

  await insertLeaveRequestLog(db, {
    leaveRequestId: id,
    actionType: "status_update",
    status: "success",
    message: `Workflow status set to ${statusLabel(workflowStatus)}.`,
    requestPayload: {
      workflowStatus,
      staffNote: input.staffNote,
      sheetStatusText: requestedSheetText,
    },
    createdByEmail: input.actorEmail ?? undefined,
    createdByName: input.actorName ?? undefined,
  });

  let warning: string | null = null;
  if (shouldWriteSheet) {
    const writerEmail = input.connectedEmail ?? input.actorEmail ?? "";
    try {
      if (!writerEmail) throw new MissingGoogleSheetsTokenError("No Google Sheets write account is configured.");
      const response = await updateGoogleSheetCell(
        writerEmail,
        current.spreadsheetId,
        current.sheetName,
        `${LEAVE_REQUESTS_STATUS_COLUMN}${current.sourceRowNumber}`,
        requestedSheetText,
      );
      await db
        .update(schema.leaveRequests)
        .set({
          sourceSheetStatus: requestedSheetText,
          sheetWriteStatus: "success",
          sheetWriteError: null,
          sheetWrittenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.leaveRequests.id, id));
      await insertLeaveRequestLog(db, {
        leaveRequestId: id,
        actionType: "sheet_status_write",
        status: "success",
        message: `Wrote Status cell ${LEAVE_REQUESTS_STATUS_COLUMN}${current.sourceRowNumber}.`,
        requestPayload: { cell: `${LEAVE_REQUESTS_STATUS_COLUMN}${current.sourceRowNumber}`, value: requestedSheetText },
        responsePayload: response as Record<string, unknown>,
        createdByEmail: input.actorEmail ?? undefined,
        createdByName: input.actorName ?? undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Sheets status write failed";
      warning = message;
      await db
        .update(schema.leaveRequests)
        .set({
          sheetWriteStatus: "failed",
          sheetWriteError: message,
          updatedAt: new Date(),
        })
        .where(eq(schema.leaveRequests.id, id));
      await insertLeaveRequestLog(db, {
        leaveRequestId: id,
        actionType: "sheet_status_write",
        status: "failed",
        message: "Sheet Status write failed.",
        requestPayload: { cell: `${LEAVE_REQUESTS_STATUS_COLUMN}${current.sourceRowNumber}`, value: requestedSheetText },
        errorMessage: message,
        createdByEmail: input.actorEmail ?? undefined,
        createdByName: input.actorName ?? undefined,
      });
    }
  }

  return {
    warning,
    detail: await getLeaveRequestDetail(db, id),
  };
}

export async function createWiseCancelPreview(
  db: Database,
  requestId: string,
  input: WiseCancelPreviewInput,
) {
  const ids = [...new Set(input.affectedSessionIds.filter(Boolean))];
  if (ids.length === 0) throw new Error("Select at least one affected session.");

  const rows = await db
    .select()
    .from(schema.leaveRequestAffectedSessions)
    .where(and(
      eq(schema.leaveRequestAffectedSessions.leaveRequestId, requestId),
      inArray(schema.leaveRequestAffectedSessions.id, ids),
    ));
  if (rows.length === 0) throw new Error("Selected affected sessions were not found.");

  await db
    .update(schema.leaveRequestAffectedSessions)
    .set({ cancelPreviewSelected: false })
    .where(eq(schema.leaveRequestAffectedSessions.leaveRequestId, requestId));
  await db
    .update(schema.leaveRequestAffectedSessions)
    .set({ cancelPreviewSelected: true })
    .where(and(
      eq(schema.leaveRequestAffectedSessions.leaveRequestId, requestId),
      inArray(schema.leaveRequestAffectedSessions.id, ids),
    ));

  const endpoints = rows.map((row) => ({
    wiseClassId: row.wiseClassId,
    wiseSessionId: row.wiseSessionId,
    method: "DELETE",
    endpoint: row.wiseClassId && row.wiseSessionId
      ? `/teacher/classes/${row.wiseClassId}/sessions/${row.wiseSessionId}?cancelSession=true`
      : null,
    manualRequired: true,
  }));

  await db
    .update(schema.leaveRequests)
    .set({ cancellationPreviewCount: rows.length, updatedAt: new Date() })
    .where(eq(schema.leaveRequests.id, requestId));

  await insertLeaveRequestLog(db, {
    leaveRequestId: requestId,
    actionType: "wise_cancel_preview",
    status: "manual_required",
    message: `Previewed ${rows.length} Wise cancellation action(s). No Wise mutation was sent.`,
    requestPayload: {
      dryRun: true,
      selectedAffectedSessionIds: ids,
      endpoints,
      policy: "preview_only_manual_required",
    },
    createdByEmail: input.actorEmail ?? undefined,
    createdByName: input.actorName ?? undefined,
  });

  return getLeaveRequestDetail(db, requestId);
}

export function affectedSessionLabel(row: Pick<typeof schema.leaveRequestAffectedSessions.$inferSelect,
  "title" | "studentName" | "subject" | "startMinute" | "endMinute"
>) {
  const title = row.title || row.studentName || row.subject || "Class";
  return `${title} ${minuteToTimeLabel(row.startMinute)}-${minuteToTimeLabel(row.endMinute)}`;
}

export async function countLeaveRequestActionBadge(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.leaveRequests)
    .where(or(
      eq(schema.leaveRequests.workflowStatus, "new"),
      eq(schema.leaveRequests.workflowStatus, "needs_review"),
      eq(schema.leaveRequests.sheetWriteStatus, "failed"),
    ));
  return Number(row?.count ?? 0);
}
