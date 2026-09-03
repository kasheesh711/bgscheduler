# University Admissions API

Feature meaning — why cases exist, the role model's intent, the 10-phase checklist, the family-facing rules — lives in [docs/features/university-admissions.md](../../features/university-admissions.md). Column-level detail for the 36 `admissions_*` tables lives in [docs/reference/database/erd-university-admissions.md](../database/erd-university-admissions.md). The cross-group inventory is [docs/reference/api/index.md](./index.md). **This page owns the mechanics**: method, path, auth, request shape, response shape, side effects, and status codes.

## Endpoint index (63)

**61 endpoints under `/api/admissions`** across 21 `route.ts` files, plus the **2 cron handlers** on `/api/internal/admissions-notifications` — 63 in scope. Every count here is a handler count from the files listed in the Handler column; no route file in the family exports `OPTIONS`, `HEAD`, or a destructured handler object.

The **Min role** column is the role the handler passes to its guard, under the ordering `parent < student < counselor < admin` ([`config.ts:17-30`](../../../src/lib/admissions/config.ts)). `staff` means [`requireCounselorOrAdmin`](../../../src/lib/admissions/access.ts) (an `admin_users` row **or** an active `admissions_counselors` registry row) rather than per-case membership; `admin (global)` means [`requireAdmissionsAdmin`](../../../src/lib/admissions/access.ts) (an `admin_users` row only); `session` means nothing beyond [`requireAdmissionsSession`](../../../src/lib/admissions/access.ts).

