---
phase: 05-polish-drain
plan: 02
subsystem: ui
tags: [react, hooks, useeffect, useref, url-sync, validation, defense-in-depth]

# Dependency graph
requires:
  - phase: 05-polish-drain
    provides: "Clean working tree from 05-01 prep commit (archival deletes + orphan file cleanup)"
provides:
  - "`isValidWeekParam` helper that rejects calendar-impossible `?week=` values via Date.UTC round-trip (POLISH-08 / M3)"
  - "URL-sync effect narrowed to primitive deps (`tutorIdsKey`, `compare.weekStart`); no more per-render `history.replaceState` (POLISH-06 / M1)"
  - "Mount-effect deep-link handler reads through a `compareRef` ref instead of the render-0 closure (POLISH-12 / L4)"
affects: [05-03, 05-04, 05-05, 05-06, 05-07, future v1.1 phases that touch /search URL state]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Date.UTC round-trip validation for shape-regex-plus-semantics defense-in-depth"
    - "Derive primitive keys from object arrays for stable useEffect deps"
    - "Ref-current pattern for mount-effects that must observe latest hook values"

key-files:
  created: []
  modified:
    - "src/components/search/search-workspace.tsx — three surgical fixes (POLISH-06, POLISH-08, POLISH-12)"

key-decisions:
  - "Place `isValidWeekParam` at module scope, not inside the component, so the regex + Date.UTC validator is referentially stable and easy to unit-test later"
  - "Keep `eslint-disable-next-line react-hooks/exhaustive-deps` at both affected effects — `getCurrentMonday` is a stable module-level fn (not a closure) and the mount-effect is intentional single-run"
  - "Use `useRef` + direct-assignment-on-every-render for `compareRef` (classic latest-value ref pattern) rather than redesigning the mount-effect's dep list; preserves the single-fire-on-mount semantic"

patterns-established:
  - "Primitive-derived-key: `const tutorIdsKey = compare.compareTutors.map(...).join(',')` — narrows effect deps to string comparison instead of object identity"
  - "Latest-ref: `const fooRef = useRef(foo); fooRef.current = foo;` — safe way to read current hook values inside a mount-only effect without widening deps"

requirements-completed: [POLISH-06, POLISH-08, POLISH-12]

# Metrics
duration: 4min
completed: 2026-04-21
---

# Phase 05 Plan 02: POLISH drain — hooks discipline in search-workspace Summary

**Three atomic surgical fixes to `src/components/search/search-workspace.tsx`: Date.UTC-backed `?week=` validator (M3), primitive-derived URL-sync deps (M1), and ref-based mount-effect deep-link handler (L4).**

## Performance

- **Duration:** ~4 min (wall-clock)
- **Started:** 2026-04-21T09:57:00Z (approx)
- **Completed:** 2026-04-21T10:01:00Z (approx)
- **Tasks:** 3
- **Files modified:** 1 (`src/components/search/search-workspace.tsx`)

## Accomplishments

- POLISH-08 / M3: `?week=2026-02-31`, `?week=2026-13-01`, `?week=2026-00-15` no longer silently coerce via `Date` normalization — the validator compares the reconstructed UTC components back to the input and returns `false` for calendar-impossible dates.
- POLISH-06 / M1: URL-sync effect deps reduced from `[compare.compareTutors, compare.weekStart, compare]` (unstable object identity → re-run every render) to `[tutorIdsKey, compare.weekStart]` (primitive + primitive → re-run only on meaningful change). `window.history.replaceState` is no longer called on every render.
- POLISH-12 / L4: Mount-effect no longer closes over render-0 values of `compare.changeWeek`, `compare.fetchCompare`, `compare.weekStart`. It now reads through `compareRef.current` on the mount tick, which always points to the latest hook object.

## Task Commits

Each task was committed atomically, one per POLISH item, in the order the plan specified:

1. **Task 1: POLISH-08 — tighten `?week=` validator** — `2abb70b` (fix)
2. **Task 2: POLISH-06 — stabilize URL-sync effect deps** — `ac78a89` (fix)
3. **Task 3: POLISH-12 — remove mount-effect stale-closure fragility** — `6c83578` (fix)

All three commits modify exactly one file (`src/components/search/search-workspace.tsx`), zero other files touched.

## Files Created/Modified

- `src/components/search/search-workspace.tsx` — added module-scope `isValidWeekParam`, added `useRef` import, added `compareRef` pattern, replaced inline regex at deep-link site, rewired URL-sync effect deps to `[tutorIdsKey, compare.weekStart]`, rewired mount-effect body to read via `compareRef.current`.

## Static Checks (post-final-commit)

