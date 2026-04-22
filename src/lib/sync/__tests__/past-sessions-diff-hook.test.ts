import { describe, it, expect, beforeEach } from "vitest";
import { runPastSessionsDiffHook } from "../past-sessions-diff-hook";
import type { NormalizedSessionBlock } from "@/lib/normalization/sessions";
import * as schema from "@/lib/db/schema";
import type { Database } from "@/lib/db";

// -- Test fixtures --
const PAST_BKK = new Date("2026-04-01T10:00:00+07:00"); // deterministic past
const PAST_BKK_2 = new Date("2026-04-05T15:30:00+07:00"); // another past
const FUTURE_BKK = new Date("2099-01-01T00:00:00+07:00"); // deterministic future

const NEW_SNAPSHOT_ID = "snapshot-new";
const PRIOR_SNAPSHOT_ID = "snapshot-prior";

interface PriorBlock {
  groupId: string;
  wiseTeacherId: string;
  wiseSessionId: string;
  startTime: Date;
  endTime: Date;
  weekday: number;
  startMinute: number;
  endMinute: number;
  wiseStatus: string;
  isBlocking: boolean;
  title: string | null;
  sessionType: string | null;
  location: string | null;
  studentName: string | null;
  subject: string | null;
  classType: string | null;
  recurrenceId: string | null;
}

function makePriorBlock(overrides: Partial<PriorBlock> & { wiseSessionId: string; startTime: Date }): PriorBlock {
  return {
    groupId: overrides.groupId ?? "group-a",
    wiseTeacherId: overrides.wiseTeacherId ?? "teacher-1",
    wiseSessionId: overrides.wiseSessionId,
    startTime: overrides.startTime,
    endTime: overrides.endTime ?? new Date(overrides.startTime.getTime() + 60 * 60 * 1000),
    weekday: overrides.weekday ?? 1,
    startMinute: overrides.startMinute ?? 600,
    endMinute: overrides.endMinute ?? 660,
    wiseStatus: overrides.wiseStatus ?? "CONFIRMED",
    isBlocking: overrides.isBlocking ?? true,
    title: overrides.title ?? null,
    sessionType: overrides.sessionType ?? null,
    location: overrides.location ?? null,
    studentName: overrides.studentName ?? null,
    subject: overrides.subject ?? null,
    classType: overrides.classType ?? null,
    recurrenceId: overrides.recurrenceId ?? null,
  };
}

// -- Mock DB factory --
// Mirrors only the three Drizzle call-chains the diff-hook uses:
//   db.select({...}).from(snapshots).where(...).limit(1)
//   db.select({...}).from(tutorIdentityGroups).where(...)
//   db.select().from(futureSessionBlocks).where(...)
//   db.insert(pastSessionBlocks).values(chunk).onConflictDoNothing({...}).returning({...})
//
// The insert chain tracks rows in an in-memory Set<wiseSessionId> to make
// ON CONFLICT DO NOTHING assertions possible across repeat calls.
function makeMockDb(opts: {
  priorSnapshotId: string | null;
  priorGroups: { id: string; canonicalKey: string }[];
  priorBlocks: PriorBlock[];
  existingPastRows?: Set<string>;
}): { db: Database; insertedRows: PriorBlock[]; existingPastRows: Set<string> } {
  const insertedRows: PriorBlock[] = [];
  const existingPastRows = opts.existingPastRows ?? new Set<string>();

  const selectBuilder = (fieldsArg?: Record<string, unknown>) => {
    const api = {
      _target: null as unknown,
      _fields: fieldsArg,
      from(target: unknown) {
        api._target = target;
        return api;
      },
      where(_condition: unknown) {
        return api;
      },
      limit(_n: number) {
        return api._resolve();
      },
      then(onFulfilled: (value: unknown) => unknown) {
        return Promise.resolve(api._resolve()).then(onFulfilled);
      },
      _resolve(): unknown[] {
        if (api._target === schema.snapshots) {
          if (!opts.priorSnapshotId) return [];
          return [{ id: opts.priorSnapshotId }];
        }
        if (api._target === schema.tutorIdentityGroups) {
          return opts.priorGroups.map((g) => ({ id: g.id, canonicalKey: g.canonicalKey }));
        }
        if (api._target === schema.futureSessionBlocks) {
          return opts.priorBlocks;
        }
        return [];
      },
    };
    return api;
  };

  const insertBuilder = (target: unknown) => {
    const api = {
      _values: [] as Array<typeof schema.pastSessionBlocks.$inferInsert>,
      values(rows: Array<typeof schema.pastSessionBlocks.$inferInsert>) {
        api._values = rows;
        return api;
      },
      onConflictDoNothing(_config?: unknown) {
        return api;
      },
      returning(_fields?: unknown) {
        if (target !== schema.pastSessionBlocks) return Promise.resolve([]);
        const inserted: { id: string }[] = [];
        for (const row of api._values) {
          if (existingPastRows.has(row.wiseSessionId)) continue;
          existingPastRows.add(row.wiseSessionId);
          insertedRows.push(row as unknown as PriorBlock);
          inserted.push({ id: `inserted-${row.wiseSessionId}` });
        }
        return Promise.resolve(inserted);
      },
    };
    return api;
  };

  const db = {
    select: (fields?: Record<string, unknown>) => selectBuilder(fields),
    insert: (target: unknown) => insertBuilder(target),
  } as unknown as Database;

  return { db, insertedRows, existingPastRows };
}

