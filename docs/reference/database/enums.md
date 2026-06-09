# Database Enums Reference

The 25 Postgres enums backing BGScheduler's typed status/category/role columns. All are declared as Drizzle `pgEnum` objects at the top of [`src/lib/db/schema.ts`](../../../src/lib/db/schema.ts) (lines 19–194), before any table definition. The Drizzle export name (`*Enum`, camelCase) wraps the underlying Postgres enum type (`snake_case`); the SQL type is what migrations create and what the database stores.

This page is the canonical home for the **mechanical** enum detail — allowed values, SQL type names, and the exact table/column each enum types. Feature docs link here rather than restating value lists. No TypeScript `enum` exists anywhere in the codebase (a project convention); these `pgEnum` declarations are the only enumerations, and code references their string members directly.

How to read the "Used by" column: `table.column` names the snake-case SQL table and the snake-case column the enum types. Defaults and nullability are noted where they are load-bearing (e.g. fail-closed defaults). Several enums are reused across many tables — `sync_status` types the `status` column on eight separate `*_sync_runs`/`*_import_runs` tables.

## Summary

| # | Drizzle export | SQL type | Values | Used by (`table.column`) |
|---|---|---|---|---|
| 1 | `syncStatusEnum` | `sync_status` | 3 | 8 tables (see below) |
| 2 | `dataIssueTypeEnum` | `data_issue_type` | 6 | `data_issues.type` |
| 3 | `dataIssueSeverityEnum` | `data_issue_severity` | 4 | `data_issues.severity` |
| 4 | `modalityEnum` | `modality` | 4 | `tutor_identity_groups.supported_modality`, `recurring_availability_windows.modality` |
| 5 | `classroomRoomCategoryEnum` | `classroom_room_category` | 3 | `classroom_rooms.category` |
| 6 | `classroomAssignmentRunStatusEnum` | `classroom_assignment_run_status` | 4 | `classroom_assignment_runs.status` |
| 7 | `classroomAssignmentRowStatusEnum` | `classroom_assignment_row_status` | 4 | `classroom_assignment_rows.status` |
| 8 | `classroomPublishStatusEnum` | `classroom_publish_status` | 4 | `classroom_assignment_rows.publish_status` |
| 9 | `classroomPublishJobStatusEnum` | `classroom_publish_job_status` | 5 | `classroom_publish_jobs.status` |
| 10 | `proposalScopeEnum` | `proposal_scope` | 2 | `proposal_items.scope` |
| 11 | `proposalStatusEnum` | `proposal_status` | 5 | `proposal_items.status` |
| 12 | `aiSchedulerConversationStatusEnum` | `ai_scheduler_conversation_status` | 2 | `ai_scheduler_conversations.status` |
| 13 | `aiSchedulerMessageRoleEnum` | `ai_scheduler_message_role` | 4 | `ai_scheduler_messages.role` |
| 14 | `lineMessageDirectionEnum` | `line_message_direction` | 2 | `line_messages.direction` |
| 15 | `lineSchedulerClassifierCategoryEnum` | `line_scheduler_classifier_category` | 4 | `line_messages.classifier_category`, `line_messages.classification_reviewed_category`, `line_scheduler_reviews.classifier_category` |
| 16 | `lineSchedulerReviewStatusEnum` | `line_scheduler_review_status` | 5 | `line_scheduler_reviews.status` |
| 17 | `lineContactStudentLinkStatusEnum` | `line_contact_student_link_status` | 3 | `line_contact_student_links.status` |
| 18 | `studentPromotionRunStatusEnum` | `student_promotion_run_status` | 6 | `student_promotion_runs.status` |
| 19 | `studentPromotionActionStatusEnum` | `student_promotion_action_status` | 4 | `student_promotion_grade_actions.status`, `student_promotion_course_actions.status` |
| 20 | `salesDashboardSourceStatusEnum` | `sales_dashboard_source_status` | 5 | `sales_dashboard_sources.status`, `sales_dashboard_sources.status_before_archive` |
| 21 | `payrollReviewStatusEnum` | `payroll_review_status` | 2 | `payroll_reviews.status` |
| 22 | `leaveRequestWorkflowStatusEnum` | `leave_request_workflow_status` | 6 | `leave_requests.workflow_status` |
| 23 | `leaveRequestSheetWriteStatusEnum` | `leave_request_sheet_write_status` | 4 | `leave_requests.sheet_write_status` |
| 24 | `progressTestStatusEnum` | `progress_test_status` | 5 | `progress_test_cycle_state.status` |
| 25 | `progressTestBookingStatusEnum` | `progress_test_booking_status` | 6 | `progress_test_bookings.status` |

---

## Core / normalization

### `syncStatusEnum` → `sync_status`

`schema.ts:19`. The shared run-status type for every sync/import lineage's run-ledger table.

