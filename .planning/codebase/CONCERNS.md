# Codebase Concerns

**Analysis Date:** 2026-05-31

> Scope note: this audit covers HEAD plus the substantial uncommitted WIP on
> branch `codex/SalesDashboard_refactor` (two in-flight features — `leave-requests`
> and payroll `rate-card`/`may-reconciliation` — plus a Google OAuth scope
> escalation). Counts reflect the working tree: **78 tables**, **96 route files
> (~110 HTTP method handlers)**, **7 Vercel crons**, **16 pages**, **132 test
> files** (129 unit `.test.ts(x)` + 3 `.integration.test.ts`). Many concerns from
> the prior (2026-04-29) audit are now FIXED in code and are listed under
> "Resolved Since Last Audit" rather than silently dropped.

## Tech Debt

**`env.ts` no longer validates most integration secrets (HIGH):**
- Issue: `src/lib/env.ts:3-16` validates only 12 vars (the original 9 + 3 optional LINE vars). But the codebase now reads ~34 distinct env vars directly via `process.env.*`, bypassing the Zod gate. Unvalidated criticals include `OPENAI_API_KEY`, `OPENAI_SCHEDULER_MODEL`/`OPENAI_SCHEDULER_SHADOW_MODEL`/`OPENAI_SCHEDULER_REASONING_EFFORT` (AI scheduler), the entire `SCHEDULE_EMAIL_*` family (Apps Script email sender, 8 vars), `LEAVE_REQUESTS_*` (Google Sheets ingestion), `SALES_DASHBOARD_CONNECTED_EMAIL`, `WISE_SESSION_OPERATIONS_VERIFIED` (writeback safety gate), and the feature flags `ENABLE_AI_SCHEDULER`/`ENABLE_LINE_SCHEDULER`.
- Files: `src/lib/env.ts:3-16`; direct readers in `src/lib/ai/scheduler.ts:478-540`, `src/lib/ai/scheduler-conversation.ts:2341`, `src/lib/classrooms/schedule-email.ts`, `src/lib/leave-requests/config.ts`, `src/lib/sales-dashboard/*`.
- Impact: `env.ts` claims to be the startup source-of-truth but a missing OpenAI key, email Apps Script secret, or sheets config now fails lazily at first request (often a 502/503 deep in a feature), not at boot. Config drift between `.env.example` and what the code actually needs is unbounded.
- Fix approach: Extend the Zod schema with the new vars (mark genuinely-optional ones `.optional()`, feature-flag-gated ones conditionally required). Route all `process.env.*` reads through `env`.

**`createWiseClient` still uses non-null assertions instead of validated `env` (LOW):**
- Issue: `createWiseClient()` reads `process.env.WISE_USER_ID!` and `process.env.WISE_API_KEY!` (`src/lib/wise/client.ts:161-162`) rather than the validated `env` object. If those are unset the `Buffer.from(undefined:undefined)` runs and credentials are silently wrong at request time.
- Files: `src/lib/wise/client.ts:159-166`
- Impact: A misconfigured deploy surfaces as a Wise 401 mid-sync rather than a boot failure. `env.ts` does validate these two, but `client.ts` does not import it.
- Fix approach: Import `env` from `src/lib/env.ts` and use `env.WISE_USER_ID` / `env.WISE_API_KEY`.

**Brittle `data_issues` → group join in `buildIndex` (MEDIUM):**
- Issue: `buildIndex` joins `data_issues` to tutor groups with an O(issues × groups) nested loop, matching on `entityId === canonicalKey OR entityId === group.id OR entityName === displayName` (`src/lib/search/index.ts:233-247`). The triple fallback exists because issue rows carry inconsistent entity identifiers depending on which normalizer emitted them (identity uses `canonicalKey`, modality/conflict_model uses `wiseSessionId`, completeness uses `teacher._id`).
- Files: `src/lib/search/index.ts:231-247`
- Impact: The `entityName === displayName` arm will misattribute issues if two groups ever share a display name. With ~70+ groups and a few hundred issues the quadratic cost is negligible today but grows with both axes.
- Fix approach: Normalize all issue rows to write `entityId = group.canonicalKey` at insertion in `orchestrator.ts`, then build one `Map<canonicalKey, IndexedDataIssue[]>` and drop the `entityName`/`group.id` arms. Note many issues are deliberately keyed by `wiseSessionId` (conflict_model) and intentionally never match a group — those are silently dropped from the per-group view today.

