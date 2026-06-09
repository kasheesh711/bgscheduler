# Classrooms & Assignments API

Mechanical reference for the 12 HTTP endpoints that back the **Classroom Assignments** feature (room catalog, daily room-assignment runs, manual overrides, Wise location publish, teacher/admin schedule emails, and the two morning-automation crons). For purpose, rules, and flows see [`docs/features/classroom-assignments.md`](../../features/classroom-assignments.md).

All routes live under `src/app/api/**/route.ts` (Next.js App Router). Dynamic route segments (`[runId]`, `[rowId]`, `[jobId]`) are `Promise`-wrapped params and `await`ed inside each handler.

## Auth tiers

| Tier | Mechanism | Failure |
|---|---|---|
| **admin** | `auth()` session (Auth.js) — any signed-in admin user | `401 {"error":"Unauthorized"}` |
| **public** | none (no `auth()`, not cron-gated) | n/a |
| **cron** | `rejectInvalidCronSecret(request)` — constant-time `Bearer ${CRON_SECRET}` compare (`src/lib/internal/cron-auth.ts:19`) | `401 {"error":"Unauthorized"}`, or `500 {"error":"Server misconfigured"}` when `CRON_SECRET` is unset (`cron-auth.ts:23`) |

The standard mutating-route error envelope is `{"error": string}`; Zod failures additionally carry `details` from `.error.flatten()`.

## Endpoint summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/classrooms/rooms` | admin | List the classroom-room catalog |
| GET | `/api/classrooms/floor-plan-map` | public | Render the floor-plan as an SVG with optional highlighted rooms |
| GET | `/api/class-assignments` | admin | Load the latest assignment run + rows for a Bangkok date |
| POST | `/api/class-assignments/run` | admin | Generate (or regenerate) the room assignment for a date |
| PATCH | `/api/class-assignments/runs/[runId]/rows/[rowId]` | admin | Set/clear a manual room override on one row |
| POST | `/api/class-assignments/runs/[runId]/publish` | admin | Start an async Wise-location publish job for a run |
| GET | `/api/class-assignments/runs/[runId]/publish/[jobId]` | admin | Poll publish-job progress |
| GET | `/api/class-assignments/runs/[runId]/teacher-schedule` | admin | Per-tutor schedule view for a run |
| GET | `/api/class-assignments/runs/[runId]/schedule-email/preview` | admin | Build the per-tutor schedule-email preview |
| POST | `/api/class-assignments/runs/[runId]/schedule-email/send` | admin | Send schedule emails to tutors for a run |
| GET | `/api/internal/class-assignments/morning` | cron | Morning automation: sync → assign → publish → email |
| GET | `/api/internal/class-assignments/admin-email` | cron | Send the admin schedule-summary email |

---

## Classroom catalog

### GET `/api/classrooms/rooms`

Source: `src/app/api/classrooms/rooms/route.ts`.

- **Auth**: admin (`route.ts:7-10`).
- **Request**: none.
- **Response** `200`: `{ rooms: ClassroomRoom[] }`. Returned by `listClassroomRooms(getDb())` (`route.ts:13`), which first seeds the default room set via `ensureDefaultClassroomRooms` and returns rooms ordered by `sortOrder` then `name` (`src/lib/classrooms/data.ts:490-496`). Each `ClassroomRoom` is the `classroom_rooms` row (`schema.ts:881-894`): `id`, `name`, `hasTv`, `capacity`, `category` (`classroom_room_category` enum, default `standard`), `active`, `sortOrder`, `createdAt`, `updatedAt`.
- **Errors**: `401` unauthenticated; `500 {"error": message}` on any failure (`route.ts:15-18`).

### GET `/api/classrooms/floor-plan-map`

Source: `src/app/api/classrooms/floor-plan-map/route.ts`. **Public — no auth and no cron gate** (the handler never calls `auth()`).

