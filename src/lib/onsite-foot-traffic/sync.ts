import "server-only";

import { and, desc, eq, gte, inArray, lt, lte, or } from "drizzle-orm";

import { DEFAULT_CLASSROOM_ROOMS } from "@/lib/classrooms/rooms";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createWiseClient, type WiseClient } from "@/lib/wise/client";
import { fetchWisePastSessionsByBangkokDate } from "@/lib/wise/fetchers";
import type { WiseSession } from "@/lib/wise/types";

import { addBangkokDays, assertFootTrafficDate, latestCompletedBangkokDate, validateFootTrafficRange } from "./dates";
import { classifyWisePastSession, type FootTrafficRoomDefinition } from "./model";
import { withOnsiteFootTrafficTransaction } from "./transaction";
import { FOOT_TRAFFIC_HISTORY_START, type FootTrafficSyncResult } from "./types";

const INSERT_CHUNK_SIZE = 400;
const FETCH_WINDOW_DAYS = 85;
const ROLLING_RECONCILIATION_DAYS = 35;
const STALE_RUNNING_MS = 20 * 60 * 1000;
const DEFAULT_INSTITUTE_ID = "696e1f4d90102225641cc413";

export interface RunFootTrafficSyncInput {
  mode?: "rolling" | "backfill";
  startDate?: string;
  endDate?: string;
  triggerType?: "cron" | "manual" | "cli";
  actorEmail?: string | null;
  now?: Date;
  client?: WiseClient;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "23505";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

async function failStaleRuns(db: Database, now: Date): Promise<void> {
  await db.update(schema.onsiteFootTrafficSyncRuns).set({
    status: "failed",
    finishedAt: now,
    errorSummary: "Foot-traffic sync marked failed after exceeding the 20-minute single-flight lease.",
  }).where(and(
    eq(schema.onsiteFootTrafficSyncRuns.status, "running"),
    lt(schema.onsiteFootTrafficSyncRuns.startedAt, new Date(now.getTime() - STALE_RUNNING_MS)),
  ));
}

async function currentRunningRun(db: Database): Promise<{ id: string; startedAt: Date } | null> {
  const [row] = await db.select({
    id: schema.onsiteFootTrafficSyncRuns.id,
    startedAt: schema.onsiteFootTrafficSyncRuns.startedAt,
  }).from(schema.onsiteFootTrafficSyncRuns)
    .where(eq(schema.onsiteFootTrafficSyncRuns.status, "running"))
    .orderBy(desc(schema.onsiteFootTrafficSyncRuns.startedAt))
    .limit(1);
  return row ?? null;
}

async function hasSuccessfulInitialBackfill(db: Database): Promise<boolean> {
  const rows = await db.select({
    requestedEndDate: schema.onsiteFootTrafficSyncRuns.requestedEndDate,
    startedAt: schema.onsiteFootTrafficSyncRuns.startedAt,
  })
    .from(schema.onsiteFootTrafficSyncRuns)
    .where(and(
      eq(schema.onsiteFootTrafficSyncRuns.status, "success"),
      eq(schema.onsiteFootTrafficSyncRuns.mode, "backfill"),
      lte(schema.onsiteFootTrafficSyncRuns.requestedStartDate, FOOT_TRAFFIC_HISTORY_START),
    ));
  return rows.some((row) =>
    row.requestedEndDate >= latestCompletedBangkokDate(new Date(row.startedAt))
  );
}

async function latestSuccessfulCoverageEnd(db: Database): Promise<string | null> {
  const [row] = await db.select({
    requestedEndDate: schema.onsiteFootTrafficSyncRuns.requestedEndDate,
  }).from(schema.onsiteFootTrafficSyncRuns)
    .where(eq(schema.onsiteFootTrafficSyncRuns.status, "success"))
    .orderBy(desc(schema.onsiteFootTrafficSyncRuns.requestedEndDate))
    .limit(1);
  return row?.requestedEndDate ?? null;
}

async function activeRooms(db: Database): Promise<FootTrafficRoomDefinition[]> {
  const rows = await db.select({
    name: schema.classroomRooms.name,
    category: schema.classroomRooms.category,
    active: schema.classroomRooms.active,
  }).from(schema.classroomRooms);
  return rows.length > 0
    ? rows
    : DEFAULT_CLASSROOM_ROOMS.map(({ name, category, active }) => ({ name, category, active }));
}

async function fetchRange(
  client: WiseClient,
  instituteId: string,
  startDate: string,
  endDate: string,
): Promise<WiseSession[]> {
  const byId = new Map<string, WiseSession>();
  for (let windowStart = startDate; windowStart <= endDate; windowStart = addBangkokDays(windowStart, FETCH_WINDOW_DAYS)) {
    const candidateEnd = addBangkokDays(windowStart, FETCH_WINDOW_DAYS - 1);
    const windowEnd = candidateEnd < endDate ? candidateEnd : endDate;
    const rows = await fetchWisePastSessionsByBangkokDate(client, instituteId, windowStart, windowEnd, 50);
    for (const row of rows) {
      if (row._id) byId.set(row._id, row);
    }
  }
  return [...byId.values()];
}

async function acquireRun(input: {
  db: Database;
  startDate: string;
  endDate: string;
  mode: "rolling" | "backfill";
  triggerType: string;
  actorEmail: string | null;
  now: Date;
}): Promise<{ runId: string | null; runningRunId: string | null }> {
  await failStaleRuns(input.db, input.now);
  const running = await currentRunningRun(input.db);
  if (running) return { runId: null, runningRunId: running.id };
  try {
    const [row] = await input.db.insert(schema.onsiteFootTrafficSyncRuns).values({
      status: "running",
      triggerType: input.triggerType,
      actorEmail: input.actorEmail,
      mode: input.mode,
      requestedStartDate: input.startDate,
      requestedEndDate: input.endDate,
      startedAt: input.now,
    }).returning({ id: schema.onsiteFootTrafficSyncRuns.id });
    return { runId: row.id, runningRunId: null };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await currentRunningRun(input.db);
    if (!raced) throw error;
    return { runId: null, runningRunId: raced.id };
  }
}

async function insertChunks<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
    await insert(rows.slice(index, index + INSERT_CHUNK_SIZE));
  }
}

