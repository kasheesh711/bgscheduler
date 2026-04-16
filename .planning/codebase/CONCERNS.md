# Codebase Concerns

**Analysis Date:** 2026-04-16

## Tech Debt

### TD-1: Duplicated date/time helper functions

- **Issue:** `getCurrentMonday`, `formatIsoDate`, `shiftWeek`, `formatMinute`, `formatDate`, `addDays`, `parseMondayDate` are reimplemented across multiple files with slight variations.
- **Files:**
  - `src/hooks/use-compare.ts` (lines 12-68) -- `formatIsoDate`, `getCurrentMonday`, `getMondayForDate`, `shiftWeek`, `formatWeekLabel`, `getWeekDate`, `formatMinute`
  - `src/app/api/compare/route.ts` (lines 20-44) -- `getCurrentMonday`, `parseMondayDate`, `addDays`, `formatIsoDate`
  - `src/lib/search/compare.ts` (lines 14-25) -- `formatMinute`, `formatDate`
  - `src/lib/search/engine.ts` (line 187-191) -- `formatMinuteToHHMM`
- **Impact:** Bug risk from inconsistent implementations. Four different `formatMinute`/`formatMinuteToHHMM` functions exist with different output formats (12h vs 24h). The `getCurrentMonday` function is duplicated between the client hook and the API route.
- **Fix approach:** Consolidate into `src/lib/dates.ts` and import everywhere. The existing `src/lib/normalization/timezone.ts` is too narrow (only `parseTimeToMinutes`).

### TD-2: No old snapshot cleanup

- **Issue:** Every sync creates a new snapshot with rows across 10+ tables. Old snapshots are never deleted. Schema has no `ON DELETE CASCADE` on foreign keys.
- **Files:** `src/lib/sync/orchestrator.ts`, `src/lib/db/schema.ts`
- **Impact:** Database grows indefinitely. With daily syncs producing ~131 teachers and thousands of related rows, dead data accumulates. Neon free/hobby tier has storage limits.
- **Fix approach:** Add a post-sync cleanup step that deletes snapshots older than N days (keeping active). Add `ON DELETE CASCADE` to all `snapshotId` foreign keys in schema.

### TD-3: Sequential teacher processing in sync

- **Issue:** Sync processes teachers one-by-one in a `for` loop (`src/lib/sync/orchestrator.ts` lines 146-249), calling `fetchTeacherFullAvailability` per teacher. With 131 teachers and 26 seven-day leave windows each, this creates ~3400+ requests despite the concurrency limiter supporting 15 parallel requests.
- **Files:** `src/lib/sync/orchestrator.ts` (lines 146-249), `src/lib/wise/fetchers.ts`
- **Impact:** Sync takes ~4m26s with only ~34s margin before the 5-minute Vercel timeout. Adding more teachers could exceed the limit.
- **Fix approach:** Batch teacher availability fetches with `Promise.all` in chunks (e.g., 10 teachers), letting the WiseClient concurrency limiter manage HTTP traffic.

### TD-4: Linear tutor group lookup in API routes

- **Issue:** `src/app/api/compare/route.ts` (line 86) and `src/app/api/search/range/route.ts` (line 139) use `index.tutorGroups.find()` -- O(n) per lookup.
- **Files:** `src/app/api/compare/route.ts`, `src/app/api/search/range/route.ts`, `src/app/api/compare/discover/route.ts` (line 66)
- **Impact:** Negligible with 72 groups, but indicates a missing `Map<id, group>` in the `SearchIndex`.
- **Fix approach:** Add `byId: Map<string, IndexedTutorGroup>` to `SearchIndex` in `src/lib/search/index.ts` and populate during `buildIndex`.

### TD-5: eslint-disable comments suppressing real warnings

- **Issue:** Five `eslint-disable` comments in the codebase suppress potentially real issues.
- **Files:**
  - `src/lib/db/index.ts:17` -- `eslint-disable-next-line no-var` (globalThis pattern, acceptable)
  - `src/lib/search/index.ts:77,79` -- `eslint-disable-next-line no-var` (globalThis pattern, acceptable)
  - `src/components/search/search-workspace.tsx:42` -- `eslint-disable-line react-hooks/exhaustive-deps` (missing dependency in effect)
  - `src/components/compare/week-calendar.tsx:36` -- `eslint-disable-line react-hooks/exhaustive-deps` (missing dependency in effect)
