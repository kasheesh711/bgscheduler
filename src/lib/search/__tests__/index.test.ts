import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as indexModule from "../index";
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
// makes 8 selects (1 active-snapshot + 1 tutor groups + 6 parallel loads).
// So:
//   • cached + matches  → 1 select  (Test 2)
//   • no cache + build  → 8 selects (Test 1)
//   • stale cache + 2 concurrent + fixed → 1 + 8 = 9 selects (Test 3)
//   • stale cache + 2 concurrent + buggy → 2 + 8 = 10 selects (Test 3 RED)

interface FakeDbState {
  // The active snapshot id returned by `where(eq(active, true)).limit(1)`.
  activeSnapshotId: string | null;
  // Counts every db.select() invocation across the chain.
  selectCallCount: number;
  // Optional micro-yield inserted before each chain resolves so concurrent
  // callers actually interleave at await boundaries.
  yieldBeforeResolve: boolean;
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
      state.activeSnapshotId ? [{ id: state.activeSnapshotId }] : [],
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
    // buildIndex makes 8 db.select calls (1 active-snapshot + 1 tutor
    // groups + 6 parallel data loads). Expected: exactly 8 selects across
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

    expect(state.selectCallCount).toBe(8);
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
    // select happens. Total: 1 cached-check + 8 buildIndex = 9 selects.
    //
    // Against the buggy code (lines 281-305) the second caller also runs
    // its own active-snapshot await before checking getBuildingPromise(),
    // producing 2 cached-check selects + 8 buildIndex selects = 10 selects.
    // This test fails RED against the buggy code at toBeLessThanOrEqual(9).
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

    expect(state.selectCallCount).toBeLessThanOrEqual(9);
    expect(a).toBe(b);
    expect(a.snapshotId).toBe("snap-NEW");
  });
});
