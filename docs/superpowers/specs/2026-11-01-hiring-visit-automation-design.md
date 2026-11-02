# Hiring visit automation: design

Date: 1 November 2026. Status: draft for Kevin's review. Approved screens: [Hiring Automation Mockup](https://claude.ai/artifact/5Wz9cdwaJStzGoPSDbMP98) (sample data).

## Intent

Kevin wants tutor hiring to run by itself from the SEEK application up to the candidate's arrival onsite. He must be able to see what the system did at each step and control how many people it contacts. He does not want the system to contact too many candidates, to offer a time when a head of department is absent, or to require him to read long AI text.

The primary user is Kevin. Gift and hiring staff also use the page.

## Goals

1. Show who received the pre-screen form, who replied, what they wrote and what score they received.
2. Score pre-screen responses, and invite only candidates with an acceptable score.
3. Replace the paper-then-mock flow with one onsite visit: a 2-hour exam, then a 1-hour mock.
4. Show each head's week: office hours, Wise classes, leave, exams and mocks.
5. Give editable limits on how many people get the form and how many get an onsite invitation.
6. Make profile evidence short, in ASD-STE100, with the DSCTE score as a pentagon.
7. Open each candidate's original résumé from Hiring.

## Non-goals

- Recording visit results, final hiring decisions or rejection messages. These stay manual and outside the app.
- Reading heads' Google Calendars. Office hours are the current source.
- Visits on Saturday or Sunday.
- Testing more than one subject in one visit. A later visit for another subject is a later project.
- Any model API-key spend. Scoring stays on the Claude subscription on Kevin's Mac.

## Anti-goals

The work has failed, even if it runs, if any of these occur:

- A large batch of candidates gets an email because a limit, a stale count or a backfill did not hold.
- A candidate gets a repeat invitation.
- A slot is offered when a head is outside saved office hours, teaching in Wise, or on leave.
- A backfill, rescore or release sends a message or changes a candidate's stage.
- A person without Hiring access can open a résumé.
- Nationality, name or other protected data affects a score.

## Current state

Evidence from `origin/main` at `c23f7968`, plus read-only production queries on 1 November 2026:

- 654 candidates: 335 new, 178 stopped, 114 review, 16 paper invited, 5 mock booked, 3 paper booked, 2 pre-screen, 1 paper passed. These counts can change: a separate Codex task is working on the same data.
- 79 candidates hold a pre-screen response. None has a pre-screen assessment, because `assessCandidates` only reaches `new`, `review` and `pre_screen`, and score-only mode only scores the profile.
- The outbox holds 2 sent pre-screen emails. There are 0 bookings. Automation and delivery are paused.
- Stored summaries average 1,149 characters. Stored criterion reasons average 396 characters.
- `hiring_mock_window` in migration 0118 fixes mocks at Monday–Friday, 10:00–16:00, one hour. Settings cannot change this.
- `availableSlots` and `verifyLiveSlot` require positive onsite working hours in Wise.
- `scripts/hiring-seek.ts` downloads each résumé, extracts redacted text, then deletes the file. It stores `true` only for the permanent-rights answer and `null` for everything else, and it discards the answer text.
- In a read-only sample of the first 80 SEEK Inbox candidates, 79 answered "I have permanent work rights with no restrictions" and 1 answered "I am a long term / permanent resident with eligibility for a work permit". The app shows no recognised answer for 219 of 335 new candidates. The cause is probably old imports. The re-read below settles it.
- `tutor_attendance_schedules` holds saved weekly hours, all 10:00–16:00: Ek Mon–Thu, Peat Tue–Fri, Mimi Mon–Fri, Tito Sun/Mon/Thu/Fri. Gift is not enrolled and has none. All five have an enabled LINE group.

## Decisions made by Kevin

### Flow

1. A new SEEK candidate gets a profile score.
2. A candidate who passes the profile gate enters the pre-screen queue. Sends obey the limits.
3. On a reply, the worker scores the response.
4. A new response that passes the pass score and all hard stops enters the onsite queue. Sends obey the limits, and the candidate gets a booking link automatically.
5. The candidate books one visit, for one subject: a 2-hour exam, then a 1-hour mock with the head for that subject.
6. A response below the score, or one that fails a hard stop, goes to review. No rejection is sent.

### Pre-screen follow-up

Send one reminder after 3 days. Mark as no reply after 7 days. Both numbers are editable. A candidate marked no reply no longer counts against the waiting limit.

### Onsite link with no booking

Same rule, with separate editable numbers: one reminder after 3 days, and the link expires after 7 days. Expiry frees the place, and the candidate shows No booking. Only a click can send a new link.

