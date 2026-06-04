import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { WiseClient } from "@/lib/wise/client";
import {
  fetchAllFutureSessions,
  fetchInstituteLocations,
  updateSessionLocation,
} from "@/lib/wise/fetchers";
import {
  getWiseSessionClassId,
  getWiseSessionClassName,
  type WiseSession,
} from "@/lib/wise/types";
import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { getLocalMinuteOfDay } from "@/lib/normalization/timezone";
import { isBlockingStatus } from "@/lib/normalization/sessions";
import {
  assignClassrooms,
  type ExternalRoomBlock,
  type AssignmentResultRow,
  type AssignmentSession,
  isOfflineSession,
  REMOTE_NO_ROOM_NEEDED,
} from "./assignment-engine";
import {
  DEFAULT_CLASSROOM_ROOMS,
  NO_ROOM_AVAILABLE,
  TV_ROOM_NAME_BY_PHYSICAL_NAME,
  type ClassroomRoomDefinition,
} from "./rooms";
import {
  assignmentFingerprint,
  reconcileClassroomAssignments,
  type ClassroomAutomationEvent,
  type PreviousAssignmentRow,
  type ReconciledAssignmentRow,
} from "./reconciliation";

export type ClassroomRun = typeof schema.classroomAssignmentRuns.$inferSelect;
export type ClassroomRow = typeof schema.classroomAssignmentRows.$inferSelect;
export type ClassroomRoom = typeof schema.classroomRooms.$inferSelect;
export type ClassroomPublishJob = typeof schema.classroomPublishJobs.$inferSelect;

export interface ClassroomAssignmentDetail {
  run: ClassroomRun | null;
  rows: ClassroomRow[];
  rooms: ClassroomRoom[];
  snapshotMeta: ClassroomSnapshotMeta;
  liveRoomBlocks: LiveRoomBlock[];
  roomConflictWarnings: RoomConflictWarning[];
}

export interface ClassroomSnapshotMeta {
  snapshotId: string | null;
  latestSyncFinishedAt: string | null;
  staleAgeMs: number | null;
  fresh: boolean;
}

export interface FreshClassroomSnapshot {
  snapshotId: string;
  snapshotMeta: ClassroomSnapshotMeta;
}

export interface LiveRoomBlock extends ExternalRoomBlock {
  wiseClassId: string | null;
  sessionType: string | null;
  wiseStatus: string | null;
}

export interface RoomConflictWarning {
  wiseSessionId: string;
  assignedRoom: string;
  desiredLocation: string;
  message: string;
  blocker: LiveRoomBlock;
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
export const CLASSROOM_ASSIGNMENT_FRESHNESS_MS = 15 * 60 * 1000;

export class StaleClassroomAssignmentSnapshotError extends Error {
  readonly code = "STALE_ASSIGNMENT_SNAPSHOT";
  readonly latestSyncFinishedAt: string | null;
  readonly staleAgeMs: number | null;

