# Room Capacity API

**Authoritative source:** the three read handlers under [`src/app/api/room-capacity/`](../../../src/app/api/room-capacity/) plus the one write handler at [`src/app/api/internal/sync-room-utilization/route.ts`](../../../src/app/api/internal/sync-room-utilization/route.ts). Feature status is declared by [docs/features/room-capacity.md](../../features/room-capacity.md); this page does not restate it.

This page is the mechanical reference for the four Room Capacity HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. Meaning — what utilization measures, why the month and forecast views exist, how saturation is reasoned about — lives in [docs/features/room-capacity.md](../../features/room-capacity.md). Table columns live in [docs/reference/database/erd-room-capacity.md](../database/erd-room-capacity.md), generated from [`schema.ts`](../../../src/lib/db/schema.ts) (`room_utilization_sessions` is declared at [`schema.ts:1736-1756`](../../../src/lib/db/schema.ts)).

## Endpoint summary

| Method | Path | Auth | Handler |
|---|---|---|---|
| `GET` | `/api/room-capacity/utilization` | admin session | [`utilization/route.ts:6-29`](../../../src/app/api/room-capacity/utilization/route.ts) |
| `GET` | `/api/room-capacity/month` | admin session | [`month/route.ts:6-22`](../../../src/app/api/room-capacity/month/route.ts) |
| `GET` | `/api/room-capacity/forecast` | admin session | [`forecast/route.ts:43-61`](../../../src/app/api/room-capacity/forecast/route.ts) |
| `POST` | `/api/internal/sync-room-utilization` | `CRON_SECRET` **or** admin session | [`sync-room-utilization/route.ts:26-54`](../../../src/app/api/internal/sync-room-utilization/route.ts) |

Only `GET /api/room-capacity/utilization` and `POST /api/internal/sync-room-utilization` have an in-repo caller: the dashboard at [`room-capacity-dashboard.tsx:354`](../../../src/components/room-capacity/room-capacity-dashboard.tsx) and [`:375`](../../../src/components/room-capacity/room-capacity-dashboard.tsx). `month` and `forecast` are reachable and tested ([`__tests__/route.test.ts`](../../../src/app/api/room-capacity/__tests__/route.test.ts)) but nothing in `src/` fetches them.

## Conventions shared across the endpoints

