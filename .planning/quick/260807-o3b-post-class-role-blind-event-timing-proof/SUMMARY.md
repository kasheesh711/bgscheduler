---
status: complete
quick_id: 260807-o3b
date: 2026-08-07
---

# Post-class feedback: role-blind event timing proof

## Problem

Session `6a6b1450b03fafaaa1851041` (Jake (Jake.Ev) Evans, tutor Kevin) carried a
`late` verdict and a `pending_review` ฿100 deduction despite the feedback being
submitted 17m54s before its deadline.

The report framed this as a cron-timing problem — a submission at 23:45 landing
between the `13,43` collector runs. It was not. Timing is derived from Wise's
immutable `event_timestamp`, never from our observation time, so no cron cadence
or grace window could have changed the verdict.

The actual cause: `deriveEventTimingEvidence` accepted an event as proof only
when `actorRole === "TEACHER"`. Wise stamps `actorRole` from the *account's*
role, not from authorship. Kevin holds an admin account, so his own submission
was recorded `ADMIN`, discarded, and rule 3 ("no qualifying event, deadline
inside coverage → proves late") fired.

Evidence from production:

| | |
|---|---|
| Deadline | 2026-08-05 23:59:59.999 Bangkok |
| `SessionFeedbackSubmittedEvent` | 2026-08-05 **23:42:05.728** Bangkok |
| Event `actor_wise_user_id` | `695369c028118f629edcb986` |
| Session `wise_teacher_user_id` | `695369c028118f629edcb986` — same person |
| Event `actor_role` | `ADMIN` |
| Verdict | `late` / `wise_activity_event_no_tutor_submission` |

## Decision

The qualifying rule is now **role-blind** (D-EVT-04): any event Wise did not
auto-submit proves `on_time` when it lands at or before the deadline.

Chosen explicitly after the measured alternatives were presented. The accepted
consequence — recorded so it is not rediscovered as a bug — is that feedback
written by a *different* admin on a tutor's behalf, or by a student actor, now
counts as the tutor's on-time proof. `AUTO` is still excluded and the content
bar is untouched, so weak feedback still fails independently of timing.

`policy_version` was deliberately not bumped: the event `on_time` branch runs
before the previous-violation-lock branch (D-EVT-02), so new evidence clears an
old lock without stranding the ~5,900 existing on-time locks.

## Commits

| Commit | Change |
|---|---|
| `fddba89` | Role-blind qualifying rule in `deriveEventTimingEvidence` |
| `fa29c52` | Wise activity mirror moved to `2,17,32,47` (15-minute cadence) |
| `71f1a21` | Timing evidence timeline, Wise-session-id lookup, dashboard column |
| `a80e640` | `reassessPostClassSessions` + `mode: "reassess"` on the sync route |

## Production outcome

Reassess run 2026-08-07, dry run first, then applied:

- 1,621 `late` sessions scanned, **871 flipped to `on_time`**, 0 failures.
- `on_time` 5,923 → 6,794; `late` 1,621 → 750.
- 4 `pending_review` deductions waived (all Kevin), each with an audited
  `system:post-class-reassess` action row.
- The reported session: `on_time`, deduction `waived`, `timing_evidence =
  wise_activity_event_before_deadline`, proven at `2026-08-05T16:42:05.728Z`.

Largest movers: Mimi 568, Gift 112, Kevin 104 — all tutors whose Wise accounts
carry a non-`TEACHER` role.

## Notes for later

- The cron move is freshness only. End-to-end pre-deadline *detection* would
  also need a post-class collector run between the mirror and midnight; the
  collector schedule (`13,43`) is unchanged.
- `timing_evidence` still emits the string `wise_activity_event_no_tutor_submission`
  for the late case. Kept verbatim because it is persisted on every historical
  assessment row; it now means "no qualifying human submission before the
  deadline".
- The reassess pass is verdict-only by design. It never rewrites identity,
  eligibility, participants, or content, because it holds no fresher evidence
  for any of them than the row already carries.
