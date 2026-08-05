# Wise Activity API

**Canonical home:** this page owns the mechanical contracts — method, path, auth, request shape, response shape, side effects, status codes — for the six Wise Activity endpoints. What the audit store and the reconciliation workbench are *for*, and the rules behind them, live in [docs/features/wise-activity-audit.md](../../features/wise-activity-audit.md); this page does not restate them. Column-level detail for `wise_activity_events` / `wise_activity_sync_runs` lives in [docs/reference/database/index.md](../database/index.md); cron scheduling context lives in [docs/reference/crons.md](../crons.md).

One cron route under `/api/internal/` and five admin routes under `/api/wise-activity/**` crawl the Wise institute event feed into an append-only store, read that store back (paged list + dashboard rollups), and reconcile Sales-Dashboard package sales against Wise receipts. The internal route is also listed in [internal-crons.md](./internal-crons.md); it is documented in full here because it shares the ingest engine with the two admin write routes.

## Endpoint index

| Method + path | Auth | Handler |
|---|---|---|
| `GET /api/internal/sync-wise-activity` | `CRON_SECRET` bearer | [`internal/sync-wise-activity/route.ts:12`](../../../src/app/api/internal/sync-wise-activity/route.ts) |
| `POST /api/wise-activity/sync` | Auth.js session | [`wise-activity/sync/route.ts:24`](../../../src/app/api/wise-activity/sync/route.ts) |
| `POST /api/wise-activity/reconciliation/backfill` | Auth.js session | [`reconciliation/backfill/route.ts:18`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts) |
| `GET /api/wise-activity` | Auth.js session | [`wise-activity/route.ts:21`](../../../src/app/api/wise-activity/route.ts) |
| `GET /api/wise-activity/summary` | Auth.js session | [`wise-activity/summary/route.ts:14`](../../../src/app/api/wise-activity/summary/route.ts) |
| `GET /api/wise-activity/reconciliation` | Auth.js session | [`wise-activity/reconciliation/route.ts:20`](../../../src/app/api/wise-activity/reconciliation/route.ts) |

The only in-repo caller of the five `/api/wise-activity/**` routes is the workspace client ([`wise-activity-workspace.tsx:550-551,580,695,714`](../../../src/components/wise-activity/wise-activity-workspace.tsx)).

---

## Conventions shared across the six endpoints

**Two auth gates, no roles.** The internal route is gated only by `rejectInvalidCronSecret(request)` ([`internal/sync-wise-activity/route.ts:13-14`](../../../src/app/api/internal/sync-wise-activity/route.ts)) — a **constant-time** comparison of the `authorization` header against `Bearer ${CRON_SECRET}` behind a length pre-check ([`cron-auth.ts:12-16`](../../../src/lib/internal/cron-auth.ts)). It returns `401 {"error":"Unauthorized"}` on mismatch and `500 {"error":"Server misconfigured"}` when `CRON_SECRET` is unset ([`cron-auth.ts:22-25`](../../../src/lib/internal/cron-auth.ts)). That bearer check is its *only* gate: `/api/internal/` is in the middleware public-route allowlist ([`middleware.ts:18`](../../../src/middleware.ts)), so session middleware never runs for it.

The five `/api/wise-activity/**` routes each `await auth()` and return `401 {"error":"Unauthorized"}` when there is no session (e.g. [`wise-activity/route.ts:22-25`](../../../src/app/api/wise-activity/route.ts)). None of those paths are allowlisted, so an unauthenticated browser request is redirected to `/login` first ([`middleware.ts:71-75`](../../../src/middleware.ts)), and a restricted admin (non-null `allowedPages` not covering `/wise-activity`) gets a middleware-level `403 {"error":"Forbidden"}` — `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:30,53-60,79-82`](../../../src/middleware.ts)). No handler performs any further check; every signed-in full-access admin can trigger a sync.

**No Zod at these boundaries.** Unlike most BGScheduler routes, none of the six use a Zod schema. Validation is inline:

