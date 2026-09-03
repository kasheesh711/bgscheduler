# Internal / Cron API

Machine-to-machine endpoints that drive the scheduled pipelines. Vercel Cron invokes them (always `GET` — Vercel issues no other method); operators re-run them by hand with `curl` or, for some, from the Data Health job list. Every one lives under `/api/internal/*`, which [`src/middleware.ts:24`](../../../src/middleware.ts) exempts from the session gate, so each route enforces its own `CRON_SECRET` check in-handler.

This page owns the **mechanical HTTP contract** — method, auth, request shape, response shape, side effects, status codes. What each pipeline *means* (what a snapshot is, why the feedback deadline matters, when a payout window closes) lives in the feature docs linked from each section.

> **Scope.** This page documents **25 endpoints** across 14 route files. Six further `/api/internal/*` endpoints exist in the tree and are documented with their owning features: `GET`/`POST /api/internal/sync-sales-dashboard` ([sales-dashboard.md](sales-dashboard.md)), `GET /api/internal/sync-wise-activity` ([wise-activity.md](wise-activity.md)), `POST /api/internal/sync-room-utilization` ([room-capacity.md](room-capacity.md)), and `GET /api/internal/class-assignments/morning` + `GET /api/internal/class-assignments/admin-email` ([classrooms-and-assignments.md](classrooms-and-assignments.md)). Thirty-one `/api/internal/*` endpoints exist in total.

---

## Conventions shared by these endpoints

### `CRON_SECRET` bearer auth

Every route requires `Authorization: Bearer $CRON_SECRET`. The comparison is constant-time (`node:crypto.timingSafeEqual`) behind a length pre-check — the pre-check avoids the `RangeError` `timingSafeEqual` throws on length-mismatched buffers and is itself O(1), so it leaks no timing signal about the secret ([`cron-auth.ts:6-17`](../../../src/lib/internal/cron-auth.ts), and the REL-07 comment at [`sync-wise/route.ts:12-15`](../../../src/app/api/internal/sync-wise/route.ts)).

Three outcomes are distinguished, and the third is the one worth knowing about:

| Secret state | Response |
|---|---|
| header matches | proceed |
| header missing or wrong | `401 {"error":"Unauthorized"}` |
| `process.env.CRON_SECRET` unset | `500 {"error":"Server misconfigured"}` |

Most routes call the shared `rejectInvalidCronSecret` ([`cron-auth.ts:19-26`](../../../src/lib/internal/cron-auth.ts)); `sync-progress-tests` imports the shared `getCronSecretStatus` ([`sync-progress-tests/route.ts:3`](../../../src/app/api/internal/sync-progress-tests/route.ts)). **Four routes carry a private, behaviourally identical copy of the helper** rather than importing it: `sync-wise` ([`:11-29`](../../../src/app/api/internal/sync-wise/route.ts)), `sync-credit-control` ([`:18-31`](../../../src/app/api/internal/sync-credit-control/route.ts)), `sync-competitor-intelligence` ([`:11-18`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)), and `student-promotions/july-1` ([`:10-17`](../../../src/app/api/internal/student-promotions/july-1/route.ts)).

### Session fallback on four `POST` handlers

`sync-wise`, `sync-credit-control`, `sync-progress-tests`, and `sync-competitor-intelligence` accept an Auth.js session **on `POST` only** when the cron secret does not match; their `GET` handlers pass `allowSessionAuth: false` and are cron-secret-only ([`sync-wise/route.ts:69-76`](../../../src/app/api/internal/sync-wise/route.ts), [`sync-credit-control/route.ts:65-71`](../../../src/app/api/internal/sync-credit-control/route.ts), [`sync-progress-tests/route.ts:41-47`](../../../src/app/api/internal/sync-progress-tests/route.ts), [`sync-competitor-intelligence/route.ts:66-72`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)). Three of the four accept **any** signed-in session with no role or capability check — `if (session)` is the whole test. Only `sync-competitor-intelligence` demands a capability, via `requireCompetitorIntelligenceSession` ([`access.ts:19-30`](../../../src/lib/competitor-intelligence/access.ts)). Because `/api/internal/*` is in the middleware public allowlist, no middleware page-scope check runs first.

A session-authenticated run is audited with `triggerSource: "admin"` and the actor's email; a cron-secret run with `triggerSource: "cron"`.

### The cron invocation audit wrapper

Twenty-three of the 25 endpoints wrap their work in `withCronInvocationAudit` ([`cron-audit.ts:191-206`](../../../src/lib/data-health/cron-audit.ts)) — the two exceptions are `GET`/`POST /api/internal/student-promotions/july-1`, which write no `cron_invocations` row at all. The wrapper:

1. Inserts a `cron_invocations` row with `outcome: "running"` before the handler runs, resolving `path`/`schedule`/`label`/`feature` from the registry entry for the job key ([`:131-159`](../../../src/lib/data-health/cron-audit.ts)). An unknown job key means **no row** — the handler still runs.
2. On completion, stamps `finishedAt`, `durationMs`, `responseStatus`, `errorSummary`, `linkedRunIds`, and a size-capped `metadata.response` digest (scalars only, strings truncated at 200 chars, whole digest capped at 2,048 bytes — [`:61-106`](../../../src/lib/data-health/cron-audit.ts)).
3. Derives `outcome` from the response, **not** from the handler's intent ([`:108-117`](../../../src/lib/data-health/cron-audit.ts)):

| Condition | Recorded outcome |
|---|---|
| body `skipped === true`, or `error`/`message` contains `already running` | `skipped` |
| body `ok === false` or `success === false` | `failed` |
| HTTP 202 | `skipped` |
| HTTP ≥ 400 | `failed` |
| otherwise | `success` |

4. Converts an uncaught throw into `500 {"error": <message>}` and audits that ([`:200-204`](../../../src/lib/data-health/cron-audit.ts)) — so a handler that forgets its own `try/catch` still produces a JSON 500 and an audit row.

### Cron registration and `maxDuration`

Seventeen paths are registered in [`vercel.json`](../../../vercel.json), and every schedule is pinned by a regression test ([`vercel-crons.test.ts:18-35`](../../../src/__tests__/vercel-crons.test.ts)). The in-app registry [`cron-registry.ts:47-399`](../../../src/lib/data-health/cron-registry.ts) declares **22** jobs — the 17 scheduled ones plus five `manualOnly: true` entries with no `vercel.json` line. Of the endpoints on this page, four are `manualOnly`: the three parked post-class jobs (`admin-digest`, `reminder-day-after`, `reminder-deadline` — [`:189-236`](../../../src/lib/data-health/cron-registry.ts)) and `line-backlog-recovery` ([`:384-398`](../../../src/lib/data-health/cron-registry.ts)).

`maxDuration` is declared per route file, never in `vercel.json`. Routes that call Wise or Google sit at 800s; digest and watchdog routes at 300s.

### The Data Health manual-run path

