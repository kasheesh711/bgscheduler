# Tutor Offboarding

**Status: PR 2 removal controls are deployed in manual mode; live mode remains disabled pending owner verification (2026-10-01).**
Wise removal remains manual until a labelled dummy-teacher probe succeeds and the owner enables
`WISE_TEACHER_REMOVAL_VERIFIED` in Vercel production. Design:
[spec](../superpowers/specs/2026-10-01-tutor-offboarding-design.md).

## Purpose

Admins rarely remove the Wise accounts of tutors who have left, so former tutors keep a working Wise login and
clutter Wise and BGScheduler. `/tutor-offboarding` ranks every person on the Wise roster by how likely they are no
longer with BeGifted, explains each score, and lets a granted admin preview and operate an audited removal run.

## How the score works

1. **Unit (OFF-01):** a person is an identity group's `canonicalKey`; their online and onsite accounts are scored together.
2. **Calibration** (`src/lib/tutor-offboarding/calibration.ts`): from every tutor's taught days since 2026-03-01
   (attendance ledger `ENDED`, blocking past session blocks, post-class sessions `ENDED`), each idle gap either ended
   with the tutor teaching again or is still open. For 21/30/45/60/90 days, `P(gone) = 1 − (returned + 0.5) / (returned + stillIdle + 1)`,
   with a default when a threshold has fewer than 5 observations, forced non-decreasing.
3. **Score** (`score.ts`): base log-odds plus evidence — no working hours +0.8, no Wise courses +0.8, never activated
   login +0.5, a teacher action in Wise within 30 days −2.0, on leave −1.5 — capped at 99%. Bands: ≥90 very likely
   gone, 70–89 likely, 40–69 unclear, under 40 active.
4. **Unknown never counts (OFF-02):** a null roster column or a failed availability fetch adds nothing.

## Separate confirmed-termination evidence

A separate read-only source shows confirmed termination alongside the score; it does not change or override the score.
The existing 30-minute snapshot sync reads the `Tutors` tab (`gid=470328060`) of the fixed supplied spreadsheet after
snapshot promotion and stores its latest snapshot in `tutor_offboarding_sheet_source`. The OAuth account can be set
with `TUTOR_OFFBOARDING_CONNECTED_EMAIL`, falling back to `SALES_DASHBOARD_CONNECTED_EMAIL`.

A row is confirmed only when each populated name cell in columns D:F is fully struck through; email formatting in
columns G:H does not affect confirmation. Matching uses a unique exact
email or full-name identity; nickname-only, fuzzy, duplicate or conflicting matches remain unmatched for staff review.
Source errors, missing syncs and snapshots older than three days stay visible in the dashboard. The sync retains the
last successful rows after a failed refresh. The API reports current source health, matched people and unmatched rows.
The page reads this source from Postgres and makes no Sheets or Wise call.

## Workforce analytics (history from 1 March 2026)

The Analytics tab combines monthly turnover, subject supply and demand, and tutor utilization. Shared Bangkok
date, month, role, subject, curriculum, level and delivery-mode filters apply to the report and its CSV export.
Tutors and teaching administrators are included; linked Wise accounts count as one canonical person. Selecting a
month, subject cell or tutor opens the contributing records and data-quality explanations. Existing course-impact
context remains available below the workforce dashboard.

### Monthly turnover

Turnover is **departures in the month divided by the roster at the start of the month**. The join date is the
earliest retained Wise account-join date, including people awaiting their first class. The roster is labelled a
**reconstructed Wise roster**: accounts removed before collection began, missing dates and unresolved identities
remain limitations.

Departures require an owner-confirmed list or a sheet marking. Following the owner's 1 October definition,
the resignation date is the last recorded past ENDED class (or direct teaching evidence), excluding known
cancellations and student no-shows. This date does not require credit evidence or complete history through
today; those limits stay visible and still apply to credit-consumed and delivered utilization. An uncancelled
future class keeps the person pending, even when viewing a past month. This status never triggers a removal.

Known matched departures remain visible when another source identity is unresolved. The monthly percentage is
labelled partial in that case; a genuinely unknown opening denominator still has no rate. Owner confirmations
are stored separately as `owner-confirmed-departures` in `tutor_offboarding_sheet_source` and read only by workforce
analytics. They retain their confirmation date and do not expire when the Sheets refresh becomes stale. They
neither edit the connected sheet nor grant removal eligibility.

### Subject supply and booked demand

The subject-by-month matrix expands into curriculum and level. The selected month also has a weekday/time view
in 30-minute buckets, using exact interval overlap and an average week. Coverage counts and monthly totals explain
the values, including months with different numbers of Mondays.

