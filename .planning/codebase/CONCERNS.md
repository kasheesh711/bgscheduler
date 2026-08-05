# Codebase Concerns

**Analysis Date:** 2026-05-31

> Scope note: this audit covers the current working tree. Counts, all derived by
> command at this revision: **188 tables** (`grep -c "= pgTable(" src/lib/db/schema.ts`),
> **241 HTTP method handlers** across **178 `route.ts` files**, **15 Vercel crons**
> (`vercel.json`) against a **21-entry cron registry** (6 declared manual-only),
> **25 pages** in the `(app)` route group (29 `page.tsx` files total, including
> `/login`, the public `/schedule/[token]`, and two `(print)` report pages),
> **369 test files** (357 unit + 12 integration), **35 `src/lib` domain modules**,
> and **96,492 lines** of non-test `src/lib` source. The source tree is clean —
> the only uncommitted changes are documentation (four new `docs/features/*.md`
> files are untracked), `.gitignore`, `README.md`, and a workflow script. Prior
> concerns that are now FIXED are listed under "Resolved Since Last Audit"
> rather than being silently dropped, and two prior claims are **corrected**
> where re-reading the code showed the previous audit was wrong.

## Tech Debt

**`src/lib/env.ts` is never imported — the startup validation gate does not exist (HIGH):**
- Issue: `env.ts` builds a 15-key Zod schema and exports `env = getEnv()`, which validates at module-evaluation time (`src/lib/env.ts:28-37`). A repo-wide grep for `@/lib/env` and `lib/env` across `src/` and `scripts/` returns **zero importers outside the file itself**. Nothing ever evaluates the module, so `getEnv()` never runs and nothing is ever validated.
- Files: `src/lib/env.ts:3-37`.
- Impact: the documented guarantee ("env validated at startup, throws on invalid") is fiction. Every consumer reads `process.env.*` directly and fails at its own call site — `getDb()` throwing `DATABASE_URL is not set` (`src/lib/db/index.ts:6-9`), `createWiseClient()` producing `Buffer.from("undefined:undefined")` and surfacing as a Wise 401 mid-sync (`src/lib/wise/client.ts:161-162`). A misconfigured deploy boots green and fails hours later inside a cron.
- Fix approach: import `env` from a real startup path (root layout or `instrumentation.ts`) **and** extend the schema, or delete the module and document per-call-site reads as the actual convention. Half-measures are worse than either.

**The schema covers 15 of 57 env vars actually read (HIGH, compounding the above):**
- Issue: a `grep -rhoE "process\.env\.[A-Z0-9_]+" src` finds **57 distinct names**; `envSchema` declares 15 (`src/lib/env.ts:4-23`). Unvalidated and load-bearing: `OPENAI_API_KEY` plus five model selectors (`OPENAI_SCHEDULER_MODEL`, `OPENAI_SCHEDULER_SHADOW_MODEL`, `OPENAI_PROGRESS_TEST_MODEL`, `OPENAI_POST_CLASS_FEEDBACK_MODEL`, `OPENAI_COMPETITOR_INTEL_MODEL`) and `OPENAI_SCHEDULER_REASONING_EFFORT`; the eight `SCHEDULE_EMAIL_*` Apps Script vars; `RESEND_API_KEY`; `LEAVE_REQUESTS_*`; `SALES_DASHBOARD_CONNECTED_EMAIL`; the Apify/DataForSEO credentials and budget caps; and — most importantly — the three Wise writeback safety gates `WISE_SESSION_OPERATIONS_VERIFIED`, `WISE_SESSION_CREATE_VERIFIED`, `WISE_SESSION_SUBJECT_UPDATE_VERIFIED`.
- Files: `src/lib/wise/operations.ts:10-12`, `src/lib/progress-tests/config.ts:50`, `src/lib/student-promotions/data.ts:450`, `src/lib/competitor-intelligence/budget.ts:19-20`, `src/lib/admissions/notifications.ts:299-300`.
- Impact: the three writeback gates are free-text `=== "true"` comparisons. A typo (`True`, `" true"`) silently disables a gate that exists to be explicit. It fails in the safe direction — the write is skipped — but presents as "the feature stopped working" with no error anywhere.
- Fix approach: `z.enum(["true","false"])` for the verified flags, `.optional()` for the genuinely optional ones, and route reads through `env`.

**Seven copy-pasted constant-time `CRON_SECRET` checks (MEDIUM):**
- Issue: `src/lib/internal/cron-auth.ts` exists precisely to centralize REL-07's constant-time compare, and 16 of the 21 `/api/internal/**/route.ts` files import it. Six inline their own byte-identical implementation: `sync-wise/route.ts:12-26`, `sync-room-utilization/route.ts:13-21`, `sync-competitor-intelligence/route.ts:12-17`, `sync-sales-dashboard/route.ts:16-21`, `sync-credit-control/route.ts:19-28`, `student-promotions/july-1/route.ts:11-16`.
- Impact: all six are currently **correct** (length pre-check plus `timingSafeEqual`), so this is not a live vulnerability — it is six places a future edit can get wrong independently, in the one code path that stands between the public internet and every destructive cron (`/api/internal/*` is wholly allowlisted past middleware auth).
- Fix approach: replace the six inline copies with `rejectInvalidCronSecret(request)`; add a test asserting every `src/app/api/internal/**/route.ts` imports the shared helper.

**The neon-http transaction fallback is copy-pasted into two modules and keyed on an error string (MEDIUM):**
- Issue: the default DB singleton is neon-http (`src/lib/db/index.ts`), which has no transaction support. `src/lib/payroll/sync.ts:89-124` and `src/lib/post-class-feedback/transaction.ts:11-49` solve this identically and separately. Both define `isNeonHttpTransactionUnsupported()` as a **regex over the driver's error message** (`/No transactions support in neon-http driver/i`), both lazily open their own `pg.Pool({ max: 1 })`, and both re-wrap the raw client with `drizzle-orm/node-postgres`.
- Impact: two failure modes. (1) If Neon or Drizzle reword that message, both fallbacks stop triggering — payroll throws, post-class-feedback loses transactional guarantees. (2) The post-class path is the worse of the two: `lockPostClassFinance()` issues `pg_advisory_xact_lock` (`src/lib/post-class-feedback/finance-lock.ts:14-17`), which is **transaction-scoped**. Were the fallback to stop engaging while the callback still ran, the lock would release after each statement and the serialization behind payout publication, deduction decisions, and finance-period transitions would vanish silently rather than erroring. 15 non-test `lockPostClassFinance(tx)` call sites across `repository.ts`, `payout-repository.ts`, and `actions.ts` depend on it. There is also an unstated assumption that `db.transaction()` throws *before* invoking the callback — if it ever threw partway through, the fallback would replay the callback's side effects.
- Fix approach: one shared `withWriteTransaction()`; detect driver capability explicitly (driver-type check or a "needs transactions" DB accessor) rather than parsing a message; add a test that the fallback holds one session across two statements.

