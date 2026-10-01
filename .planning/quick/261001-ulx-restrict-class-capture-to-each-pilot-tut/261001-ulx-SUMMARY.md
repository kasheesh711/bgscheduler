---
phase: quick-261001-ulx
plan: 01
status: implemented
requirements: [TUTOR-PILOT-01, TUTOR-PILOT-02, TUTOR-PILOT-03]
---

# Own tutor classes, today in Bangkok

The pilot now supports multiple exact login emails while giving every actor exactly one fresh active tutor-contact key. This includes administrators. Teachers use their existing accounts; no administrator or owner grant is added. Capture storage checks both creator email and tutor key, including direct callers, old owner-created captures, asset access and retries.

The server accepts only today's Bangkok classes for listing and new capture creation, checking again after asynchronous lookup and immediately before insertion. Existing owned, unexpired captures remain recoverable across midnight. The page removes date selection, labels today's list, refreshes at midnight and on visible return, ignores stale responses, and preserves active recording, media and edited drafts.

`CLASS_CAPTURE_PILOT_EMAILS` is a bounded, validated comma-separated list. A present invalid/empty list denies everyone; the legacy singular setting is used only when plural is absent. Production identity preflight verified the requested three tutors' existing exact onsite email bindings. Real addresses are deployment configuration, not repository fixtures.

## Verification

- Tests were written to fail before backend implementation; 551 backend capture/auth/Proxy tests and 18 navigation tests passed after implementation.
- 21 synthetic PostgreSQL integration tests passed for storage, processing and cleanup.
- 24 UI/helper/recorder/recovery tests and 17 synthetic browser acceptance checks passed.
- Full TypeScript check passed on Node 24; scoped ESLint and diff checks were clean. Independent plan, UI and backend reviews found no concrete P1/P2 issues.
- All test fixtures and screenshots use fictional students; no real media or paid provider requests were sent.

See `261001-ulx-VERIFICATION.md` and the release PR for final regression, exact-commit CI and deployment evidence. The current main branch's concurrent Gmail reminder work is retained in the release; this task does not alter it.

## Unverified limits

This correction does not establish real iOS/Android hardware behavior, live private uploads or provider processing/deletion, large upload network recovery, or actual Peat/Ek sign-in sessions. Existing retention, consent, explicit tutor review, manual Wise submission, provider and payroll behavior remain in place. No new migration is introduced.