- Dates are matched against `DATE_RE = /^\d{4}-\d{2}-\d{2}$/` ([`wise-activity/route.ts:7`](../../../src/app/api/wise-activity/route.ts), [`summary/route.ts:7`](../../../src/app/api/wise-activity/summary/route.ts), [`reconciliation/route.ts:6`](../../../src/app/api/wise-activity/reconciliation/route.ts), [`backfill/route.ts:11`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)); reconciliation additionally uses `MONTH_RE = /^\d{4}-\d{2}$/` ([`reconciliation/route.ts:7`](../../../src/app/api/wise-activity/reconciliation/route.ts)).
- Query numbers go through a local `numberParam(value, fallback, min, max)` that **silently falls back** on a non-integer and otherwise clamps into range ([`wise-activity/route.ts:9-14`](../../../src/app/api/wise-activity/route.ts)).
- Body numbers go through a local `numberOption(value, fallback, min, max)` requiring a real JSON integer — a numeric *string* such as `"30"` is rejected and the default applies ([`sync/route.ts:15-18`](../../../src/app/api/wise-activity/sync/route.ts), [`backfill/route.ts:13-16`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)).
- Query strings go through `stringParam()`, which trims and maps empty to `undefined` ([`wise-activity/route.ts:16-19`](../../../src/app/api/wise-activity/route.ts)).

**A malformed JSON body never 400s on parse.** Both POST routes wrap `request.json()` in `try`/`catch` and fall back to `{}` ([`sync/route.ts:30-36`](../../../src/app/api/wise-activity/sync/route.ts), [`backfill/route.ts:24-30`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)). `POST /api/wise-activity/sync` with no body therefore runs entirely on defaults; `POST …/reconciliation/backfill` with no body instead fails its required-date check and returns `400`.

**Bangkok day boundaries.** The two read routes convert an inclusive `YYYY-MM-DD` pair into a UTC instant range with `wiseActivityBangkokRange()`: `start` = Bangkok midnight of `startDate`, `end` = Bangkok midnight of `endDate + 1 day` minus 1 ms ([`data.ts:240-245`](../../../src/lib/wise-activity/data.ts)), built on `bangkokDateStartUtc` = `Date.UTC(y, m-1, d, -7)` ([`room-capacity/dates.ts:44-47`](../../../src/lib/room-capacity/dates.ts)). Both default to the last seven Bangkok days: `endDate = todayBangkok()`, `startDate = endDate − 6` ([`wise-activity/route.ts:28-31`](../../../src/app/api/wise-activity/route.ts), [`summary/route.ts:21-24`](../../../src/app/api/wise-activity/summary/route.ts)).

**Single-flight ingest.** All three write routes call the same `syncWiseActivityEvents()` ([`sync.ts:152-293`](../../../src/lib/wise-activity/sync.ts)) with the institute id `process.env.WISE_INSTITUTE_ID` falling back to the hard-coded `696e1f4d90102225641cc413`. Concurrency is enforced by the partial unique index `wise_activity_sync_runs_single_running_idx` ([`schema.ts:567-569`](../../../src/lib/db/schema.ts)); the resulting `23505` becomes `WiseActivitySyncAlreadyRunningError` ([`sync.ts:58-67,181-184`](../../../src/lib/wise-activity/sync.ts)), which all three routes map to **409** `{"error":"Wise activity sync is already running"}` (message at [`sync.ts:53`](../../../src/lib/wise-activity/sync.ts)).

**Error shape.** Every handler ends with `catch` → `{"error": err instanceof Error ? err.message : "<fallback>"}` at `500`; the fallback string differs per route and is given in each section.

---

## The shared ingest engine

Because three of the six endpoints are thin wrappers over it, `syncWiseActivityEvents(db, client, instituteId, options)` is documented once here ([`sync.ts:152-293`](../../../src/lib/wise-activity/sync.ts)).

**Options and their defaults** ([`sync.ts:17-35,158-165`](../../../src/lib/wise-activity/sync.ts)):

| Option | Default | Effect |
|--------|---------|--------|
| `triggerType` | `"cron"` | Stored on the run row; also selects the two defaults below. |
| `lookbackDays` | `3` for cron, `30` for manual ([`sync.ts:9,11,160`](../../../src/lib/wise-activity/sync.ts)) | Sets `cutoff = now − lookbackDays`; the crawl stops once the oldest event seen reaches it. |
| `maxPages` | `20` for cron, `500` for manual ([`sync.ts:10,12,161`](../../../src/lib/wise-activity/sync.ts)) | Page budget; the loop runs `startPage … startPage + maxPages − 1`. |
| `eventName` | none | Server-side Wise filter, so a targeted crawl reaches far deeper per page. |
| `startPage` | `1` (floored at 1) | Lets a deep crawl resume mid-history. |
| `stopOnKnownEvents` | `true` | Stop when a full page contains only already-persisted event ids. |
| `now` | `new Date()` | Test seam. |

**Steps:**