**Single-flight guards reimplemented per feature in three detection styles (MEDIUM):**
- Issue: 13 `single_running_idx` partial unique indexes exist in `schema.ts`. Each owning feature enforces "only one running" by inserting a `running` row and catching the unique violation — three different ways:
  - SQLSTATE only: `src/lib/credit-control/run-sync-request.ts:46`, `src/lib/progress-tests/run-sync-request.ts:44`, `src/lib/progress-tests/admin-digest.ts:266`, `src/lib/sales-dashboard/import-guard.ts:63`, `src/lib/classrooms/admin-schedule-email.ts:310`, `src/lib/admissions/cohorts.ts:22`.
  - SQLSTATE **or** index-name regex: `src/lib/wise-activity/sync.ts:64-66`, `src/lib/admissions/notifications.ts:237-238`, `src/lib/post-class-feedback/repository.ts:363`.
  - Index-name **string match only**: `src/lib/leave-requests/sync.ts:55-58` — `text.includes("leave_request_sync_runs_single_running_idx")`.
- Impact: the leave-requests variant is the fragile one. Renaming that index, or a driver that stops surfacing the constraint name in `error.message`, silently disables the guard and allows concurrent Google Sheets reads *and status writeback*. A fourth pattern exists because the watchdog has no `*_sync_runs` table at all: it uses a sentinel `cron_alert_state` row as a sweep lock with a 6-minute staleness reclaim (`src/lib/internal/cron-watchdog.ts:41-50`).
- Fix approach: one shared `isSingleFlightConflict(error, indexName?)` that asserts SQLSTATE `23505` first and uses the index name only as a secondary discriminator.

**Drizzle migration snapshot chain has 29 missing files (MEDIUM):**
- Issue: `drizzle/meta/_journal.json` records 65 migrations (idx 0-64, latest `0064_line_group_settings`) but only **36 `NNNN_snapshot.json` files** exist. Missing: 6, 9-13, 22-37, 48-49, 57-61. `git check-ignore` confirms nothing in `.gitignore` excludes them — they were deleted or never generated.
- Impact: `drizzle-kit generate` diffs against the newest snapshot, which *is* present, so generation works today. But the chain cannot be replayed or inspected at intermediate states, and any regeneration after a snapshot loss produces a bloated catch-up migration against a stale baseline. This has already bitten this repo.
- Fix approach: treat the current snapshot as the baseline, never delete `drizzle/meta/*.json`, and add a CI check that snapshot count equals journal entry count.

**Brittle `data_issues` → group join in `buildIndex` (MEDIUM):**
- Issue: `buildIndex` joins `data_issues` to tutor groups with an O(issues × groups) nested loop matching on `entityId === canonicalKey OR entityId === group.id OR entityName === displayName` (`src/lib/search/index.ts:232-246`).
- **Correction to the prior audit:** that audit claimed modality-conflict issues keyed by `wiseSessionId` "never match any group and are silently dropped." They *do* match — the orchestrator sets `entityName: group.displayName` alongside `entityId: session.wiseSessionId` (`src/lib/sync/orchestrator.ts:384-389`). The `entityName` arm is therefore **load-bearing**, not a fallback.
- Impact: because a whole issue class relies on display-name matching, two groups sharing a display name would cross-attribute every `conflict_model` issue between them. Nothing prevents duplicate display names.
- Fix approach: normalize all issue rows to `entityId = group.canonicalKey` at insertion in `orchestrator.ts`, then build one `Map<canonicalKey, IndexedDataIssue[]>` and drop the name arm.

**Modality derivation is still literal-string matching (MEDIUM, known issue):**
- Issue: `deriveModality` inspects lowercased `sessionType`/`location` for the literals `"online"`, `"virtual"`, `"onsite"`, `"in-person"`, `"offline"` (`src/lib/normalization/modality.ts:46-52`); the compare-side resolver adds `"scheduled"` to the online set as a tenant-vocabulary patch (`src/lib/search/compare.ts:5-7`, tagged MOD-UAT-01). A single-record offline group with no session evidence fails closed to `unresolved` (`modality.ts:66-79`).
- Impact: tenant venue names ("Tesla", "Nerd", "Think Outside the Box") match nothing, so onsite-vs-online for single-record groups is frequently unknown/low-confidence. This is *correct* (fail-closed) but produces a persistent stream of "Needs Review" cards. The bolted-on `"scheduled"` synonym is evidence the vocabulary is unstable and will need another patch.
- Fix approach: source a reliable `isOnline` boolean from Wise instead of inferring from free text.

**A spent one-shot cron still occupies a registry + `vercel.json` slot (MEDIUM):**
- Issue: `student_promotions_july_1` is registered with schedule `5 17 30 6 *` (June 30 17:05 UTC = July 1 00:05 Bangkok) in both `vercel.json` and `src/lib/data-health/cron-registry.ts:296-311`. It is `dangerous: true`, labelled "Applies verified Wise student grade and course promotion writes", with `cadenceMinutes: 365 * 24 * 60`.
- Impact: the job has already fired for its intended date and will **re-fire next June** against a codebase and Wise tenant that have moved on. Because it is scheduled rather than manual-only, Data Health and the watchdog classify it against a 365-day cadence — a permanently "late/unknown" posture for a year, adding noise to the exact signal the watchdog exists to produce.
- Fix approach: flip it to `manualOnly: true` (it already has the `dangerous` confirm gate) and drop the `vercel.json` entry, or delete the route. Note `docs/reference/production-route-surface.json` lists `/api/internal/student-promotions/july-1` among its 9 **critical routes**, so removal must update that manifest in the same change or `guard:production-route-surface` fails the release.

**Two parallel outbound-email stacks (LOW):**
- Issue: admissions notifications go out through the Resend REST API (`src/lib/admissions/notifications.ts:299-300`), while classroom schedule emails, the admin classroom summary, and the cron watchdog's own alerts go out through a Google Apps Script webhook (`createAppsScriptScheduleEmailSender`, imported at `src/lib/internal/cron-watchdog.ts:22-25`) configured by the eight `SCHEDULE_EMAIL_*` vars. Neither `resend` nor any mail SDK is in `package.json`.
- Impact: two credential sets, two failure modes, two retry semantics, no shared deliverability view. The watchdog that alerts on cron failure depends on the Apps Script path — if Apps Script is what broke, the alert about it cannot be delivered.
- Fix approach: consolidate onto the existing `ScheduleEmailSender` seam, or at minimum give the watchdog a second, independent channel.

**Module sprawl in `post-class-feedback` (LOW):**
- Issue: `src/lib/post-class-feedback/` holds 37 non-test source files, **twelve** of them `payout-*.ts` (`payout-accrual`, `payout-config`, `payout-master`, `payout-plan`, `payout-repository`, `payout-run`, `payout-sheet`, `payout-tutor-mapping`, `payout-window`, `payout-window-health`, `payout-workbook-operations`, `payout-writer`). `payout-repository.ts` is 2,389 lines; `repository.ts` is 2,172.
- Impact: the largest and most financially consequential subsystem in the repo has no sub-directory structure, so ownership boundaries inside it are conventional rather than enforced.
- Fix approach: promote `payout/` to its own directory under the feature — the module has the best test ratio in the repo (35 test files), so this is a mechanical move.

## Known Bugs

