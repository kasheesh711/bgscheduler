# Codebase Concerns

**Analysis Date:** 2026-05-31

> Scope note: this audit covers HEAD `d4fe6d3`, which now includes the
> **Ops Hub dashboard + navigation registry** feature (`src/lib/home/`,
> `src/lib/navigation/`, `src/app/(app)/page.tsx`, `src/app/api/home/`,
> `src/components/home/`, with the old `src/app/page.tsx` redirect deleted).
> Counts reflect the spine: **90 tables**, **130 HTTP endpoints**,
> **10 Vercel crons**, **17 pages**, **162 test files**. The previously-WIP
> `leave-requests`, `progress-tests`, `student-promotions`, and Ops Hub features
> are now committed and tracked — they are no longer "uncommitted" concerns.
> Several items from the prior audit are FIXED in code and are listed under
> "Resolved Since Last Audit" rather than silently dropped.

## Tech Debt

**`env.ts` validates only 12 of the ~36 env vars the code actually reads (HIGH):**
- Issue: `src/lib/env.ts:3-16` validates 12 vars (the original 9 + 3 optional LINE vars). But ~36 distinct vars are read directly via `process.env.*` across `src/`, bypassing the Zod gate. Unvalidated criticals include `OPENAI_API_KEY`, `OPENAI_SCHEDULER_MODEL`/`OPENAI_SCHEDULER_SHADOW_MODEL`/`OPENAI_SCHEDULER_REASONING_EFFORT`/`OPENAI_PROGRESS_TEST_MODEL` (AI scheduler + progress-test summaries), the entire `SCHEDULE_EMAIL_*` family (Apps Script email sender — primary + backup URL/secret, public base URL, reply-to, sender name: 8 vars), `LEAVE_REQUESTS_*` (Google Sheets ingestion), `SALES_DASHBOARD_CONNECTED_EMAIL`, the two writeback safety gates `WISE_SESSION_CREATE_VERIFIED` and `WISE_SESSION_OPERATIONS_VERIFIED`, the `NEXT_PUBLIC_APP_URL`/`VERCEL_URL`/`VERCEL_PROJECT_PRODUCTION_URL` URL trio, `LINE_VALIDATION_LEAD_EMAILS`, and the feature flags `ENABLE_AI_SCHEDULER`/`ENABLE_LINE_SCHEDULER`.
- Files: `src/lib/env.ts:3-16`; representative direct readers in `src/lib/ai/scheduler.ts`, `src/lib/ai/scheduler-conversation.ts`, `src/lib/classrooms/schedule-email.ts`, `src/lib/leave-requests/config.ts`, `src/lib/progress-tests/config.ts:50` (`WISE_SESSION_CREATE_VERIFIED`), `src/lib/sales-dashboard/*`.
- Impact: `env.ts` claims to be the startup source-of-truth (it throws on invalid at module load) but a missing OpenAI key, an email Apps Script secret, or a misconfigured writeback gate now fails lazily at first request (often a 500 deep inside a feature), not at boot. Config drift between `.env.example` and what the code actually needs is unbounded. The two `WISE_SESSION_*_VERIFIED` gates are especially load-bearing — they decide whether dry-run code paths actually write to Wise — yet are plain `=== "true"` string checks with no validation.
- Fix approach: Extend the Zod schema with the new vars (mark genuinely-optional ones `.optional()`, feature-flag-gated ones conditionally required). Route `process.env.*` reads through `env`.

**Migration journal has out-of-order, duplicate-prefixed catch-up migrations (MEDIUM):**
- Issue: `drizzle/` contains 40 `.sql` files but two prefix numbers collide: `0038_data_health_cron_invocations.sql` + `0038_cynical_karma.sql`, and `0039_line_link_validation_source_indexes.sql` + `0039_overrated_krista_starr.sql`. `drizzle/meta/_journal.json` applies them in journal order, NOT filename order: idx 35-37 are the hand-named `0038`/`0039`/`0040_student_promotions`, then idx 38-39 are the auto-named `0038_cynical_karma`/`0039_overrated_krista_starr` appended *after* the higher number. This is the "Drizzle snapshot drift" failure mode (see user memory): `db:generate` emitted bloated catch-up migrations whose default names re-used `0038`/`0039`.
- Files: `drizzle/0038_*.sql`, `drizzle/0039_*.sql`, `drizzle/0040_student_promotions.sql`, `drizzle/meta/_journal.json` (entries idx 35-39).
- Impact: A fresh `db:migrate` works (journal order is authoritative and all 40 files are present), but the filename ordering is misleading — an engineer reading `drizzle/` cannot infer apply order, and a hand-edit that re-sorts by filename would corrupt the journal. The auto-named `cynical_karma`/`overrated_krista_starr` migrations are exactly the kind of catch-up the memory note says to trim before applying.
- Fix approach: When `db:generate` emits an auto-named catch-up migration, inspect its diff, fold real changes into a correctly-numbered named migration, and keep filename order monotonic with the journal.

