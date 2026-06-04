# Classrooms & Assignments API

**Status:** Stable (in-flight WIP for schedule-email and morning-automation paths — see notes per endpoint).

Mechanical reference for the 12 HTTP endpoints that drive the classroom room-assignment workflow: generating a per-date assignment run, overriding room placements, publishing eligible OFFLINE locations back to Wise, emailing tutor schedules, and the two cron handlers that automate the morning run and the admin summary email. The two read-only catalog/render endpoints (`/api/classrooms/rooms`, `/api/classrooms/floor-plan-map`) are also covered here.

This page documents request/response shapes, auth, side effects, and status codes. The **meaning** of the workflow (why rooms are assigned, eligibility rules, publish policy, the writeback contract) lives in the corresponding `features/*` docs. Database column definitions are the responsibility of the schema file ([`src/lib/db/schema.ts`](../../../src/lib/db/schema.ts)); response objects below name the table they serialize rather than restating every column.

## Conventions shared across these endpoints

- **Two auth regimes.** The ten user-facing endpoints require an authenticated Auth.js session: `const session = await auth(); if (!session) return 401`. The two cron handlers under `/api/internal/class-assignments/*` instead require the `CRON_SECRET` bearer token (no user session). The single exception is `GET /api/classrooms/floor-plan-map`, which has **no auth check at all** (it renders a static SVG).
- **Dynamic route params are Promises.** Per this Next.js version, handlers receive `{ params }: { params: Promise<{ runId: string; ... }> }` and must `await params` ([`publish/route.ts:30,37`](../../../src/app/api/class-assignments/runs/[runId]/publish/route.ts)).
- **Error envelope.** Caught errors return `{ "error": string }` (some add `details`/`code`). The HTTP status is derived from the error *message* via string matching — e.g. messages ending in `"not found"` map to 404, messages starting with `"Invalid date"` map to 400. This is a deliberate, if fragile, pattern; the exact match string is noted per endpoint.
- **Snapshot freshness.** Assignment generation reads the active Wise snapshot and refuses to run against stale data (older than 15 minutes — `CLASSROOM_ASSIGNMENT_FRESHNESS_MS` at [`data.ts:129`](../../../src/lib/classrooms/data.ts)).
- **`ClassroomAssignmentDetail`** is the workhorse response object, returned by most run-scoped endpoints. Its shape ([`data.ts:45-52`](../../../src/lib/classrooms/data.ts)):

  ```ts
  {
    run: ClassroomRun | null,            // row from classroom_assignment_runs
    rows: ClassroomRow[],                // rows from classroom_assignment_rows
    rooms: ClassroomRoom[],              // full active room catalog
    snapshotMeta: {                      // ClassroomSnapshotMeta (data.ts:54-59)
      snapshotId: string | null,
      latestSyncFinishedAt: string | null,
      staleAgeMs: number | null,
      fresh: boolean
    },
    liveRoomBlocks: LiveRoomBlock[],     // data.ts:61-65
    roomConflictWarnings: RoomConflictWarning[]  // data.ts:67-73
  }
  ```

  `ClassroomRun`, `ClassroomRow`, `ClassroomRoom`, and `ClassroomPublishJob` are Drizzle `$inferSelect` types over the `classroom_assignment_runs`, `classroom_assignment_rows`, `classroom_rooms`, and `classroom_publish_jobs` tables respectively ([`data.ts:40-43`](../../../src/lib/classrooms/data.ts); columns at [`schema.ts:741-827`](../../../src/lib/db/schema.ts) and `classroom_publish_jobs` at [`schema.ts:1016`](../../../src/lib/db/schema.ts)).

---

## Assignment runs

### `GET /api/class-assignments`

Load the latest assignment run (and live-Wise conflict overlay) for one Bangkok calendar date.

- **Auth:** session required → `401 {"error":"Unauthorized"}` ([`route.ts:10-13`](../../../src/app/api/class-assignments/route.ts)).
- **Query params:** `date` (required, `YYYY-MM-DD`). Missing → `400 {"error":"date is required"}`. The value is validated by `assertIsoDate`, which checks the `^\d{4}-\d{2}-\d{2}$` shape and that it parses as a real Bangkok-midnight date ([`data.ts:149-158`](../../../src/lib/classrooms/data.ts)).
- **Response:** `200` with a `ClassroomAssignmentDetail`. If no run exists for the date, `run` is `null` (the handler still returns the room catalog, snapshot meta, and any live Wise room blocks). Built by `getClassroomAssignmentForDate` ([`data.ts:682`](../../../src/lib/classrooms/data.ts)).
- **Status codes:** `200` success · `400` missing `date`, or message starting `"Invalid date"` (malformed date) · `401` no session · `500` any other error ([`route.ts:23-27`](../../../src/app/api/class-assignments/route.ts)).

