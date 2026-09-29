# API — Feedback Autowriter

Four method/path endpoints. Meaning, rules and the state machine live in [the feature page](../../features/feedback-autowriter.md); day-to-day operation in [the runbook](../../operations/feedback-autowriter.md).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/wise/webhook` | public route + shared-secret header | Receives Wise webhook deliveries; hands lesson-ended events to the autowriter after answering. |
| `GET` | `/api/internal/feedback-autowriter` | cron secret | Backstop sweep, `8,22,38,52 * * * *`. Also runnable by the owner from Data Health. |
| `GET` | `/api/feedback-autowriter` | admin session (page scope via the proxy) | Dashboard payload. |
| `POST` | `/api/feedback-autowriter/control` | owner only (`requireClassroomOperationsOwner`) | Mode, pause/resume and per-tutor switches. |

## `POST /api/wise/webhook`

[`src/app/api/wise/webhook/route.ts`](../../../src/app/api/wise/webhook/route.ts), `maxDuration = 800`.

1. **Auth.** The header named by `WISE_WEBHOOK_AUTH_HEADER` (default `authorization`) must equal `WISE_WEBHOOK_SECRET`, bare or as `Bearer <secret>`, compared in constant time. An unset secret rejects everything. A rejected delivery logs the request's header **names** only.
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

[`src/app/api/feedback-autowriter/route.ts`](../../../src/app/api/feedback-autowriter/route.ts). Query `days` = `1`, `7` or `30` (anything else falls back to `7`). Returns the `AutowriterDashboard` built by [`loadAutowriterDashboard`](../../../src/lib/feedback-autowriter/dashboard.ts): control row, totals by state, class-end-to-POST latency, cost by model and by Bangkok day, per-tutor rows, the 60 most recent classes with the written fields, and the last 24 hours of webhook deliveries.

**Responses:** `200` · `401` · `500 { error }`.

## `POST /api/feedback-autowriter/control`

[`src/app/api/feedback-autowriter/control/route.ts`](../../../src/app/api/feedback-autowriter/control/route.ts). Same effect as the CLI switches in [the runbook](../../operations/feedback-autowriter.md).

| Body | Effect |
|---|---|
| `{ "action": "mode", "mode": "off" \| "shadow" \| "live" }` | Sets the mode. Going `live` re-queues shadow drafts whose deadline is still outside the margin and returns their count as `requeued`. |
| `{ "action": "pause", "reason": "…" }` | Sets the global halt (`halt_reason` = `paused by <email>: <reason>`). |
| `{ "action": "resume" }` | Clears the halt. |
| `{ "action": "tutor", "wiseUserId": "<24 hex>", "enabled": boolean }` | Adds or removes a roster tutor from `disabled_tutors`; non-roster ids get `400`. |

**Responses:** `200 { ok: true, requeued, control }` · `400` (bad JSON, bad body, non-roster tutor) · `401` · `403 "Only Kevin can change the feedback autowriter."` · `500`.
