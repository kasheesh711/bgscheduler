# Search, Tutors, Filters, Compare, Data Health, Auth & Admin API

HTTP reference for the search/compare workspace, tutor metadata, filter dropdowns, data-health dashboard, leave-request review, tutor business profiles, and the admin Wise-sync trigger. Eighteen endpoints across eight path families:

- **Search** — `/api/search`, `/api/search/range`, `/api/search/assistant`
- **Compare** — `/api/compare`, `/api/compare/discover`
- **Tutors** — `/api/tutors`
- **Filters** — `/api/filters`
- **Data Health** — `/api/data-health`
- **Admin** — `/api/admin/sync-wise`
- **Tutor Profiles** — `/api/tutor-profiles`, `/api/tutor-profiles/[canonicalKey]`, `/api/tutor-profiles/import-preview`, `/api/tutor-profiles/import-commit`
- **Leave Requests** — `/api/leave-requests`, `/api/leave-requests/sync`, `/api/leave-requests/[requestId]`, `/api/leave-requests/[requestId]/wise-cancel-preview`

For *what* these features mean (search/compare workflow, fail-closed availability rules, leave-request lifecycle, profile-import matching), see the relevant `docs/features/*` pages. This page documents mechanical request/response detail only.

## Conventions shared across these endpoints

**Authentication.** Every handler in this group calls `auth()` from `@/lib/auth` as its first step and returns `401 { "error": "Unauthorized" }` when no session is present. The leave-request handlers additionally require an email — they check `!session?.user?.email` rather than just `!session` (`src/app/api/leave-requests/route.ts:9`, `[requestId]/route.ts:16`, `[requestId]/route.ts:28`, `[requestId]/wise-cancel-preview/route.ts:10`, `sync/route.ts:10`). All other handlers check `!session` (e.g. `src/app/api/compare/route.ts:114`, `src/app/api/search/route.ts:31`).

These paths are **admin** tier: none are in the middleware public-route allowlist except `/api/search/assistant`, so the global auth middleware also redirects unauthenticated browser requests to `/login` before the handler runs (`src/middleware.ts:4-15, 25-29`). `/api/search/assistant` is allowlisted as public in the middleware (`src/middleware.ts:8`) yet still enforces a session in-handler (`src/app/api/search/assistant/route.ts:136-139`) — see its section below.

**Validation.** Most write/query bodies are validated with a Zod `.safeParse()`; on failure the handler returns `400 { "error": "Invalid request", "details": <flattened zod error> }`. Routes that parse a JSON body first wrap `request.json()` in `try/catch` and return `400 { "error": "Invalid JSON" }` on a parse failure. The leave-request `POST`/`PATCH` handlers are the exception: a JSON parse failure is swallowed and treated as an empty body (`{}`), not a 400 (`src/app/api/leave-requests/sync/route.ts:14-19`, `[requestId]/route.ts:33-38`, `[requestId]/wise-cancel-preview/route.ts:14-19`).

**Error handling.** Business logic runs in a `try/catch`; uncaught errors generally return `500 { "error": <err.message or a fallback> }`, via the pattern `const message = err instanceof Error ? err.message : "<fallback>"`. Exceptions: `wise-cancel-preview` returns `400` on any thrown error (`[requestId]/wise-cancel-preview/route.ts:35`); `search/assistant` returns `502`/`503` (see below); `leave-requests/sync` returns `409` on a concurrent-run error.

**Snapshot metadata.** Search/compare responses embed `snapshotMeta: { snapshotId, syncedAt, stale }` (`src/lib/search/types.ts:30-34`). `stale` is `true` when `Date.now() - syncedAt > API_STALE_THRESHOLD_MS`; when stale, a `STALE_SEARCH_WARNING` string is pushed into the response `warnings[]` (`src/app/api/compare/route.ts:144-149`).

---

## Search

Tutor-availability search against the warm in-memory index. The recommended endpoint is `POST /api/search/range`; `POST /api/search` is the legacy slot-based form; `POST /api/search/assistant` is the natural-language assistant.

### `POST /api/search/range`

Range search: an admin enters a time window + class duration, the backend slices it into fixed sub-slots and returns an availability grid. Source: `src/app/api/search/range/route.ts`.

