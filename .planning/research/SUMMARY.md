# Project Research Summary

**Project:** BGScheduler — Performance & UX Improvement
**Domain:** Next.js scheduling tool optimization (brownfield)
**Researched:** 2026-04-10
**Confidence:** HIGH

## Executive Summary

The root cause of all perceived sluggishness is a single 878-line `"use client"` monolith (`search/page.tsx`) that forces 2-4 sequential client-side fetch waterfalls before the user can interact. The server has the data in-memory (SearchIndex singleton), but the client fetches it via API routes over HTTP, serializing and deserializing unnecessarily. The fix is well-understood: split the component, convert the page to a Server Component that streams pre-fetched data via Suspense boundaries, and lazy-load heavy calendar views.

The primary UX complaint — tutor lanes blurring together in multi-tutor views — is solved by alternating tinted lane backgrounds (3-5% opacity of each tutor's assigned color), a pattern used by every major calendar tool (Google Calendar, FullCalendar, Outlook). Additional table-stakes improvements include lane header labels, skeleton loading states, hover tooltips, and a click-to-compare shortcut from search results.

The biggest risk is regression during the monolith split. The search and compare panels share state in non-obvious ways (tutor cache refs, abort controllers, snapshot IDs). A `useCompare` custom hook must be extracted before any UI splitting. The `globalThis` singleton fix for the search index is also a prerequisite for reliable server-component data fetching.

## Key Findings

### Recommended Stack

The existing stack is locked. The key change is enabling Next.js 16 features already available but not configured.

**Core changes:**
- `cacheComponents: true` in next.config.ts — enables PPR, `'use cache'` directive, React `<Activity>` state preservation. Single highest-impact config change.
- `'use cache'` + `cacheLife('hours')` + `cacheTag('snapshot')` — cache filter options and tutor list data that only change on daily sync.
- `<Suspense>` boundaries with skeleton fallbacks — stream data progressively, show instant shell.
- `React.lazy()` for WeekOverview (471 lines), CalendarGrid (275 lines), DiscoveryPanel (274 lines) — defer ~1,020 lines of JS.
- No new npm dependencies needed — all improvements use existing Tailwind, shadcn/ui, and React APIs.

### Expected Features

**Must have (table stakes):**
- Alternating lane backgrounds per tutor (5% opacity tint) — #1 fix for lane readability
- Lane header labels on the week grid — tutor name + color dot at top of each lane
- Skeleton loading states — replace "Loading..." with skeleton grid matching real layout
- Hover tooltips on session blocks — show student/subject/time on hover, keep popover on click
- Today indicator line — red/blue horizontal line on current time
- Click-to-compare from search results — "+" button on each row, reduces 3 clicks to 1
- Conflict count badge — numbered badge instead of generic "!" icon

**Should have (differentiators):**
- URL-shareable week state (`&week=2026-04-06`) — let admin staff share compare views
- Keyboard navigation for week picker — arrow keys for repetitive comparisons
- Sticky tutor legend on scroll — maintain context during vertical scrolling
- Inline free-slot actions — click free gap to copy time details

**Defer:**
- Drag-to-select time range — high complexity, not essential
- Conflict resolution suggestions — requires search engine queries per conflict
- Animated transitions — polish item, do after core fixes
- Mini-map density overview — medium complexity, not urgent

### Architecture Approach

Convert the search page from a monolithic client component to a Server Component orchestrator that streams pre-fetched data (filters, tutor list) via Suspense, while keeping user-initiated queries (search, compare) as client-side API calls with the existing cache. The in-memory SearchIndex singleton is read directly by RSC — no HTTP round-trip.

**Refactoring sequence:**
1. `useCompare` hook extraction — owns all compare state, cache, abort controller
2. Component split — SearchForm, SearchResults, ComparePanel, SearchWorkspace
3. RSC conversion — page.tsx becomes async server component, streams data as props
4. Lazy loading — WeekOverview, CalendarGrid, DiscoveryPanel via React.lazy()

### Critical Pitfalls

1. **State coordination breaks during split** — Extract `useCompare` hook first (owns `compareTutors`, `tutorCache`, `abortRef`, `lastSnapshotId`). Do NOT use React Context. Split incrementally with tests passing at each step.
2. **Module-level singleton lost between runtimes** — Move `currentIndex` and `_db` to `globalThis`. Next.js webpack + Node maintain separate module registries. Without this fix, RSC may see an empty index.
3. **Server-side waterfalls** — Use `Promise.all()` or separate Suspense boundaries for independent data fetches. Never `await` sequential server calls for data that can load in parallel.
4. **useSearchParams CSR bailout** — Keep `useSearchParams()` in the smallest client component wrapped in Suspense. Consider using page-level `searchParams` prop instead.
5. **Fail-closed safety contract** — Write E2E test for "Needs Review" rendering before touching any calendar components. Backend tests exist but frontend has no coverage.

## Implications for Roadmap

### Phase 1: Foundation (Component Splitting + Singleton Fix)
**Rationale:** All other work depends on clean component boundaries. Cannot convert to RSC while page is `"use client"`. Singleton fix is prerequisite for reliable server-side data access.
**Delivers:** `useCompare` hook, split client components (SearchForm, SearchResults, ComparePanel, SearchWorkspace), `globalThis` singleton, loading.tsx skeleton.
**Avoids:** Pitfall #1 (state coordination), Pitfall #2 (singleton loss).

### Phase 2: Performance (RSC + Streaming + Lazy Loading)
**Rationale:** Depends on Phase 1 component boundaries. This is where the "near-instant" feel comes from.
**Delivers:** Server Component page with streamed filter/tutor data, Suspense boundaries with skeletons, React.lazy() for heavy views, `cacheComponents: true`, `'use cache'` for stable data.
**Avoids:** Pitfall #3 (waterfalls), Pitfall #4 (CSR bailout), Pitfall #5 (popcorn effect).

### Phase 3: Calendar Readability + Workflow Polish
**Rationale:** Independent of performance track. Directly addresses user complaints. Can include workflow improvements (click-to-compare, tooltips, URL week state).
**Delivers:** Alternating lane backgrounds, lane headers, today indicator, conflict badges, hover tooltips, click-to-compare shortcut, URL-shareable week state.
**Avoids:** Pitfall #7 (safety contract — write E2E test first).

### Phase Ordering Rationale

- Phase 1 before Phase 2: Cannot convert to RSC without splitting the monolith. The `useCompare` hook defines the state boundary between search and compare.
- Phase 2 before Phase 3: Performance improvements change the component structure that Phase 3 modifies visually. Better to establish final component boundaries first.
- Phase 3 is independently valuable: If Phase 2 proves complex, Phase 3's visual fixes can ship separately with immediate user impact.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** State dependency mapping across search/compare panels is complex. Need to trace every cross-panel data flow before extracting the hook.
- **Phase 2:** `ensureIndex()` behavior inside `'use cache'` scopes needs verification. The DB staleness check must not be cached.

Phases with standard patterns (skip research-phase):
- **Phase 3:** Lane backgrounds, tooltips, badges are all CSS/JSX-only changes with well-documented patterns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All recommendations verified against Next.js 16 bundled docs in node_modules |
| Features | HIGH | Table stakes verified against FullCalendar, Google Calendar, Mobiscroll patterns |
| Architecture | HIGH | RSC + streaming is core Next.js App Router pattern, extensively documented |
| Pitfalls | HIGH | All pitfalls identified from direct codebase analysis + documented Next.js issues |

**Overall confidence:** HIGH

### Gaps to Address

- `ensureIndex()` inside `'use cache'` scopes — need to verify DB staleness check is not cached. May need to structure cache boundary so `ensureIndex()` runs outside cached scope.
- Auth.js async compatibility — verify `auth()` works correctly in async server components with Next.js 16's async cookies/headers API.
- `HOUR_HEIGHT` inconsistency — 48px in week-overview.tsx, 60px in calendar-grid.tsx. Must unify before skeleton components can match both views.
- Tooltip + Popover coexistence — can shadcn Tooltip (hover) and Popover (click) compose on the same trigger element? Needs prototype.

## Sources

### Primary (HIGH confidence)
- Next.js 16 bundled docs (`node_modules/next/dist/docs/`) — cacheComponents, use cache, streaming, instant navigation, lazy loading
- Direct codebase analysis — search/page.tsx, search/index.ts, all API routes, all components

### Secondary (MEDIUM confidence)
- FullCalendar resource view docs — lane coloring and resource header patterns
- Next.js issue #65350 — globalThis singleton problem documentation

---
*Research completed: 2026-04-10*
*Ready for roadmap: yes*
