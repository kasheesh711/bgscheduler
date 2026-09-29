---
quick_id: 260929-snx
status: complete
source_plan: ~/.claude/plans/for-online-classes-i-inherited-moonbeam.md (Soniox evaluation + pilot, approved 2026-09-29)
---

# Feedback autowriter second pass: write from a Soniox transcript of the recording

## Context
Live since 2026-09-29 15:07 Bangkok (PRs #91, #92). The fast path writes from Wise's AI summary, which Zoom builds
from its own transcript; on Thai/English lessons that transcript loses the English terms (pilot: 27k Thai / 33 Latin
characters), and some classes have no or a thin summary, or drafts the judge rejects. Soniox pilot (8 classes,
$0.75): Soniox kept the English terms, diarization matched Zoom's named speakers within ~2 points, preferred in 17/18
Thai-lesson windows. Kevin: "let's build up a second pass on Soniox as well."

## Tasks
1. Migration 0098: states `awaiting_recording`, `transcribing`; `evidence`, `soniox_transcription_id`; call role
   `transcriber` / arm `soniox`.
2. `soniox.ts` client (audio_url on Wise's MP4, th+en hints, diarization, language ID, context terms; delete after fetch).
3. `transcript.ts`: tokens → turns, Zoom VTT alignment for TUTOR/STUDENT (talk-share fallback), rendering, Thai share.
4. Prompts/judge/pipeline transcript mode (GLM only, "covered not mastered" rule); gates without summary.
5. `job.ts`: handovers (held draft, no summary after 30 min, Thai summary), `processTranscript`, shared `postDraft`,
   reuse of judged transcript drafts, sweep cleanup of Soniox jobs; store support; dashboard states/evidence/cost.
6. Tests (unit + Postgres), docs, env flag `FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED` + `SONIOX_API_KEY`.
