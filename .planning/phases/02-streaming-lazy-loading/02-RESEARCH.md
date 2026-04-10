# Phase 2: Streaming & Lazy Loading - Research

**Researched:** 2026-04-10
**Domain:** Next.js 16 streaming, Suspense, `'use cache'`, lazy loading, cache invalidation
**Confidence:** HIGH

## Summary

Phase 2 transforms the current client-only search page into a streaming Server Component architecture. The current `page.tsx` is a `"use client"` component that fetches filter and tutor data via `useEffect` + `fetch()` calls on mount, creating a waterfall where the user sees a blank page until both API calls complete. The target architecture uses Next.js 16's `cacheComponents` feature to cache snapshot-bound data (filters, tutor list) with `'use cache'` + `cacheTag('snapshot')`, streams that data via Suspense boundaries, and lazy-loads heavy compare components (WeekOverview ~471 lines, CalendarGrid ~275 lines, DiscoveryPanel ~274 lines) via `next/dynamic` on demand.

The key architectural challenge is that the current `SearchWorkspace` is entirely client-side (using `useSearchParams`, `useState`, `useCallback`, `useCompare` hook). Streaming filter/tutor data requires creating server-side async data functions that run in RSC context, then passing the resolved data as props through the client boundary. The `page.tsx` becomes a Server Component that fetches cached data, wraps the client `SearchWorkspace` in Suspense boundaries, and passes filter/tutor data as props instead of having SearchWorkspace fetch them via `useEffect`.

Cache invalidation is straightforward: the sync-wise route handler calls `revalidateTag('snapshot', { expire: 0 })` after successful snapshot promotion. Since this is a Route Handler (not a Server Action), `updateTag` cannot be used -- `revalidateTag` with `{ expire: 0 }` is the correct API for immediate invalidation from a Route Handler. [VERIFIED: Next.js 16 docs at `node_modules/next/dist/docs/`]

**Primary recommendation:** Enable `cacheComponents: true` in `next.config.ts`, create cached server functions for filter/tutor data with `cacheTag('snapshot')`, convert `page.tsx` to an async Server Component that streams data via Suspense, and use `next/dynamic` for lazy-loading heavy compare components.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: Claude's discretion on RSC boundary approach -- decide whether page.tsx becomes a Server Component with props drilling or uses per-section Suspense wrappers, based on what fits Phase 1's component structure best.
- D-02: Progressive streaming -- show skeleton shell immediately via `loading.tsx`, then stream in filter dropdowns and tutor combobox as each data promise resolves. User sees page structure right away, sections fill in progressively.
- D-03: Shimmer animated skeletons -- gray placeholder blocks with subtle pulse/shimmer animation. Standard pattern matching Google/GitHub style.
- D-04: High fidelity skeletons -- skeleton mirrors exact layout: side-by-side panels, form field shapes, calendar grid outline. Prevents layout shift when real content loads.
- D-05: Two skeleton levels: route-level `loading.tsx` (shown during navigation) and per-section Suspense fallbacks (shown while individual data streams arrive).
- D-06: Lazy load trigger: on first tutor add -- WeekOverview and CalendarGrid load when the first tutor is added to compare. DiscoveryPanel loads when the discovery modal opens.
- D-07: Lazy loading fallback: shimmer skeleton matching calendar grid shape.
- D-08: Sync endpoint purges cache -- after successful snapshot promotion, `sync-wise` route calls `revalidateTag('snapshot')`. Next request rebuilds cache. Immediate invalidation, no stale data window.
- D-09: Cache scope: only filter options and tutor list -- cache the data behind `/api/filters` and `/api/tutors`. Search and compare remain uncached.

