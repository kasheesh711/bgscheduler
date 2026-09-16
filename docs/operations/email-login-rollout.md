# Email login rollout — 2026-09-16

Email-code login is the first release; Outlook Calendar follows separately.

## Verification

- `npm run verify:release` passed: 5,119 unit tests, production build, both TypeScript checks and the 277-route guard.
- Thirteen PostgreSQL integration tests passed in a disposable local database: single use, concurrent verification, attempt/send limits, expiry, revoked access, failed delivery and pending admissions invitations.
- The real Next.js/Auth.js browser flow was tested using a local Neon HTTP bridge to that database and a fake email relay. A wrong code was rejected; the correct code established Ek's existing observer session and opened Tutor Sit-ins with Physics and General Science access.
- Desktop 1440×1000 and mobile 390×844 form checks passed without horizontal overflow. Unknown addresses receive the same acknowledgement, resend is delayed, and Change email restores the editable form.
- Targeted lint passed. No live inbox receipt is established by these local checks.

## Production sequence

1. Verify the linked BGScheduler project and production database, then apply additive migration `0091_email_code_login`.
2. Verify the configured Apps Script sender; set `AUTH_EMAIL_CODE_ENABLED=true` in Production only.
3. Merge the checked login release and verify its production deployment and provider list.
4. Ek requests a code in his own browser and completes login using the code from his Hotmail inbox. His existing grants remain authoritative.

Rollback: set `AUTH_EMAIL_CODE_ENABLED=false` and redeploy. Google login and existing valid sessions remain available; retain the additive database tables.

## Deployment record

Production migration `0091_email_code_login` was applied on 2026-09-16 after verifying the linked database and existing migration ledger. Ek's existing active observer grant still contains Physics and General Science. Sender verification, flag and deployment are pending. Outlook registration requires an owner Microsoft Entra session and observer consent.