- **Auth:** `auth()` → `401` when no session (`route.ts:7-10`).
- **Request body** — Zod `rangeRequestSchema` (`src/lib/search/range-search.ts:16-37`):
  | Field | Type | Notes |
  |---|---|---|
  | `searchMode` | `"recurring" \| "one_time"` | required |
  | `startTime` | `string` | required, `HH:MM` (regex `^\d{2}:\d{2}$`) |
  | `endTime` | `string` | required, `HH:MM` |
  | `durationMinutes` | `60 \| 90 \| 120` | required; accepts the strings `"60"/"90"/"120"` (transformed to number) or the numeric literals |
  | `mode` | `"online" \| "onsite" \| "either"` | required |
  | `dayOfWeek` | `number` (0–6) | optional (recurring) |
  | `date` | `string` | optional (one-time) |
  | `filters` | `{ subject?, curriculum?, level? }` | optional |
  | `tutorGroupIds` | `string[]` | optional — restrict the grid to specific tutor groups |
- **Behavior:** generates sub-slots via `generateSubSlots(startTime, endTime, durationMinutes)` (`range-search.ts:41-71`); if zero sub-slots fit, returns `400 { "error": "Time range is too short for the selected class duration" }` (`route.ts:31-36`). Otherwise delegates to `executeRangeSearch(db, …)` (`route.ts:41`, `range-search.ts:103`).
- **Response** — `RangeSearchResponse` (`src/lib/search/types.ts:102-109`): `{ snapshotMeta, subSlots: {start,end}[], grid: RangeGridRow[], needsReview: TutorReviewResult[], latencyMs, warnings }`. Each `RangeGridRow` has `availability: (true | BlockingSessionInfo[])[]` aligned to `subSlots` — `true` means free, an array lists the blocking sessions/holds (`types.ts:93-100`). `needsReview` carries fail-closed tutors with `reasons[]` (`types.ts:46-48`).
- **Errors:** `500 { "error": <message | "Search failed"> }` on a thrown error (`route.ts:52-55`).

### `POST /api/search`

Legacy slot-based search kept for backward compatibility. Source: `src/app/api/search/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:30-34`).
- **Request body** — inline Zod `searchRequestSchema` (`route.ts:8-28`):
  - `searchMode`: `"recurring" | "one_time"` (required).
  - `slots`: non-empty array of `{ id: string, dayOfWeek?: 0–6, date?: string, start: HH:MM, end: HH:MM, mode: "online"|"onsite"|"either" }`.
  - `filters`: `{ subject?, curriculum?, level? }` (optional).
  - `rawInput`: `string` (optional — the original natural-language text).
- **Behavior:** `ensureIndex(db)` then `executeSearch(index, parsed.data)` (`route.ts:54-55`).
- **Response** — `SearchResponse` (`src/lib/search/types.ts:56-63`): `{ snapshotMeta, normalizedSlots, perSlotResults: SlotResult[], intersection: TutorResult[], latencyMs, warnings }`. `perSlotResults` splits tutors into `available`/`needsReview` per slot; `intersection` is the set available across all slots.
- **Errors:** `400 Invalid JSON` / `400 Invalid request` / `500 { "error": <message | "Search failed"> }` (`route.ts:38-59`).

### `POST /api/search/assistant`

Natural-language scheduling assistant (single-turn). Public in the middleware allowlist but session-gated in-handler. Source: `src/app/api/search/assistant/route.ts`.

- **Auth:** allowlisted public at the edge (`src/middleware.ts:8`), but the handler still calls `auth()` and returns `401` with no session (`route.ts:136-139`). Effectively admin-gated.
- **Request body** — Zod `aiSchedulerRequestSchema` (`src/lib/ai/scheduler.ts:141-143`): `{ input: string }`, trimmed, length 1–6000, `.strict()` (no extra keys).
- **Preconditions:** if the AI scheduler is not configured (`isAiSchedulerConfigured()`), returns `503 { "error": "AI scheduler is not configured" }` (`route.ts:156-161`).
- **Behavior:** runs one assistant turn via `executeSchedulerTurn(...)` over the single admin message (`route.ts:169-174`), shapes the result, and persists a usage row with `logSchedulerRun(...)` (`route.ts:176-186`) tagged with the signed-in admin's email.
- **Response** (`200`) — discriminated by `status`, all carrying a `logId` (`src/lib/ai/scheduler.ts:72-98`):
  - `status: "needs_clarification"` → `{ partial, clarifyingQuestions: string[], warnings, logId }`.
  - `status: "solved"` → `{ parsedRequest, options: AiSchedulerOption[], parentMessageDraft, snapshotMeta, warnings, logId }`.
  - `status: "availability_summary"` → `{ state, availabilitySummary, assistantMessage, parentMessageDraft, snapshotMeta, warnings, logId }`.
