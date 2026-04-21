# Architecture

**Analysis Date:** 2026-04-21

## Pattern Overview

**Overall:** Snapshot-based ETL pipeline with in-memory query index served by Next.js 16 App Router (RSC + Client Components) over Neon Postgres.

**Key Characteristics:**
- **Snapshot-based data model** — all tutor data is versioned under a `snapshotId`. Exactly one snapshot has `active = true` at any instant; promotion is atomic. Failed syncs preserve the previous active snapshot.
- **Server-memory search index singleton** — the entire active snapshot is hydrated into a `SearchIndex` on the Node process and anchored on `globalThis` so it survives HMR in dev. All search/compare/filter/tutor queries run against this index with zero additional DB round-trips at request time.
- **Fail-closed safety** — unresolved identity, modality, qualification, or unknown session status routes tutors to "Needs Review", never "Available". Cancelled sessions are explicitly non-blocking.
- **Snapshot-scoped data invalidation** — `cacheTag("snapshot")` on server-cached helpers (`src/lib/data/filters.ts`, `src/lib/data/tutors.ts`); sync endpoint calls `revalidateTag("snapshot", { expire: 0 })` after a successful promote.
- **Incremental client cache** — the compare panel maintains a `Map<tutorGroupId:weekStart:version, CompareTutor>` so adding/removing a tutor avoids refetching the full selection.

## Layers

**Wise API Client Layer:**
- Purpose: HTTP communication with the Wise scheduling platform
- Location: `src/lib/wise/`
- Contains: `src/lib/wise/client.ts` (HTTP client with retry/backoff/concurrency limiter, Basic Auth + `x-api-key` + `x-wise-namespace` headers), `src/lib/wise/fetchers.ts` (domain fetchers: `fetchAllTeachers`, `fetchTeacherFullAvailability`, `fetchAllFutureSessions`), `src/lib/wise/types.ts` (Wise API response shapes, `WiseTag` union)
- Depends on: Nothing internal (pure HTTP + env vars)
- Used by: Sync orchestrator only

**Normalization Layer:**
- Purpose: Transform raw Wise API data into canonical internal representations keyed to Asia/Bangkok
- Location: `src/lib/normalization/`
- Contains:
  - `src/lib/normalization/identity.ts` — 5-step cascade (nickname regex → alias lookup → online/offline pair → unresolved → data_issue)
  - `src/lib/normalization/availability.ts` — `workingHours` → recurring windows with de-dup + overlap merge
  - `src/lib/normalization/leaves.ts` — UTC → Asia/Bangkok conversion, overlap merge over 180-day horizon
  - `src/lib/normalization/sessions.ts` — blocking classification (CANCELLED/CANCELED non-blocking, unknown = blocking)
  - `src/lib/normalization/qualifications.ts` — tag parsing into `{subject, curriculum, level, examPrep}`
  - `src/lib/normalization/modality.ts` — derived from pair structure → session type → location → unresolved
  - `src/lib/normalization/timezone.ts` — `TIMEZONE = "Asia/Bangkok"`, `toLocalTime`, `getLocalWeekday`, `getLocalMinuteOfDay`, `parseTimeToMinutes`
- Depends on: `@/lib/wise/types`
- Used by: Sync orchestrator and (for `parseTimeToMinutes`) search engine

**Sync Orchestrator:**
- Purpose: Full ETL pipeline — fetch, normalize, persist, validate, promote
- Location: `src/lib/sync/orchestrator.ts`
- Contains: `runFullSync(db, client, instituteId)` — single entry point. Creates `sync_runs` row → creates candidate `snapshots` row → fetches teachers → resolves identities → per-teacher fetches availability/leaves → fetches all future sessions → normalizes qualifications → derives modality per group → detects per-session modality contradictions (`conflict_model`) → chunks inserts at 250 rows → stores `snapshot_stats` → atomic promote if `unresolvedRatio < 0.5` → updates `sync_runs`
- Depends on: Wise client, every normalization module, `@/lib/search/compare` (for `detectSessionModalityConflict`), DB layer
- Used by: `POST/GET /api/internal/sync-wise`

**Database Layer:**
- Purpose: Postgres connection and schema definition
- Location: `src/lib/db/`
- Contains:
  - `src/lib/db/index.ts` — `getDb()` returns a `globalThis.__bgscheduler_db`-anchored Drizzle/Neon HTTP client singleton
  - `src/lib/db/schema.ts` — 14 Drizzle ORM tables + 4 enums (see STRUCTURE.md)
  - `src/lib/db/seed.ts` — admin users and aliases seeder (`npm run db:seed`)
