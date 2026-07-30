import "server-only";

import { and, asc, eq, ne, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { addBangkokDays, todayBangkok } from "@/lib/room-capacity/dates";

// ── Automatic backfill window selection ─────────────────────────────────
//
// The rolling cron only ever looks at the last four days, so history is
// reconciled by a separate backfill. Left to a human that means picking dates
// by hand every day; instead each backfill run starts from the oldest session
// that is still not `ready` and walks forward from there, so repeated runs
// converge on their own.

const BACKFILL_WINDOW_DAYS = 4;

export interface PostClassBackfillWindow {
  startDate: string;
  endDate: string;
}

/**
 * The window a backfill should work on next: `windowDays` of Bangkok calendar
 * dates starting at the oldest eligible session whose source is not yet
 * `ready`, clamped so it never runs past today.
 *
 * Returns null when every eligible session is reconciled — the caller should
 * treat that as "nothing to do", not as a failure.
 */
export async function findOldestUnreconciledBackfillWindow(
  db: Database = getDb(),
  options: { windowDays?: number; now?: Date } = {},
): Promise<PostClassBackfillWindow | null> {
  const windowDays = Math.max(1, Math.min(options.windowDays ?? BACKFILL_WINDOW_DAYS, 31));
  const [row] = await db.select({
    // Bucket by the Bangkok calendar date the session ended on, which is the
    // unit the collector's window is expressed in.
    startDate: sql<string>`to_char(${schema.postClassSessions.scheduledEndAt} at time zone 'Asia/Bangkok', 'YYYY-MM-DD')`,
  }).from(schema.postClassSessions).where(and(
    eq(schema.postClassSessions.eligible, true),
    ne(schema.postClassSessions.sourceStatus, "ready"),
  )).orderBy(asc(schema.postClassSessions.scheduledEndAt)).limit(1);

  if (!row?.startDate) return null;

  const today = todayBangkok(options.now);
  const proposedEnd = addBangkokDays(row.startDate, windowDays - 1);
  return {
    startDate: row.startDate,
    endDate: proposedEnd > today ? today : proposedEnd,
  };
}
