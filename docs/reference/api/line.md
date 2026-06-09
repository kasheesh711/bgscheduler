# LINE API

**Status:** Stable (the LINE feature's Wise write-path is dry-run / flag-gated, but these HTTP contracts are stable). **Canonical home:** this page owns the mechanical request/response contracts for the 27 LINE route handlers. Feature meaning — what the LINE OA inbox, scheduler-review queue, contact-alias tooling, link validation, and OA-resolver are *for*, and why every Wise mutation is flag-gated and dry-run — lives in [`features/line-integration.md`](../../features/line-integration.md). This page does not restate that intent.

All 27 handlers are Next.js App Router route handlers under `src/app/api/line/**/route.ts`. Most run the standard 4-step mutating-route discipline (`auth()` → 401; `request.json()` in try/catch → 400 `Invalid JSON`; `schema.safeParse()` → 400 `Invalid request` + `details: error.flatten()`; business logic). Read endpoints validate query params with `safeParse` and return their typed payload. The three exceptions to the session model (the public webhook and the two OA-resolver extension endpoints) are flagged inline.

## Authentication model

Three gates apply, set by [`middleware.ts:4-15`](../../../src/middleware.ts):

- **Auth.js session (the default, 24 of 27 endpoints).** Everything under `/api/line/` is *not* a public prefix, so the middleware redirects unauthenticated browser requests to `/login`; for an XHR it lets the request through to the handler, which calls `await auth()` and returns **HTTP 401 `{ "error": "Unauthorized" }`** when there is no session. Page-level access control also applies: a restricted user whose `allowedPages` does not include `/line-review` (or the matching API namespace) is rejected with **HTTP 403 `{ "error": "Forbidden" }`** *at the middleware*, before the handler's own 401 check ([`middleware.ts:51-62`](../../../src/middleware.ts)).
- **Public + custom bearer token (2 endpoints).** `GET /api/line/contacts/oa-resolver/worklist` and `POST /api/line/contacts/oa-resolver/runs/[runId]/rows` are listed as public routes in the middleware ([`middleware.ts:11-12`](../../../src/middleware.ts) — the `rows` path via the regex `^\/api\/line\/contacts\/oa-resolver\/runs\/[^/]+\/rows$`). They carry **no** Auth.js session; instead each reads an `Authorization: Bearer <token>` header and resolves it against an OA-resolver run token in the data layer (**401** on a missing/invalid/expired token). Both also serve permissive CORS (`Access-Control-Allow-Origin: *`) and an `OPTIONS` preflight returning `204`. These are the LINE browser-extension ingress.
- **Public, no token (1 endpoint).** `POST /api/line/webhook` is public ([`middleware.ts:10`](../../../src/middleware.ts)); it authenticates by **LINE signature HMAC** (`x-line-signature`) inside `handleLineWebhookPost`, not by session.

> **Feature flag.** The webhook short-circuits with **HTTP 503 `{ "ok": false, "error": "LINE scheduler is not configured" }`** unless `lineSchedulerEnabled()` is true, i.e. `ENABLE_LINE_SCHEDULER !== "false"` **and** both `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` are set ([`webhook/route.ts:10-12`](../../../src/app/api/line/webhook/route.ts); [`client.ts:19-22`](../../../src/lib/line/client.ts)). The session endpoints are *not* flag-gated.

## Endpoint index

| # | Method + path | Auth | Handler |
|---|---------------|------|---------|
| 1 | `POST /api/line/webhook` | LINE signature (public) | [`webhook/route.ts:9`](../../../src/app/api/line/webhook/route.ts) |
| 2 | `GET /api/line/scheduler-reviews` | Auth.js session | [`scheduler-reviews/route.ts:24`](../../../src/app/api/line/scheduler-reviews/route.ts) |
| 3 | `GET /api/line/scheduler-reviews/false-negatives` | Auth.js session | [`false-negatives/route.ts:9`](../../../src/app/api/line/scheduler-reviews/false-negatives/route.ts) |
| 4 | `PATCH /api/line/scheduler-reviews/[reviewId]` | Auth.js session | [`[reviewId]/route.ts:60`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts) |
| 5 | `GET /api/line/scheduler-reviews/[reviewId]/wise-actions` | Auth.js session | [`wise-actions/route.ts:22`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts) |
| 6 | `POST /api/line/scheduler-reviews/[reviewId]/wise-actions` | Auth.js session | [`wise-actions/route.ts:33`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts) |
| 7 | `POST /api/line/scheduler-reviews/[reviewId]/operational-plan` | Auth.js session | [`operational-plan/route.ts:13`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts) |
| 8 | `GET /api/line/scheduler-reviews/[reviewId]/context` | Auth.js session | [`context/route.ts:8`](../../../src/app/api/line/scheduler-reviews/[reviewId]/context/route.ts) |
| 9 | `GET /api/line/students` | Auth.js session | [`students/route.ts:6`](../../../src/app/api/line/students/route.ts) |
| 10 | `PATCH /api/line/messages/[messageId]/classification-feedback` | Auth.js session | [`classification-feedback/route.ts:20`](../../../src/app/api/line/messages/[messageId]/classification-feedback/route.ts) |
| 11 | `POST /api/line/messages/[messageId]/promote` | Auth.js session | [`promote/route.ts:15`](../../../src/app/api/line/messages/[messageId]/promote/route.ts) |
| 12 | `PATCH /api/line/contacts/[contactId]` | Auth.js session | [`contacts/[contactId]/route.ts:15`](../../../src/app/api/line/contacts/[contactId]/route.ts) |
| 13 | `GET /api/line/contacts/[contactId]/student-links` | Auth.js session | [`student-links/route.ts:30`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts) |
| 14 | `POST /api/line/contacts/[contactId]/student-links` | Auth.js session | [`student-links/route.ts:42`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts) |
| 15 | `PATCH /api/line/contacts/[contactId]/student-links` | Auth.js session | [`student-links/route.ts:78`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts) |
| 16 | `POST /api/line/contacts/refresh-profiles` | Auth.js session | [`refresh-profiles/route.ts:6`](../../../src/app/api/line/contacts/refresh-profiles/route.ts) |
| 17 | `POST /api/line/contacts/alias-import/preview` | Auth.js session | [`alias-import/preview/route.ts:30`](../../../src/app/api/line/contacts/alias-import/preview/route.ts) |
| 18 | `POST /api/line/contacts/alias-import/commit` | Auth.js session | [`alias-import/commit/route.ts:14`](../../../src/app/api/line/contacts/alias-import/commit/route.ts) |
| 19 | `GET /api/line/contacts/link-validation` | Auth.js session | [`link-validation/route.ts:22`](../../../src/app/api/line/contacts/link-validation/route.ts) |
| 20 | `GET /api/line/contacts/link-validation/summary` | Auth.js session | [`link-validation/summary/route.ts:16`](../../../src/app/api/line/contacts/link-validation/summary/route.ts) |
| 21 | `POST /api/line/contacts/link-validation/assign` | Auth.js session | [`link-validation/assign/route.ts:16`](../../../src/app/api/line/contacts/link-validation/assign/route.ts) |
| 22 | `PATCH /api/line/contacts/link-validation/[linkId]` | Auth.js session | [`link-validation/[linkId]/route.ts:21`](../../../src/app/api/line/contacts/link-validation/[linkId]/route.ts) |
| 23 | `GET /api/line/contacts/oa-resolver/worklist` | Bearer token (public) | [`oa-resolver/worklist/route.ts:21`](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts) |
| 24 | `GET /api/line/contacts/oa-resolver/runs` | Auth.js session | [`oa-resolver/runs/route.ts:17`](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts) |
| 25 | `POST /api/line/contacts/oa-resolver/runs` | Auth.js session | [`oa-resolver/runs/route.ts:35`](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts) |
| 26 | `GET /api/line/contacts/oa-resolver/runs/[runId]` | Auth.js session | [`runs/[runId]/route.ts:8`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/route.ts) |
| 27 | `POST /api/line/contacts/oa-resolver/runs/[runId]/rows` | Bearer token (public) | [`runs/[runId]/rows/route.ts:52`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts) |
| 28 | `POST /api/line/contacts/oa-resolver/runs/[runId]/commit` | Auth.js session | [`runs/[runId]/commit/route.ts:17`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts) |

> The table lists 28 method+path rows across 24 route files because two files export two methods on the same path (`scheduler-reviews/[reviewId]/wise-actions` = GET+POST; `oa-resolver/runs` = GET+POST), and `contacts/[contactId]/student-links` exports three (GET+POST+PATCH, each a distinct row). The task's authoritative inventory of "27 endpoints" and these 28 method+path rows describe the same set of handlers — the difference is only in how the GET+POST `oa-resolver/runs` pair is bucketed.

---

## Webhook ingress

### 1. LINE webhook — `POST /api/line/webhook`

**Auth:** public route; authenticated by LINE signature HMAC, not by session. **Flag:** requires `lineSchedulerEnabled()`. **Does:** ingest a LINE Messaging-API webhook batch and schedule per-message scheduler processing.

**Request:** raw JSON body read via `request.text()` (a LINE webhook envelope). Header `x-line-signature` carries the HMAC. No Zod schema at the route — the body is `JSON.parse`d inside `handleLineWebhookPost` after the signature check ([`webhook/route.ts:15-30`](../../../src/app/api/line/webhook/route.ts)).

**Response (HTTP 200):** `{ ok: true, createdMessageIds: string[], duplicateEvents: number, ignoredEvents: number, retractedMessages: number }` from `recordLineWebhookPayload` ([`webhook.ts:50-59`](../../../src/lib/line/webhook.ts)).

**Side effects:** persists inbound LINE events/messages (`recordLineWebhookPayload`), then for each newly created message id calls `scheduleProcessing`, which uses Next's `after()` to run `processLineMessageForScheduler` **after the response is sent** (out of band; errors are caught and `console.error`'d, never surfaced to the caller) ([`webhook/route.ts:21-29`](../../../src/app/api/line/webhook/route.ts)). `maxDuration = 60` ([`webhook/route.ts:7`](../../../src/app/api/line/webhook/route.ts)).