### Pre-screen score

Editable weights, separate from the profile weights, must total 100. Starting values: Degree 10, Subject 10, Curriculum 15, Teaching 15, English 15, University prestige 10, Written answers 15, Availability 10.

### Hard stops

These stop an automatic invitation at any score:

- Completed bachelor's degree or higher.
- English: C1 for English subjects, B2 for other subjects. "Native" counts as C2.
- At least one weekend day and one weekday after 15:00.
- An accepted SEEK work-rights answer. The accepted list starts with only "I have permanent work rights with no restrictions". The long-term resident answer is not accepted. Settings hold the list, and any new answer is not accepted until Kevin ticks it.

A related degree field is not a hard stop. It affects the score only.

### Limits

All numbers are editable.

| Limit | Pre-screen form | Onsite invitation |
|---|---:|---:|
| Per Bangkok day | 5 | none |
| Per week | 15 | 3 |
| Waiting for reply | 15 | none |
| Invited, not booked | none | 2 |
| Open per subject | 3 | 2 |
| Mocks per head, per week | none | 2 |

### Queue order

Kevin ranks subjects in settings. A subject can be set to not hiring, and its candidates stay out of both queues. Within a subject, the highest score goes first.

### Head availability

A mock slot needs saved office hours for that head, no Wise class, no Wise leave, no sit-in and no other hiring booking. The head is blocked for the mock hour only. Office staff supervise the exam. Gift starts on Monday–Friday, 10:00–16:00.

There is one set of hours. A change in Hiring settings changes Tutor Attendance for enrolled heads.

### Booking changes

A candidate can move a booking once through the link, up to 24 hours before the visit. Later changes go through staff on LINE. Staff can cancel a visit or mark a no-show in Hiring, which frees the slot and the limit.

### Existing data

- Score all pre-screen responses already held, including stopped candidates. This changes no stage and sends nothing.
- A person clicks to invite a candidate from an earlier response.
- Evaluate everyone in the app with no response, and everyone in the tracker who is missing from the app. Evaluating gives a score and a visible status. It does not make a candidate eligible for an email.
- Only candidates at stage `new` can enter the automatic pre-screen queue (335 today). Candidates in review stay visible with scores, and a person clicks to send. Stopped candidates and candidates with earlier contact never enter it.

### What a click can override

A click needs a written reason and writes an audit row. It can pass a pre-screen score below the pass score. It cannot pass a limit or a hard stop, and it cannot invite for a not-hiring subject.

### Tracker

The Recruitment Sheet and the Mock Teaching Test Log are read-only input, and they change nothing for a new-flow candidate, not even a stop. Staff stop new-flow candidates in Hiring. A new-flow candidate is one whom the app has sent the form, or who is at `onsite_invited`, `onsite_booked`, `no_reply` or `no_booking`. Old-flow candidates keep today's tracker behaviour. The Pre-screen Responses tab stays the source of replies, and the Hiring Automation tab keeps the mirrored data.

### Screens

Follow the mockup.

- **Pipeline:** limit meters, DSCTE average pentagon with full labels, a pre-screen column and filter (Queued, Sent, Reminded, Replied, No reply, with dates), a Visit column and a Résumé button on each row.
- **Candidate panel:** the pentagon with profile and pre-screen shapes, with each corner labelled by name and result. Short evidence, with the exact quote on a click. Full pre-screen answers and score parts. Visit details. An original résumé viewer.
- **Head schedules:** one calendar per head, with a head switch and a week switch, plus a list of that head's visits.
- **Rules and setup:** all limits, weights, hard stops, accepted work-rights answers, subject priority, head days and résumé retention.

### Evidence text

Summary of up to 25 words. One line of up to 15 words per DSCTE criterion. Both in ASD-STE100. The source quote stays exact, because the validator compares it to the source.

### Résumés

Keep the original file in private storage. A PDF opens in the panel and a Word file downloads. Only people with Hiring access can open a file. Delete the file after 12 months with no candidate activity. The number is editable.

## Calls made by Claude

Kevin can overrule any of these.

