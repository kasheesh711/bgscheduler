---
phase: quick-260930-jtw
plan: "01"
status: complete (draft PR #113 against main; nothing deployed, no switch changed)
subsystem: feedback-autowriter (pipeline, judge, job state machine, store, prompt, dashboard, replay tool)
tags: [feedback-autowriter, judge, transcript-first, replay, vitest, testcontainers]

requires:
  - phase: quick-260930-tf1
    provides: transcript first, the writer_failed fallback, the replay (PR #109, merged into main 30 Sep 15:25 Bangkok)
provides:
  - judge v5 — medium and high in parallel, both must pass (AUTOWRITER_JUDGE_EFFORTS, combineJudgeVerdicts, passingStoredVerdict)
  - judge time-out by evidence (AUTOWRITER_JUDGE_TIMEOUT_MS), no judge without its full time-out
  - writer-only writer_failed (PipelineResult infra `stage`)
  - writer v5 — no names but the student's (summary rule 12, transcript rule 13)
  - an upstream rate limit read from the body of a 200 response (openrouter.ts)
---

# Summary — autowriter: both judge levels, a longer transcript judge, writer-only `writer_failed`, no other names

**Branch:** `feat/autowriter-judge-tweaks`, from PR #109's head; merged with #109's later head (main's #105 and
#112) and then with `main` once #109 was merged. **PR:** #113 (draft, base `main`).
**Commits:** `81138e9` writer v5 · `8ef10fc` judge v5, time-out, writer-only `writer_failed` · `623cf61` docs ·
`d2e4cc8` plan · `86c7ab6` merge of #109's head · `bf53cd6` runbook anchor · `994a868` merge of `main` ·
`df5acfe` upstream rate limit · this summary.

Names: the 29 Sep incident class is "student A", as in 260930-tf1.

## What changed
1. **Both judge levels must pass** (`pipeline.ts`, `judge.ts`, `config.ts`). The v4 judge prompt is unchanged; it
   runs at `medium` and `high` (`AUTOWRITER_JUDGE_EFFORTS`), in parallel, on the same messages, for every draft. A
   draft passes only when both give a complete v4 verdict with `faithful: true`; the problems are the union of both
   verdicts, each once, in `judgeProblems` order. Each level keeps the single judge's handling: a failed call retries
   the class later, a reply it cannot use gets one more try at that level. Errors name the level
   (`judge:high:timeout`). Call records carry `result.effort`, `prompt_version` 5 and `judgedGeneration`.
   `metadata.judge` = the union at the top level plus `levels.medium` / `levels.high`; `reusableTranscriptDraft`
   (`passingStoredVerdict`) and the requeue SQL reuse only a draft stamped prompt 5 / judge 5 that both levels passed.
   `JUDGE_PROMPT_VERSION` 4 → 5. The dashboard still shows v3 and v4 verdicts and counts a rejected draft once.
2. **Judge time-out** (`config.ts`, `pipeline.ts`): 240 s on a transcript, 120 s on a summary. A judge is never
   started without its full time-out before the deadline margin (`function_budget_exhausted`, not a model failure).
3. **`writer_failed` counts the writer only** (`pipeline.ts` `stage`, `job.ts`). A judge failure just retries; the
   writer having delivered, its count starts again. Label "Writer failed 3 times on the transcript — from summary".
4. **No other names** (`prompt.ts`, `PROMPT_VERSION` 4 → 5): summary rule 12, transcript rule 13. Prompt only.
5. **Replay** (`replay.ts`): the pipeline's two levels replace the `medium` re-run; posted drafts are judged at both
   levels; `writer_failed` follows the new rule; a draft is tried again after any failed model call.
6. **Found by the replay, fixed** (`openrouter.ts`, `df5acfe`): OpenRouter reports an upstream rate limit inside a
   200 response with the status (429) in the body. The pipeline looked at the HTTP status only, so it counted the
   rate limit as the writer's own failure. The status is now read from the body in that case.

## Time budget
- Entry points: webhook `after()`, cron sweep, Data Health run — each `maxDuration = 800`, deadline 740 s; each
  reaches the models with ≥ 560 s left (`AUTOWRITER_SWEEP_MIN_REMAINING_MS`, unchanged).
- Every model call ends by the deadline − 45 s: ≥ 105 s before Vercel would stop the function.
- After the slowest writer call (180 s): 335 s left ≥ 240 s, so the first judge attempt always has its full time-out
  unless the reads before the writer took over 95 s.
- Worst case, transcript: writer 180 s + both judges 240 s → about 140 s left, under the POST's 240 s floor → the
  judged draft is kept and the next run posts it with no model call. A level's second try after a full time-out no
  longer fits → the class retries with a fresh function. Summary: 260 s left, the POST still fits.
- Unchanged, outside this task: the three Wise reads before a POST are not budget-checked (≤ 45 s each). A function
  stopped there has not claimed a POST.

## Verification (fresh, Node 22, on `df5acfe`)
- `npm run typecheck`: pass. `npx eslint src/lib/feedback-autowriter src/components/feedback-autowriter`: clean.
  `git diff --check origin/main...HEAD`: clean.
- `npx vitest run --project unit`: 492 files, 5843 tests pass (24 more than without this branch). One earlier full run had an unrelated
  classroom test time out at 30 s while the machine's load average was above 50; it passes alone and in the rerun.
- `npx vitest run --project integration src/lib/feedback-autowriter` (OrbStack): 4 files, 159 tests pass (1 more).
- Mutation checks — each change reverted in turn, a test fails every time (14 mutations): one judge level; reuse of
  a single-judge verdict; judge version not bumped; the requeue SQL without the levels; 120 s on transcripts; a judge
  started cut short; judge failures counted; no restart of the count; the replay counting judge failures; the old
  label; no rule 12; the old rule 13; prompt version not bumped; the HTTP status instead of the body's.

## Replay (30 Sep 15:21–15:31 Bangkok, read-only, code `bf53cd6`)
Three classes from the last 24 h whose recording Wise still listed (one tutor twice, one once), all at once.
Nothing posted; three Soniox jobs, all deleted.

| | Result |
|---|---|
| Outcomes | 2 drafts; 1 `fallback:writer_failed` (student A's class — see below) |
| Both levels ran | 14 judge calls, 7 per level: 3 transcript drafts, 1 summary draft, 3 posted drafts; 0 errors, 0 parse failures, 0 time-outs |
| Latency, `medium` | p50 10.0 s, p90 21.6 s; transcript drafts 7.1–11.0 s |
| Latency, `high` | p50 31.0 s, p90 71.1 s (the longest call); transcript drafts 16.2–31.1 s |
| Reasoning tokens (mean) | `medium` 500, `high` 1,967 |
| Agreement on the 3 transcript drafts | 2 faithful at both; 1 flagged only at `medium` (1 unsupported claim) → rejected under the new rule |
| Posted drafts vs transcript | 3 judged, 2 flagged; both levels agreed on flagged / not flagged in all 3 |
| Writer (Sol) | 10 calls: 4 answered (6.3–10.5 s), 6 rate-limited upstream |
| Cost | Soniox $0.294 (176.6 audio minutes), models $0.198 — $0.49; judges $0.053 of it ($0.0040 a `high` call, $0.0036 a `medium` call) |

- Student A's class: Sol was rate-limited twice, then wrote a draft; `medium` flagged one claim, `high` passed it, so
  the draft went to the Luna fallback, which timed out at 180 s. The code at that commit counted the two rate limits
  as writer failures, hence `writer_failed`. With `df5acfe` only Luna's time-out counts (1 of 3).
- A burst of 8 one-word requests right after the replay: 7 rate-limited, HTTP 200 with code 429 in the body.
- The 240 s time-out was not reached: the longest judge call took 71.1 s.

## Deviations and judgement calls
1. **Rate-limit fix** (not in the brief): a separate commit, `df5acfe`, which can be reverted on its own.
2. **Count restarts when the writer delivers**: "three times in a row" — a judge failure means the writer did
   deliver on that attempt, so the streak is broken (config and job comments, docs, tests).
3. **Strict "no judge it cannot finish"**: a judge needs its full time-out to start. `AUTOWRITER_SWEEP_MIN_REMAINING_MS`
   stays 560 s: raising it to fit the POST after a worst-case transcript would cut the webhook's waits for Wise and
   Soniox from 180 s to 60 s.
4. **Only the level that failed is asked again**, in parallel with the other; the first level in effort order that
   stopped names the error.
5. **Rule 12 does not list `[TUTOR]` as an allowed name**: the prompt already says never to name the tutor or write
   `[TUTOR]`. The rule is absolute (coordinator: no exception for authors or characters in lesson material).
6. **Dashboard "judged unfaithful"** now counts rejected drafts, not judge calls (two calls judge each draft).
7. **Decisions 1–3 share one commit**: they meet in the same lines of `pipeline.ts`.
8. `STATE.md` is not touched, like the other 30 Sep autowriter quick tasks.

## Open for the owner
- **Sol's route was rate-limited upstream this afternoon** (6 of 10 writer calls in the replay, 7 of 8 in a burst).
  Webhooks run classes at the same time, so with transcript first on, evening classes may wait on 10-minute retries.
  The error text points to an own provider key in OpenRouter; check zero data retention before adding one.
- **More drafts reach the Luna fallback now** (a draft one level flags: 1 of 3 here, 2 of 9 and 1 of 5 in the earlier
  replays), and Luna at `max` timed out at 180 s on an hour-long transcript (1 of 1 here). Each such time-out counts
  toward `writer_failed`; three in a row send the class to the summary. Worth watching in the first 48 h.
- The pre-POST Wise reads are not budget-checked (above).
