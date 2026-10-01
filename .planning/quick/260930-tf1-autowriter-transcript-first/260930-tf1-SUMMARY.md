---
phase: quick-260930-tf1
plan: "01"
status: complete (switch off until the owner sets it; replay 2 with the Sol writer meets the bar — see "Update, 30 Sep afternoon")
subsystem: feedback-autowriter (job state machine, store, dashboard, replay tool, CLI)
tags: [feedback-autowriter, soniox, transcript-first, replay, vitest, testcontainers]

requires:
  - phase: quick-260930-av4
    provides: writer and judge v4 (PR #107, merged; this branch was stacked on it, now merged with main)
  - phase: quick-260930-sol
    provides: GPT-6.1 Sol writer, Luna fallback for summaries and transcripts (PR #108, merged)
provides:
  - FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST switch (off by default)
  - transcript_first handover, fallBackToSummary, ProcessResult summary_fallback
  - sonioxJobInput / buildTranscriptEvidence (transcript.ts), loadTutorPriorFeedback (job.ts)
  - replay.ts + CLI --replay (read-only), with writer stats
  - writer_failed fallback cause (AUTOWRITER_MAX_WRITER_ERRORS = 3)
  - fill-in blanks are not markdown (validate.ts)
---

# Summary — autowriter: transcript first, with the summary as the fallback

**Branch:** `feat/autowriter-transcript-first`, first stacked on `feat/autowriter-accuracy-v4` (PR #107); merged
with `main` on 30 Sep afternoon, and PR #109 now targets `main` (see "Update, 30 Sep afternoon").
**Commits:**
- `453f125` shared transcript evidence steps (no behaviour change).
- `31ff715` transcript first: switch, handover, fallback, store, dashboard, tests.
- `e7b967c` read-only replay and `--replay`.
- `a6aed2f` replay: skip a class whose published recording Wise no longer lists.
- `032088f` review fixes; no writer model assumed.
- `6770416` docs.
- This summary.

Names: the two 29 Sep incidents are "student A" (another student's words given to ours) and "student B" (a summary
that turned three remaining worksheet pages into "three remaining homework problems").

## What changed
- **Switch** (`config.ts`): `FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST` (exact `"true"`) → `deps.transcriptFirst` in
  `dispatch.ts` and the CLI; acts only with the second pass (`transcriptsEnabled && soniox`).
- **Handover** (`processLeased`): after every gate and before any use of the summary; readiness wait with
  `requireSummary: !transcriptFirst`; reason `transcript_first`, `metadata.handover`, `metadata.summaryAtHandover`
  `{characters, thaiShare}`; due now with a recording (`handOverToTranscript(…, retryInMs)`), otherwise the 30-min
  recheck clamped to the fallback time (`AUTOWRITER_TRANSCRIPT_FIRST_FALLBACK_MS` = 3 h).
- **Fallback** (`fallBackToSummary`, once, `handover = transcript_first` and no `summaryFallback`): no recording at
  3 h, several parts, speakers unclear, 3 Soniox failures, pass switched off → `pending`, `evidence = summary`,
  `summaryFallback {cause, at}`, due now, result `summary_fallback`; a kept transcript draft is dropped. Holds stay:
  recording/transcript too short, a rejected transcript draft. In fallback: Thai summary → `thai_summary_no_transcript`,
  held summary draft stays held, no summary retries + `no_summary`. No loops (`mayHandOver = secondPass && !fallback`).
- **Store:** `flagNoRecording` skips transcript-first rows waiting for their recording (a stuck transcription still
  alerts); a fallback is done with its Soniox job outside a POST or lease; going live keeps its window; retry clears
  `summaryFallback`, `summaryAtHandover`, `handover`, `sonioxFailure`.
- **Dashboard:** "Waiting for the recording"; fallback label under the state; "Back to the summary" counts by cause;
  class end → post median/p90 by evidence (transcript / summary after fallback / summary).
- **Replay** (`replay.ts`, `--replay`): read-only by construction (only `getSessionDetailById`, no database handle,
  Soniox jobs deleted in `finally`, Ctrl-C deletes jobs in flight); per class outcome, Soniox minutes/$/turnaround,
  speakers, v4 transcript draft with judge `high` + `medium` on the same messages, v4 summary draft, v4 `high` judge
  of the posted draft (original text recovered by hash when a correction replaced it) against the transcript; writer
  model per draft; output 0600 in `.feedback-autowriter/replay/<ts>/`.
- **Docs:** feature page section, runbook §6 (switch, replay, tutor message, 48 h checks, rollback), env reference,
  `.env.example`.

## Verification (fresh, Node 22, on `6770416`)
- `npm run typecheck`: pass. `npm run lint`: 0 errors, 18 warnings (all pre-existing, none in the autowriter).
- `npx vitest run --project unit`: 485 files, 5620 tests pass.
- `npx vitest run --project integration src/lib/feedback-autowriter`: 3 files, 111 tests pass (89 before).
- Mutation checks: removing the no-recording fallback, the no-loop guard, the alert exemption, the clamp or
  `requireSummary: !transcriptFirst` each fails a test.
- Independent review (code-reviewer): 0 high, 1 medium (stuck transcription never alerted — fixed), 10 low (5 fixed,
  the rest listed below).

## Recording arrival (read-only, first `RecordingCompletedEvent` − `post_class_sessions.scheduled_end_at`)
- `wise_webhook_events` (the table exists since 29 Sep: 1 day): 33 classes; p50 34 min, p90 62, p95 72, p99 130,
  max 151; none over 3 h.
- `wise_activity_events` (same event from Wise's feed, 16–29 Sep): 453 classes; p50 34 min, p75 48, p90 61,
  **p95 71**, p99 107, max 394; 41 before the scheduled end (early finish); 1 over 3 h (0.2%).
- Roster tutors' online accounts: 115 ended classes, 106 with a recording event; p95 72 min, max 106, none over 3 h;
  of the 9 without, 7 had no attendance either (not held in Wise's Zoom) and 2 had attendance but no recording.
- **Recommendation: keep 3 h** (p95 ≈ 71 min ≪ 3 h).

## Replay (30 Sep, read-only; writer on this branch = GLM 5.3 Flash at `max`, judge GLM at `high`)
Run 1: 15 classes (4 per tutor over 7 days + the two incident sessions; two tutors had fewer in-scope classes),
concurrency 4. Run 2: the 5 classes whose transcript writer failed, one at a time. Combined (run 2 replaces run 1
for those 5; 4 run-1 `no_recording` fallbacks reclassified `skip:recording_gone` — Wise had announced each recording
20–33 min after class and no longer lists it):

| | Result | Acceptance |
|---|---|---|
| Decided (draft/hold/fallback) | 7 of 15 (3 draft, 3 hold, 1 fallback); 4 skipped (recording gone); 4 errors | — |
| Transcript holds | 3/7 = 43% (2 judge `unfaithful`, 1 validator `markdown:improvement`) | ≤ 15% — **not met** |
| Fallbacks | 1/7 = 14% (`speakers_unclear`, then a summary draft) | ≤ 20% — met |
| Judge parse failures | 0 (33 judge calls) | 0 — met |
| Judge p90 latency (high) | 32 s (p50 10 s); medium p90 11 s | ≤ 90 s — met |
| Soniox | $0.101 per transcribed class; turnaround p50 83 s, p90 93 s; 16 jobs, all deleted | ≈ $0.10 — met |
| Student A's transcript draft | not produced: the writer timed out at 180 s in both runs | **not evaluable** |
| Student B's transcript draft | no "three homework problems" (its homework is the three remaining worksheet pages, which the tutor tells her to finish in the transcript); held for another claim | met |
| v4 on the original posts | student A: flagged (2 wrong person — incl. the other student's page count — 1 homework not set, 1 unsupported); student B: flagged (2 unsupported: "problems" vs pages) | met (B under `unsupported`) |

- **Writer time-outs (blocker for this writer):** in run 1, 5 of the 10 classes that reached the transcript writer
  failed (4 time-outs at 180 s, 1 invalid JSON at 151 s); re-run one at a time, 4 of those 5 timed out again, so it
  is the model and effort, not load. Successful calls took 44–162 s with 5k–29k reasoning tokens. On the branch's
  code a writer failure retries every 10 minutes until the deadline, with no fallback.
- **Judge high vs medium** on the same 5 transcript drafts: 4 agree; 1 flagged only at high (a draft crediting the
  student with an answer the tutor gave). High used 4.8× the reasoning tokens (mean 3.1k vs 0.65k) and 3.9× the
  latency (mean 28 s vs 7 s), well inside the time-out; worth keeping.
- **Posted drafts vs transcript** (v4 high): 8 judged, 5 flagged. One posted draft's verdict flipped between runs
  (judge nondeterminism).
- **Wise recording retention:** recordings present at 22–24 h after class were gone at 36–66 h. Replays must use
  classes from the last day; the replay now skips such classes.
- Cost of both runs: Soniox $1.63, models $0.25.

## Deviations
1. **Recording-arrival query** also run on `wise_activity_events` (453 classes, 14 days): `wise_webhook_events` holds
   only one day (33 classes).
2. **Replay sample**: 15 classes, not ~22: the autowriter has rows only since 27–29 Sep, and two tutors had 1–2
   in-scope classes. "In scope" = verified/awaiting_event/would_submit/held/skipped_human/expired rows that ended ≥ 3 h
   ago; the replay re-checks attendance and student count itself.
3. **Two runs, combined**: run 2 re-ran the 5 writer failures at concurrency 1 to rule out load; 4 run-1 fallbacks
   reclassified after finding that Wise drops recordings after about a day (the replay now does this itself,
   `a6aed2f`). The combination was done by a local script on the local run files.
4. **Beyond the brief, from the review:** stuck transcriptions still alert; a fallback drops a kept transcript draft;
   fallback retention excludes POSTs in flight; Ctrl-C cleanup; production's Soniox time-out in the replay.
5. **Writer model** (coordinator, 30 Sep: production writer moving to GPT-6.1 Sol): nothing assumes GLM; the replay
   shows the writer model per draft and reads hold reasons for any arm in `AUTOWRITER_MODELS`.

## Open for the owner
- **Do not switch on with the GLM `max` writer**: half the hour-long transcripts failed at the writer (4 of 10 never
  got a draft in two tries). Re-run the replay after this branch is rebased onto the Sol writer. Student A's recording is likely gone from Wise ~24–36 h after
  class (by 30 Sep 20:00 – 1 Oct 08:00 Bangkok): run `--replay --sessions=699477ceb50e50f4cc219904` before then for
  the student-A check with Sol.
- **Writer failures on a transcript never fall back**: consider "writer failed N times on the transcript" as a
  fallback cause.
- **Holds**: 2 of 3 transcript holds were the judge being right; 1 was markdown in "Need more work on" — a prompt or
  validator tweak.
- **Review lows left as they are:** a due-now handover waits for the next webhook or sweep (≤ 15 min); pass-off
  drops a ready transcript draft (spec: fall back); a Thai summary is held after any fallback cause (spec);
  `genericErrors` carries into the fallback; the CLI's write-flag refusal has no test.

## Update, 30 Sep afternoon: on main, two owner defaults, replay 2 (Sol)

**Commits:** `496adef` merge `origin/main` (`08a6b86`); `9a22042` a fill-in blank is not markdown; `631ed10`
`writer_failed` fallback; `2cda6e1` docs; `3114bec` review fixes (only the models' failures count); then docs and
this summary.

### Merge
Conflicts: `types.ts` (`SUMMARY_FALLBACK_CAUSES` next to main's `ModelArm` with `sol`), the webhook-config test
imports, the dashboard component test (both new tests kept), the feature page's costs (main's Sol figures plus the
transcript-first Soniox line) and the runbook (the switch row plus main's 0100 note; sections renumbered 6 Transcript
first, 7 Alerts, 8 Writer model, anchor updated). Main's behaviour kept wherever this branch did not mean to change
it: Sol config, `[writer, fallbackWriter]` for both evidence kinds, v4 prompt text. One replay test now expects a
rejected transcript draft to reach the Luna fallback too (main's pipeline). Journal: idx 99, then 100 (when
1790735838903). PR #109 retargeted to `main`.

### Owner defaults
- **`writer_failed`** (`job.ts` `processTranscript`, infra branch): on a `transcript_first` row, every pipeline
  infra result with `modelFailure` (new field on the infra result, `pipeline.ts`) counts in `metadata.writerErrors`;
  the third falls back once (`fallBackToSummary`, cause `writer_failed`, plus `writerFailure` = the last error). A
  transcript draft the models deliver resets the count to 0. Counted: the writer's and its judge's failures (a
  time-out, a reply that is not JSON, a provider error, a route mismatch, a judge that gives no verdict). Not
  counted: Wise read errors and Soniox errors (their own paths and counters), our function's time
  (`FUNCTION_BUDGET_EXHAUSTED`, or a time-out on a call our remaining time cut short), our OpenRouter account
  (401, 402, 429) and our connection (`network_*`). Other handovers (Thai summary, no summary, held summary draft)
  retry as before. `retryHeldSession` clears `writerErrors` and `writerFailure`. Dashboard: "Writer or judge failed 3 times on the
  transcript — from summary". Replay: up to 3 tries 30 s apart, then `fallback:writer_failed`; `summarizeReplay`
  adds writer calls, failures and latency p50/p90 per draft and model (a "Writers" table in `summary.md`).
- **Markdown hold** (replay 1, "Need more work on"): the text was a fill-in blank of three underscores from a grammar
  drill, which the validator's bare `__` matched — not markdown. `MARKDOWN` now takes underscores only around text
  (`__word__`, `___word___`, also over a line break); `**` and headings unchanged. No prompt change (rule 3 already says no markdown in both modes), so
  `PROMPT_VERSION` stays 4 and stored drafts keep their reuse stamp; no emphasis normalization (nothing there was
  emphasis, and rewriting `__x__` could alter real text such as `__init__`). The no-lists rule is untouched.

### Verification (fresh, Node 22)
On `3114bec` (the later commits are docs and this summary):
- `npm run typecheck`: pass. `npm run lint`: 0 errors, 18 warnings (all pre-existing, none in the autowriter).
  `npx eslint src/lib/feedback-autowriter src/components/feedback-autowriter`: clean. `git diff --check`: clean.
- `npx vitest run --project unit`: 486 files, 5647 tests pass (5620 before the merge, 5643 right after it).
- `npx vitest run --project integration src/lib/feedback-autowriter` (OrbStack): 3 files, 115 tests pass (111 before
  the merge, 112 right after it).
- Mutation checks: counting our own time budget or our account's errors, never falling back, or dropping the
  replay's per-try slice each fails a test; the old `__` regex fails the blank test.
- Independent review (code-reviewer) of the two defaults: 0 high, 1 medium (401/402/429 and network errors counted
  toward `writer_failed`, so an OpenRouter outage would have moved classes to the summary for good: fixed with
  `modelFailure`), 4 low (a time-out cut short by our budget counted; no reset on success; `___x___` and emphasis over a
  line break no longer flagged; the replay could mix verdicts across tries and split a string key): all fixed.
- Replay 2 ran on `631ed10`, before the review fixes. They do not change its results: its one infra failure was a
  judge time-out with the full 120 s (counted either way), no draft had underscores, and its retried class kept its
  last try's verdicts.

### Replay 2 (30 Sep 12:18–12:32 Bangkok, read-only, code `631ed10`)
Writer GPT-6.1 Sol at `low` (fallback Luna), judge GLM at `high` plus a `medium` re-run. Sample: the two incident
classes plus up to 4 per tutor from the last 2 days (`--per-tutor=4 --days=2 --concurrency=2`): 14 classes, 5 skipped
(recording gone, all older than about a day), 9 decided.

| | Result | Acceptance |
|---|---|---|
| Decided | 9 of 14 (9 draft, 0 hold, 0 fallback); 5 `skip:recording_gone`; 0 errors | — |
| Transcript holds | 0 of 9 = 0% | ≤ 15% — met |
| Fallbacks | 0 of 9 = 0% | ≤ 20% — met |
| Judge parse failures | 0 of 36 answered calls (26 high, 10 medium) | 0 — met |
| Judge p90 latency (high) | 63 s (p50 13 s); 1 time-out at 120 s (student A, first try; faithful on the retry) | ≤ 90 s — met |
| Soniox | $0.100 per class; turnaround p50 83 s, p90 98 s; 9 jobs, all deleted (the account lists none after the run) | ≈ $0.10 — met |
| Student A's transcript draft | no "unfinished exam" claim; homework = the multiple-choice questions the tutor set plus a recitation task the tutor asked for; `medium` flags one detail of that task as wrong ("symbols" for names), `high` passed it | met (one wrong detail) |
| Student B's transcript draft | no "three homework problems" — "the remaining three pages of the worksheet"; both judges faithful | met |
| v4 on the original posts | A: wrong person ×2, homework not set ×1, unsupported ×1; B: unsupported ×1 | met |
| Writer (Sol) | transcript drafts 10 calls, 0 failures, p50 6.0 s, p90 7.1 s; summary drafts 9 calls, 0 failures, p50 4.7 s, p90 7.3 s | — |

- High vs medium on the same 9 transcript drafts: 7 agree, 2 flagged only at `medium` (both `unsupported`: the
  recitation detail above, and a reversed "which method the tutor preferred"). Replay 1 had 1 only at `high`.
- Posted drafts (from summaries) against the transcript: 8 judged, 5 flagged (wrong person 1, homework not set 3,
  unsupported 5).
- No Sol draft had markdown or a blank, so the validator change was not exercised here (unit tests cover it).
- Cost: Soniox $0.897 (538 audio minutes), models $0.510 — $1.41.

### Open for the owner (replaces the list above)
- Switch on? Every bar is met with Sol, on 9 decided classes from one day (older recordings are gone). Not set in
  Vercel; `FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST` stays off.
- `writer_failed` counts the judge's failures as well as the writer's (read from "writer/model failures on the
  transcript draft"); one condition in `processTranscript` narrows it to the writer.
- OpenRouter account and network errors (401, 402, 429, `network_*`) never count: they retry every 10 min until the
  deadline as before, and the class resumes from the transcript once OpenRouter is back (the summary would fail the
  same way meanwhile). Confirm.
- The judge at `high` on hour-long transcripts: p90 63 s, one 120 s time-out. Production retries 10 min later and
  falls back after 3; a longer judge time-out for transcripts would avoid the retry.
- A single judge call misses some wrong details (2 of 9 only at `medium` today, 1 of 5 only at `high` this morning):
  judging transcript drafts at both efforts and holding on either flag costs ≈ $0.004 and 5–17 s per class.
- Review lows from the first round are unchanged (listed above).

## Update, 30 Sep evening: merged with main again (#105 operating loop, #112 synthetic names)

Merge of `origin/main` (`a393e64`) into this branch, so PR #109 can merge. Both features kept whole; no behaviour
of either changed.

### Merge
- Conflicts: `docs/reference/env.md` (both new rows, `FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST` then
  `FEEDBACK_AUTOWRITER_LINE_TO`; this branch's Soniox row), `dispatch.ts` (both config imports) and the dashboard
  component: main's Overview / Quality / Review tabs and `ARM_LABEL` (`model-labels.ts`), with this branch's
  "Class end → posted, by evidence" and "Back to the summary (transcript first)" sections between Tutors and Recent
  classes in Overview, the fallback label under a class's state, and "Waiting for the recording".
- Merged by git, then checked: the runbook (main's "Reviewing posts" is now section 9; 6 Transcript first, 7 Alerts,
  8 Writer model and their anchors unchanged), the feature page, `config.ts`, the dashboard and transcript tests
  (main's synthetic names; none of the names #112 removed is back).
- Journal as on main: idx 99, 100, 101 in that order. This branch adds no migration.

### Coverage of transcript-first classes (#105's `quality.ts`, owner decision D-03)
No rule changed, so `QUALITY_POLICY_VERSION` stays 1; comments, the feature page and tests now say it:

| Class | Coverage |
|---|---|
| `awaiting_recording` / `transcript_first`, `transcribing` | in progress; a miss (`expired`) only once its posting window has closed |
| `pending` / `summary_fallback:<cause>` (any of the six causes) | in progress, same rule; the cause never matches a D-03 reason |
| fell back, then posted from the summary | posted |
| fell back, then held (`thai_summary_no_transcript`, or the summary drafts rejected) or expired | miss |
| `missing_student_or_tutor` at the handover | miss (as on the second pass) |
| `recording_too_short`, `transcript_too_short` (still holds with transcript first) | left out (D-03), as before |
| the tutor wrote it while we waited for the recording (no writer call yet) | left out (`tutor wrote first`), as on the summary path |

Tests: `quality.test.ts` (the state table, the D-03 hold table with `thai_summary_no_transcript` and the
`summary_fallback:` reasons, one case per fallback cause, final outcome, waiting for the recording) and the D-03
case of `review.integration.test.ts` (two transcript-first holds as misses, two in-progress rows on neither side).

### Verification (fresh, Node 22)
- `npm run typecheck`: pass. `npx eslint src/lib/feedback-autowriter src/components/feedback-autowriter`: clean.
  `git diff --check`: clean.
- `npx vitest run --project unit`: 492 files, 5819 tests pass.
- `npx vitest run --project integration src/lib/feedback-autowriter` (OrbStack): 4 files, 158 tests pass.

### Open for the owner
- With transcript first on, a recording in several parts or unclear speakers sends the class to the summary instead
  of holding it. If the summary then cannot carry it either (held or expired), the class is a miss; on the second
  pass the same recording was a data-quality hold, left out of coverage. Leaving such a class out would need the
  fallback cause in the coverage input and a D-03 decision.