1. **A visit is two booking rows.** One `paper` row with no interviewer and one `mock` row with the head, joined by a new `visit_id`. This keeps the overlap triggers, the sit-in protection and the exam capacity as they are.
2. **The head is assigned by the app.** Each time appears once to the candidate. When two heads can take a subject, the head with fewer mocks that week is assigned.
3. **Visit times.** The exam starts on the hour between 10:00 and 13:00, and the mock starts when the exam ends. The exam limit uses the existing `paperCapacity` setting. The candidate sees the next 5 business dates, as today.
4. **The pass score starts empty.** While it is empty, automatic onsite invitations cannot run. Kevin sets it after he sees the scores of the existing responses.
5. **Clicks obey the limits.** A manual invitation counts toward the limits and is refused when a limit is full, with a message that names the limit. To send more, Kevin raises the number. A click does not change the queue order for other candidates. Any user with Hiring access can click.
6. **Availability score.** The server calculates this, not the model. Half the points for meeting the time-slot rule. The other half from weekly hours: 1–10 gets 20% of that half, 11–20 gets 60%, 20 or more gets 100%.
7. **Written answers score.** The model scores this as met, partial or not met with exact quotes, using the two written answers. The rubric asks for a specific diagnosis, specific actions and care for the student. It does not mark grammar, accent or suspected AI use.
8. **Profile gate.** To get the form: profile score at or above the threshold, an accepted work-rights answer, a usable email, no earlier contact, at least one supported subject in a hiring subject, and a degree criterion that is not `not_met`. This removes the old rule that degree and subject must be `met`. More candidates can qualify, and the limits control the pace.
9. **Subject for the visit.** The candidate's highest-ranked supported subject. "Open per subject" counts this subject only.
10. **A late reply still counts.** A reply after the candidate is marked no reply is scored as normal.
11. **A Wise clash after booking does not move a visit.** The calendar and the candidate row show the clash, and staff act.
12. **Gift's hours stay in Hiring settings.** Enrolling Gift would start attendance tracking for Gift, which Kevin did not ask for.
13. **Old stages stay.** Candidates at `paper_*` or `mock_booked` keep their stage and their existing actions. The new flow does not move them.
14. **Calendar.** Two private events per visit: the exam for the candidate and the mock for the candidate and head. One confirmation email holds both times.
15. **Original long reasons stay stored.** New short fields sit beside them, so the rewrite destroys nothing. The UI shows the result label only when a short line is missing.
16. **Retention runs on Vercel Cron**, so it does not depend on the Mac. Only the file is deleted. Extracted text stays until a separate decision.
17. **Which reply is automatic.** A reply invites automatically only when the app sent this candidate the form, this is the candidate's first response after that send, and the stage is still `pre_screen` or `no_reply`. All other replies need a click: a response from a stopped or in-review candidate, a response with no matching send, and a changed resubmission. The form link is public, so this rule stops an unsolicited or repeated response from starting an invitation. Replies that arrive during a pause are processed when automation resumes.
18. **What "open" counts.** Pre-screen open: the form is queued or sent, with no reply, and not marked no reply. Onsite open: the candidate is invited or booked, until the visit's end time passes. Old-flow candidates do not use places in these limits, but their bookings still block a head's calendar.
19. **After a staff cancel or no-show.** The panel offers Send new link. This is a click: it needs a reason, obeys the limits and resets the move-once count. It is the one permitted repeat invitation. There is no staff booking screen.
20. **Tracker-only people with no source text.** They show "No source text" and take no automatic action. A Sourcing Log or Scheduling Responses person missing from the app is imported the same way, with earlier contact set, and a report lists the counts before any import.

## Design by part

### Data model

Migration `0119` (confirm the next free number when building):

- Widen the `hiring_stage` check with `onsite_invited`, `onsite_booked`, `no_reply` and `no_booking`.
- Replace `hiring_mock_window`: keep the interviewer, one-subject, one-hour and same-Bangkok-date rules. Remove the fixed weekday and time window, which move to settings and the slot code.
- `hiring_bookings`: add nullable `visit_id` and `reschedule_of`. Add `no_show` to the status check.
- `hiring_candidates`: add `work_rights_answer`, `visit_subject`, `pre_screen_queued_at`, and the résumé fields (`resume_path`, `resume_name`, `resume_type`, `resume_sha256`, `resume_size`, `resume_stored_at`).
- Candidate reschedule count: derive it from `reschedule_of`.

`configSchema` gains the limit numbers, `preScreenThreshold` (nullable), `preScreenWeights`, reminder and expiry days for the form and for the onsite link, `acceptedWorkRights`, ordered `subjectPriority` with a not-hiring flag, a fallback week for heads with no attendance record, and `resumeRetentionMonths`. Existing stored settings must parse with these defaults. The setup-panel save and the university-seed task use the same row and the existing revision guard.

`workRightsConfirmed` becomes derived from `work_rights_answer` and the accepted list. Remove the old "unknown rights" assumption from the table flags and `readyToInvite`.

### Queue and limits

One server function, in `src/lib/hiring/`, decides who may receive an invitation now. It takes settings, counts and eligible candidates, and it has no I/O so that tests can cover it directly. The worker and the manual action both use it.

