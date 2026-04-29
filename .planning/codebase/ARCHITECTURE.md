# Architecture

**Analysis Date:** 2026-04-29

## Pattern Overview

**Overall:** Snapshot-versioned ETL + in-memory query index.

The system fetches tutor data from the Wise scheduling platform, normalizes it through six domain-specific modules, persists it to Postgres tables keyed by an immutable `snapshot_id`, and serves search/compare queries from a singleton in-memory index loaded from the active snapshot. Reads never touch the DB after the index is warm.

**Key Characteristics:**
- **Snapshot-based persistence** — every write is scoped to a `snapshot_id`. Atomic flag-flip promotes a candidate snapshot to `active = true` after successful sync. Failed syncs preserve the prior active snapshot. Definition: `src/lib/db/schema.ts:47-51`. Promotion: `src/lib/sync/orchestrator.ts:469-484`.
- **Single in-memory index** — entire active snapshot loaded into a `globalThis`-anchored singleton (`__bgscheduler_searchIndex`) once, then queried in-process for all `/api/search`, `/api/compare`, `/api/filters`, `/api/tutors` requests. `src/lib/search/index.ts:81-86`.
- **ETL orchestrator pattern** — single `runFullSync()` function in `src/lib/sync/orchestrator.ts:45-539` performs fetch -> normalize -> persist -> validate -> promote sequentially.
- **Fail-closed safety** — unresolved identity, modality, or qualification routes tutors to "Needs Review", never to "Available". `src/lib/search/engine.ts:78-96`.
- **App Router server-first** — Next.js 16 server components fetch via cached server functions (`src/lib/data/*.ts`) using the `"use cache"` directive; client components hydrate from props.
- **Per-request cache invalidation by tag** — sync success calls `revalidateTag("snapshot")` to invalidate cached server functions. `src/app/api/internal/sync-wise/route.ts:26`.

## Layers

**Wise API client:**
- Purpose: HTTP communication with the Wise scheduling platform (api.wiseapp.live)
- Location: `src/lib/wise/`
- Contains: `client.ts` (HTTP client with retry/backoff/concurrency), `fetchers.ts` (domain fetchers for teachers, availability, sessions), `types.ts` (Wise API response shapes + accessor helpers `getWiseTeacherDisplayName`/`getWiseTeacherUserId`/`getWiseTagName`)
- Depends on: Nothing internal — pure HTTP plus env vars (`WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE`)
- Used by: Sync orchestrator only
- Key behaviors: queue-based concurrency limiter (max 5 default, 15 in production sync via `createWiseClient()`), exponential backoff (1s/2s/4s, 3 retries), Basic Auth + `x-api-key` + `x-wise-namespace` headers

**Normalization (domain layer):**
- Purpose: Transform raw Wise API data into canonical internal representations. All times anchored to Asia/Bangkok.
- Location: `src/lib/normalization/`
- Contains:
  - `identity.ts` — 5-step cascade: nickname extraction (`extractNickname`) -> alias table lookup -> online/offline pair detection (`isOnlineVariant`/`getBaseName`) -> unresolved -> data_issue. Returns `{ groups, issues }`.
  - `availability.ts` — `normalizeWorkingHours` converts Wise `workingHours.slots` into `{ weekday, startMinute, endMinute }` windows with overlap merge and de-duplication.
  - `leaves.ts` — `normalizeLeaves` converts Wise leaves from UTC to Asia/Bangkok and merges overlaps.
  - `sessions.ts` — `normalizeSessions` classifies blocking status. CANCELLED/CANCELED is non-blocking. Unknown status is blocking (fail-closed).
  - `qualifications.ts` — `normalizeTeacherTags` parses Wise tags via regex into `{ subject, curriculum, level, examPrep }`. Unmapped tags emit `tag` data_issues.
  - `modality.ts` — `deriveModality` returns one of `online`/`onsite`/`both`/`unresolved` from pair structure -> session type evidence -> location -> unresolved. Never guesses.
  - `timezone.ts` — `toLocalTime`, `getLocalWeekday`, `getLocalMinuteOfDay`, `parseTimeToMinutes`. `TIMEZONE = "Asia/Bangkok"`.
