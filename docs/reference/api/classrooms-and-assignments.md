# Classrooms & Assignments API

**Authoritative source:** the ten route handlers under [`src/app/api/class-assignments/`](../../../src/app/api/class-assignments/) and [`src/app/api/classrooms/`](../../../src/app/api/classrooms/), plus the two cron handlers under [`src/app/api/internal/class-assignments/`](../../../src/app/api/internal/class-assignments/).

This page is the mechanical reference for those 12 endpoints: method, path, auth, request shape, response shape, side effects, and status codes. What the feature is *for* — the assignment rules, the publish policy, the morning-automation story — lives in [docs/features/classroom-assignments.md](../../features/classroom-assignments.md) (**Status: stable**), which this page does not restate. Table columns live in [docs/reference/database/erd-classrooms.md](../database/erd-classrooms.md); cron scheduling lives in [docs/reference/crons.md](../crons.md).

## Endpoints on this page

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/class-assignments` | session |
| POST | `/api/class-assignments/run` | session |
| POST | `/api/class-assignments/runs/[runId]/publish` | session |
| GET | `/api/class-assignments/runs/[runId]/publish/[jobId]` | session |
| PATCH | `/api/class-assignments/runs/[runId]/rows/[rowId]` | session |
| GET | `/api/class-assignments/runs/[runId]/schedule-email/preview` | session |
| POST | `/api/class-assignments/runs/[runId]/schedule-email/send` | session |
| GET | `/api/class-assignments/runs/[runId]/teacher-schedule` | session |
| GET | `/api/classrooms/floor-plan-map` | **public** |
| GET | `/api/classrooms/rooms` | session |
| GET | `/api/internal/class-assignments/admin-email` | `CRON_SECRET` |
| GET | `/api/internal/class-assignments/morning` | `CRON_SECRET` |

The only in-repo browser caller is the workspace client, which calls eight of them — the date read, run, row override, publish start, publish poll, schedule-email preview and send ([`class-assignments-workspace.tsx:251,379,406,427,446,497,526`](../../../src/components/class-assignments/class-assignments-workspace.tsx)) — plus the same date read from its sync helper ([`sync-flow.ts:67`](../../../src/components/class-assignments/sync-flow.ts)). `GET /api/classrooms/rooms` and `GET /api/classrooms/floor-plan-map` have no client-side `fetch` in the repo: the room catalog already ships inside the assignment detail, and the floor-plan SVG is embedded as an `<img>` in the tutor schedule email ([`schedule-email.ts:278-286`](../../../src/lib/classrooms/schedule-email.ts)).

---

## Conventions shared across the endpoints

- **Session auth.** The eight `/api/class-assignments/**` handlers and `GET /api/classrooms/rooms` each call `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and return `401 {"error":"Unauthorized"}` when there is no session. None inspects role, email, or any per-resource grant; `session.user?.email` is read only to stamp an actor on writes ([`run/route.ts:42`](../../../src/app/api/class-assignments/run/route.ts), [`publish/route.ts:41`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/route.ts), [`send/route.ts:74`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/send/route.ts)).
- **Middleware gate.** `/api/classrooms/floor-plan-map` and everything under `/api/internal/` are in the middleware public-route allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)); every other endpoint here is redirected to `/login` when unauthenticated, before the handler runs ([`middleware.ts:89-93`](../../../src/middleware.ts)). For a signed-in user with a non-null `allowedPages`, the middleware additionally returns `403 {"error":"Forbidden"}` for API paths outside the allowed prefixes ([`middleware.ts:97-100`](../../../src/middleware.ts)). The prefix match is `pathname === "/api" + page` or `startsWith("/api" + page + "/")` ([`middleware.ts:59-66`](../../../src/middleware.ts)), so a `/class-assignments` grant reaches `/api/class-assignments/**` but **not** `/api/classrooms/**` — tracked as SEC-2 in [docs/OPEN-QUESTIONS.md](../../OPEN-QUESTIONS.md).
- **Cron auth.** The two internal routes call `rejectInvalidCronSecret(request)`, a **constant-time** comparison of the `authorization` header against `Bearer ${CRON_SECRET}`: mismatch → `401 {"error":"Unauthorized"}`, unset `CRON_SECRET` → `500 {"error":"Server misconfigured"}` ([`cron-auth.ts:6-26`](../../../src/lib/internal/cron-auth.ts)).
- **Dynamic params are Promises.** Run-scoped handlers take `{ params }: { params: Promise<{ runId: string; … }> }` and `await` them ([`publish/route.ts:28-37`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/route.ts)). No handler validates that a param is a UUID — a malformed id reaches Postgres and surfaces as a 500.
- **Error mapping is string-matched, not typed.** These handlers inspect the thrown message: `message.startsWith("Invalid date")` → **400**; `message.endsWith("not found")` (or, in the schedule-email routes, an exact `"Assignment run not found"`) → **404**; anything else → **500** with `{ error: message }`. The one typed branch anywhere on this page is `StaleClassroomAssignmentSnapshotError` → **409** on `POST /api/class-assignments/run` ([`run/route.ts:46-56`](../../../src/app/api/class-assignments/run/route.ts)).
- **Zod.** Only two handlers use Zod (`run`, `rows/[rowId]`); `schedule-email/send` hand-rolls its validation; the rest accept no body.
- **Dates.** Assignment dates are Bangkok `YYYY-MM-DD` strings validated by `assertIsoDate`, which throws the literal `Invalid date. Expected YYYY-MM-DD.` ([`data.ts:154-163`](../../../src/lib/classrooms/data.ts)).
- **No caching.** None of the twelve handlers declares `"use cache"`, `revalidate`, or `dynamic`; every request reads Postgres (and, on two paths, Wise) directly.

### The assignment detail envelope

Four responses return the same `ClassroomAssignmentDetail` object ([`data.ts:45-52`](../../../src/lib/classrooms/data.ts)) — `GET /api/class-assignments`, `POST /api/class-assignments/run`, `PATCH …/rows/[rowId]`, and the terminal form of the publish-progress poll. It is referenced below as the **assignment detail**.

| Key | Type | Meaning |
|-----|------|---------|
| `run` | `classroom_assignment_runs` row \| `null` | The run in question; `null` only on the date read when no run exists yet ([`data.ts:702-705`](../../../src/lib/classrooms/data.ts)). |
| `rows` | `classroom_assignment_rows[]` | Rows for that run, ordered by `startTime` then `tutorDisplayName` ([`data.ts:598-607`](../../../src/lib/classrooms/data.ts)). |
| `rooms` | `classroom_rooms[]` | The full room catalog, ordered by `sortOrder` then `name` ([`data.ts:490-496`](../../../src/lib/classrooms/data.ts)). |
| `snapshotMeta` | object | `{ snapshotId, latestSyncFinishedAt, staleAgeMs, fresh }` ([`data.ts:54-59`](../../../src/lib/classrooms/data.ts)). `fresh` is `staleAgeMs !== null && staleAgeMs <= 15 min` (`CLASSROOM_ASSIGNMENT_FRESHNESS_MS`, [`data.ts:134`](../../../src/lib/classrooms/data.ts)), measured from the newest `sync_runs` row with `status = "success"` whose `promotedSnapshotId` is this snapshot ([`data.ts:528-570`](../../../src/lib/classrooms/data.ts)). |
| `liveRoomBlocks` | `LiveRoomBlock[]` | Blocking live Wise sessions for the date that are **not** part of this run: an external room block plus `{ wiseClassId, sessionType, wiseStatus }` ([`data.ts:66-70`](../../../src/lib/classrooms/data.ts)). Hard-coded `[]` on every path except `POST /api/class-assignments/run` ([`data.ts:704,708,1148,1877`](../../../src/lib/classrooms/data.ts)). |
| `roomConflictWarnings` | `RoomConflictWarning[]` | `{ wiseSessionId, assignedRoom, desiredLocation, message, blocker }` ([`data.ts:72-78`](../../../src/lib/classrooms/data.ts)); likewise `[]` except on the run endpoint. |

Run/row/job column definitions are **not** restated here — see [erd-classrooms.md](../database/erd-classrooms.md) and [`schema.ts:1649-1662`](../../../src/lib/db/schema.ts) (rooms), [`schema.ts:1664-1688`](../../../src/lib/db/schema.ts) (runs), [`schema.ts:1690-…`](../../../src/lib/db/schema.ts) (rows), [`schema.ts:1924-1944`](../../../src/lib/db/schema.ts) (publish jobs). The enums used in these payloads are declared at [`schema.ts:50-82`](../../../src/lib/db/schema.ts): room `category` is `standard | overflow_only | online_only`, run `status` is `completed | published | partial | failed`, row `status` is `assigned | needs_review | no_room | remote`, row `publishStatus` is `not_published | skipped | success | failed`, job `status` is `pending | running | succeeded | partial | failed`.

---

## Assignment runs

### `GET /api/class-assignments`

Reads the latest assignment run for one Bangkok date. Handler: [`route.ts:9-28`](../../../src/app/api/class-assignments/route.ts).

**Auth:** session required ([`route.ts:10-13`](../../../src/app/api/class-assignments/route.ts)).

**Query parameters:**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `date` | string (`YYYY-MM-DD`) | yes | Missing → `400 {"error":"date is required"}` ([`route.ts:15-18`](../../../src/app/api/class-assignments/route.ts)). Passed through `assertIsoDate` before the query ([`route.ts:21`](../../../src/app/api/class-assignments/route.ts)). |

**Side effects:** nominally a read, but `getClassroomAssignmentForDate` calls `listClassroomRooms` → `ensureDefaultClassroomRooms`, which **writes**: it inserts any missing `DEFAULT_CLASSROOM_ROOMS` (`onConflictDoNothing` on `name`), updates rows whose `hasTv`/`capacity`/`category`/`active`/`sortOrder` drifted from the constant, and deactivates legacy physical rooms superseded by a `" (TV)"` twin ([`data.ts:431-496`](../../../src/lib/classrooms/data.ts)). No Wise calls.

**Response 200** — the [assignment detail](#the-assignment-detail-envelope). Selection is "newest run for that `assignmentDate` by `createdAt`" ([`data.ts:588-596`](../../../src/lib/classrooms/data.ts)); when none exists, `run` is `null` and `rows` is `[]` while `rooms` and `snapshotMeta` are still populated ([`data.ts:702-705`](../../../src/lib/classrooms/data.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Detail returned, including the empty-run shape. |
| 400 | `date` missing, or a thrown message starting with `Invalid date` ([`route.ts:25`](../../../src/app/api/class-assignments/route.ts)). |
| 401 | No session. |
| 500 | Any other throw — notably `No active Wise snapshot found` when the date has no run and no snapshot is active ([`data.ts:509-517`](../../../src/lib/classrooms/data.ts)). |

---

### `POST /api/class-assignments/run`

Generates a fresh assignment run for a date and persists it. Handler: [`run/route.ts:17-61`](../../../src/app/api/class-assignments/run/route.ts). `export const maxDuration = 300` ([`run/route.ts:10`](../../../src/app/api/class-assignments/run/route.ts)).

**Auth:** session required ([`run/route.ts:18-21`](../../../src/app/api/class-assignments/run/route.ts)).

**Request body** — `runRequestSchema` ([`run/route.ts:12-15`](../../../src/app/api/class-assignments/run/route.ts)):

```ts
z.object({
  date: z.string(),
  forceReassign: z.boolean().optional().default(false),
})
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `date` | string | — | Required. Zod checks only that it is a string; the `YYYY-MM-DD` shape is enforced downstream by `assertIsoDate` ([`data.ts:881`](../../../src/lib/classrooms/data.ts)). |
| `forceReassign` | boolean | `false` | When `false`, non-null `overrideRoom` values from the previous run for that date are carried into the new run; when `true` the override map is empty ([`data.ts:711-734`](../../../src/lib/classrooms/data.ts)). |

Unparseable JSON → `400 {"error":"Invalid JSON"}`; a schema failure → `400 { error: "Invalid request", details: <error.flatten()> }` ([`run/route.ts:23-36`](../../../src/app/api/class-assignments/run/route.ts)).

**Side effects** (`runClassroomAssignment`, [`data.ts:877-919`](../../../src/lib/classrooms/data.ts)):

1. Resolves the active snapshot and **fails closed** when its promoting sync is not within 15 minutes → `StaleClassroomAssignmentSnapshotError` ([`data.ts:572-578`](../../../src/lib/classrooms/data.ts), class at [`data.ts:136-152`](../../../src/lib/classrooms/data.ts)).
2. Seeds/repairs the room catalog (the same `ensureDefaultClassroomRooms` write as above).
3. Loads that Bangkok day's blocking `future_session_blocks` rows from the snapshot, joined to `tutor_identity_groups` for the display name ([`data.ts:736-783`](../../../src/lib/classrooms/data.ts)).
4. **Calls Wise** (`fetchAllFutureSessions`) and derives live room blocks for the date that are not covered by local rows ([`data.ts:887-893`](../../../src/lib/classrooms/data.ts)).
5. Runs `assignClassrooms`, then **inserts** one `classroom_assignment_runs` row (`status: "completed"`, `forceReassign`, the assigned / needs-review / no-room / remote counts, `createdBy = session.user.email`) plus one `classroom_assignment_rows` row per session ([`data.ts:830-875`](../../../src/lib/classrooms/data.ts)).

Nothing is written back to Wise here — publishing is a separate, explicit call.

**Response 200** — the [assignment detail](#the-assignment-detail-envelope) for the new run. This is the **only** endpoint that populates `liveRoomBlocks` and `roomConflictWarnings` ([`data.ts:910-918`](../../../src/lib/classrooms/data.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Run created. |
| 400 | Invalid JSON, Zod failure, or a thrown message starting with `Invalid date`. |
| 401 | No session. |
| 409 | `StaleClassroomAssignmentSnapshotError`; body `{ error, code: "STALE_ASSIGNMENT_SNAPSHOT", latestSyncFinishedAt, staleAgeMs }` ([`run/route.ts:46-56`](../../../src/app/api/class-assignments/run/route.ts)). |
| 500 | Any other throw — missing active snapshot, Wise fetch failure, missing `WISE_USER_ID`/`WISE_API_KEY` ([`data.ts:1151-1159`](../../../src/lib/classrooms/data.ts)), DB error. |

---

### `PATCH /api/class-assignments/runs/[runId]/rows/[rowId]`

Sets or clears the manual room override on one row and recomputes the whole run. Handler: [`rows/[rowId]/route.ts:11-48`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/rows/%5BrowId%5D/route.ts).

**Auth:** session required ([`rows/[rowId]/route.ts:15-18`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/rows/%5BrowId%5D/route.ts)).

**Path params:** `runId`, `rowId` — awaited at [`rows/[rowId]/route.ts:35`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/rows/%5BrowId%5D/route.ts).

**Request body** — `overrideRequestSchema` ([`rows/[rowId]/route.ts:7-9`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/rows/%5BrowId%5D/route.ts)):

```ts
z.object({
  overrideRoom: z.string().trim().nullable().optional(),
})
```

The value is trimmed again in the handler and an empty string collapses to `null`, i.e. "clear the override" ([`rows/[rowId]/route.ts:40`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/rows/%5BrowId%5D/route.ts)). Because the field is optional, an empty body `{}` is valid and **also clears the override**. The room name is not validated against the catalog at this layer — an unknown name is handed to the assignment engine as-is.

**Side effects** (`updateClassroomAssignmentOverride`, [`data.ts:1116-1149`](../../../src/lib/classrooms/data.ts)): loads the run and all of its rows, replays every existing override plus the new one through `assignClassrooms`, then rewrites **every** row of the run — `minCapacity`, `needsTv`, `preferredRoom`, `overrideRoom`, `assignedRoom`, `status`, `warnings`, `ruleTrace` — and resets each row's publish state to `publishStatus: "not_published"`, `publishError: null`, `publishedAt: null`. The run row is rewritten with fresh counts, `publishedCount: 0`, `failedPublishCount: 0`, `status: "completed"` ([`data.ts:1064-1114`](../../../src/lib/classrooms/data.ts)). No Wise call, so a previously published Wise `location` is left in place while the local publish state is cleared. Missing run → `Assignment run not found` ([`data.ts:1125`](../../../src/lib/classrooms/data.ts)); missing row → `Assignment row not found` ([`data.ts:1129`](../../../src/lib/classrooms/data.ts)).

**Response 200** — the [assignment detail](#the-assignment-detail-envelope) for the recomputed run (`liveRoomBlocks` / `roomConflictWarnings` are `[]` here).

**Status codes:** 200 · 400 (invalid JSON, Zod failure) · 401 · 404 (thrown message ends with `not found`, [`rows/[rowId]/route.ts:45`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/rows/%5BrowId%5D/route.ts)) · 500.

---

## Publishing to Wise

### `POST /api/class-assignments/runs/[runId]/publish`

Starts a background job that writes each eligible row's assigned room into the Wise session `location`. Handler: [`publish/route.ts:28-52`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/route.ts). `export const maxDuration = 300` ([`publish/route.ts:10`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/route.ts)).

**Auth:** session required ([`publish/route.ts:32-35`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/route.ts)).

**Path params:** `runId`. **Request body:** none — the request object is ignored (`_request`) and the job always targets the whole run: `createClassroomPublishJob` is called without `targetRowIds`, so `targetRows` is every row ([`publish/route.ts:39-42`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/route.ts), [`data.ts:1248-1249`](../../../src/lib/classrooms/data.ts)). Row-scoped publishing exists in the library but is reached only through the morning automation ([`morning-automation.ts:205-213`](../../../src/lib/classrooms/morning-automation.ts)).

**Side effects:**

1. Inserts one `classroom_publish_jobs` row (`status: "pending"` by column default, plus `totalCount`, `eligibleCount`, `createdBy`). Eligibility per `isClassroomPublishEligible` — row `status === "assigned"`, a real assigned room (not the `NO_ROOM_AVAILABLE` / `REMOTE_NO_ROOM_NEEDED` sentinels), an OFFLINE `sessionType`, a `wiseClassId` and `wiseSessionId`, and no `needs_review_missing_capacity` warning ([`data.ts:1213-1263`](../../../src/lib/classrooms/data.ts)).
2. Schedules `runClassroomPublishJob` through `after()` from `next/server`, falling back to a floating promise if `after` throws ([`publish/route.ts:12-26`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/route.ts)). **The job's own failures never reach this response** — they are caught and `console.error`'d ([`publish/route.ts:14-19`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/route.ts)); poll the progress endpoint instead.
3. The background job ([`data.ts:1463-1737`](../../../src/lib/classrooms/data.ts)) returns immediately if the job is already terminal ([`data.ts:1470-1473`](../../../src/lib/classrooms/data.ts)), otherwise flips it to `running`, fetches live Wise sessions, refreshes each row's `currentWiseLocation` from them ([`data.ts:1198-1211`](../../../src/lib/classrooms/data.ts)), marks the ineligible rows `skipped` ([`data.ts:1391-1403`](../../../src/lib/classrooms/data.ts)), loads the Wise location catalog ([`data.ts:1405-1418`](../../../src/lib/classrooms/data.ts)), and then per row: **fails** the row if the location cannot be resolved, if its live Wise session is missing (`Live Wise session … was not found; refusing to publish a stale assignment`, [`data.ts:1573-1582`](../../../src/lib/classrooms/data.ts)), if the target room is occupied by an external live session, or if an unchanged local row still holds the room; **succeeds without a Wise write** when the live location already matches ([`data.ts:1611-1618`](../../../src/lib/classrooms/data.ts)); otherwise queues it. Queued rows are published at concurrency 10 (`PUBLISH_ROW_CONCURRENCY`, [`data.ts:132`](../../../src/lib/classrooms/data.ts)) after dependency resolution, with a temporary-room move to break room-swap cycles ([`data.ts:1420-1461,1623-1712`](../../../src/lib/classrooms/data.ts)). **The only Wise mutation is `location`** ([`updateWiseLocationOnly`, `data.ts:1357-1370`](../../../src/lib/classrooms/data.ts)). Finally the run's publish counters and status are recomputed ([`data.ts:1307-1333,1713`](../../../src/lib/classrooms/data.ts)) and the job is set to `succeeded` / `partial` / `failed` ([`data.ts:1715-1730`](../../../src/lib/classrooms/data.ts)); a throw inside the job marks it `failed` with the error message ([`data.ts:1290-1305,1733-1736`](../../../src/lib/classrooms/data.ts)).

**Response 202** — `{ jobId, progress }` ([`publish/route.ts:46`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/route.ts)), where `progress` is `PublishJobProgress` ([`data.ts:106-124`](../../../src/lib/classrooms/data.ts), built by [`toPublishJobProgress`, `data.ts:631-659`](../../../src/lib/classrooms/data.ts)):

| Key | Type | Notes |
|-----|------|-------|
| `jobId`, `runId` | string | |
| `status` | `pending \| running \| succeeded \| partial \| failed` | Terminal set is `succeeded`/`partial`/`failed` ([`data.ts:609-611`](../../../src/lib/classrooms/data.ts)). |
| `totalCount`, `eligibleCount`, `completedCount`, `successCount`, `failedCount`, `skippedCount` | number | Counters incremented per row as the job runs ([`data.ts:1265-1288`](../../../src/lib/classrooms/data.ts)). |
| `remainingCount` | number | `max(0, totalCount - completedCount)`. |
| `elapsedMs`, `estimatedRemainingMs` | number \| null | Extrapolated from completed attempts; `null` before the job starts or once every eligible row is done ([`data.ts:613-629`](../../../src/lib/classrooms/data.ts)). |
| `lastError` | string \| null | |
| `startedAt`, `finishedAt` | ISO string \| null | |
| `createdAt`, `updatedAt` | ISO string | |

**Status codes:** 202 (job accepted — note the success path is **not** 200) · 401 · 404 (`Assignment run not found`, matched by `message.endsWith("not found")`, [`publish/route.ts:49`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/route.ts)) · 500.

---

### `GET /api/class-assignments/runs/[runId]/publish/[jobId]`

Polls a publish job. Handler: [`publish/[jobId]/route.ts:6-24`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/%5BjobId%5D/route.ts).

**Auth:** session required ([`publish/[jobId]/route.ts:10-13`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/%5BjobId%5D/route.ts)). **Path params:** `runId`, `jobId` — the lookup requires **both** to match, so a job id from another run yields `Publish job not found` ([`data.ts:661-676`](../../../src/lib/classrooms/data.ts)).

**Side effects:** a `running` job whose `startedAt` is more than 6 minutes old (`PUBLISH_JOB_STALE_AFTER_MS`, [`data.ts:133`](../../../src/lib/classrooms/data.ts)) is force-failed on read — `status: "failed"`, `lastError: "Publish job timed out before completing. Retry publishing after refreshing the assignment."`, and the parent run's publish status recomputed ([`data.ts:1335-1355`](../../../src/lib/classrooms/data.ts)). Otherwise a pure read.

**Response 200** — `PublishJobStatusResponse` ([`data.ts:126-129`](../../../src/lib/classrooms/data.ts)):

| Key | Type | Notes |
|-----|------|-------|
| `progress` | `PublishJobProgress` | The same object documented above. |
| `detail` | assignment detail | **Present only once the job is terminal** ([`data.ts:1751-1753`](../../../src/lib/classrooms/data.ts)) — the client's signal to stop polling and re-render. Built by `getClassroomAssignmentByRunId`, which hard-codes `liveRoomBlocks`/`roomConflictWarnings` to `[]` ([`data.ts:1864-1878`](../../../src/lib/classrooms/data.ts)); see DEF-11 in [docs/OPEN-QUESTIONS.md](../../OPEN-QUESTIONS.md). |

**Status codes:** 200 · 401 · 404 (thrown message ends with `not found`, [`publish/[jobId]/route.ts:21`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/publish/%5BjobId%5D/route.ts)) · 500.

---

## Teacher schedule and schedule email

### `GET /api/class-assignments/runs/[runId]/teacher-schedule`

Returns the run's rows regrouped per tutor. Handler: [`teacher-schedule/route.ts:6-23`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/teacher-schedule/route.ts).

**Auth:** session required ([`teacher-schedule/route.ts:10-13`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/teacher-schedule/route.ts)). **Path params:** `runId`. **Request body:** none.

**Side effects:** none — a pure read of the run's `assignmentDate` plus its rows ([`data.ts:1880-1920`](../../../src/lib/classrooms/data.ts)).

**Response 200** — `TeacherSchedule` ([`data.ts:80-97`](../../../src/lib/classrooms/data.ts)):

```jsonc
{
  "tutors": [
    {
      "tutorDisplayName": "…",
      "blocks": [
        {
          "rowId": "…",
          "date": "2026-05-14",   // the run's assignmentDate, repeated per block
          "startTime": "09:00",   // HH:MM formatted from startMinute
          "endTime": "10:30",
          "room": "Joy (TV)",     // "Remote / no room needed" for remote rows
          "studentName": null,
          "subject": null,
          "classType": null,
          "sessionType": null
        }
      ]
    }
  ]
}
```

Tutors are sorted by display name; blocks by `startTime` then `rowId` ([`data.ts:1909-1919`](../../../src/lib/classrooms/data.ts)). The `room` label collapses `status === "remote"` and the `REMOTE_NO_ROOM_NEEDED` sentinel to `"Remote / no room needed"` ([`data.ts:180-185`](../../../src/lib/classrooms/data.ts)).

**Status codes:** 200 · 401 · **500 for a missing run** — this handler has a single catch-all `500` branch and no 404, so `Assignment run not found` ([`data.ts:1889`](../../../src/lib/classrooms/data.ts)) surfaces as a 500 ([`teacher-schedule/route.ts:19-22`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/teacher-schedule/route.ts)). Tracked as DEF-9 in [docs/OPEN-QUESTIONS.md](../../OPEN-QUESTIONS.md).

---

### `GET /api/class-assignments/runs/[runId]/schedule-email/preview`

Builds — without sending — the per-tutor schedule email for a run: recipients, blockers, and fully rendered HTML/text. Handler: [`preview/route.ts:6-24`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/preview/route.ts).

**Auth:** session required ([`preview/route.ts:10-13`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/preview/route.ts)). **Path params:** `runId`. **Query/body:** none — the route calls `getScheduleEmailPreview(db, runId)` with no options, so the preview is always computed for the **primary** sender ([`preview/route.ts:17`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/preview/route.ts), [`schedule-email.ts:478-487`](../../../src/lib/classrooms/schedule-email.ts)).

**Side effects:** `ensureDefaultTutorContacts` **writes** any missing default `tutor_contacts` rows (`onConflictDoNothing` on `canonicalKey`) before the preview is assembled ([`schedule-email.ts:162-191`](../../../src/lib/classrooms/schedule-email.ts)). No email is sent and no email-run row is created.

**Response 200** — `ScheduleEmailPreview` ([`schedule-email.ts:74-86`](../../../src/lib/classrooms/schedule-email.ts)):

| Key | Type | Meaning |
|-----|------|---------|
| `ready` | boolean | `blockers.length === 0` ([`schedule-email.ts:583`](../../../src/lib/classrooms/schedule-email.ts)). |
| `sendable` | boolean | No hard blockers **and** `readyCount > 0` ([`schedule-email.ts:584`](../../../src/lib/classrooms/schedule-email.ts)). |
| `assignmentRunId`, `assignmentDate` | string | From the run row. |
| `subject` | string | `BeGifted schedule for <D/M/YYYY>` ([`schedule-email.ts:193-197,486`](../../../src/lib/classrooms/schedule-email.ts)). |
| `hardBlockers` | `ScheduleEmailBlocker[]` | Run-wide stoppers: `missing_email_config` for an unset `SCHEDULE_EMAIL_APPS_SCRIPT_URL` / `…_SECRET` (or the `…_BACKUP_…` pair when `senderKey` is `backup`), and `no_rows` ([`schedule-email.ts:288-304,460-476,487-497`](../../../src/lib/classrooms/schedule-email.ts)). |
| `blockers` | `ScheduleEmailBlocker[]` | The hard blockers plus per-recipient ones: `missing_recipient_email`, `unfinalized_rows` (rows still `needs_review` / `no_room`). Type union at [`schedule-email.ts:66-72`](../../../src/lib/classrooms/schedule-email.ts). |
| `readyCount`, `blockedCount` | number | Recipient counts by `status` ([`schedule-email.ts:579-580`](../../../src/lib/classrooms/schedule-email.ts)). |
| `recipients` | `ScheduleEmailRecipient[]` | `{ groupId, canonicalKey, tutorDisplayName, email, status: "ready" \| "blocked", blockReason }`, sorted by display name. `email` is the active contact's `onsiteEmail` ([`schedule-email.ts:47-54,513,546`](../../../src/lib/classrooms/schedule-email.ts)). |
| `previews` | `ScheduleEmailPreviewItem[]` | Per recipient: `{ recipient, subject, html, text, blocks, roomSteps, mapImageUrl }` ([`schedule-email.ts:56-64`](../../../src/lib/classrooms/schedule-email.ts)). `mapImageUrl` points at [`GET /api/classrooms/floor-plan-map`](#get-apiclassroomsfloor-plan-map) with that tutor's rooms pipe-joined plus a `v` cache-buster ([`schedule-email.ts:278-286`](../../../src/lib/classrooms/schedule-email.ts)). |

Grouping is per `groupId` (one email per tutor identity group), and a recipient is `blocked` when it has no email **or** its group still has `needs_review`/`no_room` rows ([`schedule-email.ts:510-548`](../../../src/lib/classrooms/schedule-email.ts)).

**Status codes:** 200 · 401 · 404 (thrown message is exactly `Assignment run not found`, [`preview/route.ts:21`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/preview/route.ts); the throw is at [`schedule-email.ts:413`](../../../src/lib/classrooms/schedule-email.ts)) · 500.

---

### `POST /api/class-assignments/runs/[runId]/schedule-email/send`

Sends the per-tutor schedule emails for a run. Handler: [`send/route.ts:59-93`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/send/route.ts).

**Auth:** session required ([`send/route.ts:63-66`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/send/route.ts)). `session.user?.email ?? null` becomes the email run's `createdBy`.

**Request body** — optional, hand-validated by `parseSendOptions` (no Zod, [`send/route.ts:14-57`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/send/route.ts)). An empty or whitespace-only body is treated as `{}`.

| Field | Type | Default | Validation |
|-------|------|---------|------------|
| `recipientGroupIds` | string[] | all previews | Must be an array of strings; any other non-`undefined` value → `400 recipientGroupIds must be an array of strings.` ([`send/route.ts:34-40`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/send/route.ts)). Filters `preview.previews` by `recipient.groupId` ([`schedule-email.ts:1038-1043`](../../../src/lib/classrooms/schedule-email.ts)). |
| `senderKey` | `"primary" \| "backup"` | `"primary"` | Else `400 senderKey must be primary or backup.` ([`send/route.ts:42-47`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/send/route.ts)). Selects which Apps Script URL/secret pair is used ([`schedule-email.ts:288-304`](../../../src/lib/classrooms/schedule-email.ts)). |
| `mode` | `"selected" \| "failed_only"` | `"selected"` | Else `400 mode must be selected or failed_only.` ([`send/route.ts:49-54`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/send/route.ts)). `failed_only` keeps only `ready` recipients with no `sent` row already recorded for this run ([`schedule-email.ts:658-667,1045-1050`](../../../src/lib/classrooms/schedule-email.ts)). |

Non-object bodies raise `Request body must be an object.`; malformed JSON raises `Invalid JSON body.` — both **400**. The route passes `sender = undefined` and never sets `backupSender`, so the real Apps Script sender for `senderKey` is constructed internally ([`send/route.ts:71-77`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/send/route.ts), [`schedule-email.ts:1035`](../../../src/lib/classrooms/schedule-email.ts)).

**Side effects** (`sendScheduleEmailsForRun`, [`schedule-email.ts:1026-1195`](../../../src/lib/classrooms/schedule-email.ts)):

- Recomputes the preview for `senderKey`, including the `tutor_contacts` seeding write.
- Inserts one `classroom_schedule_email_runs` row — `status: "pending"` when sendable, `"blocked"` otherwise ([`schedule-email.ts:1057-1063`](../../../src/lib/classrooms/schedule-email.ts)) — and one `classroom_schedule_email_recipients` row per selected recipient with `sent` / `failed` / `blocked` ([`schedule-email.ts:669-700,814-854`](../../../src/lib/classrooms/schedule-email.ts)).
- **Sends real email** through the Google Apps Script relay, one recipient at a time, with an idempotency key derived from the run and the rendered content ([`schedule-email.ts:648-651,1111-1116`](../../../src/lib/classrooms/schedule-email.ts)).
- **Automatic backup failover:** when `senderKey` is `primary` and a send fails with a quota-exhaustion error, the primary run is finalized and the remaining ready recipients are retried through the backup sender under a second email run ([`schedule-email.ts:652-656,1141-1168`](../../../src/lib/classrooms/schedule-email.ts)). With `senderKey: "backup"`, a quota error instead stops the loop and records the remaining recipients as blocked ([`schedule-email.ts:856-896,1169-1180`](../../../src/lib/classrooms/schedule-email.ts)).

**Response body** — `ScheduleEmailSendResult` ([`schedule-email.ts:121-145`](../../../src/lib/classrooms/schedule-email.ts)), returned for both the 200 and the 409:

```jsonc
{
  "summary": { "attempted": 0, "success": 0, "failed": 0, "blocked": 0 },
  "recipients": [ /* ScheduleEmailRecipient & { sendStatus: "sent"|"failed"|"blocked",
                     resendEmailId, error, senderKey, emailRunId } */ ],
  "preview": { /* ScheduleEmailPreview, as above */ },
  "failover": { "triggered": true, "fromEmailRunId": "…", "toEmailRunId": "…",
                "reason": "…", "attempted": 0, "sent": 0, "failed": 0 }
}
```

`failover` is present only when the backup path ran.

**Status codes:**

| Status | When |
|--------|------|
| 200 | `summary.attempted > 0` — at least one send was attempted ([`send/route.ts:78`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/send/route.ts)). This includes runs where every attempt **failed**; check `summary.failed`. |
| 409 | `summary.attempted === 0` — everything was blocked (missing recipient emails, unfinalized rows, missing Apps Script config, or nothing selected). The full result body is still returned. |
| 400 | Any of the five validation messages above ([`send/route.ts:84-89`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/send/route.ts)). |
| 401 | No session. |
| 404 | `Assignment run not found` ([`send/route.ts:82-83`](../../../src/app/api/class-assignments/runs/%5BrunId%5D/schedule-email/send/route.ts)). |
| 500 | Any other throw. |

---

## Room catalog and floor plan

### `GET /api/classrooms/rooms`

Returns the classroom catalog. Handler: [`rooms/route.ts:6-19`](../../../src/app/api/classrooms/rooms/route.ts).

**Auth:** session required ([`rooms/route.ts:7-10`](../../../src/app/api/classrooms/rooms/route.ts)). **Request:** no params, no body.

**Side effects:** the same `ensureDefaultClassroomRooms` reconciliation write described under `GET /api/class-assignments` — this endpoint is not read-only ([`data.ts:490-496`](../../../src/lib/classrooms/data.ts)).

**Response 200** — `{ rooms: ClassroomRoom[] }` ([`rooms/route.ts:14`](../../../src/app/api/classrooms/rooms/route.ts)): whole `classroom_rooms` rows (`id`, `name`, `hasTv`, `capacity`, `category`, `active`, `sortOrder`, `createdAt`, `updatedAt` — [`schema.ts:1649-1662`](../../../src/lib/db/schema.ts)), ordered by `sortOrder` then `name`. Note the array is wrapped in a `rooms` key, unlike the bare payloads elsewhere on this page.

**Status codes:** 200 · 401 · 500 ([`rooms/route.ts:15-18`](../../../src/app/api/classrooms/rooms/route.ts)).

---

### `GET /api/classrooms/floor-plan-map`

Renders the BeGifted floor plan as an SVG with the requested rooms highlighted and numbered. **This is the only public endpoint on this page** — it is in the middleware allowlist ([`middleware.ts:15`](../../../src/middleware.ts)) and the handler performs no auth check at all, because schedule emails embed it as an `<img>` for recipients who have no session ([`floor-plan-map/route.ts:3-16`](../../../src/app/api/classrooms/floor-plan-map/route.ts), [`schedule-email.ts:278-286`](../../../src/lib/classrooms/schedule-email.ts)). See SEC-3 in [docs/OPEN-QUESTIONS.md](../../OPEN-QUESTIONS.md).

**Query parameters:**

| Param | Type | Notes |
|-------|------|-------|
| `rooms` | string | **Pipe-delimited** room names (e.g. `Do It\|Joy (TV)`), each trimmed, empties dropped; absent → `[]` ([`floor-plan-map/route.ts:5-8`](../../../src/app/api/classrooms/floor-plan-map/route.ts)). Order sets the numbered marker order; duplicates collapse to the first occurrence ([`floor-plan-map.ts:24-32`](../../../src/lib/classrooms/floor-plan-map.ts)). Names must equal a `FLOOR_PLAN_ROOMS[].roomName` exactly ([`floor-plan.ts`](../../../src/lib/classrooms/floor-plan.ts)); unknown names are silently ignored. |
| `v` | string | Not read by the handler — a cache-busting token the email builder appends (`FLOOR_PLAN_MAP_VERSION`, [`schedule-email.ts:14,284`](../../../src/lib/classrooms/schedule-email.ts)). |

Room names arrive URL-encoded and are XML-escaped before being written into the SVG ([`floor-plan-map.ts:15-22`](../../../src/lib/classrooms/floor-plan-map.ts)).

**Side effects:** none — no database, no Wise, pure string rendering.

**Response 200** — an SVG document (1600×900, `viewBox` from `FLOOR_PLAN_VIEWBOX`) with `Content-Type: image/svg+xml; charset=utf-8` and `Cache-Control: public, max-age=3600` ([`floor-plan-map/route.ts:10-15`](../../../src/app/api/classrooms/floor-plan-map/route.ts)). Highlighted rooms are filled orange with a numbered badge; other assignable rooms white; non-assignable rooms pale blue ([`floor-plan-map.ts:56-84`](../../../src/lib/classrooms/floor-plan-map.ts)).

**Status codes:** 200 always. The handler has no try/catch and no error branch; there is no 401 and no 4xx for a bad `rooms` value.

---

## Internal cron endpoints

Both are `GET`, both are guarded solely by `CRON_SECRET`, and both wrap their work in `withCronInvocationAudit`, which inserts a `cron_invocations` row on entry (`outcome: "running"`) and updates it with duration, response status, outcome, linked run ids, a truncated error summary, and a **size-capped digest** of the response body on exit ([`cron-audit.ts:131-190`](../../../src/lib/data-health/cron-audit.ts)). The digest keeps only top-level scalars — arrays and objects collapse to their size, under a 2 KB ceiling ([`cron-audit.ts:63-105`](../../../src/lib/data-health/cron-audit.ts)) — so a large `dates[]` payload is not persisted verbatim. `outcome` is derived from the response: `skipped` for HTTP 202 or a body with `skipped: true` / "already running"; `failed` for `ok: false` / `success: false` / status ≥ 400; else `success` ([`cron-audit.ts:108-117`](../../../src/lib/data-health/cron-audit.ts)). If the handler throws, the wrapper converts it to `500 { error }` and still records the invocation ([`cron-audit.ts:191-206`](../../../src/lib/data-health/cron-audit.ts)).

Neither route reads any query parameter or body — each calls its library entry point with no options.

### `GET /api/internal/class-assignments/morning`

The daily automation: refresh Wise, re-assign the next 7 days, publish what changed, and email tutors. Handler: [`morning/route.ts:8-24`](../../../src/app/api/internal/class-assignments/morning/route.ts). `export const maxDuration = 800` ([`morning/route.ts:6`](../../../src/app/api/internal/class-assignments/morning/route.ts)). Cron `41 23 * * *` UTC = 06:41 Bangkok; job key `classroom_morning`, registered `dangerous: true` ([`vercel.json:48-51`](../../../vercel.json), [`cron-registry.ts:273-288`](../../../src/lib/data-health/cron-registry.ts)).

**Auth:** `CRON_SECRET` bearer ([`morning/route.ts:9-10`](../../../src/app/api/internal/class-assignments/morning/route.ts)).

**Side effects** (`runClassroomMorningAutomation`, [`morning-automation.ts:174-259`](../../../src/lib/classrooms/morning-automation.ts)):

1. **Ensures a fresh Wise sync** — reuses a successful sync finished within 15 minutes, otherwise waits up to 90 s (`DEFAULT_SYNC_WAIT_MS`, polling every 5 s) on a running sync, otherwise triggers one via `runWiseSyncRequest()` ([`morning-automation.ts:25-26,105-168`](../../../src/lib/classrooms/morning-automation.ts)).
2. Asserts the classroom snapshot is fresh ([`data.ts:580-586`](../../../src/lib/classrooms/data.ts)), then fetches all future Wise sessions **once** and reuses them across the whole horizon ([`morning-automation.ts:189-192`](../../../src/lib/classrooms/morning-automation.ts)).
3. Per day across a 7-day Bangkok horizon starting today ([`morning-automation.ts:170-172`](../../../src/lib/classrooms/morning-automation.ts)): runs `runIncrementalClassroomAssignment` (new run + rows + `classroom_automation_events`, `createdBy = "cron@classroom-assignments"`), selects only rows whose Wise location actually needs changing plus their blockers, and **publishes those rows to Wise** ([`morning-automation.ts:195-213`](../../../src/lib/classrooms/morning-automation.ts), [`data.ts:1757-1862`](../../../src/lib/classrooms/data.ts)).
4. For the start date only: sends tutor schedule emails with `mode: "failed_only"` as `cron@classroom-schedule-email`; a failure there is captured into `scheduleEmailError` rather than aborting the run ([`morning-automation.ts:217-233`](../../../src/lib/classrooms/morning-automation.ts)).

**Response 200** — `MorningAutomationResult` ([`morning-automation.ts:37-63`](../../../src/lib/classrooms/morning-automation.ts)):

| Key | Type | Notes |
|-----|------|-------|
| `ok` | boolean | False when rooms, review, publishing or tutor delivery remain unresolved. |
| `noRoomCount`, `needsReviewCount`, `failedPublishCount`, `failedEmailCount`, `blockedEmailCount`, `unmanagedWiseSessionCount` | number | Compact failure counts retained by cron auditing. |
| `errorSummary` | string? | Present for incomplete automation; completed work remains in `dates`. |
| `automationBatchId` | uuid | Ties the horizon's runs and `classroom_automation_events` together. |
| `startDate`, `endDate` | string | The 7-day Bangkok horizon. |
| `sync` | object | `{ mode: "reused" \| "waited" \| "triggered", syncRunId, finishedAt, snapshotId }`. |
| `dates` | array | Per day: `{ date, runId, changedRows, targetPublishRows, publishSummary: { attempted, success, skipped, failed }, scheduleEmail?, scheduleEmailError?, events, detail }`. `detail` is a full [assignment detail](#the-assignment-detail-envelope), so the response is large. |

**Status codes:**

| Status | When |
|--------|------|
| 200 | Automation completed without unresolved rooms, review, publishing or tutor delivery. |
| 401 | Bad or missing `CRON_SECRET`. |
| 500 | The full result with `ok: false`, failure counts and `errorSummary` for incomplete automation; `{ ok: false, error }` on a thrown automation error ([`morning/route.ts:18-21`](../../../src/app/api/internal/class-assignments/morning/route.ts)); or `{"error":"Server misconfigured"}` when `CRON_SECRET` is unset ([`cron-auth.ts:22-24`](../../../src/lib/internal/cron-auth.ts)). |

---

### `GET /api/internal/class-assignments/admin-email`

Sends the daily admin summary of today's classroom assignments — or an "ACTION REQUIRED" alert if the automation is not ready by the final retry. Handler: [`admin-email/route.ts:8-25`](../../../src/app/api/internal/class-assignments/admin-email/route.ts). `export const maxDuration = 300` ([`admin-email/route.ts:6`](../../../src/app/api/internal/class-assignments/admin-email/route.ts)). Cron `4,14,24,36 0 * * *` UTC = four attempts across 07:04–07:36 Bangkok; job key `classroom_admin_email`, registered `dangerous: true` ([`vercel.json:52-55`](../../../vercel.json), [`cron-registry.ts:289-305`](../../../src/lib/data-health/cron-registry.ts)).

**Auth:** `CRON_SECRET` bearer ([`admin-email/route.ts:9-10`](../../../src/app/api/internal/class-assignments/admin-email/route.ts)).

**Behavior** (`sendAdminClassroomScheduleEmail`, [`admin-schedule-email.ts:345-491`](../../../src/lib/classrooms/admin-schedule-email.ts)) — the date is today in Bangkok and the primary Apps Script sender is used, since the route passes no options:

- Returns `status: "skipped"` **without sending** when a successfully sent admin-email run already exists for the date, or when another invocation holds the delivery claim ([`admin-schedule-email.ts:355-366,399-410`](../../../src/lib/classrooms/admin-schedule-email.ts)).
- Returns `status: "pending"` **without writing** when there is no assignment run yet or a publish job is still pending **and** the Bangkok clock is before 07:36 (`FINAL_RETRY_MINUTE`, [`admin-schedule-email.ts:24`](../../../src/lib/classrooms/admin-schedule-email.ts)) — this is how the four staggered attempts back off ([`admin-schedule-email.ts:374-387`](../../../src/lib/classrooms/admin-schedule-email.ts)).
- Otherwise atomically claims the existing date-keyed `classroom_admin_email_runs` row (creating it if absent); failed/partial runs retry, successful recipients are skipped, and abandoned claims are recoverable after ten minutes. Recipient attempt history is retained. The claim timestamp fences stale workers. The subject flips from `BeGifted classroom assignments - <date>` to `ACTION REQUIRED: classroom assignments need attention - <date>` whenever rooms, publishing or tutor delivery remain unresolved, [`admin-schedule-email.ts:389-397`](../../../src/lib/classrooms/admin-schedule-email.ts). The sender **sends one email per unsent `admin_users` address**, writing a `classroom_admin_email_recipients` row per address ([`admin-schedule-email.ts:206-211,448-478`](../../../src/lib/classrooms/admin-schedule-email.ts)). No recipients configured → `status: "failed"` with `No admin_users email recipients are configured.` ([`admin-schedule-email.ts:426-447`](../../../src/lib/classrooms/admin-schedule-email.ts)). Otherwise the final status is `sent`, or `partial`/`failed` depending on how many sends threw ([`admin-schedule-email.ts:479-491`](../../../src/lib/classrooms/admin-schedule-email.ts)).

**Response body** — `AdminScheduleEmailResult` ([`admin-schedule-email.ts:26-35`](../../../src/lib/classrooms/admin-schedule-email.ts)): `{ status: "sent" | "partial" | "failed" | "pending" | "skipped", assignmentDate, assignmentRunId, emailRunId, attempted, success, failed, message, errorSummary? }`. Returned as the body for both the 200 and the result-driven 500.

**Status codes:**

| Status | When |
|--------|------|
| 200 | `result.status` is `sent`, `pending` or `skipped` ([`admin-email/route.ts:17`](../../../src/app/api/internal/class-assignments/admin-email/route.ts)). |
| 401 | Bad or missing `CRON_SECRET`. |
| 500 | `result.status` is `failed` or `partial` (the `AdminScheduleEmailResult` is still the body), or a thrown error (`{ error }`, [`admin-email/route.ts:19-22`](../../../src/app/api/internal/class-assignments/admin-email/route.ts)); or `{"error":"Server misconfigured"}` when `CRON_SECRET` is unset. |

---

## Test coverage

[`src/app/api/class-assignments/__tests__/route.test.ts`](../../../src/app/api/class-assignments/__tests__/route.test.ts) exercises the run endpoint (auth, invalid date, override policy, the 409 stale-snapshot branch), the row override, publish start and progress, the schedule-email preview, and seven schedule-email send cases including selected recipients, `failed_only` through the backup sender, automatic failover metadata, the two validation rejections, and the 409 blocked path. [`src/app/api/classrooms/__tests__/floor-plan-map-route.test.ts`](../../../src/app/api/classrooms/__tests__/floor-plan-map-route.test.ts) covers the public SVG. `GET /api/class-assignments`, `GET …/teacher-schedule`, `GET /api/classrooms/rooms`, and the two internal cron routes have **no route-level test** — their libraries are covered under [`src/lib/classrooms/__tests__/`](../../../src/lib/classrooms/__tests__/).

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
