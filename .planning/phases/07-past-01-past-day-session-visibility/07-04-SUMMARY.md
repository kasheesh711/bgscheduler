---
phase: 07-past-01-past-day-session-visibility
plan: 04
subsystem: api

tags:
  - compare-engine
  - search-index
  - past-sessions
  - asia-bangkok
  - date-fns-tz

# Dependency graph
requires:
  - phase: 07-past-01-past-day-session-visibility
    provides: pastSessionBlocks schema + migration (Plan 01); pastBlocks fetcher interface shape (Plan 03)
provides:
  - IndexedTutorGroup.canonicalKey exposure (additive single-field change, D-04)
  - buildCompareTutor(pastBlocks?) parameter wired BEFORE filter pipeline (D-06)
  - Per-weekday isHistoricalRange evaluation in buildCompareTutor (D-05 / PAST-04)
  - Exported helpers getStartOfTodayBkk + computeDateForWeekdayInRange (reusable by Plan 05 route boundary)
affects:
  - 07-05-api-compare-historical-trigger (consumes canonicalKey + pastBlocks signature)
  - 07-03-past-sessions-cached-fetcher (feeds pastBlocks to Plan 05 which feeds buildCompareTutor)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-weekday historical check via computeDateForWeekdayInRange — scalar helper avoids binary-range anti-pattern (research Pitfall 6)"
    - "pastBlocks merged BEFORE filter pipeline — downstream weeklyHours/studentCount/detectConflicts consume unified list transparently (Pitfall 13)"
    - "Default parameter now: Date = new Date() on getStartOfTodayBkk so vi.setSystemTime-style test mocks work without DI plumbing"

key-files:
  created: []
  modified:
    - src/lib/search/index.ts
    - src/lib/search/compare.ts
    - src/lib/search/__tests__/compare.test.ts
    - src/lib/search/__tests__/engine.test.ts

key-decisions:
  - "Option 1 from research (extend IndexedTutorGroup by one field) chosen over Option 2 (per-request DB query) — zero DB overhead, matches D-18 additive-only constraint"
  - "pastBlocks merged via spread concat (safe because past and future startTime ranges are disjoint by definition — no duplicates possible)"
  - "allBlocks unified variable used throughout filter + fallback so future blocks remain candidates for nearest-future-occurrence fallback on non-historical weekdays"
  - "makeTutor fixture in engine.test.ts updated alongside compare.test.ts (Rule 3 blocking issue — canonicalKey is required for TS compilation)"

patterns-established:
  - "Scoped-tsconfig verification (`/tmp/tsc-scope.json`) — lets executors type-check only the changed surface when the worktree's npm env is broken (pre-existing issue per STATE.md anti-pattern #3)"

requirements-completed:
  - PAST-01
  - PAST-04

# Metrics
duration: ~60min
completed: 2026-04-22
---

# Phase 07 Plan 04: buildCompareTutor Historical Merge Summary

**buildCompareTutor now accepts optional pastBlocks and evaluates historical-ness per-weekday (D-05), with canonicalKey exposed on IndexedTutorGroup for zero-DB-overhead routing in Plan 05.**

## Performance

- **Duration:** ~60 min (blocked ~20 min by env issues — vitest/picomatch broken across worktrees; pre-existing per STATE.md)
- **Started:** 2026-04-22T05:10:00Z (approx, worktree git-reset complete)
- **Completed:** 2026-04-22T06:13:00Z
- **Tasks:** 2 (both auto-type)
- **Files modified:** 4

## Accomplishments

- `IndexedTutorGroup.canonicalKey: string` added (additive, no SearchIndex shape churn per D-18)
- `buildIndex` populates canonicalKey from the existing `tutor_identity_groups` SELECT (zero new DB query)
- `buildCompareTutor(group, weekdays?, dateRange?, pastBlocks?)` — fourth parameter optional, backward-compatible with every existing caller (Plan 05 will be first consumer)
- D-06 merge: `pastBlocks` concatenated with `group.sessionBlocks` BEFORE filter/weekdaySet checks — downstream functions (weeklyHoursBooked, studentCount, detectConflicts) see unified session list transparently
- D-05 / PAST-04: per-weekday `isHistoricalRange` check via `computeDateForWeekdayInRange` — past days skip fallback; today + future days keep the existing nearest-future-occurrence fallback
- Two new exported helpers: `getStartOfTodayBkk(now?)` (default-parameter allows vi.setSystemTime mocking) and `computeDateForWeekdayInRange(weekday, dateRange)` (mirrors client-side `getWeekDate` arithmetic to prevent off-by-one drift)
- 6 new test cases covering: historical-only capture, honest empty, future fallback preservation, mixed current-week per-weekday enforcement, backward-compat sans pastBlocks, and detectConflicts seeing past+future merged (Pitfall 13)
- Regression guard verified: `grep -c "past_session_blocks\|pastSessionBlocks" src/lib/search/index.ts` returns 0 (D-18 enforcement — past data stays OUT of the SearchIndex singleton)

