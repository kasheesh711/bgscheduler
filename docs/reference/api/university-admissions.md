# University Admissions API

HTTP reference for the University Admissions case-management endpoints: 22 session-gated routes under `/api/admissions/**` plus the `CRON_SECRET`-protected notification cron at `/api/internal/admissions-notifications`. Feature meaning (case lifecycle, checklist model, parent projection, notification tiers) lives in the design docs ([`docs/casemanagementsystem_design.md`](../../casemanagementsystem_design.md), [`docs/Casemanagementsystem_prd.md`](../../Casemanagementsystem_prd.md)); this page owns only the mechanical HTTP contracts, verified against the route handlers in `src/app/api/admissions/**/route.ts`.

## Shared conventions

**Session guard.** Every `/api/admissions/**` handler first calls `requireAdmissionsSession()` (`src/lib/admissions/access.ts:76-97`): it reads the Auth.js session, requires an email and name (`401` otherwise), requires that the user's `allowedPages` grant `/admissions` (`403`), and maps the JWT role claim to one of `counselor | student | parent | admin` (an absent role = legacy full-access admin → `admin`; any other value, e.g. `teacher`, → `403`, fail-closed). The JWT role shapes navigation and the claim-level gates noted below; **per-case rights are never taken from the JWT**.

**Per-case guard.** Case-scoped routes then call `requireCaseAccess(email, caseId, minRole)` (`access.ts:117-172`), which re-resolves membership from Postgres on **every** request: a malformed `caseId` → `403` before any query; an `admin_users` row bypasses membership (a missing/soft-deleted case is `404` for admins — they may learn existence); non-admins need an **active** `admissions_case_members` row for that case (a missing case or membership is `403`, never `404`, so case existence does not leak); counselor memberships additionally require an **active** `admissions_counselors` registry row; finally `minRole` is enforced under the ordering `parent < student < counselor < admin` (`src/lib/admissions/config.ts:16-31`). The "Min role" noted per endpoint below is this `minRole` argument.

**Staff guard.** Cross-case staff surfaces (cohort announcements, resource writes) call `requireCounselorOrAdmin(email)` (`access.ts:196-219`): an `admin_users` row → admin, else an active `admissions_counselors` registry row → counselor, else `403` — also resolved from Postgres per request.

**Errors.** All handlers funnel failures through `admissionsErrorResponse(route, error, fallback)` (`access.ts:227-258`): `Error("Unauthorized")` → `401`, `Error("Forbidden")` → `403`, `Error("NotFound")` → `404 { "error": "Not found" }`, `Error("Conflict")` → `409`, anything else → `console.error` + `500` with the error message. Malformed JSON bodies → `400 { "error": "Invalid JSON" }` (some routes say `"Invalid JSON body"`); Zod `safeParse` failures → `400` with the flattened issues (either `{ "error": <flatten> }` or `{ "error": "Invalid request", "details": <flatten> }`, per route).

**Ordering.** `requireCaseAccess` runs **before** body/query parsing on every case-scoped method, so membership/role failures never depend on the request payload.

**Optimistic concurrency.** Mutations that accept `expectedUpdatedAt` (case PATCH, colleges PATCH, essays PATCH, activities "update", testing PATCH) compare it against the row's current `updatedAt`; a stale token returns `409` (the case PATCH additionally echoes `expectedUpdatedAt` and `currentUpdatedAt`).

**Audit.** Every write is recorded in the append-only `admissions_audit_log` via `writeAuditLog` / `withAuditedTransaction` (`src/lib/admissions/audit.ts`), attributed to the resolved actor email and role.

**Timestamps.** DTO timestamps are ISO-8601 strings; date-only fields are `"YYYY-MM-DD"` (Asia/Bangkok calendar).

### Endpoint summary

