# University Admissions API

Mechanical reference for `src/app/api/admissions/**` plus
`/api/internal/admissions-notifications`. The admissions namespace contains
**34 route-handler files**; the notification cron is one additional internal
handler.

All admissions handlers require an Auth.js session. Case routes then re-resolve
membership from Postgres; the JWT role claim is never the authority for a
case. Unless a row says otherwise, mutations follow:

1. session/authentication;
2. case or staff authorization;
3. JSON parsing;
4. Zod validation;
5. audited domain logic.

Family access also requires an open case portal. Completed cases are read-only
for students/parents; withdrawn and archived cases deny all family access.

## Error contract

| Status | Meaning |
|---|---|
| `400` | malformed JSON, query, or Zod-invalid payload |
| `401` | no authenticated admissions session |
| `403` | wrong role, unassigned/revoked member, closed family portal, forbidden lifecycle, or parent mutation |
| `404` | an authorized admin/staff request targets a missing case/entity |
| `409` | optimistic-concurrency conflict, invalid lifecycle, duplicate/idempotency conflict, missing Sheets connection, or source changed after preview |
| `422` | import preview contains blocking validation errors |
| `500` | unexpected server/configuration failure |

Non-admin case probing fails closed as `403` so it does not reveal whether a
case id exists.

## Cases, lifecycle, and people

| Method | Path | Minimum access | Contract |
|---|---|---|---|
| GET | `/api/admissions/cases` | counselor claim | Assigned caseload for counselors; all cases for admins. |
| POST | `/api/admissions/cases` | counselor claim | Create student, case, memberships, and checklist atomically. Family portal defaults closed. |
| GET | `/api/admissions/cases/[caseId]` | student | Staff/student case detail. Parent callers receive `403 Use parent dashboard`. |
| PATCH | `/api/admissions/cases/[caseId]` | assigned counselor | Update profile, Drive folder, and validated student external links; open/close the family portal; or perform one valid lifecycle transition. Supports optional `expectedUpdatedAt`. |
| GET | `/api/admissions/cases/[caseId]/members` | assigned counselor | All case memberships, including invited/revoked/bounced. |
| POST | `/api/admissions/cases/[caseId]/members` | assigned counselor | Add a parent or counselor member. |
| PATCH | `/api/admissions/cases/[caseId]/members` | assigned counselor | `revoke`, `reinvite`, or `change_email`. |
| GET | `/api/admissions/audit/[caseId]` | admin | Paginated append-only case audit history. |

Opening a portal, adding/changing an eligible family member while open,
reactivating, or resending queues an invitation in the transactional outbox and
attempts immediate delivery after commit.

Case lifecycle accepts only:

- `active → committed` or `active → withdrawn`;
- `committed → completed`;
- `completed → archived`;
- `withdrawn → archived`.

A committed application event is the canonical path for selecting the college;
it writes the event, committed pointer, and case status atomically.

## Checklist, meetings, calendar, and notes

| Method | Path | Minimum access | Contract |
|---|---|---|---|
| GET | `/cases/[caseId]/tasks` | student | Live checklist tasks and progress. |
| POST | `/cases/[caseId]/tasks` | counselor | Create custom student/counselor task. |
| PATCH | `/cases/[caseId]/tasks` | student, action-shaped | Student may change own student-owned status; staff manage/verify. |
| DELETE | `/cases/[caseId]/tasks?taskId=…` | counselor | Soft-delete an eligible custom task. |
| GET | `/cases/[caseId]/meetings` | student | Meeting log read; staff UI is the intended consumer. |
| POST | `/cases/[caseId]/meetings` | counselor | Log a meeting and optional action-item tasks. |
| PATCH | `/cases/[caseId]/meetings` | counselor | Update a meeting. |
| GET | `/cases/[caseId]/calendar` | student | Aggregated dated items for requested range/upcoming feed. |
| GET | `/cases/[caseId]/notes` | student | Role-shaped notes; staff-only bodies never reach family roles. |
| POST | `/cases/[caseId]/notes` | counselor | Create note with explicit `staff_only` or `shared_with_family` visibility. |
| PATCH | `/cases/[caseId]/notes` | counselor | Change note visibility/content through the supported action. |

Deadline reminders are mandatory; preference APIs do not expose a disable key.

