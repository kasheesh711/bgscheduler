---
phase: 01-component-architecture
plan: 01
subsystem: singletons
tags: [globalThis, HMR, singleton, dev-mode]
dependency_graph:
  requires: []
  provides: [hmr-safe-db-singleton, hmr-safe-search-index-singleton]
  affects: [src/lib/db/index.ts, src/lib/search/index.ts]
tech_stack:
  added: []
  patterns: [globalThis singleton anchoring for Next.js dev-mode HMR]
key_files:
  modified:
    - src/lib/db/index.ts
    - src/lib/search/index.ts
decisions:
  - Used `declare global { var ... }` pattern (TypeScript requires `var` for globalThis augmentation)
  - Namespaced keys with `__bgscheduler_` prefix to avoid collisions
  - Added private accessor functions for SearchIndex to encapsulate globalThis access
metrics:
  duration: 2m18s
  completed: "2026-04-10T04:43:37Z"
  tasks_completed: 2
  tasks_total: 2
  tests_passed: 82
  tests_total: 82
  files_modified: 2
---

# Phase 01 Plan 01: globalThis Singleton Anchoring Summary

Anchored DB and SearchIndex singletons on globalThis to survive Next.js dev-mode HMR module reloads, using the standard `declare global { var }` TypeScript pattern.

## Changes Made

### Task 1: DB singleton (src/lib/db/index.ts)
- **Commit:** e8ab2f1
- Replaced `let _db` module-level variable with `globalThis.__bgscheduler_db`
- Added `declare global` block with proper `var` declaration for TypeScript
- Added `DbInstance` type alias for cleaner typing
- Kept `createDb()` and all exports unchanged

### Task 2: SearchIndex singleton (src/lib/search/index.ts)
- **Commit:** 5e90298
- Replaced `let currentIndex` with `globalThis.__bgscheduler_searchIndex`
- Replaced `let buildingPromise` with `globalThis.__bgscheduler_searchIndexBuildPromise`
- Added four private accessor functions: `getCurrentIndex`, `setCurrentIndex`, `getBuildingPromise`, `setBuildingPromise`
- Updated `buildIndex()`, `ensureIndex()`, `getSearchIndex()`, `getActiveSnapshotId()` to use accessors
- All exported function signatures unchanged

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | PASS (exit 0) |
| `npm test` (82 tests) | PASS (all 82) |
| `globalThis.__bgscheduler_db` in db/index.ts | 3 occurrences |
| `globalThis.__bgscheduler_searchIndex` in search/index.ts | 4 occurrences |
| `let _db` in db/index.ts | 0 (removed) |
| `let currentIndex` in search/index.ts | 0 (removed) |

## Known Stubs

None.
