# LINE Integration

**Status: stable** — read paths and review tooling are live; the Wise scheduler write-path is flag-gated and still dry-run only.

## Purpose

The LINE Integration turns BeGifted's LINE Official Account into a managed inbox for scheduling operations. Parents message the OA in Thai or English; the system ingests every message, classifies whether it is a scheduling request, drafts a proposed reply, and surfaces the whole thing to admin staff in a review workspace. Nothing is ever sent back to a parent — and no Wise session is ever mutated — without an explicit human click.

It exists because LINE is where most parent scheduling conversations actually happen, and because the people triaging those conversations are non-technical admin staff. The integration gives them one queue to work, with the AI doing the reading-and-drafting and the human keeping veto power on every outbound action.

Four concerns live under this umbrella:

1. **Webhook ingest + contacts** — receive LINE events, persist messages, build a per-user contact/thread record, and pull LINE profiles.
2. **Classifier + scheduler reviews** — classify each inbound message, run the AI scheduler (or a deterministic operational planner for change requests), and create a reviewable draft. The reply/write side is gated by `ENABLE_LINE_SCHEDULER`.
3. **Link validation + OA resolver** — connect a LINE contact to a real Wise student. Includes a browser-extension-driven bulk resolver and a human round-robin validation tracker.
4. **Wise-action logs** — an append-only audit of every proposed/confirmed operational action against Wise sessions (currently always dry-run).

The primary users are the nine allowlisted admin staff. The OA-resolver also has a second, machine "user": a browser extension that authenticates with a per-run token (no Google session).

## Conceptual data model

All LINE tables are defined in `src/lib/db/schema.ts` (lines 1526–1740) — that file is the source of truth for exact columns, indexes, and enums (there is no separate database reference doc for LINE yet).

Conceptually:

- **Contacts** (`line_contacts`) — one row per LINE user, with the cached LINE profile (display name, picture, status) plus staff-applied labels. Uniquely keyed by LINE user id.
- **Threads** (`line_threads`) — one conversation per contact, optionally bridged to an AI-scheduler conversation so LINE and website chat share one timeline. Also uniquely keyed by LINE user id.
- **Messages** (`line_messages`) — every inbound and outbound message, including LINE webhook dedupe keys, retraction state, and the classifier verdict (category, confidence, summary, payload) plus a separate human "classification reviewed" verdict used for accuracy metrics.
- **Contact↔student links** (`line_contact_student_links`) — the mapping from a LINE contact to a Wise student, with a `suggested → verified | rejected` lifecycle, a confidence score, free-form evidence, and validation-assignment fields. Uniquely keyed per (contact, student).
- **Scheduler reviews** (`line_scheduler_reviews`) — the unit of human review for a scheduling message: the classifier verdict, the inferred operational intent, the proposed parent draft, candidate Wise sessions, proposed Wise actions, the send result, and the reviewer's decision. One review per inbound message.
- **Wise-action logs** (`line_wise_action_logs`) — append-only audit rows for each proposed/confirmed Wise session action, carrying a `dryRun` flag and request/response payloads.
- **OA-resolver runs + rows** (`line_oa_resolver_runs`, `line_oa_resolver_rows`) — a token-scoped bulk job (8-hour TTL) that hands a browser extension a worklist of students-needing-a-LINE-contact and collects back chat-URL candidates per row.

The integration **reads** but does not own several neighbouring tables: the credit-control snapshot (`credit_control_students`, `credit_control_packages`, `credit_control_sessions`) supplies the current student directory and future sessions; the in-memory search index supplies tutor candidates; and the AI-scheduler tables (`ai_scheduler_conversations`, `ai_scheduler_messages`, `ai_scheduler_runs`, `ai_scheduler_feedback`) store the conversation/run/feedback that a LINE scheduling message generates.

## API surface

All LINE endpoints live under `src/app/api/line/` — the route handlers there are the source of truth for exact request/response contracts (there is no separate API reference doc for LINE yet). Narrative summary:

**Ingest (public)**
- `POST /api/line/webhook` — LINE event receiver; signature-verified, schedules background processing.

**Reviews & messages (session-auth)**
- `GET /api/line/scheduler-reviews` — list reviews (filterable by status/intent) plus optional analytics.
- `GET /api/line/scheduler-reviews/false-negatives` — the "missed message" queue: inbound messages the AI did not escalate.
- `PATCH /api/line/scheduler-reviews/{reviewId}` — approve-and-send, accept-no-send, reject, or dismiss a review.
- `GET /api/line/scheduler-reviews/{reviewId}/context` — merged LINE + website chat timeline for the review.
- `POST /api/line/scheduler-reviews/{reviewId}/operational-plan` — recompute the deterministic operational plan for a change request.
- `GET|POST /api/line/scheduler-reviews/{reviewId}/wise-actions` — list / confirm proposed Wise session actions (the gated write-path).
- `POST /api/line/messages/{messageId}/promote` — promote a missed message into a pending review.
- `PATCH /api/line/messages/{messageId}/classification-feedback` — record the human-corrected classification.

**Contacts, links & directory (session-auth)**
- `PATCH /api/line/contacts/{contactId}` — update a contact's parent/student labels; re-derives link suggestions and returns the contact's student links. (No GET on this route.)
- `GET|POST|PATCH /api/line/contacts/{contactId}/student-links` — read a contact's student links (GET, with suggestion backfill), create a verified link (POST), or verify/reject a link (PATCH).
- `GET /api/line/students` — search the current Wise student directory.
- `POST /api/line/contacts/refresh-profiles` — re-pull LINE profiles for all contacts.
- `POST /api/line/contacts/alias-import/preview`, `.../alias-import/commit` — parse a LINE-desktop chat-list paste/screenshot into contact↔student suggestions and apply them.
- `GET /api/line/contacts/link-validation`, `.../summary`, `POST .../assign`, `PATCH .../{linkId}` — the human validation tracker (list, lead-only summary, round-robin assignment, verify/reject).

**OA resolver**
- `GET|POST /api/line/contacts/oa-resolver/runs`, `GET .../runs/{runId}`, `POST .../runs/{runId}/commit` — create/list/read a resolver run and commit matched rows into links (session-auth).
- `GET /api/line/contacts/oa-resolver/worklist`, `POST .../runs/{runId}/rows` — **token-auth, public, CORS-enabled** endpoints the browser extension calls to pull its worklist and post back chat-URL candidates.

> The token-auth resolver routes and the webhook are the only LINE endpoints exempted from Google session auth in `src/middleware.ts:10-13`. Everything else is gated by the middleware and re-checks `auth()` in-handler.

## UI

- **Page**: `src/app/(app)/line-review/page.tsx` (route `/line-review`, nav label "LINE AI Review" — `src/components/layout/app-nav.tsx:18`). It is a thin server shell that redirects unauthenticated users to `/login` and renders the client workspace inside a Suspense boundary.
- **Workspace**: `src/components/line-review/line-review-workspace.tsx` is the orchestrator. It owns all state and fetches, and exposes two top-level tabs (`line-review-workspace.tsx:38-41`): **AI Review Queue** and **Mapping Validation**.

Key components in `src/components/line-review/`:
- `review-queue.tsx` — the pending-review list with intent filter.
- `case-header.tsx`, `chat-evidence-panel.tsx` — the selected review's header and the merged LINE/website chat timeline.
- `resolution-board.tsx`, `reply-dock.tsx` — candidate-session / Wise-action board and the parent-reply editor. The dock surfaces exactly three buttons: Reject, "Accept handled" (the `accept_no_send` action), and "Approve & send" (`reply-dock.tsx:59-89`). The `dismiss` review action exists only at the API/service layer (`PATCH /api/line/scheduler-reviews/{reviewId}` → `dismissLineSchedulerReview`, `src/lib/line/review-service.ts:578`); it is not a reply-dock control.
- `student-link-command.tsx` — searchable student picker for verifying a contact↔student link.
- `alias-import-dialog.tsx` (+ `alias-import-batch.ts`) — the paste/screenshot alias-import flow.
- `oa-resolver-dialog.tsx` — create/monitor an OA-resolver run and surface the extension token.
- `mapping-validation-workspace.tsx`, `link-validation-panel.tsx` — the validation tracker tab.
- `signals-dialog.tsx`, `status-badges.tsx`, `types.ts`, `utils.ts` — analytics drawer, badges, shared DTO types, and fetch/serialization helpers.