## Task Commits

Each task was committed atomically (with `--no-verify` per orchestrator instructions):

1. **Task 1: Expose canonicalKey on IndexedTutorGroup** — `1139486` (feat)
   - `src/lib/search/index.ts`: interface + mapping
   - `src/lib/search/__tests__/engine.test.ts`: makeTutor fixture update (Rule 3 blocking issue — required for TS compilation)

2. **Task 2: buildCompareTutor past+future merge + per-weekday historical flag** — `ebab118` (feat)
   - `src/lib/search/compare.ts`: signature extension, merge, per-weekday flag, two exported helpers
   - `src/lib/search/__tests__/compare.test.ts`: makeTutor canonicalKey + 6 new test cases + vi/beforeEach/afterEach imports

## Files Created/Modified

- `src/lib/search/index.ts` — `IndexedTutorGroup.canonicalKey: string` added; `buildIndex` mapping populates it from existing SELECT
- `src/lib/search/compare.ts` — `import { toZonedTime } from "date-fns-tz"` added; new exports `getStartOfTodayBkk`, `computeDateForWeekdayInRange`; `buildCompareTutor` gains `pastBlocks?` param with D-06 merge and D-05 per-weekday flag (416 LOC total vs 358 baseline = +58 LOC)
- `src/lib/search/__tests__/compare.test.ts` — new `describe("buildCompareTutor past+future merge + per-weekday historical flag (Phase 7)")` block with 6 tests; `makeTutor` fixture updated; vitest fake-timer imports added (36 total `it()` cases vs 30 baseline = +6 as required)
- `src/lib/search/__tests__/engine.test.ts` — `makeTutor` fixture updated with `canonicalKey` (forced by Task 1's new required field)

## Decisions Made

- **Option 1 (extend `IndexedTutorGroup`) over Option 2 (per-request DB query)** — matches D-18's additive-only constraint and avoids a per-`/api/compare` DB round-trip. Research §"Pattern 5 Note (canonicalKey)" flagged Option 1 as recommended.
- **`pastBlocks && pastBlocks.length > 0` guard** (not just `pastBlocks ? [...] : ...` as in the research sketch) — avoids unnecessary array allocation when the caller passes `[]`. Semantically equivalent; a micro-optimization consistent with the hot-path nature of `buildCompareTutor`.
- **`allBlocks` (not `group.sessionBlocks`) inside the fallback filter** — ensures past blocks remain visible to the existing startTime check even though `s.startTime >= dateRange.end` predicate naturally excludes them (past blocks have startTime < now). Belt-and-suspenders: if a future maintainer loosens the predicate, past blocks won't silently leak into the fallback candidate pool.
- **Default parameter on `getStartOfTodayBkk(now: Date = new Date())`** — tests use `vi.setSystemTime` + default-arg path (simpler than DI plumbing). Research blueprint used `getStartOfTodayBkk()` with no parameter; added a defaulted `now` arg so tests stay ergonomic and a future caller could inject for non-test purposes.
- **`computeDateForWeekdayInRange` uses `new Date(Y, M, D + offset)` constructor** — three-arg form instead of research's `date.setDate(...)` mutation. Produces the same result but avoids a mutable intermediate date — cleaner semantics.
- **`classType: "ONE_TO_ONE"` in one test fixture** — kept for symmetry with existing Ava T. fixture (line 26 of compare.test.ts baseline); harmless noise.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] `engine.test.ts` makeTutor needs canonicalKey for TS compilation**
- **Found during:** Task 1 (Expose canonicalKey on IndexedTutorGroup)
- **Issue:** Task 1 made `canonicalKey: string` a required field. `src/lib/search/__tests__/engine.test.ts:6-25` literally constructs an `IndexedTutorGroup` in its `makeTutor` helper without the new required field — would fail TS2741 and block any subsequent test run. The plan's task list only named `compare.test.ts` but the same refactor is required for `engine.test.ts` for the build to pass.
- **Fix:** Added `canonicalKey: "test-tutor"` to the `engine.test.ts` `makeTutor` fixture (same line/position as `compare.test.ts`).
- **Files modified:** `src/lib/search/__tests__/engine.test.ts`
- **Verification:** `grep -c "canonicalKey" src/lib/search/__tests__/engine.test.ts` → 1 (line 9); scoped `tsc --noEmit` on the search module compiles with exit 0 (no errors from my surface; the only tsc complaint is pre-existing `TS2688 Cannot find type definition file for 'node'` — environmental per STATE.md anti-pattern #3).
- **Committed in:** `1139486` (Task 1 commit — bundled because without this fix Task 1 alone doesn't compile)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for compilation. No scope creep — just extending the plan's `compare.test.ts` fixture update to the sibling test file with the same shape.

## Divergence from Research §Pattern 4 Blueprint

All deliberate, none behavioral:

- `getStartOfTodayBkk` takes an optional defaulted `now: Date = new Date()` parameter (blueprint had no parameter). Enables `vi.setSystemTime` mocking without global monkey-patching.
- `computeDateForWeekdayInRange` uses the `new Date(Y, M, D + offset)` three-arg constructor instead of `date.setDate(...)` mutation. Same result, no mutable intermediate.
- `pastBlocks && pastBlocks.length > 0` guard (blueprint used `pastBlocks ? [...] : ...`). Equivalent behavior; avoids unnecessary array allocation when caller passes `[]`.

## Backward Compatibility

**`pastBlocks` is optional — Plan 05 is the first caller.** Every existing caller of `buildCompareTutor` (currently only `src/app/api/compare/route.ts` line 108 and `src/lib/search/__tests__/compare.test.ts` existing cases) continues to work unchanged because the new parameter defaults to `undefined`. When `pastBlocks` is undefined or empty, `allBlocks === group.sessionBlocks` and the filter/fallback pipeline behaves identically to the pre-Phase-7 implementation for today/future days. For historical days (only reachable when `dateRange.start` is in the past), the per-weekday flag now correctly disables the fallback — this is a BEHAVIORAL CHANGE for historical ranges but matches D-05/PAST-04 requirements exactly. No existing test exercised a pre-today `dateRange`, so no regression.

## Issues Encountered

- **Environmental: `npm test` / `vitest` / `tsc` broken in worktree env.** `pico is not a function` from picomatch 4.0.4 with Node 22; `TypeError: parse.fastpaths is not a function` from tinyglobby's picomatch. Pre-existing across all three worktrees (confirmed by running vitest in sibling `agent-a08a0cee`). Mitigated via `/tmp/tsc-scope.json` (scoped tsconfig with `types: []`) that compiles ONLY the modified surface — resulted in a clean `exit 0` type-check. Vercel build + CI run the authoritative test gate (per STATE.md anti-pattern #3). Test logic was traced manually against the existing `buildCompareTutor` pipeline to confirm all 6 new cases are correct.
- **Worktree base mismatch at start.** Worktree was checked out at `5ed3d2f` but orchestrator instructed base `2fb7e6df`. `git reset --soft` followed by `git checkout 2fb7e6df -- .` restored working tree to the expected Phase-7-wave-1 baseline (pastSessionBlocks schema, cache-version bump, etc. already present).

## Self-Check: PASSED

- `src/lib/search/index.ts` — `grep -c "canonicalKey: string"` = 1; `grep -c "canonicalKey: group.canonicalKey"` = 1; `grep -c "past_session_blocks\|pastSessionBlocks"` = 0 (regression guard D-18)
- `src/lib/search/compare.ts` — `grep -c "pastBlocks?: IndexedSessionBlock\[\]"` = 1; `grep -c "export function getStartOfTodayBkk"` = 1; `grep -c "export function computeDateForWeekdayInRange"` = 1; `grep -c "if (dateForWeekday && dateForWeekday < startOfTodayBkk) continue"` = 1; `grep -c "const allBlocks = pastBlocks && pastBlocks.length > 0"` = 1; `grep -c "toZonedTime"` = 2 (import + usage)
- `src/lib/search/__tests__/compare.test.ts` — `grep -c 'describe("buildCompareTutor past+future merge'` = 1; `grep -c "  it(\""` = 36 (baseline 30 + 6 new)
- Commits exist: `git log --oneline -5` shows `ebab118 feat(07-04): buildCompareTutor...` and `1139486 feat(07-04): expose canonicalKey...` on branch `worktree-agent-a2e3105f`
- Files exist: `.planning/phases/07-past-01-past-day-session-visibility/07-04-SUMMARY.md` is this file
- Scoped `tsc --noEmit` exits 0 (no errors on changed surface)

## Next Plan Readiness

- **Plan 05 unblocked:** `IndexedTutorGroup.canonicalKey` + `buildCompareTutor(..., pastBlocks)` signature are both in place. Plan 05 can now call `indexedGroups.map((g) => g.canonicalKey)` directly and route per-group `pastBlocks` slices into `buildCompareTutor` without an extra DB query.
- **`findSharedFreeSlots` awareness:** Research §"Downstream transparency" flagged that `findSharedFreeSlots` filters `group.sessionBlocks` directly — past blocks NOT in `group.sessionBlocks` will miss this query. Plan 05 must pre-merge past blocks into a temporary `groupsWithPast` structure before calling `findSharedFreeSlots` (research §Pattern 5 shows the exact shape). NOT fixed in Plan 04 because it would require changing `findSharedFreeSlots`'s signature or mutating `group.sessionBlocks` (both out of this plan's scope — surface minimization per D-18).
- **Unresolved advisory:** `src/lib/search/__tests__/engine.test.ts` `makeIndex` builds a `SearchIndex` from `tutorGroups` including the new `canonicalKey` — no changes needed for existing engine tests (they never assert `canonicalKey`).

---

*Phase: 07-past-01-past-day-session-visibility*
*Completed: 2026-04-22*
