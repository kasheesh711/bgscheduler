# Internal / Cron API

Machine-to-machine endpoints that drive the scheduled pipelines. They are invoked by Vercel Cron (always HTTP `GET` — Vercel only issues `GET`) and by operators for manual reruns. All live under `/api/internal/*`, which `src/middleware.ts:18` exempts from the session auth gate, so every route enforces its own `CRON_SECRET` check instead.

This page documents the **mechanical HTTP contract** only — method, auth, request shape, response shape, side effects, status codes. For what each pipeline *means* (what a snapshot is, why syncs fail closed, the data-integrity rules), see the corresponding feature docs.

> **Scope.** This page covers 24 endpoints. Five other `/api/internal/*` routes exist in the tree (`sync-sales-dashboard`, `sync-wise-activity`, `sync-room-utilization`, `class-assignments/morning`, `class-assignments/admin-email`) and are documented with their owning features.

---

## Conventions shared by these endpoints

### `CRON_SECRET` bearer auth

Every route requires `Authorization: Bearer $CRON_SECRET`. The comparison is constant-time (`node:crypto.timingSafeEqual`) behind a length pre-check, which avoids the `RangeError` that `timingSafeEqual` throws on length-mismatched buffers and does not itself leak the secret length (`src/lib/internal/cron-auth.ts:6`-`17`).

Four routes carry a private copy of that helper instead of importing the shared one — `sync-wise` (`src/app/api/internal/sync-wise/route.ts:11`-`29`), `sync-credit-control` (`src/app/api/internal/sync-credit-control/route.ts:18`-`31`), `sync-competitor-intelligence` (`src/app/api/internal/sync-competitor-intelligence/route.ts:11`-`18`), and `student-promotions/july-1` (`src/app/api/internal/student-promotions/july-1/route.ts:10`-`17`). Behaviour is identical. `sync-progress-tests` imports the shared `getCronSecretStatus`; every remaining route imports the shared `rejectInvalidCronSecret`.

Three outcomes are distinguished, and the third is the important one:

| Secret state | Response |
|---|---|
| header matches | proceed |
| header missing/wrong | `401 {"error":"Unauthorized"}` |
| `process.env.CRON_SECRET` unset | `500 {"error":"Server misconfigured"}` |

The misconfiguration case is deliberately **not** a `401`, so an unset env var cannot masquerade as a routine auth failure (`src/lib/internal/cron-auth.ts:22`-`25`).

### Session fallback on `POST`

Four routes accept an Auth.js session as an alternative to the secret, and only on `POST` (`GET` passes `allowSessionAuth: false`): `sync-wise`, `sync-credit-control`, `sync-progress-tests`, `sync-competitor-intelligence`. When the session path is taken, the audit row records `triggerSource: "admin"` plus the actor email instead of `"cron"`. `sync-competitor-intelligence` is stricter than the others — it calls `requireCompetitorIntelligenceSession()`, which additionally checks page access and throws `Unauthorized`/`Forbidden` (`src/lib/competitor-intelligence/access.ts:19`-`29`); the route collapses both into `401` (`src/app/api/internal/sync-competitor-intelligence/route.ts:34`-`36`).

The remaining `POST` handlers (`cron-watchdog`, `sync-leave-requests`, `admissions-notifications`, `student-promotions/july-1`) require the secret on both methods.

### Cron invocation audit

All routes except `student-promotions/july-1` wrap their work in `withCronInvocationAudit()` (`src/lib/data-health/cron-audit.ts:144`-`159`). It inserts a `cron_invocations` row with `outcome: "running"` before the handler (`:84`-`112`), then updates it with duration, response status, error summary, and linked run ids afterwards (`:114`-`142`). Outcome classification reads the JSON body, not just the status: `skipped: true` or an `error`/`message` containing "already running" → `skipped`; `ok: false` / `success: false` → `failed`; HTTP `202` → `skipped`; HTTP `>= 400` → `failed` (`:61`-`70`). A thrown handler is converted to `500 {"error": <message>}` and still audited (`:152`-`158`).

The `jobKey` passed here must exist in `src/lib/data-health/cron-registry.ts:46`-`373`, otherwise no row is written (`src/lib/data-health/cron-audit.ts:85`-`86`).

### Single-flight

Every pipeline refuses to overlap with itself, but the mechanism differs per family: a `*_sync_runs` `running`-row check with 20-minute stale recovery (Wise, credit control, progress tests, competitor intelligence), a repository-level lock that raises a typed `…AlreadyRunningError` (post-class feedback, leave requests), a Postgres advisory lock inside a transaction (post-class admin digest), a partial unique index on the running row (admissions notifications), or a sentinel-row upsert lock (cron watchdog). Details are in each section.