- Depends on: Wise types only
- Used by: Sync orchestrator + a small leak into `compare.ts` (uses `toZonedTime` + `parseTimeToMinutes`)

**Sync orchestrator:**
- Purpose: Full ETL pipeline — fetch, normalize, persist, validate, promote
- Location: `src/lib/sync/`
- Contains:
  - `orchestrator.ts:45-539` — `runFullSync()` is the single entry point. 12 numbered steps: create sync run -> create candidate snapshot -> fetch teachers -> load aliases -> resolve identities -> persist groups + members -> per-teacher fetch availability/leaves/tags + normalize qualifications -> fetch + normalize future sessions -> derive modality + emit per-session contradiction issues -> run past-sessions diff-hook -> bulk insert (parallel) availability/leaves/tags/quals/sessions/tutors -> store data_issues -> store snapshot_stats -> validate (fail if >50% unresolved identity) -> atomic promotion.
  - `past-sessions-diff-hook.ts:1-50` — `runPastSessionsDiffHook()` captures sessions that were FUTURE in the prior snapshot but have dropped out of Wise's response and now lie in the past. Writes to cross-snapshot `past_session_blocks` table. Idempotent via `UNIQUE(wise_session_id) ON CONFLICT DO NOTHING`. Must run BEFORE atomic promotion.
- Depends on: Wise client, all normalization modules, DB layer
- Used by: `POST/GET /api/internal/sync-wise` route handler only

**Database (persistence):**
- Purpose: Postgres connection and Drizzle ORM schema definition
- Location: `src/lib/db/`
- Contains:
  - `index.ts:1-29` — `getDb()` returns a `globalThis`-anchored Drizzle client (`__bgscheduler_db`). HTTP-mode Neon serverless driver.
  - `schema.ts:1-299` — 14 Drizzle table definitions plus 4 `pgEnum`s (`syncStatusEnum`, `dataIssueTypeEnum`, `dataIssueSeverityEnum`, `modalityEnum`).
  - `seed.ts` — Seeds 4 tutor aliases (Kev->Kevin, Paoju->Paojuu, Poi->Nacha (Poi), Sam->Samantha) and admin emails from `SEED_ADMIN_EMAILS` env var.
- Depends on: `@neondatabase/serverless`, `drizzle-orm`
- Used by: All server-side code

**Search index (denormalized in-memory):**
- Purpose: In-memory data structure for sub-400ms warm queries
- Location: `src/lib/search/index.ts`
- Contains:
  - `globalThis.__bgscheduler_searchIndex: SearchIndex | null` — singleton.
  - `globalThis.__bgscheduler_searchIndexBuildPromise` — concurrent-build deduplication.
  - `buildIndex(db)` — loads all 6 snapshot-scoped tables in parallel (`tutorIdentityGroupMembers`, `subjectLevelQualifications`, `recurringAvailabilityWindows`, `datedLeaves`, `futureSessionBlocks`, `dataIssues`), groups by `groupId`, and constructs `IndexedTutorGroup[]` + `byWeekday: Map<number, IndexedTutorGroup[]>`.
  - `ensureIndex(db)` — staleness check: compares `cached.snapshotId` against the DB's current `active` snapshot. Rebuilds via build-promise singleton if changed.
  - Indexed types: `IndexedTutorGroup`, `IndexedQualification`, `IndexedWiseRecord`, `IndexedAvailabilityWindow`, `IndexedLeave`, `IndexedSessionBlock`, `IndexedDataIssue`.
- Depends on: DB layer
- Used by: Search engine, compare engine, all read API routes, server cached functions in `src/lib/data/`