- **Impact:** The two `react-hooks/exhaustive-deps` suppressions may mask stale closure bugs. Missing dependencies in `useEffect` can cause subtle state sync issues.
- **Fix approach:** Audit the suppressed effects and either add the missing deps or document why they are intentionally omitted.

### TD-6: Non-null assertions on environment variables in WiseClient

- **Issue:** `src/lib/wise/client.ts` (lines 118-119) uses `process.env.WISE_USER_ID!` and `process.env.WISE_API_KEY!` with non-null assertions. Env validation exists in `src/lib/env.ts` but `createWiseClient()` does not use it.
- **Files:** `src/lib/wise/client.ts` (lines 116-123)
- **Impact:** If env vars are missing at runtime (e.g., misconfigured deployment), the app sends malformed API requests with `undefined` credentials instead of failing fast.
- **Fix approach:** Add explicit checks in `createWiseClient()` or import from the validated `env` module.

### TD-7: Identity group insertion is sequential in sync

- **Issue:** Identity groups are inserted one-by-one in a `for` loop (`src/lib/sync/orchestrator.ts` lines 101-125) with individual `.returning()` calls to get DB-generated IDs, while member rows are batch-inserted afterward.
- **Files:** `src/lib/sync/orchestrator.ts` (lines 101-129)
- **Impact:** With 72 groups, this is 72 sequential INSERT statements. Minor latency impact currently but would scale poorly.
- **Fix approach:** Batch insert groups and retrieve IDs in a single query.

## Known Bugs

### BUG-1: Online/onsite detection heuristic unreliable (documented)

- **Symptoms:** Most sessions classified as "onsite" or "unknown" because location fields contain venue names ("Think Outside the Box", "Tesla", "Nerd") that don't match URL or keyword patterns.
- **Files:** `src/lib/search/compare.ts` (lines 4-70 -- `resolveSessionModality`), `src/lib/normalization/modality.ts`
- **Trigger:** Any session at a physical venue with a creative name.
- **Current status:** Visual distinction removed from cards. Modality info still appears in popovers but may be inaccurate. Needs a more reliable data source (possibly `sessionType` from Wise or `isOnlineVariant` flag).

### BUG-2: Past-day session data gap (documented)

- **Symptoms:** For days earlier than the current date, the compare view shows "fallback" sessions from the nearest future occurrence of recurring sessions. One-time past sessions are permanently missing.
- **Files:** `src/lib/search/compare.ts` (lines 88-117 -- fallback logic in `buildCompareTutor`)
- **Trigger:** Navigating to the current week where some days have passed, or past weeks.
- **Root cause:** Wise's `status: "FUTURE"` API does not return past sessions. The fallback uses `recurrenceId` deduplication, acceptable for recurring schedules but fundamentally inaccurate for one-time sessions.

### BUG-3: Potential infinite recursion in tutor cache snapshot invalidation

- **Symptoms:** If the server snapshot ID keeps changing between requests, the `fetchCompare` function in `src/hooks/use-compare.ts` (lines 123-129) recursively calls itself without a retry limit.
- **Files:** `src/hooks/use-compare.ts` (lines 123-129)
- **Trigger:** Rapid successive syncs or race condition during snapshot promotion.
- **Current mitigation:** Practically unlikely (syncs run daily), but no guard exists. A sync during active user sessions could trigger this.
- **Fix approach:** Add a retry counter parameter to the recursive call and bail after 1-2 retries.

### BUG-4: Recurring leave conflict check uses date iteration

- **Symptoms:** `hasRecurringLeaveConflict` in `src/lib/search/engine.ts` (lines 240-270) iterates day-by-day through each leave range to check weekday matches. For long leaves (e.g., 30-day leave), this creates 30 iterations per leave.
- **Files:** `src/lib/search/engine.ts` (lines 240-270)
- **Impact:** Performance degrades with many long leaves. Currently negligible but fundamentally O(leave_days) per leave check.
- **Fix approach:** Instead of iterating days, compute whether the leave range covers any occurrence of the target weekday using modular arithmetic.

