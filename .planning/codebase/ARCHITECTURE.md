# Architecture

**Analysis Date:** 2026-06-01

## Pattern Overview

**Overall:** Snapshot-versioned ETL + in-memory query index, extended into a multi-subsystem admin platform.

The core bet is unchanged: the Wise scheduling platform (the source of truth) is slow and rate-limited, so it is never queried on the request path. A background sync pipeline pulls all tutor data out of Wise, normalizes it through six domain modules, persists it to Postgres tables keyed by an immutable `snapshot_id`, and serves search/compare reads from a process-global in-memory index loaded from the active snapshot. Reads touch the DB only for the occasional index rebuild and a handful of `"use cache"` lookups.

The codebase has since grown well beyond tutor search. The same Vercel + Next.js + Drizzle + Neon spine now hosts eight additional feature subsystems — sales dashboard, credit control, payroll, leave requests, LINE AI review, classroom assignment, room capacity, and an AI scheduler — each with its own sync/import pipeline and tables, all sharing the auth gate, DB singleton, and Wise client. The repo now spans **78 tables, 110 HTTP route handlers, 7 Vercel crons, 14 in-app pages, and 130 test files**.

**Key Characteristics:**
- **Snapshot-based persistence** — tutor data writes are scoped to a `snapshot_id`. A single atomic `UPDATE` flips a candidate snapshot to `active = true` after a successful sync. Failed syncs preserve the prior active snapshot. Definition: `src/lib/db/schema.ts` (`snapshots`). Promotion: `src/lib/sync/orchestrator.ts:480-501`.
- **Single in-memory index** — the entire active snapshot is loaded once into a `globalThis`-anchored singleton (`__bgscheduler_searchIndex`) and queried in-process for `/api/search`, `/api/search/range`, `/api/compare`, `/api/compare/discover`, `/api/proposals`, and the AI scheduler. `src/lib/search/index.ts:94-105`.
- **ETL orchestrator pattern** — one `runFullSync()` function (`src/lib/sync/orchestrator.ts:50-600`) performs fetch → normalize → persist → validate → promote inside a single try/catch.
- **Fail-closed safety** — unresolved identity, modality, or qualification routes a tutor to "Needs Review", never to "Available". `src/lib/search/engine.ts:60-150`.
- **App Router server-first reads** — server components fetch via cached server functions (`src/lib/data/*.ts`) using `"use cache"` + `cacheTag`/`cacheLife`; client components hydrate from props and call API routes.
- **Per-request cache invalidation by tag** — a successful Wise sync calls `revalidateTag("snapshot", { expire: 0 })` to sweep the snapshot-tagged cached functions. `src/lib/sync/run-wise-sync.ts:160-162`.
- **Subsystem replication of the pattern** — the non-Wise subsystems (credit control, payroll, leave requests, sales dashboard, room utilization) each have their own `*_sync_runs` / `*_import_runs` tables and dedicated cron handlers, reusing the same single-flight + status-row discipline rather than the snapshot/index machinery.

## Layers

The lower layers know nothing about the upper ones: the Wise client has no internal imports, the normalization modules depend only on Wise types, and the orchestrator is the single place that wires fetch + normalize + persist together.

**Wise API client:**
- Purpose: HTTP communication with the Wise scheduling platform (`api.wiseapp.live`)
- Location: `src/lib/wise/`
- Contains: `client.ts` (HTTP client with retry/backoff/concurrency), `fetchers.ts` (domain fetchers for teachers, availability, sessions, plus location/availability-check/session-update and analytics helpers), `types.ts` (Wise response shapes + accessor helpers `getWiseTeacherDisplayName`/`getWiseTeacherUserId`/`getWiseTagName`/`getWiseSessionTeacherUserId`)
- Depends on: Nothing internal — pure HTTP plus env vars (`WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE`)
- Used by: Sync orchestrator, Wise-activity sync, classroom publish writeback, leave-request Wise-cancel preview
- Key behaviors: queue-based concurrency limiter (default 5; `createWiseClient()` raises it to 15 for production sync — `client.ts:159-166`), exponential backoff 1s/2s/4s with 3 retries, and a `RETRYABLE_STATUS_CODES` set `{408,429,500,502,503,504}` so permanent 4xx (401/403/404/422) fail fast (`client.ts:23-30`, `:121-133`). Network-level failures (DNS/ECONNRESET/`fetch` TypeError) are also retried (`client.ts:105-113`). Auth headers: Basic Auth (base64 `userId:apiKey`) + `x-api-key` + `x-wise-namespace` + `user-agent: VendorIntegrations/{namespace}` (`client.ts:52-61`).