  constructor(meta: ClassroomSnapshotMeta) {
    const minutes = meta.staleAgeMs === null ? null : Math.round(meta.staleAgeMs / 60000);
    super(
      minutes === null
        ? "Class assignment data is not fresh. Run Wise sync before generating assignments."
        : `Class assignment data is stale (${minutes} minutes old). Run Wise sync before generating assignments.`,
    );
    this.name = "StaleClassroomAssignmentSnapshotError";
    this.latestSyncFinishedAt = meta.latestSyncFinishedAt;
    this.staleAgeMs = meta.staleAgeMs;
  }
}

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

function normalizedExactLocation(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function intervalsOverlap(
  left: Pick<ClassroomRow | AssignmentSession | LiveRoomBlock, "startMinute" | "endMinute">,
  right: Pick<ClassroomRow | AssignmentSession | LiveRoomBlock, "startMinute" | "endMinute">,
): boolean {
  return left.startMinute < right.endMinute && right.startMinute < left.endMinute;
}

function liveRoomBlockLabel(block: Pick<LiveRoomBlock, "className" | "location" | "startMinute" | "endMinute">): string {
  const className = block.className?.trim() || "unknown class";
  return `${className} in ${block.location} ${formatMinute(block.startMinute)}-${formatMinute(block.endMinute)}`;
}

function isLiveWiseRoomBlock(session: WiseSession, date: string): boolean {
  const location = normalizedExactLocation(session.location);
  return (
    Boolean(location) &&
    bangkokDateKey(new Date(session.scheduledStartTime)) === date &&
    isBlockingStatus(session.meetingStatus) &&
    isOfflineSession(session.type)
  );
}

function wiseSessionToLiveRoomBlock(session: WiseSession): LiveRoomBlock {
  return {
    wiseSessionId: session._id,
    wiseClassId: getWiseSessionClassId(session) ?? null,
    className: getWiseSessionClassName(session) ?? null,
    location: normalizedExactLocation(session.location),
    startMinute: getLocalMinuteOfDay(session.scheduledStartTime),
    endMinute: getLocalMinuteOfDay(session.scheduledEndTime),
    sessionType: session.type ?? null,
    wiseStatus: session.meetingStatus ?? null,
  };
}

export function liveRoomBlocksForDate(sessions: WiseSession[], date: string): LiveRoomBlock[] {
  return sessions
    .filter((session) => isLiveWiseRoomBlock(session, date))
    .map(wiseSessionToLiveRoomBlock);
}

function externalLiveRoomBlocks(
  liveBlocks: LiveRoomBlock[],
  localWiseSessionIds: Set<string>,
): LiveRoomBlock[] {
  return liveBlocks.filter((block) => !localWiseSessionIds.has(block.wiseSessionId));
}

export function findExternalRoomBlocker(
  row: Pick<ClassroomRow | AssignmentResultRow, "startMinute" | "endMinute">,
  desiredLocation: string,
  blocks: LiveRoomBlock[],
): LiveRoomBlock | null {
  const target = normalizedPhysicalLocation(desiredLocation);
  return blocks.find((block) => (
    normalizedPhysicalLocation(block.location) === target &&
    intervalsOverlap(row, block)
  )) ?? null;
}

export function buildRoomConflictWarnings(
  rows: Array<Pick<ClassroomRow, "wiseSessionId" | "assignedRoom" | "startMinute" | "endMinute">>,
  externalBlocks: LiveRoomBlock[],
  publishLocationByAssignedRoom: (assignedRoom: string) => string | null,
): RoomConflictWarning[] {
  const warnings: RoomConflictWarning[] = [];
  for (const row of rows) {
    if (!row.assignedRoom || row.assignedRoom === NO_ROOM_AVAILABLE || row.assignedRoom === REMOTE_NO_ROOM_NEEDED) {
      continue;
    }
    const desiredLocation = publishLocationByAssignedRoom(row.assignedRoom) ?? row.assignedRoom;
    const blocker = findExternalRoomBlocker(row, desiredLocation, externalBlocks);
    if (!blocker) continue;
    warnings.push({
      wiseSessionId: row.wiseSessionId,
      assignedRoom: row.assignedRoom,
      desiredLocation,
      blocker,
      message: `Blocked by live Wise class ${liveRoomBlockLabel(blocker)}`,
    });
  }
  return warnings;
}

type PublishLocationRoom = Pick<
  ClassroomRoomDefinition,
  "name" | "hasTv" | "capacity" | "category" | "active" | "sortOrder"
>;

export interface WisePublishLocationCatalog {
  publishLocationByPhysicalRoom: Map<string, string>;
  missingLocationByPhysicalRoom: Map<string, string>;
  temporaryLocations: string[];
}

export function wisePublishLocationName(room: Pick<ClassroomRoomDefinition, "name" | "hasTv">): string {
  const roomName = normalizedExactLocation(room.name);
  if (!room.hasTv) return roomName;
  return `${roomName.replace(/\s+\(tv\)$/i, "")} (TV)`;
}

export function buildWisePublishLocationCatalog(
  rooms: PublishLocationRoom[],
  wiseLocations: string[],
): WisePublishLocationCatalog {
  const exactWiseLocations = new Set(wiseLocations.map(normalizedExactLocation).filter(Boolean));
  const publishLocationByPhysicalRoom = new Map<string, string>();
  const missingLocationByPhysicalRoom = new Map<string, string>();
  const temporaryLocations: string[] = [];

  for (const room of rooms) {
    if (!room.active || room.category === "online_only") continue;

    const expectedLocation = wisePublishLocationName(room);
    const physicalRoom = normalizedPhysicalLocation(room.name);
    if (exactWiseLocations.has(expectedLocation)) {
      publishLocationByPhysicalRoom.set(physicalRoom, expectedLocation);
      temporaryLocations.push(expectedLocation);
    } else {
      missingLocationByPhysicalRoom.set(physicalRoom, expectedLocation);
    }
  }

  return {
    publishLocationByPhysicalRoom,
    missingLocationByPhysicalRoom,
    temporaryLocations,
  };
}

export function resolveWisePublishLocation(
  catalog: WisePublishLocationCatalog,
  assignedRoom: string,
): { ok: true; location: string } | { ok: false; reason: string } {
  const physicalRoom = normalizedPhysicalLocation(assignedRoom);
  const location = catalog.publishLocationByPhysicalRoom.get(physicalRoom);
  if (location) return { ok: true, location };

  const missingLocation = catalog.missingLocationByPhysicalRoom.get(physicalRoom);
  if (missingLocation) {
    return {
      ok: false,
      reason: `Verified Wise location ${missingLocation} is missing for assigned room ${assignedRoom}`,
    };
  }

  return {
    ok: false,
    reason: `Assigned room ${assignedRoom} is not an active publishable classroom`,
  };
}

export function isCurrentWisePublishLocation(
  currentWiseLocation: string | null | undefined,
  desiredPublishLocation: string,
): boolean {
  const current = normalizedExactLocation(currentWiseLocation);
  return Boolean(current) && current === normalizedExactLocation(desiredPublishLocation);
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
  const existingByName = new Map(existingRows.map((row) => [row.name, row]));
  const existingNames = new Set(existingByName.keys());
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

  for (const room of DEFAULT_CLASSROOM_ROOMS) {
    const existing = existingByName.get(room.name);
    if (!existing) continue;
    if (
      existing.hasTv !== room.hasTv ||
      existing.capacity !== room.capacity ||
      existing.category !== room.category ||
      existing.active !== room.active ||
      existing.sortOrder !== room.sortOrder
    ) {
      await db
        .update(schema.classroomRooms)
        .set({
          hasTv: room.hasTv,
          capacity: room.capacity,
          category: room.category,
          active: room.active,
          sortOrder: room.sortOrder,
          updatedAt: now,
        })
        .where(eq(schema.classroomRooms.name, room.name));
    }
  }

  for (const physicalRoom of TV_ROOM_NAME_BY_PHYSICAL_NAME.keys()) {
    const existing = existingByName.get(physicalRoom);
    if (!existing?.active) continue;
    await db
      .update(schema.classroomRooms)
      .set({ active: false, updatedAt: now })
      .where(eq(schema.classroomRooms.name, physicalRoom));
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

async function getActiveSnapshot(db: Database): Promise<{ id: string; createdAt: Date }> {
  const [activeSnapshot] = await db
    .select({ id: schema.snapshots.id, createdAt: schema.snapshots.createdAt })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);
  if (!activeSnapshot) throw new Error("No active Wise snapshot found");
  return activeSnapshot;
}

async function loadSnapshotById(db: Database, snapshotId: string): Promise<{ id: string; createdAt: Date } | null> {
  const [snapshot] = await db
    .select({ id: schema.snapshots.id, createdAt: schema.snapshots.createdAt })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.id, snapshotId))
    .limit(1);
  return snapshot ?? null;
}

async function loadLatestSuccessfulSyncForSnapshot(
  db: Database,
  snapshotId: string,
): Promise<{ finishedAt: Date | null } | null> {
  const [syncRun] = await db
    .select({ finishedAt: schema.syncRuns.finishedAt })
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.status, "success"),
        eq(schema.syncRuns.promotedSnapshotId, snapshotId),
      ),
    )
    .orderBy(desc(schema.syncRuns.finishedAt))
    .limit(1);
  return syncRun ?? null;
}

