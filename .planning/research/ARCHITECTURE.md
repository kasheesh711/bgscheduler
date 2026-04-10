# Architecture Patterns

**Domain:** Performance optimization of a Next.js 16 internal admin tool with server-side in-memory data
**Researched:** 2026-04-10

## Current Architecture (As-Is)

```
Browser                          Vercel Edge/Node
  |                                |
  |-- GET /search (HTML) --------->|-- RSC renders layout only
  |<-- Full "use client" page -----|   (878-line SearchPageInner is 100% client)
  |                                |
  |-- GET /api/filters ----------->|-- ensureIndex(db) --> in-memory singleton
  |<-- JSON (subjects/levels) -----|
  |                                |
  |-- POST /api/search/range ----->|-- ensureIndex(db) --> executeSearch()
  |<-- JSON (availability grid) ---|
  |                                |
  |-- POST /api/compare ---------->|-- ensureIndex(db) --> buildCompareTutor()
  |<-- JSON (schedules/conflicts) -|
  |                                |
  |-- GET /api/tutors ------------>|-- ensureIndex(db) --> tutor list
  |<-- JSON (all tutor names) -----|
```

### Problems

1. **Monolithic client component**: `search/page.tsx` is 878 lines with `"use client"` at the top. The entire page is a client component -- zero server rendering of data. The browser downloads the full JS bundle, then makes 2+ fetch calls (`/api/filters`, `/api/tutors`) before anything useful appears.

2. **Waterfall data loading**: Page renders empty shell -> fetches filters -> fetches tutors -> user can interact. Each is a sequential network round-trip to API routes that read from the same in-memory index.

3. **Redundant serialization**: The in-memory `SearchIndex` singleton lives on the same server process that renders RSC. API routes serialize it to JSON, send it over HTTP, and the client deserializes it. This is unnecessary overhead for initial data.

4. **No streaming**: The page is either fully loaded or showing "Loading..." -- no progressive rendering of the static shell (search form, compare panel chrome) while data streams in.

5. **No code splitting**: `WeekOverview` (471 lines), `CalendarGrid` (275 lines), `DiscoveryPanel` (274 lines) are all eagerly loaded even though only one is visible at a time.

## Recommended Architecture (To-Be)

### Core Principle

The in-memory `SearchIndex` singleton is the key asset. It lives on the server. RSC can read it directly without HTTP round-trips. Push data through RSC props, not client-side fetches.

```
Browser                              Vercel Node
  |                                    |
  |-- GET /search ------------------>  |
  |                                    |-- auth() check
  |                                    |-- ensureIndex(db)
  |<-- Streamed HTML:                  |
  |    [1] Static shell (instant)      |-- RSC renders search form + compare chrome
  |    [2] FilterData (streamed)       |-- <Suspense> async FilterProvider
  |    [3] TutorList (streamed)        |-- <Suspense> async TutorListProvider
  |                                    |
  |-- POST /api/search/range ------->  |-- executeSearch() (user-initiated, stays as API)
  |<-- JSON -------------------------|
  |                                    |
  |-- POST /api/compare ------------>  |-- buildCompareTutor() (user-initiated, stays as API)
  |<-- JSON -------------------------|
```

### Component Boundaries

| Component | RSC / Client | Responsibility | Communicates With |
|-----------|-------------|----------------|-------------------|
| `search/page.tsx` | **Server** (async) | Orchestrate layout, fetch initial data from index, stream to client | `SearchPanel`, `ComparePanel`, `ensureIndex` |
| `search/loading.tsx` | **Server** | Skeleton for full-page streaming on navigation | None |
| `SearchForm` | **Client** | Form inputs, mode toggle, search button, state management | `/api/search/range` via fetch |
| `SearchResults` | **Client** | Availability grid, row selection, copy button | `SearchForm` (receives results via prop/context) |
| `ComparePanel` | **Client** | Tutor chips, week picker, day tabs, cache management | `/api/compare` via fetch |
| `WeekOverview` | **Client** (lazy) | GCal-style 7-day grid with session cards | `ComparePanel` (props) |
| `CalendarGrid` | **Client** (lazy) | Single-day drill-down view | `ComparePanel` (props) |
| `DiscoveryPanel` | **Client** (lazy) | Modal for finding candidate tutors | `/api/compare/discover` via fetch |
| `FilterProvider` | **Server** (async) | Reads filter options from SearchIndex, passes as props | `ensureIndex`, `SearchForm` |
| `TutorListProvider` | **Server** (async) | Reads tutor list from SearchIndex, passes as props | `ensureIndex`, `ComparePanel` |