**Normalization (domain layer):**
- Purpose: Transform raw Wise API data into canonical internal representations. All times anchored to Asia/Bangkok.
- Location: `src/lib/normalization/`
- Contains:
  - `identity.ts` — `resolveIdentities()` runs the 5-step cascade: nickname extraction (`extractNickname`) → alias table lookup → online/offline pair detection (`isOnlineVariant`/`getBaseName`) → unresolved → `alias` data_issue. Returns `{ groups, issues }`.
  - `availability.ts` — `normalizeWorkingHours` converts Wise `workingHours.slots` into `{ weekday, startMinute, endMinute }` windows with overlap merge and de-duplication.
  - `leaves.ts` — `normalizeLeaves` converts Wise leaves UTC → Asia/Bangkok and merges overlaps.
  - `sessions.ts` — `normalizeSessions` classifies blocking status. CANCELLED/CANCELED is non-blocking; unknown status is blocking (fail-closed).
  - `qualifications.ts` — `normalizeTeacherTags` parses Wise tags via regex into `{ subject, curriculum, level, examPrep }`. Unmapped tags emit `tag` data_issues.
  - `modality.ts` — `deriveModality` returns `online`/`onsite`/`both`/`unresolved` from pair structure → session-type evidence → location → unresolved. Never guesses.
  - `timezone.ts` — `parseTimeToMinutes`, weekday/minute-of-day helpers; `TIMEZONE = "Asia/Bangkok"`.
- Depends on: Wise types only
- Used by: Sync orchestrator; `parseTimeToMinutes` also used by the search engine and compare engine

**Sync orchestrator:**
- Purpose: Full ETL pipeline — fetch, normalize, persist, validate, promote
- Location: `src/lib/sync/`
- Contains:
  - `orchestrator.ts:50-600` — `runFullSync()`, the single entry point. Numbered steps (1–12) map to ETL phases: create/reuse sync run → create candidate snapshot → fetch teachers → load aliases → resolve identities → persist groups + members → per-teacher availability/leaves/tags/qualifications → fetch + normalize future sessions → derive modality + per-group MOD-01 contradiction loop → (9.5) past-sessions diff hook → parallel chunked bulk inserts → store data_issues + snapshot_stats → validate (fail if ≥50% unresolved identity) → atomic promotion → mark sync run success + best-effort snapshot pruning.
  - `run-wise-sync.ts:142-167` — `runWiseSyncRequest()`, the single-flight wrapper. Acquires a guard sync run (`acquireSyncRun`), skips overlapping runs with HTTP 202, force-fails `running` rows older than 20 min (`STALE_RUNNING_SYNC_MS`, `:10`), and on success calls `revalidateTag("snapshot")`.
  - `past-sessions-diff-hook.ts` — `runPastSessionsDiffHook()` captures sessions that were FUTURE in the prior snapshot but dropped out of Wise's feed into the cross-snapshot `past_session_blocks` table. Must run before promotion, while the prior snapshot is still active. Per-group errors emit `completeness` issues without aborting.
  - `snapshot-pruning.ts` — `pruneOldSnapshots()`, best-effort cleanup of superseded snapshots after a successful promote; failures are logged, not fatal.
- Depends on: Wise client, all normalization modules, DB layer, compare engine (`detectSessionModalityConflict`)
- Used by: `GET/POST /api/internal/sync-wise` only