`POST /api/data-health/jobs/{jobKey}/run` re-runs a job **by calling the same lib function in-process**, not by issuing an HTTP request to the route ([`run-job.ts:29-209`](../../../src/lib/data-health/run-job.ts)). It handles 15 job keys. **Seven registry keys have no branch and therefore return `404 {"error":"Unknown job"}`** ([`run-job.ts:207`](../../../src/lib/data-health/run-job.ts)): `progress_tests`, `progress_tests_digest`, `post_class_feedback_backfill`, `student_promotions_july_1`, `admissions_notifications`, `line_backlog_recovery`, `line_credit_digest`. For those seven, a direct `CRON_SECRET` call is the only manual path.

Where a Data Health branch exists, its response can differ slightly from the route's — e.g. the post-class digest branch returns `{ok, result}` ([`run-job.ts:121-124`](../../../src/lib/data-health/run-job.ts)) where the route returns `{ok, digest}`.

---

## Endpoint index (25)

| # | Method | Path | Auth | `vercel.json` schedule | Route file |
|---|---|---|---|---|---|
| 1 | GET | `/api/internal/sync-wise` | cron secret | `*/30 * * * *` | [`sync-wise/route.ts:69-71`](../../../src/app/api/internal/sync-wise/route.ts) |
| 2 | POST | `/api/internal/sync-wise` | cron secret **or** any session | — | [`sync-wise/route.ts:74-76`](../../../src/app/api/internal/sync-wise/route.ts) |
| 3 | GET | `/api/internal/cron-watchdog` | cron secret | `7,37 * * * *` | [`cron-watchdog/route.ts:28-30`](../../../src/app/api/internal/cron-watchdog/route.ts) |
| 4 | POST | `/api/internal/cron-watchdog` | cron secret | — | [`cron-watchdog/route.ts:32-34`](../../../src/app/api/internal/cron-watchdog/route.ts) |
| 5 | GET | `/api/internal/sync-credit-control` | cron secret | `20,50 * * * *` | [`sync-credit-control/route.ts:65-67`](../../../src/app/api/internal/sync-credit-control/route.ts) |
| 6 | POST | `/api/internal/sync-credit-control` | cron secret **or** any session | — | [`sync-credit-control/route.ts:69-71`](../../../src/app/api/internal/sync-credit-control/route.ts) |
| 7 | GET | `/api/internal/sync-progress-tests` | cron secret | `25,55 * * * *` | [`sync-progress-tests/route.ts:41-43`](../../../src/app/api/internal/sync-progress-tests/route.ts) |
| 8 | POST | `/api/internal/sync-progress-tests` | cron secret **or** any session | — | [`sync-progress-tests/route.ts:45-47`](../../../src/app/api/internal/sync-progress-tests/route.ts) |
| 9 | GET | `/api/internal/progress-tests/admin-digest` | cron secret | `35 0 * * *` | [`progress-tests/admin-digest/route.ts:8-24`](../../../src/app/api/internal/progress-tests/admin-digest/route.ts) |
| 10 | GET | `/api/internal/sync-post-class-feedback` | cron secret | `13,43 * * * *` | [`sync-post-class-feedback/route.ts:15-45`](../../../src/app/api/internal/sync-post-class-feedback/route.ts) |
| 11 | GET | `/api/internal/post-class-feedback-backfill` | cron secret | `23,53 * * * *` | [`post-class-feedback-backfill/route.ts:32-81`](../../../src/app/api/internal/post-class-feedback-backfill/route.ts) |
| 12 | GET | `/api/internal/post-class-feedback/payout-accrual` | cron secret | `33 * * * *` | [`payout-accrual/route.ts:18-40`](../../../src/app/api/internal/post-class-feedback/payout-accrual/route.ts) |
| 13 | GET | `/api/internal/post-class-feedback/admin-digest` | cron secret | — (parked) | [`admin-digest/route.ts:9-22`](../../../src/app/api/internal/post-class-feedback/admin-digest/route.ts) |
| 14 | GET | `/api/internal/post-class-feedback/reminder-day-after` | cron secret | — (parked) | [`reminder-day-after/route.ts:9-29`](../../../src/app/api/internal/post-class-feedback/reminder-day-after/route.ts) |
| 15 | GET | `/api/internal/post-class-feedback/reminder-deadline` | cron secret | — (parked) | [`reminder-deadline/route.ts:9-29`](../../../src/app/api/internal/post-class-feedback/reminder-deadline/route.ts) |
| 16 | GET | `/api/internal/sync-leave-requests` | cron secret | `15,45 * * * *` | [`sync-leave-requests/route.ts:30-32`](../../../src/app/api/internal/sync-leave-requests/route.ts) |
| 17 | POST | `/api/internal/sync-leave-requests` | cron secret | — | [`sync-leave-requests/route.ts:34-36`](../../../src/app/api/internal/sync-leave-requests/route.ts) |
| 18 | GET | `/api/internal/sync-competitor-intelligence` | cron secret | `28 18 * * 0` | [`sync-competitor-intelligence/route.ts:66-68`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts) |
| 19 | POST | `/api/internal/sync-competitor-intelligence` | cron secret **or** session with CI access | — | [`sync-competitor-intelligence/route.ts:70-72`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts) |
| 20 | GET | `/api/internal/admissions-notifications` | cron secret | `12 1 * * *` | [`admissions-notifications/route.ts:73-88`](../../../src/app/api/internal/admissions-notifications/route.ts) |
| 21 | POST | `/api/internal/admissions-notifications` | cron secret | — | [`admissions-notifications/route.ts:91-113`](../../../src/app/api/internal/admissions-notifications/route.ts) |
| 22 | GET | `/api/internal/student-promotions/july-1` | cron secret | `5 17 30 6 *` | [`july-1/route.ts:19-44`](../../../src/app/api/internal/student-promotions/july-1/route.ts) |
| 23 | POST | `/api/internal/student-promotions/july-1` | cron secret | — | [`july-1/route.ts:46-48`](../../../src/app/api/internal/student-promotions/july-1/route.ts) |
| 24 | GET | `/api/internal/line-credit-digest` | cron secret | `3 2 * * *` | [`line-credit-digest/route.ts:8-24`](../../../src/app/api/internal/line-credit-digest/route.ts) |
| 25 | GET | `/api/internal/line-backlog-recovery` | cron secret | — (manual only) | [`line-backlog-recovery/route.ts:11-27`](../../../src/app/api/internal/line-backlog-recovery/route.ts) |

Four of the fourteen route files carry a route test of their own — `admissions-notifications`, `post-class-feedback-backfill`, `sync-credit-control`, and `sync-wise`, each with a suite under its own `__tests__/`. The other ten are exercised only through their lib functions' tests.

---

## Wise snapshot sync

Feature: **Tutor Search** — status **stable** (handbook maturity map; no `@deprecated` or status marker exists in code). Meaning and invariants: [docs/features/tutor-search.md](../../features/tutor-search.md).