**`createWiseClient` uses non-null assertions instead of validated `env` (LOW):**
- Issue: `createWiseClient()` reads `process.env.WISE_USER_ID!` and `process.env.WISE_API_KEY!` (`src/lib/wise/client.ts:161-162`) rather than the validated `env` object. If those are unset, `Buffer.from("undefined:undefined")` runs and credentials are silently wrong at request time.
- Files: `src/lib/wise/client.ts:159-166`
- Impact: A misconfigured deploy surfaces as a Wise 401 mid-sync rather than a boot failure. `env.ts` does validate these two, but `client.ts` does not import it.
- Fix approach: Import `env` from `src/lib/env.ts` and use `env.WISE_USER_ID` / `env.WISE_API_KEY`.

**Brittle `data_issues` → group join in `buildIndex` (MEDIUM):**
- Issue: `buildIndex` joins `data_issues` to tutor groups with a nested loop matching on `entityId === canonicalKey OR entityId === group.id OR entityName === displayName`. The triple fallback exists because issue rows carry inconsistent entity identifiers depending on which normalizer emitted them (identity uses `canonicalKey`, modality/conflict_model uses `wiseSessionId`, completeness uses `teacher._id`).
- Files: `src/lib/search/index.ts` (issue-attribution loop in `buildIndex`).
- Impact: The `entityName === displayName` arm will misattribute issues if two groups ever share a display name. With ~70+ groups and a few hundred issues the quadratic cost is negligible today but grows with both axes. Issues deliberately keyed by `wiseSessionId` (conflict_model) intentionally never match a group and are silently dropped from the per-group view.
- Fix approach: Normalize all issue rows to write `entityId = group.canonicalKey` at insertion in `orchestrator.ts`, then build one `Map<canonicalKey, IndexedDataIssue[]>` and drop the `entityName`/`group.id` arms.

**Payroll transaction fallback relies on driver error-string matching (MEDIUM):**
- Issue: The default DB singleton uses the `neon-http` driver, which has no transaction support. `payroll/sync.ts` wants real transactions for invoice writes, so `runPayrollWriteTransaction` tries `db.transaction(...)` and, on failure, detects the unsupported case by regex-matching the thrown message `/No transactions support in neon-http driver/i` (`isNeonHttpTransactionUnsupported`, `src/lib/payroll/sync.ts:89-90`), then falls back to a dedicated `pg.Pool` (node-postgres, `max: 1`) created lazily by `getPayrollWritePool()` (`src/lib/payroll/sync.ts:92-110`).
- Files: `src/lib/payroll/sync.ts:88-115`
- Impact: If Neon/Drizzle ever change that error string, the fallback stops triggering and payroll sync either throws or silently loses transactional guarantees. Also opens a second connection pool to the same DB on a serverless function.
- Fix approach: Detect driver capability explicitly (feature flag or driver-type check) rather than parsing an error message; or standardize on the WebSocket `neon-serverless` driver for write-heavy paths.

**Modality location/type matching is substring-based; the "step 3" comment is stale (MEDIUM, known issue):**
- Issue: Modality derivation no longer pattern-matches venue names, but it still leans on literal lowercased `sessionType`/`location` strings: `deriveModality` checks `types`/`locations` sets for `"online"/"virtual"/"onsite"/"in-person"/"offline"` (`src/lib/normalization/modality.ts:42-63`), and `compare.ts` keeps `ONLINE_SESSION_TYPES = {online, virtual, scheduled}` / `ONSITE_SESSION_TYPES = {onsite, in-person, offline}` (`src/lib/search/compare.ts:6-7`). Single offline records with no session evidence fail-closed to `unresolved` (`modality.ts:65-79`). NOTE: the step-3 comment at `modality.ts:64-65` still reads "assume onsite … common default" but the code below it actually returns `unresolved` — a stale comment that contradicts the (correct) fail-closed behavior.
- Files: `src/lib/normalization/modality.ts:42-92`, `src/lib/search/compare.ts:6-7`
- Impact: Tenant venue names ("Tesla", "Nerd", "Think Outside the Box") don't match, so onsite-vs-online for single-record groups is frequently `unresolved`/unknown — correct (fail-closed) but produces many "Needs Review" / unknown-modality cards. The `"scheduled"` synonym was bolted on per MOD-UAT-01 (2026-04-21) to absorb tenant vocabulary — a sign the type vocabulary is unstable.
- Fix approach: Source a reliable `isOnline` boolean from Wise rather than inferring from free-text `sessionType`/`location`; and correct the stale "assume onsite" comment to "fail-closed → unresolved".

