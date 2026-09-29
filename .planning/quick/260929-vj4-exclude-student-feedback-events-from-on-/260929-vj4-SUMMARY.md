---
quick_id: 260929-vj4
status: complete
branch: fix/feedback-timing-student-events
base: origin/main e8e9564
pr: https://github.com/kasheesh711/bgscheduler/pull/104 (draft)
commits:
  - 067a2fc verdict rule D-EVT-05 + display parity
  - 2a6fe9e ledger "Tutor submitted" column (student excluded, legacy-tolerant drift)
  - 7ff459b docs
  - d699273 review fixes (dispute report script parity, whitespace-safe SQL role match)
  - 147f178 docs: reassess not durable against on-time locks
  - (final) review nits: doc line refs, script JSDoc placement
---

# Quick 260929-vj4 Summary: STUDENT feedback events never prove tutor on-time submission

## Confirmed (read-only prod SQL, 2026-09-29)

- Feedback event roles: TEACHER 10,097 · auto 10,093 · ADMIN 8,530 · STUDENT 394 · OWNER 24.
- 38 sessions `on_time` with no non-auto, non-student event at/before the deadline;
  all 38 have a STUDENT event before the deadline (29 shadow, 9 live; 3 not yet due).
- 300 further `on_time` sessions report a student instant as `tutorSubmittedAt`
  (verdict unchanged by the fix).
- 5 written, active ledger rows carry a student instant in "Tutor submitted"
  (2026-09 run: 4, 2026-10 run: 1); amounts are content-violation charges and correct.

## Change

1. `countsAsTutorSubmission(role)` — qualifying = non-auto AND not STUDENT (D-EVT-05);
   D-EVT-04 unchanged for staff roles. Applied in `deriveEventTimingEvidence`,
   `eventProofOutcome` (`student_submitted`), dashboard Submitted column.
2. Payout candidate query excludes STUDENT (`notStudentFeedbackActor()`); drift query
   accepts new OR legacy instant → 0 new drift on 263 prod rows (naive change: 5).
3. docs/features/post-class-feedback.md (D-EVT-05, reassess recovery path, open question 14).

## Not done (owner decisions)

- No reassess `apply`, no deduction creation/approval/waiver, no ledger edits.
- Collector keeps existing on-time locks (17 sessions); the 18 unlocked due sessions
  re-derive as `late` on revisit (label only, same deduction outcome).

## Verification

- policy/detail/reassess unit tests (new cases fail on old code); payout-repository
  integration 66/66 (legacy-tolerance test fails with the clause removed).
- typecheck clean; eslint clean on changed files; full unit 5578/5579 — the single
  failure (`tutor-sit-ins/coverage.test.ts`) also fails on clean origin/main.
- Independent opus review: pass 1 BLOCKERS (doc recovery path not durable — collector
  re-locks on_time via `loadPreviousComplianceLock`; missed rule copy in
  `scripts/report-tutor-feedback-submissions.ts`; SQL whitespace parity) → fixed;
  pass 2 CLEAR (66/66 integration, typecheck clean).
- Reassess dry run with fixed code on a read-only prod session: 11,797 scanned,
  48 would change, 0 waivers; 38 = student-proven list, 10 unrelated (9 shadow
  July `unknown`, 1 race). Any reassess must be targeted by `wiseSessionIds`.

## Follow-up (owner decision)

- Lock supersession: let a later `reassess:` row supersede an earlier on-time lock in
  `loadPreviousComplianceLock` (0 existing sessions affected) so the 17 locked
  student-proven sessions can be re-decided durably.