**Payroll transaction fallback relies on driver error-string matching (MEDIUM):**
- Issue: The default DB singleton uses the `neon-http` driver, which has no transaction support. `payroll/sync.ts` wants real transactions for invoice writes, so it tries `db.transaction(...)` and, on failure, detects the unsupported case by regex-matching the thrown message `/No transactions support in neon-http driver/i` (`src/lib/payroll/sync.ts:90`), then falls back to a dedicated `pg.Pool` (node-postgres, `max: 1`) at `src/lib/payroll/sync.ts:93-110`.
- Files: `src/lib/payroll/sync.ts:88-110`
- Impact: If Neon/Drizzle ever change that error string, the fallback stops triggering and payroll sync either throws or silently loses transactional guarantees. Also opens a second connection pool to the same DB on a serverless function.
- Fix approach: Detect driver capability explicitly (feature flag or driver-type check) rather than parsing an error message; or standardize on the WebSocket `neon-serverless` driver for write-heavy paths.

**Modality location/type matching is still substring-based (MEDIUM, known issue):**
- Issue: Modality derivation no longer pattern-matches venue names (the old `http`/`zoom`/`meet.google` heuristic is gone), but it still leans on literal lowercased `sessionType`/`location` strings: `ONLINE_SESSION_TYPES = {online, virtual, scheduled}`, `ONSITE_SESSION_TYPES = {onsite, in-person, offline}` (`src/lib/search/compare.ts:6-7`), and `deriveModality` checks `location` for literal `"online"/"virtual"/"onsite"` (`src/lib/normalization/modality.ts:42-63`). Single offline records with no session evidence now fail-closed to `unresolved` (`modality.ts:65-79`) rather than defaulting onsite.
- Files: `src/lib/normalization/modality.ts:42-92`, `src/lib/search/compare.ts:6-7,97-172`
- Impact: Tenant venue names ("Tesla", "Nerd", "Think Outside the Box") still don't match, so onsite-vs-online for single-record groups is frequently `unknown`/`low` confidence. This is now correct (fail-closed) but produces many "Needs Review" / unknown-modality cards. The `"scheduled"` synonym was bolted on per MOD-UAT-01 (2026-04-21) to absorb tenant vocabulary — a sign the type vocabulary is unstable.
- Fix approach: Source a reliable `isOnline` boolean from Wise rather than inferring from free-text `sessionType`/`location`.

**Orphan handler: `sync-room-utilization` has no cron and no UI trigger (MEDIUM):**
- Issue: `POST /api/internal/sync-room-utilization` (`src/app/api/internal/sync-room-utilization/route.ts`) is fully implemented with `maxDuration = 800`, constant-time CRON_SECRET auth, and session fallback — but it is NOT registered in `vercel.json` crons, and nothing in `src/` calls `syncRoomUtilizationSessions`. The only invoker is the manual npm script `room-utilization:sync` → `scripts/sync-room-utilization.ts`.
- Files: `src/app/api/internal/sync-room-utilization/route.ts`, `vercel.json` (absent), `scripts/sync-room-utilization.ts`
- Impact: Room-utilization data only refreshes when an operator runs the script by hand. The HTTP endpoint exists but is dead weight unless someone curls it. Room-capacity dashboards silently drift between manual syncs.
- Fix approach: Either add a cron entry, or delete the route and document the script as the sole entry point.

**Uncommitted feature WIP not yet under version control (MEDIUM):**
- Issue: Two features live entirely in the working tree, untracked: (a) `leave-requests` — `src/lib/leave-requests/**`, `src/app/api/leave-requests/**`, `src/app/api/internal/sync-leave-requests/`, `src/app/(app)/leave-requests/`, `src/components/leave-requests/`, migration `drizzle/0036_tutor_leave_requests.sql`; and (b) payroll rate-cards — `src/lib/payroll/rate-card.ts`, `src/lib/payroll/may-reconciliation.ts`, migration `drizzle/0037_payroll_rate_cards.sql`. Both depend on uncommitted edits to `src/lib/db/schema.ts` (+197 lines) and `drizzle/meta/_journal.json` (idx 33, 34), plus modified-but-tracked payroll files (`data.ts`, `types.ts`, `review/route.ts`, `payroll-dashboard.tsx`, `app-nav.tsx`).
- Files: see above; `vercel.json` already references the leave-requests cron (`/api/internal/sync-leave-requests` at `15,45`).
- Impact: The branch is in a half-shipped state — `vercel.json` and the schema reference tables/routes that exist only locally. A clean checkout would not build. The "78 tables" count includes WIP tables defined only in the uncommitted `schema.ts`. Risk of losing work or a partial commit that wires the cron without the handler (or vice versa).
- Fix approach: Land each feature as a coherent commit (migration + schema + lib + route + cron + tests together), or stash. Do not commit `vercel.json`'s leave-requests cron without the handler.