## Security Considerations

### SEC-1: No rate limiting on API endpoints

- **Risk:** All authenticated API endpoints have no rate limiting. An authenticated user could flood the server.
- **Files:** All routes in `src/app/api/`
- **Current mitigation:** Auth required on all routes (middleware + per-route checks). Only 8 allowlisted admin emails. Vercel has implicit DDoS protection at the edge.
- **Recommendation:** Low priority given the 8-user base. If the pool grows, add rate limiting.

### SEC-2: Sync endpoint uses shared secret only

- **Risk:** `/api/internal/sync-wise` is protected by a single `CRON_SECRET` Bearer token. If leaked, anyone can trigger a full sync, causing DB writes and Wise API load.
- **Files:** `src/app/api/internal/sync-wise/route.ts` (lines 10-14)
- **Current mitigation:** Secret stored in Vercel env vars. Endpoint not exposed in UI. Middleware allows `/api/internal/*` without auth (`src/middleware.ts` line 12).
- **Recommendation:** Acceptable. Vercel Cron Jobs natively include a `CRON_SECRET` verification header. Consider validating the `x-vercel-cron-signature` header for defense in depth.

### SEC-3: Middleware allows all /api/internal/* paths without auth

- **Risk:** The middleware auth bypass (`src/middleware.ts` line 12) uses `pathname.startsWith("/api/internal/")` -- any future internal route would also bypass auth.
- **Files:** `src/middleware.ts` (line 12)
- **Impact:** Currently only one internal route exists (`sync-wise`), which has its own CRON_SECRET check. But adding another internal route without its own auth would create an unauthenticated endpoint.
- **Recommendation:** Add a comment documenting the expectation that all internal routes must self-authenticate. Consider narrowing to specific paths.

### SEC-4: Admin allowlist is database-only with no audit trail

- **Risk:** The `admin_users` table controls access but has no audit trail for additions/removals. Changes require direct DB access.
- **Files:** `src/lib/db/schema.ts` (lines 67-74), `src/lib/auth.ts` (lines 19-29)
- **Impact:** No visibility into who added/removed admins or when. The seed script (`src/lib/db/seed.ts`) is the only documented way to add users.
- **Recommendation:** Low priority for 8 users. Consider adding an `updated_at` column and an admin management page if the user base grows.

### SEC-5: Auth callback performs a DB query on every sign-in attempt

- **Risk:** Every Google sign-in attempt triggers a `SELECT` from `admin_users` (`src/lib/auth.ts` lines 22-28). No caching or throttling.
- **Files:** `src/lib/auth.ts` (lines 19-29)
- **Impact:** Minimal with 8 users. Could be used to enumerate valid emails via timing attacks, though the response is boolean-only.
- **Recommendation:** Acceptable for current scale.

## Performance Bottlenecks

### PERF-1: In-memory search index staleness check queries DB on every request

- **Problem:** `ensureIndex()` (`src/lib/search/index.ts` lines 272-296) queries the active snapshot ID on every API request to check staleness. If stale, it rebuilds from 6 parallel DB queries.
- **Files:** `src/lib/search/index.ts` (lines 272-296, 110-267)
- **Cause:** Serverless functions may cold-start independently. Each instance needs its own index. The DB query per request is the staleness detection cost.
- **Impact:** Adds ~10-50ms per request for the staleness check. Full rebuild is <400ms for current data volume.
- **Improvement:** Consider caching the snapshot ID in a short-lived KV store or using a time-based TTL to reduce DB round-trips.

### PERF-2: Sync approaching Vercel function timeout

- **Problem:** Full sync takes ~4m26s vs 5-minute ceiling (`maxDuration = 300`).
- **Files:** `src/app/api/internal/sync-wise/route.ts` (line 7), `src/lib/sync/orchestrator.ts`
- **Cause:** Sequential teacher processing (TD-3) and 26 seven-day leave window fetches per teacher.
- **Impact:** ~34s headroom. Adding 15-20 more teachers could breach the limit.
- **Improvement:** Parallelize teacher availability fetches. Alternatively, split sync into phases with multiple function invocations.

### PERF-3: Issue-to-group matching is O(issues x groups) during index build

