import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { addBangkokDays, bangkokDateKey, bangkokDateStartUtc, datesBetweenBangkok } from "@/lib/room-capacity/dates";
import { isWiseFinanceEvent, isWiseSessionMutation } from "./format";

export interface WiseActivityListFilters {
  start: Date;
  end: Date;
  page: number;
  pageSize: number;
  eventType?: string;
  eventName?: string;
  query?: string;
  sessionId?: string;
  transactionId?: string;
  financeOnly?: boolean;
}

export interface WiseActivitySummaryFilters {
  start: Date;
  end: Date;
  startDate: string;
  endDate: string;
  eventType?: string;
  eventName?: string;
  query?: string;
  sessionId?: string;
  transactionId?: string;
  financeOnly?: boolean;
}

export interface WiseActivityEventDto {
  id: string;
  eventId: string;
  eventType: string;
  eventName: string;
  eventTimestamp: string;
  actorWiseUserId: string | null;
  actorName: string | null;
  actorRole: string | null;
  classroomId: string | null;
  classroomName: string | null;
  classroomSubject: string | null;
  sessionId: string | null;
  sessionStartTime: string | null;
  sessionEndTime: string | null;
  transactionId: string | null;
  transactionType: string | null;
  transactionStatus: string | null;
  transactionAmount: number | null;
  transactionCurrency: string | null;
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
}

type WiseActivityRow = typeof schema.wiseActivityEvents.$inferSelect;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toWiseActivityEventDto(row: WiseActivityRow): WiseActivityEventDto {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    eventName: row.eventName,
    eventTimestamp: row.eventTimestamp.toISOString(),
    actorWiseUserId: row.actorWiseUserId,
    actorName: row.actorName,
    actorRole: row.actorRole,
    classroomId: row.classroomId,
    classroomName: row.classroomName,
    classroomSubject: row.classroomSubject,
    sessionId: row.sessionId,
    sessionStartTime: iso(row.sessionStartTime),
    sessionEndTime: iso(row.sessionEndTime),
    transactionId: row.transactionId,
    transactionType: row.transactionType,
    transactionStatus: row.transactionStatus,
    transactionAmount: row.transactionAmount,
    transactionCurrency: row.transactionCurrency,
    payload: row.payload,
    raw: row.raw,
  };
}

function buildConditions(filters: {
  start: Date;
  end: Date;
  eventType?: string;
  eventName?: string;
  query?: string;
  sessionId?: string;
  transactionId?: string;
  financeOnly?: boolean;
}): SQL[] {
  const conditions: SQL[] = [
    gte(schema.wiseActivityEvents.eventTimestamp, filters.start),
    lte(schema.wiseActivityEvents.eventTimestamp, filters.end),
  ];

  if (filters.eventType) conditions.push(eq(schema.wiseActivityEvents.eventType, filters.eventType));
  if (filters.eventName) conditions.push(eq(schema.wiseActivityEvents.eventName, filters.eventName));
  if (filters.sessionId) conditions.push(eq(schema.wiseActivityEvents.sessionId, filters.sessionId));
  if (filters.transactionId) conditions.push(eq(schema.wiseActivityEvents.transactionId, filters.transactionId));
  if (filters.financeOnly) {
    conditions.push(sql`(
      ${schema.wiseActivityEvents.eventType} = 'BILLING'
      OR ${schema.wiseActivityEvents.transactionId} IS NOT NULL
      OR ${schema.wiseActivityEvents.eventName} ILIKE '%invoice%'
      OR ${schema.wiseActivityEvents.eventName} ILIKE '%payment%'
      OR ${schema.wiseActivityEvents.eventName} ILIKE '%payout%'
    )`);
  }
  if (filters.query?.trim()) {
    const pattern = `%${filters.query.trim()}%`;
    conditions.push(sql`(
      ${schema.wiseActivityEvents.actorName} ILIKE ${pattern}
      OR ${schema.wiseActivityEvents.classroomName} ILIKE ${pattern}
      OR ${schema.wiseActivityEvents.classroomSubject} ILIKE ${pattern}
      OR ${schema.wiseActivityEvents.eventName} ILIKE ${pattern}
      OR ${schema.wiseActivityEvents.sessionId} ILIKE ${pattern}
      OR ${schema.wiseActivityEvents.transactionId} ILIKE ${pattern}
    )`);
  }

  return conditions;
}