- **Side effects:** always inserts a scheduler-run log row (on success and on failure) — `route.ts:176, 191`.
- **Errors:** `400 Invalid JSON` / `400 Invalid request` / `503` (not configured). On a model/runtime failure it still logs a `failed` run and returns `502 { "error": "AI scheduling failed", "detail": <message>, "logId": <uuid> }` (`route.ts:189-210`).

---

## Compare

Side-by-side tutor comparison and candidate discovery, both reading from the same in-memory `SearchIndex` (no extra DB queries beyond stale-ID resolution).

### `POST /api/compare`

Compare 1–3 tutors for one week: per-tutor schedules, same-student conflicts, and shared free slots. Source: `src/app/api/compare/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:113-116`).
- **Request body** — Zod `compareRequestSchema` (`route.ts:24-31`):
  | Field | Type | Notes |
  |---|---|---|
  | `tutorGroupIds` | `string[]` | required, length **1–3** |
  | `mode` | `"recurring" \| "one_time"` | required |
  | `dayOfWeek` | `number` (0–6) | optional — restrict to one weekday |
  | `date` | `string` | optional — restrict to the weekday of this date |
  | `weekStart` | `string` (ISO Monday) | optional — defaults to the current Monday in Asia/Bangkok (`getCurrentMonday`, `route.ts:34-41`) |
  | `fetchOnly` | `string[]` | optional — serialize only this subset of tutors in the response (conflicts/free-slots still computed on the full set) |
- **Behavior:**
  1. `ensureIndex(db)`; builds `snapshotMeta` and pushes `STALE_SEARCH_WARNING` if stale (`route.ts:138-149`).
  2. Resolves the requested IDs against the active snapshot. IDs missing from the active index but matching a UUID are looked up in `tutorIdentityGroups` and remapped to the active group by `canonicalKey`; when that happens it pushes the warning `"Tutor selection was refreshed after the latest Wise sync"` (`route.ts:61-110, 157-159`). If nothing resolves, returns `404 { "error": "No matching tutor groups found in active snapshot" }` (`route.ts:161-166`).
  3. Computes the Monday→Sunday week range. **Historical fallback:** if the range starts before start-of-today (Bangkok), it fetches captured `past_session_blocks` via `fetchPastSessionBlocks(canonicalKeys, …)` and merges them into both `buildCompareTutor` and the free-slot computation (`route.ts:185-227`).
  4. `buildCompareTutor` per group → `detectConflicts(allCompareTutors)` → `findSharedFreeSlots(...)` (`route.ts:200-227`).
  5. Applies `fetchOnly` to the serialized tutor list only (`route.ts:231-236`).
- **Response** — `CompareResponse` (`src/lib/search/types.ts:169-178`): `{ snapshotMeta, tutors: CompareTutor[], conflicts: Conflict[], sharedFreeSlots: SharedFreeSlot[], weekStart, weekEnd, latencyMs, warnings }`.
- **Errors:** `400 Invalid JSON` / `400 Invalid request` / `404` (no match) / `500 { "error": <message | "Compare failed"> }` (`route.ts:250-253`).

### `POST /api/compare/discover`

Find candidate tutors to add to a comparison, with per-candidate conflict status pre-computed against the already-selected tutors. Source: `src/app/api/compare/discover/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:30-33`).
- **Request body** — Zod `discoverRequestSchema` (`route.ts:12-27`):
  | Field | Type | Notes |
  |---|---|---|
  | `existingTutorGroupIds` | `string[]` | required, **max 2** (the already-selected tutors) |
  | `mode` | `"recurring" \| "one_time"` | required |
  | `dayOfWeek` | `number` (0–6) | optional |
  | `date` | `string` | optional |
  | `startTime` / `endTime` | `string` | optional, `HH:MM` |
  | `modeFilter` | `"online" \| "onsite" \| "either"` | optional |
  | `filters` | `{ subject?, curriculum?, level? }` | optional |
