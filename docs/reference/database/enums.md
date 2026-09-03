# Database Reference — Postgres Enums

The canonical lookup for every native Postgres enum type in the BGScheduler database: **61 enum
types** binding **102 columns**. All 61 are declared as Drizzle `pgEnum` constants in the
`// ── Enums ──` block at the top of [`src/lib/db/schema.ts`](../../../src/lib/db/schema.ts)
(lines 19–452, where line 19 is the section-header comment and line 452 closes the last
declaration). Both counts are mechanical:

- `grep -c "= pgEnum(" src/lib/db/schema.ts` → `61`
- enum-typed column declarations (`someEnum("column_name")` outside the declaration block) → `102`

Every one of the 61 also exists as a `CREATE TYPE "public"."…" AS ENUM (…)` statement in
[`drizzle/`](../../../drizzle) (69 `.sql` migrations at this revision, latest
`0068_payout_adjustment_superseded.sql`); `grep -rho 'CREATE TYPE "public"\."[a-z_]*"' drizzle/*.sql
| sort -u | wc -l` → `61`, and the two name sets match exactly.

This page owns the **mechanical** detail — SQL type name, Drizzle constant, declaration site,
allowed values in declaration order, and every table/column that binds the type with its
nullability and default. What a value *means* to the business, and which transitions are legal,
belongs to the owning feature doc under [`docs/features/`](../../features/); each section links
there rather than restating it. Table grain, columns, and indexes live in
[`index.md`](./index.md) and the `erd-*.md` pages.

## How to read an entry

