# University Admissions Case Management — Design

> **Status:** Approved 2026-07-09 · **PRD:** [Casemanagementsystem_prd.md](Casemanagementsystem_prd.md)
> Approach A: integrated module inside BGScheduler, following the standard feature scaffold.

## 1. Architecture Overview

```
schema (admissions_* tables, src/lib/db/schema.ts)
  → src/lib/admissions/          domain logic, guards, projections (unit-testable, no Next imports)
  → src/app/api/admissions/**    route handlers (4-step convention)
  → src/app/(app)/admissions/    server components (auth-gated pages)
  → src/components/admissions/   client shells per audience
  → sibling __tests__/ at every layer
```

Reference scaffolds: `credit-control` (mutating feature), `us-universities` (read integration), `progress-tests` (role guards). No new dependencies; no stack changes.

Module map (`src/lib/admissions/`):

| File | Responsibility |
|---|---|
| `access.ts` | `requireCaseAccess(email, caseId, minRole)`, `resolveAdmissionsRole(email)`, membership queries |
| `cases.ts` | case CRUD, lifecycle transitions, caseload queries (table + board) |
| `members.ts` | membership add/revoke/re-invite, email-change, student≠parent validation |
| `checklists.ts` | template versioning, copy-on-instantiate, push-new-items, progress % |
| `colleges.ts` | list items, rounds, decision events, committed pointer, ED/REA warnings, IPEDS join |
| `recommenders.ts` | recommender + per-college submission status, completeness rollup |
| `essays.ts` / `activities.ts` / `testing.ts` / `academics.ts` | per-module domain logic |
| `meetings.ts` | meeting log + action-item task creation, last-touch |
| `notes.ts` / `announcements.ts` / `resources.ts` | content modules (visibility enforcement in notes) |
| `parent-projection.ts` | the ONLY builder of parent-facing payloads (whitelist) |
| `notifications.ts` | Resend sends, tiering, caps, digest assembly |
| `audit.ts` | append-only audit writes, transactional pairing |
| `calendar.ts` | deadline aggregation across modules |
| `types.ts` / `config.ts` | shared types, enums, template seed data |

## 2. Auth & Authorization

### 2.1 Role resolution (sign-in, `src/lib/auth-access.ts`)

Extend `UserRole` → `"admin" | "teacher" | "counselor" | "student" | "parent"`. Resolution order (first match wins, fail-closed):

1. `admin_users` → `admin` (existing, `allowedPages` from row)
2. `admissions_counselors` (active) → `counselor`, `allowedPages: ["/admissions"]`
3. tutor contact → `teacher` (existing)
4. `admissions_case_members` (active, any case) → `student` or `parent` (member-row role; if an email is student on one case and parent on another, JWT gets max precedence student > parent — actual rights are per-case), `allowedPages: ["/admissions"]`
5. none → deny sign-in

### 2.2 Per-request enforcement

- JWT role/allowedPages: nav filtering (`src/lib/navigation/tools.ts`) + middleware prefix gating **only**.
- `requireCaseAccess(email, caseId, minRole)` (template: `src/lib/progress-tests/api.ts`): queries `admissions_case_members` + `admissions_counselors` + `admin_users` on **every** request. Throws Unauthorized/Forbidden; routes translate to 401/403. Revocation is instant; caseId tampering yields 403.
- Role ordering for `minRole`: `parent < student < counselor < admin` (within-case).
- Data-layer helpers accept resolved membership and filter by it — a forgotten guard fails closed to empty results.

### 2.3 Parent projection

`parent-projection.ts` exports `buildParentDashboard(caseId)` returning an explicit DTO: `{ progress, collegeList (name/round/status/deadline only), upcomingDeadlines, announcements, testingMilestones (released scores only), sharedNotes }`. Parent routes call only this helper. New fields must be added to the DTO deliberately — leaks are structural, not conventional.

### 2.4 Write authorization matrix

| Section | student | counselor | admin |
|---|---|---|---|
| Self-report (About You, activities, essay status, testing self-entries, research notes, own task ticks) | ✅ | ✅ (attributed override) | ✅ |
| Academics profile, college list, application plan/decisions, announcements, notes, membership, lifecycle | ❌ | ✅ | ✅ |
| Template management, counselor management, cross-case admin | ❌ | ❌ | ✅ |

Parent: no writes anywhere (view-only).

## 3. Data Model

23 tables, prefix `admissions_`, migrations via `npm run db:generate` (trim drift per repo practice). Enums as `pgEnum` (snake_case SQL). All tables: `id uuid pk default gen_random_uuid()`, `createdAt`/`updatedAt` timestamptz, soft-delete `deletedAt` where user-facing.

