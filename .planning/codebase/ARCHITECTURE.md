# Architecture

**Analysis Date:** 2026-04-16

## Pattern Overview

**Overall:** Server-rendered Next.js 16 App Router application with a snapshot-based data model, in-memory search index singleton, and ETL pipeline integrating the Wise scheduling API.

**Key Characteristics:**

- **Snapshot-based data model** -- all tutor data is versioned under a `snapshot_id`. The active snapshot is atomically promoted after a successful sync. Failed syncs preserve the previous active snapshot. Only one snapshot is `active = true` at a time.
- **In-memory search index singleton** -- the entire active snapshot is loaded into a `SearchIndex` object in server memory (via `globalThis` to survive HMR in dev). All search and compare queries run against this index with no additional DB queries per request. Stale detection checks the active snapshot ID on every call and triggers a rebuild when it changes.
- **ETL pipeline** -- a sync orchestrator fetches from the Wise API, normalizes data through six domain-specific modules, writes to Postgres in chunked inserts, validates completeness, and atomically promotes a new snapshot.
- **Fail-closed safety** -- unresolved identity, modality, or qualification data routes tutors to "Needs Review", never "Available". Unknown session statuses are treated as blocking. Cancelled sessions are explicitly non-blocking.

## Layers

### 1. External API Client

- **Purpose:** HTTP communication with the Wise scheduling platform
- **Location:** `src/lib/wise/`
- **Files:**
  - `client.ts` -- `WiseClient` class with queue-based concurrency limiter (max 5 default, 15 for production sync), exponential backoff retry (1s, 2s, 4s, configurable `maxRetries`). Auth via Basic Auth (base64 userId:apiKey) + `x-api-key` + `x-wise-namespace` headers.
  - `fetchers.ts` -- domain-specific fetchers: `fetchAllTeachers()`, `fetchTeacherFullAvailability()` (working hours + 180-day leave stitching across 26 seven-day windows), `fetchAllFutureSessions()` (paginated)
  - `types.ts` -- Wise API response type definitions (`WiseTeacher`, `WiseSession`, `WiseAvailabilityResponse`), plus accessor helpers (`getWiseTeacherDisplayName`, `getWiseTeacherUserId`, `getWiseSessionTeacherUserId`, `getWiseTagName`)
- **Depends on:** Nothing internal (pure HTTP + env vars)
- **Used by:** Sync orchestrator

### 2. Normalization Pipeline

- **Purpose:** Transform raw Wise API data into canonical internal representations
- **Location:** `src/lib/normalization/`
- **Modules (7):**
  - `identity.ts` -- 5-step cascade: nickname extraction via regex `\(([^)]+)\)` -> alias table lookup (case-insensitive) -> online/offline pair detection via `isOnlineVariant()` and `getBaseName()` -> unresolved teachers get solo groups + data_issue. Produces `IdentityGroup[]` with `canonicalKey`, `displayName`, and typed `IdentityGroupMember[]`.
  - `availability.ts` -- `normalizeWorkingHours()`: weekday + time window normalization with overlapping merge and de-duplication
  - `leaves.ts` -- `normalizeLeaves()`: UTC-to-Asia/Bangkok conversion, overlapping leave merge
  - `sessions.ts` -- `normalizeSessions()`: blocking status classification (CANCELLED/CANCELED = non-blocking, unknown = blocking fail-closed)
  - `modality.ts` -- `deriveModality()`: derived from pair structure -> session type evidence -> location heuristic -> unresolved; never guessed
  - `qualifications.ts` -- `normalizeTeacherTags()`: Wise tags parsed into subject/curriculum/level/examPrep via regex; unmapped tags produce data_issue
  - `timezone.ts` -- all conversions locked to Asia/Bangkok; exports `parseTimeToMinutes()`, weekday derivation, minute-of-day helpers
- **Depends on:** Wise types only
- **Used by:** Sync orchestrator