| Method | Path | Min role | Writes | Handler |
|---|---|---|---|---|
| GET | `/api/admissions/cases` | staff | none | [`cases/route.ts:49-63`](../../../src/app/api/admissions/cases/route.ts) |
| POST | `/api/admissions/cases` | staff | case + student + members + checklist tasks | [`cases/route.ts:65-108`](../../../src/app/api/admissions/cases/route.ts) |
| GET | `/api/admissions/cases/[caseId]` | parent (parents then 403) | none | [`cases/[caseId]/route.ts:54-72`](../../../src/app/api/admissions/cases/[caseId]/route.ts) |
| PATCH | `/api/admissions/cases/[caseId]` | counselor | case profile + lifecycle | [`cases/[caseId]/route.ts:74-133`](../../../src/app/api/admissions/cases/[caseId]/route.ts) |
| GET | `/api/admissions/cases/[caseId]/members` | counselor | none | [`members/route.ts:55-72`](../../../src/app/api/admissions/cases/[caseId]/members/route.ts) |
| POST | `/api/admissions/cases/[caseId]/members` | counselor | `admissions_case_members` insert | [`members/route.ts:74-117`](../../../src/app/api/admissions/cases/[caseId]/members/route.ts) |
| PATCH | `/api/admissions/cases/[caseId]/members` | counselor | revoke / re-invite / email change | [`members/route.ts:119-164`](../../../src/app/api/admissions/cases/[caseId]/members/route.ts) |
| GET | `/api/admissions/cases/[caseId]/tasks` | student | none | [`tasks/route.ts:101-116`](../../../src/app/api/admissions/cases/[caseId]/tasks/route.ts) |
| POST | `/api/admissions/cases/[caseId]/tasks` | counselor | custom task insert | [`tasks/route.ts:118-156`](../../../src/app/api/admissions/cases/[caseId]/tasks/route.ts) |
| PATCH | `/api/admissions/cases/[caseId]/tasks` | student (per-action) | task status / verify / update / soft delete | [`tasks/route.ts:158-223`](../../../src/app/api/admissions/cases/[caseId]/tasks/route.ts) |
| DELETE | `/api/admissions/cases/[caseId]/tasks` | counselor | task soft delete | [`tasks/route.ts:225-249`](../../../src/app/api/admissions/cases/[caseId]/tasks/route.ts) |
| GET | `/api/admissions/cases/[caseId]/colleges` | student | none | [`colleges/route.ts:99-116`](../../../src/app/api/admissions/cases/[caseId]/colleges/route.ts) |
| POST | `/api/admissions/cases/[caseId]/colleges` | counselor | college-list insert | [`colleges/route.ts:118-157`](../../../src/app/api/admissions/cases/[caseId]/colleges/route.ts) |
| PATCH | `/api/admissions/cases/[caseId]/colleges` | counselor | college-list update | [`colleges/route.ts:159-198`](../../../src/app/api/admissions/cases/[caseId]/colleges/route.ts) |
| DELETE | `/api/admissions/cases/[caseId]/colleges` | counselor | soft delete + committed-pointer clear | [`colleges/route.ts:200-224`](../../../src/app/api/admissions/cases/[caseId]/colleges/route.ts) |
| GET | `/api/admissions/cases/[caseId]/colleges/[itemId]/events` | student | none | [`events/route.ts:59-80`](../../../src/app/api/admissions/cases/[caseId]/colleges/[itemId]/events/route.ts) |
| POST | `/api/admissions/cases/[caseId]/colleges/[itemId]/events` | counselor | decision-event append (or committed-pointer move) | [`events/route.ts:82-126`](../../../src/app/api/admissions/cases/[caseId]/colleges/[itemId]/events/route.ts) |
| GET | `/api/admissions/cases/[caseId]/essays` | student | none | [`essays/route.ts:72-86`](../../../src/app/api/admissions/cases/[caseId]/essays/route.ts) |
| POST | `/api/admissions/cases/[caseId]/essays` | student | essay insert | [`essays/route.ts:88-123`](../../../src/app/api/admissions/cases/[caseId]/essays/route.ts) |
| PATCH | `/api/admissions/cases/[caseId]/essays` | student (staff fields counselor+) | essay update | [`essays/route.ts:125-175`](../../../src/app/api/admissions/cases/[caseId]/essays/route.ts) |
| DELETE | `/api/admissions/cases/[caseId]/essays` | counselor | essay soft delete | [`essays/route.ts:177-201`](../../../src/app/api/admissions/cases/[caseId]/essays/route.ts) |
| GET | `/api/admissions/cases/[caseId]/activities` | student | none | [`activities/route.ts:85-99`](../../../src/app/api/admissions/cases/[caseId]/activities/route.ts) |
| POST | `/api/admissions/cases/[caseId]/activities` | student | activity insert | [`activities/route.ts:101-137`](../../../src/app/api/admissions/cases/[caseId]/activities/route.ts) |
| PATCH | `/api/admissions/cases/[caseId]/activities` | student | activity update **or** Common App rank rewrite | [`activities/route.ts:139-182`](../../../src/app/api/admissions/cases/[caseId]/activities/route.ts) |
| DELETE | `/api/admissions/cases/[caseId]/activities` | student | activity soft delete | [`activities/route.ts:184-208`](../../../src/app/api/admissions/cases/[caseId]/activities/route.ts) |
| GET | `/api/admissions/cases/[caseId]/testing` | student | none | [`testing/route.ts:59-76`](../../../src/app/api/admissions/cases/[caseId]/testing/route.ts) |
| POST | `/api/admissions/cases/[caseId]/testing` | student | sitting insert | [`testing/route.ts:78-113`](../../../src/app/api/admissions/cases/[caseId]/testing/route.ts) |
| PATCH | `/api/admissions/cases/[caseId]/testing` | student (`scoreReleasedToParent` counselor+) | sitting update | [`testing/route.ts:115-165`](../../../src/app/api/admissions/cases/[caseId]/testing/route.ts) |
| DELETE | `/api/admissions/cases/[caseId]/testing` | student | sitting soft delete | [`testing/route.ts:167-191`](../../../src/app/api/admissions/cases/[caseId]/testing/route.ts) |
| GET | `/api/admissions/cases/[caseId]/recommenders` | student | none | [`recommenders/route.ts:113-128`](../../../src/app/api/admissions/cases/[caseId]/recommenders/route.ts) |
| POST | `/api/admissions/cases/[caseId]/recommenders` | counselor | recommender insert | [`recommenders/route.ts:130-167`](../../../src/app/api/admissions/cases/[caseId]/recommenders/route.ts) |
| PATCH | `/api/admissions/cases/[caseId]/recommenders` | counselor | update / link / submission / college doc | [`recommenders/route.ts:169-256`](../../../src/app/api/admissions/cases/[caseId]/recommenders/route.ts) |
| DELETE | `/api/admissions/cases/[caseId]/recommenders` | counselor | recommender soft delete | [`recommenders/route.ts:258-282`](../../../src/app/api/admissions/cases/[caseId]/recommenders/route.ts) |
| GET | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | student | none | [`sections/[sectionKey]/route.ts:47-59`](../../../src/app/api/admissions/cases/[caseId]/sections/[sectionKey]/route.ts) |
| PUT | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | student | draft autosave (merge) | [`sections/[sectionKey]/route.ts:61-92`](../../../src/app/api/admissions/cases/[caseId]/sections/[sectionKey]/route.ts) |
| POST | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | student (`review` counselor+) | state transition | [`sections/[sectionKey]/route.ts:94-132`](../../../src/app/api/admissions/cases/[caseId]/sections/[sectionKey]/route.ts) |
| GET | `/api/admissions/cases/[caseId]/meetings` | counselor | none | [`meetings/route.ts:52-66`](../../../src/app/api/admissions/cases/[caseId]/meetings/route.ts) |
| POST | `/api/admissions/cases/[caseId]/meetings` | counselor | meeting + action-item tasks | [`meetings/route.ts:68-111`](../../../src/app/api/admissions/cases/[caseId]/meetings/route.ts) |
| PATCH | `/api/admissions/cases/[caseId]/meetings` | counselor | meeting update | [`meetings/route.ts:113-152`](../../../src/app/api/admissions/cases/[caseId]/meetings/route.ts) |
| GET | `/api/admissions/cases/[caseId]/notes` | student | none | [`notes/route.ts:36-50`](../../../src/app/api/admissions/cases/[caseId]/notes/route.ts) |
| POST | `/api/admissions/cases/[caseId]/notes` | counselor | note insert | [`notes/route.ts:52-87`](../../../src/app/api/admissions/cases/[caseId]/notes/route.ts) |
| PATCH | `/api/admissions/cases/[caseId]/notes` | counselor | note visibility change | [`notes/route.ts:89-124`](../../../src/app/api/admissions/cases/[caseId]/notes/route.ts) |
| GET | `/api/admissions/cases/[caseId]/calendar` | student | none | [`calendar/route.ts:47-76`](../../../src/app/api/admissions/cases/[caseId]/calendar/route.ts) |
| GET | `/api/admissions/cases/[caseId]/parent-dashboard` | parent | none | [`parent-dashboard/route.ts:25-39`](../../../src/app/api/admissions/cases/[caseId]/parent-dashboard/route.ts) |
| GET | `/api/admissions/announcements` | student (case) / staff (cohort) | none | [`announcements/route.ts:108-141`](../../../src/app/api/admissions/announcements/route.ts) |
| POST | `/api/admissions/announcements` | counselor (case) / staff (cohort) | announcement insert | [`announcements/route.ts:143-191`](../../../src/app/api/admissions/announcements/route.ts) |
| PATCH | `/api/admissions/announcements` | staff, re-anchored on the stored scope | announcement update | [`announcements/route.ts:193-228`](../../../src/app/api/admissions/announcements/route.ts) |
| DELETE | `/api/admissions/announcements` | staff, re-anchored on the stored scope | announcement soft delete | [`announcements/route.ts:230-258`](../../../src/app/api/admissions/announcements/route.ts) |
| GET | `/api/admissions/resources` | session | none | [`resources/route.ts:67-76`](../../../src/app/api/admissions/resources/route.ts) |
| POST | `/api/admissions/resources` | staff | resource insert | [`resources/route.ts:78-110`](../../../src/app/api/admissions/resources/route.ts) |
| PATCH | `/api/admissions/resources` | staff | resource update | [`resources/route.ts:112-145`](../../../src/app/api/admissions/resources/route.ts) |
| DELETE | `/api/admissions/resources` | staff | resource soft delete | [`resources/route.ts:147-171`](../../../src/app/api/admissions/resources/route.ts) |
| GET | `/api/admissions/cohorts` | staff | none | [`cohorts/route.ts:25-35`](../../../src/app/api/admissions/cohorts/route.ts) |
| POST | `/api/admissions/cohorts` | admin (global) | cohort insert | [`cohorts/route.ts:41-63`](../../../src/app/api/admissions/cohorts/route.ts) |
| GET | `/api/admissions/cohorts/[cohortId]/templates` | staff | none | [`templates/route.ts:77-92`](../../../src/app/api/admissions/cohorts/[cohortId]/templates/route.ts) |
| POST | `/api/admissions/cohorts/[cohortId]/templates` | admin (global) | new template version **or** push-new-items across the cohort | [`templates/route.ts:94-142`](../../../src/app/api/admissions/cohorts/[cohortId]/templates/route.ts) |
| PATCH | `/api/admissions/cohorts/[cohortId]/templates` | admin (global) | template publish | [`templates/route.ts:144-183`](../../../src/app/api/admissions/cohorts/[cohortId]/templates/route.ts) |
| GET | `/api/admissions/counselors` | admin (global) | none | [`counselors/route.ts:40-50`](../../../src/app/api/admissions/counselors/route.ts) |
| POST | `/api/admissions/counselors` | admin (global) | registry upsert | [`counselors/route.ts:56-83`](../../../src/app/api/admissions/counselors/route.ts) |
| PATCH | `/api/admissions/counselors` | admin (global) | registry upsert / deactivate | [`counselors/route.ts:90-116`](../../../src/app/api/admissions/counselors/route.ts) |
| GET | `/api/admissions/audit/[caseId]` | admin (JWT **and** `admin_users`) | none | [`audit/[caseId]/route.ts:35-66`](../../../src/app/api/admissions/audit/[caseId]/route.ts) |
| GET | `/api/internal/admissions-notifications` | `CRON_SECRET` | notification runs + emails | [`admissions-notifications/route.ts:73-88`](../../../src/app/api/internal/admissions-notifications/route.ts) |
| POST | `/api/internal/admissions-notifications` | `CRON_SECRET` | notification runs + emails | [`admissions-notifications/route.ts:91-114`](../../../src/app/api/internal/admissions-notifications/route.ts) |

---

## Conventions shared by every `/api/admissions` handler

### The two-step guard stack

Every one of the 61 handlers opens the same way, and **the guard runs before the body is read** — a membership or role failure never touches the request payload:

1. **`requireAdmissionsSession()`** ([`access.ts:76-97`](../../../src/lib/admissions/access.ts)) reads the Auth.js session, lowercases the email, and throws `Unauthorized` when either email or name is missing. It then throws `Forbidden` when `allowedPages` does not grant `/admissions` (`hasPageAccess`, [`progress-tests/api.ts:15-21`](../../../src/lib/progress-tests/api.ts)), and maps the JWT `role` claim: `counselor` / `student` / `parent` pass through, `"admin"` or an absent/null role becomes `admin`, and **anything else — e.g. `"teacher"` — is `Forbidden`**. The claim is used for nav shaping and (in two places noted below) as a fast-fail; it never grants rights.
2. **A Postgres-resolved guard**, re-queried on every single request so revocation is instant rather than deferred to JWT expiry:

