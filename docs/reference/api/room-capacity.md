# Room Capacity API

**Authoritative source:** the three read handlers under [`src/app/api/room-capacity/`](../../../src/app/api/room-capacity/) plus the one write handler at [`src/app/api/internal/sync-room-utilization/route.ts`](../../../src/app/api/internal/sync-room-utilization/route.ts). Feature status is declared by [docs/features/room-capacity.md](../../features/room-capacity.md); this page does not restate it.

This page is the mechanical reference for the four Room Capacity HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. Meaning — what utilization measures, why the month and forecast views exist, how saturation is reasoned about — lives in [docs/features/room-capacity.md](../../features/room-capacity.md). Table grain and relationships live in [docs/reference/database/erd-room-capacity.md](../database/erd-room-capacity.md); the store this feature writes, `room_utilization_sessions`, is declared at [`schema.ts:1739-1759`](../../../src/lib/db/schema.ts).

## Endpoint summary

| Method | Path | Auth | Handler |
|---|---|---|---|
| `POST` | `/api/internal/sync-room-utilization` | `CRON_SECRET` **or** any session | [`sync-room-utilization/route.ts:26-54`](../../../src/app/api/internal/sync-room-utilization/route.ts) |
| `GET` | `/api/room-capacity/forecast` | session | [`forecast/route.ts:43-61`](../../../src/app/api/room-capacity/forecast/route.ts) |
| `GET` | `/api/room-capacity/month` | session | [`month/route.ts:6-22`](../../../src/app/api/room-capacity/month/route.ts) |
| `GET` | `/api/room-capacity/utilization` | session | [`utilization/route.ts:6-29`](../../../src/app/api/room-capacity/utilization/route.ts) |

Only two of the four have an in-repo caller. The dashboard fetches the utilization read at [`room-capacity-dashboard.tsx:354`](../../../src/components/room-capacity/room-capacity-dashboard.tsx) and the sync `POST` at [`:375`](../../../src/components/room-capacity/room-capacity-dashboard.tsx); the page itself is a one-line wrapper around that component ([`(app)/room-capacity/page.tsx:3-5`](<../../../src/app/(app)/room-capacity/page.tsx>)). `month` and `forecast` are authenticated, implemented, and unit-tested ([`__tests__/route.test.ts`](../../../src/app/api/room-capacity/__tests__/route.test.ts)) but nothing in `src/` fetches either.

**There is no scheduled cron for this feature.** `vercel.json` declares 19 cron paths and none of them contains `room`. The sync is registered in the in-app registry as `schedule: null`, `cadenceLabel: "Manual only"`, `manualOnly: true`, `maxDurationSeconds: 800`, `routeMethod: "POST"` ([`cron-registry.ts`](../../../src/lib/data-health/cron-registry.ts)), so the only way it runs is an explicit `POST` — from the dashboard button, or from an external caller holding `CRON_SECRET`.

## Conventions shared across the endpoints