1. **Reap abandoned runs.** Any `wise_activity_sync_runs` row still `running` after 20 minutes (`STALE_RUNNING_MS`, [`sync.ts:13`](../../../src/lib/wise-activity/sync.ts)) is set to `failed` with a fixed `errorSummary` ([`sync.ts:130-142`](../../../src/lib/wise-activity/sync.ts)).
2. **Claim the lock.** Insert a `running` row with `triggerType` and `metadata = { lookbackDays, maxPages, startPage, eventName, stopOnKnownEvents }` ([`sync.ts:171-180`](../../../src/lib/wise-activity/sync.ts)); a unique violation throws `WiseActivitySyncAlreadyRunningError`.
3. **Crawl.** Each iteration calls `fetchWiseActivityEvents` → `GET /institutes/{instituteId}/events` with `page_number`, `page_size` (clamped to ≤ 50) and optional `eventName` ([`fetchers.ts:498-517`](../../../src/lib/wise/fetchers.ts)); `PAGE_SIZE` is 50 ([`sync.ts:8`](../../../src/lib/wise-activity/sync.ts)).
4. **Normalize.** `normalizeWiseActivityEvent` flattens the Wise envelope into the table's columns and **drops any event without both `eventId` and a parseable `eventTimestamp`** ([`sync.ts:90-128`](../../../src/lib/wise-activity/sync.ts), null guard at [`sync.ts:103`](../../../src/lib/wise-activity/sync.ts)). The full envelope is kept in `payload` and `raw`.
5. **Insert append-only.** Existing ids are pre-selected to detect an all-known page, then rows are inserted with `onConflictDoNothing` on the `event_id` unique index ([`sync.ts:218-234`](../../../src/lib/wise-activity/sync.ts), [`schema.ts:543`](../../../src/lib/db/schema.ts)). **An already-stored event is never updated** — re-running a sync only adds rows.
6. **Stop.** `stoppedReason` is one of `empty_page`, `short_page` (page shorter than 50), `lookback_reached`, `known_events`, or the initial `max_pages` ([`sync.ts:191,204-207,236-247`](../../../src/lib/wise-activity/sync.ts)).
7. **Close the run.** On success the row is updated to `success` with the counters plus `metadata.stoppedReason` ([`sync.ts:250-262`](../../../src/lib/wise-activity/sync.ts)); on any throw it is updated to `failed` with `errorSummary` and the error is re-thrown ([`sync.ts:275-292`](../../../src/lib/wise-activity/sync.ts)).

**`result` object** (`WiseActivitySyncResult`, [`sync.ts:37-47`](../../../src/lib/wise-activity/sync.ts)) — returned verbatim inside `{ ok: true, result }` by all three write routes:

| Field | Type | Notes |
|-------|------|-------|
| `syncRunId` | string (uuid) | The `wise_activity_sync_runs` row. |
| `status` | `"success"` | Literal — a failure throws instead. |
| `triggerType` | `"cron"` \| `"manual"` | |
| `pagesFetched` | number | Wise pages actually requested. |
| `eventsFetched` | number | Raw events returned, before normalization drops. |
| `insertedCount` | number | Rows newly persisted (conflicts excluded). |
| `oldestEventTimestamp` | string \| null | `Date` in TS, ISO-8601 after JSON serialization. |
| `newestEventTimestamp` | string \| null | Same. |
| `stoppedReason` | string | One of the five values above. |

---

## Ingest

### `GET /api/internal/sync-wise-activity`

The scheduled incremental crawl. Handler: [`internal/sync-wise-activity/route.ts:12-36`](../../../src/app/api/internal/sync-wise-activity/route.ts). `export const maxDuration = 800` ([line 8](../../../src/app/api/internal/sync-wise-activity/route.ts)).

**Auth:** `CRON_SECRET` bearer only ([lines 13-14](../../../src/app/api/internal/sync-wise-activity/route.ts)). See the shared conventions above for the two failure statuses.

**Request:** no query parameters and no body are read. Everything is fixed: `triggerType: "cron"` ([line 24](../../../src/app/api/internal/sync-wise-activity/route.ts)), hence `lookbackDays = 3` and `maxPages = 20`, `startPage = 1`, `stopOnKnownEvents = true`, no `eventName` filter.

**Schedule:** `5,35 * * * *` in [`vercel.json`](../../../vercel.json), mirrored by the registry entry `wise_activity` (`lateAfterMinutes: 45`, `maxDurationSeconds: 800`, `routeMethod: "GET"`, [`cron-registry.ts:63-75`](../../../src/lib/data-health/cron-registry.ts)).

**Side effects:**

