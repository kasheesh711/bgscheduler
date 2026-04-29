# Codebase Concerns

**Analysis Date:** 2026-04-29

## Tech Debt

**Non-atomic snapshot promotion (HIGH):**
- Issue: `runFullSync` performs the snapshot promotion as TWO separate UPDATE statements (`src/lib/sync/orchestrator.ts:471-481`). Step 1 deactivates the previously active snapshot, step 2 activates the new one. Neon's HTTP driver does not support transactions (acknowledged at `src/lib/sync/past-sessions-diff-hook.ts:60-62`).
- Files: `src/lib/sync/orchestrator.ts:469-484`
- Impact: A network failure or process termination between the two updates leaves the system with ZERO active snapshots. Every subsequent call to `ensureIndex` (`src/lib/search/index.ts:281-305`) and `buildIndex` (`src/lib/search/index.ts:115-125`) throws `"No active snapshot found"` with HTTP 500. Application is unavailable until manual recovery or next successful sync.
- Fix approach: Either (a) switch the sync entry point to the WebSocket-based Neon driver for transactional support, or (b) update both rows in a single SQL statement: `UPDATE snapshots SET active = (id = $newId)` so the atomicity is provided by the row-level lock on a single statement.

**Brittle data_issue → group join (MEDIUM):**
- Issue: `buildIndex` joins `data_issues` to `tutor_identity_groups` with O(issues × groups) nested loop, matching by `entityId === canonicalKey OR entityId === group.id OR entityName === displayName`. This triple-condition fallback exists because issue rows are written with inconsistent entity identifiers depending on the source (identity vs. modality vs. tag normalization).
- Files: `src/lib/search/index.ts:170-186`
- Impact: With current production volumes (251 issues × 72 groups = ~18k comparisons) this is fine, but it grows quadratically. More importantly, `entityName === displayName` fuzzy matching will silently misattribute issues if two groups ever share a display name.
- Fix approach: Normalize issue rows to ALWAYS write `entityId = group.id` (or `canonicalKey`) at the point of insertion in `src/lib/sync/orchestrator.ts`. Drop the `entityName` fallback. Build a single `Map<string, IndexedDataIssue[]>` keyed by canonical id.

**Modality location-pattern matching defeated by venue names (MEDIUM, known issue):**
- Issue: `deriveModality` checks `location` field against literal lowercased strings `"online"`, `"virtual"`, `"onsite"` (`src/lib/normalization/modality.ts:46-52`). Production venue names like "Think Outside the Box", "Tesla", "Nerd" do not match — all default to onsite. CLAUDE.md notes the visual distinction (dashed border) was removed pending reliable detection.
- Files: `src/lib/normalization/modality.ts:42-63`
- Impact: All single-record onsite groups have unverifiable modality. Search results may show a tutor as "onsite available" when the underlying session is actually online. Compare view shows `HelpCircle` (unknown) icons more often than expected.
- Fix approach: Stop relying on `location` substring matching. Instead use `sessionType` field from Wise API as primary signal. If `sessionType` is unreliable too, escalate to Wise team (per `.planning/phases/07-WISE-SPIKE.md`) for an `isOnline` boolean on session records.

**Past-day session fallback heuristic (MEDIUM, known issue):**
- Issue: Wise's `status: "FUTURE"` API does not return past sessions. `buildCompareTutor` falls back to "nearest future occurrence of the same recurring session" for past weekdays in the requested week (`src/lib/search/compare.ts:262-291`). One-time past sessions cannot be recovered.
- Files: `src/lib/search/compare.ts:225-291`, `src/lib/data/past-sessions.ts`
- Impact: Compare view for a past week shows representative future occurrences instead of actual historical sessions. Conflict detection on past weeks is unreliable. Phase 7 PAST-01 mitigates by capturing dropped sessions into `past_session_blocks` table going forward, but no backfill exists for sessions that dropped before deployment.
- Fix approach: Phase 7 diff-hook already in place (`src/lib/sync/past-sessions-diff-hook.ts`). Sessions captured from this point forward will be available via `fetchPastSessionBlocks`. No retroactive fix possible.

