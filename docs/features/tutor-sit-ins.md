# Tutor Sit-ins

**Status:** Implemented; rollout and external delivery are opt-in. Entry point: `/tutor-sit-ins`.

Quarterly tutor quality assurance starts in **2026-Q4 (1 October–31 December, Asia/Bangkok)**. Heads can schedule an observation, complete a native rubric, and see their department's coverage. Operations staff track parent/student communication separately from the assessment report.

## Access and onboarding

| Department | Head |
|---|---|
| Physics | apivit.s@hotmail.com |
| Maths | kasidej.ju@gmail.com |
| English | drxiox@gmail.com |
| Chemistry | miieiiem@gmail.com |
| ISEB | gift.m@begiftededucation.com |

Migration `0089_tutor_sit_ins.sql` seeds these observer grants and the existing operations contacts (Petchy, Care, Palm, Aya and Muk). A head's canonical tutor identity is bound automatically only when an active tutor contact matches the exact email unambiguously. Otherwise an administrator must verify the binding in **Administration**. The linked `tutor_wise_accounts` must cover both onsite and online accounts in the current snapshot.

Google sign-in and existing account revocation remain in force. The Hotmail address must belong to a Google Account; [Google supports existing non-Gmail addresses](https://support.google.com/accounts/answer/27441). Enrollment never re-enables a disabled account. Every feature request reads current grants. An explicit inactive sit-in grant denies feature access, including for an otherwise authorized administrator.

- **Observer:** assignments and reports in their explicitly granted departments; only the assigned observer can write their report.
- **Coordinator:** all scheduling and family communication, with no rubric, report text, score, or report audit access.
- **Manager:** all departments, mappings, identity grants, assignments, exemptions and audited report reopening. Existing full administrators or administrators explicitly allowed this page qualify; an observer grant still limits a legacy administrator to their departments.

## Coverage and availability

An obligation is unique by stable tutor key, department and quarter. Real scheduled or completed lessons supply evidence, including tutors joining mid-quarter. Title keywords or an explicit Wise class mapping resolve departments; level-band `subject` values never do. ISEB and a subject produce separate obligations. Unknown mappings are visible for administrator review. Regeneration preserves existing assignments, exemptions, reports and observation history.

Only complete existing lessons are offered. Suggestions check dated Wise commitments, working hours, explicit leave coverage, other sit-ins and selected Google calendars. The shortlist prefers tutors with fewer suitable lessons, then earlier lessons. Unknown or stale evidence remains **Needs review**. Core tutor and shared student snapshots must be at most 90 minutes old.

Confirmation checks the actual Wise day, lesson detail, all linked observer accounts, current grants, Google busy intervals and competing bookings. It requires at least 24 hours' notice again at the database commit and before a new Calendar event is sent. A head cannot observe their own canonical tutor identity; an administrator must designate an eligible alternate.

The observer lease serializes confirmation and Calendar operations. A PostgreSQL advisory-lock trigger also prevents overlapping bookings across two email grants bound to the same observer identity. Version checks reject stale edits. Overlaps use half-open intervals, so a lesson ending exactly when another begins is allowed.

### Changes and cancellation

The dashboard refreshes sources and suggestions when opened or refreshed. A worker runs every ten minutes. Wise changes appear through the existing approximately thirty-minute sync cadence; confirmation also reads Wise live. Enabling Tutor Sit-ins restores that cadence for shared Credit Control student snapshots even when the Credit Control UI is retired.

A cancelled head class releases only its dated occurrence and only if all remaining checks pass. Valid observations remain in place when a better slot appears. A changed/cancelled observed lesson, tutor, location/modality, participants or head conflict invalidates the current observation, queues withdrawal and alerts, and makes replacements available for confirmation. Direct Calendar changes also require reconciliation. Temporary provider failures retain the booking with a visible review error. Completed reports and historical attempts remain intact.

## Calendar and communications

Each observer connects Calendar separately from the Sheets integration. OAuth uses encrypted, short-lived state, PKCE, verified Google identity and offline consent. Tokens are encrypted into the sit-in connection table. The Calendar permissions are availability, calendar list and owned events; see [Google's scope reference](https://developers.google.com/workspace/calendar/api/auth).

The destination must be owned. Primary and destination calendars are always checked alongside selected calendars. Personal event details never appear in the dashboard or email. Rechecking an existing booking excludes only its exact observation event: it does not subtract a merged free/busy interval that could hide another overlapping event.

Events use a persistent ID and invite the tutor's verified mode-specific contact. They contain scheduling details and an authenticated dashboard link, never assessment scores or prose. The outbox retries using the same event ID/email idempotency key. Scheduling state and delivery state are separate; Calendar failure does not silently erase an assignment. A disconnect requires upcoming observation withdrawals to finish first.

After Calendar confirmation, five staff delivery jobs are queued. Each family has separate **parent informed** and **student informed** acknowledgements, recording the current staff account and timestamp. Changes supersede old tasks and require new acknowledgements. Cancellation creates its own task while preserving earlier acknowledgements. Administrators can resolve an unknown family with a verified reference and an audited reason. Staff delivery failure does not complete a family task.

Heads receive an 08:00 Bangkok digest of openings, upcoming observations and reporting deadlines. Invalidated bookings also queue a prompt alert. Email uses the existing branded renderer and Apps Script relay.

## Native reports

The pinned `begifted-sit-in-v1` rubric adapts the [source assessment rubric](https://docs.google.com/document/d/1c_3wgkh7VGHQbW1RT0SPOf7B0VqI9HtU/edit) to individual and small-group tutoring. It preserves all ten criteria and **10 / 7 / 4 / 1** ratings. Sections total **30 / 30 / 20 / 20 = 100**.

Drafts autosave with a visible status; conflicts retain local text for review. Submission requires every criterion, strengths, development priorities, next steps and confirmation that the observation happened. The lesson must have ended and the Calendar invitation must be verified. The server calculates the score. Reports are due 48 hours after lesson end; late submission is accepted and marked late. The observation's quarter is retained across deadline boundaries.

Submission completes the assignment. Reopening requires a manager, a reason and the expected assignment version; it creates a new draft revision attributed to the original observer. Submitted reports and audit history are protected by database triggers. Rubric content is stored on each report version so later rubric changes cannot alter past scoring.

## Implementation and operations

- Domain: [`src/lib/tutor-sit-ins`](../../src/lib/tutor-sit-ins); UI: [`src/components/tutor-sit-ins`](../../src/components/tutor-sit-ins).
- [API contracts](../reference/api/tutor-sit-ins.md), [database relationships](../reference/database/erd-tutor-sit-ins.md), [configuration](../reference/env.md#tutor-sit-ins).
- [Rollout and verification record](../operations/tutor-sit-ins-rollout.md).

_Verified against the `codex/tutor-sit-ins` working tree on 2026-09-16. Production enablement is separate from implementation._
