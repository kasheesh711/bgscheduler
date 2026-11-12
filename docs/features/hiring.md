# Tutor hiring

Status: visit automation is live with sending off (2 Nov 2026). The three-stage revamp is complete in code on stacked pull requests #246 to #254. Local checks passed. Migrations `0120` and `0121` are applied to production. Merge, deployment, live use and acceptance are separate steps, listed in [Go-live for the revamp](#go-live-for-the-revamp).

The Hiring page has six tabs. Each opens by address (`/hiring?view=seek`).

- **Overview** (`view=overview`): summary figures, limit meters, the candidate table, charts, and worker, delivery and activity status.
- **1 Seek intake** (`view=seek`): see [Seek intake](#seek-intake).
- **2 Calls** (`view=calls`): see [HR calls](#hr-calls).
- **3 Pre-screen** (`view=prescreen`): see [Pre-screen screen](#pre-screen-screen).
- **4 Mock and paper** (`view=assessment`): see [Mock and paper](#mock-and-paper), including the calendar of heads.
- **Rules and setup** (`view=setup`): the rules, plus pass marks and the paper library.

The Hiring workspace follows a candidate from a SEEK application to one onsite visit: a 2-hour exam, then a 1-hour mock teaching session. The system scores the candidate, sends the invitations inside editable limits and books the visit. It does not record the visit result. It does not make a final hiring decision. It does not send rejection messages.

Open a candidate to read the full extracted profile and résumé text. The text is loaded separately from the candidate list and keeps the extraction's personal-detail redactions. Text unavailable in the source is shown as unavailable. The same panel opens the original résumé file (see [Résumé files](#résumé-files)).

The live worker asks for one continuous source passage in each evidence field. If validation fails, it retries twice with the error and the previous answer. Each failed attempt is stored in `hiring_audit` as `assessment-validation-failed`, with the source hash, attempt, error and returned assessment. After three failed attempts, the candidate stays on Review; unsupported evidence never receives a score. The score-only review command retains its own retry controls below.

## Review passes before activation

Each pass below runs on the owner Mac. Each pass changes no stage and queues no message. Each pass refuses to run while Automation or Messages is on, and each needs `HIRING_WRITES_ENABLED=true` in the Mac's environment. The exceptions are `--tracker-results-report`, which also reads only, and `--tracker-report`. It is read-only and needs neither.

- `npm run hiring:score` scores stored profiles in all stages. It uses four concurrent Claude subscription calls and resumes from stored source hashes. It stops when no unscored source remains.
- `npm run hiring:score -- --pre-screen` scores every held pre-screen response in all stages, including stopped candidates.
- `npm run hiring:score -- --briefs` writes the short display lines (see [Short evidence](#short-evidence)) for stored assessments. It changes no result, quote, score or stage. It needs `HIRING_SCORE_UNTIL`.
- `npm run hiring:score -- --retry-invalid` revisits evidence-validation holds. Each held profile gets up to three attempts with exact-quote instructions and validation feedback. The same validator still rejects unsupported evidence. A valid retry clears its old automatic evidence warning. Human notes and candidate stages stay unchanged.
- `npm run hiring:backfill -- --seek` reads SEEK once and stores the exact work-rights answer and the original résumé file of each known candidate. `--tracker-report` and `--tracker-import` handle people who exist only in the tracker. See [Backfill passes](#backfill-passes).

Set `HIRING_SCORE_UNTIL` to an ISO timestamp to stop model calls at a deadline. These passes do not enable live hiring. Scores appear as each assessment completes. They do not update the live worker's last-run timestamp. A pass that could not store some answers because a row or the settings changed meanwhile prints a count and exits with code 2. Run it again.

## Seek intake

Coverage cards show each imported SEEK folder (Inbox, Prescreen, Shortlist) against the website: the count in SEEK, the count imported, what is waiting, and the last read. The worker writes these numbers. A summary saved before this change shows the SEEK count only. A read over one hour old shows a warning. An idle tab shows the warning only after the next page action.

The list holds people with a SEEK application. People only in the tracker are in Overview. Filters: name or email, university names (several), the exact work rights answer, subject, campaign (when there is more than one), and score against the profile threshold. Click a row to open the resume beside the list. Up and down arrows move between people, one press at a time, because each move opens a file. A Word file, or a PDF that will not open, shows the extracted text.

**Send queue** numbers the pre-screen queue, then lists who was sent and when. A person can drag a row or use its arrows. The order controls real sends, through `mergeManualOrder` in `limits.ts`.

- A drag sends nothing, and changes no stage or `revision`. It writes an audit row.
- All limits and hard stops still apply. A full subject skips a dragged person, and the next person goes.
- A new arrival takes its automatic place. **Back to automatic order** clears every drag.
- Only the pre-screen queue can be dragged. The onsite queue stays automatic.

## HR calls

HR phones the strongest applicants before the pre-screen form goes. A candidate who passes the [profile gate](#profile-score) with a profile score at or above the **HR call score** (Rules and setup, starts at 80) waits on the **2 Calls** tab. The form cannot go until HR records a good call. A candidate below the call score gets the form automatically, as before. A blank call score turns the step off.

The list is sorted by profile score, highest first, then the earlier application. A candidate who fails another part of the gate (for example, a subject that is not hiring) is not on the list, because the form could not go after the call.

Each row shows the subject, the university and a **View on SEEK** button. The subject is the one the form goes for after a good call: the highest subject in the subject ranking that the profile supports. The other supported subjects show under it. The university is the one that the [profile score](#profile-score) confirmed, or "Not confirmed". **View on SEEK** opens the candidate's SEEK page in a new tab, where the phone number and the résumé are. Click a row to open the same résumé panel as Seek intake.

| Button | Result |
|---|---|
| Good call | The candidate joins the pre-screen send queue at their automatic place. The limits, the drag order and the switches still control the send. |
| No answer | The try is saved with its time. The candidate stays on the list. |
| Bad call | Stop, after a confirm. Nothing is sent to the candidate. |

- A result sends nothing and changes no stage or `revision`. Each click takes the queue lock and writes an audit row (`call-good`, `call-no-answer`, or `stop`). A click for someone who has left the list gets "Refresh the page".
- A person can still use **Invite to pre-screen** in the full record. That click counts as a good call, marked `manual` (Kevin's decision, 4 Nov 2026).
- A good call stays valid if the score or the call score changes later.
- **After a good call, SEEK moves do not hold the form** (Kevin's decision, 4 Nov 2026). A SEEK card that leaves Inbox keeps the candidate at `new`. A SEEK message still sets `previouslyContacted`, but the gate does not hold on it, and a waiting form is not cancelled. Not Suitable and Accept in SEEK still stop the candidate. The onsite reply rule also lets earlier contact pass after a good call (Kevin's decision, 12 Nov 2026); without a good call it still holds the reply for a person. A hand **Invite to pre-screen** that counted as a good call (`manual`) passes in the same way.
- **Record the call before you touch SEEK.** Before a good call is saved, a SEEK card that leaves Inbox still moves the candidate to review, and a SEEK message still counts as earlier contact. The candidate then leaves the Calls tab, and only Invite in the full record can send the form.
- **Release order.** Apply migration `0123` to production before the merge, because the dashboard reads every candidate column. Only the Mac worker releases forms, so update the Mac checkout to the merged code before Automation is on: an older worker does not know the call step and would send the form to uncalled candidates. An older worker also refuses a settings row saved with `callThreshold`, which stops it safely. For the same reason, a rollback after a settings save needs the `callThreshold` key removed from the stored config first. Drizzle skips a migration whose journal time is older than the newest applied one: `0122_hiring_campaigns` (on `feat/hiring-campaigns`) must be applied before `0123`, or its journal time raised above `0123`'s.
- The data is `hiring_candidates.call_review` (migration `0123`). Design: `docs/superpowers/specs/2026-11-04-hiring-call-queue-design.md`.

## Pre-screen screen

The list holds everyone sent a form, including people with no reply. The Visit email column reads `hiring_outbox`, not the stage, because the stage changes when the email is queued. It shows Queued, Sent with Bangkok time, Failed, May have sent, or the reason it was not sent. The panel shows the full answers, the score, and the AI's reasons with quotes.

| Action | Rule |
|---|---|
| Invite despite low score | The existing invite. It obeys limits and hard stops. |
| Stop | The existing stop. It cancels waiting emails. |
| Change score | Stored in `pre_screen_override`. The AI assessment stays. It sends nothing and changes no stage. After it, only a person can invite this candidate: `replyCheck` holds the reply, and the worker does not move it to review. It is refused while a visit email is waiting, since that email would still leave. A changed response from the candidate clears it. |
| Resend with a new link | For someone invited and not booked, or at `no_booking`. It cancels every unsent invitation and reminder holding the old link. It refuses while the worker holds a row or Messages is off. It uses no new weekly place. |

Known limit: while the new email fails at the provider, the old link has already ended, so the candidate has no working link until the email leaves.

## Mock and paper

The dated list has one row per visit, soonest first, then past visits, newest first. A candidate whose only visit was cancelled keeps a row, so a person can still reject them. Filters: head, date, needs upload, needs check, ready to decide, past results. The Calendar switch shows each head's week.

### Paper marking

A person uploads one scanned PDF for each subject, up to 25 MB, on the row or in the panel. The browser sends it to private Blob. The server then checks that the bytes are a PDF of the size chosen, and deletes a refused file.

`markPaper` sends the scan through OpenRouter, with the question paper and mark scheme from the [paper library](#rules-and-setup) when they exist. The model returns marks for each question. **The server calculates all totals, percentages, results and the "can teach up to" line** (`marking-sheet.ts`), from the marks and the current pass marks.

| Rule | Detail |
|---|---|
| Result counts at once | Owner decision. There was no accuracy test before go-live. |
| Needs check | Only when an answer is unreadable or a page is missing. It blocks Hire until a person clears it. Reject is still allowed. |
| No mark scheme | The AI marks from its own knowledge, and the sheet shows a warning. |
| No pass mark | The sheet shows the marks and "Pass mark missing". It never guesses. |
| Can teach up to | The highest level passed. A failed lower level does not change it. AS / A-Level, IB and AP are peers, so a pass in more than one names them all. |
| Refused answers | A mark above its maximum, a repeated question, marks on a question not tried, or any added total. The row fails with a plain message, and the upload stays. |
| Old flow | An AI pass changes no stage and writes no `paperPassedSubjects`, because a difference there can queue a mock invitation. A person clicks the existing button. |
| Privacy | Calls use `OPENROUTER_HIRING_API_KEY`, zero data retention and `data_collection: deny`. No file content is logged. A preview never sends a scan. Scans follow the resume retention rule, and the marks stay. |

**Known risk, accepted by the owner:** a misread mark on a readable paper raises no flag, including a score close to the pass mark. A person sees it only by opening the marks beside the scan. A Reject email can follow from it. If this happens, the first fix is a "close to pass mark" flag.

### Mock rubric

A person uploads the head's completed rubric as a PDF. The AI copies the 10 scores and the comments, and the server calculates the four part scores and the total out of 100. A blank score or one off the scale stays blank and needs a check, so the good scores are kept. A file with no score at all fails as the wrong form. A person can change scores, replace the file, or run the AI again. The AI's first read stays unchanged.

### Decision and result email

Clicking Hire or Reject saves a draft with the email text. **A draft creates no outbox row and changes no stage**, so nothing can leave later when the switches come on. The person reads the address, edits the text, and clicks Send. It goes to one candidate at a time.

- **Hire** needs one mock and every uploaded paper finished, with checks cleared. The person decides freely on low scores. A past result from the tracker does not count.
- **Reject** works any time, with a reason and an email address. Someone with no address uses Stop in the full record.
- **Send** refuses while Automation or Messages is off. The email leaves from the website at Send, through Resend.
- A new Send cancels any earlier result email that has not left. The same result cannot go twice unless the first failed. A sent email is not recalled.
- A visit still ahead must be cancelled first. A future old-flow booking ends at Send and leaves the head's calendar.
- **A sent decision stands.** A move in SEEK, a tracker change, Stop, a booking link and a retried visit email cannot overwrite it or reach the candidate.

The first email text is in `resultEmail` in `decisions.ts`.

## Source findings — 31 October 2026

The [recruitment tracker](https://docs.google.com/spreadsheets/d/12bXS1Fnx0BTwrSZXzMU7fWzOgTDfA6-P6rT0v1zDF3M/edit) has 11 tabs. The reviewed ranges contained 84 sourcing records, 83 pre-screen responses, 81 main candidate records, 30 scheduling responses and 12 subject-level mock records. These include test records; they are not counts of active candidates.

The [current SEEK job](https://th.employer.seek.com/candidates/?jobid=94844236) is expired. Its page showed 637 applications: Inbox 362, Prescreen 45, Shortlist 72 and Not Suitable 158. The original page was filtered to Inbox. An Inbox-only export must not be described as all 637 applications. The worker checks counts and pagination across all seven status folders. It imports profiles from Inbox, Prescreen and Shortlist. It tracks manual status and contact changes for known candidates without reviving candidates in Not Suitable or Accept.

The table shows the tracker's own process. It is the old flow. The new flow is in [Workflow](#workflow).

| Stage | Evidence | Operation in the tracker |
|---|---|---|
| CV review | Sourcing Log, columns L–N | Human High/Mid rating and Yes/No decision; no numeric rubric is stated. |
| Pre-screen invitation | Message Templates, E1 | Email links to the existing Google questionnaire. |
| Pre-screen assessment | Pre-screen Responses, T–W | 33 Qualified, 39 Manual Review, 11 Not Qualified. These are script-produced categories, not numeric scores. |
| Human decision | Recruitment Sheet, L | Gift records Qualified, Unqualified or Hold. |
| Paper scheduling | Scheduling Responses; templates P1–P4/C1–C3 | Collect broad days and time periods; Mimi confirms the time. Two hours per subject. |
| Paper result | Recruitment Sheet, T–V | A human records the outcome, passed subjects and levels. |
| Mock scheduling | Mock Teaching Test Log, E–F; template PP1 | A separate appointment for each passed subject; one-hour choices. The candidate prepares an IGCSE topic and an interviewer-selected topic. |
| Assessment/hiring | Mock Teaching Test Log, G–I; later templates | Outside the scope of the system. |

The old pre-screen output indicates a completed bachelor's degree, related study and English at B2 for most subjects or C1 for English teaching. Experience, missing English evidence and teaching availability also produce flags. Exact script source and a full subject-to-degree rule table were not available; observed categories must not be treated as a validated algorithm.

Two recorded defects in the old script are corrected in the new logic. A `Native` answer was labelled below B2/C1. A combined `Bachelor's, Master's` answer was labelled below a bachelor's degree. The new logic accepts combined completed degrees. It counts `Native` as C2 when the candidate selects it in the form's English field (see [Hard stops](#hard-stops)). It never infers fluency from a name or nationality.

The tracker also has source drift:

- Its settings still point to job 84021325. The requested job is 94844236.
- Its hidden README describes a Subject Assessment Log that is absent.
- The active dropdown tab and Settings disagree on Computer Science/ICT interviewers. The active list names Gift; the setup proposes that map and allows an operator to change it.
- Old weekly mock lists and the README disagree about the weekday. The new flow uses the weekdays in each head's saved hours.
- The spreadsheet timezone is `Etc/GMT`. The page shows Bangkok time. Booking instants use `Asia/Bangkok` explicitly.
- A scheduling response is not proof that an invitation was sent. Email presence in SEEK is treated as prior contact, not permission to send another copy.

The [job advertisement](https://th.jobsdb.com/expiredjob/94844236?ref=cm-ui) asks for a related degree, subject knowledge, English, and full work rights in Thailand. It prefers teaching experience and names British/American curricula and Years 4–13. Its hours start after 16:00. On 31 October, Kevin explicitly kept the tracker's newer operational rule: onsite availability on a weekend day **and** at least one weekday after 15:00. The implementation follows that instruction.

## Scoring and advancement

There are two scores. The **profile score** comes from the SEEK profile. The **pre-screen score** comes from the candidate's form response. Both scores have editable weights in **Hiring → Rules and setup**. Each set of weights must total 100. Saving records the actor, revision and full configuration.

### Profile score

Kevin set these weights. The invitation threshold starts at 60.

| Criterion | Points |
|---|---:|
| Degree relevance | 10 |
| Subject evidence | 10 |
| Curriculum experience | 20 |
| Teaching experience | 20 |
| English evidence | 20 |
| University prestige | 20 |

For the five professional criteria, `met` earns the full weight, `partial` half, and `unknown` or `not_met` no points. Every scored claim must quote text present in the source. The model cannot set its own total or send a message.

Demonstrated SAT or ISEB teaching, tutoring or test preparation earns full curriculum credit, including SAT Math, SAT Verbal, 11+ and 13+. These are BeGifted service lines. A candidate's own exam score or an intention to teach is not teaching evidence. This rule applies to profile and pre-screen assessments.

**Profile gate.** A candidate at stage `new` gets the pre-screen form only if all of these are true:

- The profile score is at or above the threshold.
- The SEEK work-rights answer is on the accepted list.
- The candidate has a usable email.
- There was no earlier contact.
- The profile supports at least one subject that is open for hiring.
- The degree criterion is not `not_met`.
- Below the HR call score, or HR recorded a good call (see [HR calls](#hr-calls)). A good call also lets earlier contact pass.

A `partial` degree or subject can pass. This is a change from the earlier rule, which needed both to be `met`. More candidates can pass the gate. The limits control the pace.

**What happens when the gate fails.** The worker looks at the candidate again every cycle.

| Reason | Result |
|---|---|
| Profile not scored, below the threshold, subject not open for hiring, work-rights answer missing or not accepted, waiting for a call | The candidate waits at `new`. A change to a setting or a re-read answer takes effect on the next cycle. |
| Degree `not_met`, no supported subject, no usable email, earlier contact | The candidate goes to review. A person decides. |

### Pre-screen score

The pre-screen score has eight parts. The server calculates two of them. The model scores the others from exact quotes.

| Part | Starting points | Source |
|---|---:|---|
| Degree | 10 | Model |
| Subject | 10 | Model |
| Curriculum | 15 | Model |
| Teaching | 15 | Model |
| English | 15 | Model |
| University prestige | 10 | Server, from the profile's universities |
| Written answers | 15 | Model |
| Availability | 10 | Server |

- **Written answers.** The model marks the two written answers met, partial or not met. A met answer gives a specific diagnosis of the student's problem, specific actions and care for the student. The rubric ignores grammar, spelling, accent and suspected AI use. A quote for this part must come from the two written answers.
- **Availability.** Half of the points come from the time-slot rule: a weekend day and a weekday after 15:00. The other half comes from weekly hours. The band 1–10 gives 20% of that half. The band 11–20 gives 60%. A band above 20 gives 100%.
- **Prestige.** The calculation is the one in [University prestige](#university-prestige). Only the profile's universities count.
- The model reads English from what the candidate states. It never reads English from a name or nationality. The word *native* counts only in the English field.

The pre-screen text is redacted before a model sees it. The redaction also removes lines that name nationality, salary or religion. This can lower a score. It protects the rule that protected data never affects a score.

### Hard stops

A hard stop keeps a candidate from an automatic onsite invitation at any score. A click cannot override a hard stop. A candidate who fails one goes to review. The system sends no rejection.

- A completed bachelor's degree or higher. A combined answer such as `Bachelor's, Master's` counts. `Below Bachelor's` and a degree in progress do not count. A related degree field is not a hard stop. It affects the score only.
- A known English level, and at least one named subject that meets its level: C1 for English subjects (EFL/ESL, English Language, English Literature, IELTS) and B2 for all other subjects. A named subject that does not meet its level is dropped. The form's English choice decides the level. `Native` counts as C2 only when the candidate selects it in that field. Free text fills the level only when the field is blank. A candidate who selects B1 stops, even if the free text cites a high test score.
- At least one weekend day and at least one weekday after 15:00.
- An accepted SEEK work-rights answer. The accepted list starts with only "I have permanent work rights with no restrictions". Any other answer, such as "I am a long term / permanent resident with eligibility for a work permit", is not accepted. A new answer from SEEK appears in Rules and setup as not accepted. It stays that way until Kevin ticks it.
- At least one named subject. Art & Design Technology also needs a portfolio.

### University prestige

The source is **US News Best Global Universities**, not the US-only National Universities table, QS, THE, or a subject ranking. The initial edition is 2026–27. The [US News release of 16 June 2026](https://www.prnewswire.com/news-releases/us-news-unveils-2026-2027-best-global-universities-rankings-302800745.html) supplies the initial top-ten reference entries. Their rank is a research/reputation measure, not evidence of the candidate's teaching ability.

Only the profile's universities count. A pre-screen reply keeps the stored result. A missing or old-catalog result is recomputed from the profile, and only a candidate with no profile assessment uses the reply's list. Only a university that awarded a completed degree can count. Short courses, exchanges and employment do not count. Multiple degrees do not stack this bonus; the highest supported institution score applies.

With the initial 20-point weight:

- A verified US/UK institution starts at 8 points.
- A verified overall global rank adds 12 points for 1–10; 10 for 11–50; 8 for 51–100; 6 for 101–200; 4 for 201–500; 2 for 501–1000.
- Chulalongkorn, Thammasat and Mahidol receive 12 points. No unverified US News rank is assigned to them.
- Other institutions receive any supported ranking points but no US/UK country bonus.
- An unverified rank earns no ranking points and is labelled unverified. Institution country is matched to a reference entry or an exact, unambiguous record from the [ROR API](https://ror.readme.io/docs/rest-api). Candidate nationality is not used.

If the source name does not match the ranking catalog, the lookup checks the full names and aliases from one exact ROR institution record. Exactly one catalog match can supply the rank. It does not remove campus names or use approximate matching; multiple matches remain unresolved.

The initial reference list is deliberately limited to ten ranks proved by the release and the three named Thai universities. It is **not a complete ranking dataset**. An administrator can add a verified institution, aliases, country, global rank, edition and source under **University prestige rules and reference data**. Country-only scoring can run automatically for other exact ROR matches; missing rank coverage remains visible.

### Short evidence

The panel shows short lines first. Each assessment has a summary of up to 25 words and one line of up to 15 words for each criterion. The lines follow ASD-STE100. The server checks the word count and asks again, up to three more times, with the exact count. The prompt asks for ASD-STE100, and no code checks that. The exact source quote stays on a click, because the validator compares it to the source. The original long reasons stay stored. The short lines sit beside them. A rewrite pass (`--briefs`) fills the short lines of older assessments. A row whose lines never fit keeps its assessment without short lines, and each rewrite run asks again.

The DSCTE pentagon shows five corners: Degree, Subject, Curriculum, Teaching and English. Each corner has the value 1, 0.5 or 0, and a text label. University prestige is not a corner. The Pipeline view shows the average pentagon of the candidates in the current filter.

## Workflow

1. The owner worker reads the normal SEEK UI in a separate Chrome profile. It extracts the application ID, professional profile, résumé text where available, the exact work-rights answer and contact history. It stores the original résumé file. It never changes a SEEK candidate's status or sends through SEEK.
2. It imports existing tracker decisions and the latest pre-screen response for each normalized email. Existing source IDs, repeated applications and prior contact are retained. Initial historical contact stays in review and receives no invitation.
3. Claude Code runs through the existing subscription-only runner, with no tools, no MCP access, no API key, a schema and a bounded call. The server validates evidence quotes and computes scores.
4. A candidate at `new` who passes the profile gate waits in the **pre-screen queue**. A candidate at or above the HR call score waits on the **Calls** tab first (see [HR calls](#hr-calls)). The queue releases a form email only while every limit has room.
5. When the candidate replies, the worker scores the response. A response that meets the [reply rule](#reply-rule) and the pass score enters the **onsite queue**. The queue releases a booking link only while every limit has room. The worker scores only a response that came after a form the app sent. It does not score any other response, change its stage or send it to review. A person handles those responses. Kevin set this rule on 9 Nov 2026.
6. The candidate opens the signed link and books one visit for one subject. The server picks the head of department. A visit is a 2-hour exam, then a 1-hour mock with that head.
7. A response below the pass score, or one that fails a hard stop, goes to review. A person decides. The system sends no rejection.

The system never records the visit result and never makes the hiring decision. Those steps stay outside the app.

### Limits

All numbers are editable in Rules and setup. The Pipeline meters and the candidate table read the same counts.

| Limit | Pre-screen form | Onsite invitation |
|---|---:|---:|
| Per Bangkok day | 5 | none |
| Per week (Monday start) | 15 | 3 |
| Waiting for reply | 15 | none |
| Invited, not booked | none | 2 |
| Open per subject | 3 | 2 |
| Mocks per head, per week | none | 2 |

- Every queued or sent email counts as used, even a `failed` or `uncertain` one, because it may have reached the candidate. A pending row counts as used.
- Day and week boundaries use `Asia/Bangkok`.
- **What frees an open place.** The pre-screen waiting place and subject place end when the candidate replies, is marked No reply, or is stopped. An onsite place ends when the link ends (No booking), when staff cancel the visit or mark a no-show, or when the booked visit's end time passes.
- **What does not free the week.** The daily and weekly counts show emails sent. A cancel or a no-show does not free them, because a sent email cannot be taken back. To send more, raise the number. An email cancelled before it left does not count.
- One lock covers every release and every click, so two runs cannot use the last place.
- The queues release nothing while Automation or Messages is off. Otherwise rows would build up, and one delivery call would send them all. Follow-up reminders and expiry also wait.
- Kevin ranks the subjects. A subject set to not hiring stays out of both queues. Inside a subject, the highest score goes first, then the earlier application.
- A row that waits shows its queue position and the limit that holds it.
- With the pass score at `0` (see [Reply rule](#reply-rule)), the onsite limits are the only brake on visit invitations. Raise them if scored replies wait.

### Follow-up and expiry

The clock starts when the email is sent. An unsent email starts no clock. The numbers are editable and separate for the form and for the onsite link.

- **Pre-screen form.** One reminder after 3 days. No reply after 7 days. A candidate marked No reply no longer counts against the waiting limit. A failed or uncertain form row can never start the clock, so it moves the candidate to No reply 7 days after its first attempt, with no reminder. A pending row holds no clock.
- **Onsite link.** One reminder after 3 days. The place frees after 7 days and the candidate shows **No booking**. The booking link itself lasts 30 days, so the expiry setting cannot be more than 30. No second link goes out without a click.

### Reply rule

A reply invites a candidate automatically only if all of these are true:

- The app sent this candidate the form (a form email with status sent).
- The response is the first one after that send, and it is not a changed resubmission.
- The stage is still `pre_screen` or `no_reply`. A late reply after No reply still counts.
- The response passes every hard stop, and it supports a subject that is open for hiring and has a head.
- The candidate has a usable email, and no earlier contact unless HR recorded a good call.
- The pre-screen score is at or above the pass score.

**The score is not a gate from 12 November 2026** (Kevin's decision). Everyone who passes HR's call can book Mock and paper. To apply this, save the pass score `0` in Rules and setup (a settings save at release; the code keeps the dial). The form is still scored, the hard stops still hold, and the score still orders the onsite queue. Raising the number brings the gate back.

The pass score starts empty. While it is empty, no automatic onsite invitation runs. The form link is public, so this rule stops an unsolicited or repeated response from starting an invitation. A response from a stopped or in-review candidate, a response with no matching send, and a changed resubmission all go to review. A response that arrives while Automation is paused is processed when it resumes.

### What a click can do

A person with Hiring access can click **Invite to onsite visit** on a candidate who has a pre-screen response. A click needs a reason of at least five characters and writes an audit row.

- A click can pass a pre-screen score below the pass score.
- A click cannot pass a hard stop. A click cannot pass a full limit: it is refused with a message that names the limit. To send more, raise the number.
- A click cannot invite for a subject that is not hiring, or for a subject that has no head.
- A click counts toward the limits. It does not change the queue order for other candidates.
- **Send new link** is a click that works after a cancel, a no-show or No booking. It is the one permitted repeat invitation. It obeys the limits and resets the move-once count.

### Tracker rule

The tracker is read-only input for a new-flow candidate. A Recruitment Sheet or Mock Teaching Test Log change does not change the stage, subjects or contact flag of that candidate. It does not queue an email. Staff stop new-flow candidates in Hiring.

A **new-flow candidate** is one of these: a candidate to whom the app sent the form, or a candidate at `onsite_invited`, `onsite_booked`, `no_reply` or `no_booking`. A candidate at a `paper_*` stage or at `mock_booked` stays on the old flow, even if the earlier worker sent that candidate the form. The Pre-screen Responses tab stays the source of replies. The `Hiring Automation` tab keeps the mirrored data.

### Old-flow candidates

Candidates at `paper_invited`, `paper_booked`, `paper_passed` and `mock_booked` keep their stage and their existing actions. The new flow does not move them. The paper-then-mock steps still apply to them: a human records the paper pass in Hiring or in the original tracker, a later change to a tracked paper-pass record queues a mock invitation, and the old paper and mock booking links stay valid. Old-flow candidates use no place in the new limits. Their bookings still block a head's calendar. Every mock counts toward "Mocks per head, per week", old flow or new, because each one uses the head's hour.

## Visit booking

A signed, expiring link at `/hiring/book/{token}` offers the visit.

- The candidate sees the next five complete business dates, excluding today and configured closed dates. Each exam starts on the hour. The visit window starts at 10:00 and ends at 16:00 by default (editable). The last exam therefore starts at 13:00. The mock starts when the exam ends.
- The exam needs room in the office. The exam limit is the existing `paperCapacity` setting. The exam does not need the head.
- The mock hour needs the head to be in saved office hours, free in Wise, with complete leave coverage and a fresh Wise snapshot. It also needs no sit-in and no other hiring booking. The head is under the weekly limit.
- A head with an identity issue, or with a completeness issue about leave or sessions, gets no times. An availability fetch failure alone does not block, because saved office hours decide when a head is in. A final live Wise read checks the head before the booking commits.
- **How fresh the list is.** The invite email holds no times. Each time the candidate page opens (and each time the candidate returns to the tab), `readLiveBusy` reads Wise live: every class on the five business dates and each head's leave. A time shows only when the live read and the Wise copy both show the head free. The page shows "Live schedule, checked HH:MM". One server instance keeps a live read for 60 seconds. If the live read fails or takes more than 12 seconds, the list uses the Wise copy from the 30-minute sync (never older than 90 minutes) and shows no "Live schedule" line (owner decision, 11 Nov 2026). The confirm step always makes its own uncached live read, so a clash cannot be booked in either case.
- When two heads can take a subject, the server picks the head with fewer mocks that week. The candidate never chooses.
- A database transaction inserts both rows (one `paper` row with no interviewer, one `mock` row with the head, joined by `visit_id`). The overlap triggers and the sit-in protection stay in place.
- **What to prepare.** The invitation, its reminder and the confirmation tell the candidate to prepare one lesson in the visit subject from an international school syllabus (IGCSE, A Level or IB), and list syllabus links: one or two for the subject, then four general ones. The text and links are `mockPrep` in `src/lib/hiring/email.ts`; `SUBJECT_LINKS` needs an entry for every subject. Emails already queued keep their old text.
- One email holds both times. Two private Google Calendar events are created: the exam for the candidate, and the mock for the candidate and the head. The head's registered LINE group gets a notice. A booked or moved notice ends with a **candidate page** link for the interviewer (see [Interviewer candidate page](#interviewer-candidate-page)).
- **Move once.** The candidate can move the visit once through the link, up to 24 hours before it starts. A move cancels the old rows and inserts new rows linked by `reschedule_of`. Later changes go through staff on LINE.
- **Staff actions.** Staff can click **Cancel visit** (before it starts) or **Mark no-show** (after it starts). Each needs a reason and writes an audit row. Each moves the candidate to No booking (a stopped candidate stays stopped), cancels unsent messages and cancels future calendar events. **Stop** refuses while the candidate has a future appointment.
- **A Wise change after booking does not move a visit.** The calendar and the candidate row show the clash, and staff act.
- A SEEK stop on a candidate with a future visit keeps the visit and writes a note that tells staff to cancel it. The stop applies after staff cancel.
- If no times exist, the page shows the LINE contact.

## Head schedules

These open from the Calendar switch in **4 Mock and paper**.

The **Head schedules** view shows one head's Monday-to-Friday week at a time. A head switch and a week switch choose what to show. The week switch starts at the current week and cannot go back, because Wise omits past sessions. For each day the view shows the head's office hours, Wise classes, leave, sit-ins, exams and mocks. A list shows that head's visits. No student name reaches the page. Only a mock and an exam block name the candidate.

A mock that overlaps a Wise class, leave or sit-in is a clash. The calendar and the candidate row show it. An old or missing Wise snapshot sets a stale warning. The warning never hides the week.

The data comes from `GET /api/hiring?head={canonicalKey}&weekStart={date}`.

## Rules and setup

The **Rules and setup** view holds:

- Profile weights, the invitation threshold and the HR call score.
- The automation switches: Automation and Messages. The save bar warns before a save starts sending.
- Pre-screen email rules: the four limits, the reminder day and the no-reply day.
- Onsite invitation rules: the pass score, the four limits, the reminder day, the link expiry day, and the visit window.
- Pre-screen score weights (total 100).
- Hard stops, and the accepted SEEK work-rights answers.
- Subject priority, with a hiring switch for each subject.
- Head office days (Monday to Friday) for each head, and the résumé retention months.
- Mock interviewers, universities and the connections.

A stored setting that breaks a rule stops the worker with a message. The page still loads so a save can repair it.

**Head days.** A head enrolled in Tutor Attendance uses that schedule. Saving head days writes a new schedule version there, effective from the next Bangkok day. This also changes the head's attendance expectations. It needs Tutor Attendance admin access. A save is refused when Tutor Attendance has a later-dated schedule, because a save copies the newest version and could undo it. A head who is not enrolled (Gift) uses a fallback week saved in Hiring settings. That choice avoids starting attendance tracking for Gift. A head with no saved hours gets no visit times, and Rules shows a warning. Removing a day does not move booked visits. The notice gives the count and says staff must act.

## Résumé files

- **SEEK can lock the download.** On some job ads, SEEK shows the résumé but replaces **Download document** with **Upgrade to download** (a paid SEEK upgrade). The new ad 95633167 does this; the old ad 94844236 does not (checked 4 Nov 2026). Then the worker gets no file and no résumé text, and the score uses the SEEK profile only. The worker counts these people and the Operations rail says "SEEK asks for an upgrade to download N new résumés". Read them on SEEK. The backfill marks them `locked` and does not read them again. After a SEEK upgrade, ask Claude to add a retry for `locked` rows (audit `seek-backfill`, `file: "locked"`).
- The worker keeps the original file when it reads a SEEK profile and uploads it to private Vercel Blob. The Mac holds no Blob key. A signed internal route gives a 5-minute upload token for one exact path.
- A PDF opens in the panel. A Word file (DOCX) downloads. The old `.doc` format is refused. The file type comes from the file bytes. Existing limits stay: 15 MB and 30 pages.
- A signed-in admin with Hiring access can open a file through `GET /api/hiring/resume/{id}`. The only other way is the interviewer's link for one confirmed mock (see [Interviewer candidate page](#interviewer-candidate-page)). Both use `resumeResponse` in `src/lib/hiring/resume-files.ts`, so the headers are the same. The route reads only the stored path and sends `no-store`, `nosniff` and a sandbox header. The AI reads only redacted text.
- **Retention.** A daily Vercel cron deletes a file after 12 months with no candidate activity. The number is editable (1 to 120 months). Only the file goes. The extracted text stays. Activity is the latest of the stored time, the pre-screen reply, a confirmed booking's end, and the newest audit row. Audit rows from the scoring, worker and backfill passes do not count as activity. Lowering the number can delete many files at the next nightly run. The panel then says the file was deleted by the retention rule.
- **Open decision: links inside a PDF.** A crafted link in an applicant's PDF can replace the whole browser tab with another site after one click. Script does not run. The panel shows a warning line for now. The other options are to open a PDF in a new tab, or to render PDFs with pdf.js (a new dependency). Kevin has not decided. He must decide before go-live.
- The files hold phone numbers, birth dates and photos. Access control, `no-store` and retention are the controls.

## Interviewer candidate page

The interviewing tutor has no sign-in to Hiring. The head's LINE notice for a booked or moved mock ends with `Candidate page (answers and résumé): {link}` (Kevin's decision, 12 Nov 2026).

- **Page.** `/hiring/brief/{token}` shows the candidate's name, the subject, the exam and mock times, the interviewer, the place, the pre-screen answers in reading order, and one button that opens the résumé in a new tab (a PDF opens; a Word file downloads). It shows no email, no phone and no AI score. The answer labels are `ANSWER_LABELS` in `src/lib/hiring/model.ts`, shared with the admin panel.
- **Access is the link and nothing else.** The token is signed like a booking link, with kind `brief` and the **mock booking's id**. `briefView` (`src/lib/hiring/service.ts`) opens it only while that booking is a confirmed mock. Anyone who holds the link can open the page until it ends, so the notice goes only to the head's registered group.
- **When the link ends.** 7 days after the mock ends; at once when the visit is cancelled, moved (the new booking gets a new link in the moved notice) or marked a no-show; and at once when the candidate is stopped or a result (Hire or Reject) is sent, because a past mock stays `confirmed`. Every failure shows one message on the page, and the file route returns one plain 404 for every refusal.
- **File.** `GET /api/hiring/brief/{token}/resume` checks the same token, then streams the stored original. A file removed by the retention rule shows as "No résumé file is stored".
- **Public routes.** `src/proxy.ts` allows exactly `/hiring/brief/{token}` and `/api/hiring/brief/{token}/resume`, with `no-store`, `no-referrer` and `noindex`. Booking links and old-flow links do not open the page, and the page link does not open a booking.
- **Not included.** No record of each open, no button to end one link by hand, and no link in the recruitment group's notices (HR has the Hiring tab).

## Backfill passes

These passes print counts only. They never print names, emails or file names. Each pass that writes refuses to run while Automation or Messages is on. No pass sends a message or changes a stage.

`npm run hiring:backfill -- --seek` needs `HIRING_BACKFILL_UNTIL` (an ISO stop time in the future) and `HIRING_WRITES_ENABLED=true`. `--limit N` reads at most N candidates. The pass opens each known candidate's SEEK page and stores the exact work-rights answer and the original file. It imports nobody. It reads every SEEK job in Rules, active or not, because an expired ad still lets us download its résumés. It takes the worker lock, so a running worker (including a paused `--watch` worker) blocks it. It pauses 10 seconds between candidates. All seven folders take about 3 to 4 hours. A candidate that is already read is skipped on a re-run. A failed download is retried on the next run. A file that can never be read (`.doc`, over the page limit, encrypted) is marked and not retried. Five unreadable candidates in a row stop the pass, because SEEK may be signed out or the page may have changed. A different answer replaces the stored one and is never accepted automatically. The summary has `stoppedEarly`. The pass is finished only when the process exits with code 0 **and** `stoppedEarly` is `false`.

`npm run hiring:backfill -- --tracker-report` reads the tracker and the app, and writes to neither. It prints how many people on the Sourcing Log and the Scheduling Responses tabs are missing from the app. `--tracker-import` then adds them: stage `review`, earlier contact set, no text, no score and no email queued, keyed by email so a re-run adds none. The `Hiring Automation` tab holds at most 2,000 candidates, so check the report first. Both tabs must have their email column, and the Sourcing Log must have its "Send email to invite" column, or the pass stops with a message.

The report also prints `alreadyContactedAtNew`: people at `new`, not marked as contacted, whom the tracker shows as already emailed. That means a row on Scheduling Responses, or a Sourcing Log row with a value in the invite column. A Sourcing Log row without that value only records a view. `--tracker-mark-contacted` marks those rows as contacted, with one audit row each under the `hiring-backfill` actor, so the queue sends them no form. It needs `HIRING_WRITES_ENABLED=true`, as `--tracker-import` does. It writes only the contact flag: no outbox row, no stage, no revision and no `updated_at`, because each release locks and rereads the row. A rerun marks none. Kevin approves this pass separately, because it changes who enters the queue.

### Past results

`npm run hiring:backfill -- --tracker-results-report` reads the tracker and the app, writes nothing, and needs no write setting. It prints counts only, including how many matched people hold a booking. `--tracker-results-import` stores the tracker's past paper and mock results with source `tracker`.

- It reads Recruitment Sheet Q, T to V and Mock Teaching Test Log D to I. It joins on Applicant ID, then email. A moved column stops the pass.
- One outcome covers a whole tracker row, so someone who passed Maths only and sat Maths and Physics stores Physics as "Not listed as passed".
- It changes no stage, writes no old-flow pass, and queues nothing. A rerun refreshes or removes only its own rows, and never a result from this website.
- A new visit's upload replaces a past result for that subject. The old values stay in the audit row.

## Implementation and protection

- Tables: `hiring_settings`, `hiring_candidates`, `hiring_bookings`, `hiring_outbox`, `hiring_audit`. Migration `0118_hiring_automation.sql` created them. Migration `0119_hiring_visit_automation.sql` adds four stages (`onsite_invited`, `onsite_booked`, `no_reply`, `no_booking`), removes the fixed Monday–Friday 10:00–16:00 window from the mock check (the slot code and the settings keep their own window), adds `no_show` to the booking status, adds `visit_id` and `reschedule_of` to bookings, and adds the work-rights answer, visit subject, reply and résumé columns to candidates. See [the database reference](../reference/database/index.md#tutor-hiring--migrations-0118-and-0119).
- Admin: `/hiring`, `/api/hiring`. Current admin session and page scope are required. See [the API reference](../reference/api/misc.md#tutor-hiring).
- Worker delivery: `POST /api/internal/hiring-delivery`. A short-lived HMAC binds the complete request body to the existing application secret. The route rejects preview environments. Email and LINE keys stay in Vercel; they are not exported to the Mac. Test mail and Calendar entries address only the configured organizer; a LINE test requires the organizer's confirmed personal user ID and rejects group IDs.
- **Where each message leaves.** Booking messages (confirmation email, Calendar events, LINE notices) leave from Vercel, straight after the booking or the staff action, and again from a cron that retries. Invitations and reminders leave from the Mac worker's cycle, because they wait for the worker's SEEK check. Delivery sends nothing unless Automation, Messages and the write gate are all on.
- **One-candidate booking test.** `bookingTestCandidateId` defaults to `null`. An owner can set one candidate UUID through the audited settings service to let only that candidate use a valid visit link while Automation is paused. The exception applies to visit booking and moves, not intake, scoring, queues or delivery. Rubric approval, the write gate, link expiry, availability, limits and the final transaction check still apply. Clear the ID to end the test. Messages remain queued while Automation or Messages is paused.
- Crons: `hiring_delivery` (`19,35,48,59 * * * *`) and `hiring_resume_retention` (`28 20 * * *`). See [the cron reference](../reference/crons.md#hiring-jobs).
- Candidate: `/hiring/book/{token}`, `/api/hiring/book/{token}`. HMAC verification, expiry and stage checks protect access. No contact details or other candidates are returned. Responses prohibit caching and referrer disclosure. The token kind (`paper`, `mock` or `visit`) selects the old or the new flow.
- Google consent uses the existing Auth.js sign-in flow and registered callback. It requests Calendar and Sheets access for the configured organizer and keeps the existing Drive grant. The existing account validation, encrypted token store and refresh code are reused.
- Booking triggers share the existing sit-in observer lock and check overlap in both directions. Candidate overlap is also rejected. Adjacent appointments are allowed.
- **Candidate email leaves from admin@begiftededucation.com** through the Workspace Gmail grant that Class Feedback connected (audience `candidate` in `src/lib/email/outbound.ts`). There is no fallback: no Resend, and never the Apps Script relay, which sends as a personal account. A Gmail rejection marks the row failed and it retries. Gmail has no idempotency key, so an email row whose acceptance is uncertain is never retried automatically. An error before the Gmail call marks the row failed, so it retries. To clear an uncertain row, look for it in the admin@ Sent folder. If it is there, set that `hiring_outbox` row to `sent`. If it is not, set it to `failed` so the next delivery retries it. Each is a one-row update that Claude runs with Kevin's OK. Emails use the BeGifted 4.0.0 email shell (`src/lib/hiring/email.ts`, vendored renderer in `src/lib/company-emails/`), with a plain-text part from the same facts. A person's edited Hire or Reject text gets the same shell. Calendar invitations come from the Google organizer in Rules (`connectedEmail`). LINE uses each tutor's current bot route and enabled group registration; the existing `PROGRESS_LINE_TUTOR_BOT_KEYS` pilot list selects the dedicated tutor bot. Calendar uses a stable event ID and verifies its private booking marker before reuse.
- Jobs retain provider receipts. An uncertain LINE send reuses its original key only within the provider's retry window; it is held after 23 hours. An uncertain email is held at once (see below). Unsent invitations for a stage already completed are cancelled. Provider acceptance and recipient delivery remain distinct.
- Unverifiable AI evidence holds only that candidate for review. It is not retried unchanged on each cycle. Confirmed appointment messages run before source intake, so a SEEK or AI connection failure does not hold those messages.
- A cycle starts no new assessment after 10 minutes. A large backlog takes more than one cycle.
- `HIRING_WRITES_ENABLED=true`, enabled settings and approved rules are all required for autonomous processing. Preview environments cannot enable writes. Delivery has its own pause switch.

### SEEK campaigns

A campaign is one SEEK job ad. **Rules and setup → SEEK campaigns** holds up to five, each with a job ID, a name and an **Active** box. The job ID is the number after `jobid=` in the SEEK candidates address.

- Each cycle reads every active job, in list order. All jobs share one budget of 40 new imports per cycle and one set of known application IDs.
- An inactive job keeps its candidates. The worker does not read it, so status changes in SEEK for those candidates are not seen.
- Each new row stores the job it came from (`hiring_candidates.seek_job_id`). The SEEK link opens that job. Rows from before campaigns carry `94844236`.
- The same person in two jobs is one row, matched by email. The row keeps the first job, and both application IDs are in `source_ids`.
- With more than one job, Seek intake shows coverage cards per campaign, the campaign name on each row and a campaign filter. Overview keeps the totals.
- A config saved before campaigns has one `seekJobId`. It reads as one active campaign. The next save stores the list.
- A page error in one job stops the whole cycle, as it did with one job: scoring, follow-ups and delivery wait until it is fixed or the job is set inactive. Imports already saved stay.
- **Release order for this change:** apply migration `0122`, then deploy, then update the Mac checkout, before anyone saves Rules. An old worker refuses the new config shape, and the first new work-rights answer also stores it.
- The rules are the same for every campaign. One profile threshold, one pre-screen form and one set of limits apply to all jobs.

## Setup

Use a checked release checkout. Do not apply migrations or send live messages from a development test. The ordered release steps are in [Go-live](#go-live).

1. Connect Google. In Hiring, select **Connect Google** and grant Calendar and Sheets access using the configured organizer account. The existing application callback is reused; no new Google Cloud redirect URI is needed.
2. Review the interviewer identities, email addresses, active LINE groups, closed dates, weights, limits and thresholds. Confirm a real test recipient for each delivery channel.
3. Use Node.js 24. From the release checkout, run `npm run hiring:worker -- --connect-seek` once and sign in to SEEK in its separate profile. It opens the first active campaign. That profile is stored under `~/.bgscheduler-hiring/seek-profile`, not in Git.
4. To run without an open terminal, use the [macOS LaunchAgent template](../operations/hiring-worker.plist.example). Replace its five path placeholders with the release checkout, Node.js 24 executable and bin directory, Claude CLI bin directory, and user home. Ensure `~/.bgscheduler-hiring` exists. Install the reviewed file as `~/Library/LaunchAgents/com.begifted.hiring.plist`, validate it with `plutil -lint`, then load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.begifted.hiring.plist`. Use `launchctl bootout` with the same domain and path to stop it. The template contains no secrets; the worker reads the release checkout's protected environment file.

`--watch` runs one cycle at a time, with 15 minutes between cycles. Each cycle runs in this order: deliver booking messages, read SEEK, sync the tracker, score, run follow-ups, release the queues, mirror the tracker, and deliver the rest. It uses the owner's Claude Code subscription and refuses API-key authentication. No model API-key spend is introduced. It queues decisions in Postgres and asks the production delivery endpoint to send messages using Vercel's existing private keys. The Mac needs the production database, application signing secret and source-read credentials, but no Resend or LINE sending keys. The owner machine must remain awake, connected and signed in; Vercel cannot run the subscription CLI. The worker records its last successful source counts and any failure in Hiring. The page warns when Automation is on and the worker last ran more than 60 minutes ago. Booking links still work then. The LaunchAgent starts at login and restarts a stopped worker. Keep the release checkout and its protected environment file while the agent is installed.

## Go-live

Each step needs Kevin's approval. The step says who acts. Do the steps in order. Do not skip a step.

Where the work stands: local checks passed on the five pull requests. Merge, migration, deployment, live delivery and acceptance are separate steps. None of them has happened. An approval for one step is not an approval for the next.

**Merge rule for PR B to PR E.** The five pull requests are a stack, and only PR A targets `main`. So today only PR A has run the five required CI checks. As each lower pull request merges, Claude retargets the next one to `main` with `gh pr edit <number> --base main`. The five required CI checks must then pass on it. A pull request that changes `drizzle/`, `scripts/`, `vercel.json`, `package.json` or another path in `.github/CODEOWNERS` (such as `src/lib/db/` and `src/app/api/internal/`) also needs Kevin's code-owner review. Do not bypass branch protection.

1. **Merge PR A (#241).** Who: Claude merges after Kevin approves. PR A changes only what `/hiring` shows. It has no migration.
2. **Apply migration `0119` to production, read it back, then merge PR B (#242).** Who: Claude applies and reads back after Kevin approves. Kevin approves again before PR B merges.
   - Before the apply, check that `select max(created_at) from drizzle.__drizzle_migrations` returns `1793404800000` (migration `0118`). Then only `0119` applies. If it returns another value, stop and tell Kevin.
   - Apply only `0119`. Do not apply other pending migrations.
   - Read back: the ledger has a row with `created_at` `1793491200000` (the journal entry `0119_hiring_visit_automation`). `select conname, pg_get_constraintdef(oid) from pg_constraint where conname in ('hiring_stage','hiring_mock_window','hiring_bookings_status_check')` shows the four new stages, no weekday or time terms in `hiring_mock_window`, and `no_show` in the status check. This work-rights backfill check returns 0:
     ```sql
     SELECT count(*) FROM hiring_candidates WHERE work_rights_confirmed IS TRUE AND work_rights_answer IS DISTINCT FROM 'I have permanent work rights with no restrictions';
     ```
   - Merge PR B only after the migration is applied. The new code selects the new columns.
   - **Rollback warning.** After the first settings save on the new code, the old code's strict check rejects the new settings keys. To go back, remove these keys from `hiring_settings.config`: `preScreenLimits`, `onsiteLimits`, `preScreenFollowUp`, `onsiteFollowUp`, `preScreenThreshold`, `preScreenWeights`, `acceptedWorkRights`, `seenWorkRights`, `subjectPriority`, `visitStartMinute`, `visitEndMinute`, `resumeRetentionMonths`. The exact SQL is in the description of PR B (#242). The Codex task `CW-20261101-hiring-university-seed` must rebase after PR B merges, for the same reason.
3. **Merge PR C (#243) and PR D (#244) in that order.** Who: Claude merges after Kevin approves each. Vercel deploys each merge. Automation and Messages stay off. PR C holds the queue and the visit. PR D holds the screens.
4. **Save Gift's hours on the Rules page, straight after PR D deploys.** Who: Kevin, or Claude with Kevin watching, in Rules and setup under Head office days. Tick Monday to Friday for Gift and save. A day you add gets 10:00 to 16:00. Do this before any pass and before Automation. Gift is the only head for 11 subjects, and Gift is not enrolled in Tutor Attendance, so these saved hours are the only source of Gift's hours. Until they are saved, an old-flow mock link for a Gift-only subject shows no times and gives the LINE contact. Today one candidate is at `paper_passed`. If Gift is missing under Mock interviewers, add Gift, save the rules, then set the days.
5. **Merge PR E (#245).** Who: Claude merges after Kevin approves. Vercel deploys it. PR E holds the résumés, the passes and this page. The résumé upload route lives here, so deploy PR E before the SEEK pass.
6. **Install Node 24.** Who: Kevin approves the install, then Claude runs `brew install node@24`. Then `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run hiring:worker` must print the usage text. The worker refuses to run below Node 24, so this must be done before switching on, and before step 7 can use `--connect-seek`. Run every command below with this `PATH`.
7. **Test the SEEK pass on 5 candidates.** Who: Claude runs it on the Mac after Kevin approves.
   - Run every pass from the release checkout: `/Users/kevinhsieh/Developer/Scheduling`, on `main`, at the commit that holds PR E. Keep it on `main` while the passes and the worker agent run. The passes read `.env.local` in that folder (a `.env.production.local` there takes priority). Check that its `DATABASE_URL` names the production database. Print the host only.
   - Run `launchctl list | grep begifted`. Expect no output. A line means that an agent is already loaded, possibly an old one from `.codex/worktrees/hiring-automation`. It would run old code and hold the worker lock. Stop and tell Kevin. Kevin must not start that agent.
   - If SEEK is signed out, run `npm run hiring:worker -- --connect-seek` first and sign in.
   - Stop any paused `--watch` worker first. It holds the worker lock, and the pass cannot start while it runs.
   - Run `HIRING_WRITES_ENABLED=true HIRING_BACKFILL_UNTIL=<ISO time> npm run hiring:backfill -- --seek --limit 5`.
   - Check the counts: `read` is 5, `filesStored` is near 5, and `readFailed` is 0.
   - Check those 5 rows in the Hiring panel. The table row has a **Résumé** button. The panel section **Original résumé** must not say "(no file yet)". A PDF must show in the frame, and a Word file must show **Download**.
   - Read the real labels on the SEEK page. The pass looks for a button or tab named "Resumé" (one accent, SEEK's spelling) and a button named "Download document". If `read` is 5 but `filesStored` is 0, SEEK may use different labels. Stop and tell Claude.
8. **Run the full SEEK pass.** Who: Claude runs it after Kevin approves. Use a stop time about 5 hours ahead. Expect 3 to 4 hours. The pass is finished only when the process exits with code 0 **and** the summary says `stoppedEarly: false`. If it stopped early, or the SEEK list changed while it ran, run the same command again. It skips candidates that are already read. Read the summary: `newWorkRightsAnswers` lists how many new answers appeared. Each new answer shows in Rules as not accepted.
9. **Run the tracker report.** Who: Claude runs `npm run hiring:backfill -- --tracker-report`. The report writes nothing. The `Hiring Automation` tab holds at most 2,000 candidates. If the current number of candidates (654 on 1 November 2026) plus the `sourcing` and `scheduling` counts is over 2,000, stop and tell Kevin. Run `HIRING_WRITES_ENABLED=true npm run hiring:backfill -- --tracker-import` only if Kevin approves the counts. The import refuses to run without that setting.
   - Read `alreadyContactedAtNew` in the report. It counts people at `new`, not marked as contacted, whom the tracker shows as already emailed: a row on Scheduling Responses, or a Sourcing Log row with a value in its "Send email to invite" column. A Sourcing Log row without that value only records a view, and does not count. These people can get a repeat form until they are marked.
   - If Kevin approves, run `HIRING_WRITES_ENABLED=true npm run hiring:backfill -- --tracker-mark-contacted`. It marks exactly those rows, with one audit row each. It adds no outbox row and changes no stage, revision or `updated_at`. It prints `marked`, and a rerun marks none. On the first live cycle, a marked person who has a profile score moves to Review.
10. **Score the held responses and write the short lines.** Who: Claude runs both on the Mac after Kevin approves. Automation and Messages must be off. "Rubric approved" must stay ticked on Rules and setup. It was on when read on 2 November 2026, and without it these passes refuse or discard their answers.
   - `HIRING_WRITES_ENABLED=true HIRING_SCORE_UNTIL=<ISO time> npm run hiring:score -- --pre-screen`. Expect about 80 to 120 model calls.
   - `HIRING_WRITES_ENABLED=true HIRING_SCORE_UNTIL=<ISO time> npm run hiring:score -- --briefs`. Expect about 650 to 800 model calls and about an hour.
   - Each pass uses Kevin's Claude subscription allowance, so set a stop time on each. `--briefs` refuses to start without `HIRING_SCORE_UNTIL`.
   - A pass is finished only when its last line says `complete` is `true`. Exit code 2 means it did not finish: some answers were not stored, or the stop time or a signal cut it off. Run the pass again. It skips stored rows.
   - The `--pre-screen` summary prints `invalidPreScreenRows`. If it is not 0, run `HIRING_WRITES_ENABLED=true HIRING_SCORE_UNTIL=<ISO time> npm run hiring:score -- --pre-screen --retry-invalid`. Each such row can take up to 3 attempts.
   - After the Codex task `CW-20261101-hiring-university-seed` lands the university seed, run `HIRING_WRITES_ENABLED=true HIRING_SCORE_UNTIL=<ISO time> npm run hiring:score`. It makes no model call for a row with an unchanged text hash, and only recomputes the university result. A row with new or changed text makes a call.
11. **Kevin decides about the PDF link.** Kevin chooses to keep the warning line, to open PDFs in a new tab, or to render with pdf.js (see [Résumé files](#résumé-files)). Claude makes any code change as a new pull request.
12. **Kevin reviews the scores and sets the rules.** Who: Kevin, in Rules and setup. Kevin reads the spread of the pre-screen scores and sets the pass score. Kevin ranks the subjects and sets each head's days. Kevin ticks the SEEK work-rights answers he accepts. Kevin checks the limits.
   - Claude first gives Kevin a read-only count of responders with no SEEK link: `select count(*) from hiring_candidates where pre_screen is not null and seek_application_id is null and jsonb_array_length(source_ids) = 0`. A click cannot invite them. They have no SEEK work-rights answer, and a missing answer is a hard stop.
13. **Count before the switch.** Who: Claude, read-only, then reports to Kevin. Count the rows that would leave `new` for review at the first cycle. Count the tracker rows whose hash changed. On 2 November 2026, 6 of 335 `new` candidates would move to review for a `not_met` degree. The 2 candidates at `pre_screen` may go to No reply on the first cycle, with no reminder, because their sends are old. People marked in step 9 who have a profile score also move to review. Kevin approves the counts.
   - Count the unsent rows, read-only: `select count(*) from hiring_outbox where status in ('pending','failed','uncertain')`. Unsent rows from clicks leave together at switch-on, up to 20 per delivery call, with one delivery call per worker cycle. Kevin decides per row. A stage change or a stop on the candidate cancels a row before it leaves.
14. **Kevin turns on Automation and Messages.** Who: Kevin in Rules and setup. Messages needs the organizer's Google Calendar connected, or the save is refused. The save bar shows how many forms a day and a week the limits allow. Then Claude runs `HIRING_WRITES_ENABLED=true npm run hiring:worker -- --once` on the Mac. Claude checks every recipient against the limits and checks the provider readbacks.
   - The first cycle writes the `Hiring Automation` tab. If that first write fails, the cycle stops before it asks for delivery. Forms and invitations stay pending, so this is safe. The error shows in Hiring. Fix the cause and run the cycle again.
15. **Load the worker agent.** Who: Claude, after step 14 passes and Kevin approves. Install the LaunchAgent from the template (see [Setup](#setup)). The agent has no write setting of its own and reads the same `.env.local`, so that file must hold `HIRING_WRITES_ENABLED=true` before the agent loads. Kevin approves that change.

### Controlled first send

Use this to send one pre-screen form and nothing else, for example to test a new campaign.

1. Turn Automation on and keep Messages off. Run `HIRING_WRITES_ENABLED=true npm run hiring:worker -- --once`. The cycle reads SEEK and scores. Queues, follow-ups and delivery wait for Messages, so no email leaves.
2. Pick one candidate. Click **Invite to pre-screen**. The form row stays `pending`.
3. Turn Messages on. Run `HIRING_WRITES_ENABLED=true npm run hiring:worker -- --send-one <candidate id>`. Turn Messages off at once.

`--send-one` takes the worker lock. It refuses unless the candidate is at `pre_screen` and its form row is `pending`. It also refuses while any other outbox row is unsent (`pending`, `failed`, `uncertain` or `processing`), and names those rows. While Messages is on, the 15-minute delivery cron, any dashboard action and a candidate booking can send a waiting booking row, so step 3 must start with none. It asks the delivery endpoint for that one row (`mode: "one"`, which accepts only a `<id>:pre-screen` key). It reads no source, scores nothing, runs no follow-up and releases no queue. It prints `sent` and the row status. Do not send a decision email from the dashboard while Messages is on for this step.

## Go-live for the revamp

Do these in order. Each step needs Kevin's approval. Automation and Messages can stay off throughout.

1. **Apply migrations, before merge.** Done on 2 November 2026, and read back. `/hiring` returns 503 without them, because the dashboard reads the new tables.
2. **Merge #246 to #254 in order.** Who: Kevin. Stacked pull requests start required CI only when based on `main`, so retarget each one and close and reopen it.
3. **Check the page.** Who: Claude, signed in, on production or the preview: all five tabs, the Back button, a filter, and opening a resume. The offline check replaces `next/navigation`, so this is the first real check of tab addresses. Open one real PDF in the frame.
4. **Update the Mac checkout before anyone saves settings.** The config schema is strict, so older code refuses a saved `paperPassRules` key. For the same reason, a Vercel rollback after a settings save needs a config repair. An old worker process also ignores the drag order, so restart it.
5. **Create the OpenRouter key.** Who: Kevin.
   1. Go to [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) and click **Create Key**.
   2. Name it `BGScheduler hiring marking`. Set **Credit limit** to `30`, and set **Reset limit every** to **Month**. Click **Create**, and copy the key.
   3. Go to vercel.com, open the **bgscheduler** project, then **Settings**, then **Environment Variables**.
   4. Key: `OPENROUTER_HIRING_API_KEY`. Value: the key. Tick **Production** only. Click **Save**.
   5. Open **Deployments**, open the top deployment's menu, and click **Redeploy**.
6. **Run the technical check.** Who: Kevin runs it, so the key stays off the chat. It uses a made-up paper, and it costs one marking run. It proves the route reads a scan and measures the cost. It is not an accuracy test. In the release checkout, run `read -s OPENROUTER_HIRING_API_KEY && export OPENROUTER_HIRING_API_KEY`, paste the key, press Return, then run `npx tsx scripts/dev/check-hiring-marking.ts`. Send Claude the printed result. If the cost per paper is far from the estimate of $0.50 to $2, review the $30 cap and `HIRING_MARKING_MODEL`.
7. **Fill in the settings.** Who: Kevin and the heads, in Rules and setup: the pass percentage for each subject and level, and the question paper and mark scheme for each subject. The Drive holds old versions. For example, the Math mark scheme dates from 2024 and the paper from 2026. Claude can prepare a list of which Drive file goes with which subject. Export Word and Google Docs files to PDF first.
8. **Import past results.** Who: Claude runs `--tracker-results-report` and sends Kevin the counts. After Kevin approves, Claude runs `HIRING_WRITES_ENABLED=true npm run hiring:backfill -- --tracker-results-import`. Automation and Messages must be off for this pass.
9. **Read the result emails.** Who: Kevin. Read `resultEmail` in `decisions.ts`, or a draft on the screen. Result emails can leave only after [Go-live](#go-live) turns on Automation and Messages.

The new columns on the `Hiring Automation` tab stay empty until Automation is on, because the worker writes that tab.

## Checks

`node scripts/dev/verify-hiring-screens.mjs [screenshot-folder]` drives the real screens in Chrome with made-up candidates. It uses no server, database or credentials.


Run these local checks from the checkout:

```sh
npm test -- src/lib/hiring src/__tests__/middleware.test.ts
npm run test:integration -- src/lib/hiring
npm run verify:release
```

The integration suites are `workflow`, `queue`, `resume-files` and `backfill` under `src/lib/hiring/__tests__/`. They cover source and email deduplication, the application-to-visit path, concurrent queue releases and clicks on separate connections, manual SEEK contact, competing reservations, a revoked pass during the live check, sit-in conflicts, uncertain delivery retries, résumé storage and retention, and silent backfill (before-and-after counts show no stage change and no outbox row). They use a disposable PostgreSQL database and mocked external providers. A separate Calendar test checks event creation, both attendees and recovery without a duplicate.

The local checks passed for the five pull requests. Their descriptions list the results and the Node 22 note. These checks do not prove live receipt, browser extraction for every SEEK folder, a signed-in page with production data, full university-rank coverage, or scoring quality on independently marked historical cases. Nothing has run against SEEK, real Blob storage or a real Sheets write. The reference catalog initially contains the publisher's verified global top ten and the three named Thai universities. Other exact ROR matches can establish country; an unverified rank earns no ranking points.

## Limits

These are explicit operating limits, not completed acceptance checks.

- The Mac must stay awake and signed in to SEEK and to Claude. When it stops, intake, scoring and new invitations stop. Booking links, booking messages and the retention job keep working.
- "Native" counts as C2 on the candidate's own claim. The exam and the mock are the next check.
- Visits take 3 hours. Wise classes, leave and caps can leave few times, especially for Chemistry, which has one head. The booking page shows the LINE contact when it has no times.
- A later Wise change does not move a confirmed visit. The clash shows, and staff act.
- Changing a head's days in Hiring changes Tutor Attendance for an enrolled head.
- The Data Health manual **Run** button for booking delivery reports `sent: 0` when an error occurs inside the run. The cron retries.
- Visits happen on weekdays only. A visit tests one subject only.


### HR and recruitment notices

All candidate hiring emails copy `people@begiftededucation.com`. Mock calendar events invite that inbox and `admin@begiftededucation.com`, in addition to the candidate and head. Existing event updates preserve attendees and responses.

In **BeGifted Recruitment**, a LINE schedule-bot admin can send `@Thea recruitment setup`. The signed tutor-channel webhook verifies the group name and saves its ID in Hiring settings. This does not change Thea's other group bindings. No candidate data goes to an unregistered group.

Thea posts when a mock is booked, moved or cancelled. On Mondays at 09:00 Bangkok, starting 16 November 2026, Thea lists initial pre-screen emails recorded as sent in the previous Monday–Sunday and confirmed mocks in the current Monday–Sunday. Reminders and failed or uncertain sends are excluded. Empty sections say “None”. Long reports have numbered parts.

The `hiring_recruitment_deliveries` ledger stores each part, its retry key, status and receipt. The Monday `/api/internal/hiring-recruitment` cron queues the summary; the existing hiring-delivery cron retries notices. Both hiring switches and the production write gate must be on to send. Unknown outcomes keep the same LINE retry key; after 23 hours they need review. A changed group or cancelled booking suppresses old notices. Migration: `0127_hiring_recruitment.sql`.


Thea also posts a short notice when a completed pre-screen response is imported after a confirmed form send, and when a mock/onsite invitation email is accepted by Gmail. Each completed form is announced once per candidate; each invitation is announced once per sent email. Changed answers, unchanged imports, reminders and failed or uncertain sends do not create another notice. Booking notices remain separate. These notices use the same recruitment delivery ledger and retry cron.

**Contact line.** Each notice about one candidate prints `Email: …` on its own line, or `Email: not recorded`: the head's group notice, and the recruitment group's mock, form and invitation notices (`contactLines` in `src/lib/hiring/recruitment.ts`). The Monday summary does not. Notices already queued keep their old text. Form notices wait for the response sync; they do not wait for scoring.
