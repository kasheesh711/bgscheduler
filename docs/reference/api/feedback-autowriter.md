# API — Feedback Autowriter

Nine method/path endpoints. Meaning, rules and the state machine live in [the feature page](../../features/feedback-autowriter.md); day-to-day operation in [the runbook](../../operations/feedback-autowriter.md).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/wise/webhook` | public route + shared-secret header | Receives Wise webhook deliveries; hands lesson-ended events to the autowriter after answering. |
| `GET` | `/api/internal/feedback-autowriter` | cron secret | Backstop sweep, `8,22,38,52 * * * *`. Also runnable by the owner from Data Health. |
| `GET` | `/api/feedback-autowriter` | admin session (page scope via the proxy) | Dashboard payload. |
| `POST` | `/api/feedback-autowriter/control` | owner only (`requireClassroomOperationsOwner`) | Mode, pause/resume and per-tutor switches. |
| `GET` | `/api/internal/feedback-autowriter/review` | cron secret | Operating-loop review job, `27 * * * *`. Also runnable by the owner from Data Health. |
| `GET` | `/api/feedback-autowriter/review` | admin session (page scope via the proxy) | Quality and review payload: the gate, coverage, daily and per-tutor rows, the review queue, incidents. |
| `GET` | `/api/feedback-autowriter/trends` | admin session (page scope via the proxy) | Daily trend series for a range and a tutor. |
| `POST` | `/api/feedback-autowriter/verdicts` | owner only (`requireClassroomOperationsOwner`) | Records a verdict on a class's first shot. |
| `POST` | `/api/feedback-autowriter/incidents` | owner only (`requireClassroomOperationsOwner`) | Acknowledges an incident (stops its pushes; an undelivered critical one stops keeping the review job red). |

## `POST /api/wise/webhook`

[`src/app/api/wise/webhook/route.ts`](../../../src/app/api/wise/webhook/route.ts), `maxDuration = 800`.

1. **Auth.** A header must carry `WISE_WEBHOOK_SECRET`, bare or as `Bearer <secret>`, compared in constant time. Wise does not name its header: with `WISE_WEBHOOK_AUTH_HEADER` unset every header is checked and the first match logs `key arrived in header "<name>"` so it can be pinned; once pinned, only that header counts. An unset secret rejects everything. A rejected delivery logs the request's header **names** only.
2. **Size.** Bodies over 1 MiB (`WISE_WEBHOOK_MAX_BODY_BYTES`) get `413`, checked on `content-length` and again on the bytes read.
3. **Kill switch.** `WISE_WEBHOOKS_ENABLED !== "true"` answers `200 { ok: true, ignored: true }` after auth and stores nothing; the backstop sweep still covers every class.
4. **Store.** Every authenticated delivery is inserted into `wise_webhook_events` keyed by the SHA-256 of the raw body (`ON CONFLICT DO NOTHING`), so a Wise retry of the same body is a duplicate.
5. **Dispatch.** A first-seen `MeetingEndedEvent`, `AttendanceComputedEvent` or `RecordingCompletedEvent` carrying a session id runs `processWebhookTrigger` inside `after()` (740 s budget): the session is re-read from Wise (the body is only a hint), the readiness gates are re-checked every 20 s for up to 3 minutes while the AI summary is still missing, and the webhook bypasses the 10-minute retry wait. The outcome is written back to the event row (`outcome`, `processed_at`).

**Responses:** `200 { ok: true, duplicate: boolean }` · `200 { ok: true, ignored: true }` · `401` · `413`. A database failure surfaces as `500`, which Wise retries.

## `GET /api/internal/feedback-autowriter`

[`src/app/api/internal/feedback-autowriter/route.ts`](../../../src/app/api/internal/feedback-autowriter/route.ts), `maxDuration = 800`, wrapped in `withCronInvocationAudit({ jobKey: "feedback_autowriter" })`.

Runs `runAutowriterJob()` with a 740-second budget: reconcile `posting`/`awaiting_event` rows, expire pending rows inside the deadline margin, shortlist roster classes from `post_class_sessions`, process due rows, then send one alert digest.

**Responses:** `200` with a `SweepResult` (`ok`, `mode`, `halted`, `processed`, `reconciled`, `alertsSent`, `infraErrors`, optional `skipped` + `reason`) · `200 { ok: true, skipped: true, reason }` when `FEEDBACK_AUTOWRITER_ENABLED` is not `true` · `401` · `503` when the run was halted, hit an infrastructure error, or could not deliver its alert digest.

## `GET /api/feedback-autowriter`

[`src/app/api/feedback-autowriter/route.ts`](../../../src/app/api/feedback-autowriter/route.ts). Query `days` = `1`, `7` or `30` (anything else falls back to `7`; the page asks for `7`). Returns the `AutowriterDashboard` built by [`loadAutowriterDashboard`](../../../src/lib/feedback-autowriter/dashboard.ts):

- `control` (mode, halt, switched-off accounts) and `system` (writer, fallback writer and judge with their efforts, the evidence switches as they act, prompt and judge versions, commit);
- `today`: the classes ending today in Bangkok by where they stand;
- `holds`: every class in state `held`, whatever its age (up to 500 — past that, those that may still wait are kept first: no deadline, or one ahead or passed less than 24 hours ago — soonest deadline first), each with its reason, deadline, alert time, whether a draft is stored, and `resolvedBy` — `"tutor_wrote"` while `post_class_sessions.latest_feedback_version_id` points at a teacher version (the class's current teacher submission holds text in topics, performance or improvement, as the Class Feedback collection last read it; a person's, since the autowriter never posts to a held class), else `null` (a blank form, a billing correction, homework alone, or text taken out again does not count). The draft's text is not in this list;
- `failedPosts`: the window's classes in `verify_failed`, `unknown_outcome` or `rejected`;
- for the window: totals by state, class-end-to-POST latency (overall and by evidence route), transcript-first fallbacks by cause, cost by model and by Bangkok day, per-tutor rows, and the 60 most recent classes with the written fields and the judge's problems;
- the last 24 hours of webhook deliveries.

In-person classes are left out everywhere.

**Responses:** `200` · `401` · `500 { error }`.

## `POST /api/feedback-autowriter/control`

[`src/app/api/feedback-autowriter/control/route.ts`](../../../src/app/api/feedback-autowriter/control/route.ts). Same effect as the CLI switches in [the runbook](../../operations/feedback-autowriter.md).

| Body | Effect |
|---|---|
| `{ "action": "mode", "mode": "off" \| "shadow" \| "live" }` | Sets the mode. Going `live` re-queues shadow drafts whose deadline is still outside the margin and returns their count as `requeued`. |
| `{ "action": "pause", "reason": "…" }` | Sets the global halt (`halt_reason` = `paused by <email>: <reason>`). |
| `{ "action": "resume" }` | Clears the halt. |
| `{ "action": "tutor", "wiseUserIds": ["<24 hex>", …], "enabled": boolean }` | Adds or removes roster accounts (1 to 20; the dashboard sends every account of one tutor) from `disabled_tutors`; a non-roster id gets `400`. |

**Responses:** `200 { ok: true, requeued, control }` · `400` (bad JSON, bad body, non-roster tutor) · `401` · `403 "Only Kevin can change the feedback autowriter."` · `500`.

## `GET /api/internal/feedback-autowriter/review`

[`src/app/api/internal/feedback-autowriter/review/route.ts`](../../../src/app/api/internal/feedback-autowriter/review/route.ts), `maxDuration = 300`, wrapped in `withCronInvocationAudit({ jobKey: "feedback_autowriter_review" })`.

Runs `runAutowriterReviewJob()` ([`review-job.ts`](../../../src/lib/feedback-autowriter/review-job.ts)): pushes of incidents already waiting, the activity-mirror check, first-shot snapshots, fix events (every autowriter class; none without `WISE_USER_ID`), review rows, verification and fix flags, review counts, the metrics of every date in the gate window, the daily gate row (only when every earlier step succeeded and the Wise activity mirror, checked before the run read it, synced within 30 minutes without stopping at its page cap) and the pushes of this run's incidents (no push is started that the 300 s budget could cut off). Reads our database only; never calls Wise.

**Responses:** `200` with a `ReviewJobResult` (`ok`, `syncRunId`, `firstShots`, `fixEvents`, `reviewsCreated`, `verificationFlags`, `flags`, `reviewCountsUpdated`, `metricRows`, `dailyGate`, `dailyGateSkipped` — why a due daily row was not written, `incidents`, `undeliveredCritical`, `stepErrors`) · `200 { ok: true, skipped: true, reason }` when disabled, on a preview deployment, or while another run holds the lock · `401` · `503` when a step failed, `WISE_USER_ID` is missing, or a critical incident is undelivered and not acknowledged.

## `GET /api/feedback-autowriter/review`

[`src/app/api/feedback-autowriter/review/route.ts`](../../../src/app/api/feedback-autowriter/review/route.ts). Returns the `AutowriterReview` built by [`loadAutowriterReview`](../../../src/lib/feedback-autowriter/review-data.ts) (`available: true`): the live gate over the rolling 14 Bangkok days, computed by the same SQL as the nightly row (`loadGateFacts`), with `blockedUntil` (the latest critical class's Bangkok date plus 14 days, or `null`); coverage breakdown; fix-round histogram; daily rows (and `lookback`: the stored all-tutors reviewed / accurate / posted / eligible counts of the six dates before the window, only for the 7-day values of its first dates); per-tutor rows (with each tutor's critical verdicts in the window); the review queue — every flagged and every unreviewed required class, then the latest others up to 300 — with exact `queueTotals`, each item carrying the first shot (and its outcome), current text, word diff, measured saves (`counted` or listed after the Approve), corrections, verdict log and open flags (with ids, for the verdict's pins); and incidents (every unacknowledged critical one first, whatever its age and whether its alert went out, never capped; then the latest 100 others of the last 30 days). In-person classes are left out.

**Responses:** `200` · `200 { available: false, reason: "review_tables_missing" }` before migration 0101 (an optional table, not a failure) · `401` · `403` (not an admin) · `500 { error }` for any other failure (logged by error name and SQLSTATE only).

## `GET /api/feedback-autowriter/trends`

[`src/app/api/feedback-autowriter/trends/route.ts`](../../../src/app/api/feedback-autowriter/trends/route.ts). Query:

| Parameter | Rule |
|---|---|
| `days` | `14`, `30` or `90`; default `14` |
| `tutor` | `*` for all tutors (the default), or a roster tutor's key (the `tutorKey` of the dashboard's tutor rows) |

Returns the `AutowriterTrends` built by [`loadAutowriterTrends`](../../../src/lib/feedback-autowriter/trends.ts): the `range` (Bangkok dates, ending today), `since` (the first date with any data among those read, or `null`), one entry per date in `days` — reviewed and accurate counts, accuracy, its pooled 7-day value and the rolling 14-day Wilson lower bound, critical verdicts, posted and eligible counts with coverage and its 7-day value, the median minutes from class end to the POST claim and its 7-day value, cost and cost per posted class, classes posted from the summary and from the transcript with the 7-day transcript share, and posts by writer — and `totals` over the range (with p90 minutes and the held classes by reason category). A date without data has `null` ratios, never zeros. Every date is the Bangkok date of the class's scheduled end. Coverage comes from the stored daily metrics; accuracy is recomputed from the review rows and their current verdicts. Reads our database only.

**Responses:** `200` · `200 { available: false, reason: "review_tables_missing" }` before migration 0101 (SQLSTATE 42P01: an optional table, not a failure, as for the review route; the page then says the quality data is not available yet) · `400` (a range other than 14, 30 or 90, or a key that is not a roster tutor's) · `401` · `403` (not an admin) · `500 { error }` for any other failure (logged by error name and SQLSTATE only).

## `POST /api/feedback-autowriter/verdicts`

[`src/app/api/feedback-autowriter/verdicts/route.ts`](../../../src/app/api/feedback-autowriter/verdicts/route.ts). Strict body:

| Field | Rule |
|---|---|
| `wiseSessionId` | 24 hex characters; the class must have a review row |
| `fieldsSha256` | 64 hex characters: the first shot's `fields_sha256` the owner was shown (a mismatch is `409`) |
| `currentVerdictId` | UUID or `null`: the class's current verdict as the page showed it (another one now is `409`) |
| `seenFlagIds` | up to 100 UUIDs: the class's open flags as the page showed them (any other open flag now is `409`); only these are resolved |
| `verdict` | `approve` or `needs_fix` |
| `severity` | `cosmetic` \| `factual` (the owner's "major": a real fix) \| `critical` — required for `needs_fix`, absent for `approve` |
| `criticalCategory` | `wrong_person` \| `billing_status` \| `invented_content` \| `should_not_have_posted` — required exactly when `severity` is `critical` |
| `note` | optional, up to 2,000 characters; required for a downgrade |
| `confirmDowngrade` | optional `true`: the owner confirms replacing a harsher judgement with a milder verdict — a critical current verdict or open critical flag with anything non-critical, or a major (`factual`) verdict with cosmetic or Approve |

One transaction appends the verdict (superseding the current one), sets `reviews.current_verdict_id`, resolves the flags the page showed, stamps `metadata.triagedAt` on the `verified` session row for an accurate verdict only (Approve or cosmetic — ending the Soniox review window; a major or critical verdict removes it again; `updated_at` is left alone), records `downgraded_from`, and, for a critical verdict, queues a critical incident.

**Responses:** `200 { ok: true, verdictId, supersedesId, resolvedFlags, criticalIncident, downgradedFrom }` · `400` (bad JSON, body or shape; a downgrade without a note) · `401` · `403 "Only Kevin can record autowriter verdicts or acknowledge incidents."` · `404` (no review row) · `409` (stale page: another first shot, current verdict or set of open flags; or a downgrade not confirmed) · `500`.

## `POST /api/feedback-autowriter/incidents`

[`src/app/api/feedback-autowriter/incidents/route.ts`](../../../src/app/api/feedback-autowriter/incidents/route.ts). Strict body `{ "action": "acknowledge", "incidentId": "<uuid>" }`. Sets `acknowledged_at` / `acknowledged_by` once (idempotent): the outbox stops pushing it, and an undelivered critical incident no longer keeps the review job red.

**Responses:** `200 { ok: true, id, acknowledgedAt, acknowledgedBy }` · `400` · `401` · `403` · `404` (no such incident) · `500`.