## Student profile and records

| Method | Path | Minimum access | Contract |
|---|---|---|---|
| GET | `/cases/[caseId]/sections/[sectionKey]` | student | Definition plus saved state for a guided section. |
| PUT | `/cases/[caseId]/sections/[sectionKey]` | student | Partial autosave; supports explicit family-sharing state where authorized. |
| POST | `/cases/[caseId]/sections/[sectionKey]` | student | Submit; counselor action reviews. |
| GET | `/cases/[caseId]/academics` | student | List live academic records. |
| POST | `/cases/[caseId]/academics` | counselor | Create a validated academic record. |
| PATCH | `/cases/[caseId]/academics` | counselor | Update by `recordId`; optional `expectedUpdatedAt`. |
| DELETE | `/cases/[caseId]/academics?recordId=…` | counselor | Soft-delete an academic record. |
| GET | `/cases/[caseId]/activities` | student | Activity master list. |
| POST | `/cases/[caseId]/activities` | student | Create an activity. |
| PATCH | `/cases/[caseId]/activities` | student | Update or rank Common App top 10. |
| DELETE | `/cases/[caseId]/activities?activityId=…` | student | Soft-delete an activity. |
| GET | `/cases/[caseId]/awards` | student | Awards; internal notes appear only to staff. |
| POST | `/cases/[caseId]/awards` | student | Create award; internal notes are staff-only. |
| PATCH | `/cases/[caseId]/awards` | student | `update` or Common App top-five `rank` action; optimistic concurrency supported. |
| DELETE | `/cases/[caseId]/awards?awardId=…` | student | Soft-delete an award. |
| GET | `/cases/[caseId]/testing` | student | Live test sittings and derived best/superscore data. |
| POST | `/cases/[caseId]/testing` | student | Create a typed sitting. |
| PATCH | `/cases/[caseId]/testing` | student | Update sitting; score release is counselor-only. |
| DELETE | `/cases/[caseId]/testing?sittingId=…` | student | Soft-delete a sitting. |

### `AcademicRecordPayload`

The academic payload is a strict discriminated union:

- `system: "us"` — GPA scale, unweighted/weighted/core GPA, class rank/size,
  rigor, four-year course plan, transcript URL, and school-profile URL;
- `system: "ib"` — MYP/DP program, subjects/levels/predicted/final grades,
  TOK, extended essay, CAS, predicted/final totals out of 45, transcript and
  school-profile URLs;
- `system: "a_level_igcse"` — IGCSE/AS/A-level subjects, boards, predicted and
  achieved grades, curriculum notes, transcript and school-profile URLs.

### Typed test scores

`scoreDetails` is discriminated by test type:

- SAT math + reading/writing; total is derived;
- ACT English/math/reading/science (+ optional writing); composite is derived;
- AP/IB subject score;
- TOEFL four sections; total is derived;
- IELTS four sections; half-point overall is derived;
- other score + optional scale.

The sitting also carries `status`, subject, regular and late registration
deadlines, accommodations, release flag, and soft deletion. Accommodations and
unreleased scores are never in the parent DTO.

## Colleges, applications, and essays

| Method | Path | Minimum access | Contract |
|---|---|---|---|
| GET | `/cases/[caseId]/colleges` | student | College rows, IPEDS enrichment, completeness, warnings, majors, and URLs. |
| POST | `/cases/[caseId]/colleges` | counselor | Add IPEDS-backed or manual college. |
| PATCH | `/cases/[caseId]/colleges` | counselor | Update round/deadline/status/category/majors/URLs and staff fields with concurrency token. |
| DELETE | `/cases/[caseId]/colleges?itemId=…` | counselor | Soft-delete a list item. |
| GET | `/cases/[caseId]/colleges/[itemId]/events` | student | Append-only application/decision event chain. |
| POST | `/cases/[caseId]/colleges/[itemId]/events` | counselor | Append an event; `committed` couples case transition atomically. |
| GET | `/cases/[caseId]/recommenders` | student | Recommenders, college links, and document-send state. |
| POST | `/cases/[caseId]/recommenders` | counselor | Create recommender. |
| PATCH | `/cases/[caseId]/recommenders` | counselor | Update/link/submission/college-document actions. |
| DELETE | `/cases/[caseId]/recommenders?recommenderId=…` | counselor | Soft-delete recommender. |
| GET | `/cases/[caseId]/essays` | student | Essay metadata, staleness, and sharing flag. |
| POST | `/cases/[caseId]/essays` | student | Create essay tracker row. |
| PATCH | `/cases/[caseId]/essays` | student | Student fields; counselor-only stage/deadline/link/share fields. |
| DELETE | `/cases/[caseId]/essays?essayId=…` | counselor | Soft-delete essay. |
| POST | `/cases/[caseId]/essays/from-prompt` | student | Create a case essay from one active prompt; duplicate prompt/college pair conflicts. |