**Credit-control snapshot promotion rewrites the entire snapshots table, every 30 minutes (HIGH):**
- Symptoms: `runCreditControlSync` promotes with `db.update(schema.creditControlSnapshots).set({ active: sql\`(id = $new)\` })` and **no `.where()` clause** (`src/lib/credit-control/sync.ts:700-702`). The Wise orchestrator does the same thing with a bounded `WHERE active = true OR id = $new`, and its comment states the bound exists precisely to avoid "a full-table rewrite per promote" (`src/lib/sync/orchestrator.ts:483-497`, REL-01).
- Trigger: every credit-control sync — `20,50 * * * *`, 48 times a day.
- Impact: each promote rewrites one row per snapshot ever created, and the row count only grows (see next entry). This is REL-01's exact failure mode, in a lineage that never received the fix.
- Fix approach: add `.where(or(eq(active, true), eq(id, snapshot.id)))`, matching the orchestrator.

**Credit-control snapshots are never pruned (HIGH):**
- Symptoms: the Wise lineage prunes after every successful promote, keeping `SNAPSHOT_RETENTION_COUNT = 30` (`src/lib/sync/snapshot-pruning.ts:5,49`). Nothing equivalent exists for credit control — a `grep` for `delete(schema.creditControl...)` finds only the sidecar `creditControlInactiveStudents`, `creditControlZeroBalanceTracking`, and `creditControlFollowUpState` cleanups (`sync.ts:607,629`; `db.ts:233,286`), never a snapshot.
- Trigger: every 30-minute run inserts a fresh snapshot plus a full set of `credit_control_students`, `credit_control_packages`, `credit_control_sessions`, and `credit_control_credit_history` rows (`sync.ts:661-694`) and nothing is ever removed.
- Impact: unbounded monotonic growth at 48 full snapshots/day in the lineage with the largest per-snapshot row count, which also now backs a **parent-facing** page (see below). Combined with the unbounded promote above, write cost grows with total history rather than staying flat.
- Fix approach: port `pruneOldSnapshots` to the credit-control lineage with its own retention count.

**Seven of twenty-one Data Health "Run now" buttons 404 and write a failed audit row (HIGH):**
- Symptoms: `CronJobKey` declares 21 keys (`src/lib/data-health/cron-registry.ts:3-23`); `runDataHealthJob` branches on 14 of them and falls through to `{ error: "Unknown job" }` with HTTP 404 (`src/lib/data-health/run-job.ts:195`). The dashboard renders a button for **all** 21 — `manualActions: CRON_JOBS.map(...)` (`src/lib/data-health/dashboard.ts:975`, consumed at `src/components/data-health/data-health-dashboard.tsx:167`).
- Trigger: clicking Run now for `progress_tests`, `progress_tests_digest`, `post_class_feedback_backfill`, `post_class_feedback_payout_accrual`, `student_promotions_july_1`, `admissions_notifications`, or `line_backlog_recovery`.
- Impact: worse than a dead button. The click is wrapped in `withCronInvocationAudit`, and `determineOutcome` maps `status >= 400` to `"failed"` (`src/lib/data-health/cron-audit.ts:61-68`), so every attempt writes a **failed** `cron_invocations` row for a job that never ran — corrupting the very signal the watchdog alerts on. `post_class_feedback_payout_accrual` is the manual actuator for the payout window (below), so the one job an operator most needs to run by hand is among the seven.
- Fix approach: add the missing branches, or filter `manualActions` to the keys `run-job.ts` actually handles and assert that set equality in a test.

**Credit-control healthy runs are classified as failing (HIGH):**
- Symptoms: `src/app/api/internal/sync-credit-control/route.ts:14` sets `maxDuration = 800`, with a comment recording that successful runs take 372-390s and that 300s produced recurring Vercel timeouts from 2026-06-16. The registry still declares `maxDurationSeconds: 300` (`src/lib/data-health/cron-registry.ts:118`), and stuck-run detection reads the **registry** value plus a 60s buffer (`src/lib/data-health/status.ts:238-240`, `STUCK_BUFFER_MS` at `status.ts:6`).
- Trigger: any run between 361s and 800s — i.e. every healthy run.
- Impact: `/data-health` shows Credit Control `failing`, and the watchdog treats `failing` as alertable (`ALERTABLE_STATUSES`, `cron-watchdog.ts:52,140`), so admins get recurring alert emails about a job that is working. Alert fatigue on the repo's only unified failure signal.
- Verified: a script comparing every registry `maxDurationSeconds` against the corresponding route's exported `maxDuration` finds `credit_control` is the **only** drift among all 21 jobs. `cron-registry.test.ts` compares only `path` and `schedule` (`src/lib/data-health/__tests__/cron-registry.test.ts:12-19`), so nothing catches it.
- Fix approach: set the registry to 800 and extend the parity test to assert `maxDurationSeconds` against each route's exported `maxDuration`.

**The public parent schedule page stamps render time as "last updated" over snapshot data (MEDIUM):**
- Symptoms: `getStudentMonthlySchedule` reads the **active credit-control snapshot** and returns `generatedAt: new Date()` — the moment of the request, not the snapshot's `generatedAt` (`src/lib/student-schedule/data.ts:174-179,232`). The public page renders that value verbatim in its footer as "updated {time}" (`src/app/schedule/[token]/page.tsx:86-89`).
- Trigger: every parent visit.
- Impact: a parent always sees a fresh timestamp. If the credit-control cron is failing (which, per the entry above, it is *reported* to be doing constantly, and could genuinely do), the page confidently presents hours- or days-old classes as current. This is the one surface in the app where a wrong schedule reaches a customer directly.
- Fix approach: select `creditControlSnapshots.generatedAt` alongside the id and thread it through, and consider showing an explicit staleness notice past a threshold.

**`recurrenceId`-only dedup in the past-day fallback can drop a co-located recurring series (LOW):**
- Symptoms: when `buildCompareTutor` fills a missing today/future weekday with the nearest-future occurrence, it dedups candidates by `recurrenceId` alone (`src/lib/search/compare.ts:274-284`). Two distinct recurring series at the same weekday and start time (different students) collapse to whichever sorts first.
- Trigger: a tutor with two same-slot recurring series; only one renders in the fallback.
- Blast radius: bounded — the fallback runs only for weekdays whose calendar date is today or later (D-05, `compare.ts:252-268`); past weekdays render honest-empty. Real date-range rendering is unaffected.
- Fix approach: dedup by `(recurrenceId, studentName)`.

**Setting a competitor-intelligence budget cap to zero grants unlimited spend (LOW):**
- Symptoms: `providerHardCapUsd` returns the parsed env value when it is finite and `>= 0` (`src/lib/competitor-intelligence/budget.ts:18-25`), and `wouldExceedBudget` short-circuits to `false` whenever `hardCapUsd <= 0` (`budget.ts:27-30`). So `COMPETITOR_INTEL_MONTHLY_CAP_USD=0`, the natural way to express "spend nothing", disables the cap check entirely.
- Trigger: an operator setting the cap to 0 to stop spend.
- Impact: the opposite of the intent, on the only paid-per-call external providers in the repo. Note the same function defaults an unset cap to **$250/month** for any non-website source.
- Fix approach: treat `0` as a hard stop and use a separate sentinel (`null`/unset) for "uncapped"; make the two enforcement call sites (`sync.ts:156-157,177`) explicit about which they mean.

