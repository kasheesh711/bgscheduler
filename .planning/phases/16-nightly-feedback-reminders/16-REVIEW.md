---
phase: 16-nightly-feedback-reminders
reviewed: 2026-09-28T16:37:10Z
depth: standard
diff_base: 6c720102f14ca0b07e67b5db92aa9c880d91c2b1
files_reviewed: 13
files_reviewed_list:
  - src/lib/post-class-feedback/nightly-reminders.ts
  - src/lib/post-class-feedback/nightly-reminder-model.ts
  - src/lib/post-class-feedback/nightly-reminder-source.ts
  - src/lib/post-class-feedback/nightly-reminder-health.ts
  - src/lib/post-class-feedback/settings.ts
  - src/lib/post-class-feedback/notifications.ts
  - src/lib/post-class-feedback/sync.ts
  - src/lib/classrooms/schedule-email.ts
  - src/lib/wise/fetchers.ts
  - src/lib/db/schema.ts
  - drizzle/0096_nightly_feedback_reminders.sql
  - src/app/api/post-class-feedback/reminders/route.ts
  - src/app/api/internal/post-class-feedback/reminder-nightly/route.ts
findings:
  critical: 0
  warning: 0
  info: 0
  total: 0
status: clean
---

# Phase 16: Code Review Report

**Reviewed:** 2026-09-28T16:37:10Z
**Depth:** standard
**Files reviewed:** 13
**Status:** clean

## Summary

No active correctness or security findings remain in the reviewed implementation after the fixes below were read back. The review covered discovery completeness, freshness and policy checks, tutor grouping, immutable dispatch evidence, retries and uncertain outcomes, cross-night recovery, activation controls, and API access.

The scope was the worktree's current files against `origin/main` at the revision above, including untracked implementation files. Related transaction, policy, identity, authentication, and notification call paths were inspected. The reviewer changed only this report and made no commit.

The clean review applies to this source inspection and the focused checks listed below. The implementer's expanded integration suite and broader gates were still running at this timestamp. Production migration, cron execution, relay delivery, and live cutover were not exercised.

## Resolved findings

The implementer corrected these issues during review. They are recorded for traceability and are excluded from the active finding counts.

1. **Known siblings could be split across tutor digests.** A ready class could dispatch while another known class for the same tutor was blocked. Unattempted queued mail could also exclude a newly discovered sibling. The queue now waits for known unresolved siblings and recomposes unattempted pending mail when membership grows. Attempted content stays frozen; genuinely late discoveries after a send retain the authorized recovery path. Verified at [nightly-reminders.ts:231](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:231).

2. **Uncertain source eligibility could become a permanent exclusion.** Billing evidence failures can produce `eligible = false` alongside an unavailable source. Source readiness and policy currency now precede eligibility classification, keeping those rows blocked and visible. Verified at [nightly-reminder-model.ts:53](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminder-model.ts:53).

3. **Old uncertain deliveries could disappear from health.** Latest-night-only health and an early off-mode return hid unresolved earlier mail. Health now counts uncertain deliveries globally, including stale sending attempts and off mode; history prioritizes unknown rows. The worker reconciles stale sending states before mode/date exits. The transition uses a conditional update, so it cannot overwrite a concurrently accepted delivery. Verified at [nightly-reminder-health.ts:10](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminder-health.ts:10), [nightly-reminders.ts:173](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:173), and [nightly-reminders.ts:403](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:403).

4. **Malformed relay responses could create false sent evidence.** Truthy nonboolean `ok` values and synthesized receipt IDs previously satisfied acceptance. Strict delivery now requires `ok === true` and a nonempty relay receipt. Ambiguous responses stay unknown and cannot trigger automatic backup delivery. Dispatch independently validates the receipt before storing sent status. Verified at [schedule-email.ts:476](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/classrooms/schedule-email.ts:476) and [nightly-reminders.ts:370](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:370).

5. **Fresh timestamps could mask obsolete policy or mapping evidence.** The worker now compares session and assessment versions with current policy/mapping versions, reopens obsolete exclusions, and rechecks configuration when claiming dispatch. Verified at [nightly-reminders.ts:45](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:45), [nightly-reminders.ts:335](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:335), and [nightly-reminders.ts:435](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:435).