| Guard | Resolves | Denies when |
|---|---|---|
| [`requireCaseAccess(email, caseId, minRole)`](../../../src/lib/admissions/access.ts) (`access.ts:117-172`) | per-case role | caseId is not UUID-shaped (`Forbidden`, before any query); case missing or soft-deleted (`NotFound` for `admin_users` rows, `Forbidden` for everyone else); no `active` `admissions_case_members` row; a counselor membership whose registry row is missing or `active = false`; role below `minRole` |
| [`requireCounselorOrAdmin(email)`](../../../src/lib/admissions/access.ts) (`access.ts:196-219`) | `staff` — `{ role: "admin" \| "counselor" }` | no `admin_users` row **and** no `active` registry row |
| [`requireAdmissionsAdmin(email)`](../../../src/lib/admissions/access.ts) (`access.ts:234-248`) | `admin` | no `admin_users` row — an active registry counselor is refused |

`requireCaseAccess` is deliberately asymmetric about existence: a non-admin probing a caseId that does not exist gets `403`, never `404`, so case existence cannot be enumerated.

**Middleware.** `/api/admissions/**` is not on the public allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before any handler runs, and a restricted user whose `allowedPages` does not prefix-match `/admissions` gets a middleware-level `403 {"error":"Forbidden"}` — `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:36-67`](../../../src/middleware.ts), [`:99`](../../../src/middleware.ts)).

### Error mapping

Every handler ends in `catch (error) { return admissionsErrorResponse(route, error, fallback) }` ([`access.ts:256-287`](../../../src/lib/admissions/access.ts)). It matches on the thrown `Error.message` exactly:

| Thrown message | Status | Body |
|---|---|---|
| `Unauthorized` | 401 | `{"error":"Unauthorized"}` |
| `Forbidden` | 403 | `{"error":"Forbidden"}` |
| `NotFound` | 404 | `{"error":"Not found"}` |
| `Conflict` | 409 | `{"error":"Conflict"}` |
| anything else | 500 | `{"error": <message>}`, or the handler's fallback string for a non-`Error` throw; logged with `console.error(route, error)` |

One escape hatch: a thrown object carrying `digest === "HANGING_PROMISE_REJECTION"` is **re-thrown**, not converted, so Next's own signal is not swallowed ([`access.ts:257-264`](../../../src/lib/admissions/access.ts)).

### Two 400 shapes

Validation is Zod `.safeParse()` everywhere, but the family carries two response dialects, split by which phase of the build wrote the file:

- **`{ error: <flatten()> }`** — `cases`, `cases/[caseId]`, `members`, `counselors`, `cohorts`, `audit/[caseId]`; malformed JSON is `{"error":"Invalid JSON body"}`.
- **`{ error: "Invalid request", details: <flatten()> }`** — `tasks`, `colleges`, `events`, `essays`, `activities`, `testing`, `recommenders`, `sections`, `notes`, `meetings`, `calendar`, `announcements`, `resources`, `templates`; malformed JSON is `{"error":"Invalid JSON"}`.

`recommenders` PATCH adds a third, one-off 400 for the CM-46 pairing rule — a bare `{ error: "<sentence>" }` with no `details` ([`recommenders/route.ts:233-242`](../../../src/app/api/admissions/cases/[caseId]/recommenders/route.ts)).

### Optimistic concurrency