- **Behavior:** iterates every tutor group not already selected, filters by `modeFilter` (against `supportedModes`) and `filters` (subject/curriculum/level, case-insensitive), and — when a weekday + time window are given — flags a candidate `freeSlot` only if it has a matching availability window AND no blocking session AND no leave (`route.ts:78-125`). For each candidate it computes conflicts against the existing selection (`detectConflicts`) and flags data issues / unresolved modality. Candidates are sorted: clean before issues, then by conflict count ascending, then by free-slot count descending (`route.ts:153-157`).
- **Response** — `DiscoverResponse` (`src/lib/search/types.ts:203-207`): `{ snapshotMeta, candidates: DiscoverCandidate[], latencyMs }`. Each `DiscoverCandidate` (`types.ts:191-201`): `{ tutorGroupId, displayName, supportedModes, qualifications, conflictCount, conflicts, freeSlots, hasDataIssues, dataIssueReasons }`.
- **Errors:** `400 Invalid JSON` / `400 Invalid request` / `500 { "error": <message | "Discover failed"> }` (`route.ts:166-169`).

---

## Tutors

### `GET /api/tutors`

All tutor names/IDs/modes/subjects from the active snapshot — the data source for the searchable tutor combobox. Source: `src/app/api/tutors/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:6-9`).
- **Request:** no parameters.
- **Behavior:** `getTutorList()` (`src/lib/data/tutors.ts`, `route.ts:12`).
- **Response** (`200`): `{ tutors: [...] }` (`route.ts:13`).
- **Errors:** `500 { "error": <message | "Failed to load tutors"> }` (`route.ts:14-17`).

---

## Filters

### `GET /api/filters`

Distinct subjects/curriculums/levels from the active snapshot, for populating the search-form dropdowns. Source: `src/app/api/filters/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:6-9`).
- **Request:** no parameters.
- **Behavior:** returns `getFilterOptions()` directly (`src/lib/data/filters.ts`, `route.ts:12`).
- **Response** (`200`): the filter-options object from `getFilterOptions()`.
- **Errors:** `500 { "error": <message | "Failed to load filters"> }` (`route.ts:13-16`).

---

## Data Health

### `GET /api/data-health`

Operations command payload for the data-health dashboard. Source: `src/app/api/data-health/route.ts`.

- **Auth:** `auth()` → `401`.
- **Request:** no parameters.
- **Behavior:** delegates to `getDataHealthDashboardPayload`, which aggregates `cron_invocations`, the feature run ledgers, the active Wise snapshot, snapshot stats, and unresolved data issues. It preserves stale-banner fields (`staleAgeMs`, `lastSuccessfulSync`, etc.) at the top level.
- **Response** (`200`):
  ```json
  {
    "overall": { "status": "healthy", "headline": "", "detail": "" },
    "cronJobs": [],
    "dataDomains": [],
    "wiseSnapshot": {},
    "issueSummary": {},
    "issueDetails": {
      "unresolvedAliases": [],
      "unresolvedModality": [],
      "unmappedTags": []
    },
    "recentRuns": [],
    "lastSuccessfulSync": "<ISO|null>",
    "staleAgeMs": 0
  }
  ```
- **Errors:** `500 { "error": <message | "Data health failed"> }`.

### `POST /api/data-health/jobs/[jobKey]/run`

Session-gated manual trigger for registered data-health jobs. Source: `src/app/api/data-health/jobs/[jobKey]/run/route.ts`.

- **Auth:** `auth()` with an email → `401`.
- **Request body:** `{ "confirmed": true }` is required for dangerous jobs (`classroom_morning`, `classroom_admin_email`).
- **Behavior:** validates `jobKey` against the typed cron registry, then calls `runDataHealthJob`. The job runner records a `cron_invocations` row with `triggerSource = "admin"` and calls the same underlying sync/automation helpers as the cron routes.
- **Responses:**
  - `200`/`202`/`500` — forwarded from the underlying job runner.
  - `404 { "error": "Unknown job" }`
  - `409 { "error": "Confirmation required" }` for dangerous jobs without confirmation.

---

## Admin

### `POST /api/admin/sync-wise`

Manually trigger a full Wise snapshot sync from an **admin session** (distinct from the `CRON_SECRET`-protected `/api/internal/sync-wise`). Source: `src/app/api/admin/sync-wise/route.ts`.