### `POST /api/class-assignments/run`

Generate (or regenerate) a local assignment run for a Bangkok date. Pure local computation — this does **not** write to Wise.

- **Auth:** session required → `401` ([`route.ts:18-21`](../../../src/app/api/class-assignments/run/route.ts)).
- **`maxDuration`:** 300s ([`route.ts:10`](../../../src/app/api/class-assignments/run/route.ts)).
- **Request body** (Zod `runRequestSchema`, [`route.ts:12-15`](../../../src/app/api/class-assignments/run/route.ts)):

  ```ts
  {
    date: string,                         // required (validated downstream as YYYY-MM-DD)
    forceReassign?: boolean               // optional, default false
  }
  ```

  Non-JSON body → `400 {"error":"Invalid JSON"}`. Schema failure → `400 {"error":"Invalid request","details": <zod flatten>}`.
- **Side effects:** `runClassroomAssignment` ([`data.ts:864`](../../../src/lib/classrooms/data.ts)) runs the assignment engine and persists a new run + rows; `createdBy` is set to the session user's email. `forceReassign: true` re-runs placement instead of keeping prior overrides/continuity.
- **Response:** `200` with the resulting `ClassroomAssignmentDetail`.
- **Status codes:** `200` success · `400` invalid JSON, Zod failure, or message starting `"Invalid date"` · `401` no session · **`409`** when the active snapshot is stale: the handler catches `StaleClassroomAssignmentSnapshotError` and returns `{ error, code: "STALE_ASSIGNMENT_SNAPSHOT", latestSyncFinishedAt, staleAgeMs }` ([`route.ts:46-56`](../../../src/app/api/class-assignments/run/route.ts); error class at [`data.ts:131-147`](../../../src/lib/classrooms/data.ts)) · `500` any other error.

### `PATCH /api/class-assignments/runs/[runId]/rows/[rowId]`

Set or clear a manual room override on a single assignment row, then recalculate the run.

- **Auth:** session required → `401` ([`route.ts:15-18`](../../../src/app/api/class-assignments/runs/[runId]/rows/[rowId]/route.ts)).
- **Path params:** `runId`, `rowId` (awaited from `params`).
- **Request body** (Zod `overrideRequestSchema`, [`route.ts:7-9`](../../../src/app/api/class-assignments/runs/[runId]/rows/[rowId]/route.ts)):

  ```ts
  { overrideRoom?: string | null }        // trimmed; nullable; optional
  ```

  The handler normalizes the value with `parsed.data.overrideRoom?.trim() || null`, so an empty/whitespace string clears the override ([`route.ts:40`](../../../src/app/api/class-assignments/runs/[runId]/rows/[rowId]/route.ts)). Non-JSON → `400 {"error":"Invalid JSON"}`. Schema failure → `400 {"error":"Invalid request","details": <zod flatten>}`.
- **Side effects:** `updateClassroomAssignmentOverride` ([`data.ts:1097`](../../../src/lib/classrooms/data.ts)) writes the override and recomputes the run's room placements.
- **Response:** `200` with the recalculated `ClassroomAssignmentDetail`.
- **Status codes:** `200` success · `400` invalid JSON / Zod failure · `401` no session · `404` when the error message ends in `"not found"` (`"Assignment run not found"` at [`data.ts:1106`](../../../src/lib/classrooms/data.ts), `"Assignment row not found"` at [`data.ts:1110`](../../../src/lib/classrooms/data.ts)) · `500` otherwise ([`route.ts:43-47`](../../../src/app/api/class-assignments/runs/[runId]/rows/[rowId]/route.ts)).

### `GET /api/class-assignments/runs/[runId]/teacher-schedule`

Return a per-tutor grouping of the run's assignment rows for the teacher-schedule view.

