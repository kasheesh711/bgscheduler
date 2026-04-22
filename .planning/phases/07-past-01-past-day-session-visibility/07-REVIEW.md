---
phase: 07-past-01-past-day-session-visibility
reviewed: 2026-04-22T00:00:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - drizzle/0002_past_session_blocks.sql
  - src/app/api/compare/route.ts
  - src/lib/data/__tests__/past-sessions.test.ts
  - src/lib/data/past-sessions.ts
  - src/lib/db/schema.ts
  - src/lib/search/__tests__/compare.test.ts
  - src/lib/search/__tests__/engine.test.ts
  - src/lib/search/cache-version.ts
  - src/lib/search/compare.ts
  - src/lib/search/index.ts
  - src/lib/sync/__tests__/past-sessions-diff-hook.test.ts
  - src/lib/sync/orchestrator.ts
  - src/lib/sync/past-sessions-diff-hook.ts
findings:
  critical: 0
  warning: 2
  info: 3
  total: 5
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-04-22T00:00:00Z
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Phase 7 (PAST-01) adds cross-snapshot past-session capture through a three-layer design: migration + schema (Plan 01), sync-time diff-hook (Plan 02), cached fetcher (Plan 03), compare merge (Plan 04), and API historical-range trigger (Plan 05). The code is well-structured with explicit decision-record (D-xx) anchors, fail-closed comments, and strong regression tests.

Key strengths:
- Cache discipline is rigorously enforced: `cacheTag("past-sessions")` is correctly separate from `"snapshot"`, and grep-asserted in tests (closes D-08 / Pitfall 7).
- Idempotency relies on the `UNIQUE(wise_session_id)` index + `onConflictDoNothing`, and is covered by an explicit shared-state test (closes D-03 / PAST-05).
- Pitfall 16 closure in `/api/compare/route.ts:150-156` correctly clones groups with merged past blocks before passing to `findSharedFreeSlots`.
- Pitfall 19 closure: `fetchPastSessionBlocksUncached` is exported separately for Vitest spying.
- Cross-snapshot table design (`group_canonical_key` denormalized, `captured_in_snapshot_id` nullable non-FK) is appropriately documented in the schema comments.
- Per-weekday `isHistoricalRange` logic in `buildCompareTutor` has an explicit regression test matrix (historical, future, current, and backward-compat) that validates D-05 and D-09.

One timezone-semantics issue is worth addressing before wider data accumulates (Warning WR-01 below). One data-model integrity improvement is recommended (Warning WR-02). Three Info items document smaller code-quality observations.

## Warnings

### WR-01: Mixed-TZ date comparison in diff-hook skips sessions that started <7h ago

**File:** `src/lib/sync/past-sessions-diff-hook.ts:114,120`
**Issue:** `toZonedTime(new Date(), "Asia/Bangkok")` returns a `Date` whose **internal UTC instant is shifted +7h** so that the wall-clock formatting renders BKK time (see `node_modules/date-fns-tz/dist/esm/toZonedTime/index.d.ts:7-11`). `prior.startTime` however is a true UTC instant read from `futureSessionBlocks.startTime` (TIMESTAMPTZ). Comparing `prior.startTime >= nowBkk` therefore mixes a UTC instant against a `UTC-now + 7h` instant — the diff-hook will treat sessions that actually started up to 7 hours ago as "still future" and skip capture.

Concrete scenario: daily cron runs at 00:00 UTC (= 07:00 BKK). A session scheduled for 06:00 BKK (23:00 UTC previous day) has already started. `prior.startTime` = `2026-04-22T23:00Z`. `new Date()` at cron time = `2026-04-23T00:00Z`. `nowBkk = toZonedTime(...)` = a Date with internal UTC value `2026-04-23T07:00Z`. Then `prior.startTime (23:00Z) >= nowBkk (07:00Z next day)` evaluates `false` — session IS captured, which happens to work in this example. But at 06:00 UTC (13:00 BKK), a session at 10:00 BKK (03:00 UTC) has `prior.startTime = 03:00Z`, `nowBkk` internal = `13:00Z` → `03:00Z >= 13:00Z` is false → captured correctly. **Inversion case**: cron at midnight UTC, session at 05:00 BKK today (22:00 UTC prior day) — `startTime = 22:00Z`, `nowBkk internal = 07:00Z (today)` → captured. Another inversion: session at 20:00 BKK yesterday = `13:00Z yesterday`, `nowBkk internal = 07:00Z today` → 13:00Z yesterday < 07:00Z today → captured. These cases happen to work.

However, the comparison logic is semantically incorrect (two incompatible timescales) and will produce the wrong answer if the cron cadence changes or the sync runs outside its normal window. Explicitly: in the 7-hour window where the "shifted-BKK-now" is ahead of true UTC-now, a past-start session captured at `prior.startTime ∈ [true_now - 7h, true_now)` compares as `startTime >= nowBkk` (because the shift pushes nowBkk into the future) and is skipped.

The test suite does not catch this because `past-sessions-diff-hook.test.ts` uses fixture dates `2026-04-01T10:00:00+07:00` (well in the past) and `2099-01-01T00:00:00+07:00` (well in the future), leaving the 7-hour boundary untested.

