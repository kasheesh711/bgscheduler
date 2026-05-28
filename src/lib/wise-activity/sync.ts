import { and, eq, inArray, lte } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { fetchWiseActivityEvents } from "@/lib/wise/fetchers";
import type { WiseClient } from "@/lib/wise/client";
import type { WiseActivityEvent } from "@/lib/wise/types";

const PAGE_SIZE = 50;
const CRON_LOOKBACK_DAYS = 3;
const CRON_MAX_PAGES = 20;
const MANUAL_LOOKBACK_DAYS = 30;
const MANUAL_MAX_PAGES = 500;
const STALE_RUNNING_MS = 20 * 60 * 1000;

export type WiseActivityTrigger = "cron" | "manual";

export interface WiseActivitySyncOptions {
  triggerType?: WiseActivityTrigger;
  lookbackDays?: number;
  maxPages?: number;
  now?: Date;
}

export interface WiseActivitySyncResult {
  syncRunId: string;
  status: "success";
  triggerType: WiseActivityTrigger;
  pagesFetched: number;
  eventsFetched: number;
  insertedCount: number;
  oldestEventTimestamp: Date | null;
  newestEventTimestamp: Date | null;
  stoppedReason: string;
}

type WiseActivityInsert = typeof schema.wiseActivityEvents.$inferInsert;

export class WiseActivitySyncAlreadyRunningError extends Error {
  constructor() {
    super("Wise activity sync is already running");
    this.name = "WiseActivitySyncAlreadyRunningError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    cause?: { code?: string };
    message?: string;
  };
  return candidate.code === "23505" ||
    candidate.cause?.code === "23505" ||
    /wise_activity_sync_runs_single_running_idx/.test(candidate.message ?? "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateValue(value: unknown): Date | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeWiseActivityEvent(raw: WiseActivityEvent): WiseActivityInsert | null {
  const event = raw.event ?? {};
  const payload = asRecord(event.payload);
  const session = asRecord(payload.session);
  const transaction = asRecord(payload.transaction);
  const transactionAmount = asRecord(transaction.amount);
  const payloadUser = asRecord(payload.user);
  const payloadClass = asRecord(payload.class);
  const classroom = raw.classroom ?? {};
  const actor = raw.user ?? {};
  const eventId = stringValue(event.eventId);
  const eventTimestamp = dateValue(event.eventTimestamp);

  if (!eventId || !eventTimestamp) return null;

  return {
    eventId,
    eventType: stringValue(event.type) ?? "unknown",
    eventName: stringValue(event.eventName) ?? "UnknownEvent",
    eventTimestamp,
    actorWiseUserId: stringValue(actor._id) ?? stringValue(payloadUser.id),
    actorName: stringValue(actor.name),
    actorRole: stringValue(actor.role),
    classroomId: stringValue(classroom._id) ?? stringValue(payloadClass.id),
    classroomName: stringValue(classroom.name),
    classroomSubject: stringValue(classroom.subject),
    sessionId: stringValue(session.id),
    sessionStartTime: dateValue(session.scheduledStartTime),
    sessionEndTime: dateValue(session.scheduledEndTime),
    transactionId: stringValue(transaction.id),
    transactionType: stringValue(transaction.transactionType) ?? stringValue(transaction.type),
    transactionStatus: stringValue(transaction.status),
    transactionAmount: numberValue(transactionAmount.value),
    transactionCurrency: stringValue(transactionAmount.currency),
    payload,
    raw: asRecord(raw),
    updatedAt: new Date(),
  };
}

async function markAbandonedRuns(db: Database, now: Date): Promise<void> {
  await db
    .update(schema.wiseActivitySyncRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorSummary: "Wise activity sync marked failed because it was still running after 20 minutes.",
    })
    .where(and(
      eq(schema.wiseActivitySyncRuns.status, "running"),
      lte(schema.wiseActivitySyncRuns.startedAt, new Date(now.getTime() - STALE_RUNNING_MS)),
    ));
}

function minDate(left: Date | null, right: Date): Date {
  return !left || right < left ? right : left;
}

