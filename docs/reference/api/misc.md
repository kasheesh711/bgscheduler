# Search, Tutors, Filters, Compare, Data Health, Auth & Admin API

HTTP reference for the search/compare workspace, tutor metadata, filter dropdowns, the data-health dashboard + job runner, the progress-tests tracker, the student-promotions audit/apply pipeline, leave-request review, tutor business profiles, and the admin Wise-sync trigger. Thirty endpoints across these path families:

- **Search** — `POST /api/search`, `POST /api/search/range`, `POST /api/search/assistant`
- **Compare** — `POST /api/compare`, `POST /api/compare/discover`
- **Tutors** — `GET /api/tutors`
- **Filters** — `GET /api/filters`
- **Tutor Profiles** — `GET /api/tutor-profiles`, `PATCH /api/tutor-profiles/[canonicalKey]`, `POST /api/tutor-profiles/import-preview`, `POST /api/tutor-profiles/import-commit`
- **Progress Tests** — `GET /api/progress-tests`, `POST /api/progress-tests/book`, `POST /api/progress-tests/mark-complete`, `POST /api/progress-tests/select-at-home`, `POST /api/progress-tests/mark-at-home-submitted`, `POST /api/progress-tests/resend-email`
- **Student Promotions** — `GET /api/student-promotions/runs`, `POST /api/student-promotions/runs`, `GET /api/student-promotions/runs/[runId]`, `POST /api/student-promotions/runs/[runId]/verify`, `POST /api/student-promotions/runs/[runId]/apply`
- **Leave Requests** — `GET /api/leave-requests`, `POST /api/leave-requests/sync`, `GET /api/leave-requests/[requestId]`, `PATCH /api/leave-requests/[requestId]`, `POST /api/leave-requests/[requestId]/wise-cancel-preview`
- **Data Health** — `GET /api/data-health`, `POST /api/data-health/jobs/[jobKey]/run`
- **Admin** — `POST /api/admin/sync-wise`

For *what* these features mean (search/compare workflow, fail-closed availability rules, the every-8-classes progress-test cycle, the student-promotion July-1 gate, leave-request lifecycle, profile-import matching), see the relevant `docs/features/*` pages. This page documents mechanical request/response detail only.

## Conventions shared across these endpoints

**Authentication.** Every handler in this group resolves the Auth.js session before doing any work. Three patterns appear:

- **Session-only** (most routes): call `auth()` from `@/lib/auth`; return `401 { "error": "Unauthorized" }` when `!session` (e.g. `src/app/api/search/route.ts:31-34`, `src/app/api/compare/route.ts:113-116`).
- **Session + email** (leave-requests, data-health job runner): check `!session?.user?.email` instead of just `!session` (`src/app/api/leave-requests/route.ts:9`, `src/app/api/data-health/jobs/[jobKey]/run/route.ts:12`).
- **Domain guard with role split** (progress-tests, student-promotions): a shared helper resolves the session and throws a sentinel `Error` that a shared error-mapper turns into `401`/`403`. Progress-tests reads use `requireProgressTestsSession`; every progress-tests mutation uses `requireProgressTestsAdminSession`, which throws `"Forbidden"` → `403` for teacher sessions (`src/lib/progress-tests/api.ts:32-63`). Student-promotions uses `requireStudentPromotionSession` (`src/lib/student-promotions/api.ts:9-15`).

All of these paths are **admin/authenticated** tier (no `CRON_SECRET` bearer); none are in the middleware public-route allowlist except `/api/search/assistant`, so the global Auth.js edge middleware also redirects unauthenticated browser navigations and applies page-level `allowedPages` access control before the handler runs (`src/middleware.ts:25-29, 52-58`). `/api/search/assistant` is allowlisted as public in the middleware yet still enforces a session in-handler (`src/app/api/search/assistant/route.ts:136-139`). The admin allowlist itself is enforced at sign-in (the `signIn` callback rejects non-admin/non-teacher Google accounts); these handlers therefore trust any present session as an allowed user. There is no separate "is this user an admin" check inside the search/compare/tutor/filter/leave/profile handlers beyond the presence of a session — the role distinction only exists in the progress-tests and student-promotions domains.

**Validation.** Most write/query bodies are validated with a module-scope Zod `const` + `.safeParse()`; on failure the handler returns `400` with the flattened error. Two shapes of failure body coexist:
- `{ "error": "Invalid request", "details": <flattened zod error> }` (search, compare, tutor-profiles import-commit).
- `{ "error": <flattened zod error> }` (progress-tests routes — they put the flattened error directly under `error`, `src/app/api/progress-tests/book/route.ts:28`).

Routes that parse a JSON body first wrap `request.json()` in `try/catch` and return `400 { "error": "Invalid JSON" }` (search/compare) or `400 { "error": "Invalid JSON body" }` (progress-tests) on a parse failure. The leave-request and student-promotions write handlers are the exception: a JSON parse failure is swallowed and treated as an empty body (`{}`), not a `400` (`src/app/api/leave-requests/sync/route.ts:14-19`, `src/app/api/student-promotions/runs/[runId]/verify/route.ts:17`).

**Error handling.** Business logic runs in a `try/catch`; uncaught errors generally return `500 { "error": <err.message or a fallback> }` via the pattern `err instanceof Error ? err.message : "<fallback>"`. Exceptions, documented per-route below: `wise-cancel-preview` returns `400` on any thrown error; `search/assistant` returns `502`/`503`; `leave-requests/sync` returns `409` on a concurrent-run error; the data-health job runner returns `409` for an unconfirmed dangerous job; the progress-tests and student-promotions error-mappers translate sentinel messages into `401`/`403`/`404`/`400` before the `500` fallback.