**Search engine:**
- Purpose: Execute availability searches against the in-memory index
- Location: `src/lib/search/engine.ts`
- Contains:
  - `executeSearch(index, request)` (`engine.ts:21-57`) — slot-based search. Supports `recurring` and `one_time` modes. Computes per-slot results plus multi-slot intersection.
  - `searchSlot(index, slot, mode, filters)` (`engine.ts:59+`) — checks data_issues, modality, availability windows, blocking sessions, leaves, qualifications. Routes unresolved tutors to `needsReview`.
  - `getBlockingSessions()` — used by range search to enrich blocked grid cells with session details.
- Depends on: Search index, normalization/timezone
- Used by: `POST /api/search` (legacy), `POST /api/search/range` (range grid)

**Compare engine:**
- Purpose: Build side-by-side tutor schedules, detect conflicts, find shared free slots
- Location: `src/lib/search/compare.ts`
- Contains:
  - `buildCompareTutor(group, weekdays?, dateRange?, pastBlocks?)` — date-range filtered schedule assembly with weekday fallback for past days lacking session data. Per-session modality resolution via `resolveSessionModality()` (`compare.ts:97-150+`).
  - `detectConflicts(allCompareTutors, indexedGroups)` — same-student overlap detection across selected tutors (case-insensitive name match, deduped by student+day+tutor pair).
  - `findSharedFreeSlots(groups, weekdays, dateRange)` — interval intersection across tutors with 30-minute minimum threshold.
  - `detectSessionModalityConflict()` — used by sync orchestrator to emit `conflict_model` data_issues.
  - `getStartOfTodayBkk(now?)` — Asia/Bangkok start-of-today helper for historical-range detection.
  - `computeDateForWeekdayInRange(weekday, dateRange)` — mirrors client `getWeekDate` to avoid off-by-one drift.
- Depends on: Search index types only
- Used by: `POST /api/compare`, `POST /api/compare/discover`, sync orchestrator (for conflict detection)

**API routes:**
- Purpose: HTTP endpoints consumed by the frontend
- Location: `src/app/api/`
- Contains: Next.js App Router route handlers (`route.ts`)
- Auth: `auth()` from `src/lib/auth.ts` first; return 401 if unauthorized. `/api/internal/*` is exempt and uses `CRON_SECRET` instead.
- Validation: All POST routes use Zod `.safeParse()` against an inline `const xxxSchema = z.object(...)` defined at module scope.
- Endpoints:
  - `POST /api/search` — `src/app/api/search/route.ts:1-62` — slot-based search.
  - `POST /api/search/range` — `src/app/api/search/range/route.ts:1-201` — range search with sub-slot grid.
  - `GET /api/filters` — distinct subjects/curriculums/levels.
  - `GET /api/tutors` — all tutor names/ids/modes/subjects.
  - `POST /api/compare` — `src/app/api/compare/route.ts:53-187` — multi-tutor compare with `weekStart` + `fetchOnly` incremental fetch.
  - `POST /api/compare/discover` — candidate tutors filtered by qualifications/mode/time with conflict pre-computation.
  - `GET /api/data-health` — sync status + issue counts.
  - `GET/POST /api/internal/sync-wise` — `src/app/api/internal/sync-wise/route.ts:7` — `maxDuration = 300` (5 min). Both methods call shared `handleSync()`.
  - `GET/POST /api/auth/[...nextauth]` — Auth.js handlers.

**Server data layer (cached functions):**
- Purpose: Server-only cached read helpers consumed by Next.js Server Components
- Location: `src/lib/data/`
- Contains:
  - `filters.ts` — `getFilterOptions()` with `"use cache"` + `cacheTag("snapshot")` + `cacheLife("hours")`
  - `tutors.ts` — `getTutorList()` with same cache discipline
  - `past-sessions.ts` — `fetchPastSessionBlocks(canonicalKeys, rangeStart, rangeEnd)` with `cacheTag("past-sessions")` + `cacheLife("days")`. EXPLICITLY separate from `"snapshot"` tag because past data is immutable (D-03 first-observation wins). Uncached variant `fetchPastSessionBlocksUncached` exported for Vitest.