**TODO marker for unimplemented `medium` modality confidence tier (LOW):**
- Issue: The confidence rubric reserves a `"medium"` tier that is never emitted (`src/lib/search/compare.ts:69-72` docstring; `src/components/compare/modality-display.ts` handles only high/low/unknown).
- Files: `src/lib/search/compare.ts:64-95`, `src/components/compare/modality-display.ts`
- Impact: If a future change ever returns `confidence: "medium"`, the UI falls through to `unknown` styling, masking intent. Harmless today (no emitter).
- Fix approach: Implement the tier or delete the reservation and note it is intentionally absent.

## Known Bugs

**Mixed `toLocaleString` + `new Date` timezone derivation persists in client code (MEDIUM):**
- Symptoms: Several client components compute "now in Bangkok" by round-tripping through `Date.toLocaleString("en-US", { timeZone: "Asia/Bangkok" })` and re-parsing with `new Date(...)`, instead of the canonical `toZonedTime` helper. The server-side compare path was migrated to `getStartOfTodayBkk()` (which uses `toZonedTime`, `src/lib/search/compare.ts:36-39`), but the client week-math was not fully converged.
- Files: client components under `src/components/compare/*` and `src/hooks/use-compare.ts` still use the `toLocaleString` idiom for week boundaries (grep `toLocaleString` in `src/components`/`src/hooks`).
- Trigger: The pattern yields a `Date` whose UTC fields look like BKK local time but is not a valid instant; subsequent `.getDay()/.getHours()` math works only because the internal fields happen to match. Off-by-one weekday is possible near the UTC/BKK date boundary.
- Workaround: `src/lib/normalization/timezone.ts` and `src/lib/search/compare.ts:getStartOfTodayBkk` are correct; the gap is purely client-side week-start computation.
- Fix approach: Replace remaining `new Date(new Date().toLocaleString(...))` sites with a single shared `toZonedTime`-based "now in BKK" helper.

**`recurrenceId`-only dedup in past-day fallback can drop a co-located recurring series (LOW):**
- Symptoms: When `buildCompareTutor` fills a missing today/future weekday with the nearest-future occurrence, it dedups candidates by `recurrenceId` only (`src/lib/search/compare.ts:274-289`). Two distinct recurring series at the same weekday+time (different students) collapse to whichever sorts first by start time.
- Files: `src/lib/search/compare.ts:262-291`
- Trigger: A tutor with two same-slot recurring series; only one shows in the fallback render.
- Workaround: The blast radius is now much smaller than before — the fallback runs ONLY for weekdays whose calendar date is today-or-future (past weekdays render honest-empty per D-05, `compare.ts:255-268`). Real (non-fallback) date-range rendering is unaffected.
- Fix approach: Dedup by `(recurrenceId, studentName)`.

## Security Considerations

**Middleware public-route allowlist has grown well beyond `/api/internal/*` (MEDIUM):**
- Risk: `isPublicRoute` (`src/middleware.ts:4-15`) now lets SIX path families through `edgeAuth` without a session: `/login`, `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/api/line/contacts/oa-resolver/worklist`, the regex `^/api/line/contacts/oa-resolver/runs/[^/]+/rows$`, and all `/api/internal/*`. Each must self-authenticate; the contract is implicit and easy to violate.
- Files: `src/middleware.ts:4-15`; self-auth verified in `src/app/api/line/webhook/route.ts` (HMAC `x-line-signature`, fail-closed 401 at `src/lib/line/webhook.ts:24-33`), `src/app/api/line/contacts/oa-resolver/worklist/route.ts` (bearer resolver token, 401 if invalid), `src/app/api/search/assistant/route.ts:136-139` (calls `auth()`, 401 if no session — so it is whitelisted yet still session-gated, an inconsistency).
- Current mitigation: The three data-bearing public routes do self-protect (LINE HMAC, resolver token, or a redundant `auth()`).
- Recommendations: `/api/classrooms/floor-plan-map` has NO auth (it renders an SVG from a `rooms` query param, no DB/secret — low risk but genuinely open, and sets long `Cache-Control: public`). Document, per route, the self-auth mechanism. A future engineer adding a public route under any of these prefixes inherits zero gate by default.