- **Problem:** In `buildIndex` (`src/lib/search/index.ts` lines 166-181), every data issue is matched against every group via nested loop checking `entityId`, group `id`, and `entityName`. With 251 issues and 72 groups: ~18,000 comparisons.
- **Files:** `src/lib/search/index.ts` (lines 166-181)
- **Cause:** Issues lack a direct `groupId` foreign key -- use string matching on `entityId`/`entityName`.
- **Improvement:** Pre-build a lookup `Map<canonicalKey|groupId|displayName, groupId>` before iterating issues. Or add a `groupId` column to `data_issues`.

### PERF-4: Discovery endpoint computes conflicts for every candidate tutor

- **Problem:** `POST /api/compare/discover` (`src/app/api/compare/discover/route.ts` lines 75-134) iterates all tutor groups, builds a `CompareTutor` for each, and runs `detectConflicts` for each candidate against existing tutors. With 72 groups and 2 existing tutors, this is 70 conflict detection runs.
- **Files:** `src/app/api/compare/discover/route.ts` (lines 75-134)
- **Impact:** Latency scales linearly with tutor count. Currently acceptable but could become slow at scale.
- **Improvement:** Pre-compute a student-session index and check conflicts via lookup rather than rebuilding per candidate.

### PERF-5: Leave stitching fetches 26 windows sequentially per teacher

- **Problem:** `fetchTeacherFullAvailability` (`src/lib/wise/fetchers.ts` lines 49-91) fetches the first window sequentially, then parallelizes the remaining 25 windows. However, the initial sequential call adds latency.
- **Files:** `src/lib/wise/fetchers.ts` (lines 49-91)
- **Impact:** Minor per-teacher overhead. The first window must be sequential to extract `workingHours`, which is correct behavior. The parallelized batch (lines 74-89) is efficient.
- **Note:** This is a design trade-off, not a pure bottleneck. The first call must complete to get `workingHours` before proceeding.

## Fragile Areas

### FRAG-1: Snapshot promotion is not truly atomic

- **Files:** `src/lib/sync/orchestrator.ts` (lines 404-419)
- **Why fragile:** Promotion uses two separate SQL statements -- deactivate old (lines 407-412) then activate new (lines 414-418). If the function crashes between these, the system has zero active snapshots and all API requests fail with "No active snapshot found" (`src/lib/search/index.ts` line 119).
- **Impact:** Complete service outage until manual DB intervention.
- **Fix approach:** Wrap both operations in a single transaction. Neon supports transactions via the Drizzle ORM `db.transaction()` API.
- **Test coverage:** No integration test covers the promotion path.

### FRAG-2: Identity resolution depends on parenthetical nickname convention

- **Files:** `src/lib/normalization/identity.ts` (lines 43-46, 72-182)
- **Why fragile:** The entire pipeline assumes teachers have nicknames in parentheses (e.g., "Chinnakrit (Celeste) Channiti"). Teachers without this convention fall to "unresolved" and require manual alias entries. The alias table has only 4 entries.
- **Impact:** If Wise changes their display name format, identity resolution silently produces wrong groupings. No alerting beyond data_issues count.
- **Test coverage:** Good unit tests in `src/lib/normalization/__tests__/identity.test.ts`.

### FRAG-3: Client-side tutor cache invalidation logic

- **Files:** `src/hooks/use-compare.ts` (lines 74-220)
- **Why fragile:** The `useRef(new Map<string, CompareTutor>())` cache keyed by `tutorGroupId:weekStart` has invalidation logic across 4 functions: `fetchCompare` (lines 88-159), `removeTutor` (lines 161-171), `addTutor` (lines 173-187), `changeWeek` (lines 189-195). Week changes clear the entire cache. Snapshot changes trigger a recursive refetch (lines 123-129) without a retry limit (see BUG-3).
- **Test coverage:** Zero -- no frontend tests.

### FRAG-4: Wise API contract dependencies