**Enums:** `admissions_case_status` (active, committed, completed, withdrawn, archived) · `admissions_member_role` (counselor, student, parent) · `admissions_member_status` (invited, active, revoked, bounced) · `admissions_task_status` (not_started, in_progress, done) · `admissions_task_owner` (student, counselor, parent) · `admissions_app_round` (ed, ed2, ea, rea, rd, rolling, priority, other) · `admissions_app_status` (researching, applying, submitted, complete) · `admissions_decision_event` (submitted, deferred, waitlisted, accepted, denied, withdrawn, committed) · `admissions_essay_status` (not_started, brainstorming, drafting, feedback, final) · `admissions_test_type` (sat, act, ap, ib, toefl, ielts, other) · `admissions_note_visibility` (staff_only, shared_with_family) · `admissions_rec_status` (planned, asked, agreed, declined) · `admissions_submission_state` (draft, submitted, reviewed) · `admissions_college_category` (reach, match, safety, unset)

| Table | Key columns (beyond id/timestamps) | Notes |
|---|---|---|
| `admissions_cohorts` | name, graduationYear | unique(name). Owns broadcasts + template seed |
| `admissions_students` | fullName, preferredName, studentEmail (lowercase), phone, school, schoolCounselor, cohortId FK, wiseStudentKey text NULL, externalLinks jsonb | **Standalone entity.** `wiseStudentKey` = informational soft ref, never FK to snapshot tables |
| `admissions_cases` | studentId FK, cohortId FK, status enum, statusChangedAt, committedListItemId uuid NULL, driveFolder text | One active case per student (partial unique idx on studentId where status in active/committed) |
| `admissions_case_members` | caseId FK, email lowercase, role enum, status enum, invitedAt, activatedAt, revokedAt, addedByEmail | unique(caseId, email). Zod refinement rejects student email in parent rows same case (admin override flag) |
| `admissions_counselors` | email lowercase unique, name, active bool | Global counselor registry (sign-in resolution) |
| `admissions_checklist_templates` | cohortId FK, version int, publishedAt, name | Immutable once published; unique(cohortId, version) |
| `admissions_template_items` | templateId FK, itemKey text (stable), phase text, title, description, defaultOwner enum, sortOrder | itemKey survives versions |
| `admissions_case_tasks` | caseId FK, templateId NULL, templateVersion NULL, itemKey NULL, phase, title, description, owner enum, status enum, dueDate NULL, verifiedByEmail NULL, verifiedAt NULL, recurrence jsonb NULL, sortOrder | Copied at seed; custom tasks have null itemKey. Recurrence counselor-only |
| `admissions_case_meetings` | caseId FK, meetingDate, mode text, attendees jsonb, notes text, nextMeetingDate NULL | Action items create case_tasks (linkage via task.metadata) |
| `admissions_college_list_items` | caseId FK, unitId int NULL, instName, city NULL, stateAbbr NULL, country, isManual bool, round enum, deadline date NULL, appStatus enum, category enum, aidOffered numeric NULL, aidNotes | unitId soft ref; reads join latest ipeds dataYear, fall back to denormalized copy |
| `admissions_application_events` | listItemId FK, event enum, eventDate, notes | Append-only decision chain |
| `admissions_recommenders` | caseId FK, name, roleSubject, contact, askStatus enum | |
| `admissions_recommender_colleges` | recommenderId FK, listItemId FK, submitted bool, submittedAt | unique(recommenderId, listItemId) |
| `admissions_college_docs` | listItemId FK, docType text (transcript/school_report/score_send), testSittingId NULL, sent bool, sentAt | Per-college completeness |
| `admissions_essays` | caseId FK, listItemId NULL, prompt, status enum, counselorStage enum NULL, deadline NULL, driveUrl, lastStudentUpdateAt | Staleness = now − lastStudentUpdateAt |
| `admissions_activities` | caseId FK, name, fullDescription, commonApp jsonb {position≤50, organization≤100, description≤150, hrsWeek, weeksYear, grades[], timing}, uc jsonb {description≤350, category}, commonAppRank int NULL, sortOrder | Char limits enforced by Zod + UI counters |
| `admissions_test_sittings` | caseId FK, testType enum, testDate, registrationDeadline NULL (auto-derived, editable), targetScore, actualScore NULL, scoreReleasedToParent bool default false, accommodations text NULL | Score sends live in `admissions_college_docs` |
| `admissions_academic_records` | caseId FK, system text (us_gpa/alevel/igcse/ib), payload jsonb, effectiveDate | Flexible multi-system: us_gpa {unweighted, weighted, classRank, classSize}; alevel/igcse [{subject, predicted, achieved}]; ib {predictedPoints, finalPoints, subjects[]} |
| `admissions_notes` | caseId FK, authorEmail, body, visibility enum (NOT NULL, no default — UI forces explicit choice) | |
| `admissions_announcements` | cohortId NULL, caseId NULL (exactly one set — check constraint), title, body, authorEmail | |
| `admissions_resources` | topic, title, url, sortOrder | Global library |
| `admissions_self_report_sections` | caseId FK, sectionKey text, payload jsonb, state enum (draft/submitted/reviewed), submittedAt, reviewedByEmail | About You etc. guided forms; autosave writes payload |
| `admissions_audit_log` | caseId FK NULL, actorEmail, actorRole, entityType, entityId, action text, diff jsonb {field:{old,new}}, createdAt | **Append-only** — no UPDATE/DELETE code path |