- **Declaration order is SQL sort order.** Postgres orders enum values by their creation order, not
  alphabetically, so `ORDER BY status` and `<`/`>` comparisons follow the order printed here. A
  value added later by `ALTER TYPE … ADD VALUE` lands wherever the migration placed it — see
  [Enums extended after creation](#enums-extended-after-creation).
- **"Column bindings" counts schema-level bindings only** — a column whose Drizzle type *is* the
  `pgEnum` constant. Strings that merely look like states (application-level unions, JSONB payload
  fields, `CHECK`-constrained `text` columns) are not enum members; the enum-shaped `text` columns
  are collected in the [appendix](#appendix-enum-shaped-text-columns).
- **`schema.ts` column** in each table cites the line of the column declaration.
- **Default** is the Drizzle `.default("…")` argument, or `—` when the column has no default.
- **Adding a value requires a migration.** Editing the `pgEnum` array alone changes TypeScript
  only; Postgres needs `ALTER TYPE … ADD VALUE`, which is what `npm run db:generate` emits.

## Index

61 types in declaration order.

| # | SQL type | Drizzle constant | Values | Declared | Bindings |
|---:|---|---|---:|---|---:|
| 1 | [`sync_status`](#sync_status) | `syncStatusEnum` | 3 | `schema.ts:21` | 15 |
| 2 | [`data_issue_type`](#data_issue_type) | `dataIssueTypeEnum` | 6 | `schema.ts:27` | 1 |
| 3 | [`data_issue_severity`](#data_issue_severity) | `dataIssueSeverityEnum` | 4 | `schema.ts:36` | 1 |
| 4 | [`modality`](#modality) | `modalityEnum` | 4 | `schema.ts:43` | 2 |
| 5 | [`classroom_room_category`](#classroom_room_category) | `classroomRoomCategoryEnum` | 3 | `schema.ts:50` | 1 |
| 6 | [`classroom_assignment_run_status`](#classroom_assignment_run_status) | `classroomAssignmentRunStatusEnum` | 4 | `schema.ts:56` | 1 |
| 7 | [`classroom_assignment_row_status`](#classroom_assignment_row_status) | `classroomAssignmentRowStatusEnum` | 4 | `schema.ts:63` | 1 |
| 8 | [`classroom_publish_status`](#classroom_publish_status) | `classroomPublishStatusEnum` | 4 | `schema.ts:70` | 1 |
| 9 | [`classroom_publish_job_status`](#classroom_publish_job_status) | `classroomPublishJobStatusEnum` | 5 | `schema.ts:77` | 1 |
| 10 | [`proposal_scope`](#proposal_scope) | `proposalScopeEnum` | 2 | `schema.ts:85` | 1 |
| 11 | [`proposal_status`](#proposal_status) | `proposalStatusEnum` | 5 | `schema.ts:90` | 1 |
| 12 | [`ai_scheduler_conversation_status`](#ai_scheduler_conversation_status) | `aiSchedulerConversationStatusEnum` | 2 | `schema.ts:98` | 1 |
| 13 | [`ai_scheduler_message_role`](#ai_scheduler_message_role) | `aiSchedulerMessageRoleEnum` | 4 | `schema.ts:103` | 1 |
| 14 | [`line_message_direction`](#line_message_direction) | `lineMessageDirectionEnum` | 2 | `schema.ts:110` | 1 |
| 15 | [`line_scheduler_classifier_category`](#line_scheduler_classifier_category) | `lineSchedulerClassifierCategoryEnum` | 4 | `schema.ts:115` | 3 |
| 16 | [`line_scheduler_review_status`](#line_scheduler_review_status) | `lineSchedulerReviewStatusEnum` | 5 | `schema.ts:122` | 1 |
| 17 | [`line_contact_student_link_status`](#line_contact_student_link_status) | `lineContactStudentLinkStatusEnum` | 3 | `schema.ts:130` | 1 |
| 18 | [`student_promotion_run_status`](#student_promotion_run_status) | `studentPromotionRunStatusEnum` | 6 | `schema.ts:136` | 1 |
| 19 | [`student_promotion_action_status`](#student_promotion_action_status) | `studentPromotionActionStatusEnum` | 4 | `schema.ts:145` | 3 |
| 20 | [`sales_dashboard_source_status`](#sales_dashboard_source_status) | `salesDashboardSourceStatusEnum` | 5 | `schema.ts:152` | 2 |
| 21 | [`payroll_review_status`](#payroll_review_status) | `payrollReviewStatusEnum` | 2 | `schema.ts:160` | 1 |
| 22 | [`leave_request_workflow_status`](#leave_request_workflow_status) | `leaveRequestWorkflowStatusEnum` | 6 | `schema.ts:165` | 1 |
| 23 | [`leave_request_sheet_write_status`](#leave_request_sheet_write_status) | `leaveRequestSheetWriteStatusEnum` | 4 | `schema.ts:174` | 1 |
| 24 | [`progress_test_status`](#progress_test_status) | `progressTestStatusEnum` | 5 | `schema.ts:181` | 1 |
| 25 | [`progress_test_booking_status`](#progress_test_booking_status) | `progressTestBookingStatusEnum` | 6 | `schema.ts:189` | 1 |
| 26 | [`competitor_sync_trigger`](#competitor_sync_trigger) | `competitorSyncTriggerEnum` | 3 | `schema.ts:198` | 1 |
| 27 | [`competitor_entity_kind`](#competitor_entity_kind) | `competitorEntityKindEnum` | 2 | `schema.ts:204` | 1 |
| 28 | [`competitor_source_type`](#competitor_source_type) | `competitorSourceTypeEnum` | 6 | `schema.ts:209` | 3 |
| 29 | [`competitor_source_status`](#competitor_source_status) | `competitorSourceStatusEnum` | 4 | `schema.ts:218` | 2 |
| 30 | [`competitor_task_status`](#competitor_task_status) | `competitorTaskStatusEnum` | 5 | `schema.ts:225` | 1 |
| 31 | [`post_class_source_status`](#post_class_source_status) | `postClassSourceStatusEnum` | 4 | `schema.ts:233` | 3 |
| 32 | [`post_class_content_status`](#post_class_content_status) | `postClassContentStatusEnum` | 3 | `schema.ts:240` | 2 |
| 33 | [`post_class_timing_status`](#post_class_timing_status) | `postClassTimingStatusEnum` | 4 | `schema.ts:246` | 2 |
| 34 | [`post_class_deduction_status`](#post_class_deduction_status) | `postClassDeductionStatusEnum` | 6 | `schema.ts:253` | 5 |
| 35 | [`post_class_enforcement_mode`](#post_class_enforcement_mode) | `postClassEnforcementModeEnum` | 3 | `schema.ts:262` | 4 |
| 36 | [`post_class_capability`](#post_class_capability) | `postClassCapabilityEnum` | 4 | `schema.ts:268` | 1 |
| 37 | [`post_class_feedback_provenance`](#post_class_feedback_provenance) | `postClassFeedbackProvenanceEnum` | 3 | `schema.ts:275` | 1 |
| 38 | [`post_class_notification_kind`](#post_class_notification_kind) | `postClassNotificationKindEnum` | 4 | `schema.ts:281` | 1 |
| 39 | [`post_class_notification_status`](#post_class_notification_status) | `postClassNotificationStatusEnum` | 5 | `schema.ts:288` | 3 |
| 40 | [`post_class_ai_status`](#post_class_ai_status) | `postClassAiStatusEnum` | 4 | `schema.ts:296` | 1 |
| 41 | [`post_class_concern_decision`](#post_class_concern_decision) | `postClassConcernDecisionEnum` | 3 | `schema.ts:303` | 2 |
| 42 | [`post_class_finance_period_status`](#post_class_finance_period_status) | `postClassFinancePeriodStatusEnum` | 2 | `schema.ts:309` | 1 |
| 43 | [`post_class_payout_run_status`](#post_class_payout_run_status) | `postClassPayoutRunStatusEnum` | 5 | `schema.ts:314` | 1 |
| 44 | [`post_class_payout_match_status`](#post_class_payout_match_status) | `postClassPayoutMatchStatusEnum` | 5 | `schema.ts:322` | 1 |
| 45 | [`post_class_payout_write_status`](#post_class_payout_write_status) | `postClassPayoutWriteStatusEnum` | 4 | `schema.ts:330` | 1 |
| 46 | [`admissions_case_status`](#admissions_case_status) | `admissionsCaseStatusEnum` | 5 | `schema.ts:337` | 1 |
| 47 | [`admissions_member_role`](#admissions_member_role) | `admissionsMemberRoleEnum` | 3 | `schema.ts:345` | 1 |
| 48 | [`admissions_member_status`](#admissions_member_status) | `admissionsMemberStatusEnum` | 4 | `schema.ts:351` | 1 |
| 49 | [`admissions_task_status`](#admissions_task_status) | `admissionsTaskStatusEnum` | 3 | `schema.ts:358` | 2 |
| 50 | [`admissions_task_owner`](#admissions_task_owner) | `admissionsTaskOwnerEnum` | 3 | `schema.ts:364` | 3 |
| 51 | [`admissions_app_round`](#admissions_app_round) | `admissionsAppRoundEnum` | 8 | `schema.ts:370` | 1 |
| 52 | [`admissions_app_status`](#admissions_app_status) | `admissionsAppStatusEnum` | 4 | `schema.ts:381` | 1 |
| 53 | [`admissions_decision_event`](#admissions_decision_event) | `admissionsDecisionEventEnum` | 7 | `schema.ts:388` | 1 |
| 54 | [`admissions_essay_status`](#admissions_essay_status) | `admissionsEssayStatusEnum` | 5 | `schema.ts:398` | 2 |
| 55 | [`admissions_test_type`](#admissions_test_type) | `admissionsTestTypeEnum` | 7 | `schema.ts:406` | 1 |
| 56 | [`admissions_test_sitting_status`](#admissions_test_sitting_status) | `admissionsTestSittingStatusEnum` | 5 | `schema.ts:416` | 1 |
| 57 | [`admissions_notification_outbox_status`](#admissions_notification_outbox_status) | `admissionsNotificationOutboxStatusEnum` | 4 | `schema.ts:424` | 1 |
| 58 | [`admissions_note_visibility`](#admissions_note_visibility) | `admissionsNoteVisibilityEnum` | 2 | `schema.ts:429` | 1 |
| 59 | [`admissions_rec_status`](#admissions_rec_status) | `admissionsRecStatusEnum` | 4 | `schema.ts:434` | 1 |
| 60 | [`admissions_submission_state`](#admissions_submission_state) | `admissionsSubmissionStateEnum` | 3 | `schema.ts:441` | 1 |
| 61 | [`admissions_college_category`](#admissions_college_category) | `admissionsCollegeCategoryEnum` | 4 | `schema.ts:447` | 1 |

## Three facts that cut across the catalog

**`sync_status` is the shared run-ledger vocabulary, and `'running'` is a lock.** Fifteen
`*_runs` tables type their `status` column with it, and thirteen of them additionally carry a
partial unique index — named `*_single_running_idx` — whose predicate is
``.where(sql`${table.status} = 'running'`)``, which makes Postgres itself the single-flight guard: a
second concurrent run cannot insert its `running` row (`schema.ts:473`, `567`, `666`, `758`, `864`,
`1177`, `1776`, `2110`, `2680`, `2995`, `3019`, `3246`, `4568`). The two sales-dashboard variants
scope the guard per source (`… AND ${table.sourceId} IS NOT NULL`, `schema.ts:668`, `760`). The two
`sync_status` columns with **no** such index are `competitor_source_runs.status` and
`competitor_ai_runs.status` — per-source and per-AI-call child ledgers under a parent
`competitor_sync_runs` row that does hold the lock.

**`modality` encodes the fail-closed rule as a value.** Both bindings default to `unresolved`
(`schema.ts:1524`, `1600`), and the normalizer emits `unresolved` rather than guessing when a
single offline record carries no further evidence (`src/lib/normalization/modality.ts:68-70`, `83`).
Downstream, `unresolved` routes a tutor to "Needs review", never to "Available".

**Application code almost never reflects over these types.** Only two files read `.enumValues` to
derive a TypeScript union — `src/lib/progress-tests/booking.ts:45` and
`src/lib/sync/orchestrator.ts:308`. Everywhere else the values are written as string literals, so a
value rename is a find-and-replace across `src/`, not a type-level refactor.

The catalog below is grouped by owning subsystem, in declaration order.

## Core — snapshot, sync, and normalization

Meaning, rules, and flows: [tutor-search](../../features/tutor-search.md) · [data-health](../../features/data-health.md).

### `sync_status`

Drizzle constant `syncStatusEnum` · declared at [`schema.ts:21`](../../../src/lib/db/schema.ts#L21) · 3 values · 15 column bindings.

**Values** (declaration order = SQL sort order): `running` · `success` · `failed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_notification_runs` | `status` | 4559 | `NOT NULL` | `running` |
| `competitor_ai_runs` | `status` | 1000 | `NOT NULL` | `running` |
| `competitor_source_runs` | `status` | 878 | `NOT NULL` | `running` |
| `competitor_sync_runs` | `status` | 846 | `NOT NULL` | `running` |
| `credit_control_sync_runs` | `status` | 1164 | `NOT NULL` | `running` |
| `ipeds_import_runs` | `status` | 3010 | `NOT NULL` | `running` |
| `leave_request_sync_runs` | `status` | 2098 | `NOT NULL` | `running` |
| `line_backlog_recovery_sync_runs` | `status` | 2668 | `NOT NULL` | `running` |
| `payroll_sync_runs` | `status` | 1766 | `NOT NULL` | `running` |
| `post_class_sync_runs` | `status` | 3228 | `NOT NULL` | `running` |
| `progress_test_sync_runs` | `status` | 2980 | `NOT NULL` | `running` |
| `sales_dashboard_import_runs` | `status` | 653 | `NOT NULL` | `running` |
| `sales_dashboard_projection_import_runs` | `status` | 746 | `NOT NULL` | `running` |
| `sync_runs` | `status` | 464 | `NOT NULL` | `running` |
| `wise_activity_sync_runs` | `status` | 555 | `NOT NULL` | `running` |

### `data_issue_type`

Drizzle constant `dataIssueTypeEnum` · declared at [`schema.ts:27`](../../../src/lib/db/schema.ts#L27) · 6 values · 1 column binding.

**Values** (declaration order = SQL sort order): `alias` · `modality` · `tag` · `completeness` · `conflict_model` · `sync`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `data_issues` | `type` | 2691 | `NOT NULL` | — |

### `data_issue_severity`

Drizzle constant `dataIssueSeverityEnum` · declared at [`schema.ts:36`](../../../src/lib/db/schema.ts#L36) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `critical` · `high` · `medium` · `low`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `data_issues` | `severity` | 2692 | `NOT NULL` | `high` |

### `modality`

Drizzle constant `modalityEnum` · declared at [`schema.ts:43`](../../../src/lib/db/schema.ts#L43) · 4 values · 2 column bindings.

**Values** (declaration order = SQL sort order): `online` · `onsite` · `both` · `unresolved`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `recurring_availability_windows` | `modality` | 1600 | `NOT NULL` | `unresolved` |
| `tutor_identity_groups` | `supported_modality` | 1524 | `NOT NULL` | `unresolved` |

## Classroom assignments

Meaning, rules, and flows: [classroom-assignments](../../features/classroom-assignments.md).

### `classroom_room_category`

Drizzle constant `classroomRoomCategoryEnum` · declared at [`schema.ts:50`](../../../src/lib/db/schema.ts#L50) · 3 values · 1 column binding.

**Values** (declaration order = SQL sort order): `standard` · `overflow_only` · `online_only`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `classroom_rooms` | `category` | 1654 | `NOT NULL` | `standard` |

### `classroom_assignment_run_status`

Drizzle constant `classroomAssignmentRunStatusEnum` · declared at [`schema.ts:56`](../../../src/lib/db/schema.ts#L56) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `completed` · `published` · `partial` · `failed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `classroom_assignment_runs` | `status` | 1668 | `NOT NULL` | `completed` |

### `classroom_assignment_row_status`

Drizzle constant `classroomAssignmentRowStatusEnum` · declared at [`schema.ts:63`](../../../src/lib/db/schema.ts#L63) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `assigned` · `needs_review` · `no_room` · `remote`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `classroom_assignment_rows` | `status` | 1718 | `NOT NULL` | `assigned` |

### `classroom_publish_status`

Drizzle constant `classroomPublishStatusEnum` · declared at [`schema.ts:70`](../../../src/lib/db/schema.ts#L70) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `not_published` · `skipped` · `success` · `failed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `classroom_assignment_rows` | `publish_status` | 1724 | `NOT NULL` | `not_published` |

### `classroom_publish_job_status`

Drizzle constant `classroomPublishJobStatusEnum` · declared at [`schema.ts:77`](../../../src/lib/db/schema.ts#L77) · 5 values · 1 column binding.

**Values** (declaration order = SQL sort order): `pending` · `running` · `succeeded` · `partial` · `failed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `classroom_publish_jobs` | `status` | 1927 | `NOT NULL` | `pending` |

## Proposals (admin holds)

Meaning, rules, and flows: [proposals](../../features/proposals.md).

### `proposal_scope`

Drizzle constant `proposalScopeEnum` · declared at [`schema.ts:85`](../../../src/lib/db/schema.ts#L85) · 2 values · 1 column binding.

**Values** (declaration order = SQL sort order): `recurring` · `one_time`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `proposal_items` | `scope` | 2321 | `NOT NULL` | — |

### `proposal_status`

Drizzle constant `proposalStatusEnum` · declared at [`schema.ts:90`](../../../src/lib/db/schema.ts#L90) · 5 values · 1 column binding.

**Values** (declaration order = SQL sort order): `pending` · `confirmed` · `released` · `expired` · `auto_resolved`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `proposal_items` | `status` | 2329 | `NOT NULL` | `pending` |

## AI scheduler

Meaning, rules, and flows: [ai-scheduler](../../features/ai-scheduler.md).

### `ai_scheduler_conversation_status`

Drizzle constant `aiSchedulerConversationStatusEnum` · declared at [`schema.ts:98`](../../../src/lib/db/schema.ts#L98) · 2 values · 1 column binding.

**Values** (declaration order = SQL sort order): `active` · `archived`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `ai_scheduler_conversations` | `status` | 2350 | `NOT NULL` | `active` |

### `ai_scheduler_message_role`

Drizzle constant `aiSchedulerMessageRoleEnum` · declared at [`schema.ts:103`](../../../src/lib/db/schema.ts#L103) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `admin` · `parent` · `assistant` · `system`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `ai_scheduler_messages` | `role` | 2373 | `NOT NULL` | — |

## LINE integration

Meaning, rules, and flows: [line-integration](../../features/line-integration.md).

### `line_message_direction`

Drizzle constant `lineMessageDirectionEnum` · declared at [`schema.ts:110`](../../../src/lib/db/schema.ts#L110) · 2 values · 1 column binding.

**Values** (declaration order = SQL sort order): `inbound` · `outbound`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `line_messages` | `direction` | 2475 | `NOT NULL` | — |

### `line_scheduler_classifier_category`

Drizzle constant `lineSchedulerClassifierCategoryEnum` · declared at [`schema.ts:115`](../../../src/lib/db/schema.ts#L115) · 4 values · 3 column bindings.

**Values** (declaration order = SQL sort order): `scheduling_request` · `scheduling_change` · `non_scheduling` · `unclear`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `line_messages` | `classification_reviewed_category` | 2491 | nullable | — |
| `line_messages` | `classifier_category` | 2486 | nullable | — |
| `line_scheduler_reviews` | `classifier_category` | 2560 | `NOT NULL` | — |

### `line_scheduler_review_status`

Drizzle constant `lineSchedulerReviewStatusEnum` · declared at [`schema.ts:122`](../../../src/lib/db/schema.ts#L122) · 5 values · 1 column binding.

**Values** (declaration order = SQL sort order): `pending_review` · `approved_sent` · `accepted_no_send` · `rejected` · `dismissed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `line_scheduler_reviews` | `status` | 2564 | `NOT NULL` | `pending_review` |

### `line_contact_student_link_status`

Drizzle constant `lineContactStudentLinkStatusEnum` · declared at [`schema.ts:130`](../../../src/lib/db/schema.ts#L130) · 3 values · 1 column binding.

**Values** (declaration order = SQL sort order): `suggested` · `verified` · `rejected`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `line_contact_student_links` | `status` | 2513 | `NOT NULL` | `suggested` |

## Student promotions

Meaning, rules, and flows: [student-promotions](../../features/student-promotions.md).

### `student_promotion_run_status`

Drizzle constant `studentPromotionRunStatusEnum` · declared at [`schema.ts:136`](../../../src/lib/db/schema.ts#L136) · 6 values · 1 column binding.

**Values** (declaration order = SQL sort order): `draft` · `verified` · `applying` · `applied` · `applied_with_errors` · `failed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `student_promotion_runs` | `status` | 1349 | `NOT NULL` | `draft` |

### `student_promotion_action_status`

Drizzle constant `studentPromotionActionStatusEnum` · declared at [`schema.ts:145`](../../../src/lib/db/schema.ts#L145) · 4 values · 3 column bindings.

**Values** (declaration order = SQL sort order): `pending` · `skipped` · `applied` · `failed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `student_promotion_course_actions` | `status` | 1412 | `NOT NULL` | `pending` |
| `student_promotion_future_session_actions` | `status` | 1437 | `NOT NULL` | `pending` |
| `student_promotion_grade_actions` | `status` | 1389 | `NOT NULL` | `pending` |

## Sales dashboard

Meaning, rules, and flows: [sales-dashboard](../../features/sales-dashboard.md).

### `sales_dashboard_source_status`

Drizzle constant `salesDashboardSourceStatusEnum` · declared at [`schema.ts:152`](../../../src/lib/db/schema.ts#L152) · 5 values · 2 column bindings.

**Values** (declaration order = SQL sort order): `active` · `refreshing` · `finalized` · `reopened` · `archived`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `sales_dashboard_sources` | `status` | 626 | `NOT NULL` | `active` |
| `sales_dashboard_sources` | `status_before_archive` | 636 | nullable | — |

## Payroll

Meaning, rules, and flows: [payroll](../../features/payroll.md).

### `payroll_review_status`

Drizzle constant `payrollReviewStatusEnum` · declared at [`schema.ts:160`](../../../src/lib/db/schema.ts#L160) · 2 values · 1 column binding.

**Values** (declaration order = SQL sort order): `draft` · `approved`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `payroll_reviews` | `status` | 1786 | `NOT NULL` | `draft` |

## Leave requests

Meaning, rules, and flows: [leave-requests](../../features/leave-requests.md).

### `leave_request_workflow_status`

Drizzle constant `leaveRequestWorkflowStatusEnum` · declared at [`schema.ts:165`](../../../src/lib/db/schema.ts#L165) · 6 values · 1 column binding.

**Values** (declaration order = SQL sort order): `new` · `needs_review` · `in_progress` · `done` · `ignored` · `canceled_by_tutor`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `leave_requests` | `workflow_status` | 2147 | `NOT NULL` | `new` |

### `leave_request_sheet_write_status`

Drizzle constant `leaveRequestSheetWriteStatusEnum` · declared at [`schema.ts:174`](../../../src/lib/db/schema.ts#L174) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `not_required` · `pending` · `success` · `failed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `leave_requests` | `sheet_write_status` | 2150 | `NOT NULL` | `not_required` |

## Progress tests

Meaning, rules, and flows: [progress-tests](../../features/progress-tests.md).

### `progress_test_status`

Drizzle constant `progressTestStatusEnum` · declared at [`schema.ts:181`](../../../src/lib/db/schema.ts#L181) · 5 values · 1 column binding.

**Values** (declaration order = SQL sort order): `accumulating` · `approaching` · `due` · `scheduled` · `completed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `progress_test_cycle_state` | `status` | 2851 | `NOT NULL` | `accumulating` |

### `progress_test_booking_status`

Drizzle constant `progressTestBookingStatusEnum` · declared at [`schema.ts:189`](../../../src/lib/db/schema.ts#L189) · 6 values · 1 column binding.

**Values** (declaration order = SQL sort order): `recorded` · `dry_run` · `wise_created` · `manual_required` · `manual_confirmed` · `failed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `progress_test_bookings` | `status` | 2881 | `NOT NULL` | `recorded` |

## Competitor intelligence

Meaning, rules, and flows: [competitor-intelligence](../../features/competitor-intelligence.md).

### `competitor_sync_trigger`

Drizzle constant `competitorSyncTriggerEnum` · declared at [`schema.ts:198`](../../../src/lib/db/schema.ts#L198) · 3 values · 1 column binding.

**Values** (declaration order = SQL sort order): `cron` · `manual` · `backfill`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `competitor_sync_runs` | `trigger_type` | 847 | `NOT NULL` | `manual` |

### `competitor_entity_kind`

Drizzle constant `competitorEntityKindEnum` · declared at [`schema.ts:204`](../../../src/lib/db/schema.ts#L204) · 2 values · 1 column binding.

**Values** (declaration order = SQL sort order): `competitor` · `own_brand`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `competitor_entities` | `kind` | 799 | `NOT NULL` | `competitor` |

### `competitor_source_type`

Drizzle constant `competitorSourceTypeEnum` · declared at [`schema.ts:209`](../../../src/lib/db/schema.ts#L209) · 6 values · 3 column bindings.

**Values** (declaration order = SQL sort order): `website` · `sitemap` · `instagram` · `facebook` · `serp` · `manual`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `competitor_source_runs` | `source_type` | 877 | `NOT NULL` | — |
| `competitor_sources` | `source_type` | 819 | `NOT NULL` | — |
| `competitor_vendor_usage` | `source_type` | 1136 | `NOT NULL` | — |

### `competitor_source_status`

Drizzle constant `competitorSourceStatusEnum` · declared at [`schema.ts:218`](../../../src/lib/db/schema.ts#L218) · 4 values · 2 column bindings.

**Values** (declaration order = SQL sort order): `active` · `disabled` · `needs_review` · `archived`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `competitor_serp_keywords` | `status` | 953 | `NOT NULL` | `active` |
| `competitor_sources` | `status` | 825 | `NOT NULL` | `active` |

### `competitor_task_status`

Drizzle constant `competitorTaskStatusEnum` · declared at [`schema.ts:225`](../../../src/lib/db/schema.ts#L225) · 5 values · 1 column binding.

**Values** (declaration order = SQL sort order): `todo` · `in_progress` · `blocked` · `done` · `ignored`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `competitor_tasks` | `status` | 1093 | `NOT NULL` | `todo` |

## Post-class feedback

Meaning, rules, and flows: [post-class-feedback](../../features/post-class-feedback.md).

### `post_class_source_status`

Drizzle constant `postClassSourceStatusEnum` · declared at [`schema.ts:233`](../../../src/lib/db/schema.ts#L233) · 4 values · 3 column bindings.

**Values** (declaration order = SQL sort order): `ready` · `unavailable` · `form_drift` · `identity_review`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_assessments` | `source_status` | 3379 | `NOT NULL` | — |
| `post_class_sessions` | `source_status` | 3270 | `NOT NULL` | `unavailable` |
| `post_class_sessions` | `source_status_before` | 3275 | nullable | — |

### `post_class_content_status`

Drizzle constant `postClassContentStatusEnum` · declared at [`schema.ts:240`](../../../src/lib/db/schema.ts#L240) · 3 values · 2 column bindings.

**Values** (declaration order = SQL sort order): `missing` · `blank` · `substantive`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_assessments` | `content_status` | 3380 | `NOT NULL` | — |
| `post_class_sessions` | `content_status` | 3283 | `NOT NULL` | `missing` |

### `post_class_timing_status`

Drizzle constant `postClassTimingStatusEnum` · declared at [`schema.ts:246`](../../../src/lib/db/schema.ts#L246) · 4 values · 2 column bindings.

**Values** (declaration order = SQL sort order): `not_due` · `on_time` · `late` · `unknown`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_assessments` | `timing_status` | 3381 | `NOT NULL` | — |
| `post_class_sessions` | `timing_status` | 3284 | `NOT NULL` | `not_due` |

### `post_class_deduction_status`

Drizzle constant `postClassDeductionStatusEnum` · declared at [`schema.ts:253`](../../../src/lib/db/schema.ts#L253) · 6 values · 5 column bindings.

**Values** (declaration order = SQL sort order): `none` · `pending_review` · `approved` · `waived` · `processed` · `reversed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_assessments` | `deduction_status` | 3382 | `NOT NULL` | `none` |
| `post_class_deduction_actions` | `from_status` | 3598 | nullable | — |
| `post_class_deduction_actions` | `to_status` | 3599 | `NOT NULL` | — |
| `post_class_deductions` | `status` | 3573 | `NOT NULL` | `pending_review` |
| `post_class_sessions` | `deduction_status` | 3285 | `NOT NULL` | `none` |

### `post_class_enforcement_mode`

Drizzle constant `postClassEnforcementModeEnum` · declared at [`schema.ts:262`](../../../src/lib/db/schema.ts#L262) · 3 values · 4 column bindings.

**Values** (declaration order = SQL sort order): `shadow` · `live` · `paused`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_assessments` | `enforcement_mode` | 3383 | `NOT NULL` | — |
| `post_class_enforcement_windows` | `mode` | 3143 | `NOT NULL` | — |
| `post_class_sessions` | `enforcement_mode` | 3288 | `NOT NULL` | `shadow` |
| `post_class_settings` | `enforcement_mode` | 3157 | `NOT NULL` | `shadow` |

### `post_class_capability`

Drizzle constant `postClassCapabilityEnum` · declared at [`schema.ts:268`](../../../src/lib/db/schema.ts#L268) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `viewer` · `reviewer` · `finance` · `access_manager`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_access_grants` | `capability` | 3190 | `NOT NULL` | — |

### `post_class_feedback_provenance`

Drizzle constant `postClassFeedbackProvenanceEnum` · declared at [`schema.ts:275`](../../../src/lib/db/schema.ts#L275) · 3 values · 1 column binding.

**Values** (declaration order = SQL sort order): `manual` · `auto` · `unknown`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_feedback_versions` | `provenance` | 3333 | `NOT NULL` | `unknown` |

### `post_class_notification_kind`

Drizzle constant `postClassNotificationKindEnum` · declared at [`schema.ts:281`](../../../src/lib/db/schema.ts#L281) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `tutor_day_after` · `tutor_deadline` · `admin_digest` · `test`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_notification_runs` | `kind` | 3427 | `NOT NULL` | — |

### `post_class_notification_status`

Drizzle constant `postClassNotificationStatusEnum` · declared at [`schema.ts:288`](../../../src/lib/db/schema.ts#L288) · 5 values · 3 column bindings.

**Values** (declaration order = SQL sort order): `pending` · `sending` · `sent` · `failed` · `cancelled`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_notification_attempts` | `status` | 3492 | `NOT NULL` | — |
| `post_class_notification_deliveries` | `status` | 3456 | `NOT NULL` | `pending` |
| `post_class_notification_runs` | `status` | 3428 | `NOT NULL` | `pending` |

### `post_class_ai_status`

Drizzle constant `postClassAiStatusEnum` · declared at [`schema.ts:296`](../../../src/lib/db/schema.ts#L296) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `pending` · `running` · `succeeded` · `failed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_ai_runs` | `status` | 3507 | `NOT NULL` | `pending` |

### `post_class_concern_decision`

Drizzle constant `postClassConcernDecisionEnum` · declared at [`schema.ts:303`](../../../src/lib/db/schema.ts#L303) · 3 values · 2 column bindings.

**Values** (declaration order = SQL sort order): `pending` · `confirmed` · `dismissed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_ai_concerns` | `decision` | 3530 | `NOT NULL` | `pending` |
| `post_class_ai_reviews` | `decision` | 3542 | `NOT NULL` | — |

### `post_class_finance_period_status`

Drizzle constant `postClassFinancePeriodStatusEnum` · declared at [`schema.ts:309`](../../../src/lib/db/schema.ts#L309) · 2 values · 1 column binding.

**Values** (declaration order = SQL sort order): `open` · `closed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_finance_periods` | `status` | 3555 | `NOT NULL` | `open` |

### `post_class_payout_run_status`

Drizzle constant `postClassPayoutRunStatusEnum` · declared at [`schema.ts:314`](../../../src/lib/db/schema.ts#L314) · 5 values · 1 column binding.

**Values** (declaration order = SQL sort order): `draft` · `publishing` · `partial` · `published` · `closed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_payout_runs` | `status` | 3645 | `NOT NULL` | `draft` |

### `post_class_payout_match_status`

Drizzle constant `postClassPayoutMatchStatusEnum` · declared at [`schema.ts:322`](../../../src/lib/db/schema.ts#L322) · 5 values · 1 column binding.

**Values** (declaration order = SQL sort order): `pending` · `matched` · `unmatched` · `ambiguous` · `no_sheet`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_payout_run_lines` | `match_status` | 3790 | `NOT NULL` | `pending` |

### `post_class_payout_write_status`

Drizzle constant `postClassPayoutWriteStatusEnum` · declared at [`schema.ts:330`](../../../src/lib/db/schema.ts#L330) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `pending` · `written` · `failed` · `skipped`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `post_class_payout_run_lines` | `write_status` | 3802 | `NOT NULL` | `pending` |

## University admissions

Meaning, rules, and flows: [university-admissions](../../features/university-admissions.md).

### `admissions_case_status`

Drizzle constant `admissionsCaseStatusEnum` · declared at [`schema.ts:337`](../../../src/lib/db/schema.ts#L337) · 5 values · 1 column binding.

**Values** (declaration order = SQL sort order): `active` · `committed` · `completed` · `withdrawn` · `archived`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_cases` | `status` | 3999 | `NOT NULL` | `active` |

### `admissions_member_role`

Drizzle constant `admissionsMemberRoleEnum` · declared at [`schema.ts:345`](../../../src/lib/db/schema.ts#L345) · 3 values · 1 column binding.

**Values** (declaration order = SQL sort order): `counselor` · `student` · `parent`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_case_members` | `role` | 4024 | `NOT NULL` | — |

### `admissions_member_status`

Drizzle constant `admissionsMemberStatusEnum` · declared at [`schema.ts:351`](../../../src/lib/db/schema.ts#L351) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `invited` · `active` · `revoked` · `bounced`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_case_members` | `status` | 4025 | `NOT NULL` | `invited` |

### `admissions_task_status`

Drizzle constant `admissionsTaskStatusEnum` · declared at [`schema.ts:358`](../../../src/lib/db/schema.ts#L358) · 3 values · 2 column bindings.

**Values** (declaration order = SQL sort order): `not_started` · `in_progress` · `done`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_case_tasks` | `status` | 4095 | `NOT NULL` | `not_started` |
| `admissions_college_requirements` | `status` | 4193 | `NOT NULL` | `not_started` |

### `admissions_task_owner`

Drizzle constant `admissionsTaskOwnerEnum` · declared at [`schema.ts:364`](../../../src/lib/db/schema.ts#L364) · 3 values · 3 column bindings.

**Values** (declaration order = SQL sort order): `student` · `counselor` · `parent`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_case_tasks` | `owner` | 4094 | `NOT NULL` | — |
| `admissions_college_requirements` | `owner` | 4194 | `NOT NULL` | `student` |
| `admissions_template_items` | `default_owner` | 4076 | `NOT NULL` | `student` |

### `admissions_app_round`

Drizzle constant `admissionsAppRoundEnum` · declared at [`schema.ts:370`](../../../src/lib/db/schema.ts#L370) · 8 values · 1 column binding.

**Values** (declaration order = SQL sort order): `ed` · `ed2` · `ea` · `rea` · `rd` · `rolling` · `priority` · `other`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_college_list_items` | `round` | 4134 | `NOT NULL` | — |

### `admissions_app_status`

Drizzle constant `admissionsAppStatusEnum` · declared at [`schema.ts:381`](../../../src/lib/db/schema.ts#L381) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `researching` · `applying` · `submitted` · `complete`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_college_list_items` | `app_status` | 4136 | `NOT NULL` | `researching` |

### `admissions_decision_event`

Drizzle constant `admissionsDecisionEventEnum` · declared at [`schema.ts:388`](../../../src/lib/db/schema.ts#L388) · 7 values · 1 column binding.

**Values** (declaration order = SQL sort order): `submitted` · `deferred` · `waitlisted` · `accepted` · `denied` · `withdrawn` · `committed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_application_events` | `event` | 4252 | `NOT NULL` | — |

### `admissions_essay_status`

Drizzle constant `admissionsEssayStatusEnum` · declared at [`schema.ts:398`](../../../src/lib/db/schema.ts#L398) · 5 values · 2 column bindings.

**Values** (declaration order = SQL sort order): `not_started` · `brainstorming` · `drafting` · `feedback` · `final`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_essays` | `counselor_stage` | 4307 | nullable | — |
| `admissions_essays` | `status` | 4306 | `NOT NULL` | `not_started` |

### `admissions_test_type`

Drizzle constant `admissionsTestTypeEnum` · declared at [`schema.ts:406`](../../../src/lib/db/schema.ts#L406) · 7 values · 1 column binding.

**Values** (declaration order = SQL sort order): `sat` · `act` · `ap` · `ib` · `toefl` · `ielts` · `other`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_test_sittings` | `test_type` | 4398 | `NOT NULL` | — |

### `admissions_test_sitting_status`

Drizzle constant `admissionsTestSittingStatusEnum` · declared at [`schema.ts:416`](../../../src/lib/db/schema.ts#L416) · 5 values · 1 column binding.

**Values** (declaration order = SQL sort order): `planned` · `registered` · `taken` · `score_received` · `canceled`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_test_sittings` | `status` | 4402 | `NOT NULL` | `planned` |

### `admissions_notification_outbox_status`

Drizzle constant `admissionsNotificationOutboxStatusEnum` · declared at [`schema.ts:424`](../../../src/lib/db/schema.ts#L424) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `pending` · `processing` · `sent` · `failed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_notification_outbox` | `status` | 4541 | `NOT NULL` | `pending` |

### `admissions_note_visibility`

Drizzle constant `admissionsNoteVisibilityEnum` · declared at [`schema.ts:429`](../../../src/lib/db/schema.ts#L429) · 2 values · 1 column binding.

**Values** (declaration order = SQL sort order): `staff_only` · `shared_with_family`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_notes` | `visibility` | 4438 | `NOT NULL` | — |

### `admissions_rec_status`

Drizzle constant `admissionsRecStatusEnum` · declared at [`schema.ts:434`](../../../src/lib/db/schema.ts#L434) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `planned` · `asked` · `agreed` · `declined`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_recommenders` | `ask_status` | 4267 | `NOT NULL` | `planned` |

### `admissions_submission_state`

Drizzle constant `admissionsSubmissionStateEnum` · declared at [`schema.ts:441`](../../../src/lib/db/schema.ts#L441) · 3 values · 1 column binding.

**Values** (declaration order = SQL sort order): `draft` · `submitted` · `reviewed`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_self_report_sections` | `state` | 4485 | `NOT NULL` | `draft` |

### `admissions_college_category`

Drizzle constant `admissionsCollegeCategoryEnum` · declared at [`schema.ts:447`](../../../src/lib/db/schema.ts#L447) · 4 values · 1 column binding.

**Values** (declaration order = SQL sort order): `reach` · `match` · `safety` · `unset`

| Table | Column | `schema.ts` | Nullability | Default |
|---|---|---|---|---|
| `admissions_college_list_items` | `category` | 4137 | `NOT NULL` | `unset` |

## Enums extended after creation

Four types gained values after their initial `CREATE TYPE`. The added values sit at the position
the migration gave them, which is what the catalog above reflects.

| Type | Migration | Statement |
|---|---|---|
| `classroom_assignment_row_status` | `0004_round_rage.sql:1` | `ADD VALUE 'remote'` |
| `ai_scheduler_message_role` | `0017_line_scheduler_reviews.sql:4` | `ADD VALUE 'parent' BEFORE 'assistant'` |
| `sales_dashboard_source_status` | `0026_sales_dashboard_archival.sql:1` | `ADD VALUE 'archived'` |
| `post_class_payout_run_status` | `0060_post_class_payout_durable_runs.sql:25-31` | `ADD VALUE IF NOT EXISTS 'publishing'`, `'partial'`, `'closed'` |

`ai_scheduler_message_role` is the one case where the inserted value is not last, so its SQL sort
order is `admin` < `parent` < `assistant` < `system` — matching the declaration order in
`schema.ts:103`.

## Appendix: enum-shaped `text` columns

Seven columns look like enums and are not. They are `text` columns narrowed in TypeScript with
Drizzle's `.$type<…>()` and constrained in Postgres by a named `CHECK`, rather than by a
`CREATE TYPE`. All seven belong to the post-class payout write path, where the value set was still
moving when the tables landed; a `CHECK` can be replaced in one migration, while an enum value
cannot be removed at all. Treat these as state machines with the same weight as the enums above —
they are simply enforced differently.

| Table | Column | Allowed values | `$type` | `CHECK` |
|---|---|---|---|---|
| `post_class_payout_runs` | `csv_status` | `pending`, `uploaded`, `failed` | `schema.ts:3682` | `pc_payout_runs_csv_status_check` (`schema.ts:3704-3707`) |
| `post_class_payout_runs` | `date_roll_status` | `not_started`, `running`, `partial`, `completed` | `schema.ts:3688` | `pc_payout_runs_date_roll_status_check` (`schema.ts:3708-3711`) |
| `post_class_payout_adjustments` | `kind` | `waiver`, `reversal` | `schema.ts:3832` | `pc_payout_adjustments_kind_check` (`schema.ts:3859`) |
| `post_class_payout_adjustments` | `status` | `pending`, `written`, `failed`, `exception`, `superseded` | `schema.ts:3838` | `pc_payout_adjustments_status_check` (`schema.ts:3860-3863`) |
| `post_class_payout_exceptions` | `status` | `open`, `resolved` | `schema.ts:3874` | `pc_payout_exceptions_status_check` (`schema.ts:3891`) |
| `post_class_payout_roll_runs` | `status` | `running`, `partial`, `completed`, `failed` | `schema.ts:3902-3905` | `pc_payout_roll_runs_status_check` (`schema.ts:3920-3923`) |
| `post_class_payout_roll_outcomes` | `status` | `pending`, `already_target`, `verified`, `failed` | `schema.ts:3933-3936` | `pc_payout_roll_outcomes_status_check` (`schema.ts:3953-3956`) |

`post_class_payout_exceptions.kind` (`schema.ts:3873`) is unconstrained `text` — neither an enum,
nor `$type`-narrowed, nor `CHECK`-ed.

## See also

- [`index.md`](./index.md) — master table index, grain, and per-domain ERD pages
- [`../api/index.md`](../api/index.md) — the endpoints that read and write these state machines
- [`../../features/`](../../features/) — purpose, rules, and flows behind each subsystem

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