### Schedules

Only the paths on this page are listed; schedules come from `vercel.json`, the Bangkok cadence labels from the registry.

| Path | Cron (UTC) | Cadence | Source |
|---|---|---|---|
| `/api/internal/sync-wise` | `*/30 * * * *` | Every 30 min | `vercel.json:4`-`5` |
| `/api/internal/sync-competitor-intelligence` | `25 18 * * 0` | Weekly, Mon 01:25 Bangkok | `vercel.json:12`-`13`, `cron-registry.ts:97`-`98` |
| `/api/internal/sync-credit-control` | `20,50 * * * *` | Every 30 min | `vercel.json:16`-`17` |
| `/api/internal/sync-progress-tests` | `25,55 * * * *` | Every 30 min | `vercel.json:20`-`21` |
| `/api/internal/progress-tests/admin-digest` | `35 0 * * *` | Daily 07:35 Bangkok | `vercel.json:24`-`25`, `cron-registry.ts:145` |
| `/api/internal/sync-post-class-feedback` | `13,43 * * * *` | Every 30 min | `vercel.json:32`-`33` |
| `/api/internal/post-class-feedback-backfill` | `23,53 * * * *` | Every 30 min | `vercel.json:36`-`37` |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` | Every 30 min | `vercel.json:40`-`41` |
| `/api/internal/student-promotions/july-1` | `5 17 30 6 *` | Once, 2026-07-01 00:05 Bangkok | `vercel.json:52`-`53`, `cron-registry.ts:302` |
| `/api/internal/cron-watchdog` | `7,37 * * * *` | Every 30 min | `vercel.json:56`-`57` |
| `/api/internal/admissions-notifications` | `12 1 * * *` | Daily 08:12 Bangkok | `vercel.json:60`-`61`, `cron-registry.ts:318` |

**Not scheduled** (no `vercel.json` entry; registered `manualOnly: true` so Data Health never reports them late): `/api/internal/post-class-feedback/admin-digest`, `/api/internal/post-class-feedback/reminder-day-after`, `/api/internal/post-class-feedback/reminder-deadline`, `/api/internal/post-class-feedback/payout-accrual` (`cron-registry.ts:188`-`247`), and `/api/internal/line-backlog-recovery` (`cron-registry.ts:358`-`372`).

### Relationship to the Data Health "Run now" button

`POST /api/data-health/jobs/{jobKey}/run` is a **separate** admin-session route — it does not call these `/api/internal/*` URLs. It re-invokes the same library functions in-process under `triggerSource: "admin"`, requires an Auth.js session, adds an `access_manager` capability check for `post_class_feedback*` keys, and returns `409 {"error":"Confirmation required","confirmationLabel":…}` unless the body carries `confirmed: true` for a `dangerous` job (`src/app/api/data-health/jobs/[jobKey]/run/route.ts:13`-`43`). It dispatches only 14 of the 21 registered job keys (`src/lib/data-health/run-job.ts:42`-`193`); every other key falls through to `404 {"error":"Unknown job"}` — see Open questions.

---

## Wise snapshot sync

Runs the full Wise ETL (`runFullSync`): fetch teachers/availability/leaves/sessions → normalize → write snapshot tables → validate → atomically promote. `maxDuration = 800` (`src/app/api/internal/sync-wise/route.ts:7`). Feature doc: [tutor-search](../../features/tutor-search.md).

### `GET /api/internal/sync-wise`

- **Auth:** `CRON_SECRET` only — `allowSessionAuth: false` (`route.ts:69`-`71`).
- **Request:** no query params, no body, no Zod schema.

### `POST /api/internal/sync-wise`

- **Auth:** `CRON_SECRET`, or any logged-in Auth.js session when the secret check is not `valid` (`route.ts:45`-`59`, `74`-`76`). Session runs are audited as `triggerSource: "admin"` with `actorEmail` from the session.
- **Request:** none.

### Behaviour (both methods)

Both delegate to `runWiseSyncRequest()` (`src/lib/sync/run-wise-sync.ts:142`-`167`), audited under `jobKey: "wise_snapshot"`.

Single-flight (`acquireSyncRun`, `run-wise-sync.ts:88`-`118`):

1. `UPDATE` any `sync_runs` row that has been `running` longer than 20 minutes (`STALE_RUNNING_SYNC_MS`, `:10`) to `failed` with a fixed error summary (`:51`-`72`).
2. If a `running` row still exists, skip.
3. Otherwise insert a fresh `running` row. A `23505` unique violation is read as a concurrent insert and also yields the skip payload (`:106`-`117`).

**Side effects:** writes `sync_runs`; on a full run writes the snapshot tables and promotes the new active `snapshots` row (`src/lib/sync/orchestrator.ts`); calls `revalidateTag("snapshot", { expire: 0 })` only when `result.success` is true (`run-wise-sync.ts:160`-`162`).

| Status | When | Body |
|---|---|---|
| `200` | `result.success === true` | `SyncResult` + `staleRunningSyncsFailed` |
| `202` | A run was already in flight | skip payload (`run-wise-sync.ts:120`-`140`) |
| `401` | Bad secret and (POST) no session | `{"error":"Unauthorized"}` |
| `500` | `result.success === false` | `SyncResult` with `success:false`, `errorSummary` |
| `500` | `CRON_SECRET` unset | `{"error":"Server misconfigured"}` |

`SyncResult` (`src/lib/sync/orchestrator.ts:22`-`32`), augmented at the route with `staleRunningSyncsFailed: number`:

```jsonc
{
  "success": true,
  "syncRunId": "<uuid>",
  "snapshotId": "<uuid|null>",
  "promotedSnapshotId": "<uuid|null>",
  "teacherCount": 0,
  "groupCount": 0,
  "issueCount": 0,
  "errorSummary": null,
  "durationMs": 0,
  "staleRunningSyncsFailed": 0
}
```

The `202` skip payload keeps the same keys with counts zeroed and adds `skipped: true`, `alreadyRunning: true`, `message`, and `runningStartedAt` (ISO) (`run-wise-sync.ts:22`-`37`, `:120`-`140`).

---

## Credit control sync

`maxDuration = 800`. The route comment records why: successful runs take 372-390 s, so the old 300 s ceiling guaranteed a timeout, which strands the `credit_control_sync_runs` row in `running` until the watchdog fails it (`src/app/api/internal/sync-credit-control/route.ts:7`-`14`). Feature doc: [credit-control](../../features/credit-control.md).

### `GET /api/internal/sync-credit-control`

- **Auth:** `CRON_SECRET` only (`route.ts:65`-`67`).
- **Request:** none.

### `POST /api/internal/sync-credit-control`

- **Auth:** `CRON_SECRET` or an Auth.js session (`route.ts:43`-`56`, `69`-`71`).
- **Request:** none.

### Behaviour

Delegates to `runCreditControlSyncRequest()` (`src/lib/credit-control/run-sync-request.ts:138`-`160`), audited under `jobKey: "credit_control"`. The single-flight guard mirrors the Wise one against `credit_control_sync_runs`, with the same 20-minute stale window (`:9`, `:50`-`68`, `:106`-`136`).

**Side effects:** writes `credit_control_sync_runs`; on success writes the credit-control snapshot tables and promotes the new snapshot (`runCreditControlSync`).

| Status | When | Body |
|---|---|---|
| `200` | `result.success === true` | `CreditControlSyncResult` + `syncRunId` + `staleRunningSyncsFailed` (`run-sync-request.ts:153`-`159`) |
| `202` | Already running | skip payload (`:84`-`104`) |
| `401` / `500` | auth | as per the shared table |
| `500` | `result.success === false` | same body with `success:false` |

`CreditControlSyncResult` (`src/lib/credit-control/sync.ts:49`-`58`): `success`, optional `snapshotId` / `promotedSnapshotId` / `errorSummary`, plus `studentCount`, `packageCount`, `sessionCount`, `failedCreditPairs`.

---

## Progress tests

Feature doc: [progress-tests](../../features/progress-tests.md).

### `GET /api/internal/sync-progress-tests` · `POST /api/internal/sync-progress-tests`

`maxDuration = 300` (`src/app/api/internal/sync-progress-tests/route.ts:7`).

- **Auth:** `GET` requires `CRON_SECRET`; `POST` also accepts an Auth.js session (`route.ts:41`-`47`).
- **Request:** none.
- **Trigger propagation:** the cron path runs `runProgressTestSyncRequest({ triggerType: "cron" })`; the session path passes `triggerType: "admin"` plus the actor email, and both are persisted on the `progress_test_sync_runs` row (`route.ts:12`-`31`, `src/lib/progress-tests/run-sync-request.ts:117`-`120`).

Single-flight uses the same pattern against `progress_test_sync_runs` with a 20-minute stale window (`src/lib/progress-tests/config.ts:27`, `run-sync-request.ts:103`-`135`).

| Status | When | Body |
|---|---|---|
| `200` | success | `ProgressTestSyncResult` + `syncRunId` + `staleRunningSyncsFailed` (`run-sync-request.ts:158`-`164`) |
| `202` | Already running | skip payload (`:82`-`101`) |
| `401` / `500` | auth | shared table |
| `500` | `success:false` | same body |

`ProgressTestSyncResult` (`src/lib/progress-tests/sync.ts:75`-`84`): `success`, `ledgerRowCount`, `enrollmentCount`, `approachingCount`, `dueCount`, `unresolvedTeacherCount`, `notificationCount`, optional `errorSummary`. The `202` skip payload omits `notificationCount` (`run-sync-request.ts:23`-`37`).

### `GET /api/internal/progress-tests/admin-digest`

`maxDuration = 300` (`src/app/api/internal/progress-tests/admin-digest/route.ts:6`).

- **Auth:** `CRON_SECRET` only; no `POST` handler exists.
- **Request:** none.
- **Side effects:** sends the once-daily digest email to every `admin_users` recipient and records `progress_test_admin_digest_runs` / `…_recipients` rows. The per-date unique index on the run row is the single-flight guard, and a terminal run for today short-circuits the whole job (`src/lib/progress-tests/admin-digest.ts:295`-`330`).
- **Response:** the `ProgressTestAdminDigestResult` object itself, not wrapped (`route.ts:16`-`18`): `status` (`"sent" | "partial" | "failed" | "skipped"`), `digestDate`, `digestRunId`, `approachingCount`, `dueCount`, `unresolvedCount`, `attempted`, `success`, `failed`, `message` (`admin-digest.ts:32`-`43`).
- **Status codes:** `200` for every status except `"failed"`, which maps to `500` while still returning the result body; a thrown error → `500 {"error": <message>}` (`route.ts:17`-`23`).

---

## Post-class feedback

Six endpoints, all `GET`-only. Two are scheduled (collector + backfill); four are parked with no `vercel.json` entry and are marked `dangerous` in the registry because they send email or write payout ledger rows. Feature doc: [post-class-feedback](../../features/post-class-feedback.md).

### `GET /api/internal/sync-post-class-feedback`

The rolling collector. `maxDuration = 800` (`route.ts:12`).

- **Auth:** `CRON_SECRET` (`route.ts:15`-`16`).
- **Request:** none — the route reads no query params and no body.
- **Work:** `runPostClassFeedbackSync({ triggerType: "cron" })`, then AI review processing and due notification retries in parallel via `Promise.allSettled`, so neither can fail the sync (`route.ts:21`-`25`).
- **Response `200`:**

```jsonc
{
  "ok": true,
  "result":  { /* SyncPostClassFeedbackResult */ },
  "ai":      { "processed": 0, "failed": 0, "skipped": 0 },   // or { "failed": true }
  "retries": { "considered": 0, "sent": 0, "failed": 0, "cancelled": 0, "deferred": 0 }
}
```

A rejected settled promise degrades to `{ "failed": true }` for that key (`route.ts:29`-`30`). Sub-shapes: `src/lib/post-class-feedback/ai.ts:348`, `…/notifications.ts:1106`-`1112`.

`SyncPostClassFeedbackResult` (`src/lib/post-class-feedback/sync.ts:97`-`116`): `runId`, `status` (`"success" | "partial"`), `windowStart`, `windowEnd`, `discoveredCount`, `candidateCount`, `windowCandidateCount`, `detailFetchedCount`, `sessionSavedCount`, `sourceIssueCount`, `checkpoint`. `windowCandidateCount` is the "is this window finished" signal — `candidateCount` counts all three lanes and pins at the cap when the recheck queue is saturated (`sync.ts:103`-`111`).

- **`409`:** `PostClassFeedbackSyncAlreadyRunningError` → `{"error":"Post-class feedback sync is already running."}` (`route.ts:33`-`35`, `…/repository.ts:266`-`271`).
- **`500`:** any other error → `{"error":"Post-class feedback sync failed"}`, with the underlying message swallowed (`route.ts:36`).

### `GET /api/internal/post-class-feedback-backfill`

Drains history that the rolling four-day collector window cannot reach. `maxDuration = 800` (`route.ts:12`).

- **Auth:** `CRON_SECRET`.
- **Query (Zod `QuerySchema`, `route.ts:21`-`30`)** — parsed from `Object.fromEntries(searchParams)` with `.safeParse()`:

  | Param | Type | Notes |
  |---|---|---|
  | `startDate` | string, `^\d{4}-\d{2}-\d{2}$` | optional |
  | `endDate` | string, `^\d{4}-\d{2}-\d{2}$` | optional |
  | `detailCap` | `z.coerce.number().int().min(1).max(400)` | optional; route default `50` |
  | `maxBatches` | `z.coerce.number().int().min(1).max(50)` | optional; route default `1` |

  Two refinements: `startDate` and `endDate` must be supplied together, and `startDate <= endDate`. Failure → `400 {"error": <flattened Zod error>}` (`route.ts:39`-`41`).
- **Window selection:** with no explicit dates the route calls `findOldestUnreconciledBackfillWindow()`, which anchors on the oldest eligible session whose `sourceStatus` is not `ready` and takes four Bangkok calendar days forward, clamped to today (`src/lib/post-class-feedback/backfill-window.ts:17`, `:32`-`54`). `null` means everything is reconciled → `200 {"ok":true,"skipped":"nothing-unreconciled"}` (`route.ts:54`-`59`).
- **Defaults rationale:** the cron stays at one 50-detail batch so routine runs never monopolise the Wise API; the 400/50 ceilings exist for manual recovery (`route.ts:64`-`68`).
- **Response `200`:** `{ "ok": true, "window": { "startDate": …, "endDate": … }, "result": PostClassBackfillJobResult }`. The job result (`backfill-job.ts:27`-`38`) carries `startDate`, `endDate`, `batches`, `detailFetchedCount`, `sessionSavedCount`, `sourceIssueCount`, `syncRuns[]`, `drained`, and `stoppedReason` (`"drained" | "batch_limit" | "time_limit"`).
- **Errors:** already-running → `409 {"error": <message>}`; anything else → `500 {"error":"Post-class feedback backfill failed"}` (`route.ts:71`-`79`).

### `GET /api/internal/post-class-feedback/reminder-day-after` · `GET /api/internal/post-class-feedback/reminder-deadline`

Parked tutor-reminder checkpoints; identical structure, differing only in the checkpoint name and `jobKey` (`post_class_feedback_day_after` / `post_class_feedback_deadline`). `maxDuration = 800` on both.

- **Auth:** `CRON_SECRET`. **Request:** none.
- **Work:** `runPostClassReminderJob("day_after" | "deadline", { triggerType: "cron" })` — refresh every candidate for the checkpoint (each sync capped at 50 Wise detail calls) before any tutor delivery is created (`src/lib/post-class-feedback/reminder-job.ts:42`-`52`).
- **Fail-closed dispatch:** when the route budget cannot drain the checkpoint, `result.ready` is false and the route returns **`503`** with `{"ok": false, "error": …, "result": …}` rather than sending partial reminders (`reminder-day-after/route.ts:17`-`23`; `reminder-deadline/route.ts:17`-`23`). Data Health then records a recoverable failed invocation.
- **`200`:** `{ "ok": true, "result": PostClassReminderJobResult }` — `ready`, `checkpoint`, `syncRuns[]`, `reminder` (a `PostClassReminderResult` or `null`), `blockedReason` (`"batch_limit" | "time_limit" | "missing_checkpoint" | null`) (`reminder-job.ts:34`-`40`). `PostClassReminderResult` is `runId`, `duplicate`, `eligible`, `deliveries`, `sent`, `failed`, `cancelled`, `unresolvedRecipients` (`notifications.ts:48`-`57`).
- **`500`:** `{"error":"Post-class <day-after|deadline> reminder job failed"}`.

### `GET /api/internal/post-class-feedback/admin-digest`

Parked daily admin digest. `maxDuration = 300`.

- **Auth:** `CRON_SECRET`. **Request:** none.
- **Side effects:** inside one transaction it takes `pg_advisory_xact_lock(hashtext(key))` on a per-Bangkok-date idempotency key, upserts the `post_class_notification_runs` row, cancels deliveries for recipients who are no longer active, and creates a per-recipient delivery row with its own idempotency key; delivery attempts run after the transaction commits (`notifications.ts:1115`-`1205`).
- **Response `200`:** `{ "ok": true, "digest": { "duplicate": bool, "sent": n, "failed": n } }` (`route.ts:16`-`17`, `notifications.ts:1201`-`1205`).
- **`500`:** `{"error":"Post-class feedback digest job failed"}` (`route.ts:18`-`19`).

### `GET /api/internal/post-class-feedback/payout-accrual`

Parked and flagged `dangerous` — it appends real payout deductions to the master ledger (`cron-registry.ts:245`). `maxDuration = 800`.

- **Auth:** `CRON_SECRET`. **Request:** none.
- **Work:** runs the accrual pass unconditionally, then the finalize pass. One invocation is therefore always "accrue, then finalize if the window has ended" (`route.ts:12`-`17`, `:30`-`31`).
  - `runPayoutAccrualPass` runs the auto-approval/reopen sweep, previews the run for the current 26th-to-25th window, and publishes in `mode: "accrual"` so it can never mint `published` and never touches the CSV/Drive leg (`src/lib/post-class-feedback/payout-accrual.ts:77`-`114`). Nothing pending → `{ "skipped": "nothing-pending" }` (`:89`).
  - `runPayoutFinalizePass` targets the oldest un-finalized ended window, else the window anchored to today's Bangkok calendar month; when none qualifies it returns `{ "skipped": "window-not-ended" }` (`:172`-`207`).
  - Both convert a `PostClassConflictError` (lease held, source sync active, stale token/version) into `{ "skipped": <message> }` so the next tick retries (`:106`-`112`, `:200`-`206`).
- **Response `200`:** `{ "ok": true, "accrual": …, "finalize": … }`, each either a `{ skipped }` object or a full `PayoutRunView`.
- **`500`:** `{"error":"Post-class payout accrual failed"}` (`route.ts:33`-`38`).

---

## Leave requests

Feature doc: [leave-requests](../../features/leave-requests.md).

### `GET /api/internal/sync-leave-requests` · `POST /api/internal/sync-leave-requests`

`maxDuration = 800` (`route.ts:7`). Both methods run the same handler; there is no session fallback (`route.ts:9`-`36`).

- **Auth:** `CRON_SECRET` on both methods.
- **Request:** none.
- **Work:** `syncLeaveRequests(getDb(), { triggerType: "cron" })` — the trigger is hard-coded to `"cron"` even for a manual `POST` (`route.ts:17`).
- **Response `200`:** `{ "ok": true, "result": SyncLeaveRequestsResult }`, where the result is `syncRunId`, `scannedRowCount`, `insertedCount`, `updatedCount`, `notificationCount` (`src/lib/leave-requests/sync.ts:36`-`42`).
- **`409`:** `LeaveRequestSyncAlreadyRunningError` → `{"error":"Leave request sync is already running."}` (`route.ts:20`-`22`, `sync.ts:21`-`26`).
- **`500`:** `{"error": <error message>}` — unlike the post-class routes, the real message is surfaced (`route.ts:23`-`24`).

---

## Competitor intelligence

Feature doc: [competitor-intelligence](../../features/competitor-intelligence.md).

### `GET /api/internal/sync-competitor-intelligence` · `POST /api/internal/sync-competitor-intelligence`

`maxDuration = 800` (`route.ts:7`).

- **Auth:** `GET` requires `CRON_SECRET`. `POST` falls back to `requireCompetitorIntelligenceSession()`, which requires an Auth.js session *and* competitor-intelligence page access; both its `Unauthorized` and `Forbidden` throws are flattened to `401` here (`route.ts:20`-`37`, `70`-`72`).
- **Request:** none.
- **Actor:** `"cron@begifted.local"` on the secret path, the session email otherwise; the same branch drives `triggerType: "cron" | "manual"` and the audit `triggerSource` (`route.ts:22`, `:42`-`50`).
- **Single-flight:** `runCompetitorIntelligenceSync` fails stale runs, then throws `Competitor intelligence sync is already running` if a `competitor_sync_runs` row is still `running` (`src/lib/competitor-intelligence/sync.ts:501`-`509`).
- **Response:** `{ "ok": <result.status === "success">, "result": CompetitorSyncResult }` with HTTP `200` on success and `500` when `result.status === "failed"` (`route.ts:52`-`54`). `CompetitorSyncResult` extends the run counts with `runId`, `status`, `seeded: { entities, sources, keywords }`, `errorSummary` (`sync.ts:57`-`66`).
- **`409`:** thrown errors whose message contains `"already running"` (`route.ts:57`-`60`).
- **`500`:** any other thrown error, message surfaced.

---

## Admissions notifications

Feature doc: [university-admissions](../../features/university-admissions.md).

### `GET /api/internal/admissions-notifications` · `POST /api/internal/admissions-notifications`

One path covers both cadences. `maxDuration = 300` (`route.ts:20`).

- **Auth:** `CRON_SECRET` on both methods (`route.ts:74`-`75`, `92`-`93`).
- **Request — Zod `runTypeSchema` = `{ runType?: "daily" | "weekly" }`** (`route.ts:22`-`24`):
  - `GET` reads it from the `?runType=` query param (`route.ts:77`-`79`).
  - `POST` reads it from an optional JSON body; an empty body is treated as `{}`, and malformed JSON returns `400 {"error":"Invalid JSON body"}` (`route.ts:95`-`103`).
  - A parse failure returns `400 {"error":"Invalid runType","details": <flattened>}`.
- **Dispatch (`route.ts:56`-`61`):**
  - `runType: "daily"` → daily deadline scan only.
  - `runType: "weekly"` → weekly digest only.
  - omitted (the Vercel cron case) → the daily scan always, plus the weekly digest when `now` is a Sunday in the Bangkok calendar (`isBangkokSunday`, `route.ts:29`-`31`).
- **Single-flight:** each pass inserts an `admissions_notification_runs` row with `status: "running"` after sweeping abandoned rows; a unique violation on `admissions_notification_runs_single_running_idx` is the skip signal (`src/lib/admissions/notifications.ts:901`-`919`).
- **Side effects:** sends admissions deadline-reminder emails to case members and, on Sundays, the weekly digest for every `active`/`committed` non-deleted case (`notifications.ts:969`-`1060`). Digest dedupe keys keep same-day re-runs idempotent.
- **Response:** `{ "ok": true, "skipped": bool, "results": AdmissionsNotificationRunResult[] }`. Status is `202` when **every** pass was skipped by its single-flight guard, `200` otherwise (`route.ts:62`-`63`). Each result is `{ skipped, runId, runType, sentCount, skippedCount, errorSummary }` (`notifications.ts:187`-`195`).
- **`500`:** `{"error": <message>}` on a top-level orchestrator throw (`route.ts:64`-`67`).

---

## Student promotions (July 1, 2026)

Feature doc: [student-promotions](../../features/student-promotions.md).

### `GET /api/internal/student-promotions/july-1` · `POST /api/internal/student-promotions/july-1`

`maxDuration = 800` (`route.ts:8`). `POST` simply calls `GET(request)` (`route.ts:46`-`48`), so the two are contractually identical.

- **Auth:** `CRON_SECRET` only, via the route-local constant-time check (`route.ts:10`-`26`).
- **Request:** none.
- **Date gate:** if `todayBangkok()` is not `STUDENT_PROMOTION_TARGET_DATE` (`"2026-07-01"`, `src/lib/student-promotions/rules.ts:1`) the route returns **`409`** `{"error":"Student promotion cron is only allowed on July 1, 2026 Bangkok time"}` before doing any work (`route.ts:27`-`31`). A second, independent guard inside `applyVerifiedStudentPromotionRun` rejects application before the target instant (`src/lib/student-promotions/data.ts:2289`-`2291`).
- **Side effects (real Wise writes):** marks the latest verified run `applying`, then applies pending grade actions, pending course actions, and selected graduation actions against Wise under a rate gate — after asserting run freshness and that the run still covers the live accepted-student roster (`data.ts:2286`-`2343`). Registry flags this job `dangerous` (`cron-registry.ts:307`-`308`).
- **Response `200`:** `{ "detail": StudentPromotionRunDetail }` — run row, the four action collections, pay-rate impacts, freshness, and a summary counter block (`data.ts:66`-`97`).
- **Errors** go through `studentPromotionErrorResponse` (`src/lib/student-promotions/api.ts:29`-`56`), which maps: `"Unauthorized"` → `401`; a message matching `/not found/i` → `404`; a message matching `/(required|cannot|only|must be|blocked|no verified|no pending|before July 1)/i` → `400`; otherwise `500` with the message. Next.js `HANGING_PROMISE_REJECTION` digests are rethrown untouched (`api.ts:30`-`37`).
- **No audit row.** This is the only endpoint on this page that does not wrap its work in `withCronInvocationAudit`, even though `student_promotions_july_1` is a registered job key (`cron-registry.ts:297`) — see Open questions.

---

## LINE backlog recovery

Feature doc: [line-integration](../../features/line-integration.md).

### `GET /api/internal/line-backlog-recovery`

Manual-only; no `vercel.json` entry. `maxDuration = 300`, sized for scanning ~1,962 contacts plus in-memory matching (`route.ts:7`-`9`).

- **Auth:** `CRON_SECRET`. No `POST` handler.
- **Request:** none — `dryRun: false` is hard-coded, so this endpoint always writes (`route.ts:19`).
- **Work:** paginate the full LINE follower roster, batch-fetch profiles (concurrency 10, 404 → skipped), load human-verified OA-resolver targets, token-index and match, then upsert contacts and insert suggested links (`src/lib/line/backlog-recovery.ts:74`-`158`). The route explicitly does **not** call `runLineFollowersReanchor` (`route.ts:8`). Inserted links are always `status: "suggested"`, never `verified`.
- **Response `200`:** `{ "ok": true, "result": LineBacklogRecoveryResult }` — `contactsScanned`, `targetsCount`, `matchedCount`, `insertedCount`, `dryRun`, plus `dryRunMatches` only when `dryRun` is true, which this route never sets (`backlog-recovery.ts:40`-`48`).
- **`500`:** `{"error": <message>}` (`route.ts:21`-`24`).

---

## Cron watchdog

Feature doc: [data-health](../../features/data-health.md).

### `GET /api/internal/cron-watchdog` · `POST /api/internal/cron-watchdog`

Sweeps every registered cron job using the same health derivation as `/data-health` and emails admins when jobs turn unhealthy. `maxDuration = 300` (`route.ts:7`); both methods run the same handler with no session fallback (`route.ts:9`-`34`).

- **Auth:** `CRON_SECRET` on both methods.
- **Request:** none.
- **Sweep (`src/lib/internal/cron-watchdog.ts:363`-`408`):**
  1. Load registry job health, plus a synthetic `post_class_payout_window` entry derived from payout-window staleness. A failure in that payout check is logged and degraded to "no payout entry this sweep" rather than failing the sweep (`:118`-`136`).
  2. Claim a single-flight sweep lock — a sentinel `cron_alert_state` row (`__watchdog_sweep_lock`) taken via one conditional upsert, reclaimable after 6 minutes (`:46`-`49`, `:298`-`323`). neon-http has neither transactions nor session advisory locks, hence the row-based lock.
  3. Classify: `checked` = every non-`manualOnly` job except the watchdog itself; `unhealthy` = status `failing`/`late`/`unknown`; `newAlerts` = unhealthy jobs with no open episode; `recoveries` = healthy jobs whose episode is still open (`:152`-`171`).
  4. Email one digest to all full-access `admin_users` (rows with `allowedPages IS NULL`) (`:255`-`262`, called at `:426`).
  5. Persist episode state only after at least one delivery succeeded, so a total delivery failure retries next sweep (`:454`-`457`, `:466`-`491`).
  6. Release the lock.
- **Response `200`:** `{ "ok": true, ...CronWatchdogSummary }` (`route.ts:17`-`18`) — `checked`, `unhealthy`, `alertsSent`, `recoveries`, `emailRecipients`, `skippedReason` (`cron-watchdog.ts:61`-`68`). `skippedReason` is one of `null`, `"cron_alert_state table unavailable"`, `"another sweep is in flight"`, `"no admin recipients"`, `"email delivery failed"`.
- **Fail-safe:** if `cron_alert_state` does not exist yet (pg `42P01`, detected on both the error and its `cause`), alerting is disabled for that sweep instead of sending un-deduped spam — still HTTP `200`, with the reason in `skippedReason` (`:271`-`289`, `:375`-`389`).
- **`500`:** `{"error": <message>}` on a thrown sweep (`route.ts:19`-`23`).

---

## Open questions

- `cron-registry.ts:118` declares `maxDurationSeconds: 300` for `credit_control`, but `src/app/api/internal/sync-credit-control/route.ts:14` sets `maxDuration = 800` (deliberately raised, per the comment at `:7`-`13`). The registry value looks stale and feeds the Data Health job list.
- `/api/internal/student-promotions/july-1` is the only endpoint here that does not call `withCronInvocationAudit`, so no `cron_invocations` row is written for `student_promotions_july_1` and Data Health cannot observe its runs directly.
- `POST /api/internal/sync-leave-requests` hard-codes `triggerType: "cron"` (`route.ts:17`), so a manual rerun is recorded on the sync run as a cron trigger. Unclear whether that is intentional.
- Seven registered job keys have no branch in `src/lib/data-health/run-job.ts` — `progress_tests`, `progress_tests_digest`, `post_class_feedback_backfill`, `post_class_feedback_payout_accrual`, `student_promotions_july_1`, `admissions_notifications`, `line_backlog_recovery` — so `POST /api/data-health/jobs/{jobKey}/run` returns `404 {"error":"Unknown job"}` for them (`run-job.ts:195`). Notably that includes the parked `post_class_feedback_payout_accrual` and `line_backlog_recovery`, whose only invocation path is a direct `CRON_SECRET` call.
- Four routes (`sync-wise`, `sync-credit-control`, `sync-competitor-intelligence`, `student-promotions/july-1`) duplicate the `CRON_SECRET` check instead of importing `src/lib/internal/cron-auth.ts`. Behaviour matches today; whether the duplication is deliberate is not recorded in the code.
- `sync-post-class-feedback`, `post-class-feedback-backfill`, the two reminder routes, the post-class admin digest, and `payout-accrual` return generic `500` strings that discard the underlying error message, unlike `sync-leave-requests` and `sync-competitor-intelligence` which surface it. The `cron_invocations.errorSummary` therefore carries less detail for those jobs.

_Verified against HEAD + uncommitted WIP on 2026-05-31._