Seven write paths accept an optional `expectedUpdatedAt` (an ISO instant matching the row's stored `updatedAt`); a mismatch is a `Conflict` → **409**. `PATCH /api/admissions/cases/[caseId]` is the only one that checks in the route itself and returns a **richer body** — `{ error: "Conflict", expectedUpdatedAt, currentUpdatedAt }` ([`cases/[caseId]/route.ts:93-105`](../../../src/app/api/admissions/cases/[caseId]/route.ts)). The other six (colleges, essays, activities, testing, plus the profile write nested inside the case PATCH) resolve inside their lib transaction and surface the plain `{"error":"Conflict"}`.

### Deletes, audit, caching

Every `DELETE` in the family is a **soft delete** — the row keeps its audit trail — and every one takes its target as a **query parameter**, never a path segment or body. Mutations write an `admissions_audit_log` row inside the same transaction, stamped with the actor email and the *resolved* role (an admin acting on a case is recorded as `admin`, never disguised as the counselor). No handler declares `"use cache"`, `revalidate`, `dynamic`, or `maxDuration`; the only `maxDuration` in scope is `300` on the internal cron route ([`admissions-notifications/route.ts:20`](../../../src/app/api/internal/admissions-notifications/route.ts)).

Statuses **401 / 403 / 500** are reachable on all 61 endpoints and are not repeated per endpoint below; **404** is reachable wherever a guard or lib can throw `NotFound`.

---

## Caseload and case detail

### `GET /api/admissions/cases`

The staff caseload. **Auth:** session + `requireCounselorOrAdmin` — students and parents are members of specific cases, never caseload viewers, so both get 403 ([`cases/route.ts:51-52`](../../../src/app/api/admissions/cases/route.ts)).

**Query:** none. **Response `200`:** `{ cases: AdmissionsCaseSummary[] }` — per row `caseId`, `studentId`, `studentName`, `preferredName`, `cohortId`, `cohortName`, `graduationYear`, `status`, `counselorEmails[]`, `counselorNames[]`, `progressPercent`, `nextDeadline`, `daysSinceLastTouch`, `committedCollegeName`, `updatedAt` ([`types.ts:77-100`](../../../src/lib/admissions/types.ts)). Scoping lives in `getCaseloadForUser`: admins see every case, a counselor sees the cases they hold an active membership on.

### `POST /api/admissions/cases`

Creates a case, its student, its memberships, and its checklist in one audited transaction. **Auth:** session + `requireCounselorOrAdmin`; `createCase` performs no actor re-validation, so this guard is the only gate ([`cases/route.ts:68-70`](../../../src/app/api/admissions/cases/route.ts)).

**Body** — `CreateCaseSchema` ([`cases/route.ts:21-47`](../../../src/app/api/admissions/cases/route.ts)):

| Field | Type | Required |
|---|---|---|
| `student.fullName` | non-empty trimmed string | yes |
| `student.studentEmail` | email | yes |
| `student.preferredName` / `phone` / `school` / `schoolCounselor` / `wiseStudentKey` | nullable string | no |
| `cohortId` | uuid | yes |
| `parentEmails` | email[], max 20 | no — defaults `[]` |
| `counselorEmails` | email[], min 1, max 20 | yes |

A `superRefine` rejects a `parentEmails` entry equal to `student.studentEmail` at the 400 boundary; `createCase` re-checks the same rule (and counselor-vs-family collisions) as `Conflict` ([`cases.ts:192-197`](../../../src/lib/admissions/cases.ts)).

**Response `200`:** `CreateCaseResult` **unwrapped** — `{ caseId, studentId, members, checklist }`, where `checklist` is `{ templateId, templateVersion, taskCount }` and `templateId` is `null` when the cohort has no published template ([`cases.ts:140-145`](../../../src/lib/admissions/cases.ts), [`checklists.ts:556-562`](../../../src/lib/admissions/checklists.ts)).

**Status codes:** 200 · 400 (bad JSON / schema) · 409 (student email also listed as parent, or a counselor email colliding with a family email).

### `GET /api/admissions/cases/[caseId]`

**Auth:** `requireCaseAccess(..., "parent")` — then the handler **rejects an actual parent with 403** `{"error":"Use parent dashboard"}` ([`cases/[caseId]/route.ts:60-62`](../../../src/app/api/admissions/cases/[caseId]/route.ts)). The full detail DTO is a staff/student view; parents are routed to the projection surface instead.

**Response `200`:** `{ case: AdmissionsCaseDetail }` ([`types.ts:150-193`](../../../src/lib/admissions/types.ts)) — the case shell payload: `status`, `statusChangedAt`, `committedListItemId`, `committedCollegeName`, `driveFolder`, `student`, `cohort`, `members`, `collegeList`, `applicationWarnings`, `progress` (`{done,total,percent,verifiedCount}`), `progressPercent`, `nextDeadline`, `upcomingDeadlines`, `announcements`, `essays`, `activities`, `testSittings`, `sections`, `thisWeek`, `phaseProgress`, `lastMeetingDate`, `createdAt`, `updatedAt`.

### `PATCH /api/admissions/cases/[caseId]`

**Auth:** `requireCaseAccess(..., "counselor")`.

**Body** — `UpdateCaseSchema` ([`cases/[caseId]/route.ts:28-52`](../../../src/app/api/admissions/cases/[caseId]/route.ts)): `status` (`active` | `committed` | `completed` | `withdrawn` | `archived`), `driveFolder` (nullable), `student` (partial profile block), `expectedUpdatedAt` (ISO datetime). A `.refine` requires at least one of `status` / `driveFolder` / `student`.

**Order of operations:** the route reads the current detail, compares `expectedUpdatedAt`, then applies profile fields via `updateCaseProfile` (which re-checks the token inside its own transaction) **before** the lifecycle transition via `updateCaseLifecycle` ([`cases/[caseId]/route.ts:107-123`](../../../src/app/api/admissions/cases/[caseId]/route.ts)).

**Response `200`:** `{ case: AdmissionsCaseDetail }`, re-read after the write.

**Status codes:** 200 · 400 · 409 — either the route-level concurrency mismatch (with the richer body above) or an illegal lifecycle transition from `isValidCaseTransition` ([`cases.ts:761-762`](../../../src/lib/admissions/cases.ts)).

---

## Case membership

All three methods run at `counselor`. The single **student** membership is created with the case; `POST` accepts only `parent` and `counselor` ([`members/route.ts:32-36`](../../../src/app/api/admissions/cases/[caseId]/members/route.ts), and `addMember` throws `Conflict` on `role: "student"` at [`members.ts:243`](../../../src/lib/admissions/members.ts)).

- **`GET`** → `{ members: AdmissionsMemberDto[] }`, sourced from `getCaseDetail` so it carries **every** status (`invited` / `active` / `revoked` / `bounced`), oldest first ([`members/route.ts:61-64`](../../../src/app/api/admissions/cases/[caseId]/members/route.ts)). Each row: `id`, `caseId`, `email`, `role`, `status`, `invitedAt`, `activatedAt`, `revokedAt`, `addedByEmail`, `createdAt`, `updatedAt` ([`types.ts:135-148`](../../../src/lib/admissions/types.ts)).
- **`POST`** body `{ email, role: "parent" | "counselor", adminOverride?: boolean }`. `adminOverride` is honored **only when the resolved case role is `admin`** — a counselor sending it is silently downgraded to `false` ([`members/route.ts:92`](../../../src/app/api/admissions/cases/[caseId]/members/route.ts)). For `role: "parent"` the route calls `rejectStudentAsParent` first, then `addMember`. Response `{ member }`.
- **`PATCH`** body is a discriminated union on `action` ([`members/route.ts:38-53`](../../../src/app/api/admissions/cases/[caseId]/members/route.ts)): `revoke` `{memberId}`, `reinvite` `{memberId}`, `change_email` `{memberId, newEmail, adminOverride?}`. Response `{ member }`.

**409 cases** on these two writes ([`members.ts:210,243,250,272,354,434-449,509`](../../../src/lib/admissions/members.ts)): adding the `student` role; adding a parent whose email equals the student's without an admin override; re-adding an email whose existing row is not `revoked`; re-inviting a member whose status is neither `invited` nor `bounced`; revoking or re-mailing an already-revoked row; changing an email to the value it already holds, to the student's address (without override), or to one that collides with another live membership.

---

## Checklist tasks

`GET` runs at `student`; `POST` and the query-param `DELETE` at `counselor`. `PATCH` is the interesting one: the **route** guard is `student`, and each action's real bar is enforced inside the lib from the `CaseAccess` it is handed ([`tasks/route.ts:165-168`](../../../src/app/api/admissions/cases/[caseId]/tasks/route.ts)) — `status` is the one student-allowed mutation, and even then only on a task the student owns (`Conflict` when `row.owner !== "student"`, [`checklists.ts:873`](../../../src/lib/admissions/checklists.ts)).

- **`GET`** → `{ tasks: AdmissionsTaskDto[], progress: { done, total, percent, verifiedCount } }` ([`tasks/route.ts:110-112`](../../../src/app/api/admissions/cases/[caseId]/tasks/route.ts), [`checklists.ts:136-142`](../../../src/lib/admissions/checklists.ts)).
- **`POST`** body — `createTaskSchema` ([`tasks/route.ts:62-70`](../../../src/app/api/admissions/cases/[caseId]/tasks/route.ts)): `title` (required, non-empty), `description`, `owner` (`student` | `counselor` | `parent`), `phase` (the ten canonical phase keys plus `custom`), `dueDate` (`YYYY-MM-DD`), `recurrence` (`{ freq: "weekly" | "biweekly", until: "YYYY-MM-DD" }`, a strict object — [`checklists.ts:81-84`](../../../src/lib/admissions/checklists.ts)), `sortOrder` (coerced int ≥ 0). Response `{ task }`.
- **`PATCH`** body — `patchTaskSchema`, discriminated on `action` ([`tasks/route.ts:72-97`](../../../src/app/api/admissions/cases/[caseId]/tasks/route.ts)): `status` `{taskId, status: not_started|in_progress|done}` → `{ task }`; `verify` `{taskId, verified: boolean}` → `{ task }`; `update` `{taskId, title?, description?, owner?, dueDate?, recurrence?, sortOrder?}` → `{ task }`; `delete` `{taskId}` → `{ ok: true }`.
- **`DELETE`** query `?taskId=<uuid>` (validated by `deleteQuerySchema`, [`tasks/route.ts:99`](../../../src/app/api/admissions/cases/[caseId]/tasks/route.ts)) → `{ ok: true }`.

**409:** deleting a template-derived task on either delete path — `softDeleteTask` refuses any row whose `itemKey` is non-null ([`checklists.ts:1120`](../../../src/lib/admissions/checklists.ts)). **404:** a non-UUID `taskId` reaching the lib.

---

## College list and decision events

### `/api/admissions/cases/[caseId]/colleges`

- **`GET`** (student) → `{ colleges: AdmissionsCollegeListRowDto[] }` — list item + live IPEDS stats + stale flag, each row carrying the CM-46 completeness rollup computed by `computeCollegeCompleteness` and passed in as `completenessMap` ([`colleges/route.ts:110-111`](../../../src/app/api/admissions/cases/[caseId]/colleges/route.ts)).
- **`POST`** (counselor) body is a **union**, not a discriminated union ([`colleges/route.ts:65-77`](../../../src/app/api/admissions/cases/[caseId]/colleges/route.ts)): either `{ unitId: positive int, round, deadline?, category? }` or `{ manual: { instName, country }, round, deadline?, category? }`. When both keys are sent the `unitId` branch wins (Zod strip mode drops the extra payload). `round` ∈ `ed | ed2 | ea | rea | rd | rolling | priority | other`; `category` ∈ `reach | match | safety | unset`. Response `{ college }`.
- **`PATCH`** (counselor) body — `updateCollegeSchema` ([`colleges/route.ts:86-95`](../../../src/app/api/admissions/cases/[caseId]/colleges/route.ts)): `itemId` (uuid, required), `expectedUpdatedAt?`, `round?`, `deadline?`, `appStatus?` (`researching | applying | submitted | complete`), `category?`, `aidOffered?` (string matching `^\d{1,12}(\.\d{1,2})?$`), `aidNotes?`. Omitted fields are untouched; explicit `null` clears a nullable field; a body with no plan fields is a lib-level no-op that echoes the row. Response `{ college }`.
- **`DELETE`** (counselor) query `?itemId=<uuid>` → `{ ok: true }`. The lib clears the case's committed pointer in the same transaction when it referenced the deleted item.

**409:** a duplicate row on the case — same `unitId`, or the same normalized manual name ([`colleges.ts:382`](../../../src/lib/admissions/colleges.ts)) — and an `expectedUpdatedAt` mismatch ([`colleges.ts:500`](../../../src/lib/admissions/colleges.ts)).

### `/api/admissions/cases/[caseId]/colleges/[itemId]/events`

- **`GET`** (student) → `{ events }`, the append-only decision chain oldest first. `listApplicationEvents` is unscoped by design, so the route first pins `itemId` to this case's live rows and returns **404 `{"error":"Not found"}`** when it does not match — cross-case probing cannot read another case's chain ([`events/route.ts:68-73`](../../../src/app/api/admissions/cases/[caseId]/colleges/[itemId]/events/route.ts)).
- **`POST`** (counselor) body is a union on `event` ([`events/route.ts:40-57`](../../../src/app/api/admissions/cases/[caseId]/colleges/[itemId]/events/route.ts)):
  - `{ event: "committed", eventDate }` → routes through `setCommittedCollege`, which moves the case's committed pointer and appends the event in **one** transaction, and responds **`{ committed }`** rather than `{ event }`. This branch takes **no `notes`** — the CM-44 pointer move records none.
  - `{ event: "submitted" | "deferred" | "waitlisted" | "accepted" | "denied" | "withdrawn", eventDate, notes? }` → `addApplicationEvent`, responds `{ event }`.

  `eventDate` is `YYYY-MM-DD` in both branches.

**409:** committing while another item already holds the case's pointer ([`colleges.ts:892`](../../../src/lib/admissions/colleges.ts)), and the guarded-update races at [`colleges.ts:754,907`](../../../src/lib/admissions/colleges.ts).

---

## Essays

`GET`, `POST`, and `PATCH` run at `student` — essays are a self-report surface — while `DELETE` runs at `counselor`, because retiring tracker rows is staff work ([`essays/route.ts:79,95,132,184`](../../../src/app/api/admissions/cases/[caseId]/essays/route.ts)).

- **`GET`** → `{ essays }`, staleness + effective stage, most urgent first.
- **`POST`** body: `prompt` (required, non-empty), `listItemId?` (uuid|null), `deadline?` (`YYYY-MM-DD`|null), `driveUrl?` ([`essays/route.ts:49-54`](../../../src/app/api/admissions/cases/[caseId]/essays/route.ts)). Response `{ essay }`.
- **`PATCH`** body: `essayId` (uuid, required), `expectedUpdatedAt?`, `prompt?`, `status?` (`not_started | brainstorming | drafting | feedback | final`), `driveUrl?`, plus the three **counselor-only** fields `counselorStage?`, `deadline?`, `listItemId?`. The route rejects a below-counselor caller who supplies **any** of those three with a bare `403 {"error":"Forbidden"}` before touching the lib ([`essays/route.ts:152-158`](../../../src/app/api/admissions/cases/[caseId]/essays/route.ts)); the lib re-checks fail-closed. Response `{ essay }`.
- **`DELETE`** query `?essayId=<uuid>` → `{ ok: true }`.

**409:** `expectedUpdatedAt` mismatch ([`essays.ts:369`](../../../src/lib/admissions/essays.ts)).

---

## Activities

Every method runs at `student` — students own the activities master list — so parents get 403 throughout and staff writes simply pass through, attributed by the audit `actorRole` ([`activities/route.ts:92,108,146,191`](../../../src/app/api/admissions/cases/[caseId]/activities/route.ts)).

- **`GET`** → `{ activities }`, ranked rows first.
- **`POST`** body: `name` (required), `fullDescription?`, `commonApp?` / `uc?` (the lib's exported hard-limit block schemas, so char-limit overflow is a 400 here rather than a 500), `sortOrder?` ([`activities/route.ts:40-46`](../../../src/app/api/admissions/cases/[caseId]/activities/route.ts)). Response `{ activity }`.
- **`PATCH`** body is discriminated on `action` ([`activities/route.ts:51-81`](../../../src/app/api/admissions/cases/[caseId]/activities/route.ts)):
  - `update` — `{ activityId, expectedUpdatedAt?, name?, fullDescription?, commonApp?, uc?, sortOrder? }` → `{ activity }`. `commonAppRank` is deliberately **absent**; ranks move only through the other action.
  - `rank` — `{ orderedIds: uuid[] }`, the full ranked selection best-first, capped at `MAX_COMMON_APP_RANKED_ACTIVITIES = 10` ([`shared/activities.ts:19`](../../../src/lib/admissions/shared/activities.ts)) with a `.refine` rejecting duplicates. The lib assigns ranks `1..n` and clears the ranks of every unlisted activity. Response **`{ ok: true }`**, not the rows.
- **`DELETE`** query `?activityId=<uuid>` → `{ ok: true }`.

**409:** creating past the live-row cap `MAX_ACTIVE_ACTIVITIES_PER_CASE = 20` ([`shared/activities.ts:16`](../../../src/lib/admissions/shared/activities.ts), enforced at [`activities.ts:269`](../../../src/lib/admissions/activities.ts)), and an `expectedUpdatedAt` mismatch ([`activities.ts:374`](../../../src/lib/admissions/activities.ts)).

---

## Testing

All four methods run at `student`; parents get 403 on every one ([`testing/route.ts:66,85,122,174`](../../../src/app/api/admissions/cases/[caseId]/testing/route.ts)).

- **`GET`** → `{ sittings, bestScores }`, fetched in parallel.
- **`POST`** body: `testType` (`sat | act | ap | ib | toefl | ielts | other`), `testDate` (`YYYY-MM-DD`), `targetScore?`, `accommodations?` ([`testing/route.ts:38-43`](../../../src/app/api/admissions/cases/[caseId]/testing/route.ts)). Response `{ sitting }`.
- **`PATCH`** body: `sittingId` (uuid), `expectedUpdatedAt?`, `testType?`, `testDate?`, `registrationDeadline?`, `targetScore?`, `actualScore?`, `accommodations?`, `scoreReleasedToParent?` ([`testing/route.ts:45-55`](../../../src/app/api/admissions/cases/[caseId]/testing/route.ts)). **`scoreReleasedToParent` is counselor+ only** (CM-83): a student or parent supplying it gets a bare `403 {"error":"Forbidden"}` before any lib call ([`testing/route.ts:142-147`](../../../src/app/api/admissions/cases/[caseId]/testing/route.ts)), and `updateSitting` re-enforces it. Response `{ sitting }`.
- **`DELETE`** query `?sittingId=<uuid>` → `{ ok: true }`.

Note the asymmetry in the schema: `expectedUpdatedAt` here is a plain `z.string()`, not `z.string().datetime()` as elsewhere. **409:** token mismatch ([`testing.ts:363`](../../../src/lib/admissions/testing.ts)).

---

## Recommenders and college documents

`GET` runs at `student`; `POST` / `PATCH` / `DELETE` at `counselor`.

- **`GET`** → `{ recommenders, collegeDocs }` — recommenders with their per-college submission links, plus the case's college-doc rows ([`recommenders/route.ts:122-124`](../../../src/app/api/admissions/cases/[caseId]/recommenders/route.ts)).
- **`POST`** body `{ name, roleSubject?, contact? }` → `{ recommender }`.
- **`PATCH`** body is discriminated on `action` ([`recommenders/route.ts:57-84`](../../../src/app/api/admissions/cases/[caseId]/recommenders/route.ts)):

| `action` | Body | Response |
|---|---|---|
| `update` | `recommenderId`, `name?`, `roleSubject?`, `contact?`, `askStatus?` (`planned \| asked \| agreed \| declined`) | `{ recommender }` |
| `link` | `recommenderId`, `listItemId` | `{ link }` |
| `submission` | `recommenderId`, `listItemId`, `submitted: boolean` | `{ link }` |
| `college_doc` | `listItemId`, `docType` (`transcript \| school_report \| score_send`), `sent: boolean`, `testSittingId?` | `{ doc }` |

  Two fail-closed pins run before the lib on the id-bearing actions, because `linkRecommenderToCollege` / `setRecommenderSubmission` / `setCollegeDoc` derive the case **from the row**, not the URL: `assertRecommenderInCase` and `assertListItemInCase` throw `NotFound` when the body's id is not one of this case's live rows ([`recommenders/route.ts:98-111`](../../../src/app/api/admissions/cases/[caseId]/recommenders/route.ts)). A foreign id therefore reads as **404**, never a write into another case.

  The `college_doc` branch also enforces the CM-46 pairing rule at the 400 boundary: `score_send` **requires** a `testSittingId`, every other `docType` **forbids** one ([`recommenders/route.ts:231-242`](../../../src/app/api/admissions/cases/[caseId]/recommenders/route.ts)).

- **`DELETE`** query `?recommenderId=<uuid>` → `{ ok: true }`.

**409:** an illegal `askStatus` move — the machine is forward-only, and a same-status write is a no-op rather than a move ([`recommenders.ts:371`](../../../src/lib/admissions/recommenders.ts)) — and a duplicate `(recommenderId, listItemId)` link, caught both by an explicit pre-check and by the unique-violation mapping ([`recommenders.ts:531,557`](../../../src/lib/admissions/recommenders.ts)).

---

## Self-report sections

`sectionKey` is one of six fixed keys — `about_you`, `q_and_a_survey`, `personality`, `random_facts`, `essay_moments`, `majors_reflection` ([`sections.ts:64-71`](../../../src/lib/admissions/sections.ts)). All three methods guard at `student` **first** and only then resolve the key, so an unknown `sectionKey` is a 404 that non-members can never observe ([`sections/[sectionKey]/route.ts:52,66,99`](../../../src/app/api/admissions/cases/[caseId]/sections/[sectionKey]/route.ts)).

- **`GET`** → `{ section: AdmissionsSectionStateDto }` — `caseId`, `sectionKey`, the full `definition`, saved `payload`, `state` (`draft | submitted | reviewed`), `submittedAt`, `reviewedByEmail`, `updatedAt` (null for a virtual empty draft with no row yet) ([`sections.ts:651-664`](../../../src/lib/admissions/sections.ts)).
- **`PUT`** body `{ payload: Record<string, unknown> }` — a **partial** payload; merge semantics and the per-field type/option/maxLength rules live in `saveSectionDraft` / `validateSectionPayload`, fail-closed against the section definition ([`sections/[sectionKey]/route.ts:34-38`](../../../src/app/api/admissions/cases/[caseId]/sections/[sectionKey]/route.ts)). Response `{ section }`.
- **`POST`** body is a discriminated union with exactly two members ([`sections/[sectionKey]/route.ts:40-43`](../../../src/app/api/admissions/cases/[caseId]/sections/[sectionKey]/route.ts)):
  - `{ action: "submit" }` — `draft → submitted`, the only event that notifies the counselor. Response is `SubmitSectionResult` **unwrapped**: `{ section, notify }` ([`sections.ts:998-1006`](../../../src/lib/admissions/sections.ts)).
  - `{ action: "review" }` — `submitted → reviewed`, **counselor+**. A below-counselor caller gets a bare `403 {"error":"Forbidden"}` before any lib call ([`sections/[sectionKey]/route.ts:116-122`](../../../src/app/api/admissions/cases/[caseId]/sections/[sectionKey]/route.ts)); `reviewSection` re-enforces it. Response `{ section }`.

**409:** submitting a section whose row is missing or not in `draft`, and reviewing one not in `submitted` ([`sections.ts:1039,1092`](../../../src/lib/admissions/sections.ts)).

---

## Meetings and notes

### Meetings — `counselor` on **all three** methods

The meeting log is a staff working surface, so even `GET` sits at `counselor`: candid observations must never reach the student or parent surfaces, which see the derived action-item tasks instead ([`meetings/route.ts:59,75,120`](../../../src/app/api/admissions/cases/[caseId]/meetings/route.ts)).

- **`GET`** → `{ meetings: AdmissionsMeetingDto[] }` ([`types.ts:195-206`](../../../src/lib/admissions/types.ts)).
- **`POST`** body: `meetingDate` (`YYYY-MM-DD`, required), `mode?`, `attendees?: string[]`, `notes?`, `nextMeetingDate?`, `actionItems?: { title, owner: student|counselor|parent, dueDate? }[]` ([`meetings/route.ts:34-41`](../../../src/app/api/admissions/cases/[caseId]/meetings/route.ts)). Response is `CreateMeetingResult` **unwrapped** — `{ meeting, createdTaskIds }` ([`meetings.ts:66-69`](../../../src/lib/admissions/meetings.ts)): logging a meeting also **creates checklist tasks** for its action items.
- **`PATCH`** body: `meetingId` (uuid) plus the same optional fields, minus `actionItems` — editing a meeting never re-creates tasks. Response `{ meeting }`.

### Notes — read at `student`, write at `counselor`

- **`GET`** → `{ notes }`, shaped for the reader's per-case role; `listNotesForRole` strips `staff_only` rows for non-staff readers ([`notes/route.ts:45`](../../../src/app/api/admissions/cases/[caseId]/notes/route.ts)).
- **`POST`** body `{ body: non-empty string, visibility: "staff_only" | "shared_with_family" }` — `visibility` is **required with no default**, matching the NOT-NULL-no-default column, so every write carries an explicit audience choice ([`notes/route.ts:21-29`](../../../src/app/api/admissions/cases/[caseId]/notes/route.ts)). Response `{ note }`.
- **`PATCH`** body `{ noteId: uuid, visibility }` → `{ note }`.

---

## Calendar and the parent dashboard

### `GET /api/admissions/cases/[caseId]/calendar`

**Auth:** `requireCaseAccess(..., "student")`, run **before** the query is parsed, so a membership failure never depends on the query string ([`calendar/route.ts:52-54`](../../../src/app/api/admissions/cases/[caseId]/calendar/route.ts)).

**Query** — `calendarQuerySchema` ([`calendar/route.ts:31-45`](../../../src/app/api/admissions/cases/[caseId]/calendar/route.ts)):

| Param | Type | Required | Default |
|---|---|---|---|
| `from` | `YYYY-MM-DD` | **yes** | — |
| `to` | `YYYY-MM-DD` | **yes** | — |
| `limit` | int, 1–`UPCOMING_DEADLINES_MAX_LIMIT` (100) | no | `UPCOMING_DEADLINES_DEFAULT_LIMIT` (5) |

Both bounds are mandatory and a `.refine` requires `from <= to`; a malformed window is a 400, never a guessed one. Constants at [`calendar.ts:55,58`](../../../src/lib/admissions/calendar.ts).

**Response `200`:** `{ items, upcoming }` — `items` are the window's `CalendarItem`s (`id`, `caseId`, `source` ∈ `task | application | essay | testing`, `title`, `date`, `overdue`, `ownerRole`; a testing item's id is suffixed `:registration` or `:sitting`, [`calendar.ts:28-46`](../../../src/lib/admissions/calendar.ts)), and `upcoming` is the open-deadline panel independent of the window.

### `GET /api/admissions/cases/[caseId]/parent-dashboard`

**Auth:** `requireCaseAccess(..., "parent")` — the **floor** of the ordering, so every active member may read: parents get their own surface, students see the same view, and counselors/admins preview exactly what the family sees ([`parent-dashboard/route.ts:32`](../../../src/app/api/admissions/cases/[caseId]/parent-dashboard/route.ts)).

**Response `200`:** `{ dashboard: ParentDashboard }` — `studentName`, `cohortName`, `caseStatus`, `progress`, `phaseProgress`, `collegeList`, `upcomingDeadlines` (≤10, overdue first), `announcements` (≤10, newest first), `testingMilestones`, `sharedNotes` (only `shared_with_family`) ([`parent-projection.ts:147-164`](../../../src/lib/admissions/parent-projection.ts)). The body is `buildParentDashboard`'s DTO and nothing else — it is the only builder of parent-facing payloads, which makes a staff-field leak a structural change rather than an oversight.

---

## Announcements

One route file, four methods, and the scope rule mirrors the `admissions_announcements_target_check` constraint: **exactly one** of `cohortId` or `caseId`, enforced by an XOR `.refine` on both the list query and the create body ([`announcements/route.ts:71-91`](../../../src/app/api/admissions/announcements/route.ts)). Both or neither is a 400 before any access check.

| Method | Scope | Guard |
|---|---|---|
| `GET` | `?caseId=` | `requireCaseAccess(..., "student")` — the family-visible feed, cohort broadcasts merged in by `listAnnouncementsForCase` |
| `GET` | `?cohortId=` | `requireCounselorOrAdmin` — cohort-wide listing is a staff surface |
| `POST` | `caseId` in body | `requireCaseAccess(..., "counselor")` on that case |
| `POST` | `cohortId` in body | `requireCounselorOrAdmin` |
| `PATCH` / `DELETE` | resolved from the **stored** row | `requireCounselorOrAdmin` before body parsing, then `requireAnnouncementMutationAccess` |

`requireAnnouncementMutationAccess` re-anchors rights on the persisted scope rather than any client-supplied id ([`announcements/route.ts:57-67`](../../../src/app/api/admissions/announcements/route.ts)): a case-scoped row additionally demands counselor membership **on that case**, so mutation is never looser than creation, while a cohort broadcast stays at the staff bar. Scope is immutable, so the pre-transaction check cannot race a retarget.

**Bodies:** `POST` `{ cohortId? | caseId?, title, body }` (both trimmed non-empty); `PATCH` `{ announcementId: uuid, title?, body? }` with a `.refine` requiring at least one of the two; `DELETE` takes `?announcementId=<uuid>` and soft-deletes, retaining the row for the audit trail.

**Responses:** `GET` → `{ announcements }`; `POST` / `PATCH` → `{ announcement }`; `DELETE` → `{ ok: true }`.

---

## Resource library

A **global** library with no per-case scope to anchor `requireCaseAccess`, so the read is deliberately open to every admissions role while writes sit at the staff bar ([`resources/route.ts:69,81,115,150`](../../../src/app/api/admissions/resources/route.ts)).

- **`GET`** — `requireAdmissionsSession` only. Response `{ groups: AdmissionsResourceTopicGroup[] }`, grouped by topic.
- **`POST`** — staff. Body `{ topic, title, url, sortOrder? }`. `topic` is validated by `isAdmissionsResourceTopic` (the ten canonical checklist phases plus `general`, [`shared/resources.ts:20-31`](../../../src/lib/admissions/shared/resources.ts)); `url` uses the lib's exported `admissionsResourceUrlSchema`. Response `{ resource }`.
- **`PATCH`** — staff. Body `{ resourceId: uuid, topic?, title?, url?, sortOrder? }` with a `.refine` requiring at least one mutable field. Response `{ resource }`.
- **`DELETE`** — staff. Query `?resourceId=<uuid>`; soft delete. Response `{ ok: true }`.

---

## Cohorts, checklist templates, counselor registry

These three cross-case surfaces have no caseId to anchor, so they use the global guards — and they split the bar between **reading** (staff) and **writing** (admin).

### Cohorts

- **`GET /api/admissions/cohorts`** — `requireCounselorOrAdmin`; students and parents have no cohort-registry view. Response `{ cohorts }`.
- **`POST /api/admissions/cohorts`** — `requireAdmissionsAdmin`. Body `{ name: non-empty, graduationYear: int 2000–2100 }` (coerced, [`cohorts/route.ts:16-19`](../../../src/app/api/admissions/cohorts/route.ts)). Response `{ cohort }`. **409** on a duplicate name, mapped from the unique violation ([`cohorts.ts:76`](../../../src/lib/admissions/cohorts.ts)).

### Checklist templates — `/api/admissions/cohorts/[cohortId]/templates`

- **`GET`** — staff. Response `{ latest, versions }`: the latest version **with** its items (`AdmissionsTemplateDto`, [`checklists.ts:101-112`](../../../src/lib/admissions/checklists.ts)) plus the full version history **without** items (`AdmissionsTemplateVersionDto`, [`checklists.ts:471-480`](../../../src/lib/admissions/checklists.ts)).
- **`POST`** — admin. Body discriminated on `action` ([`templates/route.ts:63-73`](../../../src/app/api/admissions/cohorts/[cohortId]/templates/route.ts)):
  - `create_version` — `{ items: [...], name?, publish? }`, at least one item. Each item carries `itemKey` (snake_case, `^[a-z][a-z0-9_]*$`), `phase` (one of the **ten canonical phases** — `custom` is excluded here, it is task-only), `title`, `description?`, `defaultOwner`, and `sortOrder` ([`templates/route.ts:52-61`](../../../src/app/api/admissions/cohorts/[cohortId]/templates/route.ts)). Writes version `max + 1`; the CM-20 immutability-by-versioning rule means existing versions are never edited in place. Response `{ template }`.
  - `push_new_items` — no other fields. Appends the latest **published** template's missing items to every live case in the cohort, matched by `itemKey`; existing task rows are never mutated or deleted. Response is `PushNewItemsResult` **unwrapped** — `{ templateId, templateVersion, casesUpdated, tasksCreated }` ([`checklists.ts:646-651`](../../../src/lib/admissions/checklists.ts)). **404** when the cohort has no published template.
- **`PATCH`** — admin. Body `{ templateId: uuid }`, publishing that draft. Before the write the route lists this cohort's versions and returns **404 `{"error":"Not found"}`** if the id is not among them — no cross-cohort publishing through the wrong URL ([`templates/route.ts:168-173`](../../../src/app/api/admissions/cohorts/[cohortId]/templates/route.ts)). **409** when the version is already published ([`checklists.ts:405`](../../../src/lib/admissions/checklists.ts)). Response `{ template }`.

### Counselor registry — `/api/admissions/counselors`

All three methods are `requireAdmissionsAdmin`: the registry grants counselor **sign-in capability**, so a removed admin must lose this surface immediately.

- **`GET`** → `{ counselors }` — the full registry, active and inactive ([`types.ts:125-133`](../../../src/lib/admissions/types.ts)).
- **`POST`** body `{ email, name: non-empty, active }` (`active` defaults `true`); upserts by lowercase email, audited transactionally. Response `{ counselor }`.
- **`PATCH`** body is a **union, order-sensitive** ([`counselors/route.ts:24-34`](../../../src/app/api/admissions/counselors/route.ts)): `{ email, name, active }` upserts, `{ email, active: false }` (no `name`) deactivates. The update variant wins when both `name` and `active` are present, and the flag is never guessed. Response `{ counselor }`; **404** when deactivating an unknown email.

---

## Case audit trail

### `GET /api/admissions/audit/[caseId]`

The one endpoint with a **double** admin check ([`audit/[caseId]/route.ts:40-46`](../../../src/app/api/admissions/audit/[caseId]/route.ts)): the JWT-derived `user.role` must already be `admin` (a fast-fail returning a bare `403 {"error":"Forbidden"}`), and then `requireCaseAccess(..., "admin")` re-verifies the `admin_users` row against Postgres on this request. A malformed `caseId` fails closed as 403; a missing or soft-deleted case is 404, since admins may learn existence.

**Query:** `page` (int ≥ 1, default 1) and `pageSize` (int 1–`AUDIT_LOG_MAX_PAGE_SIZE` = 200, default `AUDIT_LOG_DEFAULT_PAGE_SIZE` = 50), both `z.coerce` ([`audit/[caseId]/route.ts:14-22`](../../../src/app/api/admissions/audit/[caseId]/route.ts), constants at [`audit.ts:143,146`](../../../src/lib/admissions/audit.ts)). The bounds exist so a hostile query cannot drive a negative offset or an unbounded scan.

**Response `200`:** `AdmissionsAuditLogPage` **unwrapped** — `{ entries, page, pageSize, totalCount }`, newest first. Each entry is `{ id, caseId, actorEmail, actorRole, entityType, entityId, action, diff, createdAt }`, where `diff` is `Record<string, {old, new}>` or `null` ([`audit.ts:148-167`](../../../src/lib/admissions/audit.ts)). Read-only — the table stays append-only.

---

## Notification cron

### `GET` and `POST /api/internal/admissions-notifications`

One route file covers both cadences. **Auth is `CRON_SECRET`, not a session:** `/api/internal/*` is exempted from the middleware session gate ([`middleware.ts:24`](../../../src/middleware.ts)), and both handlers open with `rejectInvalidCronSecret`, a length-prechecked `timingSafeEqual` against `Bearer ${CRON_SECRET}` — a missing secret is **500 `{"error":"Server misconfigured"}`**, a wrong one **401** ([`cron-auth.ts:6-26`](../../../src/lib/internal/cron-auth.ts)). `export const maxDuration = 300` ([`route.ts:20`](../../../src/app/api/internal/admissions-notifications/route.ts)).

**Schedule:** `"12 1 * * *"` in [`vercel.json`](../../../vercel.json) — 08:12 Bangkok, daily — matched by the Data Health registry entry `admissions_notifications`, which declares `cadenceMinutes: 1440`, `lateAfterMinutes: 60`, `maxDurationSeconds: 300`, `routeMethod: "GET"`, and `dangerous: true` ([`cron-registry.ts:322-337`](../../../src/lib/data-health/cron-registry.ts)). Full cron table: [docs/reference/crons.md](../crons.md).

**Request:** the only parameter is `runType` ∈ `daily | weekly`, optional — from the **query string** on `GET` and from an **optional JSON body** on `POST` ([`route.ts:22-24,77-79,105`](../../../src/app/api/internal/admissions-notifications/route.ts)). `POST` reads the body with `request.text()` and treats an empty body as `{}`, so a bodyless POST is valid; malformed JSON is `400 {"error":"Invalid JSON body"}`, and an out-of-enum value is `400 {"error":"Invalid runType", details}`.

**Dispatch** ([`route.ts:42-70`](../../../src/app/api/internal/admissions-notifications/route.ts)):

| `runType` | What runs |
|---|---|
| `"daily"` | `runDailyNotifications` only |
| `"weekly"` | `runWeeklyDigest` only |
| absent (the Vercel cron case) | `runDailyNotifications` always, **plus** `runWeeklyDigest` when the invocation instant is a Sunday in the Asia/Bangkok calendar (`isBangkokSunday`, [`route.ts:29-31`](../../../src/app/api/internal/admissions-notifications/route.ts)) |

**Side effects:** each orchestrator claims a single-flight row in `admissions_notification_runs`, sweeps stale `running` rows, plans reminders, and **sends email per recipient**, isolating per-recipient failures into `errorSummary` rather than aborting the run (`runDailyNotifications` at [`notifications.ts:969`](../../../src/lib/admissions/notifications.ts), `runWeeklyDigest` at [`:1024`](../../../src/lib/admissions/notifications.ts)). A run already in flight and less than 30 minutes old returns `{ skipped: true, runId: null }` instead of starting a second pass ([`notifications.ts:943-952`](../../../src/lib/admissions/notifications.ts)). The whole call is wrapped in `withCronInvocationAudit({ jobKey: "admissions_notifications", triggerSource: "cron" })`, so every invocation lands in `cron_invocations` regardless of outcome.

**Response:** `{ ok: true, skipped, results }`, where each result is `{ skipped, runId, runType, sentCount, skippedCount, errorSummary }` ([`notifications.ts:187-195`](../../../src/lib/admissions/notifications.ts)).

**Status codes:**

| Code | Condition |
|---|---|
| 200 | At least one pass actually ran. |
| **202** | **Every** pass was skipped by the single-flight guard — `skipped: true` ([`route.ts:62-63`](../../../src/app/api/internal/admissions-notifications/route.ts)). |
| 400 | Malformed JSON body (POST) or an out-of-enum `runType`. |
| 401 | Wrong or absent `Authorization: Bearer <CRON_SECRET>`. |
| 500 | `CRON_SECRET` unset (`Server misconfigured`), or a top-level orchestrator crash. |

---

## Tests

**23 test files** cover this surface: 22 under `src/app/api/admissions/**/__tests__/` plus [`src/app/api/internal/admissions-notifications/__tests__/route.test.ts`](../../../src/app/api/internal/admissions-notifications/__tests__/route.test.ts). Coverage is complete at the route level — all 21 `/api/admissions` route files have a sibling `route.test.ts`, and the cron route has its own.

The 22nd admissions file is cross-cutting rather than per-route: [`src/app/api/admissions/__tests__/parent-access-matrix.test.ts`](../../../src/app/api/admissions/__tests__/parent-access-matrix.test.ts) asserts the parent-role outcome across the whole family in one place, which is why the parent 403s described above hold uniformly instead of being a per-handler convention. Domain-level coverage — access resolution, projections, notifications — lives in the 21 files under [`src/lib/admissions/__tests__/`](../../../src/lib/admissions/__tests__).

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
