# Feedback Autowriter

**Status:** live since 2026-09-29, constrained rollout (5 tutors, both of each tutor's Wise accounts). **Code:** [`src/lib/feedback-autowriter/`](../../src/lib/feedback-autowriter/).
**Runbook:** [`operations/feedback-autowriter.md`](../operations/feedback-autowriter.md). **API:** [`reference/api/feedback-autowriter.md`](../reference/api/feedback-autowriter.md).
**Dashboard:** `/feedback-autowriter` (nav: Scheduling & Tutors → Feedback Autowriter). Admins see posts, shadow drafts
and holds with the written text, class-end-to-post latency, model cost and webhook deliveries; only the owner sees the
mode, pause/resume and per-tutor switches (one per tutor, covering both of their Wise accounts). In-person classes on a
roster account are skipped at once (Wise type `OFFLINE`) and left out of the dashboard entirely — they stay the
tutor's to write.

Writes a tutor's post-class feedback for **online one-to-one classes** from Wise's AI meeting summary — or, with
[transcript first](#transcript-first-switch-30-sep) on, from a Soniox transcript of the lesson recording, with the
summary as the fallback — and completes Wise's own **blank auto-submission** through the same endpoint the Wise web app uses
(`POST /teacher/classes/{classId}/session/{sessionId}/feedback`). It is a separate module on purpose:
[Post-Class Feedback](./post-class-feedback.md) stays read-only toward Wise and never generates feedback; it
simply ingests what the autowriter posted like any other submission.

## Scope

| Rule | Where |
|---|---|
| Only the roster tutors (Kevin, Gift, Ek, Peat, Mimi — chosen by online-class volume to cover ≥20% of institution online classes), on both of their Wise accounts: the "… Online" one and their main one. Tutors teach online from either (all of Gift's online classes in September were on her main account); in-person classes on either are skipped by the session type below | [`roster.ts`](../../src/lib/feedback-autowriter/roster.ts) |
| Session `type=SCHEDULED`, `classType=ONE_TO_ONE`, exactly one student who attended ≥50%, meeting `ENDED`. The tutor joining their own class again is not a student: their other Wise account, or a Zoom guest (no Wise account) under one of their names (Peat, 29 Sep, joined twice more as "Kasidej Jungrakangthong" and "Peat"). Any other extra participant still counts, so the class is skipped — except a student who joined by Zoom link as a guest: when the Wise account attended under 50% and exactly one guest and the tutor both stayed ≥ 80% of the class, the guest is the student (owner rule, 29 Sep); the Wise account stays the one billed, credit-checked and named, the guest's name is redacted as the same `[STUDENT_1]` (device, family and place words like "Zoom", "iPad", "Mom" or "Office" are left alone), and the row records `studentJoinedAsGuest`. While attendance settles (60 min), an account plus a guest is retried, not skipped for good. The student whose credit is checked is stored with the POST claim and re-used by reconciliation. The one student must be a Wise user (`student_not_wise_user` otherwise: retried while attendance settles, then held). A title starting "In-Person Session" / "On-site Session" is out of scope even if Wise's type says online (`session_type_in_person_title`) | `evaluateSessionGates`, `studentParticipants` in [`session.ts`](../../src/lib/feedback-autowriter/session.ts) |
| Before the post-class deadline (≥30 min margin) | same |
| Only when the teacher submission is Wise's blank auto-submission (`metadata.autoSubmitted=true`, all answers empty); anything a person wrote is never touched | `classifyTeacherSubmission` |
| Re-sends the auto-submission's own `sessionStatus` / `creditsConsumed` (credits must equal the scheduled hours) — no new charge | [`billing.ts`](../../src/lib/feedback-autowriter/billing.ts) |
| English only | [`prompt.ts`](../../src/lib/feedback-autowriter/prompt.ts) |

Offline, group and absence cases stay with the tutor (see *gate dispositions* below).

## Flow

1. **Trigger.** Wise webhook `MeetingEndedEvent` / `AttendanceComputedEvent` / `RecordingCompletedEvent` →
   [`/api/wise/webhook`](../../src/app/api/wise/webhook/route.ts) stores the delivery and answers 200, then
   processes the session in `after()`, skipping any retry wait and re-reading Wise every 20 s for up to 3 minutes
   while the summary is not there yet (measured: the summary appears 17–78 s after the meeting ends). Target:
   feedback posted ~2–3 minutes after class (about an hour with transcript first, which waits for the recording). The [backstop cron](../reference/crons.md#feedback-autowriter-job)
   (`8,22,38,52 * * * *`) sweeps anything missed.
2. **Lease.** One worker per session (`feedback_autowriter_sessions`, conditional update on the database clock).
   The lease (14 min) outlives any function (800 s), so an expired lease always means a dead worker; the sweep
   picks such rows up again. While halted, nothing is drafted at all (no model calls).
3. **Fresh Wise read** (`GET /user/session/{id}` or the class-scoped detail, 45 s time-out per read) → gates →
   billing plan. If Wise now shows a different teacher, the row follows it (and a switched-off tutor's class is
   not posted); a `pending` row also follows the teacher the backstop's shortlist reports.
4. **Write.** `openai/gpt-6.1-sol` (GPT-6.1 Sol) on a zero-data-retention route, reasoning `low` (see
   [Models](#models)); names are redacted before anything leaves BGScheduler. The model writes `[STUDENT_1]`,
   which becomes the student's **nickname** — the
   part before the dot in the Wise name's brackets ("Worawut (Bas.Ho) Horburapa" → "Bas"), or the first name when
   there is none (owner decision, 29 Sep). The writer and the judge both get the **class details** from Wise
   (`describeClass` in [`prompt.ts`](../../src/lib/feedback-autowriter/prompt.ts)): at BeGifted Wise's `classSubject`
   is the programme or level band ("11+/13+", "Y9-11 / G8-10 (Int.)") and the subject is only in the session title
   ("Live Session - NVR" → "NVR"). Confirmed terms are expanded — 11+/13+ = the ISEB 11+/13+ entrance tests,
   NVR / Non VR = Non-Verbal Reasoning, VR = Verbal Reasoning, Sci = Science — and nothing else is guessed. The
   judge treats the class details as true, so naming the programme or subject is never a "made-up" claim. Deterministic validation (300-char policy, placeholder, absence wording,
   copy-similarity against the tutor's 90 days of feedback and the autowriter's own posts).
5. **Judge.** GLM (Together, zero data retention) checks the draft against the summary at reasoning `medium` and
   `high`, in parallel on the same messages, and the draft passes only when both do ([v5](#judge-v5-and-writer-v5-30-sep-afternoon)):
   unsupported claims, things given to the wrong person, homework the tutor never set (v4, below). Unfaithful or
   invalid → fallback writer `openai/gpt-6-luna` (zero data retention), validated and GLM-judged the same way. Both
   fail → **held** + alert. An answer to the primary writer's request from any model other than Sol is an
   infrastructure failure, never a reason to fall back; the Luna fallback has no such model check.
   Service failures (credit, outage, time-out, a provider-side generation error, a judge level that gives no verdict
   twice) never go to the fallback: the session retries in 10 minutes and the run reports an infrastructure error.
6. **Shadow or live.** Shadow stores the draft (`would_submit`). Live runs
   [`submitFeedbackGuarded`](../../src/lib/feedback-autowriter/submit.ts): credit baseline → fresh read (all gates
   again) → POST claim → one POST (never retried) → read-back of text, status, credits and the session's single
   credit entry → a non-auto submit event by the API owner (`WISE_USER_ID`). The claim needs a valid lease, mode
   `live`, no halt, the teacher from the fresh read equal to the stored one and switched on, **no other unsettled
   POST** (`posting` or `awaiting_event` — the latter can still turn into a halt, so it keeps the lock; the claim
   checks both and a partial unique index on `posting` settles simultaneous claims; a second session re-checks
   every 10 s for up to ~80 s, then leaves it to the next sweep), and at least 240 s of function time for the POST
   phase. While an unsettled POST is older than 6 min (waiting for the sweep), nothing is drafted at all.
   A shadow draft finished after the owner switched to `live` goes back to `pending` (atomically with the mode),
   so it is posted rather than stranded in `would_submit`.

### Writer and judge v4 (30 Sep)

Two 29 Sep posts went wrong in ways the v3 prompts allowed. A summary named another student next to ours ("…
noting that <another student> mentioned only 8 pages …"): redaction replaces only the student's and the tutor's
names, so that name was the only real one left, the writer took it for our student and added a homework line, and
the judge (reasoning `medium`, ~100 reasoning tokens) passed it. Another summary ended "…had three remaining homework
problems to complete" (a mis-hearing); the writer posted it as homework and repeated it under "Need more work on".
Prompt and judge versions are now 4 ([`prompt.ts`](../../src/lib/feedback-autowriter/prompt.ts),
[`judge.ts`](../../src/lib/feedback-autowriter/judge.ts)):

- **Writer rules.** Improvement is written as suggestions — never as homework the tutor set, never repeating the
  homework. Homework is only work the record shows the tutor clearly setting for after this lesson; work described
  as remaining or unfinished is not homework, an unclear record gives an empty field, and the homework is never
  restated in another field (the JSON schema says the same). In summary mode rule 7 adds that a "Next steps" line
  in the summary is the summary's own suggestion, not homework the tutor set (owner decision, 30 Sep; the
  transcript prompt is unchanged). New rule 11, *who did what*: in a summary the student is
  always `[STUDENT_1]` and the tutor `[TUTOR]`, and any other name is someone else (another student, family, a
  friend, a character in the lesson material); in a transcript only STUDENT lines are the student's, and anyone
  clearly not the student is never `[STUDENT_1]` — hedged, because a Thai-script or mis-heard name of the student is
  not redacted. The transcript's "covered, not mastered" and Thai-name rules are now 12 and 13.
- **Other-people hint (summary mode).** `otherPeopleNamed` lists up to 8 capitalised words that come right before a
  person verb ("said", "reported", "finished", "didn't", "was" …; contractions with either apostrophe), leaving
  out common words, days and months (except right before a speech verb: "May said" — May, June and April are
  nicknames too), the class details, the Soniox terms, the name words of the student's guest names, and the
  student's own names: any name starting with their first name or nickname, or only that name itself when it has
  two letters (a student "Ma" does not hide a "Marco"). Names seen before a speech or action verb come first, then
  those only seen before a state verb ("was", "has": sentence-initial nouns like "Progress was steady" take those
  too), and the cap applies after that ranking. When there are any, the writer and the judge both get "Other people
  named in the summary (never [STUDENT_1]): …" before the summary. It is a hint, never a gate: a missed name or a
  harmless extra (a character, a subject) changes nothing else.
- **Redaction gaps closed.** Rule 11 says any other name in a summary is someone else, so the student's own names
  must not survive redaction. An odd bracket code "(Tom Ja)" is replaced whole and its first word "Tom" too, where
  written capitalised. A possessive guest name ("Nathan’s iPad") hides the bare "Nathan" and keeps possessives
  natural (`[STUDENT_1]’s`). Family and place words in a guest name ("Mom's iPad", "Mae iPad", "Office PC") are
  never taken for the student: the student joined on someone else's device, and the whole guest name is still
  redacted as the student.
- **Judge.** Reasoning `high` (was `medium`). It returns three lists — `unsupported` (claims
  the record does not state or clearly imply), `misattributed` (something given to `[STUDENT_1]` that the record
  says about the tutor or someone else) and `homeworkNotSet` (homework, tasks or due dates the tutor did not
  clearly set; in summary mode a "Next steps" line is not homework the tutor set) — and `faithful` only when all
  three are empty. The schema's list descriptions say "the lesson record", since both modes send them. A reply
  missing a list is unparseable, so it fails closed (one more try, then the session retries later). Hold reasons and
  the dashboard's "Judge flagged" line use `judgeProblems`: `wrong person: …` first, then `homework not set: …`, then
  the unsupported quotes as they are — a hold reason keeps only its first three problems (300 characters) and an
  alert shows 200 characters, so the two v4 kinds are never hidden behind unsupported claims. Judge call records
  keep the three lists plus that flat `problems` list. Verdicts stored before v4 (`{ faithful, unsupported }`) still
  show their unsupported quotes. The judge still gets no style guide or examples.
- **Stored drafts.** A judged transcript draft is reused on a retry only when the current prompt and judge versions
  wrote and passed it (`metadata.pipeline`, a complete v4 verdict). An older one — for example parked at deploy time
  — is written and judged again from its kept Soniox job, and a shadow draft re-queued by going live restarts its
  transcript's review window instead of keeping it.

### Judge v5 and writer v5 (30 Sep, afternoon)

Four owner decisions from the 30 Sep interview, before transcript first is switched on. Prompt and judge versions
are now 5.

- **Both judge levels must pass.** The judge prompt is unchanged (v4); it now runs at reasoning `medium` and `high`
  (`AUTOWRITER_JUDGE_EFFORTS` in [`config.ts`](../../src/lib/feedback-autowriter/config.ts)), in parallel, on
  byte-identical messages, for every draft — summary and transcript. A draft passes only when both levels return a
  complete v4 verdict with `faithful: true`. In the 30 Sep replays each level caught a wrong detail the other passed
  (1 of 5 transcript drafts only at `high`, 2 of 9 only at `medium`). The problems of a rejected draft are the union
  of both verdicts, each once, in the usual order (wrong person, homework not set, unsupported). Each level is the
  single judge of before: a failed call (time-out, outage, wrong route) retries the class in 10 minutes, and a reply
  it cannot use gets one more try at that level; the error names the level (`judge:high:timeout`,
  `judge:medium:judge_unparseable`). Both calls are in `feedback_autowriter_calls` with `result.effort` and
  `prompt_version = 5`, plus `result.judgedGeneration` (the writer reply they judged), so the dashboard counts a
  rejected draft once.
- **Stored verdicts and reuse.** `metadata.judge` holds the union at its top level (what hold reasons and the
  dashboard read, so v3 and v4 verdicts still show as before) and each level's own verdict under `levels`. A kept
  transcript draft is reused only when it is stamped prompt 5 and judge 5 **and** its stored verdict shows both
  levels passing (`passingStoredVerdict` in [`judge.ts`](../../src/lib/feedback-autowriter/judge.ts); the requeue
  SQL applies the same test). A draft the single judge passed (v4) is written and judged again from its kept Soniox
  job — never posted on its old verdict.
- **Judge time-out.** 240 s for a transcript (the `high` judge once timed out at 120 s on an hour-long one; its p90
  was 63 s), 120 s for a summary. A judge is never started without its full time-out: if less is left before the
  function's deadline (minus 45 s), the class retries with a fresh function, and that is not counted as a model
  failure. The budget: every entry point (webhook, cron, Data Health run) runs under `maxDuration` 800 with a 740 s
  deadline and reaches the models with at least 560 s left; after the slowest writer call (180 s) 335 s remain, so
  the first judge attempt always gets its full 240 s unless the reads before the writer took over 95 s, and every
  model call ends at least 105 s before Vercel would stop the function. Worst case for a transcript (writer 180 s,
  then both judges 240 s) about 140 s remain, under the 240 s the POST needs: the judged draft is kept and the next
  run posts it without calling a model. A summary's worst case still posts in the same run (260 s left).
- **`writer_failed` counts the writer only** ([transcript first](#transcript-first-switch-30-sep)). A judge failure
  just retries every 10 minutes, as before; and because the writer delivered a draft on that attempt, its count
  starts again.
- **No other names.** Summary rule 12: "Never name anyone but `[STUDENT_1]`: refer to any other person generically —
  "another student", "a classmate", "a family member" — never by name." Transcript rule 13, which already said never
  to repeat any name, now ends "… and refer to anyone else generically ("another student", "a classmate", "a family
  member")". The tutor is never named either (unchanged). A prompt rule only: nothing holds a draft for a name, and
  the judge is not asked about it. It is absolute — authors and characters in the lesson material are not an
  exception.

## Models

Since 2026-09-30 (owner decision: "Switch the writer to Sol for everyone today"; migration 0100 adds the arm `sol`).
All three go through OpenRouter with `zdr: true`, `data_collection: "deny"` and `require_parameters: true`, so neither
a summary nor a transcript ever reaches a host that retains it ([`config.ts`](../../src/lib/feedback-autowriter/config.ts)).

| Role | Model | Route | Reasoning | Route check |
|---|---|---|---|---|
| Writer (`sol`) | `openai/gpt-6.1-sol` | any zero-data-retention host (Azure today) | `low` | the answer must come from `openai/gpt-6.1-sol` |
| Fallback writer (`luna`) | `openai/gpt-6-luna` | same | `max` | — |
| Judge (`glm`) | `z-ai/glm-5.3-flash` | pinned to Together, no host fallback | `medium` and `high`, in parallel — both must pass (v5; one call at `high` in v4, at `medium` before) | host `Together` and that model |

Why Sol: a blind comparison on 11 classes (the same Soniox transcripts for every writer, v4 rules) found 82% of
Sol-low drafts needed no real fix (no critical errors, 0.9 real errors per 100 claims), against 64% for Luna and 30%
for GLM (4.1 real errors per 100 claims). Sol also answered faster there: a median of ~6 s per draft against ~3
minutes for GLM.

From the 29 Sep pilot until the switch GLM (Together, reasoning `max`) was the writer, and Luna the fallback on a
route without zero data retention; drafts written then keep the arm `glm` (or `luna`). The evaluation
CLI (`--generate`) drafts every class with all three writers, GLM with its old writer settings (Together, reasoning
`max`); the pilot's half/half A/B assignment (`ab.ts`) is still GLM/Luna.

## Second pass: writing from the recording (Soniox, migration 0098)

When the AI summary cannot carry the feedback, the class is handed to a second pass instead of being held:

| Handover | When |
|---|---|
| `transcript_first` | every class that passes the gates, while [transcript first](#transcript-first-switch-30-sep) is on |
| `summary_draft_held` | both summary drafts failed validation or the faithfulness judge |
| `no_usable_summary` | still no summary (or too short) 30 minutes after the class end |
| `thai_summary` | the summary is at least half Thai: Wise builds it from Zoom's Thai transcript, which loses the English terms |

The row goes to `awaiting_recording` (`evidence = 'transcript'`). Wise publishes the lesson recording hours after
class; its `RecordingCompletedEvent` webhook (or the backstop, every 30 min) picks the row up and:

1. passes Wise's composite MP4 URL (`rawRecordings`, one part only) to **Soniox** `stt-async-v5`
   ([`soniox.ts`](../../src/lib/feedback-autowriter/soniox.ts)): Thai/English code-switching in one model, speaker
   diarization, our terms as context; about **$0.10 per audio hour**. The job id and its submit time are stored; a
   job not finished within ~3 minutes leaves the row `transcribing` for the next run, and one still running an hour
   after it was submitted (the stamp belongs to that job) is deleted and counted as a Soniox failure. A recording
   shorter than 70% of the scheduled class would be written up as the whole lesson, so it is held
   (`recording_too_short`): Wise's `rawRecordings[].duration` (seconds) is checked before the job — held only when
   still short 30 minutes after it was first seen short, in case the first length was not final — and Soniox's audio
   length after it;
2. fetches the transcript. BGScheduler never stores it. The Soniox job is kept while the class is in progress (so a
   retry re-fetches instead of transcribing again) and, once the class is done with it (posted, shadow draft, held,
   expired or skipped, however it got there), for review for 72 hours (owner decision, 29 Sep), then the sweep
   deletes it. The first sweep to see the class done stamps `metadata.sonioxRetainUntil` = now + 72 h (so the window
   starts within one sweep of the class finishing). A class left unfinished past its deadline (mode `off` skips the
   expiry) counts as done, and the job's cleanup still runs when `FEEDBACK_AUTOWRITER_ENABLED` is off. An owner retry
   clears the stamp, and so does going live for a draft that may transcribe again (a judged transcript draft keeps
   its window); the window starts again when the class is next done. A reviewer finds the job by the row's `soniox_transcription_id` (Soniox
   Console). `metadata.triagedAt` ends the window early; nothing writes it yet — it is reserved for the review
   surface of the operating loop. A delete that fails keeps the job id so the sweep retries it, and the sweep also
   reaps jobs no row references after 2 hours;
3. tells tutor from student by lining up Soniox's speakers with Zoom's name-labelled WEBVTT (`rawTranscript`) — every
   speaker that overlaps the teacher's cues is TUTOR, so a diarization split cannot turn the tutor into the student;
   cues under any of the tutor's other names (their other account, a second device) count as the teacher's.
   The alignment is trusted only when it looks like a one-to-one lesson (TUTOR ≥ 50% of the talk, STUDENT ≥ 5%,
   exact shares). Otherwise it falls back to talk share, used only when the split is clear (two main speakers, one
   with ≥ 60%) and — when Zoom has cues under the teacher's name — agrees with them; anything else is held
   (`speakers_unclear`). Zoom's transcript is published a few minutes after the recording (5.5 minutes on the first
   live class), so while it is missing or unreadable — and Wise gives the teacher's name to match — the row waits in
   `transcribing` (`zoom_transcript_pending`, job kept, due again after 5 minutes, i.e. the next sweep) until 20
   minutes after the Soniox job was submitted, then goes ahead on talk share (worst case ~35 minutes after submit). The models are told the labels are reliable only when Zoom confirmed them, and are told they
   are inferred by default ([`transcript.ts`](../../src/lib/feedback-autowriter/transcript.ts));
4. writes (Sol, Luna fallback) and judges (GLM at both levels, 240 s time-out) from the `[mm:ss] TUTOR/STUDENT`
   transcript, exactly like the summary path. Thai-script names can slip past the Latin-name redaction, so a transcript may only go to
   **zero-data-retention routes** — which every model now is (until 30 Sep only GLM had one, so transcripts were
   written by GLM alone, with no fallback). Extra rule: what the tutor
   explained is "covered", not "mastered", unless the student is shown doing it. A long transcript keeps its start
   and end (homework is usually set last). Any Thai text the model writes fails validation (English only; the
   student's own name, restored afterwards, may be Thai);
5. posts through the same guarded path (gates without the summary requirement).

A webhook waits up to ~3 minutes for Soniox; the backstop only looks and comes back, so one slow job never starves
the other classes. A transcript draft that was judged but whose POST did not go out (another POST in flight, or a
pre-POST gate that says "try later") is reused on the retry, as long as the current prompt and judge versions wrote
it and both judge levels passed it (v4 and v5, above). While Wise itself is not ready (attendance, status, the
POST slot, a failed read once a draft exists) the class waits in `pending`, not `awaiting_recording`. Three Soniox failures (errors, a job running
over an hour, or a run whose status checks never get an answer; within one run a failed check after a good answer
does not count, and the backstop checks once per run), several recording parts, a recording too short for the
class, or a transcript under 800 characters → `held` + alert (with [transcript first](#transcript-first-switch-30-sep),
the Soniox failures, several parts and unclear speakers fall back to the summary instead). A
class still waiting for its recording (or its transcript) 3 hours after class raises a `no_recording` alert (live
mode; not for a switched-off tutor, a short recording waiting for its recheck, an infra retry, or a transcript-first
class still waiting for its recording, which falls back instead); rows still waiting at the deadline margin expire
with an alert as before.
Soniox jobs of finished rows and of shadow drafts are deleted by the sweep once their review window is over or the
class is triaged; a refused delete is retried at the next sweep.

Pilot (2026-09-29, 8 classes): on Thai/English lessons Soniox kept the English terms that Zoom's transcript lost and
was preferred in 17 of 18 compared windows; no gain on English-only lessons.

Switch: `FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED=true` plus `SONIOX_API_KEY`; off → the fast path behaves as before.

## Transcript first (switch, 30 Sep)

Both errors reported on 29 Sep came from Wise's summary itself: redaction left another student's name as the only
real name in it, and the summary mis-heard a Thai exchange as "three remaining homework problems". The transcript
carries neither. Owner decision (30 Sep), for all five tutors: wait for the recording and write from its transcript;
use the summary only when the transcript cannot carry the class. Switch: `FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST=true`
([`config.ts`](../../src/lib/feedback-autowriter/config.ts)), exact string only, and it acts only while the second
pass is on. Off (the default), nothing changes.

- **Handover** (`processLeased` in [`job.ts`](../../src/lib/feedback-autowriter/job.ts)). After every gate —
  attendance, the submission (a class the tutor already wrote is `skipped_human` before any Soniox spend), scope,
  form, billing and the student and tutor — and before anything uses the summary: `awaiting_recording`,
  `evidence = transcript`, reason `transcript_first`, `metadata.handover` and `metadata.summaryAtHandover`
  (`{characters, thaiShare}`, for analysis only). The readiness wait no longer needs the summary, so a webhook hands
  over as soon as attendance is in. Due at once when Wise already has the recording (the next webhook or sweep
  picks it up); otherwise the usual 30-minute recheck, never later than the fallback time. Wise's
  `RecordingCompletedEvent` webhook continues it, as for any second-pass class.
- **Fallback to the summary** (`fallBackToSummary`, once): no recording **3 h after the scheduled end**, a recording
  in several parts, speakers it cannot tell apart, three Soniox failures, the transcript pass switched off while
  the class waited, or the writer failing on the transcript draft three times in a row (`writer_failed`: the writer
  timing out, answering with something that is not JSON or from the wrong route, or a provider error — counted in
  `metadata.writerErrors`, the last one in `writerFailure`, and reset whenever the writer delivers a draft; owner
  decisions, 30 Sep). Not counted, and retried every 10 minutes as before: a judge failure (the writer delivered, so
  the count starts again), Wise and Soniox errors, the function's own time, and our OpenRouter account or connection
  (a bad key, no credit, rate limited, the network). The row goes back to `pending` with `evidence = summary`, due at once, reason
  `summary_fallback:<cause>` and `metadata.summaryFallback {cause, at}` (the run reports `summary_fallback`), and the
  summary path writes it as before. A transcript draft kept on the row (only possible for a recording that gained a
  second part, or the pass switched off) is dropped with its verdict and stamp. Measured before choosing 3 h (first `RecordingCompletedEvent` − scheduled end,
  16–29 Sep, 453 classes): median 34 min, 90th percentile 61 min, 95th 71 min, one class over 3 h; the roster
  tutors' online classes: 95th percentile 72 min, none over 3 h.
- **Still holds.** A recording or transcript too short for the class, and a transcript draft the validator or judge
  rejects: the better evidence could not support a draft, so a person writes it.
- **After a fallback.** A mostly-Thai summary is held (`thai_summary_no_transcript`); a held summary draft stays
  held; no summary retries, alerts `no_summary` and expires as before. Nothing hands over again, so there is no loop;
  an owner `--retry` clears `summaryFallback`, `summaryAtHandover`, `handover` and the error counts, and the class
  may go to the transcript again.
- **Alerts and retention** ([`store.ts`](../../src/lib/feedback-autowriter/store.ts)). A transcript-first class still
  waiting for its recording raises no `no_recording` alert — it falls back at that point instead; one whose
  transcription is still running 3 h after class has no time-based fallback, so it alerts as before. A class that
  fell back is done with its Soniox job (the summary path never reads it again) unless a POST is in flight or a worker
  holds it: 72 h review window, then deletion; going live keeps its window.
- **Dashboard.** "Waiting for the recording"; a fallback shows under its state, e.g. "No recording after 3 h — from
  summary"; fallback counts by cause; class end → post median and 90th percentile by what the post was written from
  (transcript, summary after a fallback, summary).
- **Replay** (read-only, [`replay.ts`](../../src/lib/feedback-autowriter/replay.ts); CLI `--replay`). What transcript
  first would do with recent classes, before the switch is turned on: Wise session-detail GETs, database SELECTs,
  Soniox jobs deleted right after each transcript, model calls kept in memory. Per class: the outcome (draft, hold
  or fallback), Soniox minutes, cost and turnaround, the speaker method, the transcript draft with both judge
  levels' verdicts, latency and tokens (the pipeline's own two calls), a summary draft judged the same way, and both
  levels on the draft actually posted (the original, when a one-time correction replaced it) against the transcript —
  only on a transcript production would write from. Writer models are whatever `AUTOWRITER_MODELS` names, shown per draft, with their
  calls, failures and latency (p50/p90). A transcript draft whose models fail is tried up to three times (30 s
  apart, where production waits 10 minutes): three writer failures in a row count as a `writer_failed` fallback, a
  judge still failing on the last try ends as `error:judge:<level>:…` (production would keep retrying). It is typed so
  it cannot post (`Pick<WiseFeedbackOps, "getSessionDetailById">`), and no database handle is passed in: the CLI
  SELECTs the sample (including when Wise announced each recording) and the tutor's prior feedback. A class whose
  published recording Wise no longer lists (Wise drops recordings about a day after class) is skipped
  (`skip:recording_gone`), not counted as a fallback. It shares `sonioxJobInput()` and `buildTranscriptEvidence()`
  with production ([`transcript.ts`](../../src/lib/feedback-autowriter/transcript.ts)) and production's Soniox
  time-out. Output: gitignored `.feedback-autowriter/replay/<ts>/` (0600): `records.json`, `summary.json` and
  `summary.md` (no lesson text); transcripts only with `--keep-transcripts`.

## Robustness and traceability
- A timeout while reading a model or Soniox reply is an ordinary timeout (retried later), never an unhandled error.
- Any unexpected error is retried, but the third one on the same class holds it for a person with an alert
  (`metadata.genericErrors`), instead of retrying until the deadline.
- Every draft and POST claim carries `metadata.pipeline`: the commit (`VERCEL_GIT_COMMIT_SHA` on Vercel;
  `local:<sha>[+dirty]` from the CLI), the prompt and judge versions, the model arm and the evidence, so any post can
  be traced to the code that wrote it. A reused transcript draft keeps the stamp of the attempt that wrote it; the
  POST claim adds `postedFromCommit`, the code that sent it. An owner retry clears the stamp with the draft, and
  resets the error counters.

## States (`feedback_autowriter_sessions.state`)

`pending → generating → would_submit` (shadow) or `→ posting → awaiting_event → verified`.
Second pass: `→ awaiting_recording → (transcribing →) generating → …` (same ending).
Terminal: `held`, `skipped_human`, `skipped_scope`, `expired`, `rejected`, `unknown_outcome`, `verify_failed`.
`posting` is never re-claimed. After 6 minutes a `posting` row is reconciled by reads only: stored text, status,
credits and credit entry, then the submit events. A failed read-back right after the POST also leaves the row
`posting` for this reconciliation (no halt for a read error alone). For both `posting` and `awaiting_event` rows
the events are checked for a teacher/admin save between the fresh read and the POST's response (a save there was
either overwritten by ours or overwrote it) and for our submit event; saves after that window are later edits and
are never compared with our text. Every halt is written **before** the row leaves `posting`, so the single-POST
lock never opens ahead of the halt. Reads that keep failing are reported as
infrastructure errors; 2 hours after the POST an unverifiable row becomes `verify_failed`.
Any `rejected`, `unknown_outcome`, `verify_failed`, second credit entry, or a teacher/admin submit event between
the fresh read and the POST **halts** the autowriter (`feedback_autowriter_control.halted_at`) until an owner
resumes. Halt reasons accumulate (`first | then: second`), so a manual pause never hides a later automatic halt.

## Gate dispositions

| Disposition | Examples | Result |
|---|---|---|
| retry | class still running, no summary yet, no auto-blank yet; no student or attendance under 50% **within 60 minutes of the class end** (Wise may still be computing attendance) | back to `pending` in 10 min; alert if still no summary 3 h after class |
| scope | offline, group, cancelled | `skipped_scope`, no alert (tutor's own) |
| human | someone already wrote feedback | `skipped_human` |
| person | absence or partial attendance after the 60-minute settle window, form or billing drift, draft failed checks | `held` + alert |
| expired | deadline too close | `expired` + alert; a switched-off tutor's class is handed back instead (`skipped_scope`, `tutor_off_at_deadline`, no alert) |

The same dispositions apply when a gate fails on the fresh read just before the POST.

Alerts go out as one digest per sweep to `FEEDBACK_AUTOWRITER_ALERT_EMAILS` through the Apps Script relay. Outside
`live` mode, draft alerts (`held`, `expired`, `no_summary`) are recorded on the row and the dashboard but not
emailed (`alerts_sent` = `suppressed:<mode>`) — tutors still write their own then. Alerts about an actual Wise write
(`rejected`, `unknown_outcome`, `verify_failed`) are emailed in every mode. Mode `off` still reconciles posted rows.
Preview deployments never touch autowriter state.

## Costs

Writer (Sol, reasoning `low`) ≈ $0.04 per draft (mean of the 30 Sep comparison's transcript drafts). The GLM judge
cost ≈ $0.0008 per check at reasoning `medium` on a summary in the 2026-09-29 pilot; since v5 every draft is checked
twice (`medium` and `high`), about $0.004 more per transcript draft than one `high` call. A Luna fallback draft cost
≈ $0.0012 in the pilot (summaries), when GLM also wrote for ≈ $0.0024. ~200 online classes/month across
the five tutors → roughly $8–10/month, plus Soniox for the second pass (≈ $0.10 per audio hour). Transcript first
sends every class to Soniox: about $0.10 per class-hour of recording, ~$22/month. Each call's tokens and billed cost
are in `feedback_autowriter_calls`.

## Side effects to know

- Wise records the edit as made by the API key's owner (currently Kemjira (Kem) Waritpariya, OWNER). Class
  Feedback counts it as on time (role-blind timing, D-EVT-04).
- Known limitation: because "ours" is matched on that owner's user id, Kem's own saves in the Wise web app look
  like autowriter POSTs in the event feed — a save of hers between our fresh read and our POST would not be
  detected as a possible overwrite. A dedicated Wise API user would remove this; until then it relies on Kem not
  writing tutor feedback for roster tutors' online classes.
- Wise's `allowTeacherFeedbackUpdate=false`: once filled, tutors can't edit in Wise; admins can.
- Progress Tests ignores versions not authored by the session teacher, so autowritten feedback is not used as its AI context.
