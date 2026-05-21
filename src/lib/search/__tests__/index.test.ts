import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as indexModule from "../index";
import * as schema from "@/lib/db/schema";
import type { Database } from "@/lib/db";
import type { SearchIndex } from "../index";

// ── Helpers ──────────────────────────────────────────────────────────
//
// REL-02 race-coalescing tests verify that two concurrent callers of
// ensureIndex(db) result in (a) at most ONE invocation of the heavy
// buildIndex() pipeline AND (b) exactly ONE cached-snapshot check when
// a stale index is present. The synchronous-prelude singleton-promise
// fix makes the second concurrent caller short-circuit on
// getBuildingPromise() before doing its own DB lookup.
//
// We instrument the fake Database so every `db.select()` call increments
// a counter. ensureIndex's cached-check path makes 1 select. buildIndex
// makes 10 selects (1 active-snapshot + 1 promoted-sync lookup +
// 1 tutor groups + 7 parallel loads).
// So:
//   • cached + matches  → 1 select  (Test 2)
//   • no cache + build  → 10 selects (Test 1)
//   • stale cache + 2 concurrent + fixed → 1 + 10 = 11 selects (Test 3)
//   • stale cache + 2 concurrent + buggy → 2 + 10 = 12 selects (Test 3 RED)

interface FakeDbState {
  // The active snapshot id returned by `where(eq(active, true)).limit(1)`.
  activeSnapshotId: string | null;
  // Counts every db.select() invocation across the chain.
  selectCallCount: number;
  // Optional micro-yield inserted before each chain resolves so concurrent
  // callers actually interleave at await boundaries.
  yieldBeforeResolve: boolean;
}

interface FakeTablesState {
  // The active snapshot id returned by the snapshots active lookup.
  activeSnapshotId: string | null;
  // Counts every db.select() invocation across the chain.
  selectCallCount: number;
  // Per-table row fixtures keyed by the schema table reference passed to .from().
  rowsByTable: Map<unknown, unknown[]>;
}

function makeFakeDbWithTables(state: FakeTablesState): Database {
  const selectFn = vi.fn().mockImplementation(() => {
    state.selectCallCount += 1;
    const api = {
      _target: null as unknown,
      from(target: unknown) {
        api._target = target;
        return api;
      },
      where() {
        return api;
      },
      orderBy() {
        return api;
      },
      limit() {
        return Promise.resolve(api._resolve());
      },
      then(onFulfilled: (rows: unknown[]) => unknown) {
        return Promise.resolve(api._resolve()).then(onFulfilled);
      },
      _resolve(): unknown[] {
        if (api._target === schema.snapshots) {
          return state.activeSnapshotId
            ? [{ id: state.activeSnapshotId, createdAt: new Date("2026-05-18T00:00:00.000Z") }]
            : [];
        }
        return state.rowsByTable.get(api._target) ?? [];
      },
    };
    return api;
  });

  return { select: selectFn } as unknown as Database;
}

function makeFakeDb(state: FakeDbState): Database {
  function chain(rowsForLimit: unknown[], rowsForFull: unknown[]) {
    const limitFn = vi.fn().mockImplementation(async () => {
      if (state.yieldBeforeResolve) {
        await new Promise((r) => setTimeout(r, 0));
      }
      return rowsForLimit;
    });
    const whereChain = {
      orderBy: vi.fn().mockReturnThis(),
      limit: limitFn,
      // .where(...) without .limit() is awaited directly (a thenable)
      then: (onFulfilled: (rows: unknown[]) => unknown) => {
        const p = (async () => {
          if (state.yieldBeforeResolve) {
            await new Promise((r) => setTimeout(r, 0));
          }
          return rowsForFull;
        })();
        return p.then(onFulfilled);
      },
    };
    const whereFn = vi.fn().mockReturnValue(whereChain);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    return { from: fromFn };
  }

  const selectFn = vi.fn().mockImplementation(() => {
    state.selectCallCount += 1;
    // Active-snapshot lookup (limit(1)) returns [{ id }] when set, else [].
    // Bulk loaders (no .limit) return [] — buildIndex tolerates empty arrays.
    return chain(
      state.activeSnapshotId
        ? [{ id: state.activeSnapshotId, createdAt: new Date("2026-05-18T00:00:00.000Z") }]
        : [],
      [],
    );
  });

  return { select: selectFn } as unknown as Database;
}