**Competitor-intelligence budget months roll over in UTC, not Bangkok (LOW):**
- Symptoms: `monthStartIso()` computes the usage-month bucket with `setUTCDate(1)` / `setUTCHours(0,0,0,0)` (`src/lib/competitor-intelligence/budget.ts:11-16`), while the rest of the app is normalized to `Asia/Bangkok` (UTC+7).
- Trigger: spend booked between 00:00 and 07:00 Bangkok on the 1st is attributed to the previous month's bucket, so the new month's cap starts already consumed — or, symmetrically, a cap is exceeded across the boundary.
- Impact small (the cron runs weekly at 01:25 Bangkok Monday, so the boundary is rarely hit) but this is a real paid-API spend control.
- Fix approach: derive the bucket from `toZonedTime(date, "Asia/Bangkok")` like every other date helper.

**Competitor-intelligence cost tracking is an estimate, not billing truth (LOW):**
- Symptoms: per-call cost is a hardcoded default times item count — `COMPETITOR_APIFY_COST_PER_ITEM_USD ?? 0.01` and `COMPETITOR_DATAFORSEO_COST_PER_QUERY_USD ?? 0.002` (`src/lib/competitor-intelligence/sync.ts:129,136`; `providers.ts:124,179`).
- Trigger: an unset `COMPETITOR_INTEL_MONTHLY_CAP_USD` in production silently grants a $250 monthly allowance measured against guessed unit prices.
- Fix approach: set caps explicitly in Vercel env and reconcile the estimate against provider billing monthly.

## Security Considerations

**The two Auth.js provider configs request different Google scopes (MEDIUM):**
- Risk: `src/lib/auth.ts:39` requests `openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file` — full read-**write** Sheets plus per-file Drive. `src/lib/auth-edge.ts:11` still declares the old read-only scope `.../spreadsheets.readonly` for the same provider.
- Current mitigation: the authorization request is issued by the Node route handler (`/api/auth/[...nextauth]`), so the write scope is what users actually consent to; the edge config's provider params are used only for session/JWT decoding in middleware. The divergence is latent, not active.
- Recommendations: share one provider config object across both entry points so they cannot drift. Separately, note that this escalation means every admin's Google grant is write-capable on their spreadsheets and can create Drive files — a capability exercised by the payout workbook writers (`src/lib/post-class-feedback/payout-writer.ts`, `payout-workbook-operations.ts`), which mutate a real financial ledger.

**`allowedPages` and `role` are resolved once at sign-in and never refreshed (MEDIUM):**
- Risk: the Node `jwt` callback resolves access **only when `user` is present** — i.e. at sign-in — and persists `allowedPages`/`role` onto the token (`src/lib/auth.ts:58-67`). The edge `jwt` callback is a pass-through by design (`src/lib/auth-edge.ts:22-26`), and middleware authorizes from `req.auth.user.allowedPages` (`src/middleware.ts:78-88`).
- Current mitigation: five roles exist and every sensitive surface re-checks in Postgres — `requireCaseAccess` for admissions (used by 35 route files, `src/lib/admissions/access.ts:117`), `getPostClassCapabilities` for post-class feedback, teacher canonical-key resolution for progress tests. Middleware carries explicit carve-outs acknowledging this: `/post-class-feedback` and `/learning-plans` are coarse-passed at the edge precisely because "legacy JWT page prefixes must not override" the fresh DB grants (`src/middleware.ts:33-51`).
- Recommendations: **revoking a user's access does not take effect until their JWT expires or they sign in again** — document that in the runbook, or re-resolve when a `lastAccessCheck` claim ages past a few minutes. The carve-out list is also growing: each new feature with DB-fresh grants needs a hand-written middleware exception, and one written wrong either over-blocks or over-permits. Note `/api/learning-plans*` is explicitly `return false` at `middleware.ts:48-51` while the page namespace is `return true` — a subtlety that will trip the next editor.

**Middleware public-route allowlist spans eight path families (MEDIUM):**
- Risk: `isPublicRoute` (`src/middleware.ts:4-20`) bypasses `edgeAuth` for `/login`, `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/schedule/*`, `/api/line/contacts/oa-resolver/worklist`, the regex `^/api/line/contacts/oa-resolver/runs/[^/]+/rows$`, and **all** of `/api/internal/*` (21 route files). Each must self-authenticate; the contract is implicit.
- Current mitigation: the data-bearing ones do self-protect. `/api/line/webhook` verifies the LINE HMAC with `timingSafeEqual` fail-closed (`src/lib/line/signature.ts:12-19`, enforced at `src/lib/line/webhook.ts:27`) and 503s when unconfigured. `/api/internal/*` uses constant-time `CRON_SECRET` comparison (shared helper in 16 routes, inlined in 6 — see Tech Debt). `/schedule/*` is guarded by the capability-token design below. The oa-resolver routes require an opaque per-run bearer token.
- Recommendations: `/api/classrooms/floor-plan-map` has **no** auth of any kind — it renders an SVG from a `rooms` query param and sets `Cache-Control: public, max-age=3600` (`src/app/api/classrooms/floor-plan-map/route.ts:3-15`). Low risk (no DB read, no secret) but genuinely open. Keep a per-route table of which mechanism protects each allowlisted path; a future engineer adding anything under `/api/internal/` inherits zero gate by default.

**The public parent schedule page is a well-built capability-token surface — keep it that way (LOW, note):**
- Risk: `/schedule/[token]` is the only unauthenticated page that renders student data.
- Current mitigation: strong and deliberately documented. 32 random bytes from `crypto.randomBytes`, only the SHA-256 hash persisted, constant-time digest comparison with a length pre-check, scoped to exactly one `(studentKey, monthKey)`, TTL-expiring and revocable, and **every** failure mode (malformed / unknown / expired / revoked) returns `null` so the page renders one identical notice and cannot be used as an existence oracle (`src/lib/student-schedule/links.ts:1-56,121-169`; `src/app/schedule/[token]/page.tsx:39-62`). `robots: { index: false, follow: false }`; the heading uses the nickname, not the legal name.
- Recommendations: no design change. Two operational notes. (1) The risk is regression — a well-meaning "better error messages" change turns the single `ExpiredNotice` branch into an oracle; the source says "do not branch this" and that invariant deserves a test. (2) There is no rate limit: each request performs a DB lookup and, on success, a write (`viewCount` increment, `links.ts:149-158`). The `TOKEN_PATTERN` regex rejects malformed tokens before any query (`links.ts:25,126`), which blunts trivial scanning, but a valid-shaped brute force still costs one indexed SELECT per attempt.

**LINE schedule bot can push a child's schedule to a parent's phone (LOW, well gated):**
- Risk: `src/lib/line/schedule-bot.ts` and `schedule-bot-group.ts` send a message about a specific child to a destination the operator did not type.
- Current mitigation: the DM path has four independent fail-closed gates, documented in the module header (`schedule-bot.ts:1-27`) — SCHED-BOT-01 sender allowlist from `LINE_SCHEDULE_BOT_ADMIN_IDS` (unset/empty yields an empty set, disabling the bot entirely, `schedule-bot.ts:109-119`); SCHED-BOT-02 recipient resolved only from `status='verified'`, `isPhantom=false` contact links with no name-matching fallback; SCHED-BOT-03 explicit YES confirm with a 5-minute pending TTL; SCHED-BOT-04 refusal on an empty month. The router runs before the OpenAI classifier so an admin command never costs a model call and never enters the parent queue.
- Recommendations: two things to watch on the newer group path (`schedule-bot-group.ts:1-35`). (1) GRP-BOT-04 is **trust-on-first-use**: the bot confirms the first time a student appears in a given group, then lets repeat requests for that student go straight through. One mis-confirmed pairing becomes permanently silent. (2) The verified-student-link gate is deliberately *not* applied to groups, so the group path's only identity control is the exact-code match plus that one-time confirm. Both are defensible for the stated reason (the destination is a group everyone is already in), but they should be reviewed explicitly rather than inherited. Also, `LINE_SCHEDULE_BOT_ADMIN_IDS` is unvalidated free text (see `env.ts` above) — a typo disables the feature silently, which is the safe direction but produces a confusing "bot stopped working" report.