| Method | Path | Min role | Purpose |
|---|---|---|---|
| GET | `/api/admissions/cases` | counselor (claim) | Caseload for the signed-in staff user |
| POST | `/api/admissions/cases` | counselor (claim) | Create a case (student + members + checklist) |
| GET | `/api/admissions/cases/[caseId]` | student (parents 403) | Full case detail |
| PATCH | `/api/admissions/cases/[caseId]` | counselor | Update lifecycle status / profile fields |
| GET | `/api/admissions/cases/[caseId]/members` | counselor | List all memberships (every status) |
| POST | `/api/admissions/cases/[caseId]/members` | counselor | Add a parent/counselor member |
| PATCH | `/api/admissions/cases/[caseId]/members` | counselor | Revoke / re-invite / change email |
| GET | `/api/admissions/cases/[caseId]/tasks` | student | Checklist tasks + progress |
| POST | `/api/admissions/cases/[caseId]/tasks` | counselor | Create a custom task |
| PATCH | `/api/admissions/cases/[caseId]/tasks` | student (per action) | status / verify / update / delete actions |
| DELETE | `/api/admissions/cases/[caseId]/tasks?taskId=` | counselor | Soft-delete a custom task |
| GET | `/api/admissions/cases/[caseId]/meetings` | student | List meeting log |
| POST | `/api/admissions/cases/[caseId]/meetings` | counselor | Log a meeting + action-item tasks |
| PATCH | `/api/admissions/cases/[caseId]/meetings` | counselor | Edit a meeting |
| GET | `/api/admissions/cases/[caseId]/colleges` | student | College list rows + IPEDS stats + completeness |
| POST | `/api/admissions/cases/[caseId]/colleges` | counselor | Add a college (IPEDS `unitId` or manual) |
| PATCH | `/api/admissions/cases/[caseId]/colleges` | counselor | Update plan fields (round/deadline/status/category/aid) |
| DELETE | `/api/admissions/cases/[caseId]/colleges?itemId=` | counselor | Soft-delete a list item |
| GET | `/api/admissions/cases/[caseId]/colleges/[itemId]/events` | student | Decision-event chain for one item |
| POST | `/api/admissions/cases/[caseId]/colleges/[itemId]/events` | counselor | Append a decision event (`committed` moves the pointer) |
| GET | `/api/admissions/cases/[caseId]/recommenders` | student | Recommenders + college-doc rows |
| POST | `/api/admissions/cases/[caseId]/recommenders` | counselor | Create a recommender |
| PATCH | `/api/admissions/cases/[caseId]/recommenders` | counselor | update / link / submission / college_doc actions |
| DELETE | `/api/admissions/cases/[caseId]/recommenders?recommenderId=` | counselor | Soft-delete a recommender |
| GET | `/api/admissions/cases/[caseId]/essays` | student | Essay tracker rows |
| POST | `/api/admissions/cases/[caseId]/essays` | student | Add an essay row |
| PATCH | `/api/admissions/cases/[caseId]/essays` | student (staff fields counselor) | Update an essay |
| DELETE | `/api/admissions/cases/[caseId]/essays?essayId=` | counselor | Soft-delete an essay |
| GET | `/api/admissions/cases/[caseId]/activities` | student | Activities list, ranked first |
| POST | `/api/admissions/cases/[caseId]/activities` | student | Add an activity |
| PATCH | `/api/admissions/cases/[caseId]/activities` | student | update / rank (Common App top-10) actions |
| DELETE | `/api/admissions/cases/[caseId]/activities?activityId=` | student | Soft-delete an activity |
| GET | `/api/admissions/cases/[caseId]/testing` | student | Test sittings + best scores |
| POST | `/api/admissions/cases/[caseId]/testing` | student | Add a sitting |
| PATCH | `/api/admissions/cases/[caseId]/testing` | student (`scoreReleasedToParent` counselor) | Update a sitting |
| DELETE | `/api/admissions/cases/[caseId]/testing?sittingId=` | student | Soft-delete a sitting |
| GET | `/api/admissions/cases/[caseId]/calendar` | student | Dated items for a window + upcoming deadlines |
| GET | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | student | Self-report section state |
| PUT | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | student | Autosave a partial draft payload |
| POST | `/api/admissions/cases/[caseId]/sections/[sectionKey]` | student (`review` counselor) | submit / review state machine |
| GET | `/api/admissions/cases/[caseId]/parent-dashboard` | parent | Closed parent projection |
| GET | `/api/admissions/cases/[caseId]/notes` | student | Notes shaped for the reader's role |
| POST | `/api/admissions/cases/[caseId]/notes` | counselor | Create a note (explicit visibility) |
| PATCH | `/api/admissions/cases/[caseId]/notes` | counselor | Change a note's visibility |
| GET | `/api/admissions/announcements` | student (case) / staff (cohort) | List announcements for one target |
| POST | `/api/admissions/announcements` | counselor (case) / staff (cohort) | Create an announcement |
| PATCH | `/api/admissions/announcements` | staff | Edit an announcement |
| DELETE | `/api/admissions/announcements?announcementId=` | staff | Soft-delete an announcement |
| GET | `/api/admissions/resources` | any admissions role | Resource library, grouped by topic |
| POST | `/api/admissions/resources` | staff | Create a resource |
| PATCH | `/api/admissions/resources` | staff | Update a resource |
| DELETE | `/api/admissions/resources?resourceId=` | staff | Soft-delete a resource |
| GET | `/api/admissions/cohorts` | counselor (claim) | List cohorts |
| POST | `/api/admissions/cohorts` | admin (claim) | Create a cohort |
| GET | `/api/admissions/cohorts/[cohortId]/templates` | counselor (claim) | Latest checklist template + version history |
| POST | `/api/admissions/cohorts/[cohortId]/templates` | admin (claim) | create_version / push_new_items actions |
| PATCH | `/api/admissions/cohorts/[cohortId]/templates` | admin (claim) | Publish a draft template version |
| GET | `/api/admissions/counselors` | admin (claim) | Counselor registry (active + inactive) |
| POST | `/api/admissions/counselors` | admin (claim) | Upsert a counselor registry row |
| PATCH | `/api/admissions/counselors` | admin (claim) | Update or deactivate a registry row |
| GET | `/api/admissions/audit/[caseId]` | admin | One page of a case's audit trail |
| GET | `/api/internal/admissions-notifications` | cron (`CRON_SECRET`) | Daily reminder scan (+ Sunday weekly digest) |
| POST | `/api/internal/admissions-notifications` | cron (`CRON_SECRET`) | Manual trigger with optional `runType` |

