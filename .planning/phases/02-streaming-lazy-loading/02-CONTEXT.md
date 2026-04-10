# Phase 2: Streaming & Lazy Loading - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Near-instant page load with progressive data streaming, code splitting, and server-side caching. The search page streams filter and tutor data from the server via Suspense, heavy compare components load lazily on demand, and snapshot-bound data is cached with tag-based invalidation.

</domain>

<decisions>
## Implementation Decisions

### Server/Client Boundary
- **D-01:** Claude's discretion on RSC boundary approach — decide whether page.tsx becomes a Server Component with props drilling or uses per-section Suspense wrappers, based on what fits Phase 1's component structure best.
- **D-02:** Progressive streaming — show skeleton shell immediately via `loading.tsx`, then stream in filter dropdowns and tutor combobox as each data promise resolves. User sees page structure right away, sections fill in progressively.

### Skeleton Design
- **D-03:** Shimmer animated skeletons — gray placeholder blocks with subtle pulse/shimmer animation. Standard pattern matching Google/GitHub style.
- **D-04:** High fidelity skeletons — skeleton mirrors exact layout: side-by-side panels, form field shapes, calendar grid outline. Prevents layout shift when real content loads.
- **D-05:** Two skeleton levels: route-level `loading.tsx` (shown during navigation) and per-section Suspense fallbacks (shown while individual data streams arrive).

### Lazy Loading
- **D-06:** Lazy load trigger: on first tutor add — WeekOverview and CalendarGrid load when the first tutor is added to compare (user won't see calendar until they have a tutor). DiscoveryPanel loads when the discovery modal opens.
- **D-07:** Lazy loading fallback: shimmer skeleton matching calendar grid shape. Consistent with the rest of the skeleton design system.

### Cache Strategy
- **D-08:** Sync endpoint purges cache — after successful snapshot promotion, `sync-wise` route calls `revalidateTag('snapshot')`. Next request rebuilds cache. Immediate invalidation, no stale data window.
- **D-09:** Cache scope: only filter options and tutor list — cache the data behind `/api/filters` and `/api/tutors` (slow-changing, snapshot-bound). Search and compare remain uncached since they depend on user-specific query params.

### Claude's Discretion
- RSC boundary approach (props drilling vs per-section Suspense wrappers) — D-01
- Whether to use `next/dynamic` vs `React.lazy` for code splitting
- Exact Suspense boundary placement and fallback component structure
- Whether filter and tutor data use `'use cache'` directive on server functions or cached API routes
- TypeScript types for skeleton prop interfaces

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Core files to modify
- `src/app/(app)/search/page.tsx` — Current client-only page, convert to Server Component with streaming
- `next.config.ts` — Enable `cacheComponents: true` (currently bare config)
- `src/app/api/internal/sync-wise/route.ts` — Add `revalidateTag('snapshot')` after snapshot promotion

### Components to lazy-load
- `src/components/compare/week-overview.tsx` (~471 lines) — Heavy calendar grid
- `src/components/compare/calendar-grid.tsx` (~275 lines) — Day drill-down view
- `src/components/compare/discovery-panel.tsx` (~274 lines) — Tutor discovery modal

### Data sources to cache
- `src/app/api/filters/route.ts` — Subject/curriculum/level dropdown data
- `src/app/api/tutors/route.ts` — All tutor names/IDs for combobox

### Phase 1 outputs (already extracted)
- `src/components/search/search-form.tsx` — SearchForm component (receives filter data)
- `src/components/search/search-results.tsx` — SearchResults component
- `src/components/compare/compare-panel.tsx` — ComparePanel component (hosts lazy-loaded children)
- `src/components/search/search-workspace.tsx` — Top-level composition root
- `src/hooks/use-compare.ts` — useCompare hook (client-side state)

### Next.js 16 docs (MUST read for cache components)
- Next.js `'use cache'` directive docs — API may differ from training data
- Next.js `cacheTag` / `revalidateTag` API — verify exact import paths and signatures

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 1 extracted components (SearchForm, SearchResults, ComparePanel, SearchWorkspace) provide clean insertion points for streaming and lazy loading
- `useCompare` hook manages all compare state — lazy components receive data through this hook's return values
- shadcn/ui primitives for skeleton styling (can use Tailwind `animate-pulse` or create skeleton component)
- `tw-animate-css` package already installed — may provide shimmer utilities
- `globalThis`-anchored singletons (Phase 1) ensure stable server-side data access

### Established Patterns
- `"use client"` directive at top of interactive components
- Constants above component, helpers in same file
- `cn()` utility for conditional Tailwind classes
- No existing `loading.tsx` or Suspense patterns in the codebase
- No existing `'use cache'` or `next/dynamic` usage — this phase introduces both patterns

### Integration Points
- `loading.tsx` goes in `src/app/(app)/search/loading.tsx` (new file)
- Server data fetching moves from client `useEffect` + `fetch()` to server-side async functions
- `revalidateTag` call integrates into existing sync orchestrator success path
- Lazy loading wraps existing component imports in SearchWorkspace or ComparePanel

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches within the decisions above.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 02-streaming-lazy-loading*
*Context gathered: 2026-04-10*