**Transactions:** mutations on academics, college list, application events, membership, lifecycle, and visibility use the node-postgres (`pg`) transaction pattern from payroll sync so the mutation + audit row commit atomically. Low-stakes writes (task ticks) audit row-level, fire-and-forget.

**Optimistic concurrency:** mutating routes accept `expectedUpdatedAt`; mismatch returns 409 with both versions (UI shows "your counselor updated this while you were editing").

## 4. API Surface (`src/app/api/admissions/`)

All routes: session required; case-scoped routes call `requireCaseAccess` before body parsing; mutations follow auth → JSON → Zod safeParse → try/catch. Roles listed = minimum.

| Route | Methods | Min role | Purpose |
|---|---|---|---|
| `/cases` | GET, POST | counselor (GET scoped) / counselor (POST) | Caseload query; create case |
| `/cases/[caseId]` | GET, PATCH | student/parent (GET, role-shaped) / counselor (PATCH incl. lifecycle) | Case detail; updates |
| `/cases/[caseId]/members` | GET, POST, PATCH | counselor | Membership add/revoke/re-invite/email-change |
| `/cases/[caseId]/tasks` | GET, POST, PATCH | student (tick own) / counselor (manage) | Checklist |
| `/cases/[caseId]/meetings` | GET, POST, PATCH | counselor | Meeting log |
| `/cases/[caseId]/colleges` | GET, POST, PATCH, DELETE | student (GET) / counselor (writes) | List rows |
| `/cases/[caseId]/colleges/[itemId]/events` | GET, POST | counselor | Decision events |
| `/cases/[caseId]/recommenders` | GET, POST, PATCH | counselor | Recommenders + submissions |
| `/cases/[caseId]/essays` | GET, POST, PATCH | student (status/own rows) / counselor | Essay tracker |
| `/cases/[caseId]/activities` | GET, POST, PATCH, DELETE | student | Activities (counselor override attributed) |
| `/cases/[caseId]/testing` | GET, POST, PATCH | student (self-entry) / counselor (release flag) | Sittings |
| `/cases/[caseId]/academics` | GET, PUT | student (GET) / counselor (PUT) | Academic records |
| `/cases/[caseId]/notes` | GET, POST, PATCH | counselor (staff view incl. staff_only) | Notes (visibility explicit) |
| `/cases/[caseId]/sections/[sectionKey]` | GET, PUT, POST(submit) | student | Guided self-report forms |
| `/cases/[caseId]/calendar` | GET | student/parent (shaped) | Aggregated deadlines |
| `/cases/[caseId]/parent-dashboard` | GET | parent | **Projection helper only** |
| `/cohorts` + `/cohorts/[id]/templates` | GET, POST, PATCH | admin | Cohorts, template versions, push-new-items |
| `/counselors` | GET, POST, PATCH | admin | Counselor registry |
| `/announcements` | GET, POST | counselor | Cohort/case announcements |
| `/resources` | GET, POST, PATCH | counselor (write) / student (read) | Library |
| `/audit/[caseId]` | GET | admin | Audit trail view |
| `/internal/admissions-notifications` | GET/POST cron | CRON_SECRET | Deadline reminders + weekly digest (staggered cron) |

## 5. UX Specification

### 5.1 Counselor / Admin (desktop-dense)

- `/admissions`: header KPIs (active cases, overdue items, next 7-day deadlines) + view toggle **Table ↔ Board**. Table: student, cohort, status, counselor, progress %, next deadline, days-since-touch (sortable/filterable). Board: kanban by case status, cards show progress + next deadline.
- `/admissions/[caseId]`: sticky case header (student, cohort, status, committed college when set) + tab bar: Overview / Profile / Checklist / Colleges / Applications / Essays / Activities / Testing / Meetings / Notes.
  - Overview: progress rings per phase, upcoming deadlines, last meeting, quick notes.
  - Colleges: table w/ round, deadline, status, category, completeness column (recs/transcript/scores), ED/REA warning banner, add via `/us-universities` search combobox (reuses `institution-search-combobox`).
  - Applications: decision-event timeline per college; committed selector.
  - Calendar: month grid reusing `WeekCalendar` interaction patterns.
