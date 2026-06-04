# AI Scheduler API

HTTP reference for the AI Scheduler endpoints under `/api/ai-scheduler`. These routes back the admin-facing AI scheduling workspace: they manage scheduler conversations, drive an AI turn that parses a parent/admin message into a bounded Wise-backed tutor search, expose observability metrics, and capture staff feedback on AI suggestions.

For the meaning of conversations, the AI turn pipeline, fail-closed rules, and how feedback feeds correction telemetry, see the feature docs. This page documents only mechanical request/response detail.

## Conventions

- **Auth**: Every endpoint calls `await auth()` from `@/lib/auth` and returns `401 {"error":"Unauthorized"}` when there is no session. There is no per-route allowlist check beyond a valid session; the global gate lives in `src/middleware.ts`.
- **Body parsing**: Routes that accept a body parse JSON inside a `try/catch` and return `400 {"error":"Invalid JSON"}` on a parse failure.
- **Validation**: Body/query validation uses Zod `.safeParse()`. On failure the route returns `400 {"error":"Invalid request","details": <ZodError.flatten()>}` (or `400 {"error":"Invalid sort"}` for the list query). All body schemas are `.strict()`, so unknown keys are rejected.
- **DB access**: `getDb()` from `@/lib/db`; data-layer helpers live in `src/lib/ai/scheduler-data.ts`.
- **Persistence note**: AI scheduler records are never hard-deleted by these routes. `DELETE` archives. Run logging (`logSchedulerRun`) swallows DB errors and returns the string `"unlogged"` instead of an id (`scheduler-data.ts:529-532`).

---

## Conversations collection

### GET /api/ai-scheduler/conversations

List scheduler conversations with admin facets.

- **File**: `src/app/api/ai-scheduler/conversations/route.ts:27-52`
- **Auth**: required (`route.ts:28-31`).
- **Query parameters** (read from `request.nextUrl.searchParams`, `route.ts:33-41`):
  - `includeArchived` — `"true"` includes archived conversations; any other value (or absent) returns only `status = "active"` (`route.ts:33`, applied in `scheduler-data.ts:204-215`). Result is capped at 200 rows ordered by `lastMessageAt desc`.
  - `scope` — `"mine"` restricts to the caller's own conversations (`route.ts:34`, `mineOnly`).
  - `ownerEmail` — restrict to a specific creator email; takes precedence over `scope=mine` (`scheduler-data.ts:305`).
  - `sort` — one of `review_priority` | `latest` | `admin` | `oldest_pending_line`. Validated by `sortSchema` (`route.ts:10`, `36-40`); defaults to `review_priority`. An unrecognized value returns `400 {"error":"Invalid sort"}`.
  - `q` — case-insensitive substring filter over title, parent/student name, contact, and notes (`route.ts:41`, `scheduler-data.ts:276-287`).
- **Request body**: none.
- **Response** `200`: `ListSchedulerConversationsResult` (`scheduler-data.ts:46-49`):
  - `conversations`: array of `SchedulerConversationDto` (`scheduler-data.ts:16-37`). Each includes `id`, `title`, `status`, `source` (`"line"` | `"manual"`), LINE-review rollups (`pendingLineReviewCount`, `latestLineReviewStatus`, `needsStudentLink`, `oldestPendingLineReviewAt`, `latestLineReviewAt`), `customerParentName`/`customerStudentName`/`customerContact`, `notes`, `extractedState`, `createdByEmail`/`createdByName`, `archivedAt`, `lastMessageAt`, `createdAt`, `updatedAt`.
  - `adminFacets`: array of `{ email, name, count, pendingLineCount }` (`scheduler-data.ts:39-44`), sorted by display name.
- **Side effects**: none (read-only; also reads `lineSchedulerReviews` and `lineContactStudentLinks` to compute the LINE rollups, `scheduler-data.ts:218-271`).
- **Status codes**: `200`, `400` (invalid sort), `401`.

### POST /api/ai-scheduler/conversations

Create a manual scheduler conversation.