**Stale-data threshold mismatched to sync cadence (LOW):**
- Issue: `staleThresholdMs` defaults to 35 minutes (`src/lib/search/engine.ts:24`, `src/app/api/compare/route.ts:85`, `src/app/api/compare/discover/route.ts:60`). But the daily cron runs every 24 hours (`vercel.json:5`). The "stale" warning is permanently true 23+ hours per day.
- Files: `src/lib/search/engine.ts:24`, `src/app/api/compare/route.ts:85`, `src/app/api/compare/discover/route.ts:60`
- Impact: Stale warning is meaningless noise. Either every UI shows a stale warning all day, or admins ignore it.
- Fix approach: Either (a) raise threshold to 26 hours to match Hobby cron cadence, or (b) upgrade Vercel to Pro for 30-min sync (which would make the existing 35-min threshold meaningful).

**Empty catch swallows cleanup errors (LOW):**
- Issue: Sync orchestrator's outer error handler tries to write the failure to `sync_runs` and silently ignores any failure of that write itself: `.catch(() => {})` at `src/lib/sync/orchestrator.ts:524`.
- Files: `src/lib/sync/orchestrator.ts:512-525`
- Impact: If the DB is fully unreachable, the sync run never gets marked as `failed`. The `data-health` page will show the stuck row in `running` state. Operators have no visibility into the actual error.
- Fix approach: At minimum, `console.error` the cleanup failure. Consider returning a separate result code to the route handler so it can return a more accurate HTTP response.

**TODO marker for unimplemented modality tier (LOW):**
- Issue: Single TODO in source flags missing `medium` confidence tier in modality display. CLAUDE.md notes 06-CONTEXT.md D-03 anticipates this, but no follow-up phase exists.
- Files: `src/components/compare/modality-display.ts:9-11`
- Impact: When a future sync ever emits `confidence: "medium"`, the helper falls through to `unknown` styling, masking the medium-confidence intent in the UI.
- Fix approach: Either (a) extend `modalityDisplay` to handle `"medium"` now with a third icon/label, or (b) remove the TODO and document that medium tier is intentionally not implemented.

## Known Bugs

**`detectConflicts` `indexedGroups` parameter is unused (LOW):**
- Symptoms: Function signature accepts `indexedGroups` but never reads it.
- Files: `src/lib/search/compare.ts:321` — parameter declared, body uses only `compareTutors`.
- Trigger: Always — dead parameter.
- Workaround: None needed; harmless. Indicates incomplete refactor or cargo-culted signature.

**Asia/Bangkok timezone derivation via `toLocaleString("en-US", ...)` (MEDIUM):**
- Symptoms: Several modules compute "now in Bangkok" by round-tripping through `Date.toLocaleString` and parsing the result back with `new Date(...)`: `src/app/api/compare/route.ts:28-30`, `src/hooks/use-compare.ts:22-26`, `src/components/compare/week-overview.tsx:235`, `src/components/compare/calendar-grid.tsx:67`.
- Files: As above (5+ call sites).
- Trigger: This pattern produces a Date whose UTC fields appear to be Bangkok local time but is interpreted by all other Date code as UTC. Subsequent arithmetic with `.getDay()`, `.getHours()`, etc. accidentally works because the internal fields match — but the resulting Date is NOT a valid instant.
- Workaround: `src/lib/normalization/timezone.ts` correctly uses `toZonedTime` from `date-fns-tz`. The mixed-style calls bypass the canonical helper.
- Fix approach: Replace all `new Date(new Date().toLocaleString(...))` patterns with `toZonedTime(new Date(), TIMEZONE)` from `src/lib/normalization/timezone.ts`. Centralize the "current time in BKK" helper.

