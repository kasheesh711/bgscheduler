# Architecture

**Analysis Date:** 2026-09-02

## Pattern Overview

**Overall:** Snapshot-versioned ETL + in-memory query index, serving as the spine of a multi-subsystem admin platform.

The core bet is unchanged: the Wise scheduling platform (the source of truth) is slow, paginated and rate-limited, so it is never queried on the tutor read path. A background sync pulls all tutor data out of Wise, normalizes it through seven domain modules, persists it to Postgres tables keyed by an immutable `snapshot_id`, and serves search/compare reads from a process-global in-memory index built from the active snapshot. Reads touch the DB only for two cheap staleness probes, the occasional index rebuild, and a handful of `"use cache"` lookups.

The codebase has grown far past tutor search. The same Vercel + Next.js 16 + Drizzle + Neon spine now hosts two dozen feature subsystems — admissions case management, post-class feedback + tutor payout, competitor intelligence, progress tests, student promotions, student schedule links (with the LINE schedule bot), the parent class report, the LINE credit bot, learning plans, syllabus reports, US universities (IPEDS), sales dashboard, credit control, payroll, leave requests, LINE AI review, classroom assignment, room capacity, Wise activity audit, proposals, and the AI scheduler — each with its own tables, routes and (where it ingests external data) its own sync lineage, all sharing the auth gate, the DB singleton and the cron-audit discipline.

Counted from the working tree at `main@0cd1e81`: **189 `pgTable` definitions** and **61 `pgEnum` declarations** in `src/lib/db/schema.ts` (4,772 lines); **180 `route.ts` files carrying 243 HTTP endpoints** (241 named `export async function GET|POST|PUT|PATCH|DELETE` handlers — 99 GET, 95 POST, 34 PATCH, 12 DELETE, 1 PUT — plus `GET` + `POST` destructured from the Auth.js catch-all; the 2 CORS `OPTIONS` handlers on the public OA-resolver routes are excluded); **17 Vercel Cron entries** in `vercel.json` against a 22-job cron registry and 22 `/api/internal/*` route files; **31 `page.tsx` files** (26 under the authenticated `(app)` group, 3 print surfaces, `/login`, and the public `/schedule/[token]`); **69 SQL migrations** under `drizzle/`; and **389 Vitest files**.

**Key Characteristics:**
- **Snapshot-based persistence** — tutor data writes are scoped to a `snapshot_id`. A single atomic `UPDATE` flips a candidate snapshot to `active = true` after a successful sync; failed syncs preserve the prior active snapshot. Definition: `src/lib/db/schema.ts:456-460` (`snapshots`). Promotion: `src/lib/sync/orchestrator.ts:480-501`.
- **Single in-memory index** — the entire active snapshot is loaded once into a `globalThis`-anchored singleton (`__bgscheduler_searchIndex`, `src/lib/search/index.ts:92-113`) and queried in-process. Eight call sites consume it: `/api/search`, `/api/compare`, `/api/compare/discover`, `/api/proposals`, `executeRangeSearch`, room-capacity forecasting, the AI scheduler service, and the LINE operational planner (`grep -rn "ensureIndex("`).
- **ETL orchestrator pattern** — one `runFullSync()` (`src/lib/sync/orchestrator.ts:50-611`) performs fetch → normalize → persist → validate → promote inside a single try/catch, with numbered step comments (`// 1.` at `:61` … `// 12.` at `:472`, plus a `9.5` diff hook at `:400`) mapping to ETL phases.
- **Fail-closed safety** — unresolved identity, modality or qualification routes a tutor to "Needs Review", never to "Available" (`src/lib/search/engine.ts:60-150`). The same posture governs sign-in: `resolveUserAccess()` returns `null` for an unrecognized email and sign-in is denied (`src/lib/auth-access.ts:56-85`).
- **App Router server-first reads** — `next.config.ts` sets `cacheComponents: true` (its only setting); Server Components fetch via `"use cache"` helpers in `src/lib/data/*` tagged `cacheTag("snapshot")`, and uncached `auth()` calls sit inside `<Suspense>` boundaries (`src/app/(app)/layout.tsx:13-42`).
- **Tag-scoped cache invalidation** — a successful Wise sync calls `revalidateTag("snapshot", { expire: 0 })` (`src/lib/sync/run-wise-sync.ts:161`). Cross-snapshot past sessions deliberately live on a separate `"past-sessions"` tag so promotion does not sweep immutable history (`src/lib/data/past-sessions.ts:11`, `:88`).
- **Role-gated navigation** — five roles (`admin`, `counselor`, `teacher`, `student`, `parent`) resolve to an `allowedPages` claim on the JWT, enforced at the edge by `isPathAllowed()` for both the page and its API namespace (`src/lib/auth-access.ts:32-38`, `src/middleware.ts:36-67`).
- **Maintenance gate above the public allowlist** — `src/middleware.ts:76-82` runs the MAINT-04 kill switch *before* `isPublicRoute()`, because that allowlist passes `/api/line/webhook`. Off unless `MAINTENANCE_MODE` is exactly `"true"` (`src/lib/maintenance.ts:59`).
- **Cron observability as a first-class layer** — every internal job invocation is wrapped in `withCronInvocationAudit()` writing a `cron_invocations` row (`src/lib/data-health/cron-audit.ts:191`; table `schema.ts:479`), a 22-entry registry (`src/lib/data-health/cron-registry.ts:47-400`) declares each job's schedule/lateness/`maxDuration`/danger flags, and a watchdog cron sweeps them and emails admins (`src/lib/internal/cron-watchdog.ts:374`).
- **Subsystem replication of the discipline, not the machinery** — the non-Wise subsystems each own a `*_sync_runs`-style table with a single-running partial unique index, their own `/api/internal/*` or admin route, and their own cache tag, but do **not** get a snapshot lineage or the in-memory index.

## Layers

Lower layers know nothing about upper ones: the Wise read client has no internal imports, the normalization modules depend only on Wise types, and the orchestrator is the single place that wires fetch + normalize + persist together. Route logic lives in plain `src/lib/{domain}/*.ts` modules so the engines are unit-testable without the Next/auth route graph.

**Wise API client:**
- Purpose: HTTP communication with the Wise scheduling platform (`api.wiseapp.live`)
- Location: `src/lib/wise/` — `client.ts` (retry/backoff/concurrency/call tally), `fetchers.ts` (teachers, availability, future sessions, locations, analytics, activity events), `operations.ts` (writeback helpers), `types.ts` (Wise response shapes + accessor helpers)
- Depends on: nothing internal on the read path — `client.ts` has no import statements at all, and reads `WISE_USER_ID` / `WISE_API_KEY` / `WISE_NAMESPACE` straight from `process.env` (`client.ts:214-221`). `operations.ts` (the *write* helpers, off the snapshot path) does import `@/lib/db`.
- Used by: sync orchestrator, Wise-activity sync, credit control, payroll, classroom publish writeback, student promotions, progress tests, post-class feedback, room utilization, the live student-schedule overlay, leave-request Wise-cancel preview
- Key behaviors: queue-based FIFO concurrency limiter defaulting to 5, raised to **15** by `createWiseClient()` for production sync (`client.ts:65`, `:214-221`, limiter at `:179-199`); exponential backoff `2^attempt * 1000` ms (1s/2s/4s) with 3 retries, applied to both network failures and retryable statuses (`client.ts:150-177`); a closed `RETRYABLE_STATUS_CODES` set `{408, 429, 500, 502, 503, 504}` so permanent 4xx fail fast (REL-05, `client.ts:37-44`); Basic Auth (base64 `userId:apiKey`) plus `x-api-key`, `x-wise-namespace` and `user-agent: VendorIntegrations/{namespace}` (`client.ts:69-78`); an EFF-00 per-path call tally with object-id segments collapsed to `{id}` so a sync's `metadata` carries one histogram bucket per endpoint shape, not one per teacher (`client.ts:79-101`, `topWisePaths` at `:206`).

