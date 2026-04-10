# Codebase Concerns

**Analysis Date:** 2026-04-10

## Tech Debt

**Monolithic search page component (878 lines):**
- Issue: `src/app/(app)/search/page.tsx` is a single "use client" component with all search state, compare state, week picker logic, caching, and rendering in one file. Contains 30+ `useState` calls, inline fetch logic, and helper functions that belong in shared modules.
- Files: `src/app/(app)/search/page.tsx`
- Impact: Hard to maintain, test, or refactor. Any change risks regretting side effects across unrelated UI sections. No unit tests exist for any frontend component.
- Fix approach: Extract into composable hooks (`useSearchState`, `useCompareState`, `useWeekPicker`, `useTutorCache`). Move date formatting helpers (`getCurrentMonday`, `shiftWeek`, `formatIsoDate`, `formatWeekLabel`) into a shared `src/lib/dates.ts` module. The same `getCurrentMonday` and `formatIsoDate` functions are duplicated in both `src/app/(app)/search/page.tsx` and `src/app/api/compare/route.ts`.

**Duplicated date/time helper functions:**
- Issue: `getCurrentMonday`, `formatIsoDate`, `shiftWeek`, `formatMinute`, `minuteToLabel` are reimplemented across multiple files with slight variations.
- Files: `src/app/(app)/search/page.tsx` (lines 63-102, 870-878), `src/app/api/compare/route.ts` (lines 20-44), `src/lib/search/compare.ts` (lines 14-25), `src/components/compare/week-overview.tsx` (lines 27-36)
- Impact: Bug risk from inconsistent implementations. Maintenance burden when date logic needs updating.
- Fix approach: Consolidate into `src/lib/dates.ts` and import everywhere. The existing `src/lib/normalization/timezone.ts` (34 lines) is too narrow — it only has `parseTimeToMinutes`.

**No old snapshot cleanup:**
- Issue: Every sync creates a new snapshot with associated rows across 10+ tables (`tutor_identity_groups`, `tutor_identity_group_members`, `recurring_availability_windows`, `dated_leaves`, `future_session_blocks`, `raw_teacher_tags`, `subject_level_qualifications`, `data_issues`, `snapshot_stats`, `tutors`). Old snapshots are never deleted. The schema has no `ON DELETE CASCADE` on foreign keys.
- Files: `src/lib/sync/orchestrator.ts`, `src/lib/db/schema.ts`
- Impact: Database grows indefinitely. With daily syncs producing ~131 teachers and thousands of related rows, the DB will accumulate significant dead data over months. Neon free/hobby tier has storage limits.
- Fix approach: Add a post-sync cleanup step in `orchestrator.ts` that deletes snapshots older than N days (keeping the active one). Add `ON DELETE CASCADE` to all `snapshotId` foreign keys in `src/lib/db/schema.ts` so a single snapshot delete cascades through all child tables.

**Sequential teacher processing in sync:**
- Issue: The sync orchestrator processes teachers sequentially in a `for` loop (line 146-249 in `src/lib/sync/orchestrator.ts`), calling `fetchTeacherFullAvailability` one teacher at a time. With 131 teachers and 26 seven-day windows each for leaves, this creates ~3400+ sequential API calls despite the concurrency limiter supporting 15 parallel requests (`src/lib/wise/client.ts` line 122).
- Files: `src/lib/sync/orchestrator.ts` (lines 146-249), `src/lib/wise/fetchers.ts`
- Impact: Sync takes ~4m26s with only ~34s margin before the 5-minute Vercel function timeout. Adding more teachers could push past the limit.
- Fix approach: Batch teacher availability fetches with `Promise.all` in chunks (e.g., 10 teachers at a time), letting the WiseClient concurrency limiter manage the underlying HTTP requests. The `fetchTeacherFullAvailability` function already parallelizes its internal leave windows.

**Linear tutor group lookup in compare API:**
- Issue: `src/app/api/compare/route.ts` (line 86-87) uses `.find()` to locate tutor groups in the index by ID. `src/app/api/search/range/route.ts` (line 139) does the same.
- Files: `src/app/api/compare/route.ts`, `src/app/api/search/range/route.ts`
- Impact: O(n) lookup for each tutor ID. With 72 groups this is negligible, but it indicates a missing `Map<id, group>` in the `SearchIndex` structure.
- Fix approach: Add a `byId: Map<string, IndexedTutorGroup>` field to the `SearchIndex` interface in `src/lib/search/index.ts` and populate it during `buildIndex`.

## Known Bugs

**Online/onsite detection heuristic unreliable:**
- Symptoms: Most sessions are classified as "onsite" or "unknown" because the location field contains venue names like "Think Outside the Box", "Tesla", "Nerd" that don't match any pattern. The heuristic in `resolveSessionModality` (`src/lib/search/compare.ts` lines 27-70) checks for URL-like patterns or keywords, but real-world venue names don't match.
- Files: `src/lib/search/compare.ts` (lines 4-70), `src/lib/normalization/modality.ts`
- Trigger: Any session at a physical venue with a creative name.
- Workaround: Visual distinction was removed from cards. Modality info still appears in popovers but may be inaccurate.

