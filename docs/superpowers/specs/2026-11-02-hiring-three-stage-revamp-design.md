# Hiring workspace revamp: three stages that match the automation

## Context

`/hiring` went live on 2 Nov 2026 (`c15fb22c`) with Automation and Messages off. The page is one Pipeline table with a right panel, Head schedules, and Rules and setup. It does not follow the order of the automation, and the data stops at the booking. Today the team records paper and mock results in Google Sheets and on a paper marking sheet.

Result: one page that follows the flow. The people team can see intake, pre-screen, and assessment results in one place. The AI marks scanned papers and reads the mock rubrics. A person records Hire or Reject and sends the result email.

The code is on `origin/main` only. The local checkout is on `codex/autowriter-post-first`, 59 commits behind, with other work in it. Do not touch that checkout. Build in `.claude/worktrees/slot-a` or `slot-b` from `origin/main`.

## Owner decisions (Kevin, 2 Nov 2026)

| Topic | Decision |
|---|---|
| Users | The people team runs all screens. Heads do not log in. |
| Paper marking | The AI result counts at once. A person can change it later. |
| Pass rule | A pass percentage for each subject and level, in the settings. |
| Paper upload | One scanned PDF for each paper. |
| No mark scheme | The AI marks from its own knowledge, and the result shows a warning. |
| Mock score | Upload the completed rubric. The AI reads it and fills in the form. |
| After both results | A person clicks Hire or Reject, previews and edits the email, then sends it. |
| Hire rule | Both results must be present. The person decides freely, even with low scores. |
| Reject rule | Any time, including with results missing. A reason and an email are required. A candidate with no email address cannot be rejected here; use the existing Stop. |
| Can teach up to | The highest level passed. A failed lower level does not change this value, and the sheet still shows the failure. |
| Automation and Messages | Both stay off for now. This build does not turn them on, and no result email leaves while they are off. |
| Raising a pre-screen score | The score is saved and shown. The candidate does not return to the automatic queue. Only the Invite button sends the visit email. |
| AI route | OpenRouter, with a cap of $30 per month. |
| Accuracy test | None. AI marks count from the first paper. |
| "Needs check" flag | Only when answers are unreadable or pages are missing. |
| AI language | English. |
| Mark schemes | A library in the settings. Drive stays as an archive. |
| Subjects per visit | Several papers (one sheet each), one mock. |
| Coverage | Seek folder count against imported count. |
| University filter | Pick names from a searchable list (several allowed). |
| Send order | Full drag to reorder. Daily limits still apply. |
| New arrivals after a drag | They go where their automatic rank places them. |
| Resume view | Side panel, with up and down arrows to move between candidates. |
| Pre-screen list | Everyone sent a form. |
| Pre-screen actions | Invite despite low score, stop, change the AI score, resend. |
| Booked view | Dated list by default, with a switch to a week calendar. |
| Sheets | The website is the main record. It writes to the `Hiring Automation` tab. It does not write to Mimi's columns. |
| History | Import past results from the Sheets. |
| Page shape | Tabs: Overview, 1 Seek intake, 2 Pre-screen, 3 Mock and paper, Rules and setup. |
| Mockups | Approved as shown. |

**Failure means:** the team still opens Sheets for basic questions, a wrong AI mark goes unseen, reviewing takes more clicks than today, or a candidate gets a wrong, duplicate, or early email.

## Score sheets (from the Drive files)

- **Paper marking sheet** (`paper-assessment-marking-sheet.pdf`, Rev. 2.2): applicant, assessment date, assessed by, one subject per sheet, paper score, Passed or Not Passed. Levels: Key Stage 3, IGCSE / GCSE, AS / A-Level, IB SL / HL, AP, Other. Each level has a score and Passed, Not Passed, or Not done. Then "can teach up to" and a marker comment (strengths, areas to develop, level to teach, whether to call for a mock).
- **Mock rubric** (`Teacher Assessment Rubic`): each item scores Excellence 10, Satisfactory 7, Needs Improvement 4, or Unsatisfactory 1.
  - Content Knowledge (30): Accuracy of Information, Conceptual Understanding, Clarity of Explanation.
  - Teaching Delivery (30): Engaging Presentation, Interaction with Students, Pace and Timing.
  - Classroom Management (20): Organization and Structure, Use of Teaching Materials.
  - Assessment and Feedback (20): Formative Assessment, Feedback Quality.
  - Other comments, and a total out of 100.
