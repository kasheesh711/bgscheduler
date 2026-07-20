# API Reference — Master Index

The canonical lookup of every HTTP endpoint in BGScheduler. This page lists **method + path + group + auth + one-line purpose** only. For full request/response schemas, query parameters, and error shapes, follow the link on each group heading to the per-group detail page.

All routes live under `src/app/api/**/route.ts` (Next.js App Router). Endpoint count: **222** exported HTTP method handlers across **157** API route files.

## How to read this index

**Auth column** — three tiers, all verified against `src/middleware.ts` plus each route handler:

- **public** — reachable without an authenticated session. `src/middleware.ts:4-15` allowlists `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/api/line/contacts/oa-resolver/worklist`, and `/api/line/contacts/oa-resolver/runs/{runId}/rows`. The non-`/api/auth` public routes enforce their own checks in-handler (LINE signature header or a bearer token), not an admin session.
- **admin** — requires an authenticated Auth.js session. The middleware redirects unauthenticated requests to `/login` (`src/middleware.ts:25-29`); handlers additionally call `auth()` (or `requireCreditControlSession()` for credit-control) and return `401` when no session is present.
- **session** — requires an authenticated Auth.js session but is intentionally available to restricted non-admin roles when their `allowedPages` grant the relevant surface (for example `/api/home/summary` and the teacher-readable Progress Tests payload).
- **cron** — `CRON_SECRET`-protected. `src/middleware.ts:13` lets `/api/internal/*` bypass the session gate; each handler then enforces a constant-time `Bearer ${CRON_SECRET}` check (`src/lib/internal/cron-auth.ts:6-26`, or an inline copy). Six internal sync routes additionally accept an admin session as a fallback when the cron secret is absent — see the **cron (or admin)** notes below.
- **session + min role** — University Admissions only. These routes require an authenticated Auth.js session (`requireAdmissionsSession`) but are **not** admin-only: rights are re-resolved from Postgres per request (`requireCaseAccess` / `requireCounselorOrAdmin`, `src/lib/admissions/access.ts`) under the role ordering `parent < student < counselor < admin`. The Auth column shows the minimum role; see the [group page](./university-admissions.md) for the guard mechanics.

> **Canonical-home rule:** this page owns only the mechanical endpoint inventory. Meaning, business rules, and flows live in the relevant `docs/features/*` pages; full per-endpoint signatures live in the linked per-group detail pages.

---

## [AI Scheduler](./ai-scheduler.md) — `/api/ai-scheduler`

Conversational scheduling assistant: conversation CRUD, message turns, feedback, and usage metrics.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/ai-scheduler/conversations` | ai-scheduler | admin | List the signed-in admin's AI-scheduler conversations |
| POST | `/api/ai-scheduler/conversations` | ai-scheduler | admin | Create a new AI-scheduler conversation |
| GET | `/api/ai-scheduler/conversations/[conversationId]` | ai-scheduler | admin | Fetch a single conversation with its messages |
| PATCH | `/api/ai-scheduler/conversations/[conversationId]` | ai-scheduler | admin | Update a conversation (e.g. rename/title) |
| DELETE | `/api/ai-scheduler/conversations/[conversationId]` | ai-scheduler | admin | Delete a conversation |
| POST | `/api/ai-scheduler/conversations/[conversationId]/messages` | ai-scheduler | admin | Post a user message and get the assistant's reply |
| POST | `/api/ai-scheduler/messages/[messageId]/feedback` | ai-scheduler | admin | Record thumbs-up/down feedback on an assistant message |
| GET | `/api/ai-scheduler/metrics` | ai-scheduler | admin | AI-scheduler usage / quality metrics |

## [Auth](./misc.md) — `/api/auth`

Auth.js (NextAuth v5) Google OAuth handler.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET, POST | `/api/auth/[...nextauth]` | auth | public | Auth.js catch-all: sign-in, callback, session, sign-out |

> Implemented by the Auth.js handler in `src/app/api/auth/[...nextauth]/route.ts`; it exports the framework's `GET`/`POST` handlers rather than hand-written ones. Public per `src/middleware.ts:7`.

## [Class Assignments](./classrooms-and-assignments.md) — `/api/class-assignments`

Daily classroom room-assignment workspace: generate runs, override rows, publish eligible OFFLINE locations to Wise, and the teacher-schedule / schedule-email views.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/class-assignments` | class-assignments | admin | Latest assignment run for a Bangkok date (`?date=`) |
| POST | `/api/class-assignments/run` | class-assignments | admin | Generate a new local assignment run for a date |
| PATCH | `/api/class-assignments/runs/[runId]/rows/[rowId]` | class-assignments | admin | Override a row's room and recalculate the run |
| POST | `/api/class-assignments/runs/[runId]/publish` | class-assignments | admin | Publish eligible OFFLINE room locations to Wise |
| GET | `/api/class-assignments/runs/[runId]/publish/[jobId]` | class-assignments | admin | Poll status of a publish job |
| GET | `/api/class-assignments/runs/[runId]/teacher-schedule` | class-assignments | admin | Grouped teacher schedule for a run |
| GET | `/api/class-assignments/runs/[runId]/schedule-email/preview` | class-assignments | admin | Preview the schedule email for a run |
| POST | `/api/class-assignments/runs/[runId]/schedule-email/send` | class-assignments | admin | Send the schedule email for a run |