- **Auth:** session required → `401` ([`route.ts:10-13`](../../../src/app/api/class-assignments/runs/[runId]/teacher-schedule/route.ts)).
- **Path params:** `runId`.
- **Response:** `200` with a `TeacherSchedule` ([`data.ts:87-92`](../../../src/lib/classrooms/data.ts)):

  ```ts
  {
    tutors: Array<{
      tutorDisplayName: string,
      blocks: Array<{                      // TeacherScheduleBlock (data.ts:75-85)
        rowId: string, date: string,
        startTime: string, endTime: string,
        room: string,
        studentName: string | null, subject: string | null,
        classType: string | null, sessionType: string | null
      }>
    }>
  }
  ```

  Built by `getTeacherScheduleForRun` ([`data.ts:1816`](../../../src/lib/classrooms/data.ts)).
- **Status codes:** `200` success · `401` no session · `500` any error (this handler does **not** special-case "not found" — a missing run surfaces as `500`; `getTeacherScheduleForRun` throws `"Assignment run not found"` at [`data.ts:1825`](../../../src/lib/classrooms/data.ts), which falls through to the catch-all `500` at [`route.ts:19-22`](../../../src/app/api/class-assignments/runs/[runId]/teacher-schedule/route.ts)).

---

## Publishing to Wise

Publishing is **asynchronous**: `POST .../publish` enqueues a background job and returns immediately with `202`; the client polls `GET .../publish/[jobId]` for progress. Only eligible OFFLINE rows are written back, and only the Wise `location` field is updated (eligibility rules at [`data.ts:1194-1215`](../../../src/lib/classrooms/data.ts)).

### `POST /api/class-assignments/runs/[runId]/publish`

Create a publish job for a run and schedule it to run in the background.

- **Auth:** session required → `401` ([`route.ts:32-35`](../../../src/app/api/class-assignments/runs/[runId]/publish/route.ts)).
- **`maxDuration`:** 300s ([`route.ts:10`](../../../src/app/api/class-assignments/runs/[runId]/publish/route.ts)).
- **Path params:** `runId`. **Request body:** none (ignored).
- **Side effects:**
  1. `createClassroomPublishJob` inserts a row in `classroom_publish_jobs` with `totalCount`/`eligibleCount` precomputed and `createdBy` = session email ([`data.ts:1217-1244`](../../../src/lib/classrooms/data.ts)).
  2. The job is dispatched to run **after the response** via `after(task)` (Next.js `after`), with a fallback to fire-and-forget `void task()` if `after` throws ([`route.ts:12-26`](../../../src/app/api/class-assignments/runs/[runId]/publish/route.ts)). The background task calls `runClassroomPublishJob`, which performs the actual Wise `location` writebacks; failures are logged, not surfaced to this response.
- **Response:** **`202 Accepted`** with `{ jobId: string, progress: PublishJobProgress }` (see the progress shape under the `GET` below) ([`route.ts:46`](../../../src/app/api/class-assignments/runs/[runId]/publish/route.ts)).
- **Status codes:** `202` job created · `401` no session · `404` when the error message ends in `"not found"` (`"Assignment run not found"`, [`data.ts:1226`](../../../src/lib/classrooms/data.ts)) · `500` otherwise ([`route.ts:47-51`](../../../src/app/api/class-assignments/runs/[runId]/publish/route.ts)).

### `GET /api/class-assignments/runs/[runId]/publish/[jobId]`

Poll the progress of a publish job. Self-heals stale "running" jobs.

- **Auth:** session required → `401` ([`route.ts:10-13`](../../../src/app/api/class-assignments/runs/[runId]/publish/[jobId]/route.ts)).
- **Path params:** `runId`, `jobId` (both awaited; the job is looked up scoped to its run).
- **Response:** `200` with a `PublishJobStatusResponse` ([`data.ts:121-124`](../../../src/lib/classrooms/data.ts)):

  ```ts
  {
    progress: {                            // PublishJobProgress (data.ts:101-119)
      jobId, runId, status,                // status from classroom_publish_jobs
      totalCount, eligibleCount, completedCount,
      successCount, failedCount, skippedCount, remainingCount,
      elapsedMs: number | null,
      estimatedRemainingMs: number | null,
      lastError: string | null,
      startedAt, finishedAt,               // ISO strings or null
      createdAt, updatedAt                 // ISO strings
    },
    detail?: ClassroomAssignmentDetail     // present ONLY when the job is terminal
  }
  ```

  `detail` is attached only when `isPublishJobTerminal(status)` is true (i.e. the job finished) ([`data.ts:1732-1734`](../../../src/lib/classrooms/data.ts)). Timestamps are serialized via `toISOString()` in `toPublishJobProgress` ([`data.ts:618-646`](../../../src/lib/classrooms/data.ts)).
