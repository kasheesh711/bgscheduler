# Leave Requests API

**Status: stable** (handbook maturity map; no `@deprecated` or status marker exists in code). Feature meaning — why the sheet is the source, what the workflow statuses mean, why Wise cancellation stays manual — lives in [docs/features/leave-requests.md](../../features/leave-requests.md). Column-level detail for the five `leave_request*` tables lives in [docs/reference/database/erd-leave-requests.md](../database/erd-leave-requests.md), and the two owned enums are listed in [enums.md](../database/enums.md). **This page owns the mechanics**: method, path, auth, request shape, response shape, side effects, and status codes.

**Scope: 7 method+path endpoints** — the 5 in-app handlers under [`src/app/api/leave-requests/`](../../../src/app/api/leave-requests/) (4 route files, one of which exports both `GET` and `PATCH`), plus the 2 verbs of the cron route [`src/app/api/internal/sync-leave-requests/route.ts`](../../../src/app/api/internal/sync-leave-requests/route.ts). Nothing else in the repo serves a `/api/leave-requests` path. In the master index the first five count toward the `leave-requests` group and the last two toward `internal` — see [index.md](./index.md).

All five in-app handlers delegate to two libs: [`src/lib/leave-requests/data.ts`](../../../src/lib/leave-requests/data.ts) (queries + the two write paths) and [`src/lib/leave-requests/sync.ts`](../../../src/lib/leave-requests/sync.ts) (the sheet sync).

## Endpoint index (7)

| Method | Path | Auth | Writes | Handler |
|--------|------|------|--------|---------|
| GET | `/api/leave-requests` | session **with `user.email`** | none | [`route.ts:7-28`](../../../src/app/api/leave-requests/route.ts) |
| POST | `/api/leave-requests/sync` | session **with `user.email`** | full sheet sync — 5 tables + admin email | [`sync/route.ts:8-36`](../../../src/app/api/leave-requests/sync/route.ts) |
| GET | `/api/leave-requests/[requestId]` | session **with `user.email`** | none | [`[requestId]/route.ts:14-24`](../../../src/app/api/leave-requests/[requestId]/route.ts) |
| PATCH | `/api/leave-requests/[requestId]` | session **with `user.email`** | `leave_requests` update + activity log + **one Google Sheets cell** | [`[requestId]/route.ts:26-71`](../../../src/app/api/leave-requests/[requestId]/route.ts) |
| POST | `/api/leave-requests/[requestId]/wise-cancel-preview` | session **with `user.email`** | selection flags + counter + activity log (**no Wise call**) | [`wise-cancel-preview/route.ts:8-36`](../../../src/app/api/leave-requests/[requestId]/wise-cancel-preview/route.ts) |
| GET | `/api/internal/sync-leave-requests` | `CRON_SECRET` | same sync as `POST /api/leave-requests/sync` | [`internal/sync-leave-requests/route.ts:30-32`](../../../src/app/api/internal/sync-leave-requests/route.ts) |
| POST | `/api/internal/sync-leave-requests` | `CRON_SECRET` | identical — both verbs share one `handle()` | [`internal/sync-leave-requests/route.ts:34-36`](../../../src/app/api/internal/sync-leave-requests/route.ts) |

The only in-repo caller of the five in-app endpoints is the client workspace, which calls all five ([`leave-requests-workspace.tsx:95,136,168,184,212`](../../../src/components/leave-requests/leave-requests-workspace.tsx)); the page itself renders no payload server-side — it awaits `auth()`, redirects to `/login` without a session email, and mounts the client component ([`(app)/leave-requests/page.tsx:6-10`](../../../src/app/%28app%29/leave-requests/page.tsx)).

**A third sync trigger exists outside this page's scope.** Data Health's manual-run handler calls `syncLeaveRequests` directly for job key `leave_requests` with `triggerType: "manual"` and the acting admin's email ([`run-job.ts:152-162`](../../../src/lib/data-health/run-job.ts)) — and it maps *every* thrown error, including the already-running case, to 500 rather than 409.

---

## Conventions shared by these endpoints

