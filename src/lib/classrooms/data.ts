import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { WiseClient } from "@/lib/wise/client";
import {
  fetchInstituteLocations,
  updateSessionLocation,
} from "@/lib/wise/fetchers";
import {
  assignClassrooms,
  type AssignmentResultRow,
  type AssignmentSession,
  isOfflineSession,
  REMOTE_NO_ROOM_NEEDED,
} from "./assignment-engine";
import {
  DEFAULT_CLASSROOM_ROOMS,
  NO_ROOM_AVAILABLE,
  type ClassroomRoomDefinition,
} from "./rooms";

export type ClassroomRun = typeof schema.classroomAssignmentRuns.$inferSelect;
export type ClassroomRow = typeof schema.classroomAssignmentRows.$inferSelect;
export type ClassroomRoom = typeof schema.classroomRooms.$inferSelect;
export type ClassroomPublishJob = typeof schema.classroomPublishJobs.$inferSelect;

export interface ClassroomAssignmentDetail {
  run: ClassroomRun | null;
  rows: ClassroomRow[];
  rooms: ClassroomRoom[];
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PUBLISH_ROW_CONCURRENCY = 10;
const PUBLISH_JOB_STALE_AFTER_MS = 6 * 60 * 1000;

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
  return normalizedLocation(value).replace(/\s+\(tv\)$/, "");
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

function isPublishRoomInUse(
  roomName: string,
  row: PublishDependencyRow,
  candidates: PublishDependencyRow[],
): boolean {
  const target = normalizedPhysicalLocation(roomName);
  return candidates.some((candidate) => (
    candidate.id !== row.id &&
    rowsOverlap(row, candidate) &&
    (
      normalizedPhysicalLocation(candidate.currentWiseLocation) === target ||
      normalizedPhysicalLocation(candidate.assignedRoom) === target
    )
  ));
}

export function findTemporaryPublishLocation(
  row: PublishDependencyRow,
  candidates: PublishDependencyRow[],
  roomNames: string[],
): string | null {
  return roomNames.find((roomName) => !isPublishRoomInUse(roomName, row, candidates)) ?? null;
}

export function orderTemporaryPublishCandidates<T extends PublishDependencyRow>(rows: T[]): T[] {
  const blockerCounts = new Map<string, number>();
  for (const row of rows) {
    for (const blocker of findPublishRoomBlockers(row, rows)) {
      blockerCounts.set(blocker.id, (blockerCounts.get(blocker.id) ?? 0) + 1);
    }
  }
  return rows
    .filter((row) => (blockerCounts.get(row.id) ?? 0) > 0)
    .sort((left, right) => (blockerCounts.get(right.id) ?? 0) - (blockerCounts.get(left.id) ?? 0));
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
): Promise<ClassroomAssignmentDetail> {
  assertIsoDate(date);
  const rooms = await listClassroomRooms(db);
  const run = await loadLatestRunForDate(db, date);
  if (!run) return { run: null, rows: [], rooms };
  const rows = await loadRowsForRun(db, run.id);
  return { run, rows, rooms };
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
    if (row.overrideRoom) overrides.set(row.wiseSessionId, row.overrideRoom);
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
  return { run, rows, rooms };
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
  input: { runId: string; rowId: string; overrideRoom: string | null },
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

  const overrideBySessionId = new Map<string, string | null>();
  for (const row of sourceRows) {
    overrideBySessionId.set(row.wiseSessionId, row.overrideRoom);
  }
  overrideBySessionId.set(target.wiseSessionId, input.overrideRoom?.trim() || null);

  await updateRunRowsFromAssignment(db, run, sourceRows, overrideBySessionId);

  const rooms = await listClassroomRooms(db);
  const [freshRun] = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.id, input.runId))
    .limit(1);
  const rows = await loadRowsForRun(db, input.runId);
  return { run: freshRun ?? run, rows, rooms };
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

async function updateRowCurrentWiseLocation(
  db: Database,
  rowId: string,
  currentWiseLocation: string,
): Promise<void> {
  await db
    .update(schema.classroomAssignmentRows)
    .set({
      currentWiseLocation,
      updatedAt: new Date(),
    })
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
  input: { runId: string; createdBy?: string | null },
): Promise<PublishJobProgress> {
  const [run] = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.id, input.runId))
    .limit(1);
  if (!run) throw new Error("Assignment run not found");

  const rows = await loadRowsForRun(db, input.runId);
  const eligibleCount = rows.filter((row) => isClassroomPublishEligible(row).eligible).length;
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

async function loadTemporaryPublishLocations(
  db: Database,
  client: WiseClient,
  instituteId: string,
): Promise<string[]> {
  const [rooms, wiseLocations] = await Promise.all([
    listClassroomRooms(db),
    fetchInstituteLocations(client, instituteId).catch(() => []),
  ]);
  const wiseLocationNames = new Set(wiseLocations);
  return rooms
    .filter((room) => room.active && room.category !== "online_only")
    .map((room) => room.name)
    .filter((roomName) => wiseLocationNames.size === 0 || wiseLocationNames.has(roomName));
}

