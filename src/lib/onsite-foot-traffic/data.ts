import "server-only";

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

import { DEFAULT_CLASSROOM_ROOMS } from "@/lib/classrooms/rooms";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import { aggregateFootTraffic } from "./aggregate";
import { defaultFootTrafficRange, latestCompletedBangkokDate, validateFootTrafficRange } from "./dates";
import type {
  FootTrafficDashboardResult,
  FootTrafficExclusionReason,
  FootTrafficFilters,
  FootTrafficReportSnapshot,
} from "./types";

const REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

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
  const [range] = await db.select({
    startDate: sql<string | null>`min(${schema.onsiteFootTrafficSyncRuns.requestedStartDate})`,
    endDate: sql<string | null>`max(${schema.onsiteFootTrafficSyncRuns.requestedEndDate})`,
    finishedAt: sql<Date | null>`max(${schema.onsiteFootTrafficSyncRuns.finishedAt})`,
  }).from(schema.onsiteFootTrafficSyncRuns)
    .where(eq(schema.onsiteFootTrafficSyncRuns.status, "success"));
  const [latest] = await db.select({ id: schema.onsiteFootTrafficSyncRuns.id })
    .from(schema.onsiteFootTrafficSyncRuns)
    .where(eq(schema.onsiteFootTrafficSyncRuns.status, "success"))
    .orderBy(desc(schema.onsiteFootTrafficSyncRuns.finishedAt))
    .limit(1);
  return {
    startDate: range?.startDate ?? null,
    endDate: range?.endDate ?? null,
    finishedAt: range?.finishedAt ?? null,
    runId: latest?.id ?? null,
  };
}

export async function getFootTrafficDashboard(
  db: Database,
  rawFilters: FootTrafficFilters,
  now = new Date(),
): Promise<FootTrafficDashboardResult> {
  const filters = normalizeFootTrafficFilters(rawFilters, now);
  const [sessionRows, visitRows, roomNames, sourceCoverage] = await Promise.all([
    db.select().from(schema.onsiteFootTrafficSessions).where(and(
      gte(schema.onsiteFootTrafficSessions.attendanceDate, filters.startDate),
      lte(schema.onsiteFootTrafficSessions.attendanceDate, filters.endDate),
    )),
    db.select({
      wiseSessionId: schema.onsiteFootTrafficVisits.wiseSessionId,
      participantKey: schema.onsiteFootTrafficVisits.participantKey,
      studentFingerprint: schema.onsiteFootTrafficVisits.studentFingerprint,
      attendanceDate: schema.onsiteFootTrafficVisits.attendanceDate,
      consumedCredits: schema.onsiteFootTrafficVisits.consumedCredits,
    }).from(schema.onsiteFootTrafficVisits).where(and(
      gte(schema.onsiteFootTrafficVisits.attendanceDate, filters.startDate),
      lte(schema.onsiteFootTrafficVisits.attendanceDate, filters.endDate),
    )),
    availableRooms(db),
    coverage(db),
  ]);
  const invalidRooms = (filters.rooms ?? []).filter((room) => !roomNames.includes(room));
  if (invalidRooms.length > 0) throw new Error(`Invalid rooms: ${invalidRooms.join(", ")}`);

  return aggregateFootTraffic({
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
}

export async function createFootTrafficReportSnapshot(input: {
  db: Database;
  filters: FootTrafficFilters;
  createdByEmail: string;
  now?: Date;
}): Promise<FootTrafficReportSnapshot> {
  const now = input.now ?? new Date();
  const result = await getFootTrafficDashboard(input.db, input.filters, now);
  const payload = {
    meta: result.meta,
    summary: result.summary,
    weekly: result.weekly,
    monthly: result.monthly,
    byWeekday: result.byWeekday,
    byRoom: result.byRoom,
    dataQuality: result.dataQuality,
  };
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
