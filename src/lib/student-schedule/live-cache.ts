import { sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { WiseCreditSessionSchema, type WiseCreditSession } from "@/lib/credit-control/wise";

export interface LiveMonthEntry {
  sessions: WiseCreditSession[] | null;
  fetchedAt: Date | null;
  publishedAt: Date | null;
  retryAfter: Date | null;
}

export interface LiveMonthCache {
  read(key: string): Promise<LiveMonthEntry | null>;
  claim(key: string, token: string, now: Date, force: boolean, requestedAt: Date): Promise<boolean>;
  publish(key: string, token: string, sessions: WiseCreditSession[], fetchedAt: Date): Promise<boolean>;
  fail(key: string, token: string): Promise<void>;
}

/** All updates are fenced by the refresh token. No lock spans a Wise request. */
export function createLiveMonthCache(db: Database): LiveMonthCache {
  return {
    async read(key) {
      const result = await db.execute(sql`select sessions, fetched_at, published_at, retry_after from student_schedule_live_cache where cache_key = ${key}`);
      const row = result.rows[0];
      if (!row) return null;
      return {
        sessions: row.sessions === null ? null : WiseCreditSessionSchema.array().parse(row.sessions),
        fetchedAt: row.fetched_at ? new Date(row.fetched_at as string) : null,
        publishedAt: row.published_at ? new Date(row.published_at as string) : null,
        retryAfter: row.retry_after ? new Date(row.retry_after as string) : null,
      };
    },
    async claim(key, token, now, force, requestedAt) {
      const result = await db.execute(sql`
        insert into student_schedule_live_cache (cache_key, lease_token, lease_expires_at)
        values (${key}, ${token}::uuid, clock_timestamp() + interval '12 seconds')
        on conflict (cache_key) do update set lease_token = excluded.lease_token, lease_expires_at = excluded.lease_expires_at
        where (student_schedule_live_cache.lease_expires_at is null or student_schedule_live_cache.lease_expires_at <= clock_timestamp())
          and (student_schedule_live_cache.retry_after is null or student_schedule_live_cache.retry_after <= clock_timestamp())
          and (student_schedule_live_cache.fetched_at is null or student_schedule_live_cache.fetched_at <= ${new Date(now.getTime() - 60_000)}
            or (${force} and student_schedule_live_cache.published_at < ${requestedAt}))
        returning cache_key`);
      return result.rows.length === 1;
    },
    async publish(key, token, sessions, fetchedAt) {
      const result = await db.execute(sql`update student_schedule_live_cache
        set sessions = ${JSON.stringify(sessions)}::jsonb, fetched_at = ${fetchedAt}, published_at = clock_timestamp(),
          lease_token = null, lease_expires_at = null, retry_after = null
        where cache_key = ${key} and lease_token = ${token}::uuid returning cache_key`);
      return result.rows.length === 1;
    },
    async fail(key, token) {
      await db.execute(sql`update student_schedule_live_cache set lease_token = null, lease_expires_at = null,
        retry_after = clock_timestamp() + interval '30 seconds' where cache_key = ${key} and lease_token = ${token}::uuid`);
    },
  };
}