Writing remains in Google Docs. The API stores metadata and links only.

## Research, interest, and generic requirements

| Method | Path | Minimum access | Contract |
|---|---|---|---|
| GET | `/cases/[caseId]/colleges/[itemId]/research` | student | Structured research/fit record or null. |
| PATCH | `/cases/[caseId]/colleges/[itemId]/research` | student | Upsert fit 1–5, sources, visit, academics, opportunities, questions, and notes; optional concurrency token. |
| GET | `/cases/[caseId]/colleges/[itemId]/interest-events` | student | Live demonstrated-interest events. |
| POST | same | student | Create typed/date event. |
| PATCH | same | student | Update event with optional concurrency token. |
| DELETE | same + `?eventId=…` | student | Soft-delete event. |
| GET | `/cases/[caseId]/colleges/[itemId]/requirements` | student | Generic requirements. |
| POST | same | counselor | Create a student- or counselor-owned requirement. |
| PATCH | same | student, ownership-shaped | Student may update only the status of a student-owned row; definition fields, verification, and counselor-owned rows require counselor. |
| DELETE | same + `?requirementId=…` | counselor | Soft-delete requirement. |

Requirement kinds are college questions, honors program, interview, portfolio,
SRAR, FAFSA, CSS Profile, scholarship, and other. Essays, recommendations,
transcript/school report, and score sends remain canonical in their existing
tables and are not duplicated as generic requirements.

## Money

| Method | Path | Minimum access | Contract |
|---|---|---|---|
| GET | `/cases/[caseId]/colleges/[itemId]/financial-aid` | student | One college aid offer or null, including derived totals. |
| PUT | same | counselor | Upsert currency/year, cost/gift/loan breakdowns, work-study, net cost, remaining balance, notes. |
| GET | `/cases/[caseId]/scholarships` | student | Live case scholarships. |
| POST | same | student | Create scholarship; outcome and offered amount are counselor-only. |
| PATCH | same | student, field-shaped | Update; outcome/amount remain counselor-only. |
| DELETE | same + `?scholarshipId=…` | student | Soft-delete scholarship. |

Money payloads never include or accept application-portal passwords.

## Prompt catalog

| Method | Path | Minimum access | Contract |
|---|---|---|---|
| GET | `/api/admissions/prompt-catalog` | authenticated admissions user | Filter by institution, cycle, and unitId; max 500. Student/parent reads are forced to active entries and omit staff attribution/timestamps. Only a currently authorized counselor/admin may request inactive entries. |
| POST | same | counselor | `create` or `update` action; optional verification attribution and optimistic concurrency. |

Catalog identity is unique on institution + program + cycle + prompt key.

## Family projection and communications

| Method | Path | Minimum access | Contract |
|---|---|---|---|
| GET | `/cases/[caseId]/parent-dashboard` | linked parent | Closed `ParentDashboard` projection only. |
| GET | `/api/admissions/family-cases` | parent claim | Safe child-switching list for active parent memberships on open, accessible cases. |
| GET | `/api/admissions/notification-preferences?caseId=…` | active case member | Current digest prefs; deadline reminders always return `mandatory`. |
| PATCH | `/api/admissions/notification-preferences` | mutable active/committed case member | Set announcements/tasks/comments to default, digest, or off. Completed family cases remain read-only. |
| POST | `/cases/[caseId]/messages` | counselor | Queue one direct email to an active case member. Body requires `recipientMemberId`, a client-generated UUID `idempotencyKey`, `subject`, and `body`; response reports `sent`, retryable `queued`, or terminal `superseded` state plus `outboxId`. |