async function loadClassroomSnapshotMeta(
  db: Database,
  snapshotId?: string,
  now = new Date(),
): Promise<ClassroomSnapshotMeta> {
  const snapshot = snapshotId ? await loadSnapshotById(db, snapshotId) : await getActiveSnapshot(db);
  if (!snapshot) {
    return {
      snapshotId: snapshotId ?? null,
      latestSyncFinishedAt: null,
      staleAgeMs: null,
      fresh: false,
    };
  }

  const latestSync = await loadLatestSuccessfulSyncForSnapshot(db, snapshot.id);
  const finishedAt = latestSync?.finishedAt ?? null;
  const staleAgeMs = finishedAt ? Math.max(0, now.getTime() - finishedAt.getTime()) : null;
  return {
    snapshotId: snapshot.id,
    latestSyncFinishedAt: finishedAt?.toISOString() ?? null,
    staleAgeMs,
    fresh: staleAgeMs !== null && staleAgeMs <= CLASSROOM_ASSIGNMENT_FRESHNESS_MS,
  };
}

async function assertFreshClassroomSnapshot(db: Database, snapshotId: string): Promise<ClassroomSnapshotMeta> {
  const meta = await loadClassroomSnapshotMeta(db, snapshotId);
  if (!meta.fresh) {
    throw new StaleClassroomAssignmentSnapshotError(meta);
  }
  return meta;
}

