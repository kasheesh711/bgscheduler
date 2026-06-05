# AI Scheduler API

HTTP reference for the AI Scheduler endpoints under `/api/ai-scheduler`. These routes back the admin-facing AI scheduling workspace (`/scheduler`, `/scheduler/metrics`): they manage scheduler conversations, run an AI turn that parses an admin/parent message into a bounded Wise-backed tutor search and a parent-ready reply draft, expose observability metrics, and capture staff feedback on AI suggestions.

This page documents mechanical request/response detail only. For the meaning of conversations, the AI turn pipeline, fail-closed availability rules, and how feedback feeds correction telemetry, see the AI Scheduler feature doc.

This group is **8 endpoints**:

| Method | Path |
|---|---|
| GET | `/api/ai-scheduler/conversations` |
| POST | `/api/ai-scheduler/conversations` |
| GET | `/api/ai-scheduler/conversations/[conversationId]` |
| PATCH | `/api/ai-scheduler/conversations/[conversationId]` |
| DELETE | `/api/ai-scheduler/conversations/[conversationId]` |
| POST | `/api/ai-scheduler/conversations/[conversationId]/messages` |
| POST | `/api/ai-scheduler/messages/[messageId]/feedback` |
| GET | `/api/ai-scheduler/metrics` |

## Conventions

- **Auth tier**: admin session. Every handler calls `await auth()` from `@/lib/auth` and returns `401 {"error":"Unauthorized"}` when there is no session. There is no extra per-route allowlist check beyond a valid session; the global gate lives in `src/middleware.ts`.
- **Body parsing**: handlers that accept a body read `await request.json()` inside a `try/catch` and return `400 {"error":"Invalid JSON"}` on a parse failure.
- **Validation**: body and query validation use Zod `.safeParse()`. On failure the route returns `400 {"error":"Invalid request","details": <ZodError.flatten()>}` (the list-query `sort` is the one exception — it returns `400 {"error":"Invalid sort"}`). All body schemas are `.strict()`, so unknown keys are rejected.
- **Route config**: none of the eight route files export `runtime`, `dynamic`, `maxDuration`, or `revalidate`; they run with framework defaults.
- **DB access**: `getDb()` from `@/lib/db`. Data-layer helpers live in `src/lib/ai/scheduler-data.ts`; the AI turn pipeline is in `src/lib/ai/scheduler-service.ts` + `src/lib/ai/scheduler-conversation.ts`; metrics aggregators are `src/lib/ai/scheduler-metrics.ts` (scheduler), `src/lib/line/data.ts` (LINE), and `src/lib/ai/correction-telemetry.ts` (correction).
- **Soft delete**: these routes never hard-delete. `DELETE` archives (sets `status="archived"`). Run logging (`logSchedulerRun`) swallows DB errors and returns the string `"unlogged"` instead of an id (`scheduler-data.ts:529-532`).
- **`conversationId` / `messageId`** path params are awaited from `ctx.params` (Next 16 async params) and are **not** format-validated by the route handlers.

---

## Conversations collection

### GET /api/ai-scheduler/conversations

List scheduler conversations plus per-admin facets.

- **File**: `src/app/api/ai-scheduler/conversations/route.ts:27-52`
- **Auth**: required (`route.ts:28-31`).
- **Query parameters** (read from `request.nextUrl.searchParams`, `route.ts:33-41`; applied in `listSchedulerConversations`, `scheduler-data.ts:193-337`):
  - `includeArchived` — `"true"` returns archived + active; any other value (or absent) filters to `status = "active"` (`route.ts:33`, `scheduler-data.ts:204-215`). The base query is capped at 200 rows ordered by `lastMessageAt desc`.
  - `scope` — `"mine"` restricts to the caller's own conversations (`route.ts:34`, passed as `mineOnly`).
  - `ownerEmail` — restrict to a specific creator email; when present it takes precedence over `scope=mine` (`scheduler-data.ts:305`). Compared case-insensitively against `createdByEmail`.
  - `sort` — one of `review_priority` | `latest` | `admin` | `oldest_pending_line`, validated by `sortSchema` (`route.ts:10`, `36-40`); defaults to `review_priority`. An unrecognized value short-circuits to `400 {"error":"Invalid sort"}`.
  - `q` — case-insensitive substring filter over `title`, `customerParentName`, `customerStudentName`, `customerContact`, and `notes` (`route.ts:41`, `scheduler-data.ts:276-287`).