## Data flow

A parent message travels from LINE to a human-reviewed draft like this:

1. **Webhook** (`src/app/api/line/webhook/route.ts`) — verifies the `x-line-signature` HMAC, then hands the raw body to `handleLineWebhookPost` (`src/lib/line/webhook.ts`). On success it schedules per-message processing via Next's `after()` so the HTTP response returns immediately.
2. **Ingest** (`recordLineWebhookPayload`, `src/lib/line/data.ts:403`) — walks the event array, upserts the contact + thread, and inserts text messages (deduped on `webhookEventId`). `unsend` events flip `isRetracted` instead of inserting; non-user / non-text events are ignored and counted.
3. **Processing** (`processLineMessageForScheduler`, `src/lib/line/review-service.ts:126`) — pulls the LINE profile, ensures student-link suggestions, classifies the message, and persists the verdict. Non-scheduling / unclear messages stop here (no review).
4. **Classify** (`classifyLineSchedulerMessage`, `src/lib/line/classifier.ts:89`) — calls OpenAI with a strict JSON schema and recent thread context, returning `scheduling_request | scheduling_change | non_scheduling | unclear`.
5. **Plan & draft** — change requests run the deterministic operational planner (`buildLineOperationalReviewPlan`, `src/lib/line/operational.ts:584`) to infer intent and candidate sessions; new requests run the AI scheduler turn. Either way a `line_scheduler_reviews` row is created in `pending_review`.
6. **Human review** (`/line-review`) — staff approve/send, accept-no-send, reject, or dismiss. `approveLineSchedulerReview` (`review-service.ts:426`) is the only path that calls the LINE push API.
7. **Wise actions** — confirming an operational action calls `confirmLineWiseAction` (`src/lib/wise/operations.ts:26`), which records a dry-run audit log; no Wise mutation is sent.

```mermaid
flowchart TD
    P[Parent on LINE OA] -->|event| WH["POST /api/line/webhook<br/>(signature verified)"]
    WH -->|recordLineWebhookPayload| MSG[(line_messages<br/>+ contacts + threads)]
    WH -.->|after(): background| PROC[processLineMessageForScheduler]
    PROC --> CLS{classifyLineSchedulerMessage}
    CLS -->|non_scheduling / unclear| STOP[no review · maybe false-negative queue]
    CLS -->|scheduling_request| AISCHED[AI scheduler turn]
    CLS -->|scheduling_change| OPS[buildLineOperationalReviewPlan<br/>deterministic intent + candidates]
    AISCHED --> REV[(line_scheduler_reviews<br/>pending_review)]
    OPS --> REV
    REV --> UI[/line-review workspace/]
    UI -->|approve_send| PUSH["pushLineTextMessage → LINE<br/>(gated by ENABLE_LINE_SCHEDULER)"]
    UI -->|confirm wise action| WACT["confirmLineWiseAction<br/>(dry-run only)"]
    WACT --> LOG[(line_wise_action_logs)]
    PUSH --> OUT[(outbound line_messages)]
```

A separate, parallel flow links contacts to students: the **OA resolver** (`src/lib/line/oa-resolver.ts`) builds a worklist from the credit-control student directory, a browser extension fetches it by token and posts back LINE chat-URL candidates, an admin commits matches into `suggested` links, and the **validation tracker** (`src/lib/line/link-validation.ts`) round-robins those suggestions to reviewers who verify or reject them.

## Business rules & edge cases