export async function getFreshClassroomSnapshotForAssignment(db: Database): Promise<FreshClassroomSnapshot> {
  const activeSnapshot = await getActiveSnapshot(db);
  return {
    snapshotId: activeSnapshot.id,
    snapshotMeta: await assertFreshClassroomSnapshot(db, activeSnapshot.id),
  };
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
  if (!run) {
    const snapshotMeta = await loadClassroomSnapshotMeta(db);
    return { run: null, rows: [], rooms, snapshotMeta, liveRoomBlocks: [], roomConflictWarnings: [] };
  }
  const rows = await loadRowsForRun(db, run.id);
  const snapshotMeta = await loadClassroomSnapshotMeta(db, run.snapshotId);
  return { run, rows, rooms, snapshotMeta, liveRoomBlocks: [], roomConflictWarnings: [] };
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
  row: AssignmentResultRow | ReconciledAssignmentRow,
): typeof schema.classroomAssignmentRows.$inferInsert {
  const reconciled = row as Partial<ReconciledAssignmentRow>;
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
    sourceRowId: reconciled.sourceRowId ?? null,
    changeType: reconciled.changeType ?? "manual",
    assignmentFingerprint: reconciled.assignmentFingerprint ?? assignmentFingerprint(row),
    warnings: row.warnings,
    ruleTrace: row.ruleTrace,
    publishStatus: reconciled.publishStatus ?? "not_published",
    publishError: reconciled.publishError ?? null,
    publishedAt: reconciled.publishedAt ?? null,
  };
}

