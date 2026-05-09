---
phase: 10-vpol-01-view-transitions
plan: 03
subsystem: ui
tags: [view-transitions, compare-ui, scroll-restoration, css, vitest]

requires:
  - phase: 10-vpol-01-view-transitions
    provides: typed native view-transition helper and fetch-first week timing from plans 10-01 and 10-02
provides:
  - Transition-aware ComparePanel handlers for week and day navigation
  - Normalized minute-of-day scroll preservation across WeekOverview and CalendarGrid
  - Scoped compare calendar view-transition CSS with reduced-motion disable rules
  - Source guardrail tests for Phase 10 UI-only scope
affects: [10-vpol-01-view-transitions, compare-ui]

tech-stack:
  added: []
  patterns:
    - ComparePanel owns calendar transition orchestration and scroll normalization
    - WeekOverview exposes only its internal scroll container ref
    - Global CSS scopes native view-transition pseudo-elements to a single compare calendar surface

key-files:
  created:
    - src/components/compare/__tests__/view-transitions-source.test.ts
  modified:
    - src/components/compare/compare-panel.tsx
    - src/components/compare/week-overview.tsx
    - src/app/globals.css

key-decisions:
  - "Converted between WeekOverview and CalendarGrid scroll positions through minute-of-day, not raw pixels, because the grids use different hour scales."
  - "Preserved raw scrollTop only for same-view week changes where the source and target pixel scale are identical."
  - "Skipped first-load day transitions until dynamic calendar chunks are preloaded so a skeleton is not captured."

patterns-established:
  - "captureCalendarMinuteOfDay(day) and restoreCalendarMinuteOfDay(day, minuteOfDay) are the ComparePanel-owned scroll bridge."
  - "compare-calendar-transition-surface is the single named native view-transition target for compare calendar body changes."

requirements-completed: [TRANS-01, TRANS-02, TRANS-03, TRANS-04, TRANS-05]

duration: 7 min
completed: 2026-05-09
---

# Phase 10 Plan 03: ComparePanel View Transition Wiring Summary

**Compare navigation now routes week and day changes through native view-transition helpers, preserving the same time-of-day across the 48 px/hour week view and 60 px/hour day view.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-05-09T08:44:42Z
- **Completed:** 2026-05-09T08:52:13Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Added source guardrail tests that lock the UI-only scope, forbidden dependency/config surfaces, cache version, CSS hooks, and normalized scroll conversion evidence.
- Routed week prev/next, Today, calendar-popup week selection, day tabs, density cells, Week-to-Day, Day-to-Day, and Day-to-Week through transition-aware handlers.
- Added WeekOverview scroll-container ref support and ComparePanel refs for both known calendar scroll containers.
- Added scoped global CSS for `week-forward`, `week-back`, and `day` transition types, with 160 ms timing and strict reduced-motion disable rules.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add source guardrail tests** - `edc34a0` (test)
2. **Task 2: Wire compare navigation and scroll restoration** - `80b780d` (feat)
3. **Task 3: Add scoped view-transition CSS** - `3afb5e4` (feat)

**Plan metadata:** committed in the final plan-completion docs commit.

## Files Created/Modified

- `src/components/compare/__tests__/view-transitions-source.test.ts` - Source guardrails for Next config, dependencies, CSS hooks, ComparePanel wiring, scroll conversion, useCompare, and cache version.
- `src/components/compare/compare-panel.tsx` - Adds transition-aware week/day handlers, dynamic chunk preloading, scroll refs, minute-of-day capture/restore, and the named calendar transition surface.
- `src/components/compare/week-overview.tsx` - Adds `scrollContainerRef` plumbing for the internal week-view scroll body.
- `src/app/globals.css` - Adds scoped view-transition pseudo-element rules, six keyframes, root no-op rules, and reduced-motion overrides.

## Decisions Made

- Used explicit calendar scale constants in ComparePanel: `CALENDAR_START_HOUR = 7`, `WEEK_PIXELS_PER_HOUR = 48`, and `DAY_PIXELS_PER_HOUR = 60`.
- Preserved the 5pm conversion as source evidence: week raw 480 px -> 1020 minutes -> day raw 600 px, with the inverse mapping back to 480 px.
- Kept CSS transition type names static (`week-forward`, `week-back`, `day`) and did not introduce any user-provided selector path.

## Deviations from Plan

None - plan executed as written.

---

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope creep. API, schema, SearchIndex, cache-version, and dependency surfaces stayed untouched.

## Issues Encountered

- The Task 2 combined source test still failed on the planned Task 3 CSS assertions after ComparePanel wiring. This matched Task 1's expected RED behavior and was resolved by Task 3.
- `npm run lint` exits 0 with 14 warnings in existing files.

## Verification

- `npm test -- src/lib/ui/__tests__/view-transitions.test.ts src/components/compare/__tests__/view-transitions-source.test.ts` - passed, 2 files / 19 tests.
- `npm test` - passed, 32 files / 254 tests.
- `npm run lint` - passed with 14 warnings and 0 errors.
- `rg -n "viewTransition" next.config.ts` - no output.
- `rg -n "framer-motion|\"motion\"|\"@react-spring|react-spring" package.json` - no output.
- Stub scan on changed files found no placeholder, TODO/FIXME, or hardcoded-empty UI data flows.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 10-04 can perform rendered browser QA for the implemented week slide, day crossfade, reduced-motion instant behavior, skeleton avoidance, and scroll preservation.

## Self-Check: PASSED

- Found `src/components/compare/__tests__/view-transitions-source.test.ts`.
- Found `src/components/compare/compare-panel.tsx`.
- Found `src/components/compare/week-overview.tsx`.
- Found `src/app/globals.css`.
- Found `.planning/phases/10-vpol-01-view-transitions/10-03-SUMMARY.md`.
- Verified task commits `edc34a0`, `80b780d`, and `3afb5e4` exist.

---
*Phase: 10-vpol-01-view-transitions*
*Completed: 2026-05-09*