| Value | Meaning |
|---|---|
| `running` | Single-flight in-flight row; the guard each lineage uses to prevent concurrent runs. Default for the column everywhere it is used. |
| `success` | Run completed and (for the Wise snapshot lineage) promoted. |
| `failed` | Run threw or was timed out / reaped; prior active state is preserved. |

**Used by** — `status` column, `.notNull().default("running")`, on eight tables (`schema.ts:206, 282, 363, 456, 519, 998, 1327, 2187`):

- `sync_runs` (Wise snapshot sync)
- `wise_activity_sync_runs`
- `sales_dashboard_import_runs`
- `sales_dashboard_projection_import_runs`
- `credit_control_sync_runs`
- `payroll_sync_runs`
- `leave_request_sync_runs`
- `progress_test_sync_runs`

### `dataIssueTypeEnum` → `data_issue_type`

`schema.ts:25`. Classifies a normalization issue raised during sync.

Values: `alias`, `modality`, `tag`, `completeness`, `conflict_model`, `sync`.

**Used by** — `data_issues.type`, `.notNull()` (`schema.ts:1898`).

### `dataIssueSeverityEnum` → `data_issue_severity`

`schema.ts:34`. Severity ranking for a `data_issues` row.

Values: `critical`, `high`, `medium`, `low`.

**Used by** — `data_issues.severity`, `.notNull().default("high")` (`schema.ts:1899`).

### `modalityEnum` → `modality`

`schema.ts:41`. Whether a tutor / availability window is online, onsite, both, or could not be resolved.

| Value | Meaning |
|---|---|
| `online` | Online delivery. |
| `onsite` | In-person delivery. |
| `both` | Supports either. |
| `unresolved` | Could not be derived; the fail-closed default, routed to "Needs Review" rather than treated as available. |

**Used by** (both `.notNull().default("unresolved")`):

- `tutor_identity_groups.supported_modality` (`schema.ts:756`)
- `recurring_availability_windows.modality` (`schema.ts:832`)

---

## Classroom assignment

### `classroomRoomCategoryEnum` → `classroom_room_category`

`schema.ts:48`. Catalog category for a physical/virtual room.

Values: `standard`, `overflow_only`, `online_only`.

**Used by** — `classroom_rooms.category` (`schema.ts:886`).

### `classroomAssignmentRunStatusEnum` → `classroom_assignment_run_status`

`schema.ts:54`. Lifecycle of a daily room-assignment run.

Values: `completed`, `published`, `partial`, `failed`.

**Used by** — `classroom_assignment_runs.status` (`schema.ts:900`).

### `classroomAssignmentRowStatusEnum` → `classroom_assignment_row_status`

`schema.ts:61`. Per-session assignment outcome within a run.

Values: `assigned`, `needs_review`, `no_room`, `remote`.

**Used by** — `classroom_assignment_rows.status`, `.notNull().default("assigned")` (`schema.ts:950`).

### `classroomPublishStatusEnum` → `classroom_publish_status`

`schema.ts:68`. Per-row writeback state for the opt-in publish of `location` back to Wise.

Values: `not_published`, `skipped`, `success`, `failed`.

**Used by** — `classroom_assignment_rows.publish_status`, `.notNull().default("not_published")` (`schema.ts:956`).

### `classroomPublishJobStatusEnum` → `classroom_publish_job_status`

`schema.ts:75`. Status of an async publish job (the batch writeback to Wise).

Values: `pending`, `running`, `succeeded`, `partial`, `failed`.

**Used by** — `classroom_publish_jobs.status` (`schema.ts:1159`).

---

## Proposals (admin holds)

### `proposalScopeEnum` → `proposal_scope`

`schema.ts:83`. Whether a tentative hold is recurring or a single occurrence.

Values: `recurring`, `one_time`.

**Used by** — `proposal_items.scope` (`schema.ts:1550`).

### `proposalStatusEnum` → `proposal_status`

`schema.ts:88`. Lifecycle of a proposal item (local-only hold; never written to Wise).

Values: `pending`, `confirmed`, `released`, `expired`, `auto_resolved`.

**Used by** — `proposal_items.status` (`schema.ts:1558`).

---

## AI scheduler

### `aiSchedulerConversationStatusEnum` → `ai_scheduler_conversation_status`

`schema.ts:96`. Whether an AI-scheduler conversation is live or archived.

Values: `active`, `archived`.

**Used by** — `ai_scheduler_conversations.status` (`schema.ts:1579`).

### `aiSchedulerMessageRoleEnum` → `ai_scheduler_message_role`

`schema.ts:101`. Author role of a message turn in an AI-scheduler conversation.

Values: `admin`, `parent`, `assistant`, `system`.

**Used by** — `ai_scheduler_messages.role` (`schema.ts:1602`).

---

## LINE integration