- Depends on: `@neondatabase/serverless`, `drizzle-orm`
- Used by: All server-side code

**Search Index Layer:**
- Purpose: In-memory data structure for fast query execution
- Location: `src/lib/search/index.ts`
- Contains: `SearchIndex` interface, `IndexedTutorGroup`, `buildIndex()` (parallel `Promise.all` over 6 tables for the active `snapshotId`), `ensureIndex()` (lazy init + stale detection against DB), `getSearchIndex()`, `getActiveSnapshotId()`. Singleton anchored on `globalThis.__bgscheduler_searchIndex`; concurrent rebuilds coalesced via `globalThis.__bgscheduler_searchIndexBuildPromise`
- Depends on: DB layer + schema
- Used by: Search engine, compare engine, every API route, server-cached helpers in `src/lib/data/`

**Search Engine:**
- Purpose: Execute availability searches against the in-memory index
- Location: `src/lib/search/engine.ts`
- Contains: `executeSearch(index, request)` (entry), `searchSlot()` (per-slot), `isBlockedRecurring()` (weekday+minute overlap across ALL future sessions on that weekday), `isBlockedOneTime()` (exact date+minute overlap), `hasRecurringLeaveConflict()`/`hasOneTimeLeaveConflict()` (leave overlap with multi-day awareness), `matchesFilters()` (case-insensitive subject/curriculum/level), `computeIntersection()` (multi-slot AND), `getBlockingSessions()` (used by range route to decorate blocked cells). Stale threshold: 35 minutes
- Depends on: `@/lib/search/index`, `@/lib/normalization/timezone`
- Used by: `POST /api/search`, `POST /api/search/range`

**Compare Engine:**
- Purpose: Build side-by-side tutor schedules, detect conflicts, find shared free slots, resolve per-session modality
- Location: `src/lib/search/compare.ts`
- Contains:
  - `buildCompareTutor(group, weekdays?, dateRange?)` — filters `sessionBlocks` to `[dateRange.start, dateRange.end)` + weekday, computes `weeklyHoursBooked`/`studentCount`, applies **weekday fallback** for days with no data in the range (pulls nearest future occurrence, deduped by `recurrenceId`)
  - `detectConflicts(compareTutors, indexedGroups)` — case-insensitive `studentName` overlap across different tutor indices, deduped by `studentName|weekday|min(i)|max(j)`
  - `findSharedFreeSlots(groups, weekdays, dateRange?)` — subtracts blocking sessions from availability windows per tutor, sweep-line intersects across tutors, emits intervals ≥ 30 minutes
  - `resolveSessionModality(group, session)` — confidence rubric: paired group + sessionType agrees with `isOnlineVariant` = `high`; paired with missing sessionType = `low` (inferred); single-record = `high`; contradictions = `unknown`/`low` with `conflict_model` metadata
  - `detectSessionModalityConflict(input)` — sync-time variant that doesn't require an `IndexedTutorGroup`
- Depends on: `@/lib/search/index` types only
- Used by: `POST /api/compare`, `POST /api/compare/discover`, sync orchestrator

**API Routes:**
- Purpose: HTTP endpoints consumed by the frontend + Vercel cron
- Location: `src/app/api/`
- Route map:
  - `src/app/api/search/route.ts` — legacy slot-based search (`POST`)
  - `src/app/api/search/range/route.ts` — time-window + duration → availability grid with sub-slots + blocking session details (`POST`)
  - `src/app/api/compare/route.ts` — 1–3 tutors, week-scoped, accepts `weekStart` and `fetchOnly` (incremental serialization — conflicts/free-slots always use the full set) (`POST`)
  - `src/app/api/compare/discover/route.ts` — candidate tutor discovery with pre-computed conflict counts against existing selection (`POST`)
  - `src/app/api/tutors/route.ts` — all tutor names/IDs/modes/subjects (`GET`)
  - `src/app/api/filters/route.ts` — distinct subjects/curriculums/levels (`GET`)
  - `src/app/api/data-health/route.ts` — sync status, issue counts, unresolved aliases/modality/tags (`GET`)
  - `src/app/api/internal/sync-wise/route.ts` — CRON_SECRET-guarded full sync, `maxDuration = 300` (`GET`+`POST`, both route to shared `handleSync`)
  - `src/app/api/auth/[...nextauth]/route.ts` — Auth.js handlers (`GET`+`POST`)