**No Zod.** None of the five in-app handlers uses a schema. Each reads `request.json()` inside a `try/catch` that falls back to `{}` ([`sync/route.ts:14-19`](../../../src/app/api/leave-requests/sync/route.ts), [`[requestId]/route.ts:33-38`](../../../src/app/api/leave-requests/[requestId]/route.ts), [`wise-cancel-preview/route.ts:14-20`](../../../src/app/api/leave-requests/[requestId]/wise-cancel-preview/route.ts)), then narrows fields with hand-written `typeof` checks. A malformed JSON body therefore never returns 400 for parse reasons — it degrades to an empty object, and unknown fields are dropped. Query parameters on the list endpoint are read straight off `request.nextUrl.searchParams` with no validation at all ([`route.ts:13-21`](../../../src/app/api/leave-requests/route.ts)).

**Auth is session-plus-email.** All five in-app handlers guard on `!session?.user?.email`, not merely `!session`, and return `401 {"error":"Unauthorized"}` — a session without an email is rejected everywhere, because every write stamps the actor onto a row or an activity log. There is no role model and no leave-request-specific capability: any signed-in admin who reaches these paths can sync, re-status, write to the source sheet, and log a cancellation preview.

**Middleware.** `/api/leave-requests/**` is not in the public allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:89-93`](../../../src/middleware.ts)). A restricted user whose `allowedPages` does not prefix-match `/leave-requests` gets a middleware-level `403 {"error":"Forbidden"}`, since `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:36-67`](../../../src/middleware.ts), [`:97-100`](../../../src/middleware.ts)). The cron route is the opposite case: `/api/internal/` is entirely public at the middleware layer ([`middleware.ts:24`](../../../src/middleware.ts)) and is protected only by the in-handler secret check.

**Detail echo.** Both mutating request-scoped endpoints re-read and return the full detail payload after writing, so the client never needs a follow-up `GET` — `PATCH` returns it under `detail`, the cancel-preview under `detail` as well. The list is *not* echoed; the workspace bumps a reload token to re-`GET` it ([`leave-requests-workspace.tsx:197,220`](../../../src/components/leave-requests/leave-requests-workspace.tsx)).

**No caching.** No handler declares `"use cache"`, `revalidate`, or `dynamic`; every request reads Postgres directly. Neither sync path calls `revalidateTag`.

**Affected sessions are only recomputed by a sync.** `recomputeAffectedSessionsForRequest` ([`data.ts:394-495`](../../../src/lib/leave-requests/data.ts)) is called from exactly one place — the sync loop ([`sync.ts:402`](../../../src/lib/leave-requests/sync.ts)). Neither `PATCH` nor the cancel-preview re-derives which Wise sessions a leave hits, so a detail payload always reflects the active snapshot **as of the last sync**, never as of the request.

**Tests.** One route test exists for this whole surface: [`wise-cancel-preview/__tests__/route.test.ts`](../../../src/app/api/leave-requests/[requestId]/wise-cancel-preview/__tests__/route.test.ts) — 2 cases (401 without a session; non-string ids filtered out of `affectedSessionIds` before delegation). The list, detail, `PATCH`, in-app sync, and cron routes have **no route tests**; the libs behind them are covered by the four suites under [`src/lib/leave-requests/__tests__/`](../../../src/lib/leave-requests/__tests__/).

### The detail payload

`GET /api/leave-requests/[requestId]`, `PATCH /api/leave-requests/[requestId]`, and `POST …/wise-cancel-preview` all return the same object, built by `getLeaveRequestDetail` ([`data.ts:282-330`](../../../src/lib/leave-requests/data.ts)); the client-side mirror of the type is [`components/leave-requests/types.ts:117-136`](../../../src/components/leave-requests/types.ts).

| Key | Type | Notes |
|-----|------|-------|
| `request` | object | The whole `leave_requests` row spread verbatim — including the untouched `rawValues` JSONB of the source sheet row — with nine timestamp fields re-serialised as ISO strings ([`data.ts:305-317`](../../../src/lib/leave-requests/data.ts)). Column meanings: [erd-leave-requests.md](../database/erd-leave-requests.md). |
| `affectedSessions` | array | Rows of `leave_request_affected_sessions` for this request, ordered by `startTime`, each with `startTime`/`endTime`/`createdAt` as ISO strings, its `overlapMinutes`, its `cancelPreviewSelected` flag, and an added `students` roster ([`data.ts:318-324`](../../../src/lib/leave-requests/data.ts)). |
| `activityLog` | array | Rows of `leave_request_activity_logs`, newest first ([`data.ts:296-300,325-328`](../../../src/lib/leave-requests/data.ts)). Emitted `actionType` values across this API: `status_update`, `sheet_status_write`, `wise_cancel_preview` (plus `source_inserted` / `source_updated` / `source_refreshed` from the sync). |

`students` is joined in by `loadAffectedSessionStudentRosters` ([`data.ts:332-381`](../../../src/lib/leave-requests/data.ts)) from the active credit-control snapshot and the LINE link tables — one entry per student on the class, each carrying `lineContacts` for **verified** links only. A contact's `lineChatUrl` is not taken from the stored evidence as-is: `trustedLineChatUrlFromEvidence` re-parses it and returns `null` unless it is `https://chat.line.biz/{oaId}/chat/{userId}` with both ids matching `/^U[a-fA-F0-9]{32}$/` and the user id equal to the link's own ([`data.ts:85-107`](../../../src/lib/leave-requests/data.ts)).