**Snapshot metadata.** Search/compare responses embed `snapshotMeta: { snapshotId, syncedAt, stale }` (`src/lib/search/types.ts`). `stale` is `true` when `Date.now() - syncedAt > API_STALE_THRESHOLD_MS`; when stale, a `STALE_SEARCH_WARNING` string is pushed into the response `warnings[]` (`src/app/api/compare/route.ts:144-149`).

---

## Search

Tutor-availability search against the warm in-memory index (`ensureIndex(db)`). The recommended endpoint is `POST /api/search/range`; `POST /api/search` is the legacy slot-based form; `POST /api/search/assistant` is the natural-language AI assistant.

### `POST /api/search/range`

Range search: an admin enters a time window + class duration, the backend slices it into fixed sub-slots and returns an availability grid. Source: `src/app/api/search/range/route.ts`.

- **Auth:** `auth()` → `401 { "error": "Unauthorized" }` when no session (`route.ts:7-10`).
- **Request body** — Zod `rangeRequestSchema` (`src/lib/search/range-search.ts:16-37`):
  | Field | Type | Notes |
  |---|---|---|
  | `searchMode` | `"recurring" \| "one_time"` | required |
  | `dayOfWeek` | number 0–6 | optional (used for `recurring`) |
  | `date` | string | optional (used for `one_time`) |
  | `startTime` | `"HH:MM"` (regex `^\d{2}:\d{2}$`) | required |
  | `endTime` | `"HH:MM"` | required |
  | `durationMinutes` | `60 \| 90 \| 120` (string `"60"/"90"/"120"` coerced, or numeric literal) | required |
  | `mode` | `"online" \| "onsite" \| "either"` | required |
  | `filters` | `{ subject?, curriculum?, level? }` | optional |
  | `tutorGroupIds` | `string[]` | optional — scope to specific tutors |
- **Behavior:** after parsing, the handler calls `generateSubSlots(startTime, endTime, durationMinutes)`; if zero sub-slots fit the window it returns `400 { "error": "Time range is too short for the selected class duration" }` (`route.ts:30-36`). Otherwise it delegates to `executeRangeSearch(db, …)`.
- **Response:** the `RangeSearchResponse` from `executeRangeSearch` (`src/lib/search/range-search.ts`) — an availability grid of per-sub-slot rows with `Available` / blocked / `Needs review` results plus `snapshotMeta`. Fail-closed: unresolved identity/modality/qualification routes to "Needs review", never "Available".
- **Errors:** `400` (bad JSON / Zod / empty sub-slot set), `401`, `500` (`route.ts:52-55`).

### `POST /api/search`

Legacy slot-based search (multi-slot intersection). Source: `src/app/api/search/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:31-34`).
- **Request body** — Zod `searchRequestSchema` (`route.ts:8-28`):
  | Field | Type | Notes |
  |---|---|---|
  | `searchMode` | `"recurring" \| "one_time"` | required |
  | `slots` | array (min 1) of `{ id, dayOfWeek?, date?, start, end, mode }` | `start`/`end` are `"HH:MM"`; `mode` ∈ `online/onsite/either` |
  | `filters` | `{ subject?, curriculum?, level? }` | optional |
  | `rawInput` | string | optional (echo of the source text) |
- **Behavior:** `ensureIndex(db)` then `executeSearch(index, parsed.data)` (`route.ts:53-56`).
- **Response:** the `executeSearch` result object (matched tutors + per-slot availability, `snapshotMeta`).
- **Errors:** `400` (`{ "error": "Invalid JSON" }` or `{ "error": "Invalid request", "details": … }`), `401`, `500 { "error": "Search failed" }`.

### `POST /api/search/assistant`

Natural-language AI scheduler turn: the admin pastes a parent message, the LLM extracts a structured request, the app decides availability via the search engine, and a parent-reply draft is returned. Source: `src/app/api/search/assistant/route.ts`. This is the **only** route in this group on the middleware public allowlist, but it still enforces a session in-handler.

- **Auth:** `auth()` → `401` (`route.ts:136-139`).
- **Gate:** if `!isAiSchedulerConfigured()`, returns `503 { "error": "AI scheduler is not configured" }` (`route.ts:156-161`). The feature is gated by the `OPENAI_*` env vars / `ENABLE_AI_SCHEDULER`.
- **Request body** — Zod `aiSchedulerRequestSchema` (`src/lib/ai/scheduler.ts:141-143`): `{ input: string }` — trimmed, min 1, max 6000 chars, `.strict()`.
- **Behavior:** runs one scheduler turn via `executeSchedulerTurn(...)` with the pasted text as a single `admin` message, maps the result into a response, and persists a row via `logSchedulerRun(...)` (redacted input preview, model, latency breakdown, parsed/solver payloads) — both on success and on failure (`route.ts:168-205`).
- **Response (200):** one of three discriminated shapes, all carrying a `logId`:
  - `{ status: "needs_clarification", partial, clarifyingQuestions[], warnings[], logId }`
  - `{ status: "solved", parsedRequest, options[], parentMessageDraft, snapshotMeta, warnings[], logId }`
  - `{ status: "availability_summary", state, availabilitySummary, assistantMessage, parentMessageDraft, snapshotMeta, warnings[], logId }`

  (shape assembly: `responseFromSchedulerResult`, `route.ts:101-133`).
- **Side effects:** writes an AI-scheduler run-log row (always — success or failure path).
- **Errors:** `400` (`{ "error": "Invalid JSON" }` / `{ "error": "Invalid request", "details": … }`), `401`, `503` (not configured), and on a thrown turn error `502 { "error": "AI scheduling failed", "detail": <message>, "logId": <id> }` — note a failure-path log row is still written (`route.ts:189-210`).

---

## Compare

Side-by-side week-scoped comparison of 1–3 tutors (conflicts + shared free slots), and candidate discovery to suggest a tutor to add. Both run against the in-memory index.

### `POST /api/compare`