- Runs in a transaction under one advisory lock, so two runs cannot both use the last place.
- Counts queued and sent items. A pending outbox row counts as used.
- Day and week boundaries use `Asia/Bangkok`. A week starts on Monday.
- The Pipeline meters read the same counts.
- The candidate's queue position and the limit that holds them show in the table and panel.

The worker processes each candidate in its normal order, then releases sends by priority. Eligibility and release are separate steps, so a change in priority takes effect on the next cycle.

### Pre-screen status

A pure function derives one status per candidate from the outbox, stage and response: Not sent, Queued, Sent, Reminded, Replied, No reply, or Earlier contact (contact outside the app). The dashboard query returns the outbox `workflowStage` and `sentAt`, not the email body.

Reply time comes from the form timestamp. The tracker timezone is `Etc/GMT`, and the UI shows Bangkok time. The match to a candidate stays by normalized email. A response with no match stays a review case.

Reminder: an outbox email with key `{candidateId}:pre-screen-reminder`, with `workflowStage: "pre_screen"` so that a stage change cancels it. The onsite reminder works the same way, with `workflowStage: "onsite_invited"`.

### Tracker sync

Add a guard in `syncTracker`: for a new-flow candidate, a Recruitment Sheet or mock-log row does not change the stage, subjects or `previouslyContacted`, and it does not call `inviteToBooking`. After this guard, the only invitation paths for a new-flow candidate go through the shared limit function. Old-flow behaviour stays.

### Pre-screen scoring

A new assessment schema adds a `written` criterion and adds no change to `assessmentSchema` that breaks stored rows. Prestige comes from the existing calculation. Availability comes from the server.

`preScreenResult` and `englishLevel` change to the new hard stops. `Native` in the English form field means C2. The system prompt must keep the rule against inferring English from a name or nationality. A stated "Native" is the candidate's own claim and is only read from the form field.

Add score-only pre-screen mode to `npm run hiring:score`, covering all stages, with no stage change and no send. The audit row records the source hash.

### Availability and booking

`availableSlots` gets a new `visit` kind. For each date and exam start, the exam must fit `paperCapacity` and the office window. The mock hour must pass, for an interviewer:

- saved hours (attendance requirement, or the fallback week);
- no blocking Wise session and complete leave coverage;
- no sit-in and no hiring clash;
- under the per-head weekly limit.

Remove the positive Wise working-hours requirement from `indexedSlotAvailable` and `verifyLiveSlot`, by Kevin's direct instruction. Keep the fresh-snapshot check and the final live Wise read of sessions and leave. Keep the identity, leave and session data-issue blocks. Keep fail-closed behaviour on an unresolved teacher or incomplete Wise data.

Booking inserts both rows in one transaction, and the trigger and lock stay in place. Tokens gain a `visit` kind. A booked visit's link stays valid until the visit starts, so the candidate can move it once. A move cancels the old rows, inserts new rows linked by `reschedule_of`, and queues the email, calendar cancel, new calendar events and a LINE notice.

Staff actions: cancel visit, mark no-show. Both need a reason, write an audit row, free the limit and show the candidate as needing attention.

### Head schedules

A new read path under `GET /api/hiring`, guarded by `requireHiringAdmin`, returns one head's week: office hours, session blocks and leaves from the in-memory index, and hiring bookings. No student names go to the page. The week switch starts at the current week and cannot go back, because Wise omits past sessions.

Reuse the existing calendar helpers where they fit. The page uses the Hiring surface styles and tokens, not the compare palette.

### Settings for head days

Enrolled heads: write a new attendance schedule version through the existing attendance code, effective from the next day, with the Hiring actor in the audit. Other heads: write the fallback week in Hiring settings.

### Résumés

The worker keeps the downloaded file and uploads it to private Vercel Blob. The Mac does not hold a Blob key: a signed internal route, in the same style as `/api/internal/hiring-delivery`, issues a short-lived upload token for one exact path. Client upload avoids the 4.5 MB body limit. Existing limits stay: 15 MB, 30 pages, PDF or Word by file signature.

`GET /api/hiring/resume/[id]`: requires a current Hiring admin, reads only the stored path, and streams the file with `no-store`, `nosniff`, and `inline` for a PDF or `attachment` for Word. The AI continues to read only redacted text.

A one-time read-only pass of all SEEK candidates stores the original files and the exact work-rights answers. It changes nothing in SEEK, sends nothing, and changes no stage. It must be resumable, and it reports candidates with no file.

Retention: a new daily Vercel Cron deletes files after the set months with no activity. It goes through the normal cron registry and the no-collision test.

### Short evidence

