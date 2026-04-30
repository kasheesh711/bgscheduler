import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { runPastSessionsDiffHook } from "@/lib/sync/past-sessions-diff-hook";
import * as schema from "@/lib/db/schema";
import type { Database } from "@/lib/db";
import type { NormalizedSessionBlock } from "@/lib/normalization/sessions";

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

/**
 * Replaces assertion targets from the deleted unit test:
 * - captures dropped past sessions into past_session_blocks
 * - idempotent: second run doesn't double-insert (UNIQUE constraint)
 * - future sessions never captured
 * - orphan groupId emits completeness issue without abort
 */

async function seedPriorSnapshot(opts: {
  groupCanonicalKey: string;
  pastWiseSessionIds: string[];
  futureWiseSessionIds: string[];
  orphanPastWiseSessionIds?: string[];
}): Promise<{ snapshotId: string; groupId: string }> {
  const [snap] = await handle.db
    .insert(schema.snapshots)
    .values({ active: true })
    .returning({ id: schema.snapshots.id });

  const [group] = await handle.db
    .insert(schema.tutorIdentityGroups)
    .values({
      snapshotId: snap.id,
      canonicalKey: opts.groupCanonicalKey,
      displayName: "Test Tutor",
      supportedModality: "onsite",
    })
    .returning({ id: schema.tutorIdentityGroups.id });

  const past = new Date(Date.now() - 24 * 3600_000);
  const future = new Date(Date.now() + 24 * 3600_000);

  const makeRow = (
    wiseSessionId: string,
    startTime: Date,
    groupId: string,
  ): typeof schema.futureSessionBlocks.$inferInsert => ({
    snapshotId: snap.id,
    groupId,
    wiseTeacherId: "t1",
    wiseSessionId,
    startTime,
    endTime: new Date(startTime.getTime() + 3600_000),
    weekday: startTime.getDay(),
    startMinute: 600,
    endMinute: 660,
    wiseStatus: "CONFIRMED",
    isBlocking: true,
    title: null,
    sessionType: null,
    location: null,
    studentName: null,
    subject: null,
    classType: null,
    recurrenceId: null,
  });

  const rows = [
    ...opts.pastWiseSessionIds.map((id) => makeRow(id, past, group.id)),
    ...opts.futureWiseSessionIds.map((id) => makeRow(id, future, group.id)),
  ];
  const orphanRows = (opts.orphanPastWiseSessionIds ?? []).map((id) =>
    makeRow(id, past, "00000000-0000-0000-0000-000000000001"),
  );

  if (rows.length > 0) {
    await handle.db.insert(schema.futureSessionBlocks).values(rows);
  }
  if (orphanRows.length > 0) {
    await handle.db.execute(sql`SET session_replication_role = replica`);
    try {
      await handle.db.insert(schema.futureSessionBlocks).values(orphanRows);
    } finally {
      await handle.db.execute(sql`SET session_replication_role = origin`);
    }
  }

  return { snapshotId: snap.id, groupId: group.id };
}

function normalizedFutureSession(wiseSessionId: string): NormalizedSessionBlock {
  const startTime = new Date(Date.now() + 24 * 3600_000);
  return {
    wiseSessionId,
    wiseTeacherId: "t1",
    startTime,
    endTime: new Date(startTime.getTime() + 3600_000),
    weekday: startTime.getDay(),
    startMinute: 600,
    endMinute: 660,
    wiseStatus: "CONFIRMED",
    isBlocking: true,
  };
}