function resetGlobals() {
  globalThis.__bgscheduler_searchIndex = null;
  globalThis.__bgscheduler_searchIndexBuildPromise = null;
}

function makeIndex(snapshotId: string): SearchIndex {
  return {
    snapshotId,
    builtAt: new Date(),
    syncedAt: new Date(),
    tutorGroups: [],
    byWeekday: new Map(),
  };
}

describe("ensureIndex — REL-02 race-free coalescing", () => {
  beforeEach(() => {
    resetGlobals();
  });
  afterEach(() => {
    resetGlobals();
    vi.restoreAllMocks();
  });

  it("coalesces two concurrent first-time callers into a single buildIndex pipeline", async () => {
    // No cached index — both callers must converge on ONE buildIndex run.
    // buildIndex makes 10 db.select calls (1 active-snapshot + 1 promoted-sync
    // lookup + 1 tutor groups + 7 parallel data loads). Expected: exactly 10 selects across
    // both concurrent callers, and both receive the same SearchIndex
    // instance. Note: the no-cache path of ensureIndex is fully synchronous
    // up to setBuildingPromise(p), so this assertion holds for both the
    // buggy and fixed implementations — its purpose is to lock in the
    // single-build invariant rather than reproduce the race.
    const state: FakeDbState = {
      activeSnapshotId: "snap-A",
      selectCallCount: 0,
      yieldBeforeResolve: true,
    };
    const db = makeFakeDb(state);

    const [a, b] = await Promise.all([
      indexModule.ensureIndex(db),
      indexModule.ensureIndex(db),
    ]);

    expect(state.selectCallCount).toBe(10);
    expect(a).toBe(b);
    expect(a.snapshotId).toBe("snap-A");
  });

  it("returns the cached index without rebuilding when the active snapshot id matches", async () => {
    // Pre-seed the cache; ensureIndex must take the fast cached path —
    // exactly ONE select (the active-snapshot id check) and zero rebuild.
    const cached = makeIndex("snap-A");
    globalThis.__bgscheduler_searchIndex = cached;

    const state: FakeDbState = {
      activeSnapshotId: "snap-A",
      selectCallCount: 0,
      yieldBeforeResolve: false,
    };
    const db = makeFakeDb(state);

    const result = await indexModule.ensureIndex(db);

    expect(state.selectCallCount).toBe(1);
    expect(result).toBe(cached);
    // No build promise should leak after the cached path.
    expect(globalThis.__bgscheduler_searchIndexBuildPromise).toBeNull();
  });

  it("rebuilds exactly once when the cached snapshot is stale and two callers race", async () => {
    // The race-detector. With the singleton-promise fix in place, the
    // second concurrent caller sees the in-flight promise BEFORE it
    // performs its own active-snapshot lookup, so only ONE cached-check
    // select happens. Total: 1 cached-check + 10 buildIndex = 11 selects.
    //
    // Against the buggy code (lines 281-305) the second caller also runs
    // its own active-snapshot await before checking getBuildingPromise(),
    // producing 2 cached-check selects + 10 buildIndex selects = 12 selects.
    // This test fails RED against the buggy code at toBeLessThanOrEqual(11).
    const cached = makeIndex("snap-OLD");
    globalThis.__bgscheduler_searchIndex = cached;

    const state: FakeDbState = {
      activeSnapshotId: "snap-NEW",
      selectCallCount: 0,
      yieldBeforeResolve: true,
    };
    const db = makeFakeDb(state);

    const [a, b] = await Promise.all([
      indexModule.ensureIndex(db),
      indexModule.ensureIndex(db),
    ]);

    expect(state.selectCallCount).toBeLessThanOrEqual(11);
    expect(a).toBe(b);
    expect(a.snapshotId).toBe("snap-NEW");
  });
});