- Empty states with action prompts everywhere; confirmation dialogs on destructive actions; toasts 3–5s.

### 5.2 Student (mobile-first shell)

- Single column, bottom nav: **Home / Tasks / Colleges / Essays / More**. ≥44px targets, `min-h-dvh`, no horizontal scroll at 375px.
- Home = "This Week" (3–5 actions) + season-relevant phase rings + announcements.
- Guided forms: 5–10 fields per step, autosave on blur, char counters (live, hard-stop), example microcopy, Draft → Submit for review → Reviewed states.
- Deadline list (grouped by week) instead of month grid on mobile; grid available ≥1024px.

### 5.3 Parent (mobile-first, read-only)

- Single scroll page: child header → progress → upcoming deadlines → college list (name, round, status) → announcements → released testing milestones → shared notes.
- Thai-first bilingual static strings (`th`/`en` toggle persisted in localStorage); data values verbatim.
- No interactive mutations anywhere; no links to staff surfaces.

### 5.4 Design system

Existing tokens only: sky-blue OKLCH palette, amber accent, cream background, Inter + JetBrains Mono, shadcn/ui primitives, lucide icons (no emoji icons). Semantic status colors reuse `--available`/`--blocked`/`--conflict` conventions (e.g. accepted/denied/waitlisted). Contrast ≥4.5:1 both themes; visible focus rings; `prefers-reduced-motion` respected; skeletons for >300ms loads.

## 6. Edit-Conflict Model

- Section-level ownership (see §2.4). Counselors comment/suggest on student sections; direct override is allowed but attributed + audited.
- `expectedUpdatedAt` optimistic concurrency on shared entities → 409 + both versions.
- Task ticks are idempotent toggles (co-writable, last-write-wins acceptable).

## 7. Notifications Design

- Transport: existing Resend pattern (`src/lib/classrooms/schedule-email.ts` as template; per-send record with `resendEmailId`).
- Tiers: interrupt (counselor→student direct message; T-7d/T-48h deadline reminders) vs batch (weekly digest, Sunday 18:00 Asia/Bangkok).
- Cap: >3 interrupt emails/recipient/day collapse into one combined email.
- New staggered cron `admissions-notifications` (daily deadline scan + weekly digest) with single-flight guard + `*_sync_runs`-style run table, added to `vercel.json` offset from existing 7 crons.
- Per-recipient category preferences; deadline reminders non-disableable (CM-112).

## 8. Build Phases & Exit Criteria

| Phase | Scope | Exit criteria |
|---|---|---|
| 1 Foundation | Schema + migrations, role resolution, `requireCaseAccess`, case/member CRUD, caseload table+board, case shell w/ Profile/Notes/Meetings, audit | Authz matrix tests green; counselor wall + revocation proven; caseload renders |
| 2 Checklists | Templates/versions, seed-on-create, tasks, verification, recurrence, calendar, announcements | Template immutability + push-new-items tested; calendar aggregates tasks |
| 3 Colleges | List items + IPEDS integration, rounds/deadlines, decision events, committed, warnings, recommenders, completeness | Add-from-us-universities works; decision chains persist; ED/REA warning fires |
| 4 Student portal | Mobile shell, This Week, guided forms, activities (counters/rank), essays, testing | Top-3 actions <30s @375px; counters hard-stop; submit-notify flow |
| 5 Parent + notifications | Projection helper, parent dashboard, bilingual statics, Resend tiers + cron, invites | Leak-test matrix green (parent never sees staff_only/unreleased); caps enforced |
| 6 Polish | Resources, nav registration, home badge, handbook docs (feature doc, API index, DB reference, route surface JSON), full sweep | Full suite green; docs verified against code |

Each phase: build workflow (fan-out agents) → verify loop (`npm test`, `tsc --noEmit`, lint, adversarial diff review) until 2 consecutive clean rounds → atomic commit.

## 9. Testing Strategy

- **Unit:** every `src/lib/admissions/*.ts` module (guards, projections, progress math, staleness, warning logic, notification tiering/caps, template versioning).
- **Authz matrix (mandatory):** role × route × membership-state table tests — parent write attempts 403; counselor cross-case 403; revoked member 403 immediately; student writes to counselor-only sections 403; parent payloads contain zero staff-only/unreleased fields (leak tests assert on serialized DTO keys).
- **API route tests:** per-group handler tests following existing route-test patterns.
- **Component:** char counters, conflict dialog, visibility selector (no default), kanban/table rendering.
- **Integration:** membership revocation end-to-end; transactional audit (mutation rollback leaves no audit row) via testcontainers.
- **Regression:** entire existing suite green every phase.
