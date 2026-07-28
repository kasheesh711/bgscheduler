---
quick_id: 260727-pay
slug: payout-runs-publish
date: 2026-07-27
status: complete
source: plan-mode (user-approved)
plan: ~/.claude/plans/why-was-the-plan-breezy-tome.md
branch: feat/payout-runs-publish
worktree: /Users/kevinhsieh/Developer/bgscheduler-payout
---

# Payout runs: finish sections 6-8, and fix the reconciliation that blocks them

Started from "why was the plan not fully executed upon?" about the monthly
payout-run plan. PR #46 shipped sections 1-5 inert and stopped at its own
pre-registered risk gate; the two data prerequisites it named had since got
worse, not better.

## Diagnosis

1. `drive.file` was never consented — all six token rows `f`, the connected
   account's token last refreshed nine minutes before PR #46 merged.
2. Enforcement is `shadow`, so `deductionCandidate` is always false and there
   were zero deduction rows to publish. The plan's "63 deductions" were
   projections.
3. Reconciliation regressed: June 2026 at 0 ready / 1,648 unavailable.
4. Migration `0057` was never applied to production.

Root cause of (3), found in production data rather than in the plan: ten
episodes of `contract_error:global:400` carrying the *unclassified* default
message. `safeWiseIssue` defaulted unmatched errors to `scope: "global"`, and a
global issue ran `UPDATE post_class_sessions SET source_status='unavailable'
WHERE eligible` over the whole table. One per-session Wise 400 demoted ~11k
rows, ten times.

## Shipped (8 commits)

- **A1** migration `0058`, symmetric demote/restore. Demotion stays fail-closed;
  recovery is one statement instead of 50 rows per run.
- **A2** per-session default scope with a prevalence escalation (>=3 breaches
  and >=half the batch) so a genuine Wise contract change still blocks run-wide.
- **A3** resolve on the `{type}:{sessionId}` stem — all 228 open issues were
  `:400` while the list named only `:404` — and a seven-day grace before a
  missing session leaves the retry queue.
- **A4** backfill gets a cron at :23/:53, self-selects its window, and drains on
  `windowCandidateCount` rather than a total that a saturated recheck lane pins
  at the cap.
- **T0** Drive grant surfaced to finance users + `scripts/verify-drive-upload.ts`.
- **C1-C8** the publish path: pure decision module, repository, writer,
  orchestrator, two routes, Payouts tab, and the doc rewrite.

## Deviations from the approved plan

- A1 uses a new column rather than narrowing the UPDATE, because narrowing
  weakens a documented fail-closed rule. Chosen by the user.
- A2 had to change the unclassified default, not just `PostClassWiseSchemaError`;
  the plan's version would not have fixed the observed outage.
- `resolvePayoutRowAction` needs `previouslyAttempted`. Testing found that
  `grid[n]` is undefined past the end, so the last class on every sheet resolved
  to `reuse_blank` and skipped its insert; blankness alone was never sufficient
  evidence of a half-finished insert.

## Verification

`tsc` 0 · `eslint` 0 errors · 3,763 unit · 53 integration · `next build` clean.
Integration ran against local Postgres 14 via the new `TEST_DATABASE_URL`
escape hatch (Docker daemon was down).

## Not done — owner gates

1. ~~Consent `drive.file` and run the probe.~~ **Cleared 2026-07-28.** `drive.file`
   granted to kevhsh7@gmail.com, and it can create a file in a folder the app
   does not own — so no fallback is needed and the broader `drive` scope stays
   off the table. Enabling the Drive API on the Cloud project was a separate
   prerequisite that the plan had not identified.
2. Apply `0057` and `0058` to production.
3. Flip enforcement `shadow` -> `live`.
4. Map tutors to payout spreadsheets via `POST /api/post-class-feedback/payout-sheets`.
5. Verify `insertDimension` against a scratch copy of a real payout sheet before
   any live publish — formulas beyond column H and totals ranges are unproven.
6. Let reconciliation converge; the publish gate correctly refuses today.
