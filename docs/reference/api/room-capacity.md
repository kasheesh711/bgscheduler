# Room Capacity API

**Status:** Stable. This page is the mechanical reference for the four Room Capacity HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. Feature meaning — what the room-capacity workspace is for, the forecast model, and the data-quality rules — lives in [`docs/features/room-capacity.md`](../../features/room-capacity.md). Cron context for the internal sync lives in [`docs/reference/crons.md`](../crons.md).

All four endpoints are App Router route handlers under `src/app/api/`. None of them use Zod — the three read endpoints parse query parameters by hand and delegate validation to the service layer; the write endpoint takes no request body.

## Endpoint summary

| Method + path | Handler | Auth | Side effects |
|---------------|---------|------|--------------|
| `GET /api/room-capacity/utilization` | [`utilization/route.ts:6`](../../../src/app/api/room-capacity/utilization/route.ts) | Auth.js session | none (read-only) |
| `GET /api/room-capacity/month` | [`month/route.ts:6`](../../../src/app/api/room-capacity/month/route.ts) | Auth.js session | none (read-only) |
| `GET /api/room-capacity/forecast` | [`forecast/route.ts:43`](../../../src/app/api/room-capacity/forecast/route.ts) | Auth.js session | none (read-only) |
| `POST /api/internal/sync-room-utilization` | [`sync-room-utilization/route.ts:25`](../../../src/app/api/internal/sync-room-utilization/route.ts) | `CRON_SECRET` bearer **or** Auth.js session | writes `room_utilization_sessions` (upsert) |

> **Auth boundary note.** The three `GET /api/room-capacity/*` routes sit behind the session gate enforced two ways: the route handler's own `auth()` check returns 401 when there is no session, and [`middleware.ts`](../../../src/middleware.ts) redirects unauthenticated browser requests to `/login` for any non-public path. The internal `POST` route lives under `/api/internal/`, which `middleware.ts` treats as a **public route** ([`middleware.ts:13`](../../../src/middleware.ts)) — so it relies entirely on its own in-handler `CRON_SECRET`/session check for protection.

---

## Read endpoints (`/api/room-capacity/*`)

These three share an identical auth preamble: call `auth()`, and if there is no session return **HTTP 401** `{ "error": "Unauthorized" }` ([`utilization/route.ts:7-10`](../../../src/app/api/room-capacity/utilization/route.ts), [`month/route.ts:7-10`](../../../src/app/api/room-capacity/month/route.ts), [`forecast/route.ts:44-47`](../../../src/app/api/room-capacity/forecast/route.ts)). They take no request body; all inputs are URL query parameters.

### `GET /api/room-capacity/utilization`

Historical room-occupancy report computed from persisted Wise sessions (the `room_utilization_sessions` table) against the active classroom-room catalog.

**Auth:** authenticated Auth.js session required (401 otherwise).

**Query parameters** (parsed in [`utilization/route.ts:12-17`](../../../src/app/api/room-capacity/utilization/route.ts); no Zod):

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `startDate` | `YYYY-MM-DD` | `2026-03-01` | When absent, falls back to `ROOM_UTILIZATION_HISTORY_START` ([`utilization.ts:20`, `:101-103`, `:478-479`](../../../src/lib/room-capacity/utilization.ts)). |
| `endDate` | `YYYY-MM-DD` | today in `Asia/Bangkok` | Default is `todayBangkok()` ([`utilization.ts:101-103`](../../../src/lib/room-capacity/utilization.ts); [`dates.ts:27-29`](../../../src/lib/room-capacity/dates.ts)). |
| `weekdays` | comma-separated list | all 7 days | Tokens may be numbers `0`–`6` (0 = Sunday) **or** names/abbreviations (`sun`, `mon`, `tue`/`tues`, `wed`, `thu`/`thur`/`thurs`, `fri`, `sat`, and full names), case-insensitive. Parsed and de-duplicated by `parseUtilizationWeekdays` ([`utilization.ts:28-53`, `:112-129`](../../../src/lib/room-capacity/utilization.ts)). |

The handler calls `parseUtilizationWeekdays(...)` then `getRoomUtilization(getDb(), { startDate, endDate, weekdays })` ([`utilization/route.ts:16-17`](../../../src/app/api/room-capacity/utilization/route.ts)). Note `startDate`/`endDate` are passed through as raw strings (or `null` when the param is absent); the defaulting happens inside the service ([`utilization.ts:474-483`](../../../src/lib/room-capacity/utilization.ts)).