**`sync-room-utilization` is a documented manual-only job, not a cron (MEDIUM):**
- Issue: `POST /api/internal/sync-room-utilization` is fully implemented (`maxDuration = 800`, constant-time CRON_SECRET auth) but has NO Vercel cron entry. The cron registry now formally classifies it as `manualOnly: true` with `schedule: null` (`src/lib/internal/cron-registry.ts`, `key: "room_utilization"`), and `syncRoomUtilizationSessions` is reachable three other ways: the internal route, the data-health manual job runner (`runDataHealthJob` `jobKey: "room_utilization"`, `src/lib/data-health/run-job.ts`), and the npm script `room-utilization:sync` → `scripts/sync-room-utilization.ts`.
- Files: `src/app/api/internal/sync-room-utilization/route.ts`, `src/lib/internal/cron-registry.ts`, `src/lib/data-health/run-job.ts`, `vercel.json` (deliberately absent).
- Impact: Room-utilization data only refreshes when an operator triggers it (data-health "run now" button or the script). This is now an explicit product decision (the registry says "Manual only") rather than an accidental orphan — but room-capacity dashboards still silently drift between manual runs, and the late/stale signal is suppressed (`lateAfterMinutes: 0`).
- Fix approach: If automatic refresh is wanted, add a staggered cron and flip `manualOnly: false`; otherwise the current wiring is coherent and just needs the staleness expectation documented for operators.

**Ops Hub is a load-bearing default entry point (MEDIUM):**
- Issue: The Ops Hub dashboard is committed as of `d4fe6d3` (`src/lib/home/summary.ts`, `src/lib/navigation/tools.ts` — the `NAV_TOOLS`/`NAV_SECTIONS` registry — `src/app/(app)/page.tsx` rendering `/`, `src/app/api/home/summary/route.ts`, `src/components/home/`; the old `src/app/page.tsx` `/` → `/search` redirect was deleted). `src/components/layout/app-nav.tsx` and `src/middleware.ts` (whitelists `/api/home/summary` for restricted users, `middleware.ts:33`) support it.
- Files: see above.
- Impact: `/` is now the default landing page for every login, so the hub's correctness gates that path. It fans out to 8 feature payload loaders in one `Promise.all` (`getHomeSummaryPayload`, `src/lib/home/summary.ts`); a slow or failing loader degrades the landing experience.
- Fix approach: Keep the 8-loader fan-out resilient (per-loader error isolation so one failure does not blank the whole hub) and add committed coverage for the fan-out + per-badge `canAccess` filtering.

**TODO marker for unimplemented `medium` modality confidence tier (LOW):**
- Issue: The confidence rubric reserves a `"medium"` tier that is never emitted; `src/components/compare/modality-display.ts` handles only high/low/unknown.
- Files: `src/lib/search/compare.ts` (confidence docstring), `src/components/compare/modality-display.ts`
- Impact: If a future change ever returns `confidence: "medium"`, the UI falls through to `unknown` styling, masking intent. Harmless today (no emitter).
- Fix approach: Implement the tier or delete the reservation and note it is intentionally absent.

## Known Bugs

**`recurrenceId`-only dedup in past-day fallback can drop a co-located recurring series (LOW):**
- Symptoms: When `buildCompareTutor` fills a missing today/future weekday with the nearest-future occurrence, it dedups candidates by `recurrenceId` only. Two distinct recurring series at the same weekday+time (different students) collapse to whichever sorts first by start time.
- Files: `src/lib/search/compare.ts` (weekday-fallback dedup block).
- Trigger: A tutor with two same-slot recurring series; only one shows in the fallback render.
- Workaround: The blast radius is small — the fallback runs ONLY for weekdays whose calendar date is today-or-future (past weekdays render honest-empty per D-05, gated by `getStartOfTodayBkk()`, `compare.ts:30-39`). Real (non-fallback) date-range rendering is unaffected.
- Fix approach: Dedup by `(recurrenceId, studentName)`.

**Mixed `toLocaleString` + `new Date` timezone derivation in client week-math (LOW):**
- Symptoms: Some client components compute "now in Bangkok" by round-tripping through `Date.toLocaleString("en-US", { timeZone: "Asia/Bangkok" })` and re-parsing with `new Date(...)`, instead of the canonical `toZonedTime` helper. The server compare path uses `getStartOfTodayBkk()` (`toZonedTime`, `src/lib/search/compare.ts:36-39`), but client week-start computation was not fully converged.
- Files: client components under `src/components/compare/*` and `src/hooks/use-compare.ts` (grep `toLocaleString`).
- Trigger: The pattern yields a `Date` whose UTC fields look like BKK local time but is not a valid instant; off-by-one weekday is possible near the UTC/BKK date boundary.
- Workaround: `src/lib/normalization/timezone.ts` and `getStartOfTodayBkk` are correct; the gap is purely client-side.
- Fix approach: Replace remaining `new Date(new Date().toLocaleString(...))` sites with a single shared `toZonedTime`-based "now in BKK" helper.

## Security Considerations