Direct messages use the same transactional notification outbox as invitations.
The outbox row and append-only `queue` audit entry commit before any Resend
call. An identical idempotency-key replay returns the original row; reusing the
key with changed recipient/content conflicts. Immediate provider failure does
not fail the accepted message: the response reports `queued: true` and the
admissions-notifications cron retries it. Before every attempt, the worker
rechecks active membership, current email, case lifecycle, and (for students
and parents) that the family portal is still open.

`ParentDashboard` explicitly includes profile/shared About You, academics,
progress, phase progress, checklist, colleges/decisions/requirements/
completeness, recommenders, essay metadata, activities, awards, deadlines,
announcements, released testing, scholarships, financial-aid comparisons, and
shared notes.

It excludes staff-only notes, audit rows, member emails, internal ids,
Wise/OAuth data, accommodations, unreleased scores/details, private reflection,
internal award notes, financial-aid notes, and unshared Google Docs links.

## Legacy workbook import

| Method | Path | Minimum access | Contract |
|---|---|---|---|
| GET | `/cases/[caseId]/imports` | counselor | Import-run history for the case. |
| POST | same, `action: "preview"` | counselor + connected Sheets | Load bounded workbook ranges and return fingerprint, counts, changes, records, and issues. No writes. |
| POST | same, `action: "commit"` | counselor + connected Sheets | Reload source, require matching fingerprint and explicit conflict policy where needed, then commit atomically. |

Commit fields:

- `spreadsheetUrl`;
- `expectedFingerprint` (64-character SHA-256);
- `conflictPolicy` = `preserve_existing` or `overwrite_existing`.

The source identity is the Google spreadsheet id. The database idempotency key
is case + spreadsheet id + source fingerprint. Recommitting the same completed
fingerprint is a no-op. A changed workbook must be previewed again.

Supported bounded areas: Meetings, Tasks, About You, Academics, Tests,
Activities, Majors & Careers, College Criteria, Research Notes, Demonstrated
Interest, `ApplicationTracker!D33:DD52`, Essay Prompts, Financial Aid
Comparisons, and Scholarship Tracker.

The parser ignores blank template rows, formula/reference-only data, hidden
master tabs, and application-portal password cells. Blocking issues produce
`422`. Target writes, import ledger/mappings, and audit attribution share one
transaction.

Academics preview records use the same discriminated US/IB/A-Level payloads as
the case academics API. Other mutable worksheet entities carry stable source
coordinates; a changed-source commit resolves the latest prior mapping before
falling back to a natural key, and the preview compares against that same
target.

## Cross-case administration and content

| Method | Path | Access | Contract |
|---|---|---|---|
| GET/POST/PATCH/DELETE | `/api/admissions/announcements` | case reads student; case writes counselor; cohort writes staff | Case/cohort announcements. |
| GET/POST/PATCH/DELETE | `/api/admissions/resources` | authenticated read; staff write | Global resource library. |
| GET/POST | `/api/admissions/cohorts` | counselor read; admin create | Cohort registry. |
| GET/POST/PATCH | `/api/admissions/cohorts/[cohortId]/templates` | counselor read; admin mutate | Versioned checklist templates/publish/push. |
| GET/POST/PATCH | `/api/admissions/counselors` | admin | Global counselor registry and activation state. |

## Notification cron

`GET|POST /api/internal/admissions-notifications` is protected by a
constant-time `Bearer $CRON_SECRET` check. Vercel invokes GET daily at 01:12 UTC
(08:12 Bangkok). Optional `runType=daily|weekly` selects one pass.

Daily processing:

1. retries due invitation outbox rows;
2. scans mandatory 7-day/48-hour deadline reminders;
3. applies the three-interrupt-per-recipient/day collapse rule;
4. records deduped sends and finalizes the run.

On Bangkok Sunday, the default invocation also sends the weekly digest. A
partial unique index permits one running notification pass; abandoned runs are
failed after 30 minutes. The route returns `202` when all requested passes were
already running/skipped.

Production requires `RESEND_API_KEY`, a verified
`ADMISSIONS_EMAIL_FROM`, a monitored `ADMISSIONS_EMAIL_REPLY_TO`, and a valid
`CRON_SECRET`.

_Verified against the admissions parity branch on 2026-07-10._