async function persistAssignmentRun(
  db: Database,
  date: string,
  snapshotId: string,
  forceReassign: boolean,
  createdBy: string | null,
  assignmentRows: Array<AssignmentResultRow | ReconciledAssignmentRow>,
  metadata: {
    sourceRunId?: string | null;
    automationBatchId?: string | null;
    reconciliationMode?: string | null;
    changeSummary?: Record<string, unknown>;
  } = {},
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
      sourceRunId: metadata.sourceRunId ?? null,
      automationBatchId: metadata.automationBatchId ?? null,
      reconciliationMode: metadata.reconciliationMode ?? null,
      changeSummary: metadata.changeSummary ?? {},
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
  const snapshotMeta = await assertFreshClassroomSnapshot(db, activeSnapshot.id);
  const rooms = await listClassroomRooms(db);
  const overrideBySessionId = await loadPreviousOverrides(db, date, input.forceReassign);
  const sessions = await loadAssignmentSessions(db, activeSnapshot.id, date);
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const liveBlocks = liveRoomBlocksForDate(
    await fetchAllFutureSessions(createWiseClientFromEnv(), instituteId),
    date,
  );
  const localWiseSessionIds = new Set(sessions.map((session) => session.wiseSessionId));
  const externalBlocks = externalLiveRoomBlocks(liveBlocks, localWiseSessionIds);
  const result = assignClassrooms(
    sessions,
    rooms.map(toEngineRoom),
    overrideBySessionId,
    { externalRoomBlocks: externalBlocks },
  );

  const run = await persistAssignmentRun(
    db,
    date,
    activeSnapshot.id,
    input.forceReassign,
    input.createdBy ?? null,
    result.rows,
  );

  const rows = await loadRowsForRun(db, run.id);
  return {
    run,
    rows,
    rooms,
    snapshotMeta,
    liveRoomBlocks: externalBlocks,
    roomConflictWarnings: buildRoomConflictWarnings(rows, externalBlocks, (assignedRoom) => assignedRoom),
  };
}

function classroomRowToPrevious(row: ClassroomRow): PreviousAssignmentRow {
  return {
    ...rowToSession(row),
    id: row.id,
    minCapacity: row.minCapacity,
    needsTv: row.needsTv,
    preferredRoom: row.preferredRoom,
    overrideRoom: row.overrideRoom,
    assignedRoom: row.assignedRoom,
    status: row.status,
    warnings: row.warnings,
    ruleTrace: row.ruleTrace,
    publishStatus: row.publishStatus,
    publishError: row.publishError,
    publishedAt: row.publishedAt,
    assignmentFingerprint: row.assignmentFingerprint,
    sourceRowId: row.sourceRowId,
    changeType: row.changeType,
  };
}

async function persistAutomationEvents(
  db: Database,
  input: {
    automationBatchId: string;
    assignmentRunId: string;
    assignmentDate: string;
    events: ClassroomAutomationEvent[];
    targetRows: Array<{ id: string; wiseSessionId: string }>;
  },
): Promise<void> {
  if (input.events.length === 0) return;
  const targetBySessionId = new Map(input.targetRows.map((row) => [row.wiseSessionId, row]));
  await db.insert(schema.classroomAutomationEvents).values(input.events.map((event) => ({
    automationBatchId: input.automationBatchId,
    assignmentRunId: input.assignmentRunId,
    assignmentDate: input.assignmentDate,
    eventType: event.type,
    wiseSessionId: event.wiseSessionId,
    sourceRowId: event.sourceRowId,
    targetRowId: targetBySessionId.get(event.wiseSessionId)?.id ?? null,
    message: event.message,
    metadata: event.metadata,
  })));
}

