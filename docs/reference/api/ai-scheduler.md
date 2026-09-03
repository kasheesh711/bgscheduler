# AI Scheduler API

**Authoritative source:** the five route files under [`src/app/api/ai-scheduler/`](../../../src/app/api/ai-scheduler/), backed by the data layer [`src/lib/ai/scheduler-data.ts`](../../../src/lib/ai/scheduler-data.ts), the turn orchestrator [`src/lib/ai/scheduler-service.ts`](../../../src/lib/ai/scheduler-service.ts), the prompt + deterministic solver [`src/lib/ai/scheduler-conversation.ts`](../../../src/lib/ai/scheduler-conversation.ts), and the two read-only aggregators [`scheduler-metrics.ts`](../../../src/lib/ai/scheduler-metrics.ts) / [`correction-telemetry.ts`](../../../src/lib/ai/correction-telemetry.ts).

Feature status: **experimental**. This page is the mechanical reference for the eight AI Scheduler HTTP endpoints — method, path, auth, request shape, response shape, side effects, status codes. What a scheduler conversation *means*, why the model never decides availability, and how staff corrections feed telemetry live in [docs/features/ai-scheduler.md](../../features/ai-scheduler.md).

Backing tables (column detail in the [database reference](../database/index.md)): `ai_scheduler_conversations` ([`schema.ts:2347-2366`](../../../src/lib/db/schema.ts)), `ai_scheduler_messages` ([`schema.ts:2368-2384`](../../../src/lib/db/schema.ts)), `ai_scheduler_runs` ([`schema.ts:2386-2408`](../../../src/lib/db/schema.ts)), `ai_scheduler_feedback` ([`schema.ts:2410-2433`](../../../src/lib/db/schema.ts)).

## Endpoint index

| Method | Path | Purpose | Handler |
|--------|------|---------|---------|
| `GET` | `/api/ai-scheduler/conversations` | List conversations + per-admin facets | [`conversations/route.ts:27-52`](../../../src/app/api/ai-scheduler/conversations/route.ts) |
| `POST` | `/api/ai-scheduler/conversations` | Create an empty conversation | [`conversations/route.ts:54-77`](../../../src/app/api/ai-scheduler/conversations/route.ts) |
| `GET` | `/api/ai-scheduler/conversations/[conversationId]` | One conversation + its full message list | [`[conversationId]/route.ts:26-42`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts) |
| `PATCH` | `/api/ai-scheduler/conversations/[conversationId]` | Edit customer details / notes / title / status | [`[conversationId]/route.ts:44-75`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts) |
| `DELETE` | `/api/ai-scheduler/conversations/[conversationId]` | Archive (soft) — never deletes rows | [`[conversationId]/route.ts:77-93`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts) |
| `POST` | `/api/ai-scheduler/conversations/[conversationId]/messages` | Run one full scheduler turn | [`messages/route.ts:50-191`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts) |
| `POST` | `/api/ai-scheduler/messages/[messageId]/feedback` | Record accept / edit / reject on a draft | [`feedback/route.ts:41-78`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts) |
| `GET` | `/api/ai-scheduler/metrics` | Run, LINE and correction telemetry rollup | [`metrics/route.ts:8-22`](../../../src/app/api/ai-scheduler/metrics/route.ts) |

Eight endpoints across five files: the `[conversationId]` file exports three methods, `conversations/route.ts` exports two, and the remaining three files export one each.

## Conventions shared across the eight endpoints