---

## Reading the queue

### `GET /api/leave-requests`

Returns the whole triage payload for the dashboard — KPI cards, a per-start-date timeline, the request rows, and the signed-in admin's Google Sheets token status. Read-only. Handler [`route.ts:7-28`](../../../src/app/api/leave-requests/route.ts).

**Auth:** session with `user.email` → otherwise `401` ([`route.ts:8-11`](../../../src/app/api/leave-requests/route.ts)).

**Query** (all optional, all unvalidated; passed to `listLeaveRequests` at [`data.ts:223`](../../../src/lib/leave-requests/data.ts)):

| Param | Type | Effect |
|-------|------|--------|
| `status` | workflow status | `eq(workflow_status, …)`. The literal `all` is treated as "no filter" ([`data.ts:188-190`](../../../src/lib/leave-requests/data.ts)). The value is **not** checked against `LEAVE_WORKFLOW_STATUSES` ([`data.ts:9-16`](../../../src/lib/leave-requests/data.ts)) — the `as LeaveWorkflowStatus` cast is a compile-time assertion only, so anything outside the six reaches Postgres as an invalid `leave_request_workflow_status` literal and the handler's catch turns the driver error into **500**, not 400. |
| `q` | string | Trimmed, wrapped in `%…%`, and `ILIKE`-matched across `tutor_name`, `tutor_email`, `tutor_display_name`, `reason`, `source_sheet_status` ([`data.ts:197-206`](../../../src/lib/leave-requests/data.ts)). |
| `startDate` | `YYYY-MM-DD` | `start_date >= startDate` ([`data.ts:191-193`](../../../src/lib/leave-requests/data.ts)). |
| `endDate` | `YYYY-MM-DD` | `start_date <= endDate` — note it bounds the **start** column, not `end_date` ([`data.ts:194-196`](../../../src/lib/leave-requests/data.ts)), so a multi-day leave that begins before the window but runs into it is excluded. |
| `summaryOnly` | `"true"` | Exactly the string `true` ([`route.ts:20`](../../../src/app/api/leave-requests/route.ts)). Lowers the row cap to 200 and returns `requests: []` while still computing `cards` and `timeline` ([`data.ts:230,250`](../../../src/lib/leave-requests/data.ts)). |

The UI only ever sends `status`, `q`, `startDate`, `endDate` ([`view-model.ts:126-141`](../../../src/components/leave-requests/view-model.ts)); `summaryOnly: true` is used server-side by the home summary to feed the nav badge ([`summary.ts:169-170`](../../../src/lib/home/summary.ts), badge value `unreadActionCount` at [`:193-199`](../../../src/lib/home/summary.ts)).

**Response `200`** — `LeaveListResponse` ([`types.ts:41-58`](../../../src/components/leave-requests/types.ts)), no wrapper key:

| Key | Notes |
|-----|-------|
| `cards` | `total`, `new`, `needsReview`, `sheetWriteFailed`, `affectedClasses` (sum of `affected_class_count`) ([`data.ts:232-238`](../../../src/lib/leave-requests/data.ts)). |
| `unreadActionCount` | Rows that are `new`, `needs_review`, **or** have `sheet_write_status = "failed"` ([`data.ts:240-244`](../../../src/lib/leave-requests/data.ts)). |
| `timeline` | Up to 28 distinct `start_date` buckets, ascending, each `{ date, total, needsAction, affectedClasses }` ([`data.ts:210-221`](../../../src/lib/leave-requests/data.ts)). Past dates are not excluded — the 14-day forward window is a client-side construction. |
| `requests` | Up to 500 rows (200 with `summaryOnly`), ordered `source_submitted_at DESC, created_at DESC`, projected to 25 explicit fields ([`data.ts:225-230,250-278`](../../../src/lib/leave-requests/data.ts)). |
| `googleSheets` | `getGoogleTokenStatus(session.user.email)` — `{ connected, writeConnected, email, expiresAt, lastError }` ([`route.ts:22`](../../../src/app/api/leave-requests/route.ts), [`google-oauth.ts:276-293`](../../../src/lib/sales-dashboard/google-oauth.ts)). This describes **the caller's own** token, not the account that actually performs the sheet write (see `PATCH` below). |

Every roll-up is computed over the filtered, capped row set — `cards` and `timeline` therefore move with the filters and silently under-count past the 500-row cap.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Payload returned; an empty table is still 200 with zeroed cards. |
| 401 | No session, or a session without `user.email`. |
| 500 | Any throw from the query or the token lookup; body `{"error": <message>}`, defaulting to `"Leave request query failed"` ([`route.ts:24-27`](../../../src/app/api/leave-requests/route.ts)). Includes the invalid-`status` case above. |

---

## Reading one request

### `GET /api/leave-requests/[requestId]`

Full detail for one request. Read-only. Handler [`[requestId]/route.ts:14-24`](../../../src/app/api/leave-requests/[requestId]/route.ts).

**Auth:** session with `user.email` ([`:15-18`](../../../src/app/api/leave-requests/[requestId]/route.ts)).

**Path parameter:** `requestId`, awaited from the Next 16 async `params` promise ([`:12,20`](../../../src/app/api/leave-requests/[requestId]/route.ts)). No body, no query.

