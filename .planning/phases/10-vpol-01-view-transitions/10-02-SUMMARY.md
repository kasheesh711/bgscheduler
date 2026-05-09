---
phase: 10-vpol-01-view-transitions
plan: 02
subsystem: ui
tags: [view-transitions, compare-ui, react-dom, cache-version]

requires:
  - phase: 10-vpol-01-view-transitions
    provides: typed native view-transition helper from 10-01
provides:
  - Fetch-first compare week navigation path that keeps current calendar content visible while target data loads
  - Final loaded week commit through `runCalendarViewTransition` with `flushSync`
  - Unit coverage proving the view-transition helper awaits native `finished`
affects: [10-vpol-01-view-transitions, compare-ui]

tech-stack:
  added: []
  patterns:
    - Prepared compare data separated from visible compare state commits
    - `keepCurrentVisible` compare fetch option for transition-safe week navigation
    - Narrow `flushSync` usage inside native view-transition update callback

key-files:
  created: []
  modified:
    - src/hooks/use-compare.ts
    - src/lib/ui/__tests__/view-transitions.test.ts

key-decisions:
  - "Kept `/api/compare` request keys and `CACHE_VERSION` unchanged; no server, schema, SearchIndex, or response-shape change was introduced."
  - "Prepared target-week compare data before starting the native transition so loading skeletons are never committed as the final visual state."
  - "Added scroll restoration hook points to `changeWeek` through typed `WeekChangeOptions` without changing the returned `changeWeek` property name."

patterns-established:
  - "`fetchCompareData(ids, week, { keepCurrentVisible })` prepares compare state and returns `PreparedCompareState | null`."
  - "`changeWeek(newWeek, options)` fetches target data first, then commits `weekStart` and compare response inside `runCalendarViewTransition` when a transition kind is provided."

requirements-completed: [TRANS-01, TRANS-04, TRANS-05]

duration: 4min
completed: 2026-05-09
---

# Phase 10 Plan 02: Fetch-First Week Timing Summary

**Compare week navigation now fetches target data while preserving the visible calendar, then commits the loaded week inside the native view-transition update path.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-09T08:36:15Z
- **Completed:** 2026-05-09T08:40:23Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Split compare fetching into `fetchCompareData` preparation and `commitPreparedCompare` visible-state commit.
- Added `keepCurrentVisible` so transition-driven week fetches do not replace the current calendar with loading UI.
- Reworked `changeWeek` to fetch target week data first, then commit the loaded week through `runCalendarViewTransition` with scroll restoration hook points.
- Extended helper tests to prove `runCalendarViewTransition` awaits the native `finished` promise while calling `update` exactly once.

## Task Commits

Each task was committed atomically:

1. **Task 1: Split fetch preparation from compare state commit** - `ba7dc13` (feat)
2. **Task 2: Commit loaded week data through the native helper** - `40ae18a` (feat)

**Plan metadata:** committed in the final plan-completion docs commit.

## Files Created/Modified

- `src/hooks/use-compare.ts` - Adds prepared compare state, fetch-first week timing, typed week-change options, native transition commit, and scroll restoration callbacks.
- `src/lib/ui/__tests__/view-transitions.test.ts` - Adds coverage that the helper waits for the native transition `finished` promise and calls `update` once.

## Decisions Made

- Transition imports were added in Task 2 when first used, keeping the Task 1 commit free of unused symbols while preserving the final planned contracts.
- Snapshot-change retry remains a full refetch with no `fetchOnly`, preserving the existing cache invalidation behavior.
- No pending affordance was added during target-week fetch; the existing calendar remains visible per D-07.

## Deviations from Plan

None - plan behavior and final artifacts match the planned implementation.

---

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope creep. The compare API contract, cache version, SearchIndex, schema, and server files were untouched.

## Issues Encountered

None.

## Verification

- `npm test -- src/lib/ui/__tests__/view-transitions.test.ts` - passed, 11 tests.
- `npm test` - passed, 31 files / 246 tests.
- `npm run lint` - exited 0 with 14 pre-existing warnings.
- `rg -n 'keepCurrentVisible: true|runCalendarViewTransition|flushSync' src/hooks/use-compare.ts` - found the expected transition commit path.
- `rg -n 'export const CACHE_VERSION = "v2"' src/lib/search/cache-version.ts` - confirmed cache version unchanged.
- `rg -n 'src/app/api|src/lib/db|src/lib/search/index' src/hooks/use-compare.ts` - no output; no forbidden imports added.
- Stub scan on modified files found no UI stubs or placeholder data flows.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 10-03 can wire ComparePanel week/day handlers into the new `changeWeek(newWeek, options)` path, passing transition kind and scroll capture/restore callbacks while preserving the fetch-first timing model.

## Self-Check: PASSED

- Found `src/hooks/use-compare.ts`.
- Found `src/lib/ui/__tests__/view-transitions.test.ts`.
- Found `.planning/phases/10-vpol-01-view-transitions/10-02-SUMMARY.md`.
- Verified task commits `ba7dc13` and `40ae18a` exist.

---
*Phase: 10-vpol-01-view-transitions*
*Completed: 2026-05-09*
