# Codebase Concerns

**Analysis Date:** 2026-09-02

> Scope note: this audit covers `main@0cd1e81` with a clean source tree. Counts,
> all derived by command at this revision: **189 tables** and 61 `pgEnum`s
> (`grep -c "= pgTable(" src/lib/db/schema.ts`, 4,772 lines), **243 HTTP
> endpoints** across **180 `route.ts` files** (241 named `export async function`
> handlers plus the 2 destructured Auth.js handlers at
> `src/app/api/auth/[...nextauth]/route.ts:3`; the 2 CORS `OPTIONS` preflights
> on the public OA-resolver routes are excluded), **17 Vercel crons**
> (`vercel.json`) against a **22-entry cron registry** (`CronJobKey`,
> `src/lib/data-health/cron-registry.ts:3-23`; 3 declared `manualOnly`),
> **31 `page.tsx` files** (26 in the `(app)` group), **389 test files**
> (320 `.test.ts` of which 13 are `.integration.test.ts`, plus 69 `.test.tsx`),
> **36 `src/lib` domain modules**, and **101,993 lines** of non-test `src/lib`
> source. `git status --short src/` is empty — the only working-tree changes are
> documentation. Prior concerns that are now FIXED are listed under "Resolved
> Since Last Audit" rather than being silently dropped.

## Tech Debt

**`src/lib/env.ts` is never imported — the startup validation gate does not exist (HIGH):**
- Issue: `env.ts` builds an 18-key Zod schema and exports `env = getEnv()`, which validates at module-evaluation time (`src/lib/env.ts:40-49`). A repo-wide grep for `lib/env` across `src/` and `scripts/` returns **zero importers outside the file itself**. Nothing ever evaluates the module, so `getEnv()` never runs and nothing is ever validated.
- Files: `src/lib/env.ts:3-49`.
- Impact: the documented guarantee ("env validated at startup, throws on invalid") is fiction. Every consumer reads `process.env.*` directly and fails at its own call site — `getDb()` throwing `DATABASE_URL is not set` (`src/lib/db/index.ts:6-9`), `createWiseClient()` producing a `Buffer.from("undefined:undefined")` basic-auth blob that surfaces as a Wise 401 mid-sync (`src/lib/wise/client.ts`). A misconfigured deploy boots green and fails hours later inside a cron. The module's own `MAINTENANCE_MODE` comment concedes the situation — it is declared "for inventory parity only" because `src/middleware.ts` reads `process.env` directly, "because this module throws on a partial env" (`env.ts:29-32`).
- Fix approach: import `env` from a real startup path (root layout or `instrumentation.ts`) **and** extend the schema, or delete the module and document per-call-site reads as the actual convention. Half-measures are worse than either.

**The schema covers 18 of 65 env vars actually read (HIGH, compounding the above):**
- Issue: `grep -rhoE "process\.env\.[A-Z0-9_]+" src scripts | sort -u` finds **65 distinct names**; `envSchema` declares 18 (`src/lib/env.ts:3-36`). Unvalidated and load-bearing: `OPENAI_API_KEY` plus the per-feature model selectors; the `SCHEDULE_EMAIL_*` Apps Script pair and its backup pair (`src/lib/classrooms/schedule-email.ts:291-302`); `RESEND_API_KEY` (`src/lib/admissions/notifications.ts:299`); the three `LEAVE_REQUESTS_*` vars; the Apify/DataForSEO credentials and caps; the entire `POST_CLASS_PAYOUT_*` Google-target set (`src/lib/post-class-feedback/payout-config.ts`); and the four Wise/payout safety gates `WISE_SESSION_OPERATIONS_VERIFIED`, `WISE_SESSION_CREATE_VERIFIED`, `WISE_SESSION_SUBJECT_UPDATE_VERIFIED`, `POST_CLASS_PAYOUT_WRITES_ENABLED`.
- Files: `src/lib/wise/operations.ts:11`, `src/lib/progress-tests/config.ts:50`, `src/lib/student-promotions/data.ts:450`, `src/lib/post-class-feedback/payout-config.ts:49-51`, `src/lib/competitor-intelligence/budget.ts:19-20`.
- Impact: every safety gate is a free-text `=== "true"` comparison. A typo (`True`, `" true"`) silently disables a gate that exists to be explicit. It fails in the safe direction — the write is skipped — but presents as "the feature stopped working" with no error anywhere. `resolveAutoApproveEnabled` is the one reader that at least trims (`payout-config.ts:164-168`), and `resolveAutoApproveGraceHours` is the one that documents why loose coercion was dangerous (`payout-config.ts:183-190`) — the rest do neither.
- Fix approach: `z.enum(["true","false"])` for the verified flags, `.optional()` for the genuinely optional ones, and route reads through `env`.

**Six copy-pasted constant-time `CRON_SECRET` checks (MEDIUM):**
- Issue: `src/lib/internal/cron-auth.ts` exists precisely to centralize REL-07's constant-time compare, and 16 of the 22 `src/app/api/internal/**/route.ts` files import it. Six inline their own byte-identical implementation: `sync-wise/route.ts`, `sync-room-utilization/route.ts`, `sync-competitor-intelligence/route.ts`, `sync-sales-dashboard/route.ts`, `sync-credit-control/route.ts`, `student-promotions/july-1/route.ts` (each matched by `grep -c timingSafeEqual` with no `cron-auth` import).
- Impact: all six are currently **correct** (length pre-check plus `timingSafeEqual`), so this is not a live vulnerability — it is six places a future edit can get wrong independently, in the one code path that stands between the public internet and every destructive cron (`/api/internal/*` is wholly allowlisted past middleware auth, `src/middleware.ts:23`). Note two of the six guard `dangerous: true` registry jobs.
- Fix approach: replace the six inline copies with `rejectInvalidCronSecret(request)`; add a test asserting every `src/app/api/internal/**/route.ts` imports the shared helper.

**The neon-http transaction fallback is now copy-pasted into three modules and keyed on an error string (MEDIUM, worsened):**
- Issue: the default DB singleton is neon-http (`src/lib/db/index.ts:1-12`), which has no transaction support. Three modules solve this identically and separately: `src/lib/payroll/sync.ts:89-107`, `src/lib/post-class-feedback/transaction.ts:11-34`, and — new since the last audit — `src/lib/admissions/audit.ts:53-94`. All three define `isNeonHttpTransactionUnsupported()` as a **regex over the driver's error message** (`/No transactions support in neon-http driver/i`), all three lazily open their own `pg.Pool({ max: 1 })`, and all three re-wrap the raw client with `drizzle-orm/node-postgres`.
- Impact: two failure modes. (1) If Neon or Drizzle reword that message, all three fallbacks stop triggering — payroll and admissions throw, post-class-feedback loses transactional guarantees. (2) The post-class path is the worst of the three: `lockPostClassFinance()` issues `pg_advisory_xact_lock` (`src/lib/post-class-feedback/finance-lock.ts:14-18`), which is **transaction-scoped**. Were the fallback to stop engaging while the callback still ran, the lock would release after each statement and the serialization behind payout publication, deduction decisions, and finance-period transitions would vanish silently rather than erroring. There is also an unstated assumption that `db.transaction()` throws *before* invoking the callback — if it ever threw partway through, all three fallbacks would replay the callback's side effects.
- Fix approach: one shared `withWriteTransaction()`; detect driver capability explicitly (driver-type check or a "needs transactions" DB accessor) rather than parsing a message; add a test that the fallback holds one session across two statements.

