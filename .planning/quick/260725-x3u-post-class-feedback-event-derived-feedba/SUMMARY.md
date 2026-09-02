---
quick_id: 260725-x3u
slug: post-class-feedback-event-derived-feedba
date: 2026-07-25
status: complete
---

# Post-class feedback: event-derived timeliness, history backfill, parked email

## What the task was

Use the Wise Analytics → Logs (activity-event) feed to validate whether tutors submit post-class feedback on time; remove the email-relay and tutor-email-coverage activation gates; make a full backfill of `/post-class-feedback` possible.

## Findings that shaped the work

Verified against the live Wise tenant and the production Neon database before writing code:

1. **The timing dimension had never worked.** All 1,648 eligible sessions were `timing_status = unknown` or `not_due`; zero `on_time`, zero `late`. `evaluateSessionCompliance` only trusted `submission.updatedAt`, which Wise effectively never returns.
2. **A live payload bug.** `loadFeedbackEvents` read `autoSubmitted` from `payload.autoSubmitted` and two other paths. Wise emits it at `payload.session.autoSubmitted`. Production had 3,427 rows at the real path and **0** at the paths being read, so `provenance` was `unknown` on 100% of 2,728 versions.
3. **Most feedback is not written by the tutor.** Across the full 17,000-event history: TEACHER 35%, ADMIN 33%, AUTO 31%, STUDENT/OWNER 1%. Session detail cannot see this — an admin submitting on a tutor's behalf still writes `profile: "teacher"`.
4. **The `eventName` filter works server-side**, and the tenant retains ~341 pages (~17,000 events) of feedback history back to 2026-03-31.

## Decisions taken (user-directed)

- Only `TEACHER`-authored, non-auto submissions prove tutor compliance.
- Backfilled history is observation + analytics only; nothing before `policyEffectiveAt` may create a deduction.
- Email: activation gates removed now, subsystem parked (code retained, crons removed).

## Changes

### Event-derived timing and authorship
- `events.ts` (new) — pure `toFeedbackEventEvidence` projection, extracted so it is testable without the `server-only` chain that makes `repository.ts` unimportable in the node test project.
- `policy.ts` — `feedbackSubmitterRole` and `deriveEventTimingEvidence`, with the **coverage floor** guard (D-EVT-01): a deadline predating the oldest persisted event yields `unknown`, never `late`. Wired into `evaluateSessionCompliance` ahead of the mutable-timestamp path (D-EVT-02).
- `repository.ts` — fixed the `autoSubmitted` path, added `actorRole`, added `loadFeedbackEventCoverageFloor()`, persisted the basis as `timing_evidence` + `details.{timingEvidenceSource,submitterRoles}`. No migration needed.
- **Observation vs enforcement split (D-EVT-03)** — `policyApplies` no longer suspends the whole assessment; it now gates only `deductionCandidate` via `enforcementActive`. A broken source or `paused` mode still suspends assessment outright.

### Backfill
- `wise-activity/sync.ts` — added `eventName`, `startPage`, `stopOnKnownEvents`. The `known_events` stop is correct for the incremental cron but would halt a re-run on page one, so deep crawls disable it.
- `POST /api/wise-activity/sync` — accepts the three fields; `eventName` is allowlisted to `SessionFeedbackSubmittedEvent`.
- `post-class-feedback/sync.ts` — `BACKFILL_DETAIL_CAP = 400` for explicit manual date-range backfills only; cron stays at 50.
- `backfill-job.ts` (new) — time-budgeted drain loop modelled on `reminder-job.ts`.

### Bug found and fixed during the backfill
Wise answers a deleted session with **400 `"Session not found!"`**, not 404. `safeWiseIssue` defaulted unclassified errors to `scope: "global"`, so one removed session marked **every** session's source `unavailable` and suspended the entire feature. Now classified session-scoped alongside 404.

### Email gates removed / subsystem parked
- Deleted `emailRelaysConfigured()` and the activation blockers for test-email, relays, digest recipients, and tutor emails. Role coverage still gates.
- Setup checklist reduced to `mapping`, `roles`, `shadow_review`, `activation`.
- Three cron entries removed from `vercel.json`; the registry entries were kept but flipped to `manualOnly: true` / `schedule: null` so Data Health stops reporting them late **and** the three dormant routes still typecheck.
- `notifications.ts`, `reminder-job.ts`, the routes, Settings cards 3 and 5, and all five notification tables retained untouched.

### UI
`SubmitterBadge`; Operations gained a **Submitted by** column and filter; Analytics gained **Tutor wrote / Admin rescued / Auto-filled** per tutor.

## Production actions taken

- Backfilled feedback events: 341 pages, 17,000 fetched, **7,407 newly inserted**, history now 2026-03-31 → 2026-07-26.
- Resolved one stale global blocking issue caused by the 400 misclassification.
- Backdated the seeded shadow enforcement window from 2026-07-21 to the event-coverage floor (2026-03-31). Sessions with no covering window resolve to `paused` and cannot be assessed; shadow mode creates no obligations and `enforcementActive` requires `live`, so this is observation-only and reversible.
- Drained session detail across the history in weekly windows.

## Verification

- `npx tsc --noEmit` clean.
- `npx eslint` clean over every changed area.
- **1,774 unit tests pass.** The single failing *file* is `us-universities/__tests__/shortlist-bar.test.tsx`, which cannot load its own missing `./compare-colors` module — pre-existing, untracked, unrelated WIP.
- New coverage: 12 `deriveEventTimingEvidence` cases, 7 payload-projection cases against the real Wise shape, 4 sync end-to-end timing cases, 1 regression guard for the 400 misclassification, 4 drain-loop cases, 3 activity-sync option cases.
- Timing resolved in production for the first time (`wise_activity_event_before_deadline` / `wise_activity_event_no_tutor_submission`).

## Not done

- Nothing was committed. The working tree carries the changes; `src/lib/post-class-feedback/` and `src/types/post-class-feedback.ts` remain untracked WIP.
- Not deployed.