- **Query**: `rooms` (optional). A `|`-delimited list of room names to highlight; each segment is trimmed and empties dropped (`route.ts:5-8`). Omitted → empty highlight set.
- **Response** `200`: an SVG document (`Content-Type: image/svg+xml; charset=utf-8`, `Cache-Control: public, max-age=3600`) produced by `renderFloorPlanMapSvg(rooms)` (`route.ts:10-15`, renderer at `src/lib/classrooms/floor-plan-map.ts`). The body is markup, not JSON. Unknown room names simply do not match any geometry.
- **Errors**: none modeled — the handler does not validate input or branch on errors.

> This endpoint is the `mapImageUrl` target embedded in schedule emails.

---

## Assignment runs

### GET `/api/class-assignments`

Source: `src/app/api/class-assignments/route.ts`.

- **Auth**: admin (`route.ts:10-13`).
- **Query**: `date` (**required**, `YYYY-MM-DD`). Missing → `400 {"error":"date is required"}` (`route.ts:15-18`). The value is validated by `assertIsoDate` (`data.ts:154-163`), which requires the `^\d{4}-\d{2}-\d{2}$` shape and a parseable Bangkok-offset date.
- **Response** `200`: a `ClassroomAssignmentDetail` from `getClassroomAssignmentForDate` (`data.ts:695-709`):

  ```
  {
    run: ClassroomRun | null,          // latest run for the date, or null if none
    rows: ClassroomRow[],              // assignment rows ([] when run is null)
    rooms: ClassroomRoom[],            // current catalog
    snapshotMeta: {                    // ClassroomSnapshotMeta (data.ts:54-59)
      snapshotId, latestSyncFinishedAt, staleAgeMs, fresh
    },
    liveRoomBlocks: [],                // always [] on this read path (data.ts:704,708)
    roomConflictWarnings: []           // always [] on this read path
  }
  ```

  `ClassroomRun` is the `classroom_assignment_runs` row (`schema.ts:896-916`): `id`, `assignmentDate`, `snapshotId`, `status` (`classroom_assignment_run_status` enum, default `completed`), `forceReassign`, `sourceRunId`, `automationBatchId`, `reconciliationMode`, `changeSummary`, plus counters `totalSessions`/`assignedCount`/`needsReviewCount`/`noRoomCount`/`remoteCount`/`publishedCount`/`failedPublishCount`, `createdBy`, timestamps. `ClassroomRow` is the `classroom_assignment_rows` row (`schema.ts:922-955+`): identity/session fields (`groupId`, `tutorDisplayName`, `wiseTeacherId`, `wiseSessionId`, `wiseClassId`, …), timing (`startMinute`/`endMinute`/`weekday`), `currentWiseLocation`, `preferredRoom`, `overrideRoom`, `assignedRoom`, `status` (`classroom_assignment_row_status` enum, default `assigned`), `warnings[]`, `ruleTrace[]`.
- **Errors**: `401`; `400` when `assertIsoDate` throws (message starts with `"Invalid date"`, mapped at `route.ts:25`); else `500`.

### POST `/api/class-assignments/run`

Source: `src/app/api/class-assignments/run/route.ts`. `export const maxDuration = 300` (`route.ts:10`).

- **Auth**: admin (`route.ts:18-21`).
- **Body** (Zod `runRequestSchema`, `route.ts:12-15`):

  ```
  { date: string, forceReassign?: boolean = false }
  ```

  Note `date` is typed only as `z.string()` here; the `YYYY-MM-DD` shape is enforced downstream by `assertIsoDate` inside `runClassroomAssignment`, surfaced as a `400` (`route.ts:58`).