**Single-flight guards reimplemented per feature in four detection styles (MEDIUM):**
- Issue: 13 `single_running_idx` partial unique indexes exist in `schema.ts`. Each owning feature enforces "only one running" by inserting a `running` row and catching the unique violation — four different ways:
  - SQLSTATE only: `src/lib/credit-control/run-sync-request.ts:46`, `src/lib/progress-tests/run-sync-request.ts:44`, `src/lib/progress-tests/admin-digest.ts:266`, `src/lib/sales-dashboard/import-guard.ts:63`, `src/lib/classrooms/admin-schedule-email.ts:315`, `src/lib/line/credit-digest.ts:228`, `src/lib/admissions/cohorts.ts:22`.
  - SQLSTATE **or** index-name regex: `src/lib/wise-activity/sync.ts:64-66`, `src/lib/admissions/notifications.ts:237-238`.
  - Index-name **string match only**: `src/lib/leave-requests/sync.ts:57` — `text.includes("leave_request_sync_runs_single_running_idx")`.
  - Sentinel-row sweep lock: the watchdog has no `*_sync_runs` table at all, so it uses a `cron_alert_state` sentinel with a 6-minute staleness reclaim (`src/lib/internal/cron-watchdog.ts:41-51`).
- Impact: the leave-requests variant is the fragile one. Renaming that index, or a driver that stops surfacing the constraint name in `error.message`, silently disables the guard and allows concurrent Google Sheets reads *and status writeback*. (Source note: `src/lib/leave-requests/**` is read-only for this audit; the fix belongs to that module's owner.)
- Fix approach: one shared `isSingleFlightConflict(error, indexName?)` that asserts SQLSTATE `23505` first and uses the index name only as a secondary discriminator.

**Drizzle migration snapshot chain has 29 missing files (MEDIUM):**
- Issue: `drizzle/meta/_journal.json` records 69 migrations (idx 0-68, latest `0068_payout_adjustment_superseded`) against 69 `.sql` files, but only **40 `NNNN_snapshot.json` files** exist. Missing: 6, 9-13, 22-37, 48-49, 57-61. Nothing in `.gitignore` excludes them — they were deleted or never generated.
- Impact: `drizzle-kit generate` diffs against the newest snapshot, which *is* present, so generation works today. But the chain cannot be replayed or inspected at intermediate states, and any regeneration after a snapshot loss produces a bloated catch-up migration against a stale baseline. This has already bitten this repo.
- Fix approach: treat the current snapshot as the baseline, never delete `drizzle/meta/*.json`, and add a CI check that snapshot count equals journal entry count.

**Brittle `data_issues` → group join in `buildIndex` (MEDIUM):**
- Issue: `buildIndex` joins `data_issues` to tutor groups with an O(issues × groups) nested loop matching on `entityId === canonicalKey OR entityId === group.id OR entityName === displayName` (`src/lib/search/index.ts:232-240`).
- Impact: the `entityName` arm is **load-bearing**, not a fallback — modality-conflict issues are keyed by `wiseSessionId` in `entityId` and only reach their group through the display-name arm. Two groups sharing a display name would therefore cross-attribute every `conflict_model` issue between them, and nothing prevents duplicate display names.
- Fix approach: normalize all issue rows to `entityId = group.canonicalKey` at insertion in `src/lib/sync/orchestrator.ts`, then build one `Map<canonicalKey, IndexedDataIssue[]>` and drop the name arm.

**Modality derivation is still literal-string matching, while a reliable signal exists elsewhere in the repo (MEDIUM, known issue):**
- Issue: `deriveModality` inspects lowercased `sessionType`/`location` for the literals `"online"`, `"virtual"`, `"onsite"`, `"in-person"`, `"offline"` (`src/lib/normalization/modality.ts:42-52`); the compare-side resolver adds `"scheduled"` to the online set as a tenant-vocabulary patch (`src/lib/search/compare.ts:5-7`, tagged MOD-UAT-01). A single-record offline group with no session evidence fails closed to `unresolved` (`modality.ts:67-79`).
- Impact: tenant venue names ("Tesla", "Nerd", "Think Outside the Box") match nothing, so onsite-vs-online for single-record groups is frequently unknown/low-confidence. This is *correct* (fail-closed) but produces a persistent stream of "Needs Review" cards. The bolted-on `"scheduled"` synonym is evidence the vocabulary is unstable and will need another patch.
- The asymmetry is the real debt: `deriveSessionModality(title)` in `src/lib/student-schedule/data.ts:116` derives modality from the Wise session-title prefix and is trusted enough to feed both the parent-facing schedule and the student report (`src/lib/student-report/build.ts:157`). The snapshot lineage does not use it.
- Fix approach: source a reliable `isOnline` boolean from Wise, or port the title-prefix derivation into `normalization/modality.ts` as a step between session-type and location evidence.

**A spent one-shot cron still occupies a registry + `vercel.json` slot (MEDIUM):**
- Issue: `student_promotions_july_1` is registered with schedule `5 17 30 6 *` (June 30 17:05 UTC = July 1 00:05 Bangkok) in both `vercel.json` and `src/lib/data-health/cron-registry.ts:307-317`. It is `dangerous: true` with `manualOnly: false`.
- Impact: the job has already fired for its intended date and will **re-fire next June** against a codebase and Wise tenant that have moved on. Because it is scheduled rather than manual-only, Data Health and the watchdog classify it against an annual cadence — a permanently "late/unknown" posture for a year, adding noise to the exact signal the watchdog exists to produce. It is also one of the 7 keys whose Data Health "Run now" button 404s (see Known Bugs), so the manual path is unavailable too.
- Fix approach: flip it to `manualOnly: true` (it already has the `dangerous` confirm gate) and drop the `vercel.json` entry, or delete the route. Note `docs/reference/production-route-surface.json` lists `/api/internal/student-promotions/july-1` among its 9 **critical routes**, so removal must update that manifest in the same change or `guard:production-route-surface` fails the release.

**Two parallel outbound-email stacks, neither with an SDK (LOW):**
- Issue: admissions notifications go out through the Resend REST API over raw `fetch` (`src/lib/admissions/notifications.ts:43,299-304`), while classroom schedule emails, the admin classroom summary, and the cron watchdog's own alerts go out through a Google Apps Script webhook (`createAppsScriptScheduleEmailSender`, imported at `src/lib/internal/cron-watchdog.ts:23-26`) configured by the `SCHEDULE_EMAIL_APPS_SCRIPT_*` pair plus a `_BACKUP_` pair (`src/lib/classrooms/schedule-email.ts:291-302`). Neither `resend` nor any mail SDK is in `package.json`.
- Impact: two credential sets, two failure modes, two retry semantics, no shared deliverability view. The watchdog that alerts on cron failure depends on the Apps Script path — if Apps Script is what broke, the alert about it cannot be delivered.
- Fix approach: consolidate onto the existing `ScheduleEmailSender` seam, or at minimum give the watchdog a second, independent channel.

**Module sprawl in `post-class-feedback` (LOW):**
- Issue: `src/lib/post-class-feedback/` holds 40 non-test source files, **fourteen** of them `payout-*.ts`. `payout-repository.ts` is 2,484 lines; `repository.ts` is 2,180.
- Impact: the largest and most financially consequential subsystem in the repo has no sub-directory structure, so ownership boundaries inside it are conventional rather than enforced.
- Fix approach: promote `payout/` to its own directory under the feature — the module has the best test ratio in the repo (38 test files against 40 sources), so this is a mechanical move.

## Known Bugs

**Seven of twenty-two Data Health "Run now" buttons 404 and write a failed audit row (HIGH):**
- Symptoms: `CronJobKey` declares 22 keys (`src/lib/data-health/cron-registry.ts:3-23`); `runDataHealthJob` branches on 15 of them and falls through to `{ error: "Unknown job" }` with HTTP 404 (`src/lib/data-health/run-job.ts:207`). The dashboard renders a button for **all** 22 — `manualActions: CRON_JOBS.map(...)` (`src/lib/data-health/dashboard.ts:989-994`, consumed at `src/components/data-health/data-health-dashboard.tsx:167`).
- Trigger: clicking Run now for `progress_tests`, `progress_tests_digest`, `post_class_feedback_backfill`, `student_promotions_july_1`, `admissions_notifications`, `line_backlog_recovery`, or `line_credit_digest`.
- Impact: worse than a dead button. The click is wrapped in `withCronInvocationAudit` **before** the branch dispatch (`run-job.ts:34-42`), and the audit helper maps `status >= 400` to `"failed"`, so every attempt writes a **failed** `cron_invocations` row for a job that never ran — corrupting the very signal the watchdog alerts on. Five of the seven are live scheduled crons whose health is derived from those same rows.
- Fix approach: add the missing branches, or filter `manualActions` to the keys `run-job.ts` actually handles and assert that set equality in a test (the registry test file already has the harness for exactly this shape of assertion).

**Credit-control snapshots are never pruned (HIGH):**
- Symptoms: the Wise lineage prunes after every successful promote, keeping `SNAPSHOT_RETENTION_COUNT = 30` (`src/lib/sync/snapshot-pruning.ts:5,51`). Nothing equivalent exists for credit control — `grep -rn "delete(schema.creditControl" src/lib` finds only the sidecar `creditControlInactiveStudents` cleanup (`src/lib/credit-control/sync.ts:614`), never a snapshot.
- Trigger: every 30-minute run inserts a fresh snapshot (`sync.ts:667-669`) plus a full set of `credit_control_students`, `credit_control_packages`, `credit_control_sessions`, and `credit_control_credit_history` rows, and nothing is ever removed.
- Impact: unbounded monotonic growth at 48 full snapshots/day in the lineage with the largest per-snapshot row count — which also backs a **parent-facing** page (`src/lib/student-schedule/data.ts:323`), the progress-tests engine (`src/lib/progress-tests/db.ts:69`), the LINE credit digest, and student promotions.
- Fix approach: port `pruneOldSnapshots` to the credit-control lineage with its own retention count. This is the single highest-leverage storage fix in the repo.

**The hourly payout accrual cron discards its own failure reason (MEDIUM):**
- Symptoms: `src/app/api/internal/post-class-feedback/payout-accrual/route.ts:33-38` wraps both passes in `try { ... } catch { return NextResponse.json({ error: "Post-class payout accrual failed" }, { status: 500 }) }` — a bare `catch` with **no binding and no `console.error`**. The thrown error is destroyed.
- Trigger: any throw from `runPayoutAccrualPass` or `runPayoutFinalizePass` — a Google auth expiry, a sheet-shape change, a DB error.
- Impact: this is the cron that moves real money onto the master payout ledger (`33 * * * *`, `dangerous: true`, `cron-registry.ts:238-254`). When it fails, Vercel logs and the `cron_invocations` row both carry only the generic string; the operator has nothing to diagnose from. The contrast is stark two frames down: the retirement pass inside `runPayoutAccrualPass` logs its own failure with the error object (`src/lib/post-class-feedback/payout-accrual.ts:120-122`).
- Fix approach: bind the error and `console.error` it before returning the generic 500 (the response body should stay generic; the log should not).

**Setting a competitor-intelligence budget cap to zero grants unlimited spend (LOW):**
- Symptoms: `providerHardCapUsd` returns the parsed env value when it is finite and `>= 0` (`src/lib/competitor-intelligence/budget.ts:18-25`), and `wouldExceedBudget` short-circuits to `false` whenever `hardCapUsd <= 0` (`budget.ts:27-30`). So `COMPETITOR_INTEL_MONTHLY_CAP_USD=0`, the natural way to express "spend nothing", disables the cap check entirely.
- Trigger: an operator setting the cap to 0 to stop spend.
- Impact: the opposite of the intent, on the only paid-per-call external providers in the repo. Note the same function defaults an unset cap to **$250/month** for any non-website, non-manual source (`budget.ts:24`).
- Fix approach: treat `0` as a hard stop and use a separate sentinel (`null`/unset) for "uncapped"; make the enforcement call sites explicit about which they mean.

**Competitor-intelligence budget months roll over in UTC, not Bangkok (LOW):**
- Symptoms: `monthStartIso()` computes the usage-month bucket with `setUTCDate(1)` / `setUTCHours(0,0,0,0)` (`src/lib/competitor-intelligence/budget.ts:11-16`), while the rest of the app is normalized to `Asia/Bangkok` (UTC+7).
- Trigger: spend booked between 00:00 and 07:00 Bangkok on the 1st is attributed to the previous month's bucket, so the new month's cap starts already consumed — or, symmetrically, a cap is exceeded across the boundary.
- Impact: small (the cron runs `28 18 * * 0`, Monday 01:28 Bangkok, so the boundary is rarely hit) but this is a real paid-API spend control.
- Fix approach: derive the bucket from `toZonedTime(date, "Asia/Bangkok")` like every other date helper in the repo.

**`recurrenceId`-only dedup in the past-day fallback can drop a co-located recurring series (LOW):**
- Symptoms: when `buildCompareTutor` fills a missing today/future weekday with the nearest-future occurrence, it dedups candidates by `recurrenceId` alone (`src/lib/search/compare.ts:274-289`). Two distinct recurring series at the same weekday and start time (different students) collapse to whichever sorts first.
- Trigger: a tutor with two same-slot recurring series; only one renders in the fallback.
- Blast radius: bounded — the fallback runs only for weekdays whose calendar date is today or later (D-05, `compare.ts:270-276`); past weekdays render honest-empty. Real date-range rendering is unaffected.
- Fix approach: dedup by `(recurrenceId, studentName)`.

## Security Considerations

**The public parent schedule page now drives unauthenticated outbound Wise traffic (MEDIUM, new):**
- Risk: `getStudentMonthlySchedule` defaults to `liveSweep = "always"` (`src/lib/student-schedule/data.ts:311`), and the public page calls it with no override (`src/app/schedule/[token]/page.tsx:108-111`). Each uncached view therefore runs `sweepMonth`, which walks the Bangkok month padded one day at each end and issues one Wise request per day per status — roughly 34 **institute-wide** session fetches, each internally paginated, filtered to the one student only after the fetch returns (`src/lib/student-schedule/live.ts:105-115`, `src/lib/credit-control/wise.ts:206-227`).
- Current mitigation: real and deliberate. A `globalThis` memo keyed `wiseStudentId:monthKey` collapses repeat views inside a 60s TTL (`live.ts:29,140-152`), an 8s deadline caps the wait (`live.ts:27,63-88`), the whole path is fail-soft — any error returns `ok: false` and renders the snapshot unchanged — and `ENABLE_STUDENT_SCHEDULE_LIVE=false` is a documented kill switch (`live.ts:66-68`). The cache stores only student-filtered results, so no entry can leak one student's sessions into another's request.
- Recommendations: the memo is **per serverless instance**, so N warm instances mean up to N sweeps per TTL, and there is **no rate limit on the route** — a valid token refreshed in a loop, or shared into a group chat, converts page views into Wise API load on the tenant's shared quota. Add a route-level throttle, or set `liveSweep: "rescue"` on the public page specifically (the mode already exists and is what the schedule bot's empty-month path uses, `data.ts:372-379`) so the sweep is a rescue rather than the default.

