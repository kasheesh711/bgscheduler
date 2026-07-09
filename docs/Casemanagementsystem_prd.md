# University Admissions Case Management — PRD

> **Status:** Approved 2026-07-09 · **Owner:** Kevin Hsieh · **Feature route:** `/admissions`
> **Design doc:** [casemanagementsystem_design.md](casemanagementsystem_design.md)

## 1. Problem & Goals

BeGifted's university counseling team runs one Google Sheets workbook per student (the "SummitEd - {Student}" template) plus a per-student Drive folder (intake doc, essay drafts, resume). This model does not scale: undated freeform notes, self-reported checkboxes with no verification, no caseload overview, no parent visibility without sharing the entire workbook, and no audit trail on sensitive data (GPA, test scores).

**Goal:** a case management system inside BGScheduler with full functional parity with the SummitEd workbook, where:

- **Counselors** run their assigned cases end-to-end (profile, checklist, colleges, applications, essays, testing, meetings, notes).
- **Students** self-serve their own sections from their phones.
- **Parents** get view-only access to a curated dashboard.
- The company gains a durable, auditable admissions record across cycles.

**Core value:** counselors manage 30+ cases without spreadsheets; families see progress without asking.

## 2. Users & Roles

| Role | Who | Access |
|---|---|---|
| `admin` | Existing `admin_users` allowlist | All cases, all actions, role/membership management |
| `counselor` | **New role.** Counseling staff incl. external partners (e.g. SummitEd) | **Only assigned cases** (hard wall). Full edit within a case |
| `student` | The applicant (email on case membership) | Own case only. Edits **self-report sections only** |
| `parent` | Guardian(s) (email(s) on case membership) | Own child's case only. **View-only curated dashboard** |

- One case may have multiple parent members (equal view by default) and multiple counselor members (co-counseling). Any member is individually revocable — covers separated-parent situations.
- Same email as both student and parent on one case is rejected at write time; admin-only override grants the **student** role.

## 3. Access & Auth Policy

1. **Google OAuth for all roles** (decision 18 — no magic links, no LINE Login in v1). Parents without a Google account create one; onboarding is assisted at the intake meeting (QR to sign-in page, email confirmed aloud).
2. Sign-in resolution (fail-closed, same pattern as the teacher role): `admin_users` → `admissions_counselors` → tutor contact (teacher) → `admissions_case_members` → **deny**.
3. JWT role is used **only** for nav visibility and middleware route-prefix gating (`allowedPages: ["/admissions"]` for counselor/student/parent).
4. **Every** `/api/admissions/*` request re-resolves case membership from Postgres (`requireCaseAccess`) — revocation is instant, and IDOR via caseId manipulation is impossible.
5. **Parent projection:** parent-facing responses are built exclusively by a whitelisted projection helper. Raw case tables are never serialized to the parent role — over-disclosure is structurally impossible.
6. Visibility rules (decision 17):
   - Notes/comments default **staff-only**; sharing to student/parent is an explicit per-item action. No silent defaults in the UI.
   - Test **milestones** (registered / taken / scores received) are parent-visible; **raw scores** appear only after the counselor marks them released.
