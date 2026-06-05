# Internal / Cron API

Machine-to-machine endpoints that drive the scheduled ETL and automation pipelines. They are invoked by Vercel Cron (HTTP `GET`) on a staggered schedule and by operators for manual reruns (HTTP `POST`). All endpoints documented here live under `/api/internal/*`, which `src/middleware.ts` exempts from the session auth gate — each route enforces its own `CRON_SECRET` check (and, on some `POST` variants, an Auth.js session fallback) instead.

This page documents only the mechanical HTTP contract. For the **meaning** of each pipeline (what a snapshot is, why syncs fail-closed, the data-integrity rules), see the corresponding feature docs.

This file covers exactly these 11 endpoints:

| Method | Path |
|--------|------|
| GET, POST | `/api/internal/sync-wise` |
| GET, POST | `/api/internal/sync-credit-control` |
| GET, POST | `/api/internal/sync-progress-tests` |
| GET, POST | `/api/internal/sync-leave-requests` |
| GET, POST | `/api/internal/student-promotions/july-1` |
| GET | `/api/internal/progress-tests/admin-digest` |

## Conventions shared by these endpoints

- **`CRON_SECRET` bearer auth.** The caller must send `Authorization: Bearer $CRON_SECRET`. Comparison is constant-time via `node:crypto.timingSafeEqual`, guarded by a length pre-check that avoids the `RangeError` `timingSafeEqual` throws on length-mismatched buffers (REL-07). Most routes use the shared helper `src/lib/internal/cron-auth.ts:6`-`28` (`getCronSecretStatus` / `rejectInvalidCronSecret`); `sync-wise`, `sync-credit-control`, and `student-promotions/july-1` carry an inline equivalent.
- **Missing secret is a server error, not an auth failure.** If `process.env.CRON_SECRET` is unset, the route returns `500 {"error":"Server misconfigured"}` instead of `401`, so a misconfiguration is not silently treated as unauthorized (`src/lib/internal/cron-auth.ts:22`-`24`).
- **No query params; bodies are ignored.** None of these routes read query strings, and none parse a request body or define a Zod body schema. `GET` is the Vercel cron entry point; `POST` is the manual/replay variant. For `sync-wise`, `sync-credit-control`, and `sync-progress-tests` the only `GET`/`POST` difference is whether an Auth.js session is accepted as a fallback to the secret (see each section).
- **Single-flight guards.** Each sync pipeline prevents overlapping runs. The mechanism differs per family — a `*_sync_runs` row-state check plus a 20-minute stale-recovery sweep (Wise / credit-control / progress-tests), a partial unique index (leave-requests), or a once-per-day terminal run row (the progress-tests admin digest). A skipped run returns `202` (the sync families) or a `skipped` status in the `200` body (the digest).
- **Cron-invocation audit.** Every route except `student-promotions/july-1` wraps its handler in `withCronInvocationAudit(...)` (`src/lib/data-health/cron-audit.ts:144`), which inserts a `cron_invocations` row on entry and updates it with the response status, duration, derived outcome (`success` / `skipped` / `failed`), error summary, and linked run ids on completion. This audit write is best-effort: failures are logged via `console.error` and never change the HTTP response (`src/lib/data-health/cron-audit.ts:108`-`111`, `139`-`141`). The wrapper itself maps a thrown handler error to `500 {"error":"<message>"}` (`:153`-`157`).

The Vercel cron schedules for these paths (from `vercel.json`):