**The two Auth.js provider configs request different Google scopes (MEDIUM):**
- Risk: `src/lib/auth.ts:39` requests `openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file` — full read-**write** Sheets plus per-file Drive. `src/lib/auth-edge.ts:11` still declares the old read-only scope `.../spreadsheets.readonly` for the same provider.
- Current mitigation: the authorization request is issued by the Node route handler (`/api/auth/[...nextauth]`), so the write scope is what users actually consent to; the edge config's provider params are used only for session/JWT decoding in middleware. The divergence is latent, not active.
- Recommendations: share one provider config object across both entry points so they cannot drift. Separately, note that this escalation means every admin's Google grant is write-capable on their spreadsheets and can create Drive files — a capability exercised by the payout workbook writers, which mutate a real financial ledger.

**`allowedPages` and `role` are resolved once at sign-in and never refreshed (MEDIUM):**
- Risk: the Node `jwt` callback resolves access **only when `user` is present** — i.e. at sign-in — and persists `allowedPages`/`role` onto the token (`src/lib/auth.ts:58-67`). The edge `jwt` callback is a pass-through by design, and middleware authorizes from `req.auth.user.allowedPages` (`src/middleware.ts:96`).
- Current mitigation: every sensitive surface re-checks in Postgres — `requireCaseAccess` for admissions, `getPostClassCapabilities` for post-class feedback (enforced again in the job-run route, `src/app/api/data-health/jobs/[jobKey]/run/route.ts:25-30`), fresh grants in the Learning Plans Server Components. Middleware carries explicit carve-outs acknowledging this: `/post-class-feedback` and `/learning-plans` are coarse-passed at the edge precisely because "legacy JWT page prefixes must not override" the fresh DB grants (`src/middleware.ts:40-52`).
- Recommendations: **revoking a user's access does not take effect until their JWT expires or they sign in again** — document that in the runbook, or re-resolve when a `lastAccessCheck` claim ages past a few minutes. The carve-out list is also growing: each new feature with DB-fresh grants needs a hand-written middleware exception, and one written wrong either over-blocks or over-permits. Note `/api/learning-plans*` is explicitly `return false` at `middleware.ts:54-57` while the page namespace is `return true` (`middleware.ts:50-53`) — a subtlety that will trip the next editor.