### `GET /api/internal/sync-wise` · `POST /api/internal/sync-wise`

The full Wise ETL: fetch → normalize → persist → validate → atomically promote a new snapshot. `maxDuration = 800` ([`route.ts:7`](../../../src/app/api/internal/sync-wise/route.ts)).

**Auth.** `GET`: cron secret only. `POST`: cron secret, else any Auth.js session ([`route.ts:45-59`](../../../src/app/api/internal/sync-wise/route.ts)). Both funnel into the same `handleSync` ([`route.ts:32-66`](../../../src/app/api/internal/sync-wise/route.ts)).

**Request.** No query parameters, no body — neither handler reads either.

**Side effects.** `runWiseSyncRequest` ([`run-wise-sync.ts:142-167`](../../../src/lib/sync/run-wise-sync.ts)):
1. Fails any `sync_runs` row still `running` after 20 minutes (`STALE_RUNNING_SYNC_MS`, [`:10`](../../../src/lib/sync/run-wise-sync.ts)), stamping a fixed `errorSummary` ([`:39-40`](../../../src/lib/sync/run-wise-sync.ts)).
2. Single-flight guard: if a `running` row survives, returns the skip payload instead of starting ([`:88-118`](../../../src/lib/sync/run-wise-sync.ts)). A `23505` unique violation on insert is treated as the same condition.
3. Otherwise inserts a `running` row and calls `runFullSync` ([`orchestrator.ts`](../../../src/lib/sync/orchestrator.ts)), which rewrites the snapshot-scoped tutor tables and promotes the candidate snapshot.
4. On success only, calls `revalidateTag("snapshot", { expire: 0 })` ([`run-wise-sync.ts:160-162`](../../../src/lib/sync/run-wise-sync.ts)) so the cached data layer re-reads.

**Response `200` / `500`** — the `SyncResult` ([`orchestrator.ts:22-32`](../../../src/lib/sync/orchestrator.ts)) plus one added field:

| Key | Type |
|---|---|
| `success` | `boolean` |
| `syncRunId` | `string` |
| `snapshotId` | `string \| null` |
| `promotedSnapshotId` | `string \| null` |
| `teacherCount`, `groupCount`, `issueCount` | `number` |
| `errorSummary` | `string \| null` |
| `durationMs` | `number` |
| `staleRunningSyncsFailed` | `number` — rows the stale sweep failed this call ([`:157`](../../../src/lib/sync/run-wise-sync.ts)) |

**Response `202`** — the skip payload ([`:120-140`](../../../src/lib/sync/run-wise-sync.ts)): the same key set with `skipped: true`, `alreadyRunning: true`, zeroed counts, plus `message` and `runningStartedAt` (ISO). The audit records this as `skipped`.

**Status codes:** `200` success · `202` already running · `401` bad/missing secret and (on `POST`) no session · `500` `CRON_SECRET` unset, or `result.success === false` ([`:164-166`](../../../src/lib/sync/run-wise-sync.ts)).

---

## Cron watchdog

Feature: **Data Health** — status **stable**. Meaning: [docs/features/data-health.md](../../features/data-health.md).

### `GET /api/internal/cron-watchdog` · `POST /api/internal/cron-watchdog`

Both methods are identical — each delegates to the same `handle` ([`route.ts:9-34`](../../../src/app/api/internal/cron-watchdog/route.ts)). Cron secret only; there is no session fallback. `maxDuration = 300`.

**Request.** None read.

**Side effects.** `runCronWatchdog(getDb())` ([`cron-watchdog.ts:374-389`](../../../src/lib/internal/cron-watchdog.ts)):
1. Prunes `cron_invocations` under the retention policy first; a prune failure is logged and swallowed ([`:380-385`](../../../src/lib/internal/cron-watchdog.ts)).
2. Loads every registry job's health, appends a **synthetic** `post_class_payout_window` entry derived from payout-window staleness ([`:91-117`](../../../src/lib/internal/cron-watchdog.ts)) — not a cron route, but it rides the sweep to inherit episode dedup and the digest email.
3. Claims a sentinel `cron_alert_state` row as a single-flight sweep lock (`__watchdog_sweep_lock`, [`:48`](../../../src/lib/internal/cron-watchdog.ts)); a crashed sweep's lock is reclaimable after 6 minutes ([`:51`](../../../src/lib/internal/cron-watchdog.ts)).
4. Emails admins for jobs newly in `failing` / `late` / `unknown` ([`:53`](../../../src/lib/internal/cron-watchdog.ts)) and sends recovery notices, writing alert state **only after at least one recipient accepted** ([`:6-9`](../../../src/lib/internal/cron-watchdog.ts)).
5. If `cron_alert_state` is missing entirely, alerting is disabled with a `console.error` and the sweep still reports counts ([`:404-414`](../../../src/lib/internal/cron-watchdog.ts)).

The watchdog never alerts about itself ([`WATCHDOG_JOB_KEY`, `:40`](../../../src/lib/internal/cron-watchdog.ts)).

**Response `200`** — `{ ok: true, ...CronWatchdogSummary }` ([`route.ts:18`](../../../src/app/api/internal/cron-watchdog/route.ts), summary shape at [`cron-watchdog.ts:62-71`](../../../src/lib/internal/cron-watchdog.ts)): `checked`, `unhealthy`, `alertsSent`, `recoveries`, `emailRecipients` (numbers), `skippedReason` (`string | null`), `invocationsPruned` (number).

**Status codes:** `200` · `401` · `500` on any throw, body `{"error": <message>}`, also `console.error`-logged ([`route.ts:19-23`](../../../src/app/api/internal/cron-watchdog/route.ts)).

---

## Credit control sync

Feature: **Credit Control** — status **stable**. Meaning: [docs/features/credit-control.md](../../features/credit-control.md). Endpoint detail for the user-facing routes: [credit-control.md](credit-control.md).

### `GET /api/internal/sync-credit-control` · `POST /api/internal/sync-credit-control`

`maxDuration = 800`. The route file carries a load-bearing comment explaining the raise from 300s: successful runs take 372–390s, so the old limit put every run permanently over budget and stranded `running` rows until the watchdog failed them ([`route.ts:7-14`](../../../src/app/api/internal/sync-credit-control/route.ts)). The registry now mirrors 800 ([`cron-registry.ts:119-122`](../../../src/lib/data-health/cron-registry.ts)).

**Auth.** `GET` cron-secret-only; `POST` falls back to any session ([`route.ts:33-63`](../../../src/app/api/internal/sync-credit-control/route.ts)).

**Request.** None read.

**Side effects.** `runCreditControlSyncRequest` ([`run-sync-request.ts:138-160`](../../../src/lib/credit-control/run-sync-request.ts)) mirrors the Wise-sync guard exactly: fail `creditControlSyncRuns` rows `running` past 20 minutes ([`:9-12`](../../../src/lib/credit-control/run-sync-request.ts)), single-flight skip if one survives, else insert a `running` row and call `runCreditControlSync`, which rebuilds the credit-control snapshot (students, packages, sessions) and promotes it.

