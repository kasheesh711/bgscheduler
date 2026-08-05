// ----------------------------------------------------------------------------
// Student monthly schedule -- live Wise overlay.
//
// getStudentMonthlySchedule() (data.ts) reads its base rows from the active
// credit-control snapshot, which can lag up to ~36 minutes behind Wise (the
// sync runs on a `20,50 * * * *` cron and takes ~6.5 min to promote). This
// module sweeps the requested Bangkok month directly from Wise, scoped to one
// student, so a reschedule, cancellation, or brand-new class is visible on
// the next read, not the next sync.
//
// Fail-soft is the entire point: any error, zod failure, or deadline overrun
// returns `ok: false` and an empty session list. Callers MUST treat
// `ok: false` as "render the snapshot exactly as before" -- this module never
// throws into the render path.
// ----------------------------------------------------------------------------

import { fetchInstituteSessionsForDays, type WiseCreditSession } from "@/lib/credit-control/wise";
import { createWiseClient } from "@/lib/wise/client";
import { getMonthWindow } from "@/lib/calendar/month-grid";
import { addBangkokDays, datesBetweenBangkok, todayBangkok } from "@/lib/room-capacity/dates";

// Measured against production (6 cold months, one student): min 1178ms,
// p50 1485ms, p95 2783ms. The current month is always the slowest because
// "today" needs both a PAST and a FUTURE sweep. 8s leaves ~3x headroom over
// p95 so a merely slow Wise day falls back to the snapshot only when Wise is
// genuinely unhealthy, rather than flapping between live and stale.
const DEFAULT_DEADLINE_MS = 8_000;
const CACHE_TTL_MS = 60_000;
/** Prune threshold. Entries are ~10 sessions each, so this stays trivial. */
const CACHE_MAX_ENTRIES = 500;

interface LiveMonthCacheEntry {
  sessions: WiseCreditSession[];
  expiresAt: number;
}

declare global {
  var __bgscheduler_liveMonthSessionsCache: Map<string, LiveMonthCacheEntry> | undefined;
}

function liveMonthSessionsCache(): Map<string, LiveMonthCacheEntry> {
  if (!globalThis.__bgscheduler_liveMonthSessionsCache) {
    globalThis.__bgscheduler_liveMonthSessionsCache = new Map();
  }
  return globalThis.__bgscheduler_liveMonthSessionsCache;
}

/**
 * Drops expired entries once the map grows past `CACHE_MAX_ENTRIES`. TTL alone
 * only stops a stale entry being *served* — it never removes it, so without
 * this a long-lived Fluid Compute instance accumulates one entry per
 * (student × month) ever requested and never gives the memory back.
 */
function pruneExpired(cache: Map<string, LiveMonthCacheEntry>, now: number): void {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

/**
 * Opt-out kill switch, matching `lineSchedulerEnabled()`'s idiom
 * (`src/lib/line/client.ts:19-20`). Unset, or anything other than the literal
 * string "false", leaves the live overlay enabled.
 */
export function studentScheduleLiveEnabled(): boolean {
  return process.env.ENABLE_STUDENT_SCHEDULE_LIVE !== "false";
}

/**
 * Races `promise` against a deadline. On timeout the returned promise
 * rejects; it does not cancel `promise`, which is left to settle in the
 * background and its result simply discarded (`Promise.race` already
 * attaches a handler to every input promise, so no unhandled-rejection
 * warning follows). Its lingering `setTimeout` -- at most `deadlineMs` -- is
 * a deliberate, negligible tradeoff to avoid needing a definite-assignment
 * dance to clear it.
 *
 * An AbortSignal is deliberately NOT threaded into the Wise client here:
 * `WiseClient.fetchWithRetry` retries on ANY caught error, including an
 * aborted fetch, which would burn its 1s/2s/4s backoff budget AFTER the
 * deadline already fired -- the opposite of what a deadline is for.
 */
function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Live sweep exceeded ${deadlineMs}ms deadline`)), deadlineMs);
  });
  return Promise.race([promise, timeout]);
}

/**
 * Sweeps every Wise session for `monthKey`'s Bangkok calendar month -- padded
 * by one day at each end -- filtered to `wiseStudentId`. Matches the
 * credit-control sync's own attribution (`session.students.includes(...)`,
 * `sync.ts:433`); no `studentKey` re-derivation.
 *
 * Padding, not trimming: Bangkok is UTC+7, so a session starting before
 * 07:00 Bangkok time falls on the previous UTC calendar day, and Wise's own
 * `startDate`/`endDate` day semantics toward that boundary are undocumented.
 * The 1-day pad at each end is a cheap, correct hedge regardless of which
 * timezone Wise applies internally. The exact Bangkok-month instant window is
 * deliberately NOT applied here -- `getStudentMonthlySchedule` (data.ts)
 * already computes `bangkokMonthInstantWindow` for its own DB query and
 * reuses that exact window to trim this result, so the precise cutoff lives
 * in exactly one place.
 */
async function sweepMonth(wiseStudentId: string, monthKey: string): Promise<WiseCreditSession[]> {
  const { from, to } = getMonthWindow(monthKey);
  const days = datesBetweenBangkok(addBangkokDays(from, -1), addBangkokDays(to, 1));
  const client = createWiseClient();
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";

  const sessions = await fetchInstituteSessionsForDays(client, instituteId, days, todayBangkok());
  return sessions.filter((session) => session.students.includes(wiseStudentId));
}

/**
 * Live overlay entry point. Returns `ok: false` -- never throws -- when the
 * kill switch is off, the sweep errors, or it exceeds `deadlineMs`; callers
 * treat that identically to "Wise is down" and render the snapshot unchanged.
 *
 * A successful sweep is memoized for `CACHE_TTL_MS` on a `globalThis`-
 * anchored Map keyed `wiseStudentId:monthKey`, storing only the already
 * student-filtered result -- never the raw institute-wide sweep -- so no
 * cache entry can leak one student's sessions into another student's
 * request. This collapses a parent refreshing the page, or opening the same
 * link from two devices, into one Wise sweep.
 */
export async function fetchLiveMonthSessions({
  wiseStudentId,
  monthKey,
  deadlineMs = DEFAULT_DEADLINE_MS,
}: {
  wiseStudentId: string;
  monthKey: string;
  deadlineMs?: number;
}): Promise<{ sessions: WiseCreditSession[]; ok: boolean }> {
  if (!studentScheduleLiveEnabled()) return { sessions: [], ok: false };

  const cacheKey = `${wiseStudentId}:${monthKey}`;
  const cache = liveMonthSessionsCache();
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { sessions: cached.sessions, ok: true };
  }

  try {
    const sessions = await withDeadline(sweepMonth(wiseStudentId, monthKey), deadlineMs);
    pruneExpired(cache, now);
    cache.set(cacheKey, { sessions, expiresAt: now + CACHE_TTL_MS });
    return { sessions, ok: true };
  } catch (error) {
    console.error(
      "fetchLiveMonthSessions: live sweep failed, falling back to snapshot:",
      error instanceof Error ? error.message : error,
    );
    return { sessions: [], ok: false };
  }
}