**Middleware public-route allowlist spans eight path families (MEDIUM):**
- Risk: `isPublicRoute` (`src/middleware.ts:10-25`) bypasses `edgeAuth` for `/login`, `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/schedule/*`, `/api/line/contacts/oa-resolver/worklist`, the regex `^/api/line/contacts/oa-resolver/runs/[^/]+/rows$`, and **all** of `/api/internal/*` (22 route files). Each must self-authenticate; the contract is implicit.
- Current mitigation: the data-bearing ones do self-protect. `/api/line/webhook` verifies the LINE HMAC with `timingSafeEqual` fail-closed. `/api/internal/*` uses constant-time `CRON_SECRET` comparison (shared helper in 16 routes, inlined in 6 — see Tech Debt). `/schedule/*` is guarded by the capability-token design below. The oa-resolver routes require an opaque per-run bearer token. The maintenance gate is deliberately ordered **above** `isPublicRoute` so it can still close `/api/line/webhook` (`middleware.ts:71-83`, MAINT-04).
- Recommendations: `/api/classrooms/floor-plan-map` has **no** auth of any kind — it renders an SVG from a `rooms` query param and sets `Cache-Control: public, max-age=3600` (`src/app/api/classrooms/floor-plan-map/route.ts:3-16`). Low risk (no DB read, no secret) but genuinely open. Keep a per-route table of which mechanism protects each allowlisted path; a future engineer adding anything under `/api/internal/` inherits zero gate by default.

**The public parent schedule token is a well-built capability surface — keep it that way (LOW, note):**
- Risk: `/schedule/[token]` is the only unauthenticated page that renders student data.
- Current mitigation: strong and deliberately documented. 32 random bytes from `crypto.randomBytes` (`src/lib/student-schedule/links.ts:92`), only the SHA-256 hash persisted, constant-time digest comparison with a length pre-check (`links.ts:44-51`), scoped to exactly one `(studentKey, monthKey)`, TTL-expiring and revocable, and **every** failure mode (malformed / unknown / expired / revoked) returns `null` so the page renders one identical notice and cannot be used as an existence oracle — the source says so in as many words: "One response for every failure mode — do not branch this" (`src/app/schedule/[token]/page.tsx:105`).
- Recommendations: no design change. Two operational notes. (1) The risk is regression — a well-meaning "better error messages" change turns the single `ExpiredNotice` branch into an oracle, and that invariant deserves a test. (2) There is no rate limit: each request performs a DB lookup and, on success, a write (`viewCount` increment, `links.ts:153`) and now a Wise sweep (above). `TOKEN_PATTERN` rejects malformed tokens before any query (`links.ts:25,126`), which blunts trivial scanning, but a valid-shaped brute force still costs one indexed SELECT per attempt.

**LINE bots can push a child's schedule or a credit digest to a group (LOW, well gated):**
- Risk: `src/lib/line/schedule-bot.ts`, `schedule-bot-group.ts`, and the newer `credit-digest.ts` all send messages about specific students to destinations the operator did not type at send time.
- Current mitigation: the DM path has four independent fail-closed gates documented in its module header — a sender allowlist from `LINE_SCHEDULE_BOT_ADMIN_IDS` (unset/empty yields an empty set, disabling the bot entirely), a recipient resolved only from `status='verified'`, `isPhantom=false` contact links with no name-matching fallback, an explicit YES confirm with a 5-minute TTL, and refusal on an empty month. The credit digest is once-daily-idempotent by a terminal `line_credit_digest_runs` row plus a deterministic per-(date, group) push retry key (`src/lib/line/credit-digest.ts:23-27`), and only reaches groups that opted in via `/credit setup`.
- Recommendations: two things to watch on the group paths. (1) The schedule bot's group confirm is **trust-on-first-use** — one mis-confirmed pairing becomes permanently silent. (2) `line_credit_digest` is `dangerous: true` in the registry yet is one of the seven keys whose manual Run-now 404s, so the only way to exercise it is the cron. Also, `LINE_SCHEDULE_BOT_ADMIN_IDS` is unvalidated free text (see `env.ts` above) — a typo disables the feature silently, which is the safe direction but produces a confusing "bot stopped working" report.

**LINE OA-resolver routes allow wildcard CORS (LOW):**
- Risk: both `worklist` and `runs/[runId]/rows` set `Access-Control-Allow-Origin: *`, so a browser extension on any origin can call them.
- Current mitigation: access is gated by an opaque per-run bearer resolver token (401 without it); the wildcard governs only which page may present the token.
- Recommendations: acceptable for the extension integration; restrict to the extension origin if feasible.

## Performance Bottlenecks

**Per-teacher leave stitching dominates Wise sync wall time (HIGH):**
- Problem: `fetchTeacherFullAvailability` stitches a **180-day horizon into 26 seven-day windows** per teacher (`src/lib/wise/fetchers.ts:61,67,89`). With ~130 teachers that is thousands of Wise calls per sync, throttled by the client's `maxConcurrency: 15` (`src/lib/wise/client.ts:219`; the default is 5, `client.ts:65`).
- Cause: no batch availability endpoint on Wise; the per-window fan-out is irreducible client-side.
- Mitigation in place: `maxDuration = 800` on the sync route, plus a single-flight guard that fails abandoned `running` rows after a stale timeout (`src/lib/sync/run-wise-sync.ts`).
- Improvement path: halve the horizon (180 → 90 days), negotiate a multi-window endpoint, or split fast working-hours from deferred leaves.

**The public schedule page fans one page view into ~34 institute-wide Wise fetches (MEDIUM, new):**
- Problem: see the Security entry above. `fetchInstituteSessionsForDays` issues one request per Bangkok day per status (two for today), and each is internally paginated (`src/lib/credit-control/wise.ts:212-227,236`); the result is only then filtered to the one student.
- Mitigation in place: 60s per-instance memo, 8s deadline, fail-soft to the snapshot.
- Improvement path: a per-student Wise session endpoint if Wise offers one; otherwise switch the public page to `liveSweep: "rescue"` and reserve `"always"` for the authenticated admin preview.