**Middleware public-route allowlist spans six path families (MEDIUM):**
- Risk: `isPublicRoute` (`src/middleware.ts:4-15`) lets six path families through `edgeAuth` without a session: `/login`, `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/api/line/contacts/oa-resolver/worklist`, the regex `^/api/line/contacts/oa-resolver/runs/[^/]+/rows$`, and all `/api/internal/*`. Each must self-authenticate; the contract is implicit and easy to violate.
- Files: `src/middleware.ts:4-15`; self-auth verified in `src/app/api/line/webhook/route.ts` (HMAC `x-line-signature`, fail-closed 401 in `src/lib/line/webhook.ts`), the oa-resolver worklist route (bearer resolver token, 401 if invalid), and `src/app/api/search/assistant/route.ts` (calls `auth()` itself — whitelisted yet still session-gated, an inconsistency).
- Current mitigation: The data-bearing public routes self-protect (LINE HMAC, resolver token, or a redundant `auth()`). All `/api/internal/*` crons do constant-time `CRON_SECRET` checks.
- Recommendations: `/api/classrooms/floor-plan-map` has NO auth (renders an SVG from a `rooms` query param, no DB/secret — low risk but genuinely open, sets long `Cache-Control: public`). Document, per route, the self-auth mechanism. A future engineer adding a route under any of these prefixes inherits zero gate by default.

**Two Wise-writeback safety gates are plain env-string checks (MEDIUM):**
- Risk: The app's most dangerous capabilities — writing sessions and student grade/course promotions back to Wise — are gated only by `process.env.WISE_SESSION_CREATE_VERIFIED === "true"` (progress-test booking, `src/lib/progress-tests/config.ts:50`) and `WISE_SESSION_OPERATIONS_VERIFIED` (session operations). When off, code finalizes `manual_required` / dry-run with no network call; when on, it calls `scheduleWiseSession` and mutates Wise (`src/lib/progress-tests/booking.ts:171-176`). The July-1 student-promotions cron applies "verified Wise student grade and course promotion writes" (`cron-registry.ts`, `dangerous: true`).
- Files: `src/lib/progress-tests/config.ts:47-51`, `src/lib/progress-tests/booking.ts`, `src/app/api/internal/student-promotions/july-1/route.ts`, `src/lib/student-promotions/data.ts`.
- Current mitigation: Defaults are fail-closed (gate absent → dry-run); the promotions cron is additionally date-locked to July 1, 2026 Bangkok (`STUDENT_PROMOTION_TARGET_DATE`, returns 409 on any other day) and CRON_SECRET-gated with constant-time compare. Every booking attempt is persisted before any network call for audit.
- Recommendations: These gates are unvalidated by `env.ts`, so a typo (`"True"`, `"1"`) silently keeps writes off — acceptable fail-closed, but a misconfigured *enable* is undetectable until someone notices nothing wrote. Validate both flags in `env.ts` and log their resolved state at boot.

**In-flight home-hub widens middleware exposure for restricted users (LOW):**
- Risk: To let restricted (non-full-access) users see the home hub, `isPathAllowed` now hardcodes `/api/home/summary` as always-allowed (`src/middleware.ts:33`) and `/` as allowed when the user has more than one page (`middleware.ts:34`). The summary endpoint itself re-checks `auth()` and filters every payload by `canAccessHref(tool.href, allowedPages)` (`src/lib/home/summary.ts`), so a restricted user only gets counts for tools they can already open.
- Files: `src/middleware.ts:31-43`, `src/app/api/home/summary/route.ts`, `src/lib/home/summary.ts`.
- Current mitigation: Per-badge `canAccess` filtering means the endpoint cannot leak a tool's data to a user lacking that page; the Google-token status is the only always-loaded source.
- Recommendations: Keep the `canAccessHref` gate authoritative; add a test asserting a single-page restricted user gets `null` for every other tool's badge.

**In-flight Google OAuth scope escalation to read-write Sheets (MEDIUM, if still pending):**
- Risk: The sales-dashboard write path needs full read-write `spreadsheets` scope rather than `spreadsheets.readonly`, with write-token plumbing (`getGoogleSheetsWriteAccessToken`, `hasSheetsWriteScope` in `src/lib/sales-dashboard/google-oauth.ts`). A repo guard script `scripts/check-sales-dashboard-scope.mjs` (npm `guard:sales-dashboard-scope`) exists to police this.
- Files: `src/lib/sales-dashboard/google-oauth.ts`, `scripts/check-sales-dashboard-scope.mjs`.
- Current mitigation: Read-only tokens fail closed (`getGoogleSheetsWriteAccessToken` throws `MissingGoogleSheetsTokenError` for tokens lacking the write scope). `src/lib/auth.ts` is out of edit scope for this audit; verify the live requested scope there.
- Recommendations: Confirm the write capability is actually needed before any scope bump merges, scope it to the narrowest spreadsheet set, and plan the forced re-consent (existing read-only tokens stop working for write paths).

**LINE OA-resolver `worklist` allows wildcard CORS (LOW):**
- Risk: The worklist route sets `Access-Control-Allow-Origin: *` so a browser extension on any origin can call it.
- Files: `src/app/api/line/contacts/oa-resolver/worklist/route.ts`
- Current mitigation: Access is gated by an opaque per-run bearer resolver token (401 without it); the wildcard only governs which page can present the token.
- Recommendations: Acceptable for an extension integration. If feasible, restrict the origin to the extension's ID.

**Wise API key duplicated across `Authorization: Basic` and `x-api-key` headers (LOW):**
- Risk: `WiseClient.headers` sends the key in both the Basic auth blob and `x-api-key` (`src/lib/wise/client.ts:52-61`). Slightly larger leak surface in any request log.
- Files: `src/lib/wise/client.ts:52-61`
- Current mitigation: HTTPS-only (`https://api.wiseapp.live`); this header shape is a Wise tenant requirement per AGENTS.md.
- Recommendations: No action unless Wise documents a single-header alternative.

