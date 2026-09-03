# Data Health API

**Status: stable** (handbook maturity map; no `@deprecated` or status marker exists in code). Feature meaning — why the ops command center exists, what each status word means operationally, the alerting philosophy — lives in [docs/features/data-health.md](../../features/data-health.md). Column-level detail for `cron_invocations` and `cron_alert_state` lives in [docs/reference/database/erd-core.md](../database/erd-core.md); the schedule table and the mechanics shared by every cron route live in [docs/reference/crons.md](../crons.md). **This page owns the mechanics** of the Data Health surface: method, path, auth, request shape, response shape, side effects, and status codes.

**Authoritative source:** the two handlers under [`src/app/api/data-health/`](../../../src/app/api/data-health/), the watchdog route [`src/app/api/internal/cron-watchdog/route.ts`](../../../src/app/api/internal/cron-watchdog/route.ts), and the four libs they delegate to — [`dashboard.ts`](../../../src/lib/data-health/dashboard.ts) (1,019 lines), [`cron-registry.ts`](../../../src/lib/data-health/cron-registry.ts), [`run-job.ts`](../../../src/lib/data-health/run-job.ts), and [`src/lib/internal/cron-watchdog.ts`](../../../src/lib/internal/cron-watchdog.ts).

## Endpoint index (4)

Two admin endpoints under `/api/data-health`, plus the two methods of the watchdog cron that runs the same health derivation on a schedule.

| Method | Path | Auth | Writes | Handler |
|--------|------|------|--------|---------|
| GET | `/api/data-health` | session | none | [`route.ts:14-26`](../../../src/app/api/data-health/route.ts) |
| POST | `/api/data-health/jobs/[jobKey]/run` | session **with `user.email`** (+ `access_manager` for post-class jobs) | `cron_invocations` row, plus whatever the dispatched job writes | [`jobs/[jobKey]/run/route.ts:13-44`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts) |
| GET | `/api/internal/cron-watchdog` | `CRON_SECRET` | `cron_alert_state`, `cron_invocations` (write + prune), outbound email | [`cron-watchdog/route.ts:28-30`](../../../src/app/api/internal/cron-watchdog/route.ts) |
| POST | `/api/internal/cron-watchdog` | `CRON_SECRET` | same as `GET` | [`cron-watchdog/route.ts:32-34`](../../../src/app/api/internal/cron-watchdog/route.ts) |

In-repo callers: `GET /api/data-health` is fetched by the dashboard's Refresh button ([`data-health-dashboard.tsx:453`](../../../src/components/data-health/data-health-dashboard.tsx)) and by the stale-snapshot banner, which reads only `staleAgeMs` ([`stale-snapshot-banner.tsx:58-66`](../../../src/components/layout/stale-snapshot-banner.tsx)). The job runner is called from the same dashboard ([`:481-485`](../../../src/components/data-health/data-health-dashboard.tsx)). The `/data-health` page itself does **not** call the API — it awaits `getDataHealthDashboardPayload()` server-side and passes the result as `initialData` ([`(app)/data-health/page.tsx:7-13`](../../../src/app/%28app%29/data-health/page.tsx)).

---

## Conventions shared by these endpoints

**No Zod.** None of the three route files import `zod`. `GET /api/data-health` and both watchdog methods take no input at all; the job runner reads its body with `await request.json().catch(() => ({}))` and narrows it by an inline TypeScript cast to `{ confirmed?: boolean }` ([`run/route.ts:32`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)) — a compile-time assertion only. A malformed or absent body therefore never returns 400; it degrades to `{}` and fails the confirmation gate instead.