**What it computes.** `getRoomUtilization` reads `room_utilization_sessions` rows whose `utilizationDate` is within `[startDate, endDate]`, the active classroom rooms, and the max `syncedAt` timestamp, then calls `aggregateRoomUtilization` ([`utilization.ts:485-507`](../../../src/lib/room-capacity/utilization.ts)). The open-hours window is fixed at minute `420`–`1260` (07:00–21:00 Bangkok) ([`utilization.ts:21-24`](../../../src/lib/room-capacity/utilization.ts)). Sessions in counted statuses (`ENDED`, `IN_PROGRESS`, `UPCOMING`) contribute occupancy; `CANCELLED`/`CANCELED`/`MISSED`/`NO_SHOW` and any unknown status are excluded and tallied as data-quality issues ([`utilization.ts:55-56`, `:131-138`, `:311-331`](../../../src/lib/room-capacity/utilization.ts)).

**Response shape** — JSON `RoomUtilizationResponse` ([type: `types.ts:264-281`](../../../src/lib/room-capacity/types.ts); assembled at [`utilization.ts:380-397`](../../../src/lib/room-capacity/utilization.ts)):

```jsonc
{
  "range": {
    "startDate": "2026-03-01",
    "endDate": "2026-05-18",
    "generatedAt": "2026-05-18T00:00:00.000Z",
    "openStartMinute": 420,
    "openEndMinute": 1260,
    "weekdays": [0, 1, 2, 3, 4, 5, 6]
  },
  "lastSyncedAt": "2026-05-18T00:00:00.000Z",   // max synced_at, or null if no rows
  "summary": {                                    // RoomUtilizationMetric + activeRoomCount
    "occupiedMinutes": 12000,
    "availableMinutes": 48000,
    "utilizationPct": 25,                         // occupied/available, rounded to 0.1%
    "sessionCount": 200,
    "activeRoomCount": 24
  },
  "daily": [/* RoomUtilizationDailyRow[] */],     // per-date metrics + quality counts
  "monthly": [/* RoomUtilizationMonthlyRow[] */], // per-month rollups
  "rooms": [/* RoomUtilizationRoomRow[] */],      // per-room, sorted by utilizationPct desc
  "dataQuality": {                                // RoomUtilizationDataQuality
    "missingLocationCount": 1, "missingLocationMinutes": 60,
    "unknownRoomCount": 1,     "unknownRoomMinutes": 60,
    "excludedStatusCount": 2,  "excludedStatusMinutes": 120,
    "overlapMinutes": 30
  }
}
```

Field-level definitions for `RoomUtilizationDailyRow`, `RoomUtilizationMonthlyRow`, and `RoomUtilizationRoomRow` are in [`types.ts:221-262`](../../../src/lib/room-capacity/types.ts).

**Side effects:** none. Read-only Postgres `SELECT`s only ([`utilization.ts:485-497`](../../../src/lib/room-capacity/utilization.ts)).

**Status codes:**

| Status | When | Body |
|--------|------|------|
| 200 | success | `RoomUtilizationResponse` |
| 401 | no session | `{ "error": "Unauthorized" }` |
| 400 | thrown message starts with `Invalid date range` / `Invalid startDate` / `Invalid endDate` / `Invalid weekdays` | `{ "error": <message> }` |
| 500 | any other thrown error | `{ "error": <message \| "Failed to load room utilization"> }` |

The 400-vs-500 split is decided in the handler's `catch` by prefix-matching the error message ([`utilization/route.ts:19-28`](../../../src/app/api/room-capacity/utilization/route.ts)). Those messages originate from `assertUtilizationDate` ("Invalid startDate/endDate. Expected YYYY-MM-DD."), the `startDate > endDate` guard ("Invalid date range. startDate must be before or equal to endDate."), and `parseUtilizationWeekdays` ("Invalid weekdays. Expected comma-separated weekday numbers 0-6 or names." / "Invalid weekdays. Expected at least one weekday.") ([`utilization.ts:90-99`, `:120-127`, `:481-483`](../../../src/lib/room-capacity/utilization.ts)). Both 400 paths are covered by tests ([`route.test.ts:236-258`](../../../src/app/api/room-capacity/__tests__/route.test.ts)).

