# Nightly feedback reminders

## Behavior

BGScheduler owns one grouped email per canonical tutor at 22:00 Asia/Bangkok. It considers ended classes on that date and the previous two Bangkok dates, using current Wise feedback policy and deadlines. Classes ending after 22:00 enter the next night's window. Online and onsite accounts share the canonical tutor's configured primary address; conflicting fallback addresses block that tutor and remain visible.

The worker runs every 30 minutes at `/api/internal/post-class-feedback/reminder-nightly`. It validates every discovery page, stores the complete inventory, and refreshes canonical feedback in batches of 50 with a 20-minute freshness limit. A 15-minute fenced lease prevents overlapping workers; each pass has an eight-minute work budget. An unavailable class blocks its tutor's first grouped message while other tutors can proceed. Unattempted messages are regrouped when new classes arrive. After dispatch starts, content and membership stay immutable; later discoveries receive a separate recovery delivery.

**Reminder settings do not change deduction rules, approvals, existing deductions, or payout publication.** The canonical feedback refresh uses the existing evidence and assessment pipeline; reminder success is never a prerequisite for deductions.

## State and evidence

- `post_class_settings`: `reminder_mode` (`off`, `shadow`, `live`), first shadow start, prospective live activation for the current live period, and legacy trigger cutover confirmation. Changes use the existing versioned settings API and configuration audit log.
- `post_class_reminder_ledger`: unique session + reminder date + mode. Records imported and unimported classes, current discovery evidence, canonical identity, blocked contacts/source, exclusions, missed deadlines, and delivery links.
- Existing notification runs, deliveries, items, and attempts: each dispatched delivery has an immutable class list, content, recipient, stable message key, provider, receipt, and acceptance timestamp.
- A Gmail receipt establishes acceptance by the sending service. It does not prove inbox delivery or that the tutor read the email.

A complete discovery with zero eligible work is healthy. Missing pages, invalid configuration, stale feedback, unresolved identities, or unfinished imports are visible conditions. A cron pass finishing is insufficient to prove coverage: Data Health independently compares canonical sessions with ledger entries and counts unresolved outcomes.

## Settings and controls

Open **Class Feedback → Settings → Nightly feedback reminders**. Viewers can read coverage and per-class history. Access managers can preview, process due work, connect Gmail, renew authorization, and verify email and private LINE receipts, change reminder mode, and reconcile uncertain deliveries. Recipient addresses remain restricted to access managers.

- **Shadow mode** records real discovery and current policy outcomes and creates email previews. It sends no tutor reminders.
- **Build shadow preview** rehearses the most recent 22:00 window even if shadow mode was enabled after that checkpoint. Expired classes stay recorded. This action is rejected outside shadow mode.
- **Live** requires a completed current-policy shadow batch, successful Gmail renewal and confirmed email receipt within 24 hours, a verified private LINE destination, and confirmation that the legacy reminder trigger is disabled. Every activation or resume starts at the next 22:00 checkpoint, covering its normal three dates. Earlier missed nightly batches are not replayed.
- **Pause reminders** selects `off`, retaining the ledger and queue. In-flight requests may already have reached Gmail. Their uncertain outcomes remain visible and can be reconciled while paused. Resuming consolidates relevant unfinished work and records passed deadlines as missed.

Settings: `PATCH /api/post-class-feedback/settings`, with `expectedVersion` and `reminderMode`; activation can also provide a prospective `reminderActivationAt` and `legacyReminderDisabled: true`.

History/health: `GET /api/post-class-feedback/reminders?sessionId=<uuid>&tutorKey=<canonical-key>`. Access managers can request `preview=true`.

Actions: `POST /api/post-class-feedback/reminders` with `action` of `shadow_preview`, `retry`, or `resolve`. Connection controls use the separate `/email` endpoints below.

## Failure recovery

1. Check source proof and per-class reasons in the panel. Fix missing contacts through existing tutor contact controls; never guess an address.
2. Confirmed temporary rejection before acceptance can retry after 30, 90, and 180 minutes. A later Google `Retry-After` takes precedence. Permanent rejections stop automatic attempts. Access tokens renew automatically; a 401 permits one forced renewal. The deadline, current feedback, contact, policy and worker fence are checked again after renewal. All nightly attempts use Gmail; other email features retain their existing transports.
3. Network timeout, malformed acknowledgement, interrupted sending, or failure to save a receipt after acceptance is **unknown**. No automatic sender switch or resend is allowed.
4. For an unknown delivery, inspect the sending mailbox/provider evidence. Record either **accepted**, with a receipt or mailbox reference, or **verified not sent**, with an evidence note. The decision and delivery transition are atomic and audited. Verified-not-sent work must pass fresh feedback checks before a new delivery is composed.
5. Unknown outcomes remain visible across date rotation and while paused. They are listed first in searchable history.

The existing watchdog checks Gmail before 22:00 (its 21:07 and 21:37 Bangkok sweeps). It sends private LINE alerts for authorization problems, uncertain sends, and incomplete coverage after 22:30. Failure/recovery transitions and frozen alerts are stored in `post_class_reminder_line_channel` and `post_class_reminder_alerts`. The same LINE retry key is retained after a timeout, and a documented 409 replay receipt counts as acceptance. Retries back off from 30 to 180 minutes and stop before the 24-hour deduplication window. An expired or permanently rejected alert requires operator reconciliation in the connection panel. Check Kevin's private chat, then record confirmed acceptance with a receipt, or verified non-delivery with an evidence note. This closes that frozen alert and allows later alerts to proceed; it does not resend the closed message. Do not reset a retry key without checking whether it arrived.