**Credit-control storage growth compounds every promote (MEDIUM):**
- Problem: nothing prunes `credit_control_snapshots` or its child tables (see Known Bugs). The promote statement itself is correctly bounded — `WHERE active = true OR id = $new` (`src/lib/credit-control/sync.ts:714-721`), matching REL-01 — so per-promote write cost is flat; total storage and index size are not.
- Improvement path: retention pruning; a small change with the largest storage payoff in the repo.

**`buildIndex` reloads the whole snapshot on every cold start (MEDIUM):**
- Problem: the in-memory index hangs off `globalThis` (`src/lib/search/index.ts:94-97`), surviving HMR and warm invocations but not cold serverless starts. Each cold instance re-runs the snapshot-wide `SELECT`s plus the tutor business-profile map.
- Mitigation in place: build-promise coalescing (see Fragile Areas) and a small dataset keep a cold build sub-second.
- Improvement path: persist a serialized index to JSONB if scale ever reaches thousands of tutors.

**Four connection paths to the same database (LOW):**
- Problem: the shared neon-http singleton (`src/lib/db/index.ts:22-27`) plus **three** independent `pg.Pool({ max: 1 })` instances — payroll (`src/lib/payroll/sync.ts:96`), post-class-feedback (`src/lib/post-class-feedback/transaction.ts:18`), and admissions audit (`src/lib/admissions/audit.ts:43-51`).
- Cause: neon-http lacks transactions; three features need them.
- Improvement path: acceptable at `max: 1` each, but the pools are per-instance and per-feature — monitor Neon connection counts if a payroll sync, a payout publish, and an admissions mutation ever coincide across several warm functions.

**O(n²) joins and overlap detection in the read path (LOW):**
- Problem: the `data_issues` → group join is O(issues × groups) (`src/lib/search/index.ts:232-240`); same-student conflict detection in compare is O(students × overlaps²); calendar overlap-column packing in the week overview is similarly nested.
- Improvement path: fine at current scale (tens of groups, ≤3 compared tutors). Sweepline only if per-day session counts exceed ~100.

## Fragile Areas

**Snapshot promotion atomicity plus the cached-index fallback must both hold (MEDIUM):**
- Files: `src/lib/sync/orchestrator.ts:480-499`, `src/lib/search/index.ts:365-390`.
- Why fragile: promotion is a **single** `UPDATE snapshots SET active = (id = $new) WHERE active = true OR id = $new` (REL-01) — MVCC guarantees readers never see zero active rows mid-promote, and the comment at `orchestrator.ts:481-487` explicitly calls out the bounded `WHERE` as replacing a prior two-UPDATE sequence. Separately, `ensureIndex` returns the cached index when no active snapshot is found (`index.ts:384-386`). Two independent mechanisms; if a refactor splits promotion back into two statements **or** removes the cached fallback, the "No active snapshot found" outage returns. Credit control has since copied the bounded form (`credit-control/sync.ts:707-721`) but not the pruning half — a reminder that lessons here propagate unevenly.
- Safe modification: keep promotion a single bounded statement; keep the cached fallback.
- Test coverage: `src/lib/sync/__tests__/orchestrator.integration.test.ts` exercises promotion against testcontainers Postgres. No test covers a read concurrent with a promotion.

**Build-promise coalescing depends on a synchronous assign-before-await (MEDIUM):**
- Files: `src/lib/search/index.ts:354-401`.
- Why fragile: `ensureIndex` (REL-02) checks the in-flight promise **first**, before any other work — the comment says this "MUST be checked before any other work so that a concurrent caller arriving during another caller's await will short-circuit here" (`index.ts:355-359`) — then builds the work closure and assigns the resulting promise to the `globalThis` singleton in the same tick. Correct as written, but moving the assignment after any `await` reintroduces the double-rebuild leak.
- Safe modification: preserve the "check in-flight first, then kick off work and assign the promise in the same tick" structure.
- Test coverage: `src/lib/search/__tests__/index.test.ts`.

**Writeback safety flags are read at two different lifetimes (MEDIUM):**
- Files: `src/lib/line/operational.ts:21` vs `src/lib/wise/operations.ts:11`.
- Why fragile: `operational.ts:21` captures `WISE_SESSION_OPERATIONS_VERIFIED` into a **module-scope `const` at import time**, while `wise/operations.ts:11` reads it per call. The same flag has two effective lifetimes: flipping it in Vercel takes effect immediately on the `wise/operations` path but only on a fresh instance for the LINE operational path. `src/lib/progress-tests/config.ts:50`, `src/lib/student-promotions/data.ts:450`, `src/lib/post-class-feedback/payout-config.ts:49-51`, and `resolveAutoApproveEnabled` (`payout-config.ts:164`) all use the per-call form.
- Safe modification: make all readers per-call functions; never capture a safety gate at module scope.
- Test coverage: module-scope capture is invisible to tests that set `process.env` in a `beforeEach`, so a test can pass while production is stale — precisely the failure this note exists to prevent.

**Unattended payout charging is one flag deep, with a date floor as the second wall (MEDIUM):**
- Files: `src/lib/post-class-feedback/payout-config.ts:150-205`, `payout-repository.ts:130-147`, `payout-retirement.ts:167-201`, `payout-accrual.ts:95-125`.
- Why fragile: post-INC-260829 the whole unattended pipeline — the approve sweep, the payout-candidate carve-out, and ledger retirement by row **deletion** — keys on the single string `POST_CLASS_AUTO_APPROVE_ENABLED === "true"`. The design is deliberate and well-commented: the candidate query normally excludes every `system:%` decision actor and admits exactly one carve-out while the flag is on (`payout-repository.ts:141-147`), and `PAYOUT_AUTO_CHARGE_FLOOR_BANGKOK = "2026-08-26"` walls off the incident backlog and the settled August ledger (`payout-config.ts:205`). Retirement no-ops entirely with the flag off (`payout-retirement.ts:180-182`) and stands down under a live publish lease.
- What to watch: the flag is unvalidated free text (see Tech Debt) and the floor is a hardcoded string constant, so the two walls guarding real money are a string comparison and a date literal. `runPayoutAccrualPass` also calls the auto-approval sweep **unconditionally at line 100**, before the retirement pass — the sweep does its own gating internally, so correctness rests on that inner check rather than the caller.
- Safe modification: keep the flag read per-call; keep the floor constant and its comment together; never widen the `system:%` carve-out beyond the one named actor.
- Test coverage: strongest in the repo — `auto-approval`, `payout-accrual`, `payout-repository`, `payout-retirement`, and `payout-run` all have testcontainers integration suites.

**The cron watchdog is the only unified failure signal and has three self-referential dependencies (MEDIUM):**
- Files: `src/lib/internal/cron-watchdog.ts:1-180` (528 lines total), `src/lib/data-health/cron-registry.ts`, `src/lib/data-health/cron-audit.ts`, `src/lib/post-class-feedback/payout-window-health.ts`.
- Why fragile: the watchdog sweeps every non-manual registry job, derives health from `cron_invocations` audit rows, and emails admins with episode dedup in `cron_alert_state`. Three coupled assumptions: (1) it excludes itself (`WATCHDOG_JOB_KEY`, `cron-watchdog.ts:40,167`) so it can never alert on its own flapping, and nothing else watches it; (2) it locks via a sentinel `cron_alert_state` row rather than a `*_sync_runs` guard, because "neon-http supports neither transactions nor session advisory locks" (`cron-watchdog.ts:42-46`) — a crashed sweep blocks alerts for up to 6 minutes; (3) it delivers via the Apps Script sender, so an Apps Script outage suppresses the alerts about itself. A deliberate partial-delivery tradeoff is documented at `cron-watchdog.ts:11-17`: if some recipients accept and others bounce, the episode is marked alerted and the bouncing addresses are only `console.error`-logged, never retried for that episode.
- Compounding: the 404-button bug above feeds **false failures** into this exact signal, and the spent July-1 cron feeds a permanent `late`/`unknown`. `ALERTABLE_STATUSES` covers all three (`cron-watchdog.ts:53`). Alert credibility is the thing at risk.
- Safe modification: keep the registry ↔ `vercel.json` parity test (`src/lib/data-health/__tests__/cron-registry.test.ts`) — it now asserts path, schedule, route-file existence, **and** `maxDurationSeconds` against each route's exported `maxDuration`, which is the single thing preventing the whole class of drift that produced the last audit's worst bug. Extend it next to "every `CronJobKey` has a `run-job.ts` branch".
- Test coverage: one test file for the whole 528-line module (`src/lib/internal/__tests__/cron-watchdog.test.ts`); the sweep-lock reclaim and partial-delivery paths are the ones to verify before changing.