- **No Zod anywhere.** None of the four handlers declares a schema. The three `GET` routes read raw `searchParams` strings and hand them to the service layer; the `POST` route never reads a body at all. Validation, where it exists, is hand-written regex plus thrown `Error` messages that the handler maps to a status code by string prefix.
- **No response envelope on reads.** All three `GET` routes return the service object bare — no `ok`/`result` wrapper. The `POST` route is the exception: it spreads the sync result into `{ ok: true, ... }` ([`sync-room-utilization/route.ts:47`](../../../src/app/api/internal/sync-room-utilization/route.ts)).
- **No caching.** None of the four files uses `"use cache"`, `cacheTag`, or a route segment config other than `maxDuration` on the sync route. Every request recomputes.
- **Middleware gating differs by prefix.** `/api/room-capacity/**` is *not* on the public allowlist ([`middleware.ts:4-20`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs, and a restricted user whose `allowedPages` omits `/room-capacity` gets a middleware **403** `{"error":"Forbidden"}` (`isPathAllowed` matches each allowed page both as `/x` and as `/api/x`, [`middleware.ts:30-61`](../../../src/middleware.ts)). `/api/internal/*` **is** allowlisted ([`middleware.ts:18`](../../../src/middleware.ts)), so the sync route's own header/session check is the only gate.
- **No role check.** Every handler's authorization is `auth()` returning a session — there is no room-capacity-specific role or capability guard.
- **All dates are Asia/Bangkok calendar dates** in `YYYY-MM-DD` form, resolved through [`src/lib/room-capacity/dates.ts`](../../../src/lib/room-capacity/dates.ts).
- **Reads are not write-free.** All three `GET` routes reach `listClassroomRooms`, which first runs `ensureDefaultClassroomRooms` — inserting missing default rooms, `UPDATE`-ing drifted attributes back to the defaults, and deactivating superseded TV rooms ([`classrooms/data.ts:431-488`](../../../src/lib/classrooms/data.ts), called at [`:490-497`](../../../src/lib/classrooms/data.ts)). Call sites: [`utilization.ts:493`](../../../src/lib/room-capacity/utilization.ts), [`data.ts:237`](../../../src/lib/room-capacity/data.ts), [`data.ts:402`](../../../src/lib/room-capacity/data.ts). Nothing in this feature writes back to Wise.

---

## Read endpoints (`/api/room-capacity/*`)

All three share the same auth preamble — `const session = await auth(); if (!session) return 401 { "error": "Unauthorized" }` — take no request body, and read all input from query parameters.

### `GET /api/room-capacity/utilization`

Aggregated historical room occupancy for a Bangkok date range, computed from the locally persisted `room_utilization_sessions` store (never from Wise on the request path). Handler: [`utilization/route.ts:6-29`](../../../src/app/api/room-capacity/utilization/route.ts); service: `getRoomUtilization` [`utilization.ts:474-507`](../../../src/lib/room-capacity/utilization.ts) → `aggregateRoomUtilization` [`utilization.ts:227-398`](../../../src/lib/room-capacity/utilization.ts).

**Auth:** session required ([`utilization/route.ts:7-10`](../../../src/app/api/room-capacity/utilization/route.ts)).

**Query parameters:**

| Param | Type | Default | Notes |
|---|---|---|---|
| `startDate` | string (`YYYY-MM-DD`) | `2026-03-01` | Passed through as `string \| null`; the service substitutes `ROOM_UTILIZATION_HISTORY_START` when null ([`utilization.ts:20,101-103,478-479`](../../../src/lib/room-capacity/utilization.ts)). Validated by `assertUtilizationDate` against `/^\d{4}-\d{2}-\d{2}$/` ([`utilization.ts:26,90-99`](../../../src/lib/room-capacity/utilization.ts)). |
| `endDate` | string (`YYYY-MM-DD`) | today (Bangkok) | Same validation; default is `todayBangkok()` ([`utilization.ts:101-103`](../../../src/lib/room-capacity/utilization.ts), [`dates.ts:27-29`](../../../src/lib/room-capacity/dates.ts)). |
| `weekdays` | comma-separated list | all seven | Parsed by `parseUtilizationWeekdays` ([`utilization.ts:112-129`](../../../src/lib/room-capacity/utilization.ts)) **in the route**, before the service call ([`utilization/route.ts:16`](../../../src/app/api/room-capacity/utilization/route.ts)). Accepts digits `0`–`6` (0 = Sunday) and case-insensitive names/abbreviations (`sun`, `sunday`, `mon`, `tue`, `tues`, `wed`, `thu`, `thur`, `thurs`, `fri`, `sat`, …) per the token map at [`utilization.ts:28-53`](../../../src/lib/room-capacity/utilization.ts). Empty or absent → `undefined` (all weekdays); an unrecognized token throws. Result is de-duplicated and sorted ascending. |

`startDate > endDate` throws `Invalid date range. startDate must be before or equal to endDate.` ([`utilization.ts:481-483`](../../../src/lib/room-capacity/utilization.ts)).

**Response 200** — `RoomUtilizationResponse` ([`types.ts:264-281`](../../../src/lib/room-capacity/types.ts)), returned bare:

| Key | Type | Meaning |
|---|---|---|
| `range` | object | `{ startDate, endDate, generatedAt (ISO), openStartMinute, openEndMinute, weekdays }`. The open window is fixed at 07:00–21:00 Bangkok — `openStartMinute` is always `420` and `openEndMinute` always `1260` ([`utilization.ts:21-24,385-387`](../../../src/lib/room-capacity/utilization.ts)). `weekdays` echoes the resolved filter. |
| `lastSyncedAt` | string \| null | ISO of `max(synced_at)` across the whole table — not scoped to the requested range ([`utilization.ts:494-496,389`](../../../src/lib/room-capacity/utilization.ts)). |
| `summary` | object | `RoomUtilizationMetric` (`occupiedMinutes`, `availableMinutes`, `utilizationPct`, `sessionCount`) plus `activeRoomCount` ([`types.ts:274-276`](../../../src/lib/room-capacity/types.ts)). `availableMinutes` = selected days × active rooms × 840 ([`utilization.ts:247,369`](../../../src/lib/room-capacity/utilization.ts)). |
| `daily` | `RoomUtilizationDailyRow[]` | One row per selected date: the metric fields plus `date`, `weekday`, `missingLocationCount`, `unknownRoomCount`, `excludedStatusCount`, `overlapMinutes` ([`types.ts:228-235`](../../../src/lib/room-capacity/types.ts)). |
| `monthly` | `RoomUtilizationMonthlyRow[]` | Same shape keyed by `month` (`YYYY-MM`) with the first and last covered `startDate`/`endDate` ([`types.ts:237-245`](../../../src/lib/room-capacity/types.ts)). |
| `rooms` | `RoomUtilizationRoomRow[]` | One row per **active** room, sorted by `utilizationPct` desc then name ([`types.ts:247-252`](../../../src/lib/room-capacity/types.ts), [`utilization.ts:393-395`](../../../src/lib/room-capacity/utilization.ts)). |
| `dataQuality` | object | Counts **and** minutes for the three drop reasons plus total `overlapMinutes` ([`types.ts:254-262`](../../../src/lib/room-capacity/types.ts)). |

Aggregation rules that shape those numbers (all in `aggregateRoomUtilization`): each session is clipped to the 07:00–21:00 window before counting ([`utilization.ts:172-176`](../../../src/lib/room-capacity/utilization.ts)); only `ENDED`, `IN_PROGRESS`, and `UPCOMING` are counted, and every other status — including unknown ones — is dropped into `excludedStatus*` ([`utilization.ts:55-56,131-138,311-316`](../../../src/lib/room-capacity/utilization.ts)); rows with no location fall into `missingLocation*` ([`:318-323`](../../../src/lib/room-capacity/utilization.ts)); rows whose normalized label matches no active room fall into `unknownRoom*` ([`:325-331`](../../../src/lib/room-capacity/utilization.ts)); `utilizationPct` is rounded to one decimal ([`:140-143`](../../../src/lib/room-capacity/utilization.ts)); `overlapMinutes` is the *excess* concurrency per date+room, so it is reported alongside — not subtracted from — `occupiedMinutes` ([`:215-225,355-366`](../../../src/lib/room-capacity/utilization.ts)). Why those rules exist is covered in [docs/features/room-capacity.md](../../features/room-capacity.md).

**Side effects:** `ensureDefaultClassroomRooms` writes (see [Conventions](#conventions-shared-across-the-endpoints)). Nothing else is written; no Wise call.

**Status codes:**

| Status | When |
|---|---|
| 200 | Aggregate returned. |
| 401 | No session ([`utilization/route.ts:8-10`](../../../src/app/api/room-capacity/utilization/route.ts)). |
| 400 | Thrown message starts with `Invalid date range`, `Invalid startDate`, `Invalid endDate`, or `Invalid weekdays` ([`utilization/route.ts:21-26`](../../../src/app/api/room-capacity/utilization/route.ts)). Because the weekday parse sits inside the `try`, a bad `weekdays` token returns 400 rather than escaping the handler. |
| 500 | Any other thrown error; body `{ error: <message> }`, fallback text `Failed to load room utilization` ([`utilization/route.ts:20,27`](../../../src/app/api/room-capacity/utilization/route.ts)). |

---

### `GET /api/room-capacity/month`

Month-pressure view: over-capacity intervals, unmatched Wise room allocations, projected "no room" sessions, and a 30-minute heatmap, computed on demand from the active Wise snapshot. Handler: [`month/route.ts:6-22`](../../../src/app/api/room-capacity/month/route.ts); service: `getRoomCapacityMonth` [`data.ts:229-291`](../../../src/lib/room-capacity/data.ts).

**Auth:** session required ([`month/route.ts:7-10`](../../../src/app/api/room-capacity/month/route.ts)).

**Query parameters:**

| Param | Type | Default | Notes |
|---|---|---|---|
| `startDate` | string (`YYYY-MM-DD`) | today (Bangkok) | Forwarded verbatim as `string \| null`; the service applies `defaultRoomCapacityRange()` when null ([`month/route.ts:12,16`](../../../src/app/api/room-capacity/month/route.ts), [`data.ts:233-235`](../../../src/lib/room-capacity/data.ts), [`dates.ts:69-75`](../../../src/lib/room-capacity/dates.ts)). |
| `endDate` | string (`YYYY-MM-DD`) | last day of the Bangkok month containing `startDate` | Same handling; default from `endOfBangkokMonth` ([`dates.ts:63-67`](../../../src/lib/room-capacity/dates.ts)). |

**No format validation on this route.** Unlike the utilization endpoint, neither the handler nor `getRoomCapacityMonth` runs `assertUtilizationDate` or any regex — a malformed value flows straight into `bangkokDateStartUtc` and the SQL range filter ([`data.ts:76-77`](../../../src/lib/room-capacity/data.ts)), so it surfaces as a 500, not a 400. There is no 400 path in this handler at all.

**Response 200** — `RoomCapacityMonthResponse` ([`types.ts:109-139`](../../../src/lib/room-capacity/types.ts)), returned bare:

| Key | Type | Meaning |
|---|---|---|
| `range` | object | `{ startDate, endDate, generatedAt }` — the resolved range ([`data.ts:268`](../../../src/lib/room-capacity/data.ts)). |
| `snapshotMeta` | object | `{ snapshotId, syncedAt }` for the single `active = true` snapshot ([`data.ts:37-45,269`](../../../src/lib/room-capacity/data.ts)). |
| `rooms` | `RoomCapacityRoom[]` | The full classroom catalogue, active **and** inactive, as stored ([`types.ts:3-11`](../../../src/lib/room-capacity/types.ts), [`data.ts:47-57,237`](../../../src/lib/room-capacity/data.ts)). |
| `kpis` | object | `currentOvercapIntervals`, `impactedRooms` (distinct room names among current overcaps), `projectedNoRoomSessions`, `unmatchedCurrentAllocations`, `peakLoadRatio` ([`data.ts:271-277`](../../../src/lib/room-capacity/data.ts)). |
| `current` | object | What Wise's own `location` values imply today: `{ overcaps, unmatchedAllocations, heatmapCells, daySummaries }` ([`data.ts:278-283`](../../../src/lib/room-capacity/data.ts)). |
| `projected` | object | What the classroom assignment engine would produce: `{ overcaps, noRoomRows, heatmapCells, daySummaries }` ([`data.ts:284-289`](../../../src/lib/room-capacity/data.ts)). Note `projected` carries `noRoomRows` where `current` carries `unmatchedAllocations`; the two arrays are not interchangeable. |

Element shapes: `RoomCapacityOvercapInterval` ([`types.ts:54-67`](../../../src/lib/room-capacity/types.ts)); `RoomCapacityUnmatchedAllocation` with `reason: "missing_location" \| "unknown_room"` ([`types.ts:69-79`](../../../src/lib/room-capacity/types.ts)); `RoomCapacityNoRoomRow` ([`types.ts:81-93`](../../../src/lib/room-capacity/types.ts)); `RoomCapacityHeatmapCell` with `status: "empty" \| "occupied" \| "full" \| "over_capacity" \| "review"` ([`types.ts:39-52`](../../../src/lib/room-capacity/types.ts)); `RoomCapacityDaySummary` ([`types.ts:95-107`](../../../src/lib/room-capacity/types.ts)).

Mechanical notes on how those arrays are produced:

- **Session set.** `future_session_blocks` for the active snapshot with `isBlocking = true` and `startTime` in `[startDate 00:00 ICT, endDate+1 00:00 ICT)`, inner-joined to `tutor_identity_groups` for the display name ([`data.ts:70-125`](../../../src/lib/room-capacity/data.ts)). Non-blocking (e.g. cancelled) sessions never appear.
- **Overrides.** The most recent `classroom_assignment_runs` row per `assignmentDate` in range contributes its non-null `overrideRoom` values to the projection ([`data.ts:127-167`](../../../src/lib/room-capacity/data.ts)).
- **Projection.** `assignClassrooms` runs per date over those sessions and overrides ([`data.ts:193-227`](../../../src/lib/room-capacity/data.ts)).
- **Overcaps.** Per date+room, sessions are swept at every start/end boundary; an interval is emitted only when the summed load exceeds room capacity ([`analysis.ts:104-162`](../../../src/lib/room-capacity/analysis.ts)). Load is `studentCount` clamped to a minimum of 1 ([`analysis.ts:32-35`](../../../src/lib/room-capacity/analysis.ts)).
- **Heatmap.** One cell per date × active room × 30-minute bin from 07:00 to 21:00 — `ROOM_CAPACITY_BIN_MINUTES = 30` ([`analysis.ts:16,164-215`](../../../src/lib/room-capacity/analysis.ts)). The response therefore grows as `days × activeRooms × 28` cells per source, and both `current` and `projected` carry a full set.
- **Room matching** is by normalized label (TV emoji, `(Lab)`, and a trailing `(TV)` stripped, whitespace collapsed), lower-cased, against **active** rooms only ([`analysis.ts:18-26,37-45`](../../../src/lib/room-capacity/analysis.ts)).

**Side effects:** `ensureDefaultClassroomRooms` writes. No Wise call, and no run is persisted — the month view stores nothing of its own.

**Status codes:**

| Status | When |
|---|---|
| 200 | Payload returned. |
| 401 | No session ([`month/route.ts:8-10`](../../../src/app/api/room-capacity/month/route.ts)). |
| 500 | Any thrown error; body `{ error: <message> }`, fallback `Failed to load room capacity` ([`month/route.ts:18-21`](../../../src/app/api/room-capacity/month/route.ts)). Notably `No active Wise snapshot found` ([`data.ts:43`](../../../src/lib/room-capacity/data.ts)) lands here. |

---

### `GET /api/room-capacity/forecast`

Weekday saturation dates plus the weekend-demand revenue breakpoint for one growth scenario, simulated on demand from the imported model run seeded with the live schedule. Handler: [`forecast/route.ts:43-61`](../../../src/app/api/room-capacity/forecast/route.ts); service: `getRoomCapacityForecast` [`data.ts:385-444`](../../../src/lib/room-capacity/data.ts).

**Auth:** session required ([`forecast/route.ts:44-47`](../../../src/app/api/room-capacity/forecast/route.ts)).

**Query parameters:**

| Param | Type | Default | Notes |
|---|---|---|---|
| `scenario` | string | `Base` | `searchParams.get("scenario") \|\| "Base"` ([`forecast/route.ts:49`](../../../src/app/api/room-capacity/forecast/route.ts)), so an empty string also resolves to `Base`. Not validated against the known scenario set; an unknown value triggers the fallback below rather than an error. |

**Scenario fallback.** If no driver rows match the requested scenario, the service silently falls back to the first scenario alphabetically and simulates that instead ([`data.ts:394-397`](../../../src/lib/room-capacity/data.ts)). The response's `scenario` field is the **effective** scenario, not the requested one ([`data.ts:436`](../../../src/lib/room-capacity/data.ts)) — compare it against your request before labelling the result.

**Response 200** — `RoomCapacityForecastResponse` ([`types.ts:304-320`](../../../src/lib/room-capacity/types.ts)), returned bare:

| Key | Type | Meaning |
|---|---|---|
| `model` | object | `{ status: "ready" \| "missing", modelRunId, sourceLabel, forecastStart, forecastEnd, importedAt }` from the newest `room_capacity_model_runs` row by `createdAt` ([`data.ts:293-300,428-435`](../../../src/lib/room-capacity/data.ts)). |
| `scenario` | string | Effective scenario (see fallback above). |
| `scenarios` | string[] | Distinct scenario names present in the run's drivers, sorted ([`data.ts:394`](../../../src/lib/room-capacity/data.ts)). |
| `generatedAt` | string | ISO timestamp of this request. |
| `weekdayResults` | `WeekdaySaturationResult[]` | Per weekday: `roomSlotFullDate`, `roomTutorFullDate`, and the matching `*Reason` strings, all nullable ([`types.ts:174-181`](../../../src/lib/room-capacity/types.ts)); produced by `simulateSaturation` ([`forecast.ts:473`](../../../src/lib/room-capacity/forecast.ts)). |
| `weekendDemandBreakpoint` | object \| null | `WeekendDemandBreakpoint` ([`types.ts:212-219`](../../../src/lib/room-capacity/types.ts)) — combined plus per-day `WeekendDemandBreakpointResult` with `status: "reached" \| "reached_extrapolated" \| "not_reached"` ([`types.ts:195-210`](../../../src/lib/room-capacity/types.ts)); from `simulateWeekendDemandBreakpoint`, which itself returns `null` when it cannot simulate ([`forecast.ts:753`](../../../src/lib/room-capacity/forecast.ts)). |
| `weekendDemandCaptureReadiness` | object \| null | `WeekendDemandCaptureReadiness` — `ready` plus machine-readable `reasonCodes` (`missing_package_mix`, `missing_scenario_drivers`, `no_active_physical_rooms`, `missing_seed_sessions`, `no_weekend_onsite_schedule`, `zero_weekend_preference_distribution`) and the input row counts behind them ([`types.ts:283-302`](../../../src/lib/room-capacity/types.ts), [`forecast.ts:345`](../../../src/lib/room-capacity/forecast.ts)). Read this before trusting `weekendDemandBreakpoint`. |
| `monthlyDrivers` | `RoomCapacityForecastDriver[]` | The effective scenario's driver rows ([`types.ts:141-150`](../../../src/lib/room-capacity/types.ts)). |

Inputs assembled per request ([`data.ts:390-425`](../../../src/lib/room-capacity/data.ts)): the latest model run; its drivers, demand mix, and package mix (`room_capacity_forecast_drivers` / `_demand_mix` / `_package_mix`, [`data.ts:302-356`](../../../src/lib/room-capacity/data.ts)); the classroom catalogue; snapshot sessions from `modelRun.forecastStart` through the end of the last driver month ([`data.ts:398-403`](../../../src/lib/room-capacity/data.ts)); the latest per-date assignment overrides; and the in-memory search index. When the run has **no** stored demand mix, one is derived from the seed schedule instead ([`data.ts:408`](../../../src/lib/room-capacity/data.ts), [`forecast.ts:832`](../../../src/lib/room-capacity/forecast.ts)).

**Two distinct "missing model" paths — both return HTTP 200:**

1. **No model run at all.** `getRoomCapacityForecast` short-circuits to `missingForecastResponse(scenario)`: `model.status = "missing"`, empty `scenarios` and `monthlyDrivers`, null breakpoint and readiness, and seven all-null `weekdayResults` ([`data.ts:358-383,390-391`](../../../src/lib/room-capacity/data.ts)).
2. **Aggregate tables absent.** The route catches the thrown error and returns its own near-identical `missingForecastBody(scenario)` ([`forecast/route.ts:16-41,55-57`](../../../src/app/api/room-capacity/forecast/route.ts)). Detection is a plain **substring** test for `room_capacity_model_runs`, `room_capacity_forecast_drivers`, `room_capacity_demand_mix`, or `room_capacity_package_mix` anywhere in the message ([`forecast/route.ts:6-14`](../../../src/app/api/room-capacity/forecast/route.ts)) — it does not check for `relation … does not exist`, so **any** failure whose message happens to name one of those tables is also masked as `status: "missing"` with a 200. The two payload builders are duplicated, not shared.

**Side effects (this is the heaviest read endpoint):**

- `ensureDefaultClassroomRooms` writes, as on the other reads.
- `ensureIndex(db)` is called ([`data.ts:409`](../../../src/lib/room-capacity/data.ts)) — this may build or rebuild the process-global in-memory search index ([`search/index.ts:354`](../../../src/lib/search/index.ts)), a full snapshot load on a cold process.
- The saturation and weekend simulations run inline over the whole seed window; nothing is persisted, so every request repeats the work.

**Status codes:**

| Status | When |
|---|---|
| 200 | Forecast returned, **or** either missing-model path above. |
| 401 | No session ([`forecast/route.ts:45-47`](../../../src/app/api/room-capacity/forecast/route.ts)). |
| 500 | Any thrown error whose message does not name one of the four aggregate tables; body `{ error: <message> }`, fallback `Failed to load room capacity forecast` ([`forecast/route.ts:58-59`](../../../src/app/api/room-capacity/forecast/route.ts)). `No active Wise snapshot found` lands here. |

---

## Internal sync endpoint

### `POST /api/internal/sync-room-utilization`

Refreshes `room_utilization_sessions` from Wise. This is the only writer of that table and the only Wise call in the feature. Handler: [`sync-room-utilization/route.ts:26-54`](../../../src/app/api/internal/sync-room-utilization/route.ts); service: `syncRoomUtilizationSessions` [`utilization.ts:427-472`](../../../src/lib/room-capacity/utilization.ts).

**`POST` only, and not on a schedule.** The file exports no `GET` ([`sync-room-utilization/route.ts:26`](../../../src/app/api/internal/sync-room-utilization/route.ts)), and the path is absent from `vercel.json`. The cron registry records it as `schedule: null`, `cadenceLabel: "Manual only"`, `manualOnly: true`, `routeMethod: "POST"`, `maxDurationSeconds: 800` ([`cron-registry.ts:343-357`](../../../src/lib/data-health/cron-registry.ts)), and a registry test asserts the path is *not* in the `vercel.json` cron set ([`cron-registry.test.ts:35`](../../../src/lib/data-health/__tests__/cron-registry.test.ts)). The route sets `export const maxDuration = 800` ([`sync-room-utilization/route.ts:8`](../../../src/app/api/internal/sync-room-utilization/route.ts)).

**Auth — cron secret first, session fallback** ([`sync-room-utilization/route.ts:10-40`](../../../src/app/api/internal/sync-room-utilization/route.ts)):

1. `Authorization` is compared constant-time against `Bearer ${CRON_SECRET}` with a length pre-check before `timingSafeEqual` ([`:12-24`](../../../src/app/api/internal/sync-room-utilization/route.ts)). A match sets `triggerSource: "cron"`.
2. Otherwise `auth()` runs. A session sets `triggerSource: "admin"` and stamps `actorEmail` from `session.user?.email ?? null` ([`:38-39`](../../../src/app/api/internal/sync-room-utilization/route.ts)).
3. No session and `CRON_SECRET` unset → **500** `{"error":"Server misconfigured"}`; no session and a wrong or absent header → **401** `{"error":"Unauthorized"}` ([`:32-37`](../../../src/app/api/internal/sync-room-utilization/route.ts)).

This route inlines its own secret check rather than importing the shared helper in [`src/lib/internal/cron-auth.ts`](../../../src/lib/internal/cron-auth.ts); the comparison is equivalent.

**Request:** no body is read and no query parameter is consulted — anything sent is ignored. `syncRoomUtilizationSessions(getDb())` is called with no input ([`:46`](../../../src/app/api/internal/sync-room-utilization/route.ts)), so `startDate` always defaults to `ROOM_UTILIZATION_HISTORY_START = "2026-03-01"` ([`utilization.ts:20,431`](../../../src/lib/room-capacity/utilization.ts)). The service *accepts* `{ startDate, syncedAt }` ([`utilization.ts:427-430`](../../../src/lib/room-capacity/utilization.ts)), but no HTTP caller can set them — only [`scripts/sync-room-utilization.ts`](../../../scripts/sync-room-utilization.ts) and the data-health job runner reach the function directly.

**Response 200:**

```json
{ "ok": true, "fetchedCount": 0, "storedCount": 0, "startDate": "2026-03-01", "syncedAt": "2026-05-31T00:00:00.000Z" }
```

`fetchedCount` is every session Wise returned; `storedCount` is the subset actually upserted after filtering ([`utilization.ts:466-471`](../../../src/lib/room-capacity/utilization.ts), spread into `{ ok: true, ... }` at [`route.ts:47`](../../../src/app/api/internal/sync-room-utilization/route.ts)).

**Side effects:**

1. **Audit row.** The whole handler body is wrapped in `withCronInvocationAudit({ jobKey: "room_utilization", triggerSource, actorEmail, requestMethod })` ([`route.ts:42-53`](../../../src/app/api/internal/sync-room-utilization/route.ts)), which inserts a `cron_invocations` row with `outcome: "running"` before the work and updates it afterwards with `finishedAt`, `durationMs`, `responseStatus`, a derived `outcome`, `errorSummary`, and `linkedRunIds` ([`cron-audit.ts:84-142`](../../../src/lib/data-health/cron-audit.ts)). The 401 and 500-misconfig rejections return *before* the wrapper, so unauthorized attempts are not audited. Audit failures are swallowed with `console.error` and never fail the request ([`cron-audit.ts:108-111,139-141`](../../../src/lib/data-health/cron-audit.ts)).
2. **Wise fetch.** `fetchAllInstituteSessions(createWiseClient(), instituteId)` is called with **no `status` filter** ([`utilization.ts:436`](../../../src/lib/room-capacity/utilization.ts)), paginating `/institutes/{id}/sessions` at `page_size=1000` until an empty page or the reported `page_count` ([`fetchers.ts:117-147`](../../../src/lib/wise/fetchers.ts), `PAGE_LIMIT` at [`fetchers.ts:24`](../../../src/lib/wise/fetchers.ts)). Requires `WISE_INSTITUTE_ID`, else it throws `WISE_INSTITUTE_ID is required to sync room utilization` ([`utilization.ts:433-434`](../../../src/lib/room-capacity/utilization.ts)).
3. **Upsert.** Rows are mapped by `wiseSessionToUtilizationRow` — skipping any session missing `_id`, `scheduledStartTime`, or `scheduledEndTime`, or with an unparseable timestamp ([`utilization.ts:400-425`](../../../src/lib/room-capacity/utilization.ts)) — then filtered to `utilizationDate >= startDate` ([`:437-439`](../../../src/lib/room-capacity/utilization.ts)) and written in chunks of 500 (`INSERT_CHUNK_SIZE`, [`:54,441-464`](../../../src/lib/room-capacity/utilization.ts)) via `onConflictDoUpdate` on the unique `wise_session_id` index ([`schema.ts:1753`](../../../src/lib/db/schema.ts)). A session whose end lands on the next Bangkok day is clamped to minute `1440` ([`utilization.ts:416`](../../../src/lib/room-capacity/utilization.ts)).
4. **No deletes, no single-flight guard, no `*_sync_runs` row.** The sync never removes rows for sessions Wise no longer returns, and unlike the other pipelines it has no `running`-row guard — two concurrent invocations both execute in full. Idempotence rests entirely on the unique-key upsert.

**Status codes:**

| Status | When |
|---|---|
| 200 | `{ ok: true, ... }` ([`route.ts:47`](../../../src/app/api/internal/sync-room-utilization/route.ts)). |
| 401 | No valid cron secret and no session ([`route.ts:36`](../../../src/app/api/internal/sync-room-utilization/route.ts)). |
| 500 | `CRON_SECRET` unset and no session → `{"error":"Server misconfigured"}` ([`route.ts:34`](../../../src/app/api/internal/sync-room-utilization/route.ts)); sync failure → `{ error: <message> }`, fallback `Failed to sync room utilization` ([`route.ts:48-50`](../../../src/app/api/internal/sync-room-utilization/route.ts)); an error escaping the wrapper → `{ error: <message> }`, fallback `Cron invocation failed` ([`cron-audit.ts:152-157`](../../../src/lib/data-health/cron-audit.ts)). |

**Equivalent trigger elsewhere.** `POST /api/data-health/jobs/room_utilization/run` calls the same `syncRoomUtilizationSessions(getDb())` in-process and returns the same `{ ok: true, ... }` body ([`run-job.ts:185-192`](../../../src/lib/data-health/run-job.ts)). That endpoint belongs to the Data Health group and is documented there, not here.

---

## Open questions

- **Unfiltered Wise session fetch.** The sync deliberately omits `status` ([`utilization.ts:436`](../../../src/lib/room-capacity/utilization.ts)) and the aggregator has explicit handling for finished statuses (`ENDED`, `MISSED`, `NO_SHOW`, [`:55-56`](../../../src/lib/room-capacity/utilization.ts)), which implies past sessions are expected back. Whether Wise actually returns past sessions on that unfiltered call is external API behaviour no file in this repo proves.
- **`month` and `forecast` have no caller.** Both are authenticated, tested, and reachable, but nothing under `src/` fetches them — the only in-repo consumers of the group are the utilization read and the sync `POST`. Whether they are pre-built for an upcoming UI or effectively dormant is not recorded in code.
- **Forecast missing-table detection is a substring match.** [`forecast/route.ts:6-14`](../../../src/app/api/room-capacity/forecast/route.ts) converts any error mentioning one of the four table names into a 200 `status: "missing"` response, masking genuine failures. Whether the narrower `relation … does not exist` check used by other optional-table routes was intended here is unclear.
- **`month` performs no date validation.** A malformed `startDate`/`endDate` surfaces as a 500 instead of the 400 the sibling utilization route returns. It is not clear whether that asymmetry is deliberate.
- **`syncRoomUtilizationSessions` accepts `startDate`, but no HTTP path can set it.** Backfills earlier than `2026-03-01` are only reachable through the script or the data-health job runner.

_Verified against HEAD + uncommitted WIP on 2026-05-31._