**LINE OA-resolver `worklist` allows wildcard CORS (LOW):**
- Risk: the route sets `Access-Control-Allow-Origin: *`, so a browser extension on any origin can call it.
- Current mitigation: access is gated by an opaque per-run bearer resolver token (401 without it); the wildcard governs only which page may present the token.
- Recommendations: acceptable for the extension integration; restrict to the extension origin if feasible.

**Wise API key duplicated across `Authorization: Basic` and `x-api-key` (LOW):**
- Risk: `WiseClient.headers` sends the key in both the Basic blob and `x-api-key` (`src/lib/wise/client.ts:52-61`).
- Current mitigation: HTTPS-only; this header shape is a Wise tenant requirement.
- Recommendations: no action unless Wise documents a single-header alternative.

## Performance Bottlenecks

**Per-teacher leave stitching dominates Wise sync wall time (HIGH):**
- Problem: `fetchTeacherFullAvailability` stitches a **180-day horizon into 26 seven-day windows** per teacher (`src/lib/wise/fetchers.ts:61,67,73,89`). With ~130 teachers that is thousands of Wise calls per sync, throttled by the client's `maxConcurrency: 15` (`src/lib/wise/client.ts:164`).
- Cause: no batch availability endpoint on Wise; the per-window fan-out is irreducible client-side.
- Mitigation in place: `maxDuration = 800` on the sync route (30 of the 42 routes that declare one use 800; 11 use 300; one uses 60), plus a single-flight guard that fails abandoned `running` rows after 20 minutes (`STALE_RUNNING_SYNC_MS`, `src/lib/sync/run-wise-sync.ts:10`).
- Improvement path: halve the horizon (180 → 90 days), negotiate a multi-window endpoint, or split fast working-hours from deferred leaves.

**Credit-control promote cost grows with total history (MEDIUM):**
- Problem: the unbounded `UPDATE credit_control_snapshots SET active = (...)` (`src/lib/credit-control/sync.ts:700-702`) touches every snapshot row, and nothing prunes those rows. See Known Bugs — listed here because the cost is not a one-off but compounds twice daily per hour, forever.
- Improvement path: bound the `WHERE` and add retention pruning; both are small changes.

**`buildIndex` reloads the whole snapshot on every cold start (MEDIUM):**
- Problem: the in-memory index hangs off `globalThis` (`src/lib/search/index.ts`), surviving HMR and warm invocations but not cold serverless starts. Each cold instance re-runs the snapshot-wide `SELECT`s plus the tutor business-profile map.
- Mitigation in place: build-promise coalescing (see Fragile Areas) and a small dataset keep a cold build sub-second.
- Improvement path: persist a serialized index to JSONB if scale ever reaches thousands of tutors.

**Three connection paths to the same database (LOW):**
- Problem: the shared neon-http singleton (`src/lib/db/index.ts`) plus **two** independent `pg.Pool({ max: 1 })` instances — payroll (`src/lib/payroll/sync.ts:94-98`) and post-class-feedback (`src/lib/post-class-feedback/transaction.ts:15-20`).
- Cause: neon-http lacks transactions; two features need them.
- Improvement path: acceptable at `max: 1` each, but the pools are per-instance and per-feature — monitor Neon connection counts if a payroll sync and a payout publish ever run concurrently across several warm functions.

**O(n²) joins and overlap detection in the read path (LOW):**
- Problem: the `data_issues` → group join is O(issues × groups) (`src/lib/search/index.ts:233-247`); same-student conflict detection in compare is O(students × overlaps²); calendar overlap-column packing in the week overview is similarly nested.
- Improvement path: fine at current scale (tens of groups, ≤3 compared tutors). Sweepline only if per-day session counts exceed ~100.

## Fragile Areas

**Snapshot promotion atomicity plus the cached-index fallback must both hold (MEDIUM):**
- Files: `src/lib/sync/orchestrator.ts:483-499`, `src/lib/search/index.ts:378-401`.
- Why fragile: promotion is a **single** `UPDATE snapshots SET active = (id = $new) WHERE active = true OR id = $new` (REL-01) — MVCC guarantees readers never see zero active rows mid-promote, and the comment at `orchestrator.ts:483-489` explicitly calls out the bounded `WHERE`. Separately, `ensureIndex` returns the cached index when no active snapshot is found (`index.ts:384-386`). Two independent mechanisms; if a refactor splits promotion back into two statements **or** removes the cached fallback, the "No active snapshot found" outage returns. The credit-control lineage is the cautionary example of what happens when only one lineage learns the lesson.
- Safe modification: keep promotion a single bounded statement; keep the cached fallback.
- Test coverage: `src/lib/sync/__tests__/orchestrator.integration.test.ts` exercises promotion against testcontainers Postgres. No test covers a read concurrent with a promotion.

**Build-promise coalescing depends on a synchronous assign-before-await (MEDIUM):**
- Files: `src/lib/search/index.ts:354-401`.
- Why fragile: `ensureIndex` (REL-02) builds the work closure, invokes it, and assigns the resulting promise to the `globalThis` singleton **in the same tick** before any `await` yields (`index.ts:395-400`). Correct as written, but moving `setBuildingPromise(p)` after any `await` reintroduces the double-rebuild leak the comment warns about.
- Safe modification: preserve the "kick off work and assign the promise in the same tick" structure.
- Test coverage: `src/lib/search/__tests__/index.test.ts`.

**Writeback safety flags are read at two different lifetimes (MEDIUM):**
- Files: `src/lib/line/operational.ts:21` vs `src/lib/wise/operations.ts:10-12`.
- Why fragile: `operational.ts:21` captures `WISE_SESSION_OPERATIONS_VERIFIED` into a **module-scope `const` at import time**, while `wise/operations.ts:11` reads it per call. The same flag has two effective lifetimes: flipping it in Vercel takes effect immediately on the `wise/operations` path but only on a fresh instance for the LINE operational path. `src/lib/progress-tests/config.ts:50` and `src/lib/student-promotions/data.ts:450` both use the per-call form.
- Safe modification: make all readers per-call functions; never capture a safety gate at module scope.
- Test coverage: module-scope capture is invisible to tests that set `process.env` in a `beforeEach`, so a test can pass while production is stale — precisely the failure this note exists to prevent.