**The payout finalize window rides the sweep as a synthetic job (MEDIUM):**
- Files: `src/lib/internal/cron-watchdog.ts:84-124`, `src/lib/post-class-feedback/payout-window-health.ts:26,50,98-102`.
- Why fragile: `PAYOUT_WINDOW_JOB_KEY = "post_class_payout_window"` is **not a cron route**. It is a fabricated `CronJobHealth` injected into the sweep so a window that never reached `published` gets episode dedup, the digest email, and a recovery notice for free — the comment states the gap "used to be completely silent" (`cron-watchdog.ts:85-89`). Its `path`, `schedule`, and `maxDurationSeconds` are all borrowed from the accrual job definition, and `loadPayoutWindowStaleness` returns `null` (no entry at all) if the accrual job ever loses its schedule (`payout-window-health.ts:102`).
- Compounding: because the synthetic key is not a `CronJobKey`, it cannot be looked up, run, or audited like a real job — it exists only inside one sweep. Flipping `post_class_feedback_payout_accrual` back to `manualOnly` would silently delete the entire finalize alarm.
- Safe modification: keep the loader's `try/catch` degradation ("never let the payout check take the watchdog down", `cron-watchdog.ts:128-132`); if the accrual job is ever unscheduled, give the window its own schedule source rather than inheriting a null.
- Test coverage: `classifyPayoutWindowStaleness` is pure and testable; the synthetic-entry injection path is covered only by the single watchdog test file.

**The parent-facing schedule depends on a lineage built for a different purpose (MEDIUM):**
- Files: `src/lib/student-schedule/data.ts:309-408`, `src/lib/credit-control/sync.ts`.
- Why fragile: `getStudentMonthlySchedule` reads `credit_control_snapshots` / `credit_control_students` / `credit_control_sessions` — a lineage whose sync cadence, failure modes, retention, and Wise fetch windows were designed for the at-risk-credit queue, not for showing a parent their child's month. A change to the credit-control fetch windows silently truncates the parent calendar. The comment correctly forbids a name-search fallback, so the failure mode is empty rather than wrong-student — good — but the coupling is undeclared on the credit-control side, and three other consumers (progress tests, student promotions, the LINE credit digest) have since joined it.
- Improved since the last audit: the payload now stamps the **snapshot's** `generatedAt` when the live sweep did not succeed, and only `new Date()` when it did (`data.ts:406`) — so the "updated {time}" footer on the public page is no longer unconditionally a lie.
- Safe modification: leave the read where it is (a second Wise lineage would be worse), but add a test asserting the month window fits inside the credit-control fetch horizon, and note the dependency in the credit-control feature doc.
- Test coverage: `src/lib/student-schedule/__tests__/` has 3 test files against 4 sources.

**`globalThis`-anchored singletons survive HMR but not cold starts (LOW):**
- Files: `src/lib/search/index.ts:94-97`, `src/lib/db/index.ts:16-27`, `src/lib/student-schedule/live.ts:37-46`.
- Why fragile: the search index, the DB client, and now the live-month session cache all hang off `globalThis.__bgscheduler_*`. Per-instance by construction; no guard against a bundler creating two module namespaces. The live cache is the newest and the one whose per-instance scope has a user-visible cost (see Performance).
- Test coverage: none for the singleton identity property.

**Multi-day leave coverage is a documented full-day assumption (LOW):**
- Files: `src/lib/search/engine.ts:251-268` (`hasRecurringLeaveConflict`, REL-04).
- Why fragile: a >24h leave blocks every weekday it touches in full-day form, with "no minute-of-day math" by explicit comment (`engine.ts:264-266`). Intentional — it replaced a genuine minute-math bug — but it over-blocks partial first/last days.
- Test coverage: `src/lib/normalization/__tests__/leaves.test.ts`, `src/lib/search/__tests__/engine.test.ts`.

## Scaling Limits

**Wise snapshot storage bounded by 30-snapshot retention (LOW):**
- Current capacity: `pruneOldSnapshots` runs after each successful promote and keeps `SNAPSHOT_RETENTION_COUNT = 30` (`src/lib/sync/snapshot-pruning.ts:5,51`), cascade-deleting older snapshots. `past_session_blocks` is deliberately cross-snapshot (D-04) and exempt.
- Limit: flat rather than monotonic growth. Pruning failures are caught, logged, and recorded in `sync_runs.metadata` without failing the sync.
- Scaling path: tune the retention count; pruning is idempotent.

**Credit-control storage is unbounded (HIGH — see Known Bugs):**
- Current capacity: no ceiling. 48 full snapshots/day, never pruned, in the highest-row-count lineage — now with five downstream consumers.
- Scaling path: port `pruneOldSnapshots`.

**Wise sync wall time vs the 800s function ceiling (MEDIUM):**
- Current capacity: ~130 teachers × 26 leave windows under `maxDuration = 800`.
- Limit: the 800s ceiling. Of the 43 routes that declare `maxDuration`, 30 use 800s, 12 use 300s, one uses 60s.
- Scaling path: horizon reduction or a Wise batch endpoint (see Performance Bottlenecks).

**Schema and route surface growth outpacing structural conventions (MEDIUM):**
- Current capacity: 189 tables and 61 enums in a **single 4,772-line `src/lib/db/schema.ts`**; 243 handlers across 180 route files; 36 `src/lib` domain modules; 101,993 lines of non-test `src/lib` source with five files over 1,900 lines (`ai/scheduler-conversation.ts` 2,828, `student-promotions/data.ts` 2,508, `post-class-feedback/payout-repository.ts` 2,484, `post-class-feedback/repository.ts` 2,180, `classrooms/data.ts` 1,933). On the component side, `components/scheduler/scheduler-workspace.tsx` is 2,366 lines across 168 non-test `.tsx` files.
- Limit: not runtime — editorial. A schema file this size makes cross-domain review impractical and `drizzle-kit generate` diffs hard to read, which is how the snapshot drift above went unnoticed.
- Scaling path: split `schema.ts` into per-domain files re-exported from one barrel (the sanctioned barrel exception already exists for `import * as schema`), and set a soft line-count ceiling on `lib` modules.

**In-memory index size (LOW):**
- Current capacity: tens of groups × windows × sessions — single-digit MB serialized.
- Scaling path: a concern only at 10,000+ tutors.

**Per-instance caches grow within their own bounds (LOW):**
- Current capacity: the live-month session cache caps at 500 entries and prunes expired ones past that threshold (`src/lib/student-schedule/live.ts:29,53-58`) — the comment correctly notes that TTL alone "only stops a stale entry being *served*". The client-side compare cache in `src/hooks/use-compare.ts` has **no** size cap; entries accumulate as the user pages weeks, invalidated only on a version change.
- Scaling path: LRU eviction at ~50 entries for the compare cache.

