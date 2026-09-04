import "server-only";

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

import { DEFAULT_CLASSROOM_ROOMS } from "@/lib/classrooms/rooms";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import { aggregateFootTraffic } from "./aggregate";
import {
  bangkokTimeLabel,
  bangkokWeekday,
  defaultFootTrafficRange,
  latestCompletedBangkokDate,
  mondayWeekStart,
  validateFootTrafficRange,
} from "./dates";
import type {
  FootTrafficDashboardPayload,
  FootTrafficExclusionReason,
  FootTrafficFilters,
  FootTrafficMeta,
  FootTrafficReportSnapshot,
  FootTrafficVisitDetail,
} from "./types";

const REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SLOW_READ_WARNING_MS = 2_000;

export interface FootTrafficDashboardReadTimings {
  metadataMs: number;
  databaseMs: number;
  aggregationMs: number;
  totalMs: number;
  sessionRows: number;
  visitRows: number;
}

export interface FootTrafficDashboardRead {
  payload: FootTrafficDashboardPayload;
  timings: FootTrafficDashboardReadTimings;
}

export interface FootTrafficVisitDetailRead {
  visits: FootTrafficVisitDetail[];
  timings: {
    databaseMs: number;
    transformMs: number;
    totalMs: number;
    visitRows: number;
  };
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function splitTokens(values: string[]): string[] {
  return [...new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
}

export function parseFootTrafficFilters(
  searchParams: URLSearchParams,
  now = new Date(),
): FootTrafficFilters {
  const defaults = defaultFootTrafficRange(now);
  const startDate = searchParams.get("startDate") ?? defaults.startDate;
  const endDate = searchParams.get("endDate") ?? defaults.endDate;
  validateFootTrafficRange(startDate, endDate);
  const rooms = splitTokens([
    ...searchParams.getAll("room"),
    ...searchParams.getAll("rooms"),
  ]);
  const weekdayTokens = splitTokens([
    ...searchParams.getAll("weekday"),
    ...searchParams.getAll("weekdays"),
  ]);
  const weekdays = weekdayTokens.map((value) => Number(value));
  if (weekdays.some((value) => !Number.isInteger(value) || value < 0 || value > 6)) {
    throw new Error("Invalid weekdays. Expected comma-separated integers from 0 through 6.");
  }
  return {
    startDate,
    endDate,
    ...(rooms.length > 0 ? { rooms } : {}),
    ...(weekdays.length > 0 ? { weekdays: [...new Set(weekdays)].sort((a, b) => a - b) } : {}),
  };
}

export function normalizeFootTrafficFilters(
  input: Partial<FootTrafficFilters> | null | undefined,
  now = new Date(),
): FootTrafficFilters {
  const defaults = defaultFootTrafficRange(now);
  const startDate = input?.startDate ?? defaults.startDate;
  const endDate = input?.endDate ?? defaults.endDate;
  validateFootTrafficRange(startDate, endDate);
  const rooms = [...new Set((input?.rooms ?? []).map((value) => String(value).trim()).filter(Boolean))];
  const weekdays = [...new Set(input?.weekdays ?? [])];
  if (weekdays.some((value) => !Number.isInteger(value) || value < 0 || value > 6)) {
    throw new Error("Invalid weekdays. Expected integers from 0 through 6.");
  }
  return {
    startDate,
    endDate,
    ...(rooms.length > 0 ? { rooms } : {}),
    ...(weekdays.length > 0 ? { weekdays: weekdays.sort((a, b) => a - b) } : {}),
  };
}

async function availableRooms(db: Database): Promise<string[]> {
  const rows = await db.select({
    name: schema.classroomRooms.name,
    category: schema.classroomRooms.category,
    active: schema.classroomRooms.active,
  }).from(schema.classroomRooms);
  const definitions = rows.length > 0 ? rows : DEFAULT_CLASSROOM_ROOMS;
  return definitions
    .filter((room) => room.active && room.category !== "online_only")
    .map((room) => room.name)
    .sort((left, right) => left.localeCompare(right));
}

async function coverage(db: Database): Promise<{
  startDate: string | null;
  endDate: string | null;
  finishedAt: Date | string | null;
  runId: string | null;
}> {
  const [rangeRows, latestRows] = await Promise.all([
    db.select({
      startDate: sql<string | null>`min(${schema.onsiteFootTrafficSyncRuns.requestedStartDate})`,
      endDate: sql<string | null>`max(${schema.onsiteFootTrafficSyncRuns.requestedEndDate})`,
      finishedAt: sql<Date | null>`max(${schema.onsiteFootTrafficSyncRuns.finishedAt})`,
    }).from(schema.onsiteFootTrafficSyncRuns)
      .where(eq(schema.onsiteFootTrafficSyncRuns.status, "success")),
    db.select({ id: schema.onsiteFootTrafficSyncRuns.id })
      .from(schema.onsiteFootTrafficSyncRuns)
      .where(eq(schema.onsiteFootTrafficSyncRuns.status, "success"))
      .orderBy(desc(schema.onsiteFootTrafficSyncRuns.finishedAt))
      .limit(1),
  ]);
  const [range] = rangeRows;
  const [latest] = latestRows;
  return {
    startDate: range?.startDate ?? null,
    endDate: range?.endDate ?? null,
    finishedAt: range?.finishedAt ?? null,
    runId: latest?.id ?? null,
  };
}

function logDashboardRead(
  filters: FootTrafficFilters,
  timings: FootTrafficDashboardReadTimings,
): void {
  if (process.env.NODE_ENV === "test") return;
  const log = {
    level: timings.totalMs > SLOW_READ_WARNING_MS ? "warn" : "info",
    event: "onsite_foot_traffic_dashboard_read",
    startDate: filters.startDate,
    endDate: filters.endDate,
    roomFilterCount: filters.rooms?.length ?? 0,
    weekdayFilterCount: filters.weekdays?.length ?? 0,
    ...timings,
  };
  const serialized = JSON.stringify(log);
  if (timings.totalMs > SLOW_READ_WARNING_MS) {
    console.warn(serialized);
  } else {
    console.info(serialized);
  }
}

export async function readFootTrafficDashboard(
  db: Database,
  rawFilters: FootTrafficFilters,
  now = new Date(),
): Promise<FootTrafficDashboardRead> {
  const totalStartedAt = performance.now();
  const filters = normalizeFootTrafficFilters(rawFilters, now);

  const metadataStartedAt = performance.now();
  const [roomNames, sourceCoverage] = await Promise.all([
    availableRooms(db),
    coverage(db),
  ]);
  const metadataMs = elapsedMs(metadataStartedAt);
  const invalidRooms = (filters.rooms ?? []).filter((room) => !roomNames.includes(room));
  if (invalidRooms.length > 0) throw new Error(`Invalid rooms: ${invalidRooms.join(", ")}`);

  const databaseStartedAt = performance.now();
  const [sessionRows, visitRows] = await Promise.all([
    db.select({
      wiseSessionId: schema.onsiteFootTrafficSessions.wiseSessionId,
      attendanceDate: schema.onsiteFootTrafficSessions.attendanceDate,
      roomName: schema.onsiteFootTrafficSessions.roomName,
      missingAttendanceEvidenceCount: schema.onsiteFootTrafficSessions.missingAttendanceEvidenceCount,
      isCountedOnsite: schema.onsiteFootTrafficSessions.isCountedOnsite,
      exclusionReason: schema.onsiteFootTrafficSessions.exclusionReason,
    }).from(schema.onsiteFootTrafficSessions).where(and(
      gte(schema.onsiteFootTrafficSessions.attendanceDate, filters.startDate),
      lte(schema.onsiteFootTrafficSessions.attendanceDate, filters.endDate),
    )),
    db.select({
      wiseSessionId: schema.onsiteFootTrafficVisits.wiseSessionId,
      studentFingerprint: schema.onsiteFootTrafficVisits.studentFingerprint,
      attendanceDate: schema.onsiteFootTrafficVisits.attendanceDate,
    }).from(schema.onsiteFootTrafficVisits).where(and(
      gte(schema.onsiteFootTrafficVisits.attendanceDate, filters.startDate),
      lte(schema.onsiteFootTrafficVisits.attendanceDate, filters.endDate),
    )),
  ]);
  const databaseMs = elapsedMs(databaseStartedAt);

  const aggregationStartedAt = performance.now();
  const payload = aggregateFootTraffic({
    sessions: sessionRows.map((row) => ({
      ...row,
      exclusionReason: row.exclusionReason as FootTrafficExclusionReason | null,
    })),
    visits: visitRows,
    filters,
    latestCompletedDate: latestCompletedBangkokDate(now),
    coverageStartDate: sourceCoverage.startDate,
    coverageEndDate: sourceCoverage.endDate,
    dataAsOf: sourceCoverage.endDate,
    lastSuccessfulSyncAt: sourceCoverage.finishedAt
      ? new Date(sourceCoverage.finishedAt).toISOString()
      : null,
    sourceSyncRunId: sourceCoverage.runId,
    availableRooms: roomNames,
  });
  const aggregationMs = elapsedMs(aggregationStartedAt);
  const timings = {
    metadataMs,
    databaseMs,
    aggregationMs,
    totalMs: elapsedMs(totalStartedAt),
    sessionRows: sessionRows.length,
    visitRows: visitRows.length,
  };
  logDashboardRead(filters, timings);
  return { payload, timings };
}

export async function getFootTrafficDashboard(
  db: Database,
  rawFilters: FootTrafficFilters,
  now = new Date(),
): Promise<FootTrafficDashboardPayload> {
  return (await readFootTrafficDashboard(db, rawFilters, now)).payload;
}

export async function readFootTrafficVisitDetails(
  db: Database,
  meta: FootTrafficMeta,
): Promise<FootTrafficVisitDetailRead> {
  const totalStartedAt = performance.now();
  if (!meta.coverageStartDate || !meta.coverageEndDate || meta.effectiveStartDate > meta.effectiveEndDate) {
    return {
      visits: [],
      timings: { databaseMs: 0, transformMs: 0, totalMs: elapsedMs(totalStartedAt), visitRows: 0 },
    };
  }

  const databaseStartedAt = performance.now();
  const rows = await db.select({
    attendanceDate: schema.onsiteFootTrafficVisits.attendanceDate,
    scheduledStartAt: schema.onsiteFootTrafficSessions.scheduledStartAt,
    studentFingerprint: schema.onsiteFootTrafficVisits.studentFingerprint,
    wiseSessionId: schema.onsiteFootTrafficVisits.wiseSessionId,
    roomName: schema.onsiteFootTrafficSessions.roomName,
    subject: schema.onsiteFootTrafficSessions.subject,
    tutorName: schema.onsiteFootTrafficSessions.tutorName,
    consumedCredits: schema.onsiteFootTrafficVisits.consumedCredits,
  }).from(schema.onsiteFootTrafficVisits)
    .innerJoin(
      schema.onsiteFootTrafficSessions,
      eq(schema.onsiteFootTrafficVisits.wiseSessionId, schema.onsiteFootTrafficSessions.wiseSessionId),
    )
    .where(and(
      gte(schema.onsiteFootTrafficVisits.attendanceDate, meta.effectiveStartDate),
      lte(schema.onsiteFootTrafficVisits.attendanceDate, meta.effectiveEndDate),
      gte(schema.onsiteFootTrafficSessions.attendanceDate, meta.effectiveStartDate),
      lte(schema.onsiteFootTrafficSessions.attendanceDate, meta.effectiveEndDate),
    ));
  const databaseMs = elapsedMs(databaseStartedAt);

  const transformStartedAt = performance.now();
  const selectedRooms = new Set(meta.rooms);
  const selectedWeekdays = new Set(meta.weekdays);
  const weekdayByDate = new Map<string, number>();
  const weekStartByDate = new Map<string, string>();
  const visits: FootTrafficVisitDetail[] = [];
  for (const row of rows) {
    if (selectedRooms.size > 0 && (!row.roomName || !selectedRooms.has(row.roomName))) continue;
    let weekday = weekdayByDate.get(row.attendanceDate);
    if (weekday === undefined) {
      weekday = bangkokWeekday(row.attendanceDate);
      weekdayByDate.set(row.attendanceDate, weekday);
    }
    if (selectedWeekdays.size > 0 && !selectedWeekdays.has(weekday)) continue;
    let weekStart = weekStartByDate.get(row.attendanceDate);
    if (!weekStart) {
      weekStart = mondayWeekStart(row.attendanceDate);
      weekStartByDate.set(row.attendanceDate, weekStart);
    }
    visits.push({
      attendanceDate: row.attendanceDate,
      startTime: bangkokTimeLabel(row.scheduledStartAt),
      weekStart,
      month: row.attendanceDate.slice(0, 7),
      studentFingerprint: row.studentFingerprint,
      wiseSessionId: row.wiseSessionId,
      room: row.roomName ?? "Unknown",
      subject: row.subject,
      tutor: row.tutorName,
      consumedCredits: row.consumedCredits,
    });
  }
  visits.sort((left, right) =>
    left.attendanceDate.localeCompare(right.attendanceDate) ||
    left.startTime.localeCompare(right.startTime) ||
    left.wiseSessionId.localeCompare(right.wiseSessionId));
  const transformMs = elapsedMs(transformStartedAt);
  const timings = {
    databaseMs,
    transformMs,
    totalMs: elapsedMs(totalStartedAt),
    visitRows: visits.length,
  };
  if (process.env.NODE_ENV !== "test") {
    console.info(JSON.stringify({
      level: "info",
      event: "onsite_foot_traffic_visit_export_read",
      startDate: meta.effectiveStartDate,
      endDate: meta.effectiveEndDate,
      roomFilterCount: meta.rooms.length,
      weekdayFilterCount: meta.weekdays.length,
      ...timings,
    }));
  }
  return { visits, timings };
}

export async function createFootTrafficReportSnapshot(input: {
  db: Database;
  filters: FootTrafficFilters;
  createdByEmail: string;
  now?: Date;
}): Promise<FootTrafficReportSnapshot> {
  const now = input.now ?? new Date();
  const payload = await getFootTrafficDashboard(input.db, input.filters, now);
  const expiresAt = new Date(now.getTime() + REPORT_TTL_MS);
  const [row] = await input.db.insert(schema.onsiteFootTrafficReportSnapshots).values({
    createdByEmail: input.createdByEmail,
    startDate: payload.meta.requestedStartDate,
    endDate: payload.meta.requestedEndDate,
    filters: { ...input.filters } as Record<string, unknown>,
    payload: payload as unknown as Record<string, unknown>,
    sourceSyncRunId: payload.meta.sourceSyncRunId,
    createdAt: now,
    expiresAt,
  }).returning({ id: schema.onsiteFootTrafficReportSnapshots.id });
  return {
    id: row.id,
    createdByEmail: input.createdByEmail,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    payload,
  };
}

export async function getFootTrafficReportSnapshot(
  db: Database,
  id: string,
  now = new Date(),
): Promise<FootTrafficReportSnapshot | null> {
  const [row] = await db.select().from(schema.onsiteFootTrafficReportSnapshots)
    .where(and(
      eq(schema.onsiteFootTrafficReportSnapshots.id, id),
      gte(schema.onsiteFootTrafficReportSnapshots.expiresAt, now),
    ))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    createdByEmail: row.createdByEmail,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    payload: row.payload as unknown as FootTrafficReportSnapshot["payload"],
  };
}
