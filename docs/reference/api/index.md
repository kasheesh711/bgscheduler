# API Reference — Master Endpoint Index

The canonical lookup of **every** HTTP endpoint in BGScheduler. All routes are Next.js App Router handlers under `src/app/api/**/route.ts`; one file can export several methods, so the 111 route files below resolve to **130 endpoints** (each method+path row below is one endpoint — 54 GET + 60 POST + 12 PATCH + 4 DELETE; the Auth.js `[...nextauth]` catch-all counts as its GET + POST, and CORS `OPTIONS` preflight handlers are not listed).

This page is the index only — method, path, group, auth tier, and a one-line purpose. Full request/response shapes, body schemas, and status codes live on the per-group detail pages linked in each section heading. Feature-level meaning (why an endpoint exists, the rules it enforces) lives under [`docs/features/`](../../features/); those docs link here rather than restating signatures.

## Auth tiers

Auth is enforced first by `src/middleware.ts` (edge Auth.js), then re-checked inside each handler.

- **public** — reachable without a session. The middleware allowlist (`isPublicRoute`, `src/middleware.ts:4`) is: anything under `/api/auth/*`, anything under `/api/internal/*` (those self-check `CRON_SECRET`), plus the explicit handler-protected routes `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/api/line/contacts/oa-resolver/worklist`, and `POST /api/line/contacts/oa-resolver/runs/{runId}/rows` (matched by the regex at `src/middleware.ts:12`).
- **cron** — `CRON_SECRET` bearer token, constant-time compared. Every `/api/internal/*` route gates on it, via the shared helper `src/lib/internal/cron-auth.ts` (`getCronSecretStatus` / `rejectInvalidCronSecret`, `timingSafeEqual` with a length pre-check) or an inline equivalent in `internal/sync-wise` and `internal/student-promotions/july-1`. The middleware lets these through unauthenticated so cron can reach them; the handler is the real gate.
- **admin** — an authenticated Auth.js session on the `admin_users` allowlist. The middleware redirects sessionless requests to `/login` (or returns `403` for restricted users hitting a page outside their `allowedPages`, `src/middleware.ts:53`); each handler then calls `auth()` and returns `401` if absent. This is the default for everything not listed above. (Progress-Tests read routes additionally admit `teacher`-role sessions with a scoped view, but remain session-gated, not public.)

---

## Home / Ops Hub — [`misc.md`](./misc.md#home--ops-hub)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/home/summary` | Home / Ops Hub | admin | Access-filtered ops-hub landing summary — per-queue action counts + a data-freshness strip (middleware-allowlisted so the nav can always fetch badges, but the handler requires a session and filters per the viewer's `allowedPages`). |

## Search — [`misc.md`](./misc.md#search)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| POST | `/api/search/range` | Search | admin | Range availability search (time window + class duration → sub-slots → availability grid) via `executeRangeSearch`. |
| POST | `/api/search` | Search | admin | Legacy multi-slot availability search via `executeSearch` (explicit slot list). |
| POST | `/api/search/assistant` | Search | public | Natural-language search assistant (public NL entry point). |

## Compare — [`misc.md`](./misc.md#compare)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| POST | `/api/compare` | Compare | admin | Build week-scoped comparison for 1–3 tutors (schedules, conflicts, shared free slots); supports incremental `fetchOnly`. |
| POST | `/api/compare/discover` | Compare | admin | Discover candidate tutors for the compare workspace. |

## Tutors & Filters — [`misc.md`](./misc.md#tutors)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/tutors` | Tutors | admin | Tutor list for the searchable combobox (`getTutorList`). |
| GET | `/api/filters` | Filters | admin | Dropdown facet options (subjects/curricula/levels/modality) via `getFilterOptions`. |