- Used by: Server components in `src/app/(app)/search/page.tsx`, `/api/compare` route

**Frontend:**
- Purpose: Admin UI for searching and comparing tutor availability
- Location: `src/app/(app)/` (pages with route group), `src/components/` (reusable components)
- Pages:
  - `/search` (`src/app/(app)/search/page.tsx`) — async Server Component fetches `getFilterOptions()` + `getTutorList()` then renders `<SearchWorkspace>` inside `<Suspense fallback={<SearchSkeleton />}>`.
  - `/compare` (`src/app/(app)/compare/page.tsx`) — client redirect to `/search` (preserves `?tutors=` param).
  - `/data-health` — client-rendered admin dashboard.
  - `/login` — Google sign-in.
- Layouts:
  - `src/app/layout.tsx` — root: `<html lang="en">` with Inter + JetBrains Mono fonts, body `flex flex-col overflow-hidden`.
  - `src/app/(app)/layout.tsx` — wraps app routes with `<AppNav />` + `<main>`.
- Component organization:
  - `src/components/ui/` — shadcn/ui primitives wrapping `@base-ui/react` (button, card, popover, dialog, command, table, tabs, etc.)
  - `src/components/compare/` — calendar grid, week overview, week calendar (date picker), tutor combobox, discovery panel, session-colors
  - `src/components/search/` — search form, availability grid, results, recent searches, recommended slots, copy-for-parent drawer
  - `src/components/layout/` — `AppNav`
  - `src/components/skeletons/` — loading skeletons (calendar, form, search)
- Hooks:
  - `src/hooks/use-compare.ts:75-227` — `useCompare()` owns compare state: `tutorCache: useRef(new Map<string, CompareTutor>())` keyed by `${tutorGroupId}:${weekStart}:${CACHE_VERSION}`, `abortRef` for in-flight cancellation, `lastSnapshotId.current` for cache invalidation.

## Data Flow

**Sync flow (orchestrator pipeline):**
1. Vercel cron `GET /api/internal/sync-wise` (or manual `curl -X POST` with `Bearer $CRON_SECRET`).
2. `handleSync()` calls `runFullSync(db, client, instituteId)`.
3. Orchestrator inserts `sync_runs` row (status=running) and `snapshots` row (active=false).
4. `fetchAllTeachers` -> `resolveIdentities` (with aliases from DB) -> persist `tutor_identity_groups` + `tutor_identity_group_members`.
5. Per teacher (parallel up to concurrency=15): `fetchTeacherFullAvailability` (1 working-hours window + 25 leave windows over 180-day horizon). Normalize and queue rows for: `recurring_availability_windows`, `dated_leaves`, `raw_teacher_tags`, `subject_level_qualifications`. Per-teacher errors emit `completeness` data_issues but don't abort.
6. `fetchAllFutureSessions` (paginated) -> `normalizeSessions` -> queue `future_session_blocks` rows.
7. Per group: `deriveModality(group, groupSessions)` updates `tutorIdentityGroups.supportedModality`. Records each teacher's modality.
8. MOD-01 contradiction loop: per session, run `detectSessionModalityConflict` and emit `conflict_model` data_issues.
9. PAST-01 diff-hook: capture dropped-future-now-past sessions into `past_session_blocks` (cross-snapshot table).
10. `Promise.all` bulk inserts in 250-row chunks: availability + leaves + tags + qualifications + sessions + tutors.
11. Insert all `data_issues` and `snapshot_stats`.
12. If unresolved-identity ratio < 50%, atomic promotion: `UPDATE snapshots SET active=false WHERE active=true AND id != snapshotId; UPDATE snapshots SET active=true WHERE id = snapshotId`. Update sync_run with `status=success`.
13. On success, `revalidateTag("snapshot")` invalidates cached server functions.