**Admin allowlist + per-page access queried per sign-in via uncached DB read (LOW):**
- Risk: The Auth.js `signIn` callback hits Postgres on every login to check `admin_users` and resolve `allowedPages`. (`src/lib/auth.ts` is read-only for this audit; the callback is exercised by `src/lib/auth/__tests__/signin-callback.test.ts`.)
- Files: `src/lib/auth.ts` (signIn callback), `src/lib/auth/signin-callback.ts`, `src/lib/auth-access.ts`.
- Current mitigation: ~9 admins, low login volume.
- Recommendations: Fine at this scale; cache with a revalidation tag if user count grows.

## Performance Bottlenecks

**Per-teacher leave stitching dominates Wise sync wall time (HIGH):**
- Problem: `runFullSync` fetches working hours + leaves per teacher across a 180-day horizon stitched into 26 seven-day windows. With ~130 teachers that is thousands of Wise calls per sync, throttled by the client's concurrency limiter.
- Files: `src/lib/sync/orchestrator.ts` (per-teacher fan-out), `src/lib/wise/fetchers.ts` (window stitching), `src/lib/wise/client.ts:136-156` (concurrency limiter).
- Cause: No batch availability endpoint on Wise; the per-window fan-out is irreducible client-side.
- Mitigation in place: `maxDuration = 800` (Vercel Pro) gives ample headroom, and the single-flight guard (`run-wise-sync.ts`) prevents overlapping syncs from compounding load.
- Improvement path: Reduce horizon (180→90 days halves windows), negotiate a multi-window endpoint with Wise, or split working-hours (fast) from leaves (deferred).

**Home hub fans out to eight feature payload loaders on every `/` render (MEDIUM):**
- Problem: `getHomeSummaryPayload` runs a single `Promise.all` over eight loaders — leave-requests, LINE pending reviews, progress-test cycle counts, credit-control payload, payroll payload, Wise reconciliation summary, data-health dashboard, and Google token status (`src/lib/home/summary.ts`). This is the new default landing page, so it runs on most logins.
- Files: `src/lib/home/summary.ts`.
- Cause: The hub aggregates a badge/count for every tool the user can access; each loader is a separate query path.
- Mitigation in place: All loaders are DB-bound, not live-Wise — e.g. `getCreditControlPayload` reads `loadCreditControlSources` from Postgres (`src/lib/credit-control/db.ts:84`), not a Wise call; `getPayrollPayload` reads the persisted month. Each loader is wrapped in `loadSource` so one failure degrades to a per-badge error, not a 500. Loaders are skipped for tools the user can't access (`canAccess` gate).
- Improvement path: The heavier payloads (full credit-control + payroll) are computed in full just to extract a count or two — add lightweight count-only queries, or `"use cache"` the home summary with a short `cacheLife` and the `snapshot` tag.

**`buildIndex` reloads the whole snapshot on every cold start (MEDIUM):**
- Problem: The in-memory index lives on `globalThis` (`src/lib/search/index.ts:92-113`) — it survives HMR and warm invocations but not cold serverless starts. Each cold instance re-runs the snapshot-wide `SELECT`s plus the tutor business-profile map.
- Files: `src/lib/search/index.ts:140-344`.
- Cause: Singleton scope is per-instance.
- Mitigation in place: Build is coalesced (see Fragile Areas) and the dataset is small (tens of groups), so a cold build is sub-second.
- Improvement path: Persist a serialized index to a JSONB column and deserialize on cold start if scale ever reaches thousands of tutors.

**Second connection pool opened for payroll writes (LOW):**
- Problem: `getPayrollWritePool()` lazily opens a `pg.Pool` (`max: 1`) in addition to the shared `neon-http` client, to obtain transactions (`src/lib/payroll/sync.ts:92-110`).
- Files: `src/lib/payroll/sync.ts:92-110`.
- Cause: `neon-http` lacks transactions; payroll needs them.
- Improvement path: Acceptable at `max: 1`; monitor for connection exhaustion if payroll sync runs concurrently with other pooled writers.

**O(n²) overlap/conflict detection in compare rendering (LOW):**
- Problem: Same-student conflict detection is O(students × overlaps²); calendar overlap-column packing in the week overview is similarly nested. Fine for ≤3 tutors and tens of sessions/day.
- Files: `src/lib/search/compare.ts` (`detectConflicts`), `src/components/compare/week-overview.tsx`.
- Improvement path: Sweepline interval graph if per-day session counts ever exceed ~100. Not needed now.

## Fragile Areas