**Errors:** **503** `{ ok:false, error:"LINE scheduler is not configured" }` when the flag is off; **401** `{ ok:false, error:"Invalid LINE signature" }` ([`webhook.ts:29-32`](../../../src/lib/line/webhook.ts)); **400** `{ ok:false, error:"Invalid JSON" }` ([`webhook.ts:39-42`](../../../src/lib/line/webhook.ts)). Note these bodies use `ok` (not `error`-only) unlike the session endpoints.

---

## Scheduler reviews

These power the `/line-review` (and `/scheduler`) triage queue. A *scheduler review* is the human-in-the-loop record for one inbound LINE message that the classifier flagged as a scheduling request/change.

### 2. List scheduler reviews — `GET /api/line/scheduler-reviews`

**Auth:** Auth.js session. **Does:** list scheduler reviews, optionally with aggregate analytics.

**Request — query params** (no Zod object schema; validated field-by-field):
| Param | Validation | Effect |
|-------|-----------|--------|
| `status` | `z.enum(["pending_review","approved_sent","accepted_no_send","rejected","dismissed"])` ([`route.ts:7-13`](../../../src/app/api/line/scheduler-reviews/route.ts)) | filter by review status; invalid → **400 `Invalid status`** |
| `intentType` | `z.enum(["new_request","cancel_one_off","pause_until","resume","reschedule","unclear_change"])` ([`route.ts:15-22`](../../../src/app/api/line/scheduler-reviews/route.ts)) | filter by intent; invalid → **400 `Invalid intentType`** |
| `conversationId` | free string | filter to one conversation |
| `analytics` | `"true"` toggles analytics | include the analytics block |

