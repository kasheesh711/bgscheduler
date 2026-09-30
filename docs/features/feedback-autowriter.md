# Feedback Autowriter

**Status:** live since 2026-09-29, constrained rollout (5 tutors, both of each tutor's Wise accounts). **Code:** [`src/lib/feedback-autowriter/`](../../src/lib/feedback-autowriter/).
**Runbook:** [`operations/feedback-autowriter.md`](../operations/feedback-autowriter.md). **API:** [`reference/api/feedback-autowriter.md`](../reference/api/feedback-autowriter.md).
**Dashboard:** `/feedback-autowriter` (nav: Scheduling & Tutors → Feedback Autowriter). Admins see posts, shadow drafts
and holds with the written text, class-end-to-post latency, model cost and webhook deliveries; only the owner sees the
mode, pause/resume and per-tutor switches (one per tutor, covering both of their Wise accounts). In-person classes on a
roster account are skipped at once (Wise type `OFFLINE`) and left out of the dashboard entirely — they stay the
tutor's to write.

Writes a tutor's post-class feedback for **online one-to-one classes** from Wise's AI meeting summary and
completes Wise's own **blank auto-submission** through the same endpoint the Wise web app uses
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
   feedback posted ~2–3 minutes after class. The [backstop cron](../reference/crons.md#feedback-autowriter-job)
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
   part before the dot in the Wise name's brackets ("Somchai (Tom.Ja) Jaidee" → "Tom"), or the first name when
   there is none (owner decision, 29 Sep). The writer and the judge both get the **class details** from Wise
   (`describeClass` in [`prompt.ts`](../../src/lib/feedback-autowriter/prompt.ts)): at BeGifted Wise's `classSubject`
   is the programme or level band ("11+/13+", "Y9-11 / G8-10 (Int.)") and the subject is only in the session title
   ("Live Session - NVR" → "NVR"). Confirmed terms are expanded — 11+/13+ = the ISEB 11+/13+ entrance tests,
   NVR / Non VR = Non-Verbal Reasoning, VR = Verbal Reasoning, Sci = Science — and nothing else is guessed. The
   judge treats the class details as true, so naming the programme or subject is never a "made-up" claim. Deterministic validation (300-char policy, placeholder, absence wording,
   copy-similarity against the tutor's 90 days of feedback and the autowriter's own posts).
5. **Judge.** GLM (Together, zero data retention, reasoning `high`) checks the draft against the summary:
   unsupported claims, things given to the wrong person, homework the tutor never set (v4, below). Unfaithful or
   invalid → fallback writer `openai/gpt-6-luna` (zero data retention), validated and GLM-judged the same way. Both
   fail → **held** + alert. An answer to the primary writer's request from any model other than Sol is an
   infrastructure failure, never a reason to fall back; the Luna fallback has no such model check.
   Service failures (credit, outage, time-out, a provider-side generation error, a judge that gives no verdict
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

## Models

Since 2026-09-30 (owner decision: "Switch the writer to Sol for everyone today"; migration 0100 adds the arm `sol`).
All three go through OpenRouter with `zdr: true`, `data_collection: "deny"` and `require_parameters: true`, so neither
a summary nor a transcript ever reaches a host that retains it ([`config.ts`](../../src/lib/feedback-autowriter/config.ts)).

| Role | Model | Route | Reasoning | Route check |
|---|---|---|---|---|
| Writer (`sol`) | `openai/gpt-6.1-sol` | any zero-data-retention host (Azure today) | `low` | the answer must come from `openai/gpt-6.1-sol` |
| Fallback writer (`luna`) | `openai/gpt-6-luna` | same | `max` | — |
| Judge (`glm`) | `z-ai/glm-5.3-flash` | pinned to Together, no host fallback | `high` (v4; was `medium`) | host `Together` and that model |

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
4. writes (Sol, Luna fallback) and judges (GLM) from the `[mm:ss] TUTOR/STUDENT` transcript, exactly like the
   summary path. Thai-script names can slip past the Latin-name redaction, so a transcript may only go to
   **zero-data-retention routes** — which every model now is (until 30 Sep only GLM had one, so transcripts were
   written by GLM alone, with no fallback). Extra rule: what the tutor
   explained is "covered", not "mastered", unless the student is shown doing it. A long transcript keeps its start
   and end (homework is usually set last). Any Thai text the model writes fails validation (English only; the
   student's own name, restored afterwards, may be Thai);
5. posts through the same guarded path (gates without the summary requirement).

A webhook waits up to ~3 minutes for Soniox; the backstop only looks and comes back, so one slow job never starves
the other classes. A transcript draft that was judged but whose POST did not go out (another POST in flight, or a
pre-POST gate that says "try later") is reused on the retry, as long as the current prompt and judge versions wrote
it (v4, above). While Wise itself is not ready (attendance, status, the
POST slot, a failed read once a draft exists) the class waits in `pending`, not `awaiting_recording`. Three Soniox failures (errors, a job running
over an hour, or a run whose status checks never get an answer; within one run a failed check after a good answer
does not count, and the backstop checks once per run), several recording parts, a recording too short for the
class, or a transcript under 800 characters → `held` + alert. A
class still waiting for its recording (or its transcript) 3 hours after class raises a `no_recording` alert (live
mode; not for a switched-off tutor, a short recording waiting for its recheck, or an infra retry); rows still
waiting at the deadline margin expire with an alert as before.
Soniox jobs of finished rows and of shadow drafts are deleted by the sweep once their review window is over or the
class is triaged; a refused delete is retried at the next sweep.

Pilot (2026-09-29, 8 classes): on Thai/English lessons Soniox kept the English terms that Zoom's transcript lost and
was preferred in 17 of 18 compared windows; no gain on English-only lessons.

Switch: `FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED=true` plus `SONIOX_API_KEY`; off → the fast path behaves as before.

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
cost ≈ $0.0008 per check (at reasoning `medium`; `high` since v4 is not re-measured yet) and a Luna fallback draft
≈ $0.0012 in the 2026-09-29 pilot (summaries), when GLM also wrote for ≈ $0.0024. ~200 online classes/month across
the five tutors → roughly $8–10/month, plus Soniox for the second pass (≈ $0.10 per audio hour). Each call's tokens
and billed cost are in `feedback_autowriter_calls`.

## Side effects to know

- Wise records the edit as made by the API key's owner (currently Kemjira (Kem) Waritpariya, OWNER). Class
  Feedback counts it as on time (role-blind timing, D-EVT-04).
- Known limitation: because "ours" is matched on that owner's user id, Kem's own saves in the Wise web app look
  like autowriter POSTs in the event feed — a save of hers between our fresh read and our POST would not be
  detected as a possible overwrite. A dedicated Wise API user would remove this; until then it relies on Kem not
  writing tutor feedback for roster tutors' online classes.
- Wise's `allowTeacherFeedbackUpdate=false`: once filled, tutors can't edit in Wise; admins can.
- Progress Tests ignores versions not authored by the session teacher, so autowritten feedback is not used as its AI context.
