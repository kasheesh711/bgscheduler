# Architecture

**Analysis Date:** 2026-04-10

## Pattern Overview

**Overall:** Server-rendered Next.js 16 App Router with in-memory search index, snapshot-based data pipeline, and external API integration (Wise).

**Key Characteristics:**
- **Snapshot-based data model** -- all tutor data is versioned under a `snapshot_id`. The active snapshot is atomically promoted after a successful sync. Failed syncs preserve the previous active snapshot.
- **In-memory search index singleton** -- the entire active snapshot is loaded into a `SearchIndex` object in server memory. All search and compare queries run against this index with no additional DB queries. Stale detection triggers a rebuild when the active snapshot changes.
- **ETL pipeline** -- a sync orchestrator fetches from the Wise API, normalizes data through six domain-specific modules, writes to Postgres, and promotes a new snapshot.
- **Fail-closed safety** -- unresolved identity, modality, or qualification data routes tutors to "Needs Review", never "Available".

## Layers

**External API Client (`src/lib/wise/`):**
- Purpose: HTTP communication with the Wise scheduling platform
- Location: `src/lib/wise/`
- Contains: `client.ts` (HTTP client with retry/backoff/concurrency), `fetchers.ts` (domain fetchers for teachers, availability, sessions), `types.ts` (Wise API response shapes)
- Depends on: Nothing internal (pure HTTP + env vars)
- Used by: Sync orchestrator

**Normalization Layer (`src/lib/normalization/`):**
- Purpose: Transform raw Wise API data into canonical internal representations
- Location: `src/lib/normalization/`
- Contains: `identity.ts` (tutor identity resolution with 5-step cascade), `availability.ts` (working hours normalization), `leaves.ts` (leave normalization with UTC-to-Bangkok conversion), `sessions.ts` (session blocking classification), `qualifications.ts` (tag parsing into subject/curriculum/level), `modality.ts` (online/onsite derivation), `timezone.ts` (Asia/Bangkok timezone utilities)
- Depends on: Wise types
- Used by: Sync orchestrator

**Sync Orchestrator (`src/lib/sync/orchestrator.ts`):**
- Purpose: Full ETL pipeline -- fetch, normalize, persist, validate, promote
- Location: `src/lib/sync/orchestrator.ts`
- Contains: `runFullSync()` function (single entry point for the entire pipeline)
- Depends on: Wise client, all normalization modules, DB layer
- Used by: `POST /api/internal/sync-wise` route handler

**Database Layer (`src/lib/db/`):**
- Purpose: Postgres connection and schema definition
- Location: `src/lib/db/`
- Contains: `index.ts` (Neon serverless client singleton via `getDb()`), `schema.ts` (14 Drizzle ORM table definitions), `seed.ts` (admin user and alias seeding)
- Depends on: `@neondatabase/serverless`, `drizzle-orm`
- Used by: All server-side code (sync, search index, API routes, auth)

**Search Index (`src/lib/search/index.ts`):**
- Purpose: In-memory data structure for fast query execution
- Location: `src/lib/search/index.ts`
- Contains: Module-level singleton (`currentIndex`), `buildIndex()` (loads entire snapshot into memory with parallel DB queries), `ensureIndex()` (lazy init with stale detection), indexed data structures (`IndexedTutorGroup`, `SearchIndex`)
- Depends on: DB layer, schema
- Used by: Search engine, compare engine, API routes (filters, tutors)

**Search Engine (`src/lib/search/engine.ts`):**
- Purpose: Execute availability searches against the in-memory index
- Location: `src/lib/search/engine.ts`
- Contains: `executeSearch()` (slot-based search with recurring/one-time modes), blocking checks (sessions, leaves), qualification/modality filtering, multi-slot intersection
- Depends on: Search index, normalization/timezone
- Used by: `POST /api/search`, `POST /api/search/range`

**Compare Engine (`src/lib/search/compare.ts`):**
- Purpose: Build side-by-side tutor schedules, detect conflicts, find shared free slots
- Location: `src/lib/search/compare.ts`
- Contains: `buildCompareTutor()` (date-range filtered schedule assembly with weekday fallback), `detectConflicts()` (same-student overlap detection), `findSharedFreeSlots()` (interval intersection across tutors)
- Depends on: Search index types
- Used by: `POST /api/compare`, `POST /api/compare/discover`