**Response (HTTP 200):** `{ reviews, analytics }` where `reviews` comes from `listLineSchedulerReviews` ([`data.ts:755`](../../../src/lib/line/data.ts)) and `analytics` is `getLineSchedulerAnalytics(db)` ([`data.ts:1128`](../../../src/lib/line/data.ts)) when `analytics=true`, else `null` ([`route.ts:44-53`](../../../src/app/api/line/scheduler-reviews/route.ts)).

**Side effects:** none (reads only). **Errors:** 401; 400 (`Invalid status` / `Invalid intentType`).

### 3. List false-negative candidates — `GET /api/line/scheduler-reviews/false-negatives`

**Auth:** Auth.js session. **Does:** surface inbound messages the classifier *did not* route to review but whose confidence sits below a threshold — candidate missed scheduling requests.

**Request — query param:** `threshold` (optional), validated by `z.coerce.number().min(0).max(1)` ([`false-negatives/route.ts:7`](../../../src/app/api/line/scheduler-reviews/false-negatives/route.ts)); out of range → **400 `Invalid threshold`**. Omitted → handler passes `undefined` (data-layer default).

**Response (HTTP 200):** `{ candidates }` from `listLineFalseNegativeCandidates(db, { threshold })` ([`data.ts:525`](../../../src/lib/line/data.ts)). **Side effects:** none. **Errors:** 401; 400 `Invalid threshold`.

### 4. Resolve a scheduler review — `PATCH /api/line/scheduler-reviews/[reviewId]`

**Auth:** Auth.js session. **Does:** apply a terminal review decision. This is the main human action on the queue.

**Request — body:** a **discriminated union on `action`** (`patchReviewSchema`, [`[reviewId]/route.ts:12-44`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)), all variants `.strict()`:
| `action` | Required fields | Optional fields |
|----------|-----------------|-----------------|
| `approve_send` | `finalText` (trim, 1–5000) | `selectedTutorIds` (string[], ≤12), `studentLinkOverride` (bool) |
| `accept_no_send` | — | `finalText` (≤5000), `selectedTutorIds` (≤12), `studentLinkOverride` |
| `reject` | `reasonCategory` (enum: `wrong_student_link` / `wrong_extracted_request` / `wrong_tutor_fit` / `wrong_availability` / `unsafe_draft` / `unclear` / `other`), `rejectionReason` (1–500), `staffCorrection` (1–5000) | `rejectedTutorIds` (≤12) |
| `dismiss` | — | `rejectionReason` (≤500) |