Assemble week schedules for 1–3 tutors, detect same-student conflicts, and compute shared free slots. Source: `src/app/api/compare/route.ts`.

- **Auth:** `auth()` → `401` when no session (`route.ts:113-116`).
- **Request body** — Zod `compareRequestSchema` (`route.ts:24-31`):
  | Field | Type | Notes |
  |---|---|---|
  | `tutorGroupIds` | `string[]`, **1–3 items** | required |
  | `mode` | `"recurring" \| "one_time"` | required |
  | `dayOfWeek` | number 0–6 | optional |
  | `date` | string | optional |
  | `weekStart` | string `YYYY-MM-DD` | optional — defaults to the current Bangkok Monday (`getCurrentMonday`, `route.ts:34-41`) |
  | `fetchOnly` | `string[]` | optional — incremental fetch: serialize only this subset, but still use the full set for conflict/free-slot detection (`route.ts:229-236`) |
- **Behavior / side effects (read-only):**
  - Resolves requested ids against the active snapshot; ids that are stale (point at a prior snapshot's identity-group id) are remapped via `tutorIdentityGroups.canonicalKey`, pushing the warning `"Tutor selection was refreshed after the latest Wise sync"` (`resolveTutorGroupsForActiveSnapshot`, `route.ts:61-110, 157-159`).
  - **Historical-range merge (D-07 / PAST-01):** if any day in the requested week is before start-of-today Bangkok, fetches `past_session_blocks` for the tutors' canonical keys and merges them into both `buildCompareTutor` and `findSharedFreeSlots` (`route.ts:185-227`).
- **Response (200)** — `CompareResponse` (`src/lib/search/types.ts`): `{ snapshotMeta, tutors[], conflicts[], sharedFreeSlots[], weekStart, weekEnd, latencyMs, warnings[] }` (`route.ts:238-247`).
- **Errors:** `400` (`{ "error": "Invalid JSON" }` / `{ "error": "Invalid request", "details": … }`), `401`, `404 { "error": "No matching tutor groups found in active snapshot" }` when none of the ids resolve (`route.ts:161-166`), `500 { "error": "Compare failed" }`.

### `POST /api/compare/discover`

Rank candidate tutors to add to an existing comparison (0–2 already chosen), scored by conflict count and free-slot fit. Source: `src/app/api/compare/discover/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:30-33`).
- **Request body** — Zod `discoverRequestSchema` (`route.ts:12-27`):
  | Field | Type | Notes |
  |---|---|---|
  | `existingTutorGroupIds` | `string[]`, **max 2** | required |
  | `mode` | `"recurring" \| "one_time"` | required |
  | `dayOfWeek` | number 0–6 | optional |
  | `date` | string | optional |
  | `startTime` / `endTime` | `"HH:MM"` (regex) | optional |
  | `modeFilter` | `"online" \| "onsite" \| "either"` | optional |
  | `filters` | `{ subject?, curriculum?, level? }` | optional |
- **Behavior (read-only):** iterates the active index's tutor groups (excluding the already-chosen ones), filters by `supportedModes`/qualifications, computes per-candidate `freeSlots`, conflicts vs the existing set, and a `hasDataIssues` flag; sorts data-clean → fewest conflicts → most free slots (`route.ts:78-157`).
- **Response (200)** — `DiscoverResponse`: `{ snapshotMeta, candidates[], latencyMs }`, each candidate `{ tutorGroupId, displayName, supportedModes, qualifications, conflictCount, conflicts[], freeSlots[], hasDataIssues, dataIssueReasons[] }` (`route.ts:140-165`).
- **Errors:** `400`, `401`, `500 { "error": "Discover failed" }`.

---

## Tutors

### `GET /api/tutors`

Combobox source: the active snapshot's tutors. Source: `src/app/api/tutors/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:6-9`).
- **Request:** none (no query params, no body).
- **Response (200):** `{ tutors: TutorListItem[] }`, where `TutorListItem = { tutorGroupId, displayName, supportedModes: string[], subjects: string[] }` (`src/lib/data/tutors.ts:7-12`; `getTutorList()`).
- **Errors:** `401`, `500 { "error": "Failed to load tutors" }`.

---

## Filters

### `GET /api/filters`

Dropdown facets (subjects / curriculums / levels) derived from the active snapshot's qualifications. Source: `src/app/api/filters/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:6-9`).
- **Request:** none.
- **Response (200):** `FilterOptions = { subjects: string[], curriculums: string[], levels: string[] }`, each sorted (`src/lib/data/filters.ts:7-11, 30-34`). Cached server function (`"use cache"`, tagged `snapshot`).
- **Errors:** `401`, `500 { "error": "Failed to load filters" }`.

---

## Tutor Profiles

Editorial business context Wise does not store (parent-safe summary, fit, tags), keyed by stable `canonicalKey` and read by the AI scheduler. Mutating a profile clears the in-memory search index so the next search rebuilds with the new profile data.

### `GET /api/tutor-profiles`

List all tutor business profiles. Source: `src/app/api/tutor-profiles/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:7-10`).
- **Request:** none.
- **Response (200):** `{ profiles: TutorBusinessProfile[] }` (`listTutorBusinessProfiles(getDb())`, `route.ts:13-14`).
- **Errors:** `401`, `500 { "error": "Failed to load tutor profiles" }`.

### `PATCH /api/tutor-profiles/[canonicalKey]`

Upsert a single tutor's editorial profile. Source: `src/app/api/tutor-profiles/[canonicalKey]/route.ts`. The `canonicalKey` path segment is URL-decoded (`route.ts:13-16`).

