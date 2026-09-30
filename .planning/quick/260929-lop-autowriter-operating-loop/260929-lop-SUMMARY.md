---
quick_id: 260929-lop
pr: kasheesh711/bgscheduler#105 (draft)
branch: feat/autowriter-loop-phase1
---

# Summary — autowriter operating loop, Phase 1 (PR #105)

Earlier rounds are in the branch's commits: 2920352 (the first review's 28 findings), d9c5e1a (the owner's 30 Sep
decisions D-01 / D-02 / D-03; migration renumbered to 0101) and 394dc67 (merge of origin/main: #107 accuracy v4 and
#108 Sol writer; journal entries 99, 100, 101 in that order).

## Re-review fixes (30 Sep, pre-14:00)

The independent re-review's verdict was CLEAR, with one MEDIUM and several LOWs. The #108 reviewer added two items.

| Finding | Change | Test |
|---|---|---|
| **MEDIUM**: the sweep stamps `tutor_off_at_deadline` from the switches when it runs (:08/:22/:38/:52, not while the mode is `off`). A tutor switched off after the class's window closed therefore turned a miss into `excluded_tutor_off`. | `quality.ts`: `postingWindowEligibility` returns `tutorOffAtWindowEnd`, read from the control history in effect when the window closed. `classifyCoverage` leaves a hand-back out only when that is true (D-03, however long the class was workable). Otherwise the hand-back counts like the expiry it replaced: `miss_expired`, or excluded when the switches never let us write the class. | `quality.test.ts`: the new "a deadline hand-back" block. Switched off 5 min after close → miss. Mode off, tutor off, live again → miss. No history → miss. Switched off before close, or at its last instant → excluded. Mode off at close: never live → `excluded_not_live`; live earlier with the tutor on → miss, the same as the expired row. Also a new `tutorOffAtWindowEnd` test (boundary ±1 ms, another tutor, null teacher). `review.integration.test.ts` (D-03 test): Ek switched off at 16:35Z on the 28th. His class of the 26th (window closed 16:29:59Z) → `expired` 1. His class of the 27th → `excludedTutorOff` 1. Mutation (the reviewed one-liner restored): 4 unit tests and this integration test fail. |
| LOW: `student_id_missing` (POST precheck) is the same fact as `student_not_wise_user`. | Added to `DATA_QUALITY_REASONS` ("Student not a Wise user (POST check)"). | `quality.test.ts` (both reason tables and the label list); the integration D-03 test now holds 8 data-quality reasons. Mutation: 3 fail. |
| LOW: a fractional `absolutePercentAttendance` gave `attendance_42.5pct`, which neither regex matches. | `session.ts`: the reason uses `Math.floor` (42.5 → `attendance_42pct`); the threshold still compares the raw value. | `session.test.ts`: 42.5 → `attendance_42pct`, 49.9 → `attendance_49pct`, 50 passes. Disposition is retry at 30 min and person at 90 min. Coverage: `excluded_data_quality`. `quality.test.ts`: `attendance_42.5pct` → `miss_held`. Mutation: 1 fails. |
| LOW: the version constants were not explained. | One-line comment at `QUALITY_POLICY_VERSION` and `FIX_EVENT_CLASSIFIER_VERSION`: v1 = the owner's 30 Sep rules. Not bumped. | None needed: comment only. |
| LOW: the docs hardcoded the gate boundary (12/13 Oct). | Feature doc and runbook now say: blocked through the critical class's Bangkok date + 13 days (the dry run prints the date). Daily rows recorded before `--apply` show not-pass rather than `blocked_critical`. | None needed: docs only. |
| LOW: the migration runbook did not explain the numbering. | Runbook step 1: 0100 (Sol, `when` 1790735838903, below 0099's because it was applied as "0099") and 0101 (`when` 1790740000000, above every applied entry, so `db:migrate` applies only 0101). `db:generate` numbers from the last entry's `idx`, so the journal stays sorted. #108 merged: origin/main merged in (394dc67). | The journal is sorted by `idx` and every SQL file exists. Testcontainers migrate the whole journal. |
| #108 review: the review queue named every non-Luna first draft "GLM Flash". The dashboard merge conflict also had to keep ARM_LABEL. | `ARM_LABEL` moves to `src/components/feedback-autowriter/model-labels.ts`, shared by the dashboard and the review queue (no import cycle). The review queue shows `ARM_LABEL[arm]`, falling back to the raw arm. The merge kept #108's `ARM_LABEL` cell in the dashboard. | `feedback-autowriter-review.test.tsx`: a `sol` first draft reads "GPT-6.1 Sol" and never "GLM Flash"; `luna` and `glm` keep their labels. Mutation (old ternary): 1 fails. |

**Judgement call.** The review suggested excluding a hand-back when the mode was not live as the window closed. That
matches the existing semantics only when the class was never workable, and then it is excluded, as `excluded_not_live`.
If the mode was live earlier with the tutor on, the same class left to expire counts as a miss. Excluding its hand-back
would again let a switch made after the window decide the class. So only the tutor's own switch as the window closed
excludes a hand-back.

The reverse case stays as it was, fail-closed. A tutor off at the window's end but switched back on before the sweep
gives an `expired` row, which still counts as a miss.

**Production check** (read-only aggregate, 30 Sep ~11:45 Bangkok):
- No `tutor_off_at_deadline` and no `student_id_missing` rows; the one attendance hold is `attendance_0pct`. No current
  number moves.
- The control row is `live` with no tutor off, last changed 2026-09-29 08:07:30 UTC. That is what migration 0101 seeds
  as the control history.

**Verification.**
- Unit: `npx vitest run --project unit src/lib/feedback-autowriter src/components/feedback-autowriter src/app/api/feedback-autowriter src/__tests__` → 24 files, 455 tests passed.
- Integration: `npx vitest run --project integration src/lib/feedback-autowriter` (Testcontainers, OrbStack) → 3 files, 133 tests passed.
- `npm run typecheck`, `npx eslint src/lib/feedback-autowriter src/components/feedback-autowriter` and `git diff --check`: clean.