Demand shows unique students, student bookings, distinct scheduled classes and booked tutor-hours. Cancelled
bookings and no-shows remain in demand. A one-hour group class with five students contributes five student bookings,
one class and one tutor-hour. Overall unique students are deduplicated across subjects.

Supply is shared time: eight hours offered by a Maths/Physics tutor remain one eight-hour pool. A Physics booking
uses time that would otherwise be eligible for Maths too. Overlapping commitments block their union only. Subject
supply rows must not be added into an organization total, and booked demand minus remaining free time is not an
unmet-demand estimate.

Academic subjects come from reviewed exact lesson labels and class IDs. A Wise classroom name may be a student's
name, and its subject-like field may be a pricing band. Neither is evidence of an academic subject. Unmapped or
changed labels remain visible in the mapping review panel.

### Utilization and teaching evidence

The denominator is offered hours minus approved leave. Original hours and leave losses remain visible. Three
separate measures use this denominator:

- Reserved utilization: non-cancelled scheduled tutor-hours.
- Credit-consumed utilization: duration multiplied by the mean of each booked student's net-credit/normal-credit fraction.
- Recorded teaching utilization: classes established as taught by direct evidence or the approved fallback below.

A one-hour group class with full and half charges consumes 0.75 tutor-hours. A verified full refund consumes zero;
missing credits, missing participants or an unknown scheduled duration are unavailable, not zero. The owner confirmed
on 1 October 2026 that one Wise credit always equals one teaching hour, including historical and group bookings;
the normal per-student charge is scheduled minutes divided by 60. Unexplained
negative or excessive charges remain exceptions. Classes outside offered hours count and may produce rates over 100%.

Where direct teaching evidence is absent, the approved fallback is Wise ENDED plus verified positive credit
consumption, excluding known cancellations and no-shows. Scheduled duration is used when actual duration is unknown;
the UI labels this as recorded class data. A refund does not erase independently established teaching.

### Availability history and coverage

Current availability is not copied backwards into earlier months. Durable observations retain identity, role,
qualifications, offered windows, leave, source timestamps and quality separately from rotating snapshots. Unchanged
payloads are reused, while each observed boundary is retained. A measured observation ends at the next observation,
an error boundary or 90 minutes after the source observation, whichever comes first. Future recurrence is a projection.

Each utilization numerator is clipped to the same supported time as its availability denominator. The report also
retains full-period known class totals, so missing capacity does not hide demand. Unknown capacity is displayed as
unavailable and partial coverage remains explicit.