- **Side effects**: `runClassroomAssignment(getDb(), { date, forceReassign, createdBy })` (`route.ts:39-43`) regenerates the room assignment and **persists a new run + rows**; `createdBy` is the session email. With `forceReassign:false` it carries forward prior manual overrides; with `true` it discards them. This is a **local computation only — it does not write to Wise.**
- **Response** `200`: the resulting `ClassroomAssignmentDetail` (same shape as GET above, but with populated `run`/`rows`).
- **Errors**:
  - `409` — `StaleClassroomAssignmentSnapshotError`: the active Wise snapshot is stale (older than `CLASSROOM_ASSIGNMENT_FRESHNESS_MS` = 15 min, `data.ts:134`). Body includes `error`, `code:"STALE_ASSIGNMENT_SNAPSHOT"`, `latestSyncFinishedAt`, `staleAgeMs` (`route.ts:46-56`; error class `data.ts:136-152`). The caller is told to run Wise sync first.
  - `400` — message starts with `"Invalid date"` (`route.ts:58`), or Zod parse failure with `details` (`route.ts:31-36`); `400 {"error":"Invalid JSON"}` on unparseable body (`route.ts:26-28`).
  - `401`; else `500`.

### PATCH `/api/class-assignments/runs/[runId]/rows/[rowId]`

Source: `src/app/api/class-assignments/runs/[runId]/rows/[rowId]/route.ts`.

- **Auth**: admin (`route.ts:15-18`).
- **Path params**: `runId`, `rowId`.
- **Body** (Zod `overrideRequestSchema`, `route.ts:7-9`): `{ overrideRoom?: string | null }` (trimmed, nullable, optional). The handler normalizes `overrideRoom?.trim() || null` (`route.ts:40`), so empty string and omission both clear the override.
- **Side effects**: `updateClassroomAssignmentOverride(getDb(), { runId, rowId, overrideRoom })` (`route.ts:37-41`) re-runs the assignment for the run with the single row's override changed, **rewriting the run's rows** (`data.ts:1116-1145`). Local only — no Wise writeback.
- **Response** `200`: the recomputed `ClassroomAssignmentDetail`.
- **Errors**: `401`; `400 {"error":"Invalid JSON"}` (`route.ts:23`) or Zod `400` with `details` (`route.ts:28-33`); `404` when the underlying lookup throws a `"… not found"` message — run not found (`data.ts:1125`) or row not found (`data.ts:1129`) (mapped at `route.ts:45`); else `500`.

---

## Publish to Wise (async job)

The publish flow is two endpoints: a POST that **creates a job and returns immediately (`202`)** while the work runs in the background, and a GET the client polls for progress.

### POST `/api/class-assignments/runs/[runId]/publish`

Source: `src/app/api/class-assignments/runs/[runId]/publish/route.ts`. `export const maxDuration = 300` (`route.ts:10`).

- **Auth**: admin (`route.ts:32-35`).
- **Path params**: `runId`.
- **Request body**: none read.
- **Side effects**:
  1. `createClassroomPublishJob(getDb(), { runId, createdBy })` inserts a `classroom_publish_jobs` row (status `pending`) and computes `totalCount`/`eligibleCount` (`route.ts:39-42`; `data.ts:1236-1263`).
  2. The actual publish is scheduled to run **after the response** via Next's `after(task)`, falling back to a fire-and-forget `void task()` if `after` throws (`route.ts:12-26, 44`). The background `runClassroomPublishJob` (`data.ts:1463+`) flips the job to `running`, fetches live Wise sessions, and **writes eligible `OFFLINE` session `location` values back to Wise** via `updateSessionLocation`. Failures are logged with `console.error` (`route.ts:17`); the response is already sent.
- **Response** `202`: `{ jobId: string, progress: PublishJobProgress }` (`route.ts:46`). `PublishJobProgress` (`data.ts:106-124`): `jobId`, `runId`, `status` (`classroom_publish_job_status` enum), `totalCount`, `eligibleCount`, `completedCount`, `successCount`, `failedCount`, `skippedCount`, `remainingCount`, `elapsedMs`, `estimatedRemainingMs`, `lastError`, `startedAt`, `finishedAt`, `createdAt`, `updatedAt`.
- **Errors**: `401`; `404` when the message ends with `"not found"` (e.g. `"Assignment run not found"`, `data.ts:1245`; mapped at `route.ts:49`); else `500`.

### GET `/api/class-assignments/runs/[runId]/publish/[jobId]`

