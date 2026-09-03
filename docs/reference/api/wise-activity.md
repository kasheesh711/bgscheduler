# Wise Activity API

**Authoritative source:** the six route handlers under [`src/app/api/wise-activity/`](../../../src/app/api/wise-activity/) and [`src/app/api/internal/sync-wise-activity/`](../../../src/app/api/internal/sync-wise-activity/). Status is declared by the feature doc ([docs/features/wise-activity-audit.md](../../features/wise-activity-audit.md) — "Status: stable"); this page does not restate it.

This page is the canonical mechanical reference for the Wise Activity HTTP surface: method, path, auth, request shape, response shape, side effects, and status codes. What the audit store and the reconciliation workbench are *for*, and the rules behind them, live in [docs/features/wise-activity-audit.md](../../features/wise-activity-audit.md). Column-level detail for `wise_activity_events` / `wise_activity_sync_runs` lives in [docs/reference/database/erd-core.md](../database/erd-core.md) ([`schema.ts:518-552`](../../../src/lib/db/schema.ts) and [`schema.ts:553-571`](../../../src/lib/db/schema.ts)). Cron scheduling context lives in [docs/reference/crons.md](../crons.md); the internal route is also listed in [internal-crons.md](./internal-crons.md) and is documented in full here because it shares its ingest engine with two of the admin routes.

