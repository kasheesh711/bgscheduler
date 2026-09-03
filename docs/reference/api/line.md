# LINE API Reference

**Authoritative source:** the 25 route handlers under [`src/app/api/line/`](../../../src/app/api/line/). **Status:** stable (scheduler write-path flag-gated) — see [Flags that change behaviour](#flags-that-change-behaviour) for the exact mechanisms.

This page is the mechanical reference for the LINE HTTP surface: method, path, auth, request shape, response shape, side effects, and status codes. Feature meaning — why identity resolution is fail-closed, what the review lifecycle is *for*, how the OA-resolver browser extension fits the workflow — lives in [`docs/features/line-integration.md`](../../features/line-integration.md). Table columns live in [`docs/reference/database/index.md`](../database/index.md).

**29 endpoints across 25 route files.** Two `OPTIONS` preflight handlers ([`worklist/route.ts:17-19`](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts), [`rows/route.ts:48-50`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)) are excluded from that count — they carry no business surface, returning a bare `204` with CORS headers. A naive grep for exported handlers therefore yields 31.

## Endpoints at a glance

| Method | Path | Auth |
|---|---|---|
| POST | `/api/line/webhook` | public + LINE channel signature |
| GET | `/api/line/scheduler-reviews` | session |
| GET | `/api/line/scheduler-reviews/false-negatives` | session |
| PATCH | `/api/line/scheduler-reviews/[reviewId]` | session |
| GET | `/api/line/scheduler-reviews/[reviewId]/context` | session |
| POST | `/api/line/scheduler-reviews/[reviewId]/operational-plan` | session |
| GET | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | session |
| POST | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | session |
| POST | `/api/line/messages/[messageId]/promote` | session |
| PATCH | `/api/line/messages/[messageId]/classification-feedback` | session |
| PATCH | `/api/line/contacts/[contactId]` | session |
| GET | `/api/line/contacts/[contactId]/student-links` | session |
| POST | `/api/line/contacts/[contactId]/student-links` | session |
| PATCH | `/api/line/contacts/[contactId]/student-links` | session |
| GET | `/api/line/students` | session |
| POST | `/api/line/contacts/alias-import/preview` | session |
| POST | `/api/line/contacts/alias-import/commit` | session |
| POST | `/api/line/contacts/refresh-profiles` | session |
| POST | `/api/line/contacts/followers-reanchor` | session |
| GET | `/api/line/contacts/link-validation` | session |
| GET | `/api/line/contacts/link-validation/summary` | session (lead-gated payload) |
| POST | `/api/line/contacts/link-validation/assign` | session |
| PATCH | `/api/line/contacts/link-validation/[linkId]` | session |
| GET | `/api/line/contacts/oa-resolver/runs` | session |
| POST | `/api/line/contacts/oa-resolver/runs` | session |
| GET | `/api/line/contacts/oa-resolver/runs/[runId]` | session |
| POST | `/api/line/contacts/oa-resolver/runs/[runId]/commit` | session |
| POST | `/api/line/contacts/oa-resolver/runs/[runId]/rows` | public + opaque bearer token |
| GET | `/api/line/contacts/oa-resolver/worklist` | public + opaque bearer token |

---

## Conventions shared across the endpoints

**Three auth tiers.** Twenty-six endpoints call `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and return `401 {"error":"Unauthorized"}` on failure. Three are in the middleware public allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)) and enforce their own in-handler check instead: `/api/line/webhook` (HMAC channel signature), `/api/line/contacts/oa-resolver/worklist` and `/api/line/contacts/oa-resolver/runs/{runId}/rows` (opaque `Bearer` token hashed against `line_oa_resolver_runs.tokenHash`). The `rows` allowlist entry is a regex over one path segment, so it matches every `runId` ([`middleware.ts:23`](../../../src/middleware.ts)).

**Restricted-user gating.** For the 26 session endpoints, a restricted admin (non-null `allowedPages` not containing `/line-review`) is stopped in middleware before the handler runs, because `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:36-67`](../../../src/middleware.ts)). No LINE handler does its own role check; the only per-actor authorization inside the group is the validation-lead gate on the link-validation summary.

**Maintenance mode.** `MAINTENANCE_MODE=true` closes every LINE path, `/api/line/webhook` included — the maintenance gate is deliberately placed *above* the public allowlist so the webhook cannot slip through ([`middleware.ts:76-86`](../../../src/middleware.ts)); the exempt prefixes are only `/api/internal/`, `/schedule/`, `/api/auth/`, `/login` ([`maintenance.ts:43-48`](../../../src/lib/maintenance.ts)).

**The four-step mutation shape.** Handlers with a JSON body follow the project pattern: `auth()` → 401; `request.json()` in try/catch → `400 {"error":"Invalid JSON"}`; `schema.safeParse()` → `400 {"error":"Invalid request", details: <flatten()>}`; then business logic. Every body schema in this group is `.strict()`, so an unknown key is a 400, not a silent drop. Two handlers deviate: the OA-resolver commit swallows a JSON parse failure and falls back to `{}` ([`commit/route.ts:23-28`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts)), and the alias-import preview reads `multipart/form-data` rather than JSON.

**Actor stamping.** Nine route files derive `{ email, name }` from the session with a locally-defined `actorFromSession` helper (each declares its own copy — there is no shared helper) and pass it into the lib layer, which lower-cases the email and trims the name before writing it to `reviewedBy*` / `createdBy*` / `validationAssignedTo*` columns.

**No caching.** No LINE route declares `"use cache"`, `revalidate`, or `dynamic`; every request reads Postgres directly. Only two declare a `maxDuration`: the webhook (`60`) and followers-reanchor (`300`).

**Route tests.** 15 of the 25 route files have a sibling `__tests__/route.test.ts`. The ten without one are `contacts/[contactId]`, `contacts/[contactId]/student-links`, `contacts/alias-import/preview`, `contacts/oa-resolver/runs/[runId]`, `scheduler-reviews`, `scheduler-reviews/[reviewId]`, `scheduler-reviews/[reviewId]/operational-plan`, `scheduler-reviews/[reviewId]/wise-actions`, `students`, and `webhook` — so the two endpoints with the widest blast radius, the review PATCH (which sends to a parent) and the webhook, have no route-level test. The webhook's logic is covered instead at the lib layer ([`src/lib/line/__tests__/`](../../../src/lib/line/__tests__/)).

### Flags that change behaviour

| Env var | Read at | Effect |
|---|---|---|
| `ENABLE_LINE_SCHEDULER` | [`client.ts:19-23`](../../../src/lib/line/client.ts) | `lineSchedulerEnabled()` is false when this is exactly `"false"`, **or** when `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` is blank. Only `POST /api/line/webhook` consults it, and only to return **503** — it gates *ingest*, never sending. |
| `LINE_CHANNEL_SECRET` | [`client.ts:25-27`](../../../src/lib/line/client.ts) | HMAC key for `x-line-signature` verification. |
| `LINE_CHANNEL_ACCESS_TOKEN` | [`client.ts:30-31`](../../../src/lib/line/client.ts) | Bearer token for the outbound push. `pushLineTextMessage` throws if unset. |
| `WISE_SESSION_OPERATIONS_VERIFIED` | [`wise/operations.ts:10-12`](../../../src/lib/wise/operations.ts) | Selects which **dry-run** branch `POST .../wise-actions` records. Even when `"true"`, no Wise mutation is sent — see [`POST /api/line/scheduler-reviews/[reviewId]/wise-actions`](#post-apilinescheduler-reviewsreviewidwise-actions). |
| `LINE_VALIDATION_LEAD_EMAILS` | [`link-validation.ts:220-229`](../../../src/lib/line/link-validation.ts) | Comma-separated allowlist deciding who sees the link-validation tracker payload. Falls back to two hard-coded emails when unset. Read straight from `process.env` — it is **not** declared in [`src/lib/env.ts`](../../../src/lib/env.ts). |

The "write-path flag-gated" half of the status badge refers to the **Wise** write path, which is dry-run in both branches. The **LINE reply** write path is not flag-gated: `PATCH /api/line/scheduler-reviews/[reviewId]` with `action: "approve_send"` performs a real outbound push to the parent.

---

## Webhook ingest

### `POST /api/line/webhook`

Ingests a LINE Messaging API webhook batch. Handler: [`webhook/route.ts:8-47`](../../../src/app/api/line/webhook/route.ts). `export const maxDuration = 60`.

**Auth:** public in middleware; the handler verifies `x-line-signature` as base64 HMAC-SHA256 of the raw body under the channel secret, compared with `timingSafeEqual` after a length pre-check ([`signature.ts:3-20`](../../../src/lib/line/signature.ts)). A missing secret or missing signature returns false — fail-closed.

**Request:** the raw LINE webhook JSON, read with `request.text()` so the bytes signed are the bytes verified. There is no Zod schema; `recordLineWebhookPayload` reads the payload defensively field by field ([`data.ts:422-521`](../../../src/lib/line/data.ts)).

**Per-event handling** ([`data.ts:434-518`](../../../src/lib/line/data.ts)):

| Event | Outcome |
|---|---|
| `message` from a `group`/`room` source, type `text` | Collected as a `LineGroupCommand` and handed to the schedule-bot router. **Never persisted as a `line_messages` row** — the conversation model is 1:1 per LINE user, so groups are a command channel, not a conversation ([`data.ts:37-53`](../../../src/lib/line/data.ts)). |
| `message` from a `user` source, type `text` | Upserts the contact, gets-or-creates the thread, inserts an inbound `line_messages` row with `onConflictDoNothing` on `webhookEventId`. A returned id → `createdMessageIds`; no row → `duplicateEvents += 1`. |
| `unsend` from a `user` source | Sets `isRetracted` + `retractedAt` on the matching `lineMessageId`; counts into `retractedMessages`. |
| anything else — non-user source, non-text message, missing sender, other event types | `ignoredEvents += 1`. |

**Deferred work.** Both callbacks run inside Next's `after()`, so the 200 goes back to LINE first ([`webhook/route.ts:20-43`](../../../src/app/api/line/webhook/route.ts)). Each created message id is passed to `processLineMessageForScheduler`, and each group command to `handleScheduleBotGroupCommand`; both modules are `await import()`ed lazily specifically to keep the AI-scheduler and search subtrees out of the pre-response cold start. Failures are caught and `console.error`'d — they never affect the response.

**Response 200:**

```json
{ "ok": true, "createdMessageIds": ["…"], "duplicateEvents": 0,
  "ignoredEvents": 0, "retractedMessages": 0, "groupCommands": 0 }
```

**Status codes:** 200 accepted · 400 `{"ok":false,"error":"Invalid JSON"}` (signature valid, body unparseable) · 401 `{"ok":false,"error":"Invalid LINE signature"}` · 503 `{"ok":false,"error":"LINE scheduler is not configured"}` when `lineSchedulerEnabled()` is false. Shapes at [`webhook.ts:5-16,27-66`](../../../src/lib/line/webhook.ts).

---

## Scheduler reviews

All six review endpoints operate on `line_scheduler_reviews`. The row DTO returned throughout is `LineSchedulerReviewDto` ([`data.ts:94-133`](../../../src/lib/line/data.ts)) — 38 fields covering identity (`threadId`, `contactId`, `lineUserId`, `contactDisplayName`), classifier output, the operational plan (`intentType`, `intentPayload`, `candidateSessions`, `proposedWiseActions`, `adminSelectedSessionIds`, `writebackStatus`), the draft/final text pair, reviewer stamps, and send outcome (`sendLineMessageId`, `sendResponse`, `sendError`).

Two enums recur: `status` ∈ `pending_review | approved_sent | accepted_no_send | rejected | dismissed` and `intentType` ∈ `new_request | cancel_one_off | pause_until | resume | reschedule | unclear_change` ([`data.ts:10-23`](../../../src/lib/line/data.ts)). `writebackStatus` ∈ `not_applicable | dry_run | manual_required | ready | confirmed | failed` ([`data.ts:25-31`](../../../src/lib/line/data.ts)).

### `GET /api/line/scheduler-reviews`

Lists reviews, optionally with dashboard analytics. Handler: [`scheduler-reviews/route.ts:24-53`](../../../src/app/api/line/scheduler-reviews/route.ts).

**Query parameters:**

| Param | Validation | Notes |
|---|---|---|
| `status` | `statusSchema` ([`route.ts:7-13`](../../../src/app/api/line/scheduler-reviews/route.ts)) | Omit for all statuses. An invalid value is 400. |
| `intentType` | `intentSchema` ([`route.ts:15-22`](../../../src/app/api/line/scheduler-reviews/route.ts)) | Omit for all intents. An invalid value is 400. |
| `conversationId` | none | Passed through verbatim as an equality filter. |
| `analytics` | `=== "true"` | Any other value (including `1`) leaves `analytics: null`. |

**Response 200:** `{ reviews: LineSchedulerReviewDto[], analytics: LineSchedulerAnalytics | null }`. The list is joined to `line_contacts`, ordered `createdAt DESC`, and **hard-capped at 200 rows** with no pagination parameter ([`data.ts:861`](../../../src/lib/line/data.ts)). `LineSchedulerAnalytics` ([`data.ts:173-195`](../../../src/lib/line/data.ts)) carries classification counts, review-outcome counts, `rejectionRate`, `averageEditDistance`, `averageModelLatencyMs`, classification accuracy/coverage plus false-positive and false-negative counts, `unverifiedLinkBacklog`, and three grouped arrays (`commonRejectionReasons`, `commonRejectionCategories`, `feedbackLabels`).

**Status codes:** 200 · 400 `Invalid status` / `Invalid intentType` · 401.

### `GET /api/line/scheduler-reviews/false-negatives`

Lists inbound messages the classifier probably under-called, so an admin can promote them. Handler: [`false-negatives/route.ts:9-26`](../../../src/app/api/line/scheduler-reviews/false-negatives/route.ts).

**Query:** `threshold` — `z.coerce.number().min(0).max(1)`, optional. Default `LINE_FALSE_NEGATIVE_CONFIDENCE_THRESHOLD = 0.75` ([`classifier.ts:24`](../../../src/lib/line/classifier.ts)).

**Selection rule** ([`data.ts:568-635`](../../../src/lib/line/data.ts)): inbound messages with no `classificationReviewedAt` and no promoted review, whose classifier category is `unclear`, **or** `non_scheduling` with confidence below the threshold. NULL confidence is treated as "show" — fail-open toward surfacing. Ordered `classifiedAt DESC`, limit 100 (not overridable from the route). Rows with empty text are filtered out.

**Response 200:** `{ candidates: LineFalseNegativeCandidateDto[] }` ([`data.ts:79-92`](../../../src/lib/line/data.ts)) — id, thread/contact ids, `lineUserId`, display name, text, the four classifier fields, `classifiedAt`, `conversationId`.

**Status codes:** 200 · 400 `Invalid threshold` · 401.

### `PATCH /api/line/scheduler-reviews/[reviewId]`

The one endpoint that can send a message to a parent. Handler: [`[reviewId]/route.ts:60-133`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts).

**Body:** a Zod **discriminated union on `action`**, each arm `.strict()` ([`route.ts:12-44`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)):

| `action` | Required | Optional |
|---|---|---|
| `approve_send` | `finalText` (1–5000, trimmed) | `selectedTutorIds` (≤12), `studentLinkOverride` |
| `accept_no_send` | — | `finalText` (≤5000), `selectedTutorIds` (≤12), `studentLinkOverride` |
| `reject` | `reasonCategory` (one of `wrong_student_link`, `wrong_extracted_request`, `wrong_tutor_fit`, `wrong_availability`, `unsafe_draft`, `unclear`, `other`), `rejectionReason` (1–500), `staffCorrection` (1–5000) | `rejectedTutorIds` (≤12) |
| `dismiss` | — | `rejectionReason` (≤500) |

**Side effects by action** ([`review-service.ts:465-644`](../../../src/lib/line/review-service.ts)). All four are no-ops that return the row unchanged when `status !== "pending_review"`.

- **`approve_send`** — refuses unless the contact has at least one verified student link *or* `studentLinkOverride` is set, throwing `Verify a LINE student link or mark this contact as unmatched before sending` (this is the fail-closed identity gate). Then: real outbound `pushLineTextMessage` to `review.lineUserId` with an idempotency `X-Line-Retry-Key` ([`client.ts:112-142`](../../../src/lib/line/client.ts)); patch to `approved_sent` with the send response; insert an outbound `line_messages` row; write an AI-scheduler feedback row labelled `accept` or `edit` depending on whether `finalText` matches the proposed draft.
- **`accept_no_send`** — same feedback row (`accept`/`edit`), status `accepted_no_send`, **no** LINE push, and no verified-link gate.
- **`reject`** — feedback row `reject`; status `rejected` with category, reason, and staff correction persisted for the correction-telemetry loop.
- **`dismiss`** — feedback row `dismiss`; status `dismissed`.

**Response 200:** `{ review: LineSchedulerReviewDto }`.

**Status codes:** 200 · 400 invalid JSON, Zod failure, **or any thrown business error** — the whole dispatch is wrapped and every `Error` maps to 400 with its message, including a LINE push failure ([`route.ts:129-132`](../../../src/app/api/line/scheduler-reviews/[reviewId]/route.ts)) · 401 · 404 `Review not found`.

### `GET /api/line/scheduler-reviews/[reviewId]/context`

Returns the merged conversation behind a review. Handler: [`context/route.ts:8-21`](../../../src/app/api/line/scheduler-reviews/[reviewId]/context/route.ts). Read-only.

**Response 200:** `{ context: LineReviewChatContextDto }` ([`data.ts:164-171`](../../../src/lib/line/data.ts)) — `reviewId`, `threadId`, `conversationId`, and three arrays of `LineReviewContextMessageDto` ([`data.ts:150-162`](../../../src/lib/line/data.ts)): `lineMessages`, `websiteMessages`, and a `combinedTimeline`. Each entry carries `source: "line" | "website"`, `roleLabel`, text, timestamp, `direction`, `role`, `messageType`, `isRetracted`, and creator stamps. The LINE side defaults to the 30 most recent messages ([`data.ts:1040-1045`](../../../src/lib/line/data.ts)).

**Status codes:** 200 · 401 · 404 `Review not found`.

### `POST /api/line/scheduler-reviews/[reviewId]/operational-plan`

Recomputes the operational plan for a pending review — used after an identity or session change makes the stored plan stale. Handler: [`operational-plan/route.ts:13-52`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts).

**Request:** no body; the request object is ignored.

**Flow:** load the review → 404 if missing; reject a non-pending review with **400** `Only pending reviews can be rebuilt`; load the inbound message → 404 `Inbound LINE message not found`; run `buildLineOperationalReviewPlan` over `{ contactId, messageText, classifierCategory }` ([`operational.ts:584-589`](../../../src/lib/line/operational.ts)); persist the result.

The rebuild reads only **verified** contact→student links and derives candidate sessions from them ([`operational.ts:604-610`](../../../src/lib/line/operational.ts)); a `new_request` intent short-circuits to an empty plan with `writebackStatus: "not_applicable"`. The persisted `proposedDraft` falls back to the review's existing draft when the new plan produces an empty one ([`route.ts:43`](../../../src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts)). No Wise call is made — actions are only *proposed*.

**Response 200:** `{ review: LineSchedulerReviewDto | null }` (re-read after the update).

**Status codes:** 200 · 400 non-pending review · 401 · 404 review or inbound message missing. Note there is no try/catch: a thrown lib error surfaces as an unhandled 500.

### `GET /api/line/scheduler-reviews/[reviewId]/wise-actions`

Lists the Wise-action audit trail for a review. Handler: [`wise-actions/route.ts:22-31`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts).

**Response 200:** `{ logs: LineWiseActionLogDto[] }` ([`data.ts:135-148`](../../../src/lib/line/data.ts)) — `actionType`, `status`, `dryRun`, `wiseSessionIds`, `requestPayload`, `responsePayload`, `errorMessage`, creator stamps — ordered `createdAt DESC`. An unknown `reviewId` yields an empty array, not a 404.

**Status codes:** 200 · 401.

### `POST /api/line/scheduler-reviews/[reviewId]/wise-actions`

Confirms one proposed Wise action. **Records an audit row; never mutates Wise.** Handler: [`wise-actions/route.ts:33-67`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts).

**Body** (`.strict()`, [`route.ts:8-11`](../../../src/app/api/line/scheduler-reviews/[reviewId]/wise-actions/route.ts)): `actionId` (1–160), optional `selectedSessionIds` (each 1–240, ≤80 entries). When omitted or empty, the action's own `wiseSessionIds` are used.

**Behaviour** ([`wise/operations.ts:26-95`](../../../src/lib/wise/operations.ts)) — both branches write a log row and patch the review's operational state:

| `WISE_SESSION_OPERATIONS_VERIFIED` | Log `status` | `dryRun` | Review `writebackStatus` | Response `endpointVerified` |
|---|---|---|---|---|
| not `"true"` | `manual_required` (with the message `Wise cancel/reschedule endpoint contract is not verified in this environment.`) | `true` | `manual_required` | `false` |
| `"true"` | `dry_run` (response payload `Dry run recorded; no Wise mutation was sent.`) | `true` | `dry_run` | `true` |

The comment at [`operations.ts:71-72`](../../../src/lib/wise/operations.ts) states the endpoint contract stays dry-run until the Wise cancel/move request shape is verified — so setting the flag changes the audit label, not the effect.

**Response 200:** `{ log: LineWiseActionLogDto, endpointVerified: boolean }`.

**Status codes:** 200 · 400 invalid JSON, Zod failure, or any thrown error — `LINE review not found`, `Only pending reviews can confirm Wise actions`, `Wise action not found`, `Select at least one Wise session before confirming` all surface as **400**, including the not-found cases · 401.

---

## Messages

### `POST /api/line/messages/[messageId]/promote`

Promotes a message the classifier missed into a pending review. Handler: [`promote/route.ts:15-32`](../../../src/app/api/line/messages/[messageId]/promote/route.ts). No body.

**Side effects** ([`review-service.ts:423-462`](../../../src/lib/line/review-service.ts)): if a review already exists for that inbound message, it is returned with `alreadyExisted: true` and nothing is written. Otherwise the message's classification feedback is stamped `scheduling_request` (which also removes it from the false-negative queue), and a review is created with an empty `proposedDraft`, no selected suggestion, and a synthesized classification whose summary/rationale default to `Promoted from the missed-message queue` / `Manually promoted by an admin from the missed-message queue.`

**Response 200:** `{ review: LineSchedulerReviewDto, alreadyExisted: boolean }`.

**Status codes:** 200 · 401 · 404 `LINE message not found` — also returned when the message exists but its text is blank ([`review-service.ts:428-431`](../../../src/lib/line/review-service.ts)).

### `PATCH /api/line/messages/[messageId]/classification-feedback`

Records the human-reviewed classifier category, feeding classification accuracy in the analytics payload. Handler: [`classification-feedback/route.ts:20-51`](../../../src/app/api/line/messages/[messageId]/classification-feedback/route.ts).

**Body** (`.strict()`): `reviewedCategory` ∈ `scheduling_request | scheduling_change | non_scheduling | unclear`.

**Side effects** ([`data.ts:682-729`](../../../src/lib/line/data.ts)): reads the existing `classifierCategory`, computes `classificationReviewedCorrect` by equality, then writes the reviewed category, the correctness flag, the actor, and `classificationReviewedAt`. Stamping `classificationReviewedAt` is what drops the message out of the false-negative queue.

**Response 200:** `{ feedback: { id, classifierCategory, classificationReviewedCategory, classificationReviewedCorrect } }`.

**Status codes:** 200 · 400 invalid JSON / Zod failure · 401 · 404 `LINE message not found`.

---

## Contacts and student links

A **contact→student link** (`line_contact_student_links`, unique on `(contactId, studentKey)`) is the identity join between a LINE user and a credit-control student. Its `status` is `suggested | verified | rejected` ([`student-links.ts:7`](../../../src/lib/line/student-links.ts)). The invariant (IDENT-02, [`student-links.ts:529`](../../../src/lib/line/student-links.ts)) is that machine-derived links are **always** inserted as `suggested`, never `verified`; only an explicit human action promotes one.

The DTO returned by these endpoints is `LineContactStudentLinkDto` ([`student-links.ts:20-43`](../../../src/lib/line/student-links.ts)): link id, contact id, Wise/student identifiers, status, confidence, evidence blob, reviewer stamps, validation-assignment fields, and three live-student flags resolved against the current credit-control snapshot (`currentStudentActivated`, `currentStudentHasFutureSessions`, `currentStudentHasLivePackage`) — `null` when the student is no longer in the snapshot.

### `PATCH /api/line/contacts/[contactId]`

Updates the free-text labels on a contact and re-derives suggestions from the new student label. Handler: [`[contactId]/route.ts:15-42`](../../../src/app/api/line/contacts/[contactId]/route.ts).

**Body** (`.strict()`, [`route.ts:8-11`](../../../src/app/api/line/contacts/[contactId]/route.ts)): `linkedParentLabel` (≤200, nullable, optional), `linkedStudentLabel` (≤500, nullable, optional).

**Write semantics matter here:** `updateLineContactLabels` sets **both** columns using `input.x ?? null` ([`data.ts:366-382`](../../../src/lib/line/data.ts)), so omitting a field **clears** it rather than leaving it alone. This is a full replace, not a partial merge.

The handler then runs `ensureLineContactStudentLinkSuggestions` with the new student label ([`student-links.ts:478-545`](../../../src/lib/line/student-links.ts)), which parses dotted student codes out of the label, matches them against the current student directory, and inserts `status: "suggested"`, `confidence: 0.95` rows with `onConflictDoNothing`. Existing links are never downgraded or deleted.

**Response 200:** `{ links: LineContactStudentLinkDto[] }` (all links for the contact, ordered by status then student name).

**Status codes:** 200 · 400 invalid JSON / Zod failure · 401. There is no 404 — an unknown `contactId` updates zero rows and returns an empty `links` array.

### `GET /api/line/contacts/[contactId]/student-links`

Lists links for a contact. Handler: [`student-links/route.ts:30-40`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts).

**Not purely a read.** It calls `ensureLineContactStudentLinkSuggestions` with no label override, so the contact's stored label is re-parsed and any newly matching suggestions are **inserted** before the list is returned.

**Response 200:** `{ links: LineContactStudentLinkDto[] }`. **Status codes:** 200 · 401.

### `POST /api/line/contacts/[contactId]/student-links`

Creates (or upgrades) a **verified** link from an admin's explicit student pick. Handler: [`student-links/route.ts:42-76`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts).

**Body** (`.strict()`): `studentKey` (1–240, trimmed).

**Side effects** ([`student-links.ts:674-722`](../../../src/lib/line/student-links.ts)): resolves the student in the current credit-control snapshot — a miss is a 404. Inserts with `status: "verified"`, `confidence: 1`, `evidence.source = "admin_search"` and the reviewer stamps, using `onConflictDoUpdate` on `(contactId, studentKey)`; an existing `suggested` or `rejected` row for the same pair is therefore promoted to `verified` in place.

**Response 201:** `{ link: LineContactStudentLinkDto, links: LineContactStudentLinkDto[] }`.

**Status codes:** 201 · 400 invalid JSON / Zod failure · 401 · 404 `Current credit-control student not found`.

### `PATCH /api/line/contacts/[contactId]/student-links`

Verifies or rejects one existing link from the review workspace. Handler: [`student-links/route.ts:78-113`](../../../src/app/api/line/contacts/[contactId]/student-links/route.ts).

**Body** (`.strict()`): `action` ∈ `verify | reject`, `linkId` (uuid). The action maps to `status: "verified" | "rejected"`.

**Side effects** ([`student-links.ts:724-753`](../../../src/lib/line/student-links.ts)): a single update scoped by **both** `linkId` and `contactId`, stamping status, reviewer, `reviewedAt`, and clearing `validationNote` (the route passes no note). Unlike the link-validation variant below, this path does **not** re-run the operational-plan recompute.

**Response 200:** `{ link: LineContactStudentLinkDto, links: LineContactStudentLinkDto[] }`.

**Status codes:** 200 · 400 invalid JSON / Zod failure · 401 · 404 `Student link not found` (also when the link exists under a different contact).

### `GET /api/line/students`

Typeahead over the current credit-control student directory, backing the student picker in the LINE review, student-schedule, and student-report workspaces. Handler: [`students/route.ts:6-19`](../../../src/app/api/line/students/route.ts).

**Query:** `q`, trimmed. **Fewer than 2 characters returns `{ students: [] }` with a 200** — no error, no query.

**Response 200:** `{ students: LineStudentSearchRow[] }` — the directory row (`wiseStudentId`, `studentKey`, `studentName`, `parentName`, `activated`, `hasFutureSessions`, `hasLivePackage`) plus `matchType` ∈ `exact_code | nickname_code | student_key | student_name | parent_name` ([`student-links.ts:45-65`](../../../src/lib/line/student-links.ts)). Default limit 20, not overridable from the route. The search runs against the **active credit-control snapshot**; when there is no active snapshot, the result is empty ([`student-links.ts:653-670`](../../../src/lib/line/student-links.ts)).

**Status codes:** 200 · 401.

---

## Alias import and profile refresh

These three back the "import chat list" dialog in the LINE review workspace ([`alias-import-dialog.tsx`](../../../src/components/line-review/alias-import-dialog.tsx)).

### `POST /api/line/contacts/alias-import/preview`

Turns pasted chat-list text — or a screenshot — into proposed `(contact, aliasLabel)` rows. Writes nothing. Handler: [`preview/route.ts:30-69`](../../../src/app/api/line/contacts/alias-import/preview/route.ts).

**Request:** `multipart/form-data`, **not JSON** — a body that is not form data is a 400 `Expected multipart form data`. Fields:

| Field | Constraint |
|---|---|
| `text` | Optional string; blank counts as absent. |
| `image` | Optional `File`; ≤ **5 MB** and MIME ∈ `image/png`, `image/jpeg`, `image/webp` ([`route.ts:7-8,15-28`](../../../src/app/api/line/contacts/alias-import/preview/route.ts)). |
| `preferredContactId` | Optional string; biases auto-selection toward one contact. |

At least one of `text` / `image` is required, else 400 `Paste chat-list text or upload a screenshot`. When an image is present the route takes the image path (`source: "image"`) and text is ignored.

**Response 200:** `{ preview: { source: "text" | "image", rows: LineAliasImportPreviewRow[] } }` ([`contact-aliases.ts:59-69`](../../../src/lib/line/contact-aliases.ts)). Each row carries the extracted `aliasLabel` and raw text, `parsedCodes`, `suggestedStudents` (with `matchedCode`/`matchedField` and the three live-student flags), scored `contactCandidates`, and `autoSelectedContactId`.

**Status codes:** 200 · 400 non-form body, oversized/unsupported image, or neither input · 401 · **503** when the thrown message contains `configured` — the image path throws `AI scheduler is not configured` ([`contact-aliases.ts:365`](../../../src/lib/line/contact-aliases.ts)) because screenshot extraction goes through the OpenAI-backed extractor · 500 for any other failure ([`route.ts:66-69`](../../../src/app/api/line/contacts/alias-import/preview/route.ts)).

### `POST /api/line/contacts/alias-import/commit`

Applies chosen alias labels. Handler: [`commit/route.ts:14-40`](../../../src/app/api/line/contacts/alias-import/commit/route.ts).

**Body** (`.strict()`): `rows` — 1 to **100** entries of `{ contactId: uuid, aliasLabel: string 1–500 }`.

**Side effects** ([`contact-aliases.ts:490-507`](../../../src/lib/line/contact-aliases.ts)): per row, sets `linkedStudentLabel` to the alias and re-derives suggestions. Because it routes through `updateLineContactLabels`, committing an alias also **clears `linkedParentLabel`** on that contact. Rows are applied sequentially with no transaction — a mid-list failure leaves earlier rows applied. Blank labels are skipped silently.

**Response 200:** `{ result: { applied: Array<{ contactId, aliasLabel, suggestedLinkCount }> } }`, where `suggestedLinkCount` counts the contact's links still in `suggested` status after the write.

**Status codes:** 200 · 400 invalid JSON / Zod failure · 401. No 404 for an unknown `contactId`.

### `POST /api/line/contacts/refresh-profiles`

Re-fetches the LINE display name and picture for **every** stored contact. Handler: [`refresh-profiles/route.ts:6-14`](../../../src/app/api/line/contacts/refresh-profiles/route.ts). No body, no parameters, no scoping — the full table, ordered by `lastSeenAt DESC`, one sequential LINE profile call each ([`contact-aliases.ts:509-543`](../../../src/lib/line/contact-aliases.ts)).

**Response 200:** `{ result: { total, refreshed, missing, failed: Array<{ lineUserId, error }> } }`. A profile the LINE API does not return counts as `missing`; a thrown error is captured per contact into `failed` and never aborts the run.

**Status codes:** 200 · 401. The handler has no try/catch and declares **no `maxDuration`**, so it runs at the platform default despite being an unbounded fan-out.

---

## Followers re-anchor and backlog recovery

### `POST /api/line/contacts/followers-reanchor`

Seeds contacts from the OA's real followers list and recovers backlog identity. Handler: [`followers-reanchor/route.ts:15-41`](../../../src/app/api/line/contacts/followers-reanchor/route.ts). `export const maxDuration = 300`.

**Query:** `dryRun=true` — anything else is treated as a live run.

**Behaviour:**

| Mode | `runLineFollowersReanchor` | `runLineBacklogRecovery` |
|---|---|---|
| live (default) | runs; paginates the follower list, fetches each profile, upserts contacts with `onConflictDoNothing`, then runs the display-name suggestion path per follower ([`student-links.ts:795-852`](../../../src/lib/line/student-links.ts)) | runs with `dryRun: false`; writes `suggested` links |
| `?dryRun=true` | **skipped entirely**; `reanchor` is `null` | runs read-only, returning `dryRunMatches` |

`runLineBacklogRecovery` ([`backlog-recovery.ts:74-110`](../../../src/lib/line/backlog-recovery.ts)) fetches the full follower roster itself, batch-fetches profiles at concurrency 10, loads human-verified OA-resolver targets, and matches display names against them. It **always** inserts `status: "suggested"` — never `verified` (IDENT-02) — with ambiguous matches at `confidence: 0.60` and `evidence.ambiguous = true`, guarded by `onConflictDoNothing`.

**Known inefficiency, documented in the route itself** ([`route.ts:7-13`](../../../src/app/api/line/contacts/followers-reanchor/route.ts)): on a live run the roster is fetched twice — once sequentially by the re-anchor (~1,962 LINE calls) and once batched by the recovery. The comment names `POST /api/internal/line-backlog-recovery` as the clean production vehicle; that route is registered `manualOnly: true` with `schedule: null` in the cron registry ([`cron-registry.ts:384-396`](../../../src/lib/data-health/cron-registry.ts)) and has no `vercel.json` entry.

**Response 200:** `{ reanchor: LineFollowersReanchorResult | null, backlog: LineBacklogRecoveryResult }` — `{ followerCount, upsertedContacts, suggestionsCreated, errors[] }` ([`student-links.ts:777-782`](../../../src/lib/line/student-links.ts)) and `{ contactsScanned, targetsCount, matchedCount, insertedCount, dryRun, dryRunMatches? }` ([`backlog-recovery.ts:40-48`](../../../src/lib/line/backlog-recovery.ts)).

**Status codes:** 200 · 401 · 500 `{ error: <message> }`.

---

## Link validation

The validation worklist is a review queue over `suggested` links produced by the OA resolver, distributed round-robin to reviewers. Backing UI: [`link-validation-panel.tsx`](../../../src/components/line-review/link-validation-panel.tsx) and [`mapping-validation-workspace.tsx`](../../../src/components/line-review/mapping-validation-workspace.tsx).

`LineLinkValidationTaskDto` ([`link-validation.ts:20-54`](../../../src/lib/line/link-validation.ts)) is the link DTO plus contact context (`lineUserId`, display name, `linkedStudentLabel`), OA-resolver provenance (`lineChatUrl`, `lineOaAccountId`, `chatTitle`, `adminNoteRaw`, `relationshipRole`, `sourceRunId`, `sourceRowId`, `matchedCode`, `matchedField`), the assignment fields, and the three live-student flags.

**Phantom quarantine (D-03/IDENT-05).** Every scope except `phantom` filters out quarantined rows via `realContactCondition()`; `phantom` is the archive view and returns only quarantined rows, at any status ([`link-validation.ts:420-428`](../../../src/lib/line/link-validation.ts)).

### `GET /api/line/contacts/link-validation`

Lists tasks for a scope. Handler: [`link-validation/route.ts:23-58`](../../../src/app/api/line/contacts/link-validation/route.ts).

**Query parameters:**

| Param | Validation | Default | Notes |
|---|---|---|---|
| `scope` | `z.enum(LINE_LINK_VALIDATION_SCOPES)` = `my \| all \| unassigned \| verified \| rejected \| phantom` ([`link-validation.ts:12`](../../../src/lib/line/link-validation.ts)) | `my` | Invalid → 400 `Invalid scope`. |
| `runId` | uuid, optional | — | Restricts to links sourced from one OA-resolver run. Invalid → 400 `Invalid runId`. |
| `page` | `z.coerce.number().int().min(1)` | 1 | Invalid → 400 `Invalid page`. |
| `pageSize` | `z.coerce.number().int().min(1).max(100)` | 100 | Invalid → 400 `Invalid pageSize`. |

Scope semantics ([`link-validation.ts:430-451`](../../../src/lib/line/link-validation.ts)): `my` = `suggested` assigned to the caller's email (an actor with no email gets an empty task list, not an error); `unassigned` = `suggested` with no assignee; `all` = `suggested`; `verified` / `rejected` = that status; `phantom` = the archive. Ordering is parent name → student name → student key → contact display name.

**Response 200:** `{ tasks, reviewers, pagination }` where `reviewers` is `{ email, name, openAssignments }[]` and `pagination` is `{ page, pageSize, total, pageCount }` ([`link-validation.ts:56-77`](../../../src/lib/line/link-validation.ts)).

**Status codes:** 200 · 400 (four distinct messages above) · 401.

### `GET /api/line/contacts/link-validation/summary`

Progress tracker for validation leads. Handler: [`summary/route.ts:16-33`](../../../src/app/api/line/contacts/link-validation/summary/route.ts).

**Query:** `runId` (uuid, optional) → 400 `Invalid runId`.

**Authorization inside the payload.** This is the only per-actor gate in the LINE group: a caller whose email is not in `lineValidationLeadEmails()` gets **200** with an empty summary carrying `canViewTracker: false` ([`link-validation.ts:494-496`](../../../src/lib/line/link-validation.ts)) — not a 403.

**Response 200:** `{ summary: LineLinkValidationSummaryDto }` ([`link-validation.ts:79-93`](../../../src/lib/line/link-validation.ts)) — `canViewTracker`, `runId`, `totals` (`assigned`, `unassigned`, `verified`, `rejected`, `remaining`, `total`, `completionRate`), per-reviewer `reviewers[]`, and `recentActivity` as task DTOs. All aggregates exclude phantom rows.

**Status codes:** 200 · 400 `Invalid runId` · 401.

### `POST /api/line/contacts/link-validation/assign`

Distributes suggested links across reviewers round-robin. Handler: [`assign/route.ts:16-46`](../../../src/app/api/line/contacts/link-validation/assign/route.ts).

**Body** (`.strict()`, [`route.ts:10-14`](../../../src/app/api/line/contacts/link-validation/assign/route.ts)): `runId` (uuid, required), `reviewerEmails` (1–50 valid emails), `linkIds` (1–500 uuids, optional).

**Candidate selection** ([`link-validation.ts:667-681`](../../../src/lib/line/link-validation.ts)): non-phantom `suggested` links from that run; with `linkIds`, exactly those (de-duplicated, and **including already-assigned ones**, so this is how a reassignment happens); without `linkIds`, only currently unassigned links. `planRoundRobinValidationAssignments` seeds from each reviewer's existing open-assignment count so the distribution levels out. Writes are per-row updates in a loop — no transaction.

**Reviewer validation:** every email must exist in `admin_users`; an unknown one throws `LineLinkValidationError` → **400** `Unknown reviewer email: …`. An empty normalized list → 400 `Select at least one reviewer.`

**Response 200:** `{ assigned, tasks, reviewers, pagination }` — the count plus a fresh `scope: "all"` listing for the run.

**Status codes:** 200 · 400 invalid JSON, Zod failure, or `LineLinkValidationError` (which carries its own `status`, default 400) · 401. Any non-`LineLinkValidationError` is rethrown and surfaces as 500 ([`route.ts:40-44`](../../../src/app/api/line/contacts/link-validation/assign/route.ts)).

### `PATCH /api/line/contacts/link-validation/[linkId]`

Records a reviewer's verify/reject decision. Handler: [`[linkId]/route.ts:21-53`](../../../src/app/api/line/contacts/link-validation/[linkId]/route.ts).

**Body** (`.strict()`): `status` ∈ `verified | rejected`; `note` (≤1000, nullable, optional).

**Side effects** ([`link-validation.ts:715-801`](../../../src/lib/line/link-validation.ts)): the update is scoped by `isPhantom = false`, so a quarantined link can never be decided — it returns 404. On success it stamps status, reviewer, `reviewedAt`, and `validationNote`.

**On `verified` it also triggers an inline recompute (IDENT-06):** every `pending_review` scheduler review for that contact has its operational plan rebuilt so `matchedStudentKeys` and `writebackStatus` reflect the newly verified identity without a manual step. This is fail-isolated — per-review errors are swallowed by `.catch()` and never fail the status patch ([`link-validation.ts:749-796`](../../../src/lib/line/link-validation.ts)). It is also unbounded: a contact with many pending reviews does that many plan rebuilds inside the request.

**Response 200:** `{ task: LineLinkValidationTaskDto }`.

**Status codes:** 200 · 400 invalid JSON / Zod failure · 401 · 404 `Student link not found` (missing, phantom, or its contact row missing).

---

## OA resolver

The OA resolver pairs a server-side **run** with a browser extension that walks the LINE Official Account console. A run is created with a one-time opaque token; the extension polls the worklist and posts rows back with that token; an admin then commits the matched rows into `suggested` links. `LineOaResolverRunDto` ([`oa-resolver.ts:64-84`](../../../src/lib/line/oa-resolver.ts)) carries the run's status, `tokenPrefix`, seven per-status row counters, creator stamps, `expiresAt`, and the full `rows: LineOaResolverRowDto[]` ([`oa-resolver.ts:41-62`](../../../src/lib/line/oa-resolver.ts)).

**Token model** ([`oa-resolver.ts:540-587`](../../../src/lib/line/oa-resolver.ts)): the token is `<runId>.<32 random bytes base64url>`, returned **once** at creation and stored only as a hash; a display-safe `tokenPrefix` is persisted for the UI. TTL is **8 hours** (`TOKEN_TTL_MS`, [`oa-resolver.ts:111`](../../../src/lib/line/oa-resolver.ts)); authentication requires both a hash match and `expiresAt > now()` ([`oa-resolver.ts:592-606`](../../../src/lib/line/oa-resolver.ts)).

Row status ∈ `pending | matched | ambiguous | no_match | error | needs_manual_code | committed`; run status ∈ `active | committed | expired` ([`oa-resolver.ts:12-20`](../../../src/lib/line/oa-resolver.ts)).

### `GET /api/line/contacts/oa-resolver/runs`

Lists runs, or fetches the caller's most recent one. Handler: [`runs/route.ts:17-33`](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts).

**Query:** `latest=true` switches modes. Otherwise `limit` is parsed with `Number(... ?? "20")`, falls back to 20 when not finite, and is then clamped to **1–50** ([`oa-resolver.ts:526-539`](../../../src/lib/line/oa-resolver.ts)).

**Response 200:** `{ runs: LineOaResolverRunDto[] }` (newest first) — or, with `latest=true`, `{ run: LineOaResolverRunDto | null }`, resolved as the newest run created by the caller's email, falling back to the newest run overall when the session has no email ([`oa-resolver.ts:505-524`](../../../src/lib/line/oa-resolver.ts)). Every run is returned with its full row set.

**Status codes:** 200 · 401.

### `POST /api/line/contacts/oa-resolver/runs`

Creates a run and returns its one-time token. Handler: [`runs/route.ts:35-43`](../../../src/app/api/line/contacts/oa-resolver/runs/route.ts). No body.

**Side effects:** mints the token, inserts the run with the hash, prefix, initial counters and `expiresAt = now + 8h`, then materializes one row per student from `buildLineOaResolverWorklist(listCurrentLineStudents(db))` — students whose search code cannot be derived land as `needs_manual_code` rather than `pending`.

**Response 201:** `{ run: LineOaResolverRunDto, token: string }`. **The `token` is never retrievable again** — only `tokenPrefix` is stored in a readable form.

**Status codes:** 201 · 401.

### `GET /api/line/contacts/oa-resolver/runs/[runId]`

Fetches one run with its rows. Handler: [`[runId]/route.ts:8-21`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/route.ts). Read-only.

**Response 200:** `{ run: LineOaResolverRunDto }`. **Status codes:** 200 · 401 · 404 `Resolver run not found`.

### `GET /api/line/contacts/oa-resolver/worklist`

The extension's polling endpoint. Handler: [`worklist/route.ts:21-34`](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts).

**Auth:** public in middleware; `Authorization: Bearer <token>` parsed by a case-insensitive regex ([`route.ts:11-15`](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts)). The run id is derived from the token, so the URL carries no identifier. CORS is `Access-Control-Allow-Origin: *` with a companion `OPTIONS` returning 204.

**Response 200:** `{ worklist: { runId, expiresAt, rows } }` where each row is `{ rowId, studentKey, studentName, parentName, searchCode, searchCodes }` ([`oa-resolver.ts:91-98`](../../../src/lib/line/oa-resolver.ts)). Only rows still `pending` **and** carrying a `searchCode` are returned, ordered by student name ([`oa-resolver.ts:620-633`](../../../src/lib/line/oa-resolver.ts)); `searchCodes` adds sibling codes sharing the same parent.

**Status codes:** 200 · 401 `Invalid or expired resolver token` — the single response for a missing, malformed, unknown, or expired token.

### `POST /api/line/contacts/oa-resolver/runs/[runId]/rows`

The extension's write-back endpoint. Handler: [`rows/route.ts:52-89`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts).

**Auth:** bearer token only — **no session**. The token must authenticate *and* its run id must equal the `[runId]` path segment, else 401 ([`oa-resolver.ts:741`](../../../src/lib/line/oa-resolver.ts)). Same `*` CORS + `OPTIONS` 204 as the worklist.

**Body** (`.strict()` at all three levels, [`rows/route.ts:12-38`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route.ts)): `rows` — 1 to **50** entries of

- `rowId` (uuid) and `status` ∈ `matched | ambiguous | no_match | error` (required);
- `lineChatUrl` / `chatTitle` (≤500), `matchMode` / `captureMode` (≤80), `errorMessage` (≤1000), `evidence` (free-form record) — all optional;
- `candidates` — up to 25 objects of `{ lineChatUrl ≤500, chatTitle?, adminNoteRaw? ≤1000, relationshipRole? ∈ mom|dad|secretary|other|unknown, candidateRank? 1–100, captureMode?, matchMode?, searchCode? ≤120, siblingFanout? }`.

**Side effects** ([`oa-resolver.ts:722-865`](../../../src/lib/line/oa-resolver.ts)): each row is looked up scoped to the run and silently skipped if absent. Candidates are normalized (chat URLs parsed into `lineOaAccountId` + `lineUserId`), the first becomes the row's primary, and the full candidate list is stored in `evidence.candidateContacts`. A matched/ambiguous row also **fans out to sibling rows** sharing a normalized parent name — those rows are updated with the same candidates flagged `siblingFanout: true` and `matchMode: "sibling_fanout"`, skipping any row already `committed` ([`oa-resolver.ts:670-720`](../../../src/lib/line/oa-resolver.ts)). No contacts or links are written here; that is the commit step.

**Response 200:** `{ run: LineOaResolverRunDto }` (the refreshed run with all rows).

**Status codes:** 200 · 400 `Invalid JSON` / Zod failure · 401 `Missing resolver token` (no header) or `Invalid or expired resolver token` (bad token, or run-id mismatch). All responses carry the CORS headers.

### `POST /api/line/contacts/oa-resolver/runs/[runId]/commit`

Turns resolved rows into contacts and suggested links. Handler: [`commit/route.ts:17-49`](../../../src/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route.ts).

**Body** (`.strict()`, optional — a missing or unparseable body is treated as `{}`): `rowIds` (1–1000 uuids) and/or `selectedCandidates` (≤5000 entries of `{ rowId: uuid, lineUserId: /^U[a-fA-F0-9]{32}$/ }`).

**Selection** ([`oa-resolver.ts:948-1000`](../../../src/lib/line/oa-resolver.ts)): only rows in `matched` or `ambiguous` are eligible. `rowIds` narrows the set; if absent, the rowIds implied by `selectedCandidates` are used; if both are absent, **every eligible row in the run is committed**. `selectedCandidates` additionally filters *which* candidate contacts within a row are committed — the mechanism for disambiguating an `ambiguous` row.

**Per row:** if the student is gone from the current snapshot, or no candidate survives filtering, the row is set to `status: "error"` with a message (`Student no longer exists in current snapshot.` / `No selected valid LINE OA chat URL candidates at commit.`) and counted as `skipped`. Otherwise each surviving candidate gets a contact (get-or-create by `lineUserId`) and a **`suggested`** link carrying full provenance evidence — resolver source, chat URL, matched code/field, relationship role, candidate rank, sibling-fanout flag, run/row ids, and the live-student flags. `committed` counts **candidates**, not rows, so a two-candidate row adds 2.

Afterwards the run's counters are recomputed and the run flips to `committed` (with `committedAt`) only when no `matched` or `ambiguous` rows remain; otherwise it stays `active` and can be committed again ([`oa-resolver.ts:1083-1096`](../../../src/lib/line/oa-resolver.ts)). No transaction wraps the loop.

**Response 200:** `{ result: { committed, skipped, run: LineOaResolverRunDto } }`.

**Status codes:** 200 · 400 Zod failure (note: a malformed JSON body is *not* a 400 here — it degrades to `{}` and commits the whole run) · 401 · 404 `Resolver run not found`.

---

## Cross-references

- Feature meaning, identity rules, and the review lifecycle: [`docs/features/line-integration.md`](../../features/line-integration.md)
- Table columns for the 13 `line_*` tables declared in [`schema.ts`](../../../src/lib/db/schema.ts): [`docs/reference/database/index.md`](../database/index.md)
- The full endpoint inventory across all groups: [`docs/reference/api/index.md`](index.md)
- Cron schedules, including `/api/internal/line-credit-digest` and the manual-only `/api/internal/line-backlog-recovery`: [`docs/reference/crons.md`](../crons.md)
- Environment variables: [`docs/reference/env.md`](../env.md)

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