**The cron watchdog is the only unified failure signal and has three self-referential dependencies (MEDIUM):**
- Files: `src/lib/internal/cron-watchdog.ts:1-90`, `src/lib/data-health/cron-registry.ts`, `src/lib/data-health/cron-audit.ts`, `src/lib/post-class-feedback/payout-window-health.ts`.
- Why fragile: the watchdog sweeps every registry job, derives health from `cron_invocations` audit rows, and emails admins with episode dedup in `cron_alert_state`. Three coupled assumptions: (1) it excludes itself (`WATCHDOG_JOB_KEY`, `cron-watchdog.ts:39`) so it can never alert on its own flapping, and nothing else watches it; (2) it locks via a sentinel `cron_alert_state` row rather than a `*_sync_runs` guard, because "neon-http supports neither transactions nor session advisory locks" (`cron-watchdog.ts:41-50`) — a crashed sweep blocks alerts for up to 6 minutes; (3) it delivers via the Apps Script sender, so an Apps Script outage suppresses the alerts about itself. A deliberate partial-delivery tradeoff is documented at `cron-watchdog.ts:11-17`: if some recipients accept and others bounce, the episode is marked alerted and the bouncing addresses are only `console.error`-logged, never retried for that episode.
- Compounding: the two Known Bugs above (credit-control misclassified as failing; 404 clicks writing failed audit rows) both feed **false failures** into this exact signal. Alert credibility is the thing at risk.
- Safe modification: keep the registry ↔ `vercel.json` parity test (`src/lib/data-health/__tests__/cron-registry.test.ts:7-20`) — it is the single thing preventing a cron from existing in one place and not the other. Extend it to `maxDurationSeconds`.
- Test coverage: one test file for the whole 500-line module (`src/lib/internal/__tests__/cron-watchdog.test.ts`); the sweep-lock reclaim and partial-delivery paths are the ones to verify before changing.

**Payout accrual is a "parked" job that the watchdog nonetheless monitors (MEDIUM):**
- Files: `src/lib/data-health/cron-registry.ts:233-247` (`post_class_feedback_payout_accrual`, `schedule: null`, `manualOnly: true`, `dangerous: true`, confirmation label "Appends real payout deductions to the master ledger"), `src/lib/post-class-feedback/payout-window-health.ts`, `src/lib/internal/cron-watchdog.ts:73-90`.
- Why fragile: four post-class jobs are parked with no Vercel cron — the admin digest, both tutor reminders, and payout accrual (`cron-registry.ts:185-247`). The watchdog injects a **synthetic** swept entry (`PAYOUT_WINDOW_JOB_KEY`) that flags a payout window stale once the calendar month it anchors has ended. So the system alerts that a financial window was never finalized, but nothing automatically finalizes it — closure depends on a human clicking a `dangerous` job in Data Health. **And that button currently 404s** (see Known Bugs), so the documented actuator for the alert does not work.
- Safe modification: the manual posture is deliberate (real money leaves the system), not a bug. What is fragile is that the monthly obligation lives only in code comments and one watchdog alert.
- Test coverage: `classifyPayoutWindowStaleness` is pure and testable; nine post-class integration suites exist, including `payout-run`, `payout-accrual`, and `payout-repository`.

**The parent-facing schedule depends on a lineage built for a different purpose (MEDIUM):**
- Files: `src/lib/student-schedule/data.ts:165-235`, `src/lib/credit-control/sync.ts`.
- Why fragile: `getStudentMonthlySchedule` reads `credit_control_snapshots` / `credit_control_students` / `credit_control_sessions` — a lineage whose sync cadence, failure modes, retention, and Wise windows (`PAST_WINDOW_DAYS` / `FUTURE_WINDOW_DAYS`, `sync.ts:650-651`) were all designed for the at-risk-credit queue, not for showing a parent their child's month. A change to the credit-control fetch windows silently truncates the parent calendar. The comment correctly forbids a name-search fallback (`data.ts:157-163`), so the failure mode is empty rather than wrong-student — good — but the coupling is undeclared on the credit-control side.
- Safe modification: leave the read where it is (a second Wise lineage would be worse), but add a test asserting the month window fits inside the credit-control fetch horizon, and note the dependency in the credit-control feature doc.
- Test coverage: `src/lib/student-schedule/__tests__/` has 2 test files.

**`globalThis`-anchored singletons survive HMR but not cold starts (LOW):**
- Files: `src/lib/search/index.ts`, `src/lib/db/index.ts`.
- Why fragile: search index and DB client both hang off `globalThis.__bgscheduler_*`. Per-instance by construction; no guard against a bundler creating two module namespaces.
- Test coverage: none for the singleton identity property.

**Multi-day leave coverage is a documented full-day assumption (LOW):**
- Files: `src/lib/search/engine.ts:243-261` (`hasRecurringLeaveConflict`, REL-04).
- Why fragile: a >24h leave blocks every weekday it touches in full-day form, ignoring HH:MM bounds for edge days. Intentional (it replaced a genuine minute-math bug) but it over-blocks partial first/last days.
- Test coverage: `src/lib/normalization/__tests__/leaves.test.ts`, `src/lib/search/__tests__/engine.test.ts`.

## Scaling Limits

**Wise snapshot storage bounded by 30-snapshot retention (LOW):**
- Current capacity: `pruneOldSnapshots` runs after each successful promote and keeps `SNAPSHOT_RETENTION_COUNT = 30` (`src/lib/sync/snapshot-pruning.ts:5,49`), cascade-deleting older snapshots. `past_session_blocks` is deliberately cross-snapshot (D-04, `src/lib/db/schema.ts:2255-2261`) and exempt.
- Limit: flat rather than monotonic growth. Pruning failures are caught, logged, and recorded in `sync_runs.metadata` without failing the sync.
- Scaling path: tune the retention count; pruning is idempotent.

**Credit-control storage is unbounded (HIGH — see Known Bugs):**
- Current capacity: no ceiling. 48 full snapshots/day, never pruned, in the highest-row-count lineage.
- Scaling path: port `pruneOldSnapshots`; this is the single highest-leverage storage fix in the repo.

**Wise sync wall time vs the 800s function ceiling (MEDIUM):**
- Current capacity: ~130 teachers × 26 leave windows under `maxDuration = 800`.
- Limit: the 800s ceiling. Of the 42 routes that declare `maxDuration`, 30 use 800s, 11 use 300s, one uses 60s.
- Scaling path: horizon reduction or a Wise batch endpoint (see Performance Bottlenecks).

**Schema and route surface growth outpacing structural conventions (MEDIUM):**
- Current capacity: 188 tables in a **single 4,719-line `src/lib/db/schema.ts`**; 241 handlers across 178 route files; 35 `src/lib` domain modules; 96,492 lines of non-test `src/lib` source with five files over 1,900 lines (`ai/scheduler-conversation.ts` 2,828, `student-promotions/data.ts` 2,508, `post-class-feedback/payout-repository.ts` 2,389, `post-class-feedback/repository.ts` 2,172, `classrooms/data.ts` 1,933).
- Limit: not runtime — editorial. A schema file this size makes cross-domain review impractical and `drizzle-kit generate` diffs hard to read, which is how the snapshot drift above went unnoticed.
- Scaling path: split `schema.ts` into per-domain files re-exported from one barrel (the sanctioned barrel exception already exists for `import * as schema`), and set a soft line-count ceiling on `lib` modules.

**In-memory index size (LOW):**
- Current capacity: tens of groups × windows × sessions — single-digit MB serialized.
- Scaling path: a concern only at 10,000+ tutors.

**Client-side compare cache grows unbounded across week navigation (LOW):**
- Current capacity: `useCompare` caches `CompareTutor` in a `useRef(new Map())` keyed by `` `${tutorGroupId}:${week}:${CACHE_VERSION}` `` (`src/hooks/use-compare.ts:107,170`). Entries accumulate as the user pages weeks; the cache invalidates on version change (`src/lib/search/cache-version.ts`) but has no size cap.
- Scaling path: LRU eviction at ~50 entries.