The actor (`{ email, name }`) is derived from the session ([`[reviewId]/route.ts:48-53`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)).

**Response (HTTP 200):** `{ review }` — the updated review row. The handler dispatches to one of `approveLineSchedulerReview` / `acceptLineSchedulerReviewNoSend` / `rejectLineSchedulerReview` / `dismissLineSchedulerReview` in `review-service` ([`[reviewId]/route.ts:88-122`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)).

**Side effects:** mutates review status/decision; `approve_send` is the path that (when the Wise/reply write-path is enabled) would dispatch the parent reply — see the feature doc for the flag-gated, dry-run policy. **Errors:** 401; 400 `Invalid JSON`; 400 `Invalid request` (+`details`); **404 `Review not found`** when the service returns no review; **400** with the thrown error message if the service throws ([`[reviewId]/route.ts:124-132`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)).

### 5. List Wise-action logs for a review — `GET /api/line/scheduler-reviews/[reviewId]/wise-actions`

**Auth:** Auth.js session. **Does:** return the audit log of Wise actions attached to a review (newest first). **Request:** path param `reviewId`; no body/query. **Response (HTTP 200):** `{ logs }` from `listLineWiseActionLogs(db, reviewId)` ([`data.ts:985-994`](../../../src/lib/line/data.ts)). **Side effects:** none. **Errors:** 401.

### 6. Confirm a Wise action for a review — `POST /api/line/scheduler-reviews/[reviewId]/wise-actions`

**Auth:** Auth.js session. **Does:** confirm (execute, subject to dry-run / flag gating in the lib) one proposed Wise action for the review.

**Request — body** (`postSchema`, `.strict()`, [`wise-actions/route.ts:8-11`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts)): `{ actionId: string (1–160), selectedSessionIds?: string[] (each 1–240, ≤80) }`. Path param `reviewId`.

**Response (HTTP 200):** the object returned by `confirmLineWiseAction({ db, reviewId, actionId, selectedSessionIds, actor })` ([`operations.ts:26`](../../../src/lib/wise/operations.ts)), returned verbatim. **Side effects:** writes a Wise-action log entry and performs the (dry-run / flag-gated) Wise mutation defined by that action. **Errors:** 401; 400 `Invalid JSON`; 400 `Invalid request` (+`details`); **400** with the thrown error message on failure ([`wise-actions/route.ts:64-67`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts)).

### 7. Rebuild a review's operational plan — `POST /api/line/scheduler-reviews/[reviewId]/operational-plan`

**Auth:** Auth.js session. **Does:** recompute the operational plan (intent, candidate sessions, proposed draft and Wise actions) for a still-pending review by re-running `buildLineOperationalReviewPlan` against the original inbound message.

**Request:** path param `reviewId`; no body. **Response (HTTP 200):** `{ review }` — the review patched with the freshly built plan via `patchLineSchedulerOperationalPlan` ([`operational-plan/route.ts:40-51`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)).

**Side effects:** overwrites the review's plan fields (`intentType`, `intentPayload`, `proposedDraft`, `matchedStudentKeys`, `candidateSessions`, `proposedWiseActions`, `adminSelectedSessionIds`, `writebackStatus`). The proposed draft falls back to the existing one when the rebuild yields empty ([`operational-plan/route.ts:43`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)). **Errors:** 401; **404 `Review not found`**; **400 `Only pending reviews can be rebuilt`** when `status !== "pending_review"` ([`operational-plan/route.ts:25-27`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)); **404 `Inbound LINE message not found`** if the source message is gone ([`operational-plan/route.ts:29-32`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)).

### 8. Review chat context — `GET /api/line/scheduler-reviews/[reviewId]/context`

**Auth:** Auth.js session. **Does:** return the surrounding LINE chat thread for a review (recent messages + metadata) for the reviewer UI. **Request:** path param `reviewId`. **Response (HTTP 200):** `{ context }` from `getLineReviewChatContext(db, reviewId)` (defaults to the most recent 30 LINE messages, [`data.ts:997-1002`](../../../src/lib/line/data.ts)). **Side effects:** none. **Errors:** 401; **404 `Review not found`** when the context is null ([`context/route.ts:16-18`](../../../src/app/api/line/scheduler-reviews/[reviewId]/context/route.ts)).

---

## Students lookup

### 9. Search current LINE students — `GET /api/line/students`

**Auth:** Auth.js session. **Does:** typeahead over current credit-control students, for manually linking a LINE contact to a student. **Request — query param:** `q` (trimmed). A query shorter than 2 chars short-circuits to `{ students: [] }` (no DB hit) ([`students/route.ts:12-15`](../../../src/app/api/line/students/route.ts)). **Response (HTTP 200):** `{ students }` from `searchCurrentLineStudents(db, query)`. **Side effects:** none. **Errors:** 401.

---

## Messages

Operations on an individual ingested LINE message (`messageId` path param).