**Response `200` / `500`** — `CreditControlSyncResult` ([`sync.ts:49-58`](../../../src/lib/credit-control/sync.ts)) plus `syncRunId` and `staleRunningSyncsFailed` ([`run-sync-request.ts:153-158`](../../../src/lib/credit-control/run-sync-request.ts)): `success`, optional `snapshotId` / `promotedSnapshotId` / `errorSummary`, and `studentCount`, `packageCount`, `sessionCount`, `failedCreditPairs`.

**Response `202`** — skip payload with `skipped: true`, `alreadyRunning: true`, zeroed counts, `message`, `runningStartedAt` ([`:24-39`, `:84-104`](../../../src/lib/credit-control/run-sync-request.ts)).

**Status codes:** `200` · `202` · `401` · `500`.

---

## Progress tests

Feature: **Progress Tests** — status **stable**. Meaning: [docs/features/progress-tests.md](../../features/progress-tests.md).

### `GET /api/internal/sync-progress-tests` · `POST /api/internal/sync-progress-tests`

`maxDuration = 300`. `GET` cron-secret-only; `POST` accepts any session and, unusually, threads the actor through to the domain call as well as the audit — `runProgressTestSyncRequest({ triggerType: "admin", actorEmail })` ([`route.ts:19-31`](../../../src/app/api/internal/sync-progress-tests/route.ts)). Cron runs pass `triggerType: "cron"` ([`route.ts:15`](../../../src/app/api/internal/sync-progress-tests/route.ts)).

**Request.** None read.

**Side effects.** Same guard family ([`run-sync-request.ts:137-165`](../../../src/lib/progress-tests/run-sync-request.ts)): stale `progressTestSyncRuns` rows failed after the configured interval, single-flight skip, else a `running` row (stamped with `triggerType` and `actorEmail`, [`:119`](../../../src/lib/progress-tests/run-sync-request.ts)) and a `runProgressTestSync` pass that recounts the every-8-classes ledger, advances enrollments through `approaching` / `due`, and dispatches the class-6-of-8 teacher heads-up.

**Response `200` / `500`** — `ProgressTestSyncResult` ([`sync.ts:75-84`](../../../src/lib/progress-tests/sync.ts)) plus `syncRunId` and `staleRunningSyncsFailed`: `success`, `ledgerRowCount`, `enrollmentCount`, `approachingCount`, `dueCount`, `unresolvedTeacherCount`, `notificationCount`, optional `errorSummary`.

**Response `202`** — skip payload ([`:23-37`](../../../src/lib/progress-tests/run-sync-request.ts)).

**Status codes:** `200` · `202` · `401` · `500`.

### `GET /api/internal/progress-tests/admin-digest`

The daily admin digest, `35 0 * * *` UTC = 07:35 Bangkok ([`cron-registry.ts:148-156`](../../../src/lib/data-health/cron-registry.ts)). `maxDuration = 300`. Cron secret only, no session fallback ([`route.ts:8-11`](../../../src/app/api/internal/progress-tests/admin-digest/route.ts)).

**Request.** None read.

**Side effects.** `sendProgressTestAdminDigest` ([`admin-digest.ts:309`](../../../src/lib/progress-tests/admin-digest.ts)) is date-idempotent: it returns `status: "skipped"` without sending when a terminal digest row already exists for the Bangkok date ([`:316-327`](../../../src/lib/progress-tests/admin-digest.ts)). Otherwise it composes the approaching/due/unresolved rows and emails admins.

**Response.** The `ProgressTestAdminDigestResult` object is returned **verbatim, unwrapped** ([`route.ts:18`](../../../src/app/api/internal/progress-tests/admin-digest/route.ts); shape at [`admin-digest.ts:32-43`](../../../src/lib/progress-tests/admin-digest.ts)): `status` (`sent` | `partial` | `failed` | `skipped`), `digestDate`, `digestRunId`, `approachingCount`, `dueCount`, `unresolvedCount`, `attempted`, `success`, `failed`, `message`.

**Status codes:** `200` for every status except `failed`, which is mapped to `500` ([`route.ts:17`](../../../src/app/api/internal/progress-tests/admin-digest/route.ts)) · `401` · `500` on throw, body `{"error": <message>}`.

---

## Post-class feedback

Feature: **Post-Class Feedback** — status **stable**; the payout write path is **stable with writes flag-gated by `POST_CLASS_PAYOUT_WRITES_ENABLED` / `POST_CLASS_AUTO_APPROVE_ENABLED`**. Meaning, enforcement modes, and the finance publish gate: [docs/features/post-class-feedback.md](../../features/post-class-feedback.md).

All six endpoints are cron-secret-only — none has a session fallback. All six wrap in the audit.

### `GET /api/internal/sync-post-class-feedback`

The rolling evidence collector, `13,43 * * * *`. `maxDuration = 800` ([`route.ts:13`](../../../src/app/api/internal/sync-post-class-feedback/route.ts)).

**Request.** None read.

**Side effects.** One sequential sync, then three independent passes run under `Promise.allSettled` ([`route.ts:22-30`](../../../src/app/api/internal/sync-post-class-feedback/route.ts)):
1. `runPostClassFeedbackSync({ triggerType: "cron" })` — reconciles Wise teacher-feedback evidence over the rolling window.
2. `processPostClassAiReviews()` — AI quality review of 10 feedback versions per run by default, capped at 25 ([`ai.ts:123`](../../../src/lib/post-class-feedback/ai.ts)).
3. `processDuePostClassNotificationRetries()` — retries 50 due deliveries per run by default, capped at 100 ([`notifications.ts:1095`](../../../src/lib/post-class-feedback/notifications.ts)).
4. `runPostClassDeductionHygiene()` — reopens unproven approvals and waives deductions on newly ineligible sessions. **Releases claims only; never approves** ([`route.ts:26-29`](../../../src/app/api/internal/sync-post-class-feedback/route.ts), [`auto-approval.ts:266-282`](../../../src/lib/post-class-feedback/auto-approval.ts)).

Because the three follow-ups are settled rather than awaited serially, any of them can fail without failing the request.

**Response `200`:**

```
{ ok: true,
  result:  SyncPostClassFeedbackResult,
  ai:      { processed, failed, skipped } | { failed: true },
  retries: { considered, sent, failed, cancelled, deferred } | { failed: true },
  hygiene: { reopened, reopenFailed, waived, waiveFailed } | { failed: true } }
```

A rejected settled pass collapses to the literal `{ failed: true }` ([`route.ts:34-36`](../../../src/app/api/internal/sync-post-class-feedback/route.ts)). `SyncPostClassFeedbackResult` is at [`sync.ts:97-116`](../../../src/lib/post-class-feedback/sync.ts): `runId`, `status` (`success` | `partial`), `windowStart`, `windowEnd`, `discoveredCount`, `candidateCount`, `windowCandidateCount`, `detailFetchedCount`, `sessionSavedCount`, `sourceIssueCount`, `checkpoint`. The retries shape is at [`notifications.ts:1118-1124`](../../../src/lib/post-class-feedback/notifications.ts), the AI shape at [`ai.ts:348`](../../../src/lib/post-class-feedback/ai.ts).

