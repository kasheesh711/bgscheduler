# Database Reference — Master Table Index

Canonical lookup of **every table** in the BGScheduler Postgres database. All 85 tables
are defined in [`src/lib/db/schema.ts`](../../../src/lib/db/schema.ts) via Drizzle ORM.
This page is the index: it lists each table's SQL name, its Drizzle export name, the
domain it belongs to, its **grain** (what one row represents), the feature that owns it,
and a link to the domain's ER diagram.

- **Mechanical detail** (full column lists, types, defaults, indexes, FK targets) lives
  on the per-domain `erd-*.md` pages linked in the last column.
- **Meaning** (purpose, business rules, flows, why a table exists) lives in the
  [feature docs](../../features/) — each owning-feature cell names the relevant feature.
- Grain was inferred from each table's columns and verified against `schema.ts` at the
  line ranges cited per domain section below.

## How to read the grain column

The grain answers "one row per **what**?". A `PK` of `uuid id` alone does not define
grain — the grain is the natural business key, usually visible as the table's
`uniqueIndex(...)`. Where a table is snapshot-scoped, the grain is implicitly *within a
snapshot* (almost all tutor/normalization rows carry a `snapshotId` FK to `snapshots`,
which the ETL pipeline rewrites wholesale and then atomically promotes via
`snapshots.active`, `schema.ts:167`).

A few tables are deliberately **snapshot-independent** (they survive snapshot rotation):
`admin_users`, `google_oauth_tokens`, `tutor_aliases`, `cron_invocations`, `wise_activity_events`,
`wise_activity_sync_runs`, `student_promotion_runs`, `student_promotion_grade_actions`,
`student_promotion_course_actions`, `student_promotion_future_session_actions`,
`student_promotion_graduation_actions`, `student_promotion_pay_rate_impacts`,
`room_utilization_sessions`, and `past_session_blocks`
(`schema.ts:1347-1386`, the only cross-snapshot data table — see its note in
[erd-core.md](./erd-core.md)).

## Domain map

| Domain | Tables | ER diagram |
|---|---|---|
| Core (snapshots, sync, audit, auth, tutors, normalization) | 20 | [erd-core.md](./erd-core.md) |
| Sales Dashboard | 7 | [erd-sales-dashboard.md](./erd-sales-dashboard.md) |
| Credit Control | 10 | [erd-credit-control.md](./erd-credit-control.md) |
| Classrooms (assignment + email) | 9 | [erd-classrooms.md](./erd-classrooms.md) |
| Payroll | 8 | [erd-payroll.md](./erd-payroll.md) |
| Tutor Profiles | 2 | [erd-tutor-profiles.md](./erd-tutor-profiles.md) |
| Leave Requests | 5 | [erd-leave-requests.md](./erd-leave-requests.md) |
| Student Promotions | 6 | [erd-student-promotions.md](./erd-student-promotions.md) |
| AI & Proposals | 6 | [erd-ai-and-proposals.md](./erd-ai-and-proposals.md) |
| LINE | 8 | [erd-line.md](./erd-line.md) |
| Room Capacity | 4 | [erd-room-capacity.md](./erd-room-capacity.md) |
| **Total** | **85** | |

## Master table list

Columns: **Table** (SQL name) · **Const** (Drizzle export in `schema.ts`) · **Domain** ·
**Grain** (one row per …) · **Owning feature** · **ERD**.

### Core — snapshots, sync, audit, auth, tutors, normalization