**In-flight Google OAuth scope escalation to read-write Sheets (MEDIUM, uncommitted WIP):**
- Risk: Uncommitted changes widen the requested Google scope from `spreadsheets.readonly` to full read-write `spreadsheets` (`src/lib/auth.ts` diff) and add write-token plumbing (`getGoogleSheetsWriteAccessToken`, `hasSheetsWriteScope` in `src/lib/sales-dashboard/google-oauth.ts`).
- Files: `src/lib/auth.ts` (scope param), `src/lib/sales-dashboard/google-oauth.ts:1-260` (read/write scope split, write token path)
- Current mitigation: Not yet deployed. Read-only tokens fail closed (`getGoogleSheetsWriteAccessToken` throws `MissingGoogleSheetsTokenError` for tokens lacking the write scope).
- Recommendations: This escalates every admin's Google grant from read-only to write-capable on their Sheets. Confirm the write capability is actually needed before merge, scope it to the narrowest spreadsheet set possible, and plan the forced re-consent (existing read-only tokens stop working for write paths).

**LINE OA-resolver `worklist` allows wildcard CORS (LOW):**
- Risk: `worklist/route.ts` sets `Access-Control-Allow-Origin: *` (`src/app/api/line/contacts/oa-resolver/worklist/route.ts:5-9`) so a browser extension on any origin can call it.
- Files: `src/app/api/line/contacts/oa-resolver/worklist/route.ts`
- Current mitigation: Access is gated by an opaque per-run bearer resolver token (401 without it); the wildcard only governs which page can present the token.
- Recommendations: Acceptable for an extension integration. If feasible, restrict the origin to the extension's ID.

**Wise API key duplicated across `Authorization: Basic` and `x-api-key` headers (LOW):**
- Risk: `WiseClient.headers` sends the key in both the Basic auth blob and `x-api-key` (`src/lib/wise/client.ts:52-61`). Slightly larger leak surface in any request log.
- Files: `src/lib/wise/client.ts:52-61`
- Current mitigation: HTTPS-only (`https://api.wiseapp.live`); this header shape is a Wise tenant requirement per AGENTS.md.
- Recommendations: No action unless Wise documents a single-header alternative.

**Admin allowlist queried per sign-in via uncached DB read (LOW):**
- Risk: The Auth.js `signIn` callback hits Postgres on every login attempt to check `admin_users`. (Note: `src/lib/auth.ts` is read-only for this audit; the callback is exercised by `src/lib/auth/__tests__/signin-callback.test.ts`.)
- Files: `src/lib/auth.ts` (signIn callback), `src/lib/auth/signin-callback.ts`
- Current mitigation: ~9 admins, low login volume.
- Recommendations: Fine at this scale; cache with a revalidation tag if user count grows.

## Performance Bottlenecks

**Per-teacher leave stitching dominates Wise sync wall time (HIGH):**
- Problem: `runFullSync` fetches working hours + leaves per teacher across a 180-day horizon stitched into 26 seven-day windows. With ~130 teachers that is thousands of Wise calls per sync, throttled by the client's `maxConcurrency: 15`.
- Files: `src/lib/sync/orchestrator.ts:155-260`, `src/lib/wise/fetchers.ts` (window stitching), `src/lib/wise/client.ts:136-156` (concurrency limiter)
- Cause: No batch availability endpoint on Wise; the per-window fan-out is irreducible client-side.
- Mitigation in place: `maxDuration = 800` (Vercel Pro) now gives ample headroom vs the prior 300s ceiling, and the single-flight guard (`run-wise-sync.ts`) prevents overlapping syncs from compounding load.
- Improvement path: Reduce horizon (180→90 days halves windows), negotiate a multi-window endpoint with Wise, or split working-hours (fast) from leaves (deferred).

**`buildIndex` reloads the whole snapshot on every cold start (MEDIUM):**
- Problem: The in-memory index lives on `globalThis` (`src/lib/search/index.ts:94-113`) — it survives HMR and warm invocations but not cold serverless starts. Each cold instance re-runs ~8 parallel snapshot-wide `SELECT`s plus the tutor business-profile map (`src/lib/search/index.ts:142-222`).
- Files: `src/lib/search/index.ts:142-344`
- Cause: Singleton scope is per-instance.
- Mitigation in place: Build is coalesced (see Fragile Areas) and the dataset is small (tens of groups), so a cold build is sub-second.
- Improvement path: Persist a serialized index to a JSONB column and deserialize on cold start if scale ever reaches thousands of tutors.