**Normalization (domain layer):**
- Purpose: transform raw Wise payloads into canonical internal representations; all times anchored to Asia/Bangkok
- Location: `src/lib/normalization/` — seven modules (`identity`, `availability`, `leaves`, `sessions`, `qualifications`, `modality`, `timezone`)
- Contains: `identity.ts` (`resolveIdentities()` at `:72` — cascade at `:81` nickname extraction → `:97` alias-table lookup → `:110` online/offline pair merge → `:177` unresolved → `alias` data issue); `availability.ts` (`normalizeWorkingHours` → `{ weekday, startMinute, endMinute }` with overlap merge and de-dup); `leaves.ts` (UTC → Asia/Bangkok, overlap merge); `sessions.ts` (`isBlockingStatus()` at `:46-51` — `NON_BLOCKING_STATUSES` is a closed set of five terminal states `{CANCELLED, CANCELED, COMPLETED, MISSED, NO_SHOW}` at `:34-40`; a missing status and any unknown status are blocking, and the stored status defaults to `"UNKNOWN"` at `:80`); `qualifications.ts` (Wise tags → `{ subject, curriculum, level, examPrep }`, unmapped → `tag` issue); `modality.ts` (`deriveModality()` at `:23` — pair structure → session-type evidence → offline-only fallback → `unresolved` at `:70`/`:83`, never guessed); `timezone.ts` (`TIMEZONE = "Asia/Bangkok"` at `:3`, `toLocalTime`, `parseTimeToMinutes`, weekday helpers)
- Depends on: Wise types only
- Used by: sync orchestrator; `parseTimeToMinutes` is also used by the search and compare engines

**Sync orchestrator:**
- Purpose: full ETL — fetch, normalize, persist, validate, promote
- Location: `src/lib/sync/` — four modules
- Contains:
  - `orchestrator.ts:50-611` — `runFullSync()`, the single entry point. Steps 1–12: acquire/create sync run (`:61`) → create candidate snapshot with `active: false` (`:70-81`) → fetch teachers (`:83`) → load aliases (`:86`) → resolve identities (`:93`) → persist groups + members (`:107`) → per-teacher availability/leaves/tags/qualifications (`:141`) → fetch + normalize future sessions (`:262`) → derive modality plus a per-group MOD-01 contradiction pass over a hoisted in-memory map (`:307`) → (9.5) past-sessions diff hook (`:400-407`) → parallel chunked bulk inserts (`INSERT_CHUNK_SIZE = 250`, `:38`; six `insertInChunks` calls under one `Promise.all` at `:423-442`) → store `data_issues` (`:445`) + `snapshot_stats` (`:452`) → validate and promote (`:472-501`) → mark success with EFF-00 duration/Wise-call metadata (`:503-526`) + best-effort pruning (`:527-555`).
  - `run-wise-sync.ts:142-167` — `runWiseSyncRequest()`, the single-flight wrapper: force-fails `running` rows older than `STALE_RUNNING_SYNC_MS` (20 min, `:10`), skips a genuinely-running sync with HTTP **202** (`:148-150`), catches the `23505` unique violation from the DB backstop and converts it into the same skip result (`:42-49`, `:106-117`), and on success calls `revalidateTag("snapshot", { expire: 0 })` (`:161`).
  - `past-sessions-diff-hook.ts:66` — `runPastSessionsDiffHook()` captures sessions that were FUTURE in the prior snapshot but dropped out of Wise's feed into `past_session_blocks`. It must run before promotion, while the prior snapshot is still active (`:56`, `:74-75`); per-group errors emit `completeness` issues without aborting (`:117-132`); inserts are chunked at 250 with `onConflictDoNothing` (`:27`, `:155-165`), which stands in for the transaction the Neon HTTP driver cannot give it.
  - `snapshot-pruning.ts:49` — `pruneOldSnapshots()` keeps the newest `SNAPSHOT_RETENTION_COUNT = 30` snapshots plus any `active` one (`:5`, `:63-70`), nullifies `sync_runs` references, then deletes children in FK-safe order — stats → issues → sessions → leaves → windows → tags → qualifications → tutors → members → groups → snapshots (`:106-176`). Best-effort; failures are folded into the run's `metadata`.
- Depends on: Wise client, all normalization modules, DB layer, compare engine (`detectSessionModalityConflict`, `orchestrator.ts:18`)
- Used by: `GET/POST /api/internal/sync-wise` and `POST /api/admin/sync-wise`

**Database (persistence):**
- Purpose: Postgres connection and Drizzle ORM schema
- Location: `src/lib/db/`
- Contains: `index.ts:22-27` — `getDb()` returns a `globalThis`-anchored Drizzle client (`__bgscheduler_db`) over the Neon serverless HTTP driver, throwing `"DATABASE_URL is not set"` if unconfigured; `schema.ts` — **189 `pgTable` definitions** plus **61 `pgEnum`s** across 4,772 lines; `seed.ts` — seeds tutor aliases and admin emails. *(This file is read-only for this doc; column-level detail is owned by [`docs/reference/database/`](../../docs/reference/database/index.md).)*
- Transaction escape hatch: the Neon-HTTP driver has no transaction support, so the three subsystems that need atomic multi-statement writes try the Drizzle transaction first, detect the specific `"No transactions support in neon-http driver"` message, and fall back to a lazily-constructed `node-postgres` `Pool` with explicit `BEGIN`/`COMMIT`/`ROLLBACK` — `src/lib/payroll/sync.ts:90`, `src/lib/post-class-feedback/transaction.ts:12`, `src/lib/admissions/audit.ts:54`.

**Snapshot tables (Postgres):**
- Purpose: versioned, point-in-time normalized tutor data keyed by `snapshot_id`
- Tables (10 snapshot-scoped, all rewritten wholesale per run and all deleted in FK-safe order by `pruneOldSnapshots()`): `tutor_identity_groups` (`schema.ts:1519`), `tutor_identity_group_members` (`:1530`), `tutors` (`:1552`), `raw_teacher_tags` (`:1565`), `subject_level_qualifications` (`:1576`), `recurring_availability_windows` (`:1592`), `dated_leaves` (`:1606`), `future_session_blocks` (`:1618`), `data_issues` (`:2688`), `snapshot_stats` (`:2706`). The control plane is `snapshots` (`:456`) + `sync_runs` (`:462`).
- Exception: `past_session_blocks` is cross-snapshot, keyed by `group_canonical_key` with a `unique(wise_session_id)` idempotency index and a nullable, deliberately non-FK `captured_in_snapshot_id` so pruning cannot cascade into it (`schema.ts:2258-2297`).

