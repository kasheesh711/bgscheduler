# Room Capacity API

Mechanical reference for the **Room Capacity** endpoint group. Three read endpoints serve the utilization dashboard, the month heatmap, and the saturation forecast; one internal endpoint refreshes the room-utilization session store from Wise. For the feature's purpose, rules, and flows (including the note that the month/forecast engines have no frontend consumer yet), see [`docs/features/room-capacity.md`](../../features/room-capacity.md).

> **Canonical-home rule:** this page owns the endpoint mechanics (method, path, auth, request/response shape, side effects, status codes). Meaning and rationale live in the feature doc.

**Routes covered (4):**

| Method | Path | Auth | Source |
|---|---|---|---|
| GET | `/api/room-capacity/utilization` | admin | `src/app/api/room-capacity/utilization/route.ts` |
| GET | `/api/room-capacity/month` | admin | `src/app/api/room-capacity/month/route.ts` |
| GET | `/api/room-capacity/forecast` | admin | `src/app/api/room-capacity/forecast/route.ts` |
| POST | `/api/internal/sync-room-utilization` | cron (or admin) | `src/app/api/internal/sync-room-utilization/route.ts` |

**Validation note:** none of these routes use Zod. The three GET routes read raw query-string params via `request.nextUrl.searchParams.get(...)` and delegate validation to the room-capacity lib helpers (which throw plain `Error`s on bad input). The POST route takes no body.

---

## Read endpoints

All three GET routes follow the same auth shape: `auth()` → `401 {"error":"Unauthorized"}` when there is no session (`utilization/route.ts:7-10`, `month/route.ts:7-10`, `forecast/route.ts:44-47`). They are admin-gated by `src/middleware.ts` plus the in-handler `auth()` call.

### GET `/api/room-capacity/utilization`

Returns historical room-utilization metrics (occupied vs. available minutes, per-day / per-month / per-room breakdowns, and a data-quality block) aggregated from the persisted `room_utilization_sessions` store. Backed by `getRoomUtilization()` (`src/lib/room-capacity/utilization.ts:474-507`).

**Auth:** admin (`utilization/route.ts:7-10`).

**Query parameters** (all optional; `utilization/route.ts:12-16`):

| Param | Type | Default | Notes |
|---|---|---|---|
| `startDate` | `YYYY-MM-DD` | `ROOM_UTILIZATION_HISTORY_START` = `2026-03-01` | Validated by `assertUtilizationDate` (`utilization.ts:90-99`); default applied at `utilization.ts:478-479`. |
| `endDate` | `YYYY-MM-DD` | today in `Asia/Bangkok` (`todayBangkok`) | Default range from `defaultRoomUtilizationRange` (`utilization.ts:101-103`). |
| `weekdays` | comma-separated list | all 7 weekdays | Parsed by `parseUtilizationWeekdays` (`utilization.ts:112-129`). Accepts numbers `0`–`6` (0 = Sunday) **and** names/abbreviations (`sun`/`sunday`, `mon`, `tue`/`tues`, `thu`/`thur`/`thurs`, etc.). De-duplicated and sorted ascending. Empty/whitespace value → treated as "all weekdays". |

**Behavior / side effects:** read-only. Issues three parallel queries (`utilization.ts:485-497`) — the in-range `room_utilization_sessions` rows, the classroom room catalog (`listClassroomRooms`), and `max(synced_at)` for `lastSyncedAt` — then aggregates via `aggregateRoomUtilization`. Open-hours window is fixed at minutes 420–1260 (07:00–21:00 Bangkok; `utilization.ts:21-22`); session minutes are clipped to that window. Sessions are bucketed by Wise status: `ENDED`/`IN_PROGRESS`/`UPCOMING` count toward occupancy; `CANCELLED`/`CANCELED`/`MISSED`/`NO_SHOW` (and any unrecognized status) are excluded and tallied under data quality; rows missing a location or an unmatched normalized room label are likewise tallied separately (`utilization.ts:55-56`, `131-138`, `311-331`).

**Response 200** — `RoomUtilizationResponse` (`src/lib/room-capacity/types.ts:264-281`), assembled at `utilization.ts:380-397`:

