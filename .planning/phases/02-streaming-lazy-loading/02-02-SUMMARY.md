---
phase: 02-streaming-lazy-loading
plan: 02
subsystem: ui, api
tags: [use-cache, cacheComponents, cacheTag, revalidateTag, suspense, server-components, streaming]

# Dependency graph
requires:
  - phase: 02-streaming-lazy-loading/01
    provides: "Extracted SearchWorkspace, SearchForm, ComparePanel components with clean props interfaces"
provides:
  - "Cached server functions getFilterOptions() and getTutorList() with cacheTag('snapshot')"
  - "Search page as async Server Component streaming cached data as props"
  - "Cache invalidation via revalidateTag in sync endpoint"
  - "cacheComponents: true enabled in next.config.ts"
affects: [02-streaming-lazy-loading/03]

# Tech tracking
tech-stack:
  added: ["use cache directive", "cacheComponents", "cacheTag", "cacheLife", "revalidateTag"]
  patterns: ["cached server data function", "server-to-client prop streaming", "tag-based cache invalidation"]

key-files:
  created:
    - src/lib/data/filters.ts
    - src/lib/data/tutors.ts
  modified:
    - next.config.ts
    - src/app/(app)/search/page.tsx
    - src/components/search/search-workspace.tsx
    - src/components/search/search-form.tsx
    - src/components/compare/tutor-combobox.tsx
    - src/components/compare/compare-panel.tsx
    - src/app/api/internal/sync-wise/route.ts

key-decisions:
  - "FilterOptions type canonical source moved to src/lib/data/filters.ts, re-exported from search-form.tsx for backward compatibility"
  - "revalidateTag with { expire: 0 } used in Route Handler for immediate invalidation (not 'max' which would serve stale)"

patterns-established:
  - "Cached server function pattern: 'use cache' + cacheTag('snapshot') + cacheLife('hours') inside function body"
  - "Server-to-client data flow: page.tsx (async RSC) -> await cached function -> pass as props -> client component"
  - "Cache invalidation: sync route calls revalidateTag('snapshot', { expire: 0 }) after successful sync"

requirements-completed: [PERF-04, PERF-07]

# Metrics
duration: 3min
completed: 2026-04-10
---

# Phase 2 Plan 2: Server Component & Cache Summary

**Search page converted to async Server Component streaming cached filter/tutor data via 'use cache' + cacheTag('snapshot'), eliminating client-side fetch waterfalls**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-10T10:23:20Z
- **Completed:** 2026-04-10T10:26:22Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Enabled cacheComponents in next.config.ts, unlocking 'use cache' directive, cacheTag, and Activity navigation
- Created two cached server functions (getFilterOptions, getTutorList) with snapshot tag for on-demand invalidation
- Converted search page from "use client" to async Server Component that streams data as props
- Eliminated two client-side fetch waterfalls (useEffect for /api/filters and /api/tutors)
- Added cache invalidation to sync endpoint with revalidateTag("snapshot", { expire: 0 })

## Task Commits

Each task was committed atomically:

1. **Task 1: Enable cacheComponents, create cached data functions, add cache invalidation** - `0e34a8b` (feat)
2. **Task 2: Convert page.tsx to Server Component, wire data as props** - `bdcabf1` (feat)

## Files Created/Modified
- `next.config.ts` - Added cacheComponents: true
- `src/lib/data/filters.ts` - NEW: Cached getFilterOptions() with 'use cache' + cacheTag("snapshot")
- `src/lib/data/tutors.ts` - NEW: Cached getTutorList() with 'use cache' + cacheTag("snapshot")
- `src/app/api/internal/sync-wise/route.ts` - Added revalidateTag("snapshot", { expire: 0 }) after successful sync
- `src/app/(app)/search/page.tsx` - Removed "use client", made async, awaits cached data, passes as props
- `src/components/search/search-workspace.tsx` - Accepts filterOptions + tutorList as props, removed internal fetch
- `src/components/search/search-form.tsx` - Imports FilterOptions from data layer, non-nullable prop
- `src/components/compare/tutor-combobox.tsx` - Accepts tutors as prop, removed internal fetch
- `src/components/compare/compare-panel.tsx` - Passes tutorList through to TutorCombobox

## Decisions Made
- FilterOptions canonical type moved to src/lib/data/filters.ts; search-form.tsx re-exports for backward compatibility
- Used { expire: 0 } for revalidateTag (not "max") since sync endpoint needs immediate cache expiration, not stale-while-revalidate
- Kept existing /api/filters and /api/tutors routes unchanged for backward compatibility (they're no longer in the primary data flow)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- cacheComponents enabled, ready for Plan 03 to add lazy loading with next/dynamic
- ComparePanel now receives tutorList prop, clean insertion point for dynamic imports
- All 82 tests passing, TypeScript compiles clean

---
*Phase: 02-streaming-lazy-loading*
*Completed: 2026-04-10*

## Self-Check: PASSED