- **Auth:** `auth()` → `401`. **No** `CRON_SECRET` check — this is the session-gated trigger (`route.ts:8-12`).
- **Function config:** `export const maxDuration = 800` (`route.ts:5`).
- **Request body:** none — `POST()` takes no parameters and does not read the request.
- **Behavior:** delegates to `runWiseSyncRequest()` (`route.ts:14`, `src/lib/sync/run-wise-sync.ts:142`), which acquires a single-flight sync run (failing any `running` row stuck > 20 min) and either skips or runs `runFullSync(...)`. On success it calls `revalidateTag("snapshot", { expire: 0 })` (`run-wise-sync.ts:160-162`).
- **Responses** (returned by `runWiseSyncRequest`, `run-wise-sync.ts:148-166`):
  - **`202 Accepted`** — a sync is already running; body is the skip-guard object (includes `skipped: true` and the in-flight `syncRunId`).
  - **`200 OK`** — sync ran and `result.success === true`; body is the `runFullSync` result merged with `staleRunningSyncsFailed`.
  - **`500`** — sync ran but `result.success === false`; same merged body shape with `success: false`.
  - **`401`** — no admin session.

> The Vercel cron drives `/api/internal/sync-wise`, not this route. See the Internal/Cron group for the cron-secret endpoint.

---

## Tutor Profiles

Tutor business-profile records (parent-safe summary, education, languages, teaching-style/strength tags, young-learner fit, etc.) with single-record edit and a two-step bulk import. Profiles are keyed by `canonicalKey`. Saving a profile clears the in-memory search index so the next search picks up the change.

### `GET /api/tutor-profiles`

List all tutor business profiles. Source: `src/app/api/tutor-profiles/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:7-10`).
- **Request:** no parameters.
- **Behavior:** `listTutorBusinessProfiles(getDb())` (`route.ts:13`).
- **Response** (`200`): `{ profiles: TutorBusinessProfileListItem[] }` (`route.ts:14`, item shape at `src/lib/tutor-business-profiles.ts:93`).
- **Errors:** `500 { "error": <message | "Failed to load tutor profiles"> }` (`route.ts:15-18`).

### `PATCH /api/tutor-profiles/[canonicalKey]`

Update (upsert) one tutor's business profile, addressed by canonical key. Source: `src/app/api/tutor-profiles/[canonicalKey]/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:22-25`).
- **Path param:** `canonicalKey` — URL-decoded from `ctx.params` (`route.ts:13-16, 43`).
- **Request body** — Zod `tutorBusinessProfilePatchSchema` (`src/lib/tutor-business-profiles.ts:36-56`), `.strict()`. All fields optional; notable ones: `displayName` (1–160), `parentSafeSummary` (≤1200), `internalNotes` (≤3000), `education[]`/`languages[]` (≤12 each), `englishProficiency`, `youngLearnerFit`, `youngestComfortableAge` (int 3–20, nullable), `teachingStyleTags[]`/`strengthTags[]`/`curriculumExperience[]` (≤30, each tag 1–80), free-text note fields, `verifiedBy` (nullable), `lastReviewedAt` (ISO datetime, nullable), `active` (boolean).
- **Behavior:** resolves the active display name for the key; if the tutor is not in the active snapshot returns `404 { "error": "Tutor not found in active snapshot" }` (`route.ts:44-47`). Otherwise upserts via `upsertTutorBusinessProfile(...)` and calls `clearSearchIndex()` (`route.ts:50-51`).
- **Response** (`200`): `{ profile }` (`route.ts:52`).
- **Errors:** `400 Invalid JSON` / `400 Invalid request` / `404` (not in snapshot) / `500 { "error": <message | "Failed to save tutor profile"> }` (`route.ts:53-56`).

### `POST /api/tutor-profiles/import-preview`

Dry-run a bulk profile import from uploaded workbooks; returns the match analysis without writing anything. Source: `src/app/api/tutor-profiles/import-preview/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:26-29`).
- **Request body** — **multipart form data** (not JSON). A non-form body returns `400 { "error": "Expected multipart form data" }` (`route.ts:31-36`). Fields read (`route.ts:40-64`):
  - `educationFile` and/or `availabilityFile` — `.xlsx`-style workbooks (read as `File`). At least one is required, else `400 { "error": "Upload at least one tutor profile workbook" }` (`route.ts:48-50`).
  - `verifiedBy`, `lastReviewedAt` — optional string metadata.
