# Technology Stack: Performance & UX Improvements

**Project:** BGScheduler Performance & UX Overhaul
**Researched:** 2026-04-10

## Recommended Stack

The existing stack is locked (Next.js 16, Tailwind, shadcn/ui, Drizzle, Neon Postgres). This document focuses on **which features within that stack to adopt** for near-instant performance.

### Core Performance Features to Enable

| Feature | Config/Version | Purpose | Why |
|---------|---------------|---------|-----|
| `cacheComponents: true` | next.config.ts | Enables PPR + `use cache` + `<Activity>` state preservation | Single flag that unlocks the entire Next.js 16 caching/streaming model. Without it, every request is fully dynamic with no prerendering. This is the highest-impact single change. |
| `<Suspense>` boundaries | React 19.2 (built-in) | Granular streaming of dynamic content | Lets the static shell (nav, layout, form skeleton) paint instantly while data-dependent sections stream in independently. The search page currently blocks on filter data before rendering anything. |
| `loading.tsx` files | Next.js file convention | Page-level skeleton fallback | Automatic Suspense wrapping at the route level. The simplest way to show instant feedback on navigation. |
| `unstable_instant` export | Next.js 16 route config | Validates instant navigation structure | Dev-time and build-time validation that Suspense boundaries are correctly placed for client-side navigations. Catches regressions before production. |
| React `<Activity>` | React 19.2 via `cacheComponents` | Preserves component state during navigation | When navigating away and back, form inputs, scroll position, and selected state are preserved automatically. Critical for the search+compare workflow where users switch between pages. |
| Turbopack FS cache | `experimental.turbopackFileSystemCacheForDev` | Faster dev rebuilds | Already the default bundler in Next.js 16. FS caching speeds up restarts for iterative development. |

### Caching Strategy

| Technology | Scope | Purpose | Why |
|------------|-------|---------|-----|
| `'use cache'` directive | Server Components, functions | Cache stable data (filters, tutor list, snapshot metadata) | Filters and tutor lists change only when a new snapshot is promoted (daily). Caching these at the component/function level eliminates redundant DB queries and makes the static shell instant. |
| `cacheTag()` | Inside `'use cache'` scopes | Tag cached entries for targeted invalidation | Tag all snapshot-derived caches with `'snapshot'`. When a new sync runs, invalidate all stale data with a single call. |
| `cacheLife()` | Inside `'use cache'` scopes | Set TTL profiles | Use `'hours'` for filter/tutor list data (changes daily), `'max'` for layout/navigation shells. |
| Client-side `Map` cache | React `useRef` | Avoid refetching tutor schedules already loaded | Already implemented. Keep as-is -- incremental fetch with `fetchOnly` is already well-designed. |
| `revalidateTag(tag, 'max')` | Sync endpoint | Invalidate snapshot-derived caches after sync | SWR behavior: serve stale immediately, revalidate in background. Users see cached data instantly while fresh data loads. |

### Streaming Architecture

| Pattern | Where | Purpose | Why |
|---------|-------|---------|-----|
| Server Component for filter data | `/search` page | Fetch filters on the server, no client `useEffect` | Eliminates the flash of empty dropdowns. Server fetches filters from the in-memory index, streams them as part of the initial HTML. No client-side `fetch('/api/filters')` waterfall. |
| Server Component for tutor list | Tutor combobox data | Fetch tutor names on the server | Same rationale: eliminates the client-side fetch that blocks the combobox from being usable on first load. |
| Client Component for search/compare interaction | Search form, compare panel | Handle user interactions, state, AbortController | Keep interactive elements as client components. The form, week picker, tutor selector, and calendar grid must remain `'use client'`. |
| Sibling `<Suspense>` boundaries | Search results, compare panel | Independent streaming | Search results and compare panel should be in separate Suspense boundaries so one doesn't block the other. |

### Supporting Libraries (already installed, no new deps needed)

| Library | Version | Purpose | Performance Role |
|---------|---------|---------|-----------------|
| shadcn/ui `Skeleton` | Built-in | Skeleton loading states | Use for search form, calendar grid, and filter dropdown placeholders |
| shadcn/ui `Tooltip` | Built-in | Session hover info | Already available |
| `date-fns` | 4.x | Date manipulation | Already used. No change needed. |
| `cmdk` | 1.x | Combobox search | Already used for tutor search. No change needed. |

## Architecture Shift: From Client-Fetch to Server-Stream

### Current Pattern (slow)

```
Browser navigates to /search
  -> Server sends empty HTML shell (entire page is "use client")
  -> Browser downloads JS bundle
  -> Browser hydrates the empty shell
  -> useEffect fires fetch('/api/filters')     <-- WATERFALL #1
  -> Filters arrive, dropdowns populate
  -> useEffect fires fetch('/api/tutors')      <-- WATERFALL #2
  -> Tutors arrive, combobox populates
  -> User can finally interact with a populated UI
```

**Problem:** 3-4 sequential round trips before the user can interact. The entire search page is one giant `"use client"` component (879 lines). Nothing renders on the server.

### Target Pattern (near-instant)

```
Browser navigates to /search
  -> Server renders static shell instantly (nav, form layout, skeleton placeholders)
  -> Server streams filter data inline (embedded in RSC payload, no separate fetch)
  -> Server streams tutor list inline (same)
  -> Browser hydrates progressively
  -> User sees populated dropdowns on first paint
```

**Key change:** Move filter and tutor data fetching from client-side `useEffect` to Server Components with `'use cache'`. The search form itself stays as a Client Component but receives pre-fetched data as props.

### Concrete Refactoring Pattern