- **Request body**: none.
- **Response** `200`: `ListSchedulerConversationsResult` (`scheduler-data.ts:46-49`):
  - `conversations`: array of `SchedulerConversationDto` (`scheduler-data.ts:16-37`). Each includes `id`, `title`, `status` (`active` | `archived`), `source` (`line` | `manual`), LINE-review rollups (`pendingLineReviewCount`, `latestLineReviewStatus`, `needsStudentLink`, `oldestPendingLineReviewAt`, `latestLineReviewAt`), `customerParentName`/`customerStudentName`/`customerContact`, `notes`, `extractedState` (the persisted `SchedulerExtractedState`), `createdByEmail`/`createdByName`, `archivedAt`, `lastMessageAt`, `createdAt`, `updatedAt` (all timestamps serialized ISO-8601).
  - `adminFacets`: array of `{ email, name, count, pendingLineCount }` (`scheduler-data.ts:39-44`), sorted by display name.
- **Side effects**: none (read-only). To compute the LINE rollups it also reads `line_scheduler_reviews` and `line_contact_student_links` (`scheduler-data.ts:218-271`). Sorting (`review_priority` default) ranks by pending LINE-review count, then needs-student-link, then oldest pending review, then source, then recency (`scheduler-data.ts:306-334`).
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
- **Side effects**: inserts one row into `ai_scheduler_conversations` via `createSchedulerConversation` (`scheduler-data.ts:339-362`). Defaults applied at insert: empty/absent `title` → `"Untitled scheduler chat"`; absent `notes` → `""`; the creator's email is lowercased + trimmed and name trimmed (`normalizeActor`, `scheduler-data.ts:186-191`); `source` defaults to `manual` and `status` to `active` at the column level.
- **Status codes**: `201`, `400` (invalid JSON / invalid request), `401`.

---

## Single conversation

The three handlers below share `ConversationRouteContext` with `params: Promise<{ conversationId: string }>` and resolve the id via `conversationIdFromContext` (`src/app/api/ai-scheduler/conversations/[conversationId]/route.ts:19-24`).

### GET /api/ai-scheduler/conversations/[conversationId]

Fetch one conversation and its full message history.

- **File**: `src/app/api/ai-scheduler/conversations/[conversationId]/route.ts:26-42`
- **Auth**: required (`route.ts:30-33`).
- **Request body**: none.
- **Response** `200`: `{ conversation: SchedulerConversationDto, messages: SchedulerMessageDto[] }` from `getSchedulerConversationWithMessages` (`scheduler-data.ts:376-393`). Messages are ordered by `createdAt` ascending. `SchedulerMessageDto` (`scheduler-data.ts:51-62`): `id`, `conversationId`, `role` (`admin` | `parent` | `assistant` | `system`), `content`, `structuredPayload` (arbitrary JSON object or `null`), `model`, `latencyMs`, `createdByEmail`, `createdByName`, `createdAt`.

  Note: the conversation returned here is built by `getSchedulerConversation` (`scheduler-data.ts:364-374`), which uses the default empty LINE-stats (`source` is reported as `"manual"` and the LINE rollups are zeroed); the populated LINE rollups only appear in the list endpoint.
- **Side effects**: none.
- **Status codes**: `200`, `401`, `404 {"error":"Conversation not found"}` when the conversation does not exist (`route.ts:37-39`).

### PATCH /api/ai-scheduler/conversations/[conversationId]

Update editable fields on a conversation (including archive/unarchive via `status`).

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
- **Side effects**: `UPDATE` on `ai_scheduler_conversations` via `patchSchedulerConversation` (`scheduler-data.ts:395-429`). Only supplied keys are written; `updatedAt` is always bumped. An empty `title` is coerced back to `"Untitled scheduler chat"`. Setting `status="archived"` stamps `archivedAt = now()`; setting `status="active"` clears `archivedAt` to `null` (`scheduler-data.ts:418-421`).
- **Status codes**: `200`, `400` (invalid JSON / invalid request), `401`, `404 {"error":"Conversation not found"}` when no row matches (`route.ts:70-72`).

### DELETE /api/ai-scheduler/conversations/[conversationId]

Archive a conversation (soft delete).

- **File**: `src/app/api/ai-scheduler/conversations/[conversationId]/route.ts:77-93`
- **Auth**: required (`route.ts:81-84`).
- **Request body**: none.
- **Response** `200`: `{ "conversation": SchedulerConversationDto }` — the archived conversation (`route.ts:92`).
- **Side effects**: does **not** delete any row. It calls `patchSchedulerConversation(db, conversationId, { status: "archived" })` (`route.ts:87`), so the conversation flips to `status="archived"`, `archivedAt = now()`, and `updatedAt` is bumped. Messages, runs, and feedback are untouched.
- **Status codes**: `200`, `401`, `404 {"error":"Conversation not found"}` when no row matches (`route.ts:88-90`).