- **Behavior:** parses the workbooks (`parseTutorProfileImportWorkbooks`) and builds a preview against active profiles, identities, and aliases (`buildTutorProfileImportPreview`) — `route.ts:52-64`. No DB writes.
- **Response** (`200`) — `TutorProfileImportPreview` (`src/lib/tutor-profile-import.ts:102-117`): `{ summary: { educationRows, availabilityRows, matchedRows, unmatchedRows, duplicateSourceRows, availabilityOnlyRows, invalidRows, ambiguousRows }, rows: matched[], unmatchedRows[], ambiguousRows[], duplicateSourceRows: string[], availabilityOnlyRows: string[] }`.
- **Errors:** `400` (bad form / no workbook) / `500 { "error": <message | "Failed to preview tutor profile import"> }` (`route.ts:67-70`).

### `POST /api/tutor-profiles/import-commit`

Commit a previewed bulk import — upserts the supplied per-tutor patches. Source: `src/app/api/tutor-profiles/import-commit/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:20-23`).
- **Request body** — Zod `importCommitSchema` (`route.ts:12-17`), `.strict()`: `{ rows: [{ canonicalKey: string(≥1), patch: tutorBusinessProfilePatchSchema }] }`, `rows` length **1–200**.
- **Behavior:** loads active profiles into a `canonicalKey → profile` map; for each row, if the key is not in the active snapshot it is recorded in `skipped` (`reason: "Tutor not found in active snapshot"`), otherwise `upsertTutorBusinessProfile(...)` runs (`route.ts:42-59`). If anything was saved, `clearSearchIndex()` is called (`route.ts:61`).
- **Response** (`200`): `{ savedCount: number, skipped: [{ canonicalKey, reason }], profiles: <saved profiles> }` (`route.ts:62`).
- **Errors:** `400 Invalid JSON` / `400 Invalid request` / `500 { "error": <message | "Failed to commit tutor profile import"> }` (`route.ts:63-66`).

---

## Leave Requests

Teacher leave-request review: list with KPI cards, single-request detail, workflow status/note updates (with optional Google-Sheets writeback), a manual sync trigger, and a **preview-only** Wise session-cancellation helper. All four handlers require a session *with an email*.

> The business logic lives in `src/lib/leave-requests/**` (data + sync). This page documents the route surface; see the feature docs for lifecycle and matching rules.

### `GET /api/leave-requests`

List leave requests with summary cards and the connected-Google-Sheets status. Source: `src/app/api/leave-requests/route.ts`.

- **Auth:** `auth()` requiring `session.user.email` → `401` (`route.ts:8-11`).
- **Query params** (all optional; read off `request.nextUrl.searchParams`, `route.ts:13-21`) → `LeaveRequestListFilters` (`src/lib/leave-requests/data.ts:20-26`): `status`, `q` (free-text search), `startDate`, `endDate`, and `summaryOnly` (the literal string `"true"`).
- **Behavior:** `listLeaveRequests(db, filters)` (`route.ts:15`, `data.ts:112`) then `getGoogleTokenStatus(session.user.email)` (`route.ts:22`). When `summaryOnly` is true the `requests` array is empty (cards/timeline only); the row limit is 200 vs 500 (`data.ts:119, 139`).
- **Response** (`200`): `{ cards: { total, new, needsReview, sheetWriteFailed, affectedClasses }, unreadActionCount, timeline, requests: [...], googleSheets: <token status> }` (`data.ts:121-168`, merged at `route.ts:23`). Each request row carries normalized leave fields, `workflowStatus`, `staffNote`, `sheetWriteStatus`, `affectedClassCount`, `cancellationPreviewCount`, `unread`, etc.
- **Errors:** `500 { "error": <message | "Leave request query failed"> }` (`route.ts:24-27`).

### `POST /api/leave-requests/sync`

Manually trigger a leave-requests sync (read from the source sheet + normalize). Source: `src/app/api/leave-requests/sync/route.ts`.