### 3. Sync Orchestrator

- **Purpose:** Full ETL pipeline -- fetch, normalize, persist, validate, promote
- **Location:** `src/lib/sync/orchestrator.ts`
- **Entry point:** `runFullSync(db, client, instituteId)` -- single function for the entire pipeline
- **Pipeline steps (12):**
  1. Create `sync_run` record (status: running)
  2. Create candidate snapshot (active: false)
  3. Fetch all teachers from Wise
  4. Load alias table from DB
  5. Resolve identities (produces groups + identity issues)
  6. Persist identity groups and members (sequential group insert, chunked member insert)
  7. For each teacher: fetch availability/leaves, normalize working hours + leaves + tags/qualifications (per-teacher errors caught and logged as data_issues without aborting sync)
  8. Fetch and normalize all future sessions (maps Wise userId -> teacherId -> groupId)
  9. Derive modality per group (updates group record + sets per-teacher modality on availability windows)
  10. Batch persist all data (6 parallel chunked insert streams: availability windows, leaves, tags, qualifications, session blocks, tutor records)
  11. Store all accumulated data_issues + compute snapshot_stats
  12. Validate (>50% unresolved identity groups prevents promotion) -> atomic promote (deactivate old snapshot, activate new)
- **Error handling:** Top-level try-catch marks sync_run as `failed` and preserves previous active snapshot. Per-teacher errors are caught individually and logged without aborting. Cleanup errors during failure path are silently caught.
- **Returns:** `SyncResult` with success flag, counts, duration, error summary
- **Depends on:** Wise client, all normalization modules, DB layer
- **Used by:** `POST /api/internal/sync-wise` route handler

### 4. Database Layer

- **Purpose:** Postgres connection and schema definition
- **Location:** `src/lib/db/`
- **Files:**
  - `index.ts` -- Neon serverless HTTP client singleton via `getDb()`. Uses `globalThis.__bgscheduler_db` to survive HMR. Returns `drizzle()` instance with schema binding.
  - `schema.ts` -- 14 Drizzle ORM table definitions (see below)
  - `seed.ts` -- admin user email allowlisting and tutor alias seeding
- **Schema tables (14):**
  - `snapshots` -- versioned records with atomic `active` flag
  - `syncRuns` -- sync metadata, status, timestamps, error summary
  - `adminUsers` -- allowlisted admin emails (unique index on email)
  - `tutorIdentityGroups` -- logical merged tutor grouping (indexed by snapshotId)
  - `tutorIdentityGroupMembers` -- Wise teacher/user IDs per group
  - `tutorAliases` -- manual nickname-to-canonical mappings (unique index on fromKey)
  - `tutors` -- logical tutor display records with supportedModes JSON array
  - `rawTeacherTags` -- original Wise tags per teacher
  - `subjectLevelQualifications` -- normalized subject/curriculum/level/examPrep (indexed by snapshotId + groupId)
  - `recurringAvailabilityWindows` -- weekday + time + modality per group (indexed by snapshotId + weekday)
  - `datedLeaves` -- exact leave windows (indexed by snapshotId + groupId)
  - `futureSessionBlocks` -- blocking windows from Wise sessions (indexed by snapshotId + weekday + groupId)
  - `dataIssues` -- all unresolved normalization issues by type and severity (indexed by snapshotId + type)
  - `snapshotStats` -- aggregate counts for data-health dashboard (unique index on snapshotId)
- **Enums (4):** `syncStatusEnum` (running/success/failed), `dataIssueTypeEnum` (alias/modality/tag/completeness/conflict_model/sync), `dataIssueSeverityEnum` (critical/high/medium/low), `modalityEnum` (online/onsite/both/unresolved)
- **Depends on:** `@neondatabase/serverless`, `drizzle-orm`
- **Used by:** All server-side code

### 5. Search Index

