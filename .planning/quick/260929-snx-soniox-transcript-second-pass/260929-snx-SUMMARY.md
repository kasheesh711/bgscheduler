---
phase: quick-260929-snx
plan: "01"
status: complete
subsystem: feedback-autowriter / Wise webhooks / Soniox
tags: [feedback-autowriter, soniox, speech-to-text, drizzle, postgres, vitest, testcontainers]

requires:
  - phase: quick-260929-gvd
    provides: feedback autowriter (PRs #91, #92), migration 0097
provides:
  - migration 0098 (states awaiting_recording / transcribing, evidence, soniox_transcription_id, call role transcriber / arm soniox) — applied to production 2026-09-29
  - src/lib/feedback-autowriter/soniox.ts (async stt-async-v5 client) and transcript.ts (turns, Zoom VTT alignment, rendering)
  - second pass in job.ts (handovers, processTranscript, shared postDraft, Soniox cleanup and reaper)
  - env FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED + SONIOX_API_KEY (both set in Vercel production 2026-09-29)
---

# Summary — feedback autowriter second pass (Soniox transcript)

**PR:** kasheesh711/bgscheduler#94. **Commits:** 340aff9 (second pass), a35323e (review fixes + GLM praise rule),
69358cd (alert accuracy), plus a merge of origin/main (#93).

## What shipped
- Classes whose summary cannot carry the feedback are handed to a second pass instead of being held:
  - both summary drafts held;
  - no usable summary 30 min after class;
  - a summary at least half Thai.
- The second pass waits for Wise's recording, transcribes the MP4 with Soniox via `audio_url`, labels TUTOR/STUDENT
  from Zoom's named VTT or a clear talk share, writes and judges with GLM on the zero-retention route only, and posts
  through the same guarded single-POST path.
- Safety rules added during review:
  - Speaker split: Zoom alignment is trusted only for a plausible one-to-one lesson (tutor ≥ 50%, student ≥ 5%,
    exact shares). A talk share that contradicts Zoom's cues is unclear.
  - Recording coverage: under 70% of the class is held, after a 30-min recheck for Wise's length. Soniox's own
    audio length is checked after transcription.
  - Soniox jobs:
    - a job running an hour after submit is abandoned, timed only against its own stamp;
    - three failures → held;
    - a job is kept until a judged draft is stored, then deleted;
    - the sweep retries failed deletes (including shadow drafts') and reaps orphans after 2 h.
  - Retries and leases:
    - the row is re-read under the lease after the claim;
    - a judged draft survives a "try later" gate at POST time;
    - a class waiting on Wise (not the recording) waits in `pending`.
  - `no_recording` alert 3 h after class, but not for switched-off tutors, rechecks or infra retries.
  - English-only check on the model's own text; speaker labels default to "inferred".
- Live summary path (prompt version 3):
  - every judgement of how the student did must be stated in the summary or transcript;
  - a Thai-script student name no longer blocks a draft.

## Verification
- Unit: 140 autowriter tests (276 including the Wise link, dashboard and route suites after the merge).
- Postgres (Testcontainers): 68 tests. The race cases use SQL triggers:
  - a job submitted by another worker between read and claim;
  - a row taken away after the claim.
- Typecheck, lint, production build.
- Three independent review passes (APPROVE each). All their MEDIUM and LOW findings are fixed.
- Pilot (8 classes, $0.75): Soniox kept the English terms Zoom's Thai transcript lost (preferred in 17/18 windows);
  speaker split within ~2 points of Zoom's named speakers.

## Rollout
- Migration 0098 applied to production before merge (additive; the old code keeps working).
- `FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED=true` and `SONIOX_API_KEY` (set by Kevin) in Vercel production; the
  second pass is on from the merge deploy.
- Rollback: runbook §5 (pause, wait for workers, hand second-pass rows to people, deploy, re-run).

## Open
- First handed-over class to be verified in Wise after the deploy (text stored, one credit entry, Class Feedback
  on time).