**Search flow (range):**
1. Client posts `{ searchMode, dayOfWeek/date, startTime, endTime, durationMinutes, mode, filters }` to `/api/search/range`.
2. Route validates with Zod, calls `auth()`.
3. `getDb()` -> `ensureIndex(db)` returns warm singleton (rebuilds if snapshot changed).
4. Generate sub-slots (e.g. 15:00-20:00 with 90-min duration -> 15:00-16:30, 16:30-18:00, 18:00-19:30).
5. Build synthetic `SearchRequest` with all sub-slots, call `executeSearch(index, request)`.
6. Reshape per-slot results into `RangeGridRow[]` with `availability: (true | BlockingSessionInfo[])[]`.
7. For non-available cells, `getBlockingSessions(group, mode, weekday, slotStart, slotEnd, date?)` enriches the cell.
8. Sort grid by available-slot count descending, return.

**Compare flow (incremental fetch):**
1. Client `useCompare.addTutor(id, name)` updates state and calls `fetchCompare(allIds, weekStart, { fetchOnly: [newId] })`.
2. POST `/api/compare` with `{ tutorGroupIds, mode, weekStart?, fetchOnly? }`.
3. Server resolves week range (`weekStart` or current Monday in BKK), `ensureIndex`, finds `IndexedTutorGroup` for each id.
4. If `dateRange.start < startOfTodayBkk`, fetch `pastSessionBlocks` keyed by `canonicalKey` (cached, separate tag).
5. Build all `CompareTutor[]` (always, for full conflict/free-slot detection), then merge past blocks for `findSharedFreeSlots` group clones.
6. Detect conflicts on full set; serialize only `fetchOnly` subset in response.
7. Client merges into `tutorCache: Map<"id:week:CACHE_VERSION", CompareTutor>`. Builds final `mergedTutors` from cache for all selected ids.
8. If server `snapshotMeta.snapshotId !== lastSnapshotId.current`, clear cache and retry once.

**Auth flow:**
1. Every non-asset request hits `src/middleware.ts:1-28`.
2. Middleware calls `auth()` (Auth.js v5 wrapper). Allows `/login`, `/api/auth/*`, `/api/internal/*` without auth.
3. Unauthenticated users redirected to `/login?callbackUrl={original}`.
4. `/login` calls `signIn("google", { callbackUrl })` from `next-auth/react`.
5. Auth.js `signIn` callback (`src/lib/auth.ts:18-30`) checks `admin_users` table; rejects if email not in allowlist.

**State management:**
- **Server state**: `globalThis`-anchored singletons survive HMR in dev — `__bgscheduler_db`, `__bgscheduler_searchIndex`, `__bgscheduler_searchIndexBuildPromise`.
- **Client state (compare)**: React `useState` + `useRef` in `src/hooks/use-compare.ts`. `tutorCache: useRef(new Map<string, CompareTutor>())`. `abortRef: useRef<AbortController | null>` for race-condition safety.
- **Client persistent**: Recent searches in `localStorage` (last 10) via `src/components/search/recent-searches.tsx`.
- **URL state**: `?tutors=id1,id2&week=2026-04-29` synced via `window.history.replaceState` in `src/components/search/search-workspace.tsx:94-108`.

## Key Abstractions

**Snapshot (versioned data point):**
- Purpose: Immutable point-in-time capture of all tutor data
- Examples: `src/lib/db/schema.ts:47-51` (table), `src/lib/sync/orchestrator.ts:62-67` (creation), `src/lib/sync/orchestrator.ts:469-484` (atomic promotion)
- Pattern: Only one snapshot is `active = true` at a time. All snapshot-scoped data tables FK to `snapshot_id`. The cross-snapshot `past_session_blocks` table is the sole exception — it uses `group_canonical_key` (denormalized) instead.

**IndexedTutorGroup (in-memory aggregate):**
- Purpose: Denormalized read-side representation
- Examples: `src/lib/search/index.ts:55-70`, built in `buildIndex()` `src/lib/search/index.ts:189-253`
- Pattern: Eagerly loaded once with parallel queries, queried thousands of times. The `byWeekday: Map<number, IndexedTutorGroup[]>` map provides O(1) weekday lookup. `canonicalKey` field denormalized from `tutor_identity_groups.canonical_key` to support cross-snapshot past-session lookups without extra DB roundtrip.