- Depends on: Auth (`@/lib/auth`), `getDb()`, `ensureIndex()`, search/compare engines
- Used by: Frontend client components via `fetch()`; `api/internal/*` by Vercel cron

**Frontend — Server Components:**
- Purpose: Server-side data fetching for initial page load
- Location: `src/app/` (page.tsx files without `"use client"`)
- Contains: `src/app/page.tsx` (redirects to `/search`), `src/app/(app)/search/page.tsx` (awaits `getFilterOptions()` + `getTutorList()`, renders `<SearchWorkspace>`), `src/app/layout.tsx` (root html + Inter/JetBrains Mono fonts), `src/app/(app)/layout.tsx` (renders `<AppNav>` + main container)
- Depends on: `src/lib/data/filters.ts` + `src/lib/data/tutors.ts` (both `"use cache"` tagged `"snapshot"`)
- Used by: Next.js routing

**Frontend — Client Components:**
- Purpose: Interactive admin UI
- Location: `src/components/` organized by feature + `src/app/(app)/` client pages
- Key modules:
  - `src/components/search/search-workspace.tsx` — orchestrator client component; owns `RangeSearchResponse`, `SearchContext`, drawer state, `?tutors=`/`?week=` URL sync, ArrowLeft/ArrowRight week shortcuts, Esc-exits-fullscreen
  - `src/components/search/search-form.tsx` — 3-column form, idiot-proof defaults
  - `src/components/search/recommended-slots.tsx` — derives top 3 sub-slots via `getRecommendedSlots` (`src/lib/search/recommend.ts`)
  - `src/components/search/copy-for-parent-drawer.tsx` — Friendly/Terse tone toggle + clipboard copy
  - `src/components/compare/compare-panel.tsx` — drives `useCompare()` hook, lazy-loads `WeekOverview`/`CalendarGrid`/`DiscoveryPanel` via `next/dynamic`
  - `src/components/compare/week-overview.tsx` — GCal-style 7AM–9PM grid, `HOUR_HEIGHT=48`, `DISPLAY_DAYS=[1,2,3,4,5,6,0]`, sub-column cap (3 single / 2 multi) with "+N more"
  - `src/components/compare/week-calendar.tsx` — month-grid date picker popover
  - `src/components/compare/tutor-combobox.tsx` — shadcn `Command`+`Popover` searchable picker
  - `src/components/compare/discovery-panel.tsx` — shadcn `Dialog` with advanced filters
  - `src/components/compare/session-colors.ts` — shared RGBA helpers + `TUTOR_COLORS`
  - `src/components/compare/modality-display.ts` — modality chip renderer
  - `src/components/layout/app-nav.tsx` — persistent nav bar with active link indicator
  - `src/components/ui/*` — shadcn primitives wrapped over `@base-ui/react` + `cmdk`
  - `src/components/skeletons/*` — `CalendarSkeleton`, `FormSkeleton`, `SearchSkeleton` for suspense fallbacks
- Depends on: API routes (via `fetch`), `src/hooks/use-compare.ts`, shared types from `@/lib/search/types`
- Used by: End users (admin staff)

## Data Flow

**Sync flow (write path):**

1. Vercel cron (`vercel.json` schedule `0 0 * * *`) → `GET /api/internal/sync-wise` with `Authorization: Bearer $CRON_SECRET`.
2. `runFullSync()` in `src/lib/sync/orchestrator.ts`:
   - Insert `sync_runs` (status `running`) and a new `snapshots` row with `active = false`.
   - `fetchAllTeachers()` → `resolveIdentities()` (loads `tutor_aliases`) → persist `tutor_identity_groups` + `tutor_identity_group_members`.
   - For each teacher: `fetchTeacherFullAvailability()` + normalize working hours/leaves/tags → buffer rows.
   - `fetchAllFutureSessions()` across 180-day window → `normalizeSessions()` + `detectSessionModalityConflict()` per session.
   - `deriveModality()` per group → update `supportedModality`.
   - Chunked (250-row) inserts in parallel for availability/leaves/tags/qualifications/sessions/tutors, then `data_issues`.
   - Write `snapshot_stats`.
   - If `unresolvedRatio < 0.5` → atomic promote (`UPDATE snapshots SET active=false WHERE active=true AND id!=$new; UPDATE snapshots SET active=true WHERE id=$new`).
   - Update `sync_runs` status.