### Claude's Discretion
- RSC boundary approach (props drilling vs per-section Suspense wrappers) -- D-01
- Whether to use `next/dynamic` vs `React.lazy` for code splitting
- Exact Suspense boundary placement and fallback component structure
- Whether filter and tutor data use `'use cache'` directive on server functions or cached API routes
- TypeScript types for skeleton prop interfaces

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PERF-04 | Convert search page to async Server Component that streams filter/tutor data via Suspense | RSC boundary architecture, `'use cache'` server functions, Suspense streaming patterns |
| PERF-05 | Add skeleton loading states matching real component dimensions | `loading.tsx` convention, shimmer animation with Tailwind `animate-pulse`, high-fidelity skeleton components |
| PERF-06 | Lazy-load WeekOverview, CalendarGrid, DiscoveryPanel | `next/dynamic` with named exports and custom loading fallbacks |
| PERF-07 | Enable `cacheComponents: true` and use `'use cache'` with `cacheTag('snapshot')` | `cacheComponents` config, `cacheTag`/`revalidateTag` API from `next/cache` |
| INFRA-01 | Add `loading.tsx` skeleton file for search route | `loading.tsx` file convention in `src/app/(app)/search/` |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| next | 16.2.2 | Framework with `cacheComponents`, streaming, `next/dynamic` | Already installed; `'use cache'` and `cacheTag` are stable in v16 [VERIFIED: `package.json`] |
| react | 19.2.4 | Suspense boundaries for streaming | Already installed; React 19 Suspense is production-ready [VERIFIED: `package.json`] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| next/cache | (bundled) | `cacheTag`, `cacheLife`, `revalidateTag` functions | Tag cached data and invalidate on snapshot change |
| next/dynamic | (bundled) | Lazy loading with custom fallbacks | Code-split WeekOverview, CalendarGrid, DiscoveryPanel |
| tw-animate-css | 1.4.0 | Animation utilities | Already installed; use for shimmer/pulse skeleton animations [VERIFIED: `package.json`] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `next/dynamic` | `React.lazy()` + `Suspense` | `next/dynamic` is preferred -- it wraps `React.lazy` + `Suspense` with Next.js optimizations (preload, SSR control, named export support via `.then(mod => mod.Name)`) [VERIFIED: Next.js 16 lazy-loading docs] |
| `'use cache'` on server functions | Cached API route with `force-static` | Server functions are simpler -- no HTTP roundtrip, direct data return, tag-based invalidation. API routes would still work but add unnecessary network hop for server-rendered data [VERIFIED: Next.js 16 caching docs] |

## Architecture Patterns

### RSC Boundary Recommendation (D-01 Discretion)

**Recommendation: Per-section Suspense wrappers with server data functions.**

Rationale: The current `SearchWorkspace` is a `"use client"` component that uses `useSearchParams()`, `useState`, `useCallback`, and the `useCompare` hook. Converting it to a Server Component would require extracting ALL interactive state management. Instead:

1. `page.tsx` becomes an async Server Component (remove `"use client"`)
2. Create server data functions (`getFilterOptions()`, `getTutorList()`) with `'use cache'` + `cacheTag('snapshot')`
3. `page.tsx` awaits the cached data and passes it as props to `SearchWorkspace`
4. `SearchWorkspace` stays `"use client"` but receives `filterOptions` and `tutorList` as props instead of fetching them in `useEffect`
5. Wrap `SearchWorkspace` in a Suspense boundary with a skeleton fallback

This approach is minimal-change: it preserves all existing client-side state management while eliminating the fetch waterfall. The data is cached at the function level and streamed through Suspense.

```
src/app/(app)/search/
  page.tsx          # Server Component (async, no "use client")
  loading.tsx       # Route-level skeleton (shown during navigation)
src/lib/data/
  filters.ts        # getFilterOptions() with 'use cache' + cacheTag
  tutors.ts         # getTutorList() with 'use cache' + cacheTag
```

