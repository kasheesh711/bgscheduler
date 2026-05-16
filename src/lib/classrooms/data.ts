import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { WiseClient } from "@/lib/wise/client";
import {
  checkTeacherAvailabilityForSessions,
  fetchAllFutureSessions,
  fetchInstituteLocations,
  updateSessionLocation,
  type WiseSessionAvailabilityInput,
} from "@/lib/wise/fetchers";
import {
  getWiseSessionClassId,
  getWiseSessionTeacherUserId,
  type WiseSession,
} from "@/lib/wise/types";
import {
  assignClassrooms,
  type AssignmentResultRow,
  type AssignmentSession,
  isOfflineSession,
  REMOTE_NO_ROOM_NEEDED,
} from "./assignment-engine";
import {
  DEFAULT_CLASSROOM_ROOMS,
  LEGACY_PLAIN_TV_ROOM_NAMES,
  NO_ROOM_AVAILABLE,
  exactWiseRoomName,
  isLegacyPlainTvRoomName,
  tvRoomRepairLocation,
  type ClassroomRoomDefinition,
} from "./rooms";
import {
  invalidPlainTvSessionCount,
  isWiseSessionBlockingForPlainTvCleanup,
} from "./plain-tv-cleanup";

export type ClassroomRun = typeof schema.classroomAssignmentRuns.$inferSelect;
export type ClassroomRow = typeof schema.classroomAssignmentRows.$inferSelect;
export type ClassroomRoom = typeof schema.classroomRooms.$inferSelect;
export type ClassroomPublishJob = typeof schema.classroomPublishJobs.$inferSelect;

export interface ClassroomAssignmentDetail {
  run: ClassroomRun | null;
  rows: ClassroomRow[];
  rooms: ClassroomRoom[];
  wiseWritebackEnabled: boolean;
  wiseWritebackEnabledForUser: boolean;
  wiseWritebackBlockedReason: string | null;
}

export interface TeacherScheduleBlock {
  rowId: string;
  date: string;
  startTime: string;
  endTime: string;
  room: string;
  studentName: string | null;
  subject: string | null;
  classType: string | null;
  sessionType: string | null;
}

export interface TeacherSchedule {
  tutors: Array<{
    tutorDisplayName: string;
    blocks: TeacherScheduleBlock[];
  }>;
}

export interface PublishSummary {
  attempted: number;
  success: number;
  skipped: number;
  failed: number;
}