**API Routes (`src/app/api/`):**
- Purpose: HTTP endpoints consumed by the frontend
- Location: `src/app/api/`
- Contains: Route handlers using Next.js App Router conventions
- Depends on: Auth, DB, search index, search engine, compare engine
- Used by: Frontend client components

**Frontend (`src/app/`, `src/components/`):**
- Purpose: Admin UI for searching and comparing tutor availability
- Location: `src/app/(app)/` (pages), `src/components/` (reusable components)
- Contains: Client components with `"use client"` directive, shadcn/ui primitives
- Depends on: API routes (via `fetch`), search types (shared type imports)
- Used by: End users (admin staff)

## Data Flow

**Sync Pipeline (daily cron or manual trigger):**

1. `POST /api/internal/sync-wise` validates `CRON_SECRET` bearer token (`src/app/api/internal/sync-wise/route.ts`)
2. `runFullSync()` creates a sync run record and candidate snapshot in Postgres (`src/lib/sync/orchestrator.ts`)
3. Fetches all teachers from Wise API via `fetchAllTeachers()` (`src/lib/wise/fetchers.ts`)
4. Resolves tutor identities (nickname extraction, alias lookup, online/offline pairing) via `resolveIdentities()` (`src/lib/normalization/identity.ts`)
5. For each teacher: fetches availability/leaves via `fetchTeacherFullAvailability()`, normalizes working hours, leaves, and tags
6. Fetches all future sessions via `fetchAllFutureSessions()`, normalizes blocking status
7. Derives modality for each identity group via `deriveModality()` (`src/lib/normalization/modality.ts`)
8. Batch-inserts all normalized data into snapshot-scoped tables (chunked at 250 rows)
9. Validates completeness (>50% unresolved = no promotion), atomically promotes snapshot
10. Updates sync run record with success/failure status

**Search Query (user-initiated):**

1. Frontend `POST`s to `/api/search/range` with day, time window, duration, mode, and filters
2. Route handler calls `ensureIndex(db)` -- loads or reuses the in-memory singleton (`src/lib/search/index.ts`)
3. Generates sub-slots from the time range, delegates to `executeSearch()` (`src/lib/search/engine.ts`)
4. Engine iterates tutor groups by weekday index, checks availability windows, blocking sessions, leaves, qualifications, modality
5. Returns grid of tutors x sub-slots with available/blocked/needs-review status

**Compare Query (user-initiated):**

1. Frontend `POST`s to `/api/compare` with tutor IDs, week start, optional `fetchOnly` param
2. Route handler calls `ensureIndex(db)`, looks up indexed groups
3. `buildCompareTutor()` filters sessions by date range, applies weekday fallback for missing data (`src/lib/search/compare.ts`)
4. `detectConflicts()` finds same-student overlaps across selected tutors
5. `findSharedFreeSlots()` computes interval intersection of free time across all tutors
6. If `fetchOnly` is provided, only serializes the requested tutor subset (conflicts/free-slots always use full set)

**State Management:**
- **Server state**: Module-level singleton `currentIndex` in `src/lib/search/index.ts`. Rebuilt lazily when active snapshot changes.
- **Client state**: React `useState` in `src/app/(app)/search/page.tsx`. Client-side tutor cache (`Map<string, CompareTutor>`) keyed by `tutorGroupId:weekStart` with incremental fetch. AbortController for request cancellation.
- **Persistent client state**: Recent searches in `localStorage` (last 10).

## Key Abstractions

**Snapshot (`snapshots` table):**
- Purpose: Versioned point-in-time capture of all tutor data
- Examples: `src/lib/db/schema.ts` (table definition), `src/lib/sync/orchestrator.ts` (creation/promotion)
- Pattern: Only one snapshot is `active = true` at a time. All data tables reference a `snapshotId`.

**IndexedTutorGroup (`src/lib/search/index.ts`):**
- Purpose: In-memory representation of a tutor with all associated data (qualifications, availability, sessions, leaves, issues)
- Examples: `src/lib/search/index.ts` (interface + build logic)
- Pattern: Denormalized aggregate loaded once, queried many times. The `byWeekday` map provides O(1) weekday lookup.