- **Auth:** `auth()` requiring `session.user.email` → `401` (`route.ts:9-12`).
- **Function config:** `export const maxDuration = 800` (`route.ts:6`).
- **Request body:** optional JSON; a parse failure is treated as `{}` (no 400). Reads `connectedEmail` (string) when present (`route.ts:14-27`).
- **Behavior:** `syncLeaveRequests(db, { triggerType: "manual", actorEmail, actorName, connectedEmail })` (`route.ts:23-28`).
- **Response** (`200`): `{ ok: true, result: <sync result> }` (`route.ts:29`).
- **Errors:** **`409`** `{ "error": <message> }` when a sync is already running (`LeaveRequestSyncAlreadyRunningError`, `route.ts:31-33`); otherwise `500 { "error": <message | "Leave request sync failed"> }` (`route.ts:34-35`).

### `GET /api/leave-requests/[requestId]`

Fetch one leave request with its affected sessions and activity log. Source: `src/app/api/leave-requests/[requestId]/route.ts`.

- **Auth:** `auth()` requiring `session.user.email` → `401` (`route.ts:15-18`).
- **Path param:** `requestId` (from `context.params`, `route.ts:20`).
- **Behavior:** `getLeaveRequestDetail(db, requestId)` (`route.ts:21`, `data.ts:171`).
- **Response** (`200`): the detail object. **`404 { "error": "Not found" }`** when the request does not exist (`route.ts:22`).
- **Errors:** the GET handler has no `try/catch`; a thrown DB error propagates to the framework (no explicit 500 envelope).

### `PATCH /api/leave-requests/[requestId]`

Update a leave request's workflow status / staff note, with optional Google-Sheets writeback. Source: `src/app/api/leave-requests/[requestId]/route.ts`.

- **Auth:** `auth()` requiring `session.user.email` → `401` (`route.ts:27-30`).
- **Path param:** `requestId` (`route.ts:32`).
- **Request body:** JSON; a parse failure is treated as `{}` (no 400). Validated inline (no Zod), reading (`route.ts:39-62`):
  - `workflowStatus` — must be one of `LEAVE_WORKFLOW_STATUSES` (`new`, `needs_review`, `in_progress`, `done`, `ignored`, `canceled_by_tutor` — `data.ts:9-16`); an invalid value returns `400 { "error": "Invalid workflow status" }` (`route.ts:41-43`).
  - `staffNote` — string, or `null` to clear, or omitted to leave unchanged.
  - `sheetStatusText` — present (string or `null`) toggles a sheet write.
  - `retrySheetWrite` — `true` to retry a failed sheet write.
- **Behavior:** resolves the connected Google email (best-effort), then `updateLeaveRequestWorkflow(db, requestId, {...})` (`route.ts:46-64`, `data.ts:332`). The helper marks the row read, sets `sheetWriteStatus: "pending"` when a write is implied, and appends a `status_update` activity-log entry.
- **Response** (`200`): `{ ok: true, ...result }`. **`404 { "error": "Not found" }`** when the request does not exist (`route.ts:65-66`).
- **Errors:** `500 { "error": <message | "Leave request update failed"> }` (`route.ts:67-70`).

### `POST /api/leave-requests/[requestId]/wise-cancel-preview`

Preview the Wise session-cancellation actions for a leave request. **Preview only — no Wise mutation is sent.** Source: `src/app/api/leave-requests/[requestId]/wise-cancel-preview/route.ts`.

- **Auth:** `auth()` requiring `session.user.email` → `401` (`route.ts:9-12`).
- **Path param:** `requestId` (`route.ts:26`).
- **Request body:** JSON (parse failure → `{}`). Reads `affectedSessionIds` — only string entries are kept (`route.ts:14-23`).
- **Behavior:** `createWiseCancelPreview(db, requestId, { affectedSessionIds, actorEmail, actorName })` (`route.ts:27-31`, `data.ts:443`). The helper requires at least one valid session id (throws otherwise), sets `cancelPreviewSelected` on the chosen `leaveRequestAffectedSessions` rows, builds dry-run `DELETE` endpoint descriptors (each tagged `manualRequired: true`), updates `cancellationPreviewCount`, and writes a `wise_cancel_preview` activity-log entry with `status: "manual_required"` and `policy: "preview_only_manual_required"`. It then returns the refreshed detail via `getLeaveRequestDetail` (`data.ts:448-502`).
- **Response** (`200`): `{ ok: true, detail: <refreshed leave-request detail> }` (`route.ts:32`).
- **Errors:** this handler returns **`400`** on *any* thrown error (e.g. "Select at least one affected session." or "Selected affected sessions were not found.") — `route.ts:33-36` — not 500.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