## [Classrooms](./classrooms-and-assignments.md) — `/api/classrooms`

Classroom room catalog and floor-plan map asset.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/classrooms/rooms` | classrooms | admin | Classroom room catalog (24-room BeGifted list) |
| GET | `/api/classrooms/floor-plan-map` | classrooms | public | Serve the classroom floor-plan map (public per middleware) |

## [Compare](./misc.md) — `/api/compare`

Side-by-side tutor comparison and candidate discovery.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| POST | `/api/compare` | compare | admin | Compare 1-3 tutors for a week: schedules, conflicts, shared free slots |
| POST | `/api/compare/discover` | compare | admin | Find candidate tutors with pre-computed conflict status |

## [Competitor Intelligence](./misc.md) — `/api/competitor-intelligence`

Competitive signal workspace: dashboard payload, source administration, manual evidence capture, task triage, and manual sync.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/competitor-intelligence` | competitor-intelligence | admin | Load the competitor-intelligence dashboard payload |
| POST | `/api/competitor-intelligence/manual-evidence` | competitor-intelligence | admin | Add a manually collected competitor evidence item |
| GET | `/api/competitor-intelligence/own-sources` | competitor-intelligence | admin | List BeGifted-owned benchmark sources |
| POST | `/api/competitor-intelligence/own-sources` | competitor-intelligence | admin | Create or update an own-brand benchmark source |
| PATCH | `/api/competitor-intelligence/own-sources/[sourceId]` | competitor-intelligence | admin | Update or disable one own-brand benchmark source |
| PATCH | `/api/competitor-intelligence/sources/[sourceId]` | competitor-intelligence | admin | Update one competitor source status |
| POST | `/api/competitor-intelligence/sync` | competitor-intelligence | admin | Manually run the competitor-intelligence sync |
| POST | `/api/competitor-intelligence/task-suggestions/[suggestionId]/accept` | competitor-intelligence | admin | Accept a generated task suggestion |
| PATCH | `/api/competitor-intelligence/tasks/[taskId]` | competitor-intelligence | admin | Update a competitor-intelligence task |

## [Credit Control](./credit-control.md) — `/api/credit-control`

Student credit/payment tracking: payload load, per-student and bulk actions, action history, admin ownership, inactive flagging, and a manual sync trigger. All routes gate on `requireCreditControlSession()`.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/credit-control` | credit-control | admin | Load the credit-control payload (students + balances) |
| POST | `/api/credit-control/sync` | credit-control | admin | Manually trigger a credit-control data sync |
| POST | `/api/credit-control/actions` | credit-control | admin | Set or clear a single student's follow-up action status |
| POST | `/api/credit-control/actions/bulk` | credit-control | admin | Set or clear action status for many students at once |
| GET | `/api/credit-control/actions/history` | credit-control | admin | Recent action history for a student (`?studentKey=`) |
| POST | `/api/credit-control/admin-ownership` | credit-control | admin | Assign an admin owner to a student |
| POST | `/api/credit-control/inactive` | credit-control | admin | Mark a student inactive |
| DELETE | `/api/credit-control/inactive` | credit-control | admin | Clear a student's inactive flag |

## [Data Health](./misc.md) — `/api/data-health`

Operations health, cron-firing, data freshness, and normalization-issue dashboard.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/data-health` | data-health | admin | Ops command payload: cron health, data freshness, snapshot stats, and issue drill-downs |
| POST | `/api/data-health/jobs/[jobKey]/run` | data-health | admin | Manually trigger a registered data-health job; dangerous jobs require confirmation |