- **Auth:** `auth()` → `401` (`route.ts:22-25`).
- **Request body** — Zod `tutorBusinessProfilePatchSchema` (`src/lib/tutor-business-profiles.ts:36-55`, `.strict()`). All fields optional; key fields: `displayName` (1–160), `parentSafeSummary` (≤1200), `internalNotes` (≤3000), `education[]` (≤12), `languages[]` (≤12), `englishProficiency`, `youngLearnerFit`, `youngestComfortableAge` (int 3–20, nullable), `teachingStyleTags[]`/`strengthTags[]`/`curriculumExperience[]` (≤30 each), various `*Notes` (≤2000), `verifiedBy` (≤160, nullable), `lastReviewedAt` (ISO datetime, nullable), `active` (boolean).
- **Behavior:** resolves the active-snapshot display name for `canonicalKey`; if the tutor is not in the active snapshot → `404 { "error": "Tutor not found in active snapshot" }` (`route.ts:43-47`). On success, `upsertTutorBusinessProfile(...)` then `clearSearchIndex()` (`route.ts:50-52`).
- **Response (200):** `{ profile }`.
- **Side effects:** upserts the `tutor_business_profiles` row; **clears the in-memory search index**.
- **Errors:** `400` (`{ "error": "Invalid JSON" }` / `{ "error": "Invalid request", "details": … }`), `401`, `404`, `500 { "error": "Failed to save tutor profile" }`.

### `POST /api/tutor-profiles/import-preview`

Parse uploaded education/availability workbooks and return a dry-run import preview (matched to active identities + aliases). Source: `src/app/api/tutor-profiles/import-preview/route.ts`. **Multipart form-data**, not JSON.

- **Auth:** `auth()` → `401` (`route.ts:26-29`).
- **Request (multipart):** `await request.formData()`; on failure → `400 { "error": "Expected multipart form data" }` (`route.ts:31-36`). Fields:
  - `educationFile` and/or `availabilityFile` — file parts (zero-size treated as absent). At least one is required, else `400 { "error": "Upload at least one tutor profile workbook" }` (`route.ts:48-50`).
  - `verifiedBy`, `lastReviewedAt` — optional string fields, trimmed-or-null (`route.ts:20-23, 62-63`).
- **Behavior (read-only):** parses workbooks via `parseTutorProfileImportWorkbooks`, then `buildTutorProfileImportPreview(...)` against active profiles, identities, and aliases.
- **Response (200):** the preview object (per-row proposed `canonicalKey` + patch + match status).
- **Errors:** `400`, `401`, `500 { "error": "Failed to preview tutor profile import" }`.

### `POST /api/tutor-profiles/import-commit`

Commit a reviewed batch of profile patches. Source: `src/app/api/tutor-profiles/import-commit/route.ts`. JSON body.

- **Auth:** `auth()` → `401` (`route.ts:20-23`).
- **Request body** — Zod `importCommitSchema` (`route.ts:12-17`, `.strict()`): `{ rows: Array<{ canonicalKey: string (min 1), patch: tutorBusinessProfilePatchSchema }> }` — `rows` **min 1, max 200**.
- **Behavior:** for each row, if the `canonicalKey` is not in the active snapshot it is skipped (recorded with reason `"Tutor not found in active snapshot"`); otherwise `upsertTutorBusinessProfile(...)`. If any row saved, `clearSearchIndex()` (`route.ts:47-61`).
- **Response (200):** `{ savedCount, skipped: Array<{ canonicalKey, reason }>, profiles: <saved profiles> }`.
- **Side effects:** upserts 0–200 `tutor_business_profiles` rows; **clears the search index** when ≥1 saved.
- **Errors:** `400` (`{ "error": "Invalid JSON" }` / `{ "error": "Invalid request", "details": … }`), `401`, `500 { "error": "Failed to commit tutor profile import" }`.

---

## Progress Tests

The every-8-classes progress-test tracker. **Reads** are role-scoped: a `teacher` session sees only its own students (the GET resolves the teacher's canonical-key set), an `admin` session sees every enrollment. **All mutations are admin-only** — `requireProgressTestsAdminSession` throws `"Forbidden"` (→ `403`) for a teacher session before any write. The shared error-mapper `progressTestsErrorResponse` maps `"Unauthorized"`→`401`, `"Forbidden"`→`403`, and everything else →`500` (re-throwing Next's hanging-promise rejection) (`src/lib/progress-tests/api.ts:65-88`).

All five mutation routes share the same skeleton: `requireProgressTestsAdminSession()` → `request.json()` (in try/catch → `400 { "error": "Invalid JSON body" }`) → `safeParse()` (→ `400 { "error": <flattened> }`) → service call → `404 { "error": "Enrollment not found" }` when the enrollment is unknown.

### `GET /api/progress-tests`

Dashboard payload. Source: `src/app/api/progress-tests/route.ts`.

- **Auth:** `requireProgressTestsSession()` — `401`/`403` via mapper. Teacher vs admin scoping resolved in-handler (`route.ts:11-13`).
- **Request:** none.
- **Response (200):** `ProgressTestsPayload = { rows: ProgressTestRow[], summary: ProgressTestsSummary, subjects: string[], lastSyncedAt: string | null, generatedAt: string }` (`src/lib/progress-tests/types.ts:80-96`). Each `ProgressTestRow` carries cycle counts/threshold/status, the most-frequent tutor, booking state, optional parent LINE contact + recommended slots + prebuilt parent message.
- **Errors:** `401`, `403`, `500 { "error": "Progress tests load failed" }`.

### `POST /api/progress-tests/book`

Book a progress test for an enrollment (admin-confirmed). Source: `src/app/api/progress-tests/book/route.ts`.

- **Auth:** `requireProgressTestsAdminSession()` — admin-only (`route.ts:17`).
- **Request body** — Zod `BookProgressTestSchema` (`route.ts:6-13`):
  | Field | Type | Notes |
  |---|---|---|
  | `enrollmentKey` | string (min 1) | required |
  | `testDate` | ISO datetime (`z.string().datetime()`) | required; parsed to `Date` |
  | `location` | string | optional → `null` |
  | `modality` | `"online" \| "offline"` | optional (parsed but not forwarded to the service in this handler) |
  | `scheduleMethod` | `"after_class" \| "parent_pick"` | defaults to `"parent_pick"` |