| Path | Schedule (cron) | Source |
|------|-----------------|--------|
| `/api/internal/sync-wise` | `*/30 * * * *` | `vercel.json:4`-`5` |
| `/api/internal/sync-credit-control` | `20,50 * * * *` | `vercel.json:12`-`13` |
| `/api/internal/sync-progress-tests` | `25,55 * * * *` | `vercel.json:16`-`17` |
| `/api/internal/progress-tests/admin-digest` | `35 0 * * *` (07:35 Asia/Bangkok) | `vercel.json:20`-`21` |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` | `vercel.json:28`-`29` |
| `/api/internal/student-promotions/july-1` | `5 17 30 6 *` (00:05 Bangkok, July 1) | `vercel.json:40`-`41` |

> The cron schedule for each path is also mirrored in the in-app cron registry `src/lib/data-health/cron-registry.ts:35`-`206` (used by the Data Health dashboard), along with each route's `maxDuration` and a `routeMethod` (the method Vercel cron triggers, always `GET` for the scheduled jobs here).

---

## Wise snapshot sync

Runs the full Wise ETL pipeline (`runFullSync`, `src/lib/sync/orchestrator.ts:50`): fetch teachers / availability / leaves / future sessions, normalize, write snapshot tables, validate, and atomically promote a new active snapshot. On success it invalidates the `snapshot` cache tag so the in-memory search index rebuilds.

Audit `jobKey`: `wise_snapshot`. `maxDuration = 800` (`src/app/api/internal/sync-wise/route.ts:7`).

### `GET /api/internal/sync-wise`

Vercel cron entry point.

- **Auth:** `CRON_SECRET` bearer only — no session fallback (`allowSessionAuth: false`, `src/app/api/internal/sync-wise/route.ts:69`-`71`).
- **Request:** none (no body, no query, no Zod schema).

### `POST /api/internal/sync-wise`

Manual / operator entry point (e.g. `curl -X POST`).

- **Auth:** `CRON_SECRET` bearer **or**, when the secret check is not `valid`, a logged-in Auth.js session (`allowSessionAuth: true`; calls `auth()`, `src/app/api/internal/sync-wise/route.ts:45`-`58`, `74`-`76`). The audit `triggerSource` is `cron` for a valid secret, `admin` for the session path.
- **Request:** none.

### Behavior (both methods)

Both delegate to `runWiseSyncRequest()` (`src/lib/sync/run-wise-sync.ts:142`).

**Single-flight guard** (`acquireSyncRun`, `src/lib/sync/run-wise-sync.ts:88`-`118`):
1. Mark any `sync_runs` row stuck in `running` for more than 20 minutes (`STALE_RUNNING_SYNC_MS`, `:10`) as `failed` (`:51`-`72`); the count is returned as `staleRunningSyncsFailed`.
2. If a `running` row remains, skip and return the already-running payload (`202`).
3. Otherwise insert a new `running` `sync_runs` row. A unique-constraint violation (`23505`) on insert is treated as a concurrent run and also yields the skip payload (`:106`-`117`).

**Side effects:** writes `sync_runs`; on a successful full run, writes snapshot/data tables and promotes the active `snapshots` row (see `runFullSync`); calls `revalidateTag("snapshot", { expire: 0 })` only when `result.success` (`src/lib/sync/run-wise-sync.ts:160`-`162`).

### Responses

| Status | When | Body |
|--------|------|------|
| `200` | Sync completed (`result.success === true`) | `SyncResult` + `staleRunningSyncsFailed` |
| `202` | A run was already in progress; this call skipped | `SkippedSyncResult` |
| `401` | Secret present but invalid, and (POST) no session | `{"error":"Unauthorized"}` |
| `500` | `result.success === false` (sync threw internally) | `SyncResult` with `success:false`, `errorSummary` set |
| `500` | `CRON_SECRET` env var not set | `{"error":"Server misconfigured"}` |

Status selection: `result.success ? 200 : 500` (`src/lib/sync/run-wise-sync.ts:164`-`166`); skip returns `202` (`:148`-`149`).

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
  "errorSummary": "<string|null>",
  "durationMs": 0,
  "staleRunningSyncsFailed": 0
}
```

`SkippedSyncResult` (`202`; `src/lib/sync/run-wise-sync.ts:22`-`37`, `120`-`140`):

```jsonc
{
  "success": true,
  "skipped": true,
  "alreadyRunning": true,
  "syncRunId": "<uuid of the in-flight run>",
  "snapshotId": null,
  "promotedSnapshotId": null,
  "teacherCount": 0,
  "groupCount": 0,
  "issueCount": 0,
  "errorSummary": null,
  "durationMs": 0,
  "message": "Wise sync is already running. Data will refresh when that run finishes.",
  "runningStartedAt": "<ISO timestamp>",
  "staleRunningSyncsFailed": 0
}
```

---

## Credit-control sync

Re-derives the credit-control snapshot from Wise (students, prepaid packages, sessions, feedback) and promotes it. Audit `jobKey`: `credit_control`. `maxDuration = 300` (`src/app/api/internal/sync-credit-control/route.ts:7`).

### `GET /api/internal/sync-credit-control`

Vercel cron entry point.