## AI Scheduler — [`ai-scheduler.md`](./ai-scheduler.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/ai-scheduler/conversations` | AI Scheduler | admin | List AI-scheduler conversations. |
| POST | `/api/ai-scheduler/conversations` | AI Scheduler | admin | Create a new AI-scheduler conversation. |
| GET | `/api/ai-scheduler/conversations/[conversationId]` | AI Scheduler | admin | Fetch a single conversation with its messages. |
| PATCH | `/api/ai-scheduler/conversations/[conversationId]` | AI Scheduler | admin | Update conversation metadata (e.g. title/state). |
| DELETE | `/api/ai-scheduler/conversations/[conversationId]` | AI Scheduler | admin | Delete a conversation. |
| POST | `/api/ai-scheduler/conversations/[conversationId]/messages` | AI Scheduler | admin | Post a message turn (parse chat → availability → draft reply). |
| POST | `/api/ai-scheduler/messages/[messageId]/feedback` | AI Scheduler | admin | Record accept/edit/reject feedback on a scheduler message. |
| GET | `/api/ai-scheduler/metrics` | AI Scheduler | admin | Read-only accept/edit/reject metrics (`getAiSchedulerMetrics`). |

## LINE — [`line.md`](./line.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| POST | `/api/line/webhook` | LINE | public | LINE Messaging API webhook ingest (signature-verified in handler). |
| GET | `/api/line/students` | LINE | admin | Search current LINE-linkable students by query (`searchCurrentLineStudents`). |
| GET | `/api/line/scheduler-reviews` | LINE | admin | List LINE scheduler reviews. |
| GET | `/api/line/scheduler-reviews/false-negatives` | LINE | admin | List candidate false-negative (missed) scheduler-review messages. |
| PATCH | `/api/line/scheduler-reviews/[reviewId]` | LINE | admin | Update a scheduler review (triage decision/status). |
| GET | `/api/line/scheduler-reviews/[reviewId]/context` | LINE | admin | Fetch surrounding thread/context for a review. |
| POST | `/api/line/scheduler-reviews/[reviewId]/operational-plan` | LINE | admin | Generate an operational plan for a reviewed request. |
| GET | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | LINE | admin | List Wise-action audit entries for a review. |
| POST | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | LINE | admin | Record/execute a Wise action for a review (dry-run / flag-gated). |
| POST | `/api/line/messages/[messageId]/promote` | LINE | admin | Promote a LINE message into a scheduler review. |
| PATCH | `/api/line/messages/[messageId]/classification-feedback` | LINE | admin | Submit classifier-correction feedback on a message. |
| PATCH | `/api/line/contacts/[contactId]` | LINE | admin | Update a LINE contact record. |
| GET | `/api/line/contacts/[contactId]/student-links` | LINE | admin | List student links for a contact. |
| POST | `/api/line/contacts/[contactId]/student-links` | LINE | admin | Create a student link for a contact. |
| PATCH | `/api/line/contacts/[contactId]/student-links` | LINE | admin | Update a contact's student links. |
| POST | `/api/line/contacts/refresh-profiles` | LINE | admin | Refresh LINE contact display profiles from the OA. |
| POST | `/api/line/contacts/alias-import/preview` | LINE | admin | Preview a contact alias-import (no writes). |
| POST | `/api/line/contacts/alias-import/commit` | LINE | admin | Commit a contact alias-import. |
| GET | `/api/line/contacts/link-validation` | LINE | admin | List contact link-validation worklist items. |
| GET | `/api/line/contacts/link-validation/summary` | LINE | admin | Link-validation summary counts. |
| POST | `/api/line/contacts/link-validation/assign` | LINE | admin | Assign a link-validation item. |
| PATCH | `/api/line/contacts/link-validation/[linkId]` | LINE | admin | Update a single link-validation item. |
| GET | `/api/line/contacts/oa-resolver/worklist` | LINE | public | OA-resolver worklist (public read for the resolver tool). |
| GET | `/api/line/contacts/oa-resolver/runs` | LINE | admin | List OA-resolver runs. |
| POST | `/api/line/contacts/oa-resolver/runs` | LINE | admin | Start a new OA-resolver run. |
| GET | `/api/line/contacts/oa-resolver/runs/[runId]` | LINE | admin | Fetch a single OA-resolver run. |
| POST | `/api/line/contacts/oa-resolver/runs/[runId]/rows` | LINE | public | Append resolved rows to an OA-resolver run (regex-allowlisted public). |
| POST | `/api/line/contacts/oa-resolver/runs/[runId]/commit` | LINE | admin | Commit an OA-resolver run's resolutions. |