- **No Zod anywhere.** None of the four handlers declares a schema. The three `GET` routes read raw `searchParams` strings and hand them straight to the service layer; the `POST` route never reads a body at all. Validation, where it exists, is hand-written regex plus thrown `Error` messages that a handler maps to a status code by **string prefix** or **substring**, not by error type.
- **No response envelope on reads.** All three `GET` routes return the service object bare — no `ok`/`result` wrapper. The `POST` route is the exception: it spreads the sync result into `{ ok: true, ... }` ([`sync-room-utilization/route.ts:47`](../../../src/app/api/internal/sync-room-utilization/route.ts)).
- **No caching.** None of the four files declares `"use cache"`, `cacheTag`, `revalidate`, or `dynamic`. The only route segment config in the feature is `export const maxDuration = 800` on the sync route ([`sync-room-utilization/route.ts:8`](../../../src/app/api/internal/sync-room-utilization/route.ts)); the three reads run on the platform default. Every request recomputes from Postgres.
- **No role check.** Authorization for every read is `auth()` returning *any* session — there is no room-capacity-specific role, capability, or allowlist guard in the handlers.
- **Middleware gating differs by prefix.** `/api/room-capacity/**` is *not* on the public allowlist ([`middleware.ts:10-25`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:89-93`](../../../src/middleware.ts)), and a restricted user whose `allowedPages` omits `/room-capacity` gets a middleware-level **403** `{"error":"Forbidden"}` — `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:59-66,97-100`](../../../src/middleware.ts)). `/api/internal/*` **is** allowlisted ([`middleware.ts:24`](../../../src/middleware.ts)), so the sync route's own secret-or-session check is its only gate.
- **All dates are Asia/Bangkok calendar dates** in `YYYY-MM-DD` form, resolved through [`src/lib/room-capacity/dates.ts`](../../../src/lib/room-capacity/dates.ts) (`bangkokDateKey` at [`:22-25`](../../../src/lib/room-capacity/dates.ts), `todayBangkok` at [`:27-29`](../../../src/lib/room-capacity/dates.ts)).
- **Reads are not write-free.** All three `GET` routes reach `listClassroomRooms`, which first awaits `ensureDefaultClassroomRooms` — inserting missing default rooms, `UPDATE`-ing drifted attributes back to the defaults, and deactivating superseded TV rooms ([`classrooms/data.ts:431-487`](../../../src/lib/classrooms/data.ts), called at [`:490-491`](../../../src/lib/classrooms/data.ts)). Call sites: [`utilization.ts:493`](../../../src/lib/room-capacity/utilization.ts), [`data.ts:237`](../../../src/lib/room-capacity/data.ts), [`data.ts:402`](../../../src/lib/room-capacity/data.ts).
- **Nothing here writes back to Wise.** The only outbound Wise call in the feature is the sync's read of institute sessions.

---

## Sync (`/api/internal/*`)

### `POST /api/internal/sync-room-utilization`

Pulls every institute session from Wise, normalizes each one to a Bangkok date / weekday / minute window / cleaned room label, and upserts it into `room_utilization_sessions`. Handler: [`sync-room-utilization/route.ts:26-54`](../../../src/app/api/internal/sync-room-utilization/route.ts); service: `syncRoomUtilizationSessions` [`utilization.ts:427-472`](../../../src/lib/room-capacity/utilization.ts).

`export const maxDuration = 800` ([`:8`](../../../src/app/api/internal/sync-room-utilization/route.ts)). **Only `POST` is exported** — a `GET` to this path is not handled.

**Auth — two accepted credentials, checked in order** ([`:12-40`](../../../src/app/api/internal/sync-room-utilization/route.ts)):

1. `Authorization: Bearer ${CRON_SECRET}`, compared with a length pre-check plus `timingSafeEqual` ([`:18-21`](../../../src/app/api/internal/sync-room-utilization/route.ts)). A match sets `triggerSource = "cron"` and `actorEmail = null`.
2. Otherwise `auth()`. A session sets `triggerSource = "admin"` and stamps `session.user?.email ?? null` as the actor ([`:38-39`](../../../src/app/api/internal/sync-room-utilization/route.ts)). This is the path the dashboard button takes — it posts with no `Authorization` header at all.

`hasValidCronSecret` returns a three-state result, and the unset-secret case is **not** collapsed into "invalid": when `process.env.CRON_SECRET` is missing *and* there is no session, the handler returns **500 `{"error":"Server misconfigured"}`**, not 401 ([`:33-35`](../../../src/app/api/internal/sync-room-utilization/route.ts)). A session still succeeds in that state.

**Request:** no query parameters, no body. `request.json()` is never called, so any posted body and its `Content-Type` are ignored. In particular the service's `startDate` argument is **not** reachable over HTTP — the handler calls `syncRoomUtilizationSessions(getDb())` with no input ([`:46`](../../../src/app/api/internal/sync-room-utilization/route.ts)), so the start bound is always the constant `ROOM_UTILIZATION_HISTORY_START = "2026-03-01"` ([`utilization.ts:20,431`](../../../src/lib/room-capacity/utilization.ts)).

**Response 200:**

```json
{ "ok": true, "fetchedCount": 4821, "storedCount": 3907, "startDate": "2026-03-01", "syncedAt": "2026-09-02T03:00:00.000Z" }
```

| Key | Type | Meaning |
|---|---|---|
| `ok` | `true` | Literal, added by the handler ([`:47`](../../../src/app/api/internal/sync-room-utilization/route.ts)). |
| `fetchedCount` | number | Sessions returned by Wise, before filtering ([`utilization.ts:467`](../../../src/lib/room-capacity/utilization.ts)). |
| `storedCount` | number | Rows actually upserted — those that parsed and whose `utilizationDate >= startDate` ([`utilization.ts:437-439,468`](../../../src/lib/room-capacity/utilization.ts)). |
| `startDate` | string | The effective history floor, always `2026-03-01` over HTTP. |
| `syncedAt` | string (ISO) | The single timestamp stamped on every row in the run. |

**Side effects:**

- **Wise read.** `fetchAllInstituteSessions(createWiseClient(), instituteId)` is called with **no `status` filter**, so it pages the full institute session list — past and future ([`utilization.ts:436`](../../../src/lib/room-capacity/utilization.ts), fetcher at [`fetchers.ts:117-147`](../../../src/lib/wise/fetchers.ts)). `WISE_INSTITUTE_ID` is read directly from `process.env` and its absence throws ([`utilization.ts:433-434`](../../../src/lib/room-capacity/utilization.ts)).
- **Postgres upsert.** Rows are written in chunks of 500 (`INSERT_CHUNK_SIZE`, [`utilization.ts:54,441-463`](../../../src/lib/room-capacity/utilization.ts)) with `onConflictDoUpdate` on the `wise_session_id` unique index ([`schema.ts:1756`](../../../src/lib/db/schema.ts)). Every mapped column is overwritten from `excluded`. **Nothing is deleted** — a session that disappears from Wise keeps its last-known row, and rows older than the history floor are never revisited.
- **Per-row normalization** happens in `wiseSessionToUtilizationRow` ([`utilization.ts:400-425`](../../../src/lib/room-capacity/utilization.ts)): a session missing `_id`, `scheduledStartTime`, or `scheduledEndTime`, or carrying an unparseable timestamp, is dropped (`null`); `wiseStatus` falls back to the literal `"UNKNOWN"`; a session crossing midnight in Bangkok has its `endMinute` clamped to `1440`; `normalizedRoomLabel` comes from `normalizeRoomLabel` ([`analysis.ts:18`](../../../src/lib/room-capacity/analysis.ts)).
- **Cron audit row.** The whole handler body runs inside `withCronInvocationAudit({ jobKey: "room_utilization", ... })` ([`:42-53`](../../../src/app/api/internal/sync-room-utilization/route.ts)), which inserts a `cron_invocations` row with `outcome: "running"` before the work and updates it afterwards with `finishedAt`, `durationMs`, `responseStatus`, a size-capped response digest, and a derived outcome ([`cron-audit.ts:131-189`](../../../src/lib/data-health/cron-audit.ts)). A response status ≥ 400 is recorded as `failed` ([`cron-audit.ts:108-117`](../../../src/lib/data-health/cron-audit.ts)). Audit-write failures are swallowed with `console.error` and never change the response.
- **No single-flight guard and no `*_sync_runs` ledger.** Unlike the Wise snapshot, credit-control, sales, and post-class lineages, this sync has no `running`-row guard and no run table of its own; two concurrent `POST`s both fetch and both upsert. `cron_invocations` is the only durable record that a run happened.

**Status codes:**

| Status | When | Body |
|---|---|---|
| 200 | Sync completed. | `{ ok: true, ... }` as above. |
| 401 | `CRON_SECRET` is set, the header did not match, and there is no session ([`:36`](../../../src/app/api/internal/sync-room-utilization/route.ts)). | `{"error":"Unauthorized"}` |
| 500 | `CRON_SECRET` is unset **and** there is no session ([`:34`](../../../src/app/api/internal/sync-room-utilization/route.ts)). | `{"error":"Server misconfigured"}` |
| 500 | The service threw — Wise error, missing `WISE_INSTITUTE_ID`, bad `startDate`, DB failure ([`:48-51`](../../../src/app/api/internal/sync-room-utilization/route.ts)). | `{ error: <message> }` |
| 500 | Anything thrown outside the inner `try`, caught by the audit wrapper ([`cron-audit.ts:200-205`](../../../src/lib/data-health/cron-audit.ts)). | `{ error: <message> }` |

Note the 401/500 asymmetry: the two auth-failure branches are decided **before** the audit wrapper runs, so a rejected request writes no `cron_invocations` row.

---

## Reads (`/api/room-capacity/*`)

All three share the same preamble — `const session = await auth(); if (!session) return 401 {"error":"Unauthorized"}` — accept no request body, and read every input from query parameters.

### `GET /api/room-capacity/forecast`

Runs the saturation and weekend-demand simulations for one growth scenario, seeded from an imported model run plus the live Wise schedule. Handler: [`forecast/route.ts:43-61`](../../../src/app/api/room-capacity/forecast/route.ts); service: `getRoomCapacityForecast` [`data.ts:385-443`](../../../src/lib/room-capacity/data.ts).

**Auth:** session required ([`forecast/route.ts:44-47`](../../../src/app/api/room-capacity/forecast/route.ts)).

**Query parameters:**

| Param | Type | Default | Notes |
|---|---|---|---|
| `scenario` | string | `"Base"` | `searchParams.get("scenario") \|\| "Base"` ([`:49`](../../../src/app/api/room-capacity/forecast/route.ts)). The `\|\|` (not `??`) means a present-but-empty `?scenario=` also falls back to `Base`. Not validated against any enum: an unknown scenario yields no drivers, and the service silently falls back to the **first** scenario present in the model run, echoing that name back in `scenario` ([`data.ts:394-397,436`](../../../src/lib/room-capacity/data.ts)). |

**Response 200** — a bare `RoomCapacityForecastResponse` ([`types.ts:304-320`](../../../src/lib/room-capacity/types.ts)):

| Key | Type | Meaning |
|---|---|---|
| `model` | object | `{ status: "ready" \| "missing", modelRunId, sourceLabel, forecastStart, forecastEnd, importedAt }` — the latest `room_capacity_model_runs` row by `createdAt` ([`data.ts:293-300,428-435`](../../../src/lib/room-capacity/data.ts)). All fields but `status` are `null` when `status` is `"missing"`. |
| `scenario` | string | The scenario actually simulated (may differ from the request, see above). |
| `scenarios` | string[] | Sorted distinct scenario names found in the run's drivers ([`data.ts:394`](../../../src/lib/room-capacity/data.ts)). |
| `generatedAt` | string (ISO) | Response timestamp. |
| `weekdayResults` | `WeekdaySaturationResult[]` | Per weekday `{ weekday, weekdayName, roomSlotFullDate, roomTutorFullDate, roomSlotReason, roomTutorReason }` ([`types.ts:174-181`](../../../src/lib/room-capacity/types.ts)), from `simulateSaturation` ([`forecast.ts:473`](../../../src/lib/room-capacity/forecast.ts)). |
| `weekendDemandBreakpoint` | `WeekendDemandBreakpoint` \| null | `{ preferenceSource, policy, openHours, weekendDemandShare, combined, byDay }` ([`types.ts:212-219`](../../../src/lib/room-capacity/types.ts)), from `simulateWeekendDemandBreakpoint` ([`forecast.ts:753`](../../../src/lib/room-capacity/forecast.ts)); each result carries `breakpointMonth`, a `"reached" \| "reached_extrapolated" \| "not_reached"` status, captured/lost revenue and students, and top slot summaries ([`types.ts:183-210`](../../../src/lib/room-capacity/types.ts)). |
| `weekendDemandCaptureReadiness` | `WeekendDemandCaptureReadiness` \| null | `{ ready, reasonCodes, ...row counts, generatedAt }` — six documented `reasonCodes` ([`types.ts:283-302`](../../../src/lib/room-capacity/types.ts)), from [`forecast.ts:345`](../../../src/lib/room-capacity/forecast.ts). |
| `monthlyDrivers` | `RoomCapacityForecastDriver[]` | The selected scenario's per-month drivers: `newPaidStudents`, `forecastConsumedHours`, `scheduledHours`, `capacityUtilizationPct`, `capacityExceeded`, `projectedRevenueThb` ([`types.ts:141-150`](../../../src/lib/room-capacity/types.ts)). |

**The "missing model" response is produced in two different places, and both return 200.**

- **Service-side** ([`data.ts:358-383,391`](../../../src/lib/room-capacity/data.ts)) — the tables exist but hold no model run.
- **Route-side** ([`forecast/route.ts:16-41,55-57`](../../../src/app/api/room-capacity/forecast/route.ts)) — the service *threw*, and `isMissingForecastTableError` matched. That guard is a plain **substring** test for `room_capacity_model_runs`, `room_capacity_forecast_drivers`, `room_capacity_demand_mix`, or `room_capacity_package_mix` anywhere in the message ([`:6-14`](../../../src/app/api/room-capacity/forecast/route.ts)) — it does **not** require "relation … does not exist", so any failure whose message merely names one of those tables (a permission error, a constraint violation) is reported to the client as an empty-but-healthy forecast rather than a 500.

Both shapes are identical: `model.status: "missing"`, empty `scenarios` and `monthlyDrivers`, `null` breakpoint and readiness, and a 7-element `weekdayResults` array of all-`null` weekday rows carrying only `weekday` and `weekdayName`. The requested `scenario` is echoed back verbatim. The route's copy is a hand-maintained duplicate of the service's ([`data.ts:358-383`](../../../src/lib/room-capacity/data.ts) vs [`forecast/route.ts:16-41`](../../../src/app/api/room-capacity/forecast/route.ts)).

**Side effects:** the heaviest read in the feature. Besides `ensureDefaultClassroomRooms`, it requires an active Wise snapshot (`getActiveSnapshot`, throwing `No active Wise snapshot found` when none — [`data.ts:37-45`](../../../src/lib/room-capacity/data.ts)), loads blocking `future_session_blocks` across the whole forecast horizon ([`data.ts:403`](../../../src/lib/room-capacity/data.ts)), re-runs the shared classroom assignment engine over every seeded day ([`data.ts:193-227,405`](../../../src/lib/room-capacity/data.ts)), and calls `ensureIndex(db)` ([`data.ts:409`](../../../src/lib/room-capacity/data.ts)), which **builds or rebuilds the process-global in-memory search index** when it is cold or stale ([`search/index.ts:354`](../../../src/lib/search/index.ts)). Nothing is persisted.

**Status codes:**

| Status | When |
|---|---|
| 200 | Forecast returned, **or** the missing-model body ([`:53,56`](../../../src/app/api/room-capacity/forecast/route.ts)). |
| 401 | No session. |
| 500 | Any thrown error whose message does not name one of the four `room_capacity_*` tables; body `{ error: <message> }` ([`:58-59`](../../../src/app/api/room-capacity/forecast/route.ts)). |

There is **no 400** on this route — `scenario` is never rejected.

### `GET /api/room-capacity/month`

Room-pressure comparison for a Bangkok date range: what Wise's own `location` values imply ("current") versus what the assignment engine would produce ("projected"). Handler: [`month/route.ts:6-22`](../../../src/app/api/room-capacity/month/route.ts); service: `getRoomCapacityMonth` [`data.ts:229-291`](../../../src/lib/room-capacity/data.ts).

**Auth:** session required ([`month/route.ts:7-10`](../../../src/app/api/room-capacity/month/route.ts)).

**Query parameters:**

| Param | Type | Default | Notes |
|---|---|---|---|
| `startDate` | string (`YYYY-MM-DD`) | today in Bangkok | Passed through as `null` when absent ([`:12,16`](../../../src/app/api/room-capacity/month/route.ts)); the service applies `defaultRoomCapacityRange()` via `??` ([`data.ts:233-235`](../../../src/lib/room-capacity/data.ts), default at [`dates.ts:69-75`](../../../src/lib/room-capacity/dates.ts)). |
| `endDate` | string (`YYYY-MM-DD`) | end of the start month | Same mechanism; `endOfBangkokMonth(startDate)` ([`dates.ts:63-67`](../../../src/lib/room-capacity/dates.ts)). |

**Neither parameter is validated.** Unlike the utilization route, `getRoomCapacityMonth` performs no ISO-format assertion and no ordering check — the strings go straight into `bangkokDateStartUtc` and the Drizzle range predicate ([`data.ts:76-77,238-239`](../../../src/lib/room-capacity/data.ts)). A malformed value therefore surfaces as a **500**, not a 400, and an inverted range simply returns an empty result. Because the fallback is `??` and not `||`, a present-but-empty `?startDate=` is *not* replaced by the default.

**Response 200** — a bare `RoomCapacityMonthResponse` ([`types.ts:109-139`](../../../src/lib/room-capacity/types.ts)):

| Key | Type | Meaning |
|---|---|---|
| `range` | object | `{ startDate, endDate, generatedAt }` — the effective range, echoed after defaulting ([`data.ts:268`](../../../src/lib/room-capacity/data.ts)). |
| `snapshotMeta` | object | `{ snapshotId, syncedAt }` for the active Wise snapshot the sessions were read from ([`data.ts:269`](../../../src/lib/room-capacity/data.ts)). |
| `rooms` | `RoomCapacityRoom[]` | `{ id, name, capacity, hasTv, category, active, sortOrder }` ([`types.ts:3-11`](../../../src/lib/room-capacity/types.ts)). |
| `kpis` | object | `currentOvercapIntervals`, `impactedRooms` (distinct room names in the current overcaps), `projectedNoRoomSessions`, `unmatchedCurrentAllocations`, `peakLoadRatio` ([`data.ts:271-277`](../../../src/lib/room-capacity/data.ts)). |
| `current` | object | `{ overcaps, unmatchedAllocations, heatmapCells, daySummaries }` derived from Wise `location` values as-is. |
| `projected` | object | `{ overcaps, noRoomRows, heatmapCells, daySummaries }` derived from a re-run of the assignment engine. |

Element shapes: `RoomCapacityOvercapInterval` ([`types.ts:54-67`](../../../src/lib/room-capacity/types.ts)), `RoomCapacityUnmatchedAllocation` — with `reason: "missing_location" | "unknown_room"` ([`types.ts:69-79`](../../../src/lib/room-capacity/types.ts)), `RoomCapacityNoRoomRow` ([`types.ts:81-93`](../../../src/lib/room-capacity/types.ts)), `RoomCapacityHeatmapCell` — 30-minute bins with `status: "empty" | "occupied" | "full" | "over_capacity" | "review"` ([`types.ts:39-52`](../../../src/lib/room-capacity/types.ts), bin width at [`analysis.ts:16`](../../../src/lib/room-capacity/analysis.ts)), `RoomCapacityDaySummary` ([`types.ts:95-107`](../../../src/lib/room-capacity/types.ts)).

**Side effects:** requires an active Wise snapshot and throws `No active Wise snapshot found` when there is none ([`data.ts:37-45,236`](../../../src/lib/room-capacity/data.ts)); reads blocking `future_session_blocks` joined to `tutor_identity_groups` for the range ([`data.ts:70-125`](../../../src/lib/room-capacity/data.ts)); reads the latest classroom assignment run per date and its `overrideRoom` values ([`data.ts:127-167`](../../../src/lib/room-capacity/data.ts)); re-runs `assignClassrooms` per day in memory ([`data.ts:193-227`](../../../src/lib/room-capacity/data.ts)). It **persists nothing** — no assignment run row is created, which the route test asserts explicitly ("without persisting runs"). Unlike forecast, it does not touch the search index.

**Status codes:**

| Status | When |
|---|---|
| 200 | Payload returned. |
| 401 | No session. |
| 500 | Any thrown error, including a malformed date or a missing active snapshot; body `{ error: <message> }`, falling back to `"Failed to load room capacity"` for a non-`Error` throw ([`:18-21`](../../../src/app/api/room-capacity/month/route.ts)). |

There is **no 400** on this route.

### `GET /api/room-capacity/utilization`

Aggregated historical room occupancy for a Bangkok date range, computed entirely from the locally persisted `room_utilization_sessions` store — never from Wise on the request path. Handler: [`utilization/route.ts:6-29`](../../../src/app/api/room-capacity/utilization/route.ts); service: `getRoomUtilization` [`utilization.ts:474-507`](../../../src/lib/room-capacity/utilization.ts) → `aggregateRoomUtilization` [`utilization.ts:227-398`](../../../src/lib/room-capacity/utilization.ts).

**Auth:** session required ([`utilization/route.ts:7-10`](../../../src/app/api/room-capacity/utilization/route.ts)).

**Query parameters:**

| Param | Type | Default | Notes |
|---|---|---|---|
| `startDate` | string (`YYYY-MM-DD`) | `2026-03-01` | The `ROOM_UTILIZATION_HISTORY_START` constant ([`utilization.ts:20,101-103`](../../../src/lib/room-capacity/utilization.ts)). Validated by `assertUtilizationDate`, which requires `/^\d{4}-\d{2}-\d{2}$/` and a parseable `T00:00:00+07:00` instant ([`utilization.ts:26,90-99`](../../../src/lib/room-capacity/utilization.ts)). |
| `endDate` | string (`YYYY-MM-DD`) | today in Bangkok | Same validation. `startDate > endDate` throws `Invalid date range. startDate must be before or equal to endDate.` ([`utilization.ts:481-483`](../../../src/lib/room-capacity/utilization.ts)). |
| `weekdays` | comma-separated list | all seven | Parsed by `parseUtilizationWeekdays` **before** the service call ([`utilization/route.ts:16`](../../../src/app/api/room-capacity/utilization/route.ts), parser at [`utilization.ts:112-129`](../../../src/lib/room-capacity/utilization.ts)). Each token is lowercased and looked up in a fixed map accepting `0`–`6` and day names/abbreviations — `sun`/`sunday`, `mon`/`monday`, `tue`/`tues`/`tuesday`, `wed`/`wednesday`, `thu`/`thur`/`thurs`/`thursday`, `fri`/`friday`, `sat`/`saturday` ([`utilization.ts:28-53`](../../../src/lib/room-capacity/utilization.ts)). Empty tokens are skipped; an unrecognized token throws; a value that reduces to zero weekdays throws. Result is deduped and sorted ascending. An absent or blank parameter yields `undefined`, meaning all seven. |

**Fixed open window.** Occupancy is always measured against 07:00–21:00 Bangkok — `ROOM_UTILIZATION_OPEN_START_MINUTE = 420`, `ROOM_UTILIZATION_OPEN_END_MINUTE = 1260`, 840 minutes per room per day ([`utilization.ts:21-24`](../../../src/lib/room-capacity/utilization.ts)). It is not configurable by request; each session's interval is clipped to it ([`utilization.ts:172-176`](../../../src/lib/room-capacity/utilization.ts)).

**Response 200** — a bare `RoomUtilizationResponse` ([`types.ts:264-281`](../../../src/lib/room-capacity/types.ts)):

| Key | Type | Meaning |
|---|---|---|
| `range` | object | `{ startDate, endDate, generatedAt, openStartMinute, openEndMinute, weekdays }` — the effective range and the resolved weekday list ([`utilization.ts:381-388`](../../../src/lib/room-capacity/utilization.ts)). |
| `lastSyncedAt` | string (ISO) \| null | `max(synced_at)` across the **whole** table, not just the queried range ([`utilization.ts:494-496,389`](../../../src/lib/room-capacity/utilization.ts)). |
| `summary` | object | `{ occupiedMinutes, availableMinutes, utilizationPct, sessionCount, activeRoomCount }` ([`types.ts:274-276`](../../../src/lib/room-capacity/types.ts)). `availableMinutes` = selected days × active rooms × 840. |
| `daily` | `RoomUtilizationDailyRow[]` | One row per selected date, in range order, each carrying the four metric fields plus `date`, `weekday`, `missingLocationCount`, `unknownRoomCount`, `excludedStatusCount`, `overlapMinutes` ([`types.ts:228-235`](../../../src/lib/room-capacity/types.ts)). Dates with no sessions are still present, zero-filled. |
| `monthly` | `RoomUtilizationMonthlyRow[]` | Same metrics rolled to `YYYY-MM`, with the first and last selected date of that month ([`types.ts:237-245`](../../../src/lib/room-capacity/types.ts)). |
| `rooms` | `RoomUtilizationRoomRow[]` | Per active room `{ roomName, capacity, category, overlapMinutes, ...metrics }`, **sorted by `utilizationPct` descending** then name ([`types.ts:247-252`](../../../src/lib/room-capacity/types.ts), sort at [`utilization.ts:393-395`](../../../src/lib/room-capacity/utilization.ts)). |
| `dataQuality` | object | Count + minute totals for the three exclusion reasons plus `overlapMinutes` ([`types.ts:254-262`](../../../src/lib/room-capacity/types.ts)). |

`utilizationPct` is a percentage rounded to one decimal, and is `0` whenever `availableMinutes <= 0` ([`utilization.ts:140-143`](../../../src/lib/room-capacity/utilization.ts)).

**What is excluded, and why it shows up in `dataQuality`** ([`utilization.ts:304-331`](../../../src/lib/room-capacity/utilization.ts)) — each stored row is tested in this order and the first match wins:

1. **Excluded status** → only `ENDED`, `IN_PROGRESS`, `UPCOMING` count; `CANCELLED`/`CANCELED`/`MISSED`/`NO_SHOW` and *any unrecognized status* are excluded ([`utilization.ts:55-56,131-138`](../../../src/lib/room-capacity/utilization.ts)) — fail-closed, so an unknown status never inflates utilization.
2. **Missing location** → blank `rawLocation` or blank `normalizedRoomLabel`.
3. **Unknown room** → the normalized label matches no *active* classroom room ([`utilization.ts:178-196`](../../../src/lib/room-capacity/utilization.ts)).

`overlapMinutes` is reported separately and is **not** deducted from `occupiedMinutes`: it is the excess minutes during which more than one counted session occupies the same room on the same date, computed by sweeping interval boundaries ([`utilization.ts:215-225,355-366`](../../../src/lib/room-capacity/utilization.ts)).

**Side effects:** three parallel Postgres reads — the range of `room_utilization_sessions`, `listClassroomRooms` (which writes room defaults, see the conventions above), and the global `max(synced_at)` ([`utilization.ts:485-497`](../../../src/lib/room-capacity/utilization.ts)). No Wise call, no snapshot dependency, no writes of its own.

**Status codes:**

| Status | When |
|---|---|
| 200 | Aggregate returned. |
| 401 | No session. |
| 400 | The thrown message starts with `Invalid date range`, `Invalid startDate`, `Invalid endDate`, or `Invalid weekdays` ([`utilization/route.ts:21-26`](../../../src/app/api/room-capacity/utilization/route.ts)). |
| 500 | Any other thrown error; body `{ error: <message> }`, falling back to `"Failed to load room utilization"` ([`:20`](../../../src/app/api/room-capacity/utilization/route.ts)). |

This is the only route in the feature that returns 400. The mapping is by **message prefix**, so an unrelated failure that happened to start with one of those four strings would also be reported as 400.

---

## Test coverage

[`src/app/api/room-capacity/__tests__/route.test.ts`](../../../src/app/api/room-capacity/__tests__/route.test.ts) covers all three `GET` handlers with `auth`, `getDb`, and the service layer mocked: the 401 on `month` and `utilization`, default and explicit date ranges on both, the `Base` scenario default and the missing-model fallback on `forecast` (asserting `weekdayResults` has length 7), weekday-filter parsing (`weekdays=mon,wed,6` → `[1, 3, 6]`), and both 400 paths on `utilization`.

**`POST /api/internal/sync-room-utilization` has no route test.** Its service is covered indirectly by [`src/lib/room-capacity/__tests__/utilization.test.ts`](../../../src/lib/room-capacity/__tests__/utilization.test.ts); the engines behind `month` and `forecast` are covered by `analysis.test.ts`, `forecast.test.ts`, `package-mix.test.ts`, and `dates.test.ts` in the same directory.

## Open questions

- **Upserts never retire rows.** `syncRoomUtilizationSessions` only inserts and updates ([`utilization.ts:441-463`](../../../src/lib/room-capacity/utilization.ts)). A session deleted in Wise keeps its last-known row in `room_utilization_sessions` forever and continues to contribute occupied minutes. Whether that is intended is not stated in code.
- **No single-flight guard on the sync.** Every other sync lineage in the app enforces one through a `*_sync_runs` partial unique index; this one has neither table nor guard, so concurrent `POST`s race on the same upsert set.
- **The forecast's missing-table guard is a substring match** ([`forecast/route.ts:6-14`](../../../src/app/api/room-capacity/forecast/route.ts)), not a "relation does not exist" test, so a genuine database fault mentioning one of the four `room_capacity_*` tables is reported to the client as a healthy empty forecast (200).
- **Two hand-maintained copies of the missing-forecast body** exist ([`data.ts:358-383`](../../../src/lib/room-capacity/data.ts) and [`forecast/route.ts:16-41`](../../../src/app/api/room-capacity/forecast/route.ts)) and can drift independently.
- **`month` validates nothing.** A malformed `startDate`/`endDate` reaches Drizzle and surfaces as 500 rather than 400, in contrast to the sibling `utilization` route.
- **`month` and `forecast` have no caller.** Both are authenticated, tested, and reachable, but no code in `src/` outside their own route test fetches them — so their response contracts are unexercised in production.

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
