---
phase: 01-component-architecture
plan: 02
subsystem: frontend-components
tags: [extraction, hooks, components, search, compare]
dependency_graph:
  requires: []
  provides: [useCompare-hook, SearchForm-component, SearchResults-component]
  affects: [src/app/(app)/search/page.tsx]
tech_stack:
  added: []
  patterns: [custom-hooks, component-extraction, lifted-state]
key_files:
  created:
    - src/hooks/use-compare.ts
    - src/components/search/search-form.tsx
    - src/components/search/search-results.tsx
  modified: []
decisions:
  - "SearchContext interface added to pass search params from SearchForm to SearchResults for CopyButton"
  - "formatIsoDate kept as private helper in use-compare.ts (not exported, internal only)"
  - "getCurrentMonday returned in hook object for week picker Today button parity"
metrics:
  duration: "2m 29s"
  completed: "2026-04-10T04:44:14Z"
  tasks_completed: 3
  tasks_total: 3
  files_created: 3
  files_modified: 0
---

# Phase 01 Plan 02: Extract SearchForm, SearchResults, useCompare Summary

Extracted three standalone building blocks from the 879-line monolithic search page into importable modules with correct TypeScript types, ready for Plan 03 assembly.

## One-liner

useCompare hook + SearchForm + SearchResults extracted from monolith with SearchContext bridge for cross-component data flow

## What Was Done

### Task 1: Create useCompare hook (per D-05)
- Created `src/hooks/use-compare.ts` with `"use client"` directive
- Extracted 6 helper functions: `getCurrentMonday`, `shiftWeek`, `formatIsoDate`, `formatWeekLabel`, `getWeekDate`, `formatMinute`
- Extracted all compare state: `compareTutors`, `compareResponse`, `compareLoading`, `compareError`, `activeDay`, `discoveryOpen`, `prefillConflict`, `weekStart`
- Extracted 3 refs: `tutorCache`, `lastSnapshotId`, `abortRef`
- Extracted 4 handlers: `fetchCompare` (with recursive snapshot invalidation), `addTutor`, `removeTutor`, `changeWeek`
- Exported `UseCompareReturn` type for downstream typing
- **Commit:** `15a13c4`

### Task 2: Create SearchForm component (per D-01)
- Created `src/components/search/search-form.tsx` with `"use client"` directive
- Exported `FilterOptions`, `SearchContext`, `SearchFormProps` interfaces
- Exported `DAY_NAMES` constant (needed by ComparePanel in Plan 03)
- Moved constants: `DAY_OPTIONS`, `DURATION_OPTIONS`, `TIME_OPTIONS`, `selectClass`
- Component owns all 11 search state variables internally
- `handleSearch` calls `onSearchResponse(data, context)` with SearchContext
- `handleSelectRecent` uses `setTimeout + click` pattern for recent search replay
- Full form JSX: mode toggle, 3-column rows for day/time/duration/mode/filters
- **Commit:** `54b3335`

### Task 3: Create SearchResults component (per D-02)
- Created `src/components/search/search-results.tsx` with `"use client"` directive
- Exported `SearchResultsProps` interface
- Selection state (`selectedIds`) managed internally with `useEffect` reset on response change
- Integrated `AvailabilityGrid`, `CopyButton`, and Compare button
- CopyButton receives props from `SearchContext`
- Empty state: "Search for available tutors"
- **Commit:** `81f559e`

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

1. `npx tsc --noEmit` passes with zero errors
2. `src/hooks/use-compare.ts` exists and exports `useCompare`
3. `src/components/search/search-form.tsx` exists and exports `SearchForm`
4. `src/components/search/search-results.tsx` exists and exports `SearchResults`
5. Monolith `src/app/(app)/search/page.tsx` is UNCHANGED (git diff = 0 lines)

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `15a13c4` | feat(01-02): create useCompare hook with compare state and helpers |
| 2 | `54b3335` | feat(01-02): create SearchForm component with search state and form UI |
| 3 | `81f559e` | feat(01-02): create SearchResults component with selection and compare |

## Self-Check: PASSED

All 3 created files exist. All 3 commit hashes verified in git log.
