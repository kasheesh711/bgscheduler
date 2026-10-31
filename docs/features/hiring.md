# Tutor hiring

Status: deployed. The Hiring workspace opens on a one-screen Pipeline view: summary figures, stages, score distribution, profile evidence, subject supply, the candidate table and worker, delivery and activity status. The **Rules and setup** view holds the configuration.

The Hiring workspace follows a candidate from a SEEK application to an onsite mock teaching appointment. A human still marks the paper assessment. The automation offers mock teaching only after a recorded pass. It does not make a final hiring decision or send rejection messages.

Open a candidate to read the full extracted profile and résumé text. The text is loaded separately from the candidate list and keeps the extraction's personal-detail redactions. Text unavailable in the source is shown as unavailable.

For review before activation, keep processing and messages paused and run `npm run hiring:score` on the owner Mac with `HIRING_WRITES_ENABLED=true`. This uses four concurrent Claude subscription calls to score separate stored profiles in all stages. It preserves stages and does not queue or send invitations. The command resumes from stored source hashes and stops when no unscored source remains. Set `HIRING_SCORE_UNTIL` to an ISO timestamp to stop model calls at a deadline. It does not enable live hiring. Scores appear as each assessment completes; review scoring does not update the live worker's last-run timestamp.

## Source findings — 31 October 2026