3. Route handler calls `revalidateTag("snapshot", { expire: 0 })`; next request to a `"use cache"` helper refetches.

**Read flow (search):**

1. Browser `POST /api/search/range` (from `SearchWorkspace`).
2. `auth()` gate → Zod `.safeParse()`.
3. `ensureIndex(db)` — if cached singleton matches the current active `snapshotId`, reuse; otherwise deduped `buildIndex()` (loads all 6 snapshot tables in parallel).
4. `generateSubSlots()` → synthetic `SearchSlot[]` → `executeSearch()` per slot → decorate blocked cells with `getBlockingSessions()`.
5. `RangeSearchResponse` returned; client renders `<SearchResults>` (availability grid) + `<RecommendedSlots>` (top 3 sub-slots via `getRecommendedSlots`).

**Read flow (compare):**

1. Tutor selection triggers `useCompare().fetchCompare(ids, weekStart, { fetchOnly })`.
2. `POST /api/compare` with `{ tutorGroupIds, mode: "recurring", weekStart, fetchOnly }`.
3. Server computes Monday-to-Sunday `DateRange`, builds `CompareTutor[]` for **all** selected IDs (conflicts/free-slots need the full set), then filters serialized `tutors` to `fetchOnly`.
4. Client merges response tutors into `tutorCache: Map<"${id}:${week}:${CACHE_VERSION}", CompareTutor>`; if `data.snapshotMeta.snapshotId !== lastSnapshotId`, clears cache and retries once (`_retried` flag prevents infinite recursion).
5. Adding a tutor → `fetchOnly: [newId]`; removing → `fetchOnly: []` (server still recomputes conflicts/free-slots, client reuses cached tutors); week change → cache clear + full fetch.

**State Management:**
- **Server state:** `globalThis.__bgscheduler_searchIndex` (searchable) + `globalThis.__bgscheduler_db` (Drizzle client) — both HMR-safe singletons.
- **Client state:** React `useState`/`useCallback`/`useRef` in `useCompare()` (`src/hooks/use-compare.ts`) + `SearchWorkspace`. `AbortController` per `fetchCompare` invocation via `abortRef`. `compareRef` guards mount-effect stale closures.
- **Persistent client state:** Recent searches in `localStorage` (last 10, helper in `src/components/search/recent-searches.tsx`).
- **URL state:** `?tutors=id1,id2,id3` and `?week=YYYY-MM-DD` on `/search`, written via `history.replaceState` (non-navigating).
- **Server-cached:** `"use cache"` + `cacheTag("snapshot")` + `cacheLife("hours")` on `getFilterOptions()` and `getTutorList()`.

## Key Abstractions

**Snapshot:**
- Purpose: Versioned point-in-time capture of all tutor data
- Examples: `src/lib/db/schema.ts` (`snapshots` table + `snapshotId` FK on every data table), `src/lib/sync/orchestrator.ts` (creation/promotion)
- Pattern: Exactly one row has `active = true`. Promotion runs as two serialized `UPDATE`s against the `active` column. All reads filter `WHERE snapshot_id = activeSnapshot.id`.

**SearchIndex / IndexedTutorGroup:**
- Purpose: Denormalized in-memory aggregate of one snapshot
- Examples: `src/lib/search/index.ts` (`SearchIndex` interface lines 67–72, `IndexedTutorGroup` lines 55–65)
- Pattern: Loaded once per active snapshot; O(1) weekday lookup via `byWeekday: Map<number, IndexedTutorGroup[]>`. All query paths consume indexed shapes (not DB rows).

**IdentityGroup:**
- Purpose: Logical grouping of multiple Wise teacher records that represent the same real person (online + onsite variants, nickname variants)
- Examples: `src/lib/normalization/identity.ts` (`IdentityGroup` interface), `src/lib/db/schema.ts` (`tutorIdentityGroups` + `tutorIdentityGroupMembers` tables)
- Pattern: 5-step cascade resolution keyed on `canonicalKey`. Unresolved → `data_issue` of type `alias`, tutor routes to Needs Review.