**Second connection pool opened for payroll writes (LOW):**
- Problem: `getPayrollWritePool()` lazily opens a `pg.Pool` (`max: 1`) in addition to the shared `neon-http` client, to obtain transactions (`src/lib/payroll/sync.ts:93-110`).
- Files: `src/lib/payroll/sync.ts:93-110`
- Cause: `neon-http` lacks transactions; payroll needs them.
- Improvement path: Acceptable at `max: 1`; monitor for connection exhaustion if payroll sync ever runs concurrently with other pooled writers.

**O(n²) overlap/conflict detection in compare rendering (LOW):**
- Problem: Same-student conflict detection is O(students × overlaps²) (`src/lib/search/compare.ts:322-359`); calendar overlap-column packing in the week overview is similarly nested. Fine for ≤3 tutors and tens of sessions/day.
- Files: `src/lib/search/compare.ts:322-359`, `src/components/compare/week-overview.tsx`
- Improvement path: Sweepline interval graph if per-day session counts ever exceed ~100. Not needed now.

## Fragile Areas

**Snapshot promotion is now atomic, but the read path still tolerates zero active rows by design (MEDIUM):**
- Files: `src/lib/sync/orchestrator.ts:480-501`, `src/lib/search/index.ts:354-401`
- Why fragile: Promotion is a SINGLE `UPDATE snapshots SET active = (id = $new) WHERE active = true OR id = $new` (`orchestrator.ts:488-498`) — MVCC guarantees readers never see zero active rows mid-promote (REL-01, replacing the old two-UPDATE sequence). Separately, `ensureIndex` now returns the cached index when `!activeSnapshot` (`index.ts:384-386`) so a transient empty result no longer 500s. The fragility is that two independent mechanisms must both hold: if a future refactor splits the promotion back into two statements OR removes the cached-fallback, the "No active snapshot found" outage (`buildIndex` `index.ts:150-152`) returns.
- Safe modification: Keep promotion a single statement; keep the cached fallback. Add an integration test asserting `ensureIndex` survives a promotion in flight.
- Test coverage: `src/lib/sync/__tests__/orchestrator.integration.test.ts` exercises promotion against testcontainers Postgres; `src/lib/search/__tests__/index.test.ts` now exists (the prior "zero tests" gap is closed) but does not cover the concurrent-promotion race specifically.

**Build-promise coalescing depends on a synchronous assign-before-await (MEDIUM):**
- Files: `src/lib/search/index.ts:354-401`
- Why fragile: `ensureIndex` (REL-02) assigns the in-flight build promise to the `globalThis` singleton synchronously, before any `await`, so concurrent first-time callers reuse it (`index.ts:391-400`). Correct as written, but it relies on the precise ordering — moving the `setBuildingPromise(p)` after any `await` reintroduces the double-rebuild leak the comment warns about.
- Safe modification: Preserve the "kick off work and assign promise in the same tick" structure. Do not insert awaits between `buildAndCheck()` and `setBuildingPromise(p)`.
- Test coverage: `src/lib/search/__tests__/index.test.ts`; verify it includes a concurrent-call coalescing assertion.

**`globalThis`-anchored singletons survive HMR but not cold starts (MEDIUM):**
- Files: `src/lib/search/index.ts:94-113`, `src/lib/db/index.ts:16-27`
- Why fragile: The search index and DB client both hang off `globalThis.__bgscheduler_*`. Works per-instance; each cold start rebuilds. No guard against a bundler splitting the module and creating two namespaces.
- Safe modification: Document the per-instance contract.
- Test coverage: None for the singleton identity property.

**Multi-day leave coverage is a documented full-day assumption, not minute-accurate (LOW):**
- Files: `src/lib/search/engine.ts:240-289`
- Why fragile: `hasRecurringLeaveConflict` blocks EVERY weekday a >24h leave touches, in full-day form, deliberately ignoring the leave's HH:MM bounds for middle days (REL-04, documented at `engine.ts:240-250`). Single-day leaves use minute-of-day math against `leaveStart`. This is now intentional (the prior "wrong start minutes on multi-day" bug is fixed by short-circuiting multi-day to full-day), but it means a partial-day leave on the first/last day of a multi-day span over-blocks.
- Safe modification: If minute-accuracy on span edges is ever needed, compute bounds from the per-day cursor; otherwise keep and document.
- Test coverage: `src/lib/normalization/__tests__/leaves.test.ts` and `src/lib/search/__tests__/engine.test.ts` cover normalization and single-day blocking.