- **Purpose:** In-memory data structure for fast query execution
- **Location:** `src/lib/search/index.ts`
- **Key types:**
  - `SearchIndex` -- snapshotId, builtAt timestamp, `tutorGroups: IndexedTutorGroup[]`, `byWeekday: Map<number, IndexedTutorGroup[]>` for O(1) weekday lookup
  - `IndexedTutorGroup` -- denormalized aggregate: id, displayName, supportedModes, qualifications, wiseRecords, availabilityWindows, leaves, sessionBlocks, dataIssues
- **Singleton pattern:** `globalThis.__bgscheduler_searchIndex` + `globalThis.__bgscheduler_searchIndexBuildPromise` to survive HMR and prevent concurrent rebuilds
- **`buildIndex(db)`:** Loads active snapshot, then parallel-fetches all 6 related tables via `Promise.all`, groups by groupId using `Map`, and assembles `IndexedTutorGroup[]` with weekday lookup map
- **`ensureIndex(db)`:** Checks if cached index matches active snapshot via single lightweight query. If stale, triggers rebuild. Uses building-promise guard to prevent duplicate concurrent builds.
- **Depends on:** DB layer, schema
- **Used by:** Search engine, compare engine, API routes (filters, tutors)

### 6. Search Engine

- **Purpose:** Execute availability searches against the in-memory index
- **Location:** `src/lib/search/engine.ts`
- **Core function:** `executeSearch(index, request, staleThresholdMs)` -- iterates request slots, runs `searchSlot()` per slot, computes multi-slot intersection
- **`searchSlot()` logic:** weekday lookup -> filter by modality match -> check availability window coverage -> apply qualification filters -> check session blocking (recurring or one-time mode) -> check leave conflicts -> route to Available or Needs Review based on data issues
- **Blocking modes:**
  - Recurring: any future session on same weekday+time blocks
  - One-time: only exact date+time overlap blocks
- **Supporting functions:** `getBlockingSessions()` returns metadata for overlapping sessions, `hasRecurringLeaveConflict()` / `hasOneTimeLeaveConflict()` for leave checking
- **Depends on:** Search index types, normalization/timezone
- **Used by:** `POST /api/search`, `POST /api/search/range`

### 7. Compare Engine

- **Purpose:** Build side-by-side tutor schedules, detect conflicts, find shared free slots
- **Location:** `src/lib/search/compare.ts`
- **Core functions:**
  - `buildCompareTutor(group, weekdays?, dateRange?)` -- filters sessions by date range + weekday, implements weekday fallback (pulls nearest future occurrence deduped by `recurrenceId` for past days), resolves per-session modality via multi-step evidence chain (teacher isOnline -> group supportedModes -> sessionType -> location patterns), computes weekly hours and student count
  - `detectConflicts(compareTutors, indexedGroups)` -- finds same student with overlapping sessions across different selected tutors (case-insensitive name matching, deduped by student+day+tutor pair)
  - `findSharedFreeSlots(groups, weekdays, dateRange?)` -- subtracts blocking sessions from availability windows per tutor, intersects free intervals across all tutors using sweep-line algorithm (minimum 30-minute threshold)
- **Depends on:** Search index types, compare types
- **Used by:** `POST /api/compare`, `POST /api/compare/discover`

### 8. Cached Data Functions

- **Purpose:** Server-side cached data accessors using Next.js `"use cache"` directive
- **Location:** `src/lib/data/`
- **Files:**
  - `filters.ts` -- `getFilterOptions()`: extracts distinct subjects/curriculums/levels from index, tagged with `"snapshot"` cache tag, `cacheLife("hours")`
  - `tutors.ts` -- `getTutorList()`: builds sorted tutor list from index, same cache tags
- **Cache invalidation:** `revalidateTag("snapshot")` called after successful sync in `POST /api/internal/sync-wise`
- **Depends on:** Search index, DB layer
- **Used by:** `GET /api/filters`, `GET /api/tutors`