export async function runIncrementalClassroomAssignment(
  db: Database,
  input: {
    date: string;
    automationBatchId: string;
    createdBy?: string | null;
    liveSessions?: WiseSession[];
    snapshotId?: string;
    trustedSnapshotMeta?: ClassroomSnapshotMeta;
  },
): Promise<ClassroomAssignmentDetail & {
  events: ClassroomAutomationEvent[];
  changeSummary: Record<string, number>;
}> {
  const date = assertIsoDate(input.date);
  const snapshot = input.snapshotId ? await loadSnapshotById(db, input.snapshotId) : await getActiveSnapshot(db);
  if (!snapshot) throw new Error("Wise snapshot not found for classroom assignment");
  const snapshotMeta =
    input.trustedSnapshotMeta?.snapshotId === snapshot.id
      ? input.trustedSnapshotMeta
      : await assertFreshClassroomSnapshot(db, snapshot.id);
  const rooms = await listClassroomRooms(db);
  const previousRun = await loadLatestRunForDate(db, date);
  const previousRows = previousRun ? await loadRowsForRun(db, previousRun.id) : [];
  const sessions = await loadAssignmentSessions(db, snapshot.id, date);
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const liveSessions = input.liveSessions ?? await fetchAllFutureSessions(createWiseClientFromEnv(), instituteId);
  const liveBlocks = liveRoomBlocksForDate(liveSessions, date);
  const localWiseSessionIds = new Set(sessions.map((session) => session.wiseSessionId));
  const externalBlocks = externalLiveRoomBlocks(liveBlocks, localWiseSessionIds);
  const reconciliation = reconcileClassroomAssignments({
    sessions,
    previousRows: previousRows.map(classroomRowToPrevious),
    rooms: rooms.map(toEngineRoom),
    externalRoomBlocks: externalBlocks,
  });

  const run = await persistAssignmentRun(
    db,
    date,
    snapshot.id,
    false,
    input.createdBy ?? null,
    reconciliation.rows,
    {
      sourceRunId: previousRun?.id ?? null,
      automationBatchId: input.automationBatchId,
      reconciliationMode: "minimal_moves",
      changeSummary: reconciliation.summary,
    },
  );

  const rows = await loadRowsForRun(db, run.id);
  await persistAutomationEvents(db, {
    automationBatchId: input.automationBatchId,
    assignmentRunId: run.id,
    assignmentDate: date,
    events: reconciliation.events,
    targetRows: rows,
  });

  return {
    run,
    rows,
    rooms,
    snapshotMeta,
    liveRoomBlocks: externalBlocks,
    roomConflictWarnings: buildRoomConflictWarnings(rows, externalBlocks, (assignedRoom) => assignedRoom),
    events: reconciliation.events,
    changeSummary: reconciliation.summary,
  };
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
  const nextRun = freshRun ?? run;
  const snapshotMeta = await loadClassroomSnapshotMeta(db, nextRun.snapshotId);
  return { run: nextRun, rows, rooms, snapshotMeta, liveRoomBlocks: [], roomConflictWarnings: [] };
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
  currentWiseLocation: string | null,
): Promise<void> {
  await db
    .update(schema.classroomAssignmentRows)
    .set({
      currentWiseLocation,
      updatedAt: new Date(),
    })
    .where(eq(schema.classroomAssignmentRows.id, rowId));
}

