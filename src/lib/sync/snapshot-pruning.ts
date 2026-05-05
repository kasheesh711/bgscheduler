import { desc, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export const SNAPSHOT_RETENTION_COUNT = 30;

export interface SnapshotPruningResult {
  attempted: true;
  retentionCount: number;
  protectedSnapshotIds: string[];
  prunedSnapshotIds: string[];
  deletedSnapshots: number;
  rowCounts: {
    syncRunsSnapshotIdNullified: number;
    syncRunsPromotedSnapshotIdNullified: number;
    snapshotStats: number;
    dataIssues: number;
    futureSessionBlocks: number;
    datedLeaves: number;
    recurringAvailabilityWindows: number;
    rawTeacherTags: number;
    subjectLevelQualifications: number;
    tutors: number;
    tutorIdentityGroupMembers: number;
    tutorIdentityGroups: number;
    snapshots: number;
  };
  durationMs: number;
}

function emptyRowCounts(): SnapshotPruningResult["rowCounts"] {
  return {
    syncRunsSnapshotIdNullified: 0,
    syncRunsPromotedSnapshotIdNullified: 0,
    snapshotStats: 0,
    dataIssues: 0,
    futureSessionBlocks: 0,
    datedLeaves: 0,
    recurringAvailabilityWindows: 0,
    rawTeacherTags: 0,
    subjectLevelQualifications: 0,
    tutors: 0,
    tutorIdentityGroupMembers: 0,
    tutorIdentityGroups: 0,
    snapshots: 0,
  };
}

export async function pruneOldSnapshots(
  db: Database,
  retentionCount = SNAPSHOT_RETENTION_COUNT,
): Promise<SnapshotPruningResult> {
  const startedAt = Date.now();
  const rowCounts = emptyRowCounts();

  const snapshots = await db
    .select({
      id: schema.snapshots.id,
      active: schema.snapshots.active,
    })
    .from(schema.snapshots)
    .orderBy(desc(schema.snapshots.createdAt));

  const protectedSnapshotIds = new Set<string>();
  for (const snapshot of snapshots.slice(0, retentionCount)) {
    protectedSnapshotIds.add(snapshot.id);
  }
  for (const snapshot of snapshots) {
    if (snapshot.active) protectedSnapshotIds.add(snapshot.id);
  }

  const prunedSnapshotIds = snapshots
    .filter((snapshot) => !protectedSnapshotIds.has(snapshot.id))
    .map((snapshot) => snapshot.id);

  if (prunedSnapshotIds.length === 0) {
    return {
      attempted: true,
      retentionCount,
      protectedSnapshotIds: [...protectedSnapshotIds],
      prunedSnapshotIds,
      deletedSnapshots: 0,
      rowCounts,
      durationMs: Date.now() - startedAt,
    };
  }

  rowCounts.syncRunsSnapshotIdNullified = (
    await db
      .update(schema.syncRuns)
      .set({ snapshotId: null })
      .where(inArray(schema.syncRuns.snapshotId, prunedSnapshotIds))
      .returning({ id: schema.syncRuns.id })
  ).length;

  rowCounts.syncRunsPromotedSnapshotIdNullified = (
    await db
      .update(schema.syncRuns)
      .set({ promotedSnapshotId: null })
      .where(inArray(schema.syncRuns.promotedSnapshotId, prunedSnapshotIds))
      .returning({ id: schema.syncRuns.id })
  ).length;

  rowCounts.snapshotStats = (
    await db
      .delete(schema.snapshotStats)
      .where(inArray(schema.snapshotStats.snapshotId, prunedSnapshotIds))
      .returning({ id: schema.snapshotStats.id })
  ).length;

  rowCounts.dataIssues = (
    await db
      .delete(schema.dataIssues)
      .where(inArray(schema.dataIssues.snapshotId, prunedSnapshotIds))
      .returning({ id: schema.dataIssues.id })
  ).length;

  rowCounts.futureSessionBlocks = (
    await db
      .delete(schema.futureSessionBlocks)
      .where(inArray(schema.futureSessionBlocks.snapshotId, prunedSnapshotIds))
      .returning({ id: schema.futureSessionBlocks.id })
  ).length;

  rowCounts.datedLeaves = (
    await db
      .delete(schema.datedLeaves)
      .where(inArray(schema.datedLeaves.snapshotId, prunedSnapshotIds))
      .returning({ id: schema.datedLeaves.id })
  ).length;

  rowCounts.recurringAvailabilityWindows = (
    await db
      .delete(schema.recurringAvailabilityWindows)
      .where(inArray(schema.recurringAvailabilityWindows.snapshotId, prunedSnapshotIds))
      .returning({ id: schema.recurringAvailabilityWindows.id })
  ).length;

  rowCounts.rawTeacherTags = (
    await db
      .delete(schema.rawTeacherTags)
      .where(inArray(schema.rawTeacherTags.snapshotId, prunedSnapshotIds))
      .returning({ id: schema.rawTeacherTags.id })
  ).length;

  rowCounts.subjectLevelQualifications = (
    await db
      .delete(schema.subjectLevelQualifications)
      .where(inArray(schema.subjectLevelQualifications.snapshotId, prunedSnapshotIds))
      .returning({ id: schema.subjectLevelQualifications.id })
  ).length;

  rowCounts.tutors = (
    await db
      .delete(schema.tutors)
      .where(inArray(schema.tutors.snapshotId, prunedSnapshotIds))
      .returning({ id: schema.tutors.id })
  ).length;

  rowCounts.tutorIdentityGroupMembers = (
    await db
      .delete(schema.tutorIdentityGroupMembers)
      .where(inArray(schema.tutorIdentityGroupMembers.snapshotId, prunedSnapshotIds))
      .returning({ id: schema.tutorIdentityGroupMembers.id })
  ).length;

  rowCounts.tutorIdentityGroups = (
    await db
      .delete(schema.tutorIdentityGroups)
      .where(inArray(schema.tutorIdentityGroups.snapshotId, prunedSnapshotIds))
      .returning({ id: schema.tutorIdentityGroups.id })
  ).length;

  rowCounts.snapshots = (
    await db
      .delete(schema.snapshots)
      .where(inArray(schema.snapshots.id, prunedSnapshotIds))
      .returning({ id: schema.snapshots.id })
  ).length;

  return {
    attempted: true,
    retentionCount,
    protectedSnapshotIds: [...protectedSnapshotIds],
    prunedSnapshotIds,
    deletedSnapshots: rowCounts.snapshots,
    rowCounts,
    durationMs: Date.now() - startedAt,
  };
}