**Endpoints on this page (6):**

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/wise-activity` | session | [`route.ts:21`](../../../src/app/api/wise-activity/route.ts) |
| GET | `/api/wise-activity/summary` | session | [`summary/route.ts:14`](../../../src/app/api/wise-activity/summary/route.ts) |
| GET | `/api/internal/sync-wise-activity` | `CRON_SECRET` bearer | [`internal/sync-wise-activity/route.ts:12`](../../../src/app/api/internal/sync-wise-activity/route.ts) |
| POST | `/api/wise-activity/sync` | session | [`sync/route.ts:24`](../../../src/app/api/wise-activity/sync/route.ts) |
| GET | `/api/wise-activity/reconciliation` | session | [`reconciliation/route.ts:20`](../../../src/app/api/wise-activity/reconciliation/route.ts) |
| POST | `/api/wise-activity/reconciliation/backfill` | session | [`reconciliation/backfill/route.ts:18`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts) |

The only in-repo caller of the five `/api/wise-activity/**` routes is the workspace client ([`wise-activity-workspace.tsx:550-551,580,695,714`](../../../src/components/wise-activity/wise-activity-workspace.tsx)). `GET /api/internal/sync-wise-activity` is called by Vercel Cron on `2,17,32,47 * * * *` ([`vercel.json:28-31`](../../../vercel.json), pinned by [`vercel-crons.test.ts:24,145`](../../../src/__tests__/vercel-crons.test.ts)).

---

## Conventions shared across the six endpoints

**Two auth gates, no roles.** The internal route is gated only by `rejectInvalidCronSecret(request)` ([`internal/sync-wise-activity/route.ts:13-14`](../../../src/app/api/internal/sync-wise-activity/route.ts)) — a constant-time comparison of the `authorization` header against `Bearer ${CRON_SECRET}` behind a length pre-check ([`cron-auth.ts:12-16`](../../../src/lib/internal/cron-auth.ts)). It returns `401 {"error":"Unauthorized"}` on mismatch and `500 {"error":"Server misconfigured"}` when `CRON_SECRET` is unset ([`cron-auth.ts:19-26`](../../../src/lib/internal/cron-auth.ts)). That bearer check is its *only* gate: `/api/internal/` is in the middleware public-route allowlist ([`middleware.ts:24`](../../../src/middleware.ts)), so the session middleware never runs for it.

The five `/api/wise-activity/**` routes each `await auth()` and return `401 {"error":"Unauthorized"}` when there is no session (e.g. [`route.ts:22-25`](../../../src/app/api/wise-activity/route.ts)). None of those paths are allowlisted, so an unauthenticated browser request is redirected to `/login` first ([`middleware.ts:89-93`](../../../src/middleware.ts)), and a restricted admin (non-null `allowedPages` not covering `/wise-activity`) gets a middleware-level `403 {"error":"Forbidden"}` — `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:36,59-66`](../../../src/middleware.ts), [`middleware.ts:97-99`](../../../src/middleware.ts)). No handler performs any further check: every signed-in full-access admin can trigger a sync.

**No Zod at these boundaries.** Unlike most BGScheduler routes, none of the six uses a Zod schema. Validation is inline:

- Dates are matched against `DATE_RE = /^\d{4}-\d{2}-\d{2}$/` ([`route.ts:7`](../../../src/app/api/wise-activity/route.ts), [`summary/route.ts:7`](../../../src/app/api/wise-activity/summary/route.ts), [`reconciliation/route.ts:6`](../../../src/app/api/wise-activity/reconciliation/route.ts), [`backfill/route.ts:11`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)); the reconciliation read additionally uses `MONTH_RE = /^\d{4}-\d{2}$/` ([`reconciliation/route.ts:7`](../../../src/app/api/wise-activity/reconciliation/route.ts)).
- Numbers are **clamped, never rejected**. `numberParam` / `numberOption` return the fallback for a non-integer and otherwise clamp into `[min, max]` ([`route.ts:9-14`](../../../src/app/api/wise-activity/route.ts), [`sync/route.ts:15-18`](../../../src/app/api/wise-activity/sync/route.ts), [`backfill/route.ts:13-16`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)). An out-of-range `pageSize=9999` therefore yields 100, not a 400.
- Strings are trimmed, and an empty string collapses to `undefined` so the filter is dropped ([`route.ts:16-19`](../../../src/app/api/wise-activity/route.ts)).
- Both POST bodies are parsed in a `try`/`catch` that falls back to `{}` ([`sync/route.ts:30-36`](../../../src/app/api/wise-activity/sync/route.ts), [`backfill/route.ts:24-30`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)), so malformed JSON is not a 400 — the handler proceeds on defaults.

**Bangkok day boundaries.** The two read routes convert an inclusive `YYYY-MM-DD` day range into a UTC instant range via `wiseActivityBangkokRange`, whose end is the last millisecond of the Bangkok end-day ([`data.ts:240-245`](../../../src/lib/wise-activity/data.ts)). Defaults are "the last 7 Bangkok days": `todayBangkok()` and `addBangkokDays(defaultEnd, -6)` ([`route.ts:28-31`](../../../src/app/api/wise-activity/route.ts), [`summary/route.ts:21-24`](../../../src/app/api/wise-activity/summary/route.ts)). Because the fallback is `??`, a present-but-empty `?startDate=` is **not** replaced by the default — it fails `DATE_RE` and yields 400.

**Institute id.** All three ingest paths resolve the Wise institute as `process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413"` — the fallback constant is duplicated in each file ([`internal/sync-wise-activity/route.ts:10,23`](../../../src/app/api/internal/sync-wise-activity/route.ts), [`sync/route.ts:9,42`](../../../src/app/api/wise-activity/sync/route.ts), [`backfill/route.ts:10,41`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)).

**No caching.** None of the six handlers declares `"use cache"`, `revalidate`, or `dynamic`; every request reads Postgres (and, for reconciliation, Wise) directly. The three ingest routes each set `export const maxDuration = 800` ([`internal/sync-wise-activity/route.ts:8`](../../../src/app/api/internal/sync-wise-activity/route.ts), [`sync/route.ts:7`](../../../src/app/api/wise-activity/sync/route.ts), [`backfill/route.ts:8`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)); the three read routes set no `maxDuration`.

**Error envelope.** Every failure is `{"error": string}`. Handlers wrap their work in `try`/`catch` and map `err instanceof Error ? err.message : "<fallback>"` to **500**; the three ingest routes additionally map `WiseActivitySyncAlreadyRunningError` to **409** before the generic branch.

**Route tests.** [`src/app/api/wise-activity/__tests__/route.test.ts`](../../../src/app/api/wise-activity/__tests__/route.test.ts) covers all five admin routes (auth, filter pass-through, date validation, the event-name allowlist, and the backfill 409); [`src/app/api/internal/sync-wise-activity/__tests__/route.test.ts:42,58`](../../../src/app/api/internal/sync-wise-activity/__tests__/route.test.ts) covers the cron route's success and missing-secret cases.

---

## The shared ingest engine

Three of the six endpoints are thin wrappers over one function — `syncWiseActivityEvents(db, client, instituteId, options)` ([`sync.ts:152-291`](../../../src/lib/wise-activity/sync.ts)). Its option set, side effects and failure modes are identical whichever route calls it, so they are documented once here and referenced from each endpoint.

**Options** ([`sync.ts:17-35`](../../../src/lib/wise-activity/sync.ts)):

| Option | Default | Effect |
|--------|---------|--------|
| `triggerType` | `"cron"` ([`sync.ts:159`](../../../src/lib/wise-activity/sync.ts)) | Written to `wise_activity_sync_runs.trigger_type`; also selects the `lookbackDays` / `maxPages` defaults. |
| `lookbackDays` | 3 for `cron`, 30 for `manual` ([`sync.ts:9,11,160`](../../../src/lib/wise-activity/sync.ts)) | Sets the `cutoff` instant; the crawl stops once the oldest event seen reaches it ([`sync.ts:165,238-241`](../../../src/lib/wise-activity/sync.ts)). |
| `maxPages` | 20 for `cron`, 500 for `manual` ([`sync.ts:10,12,161`](../../../src/lib/wise-activity/sync.ts)) | Hard page ceiling; the loop runs `startPage … startPage + maxPages - 1` ([`sync.ts:194-195`](../../../src/lib/wise-activity/sync.ts)). |
| `eventName` | none | Server-side Wise filter; a targeted crawl reaches far deeper per page than the unfiltered feed ([`sync.ts:21-25,164`](../../../src/lib/wise-activity/sync.ts)). |
| `startPage` | 1 ([`sync.ts:162`](../../../src/lib/wise-activity/sync.ts)) | Lets a deep backfill resume mid-history. |
| `stopOnKnownEvents` | `true` ([`sync.ts:163`](../../../src/lib/wise-activity/sync.ts)) | Stop once a full page inserts nothing. Correct for the incremental cron; a deep crawl must pass `false` or it halts on page one ([`sync.ts:28-33,242-245`](../../../src/lib/wise-activity/sync.ts)). |
| `now` | `new Date()` | Test seam. |

**Crawl.** Pages are pulled at a fixed `PAGE_SIZE = 50` ([`sync.ts:8`](../../../src/lib/wise-activity/sync.ts)) through `fetchWiseActivityEvents`, a `GET /institutes/{instituteId}/events` with `page_number` / `page_size` (itself capped at 50) and an optional `eventName` ([`fetchers.ts:498-517`](../../../src/lib/wise/fetchers.ts)). Each raw envelope is flattened by `normalizeWiseActivityEvent`, which **drops** any event missing `eventId` or a parseable `eventTimestamp` and defaults an absent type/name to `"unknown"` / `"UnknownEvent"` ([`sync.ts:90-128`](../../../src/lib/wise-activity/sync.ts)).

**Side effects** (all Postgres; nothing is ever written to Wise):

1. Any `running` row older than 20 minutes is force-failed with the message `Wise activity sync marked failed because it was still running after 20 minutes.` ([`sync.ts:13,130-142`](../../../src/lib/wise-activity/sync.ts)).
2. A `wise_activity_sync_runs` row is inserted with `status = "running"` and the resolved options in `metadata` ([`sync.ts:171-179`](../../../src/lib/wise-activity/sync.ts)). The partial unique index `wise_activity_sync_runs_single_running_idx` ([`schema.ts:567-569`](../../../src/lib/db/schema.ts)) makes this the single-flight guard: a `23505` violation is rethrown as `WiseActivitySyncAlreadyRunningError` ([`sync.ts:58-67,181-184`](../../../src/lib/wise-activity/sync.ts)), which every route maps to **409** with the message `Wise activity sync is already running` ([`sync.ts:51-56`](../../../src/lib/wise-activity/sync.ts)).
3. Normalized rows are appended with `onConflictDoNothing({ target: eventId })`, so the store is **append-only and idempotent** — a re-crawl of known events inserts nothing and the `RETURNING` count doubles as the "page fully known" signal ([`sync.ts:222-232`](../../../src/lib/wise-activity/sync.ts), unique index at [`schema.ts:543`](../../../src/lib/db/schema.ts)). Existing rows are never updated.
4. On success the run row is updated to `status = "success"` with page/event/insert counts, the oldest and newest event timestamps, and `metadata.stoppedReason` ([`sync.ts:248-260`](../../../src/lib/wise-activity/sync.ts)). On failure it is updated to `status = "failed"` with `errorSummary`, and the error is rethrown to the route ([`sync.ts:273-289`](../../../src/lib/wise-activity/sync.ts)).

**`stoppedReason`** is one of `max_pages` (the loop ran out, the initial value — [`sync.ts:191`](../../../src/lib/wise-activity/sync.ts)), `empty_page` ([`:204-206`](../../../src/lib/wise-activity/sync.ts)), `short_page` (fewer than 50 events returned — [`:234-237`](../../../src/lib/wise-activity/sync.ts)), `lookback_reached` ([`:238-241`](../../../src/lib/wise-activity/sync.ts)), or `known_events` ([`:242-245`](../../../src/lib/wise-activity/sync.ts)).

**`WiseActivitySyncResult`** ([`sync.ts:37-47`](../../../src/lib/wise-activity/sync.ts)) — returned verbatim as `result` by all three ingest routes:

| Field | Type | Meaning |
|-------|------|---------|
| `syncRunId` | string (uuid) | The `wise_activity_sync_runs` row id. |
| `status` | `"success"` | Literal; a failed run throws instead of returning. |
| `triggerType` | `"cron" \| "manual"` | As resolved above. |
| `pagesFetched` | number | Wise pages requested. |
| `eventsFetched` | number | Events returned by Wise (before normalization drops). |
| `insertedCount` | number | Rows actually inserted (new events only). |
| `oldestEventTimestamp` | ISO string \| null | Oldest normalized event seen this run. |
| `newestEventTimestamp` | ISO string \| null | Newest normalized event seen this run. |
| `stoppedReason` | string | One of the five values above. |

---

## Reading the audit store

### `GET /api/wise-activity`

Paged, filtered timeline of persisted Wise events. Read-only — no writes. Handler: [`route.ts:21-56`](../../../src/app/api/wise-activity/route.ts).

**Auth:** session required ([`route.ts:22-25`](../../../src/app/api/wise-activity/route.ts)).

**Query parameters** — all optional; every filter is applied by `buildConditions` ([`data.ts:89-130`](../../../src/lib/wise-activity/data.ts)):

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `startDate` | `YYYY-MM-DD` | today − 6 days (Bangkok) | Inclusive lower bound on `event_timestamp`. |
| `endDate` | `YYYY-MM-DD` | today (Bangkok) | Inclusive through the last millisecond of that Bangkok day ([`data.ts:240-245`](../../../src/lib/wise-activity/data.ts)). |
| `page` | integer | 1 | Clamped to `[1, 10000]` ([`route.ts:41`](../../../src/app/api/wise-activity/route.ts)); offset is `(page - 1) * pageSize` ([`data.ts:135`](../../../src/lib/wise-activity/data.ts)). |
| `pageSize` | integer | 50 | Clamped to `[1, 100]` ([`route.ts:42`](../../../src/app/api/wise-activity/route.ts)). |
| `type` | string | — | Exact match on `event_type` (e.g. `BILLING`, `SESSION`) ([`data.ts:104`](../../../src/lib/wise-activity/data.ts)). |
| `eventName` | string | — | Exact match on `event_name` (e.g. `SessionCancelledEvent`) ([`data.ts:105`](../../../src/lib/wise-activity/data.ts)). |
| `sessionId` | string | — | Exact match on `session_id` ([`data.ts:106`](../../../src/lib/wise-activity/data.ts)). |
| `transactionId` | string | — | Exact match on `transaction_id` ([`data.ts:107`](../../../src/lib/wise-activity/data.ts)). |
| `q` | string | — | `ILIKE %q%` across `actor_name`, `classroom_name`, `classroom_subject`, `event_name`, `session_id`, `transaction_id` ([`data.ts:117-127`](../../../src/lib/wise-activity/data.ts)). |
| `financeOnly` | `"true"` | off | Only the exact string `"true"` enables it ([`route.ts:48`](../../../src/app/api/wise-activity/route.ts)). Matches `event_type = 'BILLING'` **or** a non-null `transaction_id` **or** an `event_name` ILIKE `%invoice%` / `%payment%` / `%payout%` ([`data.ts:108-116`](../../../src/lib/wise-activity/data.ts)). |

**Response 200** ([`data.ts:152-160`](../../../src/lib/wise-activity/data.ts)):

```json
{
  "events": [ /* WiseActivityEventDto[] */ ],
  "pagination": { "page": 1, "pageSize": 50, "total": 0, "pageCount": 0 }
}
```

`events` is ordered by `event_timestamp` **descending** ([`data.ts:146`](../../../src/lib/wise-activity/data.ts)). Each element is a `WiseActivityEventDto` ([`data.ts:33-55`](../../../src/lib/wise-activity/data.ts), mapped at [`data.ts:63-87`](../../../src/lib/wise-activity/data.ts)) — the row's scalar columns with all four timestamps as ISO strings, plus `payload` and `raw`, the untouched Wise objects kept for forensic inspection. `total` comes from a parallel `count(*)` over the same predicate and `pageCount` is `ceil(total / pageSize)` ([`data.ts:137-158`](../../../src/lib/wise-activity/data.ts)); with `total = 0`, `pageCount` is `0`.

**Status codes:** `200` · `400 {"error":"Invalid date range"}` when either date fails `DATE_RE` or `startDate > endDate` ([`route.ts:32-34`](../../../src/app/api/wise-activity/route.ts)) · `401` · `500 {"error": message}` with the fallback `Wise activity query failed` ([`route.ts:52-55`](../../../src/app/api/wise-activity/route.ts)).

### `GET /api/wise-activity/summary`

Dashboard rollups over the **same filter set and the same rows** as `GET /api/wise-activity`, without pagination. Read-only. Handler: [`summary/route.ts:14-48`](../../../src/app/api/wise-activity/summary/route.ts).

**Auth:** session required ([`summary/route.ts:15-18`](../../../src/app/api/wise-activity/summary/route.ts)).

**Query parameters:** `startDate`, `endDate`, `type`, `eventName`, `q`, `sessionId`, `transactionId`, `financeOnly` — identical semantics and defaults to the list route ([`summary/route.ts:20-42`](../../../src/app/api/wise-activity/summary/route.ts)). It takes **no** `page` / `pageSize`: the aggregate loads every matching row ([`data.ts:167-171`](../../../src/lib/wise-activity/data.ts)), so a wide range is the expensive call on this page.

**Response 200** ([`data.ts:221-237`](../../../src/lib/wise-activity/data.ts)):

| Key | Type | Meaning |
|-----|------|---------|
| `cards.totalEvents` | number | Matching rows. |
| `cards.sessionMutationEvents` | number | Rows whose `event_name` is one of `SessionCreatedEvent`, `SessionUpdatedEvent`, `SessionCancelledEvent`, `SessionDeletedEvent` ([`format.ts:3-8,68-70`](../../../src/lib/wise-activity/format.ts)). |
| `cards.financeEvents` | number | Rows matching `isWiseFinanceEvent` — `BILLING`, or a transaction id, or a name matching `invoice\|payment\|payout\|transaction` ([`format.ts:57-66`](../../../src/lib/wise-activity/format.ts)). Note this in-JS predicate is **wider** than the SQL `financeOnly` filter, which omits `%transaction%`. |
| `cards.lastSyncAt` | ISO string \| null | `finishedAt ?? startedAt` of the newest `wise_activity_sync_runs` row — **unfiltered by the date range** ([`data.ts:172-176,226`](../../../src/lib/wise-activity/data.ts)). |
| `cards.lastSyncStatus` | string \| null | That run's status. |
| `cards.lastSyncInsertedCount` | number \| null | That run's insert count. |
| `activityByDate` | array | One entry per Bangkok day in `[startDate, endDate]`, each `{ date, total, ...perEventTypeCounts }`; days with no events are present with `total: 0` ([`data.ts:179-200`](../../../src/lib/wise-activity/data.ts)). |
| `financeTrend` | array | Same day spine, each `{ date, count, amount }` summing `transaction_amount` over finance events ([`data.ts:181,211-217`](../../../src/lib/wise-activity/data.ts)). |
| `eventTypeCounts` | `Record<string, number>` | Count per `event_type`. |
| `eventNameCounts` | `Record<string, number>` | Count per `event_name`. |
| `sessionMutationCounts` | `Record<string, number>` | The four session-mutation names, always present, zero-initialized ([`data.ts:184-189`](../../../src/lib/wise-activity/data.ts)). |
| `topActors` | `[string, number][]` | Top 8 `actor_name` by count, descending ([`data.ts:235`](../../../src/lib/wise-activity/data.ts)). |
| `topClassrooms` | `[string, number][]` | Top 8 `classroom_name` by count, descending ([`data.ts:236`](../../../src/lib/wise-activity/data.ts)). |

**Status codes:** `200` · `400 {"error":"Invalid date range"}` ([`summary/route.ts:25-27`](../../../src/app/api/wise-activity/summary/route.ts)) · `401` · `500` with the fallback `Wise activity summary failed` ([`summary/route.ts:44-47`](../../../src/app/api/wise-activity/summary/route.ts)).

---

## Ingesting events

### `GET /api/internal/sync-wise-activity`

The scheduled incremental crawl. Handler: [`internal/sync-wise-activity/route.ts:12-36`](../../../src/app/api/internal/sync-wise-activity/route.ts).

**Auth:** `CRON_SECRET` bearer only ([`:13-14`](../../../src/app/api/internal/sync-wise-activity/route.ts)); no session is involved.

**Request:** no query parameters and no body are read. The crawl runs with `{ triggerType: "cron" }` and nothing else ([`:20-25`](../../../src/app/api/internal/sync-wise-activity/route.ts)), so the engine defaults apply: `lookbackDays = 3`, `maxPages = 20`, `startPage = 1`, `stopOnKnownEvents = true`, no `eventName`.

**Extra side effect — cron audit.** The whole handler body runs inside `withCronInvocationAudit({ jobKey: "wise_activity", triggerSource: "cron", requestMethod })` ([`:16-18`](../../../src/app/api/internal/sync-wise-activity/route.ts)). That wrapper inserts a `cron_invocations` row with `outcome: "running"` before the handler and updates it afterwards with duration, response status, an `errorSummary`, `linkedRunIds` (it lifts `result.syncRunId`) and a size-capped response digest ([`cron-audit.ts:131-159,161-189,191-206`](../../../src/lib/data-health/cron-audit.ts)). Outcome is derived from the response: a body whose error message contains `already running` is recorded **`skipped`**, not failed, so the 409 below does not raise a Data Health alert ([`cron-audit.ts:108-117`](../../../src/lib/data-health/cron-audit.ts)). An audit-write failure is logged and swallowed ([`cron-audit.ts:156,187`](../../../src/lib/data-health/cron-audit.ts)).

**Response 200:** `{ "ok": true, "result": WiseActivitySyncResult }` ([`:26`](../../../src/app/api/internal/sync-wise-activity/route.ts)).

**Status codes:** `200` · `401 {"error":"Unauthorized"}` (bad or absent bearer) · `409 {"error":"Wise activity sync is already running"}` ([`:28-30`](../../../src/app/api/internal/sync-wise-activity/route.ts)) · `500 {"error":"Server misconfigured"}` when `CRON_SECRET` is unset, or `500 {"error": message}` with the fallback `Wise activity sync failed` ([`:31-32`](../../../src/app/api/internal/sync-wise-activity/route.ts)). The audit wrapper converts an escaping throw into `500 {"error": message}` ([`cron-audit.ts:200-204`](../../../src/lib/data-health/cron-audit.ts)).

This is not the only way an operator can start the same crawl: Data Health's manual job runner calls `syncWiseActivityEvents` directly for `jobKey === "wise_activity"` with `{ triggerType: "manual" }` and the same 409/500 mapping ([`run-job.ts:47-62`](../../../src/lib/data-health/run-job.ts)) — that route is documented in [misc.md](./misc.md), not here.

### `POST /api/wise-activity/sync`

Operator-triggered crawl with tunable depth, including a narrow targeted backfill. Handler: [`sync/route.ts:24-62`](../../../src/app/api/wise-activity/sync/route.ts).

**Auth:** session required ([`sync/route.ts:25-28`](../../../src/app/api/wise-activity/sync/route.ts)).

**Body** — JSON object, all fields optional; a missing or unparseable body degrades to `{}` ([`sync/route.ts:30-36`](../../../src/app/api/wise-activity/sync/route.ts)):

| Field | Type | Default | Clamp / allowlist |
|-------|------|---------|-------------------|
| `lookbackDays` | integer | 30 | `[1, 400]` ([`sync/route.ts:45`](../../../src/app/api/wise-activity/sync/route.ts)) |
| `maxPages` | integer | 500 | `[1, 1000]` ([`sync/route.ts:46`](../../../src/app/api/wise-activity/sync/route.ts)) |
| `eventName` | string | none | **Allowlisted.** Only `SessionFeedbackSubmittedEvent` is accepted; anything else is silently dropped to `undefined` so an arbitrary caller cannot steer the crawl at an unbounded feed ([`sync/route.ts:11-13,20-22,47`](../../../src/app/api/wise-activity/sync/route.ts)). |
| `startPage` | integer | 1 | `[1, 5000]` ([`sync/route.ts:48`](../../../src/app/api/wise-activity/sync/route.ts)) |
| `stopOnKnownEvents` | boolean | `true` | Computed as `input.stopOnKnownEvents !== false`, so only an explicit `false` disables the early stop — required for a deep re-crawl, which would otherwise halt on page one ([`sync/route.ts:49-51`](../../../src/app/api/wise-activity/sync/route.ts)). |

Note the trigger is always `"manual"` ([`sync/route.ts:43`](../../../src/app/api/wise-activity/sync/route.ts)), and every numeric field is passed explicitly, so the engine's `cron` defaults never apply here. A rejected `eventName` produces an **unfiltered** crawl rather than an error; the test pins both the accepted and the rejected case ([`route.test.ts:166`](../../../src/app/api/wise-activity/__tests__/route.test.ts)).

**Side effects:** exactly those of the shared engine — no cron-audit row, since this route is not wrapped.

**Response 200:** `{ "ok": true, "result": WiseActivitySyncResult }` ([`sync/route.ts:54`](../../../src/app/api/wise-activity/sync/route.ts)).

**Status codes:** `200` · `401` · `409 {"error":"Wise activity sync is already running"}` ([`sync/route.ts:56-58`](../../../src/app/api/wise-activity/sync/route.ts)) · `500` with the fallback `Wise activity sync failed` ([`sync/route.ts:59-60`](../../../src/app/api/wise-activity/sync/route.ts)). There is **no 400**: bad input is clamped or dropped.

The workspace's "sync" button posts `{ lookbackDays: 30, maxPages: 500 }` and reloads the list on success ([`wise-activity-workspace.tsx:695-701`](../../../src/components/wise-activity/wise-activity-workspace.tsx)).

---

## Package-sales reconciliation

### `GET /api/wise-activity/reconciliation`

Cross-checks Sales Dashboard package-sale rows against the persisted Wise event store and live Wise money data, and returns candidate evidence per row. Read-only in Postgres, and read-only toward Wise. Handler: [`reconciliation/route.ts:20-51`](../../../src/app/api/wise-activity/reconciliation/route.ts).

**Auth:** session required ([`reconciliation/route.ts:21-24`](../../../src/app/api/wise-activity/reconciliation/route.ts)).

**Query parameters** — all optional ([`reconciliation/route.ts:26-37`](../../../src/app/api/wise-activity/reconciliation/route.ts)):

| Param | Type | Notes |
|-------|------|-------|
| `sourceId` | string | Selects a Sales Dashboard source by id; wins over `month` ([`reconciliation.ts:757-764`](../../../src/lib/wise-activity/reconciliation.ts)). |
| `month` | `YYYY-MM` | Selects the source whose `sourceMonth` starts with that month. Must match `MONTH_RE` or the request is a 400. |
| `startDate` | `YYYY-MM-DD` | Payment-date window lower bound. **Must be paired with `endDate`** — one without the other is a 400 ([`reconciliation/route.ts:14-18`](../../../src/app/api/wise-activity/reconciliation/route.ts)). |
| `endDate` | `YYYY-MM-DD` | Upper bound; `startDate <= endDate` is enforced. |

With neither `sourceId` nor `month`, the first source carrying a successful package-sales import is chosen, else the first source, else none ([`reconciliation.ts:757-764`](../../../src/lib/wise-activity/reconciliation.ts)). With no date window, the range defaults to the min/max payment date across that source's rows, falling back to the source month's first and last Bangkok day ([`reconciliation.ts:697-709,855-856`](../../../src/lib/wise-activity/reconciliation.ts)).

**What the handler reads** ([`reconciliation.ts:821-921`](../../../src/lib/wise-activity/reconciliation.ts)): the Sales Dashboard sources and the normal rows of the selected source's last successful import run; `wise_activity_events` inside the Bangkok window narrowed to money-ish rows (`BILLING`, or a transaction id, or a name ILIKE `%invoice%` / `%payment%` / `%transaction%`) with `%payout%` names explicitly excluded ([`:863-879`](../../../src/lib/wise-activity/reconciliation.ts)); the active credit-control snapshot's packages, for student/parent naming; and **two live Wise GETs** — the fees-paid trend and the receipt transactions for the window. Both live calls are individually fault-tolerant: a missing `WISE_USER_ID` / `WISE_API_KEY` or a thrown fetch is captured as an `error` string and surfaced in the payload rather than failing the request ([`reconciliation.ts:766-819`](../../../src/lib/wise-activity/reconciliation.ts)).

**Response 200** — a `WisePackageSalesReconciliation` object, returned bare ([`reconciliation.ts:158-178`](../../../src/lib/wise-activity/reconciliation.ts)):

| Key | Type | Meaning |
|-----|------|---------|
| `sources` | `ReconciliationSourceSummary[]` | Every Sales Dashboard source: `{ id, sourceMonth, label, status, lastImportedAt, lastNormalRowCount }` ([`:19-26`](../../../src/lib/wise-activity/reconciliation.ts)). |
| `selectedSource` | same \| null | The resolved source; `null` when none exists. |
| `dateRange` | `{ startDate, endDate }` | The window actually used, after defaulting. |
| `coverage` | object | Whether the persisted event store actually spans the requested window: `status` (`complete` / `partial` / `empty`), the required bounds, first/last inbound event instant and date, `inboundEventCount`, and a human `message` ([`:123-133`](../../../src/lib/wise-activity/reconciliation.ts)). |
| `summary` | object | `saleRows`, `students`, `sheetTotal`, `rowsWithCandidates`, `rowsNeedingReview`, `candidateCount`, `wiseInboundEvents`, `wiseReceipts` ([`:167-175`](../../../src/lib/wise-activity/reconciliation.ts)). |
| `revenueVariance` | object | Three-way variance — sheet package-sales total vs the Wise fees-paid trend vs Wise receipts — carrying `wiseRevenueAvailable` / `wiseReceiptsAvailable` flags and the captured `*UnavailableReason` strings from the live calls ([`:135-156`](../../../src/lib/wise-activity/reconciliation.ts)). Currency is the literal `"THB"`. |
| `students` | `ReconciliationStudentGroup[]` | Sale rows grouped by `studentKey`, each group carrying its rows; every row carries `reviewFlags` and scored `candidates` (`source: "wise_receipt"`, `score`, `confidence` of `high`/`medium`/`low`, and `reasons[]`) ([`:71-121`](../../../src/lib/wise-activity/reconciliation.ts)). |

Nothing is persisted: no match is stamped onto a sale row, and the response is advisory. The scoring rules and flag taxonomy live in [docs/features/wise-activity-audit.md](../../features/wise-activity-audit.md).

**Status codes:** `200` · `400 {"error":"Invalid month"}` ([`reconciliation/route.ts:32-34`](../../../src/app/api/wise-activity/reconciliation/route.ts)) · `400 {"error":"Invalid date range"}` when only one date is given, either fails `DATE_RE`, or `startDate > endDate` ([`reconciliation/route.ts:35-37`](../../../src/app/api/wise-activity/reconciliation/route.ts)) · `401` · `500` with the fallback `Wise reconciliation query failed` ([`reconciliation/route.ts:47-50`](../../../src/app/api/wise-activity/reconciliation/route.ts)). Two library conditions surface as **500**, not 400: a selected source with no successful package-sales import throws `Selected Sales Dashboard source has no successful package-sales import.` ([`reconciliation.ts:843-845`](../../../src/lib/wise-activity/reconciliation.ts)), and the library's own `validateDateRange` throws `Invalid date range` on a defaulted range that fails the same regex ([`reconciliation.ts:691-695,857`](../../../src/lib/wise-activity/reconciliation.ts)).

### `POST /api/wise-activity/reconciliation/backfill`

Deepens the event store far enough back to cover a reconciliation window, then leaves the caller to re-read the reconciliation. Handler: [`reconciliation/backfill/route.ts:18-56`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts).

**Auth:** session required ([`backfill/route.ts:19-22`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)).

**Body** — JSON; an unparseable body degrades to `{}` and then fails the date check ([`backfill/route.ts:24-35`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `startDate` | `YYYY-MM-DD` | **yes** | Must match `DATE_RE`; converted to a day count, not passed through as a date. |
| `endDate` | `YYYY-MM-DD` | **yes** | Must match `DATE_RE` and satisfy `startDate <= endDate`. Beyond that check it is **not used** — the crawl depth is derived from `startDate` alone. |
| `maxPages` | integer | no | Default 1000, clamped to `[1, 1000]` ([`backfill/route.ts:45`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)). |

`lookbackDays` is computed, not supplied: `wiseReconciliationBackfillLookbackDays(startDate)` is the whole-day distance from `startDate` to today in Bangkok, plus one, clamped to `[1, 365]` ([`reconciliation.ts:1013-1019`](../../../src/lib/wise-activity/reconciliation.ts)). A `startDate` more than 365 days old therefore silently backfills only 365 days.

**Side effects:** the shared engine with `{ triggerType: "manual", lookbackDays, maxPages }` ([`backfill/route.ts:38-47`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)). `stopOnKnownEvents` is **not** passed, so it defaults to `true` ([`sync.ts:163`](../../../src/lib/wise-activity/sync.ts)) — a re-run over an already-ingested window stops at the first fully known page. No cron-audit row is written.

**Response 200:** `{ "ok": true, "result": WiseActivitySyncResult }` ([`backfill/route.ts:48`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)).

**Status codes:** `200` · `400 {"error":"Invalid date range"}` for a missing, malformed, or inverted pair ([`backfill/route.ts:33-35`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)) · `401` · `409 {"error":"Wise activity sync is already running"}` ([`backfill/route.ts:50-52`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts), pinned by [`route.test.ts:252`](../../../src/app/api/wise-activity/__tests__/route.test.ts)) · `500` with the fallback `Wise reconciliation backfill failed` ([`backfill/route.ts:53-54`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)).

The workspace posts the reconciliation's own `dateRange` plus `maxPages: 1000`, then reloads the reconciliation ([`wise-activity-workspace.tsx:714-724`](../../../src/components/wise-activity/wise-activity-workspace.tsx)).

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