- The full ingest described above (writes to `wise_activity_events` and `wise_activity_sync_runs`).
- **Cron audit.** The handler body is wrapped in `withCronInvocationAudit({ jobKey: "wise_activity", triggerSource: "cron", requestMethod })` ([lines 16-18](../../../src/app/api/internal/sync-wise-activity/route.ts)), which inserts a `cron_invocations` row before the work and updates it afterwards with duration, `responseStatus`, `linkedRunIds.resultRunId` (from `result.syncRunId`) and the response body in `metadata` ([`cron-audit.ts:84-142`](../../../src/lib/data-health/cron-audit.ts)). Outcome is derived from the response: a body whose error message contains `already running` is recorded as **`skipped`**, not `failed` ([`cron-audit.ts:61-70`](../../../src/lib/data-health/cron-audit.ts)). The wrapper also converts an uncaught throw into `500 { error }` ([`cron-audit.ts:153-157`](../../../src/lib/data-health/cron-audit.ts)); audit-write failures are swallowed with `console.error` and never break the sync.

**Response 200:** `{ ok: true, result }` — see the `result` table above.

| Status | When |
|--------|------|
| 200 | Sync completed. |
| 401 | Missing or incorrect `Authorization: Bearer <CRON_SECRET>`. |
| 409 | `WiseActivitySyncAlreadyRunningError` ([lines 28-30](../../../src/app/api/internal/sync-wise-activity/route.ts)); recorded as `skipped` in `cron_invocations`. |
| 500 | `CRON_SECRET` unset (`Server misconfigured`), or any other throw with fallback message `Wise activity sync failed` ([lines 31-32](../../../src/app/api/internal/sync-wise-activity/route.ts)). |

---

### `POST /api/wise-activity/sync`

Admin-triggered crawl, tunable and optionally targeted at a single event name. Handler: [`sync/route.ts:24-62`](../../../src/app/api/wise-activity/sync/route.ts). `export const maxDuration = 800` ([line 7](../../../src/app/api/wise-activity/sync/route.ts)).

**Auth:** session required ([lines 25-28](../../../src/app/api/wise-activity/sync/route.ts)).

**Request body** (JSON, all fields optional; a missing or unparseable body becomes `{}`):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `lookbackDays` | integer | `30` | Clamped to `[1, 400]` by `numberOption` ([line 45](../../../src/app/api/wise-activity/sync/route.ts)). |
| `maxPages` | integer | `500` | Clamped to `[1, 1000]` ([line 46](../../../src/app/api/wise-activity/sync/route.ts)). |
| `eventName` | string | none | **Allowlisted.** Only `"SessionFeedbackSubmittedEvent"` is accepted; any other value is silently dropped to `undefined`, i.e. an unfiltered crawl ([lines 13,20-22,47](../../../src/app/api/wise-activity/sync/route.ts)). The comment at [lines 11-12](../../../src/app/api/wise-activity/sync/route.ts) states the intent: an arbitrary caller must not be able to steer the crawl at an unbounded feed. |
| `startPage` | integer | `1` | Clamped to `[1, 5000]`; lets a deep crawl resume mid-history ([line 48](../../../src/app/api/wise-activity/sync/route.ts)). |
| `stopOnKnownEvents` | boolean | `true` | Computed as `input.stopOnKnownEvents !== false` ([line 51](../../../src/app/api/wise-activity/sync/route.ts)) — only the literal `false` disables the early stop; every other value, including omission, leaves it on. |

`triggerType` is always `"manual"` ([line 43](../../../src/app/api/wise-activity/sync/route.ts)). The workspace's sync button posts `{ lookbackDays: 30, maxPages: 500 }` ([`wise-activity-workspace.tsx:695-699`](../../../src/components/wise-activity/wise-activity-workspace.tsx)).

**Side effects:** the shared ingest only. Unlike the internal route, this one is **not** wrapped in `withCronInvocationAudit`, so a manual sync leaves no `cron_invocations` row — only the `wise_activity_sync_runs` row.

**Response 200:** `{ ok: true, result }`.

| Status | When |
|--------|------|
| 200 | Sync completed. |
| 401 | No session. |
| 409 | A sync is already running ([lines 56-58](../../../src/app/api/wise-activity/sync/route.ts)). |
| 500 | Any other throw (Wise fetch failure, DB error); fallback message `Wise activity sync failed` ([lines 59-60](../../../src/app/api/wise-activity/sync/route.ts)). |

There is no `400` on this route: every field is either clamped or silently dropped.

---

### `POST /api/wise-activity/reconciliation/backfill`

Deepens the persisted event store far enough back to cover a reconciliation date range, so that "no candidate found" rows can be trusted. Handler: [`reconciliation/backfill/route.ts:18-56`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts). `export const maxDuration = 800` ([line 8](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)).

