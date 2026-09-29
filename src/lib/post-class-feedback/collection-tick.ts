import "server-only";

import { NextResponse } from "next/server";

import { processPostClassAiReviews } from "./ai";
import { runPostClassDeductionHygiene } from "./auto-approval";
import { processDuePostClassNotificationRetries } from "./notifications";
import { PostClassFeedbackSyncAlreadyRunningError, type PostClassSyncTrigger } from "./repository";
import {
  runPostClassFeedbackSync,
  type SyncPostClassFeedbackOptions,
  type SyncPostClassFeedbackResult,
} from "./sync";

// ── The post-class collection tick ──────────────────────────────────────
//
// One tick is the rolling collector's sync followed by its three post-sync
// passes. The cron (`sync-post-class-feedback`), Data Health's
// `post_class_feedback` Run and the Post-Class Feedback page's collect mode all
// run this one function, so their passes cannot drift apart.

/**
 * A tick's sync inputs: the rolling window, or one explicit Bangkok date range
 * for a backfill. A reminder-checkpoint sync is not a tick.
 */
export type PostClassCollectionTickOptions =
  Pick<SyncPostClassFeedbackOptions, "actorEmail" | "detailCap" | "startDate" | "endDate">
  & { triggerType: PostClassSyncTrigger };

type SettledPass<T> = T | { failed: true };

export interface PostClassCollectionTickResult {
  ok: true;
  result: SyncPostClassFeedbackResult;
  ai: SettledPass<Awaited<ReturnType<typeof processPostClassAiReviews>>>;
  retries: SettledPass<Awaited<ReturnType<typeof processDuePostClassNotificationRetries>>>;
  hygiene: SettledPass<Awaited<ReturnType<typeof runPostClassDeductionHygiene>>>;
}

const LOG_TAG = "[post-class-collection-tick]";
/** Every caller runs with maxDuration 800s; the AI pass starts no model call after 10 minutes into the tick. */
const AI_REVIEW_BUDGET_MS = 10 * 60 * 1_000;

/**
 * The error's class only. Driver, Wise and OpenAI messages can carry SQL,
 * parameters or feedback text, and these passes move deductions.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function settledPass<T>(
  pass: "ai" | "retries" | "hygiene",
  outcome: PromiseSettledResult<T>,
): SettledPass<T> {
  if (outcome.status === "fulfilled") return outcome.value;
  // The tick still answers 200, so without this line a rejected pass leaves no log.
  console.error(LOG_TAG, { pass, errorName: errorName(outcome.reason) });
  return { failed: true };
}

/**
 * Runs one post-class collection tick.
 *
 * 1. Sync with `options`. A sync error propagates before any pass runs, and the
 *    caller maps it: the cron and Data Health through
 *    {@link runPostClassCollectionTickRequest}, the page through its own mapper.
 * 2. Once the sync resolves, run the AI quality review (with a deadline 10
 *    minutes after the tick started), due notification retries and deduction
 *    hygiene in one `Promise.allSettled`. Hygiene reopens unproven approvals and
 *    waives deductions on sessions the sync just found ineligible (e.g.
 *    cancelled in Wise); it releases claims only, never approves.
 * 3. A rejected pass becomes `{ failed: true }` and is logged by pass name and
 *    error class; the other passes still report.
 */
export async function runPostClassCollectionTick(
  options: PostClassCollectionTickOptions,
): Promise<PostClassCollectionTickResult> {
  const startedAt = Date.now();
  const result = await runPostClassFeedbackSync(options);
  const [ai, retries, hygiene] = await Promise.allSettled([
    processPostClassAiReviews({ deadlineAt: startedAt + AI_REVIEW_BUDGET_MS }),
    processDuePostClassNotificationRetries(),
    runPostClassDeductionHygiene(),
  ]);
  return {
    ok: true,
    result,
    ai: settledPass("ai", ai),
    retries: settledPass("retries", retries),
    hygiene: settledPass("hygiene", hygiene),
  };
}

/**
 * One tick with the cron route's HTTP mapping, returned verbatim by the cron and
 * by Data Health's Run:
 * - `200` with the tick result, including any `{ failed: true }` pass;
 * - `409` with the typed error's own message when a sync is already running or
 *   is deferred by a live payout lease;
 * - otherwise a fixed `500` that never echoes the thrown message. The failure is
 *   logged by error class, including one thrown before the sync run row exists
 *   (an unset `WISE_INSTITUTE_ID`, a database error in `beginSync`), which has
 *   no `post_class_sync_runs` row to explain it.
 */
export async function runPostClassCollectionTickRequest(options: PostClassCollectionTickOptions) {
  try {
    return NextResponse.json(await runPostClassCollectionTick(options));
  } catch (error) {
    if (error instanceof PostClassFeedbackSyncAlreadyRunningError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error(LOG_TAG, { pass: "sync", errorName: errorName(error) });
    return NextResponse.json({ error: "Post-class feedback sync failed" }, { status: 500 });
  }
}
