# Hiring call queue — design

Date: 4 November 2026. Owner: Kevin. Status: approved by Kevin, 4 November 2026.

## Intent

HR phones the strongest SEEK applicants before the system sends them the pre-screen form. In the past, HR found these people by reading SEEK. Now the Hiring page must give HR one list, best SEEK intake score first, with the score, the résumé and the SEEK page one click away. The result of the call decides what happens next.

## Goals

- A **call queue**: every candidate who passes the profile gate with a profile score of **80 or more**, sorted by profile score, highest first.
- For each row, HR can see the score and its short evidence, open the résumé, and open the candidate's SEEK page (where the phone number is).
- HR records one of three results:
  - **Good call**: the candidate goes into the existing pre-screen send queue. The form then leaves under the normal limits.
  - **Bad call**: the existing Stop runs. Nothing goes to the candidate.
  - **No answer**: the candidate stays in the call queue. The row shows each try with its time.
- A candidate with a profile score from the profile threshold (60) to 79 gets the form automatically, as today, with no call.
- The call score (80) is editable in **Rules and setup**, next to the profile threshold.

## Non-goals

- No phone number is copied from SEEK, and the app does not dial. HR reads the number on the SEEK page.
- No call notes field, no call script, no call scheduling, no reminders to call.
- No change to the pre-screen limits, the hard stops, the drag order or the onsite flow.
- No rejection email after a bad call (same as Stop today).

## Anti-goals

- A call result must never send an email directly. A good call only puts the candidate in the send queue; the queue, the limits and the Automation and Messages switches still control every send.
- A candidate at 80 or more must never get the form before HR records a good call.
- A bad-call candidate must never come back into any queue automatically.

## Behaviour

### Who is in the call queue

A candidate is in the call queue when all of these are true:

1. They are in the set that `preScreenQueue` reads today: stage `new`, no pre-screen response, no earlier form row.
2. They pass `profileGate` (score at or above the profile threshold, accepted work rights, usable email, no earlier contact, an open subject, degree not `not_met`).
3. Their profile score is at or above the call score.
4. No good call is recorded for them.

A candidate who fails the gate (for example, a closed subject) is not in the call queue. Calling them gives no result, because the form cannot go. When the gate opens, they enter the call queue.

### Effect on the pre-screen send queue

`preScreenQueue` leaves out every candidate with a score at or above the call score who has no good call. A good call lets them in. They then take their automatic place (subject rank, then score), and a person can still drag them.

The row lock check in `releaseQueues` applies the same rule again, so a click between the read and the lock cannot send a form to an uncalled candidate.

### Recording a result

- One new action on the hiring API, for example `call_result` with `id` and `result: good | no_answer`. Bad call uses the existing `stop` action, so its rules (cancel waiting emails, refuse while a future visit exists) stay in one place.
- The action takes the queue lock, checks that the candidate is still in the call queue, and writes the result. If the candidate left the queue, it refuses with 409 and "Refresh the page", like `queue_move`.
- Each click writes an audit row with the actor and the result.
- Recording a result sends nothing and changes no stage. It does not change `revision` (same reason as the drag: a new revision voids a running AI score).
- Recording works while Automation or Messages is off. The good-call candidate then waits in the send queue.

### Stored data

- A new nullable `jsonb` column on `hiring_candidates`, for example `call_review`: `{ result: "good" | null, at, by, tries: [{ at, by }] }`. A good call sets `result`. A no answer appends to `tries`.
- A new setting `callThreshold`, integer 0 to 100 or blank, default 80, in the strict config schema with `.default(80)`, so an old saved config still parses. Builder's call: blank turns the call step off, so every gate pass gets the form automatically (same pattern as the nullable `preScreenThreshold`). A call score below the profile threshold is allowed: it means HR calls every candidate who passes the gate. (Changed during the build: a refusal would block raising the profile threshold above 80.)
- One migration for the column. The settings field needs no migration.

### Invite by hand (Kevin's decision, 4 Nov)

The candidate panel's existing **Invite to pre-screen** button still works for an uncalled candidate at 80 or more. The click records a good call (`by` = the actor, with a `manual: true` mark) in the same transaction, so the person leaves the call queue. The audit row says so.

### SEEK moves after a good call (Kevin's decision, 4 Nov)

HR may move the SEEK card to Prescreen or Shortlist, or message the candidate from SEEK, after a good call. The form must still go. So, for a candidate at stage `new` with a good call:

- `observeSeekState` does not move them to `review` when the SEEK status leaves Inbox.
- A new SEEK contact still sets `previouslyContacted`, but `profileGate` does not fail on earlier contact when a good call is recorded, because HR's call is the contact.
- A SEEK stop (Not Suitable, Accept) still stops the candidate, as today.

`sources.ts` is also changed on `feat/hiring-campaigns`, so this part needs care at rebase.

### Rules for edge cases (builder's call unless Kevin says otherwise)

- A good call stays valid if the score or the call score changes later.
- If the call score is raised, uncalled candidates newly at or above it move from the send queue to the call queue. If it is lowered, candidates below it leave the call queue and get the form automatically.
- A candidate who replies to the form some other way (for example, an old tracker response) leaves both queues, as today.
- The SEEK intake rescoring a candidate up past 80 moves them into the call queue before any form goes.

## The screen

- A **Call queue** list on the Hiring page. Builder's call: a new tab **Calls**, between **1 Seek intake** and **2 Pre-screen**, opened by `/hiring?view=calls`, because HR works from it on its own. The Hiring-only user (`allowed_pages ["/hiring"]`) needs no access change.
- Each row: rank, name, profile score, subject, the short summary line, number of tries and the last try time, and three buttons: **Good call**, **No answer**, **Bad call**.
- Clicking a row opens the same résumé panel as Seek intake, with the existing `SeekLinks` (candidate SEEK page) and the DSCTE pentagon.
- **Bad call** asks for a confirm, because Stop cannot be undone from this list.
- An empty queue says so.
- The Overview and the Seek intake send queue show the number waiting for a call.

## Constraints

- Follow the existing hiring module patterns: `src/lib/hiring/queue.ts` for the gate, the `command` union in `src/app/api/hiring/route.ts`, `audit()` from `service.ts`, the `HiringError` shape, and the existing panel components.
- Times show in Bangkok.
- Another session is working on `feat/hiring-campaigns` (several SEEK jobs) in `.claude/worktrees/slot-hiring`. This work must take the next free migration number when it is built, and rebase on that branch if it merges first. Open PR #255 also touches hiring.
- Update `docs/features/hiring.md` with the call step.

## Checks

- Unit tests: the call-queue filter (in at 80, out at 79, out after a good call, out when the gate fails), and the send-queue exclusion.
- Integration test (Testcontainers, like `queue.integration.test.ts`): a candidate at 85 gets no form row from `releaseQueues` until a good call; a candidate at 70 gets one at once; a bad call stops the candidate and cancels nothing that was not waiting.
- Tests for the two decisions: a hand invite records a good call; after a good call, a SEEK move out of Inbox or a SEEK message does not block the form, and a SEEK stop still stops.
- Component test for the Calls tab buttons.
- The offline screen check `scripts/dev/verify-hiring-screens.mjs` covers the new tab.