**Fail-closed on sending and writing.**
- The webhook returns `503` unless `ENABLE_LINE_SCHEDULER` is satisfied (`src/app/api/line/webhook/route.ts:10`). `lineSchedulerEnabled()` is true only when the flag is not the string `"false"` **and** both `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` are set (`src/lib/line/client.ts:19-23`). This is the master gate on the entire write-path: with it off, nothing ingests and nothing sends.
- A reply can only be sent from a `pending_review` row, and only after a verified student link exists or the admin explicitly checks "unmatched" — `approveLineSchedulerReview` throws otherwise (`src/lib/line/review-service.ts:436-441`). Empty final text is rejected (`review-service.ts:444`).
- The Wise session write-path is **doubly gated and still inert**: even when `WISE_SESSION_OPERATIONS_VERIFIED === "true"`, `confirmLineWiseAction` only writes a `dry_run` audit row and sends no Wise mutation (`src/lib/wise/operations.ts:71-89`). With the flag off it writes a `manual_required` log instead (`operations.ts:49-69`). The proposed actions themselves carry `dryRun: true` and an `endpointVerified` flag mirroring the env var (`src/lib/line/operational.ts:481-485`).

**Signature verification is constant-time and fail-closed.** `verifyLineSignature` returns false when the secret or signature is missing, compares lengths first, then uses `timingSafeEqual` (`src/lib/line/signature.ts:10-19`).

**Webhook idempotency.** Messages dedupe on `webhookEventId` via `onConflictDoNothing`; a conflict increments `duplicateEvents` rather than creating a duplicate (`src/lib/line/data.ts:473-477`). Reviews dedupe on `inboundMessageId` (`data.ts:734`), so re-processing a message never creates a second review.

**Classifier fail-open into the missed-message queue.** The false-negative queue surfaces every `unclear` message, plus `non_scheduling` messages whose confidence is below `LINE_FALSE_NEGATIVE_CONFIDENCE_THRESHOLD = 0.75` — and a NULL confidence counts as "show" (`src/lib/line/data.ts:561-571`, threshold at `src/lib/line/classifier.ts:24`). Messages drop out of the queue once an admin records classification feedback or promotes them. "Fail-open" here means the queue only ever *surfaces* messages for a human glance; it never auto-acts.

**Operational intent is deterministic, not AI.** For change requests, intent (`cancel_one_off`, `pause_until`, `resume`, `reschedule`, `unclear_change`) is inferred by Thai/English regex over the message text, and dates/times are parsed with a Thai-month table and Buddhist-era year normalization (`src/lib/line/operational.ts:106-307`). When a required field is missing (e.g. a pause with no resume date, or a cancel with no target date) the planner records an `issues` entry and refuses to mark the action ready (`operational.ts:286-291`, `674`).

**Student-link selection is conservative.** With multiple verified children on one contact and no clear mention in the message, the planner selects none and raises an issue rather than guessing (`src/lib/line/operational.ts:319-334`). An operational action is only "ready" when exactly one candidate session scores ≥ 60 with no outstanding issues (`operational.ts:649`).

**Resolver tokens.** Runs are authenticated by a hashed bearer token with an 8-hour TTL (`TOKEN_TTL_MS`, `src/lib/line/oa-resolver.ts:111`); only a SHA-256 hash and a short prefix are stored (`oa-resolver.ts:560-571`). Chat URLs are accepted only from `https://chat.line.biz/...` with both ids matching the `U[hex]{32}` LINE-user pattern (`oa-resolver.ts:112,344-360`). Matches found for one student fan out to siblings sharing a normalized parent group (`oa-resolver.ts:670-720`). A matched/ambiguous row with no valid candidate URL is downgraded to `error` (`oa-resolver.ts:762-776`), and committed links default to `suggested` (never auto-verified) unless already verified (`oa-resolver.ts:909`).

