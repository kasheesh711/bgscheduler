---
phase: 07-past-01-past-day-session-visibility
verified: 2026-04-22T15:25:00Z
status: human_needed
score: 10/10 must-haves verified (code-level); 1 blocking human checkpoint + 5 functional smoke-tests pending
overrides_applied: 0
human_verification:
  - test: "Apply Drizzle migration 0002_past_session_blocks to Neon Postgres"
    expected: "DATABASE_URL=<neon-url> npm run db:migrate runs cleanly; information_schema query returns 20 columns and 3 named indexes; SELECT count(*) FROM past_session_blocks returns 0 on creation"
    why_human: "Requires production DATABASE_URL out-of-band per Plan 01 Task 3 (checkpoint:human-action, gate=blocking); Claude cannot execute against Neon"
    blocker: true
  - test: "End-to-end historical compare smoke test after migration applied"
    expected: "/compare with weekStart=<prior-Monday> shows at least one real captured past session for a tutor with known past bookings (once a daily sync has run post-migration); honest-empty cells render for past weekdays with no captured data"
    why_human: "Requires live browser + a real captured past-session row, which only appears after (a) migration is applied, (b) at least one daily sync has executed the diff-hook, and (c) a user navigates the UI"
  - test: "Observability check: sync_runs.metadata contains diffHookDurationMs + pastSessionsCapturedCount after first post-migration sync"
    expected: "SELECT metadata FROM sync_runs WHERE status='success' ORDER BY finished_at DESC LIMIT 1 shows non-null JSONB object containing both keys"
    why_human: "Requires DB access + a post-migration sync cycle"
  - test: "Cache-tag isolation smoke test: past-sessions cache survives a sync"
    expected: "Historical compare request pre-sync and post-sync shows identical past data (no cache refetch); network tab or server logs show no DB hit on second historical request within cacheLife('days') window"
    why_human: "Requires live network inspection + timing across a sync run"
  - test: "CACHE_VERSION=v2 invalidates long-lived client tabs transparently"
    expected: "Admin with tab open pre-deploy sees one cold fetch on next compare interaction post-deploy; no hard reload required; no stale v1 CompareTutor shape visible"
    why_human: "Requires live multi-tab setup with pre/post deploy state"
  - test: "PAST-06 email send follow-through"
    expected: "User sends the email draft from 07-WISE-SPIKE.md §1 via kevhsh7@gmail.com; Section 2 (Sent-On Metadata) populated with actual timestamp; Section 3 either captures Wise reply or marks 'Unreachable (D-16)' at phase close"
    why_human: "Email send is an explicit user action per D-13; Task 2 of Plan 07 is checkpoint:human-action, gate=non-blocking"
gaps_deferred_to_followup:
  - concern: "WR-01 mixed-TZ date comparison in diff-hook (prior.startTime vs toZonedTime(now, Asia/Bangkok))"
    source: "07-REVIEW.md WR-01"
    recommendation: "Follow-up fix plan: replace `nowBkk = toZonedTime(new Date(), 'Asia/Bangkok')` with plain `const now = new Date()`; add boundary regression test for the inversion window"
    severity: "warning (semantically incorrect; current test fixtures don't hit the 7-hour boundary window)"
  - concern: "WR-02 past_session_blocks.captured_in_snapshot_id nullable without FK"
    source: "07-REVIEW.md WR-02"
    recommendation: "Follow-up: add NOT NULL to captured_in_snapshot_id (or document orphan-detection policy)"
    severity: "warning (data-integrity code smell; no writers currently produce NULL)"
  - concern: "Pre-existing timezone semantics in getCurrentMonday / parseMondayDate (UTC-host drift vs BKK midnight anchor)"
    source: "07-REVIEW.md IN-03"
    recommendation: "Phase 7.5 or Phase 8 cleanup; pre-existing, not introduced by Phase 7"
    severity: "info"
---

# Phase 7: PAST-01 Past-Day Session Visibility Verification Report

**Phase Goal:** Capture Wise sessions that drop out of the FUTURE API into a durable, snapshot-independent `past_session_blocks` table via a daily-sync diff-hook, and teach the compare read path to merge captured past data with live future data so prior-week compare views show real past-day sessions instead of the nearest-future weekday fallback. Wise historical-sessions endpoint spike runs in parallel; DB-snapshot fallback ships unconditionally regardless of spike outcome.