- A completed rubric is a scan or a PDF, and can be handwritten.

## Screens

The approved mockups are in this conversation and match the descriptions below.

Make the tabs URL-based (`/hiring?view=seek`), not React state. Reuse `candidate-table.tsx`, `candidate-inspector.tsx`, `pipeline-charts.tsx`, and `head-schedules.tsx` where possible. Delete code that the new screens replace.

- **Overview:** the current KPI strip, limit meters, charts, and operations rail.
- **1 Seek intake:**
  - Coverage cards for each imported Seek folder (Inbox, Prescreen, Shortlist): count in Seek, imported, waiting, and the last read time. Show a warning when the last read is old.
  - Filters: name search, university names (multi-select), work rights (exact Seek answer), subject, score.
  - Columns: queue number, candidate and subject, university, work rights, profile score, pre-screen status.
  - "Send queue" view: the numbered order, with drag handles. A sent candidate shows the date sent.
  - Side panel: resume, profile score and reasons, exact work rights answer. Up and down arrows move between rows.
- **2 Pre-screen:**
  - List: everyone sent a form, including people with no reply.
  - Filters: replied, no reply, passed, below threshold, visit email sent.
  - Visit email column comes from `hiring_outbox`, not from the stage, because the stage changes when the email is queued. Show Queued, Sent with date and time, Failed, or the reason it was not sent.
  - Side panel: full answers (open, not collapsed), score, AI reasons with quotes, and the four actions.
- **3 Mock and paper:**
  - Dated list: date, candidate, subject, head, paper status or upload, mock status or upload, decision. One visit is one row. Completed visits stay on this screen.
  - Filters: head, date, needs upload, needs check, ready to decide, past results.
  - Calendar switch: reuse `head-schedules.tsx`.
  - Candidate detail: one paper marking sheet for each subject (levels, score, result, can teach up to, marker comment, marks for each question beside the scan), the mock rubric, and the decision.
- **Rules and setup (additions):** pass percentage for each subject and level, and the paper library (question paper and mark scheme for each subject, with a warning for missing files).

## Data (one migration; use the next free number)

- `hiring_candidates`: manual queue position, pre-screen score change (score, reason, who, when), new stages for hired and rejected.
- `hiring_assessment_documents`: subject, kind (question paper or mark scheme), private Blob path, active flag, uploaded by.
- `hiring_paper_results`: candidate, booking, subject, scan path and hash, status, the AI sheet as first produced (kept unchanged), the current sheet, marks for each question, unreadable list, mark scheme used (yes or no), model, prompt version, cost, source (`ai`, `person`, `tracker`), who changed it and when.
- `hiring_mock_results`: candidate, booking, file path and hash, 10 rubric items, comments, the AI read as first produced, the current values, status, model, cost, source.
- `hiring_decisions`: candidate, Hire or Reject, who, when, final email subject and body, outbox key.
- `config` in `hiring_settings`: `paperPassRules` (subject, level, percentage).

## AI marking