## Dependencies at Risk

**`next-auth: 5.0.0-beta.30` (HIGH):**
- Risk: exact-pinned Auth.js v5 beta. Betas carry breaking changes between releases; no LTS.
- Impact: auth is split across `src/lib/auth.ts` (Node) and `src/lib/auth-edge.ts` (edge middleware), with a custom five-role `resolveUserAccess` callback, JWT `allowedPages` claims consumed by `src/middleware.ts`, and a Google Sheets/Drive OAuth scope. A beta bump could touch any of these — and the two provider configs already disagree (see Security).
- Migration plan: stay pinned; upgrade to v5 GA in a dedicated phase, re-testing the edge/node split, role resolution order, and the sheets scope.

**No `openai` SDK despite eight raw Responses-API call sites (MEDIUM):**
- Risk: there is no `openai` package in `package.json`; seven modules call `https://api.openai.com/v1/responses` over raw `fetch` from eight sites — `ai/scheduler.ts:544`, `ai/scheduler-conversation.ts:2346`, `line/classifier.ts:98`, `line/contact-aliases.ts:368`, `progress-tests/ai-summary.ts:185`, `competitor-intelligence/ai.ts:161,300`, `post-class-feedback/ai.ts:62`. Five model selectors plus `OPENAI_SCHEDULER_REASONING_EFFORT` are read as unvalidated free-text env.
- Impact: contract drift (model names, response envelope, reasoning-effort params) is caught only at runtime as a 4xx/5xx, in eight places rather than one. Feature gating is also inconsistent — `ENABLE_AI_SCHEDULER !== "false"` gates both the AI scheduler and progress-test summaries (`ai/scheduler.ts:478,540`; `progress-tests/ai-summary.ts:77`), while competitor intel has its own `ENABLE_COMPETITOR_AI` (`competitor-intelligence/ai.ts:71`) and the LINE/post-class paths have neither.
- Migration plan: adopt the official SDK, or add one shared typed client plus a Zod contract test against a recorded fixture.