```tsx
// BEFORE: Everything in one "use client" file (current state)
// src/app/(app)/search/page.tsx
"use client";
export default function SearchPage() {
  const [filters, setFilters] = useState(null);
  useEffect(() => {
    fetch("/api/filters").then(...)  // Client-side waterfall
  }, []);
  // ... 850 more lines
}

// AFTER: Server Component parent, Client Component child
// src/app/(app)/search/page.tsx (Server Component -- no directive)
import { Suspense } from "react";
import { SearchWorkspace } from "@/components/search/search-workspace";
import { SearchSkeleton } from "@/components/search/skeletons";

export default function SearchPage() {
  return (
    <Suspense fallback={<SearchSkeleton />}>
      <SearchDataLoader />
    </Suspense>
  );
}

async function SearchDataLoader() {
  "use cache";
  cacheLife("hours");
  cacheTag("snapshot");
  const filters = await getFilters();   // Direct index call, no HTTP
  const tutors = await getTutorList();   // Direct index call, no HTTP
  return <SearchWorkspace filters={filters} tutors={tutors} />;
}

// src/components/search/search-workspace.tsx
"use client";
export function SearchWorkspace({ filters, tutors }: Props) {
  // All existing interactive logic unchanged,
  // but filters/tutors arrive as serialized props
  // instead of via useEffect fetch
}
```

### Cache Invalidation After Sync

```tsx
// In the sync-wise API route, after promoting a new snapshot:
import { revalidateTag } from "next/cache";

// After successful sync promotion:
revalidateTag("snapshot", "max");
// All cached filter/tutor data will be refreshed in background
// Users see stale data instantly, fresh data arrives shortly after
```

## What NOT to Do

| Anti-Pattern | Why It's Bad | What to Do Instead |
|-------------|-------------|-------------------|
| Wrap entire page in single `<Suspense>` | Defeats streaming -- nothing shows until everything resolves. On client navigation, root Suspense is above the shared layout and has no effect. | Use sibling Suspense boundaries for independent data sections |
| Use `'use cache'` on search/compare API routes | These return user-specific filtered results that change per request | Keep API routes dynamic. Cache only the underlying data (filters, tutor list, snapshot metadata) |
| Add `loading.tsx` to every route | Creates jarring loading states for routes that already load fast | Only add to routes with meaningful async data (`/search`, `/data-health`). Login loads instantly already. |
| Use `router.push()` for internal navigation | Loses prefetching benefits and layout deduplication | Use `<Link>` component which auto-prefetches on viewport entry and deduplicates shared layouts |
| Fetch data in `useEffect` when Server Components could provide it | Creates client-side waterfalls, shows empty states, requires loading spinners | Move data fetching to Server Components, pass as props to Client Components |
| Cache search results or compare responses | User-specific, filtered by time/subject/mode -- infinite cache key space | Only cache the underlying index data and filter options |
| Disable Turbopack | Slower builds and dev refresh for no benefit | Keep Turbopack (default in Next.js 16) |
| Put `'use cache'` on components that read cookies/headers | Cached scopes cannot access request-specific data | Read cookies outside cached scope and pass values as arguments |

## Configuration Changes

```ts
// next.config.ts -- target configuration
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,  // Enables PPR + use cache + Activity
  // Consider after core work is done:
  // reactCompiler: true,  // Auto-memoization (adds build time)
  // experimental: {
  //   turbopackFileSystemCacheForDev: true,
  // },
};

export default nextConfig;
```

## Skeleton Component Strategy

Use shadcn/ui `Skeleton` component (already installed) to create matching skeletons:

| Component | Skeleton Design |
|-----------|----------------|
| Search form | 3x3 grid of skeleton rectangles matching the filter dropdown layout |
| Availability grid | Table skeleton with header row + 5-6 body rows of skeleton cells |
| Compare calendar | 7-column week header skeletons + vertical time grid skeleton bars |
| Tutor combobox | Single skeleton line with rounded pill shape |
| Week picker | Skeleton bar with left/right arrow placeholders |
| Tutor selector chips | 3 skeleton pills in a row |

Skeletons should match the exact dimensions and layout of the real components to prevent layout shift (CLS = 0).

## Confidence Assessment

| Recommendation | Confidence | Source |
|---------------|------------|--------|
| `cacheComponents: true` | HIGH | Official Next.js 16 docs bundled in `node_modules/next/dist/docs/`, blog post |
| `'use cache'` for filters/tutor list | HIGH | Official `use-cache.md` docs, exact syntax verified |
| Server Component data loading pattern | HIGH | Core Next.js App Router pattern since v13, extensively documented |
| Sibling `<Suspense>` boundaries | HIGH | Official streaming guide with explicit examples |
| `<Activity>` state preservation | HIGH | Ships automatically with `cacheComponents: true`, documented in `cacheComponents.md` |
| `unstable_instant` export | MEDIUM | Documented but `version: draft` in bundled docs. API has `unstable_` prefix. Adopt for validation but expect rename. |
| `revalidateTag(tag, profile)` | HIGH | Documented with new 2-argument signature in Next.js 16 |
| React Compiler (`reactCompiler: true`) | MEDIUM | Stable in Next.js 16 but adds build time via Babel. Not priority for this milestone -- evaluate after core perf work. |

## Sources

- Next.js 16 blog post: https://nextjs.org/blog/next-16
- Bundled docs: `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-cache.md`
- Bundled docs: `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheComponents.md`
- Bundled docs: `node_modules/next/dist/docs/01-app/02-guides/streaming.md`
- Bundled docs: `node_modules/next/dist/docs/01-app/02-guides/instant-navigation.md`
- Next.js prefetching guide: https://nextjs.org/docs/app/guides/prefetching
- Next.js loading.js reference: https://nextjs.org/docs/app/api-reference/file-conventions/loading
- shadcn/ui Skeleton: https://ui.shadcn.com/docs/components/radix/skeleton