**Response `200`:** [the detail payload](#the-detail-payload), returned bare ([`:23`](../../../src/app/api/leave-requests/[requestId]/route.ts)).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Request found. |
| 401 | No session, or a session without `user.email`. |
| 404 | `getLeaveRequestDetail` returned `null` — `{"error":"Not found"}` ([`:22`](../../../src/app/api/leave-requests/[requestId]/route.ts)). |
| — | There is **no `try/catch`**: this handler cannot emit the usual `500 {"error": …}` JSON. A driver error — most plausibly a non-UUID `requestId` hitting the `uuid` primary key ([`schema.ts:2116-2117`](../../../src/lib/db/schema.ts)) — escapes to the framework, and the response body is whatever Next produces. Untested; this route has no test. |

---

## Working a request

### `PATCH /api/leave-requests/[requestId]`

Sets workflow status and/or staff note, and attempts the Status-cell writeback to the source Google Sheet. Handler [`[requestId]/route.ts:26-71`](../../../src/app/api/leave-requests/[requestId]/route.ts); logic in `updateLeaveRequestWorkflow` ([`data.ts:497-606`](../../../src/lib/leave-requests/data.ts)).

**Auth:** session with `user.email`; the email and name are stamped on the activity-log rows ([`:27-30,61-62`](../../../src/app/api/leave-requests/[requestId]/route.ts)).

**Body** (a missing or unparseable body degrades to `{}`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `workflowStatus` | one of `new`, `needs_review`, `in_progress`, `done`, `ignored`, `canceled_by_tutor` | no | The one validated field: a string outside `LEAVE_WORKFLOW_STATUSES` → `400 {"error":"Invalid workflow status"}` ([`:40-43`](../../../src/app/api/leave-requests/[requestId]/route.ts), list at [`data.ts:9-16`](../../../src/lib/leave-requests/data.ts), enum `leave_request_workflow_status` at [`schema.ts:165-172`](../../../src/lib/db/schema.ts)). A non-string value is read as `undefined` and silently ignored. Omitting it keeps the stored status ([`data.ts:509`](../../../src/lib/leave-requests/data.ts)). |
| `staffNote` | string \| `null` | no | A string writes it; explicit `null` clears it; any other type (or omission) leaves it unchanged ([`:56`](../../../src/app/api/leave-requests/[requestId]/route.ts), [`data.ts:524`](../../../src/lib/leave-requests/data.ts)). |
| `sheetStatusText` | string \| `null` | no | Detected by `hasOwnProperty`, so **presence itself matters**: present-and-non-string becomes `null`, absent stays `undefined` ([`:57-59`](../../../src/app/api/leave-requests/[requestId]/route.ts)). Any presence triggers a sheet write. |
| `retrySheetWrite` | `true` | no | Strict `=== true` ([`:60`](../../../src/app/api/leave-requests/[requestId]/route.ts)). Re-attempts the write using the row's current `source_sheet_status`. |

**Which text gets written.** `requestedSheetText` = the trimmed `sheetStatusText` if non-empty; else, on a retry, the row's current `source_sheet_status`; else the human label for the effective status (`New`, `Needs review`, `In progress`, `Done`, `Ignored`, `Canceled by tutor`) ([`data.ts:515-516`](../../../src/lib/leave-requests/data.ts), labels at [`:155-164`](../../../src/lib/leave-requests/data.ts)).

**When a sheet write happens.** `shouldWriteSheet` is true when `sheetStatusText` was present **or** `retrySheetWrite` **or** `workflowStatus` was supplied ([`data.ts:517`](../../../src/lib/leave-requests/data.ts)). The workspace always sends the complete body, so in practice every Save attempts a write ([`leave-requests-workspace.tsx:184-193`](../../../src/components/leave-requests/leave-requests-workspace.tsx)).

**Side effects,** in order:

1. **Resolve a writer account** before touching the row: `resolveLeaveRequestsConnectedEmail(db, session.user.email, true)` picks a Sheets **write**-scoped Google account — the configured `LEAVE_REQUESTS_CONNECTED_EMAIL`, else the actor, else any healthy write token ([`:46-51`](../../../src/app/api/leave-requests/[requestId]/route.ts), [`sync.ts:88-149`](../../../src/lib/leave-requests/sync.ts), config at [`config.ts:12-13`](../../../src/lib/leave-requests/config.ts)). A throw here is swallowed to `null`, and the write later falls back to the actor's own email ([`data.ts:548`](../../../src/lib/leave-requests/data.ts)).
2. **Update the row** — `workflow_status`, `staff_note`, `unread: false` (always), `status_updated_at`, and, when a write is due, `sheet_write_status: "pending"` with `sheet_write_error: null` ([`data.ts:519-530`](../../../src/lib/leave-requests/data.ts)).
3. **Append a `status_update` activity log** with the requested payload and the actor ([`data.ts:532-544`](../../../src/lib/leave-requests/data.ts)).
4. **Write one Google Sheets cell** — column `S` of the originating sheet row, i.e. `S{source_row_number}` on the request's own `spreadsheet_id` / `sheet_name` ([`data.ts:551-557`](../../../src/lib/leave-requests/data.ts), column constant at [`config.ts:10`](../../../src/lib/leave-requests/config.ts), helper at [`sheets.ts:242-261`](../../../src/lib/sales-dashboard/sheets.ts) — a `values.update` with `valueInputOption: "USER_ENTERED"`). On success the row records `source_sheet_status`, `sheet_write_status: "success"`, `sheet_written_at`, and a `sheet_status_write` log carrying the Sheets response ([`data.ts:558-577`](../../../src/lib/leave-requests/data.ts)). This is the feature's only write to an external system of record.
5. **On write failure**, the row is flipped to `sheet_write_status: "failed"` with the message in `sheet_write_error`, a failed `sheet_status_write` log is appended, and the message is returned as `warning` ([`data.ts:578-599`](../../../src/lib/leave-requests/data.ts)).

**A failed sheet write is still HTTP 200.** The status change is already committed; only `warning` and `sheetWriteStatus` report the failure, and the UI surfaces `warning` in its error banner ([`leave-requests-workspace.tsx:196-198`](../../../src/components/leave-requests/leave-requests-workspace.tsx)). Rows in that state are what `sheetWriteFailed` / `unreadActionCount` count, and `retrySheetWrite: true` is the retry path.

**Response `200`:** `{ ok: true, warning, detail }` — `warning` is `null` on success, and `detail` is [the detail payload](#the-detail-payload) re-read after the writes ([`:66`](../../../src/app/api/leave-requests/[requestId]/route.ts), [`data.ts:602-605`](../../../src/lib/leave-requests/data.ts)).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Update applied — including when the sheet write failed (see `warning`). |
| 400 | `workflowStatus` present but outside the six values. |
| 401 | No session, or a session without `user.email`. |
| 404 | No `leave_requests` row with that id ([`data.ts:507`](../../../src/lib/leave-requests/data.ts), [`:65`](../../../src/app/api/leave-requests/[requestId]/route.ts)). |
| 500 | Any other throw — e.g. a non-UUID `requestId`; body `{"error": <message>}`, defaulting to `"Leave request update failed"` ([`:67-70`](../../../src/app/api/leave-requests/[requestId]/route.ts)). Note the Google Sheets failure path is *not* here: it is caught inside the lib and downgraded to `warning`. |

### `POST /api/leave-requests/[requestId]/wise-cancel-preview`

Records a **dry-run** of the Wise cancellations an operator would have to perform by hand for the selected affected sessions. **No Wise request is made** — nothing under `src/lib/leave-requests/` or `src/app/api/leave-requests/` imports `@/lib/wise`. Handler [`wise-cancel-preview/route.ts:8-36`](../../../src/app/api/leave-requests/[requestId]/wise-cancel-preview/route.ts); logic in `createWiseCancelPreview` ([`data.ts:608-668`](../../../src/lib/leave-requests/data.ts)).

**Auth:** session with `user.email` ([`:9-12`](../../../src/app/api/leave-requests/[requestId]/wise-cancel-preview/route.ts)).

**Body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `affectedSessionIds` | `string[]` | **yes, non-empty** | Must be an array or it becomes `[]`; non-string members are filtered out before the call ([`:21-23`](../../../src/app/api/leave-requests/[requestId]/wise-cancel-preview/route.ts) — the behaviour pinned by the route test). Ids are `leave_request_affected_sessions.id` values, de-duplicated in the lib ([`data.ts:613`](../../../src/lib/leave-requests/data.ts)). |

**Side effects:**

1. **Reject an empty or unmatched selection** — `Select at least one affected session.` when the list is empty; `Selected affected sessions were not found.` when no row matches both the id list and this `leaveRequestId` ([`data.ts:614,623`](../../../src/lib/leave-requests/data.ts)). Cross-request ids are silently excluded by that `AND`, not reported.
2. **Rewrite the selection flags** — every affected session of this request is cleared to `cancel_preview_selected = false`, then the named ones are set to `true` ([`data.ts:625-635`](../../../src/lib/leave-requests/data.ts)). The selection is therefore a replace, not an accumulate.
3. **Set `cancellation_preview_count`** on the parent row to the number of matched rows ([`data.ts:647-650`](../../../src/lib/leave-requests/data.ts)) — overwriting the value the sync derived.
4. **Append one `wise_cancel_preview` activity log** with `status: "manual_required"`, the message `Previewed N Wise cancellation action(s). No Wise mutation was sent.`, and a payload of `{ dryRun: true, selectedAffectedSessionIds, endpoints, policy: "preview_only_manual_required" }` ([`data.ts:652-665`](../../../src/lib/leave-requests/data.ts)). Each `endpoints` entry is `{ wiseClassId, wiseSessionId, method: "DELETE", endpoint, manualRequired: true }`, where `endpoint` is `/teacher/classes/{wiseClassId}/sessions/{wiseSessionId}?cancelSession=true` — or `null` when either id is missing ([`data.ts:637-645`](../../../src/lib/leave-requests/data.ts)).

**Response `200`:** `{ ok: true, detail }` — [the detail payload](#the-detail-payload) re-read after the writes ([`:32`](../../../src/app/api/leave-requests/[requestId]/wise-cancel-preview/route.ts), [`data.ts:667`](../../../src/lib/leave-requests/data.ts)).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Preview recorded. |
| 401 | No session, or a session without `user.email`. |
| 400 | **Everything else.** The single catch maps every throw to 400 with `{"error": <message>}`, defaulting to `"Wise cancel preview failed"` ([`:33-35`](../../../src/app/api/leave-requests/[requestId]/wise-cancel-preview/route.ts)). An empty selection, an unknown request id, a non-UUID id, and a database outage are indistinguishable to the caller: this endpoint emits no 404 and no 500. |

---

## Running the sheet sync

Both sync entry points call the same `syncLeaveRequests` ([`sync.ts:366-455`](../../../src/lib/leave-requests/sync.ts)) and differ only in auth, in the recorded `triggerType`, and in whether a cron audit row is written.

**What one run does,** in order ([`sync.ts:372-434`](../../../src/lib/leave-requests/sync.ts)):

1. **Claim single-flight** by inserting a `leave_request_sync_runs` row with `status: "running"`. The guard is a partial unique index in Postgres — `uniqueIndex("leave_request_sync_runs_single_running_idx").on(status).where(status = 'running')` ([`schema.ts:2110-2112`](../../../src/lib/db/schema.ts)) — so a second concurrent insert simply collides; a message naming that index becomes `LeaveRequestSyncAlreadyRunningError` ([`sync.ts:55-58,21-26,385`](../../../src/lib/leave-requests/sync.ts)).
2. **Resolve a Google account** — the caller-supplied `connectedEmail` (lower-cased, trimmed) if given, else the healthy-token selection cascade ([`sync.ts:390-391,88-149`](../../../src/lib/leave-requests/sync.ts)).
3. **Fetch and parse the sheet** — the whole `Form Responses 1` tab of the configured spreadsheet ([`sync.ts:392-393`](../../../src/lib/leave-requests/sync.ts), defaults at [`config.ts:1-5`](../../../src/lib/leave-requests/config.ts)).
4. **Match, upsert, recompute** per parsed row: match the tutor against the active snapshot's identity tables, upsert the request keyed by (spreadsheet id, sheet name, source row number) with a `source_inserted` / `source_updated` / `source_refreshed` log, then fully replace that request's `leave_request_affected_sessions` from `future_session_blocks` ([`sync.ts:399-409`](../../../src/lib/leave-requests/sync.ts), [`data.ts:394-495`](../../../src/lib/leave-requests/data.ts)).
5. **Email the admin allowlist** about newly-inserted requests only — one message per `admin_users` row, with a `leave_request_notifications` row per (request × recipient) deduped on `leave-request:new:{requestId}:{recipient}` ([`sync.ts:316-364,270-276,355`](../../../src/lib/leave-requests/sync.ts)). Zero inserts means no recipients are even loaded.
6. **Finalize** the run row to `success` with the four counters and a metadata blob naming the spreadsheet, sheet, connected email, and matching snapshot ([`sync.ts:418-434`](../../../src/lib/leave-requests/sync.ts)). On any throw the row is set to `failed` with `error_summary` and the error is rethrown ([`sync.ts:443-454`](../../../src/lib/leave-requests/sync.ts)).

**There is no stale-run reaper.** Unlike payroll or credit control, nothing sweeps abandoned `running` rows — `leave_request_sync_runs` is only ever inserted or updated by the run that owns it, and no watchdog touches the table (`grep` for `leaveRequestSyncRuns` outside `schema.ts` returns only `sync.ts` and the Data Health dashboard read at [`dashboard.ts:775`](../../../src/lib/data-health/dashboard.ts)). A run killed by the 800 s function timeout therefore strands a `running` row, and **every** later sync — cron and manual alike — returns 409 until it is cleared by hand.

**Result object** returned by both endpoints ([`sync.ts:36-42`](../../../src/lib/leave-requests/sync.ts)):

```
{ syncRunId, scannedRowCount, insertedCount, updatedCount, notificationCount }
```

`notificationCount` counts notification **rows** written (recipients × new requests), not messages sent ([`sync.ts:345-360`](../../../src/lib/leave-requests/sync.ts)).

### `POST /api/leave-requests/sync`

The dashboard's "Sync now". Handler [`sync/route.ts:8-36`](../../../src/app/api/leave-requests/sync/route.ts); `export const maxDuration = 800` ([`sync/route.ts:6`](../../../src/app/api/leave-requests/sync/route.ts)).

**Auth:** session with `user.email` ([`:9-12`](../../../src/app/api/leave-requests/sync/route.ts)).

**Body** (optional; a missing or unparseable body degrades to `{}`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `connectedEmail` | string | no | Overrides the Google account used to read the sheet, bypassing the healthy-token cascade entirely ([`:27`](../../../src/app/api/leave-requests/sync/route.ts), [`sync.ts:390-391`](../../../src/lib/leave-requests/sync.ts)). Not validated: an account with no stored token simply fails the fetch and the run is recorded `failed`. Any other type is read as `null`. The workspace never sends a body ([`leave-requests-workspace.tsx:168`](../../../src/components/leave-requests/leave-requests-workspace.tsx)). |

`triggerType` is hard-coded `"manual"` and `actorEmail` / `actorName` come from the session — none of the three is client-settable ([`:24-27`](../../../src/app/api/leave-requests/sync/route.ts)).

**Response `200`:** `{ ok: true, result }` ([`:29`](../../../src/app/api/leave-requests/sync/route.ts)).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Run completed. |
| 401 | No session, or a session without `user.email`. |
| 409 | `LeaveRequestSyncAlreadyRunningError` — body `{"error":"Leave request sync is already running."}` ([`:31-33`](../../../src/app/api/leave-requests/sync/route.ts), message at [`sync.ts:23`](../../../src/lib/leave-requests/sync.ts)). |
| 500 | Any other failure — no healthy Google account, a Sheets error, a parse error, a DB error. Body `{"error": <message>}`, defaulting to `"Leave request sync failed"` ([`:34-35`](../../../src/app/api/leave-requests/sync/route.ts)). |

### `GET /api/internal/sync-leave-requests` · `POST /api/internal/sync-leave-requests`

The scheduled entry point. Both verbs delegate to one shared `handle()` — there is **no session fallback** on `POST`, unlike some other internal routes ([`route.ts:9-36`](../../../src/app/api/internal/sync-leave-requests/route.ts)); `export const maxDuration = 800` ([`:7`](../../../src/app/api/internal/sync-leave-requests/route.ts)). Cross-cutting cron mechanics live in [internal-crons.md § Leave requests](./internal-crons.md#leave-requests) and [crons.md](../crons.md).

**Auth:** `rejectInvalidCronSecret` — a constant-time comparison of the `Authorization` header against `Bearer ${CRON_SECRET}` ([`:10-11`](../../../src/app/api/internal/sync-leave-requests/route.ts), [`cron-auth.ts:6-26`](../../../src/lib/internal/cron-auth.ts)). No body or query parameter is read at all: `connectedEmail` cannot be supplied here.

**Registration:** `vercel.json` schedules the path at `15,45 * * * *` ([`vercel.json:44-47`](../../../vercel.json)), mirrored in the Data Health registry as job key `leave_requests` — cadence 30 min, late after 45 min, `maxDurationSeconds: 800`, `manualOnly: false`, `dangerous: false`, `routeMethod: "GET"` ([`cron-registry.ts:258-272`](../../../src/lib/data-health/cron-registry.ts)); the schedule is pinned by [`vercel-crons.test.ts:28`](../../../src/__tests__/vercel-crons.test.ts).

**Extra side effect: the audit row.** The handler is wrapped in `withCronInvocationAudit({ jobKey: "leave_requests", triggerSource: "cron", requestMethod })`, which inserts a `cron_invocations` row *before* the job runs and updates it after ([`:13-14`](../../../src/app/api/internal/sync-leave-requests/route.ts), [`cron-audit.ts:131-159`](../../../src/lib/data-health/cron-audit.ts)). Outcome classification reads the response: the 409 body contains "already running", so a blocked tick is recorded as **`skipped`**, not `failed` ([`cron-audit.ts:108-117`](../../../src/lib/data-health/cron-audit.ts)).

**`triggerType` is always `"cron"`** ([`:17`](../../../src/app/api/internal/sync-leave-requests/route.ts)), so an operator's manual `POST` to this path is persisted as cron-triggered in `leave_request_sync_runs`, and no `actor_email` is recorded. Use `POST /api/leave-requests/sync` (or the Data Health run-job path) when the run should be attributable.

**Response `200`:** `{ ok: true, result }` — the same result object as the in-app sync ([`:18`](../../../src/app/api/internal/sync-leave-requests/route.ts)).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Run completed. |
| 401 | Missing or non-matching bearer secret — `{"error":"Unauthorized"}` ([`cron-auth.ts:25`](../../../src/lib/internal/cron-auth.ts)). |
| 409 | Another run holds the single-flight row — `{"error":"Leave request sync is already running."}` ([`:20-22`](../../../src/app/api/internal/sync-leave-requests/route.ts)); audited as `skipped`. |
| 500 | Either `CRON_SECRET` is unset on the server — `{"error":"Server misconfigured"}` ([`cron-auth.ts:22-24`](../../../src/lib/internal/cron-auth.ts)) — or the sync threw; body `{"error": <message>}`, defaulting to `"Leave request sync failed"` ([`:23-24`](../../../src/app/api/internal/sync-leave-requests/route.ts)). |

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