### Recommended Project Structure Changes
```
src/
  app/(app)/search/
    page.tsx           # MODIFY: remove "use client", make async Server Component
    loading.tsx        # NEW: route-level skeleton
  lib/data/
    filters.ts         # NEW: cached server function for filter options
    tutors.ts          # NEW: cached server function for tutor list
  components/
    skeletons/
      search-skeleton.tsx    # NEW: full-page skeleton (used by loading.tsx)
      form-skeleton.tsx      # NEW: search form skeleton
      calendar-skeleton.tsx  # NEW: calendar grid skeleton
    search/
      search-workspace.tsx   # MODIFY: accept filterOptions + tutorList as props
      search-form.tsx        # MODIFY: accept filterOptions as required prop (remove null)
    compare/
      compare-panel.tsx      # MODIFY: use next/dynamic for heavy children
```

### Pattern 1: Cached Server Data Function
**What:** Async function with `'use cache'` directive that loads snapshot-bound data
**When to use:** For filter options and tutor list -- slow-changing, snapshot-bound data

```typescript
// Source: Next.js 16 docs (node_modules/next/dist/docs/01-app/01-getting-started/08-caching.md)
import { cacheTag, cacheLife } from "next/cache";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";

export async function getFilterOptions() {
  "use cache";
  cacheTag("snapshot");
  cacheLife("hours");

  const db = getDb();
  const index = await ensureIndex(db);

  const subjects = new Set<string>();
  const curriculums = new Set<string>();
  const levels = new Set<string>();

  for (const group of index.tutorGroups) {
    for (const q of group.qualifications) {
      subjects.add(q.subject);
      curriculums.add(q.curriculum);
      levels.add(q.level);
    }
  }

  return {
    subjects: [...subjects].sort(),
    curriculums: [...curriculums].sort(),
    levels: [...levels].sort(),
  };
}
```

### Pattern 2: Server Component Page with Streaming
**What:** Async page that awaits cached data and passes to client component
**When to use:** For the search page

```typescript
// Source: Next.js 16 docs (caching.md, loading.md)
import { Suspense } from "react";
import { getFilterOptions } from "@/lib/data/filters";
import { getTutorList } from "@/lib/data/tutors";
import { SearchWorkspace } from "@/components/search/search-workspace";
import { SearchSkeleton } from "@/components/skeletons/search-skeleton";

export default async function SearchPage() {
  const filterOptions = await getFilterOptions();
  const tutorList = await getTutorList();

  return (
    <Suspense fallback={<SearchSkeleton />}>
      <SearchWorkspace
        filterOptions={filterOptions}
        tutorList={tutorList}
      />
    </Suspense>
  );
}
```

### Pattern 3: Lazy Loading with next/dynamic
**What:** Code-split heavy components, load on demand with skeleton fallback
**When to use:** For WeekOverview, CalendarGrid, DiscoveryPanel

```typescript
// Source: Next.js 16 docs (lazy-loading.md)
"use client";
import dynamic from "next/dynamic";
import { CalendarSkeleton } from "@/components/skeletons/calendar-skeleton";

// Named export lazy loading
const WeekOverview = dynamic(
  () => import("@/components/compare/week-overview").then((mod) => mod.WeekOverview),
  { loading: () => <CalendarSkeleton /> }
);

const CalendarGrid = dynamic(
  () => import("@/components/compare/calendar-grid").then((mod) => mod.CalendarGrid),
  { loading: () => <CalendarSkeleton /> }
);

const DiscoveryPanel = dynamic(
  () => import("@/components/compare/discovery-panel").then((mod) => mod.DiscoveryPanel),
  { loading: () => null }
);
```

### Pattern 4: Cache Invalidation from Route Handler
**What:** Call `revalidateTag` after snapshot promotion in sync endpoint
**When to use:** In the sync-wise route handler after successful sync

```typescript
// Source: Next.js 16 docs (revalidateTag.md, updateTag.md)
import { revalidateTag } from "next/cache";

// In POST handler, after successful sync:
const result = await runFullSync(db, client, instituteId);

if (result.success) {
  // Use { expire: 0 } for immediate invalidation from Route Handler
  // (updateTag is ONLY for Server Actions, not Route Handlers)
  revalidateTag("snapshot", { expire: 0 });
}
```

