# API Reference — Master Index

The canonical lookup of every HTTP endpoint in BGScheduler. This page lists **method + path + group + auth + one-line purpose** only. Full request/response schemas, query parameters, and error shapes live on the per-group detail pages linked from the Group column.

All handlers live under `src/app/api/**/route.ts` (Next.js App Router). At this revision the tree holds **178 `route.ts` files exporting 241 method+path endpoints**.

> **Canonical-home rule:** this page owns the mechanical endpoint inventory only. Business meaning, rules, and flows live in `docs/features/*`; per-endpoint signatures live in the linked group pages.

## How to read the Auth column

Access tiers are verified against [`src/middleware.ts`](../../../src/middleware.ts) plus each route handler.

| Token | Meaning |
|---|---|
| `public` | Reachable without a session. `src/middleware.ts:4-20` allowlists `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/api/line/contacts/oa-resolver/worklist`, `/api/line/contacts/oa-resolver/runs/{runId}/rows`, and all of `/api/internal/*`. Public routes that touch data enforce their own in-handler check (LINE channel signature, or an opaque resolver bearer token). |
| `admin` | Authenticated Auth.js session. The middleware redirects unauthenticated page requests to `/login` and returns `403` for API paths outside a restricted user's `allowedPages` (`src/middleware.ts:63-91`); the handler additionally calls `auth()` (or a domain guard such as `requireCreditControlSession` / `requireProgressTestsSession` / `requireCompetitorIntelligenceSession`) and returns `401` with no session. |
| `admin + cap:X` | Admin session **plus** a fresh Postgres capability grant for Post-Class Feedback, re-read on every request and never cached in the JWT (`requirePostClassCapability`, [`src/lib/post-class-feedback/access.ts:153-176`](../../../src/lib/post-class-feedback/access.ts)). An explicit non-admin JWT role (currently `teacher`) fails closed with `403`. |
| `session (role: X)` | **University Admissions only** — the one family that is *not* admin-only. `requireAdmissionsSession` establishes the session, then per-case rights are re-resolved from Postgres by `requireCaseAccess` / `requireCounselorOrAdmin` / `requireAdmissionsAdmin` ([`src/lib/admissions/access.ts`](../../../src/lib/admissions/access.ts)) under the ordering `parent < student < counselor < admin`. The column shows the **minimum** role the handler passes to its guard. |
| `cron` | `CRON_SECRET`-protected. `src/middleware.ts:18` exempts `/api/internal/*` from the session gate; each handler then does a constant-time `Bearer ${CRON_SECRET}` comparison (`rejectInvalidCronSecret` / `getCronSecretStatus`, [`src/lib/internal/cron-auth.ts:6-26`](../../../src/lib/internal/cron-auth.ts), or an inline copy of the same length-prechecked `timingSafeEqual`). A missing `CRON_SECRET` returns `500`, a wrong one `401`. |
| `cron \| admin` | Same secret check, but the handler falls back to an Auth.js session when the secret is absent — used for the manual `POST` reruns of the sync pipelines (`handleSync(request, { allowSessionAuth: true })`). The paired `GET` on those routes is cron-only. |

Two entries deserve a call-out because middleware and handler disagree in the safe direction:

- **`POST /api/search/assistant`** sits on the middleware public allowlist, but the handler still requires a session and returns `401` without one (`src/app/api/search/assistant/route.ts:136-138`). It is listed as `admin`.
- **`POST /api/data-health/jobs/[jobKey]/run`** is an admin route that additionally demands the `access_manager` capability for any job whose key starts with `post_class_feedback` (`src/app/api/data-health/jobs/[jobKey]/run/route.ts:25-30`).

## Group directory

