# API Reference — Master Index

The canonical lookup of every HTTP endpoint in BGScheduler. This page carries **method + path + group + auth + a one-line purpose** and nothing else. Request and response bodies, query parameters, status codes, and error shapes live on the per-group detail pages linked from the Group column.

> **Canonical-home rule:** `docs/reference/*` owns mechanical detail; `docs/features/*` owns meaning — purpose, rules, and flows. This index is the mechanical inventory. It does not restate business rules, and feature docs link here rather than reproduce endpoint signatures.

## What this counts

All handlers live under `src/app/api/**/route.ts`. At `main@0cd1e81` the tree holds **180 `route.ts` files exporting 243 method+path business endpoints**.

Two counting notes, because a naive `grep -c 'export async function'` disagrees:

- **+2 for Auth.js.** [`src/app/api/auth/[...nextauth]/route.ts`](../../../src/app/api/auth/%5B...nextauth%5D/route.ts) is three lines long and exports its two methods by destructuring — `export const { GET, POST } = handlers` — so it matches no `export function` pattern.
- **−2 for CORS preflight.** The `OPTIONS` handlers on the two public OA-resolver routes ([`worklist/route.ts:17`](../../../src/app/api/line/contacts/oa-resolver/worklist/route.ts) and [`runs/[runId]/rows/route.ts:48`](../../../src/app/api/line/contacts/oa-resolver/runs/%5BrunId%5D/rows/route.ts)) return bare CORS headers and carry no business surface, so they are **excluded** from the 243. Counting the `line` group therefore yields 29, not 31.

The named-handler total across all 180 files is 241; 241 + 2 destructured = 243 business endpoints, and 243 + 2 preflight = 245 exported handlers in total.

## How to read the Auth column

Every tier below is verified against [`src/middleware.ts`](../../../src/middleware.ts) plus the handler itself. The middleware is the outer gate; the handler is the one that actually decides.

| Token | Meaning |
|---|---|
| `public` | Reachable without an Auth.js session. The allowlist is exactly `isPublicRoute` ([`middleware.ts:10-26`](../../../src/middleware.ts)): `/login`, `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/schedule/*`, `/api/line/contacts/oa-resolver/worklist`, `/api/line/contacts/oa-resolver/runs/{runId}/rows`, and all of `/api/internal/*`. Every public route that touches data enforces its own in-handler check — a LINE channel signature, or an opaque `Bearer` resolver token. |
| `admin` | Authenticated Auth.js session. Unauthenticated page requests are redirected to `/login` ([`middleware.ts:92`](../../../src/middleware.ts)); an API path outside a restricted user's `allowedPages` gets `403 {"error":"Forbidden"}` ([`middleware.ts:96-99`](../../../src/middleware.ts)). The handler then calls `auth()` — or a domain guard such as `requireCreditControlSession` ([`credit-control/api.ts:5`](../../../src/lib/credit-control/api.ts)), `requireProgressTestsSession` ([`progress-tests/api.ts:35`](../../../src/lib/progress-tests/api.ts)), `requireCompetitorIntelligenceSession` ([`competitor-intelligence/access.ts:19`](../../../src/lib/competitor-intelligence/access.ts)), or `requireStudentPromotionSession` ([`student-promotions/api.ts:9`](../../../src/lib/student-promotions/api.ts)) — and returns `401` with no session. |
| `admin (admin session)` | Progress Tests only. `requireProgressTestsAdminSession` ([`progress-tests/api.ts:66`](../../../src/lib/progress-tests/api.ts)) rejects the teacher-scoped sessions that `GET /api/progress-tests` accepts, so every write on that surface is admin-only. |
| ``admin + cap:`X` `` | Admin session **plus** a fresh Postgres capability grant, re-read on every request and never cached in the JWT (`requirePostClassCapability`, [`post-class-feedback/access.ts:153`](../../../src/lib/post-class-feedback/access.ts)). Post-Class Feedback only. The four capabilities are `viewer`, `reviewer`, `finance`, and `access_manager` ([`access.ts:12-15`](../../../src/lib/post-class-feedback/access.ts)); the payout write capability is checked separately inside `payout-runs`. Middleware deliberately passes `/api/post-class-feedback/**` through `isPathAllowed` so these fresh grants — not stale JWT page prefixes — decide ([`middleware.ts:40-46`](../../../src/middleware.ts)). |
| `session (role: X)` | **University Admissions only** — the one route family that is not admin-only. `requireAdmissionsSession` establishes the session ([`admissions/access.ts:76`](../../../src/lib/admissions/access.ts)); per-case rights are then re-resolved from Postgres by `requireCaseAccess` ([`access.ts:117`](../../../src/lib/admissions/access.ts)), `requireCounselorOrAdmin` ([`access.ts:196`](../../../src/lib/admissions/access.ts)), or `requireAdmissionsAdmin` ([`access.ts:234`](../../../src/lib/admissions/access.ts)) under the ordering `parent < student < counselor < admin` (`roleAtLeast`, [`admissions/config.ts:28`](../../../src/lib/admissions/config.ts)). The column shows the **minimum** role the handler passes to its guard. |
| `cron` | `CRON_SECRET`-protected. [`middleware.ts:24`](../../../src/middleware.ts) exempts `/api/internal/*` from the session gate; the handler then runs a length-prechecked `timingSafeEqual` against `Bearer ${CRON_SECRET}` — `rejectInvalidCronSecret` / `getCronSecretStatus` ([`internal/cron-auth.ts:6-26`](../../../src/lib/internal/cron-auth.ts)), or an inline copy of the same comparison in `student-promotions/july-1` and `sync-room-utilization`. A missing `CRON_SECRET` returns `500`; a wrong one `401`. |
| `cron \| admin` | The same secret check with a session fallback, used for manual reruns of the sync pipelines. On every one of these routes the paired `GET` stays cron-only. |

### Three places where middleware and handler disagree

Each disagreement resolves in the safe direction — the handler is stricter, never looser.

- **`POST /api/search/assistant`** sits on the middleware public allowlist, but the handler still calls `auth()` and returns `401` without a session. Listed as `admin`.
- **`GET /api/classrooms/floor-plan-map`** is public **and** has no in-handler check at all ([`floor-plan-map/route.ts:1-16`](../../../src/app/api/classrooms/floor-plan-map/route.ts)). It is a pure renderer: it takes a `rooms` query param, returns `image/svg+xml`, and reads neither database nor session. That is precisely why exposing it is safe.
- **`POST /api/data-health/jobs/[jobKey]/run`** is an `admin` route that additionally demands the `access_manager` capability for any job key starting `post_class_feedback` (`403`), and `confirmed: true` for any job marked `dangerous` (`409` with a `confirmationLabel`) ([`run/route.ts:26-42`](../../../src/app/api/data-health/jobs/%5BjobKey%5D/run/route.ts)).

## Group directory

29 path prefixes, 243 endpoints. Every link below resolves to a page that documents that prefix.

