# Credit Control API

HTTP reference for the eight Credit Control endpoints under `/api/credit-control`. These power the admin credit-control dashboard: refreshing the Wise-derived snapshot, reading the dashboard payload, recording per-student follow-up actions, assigning admin ownership, and marking students inactive.

For *what* credit control means (purpose, package risk rules, admin ownership semantics), see the feature documentation. This page documents mechanical request/response detail only.

## Conventions shared by all eight endpoints

**Authentication.** Every handler calls `requireCreditControlSession()` before doing any work (`src/lib/credit-control/api.ts:5`). That helper reads the Auth.js session via `auth()`, lowercases/trims the email, and throws `Error("Unauthorized")` when either the email or display name is missing (`src/lib/credit-control/api.ts:10-12`). There is no role/allowlist check inside the helper beyond requiring a logged-in user with an email and name. On top of that, none of these eight paths appear in the middleware public-route allowlist (`src/middleware.ts:4-15`), so the global auth middleware also redirects unauthenticated browser requests to `/login` before the handler runs. The returned `AppSessionUser` (`{ email, name }`) is used as the actor for writes (`src/types/credit-control.ts:247-250`).

**Error handling.** Every handler wraps its body in `try/catch` and funnels failures through `creditControlErrorResponse(route, error, fallbackMessage)` (`src/lib/credit-control/api.ts:17-36`):

- If the error is a Next.js `HANGING_PROMISE_REJECTION` digest, it is re-thrown (not converted to a response) — `src/lib/credit-control/api.ts:18-25`.
- If `error.message === "Unauthorized"`, returns `401` with `{ "error": "Unauthorized" }` — `src/lib/credit-control/api.ts:27-29`.
- Otherwise logs to `console.error` and returns `500` with `{ "error": <error.message or fallbackMessage> }` — `src/lib/credit-control/api.ts:31-35`.

This means **`401` is signalled by the in-handler session check, not by the HTTP framework**, and any thrown DB/Wise error surfaces as `500` with the underlying message.

**Validation.** None of these handlers use Zod. Inputs are validated inline (`String(...).trim()` + presence checks). Where a field must be one of an enum, that check is done against a hardcoded list (see per-endpoint notes).

**Cache invalidation.** Mutating endpoints call `revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 })`. `CREDIT_CONTROL_CACHE_TAG` is `"credit-control"` (`src/lib/credit-control/config.ts:11`), the same tag the cached dashboard payload registers under (`src/lib/credit-control/service.ts:28`), so a successful write forces the next `GET /api/credit-control` to recompute.

> **Not in this reference:** the Vercel cron at `20,50 * * * *` targets `/api/internal/sync-credit-control` (`vercel.json:11-14`), **not** `POST /api/credit-control/sync`. The cron-driven internal route is a separate, CRON_SECRET-protected endpoint and is documented elsewhere. The `/api/credit-control/sync` route documented below is the admin-session-gated trigger.

---

## Snapshot

### `POST /api/credit-control/sync`

Triggers a full credit-control snapshot rebuild from the Wise API (fetch students/packages/sessions, compute credits, write a new snapshot row). Source: `src/app/api/credit-control/sync/route.ts`.

- **Auth:** `requireCreditControlSession()` (`route.ts:8`). No CRON_SECRET — this is the session-gated trigger.
- **Function config:** `export const maxDuration = 300` (`route.ts:4`).
- **Request body:** none. The handler is `POST()` with no parameters and does not read the request (`route.ts:6`).
- **Behavior:** delegates to `runCreditControlSyncRequest()` (`route.ts:9`, `src/lib/credit-control/run-sync-request.ts:138`), which:
  1. Builds a Wise client and resolves `instituteId` from `WISE_INSTITUTE_ID` (default `696e1f4d90102225641cc413`) — `run-sync-request.ts:140-141`.
  2. **Single-flight guard** (`acquireSyncRun`, `run-sync-request.ts:106-136`): first fails any `creditControlSyncRuns` row stuck in `running` for more than 20 minutes (`STALE_RUNNING_CREDIT_CONTROL_SYNC_MS = 20 * 60 * 1000`, `run-sync-request.ts:9`, `failStaleRunningSyncs` `run-sync-request.ts:50-68`), counting them as `staleRunningSyncsFailed`. Then, if another run is still `running`, it skips. Otherwise it inserts a new `running` row; a unique-violation (`23505`) on insert is treated as a concurrent run and also skips (`run-sync-request.ts:124-135`).
  3. If skipped, returns the run synchronously without touching Wise.
  4. Otherwise runs `runCreditControlSync(db, client, instituteId, now, { syncRunId })` (`run-sync-request.ts:149`, `src/lib/credit-control/sync.ts:483`).