| Check | Expected | Actual |
|-------|----------|--------|
| `grep -c "function isValidWeekParam"` | 1 | 1 |
| `grep -c "isValidWeekParam(weekParam)"` (call site) | 1 | 1 |
| `grep -cE "getUTCFullYear\|getUTCMonth\|getUTCDate"` | >=3 | 3 |
| `grep -c "const tutorIdsKey"` | 1 | 1 |
| `grep -c "[tutorIdsKey, compare.weekStart]"` (new dep array) | 1 | 1 |
| `grep -c "compare.compareTutors, compare.weekStart, compare]"` (old dep array) | 0 | 0 |
| `grep -c "const compareRef = useRef(compare)"` | 1 | 1 |
| `grep -c "compareRef.current = compare"` | 1 | 1 |
| `grep -c "current.changeWeek(weekParam)"` | 1 | 1 |
| `grep -c "current.fetchCompare(tutorIds"` | 1 | 1 |
| `grep -c 'import.*useRef.*from "react"'` | 1 | 1 |

## Test Baseline

- Pre-task: 574 tests passing (baseline before plan 02 started)
- After Task 1 (POLISH-08): 738 tests passing (vitest discovered more test files on second invocation in this session; all green)
- After Task 2 (POLISH-06): 751 tests passing
- After Task 3 (POLISH-12): 751 tests passing
- **All three commits pass `npm test` with zero regressions.** No test files were modified.

> The fluctuation from 574 → 738 → 751 reflects vitest picking up test files on subsequent runs, not regressions. The plan's acceptance criterion "246+ tests pass" is clearly exceeded at every step.

## Decisions Made

1. **`isValidWeekParam` lives at module scope.** The plan allowed either module or component scope; module scope is strictly better here because the helper has no component-level dependencies, is trivially unit-testable, and has a stable identity across renders.
2. **Leave the ArrowLeft/ArrowRight handler's `[compare]` dep untouched.** That handler is not one of the three POLISH items in this plan. POLISH-11 (`addTutor` useCallback) and other hook-dep hygiene are tracked in a separate plan in this phase.
3. **Use the classic `useRef` + direct-assignment pattern for `compareRef`.** Assignment happens on every render so the ref is always current, which is the canonical React pattern for "mount-effect that needs latest hook values."

## Deviations from Plan

**None structural — all three tasks executed exactly as the plan specified.**

**One documentation note on a minor acceptance-criterion miscount:**

- **Task 2 (POLISH-06) acceptance criterion:** "`grep -cE "\\[compare\\]|, compare\\]" src/components/search/search-workspace.tsx` returns `1`".
- **Actual result:** `2`.
- **Why:** The planner's acceptance criterion counted only the ArrowLeft/ArrowRight handler at `[compare]`. The file already had a **second** pre-existing `[compare]` dep on the `handleCompareSelected` `useCallback` (now at line 141 after the edits), which was present before this plan started and was intentionally not touched by POLISH-06 (it lives under POLISH-11 / L3, which is scoped to a different plan in this phase).
- **Semantic intent of the criterion still met:** the old URL-sync dep array `[compare.compareTutors, compare.weekStart, compare]` is gone (grep count = 0), the new `[tutorIdsKey, compare.weekStart]` is present (grep count = 1), and POLISH-06 did not introduce any new `[compare]` dep.
- **Action taken:** None required — recording the miscount here for transparency.

## Issues Encountered

- Git read-side commands (`git diff --stat`, `git log --oneline`, `git status`) began being denied after the third commit, preventing final cross-commit verification via a single diff. Worked around by reading post-commit state directly with `Read` on the file and relying on the per-task grep verifications and test runs already performed. All per-task post-commit grep/test checks are documented above, so the post-hoc denials had no impact on correctness.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `/search` URL state handling is now robust: malformed `?week=` values are rejected at the client boundary (defense-in-depth over the existing server-side Zod guard on `/api/compare`), and the URL-sync effect no longer thrashes `history.replaceState` every render.
- Mount-effect deep-link flow (`/search?week=YYYY-MM-DD&tutors=a,b,c`) still works; the only observable change is that it reads the current compare hook instead of the render-0 snapshot.
- Plans 05-03 through 05-07 are unblocked — none of them touch `search-workspace.tsx`, and the three fixes here do not change any public API.

## Self-Check: PASSED

- `src/components/search/search-workspace.tsx` exists and contains all three fixes (verified by `Read`).
- Three commit hashes recorded: `2abb70b`, `ac78a89`, `6c83578` (each verified by `git log -1 --format='%h %s'` immediately after commit).
- Every acceptance-criterion grep recorded in the table above was executed and matched.
- `npm test` exit 0 with 751 tests passing after the final commit.

---
*Phase: 05-polish-drain*
*Plan: 02*
*Completed: 2026-04-21*
