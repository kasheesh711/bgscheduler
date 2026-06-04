# Wise Activity API

**Status:** Stable. **Canonical home:** this page owns the mechanical request/response contracts for the six Wise Activity endpoints. Feature meaning — what the audit log and reconciliation workbench are *for*, and why they are independent of the snapshot sync — lives in [`features/wise-activity-audit.md`](../../features/wise-activity-audit.md). The cron ingest endpoint's deep scheduling mechanics also appear in [`reference/crons.md` §4](../crons.md) (this page does not restate them).

The Wise Activity surface is a **read-only audit log** of operational and financial events from the Wise platform, plus a **package-sales reconciliation** view. It maintains its own append-only event store (`wise_activity_events`) and sync-run ledger (`wise_activity_sync_runs`), and never writes back to Wise or participates in tutor-snapshot promotion (see the feature doc).

All six handlers are Next.js App Router route handlers. Each wraps its work in `try/catch` and returns `{ "error": string }` with an appropriate status on failure; the fallback message differs per route (cited below).

## Endpoint index

| # | Method + path | Auth | Handler |
|---|---------------|------|---------|
| 1 | `GET /api/wise-activity/summary` | Auth.js session | [`summary/route.ts:14`](../../../src/app/api/wise-activity/summary/route.ts) |
| 2 | `GET /api/wise-activity` | Auth.js session | [`route.ts:21`](../../../src/app/api/wise-activity/route.ts) |
| 3 | `GET /api/wise-activity/reconciliation` | Auth.js session | [`reconciliation/route.ts:20`](../../../src/app/api/wise-activity/reconciliation/route.ts) |
| 4 | `POST /api/wise-activity/sync` | Auth.js session | [`sync/route.ts:16`](../../../src/app/api/wise-activity/sync/route.ts) |
| 5 | `POST /api/wise-activity/reconciliation/backfill` | Auth.js session | [`reconciliation/backfill/route.ts:18`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts) |
| 6 | `GET /api/internal/sync-wise-activity` | `CRON_SECRET` bearer | [`sync-wise-activity/route.ts:11`](../../../src/app/api/internal/sync-wise-activity/route.ts) |

### Authentication model

Two distinct gates apply, set by [`middleware.ts:4-15`](../../../src/middleware.ts):

- **Endpoints 1–5** live under `/api/wise-activity/` — **not** a public prefix, so the middleware redirects unauthenticated browser requests to `/login`. Each handler additionally calls `await auth()` and returns **HTTP 401 `{ "error": "Unauthorized" }`** if there is no session (e.g. [`summary/route.ts:15-18`](../../../src/app/api/wise-activity/summary/route.ts)). There is **no** `CRON_SECRET` path and **no** machine-token path on these five — they are admin-session only.
- **Endpoint 6** lives under `/api/internal/`, which the middleware treats as a **public route** (no session redirect, [`middleware.ts:13`](../../../src/middleware.ts)). It is protected solely by a `CRON_SECRET` bearer check via the shared `rejectInvalidCronSecret` helper ([`sync-wise-activity/route.ts:12-13`](../../../src/app/api/internal/sync-wise-activity/route.ts); [`cron-auth.ts:19-26`](../../../src/lib/internal/cron-auth.ts)).

> **No Zod at these boundaries.** None of the six handlers use a Zod schema. GET query params are parsed and clamped by local helpers (`numberParam`, `stringParam`) and a `^\d{4}-\d{2}-\d{2}$` date regex; POST bodies are read with a `try/catch` that falls back to `{}` and coerced field-by-field. The exact rules are documented per endpoint below.

### Shared date-range semantics (GET summary + list)

Both read endpoints accept `startDate` / `endDate` as `YYYY-MM-DD` Bangkok dates. When omitted they default to the **last 7 Bangkok days**: `endDate = todayBangkok()`, `startDate = todayBangkok() − 6` ([`summary/route.ts:21-24`](../../../src/app/api/wise-activity/summary/route.ts), [`route.ts:28-31`](../../../src/app/api/wise-activity/route.ts)). Both are validated by the same rule — each must match `^\d{4}-\d{2}-\d{2}$` and `startDate <= endDate`, else **HTTP 400 `{ "error": "Invalid date range" }`** ([`summary/route.ts:25-27`](../../../src/app/api/wise-activity/summary/route.ts), [`route.ts:32-34`](../../../src/app/api/wise-activity/route.ts)).