Line ranges: `schema.ts:165-269`, `611-740`, `831-854`, `1347-1386`, `1744-1784`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `snapshots` | `snapshots` | core | versioned ETL snapshot; at most one `active=true` (`schema.ts:165-169`) | [Tutor search](../../features/tutor-search.md) (ETL) | [core](./erd-core.md) |
| `sync_runs` | `syncRuns` | core | one Wise snapshot-sync run; partial-unique guard allows a single `running` row (`schema.ts:171-186`) | [Data health](../../features/data-health.md) | [core](./erd-core.md) |
| `cron_invocations` | `cronInvocations` | core | one valid cron/admin invocation of a registered operational job (`schema.ts`) | [Data health](../../features/data-health.md) | [core](./erd-core.md) |
| `wise_activity_events` | `wiseActivityEvents` | core | one Wise audit event, deduped on `event_id` (`schema.ts:190-223`) | [Wise activity audit](../../features/wise-activity-audit.md) | [core](./erd-core.md) |
| `wise_activity_sync_runs` | `wiseActivitySyncRuns` | core | one Wise-activity audit sync run; single `running` guard (`schema.ts:225-243`) | [Wise activity audit](../../features/wise-activity-audit.md) | [core](./erd-core.md) |
| `admin_users` | `adminUsers` | core | one allowlisted admin email (unique on `email`) (`schema.ts:247-254`) | Auth ([middleware](../../../src/middleware.ts)) | [core](./erd-core.md) |
| `google_oauth_tokens` | `googleOAuthTokens` | core | one Google OAuth token set per `email` (PK = email) (`schema.ts:256-266`) | Google OAuth (shared by [Sales Dashboard](../../features/sales-dashboard.md) + [Leave requests](../../features/leave-requests.md)) | [core](./erd-core.md) |
| `tutor_identity_groups` | `tutorIdentityGroups` | core | one merged tutor identity within a snapshot (`schema.ts:611-620`) | [Tutor search](../../features/tutor-search.md) | [core](./erd-core.md) |
| `tutor_identity_group_members` | `tutorIdentityGroupMembers` | core | one Wise teacher record mapped into an identity group, per snapshot (`schema.ts:622-633`) | [Tutor search](../../features/tutor-search.md) | [core](./erd-core.md) |
| `tutor_aliases` | `tutorAliases` | core | one nickname→canonical alias mapping (unique on `from_key`); snapshot-independent (`schema.ts:635-642`) | [Tutor search](../../features/tutor-search.md) (identity) | [core](./erd-core.md) |
| `tutors` | `tutors` | core | one logical tutor display record per identity group, per snapshot (`schema.ts:644-653`) | [Tutor search](../../features/tutor-search.md) | [core](./erd-core.md) |
| `raw_teacher_tags` | `rawTeacherTags` | core | one raw Wise tag value for a teacher, per snapshot (`schema.ts:657-666`) | [Tutor search](../../features/tutor-search.md) (qualifications) | [core](./erd-core.md) |
| `subject_level_qualifications` | `subjectLevelQualifications` | core | one normalized subject/curriculum/level qualification for a group, per snapshot (`schema.ts:668-680`) | [Tutor search](../../features/tutor-search.md) | [core](./erd-core.md) |
| `recurring_availability_windows` | `recurringAvailabilityWindows` | core | one weekday+time availability window for a teacher, per snapshot (`schema.ts:684-696`) | [Tutor search](../../features/tutor-search.md) | [core](./erd-core.md) |
| `dated_leaves` | `datedLeaves` | core | one exact leave interval for a teacher, per snapshot (`schema.ts:698-708`) | [Tutor search](../../features/tutor-search.md) | [core](./erd-core.md) |
| `future_session_blocks` | `futureSessionBlocks` | core | one future Wise session blocking a tutor, per snapshot (`schema.ts:710-737`) | [Tutor search](../../features/tutor-search.md) / [Tutor compare](../../features/tutor-compare.md) | [core](./erd-core.md) |
| `room_utilization_sessions` | `roomUtilizationSessions` | core | one Wise session with its normalized room label, deduped on `wise_session_id`; snapshot-independent (`schema.ts:831-851`) | [Room capacity](../../features/room-capacity.md) (utilization) | [core](./erd-core.md) |
| `past_session_blocks` | `pastSessionBlocks` | core | one historical Wise session, deduped on `wise_session_id`; the only cross-snapshot data table (`schema.ts:1347-1386`) | [Tutor compare](../../features/tutor-compare.md) (history fallback) | [core](./erd-core.md) |
| `data_issues` | `dataIssues` | core | one unresolved normalization issue, per snapshot (`schema.ts:1744-1758`) | [Data health](../../features/data-health.md) | [core](./erd-core.md) |
| `snapshot_stats` | `snapshotStats` | core | one stats roll-up per snapshot (unique on `snapshot_id`) (`schema.ts:1762-1777`) | [Data health](../../features/data-health.md) | [core](./erd-core.md) |

