# Stack Research — v1.1 Data Fidelity & Depth

**Domain:** Next.js 16 / React 19.2 production web app — additive features only
**Researched:** 2026-04-20
**Confidence:** HIGH for (a) view transitions + (b) sticky/density viz, MEDIUM for (c) Wise historical endpoint

## TL;DR

1. **View transitions (VPOL-01): use the native CSS `startViewTransition()` browser API directly.** Do NOT add `motion` / `framer-motion`. Do NOT enable `experimental.viewTransition` in `next.config.ts`. The React 19.2 `<ViewTransition>` component and the Next.js `experimental.viewTransition` flag are both still experimental and have a known conflict with `cacheComponents: true` (Vercel/next.js #85693, Nov 2025, unresolved at time of writing). Our calendar/week/tutor transitions are same-page state swaps — they don't need router-integrated view transitions at all.
2. **Sticky legend (VPOL-02) + density overview (VPOL-03): zero new dependencies.** Pure `position: sticky` + Tailwind + inline SVG. We already use `sticky top-0` in `week-overview.tsx:297` and `calendar-grid.tsx:103`.
3. **Past-day sessions (PAST-01): the Wise public API docs DO NOT document a historical-session endpoint in any public source we could reach.** The safe v1.1 plan is the DB-snapshot fallback (already named in PROJECT.md); confirm the `status` parameter options via the Wise Postman collection or `devs@wiseapp.live` as a P0 spike before sinking engineering time into the historical path.
4. **Online/onsite detection (MOD-01): no stack change.** `WiseTeacher.isOnlineVariant` and `WiseSession.type` both already exist on our loosely-typed Wise response shapes (`[key: string]: unknown` index signatures in `src/lib/wise/types.ts`). We just need to tighten the types and wire them into `normalization/modality.ts`.

## Recommended Stack (NEW additions only)

### Core Technologies (NEW)

**None.** No new dependencies are required for v1.1. All NEW capabilities (view transitions, sticky legend, density overview, modality detection, historical sessions) are achievable with the existing stack.

### Supporting Libraries (NEW)

**None.** The existing stack covers all v1.1 needs:

| Existing | Version | Already covers v1.1 need |
|----------|---------|--------------------------|
| Browser (Chrome 115+ / Safari 18+ / Firefox 144+) | native | `document.startViewTransition()` — VPOL-01 |
| Tailwind CSS | ^4 | `sticky top-0 z-[N]` — VPOL-02 |
| React + inline SVG | 19.2.4 | Density mini-map (VPOL-03) via `<svg>` with rect bars |
| `date-fns` | ^4.1.0 | Week/day arithmetic already in use |
| `drizzle-orm` + Neon | ^0.45.2 / ^1.0.2 | Snapshot-stored past FUTURE sessions (PAST-01 fallback) |
| `zod` | ^4.3.6 | Tighten `WiseTeacher.isOnlineVariant` / `WiseSession.type` parsing (MOD-01) |

### Development Tools (NEW)

None. Vitest 4.1.2 + the existing test conventions cover the added test surface (expected ~15–30 new tests across `modality.test.ts` updates, a historical-sessions snapshot path, and density-overview unit tests).

## Installation

```bash
# No new packages.
# v1.1 ships entirely on the v1.0 dependency set.
```

## Feature-by-Feature Stack Decisions

### (a) View Transitions (VPOL-01) — use `document.startViewTransition()`

**Decision:** Use the browser-native CSS View Transitions API directly, gated behind a feature check. Do NOT install `motion` / `framer-motion`. Do NOT set `experimental.viewTransition: true` in `next.config.ts`.

**Why:**

1. **React 19.2.4 stable does NOT export `<ViewTransition>`.** It lives in `react/canary` behind `@enableViewTransition` (confirmed by inspecting `node_modules/@types/react/canary.d.ts` lines 38–109 and `experimental.d.ts` line 37). The Next.js 16 built-in doc `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md` literally says: *"for now, we strongly advise against using this feature in production."*
2. **Known Next.js 16 + cacheComponents conflict.** [Vercel/next.js #85693](https://github.com/vercel/next.js/issues/85693) (opened Nov 2025, reproducible in 16.0.1 + 19.2.0) documents that `experimental.viewTransition` + `cacheComponents: true` together produce a broken, "blurred, abrupt" animation instead of a smooth transition. Our v1.0 app relies on `cacheComponents: true` — enabling `viewTransition` is a regression risk, not a win.
3. **Our transitions are same-page state swaps, not router navigations.** Week picker, tutor add/remove, calendar/day drill-down all happen inside `/search`. Router-integrated view transitions (the thing `experimental.viewTransition` enables) give us nothing — we need DOM-mutation transitions. Those work today via the plain `document.startViewTransition(callback)` browser API, which is Baseline Newly Available as of Oct 2025 (Chrome 115+, Edge 115+, Safari 18+, Firefox 144+). ([MDN View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API))
4. **`motion` / `framer-motion` is 34 kb gzipped minimum** for the `motion` component and requires `"use client"` everywhere or the `motion/react-client` shim. The native API is 0 kb, and it composes naturally with React 19.2's existing `startTransition` / `useDeferredValue`.
5. **Graceful degradation is free.** Browsers without support just skip the animation — no feature flag, no polyfill, no runtime cost.

**Integration pattern:**

```tsx
"use client";

// src/lib/view-transitions.ts
export function withViewTransition(update: () => void) {
  if (typeof document === "undefined") return update();
  const api = (document as Document & { startViewTransition?: (cb: () => void) => unknown })
    .startViewTransition;
  if (!api) return update();
  api.call(document, update);
}
```

Call sites (`use-compare.ts`, calendar day drill-down, tutor add/remove):

```tsx
withViewTransition(() => setWeekStart(nextMonday));
```

Mark transitioning DOM with `view-transition-name: tutor-{id}` in `globals.css` (or inline `style`) — the API cross-fades by name. This keeps all transition logic declarative, CSS-driven, and removable by just unsetting the `view-transition-name`.

**Compatibility with `cacheComponents: true`:** The native `document.startViewTransition()` runs entirely in the client browser after React has committed the DOM update. It has zero interaction with the server-streaming pipeline or the `'use cache'` directive. It does NOT trigger the #85693 issue, which is specifically about Next.js's React-integrated `<Link>` + `ViewTransition` router bridge.

### (b) Sticky Tutor Legend (VPOL-02) + Density Overview (VPOL-03)

**Decision:** Zero new dependencies. Pure Tailwind + inline SVG.

**Why sticky legend needs no library:**

We already use `className="sticky top-0 z-[5] flex bg-background/90 backdrop-blur-sm"` in `week-overview.tsx:297` and `sticky top-0 bg-background z-10` in `calendar-grid.tsx:103`. These are plain CSS `position: sticky` — works in every target browser without any wrapper. The VPOL-02 work is pattern extension, not a new capability.

The only common pitfall is sticky + ancestor `overflow-hidden` (which breaks sticky). Our calendar scroll container uses `overflow-y-auto` on the inner grid and `overflow-hidden` only on `body`, so sticky works end-to-end. Any sticky-library candidate (`react-stickynode`, `react-sticky-el`, `react-sticky-box`) is pure overkill for our use case.

**Why density overview needs no library:**

The v1.1 density mini-map is bounded scope: show per-day / per-hour session density for the visible week in a compact strip or sidebar. Three native options cover every likely shape:

- **Tailwind `bg-*/{opacity}` bars** — for a simple heatmap strip (7 days × 15 hours = 105 cells, trivial). Zero deps.
- **Inline `<svg>`** — for a sparkline-style density curve or a month-strip overview. React-rendered rects/paths, fully reactive to state. Zero deps.
- **CSS conic/linear gradient** — for a floating-widget circular density indicator, if we pick that shape. Zero deps.

`recharts` / `visx` / `d3` are all overkill for 105 data points. `react-window` / `@tanstack/react-virtual` are irrelevant (we're not virtualizing a long list). We should NOT add a viz library.

**Decision on shape:** Defer to Phase 01 design review. The research position is: *any* shape can be implemented with the existing stack. Pick based on UX, not on what a library makes easy.

### (c) Wise Historical Sessions Endpoint (PAST-01)

**Decision:** Treat as UNCONFIRMED. Ship the DB-snapshot fallback in v1.1; schedule a Wise-docs spike to confirm whether a historical endpoint exists before v1.2.

**What we know:**

- Our current fetcher (`src/lib/wise/fetchers.ts:96`) calls `GET /institutes/{instituteId}/sessions` with `status=FUTURE` as the only documented value we've used.
- `WiseSession` has `scheduledStartTime` (ISO UTC), `scheduledEndTime`, `meetingStatus`, and `type` fields. Pagination is `paginateBy=COUNT` + `page_number` + `page_size`.
- `WiseSessionsResponse` envelope includes `page_count` + `totalRecords`.

**What we do NOT know (confidence LOW for all negative claims):**

- Whether `status` accepts other values like `PAST`, `COMPLETED`, `ALL`, `HISTORICAL`. Public Wise docs (`docs.wise.live`, `wise-app.gitbook.io`) point to a private Postman collection for details; the enum isn't in any indexed public source I could reach.
- Whether a separate endpoint (e.g. `/sessions/history`, `/sessions?startDate=...&endDate=...`) exists.
- Whether there are rate limits on historical queries.

**Recommended v1.1 approach (ordered):**

1. **P0 spike (≤30 min): email `devs@wiseapp.live` with these 3 questions and also check the in-product Postman link if available:**
   - Does `GET /institutes/{instituteId}/sessions` accept `status` values other than `FUTURE`?
   - Is there an endpoint that returns sessions with `scheduledStartTime` in the past?
   - Are there pagination or rate-limit differences for historical queries?
2. **Ship the fallback unconditionally.** Add a `historical_sessions` table (snapshot-scoped) that captures the set of FUTURE sessions at each nightly sync. When the nightly sync runs, any session whose `scheduledStartTime` is now in the past that was FUTURE in a previous snapshot gets persisted to `historical_sessions`. This is a ≤200-line Drizzle migration + orchestrator hook, entirely within the existing stack.
3. **If the spike returns a YES:** add a second fetcher in `src/lib/wise/fetchers.ts`, guard it behind a feature flag, and prefer it over the snapshot fallback when available. Snapshot fallback becomes a resilience net.

**Why we build the fallback even if the endpoint exists:** historical Wise data only goes as far back as their retention policy; admins may want weeks we didn't sync, and the snapshot fallback is the only source of truth for "what was scheduled when we looked on day X."

### (d) Online/Onsite Detection (MOD-01) — no stack change

**Decision:** No dependency changes. Tighten `WiseTeacher` and `WiseSession` type definitions in `src/lib/wise/types.ts` to surface the existing `isOnlineVariant` and `sessionType` fields, then fold them into the existing modality cascade in `src/lib/normalization/modality.ts`.

**Current state:**
- `WiseTeacher` in `src/lib/wise/types.ts:9` uses `[key: string]: unknown` as an escape hatch — `isOnlineVariant` is addressable today but not typed.
- `WiseSession` in `src/lib/wise/types.ts:55` declares `type?: string` and `[key: string]: unknown` — `sessionType` is addressable today but not typed.
- The current modality cascade uses *location-string pattern matching* which the CLAUDE.md "Known Issues" section already flags as unreliable.

**Work:** Add `isOnlineVariant?: boolean` to `WiseTeacher`, promote `WiseSession.type` to a discriminated union `"ONLINE" | "OFFLINE" | "HYBRID" | string`, extend `normalizeModality()` to check those fields FIRST (before the location heuristic), and keep the fail-closed default. No library, no migration.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Native `document.startViewTransition()` | `motion` (`motion/react`) | If we wanted complex choreography (shared-element layouts across unrelated DOM subtrees, spring physics, drag gestures). We don't — calendar transitions are cross-fades and position animations that CSS view-transitions handle natively. |
| Native `document.startViewTransition()` | React `<ViewTransition>` (`react/canary`) + `experimental.viewTransition` flag | If Vercel/next.js #85693 is resolved AND React promotes `<ViewTransition>` to stable AND we drop `cacheComponents: true`. All three are unlikely in the v1.1 window. |
| Pure Tailwind `sticky` | `react-stickynode` / `react-sticky-el` / `react-sticky-box` | If we needed sticky-until-a-sentinel-scrolls-past behavior with custom easing. We don't — standard `position: sticky` meets VPOL-02 literally and has shipped in two components already. |
| Inline SVG / Tailwind bars for density | `recharts`, `visx`, `@tanstack/react-charts` | If the density overview evolved into a full analytics dashboard. For a 105-cell heatmap or a 30-bar strip, React + SVG is 10 lines and 0 bytes. |
| Wise DB-snapshot fallback | Wise historical endpoint (if it exists) | If the `devs@wiseapp.live` spike confirms a real endpoint AND data retention covers our full use window. Even then, we keep the snapshot fallback as a resilience layer. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `motion` / `framer-motion` | 34 kb gzipped minimum; requires `"use client"` for every animated subtree; duplicates what native CSS view-transitions now do for free; bundle cost hits search page directly. | Native `document.startViewTransition()` + CSS `view-transition-name`. |
| `experimental.viewTransition: true` in `next.config.ts` | Experimental in Next.js 16.2 (Mar 2026 release); known conflict with `cacheComponents: true` per Vercel/next.js #85693 (unresolved Nov 2025); explicit "do not use in production" in the built-in docs. | Client-only native API — doesn't touch the framework integration. |
| `react/canary` or `react@experimental` upgrade to get `<ViewTransition>` | Breaks our supply chain (`@auth/drizzle-adapter`, `@base-ui/react`, `shadcn`, `cmdk` all target stable 19.x); `@enableViewTransition` feature flag is a moving target; canary isn't covered by the `next-auth` beta contract either. | Stay on React 19.2.4 stable; use the browser API. |
| `react-stickynode` / `react-sticky-el` / `react-sticky-box` | Solves a 2018-era problem — `position: sticky` has had universal support since ~2020. Adds weight and an abstraction the browser already provides. | Tailwind `sticky top-0 z-[N]`. |
| `recharts` / `d3` / `visx` for density overview | Wrong tool for ≤200 data points; pulls in `d3-scale`, `d3-shape`, or React component overhead (`recharts` is ~70 kb); we would use <5% of the API surface. | Inline `<svg>` rects or Tailwind-styled `<div>` bars. |
| New HTTP client (`ky`, `ofetch`, `axios`) for the historical-sessions fetch | Our `WiseClient` in `src/lib/wise/client.ts` already has retry + backoff + concurrency. Duplicating infra for one endpoint is net-negative. | Extend the existing `WiseClient.get()` with a new fetcher. |
| Client-side storage library (`zustand`, `jotai`, `valtio`) for density overview state | Current compare state lives in `useCompare`; VPOL-03 is a derivation of the same data. State library adds import-order complexity without solving a real problem. | Derived `useMemo` in the existing hook. |

## Stack Patterns by Feature

**If view transitions need more than fade/slide (drag, springs, gestures):**
- Revisit `motion` / `framer-motion`. Research says we don't need this; ship native first and validate.

**If density overview grows into a multi-panel analytics dashboard:**
- Revisit a charting library. Out of v1.1 scope per PROJECT.md Out-of-Scope table.

**If Wise `devs@wiseapp.live` confirms a historical endpoint:**
- Implement `fetchHistoricalSessions(client, instituteId, startDate, endDate)` alongside `fetchAllFutureSessions`. Add orchestrator branch that prefers historical when available, falls back to snapshot.

## Version Compatibility

| Package / API | Compatible With | Notes |
|---------------|-----------------|-------|
| `document.startViewTransition()` | Next.js 16.2.2 + React 19.2.4 + `cacheComponents: true` | Client-only; runs after React commit. Independent of framework animation features. Does not trigger Vercel/next.js #85693. |
| `position: sticky` | Tailwind CSS ^4 | Works with existing `sticky top-0 z-[N]` classes. Ancestor chain must NOT have `overflow-hidden` between sticky element and scroll container. |
| React 19.2.4 | `<ViewTransition>` from `react` | **NOT compatible.** `<ViewTransition>` is only in `react@canary` under `@enableViewTransition`. Confirmed by `@types/react@19.2.14` canary.d.ts. |
| Next.js 16.2.2 `experimental.viewTransition` | `cacheComponents: true` | **Conflicting** per Vercel/next.js #85693. Do not enable together in v1.1. |
| `motion` / `motion/react` | React 19.2.4 | Compatible, but adds 34 kb gzipped floor; requires `"use client"` or `motion/react-client` for RSC trees. |
| `date-fns` ^4.1.0 | Existing timezone utils | Already in use; no changes needed for v1.1. |

## Sources

- **Next.js built-in docs** (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md`) — HIGH confidence. Explicit "strongly advise against using this feature in production." Version: 16.2.2 shipped with our install.
- **Next.js built-in docs** (`node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md`) — HIGH confidence. Confirms `<Activity>` is stable in React 19.2 and is the sanctioned state-preservation primitive alongside `cacheComponents`.
- **`@types/react@19.2.14`** (`node_modules/@types/react/canary.d.ts` lines 38–109, `experimental.d.ts` line 37) — HIGH confidence. `<ViewTransition>` is typed only under `@enableViewTransition` feature flag in canary types, not stable.
- **[React 19.2 release blog](https://react.dev/blog/2025/10/01/react-19-2)** — HIGH confidence. Activity is stable; ViewTransition is mentioned only as a future Suspense-SSR integration target.
- **[Vercel/next.js #85693](https://github.com/vercel/next.js/issues/85693)** — MEDIUM confidence (unresolved at time of research, last checked via WebSearch 2026-04-20). `viewTransition` + `cacheComponents` conflict reported in 16.0.1 + 19.2.0; need to re-check before phase implementation.
- **[MDN View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)** — HIGH confidence. Native `document.startViewTransition()` is Baseline Newly Available (Oct 2025, Firefox 144 + Chrome 115 + Safari 18+).
- **[LogRocket: Comparing React animation libraries](https://blog.logrocket.com/best-react-animation-libraries/)** / **[motion.dev](https://motion.dev/docs/react-installation)** — MEDIUM confidence. Confirms Motion rebrand from `framer-motion` to `motion`; 34 kb minimum gzipped; `motion/react-client` pattern for RSC.
- **[`docs.wise.live/wise-api-integration/api-endpoints`](https://docs.wise.live/wise-api-integration/api-endpoints)** — LOW confidence (public doc surface; detailed Postman collection is auth-gated). No historical-sessions endpoint found in public docs. Needs `devs@wiseapp.live` confirmation before Phase 01 commits to a direction.
- **`src/lib/wise/types.ts`** (this repo) — HIGH confidence. `WiseTeacher` and `WiseSession` shapes include `[key: string]: unknown` escape hatches, so `isOnlineVariant` / `sessionType` are addressable today without schema changes.
- **`src/lib/wise/fetchers.ts`** (this repo) — HIGH confidence. Current code calls `GET /institutes/{instituteId}/sessions?status=FUTURE` with `paginateBy=COUNT` pagination; no historical path exercised yet.
- **`src/components/compare/week-overview.tsx:297`** and **`src/components/compare/calendar-grid.tsx:103`** (this repo) — HIGH confidence. Prior art for `sticky top-0 z-[N]` already shipping in production — VPOL-02 is a pattern extension.

---

*Stack research for: v1.1 Data Fidelity & Depth (subsequent milestone)*
*Researched: 2026-04-20*
