import "server-only";

import { sql } from "drizzle-orm";

import { getCronJobDefinition } from "@/lib/data-health/cron-registry";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import { feedbackDeadlineUncoveredWhere } from "./repository";

// ── Feedback deadline coverage (FU1) ────────────────────────────────────
//
// A late or short submission is only charged by an assessment made after the
// class's feedback deadline. The collector's `deadline_crossed` lane exists to
// make that assessment happen; this check proves it keeps up, as a synthetic
// cron-watchdog entry. It reads the SAME predicate as the lane
// (`feedbackDeadlineUncoveredWhere`), only with the deadline pushed back by the
// threshold, so the two can never disagree about which sessions are owed.

/** Registry key of the collection cron whose lane this check speaks for. */
export const POST_CLASS_COLLECTION_JOB_KEY = "post_class_feedback";

/**
 * How long past its feedback deadline an eligible session may stay without a
 * post-deadline assessment before the watchdog alerts. Busy days put roughly
 * 200 crossings on one Bangkok midnight; at least 20 reserved lane slots on
 * each of 2 collection runs per hour clear that well inside 12 h.
 */
export const FEEDBACK_DEADLINE_COVERAGE_THRESHOLD_HOURS = 12;

export interface FeedbackDeadlineCoverage {
  stale: boolean;
  /** Eligible in-scope sessions more than the threshold past deadline, unassessed since. */
  overdueCount: number;
  oldestDeadlineAt: Date | null;
  thresholdHours: number;
  detail: string;
}

/**
 * Decide whether the post-deadline assessment backlog breaches the invariant
 * (pure). Any overdue session at all is a breach: the threshold already gives
 * the lane its time budget.
 */
export function classifyFeedbackDeadlineCoverage(input: {
  overdueCount: number;
  oldestDeadlineAt: Date | null;
  thresholdHours: number;
}): FeedbackDeadlineCoverage {
  const stale = input.overdueCount > 0;
  const oldest = input.oldestDeadlineAt?.toISOString() ?? "unknown";
  return {
    stale,
    overdueCount: input.overdueCount,
    oldestDeadlineAt: input.oldestDeadlineAt,
    thresholdHours: input.thresholdHours,
    detail: stale
      ? `${input.overdueCount} eligible session(s) passed the feedback deadline more than ${input.thresholdHours} h ago without a post-deadline assessment (oldest deadline ${oldest}); the collector's deadline_crossed lane is not keeping up.`
      : `No eligible session in the charging scope is more than ${input.thresholdHours} h past its feedback deadline without a post-deadline assessment.`,
  };
}

/**
 * Load the coverage verdict for the current instant, or `null` while the
 * collection cron is unscheduled.
 *
 * Arms itself with the schedule, like payout-window-health: while nothing
 * collects, nothing can re-observe a crossed deadline, so alerting would be
 * noise. One aggregate without GROUP BY, which Postgres always answers with
 * exactly one row; a missing row is therefore a failed read and throws (the
 * watchdog degrades that to "no entry this sweep").
 */
export async function loadFeedbackDeadlineCoverage(
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<FeedbackDeadlineCoverage | null> {
  if (!getCronJobDefinition(POST_CLASS_COLLECTION_JOB_KEY)?.schedule) return null;
  const thresholdHours = FEEDBACK_DEADLINE_COVERAGE_THRESHOLD_HOURS;
  const [row] = await db.select({
    overdueCount: sql<number | string>`count(*)::int`,
    oldestDeadlineAt: sql<Date | string | null>`min(${schema.postClassSessions.deadlineAt})`,
  }).from(schema.postClassSessions).where(feedbackDeadlineUncoveredWhere({
    now,
    deadlineBefore: new Date(now.getTime() - thresholdHours * 3_600_000),
  }));
  if (!row) throw new Error("Feedback deadline coverage query returned no aggregate row.");
  // neon-http hands back aggregate values as strings.
  return classifyFeedbackDeadlineCoverage({
    overdueCount: Number(row.overdueCount),
    oldestDeadlineAt: row.oldestDeadlineAt ? new Date(row.oldestDeadlineAt) : null,
    thresholdHours,
  });
}
