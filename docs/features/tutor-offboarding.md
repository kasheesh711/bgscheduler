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

## Analytics (history from 1 March 2026)

The Analytics tab reports completed teaching activity from 1 March 2026 onward, current roster status, matched
termination evidence, scored-but-unmarked idle gaps, current qualifications and scheduled class impact. It is a
read-only Postgres report and does not fetch Sheets or Wise data.

This dataset cannot calculate an HR turnover rate: the termination sheet records a marked status but no effective
separation date, and the compiled sources do not provide a reliable opening employee headcount for 1 March. The report
therefore keeps `actualRate` unavailable. Its two labelled observed-teaching-cohort shares use as denominator distinct
non-ADMIN tutors with at least one `ENDED` class since 1 March. The first numerator is matched Sheet-confirmed people
in that cohort; the second adds unmarked very-likely people. These are scenario shares, not turnover rates or
confirmed-exit rates. The inferred group is score-based and never merged into the Sheet-confirmed group. Matched,
unmatched and pending identities remain separate from score bands; source confirmation and idle-gap likelihood
describe different evidence.

Counts use canonical people, so a tutor's online and onsite Wise accounts count once. Wise `ADMIN` accounts are
excluded from the tutor denominator. Full-time office attendance is a separate, potentially overlapping flag; a
full-time tutor with an `ENDED` class remains in the denominator. Monthly activity counts distinct people with an
`ENDED` class and ended sessions; it is observed teaching activity, not an employee roster count. Partial months are
flagged.

Course analysis uses observed classes and available future schedules, while qualification coverage comes from the
current snapshot's `subjectLevelQualifications`. A tutor with a qualification is not necessarily available to teach.
For each qualification, the report compares current qualified people with the remaining names after the marked-only
and marked-plus-inferred scenarios. Future classes are shown separately as pending load and are not treated as
completed teaching or guaranteed replacement capacity. Per-course upcoming counts include only marked or inferred
people assigned to that course, with separate marked and inferred counts; historical teaching totals include all
identified tutors on the course. Other historical tutors are not assumed to be available replacements. Wise
`courseCount` and `wiseCourseCategory` are operational course metadata; Wise's subject-like course field is a pricing
band, not an academic subject. Missing qualifications, identity conflicts, unresolved historical sessions and
future session records without course IDs are reported as data limitations.

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
