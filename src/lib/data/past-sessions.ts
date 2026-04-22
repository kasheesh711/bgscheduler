import { cacheTag, cacheLife } from "next/cache";
import { and, inArray, gte, lt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { IndexedSessionBlock } from "@/lib/search/index";

/**
 * PAST-01 cached fetcher for captured past-session blocks (D-06 / D-08).
 *
 * Cache discipline:
 * - `cacheTag('past-sessions')` — EXPLICITLY SEPARATE from `'snapshot'`. The
 *   daily sync's snapshot-tag revalidation MUST NOT invalidate this cache.
 *   Past data is immutable once captured (D-03 first-observation wins).
 *   Manual past-sessions-tag revalidation is reserved for schema migrations
 *   or admin action (no admin utility route in v1.1 per Claude Discretion).
 * - `cacheLife('days')` — stale 5 min / revalidate 1 day / expire 1 week.
 *   Matches daily-sync cadence; aggressive enough to benefit same-day repeat
 *   queries, conservative enough that a schema migration is noticed within a
 *   week. Verified in-tree at node_modules/next/dist/docs/01-app/.../cacheLife.md:139.
 *
 * Security: this is a single-tenant app; all callers (/api/compare) pass
 * through `src/middleware.ts` auth. No cross-tenant leak risk. PII
 * (student_name/location) stays on the same auth boundary as
 * future_session_blocks.
 *
 * Testability: the inner `fetchPastSessionBlocksUncached` is exported
 * separately so Vitest can spy DB calls without the `'use cache'` boundary
 * obscuring them (research §Common Pitfalls §Pitfall 19). The cached wrapper
 * is intentionally trivial — the tag/life literals below are asserted via
 * grep in the companion test file and in Phase 7 VERIFICATION.md.
 */
export async function fetchPastSessionBlocksUncached(
  groupCanonicalKeys: string[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Map<string, IndexedSessionBlock[]>> {
  if (groupCanonicalKeys.length === 0) return new Map();

  const db = getDb();
  const rows = await db
    .select()
    .from(schema.pastSessionBlocks)
    .where(and(
      inArray(schema.pastSessionBlocks.groupCanonicalKey, groupCanonicalKeys),
      gte(schema.pastSessionBlocks.startTime, rangeStart),
      lt(schema.pastSessionBlocks.startTime, rangeEnd),
    ));

  // Bucket rows by canonical key so buildCompareTutor can merge per-group.
  const byCanonicalKey = new Map<string, IndexedSessionBlock[]>();
  for (const r of rows) {
    const block: IndexedSessionBlock = {
      startTime: new Date(r.startTime),
      endTime: new Date(r.endTime),
      weekday: r.weekday,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
      isBlocking: r.isBlocking,
      wiseTeacherId: r.wiseTeacherId,
      title: r.title ?? undefined,
      studentName: r.studentName ?? undefined,
      subject: r.subject ?? undefined,
      classType: r.classType ?? undefined,
      sessionType: r.sessionType ?? undefined,
      recurrenceId: r.recurrenceId ?? undefined,
      location: r.location ?? undefined,
    };
    const arr = byCanonicalKey.get(r.groupCanonicalKey) ?? [];
    arr.push(block);
    byCanonicalKey.set(r.groupCanonicalKey, arr);
  }
  return byCanonicalKey;
}

/**
 * Cached wrapper — callers in /api/compare (Plan 05) use THIS function.
 *
 * Cache key determinism: callers should pass a sorted `groupCanonicalKeys`
 * array so reordering of the tutor selection doesn't create unnecessary cache
 * entries. /api/compare route sorts before calling (Plan 05, Pattern 5).
 */
export async function fetchPastSessionBlocks(
  groupCanonicalKeys: string[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Map<string, IndexedSessionBlock[]>> {
  "use cache";
  cacheTag("past-sessions");
  cacheLife("days");
  return fetchPastSessionBlocksUncached(groupCanonicalKeys, rangeStart, rangeEnd);
}