**Auth:** session required ([lines 19-22](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)).

**Request body** (JSON):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `startDate` | string `YYYY-MM-DD` | yes | Must match `DATE_RE` and be `<= endDate`, else `400 {"error":"Invalid date range"}` ([lines 31-35](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)). Converted into the crawl's `lookbackDays`. |
| `endDate` | string `YYYY-MM-DD` | yes | Validated only. It is **not** forwarded to the crawl — the ingest always walks backwards from *now*, so `endDate` cannot bound the recent end of the window. |
| `maxPages` | integer | no | Default `1000`, clamped to `[1, 1000]` ([lines 13-16,45](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)). |

`lookbackDays` is derived by `wiseReconciliationBackfillLookbackDays(startDate)`: `ceil((Bangkok-midnight-today − Bangkok-midnight-startDate) / 86 400 000) + 1`, clamped to `[1, 365]` ([`reconciliation.ts:1013-1018`](../../../src/lib/wise-activity/reconciliation.ts)). A `startDate` older than roughly a year is therefore silently truncated to a 365-day lookback. `triggerType` is `"manual"`; `eventName` is not settable here (unfiltered crawl), `startPage` defaults to 1, and `stopOnKnownEvents` is left at the engine default `true` ([lines 42-46](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)).

The workspace posts the reconciliation's current `dateRange` plus `maxPages: 1000` ([`wise-activity-workspace.tsx:714-722`](../../../src/components/wise-activity/wise-activity-workspace.tsx)).

**Side effects:** the shared ingest only — same tables, same single-flight lock, no `cron_invocations` row. It performs **no reconciliation work**; the client re-fetches `GET /api/wise-activity/reconciliation` afterwards ([`wise-activity-workspace.tsx:724`](../../../src/components/wise-activity/wise-activity-workspace.tsx)).

**Response 200:** `{ ok: true, result }`.

| Status | When |
|--------|------|
| 200 | Backfill crawl completed. |
| 400 | `startDate`/`endDate` missing, not `YYYY-MM-DD`, or reversed ([lines 33-35](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)). A body that fails to parse lands in this same branch. |
| 401 | No session. |
| 409 | A sync is already running ([lines 50-52](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)). |
| 500 | Any other throw; fallback message `Wise reconciliation backfill failed` ([lines 53-54](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)). |

---

## Reading the persisted store

### `GET /api/wise-activity`

Paged, filtered listing of `wise_activity_events`. Read-only — no writes, no `"use cache"`. Handler: [`wise-activity/route.ts:21-56`](../../../src/app/api/wise-activity/route.ts); query built by `listWiseActivityEvents` ([`data.ts:132-161`](../../../src/lib/wise-activity/data.ts)).

**Auth:** session required ([lines 22-25](../../../src/app/api/wise-activity/route.ts)).

**Query parameters:**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `startDate` | `YYYY-MM-DD` | today − 6 days (Bangkok) | Inclusive lower bound on `event_timestamp`. |
| `endDate` | `YYYY-MM-DD` | today (Bangkok) | Inclusive upper bound, expanded to end-of-day Bangkok minus 1 ms. |
| `page` | integer | `1` | Clamped to `[1, 10000]` ([line 41](../../../src/app/api/wise-activity/route.ts)); offset is `(page − 1) × pageSize`. |
| `pageSize` | integer | `50` | Clamped to `[1, 100]` ([line 42](../../../src/app/api/wise-activity/route.ts)). |
| `type` | string | — | Exact match on `event_type` ([`data.ts:104`](../../../src/lib/wise-activity/data.ts)). |
| `eventName` | string | — | Exact match on `event_name` ([`data.ts:105`](../../../src/lib/wise-activity/data.ts)). |
| `sessionId` | string | — | Exact match on `session_id` ([`data.ts:106`](../../../src/lib/wise-activity/data.ts)). |
| `transactionId` | string | — | Exact match on `transaction_id` ([`data.ts:107`](../../../src/lib/wise-activity/data.ts)). |
| `q` | string | — | Case-insensitive `ILIKE '%q%'` across `actor_name`, `classroom_name`, `classroom_subject`, `event_name`, `session_id`, `transaction_id` ([`data.ts:117-127`](../../../src/lib/wise-activity/data.ts)). Parameterized, not interpolated. |
| `financeOnly` | `"true"` | off | Only the exact string `"true"` enables it ([line 48](../../../src/app/api/wise-activity/route.ts)). Adds `event_type = 'BILLING' OR transaction_id IS NOT NULL OR event_name ILIKE '%invoice%' OR '%payment%' OR '%payout%'` ([`data.ts:108-116`](../../../src/lib/wise-activity/data.ts)). |

