import type { PostClassReminderResult } from "./notifications";
import { runPostClassReminder } from "./notifications";
import {
  runPostClassFeedbackSync,
  type SyncPostClassFeedbackOptions,
  type SyncPostClassFeedbackResult,
} from "./sync";

export type PostClassReminderCheckpoint = "day_after" | "deadline";

const DEFAULT_MAX_BATCHES = 8;
const DEFAULT_MAX_ELAPSED_MS = 9 * 60 * 1000;

type SyncRunner = (
  options: SyncPostClassFeedbackOptions,
) => Promise<SyncPostClassFeedbackResult>;

type ReminderRunner = (
  kind: "tutor_day_after" | "tutor_deadline",
  options: { now?: Date },
) => Promise<PostClassReminderResult>;

export interface RunPostClassReminderJobOptions {
  triggerType: "cron" | "manual";
  actorEmail?: string | null;
  now?: Date;
  maxBatches?: number;
  maxElapsedMs?: number;
  clock?: () => number;
  sync?: SyncRunner;
  remind?: ReminderRunner;
}

export interface PostClassReminderJobResult {
  ready: boolean;
  checkpoint: PostClassReminderCheckpoint;
  syncRuns: SyncPostClassFeedbackResult[];
  reminder: PostClassReminderResult | null;
  blockedReason: "batch_limit" | "time_limit" | "missing_checkpoint" | null;
}

/**
 * Refreshes every candidate for one reminder checkpoint before creating any
 * tutor delivery. Each sync remains capped at 50 Wise detail calls; successful
 * observations fall out of the next batch while durable failures rotate behind
 * unseen rows. If the route budget cannot drain the checkpoint, dispatch stays
 * fail-closed and Data Health records a recoverable failed invocation.
 */
export async function runPostClassReminderJob(
  checkpoint: PostClassReminderCheckpoint,
  options: RunPostClassReminderJobOptions,
): Promise<PostClassReminderJobResult> {
  const fixedNow = options.now ?? new Date();
  const maxBatches = Math.max(1, Math.min(options.maxBatches ?? DEFAULT_MAX_BATCHES, 20));
  const maxElapsedMs = Math.max(1, options.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS);
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const sync = options.sync ?? runPostClassFeedbackSync;
  const remind = options.remind ?? runPostClassReminder;
  const syncRuns: SyncPostClassFeedbackResult[] = [];

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await sync({
      triggerType: options.triggerType,
      actorEmail: options.actorEmail,
      now: fixedNow,
      reminderCheckpoint: checkpoint,
    });
    syncRuns.push(result);

    if (!result.checkpoint || result.checkpoint.kind !== checkpoint) {
      return {
        ready: false,
        checkpoint,
        syncRuns,
        reminder: null,
        blockedReason: "missing_checkpoint",
      };
    }

    // Check the route budget before dispatch even when this batch drained the
    // backlog. A slow final Wise batch must not start email work with an old
    // fixed freshness timestamp or run into the platform timeout mid-send.
    if (clock() - startedAt >= maxElapsedMs) {
      return {
        ready: false,
        checkpoint,
        syncRuns,
        reminder: null,
        blockedReason: "time_limit",
      };
    }

    if (!result.checkpoint.hasMore) {
      const reminder = await remind(
        checkpoint === "day_after" ? "tutor_day_after" : "tutor_deadline",
        { now: fixedNow },
      );
      return {
        ready: true,
        checkpoint,
        syncRuns,
        reminder,
        blockedReason: null,
      };
    }

    if (batch + 1 >= maxBatches) {
      return {
        ready: false,
        checkpoint,
        syncRuns,
        reminder: null,
        blockedReason: "batch_limit",
      };
    }
  }

  // The loop always returns, but retaining an explicit fail-closed fallback
  // keeps the invariant obvious if its bounds are changed later.
  return {
    ready: false,
    checkpoint,
    syncRuns,
    reminder: null,
    blockedReason: "batch_limit",
  };
}