**Search index (denormalized in-memory):**
- Purpose: in-memory structure backing sub-400 ms warm queries
- Location: `src/lib/search/index.ts`
- Contains: `globalThis.__bgscheduler_searchIndex` and `__bgscheduler_searchIndexBuildPromise` (`:92-113`); `buildIndex(db)` (`:142-344`) — finds the active snapshot (throwing `"No active snapshot found"` at `:151`), derives `syncedAt` from the newest `success` sync run whose `promotedSnapshotId` matches (`:154-166`), loads every snapshot-scoped table plus business profiles and a profile fingerprint in one `Promise.all` (`:175-222`), groups by `groupId` (`:225-250`), and builds `IndexedTutorGroup[]` + `byWeekday: Map<number, IndexedTutorGroup[]>` (`:322-331`); `ensureIndex(db)` (`:354-401`) — staleness check on **both** the active snapshot id and the profile-version fingerprint (`count(*) + max(updated_at)` over `tutor_business_profiles`, `getTutorProfileVersion` at `:128-137`), returning the cached index if the DB momentarily reports no active snapshot (`:384-386`)
- Indexed types: `IndexedTutorGroup` (`:65-81`), `IndexedQualification`, `IndexedWiseRecord`, `IndexedAvailabilityWindow`, `IndexedLeave`, `IndexedSessionBlock`, `IndexedDataIssue`, `IndexedTutorBusinessProfile`
- Depends on: DB layer, `tutor-business-profiles.ts`

**Search engine:**
- Purpose: execute availability searches against the in-memory index
- Location: `src/lib/search/engine.ts`
- Contains: `executeSearch(index, request, staleThresholdMs?)` (`:22-58`) — per-slot results plus a multi-slot intersection, default threshold `API_STALE_THRESHOLD_MS`; `searchSlot()` (`:60-150`) — `byWeekday` narrowing → data issues → modality → availability window coverage → qualification filters → blocking sessions → leaves, partitioning into `available` vs `needsReview`; `getBlockingSessions()` (`:200`) enriches blocked grid cells; `range-search.ts:103` `executeRangeSearch()` generates sub-slots from a window + duration (`generateSubSlots` at `:41`), calls `ensureIndex` (`:115`) and overlays local proposal holds via `listActiveProposalHolds` (`:116`) before invoking the pure engine (`:127`); `recommend.ts:20` `getRecommendedSlots()` ranks slots client-side for the recommended-slots hero and parent-message drawer; `parser.ts` handles natural-language slot text
- Depends on: search index, `normalization/timezone`, `ops/stale`, proposals — never the database

**Compare engine:**
- Purpose: build side-by-side tutor schedules, detect conflicts, find shared free slots
- Location: `src/lib/search/compare.ts`
- Contains: `buildCompareTutor(...)` (`:225`) — date-range-filtered schedule assembly with weekday fallback for past days lacking session data; `resolveSessionModality()` (`:97`); `detectSessionModalityConflict(...)` (`:185`) — consumed by the orchestrator to emit `conflict_model` issues; `detectConflicts(...)` (`:322`) — same-student overlap detection; `findSharedFreeSlots(...)` (`:361`) — interval intersection; `getStartOfTodayBkk()` (`:36`) and `computeDateForWeekdayInRange()` (`:52`)
- Depends on: search index types only