### Data Flow

```
                    SERVER (RSC)                              CLIENT
                    ============                              ======

ensureIndex(db) --> SearchIndex singleton
                         |
                    +----+----+
                    |         |
              FilterProvider  TutorListProvider
              (async RSC)     (async RSC)
                    |              |
                    v              v
              filterOptions   tutorList
              (serialized     (serialized
               as props)       as props)
                    |              |
                    +------+-------+
                           |
                    <Suspense fallback={skeleton}>
                           |
                    ========|========== serialization boundary ===========
                           |
                     SearchWorkspace (client)
                      /          \
               SearchForm      ComparePanel
               (has filters     (has tutor list
                from props)      from props)
                    |                |
               user searches    user selects tutors
                    |                |
               POST /api/       POST /api/
               search/range     compare
                    |                |
               SearchResults    WeekOverview (lazy)
                                CalendarGrid (lazy)
                                DiscoveryPanel (lazy)
```

**Key insight**: Initial data (filters, tutor list) flows through RSC props. User-initiated queries (search, compare) stay as API route POSTs because they depend on user input and need client-side state management (caching, abort controllers, loading states).

## Patterns to Follow

### Pattern 1: RSC Data Preloading with Suspense Streaming

**What:** Fetch read-only data in async Server Components, stream it to client components via props.

**When:** Data that every page load needs and doesn't depend on user input (filter options, tutor list).

**Example:**

```typescript
// app/(app)/search/page.tsx -- SERVER COMPONENT (no "use client")
import { Suspense } from "react";
import { ensureIndex } from "@/lib/search/index";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { SearchWorkspace } from "@/components/search/search-workspace";

export default async function SearchPage() {
  // Auth check runs at RSC level -- no client round-trip
  const session = await auth();
  if (!session) redirect("/login");

  return (
    <Suspense fallback={<SearchSkeleton />}>
      <SearchDataLoader />
    </Suspense>
  );
}

async function SearchDataLoader() {
  const db = getDb();
  const index = await ensureIndex(db);

  // Extract only what the client needs -- minimal serialization
  const filterOptions = {
    subjects: [...new Set(index.tutorGroups.flatMap(g => g.qualifications.map(q => q.subject)))].sort(),
    curriculums: [...new Set(index.tutorGroups.flatMap(g => g.qualifications.map(q => q.curriculum)))].sort(),
    levels: [...new Set(index.tutorGroups.flatMap(g => g.qualifications.map(q => q.level)))].sort(),
  };

  const tutorList = index.tutorGroups
    .map(g => ({
      tutorGroupId: g.id,
      displayName: g.displayName,
      supportedModes: g.supportedModes,
      subjects: [...new Set(g.qualifications.map(q => q.subject))],
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Single serialization -- no HTTP round-trip
  return (
    <SearchWorkspace
      initialFilters={filterOptions}
      initialTutors={tutorList}
    />
  );
}
```

**Why this matters:** Eliminates 2 client-side fetch waterfalls (`/api/filters` + `/api/tutors`). The data is already in-memory on the same server process. RSC reads it directly and serializes once via the React component payload.

### Pattern 2: Client Component Splitting with Lazy Loading

**What:** Split the monolithic `SearchPageInner` into focused client components. Lazy-load heavy components that aren't visible on initial render.

**When:** Components that appear conditionally (calendar views, modals) or are below the fold.

**Example:**

```typescript
// components/search/search-workspace.tsx
"use client";

import { useState, lazy, Suspense } from "react";
import { SearchForm } from "./search-form";
import { SearchResults } from "./search-results";
import { ComparePanel } from "../compare/compare-panel";

// Lazy load heavy visualization components
const WeekOverview = lazy(() => import("../compare/week-overview"));
const CalendarGrid = lazy(() => import("../compare/calendar-grid"));
const DiscoveryPanel = lazy(() => import("../compare/discovery-panel"));

export function SearchWorkspace({ initialFilters, initialTutors }) {
  // Search state lives here
  // Compare state lives here
  // ...split into focused sub-components
}
```