The two date strings are converted to a half-open-then-inclusive UTC instant window by `wiseActivityBangkokRange(startDate, endDate)`: `start = bangkokDateStartUtc(startDate)`, `end = bangkokDateStartUtc(endDate + 1 day) − 1 ms` ([`data.ts:240-245`](../../../src/lib/wise-activity/data.ts)). All filtering is then a `BETWEEN start AND end` on `wise_activity_events.eventTimestamp` ([`data.ts:99-102`](../../../src/lib/wise-activity/data.ts)).

#### Shared filter params

The summary and list endpoints share an identical filter set, applied by `buildConditions` ([`data.ts:89-130`](../../../src/lib/wise-activity/data.ts)):

| Query param | Maps to | Match semantics |
|-------------|---------|-----------------|
| `type` | `eventType` | exact equality on `event_type` |
| `eventName` | `eventName` | exact equality on `event_name` |
| `sessionId` | `sessionId` | exact equality on `session_id` |
| `transactionId` | `transactionId` | exact equality on `transaction_id` |
| `financeOnly=true` | `financeOnly` boolean | `event_type='BILLING'` OR `transaction_id IS NOT NULL` OR `event_name ILIKE '%invoice%'/'%payment%'/'%payout%'` ([`data.ts:108-116`](../../../src/lib/wise-activity/data.ts)) |
| `q` | `query` | case-insensitive `ILIKE '%q%'` across `actor_name`, `classroom_name`, `classroom_subject`, `event_name`, `session_id`, `transaction_id` ([`data.ts:117-127`](../../../src/lib/wise-activity/data.ts)) |

Empty/whitespace-only string params are coerced to `undefined` (ignored) by `stringParam` ([`route.ts:16-19`](../../../src/app/api/wise-activity/route.ts)). `financeOnly` is true only for the exact literal string `"true"` ([`route.ts:48`](../../../src/app/api/wise-activity/route.ts)).

---

## 1. Activity summary — `GET /api/wise-activity/summary`

**Auth:** Auth.js session (401 if absent). **Does:** aggregate KPI cards and chart series over the filtered event window. Read-only.

**Request — query params:** `startDate`, `endDate` (shared date semantics above), plus the shared filter set (`type`, `eventName`, `q`, `sessionId`, `transactionId`, `financeOnly`). No body. Handler at [`summary/route.ts:29-43`](../../../src/app/api/wise-activity/summary/route.ts) forwards them to `getWiseActivitySummary` ([`data.ts:163-238`](../../../src/lib/wise-activity/data.ts)), which loads **all** matching rows (no pagination) plus the single most-recent `wise_activity_sync_runs` row.

**Response (HTTP 200):** JSON shaped by [`data.ts:221-237`](../../../src/lib/wise-activity/data.ts):

| Field | Type | Notes |
|-------|------|-------|
| `cards.totalEvents` | number | count of matched rows |
| `cards.sessionMutationEvents` | number | rows whose `eventName` is one of the four session-mutation events ([`format.ts:3-8`](../../../src/lib/wise-activity/format.ts), [`format.ts:68-70`](../../../src/lib/wise-activity/format.ts)) |
| `cards.financeEvents` | number | rows matching `isWiseFinanceEvent` (BILLING / transactionId / invoice·payment·payout·transaction name regex, [`format.ts:57-66`](../../../src/lib/wise-activity/format.ts)) |
| `cards.lastSyncAt` | string \| null | ISO; `finishedAt ?? startedAt` of the latest sync run ([`data.ts:226`](../../../src/lib/wise-activity/data.ts)) |
| `cards.lastSyncStatus` | string \| null | latest run `status` (`running`/`success`/`failed`) |
| `cards.lastSyncInsertedCount` | number \| null | latest run `insertedCount` |
| `activityByDate` | array | one entry per Bangkok day in range: `{ date, total, [eventType]: count, ... }` ([`data.ts:179-200`](../../../src/lib/wise-activity/data.ts)) |
| `financeTrend` | array | per-day `{ date, count, amount }` summing `transactionAmount` of finance events ([`data.ts:211-217`](../../../src/lib/wise-activity/data.ts)) |
| `eventTypeCounts` | object | `{ [eventType]: count }` |
| `eventNameCounts` | object | `{ [eventName]: count }` |
| `sessionMutationCounts` | object | fixed keys `SessionCreatedEvent`/`SessionUpdatedEvent`/`SessionCancelledEvent`/`SessionDeletedEvent` ([`data.ts:184-189`](../../../src/lib/wise-activity/data.ts)) |
| `topActors` | array of `[name, count]` | top 8 by descending count ([`data.ts:235`](../../../src/lib/wise-activity/data.ts)) |
| `topClassrooms` | array of `[name, count]` | top 8 by descending count ([`data.ts:236`](../../../src/lib/wise-activity/data.ts)) |

