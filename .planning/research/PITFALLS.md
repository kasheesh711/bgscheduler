# Domain Pitfalls

**Domain:** Next.js 16 performance/UX refactoring of a live production scheduling app
**Researched:** 2026-04-10

## Critical Pitfalls

Mistakes that cause rewrites, production outages, or major regressions.

### Pitfall 1: Splitting the 878-line Monolithic Search Page Breaks State Coordination

**What goes wrong:** The `/search` page (`page.tsx`) is a single 878-line `"use client"` component containing 20+ `useState` hooks, a `useRef` cache (`Map<string, CompareTutor>`), and tightly coupled handlers (`fetchCompare`, `handleAddTutor`, `handleRemoveTutor`, `handleWeekChange`) that read and write across search state, compare state, and the tutor cache simultaneously. Splitting this into smaller components without a shared state strategy causes one of two failures: (a) state gets duplicated across components and falls out of sync, or (b) props drilling becomes so deep that re-renders cascade through the entire tree, making performance worse than before.

**Why it happens:** The search panel (left) and compare panel (right) share state in non-obvious ways. The "Compare Selected" button in the search panel writes to `compareTutors` state consumed by the compare panel. The `fetchCompare` callback uses `tutorCache` (a `useRef`), `lastSnapshotId` (another `useRef`), and calls `setCompareTutors` and `setCompareResponse`. Extracting the compare panel into its own component means either lifting all this state to a parent (back to square one) or introducing a state management layer.

**Consequences:** Broken tutor cache invalidation (snapshot changes not detected), stale compare results after search-to-compare handoff, AbortController leaks when the abort ref lives in a different component than the fetch call.

**Prevention:**
1. Before splitting, map every cross-panel data dependency. The critical shared state is: `compareTutors`, `compareResponse`, `weekStart`, `tutorCache`, `lastSnapshotId`, `abortRef`.
2. Extract a `useCompare` custom hook that owns ALL compare state (including the cache ref, abort controller, and fetch logic). Both panels import the hook's return values.
3. Do NOT use React Context for this -- Context causes re-renders on every state change for all consumers. The custom hook pattern with selective return values is sufficient for 2 consumers.
4. Split incrementally: extract the compare hook first, verify the 82 tests still pass, then extract the UI components.

**Detection:** Compare panel shows stale data after adding/removing tutors. Week navigation stops working. Console shows "AbortError" after component unmount.

**Phase relevance:** This is the core refactoring task. Must be the first thing addressed -- all other optimizations depend on clean component boundaries.

### Pitfall 2: Module-Level Singleton Lost Between Webpack and Node Runtimes

**What goes wrong:** The search index (`src/lib/search/index.ts`) uses a module-level `let currentIndex: SearchIndex | null = null` singleton. In Next.js on Vercel, the webpack runtime and the Node.js runtime maintain separate module registries within the same process. The singleton can be instantiated twice -- once by each runtime -- causing the index to appear "empty" in some requests despite being built in others.