- **Auth:** `CRON_SECRET` bearer only (`allowSessionAuth: false`, `src/app/api/internal/sync-credit-control/route.ts:58`-`60`).
- **Request:** none.

### `POST /api/internal/sync-credit-control`

Manual / operator entry point.

- **Auth:** `CRON_SECRET` bearer **or** a logged-in Auth.js session fallback (`allowSessionAuth: true`, `src/app/api/internal/sync-credit-control/route.ts:36`-`49`, `62`-`64`). `triggerSource` is `cron` for the secret, `admin` for the session.
- **Request:** none.

### Behavior (both methods)

Both delegate to `runCreditControlSyncRequest()` (`src/lib/credit-control/run-sync-request.ts:138`).

**Single-flight guard** (`acquireSyncRun`, `src/lib/credit-control/run-sync-request.ts:106`-`136`): identical shape to Wise — fail `creditControlSyncRuns` rows `running` for more than 20 minutes (`STALE_RUNNING_CREDIT_CONTROL_SYNC_MS`, `:9`), skip if a `running` row remains (`202`), else insert a new `running` row (with `23505`-on-insert also yielding the skip payload).

**Side effects:** writes `credit_control_sync_runs` and, on success, the snapshot-scoped credit-control tables; promotes the active snapshot and calls `revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 })` inside `runCreditControlSync` on success (`src/lib/credit-control/sync.ts:570`).

### Responses

| Status | When | Body |
|--------|------|------|
| `200` | Sync completed (`result.success === true`) | `CreditControlSyncResult` + `syncRunId` + `staleRunningSyncsFailed` |
| `202` | A run was already in progress; this call skipped | skipped payload (below) |
| `401` | Secret present but invalid, and (POST) no session | `{"error":"Unauthorized"}` |
| `500` | `result.success === false` | `CreditControlSyncResult` with `success:false`, `errorSummary` set |
| `500` | `CRON_SECRET` env var not set | `{"error":"Server misconfigured"}` |

Status selection: `result.success ? 200 : 500` (`src/lib/credit-control/run-sync-request.ts:157`-`159`); skip returns `202` (`:145`-`147`).

`CreditControlSyncResult` (`src/lib/credit-control/sync.ts:41`-`50`), augmented at the route with `syncRunId` and `staleRunningSyncsFailed`:

```jsonc
{
  "success": true,
  "snapshotId": "<uuid>",          // optional
  "promotedSnapshotId": "<uuid>",  // optional
  "studentCount": 0,
  "packageCount": 0,
  "sessionCount": 0,
  "failedCreditPairs": 0,
  "errorSummary": "<string>",      // optional, present on failure
  "syncRunId": "<uuid>",
  "staleRunningSyncsFailed": 0
}
```

Skip payload (`202`; `SkippedCreditControlSyncResult`, `src/lib/credit-control/run-sync-request.ts:84`-`104`):

```jsonc
{
  "success": true,
  "skipped": true,
  "alreadyRunning": true,
  "syncRunId": "<uuid of the in-flight run>",
  "snapshotId": null,
  "promotedSnapshotId": null,
  "studentCount": 0,
  "packageCount": 0,
  "sessionCount": 0,
  "failedCreditPairs": 0,
  "errorSummary": null,
  "message": "Credit control sync is already running. Data will refresh when that run finishes.",
  "runningStartedAt": "<ISO timestamp>",
  "staleRunningSyncsFailed": 0
}
```

---

## Progress-tests sync

Nightly progress-tests pipeline: folds attended-with-credit classes into the cross-snapshot attendance ledger, resolves each session's teacher, recomputes per-enrollment cycle state, and (fail-isolated) sends teacher heads-up notifications for newly-approaching enrollments. Audit `jobKey`: `progress_tests`. `maxDuration = 300` (`src/app/api/internal/sync-progress-tests/route.ts:7`).

### `GET /api/internal/sync-progress-tests`

Vercel cron entry point.

- **Auth:** `CRON_SECRET` bearer only (`allowSessionAuth: false`, `src/app/api/internal/sync-progress-tests/route.ts:41`-`43`).
- **Request:** none.
- **Trigger metadata:** the run is recorded with `triggerType: "cron"` on the `progress_test_sync_runs` row (`:15`).

### `POST /api/internal/sync-progress-tests`

Manual / operator entry point.