export async function runOnsiteFootTrafficSync(
  db: Database,
  input: RunFootTrafficSyncInput = {},
): Promise<FootTrafficSyncResult> {
  const now = input.now ?? new Date();
  const latestCompleted = latestCompletedBangkokDate(now);
  const initial = !(await hasSuccessfulInitialBackfill(db));
  const mode = input.mode ?? (initial ? "backfill" : "rolling");
  let defaultStart = FOOT_TRAFFIC_HISTORY_START;
  if (mode === "rolling") {
    const rollingStart = addBangkokDays(latestCompleted, -(ROLLING_RECONCILIATION_DAYS - 1));
    const coverageEnd = await latestSuccessfulCoverageEnd(db);
    const firstUncoveredDate = coverageEnd ? addBangkokDays(coverageEnd, 1) : FOOT_TRAFFIC_HISTORY_START;
    defaultStart = firstUncoveredDate < rollingStart ? firstUncoveredDate : rollingStart;
  }
  const startDate = assertFootTrafficDate(input.startDate ?? defaultStart, "startDate");
  const endDate = assertFootTrafficDate(input.endDate ?? latestCompleted, "endDate");
  validateFootTrafficRange(startDate, endDate, { maxDays: null });
  if (endDate > latestCompleted) {
    throw new Error(`Invalid endDate. Syncs may only include completed Bangkok days through ${latestCompleted}.`);
  }

  const guard = await acquireRun({
    db,
    startDate,
    endDate,
    mode,
    triggerType: input.triggerType ?? "cron",
    actorEmail: input.actorEmail ?? null,
    now,
  });
  if (!guard.runId) {
    return {
      ok: true,
      skipped: true,
      runId: guard.runningRunId,
      mode,
      startDate,
      endDate,
      fetchedSessionCount: 0,
      storedSessionCount: 0,
      visitCount: 0,
      unknownRoomCount: 0,
      missingAttendanceEvidenceCount: 0,
      missingStableIdCount: 0,
    };
  }

  const runId = guard.runId;
  try {
    const pseudonymSecret = process.env.FOOT_TRAFFIC_PSEUDONYM_SECRET?.trim();
    if (!pseudonymSecret) throw new Error("FOOT_TRAFFIC_PSEUDONYM_SECRET is not configured");
    if (pseudonymSecret.length < 32) throw new Error("FOOT_TRAFFIC_PSEUDONYM_SECRET must be at least 32 characters");
    if (!process.env.WISE_USER_ID || !process.env.WISE_API_KEY) {
      throw new Error("WISE_USER_ID and WISE_API_KEY are required for the foot-traffic sync");
    }
    const instituteId = process.env.WISE_INSTITUTE_ID ?? DEFAULT_INSTITUTE_ID;
    const [wiseSessions, rooms] = await Promise.all([
      fetchRange(input.client ?? createWiseClient(), instituteId, startDate, endDate),
      activeRooms(db),
    ]);
    const classified = wiseSessions
      .map((session) => classifyWisePastSession({ session, rooms, pseudonymSecret, now }))
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .filter((value) => value.session.attendanceDate >= startDate && value.session.attendanceDate <= endDate);
    const sessionRows: Array<typeof schema.onsiteFootTrafficSessions.$inferInsert> = classified.map(({ session }) => ({
      ...session,
      scheduledStartAt: new Date(session.scheduledStartAt),
      scheduledEndAt: new Date(session.scheduledEndAt),
      lastSyncRunId: runId,
      syncedAt: now,
    }));
    const visitRows = classified.flatMap(({ visits }) => visits);
    const fetchedIds = sessionRows.map((row) => row.wiseSessionId);
    const unknownRoomCount = sessionRows.filter((row) => row.exclusionReason === "unknown_room").length;
    const missingAttendanceEvidenceCount = sessionRows.reduce(
      (sum, row) => sum + (row.missingAttendanceEvidenceCount ?? 0),
      0,
    );
    const missingStableIdCount = sessionRows.reduce((sum, row) => sum + (row.missingStableIdCount ?? 0), 0);

    await withOnsiteFootTrafficTransaction(db, async (tx) => {
      const rangePredicate = and(
        gte(schema.onsiteFootTrafficSessions.attendanceDate, startDate),
        lte(schema.onsiteFootTrafficSessions.attendanceDate, endDate),
      );
      await tx.delete(schema.onsiteFootTrafficSessions).where(
        fetchedIds.length > 0
          ? or(rangePredicate, inArray(schema.onsiteFootTrafficSessions.wiseSessionId, fetchedIds))
          : rangePredicate,
      );
      await insertChunks(sessionRows, (chunk) => tx.insert(schema.onsiteFootTrafficSessions).values(chunk));
      await insertChunks(visitRows, (chunk) => tx.insert(schema.onsiteFootTrafficVisits).values(chunk));
      await tx.update(schema.onsiteFootTrafficSyncRuns).set({
        status: "success",
        fetchedSessionCount: wiseSessions.length,
        storedSessionCount: sessionRows.length,
        visitCount: visitRows.length,
        unknownRoomCount,
        missingAttendanceEvidenceCount,
        missingStableIdCount,
        errorSummary: null,
        finishedAt: new Date(),
      }).where(eq(schema.onsiteFootTrafficSyncRuns.id, runId));
      await tx.delete(schema.onsiteFootTrafficReportSnapshots)
        .where(lt(schema.onsiteFootTrafficReportSnapshots.expiresAt, now));
    });

    return {
      ok: true,
      skipped: false,
      runId,
      mode,
      startDate,
      endDate,
      fetchedSessionCount: wiseSessions.length,
      storedSessionCount: sessionRows.length,
      visitCount: visitRows.length,
      unknownRoomCount,
      missingAttendanceEvidenceCount,
      missingStableIdCount,
    };
  } catch (error) {
    await db.update(schema.onsiteFootTrafficSyncRuns).set({
      status: "failed",
      errorSummary: errorMessage(error),
      finishedAt: new Date(),
    }).where(eq(schema.onsiteFootTrafficSyncRuns.id, runId)).catch(() => undefined);
    throw error;
  }
}
