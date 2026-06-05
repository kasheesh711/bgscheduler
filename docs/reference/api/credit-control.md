# Credit Control API

**Status: stable.** **Authoritative source:** the seven route handlers under [`src/app/api/credit-control/`](../../../src/app/api/credit-control/).

This page is the mechanical reference for the Credit Control HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. Feature meaning — the prepaid-credit depletion projection, the at-risk follow-up queue, and the ownership/inactive model — lives in [docs/features/credit-control.md](../../features/credit-control.md). Table columns are defined in [`schema.ts`](../../../src/lib/db/schema.ts).

This group exposes **8 endpoints** across 7 files (`/api/credit-control/inactive` serves both `POST` and `DELETE`).

## Conventions shared across the endpoints

- **Authentication.** Every handler calls `requireCreditControlSession()` ([`api.ts:5-15`](../../../src/lib/credit-control/api.ts)), which reads the Auth.js session and requires both a non-empty `email` and `name`; otherwise it throws `Error("Unauthorized")`. The middleware also gates the whole `/api/credit-control/**` subtree — it is **not** in any public-route allowlist and the matcher covers all paths except Next static assets ([`middleware.ts:68`](../../../src/middleware.ts)) — so an unauthenticated browser request is redirected to `/login` before the handler runs. The in-handler session check is the API-level backstop. There is **no** cron/`CRON_SECRET` tier in this group; the manual sync is admin-session only (the scheduled sync lives in the internal-cron group, not here).
- **Returned session user.** `requireCreditControlSession()` returns `{ email, name }` where `email` is lower-cased/trimmed and `name` falls back to `email` when the session name is blank ([`api.ts:7-14`](../../../src/lib/credit-control/api.ts)). The `email` is stamped as the actor on every mutation; the `name` is echoed back in the optimistic `actionState`.
- **No Zod.** None of the credit-control handlers use a Zod schema. Bodies are read with `await request.json()` and cast inline to a TypeScript shape, then each field is coerced with `String(value ?? "").trim()` and validated with hand-written `if` checks. There is no rejection of unknown fields.
- **Uniform error mapping.** Every handler wraps its body in `try/catch` and routes failures through `creditControlErrorResponse(route, error, fallbackMessage)` ([`api.ts:17-36`](../../../src/lib/credit-control/api.ts)):
  - An error whose `digest === "HANGING_PROMISE_REJECTION"` is **re-thrown** (it is a Next.js cache-component control signal, not a real failure).
  - `Error("Unauthorized")` → **401** `{"error":"Unauthorized"}`.
  - Anything else → **500** `{"error": <error.message or fallbackMessage>}` (and `console.error(route, error)`).