- **Side effect:** a job stuck in `running` past the stale threshold (`PUBLISH_JOB_STALE_AFTER_MS` = 6 min, [`data.ts:128`](../../../src/lib/classrooms/data.ts)) is marked `failed` on read before the response is built ([`data.ts:1726-1728`](../../../src/lib/classrooms/data.ts)).
- **Status codes:** `200` success · `401` no session · `404` when the error message ends in `"not found"` (`"Publish job not found"`, [`data.ts:661`](../../../src/lib/classrooms/data.ts)) · `500` otherwise ([`route.ts:19-23`](../../../src/app/api/class-assignments/runs/[runId]/publish/[jobId]/route.ts)).

---

## Schedule emails (tutor-facing)

These two endpoints preview and send per-tutor schedule emails for a run. Implementation lives in [`src/lib/classrooms/schedule-email.ts`](../../../src/lib/classrooms/schedule-email.ts).

### `GET /api/class-assignments/runs/[runId]/schedule-email/preview`

Build the per-recipient email preview (HTML/text, room steps, blockers) without sending anything.

- **Auth:** session required → `401` ([`route.ts:10-13`](../../../src/app/api/class-assignments/runs/[runId]/schedule-email/preview/route.ts)).
- **Path params:** `runId`. **Query/body:** none.
- **Response:** `200` with a `ScheduleEmailPreview` ([`schedule-email.ts:74-86`](../../../src/lib/classrooms/schedule-email.ts)):

  ```ts
  {
    ready: boolean, sendable: boolean,
    assignmentRunId: string, assignmentDate: string, subject: string,
    hardBlockers: ScheduleEmailBlocker[],  // schedule-email.ts:66-72
    blockers: ScheduleEmailBlocker[],
    readyCount: number, blockedCount: number,
    recipients: ScheduleEmailRecipient[],  // schedule-email.ts:47-54
    previews: ScheduleEmailPreviewItem[]   // per-recipient subject/html/text/blocks/roomSteps/mapImageUrl (schedule-email.ts:56-64)
  }
  ```

  Built by `getScheduleEmailPreview` ([`schedule-email.ts:478`](../../../src/lib/classrooms/schedule-email.ts)). As a side effect it calls `ensureDefaultTutorContacts(db)` to seed the tutor-contact table before resolving recipient emails ([`schedule-email.ts:483`](../../../src/lib/classrooms/schedule-email.ts)).
- **Status codes:** `200` success · `401` no session · `404` when the message is exactly `"Assignment run not found"` ([`schedule-email.ts:413`](../../../src/lib/classrooms/schedule-email.ts)) · `500` otherwise ([`route.ts:19-23`](../../../src/app/api/class-assignments/runs/[runId]/schedule-email/preview/route.ts)).

### `POST /api/class-assignments/runs/[runId]/schedule-email/send`

Send the schedule emails for a run (optionally to a subset of recipients, via a chosen sender, in a chosen mode).

- **Auth:** session required → `401` ([`route.ts:63-66`](../../../src/app/api/class-assignments/runs/[runId]/schedule-email/send/route.ts)).
- **Path params:** `runId`.
- **Request body:** optional. An **empty body is valid** and means "send to all ready recipients with defaults" — the handler reads the raw text and returns `{}` when blank ([`route.ts:14-16`](../../../src/app/api/class-assignments/runs/[runId]/schedule-email/send/route.ts)). When present, the body is hand-validated (no Zod) into `ScheduleEmailSendOptions` ([`schedule-email.ts:107-112`](../../../src/lib/classrooms/schedule-email.ts)):

  ```ts
  {
    recipientGroupIds?: string[],          // must be an array of strings if present
    senderKey?: "primary" | "backup",      // SENDER_KEYS allow-list (route.ts:11)
    mode?: "selected" | "failed_only"      // SEND_MODES allow-list (route.ts:12)
  }
  ```

  Validation throws specific messages that map to `400`: `"Invalid JSON body."`, `"Request body must be an object."`, `"recipientGroupIds must be an array of strings."`, `"senderKey must be primary or backup."`, `"mode must be selected or failed_only."` ([`route.ts:18-56,84-89`](../../../src/app/api/class-assignments/runs/[runId]/schedule-email/send/route.ts)).