### 9. API Routes

- **Purpose:** HTTP endpoints consumed by the frontend
- **Location:** `src/app/api/`
- **Routes (8):**
  - `POST /api/search` -- slot-based search with recurring/one-time modes
  - `POST /api/search/range` -- range search: time window + duration -> availability grid with sub-slots
  - `GET /api/filters` -- distinct subjects, curriculums, levels for dropdown population
  - `GET /api/tutors` -- all tutor names/IDs/modes/subjects from active snapshot
  - `POST /api/compare` -- compare 1-3 tutors with optional `weekStart` and `fetchOnly` params. Returns week-scoped schedules, student-level conflicts, shared free slots. Conflicts/free-slots always computed on full tutor set regardless of `fetchOnly`.
  - `POST /api/compare/discover` -- find candidate tutors with filters and pre-computed conflict status
  - `GET /api/data-health` -- sync status, issue counts, recent sync history
  - `POST /api/internal/sync-wise` -- cron-triggered sync, CRON_SECRET auth, `maxDuration = 300`
  - `GET/POST /api/auth/[...nextauth]` -- Auth.js catch-all route
- **Common pattern:** Auth check first (401) -> JSON parse in try/catch (400) -> Zod `.safeParse()` validation (400 with flattened errors) -> business logic in try/catch (500 with error message)
- **Depends on:** Auth, DB, search index, search engine, compare engine
- **Used by:** Frontend client components

### 10. Frontend

- **Purpose:** Admin UI for searching and comparing tutor availability
- **Location:** `src/app/(app)/` (pages), `src/components/` (reusable components), `src/hooks/` (custom hooks)
- **Pages:**
  - `/` -- redirects to `/search`
  - `/login` -- Google sign-in with Auth.js
  - `/search` -- side-by-side workspace (search left, compare right). Client component with `"use client"` directive. All data fetching via `fetch()` to API routes.
  - `/compare` -- redirects to `/search` (backward compatibility, preserves `?tutors=` param)
  - `/data-health` -- sync status dashboard
- **Component directories:**
  - `src/components/compare/` -- calendar-grid, compare-panel, discovery-panel, session-colors, tutor-combobox, tutor-profile-popover, tutor-selector, week-calendar, week-overview
  - `src/components/search/` -- availability-grid, copy-button, recent-searches, results-view, search-form, search-results, search-workspace, slot-builder, slot-chips, slot-input
  - `src/components/layout/` -- app-nav
  - `src/components/skeletons/` -- calendar-skeleton, form-skeleton, search-skeleton
  - `src/components/ui/` -- badge, button, card, command, dialog, input-group, input, popover, select, separator, table, tabs, textarea (shadcn/ui primitives)
- **Custom hooks:** `src/hooks/use-compare.ts` -- `useCompare()` hook manages compare state, client-side tutor cache (`Map<tutorGroupId:weekStart, CompareTutor>`), incremental fetch with `fetchOnly`, AbortController for request cancellation, automatic cache invalidation on snapshot change, week navigation
- **Depends on:** API routes (via `fetch`), shared type imports
- **Used by:** End users (admin staff)

## Data Flow

### Sync Flow (ETL)

```
Wise API ──fetch──> Raw Data
                      │
                  Normalization Pipeline
                  (identity, availability, leaves,
                   sessions, qualifications, modality)
                      │
                  Postgres (new snapshot, active=false)
                      │
                  Validation (>50% unresolved = fail)
                      │
                  Atomic Promote (deactivate old, activate new)
                      │
                  revalidateTag("snapshot") ──> invalidate cache
```

### Query Flow (Search / Compare)