"(claim)" marks gates enforced on the JWT role claim from `requireAdmissionsSession` (no case to anchor); "staff" marks `requireCounselorOrAdmin`; everything else is the `requireCaseAccess` `minRole`.

---

## Caseload & cases

### `GET /api/admissions/cases`

Caseload rows for the signed-in staff user (admin = all cases; counselor = own active memberships, via `getCaseloadForUser`).

- **Auth:** session; JWT role must be `counselor` or `admin` (students/parents → `403`).
- **Response:** `{ "cases": AdmissionsCaseSummary[] }` — each row carries `caseId`, `studentId`, `studentName`, `preferredName`, cohort id/name/`graduationYear`, `status`, `counselorEmails`/`counselorNames`, `progressPercent`, `nextDeadline`, `daysSinceLastTouch`, `committedCollegeName`, `updatedAt`.
- **Errors:** `401`, `403`, `500`.

### `POST /api/admissions/cases`

Creates a case with its student, memberships, and instantiated checklist in one audited transaction.

- **Auth:** session; JWT role `counselor` or `admin`.
- **Request body:** `{ student: { fullName, studentEmail, preferredName?, phone?, school?, schoolCounselor?, wiseStudentKey? }, cohortId: uuid, parentEmails?: email[] (≤20, default []), counselorEmails: email[] (1–20) }`. A parent email equal to the student email is a Zod-level `400`.
- **Response:** `{ caseId, studentId, members: AdmissionsMemberDto[], checklist: InstantiateChecklistResult }` (`CreateCaseResult`).
- **Behavior:** links or inserts the `admissions_students` row; seeds + publishes the default checklist template when the cohort has none; inserts the case as `active`; memberships (student/parents `invited`, counselors `active`); instantiates the cohort's latest published checklist.
- **Errors:** `400`, `401`, `403`, `404` (missing cohort), `409` (student already has a live case; member overlap), `500`.

### `GET /api/admissions/cases/[caseId]`

Full case detail for the case shell (staff/student view).

- **Auth:** `requireCaseAccess` min role `parent`, but a resolved `parent` role receives `403 { "error": "Use parent dashboard" }` — the detail DTO is a staff/student surface.
- **Response:** `{ "case": AdmissionsCaseDetail }` — status/lifecycle fields, `student`, `cohort`, `members`, `collegeList` (rows + live IPEDS stats + completeness), `applicationWarnings`, `progress`/`progressPercent`, `nextDeadline`, `upcomingDeadlines`, `announcements` (≤5), `essays`, `activities`, `testSittings`, `sections`, `thisWeek`, `phaseProgress`, `lastMeetingDate`, timestamps (`src/lib/admissions/types.ts:150-192`).
- **Errors:** `401`, `403`, `404` (admin only), `500`.

### `PATCH /api/admissions/cases/[caseId]`

Updates lifecycle status and/or profile fields (drive folder, student fields).

- **Auth:** `requireCaseAccess` min role `counselor`.
- **Request body:** at least one of `status` (`active|committed|completed|withdrawn|archived`), `driveFolder` (nullable), `student` (partial: `fullName?`, `preferredName?`, `phone?`, `school?`, `schoolCounselor?`, `wiseStudentKey?`); optional `expectedUpdatedAt` (ISO datetime).
- **Response:** `{ "case": AdmissionsCaseDetail }` (re-read after the writes).
- **Behavior:** profile fields via `updateCaseProfile` (re-checks the concurrency token inside its transaction), then `updateCaseLifecycle` for a status transition (illegal transitions → `409`).
- **Errors:** `400`, `401`, `403`, `404`, `409` (stale `expectedUpdatedAt`, echoing `expectedUpdatedAt` + `currentUpdatedAt`; or an invalid lifecycle transition), `500`.