- **Behavior:** `bookTest(...)` derives the session end from `testDate` + default duration and delegates the audited, flag-gated Wise write; then reloads the dashboard row (`route.ts:31-43`). Unknown enrollment → `404 { "error": "Enrollment not found" }`.
- **Response (200):** `BookProgressTestServiceResult = { status, wiseSessionId: string | null, bookingMode: "wise" | "manual" | null, message, row: ProgressTestRow | null }` (`src/lib/progress-tests/service.ts:313-319`).
- **Side effects:** writes progress-test cycle/booking state; may perform a flag-gated Wise session write.
- **Errors:** `400`, `401`, `403`, `404`, `500 { "error": "Progress test booking failed" }`.

### `POST /api/progress-tests/mark-complete`

Manually roll an enrollment's current cycle to complete. Source: `src/app/api/progress-tests/mark-complete/route.ts`.

- **Auth:** admin-only (`route.ts:12`).
- **Request body** — Zod `MarkCompleteSchema` (`route.ts:6-8`): `{ enrollmentKey: string (min 1) }`.
- **Behavior:** `markComplete(...)`; unknown enrollment → `404` (`route.ts:26-29`).
- **Response (200):** `{ row: ProgressTestRow }`.
- **Errors:** `400`, `401`, `403`, `404`, `500 { "error": "Mark complete failed" }`.

### `POST /api/progress-tests/select-at-home`

Mark the enrollment's progress test as an at-home test (selected). Source: `src/app/api/progress-tests/select-at-home/route.ts`.

- **Auth:** admin-only (`route.ts:12`).
- **Request body** — Zod `SelectAtHomeSchema` (`route.ts:6-8`): `{ enrollmentKey: string (min 1) }`.
- **Behavior:** `selectAtHome(...)`; unknown enrollment → `404`.
- **Response (200):** `{ row: ProgressTestRow }`.
- **Errors:** `400`, `401`, `403`, `404`, `500 { "error": "Select at-home failed" }`.

### `POST /api/progress-tests/mark-at-home-submitted`

Mark a previously-selected at-home test as submitted. Source: `src/app/api/progress-tests/mark-at-home-submitted/route.ts`.

- **Auth:** admin-only (`route.ts:12`).
- **Request body** — Zod `MarkAtHomeSubmittedSchema` (`route.ts:6-8`): `{ enrollmentKey: string (min 1) }`.
- **Behavior:** `submitAtHome(...)`; unknown enrollment → `404`.
- **Response (200):** `{ row: ProgressTestRow }`.
- **Errors:** `400`, `401`, `403`, `404`, `500 { "error": "Mark at-home submitted failed" }`.

### `POST /api/progress-tests/resend-email`

Resend the teacher heads-up email for an enrollment (one-off, idempotent per cycle). Source: `src/app/api/progress-tests/resend-email/route.ts`.

- **Auth:** admin-only (`route.ts:12`).
- **Request body** — Zod `ResendEmailSchema` (`route.ts:6-8`): `{ enrollmentKey: string (min 1) }`.
- **Behavior:** `resendTeacherEmail(...)` rebuilds a single heads-up from stored cycle fields (reusing the persisted AI summary) and sends it via `runTeacherHeadsUpNotifications` (idempotent per cycle; stamps `teacherNotifiedAt` on success); unknown enrollment → `404` (`src/lib/progress-tests/service.ts:422-449`).
- **Response (200):** `ResendTeacherEmailServiceResult = { outcome: <per-enrollment send outcome> | null, row: ProgressTestRow | null }` (`service.ts:405-408`).
- **Side effects:** may send a teacher heads-up email; may stamp `teacherNotifiedAt`.
- **Errors:** `400`, `401`, `403`, `404`, `500 { "error": "Resend teacher email failed" }`.

---

## Student Promotions

The student grade/course promotion audit + apply pipeline. A **dry-run** builds a proposed set of grade/course writes from the active snapshot; an admin then **verifies** the run (confirming they checked the endpoint), and finally **applies** it (executes the Wise writes). Applies are gated to on/after **July 1, 2026 Bangkok time** for the `admin` trigger. The shared error-mapper `studentPromotionErrorResponse` maps `"Unauthorized"`→`401`, any `/not found/i` message →`404`, any message matching `/(required|cannot|only|no verified|no pending|before July 1)/i` →`400`, else →`500` (`src/lib/student-promotions/api.ts:29-56`).

Auth for all five routes: `requireStudentPromotionSession()` (`src/lib/student-promotions/api.ts:9-15`) — requires a session with email+name, else throws `"Unauthorized"` → `401`. The `[runId]` routes additionally resolve the path param via `requireStudentPromotionRunId(context)`, which throws `"Student promotion run id is required"` (→ `400` by the mapper) when absent/blank (`api.ts:17-27`).

### `GET /api/student-promotions/runs`

Load the latest run's detail. Source: `src/app/api/student-promotions/runs/route.ts`. `maxDuration = 800`.

- **Auth:** session-required (`route.ts:9`).
- **Request:** none.
- **Response (200):** `{ detail: StudentPromotionRunDetail | null }` — `null` when no run has ever been created (`getLatestStudentPromotionRunDetail`, `src/lib/student-promotions/data.ts:519`). `StudentPromotionRunDetail = { run, gradeActions[], courseActions[], summary: { pending/skipped/applied/failed × grade/course actions } }` (`data.ts:38-52`).
- **Errors:** `401`, `500 { "error": "Failed to load student promotion run" }`.

### `POST /api/student-promotions/runs`