**Why it happens:** Next.js uses webpack's module loader alongside Node's native `require()`. Module-level variables that rely on being initialized once (`let _db`, `let currentIndex`) are only singletons within their respective module system. The `getDb()` function in `src/lib/db/index.ts` has the same vulnerability. This is documented in [vercel/next.js#65350](https://github.com/vercel/next.js/issues/65350).

**Consequences:** Intermittent 500 errors where the search index is null despite having been built. Cold starts rebuild the index unnecessarily. In the worst case, two simultaneous `buildIndex` calls race against each other.

**Prevention:**
1. Anchor singletons on `globalThis` instead of module-level variables:
   ```typescript
   const globalForIndex = globalThis as unknown as { searchIndex?: SearchIndex };
   export function getSearchIndex() { return globalForIndex.searchIndex ?? null; }
   ```
2. Apply the same pattern to `getDb()` in `src/lib/db/index.ts`.
3. The existing `buildingPromise` deduplication guard is good but also needs to be on `globalThis`.

**Detection:** After deploying, monitor for unexpected index rebuilds. If `ensureIndex` logs show "Need to rebuild" when the snapshot hasn't changed, the singleton is being lost.

**Phase relevance:** Should be addressed early (performance phase) since it affects cold start latency and is a prerequisite for any server-component data fetching that relies on the index.

### Pitfall 3: Converting Data-Fetching to Server Components Creates Waterfalls

**What goes wrong:** The current architecture makes 3 client-side `fetch()` calls on mount: `/api/filters` (for dropdowns), `/api/tutors` (for combobox), and `/api/compare` (when `?tutors=` is in the URL). These run in parallel from the browser. If refactored naively to server components -- e.g., making the page an async server component that awaits all three -- they execute sequentially on the server, creating a waterfall that makes the page SLOWER than the current client-side approach.

**Why it happens:** In an async server component, each `await` blocks the next line. `const filters = await getFilters(); const tutors = await getTutors();` is sequential. Developers forget to use `Promise.all()` or Suspense boundaries to parallelize.

**Consequences:** Time to first paint increases from ~200ms (cached HTML + parallel client fetches) to ~800ms+ (server blocks on 3 sequential DB queries before sending any HTML).

**Prevention:**
1. Use `Promise.all()` for independent data fetches in server components.
2. Better: use separate Suspense boundaries so each data source streams independently. The filters dropdown can show a skeleton while the tutor list loads.
3. Keep the compare view as a client component -- it has too much interactive state (week picker, tutor chips, cache) for server rendering.
4. The `/api/filters` and `/api/tutors` endpoints are good candidates for server component data fetching (they're read-only, no user input). The search and compare endpoints should stay as client-side API calls because they depend on user-driven parameters.

**Detection:** Measure Time to First Byte (TTFB) before and after refactoring. If TTFB increases by more than 100ms, you've introduced a waterfall.

**Phase relevance:** Must be addressed when converting any fetch-on-mount patterns to server components.

### Pitfall 4: useSearchParams Suspense Boundary Causes Full-Page CSR Bailout

**What goes wrong:** The search page uses `useSearchParams()` to read `?tutors=` for deep linking. This hook forces the entire component tree up to the nearest Suspense boundary to be client-side rendered. The current code already has a Suspense wrapper around `SearchPageInner`, which is correct. BUT if during refactoring someone moves `useSearchParams()` into a parent server component or removes the Suspense boundary, the entire page loses static prerendering and the build may fail.

**Why it happens:** `useSearchParams()` prevents static generation because search params are only known at request time. Next.js requires a Suspense boundary to create a "static shell" that can be prerendered while the dynamic part renders on the client.

**Consequences:** Build failure with `Missing Suspense boundary with useSearchParams`. Or worse: silent CSR bailout where the entire page renders client-side, defeating all server-component optimizations.

**Prevention:**
1. Keep `useSearchParams()` in the smallest possible client component.
2. Extract deep-link reading into a tiny `<DeepLinkReader>` component wrapped in Suspense, rather than having the entire page depend on it.
3. Consider using `searchParams` prop on the page server component instead (available as an async prop in Next.js 15+), and pass the initial tutor IDs down as a prop.

**Detection:** During build, Next.js will warn about CSR bailout. After deploy, check if the page HTML response contains rendered content or just a loading skeleton -- if it's all skeleton, you've lost prerendering.

**Phase relevance:** Must be handled when restructuring the search page component hierarchy.

## Moderate Pitfalls

### Pitfall 5: Suspense Boundary "Popcorn Effect" Destroys UX

**What goes wrong:** Over-granular Suspense boundaries cause multiple independent loading skeletons that resolve at different times, creating a jarring "popcorn" effect where parts of the page pop in one by one. For admin staff who need a stable, predictable interface, this is worse than a single loading state.

**Prevention:**
1. Group related data behind a single Suspense boundary. The search form + filter dropdowns should be one boundary (they're meaningless without each other). The compare calendar is another boundary.
2. Use `loading.tsx` for the route-level loading state, and Suspense only for within-page streaming of secondary content.
3. The data-health page is a good candidate for multiple Suspense boundaries (stats, issues table, sync history are independent). The search page is not -- it's a coordinated workspace.

**Phase relevance:** When adding streaming/Suspense to existing pages.

### Pitfall 6: Client-Side Tutor Cache Invalidation Race Condition

**What goes wrong:** The existing `tutorCache` (a `useRef<Map>`) has a race condition: if a snapshot change is detected mid-fetch, `fetchCompare` clears the cache and recursively calls itself. But if two fetches are in flight (e.g., user clicks "Add tutor" then immediately changes week), the abort controller cancels the first request but the recursive refetch from the snapshot-change detection can fire after the abort, causing the cache to contain data from two different snapshots.

**Prevention:**
1. Add the `snapshotId` to the cache key (already partially done with `tutorGroupId:weekStart`, but add snapshot).
2. When the snapshot changes, clear the cache AND increment a "generation" counter. Only accept fetch results that match the current generation.
3. This is a pre-existing bug, not a refactoring risk, but refactoring will expose it more frequently if fetch patterns change.

**Detection:** After a sync runs and the snapshot changes, the compare view shows inconsistent session data (some tutors have old data, some have new).

**Phase relevance:** Should be fixed during the compare panel refactoring.

### Pitfall 7: Breaking the Fail-Closed Safety Contract During Refactoring

**What goes wrong:** The app has a non-negotiable rule: unresolved identity/modality/qualification must show as "Needs Review", never "Available". During refactoring, it's easy to accidentally drop the `dataIssues` check or the "Needs Review" routing when restructuring component boundaries. The search engine logic is well-tested (82 tests), but the UI rendering of "Needs Review" badges is not covered by unit tests.

**Prevention:**
1. Before refactoring any component that renders availability status, write an integration test or Playwright E2E test that verifies "Needs Review" tutors are visually flagged.
2. The search engine tests cover the backend logic. The gap is the frontend: does the `AvailabilityGrid` component correctly render the "Needs Review" state from the API response?
3. Add a smoke test: POST to `/api/search/range` with a known-unresolved tutor and verify the response contains `needsReview: true`.

**Detection:** An admin searches and sees a tutor marked "Available" who should be "Needs Review". This is a data-integrity violation.

**Phase relevance:** Relevant throughout all UI refactoring phases.

### Pitfall 8: Auth Session Check Overhead in Server Components

**What goes wrong:** Every API route calls `await auth()` to check the session. If pages are converted to server components that fetch data directly (bypassing API routes), the `auth()` call must be added to each server component. Missing it exposes data to unauthenticated users. Adding it redundantly (e.g., layout + page + each data-fetching component) adds latency.

**Prevention:**
1. Check auth once in the `(app)/layout.tsx` server component and redirect unauthenticated users to `/login`.
2. For data-fetching server components within the authenticated layout, the auth check is already done by the parent -- no need to repeat it.
3. Keep the `auth()` check on API routes since they can be called directly via curl.
4. Use Next.js middleware for the auth redirect if not already configured.

**Detection:** After refactoring, try accessing `/search` while logged out. If you see the page content flash before redirecting, auth is checked too late.

**Phase relevance:** When converting client-side fetch to server component data fetching.

## Minor Pitfalls

### Pitfall 9: Calendar Component Re-renders on Every State Change

**What goes wrong:** `WeekOverview` (471 lines) and `CalendarGrid` (275 lines) use `useMemo` for some computations but receive the full `CompareTutor[]` array and `Conflict[]` as props. Any state change in the parent (even unrelated, like typing in the search form) triggers a re-render of these expensive components because the arrays are new references on each render.

**Prevention:**
1. Once the compare state is extracted into a custom hook, the calendar components will only re-render when compare state changes (not search state changes). This is the primary fix.
2. Use `React.memo()` on `WeekOverview` and `CalendarGrid` with a custom comparator that checks `tutors.length` and tutor IDs rather than deep equality.
3. Do NOT prematurely optimize with `useMemo` on every intermediate value -- profile first with React DevTools Profiler.

**Phase relevance:** After the component splitting phase.

### Pitfall 10: Next.js 16 Async API Changes Break Existing Patterns

**What goes wrong:** Next.js 15+ changed `cookies()`, `headers()`, `params`, and `searchParams` to be async. If the codebase is migrated to Next.js 16 patterns (it's already on 16.2.2), any new server components must use `await cookies()` etc. Mixing old sync patterns with new async ones causes runtime errors.

**Prevention:**
1. The codebase already uses Auth.js which handles cookies internally. When adding new server components, always `await` the async APIs.
2. Run `npx @next/codemod@latest next-async-request-api .` if you encounter sync-to-async migration needs.
3. Check `src/lib/auth.ts` to confirm Auth.js is using the async API correctly.

**Phase relevance:** When adding any new server components.

### Pitfall 11: Vercel Hobby Plan Function Timeout During Refactoring

**What goes wrong:** The sync function currently takes ~4m26s with a 5m (300s) ceiling. If server components are added that perform heavy data loading (e.g., building the search index during SSR), those functions compete for the same execution time budget. A slow server-component render could time out on Hobby plan.

**Prevention:**
1. Never build or rebuild the search index inside a server component render. The index should be pre-built (via the cron sync) and only read during rendering.
2. `ensureIndex()` with its stale check is safe for server components as long as the index is already warm. The risk is the cold-start rebuild (~4s for 131 teachers).
3. Add a timeout guard: if `ensureIndex` takes more than 5 seconds, return a "loading" state instead of blocking the render.

**Phase relevance:** When implementing server-side data fetching.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Component splitting | #1 State coordination breaks | Extract `useCompare` hook first, test before splitting UI |
| Server component conversion | #3 Waterfall, #4 CSR bailout, #8 Auth gaps | Keep compare as client; convert filters/tutors to server; check auth in layout |
| Streaming/Suspense | #5 Popcorn effect | Group related data behind single boundaries; max 2-3 per page |
| Singleton optimization | #2 Module-level singleton loss | Move to `globalThis` before any other perf work |
| Cache improvements | #6 Race condition | Add snapshot to cache key, use generation counter |
| Calendar readability | #7 Safety contract | Write E2E test for "Needs Review" rendering before touching calendar |
| General refactoring | #9 Re-render cascade, #10 Async APIs | Profile first, `React.memo` second; always await async APIs |

## Sources

- [Next.js Server and Client Components docs](https://nextjs.org/docs/app/getting-started/server-and-client-components) -- HIGH confidence
- [Missing Suspense with CSR bailout](https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout) -- HIGH confidence
- [Next.js Singleton inconsistency issue #65350](https://github.com/vercel/next.js/issues/65350) -- HIGH confidence
- [Global Singleton and the Runtime Hell in Next.js](https://www.hawu.me/dev/6268) -- MEDIUM confidence
- [React Server Components performance pitfalls (LogRocket)](https://blog.logrocket.com/react-server-components-performance-mistakes) -- MEDIUM confidence
- [Streaming and Suspense patterns](https://dev.to/preeti_yadav/streaming-suspense-in-nextjs-why-your-app-feels-slow-even-when-it-isnt-571i) -- MEDIUM confidence
- [Canonical singleton approach discussion](https://github.com/vercel/next.js/discussions/68572) -- MEDIUM confidence
- Direct codebase analysis of `src/app/(app)/search/page.tsx`, `src/lib/search/index.ts`, `src/lib/db/index.ts` -- HIGH confidence
