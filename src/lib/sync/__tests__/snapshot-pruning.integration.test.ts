import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { pruneOldSnapshots, SNAPSHOT_RETENTION_COUNT } from "@/lib/sync/snapshot-pruning";
import * as schema from "@/lib/db/schema";
import type { Database } from "@/lib/db";

let handle: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
  handle = await startTestDb();
}, 60_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await truncateAll(handle.db);
});

interface SeededSnapshot {
  id: string;
  groupId: string;
  createdAt: Date;
}

async function seedSnapshot(index: number, opts?: { active?: boolean }): Promise<SeededSnapshot> {
  const createdAt = new Date(Date.UTC(2026, 0, index + 1, 0, 0, 0));
  const [snapshot] = await handle.db
    .insert(schema.snapshots)
    .values({ active: opts?.active ?? false, createdAt })
    .returning({ id: schema.snapshots.id });

  const [group] = await handle.db
    .insert(schema.tutorIdentityGroups)
    .values({
      snapshotId: snapshot.id,
      canonicalKey: `tutor-${index}`,
      displayName: `Tutor ${index}`,
      supportedModality: "onsite",
    })
    .returning({ id: schema.tutorIdentityGroups.id });

  await handle.db.insert(schema.tutorIdentityGroupMembers).values({
    groupId: group.id,
    snapshotId: snapshot.id,
    wiseTeacherId: `teacher-${index}`,
    wiseUserId: `user-${index}`,
    wiseDisplayName: `Tutor ${index}`,
    isOnlineVariant: false,
  });

  await handle.db.insert(schema.tutors).values({
    snapshotId: snapshot.id,
    groupId: group.id,
    displayName: `Tutor ${index}`,
    supportedModes: ["onsite"],
  });

  await handle.db.insert(schema.snapshotStats).values({
    snapshotId: snapshot.id,
    totalWiseTeachers: 1,
    totalIdentityGroups: 1,
    resolvedGroups: 1,
    totalFutureSessions: 1,
  });

  await handle.db.insert(schema.dataIssues).values({
    snapshotId: snapshot.id,
    type: "completeness",
    severity: "low",
    entityType: "snapshot",
    entityId: snapshot.id,
    entityName: `Snapshot ${index}`,
    message: `Synthetic issue for snapshot ${index}`,
  });

  await handle.db.insert(schema.futureSessionBlocks).values({
    snapshotId: snapshot.id,
    groupId: group.id,
    wiseTeacherId: `teacher-${index}`,
    wiseSessionId: `session-${index}`,
    startTime: new Date(Date.UTC(2030, 0, 1, 10, 0, 0)),
    endTime: new Date(Date.UTC(2030, 0, 1, 11, 0, 0)),
    weekday: 2,
    startMinute: 600,
    endMinute: 660,
    wiseStatus: "CONFIRMED",
    isBlocking: true,
  });

  return { id: snapshot.id, groupId: group.id, createdAt };
}

async function seedSnapshots(count: number, opts?: { activeIndex?: number }) {
  const snapshots: SeededSnapshot[] = [];
  for (let i = 0; i < count; i += 1) {
    snapshots.push(await seedSnapshot(i, { active: opts?.activeIndex === i }));
  }
  return snapshots;
}

async function tableSnapshotIds<T extends { snapshotId: string }>(
  table: { _: { name: string } },
  snapshotIds: string[],
) {
  if (snapshotIds.length === 0) return [];
  return handle.db
    .select()
    .from(table as never)
    .where(inArray((table as never as { snapshotId: unknown }).snapshotId, snapshotIds as never));
}

describe("pruneOldSnapshots — OPS-01 integration (real Postgres)", () => {
  it("retains the latest 30 snapshots and the active snapshot while pruning older inactive rows", async () => {
    const snapshots = await seedSnapshots(33, { activeIndex: 0 });
    const activeOlderThanRetention = snapshots[0];
    const pruned = snapshots.slice(1, 3);
    const latestThirty = snapshots.slice(3);
    const prunedIds = pruned.map((s) => s.id);

    await handle.db.insert(schema.syncRuns).values({
      status: "success",
      snapshotId: pruned[0].id,
      promotedSnapshotId: pruned[1].id,
    });

    await handle.db.insert(schema.pastSessionBlocks).values({
      groupCanonicalKey: "historical-tutor",
      capturedInSnapshotId: pruned[0].id,
      wiseTeacherId: "teacher-historical",
      wiseSessionId: "past-session-sentinel",
      startTime: new Date(Date.UTC(2025, 11, 1, 10, 0, 0)),
      endTime: new Date(Date.UTC(2025, 11, 1, 11, 0, 0)),
      weekday: 1,
      startMinute: 600,
      endMinute: 660,
      wiseStatus: "CONFIRMED",
      isBlocking: true,
    });
    const pastBefore = await handle.db.select().from(schema.pastSessionBlocks);

    const result = await pruneOldSnapshots(
      handle.db as unknown as Database,
      SNAPSHOT_RETENTION_COUNT,
    );

    expect(result).toMatchObject({
      attempted: true,
      retentionCount: 30,
      deletedSnapshots: 2,
    });
    expect(result.prunedSnapshotIds.sort()).toEqual(prunedIds.sort());
    expect(result.protectedSnapshotIds).toContain(activeOlderThanRetention.id);
    expect(latestThirty.every((s) => result.protectedSnapshotIds.includes(s.id))).toBe(true);

    const remainingSnapshots = await handle.db.select().from(schema.snapshots);
    expect(remainingSnapshots.map((s) => s.id).sort()).toEqual(
      [activeOlderThanRetention.id, ...latestThirty.map((s) => s.id)].sort(),
    );

    const [syncRun] = await handle.db.select().from(schema.syncRuns);
    expect(syncRun.snapshotId).toBeNull();
    expect(syncRun.promotedSnapshotId).toBeNull();

    expect(await tableSnapshotIds(schema.snapshotStats, prunedIds)).toHaveLength(0);
    expect(await tableSnapshotIds(schema.dataIssues, prunedIds)).toHaveLength(0);
    expect(await tableSnapshotIds(schema.futureSessionBlocks, prunedIds)).toHaveLength(0);
    expect(await tableSnapshotIds(schema.tutors, prunedIds)).toHaveLength(0);
    expect(await tableSnapshotIds(schema.tutorIdentityGroupMembers, prunedIds)).toHaveLength(0);
    expect(await tableSnapshotIds(schema.tutorIdentityGroups, prunedIds)).toHaveLength(0);

    const pastAfter = await handle.db.select().from(schema.pastSessionBlocks);
    expect(pastAfter).toHaveLength(pastBefore.length);
    expect(pastAfter[0].wiseSessionId).toBe("past-session-sentinel");
  });

  it("is a no-op when snapshot count is within the retention window", async () => {
    const snapshots = await seedSnapshots(30);

    const result = await pruneOldSnapshots(handle.db as unknown as Database);

    expect(result.attempted).toBe(true);
    expect(result.retentionCount).toBe(SNAPSHOT_RETENTION_COUNT);
    expect(result.deletedSnapshots).toBe(0);
    expect(result.prunedSnapshotIds).toEqual([]);
    expect(result.protectedSnapshotIds.sort()).toEqual(snapshots.map((s) => s.id).sort());

    const remainingSnapshots = await handle.db.select().from(schema.snapshots);
    expect(remainingSnapshots).toHaveLength(30);
  });
});