Source: `src/app/api/class-assignments/runs/[runId]/publish/[jobId]/route.ts`.

- **Auth**: admin (`route.ts:10-13`).
- **Path params**: `runId`, `jobId`.
- **Side effects**: `getClassroomPublishJobProgress` may **fail a stale `running` job** (older than `PUBLISH_JOB_STALE_AFTER_MS` = 6 min, `data.ts:133`) before reporting (`data.ts:1744-1747`) — i.e. a poll can transition a hung job to `failed`.
- **Response** `200`: `PublishJobStatusResponse` (`data.ts:126-129, 1748-1754`):

  ```
  { progress: PublishJobProgress, detail?: ClassroomAssignmentDetail }
  ```

  `detail` is included **only when the job has reached a terminal status** (`isPublishJobTerminal`), giving the client the post-publish run state in the same response.
- **Errors**: `401`; `404` when the message ends with `"not found"` (`route.ts:21`); else `500`.

---

## Teacher schedule + schedule emails

### GET `/api/class-assignments/runs/[runId]/teacher-schedule`

Source: `src/app/api/class-assignments/runs/[runId]/teacher-schedule/route.ts`.

- **Auth**: admin (`route.ts:10-13`).
- **Path params**: `runId`.
- **Response** `200`: `TeacherSchedule` from `getTeacherScheduleForRun` (`data.ts:1880-1920`): `{ tutors: Array<{ tutorDisplayName, blocks: TeacherScheduleBlock[] }> }`, tutors sorted by name and blocks sorted by start time. Each `TeacherScheduleBlock` (`data.ts:80-90`): `rowId`, `date` (the run's `assignmentDate`), `startTime`/`endTime` (`HH:MM`), `room` (label; `"Remote / no room needed"` for remote rows), `studentName`, `subject`, `classType`, `sessionType`.
- **Errors**: `401`; `500` on any failure. This route maps **everything** to `500` (`route.ts:19-22`) — note the underlying `"Assignment run not found"` throw (`data.ts:1889`) is **not** specially mapped to `404` here, unlike the schedule-email routes.

### GET `/api/class-assignments/runs/[runId]/schedule-email/preview`

Source: `src/app/api/class-assignments/runs/[runId]/schedule-email/preview/route.ts`.

- **Auth**: admin (`route.ts:10-13`).
- **Path params**: `runId`.
- **Response** `200`: `ScheduleEmailPreview` from `getScheduleEmailPreview` (`route.ts:17`; type at `src/lib/classrooms/schedule-email.ts:74-86`): `ready`, `sendable`, `assignmentRunId`, `assignmentDate`, `subject`, `hardBlockers[]`, `blockers[]`, `readyCount`, `blockedCount`, `recipients[]`, and `previews[]` (each a `ScheduleEmailPreviewItem` with `recipient`, `subject`, `html`, `text`, `blocks`, `roomSteps`, `mapImageUrl` — `schedule-email.ts:56-64`). Blockers are typed (`no_rows` | `unfinalized_rows` | `missing_recipient_email` | `missing_email_config`, `schedule-email.ts:66-72`).
- **Errors**: `401`; `404` when the message is exactly `"Assignment run not found"` (`route.ts:21`); else `500`.

### POST `/api/class-assignments/runs/[runId]/schedule-email/send`

Source: `src/app/api/class-assignments/runs/[runId]/schedule-email/send/route.ts`.

- **Auth**: admin (`route.ts:63-66`).
- **Path params**: `runId`.
- **Body**: optional JSON parsed by a hand-rolled validator `parseSendOptions` (**not Zod**, `route.ts:14-57`). An empty/whitespace body is allowed and treated as `{}` (`route.ts:16`). Fields:
  - `recipientGroupIds?: string[]` — when present, must be an array of strings, else `400` (`route.ts:34-40`).
  - `senderKey?: "primary" | "backup"` — else `400` (`route.ts:42-47`).
  - `mode?: "selected" | "failed_only"` — else `400` (`route.ts:49-54`).
- **Side effects**: `sendScheduleEmailsForRun(getDb(), runId, session.user?.email ?? null, undefined, options)` (`route.ts:71-77`) sends per-tutor schedule emails and records email-run rows. `senderKey` selects primary vs backup sender; `mode:"failed_only"` retries only previously failed recipients.
- **Response**: `ScheduleEmailSendResult` (`schedule-email.ts:121-145`): `{ summary: { attempted, success, failed, blocked }, recipients[], preview, failover? }`. Status is **`200` when `summary.attempted > 0`, otherwise `409`** (nothing was attempted — e.g. all recipients blocked) (`route.ts:78-79`).
- **Errors**: `401`; `404` when message is `"Assignment run not found"` (`route.ts:82-83`); `400` for the five validator messages (`Invalid JSON body.` / `Request body must be an object.` / `recipientGroupIds must be an array of strings.` / `senderKey must be primary or backup.` / `mode must be selected or failed_only.`, `route.ts:84-89`); else `500`.

---

## Internal crons

Both are `GET` handlers gated by `rejectInvalidCronSecret` and wrapped in `withCronInvocationAudit`, which records the invocation under a `jobKey` in the data-health audit (`src/lib/data-health/cron-audit.ts`). Registered in `vercel.json`.

### GET `/api/internal/class-assignments/morning`

Source: `src/app/api/internal/class-assignments/morning/route.ts`. `export const maxDuration = 800` (`route.ts:6`). Cron schedule `45 23 * * *` (`vercel.json:32-33`); audit `jobKey: "classroom_morning"` (`route.ts:13`).

- **Auth**: cron secret (`route.ts:9-10`).
- **Request**: none (query/body ignored).
- **Side effects**: `runClassroomMorningAutomation()` (`src/lib/classrooms/morning-automation.ts:174+`) runs the full daily pipeline — ensure a fresh Wise sync (reuse / wait / trigger), generate assignments per date, auto-publish eligible rows **to Wise**, and send tutor schedule emails.
- **Response** `200`: `MorningAutomationResult` (`morning-automation.ts:52-64`): `ok`, `automationBatchId`, `startDate`, `endDate`, `sync: { mode: "reused"|"waited"|"triggered", syncRunId, finishedAt, snapshotId? }`, and `dates: MorningAutomationDateResult[]` — each with `date`, `runId`, `changedRows`, `targetPublishRows`, `publishSummary`, optional `scheduleEmail`/`scheduleEmailError`, `events`, and the run `detail` (`morning-automation.ts:37-50`).
- **Errors**: `401`/`500` from the cron gate; `500 {"ok": false, "error": message}` on a thrown automation error (`route.ts:18-21`).

### GET `/api/internal/class-assignments/admin-email`

Source: `src/app/api/internal/class-assignments/admin-email/route.ts`. `export const maxDuration = 300` (`route.ts:6`). Cron schedule `0,10,20,30 0 * * *` (`vercel.json:36-37`); audit `jobKey: "classroom_admin_email"` (`route.ts:13`).

- **Auth**: cron secret (`route.ts:9-10`).
- **Request**: none.
- **Side effects**: `sendAdminClassroomScheduleEmail()` (`src/lib/classrooms/admin-schedule-email.ts:340+`) emails the admin schedule summary to all `admin_users` recipients (idempotency-keyed per `assignmentDate`+email), recording recipient rows.
- **Response**: `AdminScheduleEmailResult` (`admin-schedule-email.ts:21-30`): `status` (`"sent"|"partial"|"failed"|"pending"|"skipped"`), `assignmentDate`, `assignmentRunId`, `emailRunId`, `attempted`, `success`, `failed`, `message`. HTTP status is **`500` when `result.status === "failed"`, otherwise `200`** (`route.ts:16-18`) — so `pending`/`skipped`/`partial`/`sent` all return `200`.
- **Errors**: `401`/`500` from the cron gate; `500 {"error": message}` on a thrown error (`route.ts:19-22`).

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