**Past-day session data gap:**
- Symptoms: For days earlier than the current date, the compare week view shows "fallback" sessions pulled from the nearest future occurrence of recurring sessions. One-time past sessions are permanently missing.
- Files: `src/lib/search/compare.ts` (lines 88-117)
- Trigger: Navigating to the current week where some days have already passed, or navigating to past weeks.
- Workaround: Fallback logic uses `recurrenceId` deduplication and selects sessions from the nearest matching future date. Acceptable for recurring schedules but fundamentally inaccurate for one-time sessions.

## Security Considerations

**No rate limiting on API endpoints:**
- Risk: All API endpoints (`/api/search/range`, `/api/compare`, `/api/tutors`, `/api/filters`, `/api/data-health`) have no rate limiting. An authenticated user could flood the server with requests.
- Files: All files in `src/app/api/`
- Current mitigation: Auth required on all routes (middleware + per-route checks). Only 8 allowlisted admin emails.
- Recommendations: Low priority given the tiny user base (8 admins). If the user pool grows, add rate limiting via Vercel Edge Config or a middleware-based approach.

**Sync endpoint protected only by shared secret:**
- Risk: The `/api/internal/sync-wise` endpoint uses a single `CRON_SECRET` Bearer token for auth. If the secret leaks, anyone can trigger a full sync.
- Files: `src/app/api/internal/sync-wise/route.ts` (lines 10-13)
- Current mitigation: Endpoint is not exposed in any UI. Secret is stored in Vercel env vars.
- Recommendations: Acceptable for current setup. Consider adding IP allowlisting or Vercel's built-in cron authentication if the secret rotation cadence is infrequent.

**Non-null assertions on environment variables:**
- Risk: `src/lib/wise/client.ts` (lines 118-119) uses `process.env.WISE_USER_ID!` and `process.env.WISE_API_KEY!` with non-null assertions. If these are missing at runtime, the app will send malformed API requests rather than failing fast.
- Files: `src/lib/wise/client.ts` (line 118-120)
- Current mitigation: The DB module (`src/lib/db/index.ts`) properly validates `DATABASE_URL` with an explicit check.
- Recommendations: Add runtime validation in `createWiseClient()` that throws a clear error if env vars are missing, matching the pattern in `src/lib/db/index.ts`.

## Performance Bottlenecks

**In-memory search index rebuild on every snapshot change:**
- Problem: `ensureIndex()` in `src/lib/search/index.ts` (lines 252-274) queries the active snapshot ID on every API request, then rebuilds the entire index from 6 parallel DB queries if the snapshot changed. The index holds all tutor groups, availability, sessions, and leaves in memory.
- Files: `src/lib/search/index.ts` (lines 252-274, 90-247)
- Cause: The singleton pattern works within a single serverless function instance, but Vercel spins up multiple instances. Each cold start triggers a full rebuild. The staleness check also queries the DB on every request.
- Improvement path: For the current scale (72 groups, ~131 teachers), this is fast enough (<400ms). If data grows significantly, consider caching the snapshot ID in a KV store or using Vercel's ISR/cache to reduce DB round-trips on every request.

**Sync function approaching Vercel timeout:**
- Problem: Full sync takes ~4m26s against a 5-minute ceiling (`maxDuration = 300`).
- Files: `src/app/api/internal/sync-wise/route.ts` (line 6), `src/lib/sync/orchestrator.ts`
- Cause: Sequential teacher processing (see Tech Debt section) and 26 seven-day leave window fetches per teacher.
- Improvement path: Parallelize teacher availability fetches. Consider splitting the sync into phases (teachers first, then availability in a follow-up call) if parallelization alone isn't enough.

**Issue-to-group matching is O(issues x groups):**
- Problem: In `buildIndex` (`src/lib/search/index.ts` lines 147-161), every data issue is matched against every group via a nested loop checking `entityId` and `entityName`. With 251 issues and 72 groups, this is ~18,000 comparisons per index build.
- Files: `src/lib/search/index.ts` (lines 147-161)
- Cause: Issues don't have a direct `groupId` foreign key — they use string matching on `entityId`/`entityName`.
- Improvement path: Pre-build a lookup `Map<canonicalKey|groupId|displayName, groupId>` before iterating issues. Alternatively, add a `groupId` column to the `data_issues` table.

## Fragile Areas

**Search page client-side tutor cache:**
- Files: `src/app/(app)/search/page.tsx` (lines 167-169, 273-344)
- Why fragile: The `useRef(new Map<string, CompareTutor>())` cache keyed by `tutorGroupId:weekStart` has manual invalidation logic spread across 5 handler functions (`fetchCompare`, `handleCompareSelected`, `handleRemoveTutor`, `handleAddTutor`, `handleWeekChange`). The recursive refetch on snapshot change (line 312-314) could infinite-loop if the server snapshot keeps changing.
- Safe modification: When modifying cache behavior, trace all 5 handlers. The recursive call on line 313 should have a retry limit.
- Test coverage: Zero — no frontend tests exist.

