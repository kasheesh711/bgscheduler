# Misc API Reference — Search, Compare, Admissions & the remaining route families

Mechanical HTTP reference for **127 endpoints** across seventeen path families: the search/compare workspace, tutor metadata and filter dropdowns, the home summary, data health, the admin Wise-sync trigger, the Auth.js catch-all, tutor business profiles, leave requests, student schedule links, progress tests, post-class feedback, competitor intelligence, student promotions, US universities, and the full University Admissions case-management surface.

> **Canonical-home rule:** this page owns request/response signatures, status codes, and guard mechanics. *Why* these endpoints exist — workflows, business rules, fail-closed policy — lives in `docs/features/*`. The master method+path inventory lives in [index.md](./index.md).

| Family | Endpoints | Section |
|---|---|---|
| Search | 3 | [Search](#search) |
| Compare | 2 | [Compare](#compare) |
| Tutors / Filters | 2 | [Tutors and filters](#tutors-and-filters) |
| Home | 1 | [Home summary](#home-summary) |
| Data Health | 2 | [Data health](#data-health) |
| Admin | 1 | [Admin](#admin) |
| Auth | 2 | [Auth](#auth) |
| Tutor Profiles | 4 | [Tutor profiles](#tutor-profiles) |
| Leave Requests | 5 | [Leave requests](#leave-requests) |
| Student Schedule | 2 | [Student schedule](#student-schedule) |
| Progress Tests | 6 | [Progress tests](#progress-tests) |
| Post-Class Feedback | 13 | [Post-class feedback](#post-class-feedback) |
| Competitor Intelligence | 9 | [Competitor intelligence](#competitor-intelligence) |
| Student Promotions | 9 | [Student promotions](#student-promotions) |
| US Universities | 5 | [US universities](#us-universities) |
| University Admissions | 61 | [University admissions](#university-admissions) |
| **Total** | **127** | |

---

## Conventions shared across these endpoints

### Middleware tier

Every path below is **admin** tier except the Auth.js catch-all (public) and `POST /api/search/assistant`.

`isPublicRoute` (`src/middleware.ts:4-20`) allowlists `/login*`, `/api/auth*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/schedule/*` (parent schedule links — token-only access), two OA-resolver paths, and all of `/api/internal/*`. Everything else redirects an unauthenticated page request to `/login?callbackUrl=…` (`src/middleware.ts:71-75`).

For a restricted user whose JWT carries `allowedPages`, `isPathAllowed` (`src/middleware.ts:30-61`) matches the pathname against each allowed prefix, both as a page (`/x`, `/x/…`) and as its API namespace (`/api/x`, `/api/x/…`). A miss returns `403 { "error": "Forbidden" }` on `/api/*` paths and redirects page requests to `allowedPages[0]` (`src/middleware.ts:79-88`). Three deliberate exemptions:

- `/api/home/summary` always passes (`middleware.ts:32`) so every signed-in user can load their landing page.
- `/post-class-feedback*` and `/api/post-class-feedback*` always pass (`middleware.ts:35-40`) because that family resolves fresh Postgres capabilities per request; legacy JWT page prefixes must not override those grants.
- `/learning-plans*` pages pass, while `/api/learning-plans*` is explicitly denied (`middleware.ts:44-51`).

`POST /api/search/assistant` is public at the middleware but still requires a session in-handler and returns `401` without one (`src/app/api/search/assistant/route.ts:136-139`).

### Guard helpers and their status codes

Six guard modules appear on this page. Each throws a sentinel that its family's error mapper translates.

| Guard | Source | Behaviour |
|---|---|---|
| `auth()` inline | `@/lib/auth` | Handler compares `!session` (search, compare, discover, tutors, filters, tutor-profiles) or `!session?.user?.email` (home, leave requests, student schedule, us-universities) and returns `401 { "error": "Unauthorized" }`. |
| `requireProgressTestsSession` / `requireProgressTestsAdminSession` | `src/lib/progress-tests/api.ts:35-72` | Missing email/name → `Unauthorized`; `allowedPages` missing `/progress-tests` → `Forbidden`; JWT role `teacher` passes through as teacher, `admin`/absent → admin, anything else → `Forbidden` (fail-closed, never guess upward). The admin variant additionally rejects teachers (`api.ts:66-72`). |
| `requirePostClassCapability(cap)` | `src/lib/post-class-feedback/access.ts:153-176` | Missing email/name → `PostClassAccessError(401)`; an explicit non-admin JWT role (currently `teacher`) → `403`; missing the fresh Postgres capability grant → `403`. Capability ladder: `viewer < reviewer < finance < access_manager` (`access.ts:11-18`). Any action capability implies `viewer` (`normalizePostClassCapabilities`, `access.ts:61-72`). |
| `requireCompetitorIntelligenceSession` | `src/lib/competitor-intelligence/access.ts:19-30` | Missing email/name → `Unauthorized`; `hasCompetitorIntelligenceAccess(allowedPages, role)` false → `Forbidden`. That policy (`access-policy.ts:3-13`) denies any explicit non-admin role, allows a null/absent `allowedPages`, and otherwise requires a `/competitor-intelligence` prefix. |
| `requireStudentPromotionSession` | `src/lib/student-promotions/api.ts:9-15` | Missing email/name → `Unauthorized`. No further role gate; returns `{ email, name }` as the audit actor. |
| `requireAdmissionsSession` + `requireCaseAccess` / `requireCounselorOrAdmin` / `requireAdmissionsAdmin` | `src/lib/admissions/access.ts:76-248` | See [University admissions](#university-admissions). |

### Error mappers

| Mapper | Source | Mapping |
|---|---|---|
| `progressTestsErrorResponse` | `src/lib/progress-tests/api.ts:74-97` | `Unauthorized`→401, `Forbidden`→403, else `console.error` + 500 with `err.message`. Re-throws Next's `HANGING_PROMISE_REJECTION`. |
| `postClassFeedbackErrorResponse` | `src/lib/post-class-feedback/api.ts:12-54` | `PostClassAccessError`→its `.status`; `Unauthorized`→401; `Forbidden`→403; `PostClassValidationError`→400; `ZodError`→`400 { error, issues }`; `PostClassNotFoundError`→404; `PostClassConflictError`→409; anything else logs **only** the error name and returns the caller's generic fallback at 500 (deliberate — DB/HTTP errors can carry private feedback text, `api.ts:45-49`). |
| `competitorIntelligenceErrorResponse` | `src/lib/competitor-intelligence/access.ts:32-54` | `Unauthorized`→401, `Forbidden`→403, else 500 with `err.message`. |
| `studentPromotionErrorResponse` | `src/lib/student-promotions/api.ts:29-56` | `Unauthorized`→401; message matching `/not found/i`→404; message matching `/(required\|cannot\|only\|must be\|blocked\|no verified\|no pending\|before July 1)/i`→400; else 500. |
| `admissionsErrorResponse` | `src/lib/admissions/access.ts:256-287` | `Unauthorized`→401, `Forbidden`→403, `NotFound`→`404 { "error": "Not found" }`, `Conflict`→`409 { "error": "Conflict" }`, else `console.error(route, error)` + 500. |

All five mappers re-throw an object whose `digest === "HANGING_PROMISE_REJECTION"` so Next's own control-flow signal is not swallowed.

### Validation

Three styles coexist:

- **`safeParse` + explicit 400** — search, compare, admissions, student-schedule, tutor-profile, progress-tests and us-universities handlers. Body shape is usually `{ "error": "Invalid request", "details": <flattened> }`; admissions `cases`/`counselors`/`cohorts`, progress-tests and us-universities use the shorter `{ "error": <flattened> }`.
- **bare `schema.parse()` inside the `try`** — post-class-feedback and competitor-intelligence handlers, letting the mapper convert the `ZodError` to 400.
- **hand-rolled** — leave-request and student-promotion handlers, which swallow a JSON parse failure into `{}` and validate individual fields by hand.

### Snapshot metadata

Search and compare responses embed `snapshotMeta: { snapshotId, syncedAt, stale }` (`src/lib/search/types.ts:30-34`). `stale` is `Date.now() - syncedAt > API_STALE_THRESHOLD_MS` where the threshold is 90 minutes (`src/lib/ops/stale.ts:2`); when stale, `STALE_SEARCH_WARNING` is appended to `warnings[]` (`src/app/api/compare/route.ts:141-149`).

---

## Search

Three POST endpoints against the warm in-memory index. Source dir: `src/app/api/search/`.

### `POST /api/search/range`

The primary search: a time window plus a class duration, sliced into fixed sub-slots and returned as an availability grid.

- **Auth** — `auth()`; `401 { "error": "Unauthorized" }` with no session (`range/route.ts:7-10`).
- **Body** — Zod `rangeRequestSchema` (`src/lib/search/range-search.ts:16-37`):

  | Field | Type | Notes |
  |---|---|---|
  | `searchMode` | `"recurring" \| "one_time"` | required |
  | `dayOfWeek` | `number` 0–6 | optional (recurring) |
  | `date` | `string` | optional (one-time) |
  | `startTime` / `endTime` | `"HH:mm"` regex `^\d{2}:\d{2}$` | required |
  | `durationMinutes` | `"60" \| "90" \| "120"` (coerced) or literal `60 \| 90 \| 120` | required |
  | `mode` | `"online" \| "onsite" \| "either"` | required |
  | `filters` | `{ subject?, curriculum?, level? }` | optional |
  | `tutorGroupIds` | `string[]` | optional narrowing |

- **Extra 400** — after Zod, `generateSubSlots(startTime, endTime, durationMinutes)` must yield at least one slot; otherwise `400 { "error": "Time range is too short for the selected class duration" }` (`range/route.ts:30-36`).
- **Response** — `RangeSearchResponse` (`src/lib/search/types.ts:102-109`): `{ snapshotMeta, subSlots: {start,end}[], grid: RangeGridRow[], needsReview, latencyMs, warnings }`. Each `RangeGridRow` carries `tutorGroupId`, `tutorCanonicalKey`, `displayName`, `supportedModes`, `qualifications[]`, and `availability`, an array parallel to `subSlots` where `true` means available and a `BlockingSessionInfo[]` names what blocks it (`types.ts:93-100`).
- **Errors** — `400` invalid JSON (`{ "error": "Invalid JSON" }`), `400` Zod, `500 { "error": err.message ?? "Search failed" }`.

### `POST /api/search`

Legacy multi-slot search: intersect availability across an explicit slot list.

- **Auth** — `auth()`; `401` with no session (`search/route.ts:31-34`).
- **Body** — inline `searchRequestSchema` (`search/route.ts:8-28`): `searchMode`, `slots[]` (min 1; each `{ id, dayOfWeek?, date?, start, end, mode }` with `HH:mm` regexes and `mode: "online"|"onsite"|"either"`), optional `filters` and `rawInput`.
- **Behaviour** — `ensureIndex(db)` then `executeSearch(index, parsed.data)` (`search/route.ts:54-55`).
- **Response** — `SearchResponse` (`src/lib/search/types.ts:56-63`): `{ snapshotMeta, normalizedSlots, perSlotResults, intersection, latencyMs, warnings }`.
- **Errors** — `400` invalid JSON / Zod, `500 { "error": err.message ?? "Search failed" }`.

### `POST /api/search/assistant`

Natural-language scheduling assistant. Public at the middleware, session-gated in the handler.

- **Auth** — `auth()`; `401` with no session (`assistant/route.ts:136-139`).
- **Body** — `aiSchedulerRequestSchema` (`src/lib/ai/scheduler.ts:141-143`): `{ input: string }`, trimmed, 1–6000 chars, `.strict()`.
- **Config gate** — `503 { "error": "AI scheduler is not configured" }` when `isAiSchedulerConfigured()` is false (`assistant/route.ts:156-161`). Note the ordering: Zod runs *before* the config check.
- **Behaviour** — `executeSchedulerTurn` with a single admin message, then `responseFromSchedulerResult` maps to one of three statuses (`assistant/route.ts:101-133`):
  - `availability_summary` — parent-ready with a subject intent: `{ status, state, availabilitySummary, assistantMessage, parentMessageDraft, snapshotMeta, warnings }`.
  - `needs_clarification` — `{ status, partial, clarifyingQuestions[], warnings }` (a default question is substituted when the model returned none).
  - `solved` — `{ status, parsedRequest, options[], parentMessageDraft, snapshotMeta, warnings }`.
- **Side effects** — every turn writes a `logSchedulerRun` row (redacted input preview, model, latency breakdown, parsed + solver payloads) and the returned `logId` is merged into the response (`assistant/route.ts:176-188`).
- **Errors** — `400` invalid JSON / Zod; `502 { "error": "AI scheduling failed", detail, logId }` on any execution error, which also logs a `status: "failed"` run (`assistant/route.ts:189-209`).

---

## Compare

Source dir: `src/app/api/compare/`.

### `POST /api/compare`

Week-scoped side-by-side comparison of 1–3 tutors.

- **Auth** — `auth()`; `401` with no session (`compare/route.ts:113-116`).
- **Body** — `compareRequestSchema` (`compare/route.ts:24-31`): `tutorGroupIds` (1–3), `mode: "recurring"|"one_time"`, optional `dayOfWeek` (0–6), `date`, `weekStart` (ISO Monday), `fetchOnly` (subset of ids to serialize).
- **Stale-id resolution** — `resolveTutorGroupsForActiveSnapshot` maps requested ids onto the active snapshot, falling back to a `tutor_identity_groups` lookup by `canonicalKey` for UUID-shaped ids that no longer exist (`compare/route.ts:61-110`). When that fallback fires, `"Tutor selection was refreshed after the latest Wise sync"` is pushed onto `warnings`.
- **Week window** — `weekStart` or the current Bangkok Monday (`getCurrentMonday`, `route.ts:34-41`); `dateRange` spans Monday → Monday+7.
- **Historical merge (D-07 / PAST-01)** — when `dateRange.start` precedes the Bangkok start-of-today, `fetchPastSessionBlocks` loads captured `past_session_blocks` per canonical key and merges them into both `buildCompareTutor` and the groups fed to `findSharedFreeSlots` (`route.ts:185-221`), so a past captured session cannot read as free.
- **Response** — `CompareResponse`: `{ snapshotMeta, tutors, conflicts, sharedFreeSlots, weekStart, weekEnd, latencyMs, warnings }` (`route.ts:238-247`). With `fetchOnly`, conflicts and free slots are still computed over the full set but only the requested tutors are serialized (`route.ts:229-236`).
- **Errors** — `400` invalid JSON / Zod; `404 { "error": "No matching tutor groups found in active snapshot" }`; `500 { "error": err.message ?? "Compare failed" }`.

### `POST /api/compare/discover`

Rank candidate tutors to add to an in-progress comparison.

- **Auth** — `auth()`; `401` with no session (`discover/route.ts:30-33`).
- **Body** — `discoverRequestSchema` (`discover/route.ts:12-27`): `existingTutorGroupIds` (max 2), `mode`, optional `dayOfWeek`, `date`, `startTime`/`endTime` (`HH:mm`), `modeFilter`, `filters`.
- **Behaviour** — iterates every indexed group except the existing selection, applies modality and qualification filters, and (when weekday + both times are supplied) checks `hasAvailabilityWindow` / `hasBlockingSession` / `hasLeaveConflict` to decide whether the requested slot is free (`discover/route.ts:78-151`). Candidates are sorted data-issue-free first, then by ascending conflict count, then descending free-slot count (`route.ts:153-157`).
- **Response** — `DiscoverResponse`: `{ snapshotMeta, candidates: DiscoverCandidate[], latencyMs }`. Each candidate carries `tutorGroupId`, `displayName`, `supportedModes`, `qualifications`, `conflictCount`, `conflicts`, `freeSlots`, `hasDataIssues`, `dataIssueReasons` (`route.ts:140-150`).
- **Errors** — `400` invalid JSON / Zod; `500 { "error": err.message ?? "Discover failed" }`.

---

## Tutors and filters

### `GET /api/tutors`

- **Auth** — `auth()`; `401` with no session (`tutors/route.ts:6-9`).
- **Query** — none.
- **Response** — `{ tutors: TutorListItem[] }` where each item is `{ tutorGroupId, displayName, supportedModes, subjects }`, sorted by display name (`src/lib/data/tutors.ts:7-12,44-52`).
- **Caching** — `getTutorList()` is a `"use cache"` function tagged `snapshot` with `cacheLife("hours")` (`src/lib/data/tutors.ts:80-86`), so a successful sync's `revalidateTag("snapshot")` invalidates it.
- **Errors** — `500 { "error": err.message ?? "Failed to load tutors" }`.

### `GET /api/filters`

- **Auth** — `auth()`; `401` with no session (`filters/route.ts:6-9`).
- **Query** — none.
- **Response** — `FilterOptions` = `{ subjects, curriculums, levels }`, each a sorted deduped string array built from the active snapshot's `subject_level_qualifications` (`src/lib/data/filters.ts:7-11,19-35`).
- **Caching** — same `"use cache"` + `cacheTag("snapshot")` + `cacheLife("hours")` pattern (`filters.ts:52-58`).
- **Errors** — `500 { "error": err.message ?? "Failed to load filters" }`.

---

## Home summary

### `GET /api/home/summary`

- **Auth** — `auth()` with `session.user.email` required; `401` otherwise (`home/summary/route.ts:7-10`). This path is exempt from the `allowedPages` middleware filter (`src/middleware.ts:32`).
- **Query** — none. The handler passes the caller's `allowedPages` and email into the loader so tiles are scoped per user (`route.ts:13-16`).
- **Response** — `HomeSummaryPayload` = `{ generatedAt, actions: HomeActionSummary[], freshness: HomeFreshnessSummary }` (`src/lib/home/summary.ts:53-57`). Each source is loaded through `loadSource`, which converts a failure into `{ data: null, error }` rather than failing the whole payload (`summary.ts:68-74`).
- **Errors** — `500 { "error": err.message ?? "Home summary failed" }`.

---

## Data health

### `GET /api/data-health`

- **Auth** — `auth()`; `401` with no session (`data-health/route.ts:15-18`).
- **Query** — none.
- **Response** — `getDataHealthDashboardPayload()` (`src/lib/data-health/dashboard.ts:885`): last successful and last failed `sync_runs` rows, the active snapshot and its `snapshot_stats`, issue counts by type, and `issueDetails` split into `unresolvedAliases` / `unresolvedModality` / `unmappedTags` (`dashboard.ts:888-914`). Per-domain health rows are assembled from every subsystem's run tables plus the cron registry (`dashboard.ts:486-498`).
- **Note** — the route module also re-exports a `selectModalityIssues` helper for tests (`route.ts:6-12`); it is not part of the HTTP surface.
- **Errors** — `500 { "error": err.message ?? "Data health failed" }`.

### `POST /api/data-health/jobs/[jobKey]/run`

Manual "run now" for any registered cron job. `export const maxDuration = 800` (`run/route.ts:11`).

- **Auth** — `auth()` with `session.user.email`; `401` otherwise (`run/route.ts:14-17`). Jobs whose key starts with `post_class_feedback` additionally require the `access_manager` capability, else `403 { "error": "Access manager capability required" }` (`run/route.ts:25-30`).
- **Path param** — `jobKey`; an unknown key returns `404 { "error": "Unknown job" }` (`run/route.ts:20-23`).
- **Body** — optional `{ confirmed?: boolean }`; a malformed body is swallowed to `{}` (`run/route.ts:32`). Jobs flagged `dangerous` in the registry require `confirmed === true`, else `409 { "error": "Confirmation required", "confirmationLabel": … }` (`run/route.ts:33-41`).
- **Registry** — keys include `wise_snapshot`, `wise_activity`, `sales_dashboard`, `competitor_intelligence`, `credit_control`, `progress_tests`, `progress_tests_digest`, `post_class_feedback`, `post_class_feedback_backfill`, `post_class_feedback_digest`, `post_class_feedback_day_after`, `post_class_feedback_deadline`, `post_class_feedback_payout_accrual`, `leave_requests`, `classroom_morning`, `classroom_admin_email`, `student_promotions_july_1`, `admissions_notifications`, `cron_watchdog`, `room_utilization`, `line_backlog_recovery` (`src/lib/data-health/cron-registry.ts:48-370`). The `dangerous` flag is set on the digest/reminder/payout-accrual jobs, the classroom morning + admin-email jobs, `student_promotions_july_1`, and `admissions_notifications`.
- **Response** — whatever `runDataHealthJob` returns for that key, wrapped in `withCronInvocationAudit` with `triggerSource: "admin"` (`src/lib/data-health/run-job.ts:28-44`). Most branches return `{ ok: true, result }` at 200; a single-flight collision returns `409` with the guard's message; a failure returns `500 { "error": … }`.

---

## Admin

### `POST /api/admin/sync-wise`

Session-authenticated trigger for a full Wise snapshot sync. `export const maxDuration = 800` (`admin/sync-wise/route.ts:6`).

- **Auth** — `auth()`; `401` with no session (`route.ts:9-13`).
- **Body** — none read.
- **Behaviour** — `withCronInvocationAudit({ jobKey: "wise_snapshot", triggerSource: "admin", actorEmail, requestMethod: "POST" }, runWiseSyncRequest)` (`route.ts:15-23`). An exception inside the audited handler is converted to `500 { "error": message }` by the wrapper (`src/lib/data-health/cron-audit.ts:153-157`).
- **Responses** — `202` with the single-flight guard payload when a sync is already running; `200` with the full sync result plus `staleRunningSyncsFailed` on success; `500` with the same body shape on failure (`src/lib/sync/run-wise-sync.ts:142-167`).
- **Side effects** — on success, `revalidateTag("snapshot", { expire: 0 })` sweeps the cached data helpers (`run-wise-sync.ts:160-162`).

---

## Auth

### `GET /api/auth/[...nextauth]` · `POST /api/auth/[...nextauth]`

- **Auth** — public (`src/middleware.ts:7`).
- **Implementation** — the whole route is `export const { GET, POST } = handlers` re-exported from `@/lib/auth` (`auth/[...nextauth]/route.ts:1-3`); Auth.js owns sign-in, callback, session, CSRF, and sign-out sub-paths and their status codes.

---

## Tutor profiles

Editorial business context keyed by the stable `canonicalKey`. Source dir: `src/app/api/tutor-profiles/`.

All four handlers gate on a bare `auth()` and return `401 { "error": "Unauthorized" }` with no session.

### `GET /api/tutor-profiles`

- **Response** — `{ profiles: TutorBusinessProfile[] }` from `listTutorBusinessProfiles(getDb())` (`tutor-profiles/route.ts:12-13`).
- **Errors** — `500 { "error": err.message ?? "Failed to load tutor profiles" }`.

### `PATCH /api/tutor-profiles/[canonicalKey]`

- **Path param** — `canonicalKey`, URI-decoded before use (`[canonicalKey]/route.ts:13-16`).
- **Body** — `tutorBusinessProfilePatchSchema` (`src/lib/tutor-business-profiles.ts:36-55`), a `.strict()` all-optional patch: `displayName` (≤160), `parentSafeSummary` (≤1200), `internalNotes` (≤3000), `education[]` (≤12), `languages[]` (≤12), `englishProficiency`, `youngLearnerFit`, `youngestComfortableAge` (3–20, nullable), `youngLearnerNotes` (≤2000), `teachingStyleTags[]`/`strengthTags[]`/`curriculumExperience[]` (≤30 entries, ≤80 chars each), `teachingStyleNotes`, `studentFitNotes`, `doNotUseForNotes` (≤2000), `verifiedBy` (≤160, nullable), `lastReviewedAt` (ISO datetime, nullable), `active`.
- **Existence gate** — the canonical key must resolve to a display name in the **active snapshot**, else `404 { "error": "Tutor not found in active snapshot" }` (`route.ts:44-47`).
- **Side effects** — `upsertTutorBusinessProfile` then `clearSearchIndex()` so the in-memory index picks up the new profile version (`route.ts:50-51`).
- **Response** — `{ profile }`. **Errors** — `400` invalid JSON / Zod, `404` unknown key, `500 { "error": err.message ?? "Failed to save tutor profile" }`.

### `POST /api/tutor-profiles/import-preview`

- **Body** — `multipart/form-data`, not JSON. A non-multipart request returns `400 { "error": "Expected multipart form data" }` (`import-preview/route.ts:31-36`). Recognised parts: `educationFile`, `availabilityFile` (workbooks; zero-byte files are ignored), plus optional text fields `verifiedBy` and `lastReviewedAt`.
- **Extra 400** — at least one workbook is required: `{ "error": "Upload at least one tutor profile workbook" }` (`route.ts:48-50`).
- **Behaviour** — parses both workbooks, then diffs them against the live profiles, active identities and alias table to produce a preview (`route.ts:52-64`). No writes.
- **Response** — the preview object from `buildTutorProfileImportPreview`. **Errors** — `500 { "error": err.message ?? "Failed to preview tutor profile import" }`.

### `POST /api/tutor-profiles/import-commit`

- **Body** — `importCommitSchema` (`import-commit/route.ts:12-17`), `.strict()`: `{ rows: Array<{ canonicalKey: string, patch: TutorBusinessProfilePatch }> }`, 1–200 rows.
- **Behaviour** — rows whose `canonicalKey` is absent from the active profile set are skipped rather than failing the batch; the rest are upserted (`route.ts:47-59`). `clearSearchIndex()` fires only when at least one row saved (`route.ts:61`).
- **Response** — `{ savedCount, skipped: [{ canonicalKey, reason }], profiles }`.
- **Errors** — `400` invalid JSON / Zod, `500 { "error": err.message ?? "Failed to commit tutor profile import" }`.

---

## Leave requests

Tutor leave-form triage. Source dir: `src/app/api/leave-requests/`. Every handler gates on `auth()` with `session.user.email` and returns `401` otherwise. Validation here is hand-rolled, not Zod.

### `GET /api/leave-requests`

- **Query** — `status`, `q`, `startDate`, `endDate`, `summaryOnly` (`"true"` exactly) (`route.ts:15-21`).
- **Response** — `listLeaveRequests` output spread with `googleSheets` appended: `{ cards: { total, new, needsReview, sheetWriteFailed, affectedClasses }, unreadActionCount, timeline, requests, googleSheets }` (`src/lib/leave-requests/data.ts:232-251`, `route.ts:23`). `summaryOnly` caps the query at 200 rows and returns `requests: []`; otherwise the cap is 500 (`data.ts:230`).
- **Errors** — `500 { "error": err.message ?? "Leave request query failed" }`.

### `GET /api/leave-requests/[requestId]`

- **Response** — the detail object from `getLeaveRequestDetail`; a missing row returns `404 { "error": "Not found" }` (`[requestId]/route.ts:21-23`).
- **Note** — this handler has no try/catch, so a loader throw surfaces as an unhandled 500 from the framework.

### `PATCH /api/leave-requests/[requestId]`

- **Body** — hand-parsed (`[requestId]/route.ts:33-43`). A JSON parse failure degrades to `{}` rather than 400. Fields:
  - `workflowStatus` — must be one of `new`, `needs_review`, `in_progress`, `done`, `ignored`, `canceled_by_tutor` (`src/lib/leave-requests/data.ts:9-16`), else `400 { "error": "Invalid workflow status" }`.
  - `staffNote` — string or explicit `null`; omitted means "leave unchanged".
  - `sheetStatusText` — presence-checked with `hasOwnProperty`, so an explicit `null` clears it while omission is a no-op (`route.ts:57-59`).
  - `retrySheetWrite` — strict `=== true`.
- **Side effects** — resolves the caller's connected Google account (failure degrades to `null`) and may write the status cell back to the source sheet (`route.ts:46-51`).
- **Response** — `{ ok: true, ...result }`; a missing row returns `404 { "error": "Not found" }`.
- **Errors** — `500 { "error": err.message ?? "Leave request update failed" }`.

### `POST /api/leave-requests/[requestId]/wise-cancel-preview`

- **Body** — `{ affectedSessionIds?: string[] }`; non-string entries are filtered out and a bad body degrades to an empty list (`wise-cancel-preview/route.ts:14-23`).
- **Behaviour** — `createWiseCancelPreview` builds a dry-run cancellation preview; nothing is written to Wise.
- **Response** — `{ ok: true, detail }`.
- **Errors** — every failure maps to `400 { "error": err.message ?? "Wise cancel preview failed" }` (`route.ts:33-36`) — this route has no 500 branch.

### `POST /api/leave-requests/sync`

`export const maxDuration = 800` (`sync/route.ts:6`).

- **Body** — optional `{ connectedEmail?: string }`; a bad body degrades to `{}` (`route.ts:14-20`).
- **Behaviour** — `syncLeaveRequests(db, { triggerType: "manual", actorEmail, actorName, connectedEmail })`.
- **Response** — `{ ok: true, result }`.
- **Errors** — `409 { "error": … }` on `LeaveRequestSyncAlreadyRunningError` (single-flight guard); otherwise `500 { "error": err.message ?? "Leave request sync failed" }`.

---

## Student schedule

Monthly parent-facing schedule plus its tokenized share link. Both handlers gate on `auth()` with `session.user.email` and return `401` otherwise. (The *public* `/schedule/{token}` page is a page route, not an API endpoint, and is allowlisted separately at `src/middleware.ts:15`.)

### `GET /api/student-schedule`

- **Query** — `querySchema` (`student-schedule/route.ts:8-11`): `studentKey` (non-empty) and `month` matching `^\d{4}-\d{2}$` (`"month must be YYYY-MM"`).
- **Response** — `StudentSchedulePayload` (`src/lib/student-schedule/types.ts:42-51`): `{ student: { studentKey, wiseStudentId, studentName, parentName, code, shortName }, monthKey, monthLabel, sessions[], generatedAt }`. Every session carries precomputed Bangkok display strings (`dateKey`, `startLabel`, `endLabel`) so no client re-derives a date, and an unresolved teacher renders as the `TEACHER_TBC` constant rather than a blank (`types.ts:9-29`).
- **Errors** — `400 { "error": "Invalid query", details }`; `404 { "error": "Student not found" }` when the key does not resolve on the active snapshot; `500 { "error": err.message ?? "Failed to load schedule" }`.

### `POST /api/student-schedule/link`

- **Body** — `bodySchema` (`link/route.ts:13-16`): `{ studentKey, month }`, same `YYYY-MM` regex.
- **Behaviour** — the schedule is resolved first so a token can never be minted for an arbitrary key (`link/route.ts:46-53`); TTL comes from `STUDENT_SCHEDULE_LINK_TTL_DAYS` or the 30-day default (`src/lib/student-schedule/links.ts:27`). The link base is `APP_BASE_URL` when set, else the request origin (`link/route.ts:18-20`).
- **Response** — `{ url, expiresAt, sessionCount }`.
- **Errors** — `400 { "error": "Invalid JSON body" }` / `400 { "error": "Invalid body", details }`; `404 { "error": "Student not found" }`; `500 { "error": err.message ?? "Failed to create link" }`.

---

## Progress tests

Every-N-classes progress-test tracker. Source dir: `src/app/api/progress-tests/`. The read endpoint accepts teachers; **all five mutations require an admin session** via `requireProgressTestsAdminSession`, so a teacher gets `403` before any write (`src/lib/progress-tests/api.ts:66-72`).

### `GET /api/progress-tests`

- **Auth** — `requireProgressTestsSession()` (admin or teacher).
- **Scoping** — a teacher's canonical-key set is resolved fresh per request via `resolveTeacherCanonicalKeys` (covering their online + onsite identities) and passed as `teacherCanonicalKeys`; an admin passes `null` and sees every enrollment (`route.ts:11-13`).
- **Response** — `ProgressTestsPayload` = `{ rows, summary, subjects, lastSyncedAt, generatedAt }` (`src/lib/progress-tests/types.ts:90-96`).
- **Errors** — mapped by `progressTestsErrorResponse`: 401 / 403 / 500.

### `POST /api/progress-tests/book`

- **Auth** — `requireProgressTestsAdminSession()`.
- **Body** — `BookProgressTestSchema` (`book/route.ts:6-13`): `enrollmentKey` (non-empty), `testDate` (ISO datetime), optional `location`, optional `modality: "online"|"offline"`, `scheduleMethod: "after_class"|"parent_pick"` defaulting to `parent_pick`. `after_class` records that the admin clicked a recommended slot.
- **Note** — `modality` is accepted by the schema but is not forwarded to `bookTest` (`book/route.ts:31-37`).
- **Response** — the `bookTest` result; `404 { "error": "Enrollment not found" }` when `result.row` is null.
- **Errors** — `400 { "error": "Invalid JSON body" }` / `400 { "error": <flattened> }`; then the shared mapper.

### `POST /api/progress-tests/mark-complete` · `POST /api/progress-tests/select-at-home` · `POST /api/progress-tests/mark-at-home-submitted` · `POST /api/progress-tests/resend-email`

Four structurally identical handlers.

- **Auth** — `requireProgressTestsAdminSession()`.
- **Body** — `{ enrollmentKey: string }` (min length 1) in each file (`mark-complete/route.ts:6-8`, `select-at-home/route.ts:6-8`, `mark-at-home-submitted/route.ts:6-8`, `resend-email/route.ts:6-8`).
- **Service call** — `markComplete` / `selectAtHome` / `submitAtHome` / `resendTeacherEmail`, each with `{ enrollmentKey, actor }`.
- **Response** — `{ row }` for the first three; `resend-email` returns the full result object and checks `result.row` for existence (`resend-email/route.ts:26-31`). `resend-email` sends a teacher email as its side effect.
- **Errors** — `400` invalid JSON / Zod; `404 { "error": "Enrollment not found" }` when the enrollment does not resolve; then the shared mapper.

---

## Post-class feedback

Source dir: `src/app/api/post-class-feedback/`. Every handler calls `requirePostClassCapability(<cap>)` and routes failures through `postClassFeedbackErrorResponse`, so `401`/`403`/`400`/`404`/`409`/`500` all come from that mapper. Bodies use bare `.parse()`, so a schema violation arrives as `400 { "error": "The request payload is invalid.", "issues": [...] }`.

### `GET /api/post-class-feedback` — cap `viewer`

- **Query** — `startDate` and `endDate`; each defaults to the current Bangkok month via `defaultPostClassFeedbackRange()` (`route.ts:13-17`, `src/lib/post-class-feedback/dashboard.ts:86-89`).
- **Behaviour** — the loader validates both dates, rejects `start > end` with a `PostClassValidationError` → 400, and shapes the payload by the caller's capabilities (`canReview` / `canFinance` / `canManageAccess`) before assembling sessions, mappings, sync runs, open source issues, digest recipients, access grants, tutor contacts, finance periods and three audit slices (`dashboard.ts:118-175`). Trend granularity switches from week to month past a 120-day window.

### `GET /api/post-class-feedback/sessions/[sessionId]` — cap `viewer`

- **Path param** — `sessionId`.
- **Response** — `getPostClassFeedbackSessionDetail(sessionId, user)` — the per-session feedback history, capability-shaped (`sessions/[sessionId]/route.ts:13-16`).

### `POST /api/post-class-feedback/review` — cap `reviewer`

- **Body** — `review/route.ts:11-18`: `deductionId` (uuid), `action: "approve"|"waive"|"reopen"`, `note` (≤2000, default `""`), optional `waiverCategory` from `POST_CLASS_WAIVER_CATEGORIES`, `expectedVersion` (positive int), `idempotencyKey` (1–250).
- **Response** — `{ ok: true, deduction }`. A version mismatch surfaces as `409` via `PostClassConflictError`.

### `POST /api/post-class-feedback/ai-review` — cap `reviewer`

- **Body** — `ai-review/route.ts:8-14`: `concernId` (uuid), `action: "confirm"|"dismiss"`, `note` (trimmed, 1–2000 — required), `expectedVersion` (positive int), `idempotencyKey` (1–250).
- **Response** — `{ ok: true, result }`.

### `POST /api/post-class-feedback/finance` — cap `finance`

- **Body** — discriminated union on `action` (`finance/route.ts:8-34`). All variants carry `deductionId` (uuid), `processingMonth` (`YYYY-MM`), `expectedVersion` (positive int), `idempotencyKey` (1–250).

  | `action` | `referenceNote` | `reason` |
  |---|---|---|
  | `move` | optional, ≤2000, defaults `""` | optional |
  | `process` | required, 1–2000 | optional |
  | `reverse` | required, 1–2000 | **required**, 1–2000 |

- **Response** — `{ ok: true, deduction }`.

### `POST /api/post-class-feedback/finance-periods` — cap `finance`

- **Body** — discriminated union (`finance-periods/route.ts:9-23`): `{ month, action: "open", reason?, idempotencyKey }` or `{ month, action: "close"|"reopen", reason?, expectedVersion, idempotencyKey? }`. `month` matches `^\d{4}-(0[1-9]|1[0-2])$`.
- **Response** — `{ ok: true, period }`.

### `POST /api/post-class-feedback/payout-runs` — cap `finance`

`export const maxDuration = 800`, sized above the ten-minute Google row-write budget (`payout-runs/route.ts:18-20`).

- **Body** — `.strict()` discriminated union (`payout-runs/route.ts:28-61`):
  - `preview` — `{ anchorMonth, tutorFilter? }`.
  - `publish` — `{ anchorMonth, expectedVersion ≥1, previewToken (16–500), tutorFilter?, acknowledgements: { confirmed: true, reason (10–1000), pendingReviewDeductions: int ≥0, nonReadySessions: int ≥0 } }`. The counts must echo the exact preview — they are never accepted as booleans, so a stale tab cannot acknowledge a set that has grown (`route.ts:43-46`).
  - `retry_csv` — `{ anchorMonth, expectedVersion }`.
  - `resolve_exception` — `{ exceptionId (uuid), expectedVersion, note (10–1000), externalReference (1–500) }`.
- **Response** — `{ ok: true, ...view, writeCapability }` for the run actions, `{ ok: true, exception, writeCapability }` for `resolve_exception`. `writeCapability` is `{ enabled, target: "scratch"|"production"|null, reason }` and is a read-only projection for the UI — publish and retry independently re-resolve the target with `forWrite: true` (`route.ts:69-95`).
- **Side effects** — `publish` and `retry_csv` write payout rows to the configured Google target under a durable lease.

### `POST /api/post-class-feedback/sync` — cap `access_manager`

`export const maxDuration = 800` (`sync/route.ts:10`).

- **Body** — optional and `.strict()` with `.default({})`; a missing/unparseable body is treated as `{}` (`sync/route.ts:18-33`). Fields: `detailCap` (int 1–400), `startDate`/`endDate` (calendar-validated `YYYY-MM-DD`). Two refinements: the dates must be supplied together, and `startDate <= endDate`. `detailCap` above 50 is honoured only for an explicit start/end backfill window — every other trigger is clamped back to 50 by the sync service.
- **Behaviour** — runs the sync, then fires AI review and due notification retries via `Promise.allSettled` so neither can fail the request (`route.ts:41-44`).
- **Response** — `{ ok: true, result, ai, retries }`, where `ai`/`retries` degrade to `{ failed: true }` on rejection.

### `POST /api/post-class-feedback/shadow-review` — cap `access_manager`

- **Body** — `shadow-review/route.ts:20-29`: `expectedVersion` (positive int), optional `acknowledgeSessionIssues` (non-negative int — the exact count the operator was shown), optional `reason`.
- **Preconditions** — enforcement must currently be in `shadow` mode, the settings version must match `expectedVersion` (else `409`), and at least one active field mapping must exist (`route.ts:36-53`).
- **Behaviour** — gathers the last 20 successful sync runs, open blocking global source issues, and a 4-day rolling session-readiness window, then `classifyPostClassShadowReviewEvidence` returns a verdict. A non-ready verdict throws a `PostClassValidationError` naming the failed conditions, and when acknowledgement is possible it states the exact count required (`route.ts:84-97`).
- **Response** — `{ ok: true, settings, evidenceSyncRunId, conditions }`.

### `PATCH /api/post-class-feedback/settings` — cap `access_manager`

- **Body** — `settings/route.ts:8-19`: optional `mode: "shadow"|"live"|"paused"`, optional nullable `effectiveAt`, optional `mapping: { topics?, performance?, improvement?, homework? }` (each nullable), optional `digestRecipientEmails` (≤100 emails), required `expectedVersion` (positive int).
- **Response** — `{ ok: true, settings }`.

### `PATCH /api/post-class-feedback/access` — cap `access_manager`

- **Body** — `access/route.ts:13-19`: `email`, `capability` (one of `viewer`/`reviewer`/`finance`/`access_manager`), `enabled` (bool), `expectedVersion` (non-negative int), optional `note` (≤2000).
- **Behaviour** — reads the target's current capability set, adds or removes the one capability, and calls `replacePostClassCapabilities` with the whole resulting set under the optimistic version (`route.ts:26-37`). The target email is lowercased.
- **Response** — `{ ok: true, capabilities }`.

### `PATCH /api/post-class-feedback/tutor-emails` — cap `access_manager`

- **Body** — `tutor-emails/route.ts:12-16`: `tutorKey` (1–250), `primaryEmail` (email or `null`), `expectedVersion` (non-negative int).
- **Concurrency** — `expectedVersion` is the existing `tutor_contacts.updatedAt` in whole seconds; a mismatch throws `PostClassConflictError` → 409, and a first-time write must send `expectedVersion: 0` (`route.ts:23-30`).
- **Response** — `{ ok: true, tutor }`.

### `POST /api/post-class-feedback/test-email` — cap `access_manager`

- **Body** — `{ recipientEmail: string }` (email-validated) (`test-email/route.ts:8`).
- **Side effect** — sends a real test email to that address.
- **Response** — the `sendPostClassTestEmail` result object (returned unwrapped).

---

## Competitor intelligence

Source dir: `src/app/api/competitor-intelligence/`. Every handler calls `requireCompetitorIntelligenceSession()` and maps failures through `competitorIntelligenceErrorResponse` (401 / 403 / 500). Bodies use bare `.parse()`, so a `ZodError` escapes to the mapper's 500 branch with the Zod message — this family has **no dedicated 400 mapping**.

### `GET /api/competitor-intelligence`

- **Response** — `CompetitorDashboardPayload` (`src/lib/competitor-intelligence/types.ts:124+`): `{ checkedAt, weeklyWarRoom, competitorMatrix, contentAngles, scoreDrilldowns, brief, … }`, assembled from entities, sources, the latest brief, the 80 most recent evidence items, SERP keywords, observations, task suggestions, tasks, runs, usage and asset counts (`data.ts:224-254`).

### `POST /api/competitor-intelligence/sync`

`export const maxDuration = 800` (`sync/route.ts:8`).

- **Body** — none read.
- **Behaviour** — `runCompetitorIntelligenceSync({ triggerType: "manual", actorEmail })`.
- **Response** — `{ ok, result }`, with HTTP status `200` when `result.status === "success"` and `500` otherwise (`route.ts:17-19`) — note `ok` can be `false` inside a 500 body.
- **Errors** — an error whose message contains `"already running"` returns `409 { "error": … }` (`route.ts:21-23`); everything else goes to the mapper.

### `POST /api/competitor-intelligence/manual-evidence`

- **Body** — `ManualEvidenceSchema` (`manual-evidence/route.ts:9-15`): `entityId` (uuid), `title` (2–180), `contentText` (2–5000), optional nullable `canonicalUrl` (URL), optional `pricingSignal` (bool).
- **Response** — `{ evidence }`.

### `GET /api/competitor-intelligence/own-sources`

- **Response** — `{ sources }` from `listOwnBrandSources()`.

### `POST /api/competitor-intelligence/own-sources`

- **Body** — `OwnSourceSchema` (`own-sources/route.ts:9-15`): `sourceType: "website"|"instagram"|"facebook"`, `label` (1–120), `url` (URL), optional nullable `handle` (≤120), optional `status: "active"|"disabled"|"needs_review"|"archived"`.
- **Response** — `{ source }` with HTTP **201** (`route.ts:32`).

### `PATCH /api/competitor-intelligence/own-sources/[sourceId]`

- **Body** — the same shape as the POST (`own-sources/[sourceId]/route.ts:9-15`).
- **Behaviour** — `status: "disabled"` routes to `disableOwnBrandSource(sourceId, …)`; every other status upserts with `{ ...input, id: sourceId }` (`route.ts:24-26`).
- **Response** — `{ source }`.

### `PATCH /api/competitor-intelligence/sources/[sourceId]`

- **Body** — `{ status: "active"|"disabled"|"needs_review"|"archived" }` (`sources/[sourceId]/route.ts:9-11`).
- **Response** — `{ source }` from `updateCompetitorSourceStatus`.

### `PATCH /api/competitor-intelligence/tasks/[taskId]`

- **Body** — all-optional patch (`tasks/[taskId]/route.ts:9-15`): `status: "todo"|"in_progress"|"blocked"|"done"|"ignored"`, nullable `ownerEmail` (email), `priority: "low"|"medium"|"high"`, nullable `dueDate` (`YYYY-MM-DD`), `labels` (≤8 entries, each 1–40 chars).
- **Response** — `{ task }`.

### `POST /api/competitor-intelligence/task-suggestions/[suggestionId]/accept`

- **Body** — none read.
- **Behaviour** — `acceptCompetitorTaskSuggestion(suggestionId, user.email)` promotes a suggestion into a real task.
- **Response** — `{ task }`.

---

## Student promotions

Annual July-1 grade/course promotion audit → verify → apply pipeline. Source dir: `src/app/api/student-promotions/`. Every handler calls `requireStudentPromotionSession()` (401 with no session) and maps errors through `studentPromotionErrorResponse`, whose message-regex branches produce most of the 400s and 404s listed below. Bodies are hand-parsed with `await request.json().catch(() => ({}))`.

### `GET /api/student-promotions/runs`

`export const maxDuration = 800` applies to the whole module (`runs/route.ts:5`).

- **Response** — `{ detail }` from `getLatestStudentPromotionRunDetail()`.

### `POST /api/student-promotions/runs`

- **Body** — none read.
- **Behaviour** — `createStudentPromotionDryRun({ actor })`: a dry run only, no Wise writes.
- **Response** — `{ detail }` with HTTP **201** (`runs/route.ts:19`).

### `GET /api/student-promotions/runs/[runId]`

- **Path param** — `runId`, validated by `requireStudentPromotionRunId`; a missing/blank value throws `"Student promotion run id is required"` → 400 via the mapper's `/required/i` branch (`src/lib/student-promotions/api.ts:17-27`).
- **Response** — `{ detail }`.

### `POST /api/student-promotions/runs/[runId]/verify`

- **Body** — `{ endpointVerificationConfirmed: true, endpointVerificationNote?: string }`. Anything other than a strict `true` returns `400 { "error": "Endpoint verification confirmation is required" }` (`verify/route.ts:18-25`); a non-string note degrades to `""`.
- **Response** — `{ detail }`.

### `POST /api/student-promotions/runs/[runId]/apply`

`export const maxDuration = 800` (`apply/route.ts:10`).

- **Body** — `{ confirm: "apply-student-promotions" }` exactly; otherwise `400 { "error": "Apply confirmation is required" }` (`apply/route.ts:20-22`).
- **Side effects** — `applyVerifiedStudentPromotionRun({ runId, actor, trigger: "admin" })` performs the real Wise grade/course writes for a previously verified run.
- **Response** — `{ detail }`.

### `POST /api/student-promotions/runs/[runId]/future-sessions/apply`

`export const maxDuration = 800` (`future-sessions/apply/route.ts:13`).

- **Body** — `{ confirm: WISE_SESSION_SUBJECT_UPDATE_CONFIRMATION }`; a mismatch returns `400 { "error": "Future session subject apply confirmation is required" }` (`route.ts:23-25`). The expected literal is exported from `src/lib/student-promotions/data.ts`.
- **Side effects** — applies subject updates to future Wise sessions.
- **Response** — `{ detail }`.

### `POST /api/student-promotions/runs/[runId]/readback`

`export const maxDuration = 800` (`readback/route.ts:10`).

- **Body** — none read.
- **Behaviour** — `runStudentPromotionReadback({ runId })` re-reads Wise to confirm what was applied.
- **Response** — `{ readback }` (note: not `{ detail }`).

### `PATCH /api/student-promotions/runs/[runId]/graduation-actions/[actionId]`

`export const maxDuration = 800` (`graduation-actions/[actionId]/route.ts:34`).

- **Path params** — `runId` and `actionId`; a blank/absent `actionId` throws `"Graduation action id is required"` → 400 (`route.ts:17-27`).
- **Body** — `{ disposition: "inactive" | "university" }`; anything else throws `"Graduation disposition must be inactive or university"` → 400 via the mapper's `/must be/i` branch (`route.ts:29-32`).
- **Response** — `{ detail }`.

### `PATCH /api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review`

- **Path params** — `runId` and `impactId`; a blank/absent `impactId` throws `"Pay-rate impact id is required"` → 400 (`review/route.ts:17-27`).
- **Body** — `{ status: "verified_correct" | "incorrect", note?: string }`; an invalid status throws `"Pay-rate review status must be verified_correct or incorrect"` → 400. A non-string `note` becomes `null` (`route.ts:43-44`).
- **Response** — `{ detail }`.

---

## US universities

Read-only IPEDS reference surface. Source dir: `src/app/api/us-universities/`. Every handler gates on `auth()` with `session.user.email` (`401` otherwise) and returns `400 { "error": <flattened Zod> }` on a bad query. All five data functions are `"use cache"` with `cacheTag(US_UNIVERSITIES_CACHE_TAG)` and `cacheLife({ stale: 300, revalidate: 600, expire: 3600 })` (`src/lib/us-universities/data.ts:366-413`).

### `GET /api/us-universities`

- **Query** — none.
- **Response** — `UsUniversitiesOverview` (`src/lib/us-universities/types.ts:123-135`): `{ dataYear, totalInstitutions, withAcceptanceRate, avgAcceptanceRate, states, controls, acceptanceBuckets, scatter, cip2Options, acceptanceTrend, lastImportedAt }`.
- **Errors** — `500 { "error": err.message ?? "Failed to load overview" }`.

### `GET /api/us-universities/search`

- **Query** — `FilterQuerySchema` (`src/lib/us-universities/request.ts:12-25`): `search`, `states` (CSV), `control` (CSV of ints), `minAcceptance`, `maxAcceptance`, `maxNetPrice`, `minGradRate`, `cip2`, `sort`, `dir: "asc"|"desc"`, `page`, `pageSize`. Numerics use `z.coerce`; `page`/`pageSize` must be positive ints.
- **Response** — `InstitutionListResult` = `{ rows, total, page, pageSize }` (`types.ts:82-87`).
- **Errors** — `500 { "error": err.message ?? "Failed to search institutions" }`.

### `GET /api/us-universities/compare`

- **Query** — `{ ids: string }`, required and non-empty (`compare/route.ts:7`). The value is split on commas, parsed as integers, non-finite entries dropped, and truncated to `MAX_COMPARE = 4` (`route.ts:21-25`, `src/lib/us-universities/constants.ts:177`).
- **Extra 400** — an ids string that yields no valid numbers returns `{ "error": "No valid institution ids" }` (`route.ts:27-29`).
- **Response** — `{ institutions: CompareInstitution[] }`.
- **Errors** — `500 { "error": err.message ?? "Failed to compare institutions" }`.

### `GET /api/us-universities/export`

- **Query** — the same `FilterQuerySchema` as `/search`.
- **Response** — **not JSON**: a CSV body with `Content-Type: text/csv;charset=utf-8` and `Content-Disposition: attachment; filename="us-universities.csv"` (`export/route.ts:26-32`).
- **Errors** — `400` Zod; `500 { "error": err.message ?? "Failed to export institutions" }` (JSON).

### `GET /api/us-universities/institutions/[unitId]`

- **Path param** — `unitId`, coerced to a positive int; a non-numeric segment is a `400` (`institutions/[unitId]/route.ts:6,17-20`).
- **Response** — `InstitutionProfile`; a null profile returns `404 { "error": "Institution not found" }`.
- **Errors** — `500 { "error": err.message ?? "Failed to load institution" }`.

---

## University admissions

61 endpoints under `/api/admissions`. This is the one family on this page that is **not admin-only**: `requireAdmissionsSession` establishes the session and its role, then per-request rights are re-resolved from Postgres.

### Guards

| Guard | Source | Behaviour |
|---|---|---|
| `requireAdmissionsSession()` | `access.ts:76-97` | Missing email/name → `Unauthorized`; no `/admissions` page access → `Forbidden`; JWT role `counselor`/`student`/`parent` passes through; `admin` or an absent role → `admin`; anything else → `Forbidden`. The JWT role shapes nav only — never rights. |
| `requireCaseAccess(email, caseId, minRole)` | `access.ts:117-172` | A malformed `caseId` is `Forbidden` **before** any DB hit. An `admin_users` row bypasses membership (a missing/soft-deleted case → `NotFound`). A non-admin gets `Forbidden` for a missing case — never `NotFound`, so existence does not leak. Otherwise an **active** `admissions_case_members` row is required; a `counselor` membership additionally needs an **active** `admissions_counselors` registry row. Finally `roleAtLeast(role, minRole)` under `parent < student < counselor < admin`. |
| `requireCounselorOrAdmin(email)` | `access.ts:196-219` | `admin_users` row → admin; else an **active** registry row → counselor; else `Forbidden`. Used on cross-case surfaces that have no single `caseId`. |
| `requireAdmissionsAdmin(email)` | `access.ts:234-248` | Requires an `admin_users` row; even an active registry counselor is `Forbidden`. |

Every handler wraps its body in `try/catch` and returns `admissionsErrorResponse(ROUTE, error, <fallback>)`: `Unauthorized`→401, `Forbidden`→403, `NotFound`→404, `Conflict`→409, else 500.

Two structural conventions hold across the family:

- **Guards run before body parsing.** Membership/role failures never depend on the request body, so a non-member cannot probe schema behaviour.
- **`DELETE` takes a query param, not a body**, and is always a *soft* delete — the row is retained for the audit trail.

Optimistic concurrency, where offered, is an `expectedUpdatedAt` ISO datetime; a stale token is a `409`.

### Case detail and caseload

#### `GET /api/admissions/cases`
Min role: **counselor** (via `requireCounselorOrAdmin`). Students and parents 403 — the caseload is a staff surface. Per-user scoping (admin = all cases, counselor = own active memberships) lives in `getCaseloadForUser`. Response `{ cases }` (`cases/route.ts:49-63`).

#### `POST /api/admissions/cases`
Min role: **counselor**. Body `CreateCaseSchema` (`cases/route.ts:21-47`): `student { fullName, preferredName?, studentEmail (email), phone?, school?, schoolCounselor?, wiseStudentKey? }`, `cohortId` (uuid), `parentEmails` (≤20 emails, default `[]`), `counselorEmails` (1–20 emails). A `superRefine` rejects a parent email equal to the student email; `createCase` re-checks as the backstop (`Conflict` → 409). Response is the `createCase` result. Errors: `400 { "error": "Invalid JSON body" }` / `400 { "error": <flattened> }`.

#### `GET /api/admissions/cases/[caseId]`
`requireCaseAccess(..., "parent")`, but a resolved `parent` role is then rejected with `403 { "error": "Use parent dashboard" }` (`[caseId]/route.ts:58-62`) — the full detail DTO is a staff/student view. Response `{ case }`.

#### `PATCH /api/admissions/cases/[caseId]`
Min role: **counselor**. Body `UpdateCaseSchema` (`[caseId]/route.ts:28-52`): optional `status` (`active|committed|completed|withdrawn|archived`), nullable `driveFolder`, `student { fullName?, preferredName?, phone?, school?, schoolCounselor?, wiseStudentKey? }`, `expectedUpdatedAt`. A refine requires at least one of `status`/`driveFolder`/`student`. When `expectedUpdatedAt` mismatches the current value the handler returns `409 { "error": "Conflict", expectedUpdatedAt, currentUpdatedAt }` (`route.ts:92-105`). Profile fields are written first, then the lifecycle transition. Response `{ case }` (re-read).

### Members

#### `GET /api/admissions/cases/[caseId]/members`
Min role: **counselor**. Returns `{ members }` from `getCaseDetail` — every status (invited/active/revoked/bounced), oldest first (`members/route.ts:61-64`).

#### `POST /api/admissions/cases/[caseId]/members`
Min role: **counselor**. Body `AddMemberSchema` (`members/route.ts:32-36`): `email`, `role: "parent"|"counselor"` (a case's single student membership is created with the case), optional `adminOverride`. `adminOverride` is honoured only for an admin session (`route.ts:92`). For `role: "parent"` the handler first runs `rejectStudentAsParent` — the student-as-parent escape hatch. Response `{ member }`.

#### `PATCH /api/admissions/cases/[caseId]/members`
Min role: **counselor**. Body `MemberActionSchema`, a discriminated union on `action` (`members/route.ts:38-53`): `revoke { memberId }`, `reinvite { memberId }`, `change_email { memberId, newEmail, adminOverride? }`. Again `adminOverride` requires an admin session. Response `{ member }`.

### Checklist tasks

#### `GET /api/admissions/cases/[caseId]/tasks`
Min role: **student** (parents 403 — they see the projection instead). Response `{ tasks, progress }` (`tasks/route.ts:110-112`).

#### `POST /api/admissions/cases/[caseId]/tasks`
Min role: **counselor**. Body `createTaskSchema` (`tasks/route.ts:62-70`): `title`, `description?`, `owner: "student"|"counselor"|"parent"`, optional `phase` (the 10 checklist phases plus `custom`), `dueDate?` (`YYYY-MM-DD`), `recurrence?` (`{ freq: "weekly"|"biweekly", until: "YYYY-MM-DD" }`, `src/lib/admissions/checklists.ts:81-84`), `sortOrder?`. Response `{ task }`.

#### `PATCH /api/admissions/cases/[caseId]/tasks`
Min role at the route: **student** — the `status` tick is the one student-allowed mutation (CM-22); the lib enforces the higher counselor bar for the rest from the `CaseAccess` it is handed (`tasks/route.ts:165-168`). Body is a discriminated union (`tasks/route.ts:72-97`): `status { taskId, status: "not_started"|"in_progress"|"done" }`, `verify { taskId, verified }`, `update { taskId, title?, description?, owner?, dueDate?, recurrence?, sortOrder? }`, `delete { taskId }`. Responses: `{ task }` for the first three, `{ ok: true }` for `delete`. Deleting a template-derived task is a `409` from the lib.

#### `DELETE /api/admissions/cases/[caseId]/tasks`
Min role: **counselor**. Query `?taskId=<uuid>`. Response `{ ok: true }`.

### Colleges

#### `GET /api/admissions/cases/[caseId]/colleges`
Min role: **student**. Computes the CM-46 per-item completeness rollup first, then lists live rows with live IPEDS stats and a stale flag: `{ colleges }` (`colleges/route.ts:108-112`).

#### `POST /api/admissions/cases/[caseId]/colleges`
Min role: **counselor**. Body `addCollegeSchema`, a union of two entry shapes plus a shared plan block (`colleges/route.ts:56-77`):
- `{ unitId: positive int, round, deadline?, category? }` — an IPEDS institution.
- `{ manual: { instName, country }, round, deadline?, category? }` — non-US / unlisted.

`round` ∈ `ed|ed2|ea|rea|rd|rolling|priority|other`; `category` ∈ `reach|match|safety|unset`; `deadline` is `YYYY-MM-DD` or null. When both keys are sent the `unitId` branch wins. A duplicate row on the case is a `409` from the lib. Response `{ college }`.

#### `PATCH /api/admissions/cases/[caseId]/colleges`
Min role: **counselor**. Body `updateCollegeSchema` (`colleges/route.ts:86-95`): `itemId` (uuid), `expectedUpdatedAt?`, `round?`, `deadline?`, `appStatus?` (`researching|applying|submitted|complete`), `category?`, `aidOffered?` (decimal string `^\d{1,12}(\.\d{1,2})?$`), `aidNotes?`. Omitted fields are untouched; explicit nulls clear nullable fields. Response `{ college }`.

#### `DELETE /api/admissions/cases/[caseId]/colleges`
Min role: **counselor**. Query `?itemId=<uuid>`. The lib clears the case's committed pointer in the same transaction when it referenced the item. Response `{ ok: true }`.

#### `GET /api/admissions/cases/[caseId]/colleges/[itemId]/events`
Min role: **student**. The handler pins `itemId` to this case's live rows first, so a cross-case id returns `404 { "error": "Not found" }` before the unscoped `listApplicationEvents` runs (`events/route.ts:70-73`). Response `{ events }`, oldest first.

#### `POST /api/admissions/cases/[caseId]/colleges/[itemId]/events`
Min role: **counselor**. Body is a union (`events/route.ts:40-57`): `{ event: "committed", eventDate }` or `{ event: "submitted"|"deferred"|"waitlisted"|"accepted"|"denied"|"withdrawn", eventDate, notes? }`. `eventDate` is `YYYY-MM-DD`. A `committed` event routes through `setCommittedCollege` — the canonical CM-44 path that moves the case's committed pointer and appends the event in one transaction — and responds `{ committed }`; every other event responds `{ event }`. A second commit while another item holds the pointer is a `409`. The committed branch deliberately takes no `notes`.

### Essays

#### `GET /api/admissions/cases/[caseId]/essays`
Min role: **student**. Response `{ essays }`, most urgent first, each carrying staleness and effective stage.

#### `POST /api/admissions/cases/[caseId]/essays`
Min role: **student** (essays are a self-report surface; counselor/admin creations pass through and are attributed by the audit `actorRole`). Body `createEssaySchema` (`essays/route.ts:49-54`): `prompt` (non-empty), `listItemId?` (uuid, nullable), `deadline?` (`YYYY-MM-DD`, nullable), `driveUrl?`. Response `{ essay }`.

#### `PATCH /api/admissions/cases/[caseId]/essays`
Min role: **student**, with a per-field split. Body `updateEssaySchema` (`essays/route.ts:59-68`): `essayId` (uuid), `expectedUpdatedAt?`, `prompt?`, `status?` (`not_started|brainstorming|drafting|feedback|final`), `driveUrl?`, `counselorStage?`, `deadline?`, `listItemId?`. Supplying any of `counselorStage` / `deadline` / `listItemId` requires counselor+, else `403 { "error": "Forbidden" }` before the lib is touched (`essays/route.ts:152-158`). Response `{ essay }`.

#### `DELETE /api/admissions/cases/[caseId]/essays`
Min role: **counselor** — deleting tracker rows is staff work, not self-report. Query `?essayId=<uuid>`. Response `{ ok: true }`.

### Activities

#### `GET /api/admissions/cases/[caseId]/activities`
Min role: **student**. Response `{ activities }`, ranked rows first.

#### `POST /api/admissions/cases/[caseId]/activities`
Min role: **student** — students own the master list. Body `createActivitySchema` (`activities/route.ts:40-46`): `name` (non-empty), `fullDescription?`, `commonApp?` and `uc?` (the lib's exported hard-limit block schemas, `src/lib/admissions/shared/activities.ts:88-100`), `sortOrder?`. The live-row cap is enforced by the lib as a `409`. Response `{ activity }`.

#### `PATCH /api/admissions/cases/[caseId]/activities`
Min role: **student**. Body is a discriminated union (`activities/route.ts:78-81`):
- `update` — `{ activityId, expectedUpdatedAt?, name?, fullDescription?, commonApp?, uc?, sortOrder? }`. `commonAppRank` is deliberately absent. Response `{ activity }`.
- `rank` — `{ orderedIds }`, at most `MAX_COMMON_APP_RANKED_ACTIVITIES = 10` (`shared/activities.ts:19`), uuid-shaped and unique. The lib assigns ranks 1..n and clears the ranks of unlisted activities. Response `{ ok: true }`.

#### `DELETE /api/admissions/cases/[caseId]/activities`
Min role: **student** — students may delete their own list rows. Query `?activityId=<uuid>`. Response `{ ok: true }`.

### Testing

#### `GET /api/admissions/cases/[caseId]/testing`
Min role: **student**. Response `{ sittings, bestScores }` (`testing/route.ts:68-72`).

#### `POST /api/admissions/cases/[caseId]/testing`
Min role: **student**. Body `createSittingSchema` (`testing/route.ts:38-43`): `testType` ∈ `sat|act|ap|ib|toefl|ielts|other`, `testDate` (`YYYY-MM-DD`), `targetScore?`, `accommodations?`. Response `{ sitting }`.

#### `PATCH /api/admissions/cases/[caseId]/testing`
Min role: **student**, with one counselor-only field. Body `updateSittingSchema` (`testing/route.ts:45-55`): `sittingId` (uuid), `expectedUpdatedAt?`, `testType?`, `testDate?`, `registrationDeadline?`, `targetScore?`, `actualScore?`, `accommodations?`, `scoreReleasedToParent?`. Supplying `scoreReleasedToParent` requires counselor+ (CM-83), else `403 { "error": "Forbidden" }` before any lib call (`testing/route.ts:142-147`). Response `{ sitting }`.

#### `DELETE /api/admissions/cases/[caseId]/testing`
Min role: **student**. Query `?sittingId=<uuid>`. Response `{ ok: true }`.

### Recommenders

#### `GET /api/admissions/cases/[caseId]/recommenders`
Min role: **student**. Response `{ recommenders, collegeDocs }` (`recommenders/route.ts:122-124`).

#### `POST /api/admissions/cases/[caseId]/recommenders`
Min role: **counselor**. Body `{ name (non-empty), roleSubject?, contact? }` (`recommenders/route.ts:51-55`). Response `{ recommender }`.

#### `PATCH /api/admissions/cases/[caseId]/recommenders`
Min role: **counselor**. Body is a discriminated union on `action` (`recommenders/route.ts:57-84`):

| `action` | Fields | Response |
|---|---|---|
| `update` | `recommenderId`, `name?`, `roleSubject?`, `contact?`, `askStatus?` (`planned\|asked\|agreed\|declined`) | `{ recommender }` |
| `link` | `recommenderId`, `listItemId` | `{ link }` |
| `submission` | `recommenderId`, `listItemId`, `submitted` (bool) | `{ link }` |
| `college_doc` | `listItemId`, `docType` (`transcript\|school_report\|score_send`), `sent` (bool), `testSittingId?` | `{ doc }` |

Two fail-closed guards run before the lib: `assertRecommenderInCase` / `assertListItemInCase` pin a body-supplied id to the URL's case and throw `NotFound` for a foreign id (`recommenders/route.ts:98-111`), because the lib derives the case *from* those rows. The `college_doc` branch also enforces the CM-46 pairing rule at the 400 boundary — `score_send` requires a `testSittingId` and every other doc type forbids one (`route.ts:231-242`). The forward-only `askStatus` machine rejects an illegal move with a `409` from the lib.

#### `DELETE /api/admissions/cases/[caseId]/recommenders`
Min role: **counselor**. Query `?recommenderId=<uuid>`. Response `{ ok: true }`.

### Meetings

The meeting log is a staff surface at **counselor** minimum for *all three* methods — meeting notes carry candid observations that must never reach the student or parent views (students get the action-item tasks instead).

#### `GET /api/admissions/cases/[caseId]/meetings`
Response `{ meetings }`.

#### `POST /api/admissions/cases/[caseId]/meetings`
Body `createMeetingSchema` (`meetings/route.ts:34-41`): `meetingDate` (`YYYY-MM-DD`), `mode?`, `attendees?` (string array), `notes?`, `nextMeetingDate?`, `actionItems?` (each `{ title, owner: "student"|"counselor"|"parent", dueDate? }`). Action items are created as checklist tasks. Response is the `createMeeting` result object.

#### `PATCH /api/admissions/cases/[caseId]/meetings`
Body `updateMeetingSchema` (`meetings/route.ts:43-50`): `meetingId` (uuid) plus the same optional fields (no `actionItems`). Response `{ meeting }`.

### Notes

#### `GET /api/admissions/cases/[caseId]/notes`
Min role: **student**. `listNotesForRole(caseId, access.role)` strips `staff_only` notes for non-staff readers (`notes/route.ts:45`). Response `{ notes }`.

#### `POST /api/admissions/cases/[caseId]/notes`
Min role: **counselor**. Body `{ body (non-empty), visibility: "staff_only"|"shared_with_family" }` — `visibility` is **required with no default**, matching the NOT-NULL-no-default column, so every write carries an explicit audience choice (`notes/route.ts:21-29`). Response `{ note }`.

#### `PATCH /api/admissions/cases/[caseId]/notes`
Min role: **counselor**. Body `{ noteId (uuid), visibility }`. Response `{ note }`.

### Guided self-report sections

Path param `sectionKey` ∈ `about_you | q_and_a_survey | personality | random_facts | essay_moments | majors_reflection` (`src/lib/admissions/sections.ts:64-72`). All three methods run `requireCaseAccess(..., "student")` **first**; an unknown `sectionKey` is a `404` only *after* the membership check passes, so section keys never leak to non-members.

#### `GET /api/admissions/cases/[caseId]/sections/[sectionKey]`
Response `{ section }` — the definition plus saved answers plus review state.

#### `PUT /api/admissions/cases/[caseId]/sections/[sectionKey]`
Body `{ payload: Record<string, unknown> }` — a **partial** autosave; per-field type/option/maxLength rules live in the lib's `validateSectionPayload`, fail-closed against the section definition (`sections/[sectionKey]/route.ts:34-38`). Merge semantics live in `saveSectionDraft`. Response `{ section }`.

#### `POST /api/admissions/cases/[caseId]/sections/[sectionKey]`
Body is a discriminated union `{ action: "submit" }` | `{ action: "review" }` (`route.ts:40-43`). `submit` (draft → submitted) runs at the student bar and is the only notify event; `review` (submitted → reviewed) is counselor+ and a student attempt returns `403 { "error": "Forbidden" }` before any lib call (`route.ts:116-122`). Response `{ section }` for `review`, the `submitSection` result for `submit`.

### Parent dashboard

#### `GET /api/admissions/cases/[caseId]/parent-dashboard`
Min role: **parent** — the floor of the ordering, so *every* active member may read: parents get their own surface, students see the same view, and staff preview exactly what the family sees. The body is `buildParentDashboard`'s DTO and nothing else — the only builder of parent-facing payloads, so a staff field cannot reach this surface without a deliberate edit to `parent-projection.ts`. Response `{ dashboard }` (`parent-dashboard/route.ts:32-35`).

### Calendar

#### `GET /api/admissions/cases/[caseId]/calendar`
Min role: **student**; `requireCaseAccess` runs before query parsing. Query `calendarQuerySchema` (`calendar/route.ts:31-45`): `from` and `to` are both **required** `YYYY-MM-DD` strings with `from <= to`, and `limit` is coerced to an int between 1 and `UPCOMING_DEADLINES_MAX_LIMIT = 100`, defaulting to `UPCOMING_DEADLINES_DEFAULT_LIMIT = 5` (`src/lib/admissions/calendar.ts:55-58`). Malformed input is a `400` — never a guessed window. Response `{ items, upcoming }`.

### Audit trail

#### `GET /api/admissions/audit/[caseId]`
**Admin only, twice**: the JWT role must be `admin` (`403` otherwise, a fast-fail) *and* `requireCaseAccess(..., "admin")` re-verifies against `admin_users` on this request (`audit/[caseId]/route.ts:40-46`). Query `AuditQuerySchema`: `page` (int ≥1, default 1) and `pageSize` (int 1–`AUDIT_LOG_MAX_PAGE_SIZE = 200`, default `AUDIT_LOG_DEFAULT_PAGE_SIZE = 50`) (`src/lib/admissions/audit.ts:143,146`). Response is the paged audit object, newest first.

### Cohorts and checklist templates

#### `GET /api/admissions/cohorts`
Min role: **counselor**. Response `{ cohorts }`.

#### `POST /api/admissions/cohorts`
**Admin only**. Body `{ name (non-empty), graduationYear (coerced int 2000–2100) }` (`cohorts/route.ts:16-19`). A duplicate name surfaces as `Conflict` → 409. Response `{ cohort }`.

#### `GET /api/admissions/cohorts/[cohortId]/templates`
Min role: **counselor** (read-only staff visibility). Response `{ latest, versions }` — the latest template version with items plus the full version history (`templates/route.ts:86-88`).

#### `POST /api/admissions/cohorts/[cohortId]/templates`
**Admin only**. Body is a discriminated union on `action` (`templates/route.ts:63-73`):
- `create_version` — `{ items: templateItem[] (min 1), name?, publish? }`. Each item is `{ itemKey (snake_case regex `^[a-z][a-z0-9_]*$`), phase (one of the 10 canonical phases — `custom` is task-only), title, description?, defaultOwner: "student"|"counselor"|"parent", sortOrder (int ≥0) }`. Adds version max+1 (CM-20 immutability-by-versioning). Response `{ template }`.
- `push_new_items` — no other fields. Appends the latest published template's missing items to every live case in the cohort (CM-21). Response is the `pushNewItemsToCohortCases` result.

#### `PATCH /api/admissions/cohorts/[cohortId]/templates`
**Admin only**. Body `{ templateId: uuid }`. Fail-closed cohort scoping: the id must belong to *this* cohort's version list, else `404 { "error": "Not found" }` (`templates/route.ts:168-173`). Publishing an already-published version is a `409`. Response `{ template }`.

### Counselor registry

All three methods are **admin only** — the registry grants sign-in capability.

#### `GET /api/admissions/counselors`
Response `{ counselors }` — the full registry, active and inactive.

#### `POST /api/admissions/counselors`
Body `UpsertCounselorSchema` (`counselors/route.ts:15-19`): `{ email, name (non-empty), active (bool, default true) }`. Upserts by lowercase email; the write is audited transactionally. Response `{ counselor }`.

#### `PATCH /api/admissions/counselors`
Body `PatchCounselorSchema`, a union (`counselors/route.ts:24-34`): `{ email, name, active }` (full update — the flag is never guessed) or `{ email, active: false }` (pure deactivation, which revokes counselor sign-in). Order matters: the update variant wins when both `name` and `active` are present. An unknown email on the deactivate path is a `404`. Response `{ counselor }`.

### Announcements

Scope rule, mirroring the `admissions_announcements_target_check` constraint: every request targets **exactly one** of `cohortId` or `caseId` — both or neither is a `400` before any access check or write (`announcements/route.ts:71-91`).

#### `GET /api/admissions/announcements`
Query `{ cohortId? }` XOR `{ caseId? }` (both uuid). A case-scoped read runs `requireCaseAccess(..., "student")` and returns the family-visible feed; a cohort-scoped read runs `requireCounselorOrAdmin` because cohort-wide listing is a staff surface — students and parents see cohort broadcasts only where they are merged into their own case feed (`route.ts:124-137`). Response `{ announcements }`.

#### `POST /api/admissions/announcements`
Body `createAnnouncementSchema` (`route.ts:81-91`): the same XOR plus `title` and `body`, both trimmed and non-empty. Case-scoped creation requires counselor+ **on that case**; cohort-scoped creation requires `requireCounselorOrAdmin`. Response `{ announcement }`.

#### `PATCH /api/admissions/announcements`
`requireCounselorOrAdmin` runs before body parsing, then rights re-anchor on the **stored** row's scope — never client-supplied ids: a case-scoped target additionally requires counselor+ on that case, while a cohort broadcast stays at the staff bar (`requireAnnouncementMutationAccess`, `route.ts:57-67`). Scope is immutable, so the pre-transaction check cannot race a retarget. Body `updateAnnouncementSchema` (`route.ts:93-102`): `announcementId` (uuid) plus at least one of `title`/`body`. Response `{ announcement }`.

#### `DELETE /api/admissions/announcements`
Same re-anchoring guard. Query `?announcementId=<uuid>`. Soft delete — the lib retains the row for the audit trail. Response `{ ok: true }`.

### Resource library

#### `GET /api/admissions/resources`
`requireAdmissionsSession` **only**: the library is global and deliberately readable by every admissions role (counselor, admin, student, parent); there is no per-case scope to anchor `requireCaseAccess` (`resources/route.ts:67-76`). Response `{ groups }`.

#### `POST /api/admissions/resources`
Min role: **counselor** (via `requireCounselorOrAdmin`, before body parsing). Body `createResourceSchema` (`resources/route.ts:36-41`): `topic` (one of the 10 checklist phase keys or `general` — `src/lib/admissions/shared/resources.ts:20-26`), `title` (non-empty), `url` (`admissionsResourceUrlSchema` — a well-formed absolute URL that **must** be https; plain http and other schemes are rejected), `sortOrder?` (coerced int ≥0). Response `{ resource }`.

#### `PATCH /api/admissions/resources`
Min role: **counselor**. Body `updateResourceSchema` (`resources/route.ts:43-61`): `resourceId` (uuid) plus at least one of `topic`/`title`/`url`/`sortOrder`. Response `{ resource }`.

#### `DELETE /api/admissions/resources`
Min role: **counselor**. Query `?resourceId=<uuid>`. Soft delete. Response `{ ok: true }`.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