7. Invites contain no case data (child's first name + sign-in link only, bilingual Thai/English). Access activates only on exact email match. Member invite status (invited/bounced/active) is tracked with one-click re-invite.

## 4. Functional Requirements

Requirements are numbered `CM-xx` and testable. "Staff" = admin + assigned counselor.

### 4.1 Cases & Caseload

- **CM-01** Staff can create a case: student (name, email, school, cohort), parent email(s), assigned counselor(s).
- **CM-02** Caseload view offers a sortable/filterable **table** (student, cohort, counselor, status, progress %, next deadline, days since last touch) and a **kanban board** grouped by case status.
- **CM-03** Counselors see only cases where they are an active counselor member; admins see all.
- **CM-04** Case detail is a tabbed workspace: Overview / Profile / Checklist / Colleges / Applications / Essays / Activities / Testing / Meetings / Notes.
- **CM-05** Counselor reassignment and co-counseling are membership edits, fully audited.

### 4.2 Student Profile & Academics

- **CM-10** Profile: name, emails, phone, school, school counselor, external links (UniFrog, Drive folder, Zoom), cohort.
- **CM-11** Academic records support **US GPA** (unweighted, weighted, class rank), **UK A-level/IGCSE** predicted + achieved grades per subject, and **IB** predicted + final points (decision 13).
- **CM-12** Academics are counselor-edited; students may view.
- **CM-13** Every edit to academic data is captured in the audit log with field-level old/new values.

### 4.3 Checklist & Tasks

- **CM-20** Each cohort ("Class of 2027") has a versioned 10-phase checklist template mirroring the SummitEd phases (About You → Transition). Templates are immutable once published; edits create a new version.
- **CM-21** Case creation copies template items into case tasks (snapshot semantics). Template edits never mutate existing cases; an explicit admin action appends new items to existing cohort cases.
- **CM-22** Tasks carry owner (student/counselor/parent), optional due date, status (not started / in progress / done), and an optional counselor **verified** flag on student-owned items.
- **CM-23** Counselors can add custom tasks per case, with simple recurrence (weekly/biweekly, end date).
- **CM-24** Progress % counts done items; counselor-verified is surfaced separately.

### 4.4 Meetings

- **CM-30** First-class meeting log per case: date, mode (Zoom/in-person/LINE), attendees, structured notes, next-meeting date.
- **CM-31** Meeting action items create tasks with owners and due dates.
- **CM-32** "Days since last touch" (from meetings) feeds caseload triage.

### 4.5 College List & Applications

- **CM-40** College list rows link US institutions by IPEDS `unitId` (soft reference + denormalized name/city/state at add time; live stats join the latest data year). Non-US/manual rows use free-text name + country (decision 3).
- **CM-41** "Add to case list" is available from the `/us-universities` browse, compare, and shortlist surfaces (decision 14).
- **CM-42** Each row: application round (ED/ED2/EA/REA/RD/Rolling/Priority/Other), per-round deadline (auto-suggested, always editable), application status (researching → applying → submitted → complete), category (reach/match/safety).
- **CM-43** Decisions are recorded as dated **events** (submitted, deferred, waitlisted, accepted, denied, withdrawn) so chains like deferred→accepted are preserved.
- **CM-44** Merit/aid offered is recordable per college; exactly one college per case can be marked **committed**.
- **CM-45** Validation **warns** (never blocks) on >1 active ED or REA+ED conflicts.
- **CM-46** Per-college completeness tracks recommenders, transcript, school report, and test-score sends.

### 4.6 Recommenders

- **CM-50** Recommenders per case: name, role/subject, contact, ask-status (planned → asked → agreed → declined).
- **CM-51** Per-college submission status per recommender (pending/submitted).

### 4.7 Essays

- **CM-60** Essay tracker rows: prompt, linked college (or Common App/personal statement), status (not started / brainstorming / drafting / getting feedback / final), deadline, Google Drive doc link. Writing stays in Google Docs (decision 9).
- **CM-61** Every row shows an automatic staleness badge ("updated N days ago").
- **CM-62** Counselors have a separate confirmed-stage field that overrides student-set status in staff views.
- **CM-63** Student essay list sorts by deadline proximity × staleness.

### 4.8 Activities

- **CM-70** Master activity list per case (≤ ~20): unlimited internal description plus platform variants — Common App block (position ≤50 chars, organization ≤100, description ≤150, hrs/week, weeks/year, grade levels, timing) and UC block (description ≤350, category). Hard character counters block overflow.
- **CM-71** Students drag-rank a "Common App top 10" selection; order is persisted.
- **CM-72** Per-field copy-to-clipboard for transfer into the real applications.

### 4.9 Testing

- **CM-80** Test records are planned/completed **sittings**: type (SAT/ACT/AP/IB/TOEFL/IELTS), test date, auto-derived registration deadline, target score, actual score.
- **CM-81** Registration deadlines feed the deadline calendar and reminders.
- **CM-82** Score-send status per list college; each list college's test policy shown next to the student's best score.
- **CM-83** Raw scores are parent-visible only after counselor release (CM: visibility rule 6).

### 4.10 Announcements, Notes, Resources

- **CM-90** Announcements at cohort scope (broadcast) and case scope; visible to student and parent surfaces.
- **CM-91** Notes carry a visibility enum (`staff_only` | `shared_with_family`) chosen explicitly at write time; default staff-only.
- **CM-92** Curated resource library (links grouped by topic), admin/counselor managed, visible to students.

### 4.11 Deadlines & Calendar

- **CM-100** All dated items (tasks, application rounds, essays, test registrations/sittings) surface in one per-case calendar: month grid on desktop, list view on mobile.
- **CM-101** Counselors get a cross-case deadline calendar for their caseload.
- **CM-102** Upcoming-deadlines panel on every dashboard; overdue flagged.

### 4.12 Notifications

- **CM-110** Email via existing Resend integration. Two tiers: **interrupt** (counselor direct message to student; deadline reminders at T-7d and T-48h for items assigned to the recipient) and **batch** (weekly digest: announcements, new tasks, comments).
- **CM-111** Max 3 interrupt emails per recipient per day; overflow collapses into one.
- **CM-112** Per-category downgrade controls; deadline reminders cannot be fully disabled.

### 4.13 Student Experience

- **CM-120** Student home leads with "This Week": 3–5 counselor-prioritized or deadline-driven actions, plus per-phase progress rings scoped to season-relevant phases. Global % lives on staff/parent views.
- **CM-121** Self-report sections are guided multi-step forms with autosave on blur, inline examples, and a Draft → Submitted-for-review → Reviewed state machine. Submit is the only event that notifies the counselor. No spreadsheet-style grid editing in the student UI.
- **CM-122** Student + parent surfaces are **mobile-first** (single column, bottom nav, ≥44px touch targets); staff surfaces are desktop-dense (decision 20).

### 4.14 Parent Dashboard

- **CM-130** Curated view-only dashboard: overall progress, college list (no counselor commentary), upcoming deadlines, announcements, released testing milestones (decision 6).
- **CM-131** Static UI strings bilingual, Thai-first, for the parent surface.

### 4.15 Audit

- **CM-140** Append-only audit log (actor, role, entity, action, field-level diffs) for academic data, college list, application decisions, membership, and visibility changes. Audit row commits atomically with the mutation.

## 5. Case Lifecycle & Retention

- Status enum: `active` → `committed` → `completed` | `withdrawn` → `archived`. Transitions are staff-only and audited.
- `active`/`committed`: full role-based access. `completed`: family access continues (read-only recommended at counselor discretion). `withdrawn`/`archived`: family sign-in denied; staff retain read access.
- **Retention: indefinite** (decision 19 — explicit business decision). No purge cron in v1. **Accepted risk:** long-term storage of minors' academic records is in scope of Thai PDPA; consent + lawful basis are documented at intake, and this decision should be revisited if BeGifted formalizes a data-retention policy or receives a data-subject deletion request (soft-delete columns exist to honor one).
- Data minimization: no Thai national ID, no passport numbers — only fields the source sheet already collects.

## 6. Non-Functional Requirements

- All existing tests keep passing; locked stack unchanged (Next.js 16, Tailwind 4, shadcn/ui, Drizzle, Neon).
- Fail-closed everywhere: unknown role → deny; unresolved membership → deny; missing projection field → omitted, never guessed.
- All times Asia/Bangkok for display; deadlines stored as dates with college-local semantics.
- WCAG 2.1 AA contrast (4.5:1); lucide icons only; existing sky-blue OKLCH palette + Inter.
- Route handlers follow the repo's 4-step convention (auth → JSON parse → Zod safeParse → guarded business logic).

## 7. Out of Scope (v1)

LINE Login and LINE push · email magic links · SummitEd sheet migration/import · UK/UCAS dataset import · hard FK coupling to Wise (`wiseStudentKey` is an informational soft reference) · in-app essay editing (stays in Google Docs) · PII purge cron · Google Drive last-modified staleness integration · financial-aid document storage.

## 8. Success Criteria

1. A counselor runs a full case (create → checklist → list → applications → decisions → commit) without opening the SummitEd sheet.
2. A parent answers "where are we?" from their phone without messaging staff.
3. The top-3 student actions (see deadlines, tick a task, update essay status) each complete in <30s on a 375px viewport.
4. Zero parent-role access to staff-only data — enforced by the authz/projection test matrix, not convention.
5. Decision-season data (rounds, decision chains, aid, matriculation) is queryable for year-over-year knowledge.

## 9. Decision Log

| # | Decision |
|---|---|
| 1 | 4 roles: admin / counselor (new, assigned-case hard wall) / student (self-report edit) / parent (view-only) |
| 2 | Full sheet parity, 6-phase build |
| 3 | US-first via IPEDS; manual/free-text rows for UK/intl; no UK dataset v1 |
| 4 | Fresh start; sheets remain archive; no migration |
| 5 | Google OAuth; per-case email membership resolves role at sign-in |
| 6 | Parent view v1 = curated dashboard; expand later if needed |
| 7 | Counselor hard wall; admins see all |
| 8 | Students edit self-report sections only |
| 9 | Essay tracker + Drive links; writing stays in Docs |
| 10 | Versioned cohort templates + counselor custom tasks |
| 11 | In-app + email notifications (Resend) |
| 12 | Full calendar view + deadline fields |
| 13 | US GPA + A-levels/IGCSE + IB + SAT/ACT/AP/TOEFL/IELTS |
| 14 | Deep /us-universities integration (add-to-case, live stats) |
| 15 | Caseload = table + kanban |
| 16 | Route `/admissions` |
| 17 | Staff-only note default + whitelist parent projection + gated raw scores |
| 18 | **Google-only auth for all roles** (user override; magic links rejected) |
| 19 | **Indefinite retention** (user override; purge rejected; PDPA risk accepted + documented) |
| 20 | Mobile-first student/parent shell; desktop-dense staff |

Gap-analysis defaults adopted (2026-07-09 workflow, 4 persona lenses, 31 findings): application-round state machine with decision events; first-class meetings; recommender tracking; copy-on-instantiate templates; standalone student entity; per-request authz; transactional audit; IPEDS unitId soft ref; This-Week student home; guided forms; section-ownership conflict model; 2-tier notifications; essay staleness; Common App/UC-native activities; sitting-based testing; bilingual parent invites; multi-guardian revocable membership.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Counselor note leaked to family | Staff-only default + projection whitelist + leak-test matrix (highest-severity failure mode) |
| Parent without Google account abandons onboarding | Assisted intake onboarding; revisit magic links if adoption suffers |
| Indefinite retention of minors' data (PDPA) | Accepted business decision; consent at intake; soft-delete ready; revisit trigger documented (§5) |
| IPEDS yearly re-import breaks list links | unitId soft ref + denormalized fallback (no uuid FK) |
| Student/counselor concurrent edits | Section ownership + optimistic concurrency + both-versions conflict surface |