**Multi-day leave overlap check uses local-time minutes incorrectly (MEDIUM):**
- Symptoms: `hasRecurringLeaveConflict` walks each day of a leave range and tests `leaveStart.getHours() * 60 + leaveStart.getMinutes()` against the slot's start/end minutes (`src/lib/search/engine.ts:240-269`). For multi-day leaves, the entire day is blocked (line 262), but the start-minute calculation only uses `leaveStart` regardless of which day the loop is on.
- Files: `src/lib/search/engine.ts:240-269`
- Trigger: A multi-day leave that happens to cover the requested weekday but where the leave's first calendar day is NOT the same weekday will use the wrong start/end minutes.
- Workaround: The `isMultiDay` branch (line 259-262) catches this with the > 24h short-circuit. Single-day leaves work correctly.
- Fix approach: Compute leave-start/end minutes from the `current` cursor's date, not from `leaveStart`. Or just always treat multi-day leaves as full-day blocks (current behavior) and document the assumption.

## Security Considerations

**Cron secret authorization compares string equality (MEDIUM):**
- Risk: `authHeader !== `Bearer ${cronSecret}`` (`src/app/api/internal/sync-wise/route.ts:15`) uses non-constant-time comparison. Theoretical timing attack if an attacker can repeatedly probe.
- Files: `src/app/api/internal/sync-wise/route.ts:11-17`
- Current mitigation: CRON_SECRET is environment-only; Vercel cron sends it correctly.
- Recommendations: Use `crypto.timingSafeEqual` over equal-length buffers. Low priority since admin-only single-tenant tool, but worth fixing.

**Middleware bypass: `/api/internal/*` is unauthenticated at the middleware layer (LOW):**
- Risk: `src/middleware.ts:11` allows `/api/internal/*` through without checking auth. Each internal route must self-protect.
- Files: `src/middleware.ts:7-14`, `src/app/api/internal/sync-wise/route.ts:11-17`
- Current mitigation: `sync-wise` route checks `CRON_SECRET` itself.
- Recommendations: Document the contract that internal routes MUST self-authenticate. Add a comment to `middleware.ts` listing every internal route's auth mechanism. Risk: a future engineer adds `/api/internal/foo/route.ts` and forgets to gate it.

**Admin allowlist queried per signin via uncached DB read (LOW):**
- Risk: `auth.signIn` callback hits Postgres on every login attempt to check the allowlist (`src/lib/auth.ts:22-29`). Vulnerable to slow login if DB is degraded.
- Files: `src/lib/auth.ts:18-30`
- Current mitigation: Login traffic is low (admin-only tool, ~10 users).
- Recommendations: At admin scale this is fine. If user count grows, cache the allowlist in module memory with `cacheTag("admin-users")` invalidated on seed.

**Wise API credentials passed via Basic Auth + duplicated headers (LOW):**
- Risk: WiseClient sends the API key in both `Authorization: Basic` AND `x-api-key` headers (`src/lib/wise/client.ts:37-46`). Slightly increases blast radius if a request log leaks.
- Files: `src/lib/wise/client.ts:37-46`
- Current mitigation: HTTPS-only target (`https://api.wiseapp.live`).
- Recommendations: This is a Wise tenant requirement (per AGENTS.md), not optional. No action needed unless Wise documents a single-header alternative.

**`process.env.WISE_USER_ID!` and `process.env.WISE_API_KEY!` non-null assertions (LOW):**
- Risk: If env vars are missing, `createWiseClient` returns a client with `undefined` credentials and the `Buffer.from` call throws at request time, not at startup.
- Files: `src/lib/wise/client.ts:117-122`
- Current mitigation: `src/lib/env.ts` validates env vars at module load with Zod. But `client.ts` does not import or use `env.ts`.
- Recommendations: Replace `process.env.WISE_USER_ID!` with `env.WISE_USER_ID` (validated at startup).

## Performance Bottlenecks

**Sync timing close to Vercel function ceiling (HIGH):**
- Problem: First production sync took 4m26s on a 5m (300s) ceiling. ~34s of headroom. As teacher count grows, this ceiling will be hit.
- Files: `src/app/api/internal/sync-wise/route.ts:7` (`maxDuration = 300`), `src/lib/sync/orchestrator.ts`, `src/lib/wise/fetchers.ts:49-91` (per-teacher 26-window leave stitching)
- Cause: Per-teacher availability fetch issues 1 working-hours request + 25 leave-window requests, each batched but bottle-necked by `maxConcurrency: 15`. With 131 teachers × 26 windows = 3,406 Wise API calls per sync. At 15 concurrent ≈ 227 batches × ~1s/batch = ~3.8 minutes just for leaves.
- Improvement path:
  1. Reduce horizon from 180 days to 90 days (cuts windows from 26 to 13).
  2. Ask Wise team for a multi-window `availability` endpoint (eliminates the stitching loop entirely).
  3. Upgrade Vercel to Pro for higher function ceilings AND 30-minute cron.
  4. Split sync into "teachers + working hours" (fast) and "leaves" (deferred, paginated background job).

