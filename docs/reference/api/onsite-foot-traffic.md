# Onsite Foot Traffic API

Mechanical reference for the five authenticated workspace endpoints under `/api/onsite-foot-traffic` and the one cron endpoint that populates them. Feature meaning and counting policy live in [features/onsite-foot-traffic.md](../../features/onsite-foot-traffic.md).

## Shared authentication and filters

All five workspace endpoints require an Auth.js session with `user.email`; absence returns `401 { "error": "Unauthorized" }`. Middleware additionally enforces page scope: restricted admins need `/onsite-foot-traffic` in `allowedPages`. Responses use `Cache-Control: no-store` (downloads use `private, no-store`).

Dashboard and export filters:

| Parameter | Shape | Default / behavior |
|---|---|---|
| `startDate` | `YYYY-MM-DD` | `2026-03-01` |
| `endDate` | `YYYY-MM-DD` | `2026-09-30`; effective results are capped to successful coverage and the latest completed Bangkok day |
| `room` or `rooms` | repeatable or comma-separated room names | all active physical rooms; an unknown room returns 400 |
| `weekday` or `weekdays` | repeatable or comma-separated integers `0`–`6` | all weekdays; `0` is Sunday, while output is Monday-first |

The inclusive requested range must be ordered and at most 366 days. Invalid dates, weekdays, or rooms return `400 { error }`.

## `GET /api/onsite-foot-traffic`

Returns `FootTrafficDashboardPayload`:

```ts
{
  meta: {
    requestedStartDate: string; requestedEndDate: string;
    effectiveStartDate: string; effectiveEndDate: string;
    coverageStartDate: string | null; coverageEndDate: string | null;
    latestCompletedDate: string; dataAsOf: string | null;
    lastSuccessfulSyncAt: string | null; sourceSyncRunId: string | null;
    timeZone: "Asia/Bangkok"; source: "Wise PAST sessions";
    isEndDateCapped: boolean; isSeptemberMonthToDate: boolean;
    rooms: string[]; weekdays: number[]; availableRooms: string[];
  };
  summary: MetricSummary;
  weekly: PeriodRow[];
  monthly: PeriodRow[];
  byWeekday: BreakdownRow[];
  byRoom: BreakdownRow[];
  dataQuality: DataQuality;
}
```

`MetricSummary` is `{ studentVisits, uniqueStudents, onsiteClasses, averageVisitsPerClass, unidentifiedVisits }`. A `PeriodRow` adds `key`, `label`, `periodStart`, `periodEnd`, and `isPartial`; a `BreakdownRow` adds `key` and `label`. The quality object exposes total/countable/excluded PAST sessions and each documented exclusion category. Successful responses are `200`; unexpected database failures are `500 { error }`.

The response remains uncached and includes a `Server-Timing` header with `auth`, `metadata`, `database`, `aggregate`, and `total` durations. The initial dashboard page uses the same aggregate reader during server rendering, while this endpoint remains available for authenticated API consumers.

## `GET /api/onsite-foot-traffic/export`

Adds required query parameter `grain=weekly|monthly|weekday|room|visits` to the shared filters. Missing or unknown grain returns 400. Success is `200 text/csv;charset=utf-8` with `Content-Disposition: attachment`, a UTF-8 BOM, every field quoted, and CRLF rows.

- aggregate grains contain period or grouping keys, boundaries where applicable, partial flags, visits, unique students, onsite classes, visits/class, `data_as_of`, and `last_successful_sync_at`;
- `visits` contains attendance date/time, week start, month, pseudonymous fingerprint, Wise session ID, room, subject, tutor, and consumed credit. The fingerprint is blank for unidentified visits. No student name or raw student ID is emitted.

Aggregate grains use only the aggregate reader. The detail join and CSV-row transformation run exclusively for `grain=visits`. Successful export responses include the aggregate timing phases in `Server-Timing`; visit exports additionally include `visit-database` and `visit-transform`.

## `POST /api/onsite-foot-traffic/reports`

Accepts either a `FootTrafficFilters` body or `{ "filters": FootTrafficFilters }`; omitted fields use the shared defaults. Invalid JSON or filters return 400. On success, inserts one immutable aggregate snapshot and returns `201`:

```json
{
  "reportId": "uuid",
  "createdAt": "ISO-8601",
  "expiresAt": "ISO-8601",
  "htmlUrl": "/api/onsite-foot-traffic/reports/{id}/html",
  "pdfUrl": "/api/onsite-foot-traffic/reports/{id}/pdf"
}
```

The snapshot expires 30 days after creation. Both render endpoints read only this stored payload.

## `GET /api/onsite-foot-traffic/reports/[reportId]/html`

Returns the stored snapshot as `text/html;charset=utf-8` with attachment filename `begifted-foot-traffic-{effectiveStartDate}-to-{effectiveEndDate}.html`. The document is self-contained: logo, Cormorant/Sarabun font files, CSS, JSON-derived tables, and labelled SVGs are embedded. A missing, invalid, or expired snapshot returns 404; rendering failure returns 500.

## `GET /api/onsite-foot-traffic/reports/[reportId]/pdf`

Renders the same stored HTML snapshot as portrait A4 and returns `application/pdf` with a content length and attachment filename. The route declares `maxDuration = 120`; Chromium dependencies are dynamically imported only inside the request. The renderer closes its browser in `finally` and throws if output exceeds 4.4 MB. Missing/expired snapshots return 404; launch, render, or size failures return 500.

## `GET /api/internal/sync-onsite-foot-traffic`

Middleware-public like all `/api/internal/*` routes, but the handler requires the constant-time `Authorization: Bearer $CRON_SECRET` check. Missing server secret returns 500, bad credentials 401. The route declares `maxDuration = 800` and wraps every authorized call in `cron_invocations` audit under job key `onsite_foot_traffic`.

With no query parameters it calls `runOnsiteFootTrafficSync({ triggerType: "cron" })`:

- first successful history load: `2026-03-01` through the latest completed Bangkok day;
- subsequent loads: the previous 35 completed days;
- already-running: `202` with `skipped: true`;
- success: `200` with window, fetched/stored session counts, visit count, and quality counts;
- failure: `500 { error }`, with prior canonical rows preserved.

An operator holding `CRON_SECRET` may force a repair inside the production function with `mode=backfill` and optional `startDate` / `endDate` query parameters. Date bounds without `mode=backfill` return `400`; an unknown mode also returns `400`. These calls are audited with `triggerSource: "system"` and run with the deployment's non-exportable pseudonym key. The equivalent local CLI is `npm run foot-traffic:backfill -- --start-date=YYYY-MM-DD --end-date=YYYY-MM-DD`.