```jsonc
{
  "range": {
    "startDate": "2026-03-01",
    "endDate": "2026-05-31",
    "generatedAt": "2026-05-31T...Z",
    "openStartMinute": 420,
    "openEndMinute": 1260,
    "weekdays": [0, 1, 2, 3, 4, 5, 6]
  },
  "lastSyncedAt": "2026-05-31T...Z",   // or null if the table is empty
  "summary": {                          // RoomUtilizationMetric + activeRoomCount
    "occupiedMinutes": 0,
    "availableMinutes": 0,
    "utilizationPct": 0,                // occupied/available × 100, 1-decimal rounding
    "sessionCount": 0,
    "activeRoomCount": 0
  },
  "daily":   [ /* RoomUtilizationDailyRow[]  — per date: metric + weekday + missing/unknown/excluded counts + overlapMinutes */ ],
  "monthly": [ /* RoomUtilizationMonthlyRow[] — per YYYY-MM: metric + startDate/endDate + same quality counts */ ],
  "rooms":   [ /* RoomUtilizationRoomRow[]   — per active room: metric + capacity + category, sorted by utilizationPct desc */ ],
  "dataQuality": {
    "missingLocationCount": 0, "missingLocationMinutes": 0,
    "unknownRoomCount": 0,     "unknownRoomMinutes": 0,
    "excludedStatusCount": 0,  "excludedStatusMinutes": 0,
    "overlapMinutes": 0
  }
}
```

Field-level types: `RoomUtilizationDailyRow` (`types.ts:228-235`), `RoomUtilizationMonthlyRow` (`types.ts:237-245`), `RoomUtilizationRoomRow` (`types.ts:247-252`), `RoomUtilizationDataQuality` (`types.ts:254-262`).

**Error / status codes** (`utilization/route.ts:19-27`):

| Status | Condition |
|---|---|
| `401` | No session. |
| `400` | Lib error whose message starts with `Invalid date range`, `Invalid startDate`, `Invalid endDate`, or `Invalid weekdays`. These cover a malformed date (not `YYYY-MM-DD`), `startDate > endDate` (`utilization.ts:481-483`), or an unrecognized weekday token (`utilization.ts:120-127`). Body `{"error": <message>}`. |
| `500` | Any other thrown error; body `{"error": <message>}` (falls back to `"Failed to load room utilization"`). |

---

### GET `/api/room-capacity/month`

Returns the month-view payload for the live snapshot: current room load vs. a re-projected ideal assignment, including overcapacity intervals, heatmap cells, per-day summaries, and KPIs. Backed by `getRoomCapacityMonth()` (`src/lib/room-capacity/data.ts:229-291`).

**Auth:** admin (`month/route.ts:7-10`).

**Query parameters** (both optional; `month/route.ts:12-13`):

| Param | Type | Default | Notes |
|---|---|---|---|
| `startDate` | `YYYY-MM-DD` | `defaultRoomCapacityRange().startDate` | Passed straight through; **not** range-validated on this path (`data.ts:233-235`). |
| `endDate` | `YYYY-MM-DD` | `defaultRoomCapacityRange().endDate` | Same — no `assertUtilizationDate`/ordering check here. |

**Behavior / side effects:** read-only against Postgres; no Wise call. Resolves the active snapshot (`data.ts:37-45`), loads the room catalog, loads **blocking** `future_session_blocks` in range for that snapshot (`data.ts:70-125`), pulls the latest classroom-assignment override per date (`data.ts:127-167`), then computes an "ideal" assignment via `assignClassrooms` to derive the `projected.*` view (`data.ts:193-227`). Current vs. projected overcaps, heatmap cells, unmatched allocations, no-room rows, and day summaries are computed from the analysis helpers.

**Response 200** — `RoomCapacityMonthResponse` (`types.ts:109-139`), assembled at `data.ts:267-290`:

```jsonc
{
  "range": { "startDate": "...", "endDate": "...", "generatedAt": "...Z" },
  "snapshotMeta": { "snapshotId": "...", "syncedAt": "...Z" },   // from the active snapshot
  "rooms": [ /* RoomCapacityRoom[] (types.ts:3-11) */ ],
  "kpis": {
    "currentOvercapIntervals": 0,
    "impactedRooms": 0,                 // distinct room names in current overcaps
    "projectedNoRoomSessions": 0,
    "unmatchedCurrentAllocations": 0,
    "peakLoadRatio": 0                  // max heatmap loadRatio
  },
  "current":   { "overcaps": [...], "unmatchedAllocations": [...], "heatmapCells": [...], "daySummaries": [...] },
  "projected": { "overcaps": [...], "noRoomRows": [...],          "heatmapCells": [...], "daySummaries": [...] }
}
```