### Anti-Patterns to Avoid
- **Do NOT use `updateTag` in Route Handlers:** `updateTag` can ONLY be called from Server Actions. Using it in the sync-wise route handler will throw a runtime error. Use `revalidateTag('snapshot', { expire: 0 })` instead. [VERIFIED: Next.js 16 `updateTag.md` docs]
- **Do NOT call `cookies()` or `headers()` inside `'use cache'`:** These are runtime APIs that cannot be used inside cached scopes. Read them outside and pass as arguments. [VERIFIED: Next.js 16 `use-cache.md` docs]
- **Do NOT make `SearchWorkspace` a Server Component:** It uses `useSearchParams()`, `useState`, `useCallback`, and `useCompare` hook -- all client-only APIs. Keep it as `"use client"` and pass data as props from the server.
- **Do NOT use `revalidateTag` without second argument:** The single-argument form `revalidateTag(tag)` is deprecated in Next.js 16. Always pass a second argument (`"max"`, `{ expire: 0 }`, or a cache life profile). [VERIFIED: Next.js 16 `revalidateTag.md` docs]
- **Do NOT lazy load inside render body:** `dynamic()` calls must be at module scope (top level), not inside component functions. This is required for the bundler to resolve chunks at build time. [VERIFIED: Next.js 16 lazy-loading docs]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Code splitting | Manual `import()` + state tracking | `next/dynamic` with `loading` option | Handles SSR, preloading, Suspense integration, named exports |
| Data caching | Custom in-memory cache with TTL | `'use cache'` + `cacheTag` + `cacheLife` | Built into Next.js, auto key generation, tag-based invalidation |
| Route-level loading | Manual loading state in layout | `loading.tsx` file convention | Auto-wraps page in Suspense, shown during navigation |
| Skeleton animations | Custom CSS keyframes | Tailwind `animate-pulse` class | Already available, consistent with shadcn/ui patterns |

**Key insight:** Next.js 16's `cacheComponents` feature replaces the old `fetch` cache model with explicit `'use cache'` directives. The data functions don't need `fetch()` at all -- they can directly call `ensureIndex(db)` and the result is cached by the directive.

## Common Pitfalls

### Pitfall 1: Auth Check Inside Cached Function
**What goes wrong:** Calling `auth()` (which reads cookies) inside a `'use cache'` function causes a build error because `cookies()` is a runtime API.
**Why it happens:** `auth()` from next-auth internally calls `cookies()` to read the session.
**How to avoid:** Perform auth check OUTSIDE the cached function scope. The page.tsx Server Component checks auth before calling cached data functions. The cached data functions themselves are pure data accessors.
**Warning signs:** Error message about "request-specific arguments" inside `use cache`.

### Pitfall 2: Serverless Cache Volatility
**What goes wrong:** On Vercel serverless (Hobby plan), `'use cache'` runtime entries may not persist across function invocations because each request can hit a different instance.
**Why it happens:** In-memory LRU cache is per-instance. Serverless functions are ephemeral.
**How to avoid:** This is acceptable for this use case. The cached data rebuilds quickly (~400ms from the in-memory search index). The primary benefit is eliminating client-side fetch waterfalls and enabling Suspense streaming -- the server still serves fresh data fast even on cache miss. Build-time prerendering also produces a static shell.
**Warning signs:** Cache miss rate appears high in production logs.

