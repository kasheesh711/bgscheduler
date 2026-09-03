# Credit Control API

**Authoritative source:** the seven route files under [`src/app/api/credit-control/`](../../../src/app/api/credit-control/), which export the **eight** handlers documented on this page (`inactive/route.ts` exports two: `POST` and `DELETE`).

**Status: stable.** Feature meaning — what the worklist is for, how depletion projection and the at-risk ranking work, when a student is auto-churned — lives in [docs/features/credit-control.md](../../features/credit-control.md); this page does not restate it. Column definitions for the `credit_control_*` tables live in [docs/reference/database/erd-credit-control.md](../database/erd-credit-control.md). The scheduled sync that feeds all of this is a *different* endpoint, `/api/internal/sync-credit-control`, documented in [internal-crons.md](./internal-crons.md).

## Endpoints at a glance

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/credit-control` | session | Read the whole dashboard payload (summary, worklist, calendar, students, removed list). |
| `POST` | `/api/credit-control/actions` | session | Set or clear one student's follow-up status. |
| `POST` | `/api/credit-control/actions/bulk` | session | Set or clear follow-up status for many students in one call. |
| `GET` | `/api/credit-control/actions/history` | session | Read one student's follow-up log for the last 7 days. |
| `POST` | `/api/credit-control/admin-ownership` | session | Assign a student to a named admin owner. |
| `POST` | `/api/credit-control/inactive` | session | Hide a student from the worklist ("No Longer Active"). |
| `DELETE` | `/api/credit-control/inactive` | session | Restore a hidden student to the worklist. |
| `POST` | `/api/credit-control/sync` | session | Run a manual Wise credit-control sync (single-flight guarded). |

All eight paths are pinned in the production route-surface guard ([`production-route-surface.json:75-81`](../production-route-surface.json)), so adding or removing one fails `npm run guard:production-route-surface`.

**In-repo callers.** Six of the eight are called by the dashboard client shell [`dashboard-shell.tsx`](../../../src/components/credit-control/dashboard-shell.tsx): the payload load ([`:140`](../../../src/components/credit-control/dashboard-shell.tsx)), history ([`:367`](../../../src/components/credit-control/dashboard-shell.tsx)), single action ([`:408`](../../../src/components/credit-control/dashboard-shell.tsx)), inactive POST ([`:499`](../../../src/components/credit-control/dashboard-shell.tsx)), inactive DELETE ([`:549`](../../../src/components/credit-control/dashboard-shell.tsx)), and bulk ([`:605`](../../../src/components/credit-control/dashboard-shell.tsx)). **`POST /api/credit-control/admin-ownership` and `POST /api/credit-control/sync` have no in-repo caller** — no `fetch()` anywhere in `src/` targets either path. Ownership is otherwise seeded offline by `npm run credit-control:seed-admin-ownership` ([`package.json:19`](../../../package.json) → [`scripts/seed-credit-control-admin-ownership.ts`](../../../scripts/seed-credit-control-admin-ownership.ts)), which writes Postgres directly rather than calling the endpoint, and the cron path covers sync.

## Conventions shared across the eight endpoints

- **No Zod.** Unlike most BGScheduler routes, none of these handlers validate with a schema. Bodies are read as `(await request.json()) as { … }` and coerced with `String(x ?? "").trim()`; the only semantic validator is `normalizeStudentActionStatus`, a plain allowlist check over `["contacted", "pending-callback", "resolved"]` ([`action-helpers.ts:17-24`](../../../src/lib/credit-control/action-helpers.ts)). Zod appears in this feature only in the Wise-response parser [`wise.ts:1`](../../../src/lib/credit-control/wise.ts), never on the request path. Unknown body fields are ignored.
- **One auth helper.** Every handler starts with `await requireCreditControlSession()`, which reads the Auth.js session and throws the literal `Error("Unauthorized")` when either the email or the display name is missing ([`api.ts:5-15`](../../../src/lib/credit-control/api.ts)). It returns `{ email, name }` (`AppSessionUser`, [`types/credit-control.ts:264-267`](../../../src/types/credit-control.ts)) — the actor stamped onto every write. There is no role check beyond the session.
- **One error mapper.** Every handler's `catch` calls `creditControlErrorResponse(route, error, fallback)` ([`api.ts:17-36`](../../../src/lib/credit-control/api.ts)), which: re-throws a Next.js `HANGING_PROMISE_REJECTION` digest untouched; maps `Error("Unauthorized")` to **401** `{"error":"Unauthorized"}`; and otherwise `console.error`s the route plus error and returns **500** `{ error: <error.message or the fallback string> }`.
- **Malformed JSON is a 500, not a 400.** `request.json()` is awaited inside the same `try` as the business logic, with no dedicated catch, so a syntactically invalid body surfaces as a 500 through the mapper. This deviates from the 4-step route convention in [AGENTS.md](../../../AGENTS.md); the hand-written `if` guards below produce the only 400s.
- **Middleware gating.** `/api/credit-control/**` is not in the public-route allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before any handler runs ([`middleware.ts:89-93`](../../../src/middleware.ts)). A restricted user (non-null `allowedPages` not containing `/credit-control`) gets a middleware-level **403** `{"error":"Forbidden"}`, because `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:36-67,96-100`](../../../src/middleware.ts)). The in-handler `auth()` call is the API-level backstop.
- **One cache tag.** The payload builder is a `"use cache"` function tagged `credit-control` with `cacheLife({ stale: 60, revalidate: 60, expire: 300 })` ([`service.ts:27-33`](../../../src/lib/credit-control/service.ts), tag constant at [`config.ts:11`](../../../src/lib/credit-control/config.ts)). Every mutating handler on this page invalidates it with `revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 })` — the action/inactive routes do it inside the `src/lib/credit-control/actions.ts` helpers ([`actions.ts:79,93,116,132,137,142`](../../../src/lib/credit-control/actions.ts)), `admin-ownership` does it in the handler itself ([`admin-ownership/route.ts:27`](../../../src/app/api/credit-control/admin-ownership/route.ts)), and a successful sync does it at the end of `runCreditControlSync` ([`sync.ts:752`](../../../src/lib/credit-control/sync.ts)).
- **No route tests.** `src/app/api/credit-control/` contains seven `route.ts` files and nothing else — no `__tests__/` directory. Coverage for this surface is indirect, through the `src/lib/credit-control/` suites and the cron-route test at [`src/app/api/internal/sync-credit-control/__tests__/route.test.ts`](../../../src/app/api/internal/sync-credit-control/__tests__/route.test.ts).
- **`studentKey` is the address.** Every mutating endpoint is keyed by `studentKey`, the durable per-student key that survives snapshot rotation; the four sidecar tables written here (`credit_control_follow_up_state`, `credit_control_follow_up_log`, `credit_control_inactive_students`, `credit_control_admin_ownership`) are all keyed by it and carry no `snapshot_id` ([`schema.ts:1283-1342`](../../../src/lib/db/schema.ts)).

---

## Reading the dashboard

### `GET /api/credit-control`

Returns the entire dashboard payload in one object. Handler: [`route.ts:5-13`](../../../src/app/api/credit-control/route.ts) — four lines of body: `requireCreditControlSession()`, `getCreditControlPayload()`, `NextResponse.json(payload)`.

**Auth:** session (via `requireCreditControlSession`, [`route.ts:7`](../../../src/app/api/credit-control/route.ts)).

**Request:** no query parameters and no body. The "today" key and the recovered-action-clearing option are function arguments with defaults ([`service.ts:27-30`](../../../src/lib/credit-control/service.ts)); the route passes neither, so both take their defaults (today = Asia/Bangkok today, `clearRecoveredActionStates` on).

**Response 200** — the bare `DashboardPayload` object, no envelope ([`types/credit-control.ts:224-240`](../../../src/types/credit-control.ts)):

| Key | Type | Meaning |
|-----|------|---------|
| `adminViews` | `AdminViewOption[]` | Filter options: `all`, the six named admins from `ADMIN_OWNER_REGISTRY`, then `unassigned` ([`config.ts:28-35,110-116`](../../../src/lib/credit-control/config.ts)). |
| `lastUpdatedAt` | string | Formatted generation time of the active snapshot ([`analytics.ts:58`](../../../src/lib/credit-control/analytics.ts)). |
| `previousUpdatedAt` | string \| null | Prior snapshot's `generatedAt`; null here, because the route passes no snapshot history ([`analytics.ts:59`](../../../src/lib/credit-control/analytics.ts), [`service.ts:90`](../../../src/lib/credit-control/service.ts)). |
| `summary` | `SummaryPayload` | Student/package status counts, a `portfolio` block (`exhaustedNow`, `risk7/14/30`, `noSchedule`, pending-deduction backlog, `lowBalanceNoSchedule`, `multiRiskStudents`), `queue` counts, and `deltas` ([`types/credit-control.ts:183-213`](../../../src/types/credit-control.ts)). |
| `studentQueue` | `StudentQueueRow[]` | The at-risk worklist (rows passing `includeInQueue`). |
| `studentQueueAll` | `StudentQueueRow[]` | Every active student as a queue row; the client switches to this list when a search term is active ([`types/credit-control.ts:230-235`](../../../src/types/credit-control.ts)). |
| `calendar` | `CalendarPayload` | `{ availableStart, availableEnd, days }` ([`types/credit-control.ts:177-181`](../../../src/types/credit-control.ts)). |
| `students` | `StudentRecord[]` | Full per-student records with `packages`, `dataQualityFlags`, ownership fields and `actionState` ([`types/credit-control.ts:93-103`](../../../src/types/credit-control.ts)). |
| `inactiveStudents` | `InactiveStudentSummary[]` | Students hidden from the worklist: `{ studentKey, student, parent, source, markedAt, removedAtRemaining }` ([`service.ts:97-104`](../../../src/lib/credit-control/service.ts), [`types/credit-control.ts:215-222`](../../../src/types/credit-control.ts)). |

A `StudentQueueRow` carries 32 fields, including `worstStatus`, `totalCurrentRemaining` / `totalAdjustedRemaining` / `totalPendingDeduction`, `nextSessionDate`, `nextAlertDate` / `nextExhaustDate`, `daysUntilAlert` / `daysUntilExhaust`, `noFutureSchedule`, `pinned`, `includeInQueue`, `priorityScore`, `recommendedAction`, `whyNow` and `searchText` ([`types/credit-control.ts:112-143`](../../../src/types/credit-control.ts)). What those values *mean* is the feature doc's job.

**Side effects — a GET that writes.** Two of them, both inside `getCreditControlPayload`:

1. **Auto-clear of recovered follow-ups.** Any student holding an `actionState` whose packages no longer include a `notify` or `watch` package has their `credit_control_follow_up_state` row deleted and an `auto-clear` row appended to `credit_control_follow_up_log`, attributed to the synthetic actor `system@begifted.local` / `System` ([`service.ts:79-81,109-136`](../../../src/lib/credit-control/service.ts)).
2. **Ownership and inactive joins.** Ownership is read per student key and stamped onto each record with `adminOwnershipSource: "postgres-sidecar"` ([`service.ts:70-76`](../../../src/lib/credit-control/service.ts)); students listed in `credit_control_inactive_students` are filtered out of the worklist and re-exposed only under `inactiveStudents` ([`service.ts:83-86,97-104`](../../../src/lib/credit-control/service.ts)).

Because the function is cached for up to 300s, a given request may serve a cached payload and perform neither write.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Payload returned. |
| 401 | No session, or a session missing email/name. |
| 403 | Middleware — restricted user without `/credit-control` in `allowedPages`. |
| 500 | Any other thrown error; body `{ error: <message> }`, fallback `"Credit control load failed"` ([`route.ts:11`](../../../src/app/api/credit-control/route.ts)). |

---

## Follow-up actions

Three endpoints share the same state model: a single current status per student in `credit_control_follow_up_state`, plus an append-only `credit_control_follow_up_log`. Valid statuses are exactly `contacted`, `pending-callback`, `resolved` ([`action-helpers.ts:17`](../../../src/lib/credit-control/action-helpers.ts)); anything else normalizes to `null`, which means *clear*.

### `POST /api/credit-control/actions`

Sets or clears one student's follow-up status. Handler: [`actions/route.ts:7-55`](../../../src/app/api/credit-control/actions/route.ts).

**Auth:** session ([`actions/route.ts:9`](../../../src/app/api/credit-control/actions/route.ts)).

**Body:** `{ studentKey?: string; status?: string | null }` ([`actions/route.ts:10`](../../../src/app/api/credit-control/actions/route.ts)).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | `String(...).trim()`; empty → 400 `{"error":"studentKey is required"}` ([`actions/route.ts:11-15`](../../../src/app/api/credit-control/actions/route.ts)). Must match a student in the current payload, else 404. |
| `status` | string \| null | no | Passed through `normalizeStudentActionStatus`. A recognized value **sets**; `null`, `""`, a missing field, or **any unrecognized string** all **clear** — this endpoint never rejects a bad status ([`actions/route.ts:23`](../../../src/app/api/credit-control/actions/route.ts)). |

**Behavior.** The handler loads the full payload and looks the student up by key ([`actions/route.ts:17-21`](../../../src/app/api/credit-control/actions/route.ts)) — so it resolves the student's display name and parent name for the log rows, and so a key that is absent (including a student already hidden as inactive, who is filtered out of the payload) yields **404** `{"error":"Student not found"}`.

**Side effects:**

- Set: `upsertCreditFollowUpState` (upsert on `studentKey`) + `appendCreditFollowUpLog` with `actionType: "set"` ([`actions.ts:61-80`](../../../src/lib/credit-control/actions.ts)).
- Clear: `deleteCreditFollowUpState` + a log row with `actionType: "clear"` and `status: null` ([`actions.ts:82-94`](../../../src/lib/credit-control/actions.ts)).
- Either way, `revalidateTag("credit-control", { expire: 0 })`.

**Response 200:**

```json
{ "ok": true, "studentKey": "…", "actionState": { "status": "contacted", "updatedAt": "…ISO…", "updatedByName": "…", "isToday": true } }
```

`actionState` is `null` on a clear; on a set it is built in the handler from `new Date().toISOString()` and the session name, with `isToday` hard-coded `true` ([`actions/route.ts:24-31,52`](../../../src/app/api/credit-control/actions/route.ts)). The client applies it as the authoritative replacement for its optimistic patch ([`dashboard-shell.tsx:419-425`](../../../src/components/credit-control/dashboard-shell.tsx)).

**Status codes:** 200 · 400 (blank `studentKey`) · 401 · 403 (middleware) · 404 (unknown student) · 500 (fallback `"Action request failed"`, [`actions/route.ts:54`](../../../src/app/api/credit-control/actions/route.ts)).

### `POST /api/credit-control/actions/bulk`

Same operation over many students. Handler: [`bulk/route.ts:7-69`](../../../src/app/api/credit-control/actions/bulk/route.ts).

**Auth:** session ([`bulk/route.ts:9`](../../../src/app/api/credit-control/actions/bulk/route.ts)).

**Body:** `{ studentKeys?: string[]; status?: string | null }` ([`bulk/route.ts:10`](../../../src/app/api/credit-control/actions/bulk/route.ts)).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKeys` | string[] | yes | Trimmed, blanks dropped, de-duplicated through a `Set` ([`bulk/route.ts:11-13`](../../../src/app/api/credit-control/actions/bulk/route.ts)). Empty after that → 400 `{"error":"studentKeys is required"}`. |
| `status` | string \| null | yes-ish | **Stricter than the single endpoint.** Only an explicit `null` or `""` means clear; any other value must normalize to a valid status or the request is rejected with 400 `{"error":"valid status is required"}` ([`bulk/route.ts:19-23`](../../../src/app/api/credit-control/actions/bulk/route.ts)). A missing `status` field therefore 400s here while it clears on `/actions`. |

**Behavior.** Keys are resolved against the current payload and **silently dropped** when not found ([`bulk/route.ts:26-33`](../../../src/app/api/credit-control/actions/bulk/route.ts)) — there is no 404 on this endpoint. If nothing resolves, it returns **200 `{"updated":[]}`** without writing ([`bulk/route.ts:35-37`](../../../src/app/api/credit-control/actions/bulk/route.ts)).

**Side effects.** `bulkSetAction` / `bulkClearAction` fan out with `Promise.all`, writing one state upsert (or delete) and one log row per student, with `actionType: "bulk-set"` or `"bulk-clear"`, then a single `revalidateTag` at the end ([`actions.ts:96-133`](../../../src/lib/credit-control/actions.ts)). The writes are **not transactional** — a partial failure can leave some students updated.

**Response 200:**

```json
{ "updated": [ { "studentKey": "…", "actionState": { "status": "resolved", "updatedAt": "…ISO…", "updatedByName": "…", "isToday": true } } ] }
```

One entry per *resolved* key (so the array can be shorter than `studentKeys`); `actionState` is `null` for a clear. All entries share one `updatedAt` computed after the writes ([`bulk/route.ts:53-66`](../../../src/app/api/credit-control/actions/bulk/route.ts)).

**Status codes:** 200 · 400 (empty `studentKeys`; invalid/missing `status`) · 401 · 403 (middleware) · 500 (fallback `"Bulk action request failed"`, [`bulk/route.ts:68`](../../../src/app/api/credit-control/actions/bulk/route.ts)).

### `GET /api/credit-control/actions/history`

Reads one student's recent follow-up log. Handler: [`history/route.ts:5-26`](../../../src/app/api/credit-control/actions/history/route.ts).

**Auth:** session ([`history/route.ts:7`](../../../src/app/api/credit-control/actions/history/route.ts)).

**Query parameters:**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | `searchParams.get("studentKey")`, trimmed; blank or absent → 400 `{"error":"studentKey is required"}` ([`history/route.ts:9-13`](../../../src/app/api/credit-control/actions/history/route.ts)). No existence check — an unknown key returns an empty list, not 404. |

The window is **fixed at 7 days** — the route hard-codes the second argument to `readCreditActionHistory(studentKey, 7)` ([`history/route.ts:15`](../../../src/app/api/credit-control/actions/history/route.ts)), overriding that function's own 7-day default; there is no way to widen it over HTTP. Rows come back newest-first, filtered on `created_at >= now - 7d` ([`db.ts:237-252`](../../../src/lib/credit-control/db.ts)).

**Response 200:** `{ "history": [ { "status", "updatedAt", "updatedByName", "actionType" } ] }` — a projection of the log row: `status` (nullable), `updatedAt` = `createdAt.toISOString()`, `updatedByName` = the row's `actorName`, and `actionType` ([`history/route.ts:16-23`](../../../src/app/api/credit-control/actions/history/route.ts)). `actionType` is a free-text column ([`schema.ts:1300`](../../../src/lib/db/schema.ts)); values written in this codebase are `set`, `clear`, `bulk-set`, `bulk-clear` ([`actions.ts:74,89,110,127`](../../../src/lib/credit-control/actions.ts)) and the system-written `auto-clear` ([`service.ts:129`](../../../src/lib/credit-control/service.ts)) — note the `ActionLogRow` type only enumerates the first four ([`types/credit-control.ts:258-262`](../../../src/types/credit-control.ts)). Read-only: no writes, no cache invalidation.

**Status codes:** 200 · 400 (blank `studentKey`) · 401 · 403 (middleware) · 500 (fallback `"Failed to load history"`, [`history/route.ts:25`](../../../src/app/api/credit-control/actions/history/route.ts)).

---

## Ownership

### `POST /api/credit-control/admin-ownership`

Assigns a student to a named admin owner. Handler: [`admin-ownership/route.ts:7-36`](../../../src/app/api/credit-control/admin-ownership/route.ts).

**Auth:** session ([`admin-ownership/route.ts:9`](../../../src/app/api/credit-control/admin-ownership/route.ts)).

**Body:** `{ studentKey?: string; adminKey?: string }` ([`admin-ownership/route.ts:10`](../../../src/app/api/credit-control/admin-ownership/route.ts)).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | string | yes | Trimmed; blank (or blank `adminKey`) → 400 `{"error":"studentKey and adminKey are required"}` ([`admin-ownership/route.ts:14-16`](../../../src/app/api/credit-control/admin-ownership/route.ts)). **Not** checked against the payload — any non-empty key is accepted and stored. |
| `adminKey` | string | yes | Must be one of the keys returned by `getAdminViewOptions()`: `all`, `palm`, `kem`, `care`, `aya`, `petchy`, `muk`, `unassigned` ([`config.ts:28-35,110-116`](../../../src/lib/credit-control/config.ts)). Anything else → 400 `{"error":"Unknown adminKey"}` ([`admin-ownership/route.ts:18-20`](../../../src/app/api/credit-control/admin-ownership/route.ts)). Note the validator is the *view* list, so the filter pseudo-key `all` passes validation and can be persisted as an owner. |

**Side effects.** `upsertCreditAdminOwnership` inserts into `credit_control_admin_ownership` with `onConflictDoUpdate` on the `studentKey` primary key, refreshing `adminKey`, `assignedByEmail` (the session email) and `updatedAt` ([`db.ts:312-324`](../../../src/lib/credit-control/db.ts), [`schema.ts:1334-1342`](../../../src/lib/db/schema.ts)). Then `revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 })` in the handler ([`admin-ownership/route.ts:27`](../../../src/app/api/credit-control/admin-ownership/route.ts)) — the one endpoint here that invalidates directly rather than through `actions.ts`. On the next payload build the stored key resolves to a display label, with `adminOwnershipSource: "postgres-sidecar"` ([`db.ts:290-310`](../../../src/lib/credit-control/db.ts), [`service.ts:70-76`](../../../src/lib/credit-control/service.ts)).

**Response 200:** `{ "ok": true, "studentKey": "…", "adminKey": "…" }` ([`admin-ownership/route.ts:29`](../../../src/app/api/credit-control/admin-ownership/route.ts)).

**Status codes:** 200 · 400 (missing field; unknown `adminKey`) · 401 · 403 (middleware) · 500 (fallback `"Admin ownership update failed"`, [`admin-ownership/route.ts:31-35`](../../../src/app/api/credit-control/admin-ownership/route.ts)).

---

## Hiding and restoring students

Both handlers live in [`inactive/route.ts`](../../../src/app/api/credit-control/inactive/route.ts) and both take a JSON body — including the `DELETE`.

### `POST /api/credit-control/inactive`

Marks a student "No Longer Active" so the worklist stops surfacing them. Handler: [`inactive/route.ts:6-38`](../../../src/app/api/credit-control/inactive/route.ts).

**Auth:** session ([`inactive/route.ts:8`](../../../src/app/api/credit-control/inactive/route.ts)).

**Body:** `{ studentKey?: string }` — trimmed; blank → 400 `{"error":"studentKey is required"}` ([`inactive/route.ts:9-14`](../../../src/app/api/credit-control/inactive/route.ts)). The key is resolved against the current payload; no match → 404 `{"error":"Student not found"}` ([`inactive/route.ts:16-20`](../../../src/app/api/credit-control/inactive/route.ts)). Since already-hidden students are filtered out of the payload, re-posting for one returns 404 rather than a no-op.

**Side effects.** The handler first computes `removedAtRemaining` as the sum of `currentRemaining` across the student's packages ([`inactive/route.ts:24`](../../../src/app/api/credit-control/inactive/route.ts), field at [`types/credit-control.ts:58`](../../../src/types/credit-control.ts)) — recorded so that reactivation requires a genuine top-up above that level, matching the auto-churn rule (comment at [`inactive/route.ts:22-23`](../../../src/app/api/credit-control/inactive/route.ts)). It then calls `markInactiveStudent` with `source: "manual"` ([`inactive/route.ts:25-32`](../../../src/app/api/credit-control/inactive/route.ts)), which upserts `credit_control_inactive_students` on the `studentKey` primary key — refreshing names, `markedAt`, `markedByEmail`, `source` and `removedAtRemaining` ([`db.ts:258-282`](../../../src/lib/credit-control/db.ts)) — and invalidates the cache tag ([`actions.ts:135-138`](../../../src/lib/credit-control/actions.ts)). `source` distinguishes this manual path from the `auto-churn` rows written by the sync's churn maintenance ([`schema.ts:1310-1320`](../../../src/lib/db/schema.ts)). Follow-up state is **not** touched.

**Response 200:** `{ "ok": true }` ([`inactive/route.ts:34`](../../../src/app/api/credit-control/inactive/route.ts)).

**Status codes:** 200 · 400 · 401 · 403 (middleware) · 404 · 500 (fallback `"Inactive request failed"`, [`inactive/route.ts:36`](../../../src/app/api/credit-control/inactive/route.ts)).

### `DELETE /api/credit-control/inactive`

Restores a hidden student to the worklist. Handler: [`inactive/route.ts:40-54`](../../../src/app/api/credit-control/inactive/route.ts).

**Auth:** session ([`inactive/route.ts:42`](../../../src/app/api/credit-control/inactive/route.ts)). Note this handler does not bind the session user to anything — the restore is not attributed in any table.

**Body:** `{ studentKey?: string }` — same trim-and-require guard, blank → 400 ([`inactive/route.ts:43-48`](../../../src/app/api/credit-control/inactive/route.ts)). Unlike the `POST`, it does **not** load the payload and does **not** 404: `clearCreditInactive` issues a `DELETE … WHERE student_key = $1` that matches zero rows harmlessly ([`db.ts:284-288`](../../../src/lib/credit-control/db.ts)), so the call is idempotent.

**Side effects:** the `credit_control_inactive_students` row is deleted and the cache tag invalidated ([`actions.ts:140-143`](../../../src/lib/credit-control/actions.ts)). Whether the student reappears in `studentQueue` afterwards is up to the ranking rules, not this endpoint — it only lifts the hide.

**Response 200:** `{ "ok": true }` ([`inactive/route.ts:51`](../../../src/app/api/credit-control/inactive/route.ts)).

**Status codes:** 200 · 400 · 401 · 403 (middleware) · 500 (same fallback `"Inactive request failed"`, [`inactive/route.ts:53`](../../../src/app/api/credit-control/inactive/route.ts)).

---

## Sync

### `POST /api/credit-control/sync`

Runs a manual Wise credit-control sync under the same single-flight guard the cron uses. Handler: [`sync/route.ts:6-13`](../../../src/app/api/credit-control/sync/route.ts) — it authenticates, then delegates the entire response to `runCreditControlSyncRequest()` ([`run-sync-request.ts:138-160`](../../../src/lib/credit-control/run-sync-request.ts)).

**Auth:** session ([`sync/route.ts:8`](../../../src/app/api/credit-control/sync/route.ts)) — no cron secret is accepted here; that is the internal route's job.

**Request:** no body, no query parameters. The Wise institute is `process.env.WISE_INSTITUTE_ID`, falling back to the literal `696e1f4d90102225641cc413` ([`run-sync-request.ts:141`](../../../src/lib/credit-control/run-sync-request.ts)).

**`export const maxDuration = 300`** ([`sync/route.ts:4`](../../../src/app/api/credit-control/sync/route.ts)). The cron twin `/api/internal/sync-credit-control` carries `maxDuration = 800`, raised because successful runs were measured at 372–390s ([`internal/sync-credit-control/route.ts:7-14`](../../../src/app/api/internal/sync-credit-control/route.ts)). This manual route was not raised with it, so a full manual sync can be killed by the platform mid-run — see [Open questions](#open-questions).

**Single-flight guard**, in `acquireSyncRun` ([`run-sync-request.ts:106-136`](../../../src/lib/credit-control/run-sync-request.ts)):

1. Any `credit_control_sync_runs` row still `running` after **20 minutes** (`STALE_RUNNING_CREDIT_CONTROL_SYNC_MS`, [`run-sync-request.ts:9`](../../../src/lib/credit-control/run-sync-request.ts)) is flipped to `failed` with an explanatory `errorSummary`; the count is returned as `staleRunningSyncsFailed` ([`run-sync-request.ts:50-68`](../../../src/lib/credit-control/run-sync-request.ts)).
2. If a `running` row still exists, the request **does not start a sync** and returns **202** with the skip payload.
3. Otherwise a `running` row is inserted. A `23505` unique violation on that insert (the partial unique index in Postgres) is caught and converted into the same 202 skip payload ([`run-sync-request.ts:41-48,124-135`](../../../src/lib/credit-control/run-sync-request.ts)).

**Response 202 — already running** ([`run-sync-request.ts:84-104,145-147`](../../../src/lib/credit-control/run-sync-request.ts)): `{ success: true, skipped: true, alreadyRunning: true, syncRunId, snapshotId: null, promotedSnapshotId: null, studentCount: 0, packageCount: 0, sessionCount: 0, failedCreditPairs: 0, errorSummary: null, message: "Credit control sync is already running. Data will refresh when that run finishes.", runningStartedAt, staleRunningSyncsFailed }`.

**Response 200 — sync ran and succeeded**: the `CreditControlSyncResult` ([`sync.ts:49-58`](../../../src/lib/credit-control/sync.ts)) spread with `syncRunId` and `staleRunningSyncsFailed` ([`run-sync-request.ts:153-159`](../../../src/lib/credit-control/run-sync-request.ts)):

| Key | Type | Meaning |
|-----|------|---------|
| `success` | boolean | `true` on this path. |
| `snapshotId` / `promotedSnapshotId` | string | The candidate snapshot, and the same id once promoted. |
| `studentCount`, `packageCount`, `sessionCount` | number | Rows written to `credit_control_students` / `_packages` / `_sessions`. |
| `failedCreditPairs` | number | Student/package pairs whose Wise credit fetch failed; the run still succeeds. |
| `syncRunId`, `staleRunningSyncsFailed` | string, number | Added by the guard wrapper. |

**Response 500 — sync ran and failed**: the same object with `success: false`, zeroed counts, no `promotedSnapshotId`, and a truncated `errorSummary`; the status comes from `result.success ? 200 : 500` ([`run-sync-request.ts:158`](../../../src/lib/credit-control/run-sync-request.ts), failure branch at [`sync.ts:762-782`](../../../src/lib/credit-control/sync.ts)). Note this is a **200-shaped body returned with 500**, not the `{ error }` envelope the other seven endpoints use.

**Side effects of a successful run** ([`sync.ts:641-760`](../../../src/lib/credit-control/sync.ts)): fetches students plus PAST/FUTURE sessions over a 120-day / 180-day window; inserts an inactive candidate snapshot; bulk-inserts students, packages, sessions and credit history in chunks of 500; **atomically promotes** the candidate with a single bounded `UPDATE … SET active = (id = $candidate)` (REL-01, [`sync.ts:713-723`](../../../src/lib/credit-control/sync.ts)); runs best-effort churn maintenance whose failure is logged but never rolls back the promotion ([`sync.ts:724-729`](../../../src/lib/credit-control/sync.ts)); marks the run `success` with Wise call stats; and finally `revalidateTag("credit-control", { expire: 0 })` ([`sync.ts:752`](../../../src/lib/credit-control/sync.ts)). On failure the run row is marked `failed` with the serialized error merged into its `metadata` and no promotion occurs.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Sync ran and returned `success: true`. |
| 202 | Skipped — another run holds the single-flight guard. |
| 401 | No session, or a session missing email/name. |
| 403 | Middleware — restricted user. |
| 500 | Sync ran and returned `success: false`; or any throw before/around it, mapped to `{ error }` with fallback `"Credit control sync failed"` ([`sync/route.ts:11`](../../../src/app/api/credit-control/sync/route.ts)). |

---

## Open questions

- **`maxDuration` split between the two sync entry points.** The manual route is 300s ([`sync/route.ts:4`](../../../src/app/api/credit-control/sync/route.ts)) while the cron route is 800s and its comment records real runs at 372–390s ([`internal/sync-credit-control/route.ts:7-14`](../../../src/app/api/internal/sync-credit-control/route.ts)). A manual sync is therefore expected to exceed its own limit; whether that is deliberate (manual runs are meant to be short) or leftover drift is not recorded in code.
- **`adminKey: "all"` is accepted as an owner.** The validator reuses `getAdminViewOptions()`, whose first entry is the `all` filter pseudo-key ([`config.ts:110-116`](../../../src/lib/credit-control/config.ts)), so `all` can be persisted into `credit_control_admin_ownership`. Whether the UI would ever send it is moot — the endpoint has no in-repo caller.
- **Two endpoints with no caller.** `POST /api/credit-control/admin-ownership` and `POST /api/credit-control/sync` are reachable and tested-by-nothing; ownership is seeded by an offline script and sync by the cron. Whether they exist for operator use or are vestigial is not stated anywhere in the repo.
- **`status` semantics differ between `/actions` and `/actions/bulk`.** An unrecognized status silently clears on the single endpoint and 400s on the bulk one. No comment marks this as intentional.

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
