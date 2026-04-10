# Phase 1: Component Architecture - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Break the 878-line monolithic search page (`src/app/(app)/search/page.tsx`) into focused client components and extract shared state into a custom hook. Anchor server-side singletons on `globalThis`. Zero visual regression.

</domain>

<decisions>
## Implementation Decisions

### Component Extraction
- **D-01:** Extract `SearchForm` — owns search form state (mode, day, time, duration, filters), filter option fetching, and form submission. Receives `onSearch` callback and `filterOptions` as props.
- **D-02:** Extract `SearchResults` — owns search results display, row selection state, copy-for-parents, and "Compare (N)" button. Receives search response data and emits selected tutor IDs.
- **D-03:** Extract `ComparePanel` — owns the entire right panel: tutor selector chips, combobox, week picker, week/day tabs, calendar grid, conflict summary, free slot indicators, and discovery modal trigger.
- **D-04:** Extract `SearchWorkspace` — the top-level layout component that wires SearchForm, SearchResults, and ComparePanel together in the side-by-side split. Minimal state — delegates to children and useCompare hook.

### State Management
- **D-05:** Extract `useCompare` custom hook owning all compare state: `compareTutors`, `tutorCache` (Map ref), `abortRef`, `lastSnapshotId`, `weekStart`, `fetchCompare`, `addTutor`, `removeTutor`, `changeWeek`. Returns state + actions. No context provider needed — hook is called once in SearchWorkspace and passed down as props.
- **D-06:** Communication between search and compare: SearchResults emits selected tutor IDs via callback prop. SearchWorkspace passes this to ComparePanel's `addTutor` action.

### Singleton Anchoring
- **D-07:** Anchor `_db` (in `src/lib/db/index.ts`) and `currentIndex` (in `src/lib/search/index.ts`) on `globalThis` to survive across server-side module reloads in development. Use a namespaced key like `__bgscheduler_db` and `__bgscheduler_searchIndex`.

### Claude's Discretion
- File naming and internal organization of extracted components
- Whether helper functions (getCurrentMonday, shiftWeek, formatWeekLabel, etc.) move into a shared utils file or stay colocated
- Exact prop interfaces for each component — derive from current inline state usage
- TypeScript type declarations for globalThis extensions

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

No external specs — requirements fully captured in decisions above and REQUIREMENTS.md.

### Core files to read
- `src/app/(app)/search/page.tsx` — The 878-line monolith being decomposed (source of truth for all state and logic)
- `src/components/compare/` — Existing compare sub-components (already extracted: calendar-grid, week-overview, discovery-panel, tutor-combobox, tutor-selector, session-colors, tutor-profile-popover)
- `src/components/search/` — Existing search sub-components (already extracted: availability-grid, copy-button, recent-searches, results-view, slot-builder, slot-chips, slot-input)
- `src/lib/search/types.ts` — Shared type definitions (SearchMode, RangeSearchResponse, CompareResponse, CompareTutor, Conflict)
- `src/lib/db/index.ts` — DB singleton (`let _db`) to anchor on globalThis
- `src/lib/search/index.ts` — SearchIndex singleton (`let currentIndex`) to anchor on globalThis

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Compare sub-components already exist in `src/components/compare/` — CalendarGrid, WeekOverview, DiscoveryPanel, TutorCombobox, TutorSelector are already separate files
- Search sub-components already exist in `src/components/search/` — AvailabilityGrid, CopyButton, RecentSearches, ResultsView, SlotBuilder
- shadcn/ui primitives (Button, Card, Badge, Dialog, Popover, Command) already in `src/components/ui/`

### Established Patterns
- `"use client"` directive at top of interactive components
- Props typed inline or via imported interfaces
- `cn()` utility for class merging (Tailwind)
- Constants defined above component, helper functions in same file
- Named exports for sub-components, default export for page components

### Integration Points
- `src/app/(app)/search/page.tsx` is the only file being decomposed — no other files import from it
- New components go in `src/components/search/` and `src/components/compare/` (existing directories)
- `useCompare` hook goes in a new file (e.g., `src/hooks/use-compare.ts` or colocated)
- SearchWorkspace replaces SearchPageInner as the main composition root

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. This is a mechanical refactoring phase with clear requirements.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-component-architecture*
*Context gathered: 2026-04-10*