**Wise-activity / leave-requests / sales sync single-flight via unique-index race (LOW):**
- Files: `src/lib/wise-activity/sync.ts:46-53`, `src/lib/leave-requests/sync.ts:44-47`, `src/lib/sync/run-wise-sync.ts:42-118`
- Why fragile: Several sync paths enforce "only one running" by inserting a `running` row and catching the Postgres `23505` unique violation (or matching a named partial index like `wise_activity_sync_runs_single_running_idx` / `leave_request_sync_runs_single_running_idx`). The Wise snapshot sync additionally fails abandoned `running` rows older than 20 min (`run-wise-sync.ts:STALE_RUNNING_SYNC_MS`). Correct, but each feature reimplements the pattern slightly differently (error-code check vs. index-name string match), so a renamed index silently disables a guard.
- Safe modification: Centralize the single-flight helper; assert on the SQLSTATE `23505` rather than the index name.
- Test coverage: per-feature sync tests exist (`src/lib/wise-activity/__tests__/sync.test.ts`, `src/lib/leave-requests/__tests__/*`, `src/app/api/internal/sync-wise/__tests__/route.test.ts`).

## Scaling Limits

**Snapshot storage now bounded by 30-snapshot retention (RESOLVED → LOW):**
- Current capacity: Every promoted sync appends a full snapshot across all snapshot-scoped tables. `pruneOldSnapshots` (`src/lib/sync/snapshot-pruning.ts`) runs after each successful promote and keeps the most recent `SNAPSHOT_RETENTION_COUNT = 30` (`snapshot-pruning.ts:5,51,65`), cascade-deleting older snapshots. `past_session_blocks` is intentionally cross-snapshot and exempt.
- Limit: At 30 snapshots × per-snapshot row volume, storage is now flat rather than monotonically growing — the prior "unbounded growth vs Neon free tier" concern is mitigated. Pruning failures are caught, logged, and recorded in `sync_runs.metadata` without failing the sync (`orchestrator.ts:520-548`).
- Scaling path: Tune the retention count if 30 snapshots exceed the storage budget; pruning is idempotent.

**Wise sync wall time vs the 800s function ceiling (MEDIUM):**
- Current capacity: ~130 teachers × 26 leave windows under `maxDuration = 800` on Vercel Pro.
- Limit: The 800s ceiling; the prior 300s Hobby ceiling (with ~34s headroom) is gone.
- Scaling path: Horizon reduction or a Wise batch endpoint as teacher count grows (see Performance Bottlenecks).

**In-memory index size (LOW):**
- Current capacity: Tens of groups × windows × sessions — single-digit MB serialized.
- Limit: Function memory budget. Ample headroom.
- Scaling path: Concern only at 10,000+ tutors.

**Client-side compare cache grows unbounded across week navigation (LOW):**
- Current capacity: `useCompare` caches `CompareTutor` keyed by `tutorGroupId:weekStart:CACHE_VERSION` (`src/hooks/use-compare.ts`). Entries accumulate as the user pages weeks; cache invalidates on snapshot change but has no size cap.
- Limit: Browser memory after hundreds of week navigations.
- Scaling path: Add LRU eviction (~50 entries).

## Dependencies at Risk

**`next-auth: 5.0.0-beta.30` (HIGH):**
- Risk: Pinned to an exact Auth.js v5 beta (`package.json` — note it is now exact, no caret). Betas carry breaking changes between releases; no LTS.
- Impact: Auth split into `src/lib/auth.ts` (node) + `src/lib/auth-edge.ts` (edge middleware) plus the custom `admin_users` callback and Google Sheets OAuth — a beta bump could touch any of these.
- Migration plan: Stay pinned; upgrade to v5 GA in a dedicated phase, re-testing the edge/node split and the sheets scope.

**No `openai` SDK despite heavy OpenAI usage — raw `fetch` to `/v1/responses` (MEDIUM):**
- Risk: The AI scheduler calls `https://api.openai.com/v1/responses` directly via `fetch` (`src/lib/ai/scheduler.ts:544`, `src/lib/ai/scheduler-conversation.ts:2346`); there is no `openai` package in `package.json`. The request/response shape of the Responses API is hand-rolled.
- Impact: API contract drift (model names, response envelope, reasoning-effort params) is caught only at runtime as a 4xx/5xx. `OPENAI_SCHEDULER_MODEL`/`OPENAI_SCHEDULER_REASONING_EFFORT` are free-text env with no validation.
- Migration plan: Either adopt the official SDK (typed, versioned) or add a Zod contract test against a recorded fixture. Gate on `isAiSchedulerConfigured()` (already present).

