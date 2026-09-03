import { inArray, sql } from "drizzle-orm";
import { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { NEAR_HORIZON_DAYS, resolveAvailabilityHorizonDays } from "./fetchers";
import type { WiseLeave } from "./types";

// ── AVAIL-01 far-leave cache repository ──────────────────────────────────
//
// Cross-snapshot cache of the FAR availability window (days 28..horizon), which
// costs 22 of the 26 Wise calls per teacher per run and in practice yields
// almost nothing. Wise rejects any availability span wider than 7 days (HTTP
// 400), so the only lever is fetching the far windows LESS OFTEN.
//
// THE READ RULE, load-bearing: a cache miss, a stale row, or a read error is
// ALWAYS a live fetch. Never substitute an empty leave set for an unfetched one.
// `src/lib/search/engine.ts` decides leave conflicts with `Array.some()`, so a
// missing leave row is indistinguishable from "no leave" and the tutor is
// reported Available — fail-OPEN. Every failure path here therefore degrades to
// "fetch it live", never to "assume no leaves".

export interface FarLeaveCacheRow {
  teacherUserId: string;
  farLeaves: WiseLeave[];
  farHorizonDays: number;
  farWindowStartDay: number;
  fetchedAt: Date;
  fetchError: string | null;
}

export interface FarCacheShape {
  farHorizonDays: number;
  farWindowStartDay: number;
}

const SELECT_CHUNK_SIZE = 500;
const UPSERT_CHUNK_SIZE = 250;

/**
 * The horizon shape the CURRENT configuration would produce. A cached row whose
 * shape differs covers a different span than the caller is about to assume, so
 * `isFarCacheFresh` rejects it — changing WISE_AVAILABILITY_HORIZON_DAYS
 * invalidates the cache rather than silently under-covering.
 */
export function currentFarCacheShape(): FarCacheShape {
  return {
    farHorizonDays: resolveAvailabilityHorizonDays(),
    farWindowStartDay: NEAR_HORIZON_DAYS,
  };
}

/**
 * Whether a cached far-leave row may be reused instead of refetched.
 *
 * Pure — `expected` defaults to the configured shape, but tests (and any caller
 * that already resolved the shape once per run) pass it explicitly.
 *
 * False when:
 *   1. the row is missing — never seen this teacher;
 *   2. maxAgeMinutes is 0 — the operator disabled the cache;
 *   3. `fetchError` is set — the row records a FAILED fetch, and its leave array
 *      is therefore not evidence of anything;
 *   4. the horizon shape changed — the row covers a different span;
 *   5. the row is older than maxAgeMinutes.
 */
export function isFarCacheFresh(
  row: FarLeaveCacheRow | null | undefined,
  now: Date,
  maxAgeMinutes: number,
  expected: FarCacheShape = currentFarCacheShape(),
): boolean {
  if (!row) return false;
  if (maxAgeMinutes <= 0) return false;
  if (row.fetchError) return false;
  if (row.farHorizonDays !== expected.farHorizonDays) return false;
  if (row.farWindowStartDay !== expected.farWindowStartDay) return false;

  const ageMs = now.getTime() - row.fetchedAt.getTime();
  // A future fetchedAt (clock skew) reads as age 0 — still fresh, still bounded
  // by the horizon shape check above.
  if (ageMs < 0) return true;
  return ageMs <= maxAgeMinutes * 60 * 1000;
}

/**
 * Load cached far-leave rows for the given Wise teacher user ids.
 *
 * Returns an EMPTY map on any read failure — a missing table (migration not yet
 * applied), a transient Neon error, anything. An empty map means every teacher
 * misses the cache and is fetched live, which is slow but correct. Throwing
 * here would abort the sync; returning partial-but-plausible data would be
 * worse than either.
 */
export async function loadFarLeaveCache(
  db: Database,
  teacherUserIds: string[],
): Promise<Map<string, FarLeaveCacheRow>> {
  const ids = [...new Set(teacherUserIds.filter(Boolean))];
  const cache = new Map<string, FarLeaveCacheRow>();
  if (ids.length === 0) return cache;

  try {
    for (let i = 0; i < ids.length; i += SELECT_CHUNK_SIZE) {
      const rows = await db
        .select()
        .from(schema.wiseTeacherAvailabilityCache)
        .where(
          inArray(
            schema.wiseTeacherAvailabilityCache.teacherUserId,
            ids.slice(i, i + SELECT_CHUNK_SIZE),
          ),
        );

      for (const row of rows) {
        cache.set(row.teacherUserId, {
          teacherUserId: row.teacherUserId,
          farLeaves: (row.farLeaves ?? []) as WiseLeave[],
          farHorizonDays: row.farHorizonDays,
          farWindowStartDay: row.farWindowStartDay,
          fetchedAt: new Date(row.fetchedAt),
          fetchError: row.fetchError,
        });
      }
    }
    return cache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("wise_teacher_availability_cache") || message.includes("does not exist")) {
      console.info(
        "wise_teacher_availability_cache is unavailable; every teacher will fetch far leaves live.",
      );
    } else {
      console.error("[wise-availability-cache] far-leave cache read failed:", message);
    }
    return new Map();
  }
}

export type FarLeaveCacheUpsert = Pick<
  FarLeaveCacheRow,
  "teacherUserId" | "farLeaves" | "farHorizonDays" | "farWindowStartDay"
> & { fetchedAt?: Date; fetchError?: string | null };

/**
 * Upsert far-leave rows, keyed on teacherUserId.
 *
 * Swallows write failures on purpose: this is a cache, and the sync that
 * produced the data has already succeeded. A missing table would otherwise turn
 * a healthy sync into a failed one the moment this code deploys ahead of its
 * migration.
 *
 * @returns how many rows were written (0 when the write failed).
 */
export async function saveFarLeaveCache(
  db: Database,
  rows: FarLeaveCacheUpsert[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const values: typeof schema.wiseTeacherAvailabilityCache.$inferInsert[] = rows.map((row) => ({
    teacherUserId: row.teacherUserId,
    farLeaves: row.farLeaves as unknown[],
    farHorizonDays: row.farHorizonDays,
    farWindowStartDay: row.farWindowStartDay,
    fetchedAt: row.fetchedAt ?? new Date(),
    fetchError: row.fetchError ?? null,
  }));

  try {
    for (let i = 0; i < values.length; i += UPSERT_CHUNK_SIZE) {
      await db
        .insert(schema.wiseTeacherAvailabilityCache)
        .values(values.slice(i, i + UPSERT_CHUNK_SIZE))
        .onConflictDoUpdate({
          target: schema.wiseTeacherAvailabilityCache.teacherUserId,
          set: {
            farLeaves: sql`excluded.far_leaves`,
            farHorizonDays: sql`excluded.far_horizon_days`,
            farWindowStartDay: sql`excluded.far_window_start_day`,
            fetchedAt: sql`excluded.fetched_at`,
            fetchError: sql`excluded.fetch_error`,
          },
        });
    }
    return values.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[wise-availability-cache] far-leave cache write failed:", message);
    return 0;
  }
}
