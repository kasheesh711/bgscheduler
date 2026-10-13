# Progress Check LINE reminders

The Scheduling bot sends fixed English reminders to registered teacher groups. IGCSE_QB owns current Progress Check dates and completion state. The old Scheduling Progress writer and its three cron jobs remain retired.

The trial enables only `Buzz` in `Kru Buzz x BeGifted`. An existing LINE bot admin sends `/progress setup Buzz` in that group after adding `@begifted`. The signed webhook supplies the group ID; the bot verifies the group name and active tutor key before it stores the binding. The bot replies with a registration receipt. Other senders are ignored.

## Settings

Set `PROGRESS_LINE_REMINDER_SECRET` to the same private value in both projects. The IGCSE_QB endpoint is `GET /api/progress-cron/line-reminder-candidates?ownerKey=Buzz`. It checks its own bearer secret. It reads current records only; it does not sync, send email, or change Progress records.

In Scheduling, set `PROGRESS_LINE_CANDIDATES_URL=https://www.begifted.app/api/progress-cron/line-reminder-candidates`. Set `PROGRESS_LINE_TUTOR_KEYS=Buzz` in both projects. Set `PROGRESS_LINE_REMINDERS_ENABLED=true` only after source, group, and release checks pass. A missing or false switch stops sending. Setting `progress_line_groups.enabled=false` also stops that tutor's sends. Keep delivery records for review.

The job runs every ten minutes. Each reminder is due at 19:00 Bangkok time, seven calendar days before or one calendar day before the test lesson. It can recover later that same evening. It records expired dates without sending stale messages. The trial on 13 October skips the expired week reminder and sends one late night-before reminder for the verified 14 October test.

## Delivery and recovery

The source must have a complete successful sync within one hour. The job checks it again before sending. Missing dates, unknown tutors, stale data, submitted tests, and changed lessons stop sending. Dates use the tutor workspace's existing class plan and verified lesson IDs.

`progress_line_groups` stores the tutor binding. `progress_line_deliveries` stores the frozen message, original retry UUID, attempts, lease, and LINE receipt. Concurrent jobs claim one occurrence. A stored accepted stage blocks another message even if the lesson later moves. A changed lesson cancels an unsent occurrence. An attempted occurrence with a changed lesson, an expired reminder date, or an expired retry window requires delivery review.

Transient failures retry the exact message, destination, and key within LINE's 24-hour retry window. Permanent API refusals stop retries. LINE acceptance and a message visible in the group are separate checks; Buzz's confirmation is a separate acceptance step. Do not reset a retry key or clear an uncertain record to force another send.

Apply additive migration `0115_progress_line_reminders.sql` before releasing the sender. The cron registry, Data Health dispatcher, and route duration must agree. The API does not use AI or model API keys. Teacher expansion requires Kevin's approval.