**Status codes:** `200` · `401` · **`409`** when `PostClassFeedbackSyncAlreadyRunningError` is thrown, body `{"error":"Post-class feedback sync is already running."}` ([`route.ts:39-41`](../../../src/app/api/internal/sync-post-class-feedback/route.ts), [`repository.ts:266-271`](../../../src/lib/post-class-feedback/repository.ts)) — the audit reads the `already running` substring and records `skipped`, not `failed` · `500` for anything else, with the underlying message **discarded** in favour of the fixed string `"Post-class feedback sync failed"` ([`route.ts:42`](../../../src/app/api/internal/sync-post-class-feedback/route.ts)).

### `GET /api/internal/post-class-feedback-backfill`

Drains history that the four-day rolling collector never covers, `23,53 * * * *`. `maxDuration = 800`. This is the **only** endpoint on this page with a non-trivial query contract.

**Query — `QuerySchema`** ([`route.ts:19-30`](../../../src/app/api/internal/post-class-feedback-backfill/route.ts)), parsed from `Object.fromEntries(searchParams)` with `.safeParse`:

| Param | Type | Rules |
|---|---|---|
| `startDate` | `YYYY-MM-DD` (regex `^\d{4}-\d{2}-\d{2}$`) | optional |
| `endDate` | `YYYY-MM-DD` | optional |
| `detailCap` | coerced int | optional, 1–400, **default 50** |
| `maxBatches` | coerced int | optional, 1–50, **default 1** |

Two cross-field refinements: `startDate` and `endDate` must be supplied together, and `startDate` must not be after `endDate` ([`:26-30`](../../../src/app/api/internal/post-class-feedback-backfill/route.ts)). The defaults are deliberate — 400/50 is the manual-recovery ceiling, while the routine cron stays at one 50-detail batch so it never monopolises the Wise API ([`:64-68`](../../../src/app/api/internal/post-class-feedback-backfill/route.ts)).

**Window selection.** With no explicit dates, `findOldestUnreconciledBackfillWindow()` picks the oldest Bangkok date whose eligible sessions are not yet `sourceStatus = 'ready'`, clamped so it never runs past today ([`backfill-window.ts:32-44`](../../../src/lib/post-class-feedback/backfill-window.ts)). `null` means everything is reconciled.

**Responses:**

| Body | Meaning |
|---|---|
| `{ ok: true, skipped: "nothing-unreconciled" }` | no window to work ([`route.ts:55-58`](../../../src/app/api/internal/post-class-feedback-backfill/route.ts)) — audited as `skipped` |
| `{ ok: true, window: { startDate, endDate }, result: PostClassBackfillJobResult }` | normal run |

`PostClassBackfillJobResult` ([`backfill-job.ts:27-38`](../../../src/lib/post-class-feedback/backfill-job.ts)): `startDate`, `endDate`, `batches`, `detailFetchedCount`, `sessionSavedCount`, `sourceIssueCount`, `syncRuns[]`, `drained` (boolean), `stoppedReason` (`drained` | `batch_limit` | `time_limit`).

**Status codes:** `200` · **`400`** with `{"error": <Zod flatten>}` on schema failure ([`route.ts:39-41`](../../../src/app/api/internal/post-class-feedback-backfill/route.ts)) · `401` · `409` on `PostClassFeedbackSyncAlreadyRunningError` · `500` with the fixed string `"Post-class feedback backfill failed"`.

### `GET /api/internal/post-class-feedback/payout-accrual`

Hourly at `33 * * * *`. `maxDuration = 800`. Registered `dangerous: true` with the confirmation label *"Appends real payout deductions to the master ledger."* ([`cron-registry.ts:254-255`](../../../src/lib/data-health/cron-registry.ts)).

**Request.** None read.

**Side effects — two passes, always in this order** ([`route.ts:30-31`](../../../src/app/api/internal/post-class-feedback/payout-accrual/route.ts)):

1. **`runPayoutAccrualPass`** ([`payout-accrual.ts:95-153`](../../../src/lib/post-class-feedback/payout-accrual.ts)) — runs the auto-approval sweep, then ledger retirement (auto-un-charge by row deletion; a retirement failure is logged and non-fatal, [`:120-122`](../../../src/lib/post-class-feedback/payout-accrual.ts)), then previews the current window and publishes it in `mode: "accrual"`. Accrual mode can never mint `published` and never touches the CSV/Drive leg ([`:86-94`](../../../src/lib/post-class-feedback/payout-accrual.ts)).
2. **`runPayoutFinalizePass`** ([`:223-257`](../../../src/lib/post-class-feedback/payout-accrual.ts)) — no-ops until the 26th-to-25th window has ended *and* the three-Bangkok-day settlement lag has elapsed ([`PAYOUT_SETTLEMENT_LAG_BANGKOK_DAYS`, `:58`](../../../src/lib/post-class-feedback/payout-accrual.ts)).

Both write as the synthetic actor `system:post-class-payout-accrual` ([`:45-50`](../../../src/lib/post-class-feedback/payout-accrual.ts)) through the ordinary `publishPayoutRun`, so every row is audited exactly as a human publish would be.

**Two environment flags gate the money movement.** `POST_CLASS_AUTO_APPROVE_ENABLED` must be the exact string `"true"` or the approve half of the sweep returns `{ approved: 0, failed: 0 }` and only human-approved deductions are ever written ([`payout-config.ts:164-168`](../../../src/lib/post-class-feedback/payout-config.ts), [`auto-approval.ts:73`](../../../src/lib/post-class-feedback/auto-approval.ts)). `POST_CLASS_PAYOUT_WRITES_ENABLED` must likewise be `"true"` or every write-bound Google target resolution throws ([`payout-config.ts:48-50, 126-130`](../../../src/lib/post-class-feedback/payout-config.ts)). Reopen is deliberately **not** behind either flag — reopening restores safety, approving moves money ([`payout-config.ts:158-162`](../../../src/lib/post-class-feedback/payout-config.ts)).

**Response `200`** — `{ ok: true, accrual, finalize }` ([`route.ts:32`](../../../src/app/api/internal/post-class-feedback/payout-accrual/route.ts)). Each of the two is either `{ skipped: string }` or a full `PayoutRunView` ([`payout-run.ts:96-109`](../../../src/lib/post-class-feedback/payout-run.ts): `run`, `runPersisted`, `window`, `previewToken`, `coverage`, `lines[]`, `adjustments[]`, `exceptions[]`, `policyVersion`, `csvError`, `stoppedEarly`). Known skip strings: `"nothing-pending"` ([`:129`](../../../src/lib/post-class-feedback/payout-accrual.ts)), `"window-not-ended"` ([`:230`](../../../src/lib/post-class-feedback/payout-accrual.ts)), and any `PostClassConflictError` message — a held lease, an active source sync, or a stale token/version, all of which simply retry next tick ([`:145-152`, `:250-256`](../../../src/lib/post-class-feedback/payout-accrual.ts)).