**Validation tracker is lead-gated and round-robin.** The cross-reviewer summary is only returned to lead emails — `LINE_VALIDATION_LEAD_EMAILS` or the two hard-coded defaults (`src/lib/line/link-validation.ts:112-170`, `getLineLinkValidationSummary` at `385`). Assignment balances open workload across reviewers (`planRoundRobinValidationAssignments`, `link-validation.ts:260-283`). The tracker only ever touches links whose evidence `source = 'line_oa_resolver'` (`link-validation.ts:182-188`).

**Identity/role parsing is best-effort but typed.** Relationship role (mom/dad/secretary/other/unknown) is derived from explicit field → admin note → chat title, in that order, via bilingual regex (`src/lib/line/oa-resolver.ts:370-397`).

**Destructive cleanup is double-guarded.** `deleteLineTestData` refuses to run unless `confirm === "delete-line-test-data"` and supports a `dryRun` plan (`src/lib/line/test-data-cleanup.ts:211-227`).

## Tests

Library unit tests live in `src/lib/line/__tests__/` and cover: webhook ingest/dedupe/retraction (`webhook.test.ts`), signature verification (`signature.test.ts`), the LINE HTTP client incl. push retry-key 409 handling (`client.test.ts`), classifier confidence banding (`confidence.test.ts`), the review service end-to-end incl. promote/approve/reject paths (`review-service.test.ts`), deterministic operational planning (`operational.test.ts`), student-code parsing and matching (`student-links.test.ts`, `contact-aliases.test.ts`), link validation incl. round-robin and lead gating (`link-validation.test.ts`), the OA resolver and its extension-candidate normalization (`oa-resolver.test.ts`, `oa-resolver-extension-candidates.test.ts`), and the test-data cleanup planner (`test-data-cleanup.test.ts`).

Route-handler tests sit beside their routes under `src/app/api/line/**/__tests__/` (14 files), covering alias-import commit, link-validation list/summary/assign/`[linkId]`, OA-resolver runs/rows/worklist/commit, refresh-profiles, message promote and classification-feedback, the false-negatives queue, and the review context endpoint.

Component logic is tested in `src/components/line-review/__tests__/` (`line-review-workspace.test.ts`, `alias-import-batch.test.ts`).

## Open questions

- **The Wise session write-path is intentionally inert even when "verified."** `confirmLineWiseAction` records only a dry-run and never mutates Wise, with a code comment that the endpoint contract is unverified (`src/lib/wise/operations.ts:71-72`). Is this the intended permanent v1 behavior, or a placeholder awaiting the verified Wise cancel/reschedule request shape? It also has **no dedicated unit test** (the only references are the function itself and its route), unlike the rest of the subsystem.
- **`test-data-cleanup.ts` is script-only, with no API route.** It is wired to the one-off script `scripts/delete-line-test-data.ts` (`scripts/delete-line-test-data.ts:3-6,40`), which gates the destructive run behind a `CONFIRM_DELETE_LINE_TEST_DATA` env var and supports `--dry-run`. It is intentionally *not* reachable from any API route under `src/app`. Confirm this manual-script-only exposure is the intended access model (i.e. it should never gain an HTTP entry point).
- **Two LINE write-path flags with overlapping intent.** `ENABLE_LINE_SCHEDULER` gates ingest+send while `WISE_SESSION_OPERATIONS_VERIFIED` gates the (still dry-run) Wise action path. Confirm the intended operational matrix — e.g. is it ever expected to run with the scheduler enabled but Wise operations "verified," and what real effect that combination should have.
- **Hard-coded validation leads.** `DEFAULT_LINE_VALIDATION_LEAD_EMAILS` embeds two personal Gmail addresses as the fallback when `LINE_VALIDATION_LEAD_EMAILS` is unset (`src/lib/line/link-validation.ts:112-115`). Is relying on that fallback in production intended, or should the env var always be set?
- **"stable" maturity vs. dry-run reality.** The badge was supplied as authoritative. Worth a human confirming that "stable" is the right label given the Wise write-path never actually writes — the read/classify/review/send-reply loop is the part that is production-stable.

_Verified against HEAD + uncommitted WIP on 2026-05-31._