## Class Assignments — [`classrooms-and-assignments.md`](./classrooms-and-assignments.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/class-assignments` | Class Assignments | admin | Load class-assignment runs/payload. |
| POST | `/api/class-assignments/run` | Class Assignments | admin | Trigger a new daily room-assignment run. |
| PATCH | `/api/class-assignments/runs/[runId]/rows/[rowId]` | Class Assignments | admin | Override a single assignment row. |
| POST | `/api/class-assignments/runs/[runId]/publish` | Class Assignments | admin | Publish eligible OFFLINE `location` values to Wise. |
| GET | `/api/class-assignments/runs/[runId]/publish/[jobId]` | Class Assignments | admin | Poll a publish job's status. |
| GET | `/api/class-assignments/runs/[runId]/teacher-schedule` | Class Assignments | admin | Teacher schedule view for a run. |
| GET | `/api/class-assignments/runs/[runId]/schedule-email/preview` | Class Assignments | admin | Preview the per-teacher schedule email. |
| POST | `/api/class-assignments/runs/[runId]/schedule-email/send` | Class Assignments | admin | Send the per-teacher schedule emails. |

## Classrooms — [`classrooms-and-assignments.md`](./classrooms-and-assignments.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/classrooms/rooms` | Classrooms | admin | Room catalog. |
| GET | `/api/classrooms/floor-plan-map` | Classrooms | public | Public floor-plan map data. |

## Progress Tests — [`progress-tests.md`](./progress-tests.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/progress-tests` | Progress Tests | admin | Progress-tests payload; teacher sessions get a scoped read-only view, admins see all. |
| POST | `/api/progress-tests/book` | Progress Tests | admin | Book a progress test for an enrollment. |
| POST | `/api/progress-tests/mark-complete` | Progress Tests | admin | Mark a progress test complete. |
| POST | `/api/progress-tests/resend-email` | Progress Tests | admin | Resend the progress-test notification email. |
| POST | `/api/progress-tests/select-at-home` | Progress Tests | admin | Select the at-home progress-test option for an enrollment. |
| POST | `/api/progress-tests/mark-at-home-submitted` | Progress Tests | admin | Mark an at-home progress test as submitted. |

## Student Promotions — [`student-promotions.md`](./student-promotions.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/student-promotions/runs` | Student Promotions | admin | List student-promotion runs. |
| POST | `/api/student-promotions/runs` | Student Promotions | admin | Create a new student-promotion run. |
| GET | `/api/student-promotions/runs/[runId]` | Student Promotions | admin | Fetch a single promotion run. |
| POST | `/api/student-promotions/runs/[runId]/verify` | Student Promotions | admin | Verify a promotion run before applying. |
| POST | `/api/student-promotions/runs/[runId]/apply` | Student Promotions | admin | Apply a verified promotion run (requires confirm token; `maxDuration=800`). |