## Members

### `GET /api/admissions/cases/[caseId]/members`

- **Auth:** min role `counselor`.
- **Response:** `{ "members": AdmissionsMemberDto[] }` — every status (`invited|active|revoked|bounced`), oldest first.

### `POST /api/admissions/cases/[caseId]/members`

- **Auth:** min role `counselor`.
- **Request body:** `{ email, role: "parent" | "counselor", adminOverride?: boolean }`. `adminOverride` (student-as-parent escape hatch) is honored only when the resolved access role is `admin`.
- **Response:** `{ "member": AdmissionsMemberDto }`. New members are `invited`; the invite email is fired by the lib.
- **Errors:** `400`, `401`, `403`, `409` (duplicate membership; student email as parent without override), `500`.

### `PATCH /api/admissions/cases/[caseId]/members`

Discriminated union on `action`:

- `{ action: "revoke", memberId }` — revoke a membership (instant, next request 403s).
- `{ action: "reinvite", memberId }` — re-invite (resends the invite email).
- `{ action: "change_email", memberId, newEmail, adminOverride? }` — change the member's email.

- **Auth:** min role `counselor`.
- **Response:** `{ "member": AdmissionsMemberDto }`.
- **Errors:** `400`, `401`, `403`, `404`, `409`, `500`.

## Checklist tasks & templates

### `GET /api/admissions/cases/[caseId]/tasks`

- **Auth:** min role `student` (parents → `403`; they see tasks only via the parent projection).
- **Response:** `{ "tasks": AdmissionsTaskDto[], "progress": AdmissionsChecklistProgress }` (done/total/percent/verifiedCount).

### `POST /api/admissions/cases/[caseId]/tasks`

- **Auth:** min role `counselor`.
- **Request body:** `{ title, description?, owner: "student"|"counselor"|"parent", phase?, dueDate? ("YYYY-MM-DD"), recurrence?, sortOrder? }`. `phase` is one of the ten canonical phases or `"custom"`.
- **Response:** `{ "task": AdmissionsTaskDto }`.

### `PATCH /api/admissions/cases/[caseId]/tasks`

Discriminated union on `action`; the route gate is min role `student`, and the lib enforces the per-action bar from the passed `CaseAccess`:

- `{ action: "status", taskId, status: "not_started"|"in_progress"|"done" }` — the one student-allowed mutation (students may tick only student-owned tasks; the lib enforces this).
- `{ action: "verify", taskId, verified: boolean }` — counselor+ (lib-enforced → `403`).
- `{ action: "update", taskId, title?, description?, owner?, dueDate?, recurrence?, sortOrder? }` — counselor+ (lib-enforced).
- `{ action: "delete", taskId }` — counselor+ (lib-enforced); template-derived tasks → `409`.

- **Response:** `{ "task": AdmissionsTaskDto }` (`{ "ok": true }` for delete).
- **Errors:** `400`, `401`, `403`, `404`, `409`, `500`.

### `DELETE /api/admissions/cases/[caseId]/tasks?taskId=<uuid>`

- **Auth:** min role `counselor`. Soft-deletes a custom task; template-derived tasks → `409`.
- **Response:** `{ "ok": true }`.

### `GET /api/admissions/cohorts/[cohortId]/templates`

- **Auth:** session; JWT role `counselor`+ (`roleAtLeast`).
- **Response:** `{ "latest": AdmissionsTemplateDto | null, "versions": AdmissionsTemplateVersionDto[] }` — the latest version with items plus the full version history.

### `POST /api/admissions/cohorts/[cohortId]/templates`

Admin only (JWT role). Discriminated union on `action`:

- `{ action: "create_version", items: TemplateItem[] (≥1), name?, publish? }` — adds version `max + 1` (immutability by versioning). Each item: `{ itemKey (snake_case), phase (canonical, no "custom"), title, description?, defaultOwner, sortOrder }`.
- `{ action: "push_new_items" }` — appends the latest published template's missing items to every live case in the cohort.

- **Response:** `{ "template": AdmissionsTemplateDto }` for `create_version`; a `PushNewItemsResult` summary for `push_new_items`.
- **Errors:** `400`, `401`, `403`, `404`, `409`, `500`.

### `PATCH /api/admissions/cohorts/[cohortId]/templates`

- **Auth:** admin only (JWT role).
- **Request body:** `{ templateId: uuid }`. The version must belong to this cohort (fail-closed → `404`).
- **Response:** `{ "template": AdmissionsTemplateDto }`. Publishing an already-published version → `409`.

## Meetings

### `GET /api/admissions/cases/[caseId]/meetings`