- **Validation 400s short-circuit the handler** before the catch (e.g. missing `studentKey`) and return their own message; they do **not** pass through `creditControlErrorResponse`.
- **Cache invalidation.** Mutations call `revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 })` (tag value `"credit-control"`, [`config.ts:11`](../../../src/lib/credit-control/config.ts)) so the next read of the cached dashboard payload rebuilds. The follow-up-action mutations do this inside the service layer ([`actions.ts:75,89,112,128,133,138`](../../../src/lib/credit-control/actions.ts)); `admin-ownership` does it inline in the route ([`admin-ownership/route.ts:27`](../../../src/app/api/credit-control/admin-ownership/route.ts)).
- **The dashboard payload** returned by `GET /api/credit-control` is the `DashboardPayload` shape ([`types/credit-control.ts:215-223`](../../../src/types/credit-control.ts)); it is documented once under [`GET /api/credit-control`](#get-apicredit-control) and referenced elsewhere as the **credit-control payload**. Several mutation handlers re-read it via `getCreditControlPayload()` to resolve a `studentKey` to its display names, but they do **not** return it.

---

## Read

### `GET /api/credit-control`

Returns the full credit-control dashboard payload for the current Bangkok day. Handler: [`route.ts:5-13`](../../../src/app/api/credit-control/route.ts).

**Auth:** session required (`requireCreditControlSession()`).

**Request:** none (no query, no body).

**Response (200):** `getCreditControlPayload()` ([`service.ts:27`](../../../src/lib/credit-control/service.ts)), serialized as `DashboardPayload` ([`types/credit-control.ts:215-223`](../../../src/types/credit-control.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `adminViews` | `AdminViewOption[]` | View filter tabs: `All`, the six named admins, `Unassigned` ([`config.ts:105-111`](../../../src/lib/credit-control/config.ts)). |
| `lastUpdatedAt` | string | Generation timestamp of the active snapshot. |
| `previousUpdatedAt` | string \| null | Prior snapshot timestamp, for delta computation. |
| `summary` | `SummaryPayload` | Status/portfolio/queue counts + `deltas` vs. the previous snapshot ([`types/credit-control.ts:194-213`](../../../src/types/credit-control.ts)). |
| `studentQueue` | `StudentQueueRow[]` | Ranked at-risk follow-up queue ([`types/credit-control.ts:112-143`](../../../src/types/credit-control.ts)). |
| `calendar` | `CalendarPayload` | Per-day upcoming-session view ([`types/credit-control.ts:177-181`](../../../src/types/credit-control.ts)). |
| `students` | `StudentRecord[]` | Per-student records with packages, projections, `adminOwnerKey`, and `actionState` ([`types/credit-control.ts:93-103`](../../../src/types/credit-control.ts)). |

**Side effects:** none (read-only; served from the `credit-control`-tagged cache).

**Status codes:** `200` success · `401` unauthorized · `500` load failure (`"Credit control load failed"`).

---

## Sync

### `POST /api/credit-control/sync`

Triggers a manual Wise credit-control sync with a single-flight guard, then returns the sync result. Handler: [`sync/route.ts:6-13`](../../../src/app/api/credit-control/sync/route.ts). `maxDuration = 300` ([`sync/route.ts:4`](../../../src/app/api/credit-control/sync/route.ts)).

**Auth:** session required (`requireCreditControlSession()`).

**Request:** none (no body is read). The Wise institute is taken from `process.env.WISE_INSTITUTE_ID`, falling back to the hard-coded `696e1f4d90102225641cc413` ([`run-sync-request.ts:141`](../../../src/lib/credit-control/run-sync-request.ts)).

**Side effects** (in `runCreditControlSyncRequest` → `acquireSyncRun`, [`run-sync-request.ts:106-160`](../../../src/lib/credit-control/run-sync-request.ts)):

1. Marks any `credit_control_sync_runs` row still `running` after **20 minutes** as `failed` with a timeout `errorSummary`, and counts how many were failed (`staleRunningSyncsFailed`) ([`run-sync-request.ts:9,50-68`](../../../src/lib/credit-control/run-sync-request.ts)).
2. If another run is currently `running`, **skips** without starting work (see 202 below).
3. Otherwise inserts a new `credit_control_sync_runs` row with `status: "running"`; a concurrent insert that hits a `23505` unique violation is re-resolved to the running run and also skipped ([`run-sync-request.ts:117-135`](../../../src/lib/credit-control/run-sync-request.ts)).
4. Runs `runCreditControlSync(...)` ([`run-sync-request.ts:149`](../../../src/lib/credit-control/run-sync-request.ts)), which fetches Wise data, writes a new credit-control snapshot, and atomically promotes it on success.

**Response — skipped (202):** when a sync is already running, the guard object is returned with HTTP **202** ([`run-sync-request.ts:145-147`](../../../src/lib/credit-control/run-sync-request.ts)). Shape (`SkippedCreditControlSyncResult`, [`run-sync-request.ts:24-39`](../../../src/lib/credit-control/run-sync-request.ts)): `success: true`, `skipped: true`, `alreadyRunning: true`, `syncRunId`, `snapshotId: null`, `promotedSnapshotId: null`, zeroed counts, `errorSummary: null`, a human `message`, `runningStartedAt`, `staleRunningSyncsFailed`.

**Response — ran (200 or 500):** the `runCreditControlSync` result spread with `syncRunId` and `staleRunningSyncsFailed` added; HTTP **200** when `result.success`, else **500** ([`run-sync-request.ts:153-159`](../../../src/lib/credit-control/run-sync-request.ts)). The result shape is `CreditControlSyncResult` ([`sync.ts:41-49`](../../../src/lib/credit-control/sync.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `success` | boolean | Drives the 200 vs. 500 status. |
| `snapshotId` | string \| undefined | New snapshot id (present on success). |
| `promotedSnapshotId` | string \| undefined | Promoted snapshot id. |
| `studentCount` | number | Students written. |
| `packageCount` | number | Packages written. |
| `sessionCount` | number | Sessions written. |
| `failedCreditPairs` | number | Student/package pairs whose Wise credit fetch failed. |
| `errorSummary` | string \| undefined | Set on failure. |

**Status codes:** `200` sync ran and succeeded · `202` skipped (already running) · `401` unauthorized · `500` sync ran and failed, or the request threw (`"Credit control sync failed"`).

---

## Follow-up actions

These endpoints record an admin's follow-up state on a student (`contacted`, `pending-callback`, `resolved`) and append to an audit log. The two write endpoints resolve the `studentKey` against the live payload first, returning **404** if the student is not present.

The valid status set is normalized by `normalizeStudentActionStatus()` — `String(status).trim().toLowerCase()` must be one of `contacted`, `pending-callback`, `resolved`, else it yields `null` ([`action-helpers.ts:17-24`](../../../src/lib/credit-control/action-helpers.ts)).

### `POST /api/credit-control/actions`

Sets or clears the follow-up status for a single student. Handler: [`actions/route.ts:7-56`](../../../src/app/api/credit-control/actions/route.ts).

**Auth:** session required.

**Request body** (JSON, no schema — cast inline at [`actions/route.ts:10`](../../../src/app/api/credit-control/actions/route.ts)):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | Trimmed; `400 "studentKey is required"` if blank. |
| `status` | string \| null | no | Normalized; a recognized value **sets** the action, anything else (incl. `null`/empty/unknown) **clears** it. |

The student must exist in the live payload (used to resolve `studentName`/`parentName`), else `404 "Student not found"` ([`actions/route.ts:17-21`](../../../src/app/api/credit-control/actions/route.ts)).

**Side effects:**
- A valid `status` → `setStudentAction(...)`: upserts `credit_control_follow_up_state` and appends a `set` row to `credit_control_follow_up_log`, stamping `updatedByEmail`/`updatedByName` ([`actions.ts:57-76`](../../../src/lib/credit-control/actions.ts)).
- Otherwise → `clearStudentAction(...)`: deletes the follow-up-state row and appends a `clear` log row ([`actions.ts:78-90`](../../../src/lib/credit-control/actions.ts)).
- Both revalidate the `credit-control` cache tag.

**Response (200):** `{ ok: true, studentKey, actionState }` where `actionState` is the optimistic state `{ status, updatedAt, updatedByName, isToday: true }` when a status was set, or `null` when cleared ([`actions/route.ts:24-31,52`](../../../src/app/api/credit-control/actions/route.ts)).

**Status codes:** `200` · `400` missing `studentKey` · `401` · `404` `"Student not found"` · `500` (`"Action request failed"`).

### `POST /api/credit-control/actions/bulk`

Sets or clears the follow-up status for many students at once. Handler: [`actions/bulk/route.ts:7-70`](../../../src/app/api/credit-control/actions/bulk/route.ts).

**Auth:** session required.

**Request body** (JSON, no schema):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKeys` | string[] | yes | De-duplicated, trimmed, empties dropped; `400 "studentKeys is required"` if the resulting set is empty ([`actions/bulk/route.ts:11-17`](../../../src/app/api/credit-control/actions/bulk/route.ts)). |
| `status` | string \| null | yes-ish | `null` or `""` means **clear**; otherwise must normalize to a valid status, else `400 "valid status is required"` ([`actions/bulk/route.ts:19-23`](../../../src/app/api/credit-control/actions/bulk/route.ts)). |

`studentKeys` are intersected with the live payload's students; unknown keys are silently dropped. If none match, the handler returns `200 { "updated": [] }` without touching the DB ([`actions/bulk/route.ts:25-37`](../../../src/app/api/credit-control/actions/bulk/route.ts)).

**Side effects:** `bulkSetAction(...)` (per-student upsert + `bulk-set` log row) or `bulkClearAction(...)` (per-student delete + `bulk-clear` log row); single cache revalidation at the end ([`actions.ts:92-129`](../../../src/lib/credit-control/actions.ts)).

**Response (200):** `{ updated: [{ studentKey, actionState }, ...] }`, one entry per matched student. `actionState` is `{ status, updatedAt, updatedByName, isToday: true }` for a set, or `null` for a clear ([`actions/bulk/route.ts:54-66`](../../../src/app/api/credit-control/actions/bulk/route.ts)).

**Status codes:** `200` (including the empty-match case) · `400` missing `studentKeys` or invalid `status` · `401` · `500` (`"Bulk action request failed"`).

### `GET /api/credit-control/actions/history`

Returns the recent follow-up audit log for one student. Handler: [`actions/history/route.ts:5-27`](../../../src/app/api/credit-control/actions/history/route.ts).

**Auth:** session required.

**Query parameters:**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | Trimmed; `400 "studentKey is required"` if blank. |

**Response (200):** `{ history: [...] }`, mapped from `readCreditActionHistory(studentKey, 7)` — `credit_control_follow_up_log` rows from the **last 7 days**, newest first ([`db.ts:233-248`](../../../src/lib/credit-control/db.ts)). Each item ([`actions/history/route.ts:16-21`](../../../src/app/api/credit-control/actions/history/route.ts)):

| Field | Type | Source column |
|-------|------|---------------|
| `status` | string \| null | `status` |
| `updatedAt` | string (ISO) | `createdAt` |
| `updatedByName` | string | `actorName` |
| `actionType` | string | `actionType` (`set`/`clear`/`bulk-set`/`bulk-clear`) |

**Side effects:** none.

**Status codes:** `200` · `400` missing `studentKey` · `401` · `500` (`"Failed to load history"`).

---

## Ownership

### `POST /api/credit-control/admin-ownership`

Assigns a student to a named admin owner (sidecar table, survives snapshot rotation). Handler: [`admin-ownership/route.ts:7-37`](../../../src/app/api/credit-control/admin-ownership/route.ts).

**Auth:** session required.

**Request body** (JSON, no schema):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | Trimmed. |
| `adminKey` | string | yes | Trimmed; must be one of the keys from `getAdminViewOptions()` (`all`, the six named admins, `unassigned`), else `400 "Unknown adminKey"` ([`admin-ownership/route.ts:18-20`](../../../src/app/api/credit-control/admin-ownership/route.ts), [`config.ts:105-111`](../../../src/lib/credit-control/config.ts)). |

Both fields blank/missing → `400 "studentKey and adminKey are required"`.

**Side effects:** `upsertCreditAdminOwnership({ studentKey, adminKey, assignedByEmail })` into `credit_control_admin_ownership` ([`db.ts:297`](../../../src/lib/credit-control/db.ts)), then `revalidateTag("credit-control", { expire: 0 })` inline ([`admin-ownership/route.ts:22-27`](../../../src/app/api/credit-control/admin-ownership/route.ts)). Unlike the follow-up routes, this handler does **not** look the student up in the payload, so it never returns 404.

**Response (200):** `{ ok: true, studentKey, adminKey }`.

**Status codes:** `200` · `400` missing fields or unknown `adminKey` · `401` · `500` (`"Admin ownership update failed"`).

---

## Inactive flag

The same file serves both verbs. Both resolve `studentKey` from the request body; both revalidate the `credit-control` cache via the service layer ([`actions.ts:131-139`](../../../src/lib/credit-control/actions.ts)).

### `POST /api/credit-control/inactive`

Marks a student inactive (excludes them from the at-risk queue). Handler: [`inactive/route.ts:6-33`](../../../src/app/api/credit-control/inactive/route.ts).

**Auth:** session required.

**Request body** (JSON, no schema):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | Trimmed; `400 "studentKey is required"` if blank. |

The student must exist in the live payload (used to resolve `studentName`/`parentName`), else `404 "Student not found"` ([`inactive/route.ts:16-21`](../../../src/app/api/credit-control/inactive/route.ts)).

**Side effects:** `markInactiveStudent(...)` → `markCreditInactive(...)` upserts `credit_control_inactive_students` (conflict on `studentKey` updates names/`markedAt`/`markedByEmail`) ([`db.ts:254-267`](../../../src/lib/credit-control/db.ts)); then cache revalidation.

**Response (200):** `{ ok: true }`.

**Status codes:** `200` · `400` missing `studentKey` · `401` · `404` `"Student not found"` · `500` (`"Inactive request failed"`).

### `DELETE /api/credit-control/inactive`

Clears the inactive flag for a student. Handler: [`inactive/route.ts:35-50`](../../../src/app/api/credit-control/inactive/route.ts).

**Auth:** session required.

**Request body** (JSON, no schema):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | Trimmed; `400 "studentKey is required"` if blank. |

Unlike the `POST`, this verb does **not** consult the payload, so it never returns 404 — deleting a non-existent row is a no-op.

**Side effects:** `clearInactiveStudent(studentKey)` → `clearCreditInactive(...)` deletes the `credit_control_inactive_students` row ([`db.ts:269-273`](../../../src/lib/credit-control/db.ts)); then cache revalidation.

**Response (200):** `{ ok: true }`.

**Status codes:** `200` · `400` missing `studentKey` · `401` · `500` (`"Inactive request failed"`).

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