### `GET /api/room-capacity/month`

Operational room-load view for a date range: current Wise locations vs. the engine's *projected* room assignment, with overcapacity intervals, unmatched allocations, heatmap cells, and per-day summaries. Scoped to the active Wise snapshot.

**Auth:** authenticated Auth.js session required (401 otherwise — [`month/route.ts:7-10`](../../../src/app/api/room-capacity/month/route.ts)).

**Query parameters** (parsed in [`month/route.ts:12-16`](../../../src/app/api/room-capacity/month/route.ts); no Zod):

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `startDate` | `YYYY-MM-DD` | today in `Asia/Bangkok` | Default from `defaultRoomCapacityRange()` ([`dates.ts:69-75`](../../../src/lib/room-capacity/dates.ts)). |
| `endDate` | `YYYY-MM-DD` | end of the current Bangkok month | Same default helper ([`dates.ts:63-75`](../../../src/lib/room-capacity/dates.ts)). |

The handler passes the raw params (or `null`) straight into `getRoomCapacityMonth(getDb(), { startDate, endDate })`; the defaulting happens in the service ([`data.ts:229-235`](../../../src/lib/room-capacity/data.ts)). Tests confirm both the `{ startDate: null, endDate: null }` default pass-through and explicit-range pass-through ([`route.test.ts:142-160`](../../../src/app/api/room-capacity/__tests__/route.test.ts)).

**What it computes.** `getRoomCapacityMonth` loads the active snapshot (`snapshots.active = true`), the classroom-room catalog, blocking `future_session_blocks` in range, and the latest classroom-assignment overrides per date; it then runs the assignment engine to produce projected rows and derives KPIs, overcap intervals, unmatched allocations, heatmap cells, and day summaries for both the `current` and `projected` views ([`data.ts:229-291`](../../../src/lib/room-capacity/data.ts)). If there is no active snapshot it throws `"No active Wise snapshot found"` ([`data.ts:37-44`](../../../src/lib/room-capacity/data.ts)).

**Response shape** — JSON `RoomCapacityMonthResponse` ([type: `types.ts:109-139`](../../../src/lib/room-capacity/types.ts); assembled at [`data.ts:267-290`](../../../src/lib/room-capacity/data.ts)):

```jsonc
{
  "range": { "startDate": "2026-05-15", "endDate": "2026-05-31", "generatedAt": "2026-05-15T00:00:00.000Z" },
  "snapshotMeta": { "snapshotId": "snapshot-1", "syncedAt": "2026-05-15T00:00:00.000Z" },
  "rooms": [/* RoomCapacityRoom[] */],
  "kpis": {
    "currentOvercapIntervals": 0,
    "impactedRooms": 0,
    "projectedNoRoomSessions": 0,
    "unmatchedCurrentAllocations": 0,
    "peakLoadRatio": 0
  },
  "current":   { "overcaps": [], "unmatchedAllocations": [], "heatmapCells": [], "daySummaries": [] },
  "projected": { "overcaps": [], "noRoomRows": [],            "heatmapCells": [], "daySummaries": [] }
}
```

Element types (`RoomCapacityRoom`, `RoomCapacityOvercapInterval`, `RoomCapacityUnmatchedAllocation`, `RoomCapacityHeatmapCell`, `RoomCapacityNoRoomRow`, `RoomCapacityDaySummary`) are defined in [`types.ts:3-107`](../../../src/lib/room-capacity/types.ts).

**Side effects:** none. The override lookup and assignment run are computed in memory; this endpoint does **not** persist an assignment run (the test names this explicitly: "uses service defaults … without persisting runs", [`route.test.ts:142-148`](../../../src/app/api/room-capacity/__tests__/route.test.ts)).

**Status codes:**

| Status | When | Body |
|--------|------|------|
| 200 | success | `RoomCapacityMonthResponse` |
| 401 | no session | `{ "error": "Unauthorized" }` |
| 500 | any thrown error (e.g. no active snapshot) | `{ "error": <message \| "Failed to load room capacity"> }` |

This handler has no 400 branch — every caught error maps to 500 ([`month/route.ts:18-21`](../../../src/app/api/room-capacity/month/route.ts)).

### `GET /api/room-capacity/forecast`