**Database (persistence):**
- Purpose: Postgres connection and Drizzle ORM schema definition
- Location: `src/lib/db/`
- Contains:
  - `index.ts:22-29` — `getDb()` returns a `globalThis`-anchored Drizzle client (`__bgscheduler_db`) over the Neon HTTP serverless driver.
  - `schema.ts` — **78 `pgTable` definitions** plus 6 `pgEnum`s (`syncStatusEnum`, `dataIssueTypeEnum`, `dataIssueSeverityEnum`, `modalityEnum`, `classroomRoomCategoryEnum`, `classroomAssignmentRunStatusEnum`). Tables group by subsystem (see Key Abstractions → Table families). *(This file is read-only for this doc; exact columns live in `reference/`.)*
  - `seed.ts` — seeds tutor aliases and admin emails from `SEED_ADMIN_EMAILS`.
- Depends on: `@neondatabase/serverless`, `drizzle-orm`
- Used by: All server-side code

**Snapshot tables (Postgres):**
- Purpose: Versioned, point-in-time normalized tutor data keyed by `snapshot_id`
- Tables: `tutor_identity_groups`, `tutor_identity_group_members`, `tutors`, `raw_teacher_tags`, `subject_level_qualifications`, `recurring_availability_windows`, `dated_leaves`, `future_session_blocks`, `data_issues`, `snapshot_stats` — each carries a `snapshot_id` FK to `snapshots`.
- Exception: `past_session_blocks` is cross-snapshot (keyed by `group_canonical_key`, not `snapshot_id`) so historical compare data survives snapshot rotation.

**Search index (denormalized in-memory):**
- Purpose: In-memory data structure for sub-400ms warm queries
- Location: `src/lib/search/index.ts`
- Contains:
  - `globalThis.__bgscheduler_searchIndex: SearchIndex | null` — the singleton.
  - `globalThis.__bgscheduler_searchIndexBuildPromise` — concurrent-build coalescing.
  - `buildIndex(db)` (`:142-344`) — finds the active snapshot, derives `syncedAt` from the sync run that promoted it, loads all snapshot-scoped tables (plus tutor business profiles + a profile-version fingerprint) in parallel via `Promise.all`, groups by `groupId`, and constructs `IndexedTutorGroup[]` + a `byWeekday: Map<number, IndexedTutorGroup[]>`.
  - `ensureIndex(db)` (`:354-401`) — staleness check: rebuilds if the active snapshot id OR the profile-version fingerprint differs from the cached index. Returns the stale cached index if the DB momentarily reports no active snapshot.
  - Indexed types: `IndexedTutorGroup`, `IndexedQualification`, `IndexedWiseRecord`, `IndexedAvailabilityWindow`, `IndexedLeave`, `IndexedSessionBlock`, `IndexedDataIssue`, `IndexedTutorBusinessProfile`.
- Depends on: DB layer, `tutor-business-profiles.ts`
- Used by: Search engine, compare engine, read API routes, proposals, AI scheduler

**Search engine:**
- Purpose: Execute availability searches against the in-memory index
- Location: `src/lib/search/engine.ts`
- Contains:
  - `executeSearch(index, request, staleThresholdMs?)` (`:22-58`) — slot-based search supporting `recurring` and `one_time` modes; computes per-slot results plus a multi-slot intersection. Default stale threshold is `API_STALE_THRESHOLD_MS` (90 min).
  - `searchSlot()` (`:60-150`) — checks data_issues → modality → availability window → qualification filters → blocking sessions → leaves, partitioning tutors into `available` vs `needsReview`.
  - `getBlockingSessions()` (`:200-238`) — enriches blocked range-grid cells with overlapping session detail.
  - `range-search.ts` — generates sub-slots from a time window + duration and reshapes engine output into the availability grid.
- Depends on: Search index, normalization/timezone, `ops/stale`
- Used by: `POST /api/search`, `POST /api/search/range`

**Compare engine:**
- Purpose: Build side-by-side tutor schedules, detect conflicts, find shared free slots
- Location: `src/lib/search/compare.ts`
- Contains:
  - `buildCompareTutor(...)` (`:225`) — date-range filtered schedule assembly with weekday fallback for past days lacking session data; per-session modality via `resolveSessionModality()` (`:97`).
  - `detectConflicts(compareTutors)` (`:322`) — same-student overlap detection across selected tutors (case-insensitive, deduped by student+day+tutor).
  - `findSharedFreeSlots(...)` (`:361`) — interval intersection across tutors with a 30-minute minimum threshold.
  - `detectSessionModalityConflict(...)` (`:185`) — used by the sync orchestrator to emit `conflict_model` data_issues.
  - `getStartOfTodayBkk()` (`:36`) and `computeDateForWeekdayInRange()` (`:52`) — Asia/Bangkok helpers for historical-range detection and weekday-date math.
