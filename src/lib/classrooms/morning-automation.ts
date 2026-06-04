import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { addBangkokDays, todayBangkok } from "@/lib/room-capacity/dates";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";
import { createWiseClient } from "@/lib/wise/client";
import { fetchAllFutureSessions } from "@/lib/wise/fetchers";
import type { WiseSession } from "@/lib/wise/types";
import {
  CLASSROOM_ASSIGNMENT_FRESHNESS_MS,
  getFreshClassroomSnapshotForAssignment,
  publishClassroomAssignmentRun,
  runIncrementalClassroomAssignment,
  selectAutomationPublishTargetRowIds,
  type ClassroomAssignmentDetail,
  type PublishSummary,
} from "./data";
import {
  sendScheduleEmailsForRun,
  type ScheduleEmailSendResult,
} from "./schedule-email";

const DEFAULT_SYNC_WAIT_MS = 90_000;
const SYNC_POLL_MS = 5_000;
const AUTOMATION_ACTOR = "cron@classroom-assignments";
const SCHEDULE_EMAIL_ACTOR = "cron@classroom-schedule-email";

interface LatestSync {
  id: string;
  status: "running" | "success" | "failed";
  startedAt: Date;
  finishedAt: Date | null;
}

export interface MorningAutomationDateResult {
  date: string;
  runId: string;
  changedRows: number;
  targetPublishRows: number;
  publishSummary: PublishSummary;
  scheduleEmail?: {
    summary: ScheduleEmailSendResult["summary"];
    failover?: NonNullable<ScheduleEmailSendResult["failover"]>;
  };
  scheduleEmailError?: string;
  events: number;
  detail: ClassroomAssignmentDetail;
}

export interface MorningAutomationResult {
  ok: boolean;
  automationBatchId: string;
  startDate: string;
  endDate: string;
  sync: {
    mode: "reused" | "waited" | "triggered";
    syncRunId: string | null;
    finishedAt: string | null;
    snapshotId?: string | null;
  };
  dates: MorningAutomationDateResult[];
}

async function latestSuccessfulSync(db: Database): Promise<LatestSync | null> {
  const [sync] = await db
    .select({
      id: schema.syncRuns.id,
      status: schema.syncRuns.status,
      startedAt: schema.syncRuns.startedAt,
      finishedAt: schema.syncRuns.finishedAt,
    })
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, "success"))
    .orderBy(desc(schema.syncRuns.finishedAt))
    .limit(1);
  return sync ?? null;
}

async function latestRunningSync(db: Database): Promise<LatestSync | null> {
  const [sync] = await db
    .select({
      id: schema.syncRuns.id,
      status: schema.syncRuns.status,
      startedAt: schema.syncRuns.startedAt,
      finishedAt: schema.syncRuns.finishedAt,
    })
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, "running"))
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1);
  return sync ?? null;
}

function isFresh(sync: LatestSync | null, now = new Date()): boolean {
  if (!sync?.finishedAt) return false;
  return now.getTime() - sync.finishedAt.getTime() <= CLASSROOM_ASSIGNMENT_FRESHNESS_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureFreshWiseSyncForClassroomAutomation(
  db: Database,
  options: { maxWaitMs?: number; now?: Date } = {},
): Promise<MorningAutomationResult["sync"]> {
  const now = options.now ?? new Date();
  const initialSuccess = await latestSuccessfulSync(db);
  if (isFresh(initialSuccess, now)) {
    return {
      mode: "reused",
      syncRunId: initialSuccess?.id ?? null,
      finishedAt: initialSuccess?.finishedAt?.toISOString() ?? null,
    };
  }

  const maxWaitMs = options.maxWaitMs ?? DEFAULT_SYNC_WAIT_MS;
  const waitStarted = Date.now();
  if (await latestRunningSync(db)) {
    while (Date.now() - waitStarted < maxWaitMs) {
      await sleep(Math.min(SYNC_POLL_MS, maxWaitMs));
      const latest = await latestSuccessfulSync(db);
      if (isFresh(latest)) {
        return {
          mode: "waited",
          syncRunId: latest?.id ?? null,
          finishedAt: latest?.finishedAt?.toISOString() ?? null,
        };
      }
      if (!await latestRunningSync(db)) break;
    }
  }

  const response = await runWiseSyncRequest();
  const body = await response.json().catch(() => null) as { syncRunId?: string; success?: boolean; skipped?: boolean } | null;
  if (!response.ok && response.status !== 202) {
    throw new Error(`Wise sync failed before classroom automation: HTTP ${response.status}`);
  }

  if (body?.skipped) {
    const skippedWaitStarted = Date.now();
    while (Date.now() - skippedWaitStarted < maxWaitMs) {
      await sleep(Math.min(SYNC_POLL_MS, maxWaitMs));
      const latest = await latestSuccessfulSync(db);
      if (isFresh(latest)) {
        return {
          mode: "waited",
          syncRunId: latest?.id ?? null,
          finishedAt: latest?.finishedAt?.toISOString() ?? null,
        };
      }
    }
    throw new Error("Wise sync was still running after the classroom automation wait window.");
  }

  const latest = await latestSuccessfulSync(db);
  if (!isFresh(latest)) {
    throw new Error("Wise sync completed but did not produce a fresh promoted snapshot.");
  }

  return {
    mode: "triggered",
    syncRunId: body?.syncRunId ?? latest?.id ?? null,
    finishedAt: latest?.finishedAt?.toISOString() ?? null,
  };
}

function horizonDates(startDate: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addBangkokDays(startDate, index));
}