## [Filters](./misc.md) — `/api/filters`

Dropdown population for the search form.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/filters` | filters | admin | Distinct subjects/curriculums/levels from the active snapshot |

## [Home](./misc.md) — `/api/home`

Signed-in landing summary scoped to the user's allowed pages.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/home/summary` | home | session | Home payload for a signed-in full-access or restricted user |

## [Internal / Cron](./internal-crons.md) — `/api/internal`

Cron-triggered sync and automation jobs. `CRON_SECRET`-protected (`src/lib/internal/cron-auth.ts`); bypass the session gate via `src/middleware.ts:13`. Routes tagged **cron (or admin)** also run if an authenticated admin session is present and the cron secret check did not pass.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/internal/sync-wise` | internal | cron (or admin on POST) | Run the full Wise snapshot sync (Vercel cron via GET) |
| POST | `/api/internal/sync-wise` | internal | cron (or admin) | Manual full Wise snapshot sync (session or `curl`) |
| GET | `/api/internal/sync-wise-activity` | internal | cron | Sync newest Wise activity audit events |
| GET | `/api/internal/sync-credit-control` | internal | cron (or admin on POST) | Cron-trigger a credit-control sync |
| POST | `/api/internal/sync-credit-control` | internal | cron (or admin) | Manual credit-control sync (session or `curl`) |
| GET | `/api/internal/sync-sales-dashboard` | internal | cron (or admin on POST) | Cron-trigger a sales-dashboard import |
| POST | `/api/internal/sync-sales-dashboard` | internal | cron (or admin) | Manual sales-dashboard import (session or `curl`) |
| GET | `/api/internal/sync-competitor-intelligence` | internal | cron (or admin on POST) | Cron-trigger a competitor-intelligence sync |
| POST | `/api/internal/sync-competitor-intelligence` | internal | cron (or admin) | Manual competitor-intelligence sync (session or `curl`) |
| GET | `/api/internal/sync-leave-requests` | internal | cron | Cron-trigger a leave-requests sync |
| POST | `/api/internal/sync-leave-requests` | internal | cron | Trigger a leave-requests sync (same cron-secret check) |
| GET | `/api/internal/sync-progress-tests` | internal | cron (or admin on POST) | Cron-trigger a progress-tests sync |
| POST | `/api/internal/sync-progress-tests` | internal | cron (or admin) | Manual progress-tests sync (session or `curl`) |
| POST | `/api/internal/sync-room-utilization` | internal | cron (or admin) | Sync room-utilization sessions (session or `curl`) |
| GET | `/api/internal/class-assignments/admin-email` | internal | cron | Send the daily admin classroom-schedule email |
| GET | `/api/internal/class-assignments/morning` | internal | cron | Run the morning classroom-assignment automation |
| GET | `/api/internal/progress-tests/admin-digest` | internal | cron | Send the daily progress-test admin digest |
| GET | `/api/internal/line-backlog-recovery` | internal | cron | Recover LINE backlog identity matches |
| GET | `/api/internal/cron-watchdog` | internal | cron | Sweep stale cron invocations and alert-worthy failures |
| POST | `/api/internal/cron-watchdog` | internal | cron | Manual cron-watchdog replay with the cron secret |
| GET | `/api/internal/student-promotions/july-1` | internal | cron | Apply the verified July 1, 2026 student-promotion run |
| POST | `/api/internal/student-promotions/july-1` | internal | cron | Cron-secret replay alias for the July 1 student-promotion apply |
| GET | `/api/internal/admissions-notifications` | internal | cron | Daily admissions deadline-reminder scan (+ weekly digest on Bangkok Sundays); optional `?runType=` |
| POST | `/api/internal/admissions-notifications` | internal | cron | Manual admissions-notification trigger (bearer only; optional `runType` body) |

> **Admin-only sync (not cron):** `POST /api/admin/sync-wise` triggers the same Wise sync but is gated by an admin session via `auth()` (no `CRON_SECRET`) — see the [Admin](./misc.md) group.

## [Admin](./misc.md) — `/api/admin`

Admin-session-gated operational triggers (distinct from the `CRON_SECRET` internal routes).

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| POST | `/api/admin/sync-wise` | admin | admin | Manually trigger a Wise sync from an admin session |

## [Leave Requests](./misc.md) — `/api/leave-requests`

Teacher leave-request review: list, detail, update, manual sync, and Wise session-cancellation preview.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/leave-requests` | leave-requests | admin | List leave requests |
| POST | `/api/leave-requests/sync` | leave-requests | admin | Manually trigger a leave-requests sync |
| GET | `/api/leave-requests/[requestId]` | leave-requests | admin | Fetch a single leave request |
| PATCH | `/api/leave-requests/[requestId]` | leave-requests | admin | Update a leave request (status/decision) |
| POST | `/api/leave-requests/[requestId]/wise-cancel-preview` | leave-requests | admin | Preview Wise sessions that would be cancelled |