- **File**: `src/app/api/ai-scheduler/conversations/route.ts:54-77`
- **Auth**: required (`route.ts:55-58`).
- **Request body** — `createConversationSchema` (`route.ts:12-18`, `.strict()`). All fields optional:
  - `title` — trimmed, 1–120 chars.
  - `customerParentName` — trimmed, ≤120.
  - `customerStudentName` — trimmed, ≤120.
  - `customerContact` — trimmed, ≤160.
  - `notes` — ≤4000.
- **Response** `201`: `{ "conversation": SchedulerConversationDto }` (`route.ts:76`).
- **Side effects**: inserts one row into `ai_scheduler_conversations` via `createSchedulerConversation` (`scheduler-data.ts:339-362`). Defaults: empty `title` → `"Untitled scheduler chat"`; empty `notes` → `""`; creator email is lowercased and trimmed; `status` defaults to `active` (`schema.ts:1438-1439`).
- **Status codes**: `201`, `400` (invalid JSON / invalid request), `401`.

---

## Single conversation

All three handlers share `ConversationRouteContext` with `params: Promise<{ conversationId: string }>` and resolve the id via `conversationIdFromContext` (`src/app/api/ai-scheduler/conversations/[conversationId]/route.ts:19-24`). The `conversationId` is not format-validated by the route.

### GET /api/ai-scheduler/conversations/[conversationId]

Fetch one conversation and its full message history.

- **File**: `src/app/api/ai-scheduler/conversations/[conversationId]/route.ts:26-42`
- **Auth**: required (`route.ts:30-33`).
- **Request body**: none.
- **Response** `200`: `{ conversation: SchedulerConversationDto, messages: SchedulerMessageDto[] }` from `getSchedulerConversationWithMessages` (`scheduler-data.ts:376-393`). Messages are ordered by `createdAt` ascending. `SchedulerMessageDto` (`scheduler-data.ts:51-62`): `id`, `conversationId`, `role` (`admin` | `parent` | `assistant` | `system`), `content`, `structuredPayload` (JSON or `null`), `model`, `latencyMs`, `createdByEmail`, `createdByName`, `createdAt`.
- **Side effects**: none.
- **Status codes**: `200`, `401`, `404 {"error":"Conversation not found"}` when the conversation does not exist (`route.ts:37-39`).

### PATCH /api/ai-scheduler/conversations/[conversationId]

Update editable conversation fields, including status.

- **File**: `src/app/api/ai-scheduler/conversations/[conversationId]/route.ts:44-75`
- **Auth**: required (`route.ts:48-51`).
- **Request body** — `patchConversationSchema` (`route.ts:10-17`, `.strict()`). All fields optional:
  - `title` — trimmed, 1–120 chars.
  - `customerParentName` — trimmed, ≤120, nullable.
  - `customerStudentName` — trimmed, ≤120, nullable.
  - `customerContact` — trimmed, ≤160, nullable.
  - `notes` — ≤4000.
  - `status` — `"active"` | `"archived"`.
- **Response** `200`: `{ "conversation": SchedulerConversationDto }` (`route.ts:74`).
- **Side effects**: updates the row via `patchSchedulerConversation` (`scheduler-data.ts:395-429`). Always bumps `updatedAt`. A blank `title` collapses to `"Untitled scheduler chat"`; blank nullable customer fields collapse to `null`. Setting `status="archived"` sets `archivedAt = now()`; `status="active"` clears `archivedAt` to `null` (`scheduler-data.ts:418-421`).
- **Status codes**: `200`, `400` (invalid JSON / invalid request), `401`, `404 {"error":"Conversation not found"}` when no row matches (`route.ts:70-72`).

### DELETE /api/ai-scheduler/conversations/[conversationId]

Archive a conversation (soft delete).

- **File**: `src/app/api/ai-scheduler/conversations/[conversationId]/route.ts:77-93`
- **Auth**: required (`route.ts:81-84`).
- **Request body**: none.
- **Response** `200`: `{ "conversation": SchedulerConversationDto }` with `status: "archived"` (`route.ts:92`).
- **Side effects**: does **not** delete the row. It calls `patchSchedulerConversation(db, conversationId, { status: "archived" })` (`route.ts:87`), which sets `status="archived"` and `archivedAt = now()`.
- **Status codes**: `200`, `401`, `404 {"error":"Conversation not found"}` when no row matches (`route.ts:88-90`).

---

## Conversation messages (AI turn)