- **Auth:** min role `student`. **Response:** `{ "meetings": AdmissionsMeetingDto[] }`.

### `POST /api/admissions/cases/[caseId]/meetings`

- **Auth:** min role `counselor`.
- **Request body:** `{ meetingDate ("YYYY-MM-DD"), mode?, attendees?: string[], notes?, nextMeetingDate?, actionItems?: [{ title, owner, dueDate? }] }`.
- **Response:** `{ "meeting": AdmissionsMeetingDto, "createdTaskIds": string[] }` (`CreateMeetingResult`) — action items become checklist tasks in the `custom` phase.

### `PATCH /api/admissions/cases/[caseId]/meetings`

- **Auth:** min role `counselor`.
- **Request body:** `{ meetingId: uuid, meetingDate?, mode?, attendees?, notes?, nextMeetingDate? }`.
- **Response:** `{ "meeting": AdmissionsMeetingDto }`.

## College list & decisions

### `GET /api/admissions/cases/[caseId]/colleges`

- **Auth:** min role `student`.
- **Response:** `{ "colleges": AdmissionsCollegeListRowDto[] }` — list item fields (`unitId`/`instName`/`city`/`stateAbbr`/`country`/`isManual`/`round`/`deadline`/`appStatus`/`category`/`aidOffered`/`aidNotes`) plus live IPEDS stats, a stale flag, latest decision events, and the per-college completeness rollup; deadline ascending.

### `POST /api/admissions/cases/[caseId]/colleges`

- **Auth:** min role `counselor`.
- **Request body (union):** either `{ unitId: positive int, round, deadline?, category? }` (IPEDS-backed) or `{ manual: { instName, country }, round, deadline?, category? }` (non-US/unlisted). `round` ∈ `ed|ed2|ea|rea|rd|rolling|priority|other`; `category` ∈ `reach|match|safety|unset`.
- **Response:** `{ "college": AdmissionsCollegeListRowDto }`.
- **Errors:** `400`, `401`, `403`, `404` (unknown `unitId`), `409` (duplicate row on the case), `500`.

### `PATCH /api/admissions/cases/[caseId]/colleges`

- **Auth:** min role `counselor`.
- **Request body:** `{ itemId: uuid, expectedUpdatedAt?, round?, deadline?, appStatus?, category?, aidOffered? (decimal string, ≤2 dp), aidNotes? }`. Omitted fields untouched; explicit nulls clear nullable fields.
- **Response:** `{ "college": AdmissionsCollegeListRowDto }`. Stale token → `409`.

### `DELETE /api/admissions/cases/[caseId]/colleges?itemId=<uuid>`

- **Auth:** min role `counselor`. Soft delete; clears the case's committed pointer in the same transaction when it referenced the item.
- **Response:** `{ "ok": true }`.

### `GET /api/admissions/cases/[caseId]/colleges/[itemId]/events`

- **Auth:** min role `student`. The `itemId` is scoped to the case first (a foreign or unknown id → `404`).
- **Response:** `{ "events": AdmissionsApplicationEventDto[] }` — append-only decision chain, oldest first.

### `POST /api/admissions/cases/[caseId]/colleges/[itemId]/events`

- **Auth:** min role `counselor`.
- **Request body (union):** `{ event: "committed", eventDate }` or `{ event: "submitted"|"deferred"|"waitlisted"|"accepted"|"denied"|"withdrawn", eventDate, notes? }`.
- **Response:** `{ "event": AdmissionsApplicationEventDto }` for normal events. A `committed` event routes through `setCommittedCollege` — the pointer move and event append commit in one transaction — and responds `{ "committed": { caseId, committedListItemId, updatedAt } }` instead.
- **Errors:** `400`, `401`, `403`, `404`, `409` (a second commit while another item holds the pointer), `500`.

## Recommenders & college docs

### `GET /api/admissions/cases/[caseId]/recommenders`

- **Auth:** min role `student`.
- **Response:** `{ "recommenders": AdmissionsRecommenderWithCollegesDto[], "collegeDocs": AdmissionsCollegeDocDto[] }`.

### `POST /api/admissions/cases/[caseId]/recommenders`

- **Auth:** min role `counselor`.
- **Request body:** `{ name, roleSubject?, contact? }`.
- **Response:** `{ "recommender": AdmissionsRecommenderDto }` (askStatus starts `planned`).

### `PATCH /api/admissions/cases/[caseId]/recommenders`

Min role `counselor`. Discriminated union on `action`; body ids are pinned to the URL's case first (foreign ids → `404`, never a cross-case write):