- **Files:** `src/lib/wise/types.ts`, `src/lib/wise/fetchers.ts`, `src/lib/wise/client.ts`
- **Why fragile:** The entire data pipeline depends on Wise API response shapes. Types are manually defined (`WiseTeacher`, `WiseSession`, `WiseAvailabilityResponse`) without runtime validation (no Zod schemas on API responses). If Wise changes a field name or nests data differently, the sync silently produces empty/wrong data.
- **Impact:** A Wise API breaking change could corrupt the next sync without any error. The `WiseTeachersResponse` expects `res.data?.teachers`, `WiseSessionsResponse` expects `res.data?.sessions` -- a structural change would return empty arrays.
- **Mitigation:** The `fetchWithRetry` in `src/lib/wise/client.ts` does not validate response structure, only HTTP status codes.

### FRAG-5: Retry logic retries all errors indiscriminately

- **Files:** `src/lib/wise/client.ts` (lines 67-91)
- **Why fragile:** `fetchWithRetry` catches all errors and retries, including 400 Bad Request, 403 Forbidden, and 404 Not Found. Only a non-OK HTTP status throws, but the catch block retries both network errors and HTTP errors alike.
- **Impact:** Wasted retry attempts on permanent failures (e.g., wrong API key returns 403 three times). No distinction between transient (5xx, network) and permanent (4xx) errors.
- **Fix approach:** Only retry on 429, 5xx, or network errors. Fail immediately on 4xx.

### FRAG-6: Modality derivation produces many "unresolved" results

- **Files:** `src/lib/normalization/modality.ts` (lines 23-92)
- **Why fragile:** Single offline records with no session evidence fall to "unresolved" (lines 67-79). With 131 teachers, many single-record tutors get unresolved modality, routing them to "Needs Review" in search results. The current sync logged 251 data issues, many from this.
- **Impact:** Reduces the pool of searchable "Available" tutors. Admins see large "Needs Review" sections.

## Scaling Limits

### SCALE-1: Vercel Hobby plan constraints

- **Current:** Daily cron (once per 24 hours), 5-minute function timeout, limited compute.
- **Limit:** Sync cadence cannot go below daily without upgrading to Pro ($20/mo). Sync uses 89% of timeout.
- **Path:** Upgrade to Vercel Pro for 30-minute cron. Parallelize teacher fetches.

### SCALE-2: In-memory index size

- **Current:** ~72 tutor groups with all data fits in serverless memory.
- **Limit:** At ~1000+ tutors with proportional sessions/availability/leaves, could exceed Vercel's 1GB memory limit.
- **Path:** Move to Redis/KV-backed index or paginated search.

### SCALE-3: Database growth from orphan snapshots

- **Current:** One snapshot per day, no cleanup.
- **Limit:** Each snapshot creates rows in 10+ tables. After 6 months: ~180 snapshots with millions of orphan rows.
- **Path:** Add cleanup job (see TD-2).

## Dependencies at Risk

### DEP-1: next-auth beta version

- **Risk:** Using `next-auth@^5.0.0-beta.30` -- pre-release. Breaking changes expected before stable.
- **Files:** `src/lib/auth.ts`, `src/middleware.ts`
- **Impact:** Auth flow could break on update. The `auth()` wrapper in middleware uses the beta API surface.
- **Mitigation:** Pin exact version. Monitor Auth.js releases.

### DEP-2: Wise API availability and stability

- **Risk:** The entire data pipeline depends on `https://api.wiseapp.live` being available and maintaining its current contract.
- **Files:** `src/lib/wise/client.ts`, `src/lib/wise/fetchers.ts`, `src/lib/wise/types.ts`
- **Impact:** Wise downtime = failed sync = stale data. Wise contract change = silent data corruption. No health check or circuit breaker exists.
- **Mitigation:** Retry/backoff logic handles transient failures. Fail-closed safety prevents corrupt data from being promoted (50% threshold). No runtime schema validation on Wise responses (see FRAG-4).

### DEP-3: Neon Postgres availability

- **Risk:** Single Neon database in ap-southeast-1. No read replicas, no failover.
- **Files:** `src/lib/db/index.ts`
- **Impact:** Neon outage = complete service outage (search, compare, sync all require DB access for at least staleness checks).
- **Mitigation:** Neon provides automatic backups. The in-memory index can serve cached results during brief outages, but `ensureIndex()` queries DB on every request.

### DEP-4: @base-ui/react and shadcn/ui ecosystem