**IdentityGroup (5-step cascade resolution):**
- Purpose: Logical merging of multiple Wise teacher records into one real person
- Examples: `src/lib/normalization/identity.ts:7-18` (interface), `src/lib/db/schema.ts:78-100` (`tutor_identity_groups` + `tutor_identity_group_members` tables)
- Pattern: nickname extraction (parenthetical regex) -> alias table override -> online/offline pair detection by base name -> unresolved -> emit `alias` data_issue with severity=critical

**WiseClient (rate-limited HTTP):**
- Purpose: Retry-capable, concurrency-limited Wise API client
- Examples: `src/lib/wise/client.ts:16-114`
- Pattern: Queue-based concurrency limiter (`processQueue` `client.ts:100-113`), exponential backoff (`fetchWithRetry` `client.ts:67-91`), Basic Auth + API key + tenant headers. Factory `createWiseClient()` for production sync (concurrency=15).

**SearchIndex singleton (lazy + stale-detected):**
- Purpose: Global in-process cache for the active snapshot
- Examples: `src/lib/search/index.ts:81-86` (`globalThis` declarations), `ensureIndex()` `src/lib/search/index.ts:281-305`
- Pattern: Lazy initialization on first request; `ensureIndex` rebuilds if cached `snapshotId !== active.id`. Build-promise deduplication prevents thundering-herd on cold start.

**CompareTutor cache (client-side, version-keyed):**
- Purpose: Avoid refetching unchanged tutors when adding/removing in compare view
- Examples: `src/hooks/use-compare.ts:85-87`, `src/lib/search/cache-version.ts:22`
- Pattern: `Map<"tutorGroupId:weekStart:CACHE_VERSION", CompareTutor>`. Adding tutor sends `fetchOnly: [newId]`; removing uses `fetchOnly: []` (server still recomputes conflicts). `CACHE_VERSION = "v2"` (bumped on `CompareTutor` shape change). Snapshot mismatch from server triggers full clear + retry.

## Entry Points

**Root redirect:**
- Location: `src/app/page.tsx:1-5`
- Triggers: User navigates to `/`
- Responsibilities: `redirect("/search")`

**Search workspace (primary UI):**
- Location: `src/app/(app)/search/page.tsx:1-19`
- Triggers: User navigates to `/search`
- Responsibilities: Async Server Component. Fetches `getFilterOptions()` + `getTutorList()` (cached, snapshot-tagged). Renders `<SearchWorkspace>` inside `<Suspense>`. SearchWorkspace owns the side-by-side layout with `useCompare()` hook for the right panel.

**Sync endpoint (cron):**
- Location: `src/app/api/internal/sync-wise/route.ts:1-42`
- Triggers: Vercel cron daily at `0 0 * * *` UTC (defined in `vercel.json:3-7`) via GET; manual `curl -X POST` with `Authorization: Bearer $CRON_SECRET` for ad-hoc runs
- Responsibilities: Both GET and POST call shared `handleSync()`. `maxDuration = 300` for 5-minute timeout. Calls `runFullSync(db, client, instituteId)`. On success, `revalidateTag("snapshot", { expire: 0 })`.

**Auth middleware:**
- Location: `src/middleware.ts:1-28`
- Triggers: Every request (except `_next/static`, `_next/image`, `favicon.ico` per matcher)
- Responsibilities: Allowlist `/login`, `/api/auth/*`, `/api/internal/*`. All other paths require `req.auth`; redirect to `/login?callbackUrl={pathname}` otherwise.

**Auth handlers:**
- Location: `src/app/api/auth/[...nextauth]/route.ts` + `src/lib/auth.ts:1-35`
- Triggers: NextAuth.js routes (signIn/signOut/callback)
- Responsibilities: Google OAuth + admin allowlist check via `admin_users` table.

## Error Handling

