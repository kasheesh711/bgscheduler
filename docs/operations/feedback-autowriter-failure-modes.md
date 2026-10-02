# Feedback autowriter — failure-mode registry

The nightly Opus 5.5 audit (quick 261003-12b; runbook: [feedback-autowriter.md § 10](feedback-autowriter.md#10-nightly-audit))
sorts every problem it finds in a posted autowriter text into one of these modes. The list is generated from
`src/lib/feedback-autowriter/nightly/modes.ts`: the auditor's rubric (`nightly/audit-prompt.ts`) is written from the
same list, and a unit test (`nightly/__tests__/modes-doc.test.ts`) fails when this page and the code disagree. Add or
change a mode in `modes.ts` first, then here.

**This repository is public.** Everything on this page is sanitised: examples are invented (Pim, Nok, Tawan; an
invented lesson), and no student name, lesson text, transcript or real feedback appears. Real quotes live only in the
nightly's local `report.md` (0600, deleted after 7 days).

Severities follow the owner's definitions (29 Sep): **critical** = wrong person, billing/status, invented content,
should not have posted; **major** = a real fix; **cosmetic** = wording only (still first-shot accurate). Owner
precedents of 30 Sep: **P1** (another student's unfinished exam credited to ours) is critical, wrong_person; **P2**
(homework claimed from a summary's mis-heard exchange about the right student) is major.

Each mode records: what counts, an invented example, how the nightly detects it (deterministic precheck, the Opus
audit, or another source), its status, its counts over the last 14 nights, the root cause once known, and the fix
PRs. Status moves `open → pr_open → merged → monitoring → resolved`, or to `regressed` / `needs_owner` (the root cause
is in a file the nightly fixer may not touch, or it needs a policy decision). Status changes ride in the fix PRs;
counts are refreshed by one weekly PR. A mode first seen less than twice in 14 nights is provisional.

| Mode | Slug | Default severity | Text-fixable | From posts | Status |
|---|---|---|---|---|---|
| M01 | wrong_person | critical (wrong_person) | yes | yes | open |
| M02 | wrong_student_or_lesson | critical (wrong_person) | yes | yes | open |
| M03 | homework_not_set | major | yes | yes | open |
| M04 | invented_event | critical (invented_content) | yes | yes | open |
| M05 | misheard_detail | major | yes | yes | open |
| M06 | overstated_judgement | major | yes | yes | open |
| M07 | tutor_work_as_student | major | yes | yes | open |
| M08 | wrong_subject_content | major | yes | yes | open |
| M09 | material_omission | major | yes | yes | open |
| M10 | generic_padding | cosmetic | yes | yes | open |
| M11 | naming_policy | major | yes | yes | open |
| M12 | meta_or_format_leak | major | yes | yes | open |
| M13 | billing_status_drift | critical (billing_status) | no | yes | open |
| M14 | should_not_have_posted | critical (should_not_have_posted) | no | yes | open |
| M15 | false_hold | cosmetic | no | no (holds) | open |
| M16 | cost_runaway | major | no | no (call logs) | open |
| M17 | wording | cosmetic | yes | yes | open |

## M01 wrong_person — Another person's work credited to the student

- **Default severity:** critical (wrong_person). Owner precedent P1.
- **Definition:** The feedback gives the student something another person did, said, finished, got wrong or did not
  finish: another student, a family member, a friend, a person or character in the lesson material, or the tutor.
- **Synthetic example:** The summary says another student, named there, only managed eight pages of a mock paper; the
  feedback says Pim did not finish the paper. In the lesson Pim finished it.
- **Detection:** the Opus audit (claims marked `misattributed`); deterministic candidates `other_person_named` and
  `other_student_named`, which the audit must confirm. The production judge's `misattributed` list should have caught it.
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M02 wrong_student_or_lesson — Another student named, or content from another lesson

- **Default severity:** critical (wrong_person).
- **Definition:** The feedback names a student other than this one, or describes a lesson that is not this class's lesson.
- **Synthetic example:** Feedback for Nok's English lesson mentions Tawan by name and describes a maths lesson.
- **Detection:** the deterministic candidate `other_student_named` (display names of the tutor's other students from
  recent autowriter rows), confirmed by the audit; the audit itself for content from another lesson.
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M03 homework_not_set — Homework the tutor did not set

- **Default severity:** major. Owner precedent P2.
- **Definition:** The feedback states homework, a task or a due date that the tutor did not clearly set for the student
  to do after this lesson: work only described as remaining or unfinished, an optional suggestion, the summary's own
  "Next steps" line, or an invented due date. Critical only when it is part of a wrong-person error (M01).
- **Synthetic example:** The tutor says "we can finish the last three questions next time"; the feedback says the
  homework is to complete the last three questions by Friday.
- **Detection:** the Opus audit (its `homework` section: did the tutor clearly set homework, with a quote). The
  production judge's `homeworkNotSet` list should have caught it.
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M04 invented_event — Invented fact

- **Default severity:** critical (invented_content).
- **Definition:** A concrete score, result, test, material, activity, topic or date that has no basis anywhere in the evidence.
- **Synthetic example:** The feedback says the student scored 18/20 on a vocabulary quiz; no quiz or score appears in the lesson.
- **Detection:** the Opus audit (a factual claim it cannot quote any evidence for is `unsupported`; the wrapper
  re-checks every evidence quote against the evidence, fail closed).
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M05 misheard_detail — Mis-heard or mis-summarised detail

- **Default severity:** major.
- **Definition:** A specific detail that comes from a real exchange in the lesson but is wrong: a wrong number, word,
  page, question or text, usually from a mis-heard transcript or a summary's mistake.
- **Synthetic example:** The class worked on exercise 4B; the feedback says exercise 14B.
- **Detection:** the Opus audit (claims marked `contradicted`).
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M06 overstated_judgement — Unsupported judgement of how the student did

- **Default severity:** major.
- **Definition:** A judgement of the student's performance (confidently, quickly, mastered, excellent, struggled,
  engaged) that the evidence does not state or clearly show, including padded praise.
- **Synthetic example:** The feedback says the student "confidently mastered" fractions; the transcript only shows the
  tutor explaining fractions and the student answering two questions, one of them wrongly.
- **Detection:** the Opus audit (judgement claims without quoted support).
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M07 tutor_work_as_student — The tutor's work presented as the student's

- **Default severity:** major.
- **Definition:** Something the tutor explained, read, solved or summarised is presented as the student's own work or
  understanding (covered written as understood), often because the speaker labels are swapped or inferred.
- **Synthetic example:** The tutor works through a proof aloud; the feedback says the student explained the proof clearly.
- **Detection:** the Opus audit, with the transcript's speaker-label confidence (verified by Zoom, or inferred from
  talk share) and its own `speakerLabels` rating (`suspect_swap`).
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M08 wrong_subject_content — Subject content described wrongly

- **Default severity:** major.
- **Definition:** A concept, topic, programme, exam or level described wrongly (a subject error, the wrong exam board
  or level), while a real lesson topic is meant. With no basis at all, use M04 instead.
- **Synthetic example:** The lesson covered longitudinal waves; the feedback says the student learned that sound is a
  transverse wave.
- **Detection:** the Opus audit.
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M09 material_omission — Main topic or set homework left out

- **Default severity:** major.
- **Definition:** The lesson's main topic is missing from the feedback, or homework the tutor clearly set is left out.
- **Synthetic example:** Most of the lesson was essay planning; the feedback only mentions a five-minute vocabulary
  warm-up. Or: the tutor clearly set two practice pages for Monday and the homework field is empty.
- **Detection:** the Opus audit (`omissions`).
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M10 generic_padding — Generic filler

- **Default severity:** cosmetic.
- **Definition:** Advice or sentences not tied to this lesson, or text close to earlier feedback. If it states how the
  student performed, it is M06 instead.
- **Synthetic example:** "Keep practising regularly and stay motivated to achieve your goals." with nothing from the lesson.
- **Detection:** the production validator's `ai_suspect` codes (copy and padding checks) run again on the posted text
  as a precheck; the Opus audit.
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M11 naming_policy — Naming rule broken

- **Default severity:** major.
- **Definition:** The right student, but called by the wrong form of name (not the nickname the school uses), or
  anyone else is named, including the tutor.
- **Synthetic example:** The student's nickname is Pim but the feedback uses the full first name; or it names the tutor.
- **Detection:** deterministic prechecks `student_name_form` and `tutor_named` (floors), and the candidate
  `other_person_named` (confirmed by the audit); the audit's `names` section.
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M12 meta_or_format_leak — Meta words, attendance or format leak

- **Default severity:** major.
- **Definition:** Mentions Zoom, recordings, transcripts, AI, a summary, attendance, lateness, absence, technical
  problems, rescheduling or cancellation; or contains Thai text, a placeholder like [STUDENT_1], or markdown.
- **Synthetic example:** "According to the lesson summary, [STUDENT_1] joined late because of a connection problem."
- **Detection:** the production validator run again on the posted text (placeholder, Thai, markdown, style and
  attendance-wording codes are floors); meta words are candidates the audit must confirm (they can be lesson content:
  "cancel common factors").
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M13 billing_status_drift — Session status or credits wrong

- **Default severity:** critical (billing_status).
- **Definition:** The session status or credits in Wise differ from what the autowriter planned, or the class has an
  extra credit entry. Never fixed by editing text.
- **Synthetic example:** The plan reused one credit, but Wise now shows two credit entries for the session.
- **Detection:** deterministic prechecks from the nightly's Wise session-detail read: `billing_drift` (status or
  credits on the teacher submission differ from what we posted) and `teacher_submissions_<n>` (not exactly one).
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M14 should_not_have_posted — Should not have posted

- **Default severity:** critical (should_not_have_posted).
- **Definition:** The class should not have had autowriter feedback: the student was absent or attended under half the
  lesson, it was not one-to-one, it was in person, no real lesson took place, a person's own text was overwritten, or
  the tutor was switched off. Never fixed by editing text.
- **Synthetic example:** The recording shows only the tutor waiting for 50 minutes; the feedback describes a full lesson.
- **Detection:** the Opus audit (from the evidence); the nightly also notes a person's save since our post and an
  open owner flag as context.
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M15 false_hold — Accurate draft held

- **Default severity:** cosmetic. Not judged from posted texts.
- **Definition:** A judge or validator held a draft that was accurate, so a person had to write the feedback. Found
  when reviewing holds, not from a posted text.
- **Synthetic example:** Both judge levels flagged "we practised reading aloud" as unsupported although the transcript shows it.
- **Detection:** not by the nightly post audit (it audits posts only); planned for the weekly model review over holds.
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M16 cost_runaway — Retry loop or abnormal spend

- **Default severity:** major. Not judged from posted texts.
- **Definition:** A class used abnormally many model calls or abnormal spend (a retry loop, repeated transcriptions).
  Found from call logs, not from a posted text.
- **Synthetic example:** One class has 14 writer runs and 30 judge calls in a day because a failing judge retried every
  10 minutes.
- **Detection:** the nightly watchdog over `feedback_autowriter_calls` for the audited day (SELECT only): a class over
  $0.75, more than 4 writer runs, more than 12 judge calls, more than 1 Soniox job, 2 or more time-outs or 3 or more
  unpriced calls; and the day's total above 3× the median of the previous 7 days.
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## M17 wording — Wording only

- **Default severity:** cosmetic.
- **Definition:** Grammar, spelling, awkward phrasing or a house-style slip that does not change any fact.
- **Synthetic example:** "She practised reading and writing well and also she practised."
- **Detection:** the Opus audit.
- **Status:** open. **Counts (14 nights):** — . **Root cause:** — . **Fix PRs:** — .

## Long-term improvement plan

Rewritten from each night's synthesis (`plan.md`, local) once a mode has been seen often enough to act on; every item
names the failure modes it targets and its effect on cost per accurate post. The standing plan from the approved design
(3 Oct), until the first nights' evidence replaces it:

1. **Catch more before posting, cheaply.** Turn the most frequent audited modes into deterministic checks
   (`validate.ts`, stricter only) or writer/judge rules, each with a synthetic regression test; prefer these over more
   model calls.
2. **Better judges per dollar.** Weekly model review over the week's audited posts (judges first: higher GLM effort,
   cheaper ZDR-routed judges), adopting a change only on a ≥ 10 % improvement in expected cost per accurate post.
3. **Keep the evidence the audit needs.** Keep the production Soniox job until the nightly audit has read it, instead of
   deleting it when the owner approves (removes the nightly's re-transcription spend).
4. **Bound production retries.** Per-class caps on judge and infrastructure retries, counters for the immediate
   style/evidence retries, prices for timed-out calls (the watchdog's M16 findings feed this).
5. **Watch the critical rate.** Critical-mode recall matters more than average accuracy: at about 1 % critical per post,
   a 14-day window with no critical is rare by chance.
