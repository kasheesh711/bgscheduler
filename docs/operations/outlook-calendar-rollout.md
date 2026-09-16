# Outlook Calendar rollout — 2026-09-16

Email login is already released separately ([record](email-login-rollout.md)). Outlook implementation is gated independently. Keep Microsoft disabled until the registration and recipient-scoped checks below succeed.

## Microsoft registration

An owner must sign in to Microsoft Entra and register a **confidential Web application** with supported accounts **Accounts in any organizational directory and personal Microsoft accounts**. No app-only permissions are needed.

- Production redirect URI: `https://bgscheduler.vercel.app/api/tutor-sit-ins/calendar/microsoft/callback`
- Delegated Graph permissions: `User.Read`, `Calendars.ReadWrite`; OAuth also requests `openid`, `email`, `offline_access`.
- The code uses the `common` authority, authorization-code flow, PKCE, and an encrypted ten-minute browser state cookie bound to the signed-in app user and selected provider.
- Put the client ID and client secret into Vercel **Production** as `TUTOR_SIT_INS_MICROSOFT_CLIENT_ID` and `TUTOR_SIT_INS_MICROSOFT_CLIENT_SECRET`. Record the secret's expiry with the owner. Never put either production credential into a preview deployment or this repository.
- Apply additive migration `0092_sit_in_calendar_providers.sql` before deploying provider code. Existing Google tokens, calendars, event IDs and grants are preserved.
- Set `TUTOR_SIT_INS_MICROSOFT_ENABLED=true` only for the recipient-scoped activation checks. Keep `TUTOR_SIT_INS_TEST_RECIPIENTS` limited to the verified calendar owner, test tutor and approved staff recipients. Existing delivery controls must also be enabled for invitations.

The Microsoft account is verified through Graph `/me`. Its identity controls calendar operations only; existing website grants still control roles and accessible pages. Each observer consents to one account, then selects calendars within it. A reconnect to the same identity retains selection. A different provider/account resets selection only when no future bookings or unfinished calendar jobs depend on the previous connection.

## Required live acceptance

Record actual evidence; local fixtures do not establish any item below.

| Check | Evidence to record | Status |
|---|---|---|
| Personal Hotmail connection | Observer consent, verified mailbox and owned primary calendar | Pending registration and observer consent |
| Work/school connection | Organizational account and tenant consent behavior | Pending |
| Conflicts | Recurrence, all-day, Bangkok midnight, overlapping personal event, secondary selected calendar | Pending |
| Invitation | Recipient-scoped tutor receives one private event; app records immutable ID after readback | Pending |
| Retry | Simulated uncertain creation recovers marker without a second invitation | Pending |
| Cancellation | Tutor receives cancellation; retry after deletion completes safely | Pending |
| External edits/deletion | Existing booking becomes visible as needing rescheduling; history stays intact | Pending |
| Refresh | Expired access token refreshes and rotated refresh token is persisted | Pending |

Recipient evidence, permission consent and delivery cannot be manufactured by database tests. The Entra sign-in step currently needs the account owner.

## Automated and browser verification

Run `npm run test:integration -- src/lib/tutor-sit-ins/__tests__/workflow.integration.test.ts` against disposable PostgreSQL. It includes historical migration preservation, uncertain creation, cancellation retry with the rollout flag disabled, refresh rotation, account/provider switching, operation locks and existing Google lifecycle coverage.

The Microsoft provider unit suite covers pagination, recurrence instances, all-day/timezone boundaries, unknown/free/cancelled status, exact-event exclusion, incomplete reads, inaccessible calendars, outages, owned destinations, immutable IDs and verification before delivery. Callback tests cover Google compatibility, Microsoft PKCE, consent cancellation, state/provider/session binding and preview blocking.

Before each release, run targeted lint and `npm run verify:release`, and verify desktop/mobile calendar setup. Release results are recorded below after completion.

## Rollback and monitoring

Set `TUTOR_SIT_INS_MICROSOFT_ENABLED=false` and redeploy to stop new Outlook connections/bookings. Keep Microsoft credentials and existing connection rows: refresh, reconciliation and cancellation of recorded Microsoft events must continue. Google stays available. Do not roll the database back or deploy the old Google-only worker once Microsoft observations exist.

Provider errors are redacted to HTTP status or a safe generic message; delivery jobs retain retry count, last error and observation status. OAuth codes, access/refresh tokens, personal calendar event bodies and authentication codes must never be logged. Existing Data Health/cron supervision monitors the worker.

## Release record

Provider implementation: commit `b61ac32`, [PR #79](https://github.com/kasheesh711/bgscheduler/pull/79). Email login is live independently via PR #78.

- `npm run verify:release` passed: 452 unit files / 5,142 tests, production build, both TypeScript checks, diff check and 278-route guard.
- Focused provider/feature tests: 97 unit tests and 31 PostgreSQL integration tests passed. Targeted lint passed.
- The real local Next/Auth.js flow established Ek's synthetic Physics/General Science session. The provider chooser, connected Outlook identity and owned destination selection/save worked. Browser DOM checks at 390×844 and 1440×1000 showed no horizontal overflow. These checks used a fake relay and fake Graph responses, not a live Microsoft account.
- Migration `0092_sit_in_calendar_providers` is applied to production. Existing ciphertext, selection and event-ID values compared unchanged. There were zero production calendar connections; populated historical Google backfill was exercised separately in PostgreSQL fixtures.
- Microsoft app registration, production credentials and recipient-scoped live acceptance remain pending. Microsoft and external Calendar delivery remain disabled.

A newer approved Wise-only scheduling change follows this provider release. That change removes personal-calendar availability reads and conflict selection from the workflow, and makes confirmation, staff communication and reports independent of Calendar delivery. Its integration record will supersede the availability-specific acceptance rows above.

## Protocol references

- [Calendar view and recurring occurrences](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)
- [Event transactionId and properties](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0)
- [Immutable Outlook IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)
- [Authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