**WiseClient:**
- Purpose: Rate-limited, retry-capable HTTP client for the Wise API
- Examples: `src/lib/wise/client.ts` (class definition), `createWiseClient()` factory
- Pattern: Queue-based concurrency limiter (default `maxConcurrency = 5`, `15` for sync), exponential backoff `1s/2s/4s` with `maxRetries = 3`. Headers: Basic Auth of `userId:apiKey` + `x-api-key` + `x-wise-namespace` + `user-agent: VendorIntegrations/{namespace}`.

**CompareTutor / Conflict / SharedFreeSlot:**
- Purpose: Wire-format types for the compare workspace, week-scoped
- Examples: `src/lib/search/types.ts` (definitions), `src/lib/search/compare.ts` (producers), `src/hooks/use-compare.ts` (client consumer)
- Pattern: All session times stored as both `startMinute`/`endMinute` (for math) and `"HH:mm"` strings (for display). `modalityConfidence` drives UI styling (per MOD-01 rubric).

**RecommendedSlot:**
- Purpose: Client-side derived view model for the recommended-slots hero
- Examples: `src/lib/search/recommend.ts`
- Pattern: Ranks `subSlots` by count of fully-available qualified tutors; tiered by `"Best fit" | "Strong fit" | "Good fit"`; returns up to 3.

## Entry Points

**Root Page:**
- Location: `src/app/page.tsx`
- Triggers: User navigates to `/`
- Responsibilities: `redirect("/search")`

**Search Workspace (primary UI):**
- Location: `src/app/(app)/search/page.tsx`
- Triggers: User navigates to `/search`
- Responsibilities: Server component — resolves `filterOptions` + `tutorList` via cached helpers → renders `<SearchWorkspace>` in `<Suspense fallback={<SearchSkeleton />}>`. Side-by-side layout: search (left 50%) + compare (right 50%).

**Compare Redirect (backward compat):**
- Location: `src/app/(app)/compare/page.tsx`
- Triggers: `/compare?tutors=...` (bookmarked URLs)
- Responsibilities: Client component that `router.replace()`s to `/search`, preserving the `?tutors=` param.

**Data Health Dashboard:**
- Location: `src/app/(app)/data-health/page.tsx`
- Triggers: User navigates to `/data-health`
- Responsibilities: Client component that `fetch`es `/api/data-health`; renders sync status, snapshot stats, issues by type, unresolved aliases/modality/tags tables, recent sync history.

**Login:**
- Location: `src/app/login/page.tsx`
- Triggers: Redirect from middleware when unauthenticated
- Responsibilities: Google sign-in via `next-auth/react`'s `signIn("google", { callbackUrl })`. Renders access-denied error when email is not on the allowlist.

**Sync Endpoint:**
- Location: `src/app/api/internal/sync-wise/route.ts`
- Triggers: Vercel cron (`0 0 * * *`, configured in `vercel.json`) or manual `curl -X POST` with `Authorization: Bearer $CRON_SECRET`
- Responsibilities: Validate secret → `runFullSync()` → `revalidateTag("snapshot")` on success. `maxDuration = 300`.

**Auth Handlers:**
- Location: `src/app/api/auth/[...nextauth]/route.ts`
- Triggers: Auth.js redirects
- Responsibilities: Re-exports `{ GET, POST }` from `src/lib/auth.ts` (`NextAuth({ providers: [Google], pages, callbacks })`).

**Middleware Auth Gate:**
- Location: `src/middleware.ts`
- Triggers: Every request (matcher excludes `_next/static`, `_next/image`, `favicon.ico`)
- Responsibilities: Allowlist `/login`, `/api/auth/*`, `/api/internal/*` without auth. Otherwise require session; redirect unauthenticated users to `/login?callbackUrl={pathname}`.

## Error Handling

**Sync errors:**
- Per-teacher fetch errors are caught and pushed as `data_issues` of type `completeness` (severity `high`) without aborting the sync (`src/lib/sync/orchestrator.ts` lines 239–249).
- Top-level sync errors mark the `sync_runs` row as `failed` and preserve the previous `active = true` snapshot (no promotion branch reached).
- Completeness gate: if `unresolvedRatio >= 0.5`, the candidate snapshot is kept on disk but never promoted.