Note the audit consequence: because `ok` is `true` and the top-level body has no `skipped` key, a two-skip tick still records `success`.

**Status codes:** `200` · `401` · `500` with the fixed string `"Post-class payout accrual failed"` ([`route.ts:33-38`](../../../src/app/api/internal/post-class-feedback/payout-accrual/route.ts)); the route swallows the message entirely (`catch {`).

### `GET /api/internal/post-class-feedback/admin-digest` (parked)

No `vercel.json` entry. Registered `manualOnly: true`, `dangerous: true`, label *"Feedback Admin Digest (parked)"* ([`cron-registry.ts:192-206`](../../../src/lib/data-health/cron-registry.ts)), so Data Health never reports it late. `maxDuration = 300`.

**Side effects.** `sendPostClassAdminDigest()` ([`notifications.ts:1127`](../../../src/lib/post-class-feedback/notifications.ts)) takes a `pg_advisory_xact_lock` on a date-derived idempotency key, upserts a `post_class_notification_runs` row `onConflictDoNothing`, cancels deliveries addressed to recipients no longer active, then attempts each delivery.

**Response `200`** — `{ ok: true, digest: { duplicate, sent, failed } }` ([`route.ts:17`](../../../src/app/api/internal/post-class-feedback/admin-digest/route.ts); shape at [`notifications.ts:1213-1217`](../../../src/lib/post-class-feedback/notifications.ts)). `duplicate: true` means the run row already existed for the day.

**Status codes:** `200` · `401` · `500` with the fixed string `"Post-class feedback digest job failed"`.

### `GET /api/internal/post-class-feedback/reminder-day-after` · `GET .../reminder-deadline`

Two parked routes with byte-identical structure, differing only in the checkpoint they pass ([`reminder-day-after/route.ts:16`](../../../src/app/api/internal/post-class-feedback/reminder-day-after/route.ts) vs [`reminder-deadline/route.ts:16`](../../../src/app/api/internal/post-class-feedback/reminder-deadline/route.ts)). Both `manualOnly`, `dangerous`, `maxDuration = 800` ([`cron-registry.ts:207-236`](../../../src/lib/data-health/cron-registry.ts)).

**Side effects.** `runPostClassReminderJob(checkpoint, { triggerType: "cron" })` ([`reminder-job.ts:49-127`](../../../src/lib/post-class-feedback/reminder-job.ts)) refreshes **every** candidate for the checkpoint before creating any tutor delivery: it loops sync batches (each capped at 50 Wise detail calls) until the backlog drains, then dispatches `tutor_day_after` or `tutor_deadline` reminders. It checks the wall-clock budget *before* dispatch even on a batch that drained, so a slow final Wise batch never starts email work against a stale freshness timestamp ([`:82-92`](../../../src/lib/post-class-feedback/reminder-job.ts)).

**Response `200`** — `{ ok: true, result }` where `result` is `PostClassReminderJobResult` ([`reminder-job.ts:34-40`](../../../src/lib/post-class-feedback/reminder-job.ts)): `ready`, `checkpoint`, `syncRuns[]`, `reminder`, `blockedReason` (`batch_limit` | `time_limit` | `missing_checkpoint` | `null`).

**Response `503`** — the fail-closed case. When `result.ready === false`, no reminders were sent and the body is `{ ok: false, error: "...still has unreconciled Wise sessions.", result }` ([`reminder-day-after/route.ts:17-23`](../../../src/app/api/internal/post-class-feedback/reminder-day-after/route.ts)). Both `ok: false` and the ≥400 status make the audit record `failed`, which is the intent — Data Health should surface a checkpoint that could not drain.

**Status codes:** `200` · `401` · `503` not ready · `500` with a fixed per-route string.

---

## Leave requests

Feature: **Leave Requests** — status **stable**. Meaning: [docs/features/leave-requests.md](../../features/leave-requests.md).

### `GET /api/internal/sync-leave-requests` · `POST /api/internal/sync-leave-requests`

Identical handlers; both delegate to one `handle` ([`route.ts:9-36`](../../../src/app/api/internal/sync-leave-requests/route.ts)). Cron secret only — no session fallback on either method. `maxDuration = 800`. Cron `15,45 * * * *`.

**Request.** None read.

**Side effects.** `syncLeaveRequests(getDb(), { triggerType: "cron" })` inserts a `leave_request_sync_runs` row (stamped with the spreadsheet id and sheet name in `metadata`), reads the leave-form Google Sheet, matches each row to a Wise identity, computes affected sessions, and queues notifications. Single-flight is enforced by a Postgres `running`-row conflict, surfaced as `LeaveRequestSyncAlreadyRunningError` ([`sync.ts:21-26, 366-387`](../../../src/lib/leave-requests/sync.ts)).

**Response `200`** — `{ ok: true, result }` with `SyncLeaveRequestsResult` ([`sync.ts:36-42`](../../../src/lib/leave-requests/sync.ts)): `syncRunId`, `scannedRowCount`, `insertedCount`, `updatedCount`, `notificationCount`.

**Status codes:** `200` · `401` · **`409`** `{"error":"Leave request sync is already running."}` ([`route.ts:20-22`](../../../src/app/api/internal/sync-leave-requests/route.ts)) — audited as `skipped` via the `already running` substring · `500` with the **real** error message preserved ([`route.ts:23-24`](../../../src/app/api/internal/sync-leave-requests/route.ts)), unlike the post-class routes.

---

## Competitor intelligence

Feature: **Competitor Intelligence** — status **stable**. Meaning: [docs/features/competitor-intelligence.md](../../features/competitor-intelligence.md).

### `GET /api/internal/sync-competitor-intelligence` · `POST /api/internal/sync-competitor-intelligence`

The only weekly job on this page: `28 18 * * 0` UTC = Monday 01:28 Bangkok ([`cron-registry.ts:98-107`](../../../src/lib/data-health/cron-registry.ts)). `maxDuration = 800`.

**Auth.** `GET` cron-secret-only. `POST` falls back to `requireCompetitorIntelligenceSession()`, which requires a session **and** competitor-intelligence page access ([`access.ts:19-30`](../../../src/lib/competitor-intelligence/access.ts)). The route catches that helper's throw indiscriminately, so a `Forbidden` from an authenticated-but-unentitled user is reported as `401 {"error":"Unauthorized"}`, not 403 ([`route.ts:31-36`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)).

The actor email defaults to the literal `cron@begifted.local` and is overwritten with the session email on the admin path ([`route.ts:22, 33`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)); `triggerType` is `"cron"` or `"manual"` accordingly ([`route.ts:49`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)).

