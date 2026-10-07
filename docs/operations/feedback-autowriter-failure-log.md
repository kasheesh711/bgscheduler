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
| M09 | A main topic left out. Left-out homework stopped counting on 5 Oct (owner rule below) |
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
| O08 | A transcript existed but its speaker labels were called "unclear", so the class fell back to Wise's summary (and, with summary-only holds on, to a person) |

**Owner rule, 5 Oct 2026:** homework that the feedback leaves out is **not an error**, because not every class has
homework and an empty field is acceptable. Invented or wrong homework (M03: homework the tutor did not set, or a
conditional task written as definite) still counts. Rows below that were major only because of left-out homework were
re-graded on 5 Oct.

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
| 3 Oct (nightly) | 6abccbc01b2d9db5ba287e82 | 2 Oct 11:00 | summary | M09 | ~~major~~ → accurate | The daily-papers homework was left out; nothing else was wrong | Re-graded to accurate on 5 Oct (left-out homework is not an error) |
| 4 Oct (review) | 6ac0873c8bf475c5f4ac89e5 | 3 Oct 18:00 | transcript | M03 | major | The homework field collected every task proposed during the lesson, including one the tutor later made conditional | Left to the tutor: only the tutor can confirm the final task list |
| 4 Oct (review) | 6a76c0f3f666137cd5e9554e | 30 Sep 18:00 | transcript | M10 M17 | major (owner) | The generic voice and format did not match the tutor's house style (before the house-style guide shipped) | Left to the tutor (style; no factual error to correct) |
| 4 Oct (review) | 6ab89191c10615490d43a8cf | 29 Sep 21:00 | summary | M03 | major | The summary invented "remaining problems" from a mis-heard exchange; the writer made it homework | Corrected in Wise 30 Sep (owner-approved) |
| 4 Oct (review) | 6aba1ca4444416fb5707c075 | 29 Sep 16:00 | summary | M09 M10 | major | Generic text; the practice results and the specific difficulties were left out | Tutor rewrote it |
| 4 Oct (review) | 6aba47d069f1f327513ac027 | 29 Sep 15:00 | summary | M09 M10 | major | Same pattern as the row above | Tutor rewrote it |
| 4 Oct (review) | 6a9fbd84d58ce7a74f6673e6 | 1 Oct 10:30 | transcript | M17 | cosmetic | Long vocabulary lists in topic lines, repeated in the performance field | Left to the tutor |
| 5 Oct (nightly) | 6a81984a9174fb37ce4a2e82 | 4 Oct 18:00 | summary | M09 | ~~major~~ → cosmetic | Set homework left out; the performance field only restates the topics | Re-graded to cosmetic on 5 Oct (left-out homework is not an error) |
| 5 Oct (nightly) | 6a46220d0e4d5105181062f8 | 4 Oct 17:00 | summary | M06 M09 | major | The summary called its own fragmented input "unclear"; the writer turned that into a verdict that the student had not grasped blood flow, though the transcript shows mostly correct answers. The two set long-answer questions were omitted | No checked correction possible on 5 Oct (the re-audit rejected deleting the sentence while the homework was still missing). Left to the tutor with proposed text |
| 5 Oct (nightly) | 6abb5000b030bfa5a0d4eba9 | 4 Oct 17:00 | transcript | M05 | major | "We changed one present-tense form": the tutor corrected tense at least three times, which is why tense was her main advice | Corrected in Wise 5 Oct 03:40 (guarded path; judges and Opus re-audit passed; verified) |
| 5 Oct (nightly) | 6ac0873c8bf475c5f4ac89e6 | 4 Oct 15:00 | transcript | M07 | major | The student was credited with naming "indices" in BIDMAS; the tutor supplied the term after the student hesitated | Corrected in Wise 5 Oct 03:40 (guarded path; judges and Opus re-audit passed; verified) |
| 5 Oct (nightly) | 6a9a6eab3d8310f146bdbea7 | 4 Oct 14:30 | transcript | M05 M09 | major | An instruction slip was placed on "a separate item" when it was the very item described as answered well; the tutor's stated scores were left out | No checked correction possible on 5 Oct (the GLM judge rejected the minimal fix). Left to the tutor with proposed text |
| 5 Oct (nightly) | 6ab62a0a530475558897e34f | 4 Oct 21:00 | transcript | M09 | ~~cosmetic~~ → accurate | A one-question homework add-on was not listed | Re-graded to accurate on 5 Oct |
| 5 Oct (nightly) | 6a5f463845afae21065da667 | 4 Oct 19:30 | transcript | M17 | cosmetic | The first-person post calls the tutor's own practice set "tutor-created" | Left as is (cosmetic) |
| 5 Oct (nightly) | 6ab8dc56c10615490d50b762 | 4 Oct 19:00 | transcript | M09 | cosmetic | The performance field leaves out several correct independent answers | Left as is (cosmetic) |
| 5 Oct (nightly) | 6aaf4c2481ee4ce416cb3f60 | 4 Oct 17:30 | transcript | M17 | cosmetic | One trapezium question written as "trapezia" | Left as is (cosmetic) |
| 7 Oct (audit) | 6a7422cabcd6af4342cc5cc1 | 6 Oct 20:30 | transcript | M05 | major | A point about control-rod materials was extended to fuel rods | Left to the tutor (no checked minimal fix, or correction blocked; see the audit report) |
| 7 Oct (audit) | 6a93c1ae0c4febc6136d4a6a | 6 Oct 20:00 | transcript | M07 | major | The tutor's explanation was credited to the student; Soniox had merged both voices into one speaker for that stretch (zoom_alignment overall, tutor 84%) | Verified fix ready (checks, both judges, Opus re-audit) but not applied: four `lock:sweep_running` refusals; handed to the owner to paste |
| 7 Oct (audit) | 6aa22d2a76c0cb26cfbaaa67 | 6 Oct 18:00 | transcript | M05 | major | A homework answer-key task was tied to a question without clear basis (low confidence) | Verified fix ready (checks, both judges, Opus re-audit) but not applied: four `lock:sweep_running` refusals; handed to the owner to paste |
| 7 Oct (audit) | 6a9d1c0571b3aaa4b3b0cdca | 5 Oct 21:00 | transcript | M07 | major | The tutor's explanation (reversing both field and current) was credited to the student | Left to the tutor (no checked minimal fix, or correction blocked; see the audit report) |
| 7 Oct (audit) | 6ab629b67d4c21cce91bcd92 | 5 Oct 21:00 | transcript | M03 | major | Daily word-problem practice suggested by the tutor was reported as set homework | Left to the tutor (no checked minimal fix, or correction blocked; see the audit report) |
| 7 Oct (audit) | 6a76c108d39a835d85bd18af | 5 Oct 20:30 | transcript | M07 | major | Tutor-led reasoning on one divisibility question was credited to the student | Left to the tutor (no checked minimal fix, or correction blocked; see the audit report) |
| 7 Oct (audit) | 6a75afef9fc415affe550e5a | late post | transcript | M07 | major | Credit to the student for tutor-led work (secondary evidence only) | Left to the tutor (no checked minimal fix, or correction blocked; see the audit report) |
| 7 Oct (audit) | 6aa66a71e5e946e902d255dc | late post | transcript | M07 M09 | major | Credit to the student for tutor-led work; a main topic left out (secondary evidence only) | Left to the tutor (no checked minimal fix, or correction blocked; see the audit report) |
| 7 Oct (audit) | 6a856a80784133d0b399b3b6 | late post | transcript | M05 | major | A mis-summarised detail (secondary evidence only) | Left to the tutor (no checked minimal fix, or correction blocked; see the audit report) |

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
| 7 Oct | 6abca2231ac8ce5fb7aeafcd | deadline 5 Oct 23:59 | O02 O05 | The credit-baseline hold (above) passed its deadline with no tutor post. The starter draft never reached the tutor | No hand-to-tutor path; the tutor is never told by the system | No deduction row on 7 Oct 09:30; owner to decide if one appears |
| 7 Oct | 6abf1af067c24f09af696c87 | class 3 Oct, deadline 5 Oct 23:59 | O02 | Surfaced as a hold only on the evening of its deadline, when its tutor joined the roster (the cohort-5 deploy at 20:14). Nobody wrote it | Roster expansion makes old classes eligible on the day their deadline ends; no tutor notice | No deduction row on 7 Oct 09:30 |
| 7 Oct | 6a76b04f0d147195a7454a54, 6ac209577811f1cd621cd661, 6abcbc297c7499a5688984b6, 6a3e27f5c98e73c4953f037b | 5–6 Oct | O08 | Four `summary_only_held` holds had a full Soniox transcript and Zoom captions naming both people | Two causes. (1) The student out-talked the tutor; the alignment was clean, but the rule needed the tutor at ≥50% of the talk. (2) Soniox merged both voices into one speaker, so no per-speaker label can be right | (1) fixed by kasheesh711/bgscheduler#165 (merged 7 Oct); (2) plan below. Retried on 7 Oct after the summary-only hold was switched off |
| 7 Oct | scheduled task `bgs-autowriter-nightly` | 5–7 Oct | O06 | The scheduled task no longer exists, so the nights of 5 and 6 Oct were not audited by it | Unknown (the task was removed, not just blocked) | Nights 5 and 6 Oct audited by hand on 7 Oct |
| 7 Oct | nightly correction ledger | 5 Oct 21:00, again 7 Oct 12:08–12:11 | O06 | Six `lock:sweep_running` refusals used up the night's correction cap for one real correction, so a verified fix could not be applied | A refused reservation counted toward the cap | Fixed by kasheesh711/bgscheduler#166 (draft, stacked on #159) |
| 7 Oct | Atom runs 5 Oct 18:00–20:50 | 5 Oct | O03 | Every run failed `source_contradiction` on one student for three hours and held a maths class | The failed check and record were not stored | kasheesh711/bgscheduler#167 (draft) stores the check and the Atom activity id; Atom healthy since 21:00 |
| 5 Oct | scheduled task `bgs-autowriter-nightly` | 4 and 5 Oct 01:44 | O06 | The nightly audit never ran for the nights of 3 and 4 Oct | The scheduled session waits on a Bash permission prompt in the main checkout | Run by hand for 4 Oct on 5 Oct (3 Oct not audited); plan: nightly audit |

