---
phase: 10-vpol-01-view-transitions
plan: 01
subsystem: ui
tags: [view-transitions, vitest, accessibility, reduced-motion]

requires:
  - phase: 08-vpol-02-sticky-tutor-legend
    provides: sticky compare z-index baseline
  - phase: 09-vpol-03-density-overview
    provides: frozen compare calendar baseline
provides:
  - Typed native same-document view-transition helper
  - Unit coverage for week direction, rapid navigation, fallback paths, and native transition types
affects: [10-vpol-01-view-transitions, compare-ui]

tech-stack:
  added: []
  patterns:
    - Native document.startViewTransition feature detection behind a typed helper
    - Reduced-motion and unsupported-browser instant fallback before native transition start

key-files:
  created:
    - src/lib/ui/view-transitions.ts
    - src/lib/ui/__tests__/view-transitions.test.ts
  modified: []

key-decisions:
  - "Used native document.startViewTransition directly; did not enable Next experimental.viewTransition or add an animation dependency."
  - "Kept transition type values as the CalendarViewTransitionKind literal union so no arbitrary user string reaches CSS transition types."
  - "Resolved the plan's contradictory literal ViewTransition guardrail by preserving the required export names and verifying no React canary or animation-library usage."

patterns-established:
  - "runCalendarViewTransition(update, options) centralizes SSR, unsupported-browser, reduced-motion, and explicit skip bypass behavior."
  - "isRapidWeekNavigation(previousStartedAt, nowMs, thresholdMs) defines the 300 ms rapid week-navigation bypass rule."

requirements-completed: [TRANS-03, TRANS-05]

duration: 4min
completed: 2026-05-09
---

# Phase 10 Plan 01: View Transition Helper Summary

**Typed native view-transition helper with static transition kinds, 300 ms rapid-navigation detection, and instant fallbacks for SSR, unsupported browsers, reduced motion, and explicit skips.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-09T08:22:27Z
- **Completed:** 2026-05-09T08:26:03Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added `src/lib/ui/view-transitions.ts` with the exact exported helper contracts required by Plan 10-01.
- Added Vitest coverage for week direction mapping, 300 ms rapid-navigation detection, skip/unsupported/reduced-motion bypasses, and native `types: ["day"]` invocation.
- Verified that `next.config.ts` remains free of `viewTransition` and that no animation dependency usage was introduced.

## Task Commits

Each task was committed atomically:

1. **Task 1: Write failing helper tests** - `dd8941b` (test)
2. **Task 2: Implement the typed native helper** - `c25172c` (feat)

**Plan metadata:** pending final docs commit

## Files Created/Modified

- `src/lib/ui/view-transitions.ts` - Typed native view-transition helper and rapid week-navigation utility.
- `src/lib/ui/__tests__/view-transitions.test.ts` - Unit tests for helper contracts, bypass paths, native transition type forwarding, and rapid-navigation threshold.

## Decisions Made

- Used the platform API directly through `document.startViewTransition`, matching the phase decision to avoid Next.js experimental view transitions.
- Kept all transition types static through `CalendarViewTransitionKind`.
- Treated rejected `transition.finished` as non-fatal because the DOM update has already run.

## Deviations from Plan

None - the implementation follows the planned interface and behavior.

Acceptance clarification: the plan says the helper must not contain `ViewTransition`, but it also requires exported names such as `runCalendarViewTransition` and `RunCalendarViewTransitionOptions`. The required export contract was preserved, and the intended guardrail was verified by checking for no React canary imports, no `addTransitionType`, no `react-dom`, and no animation-library usage.

---

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope creep. The only note is a contradictory source-string guardrail; implementation behavior and dependency guardrails are intact.

## Issues Encountered

- The RED test run failed for the expected reason: `../view-transitions` did not exist before Task 2.
- `npm run lint` exits 0, with 14 pre-existing warnings in unrelated files.

## Verification

- `npm test -- src/lib/ui/__tests__/view-transitions.test.ts` - passed, 10 tests.
- `npm test` - passed, 31 files / 245 tests.
- `npm run lint` - passed with warnings only.
- `rg -n 'viewTransition' next.config.ts` - no output.
- `rg -n 'framer-motion|"motion"|"@react-spring|react-spring' package.json src/lib/ui/view-transitions.ts` - no output.
- Stub scan on created files - no stub patterns found.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 10-02 can wire week navigation through the helper's `kind`, `skip`, and rapid-navigation support. No API, schema, cache-version, or dependency changes were introduced.

## Self-Check: PASSED

- Found `src/lib/ui/view-transitions.ts`.
- Found `src/lib/ui/__tests__/view-transitions.test.ts`.
- Found `.planning/phases/10-vpol-01-view-transitions/10-01-SUMMARY.md`.
- Verified task commits `dd8941b` and `c25172c` exist.

---
*Phase: 10-vpol-01-view-transitions*
*Completed: 2026-05-09*