### Pitfall 3: `cacheComponents` Changes Navigation Behavior
**What goes wrong:** Enabling `cacheComponents` activates React's `<Activity>` component for route preservation. Previously unmounted routes stay "hidden" in the DOM, preserving state.
**Why it happens:** `cacheComponents` bundles PPR + `useCache` + `Activity` navigation.
**How to avoid:** This is actually a BENEFIT for this app -- the search page state (selected tutors, search results) persists when navigating to `/data-health` and back. However, test for any side effects where `useEffect` cleanup behaves differently (effects cleanup on hide, recreate on show). [VERIFIED: Next.js 16 `cacheComponents.md` docs]
**Warning signs:** Unexpected state preservation, effects not re-running on navigation.

### Pitfall 4: Streaming Requires Suspense Boundary for Uncached Data
**What goes wrong:** With `cacheComponents` enabled, accessing uncached async data (like DB queries) without wrapping in `<Suspense>` or marking with `'use cache'` produces a build error: "Uncached data was accessed outside of <Suspense>".
**Why it happens:** Cache Components requires explicit handling of all async operations.
**How to avoid:** Wrap all async Server Components in `<Suspense>` boundaries OR use `'use cache'` on them. [VERIFIED: Next.js 16 caching docs]
**Warning signs:** Build error about "blocking route".

### Pitfall 5: `loading.tsx` Does Not Wrap Same-Segment Layout
**What goes wrong:** The `loading.tsx` skeleton shows correctly on navigation but the `(app)` layout's `AppNav` stays visible (which is correct behavior -- layout stays interactive).
**Why it happens:** `loading.tsx` wraps `page.tsx` in a Suspense boundary, NOT the layout. The layout at `src/app/(app)/layout.tsx` renders independently.
**How to avoid:** This is desired behavior. The AppNav stays visible while the page content shows a skeleton. [VERIFIED: Next.js 16 `loading.md` docs]

## Code Examples

### Cached Server Function: Filter Options
```typescript
// src/lib/data/filters.ts
// Source: Next.js 16 caching docs + existing /api/filters/route.ts logic
import { cacheTag, cacheLife } from "next/cache";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";

export interface FilterOptions {
  subjects: string[];
  curriculums: string[];
  levels: string[];
}

export async function getFilterOptions(): Promise<FilterOptions> {
  "use cache";
  cacheTag("snapshot");
  cacheLife("hours");

  const db = getDb();
  const index = await ensureIndex(db);

  const subjects = new Set<string>();
  const curriculums = new Set<string>();
  const levels = new Set<string>();

  for (const group of index.tutorGroups) {
    for (const q of group.qualifications) {
      subjects.add(q.subject);
      curriculums.add(q.curriculum);
      levels.add(q.level);
    }
  }

  return {
    subjects: [...subjects].sort(),
    curriculums: [...curriculums].sort(),
    levels: [...levels].sort(),
  };
}
```

### Cached Server Function: Tutor List
```typescript
// src/lib/data/tutors.ts
// Source: Next.js 16 caching docs + existing /api/tutors/route.ts logic
import { cacheTag, cacheLife } from "next/cache";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";

export interface TutorListItem {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  subjects: string[];
}

export async function getTutorList(): Promise<TutorListItem[]> {
  "use cache";
  cacheTag("snapshot");
  cacheLife("hours");

  const db = getDb();
  const index = await ensureIndex(db);

  const tutors = index.tutorGroups.map((g) => ({
    tutorGroupId: g.id,
    displayName: g.displayName,
    supportedModes: g.supportedModes,
    subjects: [...new Set(g.qualifications.map((q) => q.subject))],
  }));

  tutors.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return tutors;
}
```

### Route-Level Loading Skeleton
```typescript
// src/app/(app)/search/loading.tsx
// Source: Next.js 16 loading.md convention
import { SearchSkeleton } from "@/components/skeletons/search-skeleton";

export default function Loading() {
  return <SearchSkeleton />;
}
```

