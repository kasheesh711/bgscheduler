# Progress Tests API

Endpoint reference for the progress-test cycle dashboard and admin actions. Feature routes live under `src/app/api/progress-tests/**`; scheduled sync/digest routes live under `src/app/api/internal/sync-progress-tests` and `src/app/api/internal/progress-tests/admin-digest`.

This page documents request/response mechanics only. Progress-test business policy, cycle thresholds, and teacher-email meaning belong in the feature docs.

## Auth Model

Feature routes use `src/lib/progress-tests/api.ts`:

- `requireProgressTestsSession()` returns `401 {"error":"Unauthorized"}` when the session lacks an email/name and `403 {"error":"Forbidden"}` when `allowedPages` excludes `/progress-tests`.
- A session with `role: "teacher"` is allowed to read `GET /api/progress-tests`; its payload is scoped to the teacher's canonical keys.
- Mutating routes use `requireProgressTestsAdminSession()`, so teacher sessions get `403 {"error":"Forbidden"}` before writes.
- Other thrown errors are mapped to `500 {"error": <message>}` by `progressTestsErrorResponse()`.

## Dashboard Payload

### `GET /api/progress-tests`

- **Auth:** progress-tests session. Admins see all rows; teachers see only students resolved from their email via `resolveTeacherCanonicalKeys()`.
- **Request:** none.
- **Response 200:** progress-test dashboard payload from `getProgressTestsPayload({ teacherCanonicalKeys })`.
- **Errors:** `401`, `403`, `500`.

## Admin Actions

All routes below require an admin progress-tests session and return `403` for teacher sessions. They parse JSON explicitly: malformed JSON returns `400 {"error":"Invalid JSON body"}`, and Zod validation failures return `400 {"error": <flattened zod error>}`.

### `POST /api/progress-tests/book`

- **Body:** `{ enrollmentKey, testDate, location?, modality?, scheduleMethod? }`.
  - `enrollmentKey` is required.
  - `testDate` must be an ISO datetime string.
  - `modality`, when provided, is `online | offline`.
  - `scheduleMethod` defaults to `parent_pick` and may be `after_class | parent_pick`.
- **Behavior:** calls `bookTest({ enrollmentKey, testDate, location, scheduleMethod, actor })`.
- **Response 200:** booking result, including a refreshed `row` when present.
- **Response 404:** `{ "error": "Enrollment not found" }` when the service returns no row.
- **Errors:** `400`, `401`, `403`, `404`, `500`.

### `POST /api/progress-tests/mark-at-home-submitted`

- **Body:** `{ enrollmentKey }`.
- **Behavior:** calls `submitAtHome({ enrollmentKey, actor })`.
- **Response 200:** `{ row }`.
- **Response 404:** `{ "error": "Enrollment not found" }` when no row is returned.
- **Errors:** `400`, `401`, `403`, `404`, `500`.

### `POST /api/progress-tests/mark-complete`

- **Body:** `{ enrollmentKey }`.
- **Behavior:** calls `markComplete({ enrollmentKey, actor })`.
- **Response 200:** `{ row }`.
- **Response 404:** `{ "error": "Enrollment not found" }` when no row is returned.
- **Errors:** `400`, `401`, `403`, `404`, `500`.

### `POST /api/progress-tests/resend-email`

- **Body:** `{ enrollmentKey }`.
- **Behavior:** calls `resendTeacherEmail({ enrollmentKey, actor })`.
- **Response 200:** resend result, including the refreshed `row`.
- **Response 404:** `{ "error": "Enrollment not found" }` when no row is returned.
- **Errors:** `400`, `401`, `403`, `404`, `500`.

### `POST /api/progress-tests/select-at-home`

- **Body:** `{ enrollmentKey }`.
- **Behavior:** calls `selectAtHome({ enrollmentKey, actor })`.
- **Response 200:** `{ row }`.
- **Response 404:** `{ "error": "Enrollment not found" }` when no row is returned.
- **Errors:** `400`, `401`, `403`, `404`, `500`.

## Internal Sync

### `GET /api/internal/sync-progress-tests`

- **Auth:** `CRON_SECRET` bearer only.
- **Function config:** `maxDuration = 300`.
- **Request:** none.
- **Behavior:** audited as job key `progress_tests`; calls `runProgressTestSyncRequest({ triggerType: "cron" })`.

### `POST /api/internal/sync-progress-tests`

- **Auth:** `CRON_SECRET` bearer, or any authenticated Auth.js session when the bearer check is not valid.
- **Request:** none.
- **Behavior:** cron-secret calls run with `triggerType: "cron"`; session fallback calls run with `triggerType: "admin"` and the session email.

### Internal Sync Responses

The route returns the `runProgressTestSyncRequest()` response directly when auth succeeds.

| Status | When | Body |
|---|---|---|
| route-specific | Auth succeeded | Whatever `runProgressTestSyncRequest()` returns |
| `401` | Invalid/missing bearer on `GET`, or no valid bearer/session on `POST` | `{ "error": "Unauthorized" }` |
| `500` | Missing `CRON_SECRET` where required | `{ "error": "Server misconfigured" }` |

## Admin Digest

### `GET /api/internal/progress-tests/admin-digest`

- **Auth:** `CRON_SECRET` bearer only.
- **Function config:** `maxDuration = 300`.
- **Request:** none.
- **Behavior:** audited as job key `progress_tests_digest`; calls `sendProgressTestAdminDigest()`.
- **Response 200:** digest result when `result.status !== "failed"`.
- **Response 500:** digest result when `result.status === "failed"`, missing `CRON_SECRET`, or a thrown error.
- **Response 401:** invalid bearer.

_Verified against HEAD on 2026-06-22._