**API routes:**
- Purpose: HTTP endpoints consumed by the frontend, LINE, and crons
- Location: `src/app/api/` — **180 `route.ts` files** exporting **243 endpoints**
- Auth: `auth()` first, 401 otherwise. Public exceptions are enumerated in middleware (`src/middleware.ts:9-26`): `/login`, `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, the token-bearing `/schedule/` parent links, two LINE OA-resolver worklist routes, and everything under `/api/internal/*` (which uses `CRON_SECRET`).
- Validation: POST/PATCH bodies parse through a module-scope Zod schema with `.safeParse()`, returning 400 with `.error.flatten()`.
- Long-running work is declared per route: **43** route files export a `maxDuration` — 30 at **800 s** (every `sync-*` internal cron, the post-class payout accrual, the Wise-activity backfill, the sales/payroll/post-class/leave-request/student-promotion admin syncs, and `/api/data-health/jobs/[jobKey]/run`), 12 at 300 s, and the LINE webhook at 60 s.
- Largest groups by handler count: admissions (61), internal crons (31), LINE (29, excluding its 2 `OPTIONS` preflights), sales dashboard (13), post-class feedback (13), student promotions (9), competitor intelligence (9), credit control (8), class assignments (8), AI scheduler (8). *(Exact method+path+signature inventory is owned by [`docs/reference/api/`](../../docs/reference/api/index.md).)*

**Server data layer (cached functions):**
- Purpose: server-only cached reads consumed by Server Components
- Location: `src/lib/data/`
- Contains: `filters.ts:52-58` — `getFilterOptions()` with `"use cache"` + `cacheTag("snapshot")` + `cacheLife("hours")`, backed by an uncached testable inner loader; `tutors.ts:80-86` — `getTutorList()` on the same discipline; `past-sessions.ts:82-91` — `fetchPastSessionBlocks(...)` with `cacheTag("past-sessions")` + `cacheLife("days")` and an exported uncached inner function for Vitest; `active-snapshot.ts:5` — `getActiveSnapshotIdOrThrow(db)`. These read the snapshot-scoped tables directly; they do **not** go through the in-memory index.
- Sibling subsystems own their own tags rather than piggybacking on `"snapshot"`: `CREDIT_CONTROL_CACHE_TAG` (`src/lib/credit-control/service.ts:32`), `SALES_DASHBOARD_CACHE_TAG` (`src/lib/sales-dashboard/data.ts:921`, `:934`, `:950`), `US_UNIVERSITIES_CACHE_TAG` (`src/lib/us-universities/data.ts:370-410`), plus the progress-tests service (`src/lib/progress-tests/service.ts`) and the two admissions pages, which declare `"use cache"` in the page module itself.

**Feature libraries:**
- Location: `src/lib/` — 36 module directories: `__tests__`, `admissions`, `ai`, `auth`, `calendar`, `classrooms`, `competitor-intelligence`, `credit-control`, `data`, `data-health`, `db`, `home`, `internal`, `learning-plans`, `leave-requests`, `line`, `navigation`, `normalization`, `ops`, `payroll`, `post-class-feedback`, `progress-tests`, `proposals`, `room-capacity`, `sales-dashboard`, `scheduler`, `search`, `student-promotions`, `student-report`, `student-schedule`, `syllabus`, `sync`, `ui`, `us-universities`, `wise`, `wise-activity`; plus loose modules `auth.ts`, `auth-edge.ts`, `auth-access.ts`, `bangkok-time.ts`, `env.ts`, `maintenance.ts`, `tutor-business-profiles.ts`, `tutor-profile-import.ts`, `tutor-profile-vocabulary.ts`, `utils.ts`
- The largest by surface area are `post-class-feedback` (40 modules — evidence sync, policy, auto-approval, finance lock, AI review, notifications, Drive, and a 14-module payout sub-family writing to Google Sheets), `line` (24, including the schedule bot, credit bot, report bot and OA-resolver), `admissions` (23), `sales-dashboard` (21), `credit-control` (19), `us-universities` (17) and `progress-tests` (16)
- Two directories hold only tests (`__tests__`, `auth`); `syllabus` is a server-only static-data module whose year JSON bundles are lazily `import()`-ed so the skill dataset never reaches the client (`src/lib/syllabus/get-year-syllabus.ts`)

**Frontend:**
- Purpose: admin UI across all subsystems, plus three print surfaces and one public page
- Location: `src/app/(app)/` (authenticated route group), `src/app/(print)/` (print/PDF render targets), `src/app/schedule/[token]/` (public), `src/app/login/`, `src/components/`
- Pages: **26 under `(app)/`** — `/` (home hub), `/search`, `/compare` (legacy redirect), `/scheduler`, `/scheduler/metrics`, `/line-review`, `/leave-requests`, `/tutor-profiles`, `/class-assignments`, `/room-capacity`, `/post-class-feedback`, `/progress-tests`, `/student-schedule`, `/student-report`, `/student-promotions`, `/learning-plans`, `/admissions` + `/admissions/[caseId]`, `/us-universities` + `/us-universities/[unitId]`, `/competitor-intelligence`, `/sales-dashboard`, `/credit-control`, `/payroll`, `/wise-activity`, `/data-health`. Outside the group: `/login`, `/schedule/[token]`, and three `(print)` report pages (`learning-plans/report`, `student-report/report`, `student-schedule/report`) — 31 `page.tsx` files in total.
- Navigation: `src/lib/navigation/tools.ts` is the single registry — **22 tools across 6 sections** (`scheduling-tutors`, `student-lifecycle`, `finance-revenue`, `market-intelligence`, `research-reference`, `data-audit`), 4 with `shortcut: true` and 7 with a `badgeKey` (`NavBadgeKey`, `:33-40`); `canAccessHref()`/`visibleSections()` (`:266`, `:286`) filter by the signed-in user's `allowedPages`, and `src/app/(app)/layout.tsx:14-28` (`AppNavWithAccess`) supplements that with fresh DB grants for learning plans and post-class feedback.
- Component organization: 26 dirs under `src/components/` — `ui/` (shadcn/ui over `@base-ui/react`), `layout/`, `skeletons/` for loading states, and 23 feature dirs. Five hooks in `src/hooks/`: `use-compare`, `use-keyboard-shortcuts`, `use-resizable-split`, `use-sales-dimensions`, `use-theme`.
- `/compare` is a `"use client"` redirect that forwards `?tutors=` into `/search` (`src/app/(app)/compare/page.tsx:10-17`) — the **legacy-redirect** badge on Tutor Compare describes that standalone page only; the compare engine and both `/api/compare*` endpoints are fully live inside the search workspace.

## Data Flow

**Sync flow (Wise orchestrator pipeline):**
1. Vercel cron `GET /api/internal/sync-wise` every 30 min, or a manual `POST` with `Bearer $CRON_SECRET` / an admin session (`sync-wise/route.ts:33-76`).
2. The route performs a constant-time `CRON_SECRET` comparison — `timingSafeEqual` behind an O(1) length pre-check (REL-07, `route.ts:11-29`) — and wraps the call in `withCronInvocationAudit({ jobKey: "wise_snapshot", triggerSource: "cron" | "admin" })`.
3. `runWiseSyncRequest()` acquires the guard: force-fail `running` rows older than 20 min, return 202 if one is genuinely running, otherwise insert a `sync_runs` row. The partial unique index `sync_runs_single_running_idx` (`unique(status) WHERE status = 'running'`, `schema.ts:473-475`) backstops the race at the DB.
4. `runFullSync()` inserts a candidate `snapshots` row (`active = false`), fetches teachers, resolves identities, persists groups + members.
5. Per teacher (concurrency 15): fetch full availability (working hours + a 180-day leave horizon stitched across 26 seven-day windows), normalize, queue availability/leaves/raw-tag/qualification rows. A missing Wise user id or a failed fetch emits a `completeness` issue and the loop continues — one bad teacher never aborts the sync (`orchestrator.ts:162-173`, `:249-259`).
6. Fetch + normalize future sessions into `future_session_blocks` rows, mapped back to groups via a `wiseUserId → teacherId` map.
7. Per group: `deriveModality` writes `supportedModality` and the tutor row; a second pass emits `conflict_model` issues for per-session modality contradictions using a hoisted `groupSupportedModality` map, so there is no per-session `SELECT` (MOD-01, `orchestrator.ts:365-398`).
8. (9.5) The past-sessions diff hook captures dropped-future sessions into `past_session_blocks` — necessarily before promotion, while the prior snapshot is still active.
9. `Promise.all` bulk inserts in 250-row chunks: availability + leaves + tags + qualifications + sessions + tutors.
10. Insert `data_issues` and `snapshot_stats` (including an `issuesByType` histogram).
11. Compute `unresolvedRatio = identityIssues / max(groups, 1)`; promote only if `< 0.5`, via a single `UPDATE snapshots SET active = (id = candidate) WHERE active = true OR id = candidate` (REL-01, `orchestrator.ts:480-501`). Mark the run `success` with `{ diffHookDurationMs, pastSessionsCapturedCount, durationMs, wiseCallCount, wiseTopPaths }` metadata (EFF-00, `:503-513`), then best-effort prune.
12. The runner calls `revalidateTag("snapshot")` on success. The in-memory index is **not** pushed — readers detect the change lazily.

**Search flow (range):**
1. Client posts `{ searchMode, dayOfWeek|date, startTime, endTime, durationMinutes, mode, filters }` to `/api/search/range`.
2. Route runs `auth()` → 401, `request.json()` in try/catch → 400, then Zod `.safeParse()` → 400.
3. `generateSubSlots` slices the window into class-duration sub-slots; an empty result is a 400 before any I/O.
4. `executeRangeSearch` calls `ensureIndex(db)` (two cheap `SELECT`s on the warm path) and loads active proposal holds (`range-search.ts:115-116`).
5. `executeSearch` runs entirely in memory: `byWeekday` narrowing → data issues → modality → window coverage → qualification filters → blocking sessions → leaves.
6. Results reshape into the availability grid, blocked cells are enriched with overlapping session detail, proposal holds are overlaid as a distinct blocking kind, and the response carries `snapshotMeta` + `warnings`.

**Compare flow (incremental fetch):**
1. `useCompare.addTutor(id)` posts `/api/compare` with `{ tutorGroupIds, mode, weekStart?, fetchOnly: [newId] }`.
2. The server resolves the week range from "now in Bangkok" via `date-fns-tz` `toZonedTime` (REL-08, `compare/route.ts:33-41`), calls `ensureIndex` (`:138`), and resolves each requested id.
3. **Stale-id healing:** an id from a retired snapshot is UUID-shape-checked, looked up in `tutor_identity_groups` for its `canonical_key`, re-resolved against the active index, and answered with a `"Tutor selection was refreshed after the latest Wise sync"` warning rather than a 404 (`compare/route.ts:59-110`, `:155-159`).
4. If the range starts before BKK start-of-today, `fetchPastSessionBlocks` is consulted by sorted `canonicalKey` list (separately cached), and the past blocks are merged into both `buildCompareTutor` (`:200-208`) and a cloned group handed to `findSharedFreeSlots` (`:214-224`) so a captured past session cannot read as "free".
5. All `CompareTutor`s are built (so conflicts and shared free slots stay correct) but only the `fetchOnly` subset is serialized (`:229-236`).
6. The client merges into a version-keyed `Map`; a server snapshot mismatch clears the cache and retries once (`use-compare.ts:153-170`).

**Auth flow:**
1. Every request except `_next/static`, `_next/image`, `favicon.ico` hits `src/middleware.ts` (`:111-113`), which wraps `edgeAuth` from `src/lib/auth-edge.ts` (Auth.js v5, Google provider).
2. The MAINT-04 maintenance gate runs first (`:76-82`), then the public allowlist passes through (`:84-86`); an unauthenticated request elsewhere redirects to `/login?callbackUrl=…` (`:89-93`).
3. `allowedPages` (null = full-access admin) is matched by `isPathAllowed()` against both the page prefix and its `/api` namespace; a restricted user gets 403 on an API and a redirect-to-landing-page (loop-guarded) on a page (`:96-106`).
4. Full sign-in (`src/lib/auth.ts`, not edited here) resolves the role via `resolveUserAccess()` — `admin_users` → counselor → teacher → admissions case member, first match wins, `null` denies — and persists the claim on the JWT because the edge runtime has no DB access (`src/lib/auth-access.ts:56-85`).

**Public parent-link flow (no session):**
1. An admin (or the LINE schedule bot) mints a capability token for exactly one `(studentKey, monthKey)` — random bytes, base64url, SHA-256-hashed at rest so a DB read cannot reconstruct a live link (`src/lib/student-schedule/links.ts`).
2. `/schedule/{token}` is allowlisted in middleware by the trailing-slash prefix, which deliberately keeps the authenticated `/student-schedule` admin page out of the allowlist (`middleware.ts:16-21`).
3. Resolution compares digests in constant time and returns `null` indistinguishably for malformed/unknown/expired/revoked tokens, so the page cannot be used as an existence oracle; the schedule is re-read live per visit and the page is `noindex/nofollow` (`src/app/schedule/[token]/page.tsx`).

**LINE bot flows (message → action):**
- The webhook routes an inbound message through the schedule-bot router **before** `classifyLineSchedulerMessage`, so an admin command never costs an OpenAI call and never lands in the parent scheduling queue (`src/lib/line/schedule-bot.ts`).
- DM gates (SCHED-BOT-01…04): sender must be in `LINE_SCHEDULE_BOT_ADMIN_IDS` (a non-admin gets no reply at all); the recipient resolves only from `line_contact_student_links` rows with `status='verified'` and `isPhantom=false`, with no name-matching fallback; the first message never sends — a `line_schedule_bot_pending` row with a short TTL requires an explicit `YES`; a month with zero classes refuses rather than pushing a blank calendar.
- Group gates (GRP-BOT-01…05) re-weight those for a group destination: the OA must be `@`-mentioned with `isSelf`, the sender allowlist still applies, only an exact nickname-code hit is accepted, and a student's first appearance in a group requires a confirm (`schedule-bot-group.ts`).
- Two sibling bots share the same allowlist discipline: the **credit bot** (`credit-bot.ts`, digest at `credit-digest.ts`, cron `3 2 * * *` → `/api/internal/line-credit-digest`) and the **parent class report bot** (`report-bot.ts`, backed by `src/lib/student-report/`). State lives in `line_group_settings`, `line_group_schedule_sends`, `line_schedule_bot_pending` and `line_credit_digest_runs`.

**State management:**
- **Server state**: `globalThis`-anchored singletons survive HMR — `__bgscheduler_db`, `__bgscheduler_searchIndex`, `__bgscheduler_searchIndexBuildPromise`.
- **Client state (compare)**: `useState` + `useRef` in `use-compare.ts` — a `Map<"tutorGroupId:weekStart:CACHE_VERSION", CompareTutor>` (`:107`) plus an `AbortController` for in-flight cancellation (`:109`, `:127`).
- **Client persistent**: recent searches in `localStorage`; the stale banner's dismissal in `sessionStorage` under `STALE_BANNER_SESSION_KEY` (`ops/stale.ts:9`).
- **URL state**: `?tutors=…&week=…` synced via `window.history.replaceState`.

## Key Abstractions

**Snapshot (versioned data point):**
- Purpose: immutable point-in-time capture of all tutor data
- Examples: `src/lib/db/schema.ts:456-460`, `src/lib/sync/orchestrator.ts:70-81` (creation), `:480-501` (atomic promotion)
- Pattern: at most one snapshot is `active = true` — enforced by the promotion *statement*, not by a unique index. All snapshot-scoped tables FK to `snapshot_id`; `past_session_blocks` is the sole cross-snapshot exception. `sync_runs.promoted_snapshot_id` is load-bearing — the index reads it to derive `syncedAt`, falling back to the snapshot's `createdAt` (`search/index.ts:154-166`).

**canonicalKey (stable cross-snapshot anchor):**
- Purpose: a per-tutor identity that survives 30-minute snapshot rotation, since `tutor_identity_groups.id` is regenerated every sync
- Examples: denormalized onto `IndexedTutorGroup` (D-04, `src/lib/search/index.ts:65-71`, `:258-263`); consumed by `/api/compare` stale-id healing and by the cross-snapshot past-session fetcher
- Pattern: anything durable and human-owned — tutor business profiles (`schema.ts:1985`), aliases (`:1543`), proposal holds, teacher access grants — keys off `canonicalKey`, never a snapshot UUID.

**IndexedTutorGroup (in-memory aggregate):**
- Purpose: denormalized read-side representation of one tutor
- Examples: `src/lib/search/index.ts:65-81` (interface), built in `buildIndex()` at `:251-319`
- Pattern: eagerly loaded once, queried many times; `byWeekday` (`:322-331`) gives O(1) day access so a weekday search never scans the full roster. Nothing on the request path joins across these — the join happened once at build time.

**IdentityGroup (identity cascade):**
- Purpose: merge multiple Wise teacher records into one real person
- Examples: `src/lib/normalization/identity.ts:72-207`, `tutor_identity_groups` + `tutor_identity_group_members`
- Pattern: nickname extraction → alias override → online/offline pair merge → unresolved → `alias` data issue at `critical` severity (`orchestrator.ts:97-105`). A nickname matching more than a clean online/offline pair keeps the group and emits an `identity_collision` issue for manual disambiguation (REL-03).

**WiseClient (rate-limited HTTP):**
- Purpose: retry-capable, concurrency-limited Wise API access with a per-path call tally
- Examples: `src/lib/wise/client.ts:30-203`, factory at `:214`
- Pattern: queue-based limiter (`withConcurrency`/`processQueue`, `:179-199`), 1s/2s/4s exponential backoff, explicit retryable-status allowlist, network-error retry, concurrency raised to 15 for sync. One client class serves the snapshot sync and nine sibling pipelines.

**SearchIndex singleton (lazy + stale-detected + coalesced):**
- Purpose: process-global cache of the active snapshot
- Examples: `src/lib/search/index.ts:92-113`, `ensureIndex()` `:354-401`
- Pattern: lazy build on first request; rebuild on snapshot-id **or** profile-version change; REL-02 singleton-promise coalescing assigns the in-flight promise to `globalThis` in the same synchronous tick as kickoff (`:394-400`), so concurrent cold-start callers share one build.

**CompareTutor cache (client-side, version-keyed):**
- Purpose: avoid refetching unchanged tutors when adding/removing in compare
- Examples: `src/hooks/use-compare.ts:107-175`, `src/lib/search/cache-version.ts:24`
- Pattern: `Map<"tutorGroupId:weekStart:CACHE_VERSION", CompareTutor>` with `CACHE_VERSION = "v3"`, bumped whenever the cached shape or its semantics change (the file documents the v1→v3 migration history).

**Cron registry + invocation audit:**
- Purpose: make "did the job actually run, and was it late?" answerable from data
- Examples: `src/lib/data-health/cron-registry.ts:27-46` (`CronJobDefinition` carrying `schedule`, `cadenceMinutes`, `lateAfterMinutes`, `maxDurationSeconds`, `manualOnly`, `dangerous`, `routeMethod`, optional expected-Bangkok-window fields), `:47-400` (**22 definitions**), `SCHEDULED_CRON_JOBS` at `:401`, `src/lib/data-health/cron-audit.ts:191` (`withCronInvocationAudit`), `cron_invocations` (`schema.ts:479`) + `cron_alert_state` (`:505`)
- Pattern: 17 of the 22 registered jobs carry a `vercel.json` schedule; the other 5 are declared `schedule: null, manualOnly: true` (`:202`, `:217`, `:232`, `:379`, `:394` — the three post-class notification jobs, room utilization, LINE backlog recovery) and are triggered from `/data-health` via `runDataHealthJob()` (`src/lib/data-health/run-job.ts:29`). `cron-watchdog` sweeps the registry every 30 min, dedupes alerts per failure episode, and uses a sentinel `cron_alert_state` row (`SWEEP_LOCK_KEY`, `src/lib/internal/cron-watchdog.ts:48`) as a single-flight sweep lock because neon-http supports neither transactions nor session advisory locks.

**Table families (189 tables by subsystem):**
- Snapshot/tutor spine (13): `snapshots`, `snapshot_stats`, `sync_runs`, `tutor_identity_groups`, `tutor_identity_group_members`, `tutors`, `raw_teacher_tags`, `subject_level_qualifications`, `recurring_availability_windows`, `dated_leaves`, `future_session_blocks`, `data_issues`, `past_session_blocks`
- By prefix: `admissions_*` 36 · `post_class_*` 32 · `competitor_*` 16 · `line_*` 13 · `credit_control_*` 11 · `classroom_*` 9 · `progress_test_*` 8 · `payroll_*` 8 · `sales_dashboard_*` 7 · `student_promotion_*` 6 · `tutor_*` 5 (+ `tutors`) · `room_capacity_*` 4 (+ `room_utilization_sessions`) · `leave_request_*` 5 · `ai_scheduler_*` 4 · `ipeds_*` 3 · `wise_activity_*` 2 · `proposal_*` 2 · `cron_*` 2 · singles: `student_schedule_links`, `learning_plan_access_grants`, `admin_users`, `google_oauth_tokens`, `tutor_aliases`, `tutor_business_profiles`, `tutor_contacts`
- Snapshot-independent tables survive rotation: the admin/auth tables, `tutor_aliases`, `past_session_blocks`, `room_utilization_sessions`, and every sibling-subsystem table. *(Canonical per-table inventory: [`docs/reference/database/`](../../docs/reference/database/index.md).)*

## Entry Points

**Home hub:**
- Location: `src/app/(app)/page.tsx`
- Triggers: user navigates to `/`
- Responsibilities: async Server Component inside `<Suspense>` with a skeleton; resolves the session, redirects an unauthenticated visitor to `/login` and a single-page-restricted user straight to their landing page, otherwise renders `<HomeHub>` from `getHomeSummaryPayload({ allowedPages, email })` (cross-subsystem KPI tiles scoped to `allowedPages`, `src/lib/home/summary.ts`)

**Search workspace (primary scheduling UI):**
- Location: `src/app/(app)/search/page.tsx`
- Triggers: user navigates to `/search`
- Responsibilities: `await connection()` (required for a per-request render under `cacheComponents`), then fetch `getFilterOptions()` + `getTutorList()` (cached, snapshot-tagged) and render `<SearchWorkspace>` inside `<Suspense fallback={<SearchSkeleton/>}>`; the right panel is driven by `useCompare()`

**Wise sync endpoint (cron):**
- Location: `src/app/api/internal/sync-wise/route.ts`
- Triggers: Vercel cron `*/30 * * * *` (GET); manual `POST` with `Bearer $CRON_SECRET` or an admin session
- Responsibilities: `maxDuration = 800`; constant-time secret check → cron-invocation audit (`triggerSource: "cron"` vs `"admin"`) → `runWiseSyncRequest()` → single-flight guard → `runFullSync()` → `revalidateTag("snapshot")`. Returns 200 with the `SyncResult`, 202 when skipped, 500 when the run failed.

**Other cron endpoints (16 scheduled + 5 manual-only):** all under `/api/internal/`, 22 route files in total. Scheduled in `vercel.json` alongside the snapshot sync: `sync-wise-activity` (`2,17,32,47 * * * *`), `sync-sales-dashboard` (`10,40`), `sync-post-class-feedback` (`13,43`), `sync-leave-requests` (`15,45`), `sync-credit-control` (`20,50`), `post-class-feedback-backfill` (`23,53`), `sync-progress-tests` (`25,55`), `post-class-feedback/payout-accrual` (`33 * * * *` — hourly), `cron-watchdog` (`7,37`), `progress-tests/admin-digest` (`35 0 * * *`), `class-assignments/admin-email` (`4,14,24,36 0 * * *`), `class-assignments/morning` (`41 23 * * *`), `admissions-notifications` (`12 1 * * *`), `line-credit-digest` (`3 2 * * *`), `sync-competitor-intelligence` (`28 18 * * 0`, the only weekly entry), `student-promotions/july-1` (`5 17 30 6 *`, the only annual entry). Registered but unscheduled by design: `sync-room-utilization`, `line-backlog-recovery`, and three post-class-feedback jobs (`admin-digest`, `reminder-day-after`, `reminder-deadline`). *(Canonical schedule list: [`docs/reference/crons.md`](../../docs/reference/crons.md).)*

**Auth middleware:**
- Location: `src/middleware.ts`
- Triggers: every request except `_next/static`, `_next/image`, `favicon.ico` (`:111-113`)
- Responsibilities: maintenance gate → public allowlist → session requirement → `allowedPages` page/API gate

**Auth handlers:**
- Location: `src/app/api/auth/[...nextauth]/route.ts` (`export const { GET, POST } = handlers`) + `src/lib/auth.ts` (Node) / `src/lib/auth-edge.ts` (edge) / `src/lib/auth-access.ts` (role resolution)
- Responsibilities: Google OAuth; fail-closed role + `allowedPages` resolution persisted onto the JWT. The two configs request different Google scopes because only the Node sign-in path stores the Sheets/Drive token.

**Public parent schedule:**
- Location: `src/app/schedule/[token]/page.tsx`
- Triggers: a parent opening a LINE link
- Responsibilities: the only unauthenticated page rendering student data — token-scoped to one `(studentKey, monthKey)`, `noindex/nofollow`, one identical expiry notice for every rejection mode

**LINE webhook:**
- Location: `src/app/api/line/webhook/route.ts` (public in middleware; guarded by LINE signature verification in `src/lib/line/signature.ts`; `maxDuration = 60`)
- Triggers: LINE Messaging API push
- Responsibilities: ingest contacts/threads/messages, then route through the schedule-bot / credit-bot / report-bot gates before the classifier/scheduler-review path

## Error Handling

**Strategy:** fail-closed at the data-integrity boundary, fail-loud at the API boundary, fail-isolated inside the sync.

**Sync error handling:**
- Per-teacher / per-session / per-group errors are caught and stored as `data_issues` (mostly `completeness` / `conflict_model`) without aborting the run.
- A top-level throw lands in the outer catch, which marks `sync_runs.status = "failed"`, sets `finishedAt`, `errorSummary` and a duration/Wise-call metadata blob, and preserves the prior active snapshot (`orchestrator.ts:568-610`). A failure of that cleanup `UPDATE` is logged (REL-06) but swallowed so the primary error still surfaces in the `SyncResult` (`:584-596`).
- Promotion gate: `unresolvedRatio >= 0.5` persists the snapshot but does **not** promote; the run still reports `success` with `promotedSnapshotId = null`.
- Snapshot pruning failures after a successful promote are folded into `sync_runs.metadata` as `{ attempted, failed, error }`, never fatal (`orchestrator.ts:532-541`).
- `withCronInvocationAudit` converts a thrown handler into a 500 JSON response *and* still records the finished invocation row, so a crashed job is visible in `/data-health` rather than silently missing (`cron-audit.ts:191`).

**API route error handling (uniform pattern):**
1. `auth()` → 401 if no session (internal routes use `CRON_SECRET`; `rejectInvalidCronSecret` returns 500 for `missing-secret` and 401 for `invalid`, `src/lib/internal/cron-auth.ts:19-26`).
2. `await request.json()` in try/catch → 400 on invalid JSON.
3. `schema.safeParse(body)` → 400 with `parsed.error.flatten()`.
4. Business logic in try/catch → 500 with `err instanceof Error ? err.message : "…"`.

**Optional-table tolerance:** a handful of readers treat a Postgres `"relation … does not exist"` as a typed missing-payload rather than a 500 — the tutor business-profile loader (`src/lib/tutor-business-profiles.ts:195-206`), the cron watchdog (`src/lib/internal/cron-watchdog.ts:271-295`) and the data-health dashboard (`src/lib/data-health/dashboard.ts:848`) — so a not-yet-migrated environment degrades instead of erroring. The first two predicates unwrap the `DrizzleQueryError` and check `error.cause` plus the raw pg code `42P01`, because drizzle-orm masks the underlying message behind `Failed query: <sql>`.

**Search/compare data-integrity rules (fail-closed):**
- Data issues accumulate into `reviewReasons`; an empty `supportedModes` adds `"Unresolved modality"`; an explicit modality *mismatch* excludes the tutor entirely while an *unknown* modality only demotes to review (`engine.ts:83-97`).
- A tutor reaches `available` only after clearing modality, window coverage, filters, blocking sessions and leaves — **and** carrying zero review reasons (`engine.ts:99-148`). There is no third bucket.
- Cancelled sessions are explicitly non-blocking — as are the other four terminal states in the closed `NON_BLOCKING_STATUSES` set — while a missing or unknown status is blocking, precomputed as `isBlocking` at normalization time (`normalization/sessions.ts:34-51`).
- Multi-day leaves block every weekday they touch in full, with no minute-of-day math (documented REL-04 assumption).
- Multi-slot intersection is computed over `available` only, so a needs-review tutor can never leak into it (`engine.ts:323`).

**Staleness as a warning, not an error:**
- `API_STALE_THRESHOLD_MS = 90 min` sets `snapshotMeta.stale` and pushes `STALE_SEARCH_WARNING` in both the engine and `/api/compare`; `APP_STALE_BANNER_THRESHOLD_MS = 2 h` drives a dismissible app-wide banner (`src/lib/ops/stale.ts:1-17`). Stale data is served with a caveat, never withheld.

**Degrade-rather-than-fail call sites:**
- The LINE operational planner calls `ensureIndex(input.db).catch(() => null)` so an index failure degrades that path instead of breaking message handling (`src/lib/line/operational.ts:527`).
- `ensureIndex` returns the cached index when the DB momentarily reports no active snapshot (`search/index.ts:384-386`).

**Client error handling (compare):**
- `AbortController` cancels in-flight fetches on add/remove; `AbortError` is ignored.
- A server snapshot mismatch clears the tutor cache and retries once; a second mismatch surfaces `"Snapshot changed during fetch. Please retry."` (`use-compare.ts:153-158`).

## Cross-Cutting Concerns

**Authentication & authorization:** Auth.js v5 beta with a Google provider, split into an edge entry (`src/lib/auth-edge.ts`, token claims only — the edge runtime has no DB) and a Node entry (`src/lib/auth.ts`, which calls `resolveUserAccess()`). Five roles resolve to an `allowedPages` claim; the middleware enforces it coarsely, and security-sensitive surfaces re-derive access from Postgres per request — admissions per-case membership (`src/lib/admissions/access.ts`), post-class capabilities (`src/lib/post-class-feedback/access.ts`), learning-plan grants (`src/lib/learning-plans/access.ts`), teacher scoping (`src/lib/progress-tests/teacher-access.ts`). Those surfaces carry explicit carve-outs in `isPathAllowed()` (`middleware.ts:36-57`), including one deliberate *deny* (`/api/learning-plans`, `:53-57`) that stops a page-level carve-out from widening into an API grant.

**Validation:** Zod schemas at module scope above each handler; always `.safeParse()`, never `.parse()`. `src/lib/env.ts:3-36` declares an 18-key contract — 7 hard-required (`DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`, `WISE_API_KEY`, `CRON_SECRET`), 2 defaulted (`WISE_NAMESPACE`, `WISE_INSTITUTE_ID`), 9 optional — and `getEnv()` throws on an invalid set while logging only `fieldErrors`, never values (`:40-47`). See Open Questions about whether it is ever evaluated.

**Logging:** bare `console.error()` for caught errors; no logger or request middleware. The sync orchestrator returns a `SyncResult` summary rather than logging progress, logging only pruning/cleanup failures.

**Timezone:** everything anchors to `Asia/Bangkok` (no DST) via `src/lib/normalization/timezone.ts:3` and `src/lib/bangkok-time.ts`; "now in Bangkok" is computed canonically with `date-fns-tz` `toZonedTime` (REL-08). `vitest.config.ts` pins `process.env.TZ` so date assertions are deterministic. Vercel functions are pinned to `sin1` (`vercel.json:2`).

**Caching:** `cacheComponents: true` globally (the only `next.config.ts` setting); `"use cache"` helpers tagged `"snapshot"` (swept by the Wise sync) or `"past-sessions"` (deliberately not); per-subsystem tags for credit control, sales dashboard, progress tests and US universities; the in-memory index per warm serverless instance with two-signal stale detection; the client tutor cache version-keyed by `CACHE_VERSION`.

**Transactions:** the primary `getDb()` handle is neon-http and has no transaction support. Payroll sync, post-class-feedback writes and the admissions audit trail each try the Drizzle transaction first, detect the specific `"No transactions support in neon-http driver"` error, and fall back to a module-cached `node-postgres` `Pool` doing explicit `BEGIN`/`COMMIT`/`ROLLBACK`. The snapshot spine needs none — idempotent inserts and the single-statement promotion stand in.

**Feature flags:** `ENABLE_LINE_SCHEDULER`, `ENABLE_AI_SCHEDULER` (also gating progress-test AI summaries), `ENABLE_COMPETITOR_AI` and `ENABLE_STUDENT_SCHEDULE_LIVE` are default-on-unless-`"false"` and additionally require the relevant API key, so a missing key silently degrades to the deterministic path. The money-moving flags invert that default and are exact-match `"true"`: `POST_CLASS_PAYOUT_WRITES_ENABLED` gates app-originated payout writes (`src/lib/post-class-feedback/payout-config.ts:49-51`) and `POST_CLASS_AUTO_APPROVE_ENABLED` gates unattended charging, with the reopen sweep deliberately left outside the flag because reopening restores safety while approving moves money (INC-260829, `payout-config.ts:155-168`). The LINE schedule bot is fail-closed by construction: an unset or empty `LINE_SCHEDULE_BOT_ADMIN_IDS` disables it entirely; `MAINTENANCE_BYPASS_EMAILS` behaves the same way (MAINT-03, `src/lib/maintenance.ts:79-101`).

**Subsystem sync discipline:** 13 `single_running` partial unique indexes enforce the one-run-at-a-time invariant across the platform — `sync_runs` (`schema.ts:473`) plus `wise_activity_sync_runs` (`:567`), the two sales-dashboard import lineages (`:666`, `:758`), `competitor_sync_runs` (`:864`), credit control (`:1177`), `payroll_sync_runs` (`:1776`), `leave_request_sync_runs` (`:2110`), `line_backlog_recovery_sync_runs` (`:2680`), `progress_test_sync_runs` (`:2995`), IPEDS import runs (`:3019`), `post_class_sync_runs` (`:3246`) and `admissions_notification_runs` (`:4568`). Each owns its internal route, its own `maxDuration`, and its own cache tag, writing directly to domain tables rather than through the snapshot/index machinery. The guard lives in Postgres, not in application memory, so it holds across function instances.

**Feature maturity at this revision:** stable — Tutor Search, Tutor Profiles, Classroom Assignments, Sales Dashboard, Credit Control, Payroll, Wise Activity Audit, Data Health, Leave Requests, Student Schedule, Student Report, LINE Credit Bot, Post-Class Feedback, Learning Plans, Student Promotions, Progress Tests, Competitor Intelligence, US Universities. Qualified: LINE Integration is stable with the scheduler write path flag-gated; Room Capacity's utilization path is stable while its forecast/month engines have no UI caller and its sync is `manualOnly`; Post-Class Payout is stable with writes gated behind `POST_CLASS_PAYOUT_WRITES_ENABLED` / `POST_CLASS_AUTO_APPROVE_ENABLED`; University Admissions is stable, with parity-hardening code still unmerged on `origin/codex/admissions-parity-hardening` though its schema has landed. Tutor Compare is **legacy-redirect** at the page level only (engine and endpoints live). Experimental: AI Scheduler, Proposals.

## Open questions

- **`src/lib/env.ts` still has zero importers.** It exports `env = getEnv()`, which would validate 18 keys at module-evaluation time, but a repo-wide search for `@/lib/env` / `lib/env` finds no importer outside the file itself — the spine reads `process.env` directly (`db/index.ts:6`, `wise/client.ts:216-218`, `run-wise-sync.ts:145`, `cron-auth.ts:8`, `maintenance.ts:59`). The file's own comment explains why the middleware cannot import it (the edge module would throw on a partial env). Should it be wired into a startup path, or formally redesignated as a declared inventory rather than a runtime guarantee?
- **`vercel.json` and `/api/internal/*` will always disagree by design.** Five registry jobs carry `schedule: null, manualOnly: true` and only ever run via `/data-health` → `runDataHealthJob()`, so 17 cron entries face 22 route files. Confirm the registry is the intended single source of truth for ops runbooks.
- **Cold-index build cost on Vercel.** The `SearchIndex` is per serverless instance, so a cold instance pays a full `buildIndex()` — one snapshot's worth of parallel `SELECT`s plus aggregation — on its first request. Instance recycle frequency and cold-build latency were not measured against the "< 400 ms warm" target.
- **No active snapshot at first boot.** `buildIndex()` throws `"No active snapshot found"` (`search/index.ts:151`) and `ensureIndex` only swallows the no-active case when a cached index already exists. A brand-new environment surfaces that error on every index-backed route until the first promotion — confirm deployment runbooks guarantee a promoted snapshot before serving traffic.
- **The profile fingerprint makes the "zero-query hot path" a two-query hot path.** `getTutorProfileVersion()` runs a `count(*) + max(updated_at)` aggregate on `tutor_business_profiles` on *every* `ensureIndex` call (`index.ts:128-137`, `:368-375`). Negligible today; worth revisiting if that table grows or a cheaper invalidation signal becomes available.
- **The `data_issues` → tutor-group join in `buildIndex()` is O(issues × groups).** Issues are matched to groups by scanning every group per issue and comparing `entityId`/`entityName` (`search/index.ts:232-250`). Fine at ~130 tutors, but it is a quadratic loop in the one code path that must stay fast on a cold instance.
- **`isPathAllowed()` carve-outs are accumulating.** Post-Class Feedback and Learning Plans bypass the coarse prefix match because they re-derive access from Postgres, and `/api/learning-plans` is an explicit deny inserted to stop the page-level carve-out widening into an API grant (`middleware.ts:39-57`). Correct today, but it is a growing special-case list inside a security-critical function; worth deciding whether the JWT `allowedPages` claim should become a uniform per-request capability lookup.
- **Stale-running cutoff versus the function ceiling.** The sync guard force-fails `running` rows after 20 minutes while `maxDuration` is 800 s (~13.3 min), so a sync cannot legitimately outlive the ceiling — the cutoff is purely a safety net, but a wedged row still blocks roughly 1.5 cron cycles before cleanup.
- **Payout accrual is now a scheduled hourly cron rather than a manual job** (`33 * * * *`, `vercel.json`; registry `cron-registry.ts:248` still marks it `dangerous` with a confirmation label for the manual path). It runs the accrual pass unconditionally and then a finalize pass that no-ops until the 26th-to-25th window ends. Worth confirming that the hourly cadence plus the `POST_CLASS_AUTO_APPROVE_ENABLED` grace window is the intended steady state, since the two flags are the only thing between the cron and unattended money movement.

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