| Group | Path prefix | Endpoints | Detail page |
|---|---|---|---|
| admin | `/api/admin` | 1 | [misc.md](./misc.md) |
| admissions | `/api/admissions` | 61 | [university-admissions.md](./university-admissions.md) |
| ai-scheduler | `/api/ai-scheduler` | 8 | [ai-scheduler.md](./ai-scheduler.md) |
| auth | `/api/auth` | 2 | [misc.md](./misc.md) |
| class-assignments | `/api/class-assignments` | 8 | [classrooms-and-assignments.md](./classrooms-and-assignments.md) |
| classrooms | `/api/classrooms` | 2 | [classrooms-and-assignments.md](./classrooms-and-assignments.md) |
| compare | `/api/compare` | 2 | [misc.md](./misc.md) |
| competitor-intelligence | `/api/competitor-intelligence` | 9 | [competitor-intelligence.md](./misc.md#competitor-intelligence) |
| credit-control | `/api/credit-control` | 8 | [credit-control.md](./credit-control.md) |
| data-health | `/api/data-health` | 2 | [misc.md](./misc.md) |
| filters | `/api/filters` | 1 | [misc.md](./misc.md) |
| home | `/api/home` | 1 | [misc.md](./misc.md) |
| internal | `/api/internal` | 30 | [internal-crons.md](./internal-crons.md) |
| leave-requests | `/api/leave-requests` | 5 | [misc.md](./misc.md) |
| line | `/api/line` | 29 | [line.md](./line.md) |
| payroll | `/api/payroll` | 5 | [payroll.md](./payroll.md) |
| post-class-feedback | `/api/post-class-feedback` | 13 | [post-class-feedback.md](./misc.md#post-class-feedback) |
| progress-tests | `/api/progress-tests` | 6 | [progress-tests.md](./misc.md#progress-tests) |
| proposals | `/api/proposals` | 3 | [proposals.md](./proposals.md) |
| room-capacity | `/api/room-capacity` | 3 | [room-capacity.md](./room-capacity.md) |
| sales-dashboard | `/api/sales-dashboard` | 13 | [sales-dashboard.md](./sales-dashboard.md) |
| search | `/api/search` | 3 | [misc.md](./misc.md) |
| student-promotions | `/api/student-promotions` | 9 | [student-promotions.md](./student-promotions.md) |
| student-schedule | `/api/student-schedule` | 2 | [student-schedule.md](./misc.md#student-schedule) |
| tutor-profiles | `/api/tutor-profiles` | 4 | [misc.md](./misc.md) |
| tutors | `/api/tutors` | 1 | [misc.md](./misc.md) |
| us-universities | `/api/us-universities` | 5 | [us-universities.md](./misc.md#us-universities) |
| wise-activity | `/api/wise-activity` | 5 | [wise-activity.md](./wise-activity.md) |
| **Total** | | **241** | |

> The Group column links to the canonical detail filename for each group. Five of them — `competitor-intelligence.md`, `post-class-feedback.md`, `progress-tests.md`, `student-schedule.md`, `us-universities.md` — had not landed in `docs/reference/api/` when this index was generated; until they do, the handlers under the matching `src/app/api/<prefix>/` directory are the source of truth for those groups.

## Master endpoint table

| Method | Path | Group | Auth | Brief purpose |
|---|---|---|---|---|
| POST | `/api/admin/sync-wise` | [admin](./misc.md) | admin | Trigger a full Wise snapshot sync from an admin session; audited as `wise_snapshot`, `maxDuration=800` |
| DELETE | `/api/admissions/announcements` | [admissions](./university-admissions.md) | session (role: counselor) | Soft-delete an announcement (`?announcementId=`), re-anchored on the stored row's scope |
| GET | `/api/admissions/announcements` | [admissions](./university-admissions.md) | session (role: student / counselor) | Case-scoped merged announcement feed (`?caseId=`, min role student) or cohort broadcast list (`?cohortId=`, staff only) |
| PATCH | `/api/admissions/announcements` | [admissions](./university-admissions.md) | session (role: counselor) | Edit an announcement; rights re-anchor on the stored scope, never the request body |
| POST | `/api/admissions/announcements` | [admissions](./university-admissions.md) | session (role: counselor) | Create a case-scoped or cohort-scoped announcement (exactly one target) |
| GET | `/api/admissions/audit/[caseId]` | [admissions](./university-admissions.md) | session (role: admin) | One page of a case's append-only audit trail, newest first |
| GET | `/api/admissions/cases` | [admissions](./university-admissions.md) | session (role: counselor) | List the caller's caseload (admins see all, counselors only assigned cases) |
| POST | `/api/admissions/cases` | [admissions](./university-admissions.md) | session (role: counselor) | Create a new admissions case |
| GET | `/api/admissions/cases/[caseId]` | [admissions](./university-admissions.md) | session (role: parent) | Case header/profile, shaped for the reader's per-case role |
| PATCH | `/api/admissions/cases/[caseId]` | [admissions](./university-admissions.md) | session (role: counselor) | Update case profile fields |
| DELETE | `/api/admissions/cases/[caseId]/activities` | [admissions](./university-admissions.md) | session (role: student) | Remove an activity (`?activityId=`) |
| GET | `/api/admissions/cases/[caseId]/activities` | [admissions](./university-admissions.md) | session (role: student) | List the case's activity list |
| PATCH | `/api/admissions/cases/[caseId]/activities` | [admissions](./university-admissions.md) | session (role: student) | Update an activity, or reorder the Common App ranks |
| POST | `/api/admissions/cases/[caseId]/activities` | [admissions](./university-admissions.md) | session (role: student) | Add an activity |
| GET | `/api/admissions/cases/[caseId]/calendar` | [admissions](./university-admissions.md) | session (role: student) | Deadline calendar for a date window plus the upcoming-deadlines panel |
| DELETE | `/api/admissions/cases/[caseId]/colleges` | [admissions](./university-admissions.md) | session (role: counselor) | Remove a college-list item (`?itemId=`) |
| GET | `/api/admissions/cases/[caseId]/colleges` | [admissions](./university-admissions.md) | session (role: student) | College list with the stale flag and the completeness rollup |
| PATCH | `/api/admissions/cases/[caseId]/colleges` | [admissions](./university-admissions.md) | session (role: counselor) | Update a college-list item |
| POST | `/api/admissions/cases/[caseId]/colleges` | [admissions](./university-admissions.md) | session (role: counselor) | Add a college to the case list (soft-references `ipeds_institutions.unitId`) |
| GET | `/api/admissions/cases/[caseId]/colleges/[itemId]/events` | [admissions](./university-admissions.md) | session (role: student) | Application/decision event timeline for one college item |
| POST | `/api/admissions/cases/[caseId]/colleges/[itemId]/events` | [admissions](./university-admissions.md) | session (role: counselor) | Record an application/decision event; a commit event also sets the committed college |
| DELETE | `/api/admissions/cases/[caseId]/essays` | [admissions](./university-admissions.md) | session (role: counselor) | Remove an essay (`?essayId=`) |
| GET | `/api/admissions/cases/[caseId]/essays` | [admissions](./university-admissions.md) | session (role: student) | List essays, urgent first |
| PATCH | `/api/admissions/cases/[caseId]/essays` | [admissions](./university-admissions.md) | session (role: student) | Update an essay's status/content fields |
| POST | `/api/admissions/cases/[caseId]/essays` | [admissions](./university-admissions.md) | session (role: student) | Add an essay row |
| GET | `/api/admissions/cases/[caseId]/meetings` | [admissions](./university-admissions.md) | session (role: counselor) | List meetings — staff-only surface, because meeting notes are never family-visible |
| PATCH | `/api/admissions/cases/[caseId]/meetings` | [admissions](./university-admissions.md) | session (role: counselor) | Update a meeting |
| POST | `/api/admissions/cases/[caseId]/meetings` | [admissions](./university-admissions.md) | session (role: counselor) | Log a meeting |
| GET | `/api/admissions/cases/[caseId]/members` | [admissions](./university-admissions.md) | session (role: counselor) | List case membership (email → role) |
| PATCH | `/api/admissions/cases/[caseId]/members` | [admissions](./university-admissions.md) | session (role: counselor) | Change or deactivate a member's role |
| POST | `/api/admissions/cases/[caseId]/members` | [admissions](./university-admissions.md) | session (role: counselor) | Add a member (student/parent/counselor) to the case |
| GET | `/api/admissions/cases/[caseId]/notes` | [admissions](./university-admissions.md) | session (role: student) | List notes filtered to what the reader's per-case role may see |
| PATCH | `/api/admissions/cases/[caseId]/notes` | [admissions](./university-admissions.md) | session (role: counselor) | Edit a note or change its sharing visibility |
| POST | `/api/admissions/cases/[caseId]/notes` | [admissions](./university-admissions.md) | session (role: counselor) | Add a note (staff-only by default) |
| GET | `/api/admissions/cases/[caseId]/parent-dashboard` | [admissions](./university-admissions.md) | session (role: parent) | Curated read-only parent dashboard, built solely by the whitelisted projection helper |
| DELETE | `/api/admissions/cases/[caseId]/recommenders` | [admissions](./university-admissions.md) | session (role: counselor) | Remove a recommender (`?recommenderId=`) |
| GET | `/api/admissions/cases/[caseId]/recommenders` | [admissions](./university-admissions.md) | session (role: student) | List recommenders plus their college-doc rows |
| PATCH | `/api/admissions/cases/[caseId]/recommenders` | [admissions](./university-admissions.md) | session (role: counselor) | Update a recommender or its per-college submission state |
| POST | `/api/admissions/cases/[caseId]/recommenders` | [admissions](./university-admissions.md) | session (role: counselor) | Add a recommender |
| GET | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | [admissions](./university-admissions.md) | session (role: student) | Read one self-report section's stored payload |
| POST | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | [admissions](./university-admissions.md) | session (role: student) | Submit/advance a self-report section |
| PUT | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | [admissions](./university-admissions.md) | session (role: student) | Replace one self-report section's payload |
| DELETE | `/api/admissions/cases/[caseId]/tasks` | [admissions](./university-admissions.md) | session (role: counselor) | Remove a checklist task (`?taskId=`) |
| GET | `/api/admissions/cases/[caseId]/tasks` | [admissions](./university-admissions.md) | session (role: student) | Live checklist tasks plus phase progress |
| PATCH | `/api/admissions/cases/[caseId]/tasks` | [admissions](./university-admissions.md) | session (role: student) | Multiplexed task update (status, assignment, ordering) |
| POST | `/api/admissions/cases/[caseId]/tasks` | [admissions](./university-admissions.md) | session (role: counselor) | Create a counselor custom task |
| DELETE | `/api/admissions/cases/[caseId]/testing` | [admissions](./university-admissions.md) | session (role: student) | Remove a test sitting (`?sittingId=`) |
| GET | `/api/admissions/cases/[caseId]/testing` | [admissions](./university-admissions.md) | session (role: student) | List test sittings and scores |
| PATCH | `/api/admissions/cases/[caseId]/testing` | [admissions](./university-admissions.md) | session (role: student) | Partially update one test sitting |
| POST | `/api/admissions/cases/[caseId]/testing` | [admissions](./university-admissions.md) | session (role: student) | Add a test sitting |
| GET | `/api/admissions/cohorts` | [admissions](./university-admissions.md) | session (role: counselor) | List all cohorts (staff registry view) |
| POST | `/api/admissions/cohorts` | [admissions](./university-admissions.md) | session (role: admin) | Create a cohort |
| GET | `/api/admissions/cohorts/[cohortId]/templates` | [admissions](./university-admissions.md) | session (role: counselor) | List a cohort's checklist templates |
| PATCH | `/api/admissions/cohorts/[cohortId]/templates` | [admissions](./university-admissions.md) | session (role: admin) | Update a checklist template |
| POST | `/api/admissions/cohorts/[cohortId]/templates` | [admissions](./university-admissions.md) | session (role: admin) | Create a checklist template for the cohort |
| GET | `/api/admissions/counselors` | [admissions](./university-admissions.md) | session (role: admin) | List the full counselor registry, active and inactive |
| PATCH | `/api/admissions/counselors` | [admissions](./university-admissions.md) | session (role: admin) | Update or deactivate a counselor registry row |
| POST | `/api/admissions/counselors` | [admissions](./university-admissions.md) | session (role: admin) | Create/upsert a counselor by lowercase email — this grants sign-in capability |
| DELETE | `/api/admissions/resources` | [admissions](./university-admissions.md) | session (role: counselor) | Remove a resource (`?resourceId=`) |
| GET | `/api/admissions/resources` | [admissions](./university-admissions.md) | session (any admissions role) | List the shared resource library, grouped |
| PATCH | `/api/admissions/resources` | [admissions](./university-admissions.md) | session (role: counselor) | Update a resource entry |
| POST | `/api/admissions/resources` | [admissions](./university-admissions.md) | session (role: counselor) | Add a resource entry |
| GET | `/api/ai-scheduler/conversations` | [ai-scheduler](./ai-scheduler.md) | admin | List scheduler conversations (`?sort=` validated) |
| POST | `/api/ai-scheduler/conversations` | [ai-scheduler](./ai-scheduler.md) | admin | Create a conversation (`201`) |
| DELETE | `/api/ai-scheduler/conversations/[conversationId]` | [ai-scheduler](./ai-scheduler.md) | admin | Delete a conversation |
| GET | `/api/ai-scheduler/conversations/[conversationId]` | [ai-scheduler](./ai-scheduler.md) | admin | Fetch one conversation with its messages |
| PATCH | `/api/ai-scheduler/conversations/[conversationId]` | [ai-scheduler](./ai-scheduler.md) | admin | Update conversation metadata (title, archive state) |
| POST | `/api/ai-scheduler/conversations/[conversationId]/messages` | [ai-scheduler](./ai-scheduler.md) | admin | Run one scheduler turn: persist the admin message, execute the turn, persist the reply (`503` unconfigured, `409` archived) |
| POST | `/api/ai-scheduler/messages/[messageId]/feedback` | [ai-scheduler](./ai-scheduler.md) | admin | Record accept/edit/reject feedback on an assistant message |
| GET | `/api/ai-scheduler/metrics` | [ai-scheduler](./ai-scheduler.md) | admin | Scheduler, LINE, and correction-telemetry metrics |
| GET | `/api/auth/[...nextauth]` | [auth](./misc.md) | public | Auth.js catch-all (sign-in, callback, session, CSRF) |
| POST | `/api/auth/[...nextauth]` | [auth](./misc.md) | public | Auth.js catch-all (sign-in, callback, sign-out) |
| GET | `/api/class-assignments` | [class-assignments](./classrooms-and-assignments.md) | admin | Latest room-assignment run for a Bangkok `?date=` |
| POST | `/api/class-assignments/run` | [class-assignments](./classrooms-and-assignments.md) | admin | Generate a new local assignment run for a date (never writes to Wise) |
| POST | `/api/class-assignments/runs/[runId]/publish` | [class-assignments](./classrooms-and-assignments.md) | admin | Start the publish job that writes eligible OFFLINE `location` values back to Wise (`202` + `jobId`) |
| GET | `/api/class-assignments/runs/[runId]/publish/[jobId]` | [class-assignments](./classrooms-and-assignments.md) | admin | Poll a publish job's progress |
| PATCH | `/api/class-assignments/runs/[runId]/rows/[rowId]` | [class-assignments](./classrooms-and-assignments.md) | admin | Override one row's room and recompute the run |
| GET | `/api/class-assignments/runs/[runId]/schedule-email/preview` | [class-assignments](./classrooms-and-assignments.md) | admin | Preview the per-teacher schedule emails for a run |
| POST | `/api/class-assignments/runs/[runId]/schedule-email/send` | [class-assignments](./classrooms-and-assignments.md) | admin | Send the per-teacher schedule emails for a run |
| GET | `/api/class-assignments/runs/[runId]/teacher-schedule` | [class-assignments](./classrooms-and-assignments.md) | admin | Teacher-grouped view of a run's assignments |
| GET | `/api/classrooms/floor-plan-map` | [classrooms](./classrooms-and-assignments.md) | public | Render the floor-plan SVG with `?rooms=` highlighted (`image/svg+xml`, `max-age=3600`) |
| GET | `/api/classrooms/rooms` | [classrooms](./classrooms-and-assignments.md) | admin | Room catalog |
| POST | `/api/compare` | [compare](./misc.md) | admin | Build the week-scoped compare payload for 1–3 tutors (schedules, conflicts, shared free slots, past-session blocks) |
| POST | `/api/compare/discover` | [compare](./misc.md) | admin | Discover candidate tutors to compare, against the in-memory snapshot index |
| GET | `/api/competitor-intelligence` | [competitor-intelligence](./misc.md#competitor-intelligence) | admin | Competitor-intelligence dashboard payload |
| POST | `/api/competitor-intelligence/manual-evidence` | [competitor-intelligence](./misc.md#competitor-intelligence) | admin | Record a manually captured piece of competitor evidence |
| GET | `/api/competitor-intelligence/own-sources` | [competitor-intelligence](./misc.md#competitor-intelligence) | admin | List own-brand monitoring sources |
| POST | `/api/competitor-intelligence/own-sources` | [competitor-intelligence](./misc.md#competitor-intelligence) | admin | Create an own-brand source (`201`) |
| PATCH | `/api/competitor-intelligence/own-sources/[sourceId]` | [competitor-intelligence](./misc.md#competitor-intelligence) | admin | Update or disable an own-brand source |
| PATCH | `/api/competitor-intelligence/sources/[sourceId]` | [competitor-intelligence](./misc.md#competitor-intelligence) | admin | Set a competitor source's status |
| POST | `/api/competitor-intelligence/sync` | [competitor-intelligence](./misc.md#competitor-intelligence) | admin | Run the competitor-intelligence sync now (`409` when one is already running) |
| POST | `/api/competitor-intelligence/task-suggestions/[suggestionId]/accept` | [competitor-intelligence](./misc.md#competitor-intelligence) | admin | Promote a suggested action into a tracked task |
| PATCH | `/api/competitor-intelligence/tasks/[taskId]` | [competitor-intelligence](./misc.md#competitor-intelligence) | admin | Update a competitor-intelligence task |
| GET | `/api/credit-control` | [credit-control](./credit-control.md) | admin | Credit-control dashboard payload (at-risk follow-up queue) |
| POST | `/api/credit-control/actions` | [credit-control](./credit-control.md) | admin | Set or clear the follow-up action for one `studentKey` |
| POST | `/api/credit-control/actions/bulk` | [credit-control](./credit-control.md) | admin | Set or clear the follow-up action for many `studentKeys` |
| GET | `/api/credit-control/actions/history` | [credit-control](./credit-control.md) | admin | Last 7 action-history rows for `?studentKey=` (`400` without it) |
| POST | `/api/credit-control/admin-ownership` | [credit-control](./credit-control.md) | admin | Assign an admin owner to a student |
| DELETE | `/api/credit-control/inactive` | [credit-control](./credit-control.md) | admin | Clear a student's inactive flag |
| POST | `/api/credit-control/inactive` | [credit-control](./credit-control.md) | admin | Mark a student inactive (drops them from the queue) |
| POST | `/api/credit-control/sync` | [credit-control](./credit-control.md) | admin | Run the credit-control sync on demand (`maxDuration=300`) |
| GET | `/api/data-health` | [data-health](./misc.md) | admin | Sync status, snapshot stats, and normalization-issue counts |
| POST | `/api/data-health/jobs/[jobKey]/run` | [data-health](./misc.md) | admin (+ cap:access_manager for `post_class_feedback*` jobs) | Manually run a registered cron job (`404` unknown key); jobs flagged `dangerous` need `confirmed:true` or return `409` |
| GET | `/api/filters` | [filters](./misc.md) | admin | Facet options for the search filter dropdowns |
| GET | `/api/home/summary` | [home](./misc.md) | admin | Landing-page summary tiles, scoped to the caller's `allowedPages` |
| GET | `/api/internal/admissions-notifications` | [internal](./internal-crons.md) | cron | Daily admissions deadline scan, plus the weekly digest on Bangkok Sundays |
| POST | `/api/internal/admissions-notifications` | [internal](./internal-crons.md) | cron | Same pass with an explicit `runType` (`daily` \| `weekly`) in the body |
| GET | `/api/internal/class-assignments/admin-email` | [internal](./internal-crons.md) | cron | Send the daily admin classroom-schedule summary email |
| GET | `/api/internal/class-assignments/morning` | [internal](./internal-crons.md) | cron | Morning automation: generate the day's assignment run and dispatch teacher schedules |
| GET | `/api/internal/cron-watchdog` | [internal](./internal-crons.md) | cron | Sweep stale/abandoned cron invocation rows and surface missed schedules |
| POST | `/api/internal/cron-watchdog` | [internal](./internal-crons.md) | cron | Same watchdog sweep, manual trigger |
| GET | `/api/internal/line-backlog-recovery` | [internal](./internal-crons.md) | cron | Re-scan unmatched LINE contacts to recover the matching backlog (does not re-anchor followers) |
| GET | `/api/internal/post-class-feedback-backfill` | [internal](./internal-crons.md) | cron | Backfill one post-class window (explicit range, else the oldest unreconciled one); `409` when already running |
| GET | `/api/internal/post-class-feedback/admin-digest` | [internal](./internal-crons.md) | cron | Send the post-class feedback admin digest |
| GET | `/api/internal/post-class-feedback/payout-accrual` | [internal](./internal-crons.md) | cron | Run the payout accrual pass followed by the finalize pass |
| GET | `/api/internal/post-class-feedback/reminder-day-after` | [internal](./internal-crons.md) | cron | Send the day-after tutor feedback reminders |
| GET | `/api/internal/post-class-feedback/reminder-deadline` | [internal](./internal-crons.md) | cron | Send the deadline tutor feedback reminders |
| GET | `/api/internal/progress-tests/admin-digest` | [internal](./internal-crons.md) | cron | Send the progress-tests admin digest |
| GET | `/api/internal/student-promotions/july-1` | [internal](./internal-crons.md) | cron | Apply the verified student-promotion run; `409` on any Bangkok date other than the July 1, 2026 target (`maxDuration=800`) |
| POST | `/api/internal/student-promotions/july-1` | [internal](./internal-crons.md) | cron | Identical to the `GET` — the handler delegates straight to it |
| GET | `/api/internal/sync-competitor-intelligence` | [internal](./internal-crons.md) | cron | Weekly competitor-intelligence sync (Vercel cron entry) |
| POST | `/api/internal/sync-competitor-intelligence` | [internal](./internal-crons.md) | cron \| admin | Manual rerun of the competitor-intelligence sync |
| GET | `/api/internal/sync-credit-control` | [internal](./internal-crons.md) | cron | Credit-control snapshot sync (Vercel cron entry) |
| POST | `/api/internal/sync-credit-control` | [internal](./internal-crons.md) | cron \| admin | Manual rerun of the credit-control sync |
| GET | `/api/internal/sync-leave-requests` | [internal](./internal-crons.md) | cron | Pull leave-request rows from the Google Sheet and recompute affected sessions (`409` when running) |
| POST | `/api/internal/sync-leave-requests` | [internal](./internal-crons.md) | cron | Same leave-request sync, manual trigger — still cron-secret only |
| GET | `/api/internal/sync-post-class-feedback` | [internal](./internal-crons.md) | cron | Collect the rolling post-class feedback window (`409` when running) |
| GET | `/api/internal/sync-progress-tests` | [internal](./internal-crons.md) | cron | Progress-tests sync (Vercel cron entry) |
| POST | `/api/internal/sync-progress-tests` | [internal](./internal-crons.md) | cron \| admin | Manual rerun of the progress-tests sync |
| POST | `/api/internal/sync-room-utilization` | [internal](./internal-crons.md) | cron \| admin | Refresh `room_utilization_sessions` from Wise (no `GET` variant on this route) |
| GET | `/api/internal/sync-sales-dashboard` | [internal](./internal-crons.md) | cron | Re-import refreshable sales sources plus the active projection source |
| POST | `/api/internal/sync-sales-dashboard` | [internal](./internal-crons.md) | cron \| admin | Manual rerun of the sales-dashboard import |
| GET | `/api/internal/sync-wise` | [internal](./internal-crons.md) | cron | Full Wise snapshot ETL (`*/30` cron; `maxDuration=800`) |
| POST | `/api/internal/sync-wise` | [internal](./internal-crons.md) | cron \| admin | Manual rerun of the Wise snapshot ETL (`curl` with the secret, or an admin session) |
| GET | `/api/internal/sync-wise-activity` | [internal](./internal-crons.md) | cron | Ingest new Wise activity/audit events into the append-only store (`409` when running) |
| GET | `/api/leave-requests` | [leave-requests](./misc.md) | admin | Leave-request worklist plus the caller's Google Sheets token status |
| GET | `/api/leave-requests/[requestId]` | [leave-requests](./misc.md) | admin | One leave request with its affected sessions (`404` if unknown) |
| PATCH | `/api/leave-requests/[requestId]` | [leave-requests](./misc.md) | admin | Update the workflow status, optionally writing that status back to the source sheet |
| POST | `/api/leave-requests/[requestId]/wise-cancel-preview` | [leave-requests](./misc.md) | admin | Dry-run preview of the Wise session cancellations a request would cause |
| POST | `/api/leave-requests/sync` | [leave-requests](./misc.md) | admin | Manual leave-request sheet sync (`409` when one is already running) |
| PATCH | `/api/line/contacts/[contactId]` | [line](./line.md) | admin | Update a contact's labels and refresh its student-link suggestions |
| GET | `/api/line/contacts/[contactId]/student-links` | [line](./line.md) | admin | List the contact's student links, ensuring suggestions exist |
| PATCH | `/api/line/contacts/[contactId]/student-links` | [line](./line.md) | admin | Update one student link on the contact |
| POST | `/api/line/contacts/[contactId]/student-links` | [line](./line.md) | admin | Create a verified contact→student link (`201`) |
| POST | `/api/line/contacts/alias-import/commit` | [line](./line.md) | admin | Commit a previewed LINE alias import |
| POST | `/api/line/contacts/alias-import/preview` | [line](./line.md) | admin | Preview an alias import from pasted chat-list text or an uploaded screenshot (multipart) |
| POST | `/api/line/contacts/followers-reanchor` | [line](./line.md) | admin | Re-anchor OA followers onto contacts and report the remaining backlog |
| GET | `/api/line/contacts/link-validation` | [line](./line.md) | admin | Paged link-validation worklist (`?scope=` default `my`, `?runId=`, `?page=`, `?pageSize=` max 100) |
| PATCH | `/api/line/contacts/link-validation/[linkId]` | [line](./line.md) | admin | Record a validation decision on one student link |
| POST | `/api/line/contacts/link-validation/assign` | [line](./line.md) | admin | Assign link-validation tasks to a reviewer |
| GET | `/api/line/contacts/link-validation/summary` | [line](./line.md) | admin | Aggregate link-validation counters (optionally per `?runId=`) |
| GET | `/api/line/contacts/oa-resolver/runs` | [line](./line.md) | admin | List OA-resolver runs, or fetch one by query |
| POST | `/api/line/contacts/oa-resolver/runs` | [line](./line.md) | admin | Start a new OA-resolver run |
| GET | `/api/line/contacts/oa-resolver/runs/[runId]` | [line](./line.md) | admin | Fetch one resolver run (`404` if unknown) |
| POST | `/api/line/contacts/oa-resolver/runs/[runId]/commit` | [line](./line.md) | admin | Commit a resolver run's matched rows into contact links |
| POST | `/api/line/contacts/oa-resolver/runs/[runId]/rows` | [line](./line.md) | public (resolver bearer token) | Browser-extension callback posting resolved rows for a run; CORS-enabled (`OPTIONS` preflight), token-authenticated |
| GET | `/api/line/contacts/oa-resolver/worklist` | [line](./line.md) | public (resolver bearer token) | Browser-extension worklist for a resolver token (`401` on an invalid/expired token) |
| POST | `/api/line/contacts/refresh-profiles` | [line](./line.md) | admin | Refresh LINE profile names/avatars for known contacts |
| PATCH | `/api/line/messages/[messageId]/classification-feedback` | [line](./line.md) | admin | Record classifier feedback on an inbound LINE message |
| POST | `/api/line/messages/[messageId]/promote` | [line](./line.md) | admin | Promote an inbound message into a scheduler review (idempotent) |
| GET | `/api/line/scheduler-reviews` | [line](./line.md) | admin | Scheduler review queue plus queue analytics (`?status=`, `?intentType=`) |
| PATCH | `/api/line/scheduler-reviews/[reviewId]` | [line](./line.md) | admin | Decide a review: `approve_send`, `accept_no_send`, `reject` (reason + staff correction), or `dismiss` |
| GET | `/api/line/scheduler-reviews/[reviewId]/context` | [line](./line.md) | admin | Conversation and student context behind one review |
| POST | `/api/line/scheduler-reviews/[reviewId]/operational-plan` | [line](./line.md) | admin | Rebuild the operational plan for a pending review (`400` if not pending) |
| GET | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | [line](./line.md) | admin | Wise-action audit log for one review |
| POST | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | [line](./line.md) | admin | Confirm a Wise action for a review (flag-gated, dry-run) |
| GET | `/api/line/scheduler-reviews/false-negatives` | [line](./line.md) | admin | Candidate messages the classifier likely missed, above a confidence `?threshold=` |
| GET | `/api/line/students` | [line](./line.md) | admin | Student lookup used by the contact-linking UI |
| POST | `/api/line/webhook` | [line](./line.md) | public (LINE signature) | LINE Messaging API webhook: verifies `x-line-signature`, stores events, then classifies/schedules in `after()` (`503` when unconfigured) |
| GET | `/api/payroll` | [payroll](./payroll.md) | admin | Payroll payload for `?month=YYYY-MM` (defaults to the current Bangkok month) |
| POST | `/api/payroll/adjustments` | [payroll](./payroll.md) | admin | Add a manual payroll adjustment (`month` + `description` required) |
| DELETE | `/api/payroll/adjustments/[adjustmentId]` | [payroll](./payroll.md) | admin | Remove a manual adjustment (`404` if unknown) |
| PATCH | `/api/payroll/review` | [payroll](./payroll.md) | admin | Set a month's review status and return the refreshed payload |
| POST | `/api/payroll/sync` | [payroll](./payroll.md) | admin | Run the payroll reconciliation sync for a month (`409` when one is already running) |
| GET | `/api/post-class-feedback` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:viewer | Post-class feedback dashboard payload |
| PATCH | `/api/post-class-feedback/access` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:access_manager | Grant or revoke one capability for one admin email |
| POST | `/api/post-class-feedback/ai-review` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:reviewer | Run the AI review pass over pending feedback |
| POST | `/api/post-class-feedback/finance` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:finance | Record a finance-side deduction |
| POST | `/api/post-class-feedback/finance-periods` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:finance | Open or close a finance period |
| POST | `/api/post-class-feedback/payout-runs` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:finance | Multiplexed payout-run action: `preview`, `publish`, `retry_csv`, or `resolve_exception` (write actions re-resolve the target) |
| POST | `/api/post-class-feedback/review` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:reviewer | Record a reviewer decision/deduction on a session |
| GET | `/api/post-class-feedback/sessions/[sessionId]` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:viewer | Full detail for one post-class session |
| PATCH | `/api/post-class-feedback/settings` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:access_manager | Update post-class feature settings |
| POST | `/api/post-class-feedback/shadow-review` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:access_manager | Mark shadow-review results as reviewed |
| POST | `/api/post-class-feedback/sync` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:access_manager | Manual post-class feedback sync |
| POST | `/api/post-class-feedback/test-email` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:access_manager | Send a test feedback email to a chosen recipient |
| PATCH | `/api/post-class-feedback/tutor-emails` | [post-class-feedback](./misc.md#post-class-feedback) | admin + cap:access_manager | Set a tutor's primary notification email |
| GET | `/api/progress-tests` | [progress-tests](./misc.md#progress-tests) | admin (teacher role allowed, scoped) | Progress-tests payload; a `teacher` session is narrowed to that teacher's canonical keys |
| POST | `/api/progress-tests/book` | [progress-tests](./misc.md#progress-tests) | admin | Book an on-site progress test for an enrollment |
| POST | `/api/progress-tests/mark-at-home-submitted` | [progress-tests](./misc.md#progress-tests) | admin | Mark an at-home test as submitted |
| POST | `/api/progress-tests/mark-complete` | [progress-tests](./misc.md#progress-tests) | admin | Mark a progress test complete |
| POST | `/api/progress-tests/resend-email` | [progress-tests](./misc.md#progress-tests) | admin | Resend the teacher notification email for an enrollment |
| POST | `/api/progress-tests/select-at-home` | [progress-tests](./misc.md#progress-tests) | admin | Switch an enrollment to the at-home test path |
| POST | `/api/proposals` | [proposals](./proposals.md) | admin | Create a proposal bundle of tentative tutor holds (overlap-checked against the index) |
| GET | `/api/proposals/active` | [proposals](./proposals.md) | admin | List currently active holds |
| PATCH | `/api/proposals/items/[itemId]` | [proposals](./proposals.md) | admin | Advance one hold's lifecycle (confirm / release / expire) |
| GET | `/api/room-capacity/forecast` | [room-capacity](./room-capacity.md) | admin | Saturation forecast for `?scenario=` (default `Base`); returns a typed empty payload when the forecast table is absent |
| GET | `/api/room-capacity/month` | [room-capacity](./room-capacity.md) | admin | Month-pressure view for `?startDate`/`?endDate` |
| GET | `/api/room-capacity/utilization` | [room-capacity](./room-capacity.md) | admin | Room utilization for a date range and optional `?weekdays=` filter |
| GET | `/api/sales-dashboard` | [sales-dashboard](./sales-dashboard.md) | admin | GM sales command-center payload |
| GET | `/api/sales-dashboard/dimensions` | [sales-dashboard](./sales-dashboard.md) | admin | Dimension/facet lists for the dashboard filters |
| POST | `/api/sales-dashboard/import` | [sales-dashboard](./sales-dashboard.md) | admin | Import sales sources — `mode:"backfill"` (all), a single `sourceId`, or the refreshable set by default |
| GET | `/api/sales-dashboard/import-runs` | [sales-dashboard](./sales-dashboard.md) | admin | Recent import-run history |
| POST | `/api/sales-dashboard/projection-import` | [sales-dashboard](./sales-dashboard.md) | admin | Re-import the active scenario-projection source (`409` when none is configured or the Sheets token is missing) |
| POST | `/api/sales-dashboard/projection-source` | [sales-dashboard](./sales-dashboard.md) | admin | Upsert the projection source, or seed the default when no body is supplied |
| GET | `/api/sales-dashboard/sources` | [sales-dashboard](./sales-dashboard.md) | admin | List configured monthly sales sources |
| POST | `/api/sales-dashboard/sources` | [sales-dashboard](./sales-dashboard.md) | admin | Create or update a sales source |
| DELETE | `/api/sales-dashboard/sources/[sourceId]` | [sales-dashboard](./sales-dashboard.md) | admin | Archive a sales source (`404` if unknown) |
| PATCH | `/api/sales-dashboard/sources/[sourceId]` | [sales-dashboard](./sales-dashboard.md) | admin | Change a sales source's status (`404` if unknown) |
| POST | `/api/sales-dashboard/sources/seed` | [sales-dashboard](./sales-dashboard.md) | admin | Seed the default historical source set |
| GET | `/api/sales-dashboard/transactions` | [sales-dashboard](./sales-dashboard.md) | admin | Paged/filtered transaction rows from the live slim dataset |
| GET | `/api/sales-dashboard/transactions/export` | [sales-dashboard](./sales-dashboard.md) | admin | The same filtered transactions as a downloadable file |
| POST | `/api/search` | [search](./misc.md) | admin | Legacy single-slot availability search against the warm snapshot index |
| POST | `/api/search/assistant` | [search](./misc.md) | admin | One-shot NL scheduling-assistant turn; logs a scheduler run. Middleware-public, but the handler still requires a session |
| POST | `/api/search/range` | [search](./misc.md) | admin | Range search: time window + class duration → availability grid with fail-closed Needs-Review routing |
| GET | `/api/student-promotions/runs` | [student-promotions](./student-promotions.md) | admin | Latest student-promotion run detail |
| POST | `/api/student-promotions/runs` | [student-promotions](./student-promotions.md) | admin | Create a dry-run promotion run (`201`) |
| GET | `/api/student-promotions/runs/[runId]` | [student-promotions](./student-promotions.md) | admin | One promotion run's full detail |
| POST | `/api/student-promotions/runs/[runId]/apply` | [student-promotions](./student-promotions.md) | admin | Apply a verified run to Wise (`confirm:"apply-student-promotions"` required, else `400`) |
| POST | `/api/student-promotions/runs/[runId]/future-sessions/apply` | [student-promotions](./student-promotions.md) | admin | Apply the future-session subject changes (separate `confirm` constant, else `400`) |
| PATCH | `/api/student-promotions/runs/[runId]/graduation-actions/[actionId]` | [student-promotions](./student-promotions.md) | admin | Set a graduation action's disposition |
| PATCH | `/api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review` | [student-promotions](./student-promotions.md) | admin | Record the review decision on one pay-rate impact |
| POST | `/api/student-promotions/runs/[runId]/readback` | [student-promotions](./student-promotions.md) | admin | Read back post-apply state from Wise to confirm the run landed |
| POST | `/api/student-promotions/runs/[runId]/verify` | [student-promotions](./student-promotions.md) | admin | Verify a dry run (requires the endpoint-verification confirmation and note) |
| GET | `/api/student-schedule` | [student-schedule](./misc.md#student-schedule) | admin | Monthly student calendar for `?studentKey=` + `?month=YYYY-MM` (`404` when the student is unknown) |
| POST | `/api/student-schedule/link` | [student-schedule](./misc.md#student-schedule) | admin | Mint a capability-token parent link to a student's monthly schedule (public `/schedule/{token}` page, TTL-bounded) |
| GET | `/api/tutor-profiles` | [tutor-profiles](./misc.md) | admin | List editorial tutor business profiles |
| PATCH | `/api/tutor-profiles/[canonicalKey]` | [tutor-profiles](./misc.md) | admin | Upsert one tutor's business profile (`404` unless the tutor is in the active snapshot) |
| POST | `/api/tutor-profiles/import-commit` | [tutor-profiles](./misc.md) | admin | Commit a previewed bulk profile import |
| POST | `/api/tutor-profiles/import-preview` | [tutor-profiles](./misc.md) | admin | Parse uploaded tutor-profile workbooks (multipart) into a preview |
| GET | `/api/tutors` | [tutors](./misc.md) | admin | Tutor list backing the searchable combobox |
| GET | `/api/us-universities` | [us-universities](./misc.md#us-universities) | admin | IPEDS overview payload for the research console |
| GET | `/api/us-universities/compare` | [us-universities](./misc.md#us-universities) | admin | Side-by-side institution comparison for a set of `unitId`s |
| GET | `/api/us-universities/export` | [us-universities](./misc.md#us-universities) | admin | Export the filtered institution set as `us-universities.csv` |
| GET | `/api/us-universities/institutions/[unitId]` | [us-universities](./misc.md#us-universities) | admin | Full institution profile (`404` if unknown) |
| GET | `/api/us-universities/search` | [us-universities](./misc.md#us-universities) | admin | Filtered/paged institution search |
| GET | `/api/wise-activity` | [wise-activity](./wise-activity.md) | admin | Paged Wise activity events for a date range and filters |
| GET | `/api/wise-activity/reconciliation` | [wise-activity](./wise-activity.md) | admin | Package-sales reconciliation for a `?month=` or explicit date range |
| POST | `/api/wise-activity/reconciliation/backfill` | [wise-activity](./wise-activity.md) | admin | Backfill activity events over an explicit date range (`409` when a sync is running) |
| GET | `/api/wise-activity/summary` | [wise-activity](./wise-activity.md) | admin | KPI summary over a date range |
| POST | `/api/wise-activity/sync` | [wise-activity](./wise-activity.md) | admin | Manual Wise activity ingest (`409` when a sync is running) |

## Notes on the counts

- **178 `route.ts` files → 241 endpoints.** The gap is entirely multi-method files (for example `/api/admissions/cases/[caseId]/tasks` exports `GET`, `POST`, `PATCH`, and `DELETE` from one file).
- `src/app/api/auth/[...nextauth]/route.ts` re-exports the framework's `GET`/`POST` handlers rather than declaring them, so it contributes two endpoints without a hand-written `export async function` signature.
- The 15 Vercel Cron entries in [`vercel.json`](../../../vercel.json) all point at `/api/internal/*` `GET` handlers. The `/api/internal` group is larger than 15 because several of those routes also expose a manual `POST`, and several internal jobs (the post-class reminder/digest/accrual passes, `line-backlog-recovery`) are invoked out-of-band rather than from `vercel.json`. Schedules live in [`crons.md`](../crons.md).
- `OPTIONS` preflight handlers on the two CORS-enabled OA-resolver routes are not counted as endpoints.
- Paths use the on-disk dynamic-segment syntax (`[caseId]`, `[...nextauth]`). Per-group pages sometimes render the same segments as `{caseId}`.

_Verified against HEAD + uncommitted WIP on 2026-05-31._