## Dependencies at Risk

**`next-auth: 5.0.0-beta.30` (HIGH):**
- Risk: exact-pinned Auth.js v5 beta. Betas carry breaking changes between releases; no LTS.
- Impact: auth is split across `src/lib/auth.ts` (Node) and `src/lib/auth-edge.ts` (edge middleware), with a custom `resolveUserAccess` callback, JWT `allowedPages`/`role` claims consumed by `src/middleware.ts`, a Google Sheets/Drive OAuth scope, and a `signIn` callback that stores per-user Google OAuth tokens (`auth.ts:50-57`). A beta bump could touch any of these — and the two provider configs already disagree (see Security).
- Migration plan: stay pinned; upgrade to v5 GA in a dedicated phase, re-testing the edge/node split, role resolution order, the token-storage callback, and the sheets scope.

**No `openai` SDK despite eight raw Responses-API call sites (MEDIUM):**
- Risk: there is no `openai` package in `package.json`; seven modules call `https://api.openai.com/v1/responses` over raw `fetch` from eight sites — `ai/scheduler.ts:544`, `ai/scheduler-conversation.ts:2346`, `line/classifier.ts:98`, `line/contact-aliases.ts:368`, `progress-tests/ai-summary.ts:185`, `competitor-intelligence/ai.ts:161,300`, `post-class-feedback/ai.ts:62`. The model selectors are unvalidated free-text env.
- Impact: contract drift (model names, response envelope, reasoning-effort params) is caught only at runtime as a 4xx/5xx, in eight places rather than one. Feature gating is also inconsistent — `ENABLE_AI_SCHEDULER !== "false"` gates both the AI scheduler and progress-test summaries (`ai/scheduler.ts:478,540`; `progress-tests/ai-summary.ts:77`), competitor intel has its own `ENABLE_COMPETITOR_AI` (`competitor-intelligence/ai.ts:71`), and the LINE and post-class paths have neither.
- Migration plan: adopt the official SDK, or add one shared typed client plus a Zod contract test against a recorded fixture.

**Two unvendored paid data providers behind estimated budgets (MEDIUM):**
- Risk: competitor intelligence calls Apify and DataForSEO directly with no SDK and self-estimated per-item cost.
- Impact: see the Known Bugs entries — an unset cap defaults to $250/month against guessed unit prices, a cap of `0` disables enforcement entirely, and the bucket rolls over on a UTC month boundary.
- Migration plan: set caps explicitly; fix the zero-cap semantics; reconcile against provider billing.

**`@base-ui/react: 1.3.0` (MEDIUM):**
- Risk: exact-pinned 1.x of a young primitives library underpinning the shadcn primitives in `src/components/ui/`, which in turn back the other ~150 feature components (168 non-test `.tsx` files under `src/components/`).
- Migration plan: stay pinned; monitor the changelog.

**`drizzle-orm: 0.45.2` / `zod: ^4.3.6` / `xlsx: ^0.18.5` (LOW):**
- Risk: `drizzle-orm` is exact-pinned pre-1.0 and **its error strings are load-bearing** in the three transaction fallbacks (see Tech Debt). `zod` v4 peer support across the ecosystem is still maturing. `xlsx` 0.18.5 is the last npm-published SheetJS release and parses untrusted uploaded workbooks in the sales-dashboard import path.
- Migration plan: run migrations against the testcontainers integration suite before upgrading Drizzle; treat any `xlsx` advisory as high priority given it consumes user-supplied files.

## Missing Critical Features

**Seven registered jobs have no manual actuator (HIGH):**
- Problem: `run-job.ts` handles 15 of 22 `CronJobKey`s. The seven without a branch include two whose only other trigger is a cron on a long cadence — `student_promotions_july_1` (annual) and `line_credit_digest` (daily, `dangerous: true`) — and `admissions_notifications` and `progress_tests_digest`, both daily and both `dangerous`. When one of those fails overnight, there is no way to re-run it from the app.
- Approach: add the missing branches (mechanical — each is a one-line call to an already-exported runner), then assert `CronJobKey` ↔ `run-job.ts` branch parity in `cron-registry.test.ts`, which already reads route files as text for exactly this kind of structural check.

**Three post-class tutor-facing notification jobs remain parked (MEDIUM):**
- Problem: `post_class_feedback_digest`, `post_class_feedback_day_after`, and `post_class_feedback_deadline` are all `schedule: null, manualOnly: true, dangerous: true` (`cron-registry.ts:193-233`), while the fourth of the group — payout accrual — was re-armed to an hourly cron (`33 * * * *`). The reminder loop is the only part of the notification design still unscheduled.
- Approach: decide whether the reminder loop is shipping or being retired. Registered-but-parked dangerous jobs are the state most likely to be run by accident from the Data Health job list — the `dangerous` + `confirmed: true` gate plus the `access_manager` capability check (`src/app/api/data-health/jobs/[jobKey]/run/route.ts:25-41`) is the only thing between a curious admin and an outbound tutor email blast. Note these three *do* have `run-job.ts` branches, so unlike the seven above they are genuinely one click away.

**Room-utilization and LINE-backlog refresh have no schedule (LOW):**
- Problem: `/api/internal/sync-room-utilization` and `/api/internal/line-backlog-recovery` are registered `manualOnly: true` (`cron-registry.ts:370-395`). Room utilization is genuinely invocable — it has a `run-job.ts` branch (`run-job.ts:197`), a "Sync" button in the room-capacity dashboard, an `npm run room-utilization:sync` script, and a registry test asserting it stays out of the scheduled set. LINE backlog recovery has **no** `run-job.ts` branch, so it is manual-only in name and unreachable in practice from Data Health.
- Approach: room-capacity data drifts between manual refreshes — either add a low-frequency cron or state the manual cadence in the runbook. For LINE backlog recovery, add the branch or drop the button.

**Non-Wise lineage staleness is not surfaced to end users (MEDIUM):**
- Problem: the Wise snapshot path has a user-visible staleness ladder — a 90-minute API warning and a 2-hour app-wide banner (`src/lib/ops/stale.ts:1-17`). The other lineages have health only inside Data Health and the watchdog's admin email. A sales, credit-control, or leave-requests user sees no in-page indication that their numbers are hours old.
- Partially addressed for the parent schedule, which now reports the snapshot's real `generatedAt` when the live sweep did not land (`student-schedule/data.ts:406`) — but it still shows no explicit "this is N hours old" notice past a threshold.
- Approach: reuse the `StaleSnapshotBanner` pattern per feature, driven by the existing cron health derivation, and add a staleness threshold to the public schedule footer.

## Test Coverage Gaps

> Counts: 389 test files — 320 `.test.ts` (of which 13 are `.integration.test.ts`)
> and 69 `.test.tsx`. `npm test` runs the `unit` project only;
> `npm run test:integration` runs the testcontainers Postgres suite
> (`vitest.config.ts:35-48`, `fileParallelism: false`, `maxWorkers: 1`).
> Coverage config excludes `src/app/**/*.tsx` outright (`vitest.config.ts:13-22`),
> so page-level Server Components are never measured. Distribution is heavily
> skewed: `post-class-feedback` has 38 test files against 40 sources (including
> 10 of the 13 integration suites); `line` has 24/24 and `admissions` 21/31 —
> while eight `src/lib` modules have exactly one test file and `src/hooks` has
> none.

**Integration coverage is concentrated in one feature (MEDIUM):**
- What's not tested: 10 of 13 integration suites are post-class-feedback; the other 3 are all sync (`orchestrator`, `past-sessions-diff-hook`, `snapshot-pruning`). Nothing exercises admissions case-access enforcement, payroll writes, LINE webhook→review persistence, credit-control snapshot promotion, or leave-requests sync against a real Postgres.
- Files: `src/lib/*/__tests__/*.integration.test.ts`.
- Risk: the transaction-fallback and advisory-lock behaviour in Fragile Areas is exercised only for post-class-feedback. Payroll's identical fallback (`src/lib/payroll/sync.ts:89-124`) and the new admissions one (`src/lib/admissions/audit.ts:86-110`) have no integration test at all — and the admissions path is the one that guarantees a mutation and its audit row commit together.
- Priority: MEDIUM.