Capacity-saturation and weekend-demand forecast for a named scenario, derived from an imported model run plus the active snapshot's schedule. Degrades gracefully to a "missing" payload when the forecast tables/model run do not yet exist.

**Auth:** authenticated Auth.js session required (401 otherwise — [`forecast/route.ts:44-47`](../../../src/app/api/room-capacity/forecast/route.ts)).

**Query parameters** (parsed in [`forecast/route.ts:49`](../../../src/app/api/room-capacity/forecast/route.ts); no Zod):

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `scenario` | string | `"Base"` | `request.nextUrl.searchParams.get("scenario") \|\| "Base"`. If the requested scenario has no drivers, the service falls back to the first available scenario and echoes it back in the response's `scenario` field ([`data.ts:389-396`, `:436`](../../../src/lib/room-capacity/data.ts)). Test: defaults to `Base` ([`route.test.ts:162-173`](../../../src/app/api/room-capacity/__tests__/route.test.ts)). |

The handler calls `getRoomCapacityForecast(getDb(), { scenario })` ([`forecast/route.ts:52`](../../../src/app/api/room-capacity/forecast/route.ts)).

**What it computes.** `getRoomCapacityForecast` loads the latest `room_capacity_model_runs` row; if none exists it returns a `status: "missing"` response immediately ([`data.ts:385-391`](../../../src/lib/room-capacity/data.ts)). Otherwise it loads scenario drivers, demand mix, and package mix for that model run, loads the active snapshot's seed sessions, runs `simulateSaturation`, `buildWeekendDemandCaptureReadiness`, and `simulateWeekendDemandBreakpoint`, and returns a `status: "ready"` response ([`data.ts:385-444`](../../../src/lib/room-capacity/data.ts)).

**Response shape** — JSON `RoomCapacityForecastResponse` ([type: `types.ts:304-320`](../../../src/lib/room-capacity/types.ts)):

```jsonc
{
  "model": {
    "status": "ready",                 // or "missing"
    "modelRunId": "model-1",           // null when missing
    "sourceLabel": "Projection",       // null when missing
    "forecastStart": "2026-06-01",     // null when missing
    "forecastEnd": "2027-05-01",       // null when missing
    "importedAt": "2026-05-15T00:00:00.000Z"  // null when missing
  },
  "scenario": "Base",                  // the effective scenario (may differ from the request)
  "scenarios": ["Base"],               // all scenarios present in the model run
  "generatedAt": "2026-05-15T00:00:00.000Z",
  "weekdayResults": [/* WeekdaySaturationResult[] */],
  "weekendDemandBreakpoint": { /* WeekendDemandBreakpoint */ } ,   // or null
  "weekendDemandCaptureReadiness": { /* WeekendDemandCaptureReadiness */ },  // or null
  "monthlyDrivers": [/* RoomCapacityForecastDriver[] */]
}
```

Element types (`WeekdaySaturationResult`, `WeekendDemandBreakpoint`, `WeekendDemandCaptureReadiness`, `RoomCapacityForecastDriver`) are in [`types.ts:141-219`, `:283-302`](../../../src/lib/room-capacity/types.ts). The `ready` response sets `weekendDemandBreakpoint` only when the readiness gate passes — `simulateWeekendDemandBreakpoint` returns `null` otherwise (see the feature doc for the readiness rules).

**The "missing" fallback (two paths, same shape).** A `status: "missing"` body is returned in two situations, and both produce the identical shape — `model.status: "missing"`, all `model.*` ids/labels `null`, `scenarios: []`, `weekendDemandBreakpoint: null`, `weekendDemandCaptureReadiness: null`, `monthlyDrivers: []`, and a `weekdayResults` array of exactly 7 entries (Sunday→Saturday, all dates/reasons `null`):

1. **No model run yet** — handled inside the service via `missingForecastResponse(scenario)` ([`data.ts:358-383`, `:391`](../../../src/lib/room-capacity/data.ts)).
2. **Forecast tables don't exist yet** — if the service throws an error whose message references any of `room_capacity_model_runs`, `room_capacity_forecast_drivers`, `room_capacity_demand_mix`, or `room_capacity_package_mix`, the route's `catch` recognizes it via `isMissingForecastTableError` and returns `missingForecastBody(scenario)` with **HTTP 200** instead of 500 ([`forecast/route.ts:6-14`, `:16-41`, `:55-57`](../../../src/app/api/room-capacity/forecast/route.ts)). Both `scenario` and the 7-element `weekdayResults` are echoed/preserved — covered by [`route.test.ts:175-190`](../../../src/app/api/room-capacity/__tests__/route.test.ts).