**API route errors:**
- All handlers wrap logic in `try`/`catch` and return `{ error: string }` with HTTP status.
- Status convention:
  - `401` — no session (`!session` check after `auth()`)
  - `400` — malformed JSON or Zod `.safeParse()` failure (body: `{ error, details: parsed.error.flatten() }`)
  - `404` — `POST /api/compare` when no requested `tutorGroupId` exists in the active snapshot
  - `500` — caught exception; body: `{ error: err instanceof Error ? err.message : "<op> failed" }`

**Search index staleness:**
- `ensureIndex()` (`src/lib/search/index.ts` lines 272–296) re-queries the active snapshot ID on every call; if it differs from the cached `snapshotId`, a single in-flight rebuild `Promise` is shared across concurrent callers.
- Stale age flagged in response: `snapshotMeta.stale = Date.now() - index.builtAt.getTime() > 35 * 60 * 1000` (35 minutes) and a warning is pushed to `warnings[]`.

**Client-side race handling:**
- `useCompare()` (`src/hooks/use-compare.ts`) stores an `AbortController` in `abortRef` and aborts the previous fetch before issuing a new one.
- `DOMException` with `name === "AbortError"` is swallowed silently.
- On snapshot-ID mismatch mid-fetch: clears `tutorCache` and retries once (guarded by `_retried` flag to prevent infinite recursion); second mismatch surfaces `"Snapshot changed during fetch. Please retry."`.

**Data integrity (fail-closed):**
- Unresolved identity/modality/qualification → `Needs Review`, never `Available` (`src/lib/search/engine.ts` lines 83–93).
- Cancelled sessions explicitly `isBlocking = false`; unknown statuses default to `isBlocking = true` (`src/lib/normalization/sessions.ts`).
- Modality contradiction between teacher-record `isOnlineVariant` and session `sessionType` → `modality: "unknown"`, `confidence: "low"`, + `conflict_model` data_issue (`src/lib/search/compare.ts` — `resolveSessionModality`, `detectSessionModalityConflict`).

**Env validation:**
- Missing env vars → throw at startup via Zod in `src/lib/env.ts` (`getEnv()` evaluated at module load).

## Cross-Cutting Concerns

**Authentication:**
- Auth.js v5 beta (`next-auth ^5.0.0-beta.30`) with Google provider; email allowlisting against `admin_users` in `signIn` callback (`src/lib/auth.ts`).
- Middleware gate: `src/middleware.ts` exports `auth` as middleware; all routes except `/login`, `/api/auth/*`, `/api/internal/*` require `req.auth`.
- API route gate: every non-internal handler calls `await auth()` and returns 401 if `!session`.

**Validation:**
- Zod schemas at API route boundaries, module-scoped `const`, `.safeParse()` pattern (never `.parse()`).
- Env-level validation centralized in `src/lib/env.ts`.

**Timezone:**
- All business times locked to `Asia/Bangkok` via `src/lib/normalization/timezone.ts`. Minutes since midnight is the canonical time unit. Weeks start Monday (helpers `getCurrentMonday`, `shiftWeek`, `getMondayForDate` in `src/hooks/use-compare.ts` and `src/app/api/compare/route.ts`).

**Caching:**
- Server-cached RSC helpers with `"use cache"` + `cacheTag("snapshot")` + `cacheLife("hours")` (`src/lib/data/filters.ts`, `src/lib/data/tutors.ts`); invalidated via `revalidateTag("snapshot", { expire: 0 })` after successful sync promote.
- In-memory index with stale detection (`src/lib/search/index.ts`).
- Client tutor cache keyed by `${tutorGroupId}:${weekStart}:${CACHE_VERSION}` (`src/lib/search/cache-version.ts` = `"v1"`). Bump `CACHE_VERSION` whenever `CompareTutor` shape changes.

**Logging:**
- `console.error()` on Zod failures and caught exceptions.
- No request-logging middleware; Vercel platform logs cover HTTP.

**Performance:**
- Single in-memory index eliminates DB round-trips on the query path.
- Parallel `Promise.all` over 6 tables in `buildIndex()`.
- Chunked (250-row) inserts in `insertInChunks()` during sync.
- Lazy dynamic imports for heavy compare components (`WeekOverview`, `CalendarGrid`, `DiscoveryPanel`) via `next/dynamic` in `src/components/compare/compare-panel.tsx`.
- Incremental `fetchOnly` on `/api/compare` avoids re-serializing already-cached tutors.

---

*Architecture analysis: 2026-04-21*
