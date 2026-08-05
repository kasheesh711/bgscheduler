# AI Scheduler API

**Authoritative source:** the five route files under [`src/app/api/ai-scheduler/`](../../../src/app/api/ai-scheduler/), backed by the data layer at [`src/lib/ai/scheduler-data.ts`](../../../src/lib/ai/scheduler-data.ts), the turn orchestrator at [`src/lib/ai/scheduler-service.ts`](../../../src/lib/ai/scheduler-service.ts), the prompt/solver module at [`src/lib/ai/scheduler-conversation.ts`](../../../src/lib/ai/scheduler-conversation.ts), and the two read-only aggregators [`scheduler-metrics.ts`](../../../src/lib/ai/scheduler-metrics.ts) / [`correction-telemetry.ts`](../../../src/lib/ai/correction-telemetry.ts).

This page is the mechanical reference for the eight AI Scheduler HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. What a scheduler conversation *means*, why the AI never decides availability itself, and how staff feedback feeds correction telemetry live in [docs/features/ai-scheduler.md](../../features/ai-scheduler.md). Column-level detail for the four backing tables — `ai_scheduler_conversations` ([`schema.ts:2344`](../../../src/lib/db/schema.ts)), `ai_scheduler_messages` ([`schema.ts:2365`](../../../src/lib/db/schema.ts)), `ai_scheduler_runs` ([`schema.ts:2383`](../../../src/lib/db/schema.ts)), `ai_scheduler_feedback` ([`schema.ts:2407`](../../../src/lib/db/schema.ts)) — lives in the [database reference](../database/index.md).

## Endpoint index

| Method | Path | Handler |
|--------|------|---------|
| GET | `/api/ai-scheduler/conversations` | [`conversations/route.ts:27-52`](../../../src/app/api/ai-scheduler/conversations/route.ts) |
| POST | `/api/ai-scheduler/conversations` | [`conversations/route.ts:54-77`](../../../src/app/api/ai-scheduler/conversations/route.ts) |
| GET | `/api/ai-scheduler/conversations/[conversationId]` | [`[conversationId]/route.ts:26-42`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts) |
| PATCH | `/api/ai-scheduler/conversations/[conversationId]` | [`[conversationId]/route.ts:44-75`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts) |
| DELETE | `/api/ai-scheduler/conversations/[conversationId]` | [`[conversationId]/route.ts:77-93`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts) |
| POST | `/api/ai-scheduler/conversations/[conversationId]/messages` | [`messages/route.ts:50-191`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts) |
| POST | `/api/ai-scheduler/messages/[messageId]/feedback` | [`feedback/route.ts:41-78`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts) |
| GET | `/api/ai-scheduler/metrics` | [`metrics/route.ts:8-22`](../../../src/app/api/ai-scheduler/metrics/route.ts) |

## Conventions shared across the endpoints