**Fix:** Drop the TZ conversion — both sides should be UTC instants:
```ts
// 5. "Now" as a UTC instant — matches prior.startTime's TIMESTAMPTZ semantics.
const now = new Date();

// 6. Compute the "dropped" set: in prior, not in new, and startTime < now.
for (const prior of priorBlocks) {
  if (newWiseSessionIds.has(prior.wiseSessionId)) continue;
  if (prior.startTime >= now) continue;  // both UTC instants
  // ...
}
```
If the intent of the comment "started in BKK wall-clock" is to capture sessions whose BKK-local start-of-day has passed (a different predicate than "the session has begun"), the comment should state that — but that's not what the current code does. For a sessions-that-have-actually-started predicate, direct UTC comparison is the correct form. Add a boundary regression test that freezes time to the inversion window (e.g. cron runs at 01:00 UTC = 08:00 BKK; a session at 07:00 BKK = 00:00 UTC yesterday has started 1h ago) and asserts capture.

### WR-02: `past_session_blocks.captured_in_snapshot_id` nullable without FK makes orphan audit expensive

**File:** `drizzle/0002_past_session_blocks.sql:4`, `src/lib/db/schema.ts:231`
**Issue:** `capturedInSnapshotId` is typed `uuid` with no FK constraint and no default. The schema comment at `schema.ts:212-214` correctly notes this is intentional (so snapshots can be pruned without cascading). However, every row written by the diff-hook *does* set this field (`past-sessions-diff-hook.ts:136`) — there's no path that writes `NULL`. The `NULL`-able column therefore admits a state (`captured_in_snapshot_id IS NULL`) that no production code produces but also no code defends against, meaning a stray row inserted via manual admin action (or a migration restore) could land without provenance and go undetected.

This is not a security issue — all writers pass through the diff-hook — but it's a data-integrity code smell for a table whose audit-trail value is half its purpose. The retention-unbounded design (schema.ts:216) means orphan rows would accumulate silently.

**Fix:** Two options, pick one:
1. Add `NOT NULL` to the column (matches all current writers, catches accidental NULL inserts at the DB layer). This is a breaking schema change for prior migrations but not an issue since the migration is new.
2. Keep nullable but add a CHECK constraint that logs orphans via a nightly query into `data_issues`, or simply document "NULL = pre-v1.1 migration-era row" and set the convention.

Option 1 is the low-cost recommendation:
```sql
-- drizzle/0002_past_session_blocks.sql
"captured_in_snapshot_id" uuid NOT NULL,
```
And in schema.ts:
```ts
capturedInSnapshotId: uuid("captured_in_snapshot_id").notNull(),
```

## Info

### IN-01: `compare.ts:255-291` historical-range fallback re-computes `startOfTodayBkk` per call; consider caching per-request

**File:** `src/lib/search/compare.ts:255-291`
**Issue:** `buildCompareTutor` is called once per tutor group (1-3 times per `/api/compare` request). Each call does `getStartOfTodayBkk()` which constructs a Date and a `toZonedTime` conversion. The result is identical for all groups within a single request. Currently this adds a few microseconds × 3; negligible today. However, the expanded `targetWeekdays` iteration (line 262-290) runs the per-weekday historical computation per group, which is fine but subtly compounds.

**Fix:** Pass `startOfTodayBkk` as an optional parameter (or factor the per-weekday historical classification into a precomputed `historicalWeekdays: Set<number>` the route hands to `buildCompareTutor`). Low priority — current cost is immaterial and readability is fine.

### IN-02: `/api/compare/route.ts:27-34` `getCurrentMonday` duplicates logic already present in `use-compare.ts`

**File:** `src/app/api/compare/route.ts:27-51`
**Issue:** `getCurrentMonday`, `parseMondayDate`, `addDays`, `formatIsoDate` are small helpers duplicated in the client-side hook (comment at `compare.ts:47` explicitly references `use-compare.ts:53-59`). Future divergence (e.g., someone fixes a client-side off-by-one but forgets the server-side twin) is a real risk. This is the exact pattern the comment acknowledges: "to avoid off-by-one divergence."

**Fix:** Extract `src/lib/search/week-math.ts` with `getCurrentMondayBkk`, `parseMondayDate`, `addDays`, `formatIsoDate`, and reuse in both the route and `use-compare.ts`. Not urgent; flag for Phase 8+ refactor.

### IN-03: Timezone semantics in week-range construction

**File:** `src/app/api/compare/route.ts:28-35`, `src/lib/search/compare.ts:52-61`
**Issue:** `getCurrentMonday` constructs a `Date` from BKK wall-clock year/month/date using local-host TZ constructors (`new Date(y, m, d)`). On a Vercel UTC host, this produces a Date at UTC midnight on the BKK date, not BKK midnight. `parseMondayDate` does the same. Downstream, `buildCompareTutor` filters `s.startTime >= dateRange.start` where `s.startTime` is a true UTC instant, so there's a 7-hour offset: a BKK Monday 04:00 session has `startTime = prev-Sunday-21:00Z`, which on a UTC host is < `dateRange.start = 00:00Z Monday`, so it's excluded even though it's "Monday in BKK."

This is a **pre-existing issue** (not introduced by Phase 7) — the same arithmetic is used throughout the compare module and tests. It's flagged for visibility because the Phase 7 additions (historical detection, past-block filtering) now depend on the same reference frame, increasing the surface area where a timezone cleanup pass would pay off.

**Fix:** Either
1. Construct week boundaries via `date-fns-tz fromZonedTime(new Date(y, m, d), "Asia/Bangkok")` to anchor them to BKK midnight regardless of host TZ, or
2. Document in AGENTS.md that all Date arithmetic in the compare module assumes the host runs BKK (and add a regression test with `process.env.TZ = "UTC"`).

Since no tests currently pin `process.env.TZ`, it's worth a Phase 7.5 or Phase 8 task.

---

_Reviewed: 2026-04-22T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