### Sales Dashboard

Line ranges: `schema.ts:270-446`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `sales_dashboard_sources` | `salesDashboardSources` | sales-dashboard | one monthly Google-Sheet sales source (unique active source per `source_month`) (`schema.ts:270-300`) | [Sales dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_import_runs` | `salesDashboardImportRuns` | sales-dashboard | one sales import run; single `running` per source (`schema.ts:302-321`) | [Sales dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_normal_rows` | `salesDashboardNormalRows` | sales-dashboard | one normalized "normal" sales row (unique on `import_run_id`+`row_number`) (`schema.ts:323-348`) | [Sales dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_additional_rows` | `salesDashboardAdditionalRows` | sales-dashboard | one "additional" sales row (unique on `import_run_id`+`row_number`) (`schema.ts:350-368`) | [Sales dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_projection_sources` | `salesDashboardProjectionSources` | sales-dashboard | one projection-workbook source (single `active`) (`schema.ts:370-393`) | [Sales dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_projection_import_runs` | `salesDashboardProjectionImportRuns` | sales-dashboard | one projection import run; single `running` per source (`schema.ts:395-413`) | [Sales dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) |
| `sales_dashboard_projection_months` | `salesDashboardProjectionMonths` | sales-dashboard | one projected month per scenario (unique on `import_run_id`+`scenario`+`projection_month`) (`schema.ts:415-443`) | [Sales dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) |

### Credit Control

Line ranges: `schema.ts:447-610`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `credit_control_snapshots` | `creditControlSnapshots` | credit-control | one credit-control snapshot; `active` flag (`schema.ts:447-457`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_sync_runs` | `creditControlSyncRuns` | credit-control | one credit-control sync run; single `running` guard (`schema.ts:459-477`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_students` | `creditControlStudents` | credit-control | one student per snapshot (unique on `snapshot_id`+`wise_student_id`) (`schema.ts:479-492`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_packages` | `creditControlPackages` | credit-control | one class+student package per snapshot (unique on `snapshot_id`+`wise_class_id`+`wise_student_id`) (`schema.ts:494-517`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_sessions` | `creditControlSessions` | credit-control | one session+student per snapshot (unique on `snapshot_id`+`wise_session_id`+`wise_student_id`) (`schema.ts:519-543`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_credit_history` | `creditControlCreditHistory` | credit-control | one credit-history entry per snapshot (unique on snapshot+history+student+class) (`schema.ts:545-562`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_follow_up_state` | `creditControlFollowUpState` | credit-control | current follow-up status per student (PK = `student_key`); snapshot-independent (`schema.ts:564-574`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_follow_up_log` | `creditControlFollowUpLog` | credit-control | one follow-up action event (PK = `event_id`) (`schema.ts:576-589`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_inactive_students` | `creditControlInactiveStudents` | credit-control | one student manually marked inactive (PK = `student_key`) (`schema.ts:591-597`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |
| `credit_control_admin_ownership` | `creditControlAdminOwnership` | credit-control | one admin-owner assignment per student (PK = `student_key`) (`schema.ts:599-607`) | [Credit control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) |

### Student Promotions

Line ranges: `schema.ts:1065-1243`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `student_promotion_runs` | `studentPromotionRuns` | student-promotions | one audited dry-run/apply ledger for a target date (`schema.ts:649-679`) | [Student promotions](../../features/student-promotions.md) | [student-promotions](./erd-student-promotions.md) |
| `student_promotion_grade_actions` | `studentPromotionGradeActions` | student-promotions | one potential Wise registration grade update per accepted student within a run (`schema.ts:682-704`) | [Student promotions](../../features/student-promotions.md) | [student-promotions](./erd-student-promotions.md) |
| `student_promotion_course_actions` | `studentPromotionCourseActions` | student-promotions | one potential Wise class-subject update per class within a run (`schema.ts:706-733`) | [Student promotions](../../features/student-promotions.md) | [student-promotions](./erd-student-promotions.md) |
| `student_promotion_future_session_actions` | `studentPromotionFutureSessionActions` | student-promotions | one July 1+ future Wise session subject audit/update candidate per run and Wise session | [Student promotions](../../features/student-promotions.md) | [student-promotions](./erd-student-promotions.md) |
| `student_promotion_graduation_actions` | `studentPromotionGraduationActions` | student-promotions | one required Year 13 graduate disposition review per accepted student in a run | [Student promotions](../../features/student-promotions.md) | [student-promotions](./erd-student-promotions.md) |
| `student_promotion_pay_rate_impacts` | `studentPromotionPayRateImpacts` | student-promotions | one pay-rate review row per teacher + class + student band + current/target course pair | [Student promotions](../../features/student-promotions.md) | [student-promotions](./erd-student-promotions.md) |

### Classrooms — assignment + email

Line ranges: `schema.ts:741-830`, `1016-1056`, `1110-1184`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `classroom_rooms` | `classroomRooms` | classrooms | one physical room in the catalog (unique on `name`); snapshot-independent (`schema.ts:741-754`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |
| `classroom_assignment_runs` | `classroomAssignmentRuns` | classrooms | one room-assignment run for a Bangkok date (`schema.ts:756-780`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |
| `classroom_assignment_rows` | `classroomAssignmentRows` | classrooms | one session's room assignment within a run (unique on `run_id`+`wise_session_id`) (`schema.ts:782-827`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |
| `classroom_publish_jobs` | `classroomPublishJobs` | classrooms | one Wise-publish job for an assignment run (`schema.ts:1016-1036`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |
| `classroom_automation_events` | `classroomAutomationEvents` | classrooms | one automation/reconciliation event in an assignment batch (`schema.ts:1038-1055`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |
| `classroom_schedule_email_runs` | `classroomScheduleEmailRuns` | classrooms | one tutor-schedule email run for an assignment run (`schema.ts:1110-1124`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |
| `classroom_schedule_email_recipients` | `classroomScheduleEmailRecipients` | classrooms | one tutor recipient of a schedule-email run (`schema.ts:1126-1143`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |
| `classroom_admin_email_runs` | `classroomAdminEmailRuns` | classrooms | one admin-notification email run per date (unique on `idempotency_key`) (`schema.ts:1145-1165`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |
| `classroom_admin_email_recipients` | `classroomAdminEmailRecipients` | classrooms | one recipient of an admin-email run (`schema.ts:1167-1181`) | [Classroom assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) |

### Payroll

Line ranges: `schema.ts:855-1015`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `payroll_sync_runs` | `payrollSyncRuns` | payroll | one payroll sync run for a month; single `running` guard (`schema.ts:855-873`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_reviews` | `payrollReviews` | payroll | one payroll review per month (unique on `payroll_month`) (`schema.ts:875-889`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_teacher_tiers` | `payrollTeacherTiers` | payroll | one teacher's tier for a month (unique on `payroll_month`+`wise_teacher_id`) (`schema.ts:891-905`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_payout_invoices` | `payrollPayoutInvoices` | payroll | one payout-invoice event (unique on `event_id`) (`schema.ts:907-933`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_session_observations` | `payrollSessionObservations` | payroll | one observed teaching session for a month (unique on `payroll_month`+`wise_session_id`) (`schema.ts:935-960`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_adjustments` | `payrollAdjustments` | payroll | one manual payroll adjustment for a month (`schema.ts:962-978`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_rate_card_versions` | `payrollRateCardVersions` | payroll | one rate-card version; single `active` (`schema.ts:980-995`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |
| `payroll_rate_rules` | `payrollRateRules` | payroll | one rate rule within a version (unique on version+band+course+tier) (`schema.ts:997-1014`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) |

### Tutor Profiles

Line ranges: `schema.ts:1057-1109`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `tutor_contacts` | `tutorContacts` | tutor-profiles | one tutor's contact record (unique on `canonical_key`) (`schema.ts:1057-1072`) | [Tutor profiles](../../features/tutor-profiles.md) | [tutor-profiles](./erd-tutor-profiles.md) |
| `tutor_business_profiles` | `tutorBusinessProfiles` | tutor-profiles | one tutor's business/teaching profile (PK = `canonical_key`) (`schema.ts:1074-1108`) | [Tutor profiles](../../features/tutor-profiles.md) | [tutor-profiles](./erd-tutor-profiles.md) |

### Leave Requests

Line ranges: `schema.ts:1185-1326`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `leave_request_sync_runs` | `leaveRequestSyncRuns` | leave-requests | one leave-request sheet sync run; single `running` guard (`schema.ts:1185-1203`) | [Leave requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) |
| `leave_requests` | `leaveRequests` | leave-requests | one tutor leave request, keyed to a source sheet row (unique on spreadsheet+sheet+row) (`schema.ts:1205-1261`) | [Leave requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) |
| `leave_request_affected_sessions` | `leaveRequestAffectedSessions` | leave-requests | one Wise session overlapping a leave request (unique on `leave_request_id`+`wise_session_id`) (`schema.ts:1263-1292`) | [Leave requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) |
| `leave_request_activity_logs` | `leaveRequestActivityLogs` | leave-requests | one action/audit entry for a leave request (`schema.ts:1294-1308`) | [Leave requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) |
| `leave_request_notifications` | `leaveRequestNotifications` | leave-requests | one notification email for a leave request (unique on `idempotency_key`) (`schema.ts:1310-1325`) | [Leave requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) |

### AI & Proposals

Line ranges: `schema.ts:1392-1522`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `proposal_bundles` | `proposalBundles` | ai-and-proposals | one parent-proposal bundle (local hold) (`schema.ts:1392-1402`) | [Proposals](../../features/proposals.md) | [ai-and-proposals](./erd-ai-and-proposals.md) |
| `proposal_items` | `proposalItems` | ai-and-proposals | one tutor/time hold within a bundle (`schema.ts:1404-1432`) | [Proposals](../../features/proposals.md) | [ai-and-proposals](./erd-ai-and-proposals.md) |
| `ai_scheduler_conversations` | `aiSchedulerConversations` | ai-and-proposals | one AI-scheduler conversation (`schema.ts:1436-1455`) | [AI scheduler](../../features/ai-scheduler.md) | [ai-and-proposals](./erd-ai-and-proposals.md) |
| `ai_scheduler_messages` | `aiSchedulerMessages` | ai-and-proposals | one message in a scheduler conversation (`schema.ts:1457-1473`) | [AI scheduler](../../features/ai-scheduler.md) | [ai-and-proposals](./erd-ai-and-proposals.md) |
| `ai_scheduler_runs` | `aiSchedulerRuns` | ai-and-proposals | one scheduler model/solver run (audit) (`schema.ts:1475-1497`) | [AI scheduler](../../features/ai-scheduler.md) | [ai-and-proposals](./erd-ai-and-proposals.md) |
| `ai_scheduler_feedback` | `aiSchedulerFeedback` | ai-and-proposals | one staff feedback/correction event on a scheduler run (`schema.ts:1499-1522`) | [AI scheduler](../../features/ai-scheduler.md) | [ai-and-proposals](./erd-ai-and-proposals.md) |

### LINE

Line ranges: `schema.ts:1526-1740`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `line_contacts` | `lineContacts` | line | one LINE contact (unique on `line_user_id`) (`schema.ts:1526-1542`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_threads` | `lineThreads` | line | one LINE conversation thread per contact (unique on `line_user_id`) (`schema.ts:1544-1558`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_messages` | `lineMessages` | line | one LINE message (unique on `webhook_event_id` and `line_message_id`) (`schema.ts:1560-1593`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_contact_student_links` | `lineContactStudentLinks` | line | one contact→student link (unique on `contact_id`+`student_key`) (`schema.ts:1595-1621`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_scheduler_reviews` | `lineSchedulerReviews` | line | one scheduler review for an inbound LINE message (unique on `inbound_message_id`) (`schema.ts:1623-1670`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_wise_action_logs` | `lineWiseActionLogs` | line | one Wise writeback action attempted from a LINE review (`schema.ts:1672-1687`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_oa_resolver_runs` | `lineOaResolverRuns` | line | one OA-resolver run (unique on `token_hash`) (`schema.ts:1689-1713`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |
| `line_oa_resolver_rows` | `lineOaResolverRows` | line | one student worklist row in a resolver run (unique on run+student+code) (`schema.ts:1715-1740`) | [LINE integration](../../features/line-integration.md) | [line](./erd-line.md) |

### Room Capacity

Line ranges: `schema.ts:1785-1858`.

| Table | Const | Domain | Grain (one row per …) | Owning feature | ERD |
|---|---|---|---|---|---|
| `room_capacity_model_runs` | `roomCapacityModelRuns` | room-capacity | one capacity-forecast model run (unique on `source_fingerprint`) (`schema.ts:1785-1797`) | [Room capacity](../../features/room-capacity.md) | [room-capacity](./erd-room-capacity.md) |
| `room_capacity_forecast_drivers` | `roomCapacityForecastDrivers` | room-capacity | one scenario+month forecast driver row within a model run (`schema.ts:1799-1820`) | [Room capacity](../../features/room-capacity.md) | [room-capacity](./erd-room-capacity.md) |
| `room_capacity_demand_mix` | `roomCapacityDemandMix` | room-capacity | one weekday/time demand-mix bucket within a model run (`schema.ts:1822-1838`) | [Room capacity](../../features/room-capacity.md) | [room-capacity](./erd-room-capacity.md) |
| `room_capacity_package_mix` | `roomCapacityPackageMix` | room-capacity | one package-hour bucket within a model run (`schema.ts:1840-1858`) | [Room capacity](../../features/room-capacity.md) | [room-capacity](./erd-room-capacity.md) |

## Notes & caveats

- **Domain vs. owning feature.** `room_utilization_sessions` is grouped in the **core**
  domain (it is a snapshot-independent Wise-session capture defined in the core section
  of `schema.ts`), but it is written and read by
  [`src/lib/room-capacity/utilization.ts`](../../../src/lib/room-capacity/utilization.ts),
  so its owning feature is Room capacity. Similarly `google_oauth_tokens` is a core/auth
  table but is exercised by the Sales Dashboard and Leave Requests Google integrations.
- **Snapshot scoping.** Tables in the Core (tutor/normalization) and Credit Control
  sections carry a `snapshotId`/`snapshot_id` FK; their grain is *within a snapshot*. The
  exceptions are flagged inline above and in [erd-core.md](./erd-core.md).
- **Enums.** Several `status`/`category`/`role` columns are Postgres enums declared at the
  top of `schema.ts` (`schema.ts:19-161`); their allowed values are listed on the relevant
  `erd-*.md` page, not here.

_Verified against HEAD + uncommitted WIP on 2026-05-31._