export interface PublishJobProgress {
  jobId: string;
  runId: string;
  status: ClassroomPublishJob["status"];
  totalCount: number;
  eligibleCount: number;
  completedCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  preflightWarningCount: number;
  remainingCount: number;
  elapsedMs: number | null;
  estimatedRemainingMs: number | null;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublishJobStatusResponse {
  progress: PublishJobProgress;
  detail?: ClassroomAssignmentDetail;
}

export interface PlainTvLocationRepairAuditRow {
  publishJobId: string | null;
  publishJobStatus: ClassroomPublishJob["status"] | null;
  publishedBy: string | null;
  runId: string;
  assignmentDate: string;
  rowId: string;
  wiseClassId: string | null;
  wiseSessionId: string;
  tutorDisplayName: string;
  studentName: string | null;
  startTimeBangkok: string;
  wrongLocation: string;
  intendedLocation: string;
  publishedAt: string | null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PUBLISH_ROW_CONCURRENCY = 1;
const PUBLISH_JOB_STALE_AFTER_MS = 6 * 60 * 1000;
const WISE_CLASSROOM_WRITEBACK_DISABLED_MESSAGE =
  "Wise classroom writeback is disabled. Set ENABLE_WISE_CLASSROOM_WRITEBACK=true only after explicit approval.";
const WISE_CLASSROOM_WRITEBACK_ALLOWED_EMAILS_MESSAGE =
  "Wise classroom writeback is restricted to explicitly approved admin emails.";
const PLAIN_TV_REPAIR_AUDIT_START = new Date("2026-05-15T00:00:00+07:00");
const KNOWN_NON_LOCATION_PREFLIGHT_REASONS = new Set(["TEACHER_SESSION", "TEACHER_WORKING_HOURS"]);

export function assertIsoDate(value: string): string {
  if (!ISO_DATE_RE.test(value)) {
    throw new Error("Invalid date. Expected YYYY-MM-DD.");
  }
  const parsed = new Date(`${value}T00:00:00+07:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid date. Expected YYYY-MM-DD.");
  }
  return value;
}

export function isWiseClassroomWritebackEnabled(): boolean {
  return process.env.ENABLE_WISE_CLASSROOM_WRITEBACK === "true";
}

export function wiseClassroomWritebackAllowedEmails(): Set<string> {
  return new Set(
    String(process.env.WISE_CLASSROOM_WRITEBACK_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function wiseClassroomWritebackPolicy(email: string | null | undefined): {
  wiseWritebackEnabled: boolean;
  wiseWritebackEnabledForUser: boolean;
  wiseWritebackBlockedReason: string | null;
} {
  if (!isWiseClassroomWritebackEnabled()) {
    return {
      wiseWritebackEnabled: false,
      wiseWritebackEnabledForUser: false,
      wiseWritebackBlockedReason: WISE_CLASSROOM_WRITEBACK_DISABLED_MESSAGE,
    };
  }

  const allowedEmails = wiseClassroomWritebackAllowedEmails();
  if (allowedEmails.size === 0) {
    return {
      wiseWritebackEnabled: true,
      wiseWritebackEnabledForUser: false,
      wiseWritebackBlockedReason: "WISE_CLASSROOM_WRITEBACK_ALLOWED_EMAILS is not configured.",
    };
  }

  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!normalizedEmail || !allowedEmails.has(normalizedEmail)) {
    return {
      wiseWritebackEnabled: true,
      wiseWritebackEnabledForUser: false,
      wiseWritebackBlockedReason: WISE_CLASSROOM_WRITEBACK_ALLOWED_EMAILS_MESSAGE,
    };
  }

  return {
    wiseWritebackEnabled: true,
    wiseWritebackEnabledForUser: true,
    wiseWritebackBlockedReason: null,
  };
}

export function wiseClassroomWritebackDisabledMessage(): string {
  return WISE_CLASSROOM_WRITEBACK_DISABLED_MESSAGE;
}

export function assertWiseClassroomWritebackAllowed(email: string | null | undefined): void {
  const policy = wiseClassroomWritebackPolicy(email);
  if (!policy.wiseWritebackEnabledForUser) {
    throw new Error(policy.wiseWritebackBlockedReason ?? WISE_CLASSROOM_WRITEBACK_DISABLED_MESSAGE);
  }
}

function assignmentDetail(
  run: ClassroomRun | null,
  rows: ClassroomRow[],
  rooms: ClassroomRoom[],
  viewerEmail?: string | null,
): ClassroomAssignmentDetail {
  const policy = wiseClassroomWritebackPolicy(viewerEmail);
  return {
    run,
    rows,
    rooms,
    wiseWritebackEnabled: policy.wiseWritebackEnabledForUser,
    wiseWritebackEnabledForUser: policy.wiseWritebackEnabledForUser,
    wiseWritebackBlockedReason: policy.wiseWritebackBlockedReason,
  };
}

function dateRangeForBangkokDate(value: string): { start: Date; end: Date } {
  assertIsoDate(value);
  const [year, month, day] = value.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1);
  return { start, end };
}

function formatMinute(minute: number): string {
  const normalized = Math.max(0, minute);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function classroomRoomLabel(row: Pick<ClassroomRow, "status" | "assignedRoom">): string {
  if (row.status === "remote" || row.assignedRoom === REMOTE_NO_ROOM_NEEDED) {
    return "Remote / no room needed";
  }
  return row.assignedRoom;
}

function normalizedLocation(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizedPhysicalLocation(value: string | null): string {
  return normalizedLocation(exactWiseRoomName(value).replace(/\s+\(TV\)$/i, ""));
}

function wiseIso(value: string | Date): string {
  return new Date(value).toISOString();
}

export function classroomTimestampToWiseIso(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const utcMillis = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours() - 7,
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
  return new Date(utcMillis).toISOString();
}

type PublishDependencyRow = Pick<
  ClassroomRow,
  "id" | "tutorDisplayName" | "currentWiseLocation" | "assignedRoom" | "startMinute" | "endMinute"
>;

function rowsOverlap(left: Pick<ClassroomRow, "startMinute" | "endMinute">, right: Pick<ClassroomRow, "startMinute" | "endMinute">): boolean {
  return left.startMinute < right.endMinute && right.startMinute < left.endMinute;
}

export function findPublishRoomBlockers(
  row: PublishDependencyRow,
  candidates: PublishDependencyRow[],
): PublishDependencyRow[] {
  const target = normalizedPhysicalLocation(row.assignedRoom);
  if (!target) return [];
  return candidates.filter((candidate) => (
    candidate.id !== row.id &&
    normalizedPhysicalLocation(candidate.currentWiseLocation) === target &&
    rowsOverlap(row, candidate)
  ));
}

export async function ensureDefaultClassroomRooms(db: Database): Promise<void> {
  const existingRows = await db.select().from(schema.classroomRooms);
  const existingNames = new Set(existingRows.map((row) => row.name));
  const now = new Date();

  const missingRows: Array<typeof schema.classroomRooms.$inferInsert> = DEFAULT_CLASSROOM_ROOMS
    .filter((room) => !existingNames.has(room.name))
    .map((room) => ({
      name: room.name,
      hasTv: room.hasTv,
      capacity: room.capacity,
      category: room.category,
      active: room.active,
      sortOrder: room.sortOrder,
      createdAt: now,
      updatedAt: now,
    }));

  if (missingRows.length) {
    await db.insert(schema.classroomRooms).values(missingRows).onConflictDoNothing({
      target: schema.classroomRooms.name,
    });
  }

  const legacyPlainTvNames = existingRows
    .filter((row) => row.active && isLegacyPlainTvRoomName(row.name))
    .map((row) => row.name);
  if (legacyPlainTvNames.length) {
    await db
      .update(schema.classroomRooms)
      .set({ active: false, updatedAt: now })
      .where(inArray(schema.classroomRooms.name, legacyPlainTvNames));
  }
}

export async function listClassroomRooms(db: Database): Promise<ClassroomRoom[]> {
  await ensureDefaultClassroomRooms(db);
  return db
    .select()
    .from(schema.classroomRooms)
    .orderBy(schema.classroomRooms.sortOrder, schema.classroomRooms.name);
}

function toEngineRoom(room: ClassroomRoom): ClassroomRoomDefinition {
  return {
    name: room.name,
    hasTv: room.hasTv,
    capacity: room.capacity,
    category: room.category,
    active: room.active,
    sortOrder: room.sortOrder,
  };
}

async function getActiveSnapshot(db: Database): Promise<{ id: string }> {
  const [activeSnapshot] = await db
    .select({ id: schema.snapshots.id })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);
  if (!activeSnapshot) throw new Error("No active Wise snapshot found");
  return activeSnapshot;
}

async function loadLatestRunForDate(db: Database, date: string): Promise<ClassroomRun | null> {
  const [run] = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.assignmentDate, date))
    .orderBy(desc(schema.classroomAssignmentRuns.createdAt))
    .limit(1);
  return run ?? null;
}

async function loadRowsForRun(db: Database, runId: string): Promise<ClassroomRow[]> {
  return db
    .select()
    .from(schema.classroomAssignmentRows)
    .where(eq(schema.classroomAssignmentRows.runId, runId))
    .orderBy(
      schema.classroomAssignmentRows.startTime,
      schema.classroomAssignmentRows.tutorDisplayName,
    );
}

export function isPublishJobTerminal(status: ClassroomPublishJob["status"]): boolean {
  return status === "succeeded" || status === "partial" || status === "failed";
}

export function estimatePublishRemainingMs(
  input: {
    startedAt: Date | null;
    finishedAt: Date | null;
    eligibleCount: number;
    successCount: number;
    failedCount: number;
  },
  now = new Date(),
): number | null {
  if (!input.startedAt || input.finishedAt) return null;
  const attemptedDone = input.successCount + input.failedCount;
  const remainingAttempts = input.eligibleCount - attemptedDone;
  if (attemptedDone <= 0 || remainingAttempts <= 0) return null;
  const elapsedMs = Math.max(0, now.getTime() - input.startedAt.getTime());
  return Math.round((elapsedMs / attemptedDone) * remainingAttempts);
}

export function toPublishJobProgress(
  job: ClassroomPublishJob,
  now = new Date(),
): PublishJobProgress {
  const terminal = isPublishJobTerminal(job.status);
  const end = job.finishedAt ?? (terminal ? now : null);
  const elapsedMs = job.startedAt
    ? Math.max(0, (end ?? now).getTime() - job.startedAt.getTime())
    : null;
  return {
    jobId: job.id,
    runId: job.runId,
    status: job.status,
    totalCount: job.totalCount,
    eligibleCount: job.eligibleCount,
    completedCount: job.completedCount,
    successCount: job.successCount,
    failedCount: job.failedCount,
    skippedCount: job.skippedCount,
    preflightWarningCount: job.preflightWarningCount,
    remainingCount: Math.max(0, job.totalCount - job.completedCount),
    elapsedMs,
    estimatedRemainingMs: estimatePublishRemainingMs(job, now),
    lastError: job.lastError,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

async function loadPublishJob(
  db: Database,
  jobId: string,
  runId?: string,
): Promise<ClassroomPublishJob> {
  const where = runId
    ? and(eq(schema.classroomPublishJobs.id, jobId), eq(schema.classroomPublishJobs.runId, runId))
    : eq(schema.classroomPublishJobs.id, jobId);
  const [job] = await db
    .select()
    .from(schema.classroomPublishJobs)
    .where(where)
    .limit(1);
  if (!job) throw new Error("Publish job not found");
  return job;
}

async function runLimited<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }));
}

export async function getClassroomAssignmentForDate(
  db: Database,
  date: string,
  viewerEmail?: string | null,
): Promise<ClassroomAssignmentDetail> {
  assertIsoDate(date);
  const rooms = await listClassroomRooms(db);
  const run = await loadLatestRunForDate(db, date);
  if (!run) return assignmentDetail(null, [], rooms, viewerEmail);
  const rows = await loadRowsForRun(db, run.id);
  return assignmentDetail(run, rows, rooms, viewerEmail);
}

async function loadPreviousOverrides(
  db: Database,
  date: string,
  forceReassign: boolean,
): Promise<Map<string, string>> {
  const overrides = new Map<string, string>();
  if (forceReassign) return overrides;

  const previousRun = await loadLatestRunForDate(db, date);
  if (!previousRun) return overrides;

  const rows = await db
    .select({
      wiseSessionId: schema.classroomAssignmentRows.wiseSessionId,
      overrideRoom: schema.classroomAssignmentRows.overrideRoom,
    })
    .from(schema.classroomAssignmentRows)
    .where(eq(schema.classroomAssignmentRows.runId, previousRun.id));

  for (const row of rows) {
    if (row.overrideRoom) overrides.set(row.wiseSessionId, exactWiseRoomName(row.overrideRoom));
  }
  return overrides;
}

async function loadAssignmentSessions(
  db: Database,
  snapshotId: string,
  date: string,
): Promise<AssignmentSession[]> {
  const { start, end } = dateRangeForBangkokDate(date);
  const rows = await db
    .select({
      groupId: schema.futureSessionBlocks.groupId,
      tutorDisplayName: schema.tutorIdentityGroups.displayName,
      wiseTeacherId: schema.futureSessionBlocks.wiseTeacherId,
      wiseTeacherUserId: schema.futureSessionBlocks.wiseTeacherUserId,
      wiseSessionId: schema.futureSessionBlocks.wiseSessionId,
      wiseClassId: schema.futureSessionBlocks.wiseClassId,
      startTime: schema.futureSessionBlocks.startTime,
      endTime: schema.futureSessionBlocks.endTime,
      weekday: schema.futureSessionBlocks.weekday,
      startMinute: schema.futureSessionBlocks.startMinute,
      endMinute: schema.futureSessionBlocks.endMinute,
      wiseStatus: schema.futureSessionBlocks.wiseStatus,
      sessionType: schema.futureSessionBlocks.sessionType,
      currentWiseLocation: schema.futureSessionBlocks.location,
      studentName: schema.futureSessionBlocks.studentName,
      studentCount: schema.futureSessionBlocks.studentCount,
      subject: schema.futureSessionBlocks.subject,
      classType: schema.futureSessionBlocks.classType,
      title: schema.futureSessionBlocks.title,
    })
    .from(schema.futureSessionBlocks)
    .innerJoin(
      schema.tutorIdentityGroups,
      eq(schema.futureSessionBlocks.groupId, schema.tutorIdentityGroups.id),
    )
    .where(
      and(
        eq(schema.futureSessionBlocks.snapshotId, snapshotId),
        eq(schema.futureSessionBlocks.isBlocking, true),
        gte(schema.futureSessionBlocks.startTime, start),
        lt(schema.futureSessionBlocks.startTime, end),
      ),
    );

  return rows.map((row) => ({
    ...row,
    startTime: new Date(row.startTime),
    endTime: new Date(row.endTime),
  }));
}

function toInsertRow(
  runId: string,
  snapshotId: string,
  row: AssignmentResultRow,
): typeof schema.classroomAssignmentRows.$inferInsert {
  return {
    runId,
    snapshotId,
    groupId: row.groupId,
    tutorDisplayName: row.tutorDisplayName,
    wiseTeacherId: row.wiseTeacherId,
    wiseTeacherUserId: row.wiseTeacherUserId ?? null,
    wiseSessionId: row.wiseSessionId,
    wiseClassId: row.wiseClassId ?? null,
    startTime: row.startTime,
    endTime: row.endTime,
    weekday: row.weekday,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    wiseStatus: row.wiseStatus,
    sessionType: row.sessionType ?? null,
    currentWiseLocation: row.currentWiseLocation ?? null,
    studentName: row.studentName ?? null,
    studentCount: row.studentCount ?? null,
    subject: row.subject ?? null,
    classType: row.classType ?? null,
    title: row.title ?? null,
    minCapacity: row.minCapacity,
    needsTv: row.needsTv,
    preferredRoom: row.preferredRoom,
    overrideRoom: row.overrideRoom,
    assignedRoom: row.assignedRoom,
    status: row.status,
    warnings: row.warnings,
    ruleTrace: row.ruleTrace,
    publishStatus: "not_published",
    publishError: null,
    publishedAt: null,
  };
}

async function persistAssignmentRun(
  db: Database,
  date: string,
  snapshotId: string,
  forceReassign: boolean,
  createdBy: string | null,
  assignmentRows: AssignmentResultRow[],
) {
  const counts = {
    totalSessions: assignmentRows.length,
    assignedCount: assignmentRows.filter((row) => row.status === "assigned").length,
    needsReviewCount: assignmentRows.filter((row) => row.status === "needs_review").length,
    noRoomCount: assignmentRows.filter((row) => row.status === "no_room").length,
    remoteCount: assignmentRows.filter((row) => row.status === "remote").length,
  };

  const [run] = await db
    .insert(schema.classroomAssignmentRuns)
    .values({
      assignmentDate: date,
      snapshotId,
      status: "completed",
      forceReassign,
      ...counts,
      createdBy,
    })
    .returning();

  if (assignmentRows.length) {
    await db
      .insert(schema.classroomAssignmentRows)
      .values(assignmentRows.map((row) => toInsertRow(run.id, snapshotId, row)));
  }

  return run;
}

export async function runClassroomAssignment(
  db: Database,
  input: { date: string; forceReassign: boolean; createdBy?: string | null },
): Promise<ClassroomAssignmentDetail> {
  const date = assertIsoDate(input.date);
  const activeSnapshot = await getActiveSnapshot(db);
  const rooms = await listClassroomRooms(db);
  const overrideBySessionId = await loadPreviousOverrides(db, date, input.forceReassign);
  const sessions = await loadAssignmentSessions(db, activeSnapshot.id, date);
  const result = assignClassrooms(sessions, rooms.map(toEngineRoom), overrideBySessionId);

  const run = await persistAssignmentRun(
    db,
    date,
    activeSnapshot.id,
    input.forceReassign,
    input.createdBy ?? null,
    result.rows,
  );

  const rows = await loadRowsForRun(db, run.id);
  return assignmentDetail(run, rows, rooms, input.createdBy ?? null);
}

function rowToSession(row: ClassroomRow): AssignmentSession {
  return {
    groupId: row.groupId,
    tutorDisplayName: row.tutorDisplayName,
    wiseTeacherId: row.wiseTeacherId,
    wiseTeacherUserId: row.wiseTeacherUserId,
    wiseSessionId: row.wiseSessionId,
    wiseClassId: row.wiseClassId,
    startTime: new Date(row.startTime),
    endTime: new Date(row.endTime),
    weekday: row.weekday,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    wiseStatus: row.wiseStatus,
    sessionType: row.sessionType,
    currentWiseLocation: row.currentWiseLocation,
    studentName: row.studentName,
    studentCount: row.studentCount,
    subject: row.subject,
    classType: row.classType,
    title: row.title,
  };
}

async function updateRunRowsFromAssignment(
  db: Database,
  run: ClassroomRun,
  sourceRows: ClassroomRow[],
  overrideBySessionId: Map<string, string | null>,
): Promise<void> {
  const rooms = await listClassroomRooms(db);
  const result = assignClassrooms(
    sourceRows.map(rowToSession),
    rooms.map(toEngineRoom),
    overrideBySessionId,
  );

  for (const row of result.rows) {
    const sourceRow = sourceRows.find((candidate) => candidate.wiseSessionId === row.wiseSessionId);
    if (!sourceRow) continue;

    await db
      .update(schema.classroomAssignmentRows)
      .set({
        minCapacity: row.minCapacity,
        needsTv: row.needsTv,
        preferredRoom: row.preferredRoom,
        overrideRoom: row.overrideRoom,
        assignedRoom: row.assignedRoom,
        status: row.status,
        warnings: row.warnings,
        ruleTrace: row.ruleTrace,
        publishStatus: "not_published",
        publishError: null,
        publishedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.classroomAssignmentRows.id, sourceRow.id));
  }

  await db
    .update(schema.classroomAssignmentRuns)
    .set({
      totalSessions: result.counts.totalSessions,
      assignedCount: result.counts.assignedCount,
      needsReviewCount: result.counts.needsReviewCount,
      noRoomCount: result.counts.noRoomCount,
      remoteCount: result.counts.remoteCount,
      publishedCount: 0,
      failedPublishCount: 0,
      status: "completed",
      updatedAt: new Date(),
    })
    .where(eq(schema.classroomAssignmentRuns.id, run.id));
}

export async function updateClassroomAssignmentOverride(
  db: Database,
  input: { runId: string; rowId: string; overrideRoom: string | null; updatedBy?: string | null },
): Promise<ClassroomAssignmentDetail> {
  const [run] = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.id, input.runId))
    .limit(1);
  if (!run) throw new Error("Assignment run not found");

  const sourceRows = await loadRowsForRun(db, input.runId);
  const target = sourceRows.find((row) => row.id === input.rowId);
  if (!target) throw new Error("Assignment row not found");

  const overrideRoom = input.overrideRoom?.trim() || null;
  if (overrideRoom && isLegacyPlainTvRoomName(overrideRoom)) {
    const exactRoom = exactWiseRoomName(overrideRoom);
    throw new Error(`Legacy plain TV room overrides are not allowed. Use "${exactRoom}" instead.`);
  }

  const overrideBySessionId = new Map<string, string | null>();
  for (const row of sourceRows) {
    overrideBySessionId.set(row.wiseSessionId, row.overrideRoom);
  }
  overrideBySessionId.set(target.wiseSessionId, overrideRoom);

  await updateRunRowsFromAssignment(db, run, sourceRows, overrideBySessionId);

  const rooms = await listClassroomRooms(db);
  const [freshRun] = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.id, input.runId))
    .limit(1);
  const rows = await loadRowsForRun(db, input.runId);
  return assignmentDetail(freshRun ?? run, rows, rooms, input.updatedBy ?? null);
}

function createWiseClientFromEnv(): WiseClient {
  const userId = process.env.WISE_USER_ID;
  const apiKey = process.env.WISE_API_KEY;
  const namespace = process.env.WISE_NAMESPACE ?? "begifted-education";
  if (!userId || !apiKey) {
    throw new Error("WISE_USER_ID and WISE_API_KEY are required to publish assignments");
  }
  return new WiseClient({ userId, apiKey, namespace });
}

async function markPublishResult(
  db: Database,
  rowId: string,
  publishStatus: "skipped" | "success" | "failed",
  publishError: string | null,
  publishedLocation?: string,
): Promise<void> {
  const set: Partial<ClassroomRow> = {
    publishStatus,
    publishError,
    publishedAt: publishStatus === "success" ? new Date() : null,
    updatedAt: new Date(),
  };
  if (publishStatus === "success" && publishedLocation !== undefined) {
    set.currentWiseLocation = publishedLocation;
  }

  await db
    .update(schema.classroomAssignmentRows)
    .set(set)
    .where(eq(schema.classroomAssignmentRows.id, rowId));
}

export function isClassroomPublishEligible(
  row: Pick<ClassroomRow,
    "status" | "assignedRoom" | "sessionType" | "wiseClassId" | "wiseSessionId" | "warnings"
  >,
): { eligible: true } | { eligible: false; reason: string } {
  if (row.status === "remote" || row.assignedRoom === REMOTE_NO_ROOM_NEEDED) {
    return { eligible: false, reason: "Remote online session has no Wise location to publish" };
  }
  if (row.status !== "assigned") return { eligible: false, reason: "Only assigned rows can publish" };
  if (!row.assignedRoom || row.assignedRoom === NO_ROOM_AVAILABLE) {
    return { eligible: false, reason: "No assigned room to publish" };
  }
  if (isLegacyPlainTvRoomName(row.assignedRoom)) {
    return {
      eligible: false,
      reason: `Legacy plain TV room "${row.assignedRoom}" cannot be published; use "${exactWiseRoomName(row.assignedRoom)}"`,
    };
  }
  if (!isOfflineSession(row.sessionType)) {
    return { eligible: false, reason: "V1 publishes Wise locations for OFFLINE sessions only" };
  }
  if (!row.wiseClassId) return { eligible: false, reason: "Missing Wise class id" };
  if (!row.wiseSessionId) return { eligible: false, reason: "Missing Wise session id" };
  if (row.warnings.includes("needs_review_missing_capacity")) {
    return { eligible: false, reason: "Missing reliable group capacity" };
  }
  return { eligible: true };
}

export async function createClassroomPublishJob(
  db: Database,
  input: { runId: string; createdBy?: string | null; confirmation?: string | null },
): Promise<PublishJobProgress> {
  assertWiseClassroomWritebackAllowed(input.createdBy ?? null);

  const [run] = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.id, input.runId))
    .limit(1);
  if (!run) throw new Error("Assignment run not found");

  const rows = await loadRowsForRun(db, input.runId);
  const eligibleCount = rows.filter((row) => isClassroomPublishEligible(row).eligible).length;
  const expectedConfirmation = `PUBLISH WISE ${eligibleCount}`;
  if (input.confirmation !== expectedConfirmation) {
    throw new Error(`Publish confirmation mismatch. Type "${expectedConfirmation}" to publish Wise locations.`);
  }
  const [job] = await db
    .insert(schema.classroomPublishJobs)
    .values({
      runId: input.runId,
      totalCount: rows.length,
      eligibleCount,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  return toPublishJobProgress(job);
}

async function incrementPublishJobCounters(
  db: Database,
  jobId: string,
  counts: Partial<Pick<PublishSummary, "success" | "failed" | "skipped">> & { completed?: number },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (counts.completed) {
    set.completedCount = sql`${schema.classroomPublishJobs.completedCount} + ${counts.completed}`;
  }
  if (counts.success) {
    set.successCount = sql`${schema.classroomPublishJobs.successCount} + ${counts.success}`;
  }
  if (counts.failed) {
    set.failedCount = sql`${schema.classroomPublishJobs.failedCount} + ${counts.failed}`;
  }
  if (counts.skipped) {
    set.skippedCount = sql`${schema.classroomPublishJobs.skippedCount} + ${counts.skipped}`;
  }

  await db
    .update(schema.classroomPublishJobs)
    .set(set)
    .where(eq(schema.classroomPublishJobs.id, jobId));
}

async function incrementPublishJobPreflightWarnings(
  db: Database,
  jobId: string,
  count = 1,
): Promise<void> {
  if (count <= 0) return;
  await db
    .update(schema.classroomPublishJobs)
    .set({
      preflightWarningCount: sql`${schema.classroomPublishJobs.preflightWarningCount} + ${count}`,
      updatedAt: new Date(),
    })
    .where(eq(schema.classroomPublishJobs.id, jobId));
}

async function updatePublishJobFinalVerification(
  db: Database,
  jobId: string,
  finalVerification: Record<string, unknown>,
): Promise<void> {
  await db
    .update(schema.classroomPublishJobs)
    .set({
      finalVerification,
      updatedAt: new Date(),
    })
    .where(eq(schema.classroomPublishJobs.id, jobId));
}

async function markPublishJobFailed(
  db: Database,
  jobId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Wise publish job failed";
  await db
    .update(schema.classroomPublishJobs)
    .set({
      status: "failed",
      lastError: message,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.classroomPublishJobs.id, jobId));
}

async function updateRunPublishStatus(db: Database, runId: string): Promise<void> {
  const publishedRows = await db
    .select({
      id: schema.classroomAssignmentRows.id,
      publishStatus: schema.classroomAssignmentRows.publishStatus,
    })
    .from(schema.classroomAssignmentRows)
    .where(eq(schema.classroomAssignmentRows.runId, runId));
  const publishedCount = publishedRows.filter((row) => row.publishStatus === "success").length;
  const failedPublishCount = publishedRows.filter((row) => row.publishStatus === "failed").length;
  const status =
    failedPublishCount > 0
      ? "partial"
      : publishedCount > 0
        ? "published"
        : "completed";

  await db
    .update(schema.classroomAssignmentRuns)
    .set({
      publishedCount,
      failedPublishCount,
      status,
      updatedAt: new Date(),
    })
    .where(eq(schema.classroomAssignmentRuns.id, runId));
}

function isStaleRunningPublishJob(job: ClassroomPublishJob, now = new Date()): boolean {
  if (job.status !== "running" || !job.startedAt || job.finishedAt) return false;
  return now.getTime() - job.startedAt.getTime() > PUBLISH_JOB_STALE_AFTER_MS;
}

async function failStalePublishJob(db: Database, job: ClassroomPublishJob): Promise<ClassroomPublishJob> {
  const [updatedJob] = await db
    .update(schema.classroomPublishJobs)
    .set({
      status: "failed",
      lastError: "Publish job timed out before completing. Retry publishing after refreshing the assignment.",
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.classroomPublishJobs.id, job.id))
    .returning();
  await updateRunPublishStatus(db, job.runId).catch(() => undefined);
  return updatedJob ?? job;
}

type WiseLocationUpdater = (classId: string, sessionId: string, location: string) => Promise<unknown>;

export interface WisePreflightResult {
  conflict: boolean;
  conflictReasons: string[];
  response: unknown;
}

interface WisePublishValidationContext {
  liveSessions: WiseSession[];
  liveSessionsById: Map<string, WiseSession>;
}

export function wisePreflightResponseHasConflict(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(wisePreflightResponseHasConflict);
  const record = value as Record<string, unknown>;
  if (
    record.conflict === true ||
    record.hasConflict === true ||
    record.isConflict === true ||
    record.isConflicting === true
  ) {
    return true;
  }
  return Object.values(record).some(wisePreflightResponseHasConflict);
}

export function collectWisePreflightConflictReasons(value: unknown, reasons = new Set<string>()): string[] {
  if (!value || typeof value !== "object") return [...reasons].sort();
  if (Array.isArray(value)) {
    for (const item of value) collectWisePreflightConflictReasons(item, reasons);
    return [...reasons].sort();
  }

  const record = value as Record<string, unknown>;
  const hasConflict =
    record.conflict === true ||
    record.hasConflict === true ||
    record.isConflict === true ||
    record.isConflicting === true;
  if (hasConflict && typeof record.reason === "string") {
    reasons.add(record.reason);
  }
  for (const item of Object.values(record)) collectWisePreflightConflictReasons(item, reasons);
  return [...reasons].sort();
}

export function isKnownNonLocationWisePreflightWarning(preflight: Pick<WisePreflightResult, "conflict" | "conflictReasons">): boolean {
  return (
    preflight.conflict &&
    preflight.conflictReasons.length > 0 &&
    preflight.conflictReasons.every((reason) => KNOWN_NON_LOCATION_PREFLIGHT_REASONS.has(reason))
  );
}

function rowWiseStartIso(row: Pick<ClassroomRow, "startTime">): string {
  return classroomTimestampToWiseIso(row.startTime);
}

function rowWiseEndIso(row: Pick<ClassroomRow, "endTime">): string {
  return classroomTimestampToWiseIso(row.endTime);
}

function liveSessionsById(sessions: WiseSession[]): Map<string, WiseSession> {
  return new Map(sessions.map((session) => [session._id, session]));
}

function wiseSessionsOverlap(left: WiseSession, right: WiseSession): boolean {
  return new Date(left.scheduledStartTime) < new Date(right.scheduledEndTime) &&
    new Date(right.scheduledStartTime) < new Date(left.scheduledEndTime);
}

function liveSessionRoomBlockersForRow(
  row: Pick<ClassroomRow, "wiseSessionId" | "assignedRoom">,
  liveSessions: Iterable<WiseSession>,
): WiseSession[] {
  const sessions = [...liveSessions];
  const targetSession = sessions.find((session) => session._id === row.wiseSessionId);
  if (!targetSession) return [];
  const targetLocation = normalizedPhysicalLocation(row.assignedRoom);
  if (!targetLocation) return [];

  return sessions.filter((candidate) => (
    candidate._id !== row.wiseSessionId &&
    isWiseSessionBlockingForPlainTvCleanup(candidate) &&
    normalizedPhysicalLocation(candidate.location ?? null) === targetLocation &&
    wiseSessionsOverlap(targetSession, candidate)
  ));
}

function validateLiveWiseSessionForPublish(
  row: ClassroomRow,
  liveSession: WiseSession | undefined,
): string | null {
  if (!liveSession) return `Live Wise session ${row.wiseSessionId} was not found in FUTURE sessions`;

  const liveClassId = getWiseSessionClassId(liveSession);
  if (row.wiseClassId && liveClassId && liveClassId !== row.wiseClassId) {
    return `Stale row: Wise class changed from ${row.wiseClassId} to ${liveClassId}`;
  }
  if (!liveClassId) return "Live Wise session is missing class id";

  if (wiseIso(liveSession.scheduledStartTime) !== rowWiseStartIso(row)) {
    return `Stale row: Wise start time changed from ${rowWiseStartIso(row)} to ${wiseIso(liveSession.scheduledStartTime)}`;
  }
  if (wiseIso(liveSession.scheduledEndTime) !== rowWiseEndIso(row)) {
    return `Stale row: Wise end time changed from ${rowWiseEndIso(row)} to ${wiseIso(liveSession.scheduledEndTime)}`;
  }
  if (!isOfflineSession(liveSession.type)) {
    return `Live Wise session type is not OFFLINE: ${liveSession.type ?? "unknown"}`;
  }
  if (
    row.currentWiseLocation &&
    normalizedLocation(liveSession.location ?? null) !== normalizedLocation(row.currentWiseLocation) &&
    normalizedLocation(liveSession.location ?? null) !== normalizedLocation(row.assignedRoom)
  ) {
    return `Stale row: Wise location changed from ${row.currentWiseLocation} to ${liveSession.location ?? "empty"}`;
  }

  return null;
}

export function buildWiseLocationPreflightBody(
  row: ClassroomRow,
  liveSession: WiseSession,
  toLocation: string,
): WiseSessionAvailabilityInput {
  const teacherId = getWiseSessionTeacherUserId(liveSession) ?? row.wiseTeacherUserId ?? undefined;
  if (!teacherId) {
    throw new Error("Missing Wise teacher user id for preflight");
  }

  return {
    teacherId,
    sessions: [{
      teacherId,
      classId: row.wiseClassId ?? getWiseSessionClassId(liveSession),
      sessionId: row.wiseSessionId,
      scheduledStartTime: liveSession.scheduledStartTime,
      scheduledEndTime: liveSession.scheduledEndTime,
      type: liveSession.type ?? row.sessionType ?? undefined,
    }],
    locationToCheck: toLocation,
    sessionsToSkip: {
      sessionId: row.wiseSessionId,
      skipUpcoming: false,
      classId: row.wiseClassId ?? getWiseSessionClassId(liveSession),
      startTime: liveSession.scheduledStartTime,
    },
  };
}

async function runWiseLocationPreflight(
  client: WiseClient,
  instituteId: string,
  row: ClassroomRow,
  liveSession: WiseSession,
): Promise<WisePreflightResult> {
  const response = await checkTeacherAvailabilityForSessions(
    client,
    instituteId,
    buildWiseLocationPreflightBody(row, liveSession, row.assignedRoom),
  );
  return {
    conflict: wisePreflightResponseHasConflict(response),
    conflictReasons: collectWisePreflightConflictReasons(response),
    response,
  };
}

function preflightRejection(preflight: WisePreflightResult): string | null {
  if (!preflight.conflict) return null;
  if (isKnownNonLocationWisePreflightWarning(preflight)) return null;
  const reasons = preflight.conflictReasons.length ? preflight.conflictReasons.join(", ") : "unknown conflict";
  return `Wise availability preflight rejected the location update: ${reasons}`;
}

async function refetchWiseSessionsForVerification(
  client: WiseClient,
  instituteId: string,
): Promise<WisePublishValidationContext> {
  const liveSessions = await fetchAllFutureSessions(client, instituteId);
  return { liveSessions, liveSessionsById: liveSessionsById(liveSessions) };
}

function verifyFinalPublishedRows(
  rows: ClassroomRow[],
  liveSessions: WiseSession[],
): { stalePublishedRows: string[]; roomConflictRows: string[] } {
  const liveById = liveSessionsById(liveSessions);
  const stalePublishedRows: string[] = [];
  const roomConflictRows: string[] = [];

  for (const row of rows) {
    const liveSession = liveById.get(row.wiseSessionId);
    if (!liveSession) {
      stalePublishedRows.push(`${row.wiseSessionId}: missing from live FUTURE sessions`);
      continue;
    }
    if (normalizedLocation(liveSession.location ?? null) !== normalizedLocation(row.assignedRoom)) {
      stalePublishedRows.push(`${row.wiseSessionId}: live location is ${liveSession.location ?? "empty"}, expected ${row.assignedRoom}`);
      continue;
    }

    const blockers = liveSessionRoomBlockersForRow(row, liveSessions);
    if (blockers.length) {
      roomConflictRows.push(`${row.wiseSessionId}: ${row.assignedRoom} blocked by ${blockers.map((session) => session._id).join(", ")}`);
    }
  }

  return { stalePublishedRows, roomConflictRows };
}

export async function updateWiseLocationOnly(
  updateLocation: WiseLocationUpdater,
  row: Pick<ClassroomRow, "wiseClassId" | "wiseSessionId">,
  location: string,
): Promise<string | null> {
  if (!row.wiseClassId) return "Missing Wise class id";
  if (!row.wiseSessionId) return "Missing Wise session id";
  try {
    await updateLocation(row.wiseClassId, row.wiseSessionId, location);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Wise publish failed";
  }
}

async function publishRowResult(
  db: Database,
  jobId: string,
  row: ClassroomRow,
  result: { status: "success"; publishedLocation?: string } | { status: "failed"; error: string },
): Promise<PublishSummary> {
  if (result.status === "success") {
    const publishedLocation = result.publishedLocation ?? row.assignedRoom;
    row.currentWiseLocation = publishedLocation;
    await markPublishResult(db, row.id, "success", null, publishedLocation);
    await incrementPublishJobCounters(db, jobId, { completed: 1, success: 1 });
    return { attempted: 1, success: 1, skipped: 0, failed: 0 };
  }

  await markPublishResult(db, row.id, "failed", result.error);
  await incrementPublishJobCounters(db, jobId, { completed: 1, failed: 1 });
  return { attempted: 1, success: 0, skipped: 0, failed: 1 };
}

async function markSkippedRows(
  db: Database,
  jobId: string,
  rows: Array<{ row: ClassroomRow; reason: string }>,
): Promise<PublishSummary> {
  const summary: PublishSummary = { attempted: 0, success: 0, skipped: 0, failed: 0 };
  await runLimited(rows, PUBLISH_ROW_CONCURRENCY, async ({ row, reason }) => {
    await markPublishResult(db, row.id, "skipped", reason);
    await incrementPublishJobCounters(db, jobId, { completed: 1, skipped: 1 });
    summary.skipped += 1;
  });
  return summary;
}

async function loadApprovedWiseLocations(
  client: WiseClient,
  instituteId: string,
): Promise<Set<string>> {
  const locations = await fetchInstituteLocations(client, instituteId);
  return new Set(locations.map((location) => location.trim()).filter(Boolean));
}

export async function runClassroomPublishJob(
  db: Database,
  jobId: string,
  client?: WiseClient,
): Promise<PublishJobStatusResponse> {
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const wiseClient = client ?? createWiseClientFromEnv();
  const existingJob = await loadPublishJob(db, jobId);
  assertWiseClassroomWritebackAllowed(existingJob.createdBy);
  if (isPublishJobTerminal(existingJob.status)) {
    return getClassroomPublishJobProgress(db, existingJob.runId, jobId, existingJob.createdBy);
  }

  await db
    .update(schema.classroomPublishJobs)
    .set({
      status: "running",
      startedAt: existingJob.startedAt ?? new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.classroomPublishJobs.id, jobId));

  try {
    const rows = await loadRowsForRun(db, existingJob.runId);
    const skippedRows: Array<{ row: ClassroomRow; reason: string }> = [];
    const eligibleRows: ClassroomRow[] = [];

    for (const row of rows) {
      const eligibility = isClassroomPublishEligible(row);
      if (!eligibility.eligible) {
        skippedRows.push({ row, reason: eligibility.reason });
      } else {
        eligibleRows.push(row);
      }
    }

    await db
      .update(schema.classroomPublishJobs)
      .set({
        totalCount: rows.length,
        eligibleCount: eligibleRows.length,
        updatedAt: new Date(),
      })
      .where(eq(schema.classroomPublishJobs.id, jobId));

    const summary: PublishSummary = { attempted: 0, success: 0, skipped: 0, failed: 0 };
    const skippedSummary = await markSkippedRows(db, jobId, skippedRows);
    summary.skipped += skippedSummary.skipped;
    const [approvedWiseLocations, initialSessions] = await Promise.all([
      loadApprovedWiseLocations(wiseClient, instituteId),
      fetchAllFutureSessions(wiseClient, instituteId),
    ]);
    await db
      .update(schema.classroomPublishJobs)
      .set({
        liveCatalogCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.classroomPublishJobs.id, jobId));

    let liveContext: WisePublishValidationContext = {
      liveSessions: initialSessions,
      liveSessionsById: liveSessionsById(initialSessions),
    };
    const successfullyVerifiedRows: ClassroomRow[] = [];

    await runLimited(eligibleRows, PUBLISH_ROW_CONCURRENCY, async (row) => {
      if (!approvedWiseLocations.has(row.assignedRoom)) {
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: `Assigned room "${row.assignedRoom}" is not in the Wise location catalog`,
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        return;
      }

      if (isLegacyPlainTvRoomName(row.assignedRoom)) {
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: `Legacy plain TV room "${row.assignedRoom}" cannot be published; use "${exactWiseRoomName(row.assignedRoom)}"`,
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        return;
      }

      const liveSession = liveContext.liveSessionsById.get(row.wiseSessionId);
      const staleReason = validateLiveWiseSessionForPublish(row, liveSession);
      if (staleReason || !liveSession) {
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: staleReason ?? "Live Wise session validation failed",
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        return;
      }

      const blockers = liveSessionRoomBlockersForRow(row, liveContext.liveSessions);
      if (blockers.length) {
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: `Target physical room is occupied by live Wise session(s): ${blockers.map((session) => session._id).join(", ")}`,
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        return;
      }

      let preflight: WisePreflightResult;
      try {
        preflight = await runWiseLocationPreflight(wiseClient, instituteId, row, liveSession);
      } catch (error) {
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: error instanceof Error ? error.message : "Wise availability preflight failed",
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        return;
      }

      const preflightError = preflightRejection(preflight);
      if (preflightError) {
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: preflightError,
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        return;
      }

      if (isKnownNonLocationWisePreflightWarning(preflight)) {
        await incrementPublishJobPreflightWarnings(db, jobId);
      }

      if (normalizedLocation(liveSession.location ?? null) === normalizedLocation(row.assignedRoom)) {
        const result = await publishRowResult(db, jobId, row, {
          status: "success",
          publishedLocation: row.assignedRoom,
        });
        summary.attempted += result.attempted;
        summary.success += result.success;
        successfullyVerifiedRows.push(row);
        return;
      }

      const updateError = await updateWiseLocationOnly(
        (classId, sessionId, location) => updateSessionLocation(wiseClient, classId, sessionId, location),
        row,
        row.assignedRoom,
      );
      if (updateError) {
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: updateError,
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        return;
      }

      liveContext = await refetchWiseSessionsForVerification(wiseClient, instituteId);
      const verifiedSession = liveContext.liveSessionsById.get(row.wiseSessionId);
      if (normalizedLocation(verifiedSession?.location ?? null) !== normalizedLocation(row.assignedRoom)) {
        const error = `Post-write verification failed: live location is ${verifiedSession?.location ?? "empty"}, expected ${row.assignedRoom}`;
        const result = await publishRowResult(db, jobId, row, { status: "failed", error });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        return;
      }

      const result = await publishRowResult(db, jobId, row, { status: "success" });
      summary.attempted += result.attempted;
      summary.success += result.success;
      successfullyVerifiedRows.push(row);
    });

    liveContext = await refetchWiseSessionsForVerification(wiseClient, instituteId);
    const finalInvalidPlainTvSessionCount = invalidPlainTvSessionCount(liveContext.liveSessions);
    const finalRowVerification = verifyFinalPublishedRows(successfullyVerifiedRows, liveContext.liveSessions);
    const finalVerification = {
      invalidPlainTvSessionCount: finalInvalidPlainTvSessionCount,
      verifiedSuccessCount: successfullyVerifiedRows.length,
      stalePublishedRows: finalRowVerification.stalePublishedRows,
      roomConflictRows: finalRowVerification.roomConflictRows,
    };
    await updatePublishJobFinalVerification(db, jobId, finalVerification);

    if (
      finalInvalidPlainTvSessionCount !== 0 ||
      finalRowVerification.stalePublishedRows.length > 0 ||
      finalRowVerification.roomConflictRows.length > 0
    ) {
      const failures = [
        finalInvalidPlainTvSessionCount !== 0
          ? `${finalInvalidPlainTvSessionCount} future blocking session(s) still occupy invalid plain TV rooms`
          : null,
        finalRowVerification.stalePublishedRows.length
          ? `${finalRowVerification.stalePublishedRows.length} published row(s) failed final location verification`
          : null,
        finalRowVerification.roomConflictRows.length
          ? `${finalRowVerification.roomConflictRows.length} published row(s) have final physical room conflicts`
          : null,
      ].filter(Boolean).join("; ");
      throw new Error(`Final Wise verification failed: ${failures}`);
    }

    await updateRunPublishStatus(db, existingJob.runId);

    const terminalStatus: ClassroomPublishJob["status"] =
      summary.failed > 0
        ? summary.success > 0
          ? "partial"
          : "failed"
        : "succeeded";
    await db
      .update(schema.classroomPublishJobs)
      .set({
        status: terminalStatus,
        lastError: terminalStatus === "failed" ? "No Wise locations were published" : null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.classroomPublishJobs.id, jobId));

    return getClassroomPublishJobProgress(db, existingJob.runId, jobId, existingJob.createdBy);
  } catch (error) {
    await markPublishJobFailed(db, jobId, error);
    await updateRunPublishStatus(db, existingJob.runId).catch(() => undefined);
    throw error;
  }
}

export async function getClassroomPublishJobProgress(
  db: Database,
  runId: string,
  jobId: string,
  viewerEmail?: string | null,
): Promise<PublishJobStatusResponse> {
  let job = await loadPublishJob(db, jobId, runId);
  if (isStaleRunningPublishJob(job)) {
    job = await failStalePublishJob(db, job);
  }
  const response: PublishJobStatusResponse = {
    progress: toPublishJobProgress(job),
  };
  if (isPublishJobTerminal(job.status)) {
    response.detail = await getClassroomAssignmentByRunId(db, runId, viewerEmail);
  }
  return response;
}

export async function publishClassroomAssignmentRun(
  db: Database,
  runId: string,
  client?: WiseClient,
  input: { createdBy?: string | null; confirmation?: string | null } = {},
): Promise<{ detail: ClassroomAssignmentDetail; summary: PublishSummary }> {
  const progress = await createClassroomPublishJob(db, {
    runId,
    createdBy: input.createdBy ?? null,
    confirmation: input.confirmation ?? null,
  });
  const result = await runClassroomPublishJob(db, progress.jobId, client);
  const finalProgress = result.progress;
  const detail = result.detail ?? await getClassroomAssignmentByRunId(db, runId, input.createdBy ?? null);
  return {
    detail,
    summary: {
      attempted: finalProgress.successCount + finalProgress.failedCount,
      success: finalProgress.successCount,
      skipped: finalProgress.skippedCount,
      failed: finalProgress.failedCount,
    },
  };
}

export async function getClassroomAssignmentByRunId(
  db: Database,
  runId: string,
  viewerEmail?: string | null,
): Promise<ClassroomAssignmentDetail> {
  const rooms = await listClassroomRooms(db);
  const [run] = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Assignment run not found");
  const rows = await loadRowsForRun(db, runId);
  return assignmentDetail(run, rows, rooms, viewerEmail);
}

function formatBangkokTimestamp(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")} ${byType.get("hour")}:${byType.get("minute")}`;
}

export function intendedTvRepairLocation(location: string | null | undefined): string | null {
  return tvRoomRepairLocation(location);
}

export async function getPlainTvLocationRepairAudit(
  db: Database,
): Promise<PlainTvLocationRepairAuditRow[]> {
  const rows = await db
    .select({
      publishJobId: schema.classroomPublishJobs.id,
      publishJobStatus: schema.classroomPublishJobs.status,
      publishedBy: schema.classroomPublishJobs.createdBy,
      runId: schema.classroomAssignmentRuns.id,
      assignmentDate: schema.classroomAssignmentRuns.assignmentDate,
      rowId: schema.classroomAssignmentRows.id,
      wiseClassId: schema.classroomAssignmentRows.wiseClassId,
      wiseSessionId: schema.classroomAssignmentRows.wiseSessionId,
      tutorDisplayName: schema.classroomAssignmentRows.tutorDisplayName,
      studentName: schema.classroomAssignmentRows.studentName,
      startTime: schema.classroomAssignmentRows.startTime,
      wrongLocation: schema.classroomAssignmentRows.currentWiseLocation,
      assignedRoom: schema.classroomAssignmentRows.assignedRoom,
      publishedAt: schema.classroomAssignmentRows.publishedAt,
    })
    .from(schema.classroomAssignmentRows)
    .innerJoin(
      schema.classroomAssignmentRuns,
      eq(schema.classroomAssignmentRows.runId, schema.classroomAssignmentRuns.id),
    )
    .leftJoin(
      schema.classroomPublishJobs,
      and(
        eq(schema.classroomPublishJobs.runId, schema.classroomAssignmentRuns.id),
        lte(schema.classroomPublishJobs.startedAt, schema.classroomAssignmentRows.publishedAt),
        gte(schema.classroomPublishJobs.finishedAt, schema.classroomAssignmentRows.publishedAt),
      ),
    )
    .where(
      and(
        eq(schema.classroomAssignmentRows.publishStatus, "success"),
        gte(schema.classroomAssignmentRows.publishedAt, PLAIN_TV_REPAIR_AUDIT_START),
        inArray(schema.classroomAssignmentRows.assignedRoom, LEGACY_PLAIN_TV_ROOM_NAMES),
        eq(schema.classroomAssignmentRows.currentWiseLocation, schema.classroomAssignmentRows.assignedRoom),
      ),
    )
    .orderBy(
      schema.classroomAssignmentRuns.assignmentDate,
      schema.classroomAssignmentRows.startTime,
      schema.classroomAssignmentRows.tutorDisplayName,
    );

  return rows.flatMap((row) => {
    const intendedLocation = intendedTvRepairLocation(row.assignedRoom);
    if (!intendedLocation || !row.wrongLocation) return [];
    return [{
      publishJobId: row.publishJobId,
      publishJobStatus: row.publishJobStatus,
      publishedBy: row.publishedBy,
      runId: row.runId,
      assignmentDate: row.assignmentDate,
      rowId: row.rowId,
      wiseClassId: row.wiseClassId,
      wiseSessionId: row.wiseSessionId,
      tutorDisplayName: row.tutorDisplayName,
      studentName: row.studentName,
      startTimeBangkok: formatBangkokTimestamp(new Date(row.startTime)),
      wrongLocation: row.wrongLocation,
      intendedLocation,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    }];
  });
}

export async function getTeacherScheduleForRun(
  db: Database,
  runId: string,
): Promise<TeacherSchedule> {
  const [run] = await db
    .select({ assignmentDate: schema.classroomAssignmentRuns.assignmentDate })
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Assignment run not found");

  const rows = await loadRowsForRun(db, runId);
  const byTutor = new Map<string, TeacherScheduleBlock[]>();
  for (const row of rows) {
    const blocks = byTutor.get(row.tutorDisplayName) ?? [];
    blocks.push({
      rowId: row.id,
      date: run.assignmentDate,
      startTime: formatMinute(row.startMinute),
      endTime: formatMinute(row.endMinute),
      room: classroomRoomLabel(row),
      studentName: row.studentName,
      subject: row.subject,
      classType: row.classType,
      sessionType: row.sessionType,
    });
    byTutor.set(row.tutorDisplayName, blocks);
  }

  return {
    tutors: [...byTutor.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tutorDisplayName, blocks]) => ({
        tutorDisplayName,
        blocks: blocks.sort((a, b) => {
          if (a.startTime !== b.startTime) return a.startTime.localeCompare(b.startTime);
          return a.rowId.localeCompare(b.rowId);
        }),
      })),
  };
}

export async function deleteClassroomRowsForRun(db: Database, runId: string): Promise<void> {
  await db
    .delete(schema.classroomAssignmentRows)
    .where(eq(schema.classroomAssignmentRows.runId, runId));
}

export async function deleteClassroomRuns(db: Database, runIds: string[]): Promise<void> {
  if (!runIds.length) return;
  await db
    .delete(schema.classroomAssignmentRuns)
    .where(inArray(schema.classroomAssignmentRuns.id, runIds));
}