## [LINE](./line.md) — `/api/line`

LINE OA integration: inbound webhook, contact resolution & alias import, student linking, link validation, scheduler-review workflow, and the OA-resolver run pipeline.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| POST | `/api/line/webhook` | line | public | Inbound LINE webhook (verifies `x-line-signature`) |
| GET | `/api/line/students` | line | admin | List students known to the LINE integration |
| GET | `/api/line/scheduler-reviews` | line | admin | List scheduler-review items |
| PATCH | `/api/line/scheduler-reviews/[reviewId]` | line | admin | Update a scheduler-review item |
| GET | `/api/line/scheduler-reviews/[reviewId]/context` | line | admin | Fetch context for a scheduler review |
| GET | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | line | admin | List Wise action logs for a review |
| POST | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | line | admin | Confirm/execute a Wise action for a review |
| POST | `/api/line/scheduler-reviews/[reviewId]/operational-plan` | line | admin | Generate an operational plan for a review |
| GET | `/api/line/scheduler-reviews/false-negatives` | line | admin | List false-negative classification candidates |
| POST | `/api/line/messages/[messageId]/promote` | line | admin | Promote a LINE message into a scheduler review |
| PATCH | `/api/line/messages/[messageId]/classification-feedback` | line | admin | Record corrected classification for a message |
| PATCH | `/api/line/contacts/[contactId]` | line | admin | Update a LINE contact |
| GET | `/api/line/contacts/[contactId]/student-links` | line | admin | List a contact's student links |
| POST | `/api/line/contacts/[contactId]/student-links` | line | admin | Add a student link to a contact |
| PATCH | `/api/line/contacts/[contactId]/student-links` | line | admin | Update a contact's student links |
| GET | `/api/line/contacts/link-validation` | line | admin | List contact-link validation tasks |
| GET | `/api/line/contacts/link-validation/summary` | line | admin | Link-validation summary counts |
| POST | `/api/line/contacts/link-validation/assign` | line | admin | Assign link-validation tasks to reviewers |
| PATCH | `/api/line/contacts/link-validation/[linkId]` | line | admin | Resolve/update a single link-validation task |
| POST | `/api/line/contacts/alias-import/preview` | line | admin | Preview a contact alias import |
| POST | `/api/line/contacts/alias-import/commit` | line | admin | Commit a contact alias import |
| POST | `/api/line/contacts/refresh-profiles` | line | admin | Refresh all LINE contact profiles from LINE |
| POST | `/api/line/contacts/followers-reanchor` | line | admin | Run LINE follower reanchor plus backlog recovery |
| OPTIONS | `/api/line/contacts/oa-resolver/worklist` | line | public | CORS preflight for the OA-resolver extension worklist |
| GET | `/api/line/contacts/oa-resolver/worklist` | line | public | OA-resolver worklist (bearer-token gated in-handler) |
| GET | `/api/line/contacts/oa-resolver/runs` | line | admin | List OA-resolver runs |
| POST | `/api/line/contacts/oa-resolver/runs` | line | admin | Start a new OA-resolver run |
| GET | `/api/line/contacts/oa-resolver/runs/[runId]` | line | admin | Fetch a single OA-resolver run |
| OPTIONS | `/api/line/contacts/oa-resolver/runs/[runId]/rows` | line | public | CORS preflight for OA-resolver extension row submission |
| POST | `/api/line/contacts/oa-resolver/runs/[runId]/rows` | line | public | Submit resolver rows (bearer-token gated in-handler) |
| POST | `/api/line/contacts/oa-resolver/runs/[runId]/commit` | line | admin | Commit an OA-resolver run's results |