| Group | Path prefix | Endpoints | Detail page |
|---|---|---:|---|
| admin | `/api/admin` | 1 | [misc.md](./misc.md#admin) |
| admissions | `/api/admissions` | 61 | [university-admissions.md](./university-admissions.md) |
| ai-scheduler | `/api/ai-scheduler` | 8 | [ai-scheduler.md](./ai-scheduler.md) |
| auth | `/api/auth` | 2 | [misc.md](./misc.md#auth) |
| class-assignments | `/api/class-assignments` | 8 | [classrooms-and-assignments.md](./classrooms-and-assignments.md) |
| classrooms | `/api/classrooms` | 2 | [classrooms-and-assignments.md](./classrooms-and-assignments.md#room-catalog-and-floor-plan) |
| compare | `/api/compare` | 2 | [misc.md](./misc.md#compare) |
| competitor-intelligence | `/api/competitor-intelligence` | 9 | [competitor-intelligence.md](./competitor-intelligence.md) |
| credit-control | `/api/credit-control` | 8 | [credit-control.md](./credit-control.md) |
| data-health | `/api/data-health` | 2 | [data-health.md](./data-health.md) |
| filters | `/api/filters` | 1 | [misc.md](./misc.md#tutors-and-filters) |
| home | `/api/home` | 1 | [misc.md](./misc.md#home-summary) |
| internal | `/api/internal` | 31 | [internal-crons.md](./internal-crons.md) (25) + six on their owning pages — see below |
| leave-requests | `/api/leave-requests` | 5 | [leave-requests.md](./leave-requests.md) |
| line | `/api/line` | 29 | [line.md](./line.md) |
| payroll | `/api/payroll` | 5 | [payroll.md](./payroll.md) |
| post-class-feedback | `/api/post-class-feedback` | 13 | [post-class-feedback.md](./post-class-feedback.md) |
| progress-tests | `/api/progress-tests` | 6 | [progress-tests.md](./progress-tests.md) |
| proposals | `/api/proposals` | 3 | [proposals.md](./proposals.md) |
| room-capacity | `/api/room-capacity` | 3 | [room-capacity.md](./room-capacity.md) |
| sales-dashboard | `/api/sales-dashboard` | 13 | [sales-dashboard.md](./sales-dashboard.md) |
| search | `/api/search` | 3 | [misc.md](./misc.md#search) |
| student-promotions | `/api/student-promotions` | 9 | [student-promotions.md](./student-promotions.md) |
| student-report | `/api/student-report` | 1 | [student-schedule-and-report.md](./student-schedule-and-report.md#parent-class-report) |
| student-schedule | `/api/student-schedule` | 2 | [student-schedule-and-report.md](./student-schedule-and-report.md#student-monthly-schedule) |
| tutor-profiles | `/api/tutor-profiles` | 4 | [tutor-profiles.md](./tutor-profiles.md) |
| tutors | `/api/tutors` | 1 | [misc.md](./misc.md#tutors-and-filters) |
| us-universities | `/api/us-universities` | 5 | [us-universities.md](./us-universities.md) |
| wise-activity | `/api/wise-activity` | 5 | [wise-activity.md](./wise-activity.md) |
| **Total** | | **243** | |

### The same 243, counted by detail page

`docs/reference/api/` holds **22 files: this index plus 21 detail pages.** Every one of the 21 appears below, and the column sums to 243 — no endpoint is documented nowhere, and none is counted twice.

| Detail page | Prefixes it owns | Endpoints |
|---|---|---:|
| [ai-scheduler.md](./ai-scheduler.md) | `/api/ai-scheduler` | 8 |
| [classrooms-and-assignments.md](./classrooms-and-assignments.md) | `/api/class-assignments`, `/api/classrooms`, 2 internal crons | 10 |
| [competitor-intelligence.md](./competitor-intelligence.md) | `/api/competitor-intelligence` | 9 |
| [credit-control.md](./credit-control.md) | `/api/credit-control` | 8 |
| [data-health.md](./data-health.md) | `/api/data-health` | 2 |
| [internal-crons.md](./internal-crons.md) | `/api/internal` (25 of 31) | 25 |
| [leave-requests.md](./leave-requests.md) | `/api/leave-requests` | 5 |
| [line.md](./line.md) | `/api/line` | 29 |
| [misc.md](./misc.md) | `/api/search`, `/api/compare`, `/api/tutors`, `/api/filters`, `/api/home`, `/api/admin`, `/api/auth` | 11 |
| [payroll.md](./payroll.md) | `/api/payroll` | 5 |
| [post-class-feedback.md](./post-class-feedback.md) | `/api/post-class-feedback` | 13 |
| [progress-tests.md](./progress-tests.md) | `/api/progress-tests` | 6 |
| [proposals.md](./proposals.md) | `/api/proposals` | 3 |
| [room-capacity.md](./room-capacity.md) | `/api/room-capacity`, 1 internal cron | 3 |
| [sales-dashboard.md](./sales-dashboard.md) | `/api/sales-dashboard`, 2 internal crons | 13 |
| [student-promotions.md](./student-promotions.md) | `/api/student-promotions` | 9 |
| [student-schedule-and-report.md](./student-schedule-and-report.md) | `/api/student-schedule`, `/api/student-report` | 3 |
| [tutor-profiles.md](./tutor-profiles.md) | `/api/tutor-profiles` | 4 |
| [university-admissions.md](./university-admissions.md) | `/api/admissions` | 61 |
| [us-universities.md](./us-universities.md) | `/api/us-universities` | 5 |
| [wise-activity.md](./wise-activity.md) | `/api/wise-activity`, 1 internal cron | 5 |
| **Total** | | **243** |

Three notes on how the two tables reconcile:

- **The `internal` prefix is split across five pages.** [internal-crons.md](./internal-crons.md) indexes 25 of the 31 `/api/internal` endpoints. The other six are documented alongside the subsystem they drive: `sync-sales-dashboard` GET+POST in [sales-dashboard.md](./sales-dashboard.md#cron-sync), `sync-wise-activity` in [wise-activity.md](./wise-activity.md), `sync-room-utilization` in [room-capacity.md](./room-capacity.md), and the two `class-assignments/*` jobs in [classrooms-and-assignments.md](./classrooms-and-assignments.md#internal-cron-endpoints). The per-endpoint table below links each of the six to its owning page, so the Group column is always the page that actually documents that row.
- **Counted-by-page rows attribute each internal cron once**, to the page carrying its signature. A cron may still be *discussed* on a second page — `cron-watchdog` appears in both [internal-crons.md](./internal-crons.md) and [data-health.md](./data-health.md), and the six post-class and admissions crons are discussed in their feature references — but it is counted only where it is indexed.
- **A detail page's own `Endpoint index (N)` heading may exceed its row here**, because several pages index the internal crons they discuss on top of their own prefix. [post-class-feedback.md](./post-class-feedback.md) says 19 (13 workspace + 6 crons) and [university-admissions.md](./university-admissions.md) says 63 (61 + 2 cron halves); this index counts only the 13 and the 61.

`misc.md` is a real detail page, not a placeholder: it carries the per-endpoint signatures for search, compare, tutors/filters, home, admin, and auth, each under its own heading, and opens with a **Where the other families moved** table pointing at the ten families that were split out into their own pages.

## Crons

The 31 `internal` endpoints sit on **22 distinct paths**, one per route file. `vercel.json` schedules **17** of them; the in-app registry [`cron-registry.ts`](../../../src/lib/data-health/cron-registry.ts) declares all 22, marking the remaining five `manualOnly: true` — reachable with the cron secret, but nothing fires them on a schedule:

`line-backlog-recovery` · `post-class-feedback/admin-digest` · `post-class-feedback/reminder-day-after` · `post-class-feedback/reminder-deadline` · `sync-room-utilization`

The schedule table, the sub-hourly stagger rationale, and per-job `maxDuration` live in [`../crons.md`](../crons.md).

## Every endpoint

Sorted by group, then path, then method. `[bracketed]` segments are Next.js dynamic params. The Group column links to the page carrying that endpoint's request/response signature.

| Method | Path | Group | Auth | Purpose |
|---|---|---|---|---|
| `POST` | `/api/admin/sync-wise` | [admin](./misc.md#admin) | admin | Admin-session trigger for the same `runWiseSyncRequest` the `/api/internal/sync-wise` cron runs; wrapped in a `cron_invocations` audit row with `triggerSource: "admin"`. |
| `GET` | `/api/admissions/announcements` | [admissions](./university-admissions.md) | session (role: student) / counselor | Announcement feed. Case-scoped read runs at `student`; a cohort-scoped read is staff-only (`requireCounselorOrAdmin`). Exactly one of `caseId`/`cohortId` — both or neither is a 400 before any access check. |
| `POST` | `/api/admissions/announcements` | [admissions](./university-admissions.md) | session (role: counselor) | Post an announcement to one case or one cohort. Case-scoped writes need `counselor` on that case; cohort broadcasts need `requireCounselorOrAdmin`. |
| `PATCH` | `/api/admissions/announcements` | [admissions](./university-admissions.md) | session (role: counselor) | Edit an announcement. Staff gate runs before body parsing, then rights re-anchor on the **stored** row's scope, never client-supplied ids. |
| `DELETE` | `/api/admissions/announcements` | [admissions](./university-admissions.md) | session (role: counselor) | Soft-delete one announcement by `?announcementId=`; the row is retained for the audit trail. |
| `GET` | `/api/admissions/audit/[caseId]` | [admissions](./university-admissions.md) | session (role: admin) | Append-only audit log for one case with field-level diffs. The only admissions read pinned at `admin`. |
| `GET` | `/api/admissions/cases` | [admissions](./university-admissions.md) | session (role: counselor) | Caseload list, scoped per user (admin sees all cases, a counselor only their active memberships). Students and parents 403 — they are case members, never caseload viewers. |
| `POST` | `/api/admissions/cases` | [admissions](./university-admissions.md) | session (role: counselor) | Create a case (student membership is created with it). |
| `GET` | `/api/admissions/cases/[caseId]` | [admissions](./university-admissions.md) | session (role: parent) | Case detail. Role-shaped: a `parent` reader is redirected to the parent projection surface rather than served the staff/student DTO. |
| `PATCH` | `/api/admissions/cases/[caseId]` | [admissions](./university-admissions.md) | session (role: counselor) | Update lifecycle/profile fields; accepts `expectedUpdatedAt` for optimistic concurrency (mismatch → 409 carrying both versions). |
| `GET` | `/api/admissions/cases/[caseId]/activities` | [admissions](./university-admissions.md) | session (role: student) | List live activity rows, ranked first. |
| `POST` | `/api/admissions/cases/[caseId]/activities` | [admissions](./university-admissions.md) | session (role: student) | Add an activity row; the live-row cap returns 409 from the lib. |
| `PATCH` | `/api/admissions/cases/[caseId]/activities` | [admissions](./university-admissions.md) | session (role: student) | Action union — `update` edits one activity (optional `expectedUpdatedAt`), `rank` persists the Common App top-10 order (≤10 unique live ids). |
| `DELETE` | `/api/admissions/cases/[caseId]/activities` | [admissions](./university-admissions.md) | session (role: student) | Soft-delete one activity by `?activityId=` — students may delete their own list rows. |
| `GET` | `/api/admissions/cases/[caseId]/calendar` | [admissions](./university-admissions.md) | session (role: student) | Dated case items for an inclusive `YYYY-MM-DD` window plus the open upcoming-deadlines panel. Both bounds required and `from <= to`, else 400 — never a guessed window. |
| `GET` | `/api/admissions/cases/[caseId]/colleges` | [admissions](./university-admissions.md) | session (role: student) | College list rows with live IPEDS stats, a stale flag, and the completeness rollup. |
| `POST` | `/api/admissions/cases/[caseId]/colleges` | [admissions](./university-admissions.md) | session (role: counselor) | Add a college — union of an IPEDS `unitId` or a manual free-text row; a duplicate on the case is 409. |
| `PATCH` | `/api/admissions/cases/[caseId]/colleges` | [admissions](./university-admissions.md) | session (role: counselor) | Partially update plan fields (round, deadline, app status, category, aid) with optional `expectedUpdatedAt`. |
| `DELETE` | `/api/admissions/cases/[caseId]/colleges` | [admissions](./university-admissions.md) | session (role: counselor) | Soft-delete a list row by `?itemId=`; the case's committed pointer is cleared in the same transaction when it referenced that item. |
| `GET` | `/api/admissions/cases/[caseId]/colleges/[itemId]/events` | [admissions](./university-admissions.md) | session (role: student) | One list item's append-only decision chain, oldest first; the item is scoped to the case first, so a foreign `itemId` reads as 404. |
| `POST` | `/api/admissions/cases/[caseId]/colleges/[itemId]/events` | [admissions](./university-admissions.md) | session (role: counselor) | Append one dated decision event. A `committed` event routes through `setCommittedCollege` — pointer move + event append in one transaction — and returns `{ committed }`; a second commit while another item holds the pointer is 409. |
| `GET` | `/api/admissions/cases/[caseId]/essays` | [admissions](./university-admissions.md) | session (role: student) | Essay rows with staleness and effective stage, most urgent first. |
| `POST` | `/api/admissions/cases/[caseId]/essays` | [admissions](./university-admissions.md) | session (role: student) | Add an essay row (self-report surface); staff creations pass through and are attributed by audit `actorRole`. |
| `PATCH` | `/api/admissions/cases/[caseId]/essays` | [admissions](./university-admissions.md) | session (role: student) | Partial update with a per-field write split: prompt/status/driveUrl are student-writable; `counselorStage`/`deadline`/`listItemId` require `counselor`. |
| `DELETE` | `/api/admissions/cases/[caseId]/essays` | [admissions](./university-admissions.md) | session (role: counselor) | Soft-delete an essay row by `?essayId=` — deleting tracker rows is staff work, not self-report. |
| `GET` | `/api/admissions/cases/[caseId]/meetings` | [admissions](./university-admissions.md) | session (role: counselor) | Meeting log. Pinned at `counselor` for **every** method, GET included: meeting notes carry candid observations that must never reach the student or parent surfaces. |
| `POST` | `/api/admissions/cases/[caseId]/meetings` | [admissions](./university-admissions.md) | session (role: counselor) | Log a meeting plus its action-item tasks. |
| `PATCH` | `/api/admissions/cases/[caseId]/meetings` | [admissions](./university-admissions.md) | session (role: counselor) | Edit one logged meeting. |
| `GET` | `/api/admissions/cases/[caseId]/members` | [admissions](./university-admissions.md) | session (role: counselor) | List case memberships. Membership editing is counselor-only on every method. |
| `POST` | `/api/admissions/cases/[caseId]/members` | [admissions](./university-admissions.md) | session (role: counselor) | Add a `parent` or `counselor` membership. The student-as-parent `adminOverride` escape hatch is honored only for admin sessions. |
| `PATCH` | `/api/admissions/cases/[caseId]/members` | [admissions](./university-admissions.md) | session (role: counselor) | Revoke, re-invite, or change the email on one membership. |
| `GET` | `/api/admissions/cases/[caseId]/notes` | [admissions](./university-admissions.md) | session (role: student) | Case notes shaped for the reader's per-case role — `listNotesForRole` strips staff-only notes for non-staff readers. |
| `POST` | `/api/admissions/cases/[caseId]/notes` | [admissions](./university-admissions.md) | session (role: counselor) | Create a note with an **explicit** visibility; the field is required with no default, matching the NOT-NULL-no-default column. |
| `PATCH` | `/api/admissions/cases/[caseId]/notes` | [admissions](./university-admissions.md) | session (role: counselor) | Change one note's visibility. |
| `GET` | `/api/admissions/cases/[caseId]/parent-dashboard` | [admissions](./university-admissions.md) | session (role: parent) | The closed parent projection and nothing else — the body is `buildParentDashboard`'s DTO, the only builder of parent-facing payloads, so a staff field cannot leak without editing `parent-projection.ts`. |
| `GET` | `/api/admissions/cases/[caseId]/recommenders` | [admissions](./university-admissions.md) | session (role: student) | Live recommenders with per-college submission links, plus the case's college-doc rows. |
| `POST` | `/api/admissions/cases/[caseId]/recommenders` | [admissions](./university-admissions.md) | session (role: counselor) | Create a recommender. |
| `PATCH` | `/api/admissions/cases/[caseId]/recommenders` | [admissions](./university-admissions.md) | session (role: counselor) | Action multiplexer — `update` (forward-only ask-status machine; illegal move → 409), `link`, `submission`, `college_doc`. Body ids are pinned to the URL's `caseId` first, so a foreign id reads 404 rather than writing into another case. |
| `DELETE` | `/api/admissions/cases/[caseId]/recommenders` | [admissions](./university-admissions.md) | session (role: counselor) | Soft-delete a recommender by `?recommenderId=`. |
| `GET` | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | [admissions](./university-admissions.md) | session (role: student) | One guided self-report section: definition, saved answers, review state. An unknown `sectionKey` is 404 only **after** the membership check, so keys never leak to non-members. |
| `POST` | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | [admissions](./university-admissions.md) | session (role: student) | State-machine action union — `submit` (draft → submitted, the only notify event) at the student bar; `review` (submitted → reviewed) requires `counselor`, enforced here and again inside `reviewSection`. |
| `PUT` | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | [admissions](./university-admissions.md) | session (role: student) | Autosave a **partial** section payload into the draft; merge semantics live in `saveSectionDraft`. |
| `GET` | `/api/admissions/cases/[caseId]/tasks` | [admissions](./university-admissions.md) | session (role: student) | Checklist tasks plus phase progress. |
| `POST` | `/api/admissions/cases/[caseId]/tasks` | [admissions](./university-admissions.md) | session (role: counselor) | Create a counselor custom task. |
| `PATCH` | `/api/admissions/cases/[caseId]/tasks` | [admissions](./university-admissions.md) | session (role: student) | Action multiplexer — `status` is gated at `student` (the lib enforces the student-owned-task rule); `verify`/`update`/`delete` are counselor-only inside the lib. |
| `DELETE` | `/api/admissions/cases/[caseId]/tasks` | [admissions](./university-admissions.md) | session (role: counselor) | Soft-delete a **custom** task by `?taskId=`; template-derived tasks are rejected 409 on both delete paths. |
| `GET` | `/api/admissions/cases/[caseId]/testing` | [admissions](./university-admissions.md) | session (role: student) | Test sittings plus best scores. |
| `POST` | `/api/admissions/cases/[caseId]/testing` | [admissions](./university-admissions.md) | session (role: student) | Add a test sitting (student self-report surface). |
| `PATCH` | `/api/admissions/cases/[caseId]/testing` | [admissions](./university-admissions.md) | session (role: student) | Update one sitting. `scoreReleasedToParent` is counselor-only, enforced per-field here and again fail-closed inside `updateSitting`. |
| `DELETE` | `/api/admissions/cases/[caseId]/testing` | [admissions](./university-admissions.md) | session (role: student) | Remove one test sitting. |
| `GET` | `/api/admissions/cohorts` | [admissions](./university-admissions.md) | session (role: counselor) | List cohorts. |
| `POST` | `/api/admissions/cohorts` | [admissions](./university-admissions.md) | session (role: admin) | Create a cohort (`requireAdmissionsAdmin`). |
| `GET` | `/api/admissions/cohorts/[cohortId]/templates` | [admissions](./university-admissions.md) | session (role: counselor) | Latest checklist-template version with its items, plus the full version history. |
| `POST` | `/api/admissions/cohorts/[cohortId]/templates` | [admissions](./university-admissions.md) | session (role: admin) | Admin action union — `create_version` adds version max+1 (immutability by versioning); `push_new_items` appends the latest published template's missing items to every live case in the cohort. |
| `PATCH` | `/api/admissions/cohorts/[cohortId]/templates` | [admissions](./university-admissions.md) | session (role: admin) | Publish a draft template version. Publishing twice is 409; a `templateId` outside this cohort is 404 — no cross-cohort publishing through the wrong URL. |
| `GET` | `/api/admissions/counselors` | [admissions](./university-admissions.md) | session (role: admin) | Counselor registry listing. Admin rights are re-resolved from Postgres on every request, so a removed admin loses the surface instantly rather than at JWT expiry. |
| `POST` | `/api/admissions/counselors` | [admissions](./university-admissions.md) | session (role: admin) | Create or upsert a registry counselor. |
| `PATCH` | `/api/admissions/counselors` | [admissions](./university-admissions.md) | session (role: admin) | Full update (name + explicit `active`) or a pure deactivation (`{ email, active: false }`); the flag is never guessed. |
| `GET` | `/api/admissions/resources` | [admissions](./university-admissions.md) | session (any admissions role) | Global resource library. `requireAdmissionsSession` only — deliberately readable by every admissions role; there is no per-case scope to anchor `requireCaseAccess`. |
| `POST` | `/api/admissions/resources` | [admissions](./university-admissions.md) | session (role: counselor) | Add a library resource (`requireCounselorOrAdmin` before body parsing). |
| `PATCH` | `/api/admissions/resources` | [admissions](./university-admissions.md) | session (role: counselor) | Edit a library resource. |
| `DELETE` | `/api/admissions/resources` | [admissions](./university-admissions.md) | session (role: counselor) | Soft-delete a resource by `?resourceId=`; the row is retained for the audit trail. |
| `GET` | `/api/ai-scheduler/conversations` | [ai-scheduler](./ai-scheduler.md) | admin | List scheduler conversations with per-admin facets. |
| `POST` | `/api/ai-scheduler/conversations` | [ai-scheduler](./ai-scheduler.md) | admin | Create an empty conversation. |
| `GET` | `/api/ai-scheduler/conversations/[conversationId]` | [ai-scheduler](./ai-scheduler.md) | admin | One conversation with its full message history. |
| `PATCH` | `/api/ai-scheduler/conversations/[conversationId]` | [ai-scheduler](./ai-scheduler.md) | admin | Patch conversation metadata (title, status). |
| `DELETE` | `/api/ai-scheduler/conversations/[conversationId]` | [ai-scheduler](./ai-scheduler.md) | admin | Soft-delete a conversation — implemented as a `patchSchedulerConversation` state change, not a row delete. |
| `POST` | `/api/ai-scheduler/conversations/[conversationId]/messages` | [ai-scheduler](./ai-scheduler.md) | admin | Run one scheduler turn: redact input, call the model, prove availability deterministically via the solver, persist the message, and log an `ai_scheduler_runs` row with prompt/solver versions. |
| `POST` | `/api/ai-scheduler/messages/[messageId]/feedback` | [ai-scheduler](./ai-scheduler.md) | admin | Record accept/edit/reject feedback on one assistant message. |
| `GET` | `/api/ai-scheduler/metrics` | [ai-scheduler](./ai-scheduler.md) | admin | Read-only roll-up joining scheduler metrics, correction telemetry, and the LINE scheduler analytics. |
| `GET` | `/api/auth/[...nextauth]` | [auth](./misc.md#auth) | public | Auth.js catch-all (sign-in, callback, session, CSRF). Exported by destructuring `export const { GET, POST } = handlers`, so it matches no `export function` grep — this is the `+2` in the count. |
| `POST` | `/api/auth/[...nextauth]` | [auth](./misc.md#auth) | public | Auth.js catch-all POST half (sign-in/sign-out callbacks). Same destructured export. |
| `GET` | `/api/class-assignments` | [class-assignments](./classrooms-and-assignments.md) | admin | The assignment detail envelope for one ISO date (`assertIsoDate` rejects anything else). |
| `POST` | `/api/class-assignments/run` | [class-assignments](./classrooms-and-assignments.md) | admin | Generate a room-assignment run for a date. Local generation only — nothing is written to Wise here. |
| `POST` | `/api/class-assignments/runs/[runId]/publish` | [class-assignments](./classrooms-and-assignments.md) | admin | Create a publish job and schedule it; only eligible OFFLINE sessions have their Wise `location` written, after explicit admin confirmation. |
| `GET` | `/api/class-assignments/runs/[runId]/publish/[jobId]` | [class-assignments](./classrooms-and-assignments.md) | admin | Poll one publish job's progress. |
| `PATCH` | `/api/class-assignments/runs/[runId]/rows/[rowId]` | [class-assignments](./classrooms-and-assignments.md) | admin | Manually override one assignment row's room. |
| `GET` | `/api/class-assignments/runs/[runId]/schedule-email/preview` | [class-assignments](./classrooms-and-assignments.md) | admin | Render the per-teacher schedule email without sending it. |
| `POST` | `/api/class-assignments/runs/[runId]/schedule-email/send` | [class-assignments](./classrooms-and-assignments.md) | admin | Send the teacher schedule emails for a run, recording recipients. |
| `GET` | `/api/class-assignments/runs/[runId]/teacher-schedule` | [class-assignments](./classrooms-and-assignments.md) | admin | One run's schedule grouped by teacher. |
| `GET` | `/api/classrooms/floor-plan-map` | [classrooms](./classrooms-and-assignments.md#room-catalog-and-floor-plan) | public | Pure SVG renderer: takes a `rooms` query param, returns `image/svg+xml`. Public **and** with no in-handler check — it reads no database and no session, which is why exposing it is safe. |
| `GET` | `/api/classrooms/rooms` | [classrooms](./classrooms-and-assignments.md#room-catalog-and-floor-plan) | admin | The room catalog (capacity, TV, online-only flags). |
| `POST` | `/api/compare` | [compare](./misc.md#compare) | admin | Week-scoped compare payload: per-tutor schedules with weekday fallback, same-student conflicts, and shared free slots. Supports the incremental `fetchOnly` serialization the client cache uses. |
| `POST` | `/api/compare/discover` | [compare](./misc.md#compare) | admin | Discovery pass over the in-memory index — candidate tutors for a slot with conflicts already detected. |
| `GET` | `/api/competitor-intelligence` | [competitor-intelligence](./competitor-intelligence.md) | admin | The full BI payload: daily brief, evidence items, SEO visibility, offers, War Room snapshot, response tasks. |
| `POST` | `/api/competitor-intelligence/manual-evidence` | [competitor-intelligence](./competitor-intelligence.md) | admin | Record one hand-entered evidence item, scored through the same normalization path as collected signals. |
| `GET` | `/api/competitor-intelligence/own-sources` | [competitor-intelligence](./competitor-intelligence.md) | admin | List the own-brand sources tracked alongside competitors. |
| `POST` | `/api/competitor-intelligence/own-sources` | [competitor-intelligence](./competitor-intelligence.md) | admin | Create or update an own-brand source. |
| `PATCH` | `/api/competitor-intelligence/own-sources/[sourceId]` | [competitor-intelligence](./competitor-intelligence.md) | admin | Update or disable one own-brand source. |
| `PATCH` | `/api/competitor-intelligence/sources/[sourceId]` | [competitor-intelligence](./competitor-intelligence.md) | admin | Change one competitor source's status. |
| `POST` | `/api/competitor-intelligence/sync` | [competitor-intelligence](./competitor-intelligence.md) | admin | Admin-session trigger for the same collection pipeline the weekly cron runs, under the monthly USD budget cap. |
| `POST` | `/api/competitor-intelligence/task-suggestions/[suggestionId]/accept` | [competitor-intelligence](./competitor-intelligence.md) | admin | Promote an AI suggestion into a tracked response task — suggestions are never auto-executed. |
| `PATCH` | `/api/competitor-intelligence/tasks/[taskId]` | [competitor-intelligence](./competitor-intelligence.md) | admin | Update one response task. |
| `GET` | `/api/credit-control` | [credit-control](./credit-control.md) | admin | At-risk queue payload off the active credit-control snapshot. |
| `POST` | `/api/credit-control/actions` | [credit-control](./credit-control.md) | admin | Set or clear one student's follow-up action status. |
| `POST` | `/api/credit-control/actions/bulk` | [credit-control](./credit-control.md) | admin | Set or clear follow-up status across many students in one request. |
| `GET` | `/api/credit-control/actions/history` | [credit-control](./credit-control.md) | admin | Read the follow-up action history for auditing. |
| `POST` | `/api/credit-control/admin-ownership` | [credit-control](./credit-control.md) | admin | Assign the owning admin for a student and revalidate the cached snapshot tag. |
| `POST` | `/api/credit-control/inactive` | [credit-control](./credit-control.md) | admin | Mark a student inactive so they drop out of the at-risk ranking. |
| `DELETE` | `/api/credit-control/inactive` | [credit-control](./credit-control.md) | admin | Clear an inactive mark. |
| `POST` | `/api/credit-control/sync` | [credit-control](./credit-control.md) | admin | Admin-session trigger for the same `runCreditControlSyncRequest` the `20,50` cron runs. |
| `GET` | `/api/data-health` | [data-health](./data-health.md) | admin | Ops dashboard payload: cron firing, data freshness, Wise snapshot fidelity, unresolved normalization issues. |
| `POST` | `/api/data-health/jobs/[jobKey]/run` | [data-health](./data-health.md) | admin (+ capability / confirm) | Run one registry job by key. An unknown key is 404; a `post_class_feedback*` key additionally demands the `access_manager` capability (403); a job marked `dangerous` demands `confirmed: true` (409 with `confirmationLabel`). |
| `GET` | `/api/filters` | [filters](./misc.md#tutors-and-filters) | admin | Filter option sets (subjects, curricula, levels, exam prep) for the search UI. |
| `GET` | `/api/home/summary` | [home](./misc.md#home-summary) | admin | Home-hub action summary feeding the seven nav count badges. Exempted from `allowedPages` scoping in middleware so restricted users still get their badges. |
| `GET` | `/api/internal/admissions-notifications` | [internal](./internal-crons.md) | cron | Daily admissions deadline-reminder scan; on Bangkok Sundays the same invocation also runs the weekly digest. An explicit `runType` query param runs exactly one orchestrator. Scheduled `12 1 * * *`. |
| `POST` | `/api/internal/admissions-notifications` | [internal](./internal-crons.md) | cron | Same handler as the GET, with `runType` taken from the JSON body — the manual-trigger half. |
| `GET` | `/api/internal/class-assignments/admin-email` | [internal](./classrooms-and-assignments.md#internal-cron-endpoints) | cron | Send the daily admin classroom-schedule email. Scheduled `4,14,24,36 0 * * *`. |
| `GET` | `/api/internal/class-assignments/morning` | [internal](./classrooms-and-assignments.md#internal-cron-endpoints) | cron | Morning classroom automation: generate the day's run and drive the downstream steps. Scheduled `41 23 * * *`; `maxDuration = 800`. |
| `GET` | `/api/internal/cron-watchdog` | [internal](./internal-crons.md) | cron | Supervises the other jobs — fails abandoned `running` rows and updates `cron_alert_state`. Scheduled `7,37 * * * *`. |
| `POST` | `/api/internal/cron-watchdog` | [internal](./internal-crons.md) | cron | Identical sweep; the POST half exists for manual invocation. |
| `GET` | `/api/internal/line-backlog-recovery` | [internal](./internal-crons.md) | cron | Scans LINE contacts and re-matches the unresolved backlog in memory. Backlog-recovery only — it deliberately does **not** call the followers re-anchor. Registered `manualOnly`, so no `vercel.json` entry. |
| `GET` | `/api/internal/line-credit-digest` | [internal](./internal-crons.md) | cron | Pushes the daily credit digest to the LINE staff group. Scheduled `3 2 * * *`. |
| `GET` | `/api/internal/post-class-feedback-backfill` | [internal](./internal-crons.md) | cron | Drains post-class history: each run takes the oldest still-unreconciled window and works it until the pool empties or the budget is spent, so repeated runs converge without anyone picking dates. Explicit `start`/`end` overrides the automatic choice. Scheduled `23,53 * * * *`. |
| `GET` | `/api/internal/post-class-feedback/admin-digest` | [internal](./internal-crons.md) | cron | Sends the post-class admin digest. Registered `manualOnly` — reachable with the cron secret, but nothing schedules it. |
| `GET` | `/api/internal/post-class-feedback/payout-accrual` | [internal](./internal-crons.md) | cron | Runs the accrual pass unconditionally, then the finalize pass — which itself no-ops with `{ skipped: "window-not-ended" }` until the 26th-to-25th payout window has closed. Scheduled `33 * * * *`; also runnable from Data Health as a dangerous, confirm-gated job. |
| `GET` | `/api/internal/post-class-feedback/reminder-day-after` | [internal](./internal-crons.md) | cron | `runPostClassReminderJob("day_after")` — the day-after tutor reminder. Registered `manualOnly`. |
| `GET` | `/api/internal/post-class-feedback/reminder-deadline` | [internal](./internal-crons.md) | cron | `runPostClassReminderJob("deadline")` — the deadline reminder. Registered `manualOnly`. |
| `GET` | `/api/internal/progress-tests/admin-digest` | [internal](./internal-crons.md) | cron | Daily progress-test admin digest. Scheduled `35 0 * * *`. |
| `GET` | `/api/internal/student-promotions/july-1` | [internal](./internal-crons.md) | cron | Applies the verified July-1 promotion run. Refuses with 409 on any Bangkok date other than the target date — the only annual cron, `5 17 30 6 *`. |
| `POST` | `/api/internal/student-promotions/july-1` | [internal](./internal-crons.md) | cron | Delegates verbatim to the GET handler (`return GET(request)`), same date guard. |
| `GET` | `/api/internal/sync-competitor-intelligence` | [internal](./internal-crons.md) | cron | Weekly competitor collection run. Scheduled `28 18 * * 0` (Mon 01:28 Bangkok) — the only weekly entry. |
| `POST` | `/api/internal/sync-competitor-intelligence` | [internal](./internal-crons.md) | cron \| admin | Manual rerun: the cron secret, or `requireCompetitorIntelligenceSession` as the session fallback. |
| `GET` | `/api/internal/sync-credit-control` | [internal](./internal-crons.md) | cron | Credit-control snapshot sync. Scheduled `20,50 * * * *`; `maxDuration = 800` after successful runs were measured at 372–390s against the old 300s ceiling. |
| `POST` | `/api/internal/sync-credit-control` | [internal](./internal-crons.md) | cron \| admin | Manual rerun with an Auth.js session fallback; the actor email is stamped on the run. |
| `GET` | `/api/internal/sync-leave-requests` | [internal](./internal-crons.md) | cron | Pulls leave-form rows from the Google Sheet, matches identities, computes affected sessions. Scheduled `15,45 * * * *`. A concurrent run returns 409. |
| `POST` | `/api/internal/sync-leave-requests` | [internal](./internal-crons.md) | cron | Same `handle(request)` as the GET — cron-secret only on both halves. |
| `GET` | `/api/internal/sync-post-class-feedback` | [internal](./internal-crons.md) | cron | Rolling evidence collection plus AI reviews, due notification retries, and deduction hygiene — which reopens unproven approvals and waives deductions on sessions the sync just found ineligible, releasing claims but never approving. Scheduled `13,43 * * * *`. |
| `GET` | `/api/internal/sync-progress-tests` | [internal](./internal-crons.md) | cron | Progress-test counting/lifecycle sync. Scheduled `25,55 * * * *`. |
| `POST` | `/api/internal/sync-progress-tests` | [internal](./internal-crons.md) | cron \| admin | Manual rerun with a session fallback (`triggerType: "admin"`). |
| `POST` | `/api/internal/sync-room-utilization` | [internal](./room-capacity.md) | cron \| admin | Room-utilization ingest. POST-only, registered `manualOnly` with no `vercel.json` entry; the session branch requires a signed-in admin. |
| `GET` | `/api/internal/sync-sales-dashboard` | [internal](./sales-dashboard.md#cron-sync) | cron | Sales-sheet ingest. Scheduled `10,40 * * * *`. |
| `POST` | `/api/internal/sync-sales-dashboard` | [internal](./sales-dashboard.md#cron-sync) | cron \| admin | Manual rerun; a session, when present, supplies the `actorEmail`. |
| `GET` | `/api/internal/sync-wise` | [internal](./internal-crons.md) | cron | The Wise snapshot ETL — fetch, normalize, persist, validate, promote. Scheduled `*/30 * * * *`; `maxDuration = 800`; single-flight guarded. |
| `POST` | `/api/internal/sync-wise` | [internal](./internal-crons.md) | cron \| admin | Manual trigger via Auth.js session or `curl -X POST` (kept backward compatible). |
| `GET` | `/api/internal/sync-wise-activity` | [internal](./wise-activity.md) | cron | Wise audit-event ingest. Scheduled `2,17,32,47 * * * *` — the only quarter-hourly job. |
| `GET` | `/api/leave-requests` | [leave-requests](./leave-requests.md) | admin | Leave-request worklist plus the Google OAuth token status for the connected sheet account. |
| `GET` | `/api/leave-requests/[requestId]` | [leave-requests](./leave-requests.md) | admin | One request with its affected sessions. |
| `PATCH` | `/api/leave-requests/[requestId]` | [leave-requests](./leave-requests.md) | admin | Advance the review workflow and write status back to the source sheet, using the resolved connected email. |
| `POST` | `/api/leave-requests/[requestId]/wise-cancel-preview` | [leave-requests](./leave-requests.md) | admin | **Dry run only** — builds the Wise cancellation preview for the affected sessions. Nothing is cancelled in Wise. |
| `POST` | `/api/leave-requests/sync` | [leave-requests](./leave-requests.md) | admin | Admin-session trigger for the same `syncLeaveRequests` the `15,45` cron runs. |
| `PATCH` | `/api/line/contacts/[contactId]` | [line](./line.md) | admin | Update a contact's labels and refresh its student-link suggestions. |
| `GET` | `/api/line/contacts/[contactId]/student-links` | [line](./line.md) | admin | Existing student links for one contact, with suggestions ensured first. |
| `POST` | `/api/line/contacts/[contactId]/student-links` | [line](./line.md) | admin | Create a verified contact↔student link, attributed to the session actor. |
| `PATCH` | `/api/line/contacts/[contactId]/student-links` | [line](./line.md) | admin | Change one link's status. |
| `POST` | `/api/line/contacts/alias-import/commit` | [line](./line.md) | admin | Commit a previewed alias import. |
| `POST` | `/api/line/contacts/alias-import/preview` | [line](./line.md) | admin | Multipart preview of an alias import (image + form fields), computed without writing. |
| `POST` | `/api/line/contacts/followers-reanchor` | [line](./line.md) | admin | Re-anchor follower contacts, then run backlog recovery — the one caller that pairs both passes. |
| `GET` | `/api/line/contacts/link-validation` | [line](./line.md) | admin | The link-validation task queue for the signed-in actor. |
| `PATCH` | `/api/line/contacts/link-validation/[linkId]` | [line](./line.md) | admin | Set one validation task's status. |
| `POST` | `/api/line/contacts/link-validation/assign` | [line](./line.md) | admin | Assign validation tasks to reviewers. |
| `GET` | `/api/line/contacts/link-validation/summary` | [line](./line.md) | admin | Counts across the validation queue. |
| `GET` | `/api/line/contacts/oa-resolver/runs` | [line](./line.md) | admin | List OA-resolver runs, or the latest one. |
| `POST` | `/api/line/contacts/oa-resolver/runs` | [line](./line.md) | admin | Start a new OA-resolver run. |
| `GET` | `/api/line/contacts/oa-resolver/runs/[runId]` | [line](./line.md) | admin | One resolver run with its rows. |
| `POST` | `/api/line/contacts/oa-resolver/runs/[runId]/commit` | [line](./line.md) | admin | Commit a resolver run's resolved rows into contacts. |
| `POST` | `/api/line/contacts/oa-resolver/runs/[runId]/rows` | [line](./line.md) | public | Browser-extension row upload. Middleware-public; the handler requires an opaque `Bearer` resolver token (401 when missing or expired). A sibling `OPTIONS` preflight is excluded from the endpoint count. |
| `GET` | `/api/line/contacts/oa-resolver/worklist` | [line](./line.md) | public | Browser-extension worklist fetch, gated by the same opaque `Bearer` resolver token. Its `OPTIONS` preflight is the second excluded handler. |
| `POST` | `/api/line/contacts/refresh-profiles` | [line](./line.md) | admin | Refresh every LINE contact profile from the Messaging API. |
| `PATCH` | `/api/line/messages/[messageId]/classification-feedback` | [line](./line.md) | admin | Record classifier feedback on one message. |
| `POST` | `/api/line/messages/[messageId]/promote` | [line](./line.md) | admin | Promote a message the classifier missed into a scheduler review. |
| `GET` | `/api/line/scheduler-reviews` | [line](./line.md) | admin | Review worklist plus the scheduler analytics roll-up. |
| `PATCH` | `/api/line/scheduler-reviews/[reviewId]` | [line](./line.md) | admin | Decision action on one review — approve, accept-without-send, reject, or dismiss. |
| `GET` | `/api/line/scheduler-reviews/[reviewId]/context` | [line](./line.md) | admin | The surrounding chat context for one review. |
| `POST` | `/api/line/scheduler-reviews/[reviewId]/operational-plan` | [line](./line.md) | admin | Build and persist the operational plan for one review. |
| `GET` | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | [line](./line.md) | admin | The Wise-action audit log for one review. |
| `POST` | `/api/line/scheduler-reviews/[reviewId]/wise-actions` | [line](./line.md) | admin | Confirm one Wise action; writeback stays dry-run/flag-gated. |
| `GET` | `/api/line/scheduler-reviews/false-negatives` | [line](./line.md) | admin | Candidate messages the classifier likely missed. |
| `GET` | `/api/line/students` | [line](./line.md) | admin | Student search for contact linking. |
| `POST` | `/api/line/webhook` | [line](./line.md) | public | LINE Messaging API webhook. Middleware-public; the handler verifies the channel signature. Routes to scheduler ingest (gated by `ENABLE_LINE_SCHEDULER`) and to the admin-only group schedule bot. |
| `GET` | `/api/payroll` | [payroll](./payroll.md) | admin | The month payload for a Bangkok `YYYY-MM`: rate card, review state, last sync, summary roll-ups, per-tutor rows, issues, adjustments. |
| `POST` | `/api/payroll/adjustments` | [payroll](./payroll.md) | admin with `user.email` | Insert a manual adjustment (the actor email is stamped on the row) and echo the refreshed month payload. |
| `DELETE` | `/api/payroll/adjustments/[adjustmentId]` | [payroll](./payroll.md) | admin | Delete one adjustment. The one payroll write that does **not** echo the payload — 404 when no row matched. |
| `PATCH` | `/api/payroll/review` | [payroll](./payroll.md) | admin with `user.email` | Upsert the month's review row (draft/approved + notes), stamping the approver. |
| `POST` | `/api/payroll/sync` | [payroll](./payroll.md) | admin | Reconcile the month from Wise sessions and payout invoices against the rate card. The only way a payroll sync starts — there is no payroll cron. |
| `GET` | `/api/post-class-feedback` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`viewer` | Compliance dashboard for a date range (defaults via `defaultPostClassFeedbackRange`). |
| `PATCH` | `/api/post-class-feedback/access` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`access_manager` | Replace the capability grants for one user. Guarded so an access manager cannot remove the last manager. |
| `POST` | `/api/post-class-feedback/ai-review` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`reviewer` | Run the AI concern review over selected sessions. |
| `POST` | `/api/post-class-feedback/finance` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`finance` | Finance action union — `process`, `move`, `reverse` — over reviewed deductions. |
| `POST` | `/api/post-class-feedback/finance-periods` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`finance` | Finance period state change — `open`, `close`, `reopen`. |
| `POST` | `/api/post-class-feedback/payout-runs` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`finance` (+ payout write cap) | Payout-run action union — `preview`, `publish`, `verify_sheet`, `retry_csv`, `resolve_exception`. The publish path additionally checks the payout write capability and `POST_CLASS_PAYOUT_WRITES_ENABLED`. |
| `POST` | `/api/post-class-feedback/review` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`reviewer` | Review decision union — `approve`, `waive`, `reopen`, `reinstate`. |
| `GET` | `/api/post-class-feedback/sessions/[sessionId]` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`viewer` | Full evidence detail for one session: versions, timeliness, authorship, deduction state. |
| `PATCH` | `/api/post-class-feedback/settings` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`access_manager` | Update enforcement settings — mode, effective instant, thresholds. |
| `POST` | `/api/post-class-feedback/shadow-review` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`access_manager` | Classify shadow-mode evidence and mark it reviewed; blocked while open global source issues remain. |
| `POST` | `/api/post-class-feedback/sync` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`access_manager` | In-app trigger for the collection sync plus AI reviews, notification retries, and session reassessment. |
| `POST` | `/api/post-class-feedback/test-email` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`access_manager` | Send one test reminder email to verify template and delivery. |
| `PATCH` | `/api/post-class-feedback/tutor-emails` | [post-class-feedback](./post-class-feedback.md) | admin + cap:`access_manager` | Set a tutor's primary notification email. |
| `GET` | `/api/progress-tests` | [progress-tests](./progress-tests.md) | admin | Dashboard payload. Teacher-scoped: `resolveTeacherCanonicalKeys` narrows the rows for a non-admin teacher session. |
| `POST` | `/api/progress-tests/book` | [progress-tests](./progress-tests.md) | admin (admin session) | Book a progress test for a student-subject pair. |
| `POST` | `/api/progress-tests/mark-at-home-submitted` | [progress-tests](./progress-tests.md) | admin (admin session) | Mark an at-home test as submitted. |
| `POST` | `/api/progress-tests/mark-complete` | [progress-tests](./progress-tests.md) | admin (admin session) | Complete a cycle and reset the every-8-classes counter. |
| `POST` | `/api/progress-tests/resend-email` | [progress-tests](./progress-tests.md) | admin (admin session) | Re-send the teacher heads-up email for one cycle. |
| `POST` | `/api/progress-tests/select-at-home` | [progress-tests](./progress-tests.md) | admin (admin session) | Route a due test to the at-home path. |
| `POST` | `/api/proposals` | [proposals](./proposals.md) | admin | Create a tentative hold bundle against the in-memory index; a same-tutor overlap surfaces as a database overlap error, not a silent double-book. Never written to Wise. |
| `GET` | `/api/proposals/active` | [proposals](./proposals.md) | admin | Active holds, for overlay in search. |
| `PATCH` | `/api/proposals/items/[itemId]` | [proposals](./proposals.md) | admin | Update one hold item. |
| `GET` | `/api/room-capacity/forecast` | [room-capacity](./room-capacity.md) | admin | Forecast payload. Returns a typed missing-table body with HTTP 200 — not 500 — when the forecast tables have not been created. No frontend consumer at this revision. |
| `GET` | `/api/room-capacity/month` | [room-capacity](./room-capacity.md) | admin | Month roll-up. Implemented, tested, authenticated — and, like the forecast, called by nothing outside its own tests. |
| `GET` | `/api/room-capacity/utilization` | [room-capacity](./room-capacity.md) | admin | Room utilization, filterable by weekday. The one room-capacity read the dashboard actually calls. |
| `GET` | `/api/sales-dashboard` | [sales-dashboard](./sales-dashboard.md) | admin | GM command-center payload: monthly actuals, scenario projections, insights. |
| `GET` | `/api/sales-dashboard/dimensions` | [sales-dashboard](./sales-dashboard.md) | admin | Dimension option sets for the dashboard filters. |
| `POST` | `/api/sales-dashboard/import` | [sales-dashboard](./sales-dashboard.md) | admin | Import one source, all refreshable sources, or every source, depending on the body; returns the imported-source count. |
| `GET` | `/api/sales-dashboard/import-runs` | [sales-dashboard](./sales-dashboard.md) | admin | Recent import runs with their outcomes. |
| `POST` | `/api/sales-dashboard/projection-import` | [sales-dashboard](./sales-dashboard.md) | admin | Import the active scenario-projection workbook (Bear/Base/Bull). |
| `POST` | `/api/sales-dashboard/projection-source` | [sales-dashboard](./sales-dashboard.md) | admin | Upsert the projection source, or seed the default one. |
| `GET` | `/api/sales-dashboard/sources` | [sales-dashboard](./sales-dashboard.md) | admin | List configured monthly sales sources. |
| `POST` | `/api/sales-dashboard/sources` | [sales-dashboard](./sales-dashboard.md) | admin | Create or update a source. |
| `PATCH` | `/api/sales-dashboard/sources/[sourceId]` | [sales-dashboard](./sales-dashboard.md) | admin | Change one source's status. |
| `DELETE` | `/api/sales-dashboard/sources/[sourceId]` | [sales-dashboard](./sales-dashboard.md) | admin | Archive a source (soft, not a row delete). |
| `POST` | `/api/sales-dashboard/sources/seed` | [sales-dashboard](./sales-dashboard.md) | admin | Seed the default source set. |
| `GET` | `/api/sales-dashboard/transactions` | [sales-dashboard](./sales-dashboard.md) | admin | Filtered slim transaction rows. |
| `GET` | `/api/sales-dashboard/transactions/export` | [sales-dashboard](./sales-dashboard.md) | admin | The same filtered rows serialized as CSV, with a derived filename. |
| `POST` | `/api/search` | [search](./misc.md#search) | admin | Slot search against the warm in-memory index (`ensureIndex` → `executeSearch`), fail-closed to Needs Review. |
| `POST` | `/api/search/assistant` | [search](./misc.md#search) | admin | Natural-language search assistant. Middleware-public but the handler still calls `auth()` and returns 401 without a session — effectively admin-only. |
| `POST` | `/api/search/range` | [search](./misc.md#search) | admin | Range search: a time window plus class duration is expanded into backend sub-slots before the availability grid is evaluated. |
| `GET` | `/api/student-promotions/runs` | [student-promotions](./student-promotions.md) | admin | The latest promotion run with its full detail. |
| `POST` | `/api/student-promotions/runs` | [student-promotions](./student-promotions.md) | admin | Create a dry-run: compute every promotion, graduation, and pay-band action without applying anything. |
| `GET` | `/api/student-promotions/runs/[runId]` | [student-promotions](./student-promotions.md) | admin | One run's detail. |
| `POST` | `/api/student-promotions/runs/[runId]/apply` | [student-promotions](./student-promotions.md) | admin | Apply a **verified** run to Wise. The verify step is a precondition, not advice. |
| `POST` | `/api/student-promotions/runs/[runId]/future-sessions/apply` | [student-promotions](./student-promotions.md) | admin | Apply the future-session pay-band actions for a run. |
| `PATCH` | `/api/student-promotions/runs/[runId]/graduation-actions/[actionId]` | [student-promotions](./student-promotions.md) | admin | Set one graduation action's disposition. |
| `PATCH` | `/api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review` | [student-promotions](./student-promotions.md) | admin | Set the review status on one pay-rate impact. |
| `POST` | `/api/student-promotions/runs/[runId]/readback` | [student-promotions](./student-promotions.md) | admin | Read the applied state back from Wise and diff it against what the run intended. |
| `POST` | `/api/student-promotions/runs/[runId]/verify` | [student-promotions](./student-promotions.md) | admin | Verify a dry run so it becomes applicable. |
| `GET` | `/api/student-report` | [student-report](./student-schedule-and-report.md#parent-class-report) | admin | Parent class report over the active credit-control snapshot: per-student class rows with optional tutor-feedback sub-rows (`feedback=0` excludes them). Accepts repeated `student` params plus `from`/`to`. |
| `GET` | `/api/student-schedule` | [student-schedule](./student-schedule-and-report.md#student-monthly-schedule) | admin | A student's monthly calendar for a `YYYY-MM`, built from `credit_control_sessions` on the active snapshot. Cancelled sessions are omitted; an unresolved teacher renders `TEACHER_TBC`. |
| `POST` | `/api/student-schedule/link` | [student-schedule](./student-schedule-and-report.md#student-monthly-schedule) | admin | Mint a hashed capability-token link to the public `/schedule/{token}` parent page, TTL from `STUDENT_SCHEDULE_LINK_TTL_DAYS`, base URL from `APP_BASE_URL` or the request origin. |
| `GET` | `/api/tutor-profiles` | [tutor-profiles](./tutor-profiles.md) | admin | List editorial tutor business profiles. |
| `PATCH` | `/api/tutor-profiles/[canonicalKey]` | [tutor-profiles](./tutor-profiles.md) | admin | Upsert one profile by stable `canonicalKey` and clear the in-memory search index so the change is visible on the next query. |
| `POST` | `/api/tutor-profiles/import-commit` | [tutor-profiles](./tutor-profiles.md) | admin | Commit a previewed bulk import, then clear the search index. |
| `POST` | `/api/tutor-profiles/import-preview` | [tutor-profiles](./tutor-profiles.md) | admin | Parse uploaded workbooks and compute a bulk-import preview against existing profiles, aliases, and identities — no writes. |
| `GET` | `/api/tutors` | [tutors](./misc.md#tutors-and-filters) | admin | Tutor list for the searchable combobox. |
| `GET` | `/api/us-universities` | [us-universities](./us-universities.md) | admin | Research-console overview counters. |
| `GET` | `/api/us-universities/compare` | [us-universities](./us-universities.md) | admin | Side-by-side institution comparison for a set of `unitId`s. |
| `GET` | `/api/us-universities/export` | [us-universities](./us-universities.md) | admin | The current filtered institution set as CSV. |
| `GET` | `/api/us-universities/institutions/[unitId]` | [us-universities](./us-universities.md) | admin | One institution's dossier. |
| `GET` | `/api/us-universities/search` | [us-universities](./us-universities.md) | admin | Filtered institution search over the curated IPEDS slice. |
| `GET` | `/api/wise-activity` | [wise-activity](./wise-activity.md) | admin | Persisted Wise audit events for a Bangkok date range (defaults to a window ending today). |
| `GET` | `/api/wise-activity/reconciliation` | [wise-activity](./wise-activity.md) | admin | Package-sales reconciliation for a validated date range. |
| `POST` | `/api/wise-activity/reconciliation/backfill` | [wise-activity](./wise-activity.md) | admin | Backfill events over the reconciliation lookback window using a fresh Wise client. |
| `GET` | `/api/wise-activity/summary` | [wise-activity](./wise-activity.md) | admin | KPI roll-up over the same Bangkok range logic as the events read. |
| `POST` | `/api/wise-activity/sync` | [wise-activity](./wise-activity.md) | admin | Manual event ingest, optionally narrowed by event name and page budget. |

---

## Where to go next

- **Feature meaning** — why an endpoint exists, the rules it enforces, the flow it sits in: [`docs/features/`](../../features/), indexed from [`docs/README.md`](../../README.md).
- **Column-level table detail** for anything an endpoint reads or writes: [`docs/reference/database/index.md`](../database/index.md).
- **Cron schedules, stagger, and `maxDuration`**: [`docs/reference/crons.md`](../crons.md).
- **Environment variables** an endpoint depends on: [`docs/reference/env.md`](../env.md).
- **The Wise API contracts** behind every sync route: [`docs/reference/wise-api.md`](../wise-api.md).

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