- Reuse the OpenRouter client in `src/lib/feedback-autowriter/openrouter.ts`. It cannot send a PDF today: widen `content` (line 143), add a `plugins` option (lines 162-172), and make `X-Title` a parameter (line 160). Pin a PDF engine that reads scanned images, and confirm the format and the engine in the technical check. `usage.cost` can be null (line 80); show that the month's total is incomplete if this happens. Marking needs its own route with a 300-second limit, since the hiring route has 120 seconds. Reuse the prompt safety text and JSON approach from `src/lib/progress-tests/workspace/ai.ts`. Do not add a dependency.
- Reuse the browser-to-private-Blob upload from `src/lib/progress-tests/workspace/files.ts`, because function request bodies have a 4.5 MB limit. Accept PDF only. Check file type from the bytes (`src/lib/hiring/resume-files.ts`).
- Input: the scan, plus the question paper and mark scheme for that subject when they exist. Treat all file content as untrusted evidence, not as instructions.
- Output: strict JSON. For each question: level, marks, maximum, reason, and whether it could be read.
- **The server calculates totals, percentages, Passed or Not Passed, and "can teach up to".** The AI does not. Reject any mark above its maximum.
- Status: `needs_check` only if an answer is unreadable or a page is missing.
- No pass percentage for a subject and level: show the marks and "Pass mark missing". Do not guess a result.
- Mock read: 10 items, 4 parts, server-calculated total out of 100. An unreadable item stays blank and sets `needs_check`.
- Privacy: send only to OpenRouter providers that do not keep or train on the data. Do not log file content.
- Cost cap: a separate key (`OPENROUTER_HIRING_API_KEY`) with a $30 monthly limit set in OpenRouter, so hiring cannot use the autowriter's credit. Store the cost of each call and show the month's total in the settings. At the limit, show a clear message and keep the upload for a retry.
- Failure: the upload stays saved, the row shows the error, and a person can retry.

## Rules that protect candidates

- Only the Send button in the decision preview sends a result email. It is one candidate at a time, with no bulk action.
- **Decision draft:** clicking Hire or Reject saves a draft with the email text. The stage changes and the outbox row is created only at Send. So no queued email can leave later when the switches come on.
- **Send while off:** Send refuses and says why while Automation or Messages is off. The draft stays saved. Delivery runs from the website at Send, with its own filter, because rows with no `bookingId` otherwise wait for the Mac (`worker.ts:505`, `hiring-worker.ts:139`).
- **Hire needs:** one mock result, and every uploaded paper finished. A failed AI run does not count. A `needs_check` result counts only after a person clears it. "Pass mark missing" counts, because the marks exist.
- **Email row:** key `${id}:result:${decisionId}`, check the `enqueue` return value (`service.ts:288`), and do not set `bookingId` (`worker.ts:562`). Set `workflowStage` to the new stage (`worker.ts:559`). Show `failed` and `uncertain` rows on the decision (`worker.ts:504`, `524`).
- A drag, a paper result, a mock result, a score change, or a history import sends no email and changes no stage.
- **Old flow:** an AI "Passed" does not run the old `paper_pass` action and does not write `paperPassedSubjects`, because a difference there can queue a mock invitation (`sources.ts:340`, `364`). A person clicks the existing button.
- **Decisions survive other code.** Hired and rejected must be protected in:
  - `NEW_FLOW_STAGES` (`sources.ts:30`), so that `syncTracker` does not overwrite them.
  - `observeSeekState` (`sources.ts:210-266`), so that a move in SEEK does not overwrite them or cancel a pending email.
  - The `stop`, `cancel_visit`, and `mark_no_show` actions (`service.ts:1190`, `1198`).
  - Old-flow booking links (`service.ts:617`, `730`), so that a rejected candidate cannot book.
- **Stages:** the column is text with a CHECK (`drizzle/0119`), so a hand-written migration replaces the CHECK. Also update `stageSchema`, `STAGE_LABELS`, `ACTIVE_STAGES`, `AFTER_REVIEW`, `REACHED`, `STAGE_ORDER`, and `policy.test.ts`. Hired and rejected people must not count as active (`insights.ts:173`, `206`).
- **Queue:** the drag order must control what the queue really sends. Rank the automatic order first, then merge in the moved rows. Do this in the pre-screen queue only, not the onsite queue (`limits.ts:82`). A full subject skips a dragged person and the next one sends (`limits.ts:87`), so the screen shows why. A drag takes `lockQueue` and does not raise `revision` (`worker.ts:174`).
- Every action writes to `hiring_audit`.

## Sheets