Field-level types: `RoomCapacityRoom` (`types.ts:3-11`), `RoomCapacityOvercapInterval` (`types.ts:54-67`), `RoomCapacityUnmatchedAllocation` (`types.ts:69-79`), `RoomCapacityNoRoomRow` (`types.ts:81-93`), `RoomCapacityHeatmapCell` (`types.ts:39-52`), `RoomCapacityDaySummary` (`types.ts:95-107`).

**Error / status codes** (`month/route.ts:18-21`):

| Status | Condition |
|---|---|
| `401` | No session. |
| `500` | Any thrown error; body `{"error": <message>}` (fallback `"Failed to load room capacity"`). Notably, `getActiveSnapshot` throws `No active Wise snapshot found` (`data.ts:43`) when no snapshot is active — surfaced here as a 500, not a typed missing payload. There is no `400` branch on this route. |

---

### GET `/api/room-capacity/forecast`

Returns the saturation/weekend-demand forecast for a scenario: when each weekday's room-slot and room+tutor capacity saturates, the weekend-demand breakpoint, capture-readiness diagnostics, and monthly driver rows. Backed by `getRoomCapacityForecast()` (`src/lib/room-capacity/data.ts:385-444`).

**Auth:** admin (`forecast/route.ts:44-47`).

**Query parameters** (optional; `forecast/route.ts:49`):

| Param | Type | Default | Notes |
|---|---|---|---|
| `scenario` | string | `"Base"` | Selects forecast drivers. If the requested scenario has no drivers, the lib falls back to the first available scenario and echoes the effective scenario back in the response's `scenario` field (`data.ts:389-397`, `436`). Conventionally `Bear` / `Base` / `Bull`. |

**Behavior / side effects:** read-only. Loads the latest `room_capacity_model_runs` row (`data.ts:293-300`). If **no model run exists**, returns a fully-formed `status:"missing"` response with empty arrays and 7 null-filled `weekdayResults` (`data.ts:358-383`, `391`) — HTTP 200, not an error. When a run exists, it loads forecast drivers / demand mix / package mix for that run, loads the active snapshot + room catalog, loads in-range blocking `future_session_blocks` as seed sessions, builds an `ensureIndex(db)` search index, and runs the saturation + weekend-demand simulations (`data.ts:393-426`). `ensureIndex` may lazily (re)build the in-memory search index as a side effect.

**Response 200** — `RoomCapacityForecastResponse` (`types.ts:304-320`), assembled at `data.ts:427-443`:

```jsonc
{
  "model": {
    "status": "ready",                 // or "missing"
    "modelRunId": "...",               // null when missing
    "sourceLabel": "...",
    "forecastStart": "YYYY-MM-DD",
    "forecastEnd": "YYYY-MM-DD",
    "importedAt": "...Z"
  },
  "scenario": "Base",                   // effective scenario (may differ from request after fallback)
  "scenarios": ["Base", "Bull", ...],   // distinct scenarios present in drivers
  "generatedAt": "...Z",
  "weekdayResults": [ /* WeekdaySaturationResult[] (types.ts:174-181), one per weekday 0–6 */ ],
  "weekendDemandBreakpoint": { /* WeekendDemandBreakpoint (types.ts:212-219) */ } /* or null */,
  "weekendDemandCaptureReadiness": { /* WeekendDemandCaptureReadiness (types.ts:291-302) */ } /* or null */,
  "monthlyDrivers": [ /* RoomCapacityForecastDriver[] (types.ts:141-150) */ ]
}
```

**Error / status codes** (`forecast/route.ts:54-60`):