## [Payroll](./payroll.md) — `/api/payroll`

Tutor payroll: payload load, Wise-driven sync, review edits, and manual adjustments.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/payroll` | payroll | admin | Load the payroll payload |
| POST | `/api/payroll/sync` | payroll | admin | Run the payroll sync (Wise sessions → payroll) |
| PATCH | `/api/payroll/review` | payroll | admin | Update a payroll review entry |
| POST | `/api/payroll/adjustments` | payroll | admin | Add a manual payroll adjustment |
| DELETE | `/api/payroll/adjustments/[adjustmentId]` | payroll | admin | Delete a manual payroll adjustment |

## [Proposals](./proposals.md) — `/api/proposals`

Tentative scheduling "holds" (proposal bundles) with confirm/release/extend lifecycle.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| POST | `/api/proposals` | proposals | admin | Create a proposal bundle (tentative holds) |
| GET | `/api/proposals/active` | proposals | admin | List active proposal holds |
| PATCH | `/api/proposals/items/[itemId]` | proposals | admin | Confirm, release, or extend a proposal item |

## [Progress Tests](./misc.md) — `/api/progress-tests`

Progress-test booking and teacher follow-up workflow. Teachers can read their scoped payload; mutations are admin-only.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/progress-tests` | progress-tests | session | Load progress-test payload scoped to admin or teacher access |
| POST | `/api/progress-tests/book` | progress-tests | admin | Book a progress test for one enrollment |
| POST | `/api/progress-tests/mark-at-home-submitted` | progress-tests | admin | Mark an at-home test as submitted |
| POST | `/api/progress-tests/mark-complete` | progress-tests | admin | Mark a progress-test enrollment complete |
| POST | `/api/progress-tests/resend-email` | progress-tests | admin | Resend the progress-test teacher email |
| POST | `/api/progress-tests/select-at-home` | progress-tests | admin | Select the at-home progress-test path |

## [Room Capacity](./room-capacity.md) — `/api/room-capacity`

Room-utilization analytics and capacity forecasting.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/room-capacity/utilization` | room-capacity | admin | Room utilization over a date/weekday range |
| GET | `/api/room-capacity/month` | room-capacity | admin | Monthly room-capacity view (`?startDate=`) |
| GET | `/api/room-capacity/forecast` | room-capacity | admin | Room-capacity forecast (model runs / drivers) |

## [Sales Dashboard](./sales-dashboard.md) — `/api/sales-dashboard`

Sales reporting: payload load, tab dimensions, transaction drills/CSV export, source CRUD & seeding, Google-Sheets imports, import-run history, and projection source/import.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/sales-dashboard` | sales-dashboard | admin | Load the sales-dashboard payload |
| GET | `/api/sales-dashboard/dimensions` | sales-dashboard | admin | Load tab dimensions and filter facets |
| GET | `/api/sales-dashboard/transactions` | sales-dashboard | admin | Load filtered, paginated transaction drill rows |
| GET | `/api/sales-dashboard/transactions/export` | sales-dashboard | admin | Export all filtered transaction drill rows as CSV |
| POST | `/api/sales-dashboard/import` | sales-dashboard | admin | Import sales data (single source / backfill / refreshable) |
| GET | `/api/sales-dashboard/import-runs` | sales-dashboard | admin | List sales-dashboard import runs |
| GET | `/api/sales-dashboard/sources` | sales-dashboard | admin | List configured sales sources |
| POST | `/api/sales-dashboard/sources` | sales-dashboard | admin | Create a sales source |
| PATCH | `/api/sales-dashboard/sources/[sourceId]` | sales-dashboard | admin | Update a sales source |
| DELETE | `/api/sales-dashboard/sources/[sourceId]` | sales-dashboard | admin | Delete a sales source |
| POST | `/api/sales-dashboard/sources/seed` | sales-dashboard | admin | Seed the default set of sales sources |
| POST | `/api/sales-dashboard/projection-source` | sales-dashboard | admin | Configure / seed the projection source |
| POST | `/api/sales-dashboard/projection-import` | sales-dashboard | admin | Import the active projection source |