**`buildIndex` loads entire snapshot every cold-start (MEDIUM):**
- Problem: Every API route calls `ensureIndex` which fetches all 6 snapshot tables in parallel (`src/lib/search/index.ts:135-161`). On a cold serverless instance, first request pays full DB latency.
- Files: `src/lib/search/index.ts:115-276`
- Cause: Index lives in `globalThis` (line 81-86) — survives HMR but NOT cold starts. Each new Vercel invocation rebuilds.
- Improvement path: With current 72 groups × ~200 sessions × ~30 windows, the index is small enough that rebuild is sub-second. Concern grows if scale ever reaches 1000+ tutors. Long-term: snapshot the index to JSONB column, deserialize on cold start.

**Compare API rebuilds entire CompareTutor for unchanged tutors (LOW):**
- Problem: When client adds a new tutor, server rebuilds CompareTutor for ALL selected tutors (`src/app/api/compare/route.ts:135-142`) just to compute conflicts/free-slots. Only the new tutor's serialized data is sent back via `fetchOnly` (line 167-169), but the server still does the work.
- Files: `src/app/api/compare/route.ts:135-169`, `src/lib/search/compare.ts:225-319`
- Cause: Conflict and free-slot detection require all selected tutors. Cannot be incrementalized without server-side cache.
- Improvement path: Acceptable for ≤3 tutors. If max selection ever grows, cache CompareTutor by `(tutorGroupId, weekStart, snapshotId)` in module memory.

**O(n²) overlap detection in `WeekOverview.computeOverlapColumns` (LOW):**
- Problem: Nested loop on indices to compute union-find groups (`src/components/compare/week-overview.tsx:134-142`). For typical N≤20 sessions per day, fine. Worst case: N=80 sessions, 6,400 comparisons.
- Files: `src/components/compare/week-overview.tsx:84-155`
- Cause: Algorithm is correct but not optimal.
- Improvement path: Sweepline-based interval graph would be O(n log n). Defer until N exceeds ~100/day.

**`detectConflicts` is O(students × overlaps²) (LOW):**
- Problem: Nested for-loop over student-session pairs (`src/lib/search/compare.ts:336-355`). For each student appearing in multiple tutors, all pairs are compared.
- Files: `src/lib/search/compare.ts:321-358`
- Cause: Acceptable at admin-scale (3 tutors × ~30 sessions ≤ 90 entries per student).
- Improvement path: None needed at current scale.

## Fragile Areas

**Snapshot index race on simultaneous rebuild + active-flag flip (HIGH):**
- Files: `src/lib/search/index.ts:281-305`, `src/lib/sync/orchestrator.ts:469-484`
- Why fragile: `ensureIndex` reads `snapshots WHERE active = true` (line 285-289), then if stale rebuilds. But snapshot promotion is two non-atomic UPDATEs (see "Tech Debt"). Window between deactivate-old and activate-new returns ZERO rows from `WHERE active = true` — `ensureIndex` will throw `"No active snapshot found"` from `buildIndex` (line 124).
- Safe modification: Always check `if (!activeSnapshot)` before failing; fall back to the previously cached index with a stale warning. Or fix the underlying non-atomic promotion.
- Test coverage: No integration test for "promotion happening during read" race. `src/lib/search/index.ts` has zero unit tests.

**Concurrent index rebuild promise leak (MEDIUM):**
- Files: `src/lib/search/index.ts:296-305`
- Why fragile: `ensureIndex` checks `getBuildingPromise()` to coalesce concurrent rebuilds. But this is non-atomic in JavaScript: two simultaneous calls that both find `null` will both start a rebuild (the first sets, the second overwrites). The second rebuild's promise wins; the first rebuild still runs but its result is discarded.
- Safe modification: Wrap the check-and-set in a single synchronous block before any await. Currently the await happens between `getCurrentIndex()` (line 282) and `setBuildingPromise(p)` (line 301), so a second caller can interleave.
- Test coverage: None. `__tests__` directory has no `index.test.ts`.

