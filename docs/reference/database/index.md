# Database Reference — Master Table Index

Canonical lookup of **every table** in the BGScheduler Postgres database. All 90 tables
are defined in [`src/lib/db/schema.ts`](../../../src/lib/db/schema.ts) via Drizzle ORM.
This page is the index: it lists each table's SQL name, its Drizzle export name, the
domain it belongs to, its **grain** (what one row represents), the feature that owns it,
and a link to the domain's ER diagram.

- **Mechanical detail** (full column lists, types, defaults, indexes, FK targets) lives
  on the per-domain `erd-*.md` pages linked in the last column.
- **Meaning** (purpose, business rules, flows, why a table exists) lives in the
  [feature docs](../../features/) — each owning-feature cell names the relevant feature.
- Grain was inferred from each table's columns and verified against `schema.ts` at the
  line ranges cited per domain section below. Line numbers are HEAD-relative and may
  drift; the Drizzle export name (the **Const** column) is the stable handle.

## How to read the grain column

The grain answers "one row per **what**?". A `PK` of `uuid id` alone does not define
grain — the grain is the natural business key, usually visible as the table's
`uniqueIndex(...)`. Where a table is snapshot-scoped, the grain is implicitly *within a
snapshot* (most tutor/normalization rows carry a `snapshotId` FK to `snapshots`, which
the ETL pipeline rewrites wholesale and then atomically promotes via `snapshots.active`,
`schema.ts:198-203`).

A subset of tables are deliberately **snapshot-independent** (they survive snapshot
rotation): `cron_invocations`, `admin_users`, `google_oauth_tokens`, `wise_activity_events`,
`wise_activity_sync_runs`, `tutor_aliases`, `room_utilization_sessions`,
`past_session_blocks` (`schema.ts:1487-1526`, the only cross-snapshot *tutor-session*
table — see its inline `PAST-01`/`D-04` note in `schema.ts`), and the two cross-snapshot
Progress Test accumulators `progress_test_attendance_ledger` and
`progress_test_cycle_state` (`schema.ts:2022-2082`, called out in the inline note at
`schema.ts:2007-2021`). The Credit Control, Sales Dashboard, Payroll, Room Capacity,
Student Promotion, LINE, Leave Request, AI/Proposal, and Progress Test subsystems each
keep their own run/sidecar tables independent of the Wise tutor snapshot.

## Domain map

| Domain | Tables | ER diagram |
|---|---|---|
| Core (snapshots, sync, audit, auth, tutors, normalization, student promotions, progress tests) | 32 | [erd-core.md](./erd-core.md) · [erd-student-promotions.md](./erd-student-promotions.md) |
| Sales Dashboard | 7 | [erd-sales-dashboard.md](./erd-sales-dashboard.md) |
| Credit Control | 10 | [erd-credit-control.md](./erd-credit-control.md) |
| Classrooms (assignment + email) | 9 | [erd-classrooms.md](./erd-classrooms.md) |
| Payroll | 8 | [erd-payroll.md](./erd-payroll.md) |
| Tutor Profiles | 2 | [erd-tutor-profiles.md](./erd-tutor-profiles.md) |
| Leave Requests | 5 | [erd-leave-requests.md](./erd-leave-requests.md) |
| AI & Proposals | 6 | [erd-ai-and-proposals.md](./erd-ai-and-proposals.md) |
| LINE | 8 | [erd-line.md](./erd-line.md) |
| Room Capacity | 4 | [erd-room-capacity.md](./erd-room-capacity.md) |
| **Total** | **90** | |

> The **Core** domain spans two ER-diagram pages: the snapshot/sync/tutor/normalization
> spine plus auth, Wise-activity audit, and Progress Tests live on [erd-core.md](./erd-core.md);
> the three Student Promotion tables have their own [erd-student-promotions.md](./erd-student-promotions.md).
> Both are counted inside the single Core total of 32.

## Master table list

Columns: **Table** (SQL name) · **Const** (Drizzle export in `schema.ts`) · **Domain** ·
**Grain** (one row per …) · **Owning feature** · **ERD**.

### Core — snapshots, sync, audit, auth, tutors, normalization, student promotions, progress tests