- **Side effects:** `sendScheduleEmailsForRun` ([`schedule-email.ts:1026`](../../../src/lib/classrooms/schedule-email.ts)) records an email run, dispatches messages through the Apps Script sender (default sender key `primary`, default mode `selected`), can auto-failover to a backup sender, and persists per-recipient outcomes. `createdBy` = session email.
- **Response:** a `ScheduleEmailSendResult` ([`schedule-email.ts:121-145`](../../../src/lib/classrooms/schedule-email.ts)) with `summary {attempted, success, failed, blocked}`, per-recipient `recipients[]`, the `preview`, and an optional `failover` block. **The HTTP status encodes whether anything was attempted:** `200` when `result.summary.attempted > 0`, otherwise **`409`** (nothing sendable — all selected recipients blocked) ([`route.ts:78-79`](../../../src/app/api/class-assignments/runs/[runId]/schedule-email/send/route.ts)).
- **Status codes:** `200` at least one send attempted · `409` zero attempted · `400` any of the validation messages above · `401` no session · `404` message `"Assignment run not found"` · `500` otherwise ([`route.ts:80-92`](../../../src/app/api/class-assignments/runs/[runId]/schedule-email/send/route.ts)).

---

## Room catalog & floor plan

### `GET /api/classrooms/rooms`

List the active classroom room catalog (seeds defaults on first call).

- **Auth:** session required → `401` ([`route.ts:7-10`](../../../src/app/api/classrooms/rooms/route.ts)).
- **Query/body:** none.
- **Response:** `200` with `{ rooms: ClassroomRoom[] }` — each room is a `classroom_rooms` row (`id, name, hasTv, capacity, category, active, sortOrder, createdAt, updatedAt`; [`schema.ts:741-754`](../../../src/lib/db/schema.ts)). `listClassroomRooms` calls `ensureDefaultClassroomRooms` first, so the 24-room BeGifted catalog is seeded if the table is empty ([`data.ts:485-486`](../../../src/lib/classrooms/data.ts)).
- **Status codes:** `200` success · `401` no session · `500` any error ([`route.ts:15-18`](../../../src/app/api/classrooms/rooms/route.ts)).

### `GET /api/classrooms/floor-plan-map`

Render a BeGifted floor-plan as an SVG image, with the requested rooms highlighted and numbered in order.

- **Auth:** **none.** This handler has no `auth()` call and is publicly renderable — it produces a static SVG used as the `mapImageUrl` in schedule emails ([`route.ts:3`](../../../src/app/api/classrooms/floor-plan-map/route.ts); referenced as `mapImageUrl` in `ScheduleEmailPreviewItem`, [`schedule-email.ts:63`](../../../src/lib/classrooms/schedule-email.ts)).
- **Query params:** `rooms` — a **pipe-delimited** (`|`) list of room names; each segment is trimmed and empties dropped. Absent → empty selection (the base floor plan with no highlights) ([`route.ts:4-8`](../../../src/app/api/classrooms/floor-plan-map/route.ts)).
- **Response:** `200` with the raw SVG string from `renderFloorPlanMapSvg` ([`floor-plan-map.ts:56`](../../../src/lib/classrooms/floor-plan-map.ts)). Headers: `Content-Type: image/svg+xml; charset=utf-8` and `Cache-Control: public, max-age=3600` ([`route.ts:11-14`](../../../src/app/api/classrooms/floor-plan-map/route.ts)).
- **Status codes:** `200` only — there is no try/catch and no auth gate, so this endpoint does not emit `4xx`/`5xx` under normal input.

---

## Cron handlers (internal)

Both endpoints below are **Vercel Cron** jobs, registered in [`vercel.json`](../../../vercel.json) and documented in the cron registry ([`reference/crons.md`](../crons.md)). They authenticate with `CRON_SECRET`, not a user session: `rejectInvalidCronSecret(request)` returns `401 {"error":"Unauthorized"}` on a bad/missing token and `500 {"error":"Server misconfigured"}` if `CRON_SECRET` is unset on the server ([`cron-auth.ts:19-26`](../../../src/lib/internal/cron-auth.ts)). Vercel invokes them via `GET` with `Authorization: Bearer $CRON_SECRET`.

