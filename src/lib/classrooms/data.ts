import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { WiseClient } from "@/lib/wise/client";
import {
  checkTeacherAvailabilityForSessions,
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function classroomRoomLabel(row: Pick<ClassroomRow, "status" | "assignedRoom">): string {
  if (row.status === "remote" || row.assignedRoom === REMOTE_NO_ROOM_NEEDED) {
    return "Remote / no room needed";
  }
  return row.assignedRoom;
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
): Promise<void> {
  await db
    .update(schema.classroomAssignmentRows)
    .set({
      publishStatus,
      publishError,
      publishedAt: publishStatus === "success" ? new Date() : null,
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

export async function publishClassroomAssignmentRun(
  db: Database,
  runId: string,
  client = createWiseClientFromEnv(),
): Promise<{ detail: ClassroomAssignmentDetail; summary: PublishSummary }> {
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const [run] = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Assignment run not found");

  const rows = await loadRowsForRun(db, runId);
  const summary: PublishSummary = { attempted: 0, success: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    const eligibility = isClassroomPublishEligible(row);
    if (!eligibility.eligible) {
      summary.skipped += 1;
      await markPublishResult(db, row.id, "skipped", eligibility.reason);
      continue;
    }

    summary.attempted += 1;
    try {
      if (row.wiseTeacherUserId) {
        const availability = await checkTeacherAvailabilityForSessions(client, instituteId, {
          sessions: [
            {
              teacherId: row.wiseTeacherUserId,
              scheduledStartTime: new Date(row.startTime).toISOString(),
              scheduledEndTime: new Date(row.endTime).toISOString(),
              type: row.sessionType ?? "OFFLINE",
            },
          ],
          locationToCheck: row.assignedRoom,
          sessionsToSkip: [{ sessionId: row.wiseSessionId, skipUpcoming: false }],
        });
        if (availability.sessions?.some((session) => session.hasConflict || session.conflict)) {
          throw new Error("Wise availability check reported a room/teacher conflict");
        }
      }

      await updateSessionLocation(client, row.wiseClassId!, row.wiseSessionId, row.assignedRoom);
      summary.success += 1;
      await markPublishResult(db, row.id, "success", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wise publish failed";
      summary.failed += 1;
      await markPublishResult(db, row.id, "failed", message);
    }
  }

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

  const detail = await getClassroomAssignmentByRunId(db, runId);
  return { detail, summary };
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
  const rows = await loadRowsForRun(db, runId);
  const byTutor = new Map<string, TeacherScheduleBlock[]>();
  for (const row of rows) {
    const blocks = byTutor.get(row.tutorDisplayName) ?? [];
    blocks.push({
      rowId: row.id,
      date: row.startTime.toISOString().slice(0, 10),
      startTime: formatTime(new Date(row.startTime)),
      endTime: formatTime(new Date(row.endTime)),
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
        blocks: blocks.sort((a, b) => a.startTime.localeCompare(b.startTime)),
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