```
Client (browser)
    │
    │ fetch("/api/search" or "/api/compare")
    v
API Route Handler
    │
    │ auth() check
    │ Zod validation
    │
    v
ensureIndex(db) ──> stale check (single query)
    │                    │
    │  if stale:          │  if fresh:
    │  buildIndex(db) ──> │  return cached
    │  (parallel load     │
    │   6 tables)         │
    v                     v
SearchIndex (in-memory singleton)
    │
    v
Search Engine / Compare Engine
    │
    │ Pure computation against in-memory data
    │ No additional DB queries
    v
JSON Response ──> Client
```

### Client-Side Cache Flow (Compare)

```
addTutor(id) ──> fetchCompare(allIds, week, { fetchOnly: [newId] })
                      │
                      v
              POST /api/compare (server builds ALL tutors,
                                 returns only fetchOnly subset)
                      │
                      v
              Merge into tutorCache (Map<tutorGroupId:weekStart, CompareTutor>)
                      │
              Check snapshotId: if changed, clear cache + full refetch
                      │
                      v
              setCompareResponse({ ...data, tutors: mergedFromCache })

removeTutor(id) ──> delete from cache
                 ──> fetchCompare(remainingIds, week, { fetchOnly: [] })
                     (server recomputes conflicts/free-slots, returns none)
                 ──> merge: use cache for tutor data

changeWeek(w) ──> clear cache ──> full fetchCompare(allIds, newWeek)
```

## Key Abstractions

### Snapshot

- **Definition:** Versioned point-in-time capture of all tutor data
- **Tables:** `snapshots` (id, active, createdAt)
- **Lifecycle:** Created as `active=false` during sync, atomically promoted after validation. Only one active at a time. Failed syncs leave it inactive.
- **All data tables reference `snapshotId`** -- this enables clean rollback and parallel snapshot creation.

### IndexedTutorGroup

- **Definition:** In-memory denormalized aggregate of a tutor with all associated data
- **Fields:** id, displayName, supportedModes, qualifications[], wiseRecords[], availabilityWindows[], leaves[], sessionBlocks[], dataIssues[]
- **Pattern:** Loaded once from DB during `buildIndex()`, queried many times. The `byWeekday` map on `SearchIndex` provides O(1) weekday lookup to the relevant groups.

### IdentityGroup

- **Definition:** Logical grouping of multiple Wise teacher records that represent the same real person (e.g. online + onsite variants)
- **Resolution cascade:** nickname extraction -> alias table -> online/offline pair detection -> unresolved (solo group + data_issue)
- **Canonical key:** the resolved nickname or display name, used as the unique identifier for grouping

### WiseClient

- **Definition:** Rate-limited, retry-capable HTTP client for the Wise API
- **Pattern:** Queue-based concurrency limiter (configurable max), exponential backoff retry. Factory function `createWiseClient()` reads from env vars.

## Entry Points

### Pages

| Path | File | Type | Description |
|------|------|------|-------------|
| `/` | `src/app/page.tsx` | Server Component | Redirects to `/search` |
| `/login` | `src/app/login/page.tsx` | Page | Google sign-in |
| `/search` | `src/app/(app)/search/page.tsx` | Client Component | Side-by-side workspace |
| `/compare` | `src/app/(app)/compare/page.tsx` | Client Component | Redirects to `/search` |
| `/data-health` | `src/app/(app)/data-health/page.tsx` | Page | Sync status dashboard |

### API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/search` | Session | Slot-based availability search |
| POST | `/api/search/range` | Session | Range search with sub-slots |
| GET | `/api/filters` | Session | Dropdown filter options |
| GET | `/api/tutors` | Session | All tutor names/IDs |
| POST | `/api/compare` | Session | Compare 1-3 tutors |
| POST | `/api/compare/discover` | Session | Find candidate tutors |
| GET | `/api/data-health` | Session | Sync status + issues |
| POST | `/api/internal/sync-wise` | CRON_SECRET | Full sync pipeline |
| * | `/api/auth/[...nextauth]` | Public | Auth.js endpoints |

### Cron