## Sales Dashboard — [`sales-dashboard.md`](./sales-dashboard.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/sales-dashboard` | Sales Dashboard | admin | GM command-center payload. |
| POST | `/api/sales-dashboard/import` | Sales Dashboard | admin | Import a monthly sales sheet. |
| GET | `/api/sales-dashboard/import-runs` | Sales Dashboard | admin | List sales import runs. |
| GET | `/api/sales-dashboard/sources` | Sales Dashboard | admin | List sales sheet sources. |
| POST | `/api/sales-dashboard/sources` | Sales Dashboard | admin | Create a sales sheet source. |
| POST | `/api/sales-dashboard/sources/seed` | Sales Dashboard | admin | Seed default sales sources. |
| PATCH | `/api/sales-dashboard/sources/[sourceId]` | Sales Dashboard | admin | Update a sales source. |
| DELETE | `/api/sales-dashboard/sources/[sourceId]` | Sales Dashboard | admin | Delete a sales source. |
| POST | `/api/sales-dashboard/projection-source` | Sales Dashboard | admin | Configure the scenario-projection source. |
| POST | `/api/sales-dashboard/projection-import` | Sales Dashboard | admin | Import the active scenario-projection source (Bear/Base/Bull). |

## Credit Control — [`credit-control.md`](./credit-control.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/credit-control` | Credit Control | admin | At-risk follow-up queue payload. |
| POST | `/api/credit-control/sync` | Credit Control | admin | Trigger credit-control sync (recompute depletion). |
| POST | `/api/credit-control/actions` | Credit Control | admin | Record a single follow-up action. |
| POST | `/api/credit-control/actions/bulk` | Credit Control | admin | Record follow-up actions in bulk. |
| GET | `/api/credit-control/actions/history` | Credit Control | admin | Follow-up action history. |
| POST | `/api/credit-control/admin-ownership` | Credit Control | admin | Set/clear admin ownership of a student. |
| POST | `/api/credit-control/inactive` | Credit Control | admin | Flag a student inactive. |
| DELETE | `/api/credit-control/inactive` | Credit Control | admin | Clear a student's inactive flag. |

## Payroll — [`payroll.md`](./payroll.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/payroll` | Payroll | admin | Monthly payroll reconciliation payload. |
| POST | `/api/payroll/sync` | Payroll | admin | Trigger payroll sync for a Bangkok month. |
| PATCH | `/api/payroll/review` | Payroll | admin | Update payroll review state. |
| POST | `/api/payroll/adjustments` | Payroll | admin | Add a manual payroll adjustment. |
| DELETE | `/api/payroll/adjustments/[adjustmentId]` | Payroll | admin | Remove a manual payroll adjustment. |

## Room Capacity — [`room-capacity.md`](./room-capacity.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/room-capacity/utilization` | Room Capacity | admin | Live room-utilization dashboard data. |
| GET | `/api/room-capacity/month` | Room Capacity | admin | Month-pressure view. |
| GET | `/api/room-capacity/forecast` | Room Capacity | admin | Saturation-forecast data (typed missing-table payload when drivers absent). |

## Tutor Profiles — [`misc.md`](./misc.md#tutor-profiles)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/tutor-profiles` | Tutor Profiles | admin | List editorial tutor business profiles. |
| PATCH | `/api/tutor-profiles/[canonicalKey]` | Tutor Profiles | admin | Edit a tutor profile (keyed by stable `canonicalKey`). |
| POST | `/api/tutor-profiles/import-preview` | Tutor Profiles | admin | Preview a bulk profile import (no writes). |
| POST | `/api/tutor-profiles/import-commit` | Tutor Profiles | admin | Commit a bulk profile import. |

## Proposals — [`proposals.md`](./proposals.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| POST | `/api/proposals` | Proposals | admin | Create a proposal bundle (local tentative holds). |
| GET | `/api/proposals/active` | Proposals | admin | List active proposal holds. |
| PATCH | `/api/proposals/items/[itemId]` | Proposals | admin | Update a proposal item's lifecycle state. |

## Wise Activity — [`wise-activity.md`](./wise-activity.md)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/wise-activity` | Wise Activity | admin | List persisted Wise activity events (filters). |
| GET | `/api/wise-activity/summary` | Wise Activity | admin | Activity KPI summary. |
| POST | `/api/wise-activity/sync` | Wise Activity | admin | Manual Wise-activity event sync (`maxDuration=800`). |
| GET | `/api/wise-activity/reconciliation` | Wise Activity | admin | Package-sales reconciliation readout. |
| POST | `/api/wise-activity/reconciliation/backfill` | Wise Activity | admin | Backfill Wise-activity events for reconciliation (`maxDuration=800`). |

