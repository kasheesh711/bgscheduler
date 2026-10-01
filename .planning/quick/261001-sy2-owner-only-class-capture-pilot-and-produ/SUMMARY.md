# Owner-only capture pilot and production release

The owner explicitly requested a private pilot and a live release for October 2, 2026 (Bangkok). This supersedes the earlier draft-only release boundary; no new credentials, grants, subscriptions, security changes, or real-person test recordings are authorized.

## Implementation

- One exact `CLASS_CAPTURE_PILOT_EMAIL` must also be an existing designated superadmin. A fresh active admin row, matching session access version, and current page grant are required on every entry point. Missing or malformed configuration denies access. Other admins and all tutors are excluded.
- Page, navigation, and all 12 capture API handlers share the gate, including deletion. Capture ownership and current class/student checks remain intact.
- The existing scheduled route now persists nonsecret `captureRetention*` scalar counters in its audit digest. This distinguishes a successful enabled sweep from disabled cleanup without triggering unrelated autowriter work on demand.
- Focused owner/auth/proxy/navigation checks: 9 files, 313 passing tests. Retention route/audit checks: 13 passing tests. Scoped ESLint and whitespace checks pass. Independent source review found no P1/P2 access bypass. Exact release CI belongs to PR #133.

## Production preflight

- Vercel project `bgscheduler` remains linked to the existing repository's main branch. Its five required CI checks remain required; no branch protection bypass.
- Metadata-only inspection verified the existing Blob store is private, available, and within quota. Hosted Soniox/OpenRouter credentials are present; recent existing operations succeeded on the configured Soniox and writer models. No transcripts or student media were inspected or sent for these checks.
- The existing signed-in owner session matches an enabled full-grant admin row and current access version.
- The migration ledger was at 0107. Only 0108 was applied, in a transaction that refuses a changed baseline. Its SHA-256 is `af599256cfb89bfcd4cb5709f013950d460516a8744521737ddf65c505510475`; both new tables were verified empty afterward.
- Production pilot email and retention flags are configured. Capture and paid processing are initially false; those values are not yet proof of the running deployment's configuration.
- Existing scheduled feedback-autowriter invocations run every 14–16 minutes and were healthy before release. A completed post-release capture retention sweep and synthetic deletion check must be observed before activation.

## Release record and limits

Record the exact checked/merged commit, production deployment, post-release retention counters, owner-page check, activation, and any blockers in [PR #133](https://github.com/kasheesh711/bgscheduler/pull/133). Do not call the pilot live from configuration metadata alone.

The local Vercel CLI synthetic upload did not create an object: its existing OIDC/store configuration was incomplete. No token or store was created to work around it. Runtime storage/provider checks must use existing authorized interfaces. Real iOS/Android recording, interruption behavior, provider private-file transcription, and large-upload recovery remain separate from mocked browser acceptance. No real people were recorded; no real student media was transmitted.