### 10. Classification feedback — `PATCH /api/line/messages/[messageId]/classification-feedback`

**Auth:** Auth.js session. **Does:** record a human correction to the classifier's category for one message (training / telemetry signal).

**Request — body** (`feedbackSchema`, `.strict()`, [`classification-feedback/route.ts:7-9`](../../../src/app/api/line/messages/[messageId]/classification-feedback/route.ts)): `{ reviewedCategory: z.enum(["scheduling_request","scheduling_change","non_scheduling","unclear"]) }`. Actor from session.

**Response (HTTP 200):** `{ feedback }` from `updateLineMessageClassificationFeedback({ messageId, reviewedCategory, actor })`. **Side effects:** writes the reviewed category + reviewer onto the message. **Errors:** 401; 400 `Invalid JSON`; 400 `Invalid request` (+`details`); **404 `LINE message not found`** ([`classification-feedback/route.ts:47-49`](../../../src/app/api/line/messages/[messageId]/classification-feedback/route.ts)).

### 11. Promote a message to review — `POST /api/line/messages/[messageId]/promote`

**Auth:** Auth.js session. **Does:** manually create a scheduler review from a message the classifier did not auto-promote (the human-rescue path for false negatives). **Request:** path param `messageId`; no body. Actor from session.

**Response (HTTP 200):** `{ review, alreadyExisted }` from `promoteLineMessageToReview({ db, lineMessageId, actor })` — `alreadyExisted` flags an idempotent re-promote ([`promote/route.ts:22-31`](../../../src/app/api/line/messages/[messageId]/promote/route.ts)). **Side effects:** creates (or returns the existing) review row. **Errors:** 401; **404 `LINE message not found`** when no review is produced ([`promote/route.ts:27-29`](../../../src/app/api/line/messages/[messageId]/promote/route.ts)).

---

## Contacts

A LINE *contact* is a resolved sender (parent / secretary). These endpoints manage its labels, its links to credit-control students, and bulk alias/profile tooling.

### 12. Update contact labels — `PATCH /api/line/contacts/[contactId]`

**Auth:** Auth.js session. **Does:** set the human-friendly parent/student labels on a contact and (re)seed student-link suggestions from the student label.

**Request — body** (`patchContactSchema`, `.strict()`, [`contacts/[contactId]/route.ts:8-11`](../../../src/app/api/line/contacts/[contactId]/route.ts)): `{ linkedParentLabel?: string|null (≤200), linkedStudentLabel?: string|null (≤500) }` — both nullable + optional.

**Response (HTTP 200):** `{ links }` — the contact's student links after re-suggestion ([`contacts/[contactId]/route.ts:38-41`](../../../src/app/api/line/contacts/[contactId]/route.ts)). **Side effects:** `updateLineContactLabels` writes the labels; `ensureLineContactStudentLinkSuggestions` regenerates suggested links from `linkedStudentLabel`. **Errors:** 401; 400 `Invalid JSON`; 400 `Invalid request` (+`details`). The post-validation data-layer calls are *not* wrapped in try/catch, so an unexpected failure surfaces as a framework **500** (no typed body).

### 13. List contact student-links — `GET /api/line/contacts/[contactId]/student-links`

**Auth:** Auth.js session. **Does:** return the contact's student links, ensuring suggestions exist first. **Request:** path param `contactId`. **Response (HTTP 200):** `{ links }` from `ensureLineContactStudentLinkSuggestions(db, contactId)` (which seeds suggestions then returns the link list) ([`student-links/route.ts:36-39`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)). **Side effects:** may insert *suggested* links as a side effect of ensuring suggestions. **Errors:** 401.

### 14. Create a verified student-link — `POST /api/line/contacts/[contactId]/student-links`

**Auth:** Auth.js session. **Does:** directly create a **verified** contact→student link. **Request — body** (`postSchema`, `.strict()`, [`student-links/route.ts:12-14`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)): `{ studentKey: string (1–240) }`. Actor from session.

**Response (HTTP 201):** `{ link, links }` — the new link plus the refreshed list ([`student-links/route.ts:65-75`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)). **Side effects:** inserts a verified link. **Errors:** 401; 400 `Invalid JSON`; 400 `Invalid request` (+`details`); **404 `Current credit-control student not found`** when `studentKey` does not resolve to a current student ([`student-links/route.ts:70-72`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)).

### 15. Verify/reject a student-link — `PATCH /api/line/contacts/[contactId]/student-links`

**Auth:** Auth.js session. **Does:** transition a suggested link to verified or rejected. **Request — body** (`patchSchema`, `.strict()`, [`student-links/route.ts:16-19`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)): `{ action: z.enum(["verify","reject"]), linkId: uuid }`. `verify`→status `verified`, `reject`→status `rejected` ([`student-links/route.ts:104`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)). Actor from session.

