# Progress Tests API

Public and cron endpoints for the every-8-classes Progress Tests tracker. Feature meaning,
the cycle state machine, the booking lifecycle, and the access model live in
[docs/features/progress-tests.md](../../features/progress-tests.md). This page owns only the
mechanical HTTP contracts. Table columns are in the Core ERD's
[Progress Tests section](../database/erd-core.md#progress-tests); the enums are in
[enums.md](../database/enums.md#progressteststatusenum--progress_test_status).

## Shared Conventions

All `/api/progress-tests/*` routes are session-gated:

- `GET /api/progress-tests` uses `requireProgressTestsSession()` — any signed-in user with
  page access (admin **or** teacher).
- All five mutation routes use `requireProgressTestsAdminSession()` — **admin only**; a
  teacher session throws `Forbidden` → `403` before any write.

Errors are normalized by `progressTestsErrorResponse()` (`src/lib/progress-tests/api.ts:65-88`):
`"Unauthorized"` → `401 { "error": "Unauthorized" }`, `"Forbidden"` → `403 { "error": "Forbidden" }`,
and everything else → `500 { "error": <message | fallback> }`. Next's hanging-promise
rejection is re-thrown, not swallowed.

The five mutation routes share one skeleton: `requireProgressTestsAdminSession()` →
`request.json()` (try/catch → `400 { "error": "Invalid JSON body" }`) → `safeParse()`
(→ `400 { "error": <flattened> }`) → service call → `404 { "error": "Enrollment not found" }`
when the enrollment is unknown → `200`. Every mutating service call revalidates the
`progress-tests` cache tag.

The two internal cron routes live under `/api/internal/*`, bypass session middleware like
other internal routes, and authenticate with `Authorization: Bearer $CRON_SECRET` via the
shared `src/lib/internal/cron-auth.ts` helpers (constant-time compare). They are also
documented in [internal-crons.md](./internal-crons.md) and [crons.md](../crons.md).

## `GET /api/progress-tests`

Loads the dashboard payload. Source: `src/app/api/progress-tests/route.ts`.

- **Auth:** `requireProgressTestsSession()` — admin **or** teacher (`401`/`403` via mapper).
- **Request:** none.
- **Scoping:** a `teacher` session is restricted to its own students — the handler resolves
  the teacher's canonical-key set fresh (`resolveTeacherCanonicalKeys`, covers split
  online/onsite identities) and filters rows to those tutors (empty set → zero rows,
  fail-closed); an `admin` (null) sees every enrollment plus parent-outreach enrichment.
- **Response (200):** `ProgressTestsPayload` — see [Response Shapes](#response-shapes).
- **Errors:** `401`, `403`, `500 { "error": "Progress tests load failed" }`.

## `POST /api/progress-tests/book`

Books a progress test for an enrollment (admin-confirmed). Source:
`src/app/api/progress-tests/book/route.ts`.

- **Auth:** admin only.
- **Request body** — Zod `BookProgressTestSchema`:
  | Field | Type | Notes |
  |---|---|---|
  | `enrollmentKey` | string (min 1) | required |
  | `testDate` | ISO datetime (`z.string().datetime()`) | required; parsed to `Date` |
  | `location` | string | optional → `null` |
  | `modality` | `"online" \| "offline"` | optional; **parsed but not forwarded** to the service in this handler |
  | `scheduleMethod` | `"after_class" \| "parent_pick"` | defaults to `"parent_pick"` |
- **Behavior:** `bookTest(...)` derives the session end from `testDate` +
  `PROGRESS_TEST_DEFAULT_DURATION_MINUTES` (60) and delegates the **audited, fail-closed,
  flag-gated** Wise write (`confirmProgressTestBooking`): records the intent, resolves the
  Wise class + most-frequent tutor, runs an availability pre-check that aborts on conflict,
  and only performs the real Wise create when `WISE_SESSION_CREATE_VERIFIED` is on (else
  `manual_required`). Then reloads the dashboard row. Unknown enrollment → `404`.
- **Response (200):** `BookProgressTestServiceResult = { status, wiseSessionId: string | null, bookingMode: "wise" | "manual" | null, message, row: ProgressTestRow | null }`.
- **Side effects:** writes `progress_test_bookings` + `progress_test_cycle_state`; may flag a
  ledger row; may perform a flag-gated Wise session create; revalidates the cache tag.
- **Errors:** `400`, `401`, `403`, `404`, `500 { "error": "Progress test booking failed" }`.

## `POST /api/progress-tests/mark-complete`

Manually rolls an enrollment's current cycle to complete. Source:
`src/app/api/progress-tests/mark-complete/route.ts`.

- **Auth:** admin only.
- **Request body** — Zod `MarkCompleteSchema`: `{ enrollmentKey: string (min 1) }`.
- **Behavior:** `markComplete(...)` bumps `cycleIndex`, resets `currentCount` to 0, sets
  status back to `accumulating`, and clears the booked/notify fields. Unknown enrollment →
  `404`.
- **Response (200):** `{ row: ProgressTestRow }`.
- **Side effects:** upserts `progress_test_cycle_state`; revalidates the cache tag.
- **Errors:** `400`, `401`, `403`, `404`, `500 { "error": "Mark complete failed" }`.

## `POST /api/progress-tests/select-at-home`

Logs that the enrollment's test will be taken at home (no Wise booking). Source:
`src/app/api/progress-tests/select-at-home/route.ts`.

- **Auth:** admin only.
- **Request body** — Zod `SelectAtHomeSchema`: `{ enrollmentKey: string (min 1) }`.
- **Behavior:** `selectAtHome(...)` records an audit booking row and sets cycle state to
  `scheduled` with `scheduleMethod = "at_home"` and `atHomeSelectedAt = now` (the student is
  no longer "due" while outstanding). Unknown enrollment → `404`.
- **Response (200):** `{ row: ProgressTestRow }`.
- **Side effects:** inserts a `progress_test_bookings` row + upserts cycle state; revalidates
  the cache tag.
- **Errors:** `400`, `401`, `403`, `404`, `500 { "error": "Select at-home failed" }`.

## `POST /api/progress-tests/mark-at-home-submitted`

Marks a previously-selected at-home test as submitted, then rolls the cycle. Source:
`src/app/api/progress-tests/mark-at-home-submitted/route.ts`.

- **Auth:** admin only.
- **Request body** — Zod `MarkAtHomeSubmittedSchema`: `{ enrollmentKey: string (min 1) }`.
- **Behavior:** `submitAtHome(...)` records an audit row and rolls the cycle exactly like
  mark-complete (the at-home submission counts as the test done). Unknown enrollment → `404`.
- **Response (200):** `{ row: ProgressTestRow }`.
- **Side effects:** inserts a `progress_test_bookings` row + upserts cycle state; revalidates
  the cache tag.
- **Errors:** `400`, `401`, `403`, `404`, `500 { "error": "Mark at-home submitted failed" }`.

## `POST /api/progress-tests/resend-email`

Resends the teacher heads-up email for an enrollment (one-off, idempotent per cycle).
Source: `src/app/api/progress-tests/resend-email/route.ts`.

- **Auth:** admin only.
- **Request body** — Zod `ResendEmailSchema`: `{ enrollmentKey: string (min 1) }`.
- **Behavior:** `resendTeacherEmail(...)` rebuilds a single heads-up from stored cycle fields
  (reusing the persisted AI summary) and sends it via `runTeacherHeadsUpNotifications`, which
  is idempotent per cycle (`progress-test:teacher:{enrollmentKey}:{cycleIndex}`) and stamps
  `teacherNotifiedAt`/`teacherNotifiedForCycle` on success. Unknown enrollment → `404`.
- **Response (200):** `ResendTeacherEmailServiceResult = { outcome: <per-enrollment send outcome> | null, row: ProgressTestRow | null }`.
- **Side effects:** may send a teacher heads-up email; upserts `progress_test_email_runs` +
  `progress_test_notifications`; may stamp cycle state.
- **Errors:** `400`, `401`, `403`, `404`, `500 { "error": "Resend teacher email failed" }`.

## `GET, POST /api/internal/sync-progress-tests`

Vercel Cron entry point for the nightly every-8-classes tracker. Source:
`src/app/api/internal/sync-progress-tests/route.ts`. `maxDuration = 300`.

- **Auth:**
  - `GET` — `CRON_SECRET` bearer only (`allowSessionAuth: false`). The cron entry point.
  - `POST` — `CRON_SECRET` bearer **or** a logged-in Auth.js session fallback
    (`allowSessionAuth: true`). The session path records `triggerType: "admin"` + `actorEmail`
    on the run row and sets the audit `triggerSource` to `admin`. The manual/replay variant.
- **Schedule:** `25,55 * * * *` (`vercel.json`).
- **Request:** none (no query params; bodies ignored).
- **Behavior:** delegates to `runProgressTestSyncRequest({ triggerType, actorEmail? })`,
  wrapped in `withCronInvocationAudit` (audit `jobKey: "progress_tests"`). A **single-flight
  guard** over `progress_test_sync_runs` fails rows `running` for > 20 minutes
  (`STALE_RUNNING_PROGRESS_TEST_SYNC_MS`), skips if one remains, else inserts a new `running`
  row; on a run it folds the attendance ledger, recomputes cycle state, and (fail-isolated)
  sends teacher heads-up notifications. Calls `revalidateTag("progress-tests", { expire: 0 })`.
- **Response:**
  - `200` `ProgressTestSyncResult` augmented with `syncRunId` + `staleRunningSyncsFailed` on
    success; `500` (same body) on failure (`result.success ? 200 : 500`).
  - `202 SkippedProgressTestSyncResult` when a run is already in flight (note: the skip
    payload does **not** include `notificationCount`).
- **Errors:** `401 { "error": "Unauthorized" }` (bad/missing secret, no session fallback),
  `500 { "error": "Server misconfigured" }` (`CRON_SECRET` unset).

## `GET /api/internal/progress-tests/admin-digest`

Vercel Cron entry point for the once-daily admin digest. Source:
`src/app/api/internal/progress-tests/admin-digest/route.ts`. `maxDuration = 300`.

- **Auth:** `CRON_SECRET` bearer only, via `rejectInvalidCronSecret(request)`. **GET only —
  there is no `POST` handler.**
- **Schedule:** `35 0 * * *` UTC = **07:35 Asia/Bangkok** (`vercel.json`).
- **Request:** none.
- **Behavior:** calls `sendProgressTestAdminDigest()`, wrapped in `withCronInvocationAudit`
  (audit `jobKey: "progress_tests_digest"`). Lists students newly approaching, students due
  with no booked test, and unresolvable teacher heads-up recipients, then emails every
  `admin_users` recipient. **Once-per-day idempotent** on
  `progress_test_admin_digest_runs.digest_date` (Bangkok, UNIQUE): a terminal run row for the
  date short-circuits a re-invocation; the per-date insert is the single-flight guard
  (a concurrent loser gets `23505` → `skipped`). Nothing to report → terminal `skipped` row,
  no email sent.
- **Response:** the `ProgressTestAdminDigestResult` body directly, status chosen as
  `result.status === "failed" ? 500 : 200`.
- **Errors:** `401`/`500` from `rejectInvalidCronSecret` (bad secret / unset `CRON_SECRET`);
  `500 { "error": <message> }` on an unexpected throw.

## Response Shapes

Defined in `src/lib/progress-tests/types.ts` and `service.ts`.

`ProgressTestsPayload`:

```jsonc
{
  "rows": [/* ProgressTestRow */],
  "summary": {
    "accumulating": 0,
    "approaching": 0,
    "due": 0,
    "scheduled": 0,
    "completed": 0,
    "total": 0
  },
  "subjects": ["IGCSE Maths", "..."],   // distinct, sorted
  "lastSyncedAt": "<ISO|null>",          // newest sync run finish/start
  "generatedAt": "<ISO>"
}
```

`ProgressTestRow` (one student's progress within their current block for a subject):

```jsonc
{
  "enrollmentKey": "<wiseClassId>|<wiseStudentId>",
  "wiseStudentId": "...", "wiseClassId": "...",
  "studentKey": "<student>::<parent>", "studentName": "...", "parentName": "...",
  "subject": "...",
  "currentCount": 6,            // position WITHIN the current block of 8 (0..8)
  "threshold": 8,
  "cycleIndex": 10,             // blocks already accounted for
  "status": "accumulating|approaching|due|scheduled|completed",
  "mostFrequentTutorCanonicalKey": "<key|null>",
  "mostFrequentTutorDisplayName": "<name|null>",
  "teacherNotifiedAt": "<ISO|null>", "teacherNotifiedForCycle": 10,
  "bookedTestWiseSessionId": "<id|null>", "bookedTestDate": "<ISO|null>",
  "bookedTestBookingMode": "wise|manual|null",
  "scheduleMethod": "after_class|parent_pick|at_home|null",
  "bookedTestLocation": "<room|null>",
  "atHomeSelectedAt": "<ISO|null>", "atHomeSubmittedAt": "<ISO|null>",
  "lastClassDate": "<ISO|null>",
  "lastAiSummary": { "headline": "...", "strengths": [], "focusAreas": [], "recommendation": "..." },
  "lastAiSummaryAt": "<ISO|null>",
  "updatedByEmail": "<email|null>", "updatedAt": "<ISO|null>",

  // Parent outreach — populated only for ADMIN reads on approaching/due rows
  // that have a verified parent LINE link; null/[] otherwise (and for teachers).
  "parentLineContact": { "displayName": "...", "lineUserId": "...", "chatUrl": "<https chat.line.biz|null>" },
  "recommendedSlots": [
    { "start": "<ISO>", "end": "<ISO>", "room": "Tesla", "kind": "after_class|gap", "label": "Sat 14 Jun, 16:00–17:00 · Tesla" }
  ],
  "parentMessage": "<bilingual TH/EN message|null>"
}
```

`ProgressTestSyncResult` (sync route, augmented at the route with `syncRunId` +
`staleRunningSyncsFailed`):

```jsonc
{
  "success": true,
  "ledgerRowCount": 0, "enrollmentCount": 0,
  "approachingCount": 0, "dueCount": 0,
  "unresolvedTeacherCount": 0, "notificationCount": 0,
  "errorSummary": "..."          // present on failure only
}
```

`ProgressTestAdminDigestResult` (digest route):

```jsonc
{
  "status": "sent|partial|failed|skipped",
  "digestDate": "YYYY-MM-DD",     // Asia/Bangkok
  "digestRunId": "<uuid|null>",
  "approachingCount": 0, "dueCount": 0, "unresolvedCount": 0,
  "attempted": 0, "success": 0, "failed": 0,
  "message": "..."
}
```

Exact persisted columns for the eight `progress_test_*` tables are in the Core ERD's
[Progress Tests section](../database/erd-core.md#progress-tests).