**Strategy:** Fail-closed at the data integrity boundary, fail-loud at the API boundary, fail-isolated inside the sync.

**Sync error handling:**
- Per-teacher errors caught and stored as `completeness` data_issues without aborting (`src/lib/sync/orchestrator.ts:241-251`). Mirrored by the per-group MOD-01 loop and the past-sessions diff-hook.
- Top-level sync errors mark `sync_runs.status = "failed"`, store `errorSummary`, and preserve the prior active snapshot (`src/lib/sync/orchestrator.ts:512-538`).
- Promotion gate: if `unresolvedRatio >= 0.5`, the new snapshot is persisted but NOT promoted (`src/lib/sync/orchestrator.ts:462-465`).

**API route error handling (uniform pattern):**
1. `auth()` -> 401 if no session.
2. `await request.json()` in try/catch -> 400 on invalid JSON.
3. `schema.safeParse(body)` -> 400 with `parsed.error.flatten()` on validation failure.
4. Business logic in try/catch -> 500 with `err instanceof Error ? err.message : "..."`.
- Reference: `src/app/api/compare/route.ts:53-72`, `src/app/api/search/route.ts:30-60`.

**Search/Compare data-integrity rules (fail-closed):**
- Unresolved identity, modality, or qualification routes tutors to `needsReview`, never `available` (`src/lib/search/engine.ts:78-96`).
- Cancelled sessions (`CANCELLED`/`CANCELED`) explicitly non-blocking (`src/lib/normalization/sessions.ts`).
- Unknown session statuses are blocking (fail-closed default).
- Stale index detection: `Date.now() - index.builtAt.getTime() > 35 * 60 * 1000` -> push warning + set `snapshotMeta.stale = true`. Reference: `src/lib/search/engine.ts:30-37`.

**Client error handling (compare):**
- AbortController cancels in-flight fetches when user adds/removes tutor (`src/hooks/use-compare.ts:99-102`).
- Snapshot mismatch -> clear cache + retry once with `_retried: true` flag; second mismatch surfaces error (`src/hooks/use-compare.ts:124-135`).
- DOMException AbortError silently ignored.

## Cross-Cutting Concerns

**Authentication:** Auth.js v5 beta with Google provider. Admin allowlist enforced in `src/lib/auth.ts:18-30` via `admin_users` table lookup. Middleware (`src/middleware.ts`) guards all non-public routes.

**Validation:** Zod schemas defined as `const xxxSchema = z.object(...)` at module scope above POST handlers. Always `.safeParse()`, never `.parse()`. Env validation centralized in `src/lib/env.ts:1-26`.

**Logging:** `console.error()` for caught errors. No structured logging or request middleware. Sync orchestrator does not log to console (returns `SyncResult` summary instead).

**Timezone:** All times anchored to `Asia/Bangkok` via `src/lib/normalization/timezone.ts`. Thailand has no DST. Compare-side helper `getStartOfTodayBkk()` (`src/lib/search/compare.ts:36-39`) computes BKK midnight for historical-range detection.

**Caching:**
- Next.js `"use cache"` server functions tagged with `"snapshot"` (revalidated on sync) or `"past-sessions"` (revalidated on schema migration).
- In-memory search index lives in `globalThis` (per server instance). Stale detection on every `ensureIndex` call.
- Client tutor cache version-keyed by `CACHE_VERSION` constant in `src/lib/search/cache-version.ts:22` (current: `"v2"`).

**Z-index discipline:** 3-tier scale defined in `src/lib/ui/z-index.ts:50` — `Z_INDEX = { content: 1, legend: 6, popover: 50 }`. Sticky surfaces use `legend`; portal-hoisted popovers default to `popover`.

**Color tokens:** Semantic tokens in `src/app/globals.css:13-17` — `--available`, `--blocked`, `--conflict`, `--free-slot`, `--today-indicator`. Tutor lane colors in `src/components/compare/session-colors.ts:51` — `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]`.

---

*Architecture analysis: 2026-04-29*