- **Auth:** `CRON_SECRET` bearer **or** a logged-in Auth.js session fallback (`allowSessionAuth: true`, `src/app/api/internal/sync-progress-tests/route.ts:19`-`32`, `45`-`47`). The session path records `triggerType: "admin"` and `actorEmail` on the run row, and sets the audit `triggerSource` to `admin` (`:22`-`30`).
- **Request:** none.

### Behavior (both methods)

Both delegate to `runProgressTestSyncRequest({ triggerType, actorEmail? })` (`src/lib/progress-tests/run-sync-request.ts:137`).

**Single-flight guard** (`acquireSyncRun`, `src/lib/progress-tests/run-sync-request.ts:103`-`135`): mirrors Wise/credit-control against `progress_test_sync_runs` — fail rows `running` for more than 20 minutes (`STALE_RUNNING_PROGRESS_TEST_SYNC_MS = 20 * 60 * 1000`, `src/lib/progress-tests/config.ts:27`), skip if one remains (`202`), else insert a new `running` row carrying `triggerType` + `actorEmail` (`23505`-on-insert also yields the skip payload).

**Side effects:** writes `progress_test_sync_runs`; on a run, appends to the durable progress-test ledger and upserts cycle-state rows; may write teacher heads-up notifications and an AI feedback summary (fail-isolated); calls `revalidateTag(PROGRESS_TESTS_CACHE_TAG, { expire: 0 })` inside `runProgressTestSync` (`src/lib/progress-tests/sync.ts:581`).

### Responses

| Status | When | Body |
|--------|------|------|
| `200` | Sync completed (`result.success === true`) | `ProgressTestSyncResult` + `syncRunId` + `staleRunningSyncsFailed` |
| `202` | A run was already in progress; this call skipped | skipped payload (below) |
| `401` | Secret present but invalid, and (POST) no session | `{"error":"Unauthorized"}` |
| `500` | `result.success === false` | `ProgressTestSyncResult` with `success:false`, `errorSummary` set |
| `500` | `CRON_SECRET` env var not set | `{"error":"Server misconfigured"}` |

Status selection: `result.success ? 200 : 500` (`src/lib/progress-tests/run-sync-request.ts:162`-`164`); skip returns `202` (`:146`-`148`).

`ProgressTestSyncResult` (`src/lib/progress-tests/sync.ts:70`-`79`), augmented at the route with `syncRunId` and `staleRunningSyncsFailed`:

```jsonc
{
  "success": true,
  "ledgerRowCount": 0,
  "enrollmentCount": 0,
  "approachingCount": 0,
  "dueCount": 0,
  "unresolvedTeacherCount": 0,
  "notificationCount": 0,
  "errorSummary": "<string>",   // optional, present on failure
  "syncRunId": "<uuid>",
  "staleRunningSyncsFailed": 0
}
```

Skip payload (`202`; `SkippedProgressTestSyncResult`, `src/lib/progress-tests/run-sync-request.ts:82`-`101`) — note it does **not** include `notificationCount`:

```jsonc
{
  "success": true,
  "skipped": true,
  "alreadyRunning": true,
  "syncRunId": "<uuid of the in-flight run>",
  "ledgerRowCount": 0,
  "enrollmentCount": 0,
  "approachingCount": 0,
  "dueCount": 0,
  "unresolvedTeacherCount": 0,
  "errorSummary": null,
  "message": "Progress test sync is already running. Data will refresh when that run finishes.",
  "runningStartedAt": "<ISO timestamp>",
  "staleRunningSyncsFailed": 0
}
```

---

## Progress-tests admin digest

Once-daily digest email to every `admin_users` recipient: students newly approaching a progress test, students due with no booked test, and an "Action needed" list of teacher heads-up emails that could not be resolved. **GET only** — there is no `POST` handler. Audit `jobKey`: `progress_tests_digest`. `maxDuration = 300` (`src/app/api/internal/progress-tests/admin-digest/route.ts:6`).

### `GET /api/internal/progress-tests/admin-digest`

- **Auth:** `CRON_SECRET` bearer only, via `rejectInvalidCronSecret(request)` (`src/app/api/internal/progress-tests/admin-digest/route.ts:9`-`10`).
- **Request:** none.

### Behavior

Calls `sendProgressTestAdminDigest()` (`src/lib/progress-tests/admin-digest.ts:309`).

