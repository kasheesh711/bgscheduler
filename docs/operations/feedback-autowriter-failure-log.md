# Feedback autowriter — failure log

An append-only record of every autowriter failure found in review: posts with a real error, drafts the judges had to
stop, holds that missed or nearly missed a deadline, and operational faults (alerts, collectors, audit runs). Each row
names the failure code, the root cause, and what was done. The [long-term improvement plan](#long-term-improvement-plan)
at the end says what stops each code from happening again.

**This repository is public.** Rows carry only the Wise session id, the date and the code. No student or tutor names,
lesson text, transcript or feedback text appear here. The full evidence for each row is in the owner's local audit
reports (`.feedback-autowriter/audit-YYYYMMDD/`, gitignored, 0600), and the review verdicts and flags are in
`feedback_autowriter_verdicts` / `feedback_autowriter_flags`.

## Codes

Text failures use the nightly audit's mode registry, **M01–M17** (`docs/operations/feedback-autowriter-failure-modes.md`,
generated from `src/lib/feedback-autowriter/nightly/modes.ts`; it is on main once kasheesh711/bgscheduler#158 merges). The ones seen
so far:

| Code | Meaning |
|---|---|
| M03 | Homework the tutor did not set, or a changed or conditional task presented as definite |
| M05 | A mis-heard or mis-summarised detail (usually copied from the Wise summary) |
| M06 | An unsupported judgement of how the student did (padded praise, "asked questions throughout") |
| M07 | The tutor's work or answer presented as the student's (echoes, tutor-solved questions) |
| M08 | Subject content or a question type described wrongly |
| M09 | A main topic, or homework the tutor clearly set, left out |
| M10 | Generic padding not tied to the lesson |
| M17 | Wording or format only (cosmetic) |

Operational failures have their own codes, **O01–O07** (new in this log):

| Code | Meaning |
|---|---|
| O01 | A hold alert reached people only after the feedback deadline |
| O02 | A hold has no path to a person: the tutor is not told and the stored draft cannot be handed over |
| O03 | The Atom collector failed on an invalid Wise timetable record |
| O04 | An incident stayed open (and critical) after a later check passed |
| O05 | Credit baseline mismatch: Wise holds a session charge other than the one the post expects |
| O06 | The scheduled nightly audit did not run |
| O07 | A Wise-side throttle (HTTP 429) failed a run |

Severity follows the owner's definitions (29 Sep 2026): **critical** = wrong person, billing/status, invented
content, should not have posted; **major** = needs a real fix; **cosmetic** = wording only (still counts as accurate).

## Log

Dates and times are Bangkok. "Found by" is the review that recorded it. A verdict judges the *first* post; a later
correction is listed in Status and does not change the verdict.

### Posted feedback with a real error

| Found | Wise session | Class end | Evidence | Code | Severity | Root cause | Status |
|---|---|---|---|---|---|---|---|
| 3 Oct (nightly) | 6a02ddf6b2b3690df4d7b808 | 2 Oct 19:00 | summary | M05 | major | The summary's recap included a level finished in the previous lesson; the writer copied the range | Correction blocked: the judge reads the same wrong summary (`no_candidate`). Left to the tutor with a one-span fix |
| 3 Oct (nightly) | 6abe4a758e592b2be83e8a8f | 2 Oct 19:00 | summary | M05 M06 M09 M17 | major | The summary dropped the full-mock homework and turned a corrected answer into an independent one; the writer sharpened it | No checked correction possible on 5 Oct (the Opus re-audit rejected the minimal fix because the omitted homework remained). Left to the tutor with proposed text |
| 3 Oct (nightly) | 6a76aecaf666137cd5e60fdd | 2 Oct 18:00 | summary | M05 M08 | major | A remark about the next practice set became a claim about a future exam; an informal word became a named question type | No checked correction possible on 5 Oct (the GLM judge, reading the same summary, rejected the minimal fix). Left to the tutor with proposed text |
| 3 Oct (nightly) | 6aa37680e33206b6a89be06a | 2 Oct 16:00 | summary | M05 M06 M09 | major | A mis-heard physics term became a topic; the summary's stock "asked questions" line became praise; the closing homework was missed | No checked correction possible on 5 Oct (no minimal fix exists for omitted homework). Left to the tutor with proposed text |
| 3 Oct (nightly) | 6aa3b956b85d4f7e3ffcc3d7 | 2 Oct 16:00 | transcript | M07 M09 | major | The student repeated a value the tutor had just given; the writer credited it as the student's answer | Corrected in Wise 4 Oct 00:10 (guarded path, verified) |
| 3 Oct (nightly) | 6abccbc01b2d9db5ba287e82 | 2 Oct 11:00 | summary | M09 | major | The daily-papers homework was dictated in the last minutes; the summary dropped it, so the field was left blank | No checked correction possible on 5 Oct (the omitted homework has no text-level minimal fix). Left to the tutor with proposed text |
| 4 Oct (review) | 6ac0873c8bf475c5f4ac89e5 | 3 Oct 18:00 | transcript | M03 | major | The homework field collected every task proposed during the lesson, including one the tutor later made conditional | Left to the tutor: only the tutor can confirm the final task list |
| 4 Oct (review) | 6a76c0f3f666137cd5e9554e | 30 Sep 18:00 | transcript | M10 M17 | major (owner) | The generic voice and format did not match the tutor's house style (before the house-style guide shipped) | Left to the tutor (style; no factual error to correct) |
| 4 Oct (review) | 6ab89191c10615490d43a8cf | 29 Sep 21:00 | summary | M03 | major | The summary invented "remaining problems" from a mis-heard exchange; the writer made it homework | Corrected in Wise 30 Sep (owner-approved) |
| 4 Oct (review) | 6aba1ca4444416fb5707c075 | 29 Sep 16:00 | summary | M09 M10 | major | Generic text; the practice results and the specific difficulties were left out | Tutor rewrote it |
| 4 Oct (review) | 6aba47d069f1f327513ac027 | 29 Sep 15:00 | summary | M09 M10 | major | Same pattern as the row above | Tutor rewrote it |
| 4 Oct (review) | 6a9fbd84d58ce7a74f6673e6 | 1 Oct 10:30 | transcript | M17 | cosmetic | Long vocabulary lists in topic lines, repeated in the performance field | Left to the tutor |
| 5 Oct (nightly) | 6a81984a9174fb37ce4a2e82 | 4 Oct 18:00 | summary | M09 | major | The tutor set a question set as homework near the end of the lesson (in Thai); the summary's account of the ending never mentions it, so the field was left empty | No checked correction possible on 5 Oct (no minimal fix exists for an omitted field). Left to the tutor with proposed text |
| 5 Oct (nightly) | 6a46220d0e4d5105181062f8 | 4 Oct 17:00 | summary | M06 M09 | major | The summary called its own fragmented input "unclear"; the writer turned that into a verdict that the student had not grasped blood flow, though the transcript shows mostly correct answers. The two set long-answer questions were omitted | No checked correction possible on 5 Oct (the re-audit rejected deleting the sentence while the homework was still missing). Left to the tutor with proposed text |
| 5 Oct (nightly) | 6abb5000b030bfa5a0d4eba9 | 4 Oct 17:00 | transcript | M05 | major | "We changed one present-tense form": the tutor corrected tense at least three times, which is why tense was her main advice | Corrected in Wise 5 Oct 03:40 (guarded path; judges and Opus re-audit passed; verified) |
| 5 Oct (nightly) | 6ac0873c8bf475c5f4ac89e6 | 4 Oct 15:00 | transcript | M07 | major | The student was credited with naming "indices" in BIDMAS; the tutor supplied the term after the student hesitated | Corrected in Wise 5 Oct 03:40 (guarded path; judges and Opus re-audit passed; verified) |
| 5 Oct (nightly) | 6a9a6eab3d8310f146bdbea7 | 4 Oct 14:30 | transcript | M05 M09 | major | An instruction slip was placed on "a separate item" when it was the very item described as answered well; the tutor's stated scores were left out | No checked correction possible on 5 Oct (the GLM judge rejected the minimal fix). Left to the tutor with proposed text |
| 5 Oct (nightly) | 6ab62a0a530475558897e34f | 4 Oct 21:00 | transcript | M09 | cosmetic | A one-question homework add-on given in the last minute was not listed | Left as is (cosmetic) |
| 5 Oct (nightly) | 6a5f463845afae21065da667 | 4 Oct 19:30 | transcript | M17 | cosmetic | The first-person post calls the tutor's own practice set "tutor-created" | Left as is (cosmetic) |
| 5 Oct (nightly) | 6ab8dc56c10615490d50b762 | 4 Oct 19:00 | transcript | M09 | cosmetic | The performance field leaves out several correct independent answers | Left as is (cosmetic) |
| 5 Oct (nightly) | 6aaf4c2481ee4ce416cb3f60 | 4 Oct 17:30 | transcript | M17 | cosmetic | One trapezium question written as "trapezia" | Left as is (cosmetic) |

### Drafts the judges stopped (not posted)

| Found | Wise session | Class end | Evidence | Code | What happened | Status |
|---|---|---|---|---|---|---|
| 4 Oct (judge) | 6aa4b813200ad427a0e5d27f | 4 Oct 16:00 | transcript (talk share 91/9) | M07 | Both writers (Luna, then Sol) credited answers the tutor solved to the student, in a lesson where the tutor worked through the student's homework. The medium judge caught Luna's draft (the high judge passed it); both judge levels caught Sol's draft | Held. A faithful starter draft was handed to the tutor; deadline 6 Oct 23:59 |

### Holds and operational failures

| Found | Wise session / run | When | Code | What happened | Root cause | Status |
|---|---|---|---|---|---|---|
| 5 Oct | 6a7426e2ff7c8ab70f3bd351 | class 30 Sep, deadline 2 Oct 23:59 | O01 O02 | Held at 0% attendance. The tutor joined the roster on the evening of the deadline. The hold alert was deferred by the 22:00–07:00 quiet hours to 3 Oct 07:38, after the deadline. Nobody wrote feedback, and a late-feedback deduction was approved | Quiet hours defer hold alerts even when the deadline falls inside them; no hand-to-tutor path | Deduction left for the owner to decide (waive or keep) |
| 5 Oct | 6abca2231ac8ce5fb7aeafcd | class 3 Oct 12:30, deadline 5 Oct 23:59 | O05 O02 | The draft passed both judges but was held at `credit_baseline:session_credit_0` | The student's package was empty when the class ended, so Wise booked the session at 0 credits; credits were topped up about ten minutes later. Posting would re-send a 1.5-credit charge, so the guard held it correctly | Draft handed to the tutor to post; billing left to finance |
| 5 Oct | 6a153b7efc3f9a3089512781, 6aa4b78eb2672c20ceda732a | 4 Oct 14:00, 15:00 | — (correct hold) | 0% attendance: the student never joined, and the tutor was in the room for 5 minutes and 4 seconds. Each class was charged one credit | Gate worked as designed | Handed to the tutor; the class status and credits need a human check |
| 5 Oct | 6ab086f6601d4f474a9959cf | 4 Oct 21:30 | — (correct hold) | The student attended 15 of 60 minutes (26%) | Gate worked as designed | Handed to the tutor |
| 2 Oct | Atom run 6c68a47f… | 2 Oct 17:36 | O03 | `collection_failed` on the Wise timetable read | A just-ended class appeared in both listings with different statuses | Fixed by kasheesh711/bgscheduler#139 |
| 5 Oct | Atom runs e350c4e5…, fb8b1b6d…, c6b191f3… | 4 Oct 09:06, 12:36, 17:36 | O03 O07 | Two `wise_timetable: invalid_session` failures and one Wise 429. 197 of 200 runs in three days succeeded | Unknown: the failed run stores nothing about the offending record, and the stored timetables before and after show only ordinary reschedules | Plan: Atom collector |
| 5 Oct | incidents for 6a76aeca…, 6abccb84… | 2 Oct 21:27 | O04 | Two critical "style reviewer could not return a verdict" incidents stayed open, and their pushes were reported as undelivered, for 2.5 days after both style checks passed | No automatic close when a later check for the same post passes | Acknowledged 5 Oct; plan: incident hygiene |
| 5 Oct | scheduled task `bgs-autowriter-nightly` | 4 and 5 Oct 01:44 | O06 | The nightly audit never ran for the nights of 3 and 4 Oct | The scheduled session waits on a Bash permission prompt in the main checkout | Run by hand for 4 Oct on 5 Oct (3 Oct not audited); plan: nightly audit |

## Long-term improvement plan

Ranked by how many parent-facing errors each item would have prevented. The sample is every reviewed first post up
to 5 Oct: 90 posts, 16 of them with a major error. Every item ships with **replay fixtures**: the listed
sessions' posted text must fail the new check, and the listed controls must still pass. No item is done until the
next 20 eligible posts after release are audited with zero repeats of its code.

### P0 — Summary-only posts: stop posting them unattended until captions reach the writer

- **Evidence:** every summary-only post audited so far had a major error (2 Oct night: 5 of 5 posts; 4 Oct night:
  2 of 2; 4 Oct review: 5 of the 7 majors). The Wise summary drops homework given in the closing minutes, mis-hears
  terms, and carries stock lines ("asked questions throughout", "some details were not fully clarified"). The judge
  checks the draft against the same summary, so it cannot see any of this.
- **The correction path cannot repair these posts either.** On 5 Oct, 0 of the 7 uncorrected summary-only majors could
  go through the guarded correction. The verify step's judges compare a fix against the same wrong summary, so they
  reject the correct fix, and an omitted homework field has no "minimal fix" at all. Step 2 must also feed the captions
  to `nightly verify`, and verify needs an `add_field` fix type: a quoted tutor instruction may fill an empty field.
- **Gap found on 5 Oct:** the owner's 3 Oct decision to keep posting summary-only drafts in a "careful summary mode"
  depends on kasheesh711/bgscheduler#160, which is still a draft. Production is posting summary-only drafts **without**
  that mode.
- **Change:**
  1. Today, either merge #160 after review, or flip an interim switch that holds every summary-only draft for the
     tutor. Option A of the 2 Oct plan; it costs roughly a third of classes in manual writing until step 2 ships.
  2. When no usable transcript exists, fetch the Zoom VTT captions (participant display names, timestamps) and render
     them on the TUTOR/STUDENT timeline the transcript path already uses. Give them to the writer **and** both judge
     levels. On numbers, terms, scope and homework, captions win over the summary.
- **Fixtures:** 6a81984a9174fb37ce4a2e82, 6a46220d0e4d5105181062f8, 6abccbc01b2d9db5ba287e82, 6abe4a758e592b2be83e8a8f,
  6aa37680e33206b6a89be06a, 6a76aecaf666137cd5e60fdd, 6a02ddf6b2b3690df4d7b808.
- **Owner / cost:** engineering, with an owner decision on step 1. No extra model calls; about 10–15k more input
  tokens per affected class.

### P0 — Homework as a timeline, with a deterministic cue scan

- **Evidence:** homework errors are the single most common major (homework omitted in 7 of the 16 majors, wrong scope in 2 more).
  Tutors set homework in the last minutes, often in Thai or in mixed Thai and English, and often add to or narrow
  it after first proposing it.
- **Change:**
  1. Scan tutor turns in the transcript or captions, with extra weight on the last 15 minutes, for English and Thai
     homework cues: homework, การบ้าน, ไปทำ, at home, send me, before next lesson, every day.
  2. Pass each hit, with its timestamp, to the writer as a list of candidate tasks.
  3. The writer sorts each one into set / suggested / conditional / withdrawn. The last explicit instruction wins.
  4. `validate.ts`: an empty or shorter homework field with unresolved "set" cues needs the judge to quote the line
     that shows no homework was set; otherwise the draft is held.
- **Fixtures:** omissions 6a81984a…, 6a46220d…, 6abccbc0…, 6abe4a75…, 6aa37680…; changed scope
  6ac0873c8bf475c5f4ac89e5; false homework 6ab89191c10615490d43a8cf; add-on control 6ab62a0a530475558897e34f.
- **Owner / cost:** engineering. Deterministic; no extra calls.

### P1 — Never credit the tutor's work to the student (M07)

- **Evidence:** this keeps recurring despite the judge.
  - In 6aa3b956… (posted) the student echoed a value the tutor had just given.
  - In 6ac0873c8bf475c5f4ac89e6 (posted) the student was credited with naming "indices", a term the tutor supplied.
  - In 6aa4b813… (held) the tutor solved the student's homework on screen and both writers credited the student. On
    that Luna draft the **high** judge passed it and only the medium judge caught it.
- **Change:**
  1. Writer rule (in #160): a claim that the student answered, named or worked out X needs a STUDENT turn stating X
     **before** any tutor turn states it, or a reply to an open question. Otherwise describe it as following along.
  2. Deterministic judge pre-check: for every such claim, search the tutor turns of the preceding 60 s for X and
     flag a hit.
  3. When the student's talk share is below 15%, the writer must describe the lesson as tutor-led.
- **Fixtures:** the three sessions above; control 699477acb50e50f4cc214d2d (real student answers).
- **Owner / cost:** engineering. Deterministic plus a prompt rule.

### P1 — Exact counts and placement (M05 in transcript mode)

- **Evidence:**
  - 6abb5000b030bfa5a0d4eba9 said one tense correction was made; the tutor made at least three.
  - 6a9a6eab3d8310f146bdbea7 put an instruction slip on the wrong item and dropped the stated scores.
- **Change:**
  1. Writer rule: state a count only when the evidence states or clearly enumerates it, and otherwise use "several".
     Tie a mistake to the item where it happened, and report scores the tutor states.
  2. Judge item: every numeral and every "a separate / another item" phrase needs a quoted locator.
- **Fixtures:** the two sessions above.
- **Owner / cost:** engineering. Prompt only.

### P1 — Holds must reach a person before the deadline

- **Evidence:** 6a7426e2ff7c8ab70f3bd351 was held, but the alert waited out quiet hours, the deadline passed, and the
  tutor received a late deduction. 6abca2231ac8ce5fb7aeafcd had a judged draft that only a script could read.
- **Change:**
  1. A hold alert never waits for quiet hours when the deadline falls before 07:00 the next morning.
  2. Build the hold tracker from the dashboard spec (PR 2): tell the tutor at once, add a "hand to tutor" action that
     sends the stored draft, alert 6 h before the deadline, and add a Retry button.
  3. Credit-baseline holds show their cause in plain words. "Booked at 0 credits: the package was empty at class end"
     goes to finance, not to the tutor.
  4. Late deductions on held classes are opened for review automatically. The owner keeps the decision.
- **Owner / cost:** engineering + owner. No model cost.

### P1 — Atom collector: fail one session, not the run (O03, O07)

- **Evidence:** on 4 Oct, 3 of 100 runs failed, two of them on an invalid Wise timetable record. The failed run keeps
  nothing that identifies the record, so the cause could not be found afterwards.
- **Change:**
  1. Record the offending session id and the failed check in `failureCause`.
  2. Skip an invalid session that does not belong to a linked ISEB student, and keep collecting the others.
  3. Treat Wise 429 as "retry next run". Raise a critical incident only after 3 consecutive failed runs.
- **Owner / cost:** engineering. No model cost.

### P2 — Incident hygiene (O04)

- **Change:**
  1. When a later style or scan check of the same post and evidence hash passes, the system acknowledges the earlier
     failure itself (actor `system`, with a note).
  2. A critical push fires only for a failure that is still unresolved.
- **Evidence:** two "critical" incidents stayed open for 2.5 days after their checks passed, and the health line
  reported 3 undelivered critical pushes.

### P2 — The nightly audit must run and must be seen to run (O06)

- **Change:**
  1. Add the wrapper's Bash allow rule to the main checkout, which the owner has to do.
  2. Add a health-rail line: "Nightly audit for <night>: done / not run by 07:00".
  3. When the synthesis sanitiser rejects a brief (5 Oct: "contains a real name"), still write `plan.md` with the
     names stripped.
- **Then:** review and merge kasheesh711/bgscheduler#158, #159 and #160, and move the runner to origin/main so that
  corrections no longer need `--supervised`.

### P2 — Measure by evidence source

- **Change:** add a daily major-error rate split into summary-only and transcript to the dashboard trends. Expansion
  decisions should use the transcript rate until captions ship, because the two sources fail at very different rates
  (across the two audited nights: summary-only 7 of 7 major, transcript 4 of 21).