---

## Messages (AI turn)

### POST /api/ai-scheduler/conversations/[conversationId]/messages

Append an admin message and run one AI scheduling turn, producing an assistant reply with tutor suggestions and a parent-ready draft. This is the only write-heavy endpoint in the group.

- **File**: `src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts:50-191`
- **Auth**: required (`route.ts:54-57`).
- **Config gate**: if `isAiSchedulerConfigured()` is false, returns `503 {"error":"AI scheduler is not configured"}` before reading the body (`route.ts:59-61`). The gate is true only when `process.env.ENABLE_AI_SCHEDULER !== "false"` **and** `OPENAI_API_KEY` is set (`scheduler.ts:477-480`).
- **Request body** — `sendMessageSchema` (`route.ts:19-21`, `.strict()`):
  - `content` (required) — trimmed, 1–8000 chars. The admin/parent text to schedule against.
- **Preconditions**:
  - The conversation must exist → otherwise `404 {"error":"Conversation not found"}` (`route.ts:80-83`).
  - The conversation must not be archived → otherwise `409 {"error":"Archived conversations cannot receive new messages"}` (`route.ts:84-86`).
- **Processing** (`route.ts:88-145`):
  1. Inserts the admin message (`role:"admin"`, actor = session user) via `createSchedulerMessage`.
  2. Runs `executeSchedulerTurn` (`scheduler-service.ts:48-107`): warms the in-memory search index (`ensureIndex`), pulls active proposal holds, calls OpenAI to extract structured state, merges it onto the conversation's prior `extractedState`, then deterministically solves availability via `executeSearch` and drafts a parent reply. Returns `{ extraction, assistantResult, latencyBreakdownMs }`.
  3. Inserts the assistant message (`role:"assistant"`, `actor.name:"AI Scheduler"`, `model` = `aiSchedulerModel()`, `latencyMs` = wall-clock) with `structuredPayload` = `assistantResult` merged with `extractedState`.
  4. Updates the conversation via `touchSchedulerConversationAfterMessage` (bumps `lastMessageAt`/`updatedAt`, persists the new `extractedState`, and auto-titles when the prior title was exactly `"Untitled scheduler chat"`, `route.ts:123-132`).
  5. Logs a run row into `ai_scheduler_runs` via `logSchedulerRun` with `status` = `"solved"` when `assistantResult.parentReady`, else `"needs_clarification"`; stores a redacted input preview (`redactAiSchedulerInput`, masks emails/phones/long numbers), the latency breakdown, the parsed + solver payloads, and warnings (`route.ts:133-145`).
- **Response** `200` (`route.ts:147-152`):
  - `conversation` — updated `SchedulerConversationDto` (may be `null` only if the row vanished mid-request).
  - `messages` — `[adminMessage, assistantMessage]` (both `SchedulerMessageDto`).
  - `assistantResult` — `SchedulerAssistantResult` (`scheduler-conversation.ts:209-226`): `state` (resolved scheduler state), `suggestions[]` (ranked tutor slot suggestions), optional `availabilitySummary`, `constraintLedger[]` (per-constraint `proven`/`needs_clarification`/`not_applicable`), optional `latencyBreakdownMs`, `parentMessageDraft`, `assistantMessage`, `snapshotMeta`, `warnings[]`, `questions[]`, `parentReady` (boolean).
  - `logId` — the `ai_scheduler_runs` id, or `"unlogged"` if the run insert failed.
- **Error handling** (`route.ts:153-190`): if the AI turn throws, the route still inserts an apologetic assistant message (`structuredPayload:{ error }`), touches the conversation, and logs a run with `status:"failed"` + `errorMessage`. It then returns `502 {"error":"AI scheduling failed","detail": <message>, "messages":[adminMessage, assistantMessage], "logId"}`. Note: on this path the admin message has already been persisted.
- **Status codes**: `200`, `400` (invalid JSON / invalid request), `401`, `404` (conversation not found), `409` (archived), `502` (AI turn failed), `503` (scheduler not configured).

---

## Feedback

### POST /api/ai-scheduler/messages/[messageId]/feedback

Record staff feedback (accept / edit / reject) on an assistant message's suggestions. Feeds the correction-telemetry metrics.