export async function runClassroomMorningAutomation(
  db: Database = getDb(),
  options: {
    startDate?: string;
    automationBatchId?: string;
    maxSyncWaitMs?: number;
    liveSessions?: WiseSession[];
  } = {},
): Promise<MorningAutomationResult> {
  const startDate = options.startDate ?? todayBangkok();
  const dates = horizonDates(startDate);
  const automationBatchId = options.automationBatchId ?? randomUUID();
  const sync = await ensureFreshWiseSyncForClassroomAutomation(db, {
    maxWaitMs: options.maxSyncWaitMs,
  });
  const classroomSnapshot = await getFreshClassroomSnapshotForAssignment(db);
  const client = createWiseClient();
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const liveSessions = options.liveSessions ?? await fetchAllFutureSessions(client, instituteId);
  const results: MorningAutomationDateResult[] = [];

  for (const date of dates) {
    const detail = await runIncrementalClassroomAssignment(db, {
      date,
      automationBatchId,
      createdBy: AUTOMATION_ACTOR,
      liveSessions,
      snapshotId: classroomSnapshot.snapshotId,
      trustedSnapshotMeta: classroomSnapshot.snapshotMeta,
    });
    if (!detail.run) throw new Error(`Classroom assignment run was not created for ${date}`);
    const targetRowIds = await selectAutomationPublishTargetRowIds(db, detail.rows, liveSessions, client);
    let publishSummary: PublishSummary = { attempted: 0, success: 0, skipped: 0, failed: 0 };
    if (targetRowIds.length > 0) {
      const published = await publishClassroomAssignmentRun(db, detail.run.id, client, {
        targetRowIds,
        liveSessions,
      });
      publishSummary = published.summary;
    }

    let scheduleEmail: MorningAutomationDateResult["scheduleEmail"];
    let scheduleEmailError: string | undefined;
    if (date === startDate) {
      try {
        const sent = await sendScheduleEmailsForRun(
          db,
          detail.run.id,
          SCHEDULE_EMAIL_ACTOR,
          undefined,
          { mode: "failed_only" },
        );
        scheduleEmail = {
          summary: sent.summary,
          ...(sent.failover ? { failover: sent.failover } : {}),
        };
      } catch (error) {
        scheduleEmailError = error instanceof Error ? error.message : "Schedule email send failed";
      }
    }

    results.push({
      date,
      runId: detail.run.id,
      changedRows: detail.rows.filter((row) => row.changeType !== "carried").length,
      targetPublishRows: targetRowIds.length,
      publishSummary,
      ...(scheduleEmail ? { scheduleEmail } : {}),
      ...(scheduleEmailError ? { scheduleEmailError } : {}),
      events: detail.events.length,
      detail,
    });
  }

  return {
    ok: true,
    automationBatchId,
    startDate,
    endDate: dates[dates.length - 1],
    sync: {
      ...sync,
      snapshotId: classroomSnapshot.snapshotId,
    },
    dates: results,
  };
}