describe("buildIndex — TCOV-01 denormalization", () => {
  beforeEach(() => {
    resetGlobals();
  });
  afterEach(() => {
    resetGlobals();
    vi.restoreAllMocks();
  });

  it("produces one tutor group per group row and attaches child rows by groupId", async () => {
    const rows = new Map<unknown, unknown[]>([
      [
        schema.tutorIdentityGroups,
        [
          {
            id: "g1",
            snapshotId: "snap-1",
            canonicalKey: "alice",
            displayName: "Alice",
            supportedModality: "online",
          },
          {
            id: "g2",
            snapshotId: "snap-1",
            canonicalKey: "bob",
            displayName: "Bob",
            supportedModality: "onsite",
          },
        ],
      ],
      [
        schema.tutorIdentityGroupMembers,
        [
          {
            groupId: "g1",
            wiseTeacherId: "teacher-1",
            wiseDisplayName: "Alice Online",
            isOnlineVariant: true,
          },
          {
            groupId: "g2",
            wiseTeacherId: "teacher-2",
            wiseDisplayName: "Bob Onsite",
            isOnlineVariant: false,
          },
        ],
      ],
      [
        schema.subjectLevelQualifications,
        [
          {
            groupId: "g1",
            subject: "Math",
            curriculum: "IB",
            level: "HL",
            examPrep: null,
          },
          {
            groupId: "g2",
            subject: "Physics",
            curriculum: "AP",
            level: "Y10",
            examPrep: "SAT",
          },
        ],
      ],
      [
        schema.recurringAvailabilityWindows,
        [
          {
            groupId: "g1",
            wiseTeacherId: "teacher-1",
            weekday: 1,
            startMinute: 600,
            endMinute: 720,
            modality: "online",
          },
          {
            groupId: "g2",
            wiseTeacherId: "teacher-2",
            weekday: 3,
            startMinute: 540,
            endMinute: 660,
            modality: "onsite",
          },
        ],
      ],
      [
        schema.datedLeaves,
        [
          {
            groupId: "g1",
            wiseTeacherId: "teacher-1",
            startTime: new Date("2026-05-01T00:00:00Z"),
            endTime: new Date("2026-05-02T00:00:00Z"),
          },
        ],
      ],
      [
        schema.futureSessionBlocks,
        [
          {
            groupId: "g2",
            wiseTeacherId: "teacher-2",
            wiseSessionId: "session-1",
            startTime: new Date("2026-05-15T03:00:00Z"),
            endTime: new Date("2026-05-15T04:00:00Z"),
            weekday: 5,
            startMinute: 600,
            endMinute: 660,
            wiseStatus: "CONFIRMED",
            isBlocking: true,
          },
        ],
      ],
      [schema.dataIssues, []],
    ]);
    const state: FakeTablesState = {
      activeSnapshotId: "snap-1",
      selectCallCount: 0,
      rowsByTable: rows,
    };
    const db = makeFakeDbWithTables(state);

    const index = await indexModule.buildIndex(db);

    expect(index.snapshotId).toBe("snap-1");
    expect(index.tutorGroups).toHaveLength(2);
    expect(state.selectCallCount).toBe(10);

    const g1 = index.tutorGroups.find((group) => group.id === "g1");
    const g2 = index.tutorGroups.find((group) => group.id === "g2");
    expect(g1).toBeDefined();
    expect(g2).toBeDefined();

    expect(g1!.qualifications).toEqual([
      { subject: "Math", curriculum: "IB", level: "HL", examPrep: undefined },
    ]);
    expect(g2!.qualifications).toEqual([
      { subject: "Physics", curriculum: "AP", level: "Y10", examPrep: "SAT" },
    ]);

    expect(g1!.wiseRecords).toEqual([
      { wiseTeacherId: "teacher-1", wiseDisplayName: "Alice Online", isOnline: true },
    ]);
    expect(g2!.wiseRecords).toEqual([
      { wiseTeacherId: "teacher-2", wiseDisplayName: "Bob Onsite", isOnline: false },
    ]);

    expect(g1!.availabilityWindows).toEqual([
      {
        weekday: 1,
        startMinute: 600,
        endMinute: 720,
        modality: "online",
        wiseTeacherId: "teacher-1",
      },
    ]);
    expect(g2!.availabilityWindows).toEqual([
      {
        weekday: 3,
        startMinute: 540,
        endMinute: 660,
        modality: "onsite",
        wiseTeacherId: "teacher-2",
      },
    ]);

    expect(g1!.leaves).toEqual([
      {
        startTime: new Date("2026-05-01T00:00:00Z"),
        endTime: new Date("2026-05-02T00:00:00Z"),
      },
    ]);
    expect(g2!.leaves).toHaveLength(0);
    expect(g1!.sessionBlocks).toHaveLength(0);
    expect(g2!.sessionBlocks).toEqual([
      {
        startTime: new Date("2026-05-15T03:00:00Z"),
        endTime: new Date("2026-05-15T04:00:00Z"),
        weekday: 5,
        startMinute: 600,
        endMinute: 660,
        isBlocking: true,
        wiseTeacherId: "teacher-2",
        wiseTeacherUserId: undefined,
        wiseSessionId: "session-1",
        wiseClassId: undefined,
        title: undefined,
        studentName: undefined,
        studentCount: undefined,
        subject: undefined,
        classType: undefined,
        sessionType: undefined,
        recurrenceId: undefined,
        location: undefined,
      },
    ]);
  });

  it("maps supported modes and data issues from the documented parallel load order", async () => {
    const rows = new Map<unknown, unknown[]>([
      [
        schema.tutorIdentityGroups,
        [
          {
            id: "g1",
            snapshotId: "snap-1",
            canonicalKey: "alice",
            displayName: "Alice",
            supportedModality: "both",
          },
          {
            id: "g2",
            snapshotId: "snap-1",
            canonicalKey: "bob",
            displayName: "Bob",
            supportedModality: "unresolved",
          },
        ],
      ],
      [schema.tutorIdentityGroupMembers, []],
      [schema.subjectLevelQualifications, []],
      [schema.recurringAvailabilityWindows, []],
      [schema.datedLeaves, []],
      [schema.futureSessionBlocks, []],
      [
        schema.dataIssues,
        [
          {
            entityId: "alice",
            entityName: "ignored",
            type: "tag",
            message: "Unmapped tag",
          },
          {
            entityId: "ignored",
            entityName: "Bob",
            type: "modality",
            message: "Unresolved modality",
          },
        ],
      ],
    ]);
    const state: FakeTablesState = {
      activeSnapshotId: "snap-1",
      selectCallCount: 0,
      rowsByTable: rows,
    };
    const db = makeFakeDbWithTables(state);

    const index = await indexModule.buildIndex(db);

    const g1 = index.tutorGroups.find((group) => group.id === "g1");
    const g2 = index.tutorGroups.find((group) => group.id === "g2");
    expect(g1!.supportedModes).toEqual(["online", "onsite"]);
    expect(g2!.supportedModes).toEqual([]);
    expect(g1!.dataIssues).toEqual([{ type: "tag", message: "Unmapped tag" }]);
    expect(g2!.dataIssues).toEqual([
      { type: "modality", message: "Unresolved modality" },
    ]);
  });
});

