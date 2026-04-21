import { NextResponse } from "next/server";
import { eq, desc, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { selectModalityIssues as _selectModalityIssues } from "./modality-counter";

/**
 * Re-export of the MOD-03 / D-10 modality-counter helper.
 *
 * The helper filters raw data_issues into the page-consumed "unresolvedModality"
 * list, covering BOTH legacy group-level `"modality"` issues (emitted by
 * `deriveModality` per-tutor-group) AND session-level `"conflict_model"` issues
 * (emitted by `detectSessionModalityConflict` during sync orchestration).
 * Surfaced as one admin-facing "Modality issues" number.
 *
 * The counter is expected to rise after MOD-01 ships — surface-of-reality
 * per D-11, not a regression.
 *
 * The implementation lives in `./modality-counter.ts` so Vitest can import
 * and test it without triggering the full Next.js route module graph (which
 * transitively imports `next-auth`, whose ESM subpath `next/server` cannot
 * be resolved by Vitest's bare Node resolver).
 */
export function selectModalityIssues<
  T extends { type: string; entityName: string | null; message: string },
>(
  issues: T[],
): { entityName: string; message: string; issueType: string }[] {
  return _selectModalityIssues(issues);
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();

  // Last successful sync
  const [lastSuccess] = await db
    .select()
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, "success"))
    .orderBy(desc(schema.syncRuns.finishedAt))
    .limit(1);

  // Last failed sync
  const [lastFailure] = await db
    .select()
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, "failed"))
    .orderBy(desc(schema.syncRuns.finishedAt))
    .limit(1);

  // Active snapshot stats
  const [activeSnapshot] = await db
    .select()
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);

  let stats = null;
  let issuesByType: Record<string, number> = {};
  let unresolvedAliases: { entityName: string; message: string }[] = [];
  let unresolvedModality: { entityName: string; message: string; issueType: string }[] = [];
  let unmappedTags: { entityName: string; message: string }[] = [];

  if (activeSnapshot) {
    const [snapshotStat] = await db
      .select()
      .from(schema.snapshotStats)
      .where(eq(schema.snapshotStats.snapshotId, activeSnapshot.id))
      .limit(1);

    stats = snapshotStat;
    issuesByType = (snapshotStat?.issuesByType as Record<string, number>) ?? {};

    // Get detailed issues
    const issues = await db
      .select()
      .from(schema.dataIssues)
      .where(eq(schema.dataIssues.snapshotId, activeSnapshot.id));

    unresolvedAliases = issues
      .filter((i) => i.type === "alias")
      .map((i) => ({ entityName: i.entityName ?? "", message: i.message }));

    // MOD-03 / D-10: modality counter now includes BOTH legacy group-level
    // `modality` issues (from deriveModality) AND session-level `conflict_model`
    // issues (from detectSessionModalityConflict in the sync orchestrator).
    // Surfaced as one admin-facing "Modality issues" number per D-10.
    // Post-deploy the count is expected to rise — surface-of-reality per D-11,
    // not a regression.
    unresolvedModality = selectModalityIssues(issues);

    unmappedTags = issues
      .filter((i) => i.type === "tag")
      .map((i) => ({ entityName: i.entityName ?? "", message: i.message }));
  }

  // Stale age
  const staleAgeMs = lastSuccess?.finishedAt
    ? Date.now() - new Date(lastSuccess.finishedAt).getTime()
    : null;

  // Recent sync history
  const recentSyncs = await db
    .select()
    .from(schema.syncRuns)
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(10);

  return NextResponse.json({
    lastSuccessfulSync: lastSuccess?.finishedAt ?? null,
    lastFailedSync: lastFailure?.finishedAt ?? null,
    lastFailureError: lastFailure?.errorSummary ?? null,
    staleAgeMs,
    staleMinutes: staleAgeMs ? Math.round(staleAgeMs / 60000) : null,
    activeSnapshotId: activeSnapshot?.id ?? null,
    stats: stats
      ? {
          totalWiseTeachers: stats.totalWiseTeachers,
          totalIdentityGroups: stats.totalIdentityGroups,
          resolvedGroups: stats.resolvedGroups,
          unresolvedGroups: stats.unresolvedGroups,
          totalDataIssues: stats.totalDataIssues,
        }
      : null,
    issuesByType,
    unresolvedAliases,
    unresolvedModality,
    unmappedTags,
    recentSyncs: recentSyncs.map((s) => ({
      id: s.id,
      status: s.status,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      teacherCount: s.teacherCount,
      errorSummary: s.errorSummary,
    })),
  });
}