async function refreshRowsCurrentWiseLocations(
  db: Database,
  rows: ClassroomRow[],
  liveBySessionId: Map<string, WiseSession>,
): Promise<void> {
  for (const row of rows) {
    const live = liveBySessionId.get(row.wiseSessionId);
    if (!live) continue;
    const liveLocation = live.location ? normalizedExactLocation(live.location) : null;
    if ((row.currentWiseLocation ?? null) === liveLocation) continue;
    row.currentWiseLocation = liveLocation;
    await updateRowCurrentWiseLocation(db, row.id, liveLocation);
  }
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
  input: { runId: string; createdBy?: string | null; targetRowIds?: string[] | null },
): Promise<PublishJobProgress> {
  const [run] = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(eq(schema.classroomAssignmentRuns.id, input.runId))
    .limit(1);
  if (!run) throw new Error("Assignment run not found");

  const rows = await loadRowsForRun(db, input.runId);
  const targetRowIdSet = input.targetRowIds ? new Set(input.targetRowIds) : null;
  const targetRows = targetRowIdSet ? rows.filter((row) => targetRowIdSet.has(row.id)) : rows;
  const eligibleCount = targetRows.filter((row) => isClassroomPublishEligible(row).eligible).length;
  const [job] = await db
    .insert(schema.classroomPublishJobs)
    .values({
      runId: input.runId,
      targetRowIds: input.targetRowIds ?? null,
      totalCount: targetRows.length,
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

async function loadWisePublishLocationCatalog(
  db: Database,
  client: WiseClient,
  instituteId: string,
): Promise<WisePublishLocationCatalog> {
  const [rooms, wiseLocations] = await Promise.all([
    listClassroomRooms(db),
    fetchInstituteLocations(client, instituteId),
  ]);
  if (wiseLocations.map(normalizedExactLocation).filter(Boolean).length === 0) {
    throw new Error("Wise location catalog is empty; refusing to publish locations");
  }
  return buildWisePublishLocationCatalog(rooms, wiseLocations);
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
  options: { liveSessions?: WiseSession[] } = {},
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
    const [run] = await db
      .select()
      .from(schema.classroomAssignmentRuns)
      .where(eq(schema.classroomAssignmentRuns.id, existingJob.runId))
      .limit(1);
    if (!run) throw new Error("Assignment run not found");

    const allRows = await loadRowsForRun(db, existingJob.runId);
    const targetRowIds = Array.isArray(existingJob.targetRowIds) ? new Set(existingJob.targetRowIds) : null;
    const rows = targetRowIds ? allRows.filter((row) => targetRowIds.has(row.id)) : allRows;
    const liveSessions = options.liveSessions ?? await fetchAllFutureSessions(client, instituteId);
    const liveBySessionId = new Map(liveSessions.map((session) => [session._id, session]));
    await refreshRowsCurrentWiseLocations(db, allRows, liveBySessionId);

    const localWiseSessionIds = new Set(allRows.map((row) => row.wiseSessionId));
    const externalBlocks = externalLiveRoomBlocks(
      liveRoomBlocksForDate(liveSessions, run.assignmentDate),
      localWiseSessionIds,
    );

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

    let publishCatalog: WisePublishLocationCatalog | null = null;
    let catalogError: string | null = null;
    if (eligibleRows.length > 0) {
      try {
        publishCatalog = await loadWisePublishLocationCatalog(db, client, instituteId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Wise location catalog unavailable";
        catalogError = `Wise location catalog unavailable: ${message}`;
      }
    }

    const temporaryLocations = publishCatalog?.temporaryLocations ?? [];
    const temporaryMovedRowIds = new Set<string>();

    const pendingRows = new Map<string, ClassroomRow>();
    const failedRows = new Map<string, ClassroomRow>();
    const publishLocationByRowId = new Map<string, string>();
    for (const row of eligibleRows) {
      if (catalogError) {
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: catalogError,
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        failedRows.set(row.id, row);
        continue;
      }

      const resolvedLocation = resolveWisePublishLocation(publishCatalog!, row.assignedRoom);
      if (!resolvedLocation.ok) {
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: resolvedLocation.reason,
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        failedRows.set(row.id, row);
        continue;
      }

      publishLocationByRowId.set(row.id, resolvedLocation.location);
      if (!liveBySessionId.has(row.wiseSessionId)) {
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: `Live Wise session ${row.wiseSessionId} was not found; refusing to publish a stale assignment`,
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        failedRows.set(row.id, row);
        continue;
      }

      const externalBlocker = findExternalRoomBlocker(row, resolvedLocation.location, externalBlocks);
      if (externalBlocker) {
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: `Live Wise room conflict: ${resolvedLocation.location} overlaps ${liveRoomBlockLabel(externalBlocker)}`,
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        failedRows.set(row.id, row);
        continue;
      }

      const fixedLocalBlockers = targetRowIds
        ? findPublishRoomBlockers(row, allRows).filter((blocker) => !targetRowIds.has(blocker.id))
        : [];
      if (fixedLocalBlockers.length > 0) {
        const blockerNames = fixedLocalBlockers.map((blocker) => blocker.tutorDisplayName).join(", ");
        const result = await publishRowResult(db, jobId, row, {
          status: "failed",
          error: `Wise room still occupied by unchanged local assignment: ${blockerNames}`,
        });
        summary.attempted += result.attempted;
        summary.failed += result.failed;
        failedRows.set(row.id, row);
        continue;
      }

      if (isCurrentWisePublishLocation(row.currentWiseLocation, resolvedLocation.location)) {
        const result = await publishRowResult(db, jobId, row, {
          status: "success",
          publishedLocation: resolvedLocation.location,
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
          allRows,
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
        const publishLocation = publishLocationByRowId.get(row.id);
        if (!publishLocation) {
          const result = await publishRowResult(db, jobId, row, {
            status: "failed",
            error: `No verified Wise publish location for assigned room ${row.assignedRoom}`,
          });
          summary.attempted += result.attempted;
          summary.failed += result.failed;
          failedRows.set(row.id, row);
          pendingRows.delete(row.id);
          return;
        }

        const updateError = await updateWiseLocationOnly(
          (classId, sessionId, location) => updateSessionLocation(client, classId, sessionId, location),
          row,
          publishLocation,
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

        const result = await publishRowResult(db, jobId, row, {
          status: "success",
          publishedLocation: publishLocation,
        });
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
  options: { targetRowIds?: string[] | null; liveSessions?: WiseSession[] } = {},
): Promise<{ detail: ClassroomAssignmentDetail; summary: PublishSummary }> {
  const progress = await createClassroomPublishJob(db, {
    runId,
    targetRowIds: options.targetRowIds,
  });
  const result = await runClassroomPublishJob(db, progress.jobId, client, {
    liveSessions: options.liveSessions,
  });
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

type AutomationPublishTargetRow = Pick<
  ClassroomRow,
  | "id"
  | "tutorDisplayName"
  | "currentWiseLocation"
  | "assignedRoom"
  | "startMinute"
  | "endMinute"
  | "status"
  | "sessionType"
  | "wiseClassId"
  | "wiseSessionId"
  | "warnings"
>;

export function expandAutomationPublishTargetRowIds(
  rows: AutomationPublishTargetRow[],
  initialTargetRowIds: string[],
): string[] {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const targetRowIds = new Set<string>();
  const queue: AutomationPublishTargetRow[] = [];

  for (const rowId of initialTargetRowIds) {
    const row = rowById.get(rowId);
    if (!row || targetRowIds.has(row.id)) continue;
    targetRowIds.add(row.id);
    queue.push(row);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const row = queue[index];
    const blockers = findPublishRoomBlockers(row, rows);
    for (const blocker of blockers) {
      const blockerRow = rowById.get(blocker.id);
      if (!blockerRow || targetRowIds.has(blockerRow.id)) continue;
      if (!isClassroomPublishEligible(blockerRow).eligible) continue;
      targetRowIds.add(blockerRow.id);
      queue.push(blockerRow);
    }
  }

  return [...targetRowIds];
}

export async function selectAutomationPublishTargetRowIds(
  db: Database,
  rows: ClassroomRow[],
  liveSessions: WiseSession[],
  client = createWiseClientFromEnv(),
): Promise<string[]> {
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const liveBySessionId = new Map(liveSessions.map((session) => [session._id, session]));
  let publishCatalog: WisePublishLocationCatalog | null = null;

  try {
    publishCatalog = await loadWisePublishLocationCatalog(db, client, instituteId);
  } catch {
    publishCatalog = null;
  }

  const targets: string[] = [];
  for (const row of rows) {
    if (!isClassroomPublishEligible(row).eligible) continue;
    if (row.changeType !== "carried" || row.publishStatus !== "success") {
      targets.push(row.id);
      continue;
    }

    if (!publishCatalog) continue;
    const resolved = resolveWisePublishLocation(publishCatalog, row.assignedRoom);
    if (!resolved.ok) continue;
    const liveLocation = liveBySessionId.get(row.wiseSessionId)?.location ?? row.currentWiseLocation;
    if (!isCurrentWisePublishLocation(liveLocation, resolved.location)) {
      targets.push(row.id);
    }
  }

  return expandAutomationPublishTargetRowIds(rows, targets);
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
  const snapshotMeta = await loadClassroomSnapshotMeta(db, run.snapshotId);
  return { run, rows, rooms, snapshotMeta, liveRoomBlocks: [], roomConflictWarnings: [] };
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