> The route-level `missingForecastBody` ([`forecast/route.ts:16-41`](../../../src/app/api/room-capacity/forecast/route.ts)) and the service-level `missingForecastResponse` ([`data.ts:358-383`](../../../src/lib/room-capacity/data.ts)) are two copies of the same payload, kept in sync by shape.

**Side effects:** none. Read-only.

**Status codes:**

| Status | When | Body |
|--------|------|------|
| 200 | success (`ready`) | `RoomCapacityForecastResponse` with `model.status: "ready"` |
| 200 | no model run, or a missing-forecast-table error | `RoomCapacityForecastResponse` with `model.status: "missing"` |
| 401 | no session | `{ "error": "Unauthorized" }` |
| 500 | any other thrown error | `{ "error": <message \| "Failed to load room capacity forecast"> }` |

This is the only one of the four endpoints that turns a thrown error into a 200 (the missing-table case); all non-recognized errors still return 500 ([`forecast/route.ts:54-60`](../../../src/app/api/room-capacity/forecast/route.ts)).

---

## Internal sync endpoint

### `POST /api/internal/sync-room-utilization`

Refreshes the room-utilization history that backs `GET /api/room-capacity/utilization`: fetches every institute session from Wise and upserts the relevant rows into `room_utilization_sessions`.

**HTTP method + path:** `POST /api/internal/sync-room-utilization`. The handler exports **only `POST`** — there is no `GET` ([`sync-room-utilization/route.ts:25`](../../../src/app/api/internal/sync-room-utilization/route.ts)).

**Auth:** dual-mode — a valid `CRON_SECRET` bearer token, **or** an authenticated Auth.js session as a fallback ([`sync-room-utilization/route.ts:25-35`](../../../src/app/api/internal/sync-room-utilization/route.ts)):

1. `hasValidCronSecret(request)` compares the `Authorization` header against `Bearer ${CRON_SECRET}` using a length pre-check plus `crypto.timingSafeEqual` (constant-time), returning `"valid"`, `"invalid"`, or `"missing-secret"` ([`sync-room-utilization/route.ts:1`, `:9-23`](../../../src/app/api/internal/sync-room-utilization/route.ts)).
2. If the secret is **not** `"valid"`, the handler calls `auth()`. With no session: a `"missing-secret"` status returns **HTTP 500 `{ "error": "Server misconfigured" }`** (refusing to run unauthenticated), otherwise **HTTP 401 `{ "error": "Unauthorized" }`** ([`sync-room-utilization/route.ts:27-35`](../../../src/app/api/internal/sync-room-utilization/route.ts)). A present session lets the request through even without a valid bearer token.

This is a local copy of the same constant-time pattern used by the other internal sync routes (it does not import the shared `cron-auth` helper) — see [`docs/reference/crons.md`](../crons.md).

**Request body:** none. The handler reads no body and no query params; it always calls `syncRoomUtilizationSessions(getDb())` with default arguments ([`sync-room-utilization/route.ts:38`](../../../src/app/api/internal/sync-room-utilization/route.ts)). (The underlying `syncRoomUtilizationSessions` accepts an optional `{ startDate?, syncedAt? }`, but the route passes neither, so the sync uses `ROOM_UTILIZATION_HISTORY_START = "2026-03-01"` as the floor — [`utilization.ts:427-431`](../../../src/lib/room-capacity/utilization.ts).)

**`maxDuration = 800`** — the route exports an 800-second function ceiling to cover the full institute-session fetch ([`sync-room-utilization/route.ts:7`](../../../src/app/api/internal/sync-room-utilization/route.ts)).

**Side effects (writes).** `syncRoomUtilizationSessions(db)` ([`utilization.ts:427-472`](../../../src/lib/room-capacity/utilization.ts)):