## Long-term improvement plan

### Status on 7 Oct and the next 30 days

**Where the system is (7 days to 7 Oct):**
- **Volume:** 203 classes seen. 118 posted (94 written from the transcript, 24 from Wise's summary). 28 held,
  46 written by the tutor before the AI, 11 out of scope.
- **Accuracy gate:** "head start", Wilson lower bound 73.8% (84 accurate of 102 reviewed). Coverage 88%.
- **Cost:** $0.13 per draft (Soniox is 83% of it).
- **Latency:** median 63 min overall. Transcript route 55 min; summary fallback 280 min (p90 51 h).
- **Roster:** 48 tutors (every online tutor) since 5 Oct, about 20–25 posts a day. Owner review of every post no
  longer fits in a day: 25 required posts were waiting on 7 Oct.

**What changed in the picture since 5 Oct:**
1. **Most summary-only drafts now come from discarded transcripts, not missing recordings.** 17 of the 29 summary
   fallbacks in 7 days were `speakers_unclear` (O08). That status hides two failures:
   - the student out-talks the tutor (fixed by #165);
   - Soniox merges both voices into one speaker, about 70% of the cases still checkable.
   The P0 caption work below should start with these classes, because the Zoom captions already exist for them.
2. **Holds still have no path to the tutor (O02).** The system has told no tutor about any hold
   (`tutorNotifiedAt` was empty on every one). Two holds passed their deadline unwritten on 5 Oct. On 7 Oct six
   holds were due the same night and none had reached a tutor. This is now the largest deadline risk.
3. **The nightly audit is not running at all (O06).** The scheduled task is gone, and #158/#159/#160 have been
   drafts for four days. Hand runs from `slot-eval` are the only audit.

**Owner decisions, 7 Oct (supersede the items below where they conflict):**
- **Wise's summary is an accepted source.** Summary-only drafts are no longer held for a person:
  `FEEDBACK_AUTOWRITER_HOLD_SUMMARY_ONLY` was removed from production on 7 Oct. Reviews and audits no longer flag them
  either. A summary-only post that is faithful to the Wise summary counts as accurate, even where the transcript shows
  the summary was wrong. The P0 "summary-only posts" item below is therefore closed. Captions (item 4) remain a
  quality improvement, but they are no longer a blocker.
- **Drop the false claims.** When the judges reject a draft, the system cuts the sentences they quoted and judges the
  trimmed draft again at both levels. It posts the trimmed draft only if both levels pass it
  (kasheesh711/bgscheduler#168). This replaces "hand a starter draft to the tutor" for judge holds (item 2), so item 2
  now covers only the holds that cannot be repaired.
- **Hold tracker (item 1): not yet.** Tutor messages stay manual for now.

**Order of work (each item keeps the replay-fixture rule below):**

| # | Item | Codes | Ships as | Owner gate |
|---|---|---|---|---|
| 1 | Hold tracker: tell the tutor when a class is held (deadline, reason, Wise link), owner alert 6 h before the deadline, Retry button. Spec: dashboard redesign §5, PR 2 | O01 O02 | migration + sweep + UI | Choose the channel (email or LINE) and whether the notice carries a starter draft |
| 2 | Starter draft for every hold: a judge-rejected draft is repaired by the nightly verify path; a summary-only class gets a caption-based draft. The tutor edits instead of writing from nothing | O02 M07 | job + nightly | Tutor-facing text: owner sign-off on 5 samples |
| 3 | Speaker attribution: #165 (merged 7 Oct), then label each word by the Zoom caption that covers it when Soniox merged the speakers (experiment: 71–91% of text covered; needs boundary smoothing + replay on the O08 fixtures) | O08 | transcript.ts | Replay + one-tap approval (who-said-what change) |
| 4 | Captions as evidence when there is no recording (the P0 below, step 2) | M05 M09 | writer + both judges | Replay |
| 5 | Make the nightly audit dependable: merge #158 → #159 → #166 → #160; recreate `bgs-autowriter-nightly` with the wrapper allow rule; show "Nightly audit for <night>: done / not run by 07:00" on the health rail | O06 | PRs + Mac config | Owner merges (money-adjacent: Wise writes) |
| 6 | Review capacity: let the Opus audit be the first reviewer. The owner reviews every major/critical, every tutor edit, and a random 10% of "accurate" posts to measure agreement. Switch only after 50 paired verdicts show ≥90% agreement and no missed critical | gate | review-data + nightly | Owner decision |
| 7 | Tutor edits as a signal: classify every `measured_fix` (the tutor changed the AI text) with the audit's mode registry and add a row here automatically | M* | nightly | — |
| 8 | Judge bake-off rerun on owner-verdicted drafts (about 100 now): the GLM dual judge caught 8 of 17 real errors on 1 Oct. Try a who-said-what-only Sol/Opus check | M07 | judge | Replay + approval |
| 9 | Attendance and billing holds go to the office, not the tutor: "student 0 min, charged 1 credit" (5 in 7 days) and credit-baseline holds open an office task with the Wise link | O05 | inbox + notice | — |
| 10 | Roster expansion skips classes whose deadline is less than 24 h away, so a deploy cannot create same-night holds | O02 | job | — |
| 11 | Atom: fail one session, not the run; Atom records which check failed (#167 is the first step) | O03 O07 | collector | — |
| 12a | Nightly audit cost: night 2026-10-06 (33 posts) cost $47 API-eq. At 48 tutors (~30 posts a night) that is ~$320 a week, over the $300 weekly cap, so later nights would stop part-way. Audit 100% of new tutors, flagged posts, repaired posts (`metadata.pipeline.repair`) and transcript posts with tutor share < 50%, plus a 30% random sample of the rest | O06 | nightly select | Owner (sampling rule) |
| 12b | M07 is the leading real error (5 of 9 majors on 7 Oct). Ship the deterministic pre-check from the M07 item below before more prompt work | M07 | judge pre-check | Replay |
| 12c | Correction windows collide with the sweep: the windows open at :10 and :40, two minutes after the :08 and :38 sweeps start, and a sweep can run 13 minutes. On 7 Oct every attempt hit `lock:sweep_running`. Move the windows to :16–:21 and :46–:51 (after a :08/:38 sweep can end, before the :22/:52 one) and merge #166 | O06 | nightly config | — |
| 12 | Weekly merge session for autowriter drafts (#120 #121 #143 #146 #158–#160 #165–#167). Long-lived drafts are why fixes from 3 Oct were still not live on 7 Oct | — | process | Owner |

**Targets for 6 Nov:** no hold reaches its deadline untold; judge holds that cannot be repaired under 1 a day; gate
lower bound ≥ 80% on the transcript route; nightly audit done for 28 of 30 nights; owner review under 20 minutes a day.


Ranked by how many parent-facing errors each item would have prevented. The sample is every reviewed first post up
to 5 Oct: 90 posts, 14 of them with a major error under the 5 Oct homework rule. Every item ships with **replay fixtures**: the listed
sessions' posted text must fail the new check, and the listed controls must still pass. No item is done until the
next 20 eligible posts after release are audited with zero repeats of its code.

### P0 — Summary-only posts: stop posting them unattended until captions reach the writer

- **Evidence:** on the two audited nights, summary-only posts had a major error 5 times in 7, even with left-out
  homework not counted (transcript posts: 4 in 21). The Wise summary mis-hears terms and ranges, and it carries stock
  lines ("asked questions throughout", "some details were not fully clarified"). The judge
  checks the draft against the same summary, so it cannot see any of this.
- **The correction path cannot repair these posts either.** On 5 Oct, none of the uncorrected summary-only majors could
  go through the guarded correction. The verify step's judges compare a fix against the same wrong summary, so they
  reject the correct fix, and an omitted homework field has no "minimal fix" at all. Step 2 must also feed the captions
  to `nightly verify`, and verify needs an `add_field` fix type: a quoted tutor instruction may fill an empty field.
- **Gap found on 5 Oct:** the owner's 3 Oct decision to keep posting summary-only drafts in a "careful summary mode"
  depends on kasheesh711/bgscheduler#160, which is still a draft. Production is posting summary-only drafts **without**
  that mode.
- **Change:**
  1. Now: `FEEDBACK_AUTOWRITER_HOLD_SUMMARY_ONLY` (kasheesh711/bgscheduler#162) holds every summary-only draft for a
     person. With transcript first on, that is only classes that fell back from the transcript.
  2. When no usable transcript exists, fetch the Zoom VTT captions (participant display names, timestamps) and render
     them on the TUTOR/STUDENT timeline the transcript path already uses. Give them to the writer **and** both judge
     levels. On numbers, terms, scope and homework, captions win over the summary.
- **Fixtures:** 6a46220d0e4d5105181062f8, 6abe4a758e592b2be83e8a8f, 6aa37680e33206b6a89be06a,
  6a76aecaf666137cd5e60fdd, 6a02ddf6b2b3690df4d7b808.
- **Owner / cost:** engineering, with an owner decision on step 1. No extra model calls; about 10–15k more input
  tokens per affected class.

### P2 — Wrong homework only (M03)

- **Owner rule, 5 Oct:** left-out homework is not an error, so there is no homework cue scan and no hold for an empty
  homework field. Only homework that is invented, or a conditional or withdrawn task written as definite, is checked.
- **Evidence:** 2 such errors among 90 posts. In 6ab89191c10615490d43a8cf the summary invented remaining work. In
  6ac0873c8bf475c5f4ac89e5 a conditional task was listed as set.
- **Change:** the existing `homeworkNotSet` judge list stays. Add a writer rule: when the tutor later narrows or
  cancels a task, the last instruction wins, and "if you find it hard, do …" is not homework.
- **Owner / cost:** engineering. Prompt only.

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
  (across the two audited nights, homework rule applied: summary-only 5 of 7 major, transcript 4 of 21).
