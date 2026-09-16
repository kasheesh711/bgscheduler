# Tutor Sit-ins rollout

## Deployment sequence

1. Run `npm run verify:release`, targeted lint, the focused Postgres integration suite, and desktop/mobile workflows on Node 24. The integration database is disposable: its fixture tables are truncated.
2. Apply additive migration `0089_tutor_sit_ins.sql` using the existing migration process. Keep historical tables and audit triggers on rollback.
3. Configure the existing Google OAuth web client's exact new callback: `https://bgscheduler.vercel.app/api/tutor-sit-ins/calendar/callback`. Local isolated delivery tests need their own exact localhost callback. Enable Google Calendar API and consent scopes `calendar.events.owned`, `calendar.calendarlist.readonly`, plus identity scopes. [Google OAuth web-server requirements](https://developers.google.com/identity/protocols/oauth2/web-server).
4. Set `TUTOR_SIT_INS_ENABLED=true` with `TUTOR_SIT_INS_DELIVERY_ENABLED=false`. Set `APP_BASE_URL` to the exact app origin. Keep the existing `AUTH_SECRET` encryption key stable. Preview deployments cannot connect Calendar or deliver externally.
5. Verify each head's Google login, department grant and complete onsite/online Wise identity. Review uncertain class mappings. Designate eligible alternate observers for heads' own assessments. Verify staff access. Connect each observer's Calendar through their own consent; choose an owned event destination. Connection is optional for Wise scheduling.
6. In a separate local or dedicated test database, restrict `TUTOR_SIT_INS_TEST_RECIPIENTS` to an approved test account, then enable delivery there. Do not copy production OAuth tokens into shared previews. Test Calendar create/read/retry/edit detection/withdrawal and relay email. The allowlist rejects unlisted recipients; it does not redirect real tutor/staff deliveries to the test account.
7. Only after the isolated test passes, enable production delivery. Heads may confirm eligible observations before delivery setup. Once delivery is enabled, export their pending future events. Verify one invitation, staff tasks and family acknowledgements. Check Data Health for both new cron jobs.

No production deployment, migration or environment flag change is performed merely by adding this feature to the branch.

## Checks and recovery

```sh
npm run verify:release
npx vitest run --project unit src/lib/tutor-sit-ins
TEST_DATABASE_URL=postgresql://USER@localhost:PORT/DISPOSABLE_DATABASE \
  npx vitest run --project integration src/lib/tutor-sit-ins/__tests__/workflow.integration.test.ts
```

The worker runs at UTC minutes `4,14,24,34,44,54`; the digest runs at `0 1 * * *` (08:00 Bangkok). Both use cron-secret authorization, invocation monitoring and a 300-second maximum. The worker processes older unchecked assignments first within its time budget. Pending jobs retry with exponential backoff, capped at one hour. Digest keys are per account, quarter and Bangkok day; stale digests are superseded.

- **Source stale / incomplete:** check Wise and shared student syncs. No new booking can be confirmed from incomplete evidence. A ten-minute worker cannot observe a Wise change before the source API/snapshot exposes it.
- **Google disconnected:** reconnect the same account; existing event identifiers and outbox rows remain. Do not delete credentials while withdrawals are pending.
- **Calendar delivery failure:** inspect the observation's delivery error. Reuse its job/event ID; creating another event manually bypasses duplicate protection.
- **Direct Calendar edit:** review the exported copy. The Wise booking remains valid, with a Calendar delivery discrepancy; no replacement observation or renewed family acknowledgement is created solely because of the Calendar edit.
- **Email failure:** restore the existing relay URL/secret. Outbox retries never mark a family as informed.
- **Report conflict:** refresh the server revision while retaining the local text. Submitted history is immutable; use an audited reopen to correct it.
- **Rollback:** set delivery off to halt new external writes. This also pauses queued event withdrawals, so resolve urgent cancellations before pausing or communicate them through operations. Feature-off hides entry points and skips workers without deleting data.

## Verification record — 2026-09-16

- Final `npm run verify:release` passed on Node 24.19.0: TypeScript, **5,060 unit tests across 445 files**, optimized Next.js build, post-build TypeScript, diff whitespace and the **276-route** production-surface guard. Targeted ESLint passed.
- The focused feature tests passed: **30 unit tests and 18 PostgreSQL integration tests**, including canonical observer concurrency, the post-verification notice boundary, exact 48-hour submission across quarters, revoked queued delivery, Calendar edits and recipient-scoped failure visibility.
- Focused unit tests cover quarters, exact notice, rubric scoring, live Wise account/participant/mapping checks, Calendar conflicts and HTTP access/origin boundaries.
- PostgreSQL integration tests exercise the actual migration, department/revocation isolation, quarterly uniqueness, concurrent bookings, self-observation, immutable revisions, communication history, Calendar retry recovery and delivery claims.
- Desktop 1440×1000 and mobile 390×844 browser checks used the real feature components with synthetic local API fixtures: filtering, confirmation, all ten ratings, draft saving, submission, immutable report view, Calendar selection, staff acknowledgements, dark theme and horizontal overflow. Provider authorization and Next.js session plumbing are not established by this component harness.
- A read-only live Wise probe confirmed dated sessions, student-list precedence, working/leave payloads, and `SCHEDULED` as online modality.
- The live email smoke test was explicitly authorized for the owner's account, `kevhsh7@gmail.com`, through the existing relay with a strict single-recipient allowlist and a separate local database. Relay accepted one test email; repeating the job sent zero duplicates. Inbox receipt remains user-confirmed evidence.
- The initial isolated Calendar consent request failed with `redirect_uri_mismatch`. The callbacks were subsequently saved during the allocation-correction rollout below. No Calendar token or test event had been created at this initial checkpoint.

