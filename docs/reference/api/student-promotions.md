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

Creates a fresh dry-run audit from live Wise accepted students, Wise registration data, and the active Credit Control website snapshot.

- **Auth:** admin session.
- **Function config:** `maxDuration = 800`.
- **Request:** none.
- **Response:** `201 { "detail": StudentPromotionRunDetail }`.
- **Side effects:** inserts one `student_promotion_runs` row plus grade/course action rows.
- **Errors:** `401`, `400` for expected service errors, `500` for unexpected failures.

## `GET /api/student-promotions/runs/[runId]`

Loads one promotion run with all grade and course actions.

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
- **Validation:** `endpointVerificationConfirmed` must be `true`; `endpointVerificationNote` must be non-blank in the service.
- **Response:** `{ "detail": StudentPromotionRunDetail }` with run status `verified`.
- **Side effects:** updates the run's verification fields (`verifiedAt`, `verifiedByEmail`, `endpointVerificationNote`, status).
- **Errors:** `400`, `401`, `500`.

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
- **Response:** `{ "detail": StudentPromotionRunDetail }` with run status `applied` or `applied_with_errors`.
- **Side effects:** per pending action, revalidates Wise state, writes grade registration or class subject, and persists response/error payloads.
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
  "summary": {
    "totalAcceptedWiseStudents": 1054,
    "totalWebsiteSnapshotStudents": 1054,
    "pendingGradeActions": 0,
    "pendingCourseActions": 0,
    "skippedGradeActions": 0,
    "skippedCourseActions": 0
  }
}
```

Each action row includes its Wise identifiers, current/target values, status, skip/error details, raw Wise response payloads where available, and timestamps. Exact persisted columns are in [erd-student-promotions.md](../database/erd-student-promotions.md).