1. Requires `WISE_INSTITUTE_ID`; throws `"WISE_INSTITUTE_ID is required to sync room utilization"` if unset ([`utilization.ts:433-434`](../../../src/lib/room-capacity/utilization.ts)).
2. Fetches **all** institute sessions via `fetchAllInstituteSessions(createWiseClient(), instituteId)` (no status filter — past, present, and future) ([`utilization.ts:436`](../../../src/lib/room-capacity/utilization.ts)).
3. Maps each session to a row (`wiseSessionToUtilizationRow`), dropping rows that fail to parse and any whose `utilizationDate` is before `2026-03-01` ([`utilization.ts:437-439`](../../../src/lib/room-capacity/utilization.ts)).
4. Upserts in chunks of 500 into `room_utilization_sessions`, conflict target `wiseSessionId`, updating all mutable columns from the new values (`onConflictDoUpdate`) ([`utilization.ts:54`, `:441-464`](../../../src/lib/room-capacity/utilization.ts)). This is the **only** write among the four endpoints.

**Response shape** — on success, **HTTP 200** with `{ ok: true, ...result }`, where `result` is the return of `syncRoomUtilizationSessions` ([`sync-room-utilization/route.ts:38-39`](../../../src/app/api/internal/sync-room-utilization/route.ts); [`utilization.ts:466-471`](../../../src/lib/room-capacity/utilization.ts)):

```jsonc
{
  "ok": true,
  "fetchedCount": 0,            // sessions returned by Wise
  "storedCount": 0,            // rows kept (on/after 2026-03-01) and upserted
  "startDate": "2026-03-01",
  "syncedAt": "2026-05-31T00:00:00.000Z"
}
```

**Status codes:**

| Status | When | Body |
|--------|------|------|
| 200 | success | `{ "ok": true, "fetchedCount", "storedCount", "startDate", "syncedAt" }` |
| 401 | invalid/absent bearer **and** no session (with `CRON_SECRET` set) | `{ "error": "Unauthorized" }` |
| 500 | `CRON_SECRET` unset **and** no session | `{ "error": "Server misconfigured" }` |
| 500 | any thrown error during sync (e.g. missing `WISE_INSTITUTE_ID`, Wise fetch failure) | `{ "error": <message \| "Failed to sync room utilization"> }` |

(Both 500 cases share the same status; the bodies differ — `"Server misconfigured"` for the auth-misconfig path vs. the sync error message — [`sync-room-utilization/route.ts:30-33`, `:40-43`](../../../src/app/api/internal/sync-room-utilization/route.ts).)

**Scheduling — manual only.** This endpoint is **not** registered in [`vercel.json`](../../../vercel.json) (its cron list contains 12 scheduled paths, none of which is `sync-room-utilization`). Vercel Cron invokes endpoints via `GET`, and this handler exports only `POST`, so it is not auto-scheduled. It is triggered by:

- the room-capacity dashboard's refresh action, which `fetch`es `POST /api/internal/sync-room-utilization` ([`room-capacity-dashboard.tsx:375`](../../../src/components/room-capacity/room-capacity-dashboard.tsx));
- an external `POST` with the `CRON_SECRET` bearer; or
- the CLI script `scripts/sync-room-utilization.ts` (npm `room-utilization:sync`, [`package.json:22`](../../../package.json)), which calls `syncRoomUtilizationSessions` directly.

See [`docs/reference/crons.md`](../crons.md) ("Internal handlers without a cron schedule") and the [room-capacity feature doc](../../features/room-capacity.md) for the open question on whether an automated cron was intended.

---

## Notes & open questions

- **No Zod at these route boundaries.** Unlike the project convention of validating with Zod `.safeParse()` at API boundaries, all three read routes parse query params manually and rely on service-layer string checks (`assertUtilizationDate`, `parseUtilizationWeekdays`) for validation; the write route takes no input. Verified by absence — `grep -r "zod" src/app/api/room-capacity src/app/api/internal/sync-room-utilization` returns nothing.
- **`sync-room-utilization` is unscheduled.** It exists with `maxDuration = 800` but has no `vercel.json` cron entry and is `POST`-only (cron calls `GET`), so it never fires automatically. Open question: was an automated cron (and stagger) intended, or is manual/CLI refresh the deliberate design? (Mirrors the open question already recorded in [`docs/reference/crons.md`](../crons.md) and [`docs/features/room-capacity.md`](../../features/room-capacity.md).)

_Verified against HEAD + uncommitted WIP on 2026-05-31._