**Response (HTTP 200):** `{ link, links }` ([`student-links/route.ts:107-112`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts)). **Side effects:** updates link status + reviewer. **Errors:** 401; 400 `Invalid JSON`; 400 `Invalid request` (+`details`); **404 `Student link not found`**.

### 16. Refresh all contact profiles — `POST /api/line/contacts/refresh-profiles`

**Auth:** Auth.js session. **Does:** re-pull LINE profile data (display name / avatar) for every contact via `refreshAllLineContactProfiles`. **Request:** no body, no params. **Response (HTTP 200):** `{ result }` (the refresh summary) ([`refresh-profiles/route.ts:12-13`](../../../src/app/api/line/contacts/refresh-profiles/route.ts)). **Side effects:** bulk profile updates (calls LINE). **Errors:** 401 only — no try/catch, so a failure surfaces as a framework **500**.

---

## Contact alias import

Bulk-attach human alias labels to contacts by OCR-ing a pasted LINE chat-list screenshot and/or text. Preview, then commit.

### 17. Preview alias import — `POST /api/line/contacts/alias-import/preview`

**Auth:** Auth.js session. **Does:** parse a screenshot and/or pasted text into proposed `(contactId, aliasLabel)` rows without persisting.

**Request — `multipart/form-data`** (not JSON): fields `image` (a `File`; ≤5 MB; MIME in `{image/png, image/jpeg, image/webp}`), `text`, `preferredContactId`. The handler requires **at least one** of `image` or `text` ([`alias-import/preview/route.ts:53-56`](../../../src/app/api/line/contacts/alias-import/preview/route.ts)). Parsed by hand (`request.formData()`), no Zod.

**Response (HTTP 200):** `{ preview }` from `previewLineAliasImport({ db, text, image, preferredContactId })` ([`alias-import/preview/route.ts:58-65`](../../../src/app/api/line/contacts/alias-import/preview/route.ts)). **Side effects:** none persisted (calls the OCR / vision provider). **Errors:** 401; **400 `Expected multipart form data`** if `formData()` throws; **400** with a specific message for an oversized/unsupported image (`Image must be 5MB or smaller`, `Image must be PNG, JPEG, or WebP`) ([`alias-import/preview/route.ts:18-23`](../../../src/app/api/line/contacts/alias-import/preview/route.ts)); **400 `Paste chat-list text or upload a screenshot`** when both inputs are empty; on a thrown library error, **503** when the message includes `"configured"` (provider not configured), else **500** ([`alias-import/preview/route.ts:66-69`](../../../src/app/api/line/contacts/alias-import/preview/route.ts)).

### 18. Commit alias import — `POST /api/line/contacts/alias-import/commit`

**Auth:** Auth.js session. **Does:** persist the reviewed alias rows from a preview.

**Request — body** (`commitSchema`, `.strict()`, [`alias-import/commit/route.ts:7-12`](../../../src/app/api/line/contacts/alias-import/commit/route.ts)): `{ rows: Array<{ contactId: uuid, aliasLabel: string (1–500) }> }` with `rows` length 1–100.

**Response (HTTP 200):** `{ result }` from `commitLineAliasImport({ db, rows })` ([`alias-import/commit/route.ts:35-39`](../../../src/app/api/line/contacts/alias-import/commit/route.ts)). **Side effects:** writes alias labels onto the listed contacts. **Errors:** 401; 400 `Invalid JSON`; 400 `Invalid request` (+`details`). No business-logic try/catch → an unexpected failure is a framework **500**.

---

## Link validation

A reviewer worklist for confirming / rejecting the *suggested* contact→student links produced by the OA-resolver pipeline. Tasks can be assigned to specific reviewer emails.

### 19. List validation tasks — `GET /api/line/contacts/link-validation`

**Auth:** Auth.js session. **Does:** paginated list of link-validation tasks for a scope, plus the reviewer roster.

**Request — query params** (each validated individually):
| Param | Schema | Default / notes |
|-------|--------|-----------------|
| `scope` | `z.enum(["my","all","unassigned","verified","rejected"])` ([`link-validation/route.ts:10`](../../../src/app/api/line/contacts/link-validation/route.ts)) | default `"my"`; invalid → **400 `Invalid scope`**. `my` filters to *suggested* tasks assigned to the caller's email ([`link-validation.ts:418-427`](../../../src/lib/line/link-validation.ts)) |
| `runId` | `z.string().uuid().optional()` | invalid → **400 `Invalid runId`** |
| `page` | `z.coerce.number().int().min(1).default(1)` | invalid → **400 `Invalid page`** |
| `pageSize` | `z.coerce.number().int().min(1).max(100).default(100)` | invalid → **400 `Invalid pageSize`** |

