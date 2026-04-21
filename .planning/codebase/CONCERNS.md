# Codebase Concerns

**Analysis Date:** 2026-04-21

## Tech Debt

**Legacy `/api/search` route (backward compatibility only):**
- Issue: Slot-based legacy search endpoint still exists alongside the newer `/api/search/range`. Frontend primarily uses range search; the legacy route is retained "for backward compatibility" per AGENTS.md but no callers were found in `src/`.
- Files: `src/app/api/search/route.ts` (62 lines)
- Impact: Dead-code surface area, duplicated Zod schemas, two codepaths that must both stay aligned with `executeSearch` changes. Another entry point that must be considered when updating search logic.
- Fix approach: Grep frontend components for `/api/search"` POSTs. If none, delete `src/app/api/search/route.ts` and its Zod schema; keep `/api/search/range` as the single entry point. If external callers exist (e.g., historical bookmarks, scripts), add a deprecation header and redirect.

**`modality-display.ts` forward-looking TODO for `medium` confidence tier:**
- Issue: Helper only handles `high`/`low` confidence. `medium` tier is reserved in the type but not emitted by `resolveSessionModality`. A TODO references the future phase that will activate it.
- Files: `src/components/compare/modality-display.ts:9` (TODO comment), `src/lib/search/compare.ts:46-57` (type declared)
- Impact: If `medium` is emitted before the display helper is extended, the UI falls through to the `"unknown"` branch (visually identical to low). Fail-closed default, but hides intended distinction.
- Fix approach: Either extend `modalityDisplay()` at the same time `medium` emission lands, or add a runtime assertion in dev to catch premature `medium` tier usage.

**Two independent `getCurrentMonday` implementations drift risk:**
- Issue: Week-boundary logic is duplicated between server (`src/app/api/compare/route.ts:20-28`) and client (`src/hooks/use-compare.ts:20-28`). Both convert `new Date()` to Asia/Bangkok via `toLocaleString`, but they are not shared.
- Files: `src/app/api/compare/route.ts:20-28`, `src/hooks/use-compare.ts:20-28`
- Impact: Any fix to DST handling, week-start convention (e.g., Sunday vs Monday), or timezone edge cases must touch two places. Silent divergence could cause the client to send `weekStart` that disagrees with the server's default when `weekStart` is omitted, leading to duplicate full-week fetches.
- Fix approach: Hoist both to a shared util in `src/lib/search/week-utils.ts` (safe for client and server; no Node-only imports).

