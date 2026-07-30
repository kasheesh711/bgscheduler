---
quick_id: 260727-pay
slug: payout-runs-publish
date: 2026-07-27
status: complete
superseded: 2026-07-29-dedicated-payout-tabs
source: plan-mode (user-approved)
plan: ~/.claude/plans/why-was-the-plan-breezy-tome.md
branch: feat/payout-runs-publish
worktree: /Users/kevinhsieh/Developer/bgscheduler-payout
---

# Payout runs: finish sections 6-8, and fix the reconciliation that blocks them

> **Historical implementation record — superseded 2026-07-29.** The verification
> counts and owner gates below describe the original per-tutor row-insertion
> path through the earlier payout commits. They are not current-HEAD release
> evidence. Production inspection proved tutor `Payouts` tabs are
> `QUERY(IMPORTRANGE(...))` arrays, so inserting into them would break the view.
> The approved replacement uses a finance-refreshed read-only source tab, an
> app-owned append-only `Feedback Deductions` tab, and a formula-backed
> `Payouts With Deductions` composite imported by tutor workbooks. See
> `docs/features/post-class-feedback.md` for the current rollout contract.

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

## Historical owner gates (do not use as the current rollout checklist)

1. ~~Consent `drive.file` and run the probe.~~ **Cleared 2026-07-28.** `drive.file`
   granted to kevhsh7@gmail.com, and it can create a file in a folder the app
   does not own — so no fallback is needed and the broader `drive` scope stays
   off the table. Enabling the Drive API on the Cloud project was a separate
   prerequisite that the plan had not identified.
2. Apply `0057` and `0058` to production. **Historical only:** the current
   rollout also requires `0059` and `0060`.
3. Flip enforcement `shadow` -> `live`.
4. ~~Map tutors to payout spreadsheets.~~ Superseded by exact canonical tutor →
   source-ledger identity mappings; no runtime per-tutor workbook write exists.
5. ~~Verify `insertDimension`.~~ Superseded. The dedicated adjustment tab is
   append-only; tutor arrays must instead be cut over to the formula-backed composite
   and verified recursively from the configured workbook-inventory folder.
6. Let reconciliation converge; the current preview/publish gate counts every
   non-ready source state and requires an explicit audited acknowledgement.

Current rollout additionally requires the lifecycle/dedicated-tab migration,
strict environment target validation, the default-off payout write switch,
durable publishing single-flight, preview tokens, exact tutor canaries,
CSV-only retry, post-close correction handling, current-head tests, and
scratch/production formula evidence. The feature guide owns the ordered list.