All report reads use Postgres. The source probe/backfill and existing sync hooks only read Wise. The new report lives
at `/api/tutor-offboarding/analytics/workforce`; the older `/analytics` contract is retained for compatibility and
course-impact context. See [API reference](../reference/api/tutor-offboarding.md) and
[workforce tables](../reference/database/index.md#tutor-workforce-history--migration-0105).

## Course demand growth and hiring

The Growth view tracks new demand, reactivation, churn losses and a twelve-month projection. A cohort is a student
starting a subject for the first time in retained history; moving levels within that subject does not create another
cohort. Hours are attributed to the recorded subject, curriculum and level. The March 2026 starting cohort is excluded
from growth averages because earlier history is unavailable. Trials and pretests are separate: the approved title
rules identify those terms, and other reviewed academic lessons count as regular. Unmapped lessons require review.

Churn requires 60 days without a taught class and no future booking in the subject. Lost monthly demand starts in the
month after the last taught class, using the three full months before that class's month as its baseline. For example,
an August final class uses May–July and records its loss in September after confirmation. Historic gaps without a
retained no-future-booking check are marked inferred. Missing months are unknown; fully covered empty months are zero.

New, reactivated and churned hours use the same three mature months. The projection starts from the latest completed
month and adds the average monthly net change, then applies the cancellation loss fraction once. Student-hours and
tutor-hours remain separate, with the observed group mix used for conversion. Known future commitments provide a
minimum requirement. The model shares each tutor's physical availability across all qualified subjects and allocates
the whole institution before applying academic display filters.
For each course and month, fixed bookings consume their actual times first. The remaining patterned demand is the
positive difference between the model and those bookings, so the requirement is their maximum rather than their sum.
The current month's forecast projects the latest offered recurrence across the whole calendar month; this does not
backfill measured historical availability.

Growth and hiring cover all teaching staff and delivery modes; role and mode breakdowns remain in the workforce
views. Course estimates show additional weekly hours, an optional buffer (initially 0%), and a hiring comparison.
Comparable tutors are all current qualified tutors and teaching admins with known offered schedules, including those
without classes, excluding people marked for departure. The benchmark shows average total offered hours and the
hours matching the shortage times. Fractional equivalents and rounded-up hires use matching hours; overlapping course
estimates must not be added together. Unknown availability or zero overlap does not produce a numeric hiring promise.

Charts lead each view. Definitions, source evidence and raw tables remain available through details. Scenario inputs
are computed on request and are not saved. All sources remain read-only toward Wise.

## Exclusions (never in the review list)

Wise ADMIN account (OFF-03, shown read-only under Staff accounts) · any upcoming class (OFF-04) · full-time tutor ·
identity conflict · never taught with an unknown joined date · new account under 60 days (OFF-05) · "Still with us"
until its snooze ends. Removal additionally needs the last class 45+ days ago (OFF-06) and fresh data (OFF-07).

## Data

- **Roster extras:** the snapshot sync writes `wise_relation`, `wise_joined_on`, `wise_course_count`, `wise_activated`
  onto `tutor_wise_accounts` after each promotion, best effort (`src/lib/tutor-onboarding/roster-facts.ts`; result in
  `sync_runs.metadata.rosterFacts`).
- **Reads:** Postgres only; signals cached per snapshot (`"use cache"`, tag `snapshot`); decisions, grants and
  freshness read fresh.
- **Freshness (OFF-07):** active snapshot ≤ 2 h old (judged by `snapshots.created_at`, because promoted runs are
  recorded `failed` whenever contact warnings exist); progress-test, post-class, Wise-activity and leave-request syncs
  ≤ 3 days since their last success.
- **Tables:** `tutor_offboarding_decisions`, `tutor_offboarding_access_grants`,
  `tutor_offboarding_access_audit_log`, and `tutor_offboarding_sheet_source` (migration 0102); removal runs and
  per-account snapshots (migration 0104).

## Removal controls (PR 2)

Only admins with a fresh `tutor_offboarding_access_grants` row can preview, apply, or reconcile. A preview rechecks
eligibility and live Wise roster/upcoming sessions, then expires after 15 minutes. Apply requires the saved preview
token, explicit confirmation, the exact account count, and a reason of at least ten characters. Wise requests use a
no-retry client and are sent only after a durable `sending` record. Reconciliation is read-only toward Wise; unknown
outcomes are settled by roster readback and are never resent. The local sync hook also reconciles after a successful
snapshot sync.

The default is manual mode. Live removal requires both `WISE_TEACHER_REMOVAL_VERIFIED=true` and
`VERCEL_ENV=production`; no code path switches an already previewed run between modes. Until the owner verifies the
endpoint with a controlled dummy teacher, use the checklist shown in the run result to remove accounts manually in
Wise. The application does not execute removals during deployment or background sync.

### Owner-operated endpoint probe and live-mode setup

The owner must create or approve a clearly labelled `ZZ BGS Removal Probe` teacher account they control, with no
courses and no sessions. After PR 2 is deployed in manual mode, the owner can run this command with that teacher's
Wise teacher-row id:

```bash
node --env-file=<production-env-file> --import tsx scripts/probe-wise-teacher-removal.ts \
  --teacher-id <24-character-teacher-id> --confirm remove-probe-teacher
```

The env file must supply `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE`, and `WISE_INSTITUTE_ID`; the script does
not load environment files implicitly. It refuses targets without the label or with any past or future sessions or
courses, sends exactly one no-retry removal request, then re-reads the roster. It prints only the safe request
outcome, HTTP status, readback, endpoint-verification result and next step. It never tries a teacher-row id after a
rejection. The owner should re-invite the dummy in Wise, record whether it returns with the same user id in
[`wise-api.md`](../reference/wise-api.md), and only after successful verification set
`WISE_TEACHER_REMOVAL_VERIFIED=true` in the Vercel **Production** environment and redeploy. Preview deployments and
local runs remain manual even if the flag is set. Deployment does not run the probe or remove any account.

## Page and access

Nav: Scheduling & Tutors → Tutor Offboarding. Admins with the page in `allowedPages` see the review list, Analytics,
the drawer, Still with us, staff accounts, exclusions and history. The owner (`SUPER_ADMIN_EMAILS`) also manages who may remove
tutors (OFF-11). API: [reference](../reference/api/tutor-offboarding.md).

**Endpoint semantics remain unverified** for teacher accounts until the owner completes the guarded dummy probe;
  `removeParticipant` has previously been documented for students only.