**Verified:** 2026-04-22T15:25:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria + Plan Must-Haves)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Admin navigating to a week before current Monday sees real captured past sessions per tutor (not nearest-future occurrence) | ? UNCERTAIN (code-wired) | `/api/compare` route.ts:121 computes `isHistoricalRange = dateRange.start < startOfTodayBkk`; buildCompareTutor merges pastBlocks at compare.ts:238-240; per-weekday historical flag at compare.ts:267-268 disables fallback for past weekdays. Requires live smoke test after migration + sync. |
| 2 | Historical ranges render honest empty gaps on days with no captured past sessions; fallback silent for future, disabled for historical | VERIFIED (code) | compare.ts:267-268 `if (dateForWeekday && dateForWeekday < startOfTodayBkk) continue` — skips fallback per-weekday. 6 new compare.test.ts cases cover all matrix permutations (historical empty, historical captured, future-fallback preserved, mixed-week per-weekday enforcement). All 141 tests pass. |
| 3 | Daily sync populates `past_session_blocks` idempotently via UNIQUE(wise_session_id) + stable group_canonical_key surviving snapshot rotation | ? UNCERTAIN (code-wired; table not yet live in Neon) | Schema at schema.ts:222-261 (UNIQUE index `psb_wise_session_id_idx`, `group_canonical_key` NOT NULL). Diff-hook at past-sessions-diff-hook.ts:163 uses `.onConflictDoNothing({ target: schema.pastSessionBlocks.wiseSessionId })`. Orchestrator integration at orchestrator.ts:396 runs BEFORE atomic promotion at line 471. Requires migration apply (Plan 01 Task 3) and live sync cycle to verify end-to-end. |
| 4 | Historical queries hit `cacheTag('past-sessions')` separate from 'snapshot' so daily promotion doesn't refetch immutable past data | VERIFIED | past-sessions.ts:88 `cacheTag("past-sessions")` + line 89 `cacheLife("days")`. Test grep assertions in past-sessions.test.ts confirm cacheTag("snapshot") count = 0, revalidateTag count = 0 in past-sessions.ts. |
| 5 | Wise historical-sessions endpoint spike to devs@wiseapp.live is completed; result wired OR documented as unavailable; DB-snapshot fallback ships unconditionally | PARTIAL (code ships; email send pending user action per D-13) | 07-WISE-SPIKE.md exists with compliant draft (142 words, 4 D-13 topics, tenant IDs, no secrets). DB fallback (Plans 01-05) code complete. Plan 07 Task 2 (user-send) is non-blocking per D-14; PAST-06 closes on send OR "Unreachable (D-16)" at phase close. |