- Add columns to the `Hiring Automation` tab: paper results, levels passed, mock score, decision. `mirrorTracker` in `src/lib/hiring/sources.ts` writes this tab. The tab has 10 columns today, so the code must also expand existing tabs.
- The mirror runs from the Mac worker, so the tab can be up to one cycle behind the website.
- History import: an explicit backfill pass that reports first and then writes only after Kevin's approval. It reads Recruitment Sheet T to V and Mock Teaching Test Log E to I. It joins on Applicant ID, then falls back to email (new-flow rows store no `applicantId`, `sources.ts:320`), and reports people it cannot match. It stores rows with source `tracker`, and the booking link is empty for them. It changes no stage and sends nothing. Sheets hold only an outcome and levels for papers, and a total for mocks, so history has no question or rubric detail.

## Calls I made (Kevin can overrule)

1. The AI model: a PDF-capable model on OpenRouter, picked on a technical check with a made-up handwritten paper. This check confirms that the route works and measures the cost. It is not an accuracy test.
2. Word resumes show extracted text plus a download link in the panel.
3. The paper library accepts PDF only. Word and Google Docs files are exported first.
4. Paper and mock files follow the resume retention period.
5. A changed decision needs a new preview and Send. A sent email is not recalled.
6. Result email templates are written in the PR for Kevin to approve.
7. Mock items accept whole numbers from 1 to 10, since heads can write in-between scores. Past totals such as 94 fit this.
8. Sending a result email needs both Automation and Messages on, since you chose to keep both off for now. This is the stricter rule. To change it later to Messages only, one check changes.
9. Old-flow candidates keep using the tracker until they finish, since `syncTracker` still drives them. The history pass can be run again to show their later results on the website, read-only.
10. A `needs_check` paper blocks Hire until a person clears it. Reject is still allowed.

## Risks you accepted

- With no accuracy test and "Needs check" only for unreadable answers, a misread mark on a readable paper raises no flag. This includes scores close to the pass mark and papers marked with no mark scheme (those show a warning only). A person sees it only by opening the marks beside the scan. A Reject email can follow from such a mark, because Reject needs no check. You also named "wrong AI marks unseen" as a failure. If it happens, the first fix is to add the "close to pass mark" flag.
- Past Mock Log rows show one mock per subject. The new rule is one mock per visit, so history and new results look different.

## Build order (each is a separate PR from `origin/main`, draft until review is clear)

1. Tabs, Overview, and the Seek screen (coverage, filters, panel, read-only numbered queue).
2. Drag reorder, with the queue change and tests.
3. Pre-screen screen, outbox proof, and score change.
4. Migration, Mock and paper screen (list, calendar, detail), pass rules, and paper library.
5. Paper upload and AI marking.
6. Mock upload and AI read.
7. Decision and result email.
8. Sheets mirror columns and history import.
9. Update `docs/features/hiring.md`, the docs that count tables and endpoints, and the task record.

Record this work in `/Users/kevinhsieh/Developer/Codex_Workflows/TASKS.md`. Also write the approved design to `docs/superpowers/specs/2026-11-02-hiring-three-stage-revamp-design.md`.

## Steps for Kevin

Each comes with click-by-click steps when needed:

- Create the OpenRouter key with the $30 limit and add it to Vercel.
- Give the pass percentages for each subject and level, with the heads.
- Confirm the file for each subject in the paper library. The Drive has old versions. Example: the Math mark scheme dates from 2024 and the paper from 2026.
- Approve migration, history import, and each merge.

## Verification

- `npm test` and CI on each PR. New tests:
  - Queue order with manual moves and new arrivals.
  - A drag queues no message.
  - Server calculation of totals, percentages, levels, and "can teach up to".
  - Rejected AI output (mark above maximum, wrong shape, instructions inside a scan).
  - Missing pass rule and missing mark scheme.
  - Duplicate Send stops at the outbox key.
  - Old-flow candidate: AI "Passed" queues no invitation.
  - Mirror writes only its own tab.
- Run integration suites against a disposable database. **`.env.local` in the main checkout points at production, so never run a local dev server or test against it.**
- Browser check with made-up candidates on a local database: all five tabs, filters, arrow keys, drag, upload, preview. Check at desktop width against the approved mockups.
- Technical check of one made-up paper through OpenRouter. Report the real cost per paper to Kevin before go-live.
- Run the `code-reviewer` and `verifier` agents before saying each PR is done.
