# Tutor Sit-ins rollout

## Deployment sequence

1. Run `npm run verify:release`, targeted lint, the focused Postgres integration suite, and desktop/mobile workflows on Node 24. The integration database is disposable: its fixture tables are truncated.
2. Apply additive migration `0089_tutor_sit_ins.sql` using the existing migration process. Keep historical tables and audit triggers on rollback.
3. Configure the existing Google OAuth web client's exact new callback: `https://bgscheduler.vercel.app/api/tutor-sit-ins/calendar/callback`. Local isolated delivery tests need their own exact localhost callback. Enable Google Calendar API and consent scopes `calendar.events.owned`, `calendar.events.freebusy`, `calendar.calendarlist.readonly`, plus identity scopes. [Google OAuth web-server requirements](https://developers.google.com/identity/protocols/oauth2/web-server).
4. Set `TUTOR_SIT_INS_ENABLED=true` with `TUTOR_SIT_INS_DELIVERY_ENABLED=false`. Set `APP_BASE_URL` to the exact app origin. Keep the existing `AUTH_SECRET` encryption key stable. Preview deployments cannot connect Calendar or deliver externally.
5. Verify each head's Google login, department grant and complete onsite/online Wise identity. Review uncertain class mappings. Designate eligible alternate observers for heads' own assessments. Verify staff access. Connect each observer's Calendar through their own consent; choose owned destination and calendars to check.
6. In a separate local or dedicated test database, restrict `TUTOR_SIT_INS_TEST_RECIPIENTS` to an approved test account, then enable delivery there. Do not copy production OAuth tokens into shared previews. Test Calendar create/read/retry/edit detection/withdrawal and relay email. The allowlist rejects unlisted recipients; it does not redirect real tutor/staff deliveries to the test account.
7. Only after the isolated test passes, enable production delivery. Confirm a real eligible observation after the head has reviewed it. Verify one invitation, staff tasks and family acknowledgements. Check Data Health for both new cron jobs.

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
- **Direct Google edit:** reconcile with Wise through a replacement observation. Old event withdrawal and family cancellation notices remain visible.
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
- Google rejected the isolated Calendar consent request with `redirect_uri_mismatch`. The existing `bgscheduler` OAuth client in project `begifted-scheduling` currently registers only its login callbacks. The two new Calendar callbacks (local test and production) are prepared in Google Cloud, awaiting the owner's confirmation to save. No Calendar token or test event has been created. Production delivery remains disabled.

_This is an execution record for the feature branch, not proof of production rollout._

## Allocation corrections — 2026-09-16

- Migration `0090_sit_in_coverage_scopes.sql` was applied to the verified production Neon database. All five original active grants were still untouched at revision zero; the approved Science and ISEB strand scopes were added with an audit record. Existing manually edited or revoked grants are preserved by the migration. Production had 61 automatic obligations, zero observations and zero reports before reconciliation.
- Validation: `verify:release` passed with **5,098 unit tests across 448 files**, production build, TypeScript and the 276-route guard. **22 focused Postgres integration tests** cover scope isolation, concurrent strand generation, supersession, Science balancing, self-exclusion, manual/booked preservation and revocation while availability loads. Whole-repo ESLint has 19 existing warnings and no errors.
- Desktop and 390×844 mobile checks used real components with isolated synthetic APIs. ISEB strand labels, provisional lesson selection, disabled confirmation, known-student aggregation, separate incomplete-occurrence counts and scope controls passed without horizontal overflow.
- Both Calendar OAuth callbacks were saved after owner confirmation. The isolated Calendar flow now reaches Google's unverified-app warning; completion is awaiting the owner's browser handoff. Production delivery remains disabled until Calendar delivery validation succeeds.
- Google's OAuth audience is still **Testing**. Gift is already enrolled; Ek, Peat, Tito and Mimi were missing. Their enrollment form is prepared and awaits action-time confirmation. This is separate from the application's verified grants.
- Rollout sequence after the code deploy: refresh the core Wise snapshot to populate dated student IDs, refresh shared student data, run the sit-in worker, then inspect Q4 coverage, Science allocation and provisional openings. Never backfill missing dated rosters from another occurrence.
