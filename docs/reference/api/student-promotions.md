# Student Promotions API

Admin and cron endpoints for the July 1, 2026 Wise Student Promotions workflow. Feature meaning and business rules live in [docs/features/student-promotions.md](../../features/student-promotions.md). This page owns only the mechanical HTTP contracts.

## Shared Conventions

All `/api/student-promotions/*` routes require an Auth.js admin session via `requireStudentPromotionSession()`. Unauthenticated calls return `401 { "error": "Unauthorized" }`.

All route errors are normalized by `studentPromotionErrorResponse()`: normal validation/business errors return `400`, auth errors return `401`, and unexpected failures return `500`.

The cron route lives under `/api/internal/student-promotions/july-1`, bypasses session middleware like other internal routes, and authenticates only with `Authorization: Bearer $CRON_SECRET`.

## `GET /api/student-promotions/runs`

Loads the latest persisted promotion run detail for the fixed target date `2026-07-01`.

- **Auth:** admin session.
- **Request:** none.
- **Response:** `{ "detail": StudentPromotionRunDetail | null }`.
- **Errors:** `401`, `500`.

## `POST /api/student-promotions/runs`

Creates a fresh dry-run audit from live Wise accepted students, Wise registration data, live FUTURE sessions, live teacher tags, the active payroll rate card, and the active Credit Control website snapshot.

- **Auth:** admin session.
- **Function config:** `maxDuration = 800`.
- **Request:** none.
- **Response:** `201 { "detail": StudentPromotionRunDetail }`.
- **Side effects:** inserts one `student_promotion_runs` row plus grade, course, future-session, Year 13 graduation-review, and pay-rate impact rows.
- **Errors:** `401`, `400` for expected service errors, `500` for unexpected failures.

## `GET /api/student-promotions/runs/[runId]`

Loads one promotion run with all grade, course, future-session, graduation, and pay-rate impact actions.

- **Auth:** admin session.
- **Request:** path param `runId`.
- **Response:** `{ "detail": StudentPromotionRunDetail }`.
- **Errors:** `401`, `400` if the run does not exist, `500`.

## `POST /api/student-promotions/runs/[runId]/verify`

Locks a draft dry run for July 1 apply.

- **Auth:** admin session.
- **Request body:**
  ```json
  {
    "endpointVerificationConfirmed": true,
    "endpointVerificationNote": "Verified with approved no-op record ..."
  }
  ```
- **Validation:** `endpointVerificationConfirmed` must be `true`; `endpointVerificationNote` must be non-blank in the service. The service also blocks verification when any Year 13 graduate lacks a disposition or any pay-rate impact row is pending, blocked, or marked incorrect.
- **Response:** `{ "detail": StudentPromotionRunDetail }` with run status `verified`.
- **Side effects:** updates the run's verification fields (`verifiedAt`, `verifiedByEmail`, `endpointVerificationNote`, status).
- **Errors:** `400`, `401`, `500`.

## `PATCH /api/student-promotions/runs/[runId]/graduation-actions/[actionId]`

Sets the required admin disposition for one Year 13 student.

- **Auth:** admin session.
- **Function config:** `maxDuration = 800`.
- **Request body:**
  ```json
  {
    "disposition": "inactive"
  }
  ```
  `disposition` must be `inactive` or `university`.
- **Response:** `{ "detail": StudentPromotionRunDetail }`.
- **Behavior:** updates the graduation action review fields, refreshes Year 13 University course-action eligibility, refreshes July 1+ future-session actions, and recalculates pay-rate impact rows from live Wise FUTURE sessions, live teacher tags, and the active payroll rate card.
- **Errors:** `400`, `401`, `404`, `500`.

## `PATCH /api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review`

Marks one pay-rate impact row as reviewed.

- **Auth:** admin session.
- **Request body:**
  ```json
  {
    "status": "verified_correct",
    "note": "optional reviewer note"
  }
  ```
  `status` must be `verified_correct` or `incorrect`.
- **Validation:** blocked rows cannot be marked `verified_correct`; fix tier/rate-card/mapping data and rerun the audit first.
- **Response:** `{ "detail": StudentPromotionRunDetail }`.
- **Side effects:** updates the pay-rate row review fields only.
- **Errors:** `400`, `401`, `404`, `500`.

## `POST /api/student-promotions/runs/[runId]/apply`

Manual admin fallback for applying a verified run. This is intentionally separate from the cron route.

- **Auth:** admin session.
- **Function config:** `maxDuration = 800`.
- **Request body:**
  ```json
  {
    "confirm": "apply-student-promotions"
  }
  ```