- **Risk:** Using `@base-ui/react@^1.3.0` (headless components from MUI). The Popover render prop pattern may change.
- **Files:** `src/components/compare/week-overview.tsx`, components in `src/components/ui/`
- **Impact:** UI component breakage on major updates.
- **Mitigation:** Pin version. Usage is limited.

## Data Integrity Risks

### DI-1: Non-atomic snapshot promotion (see FRAG-1)

Two separate UPDATE statements for deactivation/activation. Crash between them leaves zero active snapshots.

### DI-2: Promotion threshold may be too permissive

- **Files:** `src/lib/sync/orchestrator.ts` (lines 397-400)
- **Issue:** The 50% unresolved ratio threshold allows promotion even if 49% of identity groups have issues. With 72 groups, up to 35 groups could be unresolved and the snapshot still promotes.
- **Impact:** A corrupted sync with 49% issues would overwrite good data.
- **Consideration:** The threshold is a trade-off between data freshness and accuracy. Tightening it risks blocking promotion on legitimate data quality variation.

### DI-3: Orphan candidate snapshot on sync failure

- **Files:** `src/lib/sync/orchestrator.ts` (lines 52-65, 443-468)
- **Issue:** When sync fails, the candidate snapshot and its inserted rows remain in the DB with `active: false`. The error handler updates the `sync_runs` status but does not delete the orphan snapshot.
- **Impact:** Orphan snapshots accumulate. Combined with TD-2 (no cleanup), this compounds database growth.

### DI-4: Stale search results served without user notification

- **Files:** `src/lib/search/engine.ts` (lines 30-37), `src/app/api/compare/route.ts` (lines 75-83)
- **Issue:** The 35-minute stale threshold (`Date.now() - index.builtAt.getTime() > 35 * 60 * 1000`) produces a warning string but does not block results. With daily syncs, data is 23+ hours stale for most of the day.
- **Impact:** Users see availability data from up to 24 hours ago without prominent indication. The stale warning is present in API responses but may not be surfaced prominently in the UI.

## Missing Features Affecting Reliability

### MISS-1: No admin UI for managing aliases

- **Problem:** Alias mappings can only be managed via direct DB access or seed script. 4 aliases exist.
- **Blocks:** Non-technical admins cannot resolve identity issues independently.

### MISS-2: No alerting on sync failures

- **Problem:** Failed syncs produce no notification. Discovery requires manual `/data-health` page checks.
- **Impact:** Stale data could persist for days unnoticed.

### MISS-3: No Wise API response validation

- **Problem:** Wise API responses are cast to TypeScript types without runtime validation. No Zod schemas on incoming data.
- **Impact:** Silent data corruption if Wise changes their API contract.

## Test Coverage Gaps

### TEST-1: Zero frontend/component tests

- **What's untested:** All React components, page components, client-side caching, URL param handling, week picker navigation.
- **Key files:** `src/hooks/use-compare.ts`, `src/components/compare/week-overview.tsx`, `src/components/compare/calendar-grid.tsx`, `src/components/search/search-form.tsx`
- **Risk:** UI regressions undetected. The compare hook has complex cache/abort logic with zero verification.

### TEST-2: No API route integration tests

- **What's untested:** All API route handlers. Auth middleware, Zod validation edge cases, error responses, end-to-end data flow.
- **Key files:** `src/app/api/search/range/route.ts`, `src/app/api/compare/route.ts`, `src/app/api/compare/discover/route.ts`
- **Risk:** API contract changes silently break the frontend.

### TEST-3: No sync orchestrator integration tests

- **What's untested:** Full sync pipeline -- snapshot creation, insertion, validation thresholds, promotion, error recovery.
- **Key files:** `src/lib/sync/orchestrator.ts`
- **Risk:** Regression in the most critical system process. The 50% threshold and promotion logic are untested.

### TEST-4: No test for `ensureIndex` rebuild behavior

- **What's untested:** Index staleness detection, concurrent rebuild prevention (the `getBuildingPromise` guard), and behavior when no active snapshot exists.
- **Key files:** `src/lib/search/index.ts` (lines 272-296)
- **Risk:** Concurrent index builds could occur if the promise guard fails.

---

*Concerns audit: 2026-04-16*