- **Auth — any signed-in session, nothing finer.** Every handler calls `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and returns `401 {"error":"Unauthorized"}` when the session is falsy ([`conversations/route.ts:28-31,55-58`](../../../src/app/api/ai-scheduler/conversations/route.ts), [`[conversationId]/route.ts:30-33,48-51,81-84`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts), [`messages/route.ts:54-57`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts), [`feedback/route.ts:42-45`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts), [`metrics/route.ts:9-12`](../../../src/app/api/ai-scheduler/metrics/route.ts)). No handler checks role, email, or conversation ownership — **any signed-in user who reaches these routes can read, edit, archive, and post into every conversation**, including ones another admin created. Ownership (`created_by_email`) is recorded for display and filtering only.
- **Middleware runs first.** `/api/ai-scheduler/**` is absent from the public-route allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before any handler runs; the in-handler `auth()` is the API-level backstop. For a *restricted* user (`allowedPages` non-null) the middleware matches the path as both a page and its `/api` namespace and returns `403 {"error":"Forbidden"}` on an unmatched `/api/**` path ([`middleware.ts:36-67,96-100`](../../../src/middleware.ts)). The scheduler page is `/scheduler` ([`tools.ts:95-96`](../../../src/lib/navigation/tools.ts)), which grants `/api/scheduler` — **not** `/api/ai-scheduler`. A page-restricted user granted `["/scheduler"]` therefore loads the page and gets a middleware 403 on every call it makes. Full-access admins (`allowedPages: null`) pass through.
- **Actor stamping.** The four write endpoints derive `{ email, name }` from `session.user` via a locally duplicated `actorFromSession` helper ([`conversations/route.ts:20-25`](../../../src/app/api/ai-scheduler/conversations/route.ts), [`messages/route.ts:25-30`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts), [`feedback/route.ts:34-39`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)). `normalizeActor` lowercases and trims the email and trims the name, storing `null` for blanks ([`scheduler-data.ts:186-191`](../../../src/lib/ai/scheduler-data.ts)) — so all owner filtering is case-insensitive by construction.
- **Body handling is uniform on the four `POST`/`PATCH` endpoints.** `request.json()` in a try/catch → `400 {"error":"Invalid JSON"}`; then a module-scope Zod `.safeParse()` → `400 {"error":"Invalid request","details": <parsed.error.flatten()>}`. Every body schema is `.strict()`, so an unknown key is a 400, not a silently ignored field.
- **Nothing is transactional, nothing is cached, nothing touches Wise.** No route file exports `maxDuration`, `runtime`, `dynamic`, or `revalidate`, and none calls `revalidateTag` (verified by absence — grep over `src/app/api/ai-scheduler/` returns no match). The message route in particular performs four sequential writes with no rollback (see [below](#post-apiai-schedulerconversationsconversationidmessages)). No endpoint issues a Wise mutation; the scheduler is read-only toward Wise and writes only these four local tables.
- **No handler-level try/catch on the DB path.** Only the message route wraps business logic; the other seven let a driver or query error propagate, which surfaces as a framework **500** with no `{ error }` envelope of this app's own making. That is a deliberate deviation from the repo-wide 4-step route convention.
- **Configuration gate applies to exactly one endpoint.** `isAiSchedulerConfigured()` is `ENABLE_AI_SCHEDULER !== "false" && Boolean(OPENAI_API_KEY)` — opt-*out*, not opt-in ([`scheduler.ts:477-480`](../../../src/lib/ai/scheduler.ts)). Only `POST .../messages` checks it (503). Neither variable is declared in [`src/lib/env.ts`](../../../src/lib/env.ts); both are read straight from `process.env`, as are `OPENAI_SCHEDULER_MODEL` ([`scheduler.ts:461-463`](../../../src/lib/ai/scheduler.ts)) and `OPENAI_SCHEDULER_REASONING_EFFORT` ([`scheduler.ts:470`](../../../src/lib/ai/scheduler.ts)).

### The conversation DTO

Six endpoints return a conversation object. It is built by `conversationToDto` ([`scheduler-data.ts:121-144`](../../../src/lib/ai/scheduler-data.ts)); the TypeScript shape is `SchedulerConversationDto` ([`scheduler-data.ts:16-37`](../../../src/lib/ai/scheduler-data.ts)). Referenced below as **the conversation DTO**.

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (UUID) | |
| `title` | string | Defaults to `"Untitled scheduler chat"` ([`schema.ts:2349`](../../../src/lib/db/schema.ts)); the message route auto-titles off this exact sentinel. |
| `status` | `"active"` \| `"archived"` | |
| `source` | `"line"` \| `"manual"` | Derived, **not stored** — `"line"` only when at least one `line_scheduler_reviews` row points at the conversation ([`scheduler-data.ts:248-271`](../../../src/lib/ai/scheduler-data.ts)). |
| `pendingLineReviewCount` | number | Reviews with `status = "pending_review"`. |
| `latestLineReviewStatus` | string \| null | Status of the most recently updated linked review. |
| `needsStudentLink` | boolean | True when a pending review has no verified student key, no verified contact link, and no `studentLinkOverride` ([`scheduler-data.ts:265-268`](../../../src/lib/ai/scheduler-data.ts)). |
| `oldestPendingLineReviewAt` | string (ISO) \| null | |
| `latestLineReviewAt` | string (ISO) \| null | |
| `customerParentName` / `customerStudentName` / `customerContact` | string \| null | |
| `notes` | string | `NOT NULL DEFAULT ''` — never null. |
| `extractedState` | object | Accumulated `SchedulerExtractedState` ([`scheduler-conversation.ts:57-83`](../../../src/lib/ai/scheduler-conversation.ts)); `{}` when unset. This is the memory replayed into the next turn's prompt. |
| `createdByEmail` / `createdByName` | string \| null | Lowercased email. |
| `archivedAt` | string (ISO) \| null | |
| `lastMessageAt` / `createdAt` / `updatedAt` | string (ISO) | |

**The six line-derived fields are only populated by the list endpoint.** `getSchedulerConversation` calls `conversationToDto(row)` with no line stats ([`scheduler-data.ts:373`](../../../src/lib/ai/scheduler-data.ts)), and so do `createSchedulerConversation` ([`:361`](../../../src/lib/ai/scheduler-data.ts)), `patchSchedulerConversation` ([`:428`](../../../src/lib/ai/scheduler-data.ts)) and `touchSchedulerConversationAfterMessage` ([`:457`](../../../src/lib/ai/scheduler-data.ts)). Every endpoint except `GET /api/ai-scheduler/conversations` therefore reports `source: "manual"`, `pendingLineReviewCount: 0`, `needsStudentLink: false` and three nulls — even for a LINE-sourced conversation with pending reviews.

### The message DTO

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (UUID) | |
| `conversationId` | string (UUID) | |
| `role` | `"admin"` \| `"parent"` \| `"assistant"` \| `"system"` | Enum column; this API only ever writes `admin` and `assistant`. |
| `content` | string | |
| `structuredPayload` | object \| null | Assistant turns carry the full solver output; see [the message endpoint](#post-apiai-schedulerconversationsconversationidmessages). |
| `model` | string \| null | Set on assistant rows only. |
| `latencyMs` | number \| null | Wall-clock for the whole turn, not just the model call. |
| `createdByEmail` / `createdByName` | string \| null | Assistant rows are stamped `{ email: null, name: "AI Scheduler" }` ([`messages/route.ts:120,162`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)). |
| `createdAt` | string (ISO) | |

Shape: `SchedulerMessageDto` ([`scheduler-data.ts:51-62`](../../../src/lib/ai/scheduler-data.ts)), built by `messageToDto` ([`:146-159`](../../../src/lib/ai/scheduler-data.ts)).

---

## Conversations collection

### `GET /api/ai-scheduler/conversations`

Lists conversations with LINE-review enrichment, client-side filtering, per-admin facets, and one of four sort modes. Handler: [`conversations/route.ts:27-52`](../../../src/app/api/ai-scheduler/conversations/route.ts).

**Auth:** session required.

**Query parameters** — read individually off `request.nextUrl.searchParams` ([`conversations/route.ts:33-41`](../../../src/app/api/ai-scheduler/conversations/route.ts)); only `sort` is validated.

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `includeArchived` | string | absent | Archived rows are included **only** on the exact string `"true"`; any other value falls back to `status = 'active'` ([`conversations/route.ts:33`](../../../src/app/api/ai-scheduler/conversations/route.ts), [`scheduler-data.ts:204-215`](../../../src/lib/ai/scheduler-data.ts)). |
| `scope` | string | absent | `"mine"` filters to the caller's own conversations; any other value is ignored ([`conversations/route.ts:34`](../../../src/app/api/ai-scheduler/conversations/route.ts)). |
| `ownerEmail` | string | null | Filters to one owner. **Takes precedence over `scope=mine`** ([`scheduler-data.ts:305`](../../../src/lib/ai/scheduler-data.ts)). Lowercased before comparison. |
| `sort` | enum | `"review_priority"` | `review_priority` \| `latest` \| `admin` \| `oldest_pending_line`, validated by `sortSchema` ([`conversations/route.ts:10`](../../../src/app/api/ai-scheduler/conversations/route.ts)). An unrecognized value returns `400 {"error":"Invalid sort"}` ([`:38-40`](../../../src/app/api/ai-scheduler/conversations/route.ts)) — the one endpoint whose 400 body has no `details`. |
| `q` | string | undefined | Case-insensitive substring match over `title`, `customerParentName`, `customerStudentName`, `customerContact`, `notes` ([`scheduler-data.ts:276-287`](../../../src/lib/ai/scheduler-data.ts)). |

**Query pipeline** ([`scheduler-data.ts:193-337`](../../../src/lib/ai/scheduler-data.ts)), in order:

1. Select conversations ordered by `lastMessageAt` desc, **`LIMIT 200`** ([`:204-215`](../../../src/lib/ai/scheduler-data.ts)) — the only SQL-side filter is `status = 'active'` when `includeArchived` is off.
2. Load every `line_scheduler_reviews` row whose `conversationId` is in that page, plus verified `line_contact_student_links` for the pending reviews' contacts ([`:218-246`](../../../src/lib/ai/scheduler-data.ts)) — two extra round trips, skipped when the page is empty.
3. Map to DTOs and apply `q` in JavaScript.
4. Build `adminFacets` from the **query-filtered but not owner-filtered** set ([`:288-303`](../../../src/lib/ai/scheduler-data.ts)), so the facet counts stay stable while the user switches owners.
5. Apply the owner filter, then sort in JavaScript.

Because the `LIMIT 200` is applied *before* `q` and the owner filter, a search over a busy tenant can miss older matches — the filters narrow one page, they do not scan the table.

**Sort semantics** ([`scheduler-data.ts:308-334`](../../../src/lib/ai/scheduler-data.ts)):

| `sort` | Ordering |
|--------|----------|
| `review_priority` (default) | Most pending LINE reviews first → `needsStudentLink` first → oldest pending review first → LINE-sourced before manual → newest `lastMessageAt`. |
| `latest` | `lastMessageAt` desc. |
| `admin` | Owner name (falling back to email) ascending, then `lastMessageAt` desc. |
| `oldest_pending_line` | Conversations with a pending review first, oldest first; the rest by `lastMessageAt` desc. |

**Side effects:** none — three reads.

**Response 200** — `{ conversations: SchedulerConversationDto[], adminFacets: SchedulerConversationAdminFacet[] }` ([`ListSchedulerConversationsResult`, `scheduler-data.ts:46-49`](../../../src/lib/ai/scheduler-data.ts)). This is the one endpoint whose conversation DTOs carry real LINE-review fields. Each facet is `{ email: string|null, name: string|null, count: number, pendingLineCount: number }` ([`:39-44`](../../../src/lib/ai/scheduler-data.ts)), sorted by display name; conversations with no owner collapse into a single `email: null` facet.

**Status codes:**

| Status | When |
|--------|------|
| 200 | `{ conversations, adminFacets }`. |
| 400 | `{"error":"Invalid sort"}` — unrecognized `sort` value. |
| 401 | No session. |
| 403 | Middleware page-access denial (not emitted by the handler). |
| 500 | Any thrown DB error — unwrapped, no `{ error }` envelope from this handler. |

---

### `POST /api/ai-scheduler/conversations`

Creates one empty conversation owned by the caller. Handler: [`conversations/route.ts:54-77`](../../../src/app/api/ai-scheduler/conversations/route.ts).

**Auth:** session required; the caller becomes `created_by_email` / `created_by_name`.

**Request body** — `createConversationSchema`, `.strict()` ([`conversations/route.ts:12-18`](../../../src/app/api/ai-scheduler/conversations/route.ts)). Every field is optional; `{}` is a valid body.

| Field | Type | Schema rule | Stored as |
|-------|------|-------------|-----------|
| `title` | string | `.trim().min(1).max(120)` | Trimmed, or `"Untitled scheduler chat"` when blank ([`scheduler-data.ts:351`](../../../src/lib/ai/scheduler-data.ts)). |
| `customerParentName` | string | `.trim().max(120)` | Trimmed, `null` when blank. |
| `customerStudentName` | string | `.trim().max(120)` | Trimmed, `null` when blank. |
| `customerContact` | string | `.trim().max(160)` | Trimmed, `null` when blank. |
| `notes` | string | `.max(4000)`, **not** trimmed | Stored verbatim; `""` when absent. |

**Side effects:** a single `INSERT ... RETURNING` into `ai_scheduler_conversations` ([`scheduler-data.ts:348-359`](../../../src/lib/ai/scheduler-data.ts)). `status` defaults to `active`, `extractedState` to `{}`, `lastMessageAt`/`createdAt`/`updatedAt` to `now()` (column defaults, [`schema.ts:2350-2361`](../../../src/lib/db/schema.ts)).

**Response 201** — `{ conversation: SchedulerConversationDto }` ([`conversations/route.ts:76`](../../../src/app/api/ai-scheduler/conversations/route.ts)). The only endpoint in this group that returns 201. LINE fields are placeholders (see [the DTO note](#the-conversation-dto)).

**Status codes:**

| Status | When |
|--------|------|
| 201 | Conversation created. |
| 400 | `{"error":"Invalid JSON"}`, or Zod `{"error":"Invalid request","details":…}` — including any unknown key, since the schema is `.strict()`. |
| 401 | No session. |
| 403 | Middleware page-access denial. |
| 500 | Unwrapped insert failure. |

---

## Single conversation

All three methods share `ConversationRouteContext` — `params` is a `Promise` under Next.js 16 and is awaited by `conversationIdFromContext` ([`[conversationId]/route.ts:19-24`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)).

**Path parameter (all three):** `conversationId`, compared against a `uuid` column. It is **not** format-validated in the handler, so a syntactically invalid UUID reaches Postgres as a `uuid` cast and surfaces as a **500**, not the 404 you would expect.

### `GET /api/ai-scheduler/conversations/[conversationId]`

Returns one conversation plus its complete message history. Handler: [`[conversationId]/route.ts:26-42`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts).

**Auth:** session required. No ownership check — any signed-in caller can read any conversation.

**Request:** path param only; no query params, no body.

**Side effects:** none — two reads ([`scheduler-data.ts:376-393`](../../../src/lib/ai/scheduler-data.ts)).

**Response 200** — `{ conversation: SchedulerConversationDto, messages: SchedulerMessageDto[] }`. Messages are ordered by `createdAt` ascending and **unpaginated**: there is no `LIMIT`, so the whole thread is returned every time ([`scheduler-data.ts:383-387`](../../../src/lib/ai/scheduler-data.ts)). The conversation's LINE fields are placeholders.

**Status codes:**

| Status | When |
|--------|------|
| 200 | `{ conversation, messages }`. |
| 401 | No session. |
| 403 | Middleware page-access denial. |
| 404 | `{"error":"Conversation not found"}` — no row with that id ([`:37-39`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)). |
| 500 | Malformed UUID, or any DB error. |

---

### `PATCH /api/ai-scheduler/conversations/[conversationId]`

Edits the human-owned fields of a conversation. Handler: [`[conversationId]/route.ts:44-75`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts).

**Auth:** session required. Note that unlike `POST`, **the actor is not recorded** — `patchSchedulerConversation` takes no actor and does not touch `created_by_*`, so an edit by a second admin leaves no trace beyond `updatedAt`.

**Request body** — `patchConversationSchema`, `.strict()` ([`[conversationId]/route.ts:10-17`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)). All fields optional; each is applied only when the key is *present*, so `{}` is a valid no-op body that still bumps `updatedAt`.

| Field | Type | Schema rule | Effect ([`scheduler-data.ts:412-421`](../../../src/lib/ai/scheduler-data.ts)) |
|-------|------|-------------|--------|
| `title` | string | `.trim().min(1).max(120)` | Trimmed; falls back to `"Untitled scheduler chat"`. |
| `customerParentName` | string \| null | `.trim().max(120)`, nullable | Trimmed; blank or `null` → `null`. |
| `customerStudentName` | string \| null | `.trim().max(120)`, nullable | Same. |
| `customerContact` | string \| null | `.trim().max(160)`, nullable | Same. |
| `notes` | string | `.max(4000)` | Stored verbatim, untrimmed. |
| `status` | `"active"` \| `"archived"` | enum | Sets `status`; `archivedAt = now()` for `archived`, `null` for `active`. **This is how a conversation is un-archived** — there is no dedicated restore endpoint. |

`extractedState` is patchable at the data layer ([`scheduler-data.ts:404,417`](../../../src/lib/ai/scheduler-data.ts)) but is **not** in the route schema, so the API cannot rewrite scheduler memory — only a turn can.

**Side effects:** one `UPDATE ... RETURNING` with `updatedAt = now()` ([`scheduler-data.ts:408-427`](../../../src/lib/ai/scheduler-data.ts)). `lastMessageAt` is untouched, so editing details does not reorder the default list.

**Response 200** — `{ conversation: SchedulerConversationDto }` ([`:74`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)). LINE fields are placeholders.

**Status codes:**

| Status | When |
|--------|------|
| 200 | `{ conversation }`. |
| 400 | `{"error":"Invalid JSON"}`, or Zod `{"error":"Invalid request","details":…}`. |
| 401 | No session. |
| 403 | Middleware page-access denial. |
| 404 | `{"error":"Conversation not found"}` — the `UPDATE` matched no row ([`:70-72`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)). |
| 500 | Malformed UUID, or any DB error. |

---

### `DELETE /api/ai-scheduler/conversations/[conversationId]`

**Archives; does not delete.** The handler is a thin alias for `PATCH { status: "archived" }` — it calls the same `patchSchedulerConversation` with a hardcoded body ([`[conversationId]/route.ts:87`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)). No row in any of the four tables is ever removed by this API.

**Auth:** session required. No ownership check: any signed-in caller can archive any conversation, and no actor is recorded.

**Request:** path param only; the body is ignored (the handler's request argument is `_request`).

**Side effects:** `status = 'archived'`, `archivedAt = now()`, `updatedAt = now()`. Messages, runs and feedback are untouched, and the conversation reappears in listings under `includeArchived=true`. Archiving is also the gate on new turns — see the 409 on [the message endpoint](#post-apiai-schedulerconversationsconversationidmessages).

**Response 200** — `{ conversation: SchedulerConversationDto }` with `status: "archived"` ([`:92`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)). Not 204.

**Status codes:**

| Status | When |
|--------|------|
| 200 | `{ conversation }`, now archived. Archiving an already-archived conversation succeeds and refreshes `archivedAt`. |
| 401 | No session. |
| 403 | Middleware page-access denial. |
| 404 | `{"error":"Conversation not found"}` ([`:88-90`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/route.ts)). |
| 500 | Malformed UUID, or any DB error. |

---

## Running a scheduler turn

### `POST /api/ai-scheduler/conversations/[conversationId]/messages`

The one endpoint that calls the model. It appends the admin message, runs extraction + deterministic solve, appends the assistant reply, updates conversation memory, and writes an audit run — five writes, no transaction. Handler: [`messages/route.ts:50-191`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts).

**Auth:** session required ([`:54-57`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)). The caller is stamped on the admin message and on `ai_scheduler_runs.created_by_email`.

**Configuration gate, checked before the body is read:** `isAiSchedulerConfigured()` false → `503 {"error":"AI scheduler is not configured"}` ([`:59-61`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)). The UI mirrors this by passing `aiSchedulerEnabled` into the workspace and disabling the composer ([`scheduler/page.tsx:22`](<../../../src/app/(app)/scheduler/page.tsx>)).

**Request body** — `sendMessageSchema`, `.strict()` ([`:19-21`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)):

| Field | Type | Required | Schema rule |
|-------|------|----------|-------------|
| `content` | string | yes | `.trim().min(1).max(8000)` — the only accepted key. |

**Preconditions** ([`:78-86`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)): the conversation is loaded with its full message history; missing → `404 {"error":"Conversation not found"}`; `status === "archived"` → `409 {"error":"Archived conversations cannot receive new messages"}`. Un-archive with `PATCH { status: "active" }` to reopen.

**Turn execution** — `executeSchedulerTurn` ([`scheduler-service.ts:48-107`](../../../src/lib/ai/scheduler-service.ts)), timed into a four-part latency breakdown (`totalMs` / `dbMs` / `modelMs` / `searchMs`):

1. `ensureIndex(db)` warms or reuses the in-memory snapshot index, and active proposal holds are fetched in parallel ([`scheduler-service.ts:59-64`](../../../src/lib/ai/scheduler-service.ts)) — a cold process pays the index build on this request.
2. `extractSchedulerStateWithOpenAi` posts to `https://api.openai.com/v1/responses` with `store: false` ([`scheduler-conversation.ts:2346-2356`](../../../src/lib/ai/scheduler-conversation.ts)), returning `{ state, title? }`. The prompt carries the **entire** message history plus the conversation's accumulated `extractedState`, today's Bangkok date, the snapshot's filter options, and the tutor list.
3. `mergeSchedulerState` folds the new extraction onto the stored state.
4. `solveSchedulerTurn` computes availability **deterministically** from the index and proposal holds ([`scheduler-service.ts:86-93`](../../../src/lib/ai/scheduler-service.ts)). The model contributes structured intent; it never decides who is free.

**Writes, in order** — none of them rolled back on a later failure:

| # | Write | Detail |
|---|-------|--------|
| 1 | Admin message | Inserted **before** the try block ([`:91-96`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)), so it persists even when the turn fails. |
| 2 | Assistant message | `content = assistantResult.assistantMessage`; `structuredPayload` = the whole `assistantResult` plus `extractedState: extraction.state` (the raw extraction, not the merged state) ([`:109-121`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)); `model` and `latencyMs` set. |
| 3 | Conversation touch | `lastMessageAt`/`updatedAt` bumped; `extractedState` replaced with `assistantResult.state` (the **merged/resolved** state, not `extraction.state`); `customerParentName`/`customerStudentName`/`customerContact` overwritten from the resolved state when truthy; `title` set only when it still equals `"Untitled scheduler chat"`, from `extraction.title` or `buildConversationTitle` ([`:123-132`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts), [`scheduler-conversation.ts:2258-2269`](../../../src/lib/ai/scheduler-conversation.ts)). |
| 4 | Run audit row | `ai_scheduler_runs` with `status: "solved"` when `parentReady`, else `"needs_clarification"`; `inputPreviewRedacted` is the message run through `redactAiSchedulerInput` (emails → `[email]`, phone-shaped runs → `[phone]`, long digit runs → `[number]`, truncated to 600 chars, [`scheduler.ts:439-450`](../../../src/lib/ai/scheduler.ts)); `schedulerVersion` / `promptVersion` pinned per run from `schedulerRunMetadata` ([`scheduler-service.ts:20-21,40-46`](../../../src/lib/ai/scheduler-service.ts)); `parsedPayload` = the extraction, `solverPayload` = the assistant payload. `logSchedulerRun` swallows its own errors and returns the string `"unlogged"` ([`scheduler-data.ts:508-532`](../../../src/lib/ai/scheduler-data.ts)) — a failed audit write never fails the request. |

**Response 200** ([`:147-152`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)) — note **200, not 201**, despite creating two messages:

| Field | Type | Notes |
|-------|------|-------|
| `conversation` | conversation DTO \| null | Post-touch. `null` if the conversation vanished mid-turn. LINE fields are placeholders. |
| `messages` | `[adminMessage, assistantMessage]` | Just this turn's two rows, not the full thread. |
| `assistantResult` | object | `SchedulerAssistantResult` ([`scheduler-conversation.ts:209-226`](../../../src/lib/ai/scheduler-conversation.ts)): `state`, `suggestions[]` (ranked slot + tutor candidates, [`:127-144`](../../../src/lib/ai/scheduler-conversation.ts)), `availabilitySummary?` (with `searchProvenance.snapshotId` / `profileVersion` / `activeProposalHoldCount`, [`:169-183`](../../../src/lib/ai/scheduler-conversation.ts)), `constraintLedger[]`, `latencyBreakdownMs`, `parentMessageDraft`, `assistantMessage`, `snapshotMeta` (`{ snapshotId, syncedAt, stale }`, [`search/types.ts:30-34`](../../../src/lib/search/types.ts)), `warnings[]`, `questions[]`, `parentReady`. |
| `logId` | string | The `ai_scheduler_runs.id`, or the literal `"unlogged"`. Callers pass it back as `schedulerRunId` on feedback. |

**Response 502 — the failure path still writes** ([`:153-190`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)). Any throw inside the turn (OpenAI error, index build failure, solver error) is caught and produces: a canned assistant message (`"I could not process that message…"`) with `structuredPayload: { error }`, a conversation touch, and a run row with `status: "failed"`, `errorMessage`, and a zeroed latency breakdown. The body is `{ error: "AI scheduling failed", detail, messages: [adminMessage, assistantMessage], logId }` at **502**. So a failed turn is a durable, visible pair of messages in the thread, not a silent drop.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Turn completed (whether `parentReady` or `needs_clarification`). |
| 400 | `{"error":"Invalid JSON"}`, or Zod `{"error":"Invalid request","details":…}` — blank/whitespace `content`, over 8000 chars, or any unknown key. |
| 401 | No session. |
| 403 | Middleware page-access denial. |
| 404 | `{"error":"Conversation not found"}`. |
| 409 | `{"error":"Archived conversations cannot receive new messages"}`. |
| 500 | Malformed UUID, or a failure of write #1 (the admin message insert sits outside the try/catch). |
| 502 | `{"error":"AI scheduling failed","detail",…}` — the model or solver threw. |
| 503 | `{"error":"AI scheduler is not configured"}` — `ENABLE_AI_SCHEDULER="false"` or no `OPENAI_API_KEY`. |

---

## Staff feedback

### `POST /api/ai-scheduler/messages/[messageId]/feedback`

Records what a human did with an assistant draft — accepted it, edited it, or rejected it with a correction. This is the training signal behind the correction telemetry on `/scheduler/metrics`. Handler: [`feedback/route.ts:41-78`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts).

**Auth:** session required ([`:42-45`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)); the caller is stamped as `created_by_email` / `created_by_name`.

**Path parameter:** `messageId` — the `ai_scheduler_messages.id` the feedback attaches to. Not validated in the route and not existence-checked; it is inserted straight into a `uuid` FK column ([`schema.ts:2413`](../../../src/lib/db/schema.ts)), so an unknown or malformed id fails at Postgres as an unwrapped **500**, never a 404.

**Request body** — a Zod **discriminated union on `action`**, each arm `.strict()` ([`feedback/route.ts:7-30`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)). Required fields differ per arm, which is the whole point of the union:

| `action` | Required | Optional | Rules |
|----------|----------|----------|-------|
| `"accept"` | `action` | `conversationId`, `schedulerRunId`, `selectedTutorIds`, `editedParentDraft` | `editedParentDraft` `.max(5000)`, nullable ([`:13`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)). |
| `"edit"` | `action`, **`editedParentDraft`** | `conversationId`, `schedulerRunId`, `selectedTutorIds` | `editedParentDraft` `.trim().min(1).max(5000)` — a blank edit is a 400 ([`:20`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)). |
| `"reject"` | `action`, **`rejectionReason`**, **`staffCorrection`** | `conversationId`, `schedulerRunId`, `rejectedTutorIds` | `rejectionReason` `.trim().min(1).max(500)`; `staffCorrection` `.trim().min(1).max(5000)` ([`:27-28`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)). A rejection without both is a 400 — asserted by [`feedback/__tests__/route.test.ts:84-92`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/__tests__/route.test.ts). |

Shared optional fields: `conversationId` and `schedulerRunId` are `.uuid().nullable().optional()` and default to `null` ([`:66-67`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)); `selectedTutorIds` / `rejectedTutorIds` are string arrays of `.max(12)` and default to `[]` ([`scheduler-data.ts:561-562`](../../../src/lib/ai/scheduler-data.ts)). The arms are mutually exclusive by strictness — sending `rejectedTutorIds` with `action: "accept"`, or `selectedTutorIds` with `action: "reject"`, is a 400.

A fourth action value, `"dismiss"`, exists in `SchedulerFeedbackAction` ([`scheduler-data.ts:71`](../../../src/lib/ai/scheduler-data.ts)) but **is not in this union**. It is written only by the LINE review service ([`review-service.ts:627-631`](../../../src/lib/line/review-service.ts)), never through this endpoint — though it still shows up in the telemetry rollup.

**Side effects:** one `INSERT ... RETURNING` into `ai_scheduler_feedback` ([`scheduler-data.ts:552-573`](../../../src/lib/ai/scheduler-data.ts)). Free-text fields are trimmed and collapsed to `null` when blank. `lineReviewId`, `classifierConfidence` and `timeToReviewMs` are supported by the data layer but never populated from this route — they come from the LINE lane, which is why `confidenceByOutcome` bands rows written here as `"unknown"` ([`correction-telemetry.ts:64`](../../../src/lib/ai/correction-telemetry.ts)). Nothing is mutated on the message, run, or conversation; feedback is append-only.

**Response 200** — `{ feedback: SchedulerFeedbackDto }` ([`:77`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/route.ts)), shape at [`scheduler-data.ts:73-90`](../../../src/lib/ai/scheduler-data.ts): `id`, `conversationId`, `messageId`, `schedulerRunId`, `action`, `selectedTutorIds`, `rejectedTutorIds`, `editedParentDraft`, `rejectionReason`, `staffCorrection`, `lineReviewId`, `classifierConfidence`, `timeToReviewMs`, `createdByEmail`, `createdByName`, `createdAt`. Not 201, despite creating a row.

**Status codes:**

| Status | When |
|--------|------|
| 200 | `{ feedback }` persisted. |
| 400 | `{"error":"Invalid JSON"}`; or Zod `{"error":"Invalid request","details":…}` — unknown `action`, a missing per-arm required field, a non-UUID `conversationId`/`schedulerRunId`, over-length text, more than 12 tutor ids, or a cross-arm key. |
| 401 | No session. |
| 403 | Middleware page-access denial. |
| 500 | Unknown or malformed `messageId` (FK / cast failure), or any DB error. |

---

## Telemetry

### `GET /api/ai-scheduler/metrics`

One read-only rollup across three independent aggregators, fetched concurrently. Handler: [`metrics/route.ts:8-22`](../../../src/app/api/ai-scheduler/metrics/route.ts).

**Auth:** session required ([`:9-12`](../../../src/app/api/ai-scheduler/metrics/route.ts)). No `NextRequest` parameter — the handler accepts no query params and no body.

**Side effects:** none.

**Response 200** — `{ scheduler, line, correction }`, computed by `Promise.all` ([`:15-19`](../../../src/app/api/ai-scheduler/metrics/route.ts)):

| Key | Source | Contents |
|-----|--------|----------|
| `scheduler` | `getAiSchedulerMetrics` ([`scheduler-metrics.ts:65-131`](../../../src/lib/ai/scheduler-metrics.ts)) | Over the **500 most recent** `ai_scheduler_runs` ([`:81`](../../../src/lib/ai/scheduler-metrics.ts)): `totalRuns`, `solvedRuns`, `needsClarificationRuns`, `failedRuns`, `parentReadyConstraintFailures` (solved runs whose `constraintLedger` still holds a `needs_clarification` item, [`:50-59`](../../../src/lib/ai/scheduler-metrics.ts)), a `latency` object (`p50Ms`, `p95Ms`, `averageMs`, `averageDbMs`, `averageModelMs`, `averageSearchMs` — each `null` when no sample), `versions[]` (`schedulerVersion` × `promptVersion` counts, desc), and `recentFailures[]` (last 10, each `{ id, createdAt, errorMessage, inputPreviewRedacted }`). Shape: [`scheduler-metrics.ts:5-26`](../../../src/lib/ai/scheduler-metrics.ts). |
| `line` | `getLineSchedulerAnalytics` ([`line/data.ts:1171`](../../../src/lib/line/data.ts)) | The LINE review funnel: classification counts, review outcomes, `rejectionRate`, `averageEditDistance`, `averageModelLatencyMs`, classification accuracy / false positives / false negatives / review coverage, `unverifiedLinkBacklog`, and the common-rejection and feedback-label breakdowns. Shape: [`line/data.ts:173-195`](../../../src/lib/line/data.ts). Cross-feature — detail belongs to the [LINE API reference](line.md). |
| `correction` | `getCorrectionTelemetry` ([`correction-telemetry.ts:47-89`](../../../src/lib/ai/correction-telemetry.ts)) | Over the **5000 most recent** `ai_scheduler_feedback` rows ([`:56`](../../../src/lib/ai/correction-telemetry.ts)): `totalActions`, `acceptRate` / `editRate` / `rejectRate` / `dismissRate` (fractions 0–1, all `0` when there are no rows), `avgTimeToReviewMs`, `p50TimeToReviewMs`, and `confidenceByOutcome[]` — per-band `{ band, accept, edit, reject, dismiss, total }` in the fixed order `high, medium, low, unknown`, omitting bands with no rows. Rows written by this API's feedback endpoint always land in `unknown`, since it never sets `classifierConfidence`. Shape: [`correction-telemetry.ts:18-27`](../../../src/lib/ai/correction-telemetry.ts). |

Both caps are "most recent N rows", not a time window, so every figure is a rolling window whose real duration depends on traffic.

**Status codes:**

| Status | When |
|--------|------|
| 200 | `{ scheduler, line, correction }`. |
| 401 | No session. |
| 403 | Middleware page-access denial. |
| 500 | Any of the three aggregators throwing — unwrapped. |

---

## In-repo clients and tests

**UI callers.** [`src/components/scheduler/scheduler-workspace.tsx`](../../../src/components/scheduler/scheduler-workspace.tsx) drives six of the eight: list with `sort` / `scope` / `ownerEmail` / `includeArchived` / `q` ([`:1605`](../../../src/components/scheduler/scheduler-workspace.tsx)), conversation detail in parallel with `/api/line/scheduler-reviews` ([`:1664`](../../../src/components/scheduler/scheduler-workspace.tsx)), debounced `PATCH` autosave of the details panel ([`:1691`](../../../src/components/scheduler/scheduler-workspace.tsx)), create ([`:1724`, `:1774`](../../../src/components/scheduler/scheduler-workspace.tsx) — the second is the lazy `ensureConversation` on first send), `DELETE` behind an "archive" button ([`:1742`](../../../src/components/scheduler/scheduler-workspace.tsx)), and the message send with an optimistic admin bubble ([`:1811`](../../../src/components/scheduler/scheduler-workspace.tsx)). Feedback posts from the draft panel ([`:837`](../../../src/components/scheduler/scheduler-workspace.tsx)), sending `rejectedTutorIds` + `rejectionReason` + `staffCorrection` for a rejection and `selectedTutorIds` + a conditional `editedParentDraft` otherwise. [`src/components/scheduler/metrics-view.tsx:57`](../../../src/components/scheduler/metrics-view.tsx) fetches `/api/ai-scheduler/metrics` but reads **only** `payload.correction` — `scheduler` and `line` are computed on every request and discarded by the sole in-app consumer.

**Route tests.**

- [`conversations/__tests__/route.test.ts`](../../../src/app/api/ai-scheduler/conversations/__tests__/route.test.ts) — 401 without a session (`:57-62`), the 200 list with owner/search/sort filters and admin facets (`:65-73`), `scope=mine` as the current-admin shortcut (`:88-91`), the 400 on an invalid sort (`:99-102`), and the 201 create stamped with the caller (`:106-112`).
- [`conversations/[conversationId]/messages/__tests__/route.test.ts`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/__tests__/route.test.ts) — one test (`:154-157`) covering the happy path: admin and assistant rows persisted around a solved turn, response 200.
- [`messages/[messageId]/feedback/__tests__/route.test.ts`](../../../src/app/api/ai-scheduler/messages/[messageId]/feedback/__tests__/route.test.ts) — 401 (`:52-57`), accepted-draft persistence (`:61-68`), and the 400 when a rejection omits its reason or correction (`:84-91`).

There is no route test file for `[conversationId]/route.ts` (GET/PATCH/DELETE) or for `metrics/route.ts`.

## Notes & open questions

- **The `/api` namespace does not match the page namespace.** `allowedPages: ["/scheduler"]` grants `/api/scheduler`, but the endpoints live under `/api/ai-scheduler`, so a page-restricted user gets the page and a 403 on every request it makes ([`middleware.ts:59-66`](../../../src/middleware.ts), [`tools.ts:95-96`](../../../src/lib/navigation/tools.ts)). Same class of drift as the Proposals note. Should the route group be renamed, or the grant aliased?
- **No ownership check anywhere.** Conversations carry `created_by_email` and the list endpoint can filter by it, but no handler enforces it: any signed-in user can read, edit, archive, or post into another admin's conversation. Intentional (shared queue) or an unclosed gap?
- **LINE enrichment fields are wrong on seven of the eight endpoints.** Only the list endpoint passes line stats into `conversationToDto`; every other path uses the empty default, so a LINE-sourced conversation reads back as `source: "manual"` with zero pending reviews ([`scheduler-data.ts:361,373,428,457`](../../../src/lib/ai/scheduler-data.ts)). The workspace papers over this by fetching `/api/line/scheduler-reviews` alongside the detail GET.
- **No `maxDuration` on the message route.** It performs an OpenAI Responses call plus a possible cold `ensureIndex` build inside a serverless function that declares no duration override, so it runs at the platform default while every heavy sync route in the repo sets `maxDuration = 800`. Whether that default is sufficient in production is a runtime fact the repo cannot attest.
- **The prompt grows without bound.** Every turn replays the entire message history ([`messages/route.ts:102-105`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)) and the detail GET returns it unpaginated. Token cost and latency therefore rise linearly with conversation length, with no truncation or windowing anywhere in the path.
- **Two states are stored per turn and they differ.** The conversation keeps the *merged* state (`assistantResult.state`) while the assistant message's `structuredPayload.extractedState` keeps the *raw* extraction ([`messages/route.ts:110-111,125`](../../../src/app/api/ai-scheduler/conversations/[conversationId]/messages/route.ts)). Deliberate — replaying a message payload is not the same as resuming the conversation — but easy to conflate when reading rows.
- **Nothing is transactional.** The message route issues four writes with no rollback; a crash after write #1 leaves an admin message with no reply. The Neon HTTP driver has no transaction support, which is the same constraint documented for Proposals.
- **`ENABLE_AI_SCHEDULER` and `OPENAI_API_KEY` are undeclared.** Neither appears in [`src/lib/env.ts`](../../../src/lib/env.ts), so a typo or missing value fails at request time (503) rather than at boot. The gate is also opt-*out*: absent `ENABLE_AI_SCHEDULER`, a present API key is enough to enable the feature.

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