- `{ action: "update", recommenderId, name?, roleSubject?, contact?, askStatus? }` — the ask-status machine is forward-only (`planned → asked → agreed | declined`); an illegal move → `409`.
- `{ action: "link", recommenderId, listItemId }` — link recommender ↔ college; duplicate → `409`. Responds `{ "link": AdmissionsRecommenderCollegeDto }`.
- `{ action: "submission", recommenderId, listItemId, submitted: boolean }` — per-college pending/submitted. Responds `{ "link": ... }`.
- `{ action: "college_doc", listItemId, docType: "transcript"|"school_report"|"score_send", sent: boolean, testSittingId? }` — `score_send` **requires** `testSittingId`; the other doc types forbid it (`400`). Responds `{ "doc": AdmissionsCollegeDocDto }`.

### `DELETE /api/admissions/cases/[caseId]/recommenders?recommenderId=<uuid>`

- **Auth:** min role `counselor`. Soft delete. **Response:** `{ "ok": true }`.

## Essays

### `GET /api/admissions/cases/[caseId]/essays`

- **Auth:** min role `student`. **Response:** `{ "essays": AdmissionsEssayListRowDto[] }` — staleness + effective stage, most urgent first.

### `POST /api/admissions/cases/[caseId]/essays`

- **Auth:** min role `student` (self-report surface; staff creations are attributed via audit).
- **Request body:** `{ prompt, listItemId?, deadline?, driveUrl? }`.
- **Response:** `{ "essay": AdmissionsEssayListRowDto }`.

### `PATCH /api/admissions/cases/[caseId]/essays`

- **Auth:** min role `student`, with a per-field split: `prompt`/`status`/`driveUrl` are student-writable; `counselorStage`/`deadline`/`listItemId` require counselor+ (a student sending one → `403` before any lib call).
- **Request body:** `{ essayId: uuid, expectedUpdatedAt?, prompt?, status?, driveUrl?, counselorStage?, deadline?, listItemId? }`. `status`/`counselorStage` ∈ `not_started|brainstorming|drafting|feedback|final`.
- **Response:** `{ "essay": AdmissionsEssayListRowDto }`. Stale token → `409`.

### `DELETE /api/admissions/cases/[caseId]/essays?essayId=<uuid>`

- **Auth:** min role `counselor`. Soft delete. **Response:** `{ "ok": true }`.

## Activities

### `GET /api/admissions/cases/[caseId]/activities`

- **Auth:** min role `student`. **Response:** `{ "activities": AdmissionsActivityDto[] }`, ranked rows first.

### `POST /api/admissions/cases/[caseId]/activities`

- **Auth:** min role `student` (students own the master list).
- **Request body:** `{ name, fullDescription?, commonApp?, uc?, sortOrder? }` — the `commonApp`/`uc` platform blocks reuse the lib's hard char-limit Zod schemas.
- **Response:** `{ "activity": AdmissionsActivityDto }`. The live-row cap → `409` from the lib.

### `PATCH /api/admissions/cases/[caseId]/activities`

Min role `student`. Discriminated union on `action`:

- `{ action: "update", activityId, expectedUpdatedAt?, name?, fullDescription?, commonApp?, uc?, sortOrder? }` — `commonAppRank` is deliberately not updatable here. Responds `{ "activity": ... }`; stale token → `409`.
- `{ action: "rank", orderedIds: uuid[] (≤10, unique) }` — persists the Common App top-10 order (ranks 1..n; unlisted activities are cleared). Responds `{ "ok": true }`.

### `DELETE /api/admissions/cases/[caseId]/activities?activityId=<uuid>`

- **Auth:** min role `student`. Soft delete. **Response:** `{ "ok": true }`.

## Testing

### `GET /api/admissions/cases/[caseId]/testing`

- **Auth:** min role `student`. **Response:** `{ "sittings": AdmissionsTestSittingDto[], "bestScores": AdmissionsBestScore[] }`.

### `POST /api/admissions/cases/[caseId]/testing`

- **Auth:** min role `student`.
- **Request body:** `{ testType: "sat"|"act"|"ap"|"ib"|"toefl"|"ielts"|"other", testDate ("YYYY-MM-DD"), targetScore?, accommodations? }`.
- **Response:** `{ "sitting": AdmissionsTestSittingDto }`.

### `PATCH /api/admissions/cases/[caseId]/testing`

- **Auth:** min role `student`; `scoreReleasedToParent` is counselor-only, enforced per-field in the handler (`403`) and again fail-closed in the lib.
- **Request body:** `{ sittingId: uuid, expectedUpdatedAt?, testType?, testDate?, registrationDeadline?, targetScore?, actualScore?, accommodations?, scoreReleasedToParent? }`.
- **Response:** `{ "sitting": AdmissionsTestSittingDto }`. Stale token → `409`.

### `DELETE /api/admissions/cases/[caseId]/testing?sittingId=<uuid>`