**Snapshot promotion is not truly atomic:**
- Files: `src/lib/sync/orchestrator.ts` (lines 404-419)
- Why fragile: Promotion consists of two separate SQL statements — deactivate old (line 407-412), then activate new (line 414-418). If the function crashes between these two statements, the system has zero active snapshots and all API requests will fail with "No active snapshot found".
- Safe modification: Wrap both operations in a transaction, or use a single UPDATE with a CTE/subquery.
- Test coverage: No integration test covers the promotion path.

**Identity resolution depends on parenthetical nickname convention:**
- Files: `src/lib/normalization/identity.ts` (lines 43-46, 72-182)
- Why fragile: The entire identity resolution pipeline assumes teachers have nicknames in parentheses (e.g., "Chinnakrit (Celeste) Channiti"). Teachers without this naming convention fall through to "unresolved" and require manual alias entries. The alias table currently has only 4 entries.
- Safe modification: When Wise changes their display name format, identity resolution will silently produce wrong groupings. There's no alerting mechanism beyond the data_issues count.
- Test coverage: Good unit test coverage in `src/lib/normalization/__tests__/identity.test.ts`.

## Scaling Limits

**Vercel Hobby plan limitations:**
- Current capacity: Daily cron (once per 24 hours), 5-minute function timeout.
- Limit: Sync cadence cannot go below daily without upgrading to Pro ($20/mo). Sync already uses 89% of the 5-minute timeout.
- Scaling path: Upgrade to Vercel Pro for 30-minute cron cadence. Parallelize teacher fetches to reduce sync duration.

**In-memory index size:**
- Current capacity: ~72 tutor groups with all associated data fits comfortably in a serverless function's memory.
- Limit: At ~1000+ tutors with proportional sessions/availability/leaves, the index could exceed Vercel's 1GB memory limit for serverless functions.
- Scaling path: Move to a Redis/KV-backed index or implement pagination in the search engine.

## Dependencies at Risk

**next-auth beta version:**
- Risk: Using `next-auth@^5.0.0-beta.30` — a pre-release version. Breaking changes are expected before stable release.
- Impact: Auth flow could break on update. The `auth()` wrapper in middleware (`src/middleware.ts`) uses the beta API.
- Migration plan: Pin the exact version in `package.json` (currently uses `^` range). Monitor Auth.js releases for stable v5.

**@base-ui/react:**
- Risk: Using `@base-ui/react@^1.3.0`. This is the headless component library from MUI (formerly Radix-adjacent). The `PopoverTrigger` usage in `src/components/compare/week-overview.tsx` (line 393) uses a `render` prop pattern that may change.
- Impact: UI component breakage on major updates.
- Migration plan: Pin version. The usage is limited to Popover in the week overview component.

## Missing Critical Features

**No admin UI for managing aliases:**
- Problem: Tutor alias mappings (`tutor_aliases` table) can only be managed via direct database access or the seed script. There are currently 4 aliases.
- Blocks: Non-technical admins cannot resolve identity issues without developer intervention.

**No alerting on sync failures:**
- Problem: If the daily cron sync fails, no notification is sent. The only way to discover a failure is to check the `/data-health` page manually.
- Blocks: Stale data could persist for days without anyone noticing.

## Test Coverage Gaps

**Zero frontend/component tests:**
- What's not tested: All React components (`src/components/**`), all page components (`src/app/(app)/**`), client-side caching logic, URL parameter handling, week picker navigation.
- Files: `src/app/(app)/search/page.tsx`, `src/components/compare/week-overview.tsx`, `src/components/compare/calendar-grid.tsx`, `src/components/compare/discovery-panel.tsx`, `src/components/search/availability-grid.tsx`
- Risk: UI regressions go undetected. The search page has complex state interactions (30+ state variables, client cache, AbortController, recursive refetch) with zero automated verification.
- Priority: High — the search page is the primary user-facing feature.

**No API route integration tests:**
- What's not tested: All API route handlers (`src/app/api/**`). Auth middleware integration, request validation with Zod schemas, error responses, and end-to-end data flow from request to response.
- Files: `src/app/api/search/range/route.ts`, `src/app/api/compare/route.ts`, `src/app/api/compare/discover/route.ts`
- Risk: API contract changes (request/response shape) can silently break the frontend.
- Priority: Medium — Zod schemas provide some safety, but edge cases (invalid dates, empty results, stale index) are untested.

**No sync orchestrator integration tests:**
- What's not tested: The full sync pipeline in `src/lib/sync/orchestrator.ts` — snapshot creation, data insertion, validation thresholds, atomic promotion, error recovery.
- Files: `src/lib/sync/orchestrator.ts`
- Risk: The sync is the most critical system process. A regression here means stale or corrupt data in production. The 50% unresolved threshold (line 399) and promotion logic (lines 404-419) are completely untested.
- Priority: High — this is the data pipeline feeding all downstream features.

---

*Concerns audit: 2026-04-10*