**`globalThis.__bgscheduler_*` survives across HMR but not invocations (MEDIUM):**
- Files: `src/lib/search/index.ts:81-86`, `src/lib/db/index.ts:16-19`
- Why fragile: Pattern works for dev (HMR) and within a warm Vercel function instance, but each cold-start rebuilds. There's also no protection against module re-imports creating multiple `__bgscheduler_searchIndex` namespaces if the bundler splits the module.
- Safe modification: Document the contract. Add a unit test that asserts `getCurrentIndex()` returns the same reference across multiple `import` statements.
- Test coverage: None.

**Identity resolution silently merges teachers with the same nickname (HIGH):**
- Files: `src/lib/normalization/identity.ts:111-150`
- Why fragile: If two teachers happen to have the same nickname (e.g. "Kev"), they're merged into one canonical group with no warning. A real-world false-positive would silently combine two unrelated tutors' availability into one phantom tutor.
- Safe modification: Detect collisions: `if (entries.length > 2 && !allOnlineOffsetPair(entries)) issues.push(...)`. Currently a 3-member group is treated identically to a 2-member online/offline pair.
- Test coverage: `src/lib/normalization/__tests__/identity.test.ts` covers happy paths; no test for "three teachers with the same nickname".

**`recurrenceId` dedup in fallback can mask genuine conflicts (MEDIUM):**
- Files: `src/lib/search/compare.ts:274-289`
- Why fragile: When pulling nearest-future-occurrence for missing weekdays, the dedup is by `recurrenceId`. If a tutor has TWO different recurring series at the same weekday/time (one for student A, one for student B), only the first sorted by start-time wins. The second is silently dropped from the compare view.
- Safe modification: Dedup by `(recurrenceId, studentName)` instead.
- Test coverage: `src/lib/search/__tests__/compare.test.ts` tests the fallback path but does not cover multi-recurrence-per-weekday.

**Wise client retry doesn't distinguish 4xx from 5xx (MEDIUM):**
- Files: `src/lib/wise/client.ts:67-91`
- Why fragile: The retry loop catches ALL fetch errors and ALL non-OK responses indiscriminately. A 401 (bad creds), 404 (bad URL), or 422 (bad request body) gets retried 3 times with backoff before failing — wastes ~7 seconds and ~12 API calls per request on a permanent error.
- Safe modification: Don't retry on 4xx (client errors are not transient). Only retry on 5xx, network errors, or 429.
- Test coverage: `src/lib/wise/__tests__/client.test.ts` exists but doesn't enumerate status codes for retry policy.

## Scaling Limits

**Sync function timeout (CRITICAL — already at threshold):**
- Current capacity: 4m26s for 131 teachers, 26 leave windows each
- Limit: Vercel Hobby 300s function timeout
- Scaling path: Either (a) Pro plan for higher ceiling, (b) reduce horizon days, (c) split sync into multiple functions, (d) negotiate with Wise for batch endpoints.

**In-memory index size (LOW):**
- Current capacity: 72 groups × ~30 windows × ~200 sessions = ~3-5 MB serialized
- Limit: Vercel function memory budget (1024 MB on Hobby)
- Scaling path: Plenty of headroom. Concern only at 10,000+ tutors.

**Vercel cron cadence (HIGH — known issue):**
- Current capacity: Daily on Hobby plan
- Limit: Hobby plan does not support sub-daily crons
- Scaling path: Upgrade to Pro for 30-minute cadence.

**Compare cache key collisions (LOW):**
- Current capacity: Cache keyed on `${tutorGroupId}:${weekStart}:${CACHE_VERSION}` (`src/hooks/use-compare.ts:140`).
- Limit: Map grows unbounded as user navigates weeks. ~50KB per (tutor, week) entry × hundreds of weeks = potential ~50MB browser memory.
- Scaling path: Add LRU eviction at ~50 entries. Currently no eviction.

