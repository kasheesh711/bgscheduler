# Progress Check LINE reminders

The Scheduling bot sends fixed English reminders to registered teacher groups. IGCSE_QB owns current Progress Check dates and completion state. The old Scheduling Progress writer and its three cron jobs remain retired.

All active tutors are eligible. To start reminders for a tutor, add `@begifted` to the tutor's LINE group. Then an existing LINE bot admin sends `/progress setup <tutor key>` in that group. The tutor key is the `tutor_contacts.canonical_key` value, for example `Buzz`. Buzz must use `Kru Buzz x BeGifted`. The signed webhook supplies the group ID; the bot verifies the group name and active tutor key before it stores the binding. The bot replies with a registration receipt. Other senders are ignored.

## Settings

Set `PROGRESS_LINE_REMINDER_SECRET` to the same private value in both projects. The IGCSE_QB endpoint is `GET /api/progress-cron/line-reminder-candidates?ownerKey=<tutor key>`. It checks its own bearer secret. It reads current records only; it does not sync, send email, or change Progress records.

In Scheduling, set `PROGRESS_LINE_CANDIDATES_URL=https://www.begifted.app/api/progress-cron/line-reminder-candidates`. Set `PROGRESS_LINE_REMINDERS_ENABLED=true` only after source, group, and release checks pass. A missing or false switch stops sending. Setting `progress_line_groups.enabled=false` stops that tutor's sends. `PROGRESS_LINE_TUTOR_KEYS` is not used. Keep delivery records for review.

The job runs every ten minutes. Each reminder is due at 19:00 Bangkok time, seven calendar days before or one calendar day before the test lesson. It can recover later that same evening. It records expired dates without sending stale messages. The trial on 13 October skips the expired week reminder and sends one late night-before reminder for the verified 14 October test.

## Delivery and recovery

The source must have a complete successful sync within one hour. The job checks it again before sending. Missing dates, unknown tutors, stale data, submitted tests, and changed lessons stop sending. Dates use the tutor workspace's existing class plan and verified lesson IDs.

`progress_line_groups` stores the tutor binding. `progress_line_deliveries` stores the frozen message, original retry UUID, attempts, lease, and LINE receipt. Concurrent jobs claim one occurrence. A stored accepted stage blocks another message even if the lesson later moves. A changed lesson cancels an unsent occurrence. An attempted occurrence with a changed lesson, an expired reminder date, or an expired retry window requires delivery review.

Transient failures retry the exact message, destination, and key within LINE's 24-hour retry window. Permanent API refusals stop retries. LINE acceptance and a message visible in the group are separate checks; Buzz's confirmation is a separate acceptance step. Do not reset a retry key or clear an uncertain record to force another send.

Apply additive migration `0115_progress_line_reminders.sql` before releasing the sender. The cron registry, Data Health dispatcher, and route duration must agree. The API does not use AI or model API keys.


## Separate tutor bot pilot

The tutor bot uses the same webhook route with `?bot=tutors`:
`https://bgscheduler.vercel.app/api/line/webhook?bot=tutors`.
Set its own `LINE_TUTOR_CHANNEL_SECRET` and `LINE_TUTOR_CHANNEL_ACCESS_TOKEN`.
Create it under the same LINE provider as the parent account so the existing
admin user IDs still apply. Keep parent credentials unchanged.

`PROGRESS_LINE_TUTOR_BOT_KEYS` selects the exact canonical tutor keys that use
this account. Empty means that all reminders keep using the parent account.
The tutor webhook accepts only group commands; direct messages and room-booking
commands do not enter the parent workflow. A setup command received on the
wrong account cannot change a tutor's binding. Missing tutor credentials stop
tutor-account sends; there is no fallback to the parent account.

For the first pilot, use one verified tutor group only:

1. Record the existing group binding and check for pending delivery attempts.
   Do not change accounts while `retry`, `sending`, or other attempted unresolved
   deliveries remain. Preserve sent and uncertain records and all retry keys.
2. Temporarily disable only that group's reminder binding. Set the pilot key
   and tutor credentials, deploy the checked build, and verify the tutor webhook.
3. Remove the parent Official Account from that group and add BeGifted Tutors.
   LINE permits one Official Account per group. Use the verified account ID.
4. An existing bot admin sends `/progress setup <canonical key>` in that group.
   Verify the new account's group summary and the saved enabled binding.
5. Check one reminder through the new account, its saved receipt, and its visible
   message in the group. Keep regular schedule and duplicate protection active.
   Do not clear delivery rows or replay an accepted reminder as a test.
6. Verify a new tutor-group message appears under BeGifted Tutors and no longer
   reaches the parent account's inbox. Existing parent-account chat history may
   remain. Move no other group until Kevin approves expansion.

Rollback is limited to that group: disable its binding, resolve any attempted
sends, restore the parent Official Account, remove the pilot key and deploy,
then register the group on the parent account again. Preserve delivery history.