**Side effects:** none (two `SELECT`s only).

**Errors:** 401 (no session); 400 `Invalid date range`; 500 `{ "error": <message ?? "Wise activity summary failed"> }` ([`summary/route.ts:44-47`](../../../src/app/api/wise-activity/summary/route.ts)).

---

## 2. Activity event list — `GET /api/wise-activity`

**Auth:** Auth.js session (401 if absent). **Does:** paginated, filtered, newest-first list of persisted activity events. Read-only.

**Request — query params:** shared date semantics + shared filter set, plus pagination:

| Param | Default | Clamp | Source |
|-------|---------|-------|--------|
| `page` | `1` | integer in `[1, 10000]` | [`route.ts:41`](../../../src/app/api/wise-activity/route.ts) via `numberParam` ([`route.ts:9-14`](../../../src/app/api/wise-activity/route.ts)) |
| `pageSize` | `50` | integer in `[1, 100]` | [`route.ts:42`](../../../src/app/api/wise-activity/route.ts) |

Non-integer values fall back to the default; out-of-range values are clamped (`Math.min(max, Math.max(min, …))`). No body.

**Response (HTTP 200):** JSON from `listWiseActivityEvents` ([`data.ts:132-161`](../../../src/lib/wise-activity/data.ts)):

```jsonc
{
  "events": [ /* WiseActivityEventDto, ordered by eventTimestamp DESC */ ],
  "pagination": { "page": <n>, "pageSize": <n>, "total": <n>, "pageCount": <ceil(total/pageSize)> }
}
```

`total` is a `COUNT(*)` over the same `WHERE` clause; rows are `LIMIT pageSize OFFSET (page-1)*pageSize` ([`data.ts:135-159`](../../../src/lib/wise-activity/data.ts)).

Each `events[]` element is a **`WiseActivityEventDto`** ([`data.ts:33-55`](../../../src/lib/wise-activity/data.ts), serialized by `toWiseActivityEventDto` [`data.ts:63-87`](../../../src/lib/wise-activity/data.ts)):

| Field | Type | Field | Type |
|-------|------|-------|------|
| `id` | string (PK) | `sessionId` | string \| null |
| `eventId` | string (Wise event id) | `sessionStartTime` | string \| null (ISO) |
| `eventType` | string | `sessionEndTime` | string \| null (ISO) |
| `eventName` | string | `transactionId` | string \| null |
| `eventTimestamp` | string (ISO) | `transactionType` | string \| null |
| `actorWiseUserId` | string \| null | `transactionStatus` | string \| null |
| `actorName` | string \| null | `transactionAmount` | number \| null |
| `actorRole` | string \| null | `transactionCurrency` | string \| null |
| `classroomId` | string \| null | `payload` | object (extracted Wise `event.payload`) |
| `classroomName` | string \| null | `raw` | object (full raw event envelope) |
| `classroomSubject` | string \| null | | |

(Column-level detail for the backing `wise_activity_events` table lives in `src/lib/db/schema.ts:190-224` — not restated here.)

**Side effects:** none (count + page `SELECT`, run in parallel).

**Errors:** 401; 400 `Invalid date range`; 500 `{ "error": <message ?? "Wise activity query failed"> }` ([`route.ts:52-54`](../../../src/app/api/wise-activity/route.ts)).

---

## 3. Package-sales reconciliation — `GET /api/wise-activity/reconciliation`

**Auth:** Auth.js session (401 if absent). **Does:** cross-check the active Sales Dashboard source's package-sale rows against Wise receipt transactions and a sheet-vs-Wise revenue variance. Read-only. (Meaning, scoring rationale, and review-only guarantee: see the [feature doc](../../features/wise-activity-audit.md).)

**Request — query params** (all optional; parsed via `stringParam`, [`reconciliation/route.ts:27-30`](../../../src/app/api/wise-activity/reconciliation/route.ts)):