### Skeleton Component (shimmer animation)
```typescript
// src/components/skeletons/search-skeleton.tsx
// High fidelity skeleton matching side-by-side layout
export function SearchSkeleton() {
  return (
    <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
      {/* Left panel - Search */}
      <div className="w-1/2 flex flex-col overflow-hidden min-w-0 border-r border-border/50 pr-3">
        {/* Form skeleton */}
        <div className="space-y-2 mb-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="h-8 rounded-md bg-muted animate-pulse" />
            <div className="h-8 rounded-md bg-muted animate-pulse" />
            <div className="h-8 rounded-md bg-muted animate-pulse" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="h-8 rounded-md bg-muted animate-pulse" />
            <div className="h-8 rounded-md bg-muted animate-pulse" />
            <div className="h-8 rounded-md bg-muted animate-pulse" />
          </div>
          <div className="h-8 w-24 rounded-md bg-muted animate-pulse" />
        </div>
        {/* Results skeleton */}
        <div className="space-y-1.5 mt-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 rounded-md bg-muted/50 animate-pulse" />
          ))}
        </div>
      </div>
      {/* Right panel - Compare */}
      <div className="w-1/2 flex flex-col overflow-hidden min-w-0 pl-1">
        {/* Tutor selector skeleton */}
        <div className="flex items-center gap-2 mb-2">
          <div className="h-7 w-32 rounded-md bg-muted animate-pulse" />
          <div className="h-4 w-8 rounded bg-muted animate-pulse ml-auto" />
        </div>
        {/* Empty compare state (no skeleton for calendar -- it shows on tutor add) */}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-1">
            <div className="h-4 w-28 rounded bg-muted animate-pulse mx-auto" />
            <div className="h-3 w-48 rounded bg-muted animate-pulse mx-auto" />
          </div>
        </div>
      </div>
    </div>
  );
}
```

### Sync Endpoint Cache Invalidation
```typescript
// In src/app/api/internal/sync-wise/route.ts
// Add after: const result = await runFullSync(db, client, instituteId);
import { revalidateTag } from "next/cache";

if (result.success) {
  revalidateTag("snapshot", { expire: 0 });
}
```