**Auth is two-tier.** `/api/data-health/**` uses `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts): the GET tests `!session` ([`route.ts:15-18`](../../../src/app/api/data-health/route.ts)), the job runner tests `!session?.user?.email` because it stamps the actor onto the audit row ([`run/route.ts:14-17`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)). Both return `401 {"error":"Unauthorized"}`. There is no role model — any signed-in user who reaches the job runner can trigger any job the runner implements, subject only to the post-class capability gate and the `dangerous` confirmation gate below. `/api/internal/cron-watchdog` is the opposite: `CRON_SECRET` only, no session fallback.

**Middleware.** `/api/data-health/**` is not in the public allowlist ([`middleware.ts:10-25`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`:89-92`](../../../src/middleware.ts)). A restricted user (non-null `allowedPages` with no entry prefix-matching `/data-health`) gets a middleware-level `403 {"error":"Forbidden"}`, because `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`:36-66`](../../../src/middleware.ts), [`:97-99`](../../../src/middleware.ts)). `/api/internal/*` **is** in the public allowlist ([`:24`](../../../src/middleware.ts)), so the watchdog's only gate is the secret its handler checks.

**Cron secret comparison is constant-time.** `rejectInvalidCronSecret` builds `Bearer ${CRON_SECRET}`, pre-checks length, then `timingSafeEqual`s it against the `authorization` header ([`cron-auth.ts:6-26`](../../../src/lib/internal/cron-auth.ts)). A **missing** `CRON_SECRET` env var returns `500 {"error":"Server misconfigured"}`, not 401 — a deploy-time misconfiguration is distinguishable from a bad caller.

**No caching.** None of the three files declares `"use cache"`, `revalidate`, or `dynamic`. Every request reads Postgres directly. `maxDuration` is set per route: `800` on the job runner ([`run/route.ts:11`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)) so a manually triggered full Wise sync survives, `300` on the watchdog ([`cron-watchdog/route.ts:7`](../../../src/app/api/internal/cron-watchdog/route.ts)); `GET /api/data-health` sets none.

**Both write endpoints are audit-wrapped.** The job runner and the watchdog wrap their work in `withCronInvocationAudit` ([`cron-audit.ts:191-206`](../../../src/lib/data-health/cron-audit.ts)), which inserts a `cron_invocations` row with `outcome: "running"` before the handler and stamps `finishedAt` / `durationMs` / `responseStatus` / `errorSummary` / `linkedRunIds` / a size-capped `metadata.response` digest afterwards. The job runner passes `triggerSource: "admin"` and the caller's email ([`run-job.ts:35-41`](../../../src/lib/data-health/run-job.ts)); the watchdog passes `triggerSource: "cron"` and the actual request method ([`cron-watchdog/route.ts:13-14`](../../../src/app/api/internal/cron-watchdog/route.ts)), so a `POST` sweep is recorded as a `POST`. Full wrapper semantics — including the rule that `already running` in an error body is audited as `skipped` rather than `failed` — are in [internal-crons.md](./internal-crons.md).

---

## Reading the dashboard

### `GET /api/data-health`

Returns the whole ops payload in one object. Read-only: no writes, no Wise calls, no email. Handler [`route.ts:14-26`](../../../src/app/api/data-health/route.ts), delegating entirely to `getDataHealthDashboardPayload()` ([`dashboard.ts:899-1015`](../../../src/lib/data-health/dashboard.ts)).

**Auth:** session required — `if (!session)` → `401 {"error":"Unauthorized"}` ([`route.ts:15-18`](../../../src/app/api/data-health/route.ts)).

**Query / body:** none. The handler signature takes no `request` argument at all ([`route.ts:14`](../../../src/app/api/data-health/route.ts)); query parameters are ignored. The `now` used for every freshness and lateness computation is the lib default `new Date()` ([`dashboard.ts:899`](../../../src/lib/data-health/dashboard.ts)) — not client-settable.

**Response `200`:** `DataHealthDashboardPayload` verbatim, no wrapper key. Declared at [`types.ts:107-152`](../../../src/lib/data-health/types.ts):

| Key | Type | Notes |
|-----|------|-------|
| `checkedAt` | ISO string | `now.toISOString()` — when the payload was assembled. |
| `overall` | object | `status`, `headline`, `detail`, and six counts (`healthyCount`, `lateCount`, `failingCount`, `runningCount`, `unknownCount`, `manualOnlyCount`). Roll-up rule at [`dashboard.ts:856-886`](../../../src/lib/data-health/dashboard.ts): the worst status among **non-manual-only** jobs wins by `statusRank` ([`cron-registry.ts:407-414`](../../../src/lib/data-health/cron-registry.ts)), and an all-`unknown` sweep with at least one healthy job reports `healthy`. |
| `cronJobs` | `CronJobHealth[]` | One entry per registry job, in registry order — **22** at this revision ([`cron-registry.ts:47-399`](../../../src/lib/data-health/cron-registry.ts)). Shape at [`types.ts:28-54`](../../../src/lib/data-health/types.ts). |
| `dataDomains` | `DataDomainHealth[]` | **9** freshness cards, hard-coded in order: `wise_snapshot`, `wise_activity`, `post_class_feedback`, `sales_dashboard`, `competitor_intelligence`, `credit_control`, `leave_requests`, `class_assignments`, `room_utilization` ([`dashboard.ts:483-593`](../../../src/lib/data-health/dashboard.ts)). |
| `wiseSnapshot` | object | `activeSnapshotId`, `lastSuccessfulSync`, `lastFailedSync`, `lastFailureError`, `staleAgeMs`, `staleMinutes`, `stats` (nine snapshot counters, or `null` when no `snapshot_stats` row exists). |
| `issueSummary` | `Record<string, number>` | `snapshot_stats.issuesByType` for the active snapshot, `{}` when absent. |
| `issueDetails` | object | `unresolvedAliases`, `unresolvedModality`, `unmappedTags` — every `data_issues` row for the active snapshot, partitioned by `type` ([`dashboard.ts:413-430`](../../../src/lib/data-health/dashboard.ts)). Not paginated or capped. |
| `recentRuns` | `RunHistoryItem[]` | Eleven domain run tables flattened into one list, sorted by `startedAt` desc and **sliced to 30** ([`dashboard.ts:620-750`](../../../src/lib/data-health/dashboard.ts)). |
| `manualActions` | array | `{ key, label, dangerous, confirmationLabel }` for all 22 registry jobs ([`dashboard.ts:989-994`](../../../src/lib/data-health/dashboard.ts)) — the client uses this to decide whether to prompt before calling the job runner. |
| *compatibility block* | — | `lastSuccessfulSync`, `lastFailedSync`, `lastFailureError`, `staleAgeMs`, `staleMinutes`, `activeSnapshotId`, `stats`, `issuesByType`, `unresolvedAliases`, `unresolvedModality`, `unmappedTags`, `recentSyncs` are duplicated at the top level for the stale banner and older callers ([`types.ts:132-151`](../../../src/lib/data-health/types.ts)). `recentSyncs` is the last 8 `sync_runs` rows. |

**`unresolvedModality` includes two issue types.** Both the payload builder and the route's re-exported helper filter `type === "modality" || type === "conflict_model"` — group-level modality issues from `deriveModality` plus session-level conflicts from `detectSessionModalityConflict`, surfaced as one admin-facing number (MOD-03 / D-10, [`modality-counter.ts:1-31`](../../../src/app/api/data-health/modality-counter.ts)). The helper lives in its own module so Vitest can import it without pulling the Next/`next-auth` route graph; `route.ts:6-12` re-exports it as `selectModalityIssues`.

**How a job's `status` is derived.** `evaluateCronJobStatus` ([`status.ts:194-363`](../../../src/lib/data-health/status.ts)) resolves each job against two evidence kinds and returns one of six statuses, in this order:

| Order | Status | Condition | `healthDetail` |
|---|---|---|---|
| 1 | `manual-only` | `job.manualOnly` — returns before any lateness logic, so a parked job is never reported late ([`:199-216`](../../../src/lib/data-health/status.ts)) | `Not listed in vercel.json; runs only from manual controls.` |
| 2 | `failing` | a run has been in flight longer than `maxDurationSeconds + 60s` ([`:242-258`](../../../src/lib/data-health/status.ts)) | `Running longer than {n}s maxDuration.` |
| 3 | `running` | a run is in flight and not yet stuck | `A run is currently in progress.` |
| 4 | `unknown` | `proof === "none"` — neither a `cron_invocations` row nor a run-table row | `No invocation or run-table evidence found.` |
| 5 | `failing` | latest failure is newer than latest success | `Latest observed run failed after the latest success.` |
| 6 | `late` | interval evidence older than `lateAfterMinutes`, or the last expected calendar window passed unseen | `No observed run for the latest expected schedule window.` |
| 7 | `healthy` | none of the above | direct vs inferred wording |

`proof` is `direct` when a `triggerSource: "cron"` invocation row exists, `inferred` when only the job's own run table has evidence, `none` otherwise ([`status.ts:218-220`](../../../src/lib/data-health/status.ts)). Note `latestCronInvocation` filters on `triggerSource === "cron"` ([`dashboard.ts:439`](../../../src/lib/data-health/dashboard.ts)) — a manual run from this page is **not** direct proof that the schedule fired, though it does appear in `latestInvocation` and `recentInvocations`.

**Query volume.** One read each for the latest successful sync run, the latest failed sync run, and the active snapshot; then conditionally `snapshot_stats` and all `data_issues` for that snapshot; then the invocation window; then 14 parallel run-table reads ([`dashboard.ts:752-806`](../../../src/lib/data-health/dashboard.ts)), each `LIMIT 8` except `postClassNotifications` (32) and `roomUtilization` (1). The invocation read is a `row_number()` window partitioned by `job_key`, capped at `INVOCATIONS_PER_JOB = 8` per job over a 45-day lookback ([`dashboard.ts:828-854`](../../../src/lib/data-health/dashboard.ts)) — per-job, not global, so a 30-minute job cannot push a daily job's only proof out of the window.

**Degradation, not failure.** If `cron_invocations` does not exist, `fetchCronInvocations` catches the error, logs `console.info`, and returns `[]`, so the dashboard falls back to run-table inference instead of 500-ing ([`dashboard.ts:846-851`](../../../src/lib/data-health/dashboard.ts)). Any other error propagates to the route's catch.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Payload returned. An empty database is still 200 — `activeSnapshotId: null`, `stats: null`, empty arrays. |
| 401 | No session ([`route.ts:16-18`](../../../src/app/api/data-health/route.ts)). |
| 403 | Middleware, not the handler: restricted user whose `allowedPages` does not cover `/data-health`. |
| 500 | Any thrown error; body `{"error": <message>}`, or `"Data health failed"` for a non-`Error` throw ([`route.ts:22-25`](../../../src/app/api/data-health/route.ts)). |

---

## Running one job manually

### `POST /api/data-health/jobs/[jobKey]/run`

Runs one registered job now, **in-process** — it calls the job's lib function directly rather than issuing an HTTP request to that job's cron route ([`run-job.ts:29-209`](../../../src/lib/data-health/run-job.ts)). Handler [`run/route.ts:13-44`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts). `export const maxDuration = 800` ([`:11`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)).

**Path parameter:** `jobKey` — one of the 22 `CronJobKey` values ([`cron-registry.ts:3-25`](../../../src/lib/data-health/cron-registry.ts)), resolved via `getCronJobDefinition` ([`:403-405`](../../../src/lib/data-health/cron-registry.ts)). `context.params` is a `Promise` and is awaited ([`run/route.ts:19`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)).

**Body** (JSON; a missing or unparseable body degrades to `{}`):

| Field | Type | Required | Effect |
|-------|------|----------|--------|
| `confirmed` | boolean | only for `dangerous` jobs | Must be **exactly** `true` (`body.confirmed !== true`) or the request is rejected with 409 ([`run/route.ts:33-41`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)). Ignored for non-dangerous jobs. |

No other field is read. The client always sends `{ confirmed: action.dangerous }`, having already shown a `window.confirm` with the registry's `confirmationLabel` ([`data-health-dashboard.tsx:470-485`](../../../src/components/data-health/data-health-dashboard.tsx)).

**Gate ladder,** in handler order — each gate returns before the next runs:

1. `!session?.user?.email` → **401** `{"error":"Unauthorized"}` ([`:14-17`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)).
2. `jobKey` not in the registry → **404** `{"error":"Unknown job"}` ([`:20-23`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)). This fires **before** the audit wrapper, so an unknown key writes no `cron_invocations` row.
3. `job.key.startsWith("post_class_feedback")` and the caller's fresh capabilities do not include `access_manager` → **403** `{"error":"Access manager capability required"}` ([`:25-30`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)). Capabilities are read per request from `post_class_access_grants` joined to `admin_users` on a case- and whitespace-insensitive email match ([`access.ts:129-146`](../../../src/lib/post-class-feedback/access.ts)); the four capability values are `viewer`, `reviewer`, `finance`, `access_manager` ([`access.ts:11-16`](../../../src/lib/post-class-feedback/access.ts)). Six registry keys match this prefix: `post_class_feedback`, `_backfill`, `_digest`, `_day_after`, `_deadline`, `_payout_accrual`.
4. `job.dangerous` and `confirmed !== true` → **409** `{"error":"Confirmation required","confirmationLabel": <registry label>}` ([`:33-41`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)).
5. Otherwise `runDataHealthJob(job.key, session.user.email)` ([`:43`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)).

Because the capability gate precedes the confirmation gate, a non-manager asking for a dangerous post-class job sees 403, never 409.

**The registry, and which keys the runner actually implements.** All 22 keys pass gate 2 and reach `runDataHealthJob`, but the dispatcher implements **15**; the other **7** fall through to a terminal `404 {"error":"Unknown job"}` ([`run-job.ts:207`](../../../src/lib/data-health/run-job.ts)) — *inside* the audit wrapper, so those attempts do leave a failed `cron_invocations` row. For those seven, a direct `CRON_SECRET` call to the cron route is the only manual path.

| Job key | Schedule | `dangerous` | Runner branch | Success body |
|---|---|:---:|:---:|---|
| `wise_snapshot` | `*/30 * * * *` | — | yes | full sync result + `staleRunningSyncsFailed`; `202` when a run is already in flight ([`run-wise-sync.ts:142-167`](../../../src/lib/sync/run-wise-sync.ts)) |
| `wise_activity` | `2,17,32,47 * * * *` | — | yes | `{ok:true, result}`; `409` on `WiseActivitySyncAlreadyRunningError` ([`run-job.ts:47-63`](../../../src/lib/data-health/run-job.ts)) |
| `sales_dashboard` | `10,40 * * * *` | — | yes | `{ok:true, results, projectionResult}` — refreshable sources **and** the active projection source ([`run-job.ts:65-80`](../../../src/lib/data-health/run-job.ts)) |
| `competitor_intelligence` | `28 18 * * 0` | — | yes | `{ok, result}`; status `200`/`500` from `result.status`, `409` when the message contains `already running` ([`run-job.ts:82-98`](../../../src/lib/data-health/run-job.ts)) |
| `credit_control` | `20,50 * * * *` | — | yes | sync result + `syncRunId` + `staleRunningSyncsFailed`; `202` when already running ([`run-sync-request.ts:138-160`](../../../src/lib/credit-control/run-sync-request.ts)) |
| `progress_tests` | `25,55 * * * *` | — | **no → 404** | — |
| `progress_tests_digest` | `35 0 * * *` | — | **no → 404** | — |
| `post_class_feedback` | `13,43 * * * *` | — | yes | `{ok:true, result, retries}` — the sync **plus** due notification retries ([`run-job.ts:104-119`](../../../src/lib/data-health/run-job.ts)) |
| `post_class_feedback_backfill` | `23,53 * * * *` | — | **no → 404** | — |
| `post_class_feedback_digest` | manual-only | yes | yes | `{ok:true, result}` ([`run-job.ts:121-124`](../../../src/lib/data-health/run-job.ts)) |
| `post_class_feedback_day_after` | manual-only | yes | yes | `{ok:true, result}`, or **503** `{ok:false, error, result}` when the checkpoint still has unreconciled Wise sessions ([`run-job.ts:126-139`](../../../src/lib/data-health/run-job.ts)) |
| `post_class_feedback_deadline` | manual-only | yes | yes | same as above |
| `post_class_feedback_payout_accrual` | `33 * * * *` | yes | yes | `{ok:true, accrual, finalize}` — accrual pass then finalize pass ([`run-job.ts:141-150`](../../../src/lib/data-health/run-job.ts)) |
| `leave_requests` | `15,45 * * * *` | — | yes | `{ok:true, result}` ([`run-job.ts:152-163`](../../../src/lib/data-health/run-job.ts)) |
| `classroom_morning` | `41 23 * * *` | yes | yes | the automation result verbatim; `500 {ok:false, error}` on throw ([`run-job.ts:165-173`](../../../src/lib/data-health/run-job.ts)) |
| `classroom_admin_email` | `4,14,24,36 0 * * *` | yes | yes | the email-run result verbatim, status `500` when `result.status === "failed"` ([`run-job.ts:175-184`](../../../src/lib/data-health/run-job.ts)) |
| `student_promotions_july_1` | `5 17 30 6 *` | yes | **no → 404** | — |
| `admissions_notifications` | `12 1 * * *` | yes | **no → 404** | — |
| `line_credit_digest` | `3 2 * * *` | yes | **no → 404** | — |
| `cron_watchdog` | `7,37 * * * *` | — | yes | `{ok:true, ...CronWatchdogSummary}` ([`run-job.ts:186-195`](../../../src/lib/data-health/run-job.ts)) |
| `room_utilization` | manual-only | — | yes | `{ok:true, ...result}` ([`run-job.ts:197-205`](../../../src/lib/data-health/run-job.ts)) |
| `line_backlog_recovery` | manual-only | — | **no → 404** | — |

Three of the seven unimplemented keys are `dangerous`, so a caller must still send `confirmed: true` to receive the 404 — gate 4 runs before dispatch.

**Response shape is not uniform.** Each branch returns whatever its lib function produced; there is no envelope contract across jobs. Where a Data Health branch exists it can also differ from the cron route's own response — for example the post-class digest branch returns `{ok, result}` where the route returns `{ok, digest}`.

**Side effects.** Beyond the dispatched job's own writes (Wise snapshot promotion, Google Sheets reads, outbound tutor/admin email, LINE pushes, payout ledger appends — see each job's entry in [crons.md](../crons.md)), every dispatch writes exactly one `cron_invocations` row with `triggerSource: "admin"` and `actorEmail` set to the caller ([`run-job.ts:35-41`](../../../src/lib/data-health/run-job.ts)), so manual runs are attributable and appear in the next dashboard load's `recentInvocations`.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Job dispatched and its branch returned a 2xx body. |
| 202 | Single-flight skip on `wise_snapshot` / `credit_control` — audited as `skipped`, not `failed` ([`cron-audit.ts:114`](../../../src/lib/data-health/cron-audit.ts)). |
| 401 | No session, or a session without `user.email`. |
| 403 | Post-class job without the `access_manager` capability. Also emitted by middleware for a restricted user outside `/data-health`. |
| 404 | `jobKey` not in the registry (no audit row), **or** registered but with no runner branch (audit row written). |
| 409 | `dangerous` job without `confirmed: true`; also the `already running` collisions on `wise_activity` and `competitor_intelligence`. |
| 500 | Branch-level failure. Message fidelity varies by branch — several return a fixed generic string that discards the underlying error. |
| 503 | Reminder checkpoint not ready (`post_class_feedback_day_after`, `post_class_feedback_deadline`). |

---

## The watchdog sweep

### `GET /api/internal/cron-watchdog` · `POST /api/internal/cron-watchdog`

The push half of Data Health: it re-runs the dashboard's own health derivation on a schedule and emails admins when a job goes bad. Both methods delegate to the same private `handle` ([`route.ts:9-34`](../../../src/app/api/internal/cron-watchdog/route.ts)); `POST` exists for symmetry only and behaves identically. Scheduled `7,37 * * * *` in [`vercel.json:60-63`](../../../vercel.json) — offset from the eight sub-hourly sync jobs. `export const maxDuration = 300` ([`route.ts:7`](../../../src/app/api/internal/cron-watchdog/route.ts)).

**Auth:** `CRON_SECRET` only, checked constant-time; no session fallback ([`route.ts:10-11`](../../../src/app/api/internal/cron-watchdog/route.ts)).

**Query / body:** none. `runCronWatchdog`'s `RunCronWatchdogOptions` ([`cron-watchdog.ts:76-82`](../../../src/lib/internal/cron-watchdog.ts)) exists for test injection only — the route passes just `getDb()` ([`route.ts:17`](../../../src/app/api/internal/cron-watchdog/route.ts)), so `now`, the email sender, and the loaders are never client-settable.

**What one sweep does** ([`cron-watchdog.ts:374-389`](../../../src/lib/internal/cron-watchdog.ts) and `runWatchdogSweep` [`:391-435`](../../../src/lib/internal/cron-watchdog.ts)):

1. **Prune first, in its own try/catch.** `pruneCronInvocations` deletes rows older than `CRON_INVOCATION_RETENTION_DAYS = 90` **and** outside the newest 8 per `job_key` — both guards, so an annual job keeps its proof forever ([`cron-retention.ts:16-55`](../../../src/lib/data-health/cron-retention.ts)). A prune failure is logged and swallowed: bookkeeping must never suppress an alert digest ([`cron-watchdog.ts:379-385`](../../../src/lib/internal/cron-watchdog.ts)).
2. **Load health** via `getCronJobsHealth` — the same `buildCronJobs` the dashboard uses, without the snapshot/issue queries ([`dashboard.ts:892-898`](../../../src/lib/data-health/dashboard.ts)).
3. **Append a synthetic entry.** `post_class_payout_window` is not a cron route; it projects payout-window staleness onto the `CronJobHealth` shape so the finalize gap rides the sweep and inherits episode dedup, the digest email, and the recovery notice ([`cron-watchdog.ts:94-123`](../../../src/lib/internal/cron-watchdog.ts)). A failure on that side degrades to "no payout entry this sweep", never a failed sweep ([`:131-141`](../../../src/lib/internal/cron-watchdog.ts)).
4. **Claim the single-flight lock.** A sentinel `cron_alert_state` row keyed `__watchdog_sweep_lock` is claimed by one conditional upsert with `RETURNING`, reclaimable after 6 minutes if a sweep crashed ([`cron-watchdog.ts:42-51`](../../../src/lib/internal/cron-watchdog.ts), [`:305-330`](../../../src/lib/internal/cron-watchdog.ts)). The key can never collide with a registry key, so it is invisible to classification.
5. **Classify.** `sweepCronJobs` ([`:159-178`](../../../src/lib/internal/cron-watchdog.ts)) takes `checked` = every non-`manualOnly` job except the watchdog itself, `unhealthy` = those in `failing` / `late` / `unknown` ([`:53`](../../../src/lib/internal/cron-watchdog.ts)), `newAlerts` = unhealthy jobs with no open episode, `recoveries` = healthy jobs whose last episode is still open.
6. **Email once per episode.** One digest to every full-access admin — `admin_users` rows with `allowedPages IS NULL`, since page-restricted users cannot open the `/data-health` link the alert points at ([`:262-269`](../../../src/lib/internal/cron-watchdog.ts)). Subject: `[BGScheduler] {n} cron job(s) unhealthy`, or `… recovered` when nothing is unhealthy ([`:209-213`](../../../src/lib/internal/cron-watchdog.ts)).
7. **Persist state only after a delivery succeeded.** `newAlerts` upsert `lastAlertOutcome: "alerted"`; `recoveries` update to `"recovered"`, which re-arms the next alert ([`:492-515`](../../../src/lib/internal/cron-watchdog.ts)). Zero successful sends leaves the episode unmarked for retry on the next sweep. Partial delivery **does** close the episode and only logs the failed recipients — a deliberate tradeoff documented in the module header ([`:11-17`](../../../src/lib/internal/cron-watchdog.ts)).
8. **Release the lock** in a `finally`, matching on the episode token so a stale-reclaim race cannot release someone else's claim ([`:333-350`](../../../src/lib/internal/cron-watchdog.ts), [`:430-434`](../../../src/lib/internal/cron-watchdog.ts)).

**Response `200`:** `{ ok: true, ...CronWatchdogSummary }` ([`route.ts:18`](../../../src/app/api/internal/cron-watchdog/route.ts); shape at [`cron-watchdog.ts:62-71`](../../../src/lib/internal/cron-watchdog.ts)):

| Field | Type | Meaning |
|---|---|---|
| `checked` | number | Non-manual-only jobs evaluated, excluding the watchdog itself. |
| `unhealthy` | number | Of those, how many are `failing` / `late` / `unknown`. |
| `alertsSent` | number | New alert episodes opened this sweep (`0` when delivery failed). |
| `recoveries` | number | Episodes closed this sweep. |
| `emailRecipients` | number | Recipients that accepted the digest. |
| `skippedReason` | string \| null | `"cron_alert_state table unavailable"`, `"another sweep is in flight"`, `"no admin recipients"`, `"email delivery failed"`, or `null`. |
| `invocationsPruned` | number | Rows deleted by the retention sweep. |

**Fail-safe when `cron_alert_state` is missing.** `isMissingAlertStateTable` checks the Drizzle message, its `cause` message, and pg code `42P01` ([`cron-watchdog.ts:278-296`](../../../src/lib/internal/cron-watchdog.ts)) — a `DrizzleQueryError` hides the real detail on `cause`. On a match, alerting is disabled with a `console.error` and the sweep still returns counts with `skippedReason` set; un-deduped alerts every 30 minutes would be worse than silence ([`:403-418`](../../../src/lib/internal/cron-watchdog.ts)).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Sweep completed (including every `skippedReason` path — a skipped sweep is still a 200). |
| 401 | Missing or wrong `Bearer {CRON_SECRET}` ([`cron-auth.ts:25`](../../../src/lib/internal/cron-auth.ts)). |
| 500 | `CRON_SECRET` unset → `{"error":"Server misconfigured"}`; or any throw inside the sweep → `{"error": <message>}`, also `console.error`-logged ([`route.ts:19-23`](../../../src/app/api/internal/cron-watchdog/route.ts)). The watchdog is one of the routes that surfaces the real error message rather than a fixed string. |

---

## Cross-cutting notes

* **The watchdog never alerts on itself.** `checked` excludes `WATCHDOG_JOB_KEY` ([`cron-watchdog.ts:39-40`](../../../src/lib/internal/cron-watchdog.ts), [`:167`](../../../src/lib/internal/cron-watchdog.ts)), so a wedged watchdog is silent by construction — it shows on the dashboard, but nothing emails about it.
* **`unknown` is alertable, and that is deliberate.** `student_promotions_july_1` is pinned to *no* run evidence rather than borrowing the fallback, because its run table mixes admin drafts with the cron apply; a dangerous write-path cron reporting `healthy` without ever firing would be worse than a false `unknown` ([`dashboard.ts:274-286`](../../../src/lib/data-health/dashboard.ts)).
* **Six registry keys reach the run-evidence fallback, not one.** The fallback at [`dashboard.ts:317-341`](../../../src/lib/data-health/dashboard.ts) synthesizes a `success` run from the newest `room_utilization_sessions` row, and its comment states that only `room_utilization` gets there. Enumerating `job.key ===` branches against the registry shows six keys with no branch: `post_class_feedback_backfill`, `post_class_feedback_payout_accrual`, `admissions_notifications`, `line_credit_digest`, `room_utilization`, `line_backlog_recovery`. For the four scheduled ones this only matters when direct `cron_invocations` proof is absent (all four routes are audit-wrapped, so normally it is present) — but with an empty or missing invocation table, a fresh room-utilization row can stand in as their inferred success evidence. Comment and reachability have drifted; the comment is the stale half.
* **Registry `maxDurationSeconds` — not the route's `export const maxDuration` — drives stuck detection.** A lower registry number reports a legitimate long run as `failing`. The credit-control pair was the documented instance of this drift and is now reconciled at 800 on both sides ([`cron-registry.ts:119-122`](../../../src/lib/data-health/cron-registry.ts)); a regression test reads each route file as text and asserts every registry entry mirrors its route's declared `maxDuration`, so the two can no longer diverge silently ([`cron-registry.test.ts:57-73`](../../../src/lib/data-health/__tests__/cron-registry.test.ts)).
* **17 scheduled, 22 registered.** `vercel.json` carries 17 `crons` entries; the registry declares 22, the extra five being `manualOnly: true` with no schedule — the three parked post-class notification jobs, `room_utilization`, and `line_backlog_recovery`. Nine entries are `dangerous: true`.
* **`GET /api/data-health` is not cheap.** ~20 Postgres round trips per call and an uncapped `data_issues` read for the active snapshot. The stale banner fetches it once per workspace-path mount, and the dashboard re-fetches it after every manual run.

## Tests

| File | Cases | Covers |
|---|---:|---|
| [`src/app/api/data-health/__tests__/route.test.ts`](../../../src/app/api/data-health/__tests__/route.test.ts) | 3 | 401 unauthenticated, the v2 payload with the compatibility fields preserved, 500 JSON on aggregation failure |
| [`src/app/api/data-health/jobs/[jobKey]/run/__tests__/route.test.ts`](../../../src/app/api/data-health/jobs/[jobKey]/run/__tests__/route.test.ts) | 7 | admin session required, known non-dangerous job, 409 without confirmation, confirmed dangerous job, unknown job, `access_manager` required for post-class jobs, access manager allowed |
| [`src/app/api/data-health/__tests__/modality-counter.test.ts`](../../../src/app/api/data-health/__tests__/modality-counter.test.ts) | 5 | the `modality` + `conflict_model` union |
| [`src/lib/internal/__tests__/cron-watchdog.test.ts`](../../../src/lib/internal/__tests__/cron-watchdog.test.ts) | 25 | classification, episode dedup, recovery, lock claim/release, missing-table fail-safe, email content, payout-window entry |
| [`src/lib/data-health/__tests__/status.test.ts`](../../../src/lib/data-health/__tests__/status.test.ts) | 7 | the status ladder and expected-window arithmetic |
| [`src/lib/data-health/__tests__/cron-audit.test.ts`](../../../src/lib/data-health/__tests__/cron-audit.test.ts) | 6 | outcome derivation, response digest capping |
| [`src/lib/data-health/__tests__/cron-retention.test.ts`](../../../src/lib/data-health/__tests__/cron-retention.test.ts) | 4 | both retention guards |
| [`src/lib/data-health/__tests__/cron-registry.test.ts`](../../../src/lib/data-health/__tests__/cron-registry.test.ts) | 5 | registry mirrors `vercel.json`, every entry points at a real `route.ts`, and each entry's `maxDurationSeconds` mirrors that route's exported `maxDuration` |

The watchdog **route** has no route-level test; its behaviour is covered through the lib suite.

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