## Dependencies at Risk

**`next-auth: ^5.0.0-beta.30` (HIGH):**
- Risk: Beta release of Auth.js v5. Breaking changes between betas; no LTS guarantee. Beta 30 is from a moving train.
- Impact: Major upgrades may require migration work for `auth()` callback, JWT handling, session shape.
- Migration plan: Pin to exact version (no caret) until v5 stable releases. Monitor https://github.com/nextauthjs/next-auth/releases. When v5 GA lands, upgrade in a dedicated phase.

**`@auth/drizzle-adapter: ^1.11.1` (MEDIUM):**
- Risk: Imported (`package.json:14`) but not actually used — auth uses a custom callback against `admin_users` (`src/lib/auth.ts:22-29`), not the Drizzle adapter.
- Impact: Dead dependency increasing bundle size.
- Migration plan: Remove from `package.json`.

**`shadcn: ^4.1.2` as a runtime dependency (LOW):**
- Risk: `shadcn` package in `dependencies` (`package.json:30`) — but shadcn/ui is a copy-paste component library. The CLI is normally a dev-only tool.
- Impact: Increases bundle size if the package is actually shipped.
- Migration plan: Move to `devDependencies` if only used at build time. Verify nothing in `src/` imports from `shadcn` directly.

**`@base-ui/react: ^1.3.0` (MEDIUM):**
- Risk: 1.x release of a relatively new library (formerly Radix internals, recently rebranded). Public API stability unclear.
- Impact: Major version bumps may require component prop updates. Used heavily in `src/components/ui/*`.
- Migration plan: Pin to exact version. Monitor changelog at https://base-ui.com.

**`drizzle-orm: ^0.45.2` (LOW):**
- Risk: Pre-1.0 — semver caret allows MINOR bumps which can include breaking changes.
- Impact: Schema or query API changes.
- Migration plan: Pin to exact version. Test migrations in staging before each upgrade.

**`zod: ^4.3.6` (LOW):**
- Risk: Major version 4 (released late 2025). Not all ecosystem libraries support v4 yet.
- Impact: Type inference changes between v3 → v4. Already migrated but watch for ecosystem libraries that pin to v3.
- Migration plan: Acceptable. Watch transient peer-dep warnings.

## Missing Critical Features

**Snapshot pruning / retention policy:**
- Problem: `snapshots`, `tutor_identity_groups`, `tutor_identity_group_members`, `recurring_availability_windows`, `dated_leaves`, `future_session_blocks`, `subject_level_qualifications`, `raw_teacher_tags`, `data_issues`, `snapshot_stats` are all snapshot-scoped and append-only. Daily sync creates a new full copy.
- Files: `src/lib/db/schema.ts`, `src/lib/sync/orchestrator.ts`
- Blocks: Long-running operation — every day adds ~131 teachers × all related rows. 1 year = ~365 snapshots × ~2-5MB = ~1-2 GB. Neon free tier is 0.5GB.
- Approach: Add a snapshot-pruning step at end of sync: keep last N=30 snapshots, delete older. Cascade deletes all snapshot-scoped tables. `past_session_blocks` is intentionally cross-snapshot (per `src/lib/db/schema.ts:213-214`) and unaffected.

**Sync run alerting / notification on failure:**
- Problem: Cron failures land in Vercel logs. No email, Slack, or other notification.
- Files: `src/app/api/internal/sync-wise/route.ts`
- Blocks: Silent stale data — admins only notice when Compare results look wrong.
- Approach: Add a webhook / email notification when `result.success === false`. Even a simple Slack incoming-webhook would close the gap.

**Tutor add/remove without full sync:**
- Problem: Wise API changes (new tutor, removed tutor, changed availability) only propagate after the next daily sync.
- Files: `src/lib/sync/orchestrator.ts`
- Blocks: Up to 24h staleness; admins cannot react to urgent updates.
- Approach: Manual admin "sync now" button. Already supported via `POST /api/internal/sync-wise` with CRON_SECRET, but no UI button.

