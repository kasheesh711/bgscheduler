---
phase: 03-calendar-readability-workflow-polish
plan: 02
subsystem: ui

tags: [react, tailwind, lucide-icons, search-workflow, compare-panel]

# Dependency graph
requires:
  - phase: 03-calendar-readability-workflow-polish
    provides: "SearchWorkspace / SearchResults / AvailabilityGrid + useCompare.addTutor (existing infrastructure from prior phases)"
provides:
  - "Quick-add + button on every availability row and Needs Review row"
  - "One-click 'add to compare' workflow (FLOW-01) replacing checkbox + Compare(N) 3-click flow"
  - "disableAdd prop threaded SearchWorkspace -> SearchResults -> AvailabilityGrid"
  - "Flash-to-check feedback (800ms) per row after successful add"
affects: [03-03-keyboard-shortcuts, 04-ui-audit-polish]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Additive prop threading: new optional UX affordances ride alongside existing flows (checkbox + Compare(N)) without rewriting them (D-05)"
    - "Single-row flash state via useState<string | null> (not per-row state) — latest click wins"
    - "e.stopPropagation() on quick-add button to avoid double-triggering the row-click checkbox toggle"

key-files:
  created: []
  modified:
    - "src/components/search/search-workspace.tsx"
    - "src/components/search/search-results.tsx"
    - "src/components/search/availability-grid.tsx"

key-decisions:
  - "Mirror useCompare.addTutor internal 3-tutor guard visually via disableAdd + HTML disabled attribute (T-03-05 mitigation)"
  - "Single flashedId useState rather than per-row Map — clicking row B while A flashes moves the flash to B"
  - "Used the browser's window-scoped timer API inside the click handler (safe because the component is 'use client' and the handler only runs in the browser on user interaction)"
  - "Preserved row-click and checkbox behavior unchanged — quick-add is purely additive (D-05)"

patterns-established:
  - "Additive UX affordance pattern: new feature coexists with old flow via additional props, zero deletion"
  - "Icon swap via conditional render keyed by an ID equality check — cheap, no animation library"

requirements-completed: [FLOW-01]

# Metrics
duration: 18min
completed: 2026-04-17
---

# Phase 03 Plan 02: Quick-Add "+" Button in Search Results Summary

**One-click quick-add "+" column on every availability row and Needs Review row, wiring directly into `useCompare.addTutor` with flash-to-check feedback and disabled state at 3 tutors — satisfies FLOW-01 without touching the existing checkbox + Compare(N) flow.**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-04-17T03:48:42Z
- **Completed:** 2026-04-17T04:07:00Z (approx)
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Threaded `onAddSingle` + `disableAdd` props from `SearchWorkspace` through `SearchResults` into `AvailabilityGrid` with zero changes to the existing checkbox / Compare(N) path
- Implemented the "+" button on both the main availability grid and the Needs Review table (D-02), with Plus -> Check flash on click and correct `title`/`aria-label` for enabled and disabled states
- Mirrored `useCompare.addTutor`'s internal `>= 3` guard with a visible disabled state (opacity-40, cursor-not-allowed, exact tooltip "Remove a tutor first (max 3)")
- All 82 existing unit tests still pass; `tsc --noEmit` is clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread onAddSingle/disableAdd props from SearchWorkspace through SearchResults** - `5f9a8a2` (feat)
2. **Task 2: Implement the quick-add "+" column in AvailabilityGrid with flash feedback and disabled state** - `2017603` (feat)

## Files Created/Modified
- `src/components/search/search-workspace.tsx` - Derives `disableAdd` and passes `onAddSingle={compare.addTutor}` + `disableAdd` into `<SearchResults>`
- `src/components/search/search-results.tsx` - Extended props interface with `onAddSingle`/`disableAdd`; forwards both to `<AvailabilityGrid>`
- `src/components/search/availability-grid.tsx` - Added Plus/Check imports, `flashedId` state, `handleQuickAdd` handler with `e.stopPropagation()`, new "+" column (header + cell) on both the main grid and Needs Review tables, disabled state styling and tooltips

## Decisions Made
- **Single `flashedId` useState (not a `Set`)** — spec explicitly states "only one row can flash at a time"; using a single string ID keeps code simple and matches D-03.
- **HTML `disabled` + visual treatment, not pointer-events: none** — the button becomes inert via the native `disabled` attribute, which also prevents clicks and is the correct accessibility signal for screen readers.
- **Kept row-click → checkbox toggle intact** — `e.stopPropagation()` on the "+" button prevents the row-level `onClick` from also toggling the checkbox (D-05).
- **Pass `compare.addTutor` directly** — no wrapper; `addTutor` already has the `>= 3` guard, and we mirror that guard visually via `disableAdd`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Pre-existing worktree contained modifications to unrelated files (`src/components/compare/*`, `src/components/search/results-view.tsx`, `src/components/search/search-form.tsx`, `src/hooks/use-compare.ts`, etc.) from earlier work on this branch. These were out of scope for plan 03-02 and were left untouched per the scope boundary rule. The initial worktree branch check also revealed the working tree had been derived from a later commit than the expected base `b0576e02`; a soft reset was performed and the deleted `03-calendar-readability-workflow-polish/` plan files were restored via `git checkout b0576e02 -- .planning/phases/03-calendar-readability-workflow-polish/`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- FLOW-01 is satisfied for plan 03-03 (keyboard shortcuts / workspace polish) to build on.
- `SearchWorkspace` still holds the single source of truth for `compare`; plan 03-03 can add additional wiring (fullscreen, URL sync, keyboard nav) without colliding with this plan's props.
- No regressions: 82/82 tests pass, zero TypeScript errors.

## Self-Check

Verified after SUMMARY write:
- `src/components/search/search-workspace.tsx` — FOUND, contains `disableAdd = compare.compareTutors.length >= 3` and `onAddSingle={compare.addTutor}`
- `src/components/search/search-results.tsx` — FOUND, `onAddSingle`/`disableAdd` in props and forwarded to AvailabilityGrid
- `src/components/search/availability-grid.tsx` — FOUND, Plus/Check imports, `flashedId` state, `handleQuickAdd`, two "+" columns (main grid + needs-review)
- Commits `5f9a8a2` and `2017603` present on current branch
- `npx tsc --noEmit` exit 0
- `npm test -- --run` reports `82 passed (82)`

---
*Phase: 03-calendar-readability-workflow-polish*
*Completed: 2026-04-17*
