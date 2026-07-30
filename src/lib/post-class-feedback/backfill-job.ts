import {
  runPostClassFeedbackSync,
  type SyncPostClassFeedbackOptions,
  type SyncPostClassFeedbackResult,
} from "./sync";

const DEFAULT_MAX_BATCHES = 8;
const DEFAULT_MAX_ELAPSED_MS = 9 * 60 * 1000;

type SyncRunner = (
  options: SyncPostClassFeedbackOptions,
) => Promise<SyncPostClassFeedbackResult>;

export interface RunPostClassBackfillJobOptions {
  /** Inclusive Bangkok calendar dates. Both are required. */
  startDate: string;
  endDate: string;
  actorEmail?: string | null;
  now?: Date;
  detailCap?: number;
  maxBatches?: number;
  maxElapsedMs?: number;
  clock?: () => number;
  sync?: SyncRunner;
}

export interface PostClassBackfillJobResult {
  startDate: string;
  endDate: string;
  batches: number;
  detailFetchedCount: number;
  sessionSavedCount: number;
  sourceIssueCount: number;
  syncRuns: SyncPostClassFeedbackResult[];
  /** True when a batch drained the pool, so the window is fully observed. */
  drained: boolean;
  stoppedReason: "drained" | "batch_limit" | "time_limit";
}

/**
 * Drains a historical date window by running the collector repeatedly.
 *
 * Steps:
 *  1. Run one manual backfill batch over the window.
 *  2. Stop as soon as a batch fetches fewer details than the cap — the
 *     candidate pool for that window is exhausted.
 *  3. Otherwise keep going until the batch or wall-clock budget runs out, so
 *     a long backfill can never overrun the platform function timeout.
 *
 * Every batch is bounded by `detailCap` Wise detail calls at concurrency 4, so
 * this widens throughput without changing the per-request rate-limit posture.
 */
export async function runPostClassBackfillJob(
  options: RunPostClassBackfillJobOptions,
): Promise<PostClassBackfillJobResult> {
  const fixedNow = options.now ?? new Date();
  const maxBatches = Math.max(1, Math.min(options.maxBatches ?? DEFAULT_MAX_BATCHES, 50));
  const maxElapsedMs = Math.max(1, options.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS);
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const sync = options.sync ?? runPostClassFeedbackSync;
  const syncRuns: SyncPostClassFeedbackResult[] = [];

  let detailFetchedCount = 0;
  let sessionSavedCount = 0;
  let sourceIssueCount = 0;
  let stoppedReason: PostClassBackfillJobResult["stoppedReason"] = "batch_limit";

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await sync({
      triggerType: "manual",
      actorEmail: options.actorEmail,
      now: fixedNow,
      startDate: options.startDate,
      endDate: options.endDate,
      detailCap: options.detailCap,
    });
    syncRuns.push(result);
    detailFetchedCount += result.detailFetchedCount;
    sessionSavedCount += result.sessionSavedCount;
    sourceIssueCount += result.sourceIssueCount;

    // The window is drained when nothing is left outstanding in it.
    //
    // This used to test `candidateCount < requestedCap`, but `candidateCount`
    // sums all three candidate lanes. A saturated recheck queue — the normal
    // state while a backlog is being worked off — pins it at the cap every
    // batch, so a window that was in fact complete never reported `drained`
    // and the job burned its whole batch and wall-clock budget re-running it.
    //
    // `detailFetchedCount === 0` is kept as a no-progress guard: a batch that
    // fetched nothing will not fetch anything next time either.
    if (result.windowCandidateCount === 0 || result.detailFetchedCount === 0) {
      stoppedReason = "drained";
      break;
    }

    if (clock() - startedAt >= maxElapsedMs) {
      stoppedReason = "time_limit";
      break;
    }
  }

  return {
    startDate: options.startDate,
    endDate: options.endDate,
    batches: syncRuns.length,
    detailFetchedCount,
    sessionSavedCount,
    sourceIssueCount,
    syncRuns,
    drained: stoppedReason === "drained",
    stoppedReason,
  };
}