- **File**: `src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts:41-78`
- **Auth**: required (`route.ts:42-45`).
- **Request body** — `feedbackSchema`, a `.strict()` discriminated union on `action` (`route.ts:7-30`). Common optional fields across variants: `conversationId` (uuid, nullable), `schedulerRunId` (uuid, nullable).
  - `action:"accept"` — optional `selectedTutorIds` (array of non-empty strings, ≤12), optional `editedParentDraft` (≤5000, nullable).
  - `action:"edit"` — optional `selectedTutorIds` (≤12); **required** `editedParentDraft` (trimmed, 1–5000).
  - `action:"reject"` — optional `rejectedTutorIds` (≤12); **required** `rejectionReason` (trimmed, 1–500) and `staffCorrection` (trimmed, 1–5000).

  (The data layer also models a `"dismiss"` action and `lineReviewId`/`classifierConfidence`/`timeToReviewMs` fields, but this route never sets them — `createSchedulerFeedback`, `scheduler-data.ts:535-574`. Those are populated by the LINE review path instead.)
- **Path param**: `messageId` (`route.ts:62`) — not format-validated; stored as `messageId` on the feedback row.
- **Response** `200`: `{ "feedback": SchedulerFeedbackDto }` (`route.ts:77`). `SchedulerFeedbackDto` (`scheduler-data.ts:73-90`): `id`, `conversationId`, `messageId`, `schedulerRunId`, `action`, `selectedTutorIds[]`, `rejectedTutorIds[]`, `editedParentDraft`, `rejectionReason`, `staffCorrection`, `lineReviewId`, `classifierConfidence`, `timeToReviewMs`, `createdByEmail`, `createdByName`, `createdAt`.
- **Side effects**: inserts one row into `ai_scheduler_feedback` (`scheduler-data.ts:535-574`). Variant-specific fields are spread in only when present on the parsed body (`route.ts:69-73`); absent array fields default to `[]` and absent text fields are trimmed-or-`null`. The actor email is lowercased + trimmed.
- **Notes**: there is no existence check on `messageId` / `conversationId` / `schedulerRunId` and no FK enforcement in the handler, so feedback can be written against ids that do not resolve.
- **Status codes**: `200`, `400` (invalid JSON / invalid request — e.g. wrong/missing fields for the chosen `action`), `401`.

---

## Metrics

### GET /api/ai-scheduler/metrics

Read-only observability rollup for the `/scheduler/metrics` page. Aggregates three independent telemetry sources in parallel.

- **File**: `src/app/api/ai-scheduler/metrics/route.ts:8-22`
- **Auth**: required (`route.ts:9-12`).
- **Request body / query**: none.
- **Response** `200`: `{ scheduler, line, correction }` (`route.ts:21`), fetched via `Promise.all` (`route.ts:15-19`):
  - `scheduler` — `AiSchedulerMetrics` from `getAiSchedulerMetrics` (`scheduler-metrics.ts:5-26`, `65-131`). Computed over the most recent 500 `ai_scheduler_runs` ordered by `createdAt desc`. Fields: `totalRuns`, `solvedRuns`, `needsClarificationRuns`, `failedRuns`, `parentReadyConstraintFailures` (solved runs whose `solverPayload.constraintLedger` still contains a `needs_clarification` item), `latency` (`p50Ms`, `p95Ms`, `averageMs`, `averageDbMs`, `averageModelMs`, `averageSearchMs` — any may be `null`), `versions[]` (`{ schedulerVersion, promptVersion, count }`, descending by count), and `recentFailures[]` (up to 10 `{ id, createdAt, errorMessage, inputPreviewRedacted }`).
  - `line` — `LineSchedulerAnalytics` from `getLineSchedulerAnalytics` (`line/data.ts:154-176`): LINE classifier + review KPIs (`classifiedMessages`, `schedulingMessages`, `pendingReviews`, `approvedSent`, `rejected`, `rejectionRate`, `averageEditDistance`, `averageModelLatencyMs`, classification-accuracy fields, `unverifiedLinkBacklog`, `commonRejectionReasons[]`, `commonRejectionCategories[]`, `feedbackLabels[]`, etc.). Full shape documented in the [LINE API reference](line.md).
  - `correction` — `CorrectionTelemetry` from `getCorrectionTelemetry` (`correction-telemetry.ts:18-27`, `47-90`). Computed over up to the most recent 5000 `ai_scheduler_feedback` rows. Fields: `totalActions`, `acceptRate`/`editRate`/`rejectRate`/`dismissRate`, `avgTimeToReviewMs`, `p50TimeToReviewMs`, and `confidenceByOutcome[]` (per confidence band `high`/`medium`/`low`/`unknown`, with `accept`/`edit`/`reject`/`dismiss`/`total` counts).
- **Side effects**: none (read-only).
- **Status codes**: `200`, `401`.

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
