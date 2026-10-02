# Feedback Autowriter

**Status:** live since 2026-09-29, constrained rollout (18 tutors since 2026-10-02, both of each tutor's Wise accounts). **Code:** [`src/lib/feedback-autowriter/`](../../src/lib/feedback-autowriter/).
**Runbook:** [`operations/feedback-autowriter.md`](../operations/feedback-autowriter.md). **API:** [`reference/api/feedback-autowriter.md`](../reference/api/feedback-autowriter.md).
**Dashboard:** `/feedback-autowriter` (nav: Scheduling & Tutors → Feedback Autowriter), described in
[Dashboard](#dashboard-feedback-autowriter): a to-do list for the owner, the expansion gate and its trends, one row per
tutor, and every class with its written text in a side drawer. Every admin reads it; only the owner records verdicts,
acknowledges incidents and sees the mode, pause/resume and per-tutor switches (one per tutor, covering both of their
Wise accounts). In-person classes on a roster account are skipped at once (Wise type `OFFLINE`) and left out of the
dashboard entirely — they stay the tutor's to write. What the page measures — first-shot accuracy, coverage and the
expansion gate — is defined in [Operating loop: measurement](#operating-loop-measurement-phase-1-migration-0101).

Writes a tutor's post-class feedback for **online one-to-one classes** from Wise's AI meeting summary — or, with
[transcript first](#transcript-first-switch-30-sep) on, from a Soniox transcript of the lesson recording, with the
summary as the fallback — and completes Wise's own **blank auto-submission** through the same endpoint the Wise web app uses
(`POST /teacher/classes/{classId}/session/{sessionId}/feedback`). It is a separate module on purpose:
[Post-Class Feedback](./post-class-feedback.md) stays read-only toward Wise and never generates feedback; it
simply ingests what the autowriter posted like any other submission.

## Scope

| Rule | Where |
|---|---|
| Only the roster tutors, on both of their Wise accounts: Kevin, Gift, Ek, Peat, Mimi (29 Sep, chosen by online-class volume to cover ≥20% of institution online classes), plus Ras, Celeste, Taki, Dome, Mandy, Grace, Mint, Fluke (Chettaporn, not Fluke-Supha), Calvin, Lukas, A (Anavat), Ohm and Mookie (2 Oct, owner decision, written by Luna first — see [Models](#models)). On both accounts: the "… Online" one and their main one. Tutors teach online from either (all of Gift's online classes in September were on her main account); in-person classes on either are skipped by the session type below | [`roster.ts`](../../src/lib/feedback-autowriter/roster.ts) |
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
4. **Write.** `openai/gpt-6.1-sol` (GPT-6.1 Sol) on a zero-data-retention route, reasoning `low` — or, for the 13
   tutors added on 2 Oct, `openai/gpt-6-luna` (reasoning `max`) first with Sol as their fallback (see
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
5. **Judge.** GLM (Together, zero data retention) checks the draft against the summary at reasoning `medium` and
   `high`, in parallel on the same messages, and the draft passes only when both do ([v5](#judge-v5-and-writer-v5-30-sep-afternoon)):
   unsupported claims, things given to the wrong person, homework the tutor never set (v4, below). Unfaithful or
   invalid → fallback writer `openai/gpt-6-luna` (zero data retention), validated and GLM-judged the same way. Both
   fail → **held** + alert. An answer to the primary writer's request from any model other than Sol is an
   infrastructure failure, never a reason to fall back; the Luna fallback has no such model check.
   Service failures (credit, outage, time-out, a provider-side generation error, a judge level that gives no verdict
   twice) never go to the fallback: the session retries in 10 minutes and the run reports an infrastructure error.
   A rate limit is first tried again in the same run, a few seconds apart
   ([below](#rate-limits-tried-again-in-the-same-run-30-sep-evening)).
6. **Shadow or live.** Shadow stores the draft (`would_submit`). Live runs
   [`submitFeedbackGuarded`](../../src/lib/feedback-autowriter/submit.ts): credit baseline → fresh read (all gates
   again) → POST claim → one POST (never retried) → read-back of text, status, credits and the session's single
   credit entry → a non-auto submit event by the API owner (`WISE_USER_ID`). The claim needs a valid lease, mode
   `live`, no halt, the teacher from the fresh read equal to the stored one and switched on, **no other unsettled
   POST** (`posting` or `awaiting_event` — the latter can still turn into a halt, so it keeps the lock; the claim
   checks both and a partial unique index on `posting` settles simultaneous claims; a second session re-checks
   every 10 s for up to ~80 s, then leaves it to the next sweep), and at least 240 s of function time for the POST
   phase — checked before the three pre-POST reads (up to 45 s each; none is made for a POST that could not be
   claimed) and again right before the claim. While an unsettled POST is older than 6 min (waiting for the sweep),
   nothing is drafted at all.
   A shadow draft finished after the owner switched to `live` goes back to `pending` (atomically with the mode),
   so it is posted rather than stranded in `would_submit`.

### Writer and judge v4 (30 Sep)

Two 29 Sep posts went wrong in ways the v3 prompts allowed. A summary named another student next to ours ("…
noting that <another student> mentioned only 8 pages …"): redaction replaces only the student's and the tutor's
names, so that name was the only real one left, the writer took it for our student and added a homework line, and
the judge (reasoning `medium`, ~100 reasoning tokens) passed it. Another summary ended "…had three remaining homework
problems to complete" (a mis-hearing); the writer posted it as homework and repeated it under "Need more work on".
Prompt and judge versions became 4 ([`prompt.ts`](../../src/lib/feedback-autowriter/prompt.ts),
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
  `judge:medium:judge_unparseable`). Once one level has rejected the draft or stopped the run, the other makes no
  second try and no further in-run retry ([below](#hardening-follow-ups-30-sep-night)). Both calls are in
  `feedback_autowriter_calls` with `result.effort` and `prompt_version = 5`, plus `result.judgedGeneration` — the
  draft they judged: the writer reply's generation id, or a key of the pipeline's own when the reply carries none —
  so the dashboard counts a rejected draft once.
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
  run posts it without calling a model. A summary's worst case posts in the same run with 20 s to spare (560 − 180 −
  120 = 260 s left) — when no call was rate limited; with waits of more than those 20 s it does not
  ([below](#rate-limits-tried-again-in-the-same-run-30-sep-evening)).
- **`writer_failed` counts the writer only** ([transcript first](#transcript-first-switch-30-sep)). A judge failure
  just retries every 10 minutes, as before, and a run that ends in one starts the writer's count again — as does a
  run that stores a draft. The count is not reset merely because a writer delivered a draft: a run in which a judge
  rejects Sol's draft and the Luna fallback then fails ends in a writer failure and counts (owner decision, 30 Sep
  17:00). A rate limit never counts either — including the writer route's upstream rate limit, which OpenRouter
  reports inside a 200 response with the status (429) in the body ([`openrouter.ts`](../../src/lib/feedback-autowriter/openrouter.ts)
  reads it from there): in the 30 Sep replay that error was taken for the writer's own failure and sent a class back
  to the summary.
- **No other names.** Summary rule 12: "Never name anyone but `[STUDENT_1]`: refer to any other person generically —
  "another student", "a classmate", "a family member" — never by name." Transcript rule 13, which already said never
  to repeat any name, now ends "… and refer to anyone else generically ("another student", "a classmate", "a family
  member")". The tutor is never named either (unchanged). A prompt rule only: nothing holds a draft for a name, and
  the judge is not asked about it. It is absolute — authors and characters in the lesson material are not an
  exception.

### Rate limits: tried again in the same run (30 Sep, evening)

Owner decision: "add quick in-run retries on a rate limit so posts don't wait a whole sweep". The writer's route was
rate-limited upstream on and off that afternoon, and a second request a few seconds later usually went through, while
the class waited 10 minutes or more for its next run.

- **What counts as a rate limit.** OpenRouter's own limit (HTTP 429), or the model's upstream one, which OpenRouter
  reports inside a 200 response. It is read in every form it takes there
  ([`openrouter.ts`](../../src/lib/feedback-autowriter/openrouter.ts)): the code 429 as a number or as text (`"429"`),
  on the response (`error.code`) or carried on the choice (`choices[0].error.code`, as when a generation ends with
  `finish_reason: "error"`). Only a 429 is read this way — any other error on a choice is still the model's own
  generation error, and any other code given as text keeps the response's status.
- **What happens.** The same request is sent again in the same run, up to three more times, after about 4 s, 10 s and
  25 s — each ±30% at random, so classes that end at the same time do not retry at the same time. When OpenRouter
  says how long to wait (`Retry-After`, or the reset time of its own limit as listed with the error), we wait at
  least that long and at least the schedule's wait, with the spread on top, up to 30 s. A wait it asks for is never
  cut short: one longer than 30 s, or than what is left of the call's 45 s, means the call is not tried again in this
  run — a retry before the time it named would only be rate limited again — and the rate limit stands. One call's
  waits never add up to more than 45 s. Every model call of the pipeline goes through
  this (`callWithRateLimitRetries`) — the writer, the fallback writer and each judge level — and so does the replay,
  including its judging of posted drafts. Nothing else is tried again this way: a time-out, a provider error, a reply
  that is not JSON or an answer from another model are handled at once, as before.
- **Time.** A retry is made only when its wait and the call's whole time-out still end before the function's deadline
  minus 45 s — the rule every model call starts under. Otherwise the rate limit stands at once and the class retries
  later, as before. So a judge is still never started without its full time-out, and every model call still ends at
  least 105 s before Vercel would stop the function. The waiting comes out of what is left for the POST; the POST is
  still started only with its 240 s, and a run that no longer has them keeps the judged draft: the next run posts a
  transcript draft as stored, without a model call, and writes a summary again. Worst case: 45 s more for one call;
  in a run, each step — the writer, the two judge levels (they wait at the same time), and for a rejected draft the
  fallback writer and its judges — can add up to that. So once the waits add up to more than 20 s (one call that
  used all three retries waits 27–45 s), a summary's worst case no longer posts in the same run either: 215 s are
  left after one such call, 170 s after two.
  A sweep runs its classes one after another and starts a class only while 560 s remain, so one class's waits are
  time the classes after it do not get. Once a class of a sweep ends still rate limited at a stage (the writers'
  route, or the judge's), the classes after it make no in-run retries at that stage in that sweep, and the rows
  close to their deadline and those that call no model are started first
  ([below](#hardening-follow-ups-30-sep-night)). A webhook run is one class on its own and always keeps its retries.
- **What it still means.** Unchanged: a rate limit is never the writer's failure (it does not count toward
  `writer_failed`) and never a reason for the fallback writer. A call still rate limited after its retries ends the
  run with the same `infra:…` reason as before, and the class retries in 10 minutes.
- **Call records.** Every attempt is a row in `feedback_autowriter_calls`: a rate-limited one has `ok = false`, its
  error and no cost, and each attempt after the first carries `result.rateLimitRetry` (1, 2 or 3), so retries can
  be counted ([runbook](../operations/feedback-autowriter.md#8-writer-model-gpt-61-sol-since-2026-09-30)). The rows
  of a call are written when the call ends, after the waits, so each rate-limited attempt says itself when its
  request was sent (`result.attemptAt`), the wait OpenRouter asked for when it named one (`retryAfterMs`) and the
  wait that followed (`waitedMs`). Coverage reads "when we started writing" from `attemptAt` before `created_at`, so
  a tutor's save during the waits is not taken for "the tutor wrote first". The query casts `attemptAt` only when it
  is a time in the form we write (`ATTEMPT_AT_PATTERN` in `quality.ts`): a malformed value dates the call by its row
  instead of failing the day's metrics.

### Hardening follow-ups (30 Sep, night)

The non-blocking findings of the two reviews of the day (judge v5, the in-run retries), closed before transcript
first is switched on. No prompt changed: writer and judge versions stay 5.

- **A sweep under a lasting rate limit** (`runSweep` in [`job.ts`](../../src/lib/feedback-autowriter/job.ts)). A
  sweep starts a class only in its first 180 s, so waits spent on a limit that does not clear would keep its other
  classes out. Two rules:
  - *Order* (`sweepOrder`). Three groups, in this order:
    1. **The rows close to their deadline**, whatever they need: the feedback deadline (`deadline_at`) is no more
       than 3 hours away (`AUTOWRITER_SWEEP_NEAR_DEADLINE_MS`), soonest deadline first. The sweep expires a class 30
       minutes before its deadline, so these are the classes with at most 2.5 hours of tries left.
    2. **The rows that call no model**: a stored judged transcript draft to post, a class waiting for its recording
       or about to submit it to Soniox (no job yet).
    3. **The rows that may need the writer**: a summary to write, a transcript whose Soniox job exists — ready, or
       still running at the last look — a draft whose model call failed. A job that was still running may have
       finished since; its row then calls the writer and both judges in the same run, so it is not in group 2
       (review fix, 30 Sep night: there it could fill the start window ahead of rows near their deadline).

    Within groups 2 and 3 the most urgent deadline comes first, and a row whose last attempt ended in a model or
    service failure (reason `infra:…`) comes after every row that has not failed — so one class that keeps failing
    never takes the front of its group. Rows of group 1 with the same deadline keep that order too, the rows that
    call no model first; every class's deadline is 23:59 Bangkok, so tonight's classes all share one. The order is
    read from the row (its deadline, evidence, stored draft and Soniox job); what a row needs is a guess about its
    next step, not a promise. It decides what is started, not how long each takes: the time the rows in front use
    is time the rows behind them do not get, so a rate limit or a slow call in group 1 can still delay groups 2 and 3.
  - *Retries.* Once a class ends still rate limited (its call gave up on the limit — after its retries, or at
    once when the wait did not fit), the classes after it in that sweep make no in-run retries **at that stage**: a
    rate limit there is returned at once, as before the retries existed, and the class retries in 10 minutes. There
    is one switch per stage (review fix, 30 Sep night): the writers (Sol and the Luna fallback) and the judge are on
    different routes with limits of their own, so a limit on the writers' route leaves the judge's retries on, and
    the other way round. The next sweep starts with retries on again. A webhook run is one class per function and
    always keeps its retries.
- **A judge that keeps failing on a class.** Judge failures never count toward `writer_failed`; the class retries
  every 10 minutes until its deadline, and an infra retry raises no `no_recording` alert — so it could fail unseen
  until it expired. Runs in a row that end at the judge stage, with no answer of the judge in between, are now
  counted, on the summary path and the transcript path alike, in two counts with a mark each (review fix, 30 Sep
  night):
  - `metadata.judgeErrors` — **the judge's own failures**: a level timing out, giving no verdict in two tries,
    answering from the wrong route or model, a provider error. **The third** alerts
    (`AUTOWRITER_JUDGE_ERRORS_ALERT`).
  - `metadata.judgeUnreached` — **the runs in which the judge could not be asked**: its route rate limited (after
    the in-run retries), no time left in our own function to start it, or our OpenRouter account or connection
    refusing the call (no credit, a bad key, the network); `metadata.judgeUnreachedCause` keeps which it was the
    last time (`rate_limited`, `out_of_time`, `account_or_connection`). They are not the judge's failures and
    usually pass on their own — a rate limit hits every class at once — so alone they alert only when **both
    counts together reach six** (`AUTOWRITER_JUDGE_STAGE_ERRORS_ALERT`).

  Either mark raises one **`judge_failing`** alert in the digest. Its text says how many runs and why, and blames
  the judge model only for its own failures: "not a failure of the judge model: OpenRouter rate limited the judge's
  route", "… our own function ran out of time before the judge could start", or for a mix "failures of the judge
  model: 2; not its failure: 4 — the last time, …". The row's reason follows in
  brackets (e.g. `infra:judge:high:timeout`). The class retries exactly as before.
  The alert is sent once per run of failures. Both counts go back to zero when the judge answers: a run that ends
  with a judged draft (posted or kept for the next run), and also a run in which the judges gave their verdict on
  Sol's draft and the run then failed another way — the Luna fallback failed, or its judge did (the pipeline result
  says `judgeAnswered`). So "in a row" never spans an answer. A later run of failures that reaches a mark alerts
  again: `metadata.judgeFailingSince` records when it did, and the digest's relay key carries it for this kind, so
  the relay does not take the second alert on a class for a repeat of the first (the keys of the other kinds are
  unchanged). An alert raised outside `live` is recorded, not emailed (`alerts_sent.judge_failing` =
  `suppressed:<mode>`); if the class is still failing once the autowriter is live, its next failure arms the alert
  again and it is emailed. An alert not yet sent is dropped when the judge answers or the class settles (posted,
  held, written by the tutor, expired). A failure of the writer with no verdict in the run says nothing about the
  judge and leaves the counts where they were; an owner `--retry` clears them.
- **A wait OpenRouter asks for** ([`openrouter.ts`](../../src/lib/feedback-autowriter/openrouter.ts)): kept as
  described [above](#rate-limits-tried-again-in-the-same-run-30-sep-evening) — never a retry before it, never a
  wait shorter than the schedule's (a `Retry-After` of a second would otherwise spend all three retries at once).
  `Retry-After` is also read on an HTTP 429 whose body is not JSON; a `Retry-After` header that names no time ahead
  (empty, `0`, a past date) does not hide the one listed with the error; a header sent more than once (it reaches us
  as one list, `60, 120`) asks for the longest of its waits; and `X-RateLimit-Reset` is read only from
  the error's own header list (`error.metadata.headers`), since a response header of that name may describe another
  limit.
- **The POST budget comes before the pre-POST reads** ([`submit.ts`](../../src/lib/feedback-autowriter/submit.ts)).
  With less than 240 s of function time left, none of the three reads (up to 45 s each) is made: the judged draft is
  kept (`function_budget_too_small_for_post`, due again in 10 minutes) and the next run posts a transcript draft as
  stored. The check before the claim stays, for reads that were slow.
- **A judge level that can no longer change the outcome leaves off** (`pipeline.ts`). Once one level has returned
  an unfaithful verdict or stopped the run, the other makes no second try after an unusable reply and no further
  in-run retry of a rate limit. What it holds then is not a failure of its own: if the other level rejected the
  draft, the draft is rejected on that verdict and the fallback writer goes on; if the other level stopped, that
  stop is the outcome. The level is asked before each wait and again after it, so a retry is not sent either when
  the other level decided while this one was waiting (its record then keeps the wait it made, `waitedMs`). A call
  already in flight is not cut off, and a call that fails on its own after the other
  level's verdict (a time-out) is still a judge failure, as before. A draft still passes only on a complete verdict
  from both levels.

## Models

Since 2026-09-30 (owner decision: "Switch the writer to Sol for everyone today"; migration 0100 adds the arm `sol`).
Since 2026-10-02 the writer order is chosen per tutor (`writersFor` in `config.ts`, from the roster's `writer` field,
keyed by canonical tutor key so both accounts match): the 13 tutors added that day are written by Luna first and Sol
as their fallback (owner decision); everyone else Sol then Luna. The judges are the same for every tutor. The
model check below applies to Sol whichever place it takes. All three go through OpenRouter with `zdr: true`, `data_collection: "deny"` and `require_parameters: true`, so neither
a summary nor a transcript ever reaches a host that retains it ([`config.ts`](../../src/lib/feedback-autowriter/config.ts)).

| Role | Model | Route | Reasoning | Route check |
|---|---|---|---|---|
| Writer (`sol`) | `openai/gpt-6.1-sol` | any zero-data-retention host (Azure today) | `low` | the answer must come from `openai/gpt-6.1-sol` |
| Fallback writer (`luna`) | `openai/gpt-6-luna` | same | `max` | — |
| Judge (`glm`) | `z-ai/glm-5.3-flash` | pinned to Together, no host fallback | `medium` and `high`, in parallel — both must pass (v5; one call at `high` in v4, at `medium` before) | host `Together` and that model |

Why Luna for the 2 Oct tutors (owner decision, 2 Oct): DeepSeek V4.1 Flash was tried first for them; in a read-only
replay of their recent online classes none of its 4 transcript drafts passed the GLM judges, while Luna's passed in 2
of 3 classes. Every one of these tutors' posts is reviewed (new tutors are always reviewed at 100%).

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
   its window); the window starts again when the class is next done. A reviewer finds the job by the row's
   `soniox_transcription_id` (Soniox Console). `metadata.triagedAt` ends the window early: the owner's first
   accurate verdict on the posted class (Approve, or Needs fix · cosmetic) writes it (the review drawer), and the next sweep
   deletes the job. A major or critical verdict does not end triage — and re-opens it when it replaces an earlier
   Approve: the transcript stays for the root-cause work until the 72 h window closes. A delete that fails keeps the job
   id so the sweep retries it, and the sweep also
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
the other classes. A transcript draft that was judged but whose POST did not go out (another POST in flight, a
pre-POST gate that says "try later", or too little function time left for the POST) is reused on the retry, as long
as the current prompt and judge versions wrote it and both judge levels passed it (v4 and v5, above). While Wise itself is not ready (attendance, status, the
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
carries neither. Owner decision (30 Sep), for every roster tutor: wait for the recording and write from its transcript;
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
  the class waited, or three runs in a row that end in a failure of the writer on the transcript draft
  (`writer_failed`: a writer timing out, answering with something that is not JSON or from the wrong route, or a
  provider error — counted in `metadata.writerErrors`, the last one in `writerFailure`; owner decisions, 30 Sep). The
  count starts again when a run ends in a judge failure or with a stored draft — not whenever a writer delivers one:
  a run in which a judge rejects Sol's draft and the Luna fallback then fails ends in a writer failure and counts
  (owner decision, 30 Sep 17:00). Not counted, and retried every 10 minutes as before: a judge failure (a run of
  them on a class raises one `judge_failing` alert, [above](#hardening-follow-ups-30-sep-night)), Wise and Soniox
  errors, the function's own time, and our OpenRouter account or connection (a bad key, no credit, rate limited, the
  network). The row goes back to `pending` with `evidence = summary`, due at once, reason
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
- A model reply that is JSON but no object (`null`, a bare string) is an `invalid_json_response`, like one that is
  not JSON at all — a model failure that is retried, never an unexpected error.
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
| expired | deadline too close | `expired` + alert; a class whose tutor is switched off when the sweep runs is handed back instead (`skipped_scope`, `tutor_off_at_deadline`, no alert) |

The same dispositions apply when a gate fails on the fresh read just before the POST.

Alerts go out as one digest per sweep to `FEEDBACK_AUTOWRITER_ALERT_EMAILS` through the Apps Script relay. Outside
`live` mode, draft alerts (`held`, `expired`, `no_summary`, `no_recording`, `judge_failing`) are recorded on the row
and the dashboard but not emailed (`alerts_sent` = `suppressed:<mode>`) — tutors still write their own then. Alerts about an actual Wise write
(`rejected`, `unknown_outcome`, `verify_failed`) are emailed in every mode. Mode `off` still reconciles posted rows.
Preview deployments never touch autowriter state.

## Operating loop: measurement (Phase 1, migration 0101)

Measures every post against the owner's goal — **first-shot accuracy of at least 80% before adding tutors** — and
never writes to Wise; the POST path is unchanged (plan: `.planning/quick/260929-lop-autowriter-operating-loop/`).

**Immutable post log** (`feedback_autowriter_posts`). One row per text we put in Wise: the first shot of each class
and every re-post. Content cannot change and rows cannot be deleted (triggers, SQLSTATE `55000`). First shots are
*proven*, not copied: the POST claim pinned `body_hash` (the exact POST body), so a candidate text is accepted only
when the body rebuilt from it — in one of the 64 possible form orders, with the stored billing — hashes to it. The
hourly review job snapshots every settled posted class this way (with the read-back's problem codes, never Wise's
response body). A class a one-time script re-posted no longer proves itself and gets an info incident until the
backfill script proves it from Class Feedback's first stored version or by reversing a rename — a critical one when
the post did not verify, since then nobody knows what is in Wise. Every one-time re-post a row records becomes a
post row with its own `dedupe_key` (recorded at most once), carrying the text it put in Wise (found by its hash): the
six nickname fixes of 29 Sep (`metadata.nicknameFix`, by `script:nickname-fix (kevhsh7@gmail.com)`, "owner naming
policy: nickname") as **`policy`** posts — a naming rule made after the post, never a fix (owner decision D-01, 30 Sep)
— and the owner-approved corrections of 30 Sep (`metadata.corrections[]` = `{fields, reason, fromSha256, toSha256, at,
by}`, by `script:correct-posts (kevhsh7@gmail.com)`) as **`correction`** posts, which are fixes.

**Verdicts** (`feedback_autowriter_verdicts`, append-only, the review drawer, owner only). Approve, or Needs fix with a
severity the owner must choose (there is no default) — `cosmetic` (still counts as accurate), **major** (stored as
`factual`; a real fix), `critical` (with a category: wrong person, billing/status, invented content, should not have
posted). A verdict is pinned to what the page showed — the first shot's `fields_sha256`, the class's current verdict
and its open flags — and refused (409, "refresh") when a verdict or a flag arrived since; it resolves only the flags
shown. A newer verdict supersedes the older one and becomes `reviews.current_verdict_id` in the same transaction.
A verdict judges the first shot as posted, so replacing a harsher judgement with a milder one is a **downgrade** the
owner confirms and explains (409 without the confirmation, 400 without a note; stored as `downgraded_from`): a
critical verdict or a critical flag answered with anything non-critical, or a major verdict with cosmetic or Approve —
an Approve after a fix never quietly turns an inaccurate first shot into an accurate one (re-recording the same
severity answers a new flag without changing the judgement). A critical verdict queues a critical incident, pushed
to the owner at any hour. Verdicts the owner gave outside the dashboard are committed as
`scripts/feedback-autowriter-owner-verdicts.json` (session ids and the owner's words, never a student's name — today
the two decisions of the 30 Sep interview: `699477ce…` critical, wrong person; `6ab89191…` major) and recorded once by
the backfill's `--apply` through the same path (`source: backfill`, reviewer `kevhsh7@gmail.com (owner interview
2026-09-30)`, pinned to the first shot); a class that meanwhile has another verdict, or a flag raised after the
decision, is left for the dashboard. The critical verdict keeps every gate window that holds its class
`blocked_critical`: blocked through the critical class's Bangkok date + 13 days (the dry run prints the date). Daily
gate rows recorded before `--apply` (the job ran first) stay as written: not a pass (unrecorded posts / required
pending) rather than `blocked_critical`.

**Review inclusion** (`feedback_autowriter_reviews`). Every first shot whose text may be in Wise gets one review row
when the job first sees it — verified posts, and also posts that landed without verifying (`verify_failed`,
`unknown_outcome`, a refused POST whose read-back found the submission changed) — with the inclusion reason,
probability and a crypto-random draw stored once and never changed by a flag. Until a tutor's cohort has passed a
gate every post is required (`new_tutor`, 100%) — in Phase 1 that is every tutor; a proven tutor would drop to a 30%
random sample plus flagged posts. A landed-but-unverified first shot is also flagged critical (`system`, category
billing/status when its credits or status changed, should-not-have-posted for a stranger's save in our POST window)
and pushed, so the gate stays blocked until the owner has judged it.

**Measured fixes** (`feedback_autowriter_fix_events`). Every `SessionFeedbackSubmittedEvent` on any class the
autowriter has a row for — held, skipped and expired ones included — from the Wise activity mirror, classified by
who saved it: our API user (`WISE_USER_ID`) matched to the first shot (`autowriter_first`), a correction
(`autowriter_correction`, a fix) or a policy re-post (`autowriter_policy`, never a fix) — the row's own settled POST
and the one-time re-posts it records count too, before the backfill records them; an API save no post explains
(`api_actor_unmatched` — a script outside the lock, or the key owner's own web save) raises an incident, critical
(pushed) from the autowriter's go-live (29 Sep 2026 08:07:30 UTC) and info before it (the prototype's saves that
morning); Kevin's web user `695369c0…986` is `owner_web` (also his main roster account, so on his classes an owner
fix and a tutor edit look the same — both count); roster accounts are `tutor`; anyone else `other_staff`; students
and Wise's auto-submissions are ignored. A class whose POST is still settling is left for the next run. Without
`WISE_USER_ID` nothing is classified and the run is red. **Fixes until satisfied**: a save after our first post counts
(in total and per actor kind) up to the owner's current Approve and flags the class for review (`measured_fix`);
one after the Approve is listed ("after approval — not counted") unless a later verdict replaces the Approve; every
correction counts, a policy re-post never does (not in the fix count, the fix rounds, the flags or accuracy). Fix
rounds per post (0 / 1 / 2 / 3+) are final only for approved classes; the rest are unresolved.

**Numbers** (`quality.ts`, pure). Accuracy = accurate ÷ owner-reviewed required posts (a voluntary review of an
unsampled post never counts), judged on the two-sided 95% Wilson lower bound (z = 1.959964; with no errors 9 reviews
reach 70% and 16 reach 80%; 20/20 → 83.9%), stored unrounded and shown rounded down (87/99 is 79.9%, never "80%").
Coverage = posted ÷ (posted + held + written after our draft + expired + failed + never seen). Each class is judged by
the mode, its tutor's switch and the roster during **its own posting window** (class end → deadline − 30 min), read
from `feedback_autowriter_control_history` (a trigger on the control row logs every mode or switch change) and
`feedback_autowriter_roster_accounts` (when the job saw each code-roster account) — never by today's switches: a class
the switches never let us write (mode not live, or its tutor switched off throughout) is excluded, and before the
history starts every class counts as live (fail-closed). A class the tutor wrote first — a person's
save recorded before our first writer call, successful or not (while we still waited for the evidence) — counts on
neither side; one a person wrote after we started (a draft ready, or a writer outage) is a miss (`late`), and so is
one whose person save is not mirrored yet, and a class still unsettled once its window closed. A roster class the autowriter never
saw counts as a miss only when proven online one-to-one (past-session mirror or the Wise title in Credit Control) and
its account was on the roster during the window. Out-of-scope and in-progress classes count on neither side, and
in-person classes not at all. **Holds (owner decision D-03, 30 Sep)**: a hold for the class's own data — recording too
short or in several parts, speakers unclear, transcript too short, no student or attendance below the minimum (a
fractional percentage is named by its whole percent, rounded down: 42.5 → `attendance_42pct`), the student not a Wise
user (`student_not_wise_user`, or `student_id_missing` when only the POST's fresh read finds it) — is left out
(`excluded_data_quality`), and so is a class handed back at the deadline because its tutor was switched off
(`excluded_tutor_off`). The sweep stamps a hand-back from the switches when it runs — up to 15 minutes after the window
closed, or only once the mode is back from `off` — so coverage reads the control history instead: the hand-back is left
out only when its tutor was switched off at the moment its window closed (however long it was workable before). One
whose tutor was switched off only afterwards is judged like the expiry it replaced: a miss (`expired`), unless the
switches never let us write it at any point of its window (then excluded, as any such class). Every other hold — the
judge found the draft unfaithful, the validator or the form rejected it, billing drifted, an error — is a miss, as is
any reason not in the table (`DATA_QUALITY_REASONS` in `quality.ts`, fail-closed).
**[Transcript first](#transcript-first-switch-30-sep)** adds nothing to the table. A class waiting for its recording
(`awaiting_recording`, `transcript_first`), being transcribed, or back on the summary after a fallback (`pending`,
`summary_fallback:<cause>`) is in progress while its posting window is open, and a miss (`expired`) once it has
closed. A class that fell back is judged by where it ends: posted from the summary it counts as posted, and its
fallback cause never leaves it out — not even a recording in several parts or unclear speakers, which are
data-quality holds only where the class is held for them (a second-pass class handed over for another reason). A
mostly-Thai summary held after a fallback (`thai_summary_no_transcript`) and a handover held for a missing student
name or tutor (`missing_student_or_tutor`) are misses. The job recomputes every date of the gate window on every run.

**Gate** (rolling 14 Bangkok days). `pass` = lower bound ≥ 80%, zero critical verdicts, no unresolved critical flag,
**no unexplained API write** (a critical `api_actor_unmatched` incident the owner has not acknowledged), coverage ≥
70%, no flagged post waiting for review, **no required post still unreviewed** (the gate never counts a hand-picked
subset) and every posted first shot recorded (a POST still settling counts as not recorded yet); `head_start` =
lower bound ≥ 70%; otherwise `below_head_start`, `insufficient_data` (nothing reviewed) or `blocked_critical`. The
dashboard evaluates it live with the same SQL as the job; the job writes one append-only `daily` row per Bangkok
date (from 22:00 Bangkok, else for yesterday), but only from a run in which every earlier step succeeded and whose
Wise activity mirror — checked before the run read it — synced within 30 minutes and reached known events (not its
page cap); otherwise the date waits for a later run (it stays due until 21:59 the next day) and the run records why
(`dailyGateSkipped`). Expansion grows the roster by half, rounded up (5 → 8 → 12 → 18), after the owner confirms
— Phase 6. On 2 Oct the owner went from 5 to 18 tutors in one step, before the gate passed (owner decision).

**The review job** (`/api/internal/feedback-autowriter/review`, hourly at :27 UTC, after the :17 activity sync):
push critical incidents already waiting → check the activity mirror → snapshot first shots → derive fix events →
create review rows → raise verification and fix flags → refresh review counts → recompute the metrics of the whole
gate window → write the daily gate row (see above) → push the incidents this run raised (email to each address in
`FEEDBACK_AUTOWRITER_ALERT_EMAILS`, LINE to `FEEDBACK_AUTOWRITER_LINE_TO` when set, with a 10 s timeout; delivery
tracked per recipient, retried up to 5 times, and never started when the 300 s function could be cut off mid-push).
An undelivered critical incident — one whose pushes gave up, or one that is due and never got its turn — keeps the
run red until the owner acknowledges it on the dashboard (What needs you → Incidents → Open). Single-flight through
`feedback_autowriter_review_runs`; paused with the autowriter.

## Dashboard (`/feedback-autowriter`)

One scrolling page that answers, in this order: **what needs the owner**, **are we getting better**, **who is next**.
It replaces the nine number cards and the Overview / Quality / Review tabs (redesign PR 1; design of 30 Sep in
[`docs/superpowers/specs/2026-09-30-autowriter-dashboard-redesign-design.md`](../superpowers/specs/2026-09-30-autowriter-dashboard-redesign-design.md),
mockup A beside it). Nothing the tabs showed was dropped; the last table below says where each item went. The hold
tracker, the forward-scan decisions and the expansion candidates (PRs 2–4 of that design) add their parts when their
data exists: until then there is no "tutor told" time, no Decisions group and no "Next in line" section.

| Part | What it shows | Read from |
|---|---|---|
| **System line** | Mode (and Halted); writer, fallback writer and judge with their reasoning efforts; "Transcript first" and "Second pass" on/off as they act; prompt and judge versions (the commit as a tooltip); the review job's last run and its status; the last Wise webhook. The owner's **Controls** menu (mode, Pause, Resume) sits at its end, and the red "Posting is halted" banner directly under it, with Resume on it | `dashboard.control`, `dashboard.system` ([`system-status.ts`](../../src/lib/feedback-autowriter/system-status.ts)), `review.lastRun`, `dashboard.webhooks` |
| **What needs you** (left, two thirds) | The to-do list, in groups that appear only when they have items: **Incidents** (critical, not acknowledged) → **Held** → **To review** (flagged posts first, then required posts without a verdict) → **Failed posts**. One action per row: Review or Open. A row never carries the feedback itself. The "N open" count counts classes (a post to review with an incident about it is one). Without the review data (migration 0101 not applied, or a failed load) the list has the held classes and the failed posts only: the headline then says "Some of what needs you could not load." and an empty list "Posts to review and incidents could not load — Refresh to try again.", never "Nothing needs you" | [`buildInbox`](../../src/lib/feedback-autowriter/inbox.ts), run in the browser on the two payloads the page already has |
| **Pilot health** (right, one third) | The gate as one sentence ([`gateSentence`](../../src/lib/feedback-autowriter/gate-sentence.ts): "Gate blocked until 13 Oct: critical on 29 Sep." — a date only when critical verdicts alone block it; a critical flag or an unacknowledged API save leads without one: "Gate blocked: 1 unacknowledged API save and a critical verdict (29 Sep)."), only the criteria that are not met, the lower-bound bar marked at 70% and 80%; accuracy and coverage over the gate's 14 days (daily points, 7-day line, current figure with its counts); and the **Today** line: posted · waiting for a recording · held · tutor wrote first · out of scope, for the classes ending today in Bangkok | `review.gate`, `review.daily` (and `review.lookback`), `dashboard.today` |
| **Trends** (2 × 2) | Accuracy and the gate (daily points, 7-day average, rolling 14-day Wilson lower bound, the 80% bar, a red marker on a day with a critical verdict) · Coverage (with the 70% floor) · Speed and cost (median minutes from class end to the post on the left axis, cost per posted class on the right) · Evidence and models (classes posted from the transcript and from the summary, the 7-day transcript share; writer share and holds by reason category below). A day without data is a gap, never a zero | `GET /api/feedback-autowriter/trends` ([`trends.ts`](../../src/lib/feedback-autowriter/trends.ts)) |
| **Tutors** | One row per roster tutor: accuracy (accurate / reviewed), Wilson lower bound, coverage (posted / eligible), holds (held in the window / still open), real fixes and critical verdicts, review phase, and the status with the owner's On/Off switch | `dashboard.tutors` joined to `review.tutors` by `tutorKey` |
| **Details** (collapsed) | **All classes** (the recent classes, every held class, and the review data's older posts; filters for review status, state, tutor and evidence) · By day · The gate in full (every criterion against its threshold) · By tutor (raw counts) · Totals, cost and speed · Wise webhooks · Incidents and the review job's last run | both payloads |
| **Drawer** | Whatever a row opens, in a right-hand sheet: a **review** (the immutable first shot — "recorded at post" or "reconstructed · hash-verified", with a warning when it landed without verifying — next to the current text with a word diff, the saves measured in Wise by actor, corrections, open flags, the verdict log, and the owner's Approve / Needs fix form), a **hold** (the reason in plain words from [`hold-reasons.ts`](../../src/lib/feedback-autowriter/hold-reasons.ts), the deadline countdown, the stored draft and the judge's problems when the page has them, when the alert was emailed), a **failed post**, an **incident** (with the owner's Acknowledge), or any other class of the log | the page's current payloads; a review as it was when it opened |

**Who can do what.** Every admin sees the whole page. Only the owner gets the Controls menu, the tutor switches, the
verdict form and Acknowledge; everyone else reads, and is told so ("Only the owner records verdicts.").

**Held classes.** `dashboard.holds[]` lists every class in state `held`, whatever its age (up to 500; past that, the ones that may still wait are kept first). `resolvedBy` is
`"tutor_wrote"` while the class's teacher feedback in Wise holds text, as the Class Feedback collection last read it:
`post_class_sessions.latest_feedback_version_id` points at the class's current teacher submission when its topics,
performance or improvement hold text, and at nothing otherwise, and the autowriter never posts to a held class
(`loadHeldClassesAPersonWrote` in [`dashboard.ts`](../../src/lib/feedback-autowriter/dashboard.ts); the collection
runs every half hour and takes a class with a new save first). Neither a save nor the version observed last says as
much: staff correcting the status or the credits of a class held for its billing, and a form submitted blank, are
saves too; and a version is stored once per content, so text written and taken out again would still be the latest
one. Either would take a class off the list with no feedback in Wise. So a hold someone settled without writing (a
student marked absent, or homework alone) stays
listed until a day after its deadline; the hold tracker of PR 2 records how each hold ended. The to-do list shows a
hold only while it still waits for someone (`isOpenHold`): nobody has written it, and its deadline is ahead or passed
less than 24 hours ago. It is amber with under 24 hours to the deadline and red with under 6 (or past it). The row
stays `held` either way, so every hold remains in All classes.

**Ranges.** The 14 / 30 / 90-day selector drives the four charts and their totals only. Everything that comes from
the review payload — the health rail, the tutor table, and the chart footers for fix rounds, review counts, misses and
exclusions — covers the gate's 14 days and says so. Every 7-day value is pooled (numerators and denominators summed
over the date and the six before it, then divided). For the window's first dates the rail takes those earlier dates
from `review.lookback`: the stored counts of the six dates before the window, which belong to no total and not to
the gate. The review job recomputes only the last 15 dates each hour, so
for longer ranges the trends loader recomputes accuracy from the review rows and their current verdicts; coverage for
older dates comes from the stored rows. While history is shorter than the range the section says since when, and
under 7 days that the 7-day lines cover only the days there are.

**The tutor filter.** A click on a tutor's row narrows the to-do list (in the browser) and the All classes log, reloads
the trends for that tutor, and highlights the row; the "Showing <tutor> ×" chip clears it. An item that belongs to no
tutor (a halt, an incident on a class the page does not hold) stays in every tutor's list. The health rail, and the
chart footers that come from the review payload, stay the whole pilot's and say "all tutors".

**Loading and polling.** The page's server component loads the dashboard (last 7 days), the review data and the
trends (14 days, all tutors) in parallel. In the browser the dashboard is polled every 60 seconds (abortable,
sequenced), the review data every 5 minutes and after each action, and the trends when the range or the tutor filter
changes. The app keeps the page, hidden and with its state, while you are on another page (`cacheComponents`): its
polls stop, and when it is shown again after a second or more it reloads all three at once. A review refresh that
fails keeps its own message until one succeeds, with the time the review data on the page is from (a dashboard
refresh does not clear it); the to-do list's footer names the review data's time whenever it differs from the
classes'. A post to review stays in its drawer as it was when it opened, and the verdict is checked against that
version (its first shot, current verdict and open flags): when a poll brings a newer version of the class — a new
flag, verdict, save or text — the drawer says "This class changed since you opened it — reload it before recording a
verdict", and Reload shows the newer version with a fresh form; nothing is swapped under the form, so a flag raised
meanwhile gets the server's 409 instead of being answered unseen. After a verdict or an acknowledgement goes through,
the drawer closes, the page says "Verdict recorded." or "Incident acknowledged." and reloads; a stale page (HTTP 409)
reloads the data and keeps the drawer open on its error, with the newer version behind Reload. The drawer opens with
the focus on its scrolling body, never on Approve (which records at once).

**All classes.** The dashboard loads the text of the latest 60 classes of its 7 days, so the log says "the latest 60
of N classes" when the window holds more: an older class is listed only when it is held or has a review row, and the
filters count the classes shown.

**When data is missing.** Before migration 0101, or when the review data fails to load, the to-do list keeps the held
classes and the failed posts, and the health rail and the trends say why (the two cases read differently; a failure is
logged by error name and SQLSTATE). When only the trends fail, the trends area says so and the rest of the page is
unaffected.

**Visual check.** `node scripts/dev/render-autowriter-dashboard.mjs` bundles the page with the made-up fixtures of
`src/components/feedback-autowriter/__tests__/fixtures.ts`, compiles the stylesheet, and screenshots it with headless
Chrome into the git-ignored `.feedback-autowriter/preview/` (`dashboard-owner.png`, `dashboard-admin.png`,
`dashboard-empty.png`, and the drawer on each kind of item), for comparing with the mockup. It needs no server and no
database.

| Before the redesign | Now |
|---|---|
| Nine number cards | The Today line; the speed-and-cost and evidence-and-models charts; Details → Totals, cost and speed |
| Tutors table (Overview) and By tutor (Quality) | The tutor table; Details → By tutor for the raw counts |
| Expansion gate card and its criteria | The gate card and the accuracy chart; Details → The gate in full |
| Coverage and fix-round chips | The chart footers |
| Review tab | The To review group and the review drawer; older reviewed posts through Details → All classes |
| Incidents list | The Incidents group (open ones); Details → Incidents and the review job (all of them) |
| Recent classes, cost, webhooks, daily tables | Details |
| The 24 h / 7 d / 30 d window selector | Gone: the page's own numbers cover the last 7 days, the gate's 14, and the charts 14, 30 or 90 |

## Costs

Writer (Sol, reasoning `low`) ≈ $0.04 per draft (mean of the 30 Sep comparison's transcript drafts). The GLM judge
cost ≈ $0.0008 per check at reasoning `medium` on a summary in the 2026-09-29 pilot; since v5 every draft is checked
twice (`medium` and `high`), about $0.004 more per transcript draft than one `high` call. A Luna fallback draft cost
≈ $0.0012 in the pilot (summaries), when GLM also wrote for ≈ $0.0024. ~200 online classes/month across
the first five tutors → roughly $8–10/month (Luna-first drafts for the 13 tutors added on 2 Oct cost ≈ $0.01 each on transcripts in the 2 Oct replay), plus Soniox for the second pass (≈ $0.10 per audio hour). Transcript first
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


## Mimi format and voice guide (prepared; activation awaits owner review)

`style.ts` selects the frozen `mimi` v1 guide by canonical tutor key, covering both Wise accounts, only when
`FEEDBACK_AUTOWRITER_MIMI_STYLE_ENABLED` is exactly `true`. It defaults to disabled. Other tutors use the existing
shared prompt. The four-field Wise interface, billing, eligibility, English and nickname rules are unchanged.

Mimi's topics, improvement and assigned homework are numbered lists; performance is warm, specific prose, usually
one or two paragraphs (at most three). Topics may have `Atom learning` or `Worksheets` labels only when the current
lesson record supports them. Plain hyphen sub-items are permitted beneath numbered topics and improvement items.
The guide drops the writer's 120-character per-field target and forced two or three improvement strategies. The
300-character combined policy and all other validators remain; only `short_required_field`, an autowriter
presentation heuristic, is replaced by guide structure checks. The Class Feedback collector and finance policy
are unchanged; their advisory short-field flags can still appear.

Three anonymised pre-rollout examples are frozen in `style-examples/mimi-v1.json`, with verification notes and
anonymous content hashes. Detailed source version/hash and non-auto Wise event/actor references are retained in
the private replay receipt, because the repository is public. Those events are by Mimi's roster accounts. Wise does not bind
an event to a content version, so the evidence is explicitly session-level. Historical content guides presentation
only, never lesson facts. Both writers get the same examples and guide; neither factual judge receives them.
Numbering, list/prose structure, labels and prohibited formatting are checked locally. Format failure tries the
fallback writer, then holds for human feedback (no summary-to-transcript escape for a format failure). Existing
copy detection, invented-score/homework checks and both factual judges still apply.

Drafts and writer call records carry guide id/version. Transcript reuse and shadow requeueing require the current
guide; disabling or changing it invalidates guided drafts. A check before storing/posting also prevents a draft
from crossing a guide switch. No database migration is required; stamps use existing JSON metadata.

See the [activation and replay procedure](../operations/feedback-autowriter.md#mimi-style-guide-review-and-activation).

## ISEB format v1, Mimi voice v2 and Atom evidence

The independent, initially disabled ISEB rollout adds numbered topics, concrete improvement actions and explicitly assigned homework, with warm performance prose. Atom collection uses the existing server Chromium runtime every 15 minutes and only enriches staff-linked, unambiguous lesson activity. Both writers and both factual judges share frozen evidence; the hourly review job has a separate API style reviewer. The authenticated Review interface includes student links, sources, omission reasons and first-ten progress. Owner comparison approval and approved scheduled cloud verification gate activation. The cloud approval records whether a computer-off test actually occurred. See the [ISEB and Atom runbook](../operations/iseb-atom-feedback.md).