### POST /api/ai-scheduler/conversations/[conversationId]/messages

Append an admin message and run one AI scheduling turn (state extraction + Wise-backed solve), persisting the admin and assistant messages plus a run log.

- **File**: `src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts:50-191`
- **Auth**: required (`route.ts:54-57`).
- **Configuration gate**: returns `503 {"error":"AI scheduler is not configured"}` when `isAiSchedulerConfigured()` is false (`route.ts:59-61`). That helper requires `ENABLE_AI_SCHEDULER !== "false"` **and** a non-empty `OPENAI_API_KEY` (`scheduler.ts:477-480`).
- **Request body** — `sendMessageSchema` (`route.ts:19-21`, `.strict()`):
  - `content` (string, required) — trimmed, 1–8000 chars.
- **Preconditions** (checked after parsing, `route.ts:78-86`):
  - Conversation must exist → else `404 {"error":"Conversation not found"}`.
  - Conversation must not be archived → else `409 {"error":"Archived conversations cannot receive new messages"}`.
- **Response** `200` (success, `route.ts:147-152`):
  - `conversation`: updated `SchedulerConversationDto`.
  - `messages`: `[adminMessage, assistantMessage]` (both `SchedulerMessageDto`).
  - `assistantResult`: `SchedulerAssistantResult` (`scheduler-conversation.ts:209-226`) — `state`, `suggestions`, optional `availabilitySummary`, `constraintLedger`, optional `latencyBreakdownMs`, `parentMessageDraft`, `assistantMessage`, `snapshotMeta`, `warnings`, `questions`, `parentReady`.
  - `logId`: the inserted run id, or `"unlogged"` if run logging failed.
- **Side effects** (in order):
  1. Inserts the admin message (`role:"admin"`, actor = caller) — `createSchedulerMessage` (`route.ts:91-96`).
  2. Runs `executeSchedulerTurn` (`scheduler-service.ts:48-107`): ensures the in-memory search index, lists active proposal holds, calls OpenAI for state extraction, merges state, and solves the turn against Wise-derived data.
  3. Inserts the assistant message (`role:"assistant"`, author name `"AI Scheduler"`) with the structured payload and model/latency (`route.ts:113-121`).
  4. Updates the conversation via `touchSchedulerConversationAfterMessage` — bumps `lastMessageAt`/`updatedAt`, stores `extractedState`, copies parent/student/contact from resolved state, and auto-titles when the current title is exactly `"Untitled scheduler chat"` (`route.ts:123-132`).
  5. Inserts a run log via `logSchedulerRun` with `status` = `"solved"` when `parentReady` else `"needs_clarification"`, a PII-redacted input preview (`redactAiSchedulerInput`, `scheduler.ts:439-450`), latency breakdown, parsed/solver payloads, and warnings (`route.ts:133-145`).
- **AI failure path** — if `executeSchedulerTurn` throws (`route.ts:153-190`): the admin message is already persisted; the route inserts a fallback assistant message (a generic recovery notice with `structuredPayload:{error}`), touches the conversation, and logs a run with `status:"failed"` and `errorMessage`. It returns `502 {"error":"AI scheduling failed","detail": <message>, "messages":[adminMessage, assistantMessage], "logId"}`.
- **Status codes**: `200`, `400` (invalid JSON / invalid request), `401`, `404`, `409`, `502` (AI turn failed), `503` (not configured).

---

## Metrics

### GET /api/ai-scheduler/metrics

Aggregated observability for AI scheduler runs, LINE scheduler analytics, and correction telemetry.