| Param | Format | Purpose |
|-------|--------|---------|
| `sourceId` | string | select a specific Sales Dashboard source by id ([`reconciliation.ts:720`](../../../src/lib/wise-activity/reconciliation.ts)) |
| `month` | `YYYY-MM` (`^\d{4}-\d{2}$`) | select the source whose `sourceMonth` matches; invalid format → 400 `Invalid month` ([`reconciliation/route.ts:32-34`](../../../src/app/api/wise-activity/reconciliation/route.ts)) |
| `startDate` | `YYYY-MM-DD` | range lower bound (defaults from sale-row payment dates if omitted) |
| `endDate` | `YYYY-MM-DD` | range upper bound |

Date-range validation here differs from the read endpoints: **both or neither** of `startDate`/`endDate` must be supplied — providing exactly one, a malformed value, or `startDate > endDate` returns **HTTP 400 `{ "error": "Invalid date range" }`** ([`validateDateRange` reconciliation/route.ts:14-18, :35-37](../../../src/app/api/wise-activity/reconciliation/route.ts)). When omitted, the service derives the range from the selected source's normalized rows ([`reconciliation.ts:656-668, :813-816`](../../../src/lib/wise-activity/reconciliation.ts)).

**What it reads** (`getWisePackageSalesReconciliation`, [`reconciliation.ts:780-880`](../../../src/lib/wise-activity/reconciliation.ts)): the non-archived Sales Dashboard sources; the selected source's normalized package-sale rows; date-windowed inbound Wise invoice/payment events from `wise_activity_events` (BILLING / transactionId / invoice·payment·transaction name, excluding `%payout%`, [`reconciliation.ts:829-836`](../../../src/lib/wise-activity/reconciliation.ts)); the active Credit Control snapshot's packages; and — **via live Wise API calls** — `fetchWiseFeesPaidTrends` and `fetchWiseReceiptTransactions` ([`reconciliation.ts:846-849`](../../../src/lib/wise-activity/reconciliation.ts)). If `WISE_USER_ID`/`WISE_API_KEY` are unset, or a Wise call throws, the corresponding block degrades gracefully to an `error` string and `*Available: false` flags rather than failing the request ([`reconciliation.ts:725-778`](../../../src/lib/wise-activity/reconciliation.ts)).

**Response (HTTP 200):** a `WisePackageSalesReconciliation` object ([`reconciliation.ts:158-178`](../../../src/lib/wise-activity/reconciliation.ts)). Top-level keys:

| Field | Type | Notes |
|-------|------|-------|
| `sources` | `ReconciliationSourceSummary[]` | non-archived sources ([`reconciliation.ts:19-26`](../../../src/lib/wise-activity/reconciliation.ts)) |
| `selectedSource` | `ReconciliationSourceSummary \| null` | resolved by `sourceId` → `month` → most-recent-successful fallback ([`reconciliation.ts:716-723`](../../../src/lib/wise-activity/reconciliation.ts)) |
| `dateRange` | `{ startDate, endDate }` | effective range used |
| `coverage` | `ReconciliationCoverage` | `status: "complete"\|"partial"\|"empty"` for whether persisted inbound events span the range ([`reconciliation.ts:123-133, :437-462`](../../../src/lib/wise-activity/reconciliation.ts)) |
| `summary` | object | `saleRows`, `students`, `sheetTotal`, `rowsWithCandidates`, `rowsNeedingReview`, `candidateCount`, `wiseInboundEvents`, `wiseReceipts` ([`reconciliation.ts:626-635`](../../../src/lib/wise-activity/reconciliation.ts)) |
| `revenueVariance` | `ReconciliationRevenueVariance` | sheet vs Wise fees-paid trend vs receipts, in `THB` ([`reconciliation.ts:135-156`](../../../src/lib/wise-activity/reconciliation.ts)) |
| `students` | `ReconciliationStudentGroup[]` | per-student groups, each containing `ReconciliationSaleRow[]` with ranked `candidates` ([`reconciliation.ts:113-121, :95-111, :71-93`](../../../src/lib/wise-activity/reconciliation.ts)) |

