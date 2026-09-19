# Weekend classroom alerts

The Wednesday checkpoint starts at **09:00 Asia/Bangkok**, saves allocations for the coming Saturday and Sunday, and emails one report to **kevhsh7@gmail.com**, including when no student switches are needed. Thursday and Friday at 09:00 make fresh read-only assessments: unresolved problems receive another private warning, followed by one resolved notice after a verified recovery. Healthy Thursday/Friday checks remain quiet.

## Assessment and delivery

The check waits up to six minutes for the normal Wise refresh to promote a snapshot, retaining the existing 15-minute freshness requirement. It reads the complete live Wise sessions for both dates, sharing a pinned identity snapshot and a repeatable-read planning context. Wednesday verifies each date independently before using the existing day lock and incremental allocator. Explicit overrides, confirmed reservations, started/notified assignments and actual modalities are preserved. Unresolved source data withholds that date's save and remains visible; the other date can still complete. The full live read has a ten-minute overall budget.

The full-day minimum-switch optimizer first rearranges rooms and releases already-online lessons from onsite classrooms. These improvements are saved as actual-modality allocations. Proposed onsite-to-online conversions and their conditional room plan stay in separate run metadata. An online release uses a dedicated online room when available, otherwise **Teach elsewhere — classroom released**, including when adjacent lessons are onsite. No Wise modality, family message or teacher email is changed by this checkpoint.

Report version 2 extends the existing payload with per-day allocation state/run ID, save/source timestamps, overflow plan and Wise publication read-back. It lists students, tutors, full lesson times, actual history counts and observed periods, before/after rooms, accommodated lessons, solver proof/timeout status and source problems. Online attendance is explicitly fallback evidence. Failed dates have unverified capacity, not a zero-overflow claim. Old reports remain readable.

Normal **17:00 seven-day allocation and publishing** and **19:00 next-day schedule delivery** remain independent. A Wednesday save is not Wise publication. Only matching fresh Wise lesson/roster/location evidence counts as confirmed publication. Suggestions never clear operational warnings.

Targeted publishing respects a saved already-online release only while fresh Wise data confirms the full lesson and complete roster. It retains Wise's original location as source evidence and does not edit the online lesson. If release evidence changes during publishing, affected onsite assignments remain unresolved after read-back. Hypothetical conversions never release publishing capacity.

Room shortages, live double bookings, incompatible rooms and unverifiable data are actionable. A feasible preview does not mean a proposed correction has been applied. Solver exhaustion is reported as an unresolved assignment, not a proven number of missing rooms. Unknown identities, modality, cancellations, malformed pagination, stale snapshots and failed fetches never produce an all-clear.

Delivery uses the existing primary Apps Script relay and a durable private outbox. A successful check has a readiness of `clear`, `attention` or `unverified`; execution success means assessment and any required notification were recorded, not that rooms are sufficient. The two new tables are `classroom_weekend_checks` and `classroom_weekend_notifications`, introduced by migration `0077_classroom_weekend_checks`.

Retry ticks at 09:16 and 09:31 recover unfinished claims and failed delivery using a 15-minute lease and the same relay idempotency key. Migration `0095_classroom_weekend_allocations` adds a database-unique checkpoint/date key for `cron@classroom-weekend` runs. A committed allocation is reused after a crash; source/constraint fingerprints reject stale reuse. The checkpoint claim is locked and checked in the allocation transaction so a superseded worker cannot save. After an unverified warning is delivered, retries can finish missing dates and refresh the stored report without duplicating the accepted email; any recovery notice follows at the next primary check day. Pending mail retains its original payload/key until accepted.

## Configuration and rollout

- `CLASSROOM_WEEKEND_ALERT_EMAIL`: exactly one validated email address, configured as `kevhsh7@gmail.com`. There is no fallback to the admin mailing list.
- `CLASSROOM_WEEKEND_ALERTS_ENABLED_AT`: an ISO timestamp with offset. Missing means disabled. Set this only after the migration and release validation. Expected cron windows before this activation instant are ignored.
- Existing `SCHEDULE_EMAIL_APPS_SCRIPT_URL` and `SCHEDULE_EMAIL_APPS_SCRIPT_SECRET` provide delivery.
- Cron: `GET /api/internal/class-assignments/weekend-check`, secret-protected, `maxDuration = 800`; Vercel schedule `0,16,31 2 * * 3-5`.

The 09:00 tick deliberately shares the Wise snapshot minute, waiting for that sync rather than launching another one. The other ticks occupy free minutes. The scheduled checker never calls the source sync or publisher.

Run `npm run verify:release` and database integration tests against an isolated scratch Postgres. Validate the live evaluator without calling `runWeekendClassroomCheck` (which can send mail) and verify desktop/mobile warnings and email links with mocked data. Apply only the reviewed additive migration, configure the recipient/activation instant, and deploy the verified commit through the linked project.

First expected allocation checkpoint for this rollout: **Wednesday, 23 September 2026, 09:00 Bangkok**, covering **26–27 September**. Verify its cron invocation, both saved run IDs, stored report and provider receipt after the retry window. Provider acceptance is not confirmed inbox delivery.

For this approved restoration, deploy and validate while `WISE_CLASSROOM_AUTOMATION_ENABLED=false`, apply migrations 0094/0095 and bootstrap available history, inspect pending publication jobs, then set the flag to `true` and redeploy. Previously stopped jobs remain stopped. Keep the Kevin-only manual controls. This restores the five existing Wise/classroom jobs; it does not add another scheduled job.

Rollback: remove `CLASSROOM_WEEKEND_ALERTS_ENABLED_AT` and redeploy. Preserve the additive tables and delivery history.

## Monitoring and recovery

Data Health lists the job and supports an authenticated manual retry (the enabled Wednesday–Friday calendar still applies). The watchdog routes this job's failures only to the private recipient and excludes its details from shared admin digests. Check the stored report and delivery status if a warning is missing; do not reset a sent record or change its idempotency key to force a resend.

Class Assignments keeps a compact status bar visible when a selected saved plan is incomplete, independently of the run's `completed` status. **Review issues** opens a drawer containing Selected day, Weekend and Wise data sections, with class findings grouped and counted once per date/session. The drawer starts closed and stays closed through refreshes and new warnings; opening or closing it preserves the current room view. Desktop uses a 520px side drawer and mobile uses the full width, with one scrolling body and keyboard/outside-click dismissal.

The Weekend section displays the saved assessment with its timestamp, delivery state and per-date review links. A `weekendCheck` query parameter selects a specific saved check for the drawer; a `date` query parameter selects the affected teaching date. Saved assessments describe their observation time, not subsequent booking changes. Alert scheduling and delivery are independent of the drawer's visibility.