| Status | Condition |
|---|---|
| `401` | No session. |
| `200` (missing payload) | The caught error message mentions any of `room_capacity_model_runs`, `room_capacity_forecast_drivers`, `room_capacity_demand_mix`, or `room_capacity_package_mix` — i.e. a missing forecast table. The route returns `missingForecastBody(scenario)` (`forecast/route.ts:6-41`, `55-57`), a `status:"missing"` body that mirrors the lib's missing-run shape. This is the route's "optional-table → HTTP 200, not 500" guard. |
| `500` | Any other thrown error; body `{"error": <message>}` (fallback `"Failed to load room capacity forecast"`). `getActiveSnapshot` raising `No active Wise snapshot found` (only reached when a model run exists) would surface here. |

---

## Internal sync endpoint

### POST `/api/internal/sync-room-utilization`

Refreshes the `room_utilization_sessions` store by pulling all institute sessions from Wise and upserting them. Backed by `syncRoomUtilizationSessions()` (`src/lib/room-capacity/utilization.ts:427-472`).

**Auth:** cron (or admin) — dual-path (`sync-room-utilization/route.ts:26-40`):

1. Constant-time `Bearer ${CRON_SECRET}` check via `timingSafeEqual` with a length pre-check (`route.ts:12-24`). A valid secret marks `triggerSource = "cron"`.
2. If `CRON_SECRET` is **unset**, the route returns `500 {"error":"Server misconfigured"}` — but only when there is also no session.
3. If the secret is present-but-invalid, the route falls back to an admin `auth()` session; no session → `401 {"error":"Unauthorized"}`. A valid session marks `triggerSource = "admin"` and records the actor email.

**Not a Vercel cron.** In the cron registry this job is `manualOnly: true` with `schedule: null` / `cadenceLabel: "Manual only"` (`src/lib/data-health/cron-registry.ts:191-204`), and it is **not** listed under `crons` in `vercel.json`. It runs only when triggered manually (admin UI or an explicit bearer call). `maxDuration = 800` (`route.ts:8`).

**Request body:** none. The HTTP route calls `syncRoomUtilizationSessions(getDb())` with no input, so it uses the defaults (`startDate` = `ROOM_UTILIZATION_HISTORY_START` = `2026-03-01`, `syncedAt` = now; `utilization.ts:429-432`).

**Behavior / side effects:**

- Requires `WISE_INSTITUTE_ID` (throws `WISE_INSTITUTE_ID is required to sync room utilization` if unset; `utilization.ts:433-434`).
- Fetches **all** institute sessions via `fetchAllInstituteSessions(createWiseClient(), instituteId)` — a live Wise API call (`utilization.ts:436`).
- Maps each Wise session to a row (`wiseSessionToUtilizationRow`, `utilization.ts:400-425`), dropping rows without an id/start/end or with a `utilizationDate` earlier than `startDate`.
- **Upserts** rows into `room_utilization_sessions` in chunks of 500, on conflict by `wiseSessionId` updating all derived columns (`utilization.ts:441-464`). This is the only write to domain data.
- The whole handler is wrapped in `withCronInvocationAudit({ jobKey: "room_utilization", ... })`, which writes a start/finish row to `cron_invocations` (status, duration, response status, error summary; `src/lib/data-health/cron-audit.ts:144-159`, `84-142`).

**Response 200** (`route.ts:46-47`) — `{ ok: true, ...result }` where `result` is the `syncRoomUtilizationSessions` return (`utilization.ts:466-471`):

```jsonc
{
  "ok": true,
  "fetchedCount": 0,    // total sessions returned by Wise
  "storedCount": 0,     // rows upserted (after date/validity filtering)
  "startDate": "2026-03-01",
  "syncedAt": "...Z"
}
```

**Error / status codes:**

| Status | Condition |
|---|---|
| `500` `{"error":"Server misconfigured"}` | `CRON_SECRET` is unset **and** no admin session (`route.ts:33-35`). |
| `401` `{"error":"Unauthorized"}` | Invalid/absent bearer and no admin session (`route.ts:36`). |
| `500` `{"error": <message>}` | Sync threw (e.g. missing `WISE_INSTITUTE_ID`, a Wise fetch failure, or a DB error); fallback `"Failed to sync room utilization"` (`route.ts:48-51`). The audit wrapper also coerces any uncaught throw into a `500 {"error": <message>}` (`cron-audit.ts:152-157`). |
| `200` | Successful upsert. |

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