**`@base-ui/react: 1.3.0` (MEDIUM):**
- Risk: Exact-pinned 1.x of a young primitives library underpinning `src/components/ui/*`.
- Impact: Major bumps may require prop migrations.
- Migration plan: Stay pinned; monitor changelog.

**`shadcn: ^4.1.2` correctly in devDependencies (RESOLVED → LOW):**
- Risk: Previously flagged as a runtime dependency. It is now under `devDependencies` (`package.json`) — the copy-paste component CLI is dev-only as intended.
- Migration plan: No action; verify nothing in `src/` imports the `shadcn` package at runtime.

**`drizzle-orm: 0.45.2` / `zod: ^4.3.6` (LOW):**
- Risk: `drizzle-orm` is exact-pinned pre-1.0; `zod` is v4 (caret). Ecosystem peer support for zod v4 is still maturing.
- Impact: Query/schema API or type-inference changes on bump.
- Migration plan: Test migrations on the testcontainers integration suite before upgrading.

**`@auth/drizzle-adapter` no longer present (RESOLVED):**
- The prior "dead dependency" concern is gone — there is no `@auth/drizzle-adapter` in `package.json`. Auth uses the custom `admin_users` callback. No action.

## Missing Critical Features

**Sync failure / staleness self-recovery is implemented but uneven across features (MEDIUM):**
- Problem: The Wise snapshot path surfaces staleness well — `src/lib/ops/stale.ts` defines an API warning at 90 min (`API_STALE_THRESHOLD_MS`) and an app-wide banner at 2h (`APP_STALE_BANNER_THRESHOLD_MS`), rendered by `src/components/layout/stale-snapshot-banner.tsx`. But the newer sync surfaces (sales-dashboard, credit-control, wise-activity, leave-requests, room-utilization) each have their own `*_sync_runs` tables and failure reporting; there is no unified "any sync is failing" health signal.
- Files: `src/lib/ops/stale.ts`, `src/app/api/data-health/route.ts`, the per-feature `*-sync-runs` schemas.
- Approach: A consolidated health endpoint/banner spanning all seven crons would catch a silently-failing sales or credit-control sync the way the snapshot banner catches stale tutor data.

**No automated trigger for room-utilization sync (MEDIUM):**
- Problem: As noted under Tech Debt, room-utilization only refreshes via the manual `room-utilization:sync` script — there is no cron and the HTTP handler is unreferenced.
- Files: `src/app/api/internal/sync-room-utilization/route.ts`, `scripts/sync-room-utilization.ts`.
- Approach: Add a staggered cron or remove the orphan route.

**Manual "sync now" remains curl/CRON_SECRET only for some pipelines (LOW):**
- Problem: The Wise snapshot sync has an admin UI trigger path (`POST /api/internal/sync-wise` also accepts a session via `handleSync({allowSessionAuth:true})`, and `/api/admin/sync-wise` exists). Other pipelines expose manual sync routes (`/api/*/sync`) but UI affordance coverage is inconsistent.
- Files: `src/app/api/internal/sync-wise/route.ts:41-47`, `src/app/api/admin/sync-wise/route.ts`, `src/app/api/{credit-control,sales-dashboard,wise-activity,leave-requests,payroll}/sync/route.ts`.
- Approach: Audit that every operationally-important sync has a button, not just an endpoint.

## Test Coverage Gaps

> Counts: 132 test files total (129 `.test.ts(x)` + 3 `.integration.test.ts`).
> `npm test` runs the `unit` project (excludes the 3 integration files);
> `npm run test:integration` runs the testcontainers Postgres suite. The prior
> audit's blanket "search index / route handlers / sync orchestrator untested"
> gaps are now substantially covered — what remains is listed below.

**Client UI components and hooks (MEDIUM):**
- What's not tested: The `useCompare` hook (`src/hooks/use-compare.ts`) — AbortController cancellation, incremental `fetchOnly` cache merge, snapshot-change invalidation, retry guard. Most `src/components/**/*.tsx` are excluded from coverage entirely (`vitest.config.ts` excludes `src/app/**/*.tsx` from coverage; only a handful of component `.test.tsx` files exist: density-overview, visualization-components, room-capacity-dashboard).
- Files: `src/hooks/use-compare.ts`, `src/components/compare/*`, `src/components/search/*`.
- Risk: Race-condition and cache-invalidation logic is unverified.
- Priority: MEDIUM (needs jsdom/RTL setup).