**Stale snapshot self-recovery:**
- Problem: If sync fails repeatedly, the system silently keeps serving stale data. The `data-health` page surfaces it but admins have to actively check.
- Files: `src/app/(app)/data-health/page.tsx`, `src/app/api/data-health/route.ts`
- Blocks: Silent decay of accuracy.
- Approach: When `staleAgeMs` exceeds threshold (e.g. 48h), display a banner on `/search` and `/compare` pages, not just `/data-health`.

## Test Coverage Gaps

**Sync orchestrator integration (HIGH):**
- What's not tested: `runFullSync` end-to-end. The critical path (fetch → normalize → persist → promote) has no integration test that exercises the actual DB.
- Files: `src/lib/sync/orchestrator.ts:45-539`
- Risk: Schema migration or query change could break sync silently. Only the daily cron would catch it — at 24h delay.
- Priority: HIGH

**Search index build/ensure (HIGH):**
- What's not tested: `buildIndex`, `ensureIndex`, the `globalThis` singleton, the building-promise coalescing.
- Files: `src/lib/search/index.ts` — no `__tests__/index.test.ts` exists.
- Risk: Every API route depends on this. Race conditions and stale-detection bugs would surface only under production load.
- Priority: HIGH

**API route handlers (HIGH):**
- What's not tested: All 7 API routes (`src/app/api/{compare,compare/discover,filters,tutors,search,search/range,data-health}/route.ts`, `src/app/api/internal/sync-wise/route.ts`). Auth, validation, and error paths uncovered.
- Files: All route.ts files.
- Risk: A schema validation regression silently breaks a route in production.
- Priority: HIGH

**Client UI components and hooks (MEDIUM):**
- What's not tested: `useCompare` hook (`src/hooks/use-compare.ts`), `WeekOverview` (`src/components/compare/week-overview.tsx`), `CalendarGrid` (`src/components/compare/calendar-grid.tsx`), `SearchForm` (`src/components/search/search-form.tsx`), `DiscoveryPanel` (`src/components/compare/discovery-panel.tsx`), `RecommendedSlots` (`src/components/search/recommended-slots.tsx`).
- Files: All `src/components/**/*.tsx` and `src/hooks/*.ts`.
- Risk: AbortController logic, cache invalidation on snapshot change, recursive retry guard (`use-compare.ts:127-134`), overflow detection — all are implemented but unverified by tests.
- Priority: MEDIUM (requires React Testing Library + jsdom setup)

**Auth flows (MEDIUM):**
- What's not tested: `signIn` callback's allowlist check (`src/lib/auth.ts:18-30`), middleware bypass logic for `/api/internal/*`.
- Files: `src/lib/auth.ts`, `src/middleware.ts`
- Risk: A future change might accidentally allow non-admin users in.
- Priority: MEDIUM

**Past sessions diff-hook integration (MEDIUM):**
- What's not tested: End-to-end "prior snapshot has session X, new sync drops X, X is past → captured into past_session_blocks". Existing `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` is unit-level with mock DB.
- Files: `src/lib/sync/past-sessions-diff-hook.ts`
- Risk: Captured as `partial` with `verification_status: needs_human` in v1.1 milestone audit.
- Priority: MEDIUM

**Timezone correctness (MEDIUM):**
- What's not tested: The mixed `toLocaleString` + `new Date` pattern in `src/app/api/compare/route.ts:28-30`, `src/hooks/use-compare.ts:22-26`, `src/components/compare/week-overview.tsx:235`. No DST tests (Bangkok has no DST, but Vercel server might).
- Files: As above.
- Risk: Subtle weekday off-by-one when sync runs at a UTC hour where Bangkok is the next/previous day.
- Priority: MEDIUM

**Modality contradiction emission (LOW):**
- What's not tested: The MOD-01 per-session contradiction loop in `src/lib/sync/orchestrator.ts:356-387`. `compare.test.ts` tests `detectSessionModalityConflict` in isolation, but the orchestrator-side persistence is uncovered.
- Files: `src/lib/sync/orchestrator.ts:356-387`
- Risk: A regression could stop emitting `conflict_model` issues to `data_issues` table.
- Priority: LOW

---

*Concerns audit: 2026-04-29*
