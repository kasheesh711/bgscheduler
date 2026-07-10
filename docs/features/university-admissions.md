# University Admissions Case Management

**Status: migrations deployed, code rollout blocked.** Production has migrations
`0053–0054`, but the admissions parity code is not deployed. Configure
`RESEND_API_KEY`, `ADMISSIONS_EMAIL_FROM`, `ADMISSIONS_EMAIL_REPLY_TO`, and
`NEXT_PUBLIC_APP_URL`, then pass `npm run check:admissions-production` before
deployment. Family portals remain closed.

> [PRD](../Casemanagementsystem_prd.md) ·
> [Design](../casemanagementsystem_design.md) ·
> [API](../reference/api/university-admissions.md) ·
> [Database](../reference/database/erd-university-admissions.md) ·
> [Rollout/import runbook](../operations/admissions-import-rollout.md)

## Purpose

`/admissions` replaces per-student BeGifted application workbooks with one
audited case workspace:

- counselors manage caseload, people/access, academics, college/application
  records, essays, activities, awards, testing, meetings, money, and notes;
- students complete their role-owned work in a mobile-first portal;
- parents receive a bilingual, view-only, family-approved projection;
- existing workbooks move through a one-time guided import and remain archives.

## Access and lifecycle

Roles are admin, assigned counselor, student, and parent. Case rights are
re-resolved from Postgres for every request; counselor revocation/deactivation
and member revocation are immediate.

Family access is opt-in. `family_portal_open` defaults false.

| Case state | Student/parent behavior |
|---|---|
| portal closed | denied |
| active/committed + open | normal role-shaped access |
| completed + open | read-only |
| withdrawn/archived | denied |

Valid staff transitions are active→committed, active→withdrawn,
committed→completed, completed→archived, and withdrawn→archived. A committed
application event writes the event, committed pointer, and case status
atomically.

Ordinary Google login asks only `openid email profile`. Sheets access is a
separate staff-only consent action; family Google tokens are never stored.

## People, invitations, and operations

People & Access supports counselor assignment/reassignment, parent addition,
email change, revoke, reactivate, and resend. Opening a portal or changing an
eligible open-portal family membership queues an invitation in the same
transaction as the state change.

The invitation outbox:

- attempts immediate delivery after commit;
- retries through the daily admissions-notifications cron;
- uses unique dedupe + Resend idempotency;
- records attempt/error/provider state for operator review;
- skips obsolete activated/revoked/replaced memberships.

The casework area also exposes lifecycle controls, Drive/external links,
admin audit history, direct messages, notification preferences, and workbook
import. Deadline reminders remain mandatory.

Direct messages are also outbox-backed: the client supplies a UUID
idempotency key, the message and audit row commit before provider delivery,
and failures remain visibly queued for cron retry. Replays cannot duplicate a
send, and the worker rechecks lifecycle, membership/email, and family-portal
eligibility before each attempt.

## Student record

### Academics

Strict, audited variants:

- US GPA scale, unweighted/weighted/core GPA, rank/size, rigor, four-year
  course plan, transcript and school-profile links;
- IB MYP/DP subjects/levels/predicted/final grades, TOK, EE, CAS, and totals
  out of 45;
- IGCSE/AS/A-level subjects, boards, predicted/achieved grades.

### Activities and awards

Activities keep Common App and UC blocks with hard character limits and
Common App top-ten rank. Awards are separate first-class rows with recognition/
grade levels, date, Common App top-five rank, UC 250/350-character narratives,
staff-only internal notes, and soft deletion.

### Testing

Sittings carry subject, status, regular/late registration dates,
accommodations, and typed scores:

- SAT and ACT subscores with derived aggregates/superscores;
- AP/IB subject scores;
- TOEFL/IELTS section scores with derived totals.

Only counselors release scores to parents. Unreleased values/details and
accommodations are absent from family data.

### Guided self-report

About You adds application-relevant demographic, household, school-history,
citizenship, language, and contact fields without passport or national-ID
numbers. College Criteria and Majors & Careers cover budget, geography, size,
climate, culture/support, Holland codes, values, skills, interests, and career
reflection.

## Colleges and applications

Each college supports:

- application round/deadline/state/category and append-only decision chain;
- first/second-choice majors plus admissions/portal URLs;
- structured sources, fit, visits, opportunities, questions, and notes;
- demonstrated-interest events;
- generic requirements for questions, honors, interviews, portfolios, SRAR,
  FAFSA, CSS Profile, scholarships, and other.

Essays, recommendations, transcripts/school reports, and score sends remain
canonical in their existing records. Generic requirements do not duplicate
them.

The legacy importer maps recognized transcript send states into the canonical
college-document record. Aggregate recommendation and test-send cells remain
in the archive with preview warnings because the workbook does not identify
the named recommender or test sitting; the importer never guesses those links.

The prompt catalog is keyed by institution, program, cycle, prompt key, word
limit, source URL, and verification. Selecting a prompt creates an essay
tracker row. Essay bodies remain in Google Docs.

## Money

Scholarships track provider/link/requirements/deadline/status/outcome/offered
amount/notes. Each college can have one COA, gift aid, work-study, loan, net
cost, and remaining-balance comparison with derived totals. Official
outcome/amount and financial-aid values are counselor-authoritative.

Application-portal passwords are never accepted or stored.

## Role-specific UI

Staff use five grouped, deep-linkable areas: Overview, Student, Colleges &
Applications, Money, and Casework.

Students retain the mobile bottom navigation. This Week actions link to the
target item; student surfaces include academics readout, awards, testing,
application completeness/events, and shared feedback.

Parents see profile/shared About You, academics, checklist/deadlines, colleges,
decisions/completeness/recommenders, essay metadata, activities, awards,
released tests, scholarships/aid, announcements, and shared notes. They have
sibling switching, visible role, language toggle, and sign-out, with no
mutation controls.

The closed projection excludes staff-only notes, audit, internal IDs/member
emails, Wise/OAuth, unreleased scores, accommodations, private reflection,
internal award notes, aid notes, and unshared essay links.

## Legacy workbook import

Counselor/admin pastes a copied student workbook URL after explicit read-only
Sheets consent. Preview reads bounded areas for Meetings, Tasks, About You,
Academics, Tests, Activities, Majors & Careers, College Criteria, Research
Notes, Demonstrated Interest, `ApplicationTracker!D33:DD52`, Essay Prompts,
Financial Aid, and Scholarships.

Preview is read-only and returns fingerprint, entity counts, field changes,
unresolved colleges, invalid values/dates, and character-limit issues. Commit
reloads the source, requires matching fingerprint and explicit preserve/
overwrite policy, then atomically writes targets, audit, issues, and mappings.
The Academics grid maps to validated US, IB, and A-Level/IGCSE records; values
that cannot be mapped without guessing stay visible in the legacy archive with
a preview warning. Stable worksheet coordinates and prior import mappings keep
changed-source reimports attached to their original targets.

Idempotency is case + spreadsheet id + source fingerprint. Repeating an
unchanged completed import is a no-op. Blank/formula/reference rows, hidden
lookup tabs, and portal-password cells are ignored. There is no ongoing sync.
All imported URL fields are checked again at preview and commit; non-web URLs
and URLs containing a username or password are blocking errors, and the
stored archive pointer is rebuilt from the verified spreadsheet id.
Imports are deliberately non-destructive: a removed source row is reported
for manual reconciliation and never auto-deletes its previously mapped target.

## Data, API, and verification

Migration `0053_nosy_spectrum.sql` adds worksheet-parity tables/columns and
extends the domain to 36 `admissions_*` tables. Migration
`0054_admissions_test_status_backfill.sql` safely changes live, still-planned
legacy sittings with a persisted score to `score_received` and unscored past
sittings to `taken`; deleted rows are untouched and future unscored sittings
remain `planned`. There are 34 admissions API
route-handler files plus the internal notification cron.

Coverage includes role/lifecycle matrices, revocation, closed portal,
parent leak tests, outbox idempotency/retry, academic/test/award validation,
migration constraints, import fingerprint/atomicity, API handlers, and
role-specific components.

## Rollout

1. `0053–0054` are already applied in production.
2. Configure the four currently missing production values.
3. Run `npm run check:admissions-production` until no blocker remains.
4. Deploy code with portals closed.
5. Pilot one fresh and one imported case across all four roles.
6. Verify email/outbox, audit, parent projection, and 375 px student flows.
7. Open portals case-by-case.

_Verified against the admissions parity implementation on 2026-07-10._