**Response 200** — returned bare, no envelope:

```
{
  "events": WiseActivityEventDto[],   // ordered by event_timestamp DESC
  "pagination": { "page", "pageSize", "total", "pageCount" }
}
```

`total` comes from a parallel `count(*)::text` over the same predicate, and `pageCount = ceil(total / pageSize)` ([`data.ts:137-159`](../../../src/lib/wise-activity/data.ts)). `WiseActivityEventDto` ([`data.ts:33-55,63-87`](../../../src/lib/wise-activity/data.ts)) is the row with all timestamps ISO-serialized: `id`, `eventId`, `eventType`, `eventName`, `eventTimestamp`, `actorWiseUserId`, `actorName`, `actorRole`, `classroomId`, `classroomName`, `classroomSubject`, `sessionId`, `sessionStartTime`, `sessionEndTime`, `transactionId`, `transactionType`, `transactionStatus`, `transactionAmount`, `transactionCurrency`, `payload`, `raw`. `payload` and `raw` are the untrimmed Wise JSON, so response weight scales with them.

| Status | When |
|--------|------|
| 200 | Page returned. |
| 400 | `startDate`/`endDate` not `YYYY-MM-DD`, or `startDate > endDate` → `{"error":"Invalid date range"}` ([lines 32-34](../../../src/app/api/wise-activity/route.ts)). |
| 401 | No session. |
| 500 | Any throw; fallback message `Wise activity query failed` ([lines 52-54](../../../src/app/api/wise-activity/route.ts)). |

---

### `GET /api/wise-activity/summary`

Dashboard rollups over the same filtered set. Read-only. Handler: [`summary/route.ts:14-48`](../../../src/app/api/wise-activity/summary/route.ts); aggregation by `getWiseActivitySummary` ([`data.ts:163-238`](../../../src/lib/wise-activity/data.ts)).

**Auth:** session required ([lines 15-18](../../../src/app/api/wise-activity/summary/route.ts)).

**Query parameters:** identical to `GET /api/wise-activity` **minus** `page` / `pageSize` — `startDate`, `endDate`, `type`, `eventName`, `q`, `sessionId`, `transactionId`, `financeOnly` ([lines 36-41](../../../src/app/api/wise-activity/summary/route.ts)) — evaluated by the same `buildConditions()` helper.

**Response 200** — bare object:

| Key | Shape | Notes |
|-----|-------|-------|
| `cards` | `{ totalEvents, sessionMutationEvents, financeEvents, lastSyncAt, lastSyncStatus, lastSyncInsertedCount }` | The `lastSync*` values come from the single most recent `wise_activity_sync_runs` row by `started_at` — **any** run, ignoring both the date filter and status; `lastSyncAt` prefers `finishedAt` and falls back to `startedAt` ([`data.ts:173-177,220-229`](../../../src/lib/wise-activity/data.ts)). |
| `activityByDate` | `{ date, total, [eventType]: number }[]` | One entry per Bangkok date in `[startDate, endDate]`, seeded to `total: 0` so empty days still appear; per-`eventType` keys are added dynamically ([`data.ts:179-200`](../../../src/lib/wise-activity/data.ts)). |
| `financeTrend` | `{ date, count, amount }[]` | Same seeded date spine; `amount` sums `transaction_amount` over finance events ([`data.ts:181,211-217`](../../../src/lib/wise-activity/data.ts)). |
| `eventTypeCounts` | `Record<string, number>` | Counts by `event_type`. |
| `eventNameCounts` | `Record<string, number>` | Counts by `event_name`. |
| `sessionMutationCounts` | `Record<string, number>` | Pre-seeded with `SessionCreatedEvent`, `SessionUpdatedEvent`, `SessionCancelledEvent`, `SessionDeletedEvent` at 0 ([`data.ts:184-189`](../../../src/lib/wise-activity/data.ts)); membership test is `SESSION_MUTATION_EVENTS` ([`format.ts:3-8,68-70`](../../../src/lib/wise-activity/format.ts)). |
| `topActors` | `[name, count][]` | Top 8 by count over non-null `actor_name` ([`data.ts:235`](../../../src/lib/wise-activity/data.ts)). |
| `topClassrooms` | `[name, count][]` | Top 8 by count over non-null `classroom_name` ([`data.ts:236`](../../../src/lib/wise-activity/data.ts)). |

