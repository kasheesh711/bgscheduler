# Tutor Offboarding PR 2 — user-operated removal

Owner authorization: 1 October 2026. Kevin approved production deployment and explicitly requested removal controls that he operates. The implementation agent must not remove any account, including a probe account.

Continue the approved `2026-10-01-tutor-offboarding-design.md`, sections 6–12. PR 1 is merged as `eb4d56b`; migration 0102 is applied. Work in slot-a on `codex/tutor-offboarding-removal`. Do not run local production builds or `db:generate`.

## Required behavior

- Selection respects existing score/removal eligibility, all exclusions, freshness, and person-level account grouping. Source confirmations bypass none of these.
- Preview rechecks fresh database eligibility, the live roster and complete upcoming sessions, and records an immutable 15-minute plan/token. An unsafe account blocks the entire person's removal; never partially remove an active person's variants.
- Confirm requires the saved token, explicit confirmation, an account count and a reason of at least ten characters. Re-read the capability grant. Use a database compare-and-set and the global single-applying constraint.
- Recheck roster and upcoming sessions immediately before execution. No new or changed account, staff account, class, exclusion or capability may slip through from an old preview.
- Each removal request is sent at most once through a dedicated no-retry Wise client. Persist `sending` before POST. Unknown outcomes are settled only by roster readback, never resent.
- Live writes require both `WISE_TEACHER_REMOVAL_VERIFIED=true` and `VERCEL_ENV=production`. Otherwise provide an explicit manual Wise checklist. Do not silently change a plan between manual and live mode.
- Record per-account audit snapshots, statuses and safe errors. Finalize partial failures truthfully. Provide read-only-in-Wise reconciliation for pending/unknown/manual outcomes and interrupted runs.
- Deactivate local contacts/profiles only when every account belonging to that person is proved absent. Restore the saved values on reappearance. Run reconciliation after successful roster sync; never add a background removal call.
- Ship the guarded dummy-teacher probe script from the spec and instructions for Kevin. Do not run it or enable the verified flag without recorded successful owner verification.

## Parallel ownership

1. Core: removal types, service/store/Wise helper, reconciliation, sync hook, probe script and meaningful unit/integration tests. Publish interfaces early.
2. API/schema/docs: migration 0104 and schema, four removal routes plus reconcile endpoint, route tests, feature/API/DB/env docs. Coordinate table interfaces with core before implementation.
3. UI: selection and eligibility explanation, preview/confirm dialog, manual/live mode wording, result/history and reconciliation controls; fixture renders and tests. Coordinate types with core.
4. Primary agent: production rollout of PR 1; independent integration/security review; required checks, fixture/browser verification, migration B, reviewed PR 2 publication and deployment. Never issue any removal POST.

## Release gates

Use fictional fixtures. Keep logs free of credentials and raw query/HTTP error bodies. Preserve unrelated work. Commit explicit paths only. Test expiry, mismatch, simultaneous apply, permission revocation, live drift/classes, no-retry unknown outcomes, manual mode, partial readback, local cleanup and restoration. Independent complementary reviews must cover code not authored by each reviewer; fix all important findings.

Run typecheck, lint, full unit suite, the relevant Testcontainers integration suites, diff and route-surface checks. CI performs the build. Inspect actual desktop/mobile renders and interactions. Apply the additive migration before merging dependent code. Verify deployed commit, runtime route access, source health and manual mode. No test may remove a real or dummy Wise account.
