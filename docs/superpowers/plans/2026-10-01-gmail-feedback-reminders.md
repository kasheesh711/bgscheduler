# Restart tutor feedback reminders through Google Workspace

## Approved spec

Send from admin@begiftededucation.com through Gmail API using a dedicated OAuth client in BeGifted Scheduling. Request only openid, email, and gmail.send; require Workspace Trusted approval before connecting because the project is in Testing. Encrypt credentials separately from Sheets and Calendar. Only access managers can connect, test, confirm receipt, or activate. Preserve 22:00 Asia/Bangkok, current unexpired classes, and prospective activation without an immediate catch-up. Keep deductions and all other email features independent.

Reuse the durable queue and fenced worker; retry confirmed temporary rejections, honor Google retry timing, and reconcile ambiguous acceptance before resending. Prove delivery separately from provider acceptance. Change activation gates to Gmail renewal, confirmed test receipt, private LINE confirmation, current-policy complete shadow, and verified legacy cutover. Set Ohm's primary email to n.kriangdet@gmail.com. Exclude freshly verified no-shows despite identity review, without weakening uncertain-source safeguards.

Private LINE alerts to Kevin cover authorization failures, incomplete batches after 22:30, uncertain sends and recovery, with durable deduplication/retries. Verify the private destination before activation. Check connection health before the nightly cutoff; surface health and failed alerts in Data Health.

Run tests and release gates. Prepare and verify production email/LINE tests before disabling only sendMissingCommentsReminders (preserve the other four legacy triggers). Activate at the next 22:00 checkpoint after verification. Record seven consecutive live nights, resetting the count after failure.

## Global constraints

- Worktree starts at fe791ff0636d10dcc98829d7ff47690c2c5cea49; preserve other writers' changes.
- No production sends until explicit connection and test gates pass. Preview environments cannot connect or send.
- Never expose credentials in logs, API output, or chat. OAuth configuration and user consent remain runtime gates.
- A receipt is acceptance, not proof of inbox delivery. No automatic failover for ambiguous outcomes.

## Task 1: Gmail connection and transport

Add the encrypted dedicated connection schema, safe OAuth flow, token refresh, MIME transport and focused unit/integration tests. Verify sender pinning, state expiry, revision-bound receipts, missing scope, revoked token, rate-limit timing and uncertain send outcomes.

## Task 2: Queue and activation safety

Use Gmail for nightly reminders. Preserve frozen messages and durable attempts. Fix verified no-show exclusion. Require current sender and LINE receipt evidence, fresh shadow and legacy cutover on activation/resume. Extend real Postgres tests.

## Task 3: Private alerts and health

Add verified private LINE destination, generic receipt test, persistent failure/recovery episodes, preflight refresh and watchdog integration. Verify retries, deduplication, wrong destination, and error health.

## Task 4: Routes, interface and documentation

Add access-manager-only Gmail controls under Class Feedback, explicit receipt confirmations and connection status. Preserve viewer privacy. Document environment, API, database and operator steps.

## Task 5: Review, release and operational cutover

Run full release gates and relevant Postgres suites. Fresh whole-branch review, fixes, PR and deployment. Configure dedicated client and Workspace trust, verify email and LINE receipt, update Ohm, shadow preview, narrow legacy cutover and live activation. Start seven-night verification only once live. Record all remaining external blockers honestly.

## Review focus

OAuth state/actor binding, preview isolation, token scope and revision races, concurrent sends, acceptance ambiguity, retry timing, deadline rechecks, source exclusions, activation evidence freshness, private alert recipient confirmation, alert deduplication and delivery failures.