**Request.** None read.

**Side effects.** `runCompetitorIntelligenceSync` ([`sync.ts:494`](../../../src/lib/competitor-intelligence/sync.ts)) fails stale `running` rows, throws `"Competitor intelligence sync is already running"` if one survives ([`:507-509`](../../../src/lib/competitor-intelligence/sync.ts)), inserts a `competitor_sync_runs` row, then pulls website/social/SERP evidence through Apify and DataForSEO under the monthly USD budget cap and regenerates the daily brief.

**Response** — `{ ok: result.status === "success", result }` with `CompetitorSyncResult` ([`sync.ts:57-66`](../../../src/lib/competitor-intelligence/sync.ts)): `runId`, `status` (`success` | `failed`), `seeded: { entities, sources, keywords }`, `errorSummary`, plus the inlined `RunCounts` fields.

**Status codes:** `200` when `status === "success"` · `500` when `status === "failed"` — note the body still carries the full result, and `ok: false` makes the audit record `failed` ([`route.ts:52-54`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)) · `401` · **`409`** when the thrown message contains `already running` ([`route.ts:55-61`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)) · `500` otherwise, with the real message preserved.

---

## Admissions notifications

Feature: **University Admissions** — status **stable** (handbook maturity map notes parity-hardening code unmerged on `origin/codex/admissions-parity-hardening`; the schema landed). Meaning: [docs/features/university-admissions.md](../../features/university-admissions.md). Endpoint detail for the 60+ case-management routes: [university-admissions.md](university-admissions.md).

### `GET /api/internal/admissions-notifications` · `POST /api/internal/admissions-notifications`

One cron path covers two cadences ([`route.ts:1-7`](../../../src/app/api/internal/admissions-notifications/route.ts)). `12 1 * * *` UTC = 08:12 Bangkok. `maxDuration = 300`. Cron secret only on **both** methods — the `POST` exists for manual triggering with a body, not for session auth.

**Request — `runTypeSchema`** ([`route.ts:22-24`](../../../src/app/api/internal/admissions-notifications/route.ts)): a single optional field `runType`, `z.enum(["daily", "weekly"])`.

* `GET` reads it from the `runType` query parameter, coercing an absent value to `undefined` ([`route.ts:77-79`](../../../src/app/api/internal/admissions-notifications/route.ts)).
* `POST` reads it from an optional JSON body; an empty body is treated as `{}`, and unparseable JSON returns `400 {"error":"Invalid JSON body"}` ([`route.ts:95-103`](../../../src/app/api/internal/admissions-notifications/route.ts)).

**Dispatch rules** ([`route.ts:52-63`](../../../src/app/api/internal/admissions-notifications/route.ts)):

| `runType` | Runs |
|---|---|
| `"daily"` | daily deadline scan only |
| `"weekly"` | weekly digest only |
| absent (the cron case) | daily scan always, **plus** the weekly digest when `now` is a Bangkok Sunday ([`isBangkokSunday`, `:29-31`](../../../src/app/api/internal/admissions-notifications/route.ts)) |

Digest dedupe keys keep same-day re-runs idempotent.

**Side effects.** `runDailyNotifications` / `runWeeklyDigest` ([`notifications.ts:969, 1024`](../../../src/lib/admissions/notifications.ts)) each open a single-flight notification run and email case members; a run already in flight returns `skipped: true` with `runId: null`.

**Response.** `{ ok: true, skipped, results }` where `results` is an array of `AdmissionsNotificationRunResult` ([`notifications.ts:187-195`](../../../src/lib/admissions/notifications.ts)): `skipped`, `runId`, `runType`, `sentCount`, `skippedCount`, `errorSummary`. The top-level `skipped` is `true` only when **every** pass skipped ([`route.ts:62`](../../../src/app/api/internal/admissions-notifications/route.ts)).

**Status codes:** `200` when at least one pass ran · **`202`** when every pass skipped ([`route.ts:63`](../../../src/app/api/internal/admissions-notifications/route.ts)) — audited as `skipped` twice over (202 and the `skipped: true` key) · **`400`** `{"error":"Invalid runType","details": <Zod flatten>}`, or `{"error":"Invalid JSON body"}` on `POST` · `401` · `500` with the real message, or `"Admissions notification run failed"`.

Note the audit ordering: the secret check runs *before* `withCronInvocationAudit`, so a 401/400 leaves no `cron_invocations` row.

---

## Student promotions

Feature: **Student Promotions** — status **stable**. Meaning: [docs/features/student-promotions.md](../../features/student-promotions.md). Endpoint detail for the review/apply routes: [student-promotions.md](student-promotions.md).

### `GET /api/internal/student-promotions/july-1` · `POST /api/internal/student-promotions/july-1`

`POST` is a one-line delegation to `GET` ([`route.ts:46-48`](../../../src/app/api/internal/student-promotions/july-1/route.ts)). The only annual entry in `vercel.json`: `5 17 30 6 *` UTC = July 1, 2026 00:05 Bangkok. `maxDuration = 800`. Registered `dangerous: true` ([`cron-registry.ts:317-318`](../../../src/lib/data-health/cron-registry.ts)).

**This is the one route family on this page that does *not* wrap in `withCronInvocationAudit`** — it writes no `cron_invocations` row, so Data Health has no invocation proof for it. Its own `studentPromotionRuns` ledger is the audit trail.

**Auth.** Cron secret only, via a private copy of the helper ([`route.ts:10-17`](../../../src/app/api/internal/student-promotions/july-1/route.ts)). Unusually, the `missing-secret` branch is checked **first**, so an unset `CRON_SECRET` yields `500` even for a request that carries no header at all ([`route.ts:21-26`](../../../src/app/api/internal/student-promotions/july-1/route.ts)).

**Date gate.** After auth, the handler compares `todayBangkok()` against `STUDENT_PROMOTION_TARGET_DATE` (`"2026-07-01"`, [`rules.ts:1`](../../../src/lib/student-promotions/rules.ts)) and returns **`409`** on any other day: `{"error":"Student promotion cron is only allowed on July 1, 2026 Bangkok time"}` ([`route.ts:27-31`](../../../src/app/api/internal/student-promotions/july-1/route.ts)).

**Request.** No query or body is read on either method.

**Side effects.** `applyVerifiedStudentPromotionRun({ trigger: "cron" })` ([`data.ts:2286`](../../../src/lib/student-promotions/data.ts)) resolves the latest **verified** run, returns early and unchanged if it is already `applied` / `applied_with_errors`, and throws if it is in any other non-verified state. It then asserts run freshness, re-fetches live Wise accepted students, asserts the run still covers them, flips the run to `applying`, and executes the pending grade/course/graduation writes against Wise under a rate gate.

**Response `200`** — `{ detail: StudentPromotionRunDetail }` ([`route.ts:34-36`](../../../src/app/api/internal/student-promotions/july-1/route.ts)): the full run detail, including run header and the grade/course/graduation action rows.

