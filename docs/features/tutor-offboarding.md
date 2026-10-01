# Tutor Offboarding

**Status: building (PR 1 read-only, 2026-10-01).** Removal from Wise arrives in PR 2 behind
`WISE_TEACHER_REMOVAL_VERIFIED`. Design: [spec](../superpowers/specs/2026-10-01-tutor-offboarding-design.md).

## Purpose

Admins rarely remove the Wise accounts of tutors who have left, so former tutors keep a working Wise login and
clutter Wise and BGScheduler. `/tutor-offboarding` ranks every person on the Wise roster by how likely they are no
longer with BeGifted, explains each score, and (PR 2) lets a granted admin remove them from the Wise institute.

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
last successful rows after a failed refresh. A development source read on 1 Oct found 80 rows, 27 marked terminated;
no production import or production sync has been verified. The page reads this source from Postgres and makes no
Sheets or Wise call.

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
  `tutor_offboarding_access_audit_log`, and `tutor_offboarding_sheet_source` (migration 0102).

## Page and access

Nav: Scheduling & Tutors → Tutor Offboarding. Admins with the page in `allowedPages` see the review list, the drawer,
Still with us, staff accounts, exclusions and history. The owner (`SUPER_ADMIN_EMAILS`) also manages who may remove
tutors (OFF-11). API: [reference](../reference/api/tutor-offboarding.md).

## Open items

- PR 2: preview → confirm → apply removal via `POST /institutes/{id}/removeParticipant`, manual mode until verified.
- `removeParticipant` is documented for students only; a labelled dummy-teacher probe must pass first.