- Depends on: Search index types
- Used by: `POST /api/compare`, `POST /api/compare/discover`, sync orchestrator

**API routes:**
- Purpose: HTTP endpoints consumed by the frontend and crons
- Location: `src/app/api/` (96 `route.ts` files, **110 method handlers**: 46 GET, 48 POST, 12 PATCH, 4 DELETE)
- Auth: `auth()` from `src/lib/auth.ts` first; return 401 if unauthorized. Public exceptions (no session) are enumerated in middleware: `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, two LINE OA-resolver worklist routes, and everything under `/api/internal/*` (which use `CRON_SECRET` instead).
- Validation: POST/PATCH routes use Zod `.safeParse()` against a module-scope schema, returning 400 with `.flatten()` on failure.
- Endpoint families (representative, not exhaustive):
  - Tutor search/compare: `/api/search`, `/api/search/range`, `/api/search/assistant`, `/api/compare`, `/api/compare/discover`, `/api/filters`, `/api/tutors`.
  - Data integrity: `/api/data-health`, `/api/tutor-profiles*`.
  - Internal crons: `/api/internal/sync-wise`, `/api/internal/sync-wise-activity`, `/api/internal/sync-sales-dashboard`, `/api/internal/sync-credit-control`, `/api/internal/sync-leave-requests`, `/api/internal/sync-room-utilization`, `/api/internal/class-assignments/morning`, `/api/internal/class-assignments/admin-email`.
  - Subsystems: `/api/sales-dashboard/*`, `/api/credit-control/*`, `/api/payroll/*`, `/api/leave-requests/*`, `/api/line/*`, `/api/class-assignments/*`, `/api/classrooms/*`, `/api/room-capacity/*`, `/api/proposals/*`, `/api/ai-scheduler/*`, `/api/wise-activity/*`.
  - Auth: `GET/POST /api/auth/[...nextauth]`.
- *(Exact request/response signatures live in `reference/`.)*

**Server data layer (cached functions):**
- Purpose: Server-only cached read helpers consumed by Server Components
- Location: `src/lib/data/`
- Contains:
  - `filters.ts` — `getFilterOptions()` with `"use cache"` + `cacheTag("snapshot")` + `cacheLife("hours")`; `loadFilterOptions(db)` is the uncached, testable inner.
  - `tutors.ts` — `getTutorList()` with the same cache discipline.
  - `past-sessions.ts` — `fetchPastSessionBlocks(...)` with `cacheTag("past-sessions")` + `cacheLife("days")`, deliberately on a SEPARATE tag from `"snapshot"` because past data is immutable (first-observation wins). `fetchPastSessionBlocksUncached` exported for Vitest.
  - `active-snapshot.ts` — `getActiveSnapshotIdOrThrow(db)`, throws `"No active snapshot found"` when none is active.
- Used by: `src/app/(app)/search/page.tsx`, `/api/compare`

**Frontend:**
- Purpose: Admin UI across all subsystems
- Location: `src/app/(app)/` (pages in a route group), `src/components/` (reusable components)
- Pages (**14 under `(app)/`**, plus `/login` and a `/` redirect):
  - `/search` — async Server Component fetches `getFilterOptions()` + `getTutorList()`, renders `<SearchWorkspace>` (split search-left / compare-right) inside `<Suspense>`.
  - `/compare` — client redirect to `/search` (preserves `?tutors=`).
  - `/scheduler`, `/scheduler/metrics` — AI scheduler workspace + metrics.
  - `/line-review` — LINE AI review workspace.
  - `/leave-requests`, `/tutor-profiles`, `/class-assignments`, `/room-capacity`, `/sales-dashboard`, `/credit-control`, `/payroll`, `/wise-activity`, `/data-health` — operational dashboards.
- Navigation: `src/components/layout/app-nav.tsx` lists the persistent top-bar links; `stale-snapshot-banner.tsx` shows a dismissible banner past the 2-hour staleness threshold.
- Component organization: `src/components/ui/` (shadcn/ui over `@base-ui/react`); feature dirs (`compare/`, `search/`, plus subsystem dirs); `skeletons/` for loading states.
- Hooks: `src/hooks/use-compare.ts` owns compare state — a `tutorCache: Map<"tutorGroupId:weekStart:CACHE_VERSION", CompareTutor>` (`CACHE_VERSION = "v3"`, `src/lib/search/cache-version.ts`), an `AbortController` for in-flight cancellation, and snapshot-mismatch cache invalidation.

## Data Flow

**Sync flow (Wise orchestrator pipeline):**
1. Vercel cron `GET /api/internal/sync-wise` every 30 min (or manual `POST` with `Bearer $CRON_SECRET` / an admin session).
2. The route does a constant-time `CRON_SECRET` check (`sync-wise/route.ts:10-28`) and calls `runWiseSyncRequest()`.
3. The single-flight guard force-fails stale `running` rows (>20 min), skips if a sync is genuinely running (HTTP 202), otherwise inserts a `sync_runs` row (`status=running`). A partial unique index on `status WHERE status='running'` backstops the race at the DB.
4. `runFullSync()` inserts a candidate `snapshots` row (`active=false`), fetches teachers, resolves identities, and persists groups + members.
5. Per teacher (concurrency 15): fetch full availability (working hours + 180-day leave horizon), normalize, and queue rows for availability/leaves/raw-tags/qualifications. Missing user id or fetch failure → `completeness` data_issue, no abort.
6. Fetch + normalize future sessions → queue `future_session_blocks` rows.
7. Per group: `deriveModality` updates `supportedModality` and builds the tutor record; a follow-up loop emits `conflict_model` issues for per-session modality contradictions.
8. (9.5) Past-sessions diff hook captures dropped-future sessions into `past_session_blocks` (must precede promotion).
9. `Promise.all` bulk inserts in 250-row chunks: availability + leaves + tags + qualifications + sessions + tutors.
10. Insert `data_issues` and `snapshot_stats`.
11. If unresolved-identity ratio < 50%, atomic promotion via one `UPDATE snapshots SET active = (id = candidate) WHERE active = true OR id = candidate`. Mark the sync run success, then best-effort prune old snapshots.
12. On success the route calls `revalidateTag("snapshot")`. The in-memory index is NOT pushed — it detects the change lazily on the next read.

**Search flow (range):**
1. Client posts `{ searchMode, dayOfWeek/date, startTime, endTime, durationMinutes, mode, filters }` to `/api/search/range`.
2. Route runs `auth()` then Zod validation.
3. `getDb()` → `ensureIndex(db)` returns the warm singleton (rebuilds on snapshot/profile change).
4. Generate sub-slots, build a synthetic `SearchRequest`, call `executeSearch`.
5. Reshape into a grid; enrich blocked cells via `getBlockingSessions`; sort by available-slot count; serialize with `snapshotMeta` + `warnings`.

**Compare flow (incremental fetch):**
1. `useCompare.addTutor(id)` updates state and posts `/api/compare` with `{ tutorGroupIds, mode, weekStart?, fetchOnly: [newId] }`.
2. Server resolves the week range, `ensureIndex`, and finds each `IndexedTutorGroup`.
3. If the range starts before BKK start-of-today, it fetches `pastSessionBlocks` keyed by `canonicalKey` (separately cached).
4. It always builds all `CompareTutor`s (for full conflict/free-slot detection) but serializes only the `fetchOnly` subset.
5. The client merges into its version-keyed cache; on a server snapshot mismatch it clears the cache and retries once.

**Auth flow:**
1. Every non-asset request hits `src/middleware.ts`, which wraps `edgeAuth` from `src/lib/auth-edge.ts` (Auth.js v5, Google provider; the OAuth scope includes `spreadsheets.readonly` for sheet imports).
2. Public routes pass through; otherwise an unauthenticated request redirects to `/login?callbackUrl=…`.
3. Full sign-in (`src/lib/auth.ts`) gates the email against the `admin_users` allowlist.

**State management:**
- **Server state**: `globalThis`-anchored singletons survive HMR in dev — `__bgscheduler_db`, `__bgscheduler_searchIndex`, `__bgscheduler_searchIndexBuildPromise`.
- **Client state (compare)**: `useState` + `useRef` in `use-compare.ts` (version-keyed `tutorCache` Map + `AbortController`).
- **Client persistent**: recent searches in `localStorage` (last 10).
- **URL state**: `?tutors=…&week=…` synced via `window.history.replaceState`.

## Key Abstractions

**Snapshot (versioned data point):**
- Purpose: Immutable point-in-time capture of all tutor data
- Examples: `src/lib/db/schema.ts` (`snapshots`), `src/lib/sync/orchestrator.ts:71-75` (creation), `:480-501` (atomic promotion)
- Pattern: At most one snapshot is `active = true`. All snapshot-scoped tables FK to `snapshot_id`; `past_session_blocks` is the sole cross-snapshot exception (keyed by `group_canonical_key`).

**IndexedTutorGroup (in-memory aggregate):**
- Purpose: Denormalized read-side representation of one tutor
- Examples: `src/lib/search/index.ts:65-81` (interface), built in `buildIndex()` `:250-319`
- Pattern: Eagerly loaded once, queried many times. `byWeekday` gives O(1) day access. `canonicalKey` is denormalized onto each group so `/api/compare` can reach the cross-snapshot past-session fetcher without an extra query.

**IdentityGroup (5-step cascade resolution):**
- Purpose: Logical merging of multiple Wise teacher records into one real person
- Examples: `src/lib/normalization/identity.ts` (`resolveIdentities`), `src/lib/db/schema.ts` (`tutor_identity_groups` + `tutor_identity_group_members`)
- Pattern: nickname extraction → alias override → online/offline pair detection → unresolved → `alias` data_issue (severity `critical`).

**WiseClient (rate-limited HTTP):**
- Purpose: Retry-capable, concurrency-limited Wise API client
- Examples: `src/lib/wise/client.ts:16-166`
- Pattern: queue-based concurrency limiter, exponential backoff, explicit `RETRYABLE_STATUS_CODES` allowlist (permanent 4xx fail fast), network-error retry. `createWiseClient()` raises concurrency to 15 for production sync.

**SearchIndex singleton (lazy + stale-detected):**
- Purpose: Process-global cache of the active snapshot
- Examples: `src/lib/search/index.ts:94-105` (globals), `ensureIndex()` `:354-401`
- Pattern: lazy build on first request; rebuild on snapshot-id OR profile-version change; singleton-promise coalescing prevents thundering-herd cold-start rebuilds (the in-flight promise is assigned to `globalThis` synchronously before any `await`).

**CompareTutor cache (client-side, version-keyed):**
- Purpose: Avoid refetching unchanged tutors when adding/removing in compare
- Examples: `src/hooks/use-compare.ts`, `src/lib/search/cache-version.ts`
- Pattern: `Map<"tutorGroupId:weekStart:CACHE_VERSION", CompareTutor>`. `CACHE_VERSION = "v3"` (bumped when the `CompareTutor` shape/semantics change). A server snapshot mismatch triggers a full clear + single retry.

**Table families (78 tables by subsystem):**
- Snapshot/tutor core (12): `snapshots`, `sync_runs`, `snapshot_stats`, `tutor_identity_groups`, `tutor_identity_group_members`, `tutors`, `raw_teacher_tags`, `subject_level_qualifications`, `recurring_availability_windows`, `dated_leaves`, `future_session_blocks`, `data_issues`; plus `tutor_aliases`, `tutor_business_profiles`, `tutor_contacts`, `past_session_blocks`, `admin_users`, `google_oauth_tokens`.
- Classroom assignment: `classroom_rooms`, `classroom_assignment_runs`, `classroom_assignment_rows`, `classroom_publish_jobs`, `classroom_automation_events`, `classroom_admin_email_runs`/`_recipients`, `classroom_schedule_email_runs`/`_recipients`.
- Wise activity audit: `wise_activity_events`, `wise_activity_sync_runs`.
- Sales dashboard: `sales_dashboard_sources`, `_normal_rows`, `_additional_rows`, `_import_runs`, `_projection_sources`, `_projection_months`, `_projection_import_runs`.
- Credit control: `credit_control_students`, `_packages`, `_sessions`, `_credit_history`, `_inactive_students`, `_follow_up_state`, `_follow_up_log`, `_admin_ownership`, `_snapshots`, `_sync_runs`.
- Payroll: `payroll_reviews`, `_session_observations`, `_adjustments`, `_rate_card_versions`, `_rate_rules`, `_teacher_tiers`, `_payout_invoices`, `_sync_runs`.
- Leave requests: `leave_requests`, `_affected_sessions`, `_activity_logs`, `_notifications`, `_sync_runs`.
- LINE AI review: `line_contacts`, `_threads`, `_messages`, `_contact_student_links`, `_oa_resolver_runs`/`_rows`, `_scheduler_reviews`, `_wise_action_logs`.
- Room capacity: `room_utilization_sessions`, `room_capacity_model_runs`, `_forecast_drivers`, `_demand_mix`, `_package_mix`.
- AI scheduler: `ai_scheduler_conversations`, `_messages`, `_runs`, `_feedback`.
- Proposals: `proposal_bundles`, `proposal_items`.

## Entry Points

**Root redirect:**
- Location: `src/app/page.tsx`
- Triggers: User navigates to `/`
- Responsibilities: redirect to `/search`

**Search workspace (primary UI):**
- Location: `src/app/(app)/search/page.tsx`
- Triggers: User navigates to `/search`
- Responsibilities: Async Server Component. Fetches `getFilterOptions()` + `getTutorList()` (cached, snapshot-tagged). Renders `<SearchWorkspace>` in `<Suspense>`; the right panel uses `useCompare()`.

**Wise sync endpoint (cron):**
- Location: `src/app/api/internal/sync-wise/route.ts`
- Triggers: Vercel cron `*/30 * * * *` (GET, defined in `vercel.json`); manual `POST` with `Bearer $CRON_SECRET` or an admin session
- Responsibilities: `maxDuration = 800`. Constant-time `CRON_SECRET` check, then `runWiseSyncRequest()` (single-flight guard → `runFullSync()` → `revalidateTag("snapshot")` on success).

**Other cron endpoints (6):** all under `/api/internal/`, registered in `vercel.json`:
- `sync-sales-dashboard` (`10,40 * * * *`), `sync-credit-control` (`20,50 * * * *`), `sync-wise-activity` (`5,35 * * * *`), `sync-leave-requests` (`15,45 * * * *`), `class-assignments/morning` (`45 23 * * *`), `class-assignments/admin-email` (`0,10,20,30 0 * * *`). (`sync-room-utilization` has a route handler but no `vercel.json` cron entry — see Open Questions.)

**Auth middleware:**
- Location: `src/middleware.ts`
- Triggers: every request except `_next/static`, `_next/image`, `favicon.ico`
- Responsibilities: allow the public-route set; otherwise require a session and redirect to `/login` with `callbackUrl`.

**Auth handlers:**
- Location: `src/app/api/auth/[...nextauth]/route.ts` + `src/lib/auth.ts` (full) / `src/lib/auth-edge.ts` (edge)
- Triggers: Auth.js sign-in/out/callback
- Responsibilities: Google OAuth + `admin_users` allowlist check.

## Error Handling

**Strategy:** Fail-closed at the data-integrity boundary, fail-loud at the API boundary, fail-isolated inside the sync.

**Sync error handling:**
- Per-teacher / per-session / per-group errors are caught and stored as `data_issues` (mostly `completeness`/`conflict_model`) without aborting the run (`orchestrator.ts:163-172`, `:249-259`, `:367-398`, `:405-418`).
- A top-level throw lands in the outer catch, which marks `sync_runs.status = "failed"`, sets `finishedAt`, records `errorSummary`, and preserves the prior active snapshot (`:561-599`). A cleanup-update failure is logged (REL-06) but swallowed so the primary error surfaces.
- Promotion gate: `unresolvedRatio >= 0.5` persists the snapshot but does NOT promote (`:473-501`).
- Snapshot pruning failures after a successful promote are logged into the sync-run metadata, not fatal (`:520-548`).

**API route error handling (uniform pattern):**
1. `auth()` → 401 if no session (internal routes use `CRON_SECRET` instead).
2. `await request.json()` in try/catch → 400 on invalid JSON.
3. `schema.safeParse(body)` → 400 with `parsed.error.flatten()`.
4. Business logic in try/catch → 500 with `err instanceof Error ? err.message : "…"`.

**Search/compare data-integrity rules (fail-closed):**
- Unresolved identity, modality, or qualification routes a tutor to `needsReview`, never `available` (`engine.ts:60-150`).
- Cancelled sessions are explicitly non-blocking; unknown statuses are blocking (precomputed `isBlocking` flag).
- Multi-day leaves block every weekday they touch in full (documented REL-04 assumption, `engine.ts:240-289`).

**Staleness as a warning, not an error:**
- The engine sets `snapshotMeta.stale` and pushes a warning when `now − syncedAt > API_STALE_THRESHOLD_MS` (90 min, `src/lib/ops/stale.ts:2`). A separate 2-hour threshold drives a dismissible UI banner (`stale.ts:3`). Stale data is served with a caveat, never withheld.

**Client error handling (compare):**
- `AbortController` cancels in-flight fetches on add/remove; `AbortError` is silently ignored.
- A server snapshot mismatch clears the cache and retries once; a second mismatch surfaces an error.

## Cross-Cutting Concerns

**Authentication:** Auth.js v5 beta, Google provider, split into an edge entry (`src/lib/auth-edge.ts`, used by middleware) and a full Node entry (`src/lib/auth.ts`, allowlist check via `admin_users`). The OAuth scope requests `spreadsheets.readonly` to support Google Sheets imports in the sales/payroll subsystems.

**Validation:** Zod schemas defined at module scope above each handler; always `.safeParse()`. Env validation centralized in `src/lib/env.ts`.

**Logging:** `console.error()` for caught errors. No structured logging or request middleware; the sync orchestrator returns a `SyncResult` summary rather than logging progress (it does log pruning/cleanup failures).

**Timezone:** All times anchored to `Asia/Bangkok` via `src/lib/normalization/timezone.ts` (Thailand has no DST). Compare-side `getStartOfTodayBkk()` computes BKK midnight for historical-range detection.

**Caching:**
- Next.js `"use cache"` server functions tagged `"snapshot"` (swept on Wise sync) or `"past-sessions"` (deliberately not swept by sync).
- The in-memory index lives in `globalThis` per server instance, with stale detection on every `ensureIndex` call (snapshot id + profile-version fingerprint).
- The client tutor cache is version-keyed by `CACHE_VERSION` (`src/lib/search/cache-version.ts`, currently `"v3"`).

**Subsystem sync discipline:** Non-Wise subsystems mirror the single-flight + status-row pattern with their own `*_sync_runs` / `*_import_runs` tables and `/api/internal/*` (or admin-triggered) handlers, but write directly to their domain tables rather than through the snapshot/index machinery.

## Open questions

- **`sync-room-utilization` cron registration.** `src/app/api/internal/sync-room-utilization/route.ts` exists, but `vercel.json` lists only 7 crons and does not include it. It may be admin/manual-triggered only, or its scheduling may be pending. Confirm whether room-utilization sync is meant to run on a cron.
- **Spine vs. filesystem lib-module naming.** The authoritative spine lists lib modules `ai-scheduler` and `auth-helpers`, which on disk are `src/lib/ai/` + `src/lib/scheduler/` and `src/lib/auth/` (with the edge/full auth entries at `src/lib/auth-edge.ts` and `src/lib/auth.ts`). This doc uses the on-disk paths; the mapping is noted here in case the spine names should be reconciled.
- **Page count framing.** There are 16 `page.tsx` files; the authoritative "14 pages" counts only the in-app dashboards under `src/app/(app)/`, excluding the `/` redirect and `/login`. Worth confirming the intended denominator for downstream docs.
- **No active snapshot at first boot.** `buildIndex()` and `getActiveSnapshotIdOrThrow()` both throw `"No active snapshot found"`; `ensureIndex` only swallows the no-active case when a cached index already exists. A brand-new environment surfaces that error on every read route until the first sync promotes — confirm deployment runbooks guarantee a promoted snapshot before serving traffic.

_Verified against HEAD + uncommitted WIP on 2026-05-31._