## Leave Requests — [`misc.md`](./misc.md#leave-requests)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/leave-requests` | Leave Requests | admin | List tutor leave-request worklist. |
| POST | `/api/leave-requests/sync` | Leave Requests | admin | Manual sync of leave-form rows from the Google Sheet. |
| GET | `/api/leave-requests/[requestId]` | Leave Requests | admin | Fetch a single leave request with affected sessions. |
| PATCH | `/api/leave-requests/[requestId]` | Leave Requests | admin | Update a leave request (triage + sheet-status writeback). |
| POST | `/api/leave-requests/[requestId]/wise-cancel-preview` | Leave Requests | admin | Dry-run preview of Wise session cancellations for a leave. |

## Data Health — [`misc.md`](./misc.md#data-health)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/data-health` | Data Health | admin | Sync status + normalization-issue counts. |
| POST | `/api/data-health/jobs/[jobKey]/run` | Data Health | admin | Manually trigger a registered cron job (dangerous jobs require `confirmed:true`). |

## Auth

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/auth/[...nextauth]` | Auth | public | Auth.js catch-all (sign-in/out, callbacks, session). |
| POST | `/api/auth/[...nextauth]` | Auth | public | Auth.js catch-all (sign-in/out, callbacks, session). |

## Admin — [`misc.md`](./misc.md#admin)

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| POST | `/api/admin/sync-wise` | Admin | admin | Admin-session trigger for a Wise snapshot sync. |

## Internal / Cron — [`internal-crons.md`](./internal-crons.md)

All routes self-check `CRON_SECRET`; the middleware lets them through unauthenticated so cron can reach the handler. Sync routes typically expose both `GET` (Vercel cron) and `POST` (manual curl) with identical behavior.

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| GET | `/api/internal/sync-wise` | Internal | cron | Wise snapshot sync (cron trigger; `maxDuration=800`). |
| POST | `/api/internal/sync-wise` | Internal | cron | Wise snapshot sync (manual trigger). |
| GET | `/api/internal/sync-wise-activity` | Internal | cron | Wise-activity audit event sync. |
| GET | `/api/internal/sync-sales-dashboard` | Internal | cron | Sales-dashboard sync (cron). |
| POST | `/api/internal/sync-sales-dashboard` | Internal | cron | Sales-dashboard sync (manual). |
| GET | `/api/internal/sync-credit-control` | Internal | cron | Credit-control sync (cron). |
| POST | `/api/internal/sync-credit-control` | Internal | cron | Credit-control sync (manual). |
| GET | `/api/internal/sync-leave-requests` | Internal | cron | Leave-requests sync (cron). |
| POST | `/api/internal/sync-leave-requests` | Internal | cron | Leave-requests sync (manual). |
| GET | `/api/internal/sync-progress-tests` | Internal | cron | Progress-tests sync (cron; `maxDuration=300`). |
| POST | `/api/internal/sync-progress-tests` | Internal | cron | Progress-tests sync (manual). |
| POST | `/api/internal/sync-room-utilization` | Internal | cron | Room-utilization sync. |
| GET | `/api/internal/progress-tests/admin-digest` | Internal | cron | Send the progress-tests admin digest email (`maxDuration=300`). |
| GET | `/api/internal/class-assignments/morning` | Internal | cron | Morning class-assignment automation run (`maxDuration=800`). |
| GET | `/api/internal/class-assignments/admin-email` | Internal | cron | Send the daily class-assignment admin email (`maxDuration=300`). |
| GET | `/api/internal/student-promotions/july-1` | Internal | cron | July-1 student-promotion automation (cron; `maxDuration=800`). |
| POST | `/api/internal/student-promotions/july-1` | Internal | cron | July-1 student-promotion automation (manual). |

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