Line ranges: `schema.ts:198-327` (snapshot/sync/audit/auth), `669-750` (student promotions),
`751-880` (tutor identity + normalization + future sessions), `971-994`
(room utilization), `1487-1526` (past sessions), `1895-1935` (data issues + stats),
`2022-2205` (progress tests).

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `snapshots` | `snapshots` | core | versioned ETL snapshot; at most one `active=true` (`schema.ts:198-203`) | [Tutor search](../../features/tutor-search.md) (ETL) | [core](./erd-core.md) |
| `sync_runs` | `syncRuns` | core | one Wise snapshot-sync run; partial-unique guard allows a single `running` row (`schema.ts:204-219`) | [Data health](../../features/data-health.md) | [core](./erd-core.md) |
| `cron_invocations` | `cronInvocations` | core | one cron/admin invocation of a registered operational job; snapshot-independent (`schema.ts:221-241`) | [Data health](../../features/data-health.md) | [core](./erd-core.md) |
| `wise_activity_events` | `wiseActivityEvents` | core | one Wise audit event, deduped on `event_id`; snapshot-independent (`schema.ts:245-278`) | [Wise activity audit](../../features/wise-activity-audit.md) | [core](./erd-core.md) |
| `wise_activity_sync_runs` | `wiseActivitySyncRuns` | core | one Wise-activity audit sync run; single `running` guard (`schema.ts:280-298`) | [Wise activity audit](../../features/wise-activity-audit.md) | [core](./erd-core.md) |
| `admin_users` | `adminUsers` | core | one allowlisted admin email (unique on `email`); `allowedPages` scopes page access (`schema.ts:302-312`) | Auth ([middleware](../../../src/middleware.ts)) | [core](./erd-core.md) |
| `google_oauth_tokens` | `googleOAuthTokens` | core | one Google OAuth token set per `email` (PK = email); snapshot-independent (`schema.ts:314-324`) | Google OAuth (shared by [Sales Dashboard](../../features/sales-dashboard.md) + [Leave requests](../../features/leave-requests.md)) | [core](./erd-core.md) |
| `student_promotion_runs` | `studentPromotionRuns` | core | one grade/course promotion run for a `target_date` (`schema.ts:669-700`) | [Student promotions](../../features/student-promotions.md) | [student-promotions](./erd-student-promotions.md) |
| `student_promotion_grade_actions` | `studentPromotionGradeActions` | core | one per-student grade-bump action within a run (unique `run_id`+`wise_student_id`) (`schema.ts:702-724`) | [Student promotions](../../features/student-promotions.md) | [student-promotions](./erd-student-promotions.md) |
| `student_promotion_course_actions` | `studentPromotionCourseActions` | core | one per-class course-move action within a run (unique `run_id`+`wise_class_id`) (`schema.ts:726-747`) | [Student promotions](../../features/student-promotions.md) | [student-promotions](./erd-student-promotions.md) |
| `tutor_identity_groups` | `tutorIdentityGroups` | core | one merged tutor identity within a snapshot (`schema.ts:751-760`) | [Tutor search](../../features/tutor-search.md) | [core](./erd-core.md) |
| `tutor_identity_group_members` | `tutorIdentityGroupMembers` | core | one Wise teacher record mapped into an identity group, per snapshot (`schema.ts:762-773`) | [Tutor search](../../features/tutor-search.md) | [core](./erd-core.md) |
| `tutor_aliases` | `tutorAliases` | core | one nickname→canonical alias mapping (unique on `from_key`); snapshot-independent (`schema.ts:775-782`) | [Tutor search](../../features/tutor-search.md) (identity) | [core](./erd-core.md) |
| `tutors` | `tutors` | core | one logical tutor display record per identity group, per snapshot (`schema.ts:784-793`) | [Tutor search](../../features/tutor-search.md) | [core](./erd-core.md) |
| `raw_teacher_tags` | `rawTeacherTags` | core | one raw Wise teacher tag captured for normalization, per snapshot (`schema.ts:797-806`) | [Tutor search](../../features/tutor-search.md) (qualifications) | [core](./erd-core.md) |
| `subject_level_qualifications` | `subjectLevelQualifications` | core | one parsed subject/curriculum/level qualification for a group, per snapshot (`schema.ts:808-820`) | [Tutor search](../../features/tutor-search.md) (qualifications) | [core](./erd-core.md) |
| `recurring_availability_windows` | `recurringAvailabilityWindows` | core | one weekday availability window (minute range) for a group, per snapshot (`schema.ts:824-836`) | [Tutor search](../../features/tutor-search.md) (availability) | [core](./erd-core.md) |
| `dated_leaves` | `datedLeaves` | core | one dated leave interval for a group, per snapshot (`schema.ts:838-848`) | [Tutor search](../../features/tutor-search.md) (leaves) | [core](./erd-core.md) |
| `future_session_blocks` | `futureSessionBlocks` | core | one future Wise session that may block availability, per snapshot (`schema.ts:850-877`) | [Tutor search](../../features/tutor-search.md) / [Tutor compare](../../features/tutor-compare.md) | [core](./erd-core.md) |
| `room_utilization_sessions` | `roomUtilizationSessions` | core | one observed Wise session for room-utilization, deduped on `wise_session_id`; snapshot-independent (`schema.ts:971-991`) | [Room capacity](../../features/room-capacity.md) | [core](./erd-core.md) |
| `past_session_blocks` | `pastSessionBlocks` | core | one captured past Wise session, deduped on `wise_session_id`; **cross-snapshot** anchor via `group_canonical_key` (`schema.ts:1487-1526`) | [Tutor compare](../../features/tutor-compare.md) (PAST-01) | [core](./erd-core.md) |
| `data_issues` | `dataIssues` | core | one normalization/sync issue raised within a snapshot (`schema.ts:1895-1909`) | [Data health](../../features/data-health.md) | [core](./erd-core.md) |
| `snapshot_stats` | `snapshotStats` | core | one rollup stats row per snapshot (unique on `snapshot_id`) (`schema.ts:1913-1929`) | [Data health](../../features/data-health.md) | [core](./erd-core.md) |
| `progress_test_attendance_ledger` | `progressTestAttendanceLedger` | core | one attended-with-credit class per `wise_session_id`+`wise_student_id`; **cross-snapshot** accumulator (`schema.ts:2022-2046`) | Progress Tests | [core](./erd-core.md) |
| `progress_test_cycle_state` | `progressTestCycleState` | core | one progress-test cycle per `enrollment_key` (PK); **cross-snapshot** (`schema.ts:2048-2082`) | Progress Tests | [core](./erd-core.md) |
| `progress_test_bookings` | `progressTestBookings` | core | one progress-test booking attempt (dry-run or Wise-created) per enrollment+cycle (`schema.ts:2084-2105`) | Progress Tests | [core](./erd-core.md) |
| `progress_test_email_runs` | `progressTestEmailRuns` | core | one parent-outreach email run for an enrollment+cycle (unique `idempotency_key`) (`schema.ts:2107-2126`) | Progress Tests | [core](./erd-core.md) |
| `progress_test_notifications` | `progressTestNotifications` | core | one teacher/parent notification delivery (unique `idempotency_key`) (`schema.ts:2128-2145`) | Progress Tests | [core](./erd-core.md) |
| `progress_test_admin_digest_runs` | `progressTestAdminDigestRuns` | core | one daily admin digest run per `digest_date` (unique) (`schema.ts:2147-2167`) | Progress Tests | [core](./erd-core.md) |
| `progress_test_admin_digest_recipients` | `progressTestAdminDigestRecipients` | core | one recipient delivery within an admin digest run (`schema.ts:2169-2183`) | Progress Tests | [core](./erd-core.md) |
| `progress_test_sync_runs` | `progressTestSyncRuns` | core | one Progress Tests sync run; single `running` guard (`schema.ts:2185-2205`) | Progress Tests | [core](./erd-core.md) |