**Nothing asserts `CronJobKey` ↔ `run-job.ts` branch parity (MEDIUM):**
- What's not tested: `cron-registry.test.ts` now covers path, schedule, route-file existence, and `maxDurationSeconds` — four assertions where the last audit found two, and the `maxDuration` one closed that audit's worst bug. The remaining gap is structural in exactly the same way: nothing asserts that every registry key has a dispatch branch, which is how seven 404 buttons survive.
- Risk: the highest-impact Known Bug in this audit is a single missing assertion in an already-existing, already-text-parsing test file.
- Priority: MEDIUM — cheap, high-yield.

**Hooks are entirely untested (MEDIUM):**
- What's not tested: `src/hooks/` contains five hooks (`use-compare`, `use-keyboard-shortcuts`, `use-resizable-split`, `use-sales-dimensions`, `use-theme`) and **zero** test files. `use-compare.ts` holds the AbortController cancellation, the incremental `fetchOnly` cache merge, cache-version invalidation, and per-tutor eviction.
- Risk: race-condition and cache-invalidation logic is unverified even though 69 component `.test.tsx` files exist.
- Priority: MEDIUM.

**Thin modules with a single test file (MEDIUM for two, LOW for the rest):**
- What's not tested proportionally: `src/lib/internal` (2 sources including the 528-line cron watchdog, 1 test), `src/lib/proposals` (3/1), `src/lib/ui` (2/1), `src/lib/scheduler` (1/1), `src/lib/ops` (1/1), `src/lib/navigation` (1/1), `src/lib/home` (1/1), `src/lib/calendar` (1/1), `src/lib/syllabus` (4/2), `src/lib/student-promotions` (3/2 — for a module that performs verified Wise writes), `src/lib/student-schedule` (4/3), `src/lib/credit-control` (19/7). `src/lib/db` has none (schema + seed only, which is reasonable).
- Risk: the cron watchdog is the repo's only unified failure signal and carries sweep-lock reclaim, episode dedup, the synthetic payout-window entry, and partial-delivery logic behind one test file. Credit control at 19 sources / 7 tests is the weakest ratio among the load-bearing lineages, and it is the one whose bugs reach a parent-facing page.
- Priority: MEDIUM for `internal/cron-watchdog` and `credit-control`; LOW for the rest.

**Env/config degradation paths (LOW individually, MEDIUM in aggregate):**
- What's not tested: that a missing `OPENAI_API_KEY`, `RESEND_API_KEY`, `SCHEDULE_EMAIL_*`, or `POST_CLASS_PAYOUT_*` var degrades to a 503/disabled state rather than 500-ing deep in a handler. Nor that a mistyped `WISE_SESSION_*_VERIFIED` or `POST_CLASS_PAYOUT_WRITES_ENABLED` value fails closed (it does, by `=== "true"`, but nothing asserts it — `resolveAutoApproveEnabled` and `resolveAutoApproveGraceHours` are the only two gates with parsing tests). Nor — most simply — that `src/lib/env.ts` is imported by anything, which would have caught the orphan module immediately.
- Priority: MEDIUM in aggregate given 47 unvalidated vars.

**Public capability-token invariants (LOW but high-consequence):**
- What's not tested: that `/schedule/[token]` renders one identical response for all four failure modes. The source comment says "do not branch this" (`src/app/schedule/[token]/page.tsx:105`), which is the right instinct, but `src/app/**/*.tsx` is excluded from coverage entirely and the invariant has no assertion. Nor is there a test that the public page's live sweep stays fail-soft — the one thing standing between a Wise outage and a blank parent page.
- Priority: LOW frequency, high consequence — this is the app's only unauthenticated data surface.

## Resolved Since Last Audit

The following prior concerns are FIXED in current code and retained so the delta
is auditable.

- **Credit-control snapshot promotion rewrote the whole table (was HIGH) — RESOLVED.** The promote now carries the bounded `WHERE active = true OR id = $new` with the REL-01 rationale copied into the comment (`src/lib/credit-control/sync.ts:707-721`). The pruning half is still missing (retained above).
- **Credit-control healthy runs classified as failing (was HIGH) — RESOLVED.** The registry now declares `maxDurationSeconds: 800` for `credit_control` (`cron-registry.ts:122`), matching the route. More importantly the class of bug is closed: `cron-registry.test.ts` now reads each registry entry's route file as text and asserts the exported `maxDuration` matches, with a comment explaining why (`"a value below the route's own maxDuration reports a legitimate long run as failing"`). Verified: all 22 entries agree.
- **The parent schedule stamped render time as "last updated" (was MEDIUM) — RESOLVED.** `generatedAt` is now `live.ok ? new Date() : snapshot.generatedAt` (`src/lib/student-schedule/data.ts:406`), so the footer reports the snapshot's real age whenever the live overlay did not land.
- **Payout accrual was a parked manual-only job whose actuator 404'd (was MEDIUM/HIGH) — RESOLVED.** It is an armed hourly cron (`33 * * * *`) in both `vercel.json` and the registry, and it has a `run-job.ts` branch (`run-job.ts:141`). The registry comment records the re-arming and the flag that governs it.
- **Uncommitted `leave-requests` WIP (was MEDIUM) — RESOLVED.** `git ls-files src/lib/leave-requests` returns 9 tracked files including 4 tests; the feature has a page, API routes, and a `15,45 * * * *` cron. `git status --short src/` is empty at this revision — no untracked source exists anywhere in the tree.
- **Orphan `sync-room-utilization` handler (was MEDIUM) — RESOLVED, downgraded to a missing-schedule note.** It is a first-class `manualOnly: true` registry entry (`cron-registry.ts:370-380`) with a `run-job.ts` branch, a dashboard button, an npm script, and a registry test asserting it stays out of `vercel.json`.
- **No unified "any sync is failing" signal (was MEDIUM) — RESOLVED.** The `cron_watchdog` cron (`7,37 * * * *`) sweeps every non-manual registered job, derives status from `cron_invocations`, prunes old invocations, and emails admins with episode dedup. Its credibility is now the concern, not its existence.
- **Cron drift between code and `vercel.json` (guard).** `SCHEDULED_CRON_JOBS` is asserted equal to `vercel.json`'s `crons` array by path and schedule; 17 scheduled jobs match 17 `vercel.json` entries, and a fourth assertion verifies every registry entry points at a real route file.
- **Zero `TODO`/`FIXME`/`HACK` markers — still holds** across all of `src/`, tests included (`grep -rn "TODO\|FIXME\|HACK" src` returns nothing outside tests).
- **Route surface regressions (guard).** `npm run guard:production-route-surface` diffs the discovered `page.tsx`/`route.ts` surface against `docs/reference/production-route-surface.json` (211 source routes, 9 critical) and fails on shrinkage or a missing critical route. **Verified passing at this revision** (`Production route surface passed: 211 source routes present`). It runs inside `verify:release`, which `deploy:prod` runs before `assert-production-deploy-ready.mjs` (branch + clean tree + `HEAD == origin/main`).
- **Non-atomic snapshot promotion, index-rebuild promise leak, zero-active-snapshot 500, non-constant-time `CRON_SECRET`, 4xx retry, multi-day leave minute math, past-day fallback showing future occurrences, missing Wise snapshot retention** — all remain fixed (REL-01…REL-07, D-05, `snapshot-pruning.ts`).

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