6. **Nested acceptance transactions could commit before the audit record.** On the PostgreSQL fallback path, the former inner transaction could commit the outer acceptance changes before audit insertion. Acceptance now uses a transaction-only helper; operator reconciliation calls it inside the same transaction as the audit write. Verified at [nightly-reminders.ts:298](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:298) and [nightly-reminders.ts:476](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:476).

7. **Bounded refresh groups could starve untouched rows.** PostgreSQL's ascending null ordering placed never-checked rows behind repeatedly blocked rows. Explicit `NULLS FIRST` now makes untouched inventory eligible before repeated refreshes. Verified at [nightly-reminders.ts:439](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:439).

8. **Changed inventory could retain stale tutor and deadline evidence.** Conflict-ignore inserts discarded rediscovered changes. Mutable inventory now updates eligible ledger rows and records `inventoryChangedAt`; canonical source evidence must be at least as recent. Freshness checks precede mutable timing exclusions, and refreshed canonical dates update the ledger. Accepted and uncertain records retain their evidence. Verified at [nightly-reminders.ts:62](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:62) and [nightly-reminders.ts:122](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:122), with the matching schema and migration column.

9. **Verified deletion tombstones could remain permanently blocked.** A verified deletion now resolves before freshness checks, avoiding endless refresh attempts for deleted Wise sessions. Verified at [nightly-reminder-model.ts:54](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminder-model.ts:54).

10. **Blocked history lacked usable identity, and recipient details needed access scoping.** History now includes Wise session ID, class, and end time even when canonical import failed. Recipient email is selected only for callers with access-management rights; the default returns null. Verified at [nightly-reminder-health.ts:83](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminder-health.ts:83) and the reminders GET capability handoff.

11. **The admin worker route lacked its required execution budget.** The route now exports the same 800-second maximum duration as the internal worker route. Verified at [reminders/route.ts:12](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/app/api/post-class-feedback/reminders/route.ts:12).

12. **Shadow completion could attest configuration it had not processed.** Completion now records the policy/mapping versions captured at worker start and requires them still to match. First live activation rejects simultaneous mapping changes and requires recent matching shadow evidence, both sender test receipts, and legacy-trigger confirmation. Shadow-preview execution rejects live mode. Verified at [nightly-reminders.ts:377](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/nightly-reminders.ts:377) and [settings.ts:134](/Users/kevinhsieh/.codex/worktrees/nightly-feedback-reminders/Scheduling/src/lib/post-class-feedback/settings.ts:134).

Additional readback confirmed same-clock lease reclaim, lease release on failure, stable delivery keys for known-rejection retries, identity/content checks before retries, and exclusion of nightly deliveries from the generic retry processor. The new reminder flow does not add a historical deduction repair or payout publication path.

## Validation

- **Passed:** focused `nightly-reminders.test.ts` suite, 6 tests. Coverage includes Bangkok timing, freshness/compliance boundaries, complete discovery beyond 14,221 rows, invalid/duplicate pagination, and local-date filtering.
- **Passed:** offline execution of the actual strict sender with mocked fetch. `{ok: "false"}` and `{ok: true}` without a receipt are rejected; a true success with a receipt is accepted. No network request or email was made.
- **Passed:** offline model checks for ambiguous eligibility and stale timing evidence remaining blocked.
- **Reproduced and resolved by source readback:** nested transaction commit ordering, using an offline mock PostgreSQL client.
- **Passed:** `git diff --check` after the final fixes.
- **Pending at review time:** implementer-run expanded 16-case integration suite, full unit suite, typecheck, and lint. The implementer reported the initial eight integration cases passed; those results were not independently rerun here.

No live database, Wise mutation, outbound email, deployment, or cutover was performed by this review.

---

_Reviewer: Codex (gsd-code-reviewer)_
_Depth: standard_

## Implementer release verification

- Full release gate passed: typecheck, 468 unit suites / 5,407 tests, production build, second typecheck, whitespace check and 280-route surface guard.
- Nightly Postgres integration suite: 18/18 passed.
- Final focused regression check after the last disposition change: 63/63 passed.
- ESLint passed with pre-existing repository warnings; the new file's unused import was removed.
- Migration 0096 applied to production with reminders still off and enforcement still live. Live delivery and the seven-night observation period remain rollout steps.

- Existing financial/source regression suites: 50/50 Postgres integration tests passed.