describe("runPastSessionsDiffHook — TCOV-04 integration (real Postgres)", () => {
  it("captures dropped past sessions into past_session_blocks", async () => {
    await seedPriorSnapshot({
      groupCanonicalKey: "tutor-a",
      pastWiseSessionIds: ["S-past-1", "S-past-2"],
      futureWiseSessionIds: ["S-future-1"],
    });
    const [newSnap] = await handle.db
      .insert(schema.snapshots)
      .values({ active: false })
      .returning({ id: schema.snapshots.id });

    const result = await runPastSessionsDiffHook(
      handle.db as unknown as Database,
      [normalizedFutureSession("S-future-1")],
      newSnap.id,
    );

    expect(result.capturedCount).toBe(2);
    expect(result.issues).toHaveLength(0);

    const captured = await handle.db.select().from(schema.pastSessionBlocks);
    expect(captured.map((row) => row.wiseSessionId).sort()).toEqual([
      "S-past-1",
      "S-past-2",
    ]);
    expect(captured.every((row) => row.groupCanonicalKey === "tutor-a")).toBe(true);
    expect(captured.every((row) => row.capturedInSnapshotId === newSnap.id)).toBe(true);
  });

  it("idempotent: second run doesn't double-insert (UNIQUE constraint)", async () => {
    await seedPriorSnapshot({
      groupCanonicalKey: "tutor-a",
      pastWiseSessionIds: ["S-past-1", "S-past-2"],
      futureWiseSessionIds: [],
    });
    const [newSnap] = await handle.db
      .insert(schema.snapshots)
      .values({ active: false })
      .returning({ id: schema.snapshots.id });

    const first = await runPastSessionsDiffHook(
      handle.db as unknown as Database,
      [],
      newSnap.id,
    );
    const second = await runPastSessionsDiffHook(
      handle.db as unknown as Database,
      [],
      newSnap.id,
    );

    expect(first.capturedCount).toBe(2);
    expect(second.capturedCount).toBe(0);
    const captured = await handle.db.select().from(schema.pastSessionBlocks);
    expect(captured).toHaveLength(2);
  });

  it("future sessions never captured", async () => {
    await seedPriorSnapshot({
      groupCanonicalKey: "tutor-a",
      pastWiseSessionIds: [],
      futureWiseSessionIds: ["S-future-cancelled"],
    });
    const [newSnap] = await handle.db
      .insert(schema.snapshots)
      .values({ active: false })
      .returning({ id: schema.snapshots.id });

    const result = await runPastSessionsDiffHook(
      handle.db as unknown as Database,
      [],
      newSnap.id,
    );

    expect(result.capturedCount).toBe(0);
    expect(result.issues).toHaveLength(0);
    const captured = await handle.db.select().from(schema.pastSessionBlocks);
    expect(captured).toHaveLength(0);
  });

  it("orphan groupId emits completeness issue without abort", async () => {
    await seedPriorSnapshot({
      groupCanonicalKey: "tutor-a",
      pastWiseSessionIds: [],
      futureWiseSessionIds: [],
      orphanPastWiseSessionIds: ["S-orphan"],
    });
    const [newSnap] = await handle.db
      .insert(schema.snapshots)
      .values({ active: false })
      .returning({ id: schema.snapshots.id });

    const result = await runPastSessionsDiffHook(
      handle.db as unknown as Database,
      [],
      newSnap.id,
    );

    expect(result.capturedCount).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      snapshotId: newSnap.id,
      type: "completeness",
      severity: "medium",
      entityType: "past_session_block",
      entityId: "S-orphan",
    });
    expect(result.issues[0].message).toContain("S-orphan");

    const captured = await handle.db.select().from(schema.pastSessionBlocks);
    expect(captured).toHaveLength(0);
  });

  it("does not capture sessions still present in the new Wise response", async () => {
    await seedPriorSnapshot({
      groupCanonicalKey: "tutor-a",
      pastWiseSessionIds: ["S-still-present"],
      futureWiseSessionIds: [],
    });
    const [newSnap] = await handle.db
      .insert(schema.snapshots)
      .values({ active: false })
      .returning({ id: schema.snapshots.id });

    const result = await runPastSessionsDiffHook(
      handle.db as unknown as Database,
      [normalizedFutureSession("S-still-present")],
      newSnap.id,
    );

    expect(result.capturedCount).toBe(0);
    expect(result.issues).toHaveLength(0);
    const captured = await handle.db.select().from(schema.pastSessionBlocks);
    expect(captured).toHaveLength(0);
  });
});