Create a new dry-run audit. Source: `src/app/api/student-promotions/runs/route.ts`. `maxDuration = 800`.

- **Auth:** session-required; the resolved `{ email, name }` becomes the run actor (`route.ts:18`).
- **Request:** none (no body).
- **Behavior:** `createStudentPromotionDryRun({ actor })` — fetches the active snapshot's students/packages + Wise registration state and computes proposed grade/course actions (no Wise writes).
- **Response (201):** `{ detail: StudentPromotionRunDetail }` (`route.ts:19`).
- **Side effects:** inserts a `student_promotion_runs` row + grade/course action rows (all `pending`/`skipped`, none applied).
- **Errors:** `401`, `500 { "error": "Student promotion audit failed" }`.

### `GET /api/student-promotions/runs/[runId]`

Load a specific run's detail. Source: `src/app/api/student-promotions/runs/[runId]/route.ts`.

- **Auth:** session-required; resolves `runId` from the path (`route.ts:15-16`).
- **Request:** none.
- **Response (200):** `{ detail: StudentPromotionRunDetail }`. An unknown `runId` throws `"Student promotion run not found"` → mapped to `404` (`data.ts:489`).
- **Errors:** `400` (missing run id), `401`, `404` (unknown run), `500 { "error": "Failed to load student promotion run" }`.

### `POST /api/student-promotions/runs/[runId]/verify`

