# Credit Control API

**Authoritative source:** the seven route files under [`src/app/api/credit-control/`](../../../src/app/api/credit-control/), which export the eight handlers documented here.

This page is the mechanical reference for the Credit Control HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. Feature meaning — what the worklist is for, how depletion projection and the at-risk ranking work, why a student gets removed — lives in [docs/features/credit-control.md](../../features/credit-control.md). Column definitions for the `credit_control_*` tables live in [`schema.ts`](../../../src/lib/db/schema.ts) and are indexed from [docs/reference/database/index.md](../database/index.md).

## Endpoints at a glance

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/credit-control` | Read the full dashboard payload (worklist, calendar, summary, inactive list). |
| `POST` | `/api/credit-control/actions` | Set or clear one student's follow-up status. |
| `POST` | `/api/credit-control/actions/bulk` | Set or clear follow-up status for many students at once. |
| `GET` | `/api/credit-control/actions/history` | Read one student's follow-up log for the last 7 days. |
| `POST` | `/api/credit-control/admin-ownership` | Assign a student to an admin owner. |
| `DELETE` | `/api/credit-control/inactive` | Restore a hidden student to the worklist. |
| `POST` | `/api/credit-control/inactive` | Hide a student from the worklist ("No Longer Active"). |
| `POST` | `/api/credit-control/sync` | Run a manual Wise credit-control sync. |

Both `/inactive` handlers live in the same file ([`inactive/route.ts`](../../../src/app/api/credit-control/inactive/route.ts)); the other six are one handler per file.

---

## Conventions shared across the endpoints

**Authentication is a session, not a role.** Every handler calls `requireCreditControlSession()`, which reads the Auth.js session, requires both an email and a name, lowercases/trims the email, falls back to the email when the profile carries no name, and otherwise throws `Error("Unauthorized")` ([`api.ts:5-15`](../../../src/lib/credit-control/api.ts)). The middleware gates the subtree first: `/api/credit-control/**` is not in the public-route allowlist ([`middleware.ts:4-20`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:71-75`](../../../src/middleware.ts)), and a signed-in user whose `allowedPages` does not cover `/credit-control` gets `403 {"error":"Forbidden"}` from the middleware — `isPathAllowed` matches every allowed page both as `/x` and as `/api/x` ([`middleware.ts:30-61,79-82`](../../../src/middleware.ts)). The in-handler check is the API-level backstop and the only source of a `401`.

**One shared error envelope.** Every handler wraps its body in `try`/`catch` and routes failures through `creditControlErrorResponse(route, error, fallbackMessage)` ([`api.ts:17-36`](../../../src/lib/credit-control/api.ts)):

- A Next.js `HANGING_PROMISE_REJECTION` digest is **re-thrown**, not converted into a response ([`api.ts:18-25`](../../../src/lib/credit-control/api.ts)).
- `Error("Unauthorized")` → `401 {"error":"Unauthorized"}` ([`api.ts:27-29`](../../../src/lib/credit-control/api.ts)).
- Anything else → `console.error(route, error)` then `500 {"error": <error.message, or the handler's fallback string>}` ([`api.ts:31-35`](../../../src/lib/credit-control/api.ts)).

**No Zod.** None of the eight handlers use a schema. Bodies are read with a bare `await request.json()` cast to an inline TypeScript type, then validated by hand (`String(x ?? "").trim()` plus `if` checks). Two consequences:

- A malformed or absent JSON body makes `request.json()` throw **inside** the outer `try`, so it surfaces as **500**, not 400 — a deviation from the repo-wide auth → JSON → Zod → logic convention.
- Unknown fields are ignored, and non-string values are coerced by `String(...)` rather than rejected.

**Snapshot dependency.** `GET /api/credit-control`, both action-writing routes, and `POST /api/credit-control/inactive` all call `getCreditControlPayload()`, which loads the single `active` credit-control snapshot. With no active snapshot the loader throws `No active credit-control snapshot found. Run credit sync first.` ([`db.ts:88-95`](../../../src/lib/credit-control/db.ts)), which the envelope reports as **500** carrying that exact message.

**Cache invalidation.** The payload builder is a cached function — `"use cache"`, `cacheTag("credit-control")`, `cacheLife({ stale: 60, revalidate: 60, expire: 300 })` ([`service.ts:31-33`](../../../src/lib/credit-control/service.ts); tag constant at [`config.ts:11`](../../../src/lib/credit-control/config.ts)). Every mutating endpoint calls `revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 })` after its writes so the next read rebuilds ([`actions.ts:79,93,116,132,137,142`](../../../src/lib/credit-control/actions.ts), [`admin-ownership/route.ts:27`](../../../src/app/api/credit-control/admin-ownership/route.ts), [`sync.ts:728`](../../../src/lib/credit-control/sync.ts)).

**Student identity.** Every request addresses a student by `studentKey` — the stable dashboard key `normalize(studentName) :: normalize(parentName)` ([`helpers.ts:17-22`](../../../src/lib/credit-control/helpers.ts), re-exported as `fallbackStudentKey` at [`db.ts:326-328`](../../../src/lib/credit-control/db.ts)). The four sidecar tables written by these endpoints — `credit_control_follow_up_state` ([`schema.ts:1280-1290`](../../../src/lib/db/schema.ts)), `credit_control_follow_up_log` ([`schema.ts:1292-1305`](../../../src/lib/db/schema.ts)), `credit_control_inactive_students` ([`schema.ts:1307-1317`](../../../src/lib/db/schema.ts)), `credit_control_admin_ownership` ([`schema.ts:1331-1339`](../../../src/lib/db/schema.ts)) — are all keyed on it and survive snapshot rotation.

**In-app callers.** Six of the eight endpoints are called from [`dashboard-shell.tsx`](../../../src/components/credit-control/dashboard-shell.tsx) ([lines 140, 367, 408, 499, 549, 605](../../../src/components/credit-control/dashboard-shell.tsx)). `POST /api/credit-control/sync` and `POST /api/credit-control/admin-ownership` have no `fetch()` call site anywhere in `src/` — see [Open questions](#open-questions).

---

## Reading the worklist

### `GET /api/credit-control`

Returns the whole Credit Control dashboard payload in one response. Handler: [`route.ts:5-13`](../../../src/app/api/credit-control/route.ts).

**Auth:** session required (`requireCreditControlSession()`, [`route.ts:7`](../../../src/app/api/credit-control/route.ts)).

**Request:** no query parameters, no body. The handler calls `getCreditControlPayload()` with its defaults — `todayKey` is today in Asia/Bangkok and recovered-action clearing stays enabled ([`service.ts:27-30`](../../../src/lib/credit-control/service.ts)).

**Response 200** — a `DashboardPayload` object returned bare (no `ok`/`data` envelope). Type at [`types/credit-control.ts:224-240`](../../../src/types/credit-control.ts); assembled by `buildDashboardModel` ([`analytics.ts:30-70`](../../../src/lib/credit-control/analytics.ts)) and then patched with the inactive list ([`service.ts:97-104`](../../../src/lib/credit-control/service.ts)).

| Key | Type | Meaning |
|-----|------|---------|
| `adminViews` | `AdminViewOption[]` | Options for the owner filter: `all`, the six registry admins, `unassigned` ([`config.ts:110-116`](../../../src/lib/credit-control/config.ts)). |
| `lastUpdatedAt` | string | The active snapshot's `generatedAt`, rendered by `formatDateTime` as `YYYY-MM-DDTHH:mm:ss+07:00` — Asia/Bangkok wall clock with a hard-coded `+07:00` suffix ([`helpers.ts:66-85`](../../../src/lib/credit-control/helpers.ts), [`analytics.ts:58`](../../../src/lib/credit-control/analytics.ts), [`service.ts:88-93`](../../../src/lib/credit-control/service.ts)). |
| `previousUpdatedAt` | `string \| null` | Always `null` on this path — the service passes `{ lastSnapshot: null, history: [] }` as the snapshot state ([`service.ts:88-93`](../../../src/lib/credit-control/service.ts), [`analytics.ts:59`](../../../src/lib/credit-control/analytics.ts)). |
| `summary` | `SummaryPayload` | Student/package status counts, portfolio risk buckets (`exhaustedNow`, `risk7/14/30`, `noSchedule`, pending-deduction backlog, …), queue counts, and `deltas`. Because `previousUpdatedAt` is always `null` here, all eight `deltas` fields are `null` ([`analytics.ts:551-563,567-582`](../../../src/lib/credit-control/analytics.ts), [`types/credit-control.ts:183-213`](../../../src/types/credit-control.ts)). |
| `studentQueue` | `StudentQueueRow[]` | The at-risk worklist — `studentQueueAll` filtered to `includeInQueue` ([`analytics.ts:48-49`](../../../src/lib/credit-control/analytics.ts)). |
| `studentQueueAll` | `StudentQueueRow[]` | Every active student as a queue row; the client switches to this list when a search term is active ([`types/credit-control.ts:230-235`](../../../src/types/credit-control.ts)). |
| `calendar` | `CalendarPayload` | `{ availableStart, availableEnd, days[] }`, each day carrying per-student session entries ([`types/credit-control.ts:169-181`](../../../src/types/credit-control.ts)). |
| `students` | `StudentRecord[]` | Full per-student detail: packages, projections, pending deductions, `adminOwnerKey`/`adminOwnerName`/`adminOwnershipSource`, and `actionState` ([`types/credit-control.ts:93-110`](../../../src/types/credit-control.ts)). |
| `inactiveStudents` | `InactiveStudentSummary[]` (optional) | Students hidden from the worklist, so the UI can list and restore them: `{ studentKey, student, parent, source, markedAt, removedAtRemaining }` ([`types/credit-control.ts:215-222`](../../../src/types/credit-control.ts), [`service.ts:97-104`](../../../src/lib/credit-control/service.ts)). |

**Side effects.** This `GET` is not purely read-only. Inside the cached payload build:

1. Admin ownership is merged onto each student from `credit_control_admin_ownership`; students with no row keep their default ([`service.ts:70-76`](../../../src/lib/credit-control/service.ts), [`db.ts:290-310`](../../../src/lib/credit-control/db.ts)).
2. Follow-up states are attached and `isToday` is recomputed against the Bangkok day ([`service.ts:78`](../../../src/lib/credit-control/service.ts), [`action-helpers.ts:26-55`](../../../src/lib/credit-control/action-helpers.ts)).
3. **Auto-clear write:** `clearRecoveredActionStates` deletes the `credit_control_follow_up_state` row for any student that has an action state but no package left in `notify`/`watch`, and appends a `credit_control_follow_up_log` entry with `actionType: "auto-clear"` attributed to `system@begifted.local` / `System` ([`service.ts:24-25,79-81,109-136`](../../../src/lib/credit-control/service.ts)).
4. Students listed in `credit_control_inactive_students` are filtered out of the worklist but still returned under `inactiveStudents` ([`service.ts:83-104`](../../../src/lib/credit-control/service.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Payload returned. |
| 401 | No session, or a session without email/name ([`api.ts:27-29`](../../../src/lib/credit-control/api.ts)). |
| 403 | Middleware page-access denial for a restricted user ([`middleware.ts:79-82`](../../../src/middleware.ts)). |
| 500 | No active snapshot, or any other thrown error; fallback message `Credit control load failed` ([`route.ts:11`](../../../src/app/api/credit-control/route.ts)). |

---

## Follow-up actions

Three endpoints share one status vocabulary. `normalizeStudentActionStatus` lowercases and trims the input and accepts only `contacted`, `pending-callback`, `resolved`; anything else returns `null` ([`action-helpers.ts:17-24`](../../../src/lib/credit-control/action-helpers.ts), type at [`types/credit-control.ts:2`](../../../src/types/credit-control.ts)). Current state lives in `credit_control_follow_up_state` (one row per student, upserted on `student_key`, [`db.ts:210-225`](../../../src/lib/credit-control/db.ts)) and every transition is appended to `credit_control_follow_up_log` ([`db.ts:227-229`](../../../src/lib/credit-control/db.ts)).

### `POST /api/credit-control/actions`

Sets or clears the follow-up status of a single student. Handler: [`actions/route.ts:7-56`](../../../src/app/api/credit-control/actions/route.ts).

**Auth:** session required; the session's `email`/`name` are stamped onto the state row and the log entry ([`actions/route.ts:9,38-48`](../../../src/app/api/credit-control/actions/route.ts)).

**Request body** (JSON, no schema — inline cast at [`actions/route.ts:10`](../../../src/app/api/credit-control/actions/route.ts)):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | Trimmed; empty → 400 `studentKey is required` ([`actions/route.ts:11-15`](../../../src/app/api/credit-control/actions/route.ts)). Must match a student in the current payload, else 404. |
| `status` | `"contacted" \| "pending-callback" \| "resolved" \| null` | no | Passed through `normalizeStudentActionStatus`. **Any unrecognised value is treated as "clear", not as an error** ([`actions/route.ts:23`](../../../src/app/api/credit-control/actions/route.ts)) — the one place this route diverges from the bulk route. |

**Side effects:**

- With a valid status: `setStudentAction` upserts `credit_control_follow_up_state` and appends a log row with `actionType: "set"` ([`actions.ts:61-80`](../../../src/lib/credit-control/actions.ts)).
- Otherwise: `clearStudentAction` deletes the state row and appends `actionType: "clear"` with `status: null` ([`actions.ts:82-94`](../../../src/lib/credit-control/actions.ts)).
- Both paths end in `revalidateTag("credit-control", { expire: 0 })` ([`actions.ts:79,93`](../../../src/lib/credit-control/actions.ts)).
- The student lookup itself runs the cached payload build, so the `GET` side effects above (including the auto-clear sweep) can fire as a by-product ([`actions/route.ts:17`](../../../src/app/api/credit-control/actions/route.ts)).

**Response 200** — `{ ok: true, studentKey, actionState }`, where `actionState` is `null` on a clear and otherwise `{ status, updatedAt, updatedByName, isToday: true }` with `updatedAt` generated in the handler, not read back from the row ([`actions/route.ts:24-31,52`](../../../src/app/api/credit-control/actions/route.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | State written. |
| 400 | `studentKey` missing or blank ([`actions/route.ts:13-15`](../../../src/app/api/credit-control/actions/route.ts)). |
| 401 | No session. |
| 404 | `Student not found` — the key is absent from the current payload ([`actions/route.ts:19-21`](../../../src/app/api/credit-control/actions/route.ts)). |
| 500 | Unparseable body, missing snapshot, or DB failure; fallback `Action request failed` ([`actions/route.ts:54`](../../../src/app/api/credit-control/actions/route.ts)). |

### `POST /api/credit-control/actions/bulk`

Applies one status (or a clear) to many students in a single request. Handler: [`actions/bulk/route.ts:7-70`](../../../src/app/api/credit-control/actions/bulk/route.ts).

**Auth:** session required; actor email/name are stamped on every row written ([`actions/bulk/route.ts:9,42-50`](../../../src/app/api/credit-control/actions/bulk/route.ts)).

**Request body** (JSON, no schema — inline cast at [`actions/bulk/route.ts:10`](../../../src/app/api/credit-control/actions/bulk/route.ts)):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKeys` | `string[]` | yes | Each entry is `String(...).trim()`ed, blanks dropped, then de-duplicated through a `Set` ([`actions/bulk/route.ts:11-13`](../../../src/app/api/credit-control/actions/bulk/route.ts)). An empty result → 400 `studentKeys is required`. |
| `status` | `"contacted" \| "pending-callback" \| "resolved" \| null \| ""` | yes | Exactly `null` or `""` means **clear**; anything else must normalize to a valid status or the request is rejected with 400 `valid status is required` ([`actions/bulk/route.ts:19-23`](../../../src/app/api/credit-control/actions/bulk/route.ts)). |

**Side effects:**

- Keys are resolved against the current payload; unknown keys are silently dropped ([`actions/bulk/route.ts:25-33`](../../../src/app/api/credit-control/actions/bulk/route.ts)).
- If nothing resolves, the handler returns `200 { "updated": [] }` and writes nothing ([`actions/bulk/route.ts:35-37`](../../../src/app/api/credit-control/actions/bulk/route.ts)).
- Otherwise `bulkSetAction` / `bulkClearAction` fan out with `Promise.all`, writing one state upsert (or delete) plus one log row per student with `actionType: "bulk-set"` / `"bulk-clear"`, then revalidating the cache tag once ([`actions.ts:96-133`](../../../src/lib/credit-control/actions.ts)). There is **no transaction**, so a partial failure can leave some students updated and the request still reported as 500.

**Response 200** — `{ updated: Array<{ studentKey, actionState }> }`. One `updatedAt` ISO timestamp is generated for the whole batch and reused in every `actionState`; on a clear each `actionState` is `null` ([`actions/bulk/route.ts:53-66`](../../../src/app/api/credit-control/actions/bulk/route.ts)). Keys that did not resolve are simply absent from `updated`.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Batch applied (possibly with an empty `updated` array). |
| 400 | Empty `studentKeys`, or a non-clear `status` that is not one of the three valid values. |
| 401 | No session. |
| 500 | Unparseable body, missing snapshot, or DB failure; fallback `Bulk action request failed` ([`actions/bulk/route.ts:68`](../../../src/app/api/credit-control/actions/bulk/route.ts)). |

### `GET /api/credit-control/actions/history`

Returns the recent follow-up log for one student. Handler: [`actions/history/route.ts:5-27`](../../../src/app/api/credit-control/actions/history/route.ts).

**Auth:** session required ([`actions/history/route.ts:7`](../../../src/app/api/credit-control/actions/history/route.ts)). The session identity is not otherwise used — the return value is discarded.

**Query parameters:**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | Trimmed; blank or absent → 400 `studentKey is required` ([`actions/history/route.ts:9-13`](../../../src/app/api/credit-control/actions/history/route.ts)). Not validated against the payload — an unknown key yields an empty list, not a 404. |

The lookback window is fixed: the handler calls `readCreditActionHistory(studentKey, 7)`, i.e. `credit_control_follow_up_log` rows with `created_at >= now - 7 days`, ordered newest first, with **no row limit** ([`actions/history/route.ts:15`](../../../src/app/api/credit-control/actions/history/route.ts), [`db.ts:237-252`](../../../src/lib/credit-control/db.ts)).

**Side effects:** none — the only endpoint in this group that neither writes nor builds the cached payload.

**Response 200** — `{ history: Array<{ status, updatedAt, updatedByName, actionType }> }` ([`actions/history/route.ts:16-23`](../../../src/app/api/credit-control/actions/history/route.ts)):

| Field | Type | Source |
|-------|------|--------|
| `status` | `string \| null` | `credit_control_follow_up_log.status`; `null` for clears. |
| `updatedAt` | string (ISO) | `created_at.toISOString()`. |
| `updatedByName` | string | `actor_name`. |
| `actionType` | string | A free-text column ([`schema.ts:1297`](../../../src/lib/db/schema.ts)); in practice `set`, `clear`, `bulk-set`, `bulk-clear`, or `auto-clear` (written by the recovery sweep at [`service.ts:129`](../../../src/lib/credit-control/service.ts)). |

**Status codes:**

| Status | When |
|--------|------|
| 200 | History returned (possibly empty). |
| 400 | `studentKey` missing or blank. |
| 401 | No session. |
| 500 | DB failure; fallback `Failed to load history` ([`actions/history/route.ts:25`](../../../src/app/api/credit-control/actions/history/route.ts)). |

---

## Admin ownership

### `POST /api/credit-control/admin-ownership`

Assigns a student to an admin owner in the `credit_control_admin_ownership` sidecar. Handler: [`admin-ownership/route.ts:7-37`](../../../src/app/api/credit-control/admin-ownership/route.ts).

**Auth:** session required; `session.email` is recorded as `assigned_by_email` ([`admin-ownership/route.ts:9,22-26`](../../../src/app/api/credit-control/admin-ownership/route.ts)).

**Request body** (JSON, no schema — inline cast at [`admin-ownership/route.ts:10`](../../../src/app/api/credit-control/admin-ownership/route.ts)):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | Trimmed; blank → 400 `studentKey and adminKey are required` ([`admin-ownership/route.ts:14-16`](../../../src/app/api/credit-control/admin-ownership/route.ts)). **Not** checked against the payload — an arbitrary key is accepted and stored. |
| `adminKey` | string | yes | Must match a key returned by `getAdminViewOptions()`, else 400 `Unknown adminKey` ([`admin-ownership/route.ts:18-20`](../../../src/app/api/credit-control/admin-ownership/route.ts)). That list is `all`, the six registry admins `palm`/`kem`/`care`/`aya`/`petchy`/`muk`, and `unassigned` ([`config.ts:28-35,110-116`](../../../src/lib/credit-control/config.ts)). |

Because the validation list is the *view* list, `adminKey: "all"` passes — see [Open questions](#open-questions).

**Side effects:**

- `upsertCreditAdminOwnership` inserts or updates the row keyed on `student_key`, setting `admin_key`, `assigned_by_email`, and `updated_at` ([`db.ts:312-324`](../../../src/lib/credit-control/db.ts)).
- `revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 })` ([`admin-ownership/route.ts:27`](../../../src/app/api/credit-control/admin-ownership/route.ts)), so the next payload read reflects the new owner. On read, the display name comes from the registry label; `unassigned` renders as `Unassigned`, and any other key outside the registry is echoed back verbatim as the name. `adminOwnershipSource` becomes `postgres-sidecar` ([`db.ts:290-310`](../../../src/lib/credit-control/db.ts)).

**Response 200** — `{ ok: true, studentKey, adminKey }` ([`admin-ownership/route.ts:29`](../../../src/app/api/credit-control/admin-ownership/route.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Ownership written. |
| 400 | `studentKey` or `adminKey` blank; or `adminKey` not in the admin-view option list. |
| 401 | No session. |
| 500 | Unparseable body or DB failure; fallback `Admin ownership update failed` ([`admin-ownership/route.ts:31-35`](../../../src/app/api/credit-control/admin-ownership/route.ts)). |

---

## Inactive students

Both handlers live in [`inactive/route.ts`](../../../src/app/api/credit-control/inactive/route.ts) and operate on `credit_control_inactive_students` — the table whose members are filtered out of `studentQueue`/`studentQueueAll` and surfaced under `inactiveStudents` instead ([`service.ts:83-104`](../../../src/lib/credit-control/service.ts)). Both take a **JSON body**, including the `DELETE` ([`dashboard-shell.tsx:499-503,549-553`](../../../src/components/credit-control/dashboard-shell.tsx)).

### `POST /api/credit-control/inactive`

Marks a student "No Longer Active" and hides them from the worklist. Handler: [`inactive/route.ts:6-38`](../../../src/app/api/credit-control/inactive/route.ts).

**Auth:** session required; `session.email` is stored as `marked_by_email` ([`inactive/route.ts:8,25-32`](../../../src/app/api/credit-control/inactive/route.ts)).

**Request body** (JSON, no schema):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | Trimmed; blank → 400 `studentKey is required` ([`inactive/route.ts:9-14`](../../../src/app/api/credit-control/inactive/route.ts)). Must exist in the current payload, else 404 `Student not found` ([`inactive/route.ts:16-21`](../../../src/app/api/credit-control/inactive/route.ts)). |

**Side effects:**

- The handler sums `currentRemaining` across the student's packages and stores it as `removed_at_remaining` ([`inactive/route.ts:22-24`](../../../src/app/api/credit-control/inactive/route.ts)). This is load-bearing: the churn state machine only reactivates a student once their balance rises above `max(removedAtRemaining, 0)`, so a manual removal made while credits remain does not bounce back on the next sync ([`churn.ts:75-84,113-117`](../../../src/lib/credit-control/churn.ts)).
- `markInactiveStudent` upserts the row with `source: "manual"` and revalidates the cache tag ([`inactive/route.ts:25-32`](../../../src/app/api/credit-control/inactive/route.ts), [`actions.ts:135-138`](../../../src/lib/credit-control/actions.ts), [`db.ts:258-282`](../../../src/lib/credit-control/db.ts)). Rows written by the automatic churn sweep during a sync instead carry `source: "auto-churn"` ([`sync.ts:579,589`](../../../src/lib/credit-control/sync.ts), [`schema.ts:1313-1314`](../../../src/lib/db/schema.ts)).
- Any existing follow-up state is left untouched — hiding is orthogonal to the action state.

**Response 200** — `{ ok: true }` ([`inactive/route.ts:34`](../../../src/app/api/credit-control/inactive/route.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Student marked inactive. |
| 400 | `studentKey` missing or blank. |
| 401 | No session. |
| 404 | `Student not found` in the current payload. |
| 500 | Unparseable body, missing snapshot, or DB failure; fallback `Inactive request failed` ([`inactive/route.ts:36`](../../../src/app/api/credit-control/inactive/route.ts)). |

### `DELETE /api/credit-control/inactive`

Restores a hidden student to the worklist. Handler: [`inactive/route.ts:40-55`](../../../src/app/api/credit-control/inactive/route.ts).

**Auth:** session required, but the identity is discarded — the handler does not bind the result of `requireCreditControlSession()` and writes no actor field ([`inactive/route.ts:42`](../../../src/app/api/credit-control/inactive/route.ts)). Restores are therefore not attributed anywhere.

**Request body** (JSON, no schema):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | Trimmed; blank → 400 `studentKey is required` ([`inactive/route.ts:43-48`](../../../src/app/api/credit-control/inactive/route.ts)). |

**Side effects:** `clearInactiveStudent` deletes the `credit_control_inactive_students` row and revalidates the cache tag ([`inactive/route.ts:50`](../../../src/app/api/credit-control/inactive/route.ts), [`actions.ts:140-143`](../../../src/lib/credit-control/actions.ts), [`db.ts:284-288`](../../../src/lib/credit-control/db.ts)). Unlike the `POST`, there is **no payload lookup and no 404** — deleting a non-existent key succeeds silently. The student reappears in the worklist on the next read, and the churn engine may re-remove them on a later sync if the 45-day zero-balance rule still holds ([`config.ts:16`](../../../src/lib/credit-control/config.ts)).

**Response 200** — `{ ok: true }` ([`inactive/route.ts:51`](../../../src/app/api/credit-control/inactive/route.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Row deleted (or was already absent). |
| 400 | `studentKey` missing or blank. |
| 401 | No session. |
| 500 | Missing/unparseable body or DB failure; fallback `Inactive request failed` ([`inactive/route.ts:53`](../../../src/app/api/credit-control/inactive/route.ts)). |

---

## Sync

### `POST /api/credit-control/sync`

Triggers a manual credit-control sync from Wise. Handler: [`sync/route.ts:6-13`](../../../src/app/api/credit-control/sync/route.ts), with `export const maxDuration = 300` ([`sync/route.ts:4`](../../../src/app/api/credit-control/sync/route.ts)).

**Auth:** session required ([`sync/route.ts:8`](../../../src/app/api/credit-control/sync/route.ts)). This is the admin-facing twin of the cron route `GET/POST /api/internal/sync-credit-control` (constant-time `CRON_SECRET`; the `POST` variant also accepts an admin session), which runs the same `runCreditControlSyncRequest()` body wrapped in a cron-invocation audit ([`internal/sync-credit-control/route.ts:33-71`](../../../src/app/api/internal/sync-credit-control/route.ts)). The scheduled run is `20,50 * * * *` ([`vercel.json:15-18`](../../../vercel.json)); see [internal-crons.md](./internal-crons.md).

**Request:** no body, no query parameters. The Wise institute comes from `process.env.WISE_INSTITUTE_ID`, falling back to the hard-coded `696e1f4d90102225641cc413` ([`run-sync-request.ts:141`](../../../src/lib/credit-control/run-sync-request.ts)).

**Single-flight guard** (`acquireSyncRun`, [`run-sync-request.ts:106-136`](../../../src/lib/credit-control/run-sync-request.ts)):

1. Any `credit_control_sync_runs` row still `running` after 20 minutes is force-failed with a fixed `errorSummary` ([`run-sync-request.ts:9-12,50-68`](../../../src/lib/credit-control/run-sync-request.ts)).
2. If a `running` row remains, the request is **skipped**, not queued ([`run-sync-request.ts:111-115`](../../../src/lib/credit-control/run-sync-request.ts)).
3. Otherwise a new `running` row is inserted. The partial unique index `ccsr_single_running_idx` permits only one `running` row ([`schema.ts:1177-1179`](../../../src/lib/db/schema.ts)), so a race raises Postgres `23505`; the handler treats that as "already running" rather than an error ([`run-sync-request.ts:41-48,124-135`](../../../src/lib/credit-control/run-sync-request.ts)).

**Side effects when the run proceeds** (`runCreditControlSync`, [`sync.ts:634-759`](../../../src/lib/credit-control/sync.ts)):

- Fetches students plus `PAST` (120 days back) and `FUTURE` (180 days forward) sessions from Wise, then per-pair credit records ([`sync.ts:60-62,650-659`](../../../src/lib/credit-control/sync.ts)).
- Inserts a new inactive `credit_control_snapshots` row ([`sync.ts:661-674`](../../../src/lib/credit-control/sync.ts)), chunk-inserts `credit_control_students` / `_packages` / `_sessions` / `_credit_history` ([`sync.ts:695-698`](../../../src/lib/credit-control/sync.ts)), then flips `active` to that snapshot in a single `UPDATE` ([`sync.ts:700-702`](../../../src/lib/credit-control/sync.ts)).
- Runs churn maintenance (auto-inactivate / reactivate) **best-effort**: a failure is logged and swallowed so it never invalidates the promoted snapshot ([`sync.ts:704-709`](../../../src/lib/credit-control/sync.ts)).
- Marks the run `success` with counts and `metadata.failedCreditPairs`, then `revalidateTag("credit-control", { expire: 0 })` ([`sync.ts:711-728`](../../../src/lib/credit-control/sync.ts)).
- On failure, the run row is set to `status: "failed"` with a truncated `errorSummary` and serialized error metadata, and the function **returns** `success: false` rather than throwing ([`sync.ts:738-759`](../../../src/lib/credit-control/sync.ts)).

**Response 202 — skipped** ([`run-sync-request.ts:84-104,145-147`](../../../src/lib/credit-control/run-sync-request.ts)):

```json
{
  "success": true, "skipped": true, "alreadyRunning": true,
  "syncRunId": "<uuid of the in-flight run>",
  "snapshotId": null, "promotedSnapshotId": null,
  "studentCount": 0, "packageCount": 0, "sessionCount": 0,
  "failedCreditPairs": 0, "errorSummary": null,
  "message": "Credit control sync is already running. Data will refresh when that run finishes.",
  "runningStartedAt": "<ISO>", "staleRunningSyncsFailed": 0
}
```

**Response 200 / 500 — run executed.** The body is the `CreditControlSyncResult` ([`sync.ts:49-58`](../../../src/lib/credit-control/sync.ts)) spread with `syncRunId` and `staleRunningSyncsFailed`; the status is `200` when `success` is `true` and `500` when it is `false` ([`run-sync-request.ts:149-159`](../../../src/lib/credit-control/run-sync-request.ts)). A failed sync therefore returns **500 with a structured result object**, not the `{ error }` envelope.

| Field | Type | Meaning |
|-------|------|---------|
| `success` | boolean | Whether the run completed and promoted a snapshot. |
| `snapshotId` / `promotedSnapshotId` | `string \| undefined` | The new snapshot; identical on success. On failure `snapshotId` is present only if the snapshot row had already been inserted, and `promotedSnapshotId` is absent. |
| `studentCount` / `packageCount` / `sessionCount` | number | Rows written; all `0` on failure. |
| `failedCreditPairs` | number | Student/package pairs whose Wise credit fetch failed without aborting the run. |
| `errorSummary` | `string \| undefined` | Present only on failure (truncated). |
| `syncRunId` | string | The `credit_control_sync_runs` row id for this request ([`run-sync-request.ts:155`](../../../src/lib/credit-control/run-sync-request.ts)). |
| `staleRunningSyncsFailed` | number | How many abandoned `running` rows this request force-failed. |

**Status codes:**

| Status | When |
|--------|------|
| 200 | Sync ran and succeeded. |
| 202 | Skipped — another run is already in flight. |
| 401 | No session. |
| 500 | Sync ran and failed (structured result body), or the handler itself threw (`{ error }` envelope, fallback `Credit control sync failed`, [`sync/route.ts:11`](../../../src/app/api/credit-control/sync/route.ts)). |

**Timeout caveat.** This route caps at `maxDuration = 300` while the cron twin was raised to `800` precisely because successful credit-control syncs were measured at 372–390s ([`internal/sync-credit-control/route.ts:7-14`](../../../src/app/api/internal/sync-credit-control/route.ts)). A manual sync through this endpoint is therefore expected to be killed by the platform mid-run, stranding its `running` row until the 20-minute watchdog fails it.

---

## Open questions

- `POST /api/credit-control/admin-ownership` validates `adminKey` against `getAdminViewOptions()`, which includes the `all` filter pseudo-option ([`config.ts:110-116`](../../../src/lib/credit-control/config.ts)). Assigning a student to `all` is accepted and persisted; on read it renders with the literal name `all` ([`db.ts:300-309`](../../../src/lib/credit-control/db.ts)). Whether that is intended is unresolved from the code alone.
- Neither `POST /api/credit-control/sync` nor `POST /api/credit-control/admin-ownership` has an in-app caller: a repo-wide search for `api/credit-control` finds `fetch()` call sites only for the other six endpoints, all in [`dashboard-shell.tsx`](../../../src/components/credit-control/dashboard-shell.tsx). Both may be operator-only endpoints or leftovers.
- `POST /api/credit-control/actions` silently coerces an unrecognised `status` into a clear, while `POST /api/credit-control/actions/bulk` rejects the same input with 400 ([`actions/route.ts:23`](../../../src/app/api/credit-control/actions/route.ts) vs [`actions/bulk/route.ts:19-23`](../../../src/app/api/credit-control/actions/bulk/route.ts)). Whether the single-student leniency is deliberate is not derivable from the code.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