**Estimated JS savings:**
- `WeekOverview`: ~471 lines deferred until user selects tutors
- `CalendarGrid`: ~275 lines deferred until user clicks a day tab
- `DiscoveryPanel`: ~274 lines deferred until user clicks "Advanced search"
- Total: ~1,020 lines of JS deferred from initial bundle

### Pattern 3: loading.tsx for Navigation Streaming

**What:** Add a `loading.tsx` file for the search route to show an instant skeleton during client-side navigation.

**When:** User navigates from `/login` or `/data-health` to `/search`.

**Example:**

```typescript
// app/(app)/search/loading.tsx
export default function SearchLoading() {
  return (
    <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
      {/* Left panel skeleton */}
      <div className="w-1/2 flex flex-col border-r border-border/50 pr-3">
        <div className="h-6 w-20 bg-muted rounded animate-pulse mb-2" />
        <div className="space-y-2">
          <div className="h-7 bg-muted rounded animate-pulse" />
          <div className="grid grid-cols-3 gap-2">
            {[1,2,3].map(i => (
              <div key={i} className="h-9 bg-muted rounded animate-pulse" />
            ))}
          </div>
        </div>
      </div>
      {/* Right panel skeleton */}
      <div className="w-1/2 flex flex-col pl-1">
        <div className="h-6 w-32 bg-muted rounded animate-pulse mb-2" />
        <div className="flex-1 flex items-center justify-center">
          <div className="h-4 w-48 bg-muted rounded animate-pulse" />
        </div>
      </div>
    </div>
  );
}
```

### Pattern 4: Preserve Client-Side Cache Strategy

**What:** Keep the existing `Map<string, CompareTutor>` cache with incremental fetch, AbortController, and snapshot invalidation. This pattern is already well-implemented.

**When:** User interactions that fetch tutor schedules (add tutor, change week, remove tutor).

**Why keep it:** The current client cache is sophisticated and correct -- it handles incremental adds (`fetchOnly`), snapshot staleness detection, abort-on-unmount, and week-scoped keys. Do not replace with React Query or SWR. The overhead of adding a library is not justified for 3 fetch endpoints with already-working cache logic.

### Pattern 5: API Route Cache-Control Headers

**What:** Add `Cache-Control` headers to API routes that return snapshot-bound data.

**When:** Data that changes only when the active snapshot changes (filters, tutor list -- though these move to RSC, the API routes should still have headers for any remaining consumers).

**Example:**

```typescript
// For snapshot-bound data that rarely changes
return NextResponse.json(data, {
  headers: {
    "Cache-Control": "private, max-age=300, stale-while-revalidate=600",
  },
});
```

**Why:** The snapshot changes at most once per day (daily cron). Even a 5-minute cache dramatically reduces redundant requests if the API routes are still hit directly.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Over-Migrating to RSC

**What:** Trying to make search results or compare schedules render via RSC.

**Why bad:** Search and compare are user-initiated with complex client state (selected tutors, week navigation, cache management, abort controllers). Forcing these through RSC would require Server Actions for every interaction, losing the snappy client-side cache.

**Instead:** Keep user-initiated queries as POST API routes. Only move *initial/static data* (filters, tutor list) to RSC.

### Anti-Pattern 2: Adding React Query or SWR

**What:** Introducing a client-side data fetching library.

**Why bad:** The app has exactly 3 fetch patterns (search, compare, discover), each already has correct caching, abort handling, and error states. Adding React Query would mean rewriting working code, adding bundle size (~13KB gzipped for React Query), and learning a new abstraction for 8 admin users.

**Instead:** Keep the existing fetch + useState + useRef pattern. It is simple, working, and tested.

### Anti-Pattern 3: Granular Suspense Boundaries in Client Components

**What:** Wrapping individual client sub-components in `<Suspense>` for streaming.

**Why bad:** Client components do not benefit from RSC streaming. `<Suspense>` in client components only works with `React.lazy()` for code splitting, not for data fetching. Data fetching in client components still needs `useEffect` or event handlers.

**Instead:** Use `<Suspense>` at the RSC level for server data. Use `React.lazy()` in client components only for code-splitting heavy visualization components.

### Anti-Pattern 4: Server Actions for Read Operations

**What:** Using `"use server"` functions for search queries instead of API routes.