**Status codes**, mapped by the shared `studentPromotionErrorResponse` ([`api.ts:29-56`](../../../src/lib/student-promotions/api.ts)): `200` · `400` when the message matches `/(required|cannot|only|must be|blocked|no verified|no pending|before July 1)/i` · `401` on a bad secret, or on a thrown literal `Unauthorized` · `404` when the message matches `/not found/i` · `409` wrong Bangkok date · `500` otherwise, with the real message and a `console.error`. A `HANGING_PROMISE_REJECTION` digest is deliberately re-thrown rather than mapped ([`api.ts:30-37`](../../../src/lib/student-promotions/api.ts)).

---

## LINE

Feature: **LINE Integration** — status **stable (scheduler write-path flag-gated)**. Meaning: [docs/features/line-integration.md](../../features/line-integration.md). Endpoint detail for the 29 `/api/line/*` routes: [line.md](line.md).

### `GET /api/internal/line-credit-digest`

The daily credit-runout push to registered staff groups. `3 2 * * *` UTC = 09:03 Bangkok ([`cron-registry.ts:343-351`](../../../src/lib/data-health/cron-registry.ts)). `maxDuration = 300`. Cron secret only. Registered `dangerous: true`.

**Request.** None read.

**Side effects.** `sendLineCreditDigest()` ([`credit-digest.ts:241`](../../../src/lib/line/credit-digest.ts)) returns `status: "skipped"` without sending in three cases ([`:262-273`](../../../src/lib/line/credit-digest.ts)):
* `lineSchedulerEnabled()` is false — i.e. `ENABLE_LINE_SCHEDULER === "false"`, or either LINE credential is blank ([`client.ts:19-23`](../../../src/lib/line/client.ts));
* a terminal digest row already exists for the Bangkok date;
* no active credit-control snapshot — and deliberately **no** terminal row is written, so a snapshot arriving later the same day can still produce the digest on a re-run ([`:271-273`](../../../src/lib/line/credit-digest.ts)).

Otherwise it reads the active snapshot's packages and upcoming future sessions, projects each package's run-out day, and pushes to every `line_group_settings` row that is both `audience = 'staff'` and `creditDigestEnabled` — re-checked at send time, so a chat later flipped to `family` drops off the target list (CRED-BOT-G1, [`:308-313`](../../../src/lib/line/credit-digest.ts)).

**Response.** The `LineCreditDigestResult` verbatim, unwrapped ([`route.ts:18`](../../../src/app/api/internal/line-credit-digest/route.ts); shape at [`credit-digest.ts:59-70`](../../../src/lib/line/credit-digest.ts)): `status` (`sent` | `partial` | `failed` | `skipped`), `digestDate`, `digestRunId`, `runsOutCount`, `alreadyOutCount`, `groupCount`, `attempted`, `success`, `failed`, `message`.

**Status codes:** `200` for every status except `failed` → `500` ([`route.ts:17`](../../../src/app/api/internal/line-credit-digest/route.ts)) · `401` · `500` on throw with the real message.

### `GET /api/internal/line-backlog-recovery`

**Manual only — no `vercel.json` entry, and no Data Health branch either**, so a direct `CRON_SECRET` call is the sole way to run it. Registered `manualOnly: true`, `dangerous: false` ([`cron-registry.ts:384-398`](../../../src/lib/data-health/cron-registry.ts)). `maxDuration = 300`. **`GET` only** — there is no `POST` handler.

**Request.** None read. Note the route hard-codes `dryRun: false` ([`route.ts:19`](../../../src/app/api/internal/line-backlog-recovery/route.ts)); the lib's dry-run mode is not reachable over HTTP.

**Side effects.** `runLineBacklogRecovery({ db, dryRun: false })` ([`backlog-recovery.ts:74`](../../../src/lib/line/backlog-recovery.ts)) paginates the full LINE follower roster, batch-fetches profiles at concurrency 10 (404 → skipped), loads human-verified OA-resolver targets, matches fresh display names against them via a token index, and inserts the accepted matches (IDENT-07). The route comment records the deliberate scope limit: `runLineFollowersReanchor` is **not** called here — this is backlog recovery only ([`route.ts:7-8`](../../../src/app/api/internal/line-backlog-recovery/route.ts)).

**Response `200`** — `{ ok: true, result }` with `LineBacklogRecoveryResult` ([`backlog-recovery.ts:40-48`](../../../src/lib/line/backlog-recovery.ts)): `contactsScanned`, `targetsCount`, `matchedCount`, `insertedCount`, `dryRun`, and `dryRunMatches?` (populated only when `dryRun` is true, so never over HTTP).

**Status codes:** `200` · `401` · `500` with the real message, or `"LINE backlog recovery failed"`.

---

## Cross-cutting notes

* **Method asymmetry is real, not cosmetic.** Vercel Cron only issues `GET`, so every scheduled path must export `GET`. The `POST` variants exist for three different reasons: a session-authenticated manual re-run (`sync-wise`, `sync-credit-control`, `sync-progress-tests`, `sync-competitor-intelligence`), a body-carrying manual trigger (`admissions-notifications`), or nothing at all beyond symmetry (`cron-watchdog`, `sync-leave-requests`, `student-promotions/july-1` all treat `POST` exactly as `GET`).
* **Error-message fidelity is inconsistent.** `sync-post-class-feedback`, `post-class-feedback-backfill`, both reminder routes, the post-class admin digest, and `payout-accrual` return fixed generic 500 strings that discard the underlying error, so `cron_invocations.errorSummary` carries less detail for those six jobs. `sync-leave-requests`, `sync-competitor-intelligence`, `cron-watchdog`, `line-credit-digest`, `line-backlog-recovery`, and `progress-tests/admin-digest` surface the real message.
* **A `409` reads as `skipped`, not `failed`.** `determineOutcome` matches the substring `already running` in `error`/`message` before it looks at the status code ([`cron-audit.ts:110-111`](../../../src/lib/data-health/cron-audit.ts)), so the single-flight collisions on `sync-post-class-feedback`, `post-class-feedback-backfill`, `sync-leave-requests`, and `sync-competitor-intelligence` do not pollute the failure rate.
* **Two endpoints leave no audit trail.** `GET`/`POST /api/internal/student-promotions/july-1` never call `withCronInvocationAudit`, so Data Health derives that job's health from registry expectation alone, with no invocation proof.
* **`maxDuration` and the registry can drift.** Health derivation uses `cron-registry.ts`'s `maxDurationSeconds`, not the route's `export const maxDuration`. The credit-control pair was the documented instance of this drift and has since been reconciled at 800 ([`cron-registry.ts:119-122`](../../../src/lib/data-health/cron-registry.ts) vs [`sync-credit-control/route.ts:14`](../../../src/app/api/internal/sync-credit-control/route.ts)). Of the endpoints here, `sync-progress-tests` (route 300 / registry 300) and every other pair currently agree.

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
