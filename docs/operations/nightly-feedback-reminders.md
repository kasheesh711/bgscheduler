# Nightly feedback reminders

## Behavior

BGScheduler owns one grouped email per canonical tutor at 22:00 Asia/Bangkok. It considers ended classes on that date and the previous two Bangkok dates, using current Wise feedback policy and deadlines. Classes ending after 22:00 enter the next night's window. Online and onsite accounts share the canonical tutor's configured primary address; conflicting fallback addresses block that tutor and remain visible.

The worker runs every 30 minutes at `/api/internal/post-class-feedback/reminder-nightly`. It validates every discovery page, stores the complete inventory, and refreshes canonical feedback in batches of 50 with a 20-minute freshness limit. A 15-minute fenced lease prevents overlapping workers; each pass has an eight-minute work budget. An unavailable class blocks its tutor's first grouped message while other tutors can proceed. Unattempted messages are regrouped when new classes arrive. After dispatch starts, content and membership stay immutable; later discoveries receive a separate recovery delivery.

**Reminder settings do not change deduction rules, approvals, existing deductions, or payout publication.** The canonical feedback refresh uses the existing evidence and assessment pipeline; reminder success is never a prerequisite for deductions.

## State and evidence

- `post_class_settings`: `reminder_mode` (`off`, `shadow`, `live`), first shadow start, immutable prospective live activation, and legacy trigger cutover confirmation. Changes use the existing versioned settings API and configuration audit log.
- `post_class_reminder_ledger`: unique session + reminder date + mode. Records imported and unimported classes, current discovery evidence, canonical identity, blocked contacts/source, exclusions, missed deadlines, and delivery links.
- Existing notification runs, deliveries, items, and attempts: each dispatched delivery has an immutable class list, content, recipient, stable message key, provider, receipt, and relay acceptance timestamp.
- A relay receipt establishes acceptance by the sending service. It does not prove inbox delivery or that the tutor read the email.

A complete discovery with zero eligible work is healthy. Missing pages, invalid configuration, stale feedback, unresolved identities, or unfinished imports are visible conditions. A cron pass finishing is insufficient to prove coverage: Data Health independently compares canonical sessions with ledger entries and counts unresolved outcomes.

## Settings and controls

Open **Class Feedback → Settings → Nightly feedback reminders**. Viewers can read coverage and per-class history. Access managers can preview, process due work, test each relay to their own address, change reminder mode, and reconcile uncertain deliveries. Recipient addresses remain restricted to access managers.

- **Shadow mode** records real discovery and current policy outcomes and creates email previews. It sends no tutor reminders.
- **Build shadow preview** rehearses the most recent 22:00 window even if shadow mode was enabled after that checkpoint. Expired classes stay recorded. This action is rejected outside shadow mode.
- **Live** requires a completed current-policy shadow batch and primary/backup relay test receipts within 24 hours, plus confirmation that the legacy reminder trigger is disabled. The first batch is the next 22:00 checkpoint at or after activation, covering its normal three dates. Earlier missed nightly batches are not replayed.
- **Pause reminders** selects `off`, retaining the ledger and queue. In-flight requests may already have reached the relay. Their uncertain outcomes remain visible and can be reconciled while paused. Resuming consolidates relevant unfinished work and records passed deadlines as missed.

Settings: `PATCH /api/post-class-feedback/settings`, with `expectedVersion` and `reminderMode`; first activation can also provide a prospective `reminderActivationAt` and `legacyReminderDisabled: true`.

History/health: `GET /api/post-class-feedback/reminders?sessionId=<uuid>&tutorKey=<canonical-key>`. Access managers can request `preview=true`.

Actions: `POST /api/post-class-feedback/reminders` with `action` of `shadow_preview`, `retry`, `test` (`senderKey`: `primary` or `backup`), or `resolve`.

## Failure recovery

1. Check source proof and per-class reasons in the panel. Fix missing contacts through existing tutor contact controls; never guess an address.
2. Known rejection before acceptance can retry after 30, 90, and 180 minutes, keeping the same message key. Backup begins after a definite primary rejection.
3. Network timeout, malformed acknowledgement, interrupted sending, or failure to save a receipt after acceptance is **unknown**. No automatic sender switch or resend is allowed.
4. For an unknown delivery, inspect the sending mailbox/provider evidence. Record either **accepted**, with a receipt or mailbox reference, or **verified not sent**, with an evidence note. The decision and delivery transition are atomic and audited. Verified-not-sent work must pass fresh feedback checks before a new delivery is composed.
5. Unknown outcomes remain visible across date rotation and while paused. They are listed first in searchable history.

Data Health alerts existing watchdog recipients for source validation or sending failures, or unresolved work after 22:30. It sends the existing episode recovery notice after recovery. Failed alert delivery is persisted in `cron_alert_state` and shown in the reminder panel and Data Health. A total alert failure leaves the episode retryable; partial delivery keeps the existing watchdog policy of avoiding duplicate alerts to successful recipients.

## Cutover checklist

1. Verify migration `0096_nightly_feedback_reminders` and the deployed Git revision. Default mode is `off`; switch to `shadow`.
2. Complete a full shadow batch. Compare discovery count/date coverage against fresh Wise evidence and review representative previews, including paired tutor accounts and missing contacts.
3. Send primary and backup tests to the operator's own internal mailbox. Verify received content and stored acceptance receipts. Automated tests cover malformed acknowledgements, rejection, unknown timeouts, and persistence failures without emailing tutors.
4. In the legacy **Comments notifier** Apps Script project, disable only `sendMissingCommentsReminders`, then read the trigger list again. Preserve `trackFeedbackCommentState`, `runFeedbackSlaAudit`, `runDailyTeacherDeductionAdminWorkflow`, and `handleTeacherDeductionAdminEdit`. Record the verified cutover time. Project: `15R3PrAL5-kgHHjju0CHynzXRVh53lFTT3NduHgfRGL7aIBfa7IbTnUtp`.
5. Enable live reminders through the versioned API/UI. Verify the stored activation instant and next eligible checkpoint.
6. Inspect seven consecutive live nights: deployed revision, complete source proof, ledger coverage, actual accepted deliveries/receipts, valid zero-work/exclusion reasons, contacts, missed deadlines, unknown outcomes, and watchdog alert/recovery evidence. Retain dated results. A failed night resets the consecutive-night count.
7. Roll back using **Pause reminders**. Preserve the queue for recovery; do not restore the legacy trigger while live sending is enabled.

## Verification

Unit tests cover strict pagination beyond 13,603 rows, Bangkok boundaries, eligibility, tombstones, policy freshness and receipt parsing. Postgres integration tests cover durable grouping, missing/ambiguous source state, valid zero work, feedback completion during refresh, overlapping workers, retry timing, cross-midnight recovery, unknown outcomes across nights/off mode, interrupted sending, acceptance persistence failures, independent coverage gaps, bounded refresh fairness, immutable membership, prospective activation gates and deduction independence.

Production rollout and seven-night acceptance are operational evidence recorded separately from these code checks.