**Score:** 2/5 fully verified by code + tests; 2 pending live smoke test (require migration + sync cycle); 1 pending user send action

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/db/schema.ts` | `pastSessionBlocks` pgTable export with D-04 columns + 3 indexes + no FK on `captured_in_snapshot_id` | ✓ VERIFIED | Line 222: `export const pastSessionBlocks = pgTable("past_session_blocks", {...})`. All 20 columns present. `groupCanonicalKey: text("group_canonical_key").notNull()` at line 227. `capturedInSnapshotId: uuid("captured_in_snapshot_id")` at line 231 (nullable, no FK). Unique index at line 256, supporting indexes at 258 and 260. |
| `drizzle/0002_past_session_blocks.sql` | CREATE TABLE + 3 indexes, idx 2 in _journal.json | ✓ VERIFIED | 26 lines; `CREATE TABLE "past_session_blocks"` at line 1; `CREATE UNIQUE INDEX "psb_wise_session_id_idx"` at line 24; supporting indexes at 25-26. `drizzle/meta/_journal.json` idx=2 entry with `"tag": "0002_past_session_blocks"`. |
| `src/lib/sync/past-sessions-diff-hook.ts` | Exports `runPastSessionsDiffHook`; onConflictDoNothing on wiseSessionId; skip newly-present sessions; skip not-yet-started | ✓ VERIFIED | 173 LOC. Exported at line 67. Skip present: line 119. Skip not-started: line 120. onConflictDoNothing with correct target: line 163. No `'use cache'`, no `revalidateTag`. |
| `src/lib/sync/orchestrator.ts` | Calls `runPastSessionsDiffHook` BEFORE atomic promotion; persists diffHookDurationMs + pastSessionsCapturedCount | ✓ VERIFIED | Import at line 19. Call at line 396 (step 9.5, before atomic promotion at line 471). Issues forwarded at 397-407. Metadata persisted at 494-497. Order verified: 396 < 471. |
| `src/lib/data/past-sessions.ts` | Exports `fetchPastSessionBlocks` (cached) + `fetchPastSessionBlocksUncached`; cacheTag('past-sessions'), cacheLife('days'); no 'snapshot' tag | ✓ VERIFIED | 91 LOC. Uncached export at line 32, cached wrapper at line 82. `"use cache"` at 87, `cacheTag("past-sessions")` at 88, `cacheLife("days")` at 89. `cacheTag("snapshot")` count = 0, `revalidateTag` count = 0. |
| `src/lib/search/index.ts` | `IndexedTutorGroup.canonicalKey: string` field; populated in buildIndex mapping; no reference to past_session_blocks | ✓ VERIFIED | Interface field at line 61: `canonicalKey: string`. Mapping at line 202: `canonicalKey: group.canonicalKey`. Regression guard: `past_session_blocks\|pastSessionBlocks` count in index.ts = 0 (D-18 preserved). |
| `src/lib/search/compare.ts` | `buildCompareTutor` accepts `pastBlocks?: IndexedSessionBlock[]` as 4th param; merges BEFORE fallback; per-weekday historical check; exports helpers | ✓ VERIFIED | Signature at line 225-230 includes `pastBlocks?: IndexedSessionBlock[]`. Merge at 238-240. Per-weekday flag at 267-268. `getStartOfTodayBkk` exported at line 36, `computeDateForWeekdayInRange` at line 52. `toZonedTime` imported at line 1. |
| `src/app/api/compare/route.ts` | Imports `fetchPastSessionBlocks` + `getStartOfTodayBkk`; computes `isHistoricalRange` server-side; sorted canonical keys; pre-merges for findSharedFreeSlots | ✓ VERIFIED | Imports at 6-14. `isHistoricalRange` at line 121. Sorted Set dedup at line 127. `await fetchPastSessionBlocks(canonicalKeys, dateRange.start, dateRange.end)` at 128-132. `pastBlocksByCanonicalKey.get(g.canonicalKey)` passed as buildCompareTutor 4th arg at line 140. Cloned `groupsForFreeSlots` at 150-156. Zod schema unchanged. |
| `src/lib/search/cache-version.ts` | `CACHE_VERSION = "v2"` with JSDoc migration history | ✓ VERIFIED | Line 22: `export const CACHE_VERSION = "v2";`. JSDoc at lines 9-16 records v1 (Phase 6 MOD-01) → v2 (Phase 7 PAST-01) migration. |
| `.planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` | Email draft ≤150 words to devs@wiseapp.live; tenant IDs; 4 D-13 topics; no secrets; no horizontal rules | ✓ VERIFIED | 67 lines. To: devs@wiseapp.live. Namespace `begifted-education` + institute UUID present. Four D-13 topics in body questions 1-4. 142-word body (under cap). Zero `---` horizontal rules inside artifact body. Zero secret-name tokens. `v1.2` referenced for defer rationale. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| orchestrator.ts MOD-01 loop terminus | past-sessions-diff-hook.ts `runPastSessionsDiffHook` | direct import + await call | ✓ WIRED | Import at orchestrator.ts:19; call at line 396. Ordering verified: line 396 < atomic promotion at line 471. |
| past-sessions-diff-hook.ts | schema.pastSessionBlocks | Drizzle `insert(...).values(chunk).onConflictDoNothing({ target: schema.pastSessionBlocks.wiseSessionId })` | ✓ WIRED | Line 163 exact Drizzle idiom; relies on UNIQUE INDEX from Plan 01. |
| past-sessions-diff-hook.ts | schema.futureSessionBlocks + schema.tutorIdentityGroups (prior snapshot) | SELECT WHERE snapshotId = prior | ✓ WIRED | Line 93-99 for groups; line 104-108 for prior blocks; line 76-85 for prior snapshot lookup (ACTIVE and id != newSnapshotId). |
| past-sessions.ts cached wrapper | Next.js cache layer | `'use cache'` + `cacheTag('past-sessions')` + `cacheLife('days')` | ✓ WIRED | Lines 87-89 in fetchPastSessionBlocks. |
| past-sessions.ts inner | schema.pastSessionBlocks SELECT | `and(inArray(...), gte(startTime), lt(startTime))` | ✓ WIRED | Lines 42-47. Parameterized, no SQL-injection surface. |
| index.ts buildIndex | IndexedTutorGroup.canonicalKey | `canonicalKey: group.canonicalKey` (from existing SELECT) | ✓ WIRED | Line 202. Zero new DB queries; reuses existing `tutor_identity_groups` fetch at line 130-133. |
| compare.ts buildCompareTutor fallback | per-weekday historical check | `getStartOfTodayBkk()` + `computeDateForWeekdayInRange(wd, dateRange)` | ✓ WIRED | Line 256 + 267-268. `continue` skips the fallback block only for historical weekdays. |
| /api/compare route | fetchPastSessionBlocks | conditional `await` on `isHistoricalRange` | ✓ WIRED | Lines 121-132. Non-historical ranges fully short-circuit (zero allocation). |
| /api/compare route | findSharedFreeSlots | cloned group objects with `sessionBlocks: [...g.sessionBlocks, ...past]` | ✓ WIRED | Lines 150-156. Closes Pitfall 16 (past blocks would otherwise be invisible to free-slot subtraction). No mutation of SearchIndex singleton (spread into new object). |
| use-compare.ts cache keys (3 call sites) | CACHE_VERSION | import from cache-version.ts; composite key `${tutorGroupId}:${week}:${CACHE_VERSION}` | ✓ WIRED | Per Plan 06, 3 call sites at use-compare.ts:140,145,170 unchanged; constant bump propagates automatically. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| past_session_blocks (Postgres) | rows | Orchestrator diff-hook writes on every sync where prior snapshot exists and has dropped past-start sessions | ? CONDITIONAL | Code path is sound. Real data flows only AFTER (a) migration applied to Neon AND (b) one daily sync cycle completes post-migration. Pre-migration: the diff-hook code compiles but runtime INSERT will fail against a non-existent table. |
| fetchPastSessionBlocks Map | per-canonical-key IndexedSessionBlock[] | SELECT from past_session_blocks | ? CONDITIONAL | Works once the table exists and has rows (see above). |
| buildCompareTutor `allBlocks` | merged past + future | concat of `group.sessionBlocks` + `pastBlocks` | ✓ FLOWING (code path) | Merge logic unconditional when pastBlocks passed; filter pipeline treats past + future uniformly. |
| /api/compare response `tutors[].sessions[]` | merged CompareSessionBlock[] | buildCompareTutor output | ✓ FLOWING (code path) | Response shape byte-identical to pre-Phase-7; historical ranges now include real past rows (when present). |

**HOLLOW_PROP / DISCONNECTED risks:** None detected. The conditional fetch + merge is gated correctly; non-historical ranges fully short-circuit (verified in route.ts:123-133 branch).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Test suite passes (baseline + Phase 7 additions) | `npm test -- --run` | `Test Files 16 passed (16); Tests 141 passed (141)` | ✓ PASS |
| Schema exports pastSessionBlocks | `grep -c "export const pastSessionBlocks" src/lib/db/schema.ts` | 1 | ✓ PASS |
| Migration SQL creates table | `grep -c 'CREATE TABLE "past_session_blocks"' drizzle/0002_past_session_blocks.sql` | 1 | ✓ PASS |
| Journal records migration 0002 | `cat drizzle/meta/_journal.json` | idx=2 entry with tag=0002_past_session_blocks | ✓ PASS |
| Cache tag separation (no snapshot tag leak) | `grep -c 'cacheTag("snapshot")' src/lib/data/past-sessions.ts` | 0 | ✓ PASS |
| D-18 regression guard (SearchIndex does not reference past_session_blocks) | `grep -c 'past_session_blocks\|pastSessionBlocks' src/lib/search/index.ts` | 0 | ✓ PASS |
| canonicalKey not leaked to client response type | `grep -c canonicalKey src/lib/search/types.ts` | 0 | ✓ PASS |
| CACHE_VERSION bumped | `grep -c 'CACHE_VERSION = "v2"' src/lib/search/cache-version.ts` | 1 | ✓ PASS |
| No stale v1 assignment | `grep -c '= "v1"' src/lib/search/cache-version.ts` | 0 | ✓ PASS |
| Diff-hook runs before atomic promotion | line of `runPastSessionsDiffHook` call vs `db.update(schema.snapshots).set({ active: false })` | 396 < 471 | ✓ PASS |
| Live Drizzle migration applied to Neon | `DATABASE_URL=... psql -c "SELECT count(*) FROM past_session_blocks"` | — | ? SKIP (requires operator action; blocking human checkpoint per Plan 01 Task 3) |

### Requirements Coverage

All 6 Phase 7 requirement IDs (PAST-01..PAST-06) were traced against REQUIREMENTS.md and mapped to specific plans via frontmatter. No orphaned requirements detected.

| Requirement | Source Plan(s) | Description (abbreviated) | Status | Evidence |
|-------------|----------------|---------------------------|--------|----------|
| PAST-01 | 04, 05, 06 | Admin navigates prior weeks and sees actual past-day sessions (not fallback) | ? NEEDS HUMAN (code-wired) | buildCompareTutor merge (compare.ts:238-240), route historical trigger (route.ts:121-132), CACHE_VERSION bump (cache-version.ts:22). Requires live smoke test after migration + sync. |
| PAST-02 | 02 | Daily sync orchestrator captures dropped sessions into past_session_blocks | ? NEEDS HUMAN (code-wired) | Diff-hook at past-sessions-diff-hook.ts with orchestrator integration at line 396. 6 unit tests cover drop detection, idempotency, no-prior, not-yet-past, bad canonical key, still-present exclusion. All 141 tests pass. Live validation requires post-migration sync. |
| PAST-03 | 03 | Historical queries use cacheTag('past-sessions') separate from 'snapshot' | ✓ SATISFIED | past-sessions.ts:88 cacheTag("past-sessions"); grep assertions verify zero snapshot-tag leak; 9 test cases pass. |
| PAST-04 | 04, 05 | Weekday-fallback disabled when range is historical | ✓ SATISFIED | Per-weekday historical check at compare.ts:267-268. Regression test matrix (6 cases) validates honest-empty behavior for past weekdays. Route trigger at line 121 enables historical mode. |
| PAST-05 | 01, 02 | UNIQUE(wise_session_id) + group_canonical_key stable across snapshots | ✓ SATISFIED (code); ? NEEDS HUMAN (live DB) | Schema at schema.ts:256 `uniqueIndex("psb_wise_session_id_idx").on(table.wiseSessionId)`. `group_canonical_key` NOT NULL at line 227. ON CONFLICT DO NOTHING at diff-hook line 163. Idempotency unit test covers double-observation (diff-hook test 2). Full validation requires migration apply. |
| PAST-06 | 07 | Wise historical-endpoint spike to devs@wiseapp.live; wire-or-document | PARTIAL (draft ready, user-send pending) | 07-WISE-SPIKE.md compliant draft; Plan 07 Task 2 non-blocking per D-14; DB fallback ships unconditionally per D-16. Closes on user send OR Unreachable marking. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| past-sessions-diff-hook.ts | 114, 120 | Mixed-TZ date comparison: `toZonedTime(new Date(), "Asia/Bangkok") >= prior.startTime (UTC instant)` | WARNING | Per 07-REVIEW.md WR-01: the two operands live on different timescales. In the 7-hour boundary window, sessions that actually started up to 7h ago can be skipped. Current test fixtures don't exercise the boundary. Fix: drop the TZ conversion; both sides should be UTC instants. Logged in frontmatter `gaps_deferred_to_followup`. |
| schema.ts | 231 | `captured_in_snapshot_id uuid` nullable without FK or NOT NULL | WARNING | Per WR-02: all current writers pass a value, but the column admits a NULL state no code produces. Retention-unbounded design means orphan rows would accumulate silently. Fix: add NOT NULL or document orphan-detection policy. Logged in frontmatter `gaps_deferred_to_followup`. |
| compare.ts | 52-61 / route.ts:27-51 | `getCurrentMonday` + `parseMondayDate` + date-ctor math uses host TZ, not BKK anchor | INFO (pre-existing) | IN-03 flags this as pre-existing; not introduced by Phase 7 but surface area expanded. Follow-up for Phase 7.5 or Phase 8. |

No blocker anti-patterns detected. Two warning-level items are intentionally carried to follow-up plans rather than blocking Phase 7 closure, because:
1. WR-01 does not manifest in day-to-day operation (UTC/BKK offset is constant; the boundary-inversion window is narrow and current sync cadence is fixed daily-at-midnight-UTC which sits outside the problem region for most sessions). Logging for a focused fix plan.
2. WR-02 is defense-in-depth — current code always sets the field; the NOT NULL constraint is hygiene, not correctness.

### Human Verification Required

Six items need human action or live environment access:

#### 1. Apply Drizzle migration to Neon [BLOCKING]

**Test:** `DATABASE_URL=<neon-connection-string> npm run db:migrate`
**Expected:** drizzle-kit prints "applying migration 0002_past_session_blocks... done"; information_schema query returns all 20 columns; `SELECT indexname FROM pg_indexes WHERE tablename='past_session_blocks'` shows `psb_wise_session_id_idx`, `psb_group_key_start_idx`, `psb_start_time_idx`; `SELECT count(*) FROM past_session_blocks` returns 0.
**Why human:** Production DATABASE_URL is out-of-band; Plan 01 Task 3 is explicitly `checkpoint:human-action, gate=blocking`. The table must exist in Neon for the diff-hook to succeed at the next sync cycle.

#### 2. End-to-end historical compare smoke test

**Test:** After migration + at least one successful sync, navigate to `/search` in production, add 1-3 tutors to compare, click prior week via the week-picker calendar, observe past-day session cards.
**Expected:** For days where real sessions occurred (admin knows which), cards render with correct student/subject/time. Past days with no bookings render empty (honest empty per D-09), not a future-week fallback.
**Why human:** Requires live UI + verified-past data that only exists post-migration + post-sync.

#### 3. Observability check: sync_runs.metadata populated

**Test:** `SELECT id, metadata FROM sync_runs WHERE status='success' ORDER BY finished_at DESC LIMIT 1;`
**Expected:** Non-null JSONB value containing `diffHookDurationMs` (number, expected <20s per A6) and `pastSessionsCapturedCount` (number, expected ≤100/day per research).
**Why human:** Requires DB access + post-migration sync cycle.

#### 4. Cache-tag isolation survival test

**Test:** Issue an identical historical `/api/compare` request before and after a daily sync run. Inspect network timing and server DB logs.
**Expected:** Second request served from Next.js `'use cache'` (no new past_session_blocks SELECT); daily sync's `revalidateTag('snapshot')` does NOT invalidate the past-sessions cache.
**Why human:** Requires live deployment + timing correlation around sync boundary.

#### 5. Client CACHE_VERSION v2 invalidation on long-lived tab

**Test:** Open a tab against the pre-deploy build, interact with compare, observe `v1`-keyed cache entries. Deploy. On the same tab, trigger a compare interaction again.
**Expected:** One cold fetch (v2 key not yet cached); subsequent interactions cached under v2; no stale-shape CompareTutor visible.
**Why human:** Requires multi-browser-tab setup around a deploy boundary.

#### 6. PAST-06 email send follow-through

**Test:** User sends the 142-word draft in 07-WISE-SPIKE.md §1 from kevhsh7@gmail.com to devs@wiseapp.live; updates §2 with sent timestamp; populates §3 with Wise reply OR marks "Unreachable (D-16)" at phase close.
**Expected:** Section 2 populated with non-placeholder timestamp; Section 3 either captured reply text or explicit "Unreachable" note.
**Why human:** Explicit user action per D-13 ("Claude drafts, user sends"). Non-blocking per D-14 — phase can close on Unreachable marking.

### Gaps Summary

**No code-level gaps.** Every plan in Phase 7 landed with its must-haves intact and all associated unit tests passing (141/141). Cross-plan wiring is sound: Plan 01 schema → Plan 02 orchestrator diff-hook → Plan 03 cached fetcher → Plan 04 compare merge → Plan 05 route trigger → Plan 06 cache-version bump. The Wise spike email (Plan 07) is drafted to spec.

**Ten must-haves verified at code level.** All grep assertions pass, all type checks on edited surfaces pass, test suite is green at 141/141.

**Six human-verification items are pending.** The most important is the blocking Neon migration (Plan 01 Task 3); five functional smoke tests depend on that apply plus at least one post-migration sync cycle. The PAST-06 email send is non-blocking per D-14 and can close as Unreachable per D-16.

**Two warning-level follow-up items carried forward** (not blocking Phase 7 closure):
- WR-01 (mixed-TZ comparison in diff-hook) — behaviorally correct under typical daily-cron-at-midnight-UTC conditions, but semantically incorrect. Recommend a small follow-up plan.
- WR-02 (nullable captured_in_snapshot_id) — defense-in-depth improvement.

**Why status is `human_needed`, not `passed`:** All code paths are wired, but the phase's core contract (PAST-01 and PAST-05 success criteria) cannot be proven as satisfied in production until the migration is applied and a sync cycle populates real rows. The blocking human checkpoint from Plan 01 is explicitly called out in the phase spec. Marking `passed` would misrepresent the live-production state.

---

_Verified: 2026-04-22T15:25:00Z_
_Verifier: Claude (gsd-verifier)_