| Schedule | Endpoint | Description |
|----------|----------|-------------|
| `0 0 * * *` (daily midnight UTC) | `POST /api/internal/sync-wise` | Full Wise sync |

## Error Handling

### Sync Errors

- **Per-teacher errors:** Caught individually in the teacher processing loop. Logged as `data_issues` with type `completeness` without aborting the sync. Other teachers continue processing.
- **Top-level sync errors:** Caught by the outer try-catch. Marks the sync_run as `failed` and preserves the previous active snapshot. Cleanup DB update errors are silently caught (`.catch(() => {})`) to avoid masking the original error.
- **Completeness threshold:** If >50% of identity groups are unresolved, the snapshot is NOT promoted. This prevents catastrophically bad data from going live.

### API Route Errors

- **Pattern:** All route handlers follow: auth check (401) -> JSON parse try-catch (400) -> Zod `.safeParse()` (400 with `parsed.error.flatten()`) -> business logic try-catch (500 with `err instanceof Error ? err.message : "...failed"`)
- **404:** Returned when no matching tutor groups found in active snapshot
- **Stale warnings:** Included in response `warnings[]` array when index data is >35 minutes old

### Search Index Staleness

- **Detection:** `ensureIndex()` queries for active snapshot ID on every call. If it differs from the cached index, triggers a rebuild.
- **Build guard:** Uses a `buildingPromise` singleton to prevent concurrent rebuilds -- subsequent callers await the same promise.
- **Stale flag:** Response includes `snapshotMeta.stale: boolean` when data age exceeds 35 minutes.

### Data Integrity

- **Fail-closed principle:** Unresolved identity/modality/qualification routes tutors to "Needs Review" rather than "Available".
- **Cancelled sessions:** Explicitly non-blocking (CANCELLED/CANCELED status check).
- **Unknown session statuses:** Treated as blocking (safe default).
- **Modality:** Never guessed; multi-step evidence chain with "unresolved" as fallback.

## Cross-Cutting Concerns

### Authentication

- **Library:** Auth.js v5 beta (`next-auth ^5.0.0-beta.30`) with Google provider
- **Gate:** `src/middleware.ts` intercepts all requests except `/login`, `/api/auth/*`, `/api/internal/*`. Unauthenticated users are redirected to `/login`.
- **Allowlisting:** `signIn` callback queries `admin_users` table. Only 8 allowlisted emails can sign in.
- **Internal endpoints:** `/api/internal/*` routes bypass session auth and use `CRON_SECRET` Bearer token instead.

### Timezone Handling

- **Canonical timezone:** All times normalized to `Asia/Bangkok` (UTC+7)
- **Conversion points:** Leave data (UTC from Wise -> Bangkok), availability windows (stored as minutes-since-midnight in Bangkok time), session blocks (stored with both timestamp and minute-of-day in Bangkok)
- **Client-side:** `useCompare` hook uses `toLocaleString("en-US", { timeZone: "Asia/Bangkok" })` for current Monday calculation

### Environment Validation

- **Library:** Zod schema validation in `src/lib/env.ts`
- **Behavior:** Validates all 9 required env vars at startup. Defaults provided for `WISE_NAMESPACE` and `WISE_INSTITUTE_ID`. Invalid vars throw immediately with flattened error details.

### Caching Strategy

- **Server-side:** `"use cache"` directive on `getFilterOptions()` and `getTutorList()` with `cacheTag("snapshot")` and `cacheLife("hours")`. Invalidated via `revalidateTag("snapshot")` after successful sync.
- **Client-side:** `useCompare` hook maintains `Map<string, CompareTutor>` cache keyed by `tutorGroupId:weekStart`. Invalidated on snapshot change (detected by comparing `snapshotMeta.snapshotId`), cleared on week navigation.
- **In-memory index:** `SearchIndex` singleton in `globalThis`. Rebuilt lazily when active snapshot changes. Building-promise guard prevents duplicate concurrent rebuilds.