Two mechanical caveats. First, the handler **selects every matching row with no `LIMIT`** and aggregates in JavaScript ([`data.ts:167-171`](../../../src/lib/wise-activity/data.ts)), so cost grows linearly with the range. Second, `cards.financeEvents` is computed by `isWiseFinanceEvent`, whose regex is `/invoice|payment|payout|transaction/i` ([`format.ts:57-66`](../../../src/lib/wise-activity/format.ts)), while the `financeOnly=true` **filter** matches `%invoice%`/`%payment%`/`%payout%` with no `transaction` term ([`data.ts:108-116`](../../../src/lib/wise-activity/data.ts)) — the card can therefore count events that re-querying with `financeOnly=true` would not return.

| Status | When |
|--------|------|
| 200 | Summary returned. |
| 400 | Bad or reversed date range → `{"error":"Invalid date range"}` ([lines 25-27](../../../src/app/api/wise-activity/summary/route.ts)). |
| 401 | No session. |
| 500 | Any throw; fallback message `Wise activity summary failed` ([lines 44-46](../../../src/app/api/wise-activity/summary/route.ts)). |

---

## Reconciliation

### `GET /api/wise-activity/reconciliation`

Matches Sales-Dashboard package-sale rows against Wise receipts and reports revenue variance. Handler: [`reconciliation/route.ts:20-51`](../../../src/app/api/wise-activity/reconciliation/route.ts); all work in `getWisePackageSalesReconciliation` ([`reconciliation.ts:821-921`](../../../src/lib/wise-activity/reconciliation.ts)). It writes nothing, but it **does make live outbound Wise API calls** on every request.

**Auth:** session required ([lines 21-24](../../../src/app/api/wise-activity/reconciliation/route.ts)).

**Query parameters** (all optional):

| Param | Type | Notes |
|-------|------|-------|
| `sourceId` | string | Selects the Sales-Dashboard source by exact `id`; an unknown id yields *no* source rather than a fallback ([`reconciliation.ts:761`](../../../src/lib/wise-activity/reconciliation.ts)). |
| `month` | `YYYY-MM` | Used only when `sourceId` is absent; matches `sourceMonth.slice(0, 7)` ([`reconciliation.ts:762`](../../../src/lib/wise-activity/reconciliation.ts)). Malformed → `400 {"error":"Invalid month"}` ([lines 32-34](../../../src/app/api/wise-activity/reconciliation/route.ts)). It selects the **source**, not the date range. |
| `startDate`, `endDate` | `YYYY-MM-DD` | Must be supplied **as a pair**; one without the other, a malformed value, or `startDate > endDate` → `400 {"error":"Invalid date range"}` ([lines 14-18,35-37](../../../src/app/api/wise-activity/reconciliation/route.ts)). Omitted → derived (below). |

**Source and range resolution** ([`reconciliation.ts:748-764,830-861`](../../../src/lib/wise-activity/reconciliation.ts)): candidate sources are the non-`archived` `sales_dashboard_sources` ordered by `source_month` descending. With neither `sourceId` nor `month`, the first source having a `lastSuccessfulImportRunId` wins, else the first source, else none. With no source at all the endpoint returns an **empty but well-formed** reconciliation whose `dateRange` is today→today. A source that exists but has never imported successfully **throws** — `Selected Sales Dashboard source has no successful package-sales import.` → `500` ([`reconciliation.ts:843-845`](../../../src/lib/wise-activity/reconciliation.ts)). When no explicit range is given, the range defaults to the min/max `payment_date` of that import's rows, falling back to `sourceMonth` → end of that Bangkok month ([`reconciliation.ts:697-709`](../../../src/lib/wise-activity/reconciliation.ts)).

**Data assembled per request:**

- Package-sale rows for the source's `lastSuccessfulImportRunId`, filtered to the resolved date range ([`reconciliation.ts:847-858`](../../../src/lib/wise-activity/reconciliation.ts)).
- Persisted **inbound** Wise events in range — `event_type = 'BILLING' OR transaction_id IS NOT NULL OR event_name ILIKE '%invoice%'/'%payment%'/'%transaction%'`, minus anything matching `%payout%` ([`reconciliation.ts:863-879`](../../../src/lib/wise-activity/reconciliation.ts)); the same rule in code is `isInboundWiseInvoiceEvent` ([`reconciliation.ts:300-311`](../../../src/lib/wise-activity/reconciliation.ts)).
- Credit-control packages from the active `credit_control_snapshots` row, used as the student/class identity bridge ([`reconciliation.ts:880-906`](../../../src/lib/wise-activity/reconciliation.ts)).
- **Live Wise calls, made in parallel and never fatal**: `GET /institutes/{id}/trends` for fees-paid trends ([`fetchers.ts:567-583`](../../../src/lib/wise/fetchers.ts)) and paged `GET /institutes/{id}/fees/transactions` for receipts ([`fetchers.ts:719-747`](../../../src/lib/wise/fetchers.ts)). A missing `WISE_USER_ID`/`WISE_API_KEY`, or any thrown error, is captured into `revenueVariance.wiseRevenueUnavailableReason` / `wiseReceiptsUnavailableReason` and the response still returns 200 ([`reconciliation.ts:766-819`](../../../src/lib/wise-activity/reconciliation.ts)).

