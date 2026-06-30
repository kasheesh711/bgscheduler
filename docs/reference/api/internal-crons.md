# Internal / Cron API

Machine-to-machine endpoints that drive the scheduled ETL pipelines. Vercel Cron invokes the scheduled entries with HTTP `GET`; some handlers additionally expose HTTP `POST` for manual reruns or cron-secret replay. All endpoints live under `/api/internal/*`, which `src/middleware.ts` exempts from the session auth gate — each route enforces its own `CRON_SECRET` or explicit session fallback instead.

For the **meaning** of each pipeline (what a snapshot is, why syncs fail-closed, the data-integrity rules), see the corresponding feature docs. This page documents only the mechanical HTTP contract.

## Conventions shared by these endpoints

- **`CRON_SECRET` bearer auth.** The caller must send `Authorization: Bearer $CRON_SECRET`. Comparison is constant-time via `node:crypto.timingSafeEqual`, guarded by a length pre-check to avoid the `RangeError` that `timingSafeEqual` throws on length-mismatched buffers (`src/app/api/internal/sync-wise/route.ts:10`-`28`; shared helper at `src/lib/internal/cron-auth.ts:6`-`17`).
- **No query params.** The cron `GET` routes do not read query params. Most routes read no body; manual/replay `POST` variants either read no body or use a route-specific confirmation body documented below.
- **Single-flight guard.** Sync pipelines prevent overlapping runs where a second run could corrupt or duplicate work. The mechanism differs per family (DB row-state check + 20-minute stale recovery for Wise/credit-control; a partial unique index for leave-requests) — see each section.
- **Missing secret is a server error.** If `process.env.CRON_SECRET` is unset, the route returns `500 {"error":"Server misconfigured"}` rather than `401`, so a misconfiguration is not silently treated as an auth failure (`src/lib/internal/cron-auth.ts:22`-`24`; `src/app/api/internal/sync-wise/route.ts:49`-`50`).

The Vercel cron schedules for these paths (from `vercel.json`) and the route methods they export:

| Path | Schedule (cron) | Exported methods | Auth notes |
|------|-----------------|------------------|------------|
| `/api/internal/sync-wise` | `*/30 * * * *` (`vercel.json:4`-`5`) | `GET`, `POST` | `GET` bearer only; `POST` bearer or Auth.js session |
| `/api/internal/sync-sales-dashboard` | `10,40 * * * *` (`vercel.json:8`-`9`) | `GET`, `POST` | `GET` bearer only; `POST` bearer or Auth.js session |
| `/api/internal/sync-competitor-intelligence` | `25 18 * * 0` (`vercel.json:12`-`13`) | `GET`, `POST` | `GET` bearer only; `POST` bearer or competitor-intelligence session |
| `/api/internal/sync-credit-control` | `20,50 * * * *` (`vercel.json:16`-`17`) | `GET`, `POST` | `GET` bearer only; `POST` bearer or Auth.js session |
| `/api/internal/sync-progress-tests` | `25,55 * * * *` (`vercel.json:20`-`21`) | `GET`, `POST` | `GET` bearer only; `POST` bearer or Auth.js session |
| `/api/internal/progress-tests/admin-digest` | `35 0 * * *` (`vercel.json:24`-`25`) | `GET` | bearer only |
| `/api/internal/sync-wise-activity` | `5,35 * * * *` (`vercel.json:28`-`29`) | `GET` | bearer only |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` (`vercel.json:32`-`33`) | `GET`, `POST` | bearer only for both methods |
| `/api/internal/class-assignments/morning` | `45 23 * * *` (`vercel.json:36`-`37`) | `GET` | bearer only |
| `/api/internal/class-assignments/admin-email` | `0,10,20,30 0 * * *` (`vercel.json:40`-`41`) | `GET` | bearer only |
| `/api/internal/student-promotions/july-1` | `5 17 30 6 *` (`vercel.json:44`-`45`) | `GET`, `POST` | bearer only for both methods; date-gated to July 1, 2026 Bangkok |
| `/api/internal/cron-watchdog` | `7,37 * * * *` (`vercel.json:48`-`49`) | `GET`, `POST` | bearer only for both methods |

Manual-only internal handlers that are **not** listed in `vercel.json`:

| Path | Exported methods | Auth notes | Purpose |
|------|------------------|------------|---------|
| `/api/internal/sync-room-utilization` | `POST` | bearer or Auth.js session | Sync room-utilization sessions; documented with Room Capacity |
| `/api/internal/line-backlog-recovery` | `GET` | bearer only | Run LINE backlog recovery; no automatic Vercel schedule |

---

## Wise snapshot sync

Runs the full Wise ETL pipeline (`runFullSync`): fetch teachers/availability/leaves/sessions, normalize, write to snapshot tables, validate, and atomically promote a new active snapshot. On success it invalidates the Next cached data tagged `snapshot` (`src/lib/sync/run-wise-sync.ts:160`-`162`); the in-memory search index rebuilds lazily when `ensureIndex()` observes a new active snapshot id.

### `GET /api/internal/sync-wise`

Vercel cron entry point.

- **Auth:** `CRON_SECRET` bearer only. No session fallback (`allowSessionAuth: false`, `src/app/api/internal/sync-wise/route.ts:57`-`59`).
- **Request:** none (no body, no query, no Zod schema).

### `POST /api/internal/sync-wise`

Manual/operator entry point (e.g. `curl -X POST`).

- **Auth:** `CRON_SECRET` bearer **or**, if the secret check is not `valid`, a logged-in Auth.js session (`allowSessionAuth: true`, calls `auth()`; `src/app/api/internal/sync-wise/route.ts:41`-`47`, `62`-`64`).
- **Request:** none.

### Behavior (both methods)

`maxDuration = 800` seconds (`src/app/api/internal/sync-wise/route.ts:6`). Both methods delegate to `runWiseSyncRequest()` (`src/lib/sync/run-wise-sync.ts:142`).

**Single-flight guard** (`acquireSyncRun`, `src/lib/sync/run-wise-sync.ts:88`-`118`):
1. Mark any `sync_runs` row stuck in `running` for more than 20 minutes (`STALE_RUNNING_SYNC_MS`, `src/lib/sync/run-wise-sync.ts:10`) as `failed` (`src/lib/sync/run-wise-sync.ts:51`-`72`).
2. If a `running` row remains, skip and return the already-running payload.
3. Otherwise insert a new `running` `sync_runs` row. A unique-constraint violation (`23505`) during insert is treated as a concurrent run and also yields the skip payload (`src/lib/sync/run-wise-sync.ts:106`-`117`).

**Side effects:** writes to `sync_runs`; on a successful full run, writes snapshot/data tables and promotes the active `snapshots` row (see `runFullSync` in `src/lib/sync/orchestrator.ts`); calls `revalidateTag("snapshot", { expire: 0 })` only when `result.success` is true (`src/lib/sync/run-wise-sync.ts:160`-`162`).

### Responses

| Status | When | Body |
|--------|------|------|
| `200` | Sync completed (`result.success === true`) | `SyncResult` + `staleRunningSyncsFailed` (see below) |
| `202` | A run was already in progress; this call was skipped | `SkippedSyncResult` (see below) |
| `401` | Secret present but invalid, and (for POST) no session | `{"error":"Unauthorized"}` |
| `500` | `result.success === false` (sync threw internally) | `SyncResult` with `success:false`, `errorSummary` set |
| `500` | `CRON_SECRET` env var not set | `{"error":"Server misconfigured"}` |

Status selection: `result.success ? 200 : 500` (`src/lib/sync/run-wise-sync.ts:164`-`166`); skip returns `202` (`:148`-`149`).

`SyncResult` shape (`src/lib/sync/orchestrator.ts:22`-`32`), augmented at the route with `staleRunningSyncsFailed: number`:

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

`SkippedSyncResult` shape (`202`; `src/lib/sync/run-wise-sync.ts:22`-`37`, `120`-`140`):

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

Runs the credit-control ETL pipeline (`runCreditControlSync`): fetch student packages / sessions / per-pair credit records from Wise, write a snapshot, and promote it. Structurally mirrors the Wise sync's single-flight guard but against the `credit_control_sync_runs` table.

### `GET /api/internal/sync-credit-control`

Vercel cron entry point.

- **Auth:** `CRON_SECRET` bearer only. No session fallback (`allowSessionAuth: false`, `src/app/api/internal/sync-credit-control/route.ts:46`-`48`).
- **Request:** none.

### `POST /api/internal/sync-credit-control`

Manual/operator entry point.

- **Auth:** `CRON_SECRET` bearer **or**, if the secret is not `valid`, a logged-in Auth.js session (`allowSessionAuth: true`; `src/app/api/internal/sync-credit-control/route.ts:32`-`37`, `50`-`52`).
- **Request:** none.

### Behavior (both methods)

`maxDuration = 300` seconds (`src/app/api/internal/sync-credit-control/route.ts:6`). Both methods delegate to `runCreditControlSyncRequest()` (`src/lib/credit-control/run-sync-request.ts:138`).

**Single-flight guard** (`acquireSyncRun`, `src/lib/credit-control/run-sync-request.ts:106`-`136`): identical logic to the Wise guard but on `credit_control_sync_runs`. Stale `running` rows older than 20 minutes (`STALE_RUNNING_CREDIT_CONTROL_SYNC_MS`, `:9`) are marked `failed` before checking for a live run; a `23505` unique violation on insert also yields the skip payload.

**Side effects:** writes to `credit_control_sync_runs`; on success writes the credit-control snapshot tables and promotes the snapshot (see `runCreditControlSync` in `src/lib/credit-control/sync.ts`). Note: unlike the Wise sync, this route does **not** call `revalidateTag`.

### Responses

| Status | When | Body |
|--------|------|------|
| `200` | Sync completed (`result.success === true`) | `CreditControlSyncResult` + `syncRunId` + `staleRunningSyncsFailed` |
| `202` | A run was already in progress; this call was skipped | `SkippedCreditControlSyncResult` |
| `401` | Secret present but invalid, and (for POST) no session | `{"error":"Unauthorized"}` |
| `500` | `result.success === false` (sync threw internally) | `CreditControlSyncResult` with `success:false`, `errorSummary` set |
| `500` | `CRON_SECRET` env var not set | `{"error":"Server misconfigured"}` |

Status selection: `result.success ? 200 : 500` (`src/lib/credit-control/run-sync-request.ts:157`-`159`); skip returns `202` (`:145`-`147`).

`CreditControlSyncResult` shape (`src/lib/credit-control/sync.ts:41`-`50`), augmented at the route with `syncRunId` and `staleRunningSyncsFailed` (`src/lib/credit-control/run-sync-request.ts:153`-`156`):

```jsonc
{
  "success": true,
  "snapshotId": "<uuid>",          // optional; present on success
  "promotedSnapshotId": "<uuid>",  // optional; present on success
  "studentCount": 0,
  "packageCount": 0,
  "sessionCount": 0,
  "failedCreditPairs": 0,
  "errorSummary": "<string>",      // optional; present on failure
  "syncRunId": "<uuid>",
  "staleRunningSyncsFailed": 0
}
```

`SkippedCreditControlSyncResult` shape (`202`; `src/lib/credit-control/run-sync-request.ts:24`-`39`, `84`-`104`):

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

## Leave-requests sync

Reads the leave-requests Google Sheet, parses and matches rows to tutors, upserts `leave_requests` rows (recomputing affected sessions per request), and emails notifications for newly inserted requests. Implementation lives in `src/lib/leave-requests/sync.ts` (in-flight source; treat as authoritative for the result shape). Both HTTP methods behave identically — there is no session fallback and no manual-specific branch in the route.

### `GET /api/internal/sync-leave-requests`

Vercel cron entry point.

- **Auth:** `CRON_SECRET` bearer only, via `rejectInvalidCronSecret(request)` (`src/app/api/internal/sync-leave-requests/route.ts:9`-`10`, `24`-`26`).
- **Request:** none.

### `POST /api/internal/sync-leave-requests`

- **Auth:** identical — `CRON_SECRET` bearer only. There is **no** Auth.js session fallback for this endpoint (both methods call the same `handle()`; `src/app/api/internal/sync-leave-requests/route.ts:28`-`30`).
- **Request:** none.

### Behavior (both methods)

`maxDuration = 800` seconds (`src/app/api/internal/sync-leave-requests/route.ts:6`). Both methods call `syncLeaveRequests(getDb(), { triggerType: "cron" })` (`src/app/api/internal/sync-leave-requests/route.ts:13`) — the trigger is always recorded as `cron`, even for `POST`.

**Single-flight guard:** enforced at the database, not by a pre-check. `syncLeaveRequests` inserts a `leave_request_sync_runs` row up front; if that insert collides with the partial unique index `leave_request_sync_runs_single_running_idx`, the helper throws `LeaveRequestSyncAlreadyRunningError`, which the route maps to `409` (`src/lib/leave-requests/sync.ts:290`-`305`, `44`-`47`; route `src/app/api/internal/sync-leave-requests/route.ts:16`-`18`).

**Side effects** (`src/lib/leave-requests/sync.ts:307`-`372`): inserts/updates a `leave_request_sync_runs` row (status `running` → `success`/`failed`); fetches rows from the configured Google Sheet via the connected Google OAuth account; upserts `leave_requests` rows and recomputes affected sessions per request; sends notification emails for newly inserted requests through the Apps Script schedule-email sender. A failure marks the run row `failed` and re-throws.

### Responses

| Status | When | Body |
|--------|------|------|
| `200` | Sync completed | `{"ok":true,"result": SyncLeaveRequestsResult}` |
| `409` | Another leave-requests sync is already running | `{"error":"Leave request sync is already running."}` |
| `401` | Secret present but invalid | `{"error":"Unauthorized"}` |
| `500` | Sync threw any other error | `{"error":"<message>"}` (falls back to `"Leave request sync failed"`) |
| `500` | `CRON_SECRET` env var not set | `{"error":"Server misconfigured"}` |

Response wiring: success at `src/app/api/internal/sync-leave-requests/route.ts:13`-`14`; `409` at `:16`-`18`; generic `500` at `:19`-`20`.

`SyncLeaveRequestsResult` shape (`src/lib/leave-requests/sync.ts:36`-`42`, returned at `:354`-`360`):

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

## Student promotions July 1 apply

Applies the newest verified Student Promotions run for target date `2026-07-01`.
Unlike the recurring sync jobs, this cron is a one-shot business event: the
Vercel schedule is annual syntax, but the route hard-blocks itself unless the
Bangkok date is exactly `2026-07-01`.

### `GET /api/internal/student-promotions/july-1`

Vercel cron entry point.

- **Auth:** `CRON_SECRET` bearer only.
- **Request:** none.
- **Function config:** `maxDuration = 800`.
- **One-shot guard:** returns `409` unless `todayBangkok() === "2026-07-01"`.

### `POST /api/internal/student-promotions/july-1`

Cron-secret replay alias. It delegates to the same handler as `GET`, including
the same bearer-secret and one-shot date checks.

### Behavior

Both methods call `applyVerifiedStudentPromotionRun({ trigger: "cron" })`. The
service refuses to apply before `2026-07-01 00:05 Asia/Bangkok`, loads the newest
verified run, and returns immediately if the run is already `applied` or
`applied_with_errors`.

For each pending grade action it re-reads the student's Wise registration field
before writing. For each pending course action it re-reads the Wise class subject
and roster before writing. Per-action Wise drift or write errors are persisted on
the action row; they do not abort the whole run.

### Responses

| Status | When | Body |
|--------|------|------|
| `200` | Apply completed or run was already terminal | `{"detail": StudentPromotionRunDetail}` |
| `401` | Secret present but invalid | `{"error":"Unauthorized"}` |
| `409` | Called outside July 1, 2026 Bangkok time | `{"error":"Student promotion cron is only allowed on July 1, 2026 Bangkok time"}` |
| `500` | `CRON_SECRET` env var not set | `{"error":"Server misconfigured"}` |
| `400`/`500` | Apply service rejected or failed | `{"error":"<message>"}` |

_Verified against HEAD + uncommitted WIP on 2026-05-31._
