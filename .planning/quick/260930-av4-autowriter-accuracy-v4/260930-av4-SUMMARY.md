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

## Review fixes (PR #107 re-review)

One commit on top of 4b66055. `PROMPT_VERSION` and `JUDGE_PROMPT_VERSION` stay 4 (v4 is unmerged).

| # | Finding | Change | Tests |
|---|---|---|---|
| 1 (high) | `judgeProblems` listed unsupported claims first. A hold reason keeps 3 problems / 300 chars and an alert shows 200, so a verdict with 3 unsupported + 1 misattributed + 1 homeworkNotSet named neither v4 kind. | `judge.ts` `judgeProblems`: `wrong person: …` first, then `homework not set: …`, then the unsupported quotes; doc comment says why. A stored v3 verdict still comes back unchanged. Docs updated. | `judge.test.ts` order + v3 case; `dashboard.test.ts` v4 order; new `pipeline.test.ts` case: 3 unsupported + 1 misattributed gives `glm:unfaithful:wrong person: … \| scored … \| read …`, and with a homeworkNotSet as well both v4 kinds come first. |
| 2 (medium) | `otherPeopleNamed` missed the incident pattern: a 2-letter nickname hid longer names, month/day nicknames were always dropped, sentence-initial nouns filled the cap of 8, and some verbs were missing. | `prompt.ts`: the starts-with filter applies only to prefixes of 3+ letters (2 letters: exact match only). Days and months are kept right before a speech verb, and still dropped before a state or action verb. Speech and action matches rank ahead of state verbs, deduped across ranks, first-seen order within a rank, cap applied after ranking. New verbs: reported, shared, stated, indicated, confirmed, didn't, hadn't, hasn't, wasn't (both `'` and `’`). | `prompt.test.ts`: two-letter nickname (`Chai (Ma.Pr)` + "…noting that Marco mentioned only 8 pages…" → `["Marco"]`); "May mentioned only 8 pages" → `["May"]` with dates still dropped; 9 "X was/has …" noun sentences before "Nathan mentioned" → Nathan first within the 8; reporting verbs and `n't` forms. The existing Zoë/Nathan expectation is now `["Zoë", "Nathan"]` (speech before state). |
| 3 (medium) | Rule 11 ("any other name is someone else") contradicted known redaction gaps. | `redactForModel`: the first word of a multi-word nickname code ("(Tom Ja)" → "Tom") is redacted too, case-sensitive where capitalised, 2+ letters, letters only. Guest-alias words drop a trailing `'s`/`’s` (and a bare trailing apostrophe) and redact the bare name, so "Nathan’s notes" → `[STUDENT_1]’s notes`. Family/place words (mom … teacher, as listed in the review) joined `GENERIC_GUEST_WORDS`, so "Mom's iPad" never turns "Mom" into `[STUDENT_1]`. `otherPeopleNamed` takes the aliases (new optional 4th param) and leaves out their name words; threaded through `pipeline.ts` and `buildFeedbackMessages` (the two places that pass aliases to `redactForModel`). | `prompt.test.ts`: odd-code redaction (and the old "redaction leaves it in place" test now expects `[STUDENT_1]`); possessive alias with both apostrophes, restored as "Tom’s"; "Mom's iPad" + "Mom asked about the exam" keeps "Mom" (also "Mae iPad", "Dad’s Phone", "Office PC"); alias words left out of the hint, with the family member still listed. `pipeline.test.ts`: the writer's and judge's line omit the guest name. |
| 4 (medium) | The owner decision "Wise 'Next steps' lines are not homework" was in neither prompt. | Summary mode only: one sentence in writer rule 7 and in the judge's homeworkNotSet bullet. Transcript prompts are byte-identical (writer and judge, both label kinds: hashes compared before and after). | Judge exact-text summary prompt pins the sentence; the transcript exact-text prompt is unchanged. The writer's rule 7 is pinned exactly per mode, and the transcript prompt has no "Next steps". |
| 5 (low) | The prompt-version half of the draft-reuse check had no test. | None (tests only). | New case "previous prompt, current judge" in `job.integration.test.ts` and `{ promptVersion: 3, judgeVersion: 4 }` in `store.integration.test.ts`. With the prompt-version check removed from `job.ts` and `store.ts`, exactly these two cases fail; the check was then restored. |
| 6 (low) | The judge schema said "the summary does not support" in transcript mode too. | `judge.ts` schema: "the lesson record does not support". | `judge.test.ts`: the description is pinned, and the schema has no "summary". |

### Decisions made while fixing
- **A synthetic name for the two-letter case.** The review's case used the other student's real name from the 29 Sep summary. The public-repo rule is synthetic names only, so the tests use "Marco", which starts with "Ma" in the same way.
- **Speech verb after an adverb.** "June also asked" counts as speech: the hint already allows also/only/just/then/still before any verb. Only speech verbs keep a day or month. "June finished early" is still dropped.
- **Lower-case codes.** The first code word is capitalised before matching, so a code typed "(tom ja)" still hides "Tom" but never "tom".
- **Apostrophes in alias words.** `’` is accepted inside alias words (as `'` already was), and a bare trailing apostrophe ("James’ iPad") is treated like `’s`.
- **Not done:** a validator rejecting drafts that name other people. That is left for the owner.
- **`run.ts`** (the eval harness) passes no aliases to `redactForModel` or `buildFeedbackMessages`, so nothing is threaded there.

### Verification (fresh)
- `npx vitest run --project unit src/lib/feedback-autowriter src/app/api` (Node 20): 103 files, 1,093 tests pass. The baseline at 4b66055 was 103 files, 1,082 tests; 11 tests are new.
- Against the 4b66055 sources, 18 unit tests fail: every new behaviour's test and every changed expectation. The transcript-side guards pass on both, as intended.
- `npx vitest run --project integration src/lib/feedback-autowriter` (Testcontainers, OrbStack): 2 files, 89 tests pass. The new cases sit inside existing tests.
- Full unit project on Node 22: 484 files, 5,609 tests pass. On the local Node 20, `src/lib/tutor-sit-ins/__tests__/coverage.test.ts` fails with `Map.groupBy is not a function` (Node 21+ API; CI runs Node 24). That failure is unrelated.
- `npm run typecheck`: pass. `npx eslint src/lib/feedback-autowriter`: clean. `git diff --check`: clean.