## [Search](./misc.md) — `/api/search`

Tutor availability search: range search, legacy slot search, and the public natural-language assistant.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| POST | `/api/search/range` | search | admin | Range search: time window + duration → availability grid |
| POST | `/api/search` | search | admin | Legacy slot-based availability search |
| POST | `/api/search/assistant` | search | public | Natural-language search assistant (public per middleware) |

## [Student Promotions](./student-promotions.md) — `/api/student-promotions`

Audited July 1, 2026 Wise student grade/course promotion workflow.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/student-promotions/runs` | student-promotions | admin | Load the latest promotion run detail |
| POST | `/api/student-promotions/runs` | student-promotions | admin | Run a fresh live-Wise dry-run audit |
| GET | `/api/student-promotions/runs/[runId]` | student-promotions | admin | Load one promotion run detail |
| POST | `/api/student-promotions/runs/[runId]/verify` | student-promotions | admin | Verify a reviewed dry run for July 1 apply |
| POST | `/api/student-promotions/runs/[runId]/apply` | student-promotions | admin | Manual fallback apply for a verified run |
| POST | `/api/student-promotions/runs/[runId]/future-sessions/apply` | student-promotions | admin | Gated apply for pending July 1+ Wise session subject updates |
| PATCH | `/api/student-promotions/runs/[runId]/graduation-actions/[actionId]` | student-promotions | admin | Set Year 13 graduate disposition |
| PATCH | `/api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review` | student-promotions | admin | Mark pay-rate impact reviewed correct/incorrect |
| POST | `/api/student-promotions/runs/[runId]/readback` | student-promotions | admin | Read-only live Wise readback after apply |

## [Tutor Profiles](./misc.md) — `/api/tutor-profiles`

Tutor business-profile records with edit and bulk import.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/tutor-profiles` | tutor-profiles | admin | List tutor business profiles |
| PATCH | `/api/tutor-profiles/[canonicalKey]` | tutor-profiles | admin | Update a tutor business profile (by canonical key) |
| POST | `/api/tutor-profiles/import-preview` | tutor-profiles | admin | Preview a tutor-profile bulk import |
| POST | `/api/tutor-profiles/import-commit` | tutor-profiles | admin | Commit a tutor-profile bulk import |

## [Tutors](./misc.md) — `/api/tutors`

Tutor combobox data source.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/tutors` | tutors | admin | All tutor names/IDs/modes/subjects from the active snapshot |

## [US Universities](./misc.md) — `/api/us-universities`

IPEDS-backed university exploration, comparison, profile, and CSV export endpoints.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/us-universities` | us-universities | admin | Load US university overview metrics and featured lists |
| GET | `/api/us-universities/search` | us-universities | admin | Search/filter US institutions |
| GET | `/api/us-universities/compare` | us-universities | admin | Compare selected institutions by `ids` query param |
| GET | `/api/us-universities/export` | us-universities | admin | Export filtered institution rows as CSV |
| GET | `/api/us-universities/institutions/[unitId]` | us-universities | admin | Load one institution profile |

## [University Admissions](./university-admissions.md) — `/api/admissions`

