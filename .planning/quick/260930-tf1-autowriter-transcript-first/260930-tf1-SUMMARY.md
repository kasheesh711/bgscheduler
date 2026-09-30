---
phase: quick-260930-tf1
plan: "01"
status: complete (switch stays off: replay acceptance not met — see "Replay")
subsystem: feedback-autowriter (job state machine, store, dashboard, replay tool, CLI)
tags: [feedback-autowriter, soniox, transcript-first, replay, vitest, testcontainers]

requires:
  - phase: quick-260930-av4
    provides: writer and judge v4 on feat/autowriter-accuracy-v4 (PR #107, draft) — this branch is stacked on it
provides:
  - FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST switch (off by default)
  - transcript_first handover, fallBackToSummary, ProcessResult summary_fallback
  - sonioxJobInput / buildTranscriptEvidence (transcript.ts), loadTutorPriorFeedback (job.ts)
  - replay.ts + CLI --replay (read-only)
---

# Summary — autowriter: transcript first, with the summary as the fallback

**Branch:** `feat/autowriter-transcript-first`, stacked on `feat/autowriter-accuracy-v4` (PR #107).
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
Run 1: 15 classes (4 per tutor over 7 days + the two incident sessions; Peat and Gift had fewer in-scope classes),
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
2. **Replay sample**: 15 classes, not ~22: the autowriter has rows only since 27–29 Sep, and Peat/Gift had 1–2
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