LINE API acceptance is distinct from delivery. The launch test requires the code received in Kevin's private chat. Connection status, the last completed live batch, outstanding classes, and alert failures appear in Class Feedback and Data Health. A connection failure does not automatically switch the reminder mode off.

## Cutover checklist

1. Verify migrations `0096_nightly_feedback_reminders` and `0109_feedback_gmail` and the deployed Git revision. Keep the replacement in shadow mode until all checks pass.
2. Complete a full shadow batch. Compare discovery count/date coverage against fresh Wise evidence and review representative previews, including paired tutor accounts and missing contacts.
3. Complete the Gmail and private LINE connection steps below. Confirm the received email content and both receipt codes. Set Ohm's primary reminder address to `n.kriangdet@gmail.com`, then rerun the full shadow batch. Fresh current-policy `missed_or_no_show` evidence can exclude a class with unresolved identity; stale, unavailable, or otherwise uncertain evidence remains blocked.
4. In the legacy **Comments notifier** Apps Script project, disable only `sendMissingCommentsReminders`, then read the trigger list again. Preserve `trackFeedbackCommentState`, `runFeedbackSlaAudit`, `runDailyTeacherDeductionAdminWorkflow`, and `handleTeacherDeductionAdminEdit`. Record the verified cutover time. Project: `15R3PrAL5-kgHHjju0CHynzXRVh53lFTT3NduHgfRGL7aIBfa7IbTnUtp`.
5. Enable live reminders through the versioned API/UI. Verify the stored activation instant and next eligible checkpoint.
6. Inspect seven consecutive live nights: deployed revision, complete source proof, ledger coverage, actual accepted deliveries/receipts, valid zero-work/exclusion reasons, contacts, missed deadlines, unknown outcomes, and watchdog alert/recovery evidence. Retain dated results. A failed night resets the consecutive-night count.
7. Roll back using **Pause reminders**. Preserve the queue for recovery; do not restore the legacy trigger while live sending is enabled.

## Verification

Unit tests cover strict pagination beyond 13,603 rows, Bangkok boundaries, eligibility, tombstones, policy freshness and receipt parsing. Postgres integration tests cover durable grouping, missing/ambiguous source state, valid zero work, feedback completion during refresh, overlapping workers, retry timing, cross-midnight recovery, unknown outcomes across nights/off mode, interrupted sending, acceptance persistence failures, independent coverage gaps, bounded refresh fairness, immutable membership, prospective activation gates and deduction independence.

Production rollout and seven-night acceptance are operational evidence recorded separately from these code checks.

## Google Workspace connection

1. In Google Cloud project **BeGifted Scheduling** (`begifted-scheduling`), enable Gmail API and create a dedicated **Web application** OAuth client. Redirect URI: `https://bgscheduler.vercel.app/api/post-class-feedback/email/callback`. Do not replace the existing login/Sheets/Calendar clients.
2. Have a Workspace administrator approve that exact client as **Trusted** under Security → API controls → App access control. Record the client ID and approval. Google's [production-readiness guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview) says Workspace trust overrides the Testing app's seven-day refresh-token limitation for organization users. If the administrator cannot approve it, keep reminders in shadow and report the policy error.
3. Set production-only `POST_CLASS_GMAIL_CLIENT_ID`, `POST_CLASS_GMAIL_CLIENT_SECRET`, and, only after approval, `POST_CLASS_GMAIL_WORKSPACE_TRUSTED=true`. `AUTH_SECRET` encrypts the dedicated token row; preserve it when deploying. Never copy these credentials into previews.
4. In Class Feedback, choose **Connect Gmail**. Consent using **admin@begiftededucation.com**. The client requests only `openid`, `email` and `https://www.googleapis.com/auth/gmail.send`, offline access and PKCE. A different or unverified mailbox is rejected. Tokens are encrypted in `post_class_email_connection`; normal sign-in cannot overwrite them.
5. Choose **Verify token renewal**, then **Send test email to me**. Inspect the receiving inbox and enter its code. Google acceptance alone cannot activate reminders. Pause reminders before reconnecting or starting a new email or LINE receipt test. These actions are refused while live so they cannot invalidate the proof used by active workers. Reconnection invalidates the old receipt proof; verify the replacement grant and activate at a new prospective checkpoint. Token renewal can still be checked while live.
6. Set production-only `POST_CLASS_REMINDER_LINE_USER_ID` to Kevin's verified private `U...` identifier. The existing `LINE_CHANNEL_ACCESS_TOKEN` supplies the bot. Send the generic private LINE test and enter the received code. Group and room IDs are rejected. Changing the destination or channel token requires a new receipt test.

`GET /api/post-class-feedback/email` returns safe connection metadata. `POST` accepts `connect`, `renew`, `test`, `confirm` (code), `line_test`, or `line_confirm` (code). `line_resolve` records a blocked alert's verified outcome, expected attempt count and evidence note. All require fresh `access_manager` permission; POST also enforces same origin. The callback verifies an encrypted, actor-bound, ten-minute state cookie. Preview connections and sends are disabled.

Gmail's [sending and error rules](https://developers.google.com/workspace/gmail/api/guides/handle-errors) and the mailbox's Workspace limits still apply. A repeated MIME Message-ID does not provide Gmail duplicate protection. Inspect Gmail's Sent folder and recipient evidence manually before resolving uncertain outcomes; the app deliberately has no mailbox-reading permission.
