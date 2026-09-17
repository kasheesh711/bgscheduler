# Classroom owner restriction and automation shutdown

The emergency policy allows only `kevhsh7@gmail.com` to manually sync Wise, generate classroom assignments or publish room locations. Existing owner configuration, enabled-account state and session access version are checked on every protected operation. Automatic execution is disabled unless `WISE_CLASSROOM_AUTOMATION_ENABLED` is exactly `true`.

## Deploy and contain pending work

1. Deploy the restriction through the normal checked release process. Use an isolated worktree when the primary checkout has unrelated changes. The production environment flag must be absent or explicitly `false`; preserve `SUPER_ADMIN_EMAILS` and Kevin's enabled account.
2. Authenticate to each of the five affected internal routes with the cron secret and verify HTTP 200 with `skipped: true`, `paused: true`, and `reason: "AUTOMATION_PAUSED"`. Never print the bearer or environment values. Data Health should show the five jobs as Paused.
3. Run `scripts/stop-nonowner-classroom-publications.ts` using Node 24, `tsx`, the repository tsconfig and a private production env file. It defaults to a read-only inventory. Run with `--apply` to close pending/running jobs whose creator is not Kevin. Save both JSON results privately as the operational record.
4. The transaction preserves counters and publication rows, records the shutdown reason, and invalidates job claim tokens and the matching singleton worker lease. Completed jobs and Kevin's jobs are preserved. An HTTP request already accepted by Wise cannot be recalled; review any interrupted temporary room moves before manually publishing again.
5. Inspect pre-deployment `cron_invocations`, `sync_runs`, publication leases and deployment runtime logs. Wait for earlier functions to terminate (the longest affected route allows 800 seconds); do not mark a still-running sync failed merely to bypass its single-flight guard. Re-run the publication inventory and idempotent `--apply` sweep after old functions have ended. Declare the shutdown complete only after that check.

## Verify permissions

Test owner and non-owner sessions against the page and the manual sync, assignment run, publish, internal session fallback and Data Health routes. Other users' existing browser tabs must receive 403 when they attempt these operations. Unauthenticated action API requests return JSON 401, including requests with no cookie; the page still redirects unauthenticated visitors to login. Use invalid input/nonexistent IDs for owner validation without running a real sync or publishing to Wise.

The page derives owner controls on the server behind Suspense. The force-reassign, run and publish controls are absent for other users. Viewing, refreshing saved data, printing, overrides and manual schedule emails keep their existing access. Tutor room-booking refresh and other Wise integrations are outside the pause.

## Manual publication during the pause

Kevin's authenticated manual publisher still starts a background attempt on request. A retryable Wise failure leaves that owner job pending with its cooldown intact. Automatic recovery remains paused; the dialog enables **Retry publish** after the cooldown. Reopening the page must not leave the retry permanently disabled. A manual retry reuses the pending job and retains the normal single-worker lease and live Wise read-back safeguards.

## Re-enable only on explicit instruction

Set `WISE_CLASSROOM_AUTOMATION_ENABLED=true` and deploy to resume the five schedules together: Wise snapshot sync, next-day classroom preparation, publish recovery, classroom schedule email delivery, and weekend readiness checks/alerts. Review saved plans and remaining Kevin-created pending jobs first, because eligible pending jobs can resume. Stopped jobs remain failed and cannot silently restart. Manual access stays exclusive to Kevin even after automation is re-enabled.

Do not roll back to code predating the restriction to recover an unrelated issue: that would restore access for other admins and background execution.