async function moveCycleRowToTemporaryLocation(
  db: Database,
  client: WiseClient,
  rows: ClassroomRow[],
  allRows: ClassroomRow[],
  temporaryLocations: string[],
  temporaryMovedRowIds: Set<string>,
): Promise<{ moved: true } | { moved: false; error: string }> {
  const attemptedErrors: string[] = [];
  const moveCandidates = orderTemporaryPublishCandidates(rows).filter((row) => !temporaryMovedRowIds.has(row.id));
  for (const row of moveCandidates) {
    const candidates = temporaryLocations.filter((location) => (
      normalizedPhysicalLocation(location) !== normalizedPhysicalLocation(row.currentWiseLocation) &&
      normalizedPhysicalLocation(location) !== normalizedPhysicalLocation(row.assignedRoom)
    ));
    const temporaryLocation = findTemporaryPublishLocation(row, allRows, candidates);
    if (!temporaryLocation) {
      attemptedErrors.push(`${row.tutorDisplayName}: no temporary room available`);
      continue;
    }

    const updateError = await updateWiseLocationOnly(
      (classId, sessionId, location) => updateSessionLocation(client, classId, sessionId, location),
      row,
      temporaryLocation,
    );
    if (updateError) {
      attemptedErrors.push(`${row.tutorDisplayName}: ${updateError}`);
      continue;
    }

    row.currentWiseLocation = temporaryLocation;
    temporaryMovedRowIds.add(row.id);
    await updateRowCurrentWiseLocation(db, row.id, temporaryLocation);
    return { moved: true };
  }

  return {
    moved: false,
    error: attemptedErrors[0] ?? "No untried blocking row had an available temporary room",
  };
}

export async function runClassroomPublishJob(
  db: Database,
  jobId: string,
  client = createWiseClientFromEnv(),
): Promise<PublishJobStatusResponse> {
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const existingJob = await loadPublishJob(db, jobId);
  if (isPublishJobTerminal(existingJob.status)) {
    return getClassroomPublishJobProgress(db, existingJob.runId, jobId);
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
    const temporaryLocations = await loadTemporaryPublishLocations(db, client, instituteId);
    const temporaryMovedRowIds = new Set<string>();

    const pendingRows = new Map<string, ClassroomRow>();
    const failedRows = new Map<string, ClassroomRow>();
    for (const row of eligibleRows) {
      if (
        row.publishStatus === "success" ||
        normalizedPhysicalLocation(row.currentWiseLocation) === normalizedPhysicalLocation(row.assignedRoom)
      ) {
        const result = await publishRowResult(db, jobId, row, {
          status: "success",
          publishedLocation: row.currentWiseLocation ?? row.assignedRoom,
        });
        summary.attempted += result.attempted;
        summary.success += result.success;
      } else {
        pendingRows.set(row.id, row);
      }
    }

    while (pendingRows.size > 0) {
      const pending = [...pendingRows.values()];
      let dependencyFailures = 0;
      for (const row of pending) {
        const blockers = findPublishRoomBlockers(row, [...failedRows.values()]);
        if (blockers.length === 0) continue;
        const blockerNames = blockers.map((blocker) => blocker.tutorDisplayName).join(", ");
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: `Wise room still occupied because ${blockerNames} could not be moved`,
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        failedRows.set(row.id, row);
        pendingRows.delete(row.id);
        dependencyFailures += 1;
      }
      if (dependencyFailures > 0) continue;

      const stillPending = [...pendingRows.values()];
      const readyRows = stillPending.filter((row) => findPublishRoomBlockers(row, stillPending).length === 0);
      if (readyRows.length === 0) {
        const temporaryMove = await moveCycleRowToTemporaryLocation(
          db,
          client,
          stillPending,
          rows,
          temporaryLocations,
          temporaryMovedRowIds,
        );
        if (temporaryMove.moved) continue;

        await runLimited(stillPending, PUBLISH_ROW_CONCURRENCY, async (row) => {
          const blockers = findPublishRoomBlockers(row, stillPending);
          const blockerNames = blockers.map((blocker) => blocker.tutorDisplayName).join(", ");
          const result = await publishRowResult(db, jobId, row, {
            status: "failed",
            error: blockerNames
              ? `Wise room swap cycle; blocked by ${blockerNames}; ${temporaryMove.error}`
              : temporaryMove.error,
          });
          summary.attempted += result.attempted;
          summary.failed += result.failed;
          failedRows.set(row.id, row);
          pendingRows.delete(row.id);
        });
        break;
      }

      await runLimited(readyRows, PUBLISH_ROW_CONCURRENCY, async (row) => {
        const updateError = await updateWiseLocationOnly(
          (classId, sessionId, location) => updateSessionLocation(client, classId, sessionId, location),
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
          failedRows.set(row.id, row);
          pendingRows.delete(row.id);
          return;
        }

        const result = await publishRowResult(db, jobId, row, { status: "success" });
        summary.attempted += result.attempted;
        summary.success += result.success;
        pendingRows.delete(row.id);
      });
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

    return getClassroomPublishJobProgress(db, existingJob.runId, jobId);
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
): Promise<PublishJobStatusResponse> {
  let job = await loadPublishJob(db, jobId, runId);
  if (isStaleRunningPublishJob(job)) {
    job = await failStalePublishJob(db, job);
  }
  const response: PublishJobStatusResponse = {
    progress: toPublishJobProgress(job),
  };
  if (isPublishJobTerminal(job.status)) {
    response.detail = await getClassroomAssignmentByRunId(db, runId);
  }
  return response;
}

export async function publishClassroomAssignmentRun(
  db: Database,
  runId: string,
  client = createWiseClientFromEnv(),
): Promise<{ detail: ClassroomAssignmentDetail; summary: PublishSummary }> {
  const progress = await createClassroomPublishJob(db, { runId });
  const result = await runClassroomPublishJob(db, progress.jobId, client);
  const finalProgress = result.progress;
  const detail = result.detail ?? await getClassroomAssignmentByRunId(db, runId);
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
): Promise<ClassroomAssignmentDetail> {
  const rooms = await listClassroomRooms(db);
  const [run] = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Assignment run not found");
  const rows = await loadRowsForRun(db, runId);
  return { run, rows, rooms };
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
