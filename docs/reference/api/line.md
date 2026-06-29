# LINE API Reference

**Status:** Stable read/review paths; the Wise write-path is dry-run only (see [§ Wise actions](#wise-actions)). **Scope:** the 29 documented non-`OPTIONS` HTTP handlers under [`src/app/api/line/`](../../../src/app/api/line/).

This page is the mechanical reference — method, path, auth, request/response shapes, side effects, and status codes per endpoint. Feature meaning, lifecycles, and data flows live in [`features/line-integration.md`](../../features/line-integration.md); that doc owns the "why" and links here for signatures.

## Authentication model

Three distinct auth mechanisms guard these routes. Each endpoint section states which one applies.

1. **Admin session (Auth.js)** — the default. Handlers call `await auth()` and return **401 `{ "error": "Unauthorized" }`** when there is no session ([`scheduler-reviews/route.ts:25-28`](../../../src/app/api/line/scheduler-reviews/route.ts) is the canonical pattern). A session only exists for a Google account whose lowercased email is present in the `admin_users` allowlist — sign-in is rejected otherwise in `signInCallback` ([`auth.ts:12-22`](../../../src/lib/auth.ts)). So "requires session" means "requires an allowlisted admin." The auth gate in [`middleware.ts`](../../../src/middleware.ts) redirects unauthenticated browser requests to `/login`, but the in-handler `auth()` check is what returns JSON 401 for API callers.
2. **LINE HMAC signature** — the webhook only. The raw body is verified against the `x-line-signature` header using `HMAC-SHA256(channelSecret, rawBody)` base64, compared with `timingSafeEqual` after a length pre-check ([`signature.ts:3-20`](../../../src/lib/line/signature.ts)). No session.
3. **Per-run resolver bearer token** — the two browser-extension endpoints (`oa-resolver/worklist`, `oa-resolver/runs/[runId]/rows`). A `Bearer <token>` is pulled from the `Authorization` header and resolved against a run token in the DB; there is no Google session ([`worklist/route.ts:11-15`](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts)).

**Public-route note:** [`middleware.ts:10-12`](../../../src/middleware.ts) exempts exactly three LINE paths from the session redirect — `/api/line/webhook`, `/api/line/contacts/oa-resolver/worklist`, and the regex `^/api/line/contacts/oa-resolver/runs/[^/]+/rows$`. These are precisely the three machine-facing endpoints; they self-authenticate via signature or token. Every other LINE route is behind the session gate.

Standard error envelopes shared by the session-guarded routes:

- Malformed JSON body → **400 `{ "error": "Invalid JSON" }`**.
- Zod `.safeParse()` failure → **400 `{ "error": "Invalid request", "details": <flattened> }`** (where a Zod body schema exists).
- Missing entity → **404** with a route-specific message.

---

## Webhook

### `POST /api/line/webhook`

Inbound LINE event ingestion. **Auth: LINE HMAC signature** (no session). `maxDuration = 60` ([`route.ts:7`](../../../src/app/api/line/webhook/route.ts)).

**Feature gate:** if `lineSchedulerEnabled()` is false, returns **503 `{ ok: false, error: "LINE scheduler is not configured" }`** before any processing ([`route.ts:10-12`](../../../src/app/api/line/webhook/route.ts)). The flag is true only when `ENABLE_LINE_SCHEDULER !== "false"` **and** both `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` are set ([`client.ts:19-23`](../../../src/lib/line/client.ts)).

**Request:** raw LINE webhook JSON body (read via `request.text()` so the exact bytes can be signed). The `x-line-signature` header is required. There is no Zod schema — the body is the LINE platform's event envelope, parsed inside the handler.

**Side effects** (delegated to `handleLineWebhookPost`, [`webhook.ts:17-60`](../../../src/lib/line/webhook.ts)):
- Verifies the signature; persists the payload and per-event messages via `recordLineWebhookPayload`.
- For each newly created inbound message, schedules background scheduler processing with `after(...)` → `processLineMessageForScheduler` (classification + draft generation runs off the request path; failures are logged, not surfaced) ([`route.ts:21-29`](../../../src/app/api/line/webhook/route.ts)).

**Responses:**
- **200** `{ ok: true, createdMessageIds: string[], duplicateEvents: number, ignoredEvents: number, retractedMessages: number }` ([`webhook.ts:50-59`](../../../src/lib/line/webhook.ts)).
- **401** `{ ok: false, error: "Invalid LINE signature" }` ([`webhook.ts:29-32`](../../../src/lib/line/webhook.ts)).
- **400** `{ ok: false, error: "Invalid JSON" }` if the body is not valid JSON ([`webhook.ts:38-43`](../../../src/lib/line/webhook.ts)).
- **503** when the scheduler is not configured (see above).

---

## Scheduler reviews

The human-review queue for inbound scheduling messages. **All endpoints in this group require an admin session.**

### `GET /api/line/scheduler-reviews`

List reviews, optionally with analytics ([`scheduler-reviews/route.ts:24-54`](../../../src/app/api/line/scheduler-reviews/route.ts)).

**Query params** (all optional; validated individually, no single body schema):
- `status` — must match the enum `pending_review | approved_sent | accepted_no_send | rejected | dismissed` ([:7-13](../../../src/app/api/line/scheduler-reviews/route.ts)); invalid → **400 `{ "error": "Invalid status" }`**.
- `intentType` — must match `new_request | cancel_one_off | pause_until | resume | reschedule | unclear_change` ([:15-22](../../../src/app/api/line/scheduler-reviews/route.ts)); invalid → **400 `{ "error": "Invalid intentType" }`**.
- `conversationId` — free-form string filter.
- `analytics=true` — additionally computes `getLineSchedulerAnalytics(db)`.

**Response:** **200** `{ reviews, analytics }` where `analytics` is the analytics object when `analytics=true`, else `null` ([:44-53](../../../src/app/api/line/scheduler-reviews/route.ts)).

### `GET /api/line/scheduler-reviews/false-negatives`

Surface non-scheduling-classified messages that may actually be scheduling requests ([`false-negatives/route.ts:9-27`](../../../src/app/api/line/scheduler-reviews/false-negatives/route.ts)).

**Query params:** `threshold` (optional) — coerced number in `[0, 1]` (`z.coerce.number().min(0).max(1)`, [:7](../../../src/app/api/line/scheduler-reviews/false-negatives/route.ts)); invalid → **400 `{ "error": "Invalid threshold" }`**. Omitted → service default.

**Response:** **200** `{ candidates }` from `listLineFalseNegativeCandidates(db, { threshold })`.

### `GET /api/line/scheduler-reviews/[reviewId]/context`

Fetch the surrounding chat context for one review ([`[reviewId]/context/route.ts:8-21`](../../../src/app/api/line/scheduler-reviews/[reviewId]/context/route.ts)).

**Path param:** `reviewId`. **Response:** **200** `{ context }`; **404 `{ "error": "Review not found" }`** when `getLineReviewChatContext` returns null.

### `PATCH /api/line/scheduler-reviews/[reviewId]`

Take a decision on a review. **This is the primary review-action endpoint** ([`[reviewId]/route.ts:60-133`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)).

**Body:** a Zod **discriminated union on `action`** with `.strict()` members ([:12-44](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)):

| `action` | Required fields | Optional fields |
|----------|-----------------|-----------------|
| `approve_send` | `finalText` (1–5000 chars) | `selectedTutorIds` (≤12), `studentLinkOverride` (bool) |
| `accept_no_send` | — | `finalText` (≤5000), `selectedTutorIds` (≤12), `studentLinkOverride` |
| `reject` | `reasonCategory` (enum: `wrong_student_link \| wrong_extracted_request \| wrong_tutor_fit \| wrong_availability \| unsafe_draft \| unclear \| other`), `rejectionReason` (1–500), `staffCorrection` (1–5000) | `rejectedTutorIds` (≤12) |
| `dismiss` | — | `rejectionReason` (≤500) |

The handler dispatches to one of `approveLineSchedulerReview` / `acceptLineSchedulerReviewNoSend` / `rejectLineSchedulerReview` / `dismissLineSchedulerReview` in [`review-service.ts`](../../../src/lib/line/review-service.ts) ([:88-122](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)). The session email + name are passed as the `actor` for audit ([:48-53](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)).

**Side effects:** `approve_send` is the path that can push an outbound LINE reply (gated downstream by `ENABLE_LINE_SCHEDULER`); the others update review state without sending. See the feature doc for the send/no-send semantics.

**Responses:** **200** `{ review }`; **404 `{ "error": "Review not found" }`** when the service returns null; **400 `{ "error": <message> }`** for any thrown service error (the catch maps all exceptions to 400, [:129-132](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)); plus the shared 401 / Invalid JSON / Invalid request envelopes.

### `POST /api/line/scheduler-reviews/[reviewId]/operational-plan`

Rebuild the deterministic operational plan (intent, draft, candidate sessions, proposed Wise actions) for a pending review ([`operational-plan/route.ts:13-52`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)).

**Body:** none. **Path param:** `reviewId`.

**Preconditions / side effects:**
- Loads the review; **404 `{ "error": "Review not found" }`** if missing ([:21-24](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)).
- **400 `{ "error": "Only pending reviews can be rebuilt" }`** unless `review.status === "pending_review"` ([:25-27](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)).
- Loads the inbound LINE message; **404 `{ "error": "Inbound LINE message not found" }`** if missing ([:29-32](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)).
- Runs `buildLineOperationalReviewPlan` then persists the new intent/draft/sessions/actions via `patchLineSchedulerOperationalPlan` ([:34-49](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)).

**Response:** **200** `{ review }` (the updated review).

---

## Wise actions

Append-only audit + confirmation of operational actions against Wise sessions, scoped to one review. **Requires an admin session.** Note: confirmation is **dry-run only** in this build (see side effects).

### `GET /api/line/scheduler-reviews/[reviewId]/wise-actions`

List the Wise-action log entries for a review ([`wise-actions/route.ts:22-31`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts)).

**Response:** **200** `{ logs }` from `listLineWiseActionLogs(db, reviewId)`.

### `POST /api/line/scheduler-reviews/[reviewId]/wise-actions`

Confirm a proposed Wise action ([`wise-actions/route.ts:33-68`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts)).

**Body** (`.strict()`, [:8-11](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts)):
- `actionId` (string, 1–160) — required.
- `selectedSessionIds` (array of strings 1–240, ≤80) — optional; defaults to the action's own session ids when omitted.

**Side effects** — delegates to `confirmLineWiseAction` ([`operations.ts:26-95`](../../../src/lib/wise/operations.ts)). This **never mutates Wise**: when the cancel/reschedule endpoint contract is unverified it records a log with `status: "manual_required", dryRun: true` and sets the review's `writebackStatus` to `manual_required` ([`operations.ts:49-68`](../../../src/lib/wise/operations.ts)); otherwise it records a `status: "dry_run"` log ("Dry run recorded; no Wise mutation was sent.") and sets `writebackStatus: "dry_run"` ([`operations.ts:71-94`](../../../src/lib/wise/operations.ts)). Either way `adminSelectedSessionIds` is persisted.

**Responses:** **200** `{ log, endpointVerified }` (a `LineWiseActionLogDto` plus a boolean); **400 `{ "error": <message> }`** for thrown errors — e.g. "LINE review not found", "Only pending reviews can confirm Wise actions", "Wise action not found", "Select at least one Wise session before confirming" ([`operations.ts:34-47`](../../../src/lib/wise/operations.ts)) — the route catch maps all exceptions to 400 ([:64-67](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts)); plus shared 401 / Invalid JSON / Invalid request.

---

## Messages

Per-inbound-message operations. **Requires an admin session.**

### `POST /api/line/messages/[messageId]/promote`

Promote a raw LINE message into a scheduler review (manual escalation of a message the classifier did not auto-queue) ([`promote/route.ts:15-32`](../../../src/app/api/line/messages/[messageId]/promote/route.ts)).

**Body:** none. **Side effect:** `promoteLineMessageToReview` creates (or returns the existing) review, attributing the session actor.

**Responses:** **200** `{ review, alreadyExisted }` — `alreadyExisted: true` when a review already existed for the message; **404 `{ "error": "LINE message not found" }`** when the message id is unknown ([:27-29](../../../src/app/api/line/messages/[messageId]/promote/route.ts)).

### `PATCH /api/line/messages/[messageId]/classification-feedback`

Record a human correction of the classifier verdict (accuracy-tracking signal) ([`classification-feedback/route.ts:20-52`](../../../src/app/api/line/messages/[messageId]/classification-feedback/route.ts)).

**Body** (`.strict()`, [:7-9](../../../src/app/api/line/messages/[messageId]/classification-feedback/route.ts)): `reviewedCategory` — enum `scheduling_request | scheduling_change | non_scheduling | unclear` (required).

**Side effect:** `updateLineMessageClassificationFeedback` writes the reviewed category + actor to the message.

**Responses:** **200** `{ feedback }`; **404 `{ "error": "LINE message not found" }`** ([:47-49](../../../src/app/api/line/messages/[messageId]/classification-feedback/route.ts)); plus shared 401 / Invalid JSON / Invalid request.

---

## Students

### `GET /api/line/students`

Typeahead search of current credit-control students (for linking a contact to a student). **Requires an admin session** ([`students/route.ts:6-19`](../../../src/app/api/line/students/route.ts)).

**Query param:** `q` — the search string. If the trimmed query is **shorter than 2 characters**, the handler short-circuits to **200 `{ students: [] }`** without querying ([:12-15](../../../src/app/api/line/students/route.ts)).

**Response:** **200** `{ students }` from `searchCurrentLineStudents(db, query)`.

---

## Contacts — link validation

Connect a LINE contact to a real Wise student, with a human round-robin validation tracker. **Requires an admin session.** Note the **validation-lead sub-gate**: the *summary* endpoint returns an empty result to admins who are not validation leads (it does not 403) — see below.

### `GET /api/line/contacts/link-validation`

List validation tasks for a scope ([`link-validation/route.ts:20-44`](../../../src/app/api/line/contacts/link-validation/route.ts)).

**Query params:**
- `scope` (default `"my"`) — enum `my | all | unassigned | verified | rejected` ([:10](../../../src/app/api/line/contacts/link-validation/route.ts)); invalid → **400 `{ "error": "Invalid scope" }`**.
- `runId` (optional) — must be a UUID ([:11](../../../src/app/api/line/contacts/link-validation/route.ts)); invalid → **400 `{ "error": "Invalid runId" }`**.
- `page` (default `1`) — positive integer; invalid → **400 `{ "error": "Invalid page" }`**.
- `pageSize` (default `100`, max `100`) — positive integer; invalid → **400 `{ "error": "Invalid pageSize" }`**.

Scope semantics are applied in `listLineLinkValidationTasks` ([`link-validation.ts:320-345`](../../../src/lib/line/link-validation.ts)): `my` filters to suggested links assigned to the caller's email; `unassigned` to suggested+unassigned; `verified`/`rejected` by status.

**Response:** **200** `{ tasks, reviewers, pagination }`, where `pagination` includes `page`, `pageSize`, `total`, and `pageCount`.

### `GET /api/line/contacts/link-validation/summary`

Validation-lead dashboard counts ([`link-validation/summary/route.ts:16-33`](../../../src/app/api/line/contacts/link-validation/summary/route.ts)).

**Query param:** `runId` (optional UUID); invalid → **400 `{ "error": "Invalid runId" }`**.

**Auth nuance:** `getLineLinkValidationSummary` returns an **empty summary** (not an error) when the caller's email is not in the validation-lead allowlist `isLineValidationLeadEmail` ([`link-validation.ts:384-387`](../../../src/lib/line/link-validation.ts); lead list resolved from `LINE_VALIDATION_LEAD_EMAILS` or a built-in default, [:155-167](../../../src/lib/line/link-validation.ts)).

**Response:** **200** `{ summary }`.

### `POST /api/line/contacts/link-validation/assign`

Assign suggested links to one or more reviewers (round-robin distribution) ([`link-validation/assign/route.ts:16-46`](../../../src/app/api/line/contacts/link-validation/assign/route.ts)).

**Body** (`.strict()`, [:10-14](../../../src/app/api/line/contacts/link-validation/assign/route.ts)):
- `runId` (UUID) — required.
- `reviewerEmails` (array of emails, 1–50) — required.
- `linkIds` (array of UUIDs, 1–500) — optional; omit to assign the whole run.

**Side effect:** `assignLineLinkValidationTasks` writes assignments. **Errors:** a thrown `LineLinkValidationError` is surfaced with its own `error.status` and message ([:40-44](../../../src/app/api/line/contacts/link-validation/assign/route.ts)); other errors propagate (framework 500). Plus shared 401 / Invalid JSON / Invalid request.

**Response:** **200** with the assignment result object from the service.

### `PATCH /api/line/contacts/link-validation/[linkId]`

Verify or reject a single link from the validation queue ([`link-validation/[linkId]/route.ts:21-54`](../../../src/app/api/line/contacts/link-validation/[linkId]/route.ts)).

**Body** (`.strict()`, [:7-10](../../../src/app/api/line/contacts/link-validation/[linkId]/route.ts)):
- `status` — enum `verified | rejected` (required).
- `note` — string ≤1000, nullable, optional.

**Side effect:** `patchLineLinkValidationTaskStatus` updates the link status + note + actor.

**Responses:** **200** `{ task }`; **404 `{ "error": "Student link not found" }`** ([:49-51](../../../src/app/api/line/contacts/link-validation/[linkId]/route.ts)); plus shared 401 / Invalid JSON / Invalid request.

---

## Contacts — contact + student-link management

Per-contact label edits and the contact↔student link lifecycle. **Requires an admin session.**

### `PATCH /api/line/contacts/[contactId]`

Edit the staff-applied parent/student labels on a contact ([`[contactId]/route.ts:15-42`](../../../src/app/api/line/contacts/[contactId]/route.ts)).

**Body** (`.strict()`, [:8-11](../../../src/app/api/line/contacts/[contactId]/route.ts)):
- `linkedParentLabel` — string ≤200, nullable, optional.
- `linkedStudentLabel` — string ≤500, nullable, optional.

**Side effects:** `updateLineContactLabels` writes the labels, then `ensureLineContactStudentLinkSuggestions` (re)generates link suggestions from the new student label ([:38-39](../../../src/app/api/line/contacts/[contactId]/route.ts)).

**Response:** **200** `{ links }` — the contact's current student links after the update.

### `GET /api/line/contacts/[contactId]/student-links`

List a contact's student links, ensuring suggestions exist ([`[contactId]/student-links/route.ts:30-40`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)).

**Side effect:** `ensureLineContactStudentLinkSuggestions` may create suggested links before returning. **Response:** **200** `{ links }`.

### `POST /api/line/contacts/[contactId]/student-links`

Create a verified link from this contact to a specific current student ([`[contactId]/student-links/route.ts:42-76`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)).

**Body** (`.strict()`, [:12-14](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)): `studentKey` (string 1–240, required).

**Side effect:** `createVerifiedLineContactStudentLink` creates the verified link (actor-attributed).

**Responses:** **201** `{ link, links }`; **404 `{ "error": "Current credit-control student not found" }`** when the `studentKey` does not match a current student ([:70-72](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)); plus shared 401 / Invalid JSON / Invalid request.

### `PATCH /api/line/contacts/[contactId]/student-links`

Verify or reject an existing link by id ([`[contactId]/student-links/route.ts:78-113`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)).

**Body** (`.strict()`, [:16-19](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)):
- `action` — enum `verify | reject` (required; mapped to status `verified`/`rejected`, [:103](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)).
- `linkId` — UUID (required).

**Responses:** **200** `{ link, links }`; **404 `{ "error": "Student link not found" }`** ([:107-109](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)); plus shared 401 / Invalid JSON / Invalid request.

### `POST /api/line/contacts/refresh-profiles`

Refresh cached LINE profiles (display name / picture / status) for all contacts from the LINE API ([`refresh-profiles/route.ts:6-14`](../../../src/app/api/line/contacts/refresh-profiles/route.ts)).

**Body:** none. **Side effect:** `refreshAllLineContactProfiles({ db })` fetches and updates every contact's profile. **Response:** **200** `{ result }`.

---

## Contacts — alias import

Bulk-import contact aliases from pasted chat-list text or a screenshot (OCR/vision). **Requires an admin session.**

### `POST /api/line/contacts/alias-import/preview`

Parse pasted text and/or an uploaded image into proposed alias rows, without committing ([`alias-import/preview/route.ts:30-70`](../../../src/app/api/line/contacts/alias-import/preview/route.ts)).

**Request: `multipart/form-data`** (not JSON) — parsed via `request.formData()`; non-multipart bodies → **400 `{ "error": "Expected multipart form data" }`** ([:36-41](../../../src/app/api/line/contacts/alias-import/preview/route.ts)). Form fields:
- `image` (optional File) — must be `image/png`, `image/jpeg`, or `image/webp` and **≤5 MB**; violations → **400** with "Image must be PNG, JPEG, or WebP" / "Image must be 5MB or smaller" ([:7-8, :18-23, :43-51](../../../src/app/api/line/contacts/alias-import/preview/route.ts)).
- `text` (optional string) — pasted chat-list text.
- `preferredContactId` (optional string) — bias matching toward a specific contact.
- At least one of `image` / `text` is required, else **400 `{ "error": "Paste chat-list text or upload a screenshot" }`** ([:53-56](../../../src/app/api/line/contacts/alias-import/preview/route.ts)).

**Side effects:** none persisted — `previewLineAliasImport` only computes a proposal.

**Responses:** **200** `{ preview }`; on a thrown service error, **503** when the message contains `"configured"` (i.e. the vision/OCR provider is not configured), otherwise **500** ([:66-69](../../../src/app/api/line/contacts/alias-import/preview/route.ts)).

### `POST /api/line/contacts/alias-import/commit`

Persist the reviewed alias rows ([`alias-import/commit/route.ts:14-40`](../../../src/app/api/line/contacts/alias-import/commit/route.ts)).

**Body** (JSON, `.strict()`, [:7-12](../../../src/app/api/line/contacts/alias-import/commit/route.ts)): `rows` — array (1–100) of `{ contactId: UUID, aliasLabel: string 1–500 }`.

**Side effect:** `commitLineAliasImport` writes the aliases. **Response:** **200** `{ result }`; plus shared 401 / Invalid JSON / Invalid request.

---

## Contacts — OA resolver

A browser-extension-driven bulk resolver that maps LINE chats to students. Two endpoints are **token-authenticated** (the extension); the rest require an **admin session**. The token endpoints also export `OPTIONS` and set permissive CORS headers (`Access-Control-Allow-Origin: *`) for cross-origin extension calls.

### `GET /api/line/contacts/oa-resolver/worklist`

The extension's worklist for its run. **Auth: per-run bearer token** (no session) ([`oa-resolver/worklist/route.ts:21-34`](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts)).

**Request:** `Authorization: Bearer <token>`. `OPTIONS` returns **204** with CORS headers ([:17-19](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts)).

**Responses:** **200** `{ worklist }` (CORS headers attached); **401 `{ "error": "Invalid or expired resolver token" }`** when the token is missing or does not resolve ([:26-31](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts)).

### `POST /api/line/contacts/oa-resolver/runs/[runId]/rows`

The extension posts back resolved/ambiguous rows for a run. **Auth: per-run bearer token** (no session) ([`rows/route.ts:52-90`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)).

**Request:** `Authorization: Bearer <token>` (missing → **401 `{ "error": "Missing resolver token" }`**, [:54-59](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)). `OPTIONS` returns **204** + CORS headers ([:48-50](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)).

**Body** (`.strict()`, [:24-38](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)): `rows` — array (1–50) of row objects, each:
- `rowId` (UUID), `status` (enum `matched | ambiguous | no_match | error`) — required.
- `lineChatUrl`, `chatTitle`, `matchMode`, `captureMode`, `errorMessage` — nullable optional strings (bounded length).
- `candidates` — array (≤25) of candidate objects (`lineChatUrl`, optional `chatTitle`, `adminNoteRaw`, `relationshipRole` enum `mom|dad|secretary|other|unknown`, `candidateRank` int 1–100, `captureMode`, `matchMode`, `searchCode`, `siblingFanout`) ([:12-22](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)).
- `evidence` — free-form record, optional.

**Side effect:** `updateLineOaResolverRowsFromExtension` validates the token against the run and writes the rows.

**Responses:** **200** `{ run }` (CORS headers); **400 `{ "error": "Invalid JSON" }`** or **400 Invalid request** with CORS headers; **401 `{ "error": "Invalid or expired resolver token" }`** when the token/run does not resolve ([:82-87](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)).

### `GET /api/line/contacts/oa-resolver/runs`

List resolver runs, or fetch the latest run for the caller. **Requires an admin session** ([`oa-resolver/runs/route.ts:17-33`](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts)).

**Query params:**
- `latest=true` → returns `{ run }` from `getLatestLineOaResolverRun(db, actor)` (the caller's latest run) ([:31-32](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts)).
- Otherwise → returns `{ runs }` from `listLineOaResolverRuns(db, limit)`; `limit` query param parsed as a number, defaulting to **20** when absent or non-finite ([:25-28](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts)).

**Response:** **200** — either `{ run }` or `{ runs }` per the above.

### `POST /api/line/contacts/oa-resolver/runs`

Create a new resolver run (mints the per-run token the extension will use). **Requires an admin session** ([`oa-resolver/runs/route.ts:35-43`](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts)).

**Body:** none. **Side effect:** `createLineOaResolverRun(db, actor)` creates the run. **Response:** **201** with the run-creation result object.

### `GET /api/line/contacts/oa-resolver/runs/[runId]`

Fetch a single resolver run by id. **Requires an admin session** ([`oa-resolver/runs/[runId]/route.ts:8-21`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/route.ts)).

**Response:** **200** `{ run }`; **404 `{ "error": "Resolver run not found" }`** when unknown ([:16-18](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/route.ts)).

### `POST /api/line/contacts/oa-resolver/runs/[runId]/commit`

Commit resolved rows from a run into verified contact↔student links. **Requires an admin session** ([`oa-resolver/runs/[runId]/commit/route.ts:17-49`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts)).

**Body** (`.strict()`, [:7-13](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts)) — both optional; **a missing or invalid-JSON body is tolerated and treated as `{}`** ([:23-28](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts)):
- `rowIds` — array of UUIDs (1–1000).
- `selectedCandidates` — array (≤5000) of `{ rowId: UUID, lineUserId: string matching /^U[a-fA-F0-9]{32}$/ }` (the LINE user-id format).

**Side effect:** `commitLineOaResolverRun` materializes the selected resolutions.

**Responses:** **200** `{ result }`; **404 `{ "error": "Resolver run not found" }`** ([:44-46](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts)); **400 Invalid request** on Zod failure (note: unlike most routes, malformed JSON does *not* 400 here — it falls back to an empty body).

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
