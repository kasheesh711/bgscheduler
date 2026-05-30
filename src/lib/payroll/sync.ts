import { and, eq, lte } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { WiseClient } from "@/lib/wise/client";
import { fetchAllTeachers, fetchWiseActivityEvents } from "@/lib/wise/fetchers";
import type { WiseActivityEvent, WiseSession } from "@/lib/wise/types";
import { getWiseTeacherDisplayName, getWiseTeacherUserId, getWiseTagName } from "@/lib/wise/types";
import {
  assertPayrollMonth,
  dateIsInPayrollMonth,
  extractTierTag,
  normalizePayrollPayoutEvent,
  normalizePayrollSession,
  normalizeTierLabel,
  payrollMonthRange,
} from "./domain";

const PAYOUT_EVENT_NAME = "TutorPayoutInvoiceCreatedEvent";
const EVENT_PAGE_SIZE = 50;
const SESSION_PAGE_SIZE = 1000;
const DEFAULT_MAX_EVENT_PAGES = 1000;
const STALE_RUNNING_MS = 20 * 60 * 1000;
const INSERT_CHUNK_SIZE = 500;
const ERROR_SUMMARY_MAX_LENGTH = 2_000;

export interface PayrollSyncResult {
  syncRunId: string;
  status: "success";
  payrollMonth: string;
  teacherCount: number;
  sessionCount: number;
  invoiceCount: number;
  eventPagesFetched: number;
  sessionPagesFetched: number;
}

export class PayrollSyncAlreadyRunningError extends Error {
  constructor() {
    super("Payroll sync is already running");
    this.name = "PayrollSyncAlreadyRunningError";
  }
}

interface IdentityEntry {
  wiseTeacherId: string;
  wiseUserId: string | null;
  canonicalKey: string;
  displayName: string;
}

function isUniqueRunningViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string }; message?: string };
  return candidate.code === "23505" ||
    candidate.cause?.code === "23505" ||
    /payroll_sync_runs_single_running_idx/.test(candidate.message ?? "");
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

type PayrollWriteDb = Pick<Database, "insert" | "delete" | "update">;

async function insertChunks<T extends Record<string, unknown>>(
  db: PayrollWriteDb,
  table: Parameters<Database["insert"]>[0],
  rows: T[],
): Promise<void> {
  for (const part of chunk(rows, INSERT_CHUNK_SIZE)) {
    if (part.length > 0) {
      await db.insert(table).values(part as never);
    }
  }
}

function shortErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "Payroll sync failed";
  if (message.length <= ERROR_SUMMARY_MAX_LENGTH) return message;
  return `${message.slice(0, ERROR_SUMMARY_MAX_LENGTH)}... [truncated ${message.length - ERROR_SUMMARY_MAX_LENGTH} chars]`;
}

async function markAbandonedRuns(db: Database, now: Date): Promise<void> {
  await db
    .update(schema.payrollSyncRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorSummary: "Payroll sync marked failed because it was still running after 20 minutes.",
    })
    .where(and(
      eq(schema.payrollSyncRuns.status, "running"),
      lte(schema.payrollSyncRuns.startedAt, new Date(now.getTime() - STALE_RUNNING_MS)),
    ));
}

async function loadActiveIdentityEntries(db: Database): Promise<IdentityEntry[]> {
  return db
    .select({
      wiseTeacherId: schema.tutorIdentityGroupMembers.wiseTeacherId,
      wiseUserId: schema.tutorIdentityGroupMembers.wiseUserId,
      canonicalKey: schema.tutorIdentityGroups.canonicalKey,
      displayName: schema.tutorIdentityGroups.displayName,
    })
    .from(schema.tutorIdentityGroupMembers)
    .innerJoin(
      schema.tutorIdentityGroups,
      eq(schema.tutorIdentityGroupMembers.groupId, schema.tutorIdentityGroups.id),
    )
    .innerJoin(
      schema.snapshots,
      and(
        eq(schema.snapshots.id, schema.tutorIdentityGroups.snapshotId),
        eq(schema.snapshots.active, true),
      ),
    );
}

async function fetchPayrollPastSessions(
  client: WiseClient,
  instituteId: string,
  startDate: string,
  endDate: string,
): Promise<{ sessions: WiseSession[]; pagesFetched: number }> {
  const sessions: WiseSession[] = [];
  let pagesFetched = 0;
  for (let pageNumber = 1; ; pageNumber += 1) {
    const response = await client.get<{
      data?: {
        sessions?: WiseSession[];
        page_count?: number;
        totalRecords?: number;
      };
    }>(`/institutes/${instituteId}/sessions`, {
      status: "PAST",
      paginateBy: "DATE",
      startDate,
      endDate,
      page_number: String(pageNumber),
      page_size: String(SESSION_PAGE_SIZE),
    });
    pagesFetched += 1;
    const pageSessions = response.data?.sessions ?? [];
    sessions.push(...pageSessions);
    const pageCount = response.data?.page_count ?? pageNumber;
    if (pageNumber >= pageCount || pageSessions.length === 0) break;
  }
  return { sessions, pagesFetched };
}