export async function listWiseActivityEvents(db: Database, filters: WiseActivityListFilters) {
  const conditions = buildConditions(filters);
  const where = and(...conditions);
  const offset = (filters.page - 1) * filters.pageSize;

  const [countRows, rows] = await Promise.all([
    db
      .select({ count: sql<string>`count(*)::text` })
      .from(schema.wiseActivityEvents)
      .where(where),
    db
      .select()
      .from(schema.wiseActivityEvents)
      .where(where)
      .orderBy(desc(schema.wiseActivityEvents.eventTimestamp))
      .limit(filters.pageSize)
      .offset(offset),
  ]);

  const total = Number(countRows[0]?.count ?? "0");
  return {
    events: rows.map(toWiseActivityEventDto),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      pageCount: Math.ceil(total / filters.pageSize),
    },
  };
}

export async function getWiseActivitySummary(db: Database, filters: WiseActivitySummaryFilters) {
  const where = and(...buildConditions(filters));

  const [rows, syncRows] = await Promise.all([
    db
      .select()
      .from(schema.wiseActivityEvents)
      .where(where)
      .orderBy(desc(schema.wiseActivityEvents.eventTimestamp)),
    db
      .select()
      .from(schema.wiseActivitySyncRuns)
      .orderBy(desc(schema.wiseActivitySyncRuns.startedAt))
      .limit(1),
  ]);

  const dates = datesBetweenBangkok(filters.startDate, filters.endDate);
  const byDate = new Map(dates.map((date) => [date, { date, total: 0 } as Record<string, string | number>]));
  const financeTrend = new Map(dates.map((date) => [date, { date, count: 0, amount: 0 }]));
  const eventTypeCounts: Record<string, number> = {};
  const eventNameCounts: Record<string, number> = {};
  const sessionMutationCounts: Record<string, number> = {
    SessionCreatedEvent: 0,
    SessionUpdatedEvent: 0,
    SessionCancelledEvent: 0,
    SessionDeletedEvent: 0,
  };
  const actorCounts: Record<string, number> = {};
  const classroomCounts: Record<string, number> = {};
  let sessionMutationEvents = 0;
  let financeEvents = 0;

  for (const row of rows) {
    const date = bangkokDateKey(row.eventTimestamp);
    const dateEntry = byDate.get(date) ?? { date, total: 0 };
    dateEntry.total = Number(dateEntry.total ?? 0) + 1;
    dateEntry[row.eventType] = Number(dateEntry[row.eventType] ?? 0) + 1;
    byDate.set(date, dateEntry);

    eventTypeCounts[row.eventType] = (eventTypeCounts[row.eventType] ?? 0) + 1;
    eventNameCounts[row.eventName] = (eventNameCounts[row.eventName] ?? 0) + 1;
    if (row.actorName) actorCounts[row.actorName] = (actorCounts[row.actorName] ?? 0) + 1;
    if (row.classroomName) classroomCounts[row.classroomName] = (classroomCounts[row.classroomName] ?? 0) + 1;

    if (isWiseSessionMutation(row.eventName)) {
      sessionMutationEvents += 1;
      sessionMutationCounts[row.eventName] = (sessionMutationCounts[row.eventName] ?? 0) + 1;
    }
    if (isWiseFinanceEvent(row)) {
      financeEvents += 1;
      const current = financeTrend.get(date) ?? { date, count: 0, amount: 0 };
      current.count += 1;
      current.amount += row.transactionAmount ?? 0;
      financeTrend.set(date, current);
    }
  }

  const lastSync = syncRows[0] ?? null;
  return {
    cards: {
      totalEvents: rows.length,
      sessionMutationEvents,
      financeEvents,
      lastSyncAt: lastSync?.finishedAt?.toISOString() ?? lastSync?.startedAt.toISOString() ?? null,
      lastSyncStatus: lastSync?.status ?? null,
      lastSyncInsertedCount: lastSync?.insertedCount ?? null,
    },
    activityByDate: [...byDate.values()],
    financeTrend: [...financeTrend.values()],
    eventTypeCounts,
    eventNameCounts,
    sessionMutationCounts,
    topActors: Object.entries(actorCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
    topClassrooms: Object.entries(classroomCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

export function wiseActivityBangkokRange(startDate: string, endDate: string): { start: Date; end: Date } {
  return {
    start: bangkokDateStartUtc(startDate),
    end: new Date(bangkokDateStartUtc(addBangkokDays(endDate, 1)).getTime() - 1),
  };
}
