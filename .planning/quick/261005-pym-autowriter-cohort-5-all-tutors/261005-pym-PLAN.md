---
quick_id: 261005-pym
slug: autowriter-cohort-5-all-tutors
date: 2026-10-05
---

# Feedback autowriter: roll out to all tutors (cohort 5)

## Context
The autowriter writes Wise teacher feedback for online 1:1 classes, but only for tutors on a hardcoded roster
(`src/lib/feedback-autowriter/roster.ts`). There are 27 tutors (54 accounts) on it now, covering about 725 of 839
online classes in 30 days (86%). Kevin wants every tutor covered.

Owner decisions (5 Oct 2026):
- **Roll out now, as-is.** This overrides the operating-loop rule "expand only after the gate passes" (the 14-day lower
  bound is 75.6% against an 80% target). `FEEDBACK_AUTOWRITER_HOLD_SUMMARY_ONLY` is not turned on.
- **Scope:** everyone teaching online today goes into a hardcoded cohort 5, the same proven path as #96, #138 and #142.
  A dashboard flag lists any online tutor still missing from the roster, so future hires get added. No dynamic roster.
- **Writer:** Luna first, Sol as fallback (`writer: "luna"`), the same as cohorts 3 and 4.
- **Go-live:** tutors are live when the change deploys (they default to on; `disabled_tutors` is a deny-list). Kevin
  tells the tutors himself.

## Step 0: list the remaining tutors (production read, needs Kevin's approval)
The auto-mode classifier blocked the read-only production query during planning. When we execute, Kevin approves it or
runs it himself. The query reuses the cohort 4 recipe:
- Source: `credit_control_sessions` on the active `credit_control_snapshots` row, last 30 days.
- Online classes: title `Live Session%` or `Online Session%`, excluding `%(Cancel%`.
- Group by `wise_teacher_user_id`, keep those NOT in `AUTOWRITER_TEACHER_ALLOWLIST`, and compute classes, 1:1 classes
  and 1:1 hours.
- For each of those tutors, look up both Wise accounts (the "… Online" account and the main one), the display name and
  the canonical key in `tutor_identity_group_members` / `tutor_identity_groups` on the active `snapshots` row. A main
  account may hold 0 online classes but is still added, as in earlier cohorts.
- Known next in line: Tito, Shop, Petch-Than, Praew, Tai, plus the long tail.

## Step 1: code changes (one PR, branch `feat/autowriter-cohort-5`, slot-a or slot-b, through `/gsd-quick`)

1. **`src/lib/feedback-autowriter/roster.ts`**
   - Append a "cohort 5 — all remaining online tutors (owner decision 2026-10-05)" block. Each entry gets both accounts,
     `writer: "luna"` and the canonical key the snapshot uses.
   - The block comment records the hours ranking and the roster's share of online classes before and after.
   - `tutorNames` rule: always the full legal name. Add the nickname only when it is not an ordinary English word,
     not a subject shorthand and longer than 2 characters, because redaction is a case-insensitive whole-word match
     (precedents: "A" and "Eng" were excluded). "Shop" and "Tai" are likely exclusions. Each exclusion is named in the
     comment.
   - A tutor with only one Wise account is listed once and named in the comment.
2. **Uncovered-tutor flag (no migration).**
   - A server-only read in `review-data.ts`, placed next to the gate facts: online classes from the last 14 days on the
     active credit-control snapshot whose teacher is not in `AUTOWRITER_TEACHER_ALLOWLIST`.
   - It returns `uncoveredTutors: Array<{ wiseUserId, teacherName, classes }>`.
   - Uses `db: Database = getDb()` and the same title filter as Step 0.
   - **`src/components/feedback-autowriter/system-details.tsx:118`:** replace the obsolete line "Roster: N → next step
     +50% once the gate passes" with "Roster: N tutors · all online tutors covered", or a warning that lists the
     uncovered tutors with their class counts.
   - `nextExpansionSize` stays exported (quality.ts uses it) but drops out of the UI. Remove it from the payload if
     nothing else reads it.
3. **Tests that pin the roster size:**
   - `__tests__/roster.test.ts`: length 27 → N, and the two-accounts rule allows the named single-account exceptions.
   - `dashboard.test`: tutor order.
   - `review-data.test`: `currentTutors`.
   - `review.integration.test.ts:670`: `15 * 28` → `15 * (N + 1)`.
   - The component fixture `src/components/feedback-autowriter/__tests__/fixtures.ts:380`.
   - New unit tests for the uncovered-tutor read and its two UI states.
4. **Docs:**
   - The roster line in `docs/features/` and `docs/operations/` for the autowriter: all online tutors, how to add a new
     hire (append a roster entry with both accounts; the dashboard flag tells you when).
   - Note the owner override of the gate.

Nothing changes in job.ts, submit.ts, store.ts or session.ts. They all read the roster through
`AUTOWRITER_TEACHER_ALLOWLIST`, `rosterTutor` and `AUTOWRITER_TUTORS`, so new entries flow through scope gating,
redaction, tutor self-detection, the dashboard switches and the trends automatically.

## Step 2: verify
- `npm test -- src/lib/feedback-autowriter src/components/feedback-autowriter` (use node 22 from
  `/opt/homebrew/opt/node@22/bin`; local node 20 fails `Map.groupBy`).
- `npm run test:integration -- review.integration` with Docker.
- `npm run typecheck` and `npm run lint`.
- Redaction spot check: a unit test asserts that ordinary lesson text ("shop", "a", "English") passes through
  unchanged with the full roster loaded.
- Open as a **draft** PR (the rule from memory: Kevin may enable auto-merge). Then do a code-review pass, move it to
  ready, `gh pr update-branch`, wait for the 5 checks, and Kevin merges (CODEOWNERS).
- After deploy:
  - Dashboard: the tutors table shows N tutors, all on, and the uncovered flag reads "all covered".
  - The first posts for cohort 5 tutors show up in the 100% review queue.
  - The webhook and the 15-minute backstop pick up a new tutor's class (`ensureSessionRow` trigger).
  - The nightly audit covers them.

## Step 3: wrap-up
- Update memory: `feedback-autowriter.md` (roster 27 → N, cohort 5, gate override) and `autowriter-operating-loop.md`
  (expansion rule superseded).
- Remind Kevin: tell the tutors. Volume rises about 16% (+~114 classes/30d), which also raises nightly audit cost and
  review load by the same amount.