- **Validation:** exact confirmation string is required.
- **Apply window:** the service refuses apply before `2026-07-01 00:05 Asia/Bangkok`.
- **Coverage guard:** before writes, the service re-fetches live accepted Wise students and aborts if any are missing from the verified run.
- **Response:** `{ "detail": StudentPromotionRunDetail }` with run status `applied` or `applied_with_errors`.
- **Side effects:** per pending action, revalidates Wise state, writes grade registration or class subject, writes local Credit Control inactive rows for graduates marked `inactive`, and persists response/error payloads. No Wise student deactivation endpoint is called.
- **Future sessions:** refreshes audited July 1+ future-session actions from live Wise after grade/class apply, but does not write session subjects.
- **Errors:** `400`, `401`, `500`.

## `POST /api/student-promotions/runs/[runId]/future-sessions/apply`

Separate gated admin action for writing pending July 1+ future Wise session subjects.

- **Auth:** admin session.
- **Function config:** `maxDuration = 800`.
- **Request body:**
  ```json
  {
    "confirm": "apply-future-session-subjects"
  }
  ```
- **Validation:** exact confirmation string is required. The service also refuses writes unless `WISE_SESSION_SUBJECT_UPDATE_VERIFIED=true`.
- **Run guard:** the grade/class promotion run must already be `applied` or `applied_with_errors`.
- **Response:** `{ "detail": StudentPromotionRunDetail }`.
- **Behavior:** re-fetches live Wise FUTURE sessions, refreshes pending/applied/skipped future-session action rows, then writes only `pending` eligible rows through the single-session subject endpoint.
- **Errors:** `400`, `401`, `500`.

## `POST /api/student-promotions/runs/[runId]/readback`

Runs a read-only live Wise readback for a promotion run, intended after July 1 apply.

- **Auth:** admin session.
- **Function config:** `maxDuration = 800`.
- **Request:** none.
- **Response:** `{ "readback": StudentPromotionReadbackResult }`.
- **Behavior:** fetches live accepted Wise students, student registration fields, course state, and live FUTURE sessions; reports promoted exact/equivalent rows plus missing, wrong-grade, skipped-review, subject-drift, roster-drift, future-session subject/payroll-course exceptions, and fetch/write failures.
- **Side effects:** none in Wise. Refreshes persisted future-session action rows from live FUTURE sessions so new/stale sessions are visible before any session-subject apply.
- **Errors:** `400`, `401`, `500`.

## `GET /api/internal/student-promotions/july-1`

Vercel Cron entry point for the scheduled July 1 apply.

- **Auth:** `Authorization: Bearer $CRON_SECRET`.
- **Function config:** `maxDuration = 800`.
- **Schedule:** `5 17 30 6 *` UTC, which is `2026-07-01 00:05 Asia/Bangkok` for the target run.
- **One-shot guard:** the route returns `409` unless the current Bangkok date is exactly `2026-07-01`.
- **Request:** none.
- **Response:** `{ "detail": StudentPromotionRunDetail }`.
- **Behavior:** applies the newest verified `2026-07-01` run. If the run is already terminal, returns the stored terminal detail.
- **Errors:**
  - `401 { "error": "Unauthorized" }` for a bad/missing bearer secret.
  - `409 { "error": "Student promotion cron is only allowed on July 1, 2026 Bangkok time" }` outside the target date.
  - `500 { "error": "Server misconfigured" }` if `CRON_SECRET` is unset.
  - `400`/`500` from the apply service for verification/apply failures.

## `POST /api/internal/student-promotions/july-1`

Alias of the cron `GET` handler for operator replay with the cron secret. It has the same auth, one-shot date guard, side effects, and response shape.

## Response Shape

`StudentPromotionRunDetail` is:

```jsonc
{
  "run": {
    "id": "<uuid>",
    "targetDate": "2026-07-01",
    "status": "draft|verified|applying|applied|applied_with_errors|failed",
    "createdByEmail": "admin@example.com",
    "verifiedAt": "<ISO|null>",
    "applyStartedAt": "<ISO|null>",
    "applyFinishedAt": "<ISO|null>"
  },
  "gradeActions": [],
  "courseActions": [],
  "futureSessionActions": [],
  "graduationActions": [],
  "payRateImpacts": [],
  "summary": {
    "totalAcceptedWiseStudents": 1054,
    "totalWebsiteSnapshotStudents": 1054,
    "pendingGradeActions": 0,
    "pendingCourseActions": 0,
    "pendingFutureSessionActions": 0,
    "pendingGraduationActions": 0,
    "pendingPayRateImpacts": 0,
    "blockedPayRateImpacts": 0,
    "incorrectPayRateImpacts": 0,
    "skippedGradeActions": 0,
    "skippedCourseActions": 0,
    "skippedFutureSessionActions": 0
  }
}
```

Each action row includes its Wise identifiers, current/target values, status, skip/error details, raw Wise response payloads where available, and timestamps. Exact persisted columns are in [erd-student-promotions.md](../database/erd-student-promotions.md).