**Ad-hoc timezone handling via `toLocaleString("en-US")`:**
- Issue: Week boundaries are derived by `new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }))` rather than `date-fns-tz` (already in the dependency tree as the canonical timezone utility).
- Files: `src/app/api/compare/route.ts:21`, `src/hooks/use-compare.ts:23`
- Impact: The returned `Date` object has incorrect underlying UTC milliseconds (it's local-in-BKK interpreted as local-in-runtime). Works for date-extraction, fragile for arithmetic. A different server region or DST anomaly could shift the week boundary.
- Fix approach: Use `toZonedTime()` from `date-fns-tz` (already imported in `src/lib/normalization/timezone.ts`) for all BKK conversions.

**Normalization of session modality via `location` field pattern-matching (MOD-02 partially remediated):**
- Issue: `deriveModality` in `src/lib/normalization/modality.ts:44-63` inspects `locations.has("online")` / `locations.has("virtual")` / `locations.has("onsite")`. Most Wise sessions have venue names ("Think Outside the Box", "Tesla", "Nerd") that never match, so the fallback keeps triggering "onsite" evidence weakly. Compare-layer `resolveSessionModality` now has stricter rules, but sync-layer still uses the soft heuristic.
- Files: `src/lib/normalization/modality.ts:38-63`
- Impact: Visual modality distinction (dashed vs solid border) was removed from cards pending reliable detection per CLAUDE.md. Group-level `supportedModality` can still be resolved on weak evidence, which then flows into `IndexedTutorGroup.supportedModes` and gates search results. Risk of silently allowing online searches to match onsite-only tutors (and vice versa).
- Fix approach: Continue consolidating to `isOnlineVariant` + Wise `sessionType` as the two authoritative signals (MOD-01 series in `.planning/phases/06-mod-01-reliable-modality-detection/`). Delete the `location`-based branch from `deriveModality` once `resolveSessionModality` is the single source of truth.

**Sync orchestrator is a single 514-line function:**
- Issue: `runFullSync()` in `src/lib/sync/orchestrator.ts:44-514` is one giant try-catch with 12 numbered steps inline. Steps 1-12 do DB writes, API fetches, normalization, and atomic promotion.
- Files: `src/lib/sync/orchestrator.ts`
- Impact: Hard to unit-test individual steps (sync has **zero tests** — `src/lib/sync/__tests__/` is empty). Hard to resume partial syncs. Hard to inject mocks for individual phases. Partial failure recovery is all-or-nothing.
- Fix approach: Extract each numbered step into a named function (`fetchTeachersStep`, `persistIdentitiesStep`, `promoteSnapshotStep`, …), keep `runFullSync` as a thin orchestrator. Add unit tests per step using a mocked `Database` and `WiseClient`.

**Fan-out sequential inserts per-group in sync orchestrator:**
- Issue: `src/lib/sync/orchestrator.ts:102-126` inserts `tutorIdentityGroups` one row at a time (awaiting each `.returning()` to populate `groupIdMap`), then `fetchTeacherFullAvailability` runs in the sync orchestrator per-teacher in a `for` loop at line 147. Neon HTTP has ~50-150ms round-trip per statement.
- Files: `src/lib/sync/orchestrator.ts:102-126`, `src/lib/sync/orchestrator.ts:147-251`
- Impact: With 131 teachers and ~72 groups, this is ~200+ sequential round-trips. Latest sync was 4m26s (~34s margin under Vercel's 300s ceiling). If tutor headcount grows 30%+, this will time out.
- Fix approach: (1) Batch insert identity groups with a single `.values([...]).returning()` call to map `canonicalKey → id`. (2) Parallelize the per-teacher availability fetch using the existing `WiseClient` concurrency limiter (already set to `maxConcurrency: 15`). Today the loop is sequential (`for…of` with `await`), so the limiter is underutilized.

---

## Known Bugs

**Online/onsite detection shows all sessions as "onsite":**
- Symptoms: Compare view cards render with solid (onsite) styling even for sessions that are actually online. Visual distinction (dashed border) was removed pending reliable detection.
- Files: `src/lib/normalization/modality.ts:44-52` (evidence pattern match), `src/components/compare/modality-display.ts:12-28` (UI), `src/lib/search/compare.ts:4-5` (`ONLINE_SESSION_TYPES`/`ONSITE_SESSION_TYPES` sets)
- Trigger: Any session whose `location` is a venue name rather than "online"/"virtual"/"zoom". Majority of real sessions.
- Workaround: Modality info still shown in popover; the dashed/solid border distinction is disabled until detection becomes reliable. MOD-01 phase is in-progress per `.planning/phases/06-mod-01-reliable-modality-detection/`.

**Past-day session data is missing from compare week view:**
- Symptoms: Days earlier than the last sync show the "nearest future occurrence" of a recurring session as a placeholder, or are empty.
- Files: `src/lib/search/compare.ts:203-232` (weekday fallback logic)
- Trigger: Wise's `status: "FUTURE"` API endpoint only returns sessions with start time >= now. Past recurring instances are unrecoverable. One-time past sessions cannot be recovered at all.
- Workaround: `buildCompareTutor` has a fallback that pulls the next future occurrence of the same `recurrenceId` for past weekdays. Labeled in the UI via `date: dateRange ? formatDate(s.startTime) : undefined` — user sees the actual date of the representative, not the requested past date.

**Recurring-mode leave-conflict check iterates day-by-day through leave range:**
- Symptoms: Performance cliff for very long leaves.
- Files: `src/lib/search/engine.ts:240-270`
- Trigger: A tutor with a multi-month leave window will iterate `(current <= leaveEnd)` every single day. For a 180-day leave (the max horizon), that's 180 iterations per leave per candidate tutor per slot.
- Workaround: Not urgent at current data volume (~72 groups × small leave counts), but worth flagging. Replace with direct interval math: "does `weekday` fall within `[leaveStart, leaveEnd]`?".

**Issue-to-group matching in search index uses triple-OR fallback:**
- Symptoms: Potential false attribution of data issues to wrong groups.
- Files: `src/lib/search/index.ts:166-181`
- Trigger: Issues are attached by matching on `entityId === group.canonicalKey` OR `entityId === group.id` OR `entityName === group.displayName`. If two groups share a `displayName` (e.g. two teachers both named "John"), issues could attach to both.
- Workaround: Unlikely to occur because identity resolution deduplicates on canonical key. But naming collisions after alias resolution could cause duplicate review flags. Consider tightening to just `entityId` matches once identity generation consistently populates `entityId`.

---

## Security Considerations

**`/api/internal/sync-wise` bypasses auth middleware entirely:**
- Risk: The middleware explicitly allowlists `/api/internal/*` without auth (`src/middleware.ts:11`). Route-level protection depends solely on the `Bearer $CRON_SECRET` header check.
- Files: `src/middleware.ts:11`, `src/app/api/internal/sync-wise/route.ts:10-17`
- Current mitigation: `handleSync` returns 401 unless `authHeader === "Bearer " + process.env.CRON_SECRET`. `CRON_SECRET` is validated at startup in `src/lib/env.ts:12` (required, non-empty).
- Recommendations: (1) Confirm Vercel cron requests carry `Authorization: Bearer <CRON_SECRET>` automatically — Vercel cron requires the secret in the request URL or header. (2) Both `GET` and `POST` are exposed (`src/app/api/internal/sync-wise/route.ts:35-42`); either remove one or ensure both enforce the check (they currently share `handleSync`, so both do). (3) Consider a timing-safe comparison — currently uses `===` which is vulnerable to timing attacks. Use `crypto.timingSafeEqual` for defense-in-depth.

**Google OAuth `clientId`/`clientSecret` not strictly validated:**
- Risk: `auth.ts:10-11` reads `process.env.AUTH_GOOGLE_ID` and `process.env.AUTH_GOOGLE_SECRET` directly without the Zod-validated `env` helper.
- Files: `src/lib/auth.ts:10-11`, `src/lib/env.ts:5-6`
- Current mitigation: `env.ts` validates these at startup, but `auth.ts` reads `process.env` directly, bypassing the Zod-guarded import. If `auth.ts` is imported before `env.ts` initializes, validation could be skipped.
- Recommendations: Import `env` from `src/lib/env.ts` in `auth.ts`: `Google({ clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET })`.

**WISE credentials read with non-null assertions:**
- Risk: `src/lib/wise/client.ts:118-119` uses `process.env.WISE_USER_ID!` and `process.env.WISE_API_KEY!` (non-null assertions). If the env var is missing, runtime `Buffer.from("undefined:undefined")` produces a working-looking string that Wise will reject with 401.
- Files: `src/lib/wise/client.ts:116-123`
- Current mitigation: `src/lib/env.ts` validates both at startup. But the client file uses `process.env!`, not `env.*`.
- Recommendations: Switch `createWiseClient` to import the validated `env` object.

**Admin allowlist is email-string compare (case sensitive):**
- Risk: `signIn` callback in `src/lib/auth.ts:19-30` compares `user.email` against `adminUsers.email` using `eq()`. Google typically returns lowercased emails, but the seed order / capitalization in the DB matters.
- Files: `src/lib/auth.ts:23-30`, `src/lib/db/schema.ts:67-74` (unique index on `email`)
- Current mitigation: Seed script uses lowercase emails per CLAUDE.md's admin list. Unique index on email prevents duplicates.
- Recommendations: Normalize both sides to lowercase in the query: `eq(sql<string>\`lower(${adminUsers.email})\`, user.email.toLowerCase())`. Or enforce lowercase at seed time with a CHECK constraint.

**JSON body parsing has no size limit:**
- Risk: Route handlers call `await request.json()` without bounding payload size.
- Files: All POST routes (`src/app/api/compare/route.ts:53-57`, `src/app/api/search/route.ts:36-41`, etc.)
- Current mitigation: Vercel imposes platform-level body-size limits (4.5MB on Hobby).
- Recommendations: Add an explicit `Content-Length` check before `.json()` for non-sync endpoints. Not urgent given Vercel's platform limits and authenticated-only access.

**No rate limiting on authenticated API routes:**
- Risk: A logged-in admin (or an attacker with a stolen session cookie) can flood `/api/compare`, `/api/search/range`, etc.
- Files: All API routes under `src/app/api/`
- Current mitigation: Auth required for all except `/api/internal/*` (which has secret check). The in-memory index short-circuits most of the cost; DB hits only happen on snapshot change. Small admin user base (9 users).
- Recommendations: Not urgent. If scaling beyond Hobby, add Vercel's Edge Config rate limiting or a simple IP-based throttle.

---

## Performance Bottlenecks

**Sync duration near Vercel Hobby ceiling:**
- Problem: Last production sync was ~4m26s against a 300s (5m) function ceiling — ~34s margin. Teacher count 131, groups 72.
- Files: `src/app/api/internal/sync-wise/route.ts:7` (`maxDuration = 300`), `src/lib/sync/orchestrator.ts:44-514`
- Cause: Per-teacher sequential availability fetch + per-group sequential identity insert. Wise API has latency per call; concurrency limiter set to 15 but loop is `await`-ed sequentially (see "Fan-out sequential inserts" in Tech Debt).
- Improvement path: Parallelize per-teacher availability fetch with `Promise.all` bounded by `maxConcurrency`. Expected speedup: 3-5x on the fetch phase. Batch-insert identity groups. Same improvements listed above.

**Search index rebuild runs six parallel full-table scans per snapshot:**
- Problem: `buildIndex` in `src/lib/search/index.ts:131-156` runs `Promise.all` of 6 `SELECT * FROM <table> WHERE snapshot_id = ?`. Each table scan pulls every row for the active snapshot into the serverless function's memory.
- Files: `src/lib/search/index.ts:131-156`
- Cause: Designed for fast in-memory query access. Rebuild happens after every sync promotion, or on cold-start of a serverless instance.
- Improvement path: Current approach is correct for the "warm queries < 400ms" design goal. Monitor memory: 72 groups × ~tens of sessions + windows + leaves ≈ small. Will scale poorly past ~10x current data. Consider pagination or Redis if that happens.

**In-memory index is singleton per server process — no multi-instance sharing:**
- Problem: `globalThis.__bgscheduler_searchIndex` lives per-serverless-instance. A Vercel cold start will rebuild from scratch. Multi-region or auto-scaled instances each hold their own index.
- Files: `src/lib/search/index.ts:74-97` (global singleton + concurrent-rebuild guard)
- Cause: Design choice — single-region Hobby deployment is assumed.
- Improvement path: For current scale (Hobby, single region, 9 admins), this is fine. If upgrading to Pro + multi-region, consider Redis/Upstash for shared state.

**Client-side tutor cache grows unboundedly in session:**
- Problem: `useCompare` hook's `tutorCache` Map (`src/hooks/use-compare.ts:85`) adds entries on each fetch but only evicts on `removeTutor` or `changeWeek`. Keys are `"${id}:${week}:${CACHE_VERSION}"`. Across many week navigations, the cache accumulates.
- Files: `src/hooks/use-compare.ts:85`, `src/hooks/use-compare.ts:138-146`, `src/hooks/use-compare.ts:198-204`
- Cause: `changeWeek` calls `tutorCache.current.clear()` so that helps — but switching tutors without switching weeks continues to grow the cache within the current week.
- Improvement path: Bounded LRU or simple cap (e.g., max 30 entries) per client session. Very low priority: admin sessions are short and memory headroom is large.

**Issue-attribution in `buildIndex` is O(issues × groups):**
- Problem: `src/lib/search/index.ts:166-181` iterates every issue against every group to match by entity ID/name.
- Files: `src/lib/search/index.ts:166-181`
- Cause: Matches on three possible fields (`entityId === canonicalKey | id | entityName`); cannot use a direct map lookup.
- Improvement path: Normalize issue emission so `entityId` always equals `group.id` at sync time; then replace with a single `Map<string, Issue[]>` lookup.

---

## Fragile Areas

**Sync atomic promotion is two-step, not a single transaction:**
- Files: `src/lib/sync/orchestrator.ts:448-463`
- Why fragile: Promotion uses two separate `UPDATE` statements — `deactivate old` then `activate new`. Neither is in a transaction. If the function crashes between them, **no snapshot is active**. `ensureIndex` would throw "No active snapshot found" on every request.
- Safe modification: Wrap the two updates in a Drizzle transaction: `await db.transaction(async (tx) => { ... })`. Neon HTTP supports transactions. Verify Neon HTTP driver compatibility with Drizzle's transaction API before applying.
- Test coverage: Sync orchestrator has **zero unit tests** (empty `src/lib/sync/__tests__/`). Any change to promotion logic is unverified.

**Snapshot-change detection during client compare fetch uses recursion:**
- Files: `src/hooks/use-compare.ts:124-135`
- Why fragile: If the snapshot changes mid-fetch, the client clears the cache and recursively calls `fetchCompare(ids, week, { _retried: true })`. The guard `_retried: true` prevents infinite recursion but depends on exact property propagation. A future change that adds other retry triggers could recurse indefinitely.
- Safe modification: Convert to a `while` loop with a max-attempt counter, not recursion. Surface a clear error after N retries.

**Search index staleness check uses `.limit(1)` selecting the whole row:**
- Files: `src/lib/search/index.ts:276-281`
- Why fragile: On every `ensureIndex` call the code does `SELECT id FROM snapshots WHERE active = true LIMIT 1`. A race between `active=false` (step 1 of promotion) and `active=true` (step 2) could return no rows — `ensureIndex` would then pass `cached.snapshotId` forward, leaving the server serving stale data silently (or throw in `buildIndex`).
- Safe modification: (1) Wrap promotion in a transaction (see "atomic promotion" above). (2) Consider caching active snapshot ID with a short TTL to reduce per-request DB pressure.

**MOD-01 contradiction detection runs twice (sync + compare layers):**
- Files: `src/lib/sync/orchestrator.ts:352-386` (sync-time), `src/lib/search/compare.ts:59-134` (compare-time)
- Why fragile: Two implementations of "paired group + sessionType disagrees" logic. `detectSessionModalityConflict` was carefully hand-mirrored to `resolveSessionModality`. Any change to the rubric must update both; otherwise sync emits `conflict_model` issues that the compare layer disagrees with.
- Safe modification: Extract the shared predicate into a single function in `src/lib/search/compare.ts` and call it from the sync orchestrator. Test coverage in `src/lib/search/__tests__/compare.test.ts` (lines 104+) already exercises the matrix; extending to `detectSessionModalityConflict` is straightforward.

**Completeness threshold can block syncs if Wise data regresses:**
- Files: `src/lib/sync/orchestrator.ts:441-463`
- Why fragile: `unresolvedRatio = identityIssues.length / Math.max(groups.length, 1)`. Fails promotion if >50% unresolved. A one-off Wise API issue (e.g., malformed display names) could spike the ratio and block every subsequent sync until the underlying data is fixed. Sync will keep creating unpromoted snapshots, leaving stale production data.
- Safe modification: Emit a `critical`-severity `sync` data issue when promotion is blocked by threshold, and surface on `/data-health`. Add an escape hatch (env var or admin flag) to force-promote a snapshot manually.
- Test coverage: No tests around the 50% threshold logic.

**Identity resolution display-name collision:**
- Files: `src/lib/normalization/identity.ts:127-151`
- Why fragile: Groups keyed by lowercased canonical key. Two teachers with different parenthetical nicknames both normalizing to the same alias collapse into one group without any warning.
- Safe modification: Emit a `warning`-severity issue when a merge collapses teachers across different underlying Wise names, so admins can review.

---

## Scaling Limits

**Vercel serverless function duration (sync endpoint):**
- Current capacity: 300s cap (5 minutes). Latest sync: 266s.
- Limit: 300s on Hobby and Pro. Can only be extended via Enterprise plan or by switching to background jobs.
- Scaling path: (1) Parallelize per-teacher fetch in `orchestrator.ts` step 7. (2) Move sync to a queue-backed background job (e.g., Inngest, QStash). (3) Split into phases driven by separate cron entries.

**Vercel Hobby cron cadence (daily only):**
- Current capacity: Once per day at `0 0 * * *` per `vercel.json:4`.
- Limit: Hobby plan allows daily only. Pro plan supports every 30 minutes.
- Scaling path: Upgrade to Pro (per AGENTS.md). Zero code changes required; cron cadence is in `vercel.json`.

**In-memory index size:**
- Current capacity: 72 groups × ~O(10-100) sessions/windows/leaves each = small (< 10MB).
- Limit: Vercel serverless function memory is 1024MB on Hobby, 3008MB on Pro. Index itself is far below any limit.
- Scaling path: Not needed in the foreseeable future. Past 5x current data volume, consider paginated queries or a dedicated cache layer.

**Client-side: tutor combobox loads full tutor list:**
- Current capacity: `GET /api/tutors` returns all 72 groups.
- Limit: Becomes a UX bottleneck past ~500 tutors (combobox scroll performance, initial payload size).
- Scaling path: Switch to server-side search (`GET /api/tutors?q=<query>`) with debounced input.

---

## Dependencies at Risk

**`next-auth` at `^5.0.0-beta.30`:**
- Risk: Auth.js v5 is still in beta. Breaking changes may land before stable release.
- Impact: Auth flow is critical-path. Any breaking update will require handler rewrite.
- Migration plan: Pin to exact version (`"next-auth": "5.0.0-beta.30"`). Track https://authjs.dev/getting-started/migrating-to-v5 for GA notes. Consider switching to the stable channel once v5 final is released.

**`next@16.2.2`:**
- Risk: Next.js 16 is recent (note AGENTS.md warning: "This is NOT the Next.js you know — APIs, conventions, and file structure may all differ from your training data"). Middleware semantics and App Router conventions evolve across minor releases.
- Impact: Every upgrade risks subtle behavioral changes (middleware execution, caching, route segment config).
- Migration plan: Pin exact version in `package.json`. Read `node_modules/next/dist/docs/` before upgrading. Verify `middleware.ts`, `revalidateTag` behavior, and `maxDuration` export are still supported.

**`@neondatabase/serverless@^1.0.2`:**
- Risk: HTTP driver — does not support long-lived transactions like TCP `pg` driver. If sync orchestrator starts using transactions (recommended fix for atomic promotion), verify Drizzle's `db.transaction(...)` works on Neon HTTP.
- Impact: Transactional promotion would require Neon's `pool` driver or a separate WebSocket connection.
- Migration plan: Test `db.transaction` in a non-prod environment before relying on it.

**`drizzle-orm@^0.45.2` + `drizzle-kit@^0.31.10`:**
- Risk: Drizzle is pre-1.0; minor versions contain behavioral changes (schema-emit, migration format, type inference).
- Impact: `npm run db:generate` output can change shape between versions.
- Migration plan: Commit every generated migration verbatim. Regenerate only when intentionally upgrading.

**`shadcn@^4.1.2`:**
- Risk: This is the CLI package, not a runtime lib. Unusual to list as a dependency (not devDependency). Verify this is intentional — the `shadcn` CLI is typically a `devDependency` or `npx`-invoked.
- Files: `package.json:16`
- Migration plan: Move to `devDependencies` if not used at runtime.

**`@base-ui/react@^1.3.0`:**
- Risk: Base UI is relatively new (Radix replacement from the Radix team). API surface is still stabilizing.
- Impact: shadcn/ui components wrap it; a breaking change would require shadcn refactors.
- Migration plan: Pin exact versions for base-ui and shadcn primitives.

---

## Missing Critical Features

**Sync is not observable beyond `/data-health`:**
- Problem: No structured logging during sync. `console.error` is sprinkled in a few places; success/failure visible only through the admin page.
- Blocks: Debugging slow syncs, understanding why promotion was blocked, tracking API error rates from Wise.
- Impact: When (not if) a sync fails or runs past 300s, there's no log trail.
- Recommendation: Add Vercel logging with structured fields (step name, duration, counts) at each step boundary in `orchestrator.ts`.

**No observability for search index memory or latency:**
- Problem: `latencyMs` is returned in API responses but not aggregated anywhere. No warning on slow queries.
- Blocks: Detecting regressions when data volume grows.
- Recommendation: Log p95 latency to Vercel logs; optionally integrate Vercel Analytics or lightweight OpenTelemetry.

**No alerting on failed syncs:**
- Problem: If tomorrow's sync fails, no notification is sent. Admins find out next time they visit `/data-health`.
- Blocks: Timely response to Wise API outages or credential expiry.
- Recommendation: On sync failure, post to a Slack webhook or email (via Vercel Integrations, Resend, or similar). Can be a simple cron-invoked check, not part of the sync itself.

**No admin self-service for alias management:**
- Problem: `tutor_aliases` table is seeded via `npm run db:seed`. Adding a new alias requires a code change and deploy.
- Blocks: Operations. Common task ("Nacha goes by Poi") is a developer task.
- Recommendation: CRUD UI on `/data-health` for aliases. Low priority given the small alias list (~4 entries).

---

## Test Coverage Gaps

**Sync orchestrator has zero tests:**
- What's not tested: `runFullSync`, every step 1-12, the 50% completeness threshold, atomic promotion, failure-preserving-old-snapshot behavior.
- Files: `src/lib/sync/__tests__/` is empty. `src/lib/sync/orchestrator.ts` (514 lines).
- Risk: Every change to the most critical pipeline in the codebase is unverified. Production integration testing is the only safety net.
- Priority: **High**. Even a single smoke test with mocked `Database` and `WiseClient` verifying promotion logic would be valuable.

**API routes have no integration tests:**
- What's not tested: `POST /api/compare`, `POST /api/search`, `POST /api/search/range`, `POST /api/compare/discover`, `GET /api/filters`, `GET /api/tutors`, `GET /api/data-health`, `POST /api/internal/sync-wise`. Zero route-level tests.
- Files: `src/app/api/*/route.ts`
- Risk: Zod schema changes, auth regressions, payload shape drift undetected.
- Priority: **Medium**. The engine/normalization underneath is well-tested; the thin route handlers are mostly glue.

**No tests for client-side hooks:**
- What's not tested: `useCompare` hook's incremental fetch, AbortController lifecycle, snapshot-change recursive retry, tutor cache eviction.
- Files: `src/hooks/use-compare.ts` (230 lines).
- Risk: The recursion guard (`_retried: true`) could break silently. Cache eviction is untested.
- Priority: **Medium**. Would need React Testing Library or similar.

**No end-to-end tests:**
- What's not tested: Full search-to-compare user flow, Google OAuth login, copy-for-parent workflow, calendar date picker navigation.
- Risk: UI regressions not caught until manual QA.
- Priority: **Low** given small user base, but wise before major refactors.

**Data-health `selectModalityIssues` has a dedicated test; sync's `detectSessionModalityConflict` is lightly tested:**
- What's not tested: The sync-time contradiction loop in `orchestrator.ts:352-386` is not exercised against real multi-teacher fixtures. Matrix tests exist for `resolveSessionModality` (`src/lib/search/__tests__/compare.test.ts:104+`).
- Files: `src/lib/sync/orchestrator.ts:352-386`.
- Priority: **Medium**. Sync-layer emission of `conflict_model` drives the `/data-health` counter.

---

## Deployment Concerns

**Migrations are generated but not applied automatically on deploy:**
- Problem: `drizzle/0000_*.sql` and `0001_*.sql` are committed. Applying them requires manual `DATABASE_URL=... npm run db:migrate`.
- Files: `drizzle/`, `drizzle.config.ts`
- Risk: A deploy that introduces a schema change but forgets to run the migration produces runtime errors (missing column, wrong enum value). No CI check enforces that pending migrations have been applied.
- Recommendation: Add a Vercel build step or prestart hook that runs `drizzle-kit migrate`. Or add a startup check that queries schema metadata and fails fast if migrations are behind.

**No separation between candidate snapshot cleanup and active snapshot:**
- Problem: Failed or non-promoted snapshots remain in the DB with `active=false`. There's no documented retention/cleanup policy.
- Files: `src/lib/db/schema.ts:47-51` (snapshots table), `src/lib/sync/orchestrator.ts`
- Risk: Unbounded growth of snapshot rows and all child tables (identity groups, sessions, etc.). Each daily sync writes a new snapshot regardless of promotion status.
- Recommendation: Nightly cleanup job: delete snapshots older than N days that are not active. Or foreign-key cascade + retention policy. At 72 groups × daily syncs × years, storage grows linearly.

**`.env.local` is gitignored but `.env.example` is complete:**
- Files: `.env.example` (documents 9 vars)
- Risk: Secret leakage if someone renames `.env.local` to `.env` and commits. Standard `.gitignore` patterns should cover `.env` too.
- Recommendation: Verify `.gitignore` has `.env*` (not just `.env.local`). Add pre-commit hook (e.g., gitleaks) to scan for secrets.

**Vercel cron path is `GET`-only in `vercel.json`:**
- Files: `vercel.json:4` (`"path": "/api/internal/sync-wise"`)
- Risk: Vercel cron invokes via GET. Route handler supports both GET and POST; cron uses GET. Good. But manual `curl -X POST` is documented in CLAUDE.md — both must continue to work. This is already handled by `handleSync` shared between GET and POST in `src/app/api/internal/sync-wise/route.ts:35-42`.

---

## Data Integrity Risks

**Snapshot promotion is not wrapped in a transaction:**
- Files: `src/lib/sync/orchestrator.ts:448-463`
- See "Sync atomic promotion is two-step" under Fragile Areas. This is the single highest-priority data integrity concern.

**Sync partial writes are not rolled back on failure:**
- Files: `src/lib/sync/orchestrator.ts:487-513`
- Issue: On error, sync marks `sync_runs.status = 'failed'` and returns. Partial data written to `tutor_identity_groups`, `recurring_availability_windows`, etc. for the failed `snapshotId` remains. The previous active snapshot is preserved (since promotion never happened), so **correctness is maintained**. But:
  - Data is wasted (partial orphan snapshot).
  - No explicit cleanup.
- Recommendation: Either (a) wrap the whole sync in a transaction and let Postgres roll back on error (Neon HTTP may not support this for long-running operations), or (b) add a cleanup step that deletes rows for failed `snapshotId` values on startup or on next sync.

**`ensureIndex` races during snapshot promotion:**
- Files: `src/lib/search/index.ts:272-296`
- Issue: Between step 1 (deactivate old) and step 2 (activate new) of promotion, a request that calls `ensureIndex` could find zero active snapshots. `buildIndex` throws "No active snapshot found" on line 119.
- Recommendation: Fixed by wrapping promotion in a transaction (both updates atomic). Until then, `ensureIndex` should retry once on that specific error.

**Timezone handling in `formatDate` uses local-runtime timezone, not Bangkok:**
- Files: `src/lib/search/compare.ts:18-23`
- Issue: `formatDate` uses `d.getFullYear()`, `d.getMonth()`, `d.getDate()` — which are the **server's local timezone**. Vercel serverless runs in UTC. A session at 23:00 UTC (06:00 BKK next day) will be labeled with the UTC date, not the BKK date.
- Impact: Compare view's session date labels could be off by one day for sessions near midnight UTC.
- Recommendation: Use `toZonedTime` from `date-fns-tz` before formatting. This is particularly important because the rest of the pipeline normalizes to BKK.

**`new Date(dateStr).toISOString().slice(0, 10)` for one-time matching:**
- Files: `src/lib/search/engine.ts:176-185`, `src/lib/search/engine.ts:214-216`
- Issue: `toISOString` returns UTC. If the session is at 00:30 BKK (17:30 UTC previous day), the UTC-sliced date is the day before the BKK date.
- Impact: One-time search mode may miss or falsely-match sessions on date boundaries.
- Recommendation: Use `formatInTimeZone(d, 'Asia/Bangkok', 'yyyy-MM-dd')` from `date-fns-tz`.

**Leave conflict uses local-runtime hours in recurring mode:**
- Files: `src/lib/search/engine.ts:253-255`
- Issue: `leaveStart.getHours()` / `getMinutes()` return the server's local-timezone view of a timestamptz value. Vercel runs UTC. Bangkok is UTC+7.
- Impact: A leave stored as `17:00 UTC` (= 00:00 BKK) registers as `leaveStartMin=1020` (17h × 60) instead of `0`. Could cause false-positive or false-negative leave blocks.
- Recommendation: Convert leave timestamps to BKK explicitly using `toZonedTime` before extracting hours/minutes.

---

*Concerns audit: 2026-04-21*