- **File**: `src/app/api/ai-scheduler/metrics/route.ts:8-22`
- **Auth**: required (`route.ts:9-12`).
- **Request**: no query parameters, no body. (Handler signature is `GET()` with no request argument, `route.ts:8`.)
- **Response** `200`: `{ scheduler, line, correction }`, computed in parallel via `Promise.all` (`route.ts:15-19`):
  - `scheduler`: `AiSchedulerMetrics` (`scheduler-metrics.ts:5-26`) over the most recent 500 runs — `totalRuns`, `solvedRuns`, `needsClarificationRuns`, `failedRuns`, `parentReadyConstraintFailures`, a `latency` object (`p50Ms`, `p95Ms`, `averageMs`, `averageDbMs`, `averageModelMs`, `averageSearchMs`), `versions[]` (`schedulerVersion`/`promptVersion`/`count`), and `recentFailures[]` (up to 10).
  - `line`: `LineSchedulerAnalytics` (`src/lib/line/data.ts:154-176`) — classifier counts, review outcome counts, rejection rate, edit-distance/latency averages, classification accuracy fields, unverified-link backlog, and common rejection reasons/categories.
  - `correction`: `CorrectionTelemetry` (`src/lib/ai/correction-telemetry.ts:18-27`) over the most recent 5000 feedback rows — `totalActions`, `acceptRate`/`editRate`/`rejectRate`/`dismissRate`, `avgTimeToReviewMs`, `p50TimeToReviewMs`, and `confidenceByOutcome[]` bucketed by classifier confidence band.
- **Side effects**: none (read-only).
- **Status codes**: `200`, `401`.

---

## Feedback

### POST /api/ai-scheduler/messages/[messageId]/feedback

Record staff feedback (accept / edit / reject) on an AI assistant message.

- **File**: `src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts:41-78`
- **Auth**: required (`route.ts:42-45`).
- **Path param**: `messageId` from `params: Promise<{ messageId: string }>` (`route.ts:32`, `62`). Passed straight through to the data layer; not format-validated by the route.
- **Request body** — `feedbackSchema`, a Zod **discriminated union on `action`** (`route.ts:7-30`), each variant `.strict()`:
  - `action: "accept"` (`route.ts:8-14`): optional `conversationId` (uuid|null), `schedulerRunId` (uuid|null), `selectedTutorIds` (string[], each ≥1 char, ≤12 items), `editedParentDraft` (≤5000|null).
  - `action: "edit"` (`route.ts:15-21`): same optionals as accept, **plus required** `editedParentDraft` (trimmed, 1–5000).
  - `action: "reject"` (`route.ts:22-29`): optional `conversationId`/`schedulerRunId`, optional `rejectedTutorIds` (string[], ≤12), **required** `rejectionReason` (trimmed, 1–500) and `staffCorrection` (trimmed, 1–5000).
  - Note: the data layer also supports a `"dismiss"` action (`scheduler-data.ts:71`), but this route's schema does not accept it.
- **Response** `200`: `{ "feedback": SchedulerFeedbackDto }` (`route.ts:77`). `SchedulerFeedbackDto` (`scheduler-data.ts:73-90`): `id`, `conversationId`, `messageId`, `schedulerRunId`, `action`, `selectedTutorIds`, `rejectedTutorIds`, `editedParentDraft`, `rejectionReason`, `staffCorrection`, `lineReviewId`, `classifierConfidence`, `timeToReviewMs`, `createdByEmail`, `createdByName`, `createdAt`.
- **Side effects**: inserts one row into `ai_scheduler_feedback` via `createSchedulerFeedback` (`scheduler-data.ts:535-574`). Fields absent from the chosen variant are passed as `undefined` and default to empty arrays / `null` (`scheduler-data.ts:560-568`); text fields are trimmed and blanked to `null`. The actor email is lowercased.
- **Status codes**: `200`, `400` (invalid JSON / invalid request), `401`.

---

## Status code summary

| Endpoint | 200 | 201 | 400 | 401 | 404 | 409 | 502 | 503 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/ai-scheduler/conversations | ✓ | | ✓ (invalid sort) | ✓ | | | | |
| POST /api/ai-scheduler/conversations | | ✓ | ✓ | ✓ | | | | |
| GET /api/ai-scheduler/conversations/[conversationId] | ✓ | | | ✓ | ✓ | | | |
| PATCH /api/ai-scheduler/conversations/[conversationId] | ✓ | | ✓ | ✓ | ✓ | | | |
| DELETE /api/ai-scheduler/conversations/[conversationId] | ✓ | | | ✓ | ✓ | | | |
| POST /api/ai-scheduler/conversations/[conversationId]/messages | ✓ | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET /api/ai-scheduler/metrics | ✓ | | | ✓ | | | | |
| POST /api/ai-scheduler/messages/[messageId]/feedback | ✓ | | ✓ | ✓ | | | | |

_Verified against HEAD + uncommitted WIP on 2026-05-31._