**Why bad:** Server Actions are designed for mutations. Using them for reads loses HTTP caching, makes it harder to add AbortController support, and conflates the mental model. The current POST API routes work correctly with the client cache.

**Instead:** Keep API routes for reads. Server Actions are only appropriate if you add write operations (e.g., saving tutor preferences).

## Scalability Considerations

| Concern | At 8 users (current) | At 50 users | At 200 users |
|---------|----------------------|-------------|--------------|
| In-memory index | ~5MB, trivial | Same -- shared singleton | May need index sharding or edge caching |
| Concurrent searches | Sequential on shared index | Fine -- search is CPU-bound <10ms | Add worker threads if latency spikes |
| Client bundle | ~200KB, acceptable | Same | Same -- admin tool, not public-facing |
| API response size | <50KB per search | Same | Same -- dataset is ~130 tutors |
| Vercel function cold start | ~2s with DB + index build | Same -- singleton persists across requests | Consider `cacheComponents: true` for static shell |

**This is an internal admin tool for 8 users.** Scalability beyond 50 concurrent users is not a realistic concern. Optimize for perceived speed (streaming, code splitting, eliminating waterfalls), not throughput.

## Suggested Refactoring Order

The dependencies between changes dictate this order:

### Phase 1: Component Splitting (no behavior change)

Extract the 878-line `SearchPageInner` into focused client components:
- `SearchForm` (form inputs + handlers, ~200 lines)
- `SearchResults` (grid + selection, ~100 lines)
- `ComparePanel` (tutor chips + week picker + calendar routing, ~200 lines)
- `SearchWorkspace` (orchestrator holding shared state, ~150 lines)

**Why first:** This is a prerequisite for RSC conversion and lazy loading. Cannot convert `page.tsx` to RSC while it has `"use client"`.

**Risk:** LOW -- pure refactor, no behavior change. Existing tests validate search/compare logic.

### Phase 2: RSC Conversion + Streaming

Convert `search/page.tsx` to an async Server Component:
- Move `ensureIndex()` calls for filters/tutors into RSC
- Pass initial data as props to `SearchWorkspace`
- Add `loading.tsx` skeleton
- Add `<Suspense>` boundary around the async data loader
- Delete `/api/filters` route (no longer needed)
- Keep `/api/tutors` route as fallback for the combobox (it fetches on-demand)

**Why second:** Depends on Phase 1 (page must not be `"use client"`).

**Risk:** MEDIUM -- changes the data flow for initial load. Must verify auth still works at RSC level.

### Phase 3: Lazy Loading + Code Splitting

Add `React.lazy()` for conditional components:
- `WeekOverview` -- loaded when compare has tutors
- `CalendarGrid` -- loaded when user clicks a day tab
- `DiscoveryPanel` -- loaded when user clicks "Advanced search"

**Why third:** Depends on Phase 1 (components must be extracted to separate files, which they already are). Can technically run in parallel with Phase 2.

**Risk:** LOW -- `React.lazy()` + `Suspense` fallback is straightforward for already-extracted components.

### Phase 4: Polish

- Add `Cache-Control` headers to remaining API routes
- Consider `cacheComponents: true` in next.config.ts for static shell optimization
- Profile with React DevTools and Next.js bundle analyzer
- Add `loading.tsx` to `/data-health` route as well

**Why last:** Incremental improvements on top of the structural changes.

## Sources

- Next.js 16.2 official docs: `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` (HIGH confidence -- read directly from installed package)
- Next.js 16.2 official docs: `node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md` (HIGH confidence)
- Next.js 16.2 official docs: `node_modules/next/dist/docs/01-app/01-getting-started/08-caching.md` (HIGH confidence)
- Next.js 16.2 official docs: `node_modules/next/dist/docs/01-app/02-guides/streaming.md` (HIGH confidence)
- Next.js 16.2 official docs: `node_modules/next/dist/docs/01-app/02-guides/instant-navigation.md` (HIGH confidence)
- Next.js 16.2 official docs: `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md` (HIGH confidence)
- Next.js 16.2 official docs: `node_modules/next/dist/docs/01-app/02-guides/prefetching.md` (HIGH confidence)
- Codebase analysis: direct reading of `src/app/(app)/search/page.tsx`, `src/lib/search/index.ts`, all API routes, all component files (HIGH confidence)