describe("buildIndex — TCOV-01 byWeekday map", () => {
  beforeEach(() => {
    resetGlobals();
  });
  afterEach(() => {
    resetGlobals();
    vi.restoreAllMocks();
  });

  it("populates byWeekday with entries for every weekday a group has windows on", async () => {
    const rows = new Map<unknown, unknown[]>([
      [
        schema.tutorIdentityGroups,
        [
          {
            id: "g1",
            snapshotId: "snap-1",
            canonicalKey: "alice",
            displayName: "Alice",
            supportedModality: "online",
          },
        ],
      ],
      [
        schema.tutorIdentityGroupMembers,
        [
          {
            groupId: "g1",
            wiseTeacherId: "teacher-1",
            wiseDisplayName: "Alice Online",
            isOnlineVariant: true,
          },
        ],
      ],
      [schema.subjectLevelQualifications, []],
      [
        schema.recurringAvailabilityWindows,
        [
          {
            groupId: "g1",
            wiseTeacherId: "teacher-1",
            weekday: 1,
            startMinute: 600,
            endMinute: 720,
            modality: "online",
          },
          {
            groupId: "g1",
            wiseTeacherId: "teacher-1",
            weekday: 3,
            startMinute: 540,
            endMinute: 660,
            modality: "online",
          },
        ],
      ],
      [schema.datedLeaves, []],
      [schema.futureSessionBlocks, []],
      [schema.dataIssues, []],
    ]);
    const state: FakeTablesState = {
      activeSnapshotId: "snap-1",
      selectCallCount: 0,
      rowsByTable: rows,
    };
    const db = makeFakeDbWithTables(state);

    const index = await indexModule.buildIndex(db);

    expect(index.byWeekday.get(1)?.map((group) => group.id)).toEqual(["g1"]);
    expect(index.byWeekday.get(3)?.map((group) => group.id)).toEqual(["g1"]);
    expect(index.byWeekday.get(2) ?? []).toHaveLength(0);
  });

  it("adds a group only once per weekday even when multiple windows share that weekday", async () => {
    const rows = new Map<unknown, unknown[]>([
      [
        schema.tutorIdentityGroups,
        [
          {
            id: "g1",
            snapshotId: "snap-1",
            canonicalKey: "alice",
            displayName: "Alice",
            supportedModality: "online",
          },
        ],
      ],
      [schema.tutorIdentityGroupMembers, []],
      [schema.subjectLevelQualifications, []],
      [
        schema.recurringAvailabilityWindows,
        [
          {
            groupId: "g1",
            wiseTeacherId: "teacher-1",
            weekday: 1,
            startMinute: 540,
            endMinute: 600,
            modality: "online",
          },
          {
            groupId: "g1",
            wiseTeacherId: "teacher-1",
            weekday: 1,
            startMinute: 660,
            endMinute: 720,
            modality: "online",
          },
        ],
      ],
      [schema.datedLeaves, []],
      [schema.futureSessionBlocks, []],
      [schema.dataIssues, []],
    ]);
    const state: FakeTablesState = {
      activeSnapshotId: "snap-1",
      selectCallCount: 0,
      rowsByTable: rows,
    };
    const db = makeFakeDbWithTables(state);

    const index = await indexModule.buildIndex(db);

    expect(index.byWeekday.get(1)?.map((group) => group.id)).toEqual(["g1"]);
  });

  it("does not add a group to byWeekday if it has no availability windows", async () => {
    const rows = new Map<unknown, unknown[]>([
      [
        schema.tutorIdentityGroups,
        [
          {
            id: "g1",
            snapshotId: "snap-1",
            canonicalKey: "alice",
            displayName: "Alice",
            supportedModality: "online",
          },
        ],
      ],
      [schema.tutorIdentityGroupMembers, []],
      [schema.subjectLevelQualifications, []],
      [schema.recurringAvailabilityWindows, []],
      [schema.datedLeaves, []],
      [schema.futureSessionBlocks, []],
      [schema.dataIssues, []],
    ]);
    const state: FakeTablesState = {
      activeSnapshotId: "snap-1",
      selectCallCount: 0,
      rowsByTable: rows,
    };
    const db = makeFakeDbWithTables(state);

    const index = await indexModule.buildIndex(db);

    expect(index.byWeekday.size).toBe(0);
  });
});

describe("ensureIndex — TCOV-01 snapshot-active race fallback", () => {
  beforeEach(() => {
    resetGlobals();
  });
  afterEach(() => {
    resetGlobals();
    vi.restoreAllMocks();
  });

  it("returns cached index without throwing when zero rows match WHERE active=true", async () => {
    const cached = makeIndex("snap-A");
    globalThis.__bgscheduler_searchIndex = cached;

    const state: FakeDbState = {
      activeSnapshotId: null,
      selectCallCount: 0,
      yieldBeforeResolve: false,
    };
    const db = makeFakeDb(state);

    const result = await indexModule.ensureIndex(db);

    expect(result).toBe(cached);
    expect(result.snapshotId).toBe("snap-A");
    expect(state.selectCallCount).toBe(1);
  });
});