**Response (HTTP 200):** `{ tasks, reviewers, pagination }` from `listLineLinkValidationTasks(db, { scope, runId, actor, page, pageSize })` ([`link-validation.ts:399-412`](../../../src/lib/line/link-validation.ts)). **Side effects:** none. **Errors:** 401; 400 (`Invalid scope` / `Invalid runId` / `Invalid page` / `Invalid pageSize`).

### 20. Validation summary — `GET /api/line/contacts/link-validation/summary`

**Auth:** Auth.js session. **Does:** counts / KPIs for the validation queue (optionally scoped to one run). **Request — query param:** `runId` (`uuid` optional; invalid → **400 `Invalid runId`**). Actor from session. **Response (HTTP 200):** `{ summary }` from `getLineLinkValidationSummary(db, { runId, actor })` ([`link-validation.ts:472`](../../../src/lib/line/link-validation.ts)). **Side effects:** none. **Errors:** 401; 400 `Invalid runId`.

### 21. Assign validation tasks — `POST /api/line/contacts/link-validation/assign`

**Auth:** Auth.js session. **Does:** assign validation tasks from a run to one or more reviewer emails (by explicit link ids, or across the run's open tasks when `linkIds` is omitted).

**Request — body** (`assignSchema`, `.strict()`, [`link-validation/assign/route.ts:10-14`](../../../src/app/api/line/contacts/link-validation/assign/route.ts)): `{ runId: uuid, reviewerEmails: string[] (email, 1–50), linkIds?: uuid[] (1–500) }`.

**Response (HTTP 200):** the object from `assignLineLinkValidationTasks(db, parsed.data)` ([`link-validation/assign/route.ts:38`](../../../src/app/api/line/contacts/link-validation/assign/route.ts)). **Side effects:** writes `validationAssignedToEmail` onto the targeted links. **Errors:** 401; 400 `Invalid JSON`; 400 `Invalid request` (+`details`); a thrown `LineLinkValidationError` is mapped to **its own `.status`** with `{ error: message }` ([`link-validation/assign/route.ts:41-44`](../../../src/app/api/line/contacts/link-validation/assign/route.ts)); any other throw propagates (framework **500**).

### 22. Verify/reject one validation task — `PATCH /api/line/contacts/link-validation/[linkId]`

**Auth:** Auth.js session. **Does:** set a single link-validation task to `verified` or `rejected`, with an optional note.

**Request — body** (`patchSchema`, `.strict()`, [`link-validation/[linkId]/route.ts:7-10`](../../../src/app/api/line/contacts/link-validation/[linkId]/route.ts)): `{ status: z.enum(["verified","rejected"]), note?: string|null (≤1000) }`. Path param `linkId`; actor from session.

**Response (HTTP 200):** `{ task }` from `patchLineLinkValidationTaskStatus({ linkId, status, note, actor })` ([`link-validation/[linkId]/route.ts:43-48`](../../../src/app/api/line/contacts/link-validation/[linkId]/route.ts)). **Side effects:** updates task status + reviewer + note. **Errors:** 401; 400 `Invalid JSON`; 400 `Invalid request` (+`details`); **404 `Student link not found`**.

---

## OA resolver

The OA-resolver discovers a LINE OA chat URL for each credit-control student by driving a browser extension. A *run* is created in-app (session-auth); the extension reads its worklist and writes back rows using a per-run **bearer token** (the two public endpoints); an admin then commits matched rows into verified links.

### 23. Extension worklist — `GET /api/line/contacts/oa-resolver/worklist`

**Auth:** public route; **per-run bearer token** (`Authorization: Bearer <token>`), no session. **Does:** hand the browser extension the list of students / chats to resolve for the token's run. Serves CORS + an `OPTIONS` `204` preflight ([`oa-resolver/worklist/route.ts:17-19`](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts)).

**Request:** bearer token only; no body/query. **Response (HTTP 200, CORS headers):** `{ worklist }` from `listLineOaResolverWorklistForToken(db, token)`. **Side effects:** none. **Errors:** **401 `Invalid or expired resolver token`** (CORS headers attached) when the token is missing or does not resolve ([`oa-resolver/worklist/route.ts:26-31`](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts)).

### 24. List / latest runs — `GET /api/line/contacts/oa-resolver/runs`

**Auth:** Auth.js session. **Does:** either list recent runs or fetch the latest run (with the caller's resolver token), depending on `latest`.

**Request — query params:** `latest` (`"true"` switches mode); `limit` (number, used only when `latest` is falsy; non-finite → falls back to `20`) ([`oa-resolver/runs/route.ts:23-28`](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts)). No Zod. **Response (HTTP 200):** `latest=true` → `{ run }` from `getLatestLineOaResolverRun(db, actor)`; otherwise `{ runs }` from `listLineOaResolverRuns(db, limit)`. **Side effects:** none. **Errors:** 401.

### 25. Create a run — `POST /api/line/contacts/oa-resolver/runs`

**Auth:** Auth.js session. **Does:** create a new OA-resolver run (and its bearer token / worklist) for the caller. **Request:** no body. **Response (HTTP 201):** the object from `createLineOaResolverRun(db, actor)` returned verbatim ([`oa-resolver/runs/route.ts:41-42`](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts)). **Side effects:** inserts a run row + token + seeds its rows. **Errors:** 401.

### 26. Get one run — `GET /api/line/contacts/oa-resolver/runs/[runId]`

**Auth:** Auth.js session. **Does:** fetch a single run with its rows / status. **Request:** path param `runId`. **Response (HTTP 200):** `{ run }` from `getLineOaResolverRun(db, runId)`. **Side effects:** none. **Errors:** 401; **404 `Resolver run not found`** ([`runs/[runId]/route.ts:16-18`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/route.ts)).

### 27. Extension writes back rows — `POST /api/line/contacts/oa-resolver/runs/[runId]/rows`

**Auth:** public route; **per-run bearer token**, no session. **Does:** the extension reports resolved chat candidates for rows in the run. Serves CORS + `OPTIONS` `204`.

**Request — body** (`rowsSchema`, `.strict()`, [`runs/[runId]/rows/route.ts:24-38`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)): `{ rows: Row[] }`, `rows` length 1–50. Each `Row` (`.strict()`): `{ rowId: uuid, status: z.enum(["matched","ambiguous","no_match","error"]), lineChatUrl?: string|null (≤500), chatTitle?: string|null (≤500), candidates?: Candidate[] (≤25), matchMode?, captureMode? (≤80), errorMessage? (≤1000), evidence?: Record<string,unknown> }`. Each `Candidate` (`.strict()`, [`runs/[runId]/rows/route.ts:12-22`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)): `{ lineChatUrl (≤500), chatTitle?, adminNoteRaw? (≤1000), relationshipRole?: z.enum(["mom","dad","secretary","other","unknown"]), candidateRank?: int 1–100, captureMode?, matchMode? (≤80), searchCode? (≤120), siblingFanout?: bool }`. Path param `runId`; bearer token authenticates.

**Response (HTTP 200, CORS headers):** `{ run }` (the updated run) from `updateLineOaResolverRowsFromExtension(db, { token, runId, rows })` ([`runs/[runId]/rows/route.ts:77-89`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)). **Side effects:** writes resolved candidates / status onto the run's rows. **Errors (all CORS-headed):** **401 `Missing resolver token`** when no bearer is present; 400 `Invalid JSON`; 400 `Invalid request` (+`details`); **401 `Invalid or expired resolver token`** when the token + run do not resolve ([`runs/[runId]/rows/route.ts:82-87`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)).

### 28. Commit a run — `POST /api/line/contacts/oa-resolver/runs/[runId]/commit`

**Auth:** Auth.js session. **Does:** promote selected resolved rows of a run into verified contact↔student links / OA assignments.

**Request — body** (`commitSchema`, `.strict()`, [`runs/[runId]/commit/route.ts:7-13`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts)): `{ rowIds?: uuid[] (1–1000), selectedCandidates?: Array<{ rowId: uuid, lineUserId: string matching /^U[a-fA-F0-9]{32}$/ }> (≤5000) }` — both optional; a missing / invalid JSON body falls back to `{}` (then re-validated) ([`runs/[runId]/commit/route.ts:23-28`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts)). Path param `runId`.

**Response (HTTP 200):** `{ result }` from `commitLineOaResolverRun(db, { runId, rowIds, selectedCandidates })` ([`runs/[runId]/commit/route.ts:39-43`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts)). **Side effects:** creates verified links / commits OA assignments from the run. **Errors:** 401; 400 `Invalid request` (+`details`) — note malformed JSON does **not** 400 here (it degrades to `{}`); **404 `Resolver run not found`** when the commit returns nothing ([`runs/[runId]/commit/route.ts:44-46`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts)).

---

## Cross-cutting notes

- **Standard error envelope.** Session endpoints return `{ "error": string }` and, for Zod failures, `{ "error": "Invalid request", "details": <flatten()> }`. The webhook is the exception (`{ ok: false, error }`).
- **Actor capture.** Every mutating session endpoint derives `actor = { email, name }` from `session.user` (a local `actorFromSession` helper repeated per route) and threads it into the data layer for audit attribution.
- **Async work.** Only the webhook offloads work via `after()`; all other handlers complete their writes inline before responding.
- **Three non-session ingress points** (`webhook`, `oa-resolver/worklist`, `oa-resolver/runs/[runId]/rows`) are the *only* LINE routes reachable without an Auth.js session; the webhook is gated by LINE signature, the two resolver routes by a per-run bearer token. All other handlers require a session and pass through page-level access control.

_Verified against HEAD `d4fe6d3` on 2026-06-05._
