import { and, eq, sql } from "drizzle-orm";
import { toZonedTime } from "date-fns-tz";
import { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { NormalizedSessionBlock } from "@/lib/normalization/sessions";

// -- PAST-01 diff-hook --
// Captures sessions that existed in the prior snapshot's future_session_blocks
// but have (a) dropped out of Wise's newly-fetched FUTURE response and
// (b) startTime < now() Asia/Bangkok, into the cross-snapshot
// `past_session_blocks` table.
//
// Runs BEFORE atomic promotion (orchestrator.ts:440) so the prior snapshot
// is still `active=true` when the hook reads it.
//
// Idempotent via UNIQUE(wise_session_id) + ON CONFLICT DO NOTHING (D-03):
// double-observation across snapshots produces exactly one row.
//
// Per-group DB anomalies (e.g. a dangling groupId) emit `completeness`
// data_issues but NEVER abort the sync — error isolation mirrors the
// per-teacher availability loop at orchestrator.ts:240-250.
//
// This module intentionally has NO Next.js cache directive (the hook runs
// inside the sync pipeline, not an HTTP request) and NO cache-invalidation
// call (cache invalidation is the caller's responsibility — the orchestrator
// invalidates the snapshot tag elsewhere).

const INSERT_CHUNK_SIZE = 250;

/**
 * Data issue row shape produced by the diff-hook. Matches the `allIssues`
 * array shape in the orchestrator so the caller can forward these directly
 * to `schema.dataIssues` via `insertInChunks`.
 */
export interface DiffHookIssue {
  snapshotId: string;
  type: "completeness";
  severity: "medium";
  entityType: "past_session_block";
  entityId: string;
  entityName: string | null;
  message: string;
}

export interface DiffHookResult {
  capturedCount: number;
  issues: DiffHookIssue[];
  durationMs: number;
}

/**
 * PAST-01 diff-hook. Compares the prior active snapshot's
 * `future_session_blocks` against the newly-fetched Wise FUTURE list and
 * captures dropped past-start sessions into `past_session_blocks` with
 * ON CONFLICT DO NOTHING.
 *
 * MUST run BEFORE atomic promotion so the prior snapshot is still
 * `active=true` when the hook reads it.
 *
 * Neon HTTP driver has no transaction support — idempotency relies entirely
 * on UNIQUE(wise_session_id) + onConflictDoNothing. A crashed sync that
 * partially-inserted rows can safely re-run on the next cron tick.
 *
 * Per-group errors emit completeness data_issues; the hook never throws — a
 * diff-hook failure on one group does not abort the sync.
 */
export async function runPastSessionsDiffHook(
  db: Database,
  newWiseSessions: NormalizedSessionBlock[],
  newSnapshotId: string,
): Promise<DiffHookResult> {
  const startedAt = Date.now();
  const issues: DiffHookIssue[] = [];

  // 1. Find the currently-active (prior) snapshot. MUST run before promotion.
  const [priorSnapshot] = await db
    .select({ id: schema.snapshots.id })
    .from(schema.snapshots)
    .where(
      and(
        eq(schema.snapshots.active, true),
        sql`${schema.snapshots.id} != ${newSnapshotId}`,
      ),
    )
    .limit(1);

  if (!priorSnapshot) {
    // First-ever sync or prior active snapshot missing — nothing to diff.
    return { capturedCount: 0, issues, durationMs: Date.now() - startedAt };
  }

  // 2. Build prior groupId -> canonicalKey map (single batch SELECT).
  const priorGroups = await db
    .select({
      id: schema.tutorIdentityGroups.id,
      canonicalKey: schema.tutorIdentityGroups.canonicalKey,
    })
    .from(schema.tutorIdentityGroups)
    .where(eq(schema.tutorIdentityGroups.snapshotId, priorSnapshot.id));
  const priorGroupIdToCanonicalKey = new Map(
    priorGroups.map((g) => [g.id, g.canonicalKey]),
  );

  // 3. Read all prior-snapshot future_session_blocks in one query.
  const priorBlocks = await db
    .select()
    .from(schema.futureSessionBlocks)
    .where(eq(schema.futureSessionBlocks.snapshotId, priorSnapshot.id));

  // 4. Build O(1) lookup of wiseSessionIds present in the new Wise response.
  const newWiseSessionIds = new Set(newWiseSessions.map((s) => s.wiseSessionId));

  // 5. "Now" in Asia/Bangkok — used to test if a prior session has already started.
  const nowBkk = toZonedTime(new Date(), "Asia/Bangkok");

  // 6. Compute the "dropped" set: in prior, not in new, and startTime < now.
  const droppedRows: typeof schema.pastSessionBlocks.$inferInsert[] = [];
  for (const prior of priorBlocks) {
    if (newWiseSessionIds.has(prior.wiseSessionId)) continue; // still future — not dropped
    if (prior.startTime >= nowBkk) continue; // hasn't started yet
    const canonicalKey = priorGroupIdToCanonicalKey.get(prior.groupId);
    if (!canonicalKey) {
      issues.push({
        snapshotId: newSnapshotId,
        type: "completeness",
        severity: "medium",
        entityType: "past_session_block",
        entityId: prior.wiseSessionId,
        entityName: null,
        message: `Diff-hook: could not resolve group_canonical_key for prior-snapshot groupId=${prior.groupId}; skipping capture of wise_session_id=${prior.wiseSessionId}`,
      });
      continue;
    }
    droppedRows.push({
      groupCanonicalKey: canonicalKey,
      capturedInSnapshotId: newSnapshotId,
      wiseTeacherId: prior.wiseTeacherId,
      wiseSessionId: prior.wiseSessionId,
      startTime: prior.startTime,
      endTime: prior.endTime,
      weekday: prior.weekday,
      startMinute: prior.startMinute,
      endMinute: prior.endMinute,
      wiseStatus: prior.wiseStatus,
      isBlocking: prior.isBlocking,
      title: prior.title,
      sessionType: prior.sessionType,
      location: prior.location,
      studentName: prior.studentName,
      subject: prior.subject,
      classType: prior.classType,
      recurrenceId: prior.recurrenceId,
    });
  }

  // 7. Chunked insert with ON CONFLICT DO NOTHING (D-03 / PAST-05).
  let capturedCount = 0;
  for (let i = 0; i < droppedRows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = droppedRows.slice(i, i + INSERT_CHUNK_SIZE);
    const result = await db
      .insert(schema.pastSessionBlocks)
      .values(chunk)
      .onConflictDoNothing({ target: schema.pastSessionBlocks.wiseSessionId })
      .returning({ id: schema.pastSessionBlocks.id });
    capturedCount += result.length;
  }

  return {
    capturedCount,
    issues,
    durationMs: Date.now() - startedAt,
  };
}