_This initial checkpoint preceded production rollout; the later record below describes the deployed corrections._

## Allocation corrections — 2026-09-16

- Migration `0090_sit_in_coverage_scopes.sql` was applied to the verified production Neon database. All five original active grants were still untouched at revision zero; the approved Science and ISEB strand scopes were added with an audit record. Existing manually edited or revoked grants are preserved by the migration. Production had 61 automatic obligations, zero observations and zero reports before reconciliation.
- Validation: `verify:release` passed with **5,098 unit tests across 448 files**, production build, TypeScript and the 276-route guard. **22 focused Postgres integration tests** cover scope isolation, concurrent strand generation, supersession, Science balancing, self-exclusion, manual/booked preservation and revocation while availability loads. Whole-repo ESLint has 19 existing warnings and no errors.
- Desktop and 390×844 mobile checks used real components with isolated synthetic APIs. ISEB strand labels, provisional lesson selection, disabled confirmation, known-student aggregation, separate incomplete-occurrence counts and scope controls passed without horizontal overflow.
- Both Calendar OAuth callbacks were saved after owner confirmation. The isolated Calendar flow now reaches Google's unverified-app warning; completion is awaiting the owner's browser handoff. Production delivery remains disabled until Calendar delivery validation succeeds.
- Google's OAuth audience is still **Testing**. After owner confirmation, Peat, Tito and Mimi were added and verified in the saved test-user list; Gift was already enrolled. Google rejected Ek's `apivit.s@hotmail.com` because it is not associated with an active eligible Google Account. Ek must associate that address with Google or provide another verified Google account before Calendar onboarding can finish. Application grants and Wise identity bindings remain intact.
- Google Calendar API was found disabled in project `begifted-scheduling`. Its enablement page states the applicable Google APIs and Calendar terms; action-time owner confirmation is pending. Owner Calendar consent is also still waiting at Google's unverified-app warning. Neither pending step is evidence of a completed Calendar delivery test.
- [PR #76](https://github.com/kasheesh711/bgscheduler/pull/76) passed all five required checks and merged as `133c41c3825ad006b6c6ab95573fe8fa1ba1b59d`. Post-merge CI also passed. Vercel production deployment `dpl_Arq8GMke3vYXEJKQibfCcDmhCNxM` reached Ready and owns `bgscheduler.vercel.app`; the authenticated dashboard shows General Science and separate ISEB scope labels, with delivery still disabled.
- Rollout sequence after the code deploy: refresh the core Wise snapshot to populate dated student IDs, refresh shared student data, run the sit-in worker, then inspect Q4 coverage, Science allocation and provisional openings. Never backfill missing dated rosters from another occurrence.
- The first corrected Wise sync promoted 22,265 future sessions with dated student ID arrays; four arrays were genuinely empty. It retained existing teacher-contact/absent-roster warnings. Initial Q4 reconciliation produced 93 active obligations, superseded two obsolete automatic obligations, and passed live checks for duplicate coverage, self-observation and missing scope grants. Four heads' ordinary-subject assessments require administrator-designated alternates.
- Live verification exposed an older onboarding defect: unchanged durable Wise accounts retained a previous `last_snapshot_id`, making all heads appear unverified. The follow-up fix advances that marker inside the promotion transaction without changing content timestamps or creating audit noise. Absent, identity-conflicted and unknown account states remain blocked in both suggestions and live confirmation. Validation passed **89 focused unit tests and 32 Postgres integration tests**. A new promoted Wise sync after this fix refreshes the markers; no direct database backfill is needed.
- The first shared student/family refresh received Wise HTTP 429 and preserved the prior active snapshot. Retry after provider cooldown; never treat that failed refresh as a cancellation or substitute another lesson's roster.

## Wise-only availability rollout — 0093

Apply compatible migration `0093_sit_in_wise_scheduling.sql` after provider migration 0092. Release via reviewed PR and the five required CI checks, then refresh Q4 coverage and suggestions. Pending and replacement shortlists are regenerated; manual allocations, bookings, reports and communication history stay intact. Verify new suggestions say **Wise schedule checked** and that a head can confirm with no Calendar connection and delivery disabled.

Keep external delivery disabled until the isolated owner-account Calendar create/read/retry/withdrawal test succeeds. The Calendar smoke test must request only identity, owned events and calendar-list access, and must never query free/busy or personal event lists. Provider registration and observer consent remain separate onboarding tasks.

Reconciliation runs independently of delivery. A Wise cancellation/conflict invalidates the observation; missing Calendar credentials or edited/deleted Calendar copies do not. An invitation queued until after its lesson starts is recorded as missed, never sent late or used to invalidate a report. Rollback should pause external delivery and retain additive columns; use a forward correction instead of restoring Calendar scheduling gates.