function maxDate(left: Date | null, right: Date): Date {
  return !left || right > left ? right : left;
}

export async function syncWiseActivityEvents(
  db: Database,
  client: WiseClient,
  instituteId: string,
  options: WiseActivitySyncOptions = {},
): Promise<WiseActivitySyncResult> {
  const now = options.now ?? new Date();
  const triggerType = options.triggerType ?? "cron";
  const lookbackDays = options.lookbackDays ?? (triggerType === "manual" ? MANUAL_LOOKBACK_DAYS : CRON_LOOKBACK_DAYS);
  const maxPages = options.maxPages ?? (triggerType === "manual" ? MANUAL_MAX_PAGES : CRON_MAX_PAGES);
  const cutoff = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  await markAbandonedRuns(db, now);

  let syncRunId = "";
  try {
    const [run] = await db
      .insert(schema.wiseActivitySyncRuns)
      .values({
        status: "running",
        triggerType,
        startedAt: now,
        metadata: { lookbackDays, maxPages },
      })
      .returning({ id: schema.wiseActivitySyncRuns.id });
    syncRunId = run.id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new WiseActivitySyncAlreadyRunningError();
    throw error;
  }

  let pagesFetched = 0;
  let eventsFetched = 0;
  let insertedCount = 0;
  let oldestEventTimestamp: Date | null = null;
  let newestEventTimestamp: Date | null = null;
  let stoppedReason = "max_pages";

  try {
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const events = await fetchWiseActivityEvents(client, instituteId, {
        pageNumber,
        pageSize: PAGE_SIZE,
      });
      pagesFetched += 1;
      eventsFetched += events.length;

      if (events.length === 0) {
        stoppedReason = "empty_page";
        break;
      }

      const rows = events
        .map(normalizeWiseActivityEvent)
        .filter((row): row is WiseActivityInsert => Boolean(row));

      for (const row of rows) {
        oldestEventTimestamp = minDate(oldestEventTimestamp, row.eventTimestamp as Date);
        newestEventTimestamp = maxDate(newestEventTimestamp, row.eventTimestamp as Date);
      }

      const eventIds = rows.map((row) => row.eventId);
      const existingRows = eventIds.length
        ? await db
          .select({ eventId: schema.wiseActivityEvents.eventId })
          .from(schema.wiseActivityEvents)
          .where(inArray(schema.wiseActivityEvents.eventId, eventIds))
        : [];
      const hitKnownPage = eventIds.length > 0 && existingRows.length === eventIds.length;

      if (rows.length > 0) {
        const inserted = await db
          .insert(schema.wiseActivityEvents)
          .values(rows)
          .onConflictDoNothing({ target: schema.wiseActivityEvents.eventId })
          .returning({ id: schema.wiseActivityEvents.id });
        insertedCount += inserted.length;
      }

      if (events.length < PAGE_SIZE) {
        stoppedReason = "short_page";
        break;
      }
      if (oldestEventTimestamp && oldestEventTimestamp <= cutoff) {
        stoppedReason = "lookback_reached";
        break;
      }
      if (hitKnownPage) {
        stoppedReason = "known_events";
        break;
      }
    }

    await db
      .update(schema.wiseActivitySyncRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        pagesFetched,
        eventsFetched,
        insertedCount,
        oldestEventTimestamp,
        newestEventTimestamp,
        metadata: { lookbackDays, maxPages, stoppedReason },
      })
      .where(eq(schema.wiseActivitySyncRuns.id, syncRunId));

    return {
      syncRunId,
      status: "success",
      triggerType,
      pagesFetched,
      eventsFetched,
      insertedCount,
      oldestEventTimestamp,
      newestEventTimestamp,
      stoppedReason,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wise activity sync failed";
    await db
      .update(schema.wiseActivitySyncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        pagesFetched,
        eventsFetched,
        insertedCount,
        oldestEventTimestamp,
        newestEventTimestamp,
        errorSummary: message,
        metadata: { lookbackDays, maxPages },
      })
      .where(eq(schema.wiseActivitySyncRuns.id, syncRunId));
    throw error;
  }
}
