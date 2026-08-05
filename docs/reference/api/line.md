# LINE API Reference

**Status:** stable read/review paths; the **Wise** write-path is dry-run only (see [§ Wise actions](#wise-actions)), while the **LINE reply** write-path is a real outbound push (see [`PATCH /api/line/scheduler-reviews/[reviewId]`](#patch-apilineschedulerreviewsreviewid)). **Scope:** 29 endpoints across the 25 route files under [`src/app/api/line/`](../../../src/app/api/line/).

This page is the mechanical reference — method, path, auth, request/response shapes, side effects, and status codes per endpoint. Feature meaning, lifecycles, and the "why" behind the identity rules live in [`features/line-integration.md`](../../features/line-integration.md); that doc links here for signatures rather than restating them. The backing tables are documented in [`reference/database/index.md`](../database/index.md).

## Endpoints at a glance

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/line/webhook` | LINE signature | Ingest a LINE Messaging API webhook batch. |
| `GET` | `/api/line/scheduler-reviews` | session | List scheduler reviews, optionally with analytics. |
| `GET` | `/api/line/scheduler-reviews/false-negatives` | session | List messages the classifier probably under-called. |
| `GET` | `/api/line/scheduler-reviews/[reviewId]/context` | session | Read the merged LINE + website chat timeline. |
| `PATCH` | `/api/line/scheduler-reviews/[reviewId]` | session | Approve+send, accept without sending, reject, or dismiss. |
| `POST` | `/api/line/scheduler-reviews/[reviewId]/operational-plan` | session | Rebuild intent, candidate sessions, and proposed Wise actions. |
| `GET` | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | session | List Wise-action audit rows for a review. |
| `POST` | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | session | Confirm a proposed Wise action (dry-run only). |
| `POST` | `/api/line/messages/[messageId]/promote` | session | Promote a missed message into a pending review. |
| `PATCH` | `/api/line/messages/[messageId]/classification-feedback` | session | Record the human-reviewed classifier category. |
| `GET` | `/api/line/students` | session | Typeahead search over the current student directory. |
| `PATCH` | `/api/line/contacts/[contactId]` | session | Rewrite a contact's labels and re-derive link suggestions. |
| `GET` | `/api/line/contacts/[contactId]/student-links` | session | List a contact's links, recomputing suggestions first. |
| `POST` | `/api/line/contacts/[contactId]/student-links` | session | Create a verified link to one student by `studentKey`. |
| `PATCH` | `/api/line/contacts/[contactId]/student-links` | session | Verify or reject one existing link. |
| `GET` | `/api/line/contacts/link-validation` | session | Page the link-validation worklist for a scope. |
| `GET` | `/api/line/contacts/link-validation/summary` | session (lead) | Read the validation progress tracker. |
| `POST` | `/api/line/contacts/link-validation/assign` | session | Round-robin assign validation tasks to reviewers. |
| `PATCH` | `/api/line/contacts/link-validation/[linkId]` | session | Verify or reject one validation task. |
| `POST` | `/api/line/contacts/alias-import/preview` | session | Parse pasted chat-list text or a screenshot into aliases. |
| `POST` | `/api/line/contacts/alias-import/commit` | session | Apply reviewed alias rows to contacts. |
| `POST` | `/api/line/contacts/refresh-profiles` | session | Re-fetch the LINE profile for every stored contact. |
| `POST` | `/api/line/contacts/followers-reanchor` | session | Re-anchor from the follower roster + backlog identity recovery. |
| `GET` | `/api/line/contacts/oa-resolver/worklist` | resolver token | Browser-extension worklist for the token's run. |
| `GET` | `/api/line/contacts/oa-resolver/runs` | session | List resolver runs, or fetch the latest one. |
| `POST` | `/api/line/contacts/oa-resolver/runs` | session | Create a resolver run and mint its one-time token. |
| `GET` | `/api/line/contacts/oa-resolver/runs/[runId]` | session | Read one resolver run with all its rows. |
| `POST` | `/api/line/contacts/oa-resolver/runs/[runId]/rows` | resolver token | Browser-extension callback that writes captured rows. |
| `POST` | `/api/line/contacts/oa-resolver/runs/[runId]/commit` | session | Commit matched/ambiguous rows into contacts + suggested links. |

## Authentication model

Three in-handler auth mechanisms guard these routes, plus one middleware-level gate. Each endpoint section states which applies.

1. **Session (Auth.js)** — the default for 26 of the 29 endpoints. Handlers call `await auth()` and return **401 `{ "error": "Unauthorized" }`** when there is no session ([`scheduler-reviews/route.ts:25-28`](../../../src/app/api/line/scheduler-reviews/route.ts) is the canonical pattern). Sign-in itself is not admin-only any more: `resolveUserAccess` admits admins (`admin_users`), admissions counselors, teachers, and admissions case members ([`auth-access.ts:56-85`](../../../src/lib/auth-access.ts)). What keeps non-admins out of these routes is the middleware gate below — the in-handler `auth()` check only proves *some* principal is signed in. No LINE handler checks a role.
2. **Middleware page-scope gate** — `src/middleware.ts` resolves `req.auth.user.allowedPages`; `null` means full access, and any non-null list is matched against the pathname both as a page (`/x`, `/x/…`) and as its API namespace (`/api/x`, `/api/x/…`). An API request outside that list gets **403 `{ "error": "Forbidden" }`** before the handler runs ([`middleware.ts:30-61`, `:78-88`](../../../src/middleware.ts)). Counselors/teachers/students/parents are scoped to `/admissions` or `/progress-tests` ([`auth-access.ts:70-82`](../../../src/lib/auth-access.ts)), so they are 403'd on every `/api/line/**` path. **Note the namespace mismatch:** these APIs live under `/api/line/**` while the pages that consume them are `/line-review` and `/scheduler`, so a *restricted admin* whose `allowedPages` lists those pages is also 403'd here — only full-access admins (`allowedPages === null`) can call this surface.
3. **LINE HMAC signature** — the webhook only. The raw body is verified against the `x-line-signature` header with base64 `HMAC-SHA256(channelSecret, rawBody)`, compared using `timingSafeEqual` after a length pre-check ([`signature.ts:12-19`](../../../src/lib/line/signature.ts)). No session.
4. **Per-run resolver bearer token** — the two browser-extension endpoints (`oa-resolver/worklist`, `oa-resolver/runs/[runId]/rows`). A `Bearer <token>` is read from the `Authorization` header and matched against a SHA-hashed, 8-hour-TTL run token in Postgres ([`oa-resolver.ts:111`, `:592-606`](../../../src/lib/line/oa-resolver.ts)). No session.

**Public-route note:** [`middleware.ts:4-19`](../../../src/middleware.ts) exempts exactly three LINE paths from the session redirect — `/api/line/webhook`, `/api/line/contacts/oa-resolver/worklist`, and the regex `^/api/line/contacts/oa-resolver/runs/[^/]+/rows$`. Those are precisely the three machine-facing endpoints; they self-authenticate via signature or token. Every other LINE route sits behind the session gate.

**Route config:** only two handlers override defaults — `POST /api/line/webhook` (`maxDuration = 60`, [`webhook/route.ts:8`](../../../src/app/api/line/webhook/route.ts)) and `POST /api/line/contacts/followers-reanchor` (`maxDuration = 300`, [`followers-reanchor/route.ts:13`](../../../src/app/api/line/contacts/followers-reanchor/route.ts)).

Standard error envelopes shared by the session-guarded routes:

- Malformed JSON body → **400 `{ "error": "Invalid JSON" }`**.
- Zod `.safeParse()` failure → **400 `{ "error": "Invalid request", "details": <flattened> }`** (where a body schema exists). Every object schema is `.strict()`, so unknown keys are rejected rather than ignored.
- Missing entity → **404** with a route-specific message.

Only six handlers wrap their business logic in `try/catch` (`alias-import/preview`, `followers-reanchor`, `link-validation/assign`, `scheduler-reviews/[reviewId]`, the `wise-actions` POST, and the webhook's own envelope). Everywhere else an unexpected throw propagates to the framework as an unshaped 500.

**Environment gates.**

| Variable | Effect | Source |
|---|---|---|
| `ENABLE_LINE_SCHEDULER`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` | All three must be satisfied or the webhook returns 503. | [`client.ts:19-23`](../../../src/lib/line/client.ts) |
| `OPENAI_API_KEY` (+ AI-scheduler config) | Required only for the *image* branch of alias-import preview. | [`contact-aliases.ts:363-366`](../../../src/lib/line/contact-aliases.ts) |
| `LINE_VALIDATION_LEAD_EMAILS` | Comma-separated allowlist for the validation tracker, with a two-address built-in fallback. Not declared in [`env.ts`](../../../src/lib/env.ts) — read straight from `process.env`. | [`link-validation.ts:110-113`, `:220-232`](../../../src/lib/line/link-validation.ts) |
| `WISE_SESSION_OPERATIONS_VERIFIED` | `"true"` switches the Wise-action log from `manual_required` to `dry_run`. Neither value sends a Wise mutation. | [`operations.ts:10-12`](../../../src/lib/wise/operations.ts) |

**Student directory dependency.** Everything that resolves a "student" here reads the **active credit-control snapshot**, not the Wise tutor snapshot: `listCurrentLineStudents` joins `credit_control_students` / `_packages` / `_sessions` for the active credit-control snapshot id ([`student-links.ts:184-254`](../../../src/lib/line/student-links.ts)). With no active credit-control snapshot the directory is empty, and student lookups return `[]` / 404.

---

## Webhook

### `POST /api/line/webhook`

Inbound LINE event ingestion. **Auth: LINE HMAC signature** (no session; public in middleware). Handler: [`webhook/route.ts:10-43`](../../../src/app/api/line/webhook/route.ts).

**Feature gate:** if `lineSchedulerEnabled()` is false the handler returns **503 `{ ok: false, error: "LINE scheduler is not configured" }`** before touching the body ([`webhook/route.ts:11-13`](../../../src/app/api/line/webhook/route.ts)) — checked *before* the signature. The flag is true only when `ENABLE_LINE_SCHEDULER !== "false"` **and** both `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` are set ([`client.ts:19-23`](../../../src/lib/line/client.ts)).

**Request:** raw LINE webhook JSON, read via `request.text()` so the exact bytes can be signed ([`webhook/route.ts:16`](../../../src/app/api/line/webhook/route.ts)). The `x-line-signature` header is required. No Zod schema — the body is LINE's event envelope, walked defensively inside `recordLineWebhookPayload`.

**Side effects** (`handleLineWebhookPost`, [`webhook.ts:18-67`](../../../src/lib/line/webhook.ts) → `recordLineWebhookPayload`, [`data.ts:422-524`](../../../src/lib/line/data.ts)):

| Event shape | Effect |
|---|---|
| `source.type` = `group`/`room`, `type` = `message`, text present | Collected as a `LineGroupCommand` and **never persisted as a `line_messages` row**; handed to the schedule-bot router ([`data.ts:441-461`](../../../src/lib/line/data.ts)). |
| `source.type` ≠ `user`, or missing `userId` | `ignoredEvents += 1` ([`data.ts:463-466`](../../../src/lib/line/data.ts)). |
| `type` = `unsend` | Flags the matching `line_messages` row `isRetracted`; counts into `retractedMessages` ([`data.ts:468-482`](../../../src/lib/line/data.ts)). |
| `type` = `message`, text | Upserts the contact + thread and inserts an inbound message with `onConflictDoNothing` on `webhookEventId`; a conflict counts as `duplicateEvents` instead of `createdMessageIds` ([`data.ts:497-520`](../../../src/lib/line/data.ts)). |
| anything else (non-message event, non-text message) | `ignoredEvents += 1` ([`data.ts:484-495`](../../../src/lib/line/data.ts)). |

Two background jobs are queued with `after(...)` so they run off the response path, each wrapped in try/catch that only `console.error`s ([`webhook/route.ts:22-39`](../../../src/app/api/line/webhook/route.ts)):

- per created message id → `processLineMessageForScheduler` (schedule-bot command interception, profile refresh, link suggestions, classification, review creation — [`review-service.ts:129-189`](../../../src/lib/line/review-service.ts));
- per group command → `handleScheduleBotGroupCommand` ([`schedule-bot-group.ts:229`](../../../src/lib/line/schedule-bot-group.ts)).

**Responses** ([`webhook.ts:5-16`, `:56-66`](../../../src/lib/line/webhook.ts)):

| Status | Body |
|---|---|
| 200 | `{ ok: true, createdMessageIds: string[], duplicateEvents: number, ignoredEvents: number, retractedMessages: number, groupCommands: number }` |
| 400 | `{ ok: false, error: "Invalid JSON" }` ([`webhook.ts:38-46`](../../../src/lib/line/webhook.ts)) |
| 401 | `{ ok: false, error: "Invalid LINE signature" }` ([`webhook.ts:27-36`](../../../src/lib/line/webhook.ts)) |
| 503 | `{ ok: false, error: "LINE scheduler is not configured" }` |

---

## Scheduler reviews

The human-review queue for inbound scheduling messages. **All five endpoints require a session** (plus the middleware page gate).

### `GET /api/line/scheduler-reviews`

List reviews, optionally with analytics. Handler: [`scheduler-reviews/route.ts:24-54`](../../../src/app/api/line/scheduler-reviews/route.ts).

**Query params** (all optional, each validated individually — there is no single schema):

| Param | Rule | On failure |
|---|---|---|
| `status` | enum `pending_review \| approved_sent \| accepted_no_send \| rejected \| dismissed` ([`:7-13`](../../../src/app/api/line/scheduler-reviews/route.ts)) | 400 `{ "error": "Invalid status" }` |
| `intentType` | enum `new_request \| cancel_one_off \| pause_until \| resume \| reschedule \| unclear_change` ([`:15-22`](../../../src/app/api/line/scheduler-reviews/route.ts)) | 400 `{ "error": "Invalid intentType" }` |
| `conversationId` | free-form string equality filter ([`:41`](../../../src/app/api/line/scheduler-reviews/route.ts)) | — |
| `analytics` | `"true"` additionally computes `getLineSchedulerAnalytics(db)` ([`:42`, `:50`](../../../src/app/api/line/scheduler-reviews/route.ts)) | — |

**Response 200** — `{ reviews, analytics }`. `reviews` is `LineSchedulerReviewDto[]`, joined to `line_contacts`, ordered by `createdAt` descending and **hard-capped at 200 rows** with no pagination ([`data.ts:857-863`](../../../src/lib/line/data.ts)); the DTO's fields are defined at [`data.ts:94-133`](../../../src/lib/line/data.ts). `analytics` is `null` unless `analytics=true`, in which case it is the `LineSchedulerAnalytics` object (classification counts, review-outcome counts, `rejectionRate`, `averageEditDistance`, `averageModelLatencyMs`, `classificationAccuracy` / coverage / false-positive / false-negative counts, `unverifiedLinkBacklog`, and the rejection-reason/category/feedback-label breakdowns — [`data.ts:173-195`](../../../src/lib/line/data.ts)).

### `GET /api/line/scheduler-reviews/false-negatives`

Surface inbound messages the classifier probably under-called, so an admin can promote them. Handler: [`false-negatives/route.ts:9-27`](../../../src/app/api/line/scheduler-reviews/false-negatives/route.ts).

**Query param:** `threshold` — optional, `z.coerce.number().min(0).max(1)` ([`:7`](../../../src/app/api/line/scheduler-reviews/false-negatives/route.ts)); invalid → **400 `{ "error": "Invalid threshold" }`**. Omitted → `LINE_FALSE_NEGATIVE_CONFIDENCE_THRESHOLD = 0.75` ([`classifier.ts:24`](../../../src/lib/line/classifier.ts)).

**Selection rule** ([`data.ts:597-617`](../../../src/lib/line/data.ts)): inbound messages with **no** `classificationReviewedAt` and **no** existing scheduler review, whose category is `unclear`, **or** `non_scheduling` with confidence below the threshold — a NULL confidence counts as "show" (fail-open). Ordered by `classifiedAt` desc, limit 100.

**Response 200** — `{ candidates }`, each a `LineFalseNegativeCandidateDto` ([`data.ts:79-92`](../../../src/lib/line/data.ts)).

### `GET /api/line/scheduler-reviews/[reviewId]/context`

Fetch the surrounding chat context for one review. Handler: [`context/route.ts:8-21`](../../../src/app/api/line/scheduler-reviews/[reviewId]/context/route.ts).

**Request:** path param `reviewId`; no query, no body.

**Response 200** — `{ context }`, a `LineReviewChatContextDto` = `{ reviewId, threadId, conversationId, lineMessages, websiteMessages, combinedTimeline }`, where each message is a `LineReviewContextMessageDto` ([`data.ts:150-171`](../../../src/lib/line/data.ts)). The LINE side is the most recent 30 thread messages, re-reversed into chronological order (`lineLimit` default, [`data.ts:1045`, `:1057-1075`](../../../src/lib/line/data.ts)). **404 `{ "error": "Review not found" }`** when the review id is unknown.

### `PATCH /api/line/scheduler-reviews/[reviewId]`

The primary review-decision endpoint. Handler: [`[reviewId]/route.ts:60-133`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts).

**Body:** a Zod **discriminated union on `action`**, every member `.strict()` ([`:12-44`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)):

| `action` | Required | Optional |
|---|---|---|
| `approve_send` | `finalText` (trimmed, 1–5000) | `selectedTutorIds` (≤12 non-empty strings), `studentLinkOverride` (bool) |
| `accept_no_send` | — | `finalText` (≤5000), `selectedTutorIds` (≤12), `studentLinkOverride` |
| `reject` | `reasonCategory` (enum `wrong_student_link \| wrong_extracted_request \| wrong_tutor_fit \| wrong_availability \| unsafe_draft \| unclear \| other`), `rejectionReason` (1–500), `staffCorrection` (1–5000) | `rejectedTutorIds` (≤12) |
| `dismiss` | — | `rejectionReason` (≤500) |

The handler dispatches to `approveLineSchedulerReview` / `acceptLineSchedulerReviewNoSend` / `rejectLineSchedulerReview` / `dismissLineSchedulerReview` ([`:88-122`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)), passing the session email + name as the audit `actor` ([`:48-53`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)).

**Side effects per action** ([`review-service.ts:465-644`](../../../src/lib/line/review-service.ts)) — all four are no-ops that return the review unchanged (HTTP 200) when `status !== "pending_review"`:

- **`approve_send`** is the only real outbound write in the whole LINE surface. It refuses unless the contact has ≥1 verified student link or `studentLinkOverride` is true ("Verify a LINE student link or mark this contact as unmatched before sending", [`:477-480`](../../../src/lib/line/review-service.ts)); rejects an empty final text; then calls `pushLineTextMessage` against `https://api.line.me/v2/bot/message/push` with an idempotency `X-Line-Retry-Key` ([`client.ts:112-149`](../../../src/lib/line/client.ts)). A LINE **409** is treated as success and annotated `retryAccepted: true` rather than thrown ([`client.ts:132-141`](../../../src/lib/line/client.ts)). It is **not** gated by `lineSchedulerEnabled()` — only `LINE_CHANNEL_ACCESS_TOKEN` must be set, or the push throws. Afterwards it stores the send result on the review, inserts an outbound `line_messages` row, and records scheduler feedback (`accept` when the text is unchanged, `edit` otherwise).
- **`accept_no_send`** records feedback (`accept`/`edit`) and sets `accepted_no_send`. No LINE call.
- **`reject`** requires non-empty category + reason + correction (throws otherwise), records `reject` feedback with the rejected tutor ids, and sets `rejected`.
- **`dismiss`** records `dismiss` feedback and sets `dismissed`.

**Status codes:** **200** `{ review }`; **404 `{ "error": "Review not found" }`** when the service returns null; **400 `{ "error": <message> }`** for *any* thrown service error — the catch maps every exception to 400 ([`:129-132`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)), so a failed LINE push surfaces as a 400; plus the shared 401 / Invalid JSON / Invalid request envelopes.

### `POST /api/line/scheduler-reviews/[reviewId]/operational-plan`

Rebuild the deterministic operational plan (intent, draft, matched students, candidate sessions, proposed Wise actions) for a pending review. Handler: [`operational-plan/route.ts:13-52`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts).

**Request:** path param `reviewId`; **no body is read at all**.

**Preconditions and side effects, in order:**

1. Load the review → **404 `{ "error": "Review not found" }`** ([`:21-24`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)).
2. **400 `{ "error": "Only pending reviews can be rebuilt" }`** unless `status === "pending_review"` ([`:25-27`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)).
3. Load the inbound message → **404 `{ "error": "Inbound LINE message not found" }`** ([`:29-32`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)).
4. `buildLineOperationalReviewPlan` re-infers the intent, re-resolves verified links, reloads future sessions, and rebuilds the candidate/action lists ([`operational.ts:584-640`](../../../src/lib/line/operational.ts)); `intentType: "new_request"` short-circuits to an empty plan with `writebackStatus: "not_applicable"` ([`operational.ts:591-602`](../../../src/lib/line/operational.ts)). `patchLineSchedulerOperationalPlan` then persists `intentType`, `intentPayload`, `proposedDraft` (falling back to the existing draft when the new one is empty, [`:44`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)), `matchedStudentKeys`, `candidateSessions`, `proposedWiseActions`, `adminSelectedSessionIds`, and `writebackStatus` ([`data.ts:938-967`](../../../src/lib/line/data.ts)).

**Response 200** — `{ review }`, the reloaded review DTO.

---

## Wise actions

Append-only audit and confirmation of operational actions against Wise sessions, scoped to one review. **Session required.** Confirmation **never mutates Wise** in this build.

### `GET /api/line/scheduler-reviews/[reviewId]/wise-actions`

List the audit log for a review. Handler: [`wise-actions/route.ts:22-31`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts).

**Response 200** — `{ logs }`, `LineWiseActionLogDto[]` newest-first ([`data.ts:1028-1038`](../../../src/lib/line/data.ts)); each entry carries `actionType`, `status`, `dryRun`, `wiseSessionIds`, `requestPayload`, `responsePayload`, `errorMessage`, and the creating actor ([`data.ts:135-148`](../../../src/lib/line/data.ts)). No 404 — an unknown `reviewId` yields an empty array.

### `POST /api/line/scheduler-reviews/[reviewId]/wise-actions`

Confirm one proposed Wise action. Handler: [`wise-actions/route.ts:33-68`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts).

**Body** (`.strict()`, [`:8-11`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts)):

| Field | Type | Required | Rule |
|---|---|---|---|
| `actionId` | string | yes | trimmed, 1–160; must match an `id` inside the review's `proposedWiseActions`. |
| `selectedSessionIds` | string[] | no | each trimmed 1–240, ≤80 entries; defaults to the action's own `wiseSessionIds` when omitted or empty ([`operations.ts:42-47`](../../../src/lib/wise/operations.ts)). |

**Side effects** — `confirmLineWiseAction` ([`operations.ts:26-95`](../../../src/lib/wise/operations.ts)) writes an audit row and updates the review's writeback state, and nothing else:

| `WISE_SESSION_OPERATIONS_VERIFIED` | Log written | Review `writebackStatus` |
|---|---|---|
| not `"true"` ([`operations.ts:10-12`](../../../src/lib/wise/operations.ts)) | `status: "manual_required"`, `dryRun: true`, `errorMessage: "Wise cancel/reschedule endpoint contract is not verified in this environment."` | `manual_required` |
| `"true"` | `status: "dry_run"`, `dryRun: true`, response `"Dry run recorded; no Wise mutation was sent."` | `dry_run` |

Either way `adminSelectedSessionIds` is persisted on the review.

**Responses:** **200** `{ log, endpointVerified }`; **400 `{ "error": <message> }`** for every thrown error — "LINE review not found", "Only pending reviews can confirm Wise actions", "Wise action not found", "Select at least one Wise session before confirming" ([`operations.ts:34-47`](../../../src/lib/wise/operations.ts)) — the route catch maps all exceptions to 400 ([`:64-67`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts)), so even a missing review surfaces as 400 rather than 404; plus shared 401 / Invalid JSON / Invalid request.

---

## Messages

Per-inbound-message operations. **Session required.**

### `POST /api/line/messages/[messageId]/promote`

Manually escalate a message the classifier did not queue into a pending review. Handler: [`promote/route.ts:15-32`](../../../src/app/api/line/messages/[messageId]/promote/route.ts).

**Request:** path param `messageId`; no body is read.

**Side effects** (`promoteLineMessageToReview`, [`review-service.ts:423-463`](../../../src/lib/line/review-service.ts)): if a review already exists for the message it is returned as-is with `alreadyExisted: true` and nothing is written. Otherwise it records classification feedback (`reviewedCategory: "scheduling_request"`, actor-attributed) and creates a `pending_review` row with an **empty** `proposedDraft`, no selected tutors, and the message's stored classifier confidence/summary (defaulting to "Promoted from the missed-message queue") — the same shape as the no-AI webhook path. It **never** calls the AI and **never** sends a LINE message.

**Responses:** **200** `{ review, alreadyExisted }`; **404 `{ "error": "LINE message not found" }`** when the id is unknown *or* the message has no non-blank text ([`:27-29`](../../../src/app/api/line/messages/[messageId]/promote/route.ts), [`review-service.ts:428-431`](../../../src/lib/line/review-service.ts)).

### `PATCH /api/line/messages/[messageId]/classification-feedback`

Record a human correction of the classifier verdict — the accuracy signal behind the analytics block. Handler: [`classification-feedback/route.ts:20-52`](../../../src/app/api/line/messages/[messageId]/classification-feedback/route.ts).

**Body** (`.strict()`, [`:7-9`](../../../src/app/api/line/messages/[messageId]/classification-feedback/route.ts)): `reviewedCategory` — required enum `scheduling_request | scheduling_change | non_scheduling | unclear`.

**Side effects:** stamps `classificationReviewedCategory`, `classificationReviewedCorrect` (computed by strict comparison against the stored `classifierCategory`), the reviewer email/name, and `classificationReviewedAt` ([`data.ts:682-729`](../../../src/lib/line/data.ts)). Setting `classificationReviewedAt` also removes the message from the false-negative queue.

**Responses:** **200** `{ feedback }` = `{ id, classifierCategory, classificationReviewedCategory, classificationReviewedCorrect }`; **404 `{ "error": "LINE message not found" }`**; plus shared 401 / Invalid JSON / Invalid request.

---

## Students

### `GET /api/line/students`

Typeahead search over current credit-control students, used when linking a contact to a student. **Session required.** Handler: [`students/route.ts:6-19`](../../../src/app/api/line/students/route.ts).

**Query param:** `q`. A trimmed query **shorter than 2 characters** short-circuits to **200 `{ students: [] }`** without querying ([`:12-15`](../../../src/app/api/line/students/route.ts)).

**Response 200** — `{ students }`, up to 20 `LineStudentSearchRow`s (`wiseStudentId`, `studentKey`, `studentName`, `parentName`, `activated`, `hasFutureSessions`, `hasLivePackage`, plus `matchType` ∈ `exact_code | nickname_code | student_key | student_name | parent_name`) ([`student-links.ts:45-65`, `:603-639`](../../../src/lib/line/student-links.ts)). Ranking is match-quality first, then activated / future-sessions / live-package, then name.

---

## Contacts — labels and student links

Per-contact label edits and the contact↔student link lifecycle. **Session required.** The shared response DTO is `LineContactStudentLinkDto` ([`student-links.ts:20-43`](../../../src/lib/line/student-links.ts)) — link + student identity, `status` (`suggested | verified | rejected`), `confidence`, free-form `evidence`, reviewer/assignment attribution, and three `currentStudent*` liveness flags.

### `PATCH /api/line/contacts/[contactId]`

Edit the staff-applied parent/student labels on a contact and re-derive link suggestions. Handler: [`[contactId]/route.ts:15-42`](../../../src/app/api/line/contacts/[contactId]/route.ts).

**Body** (`.strict()`, [`:8-11`](../../../src/app/api/line/contacts/[contactId]/route.ts)):

| Field | Type | Rule |
|---|---|---|
| `linkedParentLabel` | string \| null | optional, trimmed, ≤200 |
| `linkedStudentLabel` | string \| null | optional, trimmed, ≤500 |

> **Not a partial update.** `updateLineContactLabels` writes `input.X ?? null` for *both* columns ([`data.ts:374-381`](../../../src/lib/line/data.ts)), so omitting one field **clears** it. Callers must send both labels on every request.

**Side effects:** writes the labels, then `ensureLineContactStudentLinkSuggestions` re-parses the new student label for dotted student codes and inserts `status: "suggested"` links with `confidence: 0.95` (`onConflictDoNothing` on `(contactId, studentKey)`) — never `verified`, and existing rows are never downgraded ([`student-links.ts:468-537`](../../../src/lib/line/student-links.ts)).

**Response 200** — `{ links }`, the contact's full `LineContactStudentLinkDto[]` after the update. **No 404** — an unknown `contactId` updates zero rows and returns `{ "links": [] }`.

### `GET /api/line/contacts/[contactId]/student-links`

List a contact's student links. Handler: [`student-links/route.ts:30-40`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts).

**Side effect (a read that writes):** the handler calls `ensureLineContactStudentLinkSuggestions` with no label override, so a plain `GET` can insert new `suggested` link rows derived from the contact's display name + stored student label before returning ([`student-links.ts:468-537`](../../../src/lib/line/student-links.ts)).

**Response 200** — `{ links }`.

### `POST /api/line/contacts/[contactId]/student-links`

Create (or upgrade) a **verified** link from this contact to a specific current student. Handler: [`student-links/route.ts:42-76`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts).

**Body** (`.strict()`, [`:12-14`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)): `studentKey` — required string, trimmed, 1–240.

**Side effects:** `createVerifiedLineContactStudentLink` upserts on `(contactId, studentKey)` with `status: "verified"`, `confidence: 1`, `evidence.source: "admin_search"`, and the reviewer email/name/timestamp — on conflict it **overwrites** an existing `suggested` or `rejected` row ([`student-links.ts:643-691`](../../../src/lib/line/student-links.ts)).

**Responses:** **201** `{ link, links }`; **404 `{ "error": "Current credit-control student not found" }`** when the key is absent from the active credit-control snapshot ([`:70-72`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)); plus shared 401 / Invalid JSON / Invalid request.

### `PATCH /api/line/contacts/[contactId]/student-links`

Verify or reject an existing link by id. Handler: [`student-links/route.ts:78-113`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts).

**Body** (`.strict()`, [`:16-19`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)):

| Field | Type | Rule |
|---|---|---|
| `action` | `"verify"` \| `"reject"` | required; mapped to status `verified` / `rejected` ([`:104`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)) |
| `linkId` | string (UUID) | required |

**Side effects:** the update is scoped to `(linkId, contactId)` — a link belonging to another contact is not touched — and stamps status, reviewer, `reviewedAt`, and `validationNote: null` (this schema has no note field, so any existing note is cleared) ([`student-links.ts:693-722`](../../../src/lib/line/student-links.ts)). Note this is the *contact-scoped* mutator; the queue-scoped one at [`PATCH /api/line/contacts/link-validation/[linkId]`](#patch-apilinecontactslink-validationlinkid) additionally excludes phantoms and triggers a review recompute.

**Responses:** **200** `{ link, links }`; **404 `{ "error": "Student link not found" }`**; plus shared 401 / Invalid JSON / Invalid request.

---

## Contacts — link validation

The human round-robin tracker that turns `suggested` links into `verified` / `rejected` ones. **Session required.** The *summary* endpoint additionally applies a validation-lead sub-gate (it degrades, it does not 403).

### `GET /api/line/contacts/link-validation`

List validation tasks for a scope. Handler: [`link-validation/route.ts:23-59`](../../../src/app/api/line/contacts/link-validation/route.ts).

**Query params:**

| Param | Rule | On failure |
|---|---|---|
| `scope` | default `"my"`; enum `my \| all \| unassigned \| verified \| rejected \| phantom` ([`link-validation.ts:12`](../../../src/lib/line/link-validation.ts)) | 400 `{ "error": "Invalid scope" }` |
| `runId` | optional UUID ([`:12`](../../../src/app/api/line/contacts/link-validation/route.ts)) | 400 `{ "error": "Invalid runId" }` |
| `page` | `z.coerce.number().int().min(1).default(1)` ([`:13`](../../../src/app/api/line/contacts/link-validation/route.ts)) | 400 `{ "error": "Invalid page" }` |
| `pageSize` | `z.coerce.number().int().min(1).max(100).default(100)` ([`:14`](../../../src/app/api/line/contacts/link-validation/route.ts)); re-clamped to 1–100 in the service ([`link-validation.ts:170-173`](../../../src/lib/line/link-validation.ts)) | 400 `{ "error": "Invalid pageSize" }` |

**Scope semantics** ([`link-validation.ts:420-451`](../../../src/lib/line/link-validation.ts)) — `phantom` is the archive filter and returns **only** quarantined rows (`isPhantom = true`) regardless of status; every other scope excludes phantoms (`realContactCondition()`, [`:246-249`](../../../src/lib/line/link-validation.ts)). `my` = suggested links assigned to the caller's lowercased email (an actor with no email returns an empty task list); `unassigned` = suggested with no assignee; `verified` / `rejected` = by status; `all` = suggested. Rows are ordered parent name → student name → student key → contact display name.

**Response 200** — `{ tasks, reviewers, pagination }` (not wrapped in an envelope key): `tasks` is `LineLinkValidationTaskDto[]` ([`link-validation.ts:20-54`](../../../src/lib/line/link-validation.ts) — link fields plus contact `lineUserId`/`displayName`, OA-resolver provenance, assignment fields, and current-student flags); `reviewers` is every `admin_users` row with its open-assignment count ([`:365-401`](../../../src/lib/line/link-validation.ts)); `pagination` is `{ page, pageSize, total, pageCount }`.

### `GET /api/line/contacts/link-validation/summary`

Validation-lead dashboard counts. Handler: [`summary/route.ts:16-33`](../../../src/app/api/line/contacts/link-validation/summary/route.ts).

**Query param:** `runId` — optional UUID; invalid → **400 `{ "error": "Invalid runId" }`**.

**Auth nuance:** when the caller's email is not a validation lead, the service returns an **empty summary with `canViewTracker: false`** rather than an error ([`link-validation.ts:494-496`, `:143-159`](../../../src/lib/line/link-validation.ts)). The lead list comes from `LINE_VALIDATION_LEAD_EMAILS` (comma-separated) and falls back to a two-address built-in default ([`:220-234`](../../../src/lib/line/link-validation.ts)).

**Response 200** — `{ summary }` = `{ canViewTracker, runId, totals, reviewers, recentActivity }`, where `totals` is `{ assigned, unassigned, verified, rejected, remaining, total, completionRate }` (all phantom-excluded, per IDENT-05) and `reviewers` carries per-reviewer `assigned/verified/rejected/remaining/completionRate` ([`link-validation.ts:62-93`](../../../src/lib/line/link-validation.ts)).

### `POST /api/line/contacts/link-validation/assign`

Distribute suggested links across reviewers round-robin. Handler: [`assign/route.ts:16-46`](../../../src/app/api/line/contacts/link-validation/assign/route.ts).

**Body** (`.strict()`, [`:10-14`](../../../src/app/api/line/contacts/link-validation/assign/route.ts)):

| Field | Type | Required | Rule |
|---|---|---|---|
| `runId` | string (UUID) | yes | scopes candidates to one OA-resolver run |
| `reviewerEmails` | string[] | yes | valid emails, 1–50 |
| `linkIds` | string[] | no | UUIDs, 1–500; **omit to assign the run's currently unassigned suggested links** ([`link-validation.ts:672-676`](../../../src/lib/line/link-validation.ts)) |

**Side effects:** every reviewer email must exist in `admin_users` or the call throws; candidates are sorted deterministically and handed to `planRoundRobinValidationAssignments`, which balances against each reviewer's existing open-assignment count; each winning row gets `validationAssignedToEmail/Name`, `validationAssignedRunId`, and `validationAssignedAt` ([`link-validation.ts:625-713`](../../../src/lib/line/link-validation.ts)). Phantom rows are excluded from the candidate set. Writes are one `UPDATE` per link and are **not** transactional.

**Response 200** — `{ assigned, tasks, reviewers, pagination }`: the count written plus a fresh `scope: "all"` listing for the run ([`link-validation.ts:705-712`](../../../src/lib/line/link-validation.ts)).

**Errors:** a thrown `LineLinkValidationError` is returned with its own `status` (default 400) and message — "Select at least one reviewer." or "Unknown reviewer email: …" ([`assign/route.ts:40-45`](../../../src/app/api/line/contacts/link-validation/assign/route.ts), [`link-validation.ts:95-103`](../../../src/lib/line/link-validation.ts)). Other exceptions are re-thrown (framework 500). Plus shared 401 / Invalid JSON / Invalid request.

### `PATCH /api/line/contacts/link-validation/[linkId]`

Verify or reject one link from the queue. Handler: [`[linkId]/route.ts:21-54`](../../../src/app/api/line/contacts/link-validation/[linkId]/route.ts).

**Body** (`.strict()`, [`:7-10`](../../../src/app/api/line/contacts/link-validation/[linkId]/route.ts)):

| Field | Type | Rule |
|---|---|---|
| `status` | `"verified"` \| `"rejected"` | required |
| `note` | string \| null | optional, trimmed, ≤1000 → stored as `validationNote` |

**Side effects** ([`link-validation.ts:715-801`](../../../src/lib/line/link-validation.ts)):

- The update is guarded by `isPhantom = false` ([`:737`](../../../src/lib/line/link-validation.ts)) — a quarantined row cannot be resolved and returns 404.
- **On `verified` only (IDENT-06):** every `pending_review` scheduler row for the same contact is recomputed inline — the operational plan is rebuilt from the inbound message text and re-persisted so `matchedStudentKeys` / `writebackStatus` reflect the new identity, with `adminSelectedSessionIds` reset to `[]`. Per-row failures are swallowed and never abort the status change ([`:749-796`](../../../src/lib/line/link-validation.ts)).

**Responses:** **200** `{ task }` (a `LineLinkValidationTaskDto`); **404 `{ "error": "Student link not found" }`** when the link is missing, phantom, or its contact row is gone; plus shared 401 / Invalid JSON / Invalid request.

---

## Contacts — alias import

Bulk-attach student labels to contacts from a pasted LINE chat list or a screenshot. **Session required.**

### `POST /api/line/contacts/alias-import/preview`

Parse text and/or an image into proposed alias rows without committing. Handler: [`alias-import/preview/route.ts:30-70`](../../../src/app/api/line/contacts/alias-import/preview/route.ts).

**Request: `multipart/form-data`** (the only non-JSON body in this API). A body that is not multipart → **400 `{ "error": "Expected multipart form data" }`** ([`:36-41`](../../../src/app/api/line/contacts/alias-import/preview/route.ts)). Fields:

| Field | Type | Rule |
|---|---|---|
| `image` | File | optional; MIME must be `image/png`, `image/jpeg`, or `image/webp`, size ≤ 5 MB ([`:7-8`, `:18-23`](../../../src/app/api/line/contacts/alias-import/preview/route.ts)) |
| `text` | string | optional; pasted chat-list text |
| `preferredContactId` | string | optional; biases contact matching |

Violations return **400** with the thrown message — "Image must be 5MB or smaller" / "Image must be PNG, JPEG, or WebP". Supplying neither `image` nor `text` → **400 `{ "error": "Paste chat-list text or upload a screenshot" }`** ([`:53-56`](../../../src/app/api/line/contacts/alias-import/preview/route.ts)). When **both** are supplied the image wins — the text branch is never reached ([`contact-aliases.ts:471-474`](../../../src/lib/line/contact-aliases.ts)).

**Side effects:** none persisted — `previewLineAliasImport` only computes ([`contact-aliases.ts:465-488`](../../../src/lib/line/contact-aliases.ts)). The image path calls OpenAI for extraction.

**Responses:** **200** `{ preview }` = `{ source: "text" | "image", rows }`, each row carrying `aliasLabel`, `latestMessagePreview`, `timeLabel`, `rawText`, `parsedCodes`, `suggestedStudents`, `contactCandidates` (with `score` + `reasons`), and `autoSelectedContactId` ([`contact-aliases.ts:17-69`](../../../src/lib/line/contact-aliases.ts)). On a thrown error: **503** when the message contains `"configured"` — i.e. `OPENAI_API_KEY` / the AI scheduler is unconfigured ([`contact-aliases.ts:363-365`](../../../src/lib/line/contact-aliases.ts)) — otherwise **500** ([`:66-69`](../../../src/app/api/line/contacts/alias-import/preview/route.ts)).

### `POST /api/line/contacts/alias-import/commit`

Persist the reviewed alias rows. Handler: [`alias-import/commit/route.ts:14-40`](../../../src/app/api/line/contacts/alias-import/commit/route.ts).

**Body** (JSON, `.strict()`, [`:7-12`](../../../src/app/api/line/contacts/alias-import/commit/route.ts)): `rows` — required array of 1–100 objects `{ contactId: UUID, aliasLabel: string trimmed 1–500 }`.

**Side effects:** per row, sets the contact's `linkedStudentLabel` (which, per the `updateLineContactLabels` semantics above, also **clears `linkedParentLabel`**) and then regenerates suggested links from the new label; blank labels are skipped silently ([`contact-aliases.ts:490-507`](../../../src/lib/line/contact-aliases.ts)). Rows are applied sequentially and non-transactionally — a mid-list failure leaves earlier rows applied.

**Response 200** — `{ result }` = `{ applied: [{ contactId, aliasLabel, suggestedLinkCount }] }` ([`contact-aliases.ts:71-77`](../../../src/lib/line/contact-aliases.ts)); plus shared 401 / Invalid JSON / Invalid request.

---

## Contacts — bulk identity maintenance

Long-running jobs that reconcile the contact table against the LINE Official Account. **Session required.**

### `POST /api/line/contacts/refresh-profiles`

Re-fetch display name / picture / status for **every** contact from the LINE profile API. Handler: [`refresh-profiles/route.ts:6-14`](../../../src/app/api/line/contacts/refresh-profiles/route.ts).

**Request:** no body, no params — the handler signature is `POST()`. Note this route has **no `maxDuration` override**: it runs one sequential LINE call per contact ([`contact-aliases.ts:509-543`](../../../src/lib/line/contact-aliases.ts)) under the platform default.

**Side effects:** updates each contact's cached profile, ordered by `lastSeenAt` desc. A missing profile counts as `missing` (no write); a thrown error is captured per contact and does not abort the run.

**Response 200** — `{ result }` = `{ total, refreshed, missing, failed: [{ lineUserId, error }] }` ([`contact-aliases.ts:79-84`](../../../src/lib/line/contact-aliases.ts)).

### `POST /api/line/contacts/followers-reanchor`

Combined followers re-anchor **plus** backlog identity recovery. Handler: [`followers-reanchor/route.ts:15-41`](../../../src/app/api/line/contacts/followers-reanchor/route.ts). `maxDuration = 300` ([`:13`](../../../src/app/api/line/contacts/followers-reanchor/route.ts)) — the re-anchor pass makes one sequential LINE call per follower.

**Query param:** `dryRun` — exactly `"true"` skips the re-anchor pass entirely (writes nothing) and runs backlog recovery read-only ([`:25`, `:31-32`](../../../src/app/api/line/contacts/followers-reanchor/route.ts)). No body is read; there is no Zod schema.

**Side effects:**

- `runLineFollowersReanchor` (skipped on `dryRun`) paginates the follower-ids endpoint, fetches each profile, upserts a `line_contacts` row keyed on `lineUserId` (`onConflictDoNothing`, idempotent), and runs the display-name suggestion path per follower ([`student-links.ts:764-812`](../../../src/lib/line/student-links.ts)).
- `runLineBacklogRecovery` re-fetches the full follower roster (batched, concurrency 10), matches fresh display names against human-verified OA-resolver targets, and inserts links **always as `suggested`, never `verified`** (IDENT-02/IDENT-07) ([`backlog-recovery.ts:40-100`](../../../src/lib/line/backlog-recovery.ts)). The route comment flags that this combined path double-fetches the roster; the single-fetch production vehicle is the internal cron `/api/internal/line-backlog-recovery` ([`followers-reanchor/route.ts:7-12`](../../../src/app/api/line/contacts/followers-reanchor/route.ts), see [`reference/api/internal-crons.md`](./internal-crons.md)).

**Responses:** **200** `{ reanchor, backlog }` — `reanchor` is `{ followerCount, upsertedContacts, suggestionsCreated, errors[] }` or `null` on `dryRun`; `backlog` is `{ contactsScanned, targetsCount, matchedCount, insertedCount, dryRun, dryRunMatches? }` (`dryRunMatches` only when `dryRun=true`). **500 `{ "error": <message> }`** on any thrown error, falling back to "Failed to run followers re-anchor / backlog recovery" ([`:34-40`](../../../src/app/api/line/contacts/followers-reanchor/route.ts)).

---

## Contacts — OA resolver

A browser-extension-driven bulk pipeline that maps LINE OA chats to students. Two endpoints are **token-authenticated** (the extension) and export `OPTIONS` with permissive CORS (`Access-Control-Allow-Origin: *`, sent on every response including errors); the other four require a **session**.

### `GET /api/line/contacts/oa-resolver/worklist`

The extension pulls its work items. **Auth: per-run bearer token.** Handler: [`worklist/route.ts:21-34`](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts).

**Request:** `Authorization: Bearer <token>`; no query, no body — the token identifies the run. `OPTIONS` returns **204** with the CORS headers ([`:17-19`](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts)).

**Responses:** **200** `{ worklist }` = `{ runId, expiresAt, rows }`, where `rows` are only the run's `pending` rows that have a `searchCode` — so the list shrinks as the extension reports progress ([`oa-resolver.ts:608-633`](../../../src/lib/line/oa-resolver.ts)) — each `{ rowId, studentKey, studentName, parentName, searchCode, searchCodes[] }`. **401 `{ "error": "Invalid or expired resolver token" }`** when the header is absent, the hash does not match, or `expiresAt` has passed ([`oa-resolver.ts:592-606`](../../../src/lib/line/oa-resolver.ts)) — all with CORS headers attached.

### `GET /api/line/contacts/oa-resolver/runs`

List runs, or fetch the caller's latest run. **Session required.** Handler: [`runs/route.ts:17-33`](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts).

**Query params:**

| Param | Behaviour |
|---|---|
| `latest=true` | Returns `{ run }` from `getLatestLineOaResolverRun` — the newest run created by the caller's email, falling back to the newest run overall when the session has no email ([`oa-resolver.ts:505-524`](../../../src/lib/line/oa-resolver.ts)). `run` is `null` when none exist. |
| otherwise | Returns `{ runs }` from `listLineOaResolverRuns`. `limit` is `Number(param ?? "20")`, falling back to 20 when non-finite ([`runs/route.ts:25-27`](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts)), then clamped by the service to 1–50 ([`oa-resolver.ts:530`](../../../src/lib/line/oa-resolver.ts)). |

Each `LineOaResolverRunDto` carries the run status (`active | committed | expired`), `tokenPrefix` (never the token), the seven per-status row counters, creator, `expiresAt`, and its full `rows` array ([`oa-resolver.ts:41-84`](../../../src/lib/line/oa-resolver.ts)).

### `POST /api/line/contacts/oa-resolver/runs`

Create a run and mint the extension token. **Session required.** Handler: [`runs/route.ts:35-43`](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts).

**Request:** no body, no params.

**Side effects** (`createLineOaResolverRun`, [`oa-resolver.ts:540-590`](../../../src/lib/line/oa-resolver.ts)): generates `token = "<runId>.<32 random bytes base64url>"`, stores only its SHA hash plus a display `tokenPrefix`, sets `expiresAt` to **now + 8 hours** (`TOKEN_TTL_MS`, [`:111`](../../../src/lib/line/oa-resolver.ts)), then materializes one `line_oa_resolver_rows` row per student in the active credit-control snapshot — status `pending` when a search code could be derived, else `needs_manual_code` ([`oa-resolver.ts:312-342`](../../../src/lib/line/oa-resolver.ts)).

**Response 201** — `{ run, token }`. **The plaintext `token` is returned exactly once**; it cannot be recovered afterwards.

### `GET /api/line/contacts/oa-resolver/runs/[runId]`

Fetch one run with its rows (ordered by `lineUserId`, then `studentName`). **Session required.** Handler: [`runs/[runId]/route.ts:8-21`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/route.ts).

**Responses:** **200** `{ run }`; **404 `{ "error": "Resolver run not found" }`**.

### `POST /api/line/contacts/oa-resolver/runs/[runId]/rows`

The extension posts back resolved / ambiguous / failed rows. **Auth: per-run bearer token.** Handler: [`rows/route.ts:52-90`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts).

**Request:** `Authorization: Bearer <token>` — absent → **401 `{ "error": "Missing resolver token" }`** ([`:54-59`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)). `OPTIONS` returns **204** + CORS ([`:48-50`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)).

**Body** (`.strict()`, [`:36-38`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)): `rows` — array of **1–50** row objects ([`:24-34`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)):

| Field | Type | Required | Rule |
|---|---|---|---|
| `rowId` | string (UUID) | yes | must belong to `runId`, else the row is silently skipped ([`oa-resolver.ts:744-752`](../../../src/lib/line/oa-resolver.ts)) |
| `status` | enum | yes | `matched \| ambiguous \| no_match \| error` |
| `lineChatUrl`, `chatTitle` | string \| null | no | ≤500 |
| `matchMode`, `captureMode` | string \| null | no | ≤80 |
| `errorMessage` | string \| null | no | ≤1000 |
| `candidates` | array | no | ≤25 candidate objects |
| `evidence` | record | no | free-form |

Each candidate (`.strict()`, [`:12-22`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)): `lineChatUrl` (required, ≤500), plus optional `chatTitle`, `adminNoteRaw` (≤1000), `relationshipRole` (`mom | dad | secretary | other | unknown`), `candidateRank` (int 1–100), `captureMode`, `matchMode`, `searchCode` (≤120), `siblingFanout` (bool).

**Side effects** (`updateLineOaResolverRowsFromExtension`, [`oa-resolver.ts:722-…`](../../../src/lib/line/oa-resolver.ts)) — the guards demote rather than reject:

- `matched`/`ambiguous` with **zero parseable candidate URLs** → the row is written as `status: "error"` with an explanatory `errorMessage`, and the response is still 200 ([`oa-resolver.ts:762-777`](../../../src/lib/line/oa-resolver.ts)).
- `no_match` whose evidence still shows the extension parked on a LINE OA chat URL → `status: "error"`, `matchMode: "extension_context_guard"` ([`oa-resolver.ts:779-803`](../../../src/lib/line/oa-resolver.ts)).
- A valid multi-candidate result is stored as `ambiguous`; single-candidate as `matched`, with candidates preserved in `evidence.candidateContacts` ([`oa-resolver.ts:805-817`](../../../src/lib/line/oa-resolver.ts)).
- Candidates can **fan out to sibling rows** sharing a normalized parent name, marked `matchMode: "sibling_fanout"` and `siblingFanout: true` ([`oa-resolver.ts:670-720`](../../../src/lib/line/oa-resolver.ts)).

**Responses:** **200** `{ run }` (the refreshed run DTO, CORS headers attached); **400** `{ "error": "Invalid JSON" }` or the Invalid-request envelope, both with CORS; **401 `{ "error": "Invalid or expired resolver token" }`** when the token is invalid, expired, or belongs to a different run ([`:82-87`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts), [`oa-resolver.ts:740-741`](../../../src/lib/line/oa-resolver.ts)).

### `POST /api/line/contacts/oa-resolver/runs/[runId]/commit`

Materialize resolved rows into contacts + student links. **Session required.** Handler: [`commit/route.ts:17-49`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts).

**Body** (`.strict()`, [`:7-13`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts)) — both fields optional, and **a missing or malformed JSON body is tolerated as `{}`** rather than 400 ([`:23-28`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts)):

| Field | Type | Rule |
|---|---|---|
| `rowIds` | string[] (UUID) | 1–1000; restricts the commit to those rows |
| `selectedCandidates` | array | ≤5000 of `{ rowId: UUID, lineUserId: /^U[a-fA-F0-9]{32}$/ }`; picks which candidates of an ambiguous row to commit, and derives `rowIds` when `rowIds` is absent |

With neither field the commit covers every `matched` + `ambiguous` row in the run ([`oa-resolver.ts:963-985`](../../../src/lib/line/oa-resolver.ts)).

**Side effects** (`commitLineOaResolverRun`, [`oa-resolver.ts:948-1099`](../../../src/lib/line/oa-resolver.ts)):

- Per selected candidate: get-or-create a `line_contacts` row for the `lineUserId`, then upsert a **`suggested`** contact↔student link carrying full resolver evidence (OA account id, original URL, search code, relationship role, sibling-fanout flag, run/row ids) with `sourceKind: "line_oa_resolver"`. Commit **never produces a `verified` link** — verification is the job of the link-validation queue.
- A row whose student vanished from the current snapshot, or that has no selected valid candidate, is set to `status: "error"` with a reason and counted as `skipped`.
- Committed rows get `status: "committed"` plus `committedContactId` / `committedLinkId`; run counters are recomputed; the run flips to `status: "committed"` (with `committedAt`) only when no `matched` or `ambiguous` rows remain, otherwise it stays `active` ([`oa-resolver.ts:1083-1093`](../../../src/lib/line/oa-resolver.ts)).

**Responses:** **200** `{ result }` = `{ committed, skipped, run }` ([`oa-resolver.ts:100-104`](../../../src/lib/line/oa-resolver.ts)); **404 `{ "error": "Resolver run not found" }`**; **400** on Zod failure only.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