**Snapshot promotion is atomic, but the read path tolerates zero active rows by design (MEDIUM):**
- Files: `src/lib/sync/orchestrator.ts:472-520`, `src/lib/search/index.ts:354-401`.
- Why fragile: Promotion is a SINGLE bounded `UPDATE` that flips the candidate to `active` without a moment of zero matches (REL-01, comment at `orchestrator.ts:484-486`). Separately, `ensureIndex` returns the cached index when `!activeSnapshot` (`index.ts:384-386`) so a transient empty result no longer 500s. Two independent mechanisms must both hold: if a future refactor splits promotion into two statements OR removes the cached-fallback, the "No active snapshot found" outage (`buildIndex`, `index.ts:150-151`) returns.
- Safe modification: Keep promotion a single statement; keep the cached fallback. Add an integration test asserting `ensureIndex` survives a promotion in flight.
- Test coverage: `src/lib/sync/__tests__/orchestrator.integration.test.ts` exercises promotion against testcontainers Postgres; `src/lib/search/__tests__/index.test.ts` covers the index but not the concurrent-promotion race specifically.

**Build-promise coalescing depends on a synchronous assign-before-await (MEDIUM):**
- Files: `src/lib/search/index.ts:354-401`.
- Why fragile: `ensureIndex` (REL-02) assigns the in-flight build promise to the `globalThis` singleton synchronously, before any `await`, so concurrent first-time callers reuse it (`setBuildingPromise(p)` at `index.ts:399`). Correct as written, but it relies on the precise ordering — moving the assignment after any `await` reintroduces the double-rebuild leak the comment (`index.ts:349-353`) warns about.
- Safe modification: Preserve the "kick off work and assign promise in the same tick" structure. Do not insert awaits before `setBuildingPromise(p)`.
- Test coverage: `src/lib/search/__tests__/index.test.ts`; verify it includes a concurrent-call coalescing assertion.

**`globalThis`-anchored singletons survive HMR but not cold starts (MEDIUM):**
- Files: `src/lib/search/index.ts:92-113`, `src/lib/db/index.ts`.
- Why fragile: The search index and DB client both hang off `globalThis.__bgscheduler_*`. Works per-instance; each cold start rebuilds. No guard against a bundler splitting the module and creating two namespaces.
- Safe modification: Document the per-instance contract.
- Test coverage: None for the singleton-identity property.

**Cron registry must stay in lockstep with `vercel.json` (MEDIUM):**
- Files: `src/lib/internal/cron-registry.ts`, `vercel.json`, `src/lib/data-health/dashboard.ts` (consumes the registry for the health page).
- Why fragile: `CRON_JOBS` is the single source of truth for cadence, late-after thresholds, danger flags, and expected Bangkok minutes — but `vercel.json` independently declares the actual schedules. The two are hand-maintained: the registry's `schedule` strings duplicate `vercel.json`'s `schedule` strings (e.g. `wise_snapshot` `*/30 * * * *` appears in both). A schedule changed in one place but not the other makes the data-health "late" detection lie. `room_utilization` is the deliberate exception (registry `schedule: null`, absent from `vercel.json`).
- Safe modification: Change cadence in both files together; treat `cron-registry.ts` as the documentation and `vercel.json` as the deployment fact.
- Test coverage: a cron-registration test exists (`src/app/api/internal/.../route.test.ts` style); verify it cross-checks registry vs. `vercel.json`.

**Multi-day leave coverage is a documented full-day assumption, not minute-accurate (LOW):**
- Files: `src/lib/search/engine.ts`.
- Why fragile: `hasRecurringLeaveConflict` blocks EVERY weekday a >24h leave touches, in full-day form, deliberately ignoring the leave's HH:MM bounds for middle days (REL-04). Single-day leaves use minute-of-day math. Intentional (the prior multi-day start-minute bug is fixed by short-circuiting to full-day), but a partial-day leave on the first/last day of a multi-day span over-blocks.
- Safe modification: If minute-accuracy on span edges is ever needed, compute bounds from the per-day cursor; otherwise keep and document.
- Test coverage: `src/lib/normalization/__tests__/leaves.test.ts` and `src/lib/search/__tests__/engine.test.ts`.

**Per-feature single-flight guards reimplement the same pattern differently (LOW):**
- Files: `src/lib/wise-activity/sync.ts`, `src/lib/leave-requests/sync.ts`, `src/lib/progress-tests/*`, `src/lib/sync/run-wise-sync.ts`.
- Why fragile: Several sync paths enforce "only one running" by inserting a `running` row and catching the Postgres `23505` unique violation (or matching a named partial index like `wise_activity_sync_runs_single_running_idx`). The Wise snapshot sync additionally fails abandoned `running` rows older than a timeout (`run-wise-sync.ts`). Correct, but each feature reimplements the pattern slightly differently (SQLSTATE check vs. index-name string match), so a renamed index silently disables a guard.
- Safe modification: Centralize the single-flight helper; assert on the SQLSTATE `23505` rather than the index name.
- Test coverage: per-feature sync tests exist (`src/lib/wise-activity/__tests__/sync.test.ts`, `src/lib/leave-requests/__tests__/*`, `src/lib/progress-tests/__tests__/*`).

## Scaling Limits

