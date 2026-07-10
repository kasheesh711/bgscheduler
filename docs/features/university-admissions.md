# University Admissions Case Management

**Status: built, pre-deploy** — all six design phases are implemented on the `feat/admissions` branch (phases 1–5 committed, phase 6 resources/docs in the working tree). Not yet merged to `main`; the `admissions_*` migrations have not been applied to production and the `admissions-notifications` cron only fires after deploy.

> **PRD:** [Casemanagementsystem_prd.md](../Casemanagementsystem_prd.md) · **Design doc:** [casemanagementsystem_design.md](../casemanagementsystem_design.md) · Requirements are cited as `CM-xx` (PRD §4) and design sections as `§n`.

## Purpose

University Admissions is the counselor case-management workspace that replaces BeGifted's per-student "SummitEd - {Student}" Google Sheets workbooks. The sheet model did not scale: undated freeform notes, self-reported checkboxes with no verification, no caseload overview, no parent visibility without sharing the whole workbook, and no audit trail on sensitive data (GPA, test scores). This feature moves the whole admissions record into BGScheduler so that:

- **Counselors** (including external partners such as SummitEd staff) run their assigned cases end-to-end — checklist, college list, applications and decisions, essays, activities, testing, meetings, notes — from a desktop-dense workspace at `/admissions`.
- **Students** self-serve their own sections from their phones: tick tasks, update essay status, manage activities and test sittings, and fill guided self-report forms.
- **Parents** answer "where are we?" from a view-only, Thai-first curated dashboard without messaging staff.
- The company gains a durable, auditable admissions record across cycles (decision chains, aid, matriculation are queryable year-over-year).

There is deliberately **no migration** from the old sheets (PRD decision 4): existing workbooks remain a read-only archive; new cases start fresh here.

## Roles & access model