Mark a dry-run as verified (records the admin's endpoint-verification confirmation + optional note). Source: `src/app/api/student-promotions/runs/[runId]/verify/route.ts`.

- **Auth:** session-required; resolves `runId` (`route.ts:15-16`).
- **Request body** (hand-parsed, not Zod; a JSON parse failure is swallowed to `{}`, `route.ts:17`):
  | Field | Type | Notes |
  |---|---|---|
  | `endpointVerificationConfirmed` | boolean | **must be `true`**, else `400 { "error": "Endpoint verification confirmation is required" }` (`route.ts:23-25`) |
  | `endpointVerificationNote` | string | optional; non-strings coerced to `""` |
- **Behavior:** `verifyStudentPromotionRun({ runId, actor, endpointVerificationNote })` — flips the run to a verified state.
- **Response (200):** `{ detail: StudentPromotionRunDetail }`.
- **Side effects:** updates the run row's verification fields.
- **Errors:** `400` (missing run id / unconfirmed / guard messages), `401`, `404` (unknown run), `500 { "error": "Student promotion verification failed" }`.

### `POST /api/student-promotions/runs/[runId]/apply`

Apply a verified run — execute the Wise grade/course promotion writes. Source: `src/app/api/student-promotions/runs/[runId]/apply/route.ts`. `maxDuration = 800`.

- **Auth:** session-required; resolves `runId`; actor recorded (`route.ts:17-18`).
- **Request body** (hand-parsed; parse failure swallowed to `{}`, `route.ts:19`): `{ confirm: "apply-student-promotions" }` — the literal string is required, else `400 { "error": "Apply confirmation is required" }` (`route.ts:20-22`).
- **Behavior:** `applyVerifiedStudentPromotionRun({ runId, actor, trigger: "admin" })`. **Date gate:** throws `"Student promotions cannot be applied before July 1, 2026 Bangkok time"` (→ `400`) for an admin trigger before the target date (`data.ts:734`). Requires a verified run, else `"No verified student promotion run found"` → `404`-ish (mapped to `404` by `/not found/i`, `data.ts:803`).
- **Response (200):** `{ detail: StudentPromotionRunDetail }` with applied/failed action counts in `summary`.
- **Side effects:** **executes Wise writes** (grade + course promotions, rate-limited at concurrency 3); updates action rows to `applied`/`failed`.
- **Errors:** `400` (missing run id / missing confirm / before-July-1 / other guard messages), `401`, `404` (no verified run), `500 { "error": "Student promotion apply failed" }`.

---

## Leave Requests

> **Status:** the entire Leave Requests feature is present in the working tree but **uncommitted** at this revision (per the feature docs). The route handlers under `src/app/api/leave-requests/` are documented here; the underlying `src/lib/leave-requests/**` is the in-flight source.

Tutor leave-request triage: pull leave-form rows from a Google Sheet, match to a Wise identity, compute affected sessions, give admins a worklist + sheet-status writeback + dry-run Wise-cancel preview. These handlers check `!session?.user?.email` (not just `!session`). JSON `POST`/`PATCH` bodies are parsed leniently — a parse failure becomes `{}`, never a `400`.

### `GET /api/leave-requests`

List/filter leave requests (+ Google Sheets connection status). Source: `src/app/api/leave-requests/route.ts`.

- **Auth:** `!session?.user?.email` → `401` (`route.ts:8-11`).
- **Query params** (all optional, read from `request.nextUrl.searchParams`, `route.ts:13-21`): `status`, `q` (free-text search), `startDate`, `endDate`, `summaryOnly` (`"true"` → boolean).
- **Behavior:** `listLeaveRequests(getDb(), …)` plus `getGoogleTokenStatus(session.user.email)`.
- **Response (200):** the list payload spread with `{ ...data, googleSheets }` (rows/summary + the connected-token status).
- **Errors:** `401`, `500 { "error": "Leave request query failed" }`.

### `POST /api/leave-requests/sync`

Manually trigger a leave-request sync from the Google Sheet. Source: `src/app/api/leave-requests/sync/route.ts`. `maxDuration = 800`.

- **Auth:** `!session?.user?.email` → `401` (`route.ts:9-12`).
- **Request body** (lenient JSON → `{}` on failure): optional `{ connectedEmail?: string }` — the Google account whose token to use (`route.ts:14-27`).
- **Behavior:** `syncLeaveRequests(getDb(), { triggerType: "manual", actorEmail, actorName, connectedEmail })`. Single-flight: a concurrent run throws `LeaveRequestSyncAlreadyRunningError`.
- **Response (200):** `{ ok: true, result }`.
- **Side effects:** runs the leave-request ingest/match pipeline; writes sync-run + request rows; may write sheet status back.
- **Errors:** `401`, `409 { "error": <already-running message> }` on a concurrent run (`route.ts:31-33`), `500 { "error": "Leave request sync failed" }`.

### `GET /api/leave-requests/[requestId]`

Fetch one leave-request's detail (request + affected sessions + activity). Source: `src/app/api/leave-requests/[requestId]/route.ts`.

- **Auth:** `!session?.user?.email` → `401` (`route.ts:15-18`).
- **Request:** `requestId` from the path; no body.
- **Behavior:** `getLeaveRequestDetail(getDb(), requestId)`; `null` → `404 { "error": "Not found" }` (`route.ts:20-23`).
- **Response (200):** the detail object.
- **Errors:** `401`, `404`. (No explicit `try/catch` around the lookup — an unexpected throw surfaces as the framework's default.)

### `PATCH /api/leave-requests/[requestId]`

Update a leave-request's workflow status / staff note / sheet-status text, with optional sheet-write retry. Source: `src/app/api/leave-requests/[requestId]/route.ts`.

- **Auth:** `!session?.user?.email` → `401` (`route.ts:27-30`).
- **Request body** (lenient JSON → `{}`; hand-validated, not Zod), fields read at `route.ts:39-43, 54-63`:
  | Field | Type | Notes |
  |---|---|---|
  | `workflowStatus` | string | if present, must be in `LEAVE_WORKFLOW_STATUSES`, else `400 { "error": "Invalid workflow status" }` |
  | `staffNote` | string \| `null` | tri-state: string sets, `null` clears, absent leaves unchanged |
  | `sheetStatusText` | string \| `null` | applied only when the key is present (own-property check) |
  | `retrySheetWrite` | boolean | `true` retries the Sheets writeback |
- **Behavior:** resolves a `connectedEmail` (best-effort; failure → `null`), then `updateLeaveRequestWorkflow(...)`; an unknown request → `404 { "error": "Not found" }` (`route.ts:45-66`).
- **Response (200):** `{ ok: true, ...result }`.
- **Side effects:** updates the request row; may write status back to the Google Sheet.
- **Errors:** `400` (invalid workflow status), `401`, `404`, `500 { "error": "Leave request update failed" }`.

### `POST /api/leave-requests/[requestId]/wise-cancel-preview`

Build a **dry-run** preview of the Wise session cancellations a leave would imply (no Wise writes). Source: `src/app/api/leave-requests/[requestId]/wise-cancel-preview/route.ts`.

- **Auth:** `!session?.user?.email` → `401` (`route.ts:9-12`).
- **Request body** (lenient JSON → `{}`): `{ affectedSessionIds?: string[] }` — non-string entries filtered out; defaults to `[]` (`route.ts:20-23`).
- **Behavior:** `createWiseCancelPreview(getDb(), requestId, { affectedSessionIds, actorEmail, actorName })`.
- **Response (200):** `{ ok: true, detail }`.
- **Side effects:** records the preview attempt (audit); **does not** cancel anything in Wise.
- **Errors:** `401`; **any** thrown error → `400 { "error": <message or "Wise cancel preview failed"> }` (this route uses `400`, not `500`, as its catch-all, `route.ts:33-36`).

---

## Home / Ops Hub

The landing-page summary that powers the Ops Hub at `/` and the top-nav badge counts. Read-only; access-filtered to the viewer's `allowedPages`. For *what* the hub is, see [docs/features/ops-hub.md](../../features/ops-hub.md).

### `GET /api/home/summary`

Aggregate operational signals for the home page: per-queue action counts + a data-freshness strip. Source: `src/app/api/home/summary/route.ts`.

- **Auth:** `auth()` → `401 { "error": "Unauthorized" }` when `!session?.user?.email` (`route.ts:7-10`). This path is explicitly allowlisted in the middleware (`src/middleware.ts:27`) so it bypasses page-level `allowedPages` redirects for restricted users, but the handler still enforces a session and the payload is itself access-filtered.
- **Request:** none (no query params, no body).
- **Behavior:** delegates to `getHomeSummaryPayload({ allowedPages, email }, getDb())` (`src/lib/home/summary.ts`). Each of the seven action queues is loaded only when the viewer can access its page (`canAccessHref`); each source is wrapped fail-soft so one failure marks only that queue's card `status: "error"` (value `null`) without failing the request.
- **Response (200):** `HomeSummaryPayload` (`src/lib/home/summary.ts:53-57`):
  - `generatedAt` — ISO timestamp.
  - `actions[]` — accessible queues only, each `{ id: NavBadgeKey, toolId, label, href, value: number | null, detail, status: "ok" | "error", error: string | null }`. Possible `id`s: `leaveRequests`, `lineReviews`, `progressTests`, `creditControl`, `payroll`, `wiseReconciliation`, `dataHealth`.
  - `freshness` — `{ status: "ok" | "error", checkedAt, overallStatus, overallHeadline, staleAgeMs, staleMinutes, wiseSnapshotLastSuccess, cronCounts: { healthy, late, failing, running, manualOnly, unknown }, googleSheets: { connected, writeConnected, email, lastError }, error }` (sourced from the Data Health payload + the viewer's Google OAuth token status; degrades to a zeroed error shape when Data Health is unavailable).
- **Errors:** `401`, `500 { "error": <err.message or "Home summary failed"> }` (`route.ts:17-20`).

---

## Data Health

Sync status, snapshot stats, and the cron/job runner that lets an admin trigger background jobs from the dashboard.

### `GET /api/data-health`

Dashboard payload (sync status, snapshot stats, normalization-issue counts). Source: `src/app/api/data-health/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:15-18`).
- **Request:** none.
- **Response (200):** `getDataHealthDashboardPayload()` — sync-run summary + snapshot metrics + normalization issues. (This module also re-exports a `selectModalityIssues` helper for tests; it is not part of the HTTP surface.)
- **Errors:** `401`, `500 { "error": "Data health failed" }`.

### `POST /api/data-health/jobs/[jobKey]/run`

Manually run a registered background job from the data-health dashboard. Source: `src/app/api/data-health/jobs/[jobKey]/run/route.ts`.

- **Auth:** `!session?.user?.email` → `401` (`route.ts:11-14`).
- **Path param:** `jobKey` — must resolve via `getCronJobDefinition(jobKey)`; an unknown key → `404 { "error": "Unknown job" }` (`route.ts:16-20`). Valid `CronJobKey` values: `wise_snapshot`, `wise_activity`, `sales_dashboard`, `credit_control`, `progress_tests`, `progress_tests_digest`, `leave_requests`, `classroom_morning`, `classroom_admin_email`, `student_promotions_july_1`, `room_utilization` (`src/lib/data-health/cron-registry.ts:3-14`).
- **Request body** (lenient JSON → `{}`): `{ confirmed?: boolean }`. For a job flagged `dangerous: true` (`classroom_morning`, `classroom_admin_email`, `student_promotions_july_1`), `confirmed !== true` → `409 { "error": "Confirmation required", "confirmationLabel": <job.confirmationLabel> }` (`route.ts:22-31`).
- **Behavior:** dispatches to `runDataHealthJob(jobKey, actorEmail)`, wrapped in a cron-invocation audit (`triggerSource: "admin"`). Each branch returns its own status:
  - `wise_snapshot` → delegates to `runWiseSyncRequest()`.
  - `wise_activity`, `leave_requests` → `200 { ok: true, result }`; a single-flight collision → `409`.
  - `sales_dashboard` → `200 { ok: true, results, projectionResult }`.
  - `credit_control` → delegates to `runCreditControlSyncRequest()`.
  - `classroom_morning` → returns the automation result (`500 { ok: false, error }` on throw).
  - `classroom_admin_email` → returns the email result (`500` when `status === "failed"`).
  - `room_utilization` → `200 { ok: true, ...result }`.
  - **`progress_tests`, `progress_tests_digest`, `student_promotions_july_1`** have **no executor branch** in `runDataHealthJob` and fall through to `404 { "error": "Unknown job" }` (`src/lib/data-health/run-job.ts:121`) — even though `getCronJobDefinition` recognizes them (so the route-level 404 and dangerous-confirmation checks still apply first). See [open questions](#open-questions-recorded-during-documentation).
- **Side effects:** whatever the dispatched job does (Wise snapshot sync, sales/credit/leave/room imports, classroom automation + email). Always writes a cron-invocation audit row.
- **Errors:** `401`, `404` (unknown key, or an unimplemented executor branch), `409` (unconfirmed dangerous job, or a single-flight collision inside a job), `500` (per-branch failures).

---

## Admin

### `POST /api/admin/sync-wise`

Admin-session trigger for a full Wise snapshot sync (the same pipeline the cron runs, but session-gated rather than `CRON_SECRET`-gated). Source: `src/app/api/admin/sync-wise/route.ts`. `maxDuration = 800`.

- **Auth:** `auth()` → `401` when no session (`route.ts:9-12`). Any allowed session may trigger it (no extra role check beyond session presence).
- **Request:** none (no body).
- **Behavior:** `runWiseSyncRequest()` wrapped in `withCronInvocationAudit({ jobKey: "wise_snapshot", triggerSource: "admin", actorEmail, requestMethod: "POST" }, …)` (`route.ts:15-23`). The single-flight guard lives inside `runWiseSyncRequest`; on success it revalidates the `snapshot` cache tag.
- **Response:** the `runWiseSyncRequest()` result (sync-run outcome) — status/body determined by that function.
- **Side effects:** runs the full fetch → normalize → persist → validate → atomic-promote pipeline; writes a `sync_runs` row + a cron-invocation audit row; on success promotes a new active snapshot and sweeps the `snapshot` cache tag.
- **Errors:** `401`; otherwise whatever `runWiseSyncRequest()` returns.

---

## Open questions (recorded during documentation)

- **`progress_tests`, `progress_tests_digest`, and `student_promotions_july_1` are registry keys with no executor.** `getCronJobDefinition` recognizes all three (so `POST /api/data-health/jobs/[jobKey]/run` passes its route-level 404 check, and the two `dangerous` ones still demand `confirmed: true`), but `runDataHealthJob` has no branch for them and falls through to `404 { "error": "Unknown job" }` (`src/lib/data-health/run-job.ts`; keys at `cron-registry.ts:97-191`). So a confirmed run of `student_promotions_july_1` from the dashboard returns a confusing 404 rather than applying promotions (the real apply path is `POST /api/student-promotions/runs/[runId]/apply`). Intentional (these jobs are cron-only / triggered elsewhere) or a gap? The same three keys do appear in the dashboard's status registry.
- **`GET /api/leave-requests/[requestId]` has no `try/catch`.** Unlike its sibling `PATCH`, the GET handler calls `getLeaveRequestDetail` without a guard, so an unexpected DB error surfaces as the framework default rather than a `500 { "error": … }`. Minor inconsistency; likely fine since the read is simple.
- **`POST /api/progress-tests/book` accepts `modality` but drops it.** The Zod schema parses `modality: "online" | "offline"` (`book/route.ts:10`), but the handler never forwards it to `bookTest(...)` (`route.ts:31-37`). Either dead input or a missed wiring — worth confirming whether modality should influence the booked Wise session.

_Verified against HEAD `d4fe6d3` on 2026-06-05._