- **Authentication — admin session, no cron or public tier.** Every handler calls `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and returns `401 {"error":"Unauthorized"}` when there is no session. No handler inspects the email beyond stamping it onto rows. The subtree is **not** on the middleware public-route allowlist ([`middleware.ts:4-20`](../../../src/middleware.ts)), so an unauthenticated browser request is redirected to `/login` before the handler runs; the in-handler `auth()` call is the API-level backstop.
- **Restricted users get a middleware 403 the handlers never emit.** For a signed-in user whose `allowed_pages` column is non-null ([`schema.ts:581`](../../../src/lib/db/schema.ts)), `isPathAllowed` matches each allowed prefix as both a page and an `/api`-prefixed namespace, and any `/api/**` miss returns `403 {"error":"Forbidden"}` ([`middleware.ts:30-61,79-82`](../../../src/middleware.ts)). Note the namespace asymmetry: the UI page is `/scheduler` ([`tools.ts:95`](../../../src/lib/navigation/tools.ts)) while this API group is `/api/ai-scheduler`, so an `allowedPages` entry of `/scheduler` expands to `/api/scheduler/**` and does **not** cover these endpoints.
- **Actor stamping.** `actorFromSession` lifts `session.user.email` / `session.user.name`, each defaulting to `null` — [`conversations/route.ts:20-25`](../../../src/app/api/ai-scheduler/conversations/route.ts), [`messages/route.ts:25-30`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts), [`feedback/route.ts:34-39`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts). The data layer then trims + lowercases the email and trims the name, collapsing blanks to `null` (`normalizeActor`, [`scheduler-data.ts:186-191`](../../../src/lib/ai/scheduler-data.ts)).
- **Body parsing.** Handlers that take a body call `request.json()` inside `try/catch` and return `400 {"error":"Invalid JSON"}` on failure.
- **Validation.** Bodies are validated with Zod `.safeParse()`; failure returns `400 {"error":"Invalid request","details": <error.flatten()>}`. Every body schema is `.strict()`, so unknown keys are rejected. The one query-string validation (`sort`) returns its own `400 {"error":"Invalid sort"}`.
- **Path params.** Route contexts type `params` as a `Promise` (Next.js 16) and await it before use. Neither `conversationId` nor `messageId` is format-validated in the route; both are passed straight to the data layer, where a malformed UUID surfaces as a database error.
- **Error surface.** Only the messages route wraps its business logic in `try/catch`. Elsewhere a data-layer throw propagates out of the handler, so the framework returns a generic `500` with no typed JSON body — this group does not follow the `500 {"error": message}` pattern used by, say, [Proposals](./proposals.md).
- **No route-level runtime config.** None of the five files exports `maxDuration`, `runtime`, `dynamic`, or `revalidate`, and none calls `revalidateTag` — scheduler writes never invalidate the `snapshot` cache tag.
- **Deletes are soft.** Nothing here hard-deletes: `DELETE` archives a conversation, and no endpoint removes messages, runs, or feedback.
- **Run logging never fails a request.** `logSchedulerRun` swallows database errors, logs to `console.error`, and returns the literal string `"unlogged"` in place of an id ([`scheduler-data.ts:529-532`](../../../src/lib/ai/scheduler-data.ts)).

---

## Conversations collection

### `GET /api/ai-scheduler/conversations`

Lists scheduler conversations plus per-admin facets, with LINE-review rollups attached. Handler: [`conversations/route.ts:27-52`](../../../src/app/api/ai-scheduler/conversations/route.ts).

**Auth:** session required ([`route.ts:28-31`](../../../src/app/api/ai-scheduler/conversations/route.ts)).

**Request:** no body. Query parameters are read directly off `request.nextUrl.searchParams` ([`route.ts:33-41`](../../../src/app/api/ai-scheduler/conversations/route.ts)); only `sort` has a Zod schema.

| Param | Values | Effect |
|-------|--------|--------|
| `includeArchived` | `"true"` | Includes archived rows. Any other value (or absent) restricts the DB read to `status = "active"` ([`scheduler-data.ts:204-215`](../../../src/lib/ai/scheduler-data.ts)). |
| `scope` | `"mine"` | Restricts results to conversations created by the caller's normalized email ([`route.ts:34`](../../../src/app/api/ai-scheduler/conversations/route.ts), [`scheduler-data.ts:305-307`](../../../src/lib/ai/scheduler-data.ts)). |
| `ownerEmail` | any string | Restricts to that creator email (trimmed + lowercased). **Takes precedence over `scope=mine`** ([`scheduler-data.ts:305`](../../../src/lib/ai/scheduler-data.ts)). Absent ⇒ `null`. |
| `sort` | `review_priority` \| `latest` \| `admin` \| `oldest_pending_line` | Validated by the module-scope `sortSchema` ([`route.ts:10`](../../../src/app/api/ai-scheduler/conversations/route.ts)); defaults to `review_priority`. Anything else → `400 {"error":"Invalid sort"}` ([`route.ts:36-40`](../../../src/app/api/ai-scheduler/conversations/route.ts)). |
| `q` | any string | Case-insensitive substring match over `title`, `customerParentName`, `customerStudentName`, `customerContact`, `notes` ([`scheduler-data.ts:276-287`](../../../src/lib/ai/scheduler-data.ts)). |

**Read window.** The database query is capped at **200 rows** ordered by `lastMessageAt` descending ([`scheduler-data.ts:204-215`](../../../src/lib/ai/scheduler-data.ts)); `q`, `ownerEmail`/`scope`, and all sorting are applied in-process on top of that window, so no filter reaches further back than the newest 200 conversations.

**Sort semantics** ([`scheduler-data.ts:308-334`](../../../src/lib/ai/scheduler-data.ts)):

| `sort` | Ordering |
|--------|----------|
| `review_priority` (default) | `pendingLineReviewCount` desc → `needsStudentLink` first → oldest `oldestPendingLineReviewAt` first → `source = "line"` first → `lastMessageAt` desc. |
| `latest` | `lastMessageAt` desc. |
| `admin` | Creator name (falling back to email) ascending, then `lastMessageAt` desc. |
| `oldest_pending_line` | Conversations with a pending LINE review first, oldest pending first; the rest by `lastMessageAt` desc. |

**Side effects:** none (read-only). Two extra reads build the rollups: `line_scheduler_reviews` for the listed conversation ids, then `line_contact_student_links` filtered to `status = "verified"` for the contacts behind pending reviews ([`scheduler-data.ts:218-271`](../../../src/lib/ai/scheduler-data.ts)).

**Response 200** — `ListSchedulerConversationsResult` ([`scheduler-data.ts:46-49`](../../../src/lib/ai/scheduler-data.ts)):

```
{ "conversations": SchedulerConversationDto[], "adminFacets": SchedulerConversationAdminFacet[] }
```

`SchedulerConversationDto` ([`scheduler-data.ts:16-37`](../../../src/lib/ai/scheduler-data.ts), assembled by `conversationToDto`, [`scheduler-data.ts:121-144`](../../../src/lib/ai/scheduler-data.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (UUID) | |
| `title` | string | DB default `"Untitled scheduler chat"` ([`schema.ts:2346`](../../../src/lib/db/schema.ts)). |
| `status` | `"active"` \| `"archived"` | DB default `active`. |
| `source` | `"line"` \| `"manual"` | Derived, not stored: `"line"` when at least one `line_scheduler_reviews` row points at the conversation, else `"manual"` ([`scheduler-data.ts:110-119,248-253`](../../../src/lib/ai/scheduler-data.ts)). |
| `pendingLineReviewCount` | number | Linked reviews with status `pending_review`. |
| `latestLineReviewStatus` | string \| null | Status of the linked review with the newest `updatedAt`. |
| `needsStudentLink` | boolean | True when a pending review has no `verifiedStudentKeys`, no verified contact link, and no `studentLinkOverride` ([`scheduler-data.ts:265-268`](../../../src/lib/ai/scheduler-data.ts)). |
| `oldestPendingLineReviewAt` | string (ISO) \| null | |
| `latestLineReviewAt` | string (ISO) \| null | |
| `customerParentName` / `customerStudentName` / `customerContact` | string \| null | |
| `notes` | string | DB default `""`. |
| `extractedState` | `SchedulerExtractedState` | JSONB; `{}` when unset ([`scheduler-data.ts:136`](../../../src/lib/ai/scheduler-data.ts)). Shape at [`scheduler-conversation.ts:57-83`](../../../src/lib/ai/scheduler-conversation.ts) — every field optional (`searchMode`, `dayOfWeek`, `date`, `startTime`/`endTime`, `durationMinutes`, `mode`, `filters`, `subjectIntent`, `requestedSlots`, `tutorNames`/`tutorExclusions`, `parentName`, `studentName`, `contact`, `assumptions`, `unresolvedQuestions`, …). |
| `createdByEmail` / `createdByName` | string \| null | |
| `archivedAt` | string (ISO) \| null | |
| `lastMessageAt` / `createdAt` / `updatedAt` | string (ISO) | Always present. |

`SchedulerConversationAdminFacet` ([`scheduler-data.ts:39-44`](../../../src/lib/ai/scheduler-data.ts)): `{ email: string|null, name: string|null, count: number, pendingLineCount: number }`, keyed by `createdByEmail` (null creators bucket under an internal `__unassigned__` key but still report `email: null`) and sorted by display name. **Facets are computed after the `q` filter but before the owner filter** ([`scheduler-data.ts:288-307`](../../../src/lib/ai/scheduler-data.ts)), so they keep describing every admin while `conversations` is narrowed to one.

**Status codes:**

| Status | When |
|--------|------|
| 200 | List returned. |
| 400 | `sort` is not one of the four accepted values (`{"error":"Invalid sort"}`). |
| 401 | No session. |
| 403 | Middleware page-access denial for a restricted user (not emitted by the handler). |

### `POST /api/ai-scheduler/conversations`

Creates a manual (non-LINE) scheduler conversation. Handler: [`conversations/route.ts:54-77`](../../../src/app/api/ai-scheduler/conversations/route.ts).

**Auth:** session required ([`route.ts:55-58`](../../../src/app/api/ai-scheduler/conversations/route.ts)).

**Request body** — `createConversationSchema`, `.strict()` ([`route.ts:12-18`](../../../src/app/api/ai-scheduler/conversations/route.ts)). Every field is optional, so `{}` is valid:

| Field | Type | Constraints |
|-------|------|-------------|
| `title` | string | trimmed, 1–120 chars |
| `customerParentName` | string | trimmed, ≤120 |
| `customerStudentName` | string | trimmed, ≤120 |
| `customerContact` | string | trimmed, ≤160 |
| `notes` | string | ≤4000 (not trimmed) |

**Side effects:** one insert into `ai_scheduler_conversations` via `createSchedulerConversation` ([`scheduler-data.ts:339-362`](../../../src/lib/ai/scheduler-data.ts)). A blank or absent `title` becomes `"Untitled scheduler chat"`; blank customer fields become `null`; absent `notes` becomes `""`; `createdByEmail`/`createdByName` come from the session; `status` (`active`) and `extractedState` (`{}`) come from the DB defaults.

**Response 201** — `{ "conversation": SchedulerConversationDto }` ([`route.ts:76`](../../../src/app/api/ai-scheduler/conversations/route.ts)). The DTO is built without LINE stats, so a freshly created conversation always reports `source: "manual"` with zeroed rollups.

**Status codes:**

| Status | When |
|--------|------|
| 201 | Conversation created. |
| 400 | Unparseable JSON, or Zod failure (unknown key, over-length field, empty `title`). |
| 401 | No session. |
| 403 | Middleware page-access denial for a restricted user. |

---

## Single conversation

All three handlers live in [`conversations/[conversationId]/route.ts`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts) and share `ConversationRouteContext` (`params: Promise<{ conversationId: string }>`), resolved by `conversationIdFromContext` ([`route.ts:19-24`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)).

### `GET /api/ai-scheduler/conversations/[conversationId]`

Fetches one conversation plus its full message history. Handler: [`route.ts:26-42`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts).

**Auth:** session required ([`route.ts:30-33`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)).

**Request:** no query parameters, no body.

**Side effects:** none.

**Response 200** — `{ conversation: SchedulerConversationDto, messages: SchedulerMessageDto[] }` from `getSchedulerConversationWithMessages` ([`scheduler-data.ts:376-393`](../../../src/lib/ai/scheduler-data.ts)). Messages are ordered by `createdAt` ascending and are **not** paginated. The conversation DTO here is built without LINE stats ([`scheduler-data.ts:364-374`](../../../src/lib/ai/scheduler-data.ts)), so `source` is always `"manual"` and the LINE rollups are zero/null even for a LINE-originated conversation — only the list endpoint populates them.

`SchedulerMessageDto` ([`scheduler-data.ts:51-62`](../../../src/lib/ai/scheduler-data.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (UUID) | |
| `conversationId` | string (UUID) | |
| `role` | `"admin"` \| `"parent"` \| `"assistant"` \| `"system"` | |
| `content` | string | |
| `structuredPayload` | object \| null | Assistant turns carry the solver payload; failed turns carry `{ error }`. |
| `model` | string \| null | Model id recorded on assistant turns. |
| `latencyMs` | number \| null | |
| `createdByEmail` / `createdByName` | string \| null | Assistant rows use `email: null`, `name: "AI Scheduler"`. |
| `createdAt` | string (ISO) | |

**Status codes:**

| Status | When |
|--------|------|
| 200 | Conversation + messages returned. |
| 401 | No session. |
| 403 | Middleware page-access denial for a restricted user. |
| 404 | `{"error":"Conversation not found"}` — no row with that id ([`route.ts:37-39`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)). |

### `PATCH /api/ai-scheduler/conversations/[conversationId]`

Updates editable conversation fields, including archive status. Handler: [`route.ts:44-75`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts).

**Auth:** session required ([`route.ts:48-51`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)).

**Request body** — `patchConversationSchema`, `.strict()` ([`route.ts:10-17`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)). All fields optional; `{}` is accepted and still bumps `updatedAt`:

| Field | Type | Constraints |
|-------|------|-------------|
| `title` | string | trimmed, 1–120 |
| `customerParentName` | string \| null | trimmed, ≤120 |
| `customerStudentName` | string \| null | trimmed, ≤120 |
| `customerContact` | string \| null | trimmed, ≤160 |
| `notes` | string | ≤4000 |
| `status` | `"active"` \| `"archived"` | |

`extractedState` is **not** patchable through this route even though the data layer accepts it ([`scheduler-data.ts:395-407`](../../../src/lib/ai/scheduler-data.ts)); it is written only by the messages turn.

**Side effects:** one `UPDATE` via `patchSchedulerConversation` ([`scheduler-data.ts:395-429`](../../../src/lib/ai/scheduler-data.ts)). Only supplied keys are written, and `updatedAt` is always set to now. A blank `title` collapses to `"Untitled scheduler chat"`; blank customer strings collapse to `null`. Setting `status: "archived"` also sets `archivedAt = now()`; setting `status: "active"` clears `archivedAt` back to `null` ([`scheduler-data.ts:418-421`](../../../src/lib/ai/scheduler-data.ts)).

**Response 200** — `{ "conversation": SchedulerConversationDto }` ([`route.ts:74`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)), again without LINE rollups.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Updated. |
| 400 | Unparseable JSON, or Zod failure. |
| 401 | No session. |
| 403 | Middleware page-access denial for a restricted user. |
| 404 | `{"error":"Conversation not found"}` — the `UPDATE … RETURNING` matched no row ([`route.ts:70-72`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)). |

### `DELETE /api/ai-scheduler/conversations/[conversationId]`

Archives a conversation. **This is a soft delete** — the row, its messages, runs, and feedback are all retained. Handler: [`route.ts:77-93`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts).

**Auth:** session required ([`route.ts:81-84`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)).

**Request:** no query parameters, no body.

**Side effects:** delegates to `patchSchedulerConversation(db, conversationId, { status: "archived" })` ([`route.ts:87`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)) — sets `status = "archived"`, `archivedAt = now()`, `updatedAt = now()`. The conversation drops out of the default list read but is restorable with `PATCH { "status": "active" }`, and the messages route refuses further turns while it is archived.

**Response 200** — `{ "conversation": SchedulerConversationDto }` with `status: "archived"` ([`route.ts:92`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Archived. |
| 401 | No session. |
| 403 | Middleware page-access denial for a restricted user. |
| 404 | `{"error":"Conversation not found"}` ([`route.ts:88-90`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)). |

---

## Conversation messages (the AI turn)

### `POST /api/ai-scheduler/conversations/[conversationId]/messages`

Appends an admin message and runs exactly one AI scheduling turn: OpenAI extracts and merges conversation state, then the **app** (not the model) solves availability against the in-memory snapshot index. Persists both messages plus a run-log row. Handler: [`messages/route.ts:50-191`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts).

**Auth:** session required ([`route.ts:54-57`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)).

**Configuration gate:** returns `503 {"error":"AI scheduler is not configured"}` before the body is even read when `isAiSchedulerConfigured()` is false ([`route.ts:59-61`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)) — that helper requires `ENABLE_AI_SCHEDULER !== "false"` **and** a non-empty `OPENAI_API_KEY` ([`scheduler.ts:477-480`](../../../src/lib/ai/scheduler.ts)).

**Request body** — `sendMessageSchema`, `.strict()` ([`route.ts:19-21`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)):

| Field | Type | Constraints |
|-------|------|-------------|
| `content` | string (**required**) | trimmed, 1–8000 chars |

**Preconditions** (checked after validation, [`route.ts:78-86`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)):

1. The conversation must exist → else `404 {"error":"Conversation not found"}`.
2. Its `status` must not be `archived` → else `409 {"error":"Archived conversations cannot receive new messages"}`.

**Side effects, in order:**

1. **Insert the admin message** — `role: "admin"`, `content` = the validated body, actor = caller ([`route.ts:91-96`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)). This write lands *before* the AI call, so it survives an AI failure.
2. **Run the turn** — `executeSchedulerTurn` ([`scheduler-service.ts:48-107`](../../../src/lib/ai/scheduler-service.ts)): `ensureIndex(db)` warms or reuses the snapshot search index, `listActiveProposalHolds(db)` is kicked off in parallel, `extractSchedulerStateWithOpenAi` calls OpenAI's Responses API (`store: false`, strict `json_schema` output, reasoning effort from env — [`scheduler-conversation.ts:2346-2376`](../../../src/lib/ai/scheduler-conversation.ts)) with the whole transcript (existing messages + the new admin message) and the conversation's saved `extractedState` as `currentState`, `mergeSchedulerState` merges old + new, and `solveSchedulerTurn` computes suggestions from the index. Per-stage `dbMs`/`modelMs`/`searchMs`/`totalMs` are measured here.
3. **Insert the assistant message** — `role: "assistant"`, `content` = `assistantResult.assistantMessage`, `model` = `aiSchedulerModel()`, `latencyMs` = wall time since the handler started, actor `{ email: null, name: "AI Scheduler" }` ([`route.ts:113-121`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)). Its `structuredPayload` is the assistant result with `extractedState` overwritten by the **raw model extraction** `extraction.state` ([`route.ts:109-112`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)) — not the resolved state that gets persisted on the conversation in step 4. The payload is round-tripped through `JSON.parse(JSON.stringify(…))` (`asRecord`, [`route.ts:32-34`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)), so `undefined` fields are dropped.
4. **Touch the conversation** — `touchSchedulerConversationAfterMessage` bumps `lastMessageAt`/`updatedAt`, stores `assistantResult.state` (the *resolved* state) as `extractedState`, and copies `parentName`/`studentName`/`contact` off it ([`route.ts:123-132`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)). Those copies apply only when truthy, so an empty value never blanks an existing field ([`scheduler-data.ts:446-450`](../../../src/lib/ai/scheduler-data.ts)). Auto-titling fires **only** when the current title is exactly `"Untitled scheduler chat"`, using the model's `title` or the deterministic `buildConversationTitle` ([`scheduler-conversation.ts:2258-2269`](../../../src/lib/ai/scheduler-conversation.ts)).
5. **Log the run** — `logSchedulerRun` inserts into `ai_scheduler_runs` with `status: "solved"` when `assistantResult.parentReady` is true, else `"needs_clarification"`. `inputPreviewRedacted` is the body scrubbed of emails, phone-shaped runs, and 8+ digit numbers, then truncated to 600 chars (`redactAiSchedulerInput`, [`scheduler.ts:439-450`](../../../src/lib/ai/scheduler.ts)); `schedulerVersion`/`promptVersion` are the constants at [`scheduler-service.ts:20-21`](../../../src/lib/ai/scheduler-service.ts) supplied via `schedulerRunMetadata`; `parsedPayload` = the extraction, `solverPayload` = the assistant payload, plus `warnings` ([`route.ts:133-145`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)).

**Model selection:** `aiSchedulerModel()` returns `OPENAI_SCHEDULER_MODEL` when set, else `DEFAULT_AI_SCHEDULER_MODEL = "gpt-5.4-mini"` ([`scheduler.ts:8,461-463`](../../../src/lib/ai/scheduler.ts)). Reasoning effort comes from `OPENAI_SCHEDULER_REASONING_EFFORT`, defaulting to `"low"` ([`scheduler.ts:9,469-475`](../../../src/lib/ai/scheduler.ts)). None of these are part of the request contract.

**Response 200** ([`route.ts:147-152`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `conversation` | `SchedulerConversationDto` | Post-touch state (no LINE rollups). |
| `messages` | `[SchedulerMessageDto, SchedulerMessageDto]` | `[adminMessage, assistantMessage]` — only this turn's two rows, never the history. |
| `assistantResult` | `SchedulerAssistantResult` | See below. |
| `logId` | string | `ai_scheduler_runs.id`, or `"unlogged"` when the log insert failed. |

`SchedulerAssistantResult` ([`scheduler-conversation.ts:209-226`](../../../src/lib/ai/scheduler-conversation.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `state` | `SchedulerResolvedState` | The merged state with required defaults filled in ([`scheduler-conversation.ts:85-101`](../../../src/lib/ai/scheduler-conversation.ts)). |
| `suggestions` | `SchedulerSuggestion[]` | Ranked slots — `id`, `rank`, `searchMode`, `dayOfWeek`/`date`, `start`/`end`, `durationMinutes`, `mode`, `subject`, `confidence` (`"Best fit"` \| `"Strong fit"` \| `"Good fit"`), `tutors[]`, `availableTutorCount`, `reasons[]`, `parentReady`, `requestedSlotId` ([`scheduler-conversation.ts:127-144`](../../../src/lib/ai/scheduler-conversation.ts)). |
| `availabilitySummary` | object \| omitted | `dateRange`, `filters`, `searchedFilters[]`, `subjectIntent`, `durationMinutes`, `mode`, `tutors[]`, `needsReview[]`, and `searchProvenance` = `{ snapshotId, profileVersion, activeProposalHoldCount }` ([`scheduler-conversation.ts:169-183`](../../../src/lib/ai/scheduler-conversation.ts)). |
| `constraintLedger` | `SchedulerConstraintLedgerItem[]` | One row per constraint (`search_mode`, `slot`, `date_range`, `duration`, `delivery_mode`, `academic_filter`, `subject_requests`, `tutor_include`, `tutor_exclude`, `business_requirement`, `negative_feedback`) with `label`, `requested`, `normalized`, `evidence` (`model` \| `deterministic` \| `default` \| `not_provided`), `status` (`proven` \| `needs_clarification` \| `not_applicable`), `message` ([`scheduler-conversation.ts:185-207`](../../../src/lib/ai/scheduler-conversation.ts)). |
| `latencyBreakdownMs` | `{ totalMs, dbMs, modelMs, searchMs }` | Attached by `executeSchedulerTurn` ([`scheduler-service.ts:101-105`](../../../src/lib/ai/scheduler-service.ts)). |
| `parentMessageDraft` | string | Copy-ready parent reply. |
| `assistantMessage` | string | Mirrors the persisted assistant `content`. |
| `snapshotMeta` | `{ snapshotId, syncedAt, stale }` | [`search/types.ts:30-34`](../../../src/lib/search/types.ts). |
| `warnings` / `questions` | string[] | |
| `parentReady` | boolean | Drives the run `status` (`solved` vs `needs_clarification`). |

**AI failure path** ([`route.ts:153-190`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)) — if `executeSchedulerTurn` throws, the already-persisted admin message is kept and the route still writes: a fallback assistant message (`"I could not process that message. Please try again or use the manual search while I recover."`, `structuredPayload: { error }`), a conversation touch (timestamps only), and a run log with `status: "failed"`, `errorMessage`, and a latency breakdown zeroed apart from `totalMs`. It then returns:

```
502 { "error": "AI scheduling failed", "detail": "<error message>",
      "messages": [adminMessage, assistantMessage], "logId": "<run id|unlogged>" }
```

**Status codes:**

| Status | When |
|--------|------|
| 200 | Turn completed. |
| 400 | Unparseable JSON, or `content` missing/empty/over 8000 chars/accompanied by an unknown key. |
| 401 | No session. |
| 403 | Middleware page-access denial for a restricted user. |
| 404 | Conversation does not exist. |
| 409 | Conversation is archived. |
| 502 | The AI turn threw (OpenAI error, index build failure, solver error). |
| 503 | `ENABLE_AI_SCHEDULER === "false"` or no `OPENAI_API_KEY`. |

---

## Feedback

### `POST /api/ai-scheduler/messages/[messageId]/feedback`

Records staff review of an assistant message — accept, edit, or reject — as one append-only `ai_scheduler_feedback` row. This is the input to the correction telemetry surfaced by the metrics endpoint. Handler: [`feedback/route.ts:41-78`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts).

**Auth:** session required ([`route.ts:42-45`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)).

**Path param:** `messageId` ([`route.ts:32`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts), awaited at [`route.ts:62`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)). Not validated by the route; it is written to a UUID FK column referencing `ai_scheduler_messages.id` ([`schema.ts:2410`](../../../src/lib/db/schema.ts)), so a malformed or unknown id fails at the database and surfaces as an untyped 500.

**Request body** — `feedbackSchema`, a Zod **discriminated union on `action`**; each variant is `.strict()` ([`route.ts:7-30`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)):

| `action` | Optional fields | Required fields |
|----------|-----------------|-----------------|
| `"accept"` ([`route.ts:8-14`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)) | `conversationId` (uuid\|null), `schedulerRunId` (uuid\|null), `selectedTutorIds` (string[], each ≥1 char, ≤12 items), `editedParentDraft` (≤5000\|null) | — |
| `"edit"` ([`route.ts:15-21`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)) | `conversationId`, `schedulerRunId`, `selectedTutorIds` | `editedParentDraft` (trimmed, 1–5000) |
| `"reject"` ([`route.ts:22-29`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)) | `conversationId`, `schedulerRunId`, `rejectedTutorIds` (string[], ≤12) | `rejectionReason` (trimmed, 1–500), `staffCorrection` (trimmed, 1–5000) |

Notes on the union: `selectedTutorIds` is not accepted on `reject`, and `rejectedTutorIds` is not accepted on `accept`/`edit` — `.strict()` rejects the mismatch. The data layer's fourth action `"dismiss"` ([`scheduler-data.ts:71`](../../../src/lib/ai/scheduler-data.ts)) is **not** reachable through this route, and `lineReviewId` / `classifierConfidence` / `timeToReviewMs` are never set here — those columns are written only by the LINE review service ([`review-service.ts:517,548,592,627`](../../../src/lib/line/review-service.ts)). Feedback filed through this endpoint therefore always lands in the `unknown` confidence band of the telemetry rollup.

**Side effects:** one insert via `createSchedulerFeedback` ([`scheduler-data.ts:535-574`](../../../src/lib/ai/scheduler-data.ts)). Fields absent from the chosen variant are passed as `undefined` and fall back to `[]` for the two id arrays and `null` for the text columns; text values are trimmed and blank-collapsed to `null`; the actor email is lowercased. Nothing else is mutated — the assistant message, conversation, and run row are left untouched.

**Response 200** — `{ "feedback": SchedulerFeedbackDto }` ([`route.ts:77`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)). `SchedulerFeedbackDto` ([`scheduler-data.ts:73-90`](../../../src/lib/ai/scheduler-data.ts)): `id`, `conversationId`, `messageId`, `schedulerRunId`, `action`, `selectedTutorIds[]`, `rejectedTutorIds[]`, `editedParentDraft`, `rejectionReason`, `staffCorrection`, `lineReviewId`, `classifierConfidence`, `timeToReviewMs`, `createdByEmail`, `createdByName`, `createdAt` (ISO).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Feedback recorded. |
| 400 | Unparseable JSON; unknown/missing `action`; a variant's required field missing; unknown key; array over 12 items; string over its cap. |
| 401 | No session. |
| 403 | Middleware page-access denial for a restricted user. |

---

## Metrics

### `GET /api/ai-scheduler/metrics`

Read-only observability rollup across AI scheduler runs, LINE scheduler review outcomes, and correction telemetry. Handler: [`metrics/route.ts:8-22`](../../../src/app/api/ai-scheduler/metrics/route.ts).

**Auth:** session required ([`route.ts:9-12`](../../../src/app/api/ai-scheduler/metrics/route.ts)).

**Request:** none. The handler signature is `GET()` with no `request` argument ([`route.ts:8`](../../../src/app/api/ai-scheduler/metrics/route.ts)), so query parameters are structurally ignored — there is no window, date, or pagination filtering.

**Side effects:** none. The three aggregators run in parallel under `Promise.all` ([`route.ts:15-19`](../../../src/app/api/ai-scheduler/metrics/route.ts)).

**Response 200** — `{ scheduler, line, correction }`.

`scheduler` — `AiSchedulerMetrics` ([`scheduler-metrics.ts:5-26`](../../../src/lib/ai/scheduler-metrics.ts)), computed over the **most recent 500 rows** of `ai_scheduler_runs` ([`scheduler-metrics.ts:66-81`](../../../src/lib/ai/scheduler-metrics.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `totalRuns` | number | Size of the 500-row window, not the lifetime total. |
| `solvedRuns` / `needsClarificationRuns` / `failedRuns` | number | Counts by run `status`. |
| `parentReadyConstraintFailures` | number | Runs marked `solved` whose `solverPayload.constraintLedger` still holds a `needs_clarification` item — the quality alarm ([`scheduler-metrics.ts:50-59`](../../../src/lib/ai/scheduler-metrics.ts)). |
| `latency` | object | `p50Ms`, `p95Ms`, `averageMs` (from `latencyMs`), plus `averageDbMs`/`averageModelMs`/`averageSearchMs` (from the stored `latencyBreakdown`). All `number \| null`; averages are rounded. |
| `versions` | `{ schedulerVersion, promptVersion, count }[]` | Missing values report `"unknown"`; sorted by count desc. |
| `recentFailures` | array (≤10) | `{ id, createdAt, errorMessage, inputPreviewRedacted }` for the newest failed runs. |

`line` — `LineSchedulerAnalytics` from `getLineSchedulerAnalytics` ([`line/data.ts:173-195`](../../../src/lib/line/data.ts), computed at [`line/data.ts:1171`](../../../src/lib/line/data.ts)): classifier counts (`classifiedMessages`, `schedulingMessages`, `nonSchedulingMessages`, `unclearMessages`), review outcomes (`pendingReviews`, `approvedSent`, `acceptedNoSend`, `rejected`, `dismissed`), `rejectionRate`, `averageEditDistance`, `averageModelLatencyMs`, the classification-accuracy fields (`classificationReviewedMessages`, `classificationAccuracy`, `classificationFalsePositives`, `classificationFalseNegatives`, `classificationReviewCoverage`), `unverifiedLinkBacklog`, `commonRejectionReasons[]`, `commonRejectionCategories[]`, and `feedbackLabels[]`.

`correction` — `CorrectionTelemetry` ([`correction-telemetry.ts:18-27`](../../../src/lib/ai/correction-telemetry.ts)), computed over the **most recent 5000 rows** of `ai_scheduler_feedback` ([`correction-telemetry.ts:48-56`](../../../src/lib/ai/correction-telemetry.ts)): `totalActions`; `acceptRate` / `editRate` / `rejectRate` / `dismissRate` as 0–1 fractions (0 when there are no rows); `avgTimeToReviewMs` and `p50TimeToReviewMs` (`null` when no row carries a review time); and `confidenceByOutcome[]` — per-band `{ band, accept, edit, reject, dismiss, total }` in the fixed order `high`, `medium`, `low`, `unknown`, with empty bands omitted ([`correction-telemetry.ts:75-78`](../../../src/lib/ai/correction-telemetry.ts)). Bands come from `confidenceBand`: `≥0.85` high, `≥0.6` medium, else low; a null/NaN confidence becomes `unknown` ([`line/confidence.ts:5-10`](../../../src/lib/line/confidence.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Metrics returned. |
| 401 | No session. |
| 403 | Middleware page-access denial for a restricted user. |

---

## Status code summary

| Endpoint | 200 | 201 | 400 | 401 | 404 | 409 | 502 | 503 |
|----------|-----|-----|-----|-----|-----|-----|-----|-----|
| `GET /api/ai-scheduler/conversations` | ✓ | | ✓ (invalid `sort`) | ✓ | | | | |
| `POST /api/ai-scheduler/conversations` | | ✓ | ✓ | ✓ | | | | |
| `GET /api/ai-scheduler/conversations/[conversationId]` | ✓ | | | ✓ | ✓ | | | |
| `PATCH /api/ai-scheduler/conversations/[conversationId]` | ✓ | | ✓ | ✓ | ✓ | | | |
| `DELETE /api/ai-scheduler/conversations/[conversationId]` | ✓ | | | ✓ | ✓ | | | |
| `POST /api/ai-scheduler/conversations/[conversationId]/messages` | ✓ | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `POST /api/ai-scheduler/messages/[messageId]/feedback` | ✓ | | ✓ | ✓ | | | | |
| `GET /api/ai-scheduler/metrics` | ✓ | | | ✓ | | | | |

Every endpoint can additionally return a middleware `403 {"error":"Forbidden"}` for a restricted user, and an uncaught data-layer error produces a framework `500` with no typed body (see [Conventions](#conventions-shared-across-the-endpoints)).

## In-repo clients and tests

- **UI callers.** [`scheduler-workspace.tsx`](../../../src/components/scheduler/scheduler-workspace.tsx) drives seven of the eight: list (`:1605`), detail (`:1664`), debounced detail autosave via `PATCH` (`:1691`), create (`:1724`, `:1774`), archive via `DELETE` (`:1742`), send message (`:1811`), and feedback (`:837`). [`metrics-view.tsx:57`](../../../src/components/scheduler/metrics-view.tsx) calls the metrics endpoint and reads **only** the `correction` slice of the response.
- **Route tests.** [`conversations/__tests__/route.test.ts`](../../../src/app/api/ai-scheduler/conversations/__tests__/route.test.ts) covers the 401, the query-filter pass-through with admin facets, the `scope=mine` shortcut, the invalid-`sort` 400, and the 201 create. [`messages/__tests__/route.test.ts`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/__tests__/route.test.ts) covers the solved turn end to end — both message inserts, the run log with `status: "solved"` and the version/latency metadata, and the `{ logId, messages }` body. [`feedback/__tests__/route.test.ts`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/__tests__/route.test.ts) covers the 401, the accept path, and the 400 when a `reject` omits `rejectionReason`/`staffCorrection`. The single-conversation route and the metrics route have no dedicated route tests.

_Verified against HEAD + uncommitted WIP on 2026-05-31._