**Once-per-day idempotency:** keyed on `progress_test_admin_digest_runs.digest_date` (= `todayBangkok`), which is UNIQUE. A terminal run row for the date (`sent` / `partial` / `failed` / `skipped`) short-circuits a re-invocation, so the digest is sent at most once per Bangkok day (`src/lib/progress-tests/admin-digest.ts:229`-`236`, `316`-`329`). The per-date insert is the single-flight guard: a concurrent loser gets a `23505` and returns a `skipped` result (`:247`-`271`, `367`-`380`).

**Side effects:** writes `progress_test_admin_digest_runs` and per-recipient `progress_test_admin_digest_recipients` rows; sends one email per admin recipient through the Apps Script sender, each with a per-recipient idempotency key. If there is nothing to report, a terminal `skipped` run row is recorded and no email is sent (`:333`-`358`).

### Responses

Returns the `ProgressTestAdminDigestResult` body directly, with the HTTP status chosen as `result.status === "failed" ? 500 : 200` (`src/app/api/internal/progress-tests/admin-digest/route.ts:16`-`18`).

| Status | When | Body |
|--------|------|------|
| `200` | Digest `sent`, `partial`, or `skipped` | `ProgressTestAdminDigestResult` |
| `401` | Secret present but invalid | `{"error":"Unauthorized"}` |
| `500` | Digest `failed` (e.g. no admin recipients, or all sends failed) | `ProgressTestAdminDigestResult` with `status:"failed"` |
| `500` | Handler threw, or `CRON_SECRET` env var not set | `{"error":"<message>"}` / `{"error":"Server misconfigured"}` |

`ProgressTestAdminDigestResult` (`src/lib/progress-tests/admin-digest.ts:32`-`43`):

```jsonc
{
  "status": "sent",            // "sent" | "partial" | "failed" | "skipped"
  "digestDate": "2026-06-05",  // todayBangkok
  "digestRunId": "<uuid|null>",
  "approachingCount": 0,
  "dueCount": 0,
  "unresolvedCount": 0,
  "attempted": 0,
  "success": 0,
  "failed": 0,
  "message": "<string>"
}
```

---

## Leave-requests sync

Pulls tutor leave-form rows from the configured Google Sheet, matches each to a Wise identity, computes affected sessions, and records a review worklist (plus admin notifications). Audit `jobKey`: `leave_requests`. `maxDuration = 800` (`src/app/api/internal/sync-leave-requests/route.ts:7`).

> Feature status: **in progress / uncommitted** at this revision. The route handler is committed; its dependency `src/lib/leave-requests/sync.ts` is documented here but treated as in-flight source.

### `GET /api/internal/sync-leave-requests`

Vercel cron entry point.

### `POST /api/internal/sync-leave-requests`

Manual / replay entry point.

Both methods are identical: they call the same `handle(request)` (`src/app/api/internal/sync-leave-requests/route.ts:30`-`36`).

- **Auth (both):** `CRON_SECRET` bearer only, via `rejectInvalidCronSecret(request)` (`:10`-`11`). **No session fallback** — unlike `sync-wise`/`sync-credit-control`/`sync-progress-tests`, the `POST` here does not accept an Auth.js session.
- **Request (both):** none.

### Behavior

Calls `syncLeaveRequests(getDb(), { triggerType: "cron" })` (`src/app/api/internal/sync-leave-requests/route.ts:17`) — both `GET` and `POST` pass `triggerType: "cron"`.

**Single-flight guard:** a partial unique index `leave_request_sync_runs_single_running_idx` on the `running` state. A concurrent run raises `LeaveRequestSyncAlreadyRunningError` (`src/lib/leave-requests/sync.ts:21`-`26`), which the route maps to `409` (`src/app/api/internal/sync-leave-requests/route.ts:20`-`22`).