University admissions case management: caseload + case CRUD, memberships, checklist tasks/templates, meetings, college list + decisions, recommenders, essays, activities, testing, calendar, self-report sections, parent dashboard, notes, announcements, resources, registries, and the per-case audit trail. Auth is **session + min role** (see the legend above): `requireCaseAccess` re-resolves the caller's per-case role from Postgres on every request; "(claim)" rows gate on the JWT role from `requireAdmissionsSession`; "staff" rows use `requireCounselorOrAdmin`.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/admissions/cases` | admissions | session, counselor (claim) | Caseload for the signed-in staff user |
| POST | `/api/admissions/cases` | admissions | session, counselor (claim) | Create a case (student + members + checklist) |
| GET | `/api/admissions/cases/[caseId]` | admissions | session, min student | Full case detail (parents → parent dashboard) |
| PATCH | `/api/admissions/cases/[caseId]` | admissions | session, min counselor | Update case lifecycle/profile (optimistic concurrency) |
| GET | `/api/admissions/cases/[caseId]/members` | admissions | session, min counselor | List memberships (all statuses) |
| POST | `/api/admissions/cases/[caseId]/members` | admissions | session, min counselor | Add a parent/counselor member |
| PATCH | `/api/admissions/cases/[caseId]/members` | admissions | session, min counselor | Revoke / re-invite / change member email |
| GET | `/api/admissions/cases/[caseId]/tasks` | admissions | session, min student | Checklist tasks + progress |
| POST | `/api/admissions/cases/[caseId]/tasks` | admissions | session, min counselor | Create a custom task |
| PATCH | `/api/admissions/cases/[caseId]/tasks` | admissions | session, min student (per action) | Task status / verify / update / delete actions |
| DELETE | `/api/admissions/cases/[caseId]/tasks` | admissions | session, min counselor | Soft-delete a custom task (`?taskId=`) |
| GET | `/api/admissions/cases/[caseId]/meetings` | admissions | session, min student | List the meeting log |
| POST | `/api/admissions/cases/[caseId]/meetings` | admissions | session, min counselor | Log a meeting + action-item tasks |
| PATCH | `/api/admissions/cases/[caseId]/meetings` | admissions | session, min counselor | Edit a meeting |
| GET | `/api/admissions/cases/[caseId]/colleges` | admissions | session, min student | College list + IPEDS stats + completeness |
| POST | `/api/admissions/cases/[caseId]/colleges` | admissions | session, min counselor | Add a college (IPEDS `unitId` or manual entry) |
| PATCH | `/api/admissions/cases/[caseId]/colleges` | admissions | session, min counselor | Update plan fields (round/deadline/status/category/aid) |
| DELETE | `/api/admissions/cases/[caseId]/colleges` | admissions | session, min counselor | Soft-delete a list item (`?itemId=`) |
| GET | `/api/admissions/cases/[caseId]/colleges/[itemId]/events` | admissions | session, min student | Decision-event chain for one list item |
| POST | `/api/admissions/cases/[caseId]/colleges/[itemId]/events` | admissions | session, min counselor | Append a decision event (`committed` moves the pointer) |
| GET | `/api/admissions/cases/[caseId]/recommenders` | admissions | session, min student | Recommenders + college-doc rows |
| POST | `/api/admissions/cases/[caseId]/recommenders` | admissions | session, min counselor | Create a recommender |
| PATCH | `/api/admissions/cases/[caseId]/recommenders` | admissions | session, min counselor | update / link / submission / college_doc actions |
| DELETE | `/api/admissions/cases/[caseId]/recommenders` | admissions | session, min counselor | Soft-delete a recommender (`?recommenderId=`) |
| GET | `/api/admissions/cases/[caseId]/essays` | admissions | session, min student | Essay tracker rows |
| POST | `/api/admissions/cases/[caseId]/essays` | admissions | session, min student | Add an essay row |
| PATCH | `/api/admissions/cases/[caseId]/essays` | admissions | session, min student (staff fields counselor) | Update an essay |
| DELETE | `/api/admissions/cases/[caseId]/essays` | admissions | session, min counselor | Soft-delete an essay (`?essayId=`) |
| GET | `/api/admissions/cases/[caseId]/activities` | admissions | session, min student | Activities list, ranked first |
| POST | `/api/admissions/cases/[caseId]/activities` | admissions | session, min student | Add an activity |
| PATCH | `/api/admissions/cases/[caseId]/activities` | admissions | session, min student | update / rank (Common App top-10) actions |
| DELETE | `/api/admissions/cases/[caseId]/activities` | admissions | session, min student | Soft-delete an activity (`?activityId=`) |
| GET | `/api/admissions/cases/[caseId]/testing` | admissions | session, min student | Test sittings + best scores |
| POST | `/api/admissions/cases/[caseId]/testing` | admissions | session, min student | Add a test sitting |
| PATCH | `/api/admissions/cases/[caseId]/testing` | admissions | session, min student (`scoreReleasedToParent` counselor) | Update a sitting |
| DELETE | `/api/admissions/cases/[caseId]/testing` | admissions | session, min student | Delete a sitting (`?sittingId=`) |
| GET | `/api/admissions/cases/[caseId]/calendar` | admissions | session, min student | Dated items for a window + upcoming deadlines |
| GET | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | admissions | session, min student | Self-report section definition + saved state |
| PUT | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | admissions | session, min student | Autosave a partial section draft |
| POST | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | admissions | session, min student (`review` counselor) | submit / review state machine |
| GET | `/api/admissions/cases/[caseId]/parent-dashboard` | admissions | session, min parent | Closed parent projection |
| GET | `/api/admissions/cases/[caseId]/notes` | admissions | session, min student | Notes shaped for the reader's role |
| POST | `/api/admissions/cases/[caseId]/notes` | admissions | session, min counselor | Create a note (explicit visibility) |
| PATCH | `/api/admissions/cases/[caseId]/notes` | admissions | session, min counselor | Change a note's visibility |
| GET | `/api/admissions/announcements` | admissions | session, min student (case) / staff (cohort) | List announcements for one target (`?caseId=` xor `?cohortId=`) |
| POST | `/api/admissions/announcements` | admissions | session, min counselor (case) / staff (cohort) | Create an announcement |
| PATCH | `/api/admissions/announcements` | admissions | session, staff | Edit an announcement |
| DELETE | `/api/admissions/announcements` | admissions | session, staff | Soft-delete an announcement (`?announcementId=`) |
| GET | `/api/admissions/resources` | admissions | session (any role) | Resource library grouped by topic |
| POST | `/api/admissions/resources` | admissions | session, staff | Create a resource |
| PATCH | `/api/admissions/resources` | admissions | session, staff | Update a resource |
| DELETE | `/api/admissions/resources` | admissions | session, staff | Soft-delete a resource (`?resourceId=`) |
| GET | `/api/admissions/cohorts` | admissions | session, counselor (claim) | List cohorts |
| POST | `/api/admissions/cohorts` | admissions | session, admin (claim) | Create a cohort |
| GET | `/api/admissions/cohorts/[cohortId]/templates` | admissions | session, counselor (claim) | Latest checklist template + version history |
| POST | `/api/admissions/cohorts/[cohortId]/templates` | admissions | session, admin (claim) | create_version / push_new_items actions |
| PATCH | `/api/admissions/cohorts/[cohortId]/templates` | admissions | session, admin (claim) | Publish a draft template version |
| GET | `/api/admissions/counselors` | admissions | session, admin (claim) | Counselor registry (active + inactive) |
| POST | `/api/admissions/counselors` | admissions | session, admin (claim) | Upsert a counselor registry row |
| PATCH | `/api/admissions/counselors` | admissions | session, admin (claim) | Update or deactivate a registry row |
| GET | `/api/admissions/audit/[caseId]` | admissions | session, admin | One page of a case's audit trail |

> The admissions notification cron lives in the [Internal / Cron](./internal-crons.md) group above: `GET, POST /api/internal/admissions-notifications`.

## [Wise Activity](./wise-activity.md) — `/api/wise-activity`

Wise audit-event workspace: paginated events, summary KPIs, manual backfill sync, and package-sales reconciliation.

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| GET | `/api/wise-activity` | wise-activity | admin | Paginated persisted Wise activity events |
| GET | `/api/wise-activity/summary` | wise-activity | admin | Activity KPI cards and chart aggregates |
| POST | `/api/wise-activity/sync` | wise-activity | admin | Manual admin Wise activity backfill |
| GET | `/api/wise-activity/reconciliation` | wise-activity | admin | Wise package-sales reconciliation report |
| POST | `/api/wise-activity/reconciliation/backfill` | wise-activity | admin | Backfill events for reconciliation lookback window |

---

_API route inventory verified against HEAD on 2026-07-20 with `npm run docs:audit`._