describe("runPastSessionsDiffHook", () => {
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    mockDb = makeMockDb({
      priorSnapshotId: PRIOR_SNAPSHOT_ID,
      priorGroups: [{ id: "group-a", canonicalKey: "canonical-a" }],
      priorBlocks: [],
    });
  });

  it("captures dropped past sessions from prior snapshot", async () => {
    // Prior snapshot had three sessions: S1 past, S2 past, S3 future.
    // New Wise response contains only S3. Expect S1+S2 captured, S3 not.
    mockDb = makeMockDb({
      priorSnapshotId: PRIOR_SNAPSHOT_ID,
      priorGroups: [{ id: "group-a", canonicalKey: "canonical-a" }],
      priorBlocks: [
        makePriorBlock({ wiseSessionId: "S1", startTime: PAST_BKK }),
        makePriorBlock({ wiseSessionId: "S2", startTime: PAST_BKK_2 }),
        makePriorBlock({ wiseSessionId: "S3", startTime: FUTURE_BKK }),
      ],
    });

    const newSessions: NormalizedSessionBlock[] = [
      {
        wiseSessionId: "S3",
        wiseTeacherId: "teacher-1",
        startTime: FUTURE_BKK,
        endTime: new Date(FUTURE_BKK.getTime() + 60 * 60 * 1000),
        weekday: 3,
        startMinute: 540,
        endMinute: 600,
        wiseStatus: "CONFIRMED",
        isBlocking: true,
      },
    ];

    const result = await runPastSessionsDiffHook(mockDb.db, newSessions, NEW_SNAPSHOT_ID);

    expect(result.capturedCount).toBe(2);
    expect(result.issues).toHaveLength(0);
    expect(mockDb.insertedRows.map((r) => r.wiseSessionId).sort()).toEqual(["S1", "S2"]);
    expect(mockDb.insertedRows.every((r) => r.groupCanonicalKey === "canonical-a")).toBe(true);
    expect(mockDb.insertedRows.every((r) => r.capturedInSnapshotId === NEW_SNAPSHOT_ID)).toBe(true);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("is idempotent across repeat invocations (ON CONFLICT DO NOTHING)", async () => {
    const priorBlocks = [
      makePriorBlock({ wiseSessionId: "S1", startTime: PAST_BKK }),
      makePriorBlock({ wiseSessionId: "S2", startTime: PAST_BKK_2 }),
    ];
    const sharedExistingPastRows = new Set<string>();
    const sharedPriorGroups = [{ id: "group-a", canonicalKey: "canonical-a" }];

    const newSessions: NormalizedSessionBlock[] = []; // Wise dropped both

    // First call — captures 2 rows.
    const firstRun = makeMockDb({
      priorSnapshotId: PRIOR_SNAPSHOT_ID,
      priorGroups: sharedPriorGroups,
      priorBlocks,
      existingPastRows: sharedExistingPastRows,
    });
    const result1 = await runPastSessionsDiffHook(firstRun.db, newSessions, NEW_SNAPSHOT_ID);
    expect(result1.capturedCount).toBe(2);
    expect(sharedExistingPastRows.size).toBe(2);

    // Second call — same prior + same empty new response, but
    // `existingPastRows` is shared, so ON CONFLICT DO NOTHING should skip.
    const secondRun = makeMockDb({
      priorSnapshotId: PRIOR_SNAPSHOT_ID,
      priorGroups: sharedPriorGroups,
      priorBlocks,
      existingPastRows: sharedExistingPastRows,
    });
    const result2 = await runPastSessionsDiffHook(secondRun.db, newSessions, NEW_SNAPSHOT_ID);
    expect(result2.capturedCount).toBe(0);
    expect(sharedExistingPastRows.size).toBe(2); // still 2 total — no double-insert
  });

  it("returns early when no prior active snapshot exists", async () => {
    mockDb = makeMockDb({
      priorSnapshotId: null,
      priorGroups: [],
      priorBlocks: [],
    });

    const result = await runPastSessionsDiffHook(mockDb.db, [], NEW_SNAPSHOT_ID);

    expect(result.capturedCount).toBe(0);
    expect(result.issues).toHaveLength(0);
    expect(mockDb.insertedRows).toHaveLength(0);
  });

  it("does not capture sessions whose startTime is still in the future", async () => {
    mockDb = makeMockDb({
      priorSnapshotId: PRIOR_SNAPSHOT_ID,
      priorGroups: [{ id: "group-a", canonicalKey: "canonical-a" }],
      priorBlocks: [
        // Session was in prior AND is cancelled upstream (absent from new
        // Wise response) BUT startTime is still in the future — should NOT
        // be captured because it hasn't started yet.
        makePriorBlock({ wiseSessionId: "S-future-cancelled", startTime: FUTURE_BKK }),
      ],
    });

    const result = await runPastSessionsDiffHook(mockDb.db, [], NEW_SNAPSHOT_ID);

    expect(result.capturedCount).toBe(0);
    expect(result.issues).toHaveLength(0);
    expect(mockDb.insertedRows).toHaveLength(0);
  });

  it("emits completeness data_issue when canonical_key cannot be resolved", async () => {
    mockDb = makeMockDb({
      priorSnapshotId: PRIOR_SNAPSHOT_ID,
      priorGroups: [{ id: "group-a", canonicalKey: "canonical-a" }],
      priorBlocks: [
        // Prior block references group-GHOST, which is NOT in priorGroups.
        makePriorBlock({ groupId: "group-GHOST", wiseSessionId: "S-orphan", startTime: PAST_BKK }),
      ],
    });

    const result = await runPastSessionsDiffHook(mockDb.db, [], NEW_SNAPSHOT_ID);

    expect(result.capturedCount).toBe(0);
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.type).toBe("completeness");
    expect(issue.severity).toBe("medium");
    expect(issue.entityType).toBe("past_session_block");
    expect(issue.entityId).toBe("S-orphan");
    expect(issue.snapshotId).toBe(NEW_SNAPSHOT_ID);
    expect(issue.message).toContain("group-GHOST");
    expect(issue.message).toContain("S-orphan");
    // Hook did NOT throw — sync continues.
    expect(mockDb.insertedRows).toHaveLength(0);
  });

  it("does not capture sessions still present in the new Wise response", async () => {
    mockDb = makeMockDb({
      priorSnapshotId: PRIOR_SNAPSHOT_ID,
      priorGroups: [{ id: "group-a", canonicalKey: "canonical-a" }],
      priorBlocks: [
        // Prior had S1 (past). New Wise response STILL contains S1 (unusual
        // but legal — e.g. Wise's FUTURE response hasn't dropped it yet).
        makePriorBlock({ wiseSessionId: "S1", startTime: PAST_BKK }),
      ],
    });

    const newSessions: NormalizedSessionBlock[] = [
      {
        wiseSessionId: "S1",
        wiseTeacherId: "teacher-1",
        startTime: PAST_BKK,
        endTime: new Date(PAST_BKK.getTime() + 60 * 60 * 1000),
        weekday: 3,
        startMinute: 600,
        endMinute: 660,
        wiseStatus: "CONFIRMED",
        isBlocking: true,
      },
    ];

    const result = await runPastSessionsDiffHook(mockDb.db, newSessions, NEW_SNAPSHOT_ID);

    expect(result.capturedCount).toBe(0);
    expect(result.issues).toHaveLength(0);
    expect(mockDb.insertedRows).toHaveLength(0);
  });
});