**Snapshot storage bounded by 30-snapshot retention (LOW):**
- Current capacity: Every promoted sync appends a full snapshot across all snapshot-scoped tables. `pruneOldSnapshots` runs after each successful promote and keeps the most recent `SNAPSHOT_RETENTION_COUNT = 30` (`src/lib/sync/snapshot-pruning.ts:5,51`), cascade-deleting older snapshots. `past_session_blocks` is intentionally cross-snapshot and exempt (`schema.ts:1487`).
- Limit: At 30 snapshots × per-snapshot row volume, storage is flat rather than monotonically growing. Pruning failures are caught, logged, and recorded without failing the sync.
- Scaling path: Tune the retention count if 30 snapshots exceed the storage budget; pruning is idempotent.

**Wise sync wall time vs the 800s function ceiling (MEDIUM):**
- Current capacity: ~130 teachers × 26 leave windows under `maxDuration = 800` on Vercel Pro.
- Limit: The 800s ceiling.
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
- Risk: Pinned to an exact Auth.js v5 beta (`package.json`). Betas carry breaking changes between releases; no LTS.
- Impact: Auth split into `src/lib/auth.ts` (node) + `src/lib/auth-edge.ts` (edge middleware) plus the custom `admin_users` + `allowedPages` callback and Google Sheets OAuth — a beta bump could touch any of these.
- Migration plan: Stay pinned; upgrade to v5 GA in a dedicated phase, re-testing the edge/node split and the sheets scope.

**No `openai` SDK despite heavy OpenAI usage — raw `fetch` to `/v1/responses` (MEDIUM):**
- Risk: The AI scheduler and progress-test summaries call OpenAI's Responses API directly via `fetch`; there is no `openai` package in `package.json` (confirmed: 0 references). The request/response shape is hand-rolled.
- Impact: API contract drift (model names, response envelope, reasoning-effort params) is caught only at runtime as a 4xx/5xx. `OPENAI_SCHEDULER_MODEL`/`OPENAI_SCHEDULER_REASONING_EFFORT`/`OPENAI_PROGRESS_TEST_MODEL` are free-text env with no validation.
- Migration plan: Either adopt the official SDK (typed, versioned) or add a Zod contract test against a recorded fixture. Gate on the existing `isAiSchedulerConfigured()`-style checks.

**`@base-ui/react: 1.3.0` (MEDIUM):**
- Risk: Exact-pinned 1.x of a young primitives library underpinning `src/components/ui/*`.
- Impact: Major bumps may require prop migrations.
- Migration plan: Stay pinned; monitor changelog.

**`drizzle-orm: 0.45.2` / `zod: ^4.3.6` (LOW):**
- Risk: `drizzle-orm` is exact-pinned pre-1.0; `zod` is v4 (caret). Ecosystem peer support for zod v4 is still maturing.
- Impact: Query/schema API or type-inference changes on bump.
- Migration plan: Test migrations on the testcontainers integration suite before upgrading.

**`shadcn` correctly in devDependencies (LOW):**
- Risk: `shadcn: ^4.1.2` is under `devDependencies` (the copy-paste component CLI is dev-only, as intended).
- Migration plan: No action; verify nothing in `src/` imports the `shadcn` package at runtime.

## Missing Critical Features

**Sync-failure / staleness self-recovery is improving but still uneven (LOW → was MEDIUM):**
- Problem: There is now a consolidated cron-health surface — `src/lib/data-health/dashboard.ts` computes per-cron status (healthy/late/failing/running/manual-only/unknown) from `CRON_JOBS` + `data_health_cron_invocations`, and the home hub surfaces a combined "late + failing" count (`getHomeSummaryPayload` → `dataHealth.overall`). The Wise-snapshot staleness banner (`src/lib/ops/stale.ts`, 90-min API warning / 2h app banner) still only watches the snapshot path.
- Files: `src/lib/data-health/dashboard.ts`, `src/lib/internal/cron-registry.ts`, `src/lib/ops/stale.ts`, `src/components/layout/stale-snapshot-banner.tsx`.
- Approach: The data-health dashboard largely closes the prior "no unified health signal" gap; the remaining unevenness is that the *banner* (high-visibility, always-rendered) still only reflects snapshot staleness, not a failing sales/credit-control sync.

**Manual "sync now" coverage is broad but not universal (LOW):**
- Problem: The data-health "run now" path (`POST /api/data-health/jobs/[jobKey]/run` → `runDataHealthJob`) can trigger nine job keys manually (wise_snapshot, wise_activity, sales_dashboard, credit_control, leave_requests, classroom_morning, classroom_admin_email, room_utilization, and the registry also lists progress_tests/progress_tests_digest/student_promotions_july_1). Coverage is good but the dangerous jobs (`classroom_morning`, `student_promotions_july_1`) carry `dangerous: true` + `confirmationLabel` and must keep their guards when surfaced as buttons.
- Files: `src/lib/data-health/run-job.ts`, `src/lib/internal/cron-registry.ts`, `src/app/api/data-health/jobs/[jobKey]/run/route.ts`.
- Approach: Ensure every `dangerous: true` job requires explicit confirmation in the UI before its manual trigger fires.

## Test Coverage Gaps