### `GET /api/internal/class-assignments/morning`

Daily morning automation: ensure a fresh Wise sync, run incremental assignments across the horizon, publish eligible OFFLINE rows to Wise, and send the day's tutor schedule emails (`failed_only` mode).

- **Schedule:** `45 23 * * *` UTC (06:45 Bangkok) ([`vercel.json`](../../../vercel.json); [`crons.md`](../crons.md)).
- **Auth:** `CRON_SECRET` bearer → `401`/`500` per the shared rule above ([`route.ts:8-9`](../../../src/app/api/internal/class-assignments/morning/route.ts)).
- **`maxDuration`:** 800s ([`route.ts:5`](../../../src/app/api/internal/class-assignments/morning/route.ts)).
- **Side effects:** `runClassroomMorningAutomation` ([`morning-automation.ts:180`](../../../src/lib/classrooms/morning-automation.ts)) — reuses/waits-for/triggers a Wise sync, fetches all future sessions, runs `runIncrementalClassroomAssignment` per horizon date, selects publish targets and calls `publishClassroomAssignmentRun` (real Wise `location` writebacks), and for the start date sends schedule emails in `failed_only` mode. Schedule-email errors are caught per-date and reported in the result, not thrown.
- **Response:** `200` with a `MorningAutomationResult` ([`morning-automation.ts:51-62`](../../../src/lib/classrooms/morning-automation.ts)): `{ ok: true, automationBatchId, startDate, endDate, sync: { mode, syncRunId, finishedAt }, dates: MorningAutomationDateResult[] }`. Each `dates[]` entry carries `runId`, `changedRows`, `targetPublishRows`, `publishSummary`, optional `scheduleEmail`/`scheduleEmailError`, `events`, and the full `detail` ([`morning-automation.ts:36-49`](../../../src/lib/classrooms/morning-automation.ts)).
- **Status codes:** `200` on success (the route does not branch on the result body) · `401`/`500` from the cron-secret gate · `500 {"ok":false,"error": <message>}` if the automation throws ([`route.ts:14-17`](../../../src/app/api/internal/class-assignments/morning/route.ts)).

### `GET /api/internal/class-assignments/admin-email`

Send the admin-facing classroom schedule summary email (publish + tutor-email rollup) for the current Bangkok date.

- **Schedule:** `0,10,20,30 0 * * *` UTC (07:00–07:30 Bangkok, 4×) ([`vercel.json`](../../../vercel.json); [`crons.md`](../crons.md)).
- **Auth:** `CRON_SECRET` bearer → `401`/`500` per the shared rule above ([`route.ts:8-9`](../../../src/app/api/internal/class-assignments/admin-email/route.ts)).
- **`maxDuration`:** 300s ([`route.ts:5`](../../../src/app/api/internal/class-assignments/admin-email/route.ts)).
- **Side effects:** `sendAdminClassroomScheduleEmail` ([`admin-schedule-email.ts:340`](../../../src/lib/classrooms/admin-schedule-email.ts)) loads the day's run, publish jobs, and tutor-email rollup, then emails the admin allow-list. It is idempotent per date (skips if a terminal admin email already exists).
- **Response:** an `AdminScheduleEmailResult` ([`admin-schedule-email.ts:21-30`](../../../src/lib/classrooms/admin-schedule-email.ts)): `{ status: "sent"|"partial"|"failed"|"pending"|"skipped", assignmentDate, assignmentRunId, emailRunId, attempted, success, failed, message }`.
- **Status codes:** `200` when `result.status !== "failed"` (covers `sent`/`partial`/`pending`/`skipped`); **`500` when `result.status === "failed"`** — note the result body is still the `AdminScheduleEmailResult`, not the `{error}` envelope ([`route.ts:13-14`](../../../src/app/api/internal/class-assignments/admin-email/route.ts)) · `401`/`500` from the cron-secret gate · `500 {"error": <message>}` if the call throws ([`route.ts:15-18`](../../../src/app/api/internal/class-assignments/admin-email/route.ts)).

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