> **Empty-state shortcut:** if no source can be selected, the endpoint returns a fully-formed but empty reconciliation (empty arrays, today's date as the range) rather than an error ([`reconciliation.ts:791-801`](../../../src/lib/wise-activity/reconciliation.ts)).

**Side effects:** none persisted. Note it **does** make outbound calls to the Wise API for trends/receipts (read-only on Wise's side).

**Errors:** 401; 400 `Invalid month`; 400 `Invalid date range`; 500 `{ "error": <message ?? "Wise reconciliation query failed"> }` ([`reconciliation/route.ts:47-49`](../../../src/app/api/wise-activity/reconciliation/route.ts)). A selected source with no successful import throws `"Selected Sales Dashboard source has no successful package-sales import."` → surfaced as 500 ([`reconciliation.ts:802-804`](../../../src/lib/wise-activity/reconciliation.ts)).

---

## Sync triggers (manual, session-authenticated)

Both POST endpoints below drive the **same** ingest function `syncWiseActivityEvents(db, client, instituteId, options)` ([`sync.ts:139-275`](../../../src/lib/wise-activity/sync.ts)) with `triggerType: "manual"`. The institute id is `process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413"`. Both declare `export const maxDuration = 800` ([`sync/route.ts:7`](../../../src/app/api/wise-activity/sync/route.ts), [`reconciliation/backfill/route.ts:8`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)).

**Shared single-flight guard:** a partial unique index (`wise_activity_sync_runs_single_running_idx`) lets at most one `running` row exist. A concurrent insert raises a unique violation that is caught and rethrown as `WiseActivitySyncAlreadyRunningError` ([`sync.ts:38-43, :154-168`](../../../src/lib/wise-activity/sync.ts)), which **both** handlers map to **HTTP 409 `{ "error": "Wise activity sync is already running" }`**. Stale `running` rows older than 20 minutes (`STALE_RUNNING_MS`) are reaped at the start of every run ([`sync.ts:13, :117-129, :151`](../../../src/lib/wise-activity/sync.ts)).

**Shared success response (HTTP 200):** `{ "ok": true, "result": WiseActivitySyncResult }`, where `WiseActivitySyncResult` ([`sync.ts:24-34`](../../../src/lib/wise-activity/sync.ts)) is:

| Field | Type | Notes |
|-------|------|-------|
| `syncRunId` | string | the `wise_activity_sync_runs` row id |
| `status` | `"success"` | literal (failures throw before returning) |
| `triggerType` | `"manual"` for both endpoints | |
| `pagesFetched` / `eventsFetched` / `insertedCount` | number | run counters |
| `oldestEventTimestamp` / `newestEventTimestamp` | string \| null (ISO) | span of normalized events seen |
| `stoppedReason` | string | one of `empty_page` / `short_page` / `lookback_reached` / `known_events` / `max_pages` ([`sync.ts:175, :186-229`](../../../src/lib/wise-activity/sync.ts)) |

**Shared side effects:** inserts a `wise_activity_sync_runs` row (`status: "running"`) on start; pages Wise newest-first via `fetchWiseActivityEvents` (`PAGE_SIZE = 50`); normalizes and **idempotently** inserts events with `onConflictDoNothing` on `eventId` ([`sync.ts:209-216`](../../../src/lib/wise-activity/sync.ts)); updates the run row to `success` (or `failed` with `errorSummary` on throw, [`sync.ts:232-273`](../../../src/lib/wise-activity/sync.ts)).

### 4. Manual activity sync — `POST /api/wise-activity/sync`

**Does:** admin-triggered backfill of the activity log over a recent lookback window.

**Request body** (read with a `try/catch` that defaults to `{}`; non-object bodies coerced to `{}`, [`sync/route.ts:22-28`](../../../src/app/api/wise-activity/sync/route.ts)). Both fields optional, each passed through `numberOption` (must be an integer, else fallback; clamped to range):

| Field | Default | Clamp | Maps to |
|-------|---------|-------|---------|
| `lookbackDays` | `30` | `[1, 365]` | how many days back to page before stopping (`lookback_reached`) |
| `maxPages` | `500` | `[1, 1000]` | hard page cap |

(`numberOption` at [`sync/route.ts:11-14`](../../../src/app/api/wise-activity/sync/route.ts); wired at [`sync/route.ts:37-38`](../../../src/app/api/wise-activity/sync/route.ts).)

**Errors:** 401; **409** `Wise activity sync is already running` ([`sync/route.ts:43-45`](../../../src/app/api/wise-activity/sync/route.ts)); 500 `{ "error": <message ?? "Wise activity sync failed"> }` ([`sync/route.ts:46-47`](../../../src/app/api/wise-activity/sync/route.ts)).

### 5. Reconciliation backfill — `POST /api/wise-activity/reconciliation/backfill`

**Does:** the same activity ingest as endpoint 4, but with the lookback **derived from a required start date** so finance staff can pull in enough history to make a reconciliation range's inbound events `complete`.

**Request body** (required date range; same `try/catch`→`{}` parsing):

| Field | Required? | Validation |
|-------|-----------|------------|
| `startDate` | **yes** | string `^\d{4}-\d{2}-\d{2}$` |
| `endDate` | **yes** | string `^\d{4}-\d{2}-\d{2}$`, and `startDate <= endDate` |
| `maxPages` | no | `numberOption`, default `1000`, clamp `[1, 1000]` ([`reconciliation/backfill/route.ts:45`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)) |

If `startDate`/`endDate` are missing or fail the regex, or `startDate > endDate`, the handler returns **HTTP 400 `{ "error": "Invalid date range" }`** ([`reconciliation/backfill/route.ts:31-35`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)).

The lookback is **not** taken from the body directly; it is computed by `wiseReconciliationBackfillLookbackDays(startDate)` = `ceil((todayBangkok − startDate) days) + 1`, clamped to `[1, 365]` ([`reconciliation/backfill/route.ts:44`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts); [`reconciliation.ts:882-888`](../../../src/lib/wise-activity/reconciliation.ts)). `endDate` is validated but does not affect the lookback (the ingest always pages newest-first from "now"). The default `maxPages` is `1000` here (vs `500` for endpoint 4) to accommodate deeper historical pulls.

**Errors:** 401; 400 `Invalid date range`; **409** `Wise activity sync is already running` ([`reconciliation/backfill/route.ts:50-52`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)); 500 `{ "error": <message ?? "Wise reconciliation backfill failed"> }` ([`reconciliation/backfill/route.ts:53-54`](../../../src/app/api/wise-activity/reconciliation/backfill/route.ts)).

---

## 6. Cron activity ingest — `GET /api/internal/sync-wise-activity`

**Auth:** `CRON_SECRET` bearer only (no session). **Schedule:** `5,35 * * * *` per [`vercel.json`](../../../vercel.json). **Does:** the same `syncWiseActivityEvents` ingest as the manual triggers, but with `triggerType: "cron"` and tighter bounds. **Read-only with respect to Wise; never touches snapshot data.**

**Auth check:** `rejectInvalidCronSecret(request)` runs first ([`sync-wise-activity/route.ts:12-13`](../../../src/app/api/internal/sync-wise-activity/route.ts)) — returns **HTTP 401 `{ "error": "Unauthorized" }`** on a bad/absent bearer, or **HTTP 500 `{ "error": "Server misconfigured" }`** when `CRON_SECRET` itself is unset ([`cron-auth.ts:19-26`](../../../src/lib/internal/cron-auth.ts)). The comparison is constant-time with a length pre-check.

**Request:** no query params, no body. Cron-mode bounds are hard-coded in the ingest (not request-driven): `CRON_LOOKBACK_DAYS = 3`, `CRON_MAX_PAGES = 20`, `PAGE_SIZE = 50` ([`sync.ts:8-10, :147-148`](../../../src/lib/wise-activity/sync.ts)).

**Response (HTTP 200):** `{ "ok": true, "result": WiseActivitySyncResult }` — same `WiseActivitySyncResult` shape as the manual triggers, but `result.triggerType === "cron"` ([`sync-wise-activity/route.ts:16-22`](../../../src/app/api/internal/sync-wise-activity/route.ts)).

**Side effects:** identical to the manual triggers (sync-run ledger row + idempotent `wise_activity_events` inserts), bounded to the 3-day / 20-page cron window.

**Errors:** 401 / 500 (auth, above); **409** `Wise activity sync is already running` ([`sync-wise-activity/route.ts:24-26`](../../../src/app/api/internal/sync-wise-activity/route.ts)); 500 `{ "error": <message ?? "Wise activity sync failed"> }` ([`sync-wise-activity/route.ts:27-28`](../../../src/app/api/internal/sync-wise-activity/route.ts)).

> The scheduling, stagger, and stop-condition mechanics for this cron are covered in depth in [`reference/crons.md` §4](../crons.md) and are not duplicated here.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