> Counts: 162 test files (`.test.ts(x)` + `.integration.test.ts`).
> `npm test` runs the `unit` project (excludes the integration files);
> `npm run test:integration` runs the testcontainers Postgres suite. The prior
> audit's blanket "search index / route handlers / sync orchestrator untested"
> gaps are now substantially covered — what remains is below.

**Client UI components and hooks (MEDIUM):**
- What's not tested: The `useCompare` hook (`src/hooks/use-compare.ts`) — AbortController cancellation, incremental `fetchOnly` cache merge, snapshot-change invalidation, retry guard. Most `src/components/**/*.tsx` are excluded from coverage; only a handful of component `.test.tsx` files exist.
- Files: `src/hooks/use-compare.ts`, `src/components/compare/*`, `src/components/search/*`.
- Risk: Race-condition and cache-invalidation logic is unverified.
- Priority: MEDIUM (needs jsdom/RTL setup).

**Ops Hub fan-out resilience (LOW):**
- What's covered: The Ops Hub feature is committed with tracked tests — `src/lib/home/__tests__/summary.test.ts`, `src/lib/navigation/__tests__/tools.test.ts`, `src/components/home/__tests__/home-hub.test.tsx`, and `src/components/layout/__tests__/app-nav.test.tsx` are all in the gating suite.
- What to watch: confirm the 8-loader `Promise.all` fan-out (`getHomeSummaryPayload`, `src/lib/home/summary.ts`) isolates a single failing/slow loader so one error does not blank the whole landing page, and that per-badge `canAccess` filtering stays covered as `NAV_TOOLS` grows.
- Files: `src/lib/home/summary.ts`, `src/lib/navigation/tools.ts`, `src/components/home/`.
- Priority: LOW.

**Modality-conflict emission during sync (LOW):**
- What's not tested directly: The orchestrator's per-session `detectSessionModalityConflict` → `conflict_model` persistence loop. `src/lib/sync/__tests__/orchestrator-modality-conflict.test.ts` covers conflict detection; verify it asserts the rows actually land in `data_issues`.
- Files: `src/lib/sync/orchestrator.ts` (modality-conflict loop).
- Priority: LOW.

**Cross-feature env/config wiring (LOW):**
- What's not tested: That a missing `OPENAI_API_KEY`, `SCHEDULE_EMAIL_*`, `LEAVE_REQUESTS_*`, or a mis-set `WISE_SESSION_*_VERIFIED` degrades gracefully (503/dry-run/disabled) rather than 500-ing deep in a handler.
- Files: `src/lib/env.ts`, feature config modules (`src/lib/progress-tests/config.ts`, `src/lib/leave-requests/config.ts`, `src/lib/classrooms/schedule-email.ts`).
- Priority: LOW.

## Resolved Since Last Audit

The following prior concerns are FIXED in current code and retained here so the
delta is auditable:

- **`leave-requests` / `progress-tests` / `student-promotions` / Ops Hub were uncommitted WIP** — all are now committed and tracked (`git ls-files` resolves `src/lib/leave-requests/sync.ts`, `src/lib/progress-tests/*`, `src/lib/student-promotions/*`, and the Ops Hub `src/lib/home/*` + `src/lib/navigation/*` as of `d4fe6d3`); their crons, tables, and routes are live. No untracked feature WIP remains.
- **`sync-room-utilization` was an accidental orphan** — it is now a documented `manualOnly: true` job in `src/lib/internal/cron-registry.ts`, wired into the data-health "run now" runner (`runDataHealthJob`), and reachable via three explicit paths. The decision (no cron) is now intentional, not accidental.
- **Non-atomic snapshot promotion** — single bounded `UPDATE` flips the candidate to active without a zero-active window (REL-01, `src/lib/sync/orchestrator.ts:472-520`).
- **Concurrent index-rebuild promise leak** — coalesced via synchronous promise assignment (REL-02, `src/lib/search/index.ts:354-401`).
- **Zero-active-snapshot read race throwing 500** — `ensureIndex` falls back to the cached index when no active snapshot is found (`src/lib/search/index.ts:384-386`).
- **CRON_SECRET non-constant-time compare** — `crypto.timingSafeEqual` with length pre-check across internal routes (REL-07; e.g. `src/app/api/internal/student-promotions/july-1/route.ts:9-17`).
- **Wise client retried 4xx** — retries restricted to a transient-status allowlist; permanent 4xx fail fast (REL-05, `src/lib/wise/client.ts`).
- **Past-day fallback showed misleading future occurrences** — past weekdays render honest-empty; fallback runs only for today/future weekdays (D-05, gated by `getStartOfTodayBkk`); dropped past sessions captured into the cross-snapshot `past_session_blocks` via `src/lib/sync/past-sessions-diff-hook.ts`.
- **No snapshot retention policy** — `pruneOldSnapshots` keeps 30 snapshots after each promote (`src/lib/sync/snapshot-pruning.ts`).
- **No unified cron-health signal** — `src/lib/data-health/dashboard.ts` + `cron-registry.ts` now compute per-cron status across all scheduled jobs, surfaced on the data-health page and the home hub.

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