**Side effects:** reads the leave-request Google Sheet (via the connected-email OAuth token); writes `leave_request_sync_runs`, leave-request rows, affected-session rows, and notification rows; may write status back to the source sheet and send admin notification emails (per the feature's sync logic).

### Responses

| Status | When | Body |
|--------|------|------|
| `200` | Sync completed | `{"ok": true, "result": SyncLeaveRequestsResult}` |
| `401` | Secret present but invalid | `{"error":"Unauthorized"}` |
| `409` | Another leave-requests sync is already running | `{"error":"Leave request sync is already running."}` |
| `500` | Sync threw a non-conflict error | `{"error":"<message>"}` (or `"Leave request sync failed"`) |
| `500` | `CRON_SECRET` env var not set | `{"error":"Server misconfigured"}` |

`SyncLeaveRequestsResult` (`src/lib/leave-requests/sync.ts:36`-`42`):

```jsonc
{
  "syncRunId": "<uuid>",
  "scannedRowCount": 0,
  "insertedCount": 0,
  "updatedCount": 0,
  "notificationCount": 0
}
```

---

## Student promotions — July 1 cron

One-shot cron that applies the verified July 1, 2026 Wise student grade-and-course promotion run. Unlike the sync routes above, this one is **not** wrapped in `withCronInvocationAudit` and has **no session fallback**. `maxDuration = 800` (`src/app/api/internal/student-promotions/july-1/route.ts:8`).

### `GET /api/internal/student-promotions/july-1`

Vercel cron entry point.

### `POST /api/internal/student-promotions/july-1`

Manual / replay entry point — `POST` simply delegates to `GET(request)` (`src/app/api/internal/student-promotions/july-1/route.ts:46`-`48`), so the two methods are byte-for-byte identical.

- **Auth (both):** inline `CRON_SECRET` bearer check (`hasValidCronSecret`, `src/app/api/internal/student-promotions/july-1/route.ts:10`-`17`). No session fallback.
- **Request (both):** none.

### Behavior

1. Secret check: missing secret → `500`; invalid → `401` (`:20`-`26`).
2. **Date gate:** if `todayBangkok()` is not the target date `2026-07-01` (`STUDENT_PROMOTION_TARGET_DATE`, `src/lib/student-promotions/rules.ts:1`), return `409` (`:27`-`31`). This route is allowed to run on exactly one Bangkok day.
3. Calls `applyVerifiedStudentPromotionRun({ trigger: "cron" })` (`src/lib/student-promotions/data.ts:730`). The service refuses to apply before the target instant, loads the newest verified run, and returns immediately if it is already terminal. For each pending grade action it re-reads the student's Wise registration field before writing; for each pending course action it re-reads the Wise class subject and roster before writing. Per-action Wise drift or write errors are persisted on the action row and do not abort the run.

**Side effects:** writes to Wise (student grade-registration field and course/class membership) for verified, pending actions, and updates `student_promotion_*` action/run rows with applied/skipped/failed outcomes.

### Responses

| Status | When | Body |
|--------|------|------|
| `200` | Apply completed, or the run was already terminal | `{"detail": StudentPromotionRunDetail}` |
| `401` | Secret present but invalid | `{"error":"Unauthorized"}` |
| `409` | Called outside July 1, 2026 Bangkok time | `{"error":"Student promotion cron is only allowed on July 1, 2026 Bangkok time"}` |
| `400` | Apply service rejected (validation/business error) | `{"error":"<message>"}` |
| `500` | Apply service failed unexpectedly | `{"error":"<message>"}` |
| `500` | `CRON_SECRET` env var not set | `{"error":"Server misconfigured"}` |

Errors from the apply service are normalized by `studentPromotionErrorResponse(...)` (`src/lib/student-promotions/api.ts:29`-`56`): `Unauthorized` → `401`; `/not found/i` → `404`; `/(required|cannot|only|no verified|no pending|before July 1)/i` → `400`; otherwise `500`. (The `404` branch is reachable through the shared helper but not expected for the no-argument cron apply path.)

`StudentPromotionRunDetail` (`src/lib/student-promotions/data.ts:38`-`52`):

```jsonc
{
  "run": { /* student_promotion_runs row */ },
  "gradeActions": [ /* student_promotion_grade_actions rows */ ],
  "courseActions": [ /* student_promotion_course_actions rows */ ],
  "summary": {
    "pendingGradeActions": 0,
    "skippedGradeActions": 0,
    "appliedGradeActions": 0,
    "failedGradeActions": 0,
    "pendingCourseActions": 0,
    "skippedCourseActions": 0,
    "appliedCourseActions": 0,
    "failedCourseActions": 0
  }
}
```

> The admin-session counterparts to this workflow (`/api/student-promotions/runs*`) are documented in [`student-promotions.md`](./student-promotions.md); this page covers only the internal cron route.

_Verified against HEAD `d4fe6d3` on 2026-06-05._