**Response 200** — a bare `WisePackageSalesReconciliation` ([`reconciliation.ts:158-178`](../../../src/lib/wise-activity/reconciliation.ts)), assembled by `buildPackageSalesReconciliation` ([`reconciliation.ts:618-689`](../../../src/lib/wise-activity/reconciliation.ts)):

| Key | Shape | Notes |
|-----|-------|-------|
| `sources` | `ReconciliationSourceSummary[]` | `{ id, sourceMonth, label, status, lastImportedAt, lastNormalRowCount }` ([`reconciliation.ts:19-26`](../../../src/lib/wise-activity/reconciliation.ts)) — populates the source picker. |
| `selectedSource` | same \| null | Null only when there is no usable source. |
| `dateRange` | `{ startDate, endDate }` | The resolved range, echoed for the backfill button. |
| `coverage` | `{ status, requiredStartDate, requiredEndDate, firstInboundEventAt, lastInboundEventAt, firstInboundEventDate, lastInboundEventDate, inboundEventCount, message }` | `status` is `complete` \| `partial` \| `empty`; anything but `complete` means missing-candidate rows cannot be trusted until a backfill runs ([`reconciliation.ts:123-133,446-471`](../../../src/lib/wise-activity/reconciliation.ts)). |
| `summary` | `{ saleRows, students, sheetTotal, rowsWithCandidates, rowsNeedingReview, candidateCount, wiseInboundEvents, wiseReceipts }` | ([`reconciliation.ts:166-175,667-676`](../../../src/lib/wise-activity/reconciliation.ts)). |
| `revenueVariance` | 18-field object | Sheet total vs Wise fees-paid trend vs summed receipts, with both deltas (`sheetMinusReceipts`, `receiptsMinusTrend`), availability flags and reasons; `currency` is the literal `"THB"` and `source` the literal `"wise_fees_paid_trend"` ([`reconciliation.ts:135-156,505-557`](../../../src/lib/wise-activity/reconciliation.ts)). |
| `students` | `ReconciliationStudentGroup[]` | `{ studentKey, studentNickname, rowCount, totalAmount, rowsWithCandidates, rowsNeedingReview, rows }`, sorted by `rowsNeedingReview` desc then nickname ([`reconciliation.ts:113-121,651-654`](../../../src/lib/wise-activity/reconciliation.ts)). |

Each `rows[]` entry is a `ReconciliationSaleRow` ([`reconciliation.ts:95-111`](../../../src/lib/wise-activity/reconciliation.ts)) carrying `reviewFlags: string[]` and at most **5** scored `candidates` (`MAX_CANDIDATES_PER_ROW`, [`reconciliation.ts:16,623-627`](../../../src/lib/wise-activity/reconciliation.ts)); a candidate is `{ source: "wise_receipt", …, score, confidence: "high" | "medium" | "low", reasons[] }` ([`reconciliation.ts:71-93`](../../../src/lib/wise-activity/reconciliation.ts)). How candidates are scored and what each review flag means belongs to [docs/features/wise-activity-audit.md](../../features/wise-activity-audit.md).

Note that candidates are matched against the **live receipts**, whereas `coverage` and `summary.wiseInboundEvents` describe the **persisted** event store — the two numbers answer different questions.

| Status | When |
|--------|------|
| 200 | Reconciliation returned, including the empty-source and Wise-unavailable cases. |
| 400 | `month` not `YYYY-MM`; or a half-supplied, malformed, or reversed date pair ([lines 32-37](../../../src/app/api/wise-activity/reconciliation/route.ts)). |
| 401 | No session. |
| 500 | Selected source has no successful import, or any other throw; fallback message `Wise reconciliation query failed` ([lines 47-49](../../../src/app/api/wise-activity/reconciliation/route.ts)). |

The library's own `validateDateRange` throws the same literal `Invalid date range` ([`reconciliation.ts:691-695`](../../../src/lib/wise-activity/reconciliation.ts)), but the route's pre-check makes that path unreachable over HTTP — and were it reached, it would surface as `500`, not `400`.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