> **Progress Tests** has no dedicated `docs/features/*.md` page at this revision; its
> meaning is documented inline in `schema.ts:2007-2021` and the ERD on
> [erd-core.md](./erd-core.md). See [Open questions](#open-questions) below.

### Sales Dashboard

Line ranges: `schema.ts:328-501`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `sales_dashboard_sources` | `salesDashboardSources` | sales-dashboard | one monthly sales-sheet source (unique active per `source_month`) (`schema.ts:328-351`) | [Sales dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_import_runs` | `salesDashboardImportRuns` | sales-dashboard | one import run for a source; single `running` per source (`schema.ts:360-379`) | [Sales dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_normal_rows` | `salesDashboardNormalRows` | sales-dashboard | one parsed "normal" sheet row per import run (unique `import_run_id`+`row_number`) (`schema.ts:381-405`) | [Sales dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_additional_rows` | `salesDashboardAdditionalRows` | sales-dashboard | one parsed "additional" sheet row per import run (unique `import_run_id`+`row_number`) (`schema.ts:408-425`) | [Sales dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_projection_sources` | `salesDashboardProjectionSources` | sales-dashboard | one projection workbook source; single `active` (`schema.ts:428-450`) | [Sales dashboard](../../features/sales-dashboard.md) (projections) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_projection_import_runs` | `salesDashboardProjectionImportRuns` | sales-dashboard | one projection import run; single `running` per source (`schema.ts:453-470`) | [Sales dashboard](../../features/sales-dashboard.md) (projections) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_projection_months` | `salesDashboardProjectionMonths` | sales-dashboard | one scenario×month projection row per import run (unique run+scenario+month) (`schema.ts:473-500`) | [Sales dashboard](../../features/sales-dashboard.md) (projections) | [sales-dashboard](./erd-sales-dashboard.md) |

### Credit Control

Line ranges: `schema.ts:505-665`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `credit_control_snapshots` | `creditControlSnapshots` | credit-control | one credit-control data snapshot; at most one `active=true` (`schema.ts:505-515`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_sync_runs` | `creditControlSyncRuns` | credit-control | one credit-control sync run; single `running` guard (`schema.ts:517-535`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_students` | `creditControlStudents` | credit-control | one student per snapshot (unique snapshot+`wise_student_id`) (`schema.ts:537-550`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_packages` | `creditControlPackages` | credit-control | one student×class prepaid package per snapshot (unique snapshot+class+student) (`schema.ts:552-575`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_sessions` | `creditControlSessions` | credit-control | one session per snapshot (unique snapshot+session+student) (`schema.ts:577-601`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_credit_history` | `creditControlCreditHistory` | credit-control | one Wise credit-history entry per snapshot (unique snapshot+history+student+class) (`schema.ts:603-620`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_follow_up_state` | `creditControlFollowUpState` | credit-control | one follow-up status per student (PK `student_key`); snapshot-independent sidecar (`schema.ts:622-632`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_follow_up_log` | `creditControlFollowUpLog` | credit-control | one follow-up action event (append-only); snapshot-independent (`schema.ts:634-647`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_inactive_students` | `creditControlInactiveStudents` | credit-control | one inactive-flagged student (PK `student_key`); snapshot-independent (`schema.ts:649-655`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_admin_ownership` | `creditControlAdminOwnership` | credit-control | one admin-owner assignment per student (PK `student_key`); snapshot-independent (`schema.ts:657-665`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |

### Classrooms — assignment + publish + email

Line ranges: `schema.ts:881-970` (rooms + runs + rows), `1156-1196` (publish + automation),
`1250-1321` (schedule + admin email).

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `classroom_rooms` | `classroomRooms` | classrooms | one physical/virtual room (unique on `name`); snapshot-independent catalog (`schema.ts:881-894`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |
| `classroom_assignment_runs` | `classroomAssignmentRuns` | classrooms | one room-assignment run for an `assignment_date` (`schema.ts:896-920`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |
| `classroom_assignment_rows` | `classroomAssignmentRows` | classrooms | one session→room assignment within a run (unique `run_id`+`wise_session_id`) (`schema.ts:922-967`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |
| `classroom_publish_jobs` | `classroomPublishJobs` | classrooms | one Wise-location publish job for a run (`schema.ts:1156-1176`) | [Classroom assignments](../../features/classroom-assignments.md) (publish) | [classrooms](./erd-classrooms.md) |
| `classroom_automation_events` | `classroomAutomationEvents` | classrooms | one morning-automation audit event in a batch (`schema.ts:1178-1195`) | [Classroom assignments](../../features/classroom-assignments.md) (automation) | [classrooms](./erd-classrooms.md) |
| `classroom_schedule_email_runs` | `classroomScheduleEmailRuns` | classrooms | one teacher-schedule email run for an assignment run (`schema.ts:1250-1264`) | [Classroom assignments](../../features/classroom-assignments.md) (schedule email) | [classrooms](./erd-classrooms.md) |
| `classroom_schedule_email_recipients` | `classroomScheduleEmailRecipients` | classrooms | one teacher recipient within a schedule-email run (`schema.ts:1266-1283`) | [Classroom assignments](../../features/classroom-assignments.md) (schedule email) | [classrooms](./erd-classrooms.md) |
| `classroom_admin_email_runs` | `classroomAdminEmailRuns` | classrooms | one admin-summary email run for an `assignment_date` (unique `idempotency_key`) (`schema.ts:1285-1305`) | [Classroom assignments](../../features/classroom-assignments.md) (admin email) | [classrooms](./erd-classrooms.md) |
| `classroom_admin_email_recipients` | `classroomAdminEmailRecipients` | classrooms | one admin recipient within an admin-email run (`schema.ts:1307-1321`) | [Classroom assignments](../../features/classroom-assignments.md) (admin email) | [classrooms](./erd-classrooms.md) |

### Payroll

Line ranges: `schema.ts:995-1155`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `payroll_sync_runs` | `payrollSyncRuns` | payroll | one payroll sync run for a `payroll_month`; single `running` guard (`schema.ts:995-1013`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_reviews` | `payrollReviews` | payroll | one review state per `payroll_month` (unique) (`schema.ts:1015-1029`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_teacher_tiers` | `payrollTeacherTiers` | payroll | one teacher tier resolution per month (unique month+`wise_teacher_id`) (`schema.ts:1031-1045`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_payout_invoices` | `payrollPayoutInvoices` | payroll | one Wise payout invoice event (unique `event_id`) (`schema.ts:1047-1073`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_session_observations` | `payrollSessionObservations` | payroll | one observed session per month (unique month+`wise_session_id`) (`schema.ts:1075-1100`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_adjustments` | `payrollAdjustments` | payroll | one manual pay adjustment for a month (`schema.ts:1102-1118`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_rate_card_versions` | `payrollRateCardVersions` | payroll | one rate-card version; single `active=true` (`schema.ts:1120-1135`) | [Payroll](../../features/payroll.md) (rate card) | [payroll](./erd-payroll.md) |
| `payroll_rate_rules` | `payrollRateRules` | payroll | one rate rule (band×course×tier) within a version (unique) (`schema.ts:1137-1154`) | [Payroll](../../features/payroll.md) (rate card) | [payroll](./erd-payroll.md) |

### Tutor Profiles

Line ranges: `schema.ts:1197-1249`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `tutor_contacts` | `tutorContacts` | tutor-profiles | one tutor contact record keyed by `canonical_key` (unique); snapshot-independent (`schema.ts:1197-1212`) | [Tutor profiles](../../features/tutor-profiles.md) | [tutor-profiles](./erd-tutor-profiles.md) |
| `tutor_business_profiles` | `tutorBusinessProfiles` | tutor-profiles | one editorial business profile (PK `canonical_key`); snapshot-independent (`schema.ts:1214-1248`) | [Tutor profiles](../../features/tutor-profiles.md) | [tutor-profiles](./erd-tutor-profiles.md) |

### Leave Requests

Line ranges: `schema.ts:1325-1466`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `leave_request_sync_runs` | `leaveRequestSyncRuns` | leave-requests | one leave-sheet sync run; single `running` guard (`schema.ts:1325-1343`) | [Leave requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) |
| `leave_requests` | `leaveRequests` | leave-requests | one leave-form submission per source row (unique spreadsheet+sheet+`source_row_number`) (`schema.ts:1345-1396`) | [Leave requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) |
| `leave_request_affected_sessions` | `leaveRequestAffectedSessions` | leave-requests | one Wise session overlapped by a leave (unique `leave_request_id`+`wise_session_id`) (`schema.ts:1403-1432`) | [Leave requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) |
| `leave_request_activity_logs` | `leaveRequestActivityLogs` | leave-requests | one action/audit entry against a leave request (`schema.ts:1434-1448`) | [Leave requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) |
| `leave_request_notifications` | `leaveRequestNotifications` | leave-requests | one notification delivery for a leave request (unique `idempotency_key`) (`schema.ts:1450-1466`) | [Leave requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) |

### AI & Proposals

Line ranges: `schema.ts:1532-1665`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `proposal_bundles` | `proposalBundles` | ai-and-proposals | one parent-proposal hold bundle (per student label) (`schema.ts:1532-1542`) | [Proposals](../../features/proposals.md) | [ai-and-proposals](./erd-ai-and-proposals.md) |
| `proposal_items` | `proposalItems` | ai-and-proposals | one tentative tutor-slot hold within a bundle (`schema.ts:1544-1572`) | [Proposals](../../features/proposals.md) | [ai-and-proposals](./erd-ai-and-proposals.md) |
| `ai_scheduler_conversations` | `aiSchedulerConversations` | ai-and-proposals | one AI-scheduler conversation thread (`schema.ts:1576-1595`) | [AI scheduler](../../features/ai-scheduler.md) | [ai-and-proposals](./erd-ai-and-proposals.md) |
| `ai_scheduler_messages` | `aiSchedulerMessages` | ai-and-proposals | one message turn within a conversation (`schema.ts:1597-1613`) | [AI scheduler](../../features/ai-scheduler.md) | [ai-and-proposals](./erd-ai-and-proposals.md) |
| `ai_scheduler_runs` | `aiSchedulerRuns` | ai-and-proposals | one scheduler LLM/solver run (parse+solve telemetry) (`schema.ts:1615-1637`) | [AI scheduler](../../features/ai-scheduler.md) | [ai-and-proposals](./erd-ai-and-proposals.md) |
| `ai_scheduler_feedback` | `aiSchedulerFeedback` | ai-and-proposals | one accept/edit/reject feedback event on a run/message (`schema.ts:1639-1662`) | [AI scheduler](../../features/ai-scheduler.md) (metrics) | [ai-and-proposals](./erd-ai-and-proposals.md) |

### LINE

Line ranges: `schema.ts:1666-1891`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `line_contacts` | `lineContacts` | line | one LINE OA contact (unique `line_user_id`) (`schema.ts:1666-1682`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_threads` | `lineThreads` | line | one conversation thread per contact (unique `line_user_id`) (`schema.ts:1684-1698`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_messages` | `lineMessages` | line | one LINE message (unique `webhook_event_id` / `line_message_id`) (`schema.ts:1700-1733`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_contact_student_links` | `lineContactStudentLinks` | line | one contact→student link (unique `contact_id`+`student_key`) (`schema.ts:1735-1772`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_scheduler_reviews` | `lineSchedulerReviews` | line | one scheduler-review item per inbound message (unique `inbound_message_id`) (`schema.ts:1774-1821`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_wise_action_logs` | `lineWiseActionLogs` | line | one (dry-run) Wise action attempt tied to a review (`schema.ts:1823-1838`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_oa_resolver_runs` | `lineOaResolverRuns` | line | one OA-resolver run (token-gated worklist) (unique `token_hash`) (`schema.ts:1840-1864`) | [LINE integration](../../features/line-integration.md) (OA resolver) | [line](./erd-line.md) |
| `line_oa_resolver_rows` | `lineOaResolverRows` | line | one student row within an OA-resolver run (unique run+student+`search_code`) (`schema.ts:1866-1891`) | [LINE integration](../../features/line-integration.md) (OA resolver) | [line](./erd-line.md) |

### Room Capacity

Line ranges: `schema.ts:1936-2005`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `room_capacity_model_runs` | `roomCapacityModelRuns` | room-capacity | one capacity-forecast model run (unique `source_fingerprint`) (`schema.ts:1936-1948`) | [Room capacity](../../features/room-capacity.md) (forecast) | [room-capacity](./erd-room-capacity.md) |
| `room_capacity_forecast_drivers` | `roomCapacityForecastDrivers` | room-capacity | one scenario×month forecast-driver row within a model run (`schema.ts:1950-1971`) | [Room capacity](../../features/room-capacity.md) (forecast) | [room-capacity](./erd-room-capacity.md) |
| `room_capacity_demand_mix` | `roomCapacityDemandMix` | room-capacity | one weekday/time demand-mix slice within a model run (`schema.ts:1973-1989`) | [Room capacity](../../features/room-capacity.md) (forecast) | [room-capacity](./erd-room-capacity.md) |
| `room_capacity_package_mix` | `roomCapacityPackageMix` | room-capacity | one package-hour-bucket mix row within a model run (`schema.ts:1991-2005`) | [Room capacity](../../features/room-capacity.md) (forecast) | [room-capacity](./erd-room-capacity.md) |

## Open questions

- **Progress Tests has no `docs/features/*.md` page.** The 8 Progress Test tables
  (`schema.ts:2022-2205`) are grouped under the **core** domain per the authoritative
  inventory and documented inline in `schema.ts:2007-2021`, but there is no feature doc
  to link as the "Owning feature". The owning-feature cells therefore read "Progress
  Tests" as plain text. A `docs/features/progress-tests.md` page (and matching mention in
  the [erd-core.md](./erd-core.md) scope) would close this gap.
- **erd-core.md scope vs. content.** `erd-core.md`'s header claims it covers the Progress
  Tests subsystem, but at this revision the page body does not yet contain the
  `progress_test_*` table definitions. The ERD links above point to `erd-core.md` on the
  assumption that page will host the column-level detail; verify it does before relying on
  those anchors.

_Verified against HEAD `d4fe6d3` on 2026-06-05._