Four roles (PRD §2, decision 1): `admin` (existing allowlist, sees everything), `counselor` (**new role** — hard-walled to assigned cases, full edit within a case), `student` (own case, self-report sections only), `parent` (own child's case, view-only). Access is enforced in three independent layers, each fail-closed:

1. **Sign-in resolution** (`resolveUserAccess`, `src/lib/auth-access.ts`, with the admissions steps in `resolveAdmissionsRole`, `src/lib/admissions/access.ts:37`): `admin_users` → active `admissions_counselors` registry row → tutor contact (teacher) → active `admissions_case_members` row on any case → **deny sign-in**. Counselor/student/parent JWTs carry `allowedPages: ["/admissions"]` only. An email that is a student on one case and a parent on another gets the student claim globally — actual rights stay per-case. All roles use Google OAuth (decision 18 — no magic links, no LINE Login in v1); parent onboarding is assisted at the intake meeting.
2. **Per-request membership re-resolution** (`requireCaseAccess`, `src/lib/admissions/access.ts:117`): every case-scoped `/api/admissions/*` request re-queries Postgres — the JWT role claim is *never* trusted for rights. Revocation is instant; a tampered `caseId` yields 403; non-admins get `Forbidden` (never `NotFound`) for missing cases so case existence does not leak; a counselor membership additionally requires an *active* registry row (deactivating a counselor kills their access everywhere at once). Role ordering for `minRole` is `parent < student < counselor < admin` (`roleAtLeast`, `src/lib/admissions/config.ts:27`). Cross-case surfaces with no single `caseId` (cohorts, counselors, announcements, resources, audit) use `requireCounselorOrAdmin` (`access.ts:196`), likewise resolved from Postgres per request. Guard/domain errors map to 401/403/404/409/500 via `admissionsErrorResponse` (`access.ts:227`).
3. **Parent projection** (`buildParentDashboard`, `src/lib/admissions/parent-projection.ts:225`): parent-facing responses are built **exclusively** by this whitelisted DTO builder — parent routes never serialize raw case tables. Every field is assembled field-by-field (no row spreads), so adding a column upstream can never leak to parents without a deliberate edit to this one file. Forbidden by construction: aid amounts/notes, counselor commentary (`counselorStage`, `staff_only` note bodies), per-college completeness detail, unreleased scores, member emails, `wiseStudentKey`, and anything audit-related. The raw test `score` key is **omitted entirely** (never `null`) unless the counselor released it — unreleased scores leave no trace in the serialized payload.

The write matrix (design §2.4): self-report surfaces (About-You sections, activities, essay status/prompt/Drive link, testing self-entries, own task ticks) are student-writable; academics, college list, application decisions, announcements, notes, membership, and lifecycle are counselor+; template/counselor/cohort management is admin-only; parents write nothing anywhere. Counselor edits to student sections are allowed but always **attributed** via the audit `actorRole` — never disguised as the student.

Every sensitive mutation (academics-tier data, college list, decision events, membership, lifecycle, visibility) commits **atomically with its append-only audit row** via `withAuditedTransaction` (`src/lib/admissions/audit.ts:82` — Drizzle transaction with a node-postgres fallback, same pattern as payroll sync); field-level `{old, new}` diffs come from `computeFieldDiff` (`audit.ts:119`). Low-stakes writes (task ticks) audit fire-and-forget. `admissions_audit_log` has no update/delete code path; admins read it paginated at `GET /api/admissions/audit/[caseId]` (CM-140).

## Case lifecycle

`active` → `committed` → `completed`; `active` → `withdrawn`; `completed`/`withdrawn` → `archived`; nothing leaves `archived` and same-status writes are rejected (`CASE_LIFECYCLE_TRANSITIONS`, `src/lib/admissions/cases.ts:96`; applied + audited by `updateCaseLifecycle`, `cases.ts:744`). Transitions are staff-only. One live case per student is enforced by a partial unique index (status in active/committed). Family portal routing (`getCaseIdForStudentEmail` / `getCaseIdForParentEmail`, `cases.ts:520`/`:539`) resolves only **live** (active/committed) cases — a parent with multiple live cases (siblings) lands on the newest and the per-request guard still governs each case. Retention is **indefinite** (PRD decision 19): no purge cron in v1; the Thai-PDPA risk of holding minors' academic records long-term is an explicitly accepted, documented business decision (PRD §5 lists the revisit triggers; soft-delete columns exist to honor a deletion request). No Thai national IDs or passport numbers are collected.

## Conceptual data model

25 tables, all prefixed `admissions_`, defined in `src/lib/db/schema.ts` (from `admissionsCohorts` at `:2989`) with 14 domain enums. The grain: a **cohort** ("Class of 2027") owns checklist templates and broadcast announcements; a **student** (standalone entity — not a Wise record) has at most one live **case**; a case owns members, tasks, meetings, college list items (each with an append-only decision-event chain), recommenders (+ per-college links and doc sends), essays, activities, test sittings, notes, self-report sections, and its slice of the audit log. `admissions_counselors` is the global sign-in registry; `admissions_resources` is a global library; `admissions_notification_log`/`_runs` back the email pipeline. Column-level detail, indexes, and ER diagrams live in the database reference (canonical home): [docs/reference/database/erd-university-admissions.md](../reference/database/erd-university-admissions.md).

**Wise soft-reference stance:** `admissions_students.wiseStudentKey` is an informational text column — never a foreign key into the snapshot tables, never joined at read time, and never shown to parents. Admissions data survives snapshot rotation untouched and imposes zero coupling on the sync pipeline (PRD §7 rules out hard FK coupling to Wise).

## Checklist & templates

The 10 canonical phases mirror the SummitEd workbook: About You → Academics → Testing → Activities & Awards → College Research → Essays → Recommendations → Applications → Decisions & Financial Aid → Transition to College (`ADMISSIONS_CHECKLIST_PHASES`, `src/lib/admissions/config.ts:37`; the ~50-item default seed is `DEFAULT_CHECKLIST_ITEMS` in the same file).

Template versioning semantics (CM-20/21, `src/lib/admissions/checklists.ts`):

- Templates are **immutable once published** — there is no item-edit path at all; "editing" means `createTemplateVersion` (`:304`, version = max + 1) followed by `publishTemplate` (`:390`).
- Case creation **copies** the cohort's latest published template's items into `admissions_case_tasks` (snapshot semantics — stamped with `templateId`/`templateVersion`/`itemKey`; `instantiateChecklist`, `:584`), seeding the default template when the cohort has none. Publishing a new version never mutates existing cases.
- `itemKey` is the stable identity that survives versions; the explicit admin action `pushNewItemsToCohortCases` (`:670`) appends only items whose `itemKey` a case does not already have.
- Tasks carry owner (student/counselor/parent), optional due date, status (not started / in progress / done), and a counselor **verified** flag valid only on student-owned items (CM-22). Students may update status **only** on student-owned tasks of their own case; custom tasks (with weekly/biweekly recurrence) and verification are counselor+; template-derived tasks cannot be deleted. Progress % counts done items with verification surfaced separately (CM-24, `computeProgress`, `:1190`).

## College list & applications

`src/lib/admissions/colleges.ts`. US rows **soft-reference** `ipeds_institutions` by `unitId` — never a UUID FK — and denormalize name/city/state at add time; reads join the **latest** IPEDS `dataYear` live and fall back to the denormalized copy with `stale: true` when the `unitId` no longer resolves (CM-40 — a yearly IPEDS re-import can therefore never break a list). Non-US/manual rows are free-text name + country with `isManual: true`. Staff can add an institution from any `/us-universities` surface (browse table, dossier, shortlist) via the `AddToCaseMenu` (`src/components/admissions/add-to-case-menu.tsx`, CM-41), which defaults the row to Regular Decision and hides itself permanently on a 401/403.

- **Decision chains (CM-43):** decisions are an append-only chain of dated events (submitted / deferred / waitlisted / accepted / denied / withdrawn / committed) in `admissions_application_events` — deferred→accepted is two rows, both preserved; events are never edited. `deriveLatestEvents` (`colleges.ts:850`) reduces the chain to the current state for warnings and the UI chips.
- **Committed pointer (CM-44):** exactly one committed college per case — `admissions_cases.committedListItemId` and the `committed` event commit in one transaction (`setCommittedCollege`, `:901`); a second commit while another item holds the pointer is a 409 Conflict.
- **ED/REA warnings (CM-45):** `computeApplicationWarnings` (`:1037`) is pure and **warns, never blocks** — >1 active ED/ED2, or REA alongside any ED. Items whose latest event is `denied` or `withdrawn` are inactive for warning purposes, so ED-denied → ED2 is a legal, warning-free plan.
- Round/deadline/status/category/aid live on the list item; updates use `expectedUpdatedAt` optimistic concurrency (mismatch → 409 with both versions surfaced to the UI). All list/application writes are counselor+.

**Recommenders & completeness** (`src/lib/admissions/recommenders.ts`): `askStatus` is a forward-only state machine (planned → asked → agreed | declined, terminal; invalid moves → Conflict, CM-50); one link row per (recommender, list item) with per-college submitted status (CM-51). Per-college completeness (CM-46) rolls up recommender submissions plus `admissions_college_docs` rows keyed (listItemId, docType, testSittingId|null) — `score_send` rows require a sitting id, transcript/school-report rows forbid one. Cross-case references (a recommender linked to another case's list item, a score send referencing another case's sitting) read as `NotFound`, so ids cannot be probed across cases.

## Essays

`src/lib/admissions/essays.ts` (CM-60..63). Writing stays in Google Docs — `driveUrl` is a pointer, never content (decision 9). **Staleness** is derived at read time: whole days since `lastStudentUpdateAt` (null when the student never touched the row); *only student mutations* stamp the staleness clock — counselor edits never do, so the badge always means "days since the student last worked on this." `counselorStage` is a separate counselor-confirmed field; staff views read `effectiveStage = counselorStage ?? status` (CM-62). The list sorts by the deterministic CM-63 key (`listEssaysForCase`, `:505`): dated rows first, deadline ascending (longest-overdue at the top), ties broken by staleness descending with never-touched counting as most stale. Students may create rows and edit status/prompt/driveUrl; `counselorStage`/deadline/college link are counselor+.

## Activities

`src/lib/admissions/activities.ts` (CM-70..72). One master list per case capped at 20 live rows (`MAX_ACTIVE_ACTIVITIES_PER_CASE`, `:57`); each activity has an unlimited internal description plus platform variant blocks with **hard** character limits — Common App (position ≤50, organization ≤100, description ≤150 chars, hrs/week 0–168, weeks/year 0–52, grade levels, timing) and UC (description ≤350 chars, official category). Zod rejects overflow at the API and the UI counters mirror the same exported constants, so the copy can never exceed what the real application accepts. Students drag-rank a persisted "Common App top 10" (`setCommonAppRanks`; at most 10 ids, ranks 1..n, unlisted ranks cleared, re-submitting the same order is a no-op). Per-field copy-to-clipboard (CM-72) is UI-only. Students own this list end-to-end (create/edit/delete/rank).

## Testing & score release

`src/lib/admissions/testing.ts` (CM-80..83). Test records are planned/completed **sittings** (SAT/ACT/AP/IB/TOEFL/IELTS/other) with a registration deadline auto-derived from per-type lead days (`REGISTRATION_LEAD_DAYS`, `:118`, e.g. SAT −35d) and always editable. Registration deadlines and test dates feed the deadline calendar (CM-81). Score sends per college live in `admissions_college_docs`, never duplicated here. The **release gate** (CM-83): `scoreReleasedToParent` is counselor-only — a student or parent attempt throws Forbidden; raw scores stay staff+student until released, and the parent projection then surfaces milestones (registered / taken / score received) with the numeric score attached only for released, numerically-parseable scores.

## Meetings & notes

- **Meetings** (`src/lib/admissions/meetings.ts`, CM-30..32) are a staff-only, first-class log per case: date, mode (Zoom/in-person/LINE), attendees, structured notes, next-meeting date. Meeting action items create case tasks with owners and due dates (CM-31), and "days since last touch" derives from the meeting log to feed caseload triage (CM-32).
- **Notes** (`src/lib/admissions/notes.ts`, CM-91) carry a visibility enum that is `NOT NULL` **with no default** — every write is an explicit `staff_only` | `shared_with_family` choice; the UI composer forces the selection (no silent default). `staff_only` rows reach only counselor/admin readers, enforced in the SQL filter *and* re-checked on the fetched rows; the parent projection re-filters a third time (defense in depth — a counselor note leaking to a family is the PRD's highest-severity failure mode).

## Announcements & resources

- **Announcements** (`src/lib/admissions/announcements.ts`, CM-90) are cohort-scoped (broadcast) XOR case-scoped — exactly one scope, enforced in code and by a check constraint. They are family-visible **by design**; there is deliberately no visibility enum here (audience shaping belongs to notes). Writes are counselor+; they surface on the staff overview, the student home, and the parent dashboard, and feed the weekly digest.
- **Resources** (`src/lib/admissions/resources.ts`, CM-92) are a global, case-independent curated link library grouped by the 10 phase keys plus a "general" bucket; rows with an unknown topic are never dropped or re-bucketed — they surface after "general" so bad data stays visible. Counselor/admin write, students read.

## Self-report sections & student home

- **Guided forms** (`src/lib/admissions/sections.ts`, CM-121): the About-You family from the source sheet — `about_you`, `q_and_a_survey`, `personality`, `random_facts`, `essay_moments`, `majors_reflection`. Definitions are code, not data; payloads validate against them on every write (unknown keys rejected). Autosave merges partial payloads; a no-change save writes nothing. State machine: draft → submitted → reviewed; **submit is the only notify event**, and any effective edit to a submitted/reviewed section drops it back to draft (counselor must re-review). A case with no row reads as an empty draft.
- **Student home** (`src/lib/admissions/student-home.ts`, CM-120): "This Week" merges three ranked sources — open calendar deadlines (overdue or due ≤7 days), stale-essay nudges (untouched ≥14 days with a deadline ≤30 days out), and unsubmitted-section nudges — into a deterministic capped list (`buildThisWeek`, `:128`). Phase rings are **season-scoped** (`getPhaseProgress`, `:274`): Applications unlocks in August of senior year, Decisions & Aid in December, Transition in senior spring; zero-task phases are omitted. The global % lives on staff/parent views only.

## Deadlines & calendar

`src/lib/admissions/calendar.ts` (CM-100..102) aggregates every dated item — task due dates, application-round deadlines, essay deadlines, test registrations and sittings — through a source-agnostic collector contract (`CALENDAR_COLLECTORS`; adding a source = appending one collector). All dates are `"YYYY-MM-DD"` compared on the Asia/Bangkok calendar; malformed dates are skipped, never guessed. The per-case calendar renders a month grid on desktop and a week-grouped list on mobile; counselors also get cross-case upcoming deadlines on the caseload; every dashboard carries an upcoming-deadlines panel with overdue flagged.

## Notifications

`src/lib/admissions/notifications.ts` (design §7, CM-110..112). Transport is the Resend API over plain `fetch` (mirroring the classroom schedule-email discipline); every send is recorded in `admissions_notification_log`, and a `dedupeKey` rides a partial unique index so keyed sends happen **exactly once** even across re-runs.

- **Two tiers** (CM-110): *interrupt* — counselor direct messages, member invites, and deadline reminders at T-7d and T-48h for items assigned to the recipient; *batch* — the weekly digest (announcements, new tasks, self-report section submissions — role-shaped per recipient; members whose shaped digest is empty receive nothing), sent on Bangkok Sundays.
- **Daily cap** (CM-111): more than 3 interrupts per recipient per Bangkok day collapse into **one** combined email (`INTERRUPT_DAILY_CAP`, `:55`).
- **Non-disableable reminders** (CM-112): per-category `notificationPrefs` downgrades apply to digest content only; deadline reminders have no pref key and can never be turned off (fail-closed).
- **Invites** (PRD §3.7): bilingual Thai-first, containing only the child's *first* name and the sign-in link — no case data; access activates only on exact email match at sign-in, so the invite itself grants nothing. Member status (invited/active/revoked/bounced) supports one-click re-invite (`sendMemberInvite`, `:731` — deliberately not deduped).
- **Cron**: one path, `GET/POST /api/internal/admissions-notifications` (CRON_SECRET, `maxDuration 300`), scheduled `12 1 * * *` in `vercel.json` (08:12 Bangkok, staggered against the other crons). Every invocation runs the daily deadline scan; on Bangkok Sundays it also runs the weekly digest; an explicit `runType` runs one pass manually. Runs are single-flighted through `admissions_notification_runs` (partial unique index on `status='running'`, stale rows failed after 30 minutes) — the same discipline as the other sync lineages. See [docs/reference/crons.md](../reference/crons.md).

## UI

Three audience-shaped surfaces hang off two routes. `/admissions` (`src/app/(app)/admissions/page.tsx`) routes by role: staff get the caseload workspace; students and parents are redirected to their own case; family members with no live case get a friendly empty state; any other role (e.g. teacher) is denied. `/admissions/[caseId]` runs `requireCaseAccess` per navigation (deliberately **no** `"use cache"` on either page — revocation must be instant and caseloads are per-user) and renders the shell matching the visitor's role.

- **Staff caseload** (`src/components/admissions/caseload-shell.tsx`, CM-02): header KPIs + a Table ↔ Board toggle — sortable/filterable table (student, cohort, counselor, status, progress %, next deadline, days since last touch) and a kanban board grouped by case status. Case creation (`create-case-dialog.tsx`) captures student, parent email(s), and counselor(s) in one step (CM-01).
- **Staff case shell** (`src/components/admissions/case-detail-shell.tsx`): sticky case header + the 10 canonical tabs (Overview / Profile / Checklist / Colleges / Applications / Essays / Activities / Testing / Meetings / Notes), with the active tab in the URL (`?tab=`). Colleges carries the completeness column and the ED/REA warning banner; Applications is the decision-event timeline + committed selector.
- **Student portal** (`src/components/admissions/student/portal-shell.tsx`, CM-120..122): mobile-first single column, fixed 5-item bottom nav (Home / Tasks / Colleges / Essays / More; ≥44px targets, safe-area padding, no horizontal scroll at 375px). Colleges is read-only for students (list composition is counselor work); More stacks Activities, Testing, Self-report sections, and Resources as full-screen sub-views. No staff affordances exist in this shell at all.
- **Parent dashboard** (`src/components/admissions/parent/parent-dashboard.tsx`, CM-130/131): a single-scroll, read-only page — progress, college list (name/round/status only), upcoming deadlines, announcements, released testing milestones, shared notes. Every **static** string is a `{th, en}` pair rendered Thai-first with a persisted toggle (`parent/strings.ts`); data values are verbatim, never translated. No mutations, no links to staff surfaces.

Design system: existing tokens only — sky-blue OKLCH palette, Inter, shadcn/ui primitives, lucide icons; semantic status colors reuse the `--available`/`--blocked`/`--conflict` conventions for accepted/denied/waitlisted.

## API surface

21 route files under `src/app/api/admissions/**` plus the internal cron. All require a session; case-scoped routes run `requireCaseAccess` before body parsing; mutations follow the repo's 4-step convention. Full request/response contracts live in the API reference (canonical home): [docs/reference/api/university-admissions.md](../reference/api/university-admissions.md).

| Route | Methods | Purpose |
|---|---|---|
| `/api/admissions/cases` | GET, POST | Caseload (role-scoped); create case |
| `/api/admissions/cases/[caseId]` | GET, PATCH | Case detail (role-shaped); profile + lifecycle updates |
| `…/[caseId]/members` | GET, POST, PATCH | Membership add/revoke/re-invite/email-change |
| `…/[caseId]/tasks` | GET, POST, PATCH, DELETE | Checklist tasks, verification, custom tasks |
| `…/[caseId]/meetings` | GET, POST, PATCH | Meeting log + action items |
| `…/[caseId]/colleges` | GET, POST, PATCH, DELETE | College list rows |
| `…/[caseId]/colleges/[itemId]/events` | GET, POST | Decision-event chain (incl. committed) |
| `…/[caseId]/recommenders` | GET, POST, PATCH, DELETE | Recommenders, per-college submissions, doc sends |
| `…/[caseId]/essays` | GET, POST, PATCH, DELETE | Essay tracker |
| `…/[caseId]/activities` | GET, POST, PATCH, DELETE | Activities + Common App ranking |
| `…/[caseId]/testing` | GET, POST, PATCH, DELETE | Test sittings + score release |
| `…/[caseId]/notes` | GET, POST, PATCH | Notes (explicit visibility) |
| `…/[caseId]/sections/[sectionKey]` | GET, PUT, POST | Guided self-report forms (POST = submit) |
| `…/[caseId]/calendar` | GET | Aggregated per-case deadlines |
| `…/[caseId]/parent-dashboard` | GET | Parent projection only |
| `/api/admissions/cohorts` (+ `/[cohortId]/templates`) | GET, POST, PATCH | Cohorts; template versions + push-new-items (admin) |
| `/api/admissions/counselors` | GET, POST, PATCH | Counselor registry (admin) |
| `/api/admissions/announcements` | GET, POST, PATCH, DELETE | Cohort/case announcements |
| `/api/admissions/resources` | GET, POST, PATCH, DELETE | Resource library |
| `/api/admissions/audit/[caseId]` | GET | Paginated audit trail (admin) |
| `/api/internal/admissions-notifications` | GET, POST | Cron: daily reminders + Sunday digest (CRON_SECRET) |

## Tests

Coverage is unusually broad for a new feature: 21 unit suites in `src/lib/admissions/__tests__/` (one per module — guards, projections, progress math, staleness, warnings, notification tiering/caps, template versioning), 21 route-handler suites under `src/app/api/admissions/**/__tests__/`, and 20 component suites (staff shells and tabs, student portal, parent dashboard) — all with mocked db. The mandatory leak/authz matrix (`src/app/api/admissions/__tests__/parent-access-matrix.test.ts`) self-verifies its completeness — it fails if any case-scoped route file or exported HTTP method lacks a matrix entry — then asserts a parent gets 403 on every denied surface and that the parent dashboard is the **one** parent-readable payload, whose serialized body carries only the closed projection (PRD success criterion 4: enforced by tests, not convention). Unreleased-score omission and `staff_only` filtering are pinned in `parent-projection.test.ts` and `notes.test.ts`.

## Open questions

- **Academic records (CM-10..13) have schema but no code path.** `admissions_academic_records` exists in `src/lib/db/schema.ts:3269`, but there is no `academics.ts` lib module, no `/api/admissions/cases/[caseId]/academics` route (design §4 lists one), and no UI consumer — `grep -rn admissionsAcademicRecords src/` hits only the schema. GPA / A-level / IB entry (and its CM-13 field-level audit) currently has no write path; the Profile tab covers identity fields only. Deferred deliberately, or a gap to close before deploy?
- **Family access to withdrawn/archived cases is routing-deep, not guard-deep.** PRD §5 says family sign-in is denied for `withdrawn`/`archived`. Implemented: portal routing (`getCaseIdForFamilyEmail`) only resolves live active/committed cases, so families land on an empty state — but `resolveAdmissionsRole` and `requireCaseAccess` check membership status only, not case status, so a family member whose membership was never revoked can still reach a withdrawn/archived case via a bookmarked `/admissions/[caseId]` URL or direct API call. Is "revoke memberships on archive" the intended operational step, or should `requireCaseAccess` enforce case status for family roles?
- **`admissions_test_sittings` has no `deletedAt` column** (self-documented schema gap, `src/lib/admissions/testing.ts` header): design §3 asks for soft-delete on user-facing tables, so sitting deletion is currently an audited **hard** delete (full row preserved in the audit diff, dependent score-send docs removed). A follow-up migration should add `deleted_at` and flip the delete to an UPDATE.
- **CM-112's per-category downgrade controls have no edit surface.** `admissions_case_members.notificationPrefs` is stored and honored by the digest assembly, but no API route or UI writes it — recipients cannot actually downgrade a category yet. Intended for a post-v1 settings surface?
- **Reference pages are authored in parallel.** [docs/reference/api/university-admissions.md](../reference/api/university-admissions.md) and [docs/reference/database/erd-university-admissions.md](../reference/database/erd-university-admissions.md) are being produced by the sibling docs task in this same phase; confirm both landed (and the API index / DB index / crons pages picked up the new rows) before merging.

_Verified against the `feat/admissions` worktree (phases 1–5 committed + phase 6 working tree) on 2026-07-10._