Add `brief` to each criterion and `briefSummary` to the assessment, with word-limit validation and retries, like the existing evidence retry. Word count is the checked limit. STE compliance comes from the prompt and is not machine-verified.

A rewrite pass fills these for stored assessments, using the subscription runner, without changing results, quotes, scores or stages. Run it with a stop time, because it uses Kevin's subscription allowance.

### Pentagon

A plain SVG in the existing Hiring components, with no chart dependency. Axes are Degree, Subject, Curriculum, Teaching and English, with values 1, 0.5 and 0. Prestige is not an axis. `role="img"` and a text label give the same facts to a screen reader. The average chart reads the candidates in the current filter.

## Release and go-live

Each step needs Kevin's separate approval. Approval of this design covers local implementation and tests only.

1. Merge reviewed PRs. Required CI checks stay. No protection bypass.
2. Apply only the reviewed migration to production.
3. Run the read-only SEEK pass and the score-only and rewrite passes. These send nothing.
4. Kevin reviews scores, sets the pass score and checks the limits.
5. Kevin turns on automation and messages. Start with one cycle, with the worker `--once`, and check the recipients.

Automation stays paused until step 5. This keeps the 31 October instruction to keep outreach paused.

## Acceptance examples

1. **Limit holds.** 40 candidates qualify and the daily limit is 5. One cycle queues 5, chosen by subject rank and then score. The other 35 show Queued with a position. A second cycle on the same day queues 0.
2. **Reply to invite.** A candidate replies with C1, a supported subject, a weekend and a weekday evening. The score is above the pass score. Within one cycle, Hiring shows Replied, the answers and the score, and the candidate gets a link if the onsite limit allows. Otherwise the candidate shows Queued and the limit.
3. **Visit booking.** A Mathematics candidate sees only times when Peat or Ek can take the mock hour. Choosing Tuesday 10:00 creates an exam at 10:00–12:00 and a mock at 12:00–13:00. Peat's calendar shows the mock as busy and the exam as not needing the head. No Ek slot appears on a Friday.
4. **Move once.** The candidate moves the visit 2 days before. The head gets a LINE notice and the calendar updates. A second move is refused with the LINE contact.
5. **Résumé access.** A Hiring admin opens a PDF in the panel. A user without Hiring page scope gets a 403. After the retention period the file is gone and the panel says so.
6. **Backfill is silent.** The score-only, rewrite and SEEK passes change no stage and add no outbox rows, proved by a before-and-after count.
7. **Native.** A candidate who selects Native with no test passes the English stop for EFL/ESL. A candidate with B1 does not.
8. **Tracker cannot invite.** A new-flow candidate's tracker row changes to a paper pass. No stage changes and no email is queued.
9. **Click limits.** An earlier responder below the pass score can be invited with a click and a reason. If that candidate fails a hard stop, or the onsite limit is full, the click is refused with the reason.
10. **Silent link.** A candidate ignores an onsite link. Day 3 sends a reminder. Day 7 frees the place and shows No booking. No second link goes out without a click.

## Checks

- Unit tests: the limit function, status derivation, availability score, hard stops, slot rules, word-limit validation.
- Integration: extend `workflow.integration.test.ts` for the queue under concurrent workers, visit booking, move-once, staff cancel and silent backfill.
- Browser check of the signed-in Pipeline, Head schedules and Rules views at desktop and phone width.
- `npm run verify:release`, plus the route-surface guard update and the cron registry parity tests.
- Update `docs/features/hiring.md`, `docs/reference/crons.md` and the API and database reference pages.

These checks do not prove delivery, live candidate behaviour or scoring quality. Those stay separate go-live checks.

## Risks

- **Mac dependency.** Intake and scoring stop when the Mac sleeps or the Claude or SEEK sign-in expires. Booking and delivery run on Vercel. The page must show a stale worker clearly.
- **Self-declared English.** "Native" as C2 is the candidate's claim. The exam and mock are the next check.
- **Fewer slots.** 3-hour visits, Wise classes and caps can leave few times, especially Chemistry with Mimi only and Tito on three weekdays. An empty slot list must show a contact route.
- **Personal data.** Original files show phone, birth date and photo. Access, `no-store` and retention are the controls.
- **Attendance side effect.** Changing a head's days in Hiring changes attendance expectations.
- **Parallel work.** A Codex task (`CW-20261101-hiring-university-seed`) is changing school scores for this data, and the disabled worker runtime sits in `.codex/worktrees/hiring-automation`. Keep its changes and do not start that worker during this work.

## Left to the builder

File layout, query shapes, exact email wording (in plain language, consistent with existing templates), PR split and order, and the empty and error states, in keeping with the mockup.