**Uncommitted WIP features are partially tested but not in the gating suite (MEDIUM):**
- What's not tested end-to-end: `leave-requests` has unit tests (`src/lib/leave-requests/__tests__/parser.test.ts`, `matching.test.ts`) and one route test (`wise-cancel-preview`), but the sync→match→recompute→email flow (`src/lib/leave-requests/sync.ts`) has no integration coverage. Payroll `rate-card`/`may-reconciliation` have new unit tests (`src/lib/payroll/__tests__/rate-card.test.ts`, `may-reconciliation.test.ts`) but, like the source, are uncommitted.
- Files: `src/lib/leave-requests/sync.ts`, `src/lib/payroll/{rate-card,may-reconciliation}.ts`.
- Risk: WIP could be committed without the full-flow test, and the migrations (`0036`, `0037`) are unproven against the integration DB.
- Priority: MEDIUM.

**Modality contradiction emission during sync (LOW):**
- What's not tested directly: The orchestrator's per-session `detectSessionModalityConflict` → `conflict_model` persistence loop (`src/lib/sync/orchestrator.ts:364-398`). `src/lib/sync/__tests__/orchestrator-modality-conflict.test.ts` covers the conflict detection; verify it asserts the rows actually land in `data_issues`.
- Files: `src/lib/sync/orchestrator.ts:364-398`.
- Priority: LOW.

**Cross-feature env/config wiring (LOW):**
- What's not tested: That a missing `OPENAI_API_KEY`, `SCHEDULE_EMAIL_*`, or `LEAVE_REQUESTS_*` var degrades gracefully (503/disabled) rather than 500-ing deep in a handler.
- Files: `src/lib/env.ts`, feature config modules.
- Priority: LOW.

## Resolved Since Last Audit (2026-04-29)

The following prior concerns are FIXED in current code and retained here so the
delta is auditable:

- **Non-atomic snapshot promotion (was HIGH)** — now a single atomic `UPDATE ... SET active = (id = $new)` (REL-01, `src/lib/sync/orchestrator.ts:488-498`).
- **Concurrent index-rebuild promise leak (was MEDIUM)** — coalesced via synchronous promise assignment (REL-02, `src/lib/search/index.ts:354-401`).
- **Zero-active-snapshot read race throwing 500 (was HIGH)** — `ensureIndex` falls back to the cached index when no active snapshot is found (`src/lib/search/index.ts:384-386`).
- **CRON_SECRET non-constant-time compare (was MEDIUM)** — now `crypto.timingSafeEqual` with length pre-check (REL-07, `src/app/api/internal/sync-wise/route.ts:10-28`; same pattern in `sync-room-utilization`).
- **Wise client retried 4xx (was MEDIUM)** — retries restricted to a transient-status allowlist {408,429,5xx}; permanent 4xx fail fast (REL-05, `src/lib/wise/client.ts:23-30,121-134`).
- **Identity silently merges same-nickname teachers (was HIGH)** — emits `identity_collision` high-severity issue for 3+ member or non-clean-pair groupings; group still routed to Needs Review (REL-03, `src/lib/normalization/identity.ts:148-170`).
- **Empty catch swallowed sync-cleanup errors (was LOW)** — cleanup failures are now `console.error`-logged (REL-06, `src/lib/sync/orchestrator.ts:573-585`).
- **`detectConflicts` unused `indexedGroups` param (was LOW)** — parameter removed; signature is `detectConflicts(compareTutors)` (`src/lib/search/compare.ts:322`).
- **Multi-day leave wrong start-minute math (was MEDIUM)** — multi-day leaves now short-circuit to full-day blocking (REL-04, `src/lib/search/engine.ts:260-275`).
- **Stale threshold mismatched to cron cadence (was LOW)** — centralized to 90 min / 2h matching the 30-min Pro cron (`src/lib/ops/stale.ts:1-9`).
- **Past-day fallback showed misleading future occurrences (was MEDIUM)** — past weekdays now render honest-empty; fallback runs only for today/future weekdays (D-05, `src/lib/search/compare.ts:255-268`); real dropped past sessions captured into `past_session_blocks` via the committed diff-hook (`src/lib/sync/past-sessions-diff-hook.ts`).
- **No snapshot retention policy (was missing feature)** — `pruneOldSnapshots` keeps 30 snapshots after each promote (`src/lib/sync/snapshot-pruning.ts`).
- **`shadcn` as a runtime dep / `@auth/drizzle-adapter` dead dep (was LOW/MEDIUM)** — `shadcn` moved to devDependencies; `@auth/drizzle-adapter` removed.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