- **Side effects:** inserts/updates rows in `creditControlSyncRuns`; on success writes a new snapshot and its derived student/package/session rows and promotes it (`sync.ts:527-578`); on failure marks the sync run `failed` with an `errorSummary` (`sync.ts:580-599`). Does **not** call `revalidateTag` itself.

- **Responses:**

  - **`202 Accepted`** — a sync is already running (or was just claimed concurrently). Body (`run-sync-request.ts:84-104, 145-147`):
    ```json
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

  - **`200 OK`** — sync ran and succeeded (`result.success === true`, `run-sync-request.ts:158`). Body is the sync result (`sync.ts:571-578`) merged with `syncRunId` and `staleRunningSyncsFailed` (`run-sync-request.ts:153-157`):
    ```json
    {
      "success": true,
      "snapshotId": "<uuid>",
      "promotedSnapshotId": "<uuid>",
      "studentCount": 0,
      "packageCount": 0,
      "sessionCount": 0,
      "failedCreditPairs": 0,
      "syncRunId": "<uuid>",
      "staleRunningSyncsFailed": 0
    }
    ```

  - **`500 Internal Server Error`** — sync ran but failed (`result.success === false`, `run-sync-request.ts:158`). Same envelope, with `success: false`, `snapshotId` possibly set, zeroed counts, and an `errorSummary` string (`sync.ts:591-599`). A thrown error before/within the runner is instead caught by the route's `creditControlErrorResponse` and returns `{ "error": ... }` (`route.ts:11`).

> Note the two distinct `500` shapes: a *handled* sync failure returns the rich result object `{ success: false, ..., errorSummary }`; an *unhandled* exception returns `{ "error": "Credit control sync failed" }` (or the thrown message).

---

## Dashboard payload

### `GET /api/credit-control`

Returns the full credit-control dashboard payload computed from the active snapshot plus Postgres sidecar state (action states, inactive set, admin ownership). Source: `src/app/api/credit-control/route.ts`.

- **Auth:** `requireCreditControlSession()` (`route.ts:7`).
- **Request:** no query params, no body (`route.ts:5`).
- **Behavior:** returns `getCreditControlPayload()` verbatim (`route.ts:8-9`). That service is wrapped in `"use cache"` tagged `credit-control` with `cacheLife({ stale: 60, revalidate: 60, expire: 300 })` (`src/lib/credit-control/service.ts:27-30`), so responses are served from cache until a mutating endpoint invalidates the tag or the TTL elapses.
- **Response — `200 OK`:** a `DashboardPayload` (`src/types/credit-control.ts:215-223`):
  ```jsonc
  {
    "adminViews":        [ { "key": "all", "label": "All" }, ... ],   // AdminViewOption[]
    "lastUpdatedAt":     "<ISO timestamp>",
    "previousUpdatedAt": "<ISO timestamp | null>",
    "summary":           { /* SummaryPayload: students, packages, portfolio, queue, deltas */ },
    "studentQueue":      [ /* StudentQueueRow[] */ ],
    "calendar":          { /* CalendarPayload: availableStart, availableEnd, days[] */ },
    "students":          [ /* StudentRecord[] */ ]
  }
  ```
  See `src/types/credit-control.ts` for the nested shapes: `SummaryPayload` (lines 194-213), `StudentQueueRow` (112-143), `CalendarPayload` (177-181), `StudentRecord` (93-103, includes per-student `actionState`, `adminOwnerKey`, `adminOwnerName`). Inactive students are filtered out of the payload (`service.ts:79-81`).
- **Errors:** `401` if unauthenticated; `500` (`{ "error": "Credit control load failed" }` or thrown message) on failure (`route.ts:11`).

---

## Follow-up actions

These endpoints record per-student follow-up status. Valid statuses are exactly `contacted`, `pending-callback`, `resolved` (`normalizeStudentActionStatus`, `src/lib/credit-control/action-helpers.ts:17-24`); anything else normalizes to `null` (treated as "clear"). All three mutate the `creditControlFollowUpState` / `creditControlFollowUpLog` tables and call `revalidateTag("credit-control")` (`src/lib/credit-control/actions.ts`).

### `POST /api/credit-control/actions`

Set or clear the follow-up action for a single student. Source: `src/app/api/credit-control/actions/route.ts`.

- **Auth:** `requireCreditControlSession()` → `sessionUser` used as actor (`route.ts:9`).
- **Request body** (JSON, parsed as `{ studentKey?: string; status?: string | null }`, `route.ts:10`):

  | Field | Type | Required | Notes |
  |-------|------|----------|-------|
  | `studentKey` | string | yes | Trimmed; `400` if empty (`route.ts:11-15`). Must match a student in the current payload, else `404` (`route.ts:18-21`). |
  | `status` | string \| null | no | Normalized via `normalizeStudentActionStatus` (`route.ts:23`). A valid status → **set**; null/empty/invalid → **clear**. |

- **Behavior:** loads `getCreditControlPayload()` and looks up the student (`route.ts:17-21`). If `status` normalizes to a valid value, calls `setStudentAction(...)` (upsert state + append a `"set"` log row, `src/lib/credit-control/actions.ts:57-76`); otherwise `clearStudentAction(...)` (delete state + append a `"clear"` log row, `actions.ts:78-90`). Both paths revalidate the cache tag.
- **Response — `200 OK`** (`route.ts:52`):
  ```jsonc
  {
    "ok": true,
    "studentKey": "<studentKey>",
    "actionState": {            // null when the action was cleared
      "status": "contacted",   // the normalized status
      "updatedAt": "<ISO>",
      "updatedByName": "<session user name>",
      "isToday": true
    }
  }
  ```
- **Errors:** `400` `{ "error": "studentKey is required" }`; `404` `{ "error": "Student not found" }`; `401`; `500` (`{ "error": "Action request failed" }` or thrown message, `route.ts:54`).

### `POST /api/credit-control/actions/bulk`

Set or clear the follow-up action for many students at once. Source: `src/app/api/credit-control/actions/bulk/route.ts`.

- **Auth:** `requireCreditControlSession()` → actor (`route.ts:9`).
- **Request body** (JSON, `{ studentKeys?: string[]; status?: string | null }`, `route.ts:10`):

  | Field | Type | Required | Notes |
  |-------|------|----------|-------|
  | `studentKeys` | string[] | yes | Trimmed, empty-filtered, **de-duplicated** via `Set` (`route.ts:11-13`). `400` if the resulting list is empty (`route.ts:15-17`). |
  | `status` | string \| null | conditional | `null` or `""` means **clear** (`wantsClear`, `route.ts:19`). Otherwise must normalize to a valid status, else `400` (`route.ts:20-23`). |

- **Behavior:** loads the payload, keeps only `studentKeys` that resolve to a known student (`route.ts:25-33`). If none resolve, short-circuits to `200 { "updated": [] }` (`route.ts:35-37`). Then either `bulkSetAction(...)` (per-student upsert + `"bulk-set"` log, `src/lib/credit-control/actions.ts:92-113`) or `bulkClearAction(...)` (per-student delete + `"bulk-clear"` log, `actions.ts:115-129`). Each helper revalidates the cache tag once.
- **Response — `200 OK`** (`route.ts:54-66`): one entry per *resolved* student. Unknown keys are silently dropped (not reported).
  ```jsonc
  {
    "updated": [
      {
        "studentKey": "<key>",
        "actionState": {          // null when cleared
          "status": "resolved",
          "updatedAt": "<ISO, shared across the batch>",
          "updatedByName": "<session user name>",
          "isToday": true
        }
      }
    ]
  }
  ```
- **Errors:** `400` `{ "error": "studentKeys is required" }` or `{ "error": "valid status is required" }`; `401`; `500` (`{ "error": "Bulk action request failed" }`, `route.ts:68`).

### `GET /api/credit-control/actions/history`

Returns the recent follow-up action log for one student. Source: `src/app/api/credit-control/actions/history/route.ts`.

- **Auth:** `requireCreditControlSession()` (`route.ts:7`).
- **Request — query params** (`route.ts:8-9`):

  | Param | Type | Required | Notes |
  |-------|------|----------|-------|
  | `studentKey` | string | yes | Trimmed from the URL; `400` if empty (`route.ts:11-13`). |

- **Behavior:** calls `readCreditActionHistory(studentKey, 7)` — the window is hardcoded to the **last 7 days** at the call site (`route.ts:15`; helper default also 7, `src/lib/credit-control/db.ts:233-249`), ordered newest-first by `createdAt`. Maps each log row to a compact shape (`route.ts:16-21`). Read-only — no cache invalidation.
- **Response — `200 OK`** (`route.ts:23`):
  ```jsonc
  {
    "history": [
      {
        "status": "contacted",            // log row status (may be null for clears)
        "updatedAt": "<ISO timestamp>",   // from createdAt
        "updatedByName": "<actor name>",
        "actionType": "set"               // "set" | "clear" | "bulk-set" | "bulk-clear"
      }
    ]
  }
  ```
- **Errors:** `400` `{ "error": "studentKey is required" }`; `401`; `500` (`{ "error": "Failed to load history" }`, `route.ts:25`).

---

## Admin ownership

### `POST /api/credit-control/admin-ownership`

Assigns (or reassigns) which admin owns a student. Source: `src/app/api/credit-control/admin-ownership/route.ts`.

- **Auth:** `requireCreditControlSession()` → `sessionUser.email` recorded as `assignedByEmail` (`route.ts:9`, `22-26`).
- **Request body** (JSON, `{ studentKey?: string; adminKey?: string }`, `route.ts:10`):

  | Field | Type | Required | Notes |
  |-------|------|----------|-------|
  | `studentKey` | string | yes | Trimmed; `400` if empty (`route.ts:11-16`). |
  | `adminKey` | string | yes | Trimmed; `400` if empty. Must be one of the keys returned by `getAdminViewOptions()`, else `400` `{ "error": "Unknown adminKey" }` (`route.ts:18-20`). Valid keys: `all`, `palm`, `kem`, `care`, `aya`, `petchy`, `muk`, `unassigned` (`src/lib/credit-control/config.ts:23-31, 105-112`). |

- **Behavior:** upserts the ownership row via `upsertCreditAdminOwnership({ studentKey, adminKey, assignedByEmail })` (`route.ts:22-26`, `src/lib/credit-control/db.ts:297-310` — insert with `onConflictDoUpdate` on `studentKey`). Then `revalidateTag("credit-control", { expire: 0 })` (`route.ts:27`). Unlike the action endpoints, this route does **not** verify the `studentKey` exists in the payload — only that `adminKey` is a known key.
- **Response — `200 OK`** (`route.ts:29`):
  ```json
  { "ok": true, "studentKey": "<studentKey>", "adminKey": "<adminKey>" }
  ```
- **Errors:** `400` `{ "error": "studentKey and adminKey are required" }` or `{ "error": "Unknown adminKey" }`; `401`; `500` (`{ "error": "Admin ownership update failed" }`, `route.ts:31-35`).

---

## Inactive students

`POST` marks a student inactive (excluding them from the dashboard payload); `DELETE` un-marks. Both live in `src/app/api/credit-control/inactive/route.ts` and both call `revalidateTag("credit-control")` via their action helpers.

### `POST /api/credit-control/inactive`

Mark a student inactive. Source: `src/app/api/credit-control/inactive/route.ts:6-33`.

- **Auth:** `requireCreditControlSession()` → `sessionUser.email` recorded as `markedByEmail` (`route.ts:8`, `22-27`).
- **Request body** (JSON, `{ studentKey?: string }`, `route.ts:9`):

  | Field | Type | Required | Notes |
  |-------|------|----------|-------|
  | `studentKey` | string | yes | Trimmed; `400` if empty (`route.ts:10-14`). Must exist in the current payload, else `404` (`route.ts:16-20`). |

- **Behavior:** loads `getCreditControlPayload()`, looks up the student (to capture `student`/`parent` names), then `markInactiveStudent({ studentKey, studentName, parentName, markedByEmail })` — upsert into `creditControlInactiveStudents` keyed on `studentKey` (`src/lib/credit-control/actions.ts:131-134`, `src/lib/credit-control/db.ts:254-267`) followed by cache revalidation. Subsequent `GET /api/credit-control` responses omit this student (`src/lib/credit-control/service.ts:79-81`).
- **Response — `200 OK`:** `{ "ok": true }` (`route.ts:29`).
- **Errors:** `400` `{ "error": "studentKey is required" }`; `404` `{ "error": "Student not found" }`; `401`; `500` (`{ "error": "Inactive request failed" }`, `route.ts:31`).

### `DELETE /api/credit-control/inactive`

Clear a student's inactive flag. Source: `src/app/api/credit-control/inactive/route.ts:35-50`.

- **Auth:** `requireCreditControlSession()` (`route.ts:37`). Note: unlike the `POST`, this handler does **not** read the session user beyond the auth check, and does **not** verify the student exists in the payload.
- **Request body** (JSON, `{ studentKey?: string }`, `route.ts:38`):

  | Field | Type | Required | Notes |
  |-------|------|----------|-------|
  | `studentKey` | string | yes | Trimmed; `400` if empty (`route.ts:39-43`). |

- **Behavior:** `clearInactiveStudent(studentKey)` — deletes the matching `creditControlInactiveStudents` row (`src/lib/credit-control/actions.ts:136-139`, `src/lib/credit-control/db.ts:269-273`) and revalidates the cache tag. Deleting a non-existent row is a no-op (still `200`).
- **Response — `200 OK`:** `{ "ok": true }` (`route.ts:46`).
- **Errors:** `400` `{ "error": "studentKey is required" }`; `401`; `500` (`{ "error": "Inactive request failed" }`, `route.ts:48`).

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