async function fetchPayrollPayoutEvents(
  client: WiseClient,
  instituteId: string,
  month: string,
  maxPages: number,
): Promise<{ events: WiseActivityEvent[]; pagesFetched: number }> {
  const range = payrollMonthRange(month);
  const events: WiseActivityEvent[] = [];
  let pagesFetched = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const pageEvents = await fetchWiseActivityEvents(client, instituteId, {
      pageNumber,
      pageSize: EVENT_PAGE_SIZE,
      eventName: PAYOUT_EVENT_NAME,
    });
    pagesFetched += 1;
    if (pageEvents.length === 0) break;

    let allDatedEventsBeforeMonth = true;
    for (const event of pageEvents) {
      const normalized = normalizePayrollPayoutEvent(event);
      if (!normalized?.sessionStartTime) {
        allDatedEventsBeforeMonth = false;
        continue;
      }
      const sessionDate = normalized.sessionStartTime ? schemaDateKey(normalized.sessionStartTime) : "";
      if (sessionDate >= range.startDate) {
        allDatedEventsBeforeMonth = false;
      }
      if (dateIsInPayrollMonth(normalized.sessionStartTime, range)) {
        events.push(event);
      }
    }

    if (pageEvents.length < EVENT_PAGE_SIZE || allDatedEventsBeforeMonth) break;
  }

  return { events, pagesFetched };
}

function schemaDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function runPayrollSync(
  db: Database,
  client: WiseClient,
  instituteId: string,
  monthInput: string,
  options: { now?: Date; maxEventPages?: number } = {},
): Promise<PayrollSyncResult> {
  const month = assertPayrollMonth(monthInput);
  const range = payrollMonthRange(month);
  const now = options.now ?? new Date();
  const maxEventPages = options.maxEventPages ?? DEFAULT_MAX_EVENT_PAGES;

  await markAbandonedRuns(db, now);

  let syncRunId = "";
  try {
    const [run] = await db
      .insert(schema.payrollSyncRuns)
      .values({
        payrollMonth: range.payrollMonth,
        status: "running",
        triggerType: "manual",
        startedAt: now,
        metadata: { maxEventPages, startDate: range.startDate, endDate: range.endDate },
      })
      .returning({ id: schema.payrollSyncRuns.id });
    syncRunId = run.id;
  } catch (error) {
    if (isUniqueRunningViolation(error)) throw new PayrollSyncAlreadyRunningError();
    throw error;
  }

  try {
    const [teachers, identities, sessionFetch, eventFetch] = await Promise.all([
      fetchAllTeachers(client, instituteId),
      loadActiveIdentityEntries(db),
      fetchPayrollPastSessions(client, instituteId, range.queryStartDate, range.queryEndDate),
      fetchPayrollPayoutEvents(client, instituteId, month, maxEventPages),
    ]);

    const identityByTeacherId = new Map(identities.map((entry) => [entry.wiseTeacherId, entry]));
    const identityByUserId = new Map(
      identities
        .filter((entry) => entry.wiseUserId)
        .map((entry) => [entry.wiseUserId!, entry]),
    );

    const teacherByUserId = new Map<string, { wiseTeacherId: string; displayName: string }>();
    const teacherRows: Array<typeof schema.payrollTeacherTiers.$inferInsert> = teachers.map((teacher) => {
      const tags = (teacher.tags ?? []).map((tag) => getWiseTagName(tag));
      const rawTier = extractTierTag(tags);
      const wiseUserId = getWiseTeacherUserId(teacher) ?? null;
      if (wiseUserId) {
        teacherByUserId.set(wiseUserId, {
          wiseTeacherId: teacher._id,
          displayName: getWiseTeacherDisplayName(teacher),
        });
      }
      return {
        payrollMonth: range.payrollMonth,
        syncRunId,
        wiseTeacherId: teacher._id,
        wiseUserId,
        wiseDisplayName: getWiseTeacherDisplayName(teacher),
        rawTier,
        normalizedTier: normalizeTierLabel(rawTier),
        tags,
      };
    });

    const sessionRows: Array<typeof schema.payrollSessionObservations.$inferInsert> = [];
    for (const rawSession of sessionFetch.sessions) {
      const normalized = normalizePayrollSession(rawSession);
      if (!normalized || !dateIsInPayrollMonth(normalized.startTime, range)) continue;
      const teacher = normalized.wiseTeacherUserId ? teacherByUserId.get(normalized.wiseTeacherUserId) : undefined;
      const identity = (normalized.wiseTeacherUserId ? identityByUserId.get(normalized.wiseTeacherUserId) : undefined)
        ?? (teacher ? identityByTeacherId.get(teacher.wiseTeacherId) : undefined);
      sessionRows.push({
        payrollMonth: range.payrollMonth,
        syncRunId,
        wiseSessionId: normalized.wiseSessionId,
        wiseTeacherUserId: normalized.wiseTeacherUserId,
        wiseTeacherId: normalized.wiseTeacherId ?? teacher?.wiseTeacherId ?? null,
        tutorGroupCanonicalKey: identity?.canonicalKey ?? null,
        tutorDisplayName: identity?.displayName ?? teacher?.displayName ?? null,
        wiseClassId: normalized.wiseClassId,
        className: normalized.className,
        subject: normalized.subject,
        classType: normalized.classType,
        startTime: normalized.startTime,
        endTime: normalized.endTime,
        durationMinutes: normalized.durationMinutes,
        meetingStatus: normalized.meetingStatus,
        sessionType: normalized.sessionType,
        studentCount: normalized.studentCount,
        raw: normalized.raw,
      });
    }

    const invoiceRows: Array<typeof schema.payrollPayoutInvoices.$inferInsert> = eventFetch.events
      .map(normalizePayrollPayoutEvent)
      .filter((event): event is NonNullable<typeof event> => Boolean(event))
      .filter((event) => dateIsInPayrollMonth(event.sessionStartTime, range))
      .map((event) => ({
        payrollMonth: range.payrollMonth,
        syncRunId,
        eventId: event.eventId,
        transactionId: event.transactionId,
        eventTimestamp: event.eventTimestamp,
        wiseTeacherUserId: event.wiseTeacherUserId,
        actorWiseUserId: event.actorWiseUserId,
        wiseClassId: event.wiseClassId,
        wiseSessionId: event.wiseSessionId,
        sessionStartTime: event.sessionStartTime,
        sessionCredits: event.sessionCredits,
        amountMinor: event.amountMinor,
        amount: event.amount,
        currency: event.currency,
        transactionStatus: event.transactionStatus,
        note: event.note,
        raw: event.raw,
      }));

    const metadata = {
      maxEventPages,
      startDate: range.startDate,
      endDate: range.endDate,
      queryStartDate: range.queryStartDate,
      queryEndDate: range.queryEndDate,
      eventPagesFetched: eventFetch.pagesFetched,
      sessionPagesFetched: sessionFetch.pagesFetched,
      rawPayoutEventsMatched: eventFetch.events.length,
      teacherRowsPrepared: teacherRows.length,
      sessionRowsPrepared: sessionRows.length,
      invoiceRowsNormalized: invoiceRows.length,
    };

    await db
      .update(schema.payrollSyncRuns)
      .set({ metadata })
      .where(eq(schema.payrollSyncRuns.id, syncRunId));

    await db.transaction(async (tx) => {
      await tx.delete(schema.payrollTeacherTiers).where(eq(schema.payrollTeacherTiers.payrollMonth, range.payrollMonth));
      await tx.delete(schema.payrollPayoutInvoices).where(eq(schema.payrollPayoutInvoices.payrollMonth, range.payrollMonth));
      await tx.delete(schema.payrollSessionObservations).where(eq(schema.payrollSessionObservations.payrollMonth, range.payrollMonth));

      await insertChunks(tx, schema.payrollTeacherTiers, teacherRows);
      await insertChunks(tx, schema.payrollSessionObservations, sessionRows);
      await insertChunks(tx, schema.payrollPayoutInvoices, invoiceRows);

      await tx
        .insert(schema.payrollReviews)
        .values({
          payrollMonth: range.payrollMonth,
          status: "draft",
          lastSyncRunId: syncRunId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.payrollReviews.payrollMonth,
          set: {
            status: "draft",
            approvedByEmail: null,
            approvedByName: null,
            approvedAt: null,
            lastSyncRunId: syncRunId,
            updatedAt: new Date(),
          },
        });

      await tx
        .update(schema.payrollSyncRuns)
        .set({
          status: "success",
          finishedAt: new Date(),
          teacherCount: teacherRows.length,
          sessionCount: sessionRows.length,
          invoiceCount: invoiceRows.length,
          metadata,
        })
        .where(eq(schema.payrollSyncRuns.id, syncRunId));
    });

    return {
      syncRunId,
      status: "success",
      payrollMonth: range.payrollMonth,
      teacherCount: teacherRows.length,
      sessionCount: sessionRows.length,
      invoiceCount: invoiceRows.length,
      eventPagesFetched: eventFetch.pagesFetched,
      sessionPagesFetched: sessionFetch.pagesFetched,
    };
  } catch (error) {
    await db
      .update(schema.payrollSyncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorSummary: shortErrorSummary(error),
      })
      .where(eq(schema.payrollSyncRuns.id, syncRunId));
    throw error;
  }
}