**Two unvendored paid data providers behind estimated budgets (MEDIUM):**
- Risk: competitor intelligence calls Apify and DataForSEO directly (`APIFY_API_TOKEN`, `APIFY_FACEBOOK_ACTOR`, `APIFY_INSTAGRAM_ACTOR`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`) with no SDK and self-estimated per-item cost.
- Impact: see the three Known Bugs entries — an unset cap defaults to $250/month against guessed unit prices, a cap of `0` disables enforcement entirely, and the bucket rolls over on a UTC month boundary.
- Migration plan: set caps explicitly; fix the zero-cap semantics; reconcile against provider billing.

**`@base-ui/react: 1.3.0` (MEDIUM):**
- Risk: exact-pinned 1.x of a young primitives library underpinning the 15 shadcn primitives in `src/components/ui/`, which in turn back the other ~146 feature components (161 non-test `.tsx` files under `src/components/`, across 24 feature directories).
- Migration plan: stay pinned; monitor the changelog.

**`drizzle-orm: 0.45.2` / `zod: ^4.3.6` / `xlsx: ^0.18.5` (LOW):**
- Risk: `drizzle-orm` is exact-pinned pre-1.0 and **its error strings are load-bearing** in the two transaction fallbacks (see Tech Debt). `zod` v4 peer support across the ecosystem is still maturing. `xlsx` 0.18.5 is the last npm-published SheetJS release and parses untrusted uploaded workbooks in the sales-dashboard import path.
- Migration plan: run migrations against the testcontainers integration suite before upgrading Drizzle; treat any `xlsx` advisory as high priority given it consumes user-supplied files.

## Missing Critical Features

**No automated finalize for the payout window, and the manual one is broken (HIGH):**
- Problem: `post_class_feedback_payout_accrual` is registered manual-only with no cron (`cron-registry.ts:233-247`), yet the watchdog raises a staleness alert once an anchor month ends without the window reaching `published`. The alert exists; the actuator is a human — and that human's button returns 404 because `run-job.ts` has no branch for the key (`src/lib/data-health/run-job.ts:195`).
- Approach: add the missing `run-job.ts` branch first (it makes the documented workflow real), then write the monthly runbook step tied to the alert so the obligation does not live only in code comments.

**Three of four post-class tutor-facing notification jobs are parked (MEDIUM):**
- Problem: `post_class_feedback_digest`, `post_class_feedback_day_after`, and `post_class_feedback_deadline` are all `schedule: null, manualOnly: true, dangerous: true` (`cron-registry.ts:185-232`). The registry comment says they "stay registered as manual-only so Data Health never reports them late."
- Approach: decide whether the reminder loop is shipping or being retired. Registered-but-parked dangerous jobs are the state most likely to be run by accident from the Data Health job list — the `dangerous` + `confirmed: true` gate plus the `access_manager` capability check (`src/app/api/data-health/jobs/[jobKey]/run/route.ts:25-41`) is the only thing between a curious admin and an outbound tutor email blast.

**Room-utilization and LINE-backlog refresh have no schedule (LOW):**
- Problem: `/api/internal/sync-room-utilization` and `/api/internal/line-backlog-recovery` are registered `manualOnly: true` (`cron-registry.ts:343-372`). Room utilization is genuinely invocable — it has a `run-job.ts` branch (`run-job.ts:185`) and a "Sync" button in the room-capacity dashboard — and a registry test asserts it stays out of the scheduled set (`cron-registry.test.ts:33-36`). LINE backlog recovery has **no** `run-job.ts` branch, so it is manual-only in name and unreachable in practice from Data Health.
- Approach: room-capacity data drifts between manual refreshes — either add a low-frequency cron or state the manual cadence in the runbook. For LINE backlog recovery, add the branch or drop the button.

**Sales/credit-control/leave-request staleness is not surfaced to end users (MEDIUM, upgraded):**
- Problem: the Wise snapshot path has a user-visible staleness ladder — a 90-minute API warning and a 2-hour app-wide banner (`src/lib/ops/stale.ts:1-17`). The other lineages have health only inside Data Health and the watchdog's admin email. A sales or credit-control user sees no in-page indication that their numbers are hours old.
- Upgraded because credit control now feeds a **parent-facing** page that actively advertises freshness it cannot verify (see Known Bugs).
- Approach: reuse the `StaleSnapshotBanner` pattern per feature, driven by the existing cron health derivation, and surface real snapshot age on `/schedule/[token]`.

## Test Coverage Gaps

> Counts: 369 test files — 304 `.test.ts` (of which 12 are `.integration.test.ts`)
> and 65 `.test.tsx`. `npm test` runs the `unit` project only;
> `npm run test:integration` runs the testcontainers Postgres suite
> (`vitest.config.ts:36-50`, `fileParallelism: false`, `maxWorkers: 1`).
> Coverage config excludes `src/app/**/*.tsx` outright (`vitest.config.ts:16-22`),
> so page-level Server Components are never measured. Distribution is heavily
> skewed: `post-class-feedback` has 35 test files against 37 source files
> (including 9 of the 12 integration suites); `admissions` and `line` have 21
> each — while nine `src/lib` modules have exactly one and `src/hooks` has none.

**Integration coverage is concentrated in one feature (MEDIUM):**
- What's not tested: 9 of 12 integration suites are post-class-feedback; the other 3 are all sync (`orchestrator`, `past-sessions-diff-hook`, `snapshot-pruning`). Nothing exercises admissions case-access enforcement, payroll writes, LINE webhook→review persistence, credit-control snapshot promotion, or leave-requests sync against a real Postgres.
- Files: `src/lib/*/__tests__/*.integration.test.ts`.
- Risk: the transaction-fallback and advisory-lock behaviour in Fragile Areas is exercised only for post-class-feedback. Payroll's identical fallback (`src/lib/payroll/sync.ts:100-124`) has no integration test at all. The credit-control unbounded-promote bug would have been caught by any integration test asserting row counts after two syncs.
- Priority: MEDIUM.

**Cron registry parity test checks two fields of thirteen (MEDIUM):**
- What's not tested: `cron-registry.test.ts:12-19` compares only `{ path, schedule }` between `SCHEDULED_CRON_JOBS` and `vercel.json`. `maxDurationSeconds` drift is invisible — which is exactly how the credit-control misclassification survived. Nothing asserts that every `CronJobKey` has a `run-job.ts` branch, which is how seven 404 buttons survived.
- Risk: the two highest-impact Known Bugs in this audit are both single-assertion misses in an already-existing test file.
- Priority: MEDIUM — these are cheap, high-yield assertions.

**Hooks are entirely untested (MEDIUM):**
- What's not tested: `src/hooks/` contains five hooks (`use-compare`, `use-keyboard-shortcuts`, `use-resizable-split`, `use-sales-dimensions`, `use-theme`) and **zero** test files. `use-compare.ts` holds the AbortController cancellation, the incremental `fetchOnly` cache merge, cache-version invalidation, and per-tutor eviction (`use-compare.ts:107,126-128,170,225-230,270`).
- Risk: race-condition and cache-invalidation logic is unverified even though 65 component `.test.tsx` files exist.
- Priority: MEDIUM.

**Thin modules with a single test file (MEDIUM for one, LOW for the rest):**
- What's not tested proportionally: `src/lib/internal` (2 source files including the 500-line cron watchdog, 1 test), `src/lib/proposals` (3/1), `src/lib/ui` (2/1), `src/lib/scheduler` (1/1), `src/lib/ops` (1/1), `src/lib/navigation` (1/1), `src/lib/home` (1/1), `src/lib/calendar` (1/1), `src/lib/syllabus` (4/2), `src/lib/student-promotions` (3/2 — for a module that performs verified Wise writes), `src/lib/student-schedule` (3/2). `src/lib/db` has none (schema + seed only, which is reasonable).
- Risk: the cron watchdog is the repo's only unified failure signal and carries sweep-lock reclaim, episode dedup, and partial-delivery logic behind one test file.
- Priority: MEDIUM for `internal/cron-watchdog` and `student-promotions`; LOW for the rest.

**Env/config degradation paths (LOW individually, MEDIUM in aggregate):**
- What's not tested: that a missing `OPENAI_API_KEY`, `RESEND_API_KEY`, `SCHEDULE_EMAIL_*`, or `LEAVE_REQUESTS_*` var degrades to a 503/disabled state rather than 500-ing deep in a handler. Nor that a mistyped `WISE_SESSION_*_VERIFIED` value fails closed (it does, by `=== "true"`, but nothing asserts it). Nor — most simply — that `src/lib/env.ts` is imported by anything, which would have caught the orphan module immediately.
- Priority: MEDIUM in aggregate given 42 unvalidated vars.

**Public capability-token invariants (LOW but high-consequence):**
- What's not tested: that `/schedule/[token]` renders one identical response for all four failure modes. The source comment says "do not branch this" (`src/app/schedule/[token]/page.tsx:55`), which is the right instinct, but `src/app/**/*.tsx` is excluded from coverage entirely and the invariant has no assertion.
- Priority: LOW frequency, high consequence — this is the app's only unauthenticated data surface.

## Resolved Since Last Audit

The following prior concerns are FIXED in current code and retained so the delta
is auditable, plus two prior claims that re-reading the code showed were wrong.

- **Uncommitted `leave-requests` WIP (was MEDIUM) — RESOLVED.** `git ls-files src/lib/leave-requests` returns 9 tracked files including 4 tests; the feature has 5 tables, a `/leave-requests` page, 5 API routes, and a scheduled cron. No untracked source exists anywhere in the tree (the only untracked files are four `docs/features/*.md`).
- **Orphan `sync-room-utilization` handler (was MEDIUM) — RESOLVED, downgraded to a missing-schedule note.** It is now a first-class `manualOnly: true` registry entry (`cron-registry.ts:343-357`) with a `run-job.ts` branch and a dashboard button, and a registry test asserts it stays out of `vercel.json`.
- **No unified "any sync is failing" signal (was MEDIUM) — RESOLVED.** The `cron_watchdog` cron (`7,37 * * * *`) sweeps all 21 registered jobs, derives status from `cron_invocations`, and emails admins with episode dedup. Its credibility is now the concern, not its existence.
- **Cron drift between code and `vercel.json` (guard).** `SCHEDULED_CRON_JOBS` is asserted equal to `vercel.json`'s `crons` array by path and schedule; 15 scheduled jobs match 15 `vercel.json` entries exactly, verified by running the test's own comparison.
- **Client-side `toLocaleString` timezone derivation (was MEDIUM) — RESOLVED.** Zero occurrences of the `new Date(new Date().toLocaleString(...))` idiom remain in `src/`.
- **Zero component tests (was MEDIUM) — RESOLVED.** 65 `.test.tsx` files exist across `src/components/`.
- **Unreviewed dangerous manual jobs (guard).** `/api/data-health/jobs/[jobKey]/run` requires a session, requires the `access_manager` capability for any `post_class_feedback*` job, and rejects any `dangerous` job with 409 unless the body carries `confirmed: true` (`route.ts:13-41`).
- **Route surface regressions (guard).** `npm run guard:production-route-surface` diffs the discovered `page.tsx`/`route.ts` surface against `docs/reference/production-route-surface.json` (207 source routes, 9 critical) and fails on shrinkage or a missing critical route. Verified passing at this revision. It runs inside `verify:release`, which `deploy:prod` runs before `assert-production-deploy-ready.mjs` (branch + clean tree + `HEAD == origin/main`).
- **Zero `TODO`/`FIXME`/`HACK` markers — still holds** across all of `src/`, tests included.
- **Non-atomic snapshot promotion, index-rebuild promise leak, zero-active-snapshot 500, non-constant-time `CRON_SECRET`, 4xx retry (`RETRYABLE_STATUS_CODES` at `wise/client.ts:23-27,123`), multi-day leave minute math, past-day fallback showing future occurrences, missing snapshot retention** — all remain fixed (REL-01…REL-07, D-05, `snapshot-pruning.ts`).

**Corrections to the prior audit:**

- **"Modality-conflict issues are silently dropped from the per-group view" — WRONG.** They match through the `entityName === group.displayName` arm, because the orchestrator sets `entityName: group.displayName` next to `entityId: session.wiseSessionId` (`orchestrator.ts:384-389`). The real concern is the inverse: that arm is load-bearing, so duplicate display names would cross-attribute issues. Restated under Tech Debt.
- **"`env.ts` gates 15 variables through Zod" — MISLEADING.** The schema exists but the module has zero importers, so it gates nothing. Promoted to the first Tech Debt entry.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