**Identity Group (`src/lib/normalization/identity.ts`):**
- Purpose: Logical grouping of multiple Wise teacher records that represent the same real person (e.g. online + onsite variants)
- Examples: `src/lib/normalization/identity.ts` (`IdentityGroup` interface), `src/lib/db/schema.ts` (`tutorIdentityGroups` + `tutorIdentityGroupMembers` tables)
- Pattern: 5-step cascade resolution: nickname extraction -> alias table lookup -> online/offline pair detection -> unresolved -> data_issue

**WiseClient (`src/lib/wise/client.ts`):**
- Purpose: Rate-limited, retry-capable HTTP client for the Wise API
- Examples: `src/lib/wise/client.ts`
- Pattern: Queue-based concurrency limiter (max 5 or 15 concurrent), exponential backoff (1s/2s/4s), Basic Auth + API key headers

## Entry Points

**Root page (`src/app/page.tsx`):**
- Location: `src/app/page.tsx`
- Triggers: User navigates to `/`
- Responsibilities: Redirects to `/search`

**Search page (`src/app/(app)/search/page.tsx`):**
- Location: `src/app/(app)/search/page.tsx`
- Triggers: User navigates to `/search`
- Responsibilities: Renders the side-by-side search + compare workspace. Client component with `"use client"` directive. All data fetching via `fetch()` to API routes.

**Sync endpoint (`src/app/api/internal/sync-wise/route.ts`):**
- Location: `src/app/api/internal/sync-wise/route.ts`
- Triggers: Vercel cron (daily at midnight UTC) or manual `curl` with CRON_SECRET
- Responsibilities: Runs the full sync pipeline. `maxDuration = 300` (5 minutes).

**Middleware (`src/middleware.ts`):**
- Location: `src/middleware.ts`
- Triggers: Every request (except static assets)
- Responsibilities: Auth gate. Allows `/login`, `/api/auth/*`, `/api/internal/*` without auth. Redirects unauthenticated users to `/login`.

## Error Handling

**Strategy:** Fail-closed for data integrity, try-catch with JSON error responses for API routes.

**Patterns:**
- **Sync errors**: Per-teacher errors are caught and logged as `data_issues` without aborting the entire sync. Top-level sync errors mark the sync run as `failed` and preserve the previous active snapshot. (`src/lib/sync/orchestrator.ts` lines 239-249, 443-468)
- **API route errors**: All route handlers wrap logic in try-catch, return `{ error: string }` with appropriate HTTP status codes (400, 401, 404, 500). Zod schema validation with `.safeParse()` returns 400 with flattened error details. (`src/app/api/compare/route.ts` lines 53-65)
- **Search index staleness**: `ensureIndex()` checks active snapshot on every call. Stale data is flagged in response `warnings` array and `snapshotMeta.stale` boolean. (`src/lib/search/index.ts` lines 252-274)
- **Data integrity**: Unresolved identity/modality/qualification routes tutors to "Needs Review" rather than silently omitting them. Cancelled sessions are explicitly non-blocking. Unknown session statuses are blocking (fail-closed). (`src/lib/search/engine.ts` lines 83-93)

## Cross-Cutting Concerns

**Logging:** `console.error` only, no structured logging framework. Used in `src/lib/env.ts` for env validation failures.

**Validation:** Zod schemas at API boundaries (`src/app/api/*/route.ts`). Zod schema for environment variables (`src/lib/env.ts`). No runtime validation in internal library code.

**Authentication:** Auth.js (NextAuth v5) with Google provider. Middleware-level auth gate (`src/middleware.ts`). Admin allowlisting via `admin_users` Postgres table checked in `signIn` callback (`src/lib/auth.ts`). API routes individually call `auth()` and return 401. Internal sync endpoint uses `CRON_SECRET` bearer token instead.

**Timezone:** All times normalized to `Asia/Bangkok`. Conversion utilities in `src/lib/normalization/timezone.ts`. Weekday numbers use JS convention (0=Sunday, 6=Saturday).

---

*Architecture analysis: 2026-04-10*