- **Auth:** min role `student`. **Response:** `{ "ok": true }`.

## Calendar

### `GET /api/admissions/cases/[caseId]/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=`

- **Auth:** min role `student`.
- **Query:** `from` and `to` are required, date-only, `from <= to` (else `400` — never a guessed window); `limit` is coerced, 1–100, default 5 (upcoming-deadlines panel size).
- **Response:** `{ "items": CalendarItem[], "upcoming": CalendarItem[] }` — dated tasks, application deadlines, essay deadlines, and testing dates for the inclusive window, plus the open upcoming-deadlines list.

## Self-report sections

All methods: min role `student`; an unknown `sectionKey` is `404` only after the membership check passes (section keys never leak to non-members).

### `GET /api/admissions/cases/[caseId]/sections/[sectionKey]`

- **Response:** `{ "section": AdmissionsSectionStateDto }` — `definition` (steps + fields), saved `payload` (`{}` for a never-saved section), `state` (`draft|submitted|reviewed`), `submittedAt`, `reviewedByEmail`, `updatedAt`.

### `PUT /api/admissions/cases/[caseId]/sections/[sectionKey]`

- **Request body:** `{ payload: Record<string, unknown> }` — a **partial** payload merged into the draft; per-field type/option/maxLength rules are validated fail-closed against the section definition in the lib.
- **Response:** `{ "section": AdmissionsSectionStateDto }`.

### `POST /api/admissions/cases/[caseId]/sections/[sectionKey]`

Discriminated union on `action`:

- `{ action: "submit" }` — draft → submitted (student bar; the only notify event). Responds `{ "section": AdmissionsSectionStateDto, "notify": true }`. A never-saved or already-submitted/reviewed section → `409`.
- `{ action: "review" }` — submitted → reviewed; counselor+ only (a student attempt → `403` before any lib call). Responds `{ "section": ... }`.

## Parent dashboard

### `GET /api/admissions/cases/[caseId]/parent-dashboard`

- **Auth:** min role `parent` — the floor of the ordering, so **every** active member may read (parents get their surface; counselors/admins preview exactly what the family sees). Strangers/revoked members still `403`.
- **Response:** `{ "dashboard": ParentDashboard }` — built exclusively by `buildParentDashboard` (`src/lib/admissions/parent-projection.ts`), the only builder of parent-facing payloads: progress summary, phase progress, college list entries, deadlines (≤10), announcements (≤10), testing milestones (parent-released scores only), shared-with-family notes.

## Notes

### `GET /api/admissions/cases/[caseId]/notes`

- **Auth:** min role `student`. **Response:** `{ "notes": AdmissionsNoteDto[] }` — `listNotesForRole` strips `staff_only` notes for non-staff readers.

### `POST /api/admissions/cases/[caseId]/notes`

- **Auth:** min role `counselor`.
- **Request body:** `{ body, visibility: "staff_only" | "shared_with_family" }` — `visibility` is required with **no default** (every write carries an explicit audience choice).
- **Response:** `{ "note": AdmissionsNoteDto }`.

### `PATCH /api/admissions/cases/[caseId]/notes`

- **Auth:** min role `counselor`. **Request body:** `{ noteId: uuid, visibility }`. **Response:** `{ "note": AdmissionsNoteDto }`.

## Announcements

Scope rule (mirrors the DB check constraint): every request targets exactly one of `cohortId` **xor** `caseId` — both or neither is a `400`.

### `GET /api/admissions/announcements?caseId=` or `?cohortId=`

- **Auth:** case-scoped → `requireCaseAccess` min role `student` (family-visible feed, cohort broadcasts merged in); cohort-scoped → `requireCounselorOrAdmin` (staff-only cohort-wide listing).
- **Response:** `{ "announcements": AdmissionsAnnouncementDto[] }`.

### `POST /api/admissions/announcements`

- **Auth:** case-scoped → min role `counselor` on that case; cohort-scoped → `requireCounselorOrAdmin`.
- **Request body:** `{ cohortId | caseId, title, body }`.
- **Response:** `{ "announcement": AdmissionsAnnouncementDto }`.

### `PATCH /api/admissions/announcements`

- **Auth:** `requireCounselorOrAdmin` (the stored row, not the request, defines the scope — client-supplied scope is never trusted for rights).
- **Request body:** `{ announcementId: uuid, title? , body? }` (at least one).
- **Response:** `{ "announcement": AdmissionsAnnouncementDto }`.

### `DELETE /api/admissions/announcements?announcementId=<uuid>`

- **Auth:** `requireCounselorOrAdmin`. Soft delete. **Response:** `{ "ok": true }`.

## Resources

### `GET /api/admissions/resources`

