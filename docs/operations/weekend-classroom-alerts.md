# Weekend classroom alerts

The Wednesday, Thursday and Friday checkpoint starts at **09:00 Asia/Bangkok** and checks the coming Saturday and Sunday. Only `kevhsh7@gmail.com` receives these warnings. Unchanged problems receive another warning on each check day; a subsequent primary check sends one resolved notice after the previous warning has cleared. Ordinary healthy weekends remain quiet.

## Assessment and delivery

The check waits up to six minutes for the normal Wise refresh to promote a snapshot, retaining the existing 15-minute freshness requirement. It then reads the complete live Wise session list and runs the recovery planner without changing rooms, assignments, tutor profiles, Wise bookings, or teacher emails. Reads share a pinned identity snapshot and a repeatable-read, read-only database transaction for the planning context. The full live read has a ten-minute overall budget.

Room shortages, live double bookings, incompatible rooms and unverifiable data are actionable. A feasible preview does not mean a proposed correction has been applied. Solver exhaustion is reported as an unresolved assignment, not a proven number of missing rooms. Unknown identities, modality, cancellations, malformed pagination, stale snapshots and failed fetches never produce an all-clear.

Delivery uses the existing primary Apps Script relay and a durable private outbox. A successful check has a readiness of `clear`, `attention` or `unverified`; execution success means assessment and any required notification were recorded, not that rooms are sufficient. The two new tables are `classroom_weekend_checks` and `classroom_weekend_notifications`, introduced by migration `0077_classroom_weekend_checks`.

Retry ticks at 09:16 and 09:31 recover unfinished claims and failed delivery using a 15-minute lease and the same relay idempotency key. Verified assessments and accepted emails are not repeated that day. After an unverified warning is delivered, retries can refresh the saved assessment without duplicating the warning; any recovery notice follows at the next primary check day. Pending mail retains its original payload/key until accepted.

## Configuration and rollout

- `CLASSROOM_WEEKEND_ALERT_EMAIL`: exactly one validated email address, configured as `kevhsh7@gmail.com`. There is no fallback to the admin mailing list.
- `CLASSROOM_WEEKEND_ALERTS_ENABLED_AT`: an ISO timestamp with offset. Missing means disabled. Set this only after the migration and release validation. Expected cron windows before this activation instant are ignored.
- Existing `SCHEDULE_EMAIL_APPS_SCRIPT_URL` and `SCHEDULE_EMAIL_APPS_SCRIPT_SECRET` provide delivery.
- Cron: `GET /api/internal/class-assignments/weekend-check`, secret-protected, `maxDuration = 800`; Vercel schedule `0,16,31 2 * * 3-5`.

The 09:00 tick deliberately shares the Wise snapshot minute, waiting for that sync rather than launching another one. The other ticks occupy free minutes. The scheduled checker never calls the source sync or publisher.

Run `npm run verify:release` and database integration tests against an isolated scratch Postgres. Validate the live evaluator without calling `runWeekendClassroomCheck` (which can send mail) and verify desktop/mobile warnings and email links with mocked data. Apply only the reviewed additive migration, configure the recipient/activation instant, and deploy the verified commit through the linked project.

First expected checkpoint for this rollout: **Wednesday, 9 September 2026, 09:00 Bangkok**. Verify its cron invocation, persisted report and notification receipt after the retry window. Do not invoke morning automation to test this feature.

Rollback: remove `CLASSROOM_WEEKEND_ALERTS_ENABLED_AT` and redeploy. Preserve the additive tables and delivery history.

## Monitoring and recovery

Data Health lists the job and supports an authenticated manual retry (the enabled Wednesday–Friday calendar still applies). The watchdog routes this job's failures only to the private recipient and excludes its details from shared admin digests. Check the stored report and delivery status if a warning is missing; do not reset a sent record or change its idempotency key to force a resend.

Class Assignments shows a persistent warning when a selected saved plan is incomplete, independently of the run's `completed` status. It also displays the latest weekend assessment with its timestamp and per-date review links. A `weekendCheck` query parameter opens a specific saved check; a `date` query parameter selects the affected teaching date. Saved assessments describe their observation time, not subsequent booking changes.
