---
phase: quick-260930-av4
plan: "01"
status: complete
subsystem: feedback-autowriter (writer prompt, judge, pipeline, stored-draft reuse, dashboard)
tags: [feedback-autowriter, prompts, llm-judge, vitest, testcontainers]

requires:
  - phase: quick-260929-lop
    provides: Phase 0 hardening on feat/autowriter-loop-phase0 (PR #102, unmerged) — this branch is stacked on it
provides:
  - PROMPT_VERSION 4 and JUDGE_PROMPT_VERSION 4
  - otherPeopleNamed / otherPeopleLine (prompt.ts), judgeProblems (judge.ts)
  - judge reasoning effort high
  - transcript-draft reuse gated on the current prompt and judge versions
---

# Summary — autowriter v4: who-did-what and homework rules, stricter judge

**PR:** kasheesh711/bgscheduler#107 (draft, base `feat/autowriter-loop-phase0`; never merged, no auto-merge).
**Branch:** `feat/autowriter-accuracy-v4`.
**Commits:**
- 439925d: v4 writer, judge, hint, pipeline, config, dashboard, docs, tests.
- 2890ded: review fixes (version-gated draft reuse, sharper hint, full-prompt tests).
- 85317ca: no-recording alert on a Wise read retry; wider reuse tests.
- This summary.

## What changed

### Writer (`prompt.ts`, PROMPT_VERSION 4)
Changed in both evidence modes; rules 1–5 and 8–10 are unchanged.
- **Rule 6:** improvement is suggestions only. It is never presented as homework the tutor set, and never repeats the homework.
- **Rule 7:** homework only when the record shows the tutor clearly setting it for after this lesson.
  - Remaining or unfinished work is not homework.
  - An unclear record gives an empty field.
  - Homework is never restated in another field.
- **New rule 11, who did what:**
  - Summary (absolute): any other name is someone else.
  - Transcript (hedged): only STUDENT lines are the student's.
- Old transcript rules 11 and 12 are now 12 and 13.
- The homework description in the JSON schema matches rule 7.

### Other-people hint (summary mode)
`otherPeopleNamed` lists up to 8 capitalised words directly before a person verb. It leaves out:
- stop-list words, days, months and Thai forms of address;
- class-detail words and `SONIOX_TERMS` (moved here from `job.ts`);
- names starting with the first word of the student's first name or nickname.

The writer and the judge both get "Other people named in the summary (never [STUDENT_1]): …". It is a hint, never a gate.

### Judge (`judge.ts`, JUDGE_PROMPT_VERSION 4)
- Returns three lists: `unsupported`, `misattributed` and `homeworkNotSet`.
- Strict zod parse: a missing list is unparseable, so it fails closed.
- `faithful` is forced false when any list is non-empty.
- `judgeProblems` produces `wrong person: …` and `homework not set: …` entries.
- Reasoning effort is `high` (was `medium`).
- No style guides or examples.

### Pipeline and dashboard
- Hold reasons use `judgeProblems`.
- Call records keep the three lists plus `problems`.
- One hint list goes to both builders; the judge's `otherPeople` is required.
- The dashboard shows `judgeProblems` for v4 verdicts, and unsupported quotes for stored v3 verdicts.

### Stored transcript drafts (from review)
- A draft is reused only when it carries the current prompt and judge stamp and a complete v4 verdict.
- Older drafts are written and judged again from the kept Soniox job.
- `requeueShadowDrafts` applies the same test to decide which drafts keep their review window.
- `flagNoRecording` skips `wise_read_failed`.

### Docs
"Writer and judge v4 (30 Sep)" subsection in `docs/features/feedback-autowriter.md`; judge step, reuse sentence and cost line updated.

## Deviations from the approved scope
1. **`otherPeopleNamed` has an optional third argument, `classDetails`.** The two-argument signature could not see the class details the scope says to exclude.
2. **The transcript-mode judge prompt leaves out the absolute sentence** "Any other name in the summary is someone else". A Thai-script or mis-heard student name is not redacted in a transcript, so the sentence would be false there. The summary prompt is the approved text word for word.
3. **`SONIOX_TERMS` moved** from `job.ts` to `prompt.ts`.
4. **Real names are anonymised:**
   - The incident's student names are "student A/B" and "another student" in the plan, docs, comments and PR.
   - The nickname example in the plan and tests is Tim/Timothy.
   - `439925d` still has the original example in its history; a squash merge removes it.
5. **Additions from the independent review, applied as the recommended defaults in the post-review plan:**
   - version-gated draft reuse, with its requeue and no-recording counterparts;
   - raw lists in call records;
   - the required judge hint;
   - hint fixes: Thai forms of address, first word of an odd nickname code, trailing `'s`, NFC.

## Verification (fresh, Node 22, on 85317ca)
- `npm run typecheck`: pass.
- `npm run lint`: 0 errors; the 18 warnings pre-date this change and none are in the autowriter.
- `npx vitest run --project unit`: 484 files, 5598 tests pass. The autowriter and dashboard suites have 14 files and 180 tests; the base had 13 files and 152.
- `npx vitest run --project integration src/lib/feedback-autowriter` (Testcontainers): 2 files, 89 tests pass. The new no-recording test was confirmed to fail without its fix.
- `npm run build`: pass.
- **Independent review:**
  - First pass: 0 high, 1 medium, 12 low. The medium: v3-judged transcript drafts would have been reused without v4 checks.
  - The medium and the recommended lows are fixed.
  - Re-review: **CLEAR / approve**.

## Open for the owner
- **`judgeProblems` order:** list wrong-person and homework problems before unsupported ones, so the 3-item / 300-character hold reason cannot hide them?
- **Judge schema wording:** "the summary" → "the lesson record".
- **Heuristic extensions:** `n't` forms, possessive and aside shapes, reporting verbs, and ranking is/was matches lower.
- **Homework under rule 7:** Wise "Next steps" lines may now give empty homework fields or `homework not set` holds. Is that intended?
- **Judge at `high` effort:** latency against the 120 s timeout and cost are not measured yet (≈ $0.0008 per class at `medium`).
- **Live output shape:** confirm the live GLM route returns all four judge fields. Fail closed if not: every session retries and nothing wrong posts.
- **Display only:** a rewritten-then-held older draft shows its old text on the dashboard until it is retried.
- **Outside this change:** older tests and comments still hold real-looking student names. That needs a separate cleanup.