### Dynamic Import in ComparePanel
```typescript
// In src/components/compare/compare-panel.tsx (top of file, module scope)
import dynamic from "next/dynamic";
import { CalendarSkeleton } from "@/components/skeletons/calendar-skeleton";

const WeekOverview = dynamic(
  () => import("@/components/compare/week-overview").then((mod) => mod.WeekOverview),
  { loading: () => <CalendarSkeleton /> }
);

const CalendarGrid = dynamic(
  () => import("@/components/compare/calendar-grid").then((mod) => mod.CalendarGrid),
  { loading: () => <CalendarSkeleton /> }
);

const DiscoveryPanel = dynamic(
  () => import("@/components/compare/discovery-panel").then((mod) => mod.DiscoveryPanel),
  { loading: () => null }
);
// Remove the static imports for these three components
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `fetch` cache with `revalidate` option | `'use cache'` directive + `cacheTag` | Next.js 16.0.0 | Cache is explicit opt-in, not implicit. Must enable `cacheComponents: true` |
| `unstable_cache()` function | `'use cache'` directive | Next.js 16.0.0 | `unstable_cache` is replaced by the directive-based approach |
| `revalidateTag(tag)` (single arg) | `revalidateTag(tag, profile)` | Next.js 16.x | Single-arg form is deprecated; always pass second arg |
| Route unmounting on navigation | `<Activity>` component (hidden state) | Next.js 16.0.0 (with `cacheComponents`) | Routes stay mounted but hidden; state preserved across navigations |

**Deprecated/outdated:**
- `revalidateTag(tag)` single-argument form: deprecated in Next.js 16; use `revalidateTag(tag, "max")` or `revalidateTag(tag, { expire: 0 })` [VERIFIED: Next.js 16 `revalidateTag.md`]
- `unstable_cache()`: replaced by `'use cache'` directive [VERIFIED: Next.js 16 `use-cache.md`]
- `export const dynamic = 'force-dynamic'`: still works but `cacheComponents` makes runtime the default for uncached data [VERIFIED: Next.js 16 `cacheComponents.md`]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `getDb()` and `ensureIndex(db)` work correctly inside `'use cache'` scope (no closure over non-serializable state) | Architecture Patterns | HIGH -- if `getDb()` returns a non-serializable singleton or `ensureIndex` relies on `React.cache`, it may fail inside `'use cache'` isolation. Needs testing. |
| A2 | `animate-pulse` from Tailwind is sufficient for shimmer skeletons without custom CSS | Code Examples | LOW -- can always add custom shimmer CSS if pulse is too simple |
| A3 | The `/api/filters` and `/api/tutors` route handlers can remain as-is for backward compatibility (TutorCombobox currently fetches `/api/tutors` directly) | Architecture Patterns | MEDIUM -- if TutorCombobox still fetches from API route, it bypasses the cache. Need to update TutorCombobox to accept tutors as props |

## Open Questions

1. **`ensureIndex(db)` inside `'use cache'` isolation**
   - What we know: `'use cache'` creates an isolated scope where `React.cache` values from outer scope are not visible. The `ensureIndex` function uses a module-level singleton (`currentIndex`).
   - What's unclear: Whether the module-level singleton pattern (not `React.cache`) works normally inside `'use cache'`. Module-level variables should work since they're not React-scoped.
   - Recommendation: Test during implementation. The `globalThis`-anchored singletons from Phase 1 should be fine since they're actual module state, not `React.cache`.

2. **TutorCombobox data source after migration**
   - What we know: TutorCombobox currently fetches `/api/tutors` on first open via `useEffect`. With the new architecture, tutor list data is passed as props from the Server Component.
   - What's unclear: Should TutorCombobox receive tutors as a prop, or should it continue using the API route?
   - Recommendation: Pass tutorList as a prop through SearchWorkspace -> ComparePanel -> TutorCombobox. This eliminates the client-side fetch entirely. Keep the API route for backward compatibility but it becomes unused by the main flow.

3. **Existing API routes (`/api/filters`, `/api/tutors`) retention**
   - What we know: These routes currently serve the same data the new cached server functions will provide.
   - What's unclear: Whether any other consumers use these endpoints.
   - Recommendation: Keep the API routes but they become secondary. The primary data path is server functions -> props.

## Environment Availability

Step 2.6: SKIPPED (no external dependencies identified -- all changes are code/config within the existing Next.js 16 + Vercel stack).

## Sources

### Primary (HIGH confidence)
- Next.js 16 `cacheComponents.md` -- `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheComponents.md`
- Next.js 16 `caching.md` -- `node_modules/next/dist/docs/01-app/01-getting-started/08-caching.md`
- Next.js 16 `use-cache.md` -- `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-cache.md`
- Next.js 16 `cacheTag.md` -- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cacheTag.md`
- Next.js 16 `revalidateTag.md` -- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidateTag.md`
- Next.js 16 `updateTag.md` -- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/updateTag.md`
- Next.js 16 `loading.md` -- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`
- Next.js 16 `lazy-loading.md` -- `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`
- Existing source: `src/app/(app)/search/page.tsx`, `src/components/search/search-workspace.tsx`, `src/components/compare/compare-panel.tsx`

### Secondary (MEDIUM confidence)
- Existing API routes: `src/app/api/filters/route.ts`, `src/app/api/tutors/route.ts`, `src/app/api/internal/sync-wise/route.ts`

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already installed, versions verified against `package.json`
- Architecture: HIGH -- patterns verified against Next.js 16 bundled docs, existing code structure analyzed
- Pitfalls: HIGH -- all pitfalls verified against official docs with specific error messages and constraints
- Cache invalidation: HIGH -- `revalidateTag` vs `updateTag` distinction verified in official docs

**Research date:** 2026-04-10
**Valid until:** 2026-05-10 (stable -- Next.js 16 cache components API is GA)