- **Auth:** any admissions session (the library is global and readable by every role).
- **Response:** `{ "groups": AdmissionsResourceTopicGroup[] }` — topics in canonical order, each `{ topic, label, resources: AdmissionsResourceDto[] }`.

### `POST /api/admissions/resources`

- **Auth:** `requireCounselorOrAdmin`.
- **Request body:** `{ topic (a checklist phase key or "general"), title, url (validated https URL schema), sortOrder? }`.
- **Response:** `{ "resource": AdmissionsResourceDto }`.

### `PATCH /api/admissions/resources`

- **Auth:** `requireCounselorOrAdmin`. **Request body:** `{ resourceId: uuid, topic?, title?, url?, sortOrder? }` (at least one). **Response:** `{ "resource": AdmissionsResourceDto }`.

### `DELETE /api/admissions/resources?resourceId=<uuid>`

- **Auth:** `requireCounselorOrAdmin`. Soft delete. **Response:** `{ "ok": true }`.

## Cohorts & counselors (registries)

### `GET /api/admissions/cohorts`

- **Auth:** session; JWT role `counselor`+. **Response:** `{ "cohorts": AdmissionsCohortDto[] }` (`{ id, name, graduationYear }`).

### `POST /api/admissions/cohorts`

- **Auth:** admin only (JWT role). **Request body:** `{ name, graduationYear (2000–2100, coerced) }`. **Response:** `{ "cohort": AdmissionsCohortDto }`. Duplicate name → `409`.

### `GET /api/admissions/counselors`

- **Auth:** admin only (JWT role) — the registry grants sign-in capability. **Response:** `{ "counselors": AdmissionsCounselorDto[] }` (active + inactive).

### `POST /api/admissions/counselors`

- **Auth:** admin only. **Request body:** `{ email, name, active? (default true) }` — upserts by lowercase email; audited transactionally. **Response:** `{ "counselor": AdmissionsCounselorDto }`.

### `PATCH /api/admissions/counselors`

- **Auth:** admin only. **Request body (union):** `{ email, name, active }` (full upsert) or `{ email, active: false }` (pure deactivation — revokes counselor sign-in). **Response:** `{ "counselor": AdmissionsCounselorDto }`. Unknown email on deactivation → `404`.

## Audit trail

### `GET /api/admissions/audit/[caseId]?page=&pageSize=`

- **Auth:** admin only — JWT-claim fast-fail (`403`) plus `requireCaseAccess(email, caseId, "admin")`, which re-verifies against `admin_users` and 404s a missing/soft-deleted case.
- **Query:** `page` ≥ 1 (default 1); `pageSize` 1–200 (default 50). Coerced and bounded by Zod.
- **Response:** `AdmissionsAuditLogPage` — `{ entries: [{ id, caseId, actorEmail, actorRole, entityType, entityId, action, diff, createdAt }], page, pageSize, totalCount }`, newest first.

## Notification cron

### `GET /api/internal/admissions-notifications?runType=` · `POST /api/internal/admissions-notifications`

Vercel Cron entry point (schedule `12 1 * * *` = 08:12 Asia/Bangkok daily) plus a manual-trigger `POST` alias. See [crons.md](../crons.md#9-admissions-notifications--apiinternaladmissions-notifications) for scheduling detail.

- **Auth:** `Authorization: Bearer $CRON_SECRET` via the shared `rejectInvalidCronSecret` helper (`401` invalid / `500` missing secret). Bypasses the session middleware like all `/api/internal/*` routes; no session fallback.
- **Function config:** `maxDuration = 300`.
- **Request:** optional `runType` = `"daily" | "weekly"` — query param on `GET`, JSON body on `POST` (an empty body is allowed). Invalid values → `400`.
- **Behavior:** wrapped in `withCronInvocationAudit` (job key `admissions_notifications`). No `runType` (the Vercel cron case) runs the **daily** deadline-reminder scan (T-7d/T-48h, interrupt cap of 3/recipient/day with collapse) and, on Bangkok **Sundays**, also the **weekly digest** in the same invocation. Explicit `runType` runs exactly that orchestrator. Both orchestrators are single-flight via `admissions_notification_runs` (partial unique index on `status='running'`; stale rows failed after 30 minutes) and idempotent via `admissions_notification_log.dedupe_key`.
- **Responses:** `200 { ok: true, skipped: false, results: AdmissionsNotificationRunResult[] }` when at least one pass ran; `202` with `skipped: true` when every pass was skipped by the single-flight guard; `500 { error }` on a top-level orchestrator crash. Each result carries `{ skipped, runId, runType, sentCount, skippedCount, errorSummary }`.

---

_Verified against the route handlers and `src/lib/admissions/**` on 2026-07-10._