### `lineMessageDirectionEnum` → `line_message_direction`

`schema.ts:108`. Direction of a LINE message relative to the OA.

Values: `inbound`, `outbound`.

**Used by** — `line_messages.direction` (`schema.ts:1704`).

### `lineSchedulerClassifierCategoryEnum` → `line_scheduler_classifier_category`

`schema.ts:113`. Classifier verdict for an inbound LINE message.

Values: `scheduling_request`, `scheduling_change`, `non_scheduling`, `unclear`.

**Used by** (3 columns, all nullable):

- `line_messages.classifier_category` (`schema.ts:1715`) — the model's category.
- `line_messages.classification_reviewed_category` (`schema.ts:1720`) — a human-corrected category.
- `line_scheduler_reviews.classifier_category` (`schema.ts:1787`).

### `lineSchedulerReviewStatusEnum` → `line_scheduler_review_status`

`schema.ts:120`. Triage state of a LINE scheduler review (the human-in-the-loop queue; reply/Wise writeback is flag-gated and dry-run).

Values: `pending_review`, `approved_sent`, `accepted_no_send`, `rejected`, `dismissed`.

**Used by** — `line_scheduler_reviews.status` (`schema.ts:1791`).

### `lineContactStudentLinkStatusEnum` → `line_contact_student_link_status`

`schema.ts:128`. State of a suggested link between a LINE contact and a student.

Values: `suggested`, `verified`, `rejected`.

**Used by** — `line_contact_student_links.status` (`schema.ts:1742`).

---

## Student promotion

### `studentPromotionRunStatusEnum` → `student_promotion_run_status`

`schema.ts:134`. Lifecycle of a student-promotion run (grade/course bulk-apply).

Values: `draft`, `verified`, `applying`, `applied`, `applied_with_errors`, `failed`.

**Used by** — `student_promotion_runs.status` (`schema.ts:672`).

### `studentPromotionActionStatusEnum` → `student_promotion_action_status`

`schema.ts:143`. Per-action apply outcome within a promotion run.

Values: `pending`, `skipped`, `applied`, `failed`.

**Used by** (2 tables):

- `student_promotion_grade_actions.status` (`schema.ts:712`)
- `student_promotion_course_actions.status` (`schema.ts:735`)

---

## Sales dashboard

### `salesDashboardSourceStatusEnum` → `sales_dashboard_source_status`

`schema.ts:150`. Lifecycle of a monthly sales source sheet.

Values: `active`, `refreshing`, `finalized`, `reopened`, `archived`.

**Used by** (2 columns on the same table):

- `sales_dashboard_sources.status`, `.notNull().default("active")` (`schema.ts:336`)
- `sales_dashboard_sources.status_before_archive`, nullable — preserves the prior status across an archive so a `reopened` source can restore it (`schema.ts:346`)

---

## Payroll

### `payrollReviewStatusEnum` → `payroll_review_status`

`schema.ts:158`. Approval state of a monthly payroll review.

Values: `draft`, `approved`.

**Used by** — `payroll_reviews.status` (`schema.ts:1018`).

---

## Leave requests (uncommitted WIP)

> The leave-requests feature is present in the working tree but uncommitted at this revision. The two enums below are part of that in-flight source. (`src/lib/leave-requests/**` holds the leave logic; these enum/table declarations live in `schema.ts`.)

### `leaveRequestWorkflowStatusEnum` → `leave_request_workflow_status`

`schema.ts:163`. Admin triage state of a tutor leave request.

Values: `new`, `needs_review`, `in_progress`, `done`, `ignored`, `canceled_by_tutor`.

**Used by** — `leave_requests.workflow_status`, `.notNull().default("new")` (`schema.ts:1376`).

### `leaveRequestSheetWriteStatusEnum` → `leave_request_sheet_write_status`

`schema.ts:172`. State of the status writeback to the source Google Sheet.

Values: `not_required`, `pending`, `success`, `failed`.

**Used by** — `leave_requests.sheet_write_status`, `.notNull().default("not_required")` (`schema.ts:1379`).

---

## Progress tests

### `progressTestStatusEnum` → `progress_test_status`

`schema.ts:179`. Where a student's tracker cycle sits in the every-8-classes progression.

Values: `accumulating`, `approaching`, `due`, `scheduled`, `completed`.

**Used by** — `progress_test_cycle_state.status`, `.notNull().default("accumulating")` (`schema.ts:2058`).

### `progressTestBookingStatusEnum` → `progress_test_booking_status`

`schema.ts:187`. Outcome state of a progress-test booking (including dry-run vs. actual Wise creation).

Values: `recorded`, `dry_run`, `wise_created`, `manual_required`, `manual_confirmed`, `failed`.

**Used by** — `progress_test_bookings.status`, `.notNull().default("recorded")` (`schema.ts:2088`).

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