The [recruitment tracker](https://docs.google.com/spreadsheets/d/12bXS1Fnx0BTwrSZXzMU7fWzOgTDfA6-P6rT0v1zDF3M/edit) has 11 tabs. The reviewed ranges contained 84 sourcing records, 83 pre-screen responses, 81 main candidate records, 30 scheduling responses and 12 subject-level mock records. These include test records; they are not counts of active candidates.

The [current SEEK job](https://th.employer.seek.com/candidates/?jobid=94844236) is expired. Its page showed 637 applications: Inbox 362, Prescreen 45, Shortlist 72 and Not Suitable 158. The original page was filtered to Inbox. An Inbox-only export must not be described as all 637 applications. The worker checks counts and pagination across all seven status folders. It imports profiles from Inbox, Prescreen and Shortlist. It tracks manual status and contact changes for known candidates without reviving candidates in Not Suitable or Accept.

| Stage | Evidence | Current operation |
|---|---|---|
| CV review | Sourcing Log, columns L–N | Human High/Mid rating and Yes/No decision; no numeric rubric is stated. |
| Pre-screen invitation | Message Templates, E1 | Email links to the existing Google questionnaire. |
| Pre-screen assessment | Pre-screen Responses, T–W | 33 Qualified, 39 Manual Review, 11 Not Qualified. These are script-produced categories, not numeric scores. |
| Human decision | Recruitment Sheet, L | Gift records Qualified, Unqualified or Hold. |
| Paper scheduling | Scheduling Responses; templates P1–P4/C1–C3 | Collect broad days and time periods; Mimi confirms the time. Two hours per subject. |
| Paper result | Recruitment Sheet, T–V | A human records the outcome, passed subjects and levels. |
| Mock scheduling | Mock Teaching Test Log, E–F; template PP1 | A separate appointment for each passed subject; one-hour choices. The candidate prepares an IGCSE topic and an interviewer-selected topic. |
| Assessment/hiring | Mock Teaching Test Log, G–I; later templates | Outside this implementation's decision scope. |

The old pre-screen output indicates a completed bachelor's degree, related study and English at B2 for most subjects or C1 for English teaching. Experience, missing English evidence and teaching availability also produce flags. Exact script source and a full subject-to-degree rule table were not available; observed categories must not be treated as a validated algorithm.

Two recorded defects need correction in the replacement logic: `Native` can be labelled below B2/C1, and a combined `Bachelor's, Master's` answer can be labelled below a bachelor's degree. The replacement accepts combined completed degrees. It treats `Native` as an uncalibrated self-description, uses an explicit CEFR level when present, and otherwise asks for review. It does not infer fluency from nationality.

The tracker also has source drift:

- Its settings still point to job 84021325. The requested job is 94844236.
- Its hidden README describes a Subject Assessment Log that is absent.
- The active dropdown tab and Settings disagree on Computer Science/ICT interviewers. The active list names Gift; the setup proposes that map and allows an operator to change it.
- Old weekly mock lists and the README disagree about the weekday. New bookings use the user's Monday–Friday window.
- The spreadsheet timezone is `Etc/GMT`. Booking instants use `Asia/Bangkok` explicitly.
- A scheduling response is not proof that an invitation was sent. Email presence in SEEK is treated as prior contact, not permission to send another copy.

The [job advertisement](https://th.jobsdb.com/expiredjob/94844236?ref=cm-ui) asks for a related degree, subject knowledge, English, and full work rights in Thailand. It prefers teaching experience and names British/American curricula and Years 4–13. Its hours start after 16:00. On 31 October, Kevin explicitly kept the tracker's newer operational rule: onsite availability on a weekend day **and** at least one weekday after 15:00. The implementation follows that instruction.

## Scoring and advancement

Kevin set these weights. All six weights and the invitation threshold are editable in **Hiring → Rules and setup**. Weights must sum to 100; the initial threshold is 60. Saving records the actor, revision and full configuration.

| Criterion | Points |
|---|---:|
| Degree relevance | 10 |
| Subject evidence | 10 |
| Curriculum experience | 20 |
| Teaching experience | 20 |
| English evidence | 20 |
| University prestige | 20 |

For the five professional criteria, `met` earns the full weight, `partial` half, and `unknown` or `not_met` no points. Every scored claim must quote text present in the source. The model cannot set its own total or send a message.

A new profile may receive the pre-screen form at or above the threshold only when degree and subject evidence both meet the rule, at least one subject is supported, its SEEK answer confirms unrestricted work rights, and there is no prior-contact flag. Missing evidence goes to review; it does not trigger rejection.

Pre-screen assessment uses the same editable score threshold, plus explicit degree, subject, English and availability checks. English subjects require C1; other supported subjects require B2. Art also requires a portfolio. Only declared, supported subjects can advance. The booking form asks the candidate to confirm onsite attendance and the required teaching availability.

### University prestige

The source is **US News Best Global Universities**, not the US-only National Universities table, QS, THE, or a subject ranking. The initial edition is 2026–27. The [US News release of 16 June 2026](https://www.prnewswire.com/news-releases/us-news-unveils-2026-2027-best-global-universities-rankings-302800745.html) supplies the initial top-ten reference entries. Their rank is a research/reputation measure, not evidence of the candidate's teaching ability.

Only a university that awarded a completed degree can count. Short courses, exchanges and employment do not count. Multiple degrees do not stack this bonus; the highest supported institution score applies.

With the initial 20-point weight:

- A verified US/UK institution starts at 8 points.
- A verified overall global rank adds 12 points for 1–10; 10 for 11–50; 8 for 51–100; 6 for 101–200; 4 for 201–500; 2 for 501–1000.
- Chulalongkorn, Thammasat and Mahidol receive 12 points. No unverified US News rank is assigned to them.
- Other institutions receive any supported ranking points but no US/UK country bonus.
- An unverified rank earns no ranking points and is labelled unverified. Institution country is matched to a reference entry or an exact, unambiguous record from the [ROR API](https://ror.readme.io/docs/rest-api). Candidate nationality is not used.

The initial reference list is deliberately limited to ten ranks proved by the release and the three named Thai universities. It is **not a complete ranking dataset**. An administrator can add a verified institution, aliases, country, global rank, edition and source under **University prestige rules and reference data**. Country-only scoring can run automatically for other exact ROR matches; missing rank coverage remains visible.

## Workflow

1. The owner worker reads the normal SEEK UI in a separate Chrome profile. It extracts the application ID, professional profile, resume text where available, and contact history. It never changes a SEEK candidate's status or sends through SEEK.
2. It imports existing tracker decisions and the latest pre-screen response for each normalized email. Existing source IDs, repeated applications and prior contact are retained. Initial historical contact remains in review rather than receiving another invitation.
3. Claude Code runs through the existing subscription-only runner, with no tools, no MCP access, no API key, a schema and a bounded call. The server validates evidence quotes and computes scores.
4. Qualifying new candidates receive the existing pre-screen form. Qualifying responses receive the new paper-booking page. The old scheduling response tab remains intact for historical use.
5. A human records the paper pass in Hiring or in the original tracker. Subsequent changes to a tracked paper-pass record queue a mock invitation. An initial historical import does not resend past invitations.
6. A signed, expiring candidate link offers appointments. Mock choices cover the next five complete business dates, excluding today and configured closed dates, Monday–Friday, 10:00–16:00 Bangkok. Each mock subject takes one hour. Paper choices initially use weekday office hours, 09:00–18:00, with arrival before 16:00; weekend closing hours were not stated and are not invented.
7. A mock slot needs positive offline Wise working-hour evidence, complete leave coverage, a fresh snapshot and no teaching, sit-in or hiring clash. Enrolled office staff must also be within their individual office hours. A final live Wise read checks all linked accounts before commit.
8. A database transaction reserves the candidate and interviewer, then queues candidate email, Google Calendar invitation and the assigned tutor's registered LINE group message. Peat and Ek are both proposed for Mathematics and Physics.

The `Hiring Automation` tab is a separate derived view in the same tracker. Original formulas, tabs and historical decisions are not overwritten. Candidate text is written with `RAW` parsing so it cannot become a spreadsheet formula.

New paper appointments must use the Hiring booking page. The old scheduling form and free-text paper-date cells do not reserve capacity in Hiring. No future numeric paper date was present during inspection; any appointment added manually before activation must be reconciled before opening the new booking links. Staff can continue to record paper results in the original tracker.

## Implementation and protection

- Tables: `hiring_settings`, `hiring_candidates`, `hiring_bookings`, `hiring_outbox`, `hiring_audit`; migration `0118_hiring_automation.sql`.
- Admin: `/hiring`, `/api/hiring`. Current admin session and page scope are required.
- Worker delivery: `POST /api/internal/hiring-delivery`. A short-lived HMAC binds the complete request body to the existing application secret. The route rejects preview environments. Email and LINE keys stay in Vercel; they are not exported to the Mac. Test mail and Calendar entries address only the configured organizer; a LINE test requires the organizer's confirmed personal user ID and rejects group IDs.
- Candidate: `/hiring/book/{token}`, `/api/hiring/book/{token}`. HMAC verification, expiry and stage checks protect access. No contact details or other candidates are returned. Responses prohibit caching and referrer disclosure.
- Google consent uses the existing Auth.js sign-in flow and registered callback. It requests Calendar and Sheets access for the configured organizer and keeps the existing Drive grant. The existing account validation, encrypted token store and refresh code are reused.
- Booking triggers share the existing sit-in observer lock and check overlap in both directions. Candidate overlap is also rejected. Adjacent appointments are allowed.
- Email uses the existing outbound sender. LINE uses each tutor's current bot route and enabled group registration; the existing `PROGRESS_LINE_TUTOR_BOT_KEYS` pilot list selects the dedicated tutor bot. Calendar uses a stable event ID and verifies its private booking marker before reuse.
- Jobs retain provider receipts. An uncertain email or LINE send reuses its original key only within the provider's retry window; it is held after 23 hours. Unsent invitations for a stage already completed are cancelled. Provider acceptance and recipient delivery remain distinct.
- Unverifiable AI evidence holds only that candidate for review. It is not retried unchanged on each cycle. Confirmed appointment messages run before source intake, so a SEEK or AI connection failure does not hold those messages.
- `HIRING_WRITES_ENABLED=true`, enabled settings and approved rules are all required for autonomous processing. Preview environments cannot enable writes. Delivery has its own pause switch.

## Setup and release

Use a checked release checkout. Do not apply migrations or send live messages from a development test.

1. Complete the project release checks and review this feature.
2. Apply **only the reviewed hiring migration**, after checking the target database and the current migration ledger. Do not apply unrelated pending migrations as a side effect.
3. In Hiring, select **Connect Google** and grant Calendar and Sheets access using the configured organizer account. The existing application callback is reused; no new Google Cloud redirect URI is needed. No Calendar grant existed during source inspection.
4. Review the suggested interviewer identities, email addresses, active LINE groups, closed dates, scoring weights and threshold. Confirm a real test recipient for each delivery channel.
5. Use Node.js 24. From the release checkout, run `npm run hiring:worker -- --connect-seek` once and sign in to SEEK in its separate profile. That profile is stored under `~/.bgscheduler-hiring/seek-profile`, not in Git.
6. After release and live-send approval, set the write gate and enable the feature. Run one controlled `--once` cycle. Verify recipients and provider readbacks before enabling routine `--watch` cycles.
7. To run without an open terminal, use the [macOS LaunchAgent template](../operations/hiring-worker.plist.example). Replace its five path placeholders with the release checkout, Node.js 24 executable and bin directory, Claude CLI bin directory, and user home. Ensure `~/.bgscheduler-hiring` exists. Install the reviewed file as `~/Library/LaunchAgents/com.begifted.hiring.plist`, validate it with `plutil -lint`, then load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.begifted.hiring.plist`. Use `launchctl bootout` with the same domain and path to stop it. The template contains no secrets; the worker reads the release checkout's protected environment file.

`--watch` runs one cycle at a time, with 15 minutes between cycles. It uses the owner's Claude Code subscription and refuses API-key authentication. No model API-key spend is introduced. It queues decisions in Postgres and asks the production delivery endpoint to send messages using Vercel's existing private keys. The Mac needs the production database, application signing secret and source-read credentials, but no Resend or LINE sending keys. The owner machine must remain awake, connected and signed in; Vercel cannot run the subscription CLI. The worker records its last successful source counts and any failure in Hiring. The LaunchAgent starts at login and restarts a stopped worker. Keep the release checkout and its protected environment file while the agent is installed.

Run these local checks from the checkout:

```sh
npm test -- src/lib/hiring src/__tests__/middleware.test.ts
npm run test:integration -- src/lib/hiring/__tests__/workflow.integration.test.ts
npm run verify:release
```

The integration suite covers source/email deduplication, the application-to-mock path, manual SEEK contact, competing reservations, a revoked pass during the live check, sit-in conflicts and uncertain delivery retries. It uses a disposable PostgreSQL database and mocked external providers. A separate Calendar test checks event creation, both attendees and recovery without a duplicate. A live synthetic assessment through the Claude Code subscription returned valid source quotes and the expected score of 100 for a fully supported Oxford mathematics example.

These checks do not prove live receipt, browser extraction for every candidate, full university-rank coverage, or scoring quality on independently marked historical cases. The reference catalog initially contains the publisher's verified global top ten and the three named Thai universities. Other exact ROR matches can establish country; an unverified rank earns no ranking points. Later Wise schedule changes do not automatically move a confirmed appointment. These are explicit operating limits, not completed acceptance checks.
